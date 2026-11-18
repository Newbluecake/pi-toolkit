# WebHub terminal · T51 v2 integration

> Read before changing agent context metadata, hub terminal service/resource lifecycle, either HTTP
> listener/auth bridge, UI terminal entry/renderer, maintenance tools or their tests.
>
> **Integration checkpoint, NOT release/deployment approval.** V2 execution is wired. The fixed controlled-scope trusted O/N/fresh entry and real O→N→O rehearsal are implemented; complete mixed-version/refusal/auth/browser/device gates remain in progress. Root approved obsolete v1 shared declaration deletion on 2026-11-18; the shared execution schemas/exports are now removed. Component/test greens do not imply full T51 acceptance.

## Ownership and off

- The hub alone owns PTY, ring, allocation ledger, cleanup/reaper and tabs. Agent sessions produce
  **metadata only** from their actual current context, trusted domain/child/main guard and current UDS.
- D2: all currently valid WebHub logins share eligible-session tabs; creator is quota/revocation
  attribution, **not ACL**. One view writer per term, busy never steals. LAN login is effectively
  current-OS-uid arbitrary execution: not a cwd sandbox and not model-approved execution.
- Machine policy is a boot-frozen, bounded read of selected agentDir settings. That read is the sole
  off IO exception. Unknown/denied launcher source never infers plain. D8 secure/locked forced-off,
  post-HOST_KEY main-only, print/private namespace/missing guard refusal remain.
- True off creates no service/store/backend/context producer, positive status/cap, UI terminal DOM or
  requests. Ordinary PROTO/hello mandatory fields do not change. Runtime old names stay unchanged.
- Only browser cap `terminal.tabs.v2` + matching `status.terminalSessionV2` presents a candidate entry.
  The hub still independently checks real auth/expiry/CSRF/source/privacy/current scope and resources.
  Old namespace/results/commands are refused, never executed as fallback.

## Agent metadata and private context RPC

`agent/terminal/context.ts` has no IO/timers/PTY/authority/receipt imports. `agent/index.ts` supplies trusted
plain/child/private-namespace/control facts; absent trust denies. A real link starts a new generation
**synchronously before slot replay**. Raw stored status has no positive v1/v2 declaration; write-time
projection revalidates the live original context/link/guard. Ticks and eligibility recovery never start
or revive a withdrawn generation.

`terminal_context_*` is intercepted before ordinary decoders/registry/pending commands on both sides,
including malformed/disabled frames. Hub context resolution is exact-scope, <=2s/32 flights, fresh rid,
original socket object + declaration generation/limits and original privacy. A frozen snapshot is
registered by object identity in a WeakMap; copied/equivalent objects are not capabilities. Context/cwd
never enters command history, registry/public SSE or audit. Cwd is captured for each accepted create;
invalid cwd fails closed, never substitutes HOME/hub cwd. No cwd/shell migration on later ctx changes.

Link/declaration/privacy loss synchronously seals old handles/futures and initiates cleanup. The local
`invalidateScope` permits a later **new trusted declaration + explicit request** in the same epoch;
old handles never revive. Permanent `retireScope` still permanently closes that scope. Reconnect must
not accidentally create a permanent tombstone, nor keep an old writer alive.

## Hub assembly / allocations / physical release

`assembly-terminal.ts` synchronously composes ONE guarded ledger/context/service/views/fence/resize gate
and starts a bounded terminal-only initialization Promise. HTTP/auth/rotate recovery do **not await**
terminal initialization or cleanup. Both listeners use those same objects. The original singleton,
owner object, listening socket and original socket/directory identity fence every resource write;
no second lifecycle lock is invented. Admission stops on close, but original ownership remains usable
for proof/prune until teardown releases the singleton.

