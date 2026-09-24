---
# Quota-Aware Dispatch — 实施方案（quota-plan.md）

- 日期：2026-09-23
- 上游：`docs/dev/quota/quota-requirements.md`（用户已确认的设计简报）
- 车道：L2
- 状态：待评审 → 施工
---

## 0. 已核实的外部 API 契约（写代码前请勿再改签名）

全部经本仓库 `node_modules` 实读，不是推测：

| 事项             | 事实                                                                                                                                                                                            | 出处                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 凭据读取         | `readStoredCredential(providerId: string, authPath?: string): Credential \| undefined`，**同步、内部 try/catch、失败返回 undefined**，实现就是 `JSON.parse(readFileSync(authPath))[providerId]` | `@earendil-works/pi-coding-agent` 包根导出（`dist/index.d.ts:4` → `dist/core/auth-storage.js:417`） |
| Credential 形状  | `ApiKeyCredential { type: "api_key"; key?: string; env?: ProviderEnv }` \| `OAuthCredential { type: "oauth"; refresh; access; expires }`                                                        | `@earendil-works/pi-ai/dist/auth/types.d.ts:32`                                                     |
| auth.json 实况   | 本机存在 `zai-coding-cn` / `zai` / `kimi-coding` / `moonshot`，均为 `{type:"api_key", key}`                                                                                                     | `~/.pi/agent/auth.json`                                                                             |
| provider id 对齐 | pi models.json 的 provider id 与 auth.json 键**逐字相同**（`moonshot` / `kimi-coding` / `zai-coding-cn` / `zai`），所以 `ModelRef.provider → QuotaProviderId` 是恒等映射，不需要别名表          | `~/.pi/agent/models.json`                                                                           |
| 注入通道         | `pi.sendMessage(msg: Pick<CustomMessage,"customType"\|"content"\|"display"\|"details">, options?: { triggerTurn?: boolean; deliverAs? }): void`                                                 | `dist/core/extensions/types.d.ts:971`                                                               |
| 状态栏           | `ctx.ui.setStatus(key: string, text: string \| undefined): void`                                                                                                                                | `dist/core/extensions/types.d.ts:80`                                                                |
| agent 目录       | `getAgentDir()` 包根导出，仓库已在 `src/stack.ts:2`、`src/compact-hint/pi-settings.ts:3` 使用                                                                                                   | —                                                                                                   |

仓库侧锚点：

| 事项                                           | 位置                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Stack` 接口                                   | `src/stack.ts:468`                                                                                                                                                 |
| 上一会话 dispose 交接的模块级 `previous*` 变量 | `src/stack.ts:117–130`，在 `buildSessionStack` 顶部统一 dispose（`src/stack.ts:756–790`）                                                                          |
| turn_end 钩子注册（唯一一次 / activate 级）    | `src/index.ts:175` `pi.on("turn_end", createCompactHintHook(holder, {...}))`                                                                                       |
| HOST_KEY guard                                 | `src/index.ts`，`if (g[HOST_KEY]) return;`（其后的一切只在主会话注册）                                                                                             |
| spawn 准入链                                   | `src/service/spawn-service.ts` `service.spawn()`：deadline → unknown type → **model-hint 准入（`admittedModel` 定型处，行 ~285-305）** → X3 nesting → 第一处可变写 |
| `formatModelCandidates` 唯一调用点             | `src/service/spawn-service.ts:292`                                                                                                                                 |
| 状态栏 key 先例                                | `src/service/cache-keepalive.ts:147 safeSetStatus()`（try/catch 包裹、`ctx.ui && typeof ctx.ui.setStatus === "function"` 双探测）                                  |
| 重试/退避原语                                  | `src/web-search/resilience.ts`：`isRetryableError` / `backoffDelay` / `withRequestTimeout` / `sleep`（timer 已 `unref`）/ `redactSecrets`                          |
| 全局共享 provider 先例                         | `src/service/background-status.ts`（`Symbol.for` + identity-safe release）                                                                                         |

---

## 1. 决策点（先定，后面所有设计都依赖它）

### D1. 凭据读取方式 → **pi 包根导出的 `readStoredCredential`，env 变量做次级回退，绝不硬编码路径**

- **选择**：`import { readStoredCredential } from "@earendil-works/pi-coding-agent";`
- **理由**：
  1. 它是**包根公开导出**（不是深路径 import），与仓库已用的 `getAgentDir` 同级，不引入新的脆弱耦合面；
  2. **同步**——正好适配「spawn 闸门绝不 await」与「turn_end 不阻塞」；
  3. 内部自带 try/catch，`readStoredCredential` 本身就永不抛，天然符合静默降级纪律；
  4. 自己拼 `~/.pi/agent/auth.json` 会绕开 pi 的 `getAgentDir()`（可被 `PI_*` 环境覆盖）、`normalizePath`、BOM 剥离三层处理，是明确的下策。
- **降级链**（`src/quota/credentials.ts`）：`readStoredCredential(id)` → 若 `type !== "api_key"` 或 `key` 缺失/为空 → 读 `process.env[ENV_FALLBACK[id]]`（`ZAI_API_KEY` / `KIMI_CODING_API_KEY` / `MOONSHOT_API_KEY`）→ 仍无 ⇒ 返回 `undefined`，该 provider 本期永久跳过（不打 WARN 刷屏，只在首次 miss 时 `console.warn` 一次）。
- **配置值模板**：pi 的 `key` 允许是 `$ENV_VAR` 模板或 shell 命令（`resolve-config-value.ts`），而 `readStoredCredential` **不解析**它们。规则：值含 `$` ⇒ 只做单层 `process.env` 查表（`^\$\{?([A-Za-z_]\w*)\}?$` 全量匹配才替换）；值形如命令配置（含空格 / 以 `!` 开头）⇒ **直接放弃该 provider**（绝不 `execSync`，扩展里执行用户 shell 是安全红线）。

### D2. quota 拉取触发时机 → **懒触发为主（turn_end + session_start 预热），零周期定时器**

- **选择**：不装任何 `setInterval`/自重排 timer。
  - `session_start`（`buildSessionStack` 内）：fire-and-forget 预热一次 `refreshIfStale()`；
  - 每个 `turn_end`：**先同步读缓存出判定并注入**，再 fire-and-forget `refreshIfStale()`（下一轮才用得上新数据）；
  - `refreshIfStale()` 内部：`now - fetchedAt < refreshMs` ⇒ 直接 return；有在途请求 ⇒ 直接 return（per-provider 去重）。
- **理由**：
  1. AGENTS.md 铁律「ref'd timer 会卡死 `pi -p`」的根因是 timer 本身；**不装 timer 就没有这一整类风险**，也不需要 `isCurrent(self)` 那套 keepalive 级的实例身份守卫；
  2. 额度只在有 turn 时被消耗——**空闲时刷新没有信息价值**，刷了也没人看；
  3. 单次请求只在 turn 边界发起，天然不与 spawn 主路径竞争。
- **已知代价**：HUD 在长时间空闲后显示的是陈旧值。**缓解**：HUD 文本在 `age > refreshMs` 时追加 `·stale 12m`；快照 `age > staleAfterMs`（默认 1h）时**闸门降级为不阻断、只提示**（见 §7 风险矩阵 R5）。
- **被否方案**：定时器（引入 print-mode wedge 风险 + 实例身份守卫复杂度，换来的只有空闲期 HUD 新鲜度）；纯 spawn 触发（违反「spawn 路径绝不发网络请求」）。

### D3. 注入通道 → **照抄 compact-hint 的 `deps.sendMessage(..., { triggerTurn: false })`**

- **选择**：`pi.sendMessage({ customType: "subagent:quota", content, display, details }, { triggerTurn: false })`，在 `src/index.ts` 里以闭包 `sendMessage` 注入钩子（与 `createCompactHintHook` 的 `deps.sendMessage` 逐字同形）。
- **理由**：
  1. `triggerTurn:false` = 只进上下文、不额外起一轮模型调用 —— 这正是「零工具调用 / 免费参考值」的实现方式；
  2. `customType` 让消息在 transcript 里可被识别、可被后续 renderer/过滤器处理，和 `subagent:compact-hint` / `subagent:usage-tick` 同一族；
  3. `display` 可配（`quota.display`，默认 `true`），用户能看到模型看到的同一行。
- **被否**：`before_agent_start` 追加 system prompt（memory 的通道）——system prompt 进提示词缓存前缀，每轮变动的百分比会**把整段前缀打脏**，与 `src/cache-ttl/` 的全部努力正面冲突。**这是硬性排除理由，不是偏好。**
- **被否**：`pi.sendUserMessage`（会触发一轮，违背「零 turn」）。

### D4. L1 tick 防噪音 → **三闸串联：等级闩锁 + usedPct 网格闩锁 + 最小间隔；且每轮最多一条合并消息**

- **选择**（`shouldAnnounce`，纯函数，见 §5）：满足任一即发，否则静默：
  1. **等级抬升**：`level > last.level`（L0→L1、L1→L2、L2→L3 各必发一次）；
  2. **网格前进**：`gridStep(usedPct) > last.step`（网格 = `quota.tickStepPercent` 的整数倍，默认 10 ⇒ 50/60/70/80/90）；
  3. **重复计时到期**：`level >= 2 && now - last.at >= quota.repeatMs`（默认 30min）——L2/L3 会周期性复读，因为它要改变派单决策；L1 不复读。
  - 无论多少 provider 命中，**每轮只发一条合并消息**（所有 provider 拼在一个 `[quota]` 块里）。
  - **重新武装**：`level < last.level` 且 `usedPct <= last.usedPct - QUOTA_HYSTERESIS_PCT`（默认 15）⇒ 判定为真实窗口重置，清空该 provider 的闩锁（照抄 `USAGE_TICK_HYSTERESIS_PERCENT` 的边界抖动区分思路）。
- **理由**：单靠等级闩锁 ⇒ 55%→74% 全程只报一次，模型早忘了；单靠网格 ⇒ 每 10% 必报，L0 区间纯噪音；单靠时间 ⇒ 与用量脱钩。三闸并联后：L0 完全静默、L1 区间约 4 次（50/60/70）、L2/L3 半小时复读一次。与 compact-hint 的 `lastTickStep` + `COMPACT_HINT_COOLDOWN_MS` 同一套手法，仓库内已验证。

### D5. 速率预测采样 → **窗口 3h / 最少 2 样本 / 最短跨度 5min / 首末斜率**

- **选择**（`src/quota/forecast.ts`）：
  - 每次成功刷新给每个 `(provider, scope)` 追加一个 `{ at, usedPct }` 样本；
  - 环形缓冲：`maxSamples = 32`，丢弃 `at < now - FORECAST_WINDOW_MS`（默认 `3h`）的样本；
  - **最少 2 个样本**，且 `newest.at - oldest.at >= MIN_SPAN_MS`（默认 `5min`），否则 `etaMs = undefined`（不做预测，只走百分比阶梯）；
  - 斜率 = **首末两点**：`burnPctPerMs = (newest.usedPct - oldest.usedPct) / (newest.at - oldest.at)`；`<= 0` ⇒ 无预测；
  - `etaMs = (100 - newest.usedPct) / burnPctPerMs`；
  - **重置检测**：新样本 `usedPct <= prev.usedPct - QUOTA_HYSTERESIS_PCT` ⇒ **清空该环**（跨重置的斜率是负的/无意义）。
- **理由**：
  - 窗口 3h 对 5h 窗口足够覆盖一个有意义的段，对周窗口则天然偏保守（预测偏慢 ⇒ 少报警，方向安全）；
  - 最少 2 样本 + 5min 跨度：默认 10min 刷新下，**第 2 次刷新（≈10min）就能出预测**，同时 10% 整数量化的抖动（GLM `percentage` 是整数）不会被放大成假斜率；
  - 首末斜率而非最小二乘：**可测试性压倒精度**——用例可以手写两点直接算出期望 ETA；量化噪声已被 5min 跨度门吸收。最小二乘留作未来优化点，接口（`forecast(ring, now, opts)`）不变。
  - 样本环**只在内存**（不落盘）：跨进程重启的斜率毫无意义，落盘只会引入陈旧数据污染。

### D6.（补充决策）降位标记持久化 → **`~/.pi/agent/quota-state.json`，provider 级，双重过期**

见 §5.3。要点：文件级（而非 session entry），因为它必须跨 `/reload`、跨 `/new`、跨 pi 重启存活到窗口重置；用 session entry 会在 `/new` 后丢失。

---

## 2. 模块划分：`src/quota/` 文件清单

```
src/quota/
  types.ts            纯类型 + 常量。零 import（除 core/clock 的 type）。
  ladder.ts           纯：阈值 → 等级、窗口判定、provider 级取最高严重级、网格步、防噪音判定。
  forecast.ts         纯：燃烧率采样环 + ETA 预测 + 重置检测。
  render.ts           纯：全部中文文案模板 + HUD 行 + 候选模型额度标记。
  demotion.ts         降位标记持久化（仅 node:fs，pi-free；路径由调用方注入）。
  credentials.ts      pi-facing（唯一 import readStoredCredential 的文件）+ env 回退 + 配置值模板。
  http.ts             fetchJson：超时 / 重试退避 / UA / JSON 守卫 / 密钥脱敏。复用 web-search/resilience。
  adapters/
    types.ts          ProviderAdapter 契约（被 adapters 与 service 共享；从 ../types.ts re-export 的窄面）
    zai.ts            GLM Coding Plan：parseZaiQuota + zaiAdapter / zaiOverseasAdapter
    kimi.ts           Kimi Code 订阅：parseKimiQuota + kimiAdapter
    moonshot.ts       Moonshot 余额：parseMoonshotBalance + moonshotAdapter
    index.ts          ADAPTERS: Record<QuotaProviderId, ProviderAdapter> + selectAdapters(settings)
  service.ts          QuotaService：TTL 缓存 + 去重刷新 + 样本环 + 降位写入 + HUD setStatus + dispose。
  gate.ts             纯：spawn 同步闸门判定 + 替代模型挑选。
  hook.ts             turn_end 注入钩子（createQuotaHintHook）。pi 只依赖 ExtensionContext 类型。
  index.ts            barrel + createQuotaStack()（把上面拼成 stack.ts 的一行调用）。
