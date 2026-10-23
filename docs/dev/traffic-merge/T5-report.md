# T5 报告：traffic 与 cache-ttl keepalive / pi 原生 warming 共存

> 状态：**完成**（自验见 §6）。plan r3 §7.3 全节 / §8.2 #11 / §10 T5 行 / §R1 #6 / §0 拍板⑥；方案作者 consult 裁定见 §8。
> 写域（实际改动）：新建 `src/traffic/keepalive-port.ts`、`src/traffic/warming.ts`；`src/service/cache-keepalive.ts`（发送闸门）；`src/cache-ttl/keepalive-state.ts`（skip 理由 + HUD 一处）；`src/traffic/capture.ts`（出站边界一行）；测试 ×3。**未改** `src/index.ts`、settings、`src/traffic/index.ts`（T3 在做装配）。

## 1. 留给 T3 的接口（签名；T3 按本节接线）

### 1.1 keepalive 否决端口（`src/traffic/keepalive-port.ts`，pi-free、零 import、零顶层副作用）

```ts
/** 结构化 engine 视图 —— 刻意不 import engine.ts（本模块不得拉入重依赖）。 */
export interface TrafficVetoEngineView {
  readonly state: string; // "open" | "closing" | "closed"
  readonly recording: boolean;
  readonly rulesSnapshot: { readonly rules: readonly unknown[] };
}

export interface TrafficKeepaliveVetoPort {
  /** open ∧ 录制中 ∧ 快照里有启用规则（= engine.rewriteArmed()）。 */
  rewriteArmed(): boolean;
  /** 该会话最近一次实际改写 ≥ capturedAt，或 rewriteArmed() ⇒ 否决。 */
  vetoCapture(sessionId: string, capturedAt: number): boolean;
}

/** T3 在主会话装配里构造并注册（readEngine 传 () => peekEngine()，isSecure 传 () => isSecure()）。 */
export function createTrafficKeepalivePort(
  readEngine: () => TrafficVetoEngineView | undefined,
  opts?: { isSecure?: () => boolean },
): TrafficKeepaliveVetoPort;

/** 注册进程级端口（Symbol.for("pi-subagent:traffic-keepalive-port")）。返回身份校验注销函数（=== port 才删）。 */
export function registerTrafficKeepalivePort(port: TrafficKeepaliveVetoPort): () => void;

export function peekTrafficKeepalivePort(): TrafficKeepaliveVetoPort | undefined;

/** capture.ts 出站边界调用（T5 已接好，T3 无需再接）：进程级「该会话最近一次被实际改写」标记，engine 关闭/重载后仍存活。 */
export function noteTrafficRewrite(sessionId: string, at: number): void;

/** cache-keepalive 发送闸门消费点（T5 已接好）：端口未注册 / 抛错 ⇒ false，行为字节不变。 */
export function trafficVetoPing(sessionId: string, capturedAt: number): boolean;

export const REWRITE_MARKS_CAP: number; // 256（进程标记 FIFO 容量，会话数）
export const trafficVetoStats: { marksFailures: number; portFailures: number }; // 仅观测诊断计数（畸形共享状态），T3 无需消费
```

**T3 接线**（主会话装配，traffic.enabled 时；子会话无需注册——同进程共享）：

```ts
const unregisterKeepalivePort = registerTrafficKeepalivePort(
  createTrafficKeepalivePort(() => peekEngine(), { isSecure: () => isSecure() }),
);
// session_shutdown / 释放时 unregisterKeepalivePort()（身份校验，晚到的旧注销不会删新端口）
```

**traffic off ⇒ 不注册、Symbol 不存在**。建议 T3 的 wiring 测试补断言：off 时 `peekTrafficKeepalivePort() === undefined` 且 `Symbol.for("pi-subagent:traffic-rewrite-marks")` 不在 globalThis 上（查询本身不创建任何东西）。

### 1.2 pi 原生 warming 否决（`src/traffic/warming.ts`）

