/**
 * Pure-logic tests for the legacy `@logic/{agents,banner,fleet,tools,transcript}.js` modules
 * (vue-plan.md v2.1 §3.1/§4.1, §5.2 — P5b cleanup of the interrupted P5b `git mv`).
 *
 * This file is what remains of the pre-move `tests/web-hub/web/render.test.ts` after applying
 * §4.1's disposition ("纯函数（fleetTree/toolView/agentCardModel/bannerText/format）保留；DOM
 * 断言迁为组件测试"): the DOM-rendering half (`renderFleet`/`renderToolCard`/`renderAgentList`/
 * `renderBanner`/`renderTranscript`/`el`) is gone along with the functions themselves (deleted
 * from the `@logic` modules in this same package — the Vue components now render the identical
 * view models: `FleetPanel.vue`/`FleetNode.vue` for `fleetTree`, `ToolCard.vue` for
 * `toolView`/`summarizeArgs`, `AgentList.vue`/`AgentCard.vue` for `agentCardModel`, and
 * `Transcript.vue`/`entries.ts` for `messageText`/`itemRenderKey` — see `fleet.test.ts` /
 * `tool-card.test.ts` / `agent-list.test.ts` / `transcript.test.ts` / `detail-body.test.ts` for
 * that DOM-level coverage). `formatUsd`/`formatDuration`/`clip` themselves are P1's
 * `format.test.ts`, not duplicated here.
 */
import { describe, expect, it } from "vitest";
import { agentCardModel, costLabel, shortCwd } from "../../../src/web-hub/ui/src/logic/agents.js";
import { bannerText } from "../../../src/web-hub/ui/src/logic/banner.js";
import { fleetTree } from "../../../src/web-hub/ui/src/logic/fleet.js";
import { summarizeArgs, toolView } from "../../../src/web-hub/ui/src/logic/tools.js";
import { messageText } from "../../../src/web-hub/ui/src/logic/transcript.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

const card = (agentKey: string, extra: Record<string, unknown> = {}) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/home/u/proj/app",
  state: "live",
  pluginVersion: "1",
  outdated: false,
  session: {
    sessionId: "abcdef1234",
    cwd: "/home/u/proj/app",
    reason: "startup",
    leafId: null,
    mode: "tui",
    name: "fix bug",
  },
  status: { leafId: null, busy: true, pending: false, costUsd: 0.1234, subagentCostUsd: 0.5 },
  prompts: [],
  ...extra,
});

describe("banner/bannerText", () => {
  it("blocked on dialog (kind, title); custom stays `custom`; newest wins; +N", () => {
    expect(bannerText([])).toBeNull();
    expect(bannerText(undefined)).toBeNull();
    expect(bannerText([{ kind: "custom", since: 1 }])).toBe("blocked on dialog (custom)");
    expect(bannerText([{ kind: "select", title: "Pick one", since: 1 }])).toBe("blocked on dialog (select, Pick one)");
    expect(
      bannerText([
        { kind: "select", title: "a", since: 1 },
        { kind: "custom", since: 5 },
      ]),
    ).toBe("blocked on dialog (custom) +1");
  });
});

describe("fleet/fleetTree", () => {
  it("tree order by parentRunId (depth-first), orphans are roots, cycles terminate", () => {
    const rows = [
      { runId: "a" },
      { runId: "b", parentRunId: "a" },
      { runId: "c" },
      { runId: "d", parentRunId: "b" },
      { runId: "e", parentRunId: "gone" },
      { runId: "x", parentRunId: "y" },
      { runId: "y", parentRunId: "x" },
    ];
    expect(fleetTree(rows).map(({ row, depth }) => `${row.runId}${depth}`)).toEqual([
      "a0",
      "b1",
      "d2",
      "c0",
      "e0",
      "x0",
      "y1",
    ]);
  });
});

describe("agents/agentCardModel", () => {
  it("card model: kind/cwd/session/busy/cost/stale/down/outdated", () => {
    let s = reduce(initialState(), { event: "agents", data: [card("A"), card("B", { outdated: true, kind: "rpc" })] });
    const m = agentCardModel(s.agents.get("A")!);
    expect(m).toMatchObject({
      title: "proj/app",
      kind: "tui",
      session: "fix bug",
      busy: true,
      stale: false,
      state: "live",
      outdated: false,
    });
    expect(m.cost).toBe("$0.6234 (sub $0.5000)");
    expect(agentCardModel(s.agents.get("B")!)).toMatchObject({ outdated: true, kind: "rpc" });
    s = reduce(s, { event: "agent_stale", data: { agentKey: "A" } });
    expect(agentCardModel(s.agents.get("A")!)).toMatchObject({ stale: true, state: "stale" });
    s = reduce(s, { event: "agent_down", data: { agentKey: "A", reason: "x" } });
    expect(agentCardModel(s.agents.get("A")!)).toMatchObject({ down: true, state: "down" });
  });

  it("helpers", () => {
    expect(shortCwd("/")).toBe("/");
    expect(shortCwd("/a/b/c")).toBe("b/c");
    expect(costLabel(undefined)).toBe("—");
    expect(costLabel({ costUsd: 2 })).toBe("$2.00");
  });
});

describe("tools/toolView", () => {
  it("summarizeArgs prefers well-known keys, else compact JSON, clipped", () => {
    expect(summarizeArgs({ command: "ls  -la\n" })).toBe("ls -la ");
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}');
    expect(summarizeArgs("x".repeat(300))).toHaveLength(120);
    expect(summarizeArgs(undefined)).toBe("");
  });

  it("toolView states: running (live partial) / done / error / truncated", () => {
    const call = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } };
    expect(toolView(call, undefined, { toolCallId: "t1", toolName: "bash", done: false, partial: "a" })).toMatchObject({
      state: "running",
      partial: "a",
    });
    expect(
      toolView(call, { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] }),
    ).toMatchObject({ state: "done", result: "ok" });
    expect(
      toolView(call, { role: "toolResult", toolCallId: "t1", isError: true, content: "boom", truncated: true }),
    ).toMatchObject({ state: "error", truncated: true });
    expect(toolView(call)).toMatchObject({ state: "pending" });
  });
});

describe("transcript/messageText", () => {
  it("handles strings, blocks and summaries", () => {
    expect(messageText({ content: "x" })).toBe("x");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a\n[image]");
    expect(messageText({ role: "bashExecution", command: "ls" })).toBe("ls");
    expect(messageText(null)).toBe("");
  });
});
