import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  FORWARDED_EVENTS,
  LIMITS,
  TIMING,
  decodeAgentFrame,
  decodeHubFrame,
  type AgentFrame,
  type HubFrame,
} from "../../../src/web-hub/protocol/messages.js";
import { MAX_FRAME_BYTES } from "../../../src/web-hub/protocol/ndjson.js";
import { RUN_TX_REASONS } from "../../../src/web-hub/protocol/run-transcript.js";
import { RESERVED_FRAME_TYPES } from "../../../src/web-hub/protocol/version.js";

const nonce16 = "abcdefghijklmnop";
const nonce64 = "a".repeat(64);

function hello(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: "hello",
    proto: { major: 1, minor: 0 },
    pluginVersion: "0.2.1",
    buildId: "abc123",
    agentId: { pid: 1234, nonce: nonce16 },
    epoch: "inst-1",
    kind: "tui",
    launcher: ["node", "/usr/bin/node"],
    cwd: "/tmp/wa",
    caps: ["ev.v1", "fleet.v1"],
    ...over,
  };
}

const status = {
  leafId: "abc123",
  busy: true,
  pending: false,
  contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
  costUsd: 0.12,
  subagentCostUsd: 0.01,
};

const fleetRow = {
  runId: "run_1",
  label: "explore",
  type: "Explore",
  model: "zai/glm-5.3",
  status: "running",
  phaseLabel: "searching",
  elapsedMs: 1200,
  phaseMs: 300,
  costUsd: 0.02,
  toolTrail: "rg×2",
  streamLine: "reading plan.md",
  highlight: "none",
  terminal: false,
} as const;

