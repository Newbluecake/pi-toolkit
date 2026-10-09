/**
 * web-hub content preview — the PROBE pipeline's pure logic (web-hub-preview 2026-10-07 修订
 * 「先探测后标记」, package PV4b). No DOM, no I/O, no Vue: every function runs unchanged under
 * vitest (node) and in the browser, same discipline as `./preview.js`/`./control.js`.
 *
 * - `PreviewProbeStore` — the per-scopeKey result cache + pending ledger. States per
 *   `(scopeKey, path)`: `"pending"` (a probe carrying it is in flight) → `"confirmed"` (the
 *   backend admitted it and sniffed text/image ⇒ render the clickable ref; sticky — LRU
 *   eviction is the only way a confirmed entry leaves) / `"missing"` (nothing there ⇒ stay
 *   plain text) / `"failed"` (the REQUEST itself failed — network/timeout/5s deadline/
 *   non-200 ⇒ degrade the whole batch to plain text). 2026-10-09 fix (user report
 *   `/tmp/cmdprev/cmd-badge-options.png` created mid-session): negative results EXPIRE — a
 *   `missing` entry is re-probe-able after `PROBE_MISSING_TTL_MS` (10 s), a `failed` one
 *   after `PROBE_FAILED_TTL_MS` (30 s). In an agent session a path very often appears first
 *   in the tool call that is about to CREATE it (probe ⇒ missing); a later mention in the
 *   same session (assistant text, user bubble) then re-probes once the TTL has passed,
 *   instead of staying plain text forever. Anti-retry-storm: expiry is pull-driven only
 *   (`markPending` during a flush — the composable has NO retry timer), an in-flight
 *   re-probe sets a `probing` mark so the same path is never double-submitted, and `get`
 *   keeps reporting the OLD negative state until the fresh answer settles (no flicker).
 *   Scope isolation is structural: the key carries `agentKey|sessionId|cwd` (`scopeKeyOf`),
 *   so switching session/cwd never sees stale entries — old results simply age out of the
 *   LRU. The cache is bounded LRU, cap `PROBE_LRU_CAP` (~256 entries across ALL scopes),
 *   touch-on-read. The clock is injectable (`deps.now`, default `Date.now`) — tests drive a
 *   fake clock; no real timers anywhere in this module.
 * - `planProbeBatches(paths)` — split a staged path list into wire batches honouring the
 *   server's two caps (`PREVIEW_PROBE_MAX_PATHS` entries / the 8 KiB BODY budget, with
 *   envelope headroom): byte lengths are REAL UTF-8 (`TextEncoder`), not UTF-16 units — a
 *   CJK path is 3 bytes per character on the wire.
 * - `parseProbeResults(raw, expectedCount)` — the `POST /api/preview/probe` 200-body
 *   contract: `{results:[{kind}…]}`, same length and order as the request. The kind set is
 *   `PREVIEW_PROBE_KINDS` — dir-plan §1.3's SINGLE SOURCE ("text" | "image" | "dir" |
 *   "missing"), imported from the protocol; this parser judges membership with the tuple's
 *   `.includes()` and declares no local literal union of its own. A `"dir"` answer is legal
 *   ONLY for a request that sent `dirs: true`; a dirs-less client folds it per-entry to
 *   `"missing"` in ITS layer (the logic clients' `probePost`, §1.3's single fold point).
 *   ANY other deviation is `E_BAD_RESPONSE` (the caller fails the whole batch — the hub is
 *   out of contract, not the paths).
 *
 * Runtime imports use the literal `.ts` extension for the same reason `./preview.js`
 * documents (esbuild only remaps `./foo.js` for `.ts`/`.vue` importers).
 */
import { PREVIEW_PROBE_KINDS, PREVIEW_PROBE_MAX_BODY_BYTES, PREVIEW_PROBE_MAX_PATHS } from "@protocol/preview.ts";
import { scopeKeyOf } from "./preview.js";

/** LRU cap for probe results (2026-10-07 spec: ~256 entries, keyed per scopeKey+path). */
export const PROBE_LRU_CAP = 256;

/** 2026-10-09: a `missing` entry becomes re-probe-able once this much time has passed since
 * its SETTLE (the file may have been created by the tool call that first mentioned it). */
export const PROBE_MISSING_TTL_MS = 10_000;

