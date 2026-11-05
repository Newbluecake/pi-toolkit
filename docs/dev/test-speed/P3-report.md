# P3 报告：secure 测试侧修复（#27，D13–D16）

只改测试侧，`src/**`、`tests/fixtures/**`、`tests/tiers.ts` 未动。符号链接的产品缺陷仍归 #28。

## 改动

- `tests/secure/launcher-convert.test.ts`（D15）：`E2E_ROOT` 改用 `realpathSync(join(REPO,"node_modules"))`，并补 import。
- `tests/secure/launcher-helper.test.ts`（D16）：新增 `SRC`，用于 `HELPER` 和 parity fixture。`REPO = layoutRoot(SRC)`，`node_modules` 是符号链接且 realpath 的 basename 为 `node_modules` 时取其父目录。顶层校验 pi 包的 realpath 与词法路径一致，不一致就抛布局错误。所有 `join(REPO,"node_modules",…)` 断言表达式一字未改。
- `tests/secure/gocryptfs-test-lock.ts`（D13）：拿到锁后写 `<lock>.holder.json`，内容 `{pid,starttime,vitestPid,file}`。`pid` 是 shell holder 的 `holder.pid`。`file` 目前只是 `VITEST_POOL_ID`，不是文件名，没有可靠来源，仅作说明。新增导出 `procStartTime`（zombie 视为已死）、`holderFile`、`describeLockHolder`。超时报错保持 `gocryptfs test lock not acquired (holder exit N)` 前缀，后面追加 `; holder pid … | holder unknown`。诊断是一次同步 ≤4 KiB 读，不延长预算。
- `tests/secure/private-real-harness.ts`（D14）：`awaitNoForeignGocryptfs(ctx, mine, deps?)` 60 s 后抛错并列出外来挂载，不再 `ctx.skip()`。第一次超时写入模块级记忆，之后同一文件的调用立即抛错。`{readMountinfo, now, sleep, memo, windowMs}` 可注入。签名里 `ctx` 保留以兼容调用方，实际不用。
- `tests/secure/gocryptfs-test-lock.test.ts`：只追加 3 个 D13 用例，用私有锁文件。覆盖 sidecar 指向 shell holder 而非 worker、超时消息带 holder；holder 已释放但 sidecar 仍在 ⇒ unknown；starttime 不匹配、sidecar 缺失或损坏 ⇒ unknown。
- 新建 `tests/secure/await-foreign.test.ts`（4 个用例，假时钟，已被识别为 tier1）：持续外来挂载只等一次、第二次立即抛错；瞬态挂载可恢复且不置记忆；`mine` 前缀不算外来，同文本前缀的兄弟目录算外来；非 gocryptfs 挂载忽略。

## 自验

- `npx vitest run tests/secure/await-foreign.test.ts tests/secure/gocryptfs-test-lock.test.ts tests/secure/launcher-helper.test.ts`：3 个文件、180 个用例全过，约 5 s。
- 真实挂载，`PI_TOOLKIT_TEST_WORKERS=1`，覆盖 launcher-convert、launcher-private、launcher-private-unit、init-cleanup-real：4 个文件通过，196 passed、1 skipped，耗时 390 s（日志 `/tmp/p3-real.log`）。这个 skip 是 `it.skipIf(REAL_GETFATTR)` 的既有条件跳过。
- 符号链接布局验收：`git worktree add --detach /tmp/v-sym HEAD` + `ln -s` 本仓 node_modules。因为 P3 的改动还没提交，先把改动文件拷进去再测。launcher-helper 168 个全过；launcher-convert 43 passed、1 skipped，259 s。已 `git worktree remove --force /tmp/v-sym`。
- `npm run typecheck` 通过；改动文件 `prettier --check` 通过；`git diff --quiet HEAD -- tests/fixtures/` 干净。
- 跑前跑后 `/proc/self/mountinfo` 都没有 gocryptfs 残留。

## 遗留（未处理）

1. `launcher-private-cmd.test.ts:907` 和 `launcher-private-unit.test.ts:1795` 各有一份本地 `awaitNoForeignGocryptfs`，60 s 后仍然静默 `ctx.skip()`，不在 P3 文件域内。建议后续把它们换成 harness 导出版（D14 对这两个文件还没生效）。
2. 新增的 `await-foreign.test.ts` 已被识别为 tier1。如果 test-tiers 治理门要求登记，需要 root 在 `tests/tiers.ts` 补。我没跑治理门，所以没发 message_agent。
3. D12 复核：未发现按序号对齐的应答，没有改动。
4. `launcher-private.test.ts` 的 `fresh(ctx)` 现在遇到持续外来挂载会让用例失败，而不是 skip。这是 D14 要求的行为。
5. 报告里的耗时只来自这一台机器，一次串行运行。
