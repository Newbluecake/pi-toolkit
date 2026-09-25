/**
 * Subagent tree (plan §包 E): FleetRowWire rows as a forest indented by
 * `parentRunId` — same semantics as the TUI fleet widget's `treeOrder`
 * (rows whose parent is absent become roots; depth-first, input order kept).
 */
import { clip, el, formatDuration, formatUsd } from "./dom.js";

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

const MARK = { none: "•", warn: "!", crit: "✗" };

/**
 * @param {Document} doc
 * @param {readonly any[]} rows
 * @returns {HTMLElement}
 */
export function renderFleet(doc, rows) {
  const tree = fleetTree(rows);
  const root = el(doc, "div", { class: "fleet" });
  if (tree.length === 0) return root;
  root.appendChild(el(doc, "div", { class: "fleet-title" }, `subagents (${tree.length})`));
  const ul = el(doc, "ul", { class: "fleet-list" });
  for (const { row, depth } of tree) {
    /** @type {"none" | "warn" | "crit"} */
    const hl = row.highlight === "warn" || row.highlight === "crit" ? row.highlight : "none";
    const name = String(row.label ?? row.type ?? row.runId);
    const meta = [
      String(row.phaseLabel ?? row.status ?? ""),
      row.model ? String(row.model) : "",
      formatDuration(row.elapsedMs),
      typeof row.costUsd === "number" ? formatUsd(row.costUsd) : "",
    ].filter((x) => x !== "");
    const activity = typeof row.streamLine === "string" && row.streamLine !== "" ? row.streamLine : row.toolTrail;
    const d = Math.min(depth, 8);
    ul.appendChild(
      el(
        doc,
        "li",
        {
          class: `fleet-row hl-${hl} depth-${d}${row.terminal ? " terminal" : ""}`,
          "data-depth": String(d),
          "data-key": row.runId,
        },
        [
          el(doc, "span", { class: "fleet-indent" }, depth > 0 ? `${"  ".repeat(depth - 1)}↳ ` : ""),
          el(doc, "span", { class: `fleet-mark hl-${hl}` }, MARK[hl]),
          el(doc, "span", { class: "fleet-name" }, clip(name, 60)),
          el(doc, "span", { class: "fleet-meta" }, meta.join(" · ")),
          typeof activity === "string" && activity !== ""
            ? el(doc, "span", { class: "fleet-activity" }, clip(activity, 160))
            : null,
        ],
      ),
    );
  }
  root.appendChild(ul);
  return root;
}
