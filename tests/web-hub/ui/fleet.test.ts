// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import FleetPanel from "../../../src/web-hub/ui/src/components/fleet/FleetPanel.vue";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";

/**
 * `FleetPanel.vue` / `FleetNode.vue` (vue-plan.md v2.1 §5.2/§5.3 — P4). Ports the shape of
 * `tests/fixtures/web-hub-ui/dashboard.json`'s "agent-alpha" fleet frame plus a few synthetic
 * rows to exercise depth ≥3 default-collapse and the "Show N Finished Runs" fold.
 */

function row(r: Partial<FleetRowWire> & { runId: string }): FleetRowWire {
  return {
    label: r.runId,
    type: "general",
    status: "running",
    phaseLabel: "running",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
    ...r,
  } as FleetRowWire;
}

const DASHBOARD_ROWS: FleetRowWire[] = [
  row({
    runId: "run-root",
    label: "alpha main",
    status: "running",
    phaseLabel: "delegating",
    elapsedMs: 120_000,
    costUsd: 0.42,
  }),
  row({
    runId: "run-child-1",
    parentRunId: "run-root",
    label: "explore auth flow",
    model: "cr-anthropic/claude-sonnet-5",
    status: "running",
    phaseLabel: "exploring",
    elapsedMs: 60_000,
    toolTrail: "read,grep,edit",
    streamLine: "Investigating token refresh path...",
    highlight: "warn",
  }),
  row({
    runId: "run-grandchild-1",
    parentRunId: "run-child-1",
    label: "grep call sites",
    status: "completed",
    phaseLabel: "done",
    elapsedMs: 15_000,
    costUsd: 0.03,
    terminal: true,
  }),
  row({
    runId: "run-grandchild-2",
    parentRunId: "run-child-1",
    label: "write regression test",
    status: "running",
    phaseLabel: "writing test",
    elapsedMs: 8000,
  }),
  row({
    runId: "run-child-2",
    parentRunId: "run-root",
    label: "migration write-up",
    status: "completed",
    phaseLabel: "done",
    elapsedMs: 45_000,
    costUsd: 0.11,
    terminal: true,
  }),
  row({
    runId: "run-child-3",
    parentRunId: "run-root",
    label: "flaky e2e probe",
    status: "failed",
    phaseLabel: "error",
    elapsedMs: 10_000,
    highlight: "crit",
    terminal: true,
  }),
];

