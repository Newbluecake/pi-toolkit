import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AllocationV2Schema,
  LedgerV2Schema,
  TerminalSessionV2Schema,
  TerminalFailureV2Schema,
  TerminalMarkerV2Schema,
  TERMINAL_V2_HTTP_SCHEMAS,
  TERMINAL_V2_HTTP_SUCCESS_SCHEMAS,
  TERMINAL_V2_ERROR_STATUS,
  TERMINAL_V2_LIMITS,
  terminalHttpRequestV2Ok,
  terminalContextFrameV2Ok,
  parseTerminalSessionV2,
  normalizeTerminalNameV2,
  terminalCwdV2Ok,
  terminalBase64BytesV2,
  terminalLedgerV2Ok,
  terminalViewFrameV2Ok,
} from "../../../src/web-hub/protocol/terminal-v2.js";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
const id = "A".repeat(22),
  other = "B".repeat(22);
const scope = { agentKey: "agent", sessionId: "session", epoch: "epoch" };
const envelope = { scope, hubInstance: id };
const term = { ...envelope, termId: id },
  writer = { ...term, viewId: id };
const declaration = {
  v: 2,
  enabled: true,
  sessionId: "session",
  epoch: "epoch",
  contextGeneration: 0,
  limits: { maxPerSession: 2, inputIdleMs: 3_600_000, maxLifetimeMs: 28_800_000 },
};
const allocation = {
  allocationId: id,
  termId: id,
  hubInstance: id,
  kernelBootId: "12345678-1234-1234-1234-123456789abc",
  scope,
  quotaSessionKey: "session",
  principalKey: "lan:u1",
  creatorSidTag: "S".repeat(43),
};
const ledger = { v: 2, storeId: id, revision: 0, allocations: [allocation] };
const dimension = { used: 1, unknown: 1, limit: 2 };
const tabs = {
  revision: 0,
  rows: [{ termId: id, name: "bash 1", state: "live", createdAt: 0, ordinal: 1 }],
  unknownResources: [{ allocationTag: other, state: "cleanup-unknown" }],
  quota: { session: dimension, principal: dimension, total: { ...dimension, limit: 8 } },
};
const samples = {
  list: { scope },
  create: { ...envelope, requestId: id, mode: "ensure-empty", cols: 80, rows: 24 },
  creation: { ...envelope, requestId: id },
  rename: { ...term, name: " bash 2 " },
  close: term,
  view: { ...term, offset: 0 },
  input: { ...writer, seq: 0, bytesB64: "YQ==", kind: "user" },
  resize: { ...writer, seq: 0, cols: 80, rows: 24 },
  ack: { ...writer, offset: 0, replayComplete: true },
} as const;

