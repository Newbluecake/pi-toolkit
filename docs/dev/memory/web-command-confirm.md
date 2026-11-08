# `/mem` Web 写命令统一确认方案

> 状态：架构设计 r5；下文区分已交付基础设施与待接线的写能力，不表示完整功能已实现或端到端测试已通过。源码/SDK 只读核验基线：2026-11-08。
>
> r5 变更摘要：按异源复审 ⑤–⑧ 更新，核心裁定未变。补充能力快照、现有 completion 归属、异步可见性验收和 session rm 范围变更。
> 本次交付只修改本文件，未修改源码、测试、fixture，未执行 install/build/test/git。

## 修订记录

### r2（保留历史）

| 评审项                                                                 | r2 处置与闭合依据                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **blocker：延迟 Web slash 在 capture fallback 到期后被当 native 直写** | 撤销“未 claim 则按 isInteractive 回落”和“sendUserMessage 周围即时 claim 足够”的设计。选择 **memory 专用即时 dispatch seam**：全部 Web `mem` command 在 generic extension dispatch 前截获，直接调用独立 Web 入口，绝不送入 SDK prompt/slash 队列；seam 缺失也不得 fallback。来源由显式私有调用对象承载，不依赖 capture/record TTL。 |
| **major：tags 后台回填未冻结、脱离命令生命周期**                       | Web tags 不调用会 `triggerBulk` 的 native mutation API；定义变更与回填合成受控 effect，冻结 corpus、taxonomy、外发 DTO/模型链/预算，显式覆盖 `src/memory/jev/wire.ts`。r2 对“同 lane 即无竞争”的判断不成立，由下方 r3 替换。                                                                                                       |
| **minor：执行失败验收含糊**                                            | 增加批准后 intent 写失败、首目录成功次目录失败、写后记账失败、恢复再次失败四类注入；定义磁盘/结果/授权终态/Web 可见错误/原恢复机制断言，不承诺全局回滚。                                                                                                                                                                           |
| 工作量低估                                                             | A 为即时分流/授权内核，B 为多步 UI、所有领域存储、后台执行与生命周期的系统性集成；B 写域包含 `jev/wire.ts`，不按“两个小模块”估算。                                                                                                                                                                                                 |

### r3（2026-11-08；逐条闭合 r2 复审）

复审输入：**有条件通过，0 blocker，3 findings（2 严重 + 1 一般）**。本节保留历史设计处置，不冒充实施测试证据；其中 bridge 自行立即 async/latch 的接口归属由 r5 §3.5、§4.6–4.7 依现状更正。

| finding                                                              | r3 决策、契约与强制验收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **严重：同一 lane 不能阻止超时旧任务迟到覆盖**                       | 明确 `withTimeout` 仅 race，不 abort task；`bgDepth/bgChain` 不是物理在飞计数。记录 **raw task 到全部提交尾部真正 settle** 的任务身份，超时只标 orphan、不释放登记；有遗留任务时 Web 受控任务直接 `E_MEM_BUSY`，不 consume、不写定义/侧车、不外发，也不等待遗留任务自动重试。Web 准入在入队及出队各复核，执行期持独占 admission；native 新 task 不得穿过 Web 物理占用。见 §3.6、§4.4。§6.2.2 增加“native 超时→Web 入队尝试→旧结果迟到→重新 prepare/确认”的生产 lane 测试，断言无重叠提交、无已确认结果被旧结果覆盖。            |
| **严重：>30 秒终态依赖 record，history off/append 失败时错误不可见** | 删除“晚于回执只更新 record”。direct seam **无条件装配**独立 collector、终态 latch、`cmd_late + queryOnly`，复用现有 ledger 保存有界终态；record 仅可选旁路。accepted 立即返回 `completion:"async"`，保持 ledger running；终态写 ledger 后才发 late。补齐 mem 专用 UI 查询分支，成功/失败以及 ctl 先到均须查询，读取 `result.data.output` 或 `result.message`，不丢 partial/unknown/具体错误。见 §3.5、§4.6–4.7。§6.2.4 对 history off、record append 失败分别跑 >30 秒 success/partial/unknown，验证实际 Web 渲染和执行恰一次。 |
| **一般：外部 message-speed/archive 并行写域未协调**                  | `src/web-hub/agent/index.ts`、可能的根装配、tiers/trace 交 **唯一集成 owner I 串行修改**；A/B 和外部任务只提交窄接线说明，不同时写。message-speed/archive/`tests/config/**` 对本方案冻结；越界先协调，禁止整文件覆盖。精确路径、交接与顺序见 §6.3。                                                                                                                                                                                                                                                                             |

**已确认成立、作为 r3 设计依据，不重新推翻**：

- 即时 dispatch seam 从结构上消除来源降级 blocker：Web mem 不进入 SDK slash 队列。
- 私有引用身份 + 独立 Web 入口不可由模型 DTO、ctx 标记或 `cmd.confirm` mint；不伪造 HumanTurn/BAS，不改变模型授权。
- tags 冻结全文/实际外发材料，不调用旧 mutation，`jev/wire.ts` 已在 B 写域；r3 只补真实未 settle 追踪和 admission，不撤销冻结设计。
- tidy 四类故障注入及原恢复机制的闭合保留；r3 为其补独立终态投递，不改为全局回滚。
- migrate/tidy 冻结 manifest 足以防“确认 A 执行 B”，不批准后重新发现目录/条目。
- 原文 digest + reserve/consume + 两种 cap 禁互传自洽；命令分类无整类遗漏；RPC `ctx.ui` 退化为取消，必须显式 remote adapter；既有 questions/originKind 足够承载，无必然新增 wire 字段。
- I9/golden 不变仍须实施期测试证明，文档不能代替证据。r3 的 native 并发例外、ledger 保留和 mem UI 变更在下文显式声明，不能拿“native 不变”掩盖。

### r4（2026-11-08；闭合 r3 复审的一般 finding）

复审输入：**有条件通过，0 blocker，1 finding（一般）：批准后 busy 缺明确用户文案与浏览器断言**。本次仅补设计契约与强制验收，不声称已实现或实测通过。

| finding                                                     | r4 决策、契约与强制验收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **批准后出队 busy 仅有领域断言，不能证明 Web 用户看见拒绝** | §4.6 固定文案为「后台记忆任务尚未结束，本步未执行；本次授权已失效，不会自动重试，请稍后重新发起并确认。」；以本步 `E_MEM_BUSY`、零 consume/零提交、receipt revoke 为依据，经独立 once completion → `cmd_late`/terminal ctl → `queryOnly` → DetailDock 可见 DOM 呈现。§6.2.2 补批准后出队竞速及多步 partial 断言；§6.2.4 在原六组之外增加三组 busy 浏览器用例：正常 record、history off、record append 失败。三组都断言完整固定文案实际可见、consume=0、本步提交=0，drain/重连/重放后无自动重执行；多步已有成功项保留并报 partial。 |

**r3 复审确认成立，继续作为设计依据**：raw 登记覆盖提交尾部物理 settle，入/出队双检与同步独占不变；独立于 record 的 async reply-only/late/query 通道、32 槽保留、once 终态及 `retryable=false` 不变；`src/web-hub/agent/index.ts` 等共享装配由唯一 owner I 串行接线，A/B 不直接写；generic extension 的 `sendUserMessage` 之前截获全部 mem，缺 seam 一律终止，不回落 native/SDK。本轮不替换这些机制，不扩大实现范围。

## 1. 背景与目标

### 1.1 用户已确定的范围

所有**现有且在当前布局/设置下有实现**的 `/mem` 写命令均可从 Web 执行，必须先弹明确确认框，批准后才执行。包括 project 迁移、导入、整理、恢复，session/hub 单条写入，以及 hub adopt/restore；不能只放开 migrate。

- **TUI 交互行为不变**：原直接执行的 add/rm/init/import 不新增弹框；原逐项选择、接管手写文件、adopt/restore 确认的文案、次数、选项顺序不变。新严格解析仅用于 Web，不修正 native 历史参数行为。Jev 与正在执行的 Web effect 的互斥是 §3.6 声明的并发约束，不是新增 native 确认。
- Web 所有写操作 exact-content 确认；只读预览不确认，特别是 `migrate --all --dry-run`。
- child 不获得写权限；secure/locked、scope/layout/feature 开关、锁、CAS、unknown/poison 不放宽。
- 范围变更登记：r4 原禁止新增 `session rm`，后续任务上下文将 session add/rm 纳入目标范围；这是新增目标而非现有能力。当前 native `session` 仅开放 add，没有 rm 语法；实现 rm 必须新增 native 语法及 Web 对应入口，且各自保留授权边界，补原文读取、rev、CAS、unknown 验收后才可宣称支持。其余未实现语法不因分类而开放；不实现 `tidy --batch --triage`，不开放 blocks tidy，不改变模型 `memory`/`scoped_memory` 授权规则。
- 不新增设置或 wire capability；复用 Web 控制/命令/remoteAskUser 能力。没有可信通道即拒绝，不能静默降级执行。
- 不新增全局回滚。已外发模型请求/费用、破锁、无备份覆盖不可撤销，批准前告知。
- r5 只修订此文档；下列设计性接口/测试/写域除明确标为已交付者外，均为下游实施要求。

### 1.2 必须分开的三个概念

1. `cmd.confirm:true`：现有传输防误触位，**不是写授权**。
2. 真人来源：认证 Web command 当前调用证明，或既有模型回合 HumanDispatchProof；不是 hasUI、命令字符串或来源显示文本。
3. 原文授权：当前 dialog 中选择绑定具体计划摘要的肯定项；不能授权未来尚未生成的模型修改。

另须分开：**逻辑完成/超时**不等于 task/provider/提交尾部物理 settle；**命令记录**不等于 Web 终态投递。两个区别分别是 r3 的并发与可见性边界。

## 2. 现状摘要

### 2.1 文件坐标与关键证据

