# #26 第二步：缓存保活状态同步到 web-hub，实施方案 r2

> 状态：方案 r2（吸收 glm-5.3 评审 r1 全部 7 项，见文末「修订记录 r2」；D5 已由用户拍板）。基线：`77b1cda`（#28 线路熔断）、`8f25203`（#26 第一步）；**开工基线 = #29（保活尽力重试）合入之后**，见 §0.5。
> 车道：**L2**（跨 `cache-ttl`、`web-hub/agent`、`protocol`、UI，新增协议字段）。
> 落盘位置：`docs/dev/cache-ttl-keepalive/webhub-plan.md`。
> 核对依据：todo-web、bash-jobs-panel、quota-web 三份先例方案及其对应代码；`keepalive-state.ts`、`cache-keepalive.ts`、`cache-ttl.ts`、`web-hub/agent/{status,index,todo,quota-sampler}.ts`、`protocol/messages.ts`、UI `detail/*`。

## 0. 一页摘要（给用户）

**做什么**：在 `StatusInfo` 增加可选槽 `cacheKeepalive`。agent 每 1Hz 在主进程内存里读保活 `report()`，投影成小结构（常态约 0.7KB，最坏约 3.5KB，预算 8KiB）。指纹不变就不推送，不升 proto。

**UI**：会话详情头部（BashJobsPanel 之后）增加一行只读折叠面板。

- 折叠行文字与 TUI 状态行逐字一致，例如 `cache 1h* · ping off:http 403 ·retry 25m ·t3`。
- 展开后显示：模式、启停、最近一次 ping（结果、HTTP 码、瞬态/永久、重试次数）、窗口与会话累计、按线路的熔断列表、被削减行的提示。

**关键设计**：

1. **文字零漂移**：把 `renderPingSegment` 拆成 `pingSegmentParts()`（纯函数，TUI 与 web 共用）加 `compose`。TUI 输出逐字节不变，由现有测试加新增的 parity 测试钉住。
2. **倒计时不逐秒触发推送**：线路只发绝对时间 `retryAt`（agent 时钟的 epoch ms，值不随时间漂移）。UI 用本地时钟和 30s ticker 算 `·retry 25m` 与「N 分钟前」。指纹不含 `at`。`retryAt` 的**存在性**在冷却到期瞬间翻转一次、推送一帧（期望行为，UI 据此显示 `eligible now`）。
3. **数据源**：保活服务现有的 `report()`（常态纯内存读、零 IO；ctx 失效窗口下可能触发一次幂等 `dispose()`，与 `updateStatus` 既有暴露面相同，见 §3.3/§6）已覆盖绝大部分字段，只缺两项，各加一个极小的纯 getter / 可选字段：
   - `mode/dirty`：`CacheTtlWiring.status()`。
   - 最近一次 ping 的 HTTP 码：`KeepalivePingDiagnostics.httpStatus?`。
4. **关闭态**：`webHub.enabled=false` 时根本不调用 `wireWebHub`。`cacheTtl.keepalive=false` 时服务不存在，dep 不穿线。两种情况都字段缺席，并有字节等价测试。
5. **只读**：面板不放 reset 按钮（见 D5）。
6. **分包**：**#29 先合** → P0 协议冻结 → P-A（agent）与 P-B（UI）可并行。文件域与 #23、droid 线无硬冲突（§5）。i18n 用新命名空间文件，不碰共享热点 `detail.ts`。
7. **wire 不含 `armed`**：与 TUI 状态行口径一致，且避免忙轮次每个工具调用多推 1–2 帧（见 D11）。

**需要你拍板的主要决策点**：D1（不新增设置）、D3（`retryAt` 用浏览器本地时钟）、D4（只展示 token 数、不展示美元节省）、D5（不做 reset 按钮）。完整清单见 §9，均带推荐。

---

## 0.5 Sequencing 与 #29 协调（r2 新增，评审 #1）

**顺序**：#29（保活尽力重试，工作区已实现、即将合入）→ 本方案 P0 → (P-A ∥ P-B) → P-C。**本方案在 #29 合入之后才开工**；P-A 在 #29 之后的 `keepalive-state.ts` / `cache-keepalive.ts` 上重新取基线，不与 #29 并行改同一文件。

**#29 对本方案的影响（按工作区 `git diff` 核对，开工时以合入后的代码重新核对一遍）**：

| #29 改动                                                                                                                                                                                                                                                                                                                                                                   | 对本方案的影响                                                                                                                                                                                                                  | 处置                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `onUnproven`：network / 可重试 HTTP 在 ping 内重试到缓存过期后仍失败，**不再累加 transient 熔断计数、不再产生 `session.disabled{transient:true}`**；仅 `accepted-then-lost` / `malformed`（可能已计费）仍按原计数触发 `disabled{transient:true}`。`readBackKeepaliveSessionState` 读回时幂等解除旧的 `disabled{transient:true}`                                            | `ping off:<reason> ×N`（会话级 disabled 形态）里 transient 的来源变少，只剩上述两种 kind 与永久类（`proven-write` / `no-usage` / `no-cache-value`）；`CacheKeepaliveWire.disabled.transient` 字段保留（语义不变，出现频率变低） | 投影原样映射 `session.disabled`，不依赖具体集合；测试语料按 #29 后重派生                                                              |
| **窗口级 `ping paused:<kind>` 仍在**：`onUnproven` 对**所有** unproven kind 仍写 `window.capture=undefined; window.lastStopReason=kind`，`renderPingSegment` 的 paused 分支（`window.lastStopReason !== undefined`）未改。#29 取消的是**会话级**暂停（disabled），不是窗口级——重试耗尽后的 `network` / `http 5xx` 窗口仍显示 `ping paused:network`，直到下一个真实请求清除 | 「paused 只剩 accepted-then-lost/malformed」只对**会话级** disabled 成立；窗口级 paused 对全部 unproven kind 仍成立。⚠ **开工时必须复核 #29 终稿是否改了这条**（当前工作区 `git diff` 未改；若终稿改了，按终稿派生）            | `"paused"` 保留在状态集合内；UI 把 `state` 当**开放字符串**，未知值一律 neutral，因此即使 #29 终稿改变 paused 的触发面，UI 也不受影响 |
| `RETRYABLE_HTTP_STATUSES` 加 408；重试间隔 2→5→10→20→30s 后恒 30s，直到 `aliveUntil − margin`；`aliveUntil` 未知时 3 次上限；单 ping 无论重试几次只算 1 个 ping                                                                                                                                                                                                            | `isTransientUnproven` 本就含 408（不变）；只影响 `lastPingDiagnostics.attempts` 的取值范围（可到十几次）                                                                                                                        | 投影原样透传 `attempts`，clamp 到 `[1, 999]` 整数；展开详情显示 `attempts N`                                                          |
| 子会话租约 `lease.renew`                                                                                                                                                                                                                                                                                                                                                   | 仅子会话路径，web-hub 不涉及                                                                                                                                                                                                    | 无                                                                                                                                    |
| ping 重试进行中（可持续数分钟）期间 `lastPingDiagnostics` 不更新，状态栏也无「重试中」态                                                                                                                                                                                                                                                                                   | web 与 TUI 一致：重试结束才出现结果                                                                                                                                                                                             | 非目标（§8）：不新增「ping 重试中」展示                                                                                               |

**冻结面的 #29 口径**：

- `ping.state` 已知值**按 #29 合入后的 `renderPingSegment` 现状冻结**：`active | capped | paused | line-off | disabled`。
- **UI 侧与 wire schema 一律按开放字符串处理**：schema 里 `state` 是 `Type.String({ maxLength: 32 })`，不是 `Union<Literal>`；UI 未知值 neutral，不报错、不丢帧。`paused` 作为已知值保留，也作为「可容忍旧值」——未来任何一版把它删掉，UI 无需改动。
- 分支集合、折叠行示例、agent↔UI parity 语料、`transient` 判定表**全部从 #29 合入后的 `renderPingSegment` / `isTransientUnproven` 现状派生**，不再引用 #28 时代的快照。parity 语料文件（§3.6/§4.3）头部注明派生基线的 commit。
- 耦合方向：`transient` 的判定走导出的单一来源 `isTransientUnproven`。若 #29 后续再改 transient 分类，web 自动跟随，无需改投影。

