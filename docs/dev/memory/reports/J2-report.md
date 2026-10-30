## J2（Jev 引擎）交付报告

### 文件清单（绝对路径，行数）

**新建 src（pi-free root）**

- `/home/bluecake/ai/pi-toolkit/src/memory/jev/client.ts` — 441 行，`createJevClient`
- `/home/bluecake/ai/pi-toolkit/src/memory/jev/health.ts` — 246 行，`classifyError`/健康表/令牌桶/`summarizeStatus`/`notifyFor`/`coverage`
- `/home/bluecake/ai/pi-toolkit/src/memory/jev/proxy-fetch.ts` — 306 行，`parseProxyUrl`/`createProxyFetch`/`redactProxyUrl`
- `/home/bluecake/ai/pi-toolkit/src/memory/jev/questions.ts` — 376 行，六类问题构造 + 分批
- `/home/bluecake/ai/pi-toolkit/src/memory/jev/decide.ts` — 346 行，`effectiveMeta`/各 decide*/判定缓存

**新建测试**

- `tests/memory/jev/{client,health,proxy-fetch,questions,decide,questions-eval-parity}.test.ts`（481/298/163/230/364/65 行）
- `tests/memory/jev/helpers/{fake-registry,fake-proxy}.ts`（132/180 行）

**修改**

- `scripts/dev/jev-eval.mjs` — gate/tag/review 三个模板改为与 `questions.ts` 逐字一致的形状（见下）；CLI 入口加 `import.meta.url` 守卫避免被 import 时触发网络调用。

未碰 J1 文件、`src/memory/` 其它文件、任何 fixtures（`git diff --stat HEAD -- tests/fixtures/` 为空；对 `origin/dev` 的 diff只是 J0 既有产物，已用 `git diff --stat HEAD` 排除）。

### §2 导出对照

`client.ts`:`createJevClient`、`health.ts`:`classifyError`/`errorCode`/`getHealthTable`/`clearHealthTable`/`createTokenBucket`/`summarizeStatus`/`notifyFor`/`coverage`、`proxy-fetch.ts`:`parseProxyUrl`/`createProxyFetch`/`redactProxyUrl`、`questions.ts`:`estimateTokens`/`splitBatches`/`buildRecallQuestion(s)`/`buildErrorQuestions`/`buildTagCoreQuestions`/`buildTagQuestions`/`buildTagMajorQuestions`/`buildReviewQuestions`/`buildGateQuestions`、`decide.ts`:`effectiveMeta`/`decideRecall`/`decideErrorRecall`/`decideTagging`/`decideUserLikeSuggestion`/`decideReview`/`decideGate`/`evidenceTier`/`strictest`/`verdictKey`/`createVerdictCache`。全部消费 J1 `contracts.ts` 冻结类型，未改动 contracts.ts。

### 代理 12 例结果（本地假代理 + 假上游，openssl 自签证书，不联网）

①JSON 往返 ②chunked 重组 ③代理端口拒连→`proxy error:`(瞬态) ④CONNECT 407→`proxy error:` ⑤CONNECT 502→`proxy error:` ⑥TLS 握手失败(SAN 不符)→`proxy error:` ⑦上游 402 不被吞为代理错误 ⑧abort 销毁 socket ⑨静默上游按预算超时 ⑩>1MB 响应体拒绝 ⑪非 https 目标即时拒绝 ⑫无悬挂句柄。外加 URL 解析表驱动（`https://`/`socks5://`/乱码→未配置）。全部通过。

### 错误分级表

401/402/403/451→unavailable(隔离1h)；429/5xx/超时/无码兜底→transient(连续3次隔离10min)；`proxy error:` 前缀优先 transient；含 context/too many tokens/maximum context→context(拆半重试一次,不计熔断)；关键词兜底 FreeTierError/Insufficient/unavailable→unavailable，rate limit→transient。`client.test.ts` 钉住链式 451→402→成功、瞬态熔断+恢复、全部失败、context 拆批、预算/令牌桶、并发上限(sync≤3/background≤4)、onStatusChange、abortBackground、probe 强刷、有凭证≠可用。

