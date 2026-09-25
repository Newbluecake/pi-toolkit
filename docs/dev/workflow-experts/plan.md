# workflow-experts：agent() opts 严格校验 + agent({ experts })（v2）

> 状态：方案 v2（未施工）。v1 被评审（gpt-sol）打回，本版逐条处置，见文末「§评审修订记录」。
> 范围：① `agent(prompt, opts)` 严格校验；② workflow 子 run 可 consult 专家。
> `opts.model` / `opts.thinking` 已由 `c454a2a` / `8a69c1f` 落地，**不重做**。
> `isolation:"worktree"` 的真隔离另立 todo #10（排在本任务之后，同样要改 `host.ts` / `spawner-adapter.ts`）。本任务只保证该键仍被允许。

## 0. 开工前核对

- `git log --oneline -30 -- src/workflow src/consult src/service/spawn-service.ts`：截至 2026-09-26，最近的相关提交是 `8a69c1f`/`c454a2a`（model/thinking）和 `688c0ff`/`7e79d96`（consult `"main"`）。
  **没有**任何会话做过「未知键报错」或「workflow experts 透传」。施工前再跑一次。
- 「consult §18」在 `docs/dev/consult/plan.md` 中不存在。workflow 非目标写在 **§1（第 18 行）**，并在 §4.2（:344）、§5.2（:546）、§13 #14（:824）重复出现，§2 按这四处逐条回应。

## 1. 现状核实

### 1.1 agent() opts

| 位置                               | 事实                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/worker-source.ts:52` | 整个 worker 脚手架是一个 `String.raw` 常量，可以在模块求值时插值常量。                                                                                                                                                                                                                                         |
| `worker-source.ts:421-432, 518`    | 沙箱是 `vm.createContext(Object.create(null) + 注入函数)`。**脚本里的对象字面量原型是沙箱 realm 的 `Object.prototype`**，与脚手架的不是同一个，所以普通对象判定必须按 realm 取原型身份。`agent` 等函数定义在脚手架 realm，函数体在可信 realm 里执行。                                                          |
| `worker-source.ts:163-203`         | 现状：`var o = opts \|\| {}`（`false`/`0`/`""` 会被当成空对象），直接读 `o.model`、`o.thinking`、`o.fullResult`、`o.phase`（**可能触发 getter**）；然后 `Object.assign({}, o, {phase})`，把整个对象原样 `postMessage`。遇到不可 clone 的值时，`send()`（:268-276）会静默吞掉异常，结果只能等 HR1 超时（60s）。 |
| `src/workflow/host.ts:613-676`     | 只读 `label`/`agentType`/`phase`/`model`/`thinking`/`isolation`。类型不对的值静默降级（`agentType:123` 变成默认类型），**其它键全部丢弃**。                                                                                                                                                                    |
| `host.ts:668-675`                  | `isolation:"worktree"` 只写进 TaskSemantics 和 journal（RP7 不回放），没有实际效果（#10 处理）。                                                                                                                                                                                                               |
| 实测                               | `~/.pi/agent/sessions` 里有 115 个会话调用过 SubagentWorkflow，脚本中出现过 `effort: 'low'`、`schema: PROBE_SCHEMA`（各 2 次），全被静默吞掉。memory 里 web-hub W2 那次全跑 opus 的事故是同一根因。                                                                                                            |

### 1.2 experts / consult

| 位置                                                             | 事实                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/tools/agent-tool.ts:174-190, 328-365`                       | 顶层和嵌套 Agent 调用 `resolveExperts(experts)`，把结果写进 `SpawnRequest.consultExperts`。给了 experts 但没有 resolver 时直接 throw。                                                                                                                                                                 |
| `src/consult/index.ts:211-341`                                   | `resolveExperts`：`"main"` 最先匹配，然后按 id 匹配（exact→前缀），最后按 label 匹配（live ∪ ExpertIndex）；同名跨源 ⇒ ambiguous throw。`buildRef` 接受**任意终态且有 session 文件**的 run（failed/aborted 也算），仍在运行的标 `pending:true` 并附 warning（:256）。consult 关闭时 throw。            |
| `src/service/runtime-adapter.ts:547` / `request-threading.ts:53` | 只要 run 带 `consultExperts` 就注入 consult 工具，不管调用方是谁。                                                                                                                                                                                                                                     |
| `src/workflow/spawner-adapter.ts:46-80`                          | 逐字段组装，不带 `consultExperts`，也就不可能带 `forkSessionFrom`（consult plan :66、:694 的不变量）。                                                                                                                                                                                                 |
| `src/consult/tool.ts:187, 396, 621-640`                          | consult run：`slotless`，`parentRunId = 提问者`，`totalMs = consult.timeoutMs`（默认 150s），传入工具调用的 `signal`（不 detach，终身联动）。并发门拿不到名额时**立即 busy nack**，不等待。`waitOutcome` 不带计时器，靠 C 自己的 totalMs 保证返回。                                                    |
| `src/service/spawn-service.ts:311-556`                           | `spawn()` 准入全程**没有 await**，是同一个任务内的同步段（awk 核对过）。父 run 被跟踪时检查深度和 canSpawn（fork 请求跳过 canSpawn，:405-431）；:544-549 登记 `childrenOf`。**父 run 未被跟踪（已 finish）时不设任何限制**。                                                                           |
| `spawn-service.ts:634-647` / `:174-185`                          | `abort(R)`：`running.has` 检查 → `cascadeChildren`（只级联**当时已登记**的子 run，递归）→ `runner.abort`。`finish` 时删除 nesting/parentOf/childrenOf。runner 内部的超时和停止都会经 `onChildAbort` 回到 `service.abort(R)`（`stack.ts:1367`）。                                                       |
| `src/runtime/runner.ts:88-113`                                   | `createCancelHandle`：外部 signal 已 aborted ⇒ 立即取消；否则挂监听器。                                                                                                                                                                                                                                |
| 成本（`7d67dbc`）                                                | 正常路径：consult 工具结果带 `usage` 和 `consultRunId`，R 在对应 message_end 把 C 的花费累进 `R.diag.usage`（X9），并把 C 记进 `absorbedRunIds`。workflow 汇总（`workflow-tool.ts:309-340`）只加直属子 run；HUD 和 `/agent costs` 按 absorbedRunIds 去重（`status.ts:420`、`usage-broadcast.ts:46`）。 |
| `src/workflow/runaway.ts`                                        | 只按 worker 心跳停滞判断，与成本无关。子 run consult 期间 worker 空闲，心跳照常。                                                                                                                                                                                                                      |

## 2. 与 consult 非目标的逐条对照

