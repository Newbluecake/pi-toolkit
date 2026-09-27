/**
 * "Show N Finished Runs" folding (ui-design.md §5.3: "terminal 行降灰；超过 3 条已完成时折叠为
 * 'Show N Finished Runs' 按钮"). Applied independently at every sibling list (`FleetPanel.vue`'s
 * roots, and each `FleetNode.vue`'s own `children`): every non-terminal sibling always stays
 * visible; once more than `max` terminal siblings exist in the *same* list, the `(max+1)`th and
 * later terminal ones (in original order) fold behind a toggle. Pure state, no DOM.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { FleetTreeNode } from "../../types.js";
import { isTerminalRow } from "./tree.js";

export interface FoldSiblingsHandle {
  readonly visible: ComputedRef<readonly FleetTreeNode[]>;
  readonly hiddenCount: ComputedRef<number>;
  readonly expanded: Ref<boolean>;
  reveal(): void;
}

export function useFoldSiblings(
  nodes: ComputedRef<readonly FleetTreeNode[]> | (() => readonly FleetTreeNode[]),
  max = 3,
): FoldSiblingsHandle {
  const read = typeof nodes === "function" ? nodes : (): readonly FleetTreeNode[] => nodes.value;
  const expanded = ref(false) as Ref<boolean>;

  const terminalCount = computed(() => read().filter((n) => isTerminalRow(n.row)).length);
  const hiddenCount = computed(() => (expanded.value ? 0 : Math.max(0, terminalCount.value - max)));

  const visible = computed<readonly FleetTreeNode[]>(() => {
    const all = read();
    if (expanded.value || hiddenCount.value === 0) return all;
    let seenTerminal = 0;
    const out: FleetTreeNode[] = [];
    for (const n of all) {
      if (isTerminalRow(n.row)) {
        seenTerminal++;
        if (seenTerminal > max) continue; // folded behind "Show N Finished Runs"
      }
      out.push(n);
    }
    return out;
  });

  return {
    visible,
    hiddenCount,
    expanded,
    reveal(): void {
      expanded.value = true;
    },
  };
}
