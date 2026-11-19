# Terminal retained stock CI preparation

Test/CI entrypoints only, never deployment permission. Read
`docs/dev/web-hub-terminal/README.md` and the stock test's companion Markdown.
Requires existing locked Node >=22.19/dev tools, git history including O7239,
tar/zip/unzip and the authorized test backend/OS prerequisites. No installs or
user rc access are added. Stock N is L2 only; L1 stock PTY is NOT covered.

## Ordinary environment and real file selection

**Ordinary builds/tier1/tier2/secure inherit their original caller environment.**
No dedicated stock HOME/cache/tmp is exported into them. In CI this preserves the
runner's legitimate original `/tmp`; path-sensitive golden/memory budgets must not
see a nested dedicated TMPDIR. Local path-sensitive gates should use an explicitly
private HOME/cache and `TMPDIR=/tmp` (the individual fixtures create owned private
scratch); never point them at site profiles. `ordinaryEnvironment()` does not
mutate its input, removes stock-only control variables and rejects a fully leaked
dedicated stock environment rather than silently falling back.

Vitest 2's CLI `--exclude` does **not** subtract a file from inline workspace
projects. `ordinary-tests.mjs run` sets the explicit `PI_TOOLKIT_TEST_LANE=ordinary`;
the tier2 workspace's exclude subtracts ONLY stock plus retained-existing. Ownership in
`tests/tiers.ts` is unchanged. The retained-existing lane selects exactly that original file at workers1; no lane means the full original workspace, so a
direct unprovisioned stock test still hard-fails. Dedicated cells remove the lane.

```sh
# List only: does not execute tests or secure globalSetup/mounts.
timeout 300 node scripts/ci/ordinary-tests.mjs check
# Ordinary CI gate. Only stock + retained-existing are subtracted; both lanes REQUIRED.
node scripts/ci/ordinary-tests.mjs run --project tier2 --project secure --maxWorkers=2 --no-cache
```

`check` executes real `vitest list --filesOnly` for baseline and ordinary across
**all three projects** plus the real retained-existing lane, and requires exact set equality minus the two required files, with
nonempty projects and no baseline duplicates. The integration regression also
runs the old CLI-only exclude, observes stock STILL selected and verifies the gate
rejects it; losing a real tier1 or secure file must also fail. The original
`test-tiers-actual` suite explicitly clears the lane only for its ownership census.

## Complete local development entrypoints

```sh
# Run from checkout root, in the caller's legitimate ordinary environment.
PI_TOOLKIT_TEST_WORKERS=2 npm test -- --maxWorkers=2 --no-cache
PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier2 -- --maxWorkers=2 --no-cache
```

Both check real selection, build once + build/check web UI in the **ordinary**
environment, run ordinary selected projects, then REQUIRED retained-existing at workers1, and only THEN allocate the private
stock environment, provision and attempt all four cells. The full command still
covers tier1+tier2+secure plus every stock phase. The tier2 command covers
tier2+secure plus every stock phase. Ordinary or dedicated failure makes the
entry nonzero. File filters are rejected at these complete-suite entrypoints;
use direct Vitest for directed tests. No opt-in skip or checkout fallback exists.

## Dedicated provision and four independent cells

`init` prints ONLY `PI_TOOLKIT_TEST_PRIVATE_ROOT` and the safe-artifact directory,
not HOME/cache/tmp. In Actions these two handles go to `$GITHUB_ENV` **after** the
ordinary tests. `provision`/`cell` construct private HOME/cache/tmp internally. A
new owned physical0700 short root is required; no shared fallback or automatic
cleanup. An explicitly supplied root can also be used by the local full wrapper.

```sh
node scripts/ci/terminal-stock.mjs init # export the two printed handles only
# Existing current build/build:web/check:web artifacts are REQUIRED, not rebuilt:
timeout 300 node scripts/ci/terminal-stock.mjs provision
timeout 300 node scripts/ci/terminal-stock.mjs cell npm restart
timeout 300 node scripts/ci/terminal-stock.mjs cell npm rollback
timeout 300 node scripts/ci/terminal-stock.mjs cell zip restart
timeout 300 node scripts/ci/terminal-stock.mjs cell zip rollback
```

Provision uses normal npm pack (`--ignore-scripts` only because builds already
ran) and the original release packager's explicit `--built` mode. Missing/stale
builds fail. Current HEAD, maintenance inputs/profile/output, archive SHA256 and
every consumer file are verified before/after cells. npm/ZIP payload sets match;
no consumer node_modules/links/patches/peer injection/old local artifacts.

