# 动态每窗口 ping 上限（取代 `cacheTtl.keepaliveMaxPings`）— L2 实施计划（r1，评审后修订）

状态：计划 r1（2026-10-18；评审 `r_CBEFCMCD` verdict=revise 已逐条处理，见 §R1）。承接 `plan.md` §0.3 / §6.2。
本计划只改「每窗口 ping 次数硬顶」的**来源**；门 #14 判定、窗口/熔断/子会话其它限额不动。

## 0. 裁决（final，含 §10 用户裁定与主会话裁定）

1. `cap = floor((W−R)/R)`（公式是用户的，不改），W=5m 写价、R=读价（$/M），取**被捕获请求实际使用的模型**的价；整除（等号）⇒ 不盈利 ⇒ 减 1；模型/线路变化即重算。
2. 价格不可用 ⇒ 回退 **11**（标准 Anthropic 比值；**回退值没有任何盈利性证明**，只是历史默认）。
3. **彻底删除设置** `cacheTtl.keepaliveMaxPings`；文件里的旧键**一律忽略**（含 `0`），只在 `/cache-ttl status` 提示；关保活只用 `"cacheTtl.keepalive": false`。
4. 固定哨兵上限 **96**（不可配置）；触顶来源标 `clamped`，不是 `priced`。cap=0（R<W≤2R）保留。**不设 `capOverride` 测试缝**，测试用价格夹具造 cap。
5. 子会话每窗口上限同公式；24/run、并发 4、$1.5/run、$10/24h 不变。

## 1. 价格来源与公式

### 1.1 用哪个模型（评审 #2）

`evaluateTick` 门 #9 比较的是 `ctxModelId`（`ctx.model.id`），**不比** payload 的线上 `modelId`（`tests/cache-ttl/keepalive-state.test.ts:848-862` 就构造了 ctx=A/payload=B）。
所以 `ctx.model.cost` **不能**当作被捕获请求的价。改为按**捕获请求的身份**解析：

- `resolveCapModel(registry, fp)`：`registry.find(fp.provider, fp.modelId)`（`fp = capture.fingerprint`，`modelId = payload.model`，`provider/api/baseUrl` 为捕获时 ctx 值；`ctx.modelRegistry.find` 是 pi 公开 API，已含 models.json 覆盖）。
  **要求同时满足**：命中 && `model.api === fp.api` && `model.baseUrl === fp.baseUrl`；否则 `fallback`（reason `wire-model-unmapped`，含：registry 缺 `find`/抛错、线上 id 未注册、api/baseUrl 不一致、线上 id 与 ctx id 不同且按 id 找不到）。线上 id 与 ctx id 不同但**精确命中**已定价模型 ⇒ 用命中项的价（确定）。
- 无 capture（status 空窗口/刚 invalidate）：用 `ctx.model` 的 `(provider,id)` 走**同一解析**（modelId=ctx.model.id），显示的是「若此刻开窗的上限」。
- 结果按 `capture` 对象身份 memo（`WeakMap`/单槽），避免 `config()` 每次都扫 registry；新请求重捕获即重算；`models.json` 热变更不追溯进行中的窗口（可接受，窗口最长 ≈ 96×4min）。
- 假设（写入注释+测试）：pi 的 anthropic 路径 `payload.model === model.id`；不满足的线路按上条落回 fallback，不猜。

### 1.2 分档（评审 #3）

pi-ai `calculateCost` 用 `usage.input+cacheRead+cacheWrite`（该次请求**总输入**）选**整档**费率，并整体替换 `rates`（档里没写的字段 = undefined，不回落基础价）。
`capture.prefix.tokens = cacheRead+cacheWrite`（上一次响应，**不含**未缓存 `input`，只是总输入的下界 L）。规则：

- 一次只选**一档**：无 `tiers`/空 ⇒ 基础档 `{cacheRead,cacheWrite}`；否则取「`inputTokensAbove` 严格小于 L 的最大者」，**W、R 都取自该档**，禁止与基础字段混用；该档任一值缺失/非有限 ⇒ `fallback`（reason `tier-incomplete`）。
- **档不可确定** ⇒ `fallback`（reason `tier-uncertain`）：①窗口有 capture 但 `prefix.source!=="usage"` 或 L 非有限；②存在阈值 t 满足 `L ≤ t < L + TIER_GUARD_TOKENS`（8192，覆盖未缓存尾部/新增消息的合理上界，真实总输入可能跨过 t）。
  残留风险（披露）：L 是下界，尾部极大时真实档可能更高；此时 cap 以低档价算出，偏差有界于两档比值之差，且回退/哨兵上限仍在。无 capture 时 L=0 ⇒ 基础档。
