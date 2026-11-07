# #26 交付报告：去掉 memory 用户令守卫的人工确认

> 方案：同目录 `plan.md`（r2，用户已确认，评审闭合）。本报告为实施交付记录；实施严格按 r2 改动清单执行，无范围外改动。

## 1. 行为变化摘要

- 判定域命中（touched > 0）⇒ **直接写入**：不再调用 `ui.confirm`/`ui.select`/ask_user 远程端口；子会话（开写权限）、print、rpc、TUI 一律进写入流程。
- 保留：`voided user rule:` 回显（字节不变）、`assertGuardBaseline`（CAS）、`assertCommitNotAborted`（锁前 + 锁内两个 abort 检查点，改抛 `ABORTED_GUARD(name)` = `"<name>: aborted before commit; file unchanged"`）。
- 新增：主会话且 `ctx.hasUI === true` 且写入成功 ⇒ 一次 warning 级 `ui.notify`，`noticeId` 只有序号+行号（`#2 (L12-15)`），最多列 10 条，超出折叠 `- …另有 N 条（见工具结果）`；notify 抛错被吞。子会话/无 UI/写入失败 ⇒ 零通知。
- skip 路径（touched = 0）与现状逐字节一致：不带 commitSignal，abort 不拦。
- 手写文件插入 `source: agent`（provenance 翻转）同样直写 + 通知；手写文件 write/delete 的拒绝条件保留（已不是不可绕过的保护）。
- 删除设置键 `memory.jev.confirmTimeoutS`（残留文件键被逐字段解析静默忽略，不写回用户文件）。
- `/mem` 命令侧确认（tidy/restore/review/expired/break-lock、Web 二次确认）全部未动。

## 2. 改动文件清单

实现（绝对路径，均相对 `/home/bluecake/ai/pi-toolkit`）：

| 文件                                                                              | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/tool-v2.ts`                                                           | 删除 `createDialogRace`/`AskUserRemote*` import、`deps.remote`、`REFUSE_USER_ORDER`/`GUARD_CONFIRM_TITLE`、`GUARD_REMOTE_*`/`remoteGuardQuestion`、`GuardConfirmInput`/`guardConfirm`/`raceGuardConfirm`/`firstLineOf`、`guardRemotePort`；新增 `ABORTED_GUARD`、`noticeId`、`JevGuardPlan.noticeIds`、`notifyUserRuleChange`；两个 prepare 函数改为 abort 检查 + 直写 plan；六个写入 case 在 doX 成功后、`onAfterWrite` 前调 notify；`assertCommitNotAborted` 补 `name`（6 个调用点）；`sessionSignal` 保留（注释改「主会话 commit 检查点；子会话不传」） |
| `src/memory/index.ts`                                                             | 删 `AskUserRemotePort` import、`WireMemoryOpts.remote` 及转交；`sessionSignal` 保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/index.ts`                                                                    | 删传给 `wireMemory` 的 `remote:` 行（`askUserRemoteRef` 的 4 处用法全部保留，供 ask_user/topic-switch）；`sessionAbort` 三处注释去 confirm 字样；**未新增任何 `pi.on`**                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/memory/settings.ts`、`src/memory/setting-specs.ts`、`src/config/settings.ts` | 删 `confirmTimeoutMs` 字段/解析/默认值、`memory.jev.confirmTimeoutS` spec、`TIME_SETTING_MS_PATHS` 条目；键数注释 29→28                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/memory/jev/contracts.ts`、`write-port.ts`、`config.ts`、`wire.ts`            | 删 `JevConfig`/`JevWritePort`/两个工厂 deps 及转交里的 `confirmTimeoutMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

测试：

| 文件                                                                      | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/memory/tool-v2-jev-remote-confirm.test.ts`                         | **删除**（27 例；可迁移用例由新文件 A–F/H 组承接）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tests/integration/memory-headless-confirm.test.ts`                       | **删除**（3 例，由 G 组替代）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/memory/tool-v2-jev.test.ts`                                        | 守卫段重写为直写断言：voided 回显原字节 + notify 次数与文案（两例逐字）+ confirm 0 次；子会话/无 UI 直写且 notify 0；删拒绝/超时两例；two-step 改翻转直写 + 后续 delete 无第二次 notify；declined-delete 改为直删 + `.trash` 可恢复（34 例全绿）                                                                                                                                                                                                                                                                        |
| `tests/memory/tool-v2-jev-guard-direct.test.ts`                           | **新增** A–F/H–J 九组 19 例：A 失败零通知（匹配失败/硬上限/手写 write/delete 拒绝）、B CAS（持锁窗口 4 例，区分 `changed concurrently` 与匹配错误；delete 先删后重建保守拒绝）、C 同 baseline 并发写恰一路提交 + notify 恰 1 次、D 主会话 abort 四情形（会话/工具信号 × 锁前/等锁期）、E 子会话只收工具信号、F notify 抛错仍成功、H 敏感（heading 带 `sk-SECRET123` + private/secret 混合：通知零泄漏、计数含全部、voided 回显字节不变）、I 12 条折叠行逐字、J 回归（skip 路径 abort 照常提交；子会话默认只读错误保留） |
| `tests/integration/memory-user-rule-direct.test.ts`                       | **新增** G 组 5 例：真实 `wireMemory` + PromptSectionHub + wireJev + 真 lock/commit + 假 classifier（451 partial）；rpc/tui 两模式 `ui.confirm`/`ui.select` 均 0 次；tui notify 恰 1 次（逐字）；skip 路径零通知                                                                                                                                                                                                                                                                                                        |
| `tests/config/memory-settings.test.ts`                                    | 按 plan §5：删 confirmTimeoutMs 夹具/区间/round-trip/spec 断言；key 数 12→11；新增 `isKnownSettingKey(...) === false` 与残留键容忍用例                                                                                                                                                                                                                                                                                                                                                                                  |
| `tests/config/settings-corpus.test.ts`                                    | defaults 用例改为先从 template 剪掉 `retiredPaths` 再比较；`generate()` 仍用未剪 template（残留键继续作为输入被覆盖）                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/config/__corpus__/settings-corpus.json`                            | 只更新 `defaultsSha` + `captured[].sha`(368) + `randomShas`(300) + `blockShas`(658)，新增 `retiredPaths: ["memory.jev.confirmTimeoutMs"]`；**template/timePaths/captured 输入/seed 未动**                                                                                                                                                                                                                                                                                                                               |
| `tests/config/__corpus__/setting-specs-pin.json`                          | `GOV_SPECS_GENERATE=1` 重写（先证等价，见 §4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/memory/jev/{client,command-port,config,decide,write-port}.test.ts` | 夹具去掉 `confirmTimeoutMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/memory/jev/guard.test.ts`                                          | **未改**（plan 指定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