| consult 原文                                                      | 回应                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1、§13#14(a)：spawner-adapter 逐字段组装，不带 consultExperts    | 仍然逐字段组装，只加一个显式字段 `consultExperts`。它的值**只能**来自宿主侧受信 resolver 的输出，脚本只能传字符串 handle，传不了 ref 对象，也传不了 `forkSessionFrom`。「forkSessionFrom 不可伪造」保持不变。                                                       |
| §13#14(a)：要改 ChildSpawnRequest                                 | 给 `ChildSpawner.spawn` 的请求加 `consultExperts?`（类型取自 `core/types.ts`，`src/workflow/**` 依旧不 import `src/service/**`，WI2 不破），并新增可选的不抛异常方法 `resolveExperts`。                                                                             |
| §13#14(a)：journal 回放要改                                       | experts **不进** taskKey。v1 用独立的「非回放标记 + chain-taint」（D12-D14）：专家调用本身不回放、不写 journal；它被接纳之后提交的所有调用也都强制 live、不写 journal。journal 格式和 taskKey 算法都不变。                                                          |
| §4.2：workflow 子 run 永远拿不到 consult 工具                     | 本方案推翻这一条，同步修改 consult plan §1 和 §4.2，并更新 skills。                                                                                                                                                                                                 |
| §5.2 安全模型：可授权任意可解析的终态 run，信任级别与 resume 相同 | 脚本作者就是主会话模型，它本来就能调用 `Agent({experts})`，所以没有提权。workflow 的规则比顶层**更严**（只接受 completed，见 D8）。另外，子 run 如果有 canSpawn，它的嵌套 Agent 工具**现在就能**给孙 run 挂 experts（`runtime-adapter.ts:537`），这里只是补齐空缺。 |

## 3. 设计决策表

