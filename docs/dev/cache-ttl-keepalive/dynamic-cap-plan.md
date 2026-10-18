# 动态每窗口 ping 上限（取代 `cacheTtl.keepaliveMaxPings`）— L2 实施计划

状态：计划（2026-10-18），用户已拍板的裁决见 §0。承接 `plan.md` §0.3 / §6.2（11 次 = `0.1n+0.1<1.25` ⇒ n<11.5；
Fable read 0.025× ⇒ 48）。本计划只改「每窗口 ping 次数硬顶」的**来源**，门 #14 的判定、窗口/熔断/子会话其它限额不动。

## 0. 裁决（final）与本计划的取舍

1. `cap = floor((W−R)/R)`，W=5m 缓存写价、R=缓存读价（$/M），取**该窗口捕获请求所用模型**的价格（pi 模型注册表，含 models.json 自定义价）；
   恰好整除（`W/R` 为整数）⇒ 等号不盈利 ⇒ 减 1；模型/线路变化即重算。
2. 价格不可用（无 cost、R≤0、W≤R、非有限）⇒ 回退 **11**（标准 Anthropic 比值），`/cache-ttl status` 标明来源。
3. **彻底删除设置** `cacheTtl.keepaliveMaxPings`；文件里已有的该键被忽略并提示；关保活仍是 `keepalive:false`。
4. 子会话每窗口上限同公式；其余子会话限额（24/run、并发 4、$1.5/run、$10/24h）不变。

## 1. 价格来源与公式

- **来源 = `ctx.model.cost`**（pi `Model.cost`，已含 models.json 覆盖/`tiers`）。服务层已经这样取价：`childPingGate`
  与 `report()` 都读 `safeModel()?.cost`，不新增注册表访问。`cacheWrite` 是**短（5m）写价**（pi-ai `calculateCost`：
  `rates.cacheWrite*shortWrite + rates.input*2*longWrite`），正是 ping 路径的写价（ping 对 1h 捕获会 strip ttl ⇒ 5m）。
- **“实际模型” = 门 #14 时的 `ctx.model`**：门 #9 的 fingerprint 比较含 `provider/api/ctxModelId/baseUrl`，漂移即 `invalidate`，
  所以走到 #14 时 `ctx.model` 与 `capture.fingerprint` 同一线路；model 切换 ⇒ 下一次 tick 自然按新价重算（无需缓存失效逻辑）。
- **分档价**：按 `capture.prefix.tokens`（实测下界）走与 `cacheReadCostUsd` 同一套 `tieredRate`；无 capture（status 空窗口）用 tokens=0 ⇒ 基础档。
- **公式（纯函数）**：令 `q=W/R`。盈利条件 `n·R + R < W` ⇔ `n < q−1` ⇒ `cap = ceil(q) − 2`（q 非整数时等于 `floor(q−1)`；q 整数时自动减 1）。
  浮点：`r=Math.round(q)`，若 `|q−r| ≤ 1e-9·max(1,q)` 视为整数，用 `r−2`，否则 `ceil(q)−2`（防 `1.25/0.025=50.00000000000001`）。
- 回退条件（`source:"fallback"`，`cap=11`）：`cost` 缺失 / `R` 或 `W` 不是有限正数 / `W ≤ R`。`cap` 计算结果 ≤0（`W/R ≤ 2`，如 W=2R）
  ⇒ 仍是 `priced`、`cap=0`（价格表明 ping 永不回本 ⇒ 门 #14 首 tick 即 `budget-exhausted`，诚实地不 ping；推荐，见 §8-D3）。
- 验证向量：3.75/0.3→11；6.25/0.5→11；25/2→11；1.25/0.1(Anthropic 比)→11；Fable 1.25/0.025→**48**；W=3R→1；W=12R→10；W=13R→11；W=2R→0。

## 2. 文件级改动

### 2.1 `src/cache-ttl/keepalive-state.ts`（pi-free 核心）

- 新增导出：`FALLBACK_WINDOW_CAP = 11`；`cacheReadRate(cost, tokens)`/`cacheWriteRate(cost, tokens)`（$/M，复用 `tieredRate`，**无** `tokens>0` 限制，与 `cacheReadCostUsd` 的 `undefined`-而非-0 语义一致）；
  `computeWindowCap(cost, prefixTokens): { cap: number; source: "priced" | "fallback"; reason?: "no-cost"|"no-read"|"no-write"|"write-le-read"|"non-finite" }`。
- `KeepaliveConfig` 保留 `maxPings: number`（evaluateTick #14、`pingSegmentParts`、`renderKeepaliveReportLines`、web 投影全部继续读它，**逻辑零改动**），
  增可选 `maxPingsSource?: "priced" | "fallback"`（缺省 ⇒ 不显示来源，旧测试夹具不变）、`maxPingsReason?`（仅审计）。
