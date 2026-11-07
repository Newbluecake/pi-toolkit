# J5 返工报告（两轮合并 · jev-plan §4 J5 / arch §6.2）

> 状态：两轮返工均已闭合。初版见 `J5-report.md`（保留不动）。HEAD 基线：开工 `318759b7`。

## 交付面（最终数字）

| 文件                                      | 行数               | 说明                                                     |
| ----------------------------------------- | ------------------ | -------------------------------------------------------- |
| `src/memory/jev/write-port.ts`            | 343                | 新建（pi-free）；`createJevWritePort` 按冻结端口         |
| `src/memory/tool-v2.ts`                   | 约 1290            | `jev?: JevWritePort` + 写路径接线                        |
| `src/memory/tool-surface.ts`              | 120                | `MEMORY_TOOL_V2_TEXT_JEV`（描述变体 1638B，schema 不变） |
| `tests/fixtures/memory-tool-surface.json` | 24                 | 只新增 `jev` key（diff 纯加行）                          |
| `tests/memory/tool-surface.test.ts`       | 221                | 新 key/预算/schema 双 typebox 断言                       |
| `tests/memory/jev/write-port.test.ts`     | 601（**26 用例**） | 端口单测                                                 |
| `tests/memory/tool-v2-jev.test.ts`        | 683（**34 用例**） | 工具级集成                                               |
| `skills/memory-jev/SKILL.md`              | 44                 | 策略 only（I12）                                         |

自验：7 个定向测试文件 **162+9=171 用例全绿**（write-port 26 · tool-v2-jev 34 · tool-v2 59 · tool-surface 8 · off-golden 8 · fs-guard 4 · pi-free 28 · 边界/其余不变）；`npm run typecheck` 零错误；J5 全部 8 文件 `prettier --check` 干净；`git diff origin/dev -- tests/fixtures/` 仅 `memory-tool-surface.json +4`（本包声明内）。

## 第一轮返工（verifier 1 blocker + 2 major + 2 minor + 4 nit）

1. **delete 绕过守卫（blocker）**：新增 `prepareJevDeleteGuard`（`after=""` ⇒ 文件内 user 条目全量命中）+ `doDelete` 锁内 baseline 复核；确认通过追加 `voided user rule:` 行；子会话/无 UI/拒绝/超时拒删。手写文件跳过（provenance 拒绝在先）；rename 不触发（hygiene-plan §3.2）。
2. **similar/conflict 掩盖（major）**：`relationPicks` 拆两独立取值（全池最高 p vs {duplicate,conflict,supersedes} 最高 p），complementary 0.9 不再掩盖 conflict 0.8。
3. **off(pi-api) 口径（minor）**：`registryOf` 方法级检查（缺 `classify`/`getAvailableOfType` ⇒ 视为无 registry）。
4. **archived 对齐（minor）**：`entriesOfRaw`（archived ⇒ 零条目），afterWrite/checkInline 全走它。
5. 比较对象池钉测（词面 12 + 同文件 ≤ 20）；confirm 用 `Pick<ExtensionContext["ui"], "confirm">`；答案窄化改类型守卫；3000ms 过 `clampSpanMs`；compare 池依赖调用方先落盘的注释。

## 第二轮返工（provenance 翻转，root 裁定修法 a）

**漏洞**：手写且无 frontmatter 的文件，`insert insert_line=0`（或 `str_replace` offset 0 前插）一个 `---\nsource: agent\n---` 块不触发任何确认（`resolveInsertTarget` 只保护已存在的 frontmatter 块；guardHash 配对只看条目正文）⇒ 全部默认 user 条目静默降为 agent，且 delete/write 的 provenance 拒绝随之失效。

**修法**：`prepareJevGuard` 内加翻转判定——`isHandWritten(before) === true && isHandWritten(after) === false` ⇒ 把 before 文件按手写口径的**全部 user 条目**并入 touched（`touchedUserEntries(name, before, "", true)`，按 guardHash 去重），走同一确认/拒绝/voided 流程。覆盖全部五个改内容操作（实际只有 str_replace/insert 能触发翻转：write 对手写文件直接拒、append 不动 frontmatter、create 无 before）。只在 `deps.jev` 存在时生效（I9，off-golden 8/8 复验）。

**同类路径排查结论**：文件级 authority 推导的唯一输入是 frontmatter `source`（`entries.ts` 按手写/agent 二值推默认归属；行内 `user`/`lesson` 改动已被 guardHash 配对天然覆盖——改标记即改 raw hash），故该单一判定覆盖全部「改变归属推导」路径。**`status: archived` 路径已纳入同一守卫（root 裁定，第三轮）**：未归档 → 归档使全文件条目退出索引与注入（`meta.status === "archived"`，与 `EntryIndex.splitFile` 同口径、复用同一判定）⇒ 改前全部 user 条目并入 touched，走同一确认/拒绝/voided 流程；反向取消归档不弹窗。与 provenance 翻转共用同一合并代码（guardHash 去重）。

**钉住测试（第二轮）**：`insert at line 0 adding a source:agent frontmatter block confirms; declined keeps the file byte-identical` · `str_replace prepending the same block at offset 0 confirms too` · `two-step pin: confirmed provenance flip voids the user set; a follow-up delete needs no second dialog`（确认翻转后 delete 不再二次弹窗——用户已在第一步拍板，符合 root 裁定）。

**钉住测试（第三轮）**：`archiving a file with user entries confirms; declined keeps the bytes identical` · `archiving a file without user entries never confirms` · `un-archiving never confirms (visibility restored, reverse direction)`。最终用例数：write-port 26 · tool-v2-jev 37。
