# P7：把 droid 额度查询接入 quota 模块（施工方案）

> 状态：**plan r2**（2026-10-14）。消化 `quota-review-r1.md` #1–#8、文末 SP1 spike 结果和「用户拍板」段（含 **D12 改判：web-hub 显示 droid 额度与 P7 一起做**）。修订明细见文末「修订记录 r2」。
> 依据：`docs/dev/external-agent/plan.md`（r3）；master `42d6a0e`（P1 `df2957f`、P4a `fa9d63f`、P2 `b707053`、P4c `2002ffa`、P4b `42d6a0e` 已合入，P3 在制）；`src/quota/**`（2733 行，逐文件读过）；`src/web-hub/{protocol,agent,hub,ui}` 的 quota 相关代码；`docs/dev/external-agent/samples/09c-jsonrpc-init2.jsonl`；droid 0.241.1 二进制里的字符串；只读 curl 实测（§0.2）。
> 记号：`Dn` 是决策点，`SPn` 是 spike 事实，`Fn` 是后续包（本期不做）。

---

## 0. 结论速览

### 0.1 一句话方案

把 Factory 的 standard / core 两个计费池建模成两个虚拟 quota provider：`droid-standard` 和 `droid-core`。

- 一个适配器对子负责两个池：一次 GET `/api/billing/limits` 产出两份窗口快照，两份共享同一次在途请求。
- `WindowScope` 新增 `month`。
- spawn 闸门新增按模型判定：`droid/<id>` 先查出所属池，再取该池的 verdict。这一步走晚绑定端口 `QuotaPoolPort`（由 P5 接上 droid 目录）；查不出池时同时看两个池，**两个池都触线才拦**（用户拍板 D5）。
- 闸门拦下 droid 时，替代建议分两类列出：先列 core 池模型（`droid/glm-5.3` 这类），再列 pi 订阅 provider，并标注「改用 pi 原生子 agent」（用户拍板，评审 #4）。
- `externalAgents.droid.enabled=false` 时 P5 不传 droid 输入，quota 侧不构造 droid 适配器：零网络、零告警，kimi/zai 输出字节不变。
- **web-hub 同期显示 droid 额度**（D12 改判，P7w + P7wa）：协议枚举扩展、hub 通告新 cap `quota.pools.v1`。只有 hub 通告了这个 cap，agent 才发 droid 行和 month 窗口，旧 hub 不会丢帧。UI 按池分组显示。

选"虚拟 provider id"的理由：quota 模块里所有状态都按 provider 字符串存放，包括 snapshots、rings、suspects、inflight、demotion、hook 闩锁、恢复/可用播报、HUD 去重（评审已逐条核实）。按池拆成两个 id 后这些全部原样复用；要新写的只有三处：一次请求出两份快照、闸门里"模型 → 池"的映射、展示标签（D1）。

### 0.2 本次核实出的、会改变设计的事实

| #   | 事实                                                                                                                                                                                                                                                                                                                        | 影响                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | **droid 0.241.1 的两条目录来源都不带 `billingPool`**。`initialize_session.result.availableModels`（09c 样本逐键枚举）没有；**SP1 实测** `droid.list_models` 也没有，它的 `models[]` 只比前者多一个 `disabled` 字段。二进制内置注册表里有 `billingPool:"standard"\|"core"`，但没有经任何 RPC 暴露出来。                      | v1 的池来源只能是对已冻结字段 `upstreamProvider`/`kind` 做启发式，外加 settings 覆盖（D4）。F1（目录带 billingPool）取消。`disabled` 的处理见 D18 和 F4。                                           |
| K2  | 启发式有证据支撑：09c 里 `modelProvider` 分布为 `factory`（glm/kimi/deepseek/minimax/mistral/nemotron/qwen/inkling/muse-spark/auto）、`anthropic`、`openai`、`google`、`xai`。二进制注册表里 glm/kimi/deepseek/minimax/mistral/nemotron 都是 `billingPool:"core"`，Anthropic/OpenAI 默认块是 `billingPool:"standard"`。     | `factory`（且不是 router）⇒ core；anthropic/openai/google/xai ⇒ standard；`auto` 这类 router ⇒ 未知。inkling/qwen/muse-spark 的池在二进制里没查到，可能误判，靠 `quota.droidPools` 覆盖兜底（R1）。 |
| K3  | **pi 进程环境里的 `FACTORY_API_KEY` 现在拿不到数据**。本会话继承的 key 返回 HTTP 402 `Organization does not have an active paid subscription`；`~/.factory/env.sh` 里的 key（与前者不同）返回 200；无效 key 或不带 header 都返回 401。                                                                                      | 正好是"旧 key"场景：401/402/403 ⇒ warnOnce + HUD `droid auth 402`，不拦 spawn（用户拍板 D3）。                                                                                                      |
| K4  | droid 客户端语义（反编译）：`active = windowEnd 存在且 ≥ now`；`exhausted = active && usedPercent ≥ 100`；standard 池任一窗口 exhausted ⇒ 进入超额分流 `extraUsage` / `droidCore` / 否则 `blocked`。                                                                                                                        | 适配器按这套语义归一化：未激活窗口记 0%，不带 resetAt。                                                                                                                                             |
| K5  | spawn 闸门的签名本来就按模型：`quotaGate?: (model: { provider; id }) => …`（`src/service/spawn-service.ts:219`）；P4b 对 external 模型照常调用闸门（评审已核实）。                                                                                                                                                          | 只改 `src/quota/gate.ts` 和 `src/stack.ts` 的闸门 deps 块，不碰 spawn-service。                                                                                                                     |
| K6  | web-hub 线协议是封闭枚举：`QuotaWindowSchema.scope ∈ {"5h","week"}`、`QuotaProviderSchema.id ∈ 三个旧 id`（`src/web-hub/protocol/messages.ts:1093-1113`）。decodeWith 失败会丢掉**整个** status 帧；hub 对 status 透明（`toCard` 整体透传）。                                                                               | 新 hub 放宽枚举并通告 `quota.pools.v1`；agent 只在看到这个 cap 时才发 droid 行和 month 窗口（§9A）。旧 hub 因此永远收不到未知枚举。                                                                 |
| K7  | **P4a 已合入**（`fa9d63f`），`setting-specs.ts` 不再是在途文件域；仓库也没有"每个设置叶子都必须有 spec"的覆盖测试。                                                                                                                                                                                                         | 原 P7s 并入 P7（评审 #2，D16）。                                                                                                                                                                    |
| K8  | runner 的 `LifecycleEvent`（`src/core/types.ts:1363`）不带 diag。                                                                                                                                                                                                                                                           | v1 不接 `model_usage_exhausted` 信号（D13）。                                                                                                                                                       |
| K9  | `Stack.quota` 的类型是 **`QuotaService`**，不是 `QuotaStack`：`src/stack.ts:949` 声明 `quota?: QuotaService`，`:2702` 赋值 `quota: quota.service`；`src/index.ts` 现有写法是 `holder.current?.quota?.verdicts()` / `.verdictFor(p)`（`:401-406`、`:1021`）。`stack.ts` 内部的局部变量 `quota`（`:2320`）才是 `QuotaStack`。 | 评审 #1 的建议会引入编译错误：`src/index.ts` 一侧应写 `holder.current?.quota?.X`，`stack.ts` 一侧写 `quota.service.X`。处置见修订记录 r2。                                                          |

---

## 1. 决策点（D1..D21）

「拍板」= 用户 2026-10-14 已确认，不再变更。

| #   | 问题                              | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | provider 建模                     | 虚拟 id `droid-standard` / `droid-core`（`QuotaProviderId` 联合追加），**不**新增字面 id `droid`。旧路径 `verdictFor("droid")` 仍返回 undefined（不受管 ⇒ 放行）。（按推荐执行）                                                                                                                                                                                                                                                      |
| D2  | 白名单                            | `quota.providers` 新增 token `droid`（展开成两个池），默认值改为 `"zai-coding-cn,zai,kimi-coding,droid"`；空串仍表示全关。droid 已启用但白名单里没有 droid ⇒ warnOnce `add "droid" to quota.providers`。（按推荐执行）                                                                                                                                                                                                                |
| D3  | 凭据与 401/402/403                | **拍板**：只用 `ENV_FALLBACK=FACTORY_API_KEY`（与 droid 子进程继承同一把 key），不读 `~/.factory/env.sh`。401/402/403 ⇒ 不产快照（闸门放行）+ 按状态码 warnOnce（不含 key）+ HUD `droid auth <code>`，下一次成功时清除。**不拦 spawn。**                                                                                                                                                                                              |
| D4  | 模型 → 池来源                     | 优先级：`quota.droidPools[id]`（值 `standard\|core\|none`）> 目录条目里结构性存在的 `billingPool`（只为前向兼容，K1 下恒缺席）> 启发式（`custom:` ⇒ `none`；`kind==="router"` ⇒ 未知；`factory` ⇒ core；anthropic/openai/google/xai ⇒ standard；其余 ⇒ 未知）。                                                                                                                                                                       |
| D5  | 池未知 / 端口缺席                 | **拍板**：同时查两个池，两个池都 ≥ gateLevel 才拦；任一池无快照或快照陈旧 ⇒ 放行。                                                                                                                                                                                                                                                                                                                                                    |
| D6  | extraUsage                        | **拍板**：闸门默认仍拦；`quota.droidAllowExtraUsage=true`（且 overage 为 extraUsage、extraUsageAllowed 为真、余额 >0）才放行 standard 池。文案、HUD、web 全程显示余额。                                                                                                                                                                                                                                                               |
| D7  | droid 内替代                      | `droid-standard` 被拦、且 core 池未被排除（无快照或陈旧都算未被排除）时，推荐 ≤3 个 core 模型（`droid/<id>`）。候选按顺序合并：`externalAgents.droid.models` 偏好序 → 目录 core 序 → **`quota.droidPools` 中值为 `core` 的键**（评审 #5，去重，同样滤掉 deprecated/router/`custom:`）。不要求 `overage==="droidCore"`（SP3 未证伪前不加条件）。core 被拦时不反向推荐 standard 模型（standard 模型 multiplier 普遍更高，用户未要求）。 |
| D8  | droid 被拦时的 pi 替代            | **拍板（评审 #4）**：两类都列，**core 池优先**。pi 订阅 provider 那一行改用标题「改用 pi 原生子 agent」，明示执行语义会变（pi 子 agent 而非外部 agent）。反方向（kimi/zai 被拦时推荐 droid 模型）v1 仍不做：`models.recommendable` 不含 droid 模型，且两者执行语义不同。                                                                                                                                                              |
| D9  | month 窗口                        | **拍板**：`WindowScope` 加 `"month"`；默认阈值 50/95/98；紧凑 token `mo`；`quota.windows.month.*` 可覆盖；旧的全局 l1/l2/l3Percent 也作用于 month。                                                                                                                                                                                                                                                                                   |
| D10 | forecast / demotion               | **拍板**：month 关闭规则 3b（forecast-before-reset），保留 3a；demotion 按虚拟 id 存，原样复用。                                                                                                                                                                                                                                                                                                                                      |
| D11 | 关闭态                            | `externalAgents.droid.enabled=false` ⇒ 不构造 droid 适配器 ⇒ 零网络、零凭据读取、零告警，HUD、提示词、web 字节不变。端口 getter 返回 undefined 时适配器也是 inactive。                                                                                                                                                                                                                                                                |
| D12 | web-hub                           | **改判（用户）**：与 P7 同期做，规格见 §9A。协议扩枚举 + 新 cap `quota.pools.v1`（hub 两个 cap 面同时通告）；agent 只在 `hello_ack.caps ∋ quota.pools.v1` 时发 droid 行、month 窗口、billing、problems；否则保持 P7 的过滤行为，旧 hub 字节不变、不丢帧。                                                                                                                                                                             |
| D13 | `model_usage_exhausted`           | v1 不接；靠 lifecycle 刷新 + hot TTL。F3 可选。                                                                                                                                                                                                                                                                                                                                                                                       |
| D14 | HUD 布局                          | **拍板**：两个池合并成一段 `droid 12%/40%/mo 5% core 0%/0%/mo 0%`，**始终显示**（有快照就显示）；两个池各自着色、各自带重置倒计时；`extra $12.34`、`auth 402` 按需追加。                                                                                                                                                                                                                                                              |
| D15 | stack.ts / index.ts 接线          | 闸门 deps 和 hook 的 alternatives deps 两处小改动归 P7；P5 只追加 `droid:` 输入和 `warm()`。约束：**P5 在 P7 合入后派发，或 rebase**。                                                                                                                                                                                                                                                                                                |
| D16 | TUI 设置 spec                     | **并入 P7**（评审 #2）：`quota.windows.month.l{1,2,3}Percent`、`quota.droidAllowExtraUsage` 进 `setting-specs.ts`；`factoryBaseUrl`、`droidPools` 照 baseUrl 先例只走 JSON 文件。                                                                                                                                                                                                                                                     |
| D17 | baseUrl / 私有部署                | `quota.factoryBaseUrl`，只走 JSON；接口失败 ⇒ 无快照 ⇒ 放行。                                                                                                                                                                                                                                                                                                                                                                         |
| D18 | 模型的 `disabled` 状态（评审 #6） | v1 不做。理由：P3 的目录取自 initialize 的 `availableModels`，那里没有 `disabled`；要拿到它，P3 得改成额外调用 `list_models`，牵动在制的 P3 与冻结面。残余风险写入 R12；补救放 F4（冻结面加 `disabled?: boolean` + P3 调 `list_models` + `modelsInPool` 过滤）。临时绕过：把该模型在 `quota.droidPools` 里设为 `none`，或不放进 `externalAgents.droid.models`。                                                                       |
| D19 | web cap 名与位置                  | `QUOTA_POOLS_HUB_CAP = "quota.pools.v1"`（`protocol/version.ts`），**无条件**通告（hub 只负责解码，与配置无关），在 `agent-server.ts` 和 `hub.ts` 两个 cap 面的同一位置追加。不升 PROTO（与 `preview.chunk.v1` 先例一致：不新增帧）。                                                                                                                                                                                                 |
| D20 | web 上显示哪些 billing 标记       | `auth <code>`：上 pill 和卡片（K3 的真实场景，最需要被看见）。`extra $X`：pill 只在 standard 组 L3 且 overage 为 extraUsage 时显示；卡片 standard 行常显超额策略徽章（droidCore / extraUsage+余额 / 已放行）。`gateOpen` 只在卡片显示。                                                                                                                                                                                               |
| D21 | 刷新频率                          | **拍板**：沿用 `quota.refreshMs` 10min、≥L1 或近耗尽时 `refreshHotMs` 2min；droid 不加独立参数。                                                                                                                                                                                                                                                                                                                                      |

