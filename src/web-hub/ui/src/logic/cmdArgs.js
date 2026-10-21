/**
 * Web composer `/name␠` argument-completion pure helpers (web-hub-slash-args plan §6 — P3).
 * No DOM, no I/O: every function here runs unchanged under vitest (node) and in the browser,
 * same discipline as `./mention.js`/`./control.js`/`./file-mention.js`.
 *
 * The fetch itself lives in `Composer.vue` (fake-fetch-tested there); this module owns the
 * arg-zone parser (`argZone` — the "name zone vs arg zone" split `parseSlash` never made),
 * the apply semantics (`applyArgItem` — pi-tui `applyCompletion`: `value` REPLACES the whole
 * argument prefix), the pure key map (`argKeyAction` — D2: Enter applies only after an
 * explicit ↑↓ navigation), the defensive response parser (`parseCompleteResponse` — client
 * second trim of the agent's already-trimmed items), and the backstep-only result cache
 * (`argCacheGet/Set` — exact-prefix hits, NEVER local filtering: completion functions have
 * per-command semantics a `startsWith` filter would corrupt).
 *
 * Budget constants are hand-mirrored from `protocol/command-args.ts`'s `CMD_ARGS` (P0 frozen;
 * same bundler-line rule as `run-transcript.ts` — importing that module here would drag
 * `@sinclair/typebox` into the browser bundle). `tests/web-hub/ui/cmd-args-logic.test.ts`
 * pins every entry against the protocol block so the two can never drift.
 *
 * @typedef {{ name: string, argStart: number, prefix: string }} ArgZone
 * @typedef {{ value: string, label: string, description?: string, policy?: "confirm" }} ArgItem
 */

import { utf8Len } from "./upload.js";

// --- P0-frozen budgets (CMD_ARGS mirror; pinned by tests against @protocol/command-args.ts) ---
export const ARG_PREFIX_MAX_BYTES = 1024;
export const ARG_ITEM_MAX = 50;
export const ARG_ITEM_VALUE_MAX_BYTES = 512;
export const ARG_ITEM_LABEL_MAX_CHARS = 120;
export const ARG_ITEM_DESC_MAX_CHARS = 200;
export const ARG_ITEMS_TOTAL_MAX_BYTES = 16 * 1024;
export const ARG_CLIENT_TIMEOUT_MS = 3_000;
export const ARG_DEBOUNCE_MS = 150;
export const ARG_LOADING_HINT_DELAY_MS = 250;
export const ARG_CACHE_TTL_MS = 30_000;
export const ARG_CACHE_MAX = 64;
export const ARG_RATE_PAUSE_FLOOR_MS = 1_000;

/** `/name␠…` — name runs to the FIRST whitespace, the separator is exactly one U+0020 (a tab
 * never opens the zone), the prefix is everything after it (spaces inside are fine: multi-token
 * arguments). `.` never matches a newline (the single-line check above already rejects those). */
const ARG_ZONE_RE = /^\/([^\s]+) (.*)$/;

/**
 * Arg zone state (plan §6.1): defined only when
 *  - `text` starts with `/` and NOT `//` (the send-as-text escape),
 *  - the text is single-line (no `\n`/`\r`),
 *  - the caret sits at the END of the text (v1: pi's whole-prefix replacement semantics),
 *  - the name is followed by exactly one U+0020,
 *  - the prefix is ≤1 KiB UTF-8.
 * @param {unknown} text @param {number} [caret]
 * @returns {ArgZone | undefined}
 */
export function argZone(text, caret = typeof text === "string" ? text.length : -1) {
  if (typeof text !== "string" || text === "") return undefined;
  if (!text.startsWith("/") || text.startsWith("//")) return undefined;
  if (text.includes("\n") || text.includes("\r")) return undefined;
  if (typeof caret !== "number" || caret !== text.length) return undefined;
  const m = ARG_ZONE_RE.exec(text);
  if (m === null) return undefined;
  const name = m[1];
  const prefix = m[2];
  if (typeof name !== "string" || name === "") return undefined;
  if (utf8Len(prefix) > ARG_PREFIX_MAX_BYTES) return undefined;
  return { name, argStart: name.length + 2, prefix };
}

/**
 * Apply a completion item: `value` REPLACES the whole argument prefix (§2 semantics table —
 * a multi-token completion embeds the already-typed tokens). v1 only ever applies with the
 * caret at the end of a single line, so the result is the full new text.
 * @param {string} name @param {ArgItem} item
 * @returns {string}
 */
export function applyArgItem(name, item) {
  const value = typeof item?.value === "string" ? item.value : "";
  return `/${name} ${value}`;
}

