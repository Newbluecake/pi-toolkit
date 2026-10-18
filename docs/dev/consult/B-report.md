# Package B — expert-history cache anchor

日期：2026-10-18。范围：`cache-thread-plan.md` §3、§8、§11 B、R1 #3/#4/#5/#18 与 R2 的锚点相关接缝。未改冻结 `src/core/**`，未提交 commit。并行 C/U/Feishu 的文件保持原样；`runtime-adapter.ts` 中 C 的 display-meta / onReaped 改动不属于 B。

## 1. 实现与放置表

`anchor.ts` 为 pi-free、无 timer/磁盘/网络模块。`resolveAnchor(payload, spec, model, options?)` 纯计算；`installConsultAnchor` 的状态只在本次安装的闭包里。

| 状态             | 放置与预算                                                                   | 比较规则                                                                     |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `added`          | 现有总断点 + 1 ≤ 4；在可信 `(k−1, block)` 加 marker，保留默认最后消息 marker | 消息断点必须恰为锚 + 最后 user/tool-result 的最后一块；两者 TTL 与专家侧相等 |
| `relocated`      | 仅 fresh 首请求且原总数恰为 4；移除最后 marker、在锚处复制                   | 消息断点只能为锚；最后消息无 marker；TTL 与专家侧相等；`degraded:true`       |
| `skipped:limit`  | 4-breakpoint 的线程续问/同 run 后续请求，或已有超过 4 个断点                 | 原请求引用/字节不变；旧 last-only 比较规则；`degraded:true`                  |
| `n/a`            | 非 Anthropic Messages，或完全没有 cache_control                              | 原请求引用/字节不变；旧规则                                                  |
| 其它 `skipped:*` | 见下表                                                                       | 原请求引用/字节不变；旧规则                                                  |

只在 `PiSessionDriver.resume` 的 `isConsultForkSpec(spec)` 且带 `consultAnchor` 时安装（C2 preserve 和 main readonly 两支均支持）。安装顺序：anchor 内层 → 扩展原 `onPayload` → prefix-probe 外层；原扩展看到加锚后的 payload，外层探针看到扩展处理后的最终 payload。原扩展的 replacement / undefined / throw 语义保留。

`create` 的 probe 安装不改；普通 resume 不安装 anchor。即便普通 run 错带 anchor spec，仍不改 provider 请求、不发首结果事件。T-A1 对普通 create/resume 均断言原 payload 引用、JSON 字节和 hook 返回值。

## 2. 可信身份与失败原因

首次只接受末条 user 的**唯一** text 块与 host `spec.prompt` 精确相等；历史坐标 `k = messages.length − 1`，从历史末条消息的末尾逆序找 `text|tool_use|tool_result|image`，跳过 thinking/redacted_thinking。身份保存 blockHash、整个原历史 prefixHash、systemHash、toolsHash、route 和 TTL。哈希按 JSON 的实际字段顺序计算；只忽略消息里的 cache_control。

后续请求/带 base 的线程请求逐一验证上述全部身份，坐标也检查为有效整数和有效块类型。身份验证不能用当前 marker 反推坐标。失败不改正文、不回退到另一个坐标。

| 原因                      | 触发                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `skipped:shape`           | payload/messages/route 不完整、问题不精确匹配或不是唯一 text、默认消息 marker 不唯一/不在末块、非 ephemeral marker、不支持的 TTL |
| `skipped:block`           | 原历史末消息没有可缓存块（包括只有 thinking/redacted_thinking）                                                                  |
| `skipped:identity`        | 坐标、块类型/内容、任一历史内容（含 thinking signature）、system/tools、provider/model/api 或 TTL 漂移                           |
| `skipped:limit`           | provider 的 4-breakpoint 预算不能容纳锚；只有 fresh 首请求恰好 4 个时允许 relocated                                              |
| `skipped:ttl-1h-unproven` | 本请求显式 1h，但该 route 未有 P0 完整锚形状 + 读回的证据                                                                        |