Each cell runs its own real Vitest process workers1/no-cache/290s, verifies exact
one passed named cell and no failures. The other format is unselected, not claimed
as coverage. Restart writes a consumer/binding/worker-bound checkpoint; rollback
must reopen that same checkpoint in a different worker and preserve the original
auth/token-in-place hashes and sealed chain. Missing restart checkpoint is a
visible cascading FAILURE, never recreated or replaced by a synthetic checkpoint.
All four CI steps remain required with failure propagation even if ordinary red.

## Failure-only output and bounded artifact whitelist

Raw Vitest stdout/stderr/report/checkpoint/profile stay private and are **never**
upload targets. Each failure emits a schema-filtered summary containing only fixed
cell/step/category/code enums, whitelisted source coordinates and bounded probe
stage/milliseconds. No arbitrary test names, error text, expected/actual values,
paths, token/cookie material or complete environment are forwarded. A regression
runs a real failing synthetic Vitest child with a fake secret in its name/error,
then proves the resulting public summary retains fixed probe cause but not secret.

Each dedicated invocation writes one `safe/<cell>.safe.json`, at most8192 bytes.
CI's `always()` upload lists exactly five filenames (provision plus four cells),
not a wildcard directory; max total content40KiB, retention7days. Success records
contain only cell/pass count; diagnostic details print only on failure. Invalid
schema, unsafe directory or oversize summary fails closed. Missing all files is an
artifact-step error, not a green diagnostic claim.

## Retained-existing required load-isolation lane (r3)

```sh
timeout 300 node scripts/ci/retained-existing.mjs
```

Two controlled full-file workers1 runs of the unchanged real-SDK/safe fixture
passed under the same20/22/30/45/180s budgets. This justifies isolation from the
ordinary workers2 load, **not proof of the unique remote loader.reload root cause**.
No product/test budget, reload/await/receipt, fixture or assertion is relaxed.
CI runs this lane after ordinary tier2, even if ordinary failed; local full wrappers
do the same. A later green lane cannot cancel an earlier red. Stock's already-green
provision/four required cells and five-file artifact contract are unchanged.

The workspace lane selects exactly retained-existing; real list census asserts
ordinary tier2 + singleton existing + stock equals original tier2 with no losses or
duplicates. The lane verifies real Vitest JSON: exactly this file, all three named
parameter cells passed, none missing/skipped/failed. Evidence stays in an owned
short directory without changing HOME/cache/TMPDIR; public output has only fixed
counts/status and existing closed load-probe diagnostics. Any failure returns
nonzero; synthetic controller/report negative tests are not business acceptance.

## Optional T51 external lifecycle evidence (A′, default off)

```sh
PI_TOOLKIT_T51_EXTERNAL_DIAG=existing-zero-first-v1 \
  timeout 300 node scripts/ci/retained-existing.mjs --diagnose-external-once
```

This is a separate optional entry, **not authorization to run a site experiment**
and not a replacement for the required three-cell lane. It registers existing0
only, first publish-new/first verify only. Missing permission/unknown arguments
return closed not-armed/not-run without launching the lane. The ordinary required3
entry strips both controls and retains its original schema/report assertions.
No workflow enables A′; no stock schema or five-file artifact whitelist changes.

The parent adds only passive exit/close observation and emits after the original
product settlement/receipt validation/stop. Child PROGRAM, argv, FDs/flags, SDK,
loader/reload, stop and deadlines are unchanged. The helper keeps the45s synchronous
envelope. Only this optional controller uses default+JSON reporters (JSON-only
loses successful console markers). It validates separate stdout/stderr/failure
message streams, at most one `T51_EXTERNAL_V1` marker per stream, deduplicating only
identical canonical copies. Malformed/extra keys, conflicts, oversize or missing
reports/evidence fail closed. Secrets/raw logs stay private in an owned0700 HOME
subdirectory, not an upload target. Report stat/16MiB bounds precede reading.

One safe JSON line (at most2048 bytes) contains exactly `selection`, `product`,
`asOfMs`, `exit`, `close`, `lastStage`, `reason`, `truncated`; event fields are
`state/ms/code/signal`, all closed enums or bounded milliseconds. Exit75 does not
mean timer-fired. Unseen exit does not mean running. Frozen unknowns stay unknown.
The exit listener never settles the product and is detached on freeze; late close
cannot mutate or re-emit evidence. The evidence exit status gates only exact
selection/armed permission/complete schema, **not product pass, CPU/coverage or
exit/close being seen**. `observed-pass` is always inconclusive; `observed-fail`
remains a product failure even if evidence collection passes. H4 exit-versus-close
is the only additional discriminant; this does not fix the remote root cause.
