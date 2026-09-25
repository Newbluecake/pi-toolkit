import { describe, expect, it } from "vitest";
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
