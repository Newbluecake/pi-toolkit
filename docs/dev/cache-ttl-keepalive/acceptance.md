# 提示词缓存保活独立验收

## 总评

**修完 Blocker 后合并。** 定向测试 `keepalive-lifecycle`、`keepalive-ping`、`integration/cache-keepalive` 共 47 项通过；但仍有一个会直接破坏缓存命中安全边界的 Blocker。

## Blocker

### B1. ping 无条件新增 `stream`，违反 I-K1 的逐字重放约束

**问题：** `preparePingPayload` 除调整非 thinking 请求的 `max_tokens` 外，还无条件写入 `stream: true`。对真实请求没有 `stream` 或其值不是 `true` 的 payload，这不再是“只下调 max_tokens”的逐字重放，可能改变缓存键并制造一次真实写入。现有测试反而把新增 `stream` 当作正确行为，无法守住该不变量。

**证据：** [src/cache-ttl/ping-client.ts:88](/home/bluecake/ai/pi-toolkit/src/cache-ttl/ping-client.ts:88) 无条件构造 `stream: true`；[src/cache-ttl/ping-client.ts:92](/home/bluecake/ai/pi-toolkit/src/cache-ttl/ping-client.ts:92) 才调整 `max_tokens`；[tests/cache-ttl/keepalive-ping.test.ts:101](/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-ping.test.ts:101) 只抽查若干字段且要求 `stream === true`，没有深比较“除 max_tokens 外完全相同”。I-K1 见 [plan.md:113](/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/plan.md:113)。

**建议修法：** 严格保留原 payload，只下调允许的 `max_tokens`；若流式早停是必需条件，应先证明真实请求必为 `stream: true`，并在捕获门禁拒绝不能证明同构的 payload。补带 `stream: false` 和不带 `stream` 的深比较测试。

## Major

### M1. 指纹漂移先递增 epoch，再退款，窗口会留下 `pingInFlight` 和已消费预算

**问题：** auth 返回后发现指纹漂移时，代码先 `invalidateReducer` 递增 `windowEpoch`，再调用要求旧 epoch 仍匹配的 `refundBudget()`，所以退款必然被跳过。HTTP 尚未发出，却永久留下 `pingInFlight: true` 和增加后的 `window.pings`；报告、预算和后续状态均不准确，且该路径无测试。

**证据：** [src/service/cache-keepalive.ts:281](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:281) 至 [src/service/cache-keepalive.ts:286](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:286) 先 invalidate 后 refund；[src/service/cache-keepalive.ts:232](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:232) 的退款先查旧 epoch；[src/cache-ttl/keepalive-state.ts:581](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:581) 的 invalidate 会递增 epoch。

**建议修法：** 在 invalidate 前退款，或用原子 reducer 同时完成失效、递增 epoch、清 in-flight 和退回未发出请求的预算；补 auth 返回后 model/base URL/header 漂移测试。

### M2. I7 装配边界被扩展为事件状态逻辑

**问题：** `keepaliveSessionId`、工具/UI 活跃计数、settled 清理、请求结束通知和 invalidate 事件映射决定了 keepalive 的状态语义，不只是装配。把约 80 行这些规则放入 `src/index.ts` 违反 assembly-only 铁律，也使 reload/事件顺序语义分散。

**证据：** [AGENTS.md:58](/home/bluecake/ai/pi-toolkit/AGENTS.md:58) 明确 `src/index.ts` assembly-only、无逻辑；[src/index.ts:191](/home/bluecake/ai/pi-toolkit/src/index.ts:191) 至 [src/index.ts:269](/home/bluecake/ai/pi-toolkit/src/index.ts:269) 包含会话 ID 读取和事件到状态操作的映射；计划对 index 的职责仅为 holder read-through 和 dispose，见 [plan.md:320](/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/plan.md:320)。

**建议修法：** 抽到 `src/cache-ttl/` 或 `src/service/` 的 pi-facing adapter，index 只调用一个 wiring 函数并传 holder。

## Minor

### m1. 迟到 fetch reject 路径未被 service 生命周期测试覆盖

**问题：** 实现统一在 `sendKeepalivePing` 返回后检查 epoch，迟到 body 路径也有测试；但 `hangingFetch` 只能 resolve Response，未覆盖真实请求抢占并 abort 后 fetch reject 的路径。因此 I-K8 要求的两条迟到路径只有一条被 service 测试锁住。

**证据：** [src/service/cache-keepalive.ts:304](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:304) 至 [src/service/cache-keepalive.ts:310](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:310) 是统一 epoch 门；[tests/cache-ttl/keepalive-lifecycle.test.ts:49](/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-lifecycle.test.ts:49) 的 fake 只有 resolve；[tests/cache-ttl/keepalive-lifecycle.test.ts:218](/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-lifecycle.test.ts:218) 至 [tests/cache-ttl/keepalive-lifecycle.test.ts:263](/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-lifecycle.test.ts:263) 只覆盖迟到 Response/body。

