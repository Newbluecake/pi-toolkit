# 保活熔断：按线路记录 + 同线路真实请求成功可复位 + 退避 + 手动 reset

> 状态：方案（只读调研产出，未改代码）。基线 = 工作区当前 diff（keepalive-http-status 包已合入：
> `SessionTotals.disabled.httpStatus?`、`sanitizeHttpStatus`、`renderPingSegment` 的 `ping off:http 403 ×N`）。
> 相关：`docs/dev/cache-ttl-keepalive/plan.md` §1 I-K7 / I-K7 amendment、§7.5、§16；AGENTS.md `src/cache-ttl/` 段。
> 车道：L2（状态机 + 持久化格式 + 命令面 + web 策略）。

## 0. 现象与根因

主会话 10/12 对 kimi-coding（`https://api.kimi.com/coding`，k3-256k）回放 ping，连续 2 次非可重试 4xx
（`attempts:1`）⇒ `onUnproven` 里 `nonTransientConsecutiveUnproven >= UNPROVEN_STREAK_LIMIT(2)` ⇒
`session.disabled = {reason:"http", at}`（无 `transient`）。此后用户换到别的 provider，真实请求一直成功，
但：

1. `onSuccessfulRealRequest` 只在 `disabled.transient === true` 时复位（`keepalive-state.ts` 的 `onSuccessfulRealRequest`）；
2. `evaluateTick` #2 `session.disabled !== undefined ⇒ skip("session-disabled", true)`，**与线路无关**；
3. 状态通过 `subagent:cache-keepalive` 快照持久化，`/reload` 读回仍是同一条永久记录 ⇒ 两天 `ping off:http ×0`。

根因是「把 ping 被拒这一**线路属性**记成了**会话属性**，并套用了本为『经济类』设计的永久语义」。HTTP 4xx
（非 408/429）= 请求被拒、服务端未处理 ⇒ **不可能产生缓存计费**（plan.md §16 已论证：4xx 请求本身有问题，
不可能已被计费），它不属于 I-K7 要堵的「隐形全量写」经济漏洞，因此可以安全地线路化 + 可复位。

## 1. 设计总览（五条原则）

1. **只把「4xx 拒绝」线路化**：非瞬态 HTTP（非 408/429/5xx）的计数与熔断从 `SessionTotals` 的会话级
   `nonTransient*` 计数中**摘出**，改记入 `session.lineStates[lineKey]`。
2. **经济类与语义类保持会话级永久**：`proven-write`、`no-usage`（200 但无 usage/双 0）、`no-cache-value`
   （O3，已有自己的复位）、child 的 `usd-*`/`global-cap`/`session-cap` 费用闸，**一概不动**。
3. **复位只认「同线路」真实请求成功**（`isSuccessfulRealRequest`），且受**冷却**约束（首次熔断冷却 0 ⇒ 兑现
   「请求成功就重置」；同线路复位后再被拒 ⇒ 冷却翻倍，有上限）。
4. **无新定时器**：冷却是「可复位时刻」`resetEligibleAt`，只在真实请求 settle / tick 时与 `clock.now()` 比较，
   从不为它起 timer。
5. **向后兼容**：旧的会话级 http 永久 `disabled` 读回后迁移为通配线路熔断 `"*"`（任意成功真实请求即复位）。

## 2. 线路键（line key）

### 2.1 定义

`line = provider + "\n" + normalizedBaseUrl + "\n" + ctxModelId`，持久化/比较用其 `hash53`（`keepalive-state.ts`
已有的非导出 `hash53`，同模块直接复用）：`key = "L" + hash53(line)`；另有保留键 `"*"`（通配，仅迁移产生）。

- `provider`：`ctx.model.provider`（= 指纹 `fingerprint.provider`）。
- `baseUrl`：`ctx.model.baseUrl`（= 指纹 `fingerprint.baseUrl`，`cache-ttl.ts` 的 `buildFingerprintContext`
  ← `ctx.model.baseUrl`）。归一化：`new URL()` 解析，小写 scheme+host，去 query/fragment，去尾部
  `/`；解析失败退回 `trim()`。
- `ctxModelId`：`ctx.model.id`（= 指纹 `fingerprint.ctxModelId`），**不用** payload 的 `fingerprint.modelId`
  （线上 `payload.model` 可能因 fallback 模型与 `ctx.model.id` 不同，而 settle 事件侧拿到的是
  `message.model` = `ctx.model.id`，两侧必须用同一口径）。
- 不含 `api`（由 model 决定）、不含 `authHeaderKeys`（首次 ping 后才锁定，会变）、不含 apiKey。
- `provider` 与 `ctxModelId` 均为空 ⇒ `lineKeyOf` 返回 `undefined`。**这在生产可达**：`buildFingerprintContext` 用
  `model?.provider ?? ""` / `model?.id ?? ""`，`ctx.model` 读取退化的窗口期捕获会得到双空串。此时非瞬态 http **落通配
  `"*"`**（会话内、任意成功真实请求即复位，见 §3.1/§4.1），**绝不**回退成无复位的会话级永久——否则又复现本方案要修的
  「静默 off 两天」。只有 `no-usage` / `proven-write` 保持会话级永久。

**为什么不直接用 `provider+modelId`（O3 `routeKey`）**：同一 provider 可能多个 baseUrl（relay / 直连）、同一
baseUrl 可能多个模型（kimi 的 coding 端点按模型/会员分流），用户明确列了 provider + baseUrl + model。
O3 的 `routeKey(provider, payload.model)` 保持原样，二者是两层不同粒度，互不替代（见 §9）。

**持久化只存哈希 + 展示标签**：标签 `label = "<provider>/<ctxModelId>@<host>"`（只含 host，**不含 path/query**，
截断 96 字符），避免 baseUrl 路径里偶发的凭据字样进会话文件。

### 2.2 两侧如何拿到同一个键（代码坐标）

| 侧             | 事件 / 位置                                                                                                                                                                                               | 可得信息                                                                                      | 键来源                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ping 失败/命中 | `service/cache-keepalive.ts` `runPing` → `onUnproven/onProvenHit(window, …)`，`window.capture.fingerprint`（`capture` 在 `noteRequest` 时由 `captureRequest()` 装入，`cache-ttl.ts` 的 `captureRequest`） | provider / ctxModelId / baseUrl 全齐                                                          | `lineKeyOf(window.capture.fingerprint)`，**在 reducer 内部推导**（`onUnproven` 在置 `capture: undefined` 之前取旧 window 的 capture），所以 `onUnproven/onProvenHit` **签名不变** |
| 真实请求成功   | `cache-ttl.ts` `wireCacheEvents` 里的 `message_end` / `turn_end` 处理器 → `ka.noteRequestSettled(sessionId, instance, isSuccessfulRealRequest(event.message))`                                            | `event.message.provider`、`event.message.model`（pi-ai `AssistantMessage`），**没有 baseUrl** | 新增第 4 参 `settledRoute?: {provider, modelId}`；服务端补 baseUrl，见下                                                                                                          |
| tick / 状态栏  | `service.currentLine()`：`safeModel()` = `ctx.model`                                                                                                                                                      | provider / id / baseUrl                                                                       | `lineKeyOf` 同函数                                                                                                                                                                |

**baseUrl 的补全（`CacheKeepaliveServiceImpl.resolveSettledLine(route)`）**，按序：

1. `this.inflightLine`（`noteRequest` 时记下的最近一次捕获线路 `{provider, ctxModelId, baseUrl}`）的
   provider+ctxModelId 与 `route` 一致 ⇒ 用它（**最精确**：它就是这次请求发出时的 `ctx.model`）；
2. 仅当 `this.inflightLine === undefined`（本代服务从未捕获过请求，如 /reload 后首个请求的 settle 先于捕获）且当前 `ctx.model` 的
   provider+id 与 `route` 一致 ⇒ 用当前 model 线路。**`inflightLine` 存在但不匹配时不得用 ctx.model 兜底**（避免会话中途改 models.json、
   同 provider+id 换 baseUrl 时把成功错归因到新 baseUrl 线路）；
