/** Shared deterministic inputs/interactions for the one-shot baseline recorder and parity test.
 * Contract: serialized ELEMENT DOM (comments excluded, text/attributes unchanged), plus ordered
 * UI→HubSpawnHandle request intents. Transport wire encoding is covered by transport-contract.
 */
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { vi } from "vitest";
import AgentList from "../../../../src/web-hub/ui/src/components/agents/AgentList.vue";
import SpawnRow from "../../../../src/web-hub/ui/src/components/spawn/SpawnRow.vue";
import { HUB_CTX } from "../../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetLangForTests, setLangOverride } from "../../../../src/web-hub/ui/src/composables/useI18n.js";
import type { HubHandle, HubState } from "../../../../src/web-hub/ui/src/types.js";
import type { SpawnRecordPublic } from "../../../../src/web-hub/protocol/spawn.js";

export const BASELINE_REVISION = "60b2e838";
export const COMPARISON_CONTRACT =
  "element DOM serialization excluding comment nodes; exact text and attributes; ordered UI-to-HubSpawnHandle request intents (not raw HTTP bytes)";
const NOW = 1794651000000;
const policy = {
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 10,
  maxPerPrincipal: 10,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
};
const failed: SpawnRecordPublic = {
  spawnId: "legacy-failed",
  cwdLabel: "project",
  state: "failed",
  createdAt: NOW - 20_000,
  updatedAt: NOW - 10_000,
  origin: { listener: "loopback", reqId: "legacy-request" },
};
const exited: SpawnRecordPublic = { ...failed, spawnId: "legacy-exited", state: "exited" };
const restored: SpawnRecordPublic = {
  ...failed,
  spawnId: "legacy-restored",
  restore: { attempt: 1, failure: "session-invalid" },
};
const historyItem = {
  key: "2026-10/file.jsonl",
  id: "session-id",
  cwd: "/project",
  cwdLabel: "project",
  startedAt: "2026-10-01T00:00:00.000Z",
  mtimeMs: NOW - 300_000,
  size: 10,
  title: "Recorded legacy title",
  titleSource: "first",
  kind: "main",
  cwdState: "ok",
  startable: true,
  indexed: true,
};

function elementDom(el: Element | null): string | null {
  if (!el) return null;
  const clone = el.cloneNode(true) as Element;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  return clone.outerHTML;
}
function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.body.querySelector<T>(selector);
  if (!el) throw new Error(`missing scenario element: ${selector}`);
  return el;
}
async function click(el: HTMLElement) {
  el.click();
  await flushPromises();
}

export async function captureLegacyScenarios() {
  const scenarios = [
    { name: "no-exited-cap", caps: ["spawn.v1", "spawn.relaunch.v1"], items: [failed, restored, exited] },
    {
      name: "ordinary-history-cap",
      caps: ["spawn.v1", "spawn.relaunch.v1", "spawn.history.v1"],
      items: [failed, restored, exited],
    },
    { name: "restore-off", caps: ["spawn.v1", "spawn.history.v1"], items: [failed, exited] },
  ];
  window.localStorage.clear();
  const output: Record<string, unknown> = {};
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  setLangOverride("en", null);
  try {
    for (const scenario of scenarios) {
      const ledger: unknown[] = [];
      const flow = ref({ phase: "idle" });
      const hub = {
        state: ref({
          hub: { caps: scenario.caps, pid: 123, startedAt: NOW - 1000 },
          conn: "connected",
          clientId: "legacy-tab",
          agents: new Map(),
          spawns: { items: scenario.items, active: 0, max: 10 },
          synced: true,
        } as unknown as HubState),
        dispatch: () => {},
        spawn: {
          list: async () => {
            ledger.push({ method: "GET", path: "/api/headless" });
            return { ok: true, policy, items: scenario.items.map((r) => ({ ...r, cwd: "/project" })) };
          },
          history: async (query: unknown) => {
            ledger.push({ method: "GET", path: "/api/headless/history", query });
            return {
              ok: true,
              page: {
                items: [historyItem],
                stats: { files: 1, indexed: 1, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
              },
            };
          },
          relaunch: async (spawnId: string) => {
            ledger.push({ method: "POST", path: "/api/headless/relaunch", body: { spawnId } });
            return { ok: true, spawnId, state: "starting" };
          },
          newSession: {
            flow,
            submit: async (input: unknown) => {
              ledger.push({ op: "newSession.submit", input });
              return true;
            },
            cancel: () => {},
            confirm: async () => {},
          },
        },
      } as unknown as HubHandle;
      const provide = { [HUB_CTX as symbol]: hub };
      const list = mount(AgentList, {
        props: { cards: [], selectedKey: null, filter: "" },
        global: { provide },
        attachTo: document.body,
      });
      try {
        await flushPromises();
        const agentList = elementDom(list.element);
        await click(required(".nsmenu-toggle"));
        const menu = elementDom(required(".nsmenu"));
        await click(required(".nsmenu-toggle"));
        let historyModal: unknown = null;
        if (scenario.caps.includes("spawn.history.v1")) {
          await click(required(".sidebar-history-btn"));
          const initial = elementDom(required(".history-dialog"));
          const search = required<HTMLInputElement>("input[name=history-search]");
          search.value = "parser";
          search.dispatchEvent(new Event("input", { bubbles: true }));
          search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          await flushPromises();
          await click(required(".history-kind input"));
          const queried = elementDom(required(".history-dialog"));
          await click(required(".history-row-actions button"));
          historyModal = { initial, queried };
          await click(required(".history-headrow button"));
        }
        // A legacy restore failure still follows the old owner-cwd fresh retry, without the
        // exited capability. Direct mounting also catches accidental extra row attributes.
        const row = mount(SpawnRow, {
          props: { rec: scenario.name === "restore-off" ? failed : restored },
          global: { provide },
          attachTo: document.body,
        });
        let spawnRow: unknown;
        try {
          const before = elementDom(row.element);
          const retry = row.findAll("button").find((b) => b.text() === "Retry");
          if (!retry) throw new Error("legacy retry missing");
          await retry.trigger("click");
          await flushPromises();
          await row
            .findAll("button")
            .find((b) => b.text() === "Details")!
            .trigger("click");
          await flushPromises();
          spawnRow = { before, details: elementDom(row.element) };
        } finally {
          row.unmount();
        }
        output[scenario.name] = {
          input: { caps: scenario.caps, items: scenario.items },
          agentList,
          menu,
          spawnRow,
          historyModal,
          ledger,
        };
      } finally {
        list.unmount();
        document.body.innerHTML = "";
        document.body.style.overflow = "";
      }
    }
  } finally {
    clock.mockRestore();
    resetLangForTests();
  }
  return { baselineRevision: BASELINE_REVISION, contract: COMPARISON_CONTRACT, scenarios: output };
}