- 新增导出 `pickRateTier(cost, L)`；**不改** `cacheReadCostUsd`/`cacheWriteCostUsd`（它们服务于 $ 计费，口径不同）。

### 1.3 公式与数值（评审 #5）

顺序固定：**计算 → 校验 → 钳位**。令 `q=W/R`：

1. 前置：`R,W` 为有限正数且 `W>R`，否则 `fallback`（`no-cost`/`no-read`/`no-write`/`write-le-read`，R≤0、NaN、Infinity、字符串都归此）。
2. `q` 必须有限（R 为次正规数时 `W/R` 溢出 Infinity ⇒ `fallback` `non-finite`）。
3. 整数判定容差为**几个 ULP**：`r=Math.round(q)`，`|q−r| ≤ 4·Number.EPSILON·max(1,|q|)` ⇒ 视为整数 ⇒ `raw=r−2`；否则 `raw=Math.ceil(q)−2`。
   （`W=2.000000001,R=1` ⇒ `q−2=1e-9 ≫ 4ULP` ⇒ raw=1；`1.25/0.025=50.00000000000001` ⇒ 50 ⇒ 48。不再用 1e-9。）
4. `raw` 必须有限（q 极大但有限时 `raw` 仍有限，可超 `MAX_SAFE_INTEGER`，不精确也无妨——下一步必被钳位）。
5. **钳位**：`raw > 96` ⇒ `cap=96, source:"clamped", rawCap=raw`；否则 `cap=raw, source:"priced"`。

- 合法 cap=0 区间：`R < W ≤ 2R`（`q∈(1,2]` ⇒ `ceil−2=0`）；`W≤R` 不是 0 而是 fallback。
- 返回 `WindowCap { cap; source:"priced"|"clamped"|"fallback"; rawCap?; reason? }`；`FALLBACK_WINDOW_CAP=11`、`WINDOW_CAP_CEILING=96`。
- 验证值：3.75/0.3→11；6.25/0.5→11；25/2→11；1.25/0.1→11；Fable 1.25/0.025→**48**；W=(N+2)R→N（N≤96）；W=2R→0；W=2R+ε→1；W=100R→96 clamped。

### 1.4 保证的是什么（评审 #4，删除总成本保证）

`n·R+R<W`（乘以 P）**只比较缓存前缀 P 的读/写预算**：它不含每次请求的未缓存 `input`、输出 token（ping 在无 thinking 时 `max_tokens=1`，**有 thinking 时保留原 `max_tokens`**，输出可能被计费），也不含最终真实请求自身的尾部。
因此**不再声称**「窗口最坏损失 ≤ 一次写入」。cap 是前缀预算上限；回退 11 **没有盈利性证明**（价格未知，仅沿用历史默认）。文档/指南/注释一律按此措辞。

## 2. 文件级改动

### 2.1 `src/cache-ttl/keepalive-state.ts`（pi-free）

- 新增 `pickRateTier`、`computeWindowCap(cost, prefix, ...)`（§1.2/§1.3）、常量；`resolveCapModel` 放在服务层（需 registry）。
- `KeepaliveConfig` 保留 `maxPings`（门 #14、状态文本、web 投影继续读它）；增可选 `maxPingsSource?: "priced"|"clamped"|"fallback"`、`maxPingsRaw?`、`maxPingsReason?`（缺省 ⇒ 旧夹具文本不变）。
- `renderKeepaliveReportLines` 第 2 行：`cap: 48/window (priced)` / `cap: 96/window (clamped from 2000)`（rawCap 非安全整数时只写 `clamped`）/ `cap: 11/window (fallback: unpriced)`（reason 不进文本，进审计）。
- **模型切换后的展示（评审 #6）**：窗口在 #9 漂移 invalidate 后 `capture===undefined` 但 `window.pings` 仍是旧值，而 cap 已按新模型重算，会出现 `20/11 capped`。规则：`pingSegmentParts` 的 `capped` 分支与 active 分支的 `n/max` 只在 `window.capture!==undefined` 时使用；`capture===undefined` 且无 `lastStopReason` ⇒ 视为**窗口已结束**，只显示累计 `ping Σ{session.pings} · {read} · {cost}`（无 `n/max`）；`/cache-ttl status` 的 `window:` 行同样写 `window: ended (Σ20 pings)`。
  **不声称窗口持久化**：窗口/capture 不随 reload 恢复（只有 session 级 breaker 状态恢复），故无「旧窗口 pings 与新 cap」跨重载问题。

