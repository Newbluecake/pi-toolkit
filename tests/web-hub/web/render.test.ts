import { describe, expect, it } from "vitest";
import { agentCardModel, costLabel, renderAgentList, shortCwd } from "../../../src/web-hub/web/render/agents.js";
import { bannerText, renderBanner } from "../../../src/web-hub/web/render/banner.js";
import { fleetTree, renderFleet } from "../../../src/web-hub/web/render/fleet.js";
import { renderToolCard, summarizeArgs, toolView } from "../../../src/web-hub/web/render/tools.js";
import { messageText, renderTranscript } from "../../../src/web-hub/web/render/transcript.js";
import { el, formatDuration, formatUsd } from "../../../src/web-hub/web/render/dom.js";
import { initialState, reduce } from "../../../src/web-hub/web/state.js";
import { byClass, byTag, fakeDocument, FakeElement, FakeNode } from "./fake-dom.js";

const doc = fakeDocument() as any;
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

describe("render/banner", () => {
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
    const node = renderBanner(doc, [{ kind: "confirm", title: "<b>x</b>", since: 1 }]) as unknown as FakeElement;
    expect(node.textContent).toBe("blocked on dialog (confirm, <b>x</b>)");
    expect(byTag(node, "b")).toHaveLength(0);
    expect(renderBanner(doc, [])).toBeNull();
  });
});

describe("render/fleet", () => {
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

  it("renders rows with indent, highlight and meta; empty ⇒ empty container", () => {
    const root = renderFleet(doc, [
      {
        runId: "r1",
        label: "explore",
        status: "running",
        phaseLabel: "tool",
        elapsedMs: 65_000,
        phaseMs: 0,
        costUsd: 0.02,
        highlight: "warn",
        terminal: false,
        toolTrail: "read→grep",
      },
      {
        runId: "r2",
        type: "general",
        parentRunId: "r1",
        status: "done",
        phaseLabel: "done",
        elapsedMs: 1000,
        phaseMs: 0,
        highlight: "none",
        terminal: true,
      },
    ]) as unknown as FakeElement;
    const rows = byClass(root, "fleet-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.className).toContain("hl-warn");
    expect(rows[0]!.textContent).toContain("explore");
    expect(rows[0]!.textContent).toContain("1m05s");
    expect(rows[0]!.textContent).toContain("read→grep");
    expect(rows[1]!.getAttribute("data-depth")).toBe("1");
    expect(rows[1]!.textContent).toContain("↳");
    expect(rows[1]!.className).toContain("terminal");
    expect((renderFleet(doc, []) as unknown as FakeElement).childNodes).toHaveLength(0);
  });
});

describe("render/agents", () => {
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

  it("list renders one card per agent, marks selection, click selects (no inline handlers)", () => {
    const s = reduce(initialState(), {
      event: "agents",
      data: [card("A"), card("B", { state: "stale", outdated: true })],
    });
    const picked: string[] = [];
    const ul = renderAgentList(doc, s, (k: string) => picked.push(k)) as unknown as FakeElement;
    const cards = byClass(ul, "agent-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.className).toContain("selected");
    expect(cards[1]!.className).toContain("state-stale");
    expect(cards[1]!.textContent).toContain("outdated");
    cards[1]!.dispatch("click");
    cards[0]!.dispatch("keydown", { key: "Enter" });
    expect(picked).toEqual(["B", "A"]);
    expect(renderAgentList(doc, initialState(), () => {}).textContent).toContain("no pi agents");
  });

  it("helpers", () => {
    expect(shortCwd("/")).toBe("/");
    expect(shortCwd("/a/b/c")).toBe("b/c");
    expect(costLabel(undefined)).toBe("—");
    expect(costLabel({ costUsd: 2 })).toBe("$2.00");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatDuration(3_725_000)).toBe("1h02m");
  });
});

describe("render/dom el()", () => {
  it("rejects event-handler / style attributes and sets text via text nodes", () => {
    expect(() => el(doc, "div", { onclick: "x" })).toThrow(/not allowed/);
    expect(() => el(doc, "div", { style: "color:red" })).toThrow(/not allowed/);
    const n = el(doc, "div", { class: "c" }, ["<i>x</i>"]) as unknown as FakeElement;
    expect(n.childNodes[0]!.nodeType).toBe(3);
    expect(n.textContent).toBe("<i>x</i>");
  });
});

describe("render/tools", () => {
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

  it("card is a collapsed <details> with truncation badge; content as text", () => {
    const node = renderToolCard(doc, {
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "<x>" },
      state: "done",
      result: "<script>",
      truncated: true,
    }) as unknown as FakeElement;
    expect(node.tagName).toBe("details");
    expect(node.getAttribute("open")).toBeNull();
    expect(byClass(node, "badge-trunc")).toHaveLength(1);
    expect(byTag(node, "script")).toHaveLength(0);
    expect(node.textContent).toContain("<script>");
  });
});

