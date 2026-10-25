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
} satisfies Record<string, string>;

export default fleet;
