import { describe, expect, it } from "vitest";
import { Container, Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  AgentToolParams,
  NestedAgentToolParams,
  createAgentTool,
  type NestedSpawnPort,
} from "../../src/tools/agent-tool.js";
import { CappedBody } from "../../src/ui/capped-body.js";
import type { RunDiagnostics, RunOutcome, SpawnRequest } from "../../src/core/types.js";

function outcome(
  runId: string,
  overrides: Partial<RunOutcome> = {},
  diagOverrides: Partial<RunDiagnostics> = {},
): RunOutcome {
  return {
    runId,
    status: "completed",
    text: "done",
    turns: 1,
    durationMs: 1,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 1,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...diagOverrides,
    },
    ...overrides,
  };
}

function fakePort(): NestedSpawnPort & { seen?: SpawnRequest; calls: string[] } {
  const port: NestedSpawnPort & { seen?: SpawnRequest; calls: string[] } = {
    calls: [],
    async spawn(req) {
      port.calls.push("spawn");
      port.seen = req;
      return { runId: "child-1" };
    },
    async spawnAndWait(req) {
      port.calls.push("spawnAndWait");
      port.seen = req;
      return outcome("child-1");
    },
  };
  return port;
}

/** The nested delegation flavour (blocking by default) — what runtime-adapter injects into a child. */
function nestedTool(port: NestedSpawnPort, extra: { resultMaxChars?: () => number } = {}) {
  return createAgentTool({ spawn: port, parentRunId: "parent-1", allowedTypes: ["worker", "general"], ...extra });
}

describe("tools/agent-tool: top-level Agent is background-only", () => {
  it("the top-level schema has no run_in_background field; the nested schema keeps it", () => {
    expect(Object.keys(AgentToolParams.properties)).not.toContain("run_in_background");
    expect(Object.keys(NestedAgentToolParams.properties)).toContain("run_in_background");
    expect(createAgentTool({ spawn: fakePort() }).parameters).toBe(AgentToolParams);
    expect(nestedTool(fakePort()).parameters).toBe(NestedAgentToolParams);
    // Everything else is shared verbatim between the two surfaces.
    const { run_in_background: _dropped, ...nestedRest } = NestedAgentToolParams.properties;
    expect(Object.keys(AgentToolParams.properties)).toEqual(Object.keys(nestedRest));
  });

  it("a plain call returns a run_id immediately through spawn(), never spawnAndWait()", async () => {
    const port = fakePort();
    const result = await createAgentTool({ spawn: port }).execute(
      "tc",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.calls).toEqual(["spawn"]);
    expect(port.seen?.detachSignalOnStart).toBe(true);
    expect(port.seen?.expectAck).toBeUndefined();
    expect(result.details).toEqual({ runId: "child-1", label: "d", background: true });
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("started in background (run_id: child-1)");
    expect(text).toContain('get_subagent_result(run_id: "child-1")');
    expect(text).toContain('[subagent label: "d" · run_id: child-1 · status: running]');
  });

  it("still runs in the background when a legacy run_in_background: false is passed", async () => {
    const port = fakePort();
    const legacyArgs = { description: "d", prompt: "p", subagent_type: "worker", run_in_background: false };
    const result = await createAgentTool({ spawn: port }).execute(
      "tc",
      legacyArgs as AgentToolParams,
      undefined,
      undefined,
      {} as never,
    );
    expect(port.calls).toEqual(["spawn"]);
    expect(port.seen?.detachSignalOnStart).toBe(true);
    expect((result.details as { background?: boolean }).background).toBe(true);
  });

  it("pi's argument validation accepts (and does not reject) a legacy run_in_background field", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const args = { description: "d", prompt: "p", subagent_type: "worker", run_in_background: false };
    const validated = validateToolArguments(tool as never, {
      type: "toolCall",
      id: "tc",
      name: "Agent",
      arguments: args,
    });
    expect(validated).toMatchObject({ description: "d", subagent_type: "worker" });
    // …while a genuinely malformed call is still rejected (the check is real).
    expect(() =>
      validateToolArguments(tool as never, { type: "toolCall", id: "tc", name: "Agent", arguments: { prompt: "p" } }),
    ).toThrow(/Validation failed/);
  });

  it("describes the background-only protocol and drops the foreground/auto-background wording", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    expect(tool.description).toContain("always runs in the background");
    expect(tool.description).toContain("get_subagent_result");
    expect(tool.description).toContain("steer_subagent");
    expect(tool.description).toContain("abort_subagent");
    expect(tool.description).toContain("same message");
    expect(tool.description).not.toMatch(/run_in_background|foreground|auto-background/i);
    expect(tool.promptSnippet).not.toContain("run_in_background");
    expect(tool.promptSnippet).toContain("background");
    const nested = nestedTool(fakePort());
    expect(nested.description).toContain("run_in_background: true");
    expect(nested.description).toContain("blocks until the subagent finishes");
    expect(nested.description).not.toMatch(/auto-background/i);
    expect(nested.promptSnippet).toContain("run_in_background?");
  });

  it("the nested tool keeps its blocking default: spawnAndWait, full-turn signal linkage, direct result", async () => {
    const port = fakePort();
    const result = await nestedTool(port).execute(
      "tc",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.calls).toEqual(["spawnAndWait"]);
    expect(port.seen?.detachSignalOnStart).toBeUndefined();
    expect(port.seen?.parentRunId).toBe("parent-1");
    expect(result.content[0]).toEqual({ type: "text", text: "done" });
    expect((result.details as { status?: string }).status).toBe("completed");
  });
});

