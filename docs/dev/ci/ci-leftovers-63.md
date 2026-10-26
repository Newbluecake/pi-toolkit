# CI leftovers (#63) — test-side only

Follow-up to `ci-fix-2026-10-25.md`. No `src/` change, no `tests/fixtures/` change.

| #   | Item                                                                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `launcher-private-cmd` "--global never bypasses mutual exclusion" skipped on AppArmor-userns CI | Added a userns-free twin in the same describe: a record **without `ns`** is judged by lease + supervisor liveness only (`judgePrivateInstance`), so a plain `flock <lease> sleep` is a live "mounting" instance. Asserts `privateInstanceState` = `mounting`, then `unlock acme --global` ⇒ exit 76 (`plainMountPrivateGate`), message `--private 实例正在挂载（mounting）`, no prompt, no gocryptfs call. Original userns test kept.                                                                                                                                                                                                                                                                                         |
| 2   | umask audit of `mkdirSync/writeFileSync({mode})`                                                | umask only matters when the requested mode has group/other **write** bits (022 strips them; 0700/0600/0755 unaffected). rg over tests/ found 4 such sites: `launcher-helper.test.ts:412` (already explicit chmod), `paths-trusted.test.ts:110/117` (already chmod), `mkdir.test.ts`/`hub-mkdir-dirmode` (set umask / assert via childUmask). No further fix needed. Verified: tar, paths-trusted, hub-mkdir-dirmode, spawn/mkdir, launcher-helper, catalog-store, tree all pass under `umask 022`.                                                                                                                                                                                                                            |
| 3a  | `logic-markdown-perf` growth ratio 8.5 > 8                                                      | Threshold unchanged (linear ≈ 4–6, quadratic ≈ 16). Estimator now uses process CPU time (`process.cpuUsage` user+sys) instead of wall clock (preemption on shared runners was charged to one size), 6 rounds per window, up to 5 windows (best ratio, no blind retry of a failing result: a quadratic parser fails every window). Passes 3× normally and once with 6 busy-loop CPU hogs.                                                                                                                                                                                                                                                                                                                                      |
| 3b  | `web-hub-headless` hub child startup / restore timeouts (HR6; HR5b flaked the same way)         | Readiness signals unchanged (hub.json pid alive, restore record state). `SLOW = 3` is one file-top-level constant (first revision declared it inside one describe ⇒ ReferenceError in H9-prefs; fixed). It is unconditional, not `CI`-only: a local 7-file `--maxWorkers=2` run reproduced the same 15 s boot timeout, so the cap is widened everywhere (a passing run is no slower; only a real hang waits longer). Applied to: the `child hub up` deadline in all three `bootHub` copies, and every readiness wait / test timeout in the restore describe (HR2, HR5b, HR6, HR7). Other describes keep their waits.                                                                                                          |
| 4   | self-built git repos whose `.git` / tree is snapshotted                                         | Same `maintenance.auto=false` / `gc.auto=0` after `git init` in: `convert-fixtures.ts` (earlier), `launcher-convert.test.ts`, `integration/git-graph.test.ts` (`repo()`, used by `snapshotWrites`), `integration/git-graph-cherry.test.ts` (`repo()`, used by `snapshotGitDir`), `integration/web-hub-worktree-graph.test.ts` (`repo()`, objects/refs/index snapshot). Audited by rg of all `git init` in tests/: `convert-preflight` r2 (init only, no commit), `git-wtdiff`, `web-hub-worktree-diff`, `git-worktrees`, `version-git`, `worktrees-real-git`, workflow/extensions worktree tests and `release-script` do not snapshot the repo contents, so left alone. Bare origins/clones in git-graph are not snapshotted. |

Suggested commit: `test(ci): userns-free --global exclusion test, CPU-time perf ratio, CI-scaled hub startup, no git auto-maintenance in convert fixtures`

## 3a′ — `logic-markdown-perf` growth gate: exponent fit instead of a two-size ratio

