# 外部 agent 执行后端（droid）实施方案（#22）

> 状态：**plan r2**（2026-10-14，消化 `review-r1.md` 与 `droid-protocol.md` §13 S1–S13 实测；修订记录见 §13）。
> 输入优先级：`requirements.md`（**以第二轮拍板 U2′/U4/U5/U6 为准**）→ `arch.md` → `droid-protocol.md`（含 §13）+ `samples/`
> → `explore-seams.md`。本文与 arch.md 冲突处一律以本文（= requirements + spike 实测）为准，冲突清单见 §0.2。
> 下文 `arch §x` 指 arch.md 章节，`S/xx` 指样本，`Sn` 指 spike 项（droid-protocol §13），`En` 指方案新增、spike 未覆盖、
> **由 P5 conformance 固化**的事实项（汇总见 §9）。
>
> 开发者必读：仓库根 `AGENTS.md`（零卡死不变量、设置开关、`pi-subagent` 命名不改、unref 计时器、测试门禁）。

---

## 0. 结论速览

### 0.1 一句话方案

`model:"droid/<id>"` ⇒ spawn 准入认领 ⇒ runtime-adapter 产出 `SessionSpec.external`（纯数据，含已定价表与记忆块）⇒
`RoutingSessionDriver` 交给 `DroidProvider` ⇒ 一 run 一个 `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
进程（`autonomyLevel:"high"`、`autoRejectPermissionRequests:false`，反向权限请求同步批准）⇒ 通知流映射成 `DriverEvent`、用量按
底层模型 pi 价格算 `costUsd` ⇒ runner / watchdog / reaper / 状态机 / 投递 / fleet / web-hub 原样复用。开关
`externalAgents.droid.enabled` 默认 `false`，关闭时与现状字节一致。

### 0.2 相对 arch.md 的修订

| arch 条目                                                                                            | 本方案                                                                                                                      | 依据                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| §6 三档 `ExternalTier`、`policy.ts`、角色→档位、`readonlyTypes`/`typeTiers`/`devAutonomy`/`allowWeb` | **全部删除**。所有角色一律 `autonomyLevel:"high"`，不下发工具白名单                                                         | U2′；S8 实测 high 下 `npm test`/`git commit`/`npm install`/`rm -rf` 全部免确认 |
| §6.5 策略拒绝续跑、`policyRetries`、§6.3④ 越界绊线、`policyDenials`/`policyViolation`                | **删除**                                                                                                                    | U2′                                                                            |
| §4.4 `request_permission` ⇒ cancel                                                                   | **显式 `autoRejectPermissionRequests:false` + 同步应答 `{selectedOption:"proceed_once"}`**，应答失败/无回执有界致命（§4.3） | U2′；S2                                                                        |
| `toolDomain:"readonly"` ⇒ `readonly-strict` 档                                                       | **spawn 准入直接拒绝路由到 droid**（§1）                                                                                    | U2′ 例外条款                                                                   |
| §5.4 `costUsd` 默认 0 / `usdPerCredit`                                                               | **删除**。usage × 底层模型 pi 价自算；匹配不到 ⇒ `unpriced`（`UsageDelta.unpriced`，不显示 `$0`）                           | U4，§3                                                                         |
| §11 resume cwd「头行 cwd 若仍存在否则 spec.cwd」                                                     | **一律钉头行 cwd；不存在 ⇒ config 拒绝，禁止回落**                                                                          | S7 实测换 cwd 会静默分叉会话                                                   |
| §4.4 ManagedChild `env: process.env`                                                                 | `process.env` 之上叠加 `extraEnv`，注入 `DISABLE_AUTO_UPDATE=1` 等                                                          | S12（运行中自更新 = 协议漂移）                                                 |
| §5.4 系统提示走首条消息 / S9 后可切 `--append-system-prompt-file`                                    | S9 已证实生效，v1 **仍走首条消息**（理由 §4.8）                                                                             | S9                                                                             |
| §7 能力说明块「read-only / 不得联网」                                                                | 删除；只保留「不可用能力」说明                                                                                              | U2′                                                                            |
| Q4/Q5/Q7/Q8                                                                                          | enabled 默认 false；漂移 strict + `protocolCheck:"warn"`；注入记忆；schema 失败不做修复轮                                   | U5/U6                                                                          |
| §4.3 provider 内部直接 import 框架实现                                                               | 改为**工厂注入**（`ExternalFrameworkDeps`）；`renderFirstMessage`/`extractStructuredJson` 上提 P1                           | 分包可并行（review #1）                                                        |
| §15 P4a 含 `stack.ts`/`port.ts`                                                                      | 装配（`port.ts`/`stack.ts`/`index.ts`）挪到 P5                                                                              | 分包需要                                                                       |

### 0.3 不变的 arch 结论（直接沿用，开发时读 arch 对应节）

协议选型与一 run 一进程（arch §5.1）、`RoutingSessionDriver`（§4.5）、ManagedChild 进程组/stderr 脱敏/进程级登记/终止升级
（§4.4，去掉 cancel 语义）、JSON-RPC 帧与超时（§4.4）、自写 pi 条目兼容 transcript（§5.3）、事件映射主体（§8.1，去掉策略行，
按 §4.9 补 thinking 流）、watchdog 论证（§8.2）、thinking→effort（§8.3）、句柄方法契约（§9，去掉白名单）、虚拟 provider 各层
（§10，去掉 tier 文案）、各入口可用性（§11，tidy 改为拒绝、resume 改为钉 cwd）。

---

## 1. 裁定：`toolDomain:"readonly"` ⇒ **拒绝路由到 droid**（不做工具白名单）

| 方案                         | 结论     | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **拒绝（选）**               | ✅       | ①只读保证**零依赖**：不起进程、不依赖任何 droid 行为；②U2′ 明确 v1 删除白名单机制，为单个程序内部入口保留「白名单下发（S1：`restrictToolIds` 只在 `update_session_settings` 生效、init 里写了被回显却不生效）+ `droid.list_tools` 校验 + 失败处理」整套代码不划算；③`toolDomain:"readonly"` 的唯一生产者是 `/mem tidy`，它还依赖 `inputBudget` 飞行中测量与 `memory.tidy.batch` 成本上限——droid 上前者只能 preflight、后者遇 `unpriced` 被绕过；④零副作用准入，文案明确 |
| 工具白名单 Read/LS/Glob/Grep | ❌（v1） | S1 已证实 `restrictToolIds`（经 update）是硬白名单且模型看不到其余工具，**技术上可行**，留作 v2 选项（届时：update 下发 + `list_tools.currentlyAllowed` 严格比对，不符 fail closed）                                                                                                                                                                                                                                                                                    |

文案：`MSG_READONLY_DOMAIN`（§2.11）=
`toolDomain:"readonly" runs cannot use droid/* models: external agents run with full permissions in this version, so pi-toolkit cannot guarantee read-only execution. Use a pi model for this run.`

---

## 2. 冻结面（P1 先合入；后续包只能消费，不得改签名）

> 规则：P1 合入后，§2 的类型 / 函数签名 / 设置形状 / 文案常量 / 两个纯函数实现即冻结。后续包发现必须改，先停下回报调度方，由
> P1 负责人改并广播。r2 起 §2 **无任何「由 P1 定」的未决项**。

### 2.1 `src/core/types.ts`（纯数据，无 pi import）

````ts
// —— 外部 agent：定价 ——
/** USD per 1M tokens（与 pi ModelCost 同口径）。 */
export interface ExternalPriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface ExternalPriceTier extends ExternalPriceRates {
  /** 与 pi ModelCostTier 同义：单次请求 input 总量超过此值时整次请求用该档。 */
  inputTokensAbove: number;
}
export interface ExternalPriceTable extends ExternalPriceRates {
  tiers?: readonly ExternalPriceTier[];
}
/** 价格从哪来：override=用户覆盖；upstream=droid 标注的上游 provider 的官方条目；family=按模型家族前缀推断的厂商条目；
 *  consensus=无规范 provider 时多个注册表条目价格一致。 */
export type ExternalPricingBasis = "override" | "upstream" | "family" | "consensus";
export type ExternalUnpricedReason =
  | "no_match"
  | "ambiguous"
  | "zero_price"
  | "router_model"
  | "override_unpriced"
  | "invalid_override"
  | "registry_unavailable";
export type ExternalPricing =
  | {
      status: "priced";
      source: string; // "anthropic/claude-opus-5-5" | "settings"
      basis: ExternalPricingBasis;
      /** basis ∈ {family, consensus} ⇒ true：近似价（如 factory 自托管模型按厂商 API 牌价）。 */
      approx: boolean;
      table: ExternalPriceTable;
    }
  | { status: "unpriced"; reason: ExternalUnpricedReason; detail?: string };

// —— 外部 agent：run 规格（adapter 构造，驱动只读） ——
export interface ExternalContextBlock {
  kind: "memory" | "capabilities";
  text: string;
}
export interface ExternalRunSpec {
  provider: string; // "droid"
  modelId: string; // droid 内模型 id（无 "droid/" 前缀）
  thinkingLevel?: string; // pi 档位；provider 自行映射到 reasoningEffort
  roleName: string; // agent 类型名
  rolePrompt?: string; // 仅 prompt_mode:replace 类型的 systemPrompt
  contextBlocks: readonly ExternalContextBlock[]; // fresh: [memory?, capabilities]；resume: []
  schema?: JsonSchema; // 仅用于渲染「末尾输出 ```json」指令
  persistTranscript: boolean; // = PiSessionDriver 的 persist 口径
  runId: string;
  pricing: ExternalPricing; // planRun 时快照；run 生命周期内不变
  degraded: readonly string[]; // planRun 决定的降级项（§4.8）
}

// —— 外部 agent：诊断 ——
export interface ExternalPricingDiag {
  status: "priced" | "unpriced" | "partial"; // partial = 部分用量无法定价（droid 原生子 agent 用量）
  source?: string;
  basis?: ExternalPricingBasis;
  approx?: true;
  reason?: string; // ExternalUnpricedReason 或 "child_usage"
  detail?: string;
}
export interface ExternalRunMeta {
  provider: string;
  sessionId?: string;
  autonomy?: string; // droid settings echo 的实际 autonomyLevel
  protocolVersion?: string;
  agentVersion?: string;
  credits?: number; // 本 run 累计 factoryCredits（单调）
  thinkingTokens?: number;
  childTokens?: number; // droid 原生子 agent 的 token（不计价）
  pricing?: ExternalPricingDiag;
  permissionApprovals?: number; // 已同步批准的 request_permission 次数
  degraded?: readonly string[];
  nativeSessionFile?: string;
  unknownNotifications?: number;
}
export type ExternalMetaPatch = Partial<ExternalRunMeta> & { provider: string };

// —— 既有类型的加法改动 ——
export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** U4：本增量/累计里有无法定价的部分。"all"=全部无法定价（costUsd 恒 0）；"partial"=costUsd 只含可定价部分。
   *  pi 驱动永不设置 ⇒ pi run 的 usage 永无此键。 */
  unpriced?: "all" | "partial";
}
// DriverEvent 联合新增：  | { t: "external_meta"; meta: ExternalMetaPatch }
// RunDiagnostics 新增：   external?: ExternalRunMeta;
// SessionSpec 新增：      /** 存在即由 RoutingSessionDriver 交给外部 provider；PiSessionDriver 永不读取。 */ external?: ExternalRunSpec;
````

### 2.2 `src/core/external-meta.ts`（新建，纯函数）

```ts
export const EXTERNAL_DEGRADED_CAP = 16;
/** reducer 用：字段 last-wins；credits/thinkingTokens/childTokens/permissionApprovals/unknownNotifications 取 max；
 *  degraded 并集（保序去重、上限 16）；pricing 只升不降：priced < partial < unpriced（status 取较差者，其余字段随之）。 */
export function mergeExternalMeta(prev: ExternalRunMeta | undefined, patch: ExternalMetaPatch): ExternalRunMeta;
/** accumulateUsage 用：prev 为 undefined（首个增量）⇒ 取 delta 的；两者相同 ⇒ 不变；否则 ⇒ "partial"；
 *  两者都无 ⇒ undefined。 */
export function mergeUnpriced(prev: UsageDelta | undefined, delta: UsageDelta): UsageDelta["unpriced"];
```

### 2.3 `src/core/errors.ts`

```ts
/** 携带 ErrorInfo 的 Error：外部驱动在 create()/resume()/prompt() reject 时用它把 kind/retryable 带给 runner。 */
export class ClassifiedError extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo); // super(info.message); this.name = "ClassifiedError"
}
/** instanceof 或结构守卫（name==="ClassifiedError" 且 info.kind/message/retryable 形状合法），跨 realm 安全。 */
export function classifiedInfo(e: unknown): ErrorInfo | undefined;
```

### 2.4 `src/core/tool-preview.ts`（新建）

把 `previewToolArgs(args: unknown, max = 80): string | undefined` 从 `src/runtime/session-driver.ts:297` **原样搬入**；
`session-driver.ts` 改为 `export { previewToolArgs } from "../core/tool-preview.js";`（行为字节不变，既有测试不改）。

### 2.5 `src/core/state-machine.ts`

- `accumulateUsage(prev, delta)`：现有字段累加之后，`const u = mergeUnpriced(prev, delta); ...(u === undefined ? {} : { unpriced: u })`。
  **pi 增量永不带该键 ⇒ diag.usage 字节不变**。
- 新分支 `session_event` 且 `event.t === "external_meta"`：与 `context_usage` 同族——任意状态（含终态、stale generation）接受，
  只做 `diag.external = mergeExternalMeta(diag.external, event.meta)`；**不刷新 `lastEventAt`/`lastEventType`**。
- `tests/core/core.test.ts` 的 executable transition matrix 与 seeded property 同步加 `external_meta`（AGENTS.md 硬要求）。

### 2.6 `src/core/run-journal.ts`

`JOURNAL_DIAG_FIELDS` 追加 `"external"`。`usage` 已在白名单，`unpriced` 随之持久化。

### 2.7 `src/runtime/session-driver.ts` 与 `src/runtime/runner.ts`

```ts
// SessionHandle 新增可选方法：
/** 带 kind/retryable 的 turn 错误；存在且返回值时优先于 getTurnError()。PiSessionHandle 不实现。 */
getTurnErrorInfo?(): ErrorInfo | undefined;
```

runner 两处：

