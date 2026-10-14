# 外部 agent 执行后端（droid）架构设计（#22）

> 状态：架构 v1（2026-10-14）。输入：`requirements.md`（U1/U2/U3 已拍板，本文不推翻）、`droid-protocol.md` + `samples/`
> （P0 实测，下文 `S/xx` 指样本文件）、`explore-seams.md`（接缝坐标）。下游：Plan 细化 → 分包开发。
> 本文所有「推荐/默认」都可以被用户改；§14 列出必须由用户拍板的项。

---

## 0. 结论速览

| 问题       | 结论                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议       | **`droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`**，一 run 一进程；钉住 `factoryProtocolVersion=1.264.0` / `factoryApiVersion=1.0.0`，漂移默认 **fail closed**                     |
| 分派       | 新增 `RoutingSessionDriver`（按 `SessionSpec.external` 分派），在 `stack.ts` 替换 `new PiSessionDriver(...)`；runner / watchdog / reaper / 状态机主体不动                                                     |
| 运行时判定 | **由模型 provider 推出**（`droid/<id>`），不新增 `SpawnRequest.runtime` 字段 → 不碰 request-threading、不改 agent 类型 frontmatter                                                                            |
| 模块       | `src/external-agent/`（provider 无关、pi-free 框架）+ `src/external-agent/droid/`（适配器）；core 加纯数据契约                                                                                                |
| 权限       | 三档：`readonly-strict`（toolDomain readonly，无 Execute）/ `readonly`（U2 只读角色，autonomy `off`）/ `dev`（autonomy `medium`）；三档都用**工具白名单** + **反向权限请求一律 cancel** + **host 侧越界绊线** |
| transcript | 自写 **pi 会话条目兼容格式**的 jsonl（放 `~/.pi/agent/external-agent/droid/sessions/`，不在 pi 会话目录），作为 opaque `sessionFile`；web-hub 抽屉、resume、「full transcript」后缀零改动可用                 |
| 费用       | `costUsd` 默认 0（可配 `usdPerCredit` 换算），credits 单独进 `diag.external` 展示                                                                                                                             |
| 开关       | `externalAgents.droid.enabled` 默认 **false**；关闭时不装路由器、不探测、不写盘、提示词字节一致                                                                                                               |

---

## 1. 背景与目标

### 1.1 要解决的问题

让 `Agent` 工具与 workflow `agent()` 派出的子 agent 能由 Factory droid CLI 执行（用 droid 自己的订阅额度与工具链），
上层的超时 / 宽限 / 延长、watchdog、reaper、通知投递、agent 树、web-hub、worktree 隔离原样复用。后续 Codex、Claude Code
复用同一框架。

### 1.2 约束（不可违反）

- **U1** 虚拟 provider：`model: "droid/<droid model id>"`；droid 出现在系统提示「Available models」；spawn 准入认得它。
- **U2** 按角色分级权限：只读角色 / `toolDomain:"readonly"` → droid 只读档；开发类 → 能改文件跑命令、**不联网**档；没有真只读档时必须给替代方案，不得静默放开。
- **U3** 首版覆盖 Agent 工具 + workflow `agent()`（含 worktree 隔离、`timeout_s` 延长、resume）；依赖子会话加载 pi-toolkit 的能力一律**降级或明确拒绝并报清楚原因**。
- 零卡死：分层截止时间内必终止；进程组可整组杀；不留孤儿；所有计时器 `unref()`。
- 不在 `src/` 里做 `pi-subagent → pi-toolkit` 改名；设置沿用 `~/.pi/agent/pi-subagent.json`；`Symbol.for` 键沿用 `pi-subagent:` 前缀。
- 设置开关关闭时与现状**字节一致**。不打印 / 不持久化任何凭据（`FACTORY_API_KEY` 直接继承 pi 进程环境）。
- 402 / 鉴权失败 = 清楚的终态错误，不当普通模型失败重试。
- 真机一致性测试（`tests/conformance/` 模式）在 droid 升级时提前发现协议变化。

### 1.3 非目标（首版明确不做）

droid 作为嵌套 Agent 的父、droid 作为 consult 的 asker 或 expert、run 中途 `set_model`、droid 原生多 agent（`--mission`、
`Task`/`SpawnAgent`）、`acp` / `droid daemon` 协议、Factory credits 额度闸门（quota adapter，留扩展点）。

---

## 2. 现状摘要（接缝坐标，详见 explore-seams.md）

| 关注点            | 坐标                                                                                                                                                                          | 与本设计的关系                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 驱动契约          | `src/runtime/session-driver.ts:152-244`（`SessionHandle` / `SessionDriver`）；`DriverEvent` `src/core/types.ts:620-848`；`SessionSpec` `:1404-1462`；`KillableHandle` `:1465` | 外部驱动实现之；`SessionSpec` 加 `external`                          |
| 唯一调用方        | `RuntimeRunner.run()` `src/runtime/runner.ts:713` 起；prompt 守卫 `:1062`；错误归类 `:1073-1120`；`startError` `:323`（恒 `internal`）                                        | 两处小改：`startError` 认 `ClassifiedError`、优先 `getTurnErrorInfo` |
| 驱动构造          | `src/stack.ts:1923` `new PiSessionDriver(...)`                                                                                                                                | 换成路由器（仅 enabled 时）                                          |
| 适配器注入        | `src/service/runtime-adapter.ts:601` `run()`；customTools `:700-920`；toolScope `:1044-1105`；schema 二次校验 `:1167`                                                         | 外部 run 跳过全部注入与 toolScope；schema 改走文本提取               |
| spawn 准入        | `src/service/spawn-service.ts:565` 起；hint `:640-668`；`modelExists` `:670`；quota `:687`；resume `:763/:825`                                                                | 新增「外部 provider 准入」段（零副作用区）                           |
| 模型目录 / 提示词 | `src/config/available-models.ts`（`formatAvailableModelsForPrompt`，30 条上限）；`src/sysprompt/core-sections.ts:38`；`StackModelPort` `src/stack.ts:1851`                    | 追加独立的 external 子块                                             |
| hint 解析         | `src/config/model-hint.ts`（`parseStrictModelRef` / `resolveModelHint`）                                                                                                      | fuzzy hint 永不解析到 droid；严格 `droid/<id>` 直通                  |
| watchdog / 截止   | `src/core/deadline.ts:44-95`（`model_turn` = 静默 idle ∧ 硬顶 modelTurnMs；`tool_exec` = phaseEnteredAt+toolMs；`prompt_dispatch` = firstEventMs）                            | 事件映射必须驱动相位迁移                                             |
| 状态机            | `src/core/state-machine.ts:883-1010`（`tool_end` 未知 id ⇒ illegal；并行工具计数）                                                                                            | 驱动侧去重保证不触发 illegal                                         |
| reaper            | `src/runtime/reaper.ts:91-170`：**每次 reap（含正常完成）都走** L1 `steer("wrap up now")` → L2 `requestAbort()` → L3 `dispose()` → L3p 逐个 `killableHandles.kill()`          | idle 时 steer/abort 必须 no-op；kill 语义要与优雅关闭协调            |
| 用量              | `accumulateUsage` `state-machine.ts:46`；成本 NaN 钳位先例 `session-driver.ts:287`                                                                                            | 驱动侧保证有限数                                                     |
| transcript        | web-hub 终态读取 `src/web-hub/hub/run-file-reader.ts`（要求 `.jsonl`、从 `finalLeafId` 沿 `parentId` 反扫，`projectSessionEntry` 投影 `src/web-hub/protocol/keys.ts:124`）    | 自写兼容格式即可复用                                                 |
| 设置              | `src/config/settings.ts`（接口 `:600+`、默认 `:820+`、解析 `:1200+`）、`setting-specs.ts`（TUI 编辑器）                                                                       | 新增 `externalAgents` 组                                             |
| 测试替身          | `tests/runtime/runner-session-hooks.test.ts:50`；fake 进程范式 `tests/integration/fixtures/fake-rpc-pi.mjs`；conformance `tests/conformance/`                                 | 照抄                                                                 |

**P0 实测文档需更正的两点**（本设计据样本原文，而非 droid-protocol.md 的概括）：

1. **反向请求实际存在**：`S/31-jsonrpc-deny-off.jsonl` 第 22 行，autonomy `off` 下 droid 向客户端发了
   `{"type":"request","method":"droid.request_permission","id":"<uuid>","params":{"toolUses":[…],"options":[{value:"proceed_once"},{value:"proceed_always"},{value:"cancel"}]}}`；
   探针没应答，随后该工具被取消、整个 turn 以 `reason:"cancelled"` 结束。droid-protocol.md §2/§3「未观察到反向 request」不准确。
   → 客户端**必须应答**反向请求（§4.4），不能指望 droid 自行取消。
2. `add_user_message` 的 result 实测既有 `null`（S/15）也有 `{}`（S/27），驱动不得依赖 result 形状；它在 turn 结束**之前**就返回，turn 完成只能看通知。

---

## 3. 总体设计

### 3.1 模块划分

````
src/core/                       （纯领域，无 pi import）
  types.ts        + ExternalRunSpec / ExternalTier / ExternalRunMeta
                  + SessionSpec.external?  + DriverEvent {t:"external_meta"}  + RunDiagnostics.external?
  errors.ts       + ClassifiedError（携带 ErrorInfo 的 Error）
  tool-preview.ts ← previewToolArgs 从 runtime/session-driver.ts 挪来（session-driver 改为 re-export，字节不变）
  state-machine.ts + external_meta 分支（与 context_usage 同一「仅补 diag、任意状态接受」分支）

src/runtime/
  runner.ts       startError() 认 ClassifiedError；prompt 结算优先 handle.getTurnErrorInfo?.()
  session-driver.ts  SessionHandle 加可选 getTurnErrorInfo?()；re-export previewToolArgs

src/external-agent/             （provider 无关框架，pi-free：只 import core 与 runtime 的 *类型*）
  types.ts        ExternalAgentProvider / ExternalSessionHandle / ExternalCatalog / ExternalAgentsPort
  router.ts       RoutingSessionDriver implements SessionDriver
  process.ts      ManagedChild：detached 进程组、stdio、stderr 环形缓冲+脱敏、终止升级、进程级退出钩子
  jsonrpc.ts      NDJSON 行帧 + JSON-RPC 2.0 客户端（信封注入、id、超时、反向请求分派）
  transcript.ts   pi 条目兼容 transcript 写/读（头行、追加、截断、尾部 leaf 读取）
  policy.ts       角色 → ExternalTier（纯函数）
  prompt.ts       首条消息拼装的 provider 无关部分（角色提示、记忆、能力说明、schema 指令）
  schema-extract.ts  从最终文本提取 ```json 块（纯函数）
  catalog-store.ts   模型目录缓存（原子写 0600、TTL、二进制指纹）
  port.ts         createExternalAgentsPort(settings, providers) → 给 stack/service 用的门面

src/external-agent/droid/
  protocol.ts     版本常量、方法名、信封、通知/请求的结构守卫（手写，不引 zod）
  events.ts       纯映射器：DroidMapper（通知 → DriverEvent[]，含去重/turn 切分/用量增量）
  settings.ts     ExternalRunSpec + droid 设置 → initialize/update_session_settings 参数（autonomy、白名单、effort）
  errors.ts       error 通知 / reason → ErrorInfo 分类（402/401/403、usage exhausted、漂移）
  session.ts      DroidSessionHandle（实现 SessionHandle）
  provider.ts     DroidProvider（create/resume/ownsSessionFile/catalog probe）

接线（改动现有文件）
  src/stack.ts                    enabled 时构造 providers + RoutingSessionDriver + port；注入 adapter/spawn/prompt section
  src/service/spawn-service.ts    外部 provider 准入段；resume 跨运行时拒绝；外部 transcript 守卫（恒开）
  src/service/runtime-adapter.ts  external 计划、注入门控、schema 文本提取
  src/config/available-models.ts + src/sysprompt/core-sections.ts   external 子块
  src/config/settings.ts + setting-specs.ts                         externalAgents 组
  src/consult/index.ts            resolveExperts 拒绝外部 run
  src/tools/set-model-tool.ts     droid/* 明确拒绝
  src/tools/result-text.ts        formatExternal（diag.external 一行）
````

### 3.2 依赖方向

```
tools / commands / index.ts
        │
