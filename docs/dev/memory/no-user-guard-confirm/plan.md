# #26 去掉 memory 用户令守卫的人工确认：方案 r2

> **r2**（2026-11-05）：GPT 评审结论为「有条件通过」（0 Blocker / 4 Major / 3 Minor），逐条处置见文末「评审处置表」。用户已确认方案，并回答了 r1 的两个开放问题，本版不再保留开放问题。
> 探索记录在同目录 `explore.md`。所有坐标已在 dev HEAD `a743b0ff` 上核实，订正两处：
> ① explore 里写的「硬拒绝 :978-984」实际是子会话和无 UI 时的拒绝；手写文件的拒绝在锁内（`doOverwrite` :1279、`doDelete` :1365/:1398）。
> ② `docs/guide/memory.md` 只有 127 行，「:589」这一处不存在。

## 0. 用户拍板（2026-11-05）

- **范围**：只去掉 memory 工具在 agent 改动或删除用户令（`<!-- mem user -->` 条目）时的人工确认，包括 TUI 的 `ui.confirm`、Web/headless 的 ask_user 卡、60s 超时拒绝，以及无 UI/子会话时的拒绝。`/mem tidy|restore|review|expired|break-lock`、Web 端 `/mem` 二次确认等命令侧确认**一律保留**。
- **形态**：不弹框、不开卡，直接写入。保留工具结果里的 `voided user rule:` 回显（字节格式不变）和 CAS/abort 校验（`assertGuardBaseline`、`assertCommitNotAborted`）。**不新增设置项**。
- **通知承诺（r2 收窄）**：只承诺两样——主会话 TUI 的一条 warning 级 `ui.notify`，以及**所有模式**工具结果里的 `voided user rule:` 回显。
  - rpc/headless 通路会丢弃 notify：`src/web-hub/hub/spawn/rpc-stdio.ts` 的 `FIRE_AND_FORGET_METHODS`（:60-66），在 :272 直接 return。
  - Web 的 ToolCard 只是工具详情，**不算通知通道**。
  - 本包不做 Web 主动通知（用户答复②）。
- **provenance（用户答复①）**：agent 往手写文件里插入 `source: agent`（接管翻转）时，同样直接写入并发通知，不新增硬拒绝。手写文件的 write/delete 拒绝条件保留，**但它已不再是不可绕过的保护**——先翻转、再 write/delete 就能绕开（见 §9 R-b）。
- **不变**：secure 域 D8（jev 关闭 ⇒ 没有守卫逻辑）。

## 1. 行为契约（改后）

**判定域不变**：

- str_replace/insert/write/append/create 触及用户令（`touchedUserEntries` 按 guardHash 配对）；
- 手写 → `source: agent` 的翻转；
- → `status: archived` 的翻转；
- delete 含用户令的 agent 文件；
- rename 不在判定域内。

判定域命中（touched > 0）时：

1. 不调用 `ui.confirm`、`ui.select`、ask_user 远程端口。子会话（已开写权限时）、print、rpc、TUI 一律进入写入流程，不再抛 `用户未确认…`。private/secret 条目照常计入 touched，不做过滤。
2. plan 携带以下字段：
   - `baseline = preRead.stat`；
   - `voided`：沿用 `guardAnchor`，字节不变；
   - `noticeIds`：不含内容的标识，见 §3；
   - `commitSignal`：主会话 = 工具 signal ∪ 会话 signal（`concatGuardSignals`）；子会话 = 只有宿主给的工具 signal。子会话不传 `sessionSignal`（`src/index.ts:242`），会话 controller 只在主会话的 `session_start`/`session_shutdown` 里切换（`:901-910`、`:952-956`）。
3. 锁前有一个检查点：`commitSignal` 已 abort ⇒ 抛 `ABORTED_GUARD(name)`，不落盘。锁内照旧先 `assertGuardBaseline`，再 `assertCommitNotAborted`。
4. 提交成功 ⇒ 工具结果带 voided 行；主会话且 `ctx.hasUI === true` ⇒ 调用一次 notify（§3）。提交失败（CAS、匹配失败、abort、hard limit 等）⇒ **零通知**。notify 抛错会被吞掉，仍返回成功结果。
5. touched = 0（skip plan）时与现状**逐字节一致**：不带 commitSignal，abort 不拦。jev off 时整条路径不存在（I9）。

## 2. 改动清单