1. `startError(e)`（`runner.ts:323`）：`const info = classifiedInfo(e); if (info) return { kind: info.kind, retryable: info.retryable, message: cap(info.message) };`
   否则保持 `internal`。`cap` = 现有 `START_ERROR_MESSAGE_CAP` 截断。`startup_transient`+retryable 会被 reducer
   `state-machine.ts:858` 按 `startupRetries` 重试——外部驱动**只**对 `EAGAIN/EMFILE` 用它。
2. prompt 结算（`runner.ts:1077` 起）：`const turnInfo = prompted.ok ? handle.getTurnErrorInfo?.() : undefined;`，在 self-check 分支
   之后、`turnError === undefined` 判定之前插入 `if (turnInfo !== undefined) return { ...turnInfo, message: cap(turnInfo.message) };`。

### 2.8 `src/config/settings.ts`（形状 + 默认 + 解析）

```ts
export type ExternalProtocolCheck = "strict" | "warn";
/** "provider/id"（用该 pi 模型的价格）| "unpriced" | 显式单价（USD/1M，四项必填、有限、≥0）。 */
export type DroidPricingOverride = string | ExternalPriceRates;
export interface DroidAgentSettings {
  enabled: boolean; // 默认 false；非 live（stack 构建时读）
  binary: string; // 默认 "droid"；非 live
  protocolCheck: ExternalProtocolCheck; // 默认 "strict"；非 live
  models: string[]; // 提示词展示的 droid 模型 id；[] = 自动
  advertiseMax: number; // 默认 12，整数 0..50
  injectMemory: boolean; // 默认 true（U5）
  pricing: Record<string, DroidPricingOverride>; // 默认 {}；键 = droid 模型 id
  catalogTtlMs: number; // 文件键 catalogTtlS，默认 86400s，60s..30d
  requestTimeoutMs: number; // 文件键 requestTimeoutS，默认 15s，1..120s
  initTimeoutMs: number; // 文件键 initTimeoutS，默认 20s，5..120s
  killGraceMs: number; // 文件键 killGraceS，默认 2s，0.2..30s
}
export interface ExternalAgentsSettings {
  droid: DroidAgentSettings;
}
// AgentSettings 新增：  externalAgents: ExternalAgentsSettings;
export function parseExternalAgentsSettings(value: unknown): ExternalAgentsSettings;
```

- `TIME_SETTING_MS_PATHS` 追加 `externalAgents.droid.{catalogTtlMs,requestTimeoutMs,initTimeoutMs,killGraceMs}`。
- 解析：未知键忽略；逐项非法回退默认；`models`/`pricing` 键须匹配 `/^[A-Za-z0-9._:-]{1,128}$/`，`models` 上限 50；`pricing` 字符串值须
  `parseStrictModelRef` 可解析或字面 `"unpriced"`，对象值四项齐全且有限 ≥0，否则丢弃并 `console.warn("[pi-subagent] externalAgents.droid.pricing.<id> ignored: …")`（每键一次）；`binary` 非空、无 NUL。
- **关闭态字节一致**：设置迁移不得给没有 `externalAgents` 的文件写入任何键（测试锁定）。

### 2.9 `src/external-agent/types.ts`（新建，框架全部接口；纯类型，`import type` only）

```ts
import type { Clock } from "../core/clock.js";
import type { ClassifiedError } from "../core/errors.js";
import type {
  DriverEvent,
  ExternalPriceTable,
  ExternalPricing,
  ExternalPricingDiag,
  ExternalRunSpec,
  JsonSchema,
  SessionSpec,
  UsageDelta,
} from "../core/types.js";
import type { DroidPricingOverride } from "../config/settings.js";
import type { SessionHandle } from "../runtime/session-driver.js";

export type ExternalSessionSpec = SessionSpec & { external: ExternalRunSpec };

// ── provider 与句柄 ──
export interface ExternalSessionHandle extends SessionHandle {
  readonly provider: string;
  /** RoutingSessionDriver.bind 委托；同步注册，只可调用一次（第二次 throw）。 */
  attach(onEvent: (e: DriverEvent) => void): void;
}
export interface ExternalAgentProvider {
  readonly id: string; // "droid"
  ownsSessionFile(path: string): boolean; // 路径前缀 + 头行 provider（有界同步读 ≤64KiB）
  create(spec: ExternalSessionSpec): Promise<ExternalSessionHandle>;
  /** 进程 cwd 与 initialize_session.cwd 一律取 transcript 头行 cwd（忽略 spec.cwd）；头行 cwd 不存在/非目录 ⇒
   *  reject ClassifiedError{config, msgResumeCwdGone(cwd)}，不起进程（§4.4）。 */
  resume(sessionFile: string, spec: ExternalSessionSpec): Promise<ExternalSessionHandle>;
  readonly catalog: ExternalCatalogPort;
  /** stack 重建时调用：停目录探测；不杀运行中的 run。幂等。 */
  dispose(): void;
}

// ── 模型目录 ──
export interface ExternalModelInfo {
  id: string;
  displayName?: string;
  upstreamProvider?: string; // availableModels[].modelProvider：anthropic|openai|google|xai|factory
  kind?: string; // "router" 等
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
  binaryFingerprint?: string; // realpath|size|mtimeMs|ino
  models: readonly ExternalModelInfo[];
  drift?: { expected: string; actual: string };
}
export interface ExternalCatalogPort {
  snapshot(): ExternalCatalog | undefined; // 同步：内存→磁盘缓存；绝不 spawn
  refreshInBackground(reason: "stack_build" | "binary_changed" | "stale"): void; // single-flight、有界、unref、失败静默
  observeInit(models: unknown, protocolVersion: string | undefined): void;
}
export interface CatalogStore {
  read(provider: string): ExternalCatalog | undefined; // 损坏/超限 ⇒ undefined
  write(catalog: ExternalCatalog): void; // 原子写 0600、≤256KiB；失败静默（warn 一次）
}

// ── service/stack 门面 ──
export interface ExternalAdvertisedModel {
  provider: string;
  id: string;
  name?: string;
  note?: string;
}
export interface PlanRunInput {
  runId: string;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  typeName: string;
  rolePrompt?: string;
  canSpawn: boolean;
  canMessage: boolean;
  declaresTools: boolean;
  schema?: JsonSchema;
  resume: boolean;
  cwd: string; // H2 之后的 cwd（resume 时仅用于诊断，provider 以头行为准）
  persist: boolean;
}
export interface ExternalAgentsPort {
  owns(provider: string): boolean;
  /** true 已知 / false 确定未知 / undefined 目录不可用（fail-open，交给 init+update 校验）。 */
  exists(ref: { provider: string; id: string }): boolean | undefined;
  /** 漂移（strict）/ 二进制缺失 / provider 名冲突 等整体不可用原因；有值即准入拒绝。 */
  unavailableReason(provider: string): string | undefined;
  unknownModelMessage(ref: { provider: string; id: string }): string;
  advertised(): readonly ExternalAdvertisedModel[];
  ownerOfSessionFile(path: string): string | undefined;
  /** 纯同步：定价（60s memo）+ 记忆块渲染（有界同步读）+ 能力块；不起进程。 */
  planRun(input: PlanRunInput): ExternalRunSpec;
  pricingFor(ref: { provider: string; id: string }): ExternalPricing;
  dispose(): void;
}

// ── 进程 ──
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export interface ManagedChildOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  /** 子进程 env = { ...process.env, ...extraEnv }（凭据随 process.env 继承，不读取、不打印、不持久化）。 */
  extraEnv: Readonly<Record<string, string>>;
  killGraceMs: number;
  ownerWatchdog: boolean; // DROID_EXITS_ON_STDIN_EOF=false 时为 true：sh 哨兵包裹（§4.1）
  clock: Clock;
}
export interface ManagedChild {
  readonly pid: number;
  onStdout(cb: (chunk: Buffer) => void): void;
  /** false ⇒ 背压（行仍在 Node 缓冲）；stdin 已销毁/EPIPE ⇒ throw ClassifiedError{internal}。 */
  write(line: string): boolean;
  onDrain(cb: () => void): void;
  readonly exited: Promise<ChildExit>; // 永不 reject
  exitInfo(): ChildExit | undefined;
  /** "graceful"：stdin.end + SIGTERM 组 + killGraceMs 后 SIGKILL 组；"now"：立即 SIGKILL 组。幂等。 */
  terminate(mode: "graceful" | "now"): { signalled: boolean; error?: string };
  terminating(): boolean;
  graceExpired(): boolean;
  stderrTail(maxBytes?: number): string; // 已脱敏，默认 2KiB
}
/** 同步 spawn；ENOENT ⇒ throw ClassifiedError{config}；EAGAIN/EMFILE ⇒ ClassifiedError{startup_transient, retryable:true}。 */
export type SpawnChild = (o: ManagedChildOptions) => ManagedChild;

// ── JSON-RPC ──
export type EnvelopeVerdict = { ok: true } | { ok: false; drift: { expected: string; actual: string } };
export interface Envelope {
  decorate(msg: Record<string, unknown>): Record<string, unknown>;
  /** 入站消息 factoryProtocolVersion/factoryApiVersion 比对（S6：droid 每条入站消息都带自身版本）。 */
  check(msg: Record<string, unknown>): EnvelopeVerdict;
}
export type RequestReply = { result: unknown } | { error: { code: number; message: string } };
export interface JsonRpcClientOptions {
  envelope: Envelope;
  /** 抛错 = 写不出去（进程死/EPIPE）。 */
  write(line: string): boolean;
  onNotification(method: string, params: unknown): void;
  /** 同步应答，绝不悬挂。抛错 ⇒ 客户端回 -32603 并 onProtocolError；应答 write 抛错 ⇒ onProtocolError。 */
  onRequest(method: string, id: string, params: unknown): RequestReply;
  onDrift(d: { expected: string; actual: string }): void;
  onProtocolError(e: ClassifiedError): void; // 致命
  clock: Clock;
  maxLineBytes?: number; // 默认 8 MiB
}
export interface JsonRpcClient {
  feed(chunk: Buffer | string): void;
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T>; // 超时 ⇒ ClassifiedError{internal}
  failAll(e: ClassifiedError): void;
  stats(): { lateResponses: number; nonJsonLines: number };
}
export type CreateJsonRpcClient = (o: JsonRpcClientOptions) => JsonRpcClient;

// ── transcript（格式冻结见 §4.6） ──
export interface TranscriptHeader {
  type: "external_session";
  version: 1;
  provider: string;
  sessionId: string;
  cwd: string; // create 时进程实际 cwd 的绝对 realpath；resume 的唯一 cwd 来源
  modelId: string;
  createdAt: string;
  roleName: string;
  runId: string;
}
export interface TranscriptEntry {
  type: "message" | "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
  customType?: string;
  data?: unknown;
}
export interface TranscriptWriter {
  readonly path: string;
  append(
    entry: { type: "message"; message: unknown } | { type: "custom"; customType: string; data: unknown },
  ): string | undefined;
  leafId(): string | undefined;
  branch(): readonly TranscriptEntry[];
  failed(): boolean;
  close(): void; // 同步、幂等
}
export type OpenTranscript = (o: {
  path: string;
  header?: TranscriptHeader;
  resume: boolean;
  maxFileBytes?: number;
}) => TranscriptWriter;
export type ReadTranscriptHeader = (path: string) => TranscriptHeader | undefined;

// ── 用量账本（§3.3） ──
export interface ExternalTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  credits: number;
}
export interface UsageLedgerTotals {
  usage: UsageDelta;
  credits: number;
  thinking: number;
  childTokens: number;
  overcount: boolean;
  pricing: ExternalPricingDiag;
}
export interface UsageLedger {
  beginTurn(baseline: ExternalTokenCounts | undefined): void;
  /** lastCall：droid lastCallTokenUsage（有则用于 tier 选择，S10）。 */
  observeCumulative(cum: ExternalTokenCounts, lastCall?: ExternalTokenCounts): UsageDelta | undefined;
  completeTurn(turnTotal: ExternalTokenCounts, child?: ExternalTokenCounts): UsageDelta | undefined;
  lastCumulative(): ExternalTokenCounts | undefined;
  totals(): UsageLedgerTotals;
}
export type CreateUsageLedger = (
  pricing: ExternalPricing,
  opts: { thinkingInOutput: boolean; cumulativeIncludesChild: boolean },
) => UsageLedger;

// ── 定价（§3.1） ──
export interface PriceCandidate {
  provider: string;
  id: string;
  cost?: ExternalPriceTable;
}
export type ResolveExternalPricing = (input: {
  modelId: string;
  info?: ExternalModelInfo;
  registry: readonly PriceCandidate[] | undefined;
  override?: DroidPricingOverride;
}) => ExternalPricing;
export type PriceUsage = (
  tokens: Pick<UsageDelta, "input" | "output" | "cacheRead" | "cacheWrite">,
  table: ExternalPriceTable,
  requestInputTokens?: number, // tier 选择依据；缺省 = input+cacheRead+cacheWrite
) => number;

// ── 框架依赖注入（P5 port.ts 组装；P3 只消费） ──
export interface ExternalFrameworkDeps {
  spawnChild: SpawnChild;
  createRpc: CreateJsonRpcClient;
  openTranscript: OpenTranscript;
  readTranscriptHeader: ReadTranscriptHeader;
  createLedger: CreateUsageLedger;
  catalogStore: CatalogStore;
  clock: Clock;
  agentDir: string;
  redact(text: string): string;
  warnOnce(key: string, message: string): void;
}
```

### 2.10 `src/external-agent/paths.ts`（新建，P1；纯函数，零 IO）

```ts
export const EXTERNAL_AGENT_DIRNAME = "external-agent";
export function externalAgentRoot(agentDir: string): string; // <agentDir>/external-agent
export function externalSessionsDir(agentDir: string, provider: string): string; // <root>/<provider>/sessions
/** sessionId 须过 /^[A-Za-z0-9-]{8,64}$/，否则 throw。 */
export function externalSessionPath(agentDir: string, provider: string, sessionId: string): string;
export function isExternalSessionPath(path: string | undefined, agentDir: string): boolean; // resolve 后前缀判断；undefined ⇒ false
export function catalogCachePath(agentDir: string, provider: string): string; // <agentDir>/cache/external-agent/<provider>-catalog.json
export function probeCwd(agentDir: string): string; // <agentDir>/cache/external-agent/probe-cwd
```

> r2：删除 r1 的 `KNOWN_EXTERNAL_PROVIDERS`——「是不是外部 run」在端口缺席时只用结构性证据判定（review #7，§5.4）。