3. 否则（用户在请求中途切了模型 / 回包 model 与 inflightLine 不符 / 无 inflightLine 且与 ctx.model 也不符）⇒ 返回 `undefined` ⇒ **不复位任何已知线路**，
   只允许通配 `"*"` 复位；并 `audit("line-reset-skipped", {reason:"route-unresolved"})`（去重，每 route 一次）。

> 取舍：宁可少复位（该线路继续 off，用户有 `reset` 命令兜底）也不错复位到别的线路。风险点 =「`message.model`
> 与 `ctx.model.id` 不等」（如 pi 将来在 message 上写别名）。T-L3 用测试钉住 1/2/3 三种分支；验收时看
> `line-reset-skipped` 审计是否出现。

## 3. 变更清单

### 3.1 `src/cache-ttl/keepalive-state.ts`（纯状态机，无 pi 依赖）

新增常量/类型（完整定义）：

```ts
/** 保留键：由旧版会话级 http 永久熔断迁移而来的「未知线路」熔断；任意成功真实请求即复位，无冷却。 */
export const LINE_KEY_WILDCARD = "*";
/** 线路熔断退避：首次熔断冷却 0（成功即复位）；同状态码再次熔断 trips≥2 起 BASE·2^(trips-2)，封顶 CAP。 */
export const LINE_COOLDOWN_BASE_MS: Millis = 30 * 60_000; // 30 min
export const LINE_COOLDOWN_CAP_MS: Millis = 24 * 3_600_000; // 24 h
/** 距上次复位/熔断超过此时长再熔断 ⇒ trips 重新从 1 计（长期健康的线路不背历史债）。 */
export const LINE_TRIPS_FORGET_MS: Millis = 24 * 3_600_000;
/** lineStates 容量上限（FIFO/LRU，防快照膨胀）。 */
export const MAX_LINE_STATES = 16;

export interface LineRef {
  /** `"L"+hash53(...)` 或 LINE_KEY_WILDCARD。 */
  key: string;
  /** 展示用：`provider/model@host`，≤96 字符，不含 path/query。 */
  label: string;
}

export interface LineState {
  label: string;
  /** 最近一次计入本线路的非瞬态 HTTP 状态码（100–599，经 sanitizeHttpStatus）；迁移的通配记录可缺。 */
  status?: number;
  /** 本线路连续非瞬态拒绝数（proven-hit / 瞬态失败 / 复位 清零）。 */
  consecutive: number;
  /** 本线路累计非瞬态拒绝数（复位 / proven-hit 清零）。 */
  total: number;
  /** 熔断是否打开（打开 ⇒ evaluateTick 对该线路 skip("line-disabled")）。 */
  open: boolean;
  openedAt?: Millis;
  /** 同状态码、无 proven-hit 间隔下的连续熔断次数（退避指数）；≥1 当 open 或曾 open。 */
  trips: number;
  /** open 期间：最早允许被真实成功复位的时刻（= openedAt + cooldown(trips)）。 */
  resetEligibleAt?: Millis;
  lastResetAt?: Millis;
  /** 最近一次被改动，LRU 淘汰依据。 */
  updatedAt: Millis;
}

export function lineKeyOf(fp: Pick<CaptureFingerprint, "provider" | "ctxModelId" | "baseUrl">): LineRef | undefined; // 纯函数；provider 与 ctxModelId 皆空 ⇒ undefined
export function lineCooldownMs(trips: number): Millis; // trips<=1 ⇒ 0；否则 min(CAP, BASE·2^(trips-2))
export function isLineOpen(session: SessionTotals, key: string): boolean; // lineStates[key]?.open || lineStates["*"]?.open
```

`SessionTotals` 变更：

```ts
export interface SessionTotals {
  // …既有字段不变（含 nonTransient* —— 语义收窄为「no-usage / proven-write 之类的非 HTTP 非瞬态」）…
  /** 线路级熔断/退避记录；仅承载「非瞬态 HTTP 拒绝」。键 = LineRef.key。旧快照缺省读回 {}。 */
  lineStates: Readonly<Record<string, LineState>>;
}
```

`createInitialSessionTotals()` 增 `lineStates: {}`。

`TickSkipReason` 增 `| "line-disabled"`（非经济，终局 terminal:true，与 session-disabled 同形）。

`evaluateTick`：在 #3（`no-capture`）之后、#4 之前插入 **#3.5**：

```ts
const line = lineKeyOf(capture.fingerprint);
if (line !== undefined && isLineOpen(session, line.key)) return skip("line-disabled", true);
// line 不可得（生产可达，见 §2.1）：只受通配约束
if (line === undefined && session.lineStates[LINE_KEY_WILDCARD]?.open) return skip("line-disabled", true);
```

（通配对所有线路生效；已知线路 `isLineOpen` 内含通配。）#2 `session-disabled` 仍在最前，优先级不变。

`onUnproven`（reducer，签名不变）：

- `transient`（network / accepted-then-lost / malformed / 408 / 429 / 5xx）：**逻辑不变**（会话级瞬态计数 + transient
  disabled）；另外该线路若存在**未 open** 的 LineState，则 `consecutive = 0`（镜像旧 `nonTransientConsecutive` 被瞬态打断）。
- `kind === "http" && !transient && line !== undefined`：**走线路路径，不再动 `session.nonTransient*` 与
  `session.disabled`**：
  1. `rec = lineStates[key] ?? {consecutive:0,total:0,open:false,trips:0}`（`rec` 是**变更前**的只读快照，下文全部从它读旧值）；
  2. 若 `rec.open`（竞态残留）⇒ 只刷新 `updatedAt`，不改计数；
  3. `status = sanitizeHttpStatus(httpStatus)`；`next = {...rec, consecutive: rec.consecutive+1, total: rec.total+1, status}`
     （**先算 `sameStatus`、后写 `status`**：`sameStatus` 必须比较 `rec.status`（旧值）与新 `status`，绝不能读 `next.status`，否则恒真）；
  4. `next.consecutive >= UNPROVEN_STREAK_LIMIT || next.total >= UNPROVEN_TOTAL_LIMIT` ⇒ 熔断：
     `sameStatus = rec.status === status && rec.trips > 0 && (now - (rec.lastResetAt ?? rec.openedAt ?? 0)) < LINE_TRIPS_FORGET_MS`；
     `trips = sameStatus ? rec.trips + 1 : 1`；`open=true`、`openedAt=now`、`resetEligibleAt = now + lineCooldownMs(trips)`；
  5. 容量淘汰（见下）。
     `session.lastUnproven`、`consecutiveUnproven`、`unprovenTotal`（旧聚合，仅展示）照旧更新。
- `kind === "http" && !transient && line === undefined`：**落通配 `key = LINE_KEY_WILDCARD`，计数/熔断规则与线路路径相同**
  （label `"unknown line"`；`trips` 恒为 1、`resetEligibleAt = now`——通配在被任意成功复位时整条删除，故无退避）。不碰
  `session.nonTransient*` / `session.disabled`。通配 open 时对所有线路生效。
- `no-usage`、`proven-write`：**旧路径完全不变**（会话级 `nonTransient*` + `{reason, at, httpStatus?}` 永久 `disabled`）。

`onProvenHit`（签名不变）：除既有逻辑外，`lineStates` 中该 capture 线路若**未 open**，**整条删除**（线路被证明可用
⇒ 清 `consecutive/total/trips`）；capture 线路不可得时同样删除**未 open** 的通配计数记录。open 线路不会 ping，故无需处理。

`onSuccessfulRealRequest(session, successful, options?)`：

```ts
export function onSuccessfulRealRequest(
  session: SessionTotals,
  successful: boolean,
  options?: { line: LineRef | undefined; now: Millis },
): SessionTotals;
```

1. `!successful` ⇒ 原样返回同一引用。
2. 瞬态恢复：与现有完全一致（`disabled.transient===true && !isPermanentThresholdMet`）。
3. **线路复位**（仅当传入 `options`）：
   - 通配 `"*"` 且 `open` ⇒ **整条删除**（任意成功即复位，无冷却）；
   - `options.line` 命中 `lineStates[line.key]` 且 `open` 且 `options.now >= (resetEligibleAt ?? 0)` ⇒
     `open=false; consecutive=0; total=0; lastResetAt=now; delete openedAt/resetEligibleAt; updatedAt=now`（**保留 `trips`/`status`**，
     用于再熔断时的退避判定）；`now < resetEligibleAt` ⇒ 不变（冷却中）。
