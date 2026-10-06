/**
 * worktree-web plan §7 (W2): cross-version protocol compatibility for
 * `StatusInfo.worktrees`. Mirrors `tests/web-hub/protocol/session-models-compat.test.ts`'s
 * posture for the other open-ended status/session extension (`SessionModelsWire`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decodeAgentFrame, type AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { projectWorktrees } from "../../../src/web-hub/agent/worktrees.js";
import type { ScanResult } from "../../../src/git/worktrees.js";

type JsonObject = Record<string, unknown>;

function fixture(name: string): JsonObject {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/web-hub-worktrees/${name}.json`, import.meta.url), "utf8"),
  ) as JsonObject;
}

// Exactly the StatusFrameSchema shape as it existed before worktree-web (no `worktrees`
// property on the status body) — replaying an OLD hub's decoder here pins the
// upgrade path: a new agent emitting `worktrees` still talks to an old hub.
const legacyStatusFrameSchema = Type.Object({
  t: Type.Literal("status"),
  leafId: Type.Union([Type.String(), Type.Null()]),
  busy: Type.Boolean(),
  pending: Type.Boolean(),
});

describe("worktree-web status.worktrees protocol compatibility", () => {
  it("frozen v1 fixture passes the current decoder (anti-drift)", () => {
    const decoded = decodeAgentFrame(fixture("v1-status"));
    expect(decoded).toMatchObject({ t: "status", leafId: null });
    expect((decoded as { worktrees?: unknown }).worktrees).toEqual(fixture("v1-status").worktrees);
  });

  it("v1 fixture is byte-stable against the live projection (regenerate manually, never silently)", () => {
    // Same scan input the fixture was generated from — see the fixture's own
    // generation note below. A diff here means the projection's shape changed;
    // the fixture must be regenerated and reviewed, not patched over.
    const scan: Extract<ScanResult, { kind: "ok" }> = {
      kind: "ok",
      toplevel: "/home/dev/ai/pi-toolkit",
      listCapped: false,
      worktrees: [
        {
          path: "/home/dev/ai/pi-toolkit",
          head: "0123456789abcdef0123456789abcdef01234567",
          branch: "master",
          main: true,
          current: true,
          probe: { dirty: 0, dirtyCapped: false, untrackedSkipped: false, upstream: true, ahead: 1, behind: 0 },
        },
        {
          path: "/home/dev/ai/pi-toolkit.wt/feature-x",
          head: "89abcdef0123456789abcdef0123456789abcdef",
          branch: "feature-x",
          main: false,
          current: false,
          probe: { dirty: 3, dirtyCapped: false, untrackedSkipped: false, upstream: false, ahead: 0, behind: 0 },
        },
        {
          path: "/tmp/pi-subagent-worktrees/run-abc123",
          head: "fedcba9876543210fedcba9876543210fedcba9",
          branch: "pi-agent-run-abc123",
          main: false,
          current: false,
          agentRunId: "run-abc123",
          probe: { dirty: 0, dirtyCapped: false, untrackedSkipped: false, upstream: false, ahead: 0, behind: 0 },
        },
      ],
    };
    const wire = projectWorktrees(scan, "/home/dev", 1700000000000);
    expect(wire).toEqual(fixture("v1-status").worktrees);
  });

  it("old hub accepts a new-agent frame bearing worktrees (forward compat)", () => {
    const frame = fixture("v1-status");
    expect(Value.Check(legacyStatusFrameSchema, frame)).toBe(true);
    expect(decodeAgentFrame(frame)).toBeDefined();
  });

  it("new hub accepts an old-agent frame with no worktrees field (backward compat)", () => {
    const decoded = decodeAgentFrame(fixture("legacy-status")) as Extract<AgentFrame, { t: "status" }> | undefined;
    expect(decoded).toMatchObject({ t: "status", leafId: null });
    expect(decoded?.worktrees).toBeUndefined();
  });

  it("future row/body fields pass through byte-for-byte (forward compat, Q4 open schema)", () => {
    const frame = fixture("future-row-field");
    const decoded = decodeAgentFrame(frame) as { worktrees?: unknown } | undefined;
    expect(decoded?.worktrees).toEqual(frame.worktrees);
    const row = (decoded?.worktrees as { rows: JsonObject[] }).rows[0]!;
    expect(row.foo).toBe("unexpected-future-row-field");
    expect(row.unprobed).toBe("slow-fs");
  });

  it("rejects an oversized worktrees body (rows beyond the 64-row schema cap) whole", () => {
    expect(decodeAgentFrame(fixture("oversized"))).toBeUndefined();
  });
});