Production only verifies tool-created v2 marker/witness/ledger. Missing/partial/unknown never means
fresh and is never healed. Initialization compares marker/witness as closed semantic objects, then
pins original bytes/inodes/directories. One `allocationsById` set includes hot and cold rows, no double
counting. Defaults 2/session, 2/principal, 8/total, hard total32; unknown occupies its exact original
session/principal/total dimensions. An old epoch with the same sessionId cannot bypass quota.

- Legal current-kernel cold rows are individually `cleanup-unknown`, never attach/adopt/TTL-release.
  Remaining quota can create; quota exhaustion is E_LIMIT, not global quarantine.
- Bad/unsafe/duplicate/oversize ledger, external mutation or unknown commit latches resource
  unavailable **only for terminal**. Auth stays independent; known hot cleanup can still start.
- Reservation durably commits before the only backend constructor/fork. Create requestId and accepted
  futures remain pinned through cancellation/ambiguous replies; no retry with a new ID to hide unknown.
- Explicit tab close remains visible/charged until exact proof+prune, then is dismissed from list.
  A bounded hidden completed record preserves idempotent close; natural exits stay visible until
  explicitly dismissed. This is memory-only UI metadata, never a resource-release shortcut.
- Exit/close200/PID absence/helper EOF do not release resources. Release requires original complete
  backend proof: spawn settled, PTY closed, helper actually waited, tracked identities/groups gone,
  then exact durable ledger prune/readback. Reaper retries retain unresolved slots and all deadlines.
- Ledger commit: original exact prior image -> exclusive0600 temp -> file fsync -> final synchronous
  physical guard -> rename -> parent fsync -> final original guard after **all** awaits/fd cleanup.
  Rename entered/unprovable is unknown. No late work may adopt success after cancellation/deadline.

Native bash/zsh login rc, uid/home/shell validation, filtered environment, Python capability checks and
complete physical proof are retained in `hub/terminal/v2/{backend,environment,python-helper,reaper}.ts`.
Optional unsafe labels are omitted, never rewritten/truncated or inferred from OSC/output/termId.
Read-stream metadata is plain text; list/tabs do not expose cwd/user/host/shell. Real PTY fixtures use
an owned private uid/rc environment and `web-hub-terminal-system-rc.ts` test-only pre-exec audit; they do
not modify /etc, suppress production login rc, or touch the user's normal shell/credentials.

## Old-kernel archive / tool reader

Only legal rows from a proven different kernel boot may retire. Under the original singleton/current
and one deadline, exact eligible rows + kernel/proc/namespace + original ledger are first durably saved
as immutable `evidence.json` under `.terminal-allocation-archive-v2/<128bit-hex>/`. Preparation/capacity
failure without prune retains those rows but leaves healthy remaining quota usable. Same-kernel rows
never retire by this mechanism. Capacity <=64 transactions /16MiB counts prepared/completed/partials;
no TTL, GC, reset or manifest replay.

`evidence.json` is **prepared only**, not committed proof. Only the SAME guarded ledger actually
returning committed starts exclusive temporary completion publication. Closed completion fields bind
transactionId/storeId/exact evidence SHA256/beforeRevision/strict before+1 afterRevision/exact removed
allocation IDs. File fsync -> rename -> tx/archive fsync -> final exact evidence/completion bytes,
inode, directories/current/deadline after fd cleanup. Unknown prune writes no completion. A failure
publishing completion does not resurrect rows or claim retired; partials remain and startup refuses.

The tool-only `scripts/web-hub/terminal-v2-maintenance/archive-reader.ts` replaces the former blanket
`v2-archive-review-required`. It validates exact two-file layout, closed fields/hash/store/tx/revisions/
eligible sets and current trusted empty v2 ledger. It pins original files/dirs through every await and,
under a real stopped/drained maintenance lease, re-fsyncs exact evidence/completion/tx/archive/state.
This is **current-window durability normalization**, NOT “a parseable name proves historical fsync”.
Missing completion/partials/unknown members/replaced inode/current-kernel rows deny without repair.
Earlier completed retirement boots remain auditable subject to the current-kernel safety check.
Rollback evidence snapshots include original archive bytes and never mutate v1/v2/archive.