| 文件:行                                  | 改动                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/tool-v2.ts:55-56`            | 删除 `createDialogRace` 和 `AskUserRemote*` 的 import                                                                                                                                                                              |
| `:72-78` / `:79-85`                      | 删除 deps 的 `remote`；保留 `sessionSignal`，注释改为「主会话 commit 检查点；子会话不传」                                                                                                                                          |
| `:176-179`                               | 删除 `REFUSE_USER_ORDER`、`GUARD_CONFIRM_TITLE`；新增 `ABORTED_GUARD = (name) => \`${name}: aborted before commit; file unchanged\``                                                                                               |
| `:196-206` `JevGuardPlan`                | 新增 `readonly noticeIds: readonly string[]`；`voided` 生成方式不变；`commitSignal` 注释改为「touched>0 的 plan 都带」                                                                                                             |
| `:208-219` `guardAnchor`                 | **不改**（只给 voided 用）；新增 `noticeId(e) = \`#${e.ordinal} (L${e.lineStart}-${e.lineEnd})\``，不带 heading 和正文                                                                                                             |
| `:221-255`                               | 删除 `GUARD_REMOTE_*` 常量和 `remoteGuardQuestion`                                                                                                                                                                                 |
| `:257-259`                               | `assertCommitNotAborted(signal, name)` 改抛 `ABORTED_GUARD(name)`；补传 `name` 的调用点：:1150/:1203/:1252/:1291/:1333/:1360                                                                                                       |
| `:261-272`                               | `concatGuardSignals` 保留                                                                                                                                                                                                          |
| `:274-478`                               | 删除 `GuardConfirmInput`、`guardConfirm`、`raceGuardConfirm`、`firstLineOf`                                                                                                                                                        |
| `:913-921`                               | 删除 `guardRemotePort`                                                                                                                                                                                                             |
| `:927-1011` `prepareJevGuard`            | touched 计算（:936-976）原样保留；:937 的 skip 字面量补 `noticeIds: []`；删除 :978-1005；改为 abort 检查后 `return { baseline, voided, noticeIds, commitSignal? }`                                                                 |
| `:1020-1065` `prepareJevDeleteGuard`     | :1028 的 skip 补 `noticeIds: []`；删除 :1034-1059；手写文件的 skip（:1031）保留                                                                                                                                                    |
| 新增 helper（`composeOutcome` :1067 旁） | `notifyUserRuleChange(ctx, kind, name, plan)`，见 §3                                                                                                                                                                               |
| `:1478-1544` 六个写入 case               | doX 成功返回后、`deps.onAfterWrite` 前调用 notify helper；delete 回显（:1519-1520）不变                                                                                                                                            |
| `src/memory/index.ts:33,66-73,237`       | 删除 `AskUserRemotePort` 的 import、`WireMemoryOpts.remote` 及其转交；`sessionSignal`（:74-80、:238）保留，删掉注释里「child sessions hard-refuse guards before any confirm」这句                                                  |
| `src/index.ts:239-241`                   | 删除传给 wireMemory 的 `remote:` 那一行；`askUserRemoteRef`（:178/:425/:1151/:1213）不动；`sessionAbort` 注释（:224-231、:907-908、:953-954）去掉 confirm 字样，并删除「child sessions … never read this」这句。**不新增 `pi.on`** |
| `confirmTimeoutMs` 链路（§5）            | `src/memory/settings.ts:17-18,71,103-104,382,450`、`setting-specs.ts:207-212`、`src/config/settings.ts:368`、`jev/contracts.ts:450,551`、`jev/write-port.ts:74,345`、`jev/config.ts:49`、`jev/wire.ts:249,2627`：全部删除          |

不改的文件：`jev/guard.ts`、`tool-surface.ts`（描述里没有守卫文案）、`jev/format.ts:194`。

## 3. 通知形态（只在 TUI；中文散文）

```
edit（含两种翻转）:
agent 改动了 {name} 中的 {n} 条用户令（已直接写入，未经确认）：
- 条目 {noticeId}
delete:
agent 删除了 {name}，其中 {n} 条用户令随之作废（文件已移入 .trash，可用 /mem restore --trash 找回）：
- 条目 {noticeId}
```

