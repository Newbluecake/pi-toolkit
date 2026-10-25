# T6 报告：traffic conformance 两文件 + Codex 白名单裁定

> 状态：**完成**（自验见 §6）。plan r3 §8.3 全节、§5.3（票据铸造/剥离/归属、退役规则前提）、§0 R-b、§10 T6 行；
> 接口依据 T2b-report §9（留给 T6 的退役规则前提清单）、T3-report §2/§3（装配/认领）、T5-report §1/§3（keepalive/warming 共存）。
> 写域（实际改动）：`tests/conformance/traffic.test.ts`（新，CT1–CT9）、`tests/conformance/traffic-coexist.test.ts`（新，CX1–CX6）、
> `tests/conformance/fixtures/openai-stub.ts`（新，OpenAI/codex 兼容 stub）、本报告。**未改任何 `src/`**（Codex 裁定 = 不入白名单，见 §3）。

## 1. 结论先行

- **Codex（`openai-codex-responses`）维持票据白名单外（R-b 的既定默认，无需改 `TICKET_APIS`）**：
  - SSE transport（`transport:"sse"`）：票据头经 headers 钩子 → `applyAuth` → codex 适配器 `buildSSEHeaders`（含 `options.headers`）→
    `(options?.fetch ?? globalThis.fetch)` 到达 fetch 层，且被 traffic 拦截层剥离，stub 从未收到 —— **可达且可剥离**（CT8）。
  - 默认 transport（`auto`）：pi-ai 的 codex 适配器先走 **WebSocket**；Node 22 原生 `globalThis.WebSocket` **支持 `{headers}` 选项**
    （实测握手头携带注入的头），`buildWebSocketHeaders` 把 `options.headers`（含票据）放进握手——而 **WS 握手不经
    `globalThis.fetch`**，拦截层看不到、剥不掉 ⇒ 票据会带着 128-bit 随机值直接到达 provider（CT9 实证）。
  - 不满足 R-b 的「SSE 可达**且** WS 握手不携带」⇒ 保持白名单外：只录钩子级字段、改写不生效。`T2b` 已有
    `unsupportedApiNotified` + `codexWsWarned`（`engine.codexWsWarned` 供 server 的 `codex_ws_warning`），无需新代码。
- 两文件 15 例 + 全组 `npm run test:conformance` 27 文件全绿（§6）；`npx tsc --noEmit` 0 错误；prettier 通过。

## 2. traffic.test.ts（CT1–CT9）：每条用例钉住的 pi 事实

夹具：真 `activate`（经 `additionalExtensionPaths` 指向仓库 `index.ts`，真 jiti 加载——见 §4.1 为什么不能用 factory）→
`createAgentSession`（真 `ModelRuntime`，从临时 agentDir 的 models.json 建）→ `bindExtensions({mode:"print"})`（print 模式 ⇒
`/record on` 不启动网页服务，零 listener）。`/record on` 走**真命令路径**（`session.extensionRunner.getCommand("record").handler("on",
createCommandContext())`）。观测层：观察扩展记录钩子全局序 + 装在拦截层**之上**的 fetch 探针（`/record on` 之后安装 ⇒
探针在 tap 外层，看到的是 SDK 交给 `globalThis.fetch` 的原始头）。