### Fixed executable / controlled deployment adapter

Tools are never imported by production. Run from this source checkout (Node22, existing pinned dev
SDK1.5.0/esbuild/git/tar; no installation):

```sh
node node_modules/tsx/dist/cli.mjs scripts/web-hub/terminal-v2-maintenance.ts fresh --private-parent /absolute/owned0700
node node_modules/tsx/dist/cli.mjs scripts/web-hub/terminal-v2-maintenance.ts cycle --private-parent /absolute/owned0700
```

`terminal-v2-checkpoint.ts fresh|cycle ...` forwards to the same fixed entry;
`terminal-v2-rollback.ts --controlled-cycle ...` runs that same complete private rehearsal.
The pure APIs still require a trusted in-process port; arbitrary JSON/booleans/module paths/default
state/force/reset remain fixed refusals, not an alternate maintenance implementation.

The entry **atomically creates a NEW private scope**, never adopts an existing state directory. Its
original live constructor, held physical directories, immutable construction record and exclusive
filesystem deployment-lock directory establish history. All publishers in this controlled scope go
through the same retained object/generation/floor gate; the lock lasts through the entire operation.
This is explicitly a controlled-scope/same-uid-trusted premise, **not an abstract socket as a global
cross-netns deployment fence**, and does not cover arbitrary external/site publishers. An arbitrary
empty directory is not fresh. No scope/lock adoption, stale repair, evidence GC or site action exists.

Every transaction additionally acquires the real original hub singleton and pins original socket/dir
identity. `current()` remains NO-IO private snapshot identity/generation/lifetime; the P5 tool-only
optional `guardOwnership()` performs separate synchronous read-only physical/source/artifact checks
at every engine publication guard. Async revalidation checks after all awaits; detected loss latches
invalid and stale release cannot unlock a successor. Frozen V2 P0/wire contracts are unchanged.

O is a tool build of exact7239dd115ac66039e2c4f80308ea5d08520aa6af from git archive, with a measured
**observation-only patch**: original owner/futures/physical rows/receipt/ACK success and original hub
commit/prune/service facts. No admission/proof/prune/ACK checks are replaced. Original sources, exact
before/after patch, consumed/control source hashes, actual Node/git/tar/SDK/toolchain measurements and
compiled artifact hash are retained in `build-o/measurement.json`; N clean-HEAD production source and
artifact similarly in `build-n/`. There is no caller-controlled module loader or version string.

Actual pi1.5 SDK hosts use private ResourceLoader/auth/model paths, no discovery/LLM/credentials and one
owned OS child per version to avoid cross-version `Symbol.for` objects in one VM. Retained actual
owner objects remain readable after real dispose; original accepted futures and no-new-start worker
state are checked via a private inherited PID/starttime/namespace/artifact-pinned IPC channel, not
operator JSON. Parent loss withdraws the trusted guard and runs original cleanup with an UNKNOWN hard
bound. Native private UID/rc fixtures use the unchanged real backend/helper/reaper, never fake proof.

O must really open/input/reap, durably resolve/prune and consume exact dedicated ACK before authority
revocation/dispose. Tool correlates actual proof identities/challenge/inventory/revision with original
commit chain and ACK, checks original receipts/resources/futures0 and independent `/proc` gone. Original
O marks availability `lost` on intentional link retirement even with an empty healthy journal: require
actual **live cleared before shutdown**, exact unchanged journal/physical rows/ACK afterward and actual
revoked authority/no futures, not `lost` or empty disk as proof. Original authority/receipt directories
are re-fsynced in the stopped maintenance window, not claimed historically durable from a filename.

