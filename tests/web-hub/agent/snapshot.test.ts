import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDiagnostics, RunSnapshot } from "../../../src/core/types.js";
import { createEventTap } from "../../../src/web-hub/agent/event-tap.js";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { buildBranchReply, buildSnapshotReply } from "../../../src/web-hub/agent/snapshot.js";
import { fleetFingerprint, projectFleet, readStatus } from "../../../src/web-hub/agent/status.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import { LIMITS } from "../../../src/web-hub/protocol/messages.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...overrides,
  };
}

function snap(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    generation: 1,
    status: "running",
    phase: "tool_exec",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag({
      label: "explore",
      model: { provider: "p", id: "m" },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 },
      toolHistory: [{ name: "bash", toolCallId: "t1", startedAt: 1_000, argsPreview: "npm test" }],
    }),
    updatedAt: 0,
    ...overrides,
  };
}

const noopTap = () =>
  createEventTap(() => undefined, { now: () => 0, setTimer: () => ({ cancel: () => undefined }), currentSeq: () => 0 });

describe("buildSnapshotReply", () => {
  it("leafId/seq sampled in the same tick; status.leafId aligned; recent/prompts/inflight from the tap", () => {
    const { ctx } = fakeCtx({ leaf: "L7" });
    let seq = 0;
    const tap = createEventTap(() => void (seq += 1), {
      now: () => 5,
      setTimer: () => ({ cancel: () => undefined }),
      currentSeq: () => seq,
    });
    tap.handle({ type: "message_end", message: { role: "user", timestamp: 3 } });
    tap.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    tap.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
    const reply = buildSnapshotReply("r1", {
      seq,
      ctx,
      tap,
      status: { leafId: "stale", busy: true, pending: false },
      fleet: [],
    });
    expect(reply).toMatchObject({
      t: "snapshot_reply",
      rid: "r1",
      seq: 3,
      leafId: "L7",
      sessionFile: "/tmp/fake-session.jsonl",
      recent: [{ seq: 1, message: { role: "user", timestamp: 3 } }],
      prompts: [{ kind: "custom", since: 5 }],
      inflight: { tools: [{ toolCallId: "c1", toolName: "bash", args: { command: "ls" } }] },
    });
    expect(reply.status.leafId).toBe("L7");
  });

  it("a stale ctx (throws) degrades to leafId null instead of throwing", () => {
    const ctx = {
      sessionManager: {
        getLeafId: () => {
          throw new Error("stale");
        },
        getSessionFile: () => {
          throw new Error("stale");
        },
      },
    } as never;
    const reply = buildSnapshotReply("r", {
      seq: 0,
      ctx,
      tap: noopTap(),
      status: { leafId: null, busy: false, pending: false },
      fleet: [],
    });
    expect(reply.leafId).toBeNull();
    expect(reply.sessionFile).toBeUndefined();
  });
});

describe("buildBranchReply", () => {
  const entry = (i: number, text: string) => ({
    type: "message",
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: { role: "user", timestamp: i, content: text },
  });

  it("projects getBranch() entries exactly like the hub (projectSessionEntry); drops non-projectable rows", () => {
    const branch = [{ type: "session", id: "s", timestamp: "t" }, entry(0, "a"), entry(1, "b")];
    const { ctx } = fakeCtx({ branch });
    const reply = buildBranchReply("r", ctx, LIMITS.branchReplyBytes);
    expect(reply.truncated).toBe(false);
    expect(reply.entries).toEqual([projectSessionEntry(branch[1]), projectSessionEntry(branch[2])]);
  });

  it("over 2 MiB ⇒ keeps the tail within budget and marks truncated", () => {
    const chunk = "z".repeat(60 * 1024);
    const branch = Array.from({ length: 60 }, (_, i) => entry(i, chunk)); // ≈ 3.6 MiB
    const { ctx } = fakeCtx({ branch });
    const reply = buildBranchReply("r", ctx, 8 << 20); // hub asks for more than the cap
    expect(reply.truncated).toBe(true);
    expect(reply.entries.at(-1)!.id).toBe("e59");
    const bytes = reply.entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(LIMITS.branchReplyBytes);
    expect(reply.entries.length).toBeGreaterThan(20);
    const small = buildBranchReply("r", ctx, 200 * 1024);
    expect(small.entries.length).toBeLessThanOrEqual(3);
    expect(small.truncated).toBe(true);
  });
});