| #   | 钉住的 pi 事实（peer 升级时任一不成立 ⇒ 失败）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CT1 | 每个会话请求的钩子/网络全局序恰为 **headers → payload → fetch → response**；headers 事件就地可变（traffic 铸票写头依赖）；payload 事件携带完整请求体（`model`/`messages`）；response 事件携带 `status`（2xx）与响应头。                                                                                                                                                                                                                                                                                                                                                                             |
| CT2 | 三个白名单 SDK 把 `options.headers`（票据）带到 `globalThis.fetch`：anthropic-messages（SDK client `defaultHeaders`，per-request 构造 ⇒ 延迟绑定 fetch）、openai-completions / openai-responses（OpenAI SDK v7 `defaultHeaders`）。traffic 拦截层在**所有**路径剥离票据 ⇒ provider stub（本地 HTTP，记原始头）从未收到 `x-pi-traffic-ticket`；请求行被票据精确绑定（`rewrite_status` NULL 非 `unattributed`）且 `session_id` 归属正确。                                                                                                                                                             |
| CT3 | **§5.3 退役规则前提**：同一请求只有 **400 strict-tools 回退**会再次触发 `onPayload`（headers 钩子只一次——`transformHeaders` 在 `applyAuth` 每请求解析一次，回退循环在适配器内部）；回退正文确实不同（首发 `"strict":true`，回退无）；**2xx 响应头之后不再有 `onPayload`**（turn 结束后计数稳定）；**非 2xx 不调用 `after_provider_response`**（400 那次无 response 事件）。附带钉 traffic 语义：两个 generation 各一行（status 400/200）。strict 优先路径需要模型 `compat.supportsStrictTools`（pi-ai 对未知 provider 默认 false）+ builtin `read` 工具的 `constrainedSampling:{strict:"prefer"}`。 |
| CT4 | **§0 拍板 1 / T5 共存**：cache-ttl `mode=on` 在其 `before_provider_request` 返回**改写后的克隆**（pi 的 runner 把返回值替换给后续 handler），traffic 注册在 cache-ttl 之后 ⇒ 录到的 payload 含 `"ttl":"1h"`（与 stub 收到的线上字节一致）——「录到最终 payload」成立，且行仍是票据绑定（非 unattributed）。                                                                                                                                                                                                                                                                                          |
| CT5 | **§5.3 退役规则 ② 前提**：pi 原生 cache warmer（`cacheWarming:"idle"` + 模型 `promptCache.short=11` ⇒ 延迟 1s；usage 1M tokens + 价表使期望收益 ≥ $0.05 ⇒ 决策 warm）复用会话 requestOptions ⇒ **warm 请求（`max_tokens:1`）同时触发 headers 与 payload 两个钩子**（每请求恰一对）；`cache_warming_decision` 事件可见；warm 请求以本会话 id 落库。TTL 短意味着 warmer 周期重发，断言用「≥1 + 严格配对」而非精确计数。                                                                                                                                                                               |
| CT6 | **§5.3 前提**：compaction 的 requestOptions **不含 `onPayload`/`onResponse`**（`completeSummarization` 直调 `agent.streamFunction`，`buildRequestOptions` 只带 `transformHeaders`）⇒ **只触发 headers 钩子**。`keepRecentTokens:0` 时一次手动 `session.compact()` 产生**两个** summarization 请求（主摘要 + turn-prefix 摘要），二者都只触发 headers；compaction 请求不产生 payload 行（traffic 仍两行）。                                                                                                                                                                                          |
| CT7 | 子会话 = 同进程第二个 `createAgentSession`（生产子会话由 `PiSessionDriver` 以同一 `createAgentSession` + 同一 settings 在本进程创建；第二次 activate 走 `isChildSession`（HOST_KEY 已占）分支 = `assembleTrafficChild` 的真实装配路径）。子会话请求**以子会话自身 id 落库**（`session_id` 区分），同样铸票据（child 钩子）且 stub 从未收到票据。                                                                                                                                                                                                                                                    |
| CT8 | codex **SSE** transport（`transport:"sse"`）：不尝试 WS；headers 钩子注入的头（与 traffic 铸票同注入点、同传播路径）经 `buildSSEHeaders`（合并 `options.headers`）到达 `globalThis.fetch`，被拦截层剥离 ⇒ stub 未收到。⇒「若入白名单，SSE 可达且可剥离」。                                                                                                                                                                                                                                                                                                                                          |
| CT9 | codex **默认** transport（auto，先 WS）：**WS 握手携带票据头且不经 `globalThis.fetch`**（Node 原生 WebSocket 支持 `{headers}`——undici 扩展，实测握手头含注入值）；WS 失败后回退 SSE（该条被剥离）。⇒ 票据无法保证剥离 ⇒ **不入白名单**。                                                                                                                                                                                                                                                                                                                                                            |