N uses the actual service.dispose result and maintenanceSnapshot counters/consistency/physical-prunes,
original backend.done results and independent gone checks. Rollback reads the **same actual ledger**
through the real guarded ledger implementation under the current maintenance singleton, and compares
it to the original stopped service image. Unknown/dirty/partial/error refuses without repair/deletion.
Strict existing archive completion/reader is reused. `cycle` executes real O login/open/reap/ACK →
checkpoint → real N context/input/proof/prune/dispose/readback → rollback eligibility → one explicitly
controlled O login/open/reap. V2 witness/root and old evidence are retained. Tool eligibility never
claims O understands v2 markers, lowers a site floor or deploys anything. Real reboot is separately
reported false; simulated old-kernel archive tests are not actual kernel reboot evidence.

The real mixed/refusal integration now additionally executes N-hub/O-SDK and O-hub/N-SDK with actual
hello/session/status/auth/public SSE/subscribe, both fixed versions' measured **pure UI eligibility**
code false and direct terminal refusal/zero PTY; same-version full cycles are positive controls.
This is not a browser/visual/GPU claim. Actual true-off preserves prepared resource bytes with no
service/positive declaration. An actual checkpoint followed by unreadable v1 still permits real N
context/input/proof/prune, but rollback refuses. A real prior reservation deliberately reintroduced
as an external ledger fault and a partial v2 layout refuse without repair/evidence deletion. Those
corruptions are explicit owned fault fixtures, NOT invented physical drain or real powercut evidence.
Full auth/browser/device gates remain separately tracked in P6/P7 reports. P5's older ControlledAudit
tests are component doubles, not substituted for these real executable integrations.

## Auth: no terminal IO in commit path

Real original Host/client allow/proxy/origin/cookie/2FA/auth deadlines remain authoritative. Terminal
captures fence revision **before** first original authenticate await, checks after awaits, and uses
parent hard-expiry timers. Input/resize/ACK really authenticate each request. View55s revalidation uses
original resolved identity (LAN internal symbol retains original origin/IP, never serialized), original
store and original epoch/expiry/origin rules. DB error/timeout detaches terminal view, unlike public
chat SSE's weaker failure-keeps-stream behavior. It does not poison/clear allocation accounting.

Invalidate is synchronous memory-only: increment revision, block matching admission, seal views/input,
abort creates and initiate matching creator cleanup without waiting. Auth callback faults are isolated
and cannot stop DB/token/rotate intent execution or replace its result. No terminal auth journal,
pendingAuthRevokes persistence, loginComplete proof table or terminal-only repair DB roundtrip.

- Logout/kick/rotate settle only exact original selector/revision with actual original auth facts.
  P0 global revision CAS rejects stale settle/auth continuations; unknown remains denied, no TTL/login
  proof bypass. Selector cap2048 sticky wide denial remains failclosed.
- Root-approved concrete-store password bridge leaves frozen `LanStorePort.setPassword():Promise<void>`
  unchanged. The SAME original SQLite transaction returns a closed local userId/beforeEpoch/afterEpoch
  COMMIT receipt via the SAME IPC. No non-atomic extra getUser/listSessions constructs beforeEpoch.
- Before the original password/delete transaction await, a local opaque per-operation token temporarily
  blocks LAN admission, seals views/aborts creates but does not kill unrelated creators while userId is
  unknown. Actual original committed receipt cleans exact user creators and clears **only that token**;
  concurrent token/sticky denial cannot be cleared. Normal successful passwd allows new login terminal
  admission. Business refusal uses confirmed no-change only for its own token. Unknown remains blocked;
  an arbitrary/custom store lacking the fact bridge cannot fabricate success. Only a current original
  auth fact covering the ENTIRE LAN listener (e.g. completed rotate) can discharge older unknown
  user-operation blocks; a stale rotate or one valid new SID cannot. This is no new wire/disk.
- Original admin exception wire remains E_INTERNAL; no unapproved LanResFrame expansion.
- Declared HTTP failure fix: LAN logout DB deletion failure returns503
  `{error:"E_DB",effect:"unknown",localSignedOut:true}` and clears the local cookie, on/off identically.
  Cookie removal is not server deletion proof. Successful auth bytes remain unchanged.