describe("FleetPanel.vue", () => {
  it("renders nothing when there are no rows (ui-design.md §9)", () => {
    const wrapper = mount(FleetPanel, { props: { rows: [], now: 0, defaultOpen: true } });
    expect(wrapper.find(".fleet").exists()).toBe(false);
    expect(wrapper.html().trim()).toBe("<!--v-if-->");
  });

  it("summarizes running/total/cost and renders the nested tree", () => {
    const wrapper = mount(FleetPanel, { props: { rows: DASHBOARD_ROWS, now: 0, defaultOpen: true } });
    expect(wrapper.find(".fleet").attributes("open")).toBe("");
    // 4 non-terminal rows (run-root, run-child-1, run-grandchild-2) — wait: root, child-1, grandchild-2 = 3
    expect(wrapper.get(".panel-stats .pill").text()).toContain("3 running");
    expect(wrapper.get(".panel-stats .num").text()).toContain("6 total");
    expect(wrapper.get(".panel-stats .num").text()).toContain("$0.5600");
    const rows = wrapper.findAll(".run");
    expect(rows.length).toBe(6);
    // nested depth reflected via .tree ul nesting: run-grandchild-1/2 are inside run-child-1's <ul>
    const child1Details = wrapper.findAll("details").find((d) => d.text().includes("explore auth flow"));
    expect(child1Details).toBeTruthy();
    expect(child1Details!.text()).toContain("grep call sites");
  });

  it("defaultOpen only sets the initial state, not a live binding", () => {
    const wrapper = mount(FleetPanel, { props: { rows: DASHBOARD_ROWS, now: 0, defaultOpen: false } });
    expect(wrapper.find(".fleet").attributes("open")).toBeUndefined();
  });

  it("folds subtrees at depth >= 3 by default and >3 terminal siblings behind Show N Finished Runs", async () => {
    const rows: FleetRowWire[] = [row({ runId: "root", terminal: false })];
    // depth 1..4 chain so the depth>=3 node starts collapsed
    for (let d = 1; d <= 4; d++) {
      rows.push(row({ runId: `n${d}`, parentRunId: d === 1 ? "root" : `n${d - 1}`, terminal: false }));
    }
    // 5 terminal siblings directly under root (plus the depth chain's n1)
    for (let i = 0; i < 5; i++)
      rows.push(row({ runId: `done${i}`, parentRunId: "root", status: "completed", terminal: true }));

    const wrapper = mount(FleetPanel, { props: { rows, now: 0, defaultOpen: true } });
    // depth-3 node (n3, whose own depth is 3) starts collapsed: its <details> has no `open` attr
    const n3 = wrapper
      .findAll("details")
      .find((d) => d.find("summary").exists() && d.get("summary").text().includes("n3"));
    expect(n3).toBeTruthy();
    expect((n3!.element as HTMLDetailsElement).open).toBe(false);

    // root has 6 children (n1 + 5 done*); 5 terminal > 3 ⇒ 2 folded behind the button
    expect(wrapper.text()).toContain("Show 2 Finished Runs");
    const visibleDoneBefore = wrapper.findAll(".run-name b").filter((b) => b.text().startsWith("done")).length;
    expect(visibleDoneBefore).toBe(3);

    await wrapper.get(".run-more").trigger("click");
    const visibleDoneAfter = wrapper.findAll(".run-name b").filter((b) => b.text().startsWith("done")).length;
    expect(visibleDoneAfter).toBe(5);
    expect(wrapper.text()).not.toContain("Show 2 Finished Runs");
  });

  it("ticks elapsed time locally for non-terminal rows between frames, freezes terminal rows", async () => {
    const rows: FleetRowWire[] = [
      row({ runId: "live", terminal: false, elapsedMs: 5000 }),
      row({ runId: "done", terminal: true, status: "completed", elapsedMs: 9000 }),
    ];
    const wrapper = mount(FleetPanel, { props: { rows, now: 1000, defaultOpen: true } });
    const timeOf = (name: string): string =>
      wrapper
        .findAll(".run")
        .find((r) => r.text().includes(name))!
        .get(".run-nums .time")
        .text();
    expect(timeOf("live")).toBe("5s");
    expect(timeOf("done")).toBe("9s");

    await wrapper.setProps({ now: 4000 }); // +3s, no new frame
    expect(timeOf("live")).toBe("8s");
    expect(timeOf("done")).toBe("9s"); // terminal: frozen

    // a fresh frame corrects the baseline instead of compounding drift
    await wrapper.setProps({ rows: [row({ runId: "live", terminal: false, elapsedMs: 20_000 }), rows[1]!], now: 4200 });
    expect(timeOf("live")).toBe("20s");
    await wrapper.setProps({ now: 6200 });
    expect(timeOf("live")).toBe("22s");
  });

  it("maps highlight to data-hl and terminal rows to .is-terminal", () => {
    const wrapper = mount(FleetPanel, {
      props: {
        rows: [
          row({ runId: "warn-row", highlight: "warn", terminal: false }),
          row({ runId: "crit-row", highlight: "crit", status: "failed", terminal: true }),
        ],
        now: 0,
        defaultOpen: true,
      },
    });
    const warnRow = wrapper.findAll(".run").find((r) => r.text().includes("warn-row"))!;
    const critRow = wrapper.findAll(".run").find((r) => r.text().includes("crit-row"))!;
    expect(warnRow.attributes("data-hl")).toBe("warn");
    expect(critRow.attributes("data-hl")).toBe("crit");
    expect(critRow.classes()).toContain("is-terminal");
    expect(critRow.attributes("data-st")).toBe("failed");
  });
});

describe("i18n resolves through the real MESSAGES table (regression: not just the raw key)", () => {
  it("renders the English 'Subagents' title, not a raw i18n key", () => {
    const wrapper = mount(FleetPanel, { props: { rows: DASHBOARD_ROWS, now: 0, defaultOpen: true } });
    expect(wrapper.get(".panel-title").text()).toBe("Subagents");
  });
});