### 2.2 `src/service/cache-keepalive.ts`

- `config()`（L365）：`maxPings: s.keepaliveMaxPings` → `computeWindowCap(resolveCapModel(this.deps.ctx.modelRegistry, fpOf(this.window.capture) ?? fpOfCtxModel())?.cost, capture?.prefix)`，写入 `maxPings/maxPingsSource/Raw/Reason`（memo，见 §1.1）。`safeModel()`/registry 访问全 try/catch，抛 ⇒ fallback，不新增崩溃面。
- **调用顺序（评审 #8 更正）**：`onTick` 里 `config()` **先**算出 cap 并交给 `evaluateTick`（门 #14 用它）；`childPingGate`（unpriced → run 预算 → ledger）**只在 `evaluateTick` 已判 `ping` 之后**才运行，且读 `ctx.model.cost` 的 **R**（`usd-unpriced` 判据不变）。cap 的 fallback 与 `usd-unpriced` 互不替代。
- `auditTerminalSkipOnce`：`budget-exhausted` 时 audit 附 `cap/capSource/capRaw`（可选追加字段）。
- 不加 `capOverride`。`child.ts`/`child-registry.ts`/`ping-ledger.ts` 逻辑不改，只改 `child.ts` 注释里的「每窗口 11」。

### 2.3 设置层（彻底删除，评审 #1）

- `src/config/settings.ts`：删 `CacheTtlSettings.keepaliveMaxPings`（L369）、默认值（L1101）、解析（L1623）。`parseCacheTtlSettings`：原始 `value.keepaliveMaxPings` 为有限数时，结果**仅**多一个可选只读字段 `legacyKeepaliveMaxPings?: number`（条件展开；无旧键则不存在 ⇒ `toEqual(DEFAULT_SETTINGS.cacheTtl)` 不变）。**该字段只被 status 提示读取；`keepalive` 恒由 `bool(value.keepalive, default)` 决定，`0` 与其它旧值同样被忽略，绝不影响保活开关或 cap。**
- `src/config/setting-specs.ts` L723：删 spec（TUI 编辑器随之消失）。不回写/不删用户文件旧键；不 `console.warn`（解析在父/子会话反复执行）。

### 2.4 `src/cache-ttl/cache-ttl.ts`（`/cache-ttl status` + 提示）

- `legacyCapNote(settings.cacheTtl)`（一种文案，不分 0/>0）：`note: cacheTtl.keepaliveMaxPings=N in settings is deprecated and ignored — the per-window cap is derived from the model's cache prices (see "cap:" above). To turn keepalive off use "cacheTtl.keepalive": false; remove the old key.`
- `status`：note 追加在报告行之后；服务缺席（`keepalive:false`）时 note 仍随 “service unavailable” 展示。
- “一次性”：`session_start` 用闭包标志 `legacyNoted`，每次 activate 至多 `ui.notify` 一次（TUI/rpc；print/子会话不发）；status 中旧键存在即常驻。

### 2.5 Web 线（追加式，无 proto 升级）

`src/web-hub/agent/cache-keepalive.ts` L102 `window.max` 自动动态；追加可选 `window.maxSource`（`priced|clamped|fallback`，仅在有值时）。`protocol/messages.ts`：`CacheKeepaliveWire.window` 加 `maxSource?: string`，schema L1383 补 `Type.Optional(Type.String())`（`additionalProperties:true`，旧端忽略）。
`CacheKeepalivePanel.vue` L134 保持 `n/max`，可选给该 token 加 `title`（fallback/clamped 说明）；`window` 已结束（§2.1）时投影沿用 `pingSegmentParts` 的文本，无需额外字段。

### 2.6 文档

