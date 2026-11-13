// @vitest-environment happy-dom
import { watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalController } from "../../../src/web-hub/ui/src/components/terminal/controller.js";
import type { TerminalTransport } from "../../../src/web-hub/ui/src/transport/terminal.js";
const fact = {
  termId: "term",
  reservationId: "reservation",
  revision: 1,
  state: "live",
  nextInputSeq: 0,
  baseOffset: 0,
  nextOffset: 0,
  deadlines: { inputIdleAt: 90000, lifetimeAt: 100000, parentExpiresAt: 90000 },
};
const ticket = {
  v: 1,
  bootId: "boot",
  ticketId: "ticket",
  issuedAt: 10000,
  expiresAt: 90000,
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
const privateAttachment = {
  ok: true,
  ...fact,
  attachmentId: "old-attachment",
  writerLease: "old-lease",
  replayMode: "cold",
  cwd: "/private-marker",
  userLabel: "private-marker-user",
};
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function setup(stage: "list" | "attach" | "prepare" | "open") {
  const pending = deferred();
  let held = false,
    revokeNext = false,
    clientId = "client";
  const scope = { agentKey: "agent", expect: { sessionId: "session", epoch: "epoch" } };
  const revoked = vi.fn();
  const renderer = { write: vi.fn(async () => {}), reset: vi.fn(), dimensions: () => ({ cols: 80, rows: 24 }) };
  const request = vi.fn((op: string, body: any, _signal?: AbortSignal) => {
    if (op === stage && !held) {
      held = true;
      return pending.promise;
    } // Intentionally ignores abort.
    if (revokeNext && op === "list") {
      revokeNext = false;
      return Promise.resolve({ ok: false, code: "E_AUTH_REVOKING", effect: "none" });
    }
    if (op === "prepare") return Promise.resolve({ ok: true, openId: "ticket", createTicket: ticket });
    if (op === "list") return Promise.resolve({ ok: true, revision: 2, rows: [] });
    if (op === "attach" || op === "open")
      return Promise.resolve({
        ...privateAttachment,
        termId: body.termId ?? "term",
        attachmentId: "new-attachment",
        writerLease: "new-lease",
        cwd: "/new-authority",
        userLabel: "new-user",
      });
    return Promise.resolve({ ok: true, revision: 2 });
  });
  const c = createTerminalController({
    transport: { request } as unknown as TerminalTransport,
    scope,
    clientId: () => clientId,
    renderer,
    revoked,
  });
  const connect = (connectionInstance = "new-instance", connectionToken = "new-token") =>
    c.event("terminal_connection", { connectionInstance, connectionToken, expiresAt: Date.now() + 10000 });
  connect("old-instance", "old-token");
  const result =
    stage === "list"
      ? { ok: true, revision: 1, rows: [{ ...fact, ownerLabel: "private-marker-owner" }] }
      : stage === "prepare"
        ? { ok: true, openId: "ticket", createTicket: ticket }
        : privateAttachment;
  const begin = () =>
    (stage === "list" ? c.list() : stage === "attach" ? c.attach(fact as any) : c.open()).then(
      () => null,
      (error) => error,
    );
  const send = (event: any) =>
    c.event("terminal", {
      agentKey: "agent",
      attachmentId: "new-attachment",
      connectionInstance: "new-instance",
      event: {
        v: 1,
        sessionId: "session",
        epoch: "epoch",
        ownerInstance: "owner",
        termId: "new-term",
        revision: 2,
        ...event,
      },
    });
  const newWriter = async () => {
    await c.attach({ ...fact, termId: "new-term" } as any);
    send({
      kind: "replay_begin",
      attemptId: "attempt",
      replayEpoch: "replay",
      S: 0,
      N0: 0,
      deadlineAt: Date.now() + 3000,
    });
    await turn();
    send({
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
  };
  return {
    c,
    request,
    pending,
    result,
    begin,
    connect,
    revoked,
    newWriter,
    scope,
    setClient(value: string) {
      clientId = value;
    },
    async revoke() {
      revokeNext = true;
      await c.list().catch(() => {});
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("terminal HTTP authority races (B1)", () => {
  for (const stage of ["list", "attach", "prepare", "open"] as const) {
    for (const boundary of ["disconnect", "replacement", "token-replacement", "expiry", "revoke", "dispose"] as const) {
      for (const outcome of ["success", "failure"] as const) {
        it(`${stage} in flight → ${boundary} → old ${outcome} never restores data/timer/writer or continues the operation`, async () => {
          const h = setup(stage),
            flight = h.begin();
          await turn();
          expect(h.request.mock.calls.some((call) => call[0] === stage)).toBe(true);
          const oldSignal = h.request.mock.calls.find((call) => call[0] === stage)![2]!;
          if (boundary === "disconnect") {
            h.c.event("disconnected", null);
            h.connect();
          } else if (boundary === "replacement") h.connect();
          else if (boundary === "token-replacement") h.connect("old-instance", "replacement-token");
          else if (boundary === "expiry") {
            await vi.advanceTimersByTimeAsync(10001);
            h.connect();
          } else if (boundary === "revoke") {
            await h.revoke();
            h.connect();
          } else {
            h.c.dispose();
            h.connect();
          }
          expect(oldSignal.aborted).toBe(true);
          const before = JSON.stringify(h.c.state),
            calls = h.request.mock.calls.length,
            timers = vi.getTimerCount(),
            revocations = h.revoked.mock.calls.length;
          if (outcome === "success") h.pending.resolve(h.result);
          else h.pending.resolve({ ok: false, code: "E_AUTH_REVOKING", effect: "none" });
          expect(await flight).toBeInstanceOf(Error);
          await turn();
          expect(JSON.stringify(h.c.state)).toBe(before);
          expect(JSON.stringify(h.c.state)).not.toContain("private-marker");
          expect(h.request).toHaveBeenCalledTimes(calls);
          expect(vi.getTimerCount()).toBe(timers);
          expect(h.revoked).toHaveBeenCalledTimes(revocations);
          expect(h.c.state.rows).toEqual([]);
          expect(h.c.state.current).toBeNull();
          expect(h.c.state.writable).toBe(false);
          h.c.dispose();
          expect(vi.getTimerCount()).toBe(0);
        });
      }
    }
  }
  it("old failure after await cannot revoke a new writable attachment (mutation target)", async () => {
    const h = setup("list"),
      flight = h.begin();
    await turn();
    h.connect();
    await h.newWriter();
    const before = JSON.stringify(h.c.state),
      timers = vi.getTimerCount(),
      revocations = h.revoked.mock.calls.length;
    h.pending.resolve({ ok: false, code: "E_AUTH_REVOKING", effect: "none" });
    await flight;
    await turn();
    expect(h.c.state.writable).toBe(true);
    expect(h.c.state.current?.cwd).toBe("/new-authority");
    expect(JSON.stringify(h.c.state)).toBe(before);
    expect(vi.getTimerCount()).toBe(timers);
    expect(h.revoked).toHaveBeenCalledTimes(revocations);
    h.c.dispose();
  });
  it("an old transport rejection is equally inert; an old action finally cannot clear the successor busy state", async () => {
    const h = setup("list");
    const action = h.c.action(() => h.c.list());
    await turn();
    h.connect();
    await h.newWriter();
    const wait = deferred();
    const successor = h.c.action(async (guard) => {
      await wait.promise;
      guard();
    });
    expect(h.c.state.busy).toBe(true);
    h.pending.reject(new Error("old transport rejected"));
    await action;
    await turn();
    expect(h.c.state.busy).toBe(true);
    expect(h.c.state.writable).toBe(true);
    expect(h.c.state.error).not.toContain("old transport");
    wait.resolve(undefined);
    await successor;
    h.c.dispose();
  });
  it("a stale UI preflight cannot open on a replacement connection, even when its renderer ignores cancellation", async () => {
    const h = setup("prepare"),
      wait = deferred();
    const action = h.c.action(async (guard) => {
      await wait.promise;
      guard();
      await h.c.open();
    });
    h.connect();
    wait.resolve(undefined);
    await action;
    expect(h.request).not.toHaveBeenCalled();
    h.c.dispose();
  });
  it("rechecks again between call resolution and the metadata commit continuation", async () => {
    const h = setup("list"),
      flight = h.begin();
    h.pending.resolve(h.result);
    await Promise.resolve(); // call() post-await check runs, but refreshList() has not committed yet.
    h.c.event("disconnected", null);
    await flight;
    expect(h.c.state.rows).toEqual([]);
    h.c.dispose();
  });
  it("expiry at await completion is checked against the clock even before its timer callback runs", async () => {
    const h = setup("attach"),
      flight = h.begin();
    await turn();
    vi.setSystemTime(20001);
    h.pending.resolve(h.result);
    await flight;
    expect(h.c.state.current).toBeNull();
    expect(h.c.state.writable).toBe(false);
    expect(h.request.mock.calls.some((call) => call[0] === "renew")).toBe(false);
    h.c.dispose();
  });
  it.each(["scope", "client"])("prepare is also bound to its original %s", async (key) => {
    const h = setup("prepare"),
      flight = h.begin();
    await turn();
    if (key === "scope") h.scope.expect.epoch = "new-epoch";
    else h.setClient("new-client");
    h.pending.resolve(h.result);
    await flight;
    expect(h.request.mock.calls.map((call) => call[0])).toEqual(["prepare"]);
    h.c.dispose();
  });
  it("same wire identity after disconnect cannot revive old authority (ABA)", async () => {
    const h = setup("attach"),
      flight = h.begin();
    await turn();
    h.c.event("disconnected", null);
    h.connect("old-instance", "old-token");
    h.pending.resolve(h.result);
    await flight;
    expect(h.c.state.current).toBeNull();
    h.c.dispose();
  });
  it("dispose sends best-effort detach using an independent immutable permission snapshot and no canceled signal", async () => {
    const h = setup("list");
    await h.c.attach(fact as any);
    const old = h.request.mock.calls.find((call) => call[0] === "attach")![2]!;
    h.c.dispose();
    const detach = h.request.mock.calls.find((call) => call[0] === "detach")!;
    expect(old.aborted).toBe(true);
    expect(detach[2]).toBeUndefined();
    expect(detach[1]).toMatchObject({
      connectionInstance: "old-instance",
      connectionToken: "old-token",
      clientId: "client",
      expect: { sessionId: "session", epoch: "epoch" },
      attachmentId: "new-attachment",
      writerLease: "new-lease",
    });
    h.connect();
    await turn();
    expect(h.c.state.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not install a renew timer if a synchronous observer revokes during adopt", async () => {
    const h = setup("attach"),
      flight = h.begin();
    await turn();
    const stop = watch(
      () => h.c.state.current,
      (value) => {
        if (value?.cwd === "/private-marker") {
          h.c.event("disconnected", null);
          h.connect();
        }
      },
      { flush: "sync" },
    );
    h.pending.resolve(h.result);
    await flight;
    expect(h.c.state.current).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    stop();
    h.c.dispose();
  });
  it("rechecks before failure revocation even if a synchronous error observer replaces the connection", async () => {
    const h = setup("list"),
      flight = h.begin();
    await turn();
    const stop = watch(
      () => h.c.state.error,
      (value) => {
        if (value === "E_AUTH_REVOKING") h.connect();
      },
      { flush: "sync" },
    );
    h.pending.resolve({ ok: false, code: "E_AUTH_REVOKING", effect: "none" });
    await flight;
    stop();
    await h.newWriter();
    expect(h.c.state.current?.cwd).toBe("/new-authority");
    expect(h.c.state.writable).toBe(true);
    h.c.dispose();
  });
});