- `renderKeepaliveReportLines`：第 2 行 `cap: ${maxPings}/window` 后追加来源——`(priced)` / `(fallback: unpriced)`；第 4 行 `window: n/max` 不变。
  状态栏 `ping n/max`、`ping n/max capped` **不变**（短标记不带来源，遵守 UI 文本约定）。

### 2.2 `src/service/cache-keepalive.ts`

- `config()`（L365）：`maxPings: s.keepaliveMaxPings` → `const c = this.deps.capOverride ?? computeWindowCap(this.safeModel()?.cost, this.window.capture?.prefix.tokens ?? 0)`，
  写入 `maxPings: c.cap, maxPingsSource: c.source, …`。`onTick`/`report()` 均走 `config()`，无需别处改。
- `CacheKeepaliveDeps` 增**仅测试用**可选 `capOverride?: { cap: number; source: … }`（stack.ts / child.ts **不传**；注释写明）——用来保住现有「cap=1/1000」的测试，不让测试被迫伪造价格。
- `auditTerminalSkipOnce`：reason 为 `budget-exhausted` 时 audit 数据附 `cap`/`capSource`（可选字段，追加式）。
- 子会话零额外代码：`src/cache-ttl/child.ts` 用同一 `createCacheKeepaliveService`，`config()` 自动动态；`child-registry.ts`、`ping-ledger.ts` 不改。
  仅更新 `child.ts` 注释里“窗口上限 11”字样（如有）。`childPingGate` 的 `usd-unpriced`（R 缺失 ⇒ 终局不 ping）先于回退生效，所以子会话**只有 W 缺失**时才会走 fallback=11。
- 子会话上界关系：`maxSessionPings`(24/run) 与 `$1.5/run` 在 Fable 型 cap=48 时先于窗口上限绑定——预期且无害。

### 2.3 设置层（彻底删除）

- `src/config/settings.ts`：删 `CacheTtlSettings.keepaliveMaxPings`（L369）、`DEFAULT_SETTINGS.cacheTtl.keepaliveMaxPings`（L1101）、`parseCacheTtlSettings` 里的解析（L1623）。
  `parseCacheTtlSettings` 新增**只读迁移**：原始 `value.keepaliveMaxPings` 存在时，结果上加可选 `legacyKeepaliveMaxPings?: number`（有限数才记；
  仅条件展开，缺省时键不存在 ⇒ `toEqual(DEFAULT_SETTINGS.cacheTtl)` 不变；永不回写文件，`persistSettingOverride` 按路径改 raw，不受影响）。
  迁移 0 → 关闭：`keepalive: legacy===0 ? false : bool(...)`（决策点 D1，推荐方案）。
- `src/config/setting-specs.ts` L723：删除 `"cacheTtl.keepaliveMaxPings"` spec（TUI 编辑器按 SETTING_SPECS 渲染，随之消失）。
- 不写入、不自动删除用户文件里的旧键（settings.json 属用户）；不再 `console.warn`（解析会在父/子会话反复执行，会刷屏）。

### 2.4 `src/cache-ttl/cache-ttl.ts`（`/cache-ttl status` + 提示）

- `wireCacheTtl` 已持有完整 `AgentSettings`：加纯函数 `legacyCapNotes(settings.cacheTtl)`：
  - 旧值 `>0`：`note: cacheTtl.keepaliveMaxPings=N is deprecated and ignored — the per-window cap is now derived from the model's cache prices (see "cap:" above); remove it from settings.json`
  - 旧值 `0`：`note: legacy cacheTtl.keepaliveMaxPings=0 was treated as keepalive=false; set "cacheTtl.keepalive": false and remove the old key`
- `status` 分支：把 notes 追加在 `renderKeepaliveReportLines` 之后；服务不存在（含 legacy-0 ⇒ keepalive 关）时，notes 仍随「service unavailable」一起展示（此时 notes 是用户唯一能看到原因的地方）。
- “一次性”提示：`session_start` 里用 wiring 闭包标志 `legacyNoted`，每次 activate 最多 `ctx.ui.notify` 一次（TUI/rpc，print/子会话不发）；status 中则只要旧键还在就常驻。

### 2.5 Web 线（追加式，无 proto 升级）

