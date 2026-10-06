import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, type AgentFrame } from "../../../src/web-hub/protocol/messages.js";

type JsonObject = Record<string, unknown>;

function fixture(name: string): JsonObject {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/web-hub-models/${name}.json`, import.meta.url), "utf8"),
  ) as JsonObject;
}

function session(models: JsonObject): JsonObject {
  return {
    t: "session",
    sessionId: "s1",
    cwd: "/tmp/project",
    reason: "startup",
    leafId: null,
    mode: "rpc",
    models,
  };
}

describe("session models protocol compatibility", () => {
  it("accepts the frozen v1 projection fixture", () => {
    const models = fixture("v1-session");
    const decoded = decodeAgentFrame(session(models));
    expect(decoded).toMatchObject({ t: "session", models });
  });

  it("accepts open future fields from the fixture", () => {
    const models = fixture("future-field");
    const decoded = decodeAgentFrame(session(models));
    expect(decoded).toMatchObject({ t: "session", models });
  });

  it("rejects the oversized fixture as a whole session frame", () => {
    expect(decodeAgentFrame(fixture("oversized"))).toBeUndefined();
  });

  it("keeps the legacy fixture valid without models", () => {
    const decoded = decodeAgentFrame(fixture("legacy-session"));
    expect(decoded).toMatchObject({ t: "session", sessionId: "legacy-1" });
    expect((decoded as Extract<AgentFrame, { t: "session" }>).models).toBeUndefined();
  });
});
