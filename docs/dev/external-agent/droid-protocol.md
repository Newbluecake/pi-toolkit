# droid CLI（Factory）无头调用协议摸底 —— P0 事实文档

- 实测对象：本机 `droid` **0.241.1**（`/home/bluecake/.local/bin/droid`，292 MB Bun 单文件 ELF）
- 实测日期：2026-10-14（三轮；第三轮 = §13 S1–S13 spike，样本 40–54）；实测环境：Linux x86_64，zsh，工作目录 `/tmp/droid-spike/`（git init）
- 原始样本存档：`./samples/`（本文 `S/` 即该目录；20+ 编号为第二轮成功路径样本；**40–54 为第三轮
  S1–S13 spike 样本，`available-models.json` 为 U4 导出**）
- **鉴权与 402 的教训**：第一轮所有 LLM 调用返回
  `402 Organization does not have an active paid subscription`，原因是 pi 进程环境里的
  `FACTORY_API_KEY` 是旧 key；正确凭据在 `~/.factory/env.sh`。**凡调用 droid 的 shell 都必须先
  `source ~/.factory/env.sh`**（每次新 shell 都要重新 source）。第二轮用 `gpt-6-luna`
  （tokenMultiplier 0.04，最便宜档）全部跑通。
- 标注约定：无标注 = 本机实测；「二进制证据」= 从 droid 二进制 strings 提取（非运行实测）；
  「第三方资料」= 网络文档，非一手且未在本机复现；「未验证」= 两轮均未覆盖。

---

## 1. 帮助全文与子命令/参数

命令：`droid --help`、`droid exec --help`（exit 0）。全文存档：`S/help-root.txt`、`S/help-exec.txt`。

顶层子命令：`resume` / `exec`（无头）/ `daemon`（Factory 守护进程服务）/ `search|find`（本地会话搜索）/
`update` / `mcp` / `plugin` / `computer` / `doctor`。

`droid exec` 关键参数（全部来自 help 实测输出）：

| 类别 | 参数                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输出 | `-o, --output-format text\|json\|stream-json\|stream-jsonrpc\|acp`（默认 text）                                                                                                                                 |
| 输入 | `--input-format stream-json`（多轮；**已废弃且会静默吞错，禁用**）/ `stream-jsonrpc`（JSON-RPC 全权控制）；`-f, --file <path>`；无 prompt 参数时读 stdin                                                        |
| 自治 | `--auto low\|medium\|high`；`--skip-permissions-unsafe`（不可与 --auto 同用）                                                                                                                                   |
| 会话 | `-s, --session-id <id>` 续跑；`--fork <id>` 分叉；`--tag <spec>`（可重复，支持 JSON）                                                                                                                           |
| 模型 | `-m, --model <id>`（默认 `gpt-6-sol`）；`-r, --reasoning-effort <level>`；spec/mission 各自的 model/effort 参数                                                                                                 |
| 工具 | `--only-tools / --add-tools / --remove-tools`（支持 `MCP:<server>[/<tool>]` 选择器）；`--list-tools`                                                                                                            |
| 其它 | `--cwd <path>`；`--settings <path>`（仅本进程合并的运行时设置）；`-w, --worktree [name]`；`--append-system-prompt[-file]`；`--mission`（多 agent 编排，需 `--auto high` 或 skip-permissions）；`--log-group-id` |

**help 中明确没有**：`--max-turns`、进程级超时、JSON schema 输出约束等参数。驱动必须自带
watchdog/deadline（与 pi-toolkit 零挂起不变量一致，正好由 runner 层兜底）。

## 2. 输出格式实测

### text（默认）

失败时单行人类可读错误（`S/06-error-text-format.out`）：

```
Error during droid execution: 402 {"detail":"...",...}
```

成功时为纯文本回答（未单独存档， trivial）。

### json

单行 JSON。失败样例（`S/06-error-json-format.out`）：

```json
{
  "type": "result",
  "subtype": "failure",
  "is_error": true,
  "duration_ms": 1010,
  "num_turns": 0,
  "result": "402 {...}",
  "session_id": "...",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "factory_credits": 0
  }
}
```

成功样例（实测：`droid exec -m gpt-6-luna -o json "Reply with exactly: PONG"` →
`subtype:"success"`,`is_error:false`,`result:"PONG"`,`factory_credits`:597）。usage 为 snake_case，
含 `factory_credits`（Factory 积分，非美元）。

### stream-json（NDJSON，一行一事件）——成功路径全形状（第二轮实测）

纯问答完整序列（`S/20-success-qa.stream-json.jsonl`，**全部 4 行**）：

```json
{"type":"system","subtype":"init","cwd":"/tmp/droid-spike","session_id":"7a9bd184-...",
 "tools":["Read","LS","Execute","Edit",...54 个],"model":"gpt-6-luna","reasoning_effort":"low"}
{"type":"message","role":"user","id":"6077bd41-...","text":"Reply with exactly one word: PONG",
 "timestamp":1791962370528,"session_id":"7a9bd184-..."}
{"type":"message","role":"assistant","id":"b7492574-...","text":"PONG","timestamp":...,"session_id":"..."}
{"type":"completion","finalText":"PONG","numTurns":1,"durationMs":2879,"session_id":"...",
 "timestamp":...,"usage":{"input_tokens":3,"output_tokens":6,"cache_read_input_tokens":0,
 "cache_creation_input_tokens":11923,"factory_credits":598,"ttft_ms":2645}}
```