```

**分层纪律**：`types / ladder / forecast / render / gate / demotion` **零 pi import**（可在纯 node 下单测）；`credentials / service / hook / index` 是 pi-facing 面；`http` 只依赖 `globalThis.fetch` + `../web-search/resilience.js`。

---

## 3. 导出接口签名（严格 TS：`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）

> 全部可选属性一律写成 `foo?: T | undefined`；构造对象字面量时一律用仓库既有的 `...(x === undefined ? {} : { x })` 惯用法。

### 3.1 `src/quota/types.ts`

```ts
import type { Millis } from "../core/types.js";

/** auth store / pi model registry 的 provider id（二者逐字相同，见 plan §0）。 */
export type QuotaProviderId = "zai-coding-cn" | "zai" | "kimi-coding" | "moonshot";
export const QUOTA_PROVIDER_IDS: readonly QuotaProviderId[] = ["zai-coding-cn", "zai", "kimi-coding", "moonshot"];
export function isQuotaProviderId(value: string): value is QuotaProviderId;

export type WindowScope = "5h" | "week";
/** L0 静默 / L1 提示 / L2 建议 / L3 强烈。数值可比较——provider 级取 max。 */
export type LadderLevel = 0 | 1 | 2 | 3;

export interface QuotaWindow {
  readonly scope: WindowScope;
  /** 已用百分比，0..100，解析层已 clamp。 */
  readonly usedPct: number;
  /** 窗口重置的 epoch ms；解析不出时 undefined（预测层据此关闭 ETA-vs-reset 比较）。 */
  readonly resetAt?: Millis | undefined;
}

export interface QuotaWindowsSnapshot {
  readonly provider: QuotaProviderId;
  readonly kind: "windows";
  readonly windows: readonly QuotaWindow[];
  readonly fetchedAt: Millis;
  /** GLM 的 data.level（"max"/"pro"…），仅用于 HUD 展示。 */
  readonly plan?: string | undefined;
}

export interface QuotaBalanceSnapshot {
  readonly provider: QuotaProviderId;
  readonly kind: "balance";
  /** available_balance，单位 CNY。可为负。 */
  readonly balanceCny: number;
  readonly fetchedAt: Millis;
}

export type QuotaSnapshot = QuotaWindowsSnapshot | QuotaBalanceSnapshot;

/** 网络层注入口：永不抛，失败/非 JSON/非 2xx 一律 undefined。 */
export type FetchJson = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal | undefined },
) => Promise<unknown | undefined>;

export interface AdapterDeps {
  readonly fetchJson: FetchJson;
  /** 已解析好的裸 key；undefined 时适配器必须立刻返回 undefined（不得发请求）。 */
  readonly apiKey: string | undefined;
  readonly now: () => Millis;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly signal?: AbortSignal | undefined;
}

export interface ProviderAdapter {
  readonly id: QuotaProviderId;
  readonly kind: QuotaSnapshot["kind"];
  /** 静默降级契约：**绝不抛**，任何异常/形状不符返回 undefined。 */
  fetchQuota(deps: AdapterDeps): Promise<QuotaSnapshot | undefined>;
}
```

### 3.2 `src/quota/ladder.ts`

```ts
import type { LadderLevel, Millis, QuotaSnapshot, QuotaProviderId, QuotaWindow, WindowScope } from "./types.js";

export interface LadderThresholds {
  readonly l1: number;
  readonly l2: number;
  readonly l3: number;
  /** ETA 低于此值直接 L3。 */
  readonly l3EtaMs: Millis;
}

export type LadderReason = "none" | "pct" | "forecast-before-reset" | "forecast-eta" | "exhausted";

export interface WindowVerdict {
  readonly scope: WindowScope;
  readonly usedPct: number;
  readonly level: LadderLevel;
  readonly reason: LadderReason;
  readonly resetAt?: Millis | undefined;
  /** 预测耗尽还需多久；无预测时 undefined。 */
  readonly etaMs?: Millis | undefined;
}

export interface ProviderVerdict {
  readonly provider: QuotaProviderId;
  /** 全部窗口（或余额规则）的**最高**严重级 —— Kimi 周耗尽陷阱的唯一正解。 */
  readonly level: LadderLevel;
  readonly windows: readonly WindowVerdict[];
  readonly balanceCny?: number | undefined;
  /** 持久化的「已降位」标记仍在有效期内。 */
  readonly demoted: boolean;
  readonly fetchedAt: Millis;
  /** 快照年龄超过 staleAfterMs —— 闸门据此退化为不阻断。 */
  readonly stale: boolean;
  readonly plan?: string | undefined;
}

/** 单窗口判定。etaMs 由调用方（service）从 forecast 注入，本函数保持纯。 */
export function windowLevel(
  window: QuotaWindow,
  input: { readonly now: Millis; readonly etaMs?: Millis | undefined; readonly thresholds: LadderThresholds },
): WindowVerdict;

/** 余额型（moonshot）：available <= 0 ⇒ L3；否则 L0（可选 warnCny 抬到 L2）。 */
export function balanceLevel(balanceCny: number, options?: { readonly warnCny?: number | undefined }): LadderLevel;

/** provider 级聚合：max(windows) ∪ demotion 地板（降位标记把等级钉在 >= 2）。 */
export function providerVerdict(
  snapshot: QuotaSnapshot,
  input: {
    readonly now: Millis;
    readonly thresholds: LadderThresholds;
    readonly staleAfterMs: Millis;
    readonly etaOf: (scope: WindowScope) => Millis | undefined;
    readonly demoted: boolean;
    readonly balanceWarnCny?: number | undefined;
  },
): ProviderVerdict;

/** usedPct 的线性网格步（step<=0 ⇒ 恒 0，即关闭网格闸）。 */
export function gridStep(usedPct: number, step: number): number;

export const QUOTA_HYSTERESIS_PCT = 15;
export const DEFAULT_THRESHOLDS: LadderThresholds; // { l1:50, l2:75, l3:90, l3EtaMs: 1_800_000 }
```

### 3.3 `src/quota/forecast.ts`

```ts
import type { Millis } from "../core/types.js";

export interface BurnSample {
  readonly at: Millis;
  readonly usedPct: number;
}

export interface ForecastOptions {
  readonly windowMs: Millis; // 默认 FORECAST_WINDOW_MS
  readonly minSpanMs: Millis; // 默认 FORECAST_MIN_SPAN_MS
  readonly minSamples: number; // 默认 2
  readonly maxSamples: number; // 默认 32
}
export const DEFAULT_FORECAST_OPTIONS: ForecastOptions;
export const FORECAST_WINDOW_MS = 10_800_000; // 3h
export const FORECAST_MIN_SPAN_MS = 300_000; // 5min

export interface ForecastResult {
  readonly etaMs?: Millis | undefined;
  readonly burnPctPerHour?: number | undefined;
  readonly samples: number;
  readonly skipped?: "too-few" | "too-short" | "not-burning" | undefined;
}

/** 追加一个样本并返回**新数组**（纯函数，不原地改）；检测到重置则只保留新样本。 */
export function pushSample(
  ring: readonly BurnSample[],
  sample: BurnSample,
  options?: Partial<ForecastOptions>,
): readonly BurnSample[];

export function forecast(ring: readonly BurnSample[], now: Millis, options?: Partial<ForecastOptions>): ForecastResult;
```

### 3.4 `src/quota/demotion.ts`

```ts
import type { Millis } from "../core/types.js";

export interface DemotionRecord {
  readonly provider: string;
  readonly level: 2 | 3;
  readonly markedAt: Millis;
  /** 触发窗口的 resetAt；未知时 markedAt + DEFAULT_DEMOTION_TTL_MS。 */
  readonly expiresAt: Millis;
}

export interface DemotionStore {
  get(provider: string, now: Millis): DemotionRecord | undefined;
  /** 幂等：同 provider 只在 level 抬升或已过期时改写；否则不落盘。 */
  mark(provider: string, level: 2 | 3, resetAt: Millis | undefined, now: Millis): void;
  /** 观测到窗口重置时显式清除。 */
  clear(provider: string): void;
  list(now: Millis): readonly DemotionRecord[];
}

export interface DemotionStoreOptions {
  /** 绝对路径，由 stack.ts 注入 join(getAgentDir(), "quota-state.json")。 */
  readonly path: string;
  readonly now: () => Millis;
  readonly warn?: ((message: string) => void) | undefined;
}

export const DEFAULT_DEMOTION_TTL_MS = 21_600_000; // 6h
export function createDemotionStore(options: DemotionStoreOptions): DemotionStore;
```