| #   | 取舍点                                     | 选择                                                                                                                                                                                                                                                                                                                                                                     | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 在哪里校验                                 | **worker 先做结构快照，host 做语义校验并生成报错文案**：worker 只发快照和结构报告，不再发原对象                                                                                                                                                                                                                                                                          | host 和 worker 看到的是同一份数据。快照里只有原始值和字符串数组，一定能 clone，函数值导致白等 HR1 的路径从结构上消失。报错文案只在 host 生成一份，并发 `rejected` 事件（UI 上计入 `⚠ N`）。                                                                                                                                                                                                                                                         |
| D2  | 什么算普通对象                             | 原型是 `null`、沙箱 realm 的 `Object.prototype`（`createContext` 后立刻用 `vm.runInContext("Object.prototype", ctx)` 捕获）或脚手架 realm 的 `Object.prototype`；并且 `!util.types.isProxy(o)`                                                                                                                                                                           | 拒绝数组、函数、类实例、Proxy、`Map`、装箱原始值。host 端（结构化克隆之后）用同一个判定函数，只是 realm 集合换成 host 的 `Object.prototype`/`null`。                                                                                                                                                                                                                                                                                                |
| D3  | 怎么读属性                                 | `Reflect.ownKeys`（包括 Symbol 和不可枚举键）加 `Reflect.getOwnPropertyDescriptor`，**永不调用 getter**                                                                                                                                                                                                                                                                  | 访问器属性（get/set）一律报 `accessor`；只读 data 属性的 `value`，不做任何隐式类型转换。整段逻辑包在 try/catch 里，Proxy 陷阱、已撤销的 Proxy 等任何抛错统一报 `threw`，最终都归为 `invalid_args`。                                                                                                                                                                                                                                                 |
| D4  | 什么时候可以不传 opts                      | 只有 `undefined`/`null` 视同 `{}`；`false`、`0`、`""` 以及其它任何非普通对象都报 `invalid_args`                                                                                                                                                                                                                                                                          | 修掉 `opts \|\| {}` 的问题。                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D5  | 未知键                                     | **只要存在就 reject**（值为 `undefined`、Symbol 键、不可枚举键也不例外）                                                                                                                                                                                                                                                                                                 | v1 曾忽略值为 `undefined` 的未知键，评审要求真正严格。允许的键值为 `undefined` 时仍视为未传（与现在的 model/thinking 一致）。                                                                                                                                                                                                                                                                                                                       |
| D6  | 已知键类型错误                             | reject（`invalid_args`）；`model`/`thinking` 的现有文案保持不变                                                                                                                                                                                                                                                                                                          | `agentType:123` 静默落到默认类型，正是本任务要消灭的问题。`experts` 必须是真数组（不能是 Proxy，原型必须是数组原型）；自有键只能是下标加 `length`，不能有空洞，每项都是 trim 后非空的字符串，**不能重复**（trim 后比较）。                                                                                                                                                                                                                          |
| D7  | 误写提示                                   | 列出允许键全集，加上 §4.1 的提示表，加上大小写不同时的 `did you mean`                                                                                                                                                                                                                                                                                                    | 覆盖实测出现过的 `effort` 和 `schema`。                                                                                                                                                                                                                                                                                                                                                                                                             |
| D8  | 专家必须是什么状态（用户最终口径）         | **只接受 `completed` 且 session 文件存在的 run**；failed/timed_out/aborted/仍在运行一律 reject（`"main"` 不是 run，照旧按 §16 规则现读 facts）。**只对 workflow 生效**：consult resolver 新增 opt-in 选项 `completedOnly`，顶层 Agent 默认不传，行为不变                                                                                                                 | 脚本可以 `await` 专家，派发时专家不是 completed，要么是漏了 await，要么上游失败了。失败 run 的 session 往往只有半截结论，consult 一个失败的上游多半是误用。顶层保持宽松：主会话模型会收到失败通知，是明知其状态才挂的，而且改动范围由主会话决定。**后续可选**：顶层也收紧（届时只需改成默认传 `completedOnly`）。                                                                                                                                   |
| D9  | 解析顺序                                   | `"main"` → **本 workflow 内的调用**（按声明 label 或实际 label） → resolver（label/run_id，`completedOnly:true`）                                                                                                                                                                                                                                                        | `"main"` 的优先级与顶层一致（consult §16 规则 2）。本地必须先查：脚本声明 `label:"dev"`，spawn 去重后可能实际叫 `dev-2`；如果直接交给 resolver，会解析到**外面那个 `dev`**。                                                                                                                                                                                                                                                                        |
| D10 | 本地命中多个调用                           | 本地候选 = 声明 label 或实际 label 等于该 handle 的调用。**有任何候选未 settle ⇒ reject**（still running）。否则只保留 `source:"live"`、`status:"completed"`、有 runId 的：恰好 1 个 ⇒ 改写为它的 runId；多于 1 个 ⇒ ambiguous；0 个 ⇒ reject，并列出各候选的状态（failed / withheld / replayed）。**只要有本地候选就绝不回落到 resolver**。                             | 常见的「失败后同 label 重试」写法可以正常解析；本地的失败或回放调用永远不会被改写成可 consult 的 ref，也不会意外解析到外部的同名旧 run。                                                                                                                                                                                                                                                                                                            |
| D11 | 何时解析                                   | **提交时**：在 journal 块、maxChildren、BW2 之后，入队或派发之前                                                                                                                                                                                                                                                                                                         | 快速失败，走 ack 失败路径。专家是终态，排队期间不会变；`"main"` 的 facts 到 consult 时才现读。                                                                                                                                                                                                                                                                                                                                                      |
| D12 | 专家调用本身能否回放                       | `decideReplay` 在 lookup **之前**返回 `skip:"experts"`，且**不写** journal                                                                                                                                                                                                                                                                                               | 专家是 taskKey 看不到的依赖；`"main"` 的会话一直在变。                                                                                                                                                                                                                                                                                                                                                                                              |
| D13 | chain-taint（回放安全）                    | host 闭包里有一个 `replayTainted` 标记，某次带 experts 的调用**解析成功**（被接纳，排队或派发都算）时置位，此后**提交**的所有调用：`skip:"chain_tainted"`，并且**不写** journal。整个 run 内不会清除。**被拒的专家调用（invalid_args / experts_unresolved / max_children / BW2）不置位。**                                                                               | 专家调用每次都 live，但 chain digest 只看 taskKey，不看结果，所以它下游的调用即使 prompt 一字不差，也可能依赖它这一次的结果或副作用（比如改过的文件）。若回放，拿到的是基于上一次专家结论的旧结果。被拒的专家调用什么都没 consult，没有引入隐藏依赖，后续控制流的差别会体现在后续提交的 key 上。「不写」也是必要的：否则某次专家被拒的运行会读到专家成功那次运行写下的下游条目。置位时机与环境有关，但只会减少命中，不会产生错误命中（fail-safe）。 |
| D14 | content scope                              | **同样受 taint 约束**                                                                                                                                                                                                                                                                                                                                                    | content scope 文档化的「与上游无关」的前提是上游结果本身稳定（要么命中、要么确定）；一个每次都 live 的 consult 调用打破了这个前提。v1 取保守。代价：专家调用靠前的脚本基本没有回放收益，写进 skill。                                                                                                                                                                                                                                                |
| D15 | taint 的实现方式                           | **独立标记**（skip 原因可见），不把「不可复现标记」混进 chain digest                                                                                                                                                                                                                                                                                                     | 混进 digest 只会静默变成 miss，而且照样**写**条目（写在随机 chain 下，成了 journal 垃圾），也没法和普通 miss 区分。                                                                                                                                                                                                                                                                                                                                 |
| D16 | 回放命中或 withheld 的本地专家             | reject（D10 的 0-completed 分支），提示改用 `noReplay:true` 或传外部 run_id                                                                                                                                                                                                                                                                                              | 回放命中在本次运行里没有 session 可以 fork。**已知限制**：开了 journal 的脚本重跑时，上游专家若命中，下游专家调用会被拒，只能整体 `noReplay`（Q1）。v2：在 JournalEntry 里记 `runId`，fork 历史 session（属于格式变更）。                                                                                                                                                                                                                           |
| D17 | 解析接口                                   | `ChildSpawner.resolveExperts?`，不抛异常；缺失时 reject「not supported in this context」                                                                                                                                                                                                                                                                                 | 保持 WI2，绝不静默忽略（与 `agent-tool.ts:334` 口径一致）。                                                                                                                                                                                                                                                                                                                                                                                         |
| D18 | 父 run abort 与 consult spawn 准入同时发生 | 在 spawn-service 里关死（D19）                                                                                                                                                                                                                                                                                                                                           | 见 §4.7。                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D19 | 时序契约                                   | ① `abort(R)` 在**第一个 await 之前**同步 `stopping.add(R)`，`finish(R)` 时删除；② `forkSessionFrom` 请求要求 `parentRunId` 存在、`running.has(parent)` 为真、且不在 `stopping` 里，否则返回 config error `parent run is stopping or gone`。consult 工具收到后按「could not be launched」nack，并删除 fork 文件（现有分支）。③ 工具调用的 signal 继续传入，作为第二道保险 | 准入是同步段：在 abort 之前准入的，已登记进 childrenOf，会被级联；在 abort 之后准入的，会被 ① 拦住。R 自然结束（finish）之后才到的 consult 会被 ② 拦住，不会变成无父 run。C 的 150s totalMs 是最后兜底，零挂死不依赖 ①②。                                                                                                                                                                                                                           |
| D20 | 成本                                       | **正常完成路径恰好计入一次**；**consult 进行中 R 被 abort 时，workflow 汇总（和 `budget.spent()`）会少计 C**，全局 HUD 和 `/agent costs` 仍把 C 当独立 run 计入。列为已知缺口，v1 不补偿                                                                                                                                                                                 | 补偿方案（v2）：汇总时再加上「parentRunId 是某个直属子 run、且不在任何子 run absorbedRunIds 里」的后代 run，**同时**把这些 id 放进 workflow 结果的 `runIds`，否则主会话吸收这份 usage 后 HUD 会重复计入。牵涉 `workflow-notice` 和 `result-tool` 两处，本次不做。                                                                                                                                                                                   |
| D21 | 预算与开关                                 | 不新增 workflow 级 consult 预算；**严格校验不加开关**（用户已确认），回滚靠 revert；experts 可以用 `consult.enabled=false` 关掉（此时 agent() 报错，不会静默）                                                                                                                                                                                                           | 不增加配置旋钮（consult §4.6）。                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D22 | 诊断                                       | `WorkflowChildSummary.experts?`（解析后的 runId 或 `"main"`），`WorkflowReplayStats.tainted?: true`；workflow 结果的 replay 行显示 `(chain tainted by experts)`                                                                                                                                                                                                          | 事后可以核对。                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 4. 改动清单

### 4.1 新增 `src/workflow/agent-opts.ts`（纯 TS，不引入 pi，只 import `node:util`）