4. 无任何变化 ⇒ 返回同一引用（沿用「`===` 断言未变」约定）。

新增 `resetAllBreakers(session): { session: SessionTotals; summary: BreakerResetSummary }`（纯，供手动 reset）：

```ts
export interface BreakerResetSummary {
  /** 被清掉的会话级 disabled.reason（无则 undefined）。 */
  sessionDisabled: string | undefined;
  /** 被清掉的 open 线路数（含通配）。 */
  openLines: number;
  /** 是否清掉了 provenWrites（经济类熔断，用户手动覆盖）。 */
  economicCleared: boolean;
}
```

清零：`disabled=undefined`、`transient*`/`nonTransient*`/`consecutiveUnproven`/`unprovenTotal`=0、`provenWrites=0`、
`lineStates={}`；**保留** `pings/cacheReadTokens/unnecessary*/loadBearing*/discarded*/noCacheValueCounted/lastUnproven`
（审计与 O3 once-per-session 防重复计数不能丢）。

`readBackKeepaliveSessionState`：

- 新增 `if ("lineStates" in snapshot) next.lineStates = sanitizeLineStates(snapshot.lineStates)`（整体替换，因为每条快照是
  全量）。`sanitizeLineStates`：非对象 ⇒ `{}`；键须匹配 `/^(L[0-9a-z]{1,16}|\*)$/` 且为 own property（挡 `__proto__`）；
  `label` 非空字符串截 96；数值字段 `finiteNonNegative`；`status` 经 `sanitizeHttpStatus`；`open` 须严格 `=== true`；
  `trips` 取整并 clamp 到 [0,64]；超过 `MAX_LINE_STATES` 按 `updatedAt` 降序截断；单项非法 ⇒ 丢该项，不抛。
- **迁移（§6）**：循环结束后，若**最后一个**被采用的快照**不含** `lineStates` 键且 `restored.disabled` 满足
  `reason === "http" && transient !== true`，则迁移为通配线路熔断。

`renderPingSegment` / `KeepaliveReport` / `renderKeepaliveReportLines`：见 §7。

`isPermanentThresholdMet`：不变（现在只会被 no-usage / proven-write 驱动）。

### 3.2 `src/service/cache-keepalive.ts`

- `CacheKeepaliveDeps`：不新增依赖（`recoverTransientFailures` 同时门控线路复位，主会话 only）。
- 私有字段：`inflightLine: {provider, ctxModelId, baseUrl} | undefined`（`noteRequest` 里赋值）、
  `unresolvedAudited: Set<string>`（上限 8，去重 `line-reset-skipped`）。
- `noteRequestSettled(sessionId, instance, successful = false, settledRoute?: {provider: string; modelId: string})`
  （`KeepalivePort` 接口同步加可选第 4 参）：
  ```ts
  const line = successful && settledRoute ? this.resolveSettledLine(settledRoute) : undefined;
  const nextSession = this.deps.recoverTransientFailures
    ? onSuccessfulRealRequest(this.session, successful, { line, now: this.clock.now() })
    : this.session;
  if (nextSession !== this.session) {
    const reopened = lineResetHappened(this.session, nextSession); // 线路 open→closed 或通配删除
    this.session = nextSession;
    this.audit(reopened ? "line-reset" : "real-request-recovered", reopened ? { lineKey: line?.key, label: … } : {});
    if (reopened) { this.lastSkip = undefined; this.syncExactTimer(); if (this.timer === undefined) this.arm(); }
    this.publishVisibility();
  }
  ```
  复位后必须 `syncExactTimer()` + `arm()`：`line-disabled` 是**终局** skip，会 `clearExactTimer()` 且不再 re-arm（`onTick`
  skip 分支），不补这一步当前窗口要等到下一次真实请求才恢复。（与 `noteRequest` 的 arm 行为一致；都走 `systemClock`/`clock.setTimer`，已 unref。）
- `report()`：增补 `currentLineKey`、`now`（§7）。
- `onTick` 无需改（`evaluateTick` 已处理 `line-disabled`）；`auditTerminalSkipOnce` 自动覆盖新 reason。
- `runPing` `unproven` 审计：`disabled: applied.session.disabled !== undefined` 之外增 `lineOpen: boolean`、
  `lineKey`、`httpStatus`（仅 http）；`proven-hit` 审计无需改。子会话审计结构向后兼容（只增字段）。
- 新增 `resetBreakers(): BreakerResetSummary & { evidenceCleared: boolean }`（挂 `CacheKeepaliveService`，**不**进
  `KeepalivePort`，避免波及只实现 port 的测试替身）：
  1. `resetAllBreakers(this.session)` ⇒ 赋值；
  2. 对**当前线路**（`lastRoute ?? ctx.model`）调 `evidence.resetNoCacheValue(provider, modelId, now)`
     （否则 `onTick` 的 O3 闸会在下一次 ping 立刻重新 latch `no-cache-value`，reset 形同虚设；见 §9）；
  3. `lastSkip=undefined`；`audit("breaker-reset-manual", {…summary})`（审计条目随 `persistSessionState` 带全量
     session ⇒ `/reload` 后读回为已清空）；`syncExactTimer(); if (!this.timer) this.arm(); publishVisibility()`。
  4. dispose 后调用 ⇒ no-op 返回全空 summary。

### 3.3 `src/cache-ttl/cache-ttl.ts`

- `wireCacheEvents` 里 `message_end` 与 `turn_end` 处理器的 `noteRequestSettled` 调用补第 4 参
  `settledRouteOf(event.message)`（本文件内小 helper：`message.provider`/`message.model` 皆非空字符串才返回，
  否则 `undefined`）。`agent_settled`/`agent_end` 无 message，保持不变。
- `/cache-ttl keepalive reset`（`registerCommand("cache-ttl")` 的 handler、`head === "keepalive"` 分支）：`sub === "reset"` ⇒ `port.resetBreakers()`，文案见 §8。
  补全 `getArgumentCompletions` 的 `["on","off"]` ⇒ `["on","off","reset"]`；顶层 `USAGE`/`description` 追加
  `keepalive on|off|reset`；`keepalive` 无/错子命令的 usage 文案改 `usage: /cache-ttl keepalive on|off|reset`。
- `/cache-ttl status`（`renderKeepaliveReportLines`）增线路行，见 §7。

### 3.4 `src/cache-ttl/provider-evidence.ts`

`ProviderEvidenceStore` 增一个方法（仅供手动 reset）：

```ts
/** 用户手动 reset：清掉该线路的 no-cache-value 连败与熔断（不伪造 cacheRead 证据；不动 write1h/probe 证据）。 */
resetNoCacheValue(provider: string, modelId: string, now: Millis): void;
```

实现与 `noteCacheRead` 同构（`mutate` + try/catch，`zeroReadSessions=0; delete noCacheValueSince`），区别仅在语义/调用方。
`tests/cache-ttl/provider-evidence.test.ts`、`keepalive-evidence.test.ts` 用真实 store，无需改替身。

### 3.5 `src/web-hub/agent/command-policy.ts`

`"cache-ttl"` 现规则 `sub === undefined || "status"` ⇒ allow，其余 confirm。`keepalive reset` 自然落入 confirm（它会清除
经济类熔断，必须有人确认）——**不改逻辑，加注释 + 测试钉死**：`tests/web-hub/agent/command-policy.test.ts` 在 `/cache-ttl: no-args/status allow; every mode switch confirms` 用例
追加 `expect(resolve("cache-ttl","keepalive reset","extension").policy).toBe("confirm")`。web 端 `captured:true` 回显走
`ctx.ui.notify`，无需额外适配。

### 3.6 `src/cache-ttl/child.ts`（子会话保活）——**判断：不改**