- **标识**：`noticeId` 只有序号和行号（例：`条目 #2 (L12-15)`），**不复用 `guardAnchor`**。原因是 heading 来自 `jev/entries.ts:298-299,519` 的 `headingLabel`，可能含凭证或私密名称；旧远程卡同样把 heading 当敏感内容排除。`{n}` 统计全部 touched（含 private/secret）。
- **条数**：最多列 10 条，超出时加一行 `- …另有 {n-10} 条（见工具结果）`。级别 `"warning"`，整个调用包在 try/catch 里。
- **发送条件**：`!deps.isChildSession && ctx?.hasUI === true && typeof ctx.ui.notify === "function"`。rpc 下 `hasUI` 为 true，会调用，但 hub 会丢弃（§0），不算交付。
- **已知残留**：工具结果里的 voided 行仍带 heading。这是现状字节，按拍板保留，记入 §9 R-d。
- **验收**：
  - 单测逐字断言文案和调用次数；
  - 手工开一个 TUI 会话改一条用户令，能看到 warning；
  - Web/headless 会话只核对工具结果里有 voided 行，**不作为通知验收项**。

## 4. 删除与保留

- **删除**：远程确认卡整套（端口获取、竞速、超时计时器、卡面文案）、`firstLineOf`、拒绝文案、无 UI/子会话硬拒绝、memory 的 `remote` 依赖。
- **保留**：
  - ask_user 和 topic-switch 的 `remote` 接线、`createDialogRace`；
  - `sessionSignal`/`sessionAbort`：只给主会话用，支撑「等锁期间 reload/shutdown 不落盘」；
  - `concatGuardSignals`、`assertGuardBaseline`、`assertCommitNotAborted`；
  - 两个 prepare 函数里的判定逻辑。

## 5. `confirmTimeoutS`：删除，用逐输出对比证明

**兼容**：

- `parseMemorySettings` 逐字段解析，旧文件里残留的 `confirmTimeoutS` 或老 `confirmTimeoutMs` 会被静默忽略。
- `TIME_SETTING_MS_PATHS` 去掉这一项后，`normalizeTimeUnits` 不再转换它。
- `isKnownSettingKey` 返回 false，设置面板自动不再列出。
- 不改写用户文件。

**settings corpus**（`tests/config/settings-corpus.test.ts`）：generator 会从实时的 `DEFAULT_SETTINGS`/`TIME_SETTING_MS_PATHS` 重建 template（:258-261），删一个字段就会改变随机遍历和 rnd 取用顺序（:190-209）。所以**禁止用 `GOV_CORPUS_GENERATE` 重抓**，也不拿 `ff5400bc` 当证明。步骤：

1. 改代码前在基线上跑 `GOV_CORPUS_DUMP=/tmp/c-before npx vitest run tests/config/settings-corpus.test.ts`。
2. 改代码后，用**原封不动的 corpus**（template、timePaths、captured 输入、seed 都不变 ⇒ 生成的输入逐字节相同）跑 `GOV_CORPUS_DUMP=/tmp/c-after …`。此时 defaults 用例和 sha 不符属于预期失败。
3. 用一次性 node 脚本（不进仓库）对比两边全部 `*.txt`：从 before 的 `settings.memory.jev` 里删掉 `confirmTimeoutMs` 后，必须与 after **完全字符串相等**（包括键顺序）；warnings 和 files 段逐字相等；`source-*` 不变。
4. 只更新期望值：`defaultsSha`、`captured[].sha`、`randomShas`、`blockShas`。template、timePaths、captured 输入**一律不动**。
5. 测试代码改一处：defaults 用例（:286-287）里的 `stringify(corpus.template) === text`，改为先把 corpus 新增的 `retiredPaths: ["memory.jev.confirmTimeoutMs"]` 从 template 中剪掉再比较；`generate()` 仍用未剪的 template。这样残留键作为输入继续被覆盖到，正好验证「旧键被容忍」。

**setting-specs pin**：再用一次性脚本断言「旧 pin 的 `specs` 去掉 `memory.jev.confirmTimeoutS` 这一行 ≡ 新 snapshot 的 `specs`」，顺序和每条哈希都相同。通过后再 `GOV_SPECS_GENERATE=1` 重写 pin（pin 只来自实时 spec，没有随机性）。

**测试**：`tests/config/memory-settings.test.ts` 中：

- :53/:435/:452/:468/:525-532/:590-592/:657 删除或改写；
- :622 的 key 数从 12 改为 11；
- 新增 `isKnownSettingKey("memory.jev.confirmTimeoutS") === false`；
- 新增「`loadSettings` 读到残留 `confirmTimeoutS` 不抛错、输出里没有这个字段」，写法照 :510-512 的 stale gate 用例。

`tests/memory/jev/{config,client,decide,command-port,write-port}.test.ts` 的夹具同样去掉 `confirmTimeoutMs`。

## 6. 测试矩阵

**删除**：

- `tests/memory/tool-v2-jev-remote-confirm.test.ts`（27 例），可迁移的用例搬到新文件；
- `tests/integration/memory-headless-confirm.test.ts`（3 例），由下面 G 组替代。

