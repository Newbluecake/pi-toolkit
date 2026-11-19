# Terminal retained stock CI preparation

These are **test/CI entrypoints only**, not maintenance/deployment permission. Read
`docs/dev/web-hub-terminal/README.md` and
`tests/integration/terminal-v2-retained-stock-restart.md` first. Node >=22.19 and the
already installed locked dev tools, git history (including O7239), tar/zip/unzip,
Python and an audited system shell startup environment are required. No install,
user rc, observer, stock L1 PTY or live profile access is performed by this gate.
The old ordinary fixture uses the existing explicit isolated test backend; stock N
is L2 only and its genuine create requests must fail E_LIMIT before backend fork.

## Complete development entrypoints

```sh
# Run from the checkout root. They create a fresh owned short private HOME/cache/tmp
# unless PI_TOOLKIT_TEST_PRIVATE_ROOT explicitly names an owned physical 0700 root.
# No shared cache/tmp fallback; evidence is retained, not automatically removed.
PI_TOOLKIT_TEST_WORKERS=2 npm test -- --maxWorkers=2 --no-cache
PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier2 -- --maxWorkers=2 --no-cache
```

Both build once (production build + web UI + UI check), run the ordinary selected
projects with **only** the exact stock file excluded, then provision new consumers
and execute all four stock cells. The full `npm test` still covers tier1+tier2+secure
and all stock phases. `test:tier2` covers tier2+secure and all stock phases. Either
ordinary failure or any dedicated failure makes the entry nonzero; a failed
restart cannot make rollback green. Targeted tests use `node
node_modules/vitest/vitest.mjs run --project tier2 --maxWorkers=1 --no-cache <file>`
in an explicitly private environment. The full-suite wrapper rejects file filters
rather than accidentally applying a filter to the stock acceptance gate.

Tier ownership and the workspace partition are **unchanged**. Direct `vitest` on
the stock file without consumers still hard-fails. No opt-in skip or checkout
fallback is provided. An unavailable prerequisite is an error, not coverage.

## CI / bounded individual commands

The workflow builds once before tests, reusing those outputs for ordinary tests,
normal `npm pack --ignore-scripts` (prepack already fulfilled), and the original
release ZIP packager's explicit `--built` mode. That mode requires built outputs
and never silently rebuilds. `provision` verifies the maintenance builder, every
maintenance input, selected-source profile and output hash against the current
checkout and HEAD. Both archives' checksums and **every** unpacked consumer byte
are bound to the same checkout in private `consumers/binding.json`. npm and ZIP
payload sets must agree; no consumer `node_modules`, links, peer injection or
consumer patch is allowed. Every cell revalidates that binding before and after.
Missing/stale build data fails; no old local artifacts are referenced.

```sh
# First create private env. In Actions append to $GITHUB_ENV; in a developer shell
# export these generated KEY=value lines (only newly generated private paths).
node scripts/ci/terminal-stock.mjs init
# After exporting the printed env and using it for these builds:
timeout 300 npm run build
timeout 300 npm run build:web
timeout 300 npm run check:web
timeout 300 node scripts/ci/terminal-stock.mjs provision
timeout 300 node scripts/ci/terminal-stock.mjs cell npm restart
timeout 300 node scripts/ci/terminal-stock.mjs cell npm rollback
timeout 300 node scripts/ci/terminal-stock.mjs cell zip restart
timeout 300 node scripts/ci/terminal-stock.mjs cell zip rollback
```

Provision is mandatory in CI after tier1 actually ran, even if the ordinary tests
failed; four individually named required steps follow. There is no
`continue-on-error`. Build/preparation failure already makes the job red. Each
cell runs a separate Vitest process (workers1/no-cache, outer 290s), checks real
JSON report selection (exact one passed named cell / no failures), and retains
exit metadata and private logs. The other parameter is deliberately unselected,
not claimed as passed/skipped coverage. Restart checkpoints bind consumer path,
consumer binding digest and actual Vitest worker PID; rollback checks a different
worker, reopens the **same** checkpoint/installation and verifies the terminal-only
result. Its original auth/token hash checks remain in place; no auth data is
copied into CI logs. No signal/observer/PTY L1 claim is added.