理由：(a) 子会话单次 prompt、`agent_settled` 即 dispose（`wireChildKeepalive` 的 `agent_settled` 处理器），生命周期以分钟计，没有「换线路/跨天」问题；
(b) `recoverTransientFailures` / `persistSessionState` 对子会话均关，线路 open 记录只活在本 run 内存里，等价于旧「本 run 永久」
语义，且 4xx 零计费；(c) 子会话 `noteRequestSettled` 不带成功标志，复位路径天然不触发。**自动获益的部分**：reducer/evaluateTick
是共享纯代码，子会话也会走「线路级 http 熔断」而不是「会话级 http 熔断」——对单线路 run 行为等价；`child-keepalive.test.ts`
/`keepalive-child.test.ts` 里若有断言「403 ⇒ `disabled` 非空」需同步（§10 T-C）。不新增 child 设置项。

## 4. 状态机新规则表

「线路」= `lineKeyOf(capture.fingerprint)`；「S」= 同线路真实请求成功（`isSuccessfulRealRequest` 且 `resolveSettledLine` 命中该线路）；
`now` 对比 `resetEligibleAt`。

### 4.1 ping 结果 → 状态

| unproven kind                                     | 状态码                                              | 归类         | 计数落点                              | 触发熔断        | 熔断形态                                                      | 备注                                                                     |
| ------------------------------------------------- | --------------------------------------------------- | ------------ | ------------------------------------- | --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `network` / `accepted-then-lost` / `malformed`    | —                                                   | 瞬态         | 会话级 `transient*`                   | 连续 2 / 累计 3 | `session.disabled{transient:true}`                            | **不变**；任意线路成功真实请求复位（现状）；同时打断该线路 `consecutive` |
| `http`                                            | 408 / 429 / 5xx                                     | 瞬态         | 同上                                  | 同上            | 同上（`httpStatus` 已有）                                     | **不变**                                                                 |
| `http`                                            | 其它（4xx/3xx…），线路可得                          | **线路拒绝** | `lineStates[key]` `consecutive/total` | 连续 2 / 累计 3 | `lineStates[key].open=true`，`trips`/`resetEligibleAt` 见 4.2 | **本方案新增**；不碰 `session.nonTransient*`/`disabled`                  |
| `http`                                            | 其它，线路不可得（`lineKeyOf`⇒undefined，生产可达） | **通配拒绝** | `lineStates["*"]` `consecutive/total` | 连续 2 / 累计 3 | `lineStates["*"].open=true`（`trips=1`，无冷却）              | 会话内任意成功真实请求即复位；不再有无复位的会话级 http 永久路径         |
| `no-usage`                                        | —                                                   | 语义/经济类  | 会话级 `nonTransient*`                | 连续 2 / 累计 3 | 永久 `session.disabled`                                       | **不变**（见决策 D2）                                                    |
| `proven-write`                                    | —                                                   | 经济类       | `provenWrites`                        | 1 次            | 永久 `session.disabled`                                       | **不变**；仅手动 reset 可清                                              |
| （service）evidence `no-cache-value`              | —                                                   | 证据类       | 跨会话账本                            | 账本判定        | `session.disabled{reason:"no-cache-value"}`                   | **不变**；`noteUsageCacheRead` 复位；手动 reset 也清账本（§9）           |
| （service）`usd-*` / `global-cap` / `session-cap` | —                                                   | 经济/容量    | ledger                                | —               | 终局 skip，不进 breaker                                       | **不变**                                                                 |

### 4.2 线路熔断生命周期

| 当前线路状态                             | 事件                                    | 结果                                                                                                                      |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 无记录                                   | 拒绝 s（第 1 次）                       | `{consecutive:1,total:1,status:s,open:false,trips:0}`                                                                     |
| closed，`consecutive+1≥2` 或 `total+1≥3` | 拒绝 s                                  | **open**；`trips = (status===s && trips>0 && 距上次复位/熔断<24h) ? trips+1 : 1`；`resetEligibleAt = now+cooldown(trips)` |
| closed                                   | 该线路 proven-hit                       | **整条删除**（trips 清零）                                                                                                |
| closed                                   | 该线路瞬态失败                          | `consecutive=0`（保留 total/trips）                                                                                       |
| open，`trips=1`                          | S（任意 now）                           | **复位**：`open=false, consecutive=total=0, lastResetAt=now`，保留 `trips=1,status`（冷却 0 ⇒ 兑现「成功即复位」）        |
| open，`trips≥2`，`now ≥ resetEligibleAt` | S                                       | 复位（同上）                                                                                                              |
| open，`trips≥2`，`now < resetEligibleAt` | S                                       | **不变**（冷却中；状态栏显示 `·retry <剩余>`）                                                                            |
| open                                     | 其它线路成功                            | 不变（线路隔离）                                                                                                          |
| open                                     | 其它线路的 ping 结果                    | 不影响本线路；本线路不 ping                                                                                               |
| 复位后（closed，`trips=n`）              | 同状态码再熔断（<24h）                  | `trips=n+1`，冷却翻倍                                                                                                     |
| 复位后（closed，`trips=n`）              | 不同状态码熔断                          | `trips=1`（视为新问题）                                                                                                   |
| 复位后（closed，`trips=n`）              | 之后 ≥24h 才熔断                        | `trips=1`（遗忘）                                                                                                         |
| 通配 `"*"` open                          | 任意 S（含任意线路、含 route 解析失败） | **整条删除**（无冷却；此后若仍被拒，按普通线路从 `trips=1` 开始）                                                         |
| 任意                                     | 手动 `reset`                            | 全部清空（§3.2）                                                                                                          |

**退避曲线**（`lineCooldownMs(trips)`）：1→0；2→30m；3→1h；4→2h；5→4h；6→8h；7→16h；≥8→24h（上限）。
最坏成本分析：4xx 零计费；每个熔断周期 = 2 个被拒 ping（需要 2 个窗口，即 2 次真实请求）。kimi 型「ping 永远被拒、真实请求永远成功」
的线路：周期 1（0 冷却）→ 周期 2 起冷却 30m…24h，一天内最多 ≈ 数个周期，总被拒 ping ≲ 十几个/天，量级可忽略；且无任何新定时器。

## 5. 并发 / 竞态检查（I-K8 一致）

- 线路计数写入仍只发生在 `onUnproven`/`onProvenHit` 内，二者首行已有 `pingEpoch !== windowEpoch ⇒ 丢弃`，**迟到结果不会污染线路表**。
- `resolveSettledLine` 只读 `inflightLine`/`ctx.model`，不写状态；`noteRequestSettled` 先过 `accept()`（I-K6/I-K9）。
- 同一请求会触发多次 settle（`message_end` + `turn_end`）：第二次 `onSuccessfulRealRequest` 无变化 ⇒ 同一引用 ⇒ 不重复审计。
- 竞态：线路刚 open 时另有一个已在飞的 ping（同线路）返回 ⇒ epoch 已变被丢弃；极端未丢时命中「open 时只刷新 updatedAt」分支。

## 6. 持久化格式与迁移

**新格式**（audit 快照 `data.session` 内，仅 `persistSessionState` 的主会话）：

```jsonc
"session": {
  …既有字段…,
  "disabled": null,                       // 线路熔断不再占用该字段
  "lineStates": {
    "L1k3f9x2a": { "label":"kimi-coding/k3-256k@api.kimi.com", "status":403, "consecutive":0, "total":0,
                   "open":true, "openedAt":1760000000000, "trips":2, "resetEligibleAt":1760001800000,
                   "lastResetAt":1759990000000, "updatedAt":1760000000000 }
  }
}
```

**读回（向后兼容）**：