- `src/web-hub/agent/cache-keepalive.ts` L102：`window.max` 现读 `report.config.maxPings`，**自动变动态**，无需改；追加 `window.maxSource?: "priced"|"fallback"`（仅当 `maxPingsSource` 有值）。
- `src/web-hub/protocol/messages.ts`：`CacheKeepaliveWire.window` 加可选 `maxSource?: string`；schema L1383 `window` 已 `additionalProperties:true`，补一个 `Type.Optional(Type.String())` 即可；旧 UI 忽略、旧 agent 不发，字节预算影响 <30B。
- `CacheKeepalivePanel.vue` L134 `windowText` 保持 `n/max`；仅给该 token 加 `title`（`fallback` 时 “cap fallback: model unpriced”）—— 可选，不动布局。`cacheKeepaliveView.ts` 不改。

### 2.6 文档

- `docs/guide/context.md` L31：删「`keepaliveMaxPings`=11」，改「单窗口 ping 上限按模型缓存价自动推算（`floor((写价−读价)/读价)`，Anthropic 比值 = 11，Fable = 48；无价格回退 11）」；加弃用说明。
- `AGENTS.md`（src/cache-ttl 段：「limits 11/window · 24/run…」）改为「dynamic per-window cap (price-derived, fallback 11) · 24/run …」；`plan.md` §6.2 与设置表（L993）追加一条「2026-10-18 被 dynamic-cap-plan 取代」的 supersede 注记（不改历史正文）；
  `webhub-plan.md` L239、`child-context-switch/plan.md` 同样只追加注记。CHANGELOG 不碰（发版脚本生成）。

## 3. 状态 / 遥测 / Web 线汇总

| 面                                     | 变化                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| 状态栏 `ping n/max[ capped]`           | 文本格式不变，max 为动态值                                                    |
| `/cache-ttl status`                    | `cap: 48/window (priced)` / `cap: 11/window (fallback: unpriced)`；+弃用 note |
| 子会话审计 `terminal-skip`             | `budget-exhausted` 时追加 `cap`/`capSource`（可选字段）                       |
| Web `StatusInfo.cacheKeepalive.window` | `max` 自动动态；追加可选 `maxSource`                                          |

## 4. 设置迁移

旧键一律忽略（不回写）。`>0`：被忽略并提示——**注意这是行为变化**：曾把上限调低(如 3)来省钱的用户现在会拿到价格推导的上限（≤ 一次写入的损失，见 §6 论证）。
`=0`：见 D1。`keepaliveMaxPings` 的 `0` 此前不会让 service 缺席（仍 capture、不 ping）；迁移为 `keepalive:false` 后 service 缺席（子会话同样不注册）——可见效果等价（不 ping），差别仅 breaker/evidence 记账与 status 文案，可接受。

## 5. 测试清单

**新增**：`tests/cache-ttl/keepalive-cap.test.ts`——§1 全部验证向量；浮点整除；分档价（>阈值切档、tier 缺 cacheWrite ⇒ fallback）；回退各分支（undefined/R=0/W≤R/NaN/Infinity/负数/字符串）；W≤2R ⇒ 0；property：`cap*R+R<W` 且 `(cap+1)*R+R>=W`（随机价格，eps 内）。
**服务层**：`keepalive-lifecycle`——换模型（价格不同）后 `config().maxPings` 重算、window 漂移 invalidate；无 cost ⇒ 11/`fallback`；cost 触发 cap=48 时第 12 次仍 ping、第 49 次 `budget-exhausted`；`capOverride` 优先。
**子会话**：`tests/integration/child-keepalive.test.ts` L327 用例改名/断言（`fakeCtx` 价 3.75/0.3 ⇒ 仍 11，保住原 `toHaveBeenCalledTimes(11)`），删除 `DEFAULT_SETTINGS…keepaliveMaxPings` 断言；L368 `keepaliveMaxPings:100` 改 `capOverride`/高 W÷R 价；增 Fable 价子会话：窗口 48 但 24/run 先绑。`keepalive-child.test.ts`：L699/L766（1000）→ `capOverride`；L888（1）→ W=3R 的 cost。
**设置**：`tests/config/cache-ttl-settings.test.ts`——defaults/`toEqual` 去掉该键；删 SETTING_SPECS 断言并反向断言「不存在」；legacy：`{keepaliveMaxPings:5}` ⇒ `legacyKeepaliveMaxPings:5`、不影响其它；`{keepaliveMaxPings:0}` ⇒ `keepalive:false`；`{keepaliveMaxPings:-1}`/非数 ⇒ 忽略；无旧键 ⇒ 字段缺省。
**需机械改动的夹具**（删字段 `keepaliveMaxPings: 11`）：`keepalive-breaker/child/evidence/lifecycle/ping-retry`、`probe.test.ts:196`、`integration/cache-keepalive.test.ts:130`、`integration/cache-ttl-removal.test.ts:123`（`keepaliveMaxPings:1` ⇒ `capOverride`）。
**将变化的钉死文本**：仅 `renderKeepaliveReportLines` 的 `cap:` 行（带来源后缀；无 `maxPingsSource` 的夹具保持旧文本，所以 `keepalive-breaker/state` 的 `mkReport` 系列与 `ping 3/11 Σ12…`、`ping 11/11 capped` 全部不变）；`cache-keepalive-projection`/`wiring-cache-keepalive`（`maxPings:11` 夹具）不变，增加一例 `maxSource` 透传；`cache-keepalive-view`（UI）不变。
**/cache-ttl**：`status` 含 `cap: … (priced|fallback: unpriced)`；弃用 note 三态（>0/0/无）；服务缺席时 notes 仍显示。
全量：`format:check → typecheck → test → build`；`npm run test:conformance` 非必需（不动 pi 边界）。