| 路径 / 符号                                                                                                        | 已核验事实                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/memory/command.ts:createMemCommand/isInteractive`                                                             | 先 scopedRouter 后旧命令；`isInteractive`（596–597）为 `hasUI && mode === tui && !isWebInvocation(ctx)`。失去 capture 标记的 Web slash 在 TUI 宿主满足 native 条件。                             |
| `src/memory/init-command.ts`、`store.ts`                                                                           | init/import 不是统一 TUI-only；必须在 Web 入口统一保护，不能只修 migrate。                                                                                                                       |
| `src/commands/capture.ts:226–256,763–786`                                                                          | take 依 name/args 认领；fallback TTL 5秒，capture 30秒；无 invocation 时调用原 handler 或 observed proxy，不保留 Web 负向来源。captured select/confirm/custom/editor 退化为取消。                |
| `src/web-hub/agent/builtin-bridge.ts:236–325`                                                                      | arm capture、noteIntent、sendUserMessage（默认 followUp）、settleArm；已送 SDK 的命令不能由撤销 ticket 撤回。旧 async extension 通过 sendLate 收口。                                             |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:696–725,1085–1086,1650–1652`（r2 核验）   | settled 先置 run inactive，再 await hooks，之后 drain deferred；isIdle 不包含 emitting-settled；延迟超过 fallback TTL 才进 slash handler 是真实可达路径。                                        |
| `src/web-hub/agent/command-record.ts:75–85,489–511`                                                                | RecordHandle.settle 返回 void，写失败被旁路计数吞掉；record 30分钟、intent 10分钟，均不是来源/授权/必达终态。`beginExternal` 可用于 direct dispatch。                                            |
| **`src/web-hub/agent/index.ts:885–913`**                                                                           | **cmdHistory=false 不构造 recorder**；不能把晚结果只放 record。`982–993` 的 sendLate 为既有独立接线，但 direct seam 必须确保它已就绪，不能 optional drop。                                       |
| `src/web-hub/agent/commands.ts:274–286,320–332,1090–1176`                                                          | replyOnly 不 settle；已有 29 分钟 Promise 分支与 completion 收口，复用该路径而非另造 bridge latch；写执行器和撤销端口仍待接线。queryOnly 返回 `{op:"query",state,result}`。                      |
| `src/web-hub/agent/ledger.ts:160–164,213–234,277–290`                                                              | 现有进程级纯数据 ledger：512 项、terminal TTL 30分钟、running≤16；已实现 32 槽 mem completion 保留。须复用并验证现有保留/终态路径；retryable+none 的通用删除路径不能使已接纳写重执行。           |
| `src/web-hub/ui/src/logic/{control,state}.js`、`composables/useHub.ts:628–645`、`components/detail/DetailDock.vue` | 既有成功 late 可触发 queryOnly；失败 late/terminal ctl 可能直接结束 pending、丢具体 message；查询成功 output 在 **result.data**。mem 需窄适配成功/失败及 ctl 先到竞速，不是只在 agent 发个事件。 |
| `src/memory/jev/command-port.ts:357–382,418–424`                                                                   | tags add、新 description rev、preset enable 成功后 triggerBulk；native 签名没有命令 lease。                                                                                                      |
| **`src/memory/jev/wire.ts:411–422,829–833,1178–1233`**                                                             | **withTimeout 仅 Promise.race**；native task 超时后 chain/depth 前进，原 task 未 abort，仍可能迟到 persistTags。runBulk 在出队时取 corpus/taxonomy；bgDepth=0 不证明无活任务。                   |
| `src/memory/jev/tagging.ts:tagBulk`                                                                                | 支持 entries/taxonomy/base/signal；已有失败停止逻辑，不等于具备命令 lease、raw task 追踪或提交 guard。                                                                                           |
| `src/memory/tidy/txn.ts:runStep:308–345`                                                                           | intent append 在 action try/catch 外；afterAction/beforeResult/result append 间可能已改盘；已有 attempt fence + final observation，recoverRun 不重放已 attempt action。                          |
| `src/memory/tidy/{command,batch-command}.ts`                                                                       | restore/实际 tidy 可能先 recover；batch 有 overlay/viewer/逐批 UI；只读不能顺带 recover。                                                                                                        |
| `src/memory/{jev,govern}`                                                                                          | review/expired 有逐项内容与侧车决策，review --run/blocks sweep 有写/模型副作用。                                                                                                                 |
| `src/memory/scopes/{command,session-command,hub-management,hub-store}.ts`                                          | native 私有 grant、FIFO/锁/token；adopt/restore prepare→token-bound select→commit；没有 session rm。                                                                                             |
| `src/memory/scopes/{authorize,op-cap,tool}.ts`、`src/web-hub/agent/human-dispatch-proof.ts`                        | 模型 user/hub 写需真实模型人类回合 + exact digest + dialog→OpCap；slash 不经 user BAS。与 command cap 隔离。                                                                                     |
| `src/ask-user/remote.ts`、`src/web-hub/agent/dialogs.ts`                                                           | 复用 open/setOnRemote/close、createDialogRace、nonce/id/epoch/选项校验；originKind 是可信 CmdOrigin 的 agent-local 投影。                                                                        |
| `src/web-hub/agent/{command-policy,commands}.ts`                                                                   | scoped writes 在 override 前 hard deny；prompt 发 SDK 时 expandPromptTemplates=false，仍需最终发送边界拒绝 mem 替代入口。                                                                        |
| **`src/web-hub/agent/index.ts:100–101,249–256,984`**                                                               | 同文件已有 message-speed imports、archive 设置与 builtinBridge 装配；本方案并不独占整个文件，必须单 owner 集成。                                                                                 |

r3 定点核验 raw task/recorder/ledger/UI/共享装配证据；r4 只读复核 memory/Web README 与 UI late 分支，补 busy 呈现/验收契约。保留 r2 已确认的 SDK 与领域结论，不以重新探索推翻。已读 `docs/dev/memory/README.md`（含 Jev 不变式）、`docs/dev/web-hub/README.md` 相关总述、`docs/dev/ask-user-async/README.md`。历史“TUI-only/Web write deny”是本次声明要改的行为，其余门禁保留。

### 2.1.1 r5 能力快照（不是目标分类表）

| 状态                            | 当前能力及边界                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 已交付并已接线：只读执行        | `list`、`path`、`restore` 列表、单目录 `migrate --dry-run`、`migrate --report`、`tidy --batch --status`、`tidy --batch --dry-run`、`tidy --dry-run --frontmatter`。                              |
| 已分类为 read，但执行器尚未支持 | `doctor`、`migrate --status`、`migrate --all --dry-run`（`--all` 的只读变体）；分类为 read 不等于 Web 可直达执行。                                                                               |
| 其它尚不可用模式                | 裸 `migrate --all`（destructive）、`expired`（flow）、`expired --list`（unknown，尚无受支持的纯列表 Web 语法）、裸 `review`（只读语法是 `review --list`）。                                      |
| 已接线的调用形式                | 生产目前注入的是只读函数引用，不是逐次签发的 `MemoryWebCall`；写入必须另接可信调用工厂与受保护 consumer，不能把只读引用当写授权。                                                                |
| 已交付基础设施，未完成写接线    | `commands.ts`/`ledger.ts` 的 32 槽 completion ledger 与 29 分钟 Promise 分支已实现；B1 仅交付同步 `check/consume/apply` 原语，领域锁、完整冻结计划、lease、物理任务 guard 和端到端验收仍待接线。 |
| 待实现                          | 本方案的生产写入口、可信调用工厂、领域 consumer 和异步终态完整可见性；详见 §6.3 各包状态。                                                                                                       |

不得为了让文档好看而把实际写命令的分类改成 read。

### 2.2 散落的交互/可写门清单

| 位置                                  | 当前判断                                                       | 设计处理                                                |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| command.ts migrate                    | child、写且 !isInteractive、all 且 !isInteractive              | child 保留；Web 写统一授权；all 只读放行。              |
| restore --block                       | 只拒 child，无确认                                             | Web exact plan，native 原样。                           |
| blocks review/expired、files handlers | interactive 或降级列表                                         | Web decision port，不伪造 interactive=true。            |
| handleMemJev                          | retag/reset-index child 或 !hasUI 拒；probe 无此门             | Web 三种副作用均确认，含 probe 成本。                   |
| handleMemTags.gated                   | add/rm/disable/enable child 或 !hasUI 拒                       | Web 独立 prepare/commit，不调用 native 触发器。         |
| toMemCommandUi                        | hasUI 才 select/confirm/editor                                 | Web 显式 remote，不走 captured 假取消。                 |
| contentReadonly、init/import          | scopes-on child 内容门；旧 init 另有 allowWriteInChildSessions | Web 通用 child 门覆盖，allow=true 不产生 Web 权限。     |
| tidy/command.ts                       | child/!hasUI/TidyPort；blocks tidy 禁用                        | 只替换 Web UI 门，保留能力门。                          |
| batch-command.ts                      | breakLock TUI/not-Web；实际 batch 拒 Web                       | 冻结 holder/epoch；select-loop 替 overlay，保留锁规则。 |
| govern/review-lite.ts                 | --run/enabled/interactive 才 sweep                             | sweep 先批准，后续正文另 exact。                        |
| scopes/command.ts、owner.ts           | main/tui/UI/not-Web，native environment                        | 原 native seam 不放宽；新增 confirmed consumer。        |
| human-dispatch-proof.ts               | rpc 不开本地 select                                            | sharedApproval 不改；Web 显式 remote。                  |
| command-policy.ts                     | scoped write hard deny                                         | 仅已实现语法开放到业务确认，override 不能免确认。       |

参数隐患：native tidy 在 dryRun 返回前可能进入 frontmatter 模式。Web parser 将 `tidy --dry-run --frontmatter` 路由为**真正只读** backfill 计划，不进 native runFrontmatterMode；migrate readonly flag 与 rollback 等歧义混用报 usage。native 历史解析不变。

## 3. 总体设计

### 3.1 模块、职责与依赖方向

```text
认证 Web cmd + ledger 新 dispatch / completion 槽预留
  → builtin-bridge 的 mem 专属分支（早于 generic extension dispatch）
  → MemoryWebCommandDispatch.start：同步准入/一次认领，直接启动 Web handler
       ╳ 不调用 sendUserMessage/session.prompt/SDK slash/followUp
       ╳ 缺 seam / completion 通道时不回落 generic/native
  → 私有 WebCall（source=web，owner/frame/signal/lease，永不变 native）
  → parse → read / prepare（冻结完整 effect）
  → 显式 remote choose/confirm → CommandApproval
  → 原 store/txn/confirmed scoped seam / Jev controlled admission
  → 原锁内 gate/CAS/owner/物理在飞状态复核 → consume → 提交
  → 输出 collector + 既有一次终态收口 → ledger → cmd_late → Web queryOnly / 渲染
                                     ↘ 可选 record（旁路，失败不阻断主通道）

native SDK registerCommand("mem") → 原 native handler / 原 UI / 原 grant
模型 memory/scoped_memory → 原 HumanTurn/sharedApproval/OpCap
```

新增两个职责集中的模块，**不代表只有两个小模块的工作量**：

- `src/memory/command-policy.ts`：pi-free Web 严格解析、归一化、唯一分类/needsConfirm；Web agent 可 import，hub/protocol 不 import memory。
- `src/memory/command-confirm.ts`：pi-free call/receipt registry、channel/race/deadline/执行 lease；不承担领域存储或通用任务引擎。

Web dispatch/remote 装配放既有 memory/index、command、Web agent 接线。领域计划仍在原 command/store/txn。Jev raw 任务追踪与 admission 放 `jev/wire.ts`；completion 与终态 latch 复用 `agent/commands.ts`/`agent/ledger.ts` 现有实现；所需输出收集接入既有路径，不再建立第二账本或第二终态 latch。mem UI 窄适配在现有 reducer/DetailDock，不造另一套 UI/数据库/持久审批队列。

### 3.2 `needsConfirm(cmd)` 与完整分类

本表是目标语义分类而非已开放执行器清单；当前可直达范围以 §2.1.1 为准，read 分类更宽，未接线项仍不可执行。session rm 是后续新增目标，当前 native 和 Web 均无此语法。

只接受解析成功的封闭类型：`cmd.class !== "read"`。只有 Web 新增统一框，TUI 原分支。

| 类别              | 已实现命令 / 模式                                                                                                                                     | Web 规则                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| R 纯读            | 空/list/path/doctor；jev report；tags/list；review --list；migrate --dry-run/--report/--status（可 --all）、--dry-run --import-legacy                 | 零框，保留读 gate。                                                                  |
| R 计划/列举       | tidy 合法 dry-run/frontmatter/batch preview；batch --status；restore/--trash/--legacy 无目标；session/hub list/status/path；hub show id、trash        | 零 mkdir/recover/lease/model/回填。                                                  |
| S 单条写          | init；session add 全文（目标新增 session rm 原文）；hub add 全文、rm id；tags rm/disable、无回填 matcher-only 更新                                    | 一次具体内容确认。                                                                   |
| D 破坏性/多目录写 | migrate/default/rollback/import-legacy（可 all）；import [--force] [slug…/all]；各目标 restore、restore --block；hub adopt/restore；tidy --break-lock | 冻结完整集合、覆盖/删除/权限变更与回滚限制。                                         |
| F 多步            | tidy/frontmatter/batch/archive-only；review/expired 默认处理（files/blocks）                                                                          | 导航不写；具体副作用逐次确认，入口批准不授权未来模型结果。                           |
| E 模型/派生副作用 | jev probe/retag/reset-index；review --run；**tags add/description 更新/enable 的定义变更+回填**                                                       | 冻结输入全文/实际外发、taxonomy、模型/预算、侧车影响；等待结果，不 fire-and-forget。 |
| X 非法/不可用     | 未知语法、当前的 session rm、triage、scope/feature off、blocks tidy                                                                                   | usage/原能力错误，零框零写。                                                         |

