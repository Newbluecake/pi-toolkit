/**
 * bash-jobs-panel plan §3 包 A0: frozen wire schema for `StatusInfo.bashJobs`.
 * Posture mirrors the worktrees block in `tests/web-hub/protocol/messages.test.ts` (open
 * nested schemas, worktree Q4 / plan D5): a malformed body drops the WHOLE status frame,
 * an unknown field never does, and the pre-bashJobs frame shape stays valid (no proto bump).
 * The exported property-key sets are pinned exactly — packages A (agent projection) and B
 * (UI) code against these names; an additive field must consciously update this freeze.
 */
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  BashJobRowSchema,
  BashJobsWireSchema,
  decodeAgentFrame,
  type AgentFrame,
} from "../../../src/web-hub/protocol/messages.js";

const status = {
  leafId: "abc123",
  busy: true,
  pending: false,
  contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
  costUsd: 0.12,
  subagentCostUsd: 0.01,
};

// One row per shape family: running (no end, tail not yet current), settled terminal
// (full freshness bookkeeping), and a grace/timeout row with an unavailable tail.
const runningRow = {
  id: "job-7f3a",
  cmd: "TOKEN=*** ./build.sh && echo done",
  status: "running",
  exitCode: null,
  createdAt: 1790000000000,
  elapsedMs: 65_000,
  logBytes: 4096,
  tail: "building…\nstill building",
  tailAt: 1790000060000,
  tailBytes: 4096,
} as const;

const doneRow = {
  id: "job-2b",
  cmd: "npm test",
  cmdTruncated: true,
  status: "exited",
  exitCode: 0,
  createdAt: 1789999000000,
  endedAt: 1789999900000,
  elapsedMs: 900_000,
  logBytes: 8192,
  logTruncated: true,
  tail: "988 passed",
  tailAt: 1789999900500,
  tailBytes: 8192,
  tailCurrent: true,
} as const;

const graceRow = {
  id: "job-9c",
  cmd: "sleep 600",
  status: "timeout",
  exitCode: null,
  createdAt: 1790000000000,
  endedAt: 1790000120000,
  elapsedMs: 120_000,
  logBytes: 0,
  grace: true,
  tailUnavailable: true,
} as const;

const bashJobsWire = {
  rows: [runningRow, doneRow, graceRow],
  total: 3,
  running: 1,
  failed: 0,
  omitted: 2,
  sampledAt: 1790000060000,
} as const;

function decodedStatus(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  return decodeAgentFrame(frame) as Record<string, unknown> | undefined;
}