### 3.5 `src/quota/credentials.ts`

> M2（评审修订）：`CredentialResolver` **接口定义移入 `types.ts`**（Pack 0 交付，紧邻 `ProviderAdapter`），本文件 `import type` 引用——`QuotaServiceDeps` 因此不依赖 C 包编译产物。

```ts
import type { QuotaProviderId } from "./types.js";

export interface CredentialResolver {
  /** 同步；无凭据返回 undefined。首次 miss 打一次 WARN，之后静默。 */
  (provider: QuotaProviderId): string | undefined;
}
export interface CredentialResolverOptions {
  /** 测试注入点：默认 pi 的 readStoredCredential。 */
  readonly readCredential?: ((providerId: string) => unknown) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}
export function createCredentialResolver(options?: CredentialResolverOptions): CredentialResolver;

export const ENV_FALLBACK: Readonly<Record<QuotaProviderId, string>>;
// { "zai-coding-cn": "ZAI_API_KEY", zai: "ZAI_API_KEY",
//   "kimi-coding": "KIMI_CODING_API_KEY", moonshot: "MOONSHOT_API_KEY" }
```

### 3.6 `src/quota/http.ts`

```ts
import type { FetchJson } from "./types.js";

/** Cloudflare 拦裸 curl UA（Kimi 实测 403 error 1010）——默认带浏览器 UA。 */
export const DEFAULT_USER_AGENT: string;
export const QUOTA_REQUEST_TIMEOUT_MS = 10_000;
export const QUOTA_MAX_ATTEMPTS = 2; // 1 次 + 1 次重试；额度查询不值得 3 次

export interface FetchJsonOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly secrets?: readonly string[] | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}
/** 组合 withRequestTimeout + isRetryableError + backoffDelay（全部复用 web-search/resilience.js）。永不抛。 */
export function createFetchJson(options?: FetchJsonOptions): FetchJson;
```

### 3.7 `src/quota/adapters/*.ts`

```ts
// zai.ts
export function parseZaiQuota(raw: unknown, provider: QuotaProviderId, now: Millis): QuotaWindowsSnapshot | undefined;
export const zaiAdapter: ProviderAdapter; // id "zai-coding-cn", 默认 baseUrl https://open.bigmodel.cn
export const zaiOverseasAdapter: ProviderAdapter; // id "zai",           默认 baseUrl https://api.z.ai
export const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
/** unit:3 ⇒ "5h"，unit:6 ⇒ "week"，其余忽略。 */
export function zaiScopeOfUnit(unit: unknown): WindowScope | undefined;

// kimi.ts
export function parseKimiQuota(raw: unknown, now: Millis): QuotaWindowsSnapshot | undefined;
export const kimiAdapter: ProviderAdapter; // id "kimi-coding", 默认 baseUrl https://api.kimi.com
export const KIMI_USAGES_PATH = "/coding/v1/usages";

// moonshot.ts
export function parseMoonshotBalance(raw: unknown, now: Millis): QuotaBalanceSnapshot | undefined;
export const moonshotAdapter: ProviderAdapter; // id "moonshot", 默认 baseUrl https://api.moonshot.cn
export const MOONSHOT_BALANCE_PATH = "/v1/users/me/balance";

// adapters/index.ts
export const ADAPTERS: Readonly<Record<QuotaProviderId, ProviderAdapter>>;
export function selectAdapters(enabled: readonly QuotaProviderId[]): readonly ProviderAdapter[];
```

### 3.8 `src/quota/service.ts`

```ts
import type { Clock } from "../core/clock.js";
import type { QuotaSettings } from "../config/settings.js";

export interface QuotaService {
  /** **同步**读缓存判定（spawn 闸门 / hook / HUD 唯一入口）。永不发请求、永不抛。 */
  verdicts(now?: Millis): readonly ProviderVerdict[];
  verdictFor(provider: string, now?: Millis): ProviderVerdict | undefined;
  /** fire-and-forget；未过期或在途则空转。永不抛、永不返回被拒 Promise。 */
  refreshIfStale(): void;
  /** 仅测试：等待当前所有在途刷新落地。 */
  whenIdle(): Promise<void>;
  /** 单一所有者清理（M3 评审修订）：幂等。含 setStatus(undefined)、在途刷新落地后拒写 status、降位 flush。 */
  dispose(): void;
}

export interface QuotaServiceDeps {
  readonly settings: QuotaSettings;
  readonly clock: Clock;
  readonly adapters: readonly ProviderAdapter[];
  readonly credentials: CredentialResolver;
  readonly fetchJson: FetchJson;
  readonly demotions: DemotionStore;
  /** HUD 一行；不可用时省略（子会话/print 模式）。 */
  readonly setStatus?: ((text: string | undefined) => void) | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}
export function createQuotaService(deps: QuotaServiceDeps): QuotaService;
```

### 3.9 `src/quota/gate.ts`

```ts
import type { ModelCandidate, ModelRef } from "../config/model-hint.js";

export interface QuotaGateVerdict {
  readonly level: LadderLevel;
  /** 面向模型的快速失败文案（会成为 spawn config error 的 message）。 */
  readonly message: string;
  readonly alternatives: readonly string[]; // "provider/id"
}

export interface QuotaGateDeps {
  readonly verdictFor: (provider: string) => ProviderVerdict | undefined;
  readonly available: () => readonly ModelCandidate[];
  readonly blockAtLevel: LadderLevel; // settings.quota.gateLevel
  readonly now: Millis;
}
/** undefined = 放行。只读缓存，**零 IO、零 await**。 */
export function evaluateQuotaGate(model: ModelRef, deps: QuotaGateDeps): QuotaGateVerdict | undefined;

/** 按额度健康度给候选排序后取前 n 个「provider/id」。已 block 的 provider 一律排除。 */
export function pickAlternatives(
  blocked: string,
  deps: Pick<QuotaGateDeps, "verdictFor" | "available">,
  limit?: number,
): readonly string[];

/** formatModelCandidates 的 annotate 实参：返回 " [5h 92% ⛔]" 之类后缀或 undefined。 */
export function quotaAnnotation(
  candidate: ModelCandidate,
  verdictFor: (provider: string) => ProviderVerdict | undefined,
): string | undefined;
```

### 3.10 `src/quota/hook.ts`

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const QUOTA_CUSTOM_TYPE = "subagent:quota";

export interface QuotaAnnounceLatch {
  level: LadderLevel;
  step: number;
  at: Millis;
  usedPct: number;
}

/** 会话级可变状态，挂在 Stack 上（每次 session_start 重建；无模块级状态）。 */
export interface QuotaHintState {
  readonly enabled: boolean;
  readonly tickStepPercent: number;
  readonly repeatMs: Millis;
  readonly minIntervalMs: Millis;
  readonly display: boolean;
  /** provider → 上次播报的闩锁。 */
  readonly latches: Map<string, QuotaAnnounceLatch>;
  lastSentAt: Millis;
}

export interface QuotaHintDeps {
  readonly state: () => QuotaHintState | undefined;
  readonly verdicts: () => readonly ProviderVerdict[];
  readonly refresh: () => void;
  readonly sendMessage: (
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: false },
  ) => void;
  readonly now?: (() => Millis) | undefined;
}
export function createQuotaHintHook(deps: QuotaHintDeps): (event: unknown, ctx: ExtensionContext) => void;

/** 纯判定，单测直打（不经过钩子）。 */
export function shouldAnnounce(
  verdict: ProviderVerdict,
  latch: QuotaAnnounceLatch | undefined,
  input: { readonly now: Millis; readonly tickStepPercent: number; readonly repeatMs: Millis },
): { readonly announce: boolean; readonly next: QuotaAnnounceLatch };
```

### 3.11 `src/quota/render.ts`

```ts
export function formatResetAt(resetAt: Millis | undefined, now: Millis): string; // "02:11"
export function formatEta(etaMs: Millis | undefined): string; // "约 24 分钟"
export function formatScope(scope: WindowScope): string; // "5h" / "7d"

/** 单 provider 的一行摘要（进 tick 块与 HUD）。 */
export function renderProviderLine(v: ProviderVerdict, now: Millis): string;
/** L1 合并块（多个 provider 一行一个）。 */
export function buildQuotaTickText(verdicts: readonly ProviderVerdict[], now: Millis): string;
/** L2 建议块（含 ETA / reset / 降位建议）。 */
export function buildQuotaWarnText(v: ProviderVerdict, alternatives: readonly string[], now: Millis): string;
/** L3 强烈块（含本轮禁用 + 明确替代链 + 降位标记说明）。 */
export function buildQuotaBlockText(v: ProviderVerdict, alternatives: readonly string[], now: Millis): string;
/** 一次 turn 的完整注入文本：至多一条，内部按各 provider 的等级分段拼装。 */
export function buildQuotaMessage(
  sections: readonly { readonly verdict: ProviderVerdict; readonly alternatives: readonly string[] }[],
  now: Millis,
): string;
/** HUD 一行（含陈旧标记）。 */
export function renderQuotaStatus(
  verdicts: readonly ProviderVerdict[],
  now: Millis,
  refreshMs: Millis,
): string | undefined;
```

### 3.12 `src/quota/index.ts`

```ts
export interface QuotaStack {
  readonly service: QuotaService;
  readonly hintState: QuotaHintState;
  dispose(): void;
}
/** stack.ts 的唯一调用面。settings.quota.enabled=false 时返回 undefined。 */
export function createQuotaStack(input: {
  readonly settings: QuotaSettings;
  readonly clock: Clock;
  readonly statePath: string;
  readonly setStatus?: ((text: string | undefined) => void) | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}): QuotaStack | undefined;