本基线没有 project add/rm、session rm；session rm 的新增范围及验收边界见 §1.1。F 的 choose/view 不产 receipt。删除/延长/keep不再提醒等需完整原文/元数据/digest；选择框完整承载时肯定项就是确认，不追加空框。

### 3.3 来源与 channel：在 native 分流前封死降级

**保留 r2 的专用即时 seam 目标**。当前只读生产路径是函数引用而非逐次 `MemoryWebCall`；写路径须另接可信调用工厂，不能将下述设计误作现状。不读取 SDK 私有 `_isEmittingAgentSettled`，不假定撤销票据能移除 SDK 队列。

1. `BuiltinBridge.execute` 对归一化命令名 mem（含 read/非法参数）在 generic dispatchExtension **之前**命中专属分支。拒绝、busy、缺 seam、过期、异常均就地返回，不得继续 sendUserMessage；不能仅截获看上去是写的参数。
2. 直接调用 memory Web handler，不调用 SDK native handler、不构造假 ExtensionCommandContext，不走 capture.arm/take/settleArm 或 record noteIntent。输出用显式 sink，记录可选 beginExternal。
3. 第一个参数为私有工厂签发的 `MemoryWebCall`，registry 以对象引用校验，只有认证 CmdOrigin、新 ledger dispatch、当前 actual manager/owner/generation 可创建。过期/abort/dispose 后是 **revoked Web**，不是 native；DTO/ctx 标记不可签发。
4. Native handler 保留原入口/参数/UI；Web 不引用 native direct grant 工厂作 fallback。共用只读计划与受保护领域 consumer，不共用“先试 Web 再 native”的 handler。
5. ctx.mode=rpc 不等于 Web，hasUI 不是来源；旧 webInvocation 只用于旧输出。capture/record TTL 不改变 WebCall 身份或 consumer 路由。
6. Web prompt/held/replay 不作 mem 替代入口：expandPromptTemplates=false 保留；commands.ts 的 prompt 及 held/replay 最终发送边界，对 slash 解析为 mem 的文本拒绝并提示 op:command。飞书也不能借 prompt 执行 mem 写；普通非 mem 文本不变。

安全断言是 **Web mem 从未进入 SDK slash 队列**。TUI 宿主 idle=true 且正 await settled hook 时，也只能立即走 remote 确认/明确拒绝，不等 SDK drain 转 native。实际 run 非 idle/pending、已有 Web 写、切换/手动 compact 时拒 busy/stale；这些是并发准入，不是来源安全依赖。

### 3.4 独立 CommandApproval，不伪造模型回合

- 待实现的可信写调用工厂签发 `MemoryWebCall`；现有只读函数引用不提供写权限。
- start 同步绑定 owner/frame.id/rawArgs/actual manager。重复 ledger 请求仅重放/查询，不新 invocation；重入/并发拒绝，不依赖 name+args、最近回合、next-command。
- remote callback 必须 originKind∈{loopback,lan}，确切单题 key/合法值、nonce/id/epoch、owner/invocation/step/digest 有效才 mint；自由文本、Feishu、缺 originKind、confirm bit 不授权。
- reserve→提交前 consume；失败/拒绝/abort 永久 revoke。每 owner 一个 Web 写流程/一个框；超时结束不循环重弹。多步不套模型每回合3框限制，但受总墙钟约束。
- tracker/sharedApproval/MemoryOpCap 不动；无真实模型人类回合仍 E_HUB_NEEDS_HUMAN_TURN；command cap 不进模型 enqueue，模型 cap 不进 command commit。
- 不声称识别持同凭证恶意程序与物理真人；保证模型参数、旧请求、显示文本和通用 confirm 不能自批。

### 3.5 即时 dispatch、独立终态与可见性（r3）

Web seam 从当前 ExtensionContext 取 cwd/registry，从唯一 owner 取 actual manager、sid/file/epoch，不缓存/强转旧 command ctx，不需要 waitForIdle/switchSession/sendUserMessage 能力。

**现有归属与目标接线**：`commands.ts`/`ledger.ts` 已实现 32 槽 completion ledger 和 29 分钟 Promise 分支；复用其 Promise 分支、预留与终态收口，不再按 r3 假设由 bridge 拒绝返回长 Promise 并自行立即 async，也不另造账本或第二终态 latch。写 executor 的可信工厂、结果与输出接入仍待实现并验证。30 秒观察窗口不是任务终态截止；同步及迟到结果不得倒退为 running。

**结果终结不等于写撤销**：当前 timeout/dispose 能收口结果，但生产写尚无 abort/revoke 端口，不能据此声称迟到写被阻止。lease、提交口 guard 和物理任务追踪必须接线并端到端证明。同步只读结果在 cmdHistory 默认开启时不可见的问题已修；这不代表异步终态可见性已解决。旧查询回调仅按命令名保护，同名新操作仍可能被旧结果覆盖；须绑定 `cmdId + owner/会话 + 用户操作代际`。抽屉页签的晚到恢复属于其他面板，不是 `/mem` 已修证据。

**必要接线**（与 cmdHistory 无关）：

1. 在 start 前确认 completion reserve/query/publish 与 `handleBridgeLate` 已装配；缺任一项直接拒绝、零框零业务 effect，不能 optional-chain 丢终态。
2. 每 accepted invocation 一个输出 collector（接入既有终态收口，不另造 latch），复用 sanitize/8KiB单条/32KiB总量/64条限制；不使用全局 activeStack、ctx.ui 捕获或 record buffer。为终态摘要预留8KiB，过程输出最多24KiB；进度刷屏不能挤掉最终 effect/code/恢复提示。
3. done resolve/reject、timeout、abort/dispose 进入 commands.ts/ledger.ts 既有 once 终态收口；接线完成后先撤销授权/lease，按实际观察构造结果，再将终态写入保留的 ledger 项，最后发 `cmd_late`。`record.sink/settle` 只是独立 try/catch 旁路；其不存在/抛错/append 失败均不影响 collector、latch、ledger 或 late。
4. late 是通知，**queryOnly 是结果本体**。success 通过 `query.data.result.data.output`；失败通过 `query.data.result.{code,message,effect,retryable}`（不是顶层 data.output）。具体领域码/effect/已完成/不确定/恢复线索写在 output 或 failure message，见 §4.6。
5. mem UI 必须在 success/failed late **和 terminal ctl 先到**时保留 pending 并发起有界 queryOnly，而非先移除或只显示通用码。DetailDock 查询解包还需处理 inner `ok:false`。普通命令按旧 reducer，不全局改所有控制流。§6.2.4 必须走生产 UI 验证，agent sink spy 不算到达 Web。批准后出队 busy 同样走此失败分支，固定文案见 §4.6，不能以 `E_RATE` 徽标替代。
6. ledger 终态保留独立于 record，具体容量/TTL/准入见 §4.6。连接临时断开时保留结果；重连后只 query，不重执行。永久断网/进程被杀不承诺主动送达，UI 明示不可达/未知，不能假报成功；保留窗口内可查询。

初始回执明确“已接纳，等待确认/执行；30秒不是完成期限”。最终 status 必须来自 completion 通道，不能要求用户打开 history 或用 batch --status 替代其他命令的终态。

### 3.6 tags：冻结复合 effect + 真实未 settle 的互斥（r3）

**保留 r2 冻结**：不调用旧 tagsAdd/tagsSetEnabled 后再取消 triggerBulk。复用解析、定义校验、mergeTaxonomy 纯计算，新增 Web prepare/commit consumer。prepare 只读冻结：旧/新完整 taxonomy、tag/rev、corpus 身份/条目 hash/rev、eligible 全文及脱敏后的实际外发材料、private/secret 排除项、base index、侧车集合、模型链、问题/分批规则版本、调用上界、预算/费用风险。新增 tag、description bump、preset enable 都纳入；rm/disable/matcher-only 无回填仍确认定义写。不得批准后 corpusFor 重新选目标。

确认绑定“定义写入 + 此冻结回填”复合 effect，不授权正文修改。无价目不得虚假硬费用保证；披露保守调用/时长、未知计费风险。

**纠正 r2 lane 假设**：同一个 bgChain 只能串行其 timeout wrapper，不能串行仍活着的 raw task。选择**真实在飞追踪 + busy 拒绝**，不宣称仅共用队列就安全，也不引入一套 sidecar MVCC。

- `enqueue` 在调用 native task 前登记唯一 raw 身份；任务从同步前缀、模型等待、锁等待到 persist/相关写尾部全部 settle 才移除。同步 throw 也有对应清理。withTimeout 返回只标 timeout orphan，不删除登记；bgDepth 减少、signal.aborted、client.abortBackground 被调用均不能替代 raw settle。
- Web prepare 前可早检；**runControlled 入队前与出队执行前都必须检查**是否有 timeout orphan。存在任何遗留任务即返回 `E_MEM_BUSY`/effect=none，revoke 本步 receipt，不消费、不定义写/外发/侧车写，也不把 Web 留在队列等旧结果。入队前的早检不能省略出队复核：native 可在 Web 排队期间才超时。批准后出队拒绝的固定用户文案及多步聚合见 §4.6，必须经独立终态实际呈现在 Web。
- 正常尚未超时 native job 可在同 lane 先完成；Web 出队时只在 **所有其他真实提交任务都已 settle** 后同步获得 Web 独占 admission，检查 signal/lease/owner/完整计划、锁内 CAS 后 consume。若有任何其他 raw task 尚活，直接 busy，不等待、不重试。检查与取得 admission 之间不得 await。
- 独占 admission 覆盖定义写到整个 controlled task 物理 settle；native 新入队项可保留原 FIFO，但不得在 Web admission 存续期间启动 task 的同步前缀。Web 逻辑 timeout/abort 不当作物理释放：调用者有界 settle，仍留占用/拒绝新的 Web；排队 native 受该占用约束，不能穿过。不得在等待者中无限新建 timer/轮询/第二队列。
- 全部受跟踪 raw task 的提交尾部必须可枚举且被 await；fire-and-forget persist/diag 不算已 settle。Web 诱发的回填/diag 禁 detached。native 正常队列/提示保留，**仅在与 Web 物理占用冲突时延迟启动，以及 lifecycle 撤销后禁止旧提交**是声明的安全例外；没有 Web 占用时不把 native 的120秒 wrapper全局改成无限 await。
- tracker 放 wire 实例闭包，session_start/bgAbort 换代不能清掉未 settle 身份。dispose 后不允许旧任务提交；native 原 persist/写尾部也须携带该 task 的 activation/generation guard，在锁内最后 await 后检查，避免 /reload 新实例误把旧任务当已消失。不得靠超时清空/TTL/“abort 已调用”解锁。新旧 activation 不共享 Promise/ctx/cap；不新增模块级可变表。首次从未带此 guard 的旧版本热升级，不以本方案声称能追踪旧闭包，需在无后台任务的边界启用/重启。

