import { describe, expect, it } from "vitest";
import {
  blockedToolReason,
  createConsultGuard,
  installNestedCallBlock,
  NESTED_TOOL_CALL_REASON,
} from "../../src/consult/preserve-guard.js";
import type { ExpertRequestSnapshot } from "../../src/core/types.js";
import { preflight } from "../../src/consult/preserve-identity.js";

function fixture() {
  const read = { name: "read", description: "read", parameters: { type: "object" }, execute: () => ({}) };
  const write = { name: "write", description: "write", parameters: { type: "object" }, execute: () => ({}) };
  const definitions = new Map([
    ["read", { name: "read", description: "read", parameters: read.parameters, execute: read.execute }],
    ["write", { name: "write", description: "write", parameters: write.parameters, execute: write.execute }],
  ]);
  const session: any = {
    messages: [
      {
        role: "system",
        content: "",
        toolsAdded: [
          { name: "read", description: "read", parameters: read.parameters },
          { name: "write", description: "write", parameters: write.parameters },
        ],
        timestamp: 0,
      },
    ],
    agent: {
      beforeToolCall: () => undefined,
      state: { tools: [read, write] },
    },
    _beforeToolCall: () => undefined,
    getAllTools: () => [
      { name: "read", exposure: "direct", sourceInfo: { source: "builtin" } },
      { name: "write", exposure: "direct", sourceInfo: { source: "builtin" } },
    ],
    getToolDefinition: (name: string) => definitions.get(name),
  };
  return session;
}

const snapshot = (): ExpertRequestSnapshot => ({
  tools: [
    { name: "read", description: "read", parameters: { type: "object" } },
    { name: "write", description: "write", parameters: { type: "object" } },
  ],
  systemSections: {},
  sourceSessionId: "expert",
});