首请求 n/a/shape/block 或不能建立基线时停止本 run 的锚尝试，不能在后续变长的历史里重新猜 k；身份失败同样 sticky。合法基线则逐请求重新应用，以覆盖 P0 M3 的 20-block 回看限制。OAuth 同一逻辑首请求的重试保持 relocated；上下文推进后，后续默认 4-breakpoint 请求保持原样并记 skipped:limit。

此外，raw/hash 比较器都用 `anchorIdentityMatches` 再验证**最终 payload**的 block/prefix/system/tools 哈希；扩展若在内层加锚之后更改锚内容或 thinking signature，比较结果 messages=false。该检查是诊断，不是新的发送拒绝闸门。

## 3. TTL 与断点计数

- 只统计 tools、system blocks、message content blocks 上的顶层 cache_control，不深入 schema/input/result 的应用数据；新增只能使总数 ≤4。溢出不删 system/tools marker；唯一允许的删除是 fresh 首请求 relocated 时的最后消息 marker。
- marker 值复制本请求已有最后消息 cache_control；system/tools 对象及字节不变；普通 5m（ttl 缺席）不自动升级。
- 与方案作者核对后的 P0 冻结允许表：`ANCHOR_1H_ROUTES = ["cr-anthropic/claude-opus-5-5"]`。只在**本请求已显式 1h**时复制 1h。sonnet 只有 landing，仍跳过；其它未验证 route 也跳过，原请求不变。
- M7 landing/readback 不代表 >5 min 存活；B 不更改任何默认 TTL。C 的预测/Phase 2 keeper 仍应按 5m，直到另有存活实验。
- OAuth M4 未实测：4-breakpoint relocated/limit 一律 degraded；C 预判应为 unknown，不承诺基线命中。

## 4. 首结果与探针接缝

- adapter 从 `SpawnRequest.consultAnchor` 显式透传到 driver-facing SessionSpec，仅 consult fork；NOT_THREADED 规则和 core 不变，不进入模型 prompt。
- probe 现在也识别无 consultGuard 的 main fork，保留逐请求记录。
- `installPrefixProbe` 返回值仍是可调用 cleanup，新增只读 `.record`；driver 持有本地 record 引用，诊断 registry 的 64-run FIFO 淘汰不会让 first 事件丢失。
- probe 在 bind 订阅之前将 assistant message_end 配对到请求。driver 在转发首个成功 assistant `message_end` **紧接着**发一次 `consult_cache_first`，用 A 的 `classifyConsultCacheResult` 和该成功请求 usage（错误/中止不抢占 first；详见复验修正节）。toolResult/keepalive 事件不抢占 first；无真实 request 不伪造事件；首响应无 usage 则 n/a，后续命中不能覆盖它。
- 两套比较器共用 `compareMessageBreakpoints` 状态表和同一组测试夹具；`PROVIDER_PREFIX_FIELDS` 未改。

### C / U / E1 接棒

进程内事实（不写入 core/journal）：

```ts
RunPrefixRecord.anchor?: AnchorObservation; // 首个 wire attempt 事实，不随 replay 覆盖
RunPrefixRecord.firstSuccessful?: PrefixRequestRecord; // 首个成功响应 attempt（重试后的证据以此为准）
PrefixRequestRecord.responseOk?: boolean; // error/aborted/superseded 为 false
PrefixRequestRecord.anchor?: AnchorObservation; // 本请求状态
PrefixRequestRecord.anchorIdentityValid?: boolean; // 最终 body 的身份复核
AnchorObservation = { state, identity?, degraded? }; // added/relocated 必有 identity
```

