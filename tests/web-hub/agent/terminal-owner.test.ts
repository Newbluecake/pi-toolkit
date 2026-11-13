import { afterEach, describe, expect, it, vi } from "vitest";
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
function harness() {
  vi.useFakeTimers();
  const clock = new FakeClock(1_000_000);
  let allowed = true;
  const current = { localConnectionInstance: "connection", sessionId: "session", epoch: "epoch" };
  const sent: Array<TermRes | TermEvent> = [];
  const backs: Array<{
    options: TerminalBackendOptions;
    backend: TerminalBackend;
    finish(p: TerminalPhysicalResult): void;
    ready(): void;
  }> = [];
  const display = { shellName: "bash", userLabel: "user", hostLabel: "host", cwd: "/fixture" };
  const owner = new TerminalOwner({
    ...current,
    cwd: "/fixture",
    clock,
    limits,
    allowed: () => allowed,
    current: () => current,
    send: (f) => {
      expect(terminalFrameOk(f)).toBe(true);
      sent.push(f);
      return true;
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
  });
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
