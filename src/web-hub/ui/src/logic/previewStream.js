/**
 * Chunked text-preview streaming (web-hub-preview chunked-plan §4.2/§4.3, package P2a) —
 * DOM-free, I/O-free pure logic: two segmenters (markdown / source) and the stream state
 * machine's transition functions (`nextChunkAction` / `classifyChunkOutcome`). The
 * composable (`usePreview.ts`, P2b) owns all mutable wiring; everything here is unit-tested
 * in node (`tests/web-hub/ui/logic-preview-stream.test.ts`).
 *
 * Segment objects are plain data with a monotone `id` (the component applies `markRaw` and
 * keys `v-for` on it so old segments are never re-patched). Nothing here imports Vue.
 */
import { markdownFenceMarker, parseMarkdown, scanMarkdownTail } from "./markdown.js";
import { countMdNodes, PREVIEW_MD_NODE_MAX } from "./preview.js";
import { PREVIEW_CHUNK_MIN_GAP_MS } from "@protocol/preview.ts";

/** §4.3.3: the markdown segmenter's pending buffer is force-cut beyond this many CHARS
 *  (≈1 MiB of UTF-16) when no safe top-level-blank cut exists. */
export const PREVIEW_MD_PENDING_MAX = 512 * 1024;

/** §4.3.2/D8: GLOBAL rendered-node budget for a markdown stream — once the running total
 *  would exceed it, this and EVERY later segment degrades to source (sticky, never flips
 *  back), bounding the dialog's total DOM. */
export const PREVIEW_MD_STREAM_NODE_MAX = 160_000;

/** §4.3.4: the source segmenter's force-cut threshold (chars) — only reachable on a single
 *  line longer than this (any earlier `\n` with a non-`\n` predecessor is a legal cut). */
export const SOURCE_FORCE_CHARS = 512 * 1024;

/** §4.2: a continuation failure streak is auto-retried (429/503, Retry-After spaced) at most
 *  this many times in a row; ANY success or a manual 重试 resets the counter (r2, #2). */
export const STREAM_AUTO_RETRY_MAX = 3;

/** §4.2: a 429/503 without a usable `Retry-After` waits this many seconds. */
export const STREAM_RETRY_DEFAULT_S = 1;

/* ---------------------------------------------------------------------------
 * §4.3.4 createSourceSegmenter — the r2 final cut rule. Each rendered segment is a block
 * `pre-wrap` element whose boundary REPLACES exactly one consumed "\n", so segmented
 * rendering is line-identical to a single `<pre>` IFF every non-final segment is non-empty
 * and does NOT end with "\n" (a trailing newline inside a block is swallowed; a leading one
 * renders as a stable blank line). Cut point `p`: the LAST "\n" in pending with `p > 0` whose
 * segment's last line, minus its trailing "\r"s, is non-empty (r3: "\r\n" is one terminator —
 * an empty CRLF line must never end a segment, Blink swallows it). `pending` is the RAW text
 * (never normalized — copy fidelity).
 *
 * Segment shape: { id, text, sep, forced?, final? } — the consumed text is
 * `segments.map(s => s.text + s.sep).join("")`, STRICTLY equal to the input (forced cuts
 * included: `sep:""` means no newline was consumed at the boundary).
 * ------------------------------------------------------------------------- */

/**
 * @typedef {{ id: number, text: string, sep: string, forced?: true, final?: true }} SourceSegment
 */

/**
 * §4.3.4. `push(text)` appends raw text and returns the (possibly empty) array of segments
 * that became cuttable; `flush("eof" | "stop")` emits the whole pending remainder as one
 * `final` segment (both modes identical — the source view has always shown a partial last
 * line; a `final` segment MAY end with "\n" or consist of newlines only, matching a single
 * `<pre>`'s tail behavior). A pending that is all newlines (no legal cut) is HELD until
 * more text or a flush arrives; the force cut requires at least one non-CR/LF char, so an
 * all-newline pending is never force-cut (its length stays bounded by the stream cap).
 * @param {{ forceChars?: number }} [opts]
 */
