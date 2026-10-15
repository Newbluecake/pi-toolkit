# droid RPC resume 丢失上下文 —— 根因调查报告（#22 P5 真机 D8）

- 调查日期：2026-10-15；droid **0.241.1**（`/home/bluecake/.local/bin/droid`）；全部结论以本机实测 + 二进制反混淆为准。
- 真机成本：**4 个 LLM turn**（gpt-6-luna · effort low，E1×2 / E3×1 / E4×1），另有两个零计费探针（E5/E6 只发 RPC 不发 prompt）。
- 实验脚本与产物存档：`/tmp/droid-rm/`（`rpc.py` 最小 stream-jsonrpc harness、`e1/e3/e5/e6.py`、`e1.json`/`e4.jsonl` 快照）；隔离 HOME=`/tmp/droid-rm/home`，未污染 `~/.factory`。

---

## 1. 现象复述

pi-toolkit 的 droid 适配器 resume 外部会话：`droid exec --input-format stream-jsonrpc` 起进程 → RPC `droid.initialize_session` 带 `sessionId:<旧id>` → 无条件 `update_session_settings` → `add_user_message` 续跑。结果（#22 P5 真机 conformance D8，3 次实测）：

- 会话文件正确接续：同 sessionId、追加写入、inode 不变；模型与 cwd 正确。
- 但 **2/3 次模型完全不记得前情**（`initialize_session` result 的 `session.messages:[]`，问暗号答 "I don't know"）；1/3 次「正常」。
- 换 graceful close（`close_session` + 自然退出）不改变结果。

## 2. 结论摘要（TL;DR）

**`initialize_session` 从来就不是恢复语义。** 二进制证据 + 真机实测双重证实：它对已存在的 sessionId 走的是「复用 id 的**新建**」——persistence 层只恢复 settings/累计 token 计数/文件记账，**不把历史喂进 agent loop 的会话 store**（响应里 `session.messages` 是硬编码的 `[]`）。真正的恢复方法是**同一条 RPC 线上的 `droid.load_session {sessionId}`**（ACP/daemon/TUI/CLI `-s` 全都走它），实测能完整恢复上下文。

**推荐修复**：适配器 resume 分支把 `initialize_session(sessionId)` 换成 `load_session(sessionId)`（后续无条件 `update_session_settings` 流程不变），`-32004 "Session not found"` 映射为 config 失败（fail closed）。改动集中在 `provider.ts` + `protocol.ts` 一个方法名 + 测试。

## 3. 实验记录

> 所有真机命令都先 `source ~/.factory/env.sh`（旧 key 会 402）。`rpc.py` 是按 D8 同款信封（`type:"request"` + `factoryApiVersion:"1.0.0"` + `factoryProtocolVersion:"1.264.0"` + 字符串 id）写的最小客户端；init/update 参数与生产 `buildInitParams`/`buildUpdateSettingsParams` 逐字段一致（machineId/cwd/modelId/autonomyLevel:"high"/autoRejectPermissionRequests:false/reasoningEffort:"low"）。

### E1 — D8 精确复现（SIGKILL 变体）〔2 turns〕

流程：A 进程 `initialize_session`（新）→ update → 「记住暗号 RMX-3A681C-42」→ `agent_turn_completed` → **SIGKILL 进程组**（D8 同款）；B 进程 `initialize_session(sessionId=A)` → update → 「暗号是什么？」→ 等 turn。

| 观测点              | 结果                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A turn              | reason=completed，`tokenUsage.inputTokens=362`，答 "OK"                                                                                 |
| **kill 后磁盘快照** | jsonl 存在、5 行（`session_start`+3×`message`+`agent_turn_outcome`）、**含暗号**、settings.json `inputTokens=362` ⇒ **没有 flush 丢失** |
| B init              | sessionId 同、`session.messages=[]`                                                                                                     |
| B turn              | reason=completed，`inputTokens=3, cacheReadTokens=8219`（≈系统提示+工具表的基线，S/29 真恢复时是 61848）                                |
| **B 答案**          | **"I don't know."**                                                                                                                     |
| B 后快照            | 文件追加到 9 行，inode 不变（既没删除重建、也没报错）——「续文件、不续脑」                                                               |