带工具调用（读文件，`S/21-success-readfile.stream-json.jsonl`；shell 命令 `S/22-success-shell...`；
写文件 `S/24-success-writefile-medium...`）新增两种事件：

```json
{"type":"tool_call","id":"call_DdGTAnmLodfvuhGmb2wAMKlR","messageId":"...","toolId":"Read",
 "toolName":"Read","parameters":{"file_path":"/tmp/droid-spike/read-me.txt"},"timestamp":...,"session_id":"..."}
{"type":"tool_result","id":"call_DdGTAnmLodfvuhGmb2wAMKlR","messageId":"...","toolId":"Read",
 "isError":false,"value":"sample file content: alpha bravo charlie\n","timestamp":...,"session_id":"..."}
```

要点（全部实测）：

- 首行恒为 `system/init`（session_id、cwd、工具全表、模型、推理强度）；用户 prompt 以
  `message/role:user` 回显。
- **stream-json 只发完整消息**（`message/role:assistant` 一次性全量），观察不到文本增量；
  增量只在 stream-jsonrpc 里有（见下）。
- `tool_call`：`id`（`call_*`）、`toolId`/`toolName`、`parameters`（Execute 还会带 droid 自己判定的
  `riskLevel:"low|medium|..."`、`summary`、`timeout`）。`tool_result`：同 `id` 关联，`isError`，
  成功为 `value`（字符串；ApplyPatch 的 value 是 JSON 字符串），失败为 `error:{type:"tool_error",message}`。
- **成功终结事件是 `type:"completion"`**：`finalText`（最终全文）、`numTurns`（续跑时累计）、
  `durationMs`、`usage{input_tokens,output_tokens,cache_read_input_tokens,
cache_creation_input_tokens,factory_credits[,thinking_tokens],ttft_ms}`。exit 0。
- 失败（LLM 错误/权限拒绝）时**没有 completion**，流以 `error` 事件结束（`source:"agent_loop"` 与
  `"cli"` 各一条），exit 1。驱动不能假设终结事件必存在。
- 思考内容：`-r low` 下 stream-json 未见独立 thinking 事件（RPC 模式有 `thinking_text_complete`，见下）。

### stream-jsonrpc（全双工 JSON-RPC，官方推荐的多轮协议）——成功全流程（第二轮实测）

完整成功会话存档：`S/27-jsonrpc-success-flow.jsonl`（initialize → 3 轮对话含长任务 steer +
interrupt → close）、`S/30-jsonrpc-resume-deny.jsonl`（resume）、`S/31-jsonrpc-deny-off.jsonl`
（autonomy off 拒绝）。

**信封（实测破解）**：请求必须同时携带 `type:"request"` + `factoryApiVersion:"1.0.0"` +
`factoryProtocolVersion:"1.264.0"` + **字符串 id**；缺任何一个即 `-32700 Invalid JSON-RPC message`
（id 为 null）。响应/通知带同样的顶层字段。

```
→ {"jsonrpc":"2.0","type":"request","factoryApiVersion":"1.0.0","factoryProtocolVersion":"1.264.0",
   "id":"1","method":"droid.initialize_session","params":{"machineId":"probe","cwd":"/tmp/droid-spike",
   "modelId":"gpt-6-luna","reasoningEffort":"low","autonomyLevel":"medium"}}
← {"...","id":"1","result":{"sessionId":"fe116fa0-...","hostId":"...","session":{"messages":[]},
   "settings":{"modelId":"gpt-6-luna","autonomyMode":"auto-medium","autonomyLevel":"medium",...},
   "availableModels":[ 全部模型元数据, 含 tokenMultiplier/supportedReasoningEfforts ... ]}}
```

- `initialize_session` 必填 `machineId`、`cwd`（缺省时错误信息直接列出缺失字段）。
- **resume**：⚠️ 2026-10-14 更正（#31，见 `resume-memory.md`）：`initialize_session` 传 `sessionId:<旧id>` 只是「复用 id 新建」——续写同一会话文件，但**不把历史装进模型上下文**（`session.messages:[]` 恒空，对不存在的 id 还会静默新建）。真正的恢复是 `droid.load_session({sessionId})`（缺失 ⇒ `-32004`），pi-toolkit 的 resume 已改走它。原记录：实测写入同一会话文件；
  但 result 的 `session.messages` 仍为空（历史不回传），且**会话持久化的设置覆盖 init 参数**
  （实测：旧会话存的是 medium，init 传 `autonomyLevel:"off"` 被忽略，result 显示 medium——
  改设置要在 init 后再发 `droid.update_session_settings`，实测生效并有 `settings_updated` 通知）。
- 方法目录（实测+二进制证据）：`droid.initialize_session`、`droid.add_user_message`（`{"text":...}`，
  返回 `null`）、`droid.interrupt_session`、`droid.close_session`、`droid.fork_session`、
  `droid.update_session_settings`、`droid.get_context_stats`、`droid.get_context_breakdown`、
  `droid.compact_session`、`droid.rename_session`、`droid.execute_rewind`、
  `droid.resolve_queued_user_message`、MCP/插件管理若干。