export function createSourceSegmenter(opts) {
  const forceChars =
    opts !== undefined && typeof opts.forceChars === "number" && opts.forceChars > 0
      ? opts.forceChars
      : SOURCE_FORCE_CHARS;
  let pending = "";
  let nextId = 1;
  /**
   * r3 (CRLF): `\r\n` is ONE line terminator — a legal cut `\n` at `p` needs the segment's LAST
   * line, with its trailing `\r`s removed, to be non-empty: Blink swallows a block-final line
   * that is empty-but-for-CR (it renders no height), so cutting after an empty CRLF line would
   * lose that blank line vs. a single `<pre>`.
   * @param {number} p index of a "\n" in pending, p > 0
   */
  function legalCut(p) {
    let q = p - 1;
    while (q >= 0 && pending[q] === "\r") q--;
    return q >= 0 && pending[q] !== "\n";
  }

  /** @returns {SourceSegment[]} */
  function take() {
    let p = pending.lastIndexOf("\n");
    while (p > 0 && !legalCut(p)) p = pending.lastIndexOf("\n", p - 1); // skip illegal cuts
    if (p > 0) {
      const seg = /** @type {SourceSegment} */ { id: nextId++, text: pending.slice(0, p), sep: "\n" };
      pending = pending.slice(p + 1); // a remainder starting with "\n" ⇒ next block opens blank
      return [seg];
    }
    if (pending.length > forceChars && /[^\r\n]/.test(pending)) {
      // No legal cut but a non-newline char exists ⇒ pending is `\n*` + one long newline-free
      // run (its last char is never "\n"). Force-cut the WHOLE pending; `sep:""` records that
      // no newline was consumed (the line visually wraps at the boundary — accepted, §4.3.4).
      const seg = /** @type {SourceSegment} */ { id: nextId++, text: pending, sep: "", forced: true };
      pending = "";
      return [seg];
    }
    return [];
  }
  return {
    /** @param {string} text @returns {SourceSegment[]} */
    push(text) {
      pending += typeof text === "string" ? text : "";
      return take();
    },
    /**
     * @param {"eof" | "stop"} mode
     * @returns {SourceSegment[]} the final segment, or [] when nothing is pending
     */
    flush(mode) {
      void mode; // §4.3.4: "eof" and "stop" behave identically for source text
      if (pending === "") return [];
      const seg = /** @type {SourceSegment} */ { id: nextId++, text: pending, sep: "", final: true };
      pending = "";
      return [seg];
    },
    /** Test/introspection surface: chars currently held back. */
    get pendingLength() {
      return pending.length;
    },
  };
}

/* ---------------------------------------------------------------------------
 * §4.3.3 createMarkdownSegmenter — cuts only where `scanMarkdownTail` reports a top-level
 * boundary, so (property-tested) `segments.flatMap(parse) ≡ parse(whole)`. Input chunks are
 * normalized `\r\n?`→`\n` with a trailing `\r` HELD across the chunk boundary (a split
 * CRLF must not become two newlines). Force cuts (pending > PREVIEW_MD_PENDING_MAX with no
 * safe cut): inside an unclosed fence the segment is closed with the fence marker and the
 * pending re-opened with it (the giant code block shows as two adjacent blocks); otherwise
 * at the last complete line (`forced`); a single >1MiB line with no "\n" at all goes out as
 * a `src` segment with `reason:"forced"`.
 *
 * Segment shape:
 *   { id, kind: "md", nodes, forced?, tailIncomplete?, final? }
 *   { id, kind: "src", reason: "node-budget" | "total-budget" | "forced", text, ...same flags }
 * ------------------------------------------------------------------------- */

/**
 * @typedef {{ id: number, kind: "md", nodes: unknown[], forced?: true, tailIncomplete?: true, final?: true }
 *   | { id: number, kind: "src", reason: string, text: string, forced?: true, tailIncomplete?: true,
 *       final?: true }} MdSegment
 */

/**
 * §4.3.3. Budgets are injectable for tests: `pendingMax` (force-cut threshold, chars),
 * `nodeMax` (per-segment AST budget, default `PREVIEW_MD_NODE_MAX` via countMdNodes),
 * `totalNodeMax` (sticky global rendered-node budget, §4.3.2/D8).
 * @param {{ pendingMax?: number, nodeMax?: number, totalNodeMax?: number }} [opts]
 */