/**
 * Pure key map for the arg panel (plan §6.4 + §11 D2). Returns the action, or `null` when the
 * key is not ours (falls through to the normal composer key map). IME keys are never taken
 * (isComposing / keyCode 229 — they belong to the candidate window). `Enter` applies ONLY when
 * the user has explicitly navigated with ↑↓ (`navigated`); otherwise it stays the normal
 * send/execute key. Whether a returned `"apply"` actually applies (an item exists) and whether
 * `Tab` is consumed even with zero items (focus never escapes) is the CALLER's policy.
 * @param {any} ev @param {{ navigated?: boolean }} [state]
 * @returns {"up" | "down" | "apply" | "close" | null}
 */
export function argKeyAction(ev, { navigated = false } = {}) {
  if (!ev || ev.isComposing || ev.keyCode === 229) return null;
  if (ev.key === "Escape") return "close";
  if (ev.key === "ArrowDown") return "down";
  if (ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey)) return "up";
  if (ev.key === "Tab") return "apply";
  if (ev.key === "Enter" && !ev.shiftKey && !ev.altKey && navigated) return "apply";
  return null;
}

/**
 * Defensive parse + second trim of a 200 `POST /api/command/complete` body
 * (`{ items, truncated?, source }`). Anything malformed ⇒ `undefined` (silent degrade, never
 * a throw). Per item: `value` must be a non-empty string without leading whitespace or
 * newlines and ≤512 UTF-8 bytes (over-cap items are DROPPED — truncating a completion value
 * would corrupt it); `label` ≤120 chars; `description` ≤200 chars (non-strings dropped);
 * `policy` kept only when `"confirm"` (deny items never reach the wire). Dedup by value
 * (first wins, agent-side dedup mirrored); overall ≤50 items / ≤16 KiB total, `truncated:true`
 * when either cap clipped.
 * @param {unknown} body
 * @returns {{ items: ArgItem[], truncated: boolean } | undefined}
 */
export function parseCompleteResponse(body) {
  if (body === null || typeof body !== "object") return undefined;
  const raw = body.items;
  if (!Array.isArray(raw)) return undefined;
  /** @type {ArgItem[]} */
  const items = [];
  const seen = new Set();
  let total = 0;
  let truncated = false;
  for (const r of raw) {
    if (items.length >= ARG_ITEM_MAX) {
      truncated = true;
      break;
    }
    if (r === null || typeof r !== "object") continue;
    const value = r.value;
    const label = r.label;
    if (typeof value !== "string" || value === "" || /^\s/.test(value) || value.includes("\n")) continue;
    if (utf8Len(value) > ARG_ITEM_VALUE_MAX_BYTES) continue;
    if (typeof label !== "string" || label === "" || label.length > ARG_ITEM_LABEL_MAX_CHARS) continue;
    if (seen.has(value)) continue;
    let desc = r.description;
    if (typeof desc !== "string" || desc.length > ARG_ITEM_DESC_MAX_CHARS) desc = undefined;
    const item = { value, label, ...(desc !== undefined ? { description: desc } : {}) };
    if (r.policy === "confirm") item.policy = "confirm";
    const cost = utf8Len(value) + label.length + (desc !== undefined ? desc.length : 0);
    if (total + cost > ARG_ITEMS_TOTAL_MAX_BYTES) {
      truncated = true;
      break;
    }
    total += cost;
    seen.add(value);
    items.push(item);
  }
  return { items, truncated };
}

/**
 * Backstep-only result cache (plan §6.1/§6.3 + r1 #9): exact `agentKey|name|prefix` hits,
 * 30s TTL, ≤64-entry LRU (re-set on read touches recency). Used ONLY for instant display
 * while a fresh query is pending (typing/backspace) and during an E_RATE pause — never as a
 * local filter source.
 * @param {string} agentKey @param {string} name @param {string} prefix
 */
export function argCacheKey(agentKey, name, prefix) {
  return `${agentKey}|${name}|${prefix}`;
}

/** @param {Map<string, { items: ArgItem[], at: number }>} cache @param {string} key @param {number} now
 *  @returns {ArgItem[] | undefined} */
export function argCacheGet(cache, key, now) {
  const e = cache.get(key);
  if (e === undefined) return undefined;
  if (now - e.at > ARG_CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, e); // LRU touch
  return e.items;
}

/** @param {Map<string, { items: ArgItem[], at: number }>} cache @param {string} key
 *  @param {ArgItem[]} items @param {number} now */
export function argCacheSet(cache, key, items, now) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { items, at: now });
  while (cache.size > ARG_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