### E3 — `droid.load_session` 原生恢复〔1 turn，复用 E1 会话〕

流程：新进程直接 `droid.load_session {sessionId}`（**不发 initialize_session**）→ `update_session_settings` → 同样问暗号。

| 观测点    | 结果                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| load 响应 | `session.messages=6`、`hasOlderMessages=false`、`tokenUsage`（累计从 settings 恢复）、`settings` 全量 echo、`availableModels`、`cwd`、`workingState:"idle"` |
| 答案      | **"RMX-3A681C-42"** ✅                                                                                                                                      |
| 文件      | 继续追加（12 行，inode 不变）                                                                                                                               |

### E4 — CLI `-s` 基线（S/29 复现）〔1 turn〕

`droid exec -s <E1会话> -m gpt-6-luna -r low -o stream-json "暗号是什么？"` → `finalText="RMX-3A681C-42"`，`numTurns=4`（累计）、`cache_read_input_tokens=16438`（历史真在上下文里）。

### E5 — `load_session` 的通知面（零计费，不发 prompt）

load 后通知只有 `mcp_status_changed` + `settings_updated`（全量 echo）；**没有历史以 `create_message` 回放** ⇒ 适配器 events mapper / transcript 不会被污染。update 后照常来全量 `settings_updated` echo（3 条）⇒ provider 的「update 后等 echo」机制原样可用。

### E6 — 错误形状（零计费）

| 调用                                | 结果                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `load_session` 伪造 sessionId       | RPC error **`-32004 "Session not found"`**（干净的可判定失败）                                                    |
| `initialize_session` 伪造 sessionId | **静默接受**：同 id 新建会话、`messages:[]`、磁盘创建全新 jsonl —— 这就是当前适配器踩的「静默失忆」陷阱的最小复现 |

## 4. 根因

### 4.1 已证实（二进制反混淆 + 实测互证）

droid 的 exec-worker RPC 线（我们 `--input-format stream-jsonrpc` 说话的对象）里，`initialize_session` 与 `load_session` 是两条完全不同的路径：

1. **`handleInitializeSession`** → `sessionController.createSession({sessionId, cwd, …})` → `_createSessionImpl` → persistence 层 `createSessionWithId({sessionId, cwd, …})`：
   - `rt = getSessionMessagesPath(sessionId, cwd)`（即 `~/.factory/sessions/<cwd-slug>/<id>.jsonl`）。文件**存在**时打日志 `"[Session] Session already exists locally, loading instead"` 并调 **persistence 层的** `loadSession`——它恢复 `.settings.json` 里的模型/自治/累计 tokenUsage 与文件记账（这解释了 E1 里 B 的累计用量 365=362+3、numTurns 累计、文件正确接续），**但不把消息装进 agent loop 使用的 live 会话 store**；init 响应里的 `session:{messages:[]}` 是硬编码。
   - 文件**不存在**时：同 id **静默新建**（E6）。load 抛非 SessionNotFound 错误时甚至 `rmSync` 删文件重来。
   - 即：**「续跑会话文件」≠「恢复对话上下文」**——droid-protocol.md §2/§5 的「`initialize_session` 传 `sessionId` 即续跑该会话」只对文件成立，对 LLM 上下文**从来不成立**（S/29 当年验证的是 CLI `-s`，不是 RPC init）。
2. **`handleLoadSession` → `sessionController.loadSession`**（exec-worker 层）：`findSessionFile({sessionId, searchAllProjects:true})`（**跨 cwd slug 全局找**）→ 读 jsonl → 装进 live 会话 store（代码分支日志 `"Current session has no live conversation history; loading from disk"`）→ 响应带 `session.messages` / `hasOlderMessages` / `tokenUsage` / `cwd` / `workingState`。**这才是恢复语义**。
3. 佐证（同一套事实的旁证）：
   - CLI `droid exec -s <id>` 走 `ensureSessionLoaded` → exec-worker `loadSession`（日志 `"[StreamingExec] Session loaded"`）——E4 实测记住暗号。
   - ACP 侧 `agentCapabilities.loadSession:true`；`newSession`↔initializeSession、`loadSession`/`resumeSession`↔loadSession，界线同样分明。
   - daemon 侧 `handleAddUserMessage` 对失联 client 的复活路径就是 `handleLoadSession`——daemon 从不用 initialize_session 恢复已知会话。
   - 错误映射：`load_session` 找不到会话 ⇒ `qs`(SessionNotFound) ⇒ RPC `-32004`（E6 实测吻合）。