describe("tools/agent-tool: X3 nested delegation gating (allowedTypes/forceSlotless)", () => {
  it("rejects a subagent_type outside allowedTypes before ever calling spawn (tool-level defense in depth)", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port, parentRunId: "parent-1", allowedTypes: ["worker"] });
    await expect(
      tool.execute(
        "tc1",
        { description: "d", prompt: "p", subagent_type: "escalated" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/not in this agent's canSpawn whitelist|nested delegation is not permitted/);
    expect(port.seen).toBeUndefined();
  });

  it("forwards parentRunId, forces slotless, and allows a whitelisted subagent_type", async () => {
    const port = fakePort();
    const tool = createAgentTool({
      spawn: port,
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
      forceSlotless: true,
    });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen).toMatchObject({ type: "worker", parentRunId: "parent-1", slotless: true });
  });

  it("the top-level (non-nested) tool has no allowedTypes restriction", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "anything" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen).toMatchObject({ type: "anything" });
    expect(port.seen?.slotless).toBeUndefined();
  });

  it("nested run_in_background spawns carry detachSignalOnStart (host-turn abort must not cancel them); nested blocking spawnAndWait keeps full-turn linkage", async () => {
    const bgPort = fakePort();
    await nestedTool(bgPort).execute(
      "tc-bg",
      { description: "d", prompt: "p", subagent_type: "worker", run_in_background: true },
      undefined,
      undefined,
      {} as never,
    );
    expect(bgPort.seen?.detachSignalOnStart).toBe(true);

    const fgPort = fakePort();
    await nestedTool(fgPort).execute(
      "tc-fg",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(fgPort.seen?.detachSignalOnStart).toBeUndefined();
  });

  it("forwards an optional schema through to the spawn request", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker", schema },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen?.schema).toEqual(schema);
  });

  // Regression: models serialize object args as JSON strings; a string schema
  // used to reach Type.Unsafe and crash pi's typebox 1.x at session
  // construction ("Object.defineProperty called on non-object", 0ms, no stack).
  it("parses a JSON-string schema into an object before spawning", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    await tool.execute(
      "tc-str",
      { description: "d", prompt: "p", subagent_type: "worker", schema: JSON.stringify(schema) },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen?.schema).toEqual(schema);
  });

  it.each([
    ["an unparseable string", "{not json", /not valid JSON/],
    ["a JSON array", "[1,2]", /got array/],
    ["a number", 42, /got number/],
    ["null", null, /got null/],
  ])("rejects %s with an actionable error and never spawns", async (_label, bad, message) => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await expect(
      tool.execute(
        "tc-bad",
        { description: "d", prompt: "p", subagent_type: "worker", schema: bad },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(message);
    expect(port.seen).toBeUndefined();
  });
});

describe("tools/agent-tool: nested blocking failure diagnostics", () => {
  const failed = (text?: string, sessionFile?: string) =>
    outcome("failed-42", { status: "failed", text, error: { message: "boom" } }, { sessionFile });

  it("includes runId, a non-committal resume hint, and a capped output tail", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => failed("x".repeat(1000), "/missing/session.json");
    const tool = nestedTool(port);
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(
      /run_id: failed-42.*label: "demo".*did not complete successfully: boom.*may be resumable.*resume: "failed-42"/,
    );
    try {
      await tool.execute(
        "tc2",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      );
    } catch (error) {
      const message = String(error);
      expect(message).toContain(`…${"x".repeat(500)}`);
      expect(message).not.toContain("x".repeat(502));
      expect(message.length).toBeGreaterThan(500);
    }
  });

  it("does not check session-file existence before using the non-committal hint", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => failed(undefined, "/definitely/not/on/disk");
    const tool = nestedTool(port);
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/may be resumable/);
  });

  it("explains when no session was created and omits blank output tails", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => failed("   ");
    const tool = nestedTool(port);
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/nothing to resume/);
  });
});

