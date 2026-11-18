import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, type BindingPort } from "../../../src/web-hub/agent/connection.js";
import type { TerminalContextRequest, TerminalContextReply } from "../../../src/web-hub/protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L } from "../../../src/web-hub/protocol/terminal-v2-values.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";
const roots: Array<ReturnType<typeof tmpDir>> = [];
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  for (const root of roots.splice(0)) root.cleanup();
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
    now: Date.now,
    random: () => 0.5,
    netConnect: n.netConnect,
  });
  const received: Array<{ frame: TerminalContextRequest; link: object }> = [],
    lost: object[] = [];
  const binding: BindingPort = {
    onSnapshotReq() {},
    onBranchReq() {},
    onStateChange() {},
    onTerminalContext: (frame, link) => received.push({ frame, link }),
    onTerminalLinkLost: () => {
      if (conn.terminalLinkInstance) lost.push(conn.terminalLinkInstance);
    },
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
const request: TerminalContextRequest = {
  t: "terminal_context_req",
  v: 2,
  rid: "r".repeat(24),
  sessionId: "session",
  epoch: "epoch",
  contextGeneration: 1,
};
const reply: TerminalContextReply = {
  t: "terminal_context_res",
  v: 2,
  rid: request.rid,
  ok: true,
  sessionId: "session",
  epoch: "epoch",
  contextGeneration: 1,
  cwd: "/fixture",
};
describe("v2 dedicated metadata transport and removed v1 execution", () => {
  it("routes only exact live private context, retires before teardown, changes link object on reconnect", () => {
    const h = live(),
      first = h.conn.terminalLinkInstance!;
    h.sock.hub(request);
    expect(h.received).toEqual([{ frame: request, link: first }]);
    h.sock.hub({
      t: "term_req",
      v: 1,
      rid: "r",
      sessionId: "s",
      epoch: "e",
      op: "prepare_protocol",
      offerId: "o",
      hubNonce: "h",
    });
    expect(h.received).toHaveLength(1);
    h.sock.fail("ECONNRESET");
    expect(h.lost).toEqual([first]);
    expect(h.conn.terminalLinkInstance).toBeUndefined();
    h.sock.hub(request);
    expect(h.received).toHaveLength(1);
    vi.advanceTimersByTime(500);
    const next = h.n.sockets.at(-1)!;
    expect(next).not.toBe(h.sock);
    next.emit("connect");
    next.hub(ackFrame());
    expect(h.conn.terminalLinkInstance).not.toBe(first);
    next.hub(request);
    expect(h.received.at(-1)?.link).toBe(h.conn.terminalLinkInstance);
  });
  it("caps metadata replies at 24KiB without consuming ordinary control reserve/seq; refuses old replies", () => {
    const h = live(),
      seq = h.conn.seq;
    h.sock.writableLength = L.frameBytes;
    expect(h.conn.trySend(reply)).toBe("dropped");
    const before = h.sock.frames().length;
    h.conn.send(reply);
    expect(h.sock.frames()).toHaveLength(before);
    expect(h.conn.seq).toBe(seq);
    expect(h.conn.trySend({ t: "pong", ts: 17 })).toBe("written");
    h.sock.writableLength = 0;
    expect(h.conn.trySend(reply)).toBe("written");
    const old = {
      t: "term_res" as const,
      v: 1 as const,
      rid: "r",
      sessionId: "s",
      epoch: "e",
      op: "prepare_protocol" as const,
      ok: false as const,
      code: "E_UNSUPPORTED" as const,
      effect: "none" as const,
    };
    const oldBefore = h.sock.frames().length;
    expect(h.conn.trySend(old as never)).toBe("dropped");
    h.conn.send(old as never);
    expect(h.sock.frames()).toHaveLength(oldBefore);
    expect(h.conn.seq).toBe(seq);
  });
});