**一句话根因**：适配器把「文件续写语义」的 `initialize_session(sessionId)` 当成了「上下文恢复语义」用；droid 真正的恢复方法 `droid.load_session` 一直躺在同一条 RPC 线上没被调用。

### 4.2 「1/3 正常」的解释（推测，未复现）

按上述机制，initialize_session 恢复**不可能**真恢复上下文，所以那 1 次「正常」几乎可以肯定不是模型记得，最可能的是：

- **模型自己从磁盘找回了答案**：autonomy=high 下它有 Read/Execute；会话 jsonl / transcript 里就有 "BANANA-42"，被问到「暗号是什么」时它偶尔会去翻文件（低 effort 模型行为不稳定，正好解释「时好时坏」）。该次 D8 运行的通知日志里若有 `tool_call`(Read/Grep/Execute) 即可坐实（日志已随沙箱清理，无法回看）。
- 次要可能：D8 的判据是「全部 `create_message` 通知拼接里 `includes("BANANA-42")`」，历史回显类通知（`context-*`，`visibility:"llm_only"`）若载有正文也会误判（S/30 实样里 `context-*` 的 `content` 是 `[]`，故此可能性低）。

另外可以排除的候选根因（都有反证）：会话文件 flush 丢失（E1 kill 后文件完整含暗号）；SIGKILL vs graceful（用户已测 graceful 同样失败，且机制上与关闭方式无关）；cwd slug 不一致（E1 全程同 cwd 仍失败）；`.settings.json` 损坏（E1 完好）。

## 5. droid 0.241.1 恢复手段盘点

| 手段                                   | 上下文恢复     | 可用于我们的 exec RPC 线                     | 备注                                                                                                                                                                         |
| -------------------------------------- | -------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `droid.initialize_session {sessionId}` | ❌（只续文件） | 是（当前用法）                               | 对不存在的 id 静默新建（E6）；换 cwd 会分叉出第二份文件（S7）                                                                                                                |
| **`droid.load_session {sessionId}`**   | ✅（E3）       | **是（同一条 stdin/stdout 线，方法已路由）** | `searchAllProjects` 找文件（slug 无关）；缺会话 ⇒ `-32004`；结果带 settings/availableModels/tokenUsage；不发历史回放通知（E5）；支持 `loadAllMessages`/`messageLimit` 等参数 |
| CLI `droid exec -s <id>`               | ✅（E4/S29）   | 否（stream-jsonrpc 模式 `-s` 等 flag 失效）  | 一次性进程，无 steer/权限应答通道                                                                                                                                            |
| `droid resume <id>`                    | ✅             | 否（TUI 交互）                               | —                                                                                                                                                                            |
| `droid.append_messages`                | n/a            | —                                            | 往会话**追加**消息（TUI 回放用），不是恢复开关                                                                                                                               |
| `droid.fork_session`                   | ✅（分叉）     | 是                                           | 语义是分叉新会话，破坏「同 sessionId 接续」，不适用                                                                                                                          |

## 6. 方案对比

| 方案                                                                      | 说明                                                                                                   | 成本/风险                                                                                                                                                                                                                                | 结论                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **A. resume 改用 `load_session`**（原生恢复）                             | resume 分支 `initialize_session(sessionId)` → `load_session(sessionId)`；update/校验/transcript 全不变 | ~20 行改动；`-32004` 映射 config 失败；风险见 §9                                                                                                                                                                                         | ✅ **推荐**                                                         |
| B. 适配器侧摘要注入（把上一段 transcript 摘要/最后 N 轮拼进首条用户消息） | 兜底，不依赖 droid 行为                                                                                | ①每次 resume 全量重计费（无缓存连续性，历史越长越贵）；②tool_call/result 保真度丢失，需要自造序列化；③计费面：ledger 的 resume-基线语义（L1/L2）按「原生连续累计」设计，注入会引入双重计费口径；④与 plan §4.8「resume 只发任务正文」相悖 | ❌ 仅当 A 在未来 droid 版本消失时再启用；届时 conformance D8 会先红 |
| C. resume 走 CLI `-s` 子进程                                              | 每次恢复一次性进程                                                                                     | 丢失 steer（add_user_message）/interrupt/权限应答/get_context_stats 的全双工能力，退化为杀进程+续跑；arch §4.3 的收口表全部重做                                                                                                          | ❌                                                                  |

