import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AgentFrame, SessionModelsWire } from "../../../src/web-hub/protocol/messages.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { fakeConn, hello, memLog } from "./helpers.js";

function models(): SessionModelsWire {
  return JSON.parse(
    readFileSync(new URL("../../fixtures/web-hub-models/v1-session.json", import.meta.url), "utf8"),
  ) as SessionModelsWire;
}

function session(): Extract<AgentFrame, { t: "session" }> {
  return {
    t: "session",
    sessionId: "s-models",
    sessionFile: "/tmp/s-models.jsonl",
    cwd: "/tmp/work",
    reason: "startup",
    leafId: "leaf-1",
    mode: "tui",
    model: { provider: "openai", id: "gpt-5" },
    models: models(),
  };
}

describe("registry session models propagation", () => {
  it("preserves models through the registry card and session event", () => {
    const events: unknown[] = [];
    const registry = createRegistry({
      now: () => 1_000,
      log: memLog(),
      pidAlive: () => true,
    });
    registry.bus.subscribe((event) => events.push(event));
    const conn = fakeConn();
    const { agentKey } = registry.register(hello(), conn);
    registry.onFrame(agentKey, session());

    const card = registry.list().find((item) => item.agentKey === agentKey);
    expect(card?.session?.models).toEqual(models());
    const { t: _t, ...sessionInfo } = session();
    expect(events).toContainEqual({ type: "session", agentKey, session: sessionInfo });
  });
});