stack.ts ──────────────► external-agent/port.ts ─► external-agent/droid/provider.ts
   │                              │                        │
   ▼                              ▼                        ▼
service/(spawn-service, runtime-adapter) ──(ExternalAgentsPort 接口)   external-agent/{jsonrpc,process,transcript,...}
   │                                                       │
   ▼                                                       ▼
runtime/(runner, session-driver 类型) ◄──── external-agent/router.ts（实现 SessionDriver，持有 PiSessionDriver 实例）
   │
   ▼
core/（types, errors, state-machine, tool-preview）
```

- `src/external-agent/**` 不 import `@earendil-works/*`；对 `runtime/session-driver.ts` 只用 `import type`（运行期擦除）。
- service 层只依赖 `ExternalAgentsPort` 接口（定义在 `external-agent/types.ts`，纯类型），不依赖 droid 实现。
- `PiSessionDriver` 不知道外部驱动存在；路由器通过构造注入持有它。

### 3.3 运行时判定：为什么由模型推出

一个 run 是否走外部驱动，**唯一事实来源 = 已准入的模型 provider 是否被某个启用的外部 provider 认领**（`droid`）。

- 模型（`modelOverride` / 类型 `model:` / resume 继承）在 spawn-service 已定型并贯通到 adapter 的 `spec.model`，无需新字段。
- 否决「`SpawnRequest.runtime` + frontmatter `runtime:`」（explore-seams 推荐的方案）：U1 已拍板调用方式是虚拟 provider；
  再加 runtime 字段会出现 `runtime:pi` + `model:droid/x` 的矛盾组合，还要改 request-threading（Gate C）、`configHashInput`、
  Agent 工具 schema。模型字段已进 workflow taskKey / configHash，换运行时天然 miss 回放。

---

## 4. 接口契约

### 4.1 core 新增（纯数据）

````ts
// src/core/types.ts
export type ExternalTier = "readonly-strict" | "readonly" | "dev";

export interface ExternalContextBlock {
  kind: "memory" | "capabilities";
  text: string;
}

/** 外部 agent 执行一个 run 所需的全部 provider 无关输入。由 runtime-adapter 构造，驱动只读。 */
export interface ExternalRunSpec {
  provider: string;              // "droid"
  modelId: string;               // droid 内模型 id（不含 "droid/" 前缀）
  thinkingLevel?: string;        // pi 档位 off|low|medium|high，provider 自行映射
  tier: ExternalTier;
  roleName: string;              // agent 类型名（transcript 头 / 诊断）
  rolePrompt?: string;           // 仅 prompt_mode:replace 类型的系统提示；append 型已在 prompt 里
  contextBlocks: readonly ExternalContextBlock[];  // resume 时为空
  schema?: JsonSchema;           // 仅用于渲染「末尾输出 ```json」指令；校验仍在 adapter
  persistTranscript: boolean;    // = SessionSpec.persist ?? rememberAgents
  runId: string;
}

export interface SessionSpec {
  // …现有字段…
  /** 外部 agent run 的规格；存在即由 RoutingSessionDriver 交给对应 provider。pi 驱动永不读取。 */
  external?: ExternalRunSpec;
}

export interface ExternalRunMeta {
  provider: string;
  sessionId?: string;            // droid 会话 id
  tier?: ExternalTier;
  autonomy?: string;             // 实际生效的 autonomyLevel
  protocolVersion?: string;      // droid 回报的版本
  agentVersion?: string;         // droid 二进制版本（来自目录缓存）
  credits?: number;              // 本 run 累计 factoryCredits（单调不减）
  thinkingTokens?: number;
  degraded?: readonly string[];  // 本 run 生效的降级项（"nested_agent","message_agent","schema_text",…）
  policyDenials?: number;        // 被权限门取消的次数
  policyViolation?: string;      // host 绊线触发的工具名（fail closed）
  nativeSessionFile?: string;    // droid 自己的会话文件路径（调试用，不含凭据）
  unknownNotifications?: number; // 未识别通知计数（协议漂移早期信号）
}

// DriverEvent 联合新增
| { t: "external_meta"; meta: Partial<ExternalRunMeta> & { provider: string } }

// RunDiagnostics 新增
external?: ExternalRunMeta;      // 按字段 last-wins 合并（credits 取 max）
````

状态机：`external_meta` 走与 `context_usage` 相同的分支——任意状态（含终态 / stale generation）接受、只补 `diag.external`、
**不刷新 `lastEventAt` / `lastEventType`**（它是元数据，不是活性证据，不能替 watchdog 续命）。transition matrix / property 测试同步更新。

```ts
// src/core/errors.ts
export class ClassifiedError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
  }
}
export function classifiedInfo(e: unknown): ErrorInfo | undefined; // instanceof + 结构守卫（跨 realm 安全）
```

### 4.2 runtime 两处小改（冻结面）

```ts
// SessionHandle 新增可选方法
/** 带 kind/retryable 的 turn 错误；存在时优先于 getTurnError()。pi 驱动不实现。 */
getTurnErrorInfo?(): ErrorInfo | undefined;
```

- `runner.ts` `startError(e)`：`classifiedInfo(e)` 存在则用其 kind/retryable（message 仍按 `START_ERROR_MESSAGE_CAP` 截断），否则保持 `internal`。
  `prompt()` 自身 reject 的路径（`:1104` 附近）同样经 `startError`，因此外部驱动用 `ClassifiedError` reject 即可携带 kind。
- prompt 结算：`const turnInfo = prompted.ok ? handle.getTurnErrorInfo?.() : undefined;`——在 self-check 分支之后、`turnError` 字符串分支之前，
  `turnInfo` 存在则直接作为 `promptError`。pi 驱动不实现 ⇒ 行为不变。
- `startup_transient`+retryable 仍会被 runner 重试（`:858`），因此**只有**「进程起不来的瞬态错误」（`EAGAIN`/`EMFILE`）才用它；鉴权 / 配置 / 漂移一律不可重试。

### 4.3 external-agent 框架接口

```ts
// src/external-agent/types.ts
export interface ExternalSessionHandle extends SessionHandle {
  readonly provider: string;
  /** router.bind 委托；同步注册监听，之后的事件经 onEvent 推送。只可调用一次。 */
  attach(onEvent: (e: DriverEvent) => void): void;
}

export interface ExternalAgentProvider {
  readonly id: string; // "droid"
  ownsSessionFile(path: string): boolean; // 路径前缀 + 头行（有界同步读 ≤64KiB）
  create(spec: SessionSpec & { external: ExternalRunSpec }): Promise<ExternalSessionHandle>;
  resume(sessionFile: string, spec: SessionSpec & { external: ExternalRunSpec }): Promise<ExternalSessionHandle>;
  readonly catalog: ExternalCatalogPort;
  /** stack 重建时调用：停止目录探测（不杀运行中的 run——run 由 runner/reaper 管）。 */
  dispose(): void;
}

export interface ExternalModelInfo {
  id: string;
  displayName?: string;
  upstreamProvider?: string;
  kind?: string;
  tokenMultiplier?: number;
  reasoningEfforts: readonly string[];
  defaultEffort?: string;
  deprecated: boolean;
}
export interface ExternalCatalog {
  provider: string;
  fetchedAt: number;
  agentVersion?: string;
  protocolVersion?: string;
  binaryFingerprint?: string; // realpath+size+mtimeMs+ino
  models: readonly ExternalModelInfo[];
  drift?: { expected: string; actual: string }; // 探测时发现的协议漂移
}
export interface ExternalCatalogPort {
  snapshot(): ExternalCatalog | undefined; // 同步：内存 → 磁盘缓存；绝不 spawn
  refreshInBackground(reason: "stack_build" | "binary_changed" | "stale"): void; // single-flight、有界、unref
  observeInit(models: unknown, protocolVersion: string | undefined): void; // 每次 run 的 init 结果顺带刷新
}

/** service / stack 用的门面。stack 在 enabled 时构造；关闭时为 undefined（所有调用点按「端口缺席」走原路径）。 */
export interface ExternalAgentsPort {
  owns(provider: string): boolean;
  /** 三态：true 已知 / false 确定未知 / undefined 目录不可用（fail-open，交给 init 校验）。 */
  exists(ref: { provider: string; id: string }): boolean | undefined;
  /** 漂移（strict）或二进制缺失等「整体不可用」原因；有值即准入拒绝。 */
  unavailableReason(provider: string): string | undefined;
  unknownModelMessage(ref: { provider: string; id: string }): string; // 含 droid 候选建议
  advertised(): readonly { provider: string; id: string; name?: string; note?: string }[];
  ownerOfSessionFile(path: string): string | undefined; // provider id
  planRun(input: PlanRunInput): ExternalRunSpec; // 见 §4.6
  memoryBlock?(cwd: string): string | undefined; // 晚绑定，memory 关闭时缺席
}
```

### 4.4 进程与 JSON-RPC

**ManagedChild（`process.ts`）**

| 项         | 契约                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn      | `spawn(binary, ["exec","--input-format","stream-jsonrpc","--output-format","stream-jsonrpc"], { cwd, detached: true, stdio: ["pipe","pipe","pipe"], env: process.env })`。cwd 同时经 `initialize_session.cwd` 下发（RPC 模式下 CLI flag 失效，S/08.stderr）。`ENOENT` ⇒ `ClassifiedError{config,"droid binary not found: <binary> (externalAgents.droid.binary)"}`；`EAGAIN/EMFILE` ⇒ `startup_transient` retryable |
| unref      | `child.unref()`；stdin/stdout/stderr 的底层 socket 各 `.unref()`；内部所有 timer `unref()`。保证 `pi -p` 不被挂住                                                                                                                                                                                                                                                                                                   |
| 进程组     | droid 不自建组（实测 PGID==父），`detached:true` 让它成为组长；kill 一律 `process.kill(-pid, sig)`，`ESRCH` 视为已死。Execute 的孙进程在 `factory-execute-supervisor` 自己的组里、owner 死后 ~2s 自杀（实测），组杀负责 droid 拉起的其它子进程（如 MCP server）                                                                                                                                                     |
| stderr     | 64 KiB 环形缓冲；输出前脱敏：`process.env.FACTORY_API_KEY` 的精确值替换为 `***`，外加通用 `(api[_-]?key                                                                                                                                                                                                                                                                                                             | token | authorization)["'=: ]+\S+` 卫生规则（卫生措施，非安全边界）。只用于错误文本尾部（≤2 KiB），从不写 transcript |
| 进程级登记 | `Symbol.for("pi-subagent:external-agent-procs")` 全局 `Map<pid, ManagedChild>`；首次使用时安装**一次** `process.on("exit")`：对所有存活组同步 `SIGKILL`。跨 `/reload` 复用同一表（与 worktree-origin 先例一致的文档化进程全局）                                                                                                                                                                                     |
| 终止升级   | `terminate("graceful")`：`stdin.end()` + `SIGTERM` 组 + 安排 unref'd 计时器 `killGraceMs`（默认 2000）后 `SIGKILL` 组；`terminate("now")`：立即 `SIGKILL` 组。幂等；`exited` Promise 在 `exit` 事件 resolve                                                                                                                                                                                                         |
| 孤儿兜底   | pi 被 SIGKILL 时 exit 钩子不跑 → 依赖 droid 在 stdin EOF 时自退（**P0 待验 S3**）；若不成立，在 `process.ts` 用一个极小的 `sh -c` 哨兵（父进程死亡即 `kill -KILL -<pgid>`，同 droid supervisor 的 owner-watchdog 思路）包裹                                                                                                                                                                                         |