export function createMarkdownSegmenter(opts) {
  const pendingMax =
    opts !== undefined && typeof opts.pendingMax === "number" && opts.pendingMax > 0
      ? opts.pendingMax
      : PREVIEW_MD_PENDING_MAX;
  const nodeMax =
    opts !== undefined && typeof opts.nodeMax === "number" && opts.nodeMax > 0 ? opts.nodeMax : PREVIEW_MD_NODE_MAX;
  const totalNodeMax =
    opts !== undefined && typeof opts.totalNodeMax === "number" && opts.totalNodeMax > 0
      ? opts.totalNodeMax
      : PREVIEW_MD_STREAM_NODE_MAX;
  let pending = ""; // normalized text; never carries the held trailing "\r"
  let heldCR = false; // a chunk-trailing "\r" awaiting a possible "\n" in the next chunk
  let renderedTotal = 0;
  let stickySource = false;
  let nextId = 1;

  /**
   * Per-segment node budgets (D8). @param {string} text
   * @param {{ forced?: true, tailIncomplete?: true, final?: true }} [flags]
   * @returns {MdSegment}
   */
  function emit(text, flags) {
    const f = flags ?? {};
    if (stickySource) {
      return { id: nextId++, kind: "src", reason: "total-budget", text, ...f };
    }
    const nodes = /** @type {unknown[]} */ (parseMarkdown(text));
    const n = countMdNodes(nodes, nodeMax + 1);
    if (n > nodeMax) {
      return { id: nextId++, kind: "src", reason: "node-budget", text, ...f };
    }
    if (renderedTotal + n > totalNodeMax) {
      stickySource = true;
      return { id: nextId++, kind: "src", reason: "total-budget", text, ...f };
    }
    renderedTotal += n;
    return { id: nextId++, kind: "md", nodes, ...f };
  }

  return {
    /**
     * @param {string} chunkText
     * @returns {MdSegment[]} at most one segment per push (§4.3.3: the remainder stays pending)
     */
    push(chunkText) {
      let raw = (heldCR ? "\r" : "") + (typeof chunkText === "string" ? chunkText : "");
      heldCR = false;
      if (raw.endsWith("\r")) {
        heldCR = true; // a split CRLF must not normalize into two newlines
        raw = raw.slice(0, -1);
      }
      pending += raw.replace(/\r\n?/g, "\n");
      const scan = scanMarkdownTail(pending);
      if (scan.cut > 0) {
        const text = pending.slice(0, scan.cut);
        pending = pending.slice(scan.cut);
        return [emit(text)];
      }
      if (pending.length > pendingMax) {
        if (scan.openFence !== null) {
          // Close the giant block at the last complete line, re-open it in the new pending —
          // the two code blocks' texts concatenate back to the original (§4.3.5 case 9).
          const marker = markdownFenceMarker(scan.openFence) ?? "```";
          const text = pending.slice(0, scan.lineEnd) + marker + "\n";
          pending = scan.openFence + "\n" + pending.slice(scan.lineEnd);
          return [emit(text, { forced: true })];
        }
        if (scan.lineEnd > 0) {
          const text = pending.slice(0, scan.lineEnd);
          pending = pending.slice(scan.lineEnd);
          return [emit(text, { forced: true })];
        }
        // One >1MiB line without any "\n": out as source verbatim (§4.3.3).
        const seg = /** @type {MdSegment} */ {
          id: nextId++,
          kind: "src",
          reason: "forced",
          text: pending,
          forced: true,
        };
        pending = "";
        return [seg];
      }
      return [];
    },
    /**
     * §4.3.3 flush: `"eof"` (stream done) emits the whole pending — exact; `"stop"` (cap /
     * changed) drops the incomplete last line (B5 semantics via `lineEnd`; kept verbatim
     * when there is no complete line) and marks the segment `tailIncomplete`. The `error`
     * state never flushes (pending survives for the retry continuation).
     * @param {"eof" | "stop"} mode
     * @returns {MdSegment[]}
     */
    flush(mode) {
      if (heldCR) {
        // A lone trailing "\r" normalizes to "\n" under the whole-text rule — fold it for
        // "eof"; under "stop" the incomplete tail is dropped anyway.
        if (mode === "eof") pending += "\n";
        heldCR = false;
      }
      if (pending === "") return [];
      if (mode === "eof") {
        const text = pending;
        pending = "";
        return [emit(text, { final: true })];
      }
      const scan = scanMarkdownTail(pending);
      const text = scan.lineEnd > 0 ? pending.slice(0, scan.lineEnd) : pending;
      pending = "";
      return [emit(text, { tailIncomplete: true, final: true })];
    },
    /** Test/introspection surface: chars currently held back (excluding a held "\r"). */
    get pendingLength() {
      return pending.length;
    },
  };
}

/* ---------------------------------------------------------------------------
 * §4.2 stream state machine — the pure transition functions. `usePreview` (P2b) owns the
 * mutable `PreviewTextStream`, the timers and the AbortController; these functions only
 * decide. Decisions:
 *   nextChunkAction → { type: "load", resetRetries? } | { type: "schedule", delayMs } | { type: "none" }
 *   classifyChunkOutcome → { state, append?, loaded?, autoRetries?, retryAfterS?, error?,
 *     retryable? } | { close: true } | { drop: true }
 * ------------------------------------------------------------------------- */

/**
 * @typedef {{ state: "more" | "loading" | "waiting" | "done" | "cap" | "changed" | "error",
 *   loaded: number, total: number, cap: number, autoRetries: number,
 *   error?: string, retryable?: boolean }} StreamStateLike
 */