- **C**：优先选 `record.firstSuccessful` 的身份/usage；兼容旧记录才 fallback `record.first`，显式 `responseOk:false` 的失败/被替代 attempt 不可证明温暖。`record.first?.anchor?.identity`（或 `record.anchor?.identity`）是最初的 wire 基线；`first.startedAt` 是请求开始，`first.endedAt` 是收到响应。`diag.first.at` 则是 dispatch 时刻，不能拿它延长 TTL。只有 added/relocated + 合格 usage，且没有 degraded/identity drift，才可作为证明触达。first 的状态不能被 latest 的 skipped:limit 覆盖。线程事实仍由 C 一份事实投影到自身 `consultThread` 和 asker `probe.thread`，B 不生成线程 id。
- **U**：读 A 冻结的 `diag.consultCache`/`consultThread`；B 发的 first 带真实首请求 anchor/degraded，不从累计 usage 计算。旧 run/没有首请求的 run 可缺 first。
- **E1**：raw C1/C11 调用 `comparePayloadPrefix(expertBody, consultBody, requestRecord.anchor)`（requestRecord 必须对应同一个 raw body，重试成功时取 firstSuccessful）；哈希版直接 `compareRecordedPrefix(expertLast, consultFirst)`。状态/坐标由 record 提供，不能从 HTTP marker 倒推。新的生产链 C1/C11/C12/C14 仍归 E1，B 不改 conformance 文件。旧 consult-preserve 全部现有用例继续通过。

## 5. 测试与自验

B-owned 四个测试文件覆盖：放置真值表、eligible 块、跳过 thinking/signature 保真、prompt 精确匹配、基线 sticky 失败、3→4/4→relocated/4→skipped、TTL allowlist、thread base 全身份验证、>20-block 的三轮 replay、hook 顺序/replacement/error、两套比较器共享夹具及最终内容漂移、普通请求引用/字节相等、adapter 实际透传、main/C2、first 顺序/写一次/用量配对/缺用量、registry 淘汰不丢事件。

实际验证日志位于 `/tmp/consult-B-{owned-tests,tests,typecheck,build,conformance}.log`。并行写包期间遇到过 U/Feishu 的临时类型错误以及 C fresh 字段的旧 schema 断言，均未越权修改。

最终收口结果（所有命令均实际执行，退出码 0）：

| 命令                                                                                                                                                                                                                                | 结果                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `timeout 280 npm run typecheck`                                                                                                                                                                                                     | 14:33 最后重跑通过（tsc 两配置 + vue-tsc）                                                                                         |
| `timeout 900 npx vitest run tests/consult tests/runtime tests/service tests/core`                                                                                                                                                   | 14:33:44：**104 files / 1955 tests passed**，包含并行 C 已落下的测试                                                               |
| `timeout 280 npm run build`                                                                                                                                                                                                         | 14:33 最后重跑通过                                                                                                                 |
| `timeout 900 npm run test:conformance`                                                                                                                                                                                              | 14:22：**17 files / 129 passed / 17 skipped**；droid 未开启 opt-in、consult C8 等原有跳过                                          |
| `timeout 120 npx vitest run tests/consult/anchor.test.ts tests/consult/prefix-probe.test.ts tests/consult/preserve-identity.test.ts tests/runtime/session-driver-consult-anchor.test.ts tests/conformance/consult-preserve.test.ts` | 最后 source 加强后的 14:32 重跑：**5 files / 69 passed / 1 skipped**；其中 B-owned 62 tests，consult-preserve 7 passed / 1 Q5 skip |
| `timeout 60 npx prettier --check <本报告列出的十个精确路径>`                                                                                                                                                                        | 14:33 通过；仅对 adapter 中 C 已加入的 port 签名做了一处换行格式修正，无语义改动                                                   |

并行写入造成的临时失败均已在最后重跑中消失，B 无已知实现阻塞。尚未覆盖的产品闸门：OAuth 真实路线 M4、>5 min 的 1h 存活、E1 新的生产链 C1/C11/C12/C14；均不冒充已完成。B 没有运行整个仓库 `npm test` / web build，根会话收口负责全仓检查。

## 6. B 文件清单（绝对路径）