**JsonRpcClient（`jsonrpc.ts`，provider 无关；信封由 provider 注入）**

```ts
interface Envelope { decorate(msg: object): object; check(msg: Record<string, unknown>): EnvelopeVerdict }
interface JsonRpcClientOptions {
  envelope: Envelope;
  write(line: string): boolean;            // 返回 false ⇒ 背压，等 'drain'
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, id: string, params: unknown): RequestReply;  // 同步决定应答
  onProtocolError(e: ClassifiedError): void;  // 致命：provider 据此杀进程并 fail
  clock: Clock;
}
request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
```

- **请求 id**：字符串、每进程单调 `"1","2",…`（droid 要求字符串 id，缺即 `-32700`，S/09b）。
- **超时**：每请求独立 unref'd 计时器；控制类请求默认 `requestTimeoutMs`（15s）；`initialize_session` 用 `initTimeoutMs`（20s，外层还有 runner 的 `startupMs` 守卫）。超时 ⇒ reject `ClassifiedError{internal}` 并从挂起表删除；迟到响应丢弃并计数。
- **行帧**：stdout 按 `\n` 切；单行上限 8 MiB（超限 ⇒ 致命协议错误）；非 JSON 行忽略并计数，连续 ≥20 行或累计 ≥200 行 ⇒ 致命（stdout 被污染）。
- **入站分类**：有 `id` 且命中挂起表 ⇒ 响应；`type:"request"` 或「有 method + 有 id」⇒ 反向请求；有 method 无 id ⇒ 通知。`id:null` 的错误响应（`-32700`）⇒ 致命「信封被拒」（多半是协议漂移，见 §5.1）。
- **反向请求兜底**（绝不悬挂）：同步应答。
  - `droid.request_permission` ⇒ 应答「cancel」（`options` 里 `value:"cancel"` 那一项；**确切应答形状 P0 待验 S2**）。语义：任何需要额外授权的动作一律拒绝——权限边界只由「autonomy 档 + 白名单」决定，host 不做逐条放行。
  - 其它任何方法（`droid.ask_user`、未知方法）⇒ JSON-RPC error `-32601 "not supported by pi-toolkit host"`。
- **进程退出**：所有挂起请求 reject `ClassifiedError{internal,"droid exited (code/signal)…stderr tail"}`。
- **写失败**（`EPIPE`）⇒ 视同进程死亡。

### 4.5 RoutingSessionDriver（`router.ts`）

```ts
class RoutingSessionDriver implements SessionDriver {
  constructor(pi: SessionDriver, providers: ReadonlyMap<string, ExternalAgentProvider>);
  create(spec)  → spec.external ? provider(spec.external.provider).create(spec) : pi.create(spec)
  resume(file, spec) →
      owner = providers 中 ownsSessionFile(file) 的那个
      spec.external && owner === spec.external.provider   ⇒ owner.resume(file, spec)
      !spec.external && owner === undefined               ⇒ pi.resume(file, spec)
      其余（错配）                                        ⇒ throw ClassifiedError{config,"cannot resume a <x> session with a <y> model"}
  bind(h, onEvent) → isExternal(h) ? (h.attach(onEvent), Promise.resolve()) : pi.bind(h, onEvent)
  onLateArrival(p, cb) → p.then(cb, noop).catch(noop)   // 与 pi 一致；外部句柄 dispose 即 SIGKILL
  resolveModelRef(p, id) → providers.has(p) ? undefined : pi.resolveModelRef?.(p, id)
}
```

- 句柄识别：`WeakSet<ExternalSessionHandle>`（路由器 create/resume 时登记），不靠鸭子类型。
- 错配在 spawn 准入就已拦截（§4.7），路由器这一层是纵深防御。
- `resume` 在 provider 未启用时不存在 ⇒ spawn 准入的「外部 transcript 守卫」（恒开）负责不让 pi 驱动打开我们的 jsonl（§4.7 ⑤）。

### 4.6 runtime-adapter：外部计划与注入门控

`run()` 开头（deadline 复查之后）：

```ts
const ext = spec.model && deps.external?.owns(spec.model.provider)
  ? deps.external.planRun({
      model: spec.model, type: spec.type, request: spec.request,
      resume: spec.request.resumeFrom !== undefined, cwd: preH2Cwd,
      persist: <同 PiSessionDriver 的 persist 口径>,
    })
  : undefined;
```

`planRun` 产出 `ExternalRunSpec`：`tier = resolveTier(...)`（§6.1）；`rolePrompt` = replace 型类型的 `systemPrompt`；
`contextBlocks` = fresh 时 [memory 块（若有）, capabilities 块]，resume 时 `[]`；`schema` 透传。

`ext` 存在时 adapter 的行为：

| 项                                                                                                    | 处理                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| customTools（nested Agent / message_agent / consult / StructuredOutput / set_model / consult shadow） | **全部不构造**（不是构造了再丢）                                                                           |
| grantedReserved / switch_context grant / child bash grant / prefix probe                              | 不授予                                                                                                     |
| `toolScope`                                                                                           | 不放进 `ResolvedSpawnRequest`（runner 自然跳过 onBind/onTurnBoundary）                                     |
| `sessionSpec.systemPrompt`                                                                            | 移入 `ext.rolePrompt`，`sessionSpec` 不再带（避免两处语义）                                                |
| `sessionSpec.tools` / `thinkingLevel`                                                                 | 保留（仅诊断），驱动不读                                                                                   |
| prompt                                                                                                | 仍是 `appendPromptNotes(buildPrompt(spec), promptNotes)`（append 型前缀、worktree 提示照旧）               |
| H2/H3 扩展（worktree）                                                                                | 原样（运行时无关，H2 改 cwd ⇒ droid 在 worktree 里干活）                                                   |
| schema                                                                                                | 见 §7.1：run 结束后从 `outcome.text` 提取 → `structured.value`，再走**原有** `applyStructuredOutputPolicy` |
| `displayMeta.model`                                                                                   | `{provider:"droid", id}`（fleet / web-hub 照常显示）                                                       |
| journal 抑制（readonlyDomain）                                                                        | 不变                                                                                                       |

### 4.7 spawn-service：外部 provider 准入

新依赖 `external?: ExternalAgentsPort`。插在 hint 解析之后、`modelExists` 之前，仍在零副作用区：

```
① resume 目标预解析（纯读：resolveRun + 快照 diag.model / sessionFile），提前到模型准入前
② resume 目标是外部会话（owner = external.ownerOfSessionFile(file)）:
     modelOverride 未给            ⇒ admittedModel := 目标的 droid 模型（忽略类型默认模型：resume 不换运行时）
     modelOverride 是同 provider   ⇒ 用 override（resume 后经 update_session_settings 生效）
     modelOverride 是 pi 模型      ⇒ 拒绝 "run <id> was executed by droid; resume it with a droid/<id> model or omit model"
③ admittedModel.provider 被认领:
     unavailableReason            ⇒ 拒绝（漂移 strict / 二进制缺失），retryable:false
     exists === false             ⇒ 拒绝 unknownModelMessage（列 droid 候选）
     req.experts?.length          ⇒ 拒绝 "experts/consult is not supported for droid/* runs (external agents cannot load the consult tool)"
     req.forkSessionFrom          ⇒ 拒绝（纵深防御）
     resume 目标是 pi 会话        ⇒ 拒绝 "cannot resume a pi session with droid/*"
     跳过 registry modelExists；quota 闸门照常调用（无 droid adapter ⇒ 放行，留扩展点）
④ 其余（pi 模型）路径完全不变
⑤ 恒开守卫（不依赖 enabled）：resume 目标 sessionFile 位于 `<agentDir>/external-agent/` 下而 external 端口缺席
     ⇒ 拒绝 "run <id> was executed by an external agent (droid); enable externalAgents.droid.enabled to resume it"
     （纯路径前缀判断；关闭态下这种文件只可能来自以前开启过——对既有输入字节一致）
```

### 4.8 其它入口的小改

- **hint 解析**（`stack.ts` 的 `models.resolveHint` 包一层）：hint 若能 `parseStrictModelRef` 且 provider 被认领 ⇒ 直接返回该对（显式意图）；否则只在 pi 注册表里解析——**fuzzy hint 永不落到 droid**（`"haiku"` 不会悄悄换运行时）。覆盖 `goal.verifierModelHint`、类型 frontmatter 非严格写法。
- **consult**：`resolveExperts` 对 `diag.model.provider` 被认领或 `sessionFile` 归属外部的 run 返回拒绝原因 `expert <id> is a droid external-agent run; consult requires a pi session`；workflow `expert-scope.ts` 复用同一函数自然生效。
- **set_model 工具**：目标模型是 `droid/*` ⇒ `set_model cannot switch to an external-agent model`；目标 run 是 droid run ⇒ runner 因 `handle.setModel` 缺失返回 `unsupported`，工具文案改为点名「droid external-agent run; mid-run model switching is not supported」。
- **result-text**：`formatExternal(diag.external)` 一行：`droid · session <id8> · tier readonly(off) · 1.8k credits · denied 1`。

---

## 5. 关键决策

### 5.1 协议选型：stream-jsonrpc

| 方案                            | 结论    | 理由                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **exec + stream-jsonrpc（选）** | ✅      | 唯一同时具备：文本增量（`assistant_text_delta`，给 idle 判活）、steer（`add_user_message` 并入当前 turn，S/27）、协议内优雅中断（`interrupt_session` → `reason:"cancelled"` 完整终结事件）、`get_context_stats`、`update_session_settings`（解决 resume 设置覆盖坑）、可应答的反向权限请求 |
| exec + stream-json 单发         | ❌      | 只有完整消息、无增量（长回答期间无事件 ⇒ idle 误杀风险更大）；无 steer、无优雅中断（只能信号）；失败时无终结事件；resume 要另起 `-s` 进程                                                                                                                                                  |
| `--input-format stream-json`    | ❌ 禁用 | 实测 LLM 失败时静默（无 error、exit 0、不落盘）——直接违反零卡死/可观测                                                                                                                                                                                                                     |
| acp / `droid daemon`            | ❌      | 未实测；daemon 需 WebSocket + `daemon.authenticate`，复杂度与凭据面都更大                                                                                                                                                                                                                  |

**一 run 一进程**（否决长驻进程池）：冷启动 2–3s 相对子 agent 时长可忽略；一进程一会话让「杀进程 = 杀 run」成立，
reaper/killableHandles/孤儿登记语义直接对上；进程池要做会话复用、隔离、跨 run 故障传染处理，收益不抵复杂度。

**版本钉住与漂移**