describe("decodeAgentFrame", () => {
  it("accepts a valid hello", () => {
    const f = decodeAgentFrame(hello());
    expect(f).toMatchObject({ t: "hello", kind: "tui" });
    expect((f as Extract<AgentFrame, { t: "hello" }>).agentId).toEqual({ pid: 1234, nonce: nonce16 });
  });

  it("accepts a 64-char nonce and rpc kind + optional ticket", () => {
    const f = decodeAgentFrame(hello({ agentId: { pid: 1, nonce: nonce64 }, kind: "rpc", ticket: "tk_1" }));
    expect(f).toMatchObject({ t: "hello", kind: "rpc", ticket: "tk_1" });
  });

  it("rejects hello with bad nonce length / charset / pid", () => {
    expect(decodeAgentFrame(hello({ agentId: { pid: 1, nonce: "a".repeat(15) } }))).toBeUndefined();
    expect(decodeAgentFrame(hello({ agentId: { pid: 1, nonce: "a".repeat(65) } }))).toBeUndefined();
    expect(decodeAgentFrame(hello({ agentId: { pid: 1, nonce: "bad+nonce+chars!!" } }))).toBeUndefined();
    expect(decodeAgentFrame(hello({ agentId: { pid: "1234", nonce: nonce16 } }))).toBeUndefined();
  });

  it("rejects hello with missing / mistyped strict fields", () => {
    for (const over of [
      { pluginVersion: 1 },
      { buildId: undefined },
      { epoch: 7 },
      { launcher: ["node"] },
      { launcher: "node" },
      { cwd: null },
      { caps: "ev.v1" },
      { proto: { major: "1", minor: 0 } },
    ]) {
      expect(decodeAgentFrame(hello(over))).toBeUndefined();
    }
    const { cwd: _omit, ...noCwd } = hello() as Record<string, unknown>;
    expect(decodeAgentFrame(noCwd)).toBeUndefined();
  });

  it("tolerates an explicitly-undefined optional field (never occurs on the JSON wire)", () => {
    // exactOptionalPropertyTypes 下“缺省可过”：JSON 序列化不产生 undefined 值，
    // typebox Optional 对显式 undefined 也放行，decode 不为此加额外惩罚。
    expect(decodeAgentFrame(hello({ ticket: undefined }))).toMatchObject({ t: "hello" });
  });

  it("accepts bye / session / session_detached", () => {
    expect(decodeAgentFrame({ t: "bye", reason: "quit" })).toMatchObject({ t: "bye", reason: "quit" });
    expect(decodeAgentFrame({ t: "bye", reason: "handover" })).toBeDefined();
    expect(decodeAgentFrame({ t: "bye", reason: "anything-custom" })).toBeDefined();
    expect(
      decodeAgentFrame({
        t: "session",
        sessionId: "s1",
        cwd: "/tmp/wa",
        reason: "startup",
        leafId: "leaf1",
        mode: "tui",
      }),
    ).toMatchObject({ t: "session", sessionId: "s1" });
    expect(
      decodeAgentFrame({
        t: "session",
        sessionId: "s1",
        sessionFile: "/a.jsonl",
        name: "wa",
        cwd: "/tmp/wa",
        reason: "resume",
        leafId: null,
        model: { provider: "zai", id: "glm-5.3" },
        thinkingLevel: "high",
        mode: "rpc",
      }),
    ).toMatchObject({ t: "session", model: { provider: "zai", id: "glm-5.3" } });
    expect(
      decodeAgentFrame({ t: "session", sessionId: "s1", cwd: "/a", reason: "x", leafId: "l", mode: "bogus" }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "session_detached", reason: "session_shutdown" })).toBeDefined();
    expect(decodeAgentFrame({ t: "session_detached" })).toBeUndefined();
  });

  it("accepts ev with whitelisted type and passes payload through unchecked", () => {
    const payload = {
      t: "ev",
      seq: 42,
      e: { type: "message_end", role: "assistant", timestamp: 1, extra: { deep: true } },
    };
    expect(decodeAgentFrame(payload)).toEqual(payload);
  });

  it("rejects ev with non-whitelisted event type or bad seq", () => {
    expect(decodeAgentFrame({ t: "ev", seq: 1, e: { type: "not_an_event" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "ev", seq: 1, e: { kind: "no type" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "ev", seq: 1.5, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "ev", e: { type: "turn_end" } })).toBeUndefined();
  });

  it("accepts status (minimal and full) and rejects missing busy/pending", () => {
    expect(decodeAgentFrame({ t: "status", leafId: null, busy: false, pending: false })).toMatchObject({ t: "status" });
    expect(decodeAgentFrame({ t: "status", ...status })).toMatchObject({ t: "status", costUsd: 0.12 });
    expect(decodeAgentFrame({ t: "status", leafId: "x", busy: true })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", leafId: 5, busy: true, pending: false })).toBeUndefined();
  });

  // todo-web plan §3.1/§7 (T2): StatusInfo.todo rides the existing status frame —
  // no new frame kind, no proto bump. The nested schema pins the wire shape
  // (QueueItemSchema posture); the enclosing StatusFrameSchema stays open-ended
  // so OLDER hubs (whose schema predates the field) pass the newer frame through.
  const todoWire = {
    tasks: [
      {
        id: 1,
        subject: "wire the todo snapshot",
        status: "in_progress",
        activeForm: "wiring the todo snapshot",
        blockedBy: [2],
        description: "desc",
        descTruncated: true,
      },
      { id: 2, subject: "plan", status: "completed", blockedBy: [] },
    ],
    total: 2,
    counts: { open: 0, inProgress: 1, completed: 1, blocked: 0 },
    updatedAt: 1790000000000,
  } as const;

  it("status frame with a well-formed todo passes and keeps the field", () => {
    const decoded = decodeAgentFrame({ t: "status", ...status, todo: todoWire });
    expect(decoded).toMatchObject({ t: "status", costUsd: 0.12 });
    expect((decoded as { todo?: unknown }).todo).toEqual(todoWire);
  });

  it("status frame with a malformed todo is rejected whole; omitted todo still passes", () => {
    expect(decodeAgentFrame({ t: "status", ...status, todo: 5 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, todo: "x" })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, todo: {} })).toBeUndefined(); // missing tasks/total/counts
    expect(decodeAgentFrame({ t: "status", ...status, todo: { ...todoWire, counts: { open: 1 } } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status })).toBeDefined(); // pre-feature shape stays valid
  });

  it("forward compatibility: the pre-todo hub schema (open-ended top level) passes a todo-bearing frame", () => {
    // Exactly the StatusFrameSchema shape as it existed before todo-web (no `todo`
    // property, no additionalProperties:false) — replaying the old hub's decoder here
    // pins the upgrade path: new agent + old hub coexist without a proto bump.
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
    });
    const frame = { t: "status", ...status, todo: todoWire };
    expect(Value.Check(legacyStatusFrameSchema, frame)).toBe(true);
    // and the current schema of course accepts its own frame
    expect(decodeAgentFrame(frame)).toBeDefined();
  });

  it("accepts fleet and validates row shape", () => {
    expect(decodeAgentFrame({ t: "fleet", runs: [fleetRow] })).toMatchObject({ t: "fleet" });
    expect(decodeAgentFrame({ t: "fleet", runs: [{ ...fleetRow, highlight: "bogus" }] })).toBeUndefined();
    expect(decodeAgentFrame({ t: "fleet", runs: [{ ...fleetRow, terminal: "yes" }] })).toBeUndefined();
    expect(decodeAgentFrame({ t: "fleet", runs: [] })).toMatchObject({ t: "fleet", runs: [] });
  });

  it("accepts snapshot_reply with recent/inflight/prompts and rejects malformed nested parts", () => {
    const reply = {
      t: "snapshot_reply",
      rid: "r1",
      seq: 7,
      leafId: "leaf1",
      sessionFile: "/a.jsonl",
      recent: [
        { seq: 5, message: { role: "assistant", timestamp: 1790342523472, content: "hi" } },
        { seq: 6, message: { role: "custom", customType: "probe:custom", content: "hello" } },
      ],
      inflight: {
        message: { role: "assistant", content: "partial" },
        tools: [{ toolCallId: "c1", toolName: "read", args: { path: "a" }, partial: "…" }],
      },
      prompts: [
        { kind: "select", title: "pick", since: 1790342500000 },
        { kind: "custom", since: 1790342500001 },
      ],
      status: { leafId: "leaf1", busy: false, pending: false },
      fleet: [fleetRow],
    };
    expect(decodeAgentFrame(reply)).toMatchObject({ t: "snapshot_reply", rid: "r1", seq: 7 });
    expect(decodeAgentFrame({ ...reply, recent: [{ seq: 1, message: { role: 3 } }] })).toBeUndefined();
    expect(decodeAgentFrame({ ...reply, prompts: [{ kind: "select" }] })).toBeUndefined();
    expect(decodeAgentFrame({ ...reply, inflight: { tools: [{ toolCallId: "c" }] } })).toBeUndefined();
  });

  it("snapshot_reply carries status.todo through (todo-web T2)", () => {
    const reply = {
      t: "snapshot_reply",
      rid: "r1",
      seq: 7,
      leafId: "leaf1",
      recent: [],
      prompts: [],
      status: { leafId: "leaf1", busy: false, pending: false, todo: todoWire },
      fleet: [],
    };
    const decoded = decodeAgentFrame(reply) as { status?: { todo?: unknown } } | undefined;
    expect(decoded).toMatchObject({ t: "snapshot_reply", rid: "r1" });
    expect(decoded?.status?.todo).toEqual(todoWire);
    expect(decodeAgentFrame({ ...reply, status: { ...reply.status, todo: { tasks: "nope" } } })).toBeUndefined();
  });

  // worktree-web plan §3.2/§7 (W2): StatusInfo.worktrees rides the same open-ended status frame
  // as todo/models. Unlike TodoWireSchema, the nested worktree schemas stay OPEN
  // (additionalProperties: true, Q4) — see WorktreeRowWire's docstring for why.
  const worktreesWire = {
    rows: [
      {
        label: "~/ai/pi-toolkit",
        path: "/home/u/ai/pi-toolkit",
        branch: "master",
        head: "abc1234",
        current: true,
        main: true,
        dirty: 0,
      },
      {
        label: "~/ai/pi-toolkit.wt/x",
        path: "/home/u/ai/pi-toolkit.wt/x",
        branch: "pi-agent-r1",
        head: "def5678",
        agentRunId: "r1",
        dirty: 2,
        ahead: 1,
        behind: 0,
      },
    ],
    total: 2,
    probed: 2,
    dirtyCount: 1,
    agentCount: 1,
    sampledAt: 1790000000000,
  } as const;

  it("status frame with a well-formed worktrees body passes and keeps the field", () => {
    const decoded = decodeAgentFrame({ t: "status", ...status, worktrees: worktreesWire });
    expect(decoded).toMatchObject({ t: "status", costUsd: 0.12 });
    expect((decoded as { worktrees?: unknown }).worktrees).toEqual(worktreesWire);
  });

  it("worktree rows and the enclosing body stay open to unknown fields (Q4)", () => {
    const withFuture = {
      ...worktreesWire,
      staleMin: 3,
      futureBodyField: "kept",
      rows: [{ ...worktreesWire.rows[0], unprobed: "slow-fs", futureRowField: "kept" }],
    };
    const decoded = decodeAgentFrame({ t: "status", ...status, worktrees: withFuture }) as
      { worktrees?: unknown } | undefined;
    expect(decoded?.worktrees).toEqual(withFuture);
  });

  it("status frame with a malformed worktrees body is rejected whole; omitted worktrees still passes", () => {
    expect(decodeAgentFrame({ t: "status", ...status, worktrees: 5 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status, worktrees: { ...worktreesWire, rows: "nope" } })).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "status", ...status, worktrees: { ...worktreesWire, rows: [{ label: "x", dirty: -1 }] } }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({
        t: "status",
        ...status,
        worktrees: { ...worktreesWire, rows: [{ label: "x", path: "a".repeat(4097) }] },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({
        t: "status",
        ...status,
        worktrees: { ...worktreesWire, rows: Array.from({ length: 65 }, () => ({ label: "x" })) },
      }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "status", ...status })).toBeDefined(); // pre-feature shape stays valid
  });

  it("snapshot_reply carries status.worktrees through (worktree-web W2)", () => {
    const reply = {
      t: "snapshot_reply",
      rid: "r1",
      seq: 7,
      leafId: "leaf1",
      recent: [],
      prompts: [],
      status: { leafId: "leaf1", busy: false, pending: false, worktrees: worktreesWire },
      fleet: [],
    };
    const decoded = decodeAgentFrame(reply) as { status?: { worktrees?: unknown } } | undefined;
    expect(decoded).toMatchObject({ t: "snapshot_reply", rid: "r1" });
    expect(decoded?.status?.worktrees).toEqual(worktreesWire);
    expect(decodeAgentFrame({ ...reply, status: { ...reply.status, worktrees: { rows: "nope" } } })).toBeUndefined();
  });

  it("accepts branch_reply with loose WireEntry payloads", () => {
    const entry = {
      id: "e1",
      parentId: null,
      type: "custom_message",
      timestamp: "2026-09-25T13:21:25.409Z",
      customType: "probe:custom",
      content: "hello",
      display: true,
    };
    expect(decodeAgentFrame({ t: "branch_reply", rid: "r2", entries: [entry], truncated: false })).toMatchObject({
      t: "branch_reply",
      rid: "r2",
    });
    expect(
      decodeAgentFrame({
        t: "branch_reply",
        rid: "r2",
        entries: [{ ...entry, type: "context_edit" }],
        truncated: false,
      }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "branch_reply", rid: "r2", entries: [entry] })).toBeUndefined();
  });

  it("accepts gap / ping / pong", () => {
    expect(decodeAgentFrame({ t: "gap", fromSeq: 3 })).toBeDefined();
    expect(decodeAgentFrame({ t: "gap", fromSeq: "3" })).toBeUndefined();
    expect(decodeAgentFrame({ t: "ping", ts: 1790342523472 })).toBeDefined();
    expect(decodeAgentFrame({ t: "pong", ts: 1790342523472.5 })).toBeDefined();
  });

  it("returns undefined for unknown / reserved / non-object frames", () => {
    expect(decodeAgentFrame({ t: "bogus" })).toBeUndefined();
    for (const t of RESERVED_FRAME_TYPES) {
      expect(decodeAgentFrame({ t, anything: true })).toBeUndefined();
    }
    expect(decodeAgentFrame(null)).toBeUndefined();
    expect(decodeAgentFrame("hello")).toBeUndefined();
    expect(decodeAgentFrame([hello()])).toBeUndefined();
    expect(decodeAgentFrame({})).toBeUndefined();
    expect(decodeAgentFrame(42)).toBeUndefined();
  });

  it("returns undefined for frames over the byte budget", () => {
    const big = { t: "ev", seq: 1, e: { type: "message_end", pad: "x".repeat(MAX_FRAME_BYTES) } };
    expect(decodeAgentFrame(big)).toBeUndefined();
  });
});