---

## 1. 现状核对（代码事实）

| 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 坐标                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保活服务暴露 `report(): KeepaliveReport`，常态纯内存读、零 IO。**唯一例外**：`report()` → `safeModel()` 在 `ctx.model` 读取抛错（ctx 失效）时 catch 内调用 `this.dispose()`，`dispose()` 含 `accountNoCacheValueSession()`（写 provider-evidence 磁盘 store，`noCacheValueCounted` latch 幂等）与 `audit()`（`appendEntry` 写会话文件）——即 stale-ctx 窗口下 1Hz 读者可触发真实磁盘写，与 `updateStatus` 既有暴露面相同。含 `session`（`lineStates`、`disabled`、`pings`、`cacheReadTokens`、`avoidedMissTokens`、`loadBearing*`、`unnecessary*`、`discarded*`、`lastUnproven`）、`window`、`config`、`costUsd`、`armed`、`enabled`、`lastPingDiagnostics`、`currentLineKey`、`now` | `src/cache-ttl/keepalive-state.ts:1442`；`src/service/cache-keepalive.ts:1184`、`:366-372`（`safeModel`）、`:1290` 起（`dispose`）。**行号为 `77b1cda` 基线，#29 合入后一律以符号名为准** |
| 状态栏文字单一来源：`renderCacheStatus` → `buildCacheStatusSnapshot`（mode 段 `cache 1h*`，ping 段 `renderPingSegment`，非导出）。线路形态：`ping off:http 403 ·retry 25m ·t3`；永久 disabled 形态：`ping off:http 403 ×N`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `keepalive-state.ts:1557`、`:1590`                                                                                                                                                        |
| `mode/dirty` 的权威来源是 `wireCacheTtl` 闭包变量，服务里的 `modeState` 只靠 `syncModeState` 懒同步（`before_provider_request`、模式变更时），`report()` 里没有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `cache-ttl.ts:588` 起；`cache-keepalive.ts:305`、`:1231`                                                                                                                                  |
| `CacheTtlWiring` 目前只返回 `{ warmth }`，`src/index.ts:306` 已持有该返回值 `cacheTtl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `cache-ttl.ts:64`、`:801`                                                                                                                                                                 |
| **最近一次 ping 的 HTTP 码当前不进 `lastPingDiagnostics`**。HTTP 码只落在 `lineStates[k].status` 或 `disabled.httpStatus`，而且只在达到熔断阈值之后才有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `cache-keepalive.ts:1034`（unproven 分支）；`keepalive-state.ts:1488`                                                                                                                     |
| `isTransientUnproven(kind, status)` 是已有纯函数（408/429/5xx、network、malformed、accepted-then-lost 为瞬态），**未导出**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `keepalive-state.ts:1090`                                                                                                                                                                 |
| `lastPingDiagnostics` 不持久化。`/reload` 后只有 `session.lastUnproven {kind, at}`（随快照持久化）可回填                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `cache-keepalive.ts:303`                                                                                                                                                                  |
| `systemClock.now()` = `Date.now()`，绝对 epoch，所以 `resetEligibleAt` 可以直接上线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `core/clock.ts:104`                                                                                                                                                                       |
| web-hub 的 `StatusInfo` 槽模式：`readStatus(ctx, tap, fleet, queueMirror?, todo?, worktrees?, bashJobs?, quota?, held?, load?)` 末尾追加一个 `() => T \| undefined` 参数；`index.ts` 有两个调用点（`publishStatus` 约 `:581`、snapshot 约 `:895`）；1Hz `onTick` 里 `lastXxxFp` 指纹门控；`session_start` 重置（约 `:1108`）；`src/index.ts` 约 `:993` 起用 `...(cond ? {dep} : {})` 穿线                                                                                                                                                                                                                                                                                           | `agent/status.ts`、`agent/index.ts`                                                                                                                                                       |
| `StatusFrameSchema` 无 `additionalProperties:false`，`todo/worktrees/bashJobs/quota` 的子 schema 一律 open（`additionalProperties:true`），因为 `decodeWith` 失败会丢整帧。hub 对 status 透明（`toCard` 整体带 status），先例都没改 hub                                                                                                                                                                                                                                                                                                                                                                                                                                             | `protocol/messages.ts` 约 `:1036–1175`                                                                                                                                                    |
| UI 先例：`statusOf(agent)` 窄化 → `bashJobsOf`/`worktreesOf` 视图函数 → 面板组件挂 `DetailHeader.vue` 的 `.detail-head-info`。不镜像进 `state.js`/`types.ts`（状态 reducer 整体替换 `agent.status`）。样式独立 css（source-scan 禁 `<style>`）。i18n 按命名空间文件 glob 自动合并（`quota.ts`、`load.ts` 都是独立文件）                                                                                                                                                                                                                                                                                                                                                             | `components/detail/{BashJobsPanel.vue,bashJobsView.ts}`、`i18n/index.ts`                                                                                                                  |
| `/cache-ttl keepalive reset` 在 web 命令通道已被 `command-policy.ts:139` 标为 confirm 门控                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `agent/command-policy.ts`                                                                                                                                                                 |
| **在途工作（r2 刷新，`git log`/`git status`）**：#23 chunked preview **P0–P2a 已提交**（`40bb5ab`、`0599845` 等），**P2b 在验收**（工作区脏文件：`components/preview/{PreviewHost,PreviewText}.vue`、`composables/usePreview.ts`、`logic/previewStream.js`、`i18n/{en,zh}/preview.ts`、`styles/preview.css` 与对应 tests）；#22 droid（external-agent）**P1–P4 已提交**，**P5 / P7(P7w) 待做**；#29（保活重试）在工作区实现、即将合入（`src/service/cache-keepalive.ts`、`src/cache-ttl/{keepalive-state,ping-ledger}.ts`）。本方案文件域与 #23 零交集；与 droid P5/P7 的同文件不同段并行规则见 §5                                                                                  | `git status` / `git log`                                                                                                                                                                  |

---

## 2. 线协议（`src/web-hub/protocol/messages.ts`，P0 冻结，append-only）

```ts
/** cache-keepalive-web plan §2: one line-breaker row. Open schema (additionalProperties:true). */
export interface CacheKeepaliveLineWire {
  label: string; // provider/model@host，≤128 B（来自 LineState.label，agent 侧再 truncateText）
  open: boolean; // true = 熔断中；false = 仅有历史记录（consecutive>0 或 trips>0）
  status?: number; // 100–599
  trips: number;
  retryAt?: number; // epoch ms（agent 时钟）；仅 open 且 resetEligibleAt > at 时存在。通配线路无冷却，永不带
  current?: true; // = report.currentLineKey
  wildcard?: true; // 键 "*"（旧会话级迁移 / 线路不可解析）
}
export interface CacheKeepaliveLastPingWire {
  at: number;
  kind: string; // "proven-hit" | UnprovenKind | 未来值，开放字符串，≤32 B（attempts 整数，agent 侧 clamp [1,999]）
  status?: number; // 仅 kind==="http"
  transient?: boolean; // 仅 kind!=="proven-hit"；= isTransientUnproven(kind,status)
  attempts?: number;
}
export interface CacheKeepaliveWire {
  v: 1;
  at: number; // agent 时钟，不进指纹
  mode: string; // "auto"|"on"|"off"，开放字符串，UI 回落原文
  dirty?: true;
  enabled: boolean; // report.enabled（含 /cache-ttl keepalive off 的运行时覆盖）
  // 注（r2，评审 #2）：故意不含 `armed`——见 D11。
  modeText?: string; // buildCacheStatusSnapshot 的 mode 段原文，auto 时缺省
  ping?: { text: string; state: string; retryAt?: number; tail?: string };
  window: { pings: number; max: number };
  session: {
    pings: number;
    cacheReadTokens: number;
    costUsd?: number;
    avoidedMissTokens: number;
    loadBearingWindows: number;
    unnecessaryWindows: number;
    discardedWindows: number;
  };
  lastPing?: CacheKeepaliveLastPingWire;
  disabled?: { reason: string; at: number; httpStatus?: number; transient?: true };
  lines: CacheKeepaliveLineWire[];
  omitted?: number; // 被预算阶梯削掉的行数
}
export interface StatusInfo {
  // …既有字段…
  /** cache-keepalive-web plan §2: optional prompt-cache keepalive summary (main session). Absent = web-hub off /
   *  cacheTtl.keepalive off / nothing to report (byte-equal to the pre-feature shape). Decode side stays open. */
  cacheKeepalive?: CacheKeepaliveWire;
}
```

**Schema**：`CacheKeepaliveWireSchema` 导出，全部 open（`additionalProperties:true`），边界放宽。

- `lines` maxItems 32、各字符串 maxLength 256、`v: Literal(1)`；`ping.state`、`mode`、`lastPing.kind` 一律 `Type.String`（开放，**不是** `Union<Literal>`）。
- 投影严格在更窄的界内。测试强制：投影产出必须通过 schema。
- 在 `StatusInfoSchema` 追加 `cacheKeepalive: Type.Optional(CacheKeepaliveWireSchema)`。
- 不加 cap、不升 proto、不动 hub。`StatusFrameSchema` 通过 `...StatusInfoSchema.properties` 自动继承，旧 hub 透传。

**`ping` 字段语义**（与 TUI 文字同源）：

- `text` 是 TUI ping 段去掉 `·retry`/`·tN` 后缀的头部，如 `ping off:http 403`、`ping 3/11 Σ12 · 450k · ≈$0.12`、`ping paused:network`、`ping off:http 403 ×7`。
- `state` 已知值 `{"active","capped","paused","line-off","disabled"}`（**按 #29 合入后现状冻结**，见 §0.5），UI 据此上色（`line-off`/`disabled` 为 bad，`paused`/`capped` 为 warn，其余及**任何未知值**为 neutral）。`paused` 仍对应窗口级 `ping paused:<kind>`。
- 仅 `line-off` 状态带 `retryAt`（`rec.resetEligibleAt`，且 > `at` 才带）和 `tail`（`·t3`，trips≥2 才有）。
- UI 拼接：`[text, retryAt>now ? "·retry "+fmt(retryAt-now) : "", tail].filter(Boolean).join(" ")`。
- 与现有 TUI 文字比对，三者顺序一致：`ping off:http 403 ·retry 25m ·t3`。

---

## 3. agent 侧（P-A）

### 3.1 pi-free 层改动（`src/cache-ttl/`）

**(a) `keepalive-state.ts`：拆分 `renderPingSegment`（零行为变化）**

```ts
export type PingSegmentState = "active" | "capped" | "paused" | "line-off" | "disabled";
export interface PingSegmentParts {
  text: string; // 头部（line-off 时不含 ·retry/·tN）
  state: PingSegmentState;
  retryAt?: Millis; // 仅 line-off
  tail?: string; // 仅 line-off 且 trips>=2：`·t${trips}`
}
export function pingSegmentParts(report: KeepaliveReport | undefined): PingSegmentParts | undefined;
function renderPingSegment(report) {
  // 仍非导出
  const p = pingSegmentParts(report);
  if (p === undefined) return undefined;
  let s = p.text;
  if (p.retryAt !== undefined && report!.now !== undefined && p.retryAt > report!.now)
    s += ` ·retry ${formatMsShort(p.retryAt - report!.now)}`;
  if (p.tail !== undefined) s += ` ${p.tail}`;
  return s;
}
```

分支逻辑原样搬迁。**分支集合以 #29 合入后的 `renderPingSegment` 为准**（开工时重读；当前工作区核对结果：`disabled`（会话级，#29 后 transient 来源只剩 `accepted-then-lost`/`malformed`）/ line-open / capped / paused（窗口级，对所有 unproven kind 仍有效）/ active / `undefined`），不得凭本文旧列表搬迁。

**(b)** 导出 `isTransientUnproven`（把 `function` 加 `export`）。`formatMsShort` 已导出。

**(c)** `KeepalivePingDiagnostics` 增加可选 `httpStatus?: number | undefined`。

**(d)** `src/service/cache-keepalive.ts` 约 `:1034` 的 unproven 分支，在 `lastPingDiagnostics = {…}` 里追加 `...(outcome.kind === "http" ? { httpStatus: sanitizeHttpStatus(outcome.status) } : {})`。

- 需要把 `sanitizeHttpStatus` 导出，或在服务里复用 `outcome.status` 做同样的 100–599 钳位。推荐导出。
- 该字段不持久化、不进审计、不改 `renderKeepaliveReportLines`，`/cache-ttl status` 输出不变。

**(e)** `src/cache-ttl/cache-ttl.ts`：`CacheTtlWiring` 增加

```ts
status(): { mode: CacheDisplayMode; dirty: boolean };   // 只读闭包 getter
```

`return { warmth, status: () => ({ mode, dirty }) }`。该接口的生产构造点只有一处，加成必需成员即可，typecheck 会暴露所有假实现。

**不动服务的 `KeepalivePort`/`CacheKeepaliveService` 接口**，避免假实现破坏。也不给 `KeepaliveReport` 加字段，避免 `toEqual` 型测试受影响。`mode/dirty` 走 `cacheTtl.status()`，在 `src/index.ts` 里和 `report()` 拼成输入。

### 3.2 投影模块（新）`src/web-hub/agent/cache-keepalive.ts`

纯函数、零 pi import，只 import：

- `../../cache-ttl/keepalive-state.js` 的值与类型：`pingSegmentParts`、`isTransientUnproven`、`LINE_KEY_WILDCARD`、`buildCacheStatusSnapshot`；
- `../protocol/keys.js` 的 `truncateText`；
- `../protocol/messages.js` 的类型。

agent/ 可 import 域外纯模块（`todo.ts` 先例）。

```ts
export interface CacheKeepaliveInput {
  report: KeepaliveReport;
  mode: CacheDisplayMode;
  dirty: boolean;
}

