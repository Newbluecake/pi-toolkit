# T51 v2 acceptance checkpoint

Status: **P6 IN PROGRESS, NOT deployment approval and NOT all-stack PASS**.
Accepted implementation design is T51 r2. D1 hub owner, D2 shared tabs/creator attribution and D3 drain
then breaking replacement are fixed user decisions. This page replaces obsolete v1/#45 test claims;
former complete O=4e15 evidence does not prove T51 O=7239→N migration.

## Executed evidence

| Surface                                 | Executed evidence                                                                                                                                                                                                        | Limit                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| P1 resource/CAS/quota/idempotency       | `tests/web-hub/hub/terminal/v2/{service,limits,ledger,ledger-await-guards}.test.ts`                                                                                                                                      | Memory/backend doubles where stated; actual private fs for ledger/retirement                                                            |
| Old-kernel completion/archive           | Guarded committed prune, completion fsync/rename/dir failures; `tests/terminal-v2-maintenance/archive.test.ts` exact associations/inode/normalization/rollback snapshots                                                 | Simulated old UUID; controlled drain double; NOT actual reboot/powercut/O/N adapter                                                     |
| P2 independent view/ACK/resize/fairness | `tests/web-hub/hub/terminal/v2/{view,view-regressions,routes,routes-ndjson,revocation-fence}.test.ts`                                                                                                                    | Explicit typed runtime/auth doubles                                                                                                     |
| Real PTY/backend crash                  | `tests/integration/terminal-v2-{backend,backend-crash}.test.ts`                                                                                                                                                          | Owned private uid/rc fixture, no user shells/site credentials                                                                           |
| Real independent transport/public SSE   | `tests/integration/terminal-v2-stream.test.ts`; `web-hub-sse-output.test.ts` retains general identity/gzip/order/bootstrap/slow-peer tests                                                                               | Stream suite explicitly uses service/auth doubles, not full hub                                                                         |
| Real full SDK/backend path              | `tests/integration/terminal-v2-sdk.test.ts`: actual SDK1.5 ExtensionContext, production wireWebHub/UDS/startHub/context RPC, real token auth/PTY, exact durable revision2/zero rows                                      | No LLM request; contract-fixture v2 initialization, NOT trusted fresh history/tool evidence                                             |
| Real both-listener composition          | `tests/integration/terminal-v2-hub.test.ts`: SQLite/token login, shared tab/PID/rename/close, independent view echo/PID gone, original SSE/clientId/subscribe intact                                                     | Agent context responder is explicitly simulated; separate actual SDK case above                                                         |
| Auth independence/facts                 | Same hub suite bad ledger + original passwd/login/logout, logout DB503 on/off/callback isolation; `tests/web-hub/hub/auth-store-facts.test.ts` receipt/await/no repair lookup; fence concurrent token/stale settle tests | Added real A1/A2/A3/A4/A6/A7/A8/A9/A10/late-prune subgates; A1–A12 scoped matrix now executed; final browser/full-gate evidence remains |
| Agent scope/guards                      | `wiring-terminal-v2.test.ts`, `terminal-connection.test.ts`, actual SDK integration, P3 producer context suite                                                                                                           | No stale socket/context adoption; actual changed-cwd SDK replacement matrix still pending                                               |
| UI lifecycle/provenance                 | V2 controller/regression/panel/transport tests; migrated cap/session/drawer/old-event-refusal; actual build/check:web graph + source/artifact/license gates                                                              | Happy DOM is NOT a real browser, CSP/GPU/IME/device proof                                                                               |
| Off/boundary/config/governance          | Full tier1 serial manifest shards; unchanged frozen artifacts; typecheck/build/build:web/check:web/schema/notices                                                                                                        | Exact final commands/counts/red/rerun details in P6 evidence report, not inferred here                                                  |

## Closed continuation gates

- Root-approved shared v1 resource/offer/grant/receipt/frame/HTTP/schema/ports/dead-UI exports removed.
  Only machine policy/refusal classifiers and an inert export-free frozen I8 anchor remain. Frozen V2
  P0/PROTO/fixtures/trace/I8 whitelist unchanged.
- Fixed executable `terminal-v2-maintenance.ts fresh|cycle --private-parent <owned0700>` constructs a
  new private scope, holds filesystem deployment lock + original singleton/socket/dir, measures actual
  fixed O7239/tool observation patch/N clean source/compiled artifacts/toolchain. No arbitrary JSON,
  module loader, old stopped empty-disk inference, reset or existing-site adoption.