```ts
export const AGENT_OPTS_KEYS = [
  "label",
  "agentType",
  "phase",
  "fullResult",
  "model",
  "thinking",
  "isolation",
  "experts",
] as const;
export type AgentOptsKey = (typeof AGENT_OPTS_KEYS)[number];
/** worker → host 的结构报告（worker 侧 JS 版与这里的 TS 版共用一张 parity 测试表）。 */
export type OptsDefect = { code: "not_plain_object" | "proxy" | "accessor" | "threw" | "bad_array"; key?: string };
export interface OptsSnapshot {
  readonly values: Readonly<Partial<Record<AgentOptsKey, string | boolean | readonly string[]>>>;
  readonly unknownKeys: readonly string[]; // Symbol 键渲染为 `Symbol(desc)`
  readonly defect?: OptsDefect;
}
/** host 侧：对（已 clone 的）原始 opts 做同样的快照；realmProtos 默认是 host 的 Object.prototype 和 null。 */
export function snapshotAgentOpts(raw: unknown, realmProtos?: readonly (object | null)[]): OptsSnapshot;
export interface ValidatedAgentOpts {
  readonly label?: string;
  readonly agentType?: string;
  readonly phase?: string;
  readonly fullResult?: boolean;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly isolation?: "worktree";
  readonly experts?: readonly string[]; // 已 trim、去空、查重；空数组 ⇒ undefined
}
/** 合并 worker 报告与 host 自己的快照（unknownKeys 取并集，defect 任一存在即拒）。 */
export function validateAgentOpts(
  hostSnapshot: OptsSnapshot,
  workerReport?: { unknownKeys?: readonly string[]; defect?: OptsDefect },
): { ok: true; opts: ValidatedAgentOpts } | { ok: false; message: string };
export const AGENT_OPTS_HINTS: Readonly<Record<string, string>>;
```

提示表：

- `subagent_type` / `agent_type` / `type` / `agent` → `agentType`
- `description` / `name` → `label`
- `effort` / `reasoning` / `reasoning_effort` → `thinking ('off'|'low'|'medium'|'high')`
- `timeout_ms` / `timeout_s` / `timeout` / `timeoutMs` → 没有逐次调用的超时，子 run 钉在 workflow 截止时间上，请改设 SubagentWorkflow 的 `timeout_s`
- `schema` → 不支持结构化输出，在 prompt 里要求返回 JSON，再 `JSON.parse`
- `resume` → 不支持，请用 Agent 工具的 `resume`
- `run_in_background` / `background` → agent() 本身就是异步的，用 `parallel()`
- `expert` → `experts`（字符串数组）
- `full_result` → `fullResult`
- 通用规则：转小写后与某个允许键相同时，提示 `did you mean <key>`

报错文案：`agent(prompt, opts?): unknown option(s) "effort", "subagent_type" — allowed: label, agentType, phase, fullResult, model, thinking, isolation, experts. "effort" → use thinking (…); "subagent_type" → use agentType.`
各类缺陷的报错格式都是 `agent(prompt, opts?): opts must be a plain object (got <kind>)`，或者 `opts.<key> must be a data property (accessors are not allowed)` 这一类。

### 4.2 新增 `src/workflow/expert-scope.ts`（纯函数，状态放在 host 闭包里，每个 workflow run 一份）

```ts
export interface WorkflowExpertScope {
  noteSubmitted(callId: CallId, declaredLabel: string | undefined): void;
  noteBound(callId: CallId, runId: RunId, effectiveLabel: string | undefined): void;
  noteSettled(summary: WorkflowChildSummary): void; // 记录 source/status/runId
  /** D10 规则；"main" ⇒ pass。 */
  mapLocal(
    handle: string,
  ): { kind: "pass"; handle: string } | { kind: "local"; runId: RunId } | { kind: "reject"; message: string };
}
export type WorkflowExpertResolver = (
  handles: readonly string[],
) => { refs: readonly ConsultExpertRef[] } | { error: { message: string } };
export function createWorkflowExpertScope(): WorkflowExpertScope;
export function resolveWorkflowExperts(
  handles: readonly string[],
  scope: WorkflowExpertScope,
  resolver: WorkflowExpertResolver | undefined,
): { ok: true; refs: readonly ConsultExpertRef[]; ids: readonly string[] } | { ok: false; message: string };
```

流程：先对每个 handle 调 `mapLocal`，把 local 的改写成 runId、pass 的保留原样，再把整批一次交给 resolver。
resolver 返回 error ⇒ 原文透传。返回结果里出现任何 `pending:true` 的 ref ⇒ reject（双保险，正常情况下 `completedOnly` 已经拦住）。
refs 按 runId 去重（label 和 run_id 可能指向同一个 run）。

### 4.3 `src/consult/index.ts`（opt-in 选项，顶层行为不变）

- `resolveExperts(refs: readonly string[], opts?: { completedOnly?: boolean }): ResolveExpertsResult`；`ConsultWiring.resolveExperts` 的签名同步扩展。
- `buildRef`（:211）：`completedOnly` 时，状态必须是 `completed`：取 live 快照的 `status`，没有就取 ExpertIndex 记录的 `status`。不满足时返回 failure `its run ended as <status> (workflow experts must be completed runs)`，或 `is still running (await it first)`。`"main"` 分支不受影响。
- 不传 opts 时逐字节保持现状（`wire.test.ts` 已有用例保持绿）。

### 4.4 `src/workflow/host.ts`

- `handleAgent`（:613）：先校验 prompt；再 `validateAgentOpts(snapshotAgentOpts(a.opts), a.optsReport)`，失败 ⇒ `emitRejected(…"invalid_args"…)` 加 ack 失败（这一步在 journal 块**之前**，契约见 §5）。原先 :614-676 那些零散的读取全部改成读 `ValidatedAgentOpts`。
- journal 块（:699-785）：`sem` **不变**。`decideReplay` 多传 `experts: opts.experts !== undefined` 和 `tainted: replayTainted`。这两者任一为真时**不** `journalMetaOf.set`。
- maxChildren/BW2（:788-803）之后：若带 experts，调用 `resolveWorkflowExperts(opts.experts, expertScope, deps.spawner.resolveExperts)`。失败 ⇒ `emitRejected(callId,"admission","experts_unresolved",…)` 加 ack 失败；成功 ⇒ `replayTainted = true; replayStats.tainted = true`，把 refs 和 ids 挂到 `QueuedAgentCall`。
- `registry.submit` 共三处（回放命中 :734、排队 :828、立即 :853），旁边都调 `expertScope.noteSubmitted`。两处 bind 成功（`runBoundChild` 调用前）调 `noteBound`。`recordSettled`（:450）调 `noteSettled`，并附上 `experts`。
- `WorkflowChildRejectReason`（:162）增加 `"experts_unresolved"`；`QueuedAgentCall`（:270）增加 `consultExperts?`/`expertIds?`；`spawnRequestFor`（:930）转发 `consultExperts`。
- `ChildSpawner`（:55）：`spawn` 请求增加 `consultExperts?: readonly ConsultExpertRef[]`，新增 `resolveExperts?: WorkflowExpertResolver`。
- 新状态（`expertScope`、`replayTainted`、`expertIdsOf`）全部放在 `attachHostCallHandler` 闭包里，**模块作用域不放可变状态**。