describe("render/transcript", () => {
  const loaded = (entries: unknown[], extra: Record<string, unknown> = {}) =>
    [
      { event: "hello", data: { clientId: "c" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c" } },
      {
        event: "history",
        data: { agentKey: "A", entries, tailMessages: [], fromSeq: 1, hasMore: false, source: "file", ...extra },
      },
    ].reduce((s, m) => reduce(s, m), initialState());

  const entry = (id: string, message: Record<string, unknown>) => ({
    id,
    parentId: null,
    type: "message",
    timestamp: "t",
    message,
  });

  it("renders user/assistant(markdown, thinking, tool card + its result)/custom/compaction", () => {
    const s = loaded([
      entry("u", { role: "user", content: "hi **there**", timestamp: 1 }),
      entry("a", {
        role: "assistant",
        timestamp: 2,
        model: "m1",
        usage: { cost: { total: 0.01 } },
        content: [
          { type: "thinking", thinking: "consider" },
          { type: "text", text: "Use `ls`" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
        ],
      }),
      entry("r", {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt" }],
        timestamp: 3,
      }),
      {
        id: "c",
        parentId: null,
        type: "custom_message",
        timestamp: "t",
        customType: "probe:custom",
        content: "hello",
        display: true,
      },
      { id: "k", parentId: null, type: "compaction", timestamp: "t", summary: "## Goal\n- x", truncated: true },
    ]);
    const nodes = renderTranscript(doc, s.agents.get("A")!, new Map()) as unknown as FakeNode[];
    const root = new FakeElement("div");
    for (const n of nodes) root.appendChild(n);
    expect(byClass(root, "msg-user")[0]!.textContent).toContain("hi **there**"); // user text is literal
    const assistant = byClass(root, "msg-assistant")[0]!;
    expect(byTag(assistant, "code")[0]!.textContent).toBe("ls");
    expect(byClass(assistant, "thinking")).toHaveLength(1);
    const tool = byClass(assistant, "tool")[0]!;
    expect(tool.className).toContain("tool-done");
    expect(tool.textContent).toContain("file.txt");
    expect(byClass(root, "msg-tool")).toHaveLength(0); // result folded into the card
    expect(assistant.textContent).toContain("m1 · $0.0100");
    expect(byClass(root, "msg-custom")[0]!.textContent).toContain("probe:custom");
    const sep = byClass(root, "tx-sep")[0]!;
    expect(sep.textContent).toContain("compacted");
    expect(byClass(sep, "badge-trunc")).toHaveLength(1);
  });

  it("streaming message and orphan live tools render after items; statuses shown", () => {
    let s = loaded([], { hasMore: true, oldestEntryId: "z" });
    s = reduce(s, {
      event: "ev",
      data: { agentKey: "A", seq: 1, e: { type: "message_update", contentIndex: 0, delta: "typing" } },
    });
    s = reduce(s, {
      event: "ev",
      data: {
        agentKey: "A",
        seq: 2,
        e: { type: "tool_execution_start", toolCallId: "t9", toolName: "read", args: { path: "/x" } },
      },
    });
    const root = new FakeElement("div");
    for (const n of renderTranscript(doc, s.agents.get("A")!) as unknown as FakeNode[]) root.appendChild(n);
    expect(byClass(root, "tx-more")[0]!.textContent).toContain("scroll up");
    expect(byClass(root, "streaming")[0]!.textContent).toContain("typing");
    expect(byClass(root, "tool-running")[0]!.textContent).toContain("/x");
  });

  it("render cache: finalized items are reused, pruned when gone", () => {
    const s = loaded([entry("u", { role: "user", content: "a", timestamp: 1 })]);
    const cache = new Map();
    const a = renderTranscript(doc, s.agents.get("A")!, cache);
    const b = renderTranscript(doc, s.agents.get("A")!, cache);
    expect(b[0]).toBe(a[0]);
    const cleared = reduce(s, {
      event: "history",
      data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 1, hasMore: false, source: "file" },
    });
    renderTranscript(doc, cleared.agents.get("A")!, cache);
    expect(cache.size).toBe(0);
  });

  it("history waiting / error states", () => {
    const waiting = [
      { event: "hello", data: { clientId: "c" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c" } },
    ].reduce((s, m) => reduce(s, m), initialState());
    const t = (s: typeof waiting) =>
      (renderTranscript(doc, s.agents.get("A")!) as unknown as FakeNode[]).map((n) => n.textContent).join("");
    expect(t(waiting)).toContain("loading history");
    expect(t(reduce(waiting, { event: "history", data: { agentKey: "A", error: "E_DEADLINE" } }))).toContain(
      "E_DEADLINE",
    );
  });

  it("messageText handles strings, blocks and summaries", () => {
    expect(messageText({ content: "x" })).toBe("x");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a\n[image]");
    expect(messageText({ role: "bashExecution", command: "ls" })).toBe("ls");
    expect(messageText(null)).toBe("");
  });
});