**改写** `tests/memory/tool-v2-jev.test.ts:296-618`：

- 保留：case 1、un-archive、archive 无用户令、rename。
- 断言改为「直接写入 + voided 回显（原字节）+ notify 1 次（逐字）+ confirm 0 次」：:312、:333、:456、:473、:521、:592。
- :354 子会话（开启 `allowWriteInChildSessions`）、:374 无 UI：直接写入，notify 0 次，回显照旧。
- 删除：:387 拒绝、:401 超时。
- :607-618「declined confirm refuses the delete」改为：直接删除、confirm 0 次、`.trash` 里可恢复。
- :438 改用持锁窗口的写法（见下面 B 组）。
- :495 two-step 改为：翻转直写 + notify，后续 delete 无 notify。

**新增** `tests/memory/tool-v2-jev-guard-direct.test.ts`。edit（str_replace）和 delete 两条路径都要覆盖：

| 组                | 用例                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 失败零通知      | 匹配失败、hard limit、手写文件 write/delete 被拒 ⇒ notify 0 次，文件不变                                                                                                                                                                                                                                                                        |
| B CAS             | 外部持锁（照旧文件 :722 的 `lockCreate`），持锁期间对同文件做**不碰 old_str** 的修改，释放锁 ⇒ `changed concurrently`、并发版本保留、notify 0 次。另加一例并发删掉 old_str ⇒ 断言是匹配错误（str_replace 在 :1178-1183 先做匹配、:1202 才查 baseline），同样零通知。delete 路径：持锁期间改文件 ⇒ `changed concurrently`；先删后重建 ⇒ 保守拒绝 |
| C 并发写          | 同一 baseline 两路写 ⇒ 恰好一路提交，另一路 CAS 失败，notify 恰好 1 次                                                                                                                                                                                                                                                                          |
| D abort（主会话） | 会话 signal 预先 abort ⇒ 锁前拒绝；等锁期间会话 signal abort ⇒ 锁内拒绝；工具 signal 同样两种情形。每例都要求文件逐字节不变、notify 0 次                                                                                                                                                                                                        |
| E abort（子会话） | 子会话不传 sessionSignal，等锁期间工具 signal abort ⇒ `aborted before commit`，不落盘                                                                                                                                                                                                                                                           |
| F notify 健壮性   | notify 抛错 ⇒ 仍返回成功文本，文件已写入                                                                                                                                                                                                                                                                                                        |
| H 敏感            | heading 里放 `sk-SECRET123`，再混合 private/secret/plain 条目：notify 文本不含该 heading、条目正文和标记；`{n}` 计入全部条目；voided 回显字节不变                                                                                                                                                                                               |
| I 折叠            | 超过 10 条时折叠行逐字                                                                                                                                                                                                                                                                                                                          |
| J 回归            | skip 路径的 abort 仍照常提交；子会话默认（未开写权限）⇒ 原 read-only 错误                                                                                                                                                                                                                                                                       |

**新增** `tests/integration/memory-user-rule-direct.test.ts`（G 组，生产接线级）：照 `memory-jev-e2e.test.ts` 的写法，用真实 `wireMemory`（jev on、假 classifier）注册 memory 工具。

- `mode:"rpc"` 和 `"tui"` 两种 ctx 下改一条用户令，`ui.confirm`/`ui.select` 调用次数都是 0；
- tui 下 notify 1 次；
- 宿主 `src/index.ts` 不再传 `remote`，由 typecheck 兜住。

**不改**：`tests/memory/jev/guard.test.ts`。`memory-jev-e2e.test.ts` 跑一遍，确认 `notes` 的正则断言不受影响。

## 7. 文档

- **`skills/memory-jev/SKILL.md`**：
  - :23 改为「工具不再拦截；用户本轮明确要求时直接改，否则先在回复里提议，用户同意后再改」；
  - :37 去掉「经用户确认」；
  - :42 改为「看到 `voided user rule:` 必须在回复里向用户点明」。
- **`docs/guide/memory.md`**：
  - :78-81 改为「直接写入 + TUI 通知 + 工具结果回显」，删掉过时坐标 `tool-v2.ts:663-674`，并写明 Web/headless 没有通知；
  - :85 的「仍受门禁」改为「仍会被召回」；
  - :125 删除 `confirmTimeoutS` 行。