### 4.5 `src/workflow/worker-source.ts`

- `WORKER_SOURCE` 里插值 `${JSON.stringify(AGENT_OPTS_KEYS)}`（import 自 `agent-opts.ts`）。脚手架增加 `const { types: utilTypes } = require("node:util")`。
- `createContext` 之后（:518）捕获 `sandboxObjectProto = vm.runInContext("Object.prototype", ctx)` 和 `sandboxArrayProto`，赋给脚手架的模块级变量（每个 worker 线程只执行一次，线程本身每次运行都新建，不涉及 /reload）。
- `agent()`：先由 `snapshotOpts(opts)` 生成 JS 版快照（D2-D6 的结构部分，与 TS 版逻辑一致，由 parity 测试表保证）。**之后只读快照**：model/thinking 的客户端 TypeError 检查照旧，但改成读快照值；`fullResult` 和 `phase` 也读快照。
  发送的内容是 `callHost("agent", { prompt, opts: {...snapshot.values, phase}, optsReport: { unknownKeys, defect } })`。worker 不再为未知键或缺陷在本地 reject，统一交给 host 生成报错并发事件。
- 原先 v1 计划的 DataCloneError 加固**取消**：快照只含原始值和字符串数组，不可能 clone 失败。

### 4.6 `src/workflow/types.ts` / `replay.ts`（journal.ts 不改）

- `TaskSemantics` 和 `taskKeyOf` **不改**，taskKey 逐字节不变；`JournalEntry` 也不改。
- `WorkflowChildSummary.experts?: readonly string[]`；`WorkflowReplayStats.tainted?: true`。
- `DecideReplayInput` 增加 `experts?: boolean`、`tainted?: boolean`。`decideReplay` 的判定顺序：`no_replay` → `non_deterministic` → **`experts`** → **`chain_tainted`** → `config_hash_unavailable` → lookup → …；`ReplayDecision` 的 reason 联合类型加上这两个值。

### 4.7 `src/service/spawn-service.ts`（D19，对所有 consult 都生效）

- 闭包内新增 `const stopping = new Set<RunId>()`。`abort()`（:634）通过 `running.has` 检查后、`cascadeChildren` 之前**同步** `stopping.add(runId)`；`finish`（:174）里 `stopping.delete(outcome.runId)`。
- `spawn()` 准入：在 deadlineAt 检查之后、任何可变状态写入之前加：`if (req.forkSessionFrom && (!req.parentRunId || !running.has(req.parentRunId) || stopping.has(req.parentRunId))) return { error: { kind: "config", message: "parent run is stopping or gone", retryable: false } }`。
- 普通嵌套 spawn（非 fork）v1 不收紧，列为后续可选；只收紧 fork 请求，影响面仅限 consult。

### 4.8 `src/workflow/spawner-adapter.ts` 与 `src/stack.ts`

```ts
export function createWorkflowChildSpawner(
  spawn: SpawnService,
  types: AgentTypeRegistry,
  opts?: { resolveExperts?: (refs: readonly string[], o: { completedOnly: true }) => ResolveExpertsResult },
): ChildSpawner;
```

- `spawn()`：`...(req.consultExperts?.length ? { consultExperts: [...req.consultExperts] } : {})`，依旧逐字段组装。
- `resolveExperts`：固定传 `{ completedOnly: true }`，用 try/catch 把 throw 转成 `{ error }`。
- `stack.ts:1837`：`createWorkflowChildSpawner(spawn, types, { resolveExperts: (refs, o) => { if (!consultRef.current) throw new Error("consult is not wired yet"); return consultRef.current.resolveExperts(refs, o); } })`。

### 4.9 文档（与对应提交一起）

- `src/tools/workflow-tool.ts:63-69, 408-410`：opts 列表补上 `isolation` 和 `experts`；写明未知键或类型错误会 reject（报错里列出允许的键）；写明 experts 只接受本 workflow 内已 **completed** 的调用（按声明 label 匹配）、run_id 或 `"main"`；带 experts 的调用以及其后提交的调用都不回放。同步修改 `tests/tools/workflow-tool.test.ts:208`。
- `skills/dev-flow/references/subagent-workflow.md:33-43`：更新允许键清单；「effort 被忽略」改为「未知键 reject」；「不支持 experts」改为用法说明（先 await 专家、label 唯一、只接受 completed、会 taint 回放、journal 重跑的限制）；模板里补一个验收阶段用 `experts:[\`dev:${t.id}\`]` 的例子。
- `skills/dev-flow/SKILL.md:35, :260`：删掉「workflow 不能挂 experts」，改为「可挂，限制见 references」。
- `docs/dev/consult/plan.md` 的 §1（:18）和 §4.2（:344）：各加一行「已被 workflow-experts plan 解除；workflow 只接受 completed 专家」。
- `AGENTS.md` 的 `src/workflow/` 条目：写明 opts 严格校验、experts 透传、chain-taint。memory 里 `pitfalls.md` 的对应小节由主会话在落地后更新。

## 5. 计数与回放契约表

handleAgent 里的阶段顺序：① prompt 和 opts 校验 → ② journal 块（occurrence++、chain 推进、decideReplay）→ ③ maxChildren、BW2 → ④ experts 解析 → ⑤ 入队或派发。

| 情况                                                                                                         | 停在阶段   | occurrence | chain digest | 回放判定 / 统计                       | 写 journal           | taint      | 事件 / worker 端结果                                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------- | ---------- | ------------ | ------------------------------------- | -------------------- | ---------- | ------------------------------------------------------------------------ |
| `invalid_args`（未知键、类型错误、结构缺陷、重复 handle）                                                    | ①          | **不推进** | **不推进**   | 不判定，不计数                        | 否                   | 不变       | `rejected{admission,invalid_args}`；agent() reject                       |
| 带 experts，但因 max_children/BW2 被拒                                                                       | ③          | 推进       | 推进         | `skip:experts`（计入 skipped）        | 否                   | **不置位** | `rejected{max_children\|budget_exhausted}`                               |
| `experts_unresolved`（找不到、有歧义、未 completed、仍在运行、replay/withheld、resolver 缺失、consult 关闭） | ④          | 推进       | 推进         | `skip:experts`（计入 skipped）        | 否                   | **不置位** | `rejected{admission,experts_unresolved}`；agent() reject，脚本可以 catch |
| 带 experts，解析成功                                                                                         | ⑤          | 推进       | 推进         | `skip:experts`                        | 否                   | **置位**   | 正常 queued/spawned/settled                                              |
| taint 置位之后提交的任何调用                                                                                 | 按实际情况 | 推进       | 推进         | `skip:chain_tainted`（优先于 lookup） | 否                   | 保持       | 正常                                                                     |
| taint 之前的普通调用                                                                                         | —          | 同现状     | 同现状       | 同现状                                | 同现状（仅限成功的） | —          | —                                                                        |