describe("tools/agent-tool: timeout_s budget override", () => {
  it("threads timeout_s into budgetOverride.totalMs; omits it when absent", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker", timeout_s: 120 },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen?.budgetOverride).toEqual({ totalMs: 120_000 });

    const port2 = fakePort();
    const tool2 = createAgentTool({ spawn: port2 });
    await tool2.execute(
      "tc2",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port2.seen?.budgetOverride).toBeUndefined();
  });
});

describe("tools/agent-tool: label result contract", () => {
  it("adds an effective-label marker as a separate final content block", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => outcome("run-1", {}, { label: "derived-1" });
    const result = (await nestedTool(port).execute(
      "tc",
      {
        description: "requested",
        prompt: "p",
        subagent_type: "worker",
      },
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }>; details: { label?: string } };
    expect(result.details.label).toBe("derived-1");
    expect(result.content).toHaveLength(2);
    expect(result.content[1]?.text).toContain('[subagent label: "derived-1"');
  });

  it("keeps structured JSON in content[0] and puts the marker in content[1]", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => outcome("run-2", { structuredResult: { ok: true } }, { label: "structured" });
    const result = (await nestedTool(port).execute(
      "tc",
      {
        description: "requested",
        prompt: "p",
        subagent_type: "worker",
        schema: { type: "object" },
      },
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }> };
    expect(result.content).toHaveLength(2);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true });
    expect(result.content[1]?.text).toContain('label: "structured"');
  });

  it("uses the label returned by background spawn", async () => {
    const port = fakePort();
    port.spawn = async () => ({ runId: "run-bg", label: "derived-bg" });
    const result = (await createAgentTool({ spawn: port }).execute(
      "tc",
      {
        description: "requested",
        prompt: "p",
        subagent_type: "worker",
      },
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }>; details: { label?: string } };
    expect(result.details.label).toBe("derived-bg");
    expect(result.content[0]?.text).toContain('Subagent "derived-bg"');
    expect(result.content[1]?.text).toContain("@derived-bg");
  });

  it("carries the re-pointed label through a resume result", async () => {
    const port = fakePort();
    port.spawnAndWait = async (req) => {
      expect(req.resumeFrom).toBe("old");
      return outcome("run-resumed", {}, { label: "repointed" });
    };
    const result = (await nestedTool(port).execute(
      "tc",
      {
        description: "requested",
        prompt: "p",
        subagent_type: "worker",
        resume: "old",
      },
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }> };
    expect(result.content[1]?.text).toContain("@repointed");
  });
});

describe("tools/agent-tool: renderCall (TUI call card)", () => {
  // Bare-minimum Theme stand-in: renderCall only uses fg()/bold().
  const theme = { fg: (_color: string, t: string) => t, bold: (t: string) => t };
  const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} });

  it("renders the task description and subagent_type instead of a bare tool name", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const comp = tool.renderCall!(
      { description: "analyze project", prompt: "p", subagent_type: "general-purpose" },
      theme as never,
      ctx() as never,
    );
    const out = (comp as Text).render(120).join("\n");
    expect(out).toContain("Agent: analyze project");
    expect(out).toContain("type: general-purpose");
  });

  it("marks nested background / resume / isolation runs and reuses the last component", () => {
    const tool = nestedTool(fakePort());
    const first = tool.renderCall!(
      {
        description: "d",
        prompt: "p",
        subagent_type: "worker",
        run_in_background: true,
        resume: "old-label",
        isolation: "worktree",
      },
      theme as never,
      ctx() as never,
    ) as Text;
    const out = first.render(120).join("\n");
    expect(out).toContain("background");
    expect(out).toContain("resume: old-label");
    expect(out).toContain("isolation: worktree");
    const second = tool.renderCall!(
      { description: "d2", prompt: "p", subagent_type: "worker" },
      theme as never,
      ctx(first) as never,
    );
    expect(second).toBe(first); // same Text instance, mutated in place (bash-tool convention)
    expect((second as Text).render(120).join("\n")).toContain("Agent: d2");
  });

  it("never renders a background marker on the top-level card (always background), even for a legacy field", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const comp = tool.renderCall!(
      { description: "d", prompt: "p", subagent_type: "worker", run_in_background: true } as AgentToolParams,
      theme as never,
      ctx() as never,
    ) as Text;
    const out = comp.render(120).join("\n");
    expect(out).toContain("type: worker");
    expect(out).not.toContain("background");
  });

  it("tolerates partial streaming args (no description yet)", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const comp = tool.renderCall!({}, theme as never, ctx() as never) as Text;
    expect(comp.render(120).join("\n")).toContain("Agent:");
  });
});

describe("tools/agent-tool: thinking parameter passthrough", () => {
  it("forwards the thinking param as thinkingOverride on the spawn request", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker", thinking: "low" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen).toMatchObject({ type: "worker", thinkingOverride: "low" });
  });

  it("omits thinkingOverride entirely when the thinking param is not given", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen && "thinkingOverride" in port.seen).toBe(false);
  });
});