export const CACHE_KEEPALIVE_WIRE_BUDGET_BYTES = 8 << 10;
export const CACHE_KEEPALIVE_LABEL_MAX_BYTES = 128;
export const CACHE_KEEPALIVE_MAX_ROWS = 16; // = MAX_LINE_STATES；常量引用 keepalive-state，不另起魔数

/** undefined ⇒ 字段整个缺席（字节等价于现状）。 */
export function projectCacheKeepalive(
  input: CacheKeepaliveInput | undefined,
  now: number,
): CacheKeepaliveWire | undefined;
/** 1Hz 门控：undefined ⇒ ""；否则 JSON.stringify({...wire, at: 0})。 */
export function cacheKeepaliveFingerprint(wire: CacheKeepaliveWire | undefined): string;
export function cacheKeepaliveWireBytes(wire: CacheKeepaliveWire): number;
```

**静默规则（返回 undefined）**：全部成立时返回 `undefined`，保证新装用户、没用过保活的会话与现状字节相同：

- `report.enabled === true`；
- `buildCacheStatusSnapshot` 的 `segments` 为空（即 `mode===auto` 且无 ping 段）；
- `lineStates` 为空、`disabled`/`lastUnproven`/`lastPingDiagnostics` 全为空；
- `session.pings === 0`。

`enabled===false`（运行时 `/cache-ttl keepalive off`）则**不静默**，字段带 `enabled:false`，面板可见「保活已关闭」。

**字段映射**：

- `mode/dirty/modeText`：来自 `input` 与 snapshot 的 `kind==="mode"` 段原文。
- `ping`：`pingSegmentParts(report)`，丢弃 `undefined` 的情况。
- `window`：`{ pings: report.window.pings, max: report.config.maxPings }`。
- `session.costUsd`：`report.costUsd`，`undefined` 时省略。
- `lastPing`：
  - 优先取 `report.lastPingDiagnostics`：`{at, kind: outcomeKind, status?: httpStatus, attempts?: clamp(attempts,1,999)}`。
  - `transient` 仅在 `kind !== "proven-hit"` 时设：`isTransientUnproven(kind, status)`。
  - 缺省回落 `session.lastUnproven`：`{at, kind}`，同样算 `transient`，覆盖 `/reload` 后。
- `disabled`：`session.disabled`，字段 `reason` 截断 64 B。
- `lines`：
  - 遍历 `Object.entries(session.lineStates)`，只收 `open || trips>0 || consecutive>0` 的行。
  - `label` 经 `truncateText(…, 128)`。
  - `retryAt` 条件：`open && key !== "*" && resetEligibleAt > report.now`。
  - `current` 条件：`key === report.currentLineKey`。
  - `wildcard` 条件：`key === "*"`。
  - 排序：`open` 优先，其次 `current` 优先，再按 `updatedAt` 降序。
  - 封顶 `MAX_ROWS`。

**预算阶梯**（防御性，正常达不到）：

1. 超过 8KiB 时，先把 `label` 缩到 48 B。
2. 仍超则从尾部丢**非 open** 行。
3. 仍超则从尾部丢 open 行。
4. 丢弃的行数写入 `omitted`。

估算：静态部分约 0.6KB；16 行 × 约 170 B ≈ 2.7KB；合计最坏约 3.5KB，预算 8KiB 有约 2 倍余量。

**不暴露的内容**：线路键 hash（`key`）、`baseUrl` path、header 键名/值、payload、`lastPingDiagnostics.model/baseUrl/headerKeyDiff`。`label` 已由 #28 限定为 `provider/model@host`（无 path/query），与 web 上本来就显示的模型信息同级。

### 3.3 接线

**`src/web-hub/agent/status.ts`**：`readStatus` 追加第 11 参 `cacheKeepalive?: () => CacheKeepaliveWire | undefined`。

- 在 `load` 块之后：`if (cacheKeepalive !== undefined) { const w = cacheKeepalive(); if (w !== undefined) status.cacheKeepalive = w; }`。
- 与 todo/quota 同注释口径：overwrite-only slot，无 getter 时字段缺席。

**`src/web-hub/agent/index.ts`**：

1. `WebHubDeps.cacheKeepalive?: () => CacheKeepaliveInput | undefined`（文档同 `quota`：late-bound、未设 ⇒ 槽缺席）。
2. 闭包 `let lastKaFp: string | undefined;`（与 `lastQuotaFp` 同生命周期，约 `:359` 旁）。
3. `const cacheKeepaliveProjection = (): CacheKeepaliveWire | undefined => { const d = deps.cacheKeepalive; if (d === undefined) return undefined; return projectCacheKeepalive(d(), now()); };`，参照 `quotaProjection`（约 `:441`）。
4. `publishStatus`（约 `:581`）与 snapshot（约 `:895`）两处 `readStatus` 的第 11 参传 `deps.cacheKeepalive !== undefined ? cacheKeepaliveProjection : undefined`。
5. `onTick`：在 quota 门控块旁加：
   ```ts
   if (deps.cacheKeepalive !== undefined) {
     const fp = cacheKeepaliveFingerprint(cacheKeepaliveProjection());
     if (fp !== lastKaFp) {
       lastKaFp = fp;
       publishStatus();
     }
   }
   ```
6. `session_start` 处理器（约 `:1113` 的 `lastQuotaFp = undefined` 旁）重置 `lastKaFp = undefined`。

**`src/index.ts`**（`wireWebHub({...})` 内、`quota` dep 附近，约 `:1021`）：

```ts
...(settings.cacheTtl.keepalive
  ? { cacheKeepalive: () => {
        try {
          const ka = holder.current?.keepalive;               // 每次现取，随栈重建自然换代
          return ka === undefined ? undefined : { report: ka.report(), ...cacheTtl.status() };
        } catch { return undefined; }
      } }
  : {}),
