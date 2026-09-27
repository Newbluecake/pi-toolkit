import { describe, expect, it } from "vitest";
import { agentKeyFromRoute, fixtureExpectsFleetRows } from "../../../scripts/web-hub/visual.js";
import type { DevHubFixture } from "../../../scripts/web-hub/dev-hub.js";

/**
 * P1 fix (todo #26 W3 打回点 A): `visual.ts` used to screenshot/check every cell after a fixed
 * `SETTLE_MS`, well before a fixture's own `atMs`-delayed `fleet` script event could land
 * (dashboard.json:330-416's `atMs: 250` vs. the old 200ms settle) — the detail page never had a
 * chance to render its subagent tree in time. These two pure helpers decide, from the fixture
 * alone, whether a given scenario/route combination should even bother waiting for `.fleet
 * .run` to appear before capturing/asserting.
 */

function fixtureWith(script: DevHubFixture["script"]): DevHubFixture {
  return { agents: [], history: {}, script };
}

describe("agentKeyFromRoute", () => {
  it("extracts the agent key from an #/agent/<key> hash route", () => {
    expect(agentKeyFromRoute("#/agent/agent-alpha")).toBe("agent-alpha");
  });

  it("returns undefined for the bare dashboard route", () => {
    expect(agentKeyFromRoute("#/")).toBeUndefined();
  });

  it("returns undefined for a route that merely starts with /agent without the leading #", () => {
    expect(agentKeyFromRoute("/agent/agent-alpha")).toBeUndefined();
  });
});

describe("fixtureExpectsFleetRows", () => {
  it("false when the route has no agent (agentKey undefined)", () => {
    const fixture = fixtureWith([
      {
        atMs: 250,
        event: "fleet",
        agentKey: "agent-alpha",
        data: { agentKey: "agent-alpha", runs: [{ runId: "r1" }] },
      },
    ]);
    expect(fixtureExpectsFleetRows(fixture, undefined)).toBe(false);
  });

  it("false when the fixture has no script at all", () => {
    expect(fixtureExpectsFleetRows(fixtureWith(undefined), "agent-alpha")).toBe(false);
  });

  it("false when the fixture's fleet event is scoped to a different agent", () => {
    const fixture = fixtureWith([
      { atMs: 250, event: "fleet", agentKey: "agent-beta", data: { agentKey: "agent-beta", runs: [{ runId: "r1" }] } },
    ]);
    expect(fixtureExpectsFleetRows(fixture, "agent-alpha")).toBe(false);
  });

  it("false when the fleet event for this agent carries zero runs", () => {
    const fixture = fixtureWith([
      { atMs: 250, event: "fleet", agentKey: "agent-alpha", data: { agentKey: "agent-alpha", runs: [] } },
    ]);
    expect(fixtureExpectsFleetRows(fixture, "agent-alpha")).toBe(false);
  });

  it("true when the fixture's script has a fleet event scoped (top-level agentKey) to this agent with rows", () => {
    const fixture = fixtureWith([
      {
        atMs: 250,
        event: "fleet",
        agentKey: "agent-alpha",
        data: { agentKey: "agent-alpha", runs: [{ runId: "r1" }] },
      },
    ]);
    expect(fixtureExpectsFleetRows(fixture, "agent-alpha")).toBe(true);
  });

  it("true when only data.agentKey (no top-level agentKey) identifies this agent — mirrors dev-hub's own fallback", () => {
    const fixture = fixtureWith([
      { atMs: 250, event: "fleet", data: { agentKey: "agent-alpha", runs: [{ runId: "r1" }] } },
    ]);
    expect(fixtureExpectsFleetRows(fixture, "agent-alpha")).toBe(true);
  });

  it("ignores non-fleet script events entirely", () => {
    const fixture = fixtureWith([{ atMs: 2000, event: "agent_down", data: { agentKey: "agent-alpha" } }]);
    expect(fixtureExpectsFleetRows(fixture, "agent-alpha")).toBe(false);
  });
});