```ts
export interface WarmingVetoHandle {
  dispose(): void; // 注销（转发 pi.on 的 unsubscriber）
  readonly errors: number; // armed 判定抛错次数（读内存快照不应抛；抛了 fail-open 放行 + warn 一次）
}

/** armed 判定：裸函数（作者 consult 裁定）或对象形式（T3 装配的调用形状 { rewriteArmed(): boolean }），二者等价。 */
export type WarmingVetoArmed = (() => boolean) | { rewriteArmed(): boolean };

/** 注册独立于 traffic 观察器的 cache_warming_decision 处理器：armed() 为真 ⇒ {action:"stop"}，否则/抛错 ⇒ undefined。 */
export function registerWarmingVeto(pi: ExtensionAPI, armed: WarmingVetoArmed): WarmingVetoHandle;
```

**T3 接线**：`assembleTrafficHost` 与 `assembleTrafficChild` **各调用一次**（每个 AgentSession 有自己的 cache warmer；T3 的 TODO 注释已是对象形式，可直接用）：

```ts
const veto = registerWarmingVeto(pi, { rewriteArmed: () => wiring.rewriteArmed() });
// session_shutdown / 释放时 veto.dispose()（不调用也只留下一个每次返回 undefined 的惰性处理器，无副作用）
```

`wiring.rewriteArmed()`（`TrafficWiring.rewriteArmed()`，T2b 已实现）= open ∧ 录制中 ∧ 有启用规则 ∧ !isSecure()。warming 60s 观测窗 / 改写暂停的簿记保持在 traffic 自己的观察器（`src/traffic/index.ts` 已有，T5 未动）。

## 2. 实现与相对 plan 原文的偏差（均经方案作者 consult 裁定，见 §8）

| #   | plan 原文                                                                            | 实际落地                                                                                                                                                                                    | 依据                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §7.3「主会话 `cache-keepalive.ts` 的发送闸门、子会话 `child.ts` 的发送闸门各加一行」 | 发送否决**只**加在共享 `CacheKeepaliveServiceImpl.onTick` 的 ping 分支（主/子会话共用此实现，一处覆盖两侧）；**`src/cache-ttl/child.ts` 零改动**                                            | 作者裁定 Q1-(b)：原文措辞笔误（误以为主/子各有发送路径）；并明确 Q1-(a)（在 child.ts 拦 capture）**有害**——规则开着时跳过 capture 会让 service 持有更旧的、规则启用前的 capture，规则停用后反而重放真正过期的前缀 |
| 2   | §7.3 `vetoCapture` =「该会话 `lastRewrittenAt ≥ capturedAt`，或 `rewriteArmed()`」   | `engine.lastRewrittenAt` 照旧（T2b）；另加**进程级镜像标记** `noteTrafficRewrite`（`Symbol.for("pi-subagent:traffic-rewrite-marks")`，256 会话 FIFO），`vetoCapture` 读镜像而非 engine 字段 | 作者裁定 Q3 must-fix：engine 关闭（reload / shutdown）后 provider cache 里的改写前缀还在，否决信息不能随 engine 消失。镜像在 `capture.ts` 出站边界与 engine 字段同刻写入（每次发送含重试都更新）                  |
| 3   | 文件域未列 `keepalive-state.ts` / `capture.ts`                                       | 各一处最小改动：新增 `TickSkipReason` 成员 `"traffic-rewrite"` + `pingSegmentParts` 一个分支；`capture.ts` 出站边界一行调 `noteTrafficRewrite`                                              | 类型联合与 HUD 渲染是「发送闸门一行」的必要配套；镜像写入点是作者裁定的 must-fix 落点                                                                                                                             |

**子会话 capture 键位核对（作者 checklist，已验证不改码）**：child.ts 的 capture 以 `ctx.sessionManager.getSessionId()` 为 `sessionId`（`safeSessionId`），traffic 票据/`lastRewrittenAt` 的键同为 `ctx.sessionManager.getSessionId()`（`src/traffic/index.ts` 铸票据处）——同键；两侧时钟均为 `Date.now()`（`captureRequest` 的 `capturedAt` 与 `capture.ts` 出站边界）——同源。`tests/traffic/keepalive-port.test.ts` 的真改写用例把「键=会话 id」钉进断言。

