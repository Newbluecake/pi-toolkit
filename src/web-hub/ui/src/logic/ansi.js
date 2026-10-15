/**
 * ANSI escape-sequence stripping for text preview (web-hub-preview L1 fix, 2026-10-15) —
 * DOM-free, dependency-free pure logic. Terminal logs (`/tmp/*.log` written by colorizing
 * tools) are full of CSI SGR sequences (`\x1b[36m==>\x1b[0m`); rendering them raw shows
 * `[36m` garbage, so the preview DISPLAY and COPY paths strip before rendering (download
 * keeps the original bytes — PreviewHost refetches those). The grammar follows ECMA-48/xterm:
 *
 *   CSI      `ESC [` · 0x20–0x3F parameter/intermediate bytes · final 0x40–0x7E
 *   string   `ESC ]` (OSC) / `ESC P` (DCS) / `ESC X` / `ESC ^` / `ESC _` · payload · BEL or ST (`ESC \`)
 *   2-byte   `ESC` · final 0x30–0x7E; nF: `ESC` · 0x20–0x2F intermediates · final 0x30–0x7E
 *
 * A sequence aborted by an out-of-grammar byte (e.g. a `\n` inside a CSI) is dropped up to
 * (NOT including) that byte; a string sequence whose payload exceeds ANSI_STRING_MAX without
 * a terminator is capped and dropped (xterm discards oversized strings too — a stray `ESC ]`
 * in ordinary text must never swallow the rest of the file). A sequence that runs off the END
 * of the input is "incomplete": `stripAnsi` drops it, while `createAnsiStripper` HOLDS it as
 * a carry so a sequence split across chunked-preview segment boundaries (chunked-plan #23's
 * cuts land on arbitrary bytes) is stripped as a whole — never leaving `[36m` residue in the
 * next segment.
 */

const ESC = 0x1b;

/** Unterminated string-sequence (OSC/DCS/…) payload cap, in CHARS. */
export const ANSI_STRING_MAX = 4096;

/**
 * Classify the escape sequence starting at `s[i] === ESC`.
 * @returns `{ end, full: true }` — a complete sequence covering `[i, end)`;
 *          `{ end, full: false }` — aborted at `s[end]` (an out-of-grammar byte that stays
 *          in the text) after consuming `[i, end)`;
 *          `null` — runs off the end of `s` while still incomplete (caller must hold).
 */
function scanSeq(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null; // dangling ESC — may gain an introducer in the next chunk
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 0x5b /* [ */) {
    // CSI: parameter/intermediate bytes 0x20–0x3F, then a final byte 0x40–0x7E.
    let j = i + 2;
    while (j < n) {
      const p = s.charCodeAt(j);
      if (p >= 0x20 && p <= 0x3f) {
        j += 1;
        continue;
      }
      if (p >= 0x40 && p <= 0x7e) return { end: j + 1, full: true };
      return { end: j, full: false }; // aborted by e.g. "\n" — that byte stays
    }
    return null;
  }
  if (c1 === 0x5d /* ] */ || c1 === 0x50 /* P */ || c1 === 0x58 /* X */ || c1 === 0x5e /* ^ */ || c1 === 0x5f /* _ */) {
    // String sequence: payload of anything-but-BEL/ESC, terminated by BEL or ST (`ESC \`).
    let j = i + 2;
    let payload = 0;
    while (j < n) {
      if (payload >= ANSI_STRING_MAX) return { end: j, full: false }; // capped — resume at s[j]
      const p = s.charCodeAt(j);
      if (p === 0x07) return { end: j + 1, full: true };
      if (p === ESC) {
        if (j + 1 >= n) return null; // dangling ESC may open the ST — hold
        return s.charCodeAt(j + 1) === 0x5c ? { end: j + 2, full: true } : { end: j, full: false }; // ST / abort
      }
      j += 1;
      payload += 1;
    }
    return null;
  }
  if (c1 >= 0x20 && c1 <= 0x7e) {
    // Two-byte (`ESC M`) or nF (`ESC SP F`): optional 0x20–0x2F intermediates, then a final.
    let j = i + 1;
    while (j < n && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j += 1;
    if (j >= n) return null; // ESC + intermediates ran out of input
    return s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x7e ? { end: j + 1, full: true } : { end: j, full: false };
  }
  // ESC + C0 control / DEL / 8-bit byte: aborted — consume only the ESC itself.
  return { end: i + 1, full: false };
}

/**
 * One left-to-right scan: the stripped text plus `hold` — the trailing suffix that OPENS a
 * sequence but does not complete it inside `s` ("" when the input ends outside any sequence).
 * @returns {{ text: string, hold: string }}
 */
function stripScan(s) {
  if (typeof s !== "string" || s.length === 0) return { text: "", hold: "" };
  if (s.indexOf("\u001b") === -1) return { text: s, hold: "" }; // fast path — same reference
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) !== ESC) {
      out += s[i];
      i += 1;
      continue;
    }
    const r = scanSeq(s, i);
    if (r === null) return { text: out, hold: s.slice(i) };
    i = r.end;
  }
  return { text: out, hold: "" };
}

/**
 * Strip ANSI escape sequences from `s` (one-shot). An incomplete sequence at the very end is
 * dropped. Input without any ESC is returned UNCHANGED (same reference).
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  return typeof s === "string" ? stripScan(s).text : "";
}

/**
 * Chunked-stream stripper: `push(chunk)` returns the stripped prefix of `carry + chunk`,
 * holding an incomplete trailing sequence as the carry so a sequence split across chunks
 * (and hence across preview segments) strips as a whole. `flush()` closes the stream: an
 * unterminated carry is dropped (EOF semantics — a trailing incomplete sequence never
 * displays), so `flush()` always returns "".
 * @returns {{ push(chunk: string): string, flush(): string, readonly pendingLength: number }}
 */
export function createAnsiStripper() {
  let carry = "";
  return {
    push(chunk) {
      const c = typeof chunk === "string" ? chunk : "";
      const r = stripScan(carry === "" ? c : carry + c);
      carry = r.hold;
      return r.text;
    },
    flush() {
      carry = "";
      return "";
    },
    /** Test/introspection surface: chars held back (an incomplete trailing sequence). */
    get pendingLength() {
      return carry.length;
    },
  };
}
