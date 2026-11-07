## J8 返工报告

**1) `/mem expired` 确认标题加内容摘要**：`expired-command.ts` 新增 `describeEntry(entry)`（与 review 的 `describeAnchor` 同构：`file › section: "前24码点…"`），用于交互 `label` 和 `describeRow`（--list/降级文本同步受益）。新测试：`the confirmation title includes a content snippet (~24 code points), not just file:line`。

**2) 补 `setEditorText` 回退用例**：`review-command.test.ts` 新增 `fakeUiNoEditor()`（无 `setEditorText` 字段）+ 测试 `conflict: 'Hand to agent' falls back to ui.notify when setEditorText is unavailable`，断言走 `ui.notify` 且仍 `resolve`。

**3) web 端 `review --run` 不再真跑 Jev**：grep 原文确认口径——`jev-arch.md:899`「web 端（Q35）执行 `review` 需要确认，确认后降级为与 `--list` 相同的只读文本清单…不做任何写入（`expired` 同理）」，`jev-plan.md:1183`同口径。`handleMemReview` 重排：`--run` 先判 `deps.interactive`，非交互直接 `formatList(port.review.list(...))+WEB_FALLBACK_NOTE` 返回，不调用 `port.review.run`；交互态行为不变。`command-policy.ts` 的 `review --run` 仍按 plan §4 J8 列为 confirm（plan 明文锁定，未动）——确认后执行的是只读清单，并非"无意义确认"。新测试：`--run from a non-interactive caller never calls port.review.run; degrades to --list text`（断言 `calls.run` 为空、无 `select`、文案含 `[obsolete]` 与终端提示）；原 `--run dispatches...` 测试改名为 `--run dispatches to port.review.run when interactive` 并显式传 `interactive: true`。

**4) `entry-edit.ts` 头部注释补边角说明**：追加一句——section 内容归一化后为空（如纯注释块）致剩余内容并入上一节时，删除仍会摘掉正确标题，无数据丢失，`.trash` 可兜底。

## 自验输出

- `timeout 900 npx vitest run tests/memory/doctor.test.ts tests/memory/doctor-jev.test.ts tests/memory/jev/review-command.test.ts tests/memory/jev/expired-command.test.ts tests/memory/jev/entry-edit.test.ts tests/memory/tidy tests/memory/command.test.ts tests/memory/command-jev.test.ts tests/memory/jev/off-golden.test.ts tests/web-hub/agent/command-policy.test.ts tests/memory/fs-guard.test.ts` → **21 文件 / 427 例全绿**
- `timeout 600 npm run typecheck` → exit 0（复跑两次确认；中途一次撞见 J5 并发保存 `tool-v2.ts` 导致的瞬时报错 `hwFlip`/`archiveFlip` 未定义，重跑即消失——该文件不在 J8 域内，未碰）
- `npx prettier --check`（J8 全部改动文件，含 3 个新测试文件）→ 全绿（`expired-command.test.ts` 改完后跑过一次 `--write` 修格式）

## 遗留

无新增遗留；major（启动提醒缺 core 用量行）按 root 裁定留给 J7 接线处理，本轮未动。
