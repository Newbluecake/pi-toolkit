# T51 v2 acceptance checkpoint

Status: **PARTIAL / BLOCKED, NOT deployment approval and NOT all-stack PASS**.
Accepted implementation design is T51 r2. D1 hub owner, D2 shared tabs/creator attribution and D3 drain
then breaking replacement are fixed user decisions. This page replaces obsolete v1/#45 test claims;
former complete O=4e15 evidence does not prove T51 O=7239→N migration.

## Executed evidence

| Surface                                 | Executed evidence                                                                                                                                                                                                        | Limit                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| P1 resource/CAS/quota/idempotency       | `tests/web-hub/hub/terminal/v2/{service,limits,ledger,ledger-await-guards}.test.ts`                                                                                                                                      | Memory/backend doubles where stated; actual private fs for ledger/retirement                |
| Old-kernel completion/archive           | Guarded committed prune, completion fsync/rename/dir failures; `tests/terminal-v2-maintenance/archive.test.ts` exact associations/inode/normalization/rollback snapshots                                                 | Simulated old UUID; controlled drain double; NOT actual reboot/powercut/O/N adapter         |
| P2 independent view/ACK/resize/fairness | `tests/web-hub/hub/terminal/v2/{view,view-regressions,routes,routes-ndjson,revocation-fence}.test.ts`                                                                                                                    | Explicit typed runtime/auth doubles                                                         |
| Real PTY/backend crash                  | `tests/integration/terminal-v2-{backend,backend-crash}.test.ts`                                                                                                                                                          | Owned private uid/rc fixture, no user shells/site credentials                               |
| Real independent transport/public SSE   | `tests/integration/terminal-v2-stream.test.ts`; `web-hub-sse-output.test.ts` retains general identity/gzip/order/bootstrap/slow-peer tests                                                                               | Stream suite explicitly uses service/auth doubles, not full hub                             |
| Real full SDK/backend path              | `tests/integration/terminal-v2-sdk.test.ts`: actual SDK1.5 ExtensionContext, production wireWebHub/UDS/startHub/context RPC, real token auth/PTY, exact durable revision2/zero rows                                      | No LLM request; contract-fixture v2 initialization, NOT trusted fresh history/tool evidence |
| Real both-listener composition          | `tests/integration/terminal-v2-hub.test.ts`: SQLite/token login, shared tab/PID/rename/close, independent view echo/PID gone, original SSE/clientId/subscribe intact                                                     | Agent context responder is explicitly simulated; separate actual SDK case above             |
| Auth independence/facts                 | Same hub suite bad ledger + original passwd/login/logout, logout DB503 on/off/callback isolation; `tests/web-hub/hub/auth-store-facts.test.ts` receipt/await/no repair lookup; fence concurrent token/stale settle tests | Complete A1–A12 multi-window/rotate SIGKILL matrix not yet covered                          |
| Agent scope/guards                      | `wiring-terminal-v2.test.ts`, `terminal-connection.test.ts`, actual SDK integration, P3 producer context suite                                                                                                           | No stale socket/context adoption; actual changed-cwd SDK replacement matrix still pending   |
| UI lifecycle/provenance                 | V2 controller/regression/panel/transport tests; migrated cap/session/drawer/old-event-refusal; actual build/check:web graph + source/artifact/license gates                                                              | Happy DOM is NOT a real browser, CSP/GPU/IME/device proof                                   |
| Off/boundary/config/governance          | Full tier1 serial manifest shards; unchanged frozen artifacts; typecheck/build/build:web/check:web/schema/notices                                                                                                        | Exact final commands/counts/red/rerun details in P6 evidence report, not inferred here      |

## Mandatory remaining gates (do not collapse into component greens)

- **Frozen legacy shared declarations**: remove old v1 resource/offer/grant/receipt and old
  frame/route exports from the previously frozen shared files only after coordinator authorization.
  V2 P0 schema/ports/ordinary PROTO and frozen fixtures stay unchanged. Runtime legacy reader/PTY/
  authority/SSE execution is deleted, but full production/schema deletion gate remains **BLOCKED**.
- **Trusted executable maintenance**: actual fixed trusted fresh/O/N in-process audit adapter, genuine
  deployment/publisher prevention facts, real singleton/directory identity, measured version/artifact,
  original live O physical proof→durable resolve/prune→exact ACK/authority/futures closure, real N
  dispose/no-future/same-ledger readback. Cannot accept CLI78, JSON/operator booleans or stopped empty
  disk as these observations. User authorized private controlled rehearsal only, not site maintenance.
- Real O=7239→N→O full login/open/reap, valid old-kernel archive rollback, dirty/current unknown/corrupt
  ledger refusal, fresh realizable without an O instance, mixed O/O/O–N/O/O–O/N/N–N/N/O and true-off.
  No active shell migration/adoption/restart preservation claim. No version-floor lowering/old launch
  based merely on marker/empty ledger.
- Full A1–A12 auth matrices with reserve/prune IO barriers and each mutation type, external DB55s/hard
  expiry, concurrent old-finally, rotate original intent/token-written/revoke crash windows. No auth
  callback can await terminal fs/reaper or replace original transaction outcome.
- Real Chromium seven-case CSP/WebGL gate plus manifest-verified full UI/SDK/PTY probe. Explicit offline
  Playwright1.63.0/Chromium1243 assets are absent here; no install/download was attempted. Firefox,
  true mobile/OS IME/system clipboard/drop,8-way sustained PTY+slow renderer, secure real mount,
  real kernel reboot/powercut/real ENOSPC device are **NOT RUN**.
- Recheck P4 panel CSS resource-load failure/deadline/geometry in the real browser; renderer/xterm
  CSS paths are bounded but the PanelV2 onMounted link itself is inherited accepted component code,
  not independently proven by happy-dom. Do not claim full CSS-failure gate from source-only migration.

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
  layout. It no longer imports the deleted src legacy reader; real fixed-O initializer/tool bridge is
  a pending integration gate, not a silently preserved real-O PASS.
- Former #45 compat/rollback suites against O=4e15 were obsolete, not T51 compatibility evidence.
  Their replacement T51 real O=7239 matrix is still **NOT RUN**. Removal is not evidence of parity.

## Running locally

Use an owned private HOME/cache/TMPDIR and `PWH_UI_CACHE_DIR` with read-only node_modules, external
<=300s timeout, workers2 and Vitest `--no-cache`. Strict legacy golden/tiered/PE/spawn-golden commands
use explicit TMPDIR=/tmp and only isolated generated fixtures. Never read/connect/modify the site's
`~/.pi/agent/web-hub`. No installing browser assets or terminating user shells.

`npm run typecheck`, `npm run build`, `npm run build:web`, `npm run check:web`, v2 schema/notices checks,
full tier1 serial shards and <=3 integration files per call are independent evidence. Real browser
commands explicitly fail/NOT RUN without provided assets; they do not auto-install or silently skip.
The browser probe is executable source, but has not been executed successfully here.