- **`docs/dev/memory/README.md`**：
  - 不变式 11 改为「用户令变更判定域（命中 ⇒ 直写 + voided 回显 + 主会话 TUI warning notify（不含 heading/正文）+ CAS/abort 检查点；无确认）」；
  - 补一句「手写文件的 write/delete 拒绝条件保留，但已不再是不可绕过的保护（可先翻转 provenance 再操作）」；
  - 残留风险同 §9。
- **`jev-arch.md` §6.2.5**（:846-848）：加注「2026-11 #26：确认已移除，见 no-user-guard-confirm/plan.md」。
- **`headless-confirm/{plan,impl-notes}.md`**：文件头标「已作废（#26）」，不删除。
- **gate 残留**（`jev-arch.md:1327-1330`、`hygiene-plan.md:137,272,650`、`jev-plan.md:901-902`、`reports/acceptance-report.md:34,87`）：只在段首加「（gate 已于 2026-11 移除，以下为历史）」。

## 8. 包与门禁

单包，L2。门禁命令：

```sh
npx vitest run tests/memory tests/config tests/integration/memory-jev-e2e.test.ts \
  tests/integration/memory-user-rule-direct.test.ts tests/governance tests/boundary tests/web-hub/boundary.test.ts
git diff --quiet origin/dev -- tests/fixtures/   # A/A′/B 全部字节不变
npm run typecheck && npm run build && npm run format:check
```

各冻结物管的范围：

- `jev-off-golden`：jev off 下 wireMemory 的注册列表、工具输出和文件字节，均不得变化；
- `memory-tool-surface`：描述字节；
- `activate-trace`：注册顺序。

`tests/web-hub/boundary.test.ts` 覆盖 settings 的导入闭包，`tests/boundary` 不包含它。

commit：`feat(memory): apply user-rule edits without confirmation, notify instead`。body 写明：删除设置键 confirmTimeoutS；settings pin/corpus 按 §5 的逐输出对比更新了期望哈希。

## 9. 风险

- **R-a 用户令可被 agent 静默作废**：缓解只有三样——TUI 的 warning、工具结果回显、skill 要求向用户转述。print、子会话、Web/headless 都没有通知。delete 可以从 `.trash` 找回（保留 20 份）；edit 没有自动备份。
- **R-b 手写保护可绕过（用户已接受）**：先插入 `source: agent`（只有通知），再 write/delete（翻转后条目已是 agent 权威，连通知都没有）。拒绝条件保留，但不再构成不可绕过的保护。
- **R-c abort 语义扩大**：touched > 0 的路径原先不确认就不会写，现在会写，但受 abort 检查点约束。skip 路径不变。
- **R-d voided 回显带 heading**：这是现状字节，按拍板保留；它进入工具结果和 transcript。通知侧已不含 heading。

## 评审处置表（GPT 评审，r1 → r2）

| #   | 级别  | 评审要点                      | 处置                                                                                                                                                      | 落点               |
| --- | ----- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | Major | Web 通知承诺前后矛盾          | 接受：承诺收窄为「TUI warning + 全模式回显」；写明 rpc 在 :60-66/:272 丢弃 notify；ToolCard 不算通知；不做 Web 主动通知（用户答复②）                      | §0、§3、§7         |
| 2   | Major | heading 可能泄密              | 接受：voided 字节不变；通知改用 `noticeId`（序号 + 行号）；private/secret 仍计数；加 heading 敏感断言（H 组）；残留记为 R-d                               | §1、§2、§3、§6、§9 |
| 3   | Major | corpus 重抓的证明方式         | 接受：禁用 `GOV_CORPUS_GENERATE`；冻结输入后做 before/after 逐输出对比，只更新哈希；pin 用「去掉一行后恒等」证明；门禁加 `tests/web-hub/boundary.test.ts` | §5、§8             |
| 4   | Major | 测试矩阵不全                  | 接受：补 A–J 组 + G 生产接线；CAS 区分匹配错误和 `changed concurrently`                                                                                   | §6                 |
| 5   | Minor | 会话取消范围                  | 接受：主会话 = 工具 ∪ 会话 signal，子会话只用工具 signal；补 E 组；删旧注释；不加 `pi.on`                                                                 | §1、§2、§6         |
| 6   | Minor | 机械遗漏                      | 接受：:937/:1028 补 `noticeIds: []`；改写 :607-618                                                                                                        | §2、§6             |
| 7   | Minor | provenance 表述、章节引用错误 | 接受：改为「拒绝条件保留但可绕过」；§7 改引 §9                                                                                                            | §0、§7、§9         |
| —   | 附注  | off-golden 的范围             | 接受：写明它约束注册、输出和文件字节                                                                                                                      | §8                 |