describe("tools/agent-tool: renderResult (markdown body)", () => {
  const theme = { fg: (_color: string, t: string) => t, bold: (t: string) => t };
  const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} });
  const componentText = (c: unknown) => (c as { render(width: number): string[] }).render(100).join("\n");
  const renderFinal = (tool: ReturnType<typeof createAgentTool>, body: string, expanded: boolean) =>
    tool.renderResult!(
      {
        content: [{ type: "text", text: body }],
        details: { runId: "r1", status: "completed", summary: "1 turn" },
      } as never,
      { isPartial: false, expanded } as never,
      theme as never,
      ctx() as never,
    );

  // Identity-styled MarkdownTheme: formatting functions pass text through, so
  // rendered output differs from the source only in markdown structure (e.g.
  // the leading "# " of a heading is consumed by the parser).
  const fakeMdTheme: MarkdownTheme = {
    heading: (s) => s,
    link: (s) => s,
    linkUrl: (s) => s,
    code: (s) => s,
    codeBlock: (s) => s,
    codeBlockBorder: (s) => s,
    quote: (s) => s,
    quoteBorder: (s) => s,
    hr: (s) => s,
    listBullet: (s) => s,
    bold: (s) => s,
    italic: (s) => s,
    strikethrough: (s) => s,
    underline: (s) => s,
  };

  it("renders the body with the Markdown component when a markdownTheme is injected", () => {
    const tool = createAgentTool({ spawn: fakePort(), markdownTheme: () => fakeMdTheme });
    const component = renderFinal(tool, "# 标题\n\nbody text", true);
    expect(component).toBeInstanceOf(Container);
    expect((component as Container).children.some((c) => c instanceof Markdown)).toBe(true);
    const rendered = componentText(component);
    expect(rendered).toContain("✓ ");
    expect(rendered).toContain("标题");
    expect(rendered).not.toMatch(/^# /m); // heading marker consumed by the parser
  });

  it("caps rendered markdown lines (not source lines) and expands fully", () => {
    // >6 source lines including a code fence: cutting the *source* at 6 lines
    // would split the fence; the cap applies to rendered output instead.
    const body = [
      "# Report",
      "",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "```",
      "",
      "tail-line",
    ].join("\n");
    const tool = createAgentTool({ spawn: fakePort(), markdownTheme: () => fakeMdTheme });
    const result = {
      content: [{ type: "text", text: body }],
      details: { runId: "r1", status: "completed" },
    } as never;
    const collapsedComponent = tool.renderResult!(
      result,
      { isPartial: false, expanded: false } as never,
      theme as never,
      ctx() as never,
    );
    const collapsedBody = (collapsedComponent as Container).children[0];
    expect(collapsedBody).toBeInstanceOf(CappedBody);
    expect((collapsedBody as CappedBody).inner).toBeInstanceOf(Markdown);
    const collapsed = collapsedComponent.render(100);
    expect(collapsed.length).toBeLessThanOrEqual(7); // 6 rendered lines + overflow marker
    expect(collapsed.join("\n")).toMatch(/… \+\d+ more lines/);
    const expanded = componentText(
      tool.renderResult!(result, { isPartial: false, expanded: true } as never, theme as never, ctx() as never),
    );
    expect(expanded).toContain("tail-line");
    expect(expanded).not.toContain("more lines");
  });

  it("is byte-identical to the legacy plain-text card when markdownTheme resolves to undefined", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const legacy = createAgentTool({ spawn: fakePort() });
    const explicit = createAgentTool({ spawn: fakePort(), markdownTheme: () => undefined });
    for (const expanded of [false, true]) {
      expect(componentText(renderFinal(explicit, body, expanded))).toBe(
        componentText(renderFinal(legacy, body, expanded)),
      );
    }
  });

  it("renders the top-level background start result as the plain body on the reused Text component", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const result = {
      content: [
        { type: "text", text: 'Subagent "d" started in background (run_id: r1).' },
        { type: "text", text: '[subagent label: "d" · run_id: r1 · status: running]' },
      ],
      details: { runId: "r1", label: "d", background: true },
    } as never;
    const options = { isPartial: false, expanded: false } as never;
    const first = tool.renderResult!(result, options, theme as never, ctx() as never);
    expect(first).toBeInstanceOf(Text);
    const rendered = componentText(first);
    expect(rendered).toContain("started in background (run_id: r1)");
    expect(rendered).not.toContain("✓ "); // no stats summary line for a background start
    const second = tool.renderResult!(result, options, theme as never, ctx(first) as never);
    expect(second).toBe(first); // lastComponent reuse preserved
  });
});