`docs/guide/context.md` L31 改为「单窗口 ping 上限按**缓存前缀**读/写价推算（`floor((写价−读价)/读价)`，上限 96，无价格回退 11；回退值无盈利性证明；未计入未缓存输入与输出）」+ 弃用说明；`AGENTS.md` src/cache-ttl 段「limits 11/window」改为动态；`plan.md` §6.2/设置表、`webhub-plan.md` L239、`child-context-switch/plan.md` 仅追加 supersede 注记。CHANGELOG 不碰。

## 3. 状态 / 遥测 / Web 线汇总

状态栏 `ping n/max[ capped]` 文本格式不变（窗口结束时省略 `n/max`）；status：`cap: … (priced|clamped…|fallback: unpriced)`+弃用 note；子会话审计 `terminal-skip` 的 `budget-exhausted` 附 cap 三字段；Web `window.max` 自动动态 + 可选 `maxSource`。

## 4. 设置迁移

旧键（含 `0`）一律忽略不回写，仅 status 提示。**行为变化**：曾调低上限（如 3）省钱的用户现在拿到价格推导值；曾设 `0` 想关保活的用户保活会**保持开启**——这正是用户裁定（D1），所以提示文案必须明确指向 `"cacheTtl.keepalive": false`。

## 5. 测试清单

价格夹具约定：`R=1, W=(N+2)·R` ⇒ cap=N（整数 q，等号规则）；N≤96。**所有需要 cap 的服务级夹具必须给 `ctx.modelRegistry.find(provider,id)` 返回带 cost 的模型，且 `api/baseUrl` 与捕获一致**；缺 `find` 的旧夹具 ⇒ fallback 11（行为不变）。

- **新增 `tests/cache-ttl/keepalive-cap.test.ts`（纯函数）**：§1.3 全部验证值；`W=2.000000001,R=1`→1；`W=2,R=1`→0；`W=1,R=1`/`W<R`→fallback；整数邻域两侧（`q=12±1ULP`、`q=12±1e-12`）；`q=50.00000000000001`→48；`R=5e-324`(overflow)/NaN/Infinity/负/字符串→fallback；`q>2^53` 与 `raw>MAX_SAFE_INTEGER`→96 clamped（顺序：先校验后钳位）；`raw=97`→96 clamped、`96`→96 priced；property：随机价格下 `cap·R+R<W ≤ (cap+1)·R+R`（容差内）。
- **分档**：阈值 `L=t`/`t+1`/`t−1`（严格大于）、每档不同比值（档 A 11、档 B 48）、档缺 `cacheWrite`/`cacheRead`⇒`tier-incomplete`（**不**回落基础价）、`L` 在阈值下方 <8192 ⇒ `tier-uncertain`、`prefix.source!=="usage"`、无 tiers/空 tiers、无 capture(L=0)⇒基础档。
- **#2 服务级**：ctx=A（比值 12.5）、payload.model=B（比值 50，registry 注册且 api/baseUrl 一致）⇒ cap 取 B 的 48；B 未注册/`find` 缺失或抛错/baseUrl 不一致/api 不一致 ⇒ 11 `wire-model-unmapped`；ctx 换模型 ⇒ 下一 tick `fingerprint-drift` invalidate，新窗口按新捕获重算。
- **#6 展示**：模型切换后（`window.pings=20`、cap 变 11）状态栏/`status` 不出现 `20/11 capped`，显示窗口已结束；`capped` 仍只在 `capture!==undefined` 时出现；检查 `keepalive-state/breaker` 的 `win({pings:n})` 夹具是否带 capture（`pings>0` 且 `capture===undefined` 的夹具需改）。
- **#1 设置**：`{keepalive:true,keepaliveMaxPings:0}` ⇒ `keepalive===true`、无 cap 影响、`legacyKeepaliveMaxPings===0`；该配置下 stack 建出 service（`stack.ts:2470`）；子会话 `wireChildKeepalive` 照常注册；重复 `loadSettings`/`parse` 结果恒等且不 warn；`{keepaliveMaxPings:5/-1/"x"}`；无旧键 ⇒ 字段缺省；SETTING_SPECS 不含该键（反向断言）。
- **#8 矩阵（见 §6）**逐行一例。
- **机械改动**（删 `keepaliveMaxPings: 11` 字段）：`keepalive-breaker/child/evidence/lifecycle/ping-retry`、`probe.test.ts:196`、`integration/cache-keepalive.test.ts:130`。**改写小/大 cap 用例**（无 seam）：`keepalive-lifecycle` L420/L780、`child-keepalive` L888、`cache-ttl-removal.test.ts:123` 用 W=3R（cap 1）；`keepalive-child` L699/L766、`child-keepalive` L368 的 100/1000 改 W=52R（cap 50，大于 24/run，且测试实际 ping 数 <50）；`child-keepalive` L327 保留 11（`fakeCtx` 价 3.75/0.3，需补 `modelRegistry.find`），删 `DEFAULT_SETTINGS…keepaliveMaxPings` 断言，增 Fable 价（cap 48）子会话 24/run 先绑。
- **将变化的钉死文本**：仅 `renderKeepaliveReportLines` 的 `cap:` 行（带来源后缀；无 `maxPingsSource` 夹具文本不变）及 `window:` 的「ended」形态；`ping 3/11 Σ12…`、`ping 11/11 capped`（capture 存在）不变；projection/wiring 夹具不变，增一例 `maxSource` 透传。
- 全量 `format:check → typecheck → test → build`。