describe("projectFleet / fleetFingerprint / readStatus", () => {
  it("projects the fleet widget view-model onto the wire subset", () => {
    const rows = projectFleet([snap({ parentRunId: "parent-1" })], 5_000, () => "Explore");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      label: "explore",
      type: "Explore",
      model: "p/m",
      status: "running",
      phaseLabel: "🔧工具",
      parentRunId: "parent-1",
      elapsedMs: 5_000,
      costUsd: 0.25,
      toolTrail: "▸bash npm test · 4s",
      highlight: "none",
      terminal: false,
    });
  });

  it("per-second jitter (elapsed/phase ages, live tool duration, thinking frame) does not change the fingerprint", () => {
    const thinking = snap({ phase: "model_turn", diag: { ...snap().diag, phase: "model_turn" } });
    const a = fleetFingerprint(projectFleet([snap(), thinking], 5_000));
    const b = fleetFingerprint(projectFleet([snap(), thinking], 6_000));
    const c = fleetFingerprint(projectFleet([snap(), thinking], 65_000));
    expect(b).toBe(a);
    expect(c).toBe(a);
    const done = fleetFingerprint(projectFleet([snap({ status: "completed", phase: "settled" }), thinking], 6_000));
    expect(done).not.toBe(a);
  });

  it("readStatus: busy/pending/context/cost/subagent cost; cost omitted while unknown", () => {
    const { ctx, state } = fakeCtx({ leaf: "L1", idle: false });
    const tap = noopTap();
    tap.resetForSession(Number.NaN);
    const s1 = readStatus(ctx, tap, [snap()]);
    expect(s1).toEqual({
      leafId: "L1",
      busy: true,
      pending: false,
      contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
      subagentCostUsd: 0.25,
    });
    tap.setBaseCost(2);
    state.idle = true;
    expect(readStatus(ctx, tap, [])).toMatchObject({ busy: false, costUsd: 2 });
  });
});

describe("leaf probe + slots (wiring, fake timers)", () => {
  let tmp: ReturnType<typeof tmpDir>;
  beforeEach(() => {
    tmp = tmpDir("wh-d-snap-");
    resetGlobals();
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetGlobals();
    vi.useRealTimers();
    tmp.cleanup();
  });

  it("status only on leaf change; before live only the slot is written (replayed on hello_ack)", async () => {
    const n = fakeNet();
    const { pi, fire } = fakePi();
    let snaps: RunSnapshot[] = [];
    wireWebHub(pi, {
      settings: SETTINGS,
      fleet: () => snaps,
      env: { HOME: tmp.dir },
      paths: pathsIn(tmp.dir),
      netConnect: n.netConnect,
      buildInfo: async () => ({ pluginVersion: "1", buildId: "1@t" }),
      argv1: "/none",
    });
    const { ctx, state } = fakeCtx({ leaf: "A" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(n.calls()).toBe(1);
    const s = n.sockets[0]!;
    s.emit("connect"); // handshaking: only hello goes out
    state.leaf = "B";
    snaps = [snap()];
    await vi.advanceTimersByTimeAsync(1_000); // tick while not live
    expect(s.types()).toEqual(["hello"]);
    s.hub(ackFrame());
    const afterAck = s.frames();
    expect(afterAck.map((f) => f.t)).toEqual(["hello", "session", "status", "fleet"]);
    expect(afterAck[2]).toMatchObject({ leafId: "B" });
    expect((afterAck[3]!.runs as unknown[]).length).toBe(1);

    const count = (t: string) => s.types().filter((x) => x === t).length;
    await vi.advanceTimersByTimeAsync(3_000); // leaf unchanged, fleet only jitters
    expect(count("status")).toBe(1);
    expect(count("fleet")).toBe(1);
    state.leaf = "C"; // idle custom_message appended ⇒ leaf moves without any extension event
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count("status")).toBe(2);
    expect(
      s
        .frames()
        .filter((f) => f.t === "status")
        .at(-1),
    ).toMatchObject({ leafId: "C" });
    snaps = [];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count("fleet")).toBe(2);
  });
});
