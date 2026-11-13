import { describe, expect, it } from "vitest";
import { projectOf } from "../../tiers.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { hello, memLog } from "./helpers.js";
import type { CmdFrame } from "../../../src/web-hub/protocol/messages.js";
import { createCommandRouter, createTerminalCommandIngress } from "../../../src/web-hub/hub/commands.js";
import { TERMINAL_LIMITS } from "../../../src/web-hub/protocol/terminal.js";
const meta = { agentKey: "agent", linkGen: 1, sessionId: "session", epoch: "epoch" };
describe("private command tombstones (§4.1.2 F1)", () => {
  it("does not forget expired ids, refuses capacity, isolates wrong rid/session/link and retires only its link", () => {
    const offers: unknown[] = [],
      dedicated: unknown[] = [];
    const port = createTerminalCommandIngress({
      current: (m) => m.linkGen === 1,
      onOffer: (_m, _id, o) => offers.push(o),
      onDedicated: (_m, r) => dedicated.push(r),
    });
    for (let i = 0; i < TERMINAL_LIMITS.privateCommandsPerLink; i++)
      expect(port.register(meta, { commandId: `cmd-${i}`.padEnd(16, "_"), rid: `rid-${i}` })).toBe(true);
    port.expire(meta, "cmd-0".padEnd(16, "_"));
    expect(port.register(meta, { commandId: "overflow".padEnd(16, "_"), rid: "overflow" })).toBe(false);
    const late = {
      t: "cmd_late",
      id: "cmd-0".padEnd(16, "_"),
      op: "command",
      at: 1,
      ok: true,
      data: { terminal: { v: 1, outcome: "handshake-required", offerId: "offer" } },
    };
    expect(port.ownsCommand(meta, late)).toBe(true);
    port.consumeAgentFrame(meta, late);
    expect(offers).toEqual([]);
    expect(port.ownsCommand({ ...meta, linkGen: 2 }, late)).toBe(false);
    port.consumeAgentFrame(
      { ...meta, sessionId: "wrong" },
      { ...late, t: "cmd_result", rid: "rid-1", id: "cmd-1".padEnd(16, "_") },
    );
    expect(offers).toEqual([undefined]);
    port.retireLink({ ...meta, linkGen: 2 });
    expect(port.ownsCommand(meta, late)).toBe(true);
    port.retireLink(meta);
    expect(port.ownsCommand(meta, late)).toBe(false);
    expect(port.register(meta, { commandId: "new".padEnd(16, "_"), rid: "new" })).toBe(true);
    expect(dedicated).toEqual([]);
  });
  it("consumes before callbacks, so a throwing/reentrant consumer cannot deliver an offer twice", () => {
    let calls = 0;
    const port = createTerminalCommandIngress({
      current: () => true,
      onOffer: () => {
        calls++;
        throw new Error("test");
      },
      onDedicated: () => {},
    });
    port.register(meta, { rid: "rid", commandId: "cmd".padEnd(16, "_") });
    const raw = {
      t: "cmd_result",
      rid: "rid",
      id: "cmd".padEnd(16, "_"),
      ok: true,
      data: {
        op: "command",
        kind: "builtin",
        completion: "sync",
        history: "none",
        terminal: { v: 1, outcome: "handshake-required", offerId: "offer" },
      },
    };
    expect(() => port.consumeAgentFrame(meta, raw)).toThrow("test");
    port.consumeAgentFrame(meta, raw);
    expect(calls).toBe(1);
  });
});

it("terminal integration + PTY lifecycle files stay tier2, never secure-mount skipped", () => {
  for (const name of ["ingress", "old-hub", "quarantine", "pty", "lifecycle", "reconnect", "http"])
    expect(projectOf(`tests/integration/web-hub-terminal-${name}.test.ts`)).toBe("tier2");
});
it("T-CACHE hub defense-in-depth sanitizes reserved result BEFORE LRU/duplicate/query return", async () => {
  const registry = createRegistry({ now: () => 1000, log: memLog(), pidAlive: () => true });
  let agentKey = "";
  const registration = registry.register(hello({ caps: ["cmd.v1", "command.v1"] }), {
    send: (f) => {
      if (f.t !== "cmd") return;
      // Intentionally bypass ingress to exercise the second, router-local cache boundary.
      registry.onFrame(agentKey, {
        t: "cmd_result",
        id: f.id,
        rid: f.rid,
        ok: true,
        data: {
          op: "command",
          kind: "builtin",
          completion: "sync",
          history: "none",
          terminal: { v: 1, outcome: "handshake-required", offerId: "PRIVATE-MARKER" },
        },
      });
    },
    close() {},
  });
  agentKey = registration.agentKey;
  const router = createCommandRouter({ registry, log: memLog(), now: () => 1000 });
  const f: CmdFrame = {
    t: "cmd",
    rid: "rid",
    id: "a".repeat(16),
    deadlineMs: 2000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "r".repeat(16) },
    cmd: { op: "command", name: "version", args: "" },
  };
  const first = await router.request(f, agentKey);
  expect(first).toMatchObject({ ok: false, code: "E_UNSUPPORTED", effect: "unknown" });
  const duplicate = await router.request(f, agentKey),
    query = await router.request({ ...f, queryOnly: true }, agentKey);
  expect(JSON.stringify([first, duplicate, query])).not.toContain("PRIVATE-MARKER");
  expect(query).toMatchObject({
    ok: true,
    data: { op: "query", state: "failed", result: { ok: false, code: "E_UNSUPPORTED" } },
  });
});