export type { QuotaService, QuotaHintState, ProviderVerdict, QuotaSnapshot, LadderLevel };
```

> M3（评审修订）：`QuotaStack.dispose()` 是**纯转发**（`this.service.dispose()`）——所有清理（HUD `setStatus(undefined)`、在-flight 防护、降位 flush、幂等标志）收进 `QuotaService.dispose()` 单一所有者；`/new` 双重 dispose 路径安全（幂等），`session_shutdown` 只够得着 `stack.quota` 也不会漏清。

---

## 4. 接线（`src/index.ts` / `src/stack.ts`）

### 4.1 `src/stack.ts`

1. **模块级交接变量**（紧跟 `previousAdaptive` 之后，`src/stack.ts:129` 附近）：
   ```ts
   /** quota 服务：与 keepalive/adaptive 同款「下一次 build 顶部 dispose」交接。 */
   let previousQuota: QuotaStack | undefined;
   ```
2. **`buildSessionStack` 顶部 dispose**（紧跟 `previousAdaptive?.dispose()` 之后，`src/stack.ts:774` 附近）：
   ```ts
   previousQuota?.dispose();
   previousQuota = undefined;
   ```
3. **构造**（放在 `adaptive` 构造之后、fleet widget 之前，`src/stack.ts:1196` 附近）：
   ```ts
   const quota = settings.quota.enabled
     ? createQuotaStack({
         settings: settings.quota,
         clock: systemClock,
         statePath: join(getAgentDir(), "quota-state.json"),
         ...(settings.quota.hud ? { setStatus: (text) => safeSetQuotaStatus(ctx, text) } : {}),
         warn: (message) => console.warn(`[pi-subagent] ${message}`),
       })
     : undefined;
   previousQuota = quota;
   // 预热：fire-and-forget，绝不 await（session_start 必须保持同步快）。
   quota?.service.refreshIfStale();
   ```
   `safeSetQuotaStatus` 是本文件内的 4 行 helper，逐字照抄 `src/service/cache-keepalive.ts:147 safeSetStatus` 的 try/catch + `typeof ctx.ui.setStatus === "function"` 双探测，key 用 `"quota"`。
4. **`Stack` 接口新增两个可选字段**（`src/stack.ts:468` 内）：
   ```ts
   /** 额度感知派单（docs/dev/quota/）；settings.quota.enabled=false 时缺席。 */
   quota?: QuotaService;
   /** turn_end 注入的会话级闩锁状态；与 quota 同生共死。 */
   quotaHint?: QuotaHintState;
   ```
5. **返回对象**追加（与 `keepalive`/`adaptive` 同款条件展开）：
   ```ts
   ...(quota ? { quota: quota.service, quotaHint: quota.hintState } : {}),
   ```
6. **spawn 服务注入**（`src/stack.ts:1050` 附近，`createSpawnService` 的 deps 里，紧邻 `resolveModelHint`/`availableModels`）：
   ```ts
   ...(quota && settings.quota.gate
     ? {
         quotaGate: (model: { provider: string; id: string }) =>
           evaluateQuotaGate(model, {
             verdictFor: (p) => quota.service.verdictFor(p),
             available: models.available,
             blockAtLevel: settings.quota.gateLevel as LadderLevel,
             now: systemClock.now(),
           }),
       }
     : {}),
   ```

### 4.2 `src/index.ts`（assembly-only，只加两处）

1. **turn_end 钩子注册**，紧跟现有 `pi.on("turn_end", createCompactHintHook(...))` 之后（`src/index.ts:175` 之后）。位置在 HOST_KEY guard **之后** ⇒ 天然只在主会话注册，子会话零成本：
   ```ts
   // 额度感知派单（docs/dev/quota/quota-plan.md §5）：与 compact-hint 同一 turn_end
   // 通道、同一 sendMessage 形状；状态在 stack 里（每次 session_start 重建）。
   pi.on(
     "turn_end",
     createQuotaHintHook({
       state: () => holder.current?.quotaHint,
       verdicts: () => holder.current?.quota?.verdicts() ?? [],
       refresh: () => holder.current?.quota?.refreshIfStale(),
       sendMessage: (message, options) => pi.sendMessage(message, options),
     }),
   );
   ```
2. **session_shutdown / 防御性 session_start dispose**：在两处已有的 `stack.keepalive?.dispose(); stack.adaptive?.dispose();` 旁各加一行：

   ```ts
   holder.current.quota?.dispose(); // session_start 的防御分支
   stack.quota?.dispose(); // session_shutdown
   ```

   （M3 评审修订：`Stack.quota` 直接暴露 `QuotaService`，其 `dispose()` 是**唯一清理所有者**且幂等；`QuotaStack.dispose()` 纯转发。`/new` 路径「shutdown 一次 + 重建顶部一次」的双重 dispose 安全。）

3. **不新增任何工具、不新增任何命令**。零工具调用是本特性的核心价值。

### 4.3 `src/config/model-hint.ts`（唯一一处签名扩展，向后兼容）

```ts
export function formatModelCandidates(
  candidates: readonly ModelCandidate[],
  limit = 8,
  /** 可选后缀标注（额度标记）。返回 undefined 表示该候选无标注。 */
  annotate?: (candidate: ModelCandidate) => string | undefined,
): string;
```

实现只在 `.map` 里追加 `annotate?.(c) ?? ""`。**现有唯一调用点** `src/service/spawn-service.ts:292` 改为传入第三参（由新增的 `deps.quotaAnnotate` 提供，缺省时行为逐字节不变）。`tests/config/model-hint.test.ts` 现有用例全部不变即可通过。

### 4.4 `src/service/spawn-service.ts`（两处小改）

- `SpawnServiceDeps` 新增两个可选字段：
  ```ts
  /** 额度闸门（quota-plan §6）：**同步**、只读缓存、返回 undefined 放行。 */
  quotaGate?: (model: { provider: string; id: string }) => QuotaGateVerdict | undefined;
  /** unknown-hint 错误里给候选模型附额度标记。 */
  quotaAnnotate?: (candidate: ModelCandidate) => string | undefined;
  ```
- **闸门插入点**：`service.spawn()` 内，`admittedModel` 定型之后、X3 nesting 检查之前（即现有 model-hint 块的收尾处，`src/service/spawn-service.ts` 行 ~306），**严格早于任何可变状态写**（与 CC4/resume 的准入纪律一致）：
  ```ts
  // 额度闸门（quota-plan §6）：只读同步缓存，绝不发网络请求。越线 ⇒ 快速失败
  // 并直接给替代模型，不烧一个注定 429 的 run。
  if (admittedModel && deps.quotaGate) {
    const gate = deps.quotaGate(admittedModel);
    if (gate) return { error: { kind: "config", message: gate.message, retryable: false } };
  }
  ```

---

## 5. turn_end 注入逻辑（精确伪码）

### 5.1 钩子主体（`src/quota/hook.ts`）

```ts
export function createQuotaHintHook(deps: QuotaHintDeps) {
  const now = deps.now ?? (() => Date.now());
  return (_event: unknown, ctx: ExtensionContext): void => {
    // ① 模式门：子会话是 print 模式，派单信息对它毫无意义（与 compact-hint 逐字同款）
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const state = deps.state();
    if (!state || !state.enabled) return;

    const t = now();

    // ② 同步读缓存判定（永不 await、永不发请求）
    let verdicts: readonly ProviderVerdict[] = [];
    try {
      verdicts = deps.verdicts();
    } catch {
      verdicts = [];
    }

    // ③ 懒刷新：**先读后刷**，本轮用旧值，新值给下一轮。fire-and-forget。
    try {
      deps.refresh();
    } catch {
      /* 静默：可见性绝不能拖垮 turn */
    }

    if (verdicts.length === 0) return;

    // ④ 全局最小间隔（硬性防刷屏地板；L3 不受此限，见下）
    const sections: { verdict: ProviderVerdict; alternatives: readonly string[] }[] = [];
    for (const v of verdicts) {
      if (v.level === 0) {
        state.latches.delete(v.provider);
        continue;
      }

      // M1（评审修订）：stale 快照不进注入流 —— 只进 HUD，不复读、不推闩锁。
      // stale 时闸门放行（R5），任何「会被拦下」的承诺都是假的，宁可静默。
      if (v.stale) continue;

      const latch = state.latches.get(v.provider);
      const decision = shouldAnnounce(v, latch, {
        now: t,
        tickStepPercent: state.tickStepPercent,
        repeatMs: state.repeatMs,
      });
      if (!decision.announce) continue;
      state.latches.set(v.provider, decision.next);
      sections.push({ verdict: v, alternatives: pickAlternativesFor(v) });
    }
    if (sections.length === 0) return;

    const maxLevel = Math.max(...sections.map((s) => s.verdict.level)) as LadderLevel;
    // L3 绕过全局最小间隔（它直接改变本轮派单）；L1/L2 受 minIntervalMs 约束。
    if (maxLevel < 3 && state.lastSentAt > 0 && t - state.lastSentAt < state.minIntervalMs) {
      // 撤回本轮闩锁推进，避免「被间隔吞掉的那一步」永远不再播报
      for (const s of sections) state.latches.set(s.verdict.provider, latchBefore(s.verdict.provider));
      return;
    }

    // ⑤ 一轮一条合并消息
    try {
      deps.sendMessage(
        {
          customType: QUOTA_CUSTOM_TYPE,
          content: buildQuotaMessage(sections, t),
          display: state.display,
          details: {
            level: maxLevel,
            providers: sections.map((s) => ({
              provider: s.verdict.provider,
              level: s.verdict.level,
              demoted: s.verdict.demoted,
              windows: s.verdict.windows.map((w) => ({ scope: w.scope, usedPct: w.usedPct, level: w.level })),
            })),
          },
        },
        { triggerTurn: false },
      );
      state.lastSentAt = t;
    } catch (error) {
      console.warn(`[pi-subagent] quota hint send failed: ${String(error)}`);
    }
  };
}
```

> 注意 ⑤ 里 `latchBefore` 的细节：把闩锁回滚到进入本轮前的值（钩子内先把旧值存进一个局部 `Map`），否则「被最小间隔吞掉的那一次网格前进」会被误记为已播报。**这是必须写进实现的一个点，单测 `hook.test.ts` 用例 6 锁死它。**

### 5.2 阶梯判定（`ladder.ts::windowLevel`，纯）

```ts
function windowLevel(w, { now, etaMs, thresholds }): WindowVerdict {
  const pct = clamp(w.usedPct, 0, 100);

  // 1) 硬耗尽
  if (pct >= 100) return { ..., level: 3, reason: "exhausted" };

  // 2) 百分比网格
  let level: LadderLevel = pct >= thresholds.l3 ? 3 : pct >= thresholds.l2 ? 2 : pct >= thresholds.l1 ? 1 : 0;
  let reason: LadderReason = level > 0 ? "pct" : "none";

  // 3) 速率预测（「提前」的关键，可以把 60% 抬到 L2）
  if (etaMs !== undefined && etaMs >= 0) {
    // 3a) ETA 短于硬线 ⇒ L3（无论重置多远）
    if (etaMs < thresholds.l3EtaMs && level < 3) { level = 3; reason = "forecast-eta"; }
    // 3b) 预测在窗口重置**之前**耗尽 ⇒ 至少 L2
    //     resetAt 未知时不做此判定（无从比较）——只保留 3a。
    else if (w.resetAt !== undefined && now + etaMs < w.resetAt && level < 2) {
      level = 2; reason = "forecast-before-reset";
    }
  }
  // 反向：百分比高但马上重置 —— **不降级**（只报不慌由文案承担，
  // 降级会让 90% 的窗口在重置前 1 分钟被判 L0，随后被真实 429 打脸）。
  return { scope: w.scope, usedPct: pct, level, reason,
           ...(w.resetAt === undefined ? {} : { resetAt: w.resetAt }),
           ...(etaMs === undefined ? {} : { etaMs }) };
}
```

### 5.3 provider 级聚合 + 降位标记（`ladder.ts::providerVerdict`）

```ts
function providerVerdict(snapshot, { now, thresholds, staleAfterMs, etaOf, demoted, balanceWarnCny }) {
  const stale = now - snapshot.fetchedAt > staleAfterMs;

  if (snapshot.kind === "balance") {
    const level = balanceLevel(snapshot.balanceCny, { warnCny: balanceWarnCny });
    return {
      provider,
      level: demoted ? max(level, 2) : level,
      windows: [],
      balanceCny: snapshot.balanceCny,
      demoted,
      fetchedAt,
      stale,
    };
  }

  const windows = snapshot.windows.map((w) => windowLevel(w, { now, etaMs: etaOf(w.scope), thresholds }));
  // ★ Kimi 陷阱的唯一正解：provider 级 = 全部窗口取 **最高** 严重级。
  //   周窗口 used_ratio:1 (L3) 必须压过 5h 的 remaining:100 (L0)。
  let level = windows.reduce((acc, w) => (w.level > acc ? w.level : acc), 0 as LadderLevel);
  // ★ 降位标记是**地板**不是覆盖：越过 L2 后即便当前算出 L1，仍钉在 L2。
  if (demoted && level < 2) level = 2;
  return { provider, level, windows, demoted, fetchedAt, stale, ...(plan ? { plan } : {}) };
}
```

**降位标记的写入 / 过期（`service.ts` 在每次成功刷新后执行）**：

```
存哪：  ~/.pi/agent/quota-state.json（getAgentDir() 下，由 stack.ts 注入绝对路径）
        { "version": 1, "demotions": { "zai-coding-cn": { level, markedAt, expiresAt } } }
        原子写：tmp + rename（照抄 loadSettingsFromFile 的 `${path}.${process.pid}.tmp` 手法）
        读：首次 get 时惰性加载一次，之后全内存；写：write-through，内容未变则不落盘