CT8/CT9 用观察钩子注入同形票据头而非临时改 `TICKET_APIS`：白名单是 jiti 加载实例的**模块级**状态，测试侧 import 是另一个
实例，改了也不生效；注入探针与 traffic 铸票的注入点（`before_provider_headers` 就地写头）与传播路径完全一致，证明力相同且
零生产状态突变。

## 3. Codex 裁定（R-b）

**保持白名单外**（`src/traffic/ticket.ts` 的 `TICKET_APIS` 不变：anthropic-messages / openai-completions / openai-responses）。

| 判据（R-b 原文）                          | 结果                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 票据头能经 SDK 到达 fetch 且被剥离（SSE） | ✅ CT8（可达、可剥离）                                                                                                                    |
| WS 握手不携带票据                         | ❌ CT9（`buildWebSocketHeaders` 合并 `options.headers`，Node 原生 WS 的 `{headers}` 选项让握手头携带票据；握手不经 fetch ⇒ 拦截层剥不掉） |

后果（与现状一致）：codex 会话只录钩子级字段（payload/状态/响应头/消息），改写规则对其不生效并显式标注
（`unsupportedApiPayloads++` + 一次性提示「不在票据白名单，改写规则对其不生效」；`codexWsWarned` 供页面提示）。若未来
pi-ai 让 WS transport 支持 fetch 钩子或把 WS 握手改经 fetch，重跑 CT8/CT9 即可复核。

## 4. traffic-coexist.test.ts（CX1–CX6）：认领协议真装载矩阵

夹具：真 `DefaultResourceLoader`（**不用** `noExtensions`/factory）+ 临时 settings.json 的 `packages`（仓库根 + 临时外部
fixture 包——极小 `pi-traffic-record` 复刻：v0.2.1 恒活动注册 `/record`；v0.3.0 认领协议，有效 toolkit claim ⇒ 整体让位，否则
发布 `external-active`）。活动录制器数 = `toolkitClaimIsLive()`（进程符号，与生产 isActive 同源） + fixture 自报活动。

| #   | 场景                                                                                                    | 断言                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CX1 | 旧版 v0.2.1，toolkit 先加载                                                                             | session_start 复核（getCommands 权威证据）释放 claim ⇒ toolkit 不活动；外部活动；**恰 1**；双 `/record`（`record` + `record:2`）注册但只有一个活动；端到端 prompt 后唯一活动录制器（外部）payload 计数 ≥1 |
| CX2 | 旧版 v0.2.1，外部先加载                                                                                 | 同一结局（toolkit 让位），**恰 1**                                                                                                                                                                        |
| CX3 | 墓碑 v0.3.0，toolkit 先加载                                                                             | 墓碑版整体让位（零注册零命令），toolkit claim 存活；**恰 1**；只一个 `/record`                                                                                                                            |
| CX4 | 墓碑 v0.3.0，外部先加载                                                                                 | `external-active` 符号 ⇒ toolkit **零注册零 claim**（claim 符号根本不存在，非释放）；外部活动；**恰 1**；端到端外部计数 ≥1                                                                                |
| CX5 | 旧版列在 settings 但被包级 filter 排除（`{source, extensions:[]}` —— 空 patterns 显式禁用该包全部扩展） | fixture 从未加载；toolkit 活动；**恰 1**；端到端 `/record on`（真命令）+ prompt ⇒ toolkit 库有本会话的 requests/sessions 行；shutdown 后 claim 符号无残留                                                 |
| CX6 | settings 列着不存在的路径                                                                               | 外部未加载；toolkit 活动；**恰 1**                                                                                                                                                                        |

### 4.1 夹具层面的两个 pi 事实（踩坑记录，供后续复用）

1. **factory 加载的扩展 sourceInfo 是合成的（`<inline>`）**：toolkit 经 `extensionFactories` 加载时，认领复核把**自己的**
   `/record` 判为「包根外」而让位（T3 的 fail-closed 设计，行为正确）。conformance 必须经真实路径加载
   （`additionalExtensionPaths` 或 settings `packages`）。
