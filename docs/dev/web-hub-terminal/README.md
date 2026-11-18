# WebHub terminal · T51 v2 integration

> Read before changing agent context metadata, hub terminal service/resource lifecycle, either HTTP
> listener/auth bridge, UI terminal entry/renderer, maintenance tools or their tests.
>
> **Integration checkpoint, NOT release/deployment approval.** V2 execution is wired. The real trusted
> O/N/fresh maintenance adapter, complete mixed-version/rollback rehearsals and browser/device gates
> remain incomplete. Root approved obsolete v1 shared declaration deletion on 2026-11-18; the shared execution schemas/exports are now removed. Component/test greens do not imply full T51 acceptance.

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

Tools are never imported by production. P5's controlled audit double is not a trusted deployment
adapter. Fresh requires actual never-initialized controlled history, not one ENOENT or CLI boolean.
Checkpoint requires live trusted O owner/future/proof/prune/exact-ACK facts; stopped empty disk cannot
reconstruct them. Rollback additionally requires N stopped, no hot/future/allocations, real clean dispose
and same-ledger readback. A qualifying tool result does not launch O/lower version floor; O does not
understand v2 markers. Real trusted adapters/entries and complete O→N→O remain **NOT IMPLEMENTED/NOT RUN**
at this checkpoint; the existing CLI78 refusal is NOT a completed maintenance feature.

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
classification. Ordinary first-screen CSS increment remains zero.

Unlinked offline probe mounts real PanelV2 with an explicit contract fake (no backend/auth claim).
`probe:terminal-e2e` now uses real SDK context, startHub, actual UI/login, isolated real PTY, independent
view and physical prune; explicit existing Playwright1.63.0/Chromium1243 assets only, never installs.
It has not been run here because those assets are absent. Source is not proof of browser success.

## Verification and evidence limits

See [acceptance](acceptance.md). All commands use an external<=300s bound, workers2, Vitest `--no-cache`,
private HOME/cache/tmp and read-only node_modules. Golden/tiered/PE relevance/spawn-golden paths that
require `/tmp` run separately with explicit TMPDIR=/tmp. No site ~/.pi/agent/web-hub access, install,
restart, user-shell termination, push or deployment is authorized by this work.

- Real integration: actual pi1.5 ExtensionContext→wireWebHub→UDS→startHub→HTTP/auth→isolated PTY→exact
  durable prune; plus dual listener SQLite/auth/share/PID/output/public-SSE-isolation tests.
- Archive/retirement IO tests are real private fs/guarded CAS but old boot UUIDs and drain adapters
  are simulated. Not a real reboot, powercut, trusted maintenance adapter or complete O→N→O.
- Full tier1 was executed as serial manifest shards; P6 report/commands log records initial failures, invocation corrections and reruns; shard
  log files contain the final full run (some initial full logs were overwritten by same-name reruns). Browser, Firefox, device/OS IME, secure real mounts, real kernel
  reboot/powercut and complete mixed/version maintenance matrix remain NOT RUN.
- Tests for intentionally removed v1 execution/negotiation/authority/resource/SSE/UI semantics were
  removed with their implementation, not retained as hidden runtime just to compile. Shared off/auth/
  public-SSE/metadata/guards/drawer/provenance tests were migrated/retained. V1 compatibility/rollback
  successes against former O=4e15 are obsolete and cannot stand in for T51 O=7239 maintenance evidence.

## Remaining integration blockers

1. Root-approved shared cleanup removed obsolete v1 resource/offer/grant/receipt/frame/HTTP types,
   ordinary decoders/maps, ports and dead UI projection/generator. Machine policy defaults/schema and
   namespace/reserved command/result **refusal classifiers only** remain. These historical labels are
   necessary to discard old/malformed traffic without command-history/public-SSE leakage, never to
   negotiate or execute. `terminal-session.ts` is an inert, export-free boundary anchor: the frozen
   I8 closure pins that file and its three existing edges, so they are retained without changing the
   whitelist. No production consumer imports it. Generic status stays open to opaque old keys; no v1
   positive type/parser/capability is emitted. V2 P0 files/fields, PROTO, fixtures/trace/I8 unchanged.
2. Actual executable trusted in-process O/N/fresh maintenance adapter/deployment publisher fence and
   fixed-version live O causal audit bridge remain incomplete. CLI78 is deliberately NOT a final
   delivery claim. No arbitrary module/JSON/boolean drain loader may be added to fake this gate.
3. Complete real maintenance/mixed/browser/device/failure-window matrix and independent P7 acceptance
   still pending. Do not deploy this integration checkpoint or label it all-stack PASS.