## 7. 推荐方案与落点

### 7.1 改动清单

1. **`src/external-agent/droid/protocol.ts`**：`DROID_METHODS` 增加 `loadSession: "droid.load_session"`（内部方法名表，非 P3 冻结导出；冻结常量全部不动）。
2. **`src/external-agent/droid/provider.ts`**（唯一逻辑落点，`startSession` 的 resume 分支）：
   - `o.resume === true` 时：`rpc.request(DROID_METHODS.loadSession, { sessionId: resumeSessionId, autoRejectPermissionRequests: DROID_AUTO_REJECT_PERMISSIONS }, s.initTimeoutMs)`，**不再**对 resume 发 `initialize_session`（create 流程字节不变）。
   - `sessionId` 取 `resumeSessionId`（load 响应顶层没有 sessionId 字段——E5 实测键集：`session/settings/availableModels/tokenUsage/cwd/hostId/workingState/hasOlderMessages/…`）。
   - 其余共享流程原样复用：`extractSettingsEcho(loadResult)`（响应带 `settings` 全量 echo，含 modelId/autonomyLevel）→ `catalog.observeInit(loadResult?.availableModels, …)` → 无条件 `update_session_settings`（继续解决「会话持久化设置覆盖」坑 + S5 无效模型校验）→ 等全量 echo → `verifyEffectiveSettings`。
   - 错误映射：RPC error `code:-32004`（或 message /Session not found/i）⇒ `ClassifiedError{kind:"config", retryable:false}`，文案给出预期原生文件坐标（`droidNativeSessionPaths({homeDir, cwd, sessionId}).sessionFile`，已 import）与「`~/.factory/sessions` 被清理/换机器/跨主机」提示；其余错误走现行 failSpawned 路径。今天这条路径是「静默失忆」，改后是**大声失败**——行为变化是修复目的本身，写进 CHANGELOG commit body。
3. **`docs/dev/external-agent/droid-protocol.md`**：§2/§5 修正「`initialize_session` 传 sessionId 即续跑」为「只续文件、不恢复上下文；恢复用 `droid.load_session`（-32004）」，并补 load_session 响应形状（引用本报告实验）。
4. **`docs/dev/external-agent/plan.md` §4.4/§15**：resume 流程步骤与遗留项更新（一句话级别）。

### 7.2 冻结面 / 计费面影响

- **P3 冻结导出零改动**：`DROID_PROTOCOL_VERSION`/`DROID_API_VERSION`/`DROID_AUTONOMY_FULL`/`DROID_EXEC_ARGS`/`DROID_RESUME_CUSTOM_TYPE` 等全部不动；协议信封、版本、drift 检测不变（load_session 同信封，E3/E5 实测）。
- **计费**：resume 后首个 turn 现在会带真历史上下文（cache_read 上升）——这是 resume 语义本来就该付的钱，不是回归。ledger L1「resume 首 turn 无基线 ⇒ 只记基线不出增量」在 load_session 下反而**更正确**：load 恢复的累计（含上一 run 全部用量）成为首条 `session_token_usage_changed` 基线，本 run 只记差值（E3 实测累计从 765 起跳，与 settings.json 一致）。r3 异常退出对账（`readNativeCumulativeUsage`）不变。
- **附带收益**：`load_session` 用 `searchAllProjects` 定位文件，天然免疫 S7 的「换 cwd slug 分叉第二份文件」问题（spawn cwd 仍钉头行 cwd，transcript 追加仍写原 storage cwd）。

## 8. 测试设计

### 8.1 fake-droid（`tests/external-agent/fixtures/fake-droid.mjs`）