为什么是文件而不是 session entry：
  标记要活到窗口重置（最长一周），必须跨 /reload、跨 /new、跨 pi 重启。
  session entry 在 /new 后消失，appendEntry 又只对当前会话可见 —— 语义不匹配。

写入：  刷新后 providerVerdict(level>=2) ⇒ demotions.mark(provider, level, earliestResetAtOfTriggeringWindows, now)
        mark() 幂等：仅在 (无记录 | 已过期 | 新 level 更高) 时改写并落盘。

过期（双保险，任一命中即清）：
  ① TTL：now >= expiresAt（expiresAt = 触发窗口的 resetAt；未知则 markedAt + 6h）
  ② 观测重置：新快照中该 provider 的**全部**窗口 usedPct 都 <= 旧值 - QUOTA_HYSTERESIS_PCT(15)
     ⇒ demotions.clear(provider) 并清空该 provider 的全部 forecast 样本环
  ③ 文件损坏/不可读 ⇒ 视为空表（静默），标记退化为「本进程内存有效」
```

### 5.4 防噪音判定（`hook.ts::shouldAnnounce`，纯）

```ts
function shouldAnnounce(v, latch, { now, tickStepPercent, repeatMs }) {
  const pct = Math.max(0, ...v.windows.map((w) => w.usedPct)); // provider 的代表百分比
  const step = gridStep(pct, tickStepPercent);
  const next = { level: v.level, step, at: now, usedPct: pct };

  if (!latch) return { announce: true, next }; // 首次进入 L>=1

  // 重新武装：等级下降 + 百分比真实回落 ⇒ 窗口重置，闩锁作废
  if (v.level < latch.level && pct <= latch.usedPct - QUOTA_HYSTERESIS_PCT) return { announce: v.level >= 1, next };

  if (v.level > latch.level) return { announce: true, next }; // 闸① 等级抬升
  if (step > latch.step) return { announce: true, next }; // 闸② 网格前进
  if (v.level >= 2 && now - latch.at >= repeatMs) return { announce: true, next }; // 闸③ L2+ 复读
  return { announce: false, next: latch };
}
```

### 5.5 注入文案模板（中文，`render.ts`）

**L1（tick，合并块）**

```
[quota] zai-coding-cn 5h 62% · 7d 21% | kimi-coding 5h 8% · 7d 100% ⛔ | moonshot ¥12.30
```

**L2（建议）**

```
[quota 预警] zai-coding-cn 5h 已用 78%（阈值 75%），按当前速率约 41 分钟后耗尽，早于窗口重置（02:11）。
本轮派单建议：把新任务优先交给 kimi-coding/kimi-k3、cloudrouter-anthropic/claude-opus-5；
zai-coding-cn 在回退链中降一位（已标记，持续到窗口重置）。
```

**L3（强烈 + 禁用）**

```
[quota 严重] zai-coding-cn 5h 已用 93%，预计 18 分钟内耗尽（窗口 02:11 重置）。
本轮禁止把新任务派给 zai-coding-cn —— 直接使用：kimi-coding/kimi-k3 → cloudrouter-anthropic/claude-opus-5。
继续派给该 provider 会在 spawn 阶段被快速失败拦下（不会消耗 run）。
```

**降位标记的持续携带**：任一 provider `demoted === true` 时，其在 L1 tick 行尾恒追加 `⤓demoted`：

```
[quota] zai-coding-cn 5h 41% · 7d 19% ⤓demoted(→02:11) | kimi-coding 5h 8% · 7d 12%
```

**stale 快照（M1 评审修订）**：`verdict.stale === true` 的 provider **完全不进注入流**（只进 HUD，HUD 行带 `·stale Nm`）。原因：stale 时闸门放行（R5），注入文案若继续承诺「会被 spawn 拦下」就是向模型传递假执行语义；宁可静默，真实 429 走原有回退链。紧凑标记一律英文 token（`5h`/`7d`/`·stale`/`⤓demoted`，见 AGENTS.md UI text language split），中文只出现在 L2/L3 成段建议文案里。

**余额型（moonshot）**：`available_balance > 0` ⇒ 只在 tick 行显示 `moonshot ¥12.30`；`<= 0` ⇒ 按 L3 走 `buildQuotaBlockText`，文案换成「moonshot 余额已耗尽（¥-5.04），本轮禁止派单」。

---

## 6. spawn 闸门挂点

| 项               | 决定                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **挂点层**       | `src/service/spawn-service.ts` 的 `service.spawn()`，**model-hint 准入之后、X3 nesting 检查之前**（`admittedModel` 刚定型的那一行下面）。原因：此处 `admittedModel` 已是确定的 `{provider,id}`，且**仍在「零副作用准入区」**——尚未写 `resumeLocks`/`labels`/`nesting`/`running`，与 CC4 的准入纪律完全一致，被拒的请求不留任何需要清理的状态。 |
| **同步性**       | `deps.quotaGate` 签名是同步的（返回值不是 Promise）。它只调用 `QuotaService.verdictFor()`，后者只读内存 Map。**类型层面就杜绝了在 spawn 路径发请求的可能。**                                                                                                                                                                                   |
| **阻断条件**     | `verdict.level >= settings.quota.gateLevel`（默认 3）**且** `verdict.stale === false`。陈旧快照绝不阻断（见 R5）。                                                                                                                                                                                                                             |
| **快速失败文案** | 见下                                                                                                                                                                                                                                                                                                                                           |
| **候选标记**     | `formatModelCandidates(candidates, 8, quotaAnnotation)`                                                                                                                                                                                                                                                                                        |

**快速失败错误文案**（成为 `{ kind: "config", retryable: false }` 的 message）：

```
quota gate: zai-coding-cn 的 5h 配额已用尽（98%，02:11 重置），本次 spawn 已快速失败，未消耗任何 run。
改用这些模型之一：kimi-coding/kimi-k3、cloudrouter-anthropic/claude-opus-5、newapi-aws/claude-opus-5。
（在 ~/.pi/agent/pi-subagent.json 里把 quota.gate 设为 false 可关闭本闸门。）
```

`retryable: false` 的理由：同一 provider 重试只会再撞一次墙；`retryable:true` 会让上游重试机制空转。

**`quotaAnnotation` 的标记形状**（附加在 `Available: ...` 列表的每个候选后）：

```
Available: zai-coding-cn/glm-5.3 [5h 93% ⛔], kimi-coding/kimi-k3 [5h 8%], cloudrouter-anthropic/claude-opus-5, …
```

- 无快照 / 非受管 provider ⇒ 返回 `undefined`（零标记，输出与今天逐字节相同）；
- L1 ⇒ `[5h 62%]`；L2 ⇒ `[5h 78% ⚠]`；L3 ⇒ `[5h 93% ⛔]`；
- 取该 provider **等级最高**的那个窗口来标注（Kimi 会显示 `[周 100% ⛔]`）。

**`pickAlternatives` 排序键**（稳定、可测）：`(level asc, maxUsedPct asc, 注册表顺序 asc)`，排除被阻断的 provider 本身与任何 `level >= gateLevel` 的 provider，取前 3。

---

## 7. HUD 接线

**选择：独立 status key `"quota"`，由 `QuotaService` 自己写，不改 `src/hud/`。**

- 理由：
  1. `src/service/cache-keepalive.ts:147` 已经确立了「服务自己 `ctx.ui.setStatus(key, text)`」的先例，HUD footer 的渲染器（`src/hud/footer.ts`）本身就会把所有扩展 status 聚合显示；
  2. **解耦**：`hud.enabled=false` 时 quota 状态仍可显示（pi 内置 footer 也渲染 status），`quota.enabled=false` 时 HUD 完全无感；
  3. 不动 `src/hud/` ⇒ HUD 的 1800+ 测试与 `HudSession` 生命周期零风险。
- 写入点：`QuotaService` 在**每次刷新落地后**和**创建时**调用注入的 `setStatus(text)`；`dispose()` 时调用 `setStatus(undefined)` 清行。
- `setStatus` 由 `stack.ts` 注入，包在 `safeSetQuotaStatus(ctx, text)` 里（try/catch + 双探测），因为 ctx 可能已陈旧/无 UI。
- 文本（`renderQuotaStatus`）：
  ```
  quota zai 62%/21% · kimi 8%/100%⛔ · ¥12.3
  ```
  年龄超过 `refreshMs` 时追加 ` ·stale 12m`；全部 provider 无快照时返回 `undefined`（不占位）。
- 门：`settings.quota.hud`（默认 `true`）；为 `false` 时 `createQuotaStack` 不传 `setStatus`，服务内部 `setStatus === undefined` 直接跳过。

---

## 8. Settings 字段清单

### 8.1 `src/config/settings.ts`

```ts
export interface QuotaSettings {
  enabled: boolean;
  /** 逗号分隔的 provider id 白名单；空串 = 全部关闭。未知 id 静默忽略。 */
  providers: string;
  /** 快照 TTL：早于此不重新请求。 */
  refreshMs: number;
  /** 超过此龄的快照视为陈旧：只提示、闸门不阻断。 */
  staleAfterMs: number;
  l1Percent: number;
  l2Percent: number;
  l3Percent: number;
  /** ETA 低于此值直接判 L3。 */
  l3EtaMs: number;
  /** L1 tick 的 usedPct 网格步；0 = 关闭网格闸（只剩等级闩锁）。 */
  tickStepPercent: number;
  /** 两条 quota 消息之间的全局最小间隔（L3 不受限）。 */
  minIntervalMs: number;
  /** L2+ 的复读周期。 */
  repeatMs: number;
  /** 注入消息是否在 transcript 可见。 */
  display: boolean;
  /** spawn 闸门总开关。 */
  gate: boolean;
  /** 触发阻断的最低等级（2 = 更激进，3 = 默认）。 */
  gateLevel: number;
  /** HUD status key。 */
  hud: boolean;
  /** 单次 HTTP 超时。 */
  requestTimeoutMs: number;
  /** moonshot 余额低于此值（CNY）抬到 L2；0 = 关闭（只显示不打扰，符合简报）。 */
  balanceWarnCny: number;
  zaiBaseUrl: string;
  zaiOverseasBaseUrl: string;
  kimiBaseUrl: string;
  moonshotBaseUrl: string;
  /** Cloudflare 需要浏览器 UA（Kimi 实测）。空串 = 用内置默认。 */
  userAgent: string;
}
```

在 `AgentSettings` 里加 `quota: QuotaSettings;`（放在 `cacheTtl` 与 `goal` 之间，保持块顺序可读）。

### 8.2 `DEFAULT_SETTINGS.quota`

```ts
quota: {
  enabled: true,
  providers: "zai-coding-cn,zai,kimi-coding,moonshot",
  refreshMs: 600_000,        // 10min（简报的 refreshMinutes: 10）
  staleAfterMs: 3_600_000,   // 1h
  l1Percent: 50,
  l2Percent: 75,
  l3Percent: 90,
  l3EtaMs: 1_800_000,        // 30min（简报的 ETA < 30min）
  tickStepPercent: 10,
  minIntervalMs: 300_000,    // 5min
  repeatMs: 1_800_000,       // 30min
  display: true,
  gate: true,
  gateLevel: 3,
  hud: true,
  requestTimeoutMs: 10_000,
  balanceWarnCny: 0,
  zaiBaseUrl: "https://open.bigmodel.cn",
  zaiOverseasBaseUrl: "https://api.z.ai",
  kimiBaseUrl: "https://api.kimi.com",
  moonshotBaseUrl: "https://api.moonshot.cn",
  userAgent: "",
},
```

> **对简报的一处有意偏离**：简报写 `quota.refreshMinutes`，这里定为 `refreshMs`（文件里存 `quota.refreshS` = 600）。理由：仓库的时长字段**强制**走 `*Ms`(内存)/`*S`(文件) 双域约定（`TIME_SETTING_MS_PATHS` + `time-units.ts`），`hud.autoFetchMinutes` 是唯一的历史例外。简报明确把命名定稿权交给 Plan。

### 8.3 `parseQuotaSettings`（照 `parseCacheTtlSettings` / `parseMemorySettings` 的 `bool()`/`num()`/`str()` 手法）

```ts
export function parseQuotaSettings(input: unknown): QuotaSettings {
  const defaults = DEFAULT_SETTINGS.quota;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const bool = (raw, fb) => (typeof raw === "boolean" ? raw : fb);
  const num = (raw, fb, min, max) =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fb;
  const str = (raw, fb) => (typeof raw === "string" ? raw : fb); // 注意：providers 允许空串
  const url = (raw, fb) => {
    const v = typeof raw === "string" ? raw.trim() : "";
    return /^https?:\/\//i.test(v) ? v.replace(/\/+$/, "") : fb; // 非 http(s) 一律回落默认
  };
  // 阈值单调性钳制：l1 <= l2 <= l3，越界者被后者顶上去（配置写反不会静默失效）
  const l1 = num(value.l1Percent, defaults.l1Percent, 1, 100);
  const l2 = Math.max(l1, num(value.l2Percent, defaults.l2Percent, 1, 100));
  const l3 = Math.max(l2, num(value.l3Percent, defaults.l3Percent, 1, 100));
  return {
    enabled: bool(value.enabled, defaults.enabled),
    providers: str(value.providers, defaults.providers),
    refreshMs: num(value.refreshMs, defaults.refreshMs, 60_000, 86_400_000),
    staleAfterMs: num(value.staleAfterMs, defaults.staleAfterMs, 60_000, 604_800_000),
    l1Percent: l1,
    l2Percent: l2,
    l3Percent: l3,
    l3EtaMs: num(value.l3EtaMs, defaults.l3EtaMs, 0, 86_400_000),
    tickStepPercent: num(value.tickStepPercent, defaults.tickStepPercent, 0, 50),
    minIntervalMs: num(value.minIntervalMs, defaults.minIntervalMs, 0, 86_400_000),
    repeatMs: num(value.repeatMs, defaults.repeatMs, 0, 86_400_000),
    display: bool(value.display, defaults.display),
    gate: bool(value.gate, defaults.gate),
    gateLevel: num(value.gateLevel, defaults.gateLevel, 1, 3),
    hud: bool(value.hud, defaults.hud),
    requestTimeoutMs: num(value.requestTimeoutMs, defaults.requestTimeoutMs, 1_000, 60_000),
    balanceWarnCny:
      typeof value.balanceWarnCny === "number" && Number.isFinite(value.balanceWarnCny) && value.balanceWarnCny >= 0
        ? value.balanceWarnCny
        : defaults.balanceWarnCny, // 不取整（¥0.5 有意义）
    zaiBaseUrl: url(value.zaiBaseUrl, defaults.zaiBaseUrl),
    zaiOverseasBaseUrl: url(value.zaiOverseasBaseUrl, defaults.zaiOverseasBaseUrl),
    kimiBaseUrl: url(value.kimiBaseUrl, defaults.kimiBaseUrl),
    moonshotBaseUrl: url(value.moonshotBaseUrl, defaults.moonshotBaseUrl),
    userAgent: str(value.userAgent, defaults.userAgent),
  };
}
```

在 `loadSettings` 的返回对象里加 `quota: parseQuotaSettings(value.quota),`。

### 8.4 `TIME_SETTING_MS_PATHS` 追加

```ts
"quota.refreshMs", "quota.staleAfterMs", "quota.l3EtaMs",
"quota.minIntervalMs", "quota.repeatMs", "quota.requestTimeoutMs",
```

### 8.5 `SETTING_SPECS` 追加（全部非 live —— activate 时捕获，改后 `/reload`）

```ts
"quota.enabled": bool("quota.enabled", "Quota-aware dispatch: ladder warnings + spawn gate + HUD"),
"quota.providers": { kind: "string", path: "quota.providers",
  description: "Comma-separated quota providers (zai-coding-cn,zai,kimi-coding,moonshot); empty = none" },
