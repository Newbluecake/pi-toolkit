# U1 legacy UI baseline (one-shot, not an A/B frozen artifact)

`legacy-60b2e838.json` was recorded once from baseline commit
`60b2e8384cc48e0d9df979902245e690aa0314d0`, not generated from current U1 output and not
obtained by reading old source into a snapshot. It lives only in this directory; no existing
`tests/fixtures/` artifact was changed. The recorder refuses other revisions and overwrites.

## Comparison contract

- Exact serialized **element DOM**, including text and attributes, **excluding comment nodes**.
  This is deliberately NOT a claim about Vue comment/fragment serialization byte parity.
- Ordered UI → `HubSpawnHandle` request intents, including endpoint/method/query or
  `newSession.submit` input. This is NOT a raw HTTP-byte ledger; the unchanged transport's
  wire behavior is independently covered by `transport-contract.test.ts`.
- Deterministic timestamp, language, public records, policy and interactions are shared by
  recorder and test in `legacyScenario.ts`. The expected JSON is a checked-in one-time result.
- Cases: no exited capability, ordinary history capability, restore-off. Each captures the
  actual AgentList and menu; direct SpawnRow retry/details; ordinary history dialog
  mount/search/Enter/kind/resume where its existing entry is reachable. No-cap history-off
  input does not mount an unreachable dialog.

## Actual generation commands

All scratch files were beneath the U1 work directory; dependencies remained a read-only
symlink. These commands were executed before adding the JSON to the U1 commit:

```sh
cd /home/bluecake/pi-exited-u1
GIT_OPTIONAL_LOCKS=0 git -c log.showSignature=false worktree add --detach \
  /home/bluecake/pi-exited-u1/.u1-baseline 60b2e838
mkdir -p .u1-baseline/tests/web-hub/ui/__baseline__
ln -s /home/bluecake/pi-exited-u1/node_modules .u1-baseline/node_modules
cp tests/web-hub/ui/__baseline__/legacyScenario.ts \
  .u1-baseline/tests/web-hub/ui/__baseline__/legacyScenario.ts
cp tests/web-hub/ui/__baseline__/record-legacy.ts \
  .u1-baseline/tests/web-hub/ui/__baseline__/record-legacy.test.ts
cp tests/web-hub/ui/__baseline__/record-workspace.ts.txt .u1-baseline/.u1-record.workspace.ts
cd /home/bluecake/pi-exited-u1/.u1-baseline
NODE_OPTIONS='' HOME=/tmp/u1h XDG_CACHE_HOME=/tmp/u1c TMPDIR=/tmp/u1t \
PI_TOOLKIT_TEST_WORKERS=2 \
U1_BASELINE_OUTPUT=/home/bluecake/pi-exited-u1/tests/web-hub/ui/__baseline__/legacy-60b2e838.json \
node node_modules/vitest/vitest.mjs run \
  --workspace /home/bluecake/pi-exited-u1/.u1-baseline/.u1-record.workspace.ts \
  --project baseline --no-cache tests/web-hub/ui/__baseline__/record-legacy.test.ts
```

The scratch worktree was subsequently removed with `git worktree remove --force` (only the
newly created, owned scratch tree). No reset, stash, push or clean was used. The special
workspace template supplies absolute root/setup paths to avoid Vitest 2's nested-worktree
workspace discovery resolving the parent project's setup file. The ordinary root workspace
attempt failed before running any test; only the explicit baseline workspace produced JSON.

Do not regenerate to fix a parity failure. Investigate a changed input, DOM or request first;
any intentional compatibility change needs its own declared contract decision.
