/**
 * `fleet` i18n namespace (vue-plan.md v2.1 §3.2/§3.8/§5.2 — P4). `FleetPanel.vue` / `FleetNode.vue`
 * copy — the mockup's hardcoded English strings ("Subagents", "Show N Finished Runs" etc.)
 * turned into `t()` lookups with `{n}`/`{cost}` placeholders.
 */
const fleet = {
  panelTitle: "Agents",
  running: "{n} running",
  totalCost: "{n} total · {cost}",
  showFinished: "Show {n} Finished Runs",
  treeLabel: "Agents",
  // web-hub archive plan (docs/dev/web-hub/archive-report.md). `archivedFold`/`archivedToast`
  // carry a {n}/{name} placeholder; the `auto` badge itself is a compact English token
  // (rendered directly in the components, not through i18n).
  archive: "Archive",
  unarchive: "Unarchive",
  archivedFold: "Archived {n}",
  archivedToast: "Archived {name}",
  undo: "Undo",
  // 2026-10-28 rework (acceptance blocker): the bulk archive of the omitted tail now reports its
  // outcome. Same title-style grammar as `showFinished` (「Show {n} Finished Runs」 / 「显示已完成的
  // {n} 个」): a statement of what happened, not a sentence fragment.
  archiveOmittedDone: "Archived {n} Older Job(s)",
  archiveOmittedNone: "No Older Jobs to Archive",
  archiveOmittedFailed: "Archive Failed",
} satisfies Record<string, string>;

export default fleet;
