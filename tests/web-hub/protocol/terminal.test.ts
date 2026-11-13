import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { PROTO, P1_CAPS, TERMINAL_UI_CAP } from "../../../src/web-hub/protocol/version.js";
import {
  canonicalBase64Bytes,
  terminalHttpRequestOk,
  canonicalTerminalInventory,
  hasReservedTerminalResult,
  isReservedTerminalCommand,
  terminalFrameOk,
  TERMINAL_LIMITS,
  TerminalInventorySchema,
  TerminalReapProofSchema,
  TerminalQuarantineSchema,
  TERMINAL_HTTP_SCHEMAS,
  type TerminalResourceEntry,
} from "../../../src/web-hub/protocol/terminal.js";

const scope = { sessionId: "session", epoch: "epoch", ownerInstance: "owner" };
const output = {
  t: "term_event",
  v: 1,
  ...scope,
  channelId: "channel",
  termId: "term",
  revision: 0,
  kind: "output",
  offset: 0,
  bytesB64: "aGk=",
  streamEpoch: "stream",
};
const identity = {
  agentSessionId: "session",
  termId: "term",
  epoch: "epoch",
  ownerInstance: "owner",
  reservationId: "reservation",
};
const processIdentity = { bootId: "linux-boot", pid: 7, starttime: "123", uid: 1000 };
const entry: TerminalResourceEntry = {
  identity,
  agentProcessIdentity: processIdentity,
  managed: [],
  spawnState: "pending",
  state: "reserved",
};