- `droid/protocol.ts`：`DROID_PROTOCOL_VERSION = "1.264.0"`、`DROID_API_VERSION = "1.0.0"`、`DROID_TESTED_VERSIONS = ["0.241.1"]`（仅信息）。所有出站消息带这两个字段。
- 检测点：①目录探测（stack 构建时后台跑，§7.3）的 init 响应；②每个 run 的 init 响应；③运行中任一入站消息的 `factoryProtocolVersion`；④`id:null` 的 `-32700`（信封被拒）。
- `protocolCheck: "strict"`（默认）：①发现漂移 ⇒ 目录标 `drift`，提示词不列 droid 模型、spawn 准入 `unavailableReason` 直接拒绝（零副作用、不起进程）；②③④ ⇒ `ClassifiedError{config, retryable:false}`：
  `droid protocol drift: droid speaks factoryProtocolVersion <actual>, pi-toolkit is pinned to 1.264.0 (droid <ver>). Run the droid conformance suite (PI_TOOLKIT_DROID_CONFORMANCE=1 npm run test:conformance) and bump DROID_PROTOCOL_VERSION, or set externalAgents.droid.protocolCheck="warn".`
- `protocolCheck: "warn"`：进程内首次 `console.warn` 一次 + `diag.external.degraded` 加 `protocol_drift`，继续跑。
- 二进制升级感知：目录缓存记录 `binaryFingerprint`（realpath+size+mtimeMs+ino）；stack 构建时 `stat` 比对（同步、O(1)），变了 ⇒ 后台重探。
- 理由：droid 是自更新的黑盒，协议形状变化可能让事件映射**静默失真**（例如终结事件改名 ⇒ prompt 永不结束只能靠总预算杀），fail closed 比「看起来在跑」安全；`warn` 给用户逃生口。

### 5.2 权限：工具白名单为主、autonomy 为辅

否决「只靠 autonomy 档」：droid 工具全集 54+ 个（S/20 init），含 `SlackPostMessage`、`SpawnAgent`、`SendMessage`、`Script`、
`CreateAutomation`、`Task`、`ProposeMission` 等——外发、编排、自动化都在里面，`--auto medium` 下 28 个 allowed。
白名单让 droid 升级新增的工具**默认不可用**（fail closed），也把 droid 原生多 agent 与 pi-toolkit fleet 的语义重复一并切掉。
详见 §6。

### 5.3 transcript：自写 pi 条目兼容 jsonl

| 方案                                                                                               | 结论 | 理由                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **自写 `~/.pi/agent/external-agent/droid/sessions/<droidSessionId>.jsonl`，条目形状兼容 pi（选）** | ✅   | `sessionFile` 全程 opaque（statSync/resume 回传）；web-hub 终态 transcript（`run-file-reader` 沿 `parentId` 反扫 + `projectSessionEntry`）、`get_subagent_result` 的「full session transcript」后缀、`finalLeafId`、`peekRunBranch` **零改动**可用；头行即 resume 坐标 |
| 直接把 droid 自己的 `~/.factory/sessions/<slug>/<id>.jsonl` 当 sessionFile                         | ❌   | 格式不同（web-hub 投影全失败）；含 system-reminder 注入噪声；归属判定靠路径猜；且它与交互式 droid 共享，我们无权写                                                                                                                                                     |
| 写成真正的 pi 会话（放 pi 会话目录）                                                               | ❌   | 会出现在 session-history / `/resume-recent`，能被 `pi --session` 当 pi 会话打开——谎报运行时                                                                                                                                                                            |

格式（`transcript.ts`，与 pi 条目同形但头行类型不同）：

```jsonc
// 行 1：头（type 不是 pi 的 "session" ⇒ pi 加载器不会把它当会话；无 id/timestamp ⇒ projectSessionEntry 忽略）
{"type":"external_session","version":1,"provider":"droid","sessionId":"<droid id>","cwd":"/abs","modelId":"gpt-6-luna",
 "createdAt":"<ISO>","roleName":"general","runId":"<首个 runId>"}
// 之后每条：pi 条目形状
{"type":"message","id":"<16hex>","parentId":"<prev|null>","timestamp":"<ISO>","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
{"type":"message","id":"…","parentId":"…","timestamp":"…","message":{"role":"assistant","content":[{"type":"text","text":"…"},{"type":"toolCall","id":"call_…","name":"Execute","arguments":{…}}],"model":"droid/gpt-6-luna"}}
{"type":"message","id":"…","parentId":"…","timestamp":"…","message":{"role":"toolResult","toolCallId":"call_…","toolName":"Execute","content":[{"type":"text","text":"…"}],"isError":false}}
// resume：追加一条 custom 标记（web-hub 默认墓碑投影），parentId 接续文件尾的 leaf
{"type":"custom","id":"…","parentId":"…","timestamp":"…","customType":"subagent:external-resume","data":{"runId":"…","modelId":"…"}}
```

- 来源：droid 的 `create_message`（过滤 `visibility:"llm_only"` 与 `__internal__`/`context-` 前缀 id）+ `tool_result`（去重后）。
- 上限：单条 tool 参数 8 KiB、tool 结果 16 KiB（截断标注 `…[truncated N bytes]`）；单文件 32 MiB，超限后只追加一条 `custom` 截断标记并停止写正文（resume 仍可用，droid 自己有完整历史）。
- IO：目录 `0700`、文件 `0600`；`openSync(…,"a")` 持有 fd，`writeSync` 追加（与 pi 自己的同步会话写同量级）；写失败 ⇒ 关闭 transcript、`degraded:+transcript_write_failed`、**不影响 run**。
- `persist=false`（`rememberAgents:false`）：不建文件，`sessionFile=undefined`（与 pi 内存会话一致，不可 resume）；droid 仍会在 `~/.factory` 落自己的会话（无法关闭，文档化）。
- 句柄同时在内存保留同一条目链（同样的截断），供 `getLeafId()` / `getBranchEntries()`；`observe` 首版不实现（web-hub live tap 回落 snapshot，`observeRun` 返回 `no_session`，与「还在排队」的显示一致）。

### 5.4 其它取舍

- **costUsd 默认 0**（否决「不填」：`UsageDelta.costUsd` 必填且累加；否决「按 tokenMultiplier 估美元」：无 Factory 单价来源，估出来的数字比 0 更误导）。主要收益本就是订阅额度，边际美元成本≈0；`usdPerCredit` 可配；credits 另行展示。
- **memory 注入默认开**（否决不注入：droid 只读 AGENTS.md，不认识 `~/.pi/agent/memory/<slug>/`，而项目记忆里有「删除只用精确路径」「绝不 git add -A」这类硬规则，开发类 droid 恰恰最需要）。
- **系统提示走首条消息**（否决 `--append-system-prompt-file`：RPC 模式下 CLI flag 是否生效未验证，S9 验证通过后可作为增强切换，接口不变）。
- **schema 不做修复轮**（v1）：失败即 `failed(schema)`；修复轮（再发一条「只输出 ```json」）留扩展点（§14 Q8）。

---

## 6. 权限映射（U2）

### 6.1 角色 → 档位（`policy.ts`，纯函数）

```
resolveTier({ typeName, toolDomain }, settings):
  toolDomain === "readonly"                       ⇒ "readonly-strict"
  settings.typeTiers[typeName] 存在               ⇒ 该值（用户覆盖，可升可降）
  typeName ∈ settings.readonlyTypes               ⇒ "readonly"
  否则                                            ⇒ "dev"
readonlyTypes 默认 = ["verifier","reviewer","Explore","Plan","architect"]（U2 原文清单）
```

否决「从 frontmatter `tools:` 推导」：`architect` 带 `write`，推导会把它判成开发类，与 U2 冲突；且 `tools:` 是 pi 工具名，与 droid 无关。

### 6.2 档位 → droid 设置（`droid/settings.ts`）

| 档位              | autonomyLevel                        | 工具白名单（`allowTools`）                   | 依据                                                                                                                                                 |
| ----------------- | ------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readonly-strict` | `off`                                | `Read, LS, Glob, Grep`                       | pi 的 toolDomain readonly 本就是 read/grep/find/ls、无 bash；去掉 Execute 后只读保证不再依赖 droid 的命令分类器                                      |
| `readonly`        | `off`                                | 上 + `Execute, TodoWrite, ToolSearch, Skill` | `off` = droid 只读档（exec 默认档实测 14 个 allowed；写类 Execute 被判 medium 而拒绝，S/25、S/31）                                                   |
| `dev`             | `medium`（`devAutonomy` 可改 `low`） | 上 + `Edit, Create, ApplyPatch`              | `low` 允许 ApplyPatch 改文件但拒绝 medium 风险命令（`printf > f` 被拒，S/23），开发要跑构建/测试/提交 ⇒ `medium`；`high` 放开破坏性/不可逆命令，否决 |

- `allowWeb`（默认 false）为 true 时三档都追加 `WebSearch, FetchUrl`。
- 一律排除：`Task*`、`SpawnAgent`/`InterruptAgent`/`ListAgents`/`SendMessage`（与 fleet 重复）、`AskUser`（headless）、Slack/Eval/Automation/Mission/`Script`/`Loop`/`GenerateDroid`/`UpgradeSessionModel`/`StageSettingsChanges`、全部 `MCP:*`。
- 下发方式：`initialize_session` 带 `modelId/reasoningEffort/autonomyLevel`，随后**无条件**发 `droid.update_session_settings`（含白名单字段），
  并比对响应 / `settings_updated` 通知中的生效值；任一不符 ⇒ 杀进程、`ClassifiedError{config}` fail closed。
  白名单字段用 `restrictToolIds`（S/15 结果里出现该字段）还是 `enabledToolIds`/`disabledToolIds`，**P0 待验 S1**；
  若 droid 不支持白名单语义，回退为 `disabledToolIds = 目录工具全集 − allowTools`（全集取自 init/`get_context_breakdown`）。
- 同一路径解决 resume 的「会话持久化设置覆盖 init 参数」坑（droid-protocol §2）：resume 也是 init 后 update + 校验。

### 6.3 只读保证论证（回应 explore-seams「只读域一律拒绝」与 U2 的冲突，以 U2 为准）

四层，任何一层失效都 fail closed：

1. **工具面**（droid 侧）：白名单里没有 Edit/Create/ApplyPatch；`readonly-strict` 连 Execute 都没有 ⇒ 该档的只读是**工具级硬保证**，与 pi toolDomain readonly 同强度。
2. **权限门**（droid 侧）：autonomy `off` 下凡需授权的动作都会发 `request_permission`。
3. **host 应答**：host 对 `request_permission` 一律 `cancel`（§4.4）；droid 永远拿不到「proceed」。
4. **host 绊线**：映射器看到任何 `tool_call` 的工具名不在本 run 白名单 ⇒ 立刻 `interrupt_session` + `terminate("now")`，
   run 以 `failed{config,"external-agent tool policy violation: droid attempted <Tool> outside the <tier> whitelist (pi-toolkit stopped the run)"}` 结束、`diag.external.policyViolation` 记名。
   绊线存在的意义是**检测白名单被 droid 无视**（S1 退化 / 版本漂移）。注意它是检测不是阻止：`tool_call` 与执行之间存在竞态，所以第 1 层才是保证。

`readonly` 档（带 Execute）的残余：低风险命令由 droid 分类器放行，分类器是黑盒（S/26：`curl` 被判 low）。这与现状相比**不更弱**：
pi 里 `verifier/reviewer/Explore` 都带 `bash`，只读完全靠提示词自律；droid `off` 档至少还有分类器 + 拒绝门。
需要硬只读的入口（tidy）走的是 toolDomain readonly ⇒ `readonly-strict`。

