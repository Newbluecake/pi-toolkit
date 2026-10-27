# AF1 + AF2 hub 绑定表与路由 · 交付报告（#72 alias-force-default r2）

范围：方案 §10 的 AF1（`hub/xs/aliases.ts`）和 AF2（`router.ts`、`members.ts`、`audit.ts`、`assembly-channels.ts`）。
两个提交，先表后路由。agent 侧、命令层、web、装配、AF7 handoff 均未动。`tests/fixtures/` 未动。

## 提交

| sha        | 内容                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `1cea93d0` | AF1：`aliases.ts` 加 autoClaim / forcePreview / force 执行 / origin、forced 落盘；两个新测试文件 |
| `92e23134` | AF2：router intent 分派与 v2 门控、`xs_alias_evt` 推送、`isLinked`、audit、cap `xs.alias.v2`     |

## 改动文件

AF1：

- `src/web-hub/hub/xs/aliases.ts`
- `tests/web-hub/hub/xs-aliases-v2.test.ts`（新，20 例）
- `tests/web-hub/hub/xs-aliases-v2.property.test.ts`（新，I1/I2/I5′/I7；固定种子，`XS_ALIAS_PROP_SEED=random` 可换种子，已用随机种子跑 10 次全绿；固定种子下断言 auto/force/take 三条路径都被生成器命中）

AF2：

- `src/web-hub/hub/xs/router.ts`、`src/web-hub/hub/xs/members.ts`、`src/web-hub/hub/audit.ts`（只改 `reason` 注释）、`src/web-hub/hub/assembly-channels.ts`
- `tests/web-hub/hub/xs-alias-v2-router.test.ts`（新，15 例）
- `tests/web-hub/hub/hub-xs-alias.test.ts`（既有，**文件域外**，见偏差 1）

本报告：`docs/dev/fabric-cross-session/AF1-report.md`

## 给后续包的接口说明

### hub 表（`XsAliasStore`，pi-free，hub 自有类型）

- `XsAliasRequester` 新增可选 `v2?: boolean`。**只有 `v2:true` 时**回包才写新键（`origin`、`lost.forced`、预览的 `online`/`auto`）；router 只在 `aliasUsable ∧ caps ∋ xs.alias.v2` 时置位。
- 新方法：
  - `autoClaim(requester, rawAlias, cwdLabel)`：同步前置检查（taken / confusable / FULL / 已有 held ⇒ noop 返回当前状态）不进队列；通过后才入队。成功回包 `{alias, state:"held", origin:"auto"}`；已有 held 时回 `{alias:<已有>, state:"held", origin?:"auto"}`，**不写盘**。
  - `forcePreview(requester, rawAlias)`：`not_held` / `unnotifiable` / `BUSY{tokens}`；token 绑定 `mode:"force"` + `presenceKey`。
  - `take(...)` 签名不变：token 的 `mode` 决定走 take 还是 force 语义，执行帧上的 `intent` 被忽略。
- store deps 新增（均可选）：`isLinked(sid)`、`allMembersV2(sid)`（缺省 ⇒ false，即在线持有者一律 unnotifiable）、`onForcedCommit({holderSessionId, requesterSessionId, at})`。`onForcedCommit` 在 commit 之后触发，wedged 之后晚到的 rename 成功也触发，晚到失败不触发；抛错被吞。
- `XsAliasWriteFailure` 的 TAKE 细节加了 `"unnotifiable"`。
- 落盘只加可选键：record `origin:"auto"`、tombstone `forced:true`。`version` 仍为 1，tombstone `reason` 不新增枚举。读取时 origin/forced 取值不是精确的 `"auto"`/`true` 就忽略（按人工记录处理），**不会 corrupt**。
- 人工授予（set、take、force）一律丢弃 `origin`；人工对自己的 auto 名重新 `set` 同名同 label 也会重写（算人工确认）。

### router（AF2 给 AF3/AF7 的约定）