### 2.11 `src/external-agent/messages.ts`（新建，P1；全部英文，模型/用户可见文案的唯一来源）

````ts
export const MSG_READONLY_DOMAIN: string; // §1
export const MSG_EXPERTS_UNSUPPORTED: string; // "experts/consult is not supported for droid/* runs (external agents cannot load the consult tool)"
export function msgExpertIsExternal(runId: string): string; // "expert <id> is a droid external-agent run; consult requires a pi session"
export function msgResumeCrossRuntime(runId: string, from: "droid" | "pi"): string;
export function msgResumeDisabled(runId: string): string; // "...enable externalAgents.droid.enabled to resume it"
/** "cannot resume this droid session: it was created in <cwd>, which no longer exists (deleted working directory or
 *  worktree). droid sessions are bound to their original directory — resuming elsewhere would fork the session history.
 *  Start a new run instead." */
export function msgResumeCwdGone(cwd: string): string;
export const MSG_RESUME_ISOLATION: string; // "isolation cannot be combined with resuming a droid run: droid sessions are pinned to their original working directory"
export const MSG_SET_MODEL_TO_EXTERNAL: string; // "set_model cannot switch to an external-agent model"
export const MSG_SET_MODEL_ON_EXTERNAL: string; // "droid external-agent run; mid-run model switching is not supported"
export function msgProtocolDrift(actual: string, expected: string, agentVersion?: string): string; // arch §5.1 全文
export function msgAuthFailure(detail: string): string; // arch §8.4 鉴权文案（detail 已脱敏）
export const MSG_USAGE_EXHAUSTED: string;
export function msgUnexpectedCancel(permissionApprovals: number): string;
export function msgPermissionUnacknowledged(waitedMs: number): string; // "droid did not acknowledge the permission approval within <n>s (protocol drift?); pi-toolkit stopped the run"
export const MSG_PERMISSION_REPLY_FAILED: string; // "failed to answer droid's permission request (stdin closed); pi-toolkit stopped the run"
export function msgBinaryNotFound(binary: string): string;
export function msgSchemaNoJson(): string; // "droid run did not end with a parseable ```json block (external agents have no StructuredOutput tool)"
export function msgProviderNameCollision(provider: string): string;
export function capabilitiesText(o: { canSpawn: boolean; canMessage: boolean }): string; // §4.8
export function externalModelsPromptHeader(provider: string): string; // §5.3
````

### 2.12 P1 纯函数实现（上提，review #1）：`src/external-agent/prompt.ts`、`src/external-agent/schema-extract.ts`

两个函数在 P1 **连实现带测试一起合入**（纯字符串处理，无依赖），P3 与 P4b 直接 import，不再依赖 P2：

````ts
// prompt.ts
/** 顺序：<agent-role>（rolePrompt + toolNameHint）→ 各 contextBlock（memory 包 <project-memory>，capabilities 原文）→
 *  schema 指令 → text。rolePrompt/contextBlocks/schema 均缺省时返回 text 原样（resume 路径）。 */
export function renderFirstMessage(o: {
  rolePrompt?: string;
  contextBlocks: readonly ExternalContextBlock[];
  schema?: JsonSchema;
  text: string;
  toolNameHint?: string;
}): string;
// schema-extract.ts
/** 取最后一个 ```json（或 ``` 无语言标注但内容以 { / [ 开头）围栏块解析；否则整段 trim 后以 { / [ 开头时整体解析；都失败 ⇒ ok:false。 */
export function extractStructuredJson(text: string): { ok: true; value: unknown } | { ok: false };
````

### 2.13 P1 测试（随 P1 合入）

`tests/core/external-meta.test.ts`（merge 规则全表、pricing 只升不降、degraded 上限、`mergeUnpriced` 全表）、`tests/core/core.test.ts`
（matrix/property 加 `external_meta`；`unpriced` 合并；pi 增量无 `unpriced` 键）、`tests/core/errors-classified.test.ts`、
`tests/runtime/runner-classified-error.test.ts`（startError 透传 kind/retryable + 截断；`getTurnErrorInfo` 优先级；pi 句柄行为不变）、
`tests/config/external-agents-settings.test.ts`（默认、逐项回退、时间单位、pricing 校验、迁移不加键）、`tests/external-agent/paths.test.ts`、
`tests/external-agent/messages.test.ts`、`tests/external-agent/prompt.test.ts`、`tests/external-agent/schema-extract.test.ts`
（末尾 json 块、多块取最后、无语言围栏、整段 JSON、无块、坏 JSON）、`tests/core/run-journal-external.test.ts`。

### 2.14 「只合入 P1」时各波次 2 包的独立 typecheck 矩阵（review #1 确认项）

每包跨域 import **只允许**指向 P1 文件或既有代码；P1 合入后各包单独 `npm run typecheck` 必须通过：

| 包  | 跨域 import（全部 P1 或既有）                                                                                                                                                | 明确不 import                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P2  | `core/{types,errors,clock}`、`external-agent/{types,paths}`、`config/settings`（type）、`config/model-hint`（`parseStrictModelRef`，既有）、`runtime/session-driver`（type） | `external-agent/droid/**`                                              |
| P3  | `core/{types,errors,clock,tool-preview}`、`external-agent/{types,paths,messages,prompt}`、`config/settings`（type）                                                          | P2 任何实现文件（工厂经 `ExternalFrameworkDeps` 注入；测试注入假实现） |
| P4a | `external-agent/{types,messages}`、`config/settings`                                                                                                                         | P2/P3                                                                  |
| P4b | `external-agent/{types,paths,messages,schema-extract}`、`core/types`                                                                                                         | P2/P3（端口用接口，测试用假端口）                                      |
| P4c | `core/{types,external-meta}`                                                                                                                                                 | P2/P3                                                                  |

验收方式：评审对照本表；波次 2 各包的 CI / 本地 typecheck 一律基于「P1 已合入、兄弟包未合入」的 master 跑（不 rebase 到兄弟包），通过即证明独立可编译。

---

## 3. 计费（U4）

### 3.1 droid 模型 → 底层模型 → pi 价格：匹配规则（`src/external-agent/pricing.ts`，P2）

输入：`modelId`、目录 `ExternalModelInfo`（可缺：首个 run 早于目录探测）、pi 注册表候选（`getAll()` 投影）、用户覆盖
`externalAgents.droid.pricing[modelId]`。S/U4 实测：`availableModels` 是唯一权威表，`id === modelId` 恒成立，无独立「底层模型名」字段；
非 factory provider 的 id 即厂商模型名；**factory 自托管模型底层即同名开源模型，Factory 无美元单价**。按序：

0. **覆盖**：`"unpriced"` ⇒ `unpriced/override_unpriced`；对象 ⇒ `priced/source:"settings"/basis:override/approx:false`；`"provider/id"` ⇒
   注册表精确 `find`，存在且非零价 ⇒ `priced/basis:override`，否则 `unpriced/invalid_override`。
1. `info.kind === "router"` 或 `modelId === "auto"` ⇒ `unpriced/router_model`。
2. 注册表不可读 / 为空 ⇒ `unpriced/registry_unavailable`。
3. **id 等价**：`norm(s) = lower(s).replaceAll(".", "-")`；`base(s)` = `norm(s)` 去尾部 `-\d{8}`。命中 ⇔ `norm` 相等或 `base` 相等。
   **不剥其它后缀**（`-fast`/`-mini`/`-pro`/`-preview`/`-codex`/`-flash` 都是不同价的不同模型）。
4. 命中非空但全部零价/无 cost ⇒ `unpriced/zero_price`（中转站常写 0，不当免费）。`usable` = 非零价命中。
5. **规范 provider 优先**：
   - `CANONICAL = { anthropic:["anthropic"], openai:["openai"], google:["google","google-vertex"], xai:["xai"] }`；
     `info.upstreamProvider` 命中其中 ⇒ 在这些 provider 里找，找到 ⇒ `basis:"upstream"`、`approx:false`。
   - 否则（`upstreamProvider === "factory"` 或目录缺失）用 `FAMILY = { "claude-":["anthropic"], "gpt-":["openai"], "gemini-":["google"], "grok-":["xai"], "kimi-":["moonshotai"], "glm-":["zai"], "deepseek-":["deepseek"], "minimax-":["minimax"], "mistral-":["mistral"] }`
     ⇒ 找到 ⇒ `basis:"family"`、**`approx:true`**（factory 自托管模型按厂商 API 牌价近似；目录缺失时的 claude/gpt 等也暂标近似，
     目录到位、memo 过期后自动转为 upstream）。
   - 同一 provider 内多个命中（日期变体）价格不一致 ⇒ `unpriced/ambiguous`；优先 `norm` 精确命中那条。
6. **共识兜底**：无规范命中、全部 `usable` 价格（含 tiers）深相等 ⇒ `priced/basis:"consensus"/approx:true`，source = 字典序首个；
   否则 `unpriced/ambiguous`（detail 列 ≤5 个 `p/id in/out`）。
7. 无命中 ⇒ `unpriced/no_match`。

实测对照（测试用合成 fixture 复现，不读用户文件）：`claude-sonnet-5` 取内置 `anthropic` 2/10（upstream）而非中转 `cr-anthropic` 3/15；
`claude-fable-5.1` ⇒ `claude-fable-5-1` 只在中转、两家一致 ⇒ consensus/approx；`gpt-6-luna` ⇒ `openai` 带 272k tier；`kimi-k3`（factory）⇒
`moonshotai` family/approx；`claude-opus-5-5-fast`/`inkling`/`deepseek-v4.1-flash` ⇒ `no_match`；`auto` ⇒ `router_model`。
**否决「冲突取最高价」**：编价比 unpriced 更误导；用户可用 `pricing` 覆盖钉死。

### 3.2 缓存与刷新

- `ExternalAgentsPort` 内 memo：`Map<modelId, {pricing, at}>`，TTL 60s（读时判过期，无计时器）；stack 重建随 port 丢弃 ⇒ `models.json`
  改价最迟 60s 后的新 spawn 生效。注册表读包 try/catch（live getter 可能抛）⇒ `registry_unavailable`。
- **run 内价格冻结**：`planRun` 把判定快照进 `ExternalRunSpec.pricing`；resume 是新 run ⇒ 重新判定。

### 3.3 用量增量/累计与防重复计费（`src/external-agent/usage-ledger.ts`，P2；droid 侧 `droid/usage-fields.ts` 只做字段归一）

S10 实测：`agent_turn_completed.tokenUsage` = **本 turn 增量**（E2 已证实），`cumulativeTokenUsage` = 会话累计；turn 开始无独立基线事件，
新 turn 首条 `session_token_usage_changed.tokenUsage` 给的是**上一时刻累计（即基线）**，随后逐步累计；fresh 会话首条即本 turn 用量；
事件另带 `lastCallTokenUsage`。账本规则：

| #   | 规则                                                                                                                                                                                                                                  | 防的是什么                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| L1  | `beginTurn(baseline)`：fresh 会话首 turn 基线 = 全 0；之后 = `lastCumulative()`；**resume 会话首 turn 基线 undefined**                                                                                                                | 把历史用量记进本 run           |
| L2  | `observeCumulative(cum)`：turn 内有前值 ⇒ 逐字段 `max(0, cum − prev)` 出增量；无前值 ⇒ 只记 prev（resume 首条恰为基线，S10）；turn 外只记 prev                                                                                        | 累计当增量重复加；回退产生负数 |
| L3  | `completeTurn(turnTotal, child)`：每个 turnId 只处理一次；remainder = 逐字段 `max(0, target − turnEmitted)`，`target = turnTotal (+child，若 E3 证实累计含子 agent)`；任一字段超出 ⇒ `overcount`（钳 0，`degraded:+usage_overcount`） | 实时增量 + 终结对账双算        |
| L4  | 进程在 turn 完成前死：已发增量保留，不补对账                                                                                                                                                                                          | —                              |
| L5  | `thinking`：`DROID_THINKING_IN_OUTPUT`（E1，默认 `true`）为 false 时 `output := output + thinking`，按 output 价计                                                                                                                    | 思考 token 漏计                |
| L6  | 子 agent 用量（`childTokenUsage`）：token 计入，成本不计；该增量 `unpriced:"partial"`，定价诊断升 `partial/child_usage`                                                                                                               | 用父模型价给未知模型编价       |
| L7  | 计价 `priceUsage(tokens, table, requestInputTokens)`：tier 依据优先用 `lastCallTokenUsage` 的 input+cacheRead+cacheWrite（≈单次请求），否则用增量自身；结果非有限 ⇒ 0。unpriced run：每个增量 `costUsd:0, unpriced:"all"`             | NaN；把未定价当免费            |
| L8  | credits：累计差，只进 `external_meta.credits`（max），不参与 costUsd                                                                                                                                                                  | —                              |

### 3.4 unpriced 与近似价的呈现

`UsageDelta.costUsd` 是 40+ 处消费的必填数字，v1 不改其类型，旁带粘性 `unpriced?: "all" | "partial"`（§2.1/§2.5），状态随 usage 走遍
outcome/持久化，展示面**不靠 costUsd≈0 猜**（review #10）：

