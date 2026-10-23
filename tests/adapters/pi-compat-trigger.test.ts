import { describe, expect, it } from "vitest";
import { readBeforeAgentStartTrigger, readTriggerShape } from "../../src/adapters/pi-compat.js";

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