- 通知方法 `droid.session_notification`，`params.notification.type` **成功路径实测到**：
  - `mcp_status_changed`、`settings_updated`、`session_title_updated`
  - `droid_working_state_changed`：`idle|thinking|streaming_assistant_message|executing_tool`
    （二进制另有 `compacting_conversation`、`waiting_for_tool_confirmation`）
  - `create_message`：完整消息对象（role/content[]/visibility——`llm_only` 的是上下文注入，应过滤）
  - `assistant_text_delta`（`messageId`+`blockIndex`+`textDelta`，真流式增量）/
    `assistant_text_complete` / `thinking_text_delta`+`thinking_text_complete`（第三轮修正：
    `thinking_text_complete` **不载文本**，只有 messageId/blockIndex/durationMs；思考全文在
    `thinking_text_delta` 流与 `create_message` 的 `{type:"thinking",thinking}` 块里，见 §13 S11）
  - `tool_call`：**input 渐进流式**——同一 `toolUse.id` 先 `{}`、再部分、再完整 input；驱动取最后一次
  - `tool_execution_phase_changed`：`queued → executing`；`tool_progress_update`（长命令周期心跳，
    带 `terminalId`）
  - `tool_result`：`toolUseId`、`content`（字符串）、`isError`
  - `session_token_usage_changed`：累计用量（每步都发）
  - `agent_turn_completed`：`reason`（实测值：`completed` / `cancelled` / `model_usage_exhausted`）、
    `turnId`、`tokenUsage` + `cumulativeTokenUsage` + `childTokenUsage` + `cumulativeChildTokenUsage`
    （各含 `inputTokens/outputTokens/cacheCreationTokens/cacheReadTokens/thinkingTokens/factoryCredits`）
  - `error`
- **steer 实测**（`S/27`，turn 内 Execute `sleep 20` 运行中发 `add_user_message`）：请求被接受
  （返回 `null`），消息以 `create_message` 入流，**并入当前 turn 的下一次模型调用**（agent loop 在
  tool_result 后的下一步看到它），不排队为独立 turn、不拒绝。（本例模型按原指令回了 DONE。）
- **interrupt_session 实测**：运行中的 Execute 立刻被杀 → `tool_result`
  `content:"Error: Tool execution cancelled by user", isError:true`（**重复发了两次**，驱动要按
  toolUseId 去重）→ `agent_turn_completed reason:"cancelled"`（带 usage）→ state `idle`。
  这是协议内的优雅中止，**killableHandles 之外的首选 abort**。
- **反向 request（`droid.request_permission`）在 exec 模式下确实会发**（第三轮修正第二轮结论，见 §13 S2：
  `S/31` 第 22 行即实样；默认 `autoRejectPermissionRequests` 下发出后约 1s 自动按 cancel 结算；
  传 `autoRejectPermissionRequests:false` 则真正等待客户端以 JSON-RPC response 应答
  `{selectedOption:"proceed_once"|"cancel"}`，不答复则永久挂起）。`droid.ask_user`/`droid.pick_options`
  反向请求也存在（二进制证据，headless 未实测）。
- `stream-jsonrpc` 模式下 `-m/--auto/-s` 等 CLI flag 失效（stderr 明确警告，settings 走 JSON-RPC）。

### acp

存在（Agent Client Protocol，供编辑器等）。未实测。

## 3. 自治/权限级别（第二轮已实测越界行为）

- **默认（无 flag）= 真正的只读模式**（`--list-tools` 头部 `Autonomy: read-only`，54 个工具仅 14 个
  allowed；`S/list-tools*.txt`）。
- **权限判定是按命令逐个分类的**：`tool_call.parameters.riskLevel` 由 droid 的分类器给出
  （`echo` → low；`printf > file` → medium）。
- **拒绝形态实测**（`S/25-deny-write-readonly...`：默认只读档要求写文件；`S/23...`：--auto low 下同）：
  `tool_call` 事件照发 → `tool_result isError:true`，
  `error.message:"Error: Exec ended early: insufficient permission to proceed. Re-run with --auto medium
or --auto high. For destructive commands, use --skip-permissions-unsafe."` → 助手消息复述错误 →
  `error source:"cli"` 同样文本 → **exit 1，无 completion**。
- **`--auto low` 下联网实测**（`S/26-deny-network-autolow...`）：`curl -sI https://example.com` 被判
  `riskLevel:"low"` 而**放行**（help 里"网络请求属 medium"与实际分类不符——以实测分类为准）；
  该命令本机网络超时，Execute 自带 `timeout:30` 参数，超时返回 `isError:false` 但
  `value:"Command timed out after 30 seconds..."`，exit 0。
- **JSON-RPC `autonomyLevel:"off"`（新会话）实测**（`S/31`）：写文件请求 → tool_result
  `"Error: Tool execution cancelled by user"` + `"Batch cancelled"`（isError:true）→
  `agent_turn_completed reason:"cancelled"` → idle；文件未创建。默认（不传 `autoRejectPermissionRequests`）
  时 headless 权限门先发一条 `droid.request_permission` 再约 1s 自动结算 cancel（第三轮修正：请求
  本身存在，见 §13 S2；传 `autoRejectPermissionRequests:false` 可让它真正等客户端应答）。
- `--skip-permissions-unsafe`：全放行（不可与 --auto 同用）。
- 对驱动含义：一次性跑任务用 `--auto medium` 是实用甜点位；要只读就跑默认档，越界会干净地
  exit 1 + error 事件。

## 4. 模型选择