/** 2026-10-09: a `failed` entry becomes re-probe-able after this long (longer than missing:
 * a failed REQUEST is the hub/network being unhealthy, not a file appearing). This is also
 * the anti-retry-storm floor — repeated `ensure()` submits inside the window are no-ops. */
export const PROBE_FAILED_TTL_MS = 30_000;

/** Byte budget for one batch's serialized paths — the 8 KiB BODY cap minus envelope
 * headroom (JSON braces, `"paths":[…]`, quotes/commas; each path also gets a small per-entry
 * allowance inside `planProbeBatches`). */
export const PROBE_BATCH_BYTES = PREVIEW_PROBE_MAX_BODY_BYTES - 512;

/** @typedef {"pending" | "confirmed" | "missing" | "failed"} PreviewProbeState */
/** dir-plan §1.3: the wire kind set is the protocol tuple's element type — the single source. */
/** @typedef {(typeof PREVIEW_PROBE_KINDS)[number]} PreviewProbeKindT */

const textEncoder = new TextEncoder();

/**
 * Split staged paths into wire batches: ≤ `maxPaths` entries each (server 400s above
 * `PREVIEW_PROBE_MAX_PATHS`) and ≤ `maxBytes` of estimated BODY bytes (server 413s above
 * the 8 KiB body cap). A single path longer than the whole budget still forms its own batch
 * (the UI's candidates are protocol-capped at 4096 bytes, so this never trips in practice;
 * if it ever does, the server 413 fails that batch and its entries degrade to plain text).
 * @param {readonly string[]} paths
 * @param {{ maxPaths?: number, maxBytes?: number }} [opts]
 * @returns {string[][]}
 */
export function planProbeBatches(paths, opts) {
  const maxPaths = opts !== undefined && typeof opts.maxPaths === "number" ? opts.maxPaths : PREVIEW_PROBE_MAX_PATHS;
  const maxBytes = opts !== undefined && typeof opts.maxBytes === "number" ? opts.maxBytes : PROBE_BATCH_BYTES;
  const batches = [];
  /** @type {string[]} */
  let cur = [];
  let curBytes = 0;
  for (const p of paths) {
    // 4 = two JSON quotes + comma + slack; the envelope headroom covers the rest.
    const bytes = textEncoder.encode(p).length + 4;
    if (cur.length >= maxPaths || (cur.length > 0 && curBytes + bytes > maxBytes)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(p);
    curBytes += bytes;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/**
 * The 200-body contract (see header). Pure; never throws.
 * @param {unknown} raw @param {number} expectedCount
 * @returns {{ ok: true, kinds: PreviewProbeKindT[] } | { ok: false, error: "E_BAD_RESPONSE" }}
 */
export function parseProbeResults(raw, expectedCount) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "E_BAD_RESPONSE" };
  const results = /** @type {{ results?: unknown }} */ (raw).results;
  if (!Array.isArray(results) || results.length !== expectedCount) return { ok: false, error: "E_BAD_RESPONSE" };
  /** @type {PreviewProbeKindT[]} */
  const kinds = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return { ok: false, error: "E_BAD_RESPONSE" };
    const kind = /** @type {{ kind?: unknown }} */ (entry).kind;
    // dir-plan §1.3: judge by the protocol's single-source tuple — never a hand-written union.
    if (typeof kind !== "string" || !PREVIEW_PROBE_KINDS.includes(kind)) return { ok: false, error: "E_BAD_RESPONSE" };
    kinds.push(kind);
  }
  return { ok: true, kinds };
}

const lruKey = (scopeKey, path) => `${scopeKey}\u0000${path}`;

/**
 * The probe result store. Plain data + plain methods — the Vue-facing composable
 * (`composables/usePreviewProbe.ts`) wraps mutations and re-reads after each one, so this
 * class stays importable from node tests with zero Vue on the module graph.
 *
 * Entry shape (LRU value): `{ state, at, probing? }` — `at` is the SETTLE time the negative
 * TTL counts from (pending/confirmed entries never read it); `probing: true` marks an
 * expired negative whose re-probe is in flight (the entry keeps reporting the old negative
 * state — no flicker — and `markPending` skips it so it is never double-submitted).
 * @typedef {{ state: "pending" | "confirmed" | "missing" | "failed", at: number, probing?: true }} ProbeEntry
 */
