// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import FleetTree from "../../../src/web-hub/ui/src/components/fleet/FleetTree.vue";
import FleetSummaryBar from "../../../src/web-hub/ui/src/components/fleet/FleetSummaryBar.vue";
import {
  buildFleetTree,
  fleetActivity,
  orphanRunIds,
  runTranscriptAvailable,
  FLEET_SELECT,
} from "../../../src/web-hub/ui/src/components/fleet/summary.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";

/**
 * `FleetTree.vue` / `FleetSummaryBar.vue` / `fleet/summary.ts`(fleet-drawer plan v2 §6.3 — F6)。
 * 承接被删除的 `fleet.test.ts`(FleetPanel/FleetNode)的行为用例 —— 树形嵌套、深度 ≥3 默认
 * 折叠、「Show N Finished Runs」、elapsed 本地走时、highlight/terminal 类名 —— 并新增 §6.3
 * 迁移表的三条:run-open 按钮(FLEET_SELECT)、孤儿 chip(U8)、「另有 N 个」省略行(U9)。
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
  row({ runId: "run-root", label: "alpha main", elapsedMs: 120_000, costUsd: 0.42 }),
  row({
    runId: "run-child-1",
    parentRunId: "run-root",
    label: "explore auth flow",
    model: "cr-anthropic/claude-sonnet-5",
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

function mountTree(
  rows: readonly FleetRowWire[],
  extra: Record<string, unknown> = {},
  provide: Record<string | symbol, unknown> = {},
) {
  return mount(FleetTree, {
    props: { nodes: buildFleetTree(rows), now: 0, ...extra },
    global: { provide },
  });
}

describe("FleetTree.vue(承接 FleetPanel/FleetNode 的树行为)", () => {
  it("renders the nested tree with per-row labels", () => {
    const wrapper = mountTree(DASHBOARD_ROWS);
    const rows = wrapper.findAll(".run");
    expect(rows.length).toBe(6);
    const child1Details = wrapper.findAll("details").find((d) => d.text().includes("explore auth flow"));
    expect(child1Details).toBeTruthy();
    expect(child1Details!.text()).toContain("grep call sites");
  });

  it("folds subtrees at depth >= 3 by default and >3 terminal siblings behind Show N Finished Runs", async () => {
    const rows: FleetRowWire[] = [row({ runId: "root", terminal: false })];
    for (let d = 1; d <= 4; d++) {
      rows.push(row({ runId: `n${d}`, parentRunId: d === 1 ? "root" : `n${d - 1}`, terminal: false }));
    }
    for (let i = 0; i < 5; i++)
      rows.push(row({ runId: `done${i}`, parentRunId: "root", status: "completed", terminal: true }));

    const wrapper = mountTree(rows);
    const n3 = wrapper
      .findAll("details")
      .find((d) => d.find("summary").exists() && d.get("summary").text().includes("n3"));
    expect(n3).toBeTruthy();
    expect((n3!.element as HTMLDetailsElement).open).toBe(false);

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
    const wrapper = mount(FleetTree, { props: { nodes: buildFleetTree(rows), now: 1000 } });
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
    await wrapper.setProps({
      nodes: buildFleetTree([row({ runId: "live", terminal: false, elapsedMs: 20_000 }), rows[1]!]),
      now: 4200,
    });
    expect(timeOf("live")).toBe("20s");
    await wrapper.setProps({ now: 6200 });
    expect(timeOf("live")).toBe("22s");
  });

  it("maps highlight to data-hl and terminal rows to .is-terminal", () => {
    const wrapper = mountTree([
      row({ runId: "warn-row", highlight: "warn", terminal: false }),
      row({ runId: "crit-row", highlight: "crit", status: "failed", terminal: true }),
    ]);
    const warnRow = wrapper.findAll(".run").find((r) => r.text().includes("warn-row"))!;
    const critRow = wrapper.findAll(".run").find((r) => r.text().includes("crit-row"))!;
    expect(warnRow.attributes("data-hl")).toBe("warn");
    expect(critRow.attributes("data-hl")).toBe("crit");
    expect(critRow.classes()).toContain("is-terminal");
    expect(critRow.attributes("data-st")).toBe("failed");
  });
});

describe("FleetTree.vue — run-open 按钮(§6.3 FLEET_SELECT)", () => {
  it("canOpen ⇒ run 名渲染为按钮,点击调 select 且不折叠父 details", async () => {
    const select = vi.fn();
    const wrapper = mountTree(
      [row({ runId: "root" }), row({ runId: "child", parentRunId: "root" })],
      {},
      { [FLEET_SELECT as symbol]: { select, canOpen: computed(() => true) } },
    );
    const btn = wrapper.findAll(".run-open").find((b) => b.text().includes("child"));
    expect(btn).toBeTruthy();
    const parentDetails = wrapper.findAll("details")[0]!;
    expect((parentDetails.element as HTMLDetailsElement).open).toBe(true);
    await btn!.trigger("click");
    expect(select).toHaveBeenCalledWith("child");
    expect((parentDetails.element as HTMLDetailsElement).open).toBe(true); // stop.prevent 生效
  });

  it("canOpen false 或没有 FLEET_SELECT ⇒ 纯文本,没有按钮", () => {
    const plain = mountTree([row({ runId: "r1" })]);
    expect(plain.find(".run-open").exists()).toBe(false);
    const closed = mountTree(
      [row({ runId: "r1" })],
      {},
      { [FLEET_SELECT as symbol]: { select: () => {}, canOpen: computed(() => false) } },
    );
    expect(closed.find(".run-open").exists()).toBe(false);
  });
});

describe("FleetTree.vue — 孤儿 chip(U8,§6.3 父 run 未列出)", () => {
  it("三级嵌套、父节点未列出 ⇒ 子节点作为根显示并带 chip;根下嵌套层级不变", () => {
    // root(未列出)→ mid(未列出)→ leaf:只有 leaf 在 rows 里,父链整体缺失
    const rows: FleetRowWire[] = [
      row({ runId: "leaf", parentRunId: "mid", label: "orphan leaf" }),
      row({ runId: "leaf-child", parentRunId: "leaf", label: "leaf child" }),
      row({ runId: "leaf-grand", parentRunId: "leaf-child", label: "leaf grand" }),
    ];
    const orphans = orphanRunIds(rows);
    expect([...orphans]).toEqual(["leaf"]);
    const wrapper = mount(FleetTree, { props: { nodes: buildFleetTree(rows), now: 0, orphans } });
    const leafRow = wrapper.findAll(".run").find((r) => r.text().includes("orphan leaf"))!;
    expect(leafRow.get(".chip-orphan").text()).toBe("parent run not listed");
    // 嵌套保留:leaf-child 仍在 leaf 的 details 里
    const leafDetails = wrapper.findAll("details").find((d) => d.text().includes("orphan leaf"));
    expect(leafDetails!.text()).toContain("leaf child");
    // 非孤儿行不带 chip
    expect(wrapper.findAll(".chip-orphan").length).toBe(1);
  });
});

describe("FleetTree.vue — 「另有 N 个未列出」(U9,§3.2/#12)", () => {
  it("omitted {active:6, terminal:4} ⇒ 两行提示都在", () => {
    const wrapper = mount(FleetTree, {
      props: { nodes: buildFleetTree([row({ runId: "r1" })]), now: 0, omitted: { active: 6, terminal: 4 } },
    });
    const lines = wrapper.findAll(".fleet-omitted");
    expect(lines.length).toBe(2);
    expect(lines[0]!.text()).toContain("6");
    expect(lines[1]!.text()).toContain("4");
  });

  it("omitted 缺省或为零 ⇒ 不渲染;嵌套层级(递归实例)不渲染", () => {
    const none = mountTree([row({ runId: "r1" })]);
    expect(none.find(".fleet-omitted").exists()).toBe(false);
    const nested = mount(FleetTree, {
      props: {
        nodes: buildFleetTree([row({ runId: "root" }), row({ runId: "child", parentRunId: "root" })]),
        now: 0,
        omitted: { active: 2, terminal: 0 },
      },
    });
    // 只有根层级那一条(active:2),递归进去的 child 列表不再重复
    expect(nested.findAll(".fleet-omitted").length).toBe(1);
    expect(nested.findAll(".fleet-omitted")[0]!.text()).toContain("2");
  });
});

describe("FleetTree.vue — FleetActions 接缝(control-plan §7.4,承接自 FleetNode)", () => {
  const NOOP_CONTROL = {
    sendPrompt: () => Promise.resolve({ ok: true as const }),
    abort: () => Promise.resolve({ ok: true as const }),
    steerSub: () => Promise.resolve({ ok: true as const }),
    stopSub: () => Promise.resolve({ ok: true as const }),
    answerDialog: () => Promise.resolve({ ok: true as const }),
    cancelDialog: () => Promise.resolve({ ok: true as const }),
    runCommand: () => Promise.resolve({ ok: true as const }),
    query: () => Promise.resolve({ ok: true as const }),
    retry: () => Promise.resolve({ ok: true as const }),
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
  };

  it("非终态行 + CONTROL_CTX ⇒ ⋯ 展开 FleetActions;终态行和无 inject 不显示", async () => {
    const wrapper = mountTree(
      [row({ runId: "r_live", terminal: false }), row({ runId: "r_done", terminal: true, status: "completed" })],
      {},
      { [CONTROL_CTX as symbol]: { agentKey: "agent-a", control: NOOP_CONTROL, enabled: true } },
    );
    const toggles = wrapper.findAll(".run-actions-toggle");
    expect(toggles.length).toBe(1); // 只有非终态行
    await toggles[0]!.trigger("click");
    expect(wrapper.find(".fleet-actions").exists()).toBe(true);
    expect(wrapper.find(".fleet-steer-input").exists()).toBe(true);

    const noCtx = mountTree([row({ runId: "r_live", terminal: false })]);
    expect(noCtx.find(".run-actions-toggle").exists()).toBe(false);
  });
});

describe("fleet/summary.ts 纯函数", () => {
  it("fleetActivity = streamLine || toolTrail(clip 160),FleetNode 与降级页脚共用(U11)", () => {
    expect(fleetActivity({ streamLine: "live text", toolTrail: "read,grep" })).toBe("live text");
    expect(fleetActivity({ streamLine: "", toolTrail: "read,grep" })).toBe("read,grep");
    expect(fleetActivity({ toolTrail: "read" })).toBe("read");
    expect(fleetActivity({})).toBe("");
    expect(fleetActivity({ streamLine: "x".repeat(200) }).length).toBeLessThanOrEqual(160);
  });

  it("runTranscriptAvailable:card.runTranscript 为基;password(LAN)还要 runTranscriptLan", () => {
    expect(runTranscriptAvailable({ runTranscript: true }, "token")).toBe(true);
    expect(runTranscriptAvailable({ runTranscript: true }, "password")).toBe(false);
    expect(runTranscriptAvailable({ runTranscript: true, runTranscriptLan: true }, "password")).toBe(true);
    expect(runTranscriptAvailable({}, "token")).toBe(false);
    expect(runTranscriptAvailable({ runTranscript: true }, undefined)).toBe(true); // 未知环境按 loopback
  });
});

describe("FleetSummaryBar.vue(§6.3 摘要行)", () => {
  it("汇总 running/total/cost,button 带 aria-controls/aria-expanded,点击发 toggle", async () => {
    const wrapper = mount(FleetSummaryBar, { props: { rows: DASHBOARD_ROWS, open: false } });
    const btn = wrapper.get(".fleet-summary-bar");
    expect(btn.attributes("aria-controls")).toBe("fleet-drawer");
    expect(btn.attributes("aria-expanded")).toBe("false");
    expect(btn.get(".panel-title").text()).toBe("Subagents");
    expect(btn.get(".panel-stats .pill").text()).toContain("3 running");
    expect(btn.get(".panel-stats .num").text()).toContain("6 total");
    expect(btn.get(".panel-stats .num").text()).toContain("$0.5600");
    await btn.trigger("click");
    expect(wrapper.emitted("toggle")).toEqual([[]]);
  });

  it("没有行时不渲染(不占位,沿用 ui-design §9)", () => {
    const wrapper = mount(FleetSummaryBar, { props: { rows: [], open: false } });
    expect(wrapper.find(".fleet-summary-bar").exists()).toBe(false);
  });
});