Bad resource ledger cannot prevent healthy auth success; bad auth cannot be accepted because ledger
is healthy. Both failures stay independent. Restart trusts original auth DB/token/rotate protocol,
not reconstructed terminal denial memory. Rotate recovery still owns its original persistent intent.

### Actual auth fault subgates

`tests/integration/terminal-v2-auth-{matrix,io}.test.ts` shares the real dual-listener/SQLite/token/
original-rotate/native-PTY fixture with the original hub suite; private context response remains
explicitly simulated (not an SDK claim). A1 off/bad ledger/synchronous init throw/held init still run
original logout/kick/passwd/delete/rotate and verify actual DB epochs/absence/token change. A2 holds
real allocation-temp fds before sync or injects ENOSPC for reserve AND prune while each of the five
original auth mutation kinds completes; no auth success is mocked. A3 holds ONLY the original real
backend.done result future (all other methods delegate), proves logout replies while slot stays
charged, then admits original proof and prunes once. A12 holds prune beyond the actual deadline and
proves no late/double release. ENOSPC is a syscall injection, not a real full-device claim; lifting a
known pre-rename failure may permit a fresh, actually committed proof/prune retry, never counted twice.

Real original committed-delete reply loss retains terminal denial; a new valid SID cannot clear it,
only actual full rotate completion can. Throwing terminal subscriber cannot replace passwd/rotate
commit. Saturation2048 affects terminal only, not real auth. Same-SID real double logout/late older
finally cannot clear a newer pending revoke; original DB still rejects old cookie independently of
memory settlement. Fault fixtures retain their private state. The additional timeout/restart suite drives the REAL
resident SQLite child's unchanged8s deadline: either lose one actual successful delete reply (commit
happened) or discard one outbound delete request (no commit). Eight on/off × healthy/bad ledger cases
all return honest503 E_DB/unknown/localSignedOut, then a real hub restart/reopen of unchanged files
rejects the old SID iff original DB committed, otherwise accepts it. No terminal-auth replay or state
healing. The separate A8 suite compiles a measured private current-source hub snapshot with ONLY
an observation pause after the original durable intent, token-written advance or completed LAN revoke.
Six healthy/bad resource-ledger cases SIGKILL ONLY that owned hub child, then UNPATCHED original
startHub/SQLite recovery rejects the old LAN SID, permits a new actual login, removes only the original
rotate intent and preserves resource bytes. Two additional real DB-permission fault cases retain the
original intent and LAN rotate-pending block despite successful loopback auth; lifting that explicit
owned fault permits original recovery. Source/patch/artifact hashes and private state are retained.
No PTY was started and no kernel reboot/resource-drain inference is made.

`terminal-v2-auth-failures` additionally checks real failed kick, before/after-original-commit password
and delete result loss, exact business no-change without clearing an older unknown mutation, and
true post-commit HTTP DELETE/admin password-epoch transport loss followed by real same-state restart.
The defensive bulk partial path uses an explicitly oversized owned SQLite fixture beyond normal32
admission, then the ORIGINAL transaction really deletes64/reports more; no success result is mocked.

`terminal-v2-auth-authority` runs actual55s wallclock expiry checks on both resource healths. Normal
ACK auth remains real/healthy while only original reserved SQLite lookup replies are lost: this makes
55s revalidation causal, rather than a15s missing-ACK or30s metadata-peer silence detach. Actual UDS
protocol pings keep the explicitly simulated metadata responder alive. Private NDJSON detaches,
public LAN SSE keeps its original weaker failure behavior, the other listener authenticates, and
resource bytes/charged live slot remain unchanged. A separate explicit original-DB absolute-expiry
timestamp fixture demonstrates the real local hard-expiry timer, without fake time or a55s wait.
This is controlled lookup-result failure, NOT a claim the entire SQLite process stayed dead55s.