- `droid.initialize_session` 处理器**保持现状**（sessionId 采纳 + `messages:[]`）——它是「陷阱行为」的模拟器，conformance 反向断言要用。
- 新增 `droid.load_session` 分支：
  - 可配置的「已知会话表」（复用 fixtures 现有的会话状态文件机制，或按 `params.sessionId` 对照测试注入的 id 列表）；
  - 命中 ⇒ 先 `settings_updated` 全量 echo 通知，再回 `{ session:{messages:[]}, settings:fullEcho(), availableModels, tokenUsage:{…}, cwd, hostId, workingState:"idle", hasOlderMessages:false }`（形状对齐 E5 实测；`messages` 允许测试注入非空数组以模拟历史）；
  - 未命中 ⇒ `respondError(id, -32004, "Session not found")`。
- provider 单测断言用 `f.rpcs[0].requests` 抓方法名（现有手法）。

### 8.2 provider 单测（`tests/external-agent/droid/provider.test.ts`，resume describe 扩充）

1. resume ⇒ 发的是 `droid.load_session` 且 params 含 `sessionId`/`autoRejectPermissionRequests:false`；**全程没有** `droid.initialize_session`；后续 `update_session_settings` 照发；生效值校验用 load 响应的 settings echo。
2. resume ⇒ spawn cwd 仍钉头行 cwd（现断言改方法名后原样保留）。
3. `-32004` ⇒ `ClassifiedError{config}`、文案含原生日径；**不起 prompt、不开 transcript**（`f.spawnOpts` 有进程但 `add_user_message` 从未发出——对齐现有 S5 测试的零副作用断言手法）。
4. load 后 settings echo 缺失/半截 ⇒ `verifyEffectiveSettings` fail closed（现有机制，补一条用例）。
5. create 流程逐字节不变（现有 create 用例即回归网）。

### 8.3 conformance D8 重写（`tests/conformance/droid-protocol.test.ts`）

- **D8a（恢复语义，硬门禁）**：A=`initialize_session` 新会话 → 暗号 turn → kill；B=`load_session {sessionId}` → update → 问暗号 ⇒ 断言 `load.result.session.messages.length > 0`、答案含暗号、`agent_turn_completed.cumulativeTokenUsage.inputTokens ≥ A 结束值`。
- **D8b（陷阱文档化，硬门禁）**：同会话再起 C=`initialize_session {sessionId}` → 问暗号 ⇒ 断言答案**不含**暗号且 `session.messages:[]`（0.241.1 行为钉死；未来 droid 若改好，这条会红——那是升级信号，不是误报）。
- **D8c**：`load_session` 伪造 id ⇒ `-32004`。
- 预算：3 个 turn（D8a 2 + D8b 1，D8c 零计费），与现 D8 持平。

## 9. 风险与遗留

1. **`droid.load_session` 未见于官方文档**（droid-protocol.md 方法清单也没有）：证据是二进制路由表 + ACP 能力声明 + 真机行为（E3/E5/E6），属于「ACP/daemon/TUI 公共主干」而非私有 API，稳定性预期高；但它是 0.241.1 事实，**升级 droid 须复跑 D8a**（conformance 门禁已覆盖）。`protocolCheck` drift 机制照常兜底。
2. **load 延迟**：`load_session` 要解析整个 jsonl，超长会话（数十 MB）时 20s 默认 `initTimeoutS` 可能偏紧——可在报告 PR 里提示用户调 `initTimeoutS`，或后续观察 D8a 时延再决定是否单独放宽 load 的超时。
3. **行为变化**：原「原生文件丢失也能 resume（但失忆）」→ 现在 config 拒绝。预期内（fail closed 哲学），commit body 与 `docs/dev/external-agent/README.md` 需写明。
4. **1/3「成功」未复现**（§4.2 推测）：修好后该现象整体消失（不再有失忆路径），无需进一步追查；若想坐实旧日志可在下次真机 D8 失败时顺手检查 `tool_call` 通知。
5. **`hasOlderMessages`/`messageLimit`/`loadAllMessages`**：本修复用默认参数（全量加载）；若未来要控制 resume 上下文规模，这些参数是现成旋钮，但会改变「真恢复」语义，暂不动。

## 10. 附：实验环境回收

- 实验进程已全部退出（`ps` 仅剩用户自己的交互式 droid，PID 3805584，Oct 14 启动，与实验无关）。
- `/tmp/droid-rm/`（<100 KB）保留作证据；如需清理直接 `rm -rf /tmp/droid-rm`。