---

## 2. 冻结面（P7 合入即冻结；P5 / P7wa 只消费）

> §9A.1 的协议常量是 **P7w 的冻结面**，在本方案里直接写死，所以 P7w 与 P7 可以并行。

### 2.1 `src/quota/types.ts`

```ts
export type StaticQuotaProviderId = "zai-coding-cn" | "zai" | "kimi-coding";
export type DroidQuotaProviderId = "droid-standard" | "droid-core";
export type QuotaProviderId = StaticQuotaProviderId | DroidQuotaProviderId;
export const QUOTA_PROVIDER_IDS: readonly QuotaProviderId[] = [
  "zai-coding-cn",
  "zai",
  "kimi-coding",
  "droid-standard",
  "droid-core",
]; // 旧三者顺序不变
export const DROID_QUOTA_IDS: readonly DroidQuotaProviderId[] = ["droid-standard", "droid-core"];
export function isDroidQuotaId(value: string): value is DroidQuotaProviderId;
/** 外部 agent 的 provider 名（与 externalAgents.droid / 模型前缀 droid/ 同字面；quota 自持，不 import external-agent）。 */
export const DROID_PROVIDER = "droid";

export type WindowScope = "5h" | "week" | "month";

export type QuotaPoolId = "standard" | "core";
export type DroidOverage = "droidCore" | "extraUsage" | "off"; // 其它/缺失 ⇒ "off"（droid 语义 blocked）
export interface QuotaBillingInfo {
  readonly kind: "factory";
  readonly pool: QuotaPoolId;
  readonly overage: DroidOverage;
  readonly extraUsageAllowed: boolean;
  readonly extraUsageBalanceCents: number; // 整数 ≥0
  /** service 装饰（解析层永不设置）：见 §5 第 4 条。 */
  readonly gateOpen?: boolean | undefined;
}
// QuotaWindowsSnapshot 追加：readonly billing?: QuotaBillingInfo | undefined;   // kimi/zai 永不设置

export interface QuotaProblem {
  readonly family: string; // "droid"
  readonly status: number; // 401 | 402 | 403
}
// FetchJson 的 init 追加（kimi/zai 不传 ⇒ 行为不变）：
//   readonly onHttpError?: ((status: number | undefined) => void) | undefined;
// ProviderAdapter 追加两个可选成员：
//   readonly isActive?: (() => boolean) | undefined;            // false ⇒ 本轮跳过：不读凭据、不记 lastAttempt、不发请求
//   readonly lastProblem?: (() => QuotaProblem | undefined) | undefined;

/**
 * 晚绑定池端口（P5 经 createCatalogPoolPort 供给）。同步、永不抛。
 * 首次调用可能做一次有界（≤256KiB）磁盘读：底层 ExternalCatalogPort.snapshot() 首次会经
 * catalog-store 同步读缓存文件（P3 droid/catalog.ts → catalog-store.ts，O_NOFOLLOW、≤256KiB）。
 * P5 在 stack 构建时调用 warm() 预热，把这次读挪出 spawn 准入热路径（评审 #3）。
 */
export interface QuotaPoolPort {
  readonly provider: string; // "droid"
  /** "none" = 不计费（BYOK）；undefined = 未知。 */
  poolOf(modelId: string): QuotaPoolId | "none" | undefined;
  /** 该池可推荐的模型 id（已滤 deprecated / router / custom:），偏好序在前。 */
  modelsInPool(pool: QuotaPoolId): readonly string[];
}
```

### 2.2 `src/quota/ladder.ts`

```ts
export interface LadderThresholds {
  readonly l1: number;
  readonly l2: number;
  readonly l3: number;
  readonly l3EtaMs: Millis;
  /** false ⇒ 关闭规则 3b（forecast-before-reset）；缺省 = true（行为不变）。 */
  readonly forecastBeforeReset?: boolean | undefined;
}
// DEFAULT_THRESHOLDS_BY_WINDOW 追加：month: { l1: 50, l2: 95, l3: 98, l3EtaMs: 1_800_000, forecastBeforeReset: false }
// ProviderVerdict 追加：readonly billing?: QuotaBillingInfo | undefined;   // providerVerdict 条件透传（同 plan 的写法）
```

`windowLevel` 只改规则 3b 那一行：`else if (thresholds.forecastBeforeReset !== false && window.resetAt !== undefined && …)`。

### 2.3 `src/quota/pools.ts`（新，pi-free，P5 消费）

```ts
export interface CatalogModelLike {
  id: string;
  upstreamProvider?: string;
  kind?: string;
  deprecated?: boolean;
  billingPool?: unknown;
}
/** D4 启发式（纯函数）：custom: ⇒ "none"；billingPool ∈ {standard,core} ⇒ 它；kind==="router" ⇒ undefined；
 *  upstreamProvider: factory ⇒ "core"；anthropic|openai|google|xai ⇒ "standard"；其余 ⇒ undefined。 */
export function derivePool(info: CatalogModelLike | undefined, modelId: string): QuotaPoolId | "none" | undefined;
export interface CatalogPoolPort extends QuotaPoolPort {
  /** 调一次 catalog()，吞掉一切异常；stack 构建时由 P5 调用（评审 #3）。幂等。 */
  warm(): void;
}
export function createCatalogPoolPort(o: {
  provider: string; // "droid"
  catalog: () => { readonly models: readonly CatalogModelLike[] } | undefined; // ExternalCatalogPort.snapshot（结构兼容）
  preferred?: () => readonly string[]; // externalAgents.droid.models
}): CatalogPoolPort; // 每次调用现读 catalog（同步）；catalog 抛错/缺席 ⇒ poolOf 走 derivePool(undefined, id)，modelsInPool 返回 []
```

`ExternalCatalog`（`src/external-agent/types.ts:54`）在结构上满足 `{ models: readonly CatalogModelLike[] }`，quota 不需要 import external-agent。

### 2.4 `src/quota/service.ts`（`QuotaService` 追加）

```ts
export interface QuotaModelView {
  readonly pool: QuotaPoolId | "none" | undefined;
  readonly keys: readonly QuotaProviderId[];                // pool 已知 ⇒ [droid-<pool>]；未知 ⇒ 两池；"none" ⇒ []
  readonly verdicts: readonly (ProviderVerdict | undefined)[]; // 与 keys 对齐；undefined = 无快照
}
/** undefined ⇒ 该模型不受池管理（非 droid / droid 适配器未构造）⇒ 闸门走旧路径。同步、只读。 */
verdictsForModel(model: { provider: string; id: string }, now?: Millis): QuotaModelView | undefined;
/** blocked === "droid-standard" 且 core 未被排除 ⇒ ≤limit 个 "droid/<id>"（来源与顺序见 D7）；其余 ⇒ []。 */
poolAlternatives(blocked: string, limit?: number): readonly string[];
problems(): readonly QuotaProblem[];
// QuotaServiceDeps 追加：readonly pools?: (() => QuotaPoolPort | undefined) | undefined;
```

### 2.5 `src/quota/index.ts`（`QuotaStackInput` 追加，**P5 唯一要接的线**）

```ts
readonly droid?: { readonly pools: () => QuotaPoolPort | undefined } | undefined;
```

### 2.6 `src/quota/gate.ts` / `src/quota/render.ts`

```ts
// QuotaGateDeps 追加（全可选；缺席 ⇒ 字节不变）
readonly modelView?: ((model: ModelRef) => QuotaModelView | undefined) | undefined;
readonly poolAlternatives?: ((blocked: string) => readonly string[]) | undefined;
// pickAlternatives 的 deps Pick 追加 "poolAlternatives"
// render.ts AlternativeSelection 追加（两者都缺席 ⇒ 字节不变）：
//   readonly models?: readonly string[] | undefined;   // droid 内替代（D7）
//   readonly external?: true | undefined;              // 被拦的是 droid 池 ⇒ providers 行改标题「改用 pi 原生子 agent」（D8）
export function quotaLabel(provider: string): string; // droid-standard → "droid standard 池"；droid-core → "droid core 池"；其余原样
export function formatScope(scope: WindowScope): string; // week→"7d"，month→"mo"，其余 "5h"
export function renderQuotaStatus(verdicts, now, refreshMs, theme?, problems?: readonly QuotaProblem[]): string | undefined;
```

### 2.7 `src/config/settings.ts` + `src/config/setting-specs.ts`

```ts
// QuotaSettings 追加
factoryBaseUrl: string; // 默认 "https://api.factory.ai"，http(s) + 去尾斜杠（复用 url()）
droidAllowExtraUsage: boolean; // 默认 false
droidPools: Readonly<Record<string, QuotaPoolId | "none">>; // 默认 {}；键 /^[A-Za-z0-9._:-]{1,128}$/、≤200 条、非法条目丢弃
// windows: Record<WindowScope, …> 追加 month；DEFAULT windows.month = { l1Percent: 50, l2Percent: 95, l3Percent: 98 }
// DEFAULT providers = "zai-coding-cn,zai,kimi-coding,droid"
```

`setting-specs.ts`（原 P7s 并入）：