文档：`skills/memory-jev/SKILL.md`（:23/:37/:42 三处策略改直写+转述）、`docs/guide/memory.md`（直写+通知+回显，删过时坐标，写明 Web/headless 无通知；「仍受门禁」→「仍会被召回」；删 confirmTimeoutS 表行）、`docs/dev/memory/README.md`（不变式 11 重写 + 手写保护可绕过注记 + 残留风险 + 门禁清单加新测试 + 键数 29→28）、`docs/dev/memory/jev-arch.md`（§6.2.5 加注 + §16.3 历史标注）、`docs/dev/memory/headless-confirm/{plan,impl-notes}.md`（文头「已作废（#26）」）、gate 残留五处段首标注（`hygiene-plan.md`×3、`jev-plan.md` 验收表×2、`reports/acceptance-report.md`×2）。

## 3. settings corpus 逐输出对比（plan §5，未用 GOV_CORPUS_GENERATE）

- 基线 dump（改码前，HEAD=b17eb070）：`GOV_CORPUS_DUMP=/tmp/c-before npx vitest run tests/config/settings-corpus.test.ts` → 4 passed，1331 个输出文件。
- 改码后 dump（corpus 输入面未动 ⇒ 生成输入逐字节相同）：`/tmp/c-after` → 1331 个文件，3 例预期失败（defaults/captured/random+blocks 哈希不符）。
- 一次性对比脚本结果（`/tmp/corpus-compare.log`）：

```
compared: 1331 files
equal after stripping confirmTimeoutMs: 1330
mismatched: 1
  MISMATCH ('defaults.txt', ['memory'])
```

`defaults.txt` 的单独核验（它是裸 `DEFAULT_SETTINGS`，无 `settings.` 包装路径，故上面的剥离函数没命中）：

```
before jev keys: [... 'maxCalls', 'confirmTimeoutMs', 'fastPathAllowTags' ...]
after  jev keys: [... 'maxCalls', 'fastPathAllowTags' ...]
defaults equal after strip: True        # 剥掉 memory.jev.confirmTimeoutMs 后完全相等，键序一致
```

即：**1330/1331 个 evaluate 输出（含 warnings/files 段）剥掉 `settings.memory.jev.confirmTimeoutMs` 后与改后输出完全相等；defaults 同理；无任何其他字段变化。** 哈希更新量：defaults + captured 368/368 + random 300/300 + block 658/658（全部因该字段删除而变，无意外漂移）。冻结字段（baseline/seed/两计数/template/timePaths/captured 输入）程序断言 identical。

## 4. setting-specs pin 等价证明 + 重写

一次性脚本（`/tmp/pin-verify.log`）：

```
old pin entries: 338 -> minus one: 337
new snapshot entries: 337
order + per-entry hashes identical: true
```