"quota.refreshS": seconds("quota.refreshMs", { min: 60, max: 86_400, description: "Quota snapshot TTL" }),
"quota.staleAfterS": seconds("quota.staleAfterMs", { min: 60, max: 604_800,
  hint: "older snapshots warn but never block a spawn", description: "Snapshot age after which the gate stops blocking" }),
"quota.l1Percent": count("quota.l1Percent", 1, "L1 hint threshold (used %)"),
"quota.l2Percent": count("quota.l2Percent", 1, "L2 advise threshold (used %)"),
"quota.l3Percent": count("quota.l3Percent", 1, "L3 strong threshold (used %)"),
"quota.l3EtaS": seconds("quota.l3EtaMs", { max: 86_400, description: "Predicted exhaustion horizon that forces L3" }),
"quota.tickStepPercent": count("quota.tickStepPercent", 0, "Used-% grid between L1 ticks; 0 = level latch only"),
"quota.minIntervalS": seconds("quota.minIntervalMs", { max: 86_400,
  hint: "L3 bypasses this floor", description: "Global minimum interval between quota messages" }),
"quota.repeatS": seconds("quota.repeatMs", { max: 86_400, description: "L2+ re-announce period" }),
"quota.display": bool("quota.display", "Show the injected quota line in the transcript"),
"quota.gate": bool("quota.gate", "Fail spawns fast when the target provider's quota is exhausted"),
"quota.gateLevel": { kind: "number", path: "quota.gateLevel", min: 1, max: 3, integer: true,
  description: "Minimum ladder level that blocks a spawn (3 = exhausted only, 2 = aggressive)" },
"quota.hud": bool("quota.hud", "Show the quota line in the status bar"),
"quota.requestTimeoutS": seconds("quota.requestTimeoutMs", { min: 1, max: 60, description: "Quota HTTP request timeout" }),
"quota.balanceWarnCny": { kind: "number", path: "quota.balanceWarnCny", min: 0, max: 100_000,
  description: "Moonshot balance (CNY) below which the provider is raised to L2; 0 = display only" },
// baseUrl / userAgent 刻意**不进** SETTING_SPECS（与 bashJobs.dir / bashJobs.shellPath 同款
// 「JSON-file-only」处理）：它们是逃生阀，不该出现在设置编辑器里诱导误改。
```

---

## 9. 测试计划

新增目录 `tests/quota/`（镜像 `src/quota/`）+ 一个集成用例文件。全部 fixture 取自 requirements 的实测样例，**逐字复制**（含 GLM 的 `unit:3/6`、Kimi 的 `usages.limit_5h/limit_7d`、Moonshot 的 `cash_balance:-5.04`）。

### 9.1 `tests/fixtures/quota/`

```
zai-quota-limit.json          requirements 的 GLM 双窗口实测样例（原样）
zai-quota-empty-limits.json   { code:200, data:{ level:"max", limits: [] } }
zai-quota-unknown-unit.json   limits 里混入 unit:9
kimi-usages.json              requirements 的 Kimi 实测样例（周 used_ratio:1 + 5h remaining:100）
kimi-usages-legacy.json       只有 usage + limits[]，没有顶层 usages（兜底路径）
moonshot-balance.json         { data:{ available_balance:0, voucher_balance:0, cash_balance:-5.04 } }
moonshot-balance-positive.json
```

### 9.2 单测文件与用例

**`tests/quota/ladder.test.ts`**

1. 阈值网格：49/50/74/75/89/90/100 → L0/L1/L1/L2/L2/L3/L3
2. `usedPct >= 100` → L3 且 `reason:"exhausted"`
3. 预测把 62% 抬到 L2（`now+eta < resetAt`），`reason:"forecast-before-reset"`
4. 预测 ETA < 30min 把 62% 抬到 L3，即使 `resetAt` 未知
5. **90% 但马上重置不降级**（显式锁死「不反向降级」的决策）
6. `resetAt === undefined` 时只走 3a 不走 3b
7. **Kimi 陷阱**：`[{5h, 0%}, {week, 100%}]` → provider level = 3（回归测试，用例名带 `#kimi-week-trap`）
8. 降位地板：`demoted:true` + 当前算出 L1 → provider level = 2
9. `balanceLevel`: `0 → 3`、`-5.04 → 3`、`12.3 → 0`、`warnCny:20` 时 `12.3 → 2`
10. `gridStep(62, 10) === 60`、`gridStep(49, 10) === 40`、`gridStep(x, 0) === 0`
11. `stale` 计算：`fetchedAt` 早于 `staleAfterMs` → `stale:true`

**`tests/quota/forecast.test.ts`**

1. 少于 2 样本 → `etaMs undefined`，`skipped:"too-few"`
2. 跨度 < 5min → `skipped:"too-short"`
3. 两点 `(t0, 20%) → (t0+1h, 40%)` → `burnPctPerHour === 20`，`etaMs === 3h`
4. 斜率 ≤ 0（持平/下降）→ `skipped:"not-burning"`
5. 窗口裁剪：3h 前的样本被丢弃，斜率只用窗内首末点
6. `maxSamples` 上限：第 33 个样本挤掉最旧的
7. **重置检测**：`60% → 5%`（跌幅 ≥ 15）→ 环被清空，只保留新样本
8. 边界抖动 `60% → 58%`（跌幅 < 15）→ 环保留，正常累积
9. `pushSample` 是纯函数（原数组未被改动）

