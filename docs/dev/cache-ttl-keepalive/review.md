# cache-ttl keepalive 方案评审

## 总评

**需要重做。** 当前方案不能直接开工；至少需要先修复下面的 Blocker，尤其是会话接缝、R1 失败回路、配额熔断和生命周期归属。成本公式有一部分算对了，但据此得出的默认开启策略并不安全。

## Blocker

### B1. 会话切换存在跨会话捕获竞态，可能把旧 payload 喂给新调度器

**问题：** 方案只用 `s.active` 保护 `await` 返回后的旧任务，没有在 `before_provider_request` 捕获入口校验事件所属会话。`session_start` 会先创建/替换 keepalive session，而 `holder.current` 的 stack 替换发生在之后；旧 runner 的 provider hook 若在这段窗口执行，闭包里的 `session` 已经是新会话，旧 payload 会被 `noteRequest` 记入新窗口，直接制造 R1。

**证据：** `plan.md:102-107`、`plan.md:136-174`、`plan.md:522-545`；现有 stack 替换顺序见 `src/index.ts:430-449`。方案声称“holder 范式”，但文件清单和伪代码没有 holder/generation 接缝。

**建议修法：** 为每个 `session_start` 分配不可复用的 generation/session token，同时保存该 session 的 `ExtensionContext` 身份；捕获、事件处理、tick 和每个 await 返回都必须验证 token/context 仍是当前会话。旧 hook 在新 session 已建立但尚未完成 stack 替换期间也必须静默丢弃。把调度器 holder 放到 `stack.ts`，由 stack 暴露当前 service，再由长期 hook 通过 holder 查当前 session，不能只靠一个模块内部的 `session` 变量。

### B2. 生命周期归属违背已拍板的 stack service 方案，reload/stack 重建没有统一 dispose 契约

**问题：** 任务已明确调度层是 `src/stack.ts` 的 service，与 watchdog/reaper 并列并随 stack dispose 释放；方案却在 `wireKeepalive` 闭包里自己建 `setInterval`，并把 `stack.ts` 作为否决项。这样同一 session 的 stack 被 `session_start` 重建时，生命周期由两个不相干的 handler 管理，无法由现有 `session_shutdown`/stack dispose 路径统一保证释放；也没有交付所要求的 holder 接缝。

**证据：** `plan.md:85-128`、`plan.md:522-545`、`plan.md:709-718`；`src/index.ts:430-466` 展示 stack 重建及 shutdown 的实际资源边界，`AGENTS.md` 的 `src/stack.ts` 约定要求每次 session_start 顶部 dispose 上一栈。

**建议修法：** 保留一次 activate 注册的 `before_provider_request` 捕获 hook，但让它只通过 holder 把捕获交给当前 stack service；service 在 `buildSessionStack` 创建、在 stack dispose 中清理 interval/abort，并由 `session_shutdown` 的既有 stack 释放路径兜底。补测 `/new`、fork、resume、reload、漏发 shutdown 四种路径，确认旧 timer 和旧 fetch 均不能触碰新 ctx。

### B3. R1 熔断对“无 usage/中途 abort/代理异常”不成立，可跨窗口无限重复烧写

**问题：** 只有收到 `cache_creation_input_tokens > 0` 才增加 `breaks` 并触发两次会话熔断（`plan.md:494-512`）。若请求已经被服务端接受并发生写入，但在 `message_start` 前被超时、网络断开、shutdown abort，或代理吞掉 usage，方案走 `onPingFailed`：清 capture、只停本窗口、不增加会话级 miss 计数。下一次真实请求又重置窗口，下一次 ping 可再次写入。这个路径可以在每个真实请求后重复，远超“代价上限一次/两次写入”。

**证据：** `plan.md:323-344`、`plan.md:494-512`、`plan.md:640-650`、`plan.md:772-779`。

**建议修法：** 把“请求已发出但结果无法证明是纯 cache read”视为不可证明命中：会话级 failure/miss breaker 必须计数并在阈值后永久禁用，至少对 timeout、abort、malformed、HTTP 429/5xx 做指数退避加会话熔断。只有明确得到 `cache_read > 0 && cache_creation === 0` 才允许继续；测试必须覆盖 accepted-then-disconnect、无 body、无 usage 和连续真实请求重试。

### B4. 速率/配额失败没有会话级急停，默认开启可能加速耗尽 OAuth/订阅额度