A12 pairs failed original logout on/off while real prune fsync stays held past its own deadline:
response/cookie/DB state match and late IO cannot free/double-free a slot. A regression exposed raw
logout exception text in the diagnostic log; that single declared auth-failure branch now logs ONLY
fixed E_DB, on/off identically. Auth/terminal audit and that failure diagnostic exclude token/cookie/
private-cwd exception payloads; unrelated ordinary registry diagnostics are not rewritten.

## Independent view / flow control

Only POST `/api/terminal/v2/*`; independent fetch NDJSON, never public SSE registry/ring/encoder/clientId.
Public SSE now has only original aggregate FIFO/gzip/backpressure, no private per-source accounting or
terminal admission/idle watcher. Ordinary hello/replay/history/subscribe ordering remains.

One service-lifetime resize gate survives view factory disposal: only original physical Promise
settlement releases it. Logical timeout cannot start an overlapping successor resize. One writer per
term; replay bounded16KiB suffix, raw1MiB ring, live64KiB/128 items, input4KiB/pending32KiB, helper128KiB,
per-view/hub fairness and net ACK stall deadlines remain. ACK only after renderer write callback;
ready and replay ACK may arrive in either order, input/resize only after both. Unknown input queries
original seq/queryOnly, never retries bytes/renews/acquires writer. Slow/failed view detaches, shell
continues. No full VT/history/screen restoration promise, no auto shell on reconnect/reload.

## UI / renderer / provenance

Explicit header/rail click -> lazy named PanelV2 mount, full scope key, normal Vue render-owner ref,
nextTick.open. Hydrate/breakpoint recovery only restore (list/query/attach), never create. Eligibility
recovery does not automatically reopen; repeated already-open header is idempotent. Closing/switching/
withdrawal unmounts private view and clears screen/metadata, not shell. Third FleetDrawer panel retains

> =1280 docked /768–1279 overlay /<=767 fullscreen and original agent/bash preferences; terminal selection
> is ephemeral. TTY Esc goes to shell; chrome Esc restores maximization. Confirm overlays win. Multiline
> paste/drop confirmation,4KiB cap, input focus/IME and once-only recovery remain PanelV2/controller-owned.

Token/password eager facade has only type imports, no schema/feature/fetch at construction. Validated
transport shares the feature root; renderer is a second dynamic import. Old public transport-core/
useHub terminal events/cache/sinks are removed. Matching declaration uses authoritative closed parser
in a separate lazy import, not hand-written duplicate wire validation.

Exact xterm6.0.0/fit0.11.0/webgl0.19.0, WebGL2-only (no DOM fallback), constructed-styles three known
injections and CSP remain. Renderer/fonts/one loss rebuild,3s renderer/write2s, import/CSS5s and
fonts500ms budgets are not authorization. Font fallback chain and feature-local10..24 preference remain.
Renderer geometry was extracted to `renderer.css?url` before deleting v1 CSS. Three lazy CSS assets are
v2 panel + renderer + xterm, total<=16KiB; terminalJS<=256KiB gzip, unlinked probe host<=4KiB. Actual
Rollup E=M\A+SHA256/provenance/licenses gate escaped/mixed/eager xterm; no budget borrowing/name-only
classification. Ordinary first-screen CSS increment remains zero. The panel stylesheet itself now
has an original-link, one-shot load/error/5s gate: renderer/list/create and backend-affecting controls
wait for load; error/deadline is sticky for that mounted lifetime. Unmount aborts/removes the original
link and late callbacks cannot enable this or a replacement panel. Collapse does not auto-open when
CSS later loads. Happy-dom behavior tests explicitly deliver load/error/deadline/old-lifecycle events;
these are not substituted for the separate real browser/CSP/geometry gate.