- 新增 `quota.windows.month.l1Percent` / `l2Percent` / `l3Percent`：`count(…, 1, "month window L… threshold override (used %); falls back to quota.l…Percent, then the month default (50/95/98)")`，照现有 `quota.windows.week.*`（`:898-912`）的写法。
- 新增 `quota.droidAllowExtraUsage`：`bool("quota.droidAllowExtraUsage", "Let droid spawns through when the standard pool is exhausted and Factory overage spends extra usage (real money)")`，non-live。
- `quota.providers` 的描述（`:848`）改为 `Comma-separated quota providers (zai-coding-cn,zai,kimi-coding,droid); empty = none`。
- `factoryBaseUrl`、`droidPools` 不进 spec（JSON-only 逃生阀）。

---

## 3. 适配器：`src/quota/adapters/droid.ts`（新）

```ts
export const FACTORY_BASE_URL = "https://api.factory.ai";
export const FACTORY_LIMITS_PATH = "/api/billing/limits";
export const DROID_COALESCE_MS = 5_000;
export function parseFactoryLimits(
  raw: unknown,
  now: Millis,
): { readonly standard?: QuotaWindowsSnapshot; readonly core?: QuotaWindowsSnapshot } | undefined;
export interface DroidAdapterPair {
  readonly standard: QuotaAdapter;
  readonly core: QuotaAdapter;
}
export function createDroidAdapters(o: {
  isActive: () => boolean;
  warn?: (m: string) => void;
  coalesceMs?: number;
}): DroidAdapterPair;
```

**解析**（全部 typeof 守卫、永不抛）：

- `raw.limits` 不是对象 ⇒ undefined（`usesTokenRateLimitsBilling` 只作参考，不单独判定）。
- 池 `limits.standard` / `limits.core` 各自解析，键映射为 `fiveHour→"5h"`、`weekly→"week"`、`monthly→"month"`。
- 单个窗口：`usedPercent` 不是有限数 ⇒ 跳过该窗口。`windowEnd` 是字符串 ⇒ `Date.parse`；是数字 ⇒ 大于 1e12 视为毫秒，否则视为秒；是 null ⇒ undefined。windowEnd 缺失但 `secondsRemaining` > 0 ⇒ resetAt = now + s×1000。
- `active = resetAt !== undefined && resetAt > now`。active ⇒ `{scope, usedPct: Math.round(clampPercent(p)), resetAt}`；inactive ⇒ `{scope, usedPct: 0}`，不带 resetAt（K4）。
- 一个池至少有 1 个窗口才产出快照。
- 两个池都带 `billing: { kind:"factory", pool, overage, extraUsageAllowed, extraUsageBalanceCents }`：overage 只认 `"droidCore"`/`"extraUsage"`，其余一律 `"off"`；余额取 `Math.max(0, Math.round(…))`，非数字记 0。

**请求**：GET `${deps.baseUrl}/api/billing/limits`，headers 为 `Authorization: Bearer <key>` 和 `User-Agent`（空串时用 `DEFAULT_USER_AGENT`）。没有 key ⇒ 不发请求。

**一次请求出两份快照**（pair 闭包，每个 stack 一份，**不放模块级状态**）：

- `inflight?: Promise<Parsed | undefined>` 加 `last?: { at, parsed }`。
- 任一适配器 fetch 时：有在途请求就复用；`deps.now() - last.at < coalesceMs` 就复用结果；否则发起新请求。**`inflight` 必须在 `fetchQuota` 的第一个 await 之前同步赋值**（评审核查项 1）。原因：service 在同一个 refresh pass 里串行调用两个适配器，第二个必须能同步看到第一个的在途 promise。
- 时间只用 `deps.now()`，零计时器。

**认证问题**：`fetchJson(url, { headers, signal, onHttpError: (s) => … })`。

- 401/402/403 ⇒ `problem = { family:"droid", status }`，并按状态码 warnOnce。
- 解析成功 ⇒ 清掉 problem。

401/403 的告警文案：

```text
[quota] droid: Factory billing API rejected FACTORY_API_KEY (HTTP 401) — droid quota tracking is paused (spawns are not blocked). droid runs started from this pi process inherit the same key; if you rotated it, restart pi from a shell that has the new key (~/.factory/env.sh is only sourced by new shells).
```

402 用同一句尾，前半句换成 `returned HTTP 402 for FACTORY_API_KEY (no active paid subscription for that key's organization)`。文案里不出现 key，测试断言所有 warn 输出都不含 key 子串。`createFetchJson` 自带的通用告警（`http.ts:157`）照旧保留，它只含状态码和最多 300 字节响应体，并经过 `redactSecrets`。

**`src/quota/http.ts`**：在最终失败分支（`safeWarn(describe(...))` 之前）加一行 `try { init.onHttpError?.(outcome.failure.status); } catch {}`。只调一次；中途重试不调。

**`src/quota/adapters/index.ts`**：

- `ADAPTERS` 改成 `Readonly<Record<StaticQuotaProviderId, ProviderAdapter>>`，内容不变（`tests/quota/adapters-zai.test.ts:165` 钉的三键保持绿）。
- `selectAdapters(enabled, droid?: DroidAdapterPair)`：按 `QUOTA_PROVIDER_IDS` 顺序输出；droid id 取自 pair，pair 缺席则跳过。

**`src/quota/credentials.ts`**：

- `ENV_FALLBACK` 追加两个 droid id，都映射到 `"FACTORY_API_KEY"`。
- warnOnce 的键改为 `warnKey(provider)`：droid 两个 id 合并成一个键 `"droid"`，文案里的 provider 名写 `droid`；kimi/zai 的键和文案都不变。

---

## 4. 池映射与 P5 接线

- P7 实现 `pools.ts`（§2.3），并在 service 里应用覆盖：`poolFor(id) = settings.droidPools[id] ?? port?.poolOf(id)`。端口缺席 ⇒ undefined ⇒ D5。
- **给 P5 的接线清单**（全部在 P5 已有的文件域里）：
  1. `src/stack.ts` 调用 `createQuotaStack` 的地方（当前约 `:2321`）追加：
     ```ts
     ...(externalPort !== undefined
       ? { droid: { pools: () => droidPoolPort } }
       : {}),
     ```
     其中 `droidPoolPort = createCatalogPoolPort({ provider: "droid", catalog: () => external.providers.get("droid")?.catalog.snapshot(), preferred: () => settings.externalAgents.droid.models })`。构造后**立即调用 `droidPoolPort.warm()`**（评审 #3）：把目录缓存那次 ≤256KiB 的同步读放到 stack 构建阶段，避开首个 droid spawn 的闸门判定；P5 本来就在构建时调 `refreshInBackground("stack_build")`，两者相邻即可。端口构造在 quota 之前或之后都可以（getter 是晚绑定的）。
  2. `tests/integration/external-disabled-bytes.test.ts` 追加两条断言：enabled=false ⇒ stub 的 global fetch 从未收到 `api.factory.ai` 的 URL，且没有任何 `[quota] droid` 告警；enabled=true 加 `quota.providers:""` ⇒ 同样零请求。
  3. `tests/external-agent/port.test.ts` 追加：`createCatalogPoolPort` 接真实的 `ExternalCatalog` 形状，得到 `poolOf("glm-5.3")==="core"`、`poolOf("claude-opus-5-5")==="standard"`；`warm()` 吞掉 catalog 抛错。
- 除此之外 P5 什么都不用做：闸门、hook、web 的 deps 已经在 P7 / P7wa 里接好（D15）。
- ~~F1（目录 billingPool）~~：**取消**（SP1 阴性，K1）。`derivePool` 保留对结构性 `billingPool` 的读取，只为前向兼容，零成本。

---

## 5. service 改动（`src/quota/service.ts`）

1. `thresholds(scope)`（`:133`）：`{ l1, l2, l3, l3EtaMs, ...(scope === "month" ? { forecastBeforeReset: false } : {}) }`。
2. `baseUrlFor`（`:140`）：两个 droid id 都返回 `settings.factoryBaseUrl`（switch 穷举，typecheck 会兜住遗漏）。
3. `refreshIfStale`（`:307`）：每个 adapter 循环的第一行加 `if (adapter.isActive?.() === false) continue;`，位置在 TTL、`lastAttempt.set`（`:333`）和凭据读取（`:337`）之前。
4. `verdictOf`（`:151`）：在 `providerVerdict` 之后装饰 billing：
   ```ts
   gateOpen =
     settings.droidAllowExtraUsage &&
     b.pool === "standard" &&
     b.overage === "extraUsage" &&
     b.extraUsageAllowed &&
     b.extraUsageBalanceCents > 0;
   ```
   只有 `verdict.billing` 存在时才返回新对象，kimi/zai 的对象引用和形状都不变。
5. `verdictsForModel`：
   - `model.provider !== DROID_PROVIDER` 或 adapters 里没有 droid ⇒ undefined。
   - 否则 `pool = poolFor(model.id)`，按 §2.4 规则得到 keys，再 `verdicts = keys.map((k) => verdictOf(k, now))`。
6. `poolAlternatives(blocked, limit = 3)`（评审 #5）：
   - 前提：`blocked === "droid-standard"`，且 core 的 verdict 未被排除（无 verdict、陈旧、或 `level < 3` 都算未被排除）。
   - 候选按顺序拼接（端口缺席时只剩第 ③ 项）：
     ① `port.modelsInPool("core")`（内部已是"偏好序在前、目录序在后"）；
     ② `settings.droidPools` 中值为 `core` 的键，按插入序，**加法**；
     ③ 去重。
   - 再剔除三类：`settings.droidPools[id]` 不是 `core` 的（**减法**）；目录里标 deprecated 或 router 的；`custom:` 开头的。
   - 取前 limit 个，输出 `droid/<id>`。覆盖键在目录里查不到时**保留**，视为用户的明确意图。
   - `disabled` 不过滤（D18，R12）。
7. `problems()`：遍历 adapters 的 `lastProblem?.()`，按 family 去重。
8. `writeStatus` 把 problems 传给 `renderQuotaStatus`。另外，在刷新尝试**未产出快照**、且该 adapter 有 `lastProblem` 时也调用一次 `writeStatus`（同样受 disposed 守卫），这样 `auth 402` 能在不落快照的情况下显示出来。

---

## 6. 闸门与替代（`src/quota/gate.ts`）

`evaluateQuotaGate`（`:66`）的第一步：

```ts
const view = deps.modelView?.(model);
if (view !== undefined) return evaluatePooledGate(model, view, deps); // 新路径
// …以下旧逻辑一字不改
```

`evaluatePooledGate`：

1. `keys.length === 0`（`none`）⇒ undefined。
2. 任一 `verdicts[i]` 是 undefined 或 `.stale` ⇒ undefined（fail-open，D5）。
3. `blocked_i = v.level >= blockAtLevel && v.billing?.gateOpen !== true`；不是全部都 blocked ⇒ undefined。
4. 替代建议（D7 + D8，评审 #4）：
   `alternatives = { ...pickAlternatives(keys[0], deps, 3), external: true, ...(models.length > 0 ? { models } : {}) }`。
   其中 `models = keys.length === 1 && keys[0] === "droid-standard" ? deps.poolAlternatives?.("droid-standard") ?? [] : []`。
   `providers` 照常是 pi 订阅 provider（`models.recommendable` 的排序结果）。渲染时 core 行在前、pi 行在后，pi 行带「改用 pi 原生子 agent」标题（§7）。
5. message 由 `buildPooledGateMessage`（私有）生成，各行如下：
   - 池已知：`quota gate: droid/<id>（standard 池）的 5h 配额已用尽（100%，02:11 重置），本次 spawn 已快速失败，未消耗任何 run。`（复用 `windowClause`）
   - 池未知：`quota gate: droid/<id>（计费池未知，standard 与 core 池均已触线：<standard 子句>；<core 子句>），本次 spawn 已快速失败，未消耗任何 run。`
   - `billing.overage === "extraUsage"` 且没被放行时追加一行：`Factory 超额策略为 extraUsage（额外余额 $12.34）：pi-toolkit 默认不代你花额外余额；确需继续，在 settings 文件把 quota.droidAllowExtraUsage 设为 true。`
   - `alternativesAdvice(alternatives)`，以及原有的关闭提示行。