describe("T51 P0 terminal v2 frozen contracts (no runtime)", () => {
  it("pins ordinary PROTO and leaves v2 context outside ordinary routing until private ingress is installed", () => {
    expect(PROTO).toEqual({ major: 1, minor: 2 });
    const request = {
      t: "terminal_context_req",
      v: 2,
      rid: id,
      sessionId: "session",
      epoch: "epoch",
      contextGeneration: 0,
    };
    const reply = { ...request, t: "terminal_context_res", ok: true, cwd: "/work" };
    expect(terminalContextFrameV2Ok(request)).toBe(true);
    expect(terminalContextFrameV2Ok(reply)).toBe(true);
    expect(decodeHubFrame(request)).toBeUndefined();
    expect(decodeAgentFrame(reply)).toBeUndefined();
    for (const raw of [
      { ...request, contextGeneration: -1 },
      { ...reply, cwd: "relative" },
      { ...reply, authority: id },
      { ...reply, cwd: "/" + "中".repeat(3000) },
    ])
      expect(terminalContextFrameV2Ok(raw)).toBe(false);
    expect(terminalContextFrameV2Ok({ t: "terminal_context_res", v: 2, rid: id, ok: false, code: "E_SECURE" })).toBe(
      true,
    );
  });
  it("v2 status is optional, matching, closed and only a candidate without cwd/owner readiness", () => {
    expect(Value.Check(TerminalSessionV2Schema, declaration)).toBe(true);
    expect(parseTerminalSessionV2(declaration, scope)).toEqual(declaration);
    for (const value of [
      undefined,
      { ...declaration, cwd: "/work" },
      { ...declaration, ownerReady: true },
      { ...declaration, contextGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...declaration, v: 1 },
    ])
      expect(parseTerminalSessionV2(value)).toBeUndefined();
    expect(parseTerminalSessionV2(declaration, { ...scope, epoch: "next" })).toBeUndefined();
    expect(parseTerminalSessionV2(declaration, { ...scope, sessionId: "next" })).toBeUndefined();
  });
  it("validates every request family, bounded sizes and forbids client auth/cwd/executable/SSE binding fields", () => {
    for (const op of Object.keys(samples) as Array<keyof typeof samples>) {
      expect(Value.Check(TERMINAL_V2_HTTP_SCHEMAS[op], samples[op]), op).toBe(true);
      expect(terminalHttpRequestV2Ok(op, samples[op]), op).toBe(true);
      for (const field of ["cwd", "env", "shell", "principalKey", "clientId", "connectionToken", "writerLease"])
        expect(terminalHttpRequestV2Ok(op, { ...samples[op], [field]: id }), `${op}:${field}`).toBe(false);
    }
    expect(terminalHttpRequestV2Ok("list", envelope)).toBe(false);
    expect(terminalHttpRequestV2Ok("create", { ...samples.create, requestId: "short" })).toBe(false);
    expect(terminalHttpRequestV2Ok("create", { ...samples.create, mode: "adopt" })).toBe(false);
    expect(terminalHttpRequestV2Ok("resize", { ...samples.resize, cols: 501 })).toBe(false);
    expect(terminalHttpRequestV2Ok("resize", { ...samples.resize, rows: 0 })).toBe(false);
    expect(terminalHttpRequestV2Ok("ack", { ...samples.ack, replayComplete: false })).toBe(false);
    for (const seq of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1])
      expect(terminalHttpRequestV2Ok("input", { ...samples.input, seq })).toBe(false);
    for (const bytesB64 of ["YR==", "YWJ=", "bad!", Buffer.alloc(4097).toString("base64")])
      expect(terminalHttpRequestV2Ok("input", { ...samples.input, bytesB64 })).toBe(false);
    expect(
      terminalHttpRequestV2Ok("input", { ...samples.input, bytesB64: Buffer.alloc(4096).toString("base64") }),
    ).toBe(true);
  });
  it("input queryOnly is a closed mutually exclusive lookup, never a write payload", () => {
    const query = { ...writer, seq: 0, queryOnly: true };
    expect(Value.Check(TERMINAL_V2_HTTP_SCHEMAS.input, query)).toBe(true);
    expect(terminalHttpRequestV2Ok("input", query)).toBe(true);
    for (const invalid of [
      { ...query, bytesB64: "" },
      { ...query, kind: "user" },
      { ...query, bytesB64: "YQ==", kind: "user" },
      { ...query, queryOnly: false },
      { ...query, queryOnly: "true" },
      { ...query, seq: -1 },
      { ...query, seq: Number.MAX_SAFE_INTEGER + 1 },
      { ...query, viewId: undefined },
      { ...samples.input, queryOnly: true },
      { ...samples.input, queryOnly: false },
    ]) {
      expect(Value.Check(TERMINAL_V2_HTTP_SCHEMAS.input, invalid)).toBe(false);
      expect(terminalHttpRequestV2Ok("input", invalid)).toBe(false);
    }
    expect(Value.Check(TerminalFailureV2Schema, { ok: false, code: "E_INPUT_UNKNOWN", effect: "unknown" })).toBe(true);
  });
  it("uses canonical base64 and UTF-8/code-point name/cwd limits", () => {
    expect(terminalBase64BytesV2("")).toBe(0);
    expect(terminalBase64BytesV2("YQ==")).toBe(1);
    expect(terminalBase64BytesV2("YR==")).toBeUndefined();
    expect(normalizeTerminalNameV2("  工作😀  ")).toBe("工作😀");
    expect(normalizeTerminalNameV2("😀".repeat(24))).toBe("😀".repeat(24));
    for (const name of [" ", "x\ny", "x\u007fy", "x".repeat(25), "😀".repeat(25)])
      expect(normalizeTerminalNameV2(name)).toBeUndefined();
    expect(terminalCwdV2Ok("/" + "x".repeat(8191))).toBe(true);
    for (const cwd of ["", "relative", "/\0", "/" + "中".repeat(2731)]) expect(terminalCwdV2Ok(cwd)).toBe(false);
  });
  it("creation query is a discriminated outcome, not permission to retry/fork; errors carry explicit effect", () => {
    const schema = TERMINAL_V2_HTTP_SUCCESS_SCHEMAS.creation;
    for (const outcome of [
      { ok: true, outcome: "pending" },
      { ok: true, outcome: "created", termId: id },
      { ok: true, outcome: "failed", code: "E_CWD" },
      { ok: true, outcome: "unknown" },
    ])
      expect(Value.Check(schema, outcome)).toBe(true);
    expect(Value.Check(schema, { ok: true, outcome: "created" })).toBe(false);
    expect(Value.Check(schema, { ok: true, outcome: "unknown", termId: id })).toBe(false);
    expect(Value.Check(TerminalFailureV2Schema, { ok: false, code: "E_CLEANUP_UNKNOWN", effect: "unknown" })).toBe(
      true,
    );
    expect(Value.Check(TerminalFailureV2Schema, { ok: false, code: "E_LIMIT" })).toBe(false);
    expect(TERMINAL_V2_ERROR_STATUS.E_LIMIT).toBe(429);
    expect(TERMINAL_V2_ERROR_STATUS.E_RESOURCE_UNAVAILABLE).toBe(503);
    expect(TERMINAL_V2_ERROR_STATUS.E_CLEANUP_UNKNOWN).toBe(409);
    expect(TERMINAL_V2_LIMITS).toMatchObject({ maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputResults: 64 });
  });
  it("independent view frames carry offsets/gaps/tabs, no public SSE identity or bearer", () => {
    for (const frame of [
      { t: "attached", hubInstance: id, viewId: id, termId: id, start: 0, end: 2 },
      { t: "output", offset: 0, bytesB64: "YQ==" },
      { t: "gap", from: 0, to: 1 },
      { t: "replay-end", offset: 1 },
      { t: "ready", offset: 1 },
      { t: "tabs", ...tabs },
      { t: "state", termId: id, state: "exited", exitCode: 0 },
      { t: "ping" },
      { t: "error", code: "E_AUTH" },
    ]) {
      expect(terminalViewFrameV2Ok(frame)).toBe(true);
      expect(terminalViewFrameV2Ok({ ...frame, clientId: id })).toBe(false);
    }
    for (const frame of [
      { t: "output", offset: Number.MAX_SAFE_INTEGER, bytesB64: "YQ==" },
      { t: "output", offset: 0, bytesB64: "YR==" },
      { t: "output", offset: 0, bytesB64: Buffer.alloc(8193).toString("base64") },
      { t: "gap", from: 1, to: 0 },
      { t: "gap", from: 0, to: 0 },
      { t: "attached", hubInstance: id, viewId: id, termId: id, start: 3, end: 2 },
      { t: "tabs", ...tabs, rows: [...tabs.rows, ...tabs.rows] },
      { t: "tabs", ...tabs, quota: { ...tabs.quota, session: { ...dimension, unknown: 2 } } },
      { t: "tabs", ...tabs, rows: [{ ...tabs.rows[0], cwd: "/secret" }] },
    ])
      expect(terminalViewFrameV2Ok(frame)).toBe(false);
  });
  it("ledger is resources only, preserves exact attribution, rejects duplicate/misattributed/oversized data without healing", () => {
    expect(terminalLedgerV2Ok(ledger)).toBe(true);
    expect(Value.Check(AllocationV2Schema, allocation)).toBe(true);
    for (const field of ["pendingAuthRevokes", "authEpoch", "repair", "cwd", "env", "name", "token", "pid"]) {
      expect(Value.Check(AllocationV2Schema, { ...allocation, [field]: id })).toBe(false);
      expect(terminalLedgerV2Ok({ ...ledger, [field]: [] })).toBe(false);
    }
    for (const allocations of [
      [allocation, allocation],
      [allocation, { ...allocation, allocationId: other }],
      [{ ...allocation, quotaSessionKey: "another-session" }],
      [{ ...allocation, principalKey: "" }],
      [{ ...allocation, creatorSidTag: undefined }],
      [{ ...allocation, kernelBootId: "not-a-boot" }],
      Array.from({ length: 33 }, (_, i) => ({
        ...allocation,
        allocationId: String(i).padStart(22, "A"),
        termId: String(i).padStart(22, "B"),
      })),
    ])
      expect(terminalLedgerV2Ok({ ...ledger, allocations })).toBe(false);
    expect(terminalLedgerV2Ok({ ...ledger, v: 1 })).toBe(false);
    expect(Value.Check(LedgerV2Schema, { ...ledger, allocations: [] })).toBe(true);
    expect(terminalLedgerV2Ok({ ...ledger, allocations: [{ ...allocation, hubInstance: other }] })).toBe(true); // cold != invalid
    expect(
      Value.Check(TerminalMarkerV2Schema, {
        v: 2,
        storeId: id,
        initialization: "v1-clean-checkpoint",
        checkpointId: id,
      }),
    ).toBe(true);
    expect(
      Value.Check(TerminalMarkerV2Schema, { v: 2, storeId: id, initialization: "auto-scan-v1", checkpointId: id }),
    ).toBe(false);
  });
});