1. `/home/bluecake/ai/pi-toolkit/src/consult/anchor.ts`
2. `/home/bluecake/ai/pi-toolkit/src/consult/prefix-probe.ts`
3. `/home/bluecake/ai/pi-toolkit/src/consult/preserve-identity.ts`
4. `/home/bluecake/ai/pi-toolkit/src/runtime/session-driver.ts`
5. `/home/bluecake/ai/pi-toolkit/src/service/runtime-adapter.ts`（仅 consultAnchor 透传 hunk 属于 B）
6. `/home/bluecake/ai/pi-toolkit/tests/consult/anchor.test.ts`
7. `/home/bluecake/ai/pi-toolkit/tests/consult/prefix-probe.test.ts`
8. `/home/bluecake/ai/pi-toolkit/tests/consult/preserve-identity.test.ts`
9. `/home/bluecake/ai/pi-toolkit/tests/runtime/session-driver-consult-anchor.test.ts`
10. `/home/bluecake/ai/pi-toolkit/docs/dev/consult/B-report.md`

## 7. Follow-ups after r_QGP99QKS

2026-10-18：Sonnet 验收 conditional pass、0 blockers 后，按调用方要求修复 #1/#2/#3/#5/#6，未提交 commit，未改任何冻结 core 类型，也未修改 C 在 runtime-adapter.ts 中的 hunks。下面结果覆盖本报告先前的首响应/断点计数说明。

| Finding                                     | 修复                                                                                                                                                                                                                                                                                                                                                                       | 回归证据                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — nested cache_control 误计**           | `providerCacheControls` 只枚举 tools、system blocks、message content blocks 的直接 marker；不递归进入工具 schema、input、嵌套 tool-result 数据。预算和 TTL 检查共用这一枚举。                                                                                                                                                                                              | 三个真实断点 + 三种嵌套业务同名属性仍为 added、非 degraded，保留 pi 最后 marker；只有嵌套业务键则 n/a。原 body JSON 字节不变。                                                                                                   |
| **2 — final identity invalid 未带入 first** | classifier 的 degraded 参数是 `anchorIdentityValid === false ? true : anchor.degraded`；anchor 仍如实记录实际放置 added/relocated，不假装未曾放置。                                                                                                                                                                                                                        | 扩展在内层之后改写 system：probe valid=false，first 实测 hit 仍保留，但新增 degraded:true。                                                                                                                                      |
| **3 — retry 幂等与首结果抢占**              | 首逻辑请求用完整 messages（去 marker 后）的 SHA-256 识别，只保存哈希；相同逻辑请求的重入继续 relocated，任何消息上下文推进后永不重新获得 first 特权。probe 在 consult 的新 onPayload 到来时将未结束旧 attempt 标为 responseOk:false，响应归给最后 attempt；`firstSuccessful` 只在非 error/aborted assistant message_end 设置。driver 只从 firstSuccessful 生成写一次结果。 | 连续三次同首请求 relocated；同消息数但新问题进入 skipped:limit；推进后重新发送旧请求仍 skipped:limit。error 和 aborted 均不抢占 first，成功重试后发一次 hit；没有中间 message_end 的两次 onPayload 也将 usage 归到后一 attempt。 |
| **5 — host spec 泄漏**                      | C2 解构显式移除 consultAnchor；`toCreateOptions` 也统一移除此 host-only 字段，覆盖 main/普通 create/resume，原 spec 仍留给宿主安装 hook。                                                                                                                                                                                                                                  | main 和 C2 两支都断言传给 createAgentSession 的 options 不带 consultAnchor（也不带 consultGuard），锚 hook 仍成功安装。                                                                                                          |
| **6 — TTL ordering**                        | 在返回变更前按 Anthropic 工具→system→messages 的缓存前缀顺序检查 marker；见过短 TTL 后不得出现 1h（缺省 TTL 视作 5m）。违例 `skipped:ttl-order`，返回原引用/原字节，不规范化 system/tools。                                                                                                                                                                                | 隐式 5m、显式 5m 两种短 TTL，在 tools/system 两位置、added/relocated 两种预算下都拒绝 1h-after-5m；合法 1h→5m 则接受且原 marker 不变。                                                                                           |