describe("decodeAgentFrame — dialogs closed.by (ask-user-async §7.2, P3)", () => {
  const dialogsFrame = (by: unknown) => ({
    t: "dialogs",
    epoch: "epoch-1",
    open: [],
    closed: [{ dialogId: "ask:1", by, outcome: "aborted", at: 1 }],
  });

  it("keeps accepting every historical by value (old agent against the new hub schema)", () => {
    for (const by of ["tui", "web", "abort", "session", "error"]) {
      expect(decodeAgentFrame(dialogsFrame(by))).toMatchObject({ t: "dialogs" });
    }
  });

  it("accepts the new background close value (new agent + new hub)", () => {
    expect(decodeAgentFrame(dialogsFrame("background"))).toMatchObject({
      t: "dialogs",
      closed: [{ dialogId: "ask:1", by: "background", outcome: "aborted" }],
    });
  });

  it("still rejects unknown by values and mistyped closed entries", () => {
    expect(decodeAgentFrame(dialogsFrame("bogus"))).toBeUndefined();
    expect(decodeAgentFrame({ t: "dialogs", epoch: "e", open: [], closed: [{ dialogId: "x" }] })).toBeUndefined();
    expect(decodeAgentFrame({ t: "dialogs", epoch: "e", open: [], closed: "none" })).toBeUndefined();
  });
});

