# web-resume — `resume` in the web UI + hiding subagent sessions (TUI & web) — plan v2

Status: v2 after review r1 (gpt-6.1-sol, 3 Blocker/Major classes; disposition in §10). User rulings in §9 are
binding. D5 decided (D5-a, §9); no open user decisions. Lane **L2**. No hub change, no new cmd op. Anchors are against
master at d1b4b37. Explore report: `docs/dev/web-resume/explore.md`.

## 0. Goals / non-goals

- G1: in the web detail view, typing `resume` / `/resume` / `resume --all` / `/resume-recent [--all]`, or clicking a new
  header 「恢复」 button next to 「清空」 (D7), opens a session list; choosing a row switches **the same pi process**
  (agentKey unchanged) to that session — TUI `/resume-recent` semantics (`src/session-nav/index.ts:85-144`).
- G2 (D1 彻底隐藏): subagent sessions never appear in the TUI or web list; no flag, no toggle, no hidden-count line.
- G3: every old/new hub × agent × UI combination degrades cleanly (§2.8).
- Non-goals: other cwds (D3), rename/delete from web, the hub `spawn.history` dialog (new process, different rules).

## 1. Facts (verified; r1 corrections marked ✱)

| #   | fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | TUI: editor rewrite `index.ts:56-80`; handler refuses non-TUI/busy `:89-97`; recent loader symlinks in-window files into a temp dir and calls `SessionManager.list(cwd, tempDir)` (`recent-sessions.ts:20-79`), all loader `SessionManager.list(cwd, sessionDir)` (`index.ts:102-107`); switch `ctx.switchSession` `:139`.                                                                                                                                                                   |
| F2  | Reverse-scan marks: `subagent:run.diag.sessionFile` in MAIN files, cached by mtime+size at `<agent>/cache/session-nav/subagent-marks.json` (`subagent-sessions.ts:44-153`); only the files passed in are summarised (`:103-148`). Marks are append-only facts (pi jsonl is append-only) ⇒ a stale cache entry is a valid lower bound.                                                                                                                                                        |
| F3✱ | Self-marker `subagent:child` (line 2 of a persisted, non-consult child) exists only since bc23467 (**v0.4.0**), is written **at create only** (never on Agent resume) and **best-effort** (`session-driver.ts:53-71,822`). Consult forks live in `<agent>/cache/consult-sessions` (`fork-store.ts:78`).                                                                                                                                                                                      |
| F4✱ | pi 1.2 `SessionListProgress` has a 3rd `partialSessions` arg (`session-manager.d.ts:208-210`); the local alias in `recent-sessions.ts:14` has 2. Partial rows of the recent loader carry **temp-dir paths** (real paths are restored only on the final result, `recent-sessions.ts:66-71`). `SessionManager.list` reads whole files and concatenates every message's text (`session-manager.js:495-559`); with a non-default `sessionDir` it filters by header cwd (`:1449-1457`).           |
| F5✱ | Extension commands run **immediately, even while streaming** (`agent-session.js:1593-1616`); only during `agent_settled` emission are they deferred (`:1602-1605`). `_tryExecuteExtensionCommand` calls the handler synchronously (`:1668-1681`) ⇒ the synchronous prefix of a `/webhub __exec …` handler runs inside the bridge's own `pi.sendUserMessage` call (the K20 premise already relied on by `builtin-bridge.ts:166-172`).                                                         |
| F6✱ | `runtime.switchSession(path)`: async `session_before_switch` emit → `SessionManager.open(path)` (header cwd becomes the new runtime cwd unless overridden) → `teardownCurrent` **aborts any active response** → new runtime (`agent-session-runtime.js:102-146`). `SessionManager.open` of a **missing** path initialises a new empty session at that path (`session-manager.js:665-687,1326-1347`). Path-only API: no fd/identity can be handed to pi.                                      |
| F7  | `ctx.switchSession` is on `ExtensionCommandContext` only (`types.d.ts:316-321`), returns `{cancelled}`; rpc mode wires it (`rpc-mode.js:249-251`). `ExtensionContext` has `isIdle()` and `hasPendingMessages()` (`types.d.ts:236,244`).                                                                                                                                                                                                                                                      |
| F8  | `/new` precedent: single overwritable nonce slot, 5 s TTL (`agent/index.ts:389-404`), `/webhub __exec new` (`builtin-bridge.ts:302-313`, `commands/webhub.ts:363-371`, `agent/index.ts:1548-1563`). Web cannot reach `__exec` (`command-policy.ts:178-185`).                                                                                                                                                                                                                                 |
| F9  | Ledger deletes `retryable && effect:"none"` failures (`ledger.ts:105-108`) ⇒ a same-id retry re-executes. Hub: `cmd_result.data` opaque (`messages.ts:1677`), only `data.output` is trimmed (`hub/commands.ts:152-188`); unknown error codes → HTTP 500 (`hub/http.ts:2072-2101`); agent deadline ≤ 8 s (`hub/req-deadline.ts:22-23`); hub stores `status` frames verbatim (`hub/registry.ts:459-462`) and `StatusInfoSchema` has no `additionalProperties:false` (`messages.ts:1344-1365`). |
| F10 | UI: `DetailDock.onSend` (`DetailDock.vue:214-226`), `Composer.sendGate` (`Composer.vue:576-591`), `runCommand` (`useControl.ts:231-250`), clear button (`DetailHeader.vue:213-254,339-352`); in-detail dialogs die on privacy relock (`usePrivacyLock.ts:357-358`); `.picker-scrim` is in every `OVERLAY_ROOTS`; budgets first-screen 255 KiB / lazy 42 KiB gz (`check-ui-dist.ts:108-109`).                                                                                                 |
| F11 | Managed rpc sessions: supervisor adopts the reported session coords (`hub/spawn/supervisor.ts:1395-1420,1571-1582`).                                                                                                                                                                                                                                                                                                                                                                         |