获得 admission 后只读复核 corpus/taxonomy/index：任何新增/删改/身份变化整个 step `E_MEM_PLAN_CHANGED`，**定义不写、模型不发**，不重新选择目标；最后同步复核并 consume 后写冻结 taxonomy、执行冻结 tagBulk，全程不调用 runBulk(cwd,"all")。

定义成功而回填失败/撤销：partial，分列已外发/费用、已存侧车、待处理数；不回滚定义、不自动重排，无“backfill queued 即成功”。每次物理 attempt（含 failover/split/retry）前、等待后、锁内侧车提交前查 lease/signal/gate；provider 迟到结果丢弃，不走无 guard persist/diag。撤销线性化点后不得新外发/写。

Web 定义提交不得经 triggerBulk/onFull/pending-backfill 另排 detached job；invalidation 携 command effect 上下文，只失效缓存。既有无关 native/startup 自动任务不获得 command cap，不扩大本计划；它们若有并发提交必须受上述 admission/锁内 guard 约束，不能一句“无关后台”规避。无关周期任务在隔离测试中关闭并单独记归属，生产不会全局关闭 Jev。

## 4. 接口契约

以下为内存 TS 契约，不进模型 schema/wire；opaque 类型由私有工厂签发，`exactOptionalPropertyTypes` 下缺值省略，不显式塞 undefined。

### 4.1 专属 Web 入口与封闭分类

以下为目标接口而非当前只读接线；session rm 需先新增 native 语法，再为 Web 接入独立可信授权，并验证原文读取、rev、CAS、unknown（§1.1）。

```ts
interface MemoryWebCommandDispatch {
  // activation-private；ctx 是当前 ExtensionContext，不是假 command ctx。
  start(
    request: TrustedMemoryWebRequest,
    ctx: ExtensionContext,
  ):
    | { accepted: false; code: MemoryCommandErrorCode; message: string }
    | { accepted: true; invocationId: string; done: Promise<MemoryCommandExecutionResult>; abort(): void };
}
interface TrustedMemoryWebRequest {
  readonly frameId: string;
  readonly rawArgs: string;
  readonly origin: CmdOrigin;
  readonly signal: AbortSignal;
  readonly output: (entry: CommandOutputEntry) => void;
}
function executeWebMemoryCommand(
  call: MemoryWebCall,
  cmd: ParsedMemoryCommand,
  env: MemoryWebEnvironment,
): Promise<MemoryCommandExecutionResult>;

type MemoryCommandClass = "read" | "single" | "destructive" | "flow" | "effect";
interface ParsedMemoryCommand {
  readonly kind: MemoryCommandKind;
  readonly class: MemoryCommandClass;
  readonly rawArgs: string;
  readonly options: Readonly<{
    all: boolean;
    force: boolean;
    legacy: boolean;
    targets: readonly string[];
    text?: string;
    tag?: ParsedTagDefinition;
  }>;
}
function parseMemoryCommand(
  args: string,
): { ok: true; command: ParsedMemoryCommand } | { ok: false; code: "E_MEM_ARGS"; usage: string };
function needsConfirm(cmd: ParsedMemoryCommand): boolean; // class !== "read"
```

这些是逻辑装配边界，pi-free policy/confirm 不 import ExtensionContext/CmdOrigin：pi-facing 类型留既有 memory/index/Web bridge，内核只消费其规范化私有数据。

MemoryCommandKind 为 §3.2 逐项封闭 union：list/path/doctor/init/import；migrate、migrate.preview/report/status/rollback/import-legacy/preview-legacy；tidy、tidy.frontmatter/batch/archive-only/preview/status/break-lock；restore.list/backup/trash/block；jev.report/probe/retag/reset-index；tags.list/add/rm/disable/enable；review.list/review/review.run/expired；session.list/status/path/add（目标另含 session.rm，当前不可用）；hub.list/status/path/show/trash/add/rm/adopt/restore。kind→class 由 parser 赋值，外部不能自填 read。tags 保守按 effect，prepare 再具体化，不因 matcher-only 免确认。

targets 按 kind 验证：单 id 恰1，add 保留原文；import 为0..N slug、all归一化；tags复用 quote-aware parseTagsAddArgs。未知 flag/互斥 action/多余 id 报 usage；后验 scope/layout/feature，解析成功不等于能力开放。

### 4.2 冻结计划与确认端口

```ts
interface MemoryCommandTarget {
  readonly scope: "project" | "session" | "hub";
  readonly path: string; // canonical / actual sessionFile / 明示 memory-only
  readonly identity: string;
  readonly entries: number;
}
interface MemoryCommandPlan {
  readonly invocationId: string;
  readonly step: number;
  readonly command: ParsedMemoryCommand;
  readonly targets: readonly MemoryCommandTarget[];
  readonly effect: "write" | "recover" | "model" | "write-and-model";
  readonly manifestDigest: string; // 全字段 canonical sha256
  readonly presentation: string; // 完整影响、原文/差异、回滚限制
  readonly affirm: string; // 动作 + digest8
}
interface MemoryCommandConfirmPort {
  readonly channel: "tui" | "web" | "unavailable";
  choose(req: MemoryCommandChoice, signal?: AbortSignal): Promise<MemoryCommandChoiceResult>;
  confirm(
    plan: MemoryCommandPlan,
    signal?: AbortSignal,
  ): Promise<
    | { approved: true; receipt: MemoryCommandApproval }
    | { approved: false; code: MemoryCommandErrorCode; message: string }
  >;
}
interface PreparedMemoryCommand {
  readonly plan: MemoryCommandPlan;
  commit(receipt: MemoryCommandApproval, signal?: AbortSignal): Promise<MemoryCommandExecutionResult>;
  cancel(): void;
}
interface MemoryCommandApprovalConsumer {
  reserve(receipt: MemoryCommandApproval, plan: MemoryCommandPlan): boolean;
  check(receipt: MemoryCommandApproval, plan: MemoryCommandPlan): boolean;
  consume(receipt: MemoryCommandApproval, plan: MemoryCommandPlan): boolean;
  revoke(receipt: MemoryCommandApproval): void;
}
```

- Choice 冻结 `{invocationId,step,title,options:readonly {value,label}[]}`；结果 `{ok:true,value}` 或 `{ok:false,code,message}`，导航不 mint。
- manifest 深冻结在 prepare 闭包，含所有新正文/前置状态/操作；复用 canonicalJson/sha256；不能外部单给 digest。
- confirm 不 mkdir/recover/leaseCreate/model spawn。Web 单题 MEMCMD、allowOther=false、拒绝首项、唯一 affirmative 含 digest8，验证确切 key/value。
- native adapter 仅原 UI；Web 显式 remote，不覆写 ctx.ui、不跨通道代批。

### 4.3 消费顺序与领域 seam

reserve→出队复核/物理 admission→锁内重读/比对→最后 await 后同步复核 owner/receipt/signal/gate/CAS→consume→首次 mutating I/O/外发。确认期间不持目录锁。consume 后失败也 revoke 终态，不恢复 reserved/minted。一个 cap 可覆盖枚举的多文件事务，内部不可扩域 lease，不是一原语一框。

1. project 复用 safe-fs/lock/txn；mkdir/recover/lease/model 都在 effect 审计域，不能只包主 write。
2. scoped 保留 native registry/management.command/commit；新增 command-only `enqueueConfirmedCommand(request,receipt)`、`management.commandConfirmed(operation,receipt,signal?)`、`management.commitConfirmed(token,receipt)`，prepare 绑定 WebCall/token；仍走同FIFO/锁/slot/poison/gate，匹配完整 operation/token digest。
3. 不把 trustedNativeMemoryCommand 改成 native||web，不进入模型 DTO；adopt/restore 复用原 token/scopedHubConfirmationTitle，一次确认，finally cancel(token)。
4. provenance 仍 via=command/by=user；仅既有可选审计 channel=web、cap=digest8、who=originHash8，不填假模型 turn、不落正文。

### 4.4 Jev controlled effect 与 raw task 契约（r3）

```ts
interface FrozenJevBulkInput {
  readonly dir: string;
  readonly dirIdentity: string;
  readonly corpusDigest: string;
  readonly entries: readonly MemEntry[]; // 固定 eligible 集合，深冻结
  readonly taxonomyBeforeDigest: string;
  readonly taxonomyFileAfter: TaxonomyFileV1;
  readonly taxonomy: Taxonomy;
  readonly base: JevIndexV1;
  readonly indexDigest: string;
  readonly outboundDigest: string; // 实际脱敏材料/问题版本/模型链/批次规则
  readonly maxCalls: number; // 含 failover/split，超限停止
  readonly budgetMs: number;
  readonly estimatedCostUsd?: number; // 未知省略并披露非硬金额上限
}
interface MemoryCommandExecutionLease {
  readonly signal: AbortSignal;
  check(): boolean; // owner/epoch/deadline/撤销同步检查
}
interface JevConfirmedCommandPort {
  prepareTags(cmd: ParsedMemoryCommand): Promise<PreparedMemoryCommand>;
  // 既有 lane 中 awaitable item；内部实施 §3.6 的两次 busy 检查及独占 admission。
  runControlled(input: FrozenJevBulkInput, lease: MemoryCommandExecutionLease): Promise<JevControlledResult>;
}
interface JevControlledResult {
  readonly definition: "unchanged" | "written" | "unknown";
  readonly callsStarted: number;
  readonly inputsSent: number;
  readonly tagged: number;
  readonly persisted: readonly string[];
  readonly pending: readonly string[];
  readonly effect: "none" | "completed" | "partial" | "unknown";
  readonly error?: { code: string; message: string };
}
interface JevPhysicalTaskSnapshot {
  readonly active: number; // 真正未 settle，含已超时任务
  readonly timedOutPending: number;
  readonly webExclusive: boolean;
}
```

物理 tracker 为 wire 私有设施，不由 DTO mint/清空，不向模型暴露：

- 每 native/controlled lane item 在 **调用 task 前**登记 token；保留 raw Promise，`raw.then(success, failure)` 才清 token，timeout wrapper 的 finally 只维护逻辑 queue 计数。登记范围必须含全部有提交能力的子 Promise；模型内部 race 若会遗留提交 callback，纳入 token 尾部或在提交口 generation guard 隔离，不能把一个提前 resolve 的外壳当 raw。
- `runControlled` 入队前见 timedOutPending>0 立即 none/busy；出队再见 orphan/其他 active>0 同样拒绝。正常队列等待计总墙钟；已取消 item 出队仅 settle，无新 corpus 构建/外发/写。只允许只读校验 frozen corpusDigest，变化拒绝，不重选。
- 出队的“查 active + acquire webExclusive”同一个同步临界段；等待目录锁后再查 lease/plan，只有当前 Web token 可写。admission 不等于 cap：busy 不 consume；任何失败 revoke receipt。
- native enqueue 在 Web exclusive 存续期不启动 task。独占释放绑定真实 settle，不能绑 Web 对外 done/deadline；释放后仅恢复既有队列，不自动重新执行被 busy 拒绝的 Web。
- tracker 不靠 timer 清理活任务；底层永不 settle 时新 Web 明确 busy，UI/命令调用仍在墙钟内收口，无 ref timer/CPU 轮询。保守拒绝影响可用性是本版取舍，不以不可靠 abort 换吞吐。

