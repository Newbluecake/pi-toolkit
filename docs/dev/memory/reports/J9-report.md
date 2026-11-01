## J9 交付报告

**改动文件清单**（绝对路径）：

- `/home/bluecake/ai/pi-toolkit/docs/dev/memory/jev-arch.md`（v2.1，追加实施状态行 + §19 12 条新勘误 + 12 处定点句子修订）
- `/home/bluecake/ai/pi-toolkit/docs/dev/memory/jev-plan.md`（追加实施状态行 + J4 契约补充注记）
- `/home/bluecake/ai/pi-toolkit/docs/dev/memory/README.md`（新增「Jev」一节：11 条不变式、门禁、残留风险）
- `/home/bluecake/ai/pi-toolkit/docs/guide/memory.md`（新增「Jev（自动分类器）」用户指南节 + 14 键设置表）
- `/home/bluecake/ai/pi-toolkit/AGENTS.md`（peer bump checklist 第 2 条、Frozen artifacts B 级行、Repository layout `skills/` 行）
- `/home/bluecake/ai/pi-toolkit/tests/integration/memory-jev-e2e.test.ts`（新建，2 个真实断言用例）

**12 条勘误落点**（均在 `jev-arch.md` §19，按新增行号 13–24）：#13 J4 契约补充（jev-plan §4 J4）、#14 `TAG_MAJOR_BATCH_TOKENS`（§5.2）、#15 `/mem` 描述追加 + off-golden 登记（§5.3/§9.2）、#16 `max_tokens_exceeded` 关键词（§5.2）、#17 单档超时→瞬态失败非 abort（§5.2）、#18 门禁阈值 0.6 维持 + 误拦形态（§6.4.4）、#19 C-J4 结论（§10）、#20 E 层含 pending + tagBulk all 重问全部（§6.1.4/§6.2.3）、#21 J6 遗留不成立，message_start 已覆盖（§6.1.4）、#22 用户令守卫域含 delete（§6.2.5）、#23 shell-parse 短旗标集群（§6.4.2）、#24 J9 自检总结。Q37 原已落地，核对无误。

**用户指南新增小节**：Jev 是什么/四时刻、首次启用说明、状态表（full/partial/inactive/off）、非 Linux 退化、行内权威注释语法表、用户令归属与守卫范围、`/mem jev`/`tags`/`review`/`expired` 命令用法、成本量级、14 个 `memory.jev.*` 键表。

**e2e 用例**：`tests/integration/memory-jev-e2e.test.ts` — `memory jev e2e (full) > empty dir → /mem init → write (tagged) → U/A → gate once → /mem review → /mem jev`；`memory jev e2e (partial) > same shape with a classifier-unavailable registry: write/U/A/gate degrade to zero-call paths`。均为真实断言（标签回显内容、U/A 注入内容、门禁 block/reason 文案、job 清除后放行），非恒真 stub。

**文档与代码冲突清单**：无发现冲突；§19 #24 已逐条核对 1–23 与 `src/memory/settings.ts`、各包报告、`510a0678`/`31e845ce` commit、`eval/jev-baseline.md` 一致。

**自验命令及结果**：

- `timeout 600 npx vitest run tests/integration/memory-jev-e2e.test.ts` → 2 passed
- `npm run format:check` → 绿
- `npm run typecheck` → 绿（exit 0）
- `npx vitest run tests/memory tests/conformance/memory-jev-channels.test.ts tests/boundary tests/governance tests/config tests/secure/settings-override.test.ts tests/web-hub/boundary.test.ts` → 125 files / 2201 passed | 1 skipped
- `npx vitest run tests/docs/agents-md.test.ts tests/memory/tool-surface.test.ts`（AGENTS.md 守卫测试）→ 18 passed
- `git diff --stat origin/dev -- tests/fixtures/` → 仅 `activate-trace.json`、`memory-tool-surface.json`、`memory/jev-off-golden.json`（均来自已合入 J 包，非本包改动）
- 全量 `PI_TOOLKIT_TEST_WORKERS=4 npm test` → 31636 passed | 1 failed | 23 skipped；失败项 `tests/secure/launcher-convert.test.ts`（真实 gocryptfs 挂载，Tier 2，与本次改动无关）单独重跑绿，按 AGENTS.md 触发策略判定为 flake，非回归

**遗留问题**：无（web 紧凑分支按主会话裁定不做）。

**建议的 release commit body 要点**：

- `feat(memory): [J9] jev wrap-up — docs, AGENTS.md peer-bump/frozen-artifact registration, e2e`
- 默认开启 ⇒ 工具描述变体使 system prompt 前缀一次性变化、缓存失效一次（jev-arch §8 评审 #16）
- Q37：召回同步等待迁移为整数秒键 `memory.jev.recall.waitS`（默认 2 秒），旧版无此键用户首次 `/reload` 会看到新默认值 — 非破坏性变更，无需迁移 WARN（纯新增键）
- `tests/config/__corpus__/{setting-specs-pin,settings-corpus}.json`、`tests/fixtures/memory-tool-surface.json` 等 corpus/golden 的 sha 已在 J3/J5 分别重 pin，原因均为新增 `memory.jev.*` 键/工具描述 key，非回归