## 6. 生效矩阵（评审 #8）

`config()` 先算 cap；下表的“拒绝”均发生在 `evaluateTick` 门或 `childPingGate`，**早于任何网络**。

| 场景                                                                   | cap                              | 结果                                                               |
| ---------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| 主会话，模型无价/R 缺                                                  | 11 `fallback`                    | 照旧 ping（无盈利证明，status 标 fallback）                        |
| 子会话 R 缺/0                                                          | 11 `fallback`                    | `childPingGate` ⇒ `usd-unpriced`（终局，零 ping），不因 cap 而改变 |
| 子会话 R>0、W=0/缺/≤R                                                  | 11 `fallback`                    | 在既有预算（24/run、$1.5、ledger）下按 11 ping                     |
| 非 Anthropic api（`not-anthropic`，门 #5）                             | 任意                             | 零网络（门先于 #14/cap）                                           |
| 模型声明 `promptCache`                                                 | 任意                             | `native-warmer` 拒绝（门 #4.5），零 ping                           |
| `kimi-coding/k3`（anthropic-messages，R=0.3，W=0，`models.json` 覆盖） | 11 `fallback`（`write-le-read`） | 主会话照旧 11；子会话 R>0 ⇒ 过 gate、按 11 + 既有预算              |
| Anthropic 标价 3.75/0.3                                                | 11 priced                        | 与现状一致                                                         |
| Fable（R=0.025×）                                                      | 48 priced                        | 子会话被 24/run 与 $ 预算先绑                                      |

## 7. 车道 / 风险

- **L2，单个 dev 包**（核心+服务+设置+status+web 线+文档+测试，强耦合；≈10 src + ~14 test 文件）；验收模型 ≠ 开发模型；四项检查全绿后精确路径 commit（工作区有他人未提交改动，勿 `git add -A`）。
- 风险：①`modelRegistry.find` 在部分夹具缺失 ⇒ fallback 11（行为不变，但价格夹具必须补 `find`）；②`payload.model===model.id` 假设靠单测+fallback 兜底；③`TIER_GUARD_TOKENS=8192` 为启发式，已披露；④回退 11/priced 上限都只是**前缀预算**（§1.4），不是总成本保证；⑤旧键行为变化（§4）。

## 8. R1 评审处置表（§R1）

