# sysload 恢复通知文案变更报告

日期：2026-11-05 · 车道：L1 · 包：sysload recovery notice

## 背景

用户反馈：负载回落后的恢复通知为 `[load] warn · 负载已回落，可以继续派发`，`warn` 级别 token 让恢复通知看起来像警告（历史上恢复时 level 可能仍是 warn，取决于采样窗口）。要求改为与 quota 的 `[quota 恢复]` 一致的恢复类文案。

## 改动

- `src/sysload/render.ts` — `buildLoadRecoveryText` 前缀改为 `[load 恢复]`，不再拼 `levelLabel(verdict.level)`；`levelLabel` 因此无引用，一并删除。
- `tests/sysload/render.test.ts` — 恢复通知断言更新：前缀 `[load 恢复]`、正文含「可以继续派发」、且 **不含 `warn`/`crit`**（`\b(warn|crit)\b` 全文不匹配）。
- `docs/dev/sysload/plan.md` §6.4 — 恢复块示例同步为新文案，注明旧 `[load] ok · …` 示例作废。
- 本报告。

## 影响面核查（只影响注入给模型的恢复通知；2026-11-05 打回复核后订正）

`rg -n "\[load\]|负载已回落|buildLoadRecoveryText" src/ tests/ docs/ -g '!candidates.jsonl'` 全部命中及结论：

| 命中                                                                        | 结论                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/sysload/render.ts:36-37`                                               | 实现本身（本次改动）                                                                                             |
| `src/sysload/hook.ts:3,85`                                                  | `buildLoadRecoveryText` 唯一调用方：turn_end `subagent:load` hint，注入给模型 —— 期望的改动面                    |
| `src/sysload/gate.ts:28,42`                                                 | `loadDetail`（escalation 详情行）—— 未改，级别 token 属于升高提示，保留                                          |
| `tests/sysload/render.test.ts`                                              | 断言已更新（含 warn/crit verdict 负断言，旧实现会挂）                                                            |
| `tests/sysload/hook.test.ts:117`                                            | 断言的是 escalation `[load] warn · CPU`，非恢复文案 —— 不需改                                                    |
| **`tests/integration/load-turn-end-wiring.test.ts`（tier2，首版报告漏掉）** | 同一恢复文案的集成消费者，首版仍断 `toContain("ok")` 被打回；已改为 `[load 恢复]` / `负载已回落` / 不含 `\b(warn | crit)\b` |
| `src/web-hub/ui/src/components/shell/TopBar.vue:100`                        | 仅为变量名 `load` 偶然命中 `[load]`，与文案无关                                                                  |
| `docs/dev/sysload/plan.md`                                                  | 文档示例，已同步                                                                                                 |
| `docs/dev/topic-switch/judge-eval/candidates.jsonl`                         | 历史评测语料含旧文案，数据文件不动                                                                               |

其余结论不变：升高提示 `buildLoadEscalationText` 未改动；HUD 状态行 / hub `load.v1` SSE 帧 / `StatusInfo.loadGate` / UI load 组件走独立数据通道，级别显示不受影响；日志路径不调用该函数；`tests/fixtures/**` 无 sysload recovery golden，未触碰。

## 验证（2026-11-05）

- `npx vitest run tests/sysload` ✅
- `rg -n "\[load\]|负载已回落|buildLoadRecoveryText" src/ tests/ docs/`（排除 candidates.jsonl）：见上表，无遗漏消费者
- `npx vitest run tests/sysload tests/integration/load-turn-end-wiring.test.ts` ✅（打回修复后重跑）
- `npm run typecheck` ✅
- `npx prettier --check` 改动文件 ✅