`pickAlternatives`（`:96`）：

- 排序、排除逻辑不变。
- `blocked` 是 droid 池 id 时，返回值带 `external: true`；`deps.poolAlternatives` 存在且结果非空时挂 `models`。
- 非 droid 被拦时，对象形状与今天完全一样（golden 钉住）。
- hook 侧（`src/index.ts`）调用 `pickAlternatives(provider, …)`，对 droid 池 id 自动得到同样的两类建议。

`quotaAnnotation`：不改。

---

## 7. 渲染、HUD、hook（`src/quota/render.ts`；hook.ts 零改动）

- **`formatScope`**（`:26`）：`week→"7d"`、`month→"mo"`、其余 `"5h"`。`thresholdText`、`buildQuotaWarnText` 里的 L3 取值走 `DEFAULT_THRESHOLDS_BY_WINDOW[scope]`，补上 month 即可。
- **标签**：`groupSamePool` 的 label、`buildQuotaRecoveryTexts`、`buildQuotaAvailableTexts`、闸门文案都改用 `quotaLabel(p)`。tick 行（`renderProviderLine`）保留原始 id（紧凑英文 token）。
- **`poolSignature`**（`:455`）：droid id 加前缀 `"${provider}#"`，防止两个池读数相同时被去重或合并；其它 provider 的签名字节不变。
- **`alternativesAdvice`**（`:159`），`external` 与 `models` 都缺席 ⇒ 走旧分支，字节不变。`external: true` 时按以下顺序输出：
  1. `models` 非空：`同一 Factory 账户的 core 池仍有额度，优先改用 droid core 池模型：droid/glm-5.3、droid/kimi-k3。（standard 池 = droid 的 Anthropic/OpenAI/Google/xAI 模型；core 池 = Factory 托管开源模型）`
  2. `providers` 非空：`或改用 pi 原生子 agent（订阅优先）：kimi-coding、zai-coding-cn。注意这会换成 pi 子 agent 运行（不是外部 droid，权限与工具按 pi 的 agent 类型）。` 订阅层为空时把「订阅优先」换成「无可用订阅，按量计费」。
  3. 收尾：`按任务需求选；不胜任就按路由表另选合适模型，不必硬凑。`
  4. 两类都空：`暂无替代候选，按路由表另选合适模型（可检查 pi /model；窗口重置后自动恢复）。`
  - `buildMergedBlockText` 遇到任一段带 `external` 或 `models` ⇒ 返回 undefined（回落到逐段输出）。
- **billing 子句**（私有 `billingClause(v)`，只在 `v.billing?.pool === "standard"` 时生效），追加在 L2/L3 首行之后：
  - extraUsage 且没放行：`Factory 超额策略为 extraUsage（额外余额 $X）：standard 池耗尽后 droid 会按量扣额外余额；pi-toolkit 闸门仍按额度拦截（放行需设 quota.droidAllowExtraUsage=true）。`
  - extraUsage 且已放行：`…继续派会消耗额外余额 $X（真钱），闸门不拦截；优先改用 core 池或订阅模型。` 同时 `buildQuotaBlockText` 把 `directUseText` 换成 `建议本轮不要把新任务派给 droid standard 池（继续派会花额外余额）。\n<alternativesAdvice>`，不再承诺"会被拦下"。
  - droidCore：`Factory 超额策略为 droidCore：standard 池耗尽后请改用 core 池模型。`
- **HUD**（`renderQuotaStatus`，`:493`；D14 拍板）：
  - 去重之后，`droid-standard` / `droid-core` 合并成一段：`droid <std cells>[ resets X][ extra $Y] core <core cells>[ resets Z]`。只有一个池有快照时显示 `droid …` 或 `droid core …`。
  - cell 写法：5h/week 维持 `12%`；month 写成 `mo 5%`。`·reset` 后缀照旧。
  - `extra $Y` 出现条件：`overage === "extraUsage"` 且 standard 池有窗口满足 `usedPct ≥ 100` 且原因不是 reset-elapsed。
  - problems 渲染成 `droid auth 402` 段；只有 problems、没有 verdict 时，整行为 `quota droid auth 402`。
  - 主题版：名称、`core`、倒计时用 dim，各池数值按 `levelColor` 着色，`auth 402` 用 `warning` 色。
  - 没有 droid、没有 problems ⇒ 完全走旧代码路径。
- **hook**：本身不改。droid 两个池各自有闩锁、恢复播报、可用播报（按虚拟 id 区分）。

---

## 8. month 窗口在设置里的落点（`src/config/settings.ts`）

- `QuotaSettings.windows` 的类型随 `WindowScope` 自动包含 month。
- `parseQuotaWindowThresholds`（`:1617`）追加 `month: parseWindowThresholds(record?.month, defaults.month, globalOverride)`。全局旧字段照常作用于 month（D9）；注释从"两窗口"改为"所有窗口"。
- `parseQuotaSettings` 追加 `factoryBaseUrl: url(…)`、`droidAllowExtraUsage: bool(…)`、`droidPools: parseDroidPools(value.droidPools)`（新增私有函数）。
- 设置迁移不得写入任何新键（沿用现有测试口径）。
- spec 见 §2.7（D16）。

---

## 9. stack / index / quota-sampler 的改动块（P7 负责）

- **`src/stack.ts` 闸门 deps（`:2037` 附近）**。这里的 `quota` 是局部 `QuotaStack`（`:2036` `const quota = quotaRef.current`），所以要经 `.service`。在 `evaluateQuotaGate(model, { … })` 里追加：
  ```ts
  modelView: (m) => quota.service.verdictsForModel(m),
  poolAlternatives: (b) => quota.service.poolAlternatives(b),
  ```
  没有 droid 适配器时 `verdictsForModel` 恒返回 undefined ⇒ 走旧路径。
- **`src/index.ts` hook（`:405` 附近）**。这里的 `holder.current` 是 `Stack`，而 `Stack.quota` 的类型**就是** `QuotaService`（K9：`stack.ts:949` 声明、`:2702` 赋值 `quota: quota.service`；同一块里现有写法正是 `holder.current?.quota?.verdictFor(p)`）。所以：
  ```ts
  pickAlternatives(provider, { …, poolAlternatives: (b) => holder.current?.quota?.poolAlternatives(b) ?? [] })
  ```
  **不要**写成 `holder.current?.quota?.service.…`：`QuotaService` 上没有 `service` 成员，会编译失败（评审 #1 误报，处置见修订记录 r2）。
- **`src/quota/index.ts` 的 `createQuotaStack`**：
  - `parseProviderWhitelist` 返回 `{ ids, droid: boolean }`（识别 token `droid`，顺带接受单写 `droid-standard` / `droid-core`）。
  - `input.droid` 存在且白名单含 droid ⇒ `createDroidAdapters({ isActive: () => input.droid!.pools() !== undefined, warn })` 交给 `selectAdapters`，并把 `pools: input.droid.pools` 传给 service。
  - `input.droid` 存在但白名单不含 droid ⇒ warnOnce 一次。
- **`src/web-hub/agent/quota-sampler.ts`**（P7 的"安全默认"）：
  - `projectQuota` 里把 `isQuotaProviderId` 换成本地守卫 `isLegacyWebQuotaProviderId`（只认三个旧 id）；`projectProvider` 过滤掉 `scope === "month"` 的窗口。
  - 只有 droid 行时返回 undefined，字段不出现，与功能上线前字节一致。
  - P7wa 在此基础上加 cap 门控的 pools 模式（§9A.4）；P7 单独合入时 web 永远收不到 droid 数据，也不会丢帧。

---

## 9A. web-hub 显示 droid 额度（P7w + P7wa；D12 改判）

### 9A.0 总体

- **P7w**（协议 + hub + UI）**不 import `src/quota/**`**。protocol 保持自含，quota-web 先例就是如此。所以 P7w 与 P7 **可以并行**：协议常量在 §9A.1 写死，两边各自对着这份冻结面施工。
- **P7wa**（agent 投影）依赖 P7（要用 quota 新类型）和 P7w（要用新的 wire 类型与 cap 常量），二者都合入后再做。改动很小：两个文件里的三处，加测试。
- 兼容矩阵：

  | agent \ hub                    | 旧 hub（不认枚举、无 cap）                        | 新 hub（`quota.pools.v1`）                                    |
  | ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------- |
  | 旧 agent / P7（无 pools 模式） | 现状                                              | 新 hub 解码旧形状不受影响（schema 只是放宽），UI 不出现 droid |
  | P7wa                           | 看不到 cap ⇒ pools=false ⇒ 与 P7 字节一致，不丢帧 | pools=true ⇒ 发 droid 行、month、billing、problems            |

- UI 由 hub 自带（`dist/web-hub-ui/` 或按 hubVersion 钉住的外部目录）。**新鲜加载的 UI 恒等于 hub 版本**，所以 UI 侧不需要再判断 cap：能收到 droid 行的新 UI 一定认识它。**陈旧 tab 连新 hub 时降级**（r2 复审建议 #1）：已打开的旧 UI tab 在 hub 升级重连后可能收到 droid 行 / month 窗口，UI 不做 schema 校验，旧 `providerLabel` 对未知 id 回退为裸 id、旧 `windowsOf` 过滤掉 month、`billing` / `problems` 被忽略——只显示裸 id + 5h/week，不崩、不丢帧（登记为 R16）。
- `problems` 技术上不受封闭枚举约束（旧 hub 其实能解码），随 `quota.pools.v1` 门控仅为统一口径（r2 复审建议 #2）。

### 9A.1 协议冻结面（`src/web-hub/protocol/{version,messages}.ts`，append-only）

```ts
// version.ts —— 紧随 RUNTX_HUB_CAPS / HOLD_* 之后
/** P7w：hub 能解码 droid 池额度（QuotaProviderWire.id ∈ droid-*、QuotaWindowWire.scope="month"、billing、problems）。
 *  无条件通告，hub 两个 cap 面（HubInfo.caps / hello_ack.caps）同位追加；agent 只在 hello_ack.caps ∋ 本 cap 时发这些内容。
 *  不新增帧 ⇒ 不升 PROTO（同 preview.chunk.v1 先例）。 */
export const QUOTA_POOLS_HUB_CAP = "quota.pools.v1";
export const QUOTA_POOLS_HUB_CAPS = [QUOTA_POOLS_HUB_CAP] as const;
```

```ts
// messages.ts —— quota wire（:244-288 段）
export type QuotaScopeWire = "5h" | "week" | "month"; // month 只来自看到 quota.pools.v1 的 agent
export type QuotaProviderIdWire = "zai-coding-cn" | "zai" | "kimi-coding" | "droid-standard" | "droid-core";
export interface QuotaWindowWire {
  scope: QuotaScopeWire;
  usedPct: number;
  level: 0 | 1 | 2 | 3;
  resetAt?: number;
  etaMs?: number;
}
/** 只出现在 droid-* 行。 */
export interface QuotaBillingWire {
  overage: "droidCore" | "extraUsage" | "off";
  extraUsageBalanceCents: number; // 整数 ≥0
  gateOpen?: true; // service 装饰为 true 时才出现
}
export interface QuotaProviderWire {
  id: QuotaProviderIdWire;
  plan?: string;
  level: 0 | 1 | 2 | 3;
  stale: boolean;
  fetchedAt?: number;
  demotedUntil?: number;
  windows: QuotaWindowWire[];
  billing?: QuotaBillingWire; // P7w 追加
}
export interface QuotaProblemWire {
  family: "droid";
  status: number;
} // 401|402|403
export interface QuotaWire {
  v: 1;
  at: number;
  providers: QuotaProviderWire[];
  problems?: QuotaProblemWire[]; // P7w 追加；只在 pools 模式且非空时出现
}
```

Schema（`:1093-1120` 段，保持 open posture `additionalProperties: true`）：