```

**数据流**：`holder.current?.keepalive.report()` + `cacheTtl.status()` → `projectCacheKeepalive` → 1Hz 指纹 → `publishStatus` → `readStatus`（同一函数同帧原子采样，不会出现「新 leaf + 旧保活」）。

**热路径常态零 IO**：`report()` 常态只读内存与 `ctx.model` getter。1Hz 一次，序列化约 1KB。不开新 timer，常态不碰盘/网。

**例外（如实表述，r2 评审 #3）**：`report()` → `safeModel()` 在 ctx 失效（会话替换窗口）时 catch 内调用 `this.dispose()`，其中 `accountNoCacheValueSession()` 写 provider-evidence store（磁盘）、`audit()` 经 `appendEntry` 写会话文件。该行为是服务既有的、幂等的（`noCacheValueCounted` latch 防双计；dispose 本身幂等），`updateStatus` 同样经 `report()` 触发，**web 侧不是新暴露面，只是多一个 1Hz 读者**。收敛论证：stack 重建本来就会 dispose 同一服务；web 的 `holder.current?.keepalive` 在重建后立即指向新服务；外层 try/catch 兜底。不为此新增「只读不触发 dispose」的变体 getter（改动面大于收益）。

### 3.4 指纹门控：什么变化才推

指纹 = 投影去掉 `at`（`JSON.stringify({...wire, at: 0})`）。会改变指纹的事件：

- 每次 ping 落地（约 4 分钟一次；#29 后重试期间无中间态，落地即终局）：`ping.text`、`window.pings`、`session.*`、`lastPing`。
- 线路熔断开合 / 复位 / `trips` 变化 / `retryAt` 被 re-trip 重新计算。
- `mode`/`dirty` 切换、`enabled` 切换。
- 栈重建后换新服务实例。
- **`retryAt` 的存在性翻转**：wire 里 `retryAt` 仅在 `resetEligibleAt > at` 时存在，冷却到期的那一个 tick 它从 wire 消失 ⇒ 指纹变 ⇒ 推一帧。这是**期望行为**（UI 据此从 `·retry 25m` 切到 `eligible now`），每次熔断到期恰好一帧。

**不会改变指纹的**：

- `at`、`now`（不进 wire / 被抹零）。
- `retryAt` 的**值**（绝对时间戳，不随时间漂移）；到期前 now 前进，指纹不变。
- UI 本地倒计时与「N 分钟前」（UI 自己算）。
- **`armed`**：不在 wire 里（D11）。`armed()` = `backgroundBusy() ∥ activeTools>0 ∥ uiPrompts>0`，忙轮次每个 tool_start/tool_end 都会翻转，而 `STATUS_EVENTS` 不含 tool 事件，把它放进指纹会给每个工具调用多推 1–2 帧——这不是本方案打算引入的帧率噪音。TUI 状态行也不显示 armed（只在 `/cache-ttl status` 里出现），web 与之同口径。

### 3.5 关闭态与兼容

| 场景                       | 行为                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `webHub.enabled=false`     | `wireWebHub` 不调用，零接线、零开销（`tests/integration/web-hub-disabled` 既有断言继续成立）          |
| `cacheTtl.keepalive=false` | 服务不存在，`cacheKeepalive` dep 不穿线，`readStatus` 参数 `undefined`，`onTick` 不执行门控，字段缺席 |
| 静默（见 §3.2）            | 投影返回 `undefined`，字段缺席                                                                        |
| 子会话                     | web-hub 本身 post-guard（子会话不接线），不涉及                                                       |
| print/json 会话            | web-hub 不 attach，不涉及                                                                             |
| 旧 hub + 新 agent          | `StatusFrameSchema` 无 `additionalProperties:false`，字段透传，hub 无需改                             |
| 新 hub + 旧 agent          | 字段缺席，hub 无变化                                                                                  |
| 旧 UI + 新 agent           | 未知字段被忽略；UI 字节不变                                                                           |

### 3.6 P-A 测试计划

| 文件                                                                          | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/cache-ttl/keepalive-state.test.ts` / `keepalive-breaker.test.ts`（扩） | 既有文字用例全部原样通过（拆分零行为变化）；新增 `pingSegmentParts` 各分支表驱动：`disabled`/line-off/capped/paused/active/undefined；`compose(parts, now) === renderPingSegment(report)` 对全语料逐一断言（text parity）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tests/service/…`（扩）                                                       | unproven http 分支 `lastPingDiagnostics.httpStatus` 有值；非 http 无该键；`/cache-ttl status` 输出行不变。**既有对 `lastPingDiagnostics` 做 `toEqual` 整形断言的用例同步更新**（http 分支带 `httpStatus`、非 http 无该键），属正常维护成本，随 P-A 同包提交                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/cache-ttl/…`（扩）                                                     | `wireCacheTtl().status()` 随 `/cache-ttl on/off/auto/save` 的 `mode/dirty` 同步变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 新 `tests/web-hub/agent/cache-keepalive-projection.test.ts`                   | 静默规则；mode on/off/dirty；`enabled:false` 不静默；`ping.text` 与 TUI 对拍（**语料按 #29 后现状派生**，文件头注明基线 commit；含窗口级 `paused:<kind>`、会话级 `×N`、line-off 三后缀、capped、active）；`retryAt` 条件（open 才带、通配不带、已过期不带）；`attempts` clamp 到 [1,999]；`transient` 判定表；`/reload` 回落到 `lastUnproven`；行排序与 `current/wildcard` 标记；**预算**：16 行全 4 字节 emoji label + 长 reason 下 `cacheKeepaliveWireBytes ≤ 8KiB`，阶梯逐级断言，`omitted` 正确；投影通过 `CacheKeepaliveWireSchema`；**指纹**：now 前进但**仍在 `resetEligibleAt` 之前** ⇒ 指纹不变；now **跨过** `resetEligibleAt` ⇒ `retryAt` 消失、指纹恰好变一次（对应恰好一帧）；ping 落地/熔断/mode 变化改指纹；**wire 不含 `armed` 键，`activeTools`/`uiPrompts`/`backgroundBusy` 翻转不改指纹** |
| 新 `tests/web-hub/protocol/cache-keepalive-schema.test.ts`                    | 合法 / 未知字段通过 / 旧帧（无该字段）通过 / `lines` 超 32 拒 / `v` 错拒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/web-hub/agent/status.test.ts`（扩）                                    | 传 getter ⇒ `status.cacheKeepalive` 出现；不传 ⇒ 对象 `deepEqual` 旧形（字节等价）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/web-hub/agent/wiring.test.ts`（扩，仿 bashJobs 段 `:573` 起）          | 传 dep ⇒ 状态帧含字段；ping 落地 ≤1s 内一帧；无变化 N 个 tick 内不重复推（含 `armed` 翻转场景：模拟 tool_start/tool_end ⇒ 帧数不变）；熔断冷却到期 ⇒ 恰好一帧；不传 ⇒ 字节等价；栈重建（holder 换服务）⇒ 下一帧换内容；`getter` 抛错 ⇒ 字段缺席且不崩；`snapshot_req` 返回含字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/web-hub/hub/…`（有则扩，无则用 registry 单测）                         | 含 `cacheKeepalive` 的 status 帧经 hub registry 存取 / SSE 透传不丢字段（确认 hub 白名单透明）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 4. UI 侧（P-B）

### 4.1 文件（全新，除 `DetailHeader.vue` 外无共享热点）

| 文件                                                                        | 作用                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/ui/src/components/detail/cacheKeepaliveView.ts`                | `cacheKeepaliveOf(agent)`（`statusOf` 窄化，要求 `v===1` 且 `lines` 是数组，否则 `undefined`）；`markerText(wire, nowMs)`；`markerTone(wire)`（据 `ping.state`）；`formatMsShort(ms)`（与 agent 侧同口径，`<1m`/`25m`/`3h`，由 parity 向量测试钉住）；`lineRows(wire, nowMs)`；`hasPendingRetry(wire, nowMs)`；`lastPingView(wire)` |
| `src/web-hub/ui/src/components/detail/CacheKeepalivePanel.vue`              | 折叠行 + 展开详情，props `{ readonly keepalive: CacheKeepaliveWire }`（本地 props 接口，不碰 `contracts.ts`）                                                                                                                                                                                                                       |
| `src/web-hub/ui/src/styles/cache-keepalive.css`                             | 独立样式，token-only，仿 `bash-jobs.css`                                                                                                                                                                                                                                                                                            |
| `src/web-hub/ui/src/i18n/en/cacheKeepalive.ts`、`i18n/zh/cacheKeepalive.ts` | 新命名空间 `cacheKeepalive`，glob 自动合并，**不碰 `i18n/*/detail.ts`**。zh 用 `satisfies Messages<typeof en>`，`i18n-parity.test.ts` 自动覆盖                                                                                                                                                                                      |
| `src/web-hub/ui/src/components/detail/DetailHeader.vue`                     | **唯一共享改动**：`import` + `const cacheKeepalive = computed(() => cacheKeepaliveOf(props.agent))` + 在 `<BashJobsPanel>` 之后加 `<CacheKeepalivePanel v-if="cacheKeepalive" :keepalive="cacheKeepalive" />`                                                                                                                       |