**`tests/quota/adapters-zai.test.ts`**

1. 实测 fixture → 两个窗口：`{5h, usedPct: round(79/28000*100)}`、`{week, usedPct: round(20486/140000*100)}`；`resetAt` 为原 ms 值
2. **优先自算 usedPct**（`currentValue/usage`），`percentage` 只在 `usage <= 0` 时兜底（fixture 里 percentage=1 与自算 0.28 不同，用例锁死取自算的 round 值）
3. `unit:9` 的条目被静默跳过，其余保留
4. `limits: []` → 返回 `undefined`（无可用窗口 = 无快照，不是空快照）
5. `code !== 200` / `data` 缺失 / 顶层是数组 / 是字符串 → 全部 `undefined`，**不抛**
6. `apiKey === undefined` → 立即 `undefined`，**`fetchJson` 零次调用**（用 spy 断言）
7. 请求头断言：`Authorization` 是**裸 key（无 `Bearer ` 前缀）**，URL = `${baseUrl}/api/monitor/usage/quota/limit`
8. `zaiOverseasAdapter` 的 id 是 `"zai"`，默认 baseUrl 是 `api.z.ai`，解析器完全共用

**`tests/quota/adapters-kimi.test.ts`**

1. 实测 fixture → `[{5h, 0}, {week, 100}]`（`used_ratio` 0..1 × 100）
2. `reset_time` ISO 串 → `Date.parse` 后的 ms
3. 兜底路径（`kimi-usages-legacy.json`）：`limits[].window.duration===300 && timeUnit==="TIME_UNIT_MINUTE"` → 5h，`limit`/`remaining` 字符串数字 → `usedPct = (limit-remaining)/limit*100`；顶层 `usage` → week
4. **顶层 `usages` 优先于兜底**（两者都在且矛盾时取 `usages`）
5. **不读 `totalQuota`**（fixture 里塞一个 `totalQuota: 99`，断言结果不受影响 —— 锁死上游 bug MoonshotAI/kimi-code#1569）
6. 请求头断言：`Authorization: Bearer <key>` **且** `User-Agent` 是浏览器 UA（非空、不含 `curl`）—— 回归 Cloudflare 1010
7. `used_ratio` 越界（-1 / 2）→ clamp 到 0 / 100
8. 全形状异常（null / 数组 / 缺 usages 且缺 limits）→ `undefined`，不抛

**`tests/quota/adapters-moonshot.test.ts`**

1. `available_balance: 0` → `{kind:"balance", balanceCny: 0}`
2. `available_balance` 缺失但有 `cash_balance` → 仍取 `available_balance` 语义，缺失即 `undefined`（不猜）
3. 负余额正常解析（`cash_balance:-5.04` 不参与判定）
4. 非数字 / 缺 data → `undefined`，不抛

**`tests/quota/http.test.ts`**

1. 200 + JSON → 返回解析对象
2. 200 + 非 JSON 文本 → `undefined`，不抛
3. 403 → 不重试（`fetchImpl` 恰好 1 次），返回 `undefined`
4. 500 → 重试 1 次后放弃（恰好 2 次）
5. 超时 → `undefined`；**断言底层 timer 被 `unref`**（用假 `fetch` + `vi.useFakeTimers`）
6. 错误消息脱敏：WARN 文本里不含 key 原文（`redactSecrets` 已接线）
7. 默认 UA 非空且不含 `node`/`curl`

**`tests/quota/demotion.test.ts`**

1. `mark` 后 `get` 可读；重启（新建 store 同 path）后仍可读
2. TTL 过期：`now >= expiresAt` → `get` 返回 `undefined`
3. `resetAt === undefined` → `expiresAt = markedAt + 6h`
4. 幂等：同 level 重复 `mark` 不重复落盘（spy `writeFileSync` 调用次数）
5. level 抬升（2→3）会改写
6. `clear` 立即生效并落盘
7. **文件损坏**（写入 `not json`）→ 视为空表，后续 `mark`/`get` 正常工作，不抛
8. **目录不可写**（path 指向 `/proc/...` 之类）→ 内存态仍工作，不抛
9. 原子写：断言用了 `tmp + rename`（mock `fs` 断言 `renameSync` 被调用）

**`tests/quota/credentials.test.ts`**

1. `{type:"api_key", key:"sk-x"}` → `"sk-x"`
2. `{type:"oauth", ...}` → `undefined`（本期不支持）
3. `key` 缺失 → 回退 `process.env.ZAI_API_KEY`
4. `key: "$MY_KEY"` + env 命中 → 解析成 env 值
5. `key: "!op read ..."`（命令型）→ `undefined` 且**不执行任何命令**（spy `child_process`）
6. `readStoredCredential` 抛（注入一个会抛的桩）→ `undefined`，不抛
7. 首次 miss 打一次 WARN，第二次不再打

**`tests/quota/service.test.ts`**（`FakeClock` + 注入桩 adapter）

1. `refreshIfStale` 首次触发全部 adapter；TTL 内再调不触发
2. 在途去重：连续两次 `refreshIfStale` 只发一轮请求
3. 单个 adapter 抛/超时 → 其余 provider 的快照照常产出（**静默降级隔离**）
4. `verdicts()` 是同步的且在无快照时返回 `[]`
5. 刷新后自动 `mark` 降位（level 抬到 2）
6. 观测到重置（全部窗口跌幅 ≥ 15）→ `clear` 降位 + 清空样本环
7. `setStatus` 在刷新后被调用；`dispose()` 后被以 `undefined` 调用一次
8. `dispose()` 后 `refreshIfStale()` 不再发请求
9. **无任何 timer 被创建**（`FakeClock.pendingTimers === 0` —— 锁死 D2 的「零定时器」决策）
10. **双重 dispose 只清一次 status**（M3：`QuotaStack.dispose` 纯转发 + service dispose 幂等）
11. **dispose 后在途 refresh 落地不写 status**（in-flight 防护）

**`tests/quota/hook.test.ts`**（harness 照抄 `tests/integration/compact-hint-wiring.test.ts` 的 `ctx()`/`harness()` 骨架）

1. `ctx.mode === "print"` / `"json"` → 零发送（子会话惰性）
2. L0 → 零发送，且闩锁被清除
3. 首次进 L1 → 发一条；同百分比再来一轮 → 不发（等级闩锁）
4. 62% → 71%（跨 70 网格）→ 再发一条（网格闸）
5. L1 → L2 → 立即发（等级抬升闸）
6. **最小间隔吞掉的那一步不会丢**：L1 在 `minIntervalMs` 内的第二次网格前进被吞，间隔过后同一 usedPct 仍能播报（锁死 `latchBefore` 回滚）
7. L3 **绕过** `minIntervalMs`
8. L2 在 `repeatMs` 后复读一次
9. 多 provider 同轮命中 → **只发一条**合并消息，`details.providers` 含全部
10. `demoted` → tick 文本含 `⤓demoted`
11. `sendMessage` 抛 → 钩子吞掉不抛（turn_end 不可被拖垮）
12. `verdicts()` 抛 → 钩子吞掉、仍调用 `refresh()`
13. **先读后刷**顺序：断言 `verdicts` 的调用早于 `refresh`
14. 消息契约：`{ customType: "subagent:quota", display: true }` + `{ triggerTurn: false }`
15. **stale verdict 零发送（M1）**：全部窗口 stale ⇒ 无消息、闩锁不推进（只进 HUD）

**`tests/quota/gate.test.ts`**

1. 无快照 → `undefined`（放行）
2. `level:3` 且 `stale:false` → 阻断，message 含百分比、重置时刻、替代模型
3. `level:3` 但 `stale:true` → **放行**（R5）
4. `gateLevel:2` 时 L2 也阻断
5. `pickAlternatives` 排序：低 level 优先，同 level 按 usedPct 升序，排除自身与已阻断 provider
6. 无可用替代 → message 明确说「无更优替代，请检查 pi /model」
7. `quotaAnnotation`：L0 无标记、L2 `⚠`、L3 `⛔`、未知 provider `undefined`
8. `formatModelCandidates(c, 8, undefined)` 输出与今天**逐字节相同**（向后兼容锁）

**`tests/quota/render.test.ts`**

1. 三档文案快照（`toMatchInlineSnapshot`）
2. `formatResetAt` 跨天不炸；`resetAt undefined` → `"未知"`
3. `formatEta`: 90s → `"约 2 分钟"`；5400s → `"约 1 小时 30 分钟"`
4. 余额行 `¥12.30` 两位小数；负数 `¥-5.04`
5. `renderQuotaStatus` 在全空时返回 `undefined`；陈旧时带 `·stale`

**`tests/config/quota-settings.test.ts`**（照 `tests/config/memory-settings.test.ts`）

1. `DEFAULT_SETTINGS.quota` 全字段 `toEqual` 快照
2. 缺块 / 非对象 / 数组 → 回落默认
3. 逐字段非法值回落（含 `refreshMs` 越界、`gateLevel: 0`）
4. **阈值单调钳制**：`{l1:80, l2:50, l3:60}` → `{80, 80, 80}`
5. `baseUrl` 非 http(s) → 回落默认；尾斜杠被裁掉
6. `isTimeSettingKey("quota.refreshS") === true`
7. 六个 `quota.*` 时长键在 `TIME_SETTING_MS_PATHS` 里
8. `SETTING_SPECS` 的 quota 键全部 `live` 为 undefined；`quota.baseUrl*` / `quota.userAgent` **不在** specs 里
9. 秒/毫秒迁移：文件写 `quota: { refreshS: 300 }` → `settings.quota.refreshMs === 300_000`

**`tests/integration/quota-wiring.test.ts`**

1. `buildSessionStack` 在 `quota.enabled=true` 时产出 `stack.quota` + `stack.quotaHint`；`false` 时两者缺席
2. 第二次 `buildSessionStack` 会 dispose 上一个（spy `dispose`）
3. `createQuotaHintHook` 经 holder 读到重建后的新 stack（`/reload` 存活）
4. spawn 闸门端到端：桩 quota service 报 L3 → `spawn()` 返回 `{ error: { kind:"config", retryable:false } }`，**且 `query.list()` 为空**（零可变状态写）
5. `quota.gate=false` 时同样的 L3 快照不阻断
6. `quota.enabled=false` 时 `turn_end` 钩子零发送、spawn 零变化（全特性可关）

---

## 10. 并行拆包建议

**Pack 0（前置，单人，~30min）** —— 解除所有阻塞

- 文件：`src/quota/types.ts`、`src/config/settings.ts`（`QuotaSettings` + `DEFAULT_SETTINGS.quota` + `parseQuotaSettings` + `TIME_SETTING_MS_PATHS`）、`src/config/setting-specs.ts`、`tests/config/quota-settings.test.ts`
- 验证：`npm run typecheck && npx vitest run tests/config`

**Pack 0 合并后，B/C/D/E 四包完全并行（文件域零重叠）：**