**问题：** 方案把 HTTP/网络/超时都定义为“本窗口失败、不重试”（`plan.md:508-512`），但真实请求会重置窗口（`plan.md:291-292`）。因此用户接近 5 小时额度或遇到 429/上游 502 时，每个后续真实请求仍可再次启动一次 ping；在后台长任务、多次主会话恢复的场景，保活额外消耗请求配额，且没有 quota-aware 开关、冷却时间、429/402/限额错误的全会话禁用。

**证据：** `plan.md:48-49`、`plan.md:567-576`、`plan.md:633-650`；风险登记 `plan.md:774-779` 未列配额/限流风险。任务背景已明确出现过 5 小时限额和 502，不能把它当普通网络失败处理。

**建议修法：** 对 401/402/403/409/429 及响应中明确的 quota/rate-limit 信号立即会话禁用；429 读取 `Retry-After`，在冷却期全局不 ping；连续网络/5xx 失败也应达到低阈值后会话禁用。失败不得因下一真实请求自动清除 breaker。默认开启前须有集成测试证明限额响应后不会再发 fetch。

## Major

### M1. 成本模型混用了“总写入成本”和“相对增量成本”

**问题：** `1.15P` 作为“吃 miss 相对一次本来就会发生的 read 的增量”是正确的，故 `0.1n < 1.15`、`n < 11.5` 也正确。但表格把“转 1h”写成 `+2P`，随后又把它当作从零开始的总成本比较（`plan.md:30-46`）。若当前选择是“下一次必然发生的 5m miss”，1h 的额外成本应为 `2P - 1.25P = 0.75P`，不是 `2P`；若选择是从零开始维持缓存，则应同时计入最终真实请求的 read，不能把两种基准混在同一阈值里。

**建议修法：** 明确区分无 ping 的最终真实请求、n 次成功 read 后的真实请求、以及下一次必 miss 时 5m/1h 的边际差额，并按预期剩余空档/真实请求数决策。不要由 `n=11` 自动推导升级 1h；`0.75P` 只是升级边际成本，不代表它总是值得。证据：`plan.md:30-46`、`plan.md:390-406`。

### M2. 短空档和后台提前结束时，默认开启必然纯亏，现有护栏挡不住

**问题：** 任务结束前缓存仍会被下一次真实请求命中时，ping 没有避免任何 miss，却已经花了 `0.1P`。例如 4 分钟首次 ping 成功，后台在第 4 分 10 秒结束，用户第 4 分 30 秒恢复：无 ping 成本为一次 read，方案多付一次 read。`minPrefixTokens=20000` 只能限制金额规模，不能判断缓存是否真的会过期或未来是否还有请求。

**证据：** `plan.md:224-241`、`plan.md:298-312`、`plan.md:603-609`。

**建议修法：** 默认开启必须采用保守的最小收益条件，例如要求后台工作持续时间/剩余 lease 的可证明下界，或首个 ping 延迟到更接近 TTL 且只对明确的长任务 armed；至少增加成本预算/每日次数上限，并把“不确定是否会恢复”按不 ping 处理。

### M3. prefix token 估算可能系统性高估，导致小前缀也发 ping

**问题：** `ctx.getContextUsage()?.tokens` 是上下文总量，不等同于带 ephemeral breakpoint 的可复用前缀 token 数；回退的 `JSON.stringify(payload).length / 4` 也不是 tokenizer，更包含消息、工具和字段开销。两者都可能把实际 P 估高，绕过 20k 下限，在小前缀/短空档中变成无意义的额外请求。

**证据：** `plan.md:176-220`、`plan.md:350-376`、`plan.md:676-690`。

**建议修法：** 用明确的保守估计（宁可低估而跳过）并记录估计来源；不能证明 breakpoint 前缀规模时直接不 ping。测试应覆盖“总 context 大但 cache 前缀小”和 fallback 包含大量非前缀字段。

### M4. 捕获指纹/失效覆盖不完整，且只比较 model id 不足以防 R1

**问题：** 方案用事件作废而拒绝 payload 指纹（`plan.md:182-220`），但 model/provider/api、工具集、认证 base URL、静态 headers 和其它扩展都可能改变实际缓存分桶；迁移表只在 tick 比较 `capture.modelId`，没有同时比较 provider/api/base URL。事件漏报或第三方 hook 排序变化时，回包熔断又受 B3 失败路径影响。

**证据：** `plan.md:176-220`、`plan.md:294-310`、`plan.md:459-463`；调研的链式 hook 证据见 `explore.md:5.1`。