## 6. 大 cap 是否需要其它约束（推荐，不决定）

- **经济论证**：cap 的定义使一个窗口的 ping 总花费 ≤ ≈ 一次 5m 写入（`n·R+R<W`）。即便用户一去不回，最坏损失 = 一次本来就会发生的 miss 的价格——所以 48 次（≈3.2h）在 $ 上与 11 次同量级（相对 P）。
- **仍可能想要的约束**：(a) 绝对 $ 上限——对 1M 前缀 × 贵模型，单窗口绝对值也可观，但这与 11 次时同理且主会话无此限，不新增；(b) **垃圾价格防护**：自定义 models.json 里把 R 写成极小（如 0.0001 ⇒ cap≈万级）——**推荐加一个不可配置的哨兵上限**（建议 96，≈6.4h，仅防误填；`maxPingsSource` 仍 `priced`，status 可标 `clamped`）；(c) 墙钟上限——不推荐：会重新引入第二个旋钮，且 I-K7 熔断、#13 存活期门、真实请求重开窗口已覆盖异常。
- 订阅制（OAuth）用户：价格比值同美元计费口径，额度消耗按同样比例，不另设。

## 7. 车道 / 打包 / 风险

- **L2，单个 dev 包**（核心 + 服务 + 设置 + status + web 线 + 文档 + 测试，彼此强耦合、改动面 ≈ 10 个 src 文件 + ~14 个测试文件）；验收者 ≠ 开发者模型；`format:check/typecheck/test/build` 全绿后精确路径 commit。无需 consult/并行。
- 风险：①测试夹具里 `cost` 缺 `cacheWrite`（lifecycle 用 `{cacheRead:0.3,tiers:[]}`）⇒ fallback 11，行为恰好不变；②`tieredRate` 对“tier 只给 cacheRead”的混合取价——统一要求成对，否则 fallback；
  ③`ctx.model` getter 会抛（dispose 路径）：沿用 `safeModel()`，抛则 fallback 且 dispose，不新增崩溃面；④Fable 型 cap 增大后 `window.pings` 持久化/审计字段无上限假设——已核对 `WindowState.pings` 为纯计数；⑤旧键用户行为变化（§4）需在 status/指南明示。

## 8. 决策点（需用户确认，附推荐）

- **D1 旧 `keepaliveMaxPings: 0`**：推荐**一次性迁移为 `keepalive:false`**（保持其原“不 ping”意图，并提示用户改写成 `keepalive:false`）；备选「忽略 ⇒ 保活开启」会让显式想关的用户被悄悄打开并产生计费，不推荐。
- **D2 哨兵上限 96**：推荐加（§6-b）；不加也可，但自定义价格误填无兜底。
- **D3 cap=0（W≤2R，priced）**：推荐保留 0（不 ping，status 显示 `cap: 0/window (priced)`），而非夹到 1。
- **D4 `capOverride` 测试缝**：推荐保留（仅 deps、不进 settings/stack）；备选是全部测试改用价格构造 cap（1000 型用例不可行）。

## 用户裁定（2026-10-18，回应 §8）

- **D1 旧 `keepaliveMaxPings: 0`：同样忽略**（不迁移为 `keepalive:false`）。与其它旧值一样只在 `/cache-ttl status` 提示「已废弃并忽略」；想关保活的用户需改用 `"cacheTtl.keepalive": false`。⇒ 删除 §2.3 的 `legacy===0 ? false` 迁移，§2.4 的 note 合并为一种文案（不区分 0 与 >0）。
- **D2 哨兵上限：加，固定 96**（不可配置；正常定价的模型——Anthropic 11、Fable 48——碰不到；触顶时 status 标 `clamped`）。
- **D3 cap = 0（W ≤ 2R）：保留 0，不 ping**，status 显示 `cap: 0/window (priced)`。
- **D4 `capOverride` 测试缝**：主会话决定保留（仅 deps，stack/child 不传）。
