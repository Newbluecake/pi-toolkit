// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("folds subtrees at depth >= 3 by default and, past 5 finished siblings, all but 3 behind Show N Finished Runs", async () => {
    const rows: FleetRowWire[] = [row({ runId: "root", terminal: false })];
    for (let d = 1; d <= 4; d++) {
      rows.push(row({ runId: `n${d}`, parentRunId: d === 1 ? "root" : `n${d - 1}`, terminal: false }));
    }
    for (let i = 0; i < 7; i++)
      rows.push(row({ runId: `done${i}`, parentRunId: "root", status: "completed", terminal: true }));

    const wrapper = mountTree(rows);
    const n3 = wrapper
      .findAll("details")
      .find((d) => d.find("summary").exists() && d.get("summary").text().includes("n3"));
    expect(n3).toBeTruthy();
    expect((n3!.element as HTMLDetailsElement).open).toBe(false);

    expect(wrapper.text()).toContain("Show 4 Finished Runs");
    const visibleDoneBefore = wrapper.findAll(".run-name b").filter((b) => b.text().startsWith("done")).length;
    expect(visibleDoneBefore).toBe(3);

    await wrapper.get(".run-more").trigger("click");
    const visibleDoneAfter = wrapper.findAll(".run-name b").filter((b) => b.text().startsWith("done")).length;
    expect(visibleDoneAfter).toBe(7);
    expect(wrapper.text()).not.toContain("Show 4 Finished Runs");
  });

  it("a level with only a few (≤5) finished siblings shows them all — no fold button", () => {
    const rows: FleetRowWire[] = [row({ runId: "root", terminal: false })];
    for (let i = 0; i < 5; i++)
      rows.push(row({ runId: `done${i}`, parentRunId: "root", status: "completed", terminal: true }));
    const wrapper = mountTree(rows);
    expect(wrapper.findAll(".run-name b").filter((b) => b.text().startsWith("done")).length).toBe(5);
    expect(wrapper.find(".run-more").exists()).toBe(false);
  });

  it("no chevron column: the chevron is an inline aria-hidden icon after the name, only on summary rows", () => {
    const wrapper = mount(FleetTree, {
      props: {
        nodes: buildFleetTree([row({ runId: "p" }), row({ runId: "leaf" }), row({ runId: "kid", parentRunId: "p" })]),
        now: 0,
      },
    });
    expect(wrapper.find("ul.tree-flat").exists()).toBe(false);
    const sum = wrapper.get("summary.run");
    const chev = sum.get(".run-name .chev");
    expect(chev.attributes("aria-hidden")).toBe("true");
    expect(sum.element.children[0]!.classList.contains("chev")).toBe(false); // not a leading grid cell
    // leaf rows (div.run) have no chevron placeholder at all
    expect(wrapper.findAll("div.run .chev").length).toBe(0);
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
        .get(".run-time")
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

  it("M-B2: a known thinking level renders as a muted `·<level>` token next to the model; unknown renders nothing", () => {
    const wrapper = mountTree([
      row({ runId: "leveled", model: "zai/glm-5.3", thinking: "high" }),
      row({ runId: "plain", model: "zai/glm-5.3" }),
    ]);
    const leveled = wrapper.findAll(".run").find((r) => r.text().includes("leveled"))!;
    const plain = wrapper.findAll(".run").find((r) => r.text().includes("plain"))!;
    expect(leveled.get(".run-model .model").text()).toBe("glm-5.3");
    expect(leveled.get(".run-model .model-thinking").text()).toBe("·high");
    // unknown level → the token node is absent entirely (no dangling `·`)
    expect(plain.find(".run-model .model-thinking").exists()).toBe(false);
    expect(plain.get(".run-model .model").text()).toBe("glm-5.3");
  });

  it("line-2 slot is always rendered: consult rows get a consult note, others the phase only", () => {
    const wrapper = mountTree([
      // wire status is the core RunStatus (`completed`, never the visual `done`)
      row({ runId: "c-done", status: "completed", phaseLabel: "已结束", terminal: true, consult: true }),
      row({ runId: "c-fail", status: "failed", phaseLabel: "已结束", terminal: true, consult: true }),
      row({ runId: "c-run", status: "running", phaseLabel: "运行中", consult: true }),
      row({ runId: "plain", status: "completed", phaseLabel: "已结束", terminal: true }),
      // label looks like a consult but the wire marker is absent ⇒ generic fallback
      row({ runId: "consult-fake", status: "completed", phaseLabel: "已结束", terminal: true }),
      row({ runId: "c-live", consult: true, streamLine: "thinking hard" }),
    ]);
    const act = (id: string): string =>
      wrapper
        .findAll(".run")
        .find((r) => r.text().includes(id))!
        .get(".run-activity")
        .text();
    expect(act("c-done")).toMatch(/已结束 (咨询已回答|Consult answered)/);
    expect(act("c-fail")).toMatch(/(咨询未完成|Consult incomplete)/);
    expect(act("c-run")).toMatch(/(咨询中|Consulting)/);
    expect(act("c-live")).toContain("thinking hard");
    expect(act("c-live")).not.toMatch(/咨询|Consult/);
    expect(act("plain")).toBe("已结束");
    expect(act("consult-fake")).toBe("已结束");
  });

  it("2026-10-16: the provider renders before the model (`zai/` + `glm-5.3`); a bare id renders no provider", () => {
    const wrapper = mountTree([
      row({ runId: "withprov", model: "cr-anthropic/claude-opus-5-5" }),
      row({ runId: "bare", model: "glm-5.3" }),
    ]);
    const withProv = wrapper.findAll(".run").find((r) => r.text().includes("withprov"))!;
    const bare = wrapper.findAll(".run").find((r) => r.text().includes("bare"))!;
    expect(withProv.get(".run-model .model-provider-name").text()).toBe("cr-anthropic");
    expect(withProv.get(".run-model .model-provider").text()).toBe("cr-anthropic/");
    expect(withProv.get(".run-model .model-provider").attributes("title")).toBe("cr-anthropic/claude-opus-5-5");
    expect(withProv.get(".run-model .model").text()).toBe("opus-5.5");
    expect(bare.find(".run-model .model-provider").exists()).toBe(false);
  });

  it("provider compression tiers live in fleet.css (18ch wide, 10ch <600px, 6ch <480px)", () => {
    const css = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/fleet.css"),
      "utf8",
    );
    expect(css).toMatch(/\.run-model \.model-provider \{[^}]*max-width:\s*18ch/);
    expect(css).toMatch(
      /@container \(max-width: 599px\) \{[\s\S]*?\.run-model \.model-provider \{\s*max-width:\s*10ch/,
    );
    expect(css).toMatch(/@container \(max-width: 479px\) \{[\s\S]*?\.run-model \.model-provider \{\s*max-width:\s*6ch/);
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

describe("FleetTree.vue — type badge (variant C)", () => {
  it("renders a letter badge with full type in title + aria-label instead of a text chip", () => {
    const wrapper = mountTree([row({ runId: "b1", type: "verifier" })]);
    const badge = wrapper.get(".run-type");
    expect(badge.text()).toBe("V");
    expect(badge.attributes("title")).toBe("verifier");
    expect(badge.attributes("aria-label")).toBe("verifier");
    expect(wrapper.find(".run-name .chip:not(.chip-orphan)").exists()).toBe(false);
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

  it("终态行(和无 ctx 行)渲染同宽占位:aria-hidden、不可聚焦、非按钮 ⇒ time/cost 列对齐", () => {
    const wrapper = mountTree(
      [row({ runId: "r_live", terminal: false }), row({ runId: "r_done", terminal: true, status: "completed" })],
      {},
      { [CONTROL_CTX as symbol]: { agentKey: "agent-a", control: NOOP_CONTROL, enabled: true } },
    );
    const runs = wrapper.findAll(".run");
    expect(runs.length).toBe(2);
    expect(runs[0]!.find(".run-actions-slot").exists()).toBe(false);
    const slot = runs[1]!.get(".run-actions-slot");
    expect(slot.element.tagName).toBe("SPAN");
    expect(slot.attributes("aria-hidden")).toBe("true");
    expect(slot.attributes("tabindex")).toBeUndefined();
    expect(slot.text()).toBe("");
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

describe("FleetSummaryBar.vue(§6.3 摘要入口;2026-10 悬浮化 —— 右缘竖排 tab)", () => {
  it("竖排 tab:可见面 = 图标/计数徽标,聚合计数全进 aria-label;点击发 toggle", async () => {
    const wrapper = mount(FleetSummaryBar, { props: { rows: DASHBOARD_ROWS, open: false } });
    const btn = wrapper.get(".fleet-summary-bar");
    expect(btn.attributes("aria-controls")).toBe("fleet-drawer");
    expect(btn.attributes("aria-expanded")).toBe("false");
    // 2026-10-09 「这个单词竖过来感觉很怪」: 竖排面板名改为 bot 图标,名字只在 aria-label
    expect(btn.find(".panel-title").exists()).toBe(false);
    expect(btn.get(".fab-icon use").attributes("href")).toBe("#i-bot");
    expect(btn.text()).not.toContain("Agents");
    // 2026-10-09: 徽标只数进行中的(3 running / 6 total ⇒ "3"),已结束的不计
    expect(btn.get(".fab-count").text()).toBe("3");
    expect(btn.get(".fab-count").attributes("data-st")).toBe("running");
    expect(btn.find(".fab-count .dot").exists()).toBe(true);
    // 原摘要行的聚合计数(running/总数/成本)不丢 —— 全量收进 aria-label
    const label = btn.attributes("aria-label") ?? "";
    expect(label).toContain("Agents");
    expect(label).toContain("3 running");
    expect(label).toContain("6 total");
    expect(label).toContain("$0.5600");
    // 无 title 悬浮提示(ui-design §6.3「不依赖 hover」;visual 触屏档断言全页无 [title])
    expect(btn.attributes("title")).toBeUndefined();
    await btn.trigger("click");
    expect(wrapper.emitted("toggle")).toEqual([[]]);
  });

  it("零 running:不显示徽标(只剩图标),aria-label 仍有总数、不含 running 段", () => {
    const done = [
      row({ runId: "d1", status: "completed", phaseLabel: "done", terminal: true, costUsd: 0.1 }),
      row({ runId: "d2", status: "failed", phaseLabel: "error", terminal: true }),
    ];
    const wrapper = mount(FleetSummaryBar, { props: { rows: done, open: true } });
    const btn = wrapper.get(".fleet-summary-bar");
    expect(btn.find(".fab-count").exists()).toBe(false);
    expect(btn.get(".fab-icon use").attributes("href")).toBe("#i-bot");
    expect(btn.attributes("aria-label")).toContain("2 total");
    expect(btn.attributes("aria-label")).not.toContain("running");
    expect(btn.attributes("aria-expanded")).toBe("true");
  });

  it("没有行时不渲染(不占位,沿用 ui-design §9)", () => {
    const wrapper = mount(FleetSummaryBar, { props: { rows: [], open: false } });
    expect(wrapper.find(".fleet-summary-bar").exists()).toBe(false);
  });
});

describe("fleet.css 窄容器防叠字规则(2026-10 手机抽屉行重叠现场:c6bc7b3/1c5ff54 之后的根治)", () => {
  const css = readFileSync(
    resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/fleet.css"),
    "utf8",
  );
  const rule = (selector: string): string => {
    const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(css);
    return m?.[0] ?? "";
  };

  it("chip 可收缩截断(flex:none 会让 chip 溢出 name 格子压到模型名上,是重叠根因)", () => {
    const r = rule(".run-name .chip");
    expect(r).toMatch(/flex:\s*0 1 auto/);
    expect(r).toMatch(/min-width:\s*0/);
    expect(r).toMatch(/text-overflow:\s*ellipsis/);
    expect(r).not.toMatch(/flex:\s*none/);
  });

  it("模型名可截断(time/cost 不可收缩,永远完整)", () => {
    const model = rule(".run-model .model");
    expect(model).toMatch(/min-width:\s*0/);
    expect(model).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".run-time")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".run-model")).toMatch(/min-width:\s*0/);
  });

  it("no chev column in any template; toggle track is the fixed --run-toggle-w everywhere", () => {
    expect(css).not.toMatch(/"chev /);
    expect(css).not.toMatch(/--tree-chev|tree-flat/);
    expect(css).toMatch(/\.run-actions-toggle,\s*\.run-actions-slot\s*\{[^}]*width:\s*var\(--run-toggle-w\)/);
    const tracks = [...css.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((x) => x[1]!);
    const runTracks = tracks.filter((t) => t.includes("--run-toggle-w") || /\bauto auto$/.test(t));
    expect(runTracks.length).toBe(2); // base + <480px container
    for (const t of runTracks) expect(t).toMatch(/var\(--run-toggle-w\)$/);
  });

  it("inline chevron after the name rotates open (same transition as before)", () => {
    expect(rule(".run .chev")).toMatch(/transition:\s*transform var\(--dur-base\) var\(--ease-out\)/);
    expect(css).toMatch(/details\[open\] > summary\.run \.chev\s*\{[^}]*rotate\(90deg\)/);
  });

  it("容器 <480px 时 model+cost 挪到第二行,activity 第三行(真实抽屉全在 360–559px)", () => {
    const m = /@container\s*\(max-width:\s*479px\)\s*\{([\s\S]*)\}\s*$/.exec(css);
    expect(m).not.toBeNull();
    const block = m![1]!;
    expect(block).toMatch(
      /grid-template-areas:[^;]*"icon badge name time toggle"[^;]*"\. \. model cost \."[^;]*"\. \. activity activity \."/,
    );
    // 旧的 <360px 阈值覆盖不到 docked/overlay/手机全屏抽屉,不得回退
    expect(css).not.toMatch(/@container\s*\(max-width:\s*359px\)/);
  });

  it("思考/活动预览行(.run-activity):单行 nowrap + ellipsis + min-width:0,与费用/时间分行不相交", () => {
    const r = rule(".run-activity");
    expect(r).toMatch(/grid-area:\s*activity/); // 独占网格行,不与 model 同轨道
    expect(r).toMatch(/min-width:\s*0/);
    expect(r).toMatch(/overflow:\s*hidden/);
    expect(r).toMatch(/text-overflow:\s*ellipsis/);
    expect(r).toMatch(/white-space:\s*nowrap/);
    // <480px 档的 grid-template-areas 必须把 activity 与 model 放在不同行(上一用例已钉模板,
    // 这里再钉一遍行数:模板字符串里恰好三行,activity 在最后一行)
    const m = /@container\s*\(max-width:\s*479px\)\s*\{([\s\S]*)\}\s*$/.exec(css);
    const areas = /grid-template-areas:\s*([^;]+);/.exec(m![1]!)?.[1] ?? "";
    const lines = [...areas.matchAll(/"[^"]+"/g)].map((x) => x[0]);
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("activity");
    expect(lines[2]).not.toContain("model");
  });

  it("行内元素不靠绝对定位/负 margin 排布(叠字禁令)", () => {
    for (const sel of [".run-name", ".run-model", ".run-activity", ".run-name .chip", ".run-model .model"]) {
      const r = rule(sel);
      expect(r).not.toMatch(/position:\s*absolute/);
      expect(r).not.toMatch(/margin(-\w+)?:\s*-/);
    }
  });
});
