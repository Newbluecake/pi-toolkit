import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, type BindingPort } from "../../../src/web-hub/agent/connection.js";
import { TERMINAL_LIMITS as L, type TermReq, type TermRes } from "../../../src/web-hub/protocol/terminal.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";
const roots: Array<ReturnType<typeof tmpDir>> = [];
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  for (const t of roots.splice(0)) t.cleanup();
});
function live() {
  vi.useFakeTimers();
  resetGlobals();
  const tmp = tmpDir();
  roots.push(tmp);
  const n = fakeNet();
  const conn = acquireConnection({
    buildId: "1.0.0@terminal-test",
    pluginVersion: "1.0.0",
    kind: "tui",
    cwd: "/fixture",
    paths: pathsIn(tmp.dir),
    settings: SETTINGS,
    launcher: { error: "no test loader" },
    now: () => Date.now(),
    random: () => 0.5,
    netConnect: n.netConnect,
  });
  const received: TermReq[] = [],
    lost: string[] = [];
  const binding: BindingPort = {
    onSnapshotReq() {},
    onBranchReq() {},
    onStateChange() {},
    onTerminalReq: (f) => received.push(f),
    onTerminalLinkLost: () => lost.push(conn.terminalConnectionInstance!),
  };
  conn.attach(binding, {
    sessionId: "session",
    sessionFile: "/fixture/session.jsonl",
    cwd: "/fixture",
    reason: "startup",
    leafId: "leaf",
    mode: "tui",
  });
  const sock = n.sockets[0]!;
  sock.emit("connect");
  sock.hub(ackFrame());
  return { conn, n, sock, received, lost };
}
describe("dedicated terminal connection branch (no hello/slot bytes change)", () => {
  it("routes only live term_req to the binding, fences old instance before teardown and changes incarnation", () => {
    const h = live();
    const first = h.conn.terminalConnectionInstance;
    expect(first).toBeTruthy();
    const frame: TermReq = {
      t: "term_req",
      v: 1,
      rid: "r",
      sessionId: "session",
      epoch: "epoch",
      op: "prepare_protocol",
      offerId: "o",
      hubNonce: "h",
    };
    h.sock.hub(frame);
    expect(h.received).toEqual([frame]);
    h.sock.fail("ECONNRESET");
    expect(h.lost).toEqual([first]);
    expect(h.conn.terminalConnectionInstance).toBeUndefined();
    h.sock.hub(frame);
    expect(h.received).toHaveLength(1);
    vi.advanceTimersByTime(500);
    const next = h.n.sockets.at(-1)!;
    next.emit("connect");
    next.hub(ackFrame());
    expect(h.conn.terminalConnectionInstance).not.toBe(first);
  });
  it("terminal data stops at 128KiB without consuming ordinary status/control reserve or generic seq", () => {
    const h = live();
    const frame: TermRes = {
      t: "term_res",
      v: 1,
      rid: "r",
      sessionId: "session",
      epoch: "epoch",
      ownerInstance: "owner",
      op: "bind",
      channelId: "c",
      ok: true,
      bound: true,
    };
    const seq = h.conn.seq;
    h.sock.writableLength = L.udsPendingBytes + 1;
    const before = h.sock.written.length;
    expect(h.conn.trySend(frame)).toBe("dropped");
    h.conn.send(frame);
    expect(h.sock.written).toHaveLength(before);
    expect(h.conn.trySend({ t: "pong" })).toBe("written");
    expect(h.conn.seq).toBe(seq);
    h.sock.writableLength = 0;
    expect(h.conn.trySend(frame)).toBe("written");
  });
});
