import { describe, it, expect } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { PROTO, P1_CAPS, P2_AGENT_CAPS, P2_HUB_CAPS } from "../../../src/web-hub/protocol/version.js";
import {
  hasReservedTerminalResult,
  isReservedTerminalCommand,
  isTerminalNamespace,
} from "../../../src/web-hub/protocol/terminal.js";

describe("legacy terminal refusal only, not an executable contract", () => {
  it("refuses every old frame family and malformed/future reserved variants on BOTH decoders", () => {
    for (const t of [
      "term_req",
      "term_res",
      "term_event",
      "term_future",
      "terminal_context_req",
      "terminal_context_res",
    ]) {
      for (const fields of [
        {},
        { v: 1, op: "open", rid: "rid" },
        { v: 99, op: "authority" },
        { v: 1, op: "resolved_ack", resolved: { entries: [] } },
      ]) {
        const raw = { t, sessionId: "session", epoch: "epoch", ownerInstance: "owner", ...fields };
        expect(isTerminalNamespace(raw)).toBe(true);
        expect(decodeAgentFrame(raw)).toBeUndefined();
        expect(decodeHubFrame(raw)).toBeUndefined();
      }
    }
  });
  it("preserves ordinary PROTO/caps and ordinary status bytes, including opaque old fields", () => {
    expect(PROTO).toEqual({ major: 1, minor: 2 });
    expect(P1_CAPS).toEqual(["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"]);
    expect(P2_AGENT_CAPS).toEqual(["cmd.v1", "dialog.v1", "command.v1"]);
    expect(P2_HUB_CAPS).toEqual(["cmd.v1", "dialog.v1", "command.v1", "ctl.v2"]);
    const raw = {
      t: "status",
      leafId: null,
      busy: false,
      pending: false,
      terminalSession: { v: 1, enabled: true, cwd: "opaque" },
    };
    expect(JSON.stringify(decodeAgentFrame(raw))).toBe(JSON.stringify(raw));
    expect(isTerminalNamespace(raw)).toBe(false);
    expect(isTerminalNamespace({ t: "terminal user text" })).toBe(false);
  });
  it("isolates reserved structures including nested query, never user text", () => {
    for (const data of [
      { terminal: { v: 88, grant: "x" } },
      { terminalOutcome: "unknown" },
      { v: 1, op: "protocol_ready", grant: "x" },
      { v: 1, op: "authority", authority: { nonce: "x" } },
      { v: 99, op: "authority", authority: { nonce: "x" } },
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
