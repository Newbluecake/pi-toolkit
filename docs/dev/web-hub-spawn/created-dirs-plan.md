# Plan: hub-created folders become "known" spawn dirs (+ mkdir ack, E_DIR cause copy)

Status: plan **r2** (2026-10-19), closes review r1 (`created-dirs-review-r1.md`, Blocker 0 / Major 5 / Minor 5 —
disposition table §9). NOT implemented. Diagnosis: `docs/dev/web-hub-spawn/mkdir-diagnosis.md`. Lane L2, 3
packages.

## 0. Fixed decisions (user, not re-litigated)

- Plaintext-LAN cap stays: `supervisor.policy()` answers `scope:"known"` for LAN `http` && !trusted proxy
  (`hub/spawn/supervisor.ts:2671-2676`; arch `docs/dev/web-hub-spawn/arch.md:285,302`).
- A folder created via `POST /api/headless/mkdir` **inside `webHub.spawn.roots`** becomes known (source ④ beside
  ① registry cwds, ② session headers, ③ spawn history — `hub/spawn/dirs.ts:6-9`).
- **User ruling 2026-10-19: created dirs count FULLY as known** (`known:true`): under `confirm:"unknown-dir"`
  (loopback; LAN with `lanConfirm:false`, `entry.ts:228`) they skip the unknown-dir confirm like any dir pi ran in;
  `lan:"known"` hubs and the Feishu bot (`feishu/router.ts:139` `scope: deps.spawnScope`) widen the same way. LAN
  default (`lanConfirm` on ⇒ `confirm:"always"`, `supervisor.ts:2667-2670`) unchanged.
- **Accepted residual (2026-10-19)**: a sniffed plaintext cookie can mkdir under a root then spawn there ⇒
  effectively `roots` for that attacker (confirm can be replayed too). Recorded in arch §6.1, not mitigated.

## 1. Persistence — `<stateDir>/spawn/created-dirs.json` (new `hub/spawn/created-dirs.ts`)

- Path: `createdDirsJson` = `${stateDir}/spawn/created-dirs.json` in `webHubSpawnFiles`
  (`protocol/paths.ts:216-232`); the dir already holds non-log files (`restore.veto`, `paths.ts:228`); stderr
  eviction touches only `*.stderr.log` (`stderr-sink.ts:77`). Created `0700` on first write if absent.