性质：

- (P1) 同一个脚本、同样的输入下，invalid_args 与环境无关，所以 occurrence 和 chain 的序列在两次运行之间一致。
- (P2) 任何回放命中的调用，其所在运行里在它之前都没有被接纳的专家调用；它命中的条目，也来自某次运行中 taint 之前的位置。
- (P3) taint 之后不产生任何 journal 条目。
- (P4) 每次提交都恰好对应一次 ack 失败或一次 settle（沿用现有不变量）。

## 6. 测试清单

**A. opts 严格校验**：`tests/workflow/agent-opts.test.ts`（新增，TS 版）、`worker-host-call.test.ts`（真实 worker、JS 版与 parity 表）、`host.test.ts`。

1. 所有误写键（`effort`、`subagent_type`、`timeout_ms`、`timeout_s`、`schema`、`resume`、`run_in_background`、`expert`、`description`、`AgentType` 大小写变体）：reject，报错里有允许键全集和对应提示；多个未知键一次全部列出。
2. 未知键即使值为 `undefined` 也 reject；**Symbol 键**、**不可枚举键**（`Object.defineProperty`）同样 reject。
3. 允许键是**访问器**（getter/setter）⇒ reject，且断言 getter **从未被调用**（用计数器验证）。
4. 原型链：`Object.create({label:"x"})`（继承来的属性不算 own，而且原型不在白名单）⇒ `not_plain_object`；`Object.create(null)` 可以通过；类实例、`new Map()`、函数、数组、`new String("x")` 都被拒。
5. Proxy：`new Proxy({}, {})`、ownKeys 或 getOwnPropertyDescriptor 陷阱会抛错的 Proxy、已撤销的 Proxy ⇒ 报 `proxy`/`threw`，都是 invalid_args，且陷阱没有执行（Proxy 在读任何东西之前就被判出）。
6. opts 为 `false`、`0`、`""` ⇒ invalid_args；`undefined`/`null` ⇒ 按空 opts 处理。
7. 类型错误：`agentType:1`、`label:{}`、`fullResult:"yes"`、`isolation:"x"`、`experts:"a"`、`experts:[1]`、`experts:[""]`、带空洞的数组、带额外自有键的数组、`experts:["a"," a"]`（trim 后重复）⇒ invalid_args；`model`/`thinking` 的旧文案不变（现有 :1523 用例保持绿）。
8. 合法的全部键（包括 worker 注入的 `phase`）：现有 host 和 worker 用例全绿，spawn 请求形状不变（`spawner-adapter.test.ts:59`）；`experts:[]` ⇒ 当作没传（不 taint）。
9. host 防伪造：直接构造一个带未知键或 getter 形状的 envelope 发给 host ⇒ 同样拒绝；`optsReport` 与 host 快照取并集。
10. 真实 worker：reject 能被 `try/catch` 捕获；在 `parallel()` 里只把该槽位置 null 并报 `stage_error`；顶层 await 时 workflow 以 script_error 结束；opts 里有函数值时**立即**失败，不等 HR1。
11. Parity：同一张用例表分别跑 worker JS 版和 TS `snapshotAgentOpts`，结构分类完全一致。

**B. experts 解析**：`tests/workflow/expert-scope.test.ts`（新增）、`host.test.ts`、`tests/consult/wire.test.ts`。

12. 本地按声明 label 命中 completed 调用 ⇒ 改写为 runId，spawn 请求带上 `consultExperts`；spawn 去重后实际叫 `dev-2` 时仍能命中本地（外部同时存在 `dev` 也不会误解析到外部）；按实际 label 或 run_id 也能解析。
13. `"main"` 优先于本地同名 label；本地没有候选时回落到 resolver，而且调用时带 `completedOnly:true`（spy 断言参数）。
14. **completed-only**：本地调用 failed/timed_out/aborted/withheld/replay ⇒ reject 并在报错中列出状态；外部 run 为 failed/aborted ⇒ resolver 以 `completedOnly` 失败；外部 run 为 running ⇒ 失败；「main」不受影响。
15. **completed 但没有 sessionFile**（rememberAgents=false），或 sessionFile 已被删除：本地和外部两种情况都 reject（resolver 的原文透传）。
16. **本地同名先失败后成功**：同一个 `label:"dev"`，第一次 failed、第二次 completed ⇒ 解析到第二次；两次都 completed ⇒ ambiguous；有一次仍在运行 ⇒ still running。
17. **resolver 永远不会把本地失败或回放的调用改写成 ref**：spy 断言传给 resolver 的 handle 里不包含这些调用的 runId，而且在有本地候选时根本不调用 resolver。
18. 重复 handle ⇒ invalid_args；label 和 run_id 指向同一个 run ⇒ refs 去重为一条。
19. 以上各种拒绝都是 ack 失败加 `rejected{experts_unresolved}`，spawn 没有被调用，`children[]` 里没有记录；排队路径下 refs 会随 `QueuedAgentCall` 带到延迟派发。
20. `wire.test.ts`：不传 opts 时顶层行为逐字节不变（failed 专家照样被接受）；传 `completedOnly` 时拒绝 failed 和 pending。

**C. 回放与 chain-taint**：`replay.test.ts`（RP 门矩阵加行）、`journal-replay-e2e.test.ts`、`tests/workflow/replay-taint.property.test.ts`（新增，带 seed，仿照 `host-queue.property.test.ts`）。

21. `decideReplay`：`experts:true` 或 `tainted:true` 时，即使存在匹配条目也返回 `skip`，且 lookup 从未被调用（spy）；判定顺序与 §4.6 一致（`noReplay` 优先）。
22. host：专家调用解析成功之后提交的调用，在 chain 和 content 两种 scope 下都是 `skip:chain_tainted`，都不写 journal；`replay.tainted === true`；taint 之前的调用照常命中。
23. **caught rejection**：脚本 catch 住 `experts_unresolved` 之后继续跑 ⇒ 不 taint，后续调用照常回放，且 occurrence 和 chain 按契约表推进；invalid_args 被 catch 之后 occurrence 和 chain **不变**（对比 host 内部计数的快照）。
24. **外部 resolver 在两次运行之间换了 run**（第一次 label x 解析到 r1，第二次解析到 r2）：两次专家调用都 live，第二次运行中它下游 prompt 一字不差的调用**不命中**（taint 生效）。
25. 属性测试：随机生成提交序列（普通调用 / 解析成功的专家调用 / 被拒的专家调用 / invalid_args / 重复 handle / 专家处于不同状态），跑两遍，第二遍随机翻转环境（解析是否成功、外部 run 是否换了），断言 P1-P4，以及「每个命中都不在 taint 之后」「taint 之后 journal 条目数为 0」。seed 覆盖要求：每个分支至少触发一次（沿用 host-queue 的 branch coverage guard）。
26. taskKey golden：不带任何新选项的调用，key 与改动前写死的 hex 完全相等（证明 TaskSemantics 没变）。