describe("bash-jobs-panel StatusInfo.bashJobs wire schema (包 A0 freeze)", () => {
  it("status frame with a well-formed bashJobs body passes and keeps the field", () => {
    const decoded = decodedStatus({ t: "status", ...status, bashJobs: bashJobsWire });
    expect(decoded).toMatchObject({ t: "status", costUsd: 0.12 });
    expect(decoded?.bashJobs).toEqual(bashJobsWire);
    // omitted is optional — absent when nothing was dropped
    const { omitted: _omitted, ...withoutOmitted } = bashJobsWire;
    expect(decodedStatus({ t: "status", ...status, bashJobs: withoutOmitted })?.bashJobs).toEqual(withoutOmitted);
  });

  it("rows and the enclosing body stay open to unknown fields and future status values (D5/Q4)", () => {
    const withFuture = {
      ...bashJobsWire,
      futureBodyField: "kept",
      rows: [{ ...runningRow, status: "quarantined", futureRowField: "kept" }, doneRow, graceRow],
    };
    const decoded = decodedStatus({ t: "status", ...status, bashJobs: withFuture });
    expect(decoded?.bashJobs).toEqual(withFuture);
  });

  it("old hub accepts a new-agent frame bearing bashJobs (forward compat, no proto bump)", () => {
    // Exactly the StatusFrameSchema shape as it existed before bash-jobs-panel (no `bashJobs`
    // property; the frame schema has never been additionalProperties:false) — replaying the
    // OLD hub's decoder pins the upgrade path: new agent + old hub coexist.
    const legacyStatusFrameSchema = Type.Object({
      t: Type.Literal("status"),
      leafId: Type.Union([Type.String(), Type.Null()]),
      busy: Type.Boolean(),
      pending: Type.Boolean(),
      contextUsage: Type.Optional(
        Type.Object({ tokens: Type.Number(), contextWindow: Type.Number(), percent: Type.Number() }),
      ),
      costUsd: Type.Optional(Type.Number()),
      subagentCostUsd: Type.Optional(Type.Number()),
      queue: Type.Optional(
        Type.Array(Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: true })),
      ),
      queueDropped: Type.Optional(Type.Array(Type.String())),
      todo: Type.Optional(Type.Object({ tasks: Type.Array(Type.Unknown()) }, { additionalProperties: true })),
      worktrees: Type.Optional(Type.Object({ rows: Type.Array(Type.Unknown()) }, { additionalProperties: true })),
    });
    const frame = { t: "status", ...status, bashJobs: bashJobsWire };
    expect(Value.Check(legacyStatusFrameSchema, frame)).toBe(true);
    expect(decodeAgentFrame(frame)).toBeDefined();
  });

  it("new hub accepts an old-agent frame with no bashJobs field (backward compat)", () => {
    const decoded = decodeAgentFrame({ t: "status", ...status }) as Extract<AgentFrame, { t: "status" }> | undefined;
    expect(decoded).toMatchObject({ t: "status", leafId: "abc123" });
    expect(decoded?.bashJobs).toBeUndefined();
  });

  it("status frame with a malformed bashJobs body is rejected whole", () => {
    expect(decodedStatus({ t: "status", ...status, bashJobs: 5 })).toBeUndefined();
    expect(decodedStatus({ t: "status", ...status, bashJobs: "x" })).toBeUndefined();
    expect(decodedStatus({ t: "status", ...status, bashJobs: {} })).toBeUndefined(); // missing rows/total/running/failed/sampledAt
    expect(decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, rows: "nope" } })).toBeUndefined();
    expect(decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, total: -1 } })).toBeUndefined();
    expect(
      decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, rows: [{ id: "j" }] } }),
    ).toBeUndefined(); // row missing cmd/status/exitCode/createdAt/elapsedMs/logBytes
    expect(
      decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, exitCode: "0" }] } }),
    ).toBeUndefined();
    expect(
      decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, cmdTruncated: 1 }] } }),
    ).toBeUndefined();
    expect(
      decodedStatus({
        t: "status",
        ...status,
        bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, tailCurrent: false }] },
      }),
    ).toBeUndefined(); // flag slots are literal `true`, not booleans
    expect(decodedStatus({ t: "status", ...status })).toBeDefined(); // pre-feature shape stays valid
  });

  it("rejects beyond the hard safety bounds (wider than the projection, plan §2)", () => {
    // rows maxItems 64 (projection cap is 20, D1)
    expect(
      decodedStatus({
        t: "status",
        ...status,
        bashJobs: { ...bashJobsWire, rows: Array.from({ length: 65 }, () => runningRow) },
      }),
    ).toBeUndefined();
    expect(
      decodedStatus({
        t: "status",
        ...status,
        bashJobs: { ...bashJobsWire, rows: Array.from({ length: 64 }, () => runningRow) },
      }),
    ).toBeDefined();
    // cmd maxLength 1024 (projection caps at 200 chars / 600 B, D6)
    expect(
      decodedStatus({
        t: "status",
        ...status,
        bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, cmd: "x".repeat(1025) }] },
      }),
    ).toBeUndefined();
    // tail maxLength 8192 (projection caps at 1024 B / 10 lines, D6)
    expect(
      decodedStatus({
        t: "status",
        ...status,
        bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, tail: "x".repeat(8193) }] },
      }),
    ).toBeUndefined();
    // status maxLength 32
    expect(
      decodedStatus({
        t: "status",
        ...status,
        bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, status: "s".repeat(33) }] },
      }),
    ).toBeUndefined();
    // negative counts / byte sizes / elapsed are malformed
    expect(decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, running: -1 } })).toBeUndefined();
    expect(
      decodedStatus({ t: "status", ...status, bashJobs: { ...bashJobsWire, rows: [{ ...doneRow, logBytes: -8 }] } }),
    ).toBeUndefined();
  });

  it("snapshot_reply carries status.bashJobs through", () => {
    const reply = {
      t: "snapshot_reply",
      rid: "r1",
      seq: 7,
      leafId: "leaf1",
      recent: [],
      prompts: [],
      status: { leafId: "leaf1", busy: false, pending: false, bashJobs: bashJobsWire },
      fleet: [],
    };
    const decoded = decodedStatus(reply);
    expect(decoded).toMatchObject({ t: "snapshot_reply", rid: "r1" });
    expect((decoded?.status as { bashJobs?: unknown }).bashJobs).toEqual(bashJobsWire);
    expect(decodeAgentFrame({ ...reply, status: { ...reply.status, bashJobs: { rows: "nope" } } })).toBeUndefined();
  });

  it("frozen property-key sets: exact names, and no logPath anywhere (v2 cut, D2)", () => {
    expect(Object.keys(BashJobRowSchema.properties as Record<string, unknown>).sort()).toEqual(
      [
        "id",
        "cmd",
        "cmdTruncated",
        "status",
        "exitCode",
        "createdAt",
        "endedAt",
        "elapsedMs",
        "logBytes",
        "logTruncated",
        "grace",
        "tail",
        "tailAt",
        "tailBytes",
        "tailUnavailable",
        "tailCurrent",
      ].sort(),
    );
    expect(Object.keys(BashJobsWireSchema.properties as Record<string, unknown>).sort()).toEqual(
      ["rows", "total", "running", "failed", "omitted", "sampledAt"].sort(),
    );
    expect(BashJobRowSchema.properties).not.toHaveProperty("logPath");
    expect(BashJobsWireSchema.properties).not.toHaveProperty("logPath");
  });
});