CI (shared 2-worker runner) still failed the ratio gate (63.89/7.28 = 8.77 > 8) even with CPU time and 5 windows; a ratio of two noisy timings is inherently fragile. Test-only change (`tests/web-hub/ui/logic-markdown-perf.test.ts`); no `src/`, no `tests/fixtures/` change, no product-side counters (a counter would have meant touching the parser — not needed).

- **New criterion**: least-squares power-law exponent k in t ≈ c·nᵏ over 64/128/256/512 KiB (ln–ln fit), per-size time = minimum per-parse process CPU time over 6 interleaved rounds; assert **k ≤ 1.5** (linear ≈ 1, quadratic ≈ 2), best of up to 3 windows (a truly super-linear parser fails every window). The 200 ms @256 KiB bound stays as a loose sentinel. Per-test timeout raised to 90 s (the 512 KiB set costs 1.5–7 s/shape).
- **Observed on the live parser** (10 pathological shapes): k = 1.09–1.27, i.e. ≥0.23 headroom; a single noisy size moves k far less than it moves a 2-point ratio.
- **Mutation proof (detection power kept)**: a permanent in-file guard feeds the frozen O(n²) reference (`fixtures/markdown-ref.js`) on `"*a ".repeat` at 2/4/8/16 KiB through the same `fitExponent`, and asserts k > 1.5 (measured k = 1.99). So an O(n²) regression is separated from linear by ~0.5 on both sides of the 1.5 line; at 16× growth per 4× size step the fitted k is ≈ 2.
- Only this file used wall/CPU growth ratios among the perf tests; the older `ref > live × 10` self-check (16 KiB, ~100× in practice) is unchanged.
- **Verification**: file ×5 with `--maxWorkers=1` all green; `npx vitest run tests/web-hub/ui --maxWorkers=6` ×2 (5907 tests) green with the perf file running under that load; `npm run typecheck` and prettier clean.

Suggested commit: `test(web-hub): markdown perf gate fits growth exponent (≤1.5 over 64–512 KiB) instead of a two-size timing ratio`

## J1 #2 — `highlight-j1-batches` selection-defer flake: MutationObserver microtask seam

CI (shared 2-worker runner) flaked on "a non-collapsed selection INSIDE the body defers the remaining
batches": `expect(kwHeld).toBeLessThan(200)` got 200 (`tests/web-hub/ui/highlight-j1-batches.test.ts:125`).
Test-only change; no `src/`, no `tests/fixtures/` change. **Not a product race** — the deferral check
(`startHighlightBatches`' `deferredBySelection()` in `highlight-core.ts`) runs synchronously at every
step boundary; the test just established its selection too late.

- **Root cause**: batches apply via chained `setTimeout(step, 0)` macrotasks (one per batch, 3–4 batches
  for the 200-line body). The old test did `await vi.waitFor(kw>0)` (default 50 ms poll) and only THEN
  created the selection. On a loaded runner all batch timers can fire before waitFor's first successful
  poll — the poll then already observes the COMPLETED run (kw=200), the selection holds nothing, and the
  "held" assertion reads 200. Locally the poll wins the race and the flake never shows.
- **Fix**: establish the selection inside a `MutationObserver` callback armed before parts arrive. The
  callback is a microtask queued by batch 1's DOM swap, so it runs after batch 1 lands but BEFORE the
  next batch's `setTimeout(0)` macrotask can fire — guaranteed by the event loop on any runner, no fake
  timers needed. The selection still spans two plain tail lines (100/101) the next batch would rewrite.
- **Detection power kept**: asserts a partial state at selection time (`0 < heldKw < 200`); asserts the
  run is HELD across ≥1 deferral-poll window (`kw() === heldKw` after 650 ms; any batch leaking through
  the deferral moves the count); asserts `textContent` is byte-identical while held; clearing the
  selection must resume to full completion (`waitFor(kw=200)`, covers both the `selectionchange` and the
  500 ms fallback-poll resume paths).
- **Verification**: file ×10 with `--maxWorkers=1` all green; `npx vitest run tests/web-hub/ui
--maxWorkers=6` ×3 (5910 tests each) green under concurrent load; `npm run typecheck` clean; prettier
  clean.

Suggested commit: `test(web-hub): make J1 selection-defer batch test deterministic via MutationObserver seam`