| 展示面                                                                              | 渲染                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/fleet-widget.ts` `formatWidgetCost(costUsd, unpriced?: "all" \| "partial")` | `"all"` ⇒ `unpriced`；`"partial"` ⇒ `$1.23+?`；表头活跃总计有任一 ⇒ 加 `+?`                                                                                                                                                   |
| `src/tools/agent-tool.ts` 进度行与 `formatOutcomeSummary`                           | 复用 formatWidgetCost（读 `usage.unpriced`）                                                                                                                                                                                  |
| `src/tools/result-tool.ts` usage 行                                                 | `cost:unpriced` / `cost:$x.xxxx+unpriced`；加 `formatExternal` 一行                                                                                                                                                           |
| `src/commands/status.ts`（`/agent costs` 与 usage 行）                              | 单 run 同上；Total 行后 ` (+N unpriced runs)`                                                                                                                                                                                 |
| `src/tools/result-text.ts` `formatExternal(diag.external)`                          | `droid · session 1a2b3c4d · autonomy high · priced anthropic/claude-opus-5-5 · 1.8k credits`；近似 ⇒ `priced ~moonshotai/kimi-k3 (family, approx)`；未定价 ⇒ `unpriced (no_match) — set externalAgents.droid.pricing["<id>"]` |

**披露（README + 本节）**：①**近似价类别**：`basis:"family"`（factory 自托管模型——glm/kimi/deepseek/minimax/mistral 等——按同名模型
厂商 API 牌价计，**不是** Factory 实际成本，Factory 只按 credits 计费）与 `basis:"consensus"`（中转站价格一致时采用）都标 `approx`；
②**已知缺口（v1 不改）**：HUD footer 子 agent 成本、web-hub 卡片/汇总、`toPiToolUsage` 回报给 pi 的会话总计、workflow 通知按数字合计
（未定价部分计 0）；③消费 `costUsd` 的成本上限对 unpriced 部分视为 0（consult 不能用 droid；tidy 已拒绝；`/goal` 属订阅额度场景）。

---

## 4. 运行时行为规格（P2 框架 / P3 适配器实现依据）

### 4.1 进程（P2 `process.ts`）

沿用 arch §4.4 ManagedChild 表，补充/改动：

- args 固定 `["exec","--input-format","stream-jsonrpc","--output-format","stream-jsonrpc"]`；cwd 同时经 `initialize_session.cwd` 下发。
- env = `{ ...process.env, ...extraEnv }`。P3 传 `DROID_CHILD_ENV = { DISABLE_AUTO_UPDATE: "1", FACTORYD_DISABLE_AUTO_UPDATE: "1" }`
  （S12：droid 给自己子进程注入的就是 `DISABLE_AUTO_UPDATE`；运行中自更新 = 中途协议漂移，必须挡住）。注入是尽力而为（S12 未做运行时
  拦截实验），**强保证**由用户侧 `~/.factory/update-policy.json {"disableAutoUpdate":true}` 提供——P6 README 写明，pi-toolkit 不改用户
  全局 droid 配置。
- 进程级登记 `Symbol.for("pi-subagent:external-agent-procs")` + 一次性 `process.on("exit")` 同步 SIGKILL：**首次 spawn 时才安装**。
- 孤儿：S3 实测 idle 时关 stdin ~1s 自退（exit 0）；pi 被 SIGKILL 时管道关闭即 EOF。**turn 中途 EOF 未实测**（S3 只测 idle；且有 pending
  permission 时 EOF 无效）⇒ `DROID_EXITS_ON_STDIN_EOF` 默认 `true`，由 P5 conformance D10 实测「turn 中关 stdin ≤5s 退出」固化；不成立则
  改 false 启用 `ownerWatchdog`：`/bin/sh -c` 哨兵作组长，`"$0" "$@" 0<&0 &`（必须显式 `0<&0`）+ 每 1s 校验 pi pid 与
  `/proc/<pid>/stat` starttime，pi 死 ⇒ `kill -KILL -$$`。哨兵在 P2 实现并测，无论默认值如何都可用。
- 脱敏 `redact(text)`：`process.env.FACTORY_API_KEY` 精确值 ⇒ `***` + 通用 `(api[_-]?key|token|authorization)["'=: ]+\S+`（卫生措施）。
  stderr 只以 ≤2KiB 脱敏尾部进入错误文本，从不写 transcript / 日志。

### 4.2 JSON-RPC 与漂移检测（P2 `jsonrpc.ts` + P3 `droid/envelope.ts`）

沿用 arch §4.4（字符串单调 id、每请求 unref 超时、8MiB 行上限、非 JSON 连续 ≥20 / 累计 ≥200 ⇒ 致命、进程退出 ⇒ `failAll`、EPIPE ⇒
视同退出）。漂移检测点（S6 实测修订）：

| #   | 检测点                                        | 有效性                                                                                                                                                    |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 目录探测的 init 响应 `factoryProtocolVersion` | 有效（droid 每条入站消息都带**自身**版本，S/27 88/88 行）                                                                                                 |
| ②   | 每个 run 的 init 响应                         | 有效                                                                                                                                                      |
| ③   | 运行中任一入站消息                            | 有效                                                                                                                                                      |
| ④   | `id:null -32700`（信封被拒）                  | 只对「信封真被拒」（缺字段/格式错）有意义；**droid 不校验请求侧版本**（S/43：发 1.200.0/9.9.9 均被接受）⇒ 不再视为版本漂移信号，归类为协议致命 `internal` |

版本号相等 ≠ 事件形状稳定：结构守卫（`droid/protocol.ts` 手写守卫，未知通知计数 `unknownNotifications`）+ conformance 仍是必要防线。

### 4.3 反向权限请求（P3 `droid/session.ts` 的 `onRequest`，U2′；review #3 定值）

**定值**：`initialize_session` 与随后的 `update_session_settings` 都显式带 `autoRejectPermissionRequests: DROID_AUTO_REJECT_PERMISSIONS`
（= `false`）；`onRequest("droid.request_permission")` **同步**返回 `{ result: DROID_PERMISSION_REPLY }`（= `{ selectedOption: "proceed_once" }`，
S2 实测形状）。常量全部在 `droid/protocol.ts`。其它反向请求（`droid.ask_user`、未知方法）⇒ `{ error: { code: -32601, message: "not supported by pi-toolkit host" } }`。

为什么不吃默认 auto-reject：默认（不传）时 droid ~1s 自行 cancel（S/31），请求只是通知性的，U2′「一律批准」落空。S8 实测 high 下 0 次请求，
本路径是防御性的，但必须正确。

**零卡死论证**（S2：false 时 droid **无超时永久等待**，EOF 也不打断 ⇒ 所有路径必须由我方收口）：

| 路径                                | 处置                                                                                                                                                                                                                                | 上界                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 正常                                | 同一 tick 内解析请求即写回应答；`permissionApprovals++`，节流发 `external_meta`                                                                                                                                                     | 0                            |
| `onRequest` 处理器抛错              | 客户端回 `-32603`（droid 视为失败 = cancel，二进制证据 handlePermissionFailure）**并** `onProtocolError` ⇒ 致命                                                                                                                     | 同下                         |
| 应答写入抛错（stdin 已关/EPIPE）    | `onProtocolError(ClassifiedError{internal, MSG_PERMISSION_REPLY_FAILED})` ⇒ 致命                                                                                                                                                    | 同下                         |
| 应答已写出但 droid 不认（形状漂移） | 每个已批准请求起一个 unref 计时器 `DROID_PERMISSION_ACK_TIMEOUT_MS`（10s），收到对应 `permission_resolved` 或该 toolUse 的 `tool_result`/turn 结束即清除；超时 ⇒ 致命 `ClassifiedError{config, msgPermissionUnacknowledged(10000)}` | 10s                          |
| **致命收口**（以上三种）            | `interrupt_session`（`requestTimeoutMs` 有界，不等结果）→ `terminate("now")`（pending permission 时 EOF/SIGTERM 不可靠，直接 SIGKILL 组）→ `prompt()` reject 该 ClassifiedError                                                     | `requestTimeoutMs` + SIGKILL |
| 外层兜底                            | 请求期间仍处于 runner 的 `tool_exec`/`model_turn` 相位，toolMs/idle/total 截止照常生效；reaper L3p `killableHandles`                                                                                                                | runner 预算                  |

`msgUnexpectedCancel` 在 `permissionApprovals > 0` 时附「permission approval may not have been understood by this droid version」。

### 4.4 会话设置与 resume cwd（P3 `droid/settings.ts` + `droid/provider.ts`）

**create**：

1. spawn（cwd = `spec.cwd`，即 post-H2）→ `initialize_session({ machineId:"pi-toolkit", cwd, modelId, autonomyLevel: DROID_AUTONOMY_FULL, reasoningEffort?, autoRejectPermissionRequests: false })`。
2. **无条件** `update_session_settings({ modelId, autonomyLevel:"high", reasoningEffort?, autoRejectPermissionRequests:false })`。
   S5：init 对无效 modelId **静默改成默认 `gpt-6-sol`+high**（成本陷阱），update 则干净返回 `-32602 "Unknown model: …"` ⇒ update 的
   error 文本含 model ⇒ `terminate("now")` + `ClassifiedError{config, unknownModelMessage}`（带目录候选）。**在 update 校验通过前绝不发
   `add_user_message`**。
3. 比对 update 响应 / `settings_updated` 的生效值：`autonomyLevel !== "high"`（S8：echo `autonomyMode:"auto-high"`、`autonomyLevel:"high"`，E4 已证实）
   或 `modelId` 不符 ⇒ fail closed（config）。
4. transcript 头行写入 `cwd = realpathSync(spec.cwd)`。

**resume（review #2，S7）**：S7 实测 `initialize_session(sessionId=旧, cwd=新)` 被接受、会话切到新 cwd，并在新 cwd slug 下重写全历史 ⇒
同一 sessionId 两份会话文件、历史分叉。规则：

1. `readTranscriptHeader(sessionFile)`；头行缺失/非法 ⇒ `ClassifiedError{config,"not a droid external-agent session file"}`。
2. `cwd := header.cwd`，**忽略 `spec.cwd`**；进程 spawn cwd 与 `initialize_session.cwd` 都用它。
3. `header.cwd` 不存在或不是目录（`statSync` 同步检查）⇒ reject `ClassifiedError{config, retryable:false, msgResumeCwdGone(header.cwd)}`，
   **不起进程、禁止回落 spec.cwd**。典型来源：worktree 隔离 run 的 worktree 已被 H3 清理（`kept` 处置的 worktree 仍可 resume）。
4. 其余同 create 2–3（update 同时解决「会话持久化设置覆盖 init 参数」坑）；transcript 追加 `custom subagent:external-resume`。
5. 准入侧（P4b）配套：外部会话 resume 且带 `isolation` ⇒ 零副作用拒绝 `MSG_RESUME_ISOLATION`（H2 会改 cwd，而 resume 被钉在原目录）。

thinking → reasoningEffort：照 arch §8.3；`getThinkingLevel()` 返回生效 effort。

### 4.5 事件映射与终态（P3 `droid/events.ts` 纯映射器 + `droid/terminal.ts`）

事件映射照 arch §8.1，删去「策略拒绝」处理，`request_permission` 行改为 §4.3，thinking 按 §4.9。终态：

| 条件                                                                                      | `prompt()`                                                                                                                        | `getTurnErrorInfo()`                                       | run 终态                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| `agent_turn_completed reason:completed`，无待处理 error                                   | resolve                                                                                                                           | —                                                          | `completed`，text=`lastAssistantText` |
| `cancelled` 且我方发起过 interrupt/abort                                                  | resolve                                                                                                                           | —                                                          | runner 按 stopCause/timeoutReason     |
| `cancelled` 非我方发起                                                                    | resolve                                                                                                                           | `{model, retryable:false, msgUnexpectedCancel(approvals)}` | `failed`                              |
| `error` 通知匹配 401/402/403（`/\b40[123]\b/` 或 `"status":40[123]`），随后任意 turn 完成 | resolve                                                                                                                           | `{auth, retryable:false, msgAuthFailure(脱敏 detail)}`     | `failed`                              |
| `reason:model_usage_exhausted`                                                            | resolve                                                                                                                           | `{auth, retryable:false, MSG_USAGE_EXHAUSTED}`             | `failed`                              |
| 其它 `error` + 任意完成                                                                   | resolve                                                                                                                           | `{model, retryable:/\b429\b/, 脱敏文本}`                   | `failed`                              |
| 进程在 turn 完成前退出                                                                    | 我方发起过 abort ⇒ resolve；否则 reject `ClassifiedError{internal,"droid exited unexpectedly (code/signal); stderr: <脱敏尾部>"}` | —                                                          | `aborted`/`failed`                    |
| 协议致命（strict 漂移、stdout 污染、超长行、信封被拒、权限应答失败/无回执）               | interrupt（有界）→ SIGKILL 组 → reject `ClassifiedError{config\|internal}`                                                        | —                                                          | `failed`                              |
| resume 头行 cwd 不存在                                                                    | `resume()` 直接 reject `ClassifiedError{config}`（不起进程）                                                                      | —                                                          | `failed`（session_create 阶段）       |

退出码一律不作判据。402 永远 `auth`+不可重试。

### 4.6 transcript（P2 `transcript.ts`，格式冻结）

照 arch §5.3：路径 `externalSessionPath(agentDir,"droid",sessionId)`；头行 `TranscriptHeader`（`cwd` 为 realpath，resume 唯一 cwd 来源）；之后 pi
条目同形（`message` user/assistant/toolResult、resume 时 `custom subagent:external-resume`）；工具参数 8KiB / 结果 16KiB 截断标注、单文件
32MiB 上限后只写一条截断 custom；目录 0700、文件 0600；写失败 ⇒ `failed()`、`degraded:+transcript_write_failed`、不影响 run；
`persistTranscript:false` ⇒ 不建文件、`sessionFile=undefined`。web-hub `run-file-reader` 与 `projectSessionEntry` 零改动可读（P2 测试用真
`projectSessionEntry` 断言）。

### 4.7 模型目录（P2 `catalog-store.ts` + P3 `droid/catalog.ts`）

照 arch §10「目录来源」：缓存 `catalogCachePath(agentDir,"droid")`；stack 构建时缺失 / 超 `catalogTtlMs` / 二进制指纹变化 ⇒ 后台探测（single-flight、
20s 有界、unref、失败静默）；探测 = 起 RPC（同样带 `DROID_CHILD_ENV`）→ `initialize_session`（cwd=`probeCwd(agentDir)`）→ 读 `availableModels`
（`modelProvider→upstreamProvider`、`supportedReasoningEfforts→reasoningEfforts`、`defaultReasoningEffort`、`kind`、`deprecated`、`tokenMultiplier`）
→ `close_session` → `terminate("graceful")`；每个 run 的 init 结果 `observeInit` 顺带刷新。S4 实测：只 init 也会在 `~/.factory/sessions/<probe-cwd
slug>/` 落一个空会话文件——接受（固定 slug 归档，频率 ≤ 每 `catalogTtlMs` 一次），README 披露。探测发现漂移 ⇒ `catalog.drift`，strict 下
`unavailableReason` 生效。

### 4.8 首条消息拼装（P1 `prompt.ts` 的 `renderFirstMessage`；P3 只负责传参）

顺序：`<agent-role>`（rolePrompt + `toolNameHint`：pi read/bash/edit ≈ droid Read/Execute/Edit·ApplyPatch）→ `<project-memory>`（U5）→
capabilities 块 → schema 指令 → 任务正文（adapter 的 `appendPromptNotes(buildPrompt(spec), promptNotes)`）。resume 只发任务正文。

S9 已证实 `--append-system-prompt-file` 在 RPC 下生效，v1 **仍走首条消息**：首条消息进入 droid 会话历史，resume 天然携带；system prompt
是 exec 启动参数，每次 resume 必须重新提供同一文件（需要持久化临时文件及其生命周期管理）。遵从度不足时作为后续增强切换，`ExternalRunSpec` 不变。

capabilities 文案（`capabilitiesText`）：
`You are running as an external agent (Factory droid) on behalf of pi-toolkit, with full permissions in your working directory. Unavailable here: consulting experts[, messaging other agents][, spawning pi sub-agents]. Write every finding into your final answer.`

`degraded`（planRun 产出）：`schema_text`、`message_agent`、`nested_agent`、`type_tools_ignored`、`input_budget_preflight_only`。

### 4.9 句柄方法与 thinking 映射（P3 `droid/session.ts`）

照 arch §9 表，改动：`setActiveTools` no-op、`getActiveTools()` 返回 `[]`；`requestAbort`/`steer`（idle no-op）/`dispose`（同步幂等，idle ⇒
graceful，turn 中 ⇒ now）/`killableHandles`（恰一个 `{kind:"process",id:"droid:<pid>"}`，优雅终止宽限内 no-op）不变；`getUsage()` = 账本
totals；`childExtensionMissing` 永不置位；不实现 `setModel/setThinkingLevel/observe/measureInputBudget`。attach 时立即发 `external_meta{provider,
sessionId, autonomy, protocolVersion, agentVersion, pricing, degraded, nativeSessionFile}`。`context_usage`：`get_context_stats` 节流 15s、超时 3s、
single-flight、连败 3 次停用。

thinking（S11 实测）：`thinking_text_delta{messageId, blockIndex, textDelta}` ⇒ `thinking_delta{delta}`（流式全文）；`thinking_text_complete`
**不载文本**，不映射；`create_message` 的 `{type:"thinking"}` 块只写 transcript，**不再**发 `thinking_delta`（避免与流式重复）——若该 messageId
从未收到任何 `thinking_text_delta`，才把块全文作为一次 `thinking_delta` 补发。

---

## 5. 接线规格（P4a/P4b/P4c/P5）

### 5.1 spawn 准入（P4b `src/service/spawn-service.ts`）

新增 dep `external?: ExternalAgentsPort`（另需 `agentDir`：沿用 spawn-service 既有来源，缺则 deps 注入 `agentDir: string`）。零副作用区内、hint
解析之后、`modelExists` 之前，照 arch §4.7 ①–⑤，修订：

- ③ 第一条：`req.toolDomain === "readonly"` ⇒ `MSG_READONLY_DOMAIN`（`retryable:false`）。
- ③ 其余：`unavailableReason` ⇒ 拒绝；`exists===false` ⇒ `unknownModelMessage`；`req.consultExperts?.length`（`src/core/types.ts:434`）⇒
  `MSG_EXPERTS_UNSUPPORTED`；`forkSessionFrom` ⇒ 拒绝；resume 目标是 pi 会话 ⇒ `msgResumeCrossRuntime`；**resume 目标是外部会话且
  `req.isolation !== undefined` ⇒ `MSG_RESUME_ISOLATION`**；通过后跳过 `modelExists`，quota/load 闸门照常。
- ⑤ 恒开守卫：resume 目标 `isExternalSessionPath(file, agentDir)` 且 `external` 缺席 ⇒ `msgResumeDisabled`（纯结构性证据）。
- 端口缺席时 `droid/x` 走原 `formatUnknownModelError`（字节一致）。

### 5.2 runtime-adapter（P4b `src/service/runtime-adapter.ts`）

新增 dep `external?: ExternalAgentsPort`。`isExternal = !!(spec.model && deps.external?.owns(spec.model.provider))`：

- 为真时**不构造**任何 customTools / reserved grant / switch_context grant / child bash grant / prefix probe；`toolScope` 不放进请求；
  `sessionSpec.systemPrompt` 不设（进 `rolePrompt`）。
- H2 之后（拿到 post-H2 cwd）：`sessionSpec.external = deps.external.planRun({...})`（H2 合并之后挂，避免扩展重建 spec 时丢字段）。
- schema：run `completed` 后 `extractStructuredJson(outcome.text)`（**P1** `schema-extract.ts`），失败 ⇒ `failed{schema, msgSchemaNoJson()}`；
  成功走原 `applyStructuredOutputPolicy` + verdict/v1 语义校验；不做修复轮（U6）。
- `displayMeta.model = {provider:"droid", id}` 不变。

### 5.3 提示词（P4a `src/config/available-models.ts` + `src/sysprompt/core-sections.ts`）

```ts
// available-models.ts
export interface ExternalPromptModels {
  provider: string;
  models: readonly ExternalAdvertisedModel[];
  total: number;
}
export function formatExternalModelsForPrompt(ext: ExternalPromptModels): string; // "" when models empty
export function formatAvailableModelsForPrompt(
  models: readonly AvailableModelEntry[],
  external?: readonly ExternalPromptModels[],
): string;
// core-sections.ts
export function availableModelsSection(deps: {
  stackAvailable: () => readonly AvailableModelEntry[] | undefined;
  externalModels?: () => readonly ExternalPromptModels[] | undefined;
}): SectionRegistration;
```

- `external` 缺省/空 ⇒ **逐字节等于现行输出**（golden）。pi 列表为空但有 external ⇒ 只输出 external 子块（带同一 `## Available models` 标题）。
- 子块：`### External agent models (droid)` + `externalModelsPromptHeader("droid")`：
  `` `droid/<id>` runs the subagent as a Factory droid CLI process with full permissions, not a pi session: no consult/experts, message_agent, nested Agent, set_model or toolDomain:"readonly"; resuming is pinned to the original working directory; schema answers are parsed from a final ```json block; cost is computed from the underlying model's pi price (shown as unpriced when unknown). Any droid model id is accepted. ``
  然后 `- droid/<id> — <displayName> (×<multiplier>)`，超出 `… +N more`。走 sysprompt hub 既有快照/尾部更新。
- 列哪些：`models` 非空则只列它们；否则非 deprecated、`kind!=="router"`、非 `custom:`，按 droid 原序前 `advertiseMax` 个。

### 5.4 hint / consult / set_model（review #7：端口缺席只用结构性证据）

- hint（P5 `stack.ts` `models.resolveHint` 包装）：`parseStrictModelRef(hint)` 且 `port.owns(provider)` ⇒ 直接返回；否则只在 pi 注册表解析——
  fuzzy hint 永不落到 droid。端口缺席 ⇒ 不包装（原函数）。
- consult（P4b `src/consult/index.ts` `resolveExperts`）：判定「目标是外部 run」=
  `diag.external !== undefined`（只有外部驱动会产生）**或** `isExternalSessionPath(diag.sessionFile, agentDir)` **或**
  `deps.isExternalProvider?.(diag.model?.provider)`——最后一项是新增可选 dep，**只在端口存在时由 P5 注入** `(p) => port.owns(p)`。
  命中 ⇒ `msgExpertIsExternal(id)`。关闭态下前两项对既有输入恒假（从未产生），第三项缺席 ⇒ 字节一致；用户注册表里恰有字面 provider
  `droid` 的 pi run 不受影响。workflow `expert-scope.ts` 复用 `resolveExperts` 自然生效。
- set_model（P4b `src/tools/set-model-tool.ts`）：新增可选 dep `externalOwns?: (provider: string) => boolean`（同样只在端口存在时注入）；
  目标模型 `externalOwns?.(provider) === true` ⇒ `MSG_SET_MODEL_TO_EXTERNAL`；目标 run `diag.external !== undefined` 且 runner 返回 `unsupported`
  ⇒ 文案换 `MSG_SET_MODEL_ON_EXTERNAL`。

### 5.5 装配（P5）

`src/external-agent/port.ts`：

```ts
export function createExternalAgentsPort(o: {
  settings: ExternalAgentsSettings;
  agentDir: string;
  clock: Clock;
  registry: () => readonly PriceCandidate[] | undefined; // ctx.modelRegistry.getAll() 投影（try/catch）
  piProviders: () => readonly string[]; // provider 名冲突检测
  memoryBlock?: (cwd: string) => string | undefined; // memory 关闭或 injectMemory:false 时不传
  warnOnce(key: string, message: string): void;
}): { port: ExternalAgentsPort; providers: ReadonlyMap<string, ExternalAgentProvider> } | undefined; // enabled=false ⇒ undefined
```

- 组装 `ExternalFrameworkDeps`（P2 工厂）→ `createDroidProvider(deps, () => settings.droid)`（P3）。
- provider 名冲突：pi 注册表里存在字面 provider `droid` ⇒ `unavailableReason = msgProviderNameCollision("droid")` + warnOnce，fail closed（本机
  `droid-completion` 不冲突）。
- `stack.ts`：enabled 时 `driver = new RoutingSessionDriver(new PiSessionDriver(...), providers)`，否则原样；`external` 传给 spawn-service /
  runtime-adapter；`wireConsult` 传 `isExternalProvider`、set_model 工具 deps 传 `externalOwns`（**仅端口存在时**）；`Stack.external?:
ExternalAgentsPort`；dispose 于下一次 build 顶部 + `session_shutdown`；构建时 `refreshInBackground("stack_build")`。
- `index.ts`：`availableModelsSection({ stackAvailable, externalModels })`；`wireMemory` 返回的 `renderForExternal`（P4a）经 holder 晚绑定给
  `memoryBlock`；host-form set_model 工具同样只在端口存在时拿到 `externalOwns`。

### 5.6 记忆导出（P4a `src/memory/inject.ts` + `src/memory/index.ts`）

```ts
// inject.ts
export function renderExternalMemoryBlock(
  deps: { settings: MemorySettings; cache: RenderCache },
  cwd: string,
): string | undefined;
// index.ts —— WireMemoryResult 新增
renderForExternal(cwd: string): string | undefined;
```

语义 = 子会话视角：`injectInChildSessions:false` 或 `childProfile:"none"` ⇒ undefined；tiered 用 `profile = childProfile`、
`access = accessFromTools(["read"], toolSurface)`、同一字节预算；legacy 用 `renderMemoryBlock`；异常 ⇒ undefined；不读 frozenBlocks。

---

## 6. 分包

### 6.1 依赖与波次

```
P1 契约（先合，含 prompt.ts / schema-extract.ts 两个纯函数实现）
  └─► 波次 2（同消息并行派发，都只基于 P1 合入后的 master）：P2 框架 ∥ P3 droid 适配器 ∥ P4a ∥ P4b ∥ P4c
        └─► 波次 3：P5 装配 + 集成 + 真机一致性   ∥   P6 文档
```

跨包 import 约束见 §2.14。P5 是唯一同时消费 P2+P3 实现的包。

### 6.2 各包

#### P1 契约（小包，先行）

- **目标**：§2 全部冻结面 + 两个纯函数实现 + 测试；无运行时行为。
- **文件域**：`src/core/types.ts`、`src/core/errors.ts`、`src/core/external-meta.ts`（新）、`src/core/tool-preview.ts`（新）、
  `src/core/state-machine.ts`、`src/core/run-journal.ts`、`src/runtime/session-driver.ts`、`src/runtime/runner.ts`、`src/config/settings.ts`、
  `src/external-agent/{types,paths,messages,prompt,schema-extract}.ts`（新）、§2.13 所列测试文件。
- **冻结面**：§2 全部。**依赖**：无。
- **自验**：`npx vitest run tests/core tests/runtime tests/config/external-agents-settings.test.ts tests/external-agent && npx vitest run tests/commands/ && npm run typecheck`
- **验收**：①§2 签名逐条存在且与本文一致；`src/external-agent/types.ts` 无「由 P1 定」类注释；②`previewToolArgs` 既有测试零改动通过；
  ③matrix/property 含 `external_meta`，断言不改 `lastEventAt`、终态/stale 可接受；④pi 增量累加后 `diag.usage` 无 `unpriced` 键；`mergeUnpriced`
  全表；⑤runner：`ClassifiedError{auth}` reject ⇒ outcome.error.kind=auth；无 `getTurnErrorInfo` 的句柄既有 runner 测试全过；⑥设置：缺
  `externalAgents` 的文件得默认值、迁移不写新键、`pricing` 非法条目丢弃并 warn 一次；⑦`renderFirstMessage`/`extractStructuredJson` 用例全过；
  ⑧全量门禁（§8）绿。

#### P2 框架（provider 无关，pi-free）

- **目标**：§4.1/§4.2（通用部分）/§4.6/§4.7（存储侧）/§3.1/§3.3 实现。
- **文件域**：`src/external-agent/{router,process,jsonrpc,transcript,catalog-store,pricing,usage-ledger,redact}.ts`（新）；
  `tests/external-agent/{router,process,jsonrpc,transcript,catalog-store,pricing,usage-ledger,redact}.test.ts`；`tests/external-agent/fixtures/proc-*.mjs`。
- **冻结导出**：`export class RoutingSessionDriver implements SessionDriver { constructor(pi: SessionDriver, providers: ReadonlyMap<string, ExternalAgentProvider>) }`、
  `spawnManagedChild: SpawnChild`、`createJsonRpcClient: CreateJsonRpcClient`、`openTranscript: OpenTranscript`、`readTranscriptHeader: ReadTranscriptHeader`、
  `createCatalogStore(agentDir: string): CatalogStore`、`resolveExternalPricing: ResolveExternalPricing`、`priceUsage: PriceUsage`、
  `createUsageLedger: CreateUsageLedger`、`createRedactor(env: NodeJS.ProcessEnv): (text: string) => string`。（仅 P5 消费。）
- **依赖**：P1。
- **自验**：`npx vitest run tests/external-agent && npm run typecheck && ! grep -rn "from \"@earendil-works" src/external-agent/`
- **验收**：①`src/external-agent/**` 无 `@earendil-works` import，对 runtime 只 `import type`；②router：分派、错配 throw `ClassifiedError{config}`、
  WeakSet 识别、`resolveModelRef` 对外部 provider 返回 undefined；③process：组杀后孙进程无残留、SIGTERM 不理会 ⇒ killGrace 后 SIGKILL、ENOENT ⇒
  config、exit 钩子只在首次 spawn 安装、`extraEnv` 合并到子进程（fixture 回显 env 键名，不回显值）、`ownerWatchdog` 哨兵：父进程被 SIGKILL 后
  ≤3s 组内全灭且 stdin 正确透传（`0<&0`）、计时器全 unref；④jsonrpc：arch §13.1 jsonrpc 列全部用例 + `onRequest` 抛错 ⇒ -32603 且
  `onProtocolError`、应答写入抛错 ⇒ `onProtocolError`；⑤transcript：真 `projectSessionEntry` 可投影、头行 cwd 为 realpath、0600/0700、截断、32MiB、
  resume 接续 leaf、写失败降级；⑥pricing：§3.1 规则 0–7（含 basis/approx）+ 实测对照各例；⑦ledger：§3.3 L1–L8 各至少一例（含 resume 首条即基线、
  重复 turnId、回退、overcount、child partial、thinking 两口径、NaN、lastCall tier）；⑧全量门禁绿。

#### P3 droid 适配器

- **目标**：§4.2（envelope）/§4.3/§4.4/§4.5/§4.7（探测侧）/§4.9。
- **文件域**：`src/external-agent/droid/**`（`protocol.ts`、`envelope.ts`、`events.ts`、`terminal.ts`、`settings.ts`、`catalog.ts`、`session.ts`、
  `provider.ts`、`usage-fields.ts`）；`tests/external-agent/droid/**`；`tests/external-agent/fixtures/fake-droid.mjs`。
- **冻结导出**：`createDroidProvider(deps: ExternalFrameworkDeps, settings: () => DroidAgentSettings): ExternalAgentProvider`；
  `buildInitParams(o: { cwd: string; modelId: string; reasoningEffort?: string; sessionId?: string; autonomyLevel?: string }): Record<string, unknown>`
  （`autonomyLevel` 覆盖**仅供 conformance**，生产路径恒用 `DROID_AUTONOMY_FULL`）；`droid/protocol.ts` 常量（§9 末列为最终取值）：
  `DROID_PROTOCOL_VERSION="1.264.0"`、`DROID_API_VERSION="1.0.0"`、`DROID_TESTED_VERSIONS=["0.241.1"]`、`DROID_AUTONOMY_FULL="high"`、
  `DROID_AUTO_REJECT_PERMISSIONS=false`、`DROID_PERMISSION_REPLY={selectedOption:"proceed_once"}`、`DROID_PERMISSION_ACK_TIMEOUT_MS=10_000`、
  `DROID_CHILD_ENV={DISABLE_AUTO_UPDATE:"1",FACTORYD_DISABLE_AUTO_UPDATE:"1"}`、`DROID_EXITS_ON_STDIN_EOF=true`、`DROID_THINKING_IN_OUTPUT=true`、
  `DROID_CUMULATIVE_INCLUDES_CHILD=false`。所有 spike 相关取值只在这里。
- **依赖**：P1（不 import P2；测试注入假 `SpawnChild`/`JsonRpcClient`/`OpenTranscript`/`UsageLedger`/`CatalogStore`）。
- **自验**：`npx vitest run tests/external-agent/droid && npm run typecheck && node tests/external-agent/fixtures/fake-droid.mjs --self-test`
- **验收**：①样本回放 S/27、S/30、S/31、S/44、S/54、S/10 的 DriverEvent 序列喂真 reducer 无 illegal；②interrupt 重复 `tool_result` 去重；③§4.5 终态表
  逐行一测；④402 ⇒ `auth` 不可重试，文案含 `FACTORY_API_KEY` 与重启提示且不含凭据值；⑤init 与 update 参数都含 `autoRejectPermissionRequests:false`；
  `request_permission` ⇒ 同步回 `{selectedOption:"proceed_once"}` + approvals 计数；`ask_user`/未知 ⇒ -32601；回执超时 10s（FakeClock）⇒ 致命收口
  （interrupt 发出 + `terminate("now")` 被调用 + prompt reject config）；应答写入抛错 ⇒ 同样收口；⑥S5：update `-32602 Unknown model` ⇒ config + 候选，
  且 `add_user_message` 从未发出；生效值 autonomy≠high ⇒ fail closed；⑦**resume cwd**：头行 cwd 存在 ⇒ 断言 `spawnChild` 的 cwd 与 init 参数 cwd
  都等于头行 cwd（spec.cwd 故意给另一个目录）；头行 cwd 不存在 ⇒ reject config（`msgResumeCwdGone`）且 `spawnChild` 未被调用；⑧strict 漂移
  （入站版本不符）⇒ config 致命；warn ⇒ 继续 + degraded `protocol_drift` + warnOnce；`-32700 id:null` ⇒ internal 致命；⑨thinking：
  `thinking_text_delta` ⇒ `thinking_delta`，create_message 的 thinking 块不重复发；⑩`steer`/`requestAbort` idle 立即 resolve 不发送；`dispose` 同步幂等；
  `killableHandles` 宽限内 no-op；⑪`spawnChild` 收到的 `extraEnv` === `DROID_CHILD_ENV`；⑫fake-droid 支持 §7.2 全部模式且 `--self-test` 通过；⑬全量门禁绿。

#### P4a 提示词 / 设置 UI / 记忆导出

- **文件域**：`src/config/available-models.ts`、`src/sysprompt/core-sections.ts`、`src/config/setting-specs.ts`、`src/memory/inject.ts`、`src/memory/index.ts`；
  `tests/config/available-models-external.test.ts`、`tests/sysprompt/core-sections-external.test.ts`、`tests/memory/external-render.test.ts`、
  `tests/config/setting-specs-external.test.ts`、`tests/fixtures/available-models-golden.txt`（均新）。
- **冻结面**：§5.3、§5.6 签名。**依赖**：P1。
- **自验**：`npx vitest run tests/config tests/sysprompt tests/memory && npm run typecheck`
- **验收**：①`formatAvailableModelsForPrompt(m)`、`(m, undefined)`、`(m, [])` 与改动前逐字节一致（golden 在改动前生成并提交）；②external 子块
  文案（含 resume 钉目录一句）、上限、`… +N more`、pi 为空时仍输出；③TUI 只暴露 `enabled`、`injectMemory`、`protocolCheck`；④记忆导出遵循子会话
  `injectInChildSessions`/`childProfile`、tiered 与 legacy 各一例、异常返回 undefined；⑤全量门禁绿。

#### P4b 服务层门控

- **文件域**：`src/service/spawn-service.ts`、`src/service/runtime-adapter.ts`、`src/consult/index.ts`、`src/tools/set-model-tool.ts`；
  `tests/service/spawn-service-external.test.ts`、`tests/service/runtime-adapter-external.test.ts`、`tests/consult/resolve-experts-external.test.ts`、
  `tests/tools/set-model-external.test.ts`（均新）。
- **冻结面**：拒绝文案只用 §2.11；新增可选 dep：spawn-service `external?`（+ `agentDir?`）、runtime-adapter `external?`、consult `isExternalProvider?`、
  set-model-tool `externalOwns?`（P5 注入）。**依赖**：P1。
- **自验**：`npx vitest run tests/service tests/consult tests/tools/set-model-tool.test.ts tests/tools/set-model-external.test.ts && npm run typecheck`
- **验收**：①§5.1 每条拒绝零副作用（内部表大小不变）；②readonly + droid ⇒ `MSG_READONLY_DOMAIN`；外部 resume + isolation ⇒ `MSG_RESUME_ISOLATION`；
  ③端口缺席时 `droid/x` 报错与改动前逐字节一致；④resume：外部会话无 override ⇒ 继承 droid 模型；pi override ⇒ 拒绝；端口缺席 + 外部 sessionFile ⇒
  `msgResumeDisabled`；⑤adapter 外部 run：driver 收到的 spec 无 customTools/toolScope/systemPrompt，`external` 在 H2 后挂、cwd 为 post-H2；pi run 的
  driver 请求与改动前 deep-equal；⑥schema 两路 + verdict/v1；⑦consult：`diag.external` 或外部 sessionFile ⇒ 拒绝；**`isExternalProvider` 缺席时
  `diag.model.provider==="droid"` 的 pi run 不被拒**；set_model：`externalOwns` 缺席时 `droid/x` 走原未知模型路径；⑧全量门禁绿。

#### P4c 成本展示（unpriced）+ formatExternal

- **文件域**：`src/ui/fleet-widget.ts`、`src/tools/agent-tool.ts`、`src/tools/result-tool.ts`、`src/tools/result-text.ts`、`src/commands/status.ts`；
  `tests/tools/unpriced-display.test.ts`、`tests/tools/result-text-external.test.ts`、`tests/commands/status-unpriced.test.ts`（均新）。
- **冻结面**：`formatWidgetCost(costUsd: number, unpriced?: "all" | "partial"): string`（旧调用不变）；`formatExternal(meta: ExternalRunMeta | undefined): string | undefined`。
- **依赖**：P1。
- **自验**：`npx vitest run tests/tools tests/ui tests/commands && npm run typecheck`
- **验收**：①无 `unpriced` 时所有输出与改动前逐字节一致；②`all`/`partial` 两种渲染（partial 且可定价部分四舍五入为 0 时仍显示 `$0.0000+?`，不显示成 unpriced）；
  ③`/agent costs` Total 带 `(+N unpriced runs)`；④formatExternal：upstream / family-approx / consensus-approx / unpriced / partial 五例；⑤全量门禁绿。

#### P5 装配 + 集成 + 真机一致性

- **文件域**：`src/external-agent/port.ts`（新）、`src/stack.ts`、`src/index.ts`、`tsconfig.typecheck.json`；`tests/external-agent/port.test.ts`、
  `tests/integration/external-droid-chain.test.ts`、`tests/integration/external-droid-hang.test.ts`、`tests/integration/external-disabled-bytes.test.ts`、
  `tests/conformance/droid-protocol.test.ts`（均新）。
- **依赖**：P1–P4c 全部合入。
- **自验**：`npx vitest run tests/external-agent tests/integration/external-*.test.ts && npm run typecheck`；真机（手动、opt-in）：
  `source ~/.factory/env.sh && PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts`
- **验收**：①enabled=false：driver 是 `PiSessionDriver` 实例、无 `Symbol.for("pi-subagent:external-agent-procs")`、`process.listeners("exit")` 数量不变、
  `<agentDir>/external-agent` 与 catalog 缓存不存在、Available models 与 golden 一致、consult/set_model 未拿到 `isExternalProvider`/`externalOwns`；
  ②§7.2 全部场景通过（含 resume cwd 两例）；③conformance 无 env 时 skip、有 env 时 D1–D14 通过，结果贴 PR，并据 D10/D12/D13 结果回填
  `droid/protocol.ts` 常量（若需改值，单独小提交）；④`tsconfig.typecheck.json` include 增加 `tests/external-agent/**/*.ts`，fake 句柄
  `satisfies SessionHandle`；⑤全量门禁绿。

#### P6 文档

- **文件域**：`AGENTS.md`（新增 `src/external-agent/` 条目）、`skills/dev-flow/SKILL.md`（模型路由表加 droid 行：适合开发/探索，**不能**当 consult 专家、
  不能跑 tidy、resume 钉原目录、验收建议仍用 pi 模型）、`docs/dev/external-agent/README.md`（新：用户说明；`~/.factory/update-policy.json
{"disableAutoUpdate":true}` 强烈建议；近似价与已知缺口 §3.4；探测空会话 §4.7；R10 残余风险）。
- **依赖**：P4 系列合入；与 P5 并行。**验收**：`npm run format:check` 绿；AGENTS.md 条目与实现一致（评审抽查 5 处）。

---

## 7. 测试计划（汇总）

### 7.1 单元（各包自带，见 §6.2 验收）

| 区域           | 文件                                                                                                                                                                                                                                                     | 关键用例                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON-RPC       | `tests/external-agent/jsonrpc.test.ts`                                                                                                                                                                                                                   | 信封注入；字符串单调 id；超时清表；迟到响应计数；`-32700 id:null` 致命；反向请求同步应答、处理器抛错、应答写入抛错；跨 chunk 半行；超长行；非 JSON 阈值；EPIPE                        |
| 事件映射       | `tests/external-agent/droid/events.test.ts`                                                                                                                                                                                                              | 样本回放 + 真 reducer 无 illegal；turn 切分；tool_call 渐进 input 取最后；phase_changed 补 tool_start；完成时补 open tool 的 tool_end；llm_only 过滤；compaction；thinking 流（S/54） |
| 去重           | 同上                                                                                                                                                                                                                                                     | interrupt 重复 tool_result、`Batch cancelled` 第二条、重复 turnId                                                                                                                     |
| 终态/权限      | `tests/external-agent/droid/terminal.test.ts`、`droid/session.test.ts`                                                                                                                                                                                   | §4.5 全表；鉴权正则；429 retryable；§4.3 零卡死表逐行                                                                                                                                 |
| resume cwd     | `tests/external-agent/droid/provider.test.ts`                                                                                                                                                                                                            | 头行 cwd 钉死（spawn+init）；头行 cwd 缺失 ⇒ config、不 spawn                                                                                                                         |
| 计费           | `tests/external-agent/{pricing,usage-ledger}.test.ts`、`droid/usage-fields.test.ts`                                                                                                                                                                      | §3.1 规则 0–7 + basis/approx；§3.3 L1–L8；camelCase 字段归一                                                                                                                          |
| 状态机         | `tests/core/core.test.ts`                                                                                                                                                                                                                                | external_meta 任意状态接受、不刷新活性；unpriced 合并                                                                                                                                 |
| 关闭态字节一致 | `tests/config/available-models-external.test.ts`、`tests/service/spawn-service-external.test.ts`、`tests/consult/resolve-experts-external.test.ts`、`tests/integration/external-disabled-bytes.test.ts`、`tests/config/external-agents-settings.test.ts` | 提示词 golden；unknown-model 文案；字面 provider `droid` 的 pi run 不被误判；stack 无路由/无钩子/无写盘；迁移不加键                                                                   |

### 7.2 fake-droid 集成（`tests/integration/external-droid-{chain,hang}.test.ts`，真进程 + 真进程组 + 真时钟小预算）

fake-droid 模式（P3 实现）：`--script <jsonl>`（回放通知，支持 `{"delayMs"}`）、`hang-after-init`、`no-first-event`、`silent-turn`、`half-line`、
`crash-mid-turn`、`ignore-interrupt`、`ignore-sigterm`、`no-exit-on-eof`、`drift`（入站版本不符）、`envelope-reject`、`permission-request`（发请求，
**严格模拟 S2**：未收到 `{selectedOption}` 应答就永久等待；收到后发 `permission_resolved` 继续）、`permission-no-ack`（收到应答也不发
`permission_resolved`、永久等待）、`ask-user-request`、`http-402`、`stdout-garbage`、`spawn-grandchild`、`slow-init`、`usage-script`、`echo-cwd`
（把 `process.cwd()` 与 init 参数 cwd 写进通知）、`unknown-model-on-update`（update 回 -32602）。

| 零卡死场景                          | 期望                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 挂死（hang-after-init）             | `no_first_event` 超时 ⇒ `timed_out`；reap 后进程组全灭                                                                                                                                                                                                                         |
| 无事件（silent-turn）               | idle 超时 ⇒ `timed_out`；interrupt 不响应时 graceful→SIGKILL                                                                                                                                                                                                                   |
| 半行输出（half-line）               | 不解析残行、不崩；idle 兜底                                                                                                                                                                                                                                                    |
| 进程不退出（no-exit-on-eof）        | dispose ⇒ SIGTERM 组 ⇒ killGrace 后 SIGKILL                                                                                                                                                                                                                                    |
| SIGTERM 不理会（ignore-sigterm）    | killGrace 后 SIGKILL，`unkillable` 为空                                                                                                                                                                                                                                        |
| 反向请求（permission-request）      | 我方同步批准 ⇒ fake 继续 ⇒ `completed`；断言无悬挂请求                                                                                                                                                                                                                         |
| 批准无回执（permission-no-ack）     | ≤10s + requestTimeout 内 `failed{config}`（`msgPermissionUnacknowledged`），进程组全灭                                                                                                                                                                                         |
| 402（http-402）                     | `failed{auth}` 不可重试、只起 1 个进程、文案无凭据                                                                                                                                                                                                                             |
| 无效模型（unknown-model-on-update） | `failed{config}`（session_create），fake 从未收到 `add_user_message`                                                                                                                                                                                                           |
| resume cwd（echo-cwd）              | 首 run 在目录 A；resume 时 spec.cwd=B ⇒ fake 报告的进程 cwd 与 init cwd 都是 A；删除 A 后 resume ⇒ `failed{config}` 且未起进程                                                                                                                                                 |
| 其它                                | 完成；total+宽限+延长；abort（interrupt / 信号两路）；init 超时后迟到句柄被 `disposeLate` SIGKILL；resume 链；worktree H2 cwd 到达 init；schema 提取；grandchild 组杀无残留；`pi -p` 式退出时 exit 钩子清场；计费 priced/`unpriced:"all"`/child partial；`extraEnv` 到达子进程 |

### 7.3 真机 conformance（`tests/conformance/droid-protocol.test.ts`）

opt-in：`PI_TOOLKIT_DROID_CONFORMANCE=1` 且 PATH 有 droid 且 env 有 `FACTORY_API_KEY`，否则整体 skip。模型 `gpt-6-luna` effort `low`（D12 用 `high`）；
累计 credits ≤30k；HOME 已沙箱化。用例：

- D1 init 信封且入站 `factoryProtocolVersion === DROID_PROTOCOL_VERSION`（失败信息提示 bump 流程）。
- D2 问答映射且终结；D3 Execute start/end；D4 steer 并入；D5 interrupt → cancelled + 去重。
- D6 `autonomyLevel:"high"` + `autoRejectPermissionRequests:false` 经 init + update 后 echo 为 high；写文件 + `npm --version` 无 permission 请求。
- **D7 权限批准可触发验证**：用 `buildInitParams({ autonomyLevel:"off", … })`（仅测试覆盖）+ 生产同款 `onRequest`（`DROID_PERMISSION_REPLY`）让 droid 写文件
  ⇒ 必须出现 `droid.request_permission`，应答后出现 `permission_resolved(selectedOption=proceed_once)`、文件被创建、turn `completed`（S/44 同构）。
- D8 resume 记忆 + update 覆盖；D9 `get_context_stats` 形状；D10 **turn 进行中**（Execute `sleep 30`）关 stdin ⇒ ≤5s 退出（固化 `DROID_EXITS_ON_STDIN_EOF`）。
- D11 update 无效 modelId ⇒ `-32602 Unknown model`（S5 固化）。
- D12 用量：turn tokenUsage = 累计差（S10）；high effort 下 `thinkingTokens` 与 `outputTokens` 关系（固化 `DROID_THINKING_IN_OUTPUT`，E1）。
- D13 用 droid 原生 Task/SpawnAgent 触发子 agent ⇒ `childTokenUsage` 是否计入 `tokenUsage`/累计（固化 `DROID_CUMULATIVE_INCLUDES_CHILD`，E3）；若当前账号/版本无法触发则 skip 并记录。
- D14 让模型调用 AskUser ⇒ 我方 -32601 后 turn 有界结束（E5）。

---

## 8. 门禁（每包合入前，按序）

```sh
npm run format:check
npm run typecheck                 # 改了共享接口（P1、P4c）额外跑：npx vitest run tests/commands/
npm test                          # 全量 ~200s；计时类 flaky 先单独复跑该文件确认，再判定
npm run build
```

- `tests/commands/` 不在 typecheck include 内：P1、P4c 必须额外 `npx vitest run tests/commands/`。
- P5 起 `tests/external-agent/**` 纳入 typecheck（只纳入新目录）。
- conformance 不进门禁；P5 PR 与每次 droid 升级前手动跑并贴结果。

---

## 9. spike 实测结论 → 方案最终取值

> 依据 `droid-protocol.md` §13（第三轮）。「P5 固化」= 本机尚未实测，按所列默认值实现，由 P5 conformance 实测确认/回填常量。

| #   | 实测结论                                                                                                                                                        | 方案最终取值 / 做法                                                                                                                            | 落点       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S1  | `restrictToolIds` 经 update 是硬白名单（模型看不到其余工具）；init 里写了被回显但不生效；enabled/disabledToolIds 非白名单语义                                   | U2′ 不下发任何工具策略；`toolDomain:"readonly"` 仍**拒绝**（§1），白名单留作 v2 选项                                                           | §1         |
| S2  | 应答 = response `result:{selectedOption:"proceed_once"\|"cancel"}`；`autoRejectPermissionRequests:false` 时无超时永久等待（EOF 也不打断）；默认 ~1s 自动 cancel | init+update 显式 `false`；同步回 `DROID_PERMISSION_REPLY`；应答失败/处理器抛错/10s 无回执 ⇒ 致命收口（interrupt→SIGKILL）                      | §4.3、P3   |
| S3  | idle 关 stdin ~1s 自退 exit 0；pending permission 时 EOF 无效                                                                                                   | `DROID_EXITS_ON_STDIN_EOF=true`；**turn 中途 EOF 未测 ⇒ P5 固化（D10）**，不成立则启用已实现的 sh 哨兵；pending permission 场景走 SIGKILL 收口 | §4.1       |
| S4  | 只 init 也落会话文件                                                                                                                                            | 目录探测用固定 `probeCwd`，频率 ≤ 每 TTL 一次；README 披露                                                                                     | §4.7       |
| S5  | init 对无效 modelId 静默改默认 gpt-6-sol+high；update 干净返回 `-32602 Unknown model`                                                                           | 无条件 update + 生效值比对；update 报错 ⇒ config + 候选；校验通过前不发消息                                                                    | §4.4       |
| S6  | 请求侧版本不校验（1.200.0/9.9.9 被接受）；入站消息恒带 droid 自身版本                                                                                           | 检测点①②③有效；④只表示信封被拒（internal 致命，不当版本漂移）；结构守卫 + unknownNotifications + conformance 保留                              | §4.2       |
| S7  | 换 cwd resume 被接受并在新 slug 下重写全历史 ⇒ 分叉                                                                                                             | resume 一律钉头行 cwd（spawn + init）；头行 cwd 不存在 ⇒ config 拒绝、不回落；外部 resume + isolation ⇒ 准入拒绝                               | §4.4、§5.1 |
| S8  | `autonomyLevel:"high"` echo 可验证，`npm test`/`git commit`/`npm install`/`rm -rf` 全免确认，0 次权限请求                                                       | `DROID_AUTONOMY_FULL="high"`，生效值比对；不用 `skipPermissionsUnsafe`（echo 不可验证）                                                        | §4.4       |
| S9  | RPC 下 `--append-system-prompt-file` 生效                                                                                                                       | v1 仍走首条消息（resume 天然携带）；系统提示文件列为后续增强                                                                                   | §4.8       |
| S10 | turn tokenUsage = 本 turn 增量；新 turn 首条累计事件 = 基线；有 `lastCallTokenUsage`                                                                            | 账本 L1–L3 按此实现；tier 用 lastCall（L7）                                                                                                    | §3.3       |
| S11 | `thinking_text_delta` 流式全文；`thinking_text_complete` 不载文本；create_message 有 thinking 块                                                                | delta ⇒ `thinking_delta`；complete 不映射；块只在无 delta 时补发一次                                                                           | §4.9       |
| S12 | 启动时 deferred 自更新；可用 `~/.factory/update-policy.json` 或 env `DISABLE_AUTO_UPDATE` 禁用                                                                  | 子进程注入 `DROID_CHILD_ENV`（尽力而为，未做拦截实验）；README 要求用户设 update-policy（强保证）；二进制指纹重探 + strict                     | §4.1       |
| S13 | cwd 下不产生任何 droid 文件                                                                                                                                     | worktree H3 无需额外 ignore 规则；D12 后续升级时复查                                                                                           | —          |
| U4  | `availableModels` 唯一权威；id==modelId；factory 自托管模型无上游单价                                                                                           | §3.1 规则；factory 模型按家族厂商价近似、标 `basis:family, approx`，披露                                                                       | §3.1、§3.4 |
| E1  | 未实测（S11 中 thinkingTokens 与文本长度不匹配，存疑）                                                                                                          | `DROID_THINKING_IN_OUTPUT=true`；**P5 固化（D12）**                                                                                            | P3 常量    |
| E2  | 已由 S10 证实                                                                                                                                                   | turn 级 tokenUsage 作为对账权威                                                                                                                | §3.3       |
| E3  | 未实测                                                                                                                                                          | `DROID_CUMULATIVE_INCLUDES_CHILD=false`；**P5 固化（D13）**                                                                                    | P3 常量    |
| E4  | 已由 S8 证实                                                                                                                                                    | —                                                                                                                                              | §4.4       |
| E5  | 未实测                                                                                                                                                          | -32601；**P5 固化（D14）**；若挂，后续用 S1 的 `restrictToolIds` 排除 AskUser                                                                  | §4.3       |

---

## 10. 风险与回滚

| #   | 风险                                                                                                                                                                                                                        | 缓解                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 完整权限下 droid 执行破坏性命令（含 verifier/reviewer 等只读角色；S8 实测 `rm -rf` 免确认）                                                                                                                                 | 用户 U2′ 明确接受；worktree 隔离可用；README 披露；`toolDomain:"readonly"` 仍硬拒                                                 |
| R5  | 协议漂移（droid 自更新）                                                                                                                                                                                                    | 子进程 `DISABLE_AUTO_UPDATE` + README 要求 update-policy；strict fail closed + `warn` 逃生 + 指纹重探 + conformance               |
| R7  | 内存（292MB 二进制 × 并发）                                                                                                                                                                                                 | 共享 `concurrencyLimit` + sysload 闸门                                                                                            |
| R10 | **droid 读取用户全局 skills / AGENTS.md / MCP 配置**（droid-protocol §9：会话里注入了用户环境的 skills 列表），叠加 U2′ 完整权限 ⇒ 子 agent 可以全权限调用用户配置的 MCP 工具、受用户全局指令影响，爆炸半径大于 pi 子 agent | README 明示；建议在 droid 侧为 exec 场景收紧 MCP 配置；v2 可用 S1 的 `restrictToolIds` 排除 `MCP:*`；conformance 在沙箱 HOME 下跑 |
| R11 | resume 钉原目录：worktree 被清理后 droid run 不可 resume                                                                                                                                                                    | 文案明确（`msgResumeCwdGone`）；`kept` worktree 仍可 resume；准入拒绝 resume+isolation                                            |
| —   | 定价误配（中转价/错价）/ 近似价被当官方价                                                                                                                                                                                   | 规范 provider 优先 + 冲突即 unpriced + `pricing` 覆盖 + `approx` 标注；run 内价格冻结、diag 记 source/basis                       |
| —   | unpriced 在次要展示面显示为 $0                                                                                                                                                                                              | §3.4 已知缺口；主展示面已标注                                                                                                     |
| —   | 长 thinking 无事件被 idle 误杀                                                                                                                                                                                              | S11：high effort 下有 `thinking_text_delta` 流，事件不断；不合成心跳                                                              |
| —   | 孤儿进程（pi 被 SIGKILL）                                                                                                                                                                                                   | S3 EOF 自退（idle 已证）/ D10 固化 turn 中途 / sh 哨兵；droid Execute supervisor 2s 自清                                          |
| —   | 权限请求永久等待（S2）                                                                                                                                                                                                      | §4.3 有界收口；high 下实测不出现                                                                                                  |

**回滚**：①总开关 `externalAgents.droid.enabled=false`（默认）⇒ 不建端口/路由器/钩子、不探测、不写盘、提示词字节一致；恒开判定只用结构性证据
（`diag.external`、`<agentDir>/external-agent/` 路径），关闭态从不产生。②每包可单独 revert：P5 revert ⇒ 回到端口缺席路径；P4b/P4c revert 只影响
对应准入/展示；P1 是加法改动，revert 需同时 revert 下游包。③数据：`<agentDir>/external-agent/`、`<agentDir>/cache/external-agent/` 整目录可删，
不影响 pi 会话；droid 自己在 `~/.factory/sessions` 的会话文件不由 pi-toolkit 清理。

---

## 11. conflict-check 输入（`skills/dev-flow/scripts/conflict-check.mjs` 原生格式：JSON 数组 `{id, globs}`）

波次 2（并行派发前跑，期望 exit 0）：

```json
[
  {
    "id": "P2",
    "globs": [
      "src/external-agent/router.ts",
      "src/external-agent/process.ts",
      "src/external-agent/jsonrpc.ts",
      "src/external-agent/transcript.ts",
      "src/external-agent/catalog-store.ts",
      "src/external-agent/pricing.ts",
      "src/external-agent/usage-ledger.ts",
      "src/external-agent/redact.ts",
      "tests/external-agent/router.test.ts",
      "tests/external-agent/process.test.ts",
      "tests/external-agent/jsonrpc.test.ts",
      "tests/external-agent/transcript.test.ts",
      "tests/external-agent/catalog-store.test.ts",
      "tests/external-agent/pricing.test.ts",
      "tests/external-agent/usage-ledger.test.ts",
      "tests/external-agent/redact.test.ts",
      "tests/external-agent/fixtures/proc-*.mjs"
    ]
  },
  {
    "id": "P3",
    "globs": [
      "src/external-agent/droid/**",
      "tests/external-agent/droid/**",
      "tests/external-agent/fixtures/fake-droid.mjs"
    ]
  },
  {
    "id": "P4a",
    "globs": [
      "src/config/available-models.ts",
      "src/sysprompt/core-sections.ts",
      "src/config/setting-specs.ts",
      "src/memory/inject.ts",
      "src/memory/index.ts",
      "tests/config/available-models-external.test.ts",
      "tests/sysprompt/core-sections-external.test.ts",
      "tests/memory/external-render.test.ts",
      "tests/config/setting-specs-external.test.ts",
      "tests/fixtures/available-models-golden.txt"
    ]
  },
  {
    "id": "P4b",
    "globs": [
      "src/service/spawn-service.ts",
      "src/service/runtime-adapter.ts",
      "src/consult/index.ts",
      "src/tools/set-model-tool.ts",
      "tests/service/spawn-service-external.test.ts",
      "tests/service/runtime-adapter-external.test.ts",
      "tests/consult/resolve-experts-external.test.ts",
      "tests/tools/set-model-external.test.ts"
    ]
  },
  {
    "id": "P4c",
    "globs": [
      "src/ui/fleet-widget.ts",
      "src/tools/agent-tool.ts",
      "src/tools/result-tool.ts",
      "src/tools/result-text.ts",
      "src/commands/status.ts",
      "tests/tools/unpriced-display.test.ts",
      "tests/tools/result-text-external.test.ts",
      "tests/commands/status-unpriced.test.ts"
    ]
  }
]
```

波次 3：

```json
[
  {
    "id": "P5",
    "globs": [
      "src/external-agent/port.ts",
      "src/stack.ts",
      "src/index.ts",
      "tsconfig.typecheck.json",
      "tests/external-agent/port.test.ts",
      "tests/integration/external-droid-chain.test.ts",
      "tests/integration/external-droid-hang.test.ts",
      "tests/integration/external-disabled-bytes.test.ts",
      "tests/conformance/droid-protocol.test.ts"
    ]
  },
  { "id": "P6", "globs": ["AGENTS.md", "skills/dev-flow/SKILL.md", "docs/dev/external-agent/README.md"] }
]
```

P1（单独先行，不参与并行）：`src/core/{types,errors,external-meta,tool-preview,state-machine,run-journal}.ts`、`src/runtime/{session-driver,runner}.ts`、
`src/config/settings.ts`、`src/external-agent/{types,paths,messages,prompt,schema-extract}.ts`、§2.13 测试文件。

---

## 12. 给用户的一页摘要

1. droid 默认关闭（`externalAgents.droid.enabled:false`）；打开后用 `model:"droid/<id>"` 派子 agent，所有角色都以 droid 最高自治（`high`）运行，droid 的权限询问一律同步批准（显式关掉 droid 的「自动拒绝」）。
2. 唯一例外：程序内部的只读请求（`toolDomain:"readonly"`，目前只有 `/mem tidy`）**不能**用 droid 模型，直接拒绝。
3. 费用按 droid 上报的 token × pi 注册表里同一底层模型的官方价算；Factory 自托管的开源模型（kimi/glm/deepseek 等）按同名模型厂商 API 价**近似**并标 `approx`；找不到就显示 `unpriced`，可用 `externalAgents.droid.pricing` 手工指定。HUD、web-hub、pi 自带会话总计 v1 仍把 unpriced 算作 0。
4. droid run 的 resume **钉在原工作目录**：worktree 已被清理的 droid run 无法 resume（会明确报错）；resume 时不能再要求 isolation。
5. droid 升级后事件形状一变就可能整体拒绝（fail closed），需跑真机一致性测试后 bump；急用可设 `protocolCheck:"warn"`。强烈建议在 `~/.factory/update-policy.json` 写 `{"disableAutoUpdate":true}`（pi-toolkit 只给子进程注入禁用环境变量，不改你的全局配置）。
6. droid 会读你的全局 skills/AGENTS.md/MCP 配置，并以完整权限执行——MCP 工具也一样。
7. 项目记忆会拼进 droid 首条消息；consult/专家、message_agent、嵌套 Agent、set_model 在 droid run 上明确拒绝或降级；`schema` 靠最终 ```json 块提取，失败直接判失败（不重试）。

---

## 13. 修订记录 r2（2026-10-14，消化 review-r1 + spike §13）

| 评审项                          | 处置                                                                                                                                                                                                                                                                                                | 改动位置                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| #1 Blocker 分包依赖矛盾         | `renderFirstMessage`（`prompt.ts`）与 `extractStructuredJson`（`schema-extract.ts`）**上提进 P1，连实现带测试**；P2 文件域移除二者；§2.9 删除「`ExternalPricingDiagLike` 由 P1 定」改为直接用 core `ExternalPricingDiag`；`RoutingSessionDriver` 导出形态定为 class；新增 §2.14 独立 typecheck 矩阵 | §2.9、§2.12、§2.14、§6.2 P1/P2/P3/P4b、§11                       |
| #2 S7 resume cwd                | resume 一律钉 transcript 头行 cwd（spawn + init），头行 cwd 不存在 ⇒ `ClassifiedError{config, msgResumeCwdGone}`、不起进程、禁止回落；准入加「外部 resume + isolation」拒绝；P3 单测 + P5 集成各加用例                                                                                              | §2.9 `resume` 注释、§2.11、§4.4、§4.5、§5.1、§6.2 P3⑦/P4b②、§7.2 |
| #3 autoRejectPermissionRequests | 定值 `false`（init+update），`onRequest` 同步回 `{selectedOption:"proceed_once"}`，常量集中 `droid/protocol.ts`；零卡死表覆盖处理器抛错/应答写入失败/10s 无回执 ⇒ interrupt→SIGKILL 收口；D7 改为 conformance 用 `autonomyLevel:"off"` 测试覆盖可触发验证                                           | §2.9 JSON-RPC 注释、§2.11、§4.3、§4.5、§6.2 P3⑤、§7.2、§7.3 D7   |
| #4 S6                           | 检测点表改为实测结论：①②③有效，④只表示信封被拒（internal 致命）；保留结构守卫 + unknownNotifications + conformance                                                                                                                                                                                  | §4.2、§9                                                         |
| #5 S12                          | 采用注入：`ManagedChildOptions.env` 改为 `extraEnv`（叠加在 process.env 上），P3 传 `DROID_CHILD_ENV`；README 写 update-policy.json 强保证                                                                                                                                                          | §2.9、§4.1、§4.7、§6.2 P2③/P3⑪/P6、§9、§10 R5                    |
| #6 factory 近似计费             | `ExternalPricing` priced 分支加 `basis` + `approx`，诊断带 `basis/approx`；formatExternal 显示 `(family, approx)`；§3.4 与 README 披露                                                                                                                                                              | §2.1、§3.1、§3.4、§6.2 P4c④                                      |
| #7 关闭态恒开判定               | 删除 `KNOWN_EXTERNAL_PROVIDERS`；consult/set_model 端口缺席时只用 `diag.external` + 外部 sessionFile 路径；provider 名分支经可选 dep 仅在端口存在时注入；加「字面 provider droid 的 pi run 不被误判」测试                                                                                           | §2.10、§5.4、§5.5、§6.2 P4b⑦、§7.1                               |
| #8 R10                          | 风险表补 R10（全局 skills/AGENTS.md/MCP + 完整权限），README 写明                                                                                                                                                                                                                                   | §10、§6.2 P6、§12                                                |
| #9 conflict-check 格式          | §11 改为脚本原生 `[{id, globs}]` 数组，按波次分两段                                                                                                                                                                                                                                                 | §11                                                              |
| #10 formatWidgetCost 启发式     | `UsageDelta.unpriced` 由 `true` 改为 `"all" \| "partial"`（`mergeUnpriced` 合并），展示按标记区分，不看 costUsd≈0                                                                                                                                                                                   | §2.1、§2.2、§2.5、§3.4、§6.2 P4c                                 |
| #11 S11 兜底死代码              | 改为：`thinking_text_delta` ⇒ `thinking_delta`；`thinking_text_complete` 不映射；create_message thinking 块仅在该消息无任何 delta 时补发                                                                                                                                                            | §4.9、§9                                                         |
| spike §9 表                     | 整表改为「实测结论 → 最终取值」；仍未实测的 E1/E3/E5、S3（turn 中途 EOF）明确标「P5 固化」并给出 D10/D12/D13/D14                                                                                                                                                                                    | §9、§7.3                                                         |

**冻结面签名变动（相对 r1，P1 尚未合入故无迁移成本）**：`UsageDelta.unpriced` 类型 `true` → `"all" | "partial"`；`isUnpricedUsage` → `mergeUnpriced`；
`ExternalPricing` priced 分支新增 `basis`/`approx`，新增类型 `ExternalPricingBasis`，`ExternalPricingDiag` 新增 `basis?`/`approx?`；
`ManagedChildOptions.env` → `extraEnv`；`UsageLedger.observeCumulative` 新增可选 `lastCall`、`PriceUsage` 新增可选 `requestInputTokens`；
删除 `ExternalPricingDiagLike` 与 `KNOWN_EXTERNAL_PROVIDERS`；`isExternalSessionPath` 接受 `undefined`；`messages.ts` 新增
`msgResumeCwdGone`/`MSG_RESUME_ISOLATION`/`msgPermissionUnacknowledged`/`MSG_PERMISSION_REPLY_FAILED`；P1 新增 `prompt.ts`/`schema-extract.ts` 两个冻结函数；
P4b 新增可选 dep `isExternalProvider?`/`externalOwns?`；P4c `formatWidgetCost` 第二参数类型改为 `"all" | "partial"`；P3 新增导出 `buildInitParams`。

## 14. 修订记录 r3（2026-10-14，主会话补充，用户确认开工后）

- **用户确认**：开工；`toolDomain:"readonly"` 维持「直接拒绝走 droid」；unpriced 在 HUD / web-hub / pi 会话总计按 0 计接受为已知缺口（后续小包补标记）。
- **新增：异常退出时用会话文件对账（P3 实现，P5 集成测试覆盖）**。droid 进程在一轮未结束时退出（崩溃 / reaper 组杀 / 超时）会丢失该轮 `agent_turn_completed`，L1–L8 账本漏记。run 终态时若账本存在「已开始未结算」的 turn，best-effort 读取 `~/.factory/sessions/<cwd slug>/<sessionId>.settings.json` 的累计 tokenUsage（字段名以 droid-protocol.md §5 实测为准），与账本已记累计逐字段相减，正差额作为一次补记 usage（价格沿用 run 冻结价，`external_meta` 标 `reconciled:true`）；负差/缺字段/解析失败一律放弃且不报错。约束：只读、≤256 KiB、单次 ≤500ms 有界、不阻塞终态投递（超时即放弃）、绝不重复计费（同一 turnId 已结算则不补）、路径由 sessionId 推出且需 `O_NOFOLLOW` + 普通文件校验；不打印文件内容。P3 补单测（正差补记 / 负差放弃 / 文件缺失 / 超时放弃 / 已结算不补），P5 fake-droid 加「turn 中途 SIGKILL + 预置 settings.json」场景。不改冻结面（若需在 P1 类型加 `reconciled` 字段，在 P1 一并加入）。

## 15. P5 跟踪项（波次 2 验收遗留，2026-10-14 主会话汇总）

- P4b：runtime-adapter `planRun` 的 `persist` 取 `sessionSpec.persist ?? true`，与 PiSessionDriver 的 `?? rememberAgents` 口径不一致（rememberAgents=false 时 droid 仍写 transcript）⇒ P5 装配时注入 rememberAgents 兜底。
- P4b：外部会话 resume 只剩 tombstone 时不继承 droid 模型（tombstone 无 model 字段）⇒ P5 给 tombstone 记 model，或在文档里写明。
- P4b：consult 用 `dirname(dirname(consultDir))` 推 agentDir，P5 若改 consultDir 位置必须同步。
- P4a：§5.3 的 `(×<multiplier>)` 由 P5 把 tokenMultiplier 折进 `ExternalAdvertisedModel.note`；advertiseMax 截断也在 P5。
- P2：ENOENT 文案 `msgBinaryNotFound` 仍写 droid，接第二个 CLI 时泛化；`createSpawnChild(redact)` 让 provider 注入自己的脱敏键（`createRedactor(env, secretEnvKeys)`）。
- P2/P3：droid 专有信封字段 `type` 已从框架移到 `droid/envelope.ts`（b707053 + P3）。
- 冻结面：`runner` 无 create() 重试循环，`startup_transient` 暂不使用（types.ts 注释已改）。
- P3（验收 r_KZS914MP minor）：provider 的 init/update 阶段不监听进程早退（不调 rpc.failAll），droid 提前死亡要等 initTimeoutMs 才失败（有界但慢）⇒ P5 补早退监听 + 「init 期间进程早退」「echo 等待超时回落」两个用例（fake-droid `crash-mid-turn`/新增 `exit-during-init` 模式）。

### 15.x P7 验收转入的 P5 跟踪项（r_WC5KW7WM，P7 = `4d052c0`）

1. `stack.ts` 的 `createQuotaStack` 调用点注入 `droid: { pools: () => droidPoolPort }`（`createCatalogPoolPort`：catalog = `external.providers.get("droid")?.catalog.snapshot()`，preferred = `settings.externalAgents.droid.models`），构造后紧挨着 `refreshInBackground("stack_build")` **立即 `warm()`**。
2. P5 接线后去掉 `tests/integration/quota-wiring.test.ts` 中的 `vi.spyOn` 委托，补一条不用 spy 的端到端 droid 闸门用例。
3. `tests/integration/external-disabled-bytes.test.ts`：enabled=false ⇒ 零 api.factory.ai 请求 + 零 `[quota] droid` 告警；enabled=true 且 `quota.providers:""` ⇒ 同样零请求。
4. `tests/external-agent/port.test.ts`：`createCatalogPoolPort` 接真实 ExternalCatalog 形状；`warm()` 吞掉 catalog 抛错。
5. `src/index.ts` hook 的 `poolAlternatives` 行补一条走真实 stack 的 hook 集成用例。
6. SP4：真机抓包核对 billing 字段位置（P7 偏差 1：从响应顶层读）与 windowEnd 格式。
