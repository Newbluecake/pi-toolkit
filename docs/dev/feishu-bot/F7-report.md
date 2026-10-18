# F7 report — Feishu reply rendering, splitting and durable outbox

Package **F7** of `plan.md` (§6.1 format & splitting, §6.2 targets & outbox, R1 #12/#13, §R2-b effect on what may be sent, §5.8 outbox caps).
Pi-free, hub-boundary clean, no module-scope mutable state, every timer through the injected (unref'd) clock, nothing throws.
**No frozen file changed** (`protocol/feishu.ts`, `state.ts`, `api.ts` untouched; F6's append-only `state.ts` edits did not affect any F7 test).
Consulted the plan author (r_1WAP03BH) once; adopted: group-root keeps `inThread:true`; the retry ladder must respect the uuid-dedup window;
overflow mode must be decided BEFORE anything is enqueued (§F8 below).

## Files

| File                                                     |                                                           |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `src/web-hub/hub/feishu/split.ts`                        | NEW — pure UTF-8/JSON-size markdown splitter              |
| `src/web-hub/hub/feishu/render.ts`                       | NEW — untrusted markdown ⇒ schema-2.0 cards / text notice |
| `src/web-hub/hub/feishu/outbox.ts`                       | NEW — durable outbox over `state.outbox`                  |
| `tests/web-hub/hub/feishu/{split,render,outbox}.test.ts` | NEW — 91 + 53 + 51 tests                                  |

## render.ts API

```ts
renderReply(input: ReplyInput): RenderedReply
// ReplyInput { kind: done|failed|waiting|info, label, shortId?, text, truncated?, failure?:{stopReason?,message?}, mention?, overflow?: "file"|"truncate", codeTags?, maxCardBytes?, maxParts? }
// RenderedReply { parts: RenderedPart[] /*msgType "interactive", content (serialized card), bytes, index, total*/, overflow?: {fullText, fileName "reply-<sid6>.md", clipped}, truncatedByOverflow, incomplete }
renderNotice({ label, text, mention?, maxBytes? }): RenderedMessage   // msgType "text", `{"text":"【label】…"}`
neutralizeMarkdown(text, {codeTags?}), neutralizeTags, sanitizeText, sanitizeLabel, safeHref, cardTitle, constants (OUTPUT_INCOMPLETE_LABEL, …)
```

Card: `{schema:"2.0", config:{update_multi:true}, header:{title:{plain_text "pi · <label> (i/n)"}, template: green|red|orange|grey}, body:{elements:[{markdown}]}}`.
`failed` ⇒ red, lead `**❌ 运行失败** · <stopReason>` + quoted neutralized error message ≤500 chars + any partial text; `aborted` ⇒ orange `**⏹ 运行已中止**`.
Wire-truncated text (`truncated:true`) ⇒ `⚠️ 输出不完整 · output incomplete (truncated in transit)` appended to the LAST part (reserved in every part's budget).
Group replies: `mention` (validated `FEISHU_OPEN_ID_RE`) ⇒ `<at id=ou_…></at> ` on part 1 only; invalid ⇒ ignored. Notices use the text-message syntax `<at user_id="…"></at>`.

### Untrusted-markdown rules (T3/T7 posture, all tested incl. a mutation check)

1. strip control/bidi/ZWSP/BOM/soft-hyphen/other Cf (keeps `\n \t`, ZWJ/ZWNJ), CRLF/CR/U+2028/9 ⇒ `\n`, lone surrogates ⇒ U+FFFD;
2. every tag-shaped `<` (`<`+letter `/ ! ?`) gets U+200B after it — **in prose, inline code and fences** (default `codeTags:"neutralize"`; `"literal"` keeps code literal);
3. `[text](url)` survives only for `http(s)`/`mailto` URLs that parse with no userinfo/backslash/control/quote chars, re-serialized by `URL` (parentheses ⇒ `%28/%29`); anything else ⇒ `text (` + inert code span of the destination + `)`; links are parsed by a bounded balanced-paren scanner (inline code is opaque, so `[`x`](javascript:…)` is still validated);
4. `![alt](url)` ⇒ `[🖼 alt](safe-url)` or the alt text — never an image reference;
5. the ONLY live tag a card can contain is the validated sender mention; header/labels are `plain_text` (sanitized, ≤48 code points).
   Work bound: only `(maxParts+1)·cap` chars are neutralized for the card path (30 MB input renders in ms); the attachment gets the whole sanitized raw text.

## Splitting rules (split.ts) + fixtures

Size = **UTF-8 bytes of the serialized card JSON ≤ `FEISHU_REPLY_LIMITS.maxCardBytes` (20 000)**. JSON string escaping is per code unit ⇒ body cost = `chrome + Σ jsonBytes(piece)`; `render.ts` measures the real chrome (title worst case `(4/4)`, mention, trailer reserved) and re-verifies every produced card (≤6 shrink retries, then a fixed fallback card).

| Rule                 | Behaviour                                                                                                                                               | Test fixture                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| paragraph preference | break at blank line / heading / around a fenced block once the part is ≥40 % full, else at a line boundary                                              | `paragraph boundary`, `early paragraph break`   |
| fences               | cut fence is closed at part end, **re-opened with its original opener (info string kept)**; `~~~`/long fences honoured; an unterminated fence is closed | `fences` describe (6 cases)                     |
| never empty code     | an opener that would end a part moves with its body; no part is only opener+closer                                                                      | `never just opener plus closer`, `opener moves` |
| long lines           | cut at whitespace when it keeps ≥½ of the piece, else at a **grapheme** boundary (`Intl.Segmenter`); cluster larger than the budget ⇒ code points       | `long lines` describe                           |
| surrogates/CJK/emoji | surrogate pair, ZWJ family emoji, combining sequences never split (when they fit); CJK exact reassembly                                                 | same                                            |
| blank handling       | leading blanks of a part dropped, trailing blanks never end a part                                                                                      | `drops leading blank lines`                     |
| bounded parts        | ≤`maxParts` (4) then `complete:false`; tiny budgets terminate with ≥1 code point per part                                                               | `maxParts`, `pathological tiny budget`          |
| numbering            | `" (i/n)"` only when n>1; budget for the numbered pass reserves the worst case                                                                          | render `part titles are numbered`               |
| overflow (>4 parts)  | `file` (default): part 1 + note `> 📎 …\`reply-<sid6>.md\``+`overflow{fullText,fileName,clipped}`; `truncate`: 4 parts + `> ✂️ 输出过长，已截断…`       | render overflow tests                           |

Property test: 60 seeded random documents (CJK/emoji/escapes/fences/headings) ⇒ every part ≤ budget, non-whitespace non-fence content preserved in order, deterministic. Render test: ASCII/CJK/emoji/escape-heavy/code samples × both overflow modes with mention+truncation ⇒ every card ≤20 000 B.

## outbox.ts

```ts
const ob = createFeishuOutbox({ state /*Pick<FeishuState,"outbox"|"commit">*/, api /*Pick<FeishuApi,"send"|"reply">*/, clock?, random?, onSettled?, onEvent?, targetGoneCodes?, policy? });
ob.start();                                  // after state.load(): index queued parts, re-emit settled groups (recovered:true), begin sending
await ob.enqueueFinal({ requestId, target, messages, variant?, laneKey? })   // → {ok,sendIds,durable,duplicate} | {ok:false, refused}
await ob.enqueueNotice({ target, message, key?, laneKey? })
ob.resume(); ob.stats(); await ob.stop(drainMs?); ob.dispose();
```

`OutboxTarget` (closed union; persisted as the existing `route/targetId/receiveIdType/inThread` fields — state.ts has no scope field and does not need one):
`p2p·reply{messageId}` · `p2p·send{open_id|chat_id}` · `topic{messageId}` (⇒ reply + `reply_in_thread:true` only) · `group-root{messageId,inThread?}`. A group chat `send` is **unrepresentable**; malformed/extra-shaped targets ⇒ `invalid-target`. A persisted reply is sent exactly as stored — no code path converts a reply into a send. `target-gone` (codes 230011/231003/230002, **unverified live**, injectable) fails the group; the outbox never falls back.

`enqueueFinal` refusals (loud, nothing half-written — group add + rollback in one tick): `cap`, `budget`, `unavailable`, `invalid-target|message|request`, `too-many-parts`, `disposed`; each emits `{event:"refused"}`. Caller marks the request `reply-failed`.
`sendId = "fo" + b64url(sha256(seed\npart))[0:40]`, seed = `requestId` (`requestId~variant` when variant) / `notice\n<key>` — deterministic ⇒ the same Feishu `uuid` on every retry and after any crash. The variant is persisted inside the stored `requestId` (`~` is forbidden in request ids), so a re-send under a new variant (e.g. p2p proactive after `target-gone`) is a distinct group.

### Part state machine (persisted `queued|sent|failed` + `attempts` + `code`)

```
enqueue ─(await state.commit)→ queued(durable) ─attempt→ ┬ ok ─→ sent ─┐
                                                         ├ retryable / effect unknown → queued (attempts++, code "u:<reason>" sticky | "n:<reason>"; in-cycle backoff 1 s/3 s, ≤3 tries or 30 s; then ladder 30 s,2 m,10 m,30 m,1 h…)
                                                         ├ auth refused/auth_failed/unconfigured → queue PAUSED (probe one part / 60 s; resume() or first success clears) — nothing failed
                                                         ├ target-gone / capability-denied → failed(code) + rest of group failed "skipped:<code>"
                                                         ├ other non-retryable rejection → failed("rejected:<reason>"), group continues ⇒ `partial`
                                                         ├ age > 24 h (final) / 10 min (notice) → failed("expired")
                                                         └ unknown-effect and age > 50 min (< Feishu's ≈1 h uuid dedup) → failed("expired-uncertain") — "may have been delivered"
group terminal ─→ onSettled(group) ─resolves→ records removed ; throws → retry after 60 s and on every start()
```

Bounds: frozen `maxRetries 2`, `taskBudget 30 s`, per-lane ≥250 ms (lane = `laneKey` in-process, else the target id after a restart), global ≤20 starts/s, ≤4 in flight, strict in-group part order (part N+1 waits for N). Timers: one wake timer to the next strictly-future instant (a past instant once spun the clock — fixed + regression test).
`SettledGroup`: `{kind, requestId?, variant?, outcome: delivered|failed|partial, code?, replyFailed, target, parts[{part,sendId,state,code?, messageId?,threadId?,chatId?, undelivered?}], recovered}`; `messageId/threadId/chatId/undelivered` exist only in-process (the V8 `threadId` for `group-root` binding arrives here).

### Crash matrix (all tested)

| Kill point                                                 | On disk                            | Recovery                                                                                  |
| ---------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| before `enqueue` commit                                    | nothing (`enqueue` never resolved) | caller re-enqueues (deterministic ids)                                                    |
| commit failing (`persist-failed`)                          | memory only                        | **no send** until a commit succeeds (`durable:false`, retried every 1 s)                  |
| committed, before send                                     | `queued`                           | `start()` sends with the same uuid                                                        |
| platform accepted, `sent` not persisted (or response lost) | `queued`                           | resend with the same uuid ⇒ platform dedup ⇒ one message                                  |
| in flight at shutdown                                      | `queued`                           | `stop()` aborts after the drain budget; next boot retries the same uuid                   |
| settled, handler not consumed / failing                    | `sent`/`failed` (content dropped)  | `start()` re-emits (`recovered:true`); handler retried every 60 s                         |
| settled records older than 1 h                             | swept by state                     | accepted residual: a handler failing >1 h loses the report (queued parts are never swept) |

## Hand-offs

**F8 (service/runs/files/dialogs/notify)**

- Call `outbox.start()` after `state.load()` and AFTER wiring `onSettled`; `stop(FEISHU_SHUTDOWN_BUDGET_MS.outboxDrain)` is shutdown step 4; `dispose()` on reset (then `state.destroy()`).
- `onSettled` must be **idempotent** and must make its consequence durable (`requests.transition(…, "reply-failed")` / `replied`, then `await state.commit()`) BEFORE resolving — resolving deletes the records. `replyFailed:true` ⇒ request `reply-failed`; `outcome:"partial"` is a partial reply (tell the user via a notice); `code:"expired-uncertain"` ⇒ say "may have been delivered".
- **Overflow:** `renderReply` returns `overflow` ⇒ upload `fullText` as `fileName` with `api.uploadFile` FIRST; only if it succeeds enqueue `[...parts, {msgType:"file", content: JSON.stringify({file_key})}]`; if the upload fails re-render with `overflow:"truncate"` and enqueue that — never enqueue part 1 before the decision (a later re-render would duplicate it).
- p2p `target-gone`: `group.parts[i].undelivered` (in-process) can be re-enqueued with `variant:"p2p"` and `{scope:"p2p",via:"send",…}`; topics/group-root get nothing (reply-failed only). For attached images/files use `msgType:"image"|"file"` with already-uploaded keys.
- Pass `laneKey: chat_id` for per-chat pacing; `onEvent` is body-free (use it for status counters; `capability-denied{msgType}` ⇒ `capability-denied:<x>`; `paused/resumed{auth}` ⇒ status `auth_failed`). Call `outbox.resume()` when credentials are replaced.
- Verify before relying on them: 230011/231003/230002 as "target gone"; whether card `config.summary` is accepted (not emitted); whether Feishu keeps code fences literal (then flip `codeTags:"literal"`).
- Notices: use `renderNotice` + `enqueueNotice({key})` (a stable key de-duplicates); notices are refused earlier at 448 parts by F4's reserve.

**F6:** nothing to consume; request states are advanced by F8 from `onSettled`. **FA:** construct per stack with the stack's `state`, `api`, system clock; no hub.ts edit needed from F7.

## Residuals / notes

- Inline code spans and links are recognised per line (multi-line spans are not); a mid-line cut of an overlong line can leave an unbalanced inline backtick in a part (last-resort path).
- In-process only data (`messageId`, `threadId`, `undelivered`) is lost across a restart by design (state has no field; frozen).
- `uuidSafeWindowMs` is measured from the part's `createdAt` (conservative); the dedup window itself is documented ≈1 h and not probed live.
- `variant` ids must match `[A-Za-z0-9_-]{1,16}`; request ids must not contain `~`.
- Real-tenant acceptance (FB1/FB6/FB7 era): card rendering of `<ZWSP`-broken tags in code, `target-gone` codes, `(i/n)` title look, `mention` in cards.

## Self-verification

- `timeout 280 npm run typecheck` — clean (3 projects).
- `timeout 400 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts` — 17 files, 922 passed (4 consecutive runs; one run under heavy parallel load flaked a fake-clock test → hardened with real-I/O waits).
- `npx prettier --check` on the 6 F7 files — clean.
- Mutation checks (each fails ≥1 test, then reverted): send-before-durable, uuid-window expiry (caught after fixing a latent zero-delay timer spin it exposed), no record removal after ack, `inThread` widened, tag neutralization off, unsafe link schemes allowed, fence re-open off.

## Follow-ups after r_ASBT6095 (GLM verification: conditional pass, 0 blockers)

| #   | Finding                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Tests                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | oversized fence opener: the rest of a cut opener was fence interior ⇒ every part re-emitted the whole opener | the rest of a cut OPENER line is plain text (`fenceBefore` undefined; the fence stays open for the following lines); a re-open line whose opener would take more than ¼ of the part is emitted **bare** (` ``` `, info string dropped). Verified through `renderReply` too: a 19.9 KB ` ``` `-prefixed line no longer degrades to the fallback card in truncate mode                                                                                                                  | split `fence opener larger than the budget` (4 budgets, round trip modulo fence marks, bare re-open), render `oversized fence opener through renderReply` (both modes) — fails when the fix is reverted (mutation-checked) |
| F2  | `stopReason` (lead line) and notice label were only `sanitizeLabel`ed ⇒ `<at …>` could go live               | new `markupSafeLabel` (= `sanitizeLabel` + `neutralizeTags`) used for the failed-card lead and the `【label】` of text notices. The plain_text card header is unchanged (no markup meaning there)                                                                                                                                                                                                                                                                                     | render `labels embedded in markdown/text content cannot go live` (stopReason ×3, notice label ×3 with and without mention)                                                                                                 |
| F3  | ≥1-code-point progress guarantee could overshoot the budget by ≤5 B                                          | the overshoot is now limited to a budget that cannot hold one code point: when a re-open line (or a bare opener) plus closer leave no room for one code point, the piece is emitted bare / the part is closed before it. Budgets ≥ 24 B are **never** exceeded (swept 24–90 B over a fenced/escape/emoji sample); smaller budgets terminate, lose nothing and overshoot by < one code point + a fence closer. Production budgets are ≥ 10 KB (render re-checks)                       | split `small-budget corners` (67 budgets × fenced sample, 23 tiny budgets × 2 samples)                                                                                                                                     |
| F4  | plan §6.2 "(≤2, backoff)" vs implemented 1+2 tries per cycle + 30 s → 1 h ladder until max age               | **RULING (main session): keep.** Stated explicitly as the accepted interpretation: `maxRetries=2` bounds the tries per **cycle** (1 + 2, 1 s / 3 s backoff, 30 s task budget); a cycle that ends in retryable/unknown-effect failures leaves the part `queued` and starts a new cycle on the 30 s / 2 m / 10 m / 30 m / 1 h ladder until the max age (final 24 h, notice 10 min), always with the same uuid, unknown-effect parts additionally bounded by the 50 min uuid-safe window | existing retry/ladder/expiry tests                                                                                                                                                                                         |
| F5  | a settled record swept by the state's 1 h TTL while siblings were still queued ⇒ the group never reported    | per-group in-process **tombstones** remember how each part ended; `SettledGroup.swept?: n` counts parts that are unknown after a restart (presumed sent: a failed part with continuing siblings is the only way to fail early, and it is rare). The silent "drop the group" path now only fires when NOTHING of the group is known. The group's target is cached at index time                                                                                                        | outbox `settled sibling swept while others are still queued` (in-process delivered, after-restart `swept:1`, swept FAILED sibling ⇒ `partial`) — fails without the tombstone (mutation-checked)                            |
| F6  | `renderNotice` had no final byte re-check                                                                    | same derive-then-verify loop as `renderReply` (≤6 shrink retries, then a fixed tiny notice)                                                                                                                                                                                                                                                                                                                                                                                           | render `renderNotice size re-check` (caps 256–700 × 5 hostile texts × 3 labels, with mention)                                                                                                                              |

API deltas for F8: `render.ts` exports `markupSafeLabel`; `SettledGroup` gains optional `swept`. Nothing else changed.

Self-verification (follow-up): `timeout 280 npm run typecheck` clean; `timeout 400 npx vitest run tests/web-hub/hub/feishu/{split,render,outbox}.test.ts tests/web-hub/boundary.test.ts` — 4 files, 206 passed; prettier clean.

## Re-verification (r_ZJ16HJ6C, GLM — conditional pass, 0 blockers)

F1–F6 confirmed fixed (F1/F2/F3 mutation-protected). Carried forward:

- **F8 contract**: `SettledGroup.swept > 0` must be surfaced (log + a 「n 部分无法核实」 note on the reply/notice), never treated as silently delivered. After a restart a swept failed part and a swept sent part are indistinguishable — accepted residual.
- Test gap (accepted): no test pins `renderNotice`'s verify-and-shrink loop (the worst-case probe stays under the cap even without it; the loop is defence in depth).
