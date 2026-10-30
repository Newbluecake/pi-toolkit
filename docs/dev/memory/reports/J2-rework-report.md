## J2 复验补齐报告

### 新增测试（按验收条目）

1. **decide.test.ts** — `threshold boundary (主会话裁定①, threshold=0.6): p=0.59 excluded, p=0.60 included`
2. **questions.test.ts** — `exact default-cap boundary: a combined total of exactly QUESTION_BATCH_TOKENS (12,000) fits in one batch` / `exact default-cap boundary + 1 (12,001) splits into two batches`（用默认 cap，无 cap 参数；新增 `growToExactTokens` 闭式解辅助函数，避免逐字节增长导致的 O(n²) 超时）
3. **client.test.ts** — `a 5th concurrent background-mode ask() waits for a slot (cap is 4, not 3)`、`sync and background pools are independent: 3 sync in flight does not block a background call`
4. **decide.test.ts** — `threshold boundary (plan test checklist: 0.69/0.70): p=0.69 excluded, p=0.70 included`
5. **client.test.ts**：
   - `per-activation dollar cap (maxCostUsd) latches budget-exhausted; no further classify() calls`
   - `an already-aborted request signal returns 'aborted' immediately without calling classify()`
   - `probe() passes its signal through: an already-aborted signal returns promptly without reaching the registry`
   - `probe() passes its signal through: aborting mid-flight lets probe() return promptly instead of hanging`

### 两处代码小修 diff 摘要

- `src/memory/jev/client.ts` `callOnce`：在构造 `AbortController`/发起 `registry.classify` 之前新增 `if (outerSignal?.aborted === true) return { ok: false, grade: "aborted", errorMessage: "aborted" };`，零等待、零请求。
- `src/memory/jev/client.ts` `probe()`：删除 `void signal;`，改为 `await ensureAvailability(registry, true, signal)`；`ensureAvailability` 新增可选 `signal` 参数，`getAvailableOfType` 本身无 signal 钩子（contracts.ts 未定义），故采用 `Promise.race([resolvePromise, abort后resolve(undefined)])`：预先已 abort 则跳过调用，运行中 abort 则让 `probe()` 立即返回（底层调用无法真正取消，结果被丢弃），已在注释中说明这一限制。

### 开发报告更正

上次报告「并发上限(sync≤3/background≤4)」只测了 sync 分支，background 分支未实测，表述与实测不符；现已补齐 background≤4 与两池互相独立的测试，三例均通过。

### 自验命令与真实输出

```
timeout 900 npx vitest run tests/memory/jev tests/boundary/pi-free.test.ts
→ Test Files 16 passed; Tests 409 passed
timeout 600 npm run typecheck && timeout 300 npm run format:check
→ typecheck 无输出（绿）；format:check: "All matched files use Prettier code style!"
```

（`npx prettier --write` 修了 `client.ts`/`client.test.ts` 两处格式后重跑，409 测试与 typecheck 仍全绿。）

无遗留问题，未越界，未触及 fixtures/J1 文件/package.json，未 commit。