- `-m <id>`；无效模型：**CLI flag 本地校验拒绝**（不发请求），exit 1，stderr 打印可用模型全表（
  `S/05-bad-model.stderr`；错误文本打印两次）。**但 JSON-RPC 两侧行为不同（§13 S5）：
  `initialize_session` 静默吞掉无效 modelId 并回落默认 `gpt-6-sol`+high（成本陷阱，必须校验
  settings echo）；`update_session_settings` 则干净拒绝 `-32602 "Unknown model: …"`。**
- 可用模型清单来源（均实测）：①`droid exec --help`；②`initialize_session.result.availableModels`
  （含 `modelProvider`、`tokenMultiplier`、`supportedReasoningEfforts`、`deprecated`，
  `S/09c-jsonrpc-init2.jsonl`）。
- 按 tokenMultiplier 最便宜：`gpt-6-luna` 0.04、`claude-haiku-5-5` 0.04、`glm-5.3-flash` 0.06、
  `deepseek-v4.1-flash` 0.12、`gemini-3-flash-preview` 0.2（第二轮全程用 gpt-6-luna，任务均正常完成）。
- `-r, --reasoning-effort`：per-model 枚举（`none/off/minimal/low/medium/high/xhigh/max` 子集），
  help 有全表。
- tier 别名（`anthropic-latest-balanced` 等）与版本通配（`claude-opus-*`），会话启动时解析并固定。
- `custom:<name>` BYOK，配置在 `~/.factory/settings.json`（本机未配置）。

## 5. 会话与续跑（第二轮已实测记忆保留）

- `session_id` 在 `system/init`、`initialize_session.result.sessionId`、每个事件中均有。
- 会话文件：`~/.factory/sessions/<cwd-slug>/<session-id>.jsonl` + `.settings.json`(+.bak)。jsonl 首行
  `session_start`，后续为完整 `message` 记录（含 system-reminder 注入，与 stream 格式不同）；
  `.settings.json` 含模型/自治级别/累计 `tokenUsage`/`inclusiveTokenUsage`/`providerLock`。
- **续跑记忆实测**（`S/29-resume-codeword...`）：会话 A（RPC 流程）中让模型记住暗号
  `BLUE-OTTER-42`；**进程结束后** `droid exec -s <id> "What was the codeword…"` → 回答
  `BLUE-OTTER-42`，exit 0。completion `numTurns:6`（累计）、`cache_read_input_tokens:61848`
  （证明历史真加载）。
- `-s` 续跑输出**不回放历史消息**（与 help 一致），只发新消息事件。
- JSON-RPC 等价续跑：`droid.load_session({sessionId})`（会恢复模型上下文；#31 更正——`initialize_session` 传 `sessionId` 只续写文件、模型失忆，见 `resume-memory.md`）。
- `--fork <id>` 分叉为新会话（未实测行为细节）。
- 并发 resume 同一 session id 的行为未验证。

## 6. 输入 / 多轮 / steer（第二轮已实测 steer）

- 单发：prompt 位置参数、`-f <file>`、stdin 管道（`S/13-stdin-prompt.jsonl`）。
- `--input-format stream-json`：**废弃且有害**。接受形状
  `{"type":"message","role":"user","content":"<文本>"}`；但 LLM 失败时**静默**（无 error 事件、
  消息不落盘、exit 0）。**驱动禁用此模式**。
- `--input-format stream-jsonrpc`：真正的 steer 通道。实测结论（`S/27`）：运行中
  `add_user_message` 被接受，**并入当前 turn 的下一次模型调用**；非排队为独立 turn、非拒绝。
  降级方案（单发模式）：杀进程后 `-s` 续跑。
- 对驱动含义：pi-toolkit 的 `steer` 直接映射 `droid.add_user_message`；语义是「下一轮模型调用可见」，
  与 pi 的 followUp 类似但不是立即打断。

## 7. 中止（第二轮已实测运行中信号 + 孙进程清理）

实测（Execute 跑 `sleep 300` 的 turn 运行中，`S/28-abort-*.jsonl`）：

| 场景                               | 退出码  | 终结事件                                                                        | sleep 300 残留 |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------- | -------------- |
| idle 的 RPC 进程收 SIGTERM/SIGINT  | 0       | 无                                                                              | —              |
| 运行中收 **SIGTERM**               | **143** | 无 completion；有 `tool_result isError:"Command terminated by signal: SIGTERM"` | **无**         |
| 运行中收 **SIGINT**                | **130** | 同上                                                                            | **无**         |
| setsid 启动 + `kill -TERM -<pgid>` | 143     | 同上                                                                            | **无**         |

- **孙进程自清机制（重要发现）**：Execute 的命令被包在 `factory-execute-supervisor` bash 脚本里
  （`ps` 实测可见）：supervisor 在**自己的进程组**，内嵌 owner-watchdog 每 2s 探 droid 是否存活，
  owner 死亡即 `kill -KILL -- -$$` 自杀全组。因此**即使 droid 被 SIGKILL，Execute 的孙进程也会在
  ~2s 内自清**——pi-toolkit 的 killableHandles 只需杀 droid 主进程。
- droid 自身**不建进程组**（PGID == 父进程）。
- 首选 abort 路径仍是协议内 `droid.interrupt_session`（reason:"cancelled" + 完整终结事件，见 §2），
  信号是兜底。

## 8. 用量/费用（第二轮已实测非零值）