## 3. keepalive 否决语义（发送闸门）

插入点：`onTick` 的 ping 分支，**在既有安全/预算闸门（no-cache-value 证据断路器、childPingGate 预算闸）之后、`onPingStarted` 之前**（作者裁定：更重要的停止理由不被 `lastSkip` 覆盖）：

```ts
if (trafficVetoPing(capture!.sessionId, capture!.capturedAt)) {
  // 撤销本 tick 在预算闸里拿到的 ping-ledger 预留（0 = 不计费），见 §3.1
  if (gate.lease) this.settleLeaseOnce(gate.lease, 0);
  this.lastSkip = "traffic-rewrite";
  this.arm();
  return;
}
```

此外（安全评审 T5-#2，见 §9.1）`dispatchPing` 的 **guard 闭包**也复查否决：pipeline 传输在鉴权完成后、base fetch 之前（及流读取间隔）调用 guard，且每次 retry 尝试各调一次——onTick 之后的异步窗口（鉴权等待 / 重试退避）内规则上膛时同样不发出。

- **非终态**：不设 `session.disabled`、不进任何 breaker / streak / total 计数、不清 capture、不清 exact timer 的正常重排；15s 周期 tick 重试（`arm()`）。
- **不伸 `aliveUntil`**：否决发生在 `onPingStarted` 之前，窗口存活期不被 ping 周期延长；窗口自然过期走正常 `cache-expired` 停止路径（作者裁定）。
- **自愈**：规则停用（`rewriteArmed()` false）后，下一次**未改写**真实请求的新 capture（`capturedAt > 最近改写时刻`）不再被否决，ping 恢复；`noteRequest` 本身清 `lastSkip`。
- **消费点查询零创建**：`trafficVetoPing` 只读 `Symbol.for` 全局，未注册 / 抛错 ⇒ `false`（fail-open，keepalive 行为不变）。
- **HUD**：`pingSegmentParts` 新增分支（放在各 session/line breaker 之后、capped/miss 之前）——`ping off:traffic-rewrite`，state `paused`（窗口级暂停，非会话熔断）。TUI 与 web-hub 投影共用此函数（`src/web-hub/agent/cache-keepalive.ts` 直接消费 parts，state 字符串透传，UI 已有 `paused → warn` 映射）——两侧零额外改动。
- **展示面核对**（作者 checklist）：`/cache-ttl status` 的 skip 行是通用插值（`last skip: ${report.lastSkip}`），无枚举表，无需改；web-hub 投影只枚举 `session.disabled.reason`（否决不碰它），无需改。
- **拍板⑥（toolkit 自己的保活/quota 请求不录）**：结构上已成立（T2b `internal-requests.test.ts`：keepalive pipeline ping 走 `streamSimple` 自带 transformHeaders，不经扩展钩子、无票据 ⇒ 不录不改写）；T5 未改该机制，`tests/traffic/internal-requests.test.ts` 现有断言全绿。

### 3.1 验收回归（2026-10-23 验收打回的 blocker）：否决分支撤销 ping-ledger 预留

