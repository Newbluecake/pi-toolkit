/**
 * `fleet` i18n namespace (vue-plan.md v2.1 §3.2/§3.8/§5.2 — P4). `FleetPanel.vue` / `FleetNode.vue`
 * copy — the mockup's hardcoded English strings ("Subagents", "Show N Finished Runs" etc.)
 * turned into `t()` lookups with `{n}`/`{cost}` placeholders.
 */
const fleet = {
  panelTitle: "Subagents",
  running: "{n} running",
  totalCost: "{n} total · {cost}",
  showFinished: "Show {n} Finished Runs",
  treeLabel: "Subagent tree",
} satisfies Record<string, string>;

export default fleet;
