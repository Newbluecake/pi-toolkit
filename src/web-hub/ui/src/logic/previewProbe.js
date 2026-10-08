/**
 * web-hub content preview — the PROBE pipeline's pure logic (web-hub-preview 2026-10-07 修订
 * 「先探测后标记」, package PV4b). No DOM, no I/O, no Vue: every function runs unchanged under
 * vitest (node) and in the browser, same discipline as `./preview.js`/`./control.js`.
 *
 * - `PreviewProbeStore` — the per-scopeKey result cache + pending ledger. States per
 *   `(scopeKey, path)`: `"pending"` (a probe carrying it is in flight) → `"confirmed"` (the
 *   backend admitted it and sniffed text/image ⇒ render the clickable ref) / `"missing"`
 *   (nothing there ⇒ stay plain text forever) / `"failed"` (the REQUEST itself failed —
 *   network/timeout/5s deadline/non-200 ⇒ degrade the whole batch to plain text; never a
 *   retry storm: a failed entry is terminal exactly like missing, only a scope change — a
 *   different scopeKey — probes again). Scope isolation is structural: the key carries
 *   `agentKey|sessionId|cwd` (`scopeKeyOf`), so switching session/cwd never sees stale
 *   entries — old results simply age out of the LRU. The cache is bounded LRU, cap
 *   `PROBE_LRU_CAP` (~256 entries across ALL scopes), touch-on-read.
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
 */
export class PreviewProbeStore {
  /** @param {number} [cap] */
  constructor(cap = PROBE_LRU_CAP) {
    this.cap = Math.max(1, cap);
    /** @type {Map<string, PreviewProbeState>} */
    this.states = new Map();
  }

  /** Entry count across all scopes (test surface). */
  get size() {
    return this.states.size;
  }

  /**
   * Current state of `(scopeKey, path)`; `undefined` = never staged (the composable then
   * queues a probe). A read touches the LRU.
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
    return v;
  }

  /**
   * Mark `paths` pending and return ONLY the ones that were previously unknown (dedup within
   * the call too) — exactly the paths the caller should send. Already pending paths stay
   * pending (their request is in flight); terminal states are never re-probed.
   * @param {string} scopeKey @param {readonly string[]} paths
   * @returns {string[]}
   */
  markPending(scopeKey, paths) {
    /** @type {string[]} */
    const fresh = [];
    for (const p of paths) {
      const k = lruKey(scopeKey, p);
      if (this.states.has(k)) {
        this.get(scopeKey, p); // touch
        continue;
      }
      this.states.set(k, "pending");
      fresh.push(p);
    }
    this.evict();
    return fresh;
  }

  /**
   * Fold one settled batch: entry kinds in request order (`"missing"` stays missing; text,
   * image and dir all confirm — the UI does not branch on the kind, only on confirmability).
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
   * 订: 探测失败不阻塞渲染，全部按纯文本).
   * @param {string} scopeKey @param {readonly string[]} paths
   */
  fail(scopeKey, paths) {
    for (const p of paths) this.set(scopeKey, p, "failed");
  }

  /** @param {string} scopeKey @param {string} path @param {PreviewProbeState} state */
  set(scopeKey, path, state) {
    const k = lruKey(scopeKey, path);
    this.states.delete(k);
    this.states.set(k, state);
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