- Module is zero-`as` (auto-scanned, `tests/web-hub/hub/spawn/source-scan.test.ts:20,251`). Sync API, one load
  at hub boot, single writer (singleton hub; every mutation sync in one turn ⇒ no interleaving). `prefs.ts` is
  NOT refactored in this feature (its gaps noted in r1 #4/#7 stay a separate follow-up).
- Record (envelope `{"v":1,"entries":[…]}`):
  `{ path: string /* realpath(parent)/name, ≤SPAWN_CWD_MAX_BYTES, no NUL */; dev: number; ino: number;
 createdAt: number; by: { listener: "loopback"|"lan"; user?: string } /* provenance only */ }`.
- Bounds: `CREATED_DIRS_MAX = 50`, `CREATED_DIRS_TTL_MS = 30 d` (= `dirs.ts:51,53`),
  `CREATED_DIRS_FILE_MAX_BYTES = 256 KiB` measured on the **UTF-8 JSON bytes** (r1 #6).
- **Load (hang-proof, r1 #4)** — precedent `hub/spawn/history/fs.ts:8-22` (PD20): sweep `<file>.tmp-*` residue
  (regular files only); `fd = openSync(file, O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY)` (no lstat-then-open TOCTOU:
  a FIFO/device swapped in opens without blocking); `fstatSync(fd)` must be regular, own uid, `size ≤ cap` —
  else empty set + one warn, file untouched; read with a bounded loop (≤ cap+1 bytes; EOF early ok; more than
  cap ⇒ reject); mode ≠ 0600 ⇒ `fchmodSync(fd, 0o600)` best-effort + warn. Parse: bad JSON / `v≠1` ⇒ empty + warn.
  Per-entry validation (absolute, no NUL, ≤ cwd cap, dev/ino non-negative safe ints, finite createdAt ≤ now+5
  min) drops bad entries singly; then **load-time trim in memory only**: dedupe by path (newest createdAt wins),
  drop expired, keep newest 50. Load never writes; never throws (ENOENT silent).
- **Write (r1 #6/#7)**: next state = dedupe(path) → drop expired → newest-first → ≤50 →
  `buf = Buffer.from(JSON.stringify(env))`; while `buf.length > cap` drop the oldest entry and re-serialize (the
  just-added entry is newest so it survives; one entry ≤ ~25 KiB even fully `\u00XX`-escaped). Then random tmp
  `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 0600; **write-all loop** (`n = writeSync(fd, buf, off)`; `n ≤ 0` ⇒ throw
  `E_SHORT_WRITE`; loop to `buf.length`); close; rename only after full write + close; post-rename lstat
  regular+0600 re-check. Any failure ⇒ unlink tmp, **memory and file unchanged**, `{ok:false, code}`. Invariant:
  every file we write passes our own load (tested at the exact cap boundary).
- Surface: `list(): readonly CreatedDirRecord[]` (sync, TTL-filtered on read, no timers);
  `add(rec: {path,dev,ino}, by): {ok:true}|{ok:false;code:string}` (createdAt = now()).

## 2. Admission — `hub/spawn/dirs.ts`

Deps: `createdDirs?: () => readonly CreatedDirRecord[]` on `DirServiceDeps` (`dirs.ts:144-153`); absent ⇒
byte-identical behavior and fs call sequence.

**Two sets (r1 #2)**: the legacy scan (①②③, `dirs.ts:274-371`) is untouched — its capped-50 `knownSet` keeps
its exact meaning (pinned by `dirs.test.ts:469-486`, the 51st legacy dir stays rejected). Source ④ is a
**separate** `CreatedState { map: Map<path,{dev,ino,createdAt,expiresAt}>; partial; at; gen }`, bounded by the
store's own 50. Authorization = `legacy.knownSet ∪ created.map` — created dirs can never evict a legacy dir.
`known()` (`GET /api/headless/dirs` recent) = merge both by recency, dedupe by path, `.slice(0, 50)` — **display
cap only**; invariant becomes "every displayed entry is admissible" (header comment `dirs.ts:10-12` updated).

**Separate failure domain (r1 #3)**: the created scan runs concurrently with (never inside) the legacy scan, on
its own budget `CREATED_SCAN_BUDGET_MS = min(1_000, deadline.remaining())`, its own single-flight and its own
cache; legacy `KNOWN_SCAN_BUDGET_MS`/`KNOWN_CACHE_MS` semantics unchanged. All ④ fs work goes through one
**roots/created resolver** with **≤1 fs op in flight per DirService**: roots are realpath'd **once per created
scan** (sequential); if a previous op is still unsettled (zombie: hung NFS etc.), the created scan is skipped
(`partial:true`, empty map ⇒ fail closed) — at most one libuv thread can ever be wedged by ④, so legacy ①②③ ops
are never starved. Per record (after TTL): `realpath(path) === path`, `stat` is a dir with record dev/ino,
`withinRoot(rootRp, path)` (`dirs.ts:233`) for some root resolved this scan. Cache life: 60 s when complete,
**5 s (`CREATED_PARTIAL_CACHE_MS`) when partial/skipped**, so a timeout never pins an empty created set for long.
`invalidate()` clears only the created cache and bumps `gen` (mkdir only affects ④); `currentCreated` joins an
inflight scan only if started at the current `gen` and caches a result only if `gen` is unchanged.

**Admit step 3** (`dirs.ts:422-424`): legacy hit ⇒ unchanged. Else a created hit must pass, at admission time:
(a) `now() < expiresAt` (r1 #8 — TTL closed on the cached path); (b) step-2's `st.dev/ino` = record identity;
(c) `insideRoots(rp, deadline)` with **freshly** resolved roots through the same ≤1-in-flight resolver (busy ⇒
false). Pass ⇒ `{ok:true, realpath, dev, ino, known:true, viaCreated:true}`; fail ⇒ fall through to step 4 /
`not-allowed`. Step 4 code is left as is (not refactored).

**Canonical pin (r1 #1)**: `pinSync(admitted, opts?: { canonical?: true })` (`dirs.ts:455-470`): after
`open(O_RDONLY|O_DIRECTORY)` + dev/ino match, with `canonical` it also requires
`readlinkSync("/proc/self/fd/<fd>") === admitted.realpath` (kernel path of the _opened object_ — catches the
dir moved out of a root with a symlink planted at its old path or at any parent, same inode; a deleted dir's`" (deleted)"`suffix also mismatches) ⇒ else`changed`. `DirFs`gains`readlinkSync`. Threading:
`AdmittedRequest.admitted.viaCreated?` (`supervisor.ts:218`) ← `entry.ts`copies it from`admit`; `start()`stores an in-memory, never-persisted`rec.pinCanonical`(record built at`supervisor.ts:1731`) and the fresh-
start pin (`supervisor.ts:1795`) passes `{canonical:true}`. Restore/relaunch pins (`supervisor.ts:2496`) are
unchanged (a restore re-forks an existing session; it never re-proves created-dir standing — same class as the
documented restore exception). Spawn is Linux-only (platform probe), so `/proc/self/fd` is always available.
**Honest guarantee**: at the pin instant the opened inode lives exactly at the admitted canonical path, which
admission proved inside a root; renames of that same directory _after_ the pin (the child then runs in it) or
between readlink and fork are not tracked — consistent with arch's "same uid is fully trusted" row
(`arch.md:286`). Extending `canonical` to every fresh start would also close the pre-existing identical race for
roots-scope admits; deliberately out of scope (keeps existing paths byte-identical) — follow-up.

## 3. Recording on mkdir

- `mkdir.ts`: opt-in dep `identify?: true`; after create + chmod (`mkdir.ts:184-199`) one bounded step opens the
  child `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and fstat's it (`MkdirFs.identify`); `MkdirResult` ok gains
  `identity?: {dev, ino}` (`mkdir.ts:75-77`). Identify failure ⇒ no identity, still `ok`. Absent ⇒ unchanged calls.
- `routes.ts handleMkdir` (`routes.ts:1216-1310`), after `r.ok`: if `deps.createdDirs` && `r.identity` &&
  `await dirs.insideRoots(r.path, remaining)` ⇒ `createdDirs.add(...)`; ok ⇒ `dirs.invalidate()`, reply
  `{ok:true, path, known:true}` and audit `known:true` (`SpawnAuditRecord.known`, `supervisor.ts:139`); otherwise
  today's `{ok:true,path}` byte-for-byte (`routes.ts:1309`). `add` failure ⇒ warn only.
- mkdir **outside roots / empty roots ⇒ not recorded**; mkdir itself stays allowed as today (`mkdir.ts:151-208`).
  Loopback mkdir inside roots records too (then known for LAN — intended). Loopback spawn scope is `roots`
  already (`supervisor.ts:2671-2672`). Spawn disabled ⇒ no store/file/route (`hub.ts:930`); `spawn.lan:"off"` ⇒
  LAN mkdir 404 pre-auth. No new setting, no cap.

## 4. Wire / UI contract

Protocol (`protocol/spawn.ts`, near `MkdirRequestBody` `:550`): `type SpawnDirRejectDetail = "plaintext-lan" |
"lan-known" | "outside-roots"`; `interface MkdirResponseBody { ok: true; path: string; known?: true }`.

- `400 E_DIR{reason:"not-allowed"}` gains optional `detail` **on the LAN listener only** (fresh-spawn path:
  `handleSpawn` `routes.ts:541`, policy var `routes.ts:561`, `startFresh` call `routes.ts:646-689` →
  `sendFreshOutcome` `:793-822` → `sendStartResult` `:343-345`). **Loopback E_DIR stays byte-identical** — pinned
  by keeping `tests/web-hub/http/api-headless.test.ts:311-320` unchanged. Pure helper exported from
  `supervisor.ts` and used by `policy()` itself (no drift): `lanScopeCap(cfgLan, scheme, viaTrustedProxy):
"plaintext-lan" | "lan-known" | undefined`; route `detail = policy.scope === "roots" ? "outside-roots" :
lanScopeCap(...)`, threaded from the `handleSpawn` closure into `sendFreshOutcome`. Session branch
  (`routes.ts:898`) never yields `not-allowed` (`dirs.ts:414-419`); Feishu renders its own text (no detail).
- Compat: old UIs whitelist fields (`token-client.js:609-610,780`; `password-client.js:704,~860`) ⇒ ignore
  `detail`/`known`. New UI + old hub ⇒ `spawn.errDir` and the "unregistered" ack (truthful: old hubs never record).

UI (P3):

- Clients `logic/{token,password}-client.js` (`spawnFromResponse` `:582-612` / `:676-705`) copy string
  `detail`; `spawn.mkdir` copies `known === true`. Types: `SpawnOutcome.detail?`, `SpawnMkdirOutcome` ok
  `known?: true` (`transport/types.ts:226-240,329-340`); failed flow `detail?` (`ui/src/types.ts:680-692`);
  `useNewSession.settleStartOutcome` passes `detail` for `kind==="dir"` (`composables/useNewSession.ts:161-172`).
- **mkdir success = fill the cwd input + close the panel** (the 「选择此目录」 path, `DirPicker.vue:360-364`) +
  persistent `role="status"` ack under the cwd input. Why not drill in: intent in a _spawn_ picker is "start
  there" ⇒ one click from 启动; immune to the off-screen row (diagnosis §1); no empty listing; closing first
  means the follow watcher (`DirPicker.vue:304-317`) never fires.
- **Operation generation (r1 #9)**: `mkdirSeq` bumps on every `mkdirConfirm` start, `mkdirCancel`, `browseClose`,
  `browseInto/Up/Toggle` (`DirPicker.vue:320-357`); the request captures `{seq, cwdAtStart: cwd.value,
pathAtStart: browsePath.value}`. On success: select (fill + close) **only if** seq current && panel open &&
  `cwd.value === cwdAtStart` && `browsePath.value === pathAtStart`; otherwise show the non-selecting
  `spawn.mkdirAckCreated` ({path}) and touch nothing else (never overwrites a newer cwd, never re-opens a closed
  panel). Errors of a stale seq are dropped. Ack clears when cwd diverges from the created path, on submit/close.
- Ack variants: selected && (`known` || `plaintext !== true`) ⇒ `spawn.mkdirAckSelected`; selected && !known &&
  `plaintext` (`App.vue:180`) ⇒ `spawn.mkdirAckUnregistered`.
- E_DIR copy: `failureText` (`DirPicker.vue:524-529`) maps `kind==="dir"` + `detail` ⇒ `spawn.errDirPlaintextLan`
  / `errDirLanKnown` / `errDirOutsideRoots`; else `spawn.errDir` (unchanged).
- i18n zh+en (`i18n/zh/spawn.ts:74`, `i18n/en/spawn.ts:83`; parity `tests/web-hub/ui/i18n-parity.test.ts`):
  `mkdirAckSelected` 「已新建并选为启动目录：{path}」; `mkdirAckCreated` 「已新建文件夹：{path}」;
  `mkdirAckUnregistered` 「已新建并填入 {path}；但 hub 未把它登记为可启动目录（可能不在 spawn 根目录内），此明文
  LAN 连接下启动可能被拒绝。」; `errDirPlaintextLan` 「目录被拒绝 — 明文 HTTP 的 LAN 连接只能在已知目录启动：pi
  运行过的目录，或在允许的根目录内用「新建文件夹」创建的文件夹。要使用任意根目录：改用本机（loopback）访问，或经
  受信任的 HTTPS 反向代理访问。」; `errDirLanKnown` 「目录被拒绝 — 此 hub 的 LAN 访问只允许已知目录（pi 运行过的
  目录，或在允许的根目录内新建的文件夹）。」; `errDirOutsideRoots` 「目录被拒绝 — 它既不在允许的根目录内，也不是
  已知目录。」 (+ en equivalents).

## 5. Assembly — `hub/hub.ts`

In the spawn block (`hub.ts:930-`): `createCreatedDirsStore({ file: spawnFiles.createdDirsJson, log, now })`
beside `createSpawnPrefs` (`:938`); `createdDirs: () => store.list()` into `createDirService` (`:968-975`);
`identify: true` into `createMkdirService` (`:1137-1145`); `createdDirs: store` into `createSpawnRoutes`
(new optional `SpawnRoutesDeps.createdDirs`, `routes.ts:157-190`; absent ⇒ no recording). The Feishu bot reuses
the same `spawnDirs` instance through `deps.spawn` (`hub.ts:1166-1174`) — no extra wiring. No cleanup entry.

## 6. Tests

Unit (P1)

- NEW `tests/web-hub/hub/spawn/created-dirs.test.ts` (fs seam): round-trip 0600; tmp sweep; **FIFO swapped in
  after a pre-check ⇒ open returns, fstat rejects, no hang**; dir/symlink/foreign uid/oversize/bad JSON/`v:2` ⇒
  empty + one warn + untouched; fd-based chmod fix; per-entry drops; >50 records in file ⇒ newest 50 in memory,
  file unwritten; dedupe newest wins; TTL; **escaped paths** (quote, backslash, `\n`, control chars, non-ASCII)
  round-trip; **byte-cap boundary**: file of exactly cap loads, cap+1 rejected, an add that would exceed cap
  trims oldest and the written file reloads; **short write then continue** ⇒ the loop finishes the write,
  rename commits, memory updated, file reloads; **short write then error / 0-byte write** ⇒ old file + old memory
  kept, tmp removed; restart round-trip.
- `tests/web-hub/hub/spawn/dirs.test.ts`: ④ admitted under `known` inside a root; outside roots / roots changed
  / replaced (new ino) / path→symlink / deleted ⇒ not known (scan AND cached-admit); **50 legacy + 50 created ⇒
  every legacy dir still admitted, recent list = 50** (the `:469-486` pin unchanged); **fake clock: expiry
  after a cached scan ⇒ rejected without rescan**; `invalidate()` incl. inflight-old-gen; **one hung root
  realpath (never-settling promise) ⇒ legacy dirs still admitted, created skipped, next scan after 5 s, never >1
  ④ op in flight**; missing root ⇒ matches nothing; `pinSync({canonical})`: **"inode moved out of root, symlink
  back at original path" and "parent dir swapped for symlink to moved tree" ⇒ `changed`**, plain case ok,
  without `canonical` behavior unchanged; `createdDirs` absent ⇒ identical fs call log.
- `tests/web-hub/hub/spawn/mkdir.test.ts`: `identify` returns dev/ino; failure ⇒ ok without identity; absent ⇒
  unchanged call sequence.
- `tests/web-hub/protocol/paths.test.ts`: `createdDirsJson`.
  Hub / HTTP / integration (P2) — new files avoid the golden include globs (§7)
- `tests/web-hub/hub/spawn/supervisor.test.ts` (near `:1366-1376`): `lanScopeCap` table; `policy()` outputs
  unchanged for every (listener, scheme, proxy, lan); `viaCreated` ⇒ fresh pin called with `{canonical:true}`,
  restore pin without.
- NEW `tests/web-hub/http/lan-spawn-created-dirs.test.ts` (plaintext `startLan` + `loginAs`; `spawnKit`
  `tests/web-hub/http/spawn-kit.ts:617-656` gains an options bag for REAL dirs/mkdir/store, fake supervisor):
  mkdir under root ⇒ `known:true` ⇒ spawn ⇒ 409 `always` ⇒ confirm ⇒ 202 (`startCalls[0].admitted.viaCreated`);
  outside roots ⇒ no `known` ⇒ 400 `{…,"detail":"plaintext-lan"}`; swapped dir ⇒ not-allowed; `lan:"known"` ⇒
  `lan-known`; trusted-proxy roots miss ⇒ `outside-roots`.
- `tests/web-hub/http/api-headless-mkdir.test.ts` (loopback, golden-covered): **existing cases unchanged, no
  cases added** (the golden observer keys on test names — a new case would fail on a missing fixture entry); every
  new mkdir case lives in the new non-golden files above.
- NEW `tests/web-hub/hub/feishu/service-created-dirs.test.ts`: real `createDirService` + real store (fake
  supervisor, `spawnPort()` pattern of `service.test.ts:273-285`), `spawnScope:"known"`: created ⇒ start called,
  no confirm/unknown-dir notice; expired (fake clock +31 d) / replaced / out-of-roots ⇒ `unknown-dir` notice
  (`service.ts:1147-1155`), zero starts.
- NEW `tests/integration/web-hub-created-dirs.test.ts` (Linux-only skip; in-process real `startHub` + real
  `createHttpFrontend` + real fake-pi child, mode B of `tests/integration/web-hub-headless.test.ts:14-20`, LAN via
  `tests/web-hub/http/lan-helpers.ts`): LAN plaintext mkdir → confirm → 202 → child live with cwd = created dir
  (real `pinSync` + canonical) → `close` → second `startHub` on the same stateDir → spawn there again works;
  negative: dir moved out of the root + symlink planted back ⇒ E_DIR or `failed` with `cwd changed`, no live child.
  UI (P3)
- `tests/web-hub/ui/dir-picker.test.ts` (rewrite success cases in `:459-674`): fill + close + `mkdirAckSelected`;
  unregistered variant; **edit cwd while mkdir pending ⇒ no overwrite (`mkdirAckCreated`)**; **pick recent dir B
  while pending**; **close panel while pending ⇒ stays closed**; **older request resolving after a newer one ⇒
  ignored**; E_DIR per `detail`; no detail ⇒ `spawn.errDir`.
- `tests/web-hub/ui/transport-contract.test.ts` (token/password parity for `detail`, `known`);
  `tests/web-hub/ui/use-new-session.test.ts` (`detail` only for `kind:"dir"`); i18n parity automatic.

## 7. Golden gate (r1 #5) — owned by P2

`tests/fixtures/feishu-spawn-http-golden.json` + `tests/web-hub/hub/spawn/golden.setup.ts` + `golden.config.ts`
belong to P2 alone. The observer compares responses incl. body + `content-length` exactly (`golden.setup.ts:
76-102`); capture is SHA-locked to the F5 routes (`:66,93-96`) — current `routes.ts` already differs, so capture
stays unusable by design: **no regeneration, no BASELINE_SHA change, no masking of E_DIR**. Steps: (1) run the
golden command on the untouched tree first (baseline green); (2) the only expected delta is the LAN plaintext
E_DIR key `lan-headless.test.ts :: LAN scope threading … unknown dir rejected` (fixture `:274-276`): body gains
`,"detail":"plaintext-lan"`, `content-length` 40→65 — P2 greps the fixture for every other LAN `not-allowed`
entry and lists them; (3) hand-edit exactly those keys and record before/after per key in
`docs/dev/web-hub-spawn/created-dirs-golden-delta.md` (reviewed with the code); loopback keys and mkdir bodies
(no roots in those tests) must stay byte-identical; (4) new tests go only into files outside the include globs
(`tests/web-hub/http/*headless*.test.ts`, `hub-spawn.test.ts`, `integration/web-hub-headless.test.ts`,
`golden.config.ts:9-14`) — hence the names above. Gate: `timeout 900 npx vitest run --config
tests/web-hub/hub/spawn/golden.config.ts`.

## 8. Packages, frozen surfaces, acceptance, risks

Frozen up front (verbatim in dispatch prompts): `CreatedDirRecord` + store `list/add`; `DirServiceDeps.createdDirs`,
`DirService.insideRoots/invalidate`, `pinSync(…, {canonical})`, `AdmitResult.viaCreated?`; `MkdirResult.identity?`;
wire `detail` values (LAN only) + `known?: true`.

- **P1 hub-core**: `hub/spawn/created-dirs.ts` (new), `hub/spawn/dirs.ts`, `hub/spawn/mkdir.ts`,
  `protocol/paths.ts` + their unit tests.
- **P2 hub-wire**: `protocol/spawn.ts`, `hub/spawn/routes.ts`, `hub/spawn/entry.ts`, `hub/spawn/supervisor.ts`,
  `hub/hub.ts`, `tests/web-hub/http/spawn-kit.ts`, golden fixture/setup/config + delta doc, supervisor/HTTP/
  Feishu/integration tests; docs: arch.md §6.1 (`:285` + residual) and §6.2 `lan` (`:302`), AGENTS.md "Managed
  spawn" one-liner. Depends on P1's frozen interfaces; merges after P1.
- **P3 UI**: clients, `transport/types.ts`, `ui/src/types.ts`, `useNewSession.ts`, `DirPicker.vue`, i18n zh/en,
  UI tests. Independent (additive wire).
  Acceptance (all packages merged): `npm run format:check`, `npm run typecheck`, `npm test`, **`npm run build`**,
  `npm run build:web && npm run check:web`, the golden command (§7), and the new integration file.

Risks: R1 accepted residual (§0). R2 post-pin rename / readlink→fork window (§2 honest guarantee; same-uid trust).
R3 test churn limited to the listed golden key + rewritten DirPicker cases. R4 dev/ino as JS numbers (same
non-bigint stat as the pin path, `dirs.ts:61-66`). R5 store flushing by a cookie holder only drops created-dir
convenience — the legacy set is untouched (§2), mkdir rate 10/min/principal (`routes.ts:144-147`). R6 a wedged
root disables ④ (fail closed) until its op settles — visible as the "unregistered"/E_DIR copy, never a hang.

## 9. r1 review disposition

| #   | Finding (sev.)                             | How closed                                                                                                                                                      | §          |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | identity ≠ canonical path in roots (Major) | created hits re-check TTL+identity+fresh roots at admit; `pinSync({canonical})` readlink of the fd path; symlink-at-path + parent-swap tests; residual stated   | §2, §6     |
| 2   | eviction = authz regression (Major)        | legacy capped set untouched; created set unioned for authz; display cap separate; 50+50 test                                                                    | §2, §6     |
| 3   | new source starves old (Major)             | ④ concurrent, own budget/cache/single-flight, roots once per scan, ≤1 op in flight + zombie skip, 5 s partial cache                                             | §2, §6     |
| 4   | store load not hang-proof (Major)          | `O_NONBLOCK                                                                                                                                                     | O_NOFOLLOW | O_NOCTTY` open, fstat on fd, fchmod; FIFO-swap seam test; prefs untouched | §1, §6 |
| 5   | golden gate + ownership (Major)            | P2 owns fixture/observer/config; reviewed per-key delta doc, no regen; new tests outside globs; loopback E_DIR unchanged (LAN-only detail); golden command gate | §4, §7     |
| 6   | 256 KiB ignores escaping (Minor)           | cap on UTF-8 JSON bytes, trim-to-fit on write, load-time trim; escaped/boundary/>50 tests                                                                       | §1, §6     |
| 7   | short write (Minor)                        | write-all loop, 0-byte = failure, rename after full write+close; three seam tests                                                                               | §1, §6     |
| 8   | TTL on cached path (Minor)                 | `expiresAt` cached, checked at admit; fake-clock test                                                                                                           | §2, §6     |
| 9   | late mkdir overwrites newer choice (Minor) | `mkdirSeq` + intent snapshot; non-selecting ack when stale; four race tests                                                                                     | §4, §6     |
| 10  | cross-consumer / real assembly (Minor)     | real-DirService Feishu test; real `startHub` mkdir→spawn→restart via real pinSync; `npm run build` gate                                                         | §6, §8     |
| loc | routes.ts:531 citation                     | fresh-spawn policy is `routes.ts:561` (531 = history handler)                                                                                                   | §4         |

## r2 review disposition (main-session adjudication, 2026-10-19)

r2 re-review (r_CBSRMV68): 8 closed, 2 partially, no new Blocker. Per the convergence rule the main session closed
both partials directly (no third review round): r1 #5 — `api-headless-mkdir.test.ts` gets no new cases (§6);
r1 #7 — "short write then continue" now expects a successful commit, only error/0-byte keep the old state (§6).