- json/stream-json 终结事件 `usage`（snake_case）：`input_tokens/output_tokens/
cache_read_input_tokens/cache_creation_input_tokens/factory_credits[/thinking_tokens]/ttft_ms`。
  实测 PONG 单轮：input 3 + cache_creation 11923 → `factory_credits` 598；第二轮起 cache_read 占主
  （续跑暗号轮 cache_read 61848，credits 1847）。
- stream-jsonrpc：`session_token_usage_changed`（累计，每步发）+ `agent_turn_completed` 的
  per-turn `tokenUsage` 与 `cumulativeTokenUsage`/`childTokenUsage`（camelCase）。
- **`droid.get_context_stats` 实测**（`S/27` RESP id=4）：
  `{"used":14383,"remaining":907617,"limit":922000,"accuracy":"estimated","updatedAt":"..."}`——
  **可直接映射 pi-toolkit 的 context_usage DriverEvent**（注意 accuracy 是 estimated）。
- 费用语义是 `factoryCredits` × 每模型 `tokenMultiplier`，**无美元字段**。
- 会话 `.settings.json` 持久化累计 tokenUsage。

## 9. 环境

- 鉴权：环境变量 **`FACTORY_API_KEY`**；**本机正确凭据在 `~/.factory/env.sh`，每次 shell 都要
  source**（pi 父进程环境里的同名变量是旧 key，会导致全部 402——已实测两轮对比）。
  `~/.factory/` 下无登录态凭据文件（只有 `host.json`、`settings.json`、
  `org-managed-settings.cache.json`、`sessions/` 等）。
- AGENTS.md：二进制中出现 62 次（高度可能读取，未实测验证效果）。实测会话文件显示系统注入
  「Unified tool catalog / Available skills」等 system-reminder（且拾取了用户环境的 skills 列表）。
- 联网：模型调用走 Factory 云端（`requestId: sfo1::...`）；无离线模式。
- **并发（成功路径实测）**：两个 `droid exec` 并行（`S/32-conc-success-A/B.jsonl`）：各自 exit 0、
  答案正确（ALPHA/BRAVO 不串）、session id 独立、会话文件各自追加。
- 启动耗时：`--list-tools`（纯本地）1.8–2.7s；单轮问答端到端 ~3–7s（含 TTFT ~2.6s）。二进制 292MB，
  冷启动开销不可忽视——**驱动应用长驻 stream-jsonrpc 进程而非每次 spawn**。

## 10. 退出码（两轮实测汇总）

| 场景                                                     | exit        |
| -------------------------------------------------------- | ----------- |
| 成功（含 turn 内工具失败但最终完成，如 curl 超时）       | 0           |
| `--help` / `--list-tools`                                | 0           |
| 无效模型（本地校验拒绝）                                 | 1           |
| LLM 调用失败（402）单发 text/json/stream-json            | 1           |
| 权限拒绝（只读档写文件等）                               | 1           |
| 运行中 SIGTERM / SIGINT                                  | 143 / 130   |
| idle RPC 进程收 SIGTERM/SIGINT                           | 0           |
| `--input-format stream-json`：消息校验失败、LLM 静默失败 | **0**（坑） |
| stream-jsonrpc 全流程（含 cancelled turn）               | **0**       |

**对驱动含义：退出码不能作为成败判据**。成败看事件流：json 的 `result.is_error` / stream-json 的
`completion` 是否出现 / RPC 的 `agent_turn_completed.reason` + `error` 通知；再配自家超时兜底。

## 11. 其它对「子进程驱动」关键的特性

- **stream-jsonrpc 是唯一适合驱动的模式**（长驻、多轮、双向、结构化、有优雅中断）。acp 面向编辑器，未实测。
- **hooks**：二进制证据存在 Claude-Code 风格 hook 事件（`SessionStart/PreToolUse/PostToolUse/
UserPromptSubmit/Notification/Stop/SubagentStop/PreCompact/SessionEnd`）与 HooksManagerService；
  配置方式与 exec 下是否生效未验证。
- **结构化输出**：二进制证据 `structuredOutputFormat` + 通知类型 `structured_output` 等；CLI 无 flag，
  疑似走 JSON-RPC initialize 参数或 settings，未验证。
- `--append-system-prompt[-file]` 注入系统提示后缀（**第三轮实测 RPC 模式下生效**，见 §13 S9）；
  `--settings <path>` 运行时合并设置（可注入 per-run 配置不动用户全局）。
- 工具目录 RPC 方法（第三轮新增实测）：`droid.list_tools`（返回 `tools:[{id, llmId, displayName,
description, category, defaultAllowed, currentlyAllowed}]`，可带 includeSchemas 与 settings
  字段做假设性过滤）、`droid.list_models`、`droid.list_skills` 等（完整方法目录见二进制：
  另有 `droid.load_session`/`droid.get_rewind_info`/`droid.kill_worker_session`/
  `droid.toggle_mcp_*`/`droid.set_skill_disabled` 等）。
- `droid daemon`：完整守护进程（WebSocket + `daemon.authenticate`，二进制证据）；exec 的
  stream-jsonrpc 是其单会话内嵌版。官方另有 Python SDK（docs.factory.com/sdk/python）。
- `--mission` 多 agent 编排与 droid 自带的 `Task`/`SpawnAgent` 工具同 pi-toolkit fleet 语义重复，
  接入时应禁用（`--remove-tools` 或 RPC 的 restrictToolIds）。