- `QuotaWindowSchema.scope`：联合加 `Type.Literal("month")`。
- `QuotaProviderSchema.id`：联合加 `Type.Literal("droid-standard")`、`Type.Literal("droid-core")`；新增 `billing: Type.Optional(QuotaBillingSchema)`，其中 `QuotaBillingSchema = Type.Object({ overage: Union(3 literals), extraUsageBalanceCents: Type.Integer({ minimum: 0 }), gateOpen: Type.Optional(Type.Literal(true)) }, { additionalProperties: true })`。
- `QuotaWireSchema`：新增 `problems: Type.Optional(Type.Array(Type.Object({ family: Type.Literal("droid"), status: Type.Integer({ minimum: 100, maximum: 599 }) }, { additionalProperties: true }), { maxItems: 4 }))`。
- `windows maxItems: 8`、`providers maxItems: 16` 不变（droid 每行 3 个窗口，总共 5 行）。
- `StatusInfo` / `StatusInfoSchema` 本身**不改**（`quota` 字段已存在），与 #26 的追加点不在同一块。

### 9A.2 hub（`src/web-hub/hub/{agent-server,hub}.ts`）

- `agent-server.ts` 的 `hello_ack.caps`（`:172-188`）与 `hub.ts` 的 `HubInfo.caps`（`:555-563`），都在 `...RUNTX_HUB_CAPS,` 之后、`...extraHubCaps` 之前插入 `...QUOTA_POOLS_HUB_CAPS,`。两处同位置，保持 caps-coexist 的集合与顺序一致。
- 解码：status 帧经放宽后的 `QuotaWireSchema` 透传，hub 不读取 quota 内容（`toCard` 整体透传），无其它改动。
- 测试：`tests/web-hub/hub/agent-server-admin.test.ts:115` 的精确 caps 数组追加 `"quota.pools.v1"`；`tests/web-hub/hub/hub.test.ts` 加 `arrayContaining([...QUOTA_POOLS_HUB_CAPS])`；`tests/web-hub/hub/caps-coexist.test.ts` 的两面集合相等断言自动覆盖（必要时加一条显式断言）。

### 9A.3 UI（`src/web-hub/ui/src/…`）

**`logic/quota.js`**：纯逻辑，所有分支都给 kimi/zai 留原路径。

- `scopeLabel(scope)`：`week→"7d"`、`month→"mo"`、其余 `"5h"`。
- `pillGroups` 的 `windowsOf`：排序表改为 `{ "5h": 0, week: 1, month: 2 }`，过滤条件放行 `month`。kimi/zai 不会有 month ⇒ 输出不变。
- `groupOf` 新增字段 `exhaustScope` / `exhaustResetAt`（exhausted 模式的时钟来源）：
  - 非 `droid-*` 行：`exhaustScope = "week"`、`exhaustResetAt = weekResetAt`（与现状等价，原字段 `weekResetAt` 保留）。
  - `droid-*` 行：取 `level ≥ 3` 的窗口里 resetAt 最大者（要等最长的那个窗口重置），并用它的 scope；未知 ⇒ undefined。与 HUD `recoveryCountdownText` 的取最大口径一致。
- D6 重置附注：`droid-*` 行的优先级是 month（level≥1）> week（level≥1）> 5h（>70%）；非 droid 行不会有 month，规则等价不变。
- `groupOf` 新增 `extra`：仅 `droid-standard` 且 `billing.overage==="extraUsage"` 且 `headline.level >= 3` 时为 `{ cents }`，否则不出现。
- 新增 `pillProblems(quota)`：返回 `[{ family, status }]`，非法项丢弃，最多 4 条。
- `pillDisplay`：
  - 有 problems 时返回值加 `problems` 字段；没有时形状不变。
  - **groups 为空但有 problems** ⇒ `{ mode: "available", groups: [], problems }`；两者都空 ⇒ null（与现状一致）。
- `glmPair`、`freshestQuota` 不改（droid 行天然参与新鲜度排序）。

**`components/quota/QuotaPill.vue`**：

- 类型：`PillWindow.scope` / `PillGroup.scope` 联合加 `"month"`（`:50/:59/:78`）。
- `segText`：
  - 桌面：`droid 5h 12% · 7d 40% · mo 5%`、`droid core 5h 0% · 7d 0% · mo 0%`，沿用现有拼法。`g.extra` 存在时在附注后追加 ` · extra $12.34`（紧凑 token）。
  - 移动（≤767px）：`droid 12%/40%/5%`，沿用。
  - exhausted 模式：`⚠ ${label} · ${scopeLabel(g.exhaustScope)} ${clock} reset`。非 droid 恒为 `7d` ⇒ 字节不变。
- problems：每条渲染为一个 `q-seg q-problem`，`data-level="2"`，文本 `droid auth 402`（紧凑 token），aria 走 `quota.problemAria`。phone（≤480px）的单 chip 规则不变；groups 为空、只有 problems 时，chip 文本为 `auth 402`。
- `pillLevel`：problems 存在时取 `max(现值, 2)`。

**`components/quota/QuotaCard.vue`**：

- `scopeText`：`month → t("quota.scopeMonth")`。
- droid 行照常是一行一个池（`droid` / `droid core`），每行 3 个窗口行，复用 bar、ETA、重置时间。
- 头部徽章（`q-head`，追加在 plan / demoted / stale 之后），只出现在 `droid-standard` 行：
  - `billing.overage === "droidCore"` ⇒ `t("quota.overageCore")`；
  - `extraUsage` ⇒ `t("quota.overageExtra", { amount: "$12.34" })`；再加上 `gateOpen` 时追加 `t("quota.overageAllowed")`；
  - `off` ⇒ 不显示。
- problems：标题下方一行 `q-problem-row`，文本为 `t("quota.authProblem", { status })`。
- 没有 droid、没有 problems ⇒ 模板输出不变。

**`i18n/{en,zh}/quota.ts`**（新键，两种语言同时加，以通过 `i18n-parity.test.ts`；该测试文件本身不改）：

| 键                        | en                                                                                                           | zh                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `provider.droid-standard` | `droid`                                                                                                      | `droid`（品牌 token，两种语言相同）                                                      |
| `provider.droid-core`     | `droid core`                                                                                                 | `droid core`                                                                             |
| `scopeMonth`              | `month`                                                                                                      | `月`                                                                                     |
| `overageCore`             | `Overage: switch to core pool`                                                                               | `超额：改用 core 池`                                                                     |
| `overageExtra`            | `Overage: extra usage ({amount})`                                                                            | `超额：额外余额（{amount}）`                                                             |
| `overageAllowed`          | `extra usage allowed`                                                                                        | `已允许花额外余额`                                                                       |
| `authProblem`             | `droid quota unavailable: Factory billing API returned HTTP {status} — check FACTORY_API_KEY and restart pi` | `droid 额度不可用：Factory 计费接口返回 HTTP {status}，请检查 FACTORY_API_KEY 并重启 pi` |
| `problemAria`             | `droid quota: HTTP {status}`                                                                                 | `droid 额度：HTTP {status}`                                                              |

**`styles/quota.css`**：新增 `.q-problem`（复用 `[data-level="2"]` 的颜色变量）、`.q-problem-row`、`.q-badge.q-overage`。不在组件里写 `<style>`（source-scan 规则）。

### 9A.4 P7wa：agent 投影（`src/web-hub/agent/quota-sampler.ts`、`agent/index.ts`、`src/index.ts`）

```ts
// quota-sampler.ts
export interface QuotaProjectionOptions {
  /** hello_ack.caps ∋ quota.pools.v1；缺省/false ⇒ P7 的过滤行为（字节不变）。 */
  readonly pools?: boolean;
  readonly problems?: readonly QuotaProblem[];
}
export function projectQuota(
  verdicts: readonly ProviderVerdict[] | undefined,
  now: number,
  opts?: QuotaProjectionOptions,
): QuotaWire | undefined;
```

- `pools` 不为 true ⇒ 与 P7 完全一致：只保留三个旧 id、丢掉 month、不带 billing / problems。
- `pools === true`：
  - 守卫改用全部 5 个 wire id；保留 month 窗口。
  - droid 行带 `billing: { overage, extraUsageBalanceCents, ...(gateOpen ? { gateOpen: true } : {}) }`。
  - `problems` 只收 `family === "droid"` 的条目，最多 4 条，非空才挂上。
  - providers 为空但有 problems ⇒ `{ v: 1, at, providers: [], problems }`；两者都空 ⇒ undefined。
- `quotaFingerprint`：每行追加 `billing`（overage、cents、gateOpen），顶层追加 `problems`。这些字段在 legacy wire 上都是 undefined，`JSON.stringify` 会省略 ⇒ 旧指纹字节不变。
- `agent/index.ts`：
  - `WebHubDeps`（`:198` 起）新增 `quotaProblems?: () => readonly QuotaProblem[]`。
  - `quotaProjection`（`:447`）改为：
    ```ts
    projectQuota(d(), now(), {
      pools: conn?.status().state === "live" && (conn?.caps.includes(QUOTA_POOLS_HUB_CAP) ?? false),
      problems: deps.quotaProblems?.(),
    });
    ```
  - 重连到新 hub 后 cap 变化 ⇒ 投影变化 ⇒ 1Hz tick 的指纹门控自然触发 publish，不需要额外事件。
- `src/index.ts`（`wireWebHub` 块，`:1021`）：在 `quota` dep 那一行之后追加：
  ```ts
  ...(settings.webHub.quota !== false ? { quotaProblems: () => holder.current?.quota?.problems() ?? [] } : {}),
  ```
  这里同样是 `holder.current.quota` = `QuotaService`（K9）。

### 9A.5 P7w / P7wa 的字节不变保证

- **UI golden**：`tests/fixtures/web-hub-ui/quota-legacy-golden.json`，在 P7w 的第一个提交、基于未改动的 master 生成，此后永不重生成。覆盖对象：kimi、zai 对、GLM 合并、stale、demoted、L3 exhausted 这些 wire 在 `pillGroups` / `pillDisplay` / `pillView` / `freshestQuota` 下的输出；`QuotaPill` 挂载后的 HTML（en/zh × 桌面/移动/phone）和 `QuotaCard` 的 HTML（en/zh）。测试：`tests/web-hub/ui/quota-legacy-golden.test.ts`。
- **旧 hub 兼容**：`tests/web-hub/protocol/quota-pools-schema.test.ts` 内嵌一份改动前的 `LEGACY_QUOTA_WIRE_SCHEMA` 副本，断言：
  1. 未门控的 droid 帧会被旧 schema 拒（说明门控确有必要）；
  2. `projectQuota(…, { pools: false })` 的输出能通过旧 schema；
  3. 新 schema 接受 month / droid / billing / problems；
  4. 旧形状 wire 在新旧 schema 下解码结果相同。
- **agent 侧**：P7 的 `quota-kimi-zai-golden.json` 里已含 `projectQuota` / `quotaFingerprint`，P7wa 必须让它在不传 opts、以及传 `{ pools: false }` 两种情况下都保持相等。

---

## 10. 分包