describe("decodeHubFrame", () => {
  const helloAck = {
    t: "hello_ack",
    hubVersion: "0.2.1",
    buildId: "abc123",
    proto: { major: 1, minor: 0 },
    agentKey: "pid1234#nonce",
    pingMs: 10_000,
    leaseMs: 30_000,
    http: { port: 7878 },
  };

  it("accepts a valid hello_ack", () => {
    expect(decodeHubFrame(helloAck)).toMatchObject({ t: "hello_ack", http: { port: 7878 } });
  });

  it("rejects hello_ack with missing http.port or bad types", () => {
    const { http: _http, ...noHttp } = helloAck;
    expect(decodeHubFrame(noHttp)).toBeUndefined();
    expect(decodeHubFrame({ ...helloAck, pingMs: "10000" })).toBeUndefined();
    expect(decodeHubFrame({ ...helloAck, proto: { major: 1 } })).toBeUndefined();
  });

  it("accepts hello_reject with known codes and rejects unknown ones", () => {
    for (const code of ["E_PROTO", "E_BAD_HELLO", "E_TICKET"] as const) {
      expect(decodeHubFrame({ t: "hello_reject", code, message: "m", retryAfterMs: 500 })).toMatchObject({ code });
    }
    expect(decodeHubFrame({ t: "hello_reject", code: "E_OTHER", message: "m", retryAfterMs: 500 })).toBeUndefined();
  });

  it("accepts snapshot_req / branch_req / ping / pong", () => {
    expect(decodeHubFrame({ t: "snapshot_req", rid: "r1" })).toBeDefined();
    expect(decodeHubFrame({ t: "snapshot_req" })).toBeUndefined();
    expect(decodeHubFrame({ t: "branch_req", rid: "r1", maxBytes: 2 << 20 })).toBeDefined();
    expect(decodeHubFrame({ t: "branch_req", rid: "r1" })).toBeUndefined();
    expect(decodeHubFrame({ t: "ping", ts: 1 })).toBeDefined();
    expect(decodeHubFrame({ t: "pong", ts: 1 })).toBeDefined();
  });

  it("returns undefined for agent-only frame types on the hub side", () => {
    expect(decodeHubFrame(hello())).toBeUndefined();
    expect(decodeHubFrame({ t: "ev", seq: 1, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeHubFrame({ t: "cmd", x: 1 })).toBeUndefined();
  });

  it("round-trips both directions through encodeFrame-compatible JSON", () => {
    const agent: AgentFrame = { t: "ping", ts: 5 };
    expect(JSON.parse(JSON.stringify(agent))).toEqual(agent);
    // ping/pong exist in both unions; agent-only types must not decode on the hub side
    const bye: AgentFrame = { t: "bye", reason: "quit" };
    expect(decodeHubFrame(JSON.parse(JSON.stringify(bye)))).toBeUndefined();
    const ack: HubFrame = { t: "snapshot_req", rid: "r1" };
    expect(decodeAgentFrame(JSON.parse(JSON.stringify(ack)))).toBeUndefined();
  });
});

describe("constants", () => {
  it("FORWARDED_EVENTS matches the arch §4.1.1 whitelist", () => {
    expect([...FORWARDED_EVENTS]).toEqual([
      "agent_start",
      "agent_end",
      "agent_settled",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "session_compact",
      "session_compact_failed",
      "model_select",
      "thinking_level_select",
      "session_info_changed",
      "input",
      "ui_prompt_start",
      "ui_prompt_end",
    ]);
  });

  it("TIMING / LIMITS are pinned", () => {
    expect(TIMING).toEqual({
      connectMs: 1_000,
      helloAckMs: 2_000,
      pingMs: 10_000,
      silenceMs: 30_000,
      staleMs: 30_000,
      reapMs: 60_000,
      detachGraceMs: 10_000,
      snapshotMs: 5_000,
      backoffMinMs: 500,
      backoffMaxMs: 30_000,
      spawnThrottleMs: 30_000,
      spawnWindowMs: 8_000,
    });
    expect(LIMITS).toEqual({
      writeQueueBytes: 1 << 20,
      textTruncateBytes: 64 << 10,
      recentMessages: 64,
      branchReplyBytes: 2 << 20,
      hardQueueBytes: 4 << 20,
      deltaCoalesceMs: 50,
      toolUpdateMs: 250,
      fleetMs: 1_000,
    });
  });
});

// ---------------------------------------------------------------------------
// web-hub-fleet-drawer plan §3.1 (F0): run-transcript frames. Schema bodies live in
// protocol/run-transcript.ts and are folded into the two decode tables above; these tests
// pin decode behavior through the public entry points (including the local loose mirrors'
// accept/reject parity with ev / branch_reply / snapshot_reply).
// ---------------------------------------------------------------------------

describe("decodeAgentFrame — run-transcript frames (fleet-drawer §3.1, F0)", () => {
  const runId = "r_ABCD1234";
  const tapId = "tap0123456789ab";
  const runEntry = {
    id: "e1",
    parentId: null,
    type: "custom_message",
    timestamp: "2026-10-01T00:00:00.000Z",
    customType: "probe:custom",
    content: "hello",
    display: true,
  } as const;

  const liveReply = {
    t: "run_tx_reply",
    rid: "req-1",
    runId,
    ok: true,
    source: "live",
    status: "running",
    tapId,
    seq: 7,
    watching: true,
    entries: [runEntry],
    truncated: false,
    hasMore: true,
    inflight: {
      message: { role: "assistant", content: "partial" },
      tools: [{ toolCallId: "c1", toolName: "read", args: { path: "a" }, partial: "…" }],
    },
  };

  it("accepts the live snapshot reply (loose entries/inflight pass through)", () => {
    expect(decodeAgentFrame(liveReply)).toMatchObject({ t: "run_tx_reply", source: "live", seq: 7, watching: true });
    expect(decodeAgentFrame({ ...liveReply, tapId: undefined })).toMatchObject({ t: "run_tx_reply", tapId: undefined });
  });

  it("rejects malformed live replies", () => {
    for (const over of [
      { tapId: "bad id!" }, // TAP_ID_PATTERN
      { seq: 1.5 },
      { watching: "yes" },
      { entries: runEntry },
      { entries: [{ ...runEntry, type: "context_edit" }] },
      { inflight: { tools: [{ toolCallId: "c" }] } },
      { runId: "run_1" }, // RUN_ID_PATTERN
    ]) {
      expect(decodeAgentFrame({ ...liveReply, ...over })).toBeUndefined();
    }
    const { truncated: _t, ...noTruncated } = liveReply;
    expect(decodeAgentFrame(noTruncated)).toBeUndefined();
  });

  it("accepts the file reply and keeps the three branches mutually exclusive", () => {
    const fileReply = {
      t: "run_tx_reply",
      rid: "req-1",
      runId,
      ok: true,
      source: "file",
      status: "ok",
      sessionFile: "/home/u/.pi/sessions/a.jsonl",
      finalLeafId: "e9",
    };
    expect(decodeAgentFrame(fileReply)).toMatchObject({ t: "run_tx_reply", source: "file", finalLeafId: "e9" });
    // file branch without finalLeafId / sessionFile ⇒ no branch matches
    const { finalLeafId: _leaf, ...noLeaf } = fileReply;
    expect(decodeAgentFrame(noLeaf)).toBeUndefined();
    // live fields on the file branch (and vice versa) ⇒ rejected by additionalProperties:false
    expect(decodeAgentFrame({ ...fileReply, entries: [runEntry] })).toBeUndefined();
    expect(decodeAgentFrame({ ...liveReply, sessionFile: "/a.jsonl" })).toBeUndefined();
  });

  it("accepts every denial reason on both codes, and rejects anything else", () => {
    for (const code of ["E_NOT_FOUND", "E_UNSUPPORTED"] as const) {
      for (const reason of RUN_TX_REASONS) {
        expect(decodeAgentFrame({ t: "run_tx_reply", rid: "req-1", runId, ok: false, code, reason })).toMatchObject({
          ok: false,
          code,
          reason,
        });
      }
    }
    expect(
      decodeAgentFrame({ t: "run_tx_reply", rid: "r", runId, ok: false, code: "E_BUSY", reason: "busy" }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "run_tx_reply", rid: "r", runId, ok: false, code: "E_NOT_FOUND", reason: "bogus" }),
    ).toBeUndefined();
    expect(
      decodeAgentFrame({
        t: "run_tx_reply",
        rid: "r",
        runId,
        ok: false,
        code: "E_NOT_FOUND",
        reason: "unknown_run",
        status: "ok",
      }),
    ).toBeUndefined(); // err branch carries nothing else
  });

  it("accepts run_ev for every whitelisted event type and passes e through unchecked", () => {
    const payload = { a: 1, nested: { deep: true } };
    for (const type of FORWARDED_EVENTS) {
      const f = decodeAgentFrame({ t: "run_ev", runId, tapId, seq: 1, e: { type, ...payload } });
      expect(f).toMatchObject({ t: "run_ev", e: { type } });
    }
    const passthrough = decodeAgentFrame({ t: "run_ev", runId, tapId, seq: 1, e: { type: "message_end", ...payload } });
    expect(passthrough).toEqual({ t: "run_ev", runId, tapId, seq: 1, e: { type: "message_end", ...payload } });
  });

  it("rejects malformed run_ev (unknown type / bad ids / bad seq / extra frame fields)", () => {
    expect(decodeAgentFrame({ t: "run_ev", runId, tapId, seq: 1, e: { type: "not_an_event" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_ev", runId, tapId, seq: 1, e: { kind: "no type" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_ev", runId, tapId, seq: 1.5, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_ev", runId, tapId, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_ev", runId: "run_1", tapId, seq: 1, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_ev", runId, tapId: "x", seq: 1, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_ev", runId, tapId, seq: 1, e: { type: "turn_end" }, extra: 1 })).toBeUndefined();
  });

  it("accepts run_gap / run_end and rejects malformed ones", () => {
    expect(decodeAgentFrame({ t: "run_gap", runId, tapId, fromSeq: 3 })).toMatchObject({ t: "run_gap", fromSeq: 3 });
    expect(decodeAgentFrame({ t: "run_gap", runId, tapId, fromSeq: 0 })).toMatchObject({ fromSeq: 0 }); // epoch sentinel
    expect(decodeAgentFrame({ t: "run_gap", runId, tapId, fromSeq: "3" })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_gap", runId, fromSeq: 3 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_end", runId, tapId, lastSeq: 42, status: "ok" })).toMatchObject({
      t: "run_end",
      lastSeq: 42,
      status: "ok",
    });
    expect(decodeAgentFrame({ t: "run_end", runId, tapId, lastSeq: 42 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_end", runId, tapId, lastSeq: -1, status: "ok" })).toBeDefined(); // seq domain is agent-owned
  });

  it("keeps the direction split: run agent frames never decode as hub frames", () => {
    expect(decodeHubFrame(liveReply)).toBeUndefined();
    expect(decodeHubFrame({ t: "run_ev", runId, tapId, seq: 1, e: { type: "turn_end" } })).toBeUndefined();
    expect(decodeHubFrame({ t: "run_gap", runId, tapId, fromSeq: 1 })).toBeUndefined();
    expect(decodeHubFrame({ t: "run_end", runId, tapId, lastSeq: 1, status: "ok" })).toBeUndefined();
  });

  it("returns undefined for run frames over the byte budget", () => {
    const big = { t: "run_ev", runId, tapId, seq: 1, e: { type: "message_end", pad: "x".repeat(MAX_FRAME_BYTES) } };
    expect(decodeAgentFrame(big)).toBeUndefined();
  });

  it("entries/inflight validation parity with branch_reply / snapshot_reply (local-mirror pin)", () => {
    const candidates = [
      "message",
      "custom_message",
      "custom",
      "compaction",
      "branch_summary",
      "model_change",
      "thinking_level_change",
      "context_edit", // never a valid wire entry type
      "",
    ];
    for (const type of candidates) {
      const entry = { ...runEntry, type };
      const branch = decodeAgentFrame({ t: "branch_reply", rid: "r2", entries: [entry], truncated: false });
      const runReply = decodeAgentFrame({ ...liveReply, inflight: undefined, entries: [entry] });
      expect(runReply !== undefined, type).toBe(branch !== undefined);
    }
    // inflight: same accept/reject as snapshot_reply's inflight
    const good = { message: { role: "assistant" }, tools: [] };
    const bad = { tools: [{ toolCallId: "c" }] };
    expect(decodeAgentFrame({ ...liveReply, inflight: good })).toBeDefined();
    expect(decodeAgentFrame({ ...liveReply, inflight: bad })).toBeUndefined();
  });
});

describe("decodeHubFrame — run_tx_req / run_watch (fleet-drawer §3.1, F0)", () => {
  it("accepts run_tx_req with and without before", () => {
    const base = { t: "run_tx_req", rid: "req-9", runId: "r_ABCD1234", limit: 200, maxBytes: 2 << 20 };
    expect(decodeHubFrame(base)).toMatchObject({ t: "run_tx_req", limit: 200 });
    expect(decodeHubFrame({ ...base, before: "e7" })).toMatchObject({ before: "e7" });
  });

  it("rejects malformed run_tx_req / run_watch", () => {
    for (const over of [
      { runId: "run_1" },
      { runId: "r_ABCD123" }, // 7 body chars
      { limit: 1.5 },
      { limit: "200" },
      { maxBytes: "2097152" },
      { rid: 7 },
      { unexpected: true },
    ]) {
      expect(
        decodeHubFrame({ t: "run_tx_req", rid: "req-9", runId: "r_ABCD1234", limit: 200, maxBytes: 1 << 20, ...over }),
      ).toBeUndefined();
    }
    const { maxBytes: _m, ...noMax } = { t: "run_tx_req", rid: "req-9", runId: "r_ABCD1234", limit: 200 } as Record<
      string,
      unknown
    >;
    expect(decodeHubFrame(noMax)).toBeUndefined();
    expect(decodeHubFrame({ t: "run_watch", runId: "r_ABCD1234", on: true })).toMatchObject({
      t: "run_watch",
      on: true,
    });
    expect(decodeHubFrame({ t: "run_watch", runId: "r_ABCD1234", on: false })).toBeDefined(); // idempotent off
    expect(decodeHubFrame({ t: "run_watch", runId: "r_ABCD1234" })).toBeUndefined();
    expect(decodeHubFrame({ t: "run_watch", runId: "r_ABCD1234", on: "true" })).toBeUndefined();
    expect(decodeHubFrame({ t: "run_watch", runId: "run_1", on: true })).toBeUndefined();
  });

  it("keeps the direction split: hub run frames never decode as agent frames", () => {
    expect(decodeAgentFrame({ t: "run_tx_req", rid: "r", runId: "r_ABCD1234", limit: 1, maxBytes: 1 })).toBeUndefined();
    expect(decodeAgentFrame({ t: "run_watch", runId: "r_ABCD1234", on: true })).toBeUndefined();
  });
});

describe("fleet omitted (fleet-drawer §3.2 #12, F0)", () => {
  it("round-trips omitted and keeps it optional", () => {
    expect(decodeAgentFrame({ t: "fleet", runs: [fleetRow] })).toMatchObject({ t: "fleet" });
    const withOmitted = decodeAgentFrame({ t: "fleet", runs: [fleetRow], omitted: { active: 6, terminal: 4 } });
    expect(withOmitted).toMatchObject({ omitted: { active: 6, terminal: 4 } });
    expect(decodeAgentFrame({ t: "fleet", runs: [], omitted: { active: 0, terminal: 0 } })).toBeDefined();
  });

  it("rejects malformed omitted blocks but not the frame's legacy shape", () => {
    expect(decodeAgentFrame({ t: "fleet", runs: [fleetRow], omitted: { active: 6 } })).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "fleet", runs: [fleetRow], omitted: { active: 6, terminal: 4, extra: 1 } }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "fleet", runs: [fleetRow], omitted: { active: 1.5, terminal: 4 } })).toBeUndefined();
    expect(decodeAgentFrame({ t: "fleet", runs: [fleetRow], omitted: { active: "6", terminal: 4 } })).toBeUndefined();
  });
});