**D. 时序、不死锁、成本**：`tests/service/spawn-fork-admission.test.ts`、`tests/integration/workflow-experts.test.ts`（新增，真实 SpawnService 加假 runner，仿照 `a2-window-real-spawn-service.test.ts`）。

27. **abort 与准入同时发生**：R 运行中，同步调用 `service.abort(R)`，在同一个 tick 里（第一个 await 之前）发起 `spawn({forkSessionFrom, parentRunId:R, slotless})` ⇒ error `parent run is stopping or gone`。先 spawn 再 abort ⇒ C 在 cascade 名单里，最终 aborted。R 已经 finish 之后再 fork spawn ⇒ 被拒。非 fork 的嵌套 spawn 行为不变。
28. 并发上限为 1、`maxParallel=1`，R 占着唯一的 slot 和并行槽时，consult spawn 立即被准入（slotless）；workflow 的第二个 agent() 仍按 FIFO 排队，两者互不影响。
29. workflow 的 stop 或 killAt ⇒ abort R ⇒ C 被级联 aborted；`stopOwned` 在 abortGraceMs 内结束，没有残留计时器。
30. 成本，正常路径：R 吸收了 C（usage 里含 C，absorbedRunIds 含 C）⇒ `aggregateChildUsage` 恰好计入一次，`/agent costs` 不重复。
31. 成本，**abort 少计**（钉住已知缺口）：consult 进行中 R 被 abort，没有 toolResult ⇒ workflow 汇总不包含 C，但 `usage-broadcast` 或 HUD 的 `+agents` 包含 C。用例注释写明这是 D20 的已知缺口，将来修复时改这条断言。

`src/core/state-machine.ts` 和 CallRegistry 的阶段都没有改，所以 run 状态机矩阵不动；journal 和回放语义有变化，因此按 AGENTS.md 同步 RP 门矩阵（21）并新增属性测试（25）。

## 7. 包拆分、冻结面、conflict-check

三个包。B 和 C 与 A 的文件互不相交，可以并行。A 内部按顺序提交两次。A 的集成测试（D 组 28-31）在 B、C 合入之后再跑。

- **A `wf-experts`**：① `feat(workflow): strict agent() option validation`（§4.1、§4.4 的校验部分、§4.5，以及 §4.9 中关于 opts 的文档）→ ② `feat(workflow): agent({ experts }) with completed-only resolution and chain-taint replay`（其余部分）。
- **B `spawn-fork-guard`**：`fix(spawn): reject consult fork admission while the parent is stopping or gone`（§4.7，测试 27）。
- **C `consult-completed-only`**：`feat(consult): opt-in completedOnly expert resolution`（§4.3，测试 20）。

冻结面（B、C 先按这些签名开工，A 依赖它们）：`resolveExperts(refs, opts?: { completedOnly?: boolean })`、fork 准入的报错文案 `parent run is stopping or gone`、`AGENT_OPTS_KEYS`、`ChildSpawner.spawn` 请求里的 `consultExperts`、`ChildSpawner.resolveExperts`、`DecideReplayInput.{experts,tainted}`、reason `"experts" | "chain_tainted"`、`"experts_unresolved"`、`WorkflowChildSummary.experts`、`WorkflowReplayStats.tainted`。

车道：kimi-k3 → glm-5.3 → sonnet；方案评审挂 opus。

```json
[
  {
    "id": "wf-experts",
    "globs": [
      "src/workflow/agent-opts.ts",
      "src/workflow/expert-scope.ts",
      "src/workflow/host.ts",
      "src/workflow/worker-source.ts",
      "src/workflow/types.ts",
      "src/workflow/replay.ts",
      "src/workflow/spawner-adapter.ts",
      "src/stack.ts",
      "src/tools/workflow-tool.ts",
      "tests/workflow/agent-opts.test.ts",
      "tests/workflow/expert-scope.test.ts",
      "tests/workflow/replay-taint.property.test.ts",
      "tests/workflow/host.test.ts",
      "tests/workflow/replay.test.ts",
      "tests/workflow/journal-replay-e2e.test.ts",
      "tests/workflow/spawner-adapter.test.ts",
      "tests/workflow/worker-host-call.test.ts",
      "tests/integration/workflow-experts.test.ts",
      "tests/tools/workflow-tool.test.ts",
      "skills/dev-flow/SKILL.md",
      "skills/dev-flow/references/subagent-workflow.md",
      "docs/dev/consult/plan.md",
      "AGENTS.md"
    ]
  },
  { "id": "spawn-fork-guard", "globs": ["src/service/spawn-service.ts", "tests/service/spawn-fork-admission.test.ts"] },
  { "id": "consult-completed-only", "globs": ["src/consult/index.ts", "tests/consult/wire.test.ts"] }
]
```

与 todo #10（isolation 真隔离）的关系：两者都会改 `host.ts` 和 `spawner-adapter.ts`，**必须串行**（本任务先做）。#10 开工前重新跑一遍 conflict-check。

## 8. 风险、兼容性与回滚

- **旧脚本**：实测有 `effort` 和 `schema` 的用法，改动后会被 reject。在 `parallel()`/`pipeline()` 里表现为该槽位 null 加 `⚠`，顶层 await 时表现为 workflow 失败。这是有意为之。**迁移口径**：按提示删掉或改名。journal 不受影响，这些键从未进入 taskKey，删掉后原条目照常命中。这类脚本都是模型临时写的，不存在需要迁移的存量脚本库。
- **收得更严的写法**：非普通对象的 opts、getter、Symbol 键、`opts=false` 等过去都被静默接受，现在报 invalid_args。
- **回放收益下降**：专家调用之后整条链都 live（chain 和 content 两种 scope），这是有意的保守选择（D13、D14）。开了 journal 的脚本重跑时，如果上游专家命中回放，下游专家调用会被拒（D16）。
- **spawn-service 收紧**（B）：只影响 fork 请求（consult），父 run 正在停止或已经消失时拒绝准入，consult 工具已有「could not be launched」nack 分支。
- **consult 并发**：workflow 的 4 个子 run 各并发 2 个 consult，就能占满全局 8 个名额，此时其它提问者会收到 busy nack（不等待、不挂起），写进 skill。
- **成本**：见 D20，正常路径恰好计入一次，中途 abort 时 workflow 汇总会少计（全局照常计入）。没有 workflow 级预算，单次 consult 受 $4 和 maxTurns 约束。
- **零挂死**：解析是同步且有界的（几次 statSync），不新增等待或计时器；consult 不占 slot、有 150s 硬顶；D19 让 consult 无法在父 run 停止期间或之后被准入，signal 作为第二道保险。
- **残留（既有问题）**：专家 run 在 workflow 运行期间被主会话 `resume`，会接着往同一个 session 文件里写，普通专家的 fork 没有 main 那样的一致性复核。顶层也有同样的问题，本次不修。
- **回滚**：A、B、C 可以分别 revert。只想关掉 experts 时，设 `consult.enabled=false`（此时报错，不会静默）。严格校验不设开关（用户已确认）。