**建议修法：** 捕获并在发送前比较稳定的 provider/api/model/base URL/auth-header fingerprint、cache shape、thinking/tool schema fingerprint；任何未知变化都 invalidate。若不能证明最终 payload 是本 handler 返回值，直接禁用 keepalive，而不是把熔断当唯一保障。

### M5. 默认开启的可见性不足，估算为 0 时会误导用户

**问题：** 状态栏、命令和审计条目是合理退路，但审计条目“只落 session 文件”不是运行时透明度。更严重的是成本估算在 `cost` 缺失时规定返回 0（`plan.md:688-690`），而 ping 仍可能消耗真实配额/费用，用户会看到“花费 $0”或没有 HUD 变化。

**证据：** `plan.md:578-595`、`plan.md:676-691`；`explore.md:3` 已确认 HUD 只统计官方 message entries。

**建议修法：** 在状态栏和 `/cache-ttl status` 明确显示 `estimated/unknown`、cache-read tokens、请求次数、失败/限额状态；cost 缺失时禁止显示 `$0`，显示“费用未知”。RPC/headless 模式也应提供日志或结构化审计读取方式。

### M6. 施工与测试矩阵漏掉关键安全路径

**问题：** 矩阵覆盖了正常命中、单次 creation miss 和 timer count，但没有覆盖 B1 会话接缝、stack service dispose、旧 ctx await 回写、usage 缺失导致的重复 miss、429/Retry-After/额度错误、第三方后置 payload handler、provider/base URL 变化，以及真实请求与 ping 同时开始的原子抢占。步骤 4/5 的测试仍按 `wireKeepalive` 自持 timer 的设计写，不能验证任务要求的 stack dispose。

**证据：** `plan.md:709-745`、`plan.md:749-766`；现有 stack shutdown 资源路径见 `src/index.ts:455-466`。

**建议修法：** 在施工顺序中先定 holder + stack service 生命周期，再写装配集成测试；将上述路径列为必须项。每个测试都要断言 fetch 次数、旧 ctx 没有 `setStatus`/`appendEntry`、session shutdown 后 timer/socket 为零。

## Minor

### m1. 配置项数量和 spec 说明不一致

**问题：** `plan.md:123-124` 写“4 个新 spec”，实际 `plan.md:603-609` 列出 5 个设置项；测试又要求 5 条（`plan.md:730-734`）。

**建议修法：** 统一为 5 个 spec，并明确 `TIME_SETTING_MS_PATHS` 的内部 ms path 与展示 key 映射测试。

### m2. auth 等待后没有重新检查存活边界

**问题：** 方案在 tick 时检查 `aliveUntil - margin`，但认证 `await getApiKeyAndHeaders` 之后才真正发 POST（`plan.md:542-545`）。认证等待可能把请求推过安全边界。

**建议修法：** `sendKeepalivePing` 前按当前时间再次检查 `aliveUntil - margin`，并把 auth 等待计入预算；测试 fake timer 覆盖 tick 后延迟发 POST。

### m3. unref 不等于 fetch reader/socket 已释放

**问题：** timer unref 只解决 Node 进程引用，不等于 fetch body reader 和 abort listener 已释放。

**建议修法：** 为成功早停、超时、shutdown abort、HTTP 非 2xx 分别断言 reader/socket 结束，并清理 parent abort listener。

## v2 复核

### B1：未闭合

v2 已经关闭了“新 service 已创建但尚未挂入 holder”的两段式窗口：service 在
buildSessionStack 中创建，旧实例在 build 顶部 dispose，holder 为空时捕获也会静默跳过；
不同 sessionId 的旧 payload、空 holder、以及 stale ctx 读取失败的路径也按设计会被丢弃或自我
dispose。但身份校验的实际伪代码只有 disposed 与 captured.sessionId === ownSessionId，
generation 没有进入 CapturedRequest，也没有校验“这个 port 仍是 holder.current 的同一个 service
实例”。因此同一 sessionId 的重建/reload 窗口中，旧 hook 或旧异步回调可以把带旧 payload 的调用
送到新 service 并通过 accept；仅比较 sessionId 不能证明实例仍属于当前 stack。结论是：不同会话
ID 的竞态已处理，但 B1 要求的跨实例 stale 路径仍未闭合。

### B2：未闭合

