/**
 * Subagent tree fold (vue-plan.md v2.1 §3.1/§3.2, §5.2 — P5b cleanup): `FleetRowWire` rows as a
 * forest indented by `parentRunId` — same semantics as the TUI fleet widget's `treeOrder` (rows
 * whose parent is absent become roots; depth-first, input order kept).
 *
 * DOM rendering (`renderFleet`, built on the legacy `render/dom.js`'s `el()`) is deleted here
 * (P5b, §3.1's disposition table: "保留 fleetTree；renderFleet P5b 删") — the Vue UI renders the
 * same fold with `FleetPanel.vue`/`FleetNode.vue` (`components/fleet/tree.ts`'s `fleetTree`
 * port, §3.2/§5.2 P4).
 */

/**
 * @param {readonly any[]} rows
 * @returns {Array<{ row: any, depth: number }>}
 */
export function fleetTree(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.runId === "string") : [];
  const present = new Set(list.map((r) => r.runId));
  /** @type {Map<string, any[]>} */
  const children = new Map();
  const roots = [];
  for (const row of list) {
    const p = row.parentRunId;
    if (typeof p === "string" && p !== row.runId && present.has(p)) {
      const arr = children.get(p) ?? [];
      arr.push(row);
      children.set(p, arr);
    } else roots.push(row);
  }
  /** @type {Array<{ row: any, depth: number }>} */
  const out = [];
  const seen = new Set();
  /** @param {any} row @param {number} depth */
  const visit = (row, depth) => {
    if (seen.has(row.runId)) return; // cycle guard
    seen.add(row.runId);
    out.push({ row, depth });
    for (const child of children.get(row.runId) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // rows only reachable through a parent cycle: surface them as roots
  for (const row of list) if (!seen.has(row.runId)) visit(row, 0);
  return out;
}