- **问题**：子会话（配 `pingLedger` 的 harness）里 `childPingGate` 返回 `allow:true` 时已 `tryAcquire` 拿到 lease；否决提前 return 既不挂 `currentLease` 也不 settle——lease 150s 后被 `reclaimExpired` 回收并把 `estimateUsd` 记入 `spent24h`（幽灵计费）；持续否决每 15s 漏占一个并发额度（`maxConcurrent` 默认 4），挤占其它子会话（`global-cap`），累积可触发 `usd-process`。
- **修复**：否决分支 return 前 `if (gate.lease) this.settleLeaseOnce(gate.lease, 0)`。语义核对：`ping-ledger.ts` 的 `Lease.settle` 文档明示「`chargeUsd` omitted（或 `undefined`）⇒ revoke the reservation entirely」，实现 `charge = chargeUsd ?? 0; if (charge > 0) recordSpend`——**`settle(now, 0)` = 撤销不计费**，与 `dispose()` 的兜底（:1754，同款「lease 不得残留占用并发额度」理由）一致；`settledLeases` 是 `WeakSet`，无增长问题。「否决位于预算闸之后、lastSkip 优先级」不变（撤销在 `lastSkip` 赋值前，不影响任何 skip 语义）。
- **回归测试**（`keepalive-traffic-veto.test.ts` 新 describe，注入真实 `createChildKeepaliveLedger()` 工厂实例 + `maxConcurrentPings: 2`）：①连续否决 tick 后 `activeCount()/reserved()` 恒 0，重开窗口跨过首笔 lease 的 150s 回收窗（240s+150s=390s < 510s 的下一 tick）后 `spent24h` 仍 0、`lastSkip` 保持 `traffic-rewrite` 不被 `global-cap` 取代；②无否决时 ledger 路径字节不变（ping 正常发出，acquire→settle 一个循环，无预留残留）。已验证测试非空转：临时注释修复行后用例 ① 失败（第三笔 tick 后 `activeCount`=2，即打回症状）。

## 4. warming 否决（`src/traffic/warming.ts`）

- 独立注册一个 `cache_warming_decision` 处理器（与 traffic 自己的观察器互不影响；pi 1.3 的 runner 把各 handler 返回值折叠进局部变量，扩展间不冲突）。
- `armed()` 为真 ⇒ `{ action: "stop" }`（plan §7.3：歧义路径下 warmer 可能被改写而写错前缀）；假/抛错 ⇒ `undefined`（不否决；抛错 fail-open + 计数 + 一次去重 `console.warn`）。
- 观察器侧的 60s 窗口 / 改写暂停（T2b 裁定 A 的 fail-closed 兜底）保持原样——T5 缺席或被其它扩展改判时仍安全（作者确认职责边界：簿记归观察器，否决归本模块）。

## 5. 冻结面验证

- **端口未注册 ⇒ 字节不变**：新增检查短路为 `false`，不写任何状态。显式用例：`keepalive-traffic-veto.test.ts` 末例（标记存在 + 无端口 ⇒ ping 正常发出，渲染不含 traffic-rewrite）。
- **现有测试全绿**：`tests/traffic tests/cache-ttl tests/service` 110 文件 / 2029 例全过（含 T3 并行在途改动共存）；另跑 `tests/integration/keepalive-pipeline-service` + `tests/integration/cache-ttl-removal` + `tests/web-hub/agent/cache-keepalive-projection`（51 例，投影/移除冻结面）全过。
- **traffic off 零面**：`keepalive-port.ts` 零 import、零顶层副作用；查询不创建容器/不建全局符号；warming 模块仅在被调用时注册（off ⇒ T3 不调用 ⇒ 零面）。
- 三份 off golden 与 `legacy-xs-v071` 未触碰。

## 6. 自验

```
$ npx vitest run tests/traffic tests/cache-ttl tests/service --maxWorkers=2
 Test Files  113 passed (113)
      Tests  2081 passed (2081)      （T5 新增 27 例：keepalive-port 14 + warming 5 + keepalive-traffic-veto 8；总数含 T3 并行新增套件，随其合入进度浮动）

$ npx vitest run tests/integration/keepalive-pipeline-service.test.ts tests/integration/cache-ttl-removal.test.ts \
    tests/web-hub/agent/cache-keepalive-projection.test.ts --maxWorkers=2
 Test Files  3 passed (3) · Tests 51 passed (51)

$ npx tsc --noEmit -p tsconfig.json        0 错误
$ npx tsc --noEmit -p tsconfig.build.json  0 错误
$ npx prettier --check <全部改动文件>       All matched files use Prettier code style!
```

## 7. 遗留 / 交接