describe("consult preserve guard", () => {
  it("pins read-only identities and blocks other tools with the exact reason", async () => {
    const session = fixture();
    const guard = createConsultGuard(snapshot());
    expect(guard.preflight(session)).toEqual({ ok: true });
    guard.install(session);
    const context = (assistantMessage: object, name: string, tools = session.agent.state.tools) => ({
      toolCall: { name, id: `${name}-1` },
      assistantMessage,
      args: {},
      context: { tools },
    });
    expect(await session.agent.beforeToolCall(context({}, "read"))).toBeUndefined();
    const blockedBatch = {};
    const blocked = await session.agent.beforeToolCall(context(blockedBatch, "write"));
    expect(blocked).toMatchObject({
      block: true,
      reason:
        'Tool "write" is disabled in this read-only consult. Allowed tools: read. Answer from your existing context or use an allowed tool.',
      terminate: false,
    });
    const second = await session.agent.beforeToolCall(context({}, "write"));
    expect(second.terminate).toBe(true);
    expect(guard.counters()).toMatchObject({ calls: 2, batches: 2, terminated: true, identity: 0, nested: 0 });
  });

  it("blocks nested calls even when the target is read", async () => {
    const session = fixture();
    installNestedCallBlock(session);
    await expect(session._beforeToolCall({}, "parent")).resolves.toEqual({
      block: true,
      reason: NESTED_TOOL_CALL_REASON,
    });
  });

  it("counts and blocks nested calls through the private pi hook", async () => {
    const session = fixture();
    const guard = createConsultGuard(snapshot());
    expect(guard.preflight(session)).toEqual({ ok: true });
    guard.install(session);
    await expect(
      session._beforeToolCall(
        { toolCall: { name: "read" }, assistantMessage: {}, context: { tools: session.agent.state.tools } },
        "parent",
      ),
    ).resolves.toMatchObject({ block: true, reason: NESTED_TOOL_CALL_REASON, nested: true });
    expect(guard.counters()).toMatchObject({ calls: 1, nested: 1 });
  });

  it("blocks an allowed tool after its identity changes", async () => {
    const session = fixture();
    const guard = createConsultGuard(snapshot());
    expect(guard.preflight(session)).toEqual({ ok: true });
    guard.install(session);
    const replacement = { ...session.agent.state.tools[0] };
    const result = await session.agent.beforeToolCall({
      toolCall: { name: "read", id: "read-1" },
      assistantMessage: {},
      args: {},
      context: { tools: [replacement, session.agent.state.tools[1]] },
    });
    expect(result.block).toBe(true);
    expect(result.identity).toBe(true);
    expect(guard.counters().identity).toBe(1);
  });

  it("fails closed when a declared tool is not registered", () => {
    const session = fixture();
    const guard = createConsultGuard({ ...snapshot(), tools: [...snapshot().tools, { name: "missing" }] });
    expect(guard.preflight(session)).toEqual({ ok: false, code: "identity_mismatch:tool-not-registered:missing" });
  });

  const expectPreflightFailure = (mutate: (session: any) => void, code: string) => {
    const session = fixture();
    mutate(session);
    expect(preflight(session, snapshot())).toMatchObject({ ok: false, code });
    expect(createConsultGuard(snapshot()).preflight(session)).toMatchObject({ ok: false, code });
  };

  it.each([
    ["guard_unavailable:agent-hooks", (session: any) => delete session.agent.beforeToolCall],
    ["guard_unavailable:nested-hook", (session: any) => delete session._beforeToolCall],
    [
      "identity_mismatch:tool-exposure:read",
      (session: any) => {
        session.getAllTools = () => [
          { name: "read", exposure: "hidden", sourceInfo: { source: "builtin" } },
          { name: "write", exposure: "direct", sourceInfo: { source: "builtin" } },
        ];
      },
    ],
    [
      "identity_mismatch:prepare-loadout:read",
      (session: any) => {
        const original = session.getToolDefinition;
        session.getToolDefinition = (name: string) =>
          name === "read" ? { ...original(name), prepareLoadout: () => ({}) } : original(name);
      },
    ],
    [
      "identity_mismatch:readonly-not-builtin:read",
      (session: any) => {
        session.getAllTools = () => [
          { name: "read", exposure: "direct", sourceInfo: { source: "sdk" } },
          { name: "write", exposure: "direct", sourceInfo: { source: "builtin" } },
        ];
      },
    ],
    [
      "identity_mismatch:unaudited-prepare-arguments:write",
      (session: any) => {
        const original = session.getToolDefinition;
        session.getToolDefinition = (name: string) =>
          name === "write" ? { ...original(name), prepareArguments: () => ({}) } : original(name);
      },
    ],
    [
      "identity_mismatch:tool-definition:read",
      (session: any) => {
        session.messages[0].toolsAdded[0].description = "changed";
      },
    ],
  ] as const)("preflight rejects %s through both production entry points", (_code, mutate) => {
    expectPreflightFailure(mutate, _code);
  });

  it("accepts undefined or reference-equal builtin edit prepareArguments", () => {
    const session = fixture();
    const editPrepare = () => ({}) as unknown;
    const original = session.getToolDefinition;
    session.agent.state.tools.push({
      name: "edit",
      description: "edit",
      parameters: { type: "object" },
      execute: () => ({}),
    });
    session.messages[0].toolsAdded.push({ name: "edit", description: "edit", parameters: { type: "object" } });
    session.getAllTools = () => [
      { name: "read", exposure: "direct", sourceInfo: { source: "builtin" } },
      { name: "write", exposure: "direct", sourceInfo: { source: "builtin" } },
      { name: "edit", exposure: "direct", sourceInfo: { source: "builtin" } },
    ];
    const editSnapshot = {
      ...snapshot(),
      tools: [...snapshot().tools, { name: "edit", description: "edit", parameters: { type: "object" } }],
    };
    expect(preflight(session, editSnapshot)).toEqual({ ok: true });
    session.getToolDefinition = (name: string) =>
      name === "edit" ? { ...original(name), prepareArguments: editPrepare } : original(name);
    expect(preflight(session, editSnapshot)).toEqual({ ok: true });
  });

  it("scans active direct and registered codemode/deferred tools, not inactive direct tools", () => {
    const session = fixture();
    const original = session.getToolDefinition;
    const baseTools = session.getAllTools();
    session.getAllTools = () => [
      ...baseTools,
      { name: "inactive", exposure: "direct", sourceInfo: { source: "sdk" } },
      { name: "nested", exposure: "codemode", sourceInfo: { source: "sdk" } },
    ];
    session.getToolDefinition = (name: string) => {
      if (name === "inactive") return { name, prepareLoadout: () => ({}), prepareArguments: () => ({}) };
      if (name === "nested") return { name, prepareLoadout: () => ({}) };
      return original(name);
    };
    expect(preflight(session, snapshot())).toEqual({ ok: false, code: "identity_mismatch:prepare-loadout:nested" });
    session.getAllTools = () => baseTools;

    expect(preflight(session, snapshot())).toEqual({ ok: true });
  });

  it("preserves the precise pinTools identity code", () => {
    const session = fixture();
    const guard = createConsultGuard(snapshot());
    session.agent.state.tools = session.agent.state.tools.filter((tool: any) => tool.name !== "read");
    expect(() => guard.install(session)).toThrow("[consult-preserve:identity_mismatch:tool-not-registered:read]");
  });

  it("blocks definition and execute reference replacements", async () => {
    for (const replacement of ["definition", "execute"] as const) {
      const session = fixture();
      const guard = createConsultGuard(snapshot());
      expect(guard.preflight(session)).toEqual({ ok: true });
      guard.install(session);
      const original = session.getToolDefinition("read");
      session.getToolDefinition = (name: string) =>
        name === "read" ? { ...original, ...(replacement === "execute" ? { execute: () => ({}) } : {}) } : original;
      const result = await session.agent.beforeToolCall({
        toolCall: { name: "read", id: "read-1" },
        assistantMessage: {},
        args: {},
        context: { tools: session.agent.state.tools },
      });
      expect(result).toMatchObject({ block: true, identity: true });
      expect(guard.counters().identity).toBe(1);
    }
  });

  it("keeps counters read-only and formats empty and multiple allowed lists", async () => {
    expect(blockedToolReason("bash", [])).toBe(
      'Tool "bash" is disabled in this read-only consult. Allowed tools: none. Answer from your existing context.',
    );
    expect(blockedToolReason("bash", ["read", "grep"])).toBe(
      'Tool "bash" is disabled in this read-only consult. Allowed tools: read, grep. Answer from your existing context or use an allowed tool.',
    );
    const session = fixture();
    const guard = createConsultGuard(snapshot());
    expect(guard.preflight(session)).toEqual({ ok: true });
    guard.install(session);
    await session.agent.beforeToolCall({
      toolCall: { name: "write", id: "write-1" },
      assistantMessage: {},
      args: {},
      context: { tools: session.agent.state.tools },
    });
    const first = guard.counters();
    const second = guard.counters();
    expect(second).toEqual(first);
  });
});