describe("terminal r4 exact v1 contract (§4.3 / I10)", () => {
  it("appends frames without changing PROTO or hello capabilities", () => {
    expect(PROTO).toEqual({ major: 1, minor: 2 });
    expect(P1_CAPS).not.toContain(TERMINAL_UI_CAP);
    expect(decodeAgentFrame(output)).toEqual(output);
    expect(decodeAgentFrame({ ...output, kind: "future" })).toBeUndefined();
    expect(decodeAgentFrame({ ...output, v: 2 })).toBeUndefined();
    expect(decodeAgentFrame({ ...output, env: { SECRET: "x" } })).toBeUndefined();
    const badOpError = {
      t: "term_res",
      v: 1,
      rid: "rid",
      ...scope,
      op: "open",
      ok: false,
      code: "E_INPUT_SEQUENCE",
      effect: "none",
    };
    expect(decodeAgentFrame(badOpError)).toBeUndefined();
    expect(decodeAgentFrame({ ...badOpError, code: "E_LIMIT" })).toBeDefined();
    expect(
      decodeHubFrame({
        t: "term_req",
        v: 1,
        rid: "rid",
        sessionId: "session",
        epoch: "epoch",
        op: "prepare_protocol",
        offerId: "offer",
        hubNonce: "nonce",
      }),
    ).toBeDefined();
    expect(
      decodeHubFrame({ t: "term_req", v: 1, rid: "rid", ...scope, op: "open", channelId: "channel", shell: "bash" }),
    ).toBeUndefined();
  });
  it("checks canonical base64 before and after decoding and raw-byte offsets", () => {
    expect(canonicalBase64Bytes("aGk=")).toBe(2);
    expect(canonicalBase64Bytes("YQ==")).toBe(1);
    for (const b of ["YR==", "YWJ=", "a Gk=", "aGk", "????"]) expect(canonicalBase64Bytes(b)).toBeUndefined();
    expect(terminalFrameOk({ ...output, bytesB64: "YQ==", offset: Number.MAX_SAFE_INTEGER - 1 })).toBe(true);
    expect(terminalFrameOk({ ...output, offset: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(terminalFrameOk({ ...output, offset: -1 })).toBe(false);
    expect(terminalFrameOk({ ...output, offset: 0.5 })).toBe(false);
    expect(terminalFrameOk({ ...output, bytesB64: Buffer.alloc(8192).toString("base64") })).toBe(true);
    expect(terminalFrameOk({ ...output, bytesB64: Buffer.alloc(8193).toString("base64") })).toBe(false);
  });
  it("freezes quotas/deadlines/replay; no unbounded zeros", () => {
    expect([TERMINAL_LIMITS.maxPerSession, TERMINAL_LIMITS.maxPerPrincipal, TERMINAL_LIMITS.maxTotal]).toEqual([
      2, 2, 8,
    ]);
    expect([TERMINAL_LIMITS.inputIdleMs, TERMINAL_LIMITS.maxLifetimeMs, TERMINAL_LIMITS.ringBytes]).toEqual([
      3600000, 28800000, 1048576,
    ]);
    expect([TERMINAL_LIMITS.replayMs, TERMINAL_LIMITS.replayBytes, TERMINAL_LIMITS.replayLiveStagingBytes]).toEqual([
      3000, 16384, 0,
    ]);
  });
  it("POSTs require private SSE identity and reject client process/env claims", () => {
    const body = {
      agentKey: "agent",
      expect: { sessionId: "s", epoch: "e" },
      clientId: "client",
      connectionInstance: "instance",
      connectionToken: "token",
      cols: 80,
      rows: 24,
    };
    expect(Value.Check(TERMINAL_HTTP_SCHEMAS.prepare, body)).toBe(true);
    expect(terminalHttpRequestOk("prepare", body)).toBe(true);
    const input = {
      ...body,
      termId: "term",
      attachmentId: "attachment",
      writerLease: "lease",
      inputSeq: 0,
      bytesB64: "YR==",
      inputKind: "user",
      streamEpoch: "stream",
    };
    const { cols: _cols, rows: _rows, ...inputOnly } = input;
    expect(terminalHttpRequestOk("input", inputOnly)).toBe(false);
    expect(terminalHttpRequestOk("input", { ...inputOnly, bytesB64: "YQ==" })).toBe(true);
    const { connectionToken: _token, ...missing } = body;
    expect(Value.Check(TERMINAL_HTTP_SCHEMAS.prepare, missing)).toBe(false);
    for (const [k, val] of Object.entries({
      cwd: "/tmp",
      env: {},
      uid: 1000,
      signal: "SIGKILL",
      pid: 7,
      shell: "/bin/bash",
      command: "sh",
      cols: 501,
      rows: 0,
    }))
      expect(Value.Check(TERMINAL_HTTP_SCHEMAS.prepare, { ...body, [k]: val })).toBe(false);
  });
  it("isolates reserved structures including nested query, never user text", () => {
    for (const data of [
      { terminal: { v: 88, grant: "x" } },
      { terminalOutcome: "unknown" },
      { v: 1, op: "protocol_ready", grant: "x" },
      { v: 1, action: "resource_inventory", entries: [] },
      { op: "query", result: { ok: true, data: { terminal: { unknown: true } } } },
      {
        op: "query",
        result: { ok: true, data: { op: "query", result: { ok: true, data: { outcome: "handshake-required" } } } },
      },
    ]) {
      expect(hasReservedTerminalResult({ t: "cmd_late", data })).toBe(true);
    }
    expect(
      hasReservedTerminalResult({
        t: "cmd_late",
        data: { op: "command", output: { entries: [{ text: "terminal grant" }] } },
      }),
    ).toBe(false);
    expect(isReservedTerminalCommand({ op: "command", name: " /WEBHUB ", args: " __TERMINAL {}" })).toBe(true);
    expect(isReservedTerminalCommand({ op: "prompt", text: " /webhub __terminal {}" })).toBe(true);
    expect(isReservedTerminalCommand({ op: "command", name: "template", args: "/webhub __terminal {}" })).toBe(true);
    expect(isReservedTerminalCommand({ op: "prompt", text: "explain terminal behavior" })).toBe(false);
  });
});

describe("F2 metadata contract, not OS proof verification (§5.5.1)", () => {
  it("Q1 identity includes reservation/session/string epoch; PID alone is invalid", () => {
    const snapshot = {
      v: 1,
      hubBootId: "boot",
      challengeId: "challenge",
      linkGen: 1,
      inventoryId: "inventory",
      revision: 1,
      sender: { agentSessionId: "current", epoch: "current-e", ownerInstance: "current-o", processIdentity },
      totalCount: 1,
      digest: "a".repeat(64),
      entries: [entry],
      proofs: [],
      complete: true,
    };
    expect(Value.Check(TerminalInventorySchema, snapshot)).toBe(true);
    expect(
      Value.Check(TerminalInventorySchema, {
        ...snapshot,
        entries: [{ ...entry, identity: { ...identity, epoch: 1 } }],
      }),
    ).toBe(false);
    expect(
      Value.Check(TerminalInventorySchema, {
        ...snapshot,
        sender: { ...snapshot.sender, processIdentity: { pid: 7 } },
      }),
    ).toBe(false);
  });
  it("Q2 canonical SHA256 metadata digest fixes order, identity tuples and raw schema", () => {
    const second = { ...entry, identity: { ...identity, termId: "other" } };
    const hash = (e: TerminalResourceEntry[]) =>
      createHash("sha256").update(canonicalTerminalInventory(e)).digest("hex");
    expect(hash([entry, second])).toBe(hash([second, entry]));
    expect(hash([entry])).not.toBe(hash([second]));
    expect(hash([entry])).not.toBe(hash([{ ...entry, spawnState: "settled" }]));
  });
  it("Q3 lost is an explicit unknown-effect quarantine, never cleared/exited", () => {
    const lost = {
      state: "lost",
      revision: 1,
      code: "E_RESOURCE_QUARANTINED",
      effect: "unknown",
      reason: "inventory-missing",
      physicalUsed: 1,
    };
    expect(Value.Check(TerminalQuarantineSchema, lost)).toBe(true);
    expect(Value.Check(TerminalQuarantineSchema, { ...lost, effect: "none" })).toBe(false);
    expect(Value.Check(TerminalQuarantineSchema, { ...lost, state: "cleared" })).toBe(false);
  });
  it("Q4 close/SIGKILL/cleaned/partial helper exit cannot masquerade as reaped schema", () => {
    const proof = {
      identity,
      agentProcessIdentity: processIdentity,
      hubBootId: "boot",
      challengeId: "challenge",
      linkGen: 1,
      inventoryId: "inventory",
      revision: 1,
      proofId: "proof",
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: [],
      outcome: "reaped",
    };
    expect(Value.Check(TerminalReapProofSchema, proof)).toBe(true);
    for (const key of ["spawnSettled", "ptyClosed", "helperReaped", "managedGroupsGone"])
      expect(Value.Check(TerminalReapProofSchema, { ...proof, [key]: false })).toBe(false);
    expect(Value.Check(TerminalReapProofSchema, { ...proof, cleaned: true })).toBe(false);
    expect(Value.Check(TerminalReapProofSchema, { ...proof, outcome: "close-accepted" })).toBe(false);
  });
});
