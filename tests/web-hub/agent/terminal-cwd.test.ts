import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTerminalBackend } from "../../../src/web-hub/agent/terminal/backend.js";
import { TerminalBackendError } from "../../../src/web-hub/agent/terminal/environment.js";
import { tmpDir } from "./helpers.js";
import { vi } from "vitest";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { MODULE_INSTANCE } from "../../../src/web-hub/agent/connection.js";
import { TerminalOwner } from "../../../src/web-hub/agent/terminal/owner.js";
import type {
  TerminalBackend,
  TerminalBackendOptions,
  TerminalPhysicalResult,
} from "../../../src/web-hub/agent/terminal/backend.js";
import type { TermRes } from "../../../src/web-hub/protocol/terminal.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS } from "./helpers.js";

/** Production cwd preflight only: real filesystem permissions as non-root, no PTY.
 * Helper chdir race / exec / physical receipt coverage is P-I's real PTY gate. */
let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("cwd-");
});
afterEach(() => {
  chmodSync(tmp.dir, 0o700);
  tmp.cleanup();
});
function open(cwd: string) {
  return createTerminalBackend({
    cwd,
    cols: 80,
    rows: 24,
    inputIdleMs: 3600000,
    maxLifetimeMs: 28800000,
    onData: () => {},
  });
}
describe("cwd fail-closed before helper creation (T14)", () => {
  it.each(["", "relative", "/bad\0path"])("rejects invalid trusted cwd %s with fixed code", (cwd) => {
    expect(() => open(cwd)).toThrow(new TerminalBackendError("E_BAD_REQUEST"));
  });
  it("missing directory and regular file never fall back to HOME/process cwd", () => {
    const file = join(tmp.dir, "file");
    writeFileSync(file, "");
    for (const cwd of [join(tmp.dir, "absent"), file])
      expect(() => open(cwd)).toThrow(new TerminalBackendError("E_BAD_REQUEST"));
  });
  it("real chmod traverse denial under a non-root fixture is fixed E_BAD_REQUEST", () => {
    // This environment gate must not silently turn permission coverage into a root PASS.
    expect(process.getuid?.(), "run permission fixture as non-root").not.toBe(0);
    const denied = join(tmp.dir, "denied");
    mkdirSync(denied, { mode: 0o700 });
    chmodSync(denied, 0o600);
    try {
      expect(() => open(denied)).toThrow(new TerminalBackendError("E_BAD_REQUEST"));
    } finally {
      chmodSync(denied, 0o700);
    }
  });
});