- **给 T3**：§1 两个接线点 + off 时端口/标记符号不存在的 wiring 断言（§1.1 末）。T3 的 `src/traffic/index.ts` TODO（:931）注释里的调用形状已兼容（对象形式）。
- **给 T7（文档）**：plan §7.3「主会话…子会话…各加一行」措辞按 §8 Q1 裁定回填（共享 service 一处覆盖）；真机 V5 的 `ping off:traffic-rewrite` 断言可按 §3 的 HUD 分支直接验。
- **残留（可接受）**：进程标记 FIFO 上限 256 会话——被淘汰会话的极旧 capture 理论上可再 ping 一次（远超真实并发会话数，作者裁定示例值）；否决期间 15s 一次的空 tick 重试直到自愈（无网络、无费用）。

## 8. 方案作者 consult 裁定记录（r_YRWB4PF3，2026-10-23）

- **Q1** → (b)：child.ts 无需改动，共享 `onTick` 一处否决覆盖主/子；(a) 拦 capture 有害（持有更旧 capture，规则停用后重放真正过期前缀）。child.ts 仅需**核对**（已核对并钉测试）：capture 的 sessionId = 子会话自身会话 id（非 instanceId/runId）、时钟同 `Date.now()`。
- **Q2** → 非终态、不熔断、不动计数、不清 capture；`aliveUntil` 不因否决延长（窗口自然过期照常停）；检查顺序在既有安全/预算闸门之后、发送之前；HUD `ping off:traffic-rewrite` 可，需核对 status 枚举表与 web-hub 投影白名单（已核对：均无需改）；补一条 off 字节不变断言。
- **Q3** → 签名可行，must-fix 两条：① `lastRewrittenAt` 不能只活在 engine（engine 关闭后旧 capture 仍要否决）⇒ 端口自持进程级 Map（256 FIFO）+ engine 出站边界回调 `noteRewritten`；② 注销必须身份校验（`=== port` 才删）。`readEngine` 调用时现读不缓存；`keepalive-port.ts` 零顶层副作用、不 import 重模块、永不建容器；traffic off 时符号不存在（wiring 测试断言）。warming：主/子各注册一次、只在 `wireTraffic*` 内调用、armed 抛错 ⇒ `undefined`（计数）、簿记归观察器不归 warming.ts。

## 9. 安全评审处置（cr-response gpt-6.1-sol，/tmp/traffic-T3T5-secreview.json；T5 部分 2026-10-23 修复）

### 9.1 Major #2：否决只在 onTick 查一次，鉴权等待 / 重试退避旁路

- **问题**：onTick 零规则时放行后，pipeline 在鉴权 await 期间规则被启用（网页启用 + 快照刷新），物理 fetch 的 guard 只查 disposed/windowEpoch ⇒ 旧 capture 照发；首试 429/网络错误进入 2s/5s 退避，期间启用规则，下一次 `dispatchPing` 不再经过 onTick 的 traffic 检查 ⇒ 照发。
- **修复（第 1 轮）**：`dispatchPing` 的 guard 闭包加入 traffic 否决复查（真实传输 `pipeline-ping.ts` 在鉴权后、base fetch 前调 guard（:255/:312），流读取间隔也调（:357/:382/:387）；每次 retry 尝试各一次）。命中 ⇒ 走既有 `not-sent{guard}` 路径。
- **第 2 轮闭合（原部分闭合：retry 被否决后继承前次网络失败 outcome，走 onUnproven 清掉 capture，违反「否决 = 可恢复暂停」）**：`runPing` 的 not-sent 分支**显式区分** traffic veto 与普通 not-sent/自然重试终结——`not-sent{guard}` 且复查 `trafficVetoPing` 仍真时：**不进入** onUnproven（不清 capture、不立 lastStopReason、不动未证明计数），保留 capture 对象与**原 aliveUntil**，退预算解除 pingInFlight，`lastSkip="traffic-rewrite"`，直接返回。lease 由外层 finally **恰一次**结算：可重试前提下前次尝试必为 never-processed（network / 可重试 http）⇒ charge 恒 0（未发送部分撤销不计费；已发送的前次尝试按原规则亦为 0）。**恢复**：规则停用后 15s 周期 tick 在窗口 TTL 内自动恢复发送，**无需 noteRequest**。已发出的请求不追溯：不撤销已发生的读、不追加计费/熔断——流读取中途命中 guard 与今日 disposed/epoch-change 同款处理。
- **验证**：①鉴权等待中上膛 ⇒ 鉴权完成后不发送、refund、不熔断、lease 0 结算、后续 tick 不再进入；②退避中上膛 ⇒ 仅首次到达网络（fetch 恰 1 次）、sender 进入但被 guard 拦、**capture 对象身份不变、原 aliveUntil 保留、lastStopReason 未立、unprovenTotal 为 0、lease 0**；随后**不 noteRequest** 关闭规则 ⇒ 15s 后（窗口 TTL 内）恢复发送（fetch 第 2 次）。两用例均实证非空转：第 1 轮验证时禁用 guard 复查分别失败于「鉴权后发出」与「重试第二次到达网络」；第 2 轮验证时临时禁用 not-sent 分支的 veto 早退，用例 ② 失败于 `window.capture` 变 undefined（onUnproven 清除，即本轮打回点）。onTick 分支与 guard 分支共用 `trafficVetoPing`（未注册 ⇒ 恒 false）⇒ 冻结面不变。