- `tests/integration/terminal-v2-maintenance*.test.ts` actually executes real pi1.5 SDK child/UDS/hub/
  native PTY/token login/input/physical proof/original prune/exact ACK/authority revoke → checkpoint →
  real N input/prune/dispose/no-future/same guarded ledger readback → strict rollback inspection →
  controlled O login/input/reap again. Fresh is realized without any fictitious O instance. Immutable
  snapshot identity, publisher/floor guards, source/artifact/socket replacement refusals are real.
  P5 ControlledAudit/old-UUID cases remain clearly simulated; no real reboot/powercut claim. This is
  private development/validation, not site maintenance/deployment/floor lowering.

## Mandatory remaining gates (do not collapse into component greens)

- Extend real mixed/refusal coverage to any remaining browser/device/kernel failure windows. Actual O/O/O→N/N/N→O/O/O, fresh, N/O and O/N SDK/wire plus both exact pure-UI version gates, true-off, unreadable-v1 isolation, owned external-ledger/partial refusals are now executed. Old-kernel archive UUID tests remain simulated, not real reboot.
  No active shell migration/adoption/restart preservation claim. No version-floor lowering/old launch
  based merely on marker/empty ledger.
- A1–A12 scoped real matrix now executes original auth/SQLite/token/intent, actual8s IPC deadline,
  true hub SIGKILL windows, post-commit HTTP/admin response loss, actual55s lookup-result-loss versus
  public SSE and real original-DB hard-expiry timestamp fixture, failure/on-off/late-IO audit parity.
  Fault locations and limits are explicit; no successful auth or physical proof stub.
- Real Chromium seven-case CSP/WebGL PLUS panel CSS network-abort/deadline gate and manifest-verified
  full UI/actual SDK/actual PTY path now PASS on root-provided PW1.65.1/Chromium1255. Explicit dashboard
  selection is required; no injected UI state. Closed-tab cache resurrection was found/fixed with
  private memory metadata only after exact proof+prune; unknown remains visible/charged. WebGL2
  renderer is SwiftShader SOFTWARE, not hardware GPU. No install/download/site action.
- Final full CURRENT membership tier1, latest committed source maintenance/matrix and build/schema/
  boundary/fixture gates still require their final recorded rerun. Historical tier1 count is not
  current-final evidence. P7 independently verifies rather than implementing remaining adapters.
- Firefox, true mobile/OS IME/system clipboard/drop,8-way sustained PTY+slow renderer, secure real
  mount, real kernel reboot/powercut/real ENOSPC device are **NOT RUN**. No deployment approval.

## Test removal/migration accounting

D3 intentionally removes v1 runtime. The corresponding owner/negotiator/authority/receipt/ticket/
resource-fence/private-SSE/v1-controller suites were removed with it; they are not hidden under a new
production path to keep old tests green. Important shared tests were retained or migrated:

- Real general public SSE FIFO/gzip/order/bootstrap tests remain (`sse-output.test.ts` and
  `web-hub-sse-output.test.ts`), while v1 source-accounting/admission-capability tests are obsolete.
- Environment filtering, native system rc preflight, WebGL unavailable and renderer/font/CSP source
  gates remain; optional metadata filtering was restored when retained regression caught relocation
  weakening. V2 quota/ring/backend/cleanup tests replace owner-based semantics.
- Shared real agent-server status/link tests, cap startup/privacy/off tests and UI drawer/session/
  transport tests were migrated to v2 matching scope/zero private SSE, not simply discarded.
- P5's one old production-initializer component case now explicitly says **synthetic** known-empty v1
  layout. It no longer imports the deleted src legacy reader. The separate real executable integration now covers fixed O7239 original initializer/live owner/futures/proof/prune/ACK/authority; that does not retroactively turn this synthetic case into real evidence.
- Former #45 compat/rollback suites against O=4e15 were obsolete, not T51 compatibility evidence.
  Their T51 O7239 replacement now has actual O→N→O/fresh/mixed-SDK/wire/pure-UI/refusal evidence. Browser/device/kernel limits remain explicit; removal itself is not evidence of parity.

## Running locally

Use an owned private HOME/cache/TMPDIR and `PWH_UI_CACHE_DIR` with read-only node_modules, external
<=300s timeout, workers2 and Vitest `--no-cache`. Strict legacy golden/tiered/PE/spawn-golden commands
use explicit TMPDIR=/tmp and only isolated generated fixtures. Never read/connect/modify the site's
`~/.pi/agent/web-hub`. No installing browser assets or terminating user shells.

`npm run typecheck`, `npm run build`, `npm run build:web`, `npm run check:web`, v2 schema/notices checks,
full tier1 serial shards and <=3 integration files per call are independent evidence. Real browser
commands explicitly fail/NOT RUN without provided assets; they do not auto-install or silently skip.
The browser probe is executable source, but has not been executed successfully here.