/**
 * §4.2 `loadMore()` decision. `lastEndedAt` is when the previous continuation SETTLED
 * (ms clock of the caller's choice). From `more`: load immediately when the ≥300 ms gap has
 * passed and `loaded < min(total, cap)`; otherwise schedule ONE coalescing timer for the
 * remaining gap (the caller re-invokes `nextChunkAction` when it fires). `loading`/`waiting`
 * are no-ops (single-flight), `done`/`cap`/`changed` are terminal. From `error` a MANUAL
 * retry (the 重试 button) is allowed only when `retryable`, and resets the auto-retry
 * streak (r2, #2).
 * @param {StreamStateLike} s @param {number} now @param {number} lastEndedAt
 * @returns {{ type: "load", resetRetries?: boolean } | { type: "schedule", delayMs: number } | { type: "none" }}
 */
export function nextChunkAction(s, now, lastEndedAt) {
  if (s.state === "more") {
    if (!(s.loaded < Math.min(s.total, s.cap))) return { type: "none" };
    const wait = PREVIEW_CHUNK_MIN_GAP_MS - (now - lastEndedAt);
    return wait <= 0 ? { type: "load" } : { type: "schedule", delayMs: wait };
  }
  if (s.state === "error" && s.retryable === true) return { type: "load", resetRetries: true };
  return { type: "none" };
}

/**
 * §4.2 continuation-outcome classification. `o` is the transport's `PreviewOutcome` for the
 * continuation request (headers already validated by `checkPreviewHeaders`'s chunk branch —
 * an offset/ident echo mismatch never reaches here). Any success resets `autoRetries` to 0
 * (r2, #2). `append` carries the decoded chunk for the caller to push into the stream's
 * `chunks`; `loaded` is the new byte total. Inconsistent 200s never append: `size !== total`
 * ⇒ changed; `bytes === 0 && truncated` ⇒ non-retryable error (protocol violation, the
 * hub's advance rule makes it unreachable); `!truncated && loaded !== total` ⇒ changed.
 * @param {StreamStateLike} s
 * @param {any} o
 * @returns {{ state: string, append?: { text: string, bytes: number }, loaded?: number,
 *   autoRetries?: number, retryAfterS?: number, error?: string, retryable?: boolean }
 *   | { close: true } | { drop: true }}
 */
export function classifyChunkOutcome(s, o) {
  if (o !== null && typeof o === "object" && o.ok === true) {
    if (o.kind !== "text") return { state: "error", error: "E_BAD_RESPONSE", retryable: false };
    if (o.size !== s.total) return { state: "changed" };
    const bytes = typeof o.bytes === "number" && Number.isInteger(o.bytes) && o.bytes >= 0 ? o.bytes : -1;
    if (bytes < 0) return { state: "error", error: "E_BAD_RESPONSE", retryable: false };
    const loaded = s.loaded + bytes;
    if (o.truncated !== true) {
      if (bytes === 0 && s.loaded !== s.total) return { state: "changed" };
      if (loaded !== s.total) return { state: "changed" };
      return { state: "done", append: { text: o.text, bytes }, loaded, autoRetries: 0 };
    }
    if (bytes === 0) return { state: "error", error: "E_BAD_RESPONSE", retryable: false };
    const append = { text: o.text, bytes };
    if (loaded >= s.cap) return { state: "cap", append, loaded, autoRetries: 0 };
    return { state: "more", append, loaded, autoRetries: 0 };
  }
  const err = o !== null && typeof o === "object" && typeof o.error === "string" ? o.error : "E_NETWORK";
  const status = o !== null && typeof o === "object" && typeof o.status === "number" ? o.status : 0;
  if (err === "E_ABORT") return { drop: true }; // cancellation: the controller already moved on
  if (err === "E_SESSION_CHANGED") return { close: true };
  if (err === "E_PREVIEW_CHANGED" || status === 404 || status === 415) return { state: "changed" };
  if (status === 429 || status === 503 || err === "E_RATE" || err === "E_BUSY" || err === "E_HUB_RESTARTING") {
    if (s.autoRetries < STREAM_AUTO_RETRY_MAX) {
      const ra =
        o !== null && typeof o === "object" && typeof o.retryAfterS === "number" && o.retryAfterS >= 0
          ? o.retryAfterS
          : STREAM_RETRY_DEFAULT_S;
      return { state: "waiting", retryAfterS: ra, autoRetries: s.autoRetries + 1 };
    }
    return { state: "error", error: err, retryable: true };
  }
  if (status === 400 || status === 403 || err === "E_BAD_RESPONSE" || err === "E_BAD_REQUEST") {
    return { state: "error", error: err, retryable: false };
  }
  // E_DEADLINE / E_NETWORK / 500 (and any other 5xx) / E_AUTH: retryable error (§4.2).
  return { state: "error", error: err, retryable: true };
}
