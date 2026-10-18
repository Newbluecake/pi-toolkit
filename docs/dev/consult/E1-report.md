# Package E1 — cache/thread production-chain conformance

日期：2026-10-18。依据：`cache-thread-plan.md` §11 C1、C11、C12、C14 与 §R2-5；A `73554a3`、U `815e6da`、B+C `05dc95e` 的交接。只修改测试/夹具和本报告；未修改 `src/`，未提交 commit。并行包的工作区改动未暂存、回滚或覆盖。

## 1. 真实装配链及观察接缝

新增 `fixtures/consult-production.ts` 使用真实 pi 1.2.0 SDK：

```text
DefaultResourceLoader(extensionFactories: [真实 exported activate])
  → createAgentSession → bindExtensions / 真实 session_start
  → 真实 buildSessionStack / wireConsult
  → activate 注册的 Agent 工具（包含 experts 白名单解析）
  → SpawnService → runtime-adapter → RuntimeRunner → PiSessionDriver
  → 真实专家 session 文件
  → asker 模型真实调用 consult 工具
  → fork-store → threads → adapter → driver.resume
  → C2 guard + adapter shadows + anchor + prefix-probe
  → pi-ai Anthropic adapter → 127.0.0.1 HTTP/SSE 桩
  → 真实 usage / consult_cache_first / tool_end / asker 费用与探针 fold
```

主会话通过 SDK 的 inline factory 加载真实 `activate`，便于 Vitest 的 **call-through** `buildSessionStack` 包装只读取其返回对象；不是 mock stack、手造工具或手工拼 hooks。子会话完全通过临时 `settings.json` 中的绝对 `index.ts` 路径加载真实包（jiti），不继承主会话的 factory。专家自身 `childExtensionMissing` 缺席验证子扩展确实激活。

`PiSessionDriver.create/resume` 的观察包装均调用原函数。dispose 观察器调用真实 dispose，记录前后是否为 head；ordinary onPayload 观察器调用原链，记录原始引用/JSON 与返回引用/JSON。没有替换 driver/runner/guard/anchor，也没有自行安装生产 anchor/guard。既有手工 fork 的 C1–C7 保留为 supplementary，不冒充 E1 生产链闸门。

隔离：临时 HOME、agent dir、models/settings、session/fork 文件；`PI_OFFLINE=1`；所有模型路由均指向本地桩。关闭外部通知、配额、保活、标题模型等非本包功能。真实 pi 的主题初始化仅用于避免 RPC 下 cache-status 钩子的测试环境错误。

## 2. 用例与断言

| 用例                         | 证明内容                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 + C12（非 OAuth）**     | 首请求 `added`，消息断点精确为可信 anchor + 最后 user 块，总数 4；调用 `comparePayloadPrefix(expertBody, consultBody, first.anchor)` 与 `compareRecordedPrefix`，逐项相等且 prefix 比较全部 true；逐字段与逐消息哈希从 HTTP body 重新计算。                                                                                       |
| **C12 完整追问**             | 第 2 问 messages（去相对 marker 后）精确等于第 1 问 messages + 完整 A1 + Q2。A1 中部唯一 sentinel 在 caller 截断结果中缺席、在第 2 问原始 body 中完整存在。R2 follow-up #2 行、结果首行、两侧投影的同一 thread id / seq=2 都有断言。                                                                                              |
| **C12 seal / 物理文件**      | 真实 dispose 前、dispose 返回后、onReaped 之前都不是 head；正面 `disposed:true` 后才能在下一 asker 请求处看到 retained head。第 1 问后 fork1 存在；第 2 问晋升后 fork1 消失、fork2 存在，独立于后来的 fresh 清理。专家原文件字节完全不变。                                                                                        |
| **C12 loadout / prefix**     | 原 session 与最终 head 的工具声明、systemSections 相同；第 1 问新增 provider 消息只有 user/assistant，没有新的 system/tool 声明。完整安装链还会新增一条非 provider 的 `subagent:prompt-sections` custom entry（真实 prompt hub 的持久化快照），明确断言而非忽略。真实 C2 guard 已安装，`Agent` / `set_model` 声明是冻结 shadows。 |
| **C12 anchor / usage / U**   | 第 2 问复用第 1 问的完整 anchor identity；stub usage 与首请求 probe 一致；`diag.consultCache.first` 实际存在、与 asker probe 的 cacheResult 一致；第 2 问预测 warm，证据为 anchor-ledger 且 touch 时间精确来自第 1 问 request.startedAt；从真实 diag 可导出 `t#2 warm·hit N%`。                                                   |
| **C12 fresh / close**        | `fresh:true` 回到原专家历史、丢弃此前 Q/A、使用新 thread id / seq=1。真实 session_shutdown 调用 close 时 asker 仍在等待受控 HTTP 响应；关闭后 heads/forks/usedBytes=0，threads 已关闭、views 空、ledger 空、guard 释放、consult 目录空，幂等 shutdown 不泄漏。                                                                    |
| **C11 OAuth**                | 本地 synthetic `sk-ant-oat…` token 触发真实 pi-ai OAuth 转换；首请求 relocated、只留 anchor 消息断点、总数 4；第 2 问严格 `skipped:limit`、只有 pi 默认最后 user marker、总数 4，原 head/A1/Q2 仍精确保留，unknown/degraded 如实显示。                                                                                            |
| **before_agent_start shape** | 一个真实从 settings 加载的测试扩展注入 custom message，使首请求问题不再满足唯一文本块形状；实际 HTTP 消息含注入文本，anchor=`skipped:shape`、legacy last-only，总数 3；consult/asker 均 completed，cache first 与 raw/hash 比较正常，无错误或 ledger warm 证据。                                                                  |
| **生产 guard 补充**          | consult 模型真实尝试 builtin `write`、adapter `Agent`、`set_model`；三个结果均为 disabled error，guard 统计 3 calls / 1 batch / 未 terminated，没有写文件、没有新增 nested run；下一请求 anchor 重放且正常回答。                                                                                                                  |
| **C14 × 2**                  | 非 OAuth 与 OAuth 各运行真实普通 create + 普通 resume；onPayload 输入/输出引用相等、JSON 字节相等，HTTP body 与 SDK native payload 的 body 投影逐字节一致；消息断点只在最后 user 块，总数分别 3/4，无 consultCache/consultThread/anchor 字段。resume 前等真实 live-session-file 标记释放，不绕过原生安全门。                      |

