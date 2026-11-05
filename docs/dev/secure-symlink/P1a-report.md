# #28 P1a report（plan r3 §2 第 1–8 项）

## 改动文件

- src/secure/bin/helper.mjs — `cmdInnerMount`：pin 后 `physicalPaths(v)`，断言 `realMnt === pin.path`，argv 改用新导出 `plainMountSpawnTail(realCipher, realMnt)`；注释写明 §1.2 边界
- tests/secure/launcher-helper.test.ts — 新 describe：physicalPaths 矩阵 L0/L1/L2、L3/L4、tail、判定对拍（helper vs config.ts）、R1/R2/R3 竞争边界（探测侧 + `verifyMountPointIdentity` 侧）
- tests/secure/launcher-cli.test.ts — 根 realpath 化；新增 fake gocryptfs 调用点用例（L1 下 argv 为 `<realpath(dir)>/cipher`）
- tests/secure/domain.test.ts — `judgeVaultMount`：物理 source ⇒ ok，词法 ⇒ foreign
- tests/secure/launcher-symlink.test.ts（新）— 真实挂载正例（unlock→lock ×2，精确 mountinfo 解析，`leaseFree(e)` 5s）与反例（外来 gocryptfs ⇒ foreign、lock 含「不动它」）；`PLAIN_SKIP` 门控
- tests/tiers.ts — `SECURE_MOUNT_FILES` 登记新文件，注释 16→17
- tests/secure/launcher-off-golden.test.ts — 仅 tmp 根 realpath 化（加 import）
- 未碰：data-encryption README、AGENTS.md、test-speed README、冻结文件、fixtures。

## 自验

- tier1 定向（6 文件）：6 passed / 315 tests passed（/tmp/p1a-t1.log）
- `PI_TOOLKIT_TEST_WORKERS=1 npx vitest run --project secure tests/secure/launcher-symlink.test.ts --reporter=verbose`：
  - ✓ positive: unlock → mounted → lock twice; source is the physical cipher; lease released 832ms
  - ✓ negative: a FOREIGN gocryptfs mount at <mnt> stays foreign — status says so, lock refuses to touch it
  - Tests 2 passed，skipped 0
- 变异验证：临时把调用改回 `v.cipher/v.mnt`，正例变红（1 failed | 1 passed）；已还原。
- `npm run test:secure`：17 files passed，619 passed | 1 skipped（skip 为 `launcher-convert.test.ts` 既有用例，非本包）；`launcher-off-golden`（24）通过（/tmp/p1a-secure.log）
- 挂载残留：各阶段前后 `/proc/self/mountinfo` 无 gocryptfs 条目
- `git diff --quiet HEAD -- tests/fixtures/` ⇒ clean；`npm run typecheck` 退出 0；`prettier --check` 改动文件通过

## 遗留

- 第 9、10 项（README / AGENTS.md / test-speed）留 P1b。
- 未跑全量 tier1 / format:check 全仓 / build（按指定范围）。