| 包                                | 波次                                          | 目标                                                                                                                                                                                                                                                           | 文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 依赖                        |
| --------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **P7** quota 接入（L2）           | 现在（与 P3、#23 P2b、#26 并行）              | §2–§9 全部，含原 P7s（D16）和 `docs/dev/quota/*` 的偏差记录（评审 #8）                                                                                                                                                                                         | `src/quota/{types,ladder,service,gate,render,credentials,http,index,pools}.ts`、`src/quota/adapters/{types,index,droid}.ts`、`src/config/{settings,setting-specs}.ts`、`src/web-hub/agent/quota-sampler.ts`、`src/stack.ts`（只改闸门 deps 块）、`src/index.ts`（只改 quota hook 块）、`docs/dev/quota/{quota-plan,integration-map}.md`（只追加偏差记录节）；`tests/quota/**`、`tests/config/quota-settings.test.ts`、`tests/web-hub/agent/quota-sampler.test.ts`、`tests/integration/quota-wiring.test.ts`、`tests/fixtures/quota/**`、`tests/fixtures/quota-kimi-zai-golden.json`                                                                                                                | P1、P4a（均已合入）         |
| **P7w** web 协议 + hub + UI（L2） | 现在，**与 P7 并行**                          | §9A.1–§9A.3、§9A.5 的 UI 与 schema 部分，加 `docs/dev/quota-web/plan.md` 的 §8 修订节                                                                                                                                                                          | `src/web-hub/protocol/{version,messages}.ts`（只改 quota 段）、`src/web-hub/hub/{agent-server,hub}.ts`（只改 caps 列表）、`src/web-hub/ui/src/logic/quota.js`、`src/web-hub/ui/src/components/quota/{QuotaPill,QuotaCard}.vue`、`src/web-hub/ui/src/i18n/{en,zh}/quota.ts`、`src/web-hub/ui/src/styles/quota.css`、`docs/dev/quota-web/plan.md`；`tests/web-hub/protocol/quota-pools-schema.test.ts`（新）、`tests/web-hub/hub/{agent-server-admin,hub,caps-coexist}.test.ts`、`tests/web-hub/ui/{logic-quota,quota-pill}.test.ts`、`tests/web-hub/ui/quota-legacy-golden.test.ts`（新）、`tests/web-hub/ui/quota-pools.test.ts`（新）、`tests/fixtures/web-hub-ui/quota-legacy-golden.json`（新） | 无（不 import `src/quota`） |
| **P7wa** agent 投影（L1）         | P7 与 P7w 都合入后；若 #26 P-A 在途，排在其后 | §9A.4                                                                                                                                                                                                                                                          | `src/web-hub/agent/{quota-sampler,index}.ts`、`src/index.ts`（只改 `wireWebHub` 的 quota dep 行）；`tests/web-hub/agent/quota-sampler.test.ts`、`tests/web-hub/agent/quota-pools-wiring.test.ts`（新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P7、P7w                     |
| **P5 增量**                       | 波次 3                                        | §4 接线清单 3 条（含 `warm()`）                                                                                                                                                                                                                                | P5 原有文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P7（D15）                   |
| **P6 增量**                       | 波次 3                                        | AGENTS.md 的 `src/quota/` 与 `src/web-hub/` 条目补「droid 池、month、白名单 token、extraUsage、`quota.pools.v1`」；droid README 补「quota 行与 web pill、旧 key 需重启 pi、自定义 providers 需加 droid、extraUsage 默认拦截」                                  | P6 原有文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P7、P7w                     |
| ~~P7s~~                           | —                                             | 并入 P7（评审 #2）                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                           |
| ~~F1~~ 目录 billingPool           | —                                             | 取消（SP1 阴性）                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                           |
| F3 耗尽信号提速                   | 可选                                          | D13                                                                                                                                                                                                                                                            | `src/stack.ts`、`src/quota/service.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P5                          |
| F4 模型 `disabled`                | 可选，等 P3 合入后再评估                      | D18：冻结面 `ExternalModelInfo` 加 `disabled?: boolean`（P1 负责人，纯加法 + 广播）；P3 的目录探测在 `initialize_session` 之后补一次 `droid.list_models` 读取 `disabled`；P2 的 catalog-store 原样往返；`CatalogModelLike` 加 `disabled?`，`modelsInPool` 过滤 | `src/external-agent/{types,catalog-store}.ts`、`src/external-agent/droid/catalog.ts`、`src/quota/pools.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | P3、P7                      |

**推荐派发顺序**：

1. 立即同消息并行派发 **P7 ∥ P7w**。两者文件域零交集，也与在途的 P3、#23 P2b、#26 零交集（只有 P7w ∩ #26 P0 都碰 `messages.ts`，见下文）。
2. P7 与 P7w 都合入、且 #26 P-A 已合入（或确认不在途）之后，派 **P7wa**。
3. P5 在 P7 合入后派发（D15）。P6 在 P7、P7w 合入后派发。

**与在途 / 待做的 web-hub 包的交集与合并顺序**：

| 对方                                                                                                                                                                                                             | 交集文件                                                                                                                                                | 冲突性质                                                                                                                                                                                             | 顺序                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| #26 P0（`messages.ts` 追加 `CacheKeepaliveWire` 与 `StatusInfo.cacheKeepalive`）                                                                                                                                 | P7w：`src/web-hub/protocol/messages.ts`                                                                                                                 | 不同块。P7w 改 quota wire 段（`:244-288`、`:1093-1120`），#26 改 `StatusInfo`（`:466`）、`StatusInfoSchema`（`:1174`）并在文件末尾追加新 schema。语义零冲突。                                        | 谁先都行，后合方 rebase。#26 P0 是"先合的小包"，建议它先合，P7w rebase。     |
| #26 P-A（`agent/{status,index}.ts`、`src/index.ts` 的 `wireWebHub` 块）                                                                                                                                          | P7wa：`agent/index.ts`（`WebHubDeps` 接口、`quotaProjection` 闭包）、`src/index.ts`（`:1021` 紧邻行）；P7：`src/index.ts`（hook 块 `:399-411`，不同块） | P7wa 与 #26 P-A 在 `src/index.ts` 的 `quota` dep 邻行和 `WebHubDeps` 接口的邻近位置**大概率出现文本冲突**，语义不冲突。P7wa 不改 `agent/status.ts`（`readStatus` 签名不动）。                        | **P7wa 排在 #26 P-A 之后**，由 P7wa rebase。                                 |
| #26 P-B（`components/detail/*`、`DetailHeader.vue`、`styles/cache-keepalive.css`、`i18n/*/cacheKeepalive.ts`）                                                                                                   | 无                                                                                                                                                      | —                                                                                                                                                                                                    | 无约束                                                                       |
| #23 P2b（`ui/src/{composables/usePreview.ts,components/preview/*,styles/preview.css,i18n/{zh,en}/preview.ts,logic/previewStream.js}`，以及 `tests/web-hub/ui/{i18n-parity,source-scan,checks-body*,…}.test.ts`） | 文件无交集                                                                                                                                              | 共享的是测试约束：P7w **不得编辑** `i18n-parity.test.ts` / `source-scan.test.ts`，只需让 en/zh 键对齐、组件里不写 `<style>`。`tests/web-hub/check-ui-dist-budget.test.ts` 的体积预算两边都会吃一点。 | 无顺序约束；后合方 rebase 后重跑 `build:web` + `check:web` + dist 预算测试。 |
| P5（`src/stack.ts`、`src/index.ts`）                                                                                                                                                                             | P7、P7wa                                                                                                                                                | 不同块                                                                                                                                                                                               | D15：P5 在 P7 之后；P7wa 与 P5 谁先都行。                                    |

**conflict-check 输入**（与当前在途的 P3、#23 P2b、#26 P0 一起跑，期望 exit 0）：

```json
[
  {
    "id": "P7",
    "globs": [
      "src/quota/**",
      "src/config/settings.ts",
      "src/config/setting-specs.ts",
      "src/web-hub/agent/quota-sampler.ts",
      "src/stack.ts",
      "src/index.ts",
      "docs/dev/quota/**",
      "tests/quota/**",
      "tests/config/quota-settings.test.ts",
      "tests/web-hub/agent/quota-sampler.test.ts",
      "tests/integration/quota-wiring.test.ts",
      "tests/fixtures/quota/**",
      "tests/fixtures/quota-kimi-zai-golden.json"
    ]
  },
  {
    "id": "P7w",
    "globs": [
      "src/web-hub/protocol/version.ts",
      "src/web-hub/protocol/messages.ts",
      "src/web-hub/hub/agent-server.ts",
      "src/web-hub/hub/hub.ts",
      "src/web-hub/ui/src/logic/quota.js",
      "src/web-hub/ui/src/components/quota/**",
      "src/web-hub/ui/src/i18n/en/quota.ts",
      "src/web-hub/ui/src/i18n/zh/quota.ts",
      "src/web-hub/ui/src/styles/quota.css",
      "docs/dev/quota-web/**",
      "tests/web-hub/protocol/quota-pools-schema.test.ts",
      "tests/web-hub/hub/agent-server-admin.test.ts",
      "tests/web-hub/hub/hub.test.ts",
      "tests/web-hub/hub/caps-coexist.test.ts",
      "tests/web-hub/ui/logic-quota.test.ts",
      "tests/web-hub/ui/quota-pill.test.ts",
      "tests/web-hub/ui/quota-legacy-golden.test.ts",
      "tests/web-hub/ui/quota-pools.test.ts",
      "tests/fixtures/web-hub-ui/quota-legacy-golden.json"
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
    "id": "#23-P2b",
    "globs": [
      "src/web-hub/ui/src/composables/usePreview.ts",
      "src/web-hub/ui/src/components/preview/**",
      "src/web-hub/ui/src/styles/preview.css",
      "src/web-hub/ui/src/i18n/zh/preview.ts",
      "src/web-hub/ui/src/i18n/en/preview.ts",
      "src/web-hub/ui/src/logic/previewStream.js",
      "tests/web-hub/ui/i18n-parity.test.ts",
      "tests/web-hub/ui/source-scan.test.ts",
      "tests/web-hub/ui/preview-*.test.ts",
      "tests/web-hub/ui/use-preview.test.ts",
      "tests/web-hub/ui/logic-preview-stream.test.ts",
      "tests/web-hub/ui/checks-body*.test.ts",
      "tests/web-hub/ui/highlighted-code.test.ts",
      "scripts/web-hub/visual/checks-body.ts"
    ]
  }
]
```

`#26 P0`（`src/web-hub/protocol/messages.ts`）与 P7w 在 glob 层面必然相交，这一对按上表"不同块、后合方 rebase"处理，**不放进同一次 conflict-check**。P7wa 不参与并行检查（串行包）。

**P7 的提交顺序**（验收时核对 `git log`）：

1. kimi/zai golden fixture + golden 测试，基于**未改动的 master** 生成，此后永不重生成。
2. types / ladder / settings（month）+ setting-specs + sampler 过滤。
3. droid 适配器、credentials、http。
4. pools + service。
5. gate、render、HUD。
6. stack / index 改动块 + 集成测试。
7. `docs/dev/quota/quota-plan.md` 与 `integration-map.md` 各追加一节「偏差记录：droid 池与 month 窗口（#22 P7）」（评审 #8），写清三 provider → 五 id、两窗口 → 三窗口、按模型闸门、`quota.pools.v1`，并链接回本文件。

**P7 自验**：

```sh
npx vitest run tests/quota tests/config/quota-settings.test.ts tests/web-hub/agent/quota-sampler.test.ts tests/integration/quota-wiring.test.ts && npm run typecheck
```

然后跑全量门禁：`format:check → typecheck → test → build`。

**P7 验收**：

1. kimi/zai golden 逐字节相等。
2. §2 的签名逐条存在。
3. 未传 `droid` 输入 ⇒ adapters 与改动前 deep-equal，stub fetch 零 Factory 请求。
4. 传了 `droid` 输入但 `pools()` 返回 undefined ⇒ 凭据桩零调用、零请求、零告警。
5. §11 中属于 P7 的单测全部通过。
6. 任何告警、HUD、文案输出里都不含 key 子串。
7. `FakeClock.pendingTimers === 0`。
8. `docs/dev/quota/*` 的偏差记录已追加。
9. 全量门禁绿。

**P7w 的提交顺序**：

1. UI legacy golden fixture + 测试，以及含 `LEGACY_QUOTA_WIRE_SCHEMA` 副本的 schema 测试骨架，都基于未改动的 master。
2. 协议常量与 schema。
3. hub caps 两个面。
4. `logic/quota.js`。
5. 组件、i18n、css。
6. `docs/dev/quota-web/plan.md` 追加「§8 droid 池与 month（#22 P7w）」。

**P7w 自验**：

```sh
npx vitest run tests/web-hub/protocol tests/web-hub/hub tests/web-hub/ui && npm run typecheck && npm run build:web && npm run check:web
```