### 9.2 Major #3：进程标记无运行时校验，辅助记账故障可阻断 provider 请求

- **问题**：`ensureMarks()` 把任意 truthy 共享符号值强转 `RewriteMarks`；他人写入 `{v:1,map:null}` 后，下次成功改写的 `map.has` 即抛 TypeError，且调用点在实际发送之前 ⇒ 正常模型请求直接失败（读取侧的 fail-open catch 保不了写侧）。
- **修复**（`keepalive-port.ts` 重写相关段 + `capture.ts` 双重兜底）：
  1. **读取校验**：`readMarks()` 形状校验（对象 ∧ `v===1` ∧ `map instanceof Map`），getter 抛错同样兑底；畸形 ⇒ `corrupt` 态。
  2. **写侧 never-throw + 自愈**：`noteTrafficRewrite` 全程 try/catch；畸形/缺失结构用新的合法结构**替换**后写入（下一次改写即自愈；只读访问器导致写回失败只计数）；`capture.ts` 调用点再包一层 try/catch，辅助记账绝不阻断发送。
  3. **读侧 never-throw**：端口 `vetoCapture` / `trafficVetoPing` / `peekTrafficKeepalivePort` 均兑底；失败计入 `trafficVetoStats`（仅观测）+ 首次畸形 `console.warn` 一次（去重）。
  4. **端口形状校验**：非对象 / 缺方法的端口全局按未注册处理。
- **fail 策略（不对称，刻意，按评审建议）**：**标记损坏 ⇒ 否决**（视为「最近有改写」，宁少 ping 不发旧 capture；自愈 = 下一次 `noteTrafficRewrite` 替换合法结构，条目级损坏由该会话下次改写覆盖）；**端口损坏 / 未注册 ⇒ 放行**（等价 traffic off 冻结面——traffic 没说话就不否决）。持续损坏（攻击者反复写畸形值）⇒ 持续否决：keepalive 是优化，停摆只损失缓存命中，方向安全；不会永久停摆于「发旧 capture」。同进程恶意扩展本就能替换 fetch / 注册恒真端口（评审「共享符号信任边界」），本模块只隔离**畸形**状态对正常请求的影响，不声明扩展间真实性隔离。
- **验证**：新增 4 组畸形用例（非 Map / map:null / 字符串 / 数字 ⇒ 否决 + 写侧替换自愈；条目值类型错 ⇒ 该条否决其它正常 + 覆盖修复；抛错 getter ⇒ 否决 + 不抛 + 计数；畸形端口 ⇒ peek undefined + 放行）与 1 组真 engine 集成（jq）：标记全局畸形时真实改写请求**照常发送**（上游收到改写后正文、响应正常结算），出站边界写入同时自愈畸形结构。
