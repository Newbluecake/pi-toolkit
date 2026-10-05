import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentFrame, HubFrame, WireEntry } from "../../../src/web-hub/protocol/messages.js";
import { RUN_TX } from "../../../src/web-hub/protocol/run-transcript.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import type { HubEvent, RunSink, RunTranscriptService } from "../../../src/web-hub/hub/ports.js";
import { HubError, createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { createRunTranscriptService } from "../../../src/web-hub/hub/run-transcript.js";
import { createRunFileReader } from "../../../src/web-hub/hub/run-file-reader.js";
import { formatSseFrame } from "../../../src/web-hub/hub/sse.js";
import { fakeConn, hello, memLog, recordBus, tmpDirs, waitFor, type FakeConn, type Hello } from "./helpers.js";

/**
 * fleet-drawer plan §9 F3b acceptance: watch refcount/ordering, file-source leaf walk,
 * payload hygiene (sessionFile/finalLeafId never survive), the §3.3 hub state table row by
 * row, the RunEndLedger (dedupe + TTL), the three bus reactions (agent_down / epoch change /
 * caps change), and the L-matrix's service-layer cap gating half. The HTTP/RunSub generation
 * half of the matrix is F4's (`tests/web-hub/http/api-run.test.ts`).
 */

const tmp = tmpDirs();
afterEach(() => tmp.cleanup());

const RUN = "r_ABCDEFGH";
const RUN2 = "r_JKLMNPQR";
const TAP = "tapAAAAAAAAAAAA";
const TAP2 = "tapBBBBBBBBBBBB";

const ev = (seq: number, over: Partial<Extract<AgentFrame, { t: "run_ev" }>> = {}): AgentFrame => ({
  t: "run_ev",
  runId: RUN,
  tapId: TAP,
  seq,
  e: { type: "turn_start" },
  ...over,
});

// ---------------------------------------------------------------------------
// jsonl fixtures (same builders as run-file-reader.test.ts, trimmed)
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const line = (o: object): string => `${JSON.stringify(o)}\n`;
const iso = (n: number): string => new Date(1_790_000_000_000 + n * 1000).toISOString();

const msgEntry = (id: string, parentId: string | null, n: number): Raw => ({
  type: "message",
  id,
  parentId,
  timestamp: iso(n),
  message: { role: n % 2 === 0 ? "user" : "assistant", content: `text-${id}` },
});

/** Linear parent chain `${prefix}0 .. ${prefix}${count-1}` (root first). */
function chainRaw(prefix: string, count: number, opts?: { parent?: string | null }): Raw[] {
  const out: Raw[] = [];
  let p: string | null = opts?.parent ?? null;
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}`;
    out.push(msgEntry(id, p, i + 1));
    p = id;
  }
  return out;
}

/** In-memory truth, mirroring `walkBranch`: walk parentId from the leaf, oldest-first, projected. */
function walkExpected(raws: Raw[], leafId: string): WireEntry[] {
  const byId = new Map<string, Raw>();
  for (const r of raws) if (typeof r["id"] === "string") byId.set(r["id"], r);
  const chain: Raw[] = [];
  let cur: string | null = leafId;
  while (cur !== null) {
    const r = byId.get(cur);
    if (r === undefined) break;
    chain.push(r);
    const p: unknown = r["parentId"];
    cur = typeof p === "string" ? p : null;
  }
  chain.reverse();
  return chain.flatMap((r) => {
    const e = projectSessionEntry(r);
    return e === undefined ? [] : [e];
  });
}

function writeJsonl(name: string, content: string): string {
  const file = join(tmp.make("wh-runtx-"), name);
  writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type ReqFrame = Extract<HubFrame, { t: "run_tx_req" }>;
type ReplyBuilder = (req: ReqFrame) => AgentFrame;

const liveReply =
  (over: Partial<Extract<AgentFrame, { t: "run_tx_reply"; ok: true; source: "live" }>> = {}): ReplyBuilder =>
  (req) => ({
    t: "run_tx_reply",
    rid: req.rid,
    runId: req.runId,
    ok: true,
    source: "live",
    status: "running",
    tapId: TAP,
    seq: 0,
    watching: true,
    entries: [],
    truncated: false,
    hasMore: false,
    ...over,
  });

const fileReply =
  (sessionFile: string, finalLeafId: string, status = "completed"): ReplyBuilder =>
  (req) => ({
    t: "run_tx_reply",
    rid: req.rid,
    runId: req.runId,
    ok: true,
    source: "file",
    status,
    sessionFile,
    finalLeafId,
  });

const errReply =
  (code: "E_NOT_FOUND" | "E_UNSUPPORTED", reason: string): ReplyBuilder =>
  (req) => ({
    t: "run_tx_reply",
    rid: req.rid,
    runId: req.runId,
    ok: false,
    code,
    reason,
  });

interface SinkRec {
  evs: Array<{ agentKey: string; runId: string; seq: number }>;
  ends: Array<{ agentKey: string; runId: string; lastSeq: number }>;
  resyncStarts: string[];
  histories: Array<{ agentKey: string; runId: string; payload: unknown }>;
  dropped: Array<{ agentKey: string; runId: string; err: { error: string; reason?: string }; refs?: string[] }>;
  sink: RunSink;
}

function recordSink(): SinkRec {
  const rec: SinkRec = {
    evs: [],
    ends: [],
    resyncStarts: [],
    histories: [],
    dropped: [],
    sink: {
      ev: (agentKey, runId, p) => rec.evs.push({ agentKey, runId, seq: p.seq }),
      end: (agentKey, runId, p) => rec.ends.push({ agentKey, runId, lastSeq: p.lastSeq }),
      resyncStart: (agentKey, runId) => rec.resyncStarts.push(`${agentKey}|${runId}`),
      history: (agentKey, runId, payload) => rec.histories.push({ agentKey, runId, payload }),
      dropped: (agentKey, runId, err, refs) =>
        rec.dropped.push({
          agentKey,
          runId,
          err: { error: err.error, ...(err.reason === undefined ? {} : { reason: err.reason }) },
          refs,
        }),
    },
  };
  return rec;
}

interface Ctx {
  reg: Registry;
  events: HubEvent[];
  conn: FakeConn;
  /** Scripted run_tx_req replies (shifted per request); the default answers a live snapshot. */
  replies: ReplyBuilder[];
  reqs: ReqFrame[];
  svc: RunTranscriptService;
  sink: SinkRec;
  clock: { t: number };
  agentKey: string;
  /** P1-2 harness: when on, run_tx_req frames are HELD instead of auto-answered; answer them
   * via `answerHeld` so a resync round can be kept in-flight across a later bus event. */
  hold: { on: boolean };
  answerHeld(frame: (req: ReqFrame) => AgentFrame): void;
  /** Re-hello with different caps (same epoch unless overridden). */
  rehello(over: Partial<Hello>): void;
}

function ctx(opts?: {
  caps?: string[];
  /** P2-1 harness: reader construction seams (scanChunkBytes/maxScanBytes) + a custom clock. */
  readerOpts?: { scanChunkBytes?: number; maxScanBytes?: number; now?: () => number };
  /** Overrides the service's clock (defaults to reading `clock.t`). */
  now?: () => number;
}): Ctx {
  const clock = { t: 1_000_000 };
  const reg = createRegistry({ now: () => clock.t, log: memLog(), pidAlive: () => true });
  const base = fakeConn();
  const replies: ReplyBuilder[] = []; // empty: the send hook falls back to a live reply
  const reqs: ReqFrame[] = [];
  const held: ReqFrame[] = [];
  const hold = { on: false };
  const conn: FakeConn = {
    ...base,
    send: (f: HubFrame) => {
      base.sent.push(f);
      if (f.t === "run_tx_req") {
        reqs.push(f);
        if (hold.on) {
          held.push(f);
          return;
        }
        const next = replies.shift() ?? liveReply();
        reg.onFrame(agentKeyHolder.key!, next(f));
      }
    },
    close: base.close,
    closedWith: base.closedWith,
  };
  const agentKeyHolder: { key: string | undefined } = { key: undefined };
  const { agentKey } = reg.register(hello({ caps: opts?.caps ?? ["ev.v1", "runtx.v1", "runtx.lan.v1"] }), conn);
  agentKeyHolder.key = agentKey;
  const svc = createRunTranscriptService({
    registry: reg,
    reader: createRunFileReader({
      now: opts?.readerOpts?.now ?? (() => clock.t),
      ...(opts?.readerOpts?.scanChunkBytes === undefined ? {} : { scanChunkBytes: opts.readerOpts.scanChunkBytes }),
      ...(opts?.readerOpts?.maxScanBytes === undefined ? {} : { maxScanBytes: opts.readerOpts.maxScanBytes }),
    }),
    log: memLog(),
    now: opts?.now ?? (() => clock.t),
  });
  const sink = recordSink();
  svc.setSink(sink.sink);
  return {
    reg,
    events: recordBus(reg),
    conn,
    replies,
    reqs,
    svc,
    sink,
    clock,
    agentKey,
    hold,
    answerHeld: (frame) => {
      const req = held.shift();
      if (req === undefined) throw new Error("no held run_tx_req");
      hold.on = false;
      reg.onFrame(agentKey, frame(req));
    },
    rehello: (over: Partial<Hello>) => {
      reg.register(hello({ caps: opts?.caps ?? ["ev.v1", "runtx.v1", "runtx.lan.v1"], ...over }), conn);
    },
  };
}

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
};

const watchFrames = (c: Ctx): Array<{ runId: string; on: boolean }> =>
  c.conn.sent
    .filter((f): f is Extract<HubFrame, { t: "run_watch" }> => f.t === "run_watch")
    .map((f) => ({ runId: f.runId, on: f.on }));

const expectUnsupported = async (p: Promise<unknown>): Promise<void> => {
  await expect(p).rejects.toMatchObject({ code: "E_UNSUPPORTED", message: "unsupported" });
};

// ---------------------------------------------------------------------------

describe("watch refcount & ordering (§5.2)", () => {
  it("0→1 sends run_watch{on:true} exactly once; 1→0 sends {on:false} once; duplicate refs never double-count", () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.svc.watch(c.agentKey, RUN, "loopback:c1"); // duplicate ref
    c.svc.watch(c.agentKey, RUN, "loopback:c2"); // second client
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]);
    c.svc.unwatch(c.agentKey, RUN, "loopback:c1");
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]); // still one ref left
    c.svc.unwatch(c.agentKey, RUN, "loopback:c2");
    expect(watchFrames(c)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN, on: false },
    ]);
    // re-watch after full drop re-arms
    c.svc.watch(c.agentKey, RUN, "lan:c3");
    expect(watchFrames(c)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN, on: false },
      { runId: RUN, on: true },
    ]);
  });

  it("unwatch for an unknown run/ref is a no-op", () => {
    const c = ctx();
    expect(() => c.svc.unwatch(c.agentKey, RUN, "loopback:nobody")).not.toThrow();
    expect(watchFrames(c)).toEqual([]);
  });

  it("run_watch precedes run_tx_req on the same socket (§5.2 snapshot ordering)", async () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    const kinds = c.conn.sent.map((f) => f.t);
    const wi = kinds.indexOf("run_watch");
    const ri = kinds.indexOf("run_tx_req");
    expect(wi).toBeGreaterThanOrEqual(0);
    expect(ri).toBeGreaterThanOrEqual(0);
    expect(wi).toBeLessThan(ri);
  });

  it("RunEndLedger hit ⇒ watch does not arm a tap (§5.2 ledger use #2)", async () => {
    const c = ctx();
    // A terminal record lands in the ledger (no watch held: stray end frames only seed it).
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 5, status: "completed" });
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    expect(watchFrames(c)).toEqual([]); // terminal: no tap
    // The snapshot still works and takes the (scripted) file path.
    c.replies.push(fileReply("/nonexistent.jsonl", "leafX"));
    await expect(c.svc.snapshot(c.agentKey, RUN, "loopback")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
      message: "file_missing",
    });
  });

  it("after the ledger TTL expires, watch arms the tap again", () => {
    const c = ctx();
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 5, status: "completed" });
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    expect(watchFrames(c)).toEqual([]);
    c.svc.unwatch(c.agentKey, RUN, "loopback:c1");
    c.clock.t += RUN_TX.endLedgerTtlMs + 1;
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]);
  });
});

describe("snapshot / page payloads (§5.2 reply branches)", () => {
  const e0: WireEntry = { id: "m0", parentId: null, type: "message", timestamp: iso(1) };

  it("live reply assembles the payload; watermark is applied to the watch", async () => {
    const c = ctx();
    c.replies.push(liveReply({ seq: 4, entries: [e0], watching: true, hasMore: false, inflight: { tools: [] } }));
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    const p = await c.svc.snapshot(c.agentKey, RUN, "loopback");
    expect(p).toMatchObject({
      agentKey: c.agentKey,
      runId: RUN,
      entries: [e0],
      fromSeq: 5,
      hasMore: false,
      source: "live",
      terminal: false,
      live: true,
      status: "running",
      tapId: TAP,
      oldestEntryId: "m0",
      inflight: { tools: [] },
    });
    expect(p.tailMessages).toEqual([]);
    expect(JSON.parse(JSON.stringify(p))).not.toHaveProperty("sessionFile");
    // watermark applied: a duplicate seq-4 ev is dropped, seq 5 fans out
    c.svc.onFrame(c.agentKey, ev(4));
    c.svc.onFrame(c.agentKey, ev(5));
    expect(c.sink.evs.map((x) => x.seq)).toEqual([5]);
  });

  it("watching:false ⇒ live:false (degraded footer signal, §2 table)", async () => {
    const c = ctx();
    c.replies.push(liveReply({ watching: false, tapId: undefined, seq: 0 }));
    const p = await c.svc.snapshot(c.agentKey, RUN, "loopback");
    expect(p.live).toBe(false);
    expect(p.tapId).toBeUndefined();
  });

  it("file reply walks finalLeafId; a dead-branch tail never leaks in (T2); payload strips sessionFile/finalLeafId", async () => {
    const c = ctx();
    // m0→m1→m2→m3 is the live branch; d1→d2 is a discarded branch appended AFTER the leaf —
    // the file's physical last line belongs to it, so "take the last line" would be wrong.
    const raws = [...chainRaw("m", 4), ...chainRaw("d", 2, { parent: "m1" })];
    const file = writeJsonl("t2.jsonl", raws.map(line).join(""));
    c.replies.push(fileReply(file, "m3", "completed"));
    const p = await c.svc.snapshot(c.agentKey, RUN, "loopback");
    expect(p.source).toBe("file");
    expect(p.terminal).toBe(true);
    expect(p.live).toBe(false);
    expect(p.fromSeq).toBe(0);
    expect(p.status).toBe("completed");
    expect(p.entries).toEqual(walkExpected(raws, "m3"));
    const json = JSON.stringify(p);
    expect(json).not.toContain(file);
    expect(json).not.toContain("sessionFile");
    expect(json).not.toContain("finalLeafId");
  });

  it("file reply: leaf not in the file ⇒ leaf_missing; missing file ⇒ file_missing", async () => {
    const c = ctx();
    const file = writeJsonl("t-missing-leaf.jsonl", chainRaw("m", 2).map(line).join(""));
    c.replies.push(fileReply(file, "zzz"));
    await expect(c.svc.snapshot(c.agentKey, RUN, "loopback")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
      message: "leaf_missing",
    });
    c.replies.push(fileReply("/nonexistent/x.jsonl", "m1"));
    await expect(c.svc.snapshot(c.agentKey, RUN, "loopback")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
      message: "file_missing",
    });
  });

  it("page: live branch is served by the agent; `live` is forced false (§3.4); before is passed through", async () => {
    const c = ctx();
    const e1: WireEntry = { id: "p1", parentId: "m0", type: "message", timestamp: iso(2) };
    c.replies.push(liveReply({ seq: 9, entries: [e1] }));
    const p = await c.svc.page(c.agentKey, RUN, "m0", 50, "loopback");
    expect(c.reqs.at(-1)).toMatchObject({ t: "run_tx_req", runId: RUN, before: "m0", limit: 50 });
    expect(p).toMatchObject({ entries: [e1], fromSeq: 10, live: false, terminal: false, source: "live" });
  });

  it("page: file branch pages backwards through the reader", async () => {
    const c = ctx();
    const raws = chainRaw("m", 6);
    const file = writeJsonl("page.jsonl", raws.map(line).join(""));
    c.replies.push(fileReply(file, "m5"));
    const p = await c.svc.page(c.agentKey, RUN, "m3", 2, "loopback");
    expect(p.entries).toEqual(walkExpected(raws, "m3").slice(1, 3)); // m1, m2 — the 2 entries older than m3
    expect(p.terminal).toBe(true);
  });

  it("page limit is clamped into 1..pageMax; garbage becomes pageMax", async () => {
    const c = ctx();
    await c.svc.page(c.agentKey, RUN, "m0", 9999, "loopback");
    expect(c.reqs.at(-1)?.limit).toBe(RUN_TX.pageMax);
    await c.svc.page(c.agentKey, RUN, "m0", 0, "loopback");
    expect(c.reqs.at(-1)?.limit).toBe(1);
    await c.svc.page(c.agentKey, RUN, "m0", Number.NaN, "loopback");
    expect(c.reqs.at(-1)?.limit).toBe(RUN_TX.pageMax);
  });

  it("ok:false reply maps 1:1 onto HubError (code, reason)", async () => {
    const c = ctx();
    c.replies.push(errReply("E_NOT_FOUND", "unknown_run"));
    const p1 = c.svc.snapshot(c.agentKey, RUN, "loopback");
    await expect(p1).rejects.toBeInstanceOf(HubError);
    await expect(p1).rejects.toMatchObject({ code: "E_NOT_FOUND", message: "unknown_run" });
    c.replies.push(errReply("E_NOT_FOUND", "not_persisted"));
    const p2 = c.svc.snapshot(c.agentKey, RUN, "loopback");
    await expect(p2).rejects.toMatchObject({ code: "E_NOT_FOUND", message: "not_persisted" });
  });
});

describe("capability gating — L1–L8 service half (§5.2 requireCap / §7.1)", () => {
  it("loopback-mode agent (runtx.v1 only): loopback works, LAN is refused on all three entry points", async () => {
    const c = ctx({ caps: ["ev.v1", "runtx.v1"] });
    await expect(c.svc.snapshot(c.agentKey, RUN, "loopback")).resolves.toBeTruthy();
    await expectUnsupported(c.svc.snapshot(c.agentKey, RUN, "lan"));
    await expectUnsupported(c.svc.page(c.agentKey, RUN, "x", 10, "lan"));
    expect(() => c.svc.watch(c.agentKey, RUN, "lan:c1")).toThrowError(HubError);
    expect(() => c.svc.watch(c.agentKey, RUN, "lan:c1")).toThrowError(
      expect.objectContaining({ code: "E_UNSUPPORTED", message: "unsupported" }),
    );
    expect(watchFrames(c)).toEqual([]); // the refused watch never armed a tap
  });

  it("all-mode agent (runtx.v1 + runtx.lan.v1): both listeners pass (L1/L2)", async () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "lan:c1");
    await expect(c.svc.snapshot(c.agentKey, RUN, "lan")).resolves.toBeTruthy();
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]);
  });

  it("old agent (no runtx.* caps): every entry point is E_UNSUPPORTED on BOTH listeners; card is false (hard acceptance: new hub + old agent)", async () => {
    const c = ctx({ caps: ["ev.v1", "cmd.v1", "upload.v1"] });
    const card = c.reg.get(c.agentKey)!;
    expect(card.runTranscript).toBe(false);
    expect(card.runTranscriptLan).toBe(false);
    for (const listener of ["loopback", "lan"] as const) {
      await expectUnsupported(c.svc.snapshot(c.agentKey, RUN, listener));
      await expectUnsupported(c.svc.page(c.agentKey, RUN, "x", 10, listener));
      expect(() => c.svc.watch(c.agentKey, RUN, `${listener}:c1`)).toThrowError(
        expect.objectContaining({ code: "E_UNSUPPORTED" }),
      );
    }
    expect(watchFrames(c)).toEqual([]);
    expect(c.reqs).toEqual([]); // never even asked the agent
  });

  it("off-mode agent and an unknown agentKey: no caps / E_NOT_FOUND", async () => {
    const c = ctx({ caps: ["ev.v1"] });
    await expectUnsupported(c.svc.snapshot(c.agentKey, RUN, "loopback"));
    await expect(c.svc.snapshot("a0000-unknown", RUN, "loopback")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    expect(() => c.svc.watch("a0000-unknown", RUN, "loopback:c1")).toThrowError(HubError);
  });

  it("a malformed ref (no listener prefix) is refused, never counted", () => {
    const c = ctx();
    expect(() => c.svc.watch(c.agentKey, RUN, "garbage")).toThrowError(HubError);
    expect(watchFrames(c)).toEqual([]);
  });
});

describe("§3.3 hub state table (per RunWatch)", () => {
  async function armed(c: Ctx, seq = 0): Promise<void> {
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.replies.push(liveReply({ seq }));
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.sink.histories.length = 0;
    c.sink.resyncStarts.length = 0;
    c.reqs.length = 0;
  }

  it("seq === lastSeq+1 fans out; duplicates are dropped; a hole triggers resync and is NOT forwarded", async () => {
    const c = ctx();
    await armed(c, 2);
    c.svc.onFrame(c.agentKey, ev(3));
    c.svc.onFrame(c.agentKey, ev(3)); // duplicate
    c.svc.onFrame(c.agentKey, ev(5)); // hole (4 missing)
    expect(c.sink.evs.map((x) => x.seq)).toEqual([3]);
    await flush();
    expect(c.sink.resyncStarts).toEqual([`${c.agentKey}|${RUN}`]);
    expect(c.sink.evs.map((x) => x.seq)).toEqual([3]); // the hole frame never reached the sink
    expect(c.reqs.length).toBe(1); // the resync round's run_tx_req
  });

  it("a settled resync delivers run_history{resync:true} and re-establishes continuity", async () => {
    const c = ctx();
    await armed(c, 2);
    c.replies.push(liveReply({ seq: 4 })); // the round's snapshot watermark
    c.svc.onFrame(c.agentKey, ev(5)); // hole ⇒ resync
    await flush();
    expect(c.sink.histories).toHaveLength(1);
    const h = c.sink.histories[0]!.payload as { resync?: boolean; fromSeq: number; source: string };
    expect(h.resync).toBe(true);
    expect(h.fromSeq).toBe(5);
    expect(h.source).toBe("live");
    c.svc.onFrame(c.agentKey, ev(5)); // watermark 4 ⇒ contiguous next is 5
    expect(c.sink.evs.map((x) => x.seq)).toEqual([5]);
  });

  it("a post-snapshot event that lands during the window does not fire a spurious second round (max-watermark rule)", async () => {
    const c = ctx();
    await armed(c, 2);
    c.replies.push(liveReply({ seq: 4 })); // the round's snapshot sees watermark 4
    c.svc.onFrame(c.agentKey, ev(5)); // hole ⇒ round starts
    // events 5..7 were generated AFTER the agent took the snapshot but land during the window
    c.svc.onFrame(c.agentKey, ev(6));
    c.svc.onFrame(c.agentKey, ev(7));
    await flush();
    expect(c.sink.resyncStarts).toHaveLength(1); // no phantom hole: lastSeq tracked to 7
    expect(c.sink.histories).toHaveLength(1);
    c.svc.onFrame(c.agentKey, ev(8)); // 8 === tracked 7 + 1 ⇒ still contiguous, no round
    expect(c.sink.evs.map((x) => x.seq)).toEqual([6, 7, 8]); // 5 was the hole trigger — never forwarded
    expect(c.sink.resyncStarts).toHaveLength(1);
  });

  it("tapId mismatch triggers resync", async () => {
    const c = ctx();
    await armed(c, 2);
    c.svc.onFrame(c.agentKey, ev(3, { tapId: TAP2 }));
    expect(c.sink.evs).toEqual([]);
    expect(c.sink.resyncStarts).toEqual([`${c.agentKey}|${RUN}`]);
  });

  it("during an in-flight round, events pass through unchecked and gaps coalesce by watermark", async () => {
    const c = ctx();
    await armed(c, 2);
    c.replies.push(liveReply({ seq: 7 }));
    c.svc.onFrame(c.agentKey, ev(5)); // hole ⇒ round starts
    expect(c.sink.resyncStarts).toHaveLength(1);
    c.svc.onFrame(c.agentKey, ev(9)); // in-flight: forwarded despite the hole
    c.svc.onFrame(c.agentKey, ev(3)); // in-flight duplicate window: still forwarded (buffered)
    expect(c.sink.evs.map((x) => x.seq)).toEqual([5, 9, 3].filter((s) => s !== 5)); // 5 was the hole trigger — never forwarded
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 6 }); // covered by watermark 7
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 99 }); // NOT covered
    await flush();
    expect(c.sink.resyncStarts).toHaveLength(2); // gap{99} ⇒ one more round
    expect(c.sink.histories).toHaveLength(2);
  });

  it("run_end aligned (contiguous, tapId, lastSeq) fans out once; the agent's retry duplicate is ledger-dropped", async () => {
    const c = ctx();
    await armed(c, 4);
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 4, status: "completed" });
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 4, status: "completed" }); // retry
    expect(c.sink.ends).toEqual([{ agentKey: c.agentKey, runId: RUN, lastSeq: 4 }]);
    expect(c.sink.resyncStarts).toEqual([]);
  });

  it("a DIFFERENT (tapId,lastSeq) end is new information, not a duplicate", async () => {
    const c = ctx();
    await armed(c, 4);
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 4, status: "completed" });
    c.replies.push(fileReply("/nonexistent.jsonl", "m1"));
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 9, status: "failed" }); // hole 5..9 ⇒ resync
    expect(c.sink.ends).toEqual([{ agentKey: c.agentKey, runId: RUN, lastSeq: 4 }]);
    await waitFor(() => c.sink.histories.length >= 1);
    // S4: the broken-chain end is never forwarded; the resync round settles as an error
    // payload (the scripted file is missing) — still exactly one history, one forwarded end.
    expect(c.sink.histories).toHaveLength(1);
    expect(c.sink.histories[0]!.payload).toMatchObject({ error: "E_NOT_FOUND", reason: "file_missing" });
    expect(c.sink.ends).toHaveLength(1);
  });

  it("run_end arriving mid-round is recorded and settles via the round's terminal snapshot (no live race loss)", async () => {
    const c = ctx();
    await armed(c, 2);
    const file = writeJsonl("midround.jsonl", chainRaw("m", 3).map(line).join(""));
    c.replies.push(fileReply(file, "m2"));
    c.svc.onFrame(c.agentKey, ev(5)); // hole ⇒ round starts
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 5, status: "completed" });
    expect(c.sink.ends).toEqual([]); // never forwarded directly mid-round
    await waitFor(() => c.sink.histories.length >= 1);
    // The terminal settle is authoritative: it clears the mid-round `again`, so exactly ONE
    // round ran and the subscribers hold the final file-backed state.
    expect(c.sink.histories).toHaveLength(1);
    const h = c.sink.histories[0]!.payload as { resync?: boolean; terminal: boolean; source: string };
    expect(h.resync).toBe(true);
    expect(h.terminal).toBe(true);
    expect(h.source).toBe("file");
    expect(c.sink.resyncStarts).toHaveLength(1);
  });

  it("resync storm: a 4th round within 10s ⇒ E_BUSY/resync_storm, watch deleted, tap turned off", async () => {
    const c = ctx();
    await armed(c, 0);
    for (let i = 0; i < 3; i++) {
      c.svc.onFrame(c.agentKey, ev(2)); // always a hole against watermark 0
      await flush();
    }
    expect(c.sink.resyncStarts).toHaveLength(3);
    expect(c.sink.dropped).toEqual([]);
    c.svc.onFrame(c.agentKey, ev(2)); // 4th start attempt inside the window
    expect(c.sink.dropped).toEqual([
      { agentKey: c.agentKey, runId: RUN, err: { error: "E_BUSY", reason: "resync_storm" }, refs: undefined },
    ]);
    expect(watchFrames(c).at(-1)).toEqual({ runId: RUN, on: false });
    // the watch is gone: further events are ignored
    c.svc.onFrame(c.agentKey, ev(3));
    expect(c.sink.evs).toEqual([]);
  });

  it("the storm window slides (10s): rounds spaced past the window do not trip the breaker", async () => {
    const c = ctx();
    await armed(c, 0);
    for (let i = 0; i < 4; i++) {
      c.svc.onFrame(c.agentKey, ev(2));
      await flush();
      c.clock.t += 10_001; // each round ages out of the window
    }
    expect(c.sink.dropped).toEqual([]);
    expect(c.sink.resyncStarts).toHaveLength(4);
  });
});

describe("bus reactions (§5.2)", () => {
  it("agent_down ⇒ every held subscription gets E_AGENT_GONE; state cleared; later frames are inert", async () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.svc.watch(c.agentKey, RUN2, "lan:c2");
    c.reg.onFrame(c.agentKey, { t: "bye", reason: "quit" });
    c.reg.onClose(c.agentKey, true);
    const errs = c.sink.dropped.map((d) => [d.runId, d.err.error]);
    expect(errs).toEqual([
      [RUN, "E_AGENT_GONE"],
      [RUN2, "E_AGENT_GONE"],
    ]);
    // no run_watch{on:false} to a dead agent, and no further sink traffic
    expect(watchFrames(c)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN2, on: true },
    ]);
    c.svc.onFrame(c.agentKey, ev(1));
    expect(c.sink.evs).toEqual([]);
    expect(() => c.svc.onFrame(c.agentKey, ev(1))).not.toThrow();
  });

  it("epoch change (gap{fromSeq:0}) ⇒ re-arm run_watch{on:true} then resync every watch", async () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]);
    c.replies.push(liveReply({ seq: 3 }));
    c.rehello({ epoch: "epoch-2" }); // /reload: taps died, epoch bumped
    // re-armed BEFORE the round's request — the SAME on:true is idempotently re-sent
    expect(watchFrames(c)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN, on: true },
    ]);
    const onIdx = c.conn.sent.map((f) => f.t).lastIndexOf("run_watch");
    const reqIdx = c.conn.sent.map((f) => f.t).lastIndexOf("run_tx_req");
    expect(onIdx).toBeGreaterThanOrEqual(0);
    expect(reqIdx).toBeGreaterThan(onIdx);
    await flush();
    expect(c.sink.resyncStarts).toEqual([`${c.agentKey}|${RUN}`]);
    expect(c.sink.histories).toHaveLength(1);
  });

  it("a session frame's FIRST arrival never resyncs; a sessionId CHANGE resyncs", async () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    const session = (sessionId: string): void => {
      c.reg.onFrame(c.agentKey, {
        t: "session",
        sessionId,
        sessionFile: `/tmp/${sessionId}.jsonl`,
        cwd: "/tmp/work",
        reason: "startup",
        leafId: null,
        mode: "tui",
      });
    };
    session("s1");
    expect(c.sink.resyncStarts).toEqual([]);
    c.replies.push(liveReply({ seq: 1 }));
    session("s2");
    expect(c.sink.resyncStarts).toEqual([`${c.agentKey}|${RUN}`]);
    await flush();
    expect(c.sink.histories).toHaveLength(1);
  });

  it("caps change (L9): refs whose listener no longer qualifies are dropped with unsupported; survivors keep working", async () => {
    const c = ctx(); // caps: runtx.v1 + runtx.lan.v1
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.svc.watch(c.agentKey, RUN, "lan:c2");
    c.rehello({ caps: ["ev.v1", "runtx.v1"] }); // LAN cap dropped ("/reload" with subagentTranscript=loopback)
    expect(c.sink.dropped).toEqual([
      { agentKey: c.agentKey, runId: RUN, err: { error: "E_UNSUPPORTED", reason: "unsupported" }, refs: ["lan:c2"] },
    ]);
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]); // watch survives (loopback ref)
    // the surviving loopback ref still streams
    c.replies.push(liveReply({ seq: 1 }));
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.svc.onFrame(c.agentKey, ev(2));
    expect(c.sink.evs.map((x) => x.seq)).toEqual([2]);
    // but LAN admission now fails closed
    await expectUnsupported(c.svc.snapshot(c.agentKey, RUN, "lan"));
  });

  it("caps change dropping ALL runtx caps: every ref dropped, watch deleted, tap off", () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.svc.watch(c.agentKey, RUN, "lan:c2");
    c.rehello({ caps: ["ev.v1"] }); // subagentTranscript=off
    const drops = c.sink.dropped.map((d) => [d.err.error, d.refs]);
    expect(drops).toEqual([["E_UNSUPPORTED", ["loopback:c1", "lan:c2"]]]);
    expect(watchFrames(c)).toEqual([
      { runId: RUN, on: true },
      { runId: RUN, on: false },
    ]);
    c.svc.onFrame(c.agentKey, ev(1)); // watch gone: inert
    expect(c.sink.evs).toEqual([]);
  });

  it("an ordinary reconnect with UNCHANGED caps publishes no caps event", () => {
    const c = ctx();
    c.rehello({});
    expect(c.events.filter((e) => e.type === "caps")).toEqual([]);
  });
});

describe("dispose", () => {
  it("clears state, unsubscribes from the bus, and never throws afterwards", () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.svc.dispose();
    c.svc.onFrame(c.agentKey, ev(1));
    c.reg.onFrame(c.agentKey, { t: "bye", reason: "quit" });
    c.reg.onClose(c.agentKey, true);
    expect(c.sink.evs).toEqual([]);
    expect(c.sink.dropped).toEqual([]);
    expect(() => c.svc.onFrame(c.agentKey, ev(2))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P1-1 (验收修补): a terminal snapshot must never overwrite the RunEndLedger's real
// {tapId,lastSeq} — full chain: end → ledger → resubscribe hits ledger → terminal snapshot →
// the agent retries the SAME end ⇒ deduped, no resync.
// ---------------------------------------------------------------------------

describe("P1-1: terminal snapshot preserves the ledger's real (tapId,lastSeq)", () => {
  it("end→ledger→resubscribe→terminal snapshot→agent end retry is deduped (no resync, no run_tx_req)", async () => {
    const c = ctx();
    // 1) live watch, watermark 4, then the aligned end lands in the ledger + sink
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.replies.push(liveReply({ seq: 4 }));
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 4, status: "completed" });
    expect(c.sink.ends).toHaveLength(1);

    // 2) full unsubscribe → resubscribe: the ledger hit skips arming a tap
    c.svc.unwatch(c.agentKey, RUN, "loopback:c1");
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    expect(watchFrames(c).filter((f) => f.on)).toHaveLength(1); // only the ORIGINAL arm

    // 3) terminal snapshot (file source) — before the fix this overwrote the ledger with {"",0}
    const file = writeJsonl("p1-1.jsonl", chainRaw("m", 3).map(line).join(""));
    c.replies.push(fileReply(file, "m2", "completed"));
    const p = await c.svc.snapshot(c.agentKey, RUN, "loopback");
    expect(p.terminal).toBe(true);

    // 4) the agent retries the very same run_end (endedPending tick after a flaky link)
    const reqsBefore = c.reqs.length;
    const resyncBefore = c.sink.resyncStarts.length;
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: TAP, lastSeq: 4, status: "completed" });

    // deduped against the LEDGER's real values: exactly one forwarded end, no new round
    expect(c.sink.ends).toHaveLength(1);
    expect(c.sink.resyncStarts).toHaveLength(resyncBefore);
    expect(c.reqs).toHaveLength(reqsBefore);
    expect(c.sink.dropped).toEqual([]);
  });

  it("terminal snapshot with NO prior ledger entry still synthesizes + seeds the ledger (mid-round loss)", async () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    const file = writeJsonl("p1-1-synth.jsonl", chainRaw("m", 3).map(line).join(""));
    c.replies.push(fileReply(file, "m2", "completed")); // terminal reply; no end was ever seen
    const p = await c.svc.snapshot(c.agentKey, RUN, "loopback");
    expect(p).toMatchObject({ terminal: true, live: false });
    // a later end matching the SYNTHESIZED {tapId:"",lastSeq:0} shape dedupes against the
    // seeded ledger — it is the very end the watch never saw, never a new one
    c.svc.onFrame(c.agentKey, { t: "run_end", runId: RUN, tapId: "", lastSeq: 0, status: "completed" });
    expect(c.sink.ends).toEqual([]); // ledger-deduped before any watch logic runs
    expect(c.sink.resyncStarts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P1-2 (验收修补): epoch/session change during an in-flight resync round must open a NEW
// round after the stale one settles (S8), consuming storm budget like any other round.
// ---------------------------------------------------------------------------

describe("P1-2: epoch change during an in-flight resync round re-arms after settle", () => {
  it("gap round in-flight → /reload (epoch) → stale round settles → second round opens", async () => {
    const c = ctx();
    c.replies.push(liveReply({ seq: 2 }));
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.sink.resyncStarts.length = 0;
    c.sink.histories.length = 0;

    // a gap fires a resync round, but the reply is HELD — the round stays in flight
    c.hold.on = true;
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 3 });
    expect(c.sink.resyncStarts).toHaveLength(1);

    // /reload lands mid-round: re-arm + again (before the fix this was swallowed by startResync)
    c.rehello({ epoch: "epoch-2" });
    expect(c.sink.resyncStarts).toHaveLength(1); // still just the one in-flight round…

    // round 2's reply is queued BEFORE releasing round 1, so it auto-answers when it fires
    c.replies.push(liveReply({ seq: 3 }));
    c.answerHeld((req) => liveReply({ seq: 3 })(req)); // round 1 settles with a PRE-reload watermark
    await waitFor(() => c.sink.resyncStarts.length >= 2); // …then the post-epoch round opens
    await waitFor(() => c.sink.histories.length >= 2);
    expect(c.sink.resyncStarts).toHaveLength(2);
    expect(c.sink.histories).toHaveLength(2);
    const kinds = c.conn.sent.map((f) => f.t);
    // the re-arm preceded the epoch round's request on the same socket
    expect(kinds.lastIndexOf("run_watch")).toBeLessThan(kinds.lastIndexOf("run_tx_req"));
  });

  it("the post-epoch round consumes storm budget: 10s/3-round breaker still trips on schedule", async () => {
    const c = ctx();
    c.replies.push(liveReply({ seq: 2 }));
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.sink.resyncStarts.length = 0;
    c.sink.dropped.length = 0;

    // rounds 1 (gap, held) + 2 (epoch again) — the epoch round counts toward the budget
    c.hold.on = true;
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 3 });
    c.rehello({ epoch: "epoch-3" });
    c.replies.push(liveReply({ seq: 3 }));
    c.answerHeld((req) => liveReply({ seq: 3 })(req));
    await waitFor(() => c.sink.resyncStarts.length >= 2);

    // round 3 (a plain gap) still fits; the 4th start attempt trips the breaker — proving the
    // epoch round's start pushed `times` like any other (otherwise this would be start #3).
    // Wait for round 3 to SETTLE first: while in flight, a further gap coalesces instead of
    // counting as a start attempt.
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 9 });
    await waitFor(() => c.sink.resyncStarts.length >= 3);
    await waitFor(() => c.sink.histories.length >= 3);
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 10 });
    expect(c.sink.dropped).toEqual([
      { agentKey: c.agentKey, runId: RUN, err: { error: "E_BUSY", reason: "resync_storm" }, refs: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------
// P2-1 (验收修补): the full §3.6 reader-failure → HubError mapping table, parameterized.
// ---------------------------------------------------------------------------

describe("P2-1: §3.6 reader failure mapping (parameterized)", () => {
  it.each([
    {
      reason: "file_missing",
      code: "E_NOT_FOUND",
      fixture: () => ({
        file: "/nonexistent-dir/x.jsonl",
        leaf: "m1",
        readerOpts: undefined as undefined | { scanChunkBytes?: number; maxScanBytes?: number },
      }),
    },
    {
      reason: "leaf_missing",
      code: "E_NOT_FOUND",
      fixture: () => ({
        file: writeJsonl("map-leaf.jsonl", chainRaw("m", 2).map(line).join("")),
        leaf: "zzz",
        readerOpts: undefined as undefined | { scanChunkBytes?: number; maxScanBytes?: number },
      }),
    },
    {
      reason: "too_large",
      code: "E_UNSUPPORTED",
      fixture: () => ({
        // ~6 entries ≈ 700B of chain; the reader's scan budget is pinned to 128B
        file: writeJsonl("map-big.jsonl", chainRaw("m", 6).map(line).join("")),
        leaf: "m5",
        readerOpts: { scanChunkBytes: 64, maxScanBytes: 128 },
      }),
    },
    {
      reason: "parse_error",
      code: "E_UNSUPPORTED",
      fixture: () => ({
        // the leaf's line contains the needle but is not valid JSON; a VALID line follows it
        // so it is not treated as the tolerated trailing half-written line
        file: writeJsonl(
          "map-parse.jsonl",
          [...chainRaw("m", 2).map(line), 'garbage{"id":"m2" not json\n', line(msgEntry("m3", "m2", 9))].join(""),
        ),
        leaf: "m2",
        readerOpts: undefined as undefined | { scanChunkBytes?: number; maxScanBytes?: number },
      }),
    },
    {
      reason: "busy",
      code: "E_BUSY",
      fixture: () => ({
        // an always-past-deadline clock: the service computes deadlineAt = now()+5s, and the
        // reader's first deadline check (cold cursor ⇒ needmore) already sees now()+12s
        file: writeJsonl("map-busy.jsonl", chainRaw("m", 3).map(line).join("")),
        leaf: "m2",
        readerOpts: undefined as undefined | { scanChunkBytes?: number; maxScanBytes?: number },
      }),
    },
  ] as const)("$reason ⇒ $code", async ({ reason, code, fixture }) => {
    const fx = fixture();
    const advancing = reason === "busy" ? { v: 1_000_000 } : undefined;
    const now = advancing === undefined ? undefined : () => (advancing.v += 6_000);
    const c = ctx({
      // the advancing clock must reach BOTH the service (deadline computation) and the reader
      // (deadline check) — threading it through readerOpts keeps them the same clock.
      readerOpts: { ...(fx.readerOpts ?? {}), ...(now === undefined ? {} : { now }) },
      ...(now === undefined ? {} : { now }),
    });
    c.replies.push(fileReply(fx.file, fx.leaf));
    await expect(c.svc.snapshot(c.agentKey, RUN, "loopback")).rejects.toMatchObject({ code, message: reason });
  });
});

// ---------------------------------------------------------------------------
// P2-2 (验收修补): capRunPayload actually trims against the REAL wire unit — an oversized
// SSE frame (snapshot) and an oversized bare JSON body (page), newest entry always kept.
// ---------------------------------------------------------------------------

describe("P2-2: capRunPayload truncation (real frame units)", () => {
  const bigEntries = (): WireEntry[] => {
    const mk = (id: string, parentId: string | null): WireEntry =>
      ({
        id,
        parentId,
        type: "message",
        timestamp: iso(1),
        message: { role: "user", content: "x".repeat(900_000) },
      }) as WireEntry;
    return [mk("b0", null), mk("b1", "b0"), mk("b2", "b1")]; // 3 × ~900KB > 2 MiB
  };

  it("snapshot: the SSE frame is trimmed under RUN_TX.maxBytes, newest kept, hasMore set", async () => {
    const c = ctx();
    const entries = bigEntries();
    c.replies.push(liveReply({ seq: 1, entries, hasMore: false }));
    const p = await c.svc.snapshot(c.agentKey, RUN, "loopback");
    expect(p.entries.length).toBeLessThan(entries.length); // trimmed from the oldest end
    expect(p.entries.at(-1)?.id).toBe("b2"); // the newest entry is always kept
    expect(p.hasMore).toBe(true); // trimming implies more on the agent side
    expect(p.oldestEntryId).toBe(p.entries[0]?.id);
    const frame = formatSseFrame("run_history", p);
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(RUN_TX.maxBytes);
  });

  it("page: the bare JSON body is trimmed under RUN_TX.maxBytes (different wire unit, same budget)", async () => {
    const c = ctx();
    const entries = bigEntries();
    c.replies.push(liveReply({ seq: 1, entries, hasMore: false }));
    const p = await c.svc.page(c.agentKey, RUN, "b0", 400, "loopback");
    expect(p.entries.length).toBeLessThan(entries.length);
    expect(p.entries.at(-1)?.id).toBe("b2");
    expect(Buffer.byteLength(JSON.stringify(p), "utf8")).toBeLessThanOrEqual(RUN_TX.maxBytes);
  });
});

// ---------------------------------------------------------------------------
// P2-3 (验收修补): listenerOfRef negative shapes — no misjudgment, no accidental watch.
// ---------------------------------------------------------------------------

describe("P2-3: listenerOfRef rejects malformed refs", () => {
  it.each(["lanish:x", "loopbackX:x", "loopback", "lan", "", ":c1", "loopback:", "lan:"])(
    "%j is refused with E_BAD_REQUEST and never arms a watch",
    (ref) => {
      const c = ctx();
      expect(() => c.svc.watch(c.agentKey, RUN, ref)).toThrowError(HubError);
      expect(() => c.svc.watch(c.agentKey, RUN, ref)).toThrowError(
        expect.objectContaining({ code: "E_BAD_REQUEST", message: "bad ref" }),
      );
      expect(watchFrames(c)).toEqual([]);
      expect(c.reqs).toEqual([]);
    },
  );

  it("well-formed refs on both listeners still parse (positive control)", () => {
    const c = ctx();
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    c.svc.watch(c.agentKey, RUN, "lan:c-2");
    c.svc.watch(c.agentKey, RUN, "lan:with:colons"); // clientId may itself contain colons
    expect(watchFrames(c)).toEqual([{ runId: RUN, on: true }]); // one arm, three refs
  });
});

// ---------------------------------------------------------------------------
// P2-4 (验收修补): the service's registry port REQUIRES getCaps — a provider lacking it is a
// type error, not a silent E_NOT_FOUND; undefined can only mean "agent absent".
// ---------------------------------------------------------------------------

describe("P2-4: RunTxRegistryPort contract (getCaps required)", () => {
  it("the dependency type demands a non-optional getCaps (type-level pin)", () => {
    type RegistryProp = Parameters<typeof createRunTranscriptService>[0]["registry"];
    expectTypeOf<RegistryProp["getCaps"]>().toEqualTypeOf<(agentKey: string) => readonly string[] | undefined>();
    // the full Registry satisfies the narrowed port structurally
    expectTypeOf<Registry>().toMatchTypeOf<RegistryProp>();
  });

  it("a narrow port object (only the four members) drives a full snapshot", async () => {
    const clock = { t: 1_000_000 };
    const reg = createRegistry({ now: () => clock.t, log: memLog(), pidAlive: () => true });
    const conn = fakeConn();
    const { agentKey } = reg.register(hello({ caps: ["ev.v1", "runtx.v1"] }), conn);
    const port = {
      getCaps: (k: string) => reg.getCaps(k),
      send: (k: string, f: HubFrame) => reg.send(k, f),
      request: <R extends AgentFrame>(k: string, f: HubFrame & { rid: string }, d: number) => reg.request<R>(k, f, d),
      bus: reg.bus,
    };
    const svc = createRunTranscriptService({
      registry: port,
      reader: createRunFileReader({ now: () => clock.t }),
      log: memLog(),
      now: () => clock.t,
    });
    // one scripted live reply, delivered through the real registry rid correlation
    const p = svc.snapshot(agentKey, RUN, "loopback");
    const req = conn.sent.find((f): f is Extract<HubFrame, { t: "run_tx_req" }> => f.t === "run_tx_req");
    expect(req).toBeDefined();
    reg.onFrame(agentKey, liveReply({ seq: 6 })({ ...req!, rid: req!.rid }) as AgentFrame);
    await expect(p).resolves.toMatchObject({ source: "live", fromSeq: 7 });
    // unknown agent through the narrow port still fails closed as E_NOT_FOUND
    await expect(svc.snapshot("a0000-nope", RUN, "loopback")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// P1-2 round 2 (验收第二回合): `again` is CAUSE-SPLIT — an epoch/session re-arm
// (`againEpoch`) must survive even a TERMINAL settle of the stale in-flight round (S8: the
// stale round's snapshot predates the epoch change and is never the post-change authority),
// while the end/gap causes keep being cleared by a terminal settle (their answer IS the
// terminal snapshot).
// ---------------------------------------------------------------------------

describe("P1-2 round 2: epoch re-arm survives a terminal settle", () => {
  it("Round A (epoch N) in-flight → re-hello (epoch N+1) → stale reply settles TERMINAL → Round B still opens and consumes storm budget", async () => {
    const c = ctx();
    c.replies.push(liveReply({ seq: 2 }));
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.sink.resyncStarts.length = 0;
    c.sink.histories.length = 0;
    c.sink.dropped.length = 0;

    // Round A starts (gap) but its reply is HELD — and the run has meanwhile gone terminal on
    // the agent, so A's stale reply (still from epoch N) will be a FILE/terminal one.
    const file = writeJsonl("p1-2r2.jsonl", chainRaw("m", 3).map(line).join(""));
    c.hold.on = true;
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 3 });
    expect(c.sink.resyncStarts).toHaveLength(1);

    // the epoch flips mid-round: resyncAll arms the epoch round (againEpoch=true)
    c.rehello({ epoch: "epoch-2" });

    // queue Round B's terminal reply (A's comes from answerHeld); Round C later falls through
    // to the default LIVE reply, whose settle (ended ⇒ again) is what trips the breaker
    c.replies.push(fileReply(file, "m2", "completed"));
    c.answerHeld((req) => fileReply(file, "m2", "completed")(req)); // A settles TERMINAL

    // before the cause-split fix, the terminal settle cleared `again` wholesale and Round B
    // never opened — leaving the browser with the STALE epoch-N terminal snapshot
    await waitFor(() => c.sink.resyncStarts.length >= 2);
    await waitFor(() => c.sink.histories.length >= 2);
    expect(c.sink.resyncStarts).toHaveLength(2);
    expect(c.sink.histories).toHaveLength(2);
    for (const h of c.sink.histories) {
      expect(h.payload).toMatchObject({ terminal: true, source: "file", resync: true });
    }
    const kinds = c.conn.sent.map((f) => f.t);
    expect(kinds.lastIndexOf("run_watch")).toBeLessThan(kinds.lastIndexOf("run_tx_req"));

    // Round B consumed storm budget: with starts {A, B} on the clock, one more gap round (C)
    // fits and its live settle (ended ⇒ again) makes the 4th start attempt trip the breaker
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 9 });
    await waitFor(() => c.sink.dropped.length >= 1);
    expect(c.sink.dropped).toEqual([
      { agentKey: c.agentKey, runId: RUN, err: { error: "E_BUSY", reason: "resync_storm" }, refs: undefined },
    ]);
  });

  it("contrast: GAP cause + terminal settle ⇒ again stays cleared, no second round (existing end-cause semantics pinned by the mid-round-end test above)", async () => {
    const c = ctx();
    c.replies.push(liveReply({ seq: 2 }));
    c.svc.watch(c.agentKey, RUN, "loopback:c1");
    await c.svc.snapshot(c.agentKey, RUN, "loopback");
    c.sink.resyncStarts.length = 0;
    c.sink.histories.length = 0;

    // Round A starts (hole) with its reply held; a gap lands mid-round pointing PAST any
    // watermark (the gap cause) — then A settles TERMINAL
    const file = writeJsonl("p1-2r2-gap.jsonl", chainRaw("m", 3).map(line).join(""));
    c.hold.on = true;
    c.svc.onFrame(c.agentKey, ev(9)); // hole ⇒ Round A
    expect(c.sink.resyncStarts).toHaveLength(1);
    c.svc.onFrame(c.agentKey, { t: "run_gap", runId: RUN, tapId: TAP, fromSeq: 99 }); // gap cause, mid-round
    c.answerHeld((req) => fileReply(file, "m2", "completed")(req)); // A settles TERMINAL
    await waitFor(() => c.sink.histories.length >= 1);

    // the terminal snapshot answers the run's own loss signals: no Round B fires (the gap
    // cause is live-guarded and the end cause was never armed in this scenario)
    expect(c.sink.resyncStarts).toHaveLength(1);
    expect(c.sink.histories).toHaveLength(1);
    expect(c.sink.histories[0]!.payload).toMatchObject({ terminal: true, resync: true });
    expect(c.sink.dropped).toEqual([]);
  });
});
