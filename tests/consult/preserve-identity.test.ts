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

  it("compares the real expert-to-consult shape with relative breakpoints", () => {
    const expert = {
      model: "model",
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "latest", cache_control: { type: "ephemeral", ttl: "5m" } }] },
      ],
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "read" }],
      thinking: { type: "enabled" },
    };
    const consult = {
      ...expert,
      messages: [
        ...expert.messages.slice(0, -1),
        { role: "user", content: [{ type: "text", text: "latest" }] },
        { role: "assistant", content: [{ type: "text", text: "consulting" }] },
        {
          role: "user",
          content: [{ type: "text", text: "question", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
      ],
    };
    expect(comparePayloadPrefix(expert, consult)).toMatchObject({
      model: true,
      messages: true,
      system: true,
      tools: true,
      thinking: true,
    });
  });

  it.each([
    [
      "a non-last breakpoint",
      (expert: any, consult: any) => ({
        ...expert,
        messages: [
          {
            ...expert.messages[0],
            content: [{ type: "text", text: "old", cache_control: { type: "ephemeral", ttl: "5m" } }],
          },
          ...expert.messages.slice(1),
        ],
      }),
    ],
    [
      "a ttl mismatch",
      (expert: any, consult: any) => ({
        ...consult,
        messages: consult.messages.map((message: any) =>
          message.role === "user" && message.content?.[0]?.text === "question"
            ? { ...message, content: [{ ...message.content[0], cache_control: { type: "ephemeral", ttl: "1h" } }] }
            : message,
        ),
      }),
    ],
    [
      "a changed prefix message",
      (expert: any, consult: any) => ({
        ...consult,
        messages: consult.messages.map((message: any, index: number) =>
          index === 1 ? { ...message, content: [{ type: "text", text: "changed" }] } : message,
        ),
      }),
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const expert = {
      model: "model",
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "latest", cache_control: { type: "ephemeral", ttl: "5m" } }] },
      ],
    };
    const consult = {
      ...expert,
      messages: [
        ...expert.messages.slice(0, -1),
        { role: "user", content: [{ type: "text", text: "latest" }] },
        { role: "assistant", content: "consulting" },
        {
          role: "user",
          content: [{ type: "text", text: "question", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
      ],
    };
    const result =
      _name === "a non-last breakpoint"
        ? comparePayloadPrefix(mutate(expert, consult), consult)
        : comparePayloadPrefix(expert, mutate(expert, consult));
    expect(result.messages).toBe(false);
  });

  it("compares the provider prefix while ignoring cache-control in message blocks", () => {
    const expert = {
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "read" }],
      thinking: { type: "enabled" },
    };
    const consult = { ...expert, messages: [...expert.messages, { role: "assistant", content: "new" }] };
    expect(comparePayloadPrefix(expert, consult).messages).toBe(true);
    expect(comparePayloadPrefix(expert, { ...consult, tools: [{ name: "write" }] }).tools).toBe(false);
  });
});