### 6.4 网络边界（U2「不联网」）

结论：**droid 侧无法硬性断网**。①droid 自身必须联网访问 Factory 云端模型，进程级网络隔离不可行；②Execute 里的联网命令由黑盒分类器定级
（S/26 `curl` 判 low，连 `low` 档都放行）。设计做到：WebSearch/FetchUrl 默认不在白名单（关掉显式联网工具）+ 首条消息的能力说明里写明
「不得发起网络请求」+ 文档披露残余风险。这与现状等价（pi 的开发类子 agent 的 bash 同样无网控）。**需用户确认接受（§14 Q1）**。

### 6.5 越权失败的呈现与「策略拒绝续跑」

实测：`off` 档下被 cancel 的动作会让**整个 turn** 以 `reason:"cancelled"` 结束（S/31）。若不处理，只读角色第一次尝试跑
`npm test` 就整个 run 失败。设计：

- 判定「策略拒绝」：本 turn 内 host 应答过 `request_permission=cancel`，或出现 `tool_result` 文本 `Tool execution cancelled`/`insufficient permission`，且**不是**我们发起的 interrupt。
- 若 `policyRetries`（默认 2）未用完：在同一个 `prompt()` 内自动 `add_user_message`：
  `[pi-toolkit] The previous action (<Tool>: <command 摘要>) was denied by policy: this run uses the <tier> tier (droid autonomy <level>). Do not retry it; continue the task without it, or explain in your final answer what you could not do.`
  ——新 turn 开始，`prompt()` 继续等最终 `completed`。计数进 `diag.external.policyDenials`。
- 用尽 ⇒ `prompt()` resolve，`getTurnErrorInfo = {config, "droid run stopped: <n> actions were denied by the <tier> tier (autonomy <level>): <列表>. Use a pi model, or override externalAgents.droid.typeTiers.<type>."}`。
- 每次续跑都受 runner 总预算约束（不新增计时器语义）。

---

## 7. 降级矩阵（U3）

