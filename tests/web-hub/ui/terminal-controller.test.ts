// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalController } from "../../../src/web-hub/ui/src/components/terminal/controller.js";
import type { TerminalTransport } from "../../../src/web-hub/ui/src/transport/terminal.js";
const scope = { agentKey: "agent", expect: { sessionId: "session", epoch: "epoch" } };
const deadlines = { inputIdleAt: 70000, lifetimeAt: 90000, parentExpiresAt: 80000 };
const fact = {
  termId: "term",
  reservationId: "reservation",
  revision: 1,
  state: "live",
  nextInputSeq: 0,
  baseOffset: 0,
  nextOffset: 0,
  deadlines,
};
const attachment = { ok: true, ...fact, attachmentId: "attachment", writerLease: "lease", replayMode: "cold" };
const ticket = {
  v: 1,
  bootId: "boot",
  ticketId: "ticket",
  issuedAt: 10000,
  expiresAt: 70000,
  ownerBinding: {
    listener: "loopback",
    principal: "principal",
    sidTag: "sid",
    agentKey: "agent",
    sessionId: "session",
    epoch: "epoch",
    ownerInstance: "owner",
  },
  payloadDigest: "a".repeat(64),
  mac: "b".repeat(64),
};
function setup(custom?: (op: string, body: any) => any) {
  const request = vi.fn(async (op: string, body: any) =>
    custom
      ? custom(op, body)
      : op === "attach" || op === "open"
        ? { ...attachment }
        : op === "list"
          ? { ok: true, revision: 1, rows: [fact] }
          : op === "prepare"
            ? { ok: true, openId: "ticket", createTicket: ticket }
            : op === "input"
              ? { ok: true, acceptedThrough: body.inputSeq }
              : { ok: true, revision: 2 },
  );
  const renderer = {
    write: vi.fn(async (_bytes: Uint8Array) => {}),
    reset: vi.fn(),
    dimensions: () => ({ cols: 80, rows: 24 }),
  };
  const revoked = vi.fn();
  const c = createTerminalController({
    transport: { request } as unknown as TerminalTransport,
    scope,
    clientId: () => "client",
    renderer,
    revoked,
  });
  c.event("terminal_connection", { connectionInstance: "instance", connectionToken: "token", expiresAt: 80000 });
  const event = (e: Record<string, unknown>, extras = {}) =>
    c.event("terminal", {
      agentKey: "agent",
      attachmentId: "attachment",
      connectionInstance: "instance",
      event: { v: 1, sessionId: "session", epoch: "epoch", ownerInstance: "owner", termId: "term", revision: 2, ...e },
      ...extras,
    });
  return { c, request, renderer, event, revoked };
}
const turn = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("terminal attachment controller (§4.2 / §6.2 / §7.3)", () => {
  it("does no discovery until an explicit list action; all requests carry the private identity", async () => {
    const { c, request } = setup();
    expect(request).not.toHaveBeenCalled();
    await c.list();
    expect(request.mock.calls[0]?.[1]).toEqual({
      ...scope,
      clientId: "client",
      connectionInstance: "instance",
      connectionToken: "token",
    });
    c.dispose();
  });
  it("opens only a server-signed operation and queries that same id on unknown effect, never repeats open", async () => {
    const { c, request } = setup((op) =>
      op === "prepare"
        ? { ok: true, openId: "ticket", createTicket: ticket }
        : op === "open"
          ? { ok: false, code: "E_DEADLINE", effect: "unknown" }
          : op === "state"
            ? { ok: true, fact: { state: "unknown", effect: "unknown" } }
            : { ok: true, revision: 1 },
    );
    await expect(c.open()).rejects.toThrow("effect unknown");
    expect(request.mock.calls.map((c) => c[0])).toEqual(["prepare", "open", "state"]);
    expect(request.mock.calls[2]?.[1].target.openId).toBe("ticket");
    c.dispose();
  });
  it("defers ResizeObserver controls until replay cutover, then uses the latest dimensions", async () => {
    const { c, request, renderer, event } = setup();
    await c.attach(fact as any);
    const dimensions = { cols: 120, rows: 35 };
    renderer.dimensions = () => dimensions;
    await c.resize(); // Observer fires immediately after HTTP attachment adoption.
    event({ kind: "replay_begin", attemptId: "attempt", replayEpoch: "replay", S: 0, N0: 0, deadlineAt: 13000 });
    await turn();
    await c.resize(); // Still replaying: the agent would reject E_LEASE_EXPIRED.
    expect(request.mock.calls.filter(([op]) => op === "resize")).toEqual([]);
    dimensions.cols = 132;
    event({
      kind: "cutover",
      attemptId: "attempt",
      newLiveEpoch: "live",
      replayEnd: 0,
      liveFrom: 0,
      gap: { from: 0, to: 0 },
      resetParser: true,
    });
    await turn();
    expect(c.state.writable).toBe(true);
    expect(request.mock.calls.filter(([op]) => op === "resize")).toHaveLength(1);
    expect(request.mock.calls.find(([op]) => op === "resize")?.[1]).toMatchObject({ cols: 132, rows: 35 });
    expect(c.state.error).toBe("");
    c.dispose();
  });
  it("gates replay input/auto-responses and ACKs raw bytes only after renderer completion; cutover enables input", async () => {
    const { c, request, renderer, event } = setup();
    await c.attach(fact as any);
    let rendered!: () => void;
    renderer.write.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          rendered = r;
        }),
    );
    event({ kind: "replay_begin", attemptId: "attempt", replayEpoch: "replay", S: 0, N0: 3, deadlineAt: 13000 });
    event({ kind: "output", offset: 0, bytesB64: "5Lit", streamEpoch: "replay" });
    c.input(new Uint8Array([27]));
    c.input(new Uint8Array([27]), "terminal_response");
    await turn();
    expect(request.mock.calls.filter((c) => c[0] === "ack" || c[0] === "input")).toHaveLength(0);
    expect([...renderer.write.mock.calls[0]![0]]).toEqual([228, 184, 173]);
    rendered();
    await turn();
    expect(request.mock.calls.find((c) => c[0] === "ack")?.[1].ack).toEqual({
      phase: "replay_ready",
      attemptId: "attempt",
      replayEpoch: "replay",
      renderedThrough: 3,
    });
    event({
      kind: "cutover",
      attemptId: "attempt",
      newLiveEpoch: "live",
      replayEnd: 3,
      liveFrom: 8,
      gap: { from: 3, to: 8 },
      resetParser: true,
    });
    expect(c.state.writable).toBe(true);
    expect(c.state.gap).toContain("[3, 8)");
    c.input(new Uint8Array([3]));
    await turn();
    const input = request.mock.calls.find((c) => c[0] === "input")![1];
    expect(input.inputSeq).toBe(0);
    expect(input.streamEpoch).toBe("live");
    expect(input.inputKind).toBe("user");
    c.dispose();
  });
  it("buffers bounded early events arriving before the attach response and never needs a second attach", async () => {
    let send!: (e: Record<string, unknown>) => void;
    const { c, event, request } = setup((op) => {
      if (op === "attach") {
        send({ kind: "replay_begin", attemptId: "attempt", replayEpoch: "replay", S: 0, N0: 0, deadlineAt: 13000 });
        return { ...attachment };
      }
      return { ok: true, revision: 2 };
    });
    send = event;
    await c.attach(fact as any);
    await turn();
    expect(request.mock.calls.filter((c) => c[0] === "attach")).toHaveLength(1);
    expect(request.mock.calls.find((c) => c[0] === "ack")?.[1].ack.phase).toBe("replay_ready");
    c.dispose();
  });
  it("fails once after the absolute replay deadline and remains background on late cutover", async () => {
    const { c, event, request } = setup();
    await c.attach(fact as any);
    event({ kind: "replay_begin", attemptId: "attempt", replayEpoch: "replay", S: 0, N0: 1, deadlineAt: 13000 });
    await vi.advanceTimersByTimeAsync(3001);
    expect(c.state.error).toBe("E_REPLAY_DEADLINE");
    expect(c.state.writable).toBe(false);
    event({
      kind: "cutover",
      attemptId: "attempt",
      newLiveEpoch: "live",
      replayEnd: 1,
      liveFrom: 1,
      gap: { from: 1, to: 1 },
      resetParser: true,
    });
    expect(c.state.writable).toBe(false);
    expect(request.mock.calls.filter((c) => c[0] === "detach")).toHaveLength(1);
    expect(request.mock.calls.some((c) => c[0] === "close")).toBe(false);
    c.dispose();
  });
  it("rejects wrong connection/attachment/epoch and a skipped output offset", async () => {
    const { c, event, renderer } = setup();
    await c.attach(fact as any);
    event(
      { kind: "replay_begin", attemptId: "attempt", replayEpoch: "replay", S: 0, N0: 1, deadlineAt: 13000 },
      { connectionInstance: "old" },
    );
    expect(renderer.reset).not.toHaveBeenCalled();
    event({ kind: "replay_begin", attemptId: "attempt", replayEpoch: "replay", S: 0, N0: 1, deadlineAt: 13000 });
    event({ kind: "output", offset: 1, bytesB64: "YQ==", streamEpoch: "replay" });
    await turn();
    expect(c.state.error).toContain("不连续");
    expect(renderer.write).not.toHaveBeenCalled();
    c.dispose();
  });
  it("revoke/disconnect erases all display metadata and freezes pending input, without closing the shell", async () => {
    const { c, request, revoked } = setup();
    await c.list();
    await c.attach(fact as any);
    c.event("disconnected", null);
    expect(c.state.rows).toEqual([]);
    expect(c.state.current).toBeNull();
    expect(revoked).toHaveBeenCalledOnce();
    c.input(new Uint8Array([97]));
    await turn();
    expect(request.mock.calls.some((c) => c[0] === "input" || c[0] === "close")).toBe(false);
    c.dispose();
  });
  it("expires the private connection even without user interaction; a new identity cannot keep the old writer", async () => {
    const { c, revoked } = setup();
    await c.attach(fact as any);
    await vi.advanceTimersByTimeAsync(70000);
    expect(revoked).toHaveBeenCalled();
    expect(c.state.current).toBeNull();
    expect(c.state.writable).toBe(false);
    c.dispose();
  });
  it("renderer detach releases only the writer; explicit close is a separate operation", async () => {
    const { c, request } = setup();
    await c.attach(fact as any);
    await c.detach();
    expect(request.mock.calls.map((c) => c[0])).toEqual(["attach", "detach"]);
    c.dispose();
  });
});