describe("unknown run-family frames are silently ignored (compat matrix, fleet-drawer §3.2 F0)", () => {
  // Pins the protocol-layer half of plan §3.2's compat matrix (旧 hub/旧 agent + 新帧): a peer
  // built before fleet F0 receiving a run-transcript frame it has no schema for must decode it
  // to undefined and ignore it — never throw, never prefix-match. The second test guards the
  // other direction: real run frames must still decode (the ignore path must not over-reach).
  it("returns undefined for unknown future run_* frame types in both directions, without throwing", () => {
    const unknownAgent = {
      t: "run_future_2099",
      runId: "r_ABCD1234",
      tapId: "tap0123456789ab",
      seq: 1,
      payload: { deep: true },
    };
    const unknownHub = { t: "run_future_2099", rid: "req-1", runId: "r_ABCD1234", limit: 1, maxBytes: 1 };
    expect(() => decodeAgentFrame(unknownAgent)).not.toThrow();
    expect(() => decodeHubFrame(unknownHub)).not.toThrow();
    expect(decodeAgentFrame(unknownAgent)).toBeUndefined();
    expect(decodeHubFrame(unknownHub)).toBeUndefined();
    // a typo'd but plausible name is equally unknown — decode never prefix-matches on `t`
    expect(
      decodeAgentFrame({
        t: "run_tx_repl",
        rid: "r",
        runId: "r_ABCD1234",
        ok: false,
        code: "E_NOT_FOUND",
        reason: "unknown_run",
      }),
    ).toBeUndefined();
    expect(decodeHubFrame({ t: "run_wach", runId: "r_ABCD1234", on: true })).toBeUndefined();
  });

  it("still decodes real run frames (the ignore path must not over-reach)", () => {
    expect(
      decodeAgentFrame({
        t: "run_tx_reply",
        rid: "req-1",
        runId: "r_ABCD1234",
        ok: false,
        code: "E_NOT_FOUND",
        reason: "unknown_run",
      }),
    ).toMatchObject({ t: "run_tx_reply", ok: false, reason: "unknown_run" });
    expect(decodeHubFrame({ t: "run_watch", runId: "r_ABCD1234", on: true })).toMatchObject({
      t: "run_watch",
      on: true,
    });
  });
});