哈希对照有一个 SDK 事实：Anthropic SDK 把 `params.betas` 从 JSON body 移到 `anthropic-beta` HTTP header。测试从该 header 的有序数组重算其哈希，其余字段直接从 raw body 重算；没有因此放宽任何 anchor/TTL 比较。

## 3. 本地缓存桩

`AnthropicStub` 新增 opt-in `promptCache`（旧测试默认 usage 与行为不变）：

- 用模型、工具、system、消息 role/块的逐前缀字节哈希作 key，忽略相对 cache_control。
- 只有显式 breakpoint 写入；读取只在每个显式 breakpoint 的至多 20 块回看范围内查既有写入；读最长匹配前缀，再写增量。
- token 数为确定性的序列化字符估算；通过真实 SSE usage 交给真实 pi-ai 解析，不直接注入 reducer/diag/ledger。
- raw request 上保留本次 responseUsage 供交叉断言；支持受控异步 reply，稳定保持 asker 存活到 shutdown 测试点。

该桩用于证明安装链、前缀与记账/分类行为，不宣称复刻 Anthropic tokenizer、真实账单或中转缓存实现。

## 4. 发现的阻塞及解决

首次生产 OAuth 测试准确失败：首请求 relocated，而线程第 2 问也 relocated，违反 C11/§3.4。E1 按限定停下并上报，未修改 src、未放松严格断言。

用户裁定：C 包对首个成功请求的**有效 identity**保留线程 base，不论 degradation。C dev `r_24SVEM18` 在 `src/consult/tool.ts` 完成该修复（E1 验证时为并行未提交改动）。修复后原严格断言通过：第 2 问 `skipped:limit`、pi last-message marker 完整保留、总数 4。

复测还纠正了 E1 自己的一个额外假设：生产 ledger 可以存 degraded entry，预测器将其映射为 `unknown(degraded-anchor)`，不等于 ledger 必须 size=0。测试改为断言所要求的 unknown/degraded 行为；**未改动** anchor 状态、精确断点位置或断点总数断言。此项不是生产源码缺陷。

## 5. 自验

最终均实际执行，退出码 0：

```text
$ timeout 900 npm run test:conformance
 Test Files  17 passed (17)
      Tests  135 passed | 17 skipped (152)
   Start at  15:39:05
   Duration  98.82s (transform 6.68s, setup 718ms, collect 21.84s, tests 243.92s, environment 3ms, prepare 1.01s)
EXIT_CODE=0

$ timeout 280 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
EXIT_CODE=0

$ timeout 280 npm run build
> tsc -p tsconfig.build.json
BUILD_EXIT_CODE=0

$ timeout 60 npx prettier --check <本报告列出的四个精确文件路径>
Checking formatting...
All matched files use Prettier code style!
EXIT_CODE=0
```

最终 suite 中 `consult-preserve.test.ts` 为 **13 passed / 1 Q5 skipped**，6 个新增生产链用例全部通过。`git diff --check -- <四个精确路径>` 通过。费用还断言 consult run 的实际 costUsd 总和为正、与 asker `diag.consults.costUsd` 相等，并包含在 asker 累计 usage 中。

最终日志：`/tmp/consult-E1-{conformance,typecheck,build}-final.log`。本包首次全 conformance 的红灯证据仍保留于 `/tmp/consult-E1-conformance.log`（OAuth 修复前：16 files passed / 1 failed；130 passed / 1 failed / 17 skipped），没有被最终 green 覆盖。

## 6. 范围外与残余

- **M4 OAuth live 未测**：synthetic OAuth token 只证明真实 pi 的 4-breakpoint 请求形状、relocated/limit 与 degraded 投影，不证明任何 OAuth 上游缓存命中。
- **1h 存活未测**：没有外部网络请求、没有跨 5 min/1h 等待，不替代 P0/M7 或 TTL 存活实验。
- 不实现 Phase 2 C13、C-K*、ping、鉴权重建或 owner 计费；保活在夹具中关闭。
- 本包新生产链用例均为成功首响应；首失败/strict-tool HTTP fallback 的 raw-first / firstSuccessful 分流仍由 B 的单元/driver 测试覆盖，本包未新增该 HTTP 失败场景。
- 既有 C8 仍按 Q5 unresolved 明示 skipped，未删除或改成假绿。
- 本包只跑所列 conformance/类型/构建/格式检查，不声称完成全仓 npm test 或 web 构建/真机验收。

## 7. E1 文件清单（绝对路径）

1. `/home/bluecake/ai/pi-toolkit/tests/conformance/consult-preserve.test.ts`
2. `/home/bluecake/ai/pi-toolkit/tests/conformance/fixtures/anthropic-stub.ts`
3. `/home/bluecake/ai/pi-toolkit/tests/conformance/fixtures/consult-production.ts`（新增）
4. `/home/bluecake/ai/pi-toolkit/docs/dev/consult/E1-report.md`（新增）
