import { describe, expect, it } from "vitest";
import {
  readBeforeAgentStartTrigger,
  readContextTrailingCustom,
  readTriggerShape,
} from "../../src/adapters/pi-compat.js";

describe("R1 before_agent_start structural probe", () => {
  it.each([
    [undefined, "unknown"],
    [null, "unknown"],
    ["prompt", "unknown"],
    [{}, "unknown"],
    [{ prompt: "human" }, "legacy"],
    [{ messageType: "user", prompt: "human" }, "union"],
    [{ messageType: "custom" }, "union"],
    [{ messageType: "future", prompt: "x" }, "unknown"],
    [{ messageType: 42, prompt: "x" }, "unknown"],
  ])("shape of %j is %s (no version lookup)", (event, expected) => {
    expect(readTriggerShape(event)).toBe(expected);
  });

  it("reads custom type/details without reading or transforming content", () => {
    const details = { xsWake: true, wakeToken: "token", level: 1 };
    const message = {
      customType: "subagent:xs",
      details,
      get content(): never {
        throw new Error("must not inspect text");
      },
    };
    const trigger = readBeforeAgentStartTrigger({ messageType: "custom", message });
    expect(trigger).toEqual({ kind: "custom", customType: "subagent:xs", details });
    if (trigger.kind === "custom") expect(trigger.details).toBe(details);
  });

  it.each([undefined, null, false, 42, "bad", [], { customType: 7 }, { details: undefined }])(
    "missing/malformed custom message %j stays custom, with absent fields omitted",
    (message) => {
      expect(readBeforeAgentStartTrigger({ messageType: "custom", message })).toEqual({ kind: "custom" });
    },
  );

  it("details remains unknown so the caller can detect custom-shape loss", () => {
    expect(
      readBeforeAgentStartTrigger({ messageType: "custom", message: { customType: "xs", details: null } }),
    ).toEqual({ kind: "custom", customType: "xs", details: null });
  });

  it("preserves all old kind/prompt behavior", () => {
    expect(readBeforeAgentStartTrigger({ prompt: "legacy" })).toEqual({ kind: "user", prompt: "legacy" });
    expect(readBeforeAgentStartTrigger({ messageType: "user", prompt: "new" })).toEqual({
      kind: "user",
      prompt: "new",
    });
    expect(readBeforeAgentStartTrigger({ messageType: "future", prompt: "not human" })).toEqual({ kind: "unknown" });
  });
});

describe("wake-unknown-optimistic: readContextTrailingCustom (context event tail probe)", () => {
  const custom = (over: Record<string, unknown> = {}) => ({
    role: "custom",
    customType: "subagent:xs",
    details: { xsWake: true },
    ...over,
  });
  it("reads ONLY the trailing custom message's shape, never its content", () => {
    const message = {
      role: "custom",
      customType: "subagent:xs",
      details: { xsWake: true },
      get content(): never {
        throw new Error("must not inspect text");
      },
    };
    expect(readContextTrailingCustom({ messages: [{ role: "user", content: "u" }, message] })).toEqual({
      customType: "subagent:xs",
      details: { xsWake: true },
    });
  });
  it.each([
    [undefined, undefined],
    [null, undefined],
    ["str", undefined],
    [{}, undefined],
    [{ messages: "no" }, undefined],
    [{ messages: [] }, undefined],
    [{ messages: [{ role: "user", content: "u" }] }, undefined],
    [{ messages: [{ role: "assistant", content: "a" }] }, undefined],
    [{ messages: [{ role: "custom", customType: 7, details: undefined }] }, {}],
    [{ messages: [{ role: "custom" }] }, {}],
    [{ messages: [{ role: "custom", details: { x: 1 } }] }, { details: { x: 1 } }],
    [{ messages: [{ role: "custom", customType: "subagent:xs" }] }, { customType: "subagent:xs" }],
  ])("shape of %j ⇒ %j", (event, expected) => {
    expect(readContextTrailingCustom(event)).toEqual(expected);
  });
  it("a non-custom trailing message after the marker means other (only the tail is read)", () => {
    expect(
      readContextTrailingCustom({
        messages: [custom(), { role: "user", content: "follow-up" }],
      }),
    ).toBeUndefined();
  });
});
