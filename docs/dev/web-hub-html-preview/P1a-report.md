# P1a report — hub pure layer (web-hub-html-preview plan v2 + §R2)

## Changed files

NEW (src/web-hub/hub/preview/): `pv-path.ts`, `pv-mime.ts`, `pv-io.ts`, `html-cap.ts`, `pv-admit.ts`
MODIFIED: `stream.ts` (streamRawBody extraction, `StreamSrc.pv`, `PvStreamIo`, fail reason `"not-live"`), `fs.ts` (+1 additive export `PV_DIR_OPEN_FLAGS`)
Tests: `tests/web-hub/hub/preview/{pv-path,pv-mime,pv-io,html-cap,pv-admit}.test.ts` (new), `stream.test.ts` (+7 tests), `source-scan.test.ts` (5 new files added to KERNEL_FILES), corpus `tests/fixtures/pv-path-corpus.json`.
`admit.ts`, routes/http/hub, P0 files, ui/** untouched.

## Deviations (please review)

1. `fs.ts` got `PV_DIR_OPEN_FLAGS` (O_RDONLY|O_DIRECTORY|O_NOFOLLOW): only fs.ts may import node:fs (source-scan), so the dir-fd flag constant had to live there.
2. `source-scan.test.ts` edited: its "expected file set" assertion would otherwise fail on the 5 new files; they are now scanned under the same rules (no node:fs, no readFile().
3. `StreamFailReason` gained `"not-live"` (beforeHead() false ⇒ pre-head; P1b maps to 404). Nothing else consumes the union.
4. O_DIRECTORY|O_NOFOLLOW on a symlinked dir yields ENOTDIR ⇒ 404 (not 409) from `pinPvDir`.
5. `PV_DENY_AUDIT_THROTTLE_MS` is 100 in P0 (plan text says 1/10s); store uses the constant as frozen.
6. pv `Content-Length` is forced by stream.ts to the admitted size; building the §3.1 header table (CSP, ACAO null…) is left to P1b (`pv-mime.pvContentType` supplies Content-Type).

## Exported APIs for P1b (verbatim signatures)

```ts
// pv-path.ts
parsePvRelPath(rawRel: string): { ok:true; rel:string; segments:readonly string[] } | { ok:false; reason: PvPathReject }
splitPvRest(rest: string): { cap: string; rawRel: string } | undefined   // undefined ⇒ bad cap ⇒ 404; rawRel "" ⇒ parse says "empty"
parsePvwRest(rest: string): string | undefined
redactLogUrl(url: string): string; isPvLogUrl(url: string): boolean; errCode(err: unknown): string
// pv-mime.ts
pvContentType(rel: string): string; pvExtOf(rel: string): string; PV_DEFAULT_MIME
// pv-io.ts
createPvIoGate(opts?: { slots?; opTimeoutMs?; now? }): PvIoGate
interface PvIoGate { slots; inflight; waiting; lateFds;
  run<T>(op: () => Promise<T>, o: {deadlineAt:number; signal?:AbortSignal}): Promise<T>;
  open<H extends {close():Promise<void>}>(op, o): Promise<H>;   // late handle closed on settle
  close(op: () => Promise<void>): Promise<void>;                // bounded, never rejects, priority queue
  dispose(): void }
// html-cap.ts
createHtmlCapStore(deps: { now(); closeDir(fh): Promise<void>; onEnd?(s: PvEndSummary): void; randomBytes?; capTag?; limits? }): HtmlCapStore
HtmlCapStore { revokeSeq(): number; revokedSince(seq0, {listener,sidTag?,userId?}): "clear"|"revoked"|"unknown";
  endCap(rec: HtmlCap, reason?: "revoked"|"close"): void;   // see contract below
  mintChecked(seq0, HtmlCapMintInput): {ok:true;rec}|{ok:false;reason:"revoked"|"tombstone-gap"};  // sync check+insert; on !ok caller closes dirFh
  lookup(cap, listener, origin, {touch?}): HtmlCap|undefined; isLive(rec): boolean;
  lease(rec): PvLease|undefined  // {rec, signal, release()}; hold across admission+stream
  addWaiter(rec, {cancel(reason)}): boolean; removeWaiter(rec, w): void;
  noteRequest(rec); noteBytes(rec,n); noteDenied(rec, code): boolean /*may audit*/;
  revoke(sel: PvRevokeSelector, reason: PvRevokeReason): void; sweep(); dispose(); size; totals():{active,queued} }
// pv-admit.ts
dirTooBroad(dir, denyCtx, uploadsRoots?): boolean                       // D2
pinPvDir(deps: PvAdmitDeps, {boundDir, entry, entryDev, entryIno, deadlineAt, signal?}): Promise<{ok:true;dirFh}|PvFail>
admitPvFile(deps, {dirFd, dirPath, rel, signal?, deadlineAt?}): Promise<{ok:true;fh;size;realpath}|PvFail>
PvAdmitDeps = { denyCtx; gate: Pick<PvIoGate,"run"|"open"|"close">; fs?: Partial<PreviewFs>; now() }
PvFail = { ok:false; status (0=abort); code; reason?; retryAfterS?; revokeCap?: true }
pvFailOf(err): PvFail
// stream.ts
readAndStream(src with pv: { headers; beforeHead(): boolean; io: PvStreamIo /* PvIoGate satisfies */ }, sink, opts)
```

Usage notes: capture `seq0 = store.revokeSeq()` BEFORE `authorize`; `mintChecked` right after `pinPvDir` (same tick). Take `store.lease(rec)` at dequeue, pass `lease.signal` as `opts.signal` to readAndStream and `lease.release()` in finally; `closeDir` = `(fh) => gate.close(() => fh.close())`.
**`endCap` contract (main-session ruling)**: `store.endCap(rec: HtmlCap, reason?: "revoked"|"close"): void` ends exactly one cap — bumps `revokeSeq` + per-cap tombstone (matches no mint binding), aborts that cap's leases, cancels its queued waiters, emits one `pv-end` summary, closes the dir fd once refs drain; siblings untouched; idempotent (no-op if already ended: no seq bump, no 2nd summary). When `admitPvFile` returns `{ok:false, revokeCap:true}` P1b calls `store.endCap(rec)` (rec = the cap the request holds; the request's own lease may still be held — the fd closes when it is released) and answers the constant 404.
Dir-fd lifetime: hold a lease while `admitPvFile` runs (the fd must not be closed mid-admission).

## Self-verify

- `npx prettier --write` on all changed files: done.
- `npm run typecheck`: tsc (both projects) pass; vue-tsc fails ONLY in `src/web-hub/ui/src/components/shell/VersionPanel.vue(247,61)` (another agent's concurrent UI work, not P1a).
- `npx vitest run tests/web-hub/hub/preview tests/web-hub/protocol tests/web-hub/boundary.test.ts`:
  `Test Files 52 passed (52) · Tests 1687 passed | 3 skipped (1690)` (after endCap addition; `npx tsc --noEmit -p tsconfig.json` clean)
