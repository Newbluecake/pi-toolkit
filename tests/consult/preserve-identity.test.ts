import { describe, expect, it } from "vitest";
import {
  comparePayloadPrefix,
  preflight,
  sessionToolStateChanges,
  toolStateChanges,
} from "../../src/consult/preserve-identity.js";

describe("consult preserve identity", () => {
  it("uses pi's declaration comparison semantics", () => {
    const read = { name: "read", description: "read", parameters: { type: "object" } };
    expect(toolStateChanges([read], [read])).toEqual({ toolsAdded: [], toolsRemoved: [] });
    expect(toolStateChanges([read], [{ ...read, description: "changed" }])).toEqual({
      toolsAdded: [{ ...read, description: "changed" }],
      toolsRemoved: [{ name: "read" }],
    });
  });

  it("runs the pure preflight checks without mutating the session", () => {
    const read = { name: "read", description: "read", parameters: { type: "object" } };
    const session: any = {
      messages: [{ role: "system", content: "", toolsAdded: [read], timestamp: 0 }],
      agent: { beforeToolCall: () => undefined, state: { tools: [read] } },
      _beforeToolCall: () => undefined,
      getAllTools: () => [{ name: "read", exposure: "direct", sourceInfo: { source: "builtin" } }],
      getToolDefinition: () => ({ ...read, execute: () => ({}) }),
    };
    expect(preflight(session, { tools: [read], systemSections: {}, sourceSessionId: "expert" })).toEqual({ ok: true });
    expect(session.agent.state.tools).toEqual([read]);
  });

  it("computes the same state for a session transcript and active tools", () => {
    const read = { name: "read", description: "read", parameters: { type: "object" } };
    const session = {
      messages: [{ role: "system", content: "", toolsAdded: [read], timestamp: 0 }],
      agent: { state: { tools: [read] } },
    };
    expect(sessionToolStateChanges(session)).toEqual({ toolsAdded: [], toolsRemoved: [] });
  });

  it("compares the provider prefix while ignoring cache-control in message blocks", () => {
    const expert = {
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "read" }],
      thinking: { type: "enabled" },
    };
    const consult = {
      ...expert,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: "new" },
      ],
    };
    expect(comparePayloadPrefix(expert, consult)).toMatchObject({
      model: true,
      messages: true,
      system: true,
      tools: true,
      thinking: true,
    });
    expect(comparePayloadPrefix(expert, { ...consult, tools: [{ name: "write" }] }).tools).toBe(false);
  });
});