| #   | 评审要点                                     | 处置（本文位置）                                                                                                                                                                  |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D1 文本仍让旧键控制保活                      | 删迁移；`0` 同其它旧值只触发 status note；`keepalive` 恒由自身键决定（§0.3/§2.3/§2.4/§4）；新增 `{keepalive:true,keepaliveMaxPings:0}`/service 存在/子会话加载/重复加载测试（§5） |
| 2   | 门 #9 不证明 ctx.model==载荷模型             | 按捕获 `provider+payload.model` 经 `registry.find` + api/baseUrl 校验取价，映射不确定 ⇒ fallback `wire-model-unmapped`；ctx≠wire 服务级测试（§1.1/§5）                            |
| 3   | 分档按总输入、整档替换                       | 单档、W/R 同档、不混基础价、缺字段/档不确定 ⇒ fallback；阈值边界与逐档比值测试（§1.2/§5）                                                                                         |
| 4   | cap 只保证前缀预算                           | 删除总成本保证；披露忽略未缓存尾部/输出/thinking；回退 11 无盈利证明（§1.4/§2.6/§7）                                                                                              |
| 5   | 数值健壮性                                   | 校验商/结果有限；几个 ULP 容差；合法 0 区间 R<W≤2R；顺序 计算→校验→钳位；溢出/>MAX_SAFE 测试（§1.3/§5）                                                                           |
| 6   | 换模型后 pings 与新 cap 错位；窗口持久化声明 | 窗口结束显示（无 `n/max`）；`capped` 需 capture；删除窗口持久化说法（§2.1/§5）                                                                                                    |
| 7   | 哨兵 96                                      | 用户裁定保留；来源单列 `clamped`（+`rawCap`），非 `priced`（§1.3/§0.4）                                                                                                           |
| 8   | 子会话 gate 顺序描述错                       | 更正顺序；加生效矩阵（§2.2/§6）                                                                                                                                                   |
| 9   | `capOverride` 缝                             | 主会话裁定删除；用价格夹具造 cap（W=(N+2)R），夹具补 `modelRegistry.find`（§0.4/§5）                                                                                              |

## 10. 用户裁定（2026-10-18，final，覆盖前文）

- **D1**：旧 `keepaliveMaxPings: 0` 与其它旧值一样**忽略**（不迁移为 `keepalive:false`）；仅 status 提示废弃，想关保活用 `"cacheTtl.keepalive": false`。
- **D2**：哨兵上限固定 96，不可配置；触顶标 `clamped`。**D3**：cap=0（R<W≤2R）保留，不 ping。
- **D4（主会话 #9 决定）**：不保留 `capOverride` 测试缝，测试用价格夹具构造 cap。

## §R2 主会话收口（第二轮评审 re-review-dynamic-keepalive-cap-plan, run_id: r_RCBXFW0A：#2/#4/#8/#9 闭合，#1/#3/#5/#6 部分闭合；不再开第三轮）

以下裁定覆盖正文中与之冲突的表述，开发按此执行：

- **R2-1 选档输入（#3）**：档位只用「与捕获请求同一次真实请求」的完整 usage 总量 `input + cacheRead + cacheWrite`（打开该窗口的那次真实请求的响应 usage；ping 重放同一 payload，选档输入相同）。拿不到这份 usage 时：模型**无分档** ⇒ 基础价照常 `priced`；模型**有分档** ⇒ 回退 11，`source:"fallback"`、reason `tier-uncertain`。删除 8192 启发式。测试：新增输入 >8192 跨档、跨多档、不同档 W/R 比值、usage 缺失 × 有/无分档。
- **R2-2 取值范围（#5 新引入）**：最终 `cap = min(96, max(0, raw))`，恒为 `[0,96]` 的整数；`raw > 96` ⇒ `clamped`；`raw < 0`（如 W 仅比 R 大一个 ULP）归一为 0、`priced`。测试覆盖 q 在 1、2 两侧邻域。
- **R2-3 Web 展开行（#6）**：投影在窗口已被 invalidate（旧窗口计数 + 新模型上限）时追加可选 `window.ended: true`；`CacheKeepalivePanel` 展开行此时显示 `ended`（不显示 `n/max`）；字段缺省 ⇒ 旧端行为不变（旧 agent / 旧 UI 互通）。测试：旧窗口 20 次 → 新 cap 11 的投影断言 + 组件断言。
- **R2-4 property 范围（#4 测试）**：「最大可盈利整数」property 只用于未钳位的 `priced` 分支（含约定的整数容差）；`clamped` 断言 cap=96、raw>96、前缀预算不等式与来源；`fallback` 断言 11 与 reason。
- **R2-5 旧键提示（#1）**：删除 `session_start` 主动通知，**只在 `/cache-ttl status` 提示**。旧键「存在」即提示（不论值是否合法）：可解析的有限数显示原值，否则显示 `(invalid)`；文案一种：`note: cacheTtl.keepaliveMaxPings is deprecated and ignored — the per-window cap now comes from the model's cache prices; use "cacheTtl.keepalive": false to turn keepalive off, and remove the old key`。旧值在任何情况下都不影响开关或上限。测试：数值 / 0 / 字符串 / 缺省四态。