// This complementary T5 path uses the REAL wireWebHub + TerminalOwner + private
// negotiation, replacing only physical PTY creation. Every first open is actually
// received; the tests above cover real non-root filesystem denial independently.
const proven: TerminalPhysicalResult = {
  outcome: "reaped",
  spawnSettled: true,
  ptyClosed: true,
  helperReaped: true,
  managedGroupsGone: true,
  identitiesChecked: [],
  waited: [],
};
it("T5 real wiring first open uses updated event ctx; retries pin cwd; session boundaries choose new ctx", async () => {
  vi.useFakeTimers();
  resetGlobals();
  const a = fakePi(),
    n = fakeNet(),
    c = fakeCtx();
  const owners: TerminalOwner[] = [];
  const captured: TerminalBackendOptions[] = [];
  const backends: TerminalBackend[] = [];
  const limits = { maxPerSession: 4, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
  wireWebHub(a.pi, {
    settings: { ...SETTINGS, terminal: { ...limits, enabled: true } },
    terminalGuard: () => true,
    privateNs: () => ({ gate: "not-ns" }),
    terminalOwnerFactory: async (options) => {
      const { local: _physicalAuthority, ...rest } = options;
      const owner = new TerminalOwner(
        {
          ...rest,
          backend: (opts) => {
            captured.push(opts);
            let finish!: (p: TerminalPhysicalResult) => void;
            const backend: TerminalBackend = {
              ready: Promise.resolve(),
              done: new Promise((resolve) => {
                finish = resolve;
              }),
              managed: [],
              spawnSettled: true,
              close: vi.fn(() => finish(proven)),
              retryReap: async () => proven,
              input: async () => {},
              resize: async () => {},
            };
            backends.push(backend);
            return backend;
          },
        },
        { pid: 7, uid: 1000, bootId: "boot", starttime: "1" },
      );
      owners.push(owner);
      return owner;
    },
    fleet: () => [],
    paths: pathsIn(tmp.dir),
    env: { HOME: tmp.dir },
    netConnect: n.netConnect,
    argv1: "/missing/pi",
    buildInfo: async () => ({ pluginVersion: "1", buildId: "cwd" }),
  });
  let ctx = { ...c.ctx, cwd: "/first-session" };
  let serial = 0;
  try {
    a.fire("session_start", { reason: "startup" }, ctx);
    await vi.advanceTimersByTimeAsync(0);
    const socket = n.sockets[0]!;
    socket.emit("connect");
    socket.hub(ackFrame());
    const openChannel = () => {
      const owner = owners.at(-1)!;
      const scope = {
        sessionId: ctx.sessionManager.getSessionId(),
        epoch: MODULE_INSTANCE,
        ownerInstance: owner.ownerInstance,
      };
      const offer = owner.offer(
        {
          t: "cmd",
          rid: "rid",
          id: `cmd-${++serial}`,
          deadlineMs: 3000,
          origin: { listener: "loopback", ip: "127.0.0.1", reqId: "req" },
          cmd: { op: "command", name: "webhub", args: "__terminal" },
        },
        { v: 1, action: "negotiate", requestNonce: "nonce" },
      );
      expect(offer).toBeDefined();
      socket.hub({
        t: "term_req",
        v: 1,
        rid: "prepare",
        sessionId: scope.sessionId,
        epoch: scope.epoch,
        op: "prepare_protocol",
        offerId: offer!.offerId,
        hubNonce: "hub",
      });
      const challenge = socket.frames().at(-1) as Extract<TermRes, { op: "protocol_challenge" }>;
      const handshake = { offerId: offer!.offerId, hubNonce: "hub", agentChallenge: challenge.agentChallenge };
      socket.hub({ t: "term_req", v: 1, rid: "ready", ...scope, op: "protocol_ready", ...handshake });
      const ready = socket.frames().at(-1) as { grant: string };
      socket.hub({
        t: "term_req",
        v: 1,
        rid: "bind",
        ...scope,
        op: "bind",
        ...handshake,
        proposedChannelId: "channel",
        grant: ready.grant,
      });
      return (id: string) =>
        socket.hub({
          t: "term_req",
          v: 1,
          rid: `open-${id}`,
          ...scope,
          channelId: "channel",
          op: "open",
          openId: id,
          termId: `term-${id}`,
          reservationId: `res-${id}`,
          ownerKey: "owner",
          attachmentId: "attach",
          writerLease: "lease",
          cols: 80,
          rows: 24,
          createTicket: {
            v: 1,
            bootId: "hub",
            ticketId: id,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 600000,
            ownerBinding: { listener: "loopback", principal: "user", sidTag: "sid", agentKey: "agent", ...scope },
            payloadDigest: "a".repeat(64),
            mac: "b".repeat(64),
          },
        });
    };
    const open = openChannel();
    open("first");
    await vi.advanceTimersByTimeAsync(0);
    ctx = { ...ctx, cwd: "/event-current" };
    a.fire("agent_end", {}, ctx);
    open("first"); // retry, not another backend
    open("second");
    await vi.advanceTimersByTimeAsync(0);
    expect(captured.map((o) => o.cwd)).toEqual(["/first-session", "/event-current"]);
    expect(backends[0]!.close).not.toHaveBeenCalled();
    a.fire("session_shutdown", { reason: "resume" }, ctx);
    expect(backends[0]!.close).toHaveBeenCalled();
    ctx = { ...ctx, cwd: "/resumed-session", sessionManager: { ...ctx.sessionManager, getSessionId: () => "resumed" } };
    a.fire("session_start", { reason: "resume" }, ctx);
    await vi.advanceTimersByTimeAsync(0);
    openChannel()("resumed");
    await vi.advanceTimersByTimeAsync(0);
    expect(captured.map((o) => o.cwd)).toEqual(["/first-session", "/event-current", "/resumed-session"]);
    expect(JSON.stringify(owners.at(-1)!.resourceEntries())).not.toMatch(/cwd|resumed-session/);
  } finally {
    a.fire("session_shutdown", { reason: "quit" }, ctx);
    await vi.advanceTimersByTimeAsync(0);
    for (const owner of owners) {
      await owner.dispose();
      const entries = owner.resourceEntries();
      if (entries.length) owner.forgetResolvedReceipts(entries.map((e) => e.identity));
    }
    resetGlobals();
    vi.useRealTimers();
  }
});