### #3 的 pi 1.2.0 重试路径核实

已读本地实际安装代码，而不是假设 onPayload 只会调用一次：

- `pi-ai/dist/api/anthropic-messages.js:435–465`：onPayload 在 strict-tool grammar fallback 的 `for (;;)` **内部**，因此严格工具降级可在没有 assistant/error message_end 的情况下重入。`retryProviderRequest` 在 onPayload **之后**调用；普通 HTTP retry 复用 params，不再次调用 onPayload。
- `pi-coding-agent/dist/core/agent-session.js:3057–3094`：AgentSession `_prepareRetry` 会持久化原失败 attempt，但用 `_omitRecoveryAttempt(message)` 从模型投影中移除，再继续调用 provider。因此下一次 onPayload 可收到与原首请求相同的消息。
- `pi-agent-core/dist/agent-loop.js:298–333`：error 也会发 assistant message_end，原实现确实会把零 usage 消费为 n/a。现 error/aborted 的 attempt 只留下 responseOk:false；如果最终始终无成功响应，不伪造 `consult_cache_first`。成功响应本身缺 usage 仍只发一次 n/a，这是“成功但无法测量”，不是失败抢占。
- 以上是源码路径核实 + B 文件内事件/重入回归；真实生产安装链 + HTTP 边界的新 conformance 仍归 **E1**，没有将模拟驱动用例冒充生产链验收。

### 更新后的 C / E1 接棒

`RunPrefixRecord.first` 继续表示第一个 wire observation，不改语义；新增 `firstSuccessful` 表示首个成功 attempt。`requests` 仍保留全部 attempt 供费用归集；失败/被 fallback 替代的 attempt 不冒充成功触达。C 的 cacheProbe / ledger / thread base 应优先取 firstSuccessful，兼容旧记录才取 first，并拒绝 `responseOk === false` 的证明；原 first 与对应 raw body 的比较仍有效。此 API 提醒已发给调度方转交 C。

**Finding 4 交由 E1**：新的 C1/C11/C12/C14 必须走 SpawnService → consult tool → fork-store → threads → adapter → driver 的生产链。B 的现有 conformance 通过不等于该新增闸门已经完成。E1 还应在真实 retry 的 raw 请求与 probe 对应关系上检查：first 与 firstSuccessful 不一定指向同一 attempt，不能把成功响应 usage 配到已被替代的 body。

### 修正后自验

- `timeout 280 npm run typecheck`：通过。
- `timeout 900 npx vitest run tests/consult tests/runtime tests/service tests/core`：**105 files / 1975 tests passed**（14:50:03，26.39s）。
- `timeout 900 npm run test:conformance`：**17 files / 129 passed / 17 expected skips**（14:50:03，101.37s）；consult-preserve 现有用例继续通过。
- 定向首次回归：anchor 39 / prefix-probe 6 / session-driver-consult-anchor 17，共 **62 passed**。
- `timeout 280 npm run build`：通过；十个精确 B 文件 `prettier --check` 与本轮文件 `git diff --check`：通过。日志为 `/tmp/consult-B-follow-{unit,tests,typecheck,conformance,build,prettier}.log`。

本次追加修改仅：`src/consult/anchor.ts`、`src/consult/prefix-probe.ts`、`src/runtime/session-driver.ts`、`tests/consult/anchor.test.ts`、`tests/runtime/session-driver-consult-anchor.test.ts`、本报告。没有修改 C 的实现或测试。

## Verification

r_QGP99QKS (Sonnet) conditional pass → follow-ups 1/2/3/5/6 fixed → re-verified r_C7DC7FB0: pass, no regressions. Finding 4 (production-install-chain conformance) is E1's.