| 旧快照                                                                                                            | 读回结果                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无 `lineStates` 键、`disabled = {reason:"http", at}`（无 transient；有无 `httpStatus` 均可，含 10/12 的实际记录） | `disabled=undefined`；`lineStates["*"] = {label:"unknown line (legacy)", status:httpStatus?, consecutive:0,total:0, open:true, openedAt:at, trips:1, resetEligibleAt:at, updatedAt:at}`；并把 `nonTransientConsecutiveUnproven/nonTransientUnprovenTotal` 置 0（否则残留的 ≥2 会让下一个任意 unproven 立刻再触发永久熔断）。**下一次任意成功真实请求即复位。** |
| 无 `lineStates`、`disabled.transient===true`                                                                      | 原样（瞬态，现有复位路径）                                                                                                                                                                                                                                                                                                                                     |
| 无 `lineStates`、`disabled.reason ∈ {proven-write,no-usage,no-cache-value,…}` 非 http                             | 原样永久（不可判定线路；用户可 `reset`）                                                                                                                                                                                                                                                                                                                       |
| 有 `lineStates`                                                                                                   | 逐项 sanitize；非法项丢弃；整体非法 ⇒ `{}`；**不抛**                                                                                                                                                                                                                                                                                                           |
| `lineStates` 缺失且 `disabled` 缺失                                                                               | `lineStates={}`                                                                                                                                                                                                                                                                                                                                                |

迁移只在「该链上最后采用的快照是旧格式」时执行。新格式下 `{reason:"http"}` 永久 `disabled` 已不再产生（线路不可得也落通配），故新格式快照不会被误迁移。
迁移是**读回时的纯函数**，不额外写盘；下一次任何 audit 会把新格式落盘。
**混合史残余**：旧 `nonTransient*` 是 http 与 no-usage 混算的，旧快照无法判别 `disabled.reason==="http"` 的触发史里是否含 no-usage。迁移一律按 http 处理并清零计数（决策 D7 已接受，§13 披露）。
**回滚兼容**：新快照被旧版本读回时，`lineStates` 被忽略、`disabled` 为空 ⇒ 旧代码对该线路恢复 ping（可接受，4xx 零计费；旧代码会重新计数熔断）。

## 7. 状态行与 `/cache-ttl status`

**状态行**（紧凑英文 token，不混中文）。`KeepaliveReport` 增两个可选字段：`currentLineKey?: string`、`now?: Millis`（皆由
`report()` 填；缺省时退化为旧渲染）。`renderPingSegment` 优先级：

1. `session.disabled`（现状，含 sibling 包的 `http 403`）；
2. **当前线路**（`lineStates[currentLineKey]`）或通配 `"*"` 处于 open：
   `ping off:http 403`；`status` 缺失（迁移/通配记录）⇒ `ping off:http`；`resetEligibleAt > now` 时追加 ` ·retry 25m`；
   `trips≥2` 追加 ` ·t3`。**线路 off 形态不带 `×N`**：`×N` 是跨线路累计的 `session.pings`，在多线路会话里会把线路 B 的 ping
   算到线路 A 的 off 上造成误导；`×N` 只保留在 `session.disabled` 形态（第 1 条，会话级，语义自洽）。
3. 其余沿用。

**时长 helper**：`keepalive-state.ts` 内新增本地纯函数 `formatMsShort(ms: number): string`（不复用 `feishu-notify/core.ts` 的
`formatDuration`——那是秒入参且属另一模块，pi-free 状态机不应跨模块耦合/单位错配）：`ms<=0 → "0m"`；`<60s → "<1m"`；
`≤120min → ceil(分钟)+"m"`（25m、90m）；`>120min → ceil(小时)+"h"`（3h，封顶展示 `24h`）。向上取整，避免显示「还剩 0」而仍在冷却。

非当前线路 open **不显示**（不干扰当前线路状态），只在 `/cache-ttl status` 里列出。

**`renderKeepaliveReportLines`** 增行（英文 token）：

```
line off: kimi-coding/k3-256k@api.kimi.com · http 403 · trips 2 · reset eligible in 25m   // 每条 open 线路一行
line armed: 2 closed record(s) with history                                              // 有 closed 但 trips/consecutive>0 的记录数
```

`disabled:`/`breaker:` 行保持。无线路记录则不输出（旧快照零差异）。

## 8. `/cache-ttl keepalive reset`

行为：清除**当前会话**全部熔断（`resetAllBreakers` + 当前线路 evidence `no-cache-value`），重新武装当前窗口；**不**启用被用户 `keepalive off` 关闭的开关；
不清 ping 账本/预算。窗口 `capture` 若已被 unproven 清掉，保活在**下一次真实请求**后恢复（文案说明）。

文案（遵循语言政策：命令回执=紧凑英文 token，与同命令既有 notify 一致；经济类被清除时追加一段**中文散文**警示）：

- 有东西可清：
  `keepalive reset: cleared session-disabled(no-usage) · 2 line breaker(s) · counters zeroed · evidence(no-cache-value, current line only) · resumes on next real request`
  （各段按实际存在才出现；evidence 只清**当前线路**的 O3 记录，其它线路的 `no-cache-value` 不动，`/cache-ttl status` 同样按当前线路标注该 scope）
- 清除了 `provenWrites`（经济类）时追加第二行：
  `注意：已手动清除经济类熔断（proven-write）。若该线路 ping 仍会触发缓存写入，下一次写入会再次永久停用保活。`
- 无可清：`keepalive reset: nothing to clear (no breaker open)`（仍会把计数清零）
- 服务不可用：沿用现有 `keepalive service unavailable (no active session, or cacheTtl.keepalive=false)`（warning）。
- 只读/可变分类：`confirm`（§3.5）。

## 9. 与 provider evidence 层（`provider-evidence.ts`）的关系

| 项                            | 键                            | 作用域                                                       | 本改动后                                                                                         |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| O2 write1h 证据               | `provider+payload.model`      | 跨会话、30d                                                  | 不变                                                                                             |
| O3 `no-cache-value` 连败/熔断 | 同上                          | 跨会话；会话内 latch 进 `session.disabled`                   | 不变；`noteCacheRead`/`noteUsageCacheRead` 复位不变；新增仅「手动 reset 的 `resetNoCacheValue`」 |
| **线路熔断（本方案）**        | `provider+baseUrl+ctxModelId` | **仅会话内**（经 `subagent:cache-keepalive` 快照随 /reload） | 新增，**不写入 evidence 账本**                                                                   |

明确不做：不把 4xx 拒绝写进 evidence（跨会话记忆「这条线路 ping 被拒」会让『复位』失去意义，且需处理账号/密钥更换的失效问题）。
代价：新会话到 kimi 会再花 2 个 4xx ping 才熔断（零计费，可接受）。若后续要做，另立包（决策 D5）。
两层不会互相覆盖：线路熔断只挡 4xx；evidence 只挡「活跃但零读」；`resetBreakers` 是唯一同时碰二者的入口，且只清当前线路的 O3 记录。

## 10. 零卡死

- **无新定时器**。冷却 = 时刻比较，在 `noteRequestSettled`/`evaluateTick`/渲染时读 `clock.now()`。
- 复位后的 `syncExactTimer()`/`arm()` 复用现有 `clock.setTimer`（`systemClock` 已 unref；测试 `FakeClock`）。
- `resetBreakers` 同步完成，无 await；dispose 后 no-op。
- `lineStates` 容量 16 + 单项字段 clamp + sanitize 上限 ⇒ 快照体积有界；淘汰顺序：非 open 且 `updatedAt` 最旧 → 否则 open 中最旧（不淘汰 `"*"`）。
- 所有新增读回路径 try/catch 兜底（沿用 `readBackKeepaliveSessionState` 外层 catch ⇒ `undefined`）。

## 11. 测试计划

**T-S 状态机（`tests/cache-ttl/keepalive-state.test.ts`）**