- `AskUser` 工具在 headless 的行为未实测；建议默认 `--remove-tools AskUser`。
- Execute 工具有 `timeout` 参数（模型可传，实测 30s 超时生效），但无进程级总超时。

---

## 13. S1–S13 spike 结论（2026-10-14 第三轮）

第三轮一次性 spike，样本 `S/40`–`S/54`（除标注外均 stream-jsonrpc，模型 gpt-6-luna，凭据同前：每 shell
先 `source ~/.factory/env.sh`）。无标注 = 本机实测；「二进制证据」= strings 提取。

### S1 工具白名单字段（S/47、S/48）

- 四个字段均真实存在（实测+二进制证据）：`additionalToolIds` / `enabledToolIds` / `disabledToolIds` /
  `restrictToolIds`，出现在 initialize_session / update_session_settings 的 settings 与 settings echo 里。
- **`restrictToolIds` 是唯一的硬白名单**：`update_session_settings({restrictToolIds:["Read","LS","Execute"]})`
  → `droid.list_tools` 的 `currentlyAllowed` 恰好只剩这 3 个；且**模型真的看不到其余工具**（restrict=["Execute"]
  时模型自报可用工具仅 `functions.Execute, multi_tool_use.parallel`，读文件改用 Execute 跑 python cat）。
  它同时也是 `droid.list_tools` 的请求级参数（假设性过滤，同样生效）。
- **坑：init 参数里的 `restrictToolIds` 被 settings echo 回显但完全不生效**（实测 init 带 ["Execute"] 后
  list_tools 仍 32/32 全 allowed；紧接着 update 同值立即变 1/32）。工具策略必须在 init 后用
  `update_session_settings` 下发，或用 list_tools 校验实际状态。
- `enabledToolIds`/`disabledToolIds` 不是白名单语义（实测 enabledToolIds=["Execute"] 后仍 30/32
  allowed，模型也仍列出全套工具；推测是在自治档默认集上增删个别工具）。`disabledToolIds` 未实测。
- **settings 里的 toolIds 匹配的是 llmId（"Read"/"Execute"/…），不是 list_tools 返回的 catalog id
  （"apply-patch-cli"/…）**。
- 驱动含义：白名单 = `restrictToolIds` via `update_session_settings` + `droid.list_tools` 绊线校验；
  Task/SpawnAgent 等编排工具照此禁用。

### S2 反向 `droid.request_permission`（S/44 批准、S/45 拒绝、S/46 超时 + 旧 S/31）

- **完整形状**（S/31 第 22 行实样）：`{type:"request", method:"droid.request_permission", id:<uuid>,
params:{toolUses:[{toolUse:{type:"tool_use", id, name, input{command,summary,riskLevel}},
confirmationType:"exec", details:{type:"exec", fullCommand, command, extractedCommands,
impactLevel}}], options:[{label, value:"proceed_once"|"proceed_always"|"cancel", …}]}}`。
- **应答形状（实测）**：向该请求 id 回 JSON-RPC **response**，`result:{selectedOption:"proceed_once"}`
  （批准）或 `{"cancel"}`（拒绝）。批准 → `permission_resolved(selectedOption=proceed_once)` → 工具执行
  → turn `completed`；拒绝 → `tool_result isError`（cancelled）→ **turn 仍 reason:"completed"**
  （模型继续收尾，与自动拒绝的 "cancelled" 不同）。`comment`/`editedSpecContent` 可选（二进制证据
  `respondToPermission({permissionId, selectedOption, sessionId, comment?, editedSpecContent?})`）；
  error 响应或格式非法 = 按失败处理（等效 cancel，二进制证据 handlePermissionFailure）。
- **超时行为（实测）**：`autoRejectPermissionRequests:false` 时**无超时，永久等待**（180s+ 无结算，
  stdin EOF 也不打断，只能 interrupt/杀进程）。默认（不传）one-shot exec 自动秒拒（S/31：请求发出
  后约 1s permission_resolved=cancel）——默认情况下收到请求只是通知性的。
- 驱动含义：U2′ 全权限下不会收到；开低自治时要么吃默认 auto-reject，要么 false+逐个应答+自家超时。

### S3 stdin EOF（S/40）

idle 状态关 stdin → ~1s 内自行退出，**exit 0**，退出前补发一条 idle 通知；无 error 无 hang。
注意 S2：有 pending permission 时 EOF 不生效（实测 30s+ 不退）。

### S4 只 init 不发消息（S/40）

`~/.factory/sessions/<slug>/<sessionId>.jsonl` 照常创建（首行 session_start）。会话文件存在性 ≠
跑过任务。

### S5 无效 modelId（S/41 init、S/42 update）

- **initialize_session：静默吞掉**——无错误、无 error 通知，`result.settings.modelId` 直接变成默认
  `gpt-6-sol`（reasoningEffort 也变 high）。**成本陷阱**（请求 0.04x luna 静默变 0.8x sol+high）；驱动必须
  init 后校验 settings echo。
- `update_session_settings`：干净拒绝 `error:{code:-32602, message:"Unknown model: …"}`，会话仍可用。

### S6 错误 factoryProtocolVersion（S/43）

init 信封带 `1.200.0` / `9.9.9` 均被正常接受（各自新建会话），无错误无警告，响应仍回 `1.264.0`。
**请求侧协议版本目前不校验**；风险在响应/事件形状漂移而非版本拒收。