归属方向本身已改对：src/service/cache-keepalive.ts、Stack.keepalive、previousKeepalive、
build 顶部 dispose、正常 session_shutdown 兜底，以及 systemClock.setTimer/UsageBroadcaster
的自停止模式是一致的；holder 为空和 /new、fork、resume 的同模块重建路径也有明确处理。然而
方案把“漏发 shutdown”归因于 src/index.ts:433-439 的 session-start 防御块，那个代码只有在
后续 session_start 到达时才会执行；若 shutdown 漏发且没有下一次 build，既没有调用 dispose，也
没有清理在途 fetch/reader/socket。进程退出时 timer 的 unref 只证明不会阻塞退出，不等于网络
资源已释放。因此生命周期契约（尤其漏发 shutdown 的路径）尚未完全闭合。另有一处归属说明仍
不匹配：方案引用 src/stack.ts:461-470 作为 keepalive 的 shutdown 注释，但该处实际是
fleetWidget/bashJobs/fabric 字段说明，没有 keepalive 语义。

### B3：未闭合

状态机的会话级计数设计本身已正确：只有 cache_read > 0 && cache_creation === 0 是成功，真实
请求只重置窗口字段，provenWrite、unprovenTotal、consecutiveUnproven 和 disabled 不被
真实请求清零；accepted-then-disconnect、无 usage、HTTP、网络和 abort 也都被列为 unproven。
但真实请求抢占 ping 时，v2 只 abort 旧 ping，没有给这次 ping 分配窗口代际/请求 token；
runPing() 的 await 返回点只明确检查 disposed，没有检查“仍是该次 ping、仍是该窗口”。若底层
fetch 在 abort 后仍迟到返回，旧结果仍可执行 onProvenHit 或 onUnproven，污染新真实请求的
window（前者还会把 consecutiveUnproven 清零并推进旧的 aliveUntil）。这使抢占后的
accepted-then-disconnect 路径仍可能反复影响后续窗口，不能称为完全闭合。

### 锚点抽查

- src/stack.ts:99-116：存在 previous* 句柄区；previousUsageBroadcaster 在 105-106，匹配。
- src/stack.ts:445-474：存在 Stack 接口；当前没有 keepalive 字段，属于待实施位置，范围语义匹配。
- src/stack.ts:678-694：确实是 build 顶部 dispose 块，待追加位置匹配。
- src/stack.ts:1073 之后：1073 是 bashJobs 构造处，query 已在此前建立；作为“query 与 bashJobs 都已存在之后”的插入锚点基本匹配，但应写成 1074 之后更精确。
- src/stack.ts:1237+：return 实际从 1239 开始，1237+ 可用但不是精确起点。
- src/index.ts:164：确实是 wireCacheTtl(pi, settings)，但当前尚未带 holder deps；待改语义匹配。
- src/index.ts:433-439：确实是 session_start 的防御性旧 stack 清理块；不是“漏发 shutdown”本身的独立兜底。
- src/index.ts:452-466：当前 455 开始才是 session_shutdown，466 是 fleetWidget dispose；作为待追加 keepalive 的范围匹配。
- src/index.ts:443：不匹配；holder.current = stack 当前在 442 行。B1 的“同一赋值变可达”论证应改为 442。
- src/stack.ts:461-470：不匹配；这里是 fleetWidget、bashJobs、fabric 的接口说明，没有方案所称的 keepalive shutdown 注释。
- src/core/clock.ts:12-22、src/delivery/usage-broadcast.ts:91-97、src/hud/index.ts:60-64：分别存在 unref timer、幂等 dispose、stale ctx 注释，语义匹配。
- src/hud/footer.ts:178-188、src/adapters/pi-compat.ts:59、src/service/background-status.ts:10-30：引用的 usage 账本、read-back probe、全局 background-status 范式均存在且语义匹配。
- src/web-search/resilience.ts:96、src/compact-hint/threshold.ts:12、src/hud/footer.ts:4：分别存在打码循环、usage-tick custom type、扩展 status 聚合说明，语义匹配。

### 新引入的 Blocker

- B5：抢占后的迟到 ping 结果缺少窗口代际校验。abort() 不是同步取消 promise；若旧 ping 在新真实请求后返回，当前骨架没有 token/generation 守卫，可能回写新窗口并改变 breaker/存活期。必须在 ping 开始时绑定窗口代际，在每个 await 返回点及 reducer 前验证代际，失配只丢弃且不计数、不回写。

### 一句话总评

**仍需修改**：B1、B2、B3 均有未闭合项，且新增 B5；请先补齐实例/窗口代际校验与漏发 shutdown 的实际释放契约，再开工。
