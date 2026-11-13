/** F2: real socket ingress + owned durable journal + resource fence + local proof verifier.
 * Q4 PTY/multiple-pgid/late-future OS facts are tested by P1-A in web-hub-terminal-pty.test.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, chmod, rm, readFile, open, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createTerminalResourceJournal } from "../../src/web-hub/hub/terminal/resource-fence-journal.js";
import {
  TerminalResourceFence,
  createLocalTerminalProofVerifier,
  inventoryDigest,
} from "../../src/web-hub/hub/terminal/resource-fence.js";
import {
  terminalIdentityKey,
  type TerminalResourceEntry,
  type TerminalReapProof,
  type TerminalInventoryPage,
  type TerminalChallenge,
  type TerminalResolvedAck,
} from "../../src/web-hub/protocol/terminal.js";
import { connectClient, hello, waitFor } from "../web-hub/hub/helpers.js";
import type { TerminalResourceJournalPort, TerminalIngressMeta } from "../../src/web-hub/hub/ports.js";
import { terminalUnavailable } from "../../src/web-hub/hub/ports.js";
import { terminalHarness, type TerminalHarness } from "./web-hub-terminal-harness.js";

const lives: TerminalHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.close();
});
const processIdentity = { bootId: "linux-boot", pid: 7, starttime: "100", uid: 1000 };
const identity = {
  agentSessionId: "old-session",
  termId: "term",
  epoch: "old-epoch",
  ownerInstance: "old-owner",
  reservationId: "reservation",
};
const evidence = { hubBootId: "hub-boot", challengeId: "challenge", linkGen: 1, inventoryId: "inventory", revision: 1 };
const proof = {
  ...evidence,
  identity,
  agentProcessIdentity: processIdentity,
  proofId: "proof",
  spawnSettled: true,
  ptyClosed: true,
  helperReaped: true,
  managedGroupsGone: true,
  identitiesChecked: [],
  outcome: "reaped",
};
const frame = (page: unknown) => ({
  t: "term_res",
  v: 1,
  rid: "inventory-rid",
  sessionId: "session",
  epoch: "epoch-1",
  ownerInstance: "owner",
  channelId: "resource-channel",
  op: "inventory",
  ok: true,
  page,
});

describe("F2 Q1–Q4 P1-C schema/ingress subsets (§5.5.1)", () => {
  it("Q1 / Q2 / Q4 invalid evidence is isolated before the optional verifier, valid evidence stays private", async () => {
    const received: unknown[] = [];
    const h = await terminalHarness({
      terminal: { ownsCommand: () => false, consumeAgentFrame: (_meta, raw) => received.push(raw), retireLink() {} },
    });
    lives.push(h);
    const streams = await Promise.all([h.sse(0), h.sse(1)]);
    const valid = frame({ ...evidence, phase: "chunk", chunkIndex: 0, entries: [], proofs: [proof] });
    h.client.send(valid);
    // Q1 mandatory incarnation/string identity; Q2 page cardinality/closed union; Q4 evidence booleans.
    h.client.send(
      frame({
        ...evidence,
        phase: "chunk",
        chunkIndex: 0,
        entries: [],
        proofs: [{ ...proof, identity: { ...identity, epoch: 2 } }],
      }),
    );
    h.client.send(
      frame({
        ...evidence,
        phase: "begin",
        sender: { agentSessionId: "s", epoch: "e", ownerInstance: "o", processIdentity },
        totalCount: 33,
        chunkCount: 1,
        digest: "a".repeat(64),
      }),
    );
    h.client.send(
      frame({ ...evidence, phase: "end", totalCount: 1, chunkCount: 1, digest: "invalid", complete: true }),
    );
    for (const field of ["spawnSettled", "ptyClosed", "helperReaped", "managedGroupsGone"])
      h.client.send(
        frame({ ...evidence, phase: "chunk", chunkIndex: 0, entries: [], proofs: [{ ...proof, [field]: false }] }),
      );
    h.client.send(
      frame({ ...evidence, phase: "chunk", chunkIndex: 0, entries: [], proofs: [{ ...proof, cleaned: true }] }),
    );
    await h.barrier();
    expect(received).toEqual([valid]);
    expect(h.bus.filter((e) => JSON.stringify(e).includes("reservation"))).toEqual([]);
    for (const s of streams) expect(JSON.stringify(s.events)).not.toContain("reservation");
  });
  it("Q3 absent service is explicitly Unavailable, never zero inventory / cleared permission", () => {
    expect(terminalUnavailable()).toEqual({ ok: false, code: "E_UNAVAILABLE", effect: "none" });
    expect(terminalUnavailable()).not.toHaveProperty("physicalUsed");
    expect(terminalUnavailable()).not.toHaveProperty("state", "cleared");
  });
});

async function actualProcess(pid: number) {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const stat = await readFile(`/proc/${pid}/stat`, "utf8"),
    tail = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(" ");
  return { bootId, pid, starttime: tail[19]!, uid: process.getuid!(), sid: Number(tail[3]), pgid: Number(tail[2]) };
}
async function resourceFixture(n = 2, independent = false) {
  const dir = await mkdtemp(join(tmpdir(), "q-"));
  await chmod(dir, 0o700);
  let now = 1000;
  const signal = new AbortController().signal;
  const agent = await actualProcess(process.pid),
    { sid: _, pgid: __, ...agentProcessIdentity } = agent;
  const entries: TerminalResourceEntry[] = [];
  for (let i = 0; i < n; i++) {
    // Real reaped node worker, no shell/rc/user HOME. PTY settlement is A's separate gate.
    const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await once(child, "message");
      const managed = await actualProcess(child.pid!);
      entries.push({
        identity: {
          agentSessionId: `old-session-${i}`,
          termId: `term-${i}`,
          epoch: "old-epoch",
          ownerInstance: `old-owner-${i}`,
          reservationId: `reservation-${i}`,
        },
        agentProcessIdentity:
          independent && i > 0
            ? { bootId: managed.bootId, pid: managed.pid, starttime: managed.starttime, uid: managed.uid }
            : agentProcessIdentity,
        managed: [{ ...managed, role: "helper" }],
        spawnState: "settled",
        state: "poison",
      });
    } finally {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
  const initial = createTerminalResourceJournal({ stateDir: dir, now: () => now, trustedNew: async () => true });
  expect((await initial.load(signal)).kind).toBe("trusted-new");
  expect(
    await initial.commit(
      0,
      { v: 1, revision: 1, resources: entries.map((entry) => ({ entry, status: "unresolved" })) },
      signal,
    ),
  ).toBe("committed");
  // New instance really reloads the persisted journal; ENOENT is not a new-store proof.
  const disk = createTerminalResourceJournal({ stateDir: dir, now: () => now });
  let failCommit = false;
  const release: string[] = [],
    receipts = new Set<string>();
  const journal: TerminalResourceJournalPort = {
    load: (s) => disk.load(s),
    commit: (rev, next, s) => (failCommit ? Promise.resolve("unavailable") : disk.commit(rev, next, s)),
  };
  const local = createLocalTerminalProofVerifier({ receipt: (p) => receipts.has(JSON.stringify(p)) });
  const fence = new TerminalResourceFence({
    journal,
    now: () => now,
    verifyProof: local,
    onRelease: (id) => release.push(id),
  });
  await fence.initialize(signal);
  const jobs: Promise<unknown>[] = [];
  let receiver = fence;
  const acks: TerminalResolvedAck[] = [];
  fence.onResolved((ack) => acks.push(ack));
  const h = await terminalHarness({
    terminal: {
      ownsCommand: () => false,
      consumeAgentFrame: (meta, raw) => {
        const r = raw as { op: string; ok: boolean; page: TerminalInventoryPage };
        if (r.op === "inventory" && r.ok) jobs.push(receiver.page(meta, r.page, signal));
      },
      retireLink: (meta) => fence.retireLink(meta),
    },
  });
  lives.push(h);
  const meta: TerminalIngressMeta = { agentKey: h.agentKey, linkGen: 1, sessionId: "session", epoch: "epoch-1" };
  function pages(challenge: TerminalChallenge, es = entries, proofEntries = es, senderMeta = meta) {
    es = structuredClone(es);
    proofEntries = structuredClone(proofEntries);
    const scope = {
      hubBootId: challenge.hubBootId,
      challengeId: challenge.challengeId,
      linkGen: challenge.linkGen,
      inventoryId: `inventory-${challenge.challengeId}`,
      revision: 1,
    };
    const proofs: TerminalReapProof[] = proofEntries.map((entry) => ({
      ...scope,
      identity: entry.identity,
      agentProcessIdentity: entry.agentProcessIdentity,
      proofId: `proof-${entry.identity.termId}`,
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: entry.managed,
      outcome: "reaped",
    }));
    for (const p of proofs) receipts.add(JSON.stringify(p));
    const digest = inventoryDigest(es);
    return [
      {
        ...scope,
        phase: "begin",
        sender: {
          agentSessionId: senderMeta.sessionId,
          epoch: senderMeta.epoch,
          ownerInstance: "owner",
          processIdentity: independent && senderMeta !== meta ? entries[1]!.agentProcessIdentity : agentProcessIdentity,
        },
        totalCount: es.length,
        chunkCount: 1,
        digest,
      },
      { ...scope, phase: "chunk", chunkIndex: 0, entries: es, proofs },
      { ...scope, phase: "end", chunkCount: 1, totalCount: es.length, digest, complete: true },
    ] as TerminalInventoryPage[];
  }
  let barrierSeq = 0;
  async function send(ps: TerminalInventoryPage[], client = h.client) {
    // Await each private ingress callback: snapshots apply atomically only at end.
    const results: unknown[] = [];
    for (const page of ps) {
      client.send({
        ...frame(page),
        sessionId: client === h.client ? meta.sessionId : "absent-session",
        epoch: client === h.client ? meta.epoch : "epoch-2",
      });
      const ts = ++barrierSeq;
      client.send({ t: "ping", ts });
      await client.waitFrame((f) => f.t === "pong" && f.ts === ts);
      results.push(...(await Promise.all(jobs.splice(0))));
    }
    return results;
  }
  return {
    dir,
    entries,
    fence,
    acks,
    setReceiver: (f: TerminalResourceFence) => {
      receiver = f;
    },
    meta,
    currentProcess: agentProcessIdentity,
    pages,
    send,
    release,
    signal,
    journal,
    receipts,
    h,
    setTime: (n: number) => {
      now = n;
    },
    getTime: () => now,
    fail: (b: boolean) => {
      failCommit = b;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("F2 Q1–Q4 actual H journal/fence/proof chain (§5.5.1)", () => {
  it("Q1 exact old resource identity and current boot/challenge/link only, release once", async () => {
    const q = await resourceFixture(1);
    try {
      for (const mutation of [
        "boot",
        "challenge",
        "link",
        "session",
        "epoch",
        "owner",
        "reservation",
        "senderOwner",
        "senderProcess",
      ]) {
        const ch = q.fence.begin(q.meta, "owner", q.currentProcess),
          ps = q.pages(ch);
        if (mutation === "boot") for (const p of ps) p.hubBootId = "old-boot";
        if (mutation === "challenge") for (const p of ps) p.challengeId = "old-challenge";
        if (mutation === "link") for (const p of ps) p.linkGen = 2;
        if (mutation === "senderOwner")
          (ps[0] as Extract<TerminalInventoryPage, { phase: "begin" }>).sender.ownerInstance = "wrong";
        if (mutation === "senderProcess")
          (ps[0] as Extract<TerminalInventoryPage, { phase: "begin" }>).sender.processIdentity = {
            ...q.currentProcess,
            starttime: "0",
          };
        const chunk = ps[1] as Extract<TerminalInventoryPage, { phase: "chunk" }>;
        if (["session", "epoch", "owner", "reservation"].includes(mutation)) {
          const k = { session: "agentSessionId", epoch: "epoch", owner: "ownerInstance", reservation: "reservationId" }[
            mutation
          ]!;
          chunk.proofs[0]!.identity = { ...chunk.proofs[0]!.identity, [k]: "wrong" };
        }
        expect((await q.send(ps)).includes("rejected")).toBe(true);
        expect(q.release).toEqual([]);
        expect(q.fence.physicalUsed()).toBe(1);
        expect(() => q.fence.assertOpen()).toThrow("E_RESOURCE_QUARANTINED");
      }
      const good = q.pages(q.fence.begin(q.meta, "owner", q.currentProcess));
      expect(await q.send(good)).toEqual(["accepted", "accepted", "accepted"]);
      expect(q.release).toEqual(["reservation-0"]);
      expect(q.fence.snapshot().state).toBe("cleared");
      expect(await q.send(good)).toEqual(["rejected", "rejected", "rejected"]);
      expect(q.release).toHaveLength(1);
    } finally {
      await q.cleanup();
    }
  }, 20000);
  it("Q2 count/digest/duplicate/missing/out-of-order/expected-set coverage: no partial release", async () => {
    const q = await resourceFixture();
    try {
      for (const mutation of ["count", "digest", "duplicate", "missing", "order", "omission"]) {
        let ps = q.pages(q.fence.begin(q.meta, "owner", q.currentProcess));
        const begin = ps[0] as Extract<TerminalInventoryPage, { phase: "begin" }>,
          chunk = ps[1] as Extract<TerminalInventoryPage, { phase: "chunk" }>,
          end = ps[2] as Extract<TerminalInventoryPage, { phase: "end" }>;
        if (mutation === "count") chunk.entries.pop();
        if (mutation === "digest") {
          begin.digest = "a".repeat(64);
          end.digest = begin.digest;
        }
        if (mutation === "duplicate") chunk.entries[1] = chunk.entries[0]!;
        if (mutation === "missing") ps = [begin, end];
        if (mutation === "order") ps = [begin, end, chunk];
        if (mutation === "omission") {
          chunk.entries.pop();
          chunk.proofs.pop();
          begin.totalCount = 1;
          end.totalCount = 1;
          begin.digest = inventoryDigest(chunk.entries);
          end.digest = begin.digest;
        }
        await q.send(ps);
        expect(q.fence.physicalUsed()).toBe(2);
        expect(q.release).toEqual([]);
        expect(q.fence.snapshot().state).not.toBe("cleared");
      }
      expect(await q.send(q.pages(q.fence.begin(q.meta, "owner", q.currentProcess)))).toEqual([
        "accepted",
        "accepted",
        "accepted",
      ]);
      expect(q.fence.physicalUsed()).toBe(0);
      expect(q.release).toHaveLength(2);
    } finally {
      await q.cleanup();
    }
  }, 20000);
  it("Q3 r4 A fully resolved durably, ONLY B absent: 5/30/60s lost; B fresh proof clears once", async () => {
    const q = await resourceFixture(2, true);
    let bClient: Awaited<ReturnType<typeof connectClient>> | undefined;
    try {
      const a = q.entries[0]!,
        b = q.entries[1]!;
      bClient = await connectClient(join(q.h.tmp.dir, "agent.sock"));
      bClient.send(hello({ agentId: { pid: 4243, nonce: "nonceBBBBBBBBBBBBBBB" }, epoch: "epoch-2" }));
      const ack = await bClient.waitFrame((f) => f.t === "hello_ack");
      bClient.send({
        t: "session",
        sessionId: "absent-session",
        cwd: "/tmp/work",
        reason: "startup",
        leafId: null,
        mode: "tui",
      });
      const bMeta = { ...q.meta, agentKey: String(ack.agentKey), sessionId: "absent-session", epoch: "epoch-2" };
      const ca = q.fence.begin(q.meta, "owner", q.currentProcess),
        cb = q.fence.begin(bMeta, "owner", b.agentProcessIdentity);
      expect(await q.send(q.pages(ca, [a]))).toEqual(["accepted", "accepted", "accepted"]);
      expect(
        q.fence
          .records()
          .resources.find((r) => terminalIdentityKey(r.entry.identity) === terminalIdentityKey(a.identity))?.status,
      ).toBe("resolved");
      const persisted = JSON.parse(await readFile(join(q.dir, "terminal-resource-fence-v1.json"), "utf8"));
      expect(persisted.resources[0].status).toBe("resolved");
      expect(q.release).toEqual([a.identity.reservationId]);
      expect(q.acks).toHaveLength(1);
      expect(q.acks[0]!.identities).toEqual([a.identity]);
      expect(q.fence.snapshot().state).not.toBe("cleared");
      expect(() => q.fence.assertOpen()).toThrow("E_RESOURCE_QUARANTINED");
      for (const at of [6000, 31000, 61000]) {
        q.setTime(at);
        expect(q.fence.snapshot()).toMatchObject({ state: "lost", physicalUsed: 1 });
        expect(() => q.fence.assertOpen()).toThrow("E_RESOURCE_QUARANTINED");
      }
      const old = q.pages(cb, [b], [b], bMeta);
      expect(await q.send(old, bClient)).toEqual(["rejected", "rejected", "rejected"]);
      expect(q.release).toHaveLength(1);
      const fresh = q.fence.begin(bMeta, "owner", b.agentProcessIdentity),
        bps = q.pages(fresh, [b], [b], bMeta);
      expect(await q.send(bps, bClient)).toEqual(["accepted", "accepted", "accepted"]);
      expect(q.fence.snapshot().state).toBe("cleared");
      expect(q.fence.physicalUsed()).toBe(0);
      expect(q.release).toHaveLength(2);
      expect(() => q.fence.assertOpen()).not.toThrow();
      expect(await q.send(bps, bClient)).toEqual(["rejected", "rejected", "rejected"]);
      expect(q.release).toHaveLength(2);
    } finally {
      bClient?.sock.destroy();
      await q.cleanup();
    }
  }, 20000);
  it("Q4 H durable commit failure and concurrent/repeated proof CAS never release early/twice", async () => {
    // Physical PTY + foreground/background pgids + late spawn settlement are P1-A's
    // tests/integration/web-hub-terminal-pty.test.ts gate, not mocked as a PTY here.
    const q = await resourceFixture(1);
    try {
      q.fail(true);
      expect(await q.send(q.pages(q.fence.begin(q.meta, "owner", q.currentProcess)))).toEqual([
        "accepted",
        "accepted",
        "unavailable",
      ]);
      expect(q.release).toEqual([]);
      expect(q.acks).toEqual([]);
      expect(q.fence.physicalUsed()).toBe(1);
      expect(q.fence.snapshot().state).not.toBe("cleared");
      q.fail(false);
      const ps = q.pages(q.fence.begin(q.meta, "owner", q.currentProcess));
      expect(await q.send(ps)).toEqual(["accepted", "accepted", "accepted"]);
      expect(q.release).toHaveLength(1);
      await q.send(ps);
      expect(q.release).toHaveLength(1);
    } finally {
      await q.cleanup();
    }
  }, 20000);
  it("Q4 local proof port requires a completed snapshot, real local receipt and durable CAS", async () => {
    const q = await resourceFixture(1);
    try {
      const ch = q.fence.begin(q.meta, "owner", q.currentProcess),
        ps = q.pages(ch),
        p = (ps[1] as Extract<TerminalInventoryPage, { phase: "chunk" }>).proofs[0]!;
      expect(await q.fence.localProof(p, q.signal)).toBe("rejected");
      const snapshot = q.pages(ch, q.entries, []);
      expect(await q.send(snapshot)).toEqual(["accepted", "accepted", "accepted"]);
      expect(q.fence.physicalUsed()).toBe(1);
      q.receipts.delete(JSON.stringify(p));
      expect(await q.fence.localProof(p, q.signal)).toBe("rejected");
      expect(q.release).toEqual([]);
      q.receipts.add(JSON.stringify(p));
      q.fail(true);
      expect(await q.fence.localProof(p, q.signal)).toBe("unavailable");
      expect(q.release).toEqual([]);
      q.fail(false);
      expect(await q.fence.localProof(p, q.signal)).toBe("accepted");
      expect(q.fence.snapshot().state).toBe("cleared");
      expect(q.release).toHaveLength(1);
      expect(await q.fence.localProof(p, q.signal)).toBe("rejected");
      expect(q.release).toHaveLength(1);
    } finally {
      await q.cleanup();
    }
  }, 20000);
  it("pure-data unresolved handoff unions with resolved disk facts instead of resetting to zero", async () => {
    const q = await resourceFixture(1);
    try {
      expect(await q.send(q.pages(q.fence.begin(q.meta, "owner", q.currentProcess)))).toEqual([
        "accepted",
        "accepted",
        "accepted",
      ]);
      expect(q.fence.physicalUsed()).toBe(0);
      const f = new TerminalResourceFence({
        journal: createTerminalResourceJournal({ stateDir: q.dir, now: q.getTime }),
        now: q.getTime,
        verifyProof: createLocalTerminalProofVerifier({ receipt: (p) => q.receipts.has(JSON.stringify(p)) }),
      });
      await f.initialize(q.signal, [q.entries[0]!]);
      expect(f.physicalUsed()).toBe(1);
      expect(f.snapshot().state).not.toBe("cleared");
      expect(() => f.assertOpen()).toThrow("E_RESOURCE_QUARANTINED");
      expect(f.records().resources[0]?.status).toBe("unresolved");
      expect(f.records().resources[0]?.proof).toBeDefined(); // historical evidence is not a fresh challenge authority
    } finally {
      await q.cleanup();
    }
  }, 20000);
  it("Q1 real same-agent reconnect increments link; old challenge cannot release new ingress", async () => {
    const q = await resourceFixture(1);
    let c: Awaited<ReturnType<typeof connectClient>> | undefined;
    try {
      const old = q.pages(q.fence.begin(q.meta, "owner", q.currentProcess));
      q.h.client.sock.destroy();
      await q.h.client.closed;
      c = await connectClient(join(q.h.tmp.dir, "agent.sock"));
      c.send(hello({ epoch: "epoch-2" }));
      const ack = await c.waitFrame((f) => f.t === "hello_ack");
      expect(ack.agentKey).toBe(q.h.agentKey);
      c.send({
        t: "session",
        sessionId: "absent-session",
        cwd: "/tmp/work",
        reason: "resume",
        leafId: null,
        mode: "tui",
      });
      const meta = { agentKey: q.h.agentKey, linkGen: 2, sessionId: "absent-session", epoch: "epoch-2" };
      expect(await q.send(old, c)).toEqual(["rejected", "rejected", "rejected"]);
      expect(q.fence.physicalUsed()).toBe(1);
      const pages = q.pages(q.fence.begin(meta, "owner", q.currentProcess), q.entries, q.entries, meta);
      expect(await q.send(pages, c)).toEqual(["accepted", "accepted", "accepted"]);
      expect(q.release).toHaveLength(1);
    } finally {
      c?.sock.destroy();
      await q.cleanup();
    }
  }, 20000);
  it("Q4 concurrent local physical proofs contend on the real durable resolved CAS", async () => {
    const q = await resourceFixture(1);
    try {
      const ch = q.fence.begin(q.meta, "owner", q.currentProcess),
        p = (q.pages(ch)[1] as Extract<TerminalInventoryPage, { phase: "chunk" }>).proofs[0]!;
      expect(await q.send(q.pages(ch, q.entries, []))).toEqual(["accepted", "accepted", "accepted"]);
      const results = await Promise.all([q.fence.localProof(p, q.signal), q.fence.localProof(p, q.signal)]);
      expect(results.filter((r) => r === "accepted")).toHaveLength(1);
      expect(q.release).toHaveLength(1);
      expect(q.fence.physicalUsed()).toBe(0);
      const persisted = JSON.parse(await readFile(join(q.dir, "terminal-resource-fence-v1.json"), "utf8"));
      expect(persisted.resources[0].status).toBe("resolved");
    } finally {
      await q.cleanup();
    }
  }, 20000);
  it("resolved rename/fsync completion crosses deadline: no release/ACK, cold resolved rows re-quarantine until fresh proof", async () => {
    const q = await resourceFixture(1);
    const handle = await open(join(q.dir, "terminal-resource-fence-v1.json"), "r"),
      proto = Object.getPrototypeOf(handle);
    await handle.close();
    const original = proto.sync;
    let paused = false,
      resume!: () => void;
    const spy = vi.spyOn(proto, "sync").mockImplementation(async function (this: { fd: number }) {
      await original.call(this);
      if (!paused && (await readlink(`/proc/self/fd/${this.fd}`)) === q.dir) {
        paused = true;
        await new Promise<void>((r) => (resume = r));
      }
    });
    try {
      const pending = q.send(q.pages(q.fence.begin(q.meta, "owner", q.currentProcess)));
      await waitFor(() => paused);
      expect(
        JSON.parse(await readFile(join(q.dir, "terminal-resource-fence-v1.json"), "utf8")).resources[0].status,
      ).toBe("resolved");
      q.setTime(q.getTime() + 6000);
      resume();
      expect((await pending).at(-1)).toBe("unavailable");
      expect(q.release).toEqual([]);
      expect(q.acks).toEqual([]);
      expect(q.fence.snapshot().state).not.toBe("cleared");
      expect(q.fence.physicalUsed()).toBe(1);
      spy.mockRestore();
      const released: string[] = [],
        acks: TerminalResolvedAck[] = [];
      const restarted = new TerminalResourceFence({
        journal: createTerminalResourceJournal({ stateDir: q.dir, now: q.getTime }),
        now: q.getTime,
        verifyProof: createLocalTerminalProofVerifier({ receipt: (p) => q.receipts.has(JSON.stringify(p)) }),
        onRelease: (id) => released.push(id),
      });
      restarted.onResolved((ack) => acks.push(ack));
      await restarted.initialize(q.signal);
      q.setReceiver(restarted);
      expect(restarted.snapshot()).toMatchObject({ state: "collecting", physicalUsed: 1 });
      expect(() => restarted.assertOpen()).toThrow("E_RESOURCE_QUARANTINED");
      const expired = restarted.begin(q.meta, "owner", q.currentProcess);
      const old = q.pages(expired);
      for (const delta of [5000, 30000, 60000]) {
        q.setTime(q.getTime() + delta);
        expect(restarted.snapshot()).toMatchObject({ state: "lost", physicalUsed: 1 });
        expect(released).toEqual([]);
        expect(acks).toEqual([]);
      }
      expect(await q.send(old)).toEqual(["rejected", "rejected", "rejected"]);
      const current = restarted.begin(q.meta, "owner", q.currentProcess),
        pages = q.pages(current);
      expect(await q.send(pages)).toEqual(["accepted", "accepted", "accepted"]);
      expect(restarted.snapshot().state).toBe("cleared");
      expect(released).toHaveLength(1);
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        hubBootId: restarted.bootId,
        challengeId: current.challengeId,
        linkGen: current.linkGen,
        journalRevision: restarted.records().revision,
        identities: [q.entries[0]!.identity],
      });
    } finally {
      spy.mockRestore();
      resume?.();
      await q.cleanup();
    }
  }, 20000);
});