旧 pin 的 `specs` 去掉 `memory.jev.confirmTimeoutS` 一行后与新 snapshot **顺序与逐条哈希完全相同** ⇒ 唯一变化就是删掉该 spec。随后 `GOV_SPECS_GENERATE=1` 重写 + prettier 归一，git diff 仅删一行 + `all` 哈希更新。（corpus/pin 两个 JSON 均经 `npx prettier --write` 归一到仓库格式，与原入库形态一致。）

## 5. 自验命令与结果（真实输出）

| 命令                                                                                                                                                                                                                                                                                        | 结果                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/memory tests/config tests/integration/memory-jev-e2e.test.ts tests/integration/memory-jev-recall.test.ts tests/integration/memory-jev-write.test.ts tests/integration/memory-user-rule-direct.test.ts tests/governance tests/boundary tests/web-hub/boundary.test.ts` | `Test Files 152 passed (152)` / `Tests 2716 passed (2716)`（logs：`/tmp/t-gate-main.log`；prettier 归一后复跑 memory+config+两集成 `145 passed / 2623 passed`，`/tmp/t-gate-rerun.log`；最终态完整 governance 复跑 `2 passed / 32 passed`，`/tmp/t-governance-final.log`） |
| 定向组（A–J + G）                                                                                                                                                                                                                                                                           | guard-direct `19 passed`（`/tmp/t-guard-direct.log`）；tool-v2-jev `34 passed`；user-rule-direct `5 passed`（`/tmp/t-integ.log`）                                                                                                                                          |
| `tests/memory/jev/off-golden.test.ts`                                                                                                                                                                                                                                                       | passed（A′ 未重生，`/tmp/t-final-gates.log`）                                                                                                                                                                                                                              |
| tool-surface 测试 + `memory-tool-surface.json`                                                                                                                                                                                                                                              | passed；fixture 未动（git status 无该文件）                                                                                                                                                                                                                                |
| `npm run typecheck`                                                                                                                                                                                                                                                                         | 退出码 0，零错误（含 #20 在途文件也全绿；`/tmp/t-typecheck.log`、`/tmp/t-typecheck2.log`）                                                                                                                                                                                 |
| `npm run build`                                                                                                                                                                                                                                                                             | `build:bundle ok — dist/bundle/index.js sha256=a32bfab7a1a36715 size=4.68 MB`                                                                                                                                                                                              |
| `npx prettier --check <全部改动文件>`                                                                                                                                                                                                                                                       | `All matched files use Prettier code style!`                                                                                                                                                                                                                               |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                                                                                                                                                                                  | 通过（`git status --porcelain tests/fixtures/` 为空 ⇒ A/A′/B 冻结物字节不变）                                                                                                                                                                                              |
| 全量 `npm test`                                                                                                                                                                                                                                                                             | **未跑**（并行 agent 禁全量，按任务指令）                                                                                                                                                                                                                                  |

冻结面复核：`ask_user`/`topic-switch` 的 remote 接线（`src/index.ts:420/:1208`）、`createDialogRace`、`sessionSignal`/`sessionAbort`、`concatGuardSignals` 全部保留；`src/memory/tool-v2.ts` 0 个 `pi.on`，`src/memory/index.ts` 3 个（原有，未增）；activate-trace（B 级）测试绿且 golden 未改。

## 6. 与方案的出入

1. A 组硬上限用例用 `rules.md`（topic 文件）而非 `core.md`——`core.md` 命中的是 `coreBytes` 上限而非 `topicMaxBytes`，方案未指定文件名，属测试实现细节。
2. `src/memory/settings.ts` 的「N 个设置键」计数注释（29→28）与 README 对应句子同步更新——方案 §5 删键的直接后果，未列在清单但属同一意图。
3. corpus/pin JSON 程序化更新后经 prettier 归一（原始文件入库形态即 prettier 格式，生成器写出的 1-space JSON 需归一后才与仓库一致）。

## 7. 遗留问题 / 已知残留（方案 §9，均在拍板范围内）

- **R-a** 用户令可被 agent 静默作废：缓解只有 TUI warning、工具结果回显、skill 转述要求；print/子会话/Web/headless 无通知；delete 可从 `.trash` 找回（20 份），edit 无自动备份。
- **R-b** 手写文件保护可绕过：先插入 `source: agent`（只有通知），再 write/delete（无通知）。
- **R-d** voided 回显仍带 heading（现状字节，进入工具结果与 transcript）；通知侧已不含 heading/正文。
- 本包不做 Web 主动通知（用户答复②）；rpc 的 notify 会调用但被 hub 的 `FIRE_AND_FORGET_METHODS` 丢弃，不算交付。
- commit 由主会话执行（本任务禁 git 写操作），建议信息：`feat(memory): apply user-rule edits without confirmation, notify instead`（body 写明删除 `confirmTimeoutS` 与 §5 的哈希更新方式）。
