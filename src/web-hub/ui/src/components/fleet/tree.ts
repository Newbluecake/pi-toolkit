/**
 * Pure fold from `@logic/render/fleet.js`'s `fleetTree(rows)` (flat, depth-first `{row, depth}`
 * pairs — cycle/orphan handling already lives there, unit-tested, untouched) into the nested
 * `FleetTreeNode[]` shape `types.ts` (P0 frozen) declares, so `FleetPanel.vue`/`FleetNode.vue`
 * can recurse over `.children` instead of re-deriving parent/child relationships themselves.
 *
 * Reconstruction algorithm: `fleetTree`'s output is a depth-first pre-order traversal with an
 * explicit `depth` on every entry, so a single pass with a "last node seen at depth N" stack
 * rebuilds the exact same forest `fleetTree` walked — a node at `depth` attaches to
 * `stack[depth - 1]` (or becomes a root at `depth === 0`), then becomes `stack[depth]` for
 * whatever comes next.
 */
import { fleetTree } from "@logic/render/fleet.js";
import type { FleetRowWire } from "@protocol/messages.js";
import type { FleetTreeNode } from "../../types.js";

interface MutableNode {
  row: FleetRowWire;
  depth: number;
  children: MutableNode[];
}

/** `FleetTreeNode.row` is typed structurally (`Record<string, unknown>`) to avoid a hard
 * `@protocol` dependency in `types.ts`; the wire rows really are `FleetRowWire`s here. */
export function buildFleetTree(rows: readonly FleetRowWire[]): readonly FleetTreeNode[] {
  const flat = fleetTree(rows) as ReadonlyArray<{ row: FleetRowWire; depth: number }>;
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  for (const { row, depth } of flat) {
    const node: MutableNode = { row, depth, children: [] };
    stack.length = depth;
    if (depth === 0) {
      roots.push(node);
    } else {
      const parent = stack[depth - 1];
      if (parent) parent.children.push(node);
      else roots.push(node); // defensive: shouldn't happen given fleetTree's own invariants
    }
    stack[depth] = node;
  }
  return roots as unknown as readonly FleetTreeNode[];
}

/** Depth-first pre-order flatten of a forest — mirrors `fleetTree`'s own traversal order, used
 * where a flat list (not a recursive template) is more convenient (e.g. counting/testing). */
export function flattenFleetTree(nodes: readonly FleetTreeNode[]): readonly FleetTreeNode[] {
  const out: FleetTreeNode[] = [];
  const visit = (n: FleetTreeNode): void => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** `FleetRowWire.terminal` read off the structurally-typed `FleetTreeNode.row`. */
export function isTerminalRow(row: Record<string, unknown>): boolean {
  return row.terminal === true;
}