**不改**：`logic/state.js`、`types.ts`、`transport/types.ts`、`contracts.ts`、`styles/detail.css`、任何 `preview*`/`markdown.js`/`password-client.js`/`token-client.js`（均有在途改动或为冻结面）。

### 4.2 展示

**折叠行**（`.ck-sum`，单行省略，`min-width:0`）：

- 图标 `radio`（已有图标）+ 文字 `[modeText, pingText].filter(Boolean).join(" · ")`。
- 形态示例：
  - `cache 1h* · ping off:http 403 ·retry 25m ·t3`
  - `cache 5m · ping 3/11 Σ12 · 450k · ≈$0.12`
- `ping` 缺省时只显示 mode；`enabled:false` 时追加 token `keepalive off`。
- 英文 token 在两种语言下保持一致，符合 AGENTS.md 的 UI 文字规则。
- 颜色由 `ping.state` 映射（bad / warn / neutral）。

**展开详情**（`<dl class="ck-kv">`，散文标签走 i18n，值保持 token）：

1. 模式：`auto`/`on`/`off`，`dirty` 时加 `*`，附一句中文说明。
2. 保活：已启用 / 已关闭（`enabled`）。**不显示 `armed`**（D11）；窗口活动情况由第 4 项「窗口 N/M」与折叠行 ping 段表达。
3. 最近一次 ping：结果 token（`proven-hit` / `http` / `network` …）、HTTP 码、`transient`/`permanent` 标记、`attempts`、相对时间。**时基统一用浏览器时钟**（r2，评审 #5）：`age = Date.now() - lastPing.at`，分钟粒度，与 retry 倒计时同一时基（时钟偏差口径同 D3；不再用冻结的 `wire.at - lastPing.at`，否则「5m ago」会停滞到下一次指纹变化，可能数十分钟）。无记录时显示占位文案。
4. 窗口：`3/11`。
5. 本会话累计：ping 次数、cache read（`450k`，格式沿用 UI `formatTokens` 或本地 `k/m` 小函数）、`≈$0.12`（缓存读费用，与 TUI 同口径）、`avoided rewrite N tok`（见 D4）、load-bearing / unnecessary / discarded 窗口数。
6. `disabled`：非空时显示原因 + 码 + 瞬态/永久。
7. **线路熔断列表**（`<ul class="ck-lines">`）：每行 `label`（mono、省略、`title` 全文）、`http 403`、`trips N`、`retry in 25m`（open 且 `retryAt>now`）或 `eligible now`（open 且已过期）、`current` / `*`(legacy) 角标；非 open 行淡显为 `history`。尾部 `(+N more)` 对应 `omitted`。

