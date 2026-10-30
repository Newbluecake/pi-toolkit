## J4 返工报告

验收员 6 条全部处理完毕，未 commit，文件域未越界（仅 J4 文件）。

**1. review 行日期格式（minor）** — `command-port.ts` 组装 view 时改传 `lastRunAt.slice(0, 10)`（侧车仍存完整 ISO 供 §6.3.1 intervalDays；format.ts 未动）。新增测试 `review line shows a DATE-ONLY lastRunAt (§9.4)`（command-port.test.ts）：seed 全 ISO 后断言输出 `review   last 2026-10-28 · 0 open → /mem review` 且无 `T` 时戳。

**2. 无 UI 写操作提示（minor）** — 查证现有惯例：`command.ts` 所有分支及 `tidy/command.ts` 的 §7 gate（tidy/command.ts:96-97）均为 `if (ctx.hasUI) ctx.ui.notify(...)`，`/mem` 命令族无 hasUI 之外的输出通道（无 stderr/console 回退）。结论：**保持无 UI 静默拒绝（框架无输出通道）**，`handleMemJev`/`handleMemTags` 的 notify helper 与 `gated()` 处已加注释说明。

**3. project 断言（nit）** — review.test.ts 的 fakeClient AskRecord 补记 `state`，新增断言 `client.asks[0]!.state["project"] === "demo"` 与 `every(a => a.duty === "review")`。

**4. import 期计算（nit）** — review.ts 删除模块加载期的 `presetTaxonomy()/PRESET_TAXONOMY`（mergeTaxonomy 调用+抛错路径），改为常量最小合法值 `UNUSED_TAXONOMY = { rev:"", types:[], importance:[], tags:[] }`（effectiveMeta 实现完全忽略该参数），并删除 mergeTaxonomy import。

**5. partial 停机前提（nit）** — 按推荐改为**显式读 status**：`tagBulk` 新增 `degraded()`（`client.status()` 为 `off`/`partial` 即停），并入 `halted()`，每次 ask 前检查；doc 注释写明不再依赖「ask 失败 ⇒ partial」隐式前提。新增测试 `client reports partial ⇒ run stops even though asks would keep succeeding`：status 在第 1 次 ask 后翻 partial、ask 恒成功 ⇒ 恰好 1 次调用、30 条全 pending。

**6. 1MB 字节上限补测** — index-store.test.ts 新增两条：`1MB byte cap: dead hashes drop first, then oldest-at shrinks until the file fits`（3×600KB，dead 先删、再删到单条 ≤1MB）与 `writeIndexPatch enforces the byte cap on the persisted file`（写入后文件实测字节数 ≤ SIDECAR_MAX_BYTES、留最新条）。

**自验输出（真实结果）**

- `timeout 900 npx vitest run tests/memory/jev tests/memory/command-jev.test.ts tests/memory/command.test.ts tests/memory/fs-guard.test.ts tests/web-hub/agent/command-policy.test.ts tests/boundary/pi-free.test.ts` → **Test Files 24 passed (24) / Tests 583 passed (583)**（prettier 格式化后复跑同结果）
- `timeout 600 npm run typecheck` → exit 0
- `timeout 300 npm run format:check` → All matched files use Prettier code style!（exit 0）
- `git status --short -- tests/fixtures/` → 0 行（fixtures 未动）

**遗留**：无新增；此前上报事项（J6 接线四个可选 deps、`PI_API_ALLOWED_DIFF` 追加 `registration:registerCommand:mem`、TAG_MAJOR_BATCH_TOKENS 待 J9 回写架构稿、用户标签 disable=删除）不变。
