import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalReaper } from "../../../src/web-hub/agent/terminal/reaper.js";
import { FakeClock } from "../../../src/core/clock.js";
import { TerminalOwner, terminalResourceHandoff } from "../../../src/web-hub/agent/terminal/owner.js";
import type {
  TerminalBackend,
  TerminalBackendOptions,
  TerminalPhysicalResult,
} from "../../../src/web-hub/agent/terminal/backend.js";
import {
  terminalFrameOk,
  type TermReq,
  type TermRes,
  type TermEvent,
  type TerminalResourceIdentity,
} from "../../../src/web-hub/protocol/terminal.js";
const limits = { maxPerSession: 1, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const processIdentity = { bootId: "boot", pid: 7, starttime: "1", uid: 1000 };
const owners: TerminalOwner[] = [];
afterEach(async () => {
  for (const o of owners.splice(0)) {
    await o.dispose();
    const proven = o.resourceEntries().filter((e) =>
      o.reapProof(e.identity, {
        hubBootId: "test",
        challengeId: "test",
        linkGen: 1,
        inventoryId: "test",
        revision: 0,
      }),
    );
    if (proven.length) o.forgetResolvedReceipts(proven.map((e) => e.identity));
  }
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function harness(maxPerSession = 1, clock = new FakeClock(1_000_000)) {
  vi.useFakeTimers();
  let allowed = true;
  const current = { localConnectionInstance: "connection", sessionId: "session", epoch: "epoch" };
  const sent: Array<TermRes | TermEvent> = [];
  let sendHook: ((frame: TermRes | TermEvent) => boolean) | undefined;
  const backs: Array<{
    options: TerminalBackendOptions;
    backend: TerminalBackend;
    finish(p: TerminalPhysicalResult): void;
    ready(): void;
  }> = [];
  const display = { shellName: "bash", userLabel: "user", hostLabel: "host", cwd: "/fixture" };
  const owner = new TerminalOwner(
    {
      ...current,
      cwd: "/fixture",
      clock,
      limits: { ...limits, maxPerSession },
      allowed: () => allowed,
      current: () => current,
      send: (f) => {
        expect(terminalFrameOk(f)).toBe(true);
        sent.push(f);
        return sendHook?.(f) ?? true;
      },
      backend: (options) => {
        let finish!: (p: TerminalPhysicalResult) => void, ready!: () => void;
        const done = new Promise<TerminalPhysicalResult>((r) => {
          finish = r;
        });
        const backend: TerminalBackend = {
          ready: new Promise((r) => {
            ready = r;
          }),
          done,
          managed: [],
          spawnSettled: false,
          display,
          input: vi.fn(async () => undefined),
          resize: vi.fn(async () => undefined),
          close: vi.fn(() => {
            for (const key of Object.keys(display)) delete (display as Record<string, string>)[key];
          }),
          retryReap: async () => ({
            outcome: "reap_incomplete",
            spawnSettled: true,
            ptyClosed: false,
            helperReaped: true,
            managedGroupsGone: false,
            identitiesChecked: [],
            waited: [],
          }),
        };
        backs.push({ options, backend, finish, ready });
        return backend;
      },
    },
    processIdentity,
  );
  owners.push(owner);
  const scope = { sessionId: "session", epoch: "epoch", ownerInstance: owner.ownerInstance };
  const request = (op: string, extra: object = {}, channelId = "channel") => {
    const f = {
      t: "term_req",
      v: 1,
      rid: `r-${sent.length}`,
      ...scope,
      op,
      ...(["protocol_ready", "bind"].includes(op) ? {} : { channelId }),
      ...extra,
    };
    expect(terminalFrameOk(f)).toBe(true);
    expect(owner.receive(f)).toBe(true);
    return f as TermReq;
  };
  const negotiate = (action = "negotiate", channelId = "channel") => {
    const offer = owner.offer(
      {
        t: "cmd",
        rid: "rid",
        id: `cmd-${sent.length}`,
        deadlineMs: 3000,
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "req" },
        cmd: { op: "command", name: "webhub", args: "__terminal" },
      },
      { v: 1, action, requestNonce: "nonce" },
    );
    expect(offer).toBeDefined();
    expect(
      owner.receive({
        t: "term_req",
        v: 1,
        rid: "prepare",
        sessionId: "session",
        epoch: "epoch",
        op: "prepare_protocol",
        offerId: offer!.offerId,
        hubNonce: "hub",
      }),
    ).toBe(true);
    const challenge = sent.at(-1)! as Extract<TermRes, { op: "protocol_challenge" }>;
    const handshake = { offerId: offer!.offerId, hubNonce: "hub", agentChallenge: challenge.agentChallenge };
    request("protocol_ready", handshake);
    const ready = sent.at(-1)!;
    if (action === "negotiate") {
      expect(ready).toHaveProperty("grant");
      request("bind", { ...handshake, proposedChannelId: channelId, grant: (ready as { grant: string }).grant });
    }
    return ready;
  };
  const open = (id = "one") =>
    request("open", {
      openId: id,
      termId: `t-${id}`,
      reservationId: `r-${id}`,
      ownerKey: "owner-key",
      attachmentId: "attachment",
      writerLease: "lease",
      cols: 80,
      rows: 24,
      createTicket: {
        v: 1,
        bootId: "hub-boot",
        ticketId: id,
        issuedAt: clock.now(),
        expiresAt: clock.now() + 600000,
        ownerBinding: { listener: "loopback", principal: "user", sidTag: "sid", agentKey: "agent", ...scope },
        payloadDigest: "a".repeat(64),
        mac: "b".repeat(64),
      },
    });
  const writer = { termId: "t-one", attachmentId: "attachment", writerLease: "lease" };
  const writable = () => {
    const begin = sent.findLast((f) => f.t === "term_event" && f.kind === "replay_begin") as Extract<
      TermEvent,
      { kind: "replay_begin" }
    >;
    request("ack", {
      ...writer,
      ack: {
        phase: "replay_ready",
        attemptId: begin.attemptId,
        replayEpoch: begin.replayEpoch,
        renderedThrough: begin.N0,
      },
    });
    return (
      sent.findLast((f) => f.t === "term_event" && f.kind === "cutover") as Extract<TermEvent, { kind: "cutover" }>
    ).newLiveEpoch;
  };
  const reaped = () =>
    backs[0]!.finish({
      outcome: "reaped",
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: [],
      waited: [],
    });
  return {
    owner,
    clock,
    sent,
    backs,
    request,
    negotiate,
    open,
    writer,
    writable,
    reaped,
    display,
    disable: () => {
      allowed = false;
    },
    replaceConnection: (id: string) => {
      current.localConnectionInstance = id;
    },
    setSendHook: (hook?: (frame: TermRes | TermEvent) => boolean) => {
      sendHook = hook;
    },
  };
}
describe("terminal owner logical vs physical state §§5.5/6", () => {
  it("does not spawn before dedicated ready+bind, pins physical slot until real result, never on close ACK", async () => {
    const h = harness();
    expect(h.backs).toHaveLength(0);
    h.negotiate();
    expect(h.backs).toHaveLength(0);
    h.open();
    expect(h.owner.physicalUsed).toBe(1);
    h.open("second");
    expect(h.backs).toHaveLength(1);
    expect(h.sent.at(-1)).toHaveProperty("code", "E_RESOURCE_QUARANTINED");
    h.backs[0]!.ready();
    await flush();
    const epoch = h.writable();
    h.request("input", { ...h.writer, inputSeq: 0, bytesB64: "YQ==", inputKind: "user", streamEpoch: epoch });
    await flush();
    h.request("input", { ...h.writer, inputSeq: 0, bytesB64: "YQ==", inputKind: "user", streamEpoch: epoch });
    await flush();
    expect(h.backs[0]!.backend.input).toHaveBeenCalledTimes(1);
    const entry = h.owner.resourceEntries()[0]!;
    h.request("close", {
      termId: entry.identity.termId,
      reservationId: entry.identity.reservationId,
      closeId: "close",
      expectedRevision: (h.sent.findLast((f) => f.t === "term_res" && f.op === "open" && f.ok) as { revision: number })
        .revision,
    });
    expect(h.owner.physicalUsed).toBe(1);
    expect(
      h.owner.reapProof(entry.identity, {
        hubBootId: "b",
        challengeId: "c",
        linkGen: 1,
        inventoryId: "i",
        revision: 1,
      }),
    ).toBeUndefined();
    h.reaped();
    await flush();
    expect(h.owner.physicalUsed).toBe(0);
  });
  it("bounded replay discards live during replay and cuts over once at the exact byte barrier", async () => {
    const h = harness();
    h.negotiate();
    h.open();
    h.backs[0]!.options.onData(Buffer.alloc(1024 * 1024 + 100, 65));
    h.backs[0]!.ready();
    await flush();
    const replay = h.sent.filter((f) => f.t === "term_event" && f.kind === "output") as Array<
      Extract<TermEvent, { kind: "output" }>
    >;
    expect(replay.reduce((n, f) => n + Buffer.from(f.bytesB64, "base64").length, 0)).toBe(16384);
    h.backs[0]!.options.onData(Buffer.alloc(100, 66));
    const before = h.sent.length;
    const liveEpoch = h.writable();
    const cut = h.sent.slice(before).find((f) => f.t === "term_event" && f.kind === "cutover") as Extract<
      TermEvent,
      { kind: "cutover" }
    >;
    expect(cut.gap.to - cut.gap.from).toBe(100);
    h.backs[0]!.options.onData(Buffer.from("live"));
    expect(h.sent.at(-1)).toMatchObject({ kind: "output", offset: cut.liveFrom, streamEpoch: liveEpoch });
    h.clock.advance(2000); // no renderer ACK: background, not killed
    h.request("input", {
      ...h.writer,
      inputSeq: 0,
      bytesB64: "eA==",
      inputKind: "terminal_response",
      streamEpoch: liveEpoch,
    });
    expect(h.sent.at(-1)).toHaveProperty("code", "E_LEASE_EXPIRED");
    expect(h.backs[0]!.backend.close).not.toHaveBeenCalled();
    h.reaped();
  });
  it("output/renew/automatic responses cannot extend inputIdle, but user bytes can", async () => {
    const h = harness();
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    const epoch = h.writable();
    h.clock.advance(500);
    h.request("input", {
      ...h.writer,
      inputSeq: 0,
      bytesB64: "eA==",
      inputKind: "terminal_response",
      streamEpoch: epoch,
    });
    await flush();
    h.clock.advance(500);
    h.request("renew", h.writer);
    h.backs[0]!.options.onData(Buffer.from("x"));
    h.clock.advance(3599000);
    expect(h.backs[0]!.backend.close).toHaveBeenCalledOnce();
    expect(h.owner.physicalUsed).toBe(1);
    h.reaped();
  });
  it("dispose synchronously revokes, hands only bounded data over, incomplete remains poison", async () => {
    const h = harness();
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    const dispose = h.owner.dispose();
    const handoff = terminalResourceHandoff().find((e) => e.identity.ownerInstance === h.owner.ownerInstance)!;
    expect(Object.keys(handoff).sort()).toEqual(["agentProcessIdentity", "identity", "managed", "spawnState", "state"]);
    expect(h.backs[0]!.backend.close).toHaveBeenCalledOnce();
    expect(h.owner.physicalUsed).toBe(1);
    h.reaped();
    await dispose;
    await flush();
    expect(h.owner.physicalUsed).toBe(0);
    expect(terminalResourceHandoff().some((e) => e.identity.ownerInstance === h.owner.ownerInstance)).toBe(false);
  });
  it("resource-only channel can inventory but never open/input; link retirement invalidates old channel", () => {
    const h = harness();
    const ready = h.negotiate("resource_inventory");
    const channel = (ready as { channelId: string }).channelId;
    const raw = {
      t: "term_req",
      v: 1,
      rid: "x",
      sessionId: "session",
      epoch: "epoch",
      ownerInstance: h.owner.ownerInstance,
      op: "list",
      channelId: channel,
    };
    expect(h.owner.receive(raw)).toBe(false);
    expect(h.backs).toHaveLength(0);
    h.owner.linkLost();
    expect(h.owner.receive(raw)).toBe(false);
  });
  it("privacy/secure guard revokes before output/metadata enqueue and clears cached panel labels", async () => {
    const h = harness();
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    h.writable();
    expect(h.sent.findLast((f) => f.t === "term_res" && f.op === "open")).toMatchObject({
      shellName: "bash",
      cwd: "/fixture",
    });
    h.request("list");
    for (const fact of (h.sent.at(-1) as { rows: unknown[] }).rows)
      for (const key of ["shellName", "userLabel", "hostLabel", "cwd"]) expect(fact).not.toHaveProperty(key);
    h.disable();
    const before = h.sent.length;
    h.backs[0]!.options.onData(Buffer.from("must not enqueue"));
    expect(h.sent).toHaveLength(before);
    expect(h.display).toEqual({});
    expect(h.backs[0]!.backend.close).toHaveBeenCalled();
    expect(h.owner.physicalUsed).toBe(1);
    h.reaped();
  });
  it("link retirement prevents a fresh channel attaching the old shell; 30s is cleanup deadline not release", async () => {
    const h = harness();
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    h.writable();
    h.owner.linkLost();
    h.negotiate("negotiate", "new-channel");
    h.request(
      "attach",
      {
        termId: "t-one",
        attachId: "new-attach",
        attachmentId: "new-attachment",
        writerLease: "new-lease",
        cols: 80,
        rows: 24,
      },
      "new-channel",
    );
    expect(h.sent.at(-1)).toHaveProperty("code", "E_BAD_REQUEST");
    h.clock.advance(30000);
    expect(h.owner.physicalUsed).toBe(1);
    expect(h.backs[0]!.backend.close).toHaveBeenCalled();
    h.reaped();
  });
  it("reload retains only plain reaped receipts for fresh challenges; trusted durable confirmation removes exactly once", async () => {
    const a = harness();
    a.negotiate();
    a.open();
    a.backs[0]!.ready();
    await flush();
    const old = a.owner.resourceEntries()[0]!.identity;
    a.reaped();
    await flush();
    await a.owner.dispose();
    const b = harness();
    expect(b.owner.physicalUsed).toBe(0);
    const evidence = {
      hubBootId: "new-boot",
      challengeId: "new-challenge",
      linkGen: 2,
      inventoryId: "new-inventory",
      revision: 1,
    };
    const proof = b.owner.reapProof(old, evidence)!;
    expect(proof).toMatchObject({ ...evidence, identity: old, outcome: "reaped" });
    expect(proof.identity.ownerInstance).not.toBe(b.owner.ownerInstance);
    expect(b.owner.resourceEntries()).toHaveLength(1);
    expect(b.owner.forgetResolvedReceipts([{ ...old, reservationId: "unknown" }])).toBe(0);
    expect(b.owner.forgetResolvedReceipts([old, old])).toBe(0);
    expect(b.owner.resourceEntries()).toHaveLength(1);
    expect(b.owner.forgetResolvedReceipts([old])).toBe(1);
    expect(b.owner.forgetResolvedReceipts([old])).toBe(0);
    expect(b.owner.resourceEntries()).toEqual([]);
  });

  it("32 unconfirmed reaped receipts are pinned across TTL and deny a new resource; trusted confirmation admits again", async () => {
    const h = harness();
    h.negotiate();
    const physical = {
      outcome: "reaped" as const,
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: [],
      waited: [],
    };
    for (let i = 0; i < 32; i++) {
      h.open(`receipt-${i}`);
      h.backs[i]!.ready();
      await flush();
      h.backs[i]!.finish(physical);
      await flush();
    }
    expect(h.owner.physicalUsed).toBe(0);
    expect(h.owner.resourceEntries()).toHaveLength(32);
    h.open("blocked");
    expect(h.backs).toHaveLength(32);
    expect(h.sent.at(-1)).toHaveProperty("code", "E_LIMIT");
    h.clock.advance(11 * 60 * 1000);
    expect(h.owner.resourceEntries()).toHaveLength(32); // Receipt retention is not a ticket TTL.
    const identity = h.owner.resourceEntries()[0]!.identity;
    expect(h.owner.forgetResolvedReceipts([identity])).toBe(1);
    h.open("admitted");
    expect(h.backs).toHaveLength(33);
    h.backs[32]!.ready();
    await flush();
    h.backs[32]!.finish(physical);
    await flush();
  });
});

describe("terminal reaper I1/I5 bounded attempts", () => {
  it("a stuck attempt times out, at most three rounds finish within 60s, start is idempotent", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(() => new Promise<boolean>(() => undefined));
    const reaper = new TerminalReaper(attempt);
    reaper.start();
    reaper.start();
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600000);
    expect(attempt).toHaveBeenCalledTimes(3);
    reaper.stop();
  });
  it("stop cancels a stuck attempt deadline and all retry timers without pretending success", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(() => new Promise<boolean>(() => undefined));
    const reaper = new TerminalReaper(attempt);
    reaper.start();
    expect(vi.getTimerCount()).toBe(1);
    reaper.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("F1 exact retired-link resource ownership", () => {
  const physical = {
    outcome: "reaped" as const,
    spawnSettled: true,
    ptyClosed: true,
    helperReaped: true,
    managedGroupsGone: true,
    identitiesChecked: [],
    waited: [],
  };
  it("old resources fully reaped, new link terminal survives the old 30s callback", async () => {
    const h = harness();
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    h.owner.linkLost();
    h.reaped();
    await flush();
    expect(h.owner.physicalUsed).toBe(0);
    h.replaceConnection("connection-2");
    h.negotiate();
    h.open("new");
    h.backs[1]!.ready();
    await flush();
    try {
      h.clock.advance(30000);
      expect(h.backs[1]!.backend.close).not.toHaveBeenCalled();
      expect(h.owner.physicalUsed).toBe(1);
    } finally {
      h.backs[1]!.finish(physical);
      await flush();
    }
  });
  it("two retired generations keep independent exact sets and never close a third generation", async () => {
    const h = harness(2);
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    h.owner.linkLost();
    h.reaped();
    await flush();
    h.clock.advance(1000);
    h.replaceConnection("connection-2");
    h.negotiate();
    h.open("second");
    h.backs[1]!.ready();
    await flush();
    h.owner.linkLost();
    h.replaceConnection("connection-3");
    h.negotiate();
    h.open("third");
    h.backs[2]!.ready();
    await flush();
    try {
      h.clock.advance(29000); // Only retirement #1 has expired.
      expect(h.backs[1]!.backend.close).not.toHaveBeenCalled();
      expect(h.backs[2]!.backend.close).not.toHaveBeenCalled();
      h.clock.advance(1000); // Retirement #2 closes only the second resource.
      expect(h.backs[1]!.backend.close).toHaveBeenCalledOnce();
      expect(h.backs[2]!.backend.close).not.toHaveBeenCalled();
    } finally {
      h.backs[1]!.finish(physical);
      h.backs[2]!.finish(physical);
      await flush();
    }
  });
});

/** Moves authoritative now without dispatching any timer callback. */
class DeferredClock extends FakeClock {
  private offset = 0;
  override now(): number {
    return super.now() + this.offset;
  }
  jump(ms: number): void {
    this.offset += ms;
  }
}
describe("F2 synchronous absolute expiry, overdue timer not dispatched", () => {
  it("replay ready after deadline+1ms fails and cannot cut over even with cleanup timer pending", async () => {
    const clock = new DeferredClock(1_000_000),
      h = harness(1, clock);
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    const begin = h.sent.findLast((f) => f.t === "term_event" && f.kind === "replay_begin") as Extract<
      TermEvent,
      { kind: "replay_begin" }
    >;
    clock.jump(3001); // DO NOT advance() or run timers.
    try {
      const before = h.sent.length;
      h.request("ack", {
        ...h.writer,
        ack: {
          phase: "replay_ready",
          attemptId: begin.attemptId,
          replayEpoch: begin.replayEpoch,
          renderedThrough: begin.N0,
        },
      });
      expect(h.sent.at(-1)).toMatchObject({ op: "ack", ok: false, code: "E_REPLAY_DEADLINE" });
      expect(h.sent.slice(before).some((f) => f.t === "term_event" && f.kind === "cutover")).toBe(false);
      h.request("renew", h.writer);
      expect(h.sent.at(-1)).toHaveProperty("code", "E_LEASE_EXPIRED");
    } finally {
      h.reaped();
      await flush();
    }
  });
  it("lease+1ms output is never enqueued, expired attachment is detached before the delayed tick", async () => {
    const clock = new DeferredClock(1_000_000),
      h = harness(1, clock);
    h.negotiate();
    h.open();
    h.backs[0]!.ready();
    await flush();
    h.writable();
    clock.jump(15001);
    try {
      const before = h.sent.length;
      h.backs[0]!.options.onData(Buffer.from("expired-output"));
      expect(h.sent).toHaveLength(before);
      h.request("renew", h.writer);
      expect(h.sent.at(-1)).toHaveProperty("code", "E_LEASE_EXPIRED");
      expect(h.backs[0]!.backend.close).not.toHaveBeenCalled(); // detached/background, not killed
    } finally {
      h.reaped();
      await flush();
    }
  });
});

type H = ReturnType<typeof harness>;
const reapedPhysical = {
  outcome: "reaped" as const,
  spawnSettled: true,
  ptyClosed: true,
  helperReaped: true,
  managedGroupsGone: true,
  identitiesChecked: [],
  waited: [],
};
async function createReceipt(h: H, id = "one", index = 0): Promise<TerminalResourceIdentity> {
  h.open(id);
  h.backs[index]!.ready();
  await flush();
  const identity = h.owner.resourceEntries().find((e) => e.identity.termId === `t-${id}`)!.identity;
  h.backs[index]!.finish(reapedPhysical);
  await flush();
  return identity;
}
function resourceChannel(h: H): string {
  return (h.negotiate("resource_inventory") as { channelId: string }).channelId;
}
function inventory(h: H, channelId: string, challengeId = "cleanup-challenge") {
  const before = h.sent.length;
  h.request(
    "inventory",
    { challenge: { hubBootId: "hub-boot", challengeId, linkGen: 1, deadlineAt: h.clock.now() + 5000 } },
    channelId,
  );
  const frames = h.sent
    .slice(before)
    .filter(
      (f): f is Extract<TermRes, { op: "inventory"; ok: true }> => f.t === "term_res" && f.op === "inventory" && f.ok,
    );
  expect(frames.map((f) => f.page.phase)).toEqual(["begin", ...frames.slice(1, -1).map(() => "chunk"), "end"]);
  return frames;
}
function resolvedAck(
  frames: ReturnType<typeof inventory>,
  identities?: TerminalResourceIdentity[],
  journalRevision = 1,
) {
  const begin = frames[0]!;
  const page = begin.page;
  return {
    t: "term_req",
    v: 1,
    rid: "durable-confirmation",
    sessionId: begin.sessionId,
    epoch: begin.epoch,
    ownerInstance: begin.ownerInstance,
    channelId: begin.channelId,
    op: "resolved_ack",
    resolved: {
      hubBootId: page.hubBootId,
      challengeId: page.challengeId,
      linkGen: page.linkGen,
      inventoryId: page.inventoryId,
      revision: page.revision,
      journalRevision,
      identities:
        identities ?? frames.flatMap((f) => (f.page.phase === "chunk" ? f.page.proofs.map((p) => p.identity) : [])),
    },
  };
}
describe("dedicated resolved_ack consumes only actually sent current physical proofs", () => {
  it.each(["hubBootId", "challengeId", "linkGen", "inventoryId", "revision"] as const)(
    "rejects wrong %s without any receipt deletion, then accepts exact current proof",
    async (field) => {
      const h = harness();
      h.negotiate();
      await createReceipt(h);
      const channel = resourceChannel(h),
        frames = inventory(h, channel),
        ack = resolvedAck(frames);
      const bad = {
        ...ack,
        resolved: { ...ack.resolved, [field]: typeof ack.resolved[field] === "number" ? 99 : "wrong" },
      };
      expect(h.owner.receive(bad)).toBe(false);
      expect(h.owner.resourceEntries()).toHaveLength(1);
      expect(h.owner.receive(ack)).toBe(true);
      expect(h.owner.resourceEntries()).toEqual([]);
      expect(h.owner.physicalUsed).toBe(0);
      expect(h.owner.receive(ack)).toBe(false);
    },
  );
  it.each(["sessionId", "epoch", "ownerInstance", "channelId"] as const)(
    "rejects wrong sender %s with a valid body",
    async (field) => {
      const h = harness();
      h.negotiate();
      await createReceipt(h);
      const ack = resolvedAck(inventory(h, resourceChannel(h)));
      expect(h.owner.receive({ ...ack, [field]: "wrong" })).toBe(false);
      expect(h.owner.resourceEntries()).toHaveLength(1);
      expect(h.owner.receive(ack)).toBe(true);
    },
  );
  it("unknown/duplicate identity batches never partially delete; an interactive channel cannot confirm", async () => {
    const h = harness();
    h.negotiate();
    const known = await createReceipt(h);
    const interactive = resolvedAck(inventory(h, "channel"));
    expect(h.owner.receive(interactive)).toBe(false);
    const ack = resolvedAck(inventory(h, resourceChannel(h)));
    for (const identities of [
      [known, known],
      [known, { ...known, reservationId: "unknown" }],
    ])
      expect(h.owner.receive({ ...ack, resolved: { ...ack.resolved, identities } })).toBe(false);
    expect(h.owner.resourceEntries()).toHaveLength(1);
    expect(h.owner.receive(ack)).toBe(true);
  });
  it("expired challenge rejects before a pending timer callback; a fresh challenge is required", async () => {
    const clock = new DeferredClock(1_000_000),
      h = harness(1, clock);
    h.negotiate();
    await createReceipt(h);
    const channel = resourceChannel(h),
      ack = resolvedAck(inventory(h, channel));
    clock.jump(5001);
    expect(h.owner.receive(ack)).toBe(false);
    expect(h.owner.resourceEntries()).toHaveLength(1);
    const fresh = resolvedAck(inventory(h, channel, "fresh-challenge"));
    expect(h.owner.receive(ack)).toBe(false);
    expect(h.owner.receive(fresh)).toBe(true);
  });
  it("superseded snapshots and journal revision regression reject; equal commit revision can confirm a different subset once", async () => {
    const h = harness(2);
    h.negotiate();
    const a = await createReceipt(h),
      b = await createReceipt(h, "two", 1);
    const channel = resourceChannel(h),
      stale = resolvedAck(inventory(h, channel, "old-challenge"));
    const frames = inventory(h, channel, "new-challenge");
    expect(h.owner.receive(stale)).toBe(false);
    expect(h.owner.receive(resolvedAck(frames, [a], 9))).toBe(true);
    expect(h.owner.receive(resolvedAck(frames, [b], 8))).toBe(false);
    expect(h.owner.resourceEntries()).toHaveLength(1);
    expect(h.owner.receive(resolvedAck(frames, [b], 9))).toBe(true);
    expect(h.owner.receive(resolvedAck(frames, [b], 9))).toBe(false);
    expect(h.owner.resourceEntries()).toEqual([]);
  });
  it("connection retirement invalidates the old receipt authority even if the exact old frame is replayed", async () => {
    const h = harness();
    h.negotiate();
    await createReceipt(h);
    const ack = resolvedAck(inventory(h, resourceChannel(h)));
    h.owner.linkLost();
    h.replaceConnection("new-connection");
    expect(h.owner.receive(ack)).toBe(false);
    expect(h.owner.resourceEntries()).toHaveLength(1);
    const fresh = resolvedAck(inventory(h, resourceChannel(h), "fresh-link-challenge"));
    expect(h.owner.receive(fresh)).toBe(true);
  });
  it("old-owner cleanup completing after inventory is NOT an already-sent proof; fresh snapshot confirms only the exact old identity", async () => {
    const a = harness();
    a.negotiate();
    a.open();
    a.backs[0]!.ready();
    await flush();
    const identity = a.owner.resourceEntries()[0]!.identity;
    const disposal = a.owner.dispose();
    const b = harness(),
      channel = resourceChannel(b);
    const beforeCleanup = inventory(b, channel);
    expect(beforeCleanup.flatMap((f) => (f.page.phase === "chunk" ? f.page.proofs : []))).toEqual([]);
    a.reaped();
    await disposal;
    await flush();
    expect(b.owner.receive(resolvedAck(beforeCleanup, [identity]))).toBe(false);
    expect(b.owner.resourceEntries()).toHaveLength(1);
    const fresh = inventory(b, channel, "after-old-cleanup");
    expect(b.owner.receive(resolvedAck(beforeCleanup, [identity]))).toBe(false);
    expect(b.owner.receive(resolvedAck(fresh, [identity]))).toBe(true);
    expect(b.owner.physicalUsed).toBe(0);
    expect(b.owner.resourceEntries()).toEqual([]);
    a.backs[0]!.options.onManaged?.(); // A late old reaper observer may still finish after this ACK.
    expect(b.owner.resourceEntries()).toEqual([]);
    expect(a.owner.resourceEntries()).toEqual([]);
  });
  it("an end-frame write failure cannot authorize receipt forgetting", async () => {
    const h = harness();
    h.negotiate();
    await createReceipt(h);
    const channel = resourceChannel(h);
    h.setSendHook((f) => !(f.t === "term_res" && f.op === "inventory" && f.ok && f.page.phase === "end"));
    const frames = inventory(h, channel),
      ack = resolvedAck(frames);
    expect(h.owner.receive(ack)).toBe(false);
    expect(h.owner.resourceEntries()).toHaveLength(1);
    h.setSendHook();
    expect(h.owner.receive(resolvedAck(inventory(h, resourceChannel(h), "after-failed-write")))).toBe(true);
  });
  it("a reentrant ACK before the end-frame send returns cannot race the snapshot installation", async () => {
    const h = harness();
    h.negotiate();
    await createReceipt(h);
    const channel = resourceChannel(h);
    const frames: ReturnType<typeof inventory> = [];
    let premature: boolean | undefined;
    h.setSendHook((f) => {
      if (f.t === "term_res" && f.op === "inventory" && f.ok) {
        frames.push(f);
        if (f.page.phase === "end") premature = h.owner.receive(resolvedAck(frames));
      }
      return true;
    });
    inventory(h, channel);
    expect(premature).toBe(false);
    expect(h.owner.resourceEntries()).toHaveLength(1);
    expect(h.owner.receive(resolvedAck(frames))).toBe(true);
  });
});
