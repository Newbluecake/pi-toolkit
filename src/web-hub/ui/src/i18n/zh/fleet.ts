/**
 * `fleet` i18n namespace, Chinese (vue-plan.md v2.1 §3.2/§3.8/§5.2 — P4). `satisfies
 * Messages<typeof en>` makes a missing/extra key a `vue-tsc` compile error at authoring time
 * (`i18n-parity.test.ts` also checks it — and the `{param}` sets — at runtime).
 */
import en from "../en/fleet.js";

type Messages<T> = { [K in keyof T]: string };

const fleet = {
  panelTitle: "子 Agent",
  running: "{n} 个运行中",
  totalCost: "共 {n} 个 · {cost}",
  showFinished: "显示已完成的 {n} 个",
  treeLabel: "子 Agent 树",
} satisfies Messages<typeof en>;

export default fleet;