1. `lineKeyOf`：同输入同键；baseUrl 大小写/尾斜杠/query 归一；不同 baseUrl/model/provider 不同键；provider 与 ctxModelId 皆空 ⇒ undefined；label 无 path。
2. 4.1 全表逐行（`it.each`）：瞬态路径不变；非瞬态 http 有线路 ⇒ 仅 `lineStates` 变、`session.disabled`/`nonTransient*` 不变；无线路 ⇒ 旧永久；`no-usage`/`proven-write` ⇒ 旧永久。
3. 4.2 生命周期矩阵：trips=1 立即复位；trips=2 冷却内不复位、冷却后复位；同状态码 `trips+1`；不同状态码 `trips=1`；>24h 遗忘；proven-hit 删除；瞬态打断 `consecutive`；他线路成功不复位；通配任意成功即复位；未变化返回同一引用。
4. `lineCooldownMs` 曲线 + 上限；`evaluateTick`：`line-disabled` 终局、仅命中线路、通配全线路、`session-disabled` 仍优先、他线路 capture 仍可 ping。
5. 容量淘汰：17 条 ⇒ 16，优先淘汰 closed 最旧，`"*"` 与 open 保留。
6. 属性测试（seeded，沿用既有风格）：任意事件序列下 `provenWrites>=1` 的会话 `onSuccessfulRealRequest` 永不让 `disabled` 清空；线路复位不会清 `trips` 以外的 session 级经济字段；不变量「open ⇒ openedAt 与 resetEligibleAt 存在」。
7. `resetAllBreakers`：清零集合 + 保留集合（`noCacheValueCounted`、审计累计）。
8. 渲染：`ping off:http 403 ·retry 25m`（线路形态无 `×N`）、`·t3`、当前线路非 open 时不显示、迁移/通配记录无状态码（`ping off:http`）、`session.disabled` 形态仍带 `×N`、多线路下线路形态不受 `session.pings` 影响、`renderKeepaliveReportLines` 线路行。
9. `formatMsShort` 单测：0/负数→`0m`；59_999→`<1m`；60_000→`1m`；25·60_000→`25m`；120·60_000→`120m`；121·60_000→`3h`；24h→`24h`；超大值不抛。
10. 通配路径：`lineKeyOf`⇒undefined 的 capture 连续两次 403 ⇒ `lineStates["*"].open`、`session.disabled` 不变；任意成功（含任意线路、route 未解析）即删除；`evaluateTick` 在 line 不可得且通配 open 时 `line-disabled`；`sameStatus` 用例：先 403 熔断复位再 401 熔断 ⇒ `trips===1`（钉住先比后写的顺序）。

**T-P 持久化（同文件 + `keepalive-lifecycle.test.ts`）**

1. 往返：含多条 `lineStates` 的快照 `readBack` 深相等。
2. 旧格式迁移三行（§6 表）：10/12 实际形状 `{reason:"http",at}` ⇒ 通配 open、`disabled` 空、`nonTransient*` 清零；带 `httpStatus:403`；`transient:true` 不迁移；`no-usage`/`proven-write` 不迁移。
3. 脏数据：`lineStates` 为数组/字符串/键 `__proto__`/非法数值/超 16 条 ⇒ 不抛、丢弃非法项。
4. 迁移幂等：迁移后 service 写 audit ⇒ 再 readBack 得到同一通配记录且不二次迁移。

**T-R reset 命令（`tests/cache-ttl/cache-ttl.test.ts` + lifecycle）**
`keepalive reset`：清会话级 + 线路 + 计数；文案三种（有/无/经济类警示）；服务不可用；补全含 `reset`；`resetBreakers` 后 audit `breaker-reset-manual` 的快照读回为空；evidence 当前线路 `no-cache-value` 被清且下一 tick 不再 latch；`/reload` 读回仍清空。
`tests/web-hub/agent/command-policy.test.ts`：`cache-ttl keepalive reset` ⇒ confirm。

**T-L 线路隔离与服务集成（`keepalive-lifecycle.test.ts`，`FakeClock` + 假 fetch）**

1. 复现 10/12：线路 A 两次 403 ⇒ `line-disabled`；切到线路 B（不同 provider）真实请求成功 ⇒ **B 的保活正常 ping**、A 仍 off；切回 A 并成功 ⇒ 立即复位并在当前窗口恢复 ping（验证复位后 `arm`/`syncExactTimer`）。
2. 退避：A 复位后再 2 次 403 ⇒ `trips=2`；冷却内成功 ⇒ 不复位且状态栏 `·retry`；`clock.advance(30m)` 后成功 ⇒ 复位；再被拒 ⇒ `trips=3`，冷却 1h；封顶 24h。
3. `resolveSettledLine` 分支：inflight 命中；`inflightLine` 存在但不匹配时**即使** ctx.model 匹配也不复位（models.json 改 baseUrl 场景）；`inflightLine===undefined` 且 ctx.model 匹配 ⇒ 复位；都不匹配 ⇒ 不复位且 `line-reset-skipped` 审计一次。
4. 失败/abort 的真实请求（`isSuccessfulRealRequest` false）不复位。
5. 同时存在瞬态 disabled + 线路 open：成功真实请求只复位瞬态 + 命中线路，不互相覆盖。
6. 零悬挂：整个场景结束 `clock.pendingTimers === 0`（dispose 后）；复位本身不新增 timer（对比前后 `pendingTimers`）。

**T-C 既有测试的同步修改（预期会红，需逐个确认语义而非机械改）**

- `keepalive-state.test.ts`：`classifies … other 4xx as permanent`（`nonTransientUnprovenTotal` 断言）、sibling 包新增的 `records the HTTP status on the disable`（permanent 403 分支）与 `drops an out-of-range HTTP status`、`I-K7: onRealRequest never resets or revives a disabled session` 用例保持（proven-write 仍永久）。4xx 分支的断言改为落在 `lineStates`；transient 503 分支保持。
- `keepalive-lifecycle.test.ts`：**仅**改「断言非瞬态 4xx ⇒ `session.disabled`」的用例；断言 proven-write / no-usage / 瞬态 408 的用例（含 `disabled.transient`、`httpStatus:408` 往返）**不需要改，不要动**。`keepalive-child.test.ts` 目前只断言 `unprovenKind === "http"`、无 disabled 断言，`child-keepalive.test.ts` 同理——条件式处理：若实施时发现有 4xx ⇒ `session.disabled` 断言才改为 `lineStates`。
- `createInitialSessionTotals()` 相关 `toEqual` 字面量补 `lineStates: {}`。
- `tests/fixtures/compact-hint-golden.json` **无关，不动**。

## 12. 实施顺序（建议拆 2 个提交）

1. **P1 纯状态机 + 读回/迁移 + 渲染**：`keepalive-state.ts`（类型/常量/`lineKeyOf`/reducer/evaluateTick/readBack/render）+ T-S/T-P。
2. **P2 服务接线 + 命令 + evidence 方法 + web policy**：`cache-keepalive.ts`、`cache-ttl.ts`、`provider-evidence.ts`、`command-policy.ts` + T-R/T-L/T-C。
3. 文档：plan.md §1 追加 `I-K7 amendment 2`（HTTP 4xx 线路化、可复位、退避；经济类仍永久）、§7.5 表脚注、AGENTS.md `src/cache-ttl/` 段补两句。

验收（真机，tmux，见 memory live-acceptance-tmux）：在含旧 `{reason:"http"}` 快照的会话上 `/reload` ⇒ 状态行应显示 `ping off:http`（迁移通配，无 ×N），发一条成功请求后消失并恢复 ping；`/cache-ttl keepalive reset` 回执。

## 13. 风险与回滚