**本地时钟显示（retry 倒计时 + lastPing 年龄）**：UI 用 `retryAt - Date.now()` 与 `Date.now() - lastPing.at` 在本地算，复用 `useTicker`，`intervalMs: 30_000`。**ticker 仅在以下任一成立时建立**：① 存在 `retryAt > now` 的 `ping`/线路行（折叠行含 `·retry`，面板折叠时也要走）；② 面板展开且存在 `lastPing`（年龄显示）。两者都不成立时不建；卸载时 dispose。`hidden` 页面不走（`useTicker` 自带）。粒度为分钟，与 TUI `formatMsShort` 同。

**移动端**：折叠行 `text-overflow: ellipsis`；展开后 `.ck-kv` 改为两列 grid，≤480px 退化为单列；每个线路行 `flex-wrap`，label 独占首行，状态 chip 换行。触屏 `pointer: coarse` 下 summary 行最小高度与 `.bj-sum` 同族。验收视口 360px。

**无该字段**：`cacheKeepaliveOf` 返回 `undefined`，`v-if` 不渲染，`DetailHeader` 输出不变（P-B 测试逐字节断言）。

**i18n 约定**：散文（标签、说明、aria、占位）走中文/英文双语；紧凑标记（折叠行、`http 403`、`trips N`、`·retry 25m`、`keepalive off`）一律英文 token，两种语言相同。键清单（草案）：
`title`、`toggleAria`、`summaryAria`、`rowMode`、`rowEnabled`、`enabledOn`、`enabledOff`、`rowLastPing`、`lastPingNone`、`lastPingAgo`（`{age} ago`，age 本地算）、`transientTag`、`permanentTag`、`rowWindow`、`rowSession`、`rowCacheRead`、`rowCost`、`rowAvoided`、`rowDiscarded`、`rowDisabled`、`linesTitle`、`linesNone`、`lineCurrent`、`lineLegacy`、`lineHistory`、`lineRetryIn`、`lineEligibleNow`、`linesMore`、`footerSampled`。

### 4.3 P-B 测试计划