## 9. 仍需用户确认

- **Q1**（D16）：开了 journal 的脚本重跑时，上游专家若命中回放，下游专家调用会被拒，只能整体 `noReplay`。v1 接受这个限制吗？还是要把「JournalEntry 记录 runId，fork 历史 session」提前到本任务（需要改 journal 格式：旧版本读到新条目会当成 corrupt，降级为 live）？
- 已定、无需再问：completed-only 只在 workflow 生效；严格校验不加开关；isolation 真隔离放到 #10。

## §评审修订记录（v1 → v2，评审人 gpt-sol）

| #   | 级别 | 问题                                       | 处置                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞 | D10 与用户确认冲突                         | 已统一为用户最终口径：D8 规定 workflow 只接受 completed 且有 sessionFile 的专家，通过 consult resolver 的 opt-in 选项 `completedOnly` 实现（§4.3）。顶层 Agent 行为不变，差异和理由写在 D8，「顶层也收紧」列为后续可选。删除了文末独立的「用户确认」节和旧的 Q2/Q3，内容并入正文（D8、D21、头部 #10 说明）。                                                                |
| 2   | 严重 | opts 严格校验不够严                        | D1-D6 与 §4.1、§4.5：普通对象按 realm 判定原型身份（沙箱与脚手架的 `Object.prototype` 或 `null`）；先用 `util.types.isProxy` 排除 Proxy；用 `Reflect.ownKeys` 加属性描述符读取，永不调用 getter，访问器和陷阱抛错都归为 invalid_args；`false`/`0`/`""` 不再被当成空对象；worker 先做快照、只发快照和结构报告，host 对收到的对象再做一遍同样的快照；报错文案只在 host 生成。 |
| 3   | 严重 | 回放安全：专家调用之后的链不能再算安全命中 | D12-D15 与 §5：chain-taint 的置位时机明确为「专家调用解析成功（被接纳）」，**被拒不置位**并给出理由。taint 之后的调用不读也不写 journal；content scope 同样受约束（D14）。已删除 v1 第 16 条「专家调用之后下游仍命中」。                                                                                                                                                    |
| 4   | 严重 | 三类情况对 occurrence/chain 的影响不清     | 新增 §5 契约表（invalid_args 不推进；experts_unresolved、max_children/BW2、解析成功都推进；taint 之后照常推进但判为 skip），列出性质 P1-P4。按 AGENTS.md 同步 RP 门矩阵（测试 21），新增带 seed 的属性测试（25），覆盖 caught-rejection（23）、专家状态变化与环境翻转（24、25）、重复 handle（18、25）、chain 与 content scope（22）。                                      |
| 5   | 一般 | 缺几个边界测试                             | 测试 15（completed 但无 sessionFile 或文件已删）、16（本地同名先失败后成功，D10 规则因此改为只在 completed 候选中选唯一）、24（两次运行之间外部换 run）、17（resolver 永远不会把本地失败或回放调用改写成 ref，有本地候选时不调用 resolver）。                                                                                                                               |
| 6   | 一般 | 成本结论不准确                             | D20 改为「正常完成路径恰好计入一次；consult 中途 abort 时 workflow 汇总和 `budget.spent()` 少计，全局 HUD 仍计入」，列为已知缺口，并给出 v2 补偿方案（后代 run 补计，同时把这些 id 放进 `runIds`，避免 HUD 重复计入）。测试 31 钉住当前行为。                                                                                                                               |
| 7   | 一般 | 父 abort 与 consult 准入同时发生时的时序   | 核实 spawn 准入是无 await 的同步段。D19 与 §4.7：`abort()` 在第一个 await 之前同步把父 run 放进 `stopping`；fork 请求要求父 run 仍在运行且不在停止中；signal 作为第二道保险。新增包 B，测试 27 用真实 SpawnService 覆盖 abort 前、同一 tick、finish 之后三种时序。                                                                                                          |
| 8   | 一般 | 测试矩阵不全                               | 测试 2-7（Symbol、不可枚举、原型链、getter 未被调用、Proxy 与陷阱、`false`/`0`/`""`）、14（completed-only）、21-25（chain-taint）、31（abort 少计）。                                                                                                                                                                                                                       |
| 9   | 建议 | experts 不该进 taskKey                     | 已采纳：TaskSemantics、taskKeyOf、JournalEntry 都不改（测试 26 用 golden 值证明 key 不变）；改为 `DecideReplayInput.experts`/`tainted` 的独立非回放标记（D15 说明了为什么不把标记混进 digest）。内容指纹、记录 runId 等更复杂的回放推迟到 v2（D16、Q1）。                                                                                                                   |

## 用户确认（v2）

- 同意按 v2 开工（复审无阻塞时）。
- Q1 上游专家命中回放、下游问不到：**v1 接受这个限制**——带 experts 的下游调用在专家未真跑时 reject，提示用 `noReplay: true` 整体重跑；journal 格式不变。

## 复审（v2，gpt-sol：有条件通过）遗留项——开发时必须落实

- **N1（严重）**：worker 快照阶段先判定可 clone / 合法形状；允许键上的 function、Symbol、不可 clone 值（含 `experts` 数组元素）只发 `defect`，绝不放进 snapshot values，否则 `postMessage` 抛 `DataCloneError` 被 `send()` 吞掉后白等 HR1，违反测试 #10。
- **N2**：已由用户确认（见上「用户确认（v2）」Q1：接受限制）。
- **N3（一般）**：`stopping` 标记为幂等集合；覆盖生产路径 `stopChildrenOf(workflowId) → abort(R)`、重复 abort、父 finish 与子 consult spawn 交错的测试；不能只测直接 `abort(R)`。当前 `abort()` 先 `await cascadeChildren`（src/service/spawn-service.ts:636-647），同步标记必须在任何 await 之前。
