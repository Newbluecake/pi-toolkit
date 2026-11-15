/** Deterministic dedicated-peer/journal barriers, NOT OS/PTY evidence. The real
 * separate-process per-session suite retains the receipt + /proc + fsync gate. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalService, type TerminalAgentTarget } from "../../../../src/web-hub/hub/terminal/service.js";
import { TerminalCollectionQueue } from "../../../../src/web-hub/hub/terminal/collection-queue.js";
import { TerminalResourceFence, inventoryDigest } from "../../../../src/web-hub/hub/terminal/resource-fence.js";
import type { LiveTerminalBinding } from "../../../../src/web-hub/hub/terminal/sse-binding.js";
import type { TerminalIngressMeta } from "../../../../src/web-hub/hub/ports.js";
import type { CmdFrame } from "../../../../src/web-hub/protocol/messages.js";
import {
  terminalFrameOk,
  type TerminalHubConfig,
  type TerminalJournal,
  type TerminalReapProof,
  type TerminalResourceEntry,
  type TermReq,
} from "../../../../src/web-hub/protocol/terminal.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// All peer replies are synchronous microtasks. Drain their bounded continuation
// graph without sleeps, extra collections or timing-dependent Promise.race tests.
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
const disposes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0)) await dispose();
  vi.useRealTimers();
});
const config: TerminalHubConfig = {
  maxPerSession: 2,
  maxPerPrincipal: 8,
  maxTotal: 8,
  inputIdleMs: 300000,
  maxLifetimeMs: 900000,
};
async function harness() {
  const targets = new Map<string, TerminalAgentTarget>(
    ["A", "B"].map((key, i) => [
      key,
      {
        meta: { agentKey: key, sessionId: key, epoch: "epoch", linkGen: 1 },
        processIdentity: { bootId: "boot", pid: 100 + i, starttime: "10", uid: 1000 },
        ownerInstance: `owner-${key}`,
        allowed: true,
        authorization: "1",
      },
    ]),
  );
  const physical = new Set(targets.keys());
  let disk: TerminalJournal = { v: 1, revision: 0, resources: [] };
  const commits: TerminalJournal[] = [];
  let hold: ReturnType<typeof deferred> | undefined;
  let entered: ReturnType<typeof deferred> | undefined;
  const released: string[] = [];
  const proved: string[] = [];
  const fence = new TerminalResourceFence({
    now: Date.now,
    journal: {
      load: async () => ({ kind: "trusted-new" }),
      commit: async (revision, next, signal) => {
        const pending = hold;
        hold = undefined;
        entered?.resolve();
        if (pending) await pending.promise;
        if (signal.aborted) return "unavailable";
        if (disk.revision !== revision) return "conflict";
        disk = structuredClone(next);
        commits.push(disk);
        return "committed";
      },
    },
    // Explicit mock physical port: validate exact producer/resource and all facts;
    // never infer reaped from a close/UI event. Production OS verifier is NOT replaced
    // in the integration acceptance tests.
    verifyProof: async (proof, entry) => {
      proved.push(entry.identity.agentSessionId);
      return (
        proof.proofId === `sealed-${entry.identity.reservationId}` &&
        JSON.stringify(proof.identity) === JSON.stringify(entry.identity) &&
        JSON.stringify(proof.agentProcessIdentity) === JSON.stringify(entry.agentProcessIdentity) &&
        proof.outcome === "reaped" &&
        proof.spawnSettled &&
        proof.ptyClosed &&
        proof.helperReaped &&
        proof.managedGroupsGone
      );
    },
    onRelease: (id) => released.push(id),
  });
  await fence.initialize(new AbortController().signal);
  const sent: Array<{ meta: TerminalIngressMeta; frame: TermReq | CmdFrame }> = [];
  const modes = new Map<string, boolean>();
  const entries = new Map<string, TerminalResourceEntry>();
  let afterResponse: ((key: string, frame: TermReq | CmdFrame) => void) | undefined;
  let service!: ReturnType<typeof createTerminalService>;
  const send = (meta: TerminalIngressMeta, frame: TermReq | CmdFrame) => {
    sent.push({ meta, frame });
    queueMicrotask(() => {
      const key = meta.agentKey;
      const target = targets.get(key)!;
      const deliver = (response: unknown) => {
        expect(terminalFrameOk(response)).toBe(true);
        service.ingress.consumeAgentFrame(meta, response);
      };
      if (frame.t === "cmd") {
        modes.set(key, frame.cmd.op === "command" && (frame.cmd.args ?? "").includes("resource_inventory"));
        service.ingress.consumeAgentFrame(meta, {
          t: "cmd_result",
          rid: frame.rid,
          id: frame.id,
          ok: true,
          data: {
            op: "command",
            kind: "builtin",
            completion: "sync",
            history: "none",
            terminal: { v: 1, outcome: "handshake-required", offerId: `offer-${key}` },
          },
        });
        afterResponse?.(key, frame);
        return;
      }
      const base = {
        t: "term_res",
        v: 1,
        rid: frame.rid,
        sessionId: meta.sessionId,
        epoch: meta.epoch,
        ownerInstance: target.ownerInstance,
        ok: true,
      };
      if (frame.op === "prepare_protocol")
        deliver({
          ...base,
          op: "protocol_challenge",
          offerId: frame.offerId,
          hubNonce: frame.hubNonce,
          agentChallenge: "challenge",
        });
      else if (frame.op === "protocol_ready")
        deliver({
          ...base,
          op: frame.op,
          offerId: frame.offerId,
          hubNonce: frame.hubNonce,
          agentChallenge: frame.agentChallenge,
          ...(modes.get(key)
            ? { mode: "resource-only", channelId: `resource-${key}` }
            : {
                mode: "interactive",
                grant: "grant",
                expiresAt: Date.now() + 50000,
                backend: "linux-pty-v1",
                limits: config,
              }),
        });
      else if (frame.op === "bind") deliver({ ...base, op: "bind", channelId: frame.proposedChannelId, bound: true });
      else if (frame.op === "open") {
        entries.set(key, {
          identity: {
            agentSessionId: meta.sessionId,
            epoch: meta.epoch,
            ownerInstance: target.ownerInstance!,
            termId: frame.termId,
            reservationId: frame.reservationId,
          },
          agentProcessIdentity: target.processIdentity,
          managed: [],
          spawnState: "settled",
          state: "closing",
        });
        deliver({
          ...base,
          op: "open",
          channelId: frame.channelId,
          termId: frame.termId,
          reservationId: frame.reservationId,
          attachmentId: frame.attachmentId,
          writerLease: frame.writerLease,
          revision: 1,
          state: "live",
          nextInputSeq: 0,
          baseOffset: 0,
          nextOffset: 0,
          deadlines: {
            inputIdleAt: Date.now() + 300000,
            lifetimeAt: Date.now() + 900000,
            parentExpiresAt: Date.now() + 900000,
          },
          replayMode: "cold",
        });
      } else if (frame.op === "inventory") {
        const entry = entries.get(key)!;
        const scope = { ...frame.challenge, inventoryId: `inventory-${key}`, revision: 1 };
        const { deadlineAt: _, ...evidence } = scope;
        const proof: TerminalReapProof = {
          ...evidence,
          identity: entry.identity,
          agentProcessIdentity: entry.agentProcessIdentity,
          proofId: `sealed-${entry.identity.reservationId}`,
          spawnSettled: true,
          ptyClosed: true,
          helperReaped: true,
          managedGroupsGone: true,
          identitiesChecked: [],
          outcome: "reaped",
        };
        const digest = inventoryDigest([entry]);
        const page = (value: object) =>
          deliver({ ...base, op: "inventory", channelId: frame.channelId, page: { ...evidence, ...value } });
        page({
          phase: "begin",
          sender: {
            agentSessionId: meta.sessionId,
            epoch: meta.epoch,
            ownerInstance: target.ownerInstance,
            processIdentity: target.processIdentity,
          },
          totalCount: 1,
          chunkCount: 1,
          digest,
        });
        page({ phase: "chunk", chunkIndex: 0, entries: [entry], proofs: [proof] });
        page({ phase: "end", chunkCount: 1, totalCount: 1, digest, complete: true });
      }
      afterResponse?.(key, frame);
    });
    return true;
  };
  service = createTerminalService({
    config,
    now: Date.now,
    target: (key) => targets.get(key),
    resourceCurrent: (meta) => physical.has(meta.agentKey),
    send,
    resourceFence: fence,
    pendingBytes: () => 0,
    privacy: { denied: () => false, onChange: () => () => {} },
    audit: () => {},
  });
  disposes.push(() => service.dispose());
  const identity = {
    listener: "loopback" as const,
    principal: "principal",
    sidTag: "sid",
    parentExpiresAt: Date.now() + 900000,
  };
  service.auth.loginComplete(identity, 0, service.auth.revision);
  const binding: LiveTerminalBinding = {
    identity,
    active: true,
    metadata: {
      ...identity,
      fenceRevision: 0,
      authEpoch: 0,
      clientId: "client",
      connectionInstance: "connection",
      connectionToken: "token",
      live: true,
    },
    activate() {},
    onRevoke: () => () => {},
    send: () => true,
    revoke() {},
  };
  for (const [key, target] of targets) {
    const base = {
      agentKey: key,
      expect: { sessionId: key, epoch: target.meta.epoch },
      clientId: "client",
      connectionInstance: "connection",
      connectionToken: "token",
      tabId: "tab",
      cols: 80,
      rows: 24,
    };
    const prepared = await service.request("prepare", base, identity, binding, new AbortController().signal);
    await service.request(
      "open",
      { ...base, openId: prepared.openId, createTicket: prepared.createTicket },
      identity,
      binding,
      new AbortController().signal,
    );
  }
  return {
    service,
    fence,
    released,
    proved,
    commits,
    sent,
    entries,
    disk: () => disk,
    collect: (key: string) =>
      service.collect(identity, binding, structuredClone(targets.get(key)!), new AbortController().signal),
    disconnect(key: string) {
      physical.delete(key);
    },
    withdraw(key: string) {
      const target = targets.get(key)!;
      target.allowed = false;
      target.authorization = "2";
      service.ingress.onIngressFailure?.(target.meta);
    },
    afterResponse(fn: typeof afterResponse) {
      afterResponse = fn;
    },
    holdCommit() {
      hold = deferred();
      entered = deferred();
      return { arrived: entered.promise, release: hold.resolve };
    },
  };
}

describe("shared single-writer inventory publication", () => {
  it.each([
    ["A", "B"],
    ["B", "A"],
  ])("%s fsync overlaps %s final snapshot: both exact flights drain once", async (first, second) => {
    const h = await harness();
    const held = h.holdCommit();
    const one = h.collect(first!);
    await held.arrived;
    const two = h.collect(second!);
    await flush();
    expect(
      h.sent.filter(
        ({ meta, frame }) => meta.agentKey === second && frame.t === "term_req" && frame.op === "inventory",
      ),
    ).toHaveLength(1);
    expect(h.released).toEqual([]);
    expect(h.service.limits.physicalUsed).toBe(2);
    held.release();
    await Promise.all([one, two]);
    expect(h.disk().resources).toEqual([]);
    expect(h.fence.records().resources).toEqual([]);
    expect(h.service.limits.physicalUsed).toBe(0);
    expect(h.released).toEqual([
      h.entries.get(first!)!.identity.reservationId,
      h.entries.get(second!)!.identity.reservationId,
    ]);
    const acks = h.sent.flatMap(({ meta, frame }) =>
      frame.t === "term_req" && frame.op === "resolved_ack" ? [{ key: meta.agentKey, ack: frame.resolved }] : [],
    );
    expect(acks.map(({ key }) => key)).toEqual([first, second]);
    for (const { key, ack } of acks) {
      expect(ack.identities).toEqual([h.entries.get(key)!.identity]);
      const inventory = h.sent.find(
        ({ meta, frame }) => meta.agentKey === key && frame.t === "term_req" && frame.op === "inventory",
      )!.frame;
      if (inventory.t !== "term_req" || inventory.op !== "inventory") throw new Error("exact flight missing");
      expect(ack.challengeId).toBe(inventory.challenge.challengeId);
      expect(ack.inventoryId).toBe(`inventory-${key}`);
    }
    expect(h.commits.slice(2).map((j) => j.resources.map((r) => [r.entry.identity.agentSessionId, r.status]))).toEqual([
      [
        ["A", first === "A" ? "resolved" : "unresolved"],
        ["B", first === "B" ? "resolved" : "unresolved"],
      ],
      [[second, "unresolved"]],
      [[second, "resolved"]],
      [],
    ]);
  });

  it("withdrawal while an established exact A flight queues behind B does not revoke its physical drain", async () => {
    const h = await harness();
    const held = h.holdCommit();
    const b = h.collect("B");
    await held.arrived;
    const a = h.collect("A");
    await flush();
    const before = h.sent.length;
    expect(
      h.sent.filter(({ meta, frame }) => meta.agentKey === "A" && frame.t === "term_req" && frame.op === "inventory"),
    ).toHaveLength(1);
    h.withdraw("A");
    held.release();
    await Promise.all([a, b]);
    expect(h.disk().resources).toEqual([]);
    expect(h.service.limits.physicalUsed).toBe(0);
    const frames = h.sent.slice(before).map(({ frame }) => frame);
    expect(
      frames.filter(
        (f) =>
          f.t === "cmd" || (f.t === "term_req" && ["prepare_protocol", "protocol_ready", "inventory"].includes(f.op)),
      ),
    ).toEqual([]);
    expect(frames.filter((f) => f.t === "term_req" && f.op === "resolved_ack")).toHaveLength(2);
  });

  it("a queued flight rechecks its own physical producer without invalidating the other agent", async () => {
    const h = await harness();
    const held = h.holdCommit();
    const b = h.collect("B");
    await held.arrived;
    const a = h.collect("A");
    await flush();
    h.disconnect("A");
    held.release();
    await Promise.all([a, b]);
    expect(h.proved).toEqual(["B"]);
    expect(h.disk().resources.map((r) => [r.entry.identity.agentSessionId, r.status])).toEqual([["A", "unresolved"]]);
    expect(h.service.limits.physicalUsed).toBe(1);
    expect(h.released).toEqual([h.entries.get("B")!.identity.reservationId]);
    expect(
      h.sent.filter(
        ({ meta, frame }) => meta.agentKey === "A" && frame.t === "term_req" && frame.op === "resolved_ack",
      ),
    ).toEqual([]);
  });

  it("a new A negotiation withdrawn while B publishes sends no fresh prepare/ready/inventory", async () => {
    const h = await harness();
    const held = h.holdCommit();
    const b = h.collect("B");
    await held.arrived;
    let boundary = -1;
    h.afterResponse((key, frame) => {
      if (key === "A" && frame.t === "cmd") {
        boundary = h.sent.length;
        h.withdraw("A");
      }
    });
    await h.collect("A");
    expect(boundary).toBeGreaterThan(0);
    expect(
      h.sent
        .slice(boundary)
        .filter(
          ({ meta, frame }) =>
            meta.agentKey === "A" &&
            frame.t === "term_req" &&
            ["prepare_protocol", "protocol_ready", "inventory"].includes(frame.op),
        ),
    ).toEqual([]);
    held.release();
    await b;
    expect(h.disk().resources.map((r) => [r.entry.identity.agentSessionId, r.status])).toEqual([["A", "unresolved"]]);
    expect(h.service.limits.physicalUsed).toBe(1);
    expect(h.released).toEqual([h.entries.get("B")!.identity.reservationId]);
  });

  it("queued exact flight expires within its original 2s: no publication, release or ACK", async () => {
    vi.useFakeTimers();
    const h = await harness();
    const held = h.holdCommit();
    const b = h.collect("B");
    await held.arrived;
    const a = h.collect("A");
    await flush();
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all([a, b]);
    held.release();
    await flush();
    expect(h.proved).toEqual(["B"]); // A never enters the writer after expiry
    expect(h.disk().resources.map((r) => r.status)).toEqual(["unresolved", "unresolved"]);
    expect(h.service.limits.physicalUsed).toBe(2);
    expect(h.released).toEqual([]);
    expect(h.sent.filter(({ frame }) => frame.t === "term_req" && frame.op === "resolved_ack")).toEqual([]);
  });

  it("32 active/queued publications are bounded; overflow fails closed without invoking its resource mutation", async () => {
    const h = await harness();
    const queue = new TerminalCollectionQueue(Date.now);
    const held = deferred();
    const signal = new AbortController().signal;
    const deadline = Date.now() + 2000;
    const jobs = [queue.run(() => held.promise, deadline, signal)];
    for (let i = 1; i < 32; i++) jobs.push(queue.run(async () => {}, deadline, signal));
    const publish = vi.fn(() => h.collect("A"));
    await expect(queue.run(publish, deadline, signal)).rejects.toMatchObject({ code: "E_LIMIT" });
    expect(publish).not.toHaveBeenCalled();
    expect(h.disk().resources.map((r) => r.status)).toEqual(["unresolved", "unresolved"]);
    expect(h.service.limits.physicalUsed).toBe(2);
    expect(h.released).toEqual([]);
    held.resolve();
    await Promise.all(jobs);
    expect(h.disk().resources).toHaveLength(2);
  });
});

// Logical cancellation cannot let a successor overtake a publication whose
// underlying IO is still settling (even though its caller has already returned).
it("canceling an active caller does not unlock the publication writer early", async () => {
  const queue = new TerminalCollectionQueue(Date.now);
  const controller = new AbortController();
  const held = deferred();
  const first = queue.run(() => held.promise, Date.now() + 2000, controller.signal);
  const rejection = expect(first).rejects.toMatchObject({ code: "E_DEADLINE" });
  await flush();
  const next = vi.fn(async () => "published");
  const second = queue.run(next, Date.now() + 2000, new AbortController().signal);
  controller.abort();
  await rejection;
  await flush();
  expect(next).not.toHaveBeenCalled();
  held.resolve();
  expect(await second).toBe("published");
  expect(next).toHaveBeenCalledTimes(1);
});

// Direct queue tests intentionally omit the service's physical guard: that guard
// must not mask a missing queue-owned recheck after the logical caller returns.
describe("direct publication queue: expired waiters never execute (M1/d2)", () => {
  it.each(["abort", "deadline"] as const)(
    "%s while B waits: reject B before releasing A, then never invoke B's publication",
    async (invalidation) => {
      vi.useFakeTimers();
      const queue = new TerminalCollectionQueue(Date.now);
      const entered = deferred();
      const held = deferred();
      const a = queue.run(
        () => {
          entered.resolve();
          return held.promise;
        },
        Date.now() + 10000,
        new AbortController().signal,
      );
      await entered.promise;
      const controller = new AbortController();
      let mutations = 0;
      const publishB = vi.fn(async () => {
        mutations++;
      });
      const b = queue.run(publishB, Date.now() + 50, controller.signal);
      const rejected = expect(b).rejects.toMatchObject({ code: "E_DEADLINE" });
      if (invalidation === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(51);
      await rejected; // B's caller is already gone, but A still owns the writer.
      held.resolve();
      await a;
      await flush();
      expect(publishB).not.toHaveBeenCalled();
      expect(mutations).toBe(0);
    },
  );
});

describe("direct publication queue: a failed item cannot poison successors (M2/d3)", () => {
  it.each(["rejected promise", "synchronous throw"] as const)(
    "A fails by %s after its barrier: queued B and later C both publish once",
    async (failure) => {
      const queue = new TerminalCollectionQueue(Date.now);
      const entered = deferred();
      const held = deferred();
      const error = new Error("publication A failed");
      const failPublication = (): Promise<never> => {
        if (failure === "synchronous throw") throw error;
        return Promise.reject(error);
      };
      const a = queue.run(
        () => {
          entered.resolve();
          return held.promise.then(failPublication);
        },
        Date.now() + 10000,
        new AbortController().signal,
      );
      const rejected = expect(a).rejects.toBe(error);
      await entered.promise;
      const publishB = vi.fn(async () => "B published");
      const b = queue.run(publishB, Date.now() + 10000, new AbortController().signal);
      const bSucceeded = expect(b).resolves.toBe("B published");
      held.resolve();
      await rejected; // The original publication error, not a generic deadline.
      await bSucceeded;
      expect(publishB).toHaveBeenCalledTimes(1);
      const publishC = vi.fn(async () => "C published");
      await expect(queue.run(publishC, Date.now() + 10000, new AbortController().signal)).resolves.toBe("C published");
      expect(publishC).toHaveBeenCalledTimes(1);
    },
  );

  it("a synchronous throw at publication entry also leaves queued B and later C usable", async () => {
    const queue = new TerminalCollectionQueue(Date.now);
    const entered = deferred();
    const held = deferred();
    const predecessor = queue.run(
      () => {
        entered.resolve();
        return held.promise;
      },
      Date.now() + 10000,
      new AbortController().signal,
    );
    await entered.promise;
    const error = new Error("synchronous publication A failure");
    const publishA = vi.fn((): Promise<never> => {
      throw error;
    });
    const a = queue.run(publishA, Date.now() + 10000, new AbortController().signal);
    const rejected = expect(a).rejects.toBe(error);
    const publishB = vi.fn(async () => "B published");
    const b = queue.run(publishB, Date.now() + 10000, new AbortController().signal);
    const bSucceeded = expect(b).resolves.toBe("B published");
    held.resolve();
    await predecessor;
    await rejected;
    expect(publishA).toHaveBeenCalledTimes(1);
    await bSucceeded;
    expect(publishB).toHaveBeenCalledTimes(1);
    const publishC = vi.fn(async () => "C published");
    await expect(queue.run(publishC, Date.now() + 10000, new AbortController().signal)).resolves.toBe("C published");
    expect(publishC).toHaveBeenCalledTimes(1);
  });

  it("an aborted middle waiter B rejects before A ends, but cannot poison queued C", async () => {
    const queue = new TerminalCollectionQueue(Date.now);
    const entered = deferred();
    const held = deferred();
    const a = queue.run(
      () => {
        entered.resolve();
        return held.promise;
      },
      Date.now() + 10000,
      new AbortController().signal,
    );
    await entered.promise;
    const controller = new AbortController();
    const publishB = vi.fn(async () => "B must not publish");
    const b = queue.run(publishB, Date.now() + 5000, controller.signal);
    const rejected = expect(b).rejects.toMatchObject({ code: "E_DEADLINE" });
    controller.abort();
    await rejected;
    const publishC = vi.fn(async () => "C published");
    const c = queue.run(publishC, Date.now() + 10000, new AbortController().signal);
    const cSucceeded = expect(c).resolves.toBe("C published");
    expect(publishC).not.toHaveBeenCalled();
    held.resolve();
    await a;
    await cSucceeded;
    expect(publishB).not.toHaveBeenCalled();
    expect(publishC).toHaveBeenCalledTimes(1);
  });
});
