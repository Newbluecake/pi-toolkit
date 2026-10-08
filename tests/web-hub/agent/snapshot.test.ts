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

  it("D2-7 (web-hub-session-switch plan §2.2 step 4): backfills sessionId read in the same tick; a throwing getter or empty string omits it", () => {
    const { ctx } = fakeCtx({ sessionId: "sess-1" });
    const reply = buildSnapshotReply("r1", {
      seq: 0,
      ctx,
      tap: noopTap(),
      status: { leafId: null, busy: false, pending: false },
      fleet: [],
    });
    expect(reply.sessionId).toBe("sess-1");

    const throwing = {
      sessionManager: {
        getLeafId: () => "L1",
        getSessionFile: () => "/tmp/s.jsonl",
        getSessionId: () => {
          throw new Error("stale");
        },
      },
    } as never;
    const r2 = buildSnapshotReply("r2", {
      seq: 0,
      ctx: throwing,
      tap: noopTap(),
      status: { leafId: null, busy: false, pending: false },
      fleet: [],
    });
    expect(r2.sessionId).toBeUndefined();

    const empty = fakeCtx({ sessionId: "" });
    const r3 = buildSnapshotReply("r3", {
      seq: 0,
      ctx: empty.ctx,
      tap: noopTap(),
      status: { leafId: null, busy: false, pending: false },
      fleet: [],
    });
    expect(r3.sessionId).toBeUndefined();
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

  // todo-web plan §3.3/§7 (T3): the optional 5th seam — a getter ⇒ sampled
  // projection in the same frame; no getter / empty list ⇒ the `todo` key is
  // absent (toEqual pins key-level absence, not just undefined-vs-null).
  it("readStatus: todo getter ⇒ status.todo sampled atomically; empty/absent ⇒ key missing", () => {
    const { ctx } = fakeCtx({ leaf: "L9" });
    const tap = noopTap();
    tap.resetForSession(Number.NaN);
    const populated = {
      tasks: [
        {
          id: 1,
          subject: "s",
          description: "d",
          status: "pending" as const,
          blocks: [],
          blockedBy: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      nextId: 2,
    };
    const s = readStatus(ctx, tap, [], undefined, () => populated);
    expect(s.todo).toMatchObject({
      tasks: [{ id: 1, subject: "s", status: "pending" }],
      total: 1,
      counts: { open: 1, inProgress: 0, completed: 0, blocked: 0 },
    });

    const emptied = readStatus(ctx, tap, [], undefined, () => ({ tasks: [], nextId: 2 }));
    expect("todo" in emptied).toBe(false);

    const noGetter = readStatus(ctx, tap, []);
    expect("todo" in noGetter).toBe(false);
  });

  // worktree-web plan §4.4/§7 (W3): the optional 6th seam, same sampled-atomically /
  // key-absence-on-undefined posture as the todo seam above.
  it("readStatus: worktrees getter ⇒ status.worktrees sampled atomically; undefined/no getter ⇒ key missing", () => {
    const { ctx } = fakeCtx({ leaf: "L9" });
    const tap = noopTap();
    tap.resetForSession(Number.NaN);
    const wire = {
      rows: [{ label: "~/repo", path: "/home/u/repo", main: true as const, current: true as const }],
      total: 1,
      probed: 0,
      dirtyCount: 0,
      agentCount: 0,
      sampledAt: 123,
    };
    const s = readStatus(ctx, tap, [], undefined, undefined, () => wire);
    expect(s.worktrees).toEqual(wire);

    const absent = readStatus(ctx, tap, [], undefined, undefined, () => undefined);
    expect("worktrees" in absent).toBe(false);

    const noGetter = readStatus(ctx, tap, []);
    expect("worktrees" in noGetter).toBe(false);
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
    // web-hub-steer-recall §4.7 step 9: the live transition itself republishes the status slot
    // (after the slot replay), so the handshake burst ends with a second `status` frame.
    expect(afterAck.map((f) => f.t)).toEqual(["hello", "session", "status", "fleet", "status"]);
    expect(afterAck[2]).toMatchObject({ leafId: "B" });
    expect((afterAck[3]!.runs as unknown[]).length).toBe(1);

    const count = (t: string) => s.types().filter((x) => x === t).length;
    await vi.advanceTimersByTimeAsync(3_000); // leaf unchanged, fleet only jitters
    expect(count("status")).toBe(2);
    expect(count("fleet")).toBe(1);
    state.leaf = "C"; // idle custom_message appended ⇒ leaf moves without any extension event
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count("status")).toBe(3);
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

  // worktree-web plan §4.4/§7 (W3): `onSnapshotReq`'s `readStatus(...)` call also threads the
  // worktrees getter — a snapshot_reply's embedded status must carry whatever the sampler's
  // cache held at that instant, same as the live status slot would.
  it("snapshot_reply.status.worktrees matches what the status slot would carry", async () => {
    const n = fakeNet();
    const { pi, fire } = fakePi();
    const run = (async (args: readonly string[]) => {
      if (args.includes("rev-parse")) return { code: 0, stdout: "/repo\n", stdoutCapped: false, stderr: "" };
      if (args.includes("list")) {
        return {
          code: 0,
          stdout: `worktree /repo\nHEAD ${"a".repeat(40)}\nbranch refs/heads/master\n\n`,
          stdoutCapped: false,
          stderr: "",
        };
      }
      return { code: 0, stdout: "# branch.head master\n", stdoutCapped: false, stderr: "" };
    }) as unknown as import("../../../src/git/run.js").GitRunner;
    wireWebHub(pi, {
      settings: SETTINGS,
      fleet: () => [],
      env: { HOME: tmp.dir },
      paths: pathsIn(tmp.dir),
      netConnect: n.netConnect,
      gitRunner: run,
      gitRealpath: async (p: string) => p,
      buildInfo: async () => ({ pluginVersion: "1", buildId: "1@t" }),
      argv1: "/none",
    });
    const { ctx } = fakeCtx({ leaf: "A" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const s = n.sockets[0]!;
    s.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s.hub(ackFrame());
    await vi.advanceTimersByTimeAsync(1_000); // first tick-driven scan after the link goes live
    for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0); // drain the scan's microtask chain
    const lastStatus = s
      .frames()
      .filter((f) => f.t === "status")
      .at(-1) as { worktrees?: unknown };
    expect(lastStatus.worktrees).toMatchObject({ rows: [expect.objectContaining({ label: "/repo" })] });

    s.hub({ t: "snapshot_req", rid: "r1" });
    await vi.advanceTimersByTimeAsync(0);
    const reply = s.frames().find((f) => f.t === "snapshot_reply") as { status?: { worktrees?: unknown } };
    expect(reply.status?.worktrees).toEqual(lastStatus.worktrees);
  });
});
