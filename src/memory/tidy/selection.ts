import type { ArchiveSignal } from "./archive-signals.js";

export interface SelectionCandidate {
  name: string;
  bytes: number;
  signals?: readonly ArchiveSignal[];
  reason?: string;
  conflict?: boolean;
  suggested?: boolean;
}
export type SelectionAction =
  | { kind: "continue" }
  | { kind: "suggested" }
  | { kind: "clear" }
  | { kind: "toggle"; name: string }
  | { kind: "view"; name: string }
  | { kind: "cancel" };
export interface SelectionState {
  candidates: readonly SelectionCandidate[];
  selected: ReadonlySet<string>;
}
export interface SelectionItem {
  id: string;
  label: string;
  action: SelectionAction;
}

function prefix(index: number): string {
  return String(index + 1).padStart(2, "0");
}
function selectedBytes(state: SelectionState): number {
  return state.candidates.filter((c) => state.selected.has(c.name)).reduce((sum, c) => sum + c.bytes, 0);
}
function fmtKiB(bytes: number): string {
  const value = Number((Math.max(0, bytes) / 1024).toFixed(1));
  return `${String(value)}KiB`;
}

/** Build the exact, uniquely-prefixed labels used by the bounded select loop. */
export function selectionItems(state: SelectionState): readonly SelectionItem[] {
  const items: SelectionItem[] = [];
  items.push({
    id: "continue",
    label: `${prefix(0)} ✓ Continue — archive ${state.selected.size} selected (${fmtKiB(selectedBytes(state))})`,
    action: { kind: "continue" },
  });
  items.push({ id: "suggested", label: `${prefix(1)} Select suggested`, action: { kind: "suggested" } });
  items.push({ id: "clear", label: `${prefix(2)} Clear all`, action: { kind: "clear" } });
  let index = 3;
  for (const candidate of state.candidates) {
    const checked = candidate.conflict ? "-" : state.selected.has(candidate.name) ? "x" : " ";
    const signal = candidate.signals?.join(" ") ?? "";
    const suffix = candidate.conflict ? " conflict" : signal ? ` ${signal}` : "";
    items.push({
      id: `candidate:${candidate.name}`,
      label: `${prefix(index++)} [${checked}] ${candidate.name} · ${fmtKiB(candidate.bytes)}${suffix}${candidate.reason ? ` — ${candidate.reason}` : ""}`,
      action: { kind: "toggle", name: candidate.name },
    });
  }
  items.push({ id: "view", label: `${prefix(index++)} View a file…`, action: { kind: "view", name: "" } });
  items.push({ id: "cancel", label: `${prefix(index)} Cancel`, action: { kind: "cancel" } });
  return items;
}

export function selectionAction(items: readonly SelectionItem[], label: string | undefined): SelectionAction {
  return items.find((item) => item.label === label)?.action ?? { kind: "cancel" };
}
export function selectedTotal(state: SelectionState): { files: number; bytes: number } {
  return { files: state.selected.size, bytes: selectedBytes(state) };
}
export function reduceSelection(state: SelectionState, action: SelectionAction): SelectionState {
  const selected = new Set(state.selected);
  if (action.kind === "cancel" || action.kind === "continue" || action.kind === "view") return { ...state, selected };
  if (action.kind === "clear") selected.clear();
  if (action.kind === "suggested") {
    selected.clear();
    for (const candidate of state.candidates)
      if (candidate.suggested && !candidate.conflict) selected.add(candidate.name);
  }
  if (action.kind === "toggle") {
    const candidate = state.candidates.find((item) => item.name === action.name);
    if (!candidate || candidate.conflict) return { ...state, selected };
    if (selected.has(action.name)) selected.delete(action.name);
    else selected.add(action.name);
  }
  return { ...state, selected };
}

export const buildSelectionItems = selectionItems;