然后跑全量门禁。

**P7w 验收**：

1. UI legacy golden 逐字节相等。
2. caps 两个面同位追加 `quota.pools.v1`，caps-coexist 绿。
3. 旧 schema 副本测试的 4 条断言全部通过（§9A.5）。
4. 用手写的 droid wire fixture 跑出 pill/card 的分池显示、month、exhausted 时钟、extra、auth 各一例。
5. i18n-parity、source-scan 无需修改即绿。
6. 真机抽查（桌面 + 手机宽度各一张截图，贴 PR）。

**P7wa 验收**：

1. 不传 opts 或传 `{ pools: false }` ⇒ 输出与 P7 golden 相等。
2. 假 conn 的 caps 含 / 不含 `quota.pools.v1` 两种情况各一例。
3. cap 在重连后出现 ⇒ 下一个 tick 发布新帧。
4. 只有 problems ⇒ `providers: []`。
5. 全量门禁绿。

---

## 11. 测试计划

| 文件                                                                                                                                                   | 所属包          | 关键用例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`tests/quota/kimi-zai-golden.test.ts`** + `tests/fixtures/quota-kimi-zai-golden.json`（第一个提交生成，参照 compact-hint golden 的先例，永不重生成） | P7              | 固定 `now`，测试顶部设 `process.env.TZ="Asia/Shanghai"`。kimi（5h 8% / week 100% exhausted 带 reset）、zai-coding-cn+zai 同池、L1/L2/L3、stale、demotion 地板、reset-elapsed、week 的 forecast-before-reset 各一份 verdict。断言对象：`providerVerdict` 的 JSON；`renderQuotaStatus` 的纯文本版与主题版；`buildQuotaMessage` / `buildQuotaTickText` / `buildQuotaWarnText` / `buildQuotaBlockText` / `buildQuotaRecoveryTexts` / `buildQuotaAvailableTexts`；`evaluateQuotaGate` 的 message（不带新 deps / 带新 deps 但非 droid 模型，两者都要等于旧输出）；`pickAlternatives`、`quotaAnnotation`、`alternativesAdvice`；`createQuotaHintHook` 发出的 content+details；`projectQuota` + `quotaFingerprint`。 |
| `tests/quota/adapters-droid.test.ts` + `tests/fixtures/quota/factory-limits-*.json`                                                                    | P7              | 实测全 0 样本；standard 5h 100% 且 windowEnd 在未来；inactive（null）；windowEnd 已过；只有 `secondsRemaining`；windowEnd 为字符串和数字两种；缺 `limits`；overage 三态和未知值；余额为负数或 NaN；usedPercent 为 NaN/Infinity/负数；header 带 `Bearer`；无 key 不发请求；同一 pass 内两个适配器只发一次请求（含"inflight 在首个 await 前同步赋值"）；401/402/403 ⇒ `lastProblem` + warnOnce（同一状态码只告警一次）、成功后清除、告警不含 key；注入的 fetch 抛错也不外抛。                                                                                                                                                                                                                                  |
| `tests/quota/pools.test.ts`                                                                                                                            | P7              | `derivePool` 全表；`modelsInPool` 过滤 deprecated/router/custom、preferred 优先；catalog 抛错或缺席时退化；`warm()` 吞异常且只调一次 catalog。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/quota/ladder.test.ts`                                                                                                                           | P7              | month 默认阈值；`forecastBeforeReset:false` 时不抬到 L2，但 3a 仍然抬到 L3；billing 条件透传；5h/week 行为不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/quota/service.test.ts`                                                                                                                          | P7              | `isActive=false` ⇒ 不读凭据、不记 `lastAttempt`，翻成 true 后立即拉取；`verdictsForModel` 覆盖池已知、未知、`none`、非 droid、端口缺席、`droidPools` 覆盖；`gateOpen` 装饰的四个条件；`poolAlternatives` 覆盖 core 健康 / core L3 / core 陈旧 / blocked 不是 droid-standard，**`droidPools` 改判进 core 的模型出现在建议里、改判出 core 的被剔除、目录缺席时仍给出覆盖键**（评审 #5）；problem 未落快照时也写 HUD；ring 与 demotion 按虚拟 id 隔离。                                                                                                                                                                                                                                                         |
| `tests/quota/gate.test.ts`                                                                                                                             | P7              | standard 耗尽 ⇒ 拦，message 里 core 模型行在前、「改用 pi 原生子 agent」行在后（评审 #4）；core 被拦 ⇒ 只有 pi 行（带新标题）；池未知只有一个池触线 ⇒ 放行，两个池都触线 ⇒ 拦（文案为"计费池未知"）；任一池陈旧或无快照 ⇒ 放行；`gateOpen` ⇒ 放行；extraUsage 未放行时文案含余额和设置名；`none` ⇒ 放行；非 droid 被拦 ⇒ `AlternativeSelection` 无 `external`/`models`。                                                                                                                                                                                                                                                                                                                                     |
| `tests/quota/render.test.ts`                                                                                                                           | P7              | HUD 合并段、`mo 5%`、各池独立倒计时、`extra $12.34`、`auth 402`（有/无 verdict，纯文本与主题版）；`quotaLabel`；`external` 下的四种组合（models 有/无 × providers 有/无）；合并块遇到 `external` 时回落；三种 billing 子句；放行后 L3 不再承诺"会被拦下"。                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/quota/hook.test.ts`                                                                                                                             | P7              | 两个池的闩锁互不影响；droid-standard 进入 L3 时 alternatives 带 models 与 external；可用播报两池分行且标签正确。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/quota/credentials.test.ts`                                                                                                                      | P7              | droid id 回落到 `FACTORY_API_KEY`；两个 droid id 只告警一次、文案写 `droid`；kimi/zai 的告警文案不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/quota/http.test.ts`                                                                                                                             | P7              | `onHttpError` 只在最终失败时调一次；中途重试不调；它抛错不影响"永不抛"；不传时行为不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/config/quota-settings.test.ts`                                                                                                                  | P7              | 更新 `:61`/`:203` 两处默认值断言；month 覆盖与全局旧字段的优先级；`factoryBaseUrl` 校验；`droidPools` 解析与丢弃非法条目；`droidAllowExtraUsage` 默认 false；**spec**：三个 `quota.windows.month.*` 和 `quota.droidAllowExtraUsage` 存在且 non-live；`quota.factoryBaseUrl` / `quota.droidPools` 加入 `:184` 的"必须缺席"列表。                                                                                                                                                                                                                                                                                                                                                                              |
| `tests/web-hub/agent/quota-sampler.test.ts`                                                                                                            | P7（P7wa 扩充） | P7：只有 droid ⇒ undefined；droid 与 kimi 混合 ⇒ 输出与只有 kimi 时逐字节一致；kimi verdict 混入 month（防御）⇒ 丢掉。P7wa：`pools:true` 下 droid 行、month、billing（gateOpen 仅为 true 时出现）、problems（只收 droid、最多 4 条）、只有 problems 时 `providers:[]`；指纹在 legacy 输入下与旧值相同，在 billing / problems 变化时变化。                                                                                                                                                                                                                                                                                                                                                                    |
| `tests/integration/quota-wiring.test.ts`                                                                                                               | P7              | 真 stack，`providers:"…,droid"`，桩注入 `droid.pools`、stub fetch：standard 耗尽时 spawn `droid/claude-opus-5-5` ⇒ config 错误且不建 run；`droid/glm-5.3` ⇒ 放行；不注入 `droid` ⇒ 零 Factory 请求。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/web-hub/protocol/quota-pools-schema.test.ts`（新）                                                                                              | P7w             | §9A.5 的 4 条；`QUOTA_POOLS_HUB_CAP === "quota.pools.v1"`；billing / problems 的边界（cents 负数、status 越界、problems 超过 4 条）被拒。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tests/web-hub/hub/{agent-server-admin,hub,caps-coexist}.test.ts`                                                                                      | P7w             | caps 两个面都含 `quota.pools.v1` 且位置一致。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/web-hub/ui/quota-legacy-golden.test.ts` + fixture（新）                                                                                         | P7w             | §9A.5 UI golden。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/web-hub/ui/logic-quota.test.ts`（扩充）、`quota-pools.test.ts`（新）、`quota-pill.test.ts`（扩充）                                              | P7w             | `scopeLabel("month")`；`windowsOf` 排序 5h/week/month；droid 组的 `exhaustScope` 取最长已耗尽窗口；D6 附注优先 month；`extra` 只在 standard + extraUsage + L3 时出现；`pillProblems`；problems-only 的 `pillDisplay`；Pill 在桌面/移动/phone 下的 droid 文本、exhausted 时钟、auth chip；Card 的 month 行、超额徽章三态、gateOpen 徽章、auth 行；en/zh 文案。                                                                                                                                                                                                                                                                                                                                                |
| `tests/web-hub/agent/quota-pools-wiring.test.ts`（新）                                                                                                 | P7wa            | `wireWebHub` + 假 conn：caps 不含 cap ⇒ status 帧里没有 droid；含 cap ⇒ 有；重连后 cap 出现 ⇒ 下一 tick 发帧；`quotaProblems` getter 抛错 ⇒ 视为无 problems（不拖垮 status）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 12. 风险

| #   | 风险                                                                                                                                  | 缓解                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 启发式误判池（inkling/qwen/muse-spark 等 factory 模型）                                                                               | `quota.droidPools` 覆盖，覆盖同时作用于判定和替代建议（评审 #5）；池未知时两池 fail-open。SP1 已阴性，没有更好的数据源。                                                                                                                                                                                        |
| R2  | pi 环境里是旧 key（**已实测 402**）                                                                                                   | warnOnce + HUD `droid auth 402` + web auth chip；文案明确写"重启 pi"；quota 失败不拦 spawn（D3 拍板）。                                                                                                                                                                                                         |
| R3  | 偏好为 droidCore、standard 已耗尽时，droid 可能静默换成 core 模型（SP2）                                                              | 闸门在 standard 耗尽时直接拦下 standard 模型；P3 的生效值比对能兜住 init/update 阶段的换模型。                                                                                                                                                                                                                  |
| R4  | extraUsage 会花真钱                                                                                                                   | 默认拦截（D6 拍板）；文案、HUD、web 卡片徽章都写出余额。                                                                                                                                                                                                                                                        |
| R5  | Factory 接口形状漂移，或部署在 airgap / customer-prem                                                                                 | 全守卫、永不抛；无快照 ⇒ 放行；`factoryBaseUrl` 可改。                                                                                                                                                                                                                                                          |
| R6  | 请求频率与挂起（评审 #7 改写）                                                                                                        | 每个 refresh pass 最多发一次 Factory 请求：两个池的适配器在同一 pass 里串行调用，第二个复用第一个的在途 promise（5s 合并窗口）。两池的 TTL 天然对齐，慢池总是搭快池的车，所以实际请求频率 = 较快池的 TTL（10min，≥L1 时 2min，D21）。请求本身走 `createFetchJson`（10s 超时、unref、最多 2 次尝试），零计时器。 |
| R7  | 旧 hub 收到 droid/month 后丢掉整帧                                                                                                    | P7 过滤；P7wa 只在 `hello_ack.caps ∋ quota.pools.v1` 时发送；旧 schema 副本测试锁死（§9A.5）。                                                                                                                                                                                                                  |
| R8  | 主会话出现 droid 的 L1 tick / 可用播报，显得噪                                                                                        | 只在用户启用 droid 后出现；`tickStepPercent` 与最小间隔照常约束。                                                                                                                                                                                                                                               |
| R9  | 类型扩展的连锁影响（`Record<WindowScope>` 穷举、web 联合类型）                                                                        | typecheck 会兜住；已逐一列出 settings、ladder、sampler、UI 组件类型。                                                                                                                                                                                                                                           |
| R10 | usedPercent 四舍五入后变 100，比 droid 早一步报 exhausted                                                                             | 闸门本来就在 L3 拦；与 kimi 口径一致。                                                                                                                                                                                                                                                                          |
| R11 | P5 与 P7 的 `stack.ts`/`index.ts` 改动块冲突                                                                                          | D15 排序。                                                                                                                                                                                                                                                                                                      |
| R12 | **替代建议可能推荐 droid 侧已禁用的 core 模型**（评审 #6；`disabled` 只在 `list_models` 里有，目录不带）                              | 后果有界：最坏是一次快速失败的 spawn（P4b 准入或 droid 的 update `-32602` 会拒，不会长时间挂着）。临时绕过：该模型 `droidPools` 设 `none`，或在 `externalAgents.droid.models` 里只列可用模型（偏好序在前）。根治方案是 F4。                                                                                     |
| R13 | web pill 在多个会话之间切换时，droid 组时有时无（`freshestQuota` 只选一个 wire；P7wa 之前的旧会话、或连到旧 hub 的会话不带 droid 行） | 现有新鲜度规则（非陈旧 → 最新 fetchedAt → at）会让持续刷新的会话胜出；droid 已启用的会话额度刷新更频繁。可接受，写入 P6 README。                                                                                                                                                                                |
| R14 | 与 #26 的 `messages.ts` / `agent/index.ts` / `src/index.ts` 发生文本冲突                                                              | §10 的合并顺序：P7w 与 #26 P0 后合方 rebase；P7wa 排在 #26 P-A 之后。                                                                                                                                                                                                                                           |
| R15 | 桌面 TopBar 宽度：GLM、Kimi、droid、droid core 四组                                                                                   | available 模式只显示未耗尽的组（现有规则）；移动端走紧凑数字；P7w 验收贴桌面和手机截图。                                                                                                                                                                                                                        |
| R16 | 陈旧 UI tab 连上新 hub 后收到 droid 行 / month 窗口（§9A.0）                                                                          | 旧 UI 降级：未知 id 显示裸 id、只渲染 5h/week、忽略 billing/problems；不崩不丢帧。刷新页面即得完整 UI。                                                                                                                                                                                                         |

