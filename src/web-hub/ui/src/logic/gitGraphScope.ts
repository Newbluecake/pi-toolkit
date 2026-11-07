/**
 * web-hub worktree commit-graph — scope helpers (worktree-graph plan v2 §4.3/#13, package P3).
 *
 * Deliberately a SEPARATE file from `./gitGraph.ts`: the worktree panel (main chunk) imports
 * ONLY this module (scope derivation, worktree pick, refresh signature) — the layout/chip/date
 * logic stays in `gitGraph.ts`, which is imported solely by the lazy `components/graph/*`
 * chunk. Keeping this file free of `gitGraph.ts` imports is what keeps layout code out of the
 * main bundle (§5's ≤1.5 KB gz main-increment gate); do NOT "simplify" the split away.
 *
 * No DOM, no I/O, no Vue, no timers: every export runs unchanged under vitest (node) and in
 * the browser, the same discipline as `./wtdiff.js` / `./sessionKeepAlive.ts`. All functions
 * are total and never throw — a malformed status snapshot degrades to "no graph", never to an
 * exception.
 *
 * - `wtgraphScopeOf` — the §4.3 scope derivation, the wtgraph twin of `wtdiffScopeOf`
 *   (`./wtdiff.js`): a scope exists only when the transport offers the graph call, the hub
 *   caps carry `wtgraph.v1` (declared under the same conditions as `wtdiff.v1`, §0 G1), LAN
 *   (password mode) ADDITIONALLY requires `preview.lan.v1` (§0.2 Q1 — LAN rides that cap; a
 *   loopback-mode hub never declares it), and the selected agent has a live session. The
 *   result is `{ agentKey, sessionId }` — the `wt` request input is picked separately.
 * - `pickGraphWt` — §4.3: the worktree the graph renders = the `current` row's `path`, else
 *   the main worktree row's `path`, else `null` (graph section hidden). `path` is the only
 *   join key that matches the hub's membership porcelain exactly; a row whose path was
 *   dropped under projection pressure is skipped.
 * - `graphSigOf` — §4.3's refresh signature: while expanded, a change ⇒ the 3 s debounce
 *   re-pull. Opaque — only equality of two signatures across samples ever matters.
 */

import {
  PREVIEW_LAN_HUB_CAP,
  WTGRAPH_FILES_HUB_CAP,
  WTGRAPH_HUB_CAP,
  WTGRAPH_MERGED_HUB_CAP,
} from "@protocol/version.js";
import type { WorktreeRowWire } from "@protocol/messages.js";

/** The §4.6-shaped request scope (same shape as wtdiff's; `wt` joins at request time). */
export interface GraphScope {
  agentKey: string;
  sessionId: string;
  /** merged-plan §6/§7.1 (P4): the hub declared `wtgraph.merged.v1` (under the SAME conditions
   *  as `wtgraph.v1`, §5.1 — loopback-mode hubs and LAN-without-preview.lan.v1 never carry it,
   *  so this file needs no extra gate). `true` ⇒ the graph request rides `&merged=1` with the
   *  48 s deadline; `false` ⇒ the baseline request, byte-identical to before. */
  merged: boolean;
  /** wtgraph.files.v1: the hub declared the per-commit file list (same gate as `wtgraph.v1`).
   *  Present ONLY when true — an absent key keeps the pre-feature scope shape byte-identical. */
  files?: true;
}

/** Defensive input of `wtgraphScopeOf` — every field arrives from untrusted UI state. */
export interface GraphScopeInput {
  mode?: unknown;
  hubCaps?: unknown;
  hasTransport?: unknown;
  agentKey?: unknown;
  session?: unknown;
}

/**
 * §4.3 scope derivation, aligned 1:1 with `wtdiffScopeOf` (`./wtdiff.js`) but keyed on
 * `WTGRAPH_HUB_CAP`. Password (LAN) mode needs `wtgraph.v1` AND `preview.lan.v1` (§0.2 Q1);
 * every other listener mode needs `wtgraph.v1` alone. Total and never throws.
 */
export function wtgraphScopeOf(p?: GraphScopeInput | null): GraphScope | null {
  if (p === null || typeof p !== "object") return null;
  const { mode, hubCaps, hasTransport, agentKey, session } = p;
  if (hasTransport !== true) return null;
  const caps = Array.isArray(hubCaps) ? hubCaps : [];
  if (!caps.includes(WTGRAPH_HUB_CAP)) return null;
  if (mode === "password" && !caps.includes(PREVIEW_LAN_HUB_CAP)) return null;
  if (typeof agentKey !== "string" || agentKey === "") return null;
  if (session === null || typeof session !== "object") return null;
  const s = session as { sessionId?: unknown };
  if (typeof s.sessionId !== "string" || s.sessionId === "") return null;
  return {
    agentKey,
    sessionId: s.sessionId,
    merged: caps.includes(WTGRAPH_MERGED_HUB_CAP),
    ...(caps.includes(WTGRAPH_FILES_HUB_CAP) ? { files: true as const } : {}),
  };
}

/**
 * §4.3 worktree pick: first row with `current === true` and a usable `path`, else the first
 * `main === true` row with one, else `null` (the panel hides the graph section). The current
 * row wins even when a main row appeared earlier in the ranked list. Total, never throws.
 */
export function pickGraphWt(rows: readonly WorktreeRowWire[] | null | undefined): string | null {
  if (!Array.isArray(rows)) return null;
  let mainPath: string | null = null;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const path = row.path;
    if (typeof path !== "string" || path === "") continue; // dropped under budget pressure — inert
    if (row.current === true) return path;
    if (mainPath === null && row.main === true) mainPath = path;
  }
  return mainPath;
}

/**
 * §4.3 refresh signature over the whole worktree row list: `path|branch|head|current|main`
 * per row, joined in ranked order. Opaque — only equality of two signatures of the SAME
 * panel across samples matters (a change ⇒ debounce re-pull of an expanded graph). Absent
 * fields render as empty strings so `head: "abc"` and an absent head never collide. Total,
 * never throws.
 */
export function graphSigOf(rows: readonly WorktreeRowWire[] | null | undefined): string {
  if (!Array.isArray(rows)) return "";
  const parts: string[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      parts.push("||||");
      continue;
    }
    parts.push(
      [
        typeof row.path === "string" ? row.path : "",
        typeof row.branch === "string" ? row.branch : "",
        typeof row.head === "string" ? row.head : "",
        row.current === true ? 1 : 0,
        row.main === true ? 1 : 0,
      ].join("|"),
    );
  }
  return parts.join("\n");
}