模型仍走 `jev/client.ts` 唯一外发口，command-local guarded facade 覆盖每次物理 attempt、usage/诊断持久化；不直接 classify。侧车 persist 最后 await 后锁内检查 lease/generation，merge 只允许冻结 hash 且 input rev/taxonomy/base 前置相符，不能无条件覆盖 index。tagBulk signal 只是取消的一层，不替代提交 guard。native task 的 lifecycle commit guard 通过可选任务上下文接入，Web 协调未装配时旧调用默认行为不变；装配开启后的 disposed/过代提交一律拒绝。

Web controlled logging 不触发 detached diag；错误走独立 collector，再旁路 record。健康计数不冒充提交。retag/review --run/probe 复用同类受控 effect，不因旧 API 返回 string 沿用无 lease 的后台实现。

### 4.5 TOCTOU 与确认展示

| 操作                               | 冻结/提交前复核                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| migrate/all/rollback/import-legacy | canonical root、每目录 dev/ino、精确目录集合、源字节/身份、blocks rev/state/marker/hold、计划/pending journal；批准后不发现新目录。 |
| init/import                        | absent目标及最近父目录身份、精确源/目标/hash、force旧正文；确认前不ensureMemoryDir，importAll不自由rediscover。                     |
| restore/adopt                      | 原token/RestorePlan、archive/trash完整存储名、manifest/hash/metadata、目标冲突rev、namespace；不能换同id另一文件。                  |
| tidy/frontmatter/review/expired    | 原文/新正文/patch、source/authority/scope、rev/选中集合；模型/编辑后新计划。                                                        |
| break-lock                         | holder全文/lease/epoch；变化拒绝，epoch bump BEFORE lockBreak保留。                                                                 |
| tags/Jev                           | §3.6/4.4完整corpus/taxonomy/index/外发计划；不能只冻结定义。                                                                        |

变化 E_MEM_PLAN_CHANGED，不自动重开框；前步成功下一步失败 partial。恢复先只读检查 journal→独立 effect=recover→批准→原 txn恢复→重新规划后续，不在prepare偷恢复。原 CAS 不承诺恶意同uid syscall间替换的全文件系统事务。

每框包含原始命令、scope/项目、全部 canonical目录/actual sessionFile、条目/文件/字节数、完整digest、有效期、回滚条件。正文当文本，不执行指令/HTML。

| 类别                    | 额外展示                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| add/rm/init/tags        | add全文；rm完整正文/id/rev；init路径/source；旧/新完整tag定义；含回填展示全部输入/外发/成本/侧车范围。Hub“所有项目共享”，session“仅本会话”。 |
| migrate/import/force    | 全部目录/源slug/新增跳过覆盖/完整diff、marker/state/report、reload及rollback限制。                                                           |
| restore/adopt           | 完整备份名/正文/覆盖决定/metadata/重封印范围/new grant，不声称修复unknown provenance。                                                       |
| tidy/review/expired     | 完整原文/新文/日期/authority/source转换、keep/dismiss侧车/提醒规则；模型外发费用先确认、输出apply另确认；无备份明示不可自动回滚。            |
| Jev/recovery/break-lock | 外发模型/次数/预算/费用不可撤回、派生目录/索引损失；review--run sweep集合；holder/pid/epoch/恢复中断；破锁不强杀、不自动撤销。               |

大计划冻结分页：前页仅下一页/取消，末页总数/总digest/执行项；每页绑manifest/页序/nonce。每页正文≤24KiB、帧≤64KiB且低于既有transport硬限；继续拆正文边界，不截断批准，不拿notify的8KiB稿作原文确认。

### 4.6 结果、终态保留与错误呈现（r3；r4 补批准后 busy 文案）

```ts
interface MemoryCommandExecutionResult {
  readonly ok: boolean;
  readonly effect: "none" | "completed" | "partial" | "unknown";
  readonly completed: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { target: string; code: string; message: string }[];
  readonly uncertain: readonly string[];
  readonly recovery?: readonly string[];
  readonly code?: MemoryCommandErrorCode;
  readonly message: string;
}
// 既有 agent/ledger.ts completion 能力的逻辑契约；复用实际接口，不新增第二账本。
interface MemoryCompletionLedgerPort {
  reserveMemoryCompletion(id: string, now: number): boolean;
  settleMemoryCompletion(id: string, result: LedgerResult, now: number): boolean;
}
```

**领域结果**：ok=true 仅全部计划 effect 完成；空计划 none，非空成功 completed。known subset partial；是否生效/领域记账一致性不确证 unknown，即使 completed 已有确定子项。正文写成功而 result append 失败不能报 none/“未执行”。command-record 故障只属观测失败，已确证领域完成仍 completed；向 Web 给“已完成，命令记录保存失败”，不改成领域 unknown。领域元数据/审计与正文一致性不明仍 unknown，不能由缺 journal 终态推无写。

**独立有界保留**：32 槽 completion ledger 已在现有 `commands.ts`/`ledger.ts` 实现；以下是复用与集成验收要求，不再新增第二账本或第二终态 latch。不存 cap/ctx/Promise/原确认全文。timeout/dispose 当前只保证结果收口，不提供生产写 abort/revoke。

- beginOrReply 得 new 后、start/开框前 reserve；仅命令分流持有该 port。最多 **32 个受保留 mem 槽（running+terminal）**，running仍受原16总上限/每owner1写流程限制；无槽返回 E_RATE/E_MEM_BUSY，零effect，不挤掉其他未到期 mem 结果。
- 已 reserve 的 running 项不淘汰；墙钟到期必须 settle。terminal 自终态时刻保留 **30分钟**，TTL/容量 sweep都跳过未到期 mem 项，其他项原策略。现有512表容量不扩；32×≤32KiB collector/结果负载约1MiB上界，失败message≤8KiB。过期按旧清理机制释放，不新建持久文件或模块级状态。
- settleMemoryCompletion 为 once：只有当前未终态的预留项可写，重复/迟到回调返回false，不覆写终态、不再发late。领域副作用若仍不确定先收unknown，不能让迟到provider把它升级success。
- 所有已接纳 mem 终态失败 `retryable:false`，即使 effect=none 也不触发现有“retryable+none删ledger”路径。重复相同cmdId重放；queryOnly只读；不同payload同id拒绝。到保留期外结果不再保证可查，UI给过期/未知而不自动重派；新操作需用户重新发起、prepare和确认。
- reload/dispose 先撤销执行并将运行中completion收为stale/实际partial或unknown，再释放装配。结果是既有纯数据ledger，可跨/reload查询；杀进程丢失内存是明确边界，不声称持久必达。

**wire 映射**：不扩 `CmdErrorCode`/`CmdEffect` union，不把领域 partial 塞入 wire effect。

| 内部结果                         | 既有 CmdResultBody                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completed / 空计划成功           | ok=true，command/extension/completion=sync/captured=true，output含明确effect、已完成及观测警告。                                                                                                                                                                              |
| partial / unknown / 其他领域失败 | ok=false；存储/模型失败映射E_COMMAND_DENIED，超时E_DEADLINE、stale E_STALE_CTX、缺通道E_UNSUPPORTED、busy E_RATE、args E_BAD_REQUEST；**message带原领域code、effect、阶段、确定/不确定项与恢复引用/勿盲重试**。retryable=false；仅确证none映射wire effect=none，其余unknown。 |

失败形状没有 data.output，因此不能假设失败query走成功解包；DetailDock必须显示inner result.message。失败摘要≤8KiB，优先保留领域码/effect/阶段/总数/首个错误/uncertain及恢复引用，长列表可截断并说明数量；这不是确认原文，不要求完整manifest重放。不要把失败包装成ok=true只为触发自动查询。

**批准后出队 busy 的固定用户契约（r4）**：本步在用户肯定答复后、出队复核发现真实未 settle 任务而拒绝时，结果摘要必须完整保留并在 Web 可见结果区逐字显示以下文案（不含引号）：

> 后台记忆任务尚未结束，本步未执行；本次授权已失效，不会自动重试，请稍后重新发起并确认。

- 本步领域结果为 `E_MEM_BUSY`/`effect=none`，`consume` 调用次数与成功次数均为 **0**，本步提交数为 **0**；taxonomy/正文/侧车/diag/外发等均不得由本步产生。已 reserve 的 receipt 也必须永久 revoke，队列中不保留自动重试项。原 native 任务的迟到写单独归属，不计作 Web 成功或 Web 副作用。
- 单步命令聚合为 `ok=false`、领域 `effect=none`；映射 wire `code=E_RATE`、`effect=none`、`retryable=false`。`message` 同时携带 `E_MEM_BUSY`、出队阶段及上述完整文案。不是只发通用限流码，也不是 sink notify 后直接删除 pending。
- 多步命令若前步已有确定成功且无不确定项，总体必须为 `ok=false`、领域 `effect=partial`，保留 `completed`、列出本步 busy 与后续 skipped；wire `code=E_RATE`、`effect=unknown`、`retryable=false`。上述“本步未执行”只指当前被拒步，不能把整次命令报 none、抹掉已成功项；有不确定项仍按原规则报 unknown。
- 文案作为失败 `result.message` 中不可截断的固定段，经 once completion/late/queryOnly 到 DetailDock；history off 或 record append 失败也必须显示同文案。记录保存失败只能追加独立观测警告，不遮挡或改写该段，不把本步 none/多步 partial 改为记录故障 unknown。此契约针对批准后任务 busy，不将预开框无槽等其他 busy 原因谎称为后台任务未结束。
- 释放旧任务、lane drain、迟到帧、重连/重复 cmdId、queryOnly 均不得重执行本步或重开确认。要再尝试只能由用户重新发起、重新 prepare、使用新 cmdId 和新确认；DOM 与零副作用联合验收见 §6.2.4。

可选 record 状态：现有 settle(void)无法报告单次append失败。实施时在同RecordHandle增加 `settleObserved(outcome): "appended" | "skipped" | "failed"`，与settle共享一次性关闭逻辑；direct只调用该方法一次，native继续原void settle。beginExternal失败也由direct记录为观测失败。failed才显示保存失败，policy skip/history off不误报警；不支持反馈时如实“记录持久化未验证”，不能假称已保存。此接口只提供观测，不授权重执行、不改frozen record wire。

| 内部错误                                          | 行为                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| E_MEM_CONFIRM_DECLINED                            | 拒绝/取消/关框；当前step无effect，前步成功仍partial。                                                                              |
| E_MEM_CONFIRM_TIMEOUT                             | 单框120秒撤销；重新发起才可确认。                                                                                                  |
| E_MEM_CONFIRM_UNAVAILABLE                         | remote缺失/开框失败/断线/裸RPC；零本地select、零新写。                                                                             |
| E_MEM_NEEDS_HUMAN_COMMAND                         | 无有效WebCall/伪造；不能补模型回合/native。                                                                                        |
| E_MEM_PLAN_CHANGED                                | 停止，不重弹、不扩计划。                                                                                                           |
| E_MEM_CONFIRM_STALE                               | owner/lifecycle/abort；迟到答案/结果不写。                                                                                         |
| E_CHILD_READONLY                                  | child拒写，只读按原门。                                                                                                            |
| E_MEM_BUSY                                        | 另有流程/真实遗留task/无completion槽；不入SDK队列，不consume。批准后任务busy必须revoke并显示本节固定文案，多步按实际已完成项聚合。 |
| E_MEM_ARGS / 原能力错误                           | usage/off，零框。                                                                                                                  |
| E_NAMESPACE/E_CONFLICT/E_GATE/E_PERSIST_UNKNOWN等 | 保留原码到摘要；unknown明确可能部分写入、勿直接重试并列恢复线索。                                                                  |