### S7 换 cwd 续跑（S/53）

`initialize_session(sessionId=旧, cwd=新目录)` 被接受，sessionId 不变，会话 cwd 切到新目录（pwd 实测）。
**同一 sessionId 出现两份会话文件**：旧位置保留不动，新位置按新 cwd slug 重写全历史（含旧消息+
system-reminder）。后续 resume 按 cwd slug 定位 ⇒ 双份历史分叉隐患；驱动 resume 时 cwd 必须与原会话一致。

### S8 最高自治档（U2′）（S/50 高自治全家桶、S/51 skip、S/52 高自治 rm -rf）

- `autonomyLevel:"high"`（echo autonomyMode=auto-high）：实测全部免确认、0 次 request_permission：
  `npm test` / `npx --yes tsc --version` / `git add -A && git commit` / `npm install is-even` /
  `printf > file` / **`rm -rf <目录>`**，任务全部完成（npx tsc 报错是本地无 tsc，非权限拒绝）。
- **RPC 存在 skip-permissions 等价物**：init 传 `skipPermissionsUnsafe:true`（二进制证据 init schema
  有该字段）实测被接受且 `rm -rf` 免确认执行——但 settings echo 显示 autonomyLevel=off/normal 且不
  回显该字段（行为与 echo 矛盾，验证只能靠行为/内部等价 CLI flag 的效果）。
- 驱动含义：U2′ 用 `autonomyLevel:"high"`（settings echo 可验证）即可；skipPermissionsUnsafe 兜底
  （force-push 等更高危操作未测）。高自治下未观察到任何 request_permission。

### S9 RPC 下 `--append-system-prompt-file`（S/49）

生效（实测：独特尾缀指令 ZEBRA-77 → 回答 "4 ZEBRA-77"）。二进制证据：appendSystemPrompt/
appendSystemPromptFile 在 exec 启动时进运行时配置，与输出格式无关；init 参数无对应字段。

### S10 用量基线（S/44 turn2）

- `agent_turn_completed.tokenUsage` = **本 turn 增量**；`cumulativeTokenUsage` = 会话累计
  （实测 turn2: turnUsage.in=3, cumulative.in=376 = 373+3）。
- turn 开始时**无独立 baseline 事件**：新 turn 首条 `session_token_usage_changed` 在首个模型调用
  完成后才发，其 `tokenUsage` 字段给的是上一时刻累计（即基线），随后逐步累计；fresh 会话首条即
  本 turn 用量。事件另带 `inclusiveTokenUsage` 与 `lastCallTokenUsage`。
- 驱动含义：arch 的基线算法成立——基线 = turn 开始前最后一次累计快照，实时增量 = 累计差值，完成时
  对账 agent_turn_completed.tokenUsage。

### S11 高 effort 思考文本（S/54）

gpt-6-luna `reasoningEffort:"high"`（支持，最便宜档）：① `thinking_text_delta`（messageId+
blockIndex=0+textDelta）流式全文思考；② `thinking_text_complete` **不载文本**（仅 messageId/
blockIndex/durationMs）；③ `create_message.content` 含 `{type:"thinking", thinking:"<全文>"}` 块

- `{type:"text"}` 块。取全文用 ③，流式用 ①。`tokenUsage.thinkingTokens=23` 与文本长度不匹配
  （疑似只计部分调用，存疑）。

### S12 自更新（help+本机日志+二进制证据；未做运行时拦截实验）

- 机制：启动时 deferred auto-update（本机日志 `~/.factory/logs/droid-log-single.log`：outcome=
  background-in-progress / no-update / skipped；非阻塞升级、阻塞回滚；检查有超时上限 “did not
  complete within its cap”）。日志里只有 TUI/daemon 启动检查，exec 模式无更新日志（无法证明 exec
  不检查）。
- **禁用**：`~/.factory/update-policy.json` → `{"disableAutoUpdate":true}`（本机当前 false）；env
  `FACTORYD_DISABLE_AUTO_UPDATE`（daemon 侧）、`DISABLE_AUTO_UPDATE`（droid 给子进程注入的就是它）。
  `DROID_FORCE_BLOCKING_UPDATE` 是反向强制阻塞更新。`droid update --check` / `-v <ver>` 手动。
- 驱动含义：R5 的正解 = host 置 update-policy true + 二进制指纹重探 + conformance。

### S13 cwd 附加文件（S/50）

fresh git 目录跑完 5 步任务后 `git status`：只有任务自身产物（node_modules/、package-lock.json、
s8-write.txt、改过的 package.json），**无 `.factory/` 或任何 droid 自建文件**（/tmp/droid-spike 根与
各子目录同）。会话数据全在 `~/.factory`。H3 worktree 提交无需额外 ignore 规则（0.241.1）。

### U4 计费映射（`S/available-models.json`，62 模型）

- 导出字段：id / modelProvider / modelId / tokenMultiplier。**id==modelId 恒成立，无独立「底层模型
  名」字段**（二进制里 routedModelId/targetModelId 属 spec-mode 路由，非公开映射）。