export class PreviewProbeStore {
  /**
   * @param {number} [cap]
   * @param {{ now?: () => number }} [deps] — injectable clock (2026-10-09 negative-TTL fix);
   * default `Date.now`. No real timers anywhere in this module.
   */
  constructor(cap = PROBE_LRU_CAP, deps) {
    this.cap = Math.max(1, cap);
    this.now = deps !== undefined && typeof deps.now === "function" ? deps.now : Date.now;
    /** @type {Map<string, ProbeEntry>} */
    this.states = new Map();
  }

  /** Entry count across all scopes (test surface). */
  get size() {
    return this.states.size;
  }

  /**
   * Current state of `(scopeKey, path)`; `undefined` = never staged (the composable then
   * queues a probe). A read touches the LRU. Deliberately NOT expiry-aware: an expired
   * negative keeps reporting its old state until the fresh probe settles (no flicker).
   * @param {string} scopeKey @param {string} path
   * @returns {PreviewProbeState | undefined}
   */
  get(scopeKey, path) {
    const k = lruKey(scopeKey, path);
    const v = this.states.get(k);
    if (v !== undefined) {
      this.states.delete(k);
      this.states.set(k, v);
    }
    return v !== undefined ? v.state : undefined;
  }

  /**
   * Mark `paths` pending and return ONLY the ones the caller should send — dedup within the
   * call too. Never-probed paths stage `"pending"` (their in-flight guard, as before).
   * Confirmed and in-window negative entries are skipped (touch only). An EXPIRED negative
   * (`missing` ≥ `PROBE_MISSING_TTL_MS` / `failed` ≥ `PROBE_FAILED_TTL_MS` old, counted from
   * its settle time) is re-staged: a `probing` mark goes on the entry (its reported state
   * stays the old negative until the fresh answer settles) and the path is returned fresh.
   * An already-`probing` entry is skipped — a path is never double-submitted while any
   * probe for it is in flight.
   * @param {string} scopeKey @param {readonly string[]} paths
   * @returns {string[]}
   */
  markPending(scopeKey, paths) {
    const now = this.now();
    /** @type {string[]} */
    const fresh = [];
    for (const p of paths) {
      const k = lruKey(scopeKey, p);
      const cur = this.states.get(k);
      if (cur === undefined) {
        this.states.set(k, { state: "pending", at: now });
        fresh.push(p);
        continue;
      }
      // present: touch (LRU recency) in every branch
      this.states.delete(k);
      this.states.set(k, cur);
      if (cur.state === "pending" || cur.state === "confirmed") continue;
      const ttl = cur.state === "missing" ? PROBE_MISSING_TTL_MS : PROBE_FAILED_TTL_MS;
      if (now - cur.at < ttl || cur.probing === true) continue; // in-window or already re-probing
      cur.probing = true; // keep reporting the old negative state until settle (no flicker)
      fresh.push(p);
    }
    this.evict();
    return fresh;
  }

  /**
   * Fold one settled batch: entry kinds in request order (`"missing"` stays missing; text,
   * image and dir all confirm — the UI does not branch on the kind, only on confirmability).
   * `at` restarts the negative TTL clock from THIS answer (the freshest evidence wins).
   * @param {string} scopeKey @param {readonly string[]} paths @param {readonly PreviewProbeKindT[]} kinds
   */
  settle(scopeKey, paths, kinds) {
    for (let i = 0; i < paths.length; i++) {
      const kind = kinds[i];
      this.set(scopeKey, paths[i], kind === "missing" ? "missing" : "confirmed");
    }
  }

  /**
   * Fold a FAILED request (transport error / timeout / non-200 / malformed body): every entry
   * of the batch degrades to `"failed"` — rendered exactly like plain text (2026-10-07 修
   * 订: 探测失败不阻塞渲染，全部按纯文本), now with the failed TTL clock restarted.
   * @param {string} scopeKey @param {readonly string[]} paths
   */
  fail(scopeKey, paths) {
    for (const p of paths) this.set(scopeKey, p, "failed");
  }

  /** @param {string} scopeKey @param {string} path @param {PreviewProbeState} state */
  set(scopeKey, path, state) {
    const k = lruKey(scopeKey, path);
    this.states.delete(k);
    this.states.set(k, { state, at: this.now() }); // a fresh answer always clears `probing`
    this.evict();
  }

  evict() {
    while (this.states.size > this.cap) {
      const oldest = this.states.keys().next();
      if (oldest.done === true) break;
      this.states.delete(oldest.value);
    }
  }
}

export { scopeKeyOf };