invalid origin/nonce/epoch callback返回false，桥回复E_DIALOG_CLOSED；合法调用可继续等真答案，生命周期撤销立即stale。Web失败无论hasUI都进独立终态；不被blanket catch吞成功。TUI notify/不抛错约定保留。无可信sink/completion的裸RPC/print写拒绝并抛带code failure，不开本地框。

批准后失败finally revoke cap/lease、关闭框、使排队项失效；**物理tracker不得伪清零**。保留journal/restore，不自动mint重试，不重放已有attempt的action。恢复自己需新plan/cap。

### 4.7 时限、查询与清理

现有 29 分钟 Promise 分支与 completion 收口由 `commands.ts`/`ledger.ts` 承担；以下关于写撤销、guard 和 UI 的内容是待接线验收目标，而非现成的生产写撤销能力。所有结果呈现与查询回调须验证 `cmdId + owner/会话 + 用户操作代际`，仅匹配命令名不足以隔离同名新操作。

- createDialogRace同步认领，Web不同时开TUI，覆盖answer/cancel/timeout/abort/error。
- 单框120秒；timer经clampSpanMs/unref，长总时长createSegmentedClock。Web总墙钟29分钟，模型/活动预算再取原值更小者，分页/排队/确认/模型均计墙钟；TUI预算不变。
- capture30秒、record30分钟均不撤销/扩大授权，也不作为终态唯一归宿。总墙钟到期revoke/abort、保留journal、completion收口；provider不理abort时须由待实现的提交 guard 阻止迟到副作用，真实占用按§4.4保留；现有结果 timeout 本身不提供此保证。
- Web mem accepted到终态间只reply-only；completion终态exactly-once，然后cmd_late。禁止30秒capture expiry把command先settle；禁止靠延长全局capture/record常量补洞。
- mem reducer对terminal ctl及任何late都走query，含failed；按(cmdId,terminal updatedAt/late)合并同一终态查询，避免ctl/late各发一次。正在查询时不倒退running；query running不当完成。失败重连可查询，但永不自动执行retry。
- 复用每次网络flight的有界期限与一次in-flight查询；查询失败保留unknown/可手动查，自动恢复最多一次/连接恢复，未到终态不高频轮询。具体错误/effect由query结果覆盖ctl通用码；不得把partial/unknown硬改none。普通命令字节不变。
- reload/new/resume/tree/shutdown/dispose/显式abort撤销本owner全部call/receipt/排队项并先写completion；普通leaf append不换owner。终态查询只用cmdId+认证通道，不能恢复cap。
- 初始输出说明“已接纳，最终由Web命令结果返回；history可选”。结果保留30分钟、进程丢失/过期/永久断网边界明确；batch --status只作该领域辅助，不替代必需终态。

## 5. 关键决策与兼容性

### 5.1 为什么不选其他方案

- **拒绝ALS around send + claim-or-native**：SDK settled延迟可晚于票据；无invocation不等于native。
- **即时seam而非长期来源tombstone**：SDK队列不带私有对象，name+args有界ledger无法永久证明负来源；模糊tombstone会误伤同文native。所有Web mem不入队是结构性保证。
- 不把rpc/hasUI/cmd.confirm当真人，不伪造HumanTurn/BAS，不复用模型cap，不只覆写ctx.ui.confirm。
- 不持锁等人、不批准后重扫、不各handler复制remote，不写完定义再补框。
- **真实pending + busy，而非只共用bgChain/调用abort**：race与abort不证明旧提交结束；忙时拒绝牺牲可用性，避免另建sidecar MVCC/全局事务。native常态行为保留，Web占用期间的并发启动延迟和撤销guard明确声明。
- **ledger+late/query，而非仅record或通知文本**：history可以关闭，append会失败，通用capture仅30秒。32个有界保留槽防terminal被容量提前挤出；不建审批持久队列/数据库，不把每条mem结果保证扩大为全控制面必达。

### 5.2 policy：默认一个真正授权框

Web policy共用parse/class：read allow，已实现effect/flow可派发业务确认，移除旧scoped hard deny。显式webCommandPolicy.mem=deny优先；confirm可保留传输防误触；allow不能绕needsConfirm。completion同源、未知语法usage。no-fallback独立于policy。

### 5.3 协议与 golden

既有cmd_result/cmd_late/queryOnly、question/options、originKind、nonce/epoch足够；WebCall/plan/lease/receipt/raw token/ledger保留标记均内部，无PROTO/source枚举/caps新增。仍需改agent/UI消费行为，不可把“wire不变”说成零接线工作。

- I9：Web off不构造新factory/port、不改native参数/文案/顺序、prompt/schema/tool description；native tags原触发保留。Web协调开启时§3.6声明的并发/旧代提交例外单测覆盖，不能冒充全局native字节变化。off golden/trace实施证明。
- remote off的Web写拒绝是声明安全变化；scopes双off仍可构造project runtime，session/hub不可用。
- secure/locked不新增Hub/来源，不绕D8；存储/接线前读data-encryption README。
- I10：旧hub透传既有结果；新版UI窄适配保证详细失败展示，旧UI不承诺新增显示能力，但可查询既有message，不因此直写。remote不支持/断线fail-closed。A级/A′不重生，memory/jev-off、secure parity原字节；旧scoped Web hard deny普通测试按声明更新。
- 优先复用生命周期hook；确需新增注册由唯一集成owner声明，按治理规则集中更新activate-trace，off trace不变，不刷新其他golden。

## 6. 实施要点、测试矩阵与拆包

### 6.1 函数级写域（实施期，本轮不动）

当前只读能力及不可用项见 §2.1.1；下表是剩余目标写域，不代表这些领域已经完成。

| 文件域                                                                                                                                          | 要点 / owner                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 新memory/command-policy.ts、command-confirm.ts                                                                                                  | A：封闭分类、私有call/cap/lease、remote/race/预算/cleanup。                                                                            |
| web-hub/agent/builtin-bridge.ts                                                                                                                 | A：mem早分流、start、输出接入既有completion/late，no-fallback；不sendUserMessage；不另造终态latch。                                    |
| web-hub/agent/{commands,ledger,command-record}.ts                                                                                               | A：prompt/held/replay拒替代入口；复用已实现的completion预留/once/保留及29分钟Promise分支；record可选settleObserved反馈，不影响主通道。 |
| web-hub/ui/src/logic/{control,state}.js、composables/useHub.ts、components/detail/DetailDock.vue及定向测试                                      | A：仅mem的成功/失败/ctl先到query、去重、inner失败解包/实际显示、禁重执行；不改message-speed/archive UI。                               |
| commands/capture.ts                                                                                                                             | A：至多提取纯输出限幅helper；wrap/TTL通用语义不变，不授权化。                                                                          |
| memory/{index,command}.ts                                                                                                                       | B：executor/native入口分离、current ctx/manager、remote晚绑定、scopes-off project runtime/dispose。共享装配hunk交I。                   |
| memory/init-command.ts、store.ts                                                                                                                | B1：固定sources/targets/absent/force/CAS prepare/commit，native API原样。                                                              |
| memory/blocks/{migrate,migrate-plan,legacy}.ts                                                                                                  | B1：固定目录/源snapshot，防重扫扩域，startup迁移不接确认。                                                                             |
| memory/tidy/{command,batch-command,apply,restore,txn}.ts                                                                                        | B2：Web多步select-loop/完整diff页、recover/lease批准、可选guard，不重写txn/manifest。                                                  |
| memory/jev/{command-port,review-command,expired-command}.ts、govern/review-lite.ts                                                              | B2/B3：prepare/原文/keep/dismiss/resolve，controlled consumer不进native triggerBulk。                                                  |
| **memory/jev/wire.ts**及必要tagging/client/index-store/diag guard seam                                                                          | **B3明确写域**：raw追踪到提交settle、orphan busy/admission、冻结输入、每attempt与锁内persist guard、禁detached、native旧代提交fence。  |
| memory/scopes/{command,session-command,session-store,hub-management,hub-store,wire,owner}.ts                                                    | B1：command-only consumer/token单框/同FIFO锁poison/两cap隔离。                                                                         |
| **src/web-hub/agent/index.ts、src/index.ts、必要src/stack.ts/stack-teardown.ts、tests/tiers.ts、tests/fixtures/governance/activate-trace.json** | **只由I串行写**，A/B和外部任务不得同时编辑；fixture是否需动先按规则申报。                                                              |
| docs/dev/memory/README.md                                                                                                                       | B交付后记真实行为/预算/残留风险；本轮只改当前设计文件。                                                                                |

Web Edit then apply：allowOther先收候选→新plan→allowOther=false最终确认；自由输入不授权。hand-to-agent只展示待发指令，不自动sendUserMessage/继承cap。

### 6.2 验收矩阵与强制专项

| 场景          | 必须验证                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web成功       | migrate单/all、init/import/force、各restore、tags/Jev、scoped add/rm/adopt/restore；批准前零effect，批准后正确写，默认无泛确认双框。               |
| 拒绝/超时     | 拒绝/关闭/120秒同tick/late answer，不重弹/cap不重放；ManualClock不真睡120秒。                                                                      |
| 无通道/来源   | remote缺失/throw/断线、RPC hasUI=true零local select；伪call/旧cmdId/Feishu/重入并发零native；合法command不需BAS。                                  |
| 模型隔离      | 无HumanTurn仍E_HUB_NEEDS_HUMAN_TURN，command不补下一回合，两cap互传拒绝。                                                                          |
| TOCTOU        | 目录集合/字节/rev/marker/epoch/namespace/manifest/absent变化拒绝；partial/unknown不盲重试。                                                        |
| 只读/child    | all dry-run/report/status、dry legacy import、tidy preview/status、restore列表零框零recover/mkdir/lease/model；child写全拒，allow=true无效。       |
| 多步          | 第4项仍可批准；choose不mint；模型/编辑后新plan；recovery先确认，keep/dismiss受保护，不假装custom/editor成功。                                      |
| native/off    | add/rm无新框，takeover/adopt/restore次数文案顺序取消不变；native tags原trigger/提示；Web off无新接线/golden原字节。                                |
| 生命周期/传输 | 不依赖capture；独立终态history off可用；29分钟abort；reload/tree/dispose；同cmdId不再执行、cap不持久化。                                           |
| 批准后busy    | 出队复核拒绝，完整固定文案实际到Web DOM；history off/record append失败均覆盖；本步consume=0/提交=0/revoke，无自动重执行，多步已有成功项仍partial。 |
| 浏览器全链    | 真RPC→CmdOrigin→direct seam→dialog→cap→store；migrate/hub restore各一；长文分页/默认拒绝/刷新不重执行。                                            |

#### 6.2.1 保留 blocker 回归：真实 SDK settled 超过 fallback TTL

真实SDK tier2，不以fake ctx/isIdle spy/给handler贴webInvocation替代：

1. own HOME/tmp、SDK1.5 session + TUI宿主、生产bridge/direct seam/存储，scripted runtime触发真实agent_settled，一个hook用barrier阻塞；断言isIdle=true且hook未释放。
2. 前提对照：无副作用fixture extension走旧arm/send/settleArm，经真实prompt排队；保持barrier实际>5秒（建议6秒并检查fallback淘汰），释放后handler才执行且无capture。不得危险生产mem复现旧洞。真实等待只此tier2，清理/超时有界。
3. 回归：同窗口生产Web发mem init、session add、hub add/rm（own存储参数化）。即时命中seam；native handler/grant=0、mem sendUserMessage/session.prompt=0；remote框已出现或通道拒绝，不等SDK drain。
4. 不肯定答复，超过TTL后拒绝/撤销/过期，再释放barrier/drain。正文/taxonomy/index/journal业务写=0；native=0，无迟到框/自动重试。command record是允许观测写，单独计数。
5. 正例同窗口及时批准只走confirmed consumer；撤销call不可复用。seam undefined/throw、generic policy allow、record/capture过期分别注入，仍零SDK/native。completion缺接线另测零effect拒绝。