**建议修法：** 增加“ping 发起、真实请求递增 epoch、fetch reject”用例，精确断言窗口对象字段、`aliveUntil`、proven/unproven 和 breaker 均不变。

### m2. integration 测试绕过了 index 的真实事件 forwarder

**问题：** 集成测试直接调用 `noteToolStart`，不能证明实际 activate 路径能正确 arm、settle、invalidate，也无法发现 M2 所述 wiring 回归。

**证据：** [tests/integration/cache-keepalive.test.ts:153](/home/bluecake/ai/pi-toolkit/tests/integration/cache-keepalive.test.ts:153) 至 [tests/integration/cache-keepalive.test.ts:158](/home/bluecake/ai/pi-toolkit/tests/integration/cache-keepalive.test.ts:158) 明确绕过 index forwarder。

**建议修法：** 增加 activate 级测试，触发 tool/UI、agent settled 和 drift 事件，并验证 rebuild 后旧实例不再接收状态写入。

## 八项结论

1. **I-K8：实现通过，测试部分通过。** auth await 和完整 ping await 后均查 epoch，结果 reducer 前也再次由纯 reducer 自检；失配不回写窗口、存活期或 breaker。已覆盖迟到 proven-hit 和已拿到 body 的 accepted-then-lost，但缺 fetch reject 用例。证据：[src/service/cache-keepalive.ts:256](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:256)、[src/service/cache-keepalive.ts:310](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:310)、[src/cache-ttl/keepalive-state.ts:592](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:592)、[src/cache-ttl/keepalive-state.ts:610](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:610)。
2. **I-K9：通过。** `accept()` 校验 disposed、sessionId、instanceId、`isCurrent(this)`；holder/current 失配计入 `instanceMismatch`。证据：[src/service/cache-keepalive.ts:174](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:174) 至 [src/service/cache-keepalive.ts:185](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:185)。
3. **I-K7：通过。** 只有 proven-hit 清连续计数；其余六类都走 `onUnproven`，真实请求不清会话级计数，三条停用线均生效。证据：[src/cache-ttl/ping-client.ts:35](/home/bluecake/ai/pi-toolkit/src/cache-ttl/ping-client.ts:35)、[src/cache-ttl/keepalive-state.ts:610](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:610) 至 [src/cache-ttl/keepalive-state.ts:629](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:629)、[src/cache-ttl/keepalive-state.ts:543](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:543)。
4. **I-K1：不通过。** 两次时间边界检查正确，第二次在 auth await 后；但 payload 额外写 `stream`，构成 B1。证据：[src/cache-ttl/keepalive-state.ts:414](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:414)、[src/service/cache-keepalive.ts:290](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:290)、[src/cache-ttl/ping-client.ts:88](/home/bluecake/ai/pi-toolkit/src/cache-ttl/ping-client.ts:88)。
5. **生命周期/零悬挂：通过。** `previousKeepalive`、Stack 字段、build 顶部 dispose、构造、return、shutdown 兜底均齐全；dispose 幂等并清 timer/abort；timer 走已 unref 的 system clock。证据：[src/stack.ts:115](/home/bluecake/ai/pi-toolkit/src/stack.ts:115)、[src/stack.ts:472](/home/bluecake/ai/pi-toolkit/src/stack.ts:472)、[src/stack.ts:697](/home/bluecake/ai/pi-toolkit/src/stack.ts:697)、[src/stack.ts:1080](/home/bluecake/ai/pi-toolkit/src/stack.ts:1080)、[src/stack.ts:1275](/home/bluecake/ai/pi-toolkit/src/stack.ts:1275)、[src/index.ts:541](/home/bluecake/ai/pi-toolkit/src/index.ts:541)、[src/service/cache-keepalive.ts:410](/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts:410)、[src/core/clock.ts:12](/home/bluecake/ai/pi-toolkit/src/core/clock.ts:12)。
6. **I7：不通过。** 见 M2。
7. **测试质量：部分通过。** epoch body、实例身份、accepted-then-lost 分类、真实请求不重置 breaker、stack rebuild dispose 均有覆盖；reject、真实 index wiring 和 fingerprint-drift 退款缺失，payload 同构断言过松并接受了 B1。
8. **默认开启门控：通过。** 非 Anthropic Messages API、无 ephemeral cache_control、已有 1h、实测前缀不足 20k、无后台/tool/UI 工作都会阻止 fetch。证据：[src/cache-ttl/keepalive-state.ts:390](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:390) 至 [src/cache-ttl/keepalive-state.ts:421](/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts:421)。
