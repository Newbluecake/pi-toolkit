/**
 * web-resume plan §2.4/§2.7 — wire compatibility for the resume additions:
 *  - `StatusInfo.features` (optional, bounded) decodes on the current schema, and a frame
 *    carrying it STILL passes the PRE-change status schema (an old hub forwards it verbatim, F9);
 *  - `data.sessions` rides the `command` variant of `cmd_result` through the existing
 *    `Type.Unknown()` CmdData untouched (no proto bump, no hub change).
 */
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  decodeAgentFrame,
  RESUME_FEATURE_V1,
  STATUS_FEATURES_MAX_CHARS,
  STATUS_FEATURES_MAX_ITEMS,
  type AgentFrame,
  type CmdResultFrame,
  type ResumeSessionsWire,
} from "../../../src/web-hub/protocol/messages.js";

const baseStatus = {
  t: "status",
  leafId: "e1",
  busy: false,
  pending: false,
};

// Exactly the StatusFrameSchema shape as it existed before web-resume (no `features`
// property) — replaying an OLD hub's decoder here pins the upgrade path: a new agent
// emitting `features` still talks to an old hub (F9, §2.8 row 3).
const legacyStatusFrameSchema = Type.Object({
  t: Type.Literal("status"),
  leafId: Type.Union([Type.String(), Type.Null()]),
  busy: Type.Boolean(),
  pending: Type.Boolean(),
});

describe("web-resume wire — StatusInfo.features (§2.7)", () => {
  it("a status frame with features decodes on the current schema", () => {
    const frame = decodeAgentFrame({ ...baseStatus, features: [RESUME_FEATURE_V1] });
    expect((frame as { features?: string[] }).features).toEqual(["resume.v1"]);
  });

  it("a pre-change status frame (no features) still decodes — old agents unaffected", () => {
    expect(decodeAgentFrame({ ...baseStatus })).toBeDefined();
  });

  it("the PRE-change schema accepts a features-carrying frame — old hubs forward it (F9 pin)", () => {
    expect(Value.Check(legacyStatusFrameSchema, { ...baseStatus, features: ["resume.v1"] })).toBe(true);
  });

  it("the bounds are enforced by the current schema (≤32 × ≤64 chars)", () => {
    expect(STATUS_FEATURES_MAX_ITEMS).toBe(32);
    expect(STATUS_FEATURES_MAX_CHARS).toBe(64);
    const tooMany = decodeAgentFrame({
      ...baseStatus,
      features: Array.from({ length: STATUS_FEATURES_MAX_ITEMS + 1 }, () => "x"),
    });
    expect(tooMany).toBeUndefined();
    const tooLong = decodeAgentFrame({ ...baseStatus, features: ["x".repeat(STATUS_FEATURES_MAX_CHARS + 1)] });
    expect(tooLong).toBeUndefined();
  });
});

describe("web-resume wire — data.sessions on cmd_result (§2.4)", () => {
  const sessions: ResumeSessionsWire = {
    v: 1,
    scope: "recent",
    windowHours: 48,
    gen: "0123456789abcdef",
    total: 2,
    rows: [
      { id: "s1", title: "one", titleSource: "first", modifiedMs: 1, current: true },
      { id: "s2", title: "两字", titleSource: "name", modifiedMs: 2, forked: true },
    ],
    next: "0123456789abcdef.2.abcdef01",
    provenance: "partial",
    builtAt: 3,
    ambiguous: 1,
    truncated: true,
    q: "widget",
  };
  const frame: CmdResultFrame = {
    t: "cmd_result",
    rid: "r-1",
    id: "cmd-0000000000000001",
    ok: true,
    data: { op: "command", kind: "builtin", completion: "sync", sessions },
  };

  it("rides the existing command variant through decodeAgentFrame verbatim", () => {
    const out = decodeAgentFrame(frame) as (AgentFrame & { data: { sessions?: ResumeSessionsWire } }) | undefined;
    expect(out).toBeDefined();
    expect(out!.data.sessions).toEqual(sessions);
  });

  it("a cmd_result without sessions is unaffected", () => {
    const out = decodeAgentFrame({ ...frame, data: { op: "command", kind: "builtin", completion: "sync" } });
    expect((out as { data: unknown }).data).toEqual({ op: "command", kind: "builtin", completion: "sync" });
  });
});