用生产bridge分流计数证明“不入队”，最终文件没变不足以证明；前提对照保证真实触发延迟。

#### 6.2.2 保留冻结/取消，并补 r3 native 超时遗留竞争（r4 补 Web 可见性）

- 生产wire lane前置正常native/controlled barrier；Web tags新增/description/enable逐一prepare→完整确认→排队，旧triggerBulk/runBulk=0。等待中新增/改/删条目、taxonomy/index变化，放行后E_MEM_PLAN_CHANGED、定义未写/模型零外发/侧车零写，不扩大cap/重弹。
- 排队撤销/abort/reload/墙钟后放行：Web零外发/定义/侧车/diag，调用有界settle、receipt终态。执行中模型前/provider等待/persist等锁后三点撤销：线性化后新attempt/写=0，迟到结果不persist；定义已写则partial并列费用/已发数。
- 成功只用冻结且脱敏材料/链，private/secret零外发，仅写冻结hash；任务尾部全部await，无衍生bulk/重试/diag；预算/sidecar busy分列tagged/persisted/pending。native对照仍原trigger条件/提示，不全局关后台。

**r3 必测时序（ManualClock + 生产 enqueue/withTimeout/persist 路径 + own真实FS；不真睡120秒）**：

1. 启动native bulk，provider barrier不响应abort；记录raw token=1。推进到BACKGROUND_TOTAL_MS并flush wrapper，断言bgChain已前进/bgDepth可归零，**timedOutPending=1、raw token仍在**，证明触发的是原race缺口。
2. 此后发Web tags并尝试入队（另例先正常排队，再让前置native超时，以覆盖出队检查）。即使拿到合法确认receipt，也必须E_MEM_BUSY/none；本步receipt终态revoke，consume调用及成功次数=0、本步提交数=0，taxonomy/模型/侧车/diag归属Web均0，不得以旧native成功替代Web成功。忙拒绝之后不保留自动重试项。**出队用例必须证明肯定答复与入队发生在前置任务超时之前、拒绝发生在出队复核，而非预开框busy。** 此拒绝还须按§6.2.4三组浏览器专项，在实际DOM看到§4.6完整固定文案；领域结果/sink spy本身不算闭合。
3. 释放native迟到结果，等到**persist完成及raw settle**，才看到token移除；在persist后、raw finally前再插入Web入队仍busy。旧native如按原路径保存，必须发生在任何Web定义/提交之前；记录commit临界区并发峰值≤1，无Web/旧native交叠。
4. 然后**重新prepare + 新确认 + 新cmdId/cap**执行Web（必须读到旧native已保存base）。成功后再drain全部旧Promise/microtask，快照Web的taxonomy/index哈希保持不变；旧raw token无可重复提交callback，已确认结果不被迟到覆盖。
5. 独立竞速：Web持admission期间触发native enqueue，native同步task前缀不得运行；Web逻辑timeout/provider未settle仍占用，新Web busy。待真实settle或旧代guard已可靠隔离后恢复native；不得因bgDepth归零/调用abort就穿过。session_start换bgAbort不清token；dispose/reload后旧native锁内提交fence拒绝，不能写新activation结果。
6. busy拒绝、两个gate之间竞争、raw同步throw/reject、模型内部race遗留、pending persist/diag尾部、最后await后撤销分别覆盖；检查每个task只有一次物理登记/移除、零unhandled rejection。永不settle夹具仅使准入busy，不使Web调用/清理无限等或留下ref timer。
7. 多步先完成一步，再让已批准的后一步出队busy：仅被拒步consume=0/提交=0、receipt revoke，前步提交计数和成功快照不变；总体partial保留completed、本步busy与后续skipped，不能总体none。旧任务settle、lane drain、重连/重复cmdId后仍不自动重执行，实际Web显示partial、已成功项及固定“本步未执行”文案。

不得把native job替换成会按时响应abort的mock来“证明”安全；不得只测新controlled task迟到而遗漏旧native persist。

#### 6.2.3 保留批准后四类故障注入

全部own tmp真实FS + 原txn hooks/窄故障端口，前置真实remote批准/consume，不只mock字符串。失败后旧receipt的reserve/check/consume/commit全拒，重连/重复cmdId不复活。

| 注入                       | 磁盘/领域结果断言                                                                                                                                                                                                          | Web可见性/原恢复                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **intent写失败**           | runStep intent append在action try外失败；action=0、正文不变。若manifest/目录已建立列partial元数据，只有确证无mutating I/O才none；写可能生效而抛错则unknown。                                                               | 独立终态含code/阶段/runId；record可选。journal只读可列，新恢复确认走原recover/restore；没有可恢复intent如实说明，不杜撰回滚。             |
| **首目录成功、次目录失败** | 首个完成，次个首action前失败，第三个不执行；partial精确completed/failed/skipped。次个有不确定提交总体unknown但保留首个确定成功。                                                                                           | 明示无全局回滚；首按原rollback/restore条件，次按原recovery收敛；不回放整个cap/重新发现目录。                                              |
| **写后记账失败**           | afterAction/beforeResult/result append失败，正文已变、journal缺result；unknown非none/success，uncertain列opId/runId；Hub正文后metadata/audit按证据unknown并保留poison。仅command-record失败领域仍completed，观测失败分列。 | 独立late/query实际到Web；原recoverRun观察补结果、不增加已attempt action计数，原restore恢复备份；恢复需新cap。不为测试重写正文/删journal。 |
| **恢复再次失败**           | 制造中断→单独批准recover→观察补记/清理/manifest append再次失败；保留journal/leftovers，有确定子集partial否则unknown，后续工作不启动，恢复cap终态。                                                                         | Web显示第二次错误/引用/勿盲重试；去故障新plan/cap走原恢复收敛；已attempt action仍不重放。                                                 |

不可逆确认页明确外发/费用、破锁epoch、无备份覆盖不可撤回；失败页保留effect。要求恢复原本可恢复存储，不要求新增全局事务。

#### 6.2.4 r3：>30 秒、无 record 的终态实际到达 Web（r4 增补 busy 三组）

r5 可见性补充：同步只读结果在默认 history on 下不可见的问题已修，但异步终态未因此闭合；抽屉页签晚到恢复是其他面板的教训，不能记为 `/mem` 已修。新增下列生产 UI 验收，所有断言都约束 `cmdId + owner/会话 + 用户操作代际`：

| 条件 / 竞速                       | 必须断言                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| history on / off；record 写入失败 | 当前命令终态及具体结果均可见；record 失败只作独立观测提示。            |
| ctl/late 两种乱序及重复           | 查询合并，正确显示同一终态，不倒退或重复执行。                         |
| 同名新命令                        | 旧查询迟到不得覆盖新 cmdId/新操作代际的结果，即使命令名相同。          |
| 用户 dismiss                      | dismiss 后旧查询不能重新打开或覆盖用户当前操作；新操作不受旧结果污染。 |
| 切换会话后迟到查询                | 旧 owner/会话的查询结果不得更新当前会话界面；不重执行旧命令。          |

测试生产direct bridge→handler/ledger→hub→SSE/HTTP queryOnly→Vue reducer/DetailDock，own HOME/本地hub/scripted模型/own存储，不能用“sink调用过”“ledger里有字串”代替Web可见断言。agent层ManualClock推进，浏览器层可注入clock/barrier，不真等120秒；transport至少跨过原30秒窗口一次。

保留参数化两个观测环境与三个领域终态的**原6组**，不以新增busy用例替代：

| 观测环境                                                             | >30秒后终态                 | 必须到达Web的内容                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| cmdHistory=false，断言recorder未构造                                 | success / partial / unknown | success正文结果/完成数；partial已完成与失败目标/原code；unknown不确定项/恢复引用/勿盲重试。每组看到正确终态而非“terminal-only/发送成功”。 |
| cmdHistory=true，begin/end append注入失败（另覆盖beginExternal失败） | success / partial / unknown | 相同领域内容仍到达；仅record故障不改领域effect，另显保存失败。partial/unknown的原领域错误不被观测失败遮住。                               |

每组执行：

1. 发生产Web mem写，确认框保持>30秒后批准（partial/unknown在批准后用§6.2.3真实故障）；另例批准后模型barrier让执行>30秒。初始async回执不settle，Web pending保持可跟踪。
2. terminal ledger保存后发late；成功和失败都触发**只读queryOnly**，读取正确嵌套层。DetailDock DOM/可见结果区断言effect、原code/阶段、完成/不确定/恢复文本；不是只断通用E_COMMAND_DENIED。
3. 故意让terminal ctl先于cmd_late、late先于ctl、重复帧、结果同步完成、30秒timer同tick、record抛错分别覆盖。每cmdId终态只落一次、每个终态查询合并去重，ctl不能先删pending导致消息丢失；失败query不能被解成成功。
4. 暂断线再连接，丢late后仅凭ctl/query仍恢复同一结果。相同cmdId重复提交/查询、late重放、query网络失败后手动查询均**不重执行**：handler启动=1、开框=1（或原多步数）、每effect提交计数固定；cap不再mint，不自动retry。
5. 打满32个mem保留槽：新写预开框busy、旧终态仍可查；制造普通ledger容量/TTL压力，未到期mem结果不能被淘汰。终态后30分钟过期允许清理，UI显示过期/未知、不自动发新写；进程丢失仅报告不可查。
6. 29分钟墙钟/abort/dispose也产生独立终态；record失效不使running永存；provider迟到不覆盖unknown、不发第二late。断线不可送达时明确unknown，不承诺永久网络故障必达。

**r4 新增：批准后才出队发现 busy 的三组浏览器用例**。复用上述生产全链与§6.2.2的真实lane/超时夹具；禁止把busy字符串直接喂给UI，也禁止用“开框前已busy”冒充批准后的拒绝。三组均以出队busy为业务终态，history/record故障只是观测条件，不是busy的替代触发原因。

| 组                              | 观测条件与触发                                                                                                  | 必须实际可见的DOM断言                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1：批准后出队busy              | cmdHistory=true且record正常；native正常占lane→Web真实肯定答复并入队→前置native超时但raw未settle→Web出队复核拒绝 | DetailDock/可见命令结果区包含完整固定句：「后台记忆任务尚未结束，本步未执行；本次授权已失效，不会自动重试，请稍后重新发起并确认。」并显示E_MEM_BUSY/出队阶段及本步none；不得只显示E_RATE或让failed late直接结束pending而丢消息。 |
| B2：history off下同一拒绝       | cmdHistory=false，断言recorder未构造；同B1时序                                                                  | 同B1逐字文案在可见DOM出现；无需打开history，不误报“记录保存失败”。                                                                                                                                                               |
| B3：record append失败下同一拒绝 | cmdHistory=true，begin/end append失败参数化，另覆盖beginExternal失败；同B1时序                                  | 同B1逐字文案在可见DOM出现，另有记录观测失败提示；该提示不遮挡busy文案、不更改领域effect或retryable。                                                                                                                             |

三组全部强制以下联合断言（不是sink spy；DOM需定位当前cmdId对应结果区、断言可见且包含完整文本，不以隐藏节点、title snapshot、ledger字符串或通知调用次数替代）：