- 可靠匹配依据：`initialize_session.result.availableModels` 是唯一权威表。`modelProvider`
  ∈ anthropic/openai/google/xai/factory；**factory 自托管的模型（glm/kimi/qwen/deepseek/mistral/
  nemotron/minimax/inkling/auto 等）底层即同名模型，无上游单价**；其余 provider 的 id 即厂商模型名
  （droid 命名，如 claude-fable-5.1）。tokenMultiplier 是 credits 计费乘数，无美元字段——U4「按底层
  模型单价算费用」只能对非 factory provider 挂外部价目表近似；factory 侧只能用 factoryCredits 口径。

---

## 事件 → DriverEvent 映射草表（第三轮后）

pi-toolkit 侧类型见 `src/core/types.ts`。推荐走 **stream-jsonrpc** 长驻进程：

| droid 事件（实测）                                                                                      | DriverEvent                                             | 备注                                                   |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| `initialize_session` result                                                                             | run 元数据（session_id、model、tools、availableModels） | 实测                                                   |
| `droid_working_state_changed: thinking/streaming_assistant_message`                                     | turn_start                                              | 实测                                                   |
| `droid_working_state_changed: executing_tool`                                                           | （工具阶段，可并入 tool_start）                         | 实测                                                   |
| `droid_working_state_changed: idle`（turn 后）                                                          | turn 结束/settle 信号                                   | 实测                                                   |
| `assistant_text_delta`（messageId+blockIndex+textDelta）                                                | 流式增量                                                | 实测；按 messageId 聚合                                |
| `assistant_text_complete` / `create_message`(role=assistant)                                            | message_end                                             | 实测；`visibility:"llm_only"` 的 create_message 要过滤 |
| `thinking_text_complete`                                                                                | thinking 块                                             | 实测（低档位内容常为空）                               |
| `tool_call`（input 渐进流式）                                                                           | tool_start                                              | 实测；同一 toolUse.id 多次，**取最后一次完整 input**   |
| `tool_execution_phase_changed` / `tool_progress_update`                                                 | （进度，可忽略或日志）                                  | 实测                                                   |
| `tool_result`（toolUseId+content+isError）                                                              | tool_end                                                | 实测；interrupt 时**可能重复发**，按 toolUseId 去重    |
| `session_token_usage_changed`                                                                           | usage 累计更新                                          | 实测                                                   |
| `agent_turn_completed`（reason: completed/cancelled/model_usage_exhausted + tokenUsage.factoryCredits） | turn_end + usage；reason≠completed ⇒ 异常终止语义       | 实测                                                   |
| `error` 通知 / stream-json `type:error`                                                                 | run failed                                              | 实测                                                   |
| `thinking_text_delta`（messageId+blockIndex+textDelta）                                                 | thinking 流式增量                                       | 第三轮实测（§13 S11）；blockIndex=0 思考 / 1 正文      |
| `create_message` content 的 `{type:"thinking",thinking}` 块                                             | thinking 全文（message_end）                            | 第三轮实测；`thinking_text_complete` 本身不载文本      |
| `droid.request_permission`（反向请求） → 回 response `{selectedOption}`                                 | 权限审批（默认 auto-reject 无需应答）                   | 第三轮实测（§13 S2）                                   |
| `permission_resolved` 通知                                                                              | 权限结果确认                                            | 实测                                                   |
| `droid.get_context_stats` 响应（used/limit/accuracy）                                                   | context_usage                                           | 实测；主动查，estimated                                |
| stream-json 单发：`completion`（finalText/numTurns/usage）                                              | run 终态 + usage                                        | 实测                                                   |
| stream-json 单发：`tool_call`/`tool_result`（value/error）                                              | tool_start/tool_end                                     | 实测                                                   |

## 风险/未知项清单（第三轮后）

1. **环境 key 依赖**：必须用 `~/.factory/env.sh` 的凭据；驱动 spawn 时要保证 env 正确（或文档化）。
2. **stream-json 输入模式静默吞错**（exit 0、无事件、不落盘）—— 严禁使用；只用 stream-jsonrpc。
3. **退出码不可信**（多场景失败也 exit 0；信号退出码还分 idle/运行中两档）—— 成败只看事件流+超时。
4. **协议版本**：信封要求带 `factoryProtocolVersion:"1.264.0"`，但第三轮实测**不校验**（1.200.0/9.9.9
   均被接受，见 §13 S6）——风险不在版本字段被拒，而在 droid 自更新后事件形状漂移（S12 的禁用
   自更新 + 二进制指纹重探仍是正解）。
5. **RPC resume 的设置覆盖坑**：`initialize_session(sessionId)` 续跑时，会话持久化设置覆盖 init 参数；
   要在 init 后用 `update_session_settings` 改。
6. **tool_result / tool_call 事件重复与流式 input**：需按 id 去重、取最后一次 input。
7. 会话目录与交互式 droid 共享；并发 resume 同一 id 未验证。
8. hooks / structured_output / AskUser headless 行为 / `--fork` 细节 / acp：未验证。
9. stream-json 单发模式无文本增量（只完整消息）；要流式只能 RPC。
10. 权限分类器是黑盒（help 说联网属 medium，实测 curl 判 low）——自治档位的精确边界以实测为准，
    驱动文案不要照抄 help。

## 附：第三方资料（非实测，仅旁证）

- Droid Exec 官方文档镜像：https://docs.factory.com/droid-exec/overview
- CLI reference 镜像：https://dubstack.wiki/factory-ai/factory/reference/cli-reference
- 官方 SDK：https://docs.factory.com/sdk/python