| 包               | 文件域                                                                                                                                           | 依赖                                                                                                                                           | 验证命令                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **B 纯逻辑**     | `src/quota/ladder.ts`、`forecast.ts`、`render.ts` + `tests/quota/{ladder,forecast,render}.test.ts`                                               | Pack 0                                                                                                                                         | `npx vitest run tests/quota/ladder.test.ts tests/quota/forecast.test.ts tests/quota/render.test.ts && npm run typecheck`      |
| **C 适配器**     | `src/quota/http.ts`、`credentials.ts`、`adapters/**` + `tests/quota/{http,credentials,adapters-*}.test.ts` + `tests/fixtures/quota/**`           | Pack 0                                                                                                                                         | `npx vitest run tests/quota/http.test.ts tests/quota/credentials.test.ts tests/quota/adapters-*.test.ts && npm run typecheck` |
| **D 服务与注入** | `src/quota/demotion.ts`、`service.ts`、`hook.ts`、`index.ts` + `tests/quota/{demotion,service,hook}.test.ts`                                     | Pack 0 + B + C（M2 修订：`CredentialResolver` 已随 `types.ts` 进 Pack 0；`fetchJson`/adapters 是 C 包运行时依赖——D 包用 DI 桩顶住直至 C 合并） | `npx vitest run tests/quota/demotion.test.ts tests/quota/service.test.ts tests/quota/hook.test.ts && npm run typecheck`       |
| **E 闸门**       | `src/quota/gate.ts`、`src/config/model-hint.ts`、`src/service/spawn-service.ts` + `tests/quota/gate.test.ts` + `tests/config/model-hint.test.ts` | Pack 0 + B（`ProviderVerdict`）                                                                                                                | `npx vitest run tests/quota/gate.test.ts tests/config/model-hint.test.ts tests/service && npm run typecheck`                  |

**Pack A（装配面，必须单包、必须最后，不可与任何包并行）**

- 文件：`src/index.ts`、`src/stack.ts` + `tests/integration/quota-wiring.test.ts`
- 理由：这两个文件是全仓库的合流点，`Stack` 接口、`previous*` 交接变量、`session_shutdown` dispose 链、`turn_end` 注册顺序都在里面；两个人同时改必然冲突，且冲突后 `/reload` 生命周期的错误是最难在 review 里看出来的一类。
- 验证：`npm run format:check && npm run typecheck && npm test && npm run build`（**全量**，不允许只跑子集）

**Pack F（收尾，可与 A 并行，跨仓库）**

- `CHANGELOG.md` 的 Unreleased 段、`README.md` / `README.en.md` 的特性列表、`AGENTS.md` 的 `src/quota/` 一行说明、dev-flow `SKILL.md` 的静态规则句。
- 验证：`npm run format:check`

**合流闸**：A 合并后必须在真实 key 下手动冒烟一次（GLM + Kimi + Moonshot 各拉一次，确认三个快照都非 `undefined`），这是唯一无法自动化的验收项。

---

## 11. 风险与静默降级矩阵

| #       | 场景                                       | 发生什么                                                                                                                                                | 用户/模型可见的表现                                                                   | 防护位置                                     |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| **R1**  | **端点挂了**（502/超时/DNS）               | `createFetchJson` 重试 1 次后返回 `undefined` → adapter 返回 `undefined` → service 保留**上一次的旧快照**（不清空）                                     | 无报错；HUD 追加 `·stale Nm`；超过 `staleAfterMs` 后注入静默 + 闸门自动停止阻断（M1） | `http.ts` + `service.ts`                     |
| **R2**  | **响应形状变了**（控制台后端改字段）       | 解析器返回 `undefined`（每个字段都经 `typeof` 守卫，无一处直接下标解引用）                                                                              | 该 provider 从 tick 行消失，其余照常                                                  | `adapters/*.ts` 解析层                       |
| **R3**  | **key 缺失 / 是 OAuth / 是命令型配置**     | `credentials` 返回 `undefined` → adapter **零请求**直接 `undefined`；首次打一条 WARN                                                                    | 该 provider 永久静默；`/agent settings` 里可见 `quota.providers` 可摘掉它             | `credentials.ts`                             |
| **R4**  | **网络超时**                               | `withRequestTimeout`（10s，timer 已 `unref`）中止请求；`AbortController` 释放                                                                           | 无阻塞：turn_end 早已用旧快照返回了                                                   | `http.ts`（复用 `web-search/resilience.ts`） |
| **R5**  | **快照陈旧但闸门想拦**                     | `verdict.stale === true` 时 `evaluateQuotaGate` **一律放行**                                                                                            | 派单照常，最坏退化为今天的行为（真 429 由上游处理）                                   | `gate.ts`                                    |
| **R6**  | **降位标记文件损坏 / 目录不可写**          | `createDemotionStore` 视为空表，内存态继续工作；写失败只 WARN                                                                                           | 标记退化为「本进程有效」，`/reload` 后丢失                                            | `demotion.ts`                                |
| **R7**  | **Cloudflare 拦截（Kimi 403 error 1010）** | 403 属不可重试 → `undefined`                                                                                                                            | kimi 从 tick 行消失。**主防护是默认带浏览器 UA**；`quota.userAgent` 可覆盖            | `http.ts` + `adapters/kimi.ts`               |
| **R8**  | **`ctx.ui` 陈旧 / 无 UI（print 模式）**    | `safeSetQuotaStatus` 的 try/catch 吞掉                                                                                                                  | 无 HUD 行，其余功能不受影响                                                           | `stack.ts`                                   |
| **R9**  | **`sendMessage` 抛**                       | 钩子 catch + WARN                                                                                                                                       | 本轮无注入，下轮照常（闩锁已推进 ⇒ 最多漏一格，不会卡死）                             | `hook.ts`                                    |
| **R10** | **预测数据不足 / 斜率为负**                | `etaMs = undefined` → 阶梯**退化为纯百分比**判定                                                                                                        | 提前预警变弱，但不产生假警报                                                          | `forecast.ts`                                |
| **R11** | **`quota.enabled = false`**                | `createQuotaStack` 返回 `undefined` → `stack.quota`/`stack.quotaHint` 缺席 → 钩子首行 `if (!state) return`；spawn 的 `deps.quotaGate` 未注入            | **与今天逐字节相同的行为**（全特性可一键回退）                                        | `stack.ts`                                   |
| **R12** | **子会话（print 模式）**                   | HOST_KEY guard 之后才注册钩子 ⇒ 子会话根本没有这个 hook；即便有，`ctx.mode === "print"` 也直接 return                                                   | 子会话零开销、零请求                                                                  | `index.ts` + `hook.ts`                       |
| **R13** | **`/reload`**                              | 钩子经 `holder.current` 读新 stack；旧 `QuotaStack` 在下一次 `buildSessionStack` 顶部 + `session_shutdown` 双重 dispose；**零模块级可变状态、零 timer** | 无泄漏、无重复播报                                                                    | `stack.ts` + `index.ts`                      |
| **R14** | **模型误读额度行去改派单**                 | 文案里明确写出替代模型的**完整 `provider/id`**，不让模型自己猜；闸门是最后一道保险                                                                      | —                                                                                     | `render.ts` + `gate.ts`                      |

---

## 12. 明确不做（与简报一致）

- GLM 团队版 `?type=2` + `bigmodel-organization`/`bigmodel-project` 头 —— `AdapterDeps` 里预留了 `baseUrl`，加头时再扩 `extraHeaders` 字段即可，本期不写。
- Kimi 海外站 `api.kimi.ai` —— `quota.kimiBaseUrl` 是配置位，未实测不设第二个 adapter。
- 额度折算美元成本（HUD 已有成本线）。
- CloudRouter / zhipu-pool 等中转池（无公开额度端点）。
- 任何新工具 / 新命令 —— **零工具调用是本特性的定义性约束**。

---

## 13. 评审后修订（验收后落盘）

本节为验收阶段用户拍板的修订记录，均为超出原计划文字的落地偏差，实施以本节为准。

- **HUD footer 独占行**：验收后用户要求 quota 状态独立成行，改动了 `src/hud/footer.ts`（超出 §7「不动 `src/hud/`」的原决策）；已抽出 `renderExtensionStatusLines` 纯函数并以 `tests/hud/footer.test.ts` 覆盖。
- **HUD 主题着色**：新增 `QuotaStatusTheme` / `readQuotaStatusTheme`（`ctx.ui.theme` 的结构子集），服务经可选 `theme` 依赖取色，无主题时退化为纯文本。
- **同池去重（评审 Minor 9 落地）**：`zai-coding-cn` 与 `zai` 常配同一把 key（同账号同配额池），展示层经 `dedupeVerdicts` 折叠为一行（usedPct 取整 + resetAt 分钟桶容差）；gate 仍按 provider id 独立判定。
- **紧凑标记去除 ⛔（用户要求）**：L2/L3 统一 ` ⚠`，HUD 侧严重度由颜色表达（warning / error）。
- **moonshot 余额检测移除（用户决策）**：`QuotaSnapshot` 收敛为纯窗口型（`export type QuotaSnapshot = QuotaWindowsSnapshot`），adapter / 凭据回退 / 阶梯 / 渲染 / 闸门 / settings 里的 balance 语义全链路摘除，`QuotaProviderId` 收窄为 `zai-coding-cn | zai | kimi-coding`。
- **订阅优先用完（2026-09 用户决策，推翻 L2 导流）**：受管 provider 都是**订阅额度**——窗口内不用就作废，提前把流量导向按量计费模型方向是反的。落地：
  - L2 变为**纯提示**：文案只报用量/ETA/重置时刻并声明「订阅额度照常优先使用，派单不变」，不再列替代模型、不再「降一位」；闸③ 复读只对 L3（`shouldAnnounce`）。
  - **降位标记只在 L3 写入**（`service.applySnapshot`），L2 不再写 `quota-state.json`；`providerVerdict` 的降位地板（≥2）语义不变。
  - `pickAlternatives` 排序键前置**订阅层**：带窗口数据的受管 provider（含 stale）排在非受管（按量计费/中转，无额度数据）之前，其后才是 `level asc, maxUsedPct asc, 注册表顺序 asc`。原「非受管视作 L0/pct 0 排最前」（Minor 3）作废。
  - `formatResetAt` 跨天输出 `M/D HH:MM`——7d 窗口只报 `HH:MM` 会被读成「今天」。
- **同池合并注入（2026-09 用户确认）**：`buildQuotaMessage` 对 L2/L3 块按「等级 + `dedupeVerdicts` 同一池签名」分组，同池的 `zai-coding-cn` 与 `zai` 合并为一段（标签 `zai-coding-cn / zai`），替代链剔除组内成员；L1 tick 沿用 `dedupeVerdicts` 折叠。
- **替代链只推荐 scope 内模型（2026-09 用户要求）**：`StackModelPort.recommendable()` = 会话 scope（`ctx.scopedModels` live getter，即 `/models` 里激活的模型）∩ `getAvailable()`，保留 scope 顺序；未配置 scope 时退化为 available。turn_end 注入与 spawn 闸门的 `pickAlternatives` 都改读它；模型解析/校验（resolveHint、set_model、未知 hint 报错列表）仍走 available，不受影响。