| 风险                                                                                                                                                                                                                                                                     | 缓解                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.model` ≠ `ctx.model.id` ⇒ 永不复位（又回到「静默 off」）                                                                                                                                                                                                        | `resolveSettledLine` 优先用 `inflightLine`；失败有 `line-reset-skipped` 审计 + `/cache-ttl status` 可见 + `reset` 命令兜底；T-L3 钉住                                                                                                  |
| 4xx 实际并非零计费（某 relay 先扣费后拒）                                                                                                                                                                                                                                | 退避封顶 24h 限制频率；经济类（proven-write/no-usage）仍永久；plan §16 已把 4xx 列为「不可能被计费」                                                                                                                                   |
| 线路表被恶意/损坏快照撑爆或原型污染                                                                                                                                                                                                                                      | 键正则 + own-property + 容量 16 + 字段 clamp；sanitize 单测                                                                                                                                                                            |
| 迁移后通配熔断挡掉所有线路直到有成功请求                                                                                                                                                                                                                                 | 行为等价于旧版（本来就全挡），且首个成功真实请求即解除                                                                                                                                                                                 |
| 手动 reset 清 `provenWrites` 导致再烧一次写入                                                                                                                                                                                                                            | 仅用户显式命令 + confirm + 中文警示；最坏暴露 = 一次 ping 写入，随后重新永久                                                                                                                                                           |
| **迁移混合史残余**：旧 `nonTransient*` 混算 http 与 no-usage，旧快照 `reason:"http"` 的触发史可能含 no-usage（200 无 usage，属可能已计费类）；迁移后通配被任意成功删除且计数清零 ⇒ 保活恢复，最多再发 2–3 个 ping 才重新熔断，且若病因其实是 no-usage 这些 ping 可能计费 | **披露并接受（D7）**：上界 ≤2–3 个 ping 的保守估算成本；极罕见（需旧快照恰好为混合史）；自愈（重新熔断为会话级永久 no-usage，不再复位）。不做迁移时的 kind 判别（旧快照里只有 `lastUnproven.kind` 作弱线索，不完美，且增加迁移复杂度） |
| **通配回落的宽度**：`lineKeyOf`⇒undefined 的 4xx 熔断落通配，会挡所有线路，直到任意成功                                                                                                                                                                                  | 与旧版（会话级全挡）等价但可自动复位；通配无冷却，若该未知线路持续被拒则每个成功后重来一轮 2 个零计费 4xx，可忽略                                                                                                                      |
| 子会话行为改变                                                                                                                                                                                                                                                           | 单线路 run 下等价；T-C 覆盖；不改 child.ts                                                                                                                                                                                             |
| **回滚**                                                                                                                                                                                                                                                                 | 纯增量字段：`git revert` 两个提交即可；快照向旧版兼容（§6 末）；`lineStates` 缺省即旧行为。无设置项、无数据迁移落盘，无需回滚脚本                                                                                                      |

## 14. 需要用户拍板的项

| #   | 问题                                                                   | 推荐                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 首次线路熔断冷却是否为 0（成功即复位）；再熔断起 30m×2^(n-2)，封顶 24h | **0 起步 + 30m 基数 + 24h 封顶**（兑现「成功就重置」，同时压住 kimi 型循环）。**被否决备选：统一固定冷却**（如恒 30m）——结构更简单，但首次熔断也要等 30m 才能复位，违背「请求成功就重置」；且无法对反复被拒的线路持续降频，kimi 型循环每天多几个零计费 4xx。该备选此前仅被隐含排除、未单独评估，现补记 |
| D2  | `no-usage`（200 但无 usage/双 0）是否也线路化                          | **不线路化，维持会话级永久**（它是「语义/可能被计费」类，非『被拒』；可后续单独评估）                                                                                                                                                                                                                  |
| D3  | 退避判定「同状态码」：换状态码（401↔403 交替）是否重置 `trips`         | **按你的原话：同状态码才累加，换码 `trips=1`**（交替码极罕见，被拒零计费）                                                                                                                                                                                                                             |
| D4  | 手动 reset 是否连 `proven-write`（`provenWrites`）也清                 | **清，但 confirm + 中文警示**（你要「清除所有熔断」；最坏再烧一次写入）                                                                                                                                                                                                                                |
| D5  | 是否把「线路被拒」写进跨会话 evidence 账本                             | **不做**。原因：归因只能部分完成（旧审计条目无 provider 字段，需扫全分支才能回填）且判为不值得，并非「验证过不可行」；另见 §9（复位语义、账号/密钥更换失效）。新会话多花 2 个零计费 4xx                                                                                                                |
| D6  | `/cache-ttl keepalive reset` 在 web-hub 的策略                         | **confirm**（可变且能清经济类熔断）                                                                                                                                                                                                                                                                    |
| D7  | 旧快照迁移的混合史残余（§13）：不做迁移时的 kind 判别                  | **接受**（≤2–3 个保守上界计费 ping，罕见、自愈）                                                                                                                                                                                                                                                       |

## 用户摘要（5 行）

1. 熔断从「会话级永久」改为「**按线路（provider+baseUrl+model）记录**」的 4xx 拒绝熔断：只挡被拒的那条线路，别的线路照常保活。
2. **同线路**任意一次成功真实请求即复位（首次冷却 0）；复位后同状态码再被拒，冷却 30m→1h→…封顶 24h；状态行显示 `ping off:http 403 ·retry 25m`（线路形态无 ×N）。
3. `proven-write` / `no-usage` / `no-cache-value` / 费用闸等经济类熔断**保持永久**（`no-cache-value` 复位逻辑不变，不写入 evidence 的 4xx 记忆）。
4. 旧快照里的会话级 http 永久熔断读回即变成「未知线路可复位熔断」（下一次任意成功请求就解除），不会崩；线路不可得的 4xx 也落同一通配而非永久；子会话保活**不改**。
5. 新增 `/cache-ttl keepalive reset`（清当前会话全部熔断，含当前线路的 no-cache-value；web 端 confirm）；全程无新定时器，约 2 个提交 + 一批测试。

## 用户拍板（2026-10-14）

- D1 冷却曲线：首次复位冷却 0；同码再拒起 30m×2^(n-2)，封顶 24h（采纳推荐）。
- D2 `no-usage`：不线路化，保持会话级永久（采纳推荐）。
- D3 退避只对同状态码累加，换码重新从 1 算（采纳推荐）。
- D4 `/cache-ttl keepalive reset` 连 `provenWrites` 等经济类熔断一起清，确认框加中文警示（采纳推荐）。
- D5 不把「线路被拒」写进跨会话 evidence（采纳推荐）。
- D6 web-hub 中 reset 保持 confirm（采纳推荐）。
- D7 旧快照迁移混合史残余：接受（r2 评审追加；≤2–3 个保守上界计费 ping，罕见、自愈）。

## 修订记录 r2（响应 `breaker-recovery-review-r1.md`，glm-5.3「有条件通过」）

| 评审项                                                  | 处置                                                                                                                | 改动位置                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Major：`line===undefined` 的永久路径生产可达、无复位 | **采纳**：落通配 `"*"`（会话内任意成功即复位），仅 `no-usage`/`proven-write` 保持会话级永久；删除「仅单测可达」说法 | §2.1 末条；§3.1 `evaluateTick` 注释、`onUnproven` 通配条目、`onProvenHit`；§4.1 第 4 行；§6 末段；§11 T-S10；§13 新增「通配回落」行；摘要 4 |
| #2 Minor：迁移混合史残余                                | **采纳**：§13 披露（≤2–3 个保守上界计费 ping，罕见自愈），新增 D7 显式「接受」，不做 kind 判别                      | §6「混合史残余」；§13 迁移风险行；§14 D7；「用户拍板」D7                                                                                    |
| #3 Minor：线路 off 的 `×N` 跨线路误导                   | **采纳**：线路形态 `ping off:http 403 ·retry 25m`；`×N` 仅留在 session-disabled 形态                                | §7 状态行；§11 T-S8；§12 验收文案；摘要 2                                                                                                   |
| #4 Minor：分支 2 收紧                                   | **采纳**：仅 `inflightLine===undefined` 时用 ctx.model；存在但不匹配不兜底                                          | §2.2 `resolveSettledLine` 分支 2/3；§11 T-L3                                                                                                |
| #5 Nit：行号                                            | **采纳**：改为符号引用                                                                                              | §0、§2.1、§2.2、§3.3、§3.5、§3.6、§11 T-C                                                                                                   |
| #6 Nit：`formatDuration` 不存在于 keepalive-state       | **采纳**：本地 `formatMsShort`（ms→`25m`/`3h`，向上取整）+ 渲染单测                                                 | §7「时长 helper」；§11 T-S9                                                                                                                 |
| #7 Nit：D1/D5 备选记录                                  | **采纳**：D1 补「统一固定冷却」被否决备选及代价；D5 改写为「归因只能部分完成且不值得」                              | §14 D1/D5                                                                                                                                   |
| #8 Nit：`sameStatus` 伪码歧义                           | **采纳**：`rec` 为变更前快照，先比后写，禁止读 `next.status`；T-S10 钉住                                            | §3.1 `onUnproven` 步骤 1/3/4；§11 T-S10                                                                                                     |
| #9 Nit：evidence 回执 scope                             | **采纳**：回执写 `evidence(no-cache-value, current line only)` 并说明 `/cache-ttl status` 同样标注                  | §8 文案                                                                                                                                     |
| #10 Nit：T-C 区间过宽                                   | **采纳**：收窄为仅「非瞬态 4xx ⇒ `session.disabled`」用例，明列不要动的用例；child 测试保持条件式                   | §11 T-C                                                                                                                                     |

## 用户拍板 2026-10-20：no-usage 线路化、无冷却（推翻 D2）

用户裁决：`no-usage`（200 但无 usage / 双 0）熔断必须在 (a) 会话切换模型/线路、(b) 同线路真实请求成功 时恢复，**且无任何冷却**。
推翻 D2「no-usage 保持会话级永久」。实现口径：

- **线路级**：`SessionTotals.noUsageStates`（`Record<lineKey, LineState>`，与 HTTP 的 `lineStates` 分表，避免同线路两类计数/退避互相污染）。
  线路键沿用 `lineKeyOf`（provider+baseUrl+ctxModelId；不可得 ⇒ 通配 `"*"`）；阈值沿用 `UNPROVEN_STREAK_LIMIT`（连续）/
  `UNPROVEN_TOTAL_LIMIT`（累计）；瞬态失败打断 `consecutive`，该线路 proven-hit 删除未 open 记录。熔断打开时 `trips=1`、
  `resetEligibleAt=now`（无退避）。**不再**写 `session.disabled` / `nonTransient*`，故别的线路照常 ping；`evaluateTick` 新增终局 skip `line-no-usage`。
- **恢复（无冷却）**：`onSuccessfulRealRequest(..., { line, now, cacheUsage })`——仅当该次成功真实响应本身报告了缓存用量
  （`cacheRead>0 || cacheWrite>0`，`realRequestReportedCacheUsage`，由 `cache-ttl.ts` 的 `message_end`/`turn_end` 经
  `noteRequestSettled` 第 6 参传入）才立即删除同线路（或通配）no-usage 记录；成功但无用量 ⇒ 保持熔断（返回同一引用）。
  切到别的线路 ⇒ 该线路无记录 ⇒ 恢复 ping；切回 ⇒ 仍熔断，直到那里一次带用量的真实成功。恢复后服务 `syncExactTimer()+arm()` 重新武装当前窗口（与 HTTP 线路复位同路径，审计 `line-reset`）。
- **不变**：`proven-write` 仍是永久会话级禁用（`provenWrites`/`disabled`）；evidence `no-cache-value` 熔断不变；HTTP 线路熔断的冷却/退避不变。
- **迁移**：旧快照 `disabled{reason:"no-usage"}`（永久）读回时迁移为通配 no-usage 熔断（`trips=1`，清零 `nonTransient*`），下一次带用量的真实成功即解除；迁移幂等（新代码永不再写 `disabled.reason==="no-usage"`）。`/cache-ttl keepalive reset` 同时清空 `noUsageStates`（计入 summary.openLines）。
- **展示**：当前线路（或通配）no-usage 打开 ⇒ 状态栏 `ping off:no-usage`（`PingSegmentState` 仍为 `line-off`，无 `·retry`/`·tN`）；
  `/cache-ttl status` 增行 `line off: <label> · no-usage · per-line, lifts on the next real response that reports cache usage (no cooldown)`。
- **已披露残余**：(1) no-usage 的 200 响应可能已计费（与 4xx 不同），线路化后每条线路最多再花 2–3 个 ping 才熔断，且每次带用量的真实成功后会重新计数——这是用户明确接受的取舍；
  (2) web-hub 的 `lineRows` 线路列表暂不展示 no-usage 行（线路 wire 无 reason 字段，append-only 契约未改），仅通过状态段 `ping off:no-usage` 可见。

## 用户拍板 2026-10-20（二）：proven-write 线路化、无冷却（推翻「proven-write 仍永久会话级」）

现场：cr-anthropic/claude-opus-5-5（cloudrouter）连续 19 次 hit，距上次真实请求 4 分钟的一次 ping 缓存已失效（read 0 / write 186k）⇒ 整个会话被永久停用保活。用户裁决：`proven-write` 不得再会话永久；与 no-usage 同构（见上一节），但**首次即熔断**、恢复条件更宽。

- **线路级、首次即开**：`SessionTotals.provenWriteStates`（`Record<lineKey, LineState>`，独立于 `lineStates`/`noUsageStates`，同线路三类熔断互不污染计数/恢复条件；「reason」由所在 map 体现，未给 `LineState` 加字段）。线路键 `lineKeyOf`（不可得 ⇒ 通配 `"*"`）；`onUnproven("proven-write")` 立即写 `open:true, trips:1, resetEligibleAt=now`（无阈值——每多一次 ping 都会再付一次整段写入）。**不再**写 `session.disabled` / `nonTransient*`，别的线路照常 ping；`evaluateTick` 新增终局 skip `line-proven-write`（#3.7）。`provenWrites` 保留为单调统计量，**不再参与** `permanent` / `isPermanentThresholdMet` 判定（否则旧快照的非零值会让之后任何非线路类失败变成永久）。
- **恢复（无冷却）**：`onSuccessfulRealRequest` 中任意一次成功真实请求只要线路一致（或熔断在通配）就立即删除记录——**不要求带缓存用量**（真实请求本身重建缓存；这是与 no-usage 的有意区别）。失败请求/无 options 不恢复（返回原引用）。切到别的线路 ⇒ 该线路无记录 ⇒ 恢复 ping；切回 ⇒ 仍熔断，直到那里一次成功真实请求。服务层沿用 `line-reset` 审计 + `syncExactTimer()+arm()` 重新武装。纯函数 `clearProvenWriteLine` 单独导出。
- **子会话**：子会话服务不开 `recoverTransientFailures`（其余熔断仍不恢复，行为不变）；`noteRequestSettled` 在非恢复分支里**仅**对 proven-write 调 `clearProvenWriteLine`，`child.ts` 的 `message_end/turn_end` 现传 `isSuccessfulRealRequest`/`realRequestReportedCacheUsage`（此前恒传 false）。副作用（已知、接受）：子会话里「成功但无缓存用量」的真实响应现在也会清除 late-usage 学习的 pending，与主会话一致。
- **迁移**：旧快照 `disabled{reason:"proven-write"}` 读回时迁移为通配 proven-write 熔断（`trips=1`，清零 `nonTransient*`），下一次成功真实请求即解除；幂等（新代码永不再写该 reason）。`/cache-ttl keepalive reset` 同时清空 `provenWriteStates`（计入 `openLines`，并置 `economicCleared`；`economicCleared` 现按「有开着的 proven-write 熔断或旧式 session 级 proven-write」判定，不再看单调的 `provenWrites`）；reset 文案改为「该线路下一次真实请求成功或切换模型后恢复」。
- **展示**：当前线路（或通配）proven-write 打开 ⇒ `ping off:proven-write`（`line-off`，优先级 http > proven-write > no-usage，无 `·retry`/`·tN`）；`/cache-ttl status` 增行 `line off: <label> · proven-write · per-line, lifts on the next successful real request on this line or a model switch (no cooldown)`；header note 改为「stops on this line … resumes after the next successful real request on it」。web 面板：`lastPing.line:true`（proven-write/no-usage，append-only 可选字段，schema `additionalProperties` 本就开放）⇒ chip 「线路级 / per-line」，不再显示「永久」；`lines[]` 行列表不展示 proven-write（与 no-usage 同，沿用上一节披露残余 (2)，仅通过 `ping off:proven-write` 状态段可见）；投影的静默判定加入 `provenWriteStates`。
- **已披露残余**：(1) 仍会付一次整段写入才熔断（首次即开已是最小代价）；(2) 熔断期间同线路不再 ping，窗口过期后缓存自然冷，下一次真实请求照常付写入——与不保活等价；(3) 同线路若真实请求持续失败则一直不恢复（需一次成功响应）。
