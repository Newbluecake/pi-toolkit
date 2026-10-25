# P3 死代码清理报告

基线 HEAD `85cf78bb`（plan-lowrisk.md r2.1 §3）。完整的逐条 rg 输出（§3.1 两条命令的命令行与结果）保存在核验证据 JSON 中：`/tmp/p3-evidence.json`（A/B 组 63 条）、`/tmp/p3-c-evidence.json`（C 组）；删除预览 `/tmp/p3-deletion-preview.txt`。

## 核验结果摘要

- A 组（别名残留）+ B 组（零引用函数）共 63 个名字，全部按 §3.2/§3.3 清单删除，命令 ① 只命中声明行，命令 ② 除下列历史文档例外外均为空。
- C 组：`src/web-hub/hub/lan-security-stubs.ts` 删除（含 15 个 notImplemented 桩）；`src/rpc/client.ts` 经 `git mv` 语义移到 `tests/rpc/helpers/rpc-client.ts`（import 改为 `../../../src/...`）；`orchestrator.testing.ts` 未动。
- 未触及：consult、secure、观察组条目、`tests/fixtures`（`git diff 85cf78bb -- tests/fixtures` 为 0 行）。边界钉死文件（SYSLOAD/SCHEDULE/GIT 闭包）的 import 行未改。
- 没有降为观察的新增条目；观察组清单（§3.5）原样保留，本批未删。

## 删除清单

A：formatEnvelope、createMessageKey、createEngine、createWorktreeExtensionPoints、droidLastCallCounts、computeArchiveSignals、packBatches、parseTidyBatchSettings、planIndexEdit/applyIndexEdit/applyIndexEdits、foldJournal/nextRunState/decideOp、createRunLease/readRunLease/refreshRunLease/releaseRunLease/breakRunLease、parseManifestV2、reserveRun/watcherAllowance、buildSelectionItems、executeStep/executeTransaction、boundedViewer、buildLoadHintText/buildLoadRejectText/buildLoadRecoveryNotice、createTracker、toLoadWire/toLoadGateWire/fingerprintLoad、defaultAvatarFs、validateAvatarPngHub/validateAvatarPngNode、UNKNOWN_COMMIT。

B：isMeasureApi、mergeWorktreeSettings、effortInfoOf、canTransitionRunState、readBackupFile、writeManifest、remainingUsd、canDispatch、releaseReservation、isValidInputBudget、claimableNow、undecidedCount、runsOfTask、loadLevelAtLeast、summarizeLoad、buildLoadNotice、renderTaskPreview、isAvatarRejectReason、parseCursor、verifySnapshotAsync、readStopMarker/writeStopMarker/removeStopMarker、readRotateIntent/writeRotateIntent/removeRotateIntent。

C：见上。测试改动：`tests/rpc/rpc.test.ts`（import 路径）、`tests/web-hub/hub/lan-security-surfaces.test.ts`（去掉 stub import 与断言，用例改名 "B repair is async and honours cancellation"）。

## 历史文档例外（主会话裁定允许删除）

1. `lan-security-stubs` → `docs/dev/web-hub/lan-security-P0-surfaces.md:36`（P0 当时的设计描述）。
2. `readStopMarker` → `docs/dev/web-hub/control-plan.md` 第 65、927、1475 行（3 处，D24 当时的设计描述）。

另：`src/rpc/client.ts` 在 `docs/dev/auto-background/plan.md`（57/264/309 行）有历史提及；该文件是移动而非删除，文档不改。

## 验收

- `npm run typecheck`（tsc×2 + vue-tsc）通过。
- `npx vitest run tests/memory tests/sysload tests/schedule tests/web-hub tests/todo tests/cache-ttl tests/external-agent tests/extensions tests/core tests/delivery tests/runtime tests/rpc`：915 个文件、19668 通过、4 跳过，含 `tests/web-hub/boundary.test.ts` 与 lan-security-surfaces。
- 改动文件 `prettier --check` 通过。

## 补充（主会话，2026-10-25）

- 观察组（本批未删，留待后续）：完整清单见 `plan-lowrisk.md` §3.5，本包未删其中任何一项；核验中降为观察的条目已在上文列出。
- 逐条 rg 核验输出未内联：原始证据由开发阶段生成（`/tmp/p3-evidence.json`、`/tmp/p3-c-evidence.json`，临时文件），验收员已对 63 项删除逐条重新核验（全部只剩声明命中），结论见验收记录。
- 历史文档例外（主会话裁定）：`readStopMarker` 在 `docs/dev/web-hub/control-plan.md` 3 处；`lan-security-stubs` / `unimplementedLanSecurityStore` 在 `docs/dev/web-hub/lan-security-P0-surfaces.md:36`。