2. **自建 `modelRuntime` 会绕过 `applyAuth`**：consult-preserve 式的手写 runtime（直调 pi-ai `streamSimple`）跳过
   `ModelRuntime.applyAuth` ⇒ `transformHeaders`（= headers 钩子）永不触发。观测 headers 钩子必须让 session 用真
   `ModelRuntime`（`createAgentSession({agentDir, model, …})`，不传 `modelRuntime`）。

## 5. 对 AGENTS.md peer 升级清单的追加（T7 落地，两行）

在「Peer dependencies on `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` …」段落之后追加：

```markdown
- Before bumping, run `npm run test:conformance` (real `AgentSession` boundary-draft contract + runtime capability
  self-check, `tests/conformance/`) — it never gates pi-compat's structural probes (I14), it just tells you ahead of users
  whether `src/context-switch/capability.ts` still reaches `verified`. **Also run `tests/conformance/traffic.test.ts` and
  `tests/conformance/traffic-coexist.test.ts`**: they pin traffic's ticket-identity premises against real pi/pi-ai (hook
  order headers→payload→fetch→response; only the 400 strict-tools fallback re-fires `onPayload`; no `onPayload` after 2xx
  response headers; non-2xx never reaches `after_provider_response`; the cache warmer fires BOTH hooks, compaction only
  headers; whitelisted SDKs carry `options.headers` to `globalThis.fetch`; codex WS handshakes carry them OUTSIDE fetch) and
  the claim-protocol single-recorder matrix with the real resource loader.
```

（两行 = traffic 两文件各一行职责说明；T7 可按 AGENTS.md 现有行文风格改写。）

## 6. 自验输出

```
$ npx vitest run tests/conformance/traffic.test.ts tests/conformance/traffic-coexist.test.ts   # 连跑两次
 Test Files  2 passed (2) · Tests 15 passed (15)   （run1: 99.50s；run2: 98.23s）

$ npm run test:conformance
 Test Files  27 passed (27) · Tests 282 passed | 17 skipped (299)   （122s；无与 traffic 无关的既有失败）

$ npx tsc --noEmit -p tsconfig.json          0 错误
$ npx prettier --check tests/conformance/traffic.test.ts tests/conformance/traffic-coexist.test.ts tests/conformance/fixtures/openai-stub.ts
All matched files use Prettier code style!
```

单文件计时：traffic.test.ts ≈ 99s（9 例，CT2 三 API ×每 API 一个会话 ≈ 24s、CT7 双会话 ≈ 17s）；traffic-coexist ≈ 52s（6 例）。
两文件并入后 conformance 全组 122s（此前约 100s），增量约 +2.5min 的 wall-clock（vitest 并行池下）。§8.4 的 CI 增量预算只看
`npm test`（conformance 不进 `npm test`），无影响。

## 7. 偏差与说明

1. **`transport` 是 pi 全局设置**（settings.json `"transport":"sse"|"auto"`，sdk.js `getTransport()`），不是 per-model——CT8
   用 settings 驱动真路径，而非伪造 options。
2. CT9 的 WS 服务器是 stub 内置的 `upgrade` 记录 + 立即 destroy：既录握手头，又让适配器走真实的「WS 失败 → SSE 回退」路径
   （生产中对坏 WS 端点的行为），回退请求同时充当「fetch 路径可剥离」的对照。
3. CT8/CT9 的注入票据值用固定 32-hex 字面量（`6edead…`/`feedface…`）而非随机——断言精确匹配，且证明「值本身无语义」
   （拦截层按头名剥离，不解析）。
4. CT5 的 warmer 周期重发（TTL 11s ⇒ 每 ~1s 一次）不停表：断言全部「≥1 + 严格配对」；turn 结束与 shutdown 会停
   （`cacheWarmer.cancel`）。
5. 遗留（不阻塞）：`npm run test:conformance` 时长 122s，主要由 rpc-spawn（121s）与 fabric-xs（96s）贡献；traffic 两文件
   合计 ~150s test-time 但并行摊平。