Unlinked offline probe mounts real PanelV2 with an explicit contract fake (no backend/auth claim).
`probe:terminal-e2e` now uses real SDK context, startHub, actual UI/login, isolated real PTY, independent
view and physical prune; explicit external Playwright/Chromium assets only, never installs. Root has provided Playwright1.65.1/Chromium1255 (Chrome159); default headless WebGL2 is SwiftShader software, not hardware GPU. Actual Chromium full UI/SDK/PTY scenario now passes: explicit dashboard selection/open, real input/PID,
one real WebGL loss/rebuild without new create, collapse/reload/reattach same PID, confirmed close/
original physical proof+durable revision2 prune/PID gone/public SSE intact. The real browser caught
explicitly closed completed tabs reappearing from the bounded metadata cache; the local hidden
completion fix above preserves natural exits/idempotency and never hides unresolved resources.
Seven CSP/WebGL component-browser cases PLUS panel CSS network-abort/deadline cases pass on those
same assets; contract input sink there is explicitly fake, not a second PTY/auth claim. Earlier
missing-assets NOT RUN is historical. Hardware GPU/Firefox/device/OS behavior is not proven.

## Verification and evidence limits

See [acceptance](acceptance.md). All commands use an external<=300s bound, workers2, Vitest `--no-cache`,
private HOME/cache/tmp and read-only node_modules. Golden/tiered/PE relevance/spawn-golden paths that
require `/tmp` run separately with explicit TMPDIR=/tmp. No site ~/.pi/agent/web-hub access, install,
restart, user-shell termination, push or deployment is authorized by this work.

- Real integration: actual pi1.5 ExtensionContext→wireWebHub→UDS→startHub→HTTP/auth→isolated PTY→exact
  durable prune; plus dual listener SQLite/auth/share/PID/output/public-SSE-isolation tests.
- Archive/retirement IO tests are real private fs/guarded CAS but old boot UUIDs and drain adapters
  are simulated, not a real reboot/powercut. The separate fixed controlled executable integrations above supply real O/N adapter and O→N→O evidence (without a kernel reboot).
- Full tier1 was executed as serial manifest shards; P6 report/commands log records initial failures, invocation corrections and reruns; shard
  log files contain the final full run (some initial full logs were overwritten by same-name reruns). Real Chromium scenarios and exact mixed/version matrix are now executed as scoped evidence.
  Firefox, device/OS IME, secure real mounts and real kernel reboot/powercut remain NOT RUN.
- Tests for intentionally removed v1 execution/negotiation/authority/resource/SSE/UI semantics were
  removed with their implementation, not retained as hidden runtime just to compile. Shared off/auth/
  public-SSE/metadata/guards/drawer/provenance tests were migrated/retained. V1 compatibility/rollback
  successes against former O=4e15 are obsolete and cannot stand in for T51 O=7239 maintenance evidence.

## Current integration closure / remaining gates

1. Root-approved shared cleanup removed obsolete v1 resource/offer/grant/receipt/frame/HTTP types,
   ordinary decoders/maps, ports and dead UI projection/generator. Machine policy defaults/schema and
   namespace/reserved command/result **refusal classifiers only** remain. These historical labels are
   necessary to discard old/malformed traffic without command-history/public-SSE leakage, never to
   negotiate or execute. `terminal-session.ts` is an inert, export-free boundary anchor: the frozen
   I8 closure pins that file and its three existing edges, so they are retained without changing the
   whitelist. No production consumer imports it. Generic status stays open to opaque old keys; no v1
   positive type/parser/capability is emitted. V2 P0 files/fields, PROTO, fixtures/trace/I8 unchanged.
2. Fixed controlled-scope executable/adapters and actual measured O7239→N→O are implemented/tested.
   No general existing-site adapter, deployment or floor lowering is authorized/provided; CLI refusals
   of arbitrary facts/paths remain intentional. The actual SDK/wire/pure-UI mixed/refusal subset is now covered; hardware/kernel/browser/fault limitations above still apply.
3. Complete real maintenance/mixed/browser/device/failure-window matrix and independent P7 acceptance
   still pending. Do not deploy this integration checkpoint or label it all-stack PASS.