| 帧                                                                                                                                                                                   | 行为                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{alias, intent:"auto"}`                                                                                                                                                             | v2 ∧ joined；成功回 `origin:"auto"`；审计 `reason:"auto"`                                                                                                                    |
| `{alias, take:"preview", intent:"force"}`                                                                                                                                            | 限速计入 `listPerMin`；审计 `reason:"force-preview"`                                                                                                                         |
| `{alias, take:<token>[, intent:"force"]}`                                                                                                                                            | 执行，审计 `reason:"take"`（force 与 take 在审计里不区分）                                                                                                                   |
| `intent` / `prevSessionId` 来自无 v2 请求方、`intent:"force"` 缺 alias 或缺 take、`intent:"auto"` 带 take 或缺 alias 或未 joined、`prevSessionId` 不配 handoff、intent 与 clear 并存 | `E_XS_BAD_FRAME`（先于 store，审计 `reason` 为推导出的 sub）                                                                                                                 |
| `intent:"handoff"`                                                                                                                                                                   | **一律 `E_XS_BAD_FRAME`**。AF7 在 `handleAlias` 的 `intentMalformed` 里去掉 `intent === "handoff"` 一项，再接 `store.handoff`。agent 按方案 §3.1 把它当成交接失败，回落 auto |

- 推送：`createXsAliasBinding().attach(members, registry?)` 多了第二个参数（`createXsRelay` 已传）；向 `members.effectiveAll()` 中 `sessionId===holder ∧ aliasV2Capable` 的每个 member 调 `registry.send(agentKey, {t:"xs_alias_evt", sessionId, at})`。帧不含别名文本。
- `XsEffectiveMember.aliasV2Capable`：hello caps ∋ `xs.alias.v2`。
- hub caps：`xs.alias.v1` 之后紧跟 `xs.alias.v2`，条件同为 `store.advertised`。hello_ack 与 HubInfo 两面同源。
- AFW/AF3 注意：agent 看到 hub caps ∋ v2 才发 intent；收到 `xs_alias_evt` 只做 get 对账，对账结果里 `lost.forced` 只会出现在 v2 请求方的回包。
- `hub.json.alias` 未改。

## 与方案/AF0 的偏差

1. **改了文件域外的既有测试** `tests/web-hub/hub/hub-xs-alias.test.ts`：cap 矩阵测试钉死了「alias 打开 = xs caps + 恰好一个尾部 cap」，v2 cap 必然使它变红。改为期望尾部两项 `[v1, v2]`，并断言 degraded/off 时都没有 v2。其余既有测试零改动。
2. **`XsAliasStorePortV2`（fabric `types-alias.ts`，AF0 提案）未被使用，也没改**：hub 不能 import fabric，hub 侧用自己的 `XsAliasStore` 接口。与提案的差异：没有 `handoff`（留给 AF7）；`forcePreview`/`autoClaim` 签名同提案；`XsAliasRequester` 在 hub 侧多了 `v2`。AF3 若要对齐，只需看上表。
3. 预览的 `auto?:true` 对 **take 预览**也会写（v2 请求方、记录 origin=auto 时），不只 force 预览——方案 §3.2 把它画在通用的 preview 形状里，这样确认框两条路径都能标「自动认领」。非 v2 请求方的 take 预览键集与 v1 逐字节一致（有测试）。
4. `autoClaim` 的 `noop`（S 已有 held）在同步前置阶段返回，不占队列，也不检查 `x` 是否被别人占用（方案 §4 第 2 行本就如此）。
5. 方案 §4 表对 `force preview` 的 `held(H≠S)` 未说明「过期 held」。实现按普通 held 处理（离线 ⇒ notifiable ⇒ 可 force）。
6. token 的内部字段 `offlineSince` 改名为 `presenceKey`，并新增 `mode`（方案 §4）。take 路径语义不变（键为 `off:<offlineSince>`，旧 stale/online/recent 判定顺序保持）。
7. 没有为 force 执行单独加审计标记：方案规定它「审计为 `take`」，因此日志里 force 和 take 无法区分（要区分需放宽「只写 sub-op 与 code」的规则，未做）。

## 自验

| 命令                                                                                                                                                                                                                                                          | 结果                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run typecheck`                                                                                                                                                                                                                                           | 通过（TS7 ×2 + vue-tsc）                                    |
| `npx vitest run tests/fabric tests/web-hub/hub tests/web-hub/agent tests/web-hub/protocol tests/commands --maxWorkers=2`                                                                                                                                      | 422 文件 / 10012 通过 / 3 skip（既有）                      |
| `npx vitest run tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-alias.test.ts tests/integration/fabric-xs-alias-wiring.test.ts tests/conformance/fabric-xs.test.ts tests/web-hub/boundary.test.ts tests/governance --maxWorkers=2` | 6 文件 / 57 通过                                            |
| `npx vitest run tests/integration/fabric-xs --maxWorkers=2`（全部 fabric-xs 集成）                                                                                                                                                                            | 15 文件 / 85 通过                                           |
| `npx prettier --check src tests docs/dev/fabric-cross-session`                                                                                                                                                                                                | 通过                                                        |
| `git diff --quiet 9ce5abc7 -- tests/fixtures/`                                                                                                                                                                                                                | 干净（`xs-router-v071-diff`、三份 off golden 均未动且全绿） |

未跑全量 `npx vitest run`（AF0 报告已说明全量耗时过长，以 CI 为准）。

## 遗留

- handoff（hub 侧 `planHandoff`、`members` 继承边、`predecessorOf`）属于 AF7，未做；`intent:"handoff"` 现在回 BAD_FRAME。
- 没有真实 hub 子进程 × 多 stack 的集成（方案 §9 集成 ①–⑧ 属 AF6）。pin 屏障（集成 ③）在 router 层有等价单测，`xs-alias-v2-router.test.ts` 里的「pin barrier」。
- `isLinked` 每次 force 预览/执行遍历一次 `registry.list()`（O(记录数)）；force 是人工低频操作，未做索引。