1. 时间线证明真实肯定答复→入队→前置native超时→出队busy；用barrier令终态晚于原30秒窗口，覆盖failed late触发query及terminal ctl先到两种顺序。query返回inner `ok=false`后，浏览器必须渲染`result.message`中的完整固定句，再结束pending；同cmdId终态once、late/query去重。
2. 对**被拒本步**计数：consume调用=0且成功=0、提交=0，定义/正文/侧车/diag/模型外发均0；receipt reserve/check/consume/commit不可再成功。record允许的观测写、前置native的迟到persist分别归属计数，不能混入本步。
3. 释放旧native至提交尾部raw settle，drain全部lane/Promise/microtask；随后重连、重复同cmdId、重放late/ctl、手动query。handler/开框不新增，本步consume与提交仍为0，无自动重执行、无自动重弹/新receipt；终态仍是原busy拒绝而不是迟到success。再执行只能另由用户发起新cmdId/prepare/确认。
4. **每组三组都补多步变体**：前一步实际成功，再批准本步并触发同一出队busy。实际DOM同时显示`partial`、前步已成功项及完整固定句；领域completed保留、failed指向本步、后续skipped，不能整体报none。只对被拒步断言consume=0/提交=0；前步计数/成功磁盘快照保持不变，drain/重连后无自动重执行。wire E_RATE/effect=unknown/retryable=false，不因E_RATE进入自动retry。

建议测试文件：原 `tests/memory/command-{policy,confirm,web}.test.ts`、`tests/memory/jev/command-web-bulk.test.ts`、`tests/web-hub/agent/memory-command-proof.test.ts`、`tests/integration/memory-web-command-confirm.test.ts`、`tests/conformance/memory-web-command-dispatch.test.ts`；补 `tests/web-hub/agent/memory-command-completion.test.ts`、既有ledger/reducer/DetailDock目录的mem定向套件。真实SDK/进程/6秒等按tiers归tier2，故障本地套件按规则登记，不能自行抢写tiers。

浏览器不新增Playwright依赖：复用 `scripts/web-hub/lib/playwright.ts` offline-first loader，feature-local `scripts/web-hub/memory-command-confirm-probe.ts`。own tmp/HOME/本地hub，无真实Jev/API/用户记忆；退出0通过/1断言失败/2浏览器或夹具不可用（不算通过），不在线安装。title snapshot不算viewport验收。

### 6.3 拆包、外部写域协调与估算（r3）

**r5 进度快照（与下方原计划估算分开）**：

| 工作包              | 实际状态 / 剩余门禁                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| B1 原语             | 同步 `check/consume/apply` 已交付但未接线；不等于领域锁、完整冻结计划、lease、物理任务 guard 或端到端验收完成。         |
| B1b                 | 在途；不得当作已交付或已接线。                                                                                          |
| 其他领域            | hub/scoped/migrate/import/restore/tidy 的生产写适配未做；须分别完成可信调用、锁/CAS、撤销 guard 与全链验收。            |
| session rm 范围变更 | r4 禁止，后续纳入目标；native 当前仅 add。rm 须新增 native 语法及 Web 安全入口，原文读取/rev/CAS/unknown 验收独立通过。 |
| completion/UI       | 32 槽 ledger 与 29 分钟 Promise 分支已实现；复用 `commands.ts`/`ledger.ts`，写撤销端口及异步可见性仍待完成。            |

**单owner规则先于并行**：唯一集成owner记为 **I**（由主调度明确登记到派单；不是A/B或外部任务各自声称owner）。I贯穿A→B里程碑，独占以下共享文件，串行做窄hunk集成：

- `src/web-hub/agent/index.ts`：direct seam、completion、remote/recorder晚绑定、message-speed与archive现有接线必须共存；A/B只能提交确切插入点/参数签名/测试依赖，不直接写该文件。
- 可能涉及的 `src/index.ts`、`src/stack.ts`、`src/stack-teardown.ts` 及共享 `src/memory/index.ts` 装配hunk；需要才改，不因本方案预授权重构。
- `tests/tiers.ts`、`tests/fixtures/governance/activate-trace.json`：新测试tier与新增注册变动由I统一登记/核验。A级/A′冻结不动；trace仅声明注册变化按仓库规则更新，禁止各包整份重生。

**外部冻结面（对本方案A/B/I都适用；外部任务仍由其原owner管理）**：

| 冻结路径                                                                                                   | 本方案约束                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/web-hub/agent/message-speed*`、`tests/**/message-speed*`，以及其他既有message-speed测试/协议/设置hunk | 不改、不重命名、不格式化、不回退；tokens/s任务的多API行为与测试不纳入本方案。             |
| `src/archive/**`、其他`src/**/archive*`/`tests/**/archive*`路径及共享文件内archive设置/接线hunk            | 不改外部archive功能；本方案的memory tidy archive-only只在§6.1明确的memory领域路径内实施。 |
| `tests/config/**`                                                                                          | 全目录冻结，不能为了类型/trace/默认值门禁顺手刷新外部配置测试。                           |
| 共享根文件里的message-speed/archive imports、deps、settings、register顺序与配套测试hunk                    | 不属于I可以自由改动的区域；I只有按协调结果做最小合并的权限，不代表独占整个仓库。          |

实施派单前，I与外部message-speed/archive owner确认共享文件当前基线和待合入hunk，记录路径/符号/顺序。外部owner也不同时编辑共享装配；其接线由I接收后串行集成。若外部任务尚未登记owner，由主调度先明确，再派共享写任务；不可把“未见冲突”当默认允许并写。

**串行交接顺序**：先冻结A接口→I接A测试adapter/接线（生产写仍deny）→B1/B2/B3各自领域交付→I按最新共享文件逐hunk接B生产consumer/策略→I登记tiers/必要trace→定向+跨任务回归。A/B若需修改已经交付的共享接口，先向I提交变更契约，不自行改I文件。外部任务此间的更新由I合并，不要求外部停止整个功能开发。

越出写域/触碰冻结路径时**先停该hunk并向主调度/I/对应owner协调**，说明必要性/最小改动/测试影响，获明确同意后才转交单owner实施；不凭“修测试/格式化”越界。禁止整文件覆盖、从旧副本复制index/tiers/trace、以整文件checkout/restore清冲突；只能基于最新文件做窄hunk，保留另一任务的实现/测试。I最终验证message-speed/archive/配置测试相关基线未丢、装配只注册一次，不能只跑memory测试声称集成通过。

**量级为资深开发者有效人日（含定向测试，不是本次文档修订/agent墙钟承诺）**。r3新增raw追踪和无record全链，重新估算：

| 包/工作面                                                       | 估算          | 独立验收                                                                        |
| --------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| A：解析/cap/lease/remote                                        | 2–3人日       | fake consumer全状态矩阵、两cap隔离、分页/时限。                                 |
| A：direct dispatch/独立completion/ledger保留/mem UI/真实SDK回归 | 3–5人日       | 生产仍旧write deny；settled>TTL无SDK/native；>30秒history off与record故障全链。 |
| **A合计**                                                       | **5–8人日**   | 内核/分流/终态，不宣称全产品写支持。                                            |
| B1：单条/迁移/import/restore/scoped                             | 3–5人日       | 固定计划/token/锁/CAS/partial/unknown及故障。                                   |
| B2：tidy/batch/review/expired多步UI                             | 3–5人日       | select-loop/分页/逐effect批准/TUI不变。                                         |
| B3：Jev模型effect、wire raw tracker/admission/lifecycle         | 3–5人日       | native timeout orphan busy/无交叠/迟到不覆盖、冻结/guard/取消。                 |
| B4/I：唯一集成/策略completion/浏览器/跨任务回归/golden          | 2–3人日       | 全命令生产全链、off/native与外部冻结面证据。                                    |
| **B含I集成合计**                                                | **11–18人日** | 任一已实现命令或强制专项缺失不算完成。                                          |
| **总计**                                                        | **16–26人日** | I接A的工作计入A，避免重复估；发现新SDK/viewport缺口重估，不削安全验收抵工期。   |

#### 包A：内核、即时分流与独立终态，不开放生产写

按§6.1 A写域；共享装配/tiers/trace只交I。生产旧write deny不删，不先暴露无guard init/import；测试adapter证明全闭环，缺注入写拒绝，其他extension原样。A完成必须包括§6.2.4，不可把独立终态延后到可选优化。

下游验收命令（本次未执行；新测试创建后才有效）：

```sh
npm run typecheck
npx vitest run tests/memory/command-policy.test.ts tests/memory/command-confirm.test.ts tests/web-hub/agent/memory-command-proof.test.ts tests/web-hub/agent/memory-command-completion.test.ts tests/web-hub/agent/capture-commands.test.ts tests/web-hub/agent/builtin-bridge.test.ts
npx vitest run tests/conformance/memory-web-command-dispatch.test.ts tests/conformance/memory-scopes-proof.test.ts tests/governance/test-tiers.test.ts tests/boundary/pi-free.test.ts
```

另跑实际新增ledger/mem reducer/DetailDock定向文件，报告准确路径和结果，不以不存在/跳过当通过。

#### 包B：全部领域适配、I唯一生产接线与最终验收

§6.1 B领域含 **jev/wire.ts**与必要guard seam；B1/B2/B3可分领域，但共享command/index/wire由明确单owner串行，所有I文件遵循上文。生产开放与全部guard同里程碑，不能先删门后补确认。A seam修订由I收口。README/browser probe只记真实证据。

```sh
npm run typecheck
npx vitest run tests/memory tests/web-hub/agent/builtin-bridge.test.ts tests/web-hub/agent/command-policy.test.ts tests/web-hub/agent/capture-commands.test.ts tests/web-hub/agent/dialogs.test.ts tests/web-hub/agent/command-capture-recorder.test.ts tests/web-hub/agent/memory-command-completion.test.ts
npx vitest run tests/integration/memory-web-command-confirm.test.ts tests/conformance/memory-web-command-dispatch.test.ts tests/conformance/memory-scopes-proof.test.ts tests/conformance/memory-scopes-input.test.ts tests/conformance/memory-scopes-sdk.test.ts
npx vitest run tests/governance tests/boundary/pi-free.test.ts tests/web-hub/boundary.test.ts
npx tsx scripts/web-hub/memory-command-confirm-probe.ts
npm run test:tier1
```

I另列实际message-speed/archive/受影响配置定向回归命令（路径从外部owner交接取得，不臆造）。保留真实命令/日志/未覆盖项；发布前按仓库规则补format/build/tier2，不在本设计任务执行。不迁移生产记忆，不reload用户进程。

### 6.4 风险与扩展边界

1. 即时seam只解决memory局部dispatch；异常不能悄悄回sendUserMessage。
2. mkdir/lease/recover/keep/dismiss、taxonomy诱发bulk、sidecar/diag容易漏；审计所有effect与真实提交尾部，不只主write。
3. raw永不settle保守busy、Web物理占用会延迟native启动；安全优先。后续若需要更高可用性，可单独设计可靠提交隔离，本版不预做MVCC。
4. completion有界内存/保留窗，不承诺跨进程崩溃必达或永久网络故障送达；history off/append失败**不是**丢失终态的免责项。UI实际显示/ctl竞速是必验。
5. 不增强原txn崩溃/fsync承诺；partial/unknown由磁盘证据决定，原restore/recovery须故障实测，不新增全局回滚。
6. 大正文分页/viewport、长确认/late/query必须实测，不调大全局capture常量补救。shared index/tiers/trace只由I串行整合，外部功能不因本方案被覆盖。
7. command cap是局部域，未来命令不在封闭分类/prepare consumer一律拒绝。Jev #26模型用户令直写不在范围，不恢复已删除guard、不改工具描述/golden；统一的仅是 `/mem` Web真人命令确认体验。