## 2. Design

### 2.1 Subagent rule (shared by TUI and web)

A session file is **sub** ⇔ (a) its head contains a `subagent:child` custom line (self-marker, F3), **or** (b) its
resolved path is in the **provenance index** (union of all `subagent:run` marks ever scanned in this session dir, F2).
No heuristic (D2). Current session never hidden. Sub rows are dropped entirely (D1); `markSubagentSessions` and the
`[sub:type]` retitle are deleted.

**Provenance index ≠ display candidates** (r1 #4). The index covers the **whole session dir**, not the 48 h window:

- Source = marks cache **v2** (all entries, any age — append-only ⇒ valid lower bound without re-stat) ∪ fresh scans.
- Each list call (TUI or web) advances an **incremental backfill** under a budget (≤2 s, ≤64 MiB read, ≤4 fds) — see
  "Backfill state and fairness" below. `complete` ⇔ every tracked file's entry has the file's current identity and
  `scannedTo === size`, and no capacity limit was hit.
- Cache v2 is **one file per session dir**: `<agent>/cache/session-nav/provenance-v2/<sha256(sessionDir)[0:16]>.json`
  (the v1 file `subagent-marks.json` is shared by all cwds and simply ignored). Atomic tmp+rename, mode 0600, last
  writer wins between processes (the cache is an optimisation and a lower bound — a lost write only costs a rescan).

**Backfill state and fairness** (r2 #4):

- Entry: `{dev, ino, size, mtimeMs, scannedTo, marks: string[], over?: true}`. `scannedTo` = byte offset just after the
  last complete `\n` already scanned. Resume rule: same `dev/ino` and `size ≥ scannedTo` ⇒ continue reading at
  `scannedTo` (pi only appends); otherwise (identity changed or file shrank) ⇒ the entry's marks are dropped and the
  file restarts at 0. A pending file = no entry, identity changed, or `scannedTo < size`.
- Per call: ① files whose mtime is inside the 48 h window first, capped at half the byte budget; ② then a
  **round-robin cursor** (`cursor` = last processed path, persisted in the cache, files ordered by path): start after
  it, wrap once. Each file gets at most an **8 MiB chunk per call**; the cursor moves past the file even if unfinished,
  so a huge file can never starve the others and is resumed from `scannedTo` on its next turn.
- Convergence: with no new writes, every pending byte is read once, so the backfill completes after about
  ⌈pending bytes / 32 MiB⌉ calls (half the budget always goes to the round-robin), independent of file order.

**Capacity limits** (r2 #4/#7) — one rule set for the scan and the cache:

| limit                 | value                                                                                 | over the limit                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| tracked files per dir | 20 000 newest by mtime                                                                | older files are never scanned; index `capacity:"files"`                                                                 |
| marks per entry       | 2 048, each stored as a basename when the child is in the same dir (else ≤4 KiB path) | extra marks dropped, entry `over:true`; index `capacity:"marks"`                                                        |
| bytes per entry       | 512 KiB serialized                                                                    | same as marks                                                                                                           |
| cache file            | 16 MiB, checked **before** reading (`fstat` on a `O_NONBLOCK` open) and when writing  | read: larger ⇒ treated as absent and rebuilt; write: evict oldest-mtime entries until it fits, index `capacity:"bytes"` |

Guarantee when a limit is hit: children with a self-marker (v0.4.0+) are always hidden, because the marker is checked
on every displayed row independently of the index; a pre-v0.4.0 child is hidden iff its parent is tracked and not
truncated. Anything else may show, and `complete` stays false. Disclosure: AGENTS.md + acceptance; the web wire reports
`provenance: "complete" | "partial" | "capacity"` (diagnostics only — D1 keeps the UI free of counts).

- Residuals (disclosed in AGENTS.md + acceptance): a pre-v0.4.0 child whose parent file is **deleted** is undetectable;
  until the backfill completes once (first few opens on a large dir), a pre-v0.4.0 child whose parent is older than the
  scanned part may still show. Children dispatched by Agent-resume add a fresh `subagent:run` to the (recent) caller,
  so they are covered by recent files.

### 2.2 P1 pi-free modules in `src/session-nav/` (frozen API)

```ts
// session-head.ts — bounded head/tail reader (also used by the exec re-validation, §2.5)
export interface HeadLimits {
  headBytes: number /*64 KiB*/;
  tailBytes: number /*16 KiB*/;
  headerLineBytes: number; /*4 KiB*/
}
export interface SessionHead {
  id: string;
  cwd: string;
  forked: boolean;
  child: boolean;
  name?: string;
  firstMessage?: string;
}
export type HeadResult =
  { ok: true; head: SessionHead } | { ok: false; invalid: "no-header" | "bad-header" | "too-long-header" };
export function readSessionHeadFd(fd: number, size: number, limits?: HeadLimits): HeadResult; // sync, bounded
export interface FileFact {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
export const SESSION_READ_FLAGS: number; // O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY (each `?? 0`), = hub/preview/fs.ts:64-70
export function openSessionNoFollow(path: string): { fd: number; fact: FileFact } | undefined; // sync open(SESSION_READ_FLAGS) → fstat → regular only; fd closed on every failure
export function openSessionNoFollowAsync(path: string): Promise<{ handle: FileHandle; fact: FileFact } | undefined>; // same contract, fs/promises
// provenance.ts
export interface ProvenanceIndex {
  has(absPath: string): boolean;
  readonly complete: boolean;
}
export function advanceProvenance(
  sessionDir: string,
  budget: { ms: number; bytes: number },
  signal?: AbortSignal,
): Promise<ProvenanceIndex>;
// classify.ts
export function isSubagentSession(
  absPath: string,
  head: { child: boolean } | undefined,
  index: ProvenanceIndex,
): boolean;
export function displayTitle(head: SessionHead): { title: string; source: "name" | "first" | "none" }; // skill-envelope strip (reuses skill-titles.ts stripSkillEnvelope), C0→space, ≤120 UTF-16, surrogate-safe
```

`readSessionHeadFd`: line-by-line on the `\n` byte; header must be line 1 (`type:"session"`, string `id` matching
`RESTORE_SESSION_ID_RE`, absolute `cwd`); `parentSession` ⇒ `forked`; `{"type":"custom","customType":"subagent:child"`
prefix ⇒ `child`; last `session_info.name` seen in head **or tail** window; first `role:"user"` line ⇒ firstMessage
(a line larger than the remaining window ⇒ loose `"text":"…"` extraction, head.ts precedent). Marker literal pinned by a
source-scan test against `SUBAGENT_CHILD_CUSTOM_TYPE` (no runtime import of `session-driver.ts`).

**Open discipline** (r2 B1, precedent `hub/spawn/history/fs.ts:7-9,20-22`, `hub/preview/fs.ts:64-70`): every file
open in P1/P2 — head reader, web generation build, provenance scan (which today streams by path through
`createReadStream`, `subagent-sessions.ts:69` — replaced by reads on the opened fd), cache file read, exec
re-validation — goes through `openSessionNoFollow{,Async}`: `O_NONBLOCK` so a target swapped for a FIFO without a
writer or a device never blocks the open (and never parks a libuv thread), `O_NOCTTY` so a tty is never adopted;
`fstat` immediately; anything but a regular file is rejected; the fd is closed in a `finally` on every path. No
`readFile(path)`/`createReadStream(path)` remains in these modules (source-scan test).

### 2.3 TUI (`src/session-nav/index.ts`, `recent-sessions.ts`)

- Input forms unchanged (`resume`, `/resume`, `… --all`); completions unchanged. No `--sub` (D1).
- Both loaders: ① candidate files (window / all) → ② `advanceProvenance` (budget above) + `readSessionHeadFd` on each
  candidate (≤16 concurrent, bounded per file) → sub set → ③ `SessionManager.list(..., wrappedProgress, signal)` where
  `wrappedProgress(loaded,total,partials)` **first maps temp paths → real paths** (`realPathByName`), then drops sub rows
  and forwards (r1 #5) → ④ `cleanSkillTitles` → ⑤ final filter. Use pi's exported `SessionListProgress` type; thread
  `AbortSignal` through every step (the selector already passes one). TUI keeps pi-native full-text search/tree.
- Busy/non-TUI behaviour unchanged.

### 2.4 Web list path (read-only, `command` op, no hub change)

Request: `{op:"command", name:"resume", args:"__list " + JSON}` with
`{"scope":"recent"|"all", "q"?: string ≤128, "cursor"?: string}`. Sent by a new non-optimistic `queryCommand`
(§2.6) — never in the queue UI.

Agent `src/web-hub/agent/resume-list.ts` builds a **generation** per scope:

| bound       | value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| files       | `.jsonl` lstat'd regular files in `ctx.sessionManager.getSessionDir()`; recent ⇒ mtime ≥ now−48 h; newest first, cap 5 000 (then `truncated`)   |
| per file    | `openSessionNoFollow` + `readSessionHeadFd` (head ≤64 KiB, header line ≤4 KiB, tail ≤16 KiB only if size > 64 KiB); never `SessionManager.list` |
| totals      | ≤64 MiB read + ≤5 s wall per build (rows so far kept, `partial:true`); provenance step inside the same 5 s, its own ≤2 s/≤64 MiB                |
| concurrency | one process-wide fs gate: ≤4 open fds shared by build + provenance; ≤1 build in flight per scope (single-flight), ≤2 total                      |
| retention   | ≤1 gen per scope; rows ≤2 000, title ≤120 UTF-16; no message text retained at all (search is title-only, r1 #7)                                 |
| lifetime    | first-page request reuses a gen ≤10 s old, else rebuilds; a gen idle 120 s is dropped on next access (lazy, no timers)                          |
| fence       | `session_shutdown` aborts in-flight builds (AbortController) and bumps an epoch; a build finishing under an old epoch never writes the cache    |

Row filter: header valid ∧ `resolve(head.cwd) === resolve(ctx.cwd)` (shared custom sessionDir, r1 #3) ∧ not sub ∧
**unique header id within the gen** (duplicate ids ⇒ all copies omitted, counted in `ambiguous`, r1 #10). Sort
`modifiedMs` desc, then `id` asc (stable). Each gen keeps an index `id → FileFact` (dev/ino/size/mtime at read time).
Search: case-insensitive all-tokens match over the row title only (honestly weaker than the TUI's full text).

Paging (r1 #9): page ≤100 rows **and** ≤32 KiB; `cursor = "<genId>.<offset>.<qHash>"`; a cursor whose gen is gone
or whose qHash ≠ hash(q) ⇒ response `reset:true` + a fresh first page (UI clears and replaces).

Wire (`protocol/messages.ts`, types only, append-only, no proto bump; rides `CmdData` command variant as
`sessions?: ResumeSessionsWire` — passes any hub, F9):

```ts
export interface ResumeSessionRowWire {
  id: string;
  title: string;
  titleSource: "name" | "first" | "none";
  modifiedMs: number;
  current?: true;
  forked?: true;
}
export interface ResumeSessionsWire {
  v: 1;
  scope: "recent" | "all";
  windowHours: 48;
  q?: string;
  gen: string;
  total: number;
  rows: ResumeSessionRowWire[];
  next?: string /*cursor*/;
  reset?: true;
  partial?: true;
  truncated?: true;
  ambiguous?: number;
  provenance: "complete" | "partial" | "capacity";
  builtAt: number;
}
```

Never on the wire: paths, cwd, message text. Async in a sync bridge — **reads only**: `BuiltinBridge.execute` may return
a Promise **only for `__list`**; `commands.ts handleCommand` races it with `min(opTotal(frame), 6000)` (unref'd),
settles once; timeout ⇒ `E_DEADLINE` retryable effect none message `resume:scanning` (no side effect exists, so the
F9 same-id re-execution is harmless; UI retries ≤4× with new ids). For `__list` only: ledger stores the result with
`data.sessions` stripped, and no origin notify is written (`bridge.isQuiet(frame)`).

### 2.5 Switch path — synchronous decision, all authoritative checks at the execution point

Request: `runCommand(agentKey, "resume", "__pick " + JSON({id, gen}), confirm?)` (optimistic ctl item like `/new`).

**Bridge (`resume-exec.ts`, fully synchronous, no await):**

1. existing `expect.sessionId` check (`builtin-bridge.ts:340-344`) → `E_SESSION_CHANGED`.
2. `!ctx.isIdle() || ctx.hasPendingMessages()` ⇒ `E_COMMAND_DENIED`, retryable, `resume:busy` (D4).
3. **exec claim** (one per process, shared with `/new`): held ⇒ `E_COMMAND_DENIED` `exec:in-flight`. `/new`'s
   `armExec` honours the same claim (r1 #2 concurrent pick / pick-vs-/new).
4. gen index lookup `id → FileFact`; missing ⇒ `E_NOT_FOUND` `resume:stale-list` (UI reloads the list).
5. arm **ticket** `{nonce, frameId, op:"resume", source:{sessionId, file}, target:FileFact & {id}, confirm, deadlineAt:
now + min(opTotal, 5000), state:"armed"}` (payload bound to source **and** target, r1 #2); claim taken.
6. `pi.sendUserMessage("/webhub __exec resume <nonce>", {deliverAs:"followUp", expandPromptTemplates:true})` — sync
   throw ⇒ revoke ticket, release claim, `E_STALE_CTX` effect none; async rejection ⇒ same via late (if still armed).
7. Inspect `ticket.state` synchronously (F5: the handler's sync prefix has already run):
   - `rejected{code,msg}` ⇒ return that error, **effect none** (the common failure path is now a plain sync reply);
   - `switching` ⇒ return ok `{op:"command", kind:"builtin", completion:"async"}`; the outcome comes as one `cmd_late`;
   - still `armed` (settle-deferred re-entry, F5) ⇒ arm an unref'd revoke timer at `deadlineAt`, return ok async. If the
     timer wins the CAS: revoke, release claim, late `E_DEADLINE` **retryable:false** effect none — a revoked ticket can
     never switch (r1 #1).

**`internalExec("resume <nonce>")` (command context; sync until `ctx.switchSession`):**

a. CAS `armed → validating` on the nonce; anything else (unknown/expired/revoked) ⇒ no-op, terminal warning.
b. Re-validate, all synchronous: source session id **and** file unchanged; `isIdle() && !hasPendingMessages()`;
`now ≤ deadlineAt`; `openSessionNoFollow(target.path)` ⇒ regular, `dev/ino === target`; `readSessionHeadFd` ⇒
`id === target.id`, `resolve(cwd) === resolve(ctx.cwd)`, `!child`; provenance `!has(path)`; not the current file;
D5 check (§7, recommended variant: size/mtime unchanged since listed and mtime older than 30 s, unless
`ticket.confirm`). fd closed. Failure ⇒ `rejected{…}` (D5 failure ⇒ `E_CONFIRM_REQUIRED` `resume:active-elsewhere`),
claim released; if the bridge already returned (deferred path) the rejection goes out as late (retryable:false).
c. `switching`; set `switchInFlight` (web `prompt` ops get `E_STALE_CTX` retryable effect none while set — closes the
web half of the `session_before_switch` window); `await ctx.switchSession(path, { withSession })`.
d. Outcomes → exactly one late result: `withSession` verifies `rc.sessionManager.getSessionId() === target.id`, the
file path, **and identity**: `openSessionNoFollow(rc.sessionManager.getSessionFile())` ⇒ `dev/ino === ticket.target`
(r2 #3) ⇒ late ok; any mismatch (F6 missing-file/replace window) ⇒ late `E_STALE_CTX` effect **unknown**
`resume:mismatch` (the switch already happened — reported, not undone); `{cancelled:true}` ⇒ late `E_COMMAND_DENIED` effect none `resume:cancelled`; throw ⇒ late
`E_STALE_CTX` effect unknown. `finally`: release claim, clear `switchInFlight`, drop ticket. All late failures are
`retryable:false` (no F9 re-execution); a user retry is a new id.

Session boundary (`session_shutdown` not caused by our own ticket): armed tickets revoked → late `E_SESSION_CHANGED`.

**Disclosed residual windows** (path-only pi API, F6): W1 between our checks and pi's `SessionManager.open` lie the
async `session_before_switch` handlers — a file swap there is not prevented, only detected afterwards (d). pi keeps
only the path, so the post-switch check sees the file pi will append to next; a replacement that is **swapped back**
before that check (pi loaded inode B, the path points at the original inode A again) carries the same id and path and
is **entirely undetectable** — disclosed, not mitigated. A
TUI-typed prompt in that window is aborted by pi's teardown (TUI `/resume` has the same window). W2 another process
holding the target open while idle is not detectable (D5). Busy race is closed: idle is re-checked synchronously in
(b) and the switch starts in the same tick.

RPC/managed sessions: same path (F7, F11); proven by conformance C2.

### 2.6 UI

- `ui/src/logic/resume.ts` (pure): `parseResumeIntent(text)` → `{scope}` for `resume`, `/resume`, `/resume-recent`
  (+ optional ` --all`); `resumeAvailable(status, commandsEnabled)` = `status.features?.includes("resume.v1")`;
  `decoratePalette(rows)` shows `/resume`, `/resume-recent` as runnable with a 「恢复会话」 description when available;
  `validateSessionsWire(unknown)`; `knownLiveElsewhere(id, agents, selfKey)` (another live card's `session.sessionId`).
- `composables/useResume.ts`: `idle → loading(attempt) → ready{gen, rows, next} → picking → switching → closed | error`;
  `resume:scanning` ⇒ ≤4 retries (1 s, new ids); search debounce 300 ms + request generation counter (stale replies
  dropped); `reset:true` ⇒ replace rows; pick: `E_CONFIRM_REQUIRED resume:active-elsewhere` ⇒ inline confirm ⇒ resend
  with `confirm` (new id); ok async ⇒ `switching` until `agent.session.sessionId === id` (close), another id (「已切换到
  其他会话」), the ctl item turning `late_failed` (one `query` for code/message), or 10 s (「未确认切换，请查看终端」).
- `useControl.ts` + `types.ts`: optional `queryCommand(agentKey, name, args)` — `transport.command` with a fresh id and
  `expect`, no `ctl_send`/`remember`.
- Dialog host: `AgentDetail.vue` mounts `ResumeDialog` (lazy `defineAsyncComponent`) and provides `RESUME_DIALOG`
  (`open({scope})`) to both `DetailDock` and `DetailHeader`; it unmounts with AgentDetail on privacy relock (F10).
- `DetailDock.vue:214` first line of `onSend`: intent ∧ available ⇒ `open(intent)`; `Composer.vue sendGate`: intent ∧
  available ∧ empty tray ⇒ ok.
- `DetailHeader.vue` (D7): 「恢复」 button right after the clear button (`:339-352`), gated `clearUsable ∧
resumeAvailable`, not busy-gated (D4: browse while busy), opens `RESUME_DIALOG`.
- `components/control/ResumeDialog.vue`: root class `picker-scrim` (no OVERLAY_ROOTS edits), ≤640 px via
  `PickerSheet.vue`; header = search + segmented 「48h | 全部」; row = title (interpolation only) + badges 当前 / ⑂ /
  「已在其他窗口打开」 + relative time; footer = 「加载更多」, partial/truncated note, D5 disclosure line. Busy ⇒ banner
  「Agent 正在回复，结束后再切换」 and rows disabled. A known-live-elsewhere row needs a local second click (UI half of
  D5). Keyboard ↑/↓/Enter/Esc; no autofocus on coarse pointers; rows ≥44 px.
- i18n `i18n/{zh,en}/resume.ts`; styles in a lazily imported css with the dialog.

### 2.7 Capability signal and policy (r1 #8)

- Agent `status.ts readStatus` adds `features?: string[]` (bounded ≤32 × ≤64 chars) with `"resume.v1"` iff control is
  enabled, the session is persisted (`getSessionFile()` defined), and `webCommandPolicy.resume` is absent or `"allow"`
  (`"confirm"`/`"deny"` ⇒ feature off — documented). Old agents never send it ⇒ no false positive from a user override.
  Schema gets the optional field (old hubs already forward unknown status fields, F9 — pinned by a test against the
  pre-change schema).
- `command-policy.ts`: advertised bare `resume` **stays deny** (old UIs unchanged); `resume` with `__list`/`__pick` args
  ⇒ allow (subject to the same override rule); `resume-recent` stays deny for every web form (the new UI never sends
  it — intents are resolved client-side).

### 2.8 Compatibility matrix

| agent                 | hub | UI  | result                                                                                        |
| --------------------- | --- | --- | --------------------------------------------------------------------------------------------- |
| old                   | any | new | no `resume.v1` ⇒ no intercept, no button; `/resume` denied as today; byte-identical behaviour |
| new                   | any | old | `/resume` still advertised deny; bare `resume` is a prompt as today; nothing new is reachable |
| new                   | old | new | full feature (`data.sessions`, `status.features` both pass verbatim)                          |
| new                   | new | new | full feature                                                                                  |
| new (`resume:"deny"`) | any | new | feature off                                                                                   |

## 3. Packages (P1 ∥ P2 ∥ P3; frozen = §2.2 API, §2.4 wire, §2.7 `features`)

| pkg                | files (exclusive)                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1** session-nav | `src/session-nav/{session-head,provenance,classify}.ts` (new), `subagent-sessions.ts` (cache v2 → provenance; delete retitle), `recent-sessions.ts`, `index.ts`; `tests/session-nav/*`                                                                                                                                                                                                                                         |
| **P2** agent       | `src/web-hub/protocol/messages.ts` (types + optional `features` schema), `src/web-hub/agent/{resume-list,resume-exec}.ts` (new), `builtin-bridge.ts`, `command-policy.ts`, `commands.ts` (thenable reads, quiet/slim, `switchInFlight` prompt guard), `index.ts` (ticket/claim replaces `pendingExec`, `internalExec` op `resume`, boundary revoke), `status.ts`; `src/commands/webhub.ts` (messages); `tests/web-hub/agent/*` |
| **P3** UI          | `ui/src/logic/resume.ts`, `ui/src/composables/{useResume,useControl}.ts`, `ui/src/types.ts`, `ui/src/components/control/ResumeDialog.vue`, `components/control/Composer.vue`, `components/detail/{AgentDetail,DetailDock,DetailHeader}.vue`, `i18n/{zh,en}/*`, styles; `tests/web-hub/ui/*resume*`                                                                                                                             |
| **P4**             | `tests/conformance/web-resume.test.ts`, `AGENTS.md` (session-nav + web-hub P2 paragraphs), `docs/dev/web-resume/acceptance.md`                                                                                                                                                                                                                                                                                                 |

Frozen for all: `hub/**`, `CmdSchema`/`CtlItemSchema`, `hub/spawn/history/**`.

## 4. Tests

- **P1**: head reader (header/marker/name in head and tail/first-user loose extraction/oversized line/too-long header);
  provenance: cold cache + old parent outside 48 h + recent child without self-marker ⇒ hidden after backfill, budget
  exhaustion ⇒ `complete:false` then converges on the next call, warm cache uses stale entries without restat, v1 cache
  ignored, prune; resume from `scannedTo` after an append; identity change / shrink restarts at 0 and drops marks; a
  single 200 MiB parent never starves other files (round-robin, 8 MiB chunks) and the backfill converges within the
  stated number of calls; 20 001 files ⇒ `capacity:"files"`, self-marked children still hidden; mark/entry/cache byte
  caps + oversized cache file treated as absent; renamed child hidden; partial-progress test with **real temp-dir paths** (no sub row ever
  reaches the selector); AbortSignal leaves no temp dir.
- **P2 list**: shared custom sessionDir with foreign-cwd files excluded; duplicate header ids omitted + `ambiguous`;
  custom filenames listed; bounds (64 KiB head, 4 KiB header, 64 MiB/5 s total, 2 000 rows, page 100/32 KiB, title 120,
  C0, surrogates) as a seeded property test; big single line; two scopes concurrently ⇒ ≤4 fds; boundary aborts a build
  and its late completion never populates the cache; cursor reset on gen change and on q change; stable order.
- **Open discipline (P1+P2)**: a listed regular file swapped for a FIFO with no writer before the open ⇒ rejected and
  the call returns (test wrapped in a 2 s hard timeout — a hang fails it); same for the provenance scan and the exec
  re-validation; a char device (`/dev/null` symlinked in → `O_NOFOLLOW` reject; hard path to a device node → non-regular
  reject); fd count back to baseline after every failure path.
- **P2 pick**: sync reject paths (busy, pending, in-flight claim, stale list, expect mismatch) never call
  `sendUserMessage`; exec re-validation rejects: source changed, became busy (a prompt started between list and pick),
  file deleted, file replaced (new inode), symlink swap, header id/cwd mismatch, became a child, current file, D5; post-switch same-id/same-path replacement with a new inode ⇒
  `resume:mismatch` effect unknown;
  **deferred re-entry** (simulated `_isEmittingAgentSettled`) completing after `deadlineAt` ⇒ revoked, **no switch ever
  happens** (r1 #1 anchor test); concurrent picks; pick vs `/new`; boundary revokes; exactly one late per armed ticket;
  late failures retryable:false; `switchInFlight` blocks web prompts; `withSession` id mismatch ⇒ effect unknown.
- **P3**: intent matrix + `resumeAvailable` false ⇒ golden old behaviour; sendGate; palette decoration; header button
  gating (clear-button test pattern `detail-header-clear.test.ts`); retries; stale search drop; reset; switching
  success/other/late_failed/timeout; busy banner; local and server D5 confirms; dialog unmount on relock; `check:web`
  delta recorded (target ≤ +1.5 KiB first-screen, dialog in a lazy chunk).
- **P4 conformance** (real pi 1.2): C1 TUI-mode: `pi.sendUserMessage("/webhub __exec resume <nonce>")` from an event
  context runs the handler's sync prefix before returning (F5 pin) and `switchSession` fires `session_start` on the
  target; C2 same in `--mode rpc`; C3 `SessionManager.list` partials carry temp paths (F4 pin); C4 a real child run's
  file has the line-2 marker and never appears in either list; C5 `SessionManager.open` of a missing path creates a new
  session (F6 pin, guards `resume:mismatch`).
- Gates: `format:check → typecheck → test → build → build:web → check:web`.

## 5. Risks

- R1✱ (corrected): extension commands are not queued while streaming (F5) — the old "TTL expiry while queued" story
  was wrong. Busy is now re-checked synchronously at the execution point; the remaining exposure is W1 (§2.5).
- R2 large folders: provenance backfill may need several opens to complete; disclosed residual (§2.1).
- R3 W1/W2 windows (§2.5, D5).
- R4 `handleCommand` gains a thenable branch for reads only; all existing ops stay synchronous (unchanged
  `commands.test.ts` pins it). The `pendingExec` → ticket/claim refactor changes `/new` only by adding the claim check.
- R5 the bounded web head reader can miss a rename buried deeper than the 16 KiB tail (falls back to the first-message
  title); TUI keeps pi's exact titles.

## 6. Docs

AGENTS.md session-nav paragraph (D1 hide rule, provenance index + cache v2, residuals) and web-hub P2 paragraph
(`resume` `__list`/`__pick`, `status.features`, exec ticket/claim shared with `/new`, read-only thenable path, W1/W2).

## 7. D5 (another writer on the target jsonl) — decided: D5-a (§9)

pi never locks session files; two processes writing one jsonl corrupt its tree.

- **D5-a (recommended) — bounded positive detection + honest residual.** UI: a row whose id is another live card's
  session needs a second click. Agent, at the execution point (§2.5 b, ≤1 fstat on the already-open fd): the target
  changed size/mtime since it was listed, or was written within the last 30 s ⇒ `E_CONFIRM_REQUIRED
resume:active-elsewhere` ⇒ explicit second confirm. Footer line: 「pi 不锁会话文件；若该会话正在一个未接入 web 的终端里
  空闲打开，这里无法发现。」 Why: size/mtime are **activity signals, not proof of occupancy** — they flag a target that
  something wrote recently (an actively used session appends every turn) at zero hub cost, can miss a writer that has
  not written yet, and can flag a writer that has since exited; the undetectable idle-open case is stated, not hidden.
- D5-b — pure TUI parity: no checks, only the footer line. Simplest; the TUI has no guard either.
- D5-c — hub-backed occupancy (cards + managed records + `/proc`, `hub/spawn/history/occupancy.ts:64-163`): strongest,
  but needs a hub endpoint/cap and an agent-side round trip, and its `/proc` "unconnected pi" rule would flag almost
  every pick on a machine with several pi processes — out of scope for v1.

## 8. One-page summary (for the user)

**功能**：web 详情页输入 `resume` / `/resume`（`--all` 同样有效），或点头部「清空」旁的新按钮「恢复」，弹出当前目录的会话列表
（默认最近 48 小时，可切「全部」，按标题搜索、加载更多）；点一行就在**同一个 pi 进程**里切过去，页面自动跟随。TUI 与 web 都**彻底隐藏
subagent 会话**，没有开关。Agent 正在回复时列表可看、不能切。

**怎么认 subagent**：会话文件第 2 行的 `subagent:child` 标记（v0.4.0 起的新子会话），或任一主会话的 `subagent:run` 记录指向它。
后者现在查的是**整个会话目录**的记录（增量回填、有预算、带磁盘缓存），不再只看 48 小时内的文件，所以“旧父会话 + 最近被续用的旧子会话”
也会被藏住。已知盲区：v0.4.0 以前、且父会话文件已删除的子会话；大目录在最初几次打开时回填未完成。

**列表怎么来**：web 列表不再调用 pi 的整文件解析——agent 自己只读每个文件开头 64 KiB（必要时末尾 16 KiB），全程有字节、时间、
并发和缓存上限，不保留任何消息正文；每页 ≤100 行 / 32 KiB，翻页游标绑定扫描批次，批次变了就整页重载。只传标题、时间、会话 id，
不传路径。只列 header 里 cwd 等于当前目录、id 唯一的会话。

**切换怎么保证不出错**：点选后，agent 同步检查（忙不忙、有没有排队消息、列表是否过期、有没有别的切换在进行），通过才签一张绑定
“来源会话 + 目标文件身份”的一次性票据并重入命令上下文；所有关键检查在**真正调用切换前的同一时刻**再做一遍（来源没变、仍空闲、
文件没被删/换/改成符号链接、id 和目录都对）。超时作废的票据永远不会再切换；失败直接同步返回，切换结果事后单独回报一次。剩余的
极小窗口（pi 只接受路径，切换前其他扩展钩子运行期间）会在切换后核对会话 id，如实报告。

**兼容**：不改 hub、不加新命令通道；旧 agent 或旧页面下一切照旧。托管（rpc）会话同样可用。

**分包**：P1 列表核心与 TUI 过滤；P2 agent 列表/切换；P3 web 弹窗、输入拦截、「恢复」按钮（懒加载）；P4 真 pi 一致性测试 + 文档。
P1/P2/P3 并行。

**D5 已定为 D5-a**（§9）：已知在别的窗口打开、或文件刚被写过/列出后有变化时要求二次确认（这些只是“最近有活动”的信号，不是占用证明），并明说“未接入 web 的终端里空闲打开的会话无法发现”。

## 9. User rulings (2026-10-16)

- **D1 → 彻底隐藏**（overrides the recommendation): subagent sessions never appear in the TUI or web list; no
  `resume --sub` flag and no 「含 subagent」 toggle. Keep the 「已隐藏 N 个」 count line out as well unless it is free
  (drop it if it costs a second scan). Child transcripts stay reachable through the existing subagent tooling
  (`get_subagent_result`, session files), not through resume.
- **D3 → 只列当前目录**（recommended）: current folder, 48h default + 「全部」, search, load more.
- **D4 → 忙时可看不可切**（recommended).
- **D7 → 加「恢复」按钮**（overrides v1 scope): a header button next to the clear button opens the same session
  list dialog (same gating as the clear button + the resume capability signal).
- D2 / D5 / D6 / D8: not asked; the recommended options stand (main-session ruling).

## 10. Review r1 disposition

| #   | finding                                                | disposition                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | async pick under read-timeout semantics ⇒ late switch  | **fixed** — pick is fully synchronous in the bridge (§2.5 steps 1-7); only `__list` may be async (§2.4). A ticket is armed only after all sync checks; a revoked/expired ticket can never switch (CAS, step 7 / a); late failures `retryable:false`; anchor test in §4 P2 pick. |
| 2   | busy check not atomic; R1 wrong; overwritable nonce    | **fixed** — idle + pending re-checked synchronously inside `internalExec` immediately before `ctx.switchSession` (§2.5 b-c); exec claim shared with `/new` (step 3); ticket bound to source + target (step 5); boundary revoke; R1 corrected (§5, F5); tests §4.                |
| 3   | path identity / missing file / cross-cwd               | **fixed** — gen index stores dev/ino/size/mtime; exec opens `O_NOFOLLOW`, fstat-matches, re-reads header id + cwd, rejects child/current (§2.5 b); list filters by header cwd (§2.4); post-switch id verification + disclosed W1 window (§2.5 d, residuals); C5 pin.            |
| 4   | recent mode misses old-parent children; F3 overstated  | **fixed** — provenance index over the whole dir, incremental + budgeted, cache v2, append-only lower bound (§2.1); F3 corrected to v0.4.0 / create-only / best-effort (§1); residuals disclosed; cold/warm tests (§4 P1).                                                       |
| 5   | partial progress uses temp paths; 2-arg progress type  | **fixed** — map temp → real before filtering, pi's 3-arg type, signal threaded (§2.3); real temp-path test + C3 pin (§4).                                                                                                                                                       |
| 6   | D5 UI-only confirm does not cover two writers          | **fixed as a decision** — D5-a/b/c with an execution-point recheck in the recommended option and an explicit residual statement (§7, §2.5 b).                                                                                                                                   |
| 7   | scan/cache unbounded (`SessionManager.list` reads all) | **fixed** — web path never calls `SessionManager.list`; bounded head/tail reader, per-file/line/total/time/fd/gen/row bounds, no message text retained, epoch fence (§2.4 table); tests §4 P2 list.                                                                             |
| 8   | policy is not a version signal; alias overrides        | **fixed** — `status.features` `"resume.v1"` (old agents cannot emit it); advertised `/resume` stays deny; override rule for `resume` and `resume-recent` defined (§2.7); matrix §2.8.                                                                                           |
| 9   | offset paging not bound to a generation                | **fixed** — gen-bound cursor with q hash, `reset:true`, stable `(modifiedMs desc, id asc)` order (§2.4); tests §4.                                                                                                                                                              |
| 10  | `_<id>.jsonl` suffix resolution                        | **fixed** — id → file comes from the gen's header enumeration (custom filenames work), duplicates omitted, exec re-verifies header + identity (§2.4, §2.5 b); tests §4.                                                                                                         |

- **D5 → D5-a**（2026-10-16, recommended）: bounded positive detection (another live web card on the same session,
  or the target written within 30 s / changed since listed ⇒ second confirm) + the honest footer line about idle
  sessions open in unconnected terminals.

## 11. Review r2 disposition

| #     | finding                                                    | disposition                                                                                                                                                                                                                                                          |
| ----- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | sync `O_NOFOLLOW` open blocks forever on a FIFO swapped in | **fixed** — `SESSION_READ_FLAGS` = `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK\|O_NOCTTY`, fstat-regular-or-reject, fd closed on every path, used by every open incl. the provenance scan and cache read (§2.2 "Open discipline"); FIFO/device tests with a hard timeout (§4). |
| #3    | same-id same-path replacement reported as success          | **fixed** — post-switch `dev/ino` recheck of the path pi now holds (§2.5 d); the swap-back case is disclosed as entirely undetectable (§2.5 W1).                                                                                                                     |
| #4    | backfill convergence / starvation / cap conflict           | **fixed** — per-file `scannedTo` + identity resume, 48 h lane ≤ half budget + persisted round-robin cursor with 8 MiB chunks, convergence bound, explicit `capacity` completion semantics and guarantees (§2.1); tests (§4 P1).                                      |
| #7    | cache bounded only by entry count                          | **fixed** — per-dir cache file, per-entry mark count/bytes caps, 16 MiB read/write cap with defined over-limit behaviour, shared with #4's capacity semantics (§2.1 table); wire enum gains `"capacity"` (§2.4).                                                     |
| r2 #6 | D5-a wording overclaims                                    | **fixed** — size/mtime described as activity signals, not occupancy proof (§7 D5-a).                                                                                                                                                                                 |
