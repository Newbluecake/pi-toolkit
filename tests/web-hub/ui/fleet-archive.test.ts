// @vitest-environment happy-dom
/**
 * web-hub archive plan — UI pure view-logic (archiveView.ts): narrowing the loose status slot,
 * per-kind partitioning, and the bash summary's archived-segment counting inputs. Component
 * behavior (fold/buttons/toast) is pinned by the drawer/tree component tests' helpers; these
 * pure functions are the seam the components consume.
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetRowWire } from "@protocol/messages.js";
import {
  archivedOf,
  archiveSetOf,
  partitionArchived,
} from "../../../src/web-hub/ui/src/components/fleet/archiveView.js";
import FleetDrawer from "../../../src/web-hub/ui/src/components/drawer/FleetDrawer.vue";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.textContent = "";
});

function agentOf(status: Record<string, unknown> | undefined) {
  return { status } as unknown as Parameters<typeof archivedOf>[0];
}

const row = (runId: string, terminal = false, extra: Partial<FleetRowWire> = {}): FleetRowWire =>
  ({
    runId,
    terminal,
    status: terminal ? "completed" : "running",
    phaseLabel: terminal ? "done" : "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    ...extra,
  }) as unknown as FleetRowWire;

describe("archivedOf (status slot narrowing)", () => {
  it("returns undefined for absent/empty/malformed slots (pre-feature byte shape)", () => {
    expect(archivedOf(agentOf(undefined))).toBeUndefined();
    expect(archivedOf(agentOf({}))).toBeUndefined();
    expect(archivedOf(agentOf({ archived: null }))).toBeUndefined();
    expect(archivedOf(agentOf({ archived: { rev: 1, entries: [] } }))).toBeUndefined();
    expect(archivedOf(agentOf({ archived: "junk" }))).toBeUndefined();
  });

  it("returns the wire when entries exist", () => {
    const wire = { rev: 2, entries: [{ kind: "run" as const, id: "r1", at: 1, auto: true as const }] };
    expect(archivedOf(agentOf({ archived: wire }))).toEqual(wire);
  });
});

describe("archiveSetOf + partitionArchived", () => {
  const wire = {
    rev: 1,
    entries: [
      { kind: "run" as const, id: "r1", at: 1, auto: true as const },
      { kind: "run" as const, id: "r2", at: 2 },
      { kind: "bash" as const, id: "b1", at: 3 },
    ],
  };

  it("splits per kind and keeps wire order in both halves", () => {
    const runs = archiveSetOf(wire, "run");
    expect(runs.get("r1")?.auto).toBe(true);
    expect(runs.get("r2")?.auto).toBeUndefined();
    const p = partitionArchived([row("r3"), row("r1", true), row("r2", true)], runs);
    expect(p.live.map((r) => r.runId)).toEqual(["r3"]);
    expect(p.archivedRows.map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("never lets archived metadata hide an active row", () => {
    const p = partitionArchived([row("r1"), row("r2", true)], archiveSetOf(wire, "run"));
    expect(p.live.map((r) => r.runId)).toEqual(["r1"]);
    expect(p.archivedRows.map((r) => r.runId)).toEqual(["r2"]);
  });

  it("an archived id missing from the wire appears in neither half", () => {
    const p = partitionArchived([row("rX")], archiveSetOf(wire, "run"));
    expect(p.live.map((r) => r.runId)).toEqual(["rX"]);
    expect(p.archivedRows).toHaveLength(0);
  });

  it("empty set ⇒ everything live (byte-identical tree input)", () => {
    const rows = [row("r1"), row("r2")];
    expect(partitionArchived(rows, archiveSetOf(undefined, "run")).live).toEqual(rows);
  });
});

function drawerAgent(rows: readonly FleetRowWire[], archived?: Record<string, unknown>): AgentState {
  return {
    key: "A",
    card: { control: false, runTranscript: false, state: "live" },
    down: false,
    prompts: [],
    fleet: rows,
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    dialogs: { epoch: "e1", open: [], closed: [] },
    pendingCtl: [],
    runSel: null,
    runTx: null,
    status: { busy: false, pending: false, ...(archived === undefined ? {} : { archived }) },
  } as unknown as AgentState;
}

function mountDrawer(agent: AgentState) {
  const wrapper = mount(FleetDrawer, {
    props: { agent, now: 1000, mode: "overlay", open: true, panel: "agent" },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("FleetDrawer received-row archive honesty", () => {
  it("renders 64 received terminal rows as 6 live + 58 archived, not as a metadata-only count", async () => {
    // P3 deliberately starts with RECEIVED rows. The producer/archive-view projection chain is
    // owned and verified separately; this is actual Vue DOM evidence, not a full-chain claim.
    const rows = Array.from({ length: 64 }, (_, i) =>
      row(`run-${i}`, true, {
        title: `Run ${i}`,
        label: `worker-${i}`,
        costUsd: 0.01,
        startedAt: 100 + i,
        endedAt: 200 + i,
      }),
    );
    const archived = {
      rev: 1,
      entries: rows.slice(6).map((r, i) => ({ kind: "run" as const, id: r.runId, at: i + 1, auto: true as const })),
    };
    const wrapper = mountDrawer(drawerAgent(rows, archived));

    expect(wrapper.get(".fleet-archived-fold").text()).toBe("Archived 58");
    await wrapper.get(".run-more").trigger("click");
    const liveNames = wrapper.findAll(".tree .run-name b").map((el) => el.text());
    expect(liveNames).toEqual(Array.from({ length: 6 }, (_, i) => `Run ${i}`));

    await wrapper.get(".fleet-archived-fold").trigger("click");
    const archivedRows = wrapper.findAll(".fleet-archived-list .arch-row");
    expect(archivedRows).toHaveLength(58);
    expect(archivedRows[0]!.get(".arch-name b").text()).toBe("Run 6");
    expect(archivedRows[0]!.get(".run-cost").text()).toBe("$0.0100");
    expect(archivedRows.at(-1)!.get(".arch-name b").text()).toBe("Run 63");
    expect(new Set(archivedRows.map((el) => el.get(".arch-name b").text())).size).toBe(58);
  });

  it("keeps archived-metadata active rows live and counts only received archived rows", async () => {
    const rows = [row("active", false, { title: "Still active" }), row("done", true, { title: "Received archive" })];
    const archived = {
      rev: 1,
      entries: [
        { kind: "run" as const, id: "active", at: 1 },
        { kind: "run" as const, id: "done", at: 2 },
        { kind: "run" as const, id: "metadata-only", at: 3 },
      ],
    };
    const wrapper = mountDrawer(drawerAgent(rows, archived));
    expect(wrapper.get(".tree .run-name b").text()).toBe("Still active");
    expect(wrapper.get(".fleet-archived-fold").text()).toBe("Archived 1");
    await wrapper.get(".fleet-archived-fold").trigger("click");
    const archivedRows = wrapper.findAll(".fleet-archived-list .arch-row");
    expect(archivedRows).toHaveLength(1);
    expect(archivedRows[0]!.get(".arch-name b").text()).toBe("Received archive");
  });

  it("keeps the existing tree omission hints reachable with zero received rows", () => {
    const agent = { ...drawerAgent([]), fleetOmitted: { active: 2, terminal: 3 } } as AgentState;
    const wrapper = mountDrawer(agent);
    const hints = wrapper.findAll(".fleet-omitted");
    expect(hints).toHaveLength(2);
    expect(hints[0]!.text()).toContain("2");
    expect(hints[1]!.text()).toContain("3");
    expect(wrapper.find(".fleet-archived").exists()).toBe(false);
  });
});