| 能力                                                 | 处置                                                                                                                                                                                                                                                                                                                            | 在哪一层                              | 呈现                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema` / StructuredOutput                          | **降级支持**：首条消息追加 schema 指令（「最终回答末尾输出且只输出一个 ``json 代码块，符合以下 JSON Schema」）；run `completed` 后 adapter 用 `extractStructuredJson(outcome.text)`（取最后一个 ``json 块；否则整段文本以 `{`/`[` 开头时整体解析）→ `structured.value` → 原 `applyStructuredOutputPolicy` + verdict/v1 语义校验 | runtime-adapter                       | 提取失败 ⇒ `failed{schema,"droid run did not end with a parseable \`\`\`json block (external agents have no StructuredOutput tool)"}`；校验失败沿用原文案；`degraded:+schema_text` |
| consult（asker：Agent/workflow 带 `experts`）        | 拒绝                                                                                                                                                                                                                                                                                                                            | spawn 准入 §4.7③                      | `experts/consult is not supported for droid/* runs …`                                                                                                                              |
| consult（droid run 当 expert，含 workflow 同 label） | 拒绝                                                                                                                                                                                                                                                                                                                            | `consult/index.ts` `resolveExperts`   | `expert <id> is a droid external-agent run; consult requires a pi session`                                                                                                         |
| `message_agent`（出站）                              | 降级：不注入；类型带 `can_message` ⇒ 能力说明块写明「无法给其它 agent 发消息，结论写进最终回答」，`degraded:+message_agent`                                                                                                                                                                                                     | adapter / planRun                     | result 行显示 degraded                                                                                                                                                             |
| 入站消息（@mention、fabric inject、steer_subagent）  | **支持**：都经 `handle.steer` ⇒ `add_user_message`，并入当前 turn 下一次模型调用（S/27）                                                                                                                                                                                                                                        | 驱动                                  | —                                                                                                                                                                                  |
| 嵌套 Agent（droid 为父）                             | 降级：不注入；类型带 `can_spawn` ⇒ 能力说明 + `degraded:+nested_agent`                                                                                                                                                                                                                                                          | adapter / planRun                     | 同上                                                                                                                                                                               |
| 嵌套 Agent（pi 父派 droid 子）                       | 支持（同一 spawn 准入）                                                                                                                                                                                                                                                                                                         | —                                     | —                                                                                                                                                                                  |
| `switch_context`                                     | 降级为 droid 自带压缩：`compacting_conversation` ⇒ `compaction_start/end`，compaction 预算生效                                                                                                                                                                                                                                  | 驱动映射                              | —                                                                                                                                                                                  |
| bash settle-hold / `bash_job`                        | 不适用：droid 无后台 job；Execute 长命令受 `toolMs` 约束（与 pi 前台 bash 相同）；`sealSession` 对外部 sessionId 返回 undefined（runner 已容忍）                                                                                                                                                                                | —                                     | —                                                                                                                                                                                  |
| cache keepalive / cache 统计 / provider evidence     | 不适用（droid 请求不经 pi provider）；无事件、无成本折算                                                                                                                                                                                                                                                                        | —                                     | —                                                                                                                                                                                  |
| memory 注入                                          | 降级：fresh run 时把 `memorySection` 当前渲染块（同一渲染器、同字节预算）作为 `memory` 上下文块拼进首条消息；resume 不重复；memory 工具不可用（子会话本就只读）                                                                                                                                                                 | planRun ← memory 晚绑定端口           | 关 `injectMemory` 或 `memory.enabled=false` ⇒ 不拼                                                                                                                                 |
| `set_model`（对 droid run / 切到 droid）             | 拒绝                                                                                                                                                                                                                                                                                                                            | set-model 工具 + runner `unsupported` | §4.8 文案                                                                                                                                                                          |
| `thinking`                                           | 映射到 `reasoningEffort`（§8.3）                                                                                                                                                                                                                                                                                                | droid/settings.ts                     | 实际 effort 回报为 `diag.thinking`                                                                                                                                                 |
| agent 类型系统提示                                   | append 型：已在 prompt 前缀（不变）；replace 型：`rolePrompt` 放首条消息最前，外包 `<agent-role>` 块，并附一句工具名对照（pi 的 read/bash/edit ≈ droid 的 Read/Execute/Edit·ApplyPatch）                                                                                                                                        | droid/session.ts 渲染                 | —                                                                                                                                                                                  |
| 类型 `tools:` / `max_turns`                          | 忽略（工具由档位决定；droid 无轮次上限，靠总预算）                                                                                                                                                                                                                                                                              | planRun                               | `degraded:+type_tools_ignored`（仅当类型声明了 tools）                                                                                                                             |
| `child_extension_missing`                            | 不适用：外部句柄永不置 `childExtensionMissing`（否则带 inputBudget 的 run 会被 runner 误判 failed）                                                                                                                                                                                                                             | 驱动                                  | —                                                                                                                                                                                  |
| `inputBudget`（tidy batch）                          | 降级：只有 runner 的字节估算 preflight（`measureInputBudget` 缺失时的兜底）；飞行中测量/中止不可用（droid 超窗会自行压缩）                                                                                                                                                                                                      | runner 既有兜底                       | `degraded:+input_budget_preflight_only`                                                                                                                                            |
| `toolDomain:"readonly"`                              | 支持（`readonly-strict`）                                                                                                                                                                                                                                                                                                       | §6                                    | —                                                                                                                                                                                  |
| worktree 隔离                                        | 支持（H2 改 cwd；H3 提交）                                                                                                                                                                                                                                                                                                      | 扩展原样                              | —                                                                                                                                                                                  |

能力说明块（`capabilities`，provider 无关文案，英文，只列本 run 相关项）示例：
`You are running as an external agent (Factory droid) on behalf of pi-toolkit. Unavailable here: messaging other agents, spawning sub-agents, consulting experts. Write every finding into your final answer. Do not make network requests.`（readonly 档追加「read-only: do not modify files or run state-changing commands」）。

---

## 8. 事件映射与终态

### 8.1 DroidMapper（`droid/events.ts`，纯、可回放样本）

内部状态：`inTurn`、`toolResultsSinceAssistant`、`pendingToolStart: Map<id, latestInput>`、`openTools: Set<id>`、
`endedTools: Set<id>`、`compacting`、`usageBaseline`、`reportedUsage`、`lastAssistantText`、`seenTurnIds`。

| droid 输入（`params.notification.type` 除非注明）                                      | DriverEvent（按序）                                                                                                                                   | 说明                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `droid_working_state_changed` → `thinking`/`streaming_assistant_message`，且 `!inTurn` | `turn_start`                                                                                                                                          | prompt 后 ~毫秒级必到（S/27），满足 `prompt_dispatch` 的 firstEvent                                                     |
| 同上，`inTurn` 且 `toolResultsSinceAssistant>0`（工具结果后开始新一次模型调用）        | `turn_end{toolResults:n}`, `turn_start`                                                                                                               | pi 的 turn = 一次 assistant 消息 + 其工具结果                                                                           |
| → `compacting_conversation`                                                            | `compaction_start{reason:"droid"}`                                                                                                                    | 进 compaction 相位，用 compactionMs                                                                                     |
| 离开 `compacting_conversation`                                                         | `compaction_end{aborted:false}`                                                                                                                       |                                                                                                                         |
| → `executing_tool` / `idle` / `waiting_for_tool_confirmation`                          | （无）                                                                                                                                                | idle 由 `agent_turn_completed` 处理；confirmation 由反向请求处理                                                        |
| `assistant_text_delta`                                                                 | `text_delta{delta:textDelta}`                                                                                                                         | 刷新 lastEventAt（idle 判活来源之一）                                                                                   |
| `create_message` role=assistant，可见                                                  | 若含非空 thinking 块：`thinking_delta`；然后 `message_end{usage:增量}`；对其中每个 `tool_use` 若未发过：`tool_start{toolCallId,toolName,argsPreview}` | `argsPreview` 用最终完整 input（`previewToolArgs`）；记录 `lastAssistantText` = 文本块拼接（非空才覆盖）                |
| `create_message` role=user / `llm_only` / `__internal__`·`context-` id                 | （无，仅 transcript；`llm_only` 连 transcript 也不写）                                                                                                |                                                                                                                         |
| `tool_call`（渐进流式，同 id 多次）                                                    | （无）仅更新 `pendingToolStart[id]`                                                                                                                   | 取最后一次 input                                                                                                        |
| `tool_execution_phase_changed`（queued/executing），id 尚未 start                      | `tool_start`（用当前最新 input）                                                                                                                      | 兜底：assistant 消息晚于执行开始时                                                                                      |
| `tool_progress_update`                                                                 | `tool_update{toolCallId}`                                                                                                                             | 只刷新 lastEventAt；`tool_exec` 截止仍是 toolMs（与 pi 一致）                                                           |
| `tool_result`，id ∉ endedTools                                                         | 若未 start 先补 `tool_start`；`tool_end{isError}`；`toolResultsSinceAssistant++`                                                                      | **按 toolUseId 去重**（interrupt 时重复两次、S/31 的「Batch cancelled」第二条均丢弃）；重复不发事件，避免状态机 illegal |
| `session_token_usage_changed`                                                          | （无）更新累计快照                                                                                                                                    | 增量在下一次 message_end 吐出                                                                                           |
| `agent_turn_completed`（每 turnId 一次）                                               | 为每个 open tool 补 `tool_end{isError:true}`；`inTurn` 则 `turn_end{toolResults:n}`；对账 `message_end{usage}`（若有正增量）；`settled`               | 然后交给 §8.4 判定                                                                                                      |
| `settings_updated` / `mcp_status_changed` / `session_title_updated`                    | （无）                                                                                                                                                | settings 用于 §6.2 校验                                                                                                 |
| `error`                                                                                | （无事件）记录到 `pendingErrors`                                                                                                                      | 分类见 §8.4                                                                                                             |
| 未知通知类型                                                                           | （无）`unknownNotifications++`                                                                                                                        | 前向兼容；计数随 external_meta 上报                                                                                     |
| 反向请求 `request_permission`                                                          | （无事件）host 应答 cancel，记一次 denial                                                                                                             | §6.5                                                                                                                    |
| bind 时 / credits 变化（节流 ≥5s）/ denial / violation                                 | `external_meta{…}`                                                                                                                                    | 不刷新活性                                                                                                              |

`context_usage`：每次 `message_end` 或 `turn_end` 后发 `droid.get_context_stats`（single-flight、节流 15s、超时 3s、失败静默且连败 3 次停用），
映射 `{tokens:used, contextWindow:limit, percent:round(used/limit*100,1)}`（`accuracy:"estimated"` 不另标）。

### 8.2 watchdog 不误杀的论证

| 相位                 | 截止                                                          | 活性来源                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_create`     | startupMs（30s）                                              | create() 内：spawn + init + update 设置，实测冷启动 2–3s                                                                                                                                                                                 |
| `prompt_dispatch`    | firstEventMs                                                  | `add_user_message` 后立即有 `working_state` ⇒ `turn_start`                                                                                                                                                                               |
| `model_turn`         | `min(lastEventAt+idleMs, phaseEnteredAt+modelTurnMs)`         | `text_delta`、`message_end`、`tool_update`、`turn_*`；**droid 在长 thinking 期间可能无事件**（无 thinking 增量，只有结束时的 `thinking_text_complete`）——不合成心跳（合成心跳会让真卡死的 provider 调用永不被 idle 抓到）；风险见 §14 R4 |
| `tool_exec`          | phaseEnteredAt+toolMs                                         | 不依赖心跳（与 pi 相同）；`tool_update` 仅更新显示                                                                                                                                                                                       |
| `compaction`         | compactionMs                                                  | `compaction_start/end`                                                                                                                                                                                                                   |
| 总预算 / 宽限 / 延长 | runner 活 deadline（`guardUntil` 跟随 `effectiveDeadlineAt`） | 运行时无关                                                                                                                                                                                                                               |
| 进程意外退出         | —                                                             | 立即 settle `prompt()`（不等 idle）                                                                                                                                                                                                      |

### 8.3 thinking → reasoningEffort

`map(level, model.reasoningEfforts, model.defaultEffort)`：

- `undefined` ⇒ 发 `defaultEffort`（目录已知时；否则不发，交给 droid 默认）。
- `off` ⇒ 依次取 `off` / `none` / `minimal` 中第一个受支持的；都不支持 ⇒ 最低档。
- `low|medium|high` ⇒ 受支持则原样；否则按序 `[none,off,minimal,low,medium,high,xhigh,max]` 取最近的受支持档（同距取低）。
- `getThinkingLevel()` 返回 droid 实际生效 effort（来自 settings 校验），写入 `diag.thinking`（只展示）。

### 8.4 终态判定（`prompt()` + `getTurnErrorInfo()`）

退出码一律不作判据（droid-protocol §10）。

| 条件                                                                                                            | `prompt()`                                                                                                                              | `getTurnErrorInfo()`                                                                                                              | run 终态                                                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `agent_turn_completed reason:completed`，无待处理 error                                                         | resolve                                                                                                                                 | —                                                                                                                                 | `completed`，text = `lastAssistantText`                   |
| `cancelled`，且我们发起过 interrupt/abort                                                                       | resolve                                                                                                                                 | —                                                                                                                                 | runner 按 stopCause/timeoutReason ⇒ `aborted`/`timed_out` |
| `cancelled`，策略拒绝，`policyRetries` 有余                                                                     | 不 resolve，自动续跑（§6.5）                                                                                                            | —                                                                                                                                 | —                                                         |
| `cancelled`，策略拒绝，用尽                                                                                     | resolve                                                                                                                                 | `{config, retryable:false, …denied…}`                                                                                             | `failed`                                                  |
| `cancelled`，其它原因                                                                                           | resolve                                                                                                                                 | `{model, "droid cancelled the turn unexpectedly"}`                                                                                | `failed`                                                  |
| `error` 通知文本匹配 HTTP 401/402/403（`/\b40[123]\b/` 或 `"status":40[123]`），随后任何 `agent_turn_completed` | resolve                                                                                                                                 | `{auth, retryable:false}`（文案见下）                                                                                             | `failed`                                                  |
| `reason:model_usage_exhausted`（无可分类 error）                                                                | resolve                                                                                                                                 | `{auth, retryable:false, "droid reports model usage exhausted (Factory subscription/credits) — not a model error, do not retry"}` | `failed`                                                  |
| 其它 `error` 通知 + 任意完成                                                                                    | resolve                                                                                                                                 | `{model, retryable: /\b429\b/.test ? true : false, <脱敏错误>}`                                                                   | `failed`                                                  |
| 进程在 turn 完成前退出                                                                                          | 我们发起过 abort ⇒ resolve；否则 reject `ClassifiedError{internal,"droid exited unexpectedly (code X / signal Y); stderr: <脱敏尾部>"}` | —                                                                                                                                 | `aborted` / `failed`                                      |
| 协议致命错误（漂移、stdout 污染、超长行、白名单绊线）                                                           | 杀进程后 reject / resolve+info                                                                                                          | `{config}` 或 `{internal}`                                                                                                        | `failed`                                                  |

鉴权文案（英文，进 run 错误，模型与用户可见）：
`droid authentication/subscription failure (HTTP 402: Organization does not have an active paid subscription). This is not a model error — do not retry. Check FACTORY_API_KEY in pi's environment (~/.factory/env.sh is only sourced by new shells; restart pi after updating it).`
（括号内取 droid 原始 `detail`，脱敏；`requestId` 保留便于排查。）

---

## 9. DroidSessionHandle 方法契约（`droid/session.ts`）

| 方法                                                                                       | 实现                                                                                                                                                                                                                                                                                                                                         | 缺失 / 降级时调用方行为            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `sessionId`                                                                                | droid 会话 id（init 结果）                                                                                                                                                                                                                                                                                                                   | —                                  |
| `sessionFile`                                                                              | transcript 路径；persist=false 时 `undefined`                                                                                                                                                                                                                                                                                                | —                                  |
| `prompt(text)`                                                                             | 首次调用拼首条消息（rolePrompt → contextBlocks → schema 指令 → text）；记录用量基线；`add_user_message`；返回在 §8.4 结算的 Promise。内部所有 Promise 挂 noop catch，绝不产生 unhandled rejection                                                                                                                                            | —                                  |
| `steer(text)`                                                                              | 仅当 `inTurn` 且进程活着：`add_user_message`（`requestTimeoutMs` 有界）；否则**立即 resolve 不发送**（reaper 每次都调 L1 `steer("wrap up now")`——idle 时若真发会开启新 turn）                                                                                                                                                                | —                                  |
| `requestAbort()`                                                                           | `inTurn`：标记 `abortRequested` → `interrupt_session` → 等 `agent_turn_completed` 至 `interruptWaitMs`（默认 min(abortGraceMs−1s, 5s)）→ 未到则 `terminate("graceful")`；idle / 已死：立即 resolve                                                                                                                                           | reaper L2 有 abortGraceMs 外层上界 |
| `dispose()`                                                                                | **同步、幂等**：关 transcript fd、退订、清计时器；进程活且 idle ⇒ `terminate("graceful")`（stdin EOF + SIGTERM 组，idle 时实测 exit 0 干净退出）；进程活且在 turn 中 ⇒ `terminate("now")`；返回 `{returned:true, killed: 已发信号?1:0, unkillable:[]}`（`process.kill` 抛非 ESRCH 错误 ⇒ unkillable 记 `{kind:"process",id:"droid:<pid>"}`） | —                                  |
| `killableHandles`                                                                          | 恰一个 `{kind:"process", id:"droid:<pid>", kill}`：已退出 ⇒ no-op；优雅终止进行中且未超 `killGraceMs` ⇒ no-op（升级计时器负责，避免在 droid 落盘设置时 SIGKILL）；否则 `SIGKILL` 组。**这是全仓库 `killableHandles` 的首个生产者**                                                                                                           | reaper L3p 每次都调                |
| `setActiveTools` / `getActiveTools`                                                        | no-op / 返回本 run 白名单（droid 名）                                                                                                                                                                                                                                                                                                        | toolScope 对外部 run 不启用        |
| `getLastAssistantText()`                                                                   | `lastAssistantText`                                                                                                                                                                                                                                                                                                                          | —                                  |
| `getTurnErrorInfo()`                                                                       | §8.4                                                                                                                                                                                                                                                                                                                                         | 新增可选方法                       |
| `getTurnError()`                                                                           | `getTurnErrorInfo()?.message`                                                                                                                                                                                                                                                                                                                | 兼容                               |
| `getUsage()`                                                                               | 本 run 累计 `UsageDelta`                                                                                                                                                                                                                                                                                                                     | —                                  |
| `getModelRef()`                                                                            | `{provider:"droid", id: 生效 modelId}`                                                                                                                                                                                                                                                                                                       | —                                  |
| `getThinkingLevel()`                                                                       | 生效 effort                                                                                                                                                                                                                                                                                                                                  | —                                  |
| `setModel` / `setThinkingLevel`                                                            | **不实现**                                                                                                                                                                                                                                                                                                                                   | runner `unsupported`               |
| `getLeafId()` / `getBranchEntries()`                                                       | transcript 内存链                                                                                                                                                                                                                                                                                                                            | 缺失则 `leaf_unknown`              |
| `observe`                                                                                  | 不实现（v1）                                                                                                                                                                                                                                                                                                                                 | `observeRun` → `no_session`        |
| `measureInputBudget`                                                                       | 不实现                                                                                                                                                                                                                                                                                                                                       | runner 字节估算兜底                |
| `getToolSources` / `getSwitchTail` / `consultIdentityPrediction` / `childExtensionMissing` | 不实现 / 永不置位                                                                                                                                                                                                                                                                                                                            | 既有降级                           |

**用量**（`UsageDelta`，全部有限数，NaN/负数钳 0）：

- 增量来源：`session_token_usage_changed.tokenUsage` 相对基线的差；基线 = `add_user_message` 发出时最近一次累计快照（fresh 会话首个 prompt 基线为 0；**resume 会话首个 prompt 若尚无快照则本 turn 不发实时增量**，只在完成时对账——避免把历史用量记进本 run；基线行为 P0 待验 S10）。
- 对账：`agent_turn_completed.tokenUsage`（turn 级权威值）− 本 turn 已报 ⇒ 若 >0 补一条 `message_end`。保证「完成时总量 == droid turn 用量」（高估时只能钳 0，记 `degraded:+usage_overcount`）。
- 字段：`input=inputTokens`、`output=outputTokens`、`cacheRead=cacheReadTokens`、`cacheWrite=cacheCreationTokens`、`costUsd=credits×usdPerCredit`；`thinkingTokens`、`factoryCredits` 进 `external_meta`。

---

## 10. 虚拟 provider（U1）各层

| 层                             | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Available models 提示词        | `formatAvailableModelsForPrompt(models, external?)`：external 为空/缺省 ⇒ 输出**逐字节不变**（golden 测试锁定）；非空 ⇒ 在原列表后追加独立子块（独立上限 `advertiseMax`，不占 pi 的 30 条）：<br>`### External agent models (droid)`<br>`` `droid/<id>` runs the subagent as a Factory droid CLI process, not a pi session: no consult/experts, message_agent, nested Agent or set_model; schema answers are parsed from a final ```json block; read-only agent types run in droid's read-only mode. Any droid model id is accepted. `` 后接 `- droid/<id> — <displayName> (×<multiplier>)` 列表与 `… +N more`。走 sysprompt hub 的 stable 快照 + 尾部更新机制（目录变化 = 一次尾部更新），不新增 hook |
| 列哪些                         | `models` 设置（id 列表）显式给出则只列它们；否则自动：非 deprecated、`kind!=="router"`、非 `custom:`，按 droid 原序取前 `advertiseMax`（默认 12）。准入接受目录里**任意** id（不限于展示的）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 目录来源                       | `catalog-store`：`<agentDir>/cache/external-agent/droid-catalog.json`（0600 原子写、上限 256 KiB）。刷新：stack 构建时若缺失 / 超 `catalogTtlS`（24h）/ 二进制指纹变化 ⇒ 后台探测（单飞、20s 有界、unref、失败静默保留旧缓存）；每个 run 的 init 结果顺带 `observeInit`（零额外成本）。探测 = 起 droid RPC → `initialize_session`（cwd 固定为 `<agentDir>/cache/external-agent/probe-cwd`，把可能产生的空会话归到一个 slug 下，P0 待验 S4）→ 读 `availableModels` → `close_session` → `terminate`。**否决 `droid exec --help` 文本解析**（无结构、易碎）                                                                                                                                               |
| droid 未安装 / 关闭            | 关闭：端口缺席，提示词无子块、`droid/x` 走原 unknown-model 错误（字节一致）。开启但二进制缺失：`unavailableReason` = binary not found ⇒ 子块不出现、准入明确拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| spawn 准入                     | §4.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `withResolvedModel`            | 外部 spec 由路由器交给 provider，永不进入 `PiSessionDriver.withResolvedModel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| quota 闸门                     | 照常调用；无 `droid` adapter ⇒ 放行。「droid 一个池」= 未来 `src/quota/` 新增 provider adapter（Factory credits），不在首版                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| workflow `parseStrictModelRef` | `agent({model:"droid/x"})` 严格对 ⇒ spawn 准入 ⇒ 未知 id 以 dispatch-failure reject（带 droid 候选）；model 进 taskKey，换运行时 miss 回放                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 类型默认模型                   | frontmatter `model: droid/<id>` 严格对 ⇒ `config.model` ⇒ 同一路径；`configHashInput` 已含 model，无需改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| thinking                       | §8.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `set_model`                    | §4.8 拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 11. 各入口可用性与改动

| 入口                                                              | 可用性                                     | 必要改动                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 顶层 Agent（background）                                          | ✅                                         | 无（准入 + adapter 之后天然可用）                                                                            |
| `timeout_s` / 宽限 / `extend_subagent_timeout` / `abort_subagent` | ✅                                         | 无（runner 状态机 + cancel；外部 run 只需 abort/kill 可靠）                                                  |
| resume                                                            | ✅                                         | §4.7②、§9；cwd 取头行 cwd（若仍存在）否则当前 spec.cwd（worktree 被清理后的 resume 能否找到会话 P0 待验 S7） |
| steer_subagent / @mention / fabric inject                         | ✅（turn 进行中）                          | 无                                                                                                           |
| worktree 隔离（Agent 与 workflow）                                | ✅                                         | 无；droid 是否往 cwd 写额外文件（如 `.factory/`）P0 待验 S13，若写则 H3 提交前需忽略规则                     |
| workflow `agent()` + FIFO 排队 + isolation + replay               | ✅                                         | 无（固定 deadline、占 slot、taskKey 含 model）                                                               |
| workflow `agent({experts})`                                       | ❌ 拒绝                                    | §4.7③                                                                                                        |
| 嵌套 Agent（pi 父 → droid 子）                                    | ✅                                         | 无                                                                                                           |
| `/goal` verifier（schema verdict/v1）                             | ✅ 降级                                    | `verifierModelHint` 写 `droid/<id>`（严格对经 §4.8 hint 包装放行）；schema 走文本提取                        |
| `/mem tidy`（toolDomain readonly + schema + inputBudget）         | ✅ 降级                                    | `readonly-strict`；inputBudget 仅 preflight                                                                  |
| consult                                                           | ❌ 双向拒绝                                | §4.8                                                                                                         |
| RPC spawn / cron / `/task`                                        | ✅                                         | 无（运行时无关）                                                                                             |
| 并发上限                                                          | 共享全局 `concurrencyLimit` + sysload 闸门 | 无；单个 droid 进程 RSS 较大（二进制 292MB），见 R7                                                          |

---

## 12. 设置项

`~/.pi/agent/pi-subagent.json`：

```jsonc
"externalAgents": {
  "droid": {
    "enabled": false,                 // 非 live（session_start 重建生效）
    "binary": "droid",                // 非 live；PATH 查找或绝对路径
    "protocolCheck": "strict",        // "strict" | "warn"；非 live
    "models": [],                     // 提示词展示的 id 列表；空 = 自动
    "advertiseMax": 12,
    "readonlyTypes": ["verifier","reviewer","Explore","Plan","architect"],
    "typeTiers": {},                  // { "<type>": "readonly-strict"|"readonly"|"dev" }
    "devAutonomy": "medium",          // "low" | "medium"
    "allowWeb": false,
    "policyRetries": 2,               // 0 = 首次策略拒绝即失败
    "injectMemory": true,
    "usdPerCredit": 0,                // ≥0 有限数；0 ⇒ costUsd 恒 0
    "catalogTtlS": 86400,
    "requestTimeoutS": 15,
    "initTimeoutS": 20,
    "killGraceS": 2
  }
}
```

- live 与否：`enabled/binary/protocolCheck` 在 stack 构建时读；其余在每次 spawn/planRun 时现读（与 `resultMaxChars` 等既有惯例一致）。
- 解析：未知键忽略；非法值逐项回退默认（照 `settings.ts` 既有 `parse*` 风格）；`typeTiers` 值域外的条目丢弃并 WARN。
- **默认 `enabled:false` 的理由**：需要本机装 droid + 有效订阅凭据；默认开会改变所有用户的系统提示（Available models）并在每次 session_start 起探测进程。用户本机手动打开。
- **关闭时字节一致保证**：不构造路由器（stack 直接 `new PiSessionDriver`）、不建端口（spawn/adapter/consult/set_model/提示词全部走「端口缺席」原路径）、不安装进程登记与 exit 钩子、不探测不写盘、`external_meta` 永不产生；唯一恒开的是 §4.7⑤ 的路径前缀守卫（只对 `<agentDir>/external-agent/` 下的文件生效，关闭态从未产生此类文件）。由 golden（提示词）+ 端口缺席单测锁定。
- TUI 设置编辑器（`setting-specs.ts`）：首版只暴露 `enabled`、`devAutonomy`、`allowWeb`、`injectMemory`；其余手改文件。

---

## 13. 测试策略

### 13.1 单元（`tests/external-agent/**`，全部纯函数或本地进程）

| 文件                                   | 覆盖                                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonrpc.test.ts`                      | 信封注入；字符串 id 单调；超时 reject 且清表；迟到响应丢弃计数；`id:null -32700` ⇒ 致命；反向请求同步应答（permission=cancel、未知=-32601）；行帧（跨 chunk、超长行、非 JSON 计数阈值）；EPIPE                                                       |
| `droid-events.test.ts`                 | **样本回放**：S/27（问答、STORED、steer、interrupt 重复 tool_result）、S/30（resume 写入）、S/31（permission + Batch cancelled 去重）、S/10（402 → model_usage_exhausted）；断言 DriverEvent 序列满足状态机前置条件（喂给真 reducer 不产生 illegal） |
| `droid-terminal.test.ts`               | §8.4 全表；策略拒绝续跑计数与用尽文案；鉴权分类正则                                                                                                                                                                                                  |
| `droid-usage.test.ts`                  | 基线/增量/对账；resume 无基线；NaN/负数钳位；credits×usdPerCredit                                                                                                                                                                                    |
| `droid-settings.test.ts`               | 档位 → autonomy/白名单；allowWeb；effort 映射全表；update 校验不符 ⇒ fail closed                                                                                                                                                                     |
| `policy.test.ts`                       | resolveTier 优先级                                                                                                                                                                                                                                   |
| `schema-extract.test.ts`               | 末尾 json 块、多块取最后、整段 JSON、无块、坏 JSON                                                                                                                                                                                                   |
| `transcript.test.ts`                   | 头行、条目形状经 `projectSessionEntry` 可投影、截断、32MiB 上限、resume 接续 leaf、写失败降级、0600/0700                                                                                                                                             |
| `router.test.ts`                       | create/resume/bind 分派、错配拒绝、WeakSet 识别、resolveModelRef 对外部 provider 返回 undefined                                                                                                                                                      |
| `catalog-store.test.ts`                | TTL、指纹变化、原子写、损坏文件回退、漂移标记                                                                                                                                                                                                        |
| `available-models.test.ts`（扩展现有） | external 缺省时 golden 逐字节不变；子块上限与文案                                                                                                                                                                                                    |
| `spawn-service-external.test.ts`       | §4.7 每条拒绝都零副作用（无 runId/label/锁）；resume 继承模型；恒开守卫                                                                                                                                                                              |
| `runtime-adapter-external.test.ts`     | 外部 run 不构造任何 customTools、不带 toolScope、systemPrompt 移入 rolePrompt、schema 提取接原策略                                                                                                                                                   |
| `state-machine` matrix/property        | `external_meta` 任意状态接受、不刷新 lastEventAt                                                                                                                                                                                                     |
| runner 两处小改                        | `ClassifiedError` kind 透传与截断；`getTurnErrorInfo` 优先级；pi 驱动行为不变                                                                                                                                                                        |

### 13.2 fake droid 集成（`tests/external-agent/fixtures/fake-droid.mjs`，照 `fake-rpc-pi.mjs` 模式）

真进程、真进程组、真计时。脚本化模式（argv/env 选择）：`--script <jsonl>`（收到 `add_user_message` 后按样本回放通知，支持 `{"delayMs":…}` 指令）、
`hang-after-init`、`no-first-event`、`crash-mid-turn`、`ignore-interrupt`、`ignore-sigterm`、`drift`（回报其它 protocolVersion）、
`envelope-reject`、`permission-request`、`stdout-garbage`、`spawn-grandchild`（拉一个 `sleep 300` 子进程，验证组杀后无残留）、
`slow-init`、`stdin-eof-exit`。

`tests/integration/external-droid-chain.test.ts`：真 `SpawnService + runtime-adapter + RuntimeRunner + RoutingSessionDriver + DroidProvider(binary=fake)`，
小预算真时钟。断言：完成 / 鉴权失败 / no_first_event / idle / total + 宽限 + 延长 / abort（interrupt 路径与 ignore-interrupt 的信号路径）/
reap 后进程组全灭且无孙进程 / late arrival（init 超时后迟到）被 disposeLate SIGKILL / resume 链 / worktree H2 cwd 到达 fake 的 init 参数 /
schema 提取 / `pi -p` 式进程退出时 exit 钩子清场（子进程测试）。

### 13.3 真机一致性（`tests/conformance/droid-protocol.test.ts`）

- opt-in：`PI_TOOLKIT_DROID_CONFORMANCE=1` 且 `droid` 在 PATH 且环境有 `FACTORY_API_KEY`，否则整体 skip（CI 不跑）。
- 最便宜模型 `gpt-6-luna`，effort `low`；全套积分预算断言（累计 credits ≤ 30k，超即失败停止后续用例）。
- 测试 HOME 已被 `tests/setup/sandbox-home.ts` 沙箱化 ⇒ droid 会话写进沙箱，不污染用户 `~/.factory/sessions`（凭据走环境变量，不依赖 `~/.factory`）。
- 用例（升级 droid 前必跑，失败即说明需要改代码/bump 版本）：
  D1 init 信封与 `factoryProtocolVersion == DROID_PROTOCOL_VERSION`；D2 问答事件序列可被 DroidMapper 映射且终结；D3 Execute 工具 start/end；
  D4 steer 并入；D5 interrupt → cancelled + 去重；D6 白名单生效（请求调用不在白名单的工具 ⇒ 不出现该工具的执行）；D7 `off` 档写文件被拒且出现 `request_permission`、cancel 应答形状被接受；
  D8 `medium` 档构建类命令（`npm test` 类）放行情况记录（只记录不断言，供 U2 复核）；D9 resume 记忆 + update 设置覆盖；D10 `get_context_stats` 形状；
  D11 stdin EOF ⇒ 进程 ≤5s 退出；D12 无效 modelId 的错误形状；D13 cwd 下无额外文件。
- P0 待验项（S1–S13，见 §14）由一次性 spike 脚本先行确认并补进 `droid-protocol.md` 与 `samples/`，再固化为上述用例。

### 13.4 typecheck 盲区

`npm run typecheck` 只覆盖 `src/**`（`tsconfig.json`）+ 单个 `tests/web-hub/contract/types.test-d.ts`；**测试文件整体不过类型检查**（vitest 只剥类型）。
fake 句柄与真实 `SessionHandle` 契约漂移不会被发现。措施：①新增测试里的 fake 句柄一律 `satisfies SessionHandle` / `satisfies ExternalSessionHandle`；
②把 `tests/external-agent/**/*.ts` 加进 `tsconfig.typecheck.json` 的 `include`（只纳入新目录，不扩大到既有测试，避免一次性引爆）；
③`fake-droid.mjs` 是纯 JS，靠集成测试覆盖。

---

## 14. 风险与开放问题

### 14.1 需用户拍板（每项附推荐）

| #   | 问题                                                                                    | 推荐                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | dev 档无法硬性断网（droid 必须联网；分类器把 `curl` 判 low）                            | **接受尽力而为**：关 WebSearch/FetchUrl + 提示词约束 + 文档披露；与 pi 子 agent 现状等价                                                                         |
| Q2  | `verifier` 按 U2 走只读档，可能跑不了 `npm test`（medium 风险会被 cancel，D8 实测确认） | 默认保持 U2；若 D8 证实被拒，允许 `typeTiers.verifier:"dev"` 覆盖，并在 dev-flow 里建议验收继续用 pi 模型                                                        |
| Q3  | `architect` 按 U2 走只读档写不了架构文档                                                | 默认保持 U2，droid architect 把文档全文作为最终回答由派发方落盘；需要直接写盘时 `typeTiers.architect:"dev"`（或 `devAutonomy:"low"` 级别的专用档，作为后续扩展） |
| Q4  | `enabled` 默认值                                                                        | **false**（理由 §12）；你本机手动开                                                                                                                              |
| Q5  | 协议漂移默认 strict（droid 自更新后所有 droid run 立即被拒，直到 bump）                 | **strict** + `protocolCheck:"warn"` 逃生口                                                                                                                       |
| Q6  | 费用口径                                                                                | `costUsd=0` + 单独显示 credits；需要时配 `usdPerCredit`                                                                                                          |
| Q7  | 是否把 pi 项目记忆拼进 droid 首条消息                                                   | **开**（`injectMemory:true`）                                                                                                                                    |
| Q8  | schema 提取失败是否自动给一次修复轮                                                     | v1 **不做**，留扩展点；/goal verifier 若失败率高再加                                                                                                             |
| Q9  | 策略拒绝续跑（§6.5）默认 2 次                                                           | **2**；设 0 即首次拒绝失败                                                                                                                                       |

### 14.2 技术风险

| #   | 风险                                                                 | 缓解                                                                                                        |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| R1  | 白名单字段语义未验证（S1）                                           | P0 spike；回退 `disabledToolIds`；host 绊线 fail closed                                                     |
| R2  | `request_permission` 应答形状未验证（S2）；未应答时 droid 是否会等待 | P0 spike；应答失败时 droid 若挂起，由 idle/total 兜底，且绊线/超时后 SIGKILL                                |
| R3  | pi 被 SIGKILL 时 droid 孤儿（exit 钩子不跑）                         | S3 验证 stdin EOF 自退；不成立则加 sh 哨兵（§4.4）                                                          |
| R4  | 长 thinking 无事件被 idle（默认 240s）误杀                           | 不合成心跳；conformance 用高 effort 测最长静默；必要时为 droid run 设专属 idle 覆盖（后续设置项，不在首版） |
| R5  | droid 自更新 ⇒ 协议漂移                                              | strict 早拒 + 二进制指纹重探 + conformance；能否禁用自更新（S12）待查                                       |
| R6  | resume 会话找不到（cwd 变、worktree 已删）（S7）                     | 头行 cwd 优先；失败映射为清楚的 config 错误                                                                 |
| R7  | droid 进程内存大，10 并发可能数 GB                                   | 共享 concurrencyLimit + sysload 闸门；后续可加 `maxConcurrent`                                              |
| R8  | 用量基线假设（S10）不成立 ⇒ 实时值偏差                               | 完成时对账到 turn 权威值；偏差只影响运行中显示                                                              |
| R9  | 首条消息里的角色提示可被模型视为普通用户文本，遵从度低于系统提示     | S9 验证 `--append-system-prompt-file` 在 RPC 下是否生效，生效则切换（接口不变）                             |
| R10 | droid 读取用户全局 skills / AGENTS.md / MCP 配置，行为受本机环境影响 | MCP/Skill 外的工具已白名单化；文档披露；conformance 在沙箱 HOME 下跑                                        |
| R11 | 目录探测可能在 `~/.factory/sessions` 留空会话（S4）                  | 固定 probe cwd 归档；不成立则改为「仅靠 run init 顺带刷新 + 首次显式 `/agent` 触发」                        |

### 14.3 P0 spike 清单（开发前一次性完成，结果回写 droid-protocol.md）

S1 白名单字段语义（init / update 是否接受、模型是否真看不到其它工具）· S2 `request_permission` 应答形状与超时行为 · S3 stdin EOF 退出 ·
S4 init 不发消息是否落会话文件 · S5 无效 modelId 在 init/update 的错误形状 · S6 发送旧 protocolVersion 时 droid 的反应 · S7 换 cwd resume ·
S8 `npm test`/`tsc`/`git commit`/`npm install` 在 off/low/medium 的分类 · S9 RPC 下 `--append-system-prompt-file` · S10 turn 开始时的用量事件基线 ·
S11 高 effort 下 thinking 文本是否出现在 `create_message` · S12 自更新机制与禁用方式 · S13 cwd 下是否产生额外文件。

---

## 15. 实施分包建议

| 包                   | 文件域                                                                                                                                                                                                                                                                                                               | 依赖                                      | 冻结面 / 共享接口                                                                                                                                                                                              | 可并行                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **P0 spike**         | `docs/dev/external-agent/droid-protocol.md`、`samples/`、一次性脚本（不进 src）                                                                                                                                                                                                                                      | —                                         | 产出 S1–S13 事实                                                                                                                                                                                               | 与 P1 并行                                                    |
| **P1 契约**          | `src/core/types.ts`、`src/core/errors.ts`、`src/core/tool-preview.ts`（挪 `previewToolArgs`）、`src/core/state-machine.ts`（external_meta）、`src/runtime/session-driver.ts`（`getTurnErrorInfo?` + re-export）、`src/runtime/runner.ts`（两处）、`src/external-agent/types.ts`（全部接口）+ 对应 matrix/runner 测试 | —                                         | **冻结**：`ExternalRunSpec`、`ExternalRunMeta`、`DriverEvent.external_meta`、`ClassifiedError`、`getTurnErrorInfo`、`ExternalAgentProvider`/`ExternalSessionHandle`/`ExternalCatalogPort`/`ExternalAgentsPort` | 先行；小包                                                    |
| **P2 框架**          | `src/external-agent/{router,process,jsonrpc,transcript,policy,prompt,schema-extract,catalog-store}.ts` + `tests/external-agent/` 对应单测                                                                                                                                                                            | P1                                        | transcript 条目格式（§5.3）为冻结面                                                                                                                                                                            | 与 P3、P4 并行                                                |
| **P3 droid 适配器**  | `src/external-agent/droid/**` + `tests/external-agent/droid-*.test.ts` + `fixtures/fake-droid.mjs`                                                                                                                                                                                                                   | P1；用 P2 接口（实现未就绪时以接口 mock） | 映射表 §8.1、终态表 §8.4                                                                                                                                                                                       | 与 P2、P4 并行；S1/S2 结论落地前白名单字段/应答形状用常量隔离 |
| **P4a 装配与提示词** | `src/config/settings.ts`、`src/config/setting-specs.ts`、`src/config/available-models.ts`、`src/sysprompt/core-sections.ts`、`src/external-agent/port.ts`、`src/stack.ts`                                                                                                                                            | P1                                        | 设置形状（§12）、提示词子块文案                                                                                                                                                                                | 与 P4b 并行（`stack.ts` 只由 P4a 改）                         |
| **P4b 服务层门控**   | `src/service/spawn-service.ts`、`src/service/runtime-adapter.ts`、`src/consult/index.ts`、`src/tools/set-model-tool.ts`、`src/tools/result-text.ts` + 对应测试                                                                                                                                                       | P1（只依赖 `ExternalAgentsPort` 接口）    | 拒绝文案（§4.7/§4.8/§7）                                                                                                                                                                                       | 与 P4a 并行                                                   |
| **P5 集成与一致性**  | `tests/integration/external-droid-chain.test.ts`、`tests/conformance/droid-protocol.test.ts`、`tsconfig.typecheck.json`                                                                                                                                                                                              | P2、P3、P4                                | —                                                                                                                                                                                                              | 最后                                                          |
| **P6 文档**          | `AGENTS.md`（`src/external-agent/` 条目）、`skills/dev-flow`（droid 模型路由与 Q2/Q3 建议）、本目录 `plan.md`                                                                                                                                                                                                        | P4                                        | —                                                                                                                                                                                                              | 与 P5 并行                                                    |

关键提示：

- P1 是唯一的共享冻结面，务必先合；其后 P2/P3/P4a/P4b 文件域互不重叠，可同消息并行派发。
- 状态机改动（external_meta）必须同步更新 transition matrix / property 测试（AGENTS.md 硬要求）。
- 所有新计时器 `unref()`；所有 `process.kill` 包 try/catch 并区分 `ESRCH`；`dispose()` 内不得 await。
- 绝不在日志、transcript、错误文本里出现环境变量值；stderr 仅以脱敏尾部进入错误文本。
- `Symbol.for` 键、log 前缀沿用 `pi-subagent:` / `[pi-subagent]`。