| 文件                                                | 内容                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 `tests/web-hub/ui/cache-keepalive-view.test.ts`  | `cacheKeepaliveOf` 窄化（缺 `v` / 非数组 / 非对象 ⇒ undefined）；`markerText` 拼接顺序对拍 TUI 语料（`·retry`、`·t3`、`×N`、无 retry）；`formatMsShort` 向量与 agent 侧一致（同一份向量 JSON 在两侧测试里各引一次，**语料按 #29 后现状派生、文件头注明基线 commit**）；`state` 未知值（含将来删除 `paused` 后的旧值、任意字符串）一律 neutral 且不抛；未知 `mode`/`kind` 回落；`retryAt` 已过期不渲染 `·retry` |
| 新 `tests/web-hub/ui/cache-keepalive-panel.test.ts` | 折叠/展开；所有字段渲染；`transient`/`permanent` 标记；`omitted`；`current`/`wildcard`/`history` 行；ticker 仅在「存在未来 `retryAt`」或「展开且有 `lastPing`」时创建、两者都无不建、卸载清理（照 `bash-jobs-panel.test.ts` 的 ticker 断言）；lastPing 年龄随假时钟前进而变化（不随 `wire.at` 冻结）；`<script>` 之类字符串作为文本渲染；无任何 `v-html` / 持久化存储                                          |
| `tests/web-hub/ui/detail-header.test.ts`（扩）      | 有字段 ⇒ 挂载在 BashJobsPanel 之后；无字段 ⇒ 输出与旧快照一致                                                                                                                                                                                                                                                                                                                                                  |
| `tests/web-hub/ui/i18n-parity.test.ts`              | 自动覆盖新命名空间，无需改动                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/web-hub/ui/source-scan.test.ts`              | 自动覆盖：不得出现 `<style>`、静态 `style=`、`v-html`、`localStorage`                                                                                                                                                                                                                                                                                                                                          |
| `npm run build:web` + `npm run check:web`           | 看 gzip 体积预算（组件小，预期增量 <2KiB）                                                                                                                                                                                                                                                                                                                                                                     |

---

## 5. 分包、并行与冻结面

| 包                                | 内容                                                                                                                                              | 文件域                                                                                                                                                                                                                                   | 依赖                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **前置：#29 合入**                | 保活尽力重试（工作区已实现）                                                                                                                      | `src/service/cache-keepalive.ts`、`src/cache-ttl/{keepalive-state,ping-ledger}.ts`、对应 tests                                                                                                                                           | —                                                                                 |
| **P0 协议冻结（#29 之后，很小）** | `messages.ts`：§2 的 interface + `CacheKeepaliveWireSchema` + `StatusInfo`/`StatusInfoSchema` 追加字段；schema 测试                               | `src/web-hub/protocol/messages.ts`；`tests/web-hub/protocol/cache-keepalive-schema.test.ts`                                                                                                                                              | 无                                                                                |
| **P-A agent 侧**                  | §3 全部                                                                                                                                           | `src/cache-ttl/{keepalive-state,cache-ttl}.ts`、`src/service/cache-keepalive.ts`（仅 `lastPingDiagnostics.httpStatus` 那一处）、`src/web-hub/agent/{cache-keepalive(新),status,index}.ts`、`src/index.ts` 的 `wireWebHub` 块、对应 tests | **#29、P0**                                                                       |
| **P-B UI 侧**                     | §4 全部                                                                                                                                           | `src/web-hub/ui/src/components/detail/{cacheKeepaliveView.ts,CacheKeepalivePanel.vue,DetailHeader.vue}`、`styles/cache-keepalive.css`、`i18n/{en,zh}/cacheKeepalive.ts`、对应 tests                                                      | P0（只 `import type`，用手写 fixture；fixture/语料按 #29 后现状；**不依赖 P-A**） |
| **P-C 文档（A/B 合入后）**        | 本文件状态改「已实施」+ 提交号；`AGENTS.md` 的 `src/cache-ttl/` 或 `src/web-hub/` 段加一句指针；`docs/dev/cache-ttl-keepalive/plan.md` 加一句链接 | `docs/`、`AGENTS.md`                                                                                                                                                                                                                     | A、B                                                                              |

**P-A 与 P-B 文件域不相交，可并行。**

**冻结面**（P0 之后不得单方修改）：

- `CacheKeepaliveWire` 的字段名与语义（不含 `armed`）。
- `ping.state` 已知值集合**按 #29 合入后现状**冻结；wire/UI 均按开放字符串处理，未知值 neutral（§0.5）。
- `pingSegmentParts` 的返回形状。

**热点与回避（r2 刷新，评审 #6）**：

- `src/index.ts`、`agent/index.ts`、`agent/status.ts`、`DetailHeader.vue`、`messages.ts`：均只做局部插入 / 追加段，后提交方 rebase 追加段即可。
- **`i18n/*/detail.ts`（共享热点）：本方案不触碰**，使用新命名空间文件。
- **#23 chunked preview（P0–P2a 已提交，P2b 验收中）**：不碰 `ui/src/logic/preview*.js`、`logic/markdown.js`、`password-client.js`、`token-client.js`、`components/preview/*`、`composables/usePreview.ts`、`i18n/*/preview.ts`、`styles/preview.css`、`hub/preview/*`、`hub/hub.ts`、`ui/src/types.ts`、`transport/types.ts`。本方案 UI 侧不动 `types.ts`（无 state 镜像）。文件域零交集，可与 P2b 验收并行，无需等待。
- **#22 droid（P1–P4 已提交；P5 / P7 / P7w 待做）**：
  - **与 P5**：P5 改 `src/index.ts` 的 availableModels / memory / `set_model` 区块以及 `src/stack.ts`；本方案在 `src/index.ts` **只动 `wireWebHub({...})` deps 块**（`quota` dep 之后加一个条件展开）并读取 `cacheTtl` 变量，**不碰 `src/stack.ts`**。不同区块并行；后提交方 rebase，冲突解法为保留双方追加。
  - **与 P7/P7w**：P7 会修改 `protocol/messages.ts` 的 `QuotaWindowSchema` / `QuotaProviderSchema`（provider id 枚举等）。本方案 P0 在同文件的**不同段**（`StatusInfo` 追加字段 + 新 `CacheKeepaliveWireSchema` 追加在 `LoadGateWireSchema` 之后、`StatusInfoSchema` 内追加一行）。规则：两侧均 append-only、不重排既有段；后合入方 rebase，冲突仅可能出现在 `StatusInfoSchema` 字段列表末尾，保留双方即可；_*P0 不得改 Quota* 任何一行_*，P7 不得改 `StatusInfoSchema` 里除追加外的行。
  - 本方案其余文件（`src/cache-ttl/*`、`src/service/cache-keepalive.ts`、`src/web-hub/agent/{cache-keepalive,status}.ts`、UI detail 组件）与 droid 线零交集；`agent/index.ts` 若 P7 也动 quota 投影，同为局部插入。
- **#29**：本方案**严格后于** #29（§0.5），不并行改 `keepalive-state.ts` / `cache-keepalive.ts`。
- 合并顺序建议：P0 → (P-A ∥ P-B) → P-C。验收模型 ≠ 开发模型（dev-flow）。

---

## 6. 风险与缓解

| 风险                                                                                                     | 缓解                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拆分 `renderPingSegment` 导致 TUI 文字漂移                                                               | 零行为重构；既有 `renderCacheStatus` 用例全过 + 新增 `compose==render` 对拍；不改调用方                                                                                                                                                                     |
| 投影越界导致整帧被 hub 丢弃（`decodeWith` 失败丢整个 status 帧，同 bashJobs 的教训）                     | schema 全 open 且边界宽于投影；测试强制「投影必须通过 schema」；字符串在 agent 侧用 `truncateText` 截断；`lines` 封顶                                                                                                                                       |
| `report()` 在 ctx 失效时触发 `dispose()`（含一次 evidence 磁盘写 + `appendEntry` 审计写，**不是零 IO**） | 既有行为，非新暴露面：`updateStatus` 同样经 `report()`；`dispose()` 幂等、`noCacheValueCounted` latch 防双计；stack 重建本就会 dispose 同一服务，web 读者随 `holder.current` 立即换到新服务；外层 try/catch 兜底；session_start 先于 web-hub 的处理器重建栈 |
| #29 与本方案语料/枚举冲突（评审 #1）                                                                     | 严格后于 #29；`state` 开放字符串、未知值 neutral；语料按 #29 后现状派生并注明基线；开工第一步重读 `renderPingSegment`                                                                                                                                       |
| `armed` 误入指纹造成帧率噪音（评审 #2）                                                                  | wire 不含 `armed`；测试断言 tool/ui-prompt/background 翻转不改指纹、不多推帧                                                                                                                                                                                |
| UI 用浏览器本地时钟算 retry，与 agent 时钟有偏差                                                         | 粒度是分钟，冷却 ≥30m；偏差只影响显示几分钟；已过期时降级为 `eligible now`。skew-free 锚定方案被否决，见 D3                                                                                                                                                 |
| `lastPingDiagnostics` 不持久化，`/reload` 后最近一次 ping 的 HTTP 码丢失                                 | 回落到 `session.lastUnproven`（只有 kind、at）；UI 对缺省 `status/attempts` 显式容错                                                                                                                                                                        |
| 文字契约漂移（agent 与 UI 的 `formatMsShort` 各一份）                                                    | 同一份向量在两侧测试各引用一次；改任一侧即红                                                                                                                                                                                                                |
| `mode` 来源错位（服务 `modeState` 是懒同步的）                                                           | 改用 `cacheTtl.status()` 读权威闭包，不读服务私有 `modeState`                                                                                                                                                                                               |
| 单会话多次重建栈造成 `lastKaFp` 误判                                                                     | `session_start` 重置；换服务实例必然改变内容或至少触发一次重推，最坏多推一帧                                                                                                                                                                                |
| 体积预算                                                                                                 | 新组件小；`check:web` 兜底                                                                                                                                                                                                                                  |

---

## 7. 验证与验收清单

1. `npm run format:check`、`typecheck`、`test`、`build`、`build:web`、`check:web` 全绿；`tests/web-hub/ui/source-scan`、`i18n-parity`、`boundary.test.ts` 绿。
2. 手动真机（可用 tmux，见 live-acceptance-tmux）：
   - 起 web-hub，打开主会话详情页：无保活活动时头部不出现新行。
   - 触发若干 ping 后折叠行出现，文字与 TUI 状态栏一致。
   - 人为制造 403（假 relay）：折叠行变为 `ping off:http 403 …`，展开能看到线路行与 retry 倒计时。
   - `/cache-ttl keepalive reset`（TUI）后 ≤1s 内 web 恢复。
   - `/reload`：面板仍在，最近一次 ping 回落到 `lastUnproven`。
   - 关掉 `cacheTtl.keepalive` 再开 web：无该行。
   - 手机视口 360px：单行省略、展开无横向溢出。
3. 旧 hub / 旧 UI 混搭：无该字段时字节不变（wiring + detail-header 快照测试覆盖）。

---

## 8. 非目标（v1 不做）

- 子会话（child keepalive）的状态展示。
- 面板内 reset / 开关 / 模式切换按钮（见 D5）。
- 美元「节省」口径（见 D4）。
- AgentCard / 侧栏徽标（可作后续 T5，同 todo-web 的 T5）。
- 历史曲线 / ping 日志。
- 「ping 重试中」中间态展示（#29 后单次 ping 可重试数分钟，期间 TUI 与 web 均无中间态）。
- `armed` / 窗口是否正在等待下一次 ping 的细粒度展示（D11）。

---

## 9. 决策点

| #       | 决策                                                               | 推荐                                                                    | 说明                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | 是否新增 `webHub.cacheKeepalive` 开关                              | **不加**                                                                | 门控 = `webHub.enabled` ∧ `cacheTtl.keepalive`，与 todo / worktrees / bashJobs 一致。quota 有 `webHub.quota` 是因为它多一路采样与 hub 侧成本；本槽零采样。新增 setting 要连带改 settings 解析/规格/编辑器/文档，收益低                                                                                                                                                                    |
| **D2**  | 数据通道                                                           | **搭 `StatusInfo.cacheKeepalive`，1Hz 指纹门控**                        | 不新建帧/端点/事件；不让服务主动 emit。变化源是 ping 落地、熔断开合/到期、mode 切换等低频离散事件（`armed` 已排除在 wire 之外，D11），最坏 1s 延迟，与 todo/quota 同级                                                                                                                                                                                                                    |
| **D3**  | retry 倒计时时钟                                                   | **绝对 `retryAt` + 浏览器 `Date.now()`，30s ticker**                    | 备选「`retryAt - at` 锚定到收帧时刻」可免疫时钟偏差，但需要 `receivedAt` 基线：面板因头部折叠重挂载会重置基线并高估剩余，要进 `state.js` 镜像才能修，而 `state.js` 是共享冻结面。分钟粒度 + ≥30m 冷却下，偏差可忽略；与 quota-web D2 同口径。r2：`lastPing` 年龄也统一用该时基（评审 #5）                                                                                                 |
| **D4**  | 「节省」展示口径                                                   | **只展示 token 数 `avoided rewrite N tok` 与窗口计数，不算美元**        | `avoidedMissTokens` 是跨模型累加，换算美元需要每窗口按当时单价结算（新状态、新持久化），超出本步范围。`≈$` 展示的是缓存读费用，与 TUI 同口径。美元节省留作后续                                                                                                                                                                                                                            |
| **D5**  | 面板内是否放「发送 reset 命令」入口                                | **默认不做**（可选项见下）                                              | 只读展示是用户已定需求。可选方案：在有 open 行时放一个按钮，经现有命令通道发 `/cache-ttl keepalive reset`。风险：① reset 会清除**经济类熔断**（`proven-write` 等），重新放开真实花费，误触代价高；② 命令通道是 confirm 门控，需要设计一次 web 确认交互；③ 引入第一个写入口，要补 command-policy / ledger / 失败反馈测试。若要做，应单列为后续小包，并复用既有 confirm 对话框，不新造      |
| **D6**  | `enabled:false`（运行时 `/cache-ttl keepalive off`）时字段是否保留 | **保留，带 `enabled:false`**                                            | 否则用户在 web 上看不到「保活被手动关了」。静默规则只在 `enabled===true` 且无任何信息时才返回 `undefined`                                                                                                                                                                                                                                                                                 |
| **D7**  | `mode` 的来源                                                      | **`CacheTtlWiring.status()` 新 getter**                                 | 服务私有 `modeState` 是懒同步的，可能落后。该 getter 是只读闭包，加成必需成员即可                                                                                                                                                                                                                                                                                                         |
| **D8**  | 最近一次 ping 的 HTTP 码                                           | **给 `KeepalivePingDiagnostics` 加可选 `httpStatus`**                   | 否则只能在达到熔断阈值后才有码，无法满足「HTTP 状态码」需求。该字段不持久化、不进审计、不影响 `/cache-ttl status` 现有输出                                                                                                                                                                                                                                                                |
| **D9**  | 文字一致性实现方式                                                 | **拆出 `pingSegmentParts`，agent 发头部 + `retryAt` + `tail`，UI 拼接** | 备选「agent 发整句文字」会让倒计时进入指纹，每分钟推送；备选「UI 自己重写判断逻辑」会漂移。拆分后 TUI 与 web 共用同一份分支逻辑                                                                                                                                                                                                                                                           |
| **D10** | i18n 位置                                                          | **新命名空间文件 `i18n/{en,zh}/cacheKeepalive.ts`**                     | glob 自动合并，避开共享热点 `detail.ts`；与 `quota.ts`、`load.ts` 同模式                                                                                                                                                                                                                                                                                                                  |
| **D11** | wire 是否含 `armed`（r2，评审 #2）                                 | **删除，不放进 wire**                                                   | 二选一：① 删字段；② 保留但移出指纹。选 ①：(a) 与 TUI 状态行口径一致——TUI 状态行从不显示 armed，只有 `/cache-ttl status` 有；(b) ② 会让展开详情里的 armed 陈旧到下一次真实事件，显示一个可能错误的值比不显示更糟；(c) `armed()` 在忙轮次随每个工具调用翻转，是高频瞬时量，不适合走「低频指纹门控」的 status 槽；(d) 窗口活动已由 `window N/M` 与 ping 段（`capped`/`paused`/`active`）表达 |

**车道与调度建议**：L2。**#29 合入后**才开工。P0 小包可由主会话直改或派 dev；P-A 与 P-B 并行派发；每包返回后立即派 verifier（验收模型 ≠ 开发模型）；验收通过后精确路径 commit，不 push。

## 用户拍板（2026-10-14）

- D5：v1 只读，不放 reset 按钮（推荐项）。其余 D 项按方案推荐执行。

---

## 修订记录 r2（吸收 glm-5.3 评审 r1，`webhub-review-r1.md`）

| 评审项                                           | 严重度 | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 改动位置                                                                                                      |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| #1 #29 在途语义变更未纳入                        | 一般   | **采纳**：新增 sequencing 节（本方案在 #29 合入后开工，P-A 不与 #29 并行）；分支集合/示例/parity 语料/transient 表按 #29 后 `renderPingSegment`、`isTransientUnproven` 现状派生并在语料文件头注明基线；`ping.state` 按 #29 后现状冻结，wire 为开放字符串、UI 未知值 neutral，`paused` 作可容忍值保留；写明 `isTransientUnproven` 已含 408、#29 只影响 `attempts`、transient 分类单一来源使 web 自动跟随。**附带更正**：核对工作区代码发现 #29 取消的是**会话级** transient 暂停（`disabled{transient}`），**窗口级 `ping paused:<kind>` 仍对所有 unproven kind 成立**（`onUnproven` 仍写 `window.lastStopReason`），已写入 §0.5 并要求开工时复核 #29 终稿 | §0.5（新）、§2 wire/`ping` 语义与 schema 说明、§3.1(a)、§3.6、§4.3、§5（前置行 + 冻结面）、§6 风险行          |
| #2 `armed` 进指纹导致忙轮次多推帧                | 一般   | **采纳方案①**：wire 删除 `armed`（理由见 D11）；展开详情不显示；§3.4 显式列为不触发项；测试加「tool/ui-prompt/background 翻转不改指纹、不多推帧」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §0 第 7 点、§2、§3.4、§3.6（投影与 wiring 行）、§4.2 第 2 项、i18n 键清单（删 `rowArmed`）、§6、§8、D11（新） |
| #3 「零 IO / 无副作用」表述矛盾                  | 一般   | **采纳**：改为「常态零 IO；stale-ctx 下 `report()`→`safeModel()`→`dispose()` 可触发幂等 evidence 磁盘写 + `appendEntry`，与 `updateStatus` 既有暴露面相同」；§6 写明收敛论证；不新增变体 getter                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §0 第 3 点、§1 首行、§3.3、§6                                                                                 |
| #4 `retryAt` 流逝不触发推送不精确                | 一般   | **采纳**：§3.4 改为「值不漂移；存在性在到期瞬间翻转一次、触发一帧（期望）」；测试限定「到期前 now 前进 ⇒ 指纹不变；跨过 ⇒ 恰好一帧」，wiring 加「冷却到期恰好一帧」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §0 第 2 点、§3.4、§3.6、D2                                                                                    |
| #5 lastPing 年龄与 retry 倒计时时基不一致        | 建议   | **采纳**：年龄统一用浏览器时钟；ticker 条件扩为「存在未来 `retryAt`」或「展开且有 `lastPing`」；测试加「年龄随假时钟前进」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §4.2、§4.3、D3                                                                                                |
| #6 工作区在途事实陈旧 / 并行性未点名             | 建议   | **采纳**：刷新 §1 在途行（#23 P0–P2a 已提交、P2b 验收中；droid P1–P4 已提交、P5/P7 待做；#29 即将合入）；§5 点名与 droid P5（`src/index.ts` 不同区块，不碰 `src/stack.ts`）、P7/P7w（`messages.ts` 同文件不同段，互不改对方段，append-only，后合入方 rebase）的并行与 rebase 规则                                                                                                                                                                                                                                                                                                                                                                         | §1 在途行、§5                                                                                                 |
| #7 `lastPingDiagnostics` 既有 `toEqual` 断言会红 | 建议   | **采纳**：§3.6 service 测试行补「既有断言同步更新，随 P-A 同包提交」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §3.6                                                                                                          |
| （附带）#29 引入的 `attempts` 取值范围           | —      | 投影 clamp `attempts` 到 [1,999]；「ping 重试中」中间态列为非目标                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §0.5、§2、§3.2、§8                                                                                            |