---

## 13. Spike 清单

| #   | 要证实的事实                                                                                                  | 状态 / 做法                                              | 结果怎么用                                        |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| SP1 | `droid.list_models` 带不带 `billingPool`                                                                      | **已做，阴性**（附录）。顺带发现多一个 `disabled` 字段。 | F1 取消；`disabled` 走 D18 / F4。                 |
| SP2 | droidCore 偏好且 standard 已耗尽时，`droid exec -m <standard>` 是返回 `model_usage_exhausted`，还是静默换模型 | 需要一个已耗尽的账号，或等自然耗尽。                     | 若会静默换，记入 P3 风险，P5 conformance 加用例。 |
| SP3 | overage 为 `off` 时 core 模型是否仍可用                                                                       | 同上。                                                   | 不可用 ⇒ 给 D7 加条件 `overage === "droidCore"`。 |
| SP4 | 激活态窗口的 `usedPercent` 量纲与 `windowEnd` 格式                                                            | 用 `env.sh` 的 key 跑若干 droid run 后再 curl。          | 固化进 adapters-droid 测试样本。                  |

---

## 14. 给用户的一页摘要

1. droid 打开后（`externalAgents.droid.enabled`），quota 每 10 分钟查一次 Factory 账户额度，接近耗尽时改为每 2 分钟一次；两个计费池在同一轮刷新里只发一次请求。关闭 droid 时完全不查、零网络，kimi/zai 的 HUD、提示和 web 显示与现在逐字节一致。
2. 额度**按计费池**分开：standard（droid 的 Claude/GPT/Gemini/Grok）和 core（Factory 托管的 GLM/Kimi/DeepSeek 等），各有 5 小时、7 天、月三个窗口。HUD 显示为 `droid 12%/40%/mo 5% core 0%/0%/mo 0%`。**web 顶栏和弹出卡同期显示**：droid / droid core 两组，卡片里有月窗口、超额策略徽章和认证错误提示。只有升级后的 hub 才会收到这些数据，旧 hub 不受影响。
3. 派 `droid/<模型>` 时按该模型所属的池判定：standard 池用尽就当场拦下（不消耗 run）。替代建议先列同账户 core 池模型（例如 `droid/glm-5.3`），再列 pi 订阅模型，并注明「改用 pi 原生子 agent」。池的归属按模型厂商推断（droid 的两个模型接口都不给池字段，已实测），推错了在设置文件里用 `quota.droidPools` 纠正，纠正会同时影响判定和推荐；推不出时，两个池都满才拦。
4. Factory 账户若设成超额后用额外余额（extraUsage），pi-toolkit **默认仍然拦截**，不替你花真钱，余额处处可见；确需放行，把 `quota.droidAllowExtraUsage` 设为 true（TUI 设置里也能改）。
5. ⚠ 实测：当前 pi 进程环境里的 `FACTORY_API_KEY` 对额度接口返回 402，`~/.factory/env.sh` 里的新 key 返回 200，新 key 要等**重启 pi** 才生效。key 有问题时 HUD 和 web 会显示 `droid auth 402`，但不会因此拦截 spawn。
6. 自定义过 `quota.providers` 的话，需要手动加上 `droid`（默认值已包含）。
7. 分三个包：P7（quota 本体 + 设置）和 P7w（web 协议、hub、界面）现在就可以并行开工；P7wa（让 agent 在新 hub 上发送 droid 数据）等两者合入、并排在 #26 的 agent 改动之后再做。P5 只需多接一根线并预热一次目录读取。

---

## 附：Spike 结果（主会话 2026-10-14 实测）

- **SP1 阴性**：droid 0.241.1 用 stream-jsonrpc 调 `droid.list_models`（env.sh 的 key，probe cwd `/tmp/droid-spike`），返回的 `models[]` 键集合为 `defaultReasoningEffort, deprecated, disabled, displayName, id, isCustom, isNew, kind, modelId, modelProvider, noImageSupport, shortDisplayName, supportedReasoningEfforts, supportsPDFs, tokenMultiplier, usesUSBasedInference`，**没有 `billingPool`**（比 initialize 的 availableModels 多一个 `disabled`）。⇒ F1 不做；v1 按 D4 启发式 + `quota.droidPools` 覆盖。

## 用户拍板（2026-10-14）

- D5 池未知 ⇒ 两个池都触线才拦（推荐项）。
- D6 extraUsage ⇒ 默认仍拦，`quota.droidAllowExtraUsage=true` 才放行（推荐项）。
- D3 401/402/403 ⇒ 不拦 spawn，只告警 + HUD `droid auth <code>`（推荐项）。
- 其余 D 项按方案推荐执行。
- D9 month 阈值 50/95/98（同 week，推荐项）；month 关闭 forecast-before-reset（D10 推荐项）。
- 刷新频率沿用 10min / ≥L1 时 2min（推荐项）。
- D14 HUD：两池合并一段、始终显示（推荐项）。
- **D12 改判：web-hub 显示 droid 额度与 P7 一起做**（不再推迟到 F2）。F2/P7w 需要在 r2 里展开成完整规格：协议枚举扩展 + cap 协商 + 旧 hub 不丢帧 + UI 分池卡片，并与 #26（protocol/messages.ts 同为追加）、#23 P2b（UI）排好文件域与合并顺序。

---

## 修订记录 r2（2026-10-14）

| 来源                                               | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 改动位置                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 评审 #1（`src/index.ts` 成员路径）                 | **核实为误报，维持原写法，并在方案里写明原因**。`holder.current` 是 `Stack`，`Stack.quota` 的类型就是 `QuotaService`（`src/stack.ts:949` 声明，`:2702` 赋值 `quota: quota.service`）；同一 hook 块现有代码就是 `holder.current?.quota?.verdictFor(p)`（`src/index.ts:406`），web dep 是 `holder.current?.quota?.verdicts()`（`:1021`）。评审对照的 `QuotaStack`（`src/quota/index.ts:34-38`）是 `stack.ts` 内部的局部变量类型。按评审改成 `holder.current?.quota?.service.poolAlternatives(b)` 会编译失败（`QuotaService` 没有 `service` 成员）。两侧最终写法：`stack.ts` 用 `quota.service.X`，`src/index.ts` 用 `holder.current?.quota?.X`（含 P7wa 的 `problems()`）。**提请主会话确认**：本条与"#1 改为 quota.service.poolAlternatives"的指示相反，依据是上面的代码坐标。 | K9、§9、§9A.4                                                |
| 评审 #2（P4a 已合入）                              | 原 P7s 并入 P7；spec 规格写进 §2.7；K7、D16、§10、§11、§14 同步修改。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | K7、D16、§2.7、§8、§10、§11、§14                             |
| 评审 #3（`QuotaPoolPort`"零 IO"不实）              | 注释改为「同步、永不抛；首次调用可能做一次有界（≤256KiB）磁盘读」。`createCatalogPoolPort` 返回 `CatalogPoolPort`，带 `warm()`；P5 在 stack 构建时调用一次，把那次读挪出 spawn 准入热路径。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §2.1、§2.3、§4、§11                                          |
| 评审 #4 + 用户拍板（droid 被拦时的 pi 替代）       | 两类都列，core 池优先；pi provider 那一行用「改用 pi 原生子 agent」标题，并说明执行语义会变。`AlternativeSelection` 新增 `external?: true`；非 droid 路径字节不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | D8、§2.6、§6、§7、§11                                        |
| 评审 #5（`droidPools` 改判进 core 的模型不进替代） | `poolAlternatives` 改为"加法 + 减法"：并入 `droidPools` 中值为 core 的键，剔除被改判出 core 的；目录查不到的覆盖键保留。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | D7、§5 第 6 条、§11、R1                                      |
| 评审 #6 + SP1（`disabled` 字段）                   | v1 不做（D18）：P3 的目录来源没有 `disabled`，补上它要改冻结面和在制的 P3，与本期收益不成比例。残余风险记为 R12，附临时绕过；根治列为 F4（冻结面加 `disabled?: boolean`、P3 补调 `list_models`、`modelsInPool` 过滤），**推荐等 P3 合入后再评估，不放进本期**。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | K1、D18、§5 第 6 条、§10（F4）、R12                          |
| 评审 #7（R6 措辞）                                 | 改写为"每个 refresh pass 最多一次请求；两池 TTL 天然对齐，慢池搭快池的车"；并在 §3 写明"inflight 必须在首个 await 之前同步赋值"。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §3、R6、§14 第 1 条                                          |
| 评审 #8（`docs/dev/quota/*` 无人负责）             | 归 P7：最后一个提交在 `docs/dev/quota/{quota-plan,integration-map}.md` 各追加一节偏差记录。web 侧的 `docs/dev/quota-web/plan.md` §8 归 P7w。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | §10（文件域、提交顺序、验收）                                |
| 用户改判 D12（web 与 P7 同期）                     | 原 F2/P7w 展开为 §9A 完整规格，拆成两个包：**P7w**（协议 + hub + UI，不 import `src/quota`，可与 P7 并行，协议常量在 §9A.1 冻结）和 **P7wa**（agent 投影，依赖 P7 + P7w，排在 #26 P-A 之后）。新 cap `quota.pools.v1` 在 hub 两个面无条件通告，agent 按 `hello_ack.caps` 门控，旧 hub 字节不变、不丢帧（有旧 schema 副本测试）。UI 按池分组，`scopeLabel` 支持 month="mo"，exhausted 时钟按最长已耗尽窗口取，补 i18n 与移动端规则。billing 标记上 web 的范围见 D20。另列出与 #23 P2b、#26 的交集与合并顺序。                                                                                                                                                                                                                                                                  | §0.1、K6、D12、D19、D20、§9、§9A、§10、§11、R7、R13–R15、§14 |
| 用户拍板 D3/D5/D6/D9/D10/D14、刷新频率             | D 表里标注「拍板」，内容按推荐项写死；刷新频率写成 D21。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §1                                                           |
| SP1 结果                                           | K1 改写；F1 取消；§13 标记已完成。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | K1、§4、§10、§13                                             |