### jev-eval.mjs 模板改动

- recall 模板本就与 arch/questions.ts 逐字一致，未改。
- gate：从两道 bool 改为架构稿 §6.4.3 的单 choice 模板（`buildGateQuestions(state, guardEntries)`），数据集无真实规则正文/证据，故用一条合成通用守护条目代表全部用例；评分因此把 hold/hold-evidence 合并成 `block`（二者的区别来自代码层 inline `gate=hold`+进程证据，不是分类器能回答的问题）——已在脚本注释与下方遗留项标注。
- tag：改为只跑真实的 5 个 `m_*` 固定题（`buildTagCoreQuestions`），舍弃原来自造的 `m_user`；`t_*`/`c*` 需要 taxonomy/比较候选，数据集没有，未跑。
- review：从两道 bool 改为架构稿 §6.3.3 的单 pair choice 模板；数据集无 `updated` 日期，两侧均代入 `today`（削弱 supersedes 方向的可信度，duplicate/conflict/complementary/unrelated 仍可评测）。
- 新增 `questions-eval-parity.test.ts`：对 recall/tag-core/gate/review 四类模板用相同输入比对脚本 vs `questions.ts`，5 例全绿。

### 自验命令与真实输出

```
timeout 300 npx vitest run tests/memory/jev tests/boundary/pi-free.test.ts
→ Test Files 16 passed; Tests 399 passed
timeout 600 npm run typecheck && timeout 300 npm run format:check
→ 均无输出/绿（format:check: "All matched files use Prettier code style!"）
grep -n "setTimeout\|setInterval" src/memory/jev/*.ts
→ client.ts:258（abort 超时，已 .unref()）、proxy-fetch.ts:215（整请求硬超时，已 .unref()）——逐处旁边都有 unref 调用
git diff --stat origin/dev -- tests/fixtures/
→ 仅 jev-off-golden.json（J0 既有产物，本地 dev 领先 origin/dev 24 commit 所致；git diff --stat HEAD -- tests/fixtures/ 为空，证明 J2 零改动）
timeout 600 npx vitest run tests/memory/jev/off-golden.test.ts
→ 8 passed
node scripts/dev/jev-eval.mjs --dry-run --set gate | head -60
→ 正常打印 g_g01 choice 问题 JSON
```

另跑 `timeout 300 npx vitest run tests/memory/jev tests/boundary/pi-free.test.ts tests/web-hub/boundary.test.ts` → 17 files / 419 tests 全绿。

### 遗留与上报事项

1. **C-J8 门控未跑**（无凭证）：context 类错误的真实措辞沿用 arch 列的三个关键词（`context`/`too many tokens`/`maximum context`），未经真机验证，按计划列为遗留。
2. **gate/review 评测集字段不足**：`jev-gate.json`/`jev-review.json` 缺真实规则正文、运行证据、`updated` 日期，已在脚本注释里说明用合成数据/今天日期代入、hold 与 hold-evidence 合并评分；`jev-tag.json` 只能验证 5 个 `m_*` 核心题，`t_*`/`c*` 未覆盖。此前已上报并获主会话许可（"评测集字段不够时可以在脚本里做适配"），未改评测集 JSON 本身。
3. `decideTagging`/`effectiveMeta`/`decideReview` 等函数签名比 jev-plan §4 文字描述多了必要参数（如 `file`、`taxonomy`），因为这些值是 EntryTags/ReviewSuggestion 契约要求但原文未列全——均为新增参数、未改冻结类型，J4/J6 消费时需注意实际签名（见各文件顶部注释）。
4. `markInactive`/`onStatusChange`/`abortBackground`/`usage()` 是 J2 对 `JevClientHandle`（非冻结扩展类型）的具体实现，J6 wire 时可按需调整调用方式，未在 contracts.ts 里登记（按计划它们本就不在 J1 的冻结签名表里，是 J2 自己 "`createJevClient` deps/返回值" 的实现细节）。

未遇到需要越界或等待 root 回复的阻塞点，故未发送 `message_agent`。
