/** web-hub-html-preview plan v2 T-H2 / §2.2 / §2.4 / §R2 — `hub/preview/html-cap.ts`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewHandle } from "../../../../src/web-hub/hub/preview/admit.js";
import {
  createHtmlCapStore,
  type HtmlCapMintInput,
  type HtmlCapStore,
  type PvEndSummary,
} from "../../../../src/web-hub/hub/preview/html-cap.js";
import {
  PV_CAP_RE,
  PV_CAPS_GLOBAL,
  PV_CAPS_PER_PRINCIPAL,
  PV_HARD_TTL_MS,
  PV_IDLE_TTL_MS,
  PV_TOMBSTONE_RING,
} from "../../../../src/web-hub/protocol/preview-html.js";

afterEach(() => vi.restoreAllMocks());

function fh(): PreviewHandle & { closed: number } {
  const h = {
    closed: 0,
    fd: 9,
    stat: async () => {
      throw new Error("unused");
    },
    read: async () => ({ bytesRead: 0 }),
    close: async () => {
      h.closed += 1;
    },
  };
  return h as unknown as PreviewHandle & { closed: number };
}

function setup(limits?: Parameters<typeof createHtmlCapStore>[0]["limits"]) {
  let t = 1_000_000;
  const ends: PvEndSummary[] = [];
  const store = createHtmlCapStore({
    now: () => t,
    closeDir: (h) => h.close(),
    onEnd: (s) => ends.push(s),
    limits,
  });
  const input = (over: Partial<HtmlCapMintInput> = {}): HtmlCapMintInput => ({
    principal: "p1",
    listener: "loopback",
    origin: "http://127.0.0.1:1",
    sidTag: "sid-a",
    dirFh: fh(),
    dirPath: "/tmp/site",
    dirDev: 1,
    dirIno: 2,
    entry: "index.html",
    ...over,
  });
  const mint = (store: HtmlCapStore, over: Partial<HtmlCapMintInput> = {}) => {
    const r = store.mintChecked(store.revokeSeq(), input(over));
    if (!r.ok) throw new Error(`mint failed ${r.reason}`);
    return r.rec;
  };
  return { store, ends, advance: (ms: number) => (t += ms), input, mint, now: () => t };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("html-cap store: identity & lookup", () => {
  it("caps are unique 43-char base64url; two mints of the same file ⇒ two caps", () => {
    const { store, mint } = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const rec = mint(store);
      expect(PV_CAP_RE.test(rec.cap)).toBe(true);
      expect(rec.capTag).toMatch(/^[0-9a-f]{12}$/);
      expect(rec.capTag).not.toContain(rec.cap.slice(0, 8));
      seen.add(rec.cap);
    }
    expect(seen.size).toBe(6);
  });

  it("uses crypto randomBytes(32) (seam receives 32)", () => {
    const calls: number[] = [];
    const store = createHtmlCapStore({
      now: () => 0,
      closeDir: async () => undefined,
      randomBytes: (n) => {
        calls.push(n);
        return Buffer.alloc(n, 7);
      },
    });
    const r = store.mintChecked(0, { ...setup().input(), principal: "x" });
    expect(r.ok && r.rec.cap).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(calls).toEqual([32]);
  });

  it("lookup binds listener + origin", () => {
    const { store, mint } = setup();
    const rec = mint(store);
    expect(store.lookup(rec.cap, "loopback", rec.origin)).toBe(rec);
    expect(store.lookup(rec.cap, "lan", rec.origin)).toBeUndefined();
    expect(store.lookup(rec.cap, "loopback", "http://other")).toBeUndefined();
    expect(store.lookup("x".repeat(43), "loopback", rec.origin)).toBeUndefined();
  });
});

describe("html-cap store: TTL (fake clock)", () => {
  it("idle expiry slides with lookups; hard expiry is absolute", () => {
    const { store, mint, advance, ends } = setup();
    const rec = mint(store);
    advance(PV_IDLE_TTL_MS - 1000);
    expect(store.lookup(rec.cap, "loopback", rec.origin)).toBe(rec); // slides
    advance(PV_IDLE_TTL_MS - 1000);
    expect(store.lookup(rec.cap, "loopback", rec.origin)).toBe(rec);
    // keep sliding until the hard deadline
    while (rec.hardAt - (rec.lastUsedAt + 1) > PV_IDLE_TTL_MS) {
      advance(PV_IDLE_TTL_MS - 1000);
      expect(store.lookup(rec.cap, "loopback", rec.origin)).toBe(rec);
    }
    advance(PV_HARD_TTL_MS); // past hardAt regardless of activity
    expect(store.lookup(rec.cap, "loopback", rec.origin)).toBeUndefined();
    expect(store.isLive(rec)).toBe(false);
    expect(ends.map((e) => e.end)).toEqual(["hard"]);
  });

  it("idle expiry ends the cap once, closes the dir fd, summary says idle", async () => {
    const { store, mint, advance, ends } = setup();
    const rec = mint(store);
    advance(PV_IDLE_TTL_MS);
    expect(store.lookup(rec.cap, "loopback", rec.origin)).toBeUndefined();
    store.sweep();
    await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ end: "idle", capTag: rec.capTag });
    expect((rec.dirFh as PreviewHandle & { closed: number }).closed).toBe(1);
    expect(store.size).toBe(0);
  });

  it("hard deadline is mint + PV_HARD_TTL_MS; idle/hard constants ordered", () => {
    const { store, mint, now } = setup();
    const rec = mint(store);
    expect(rec.hardAt).toBe(now() + PV_HARD_TTL_MS);
    expect(PV_IDLE_TTL_MS).toBeLessThan(PV_HARD_TTL_MS);
  });

  it("never schedules a timer (no setTimeout / setInterval)", () => {
    const st = vi.spyOn(globalThis, "setTimeout");
    const si = vi.spyOn(globalThis, "setInterval");
    const { store, mint, advance } = setup();
    const rec = mint(store);
    store.lookup(rec.cap, "loopback", rec.origin);
    const lease = store.lease(rec)!;
    lease.release();
    advance(PV_IDLE_TTL_MS);
    store.sweep();
    store.revoke("all", "close");
    store.dispose();
    expect(st).not.toHaveBeenCalled();
    expect(si).not.toHaveBeenCalled();
  });
});

describe("html-cap store: occupancy / FIFO eviction", () => {
  it("per principal 8: the 9th evicts the oldest of THAT principal and closes its dir fd", async () => {
    const { store, mint, ends } = setup();
    const first = mint(store, { principal: "a" });
    const other = mint(store, { principal: "b" });
    for (let i = 1; i < PV_CAPS_PER_PRINCIPAL; i += 1) mint(store, { principal: "a" });
    expect(store.lookup(first.cap, "loopback", first.origin, { touch: false })).toBe(first);
    const ninth = mint(store, { principal: "a" });
    await flush();
    expect(store.isLive(first)).toBe(false);
    expect(store.isLive(other)).toBe(true);
    expect(store.isLive(ninth)).toBe(true);
    expect((first.dirFh as PreviewHandle & { closed: number }).closed).toBe(1);
    expect(ends.filter((e) => e.end === "evicted")).toHaveLength(1);
  });

  it("global 64: the 65th evicts the oldest overall", async () => {
    const { store, mint } = setup();
    const recs = [];
    for (let i = 0; i < PV_CAPS_GLOBAL; i += 1) recs.push(mint(store, { principal: `p${i}` }));
    expect(store.size).toBe(PV_CAPS_GLOBAL);
    mint(store, { principal: "late" });
    await flush();
    expect(store.size).toBe(PV_CAPS_GLOBAL);
    expect(store.isLive(recs[0]!)).toBe(false);
    expect(store.isLive(recs[1]!)).toBe(true);
    expect((recs[0]!.dirFh as PreviewHandle & { closed: number }).closed).toBe(1);
  });
});

describe("html-cap store: revoke (T-H2 / §2.4)", () => {
  it("by sidTag / userId / listener / all — only matching caps die, seq + tombstone advance", () => {
    const { store, mint } = setup();
    const a = mint(store, { sidTag: "s1", userId: 1, listener: "lan", principal: "u1" });
    const b = mint(store, { sidTag: "s2", userId: 2, listener: "lan", principal: "u2" });
    const c = mint(store, { sidTag: "s3", listener: "loopback", principal: "lo" });
    const d = mint(store, { sidTag: "s4", userId: 1, listener: "lan", principal: "u1b" });
    expect(store.revokeSeq()).toBe(0);
    store.revoke({ sidTag: "s1" }, "logout");
    expect(store.revokeSeq()).toBe(1);
    expect([a, b, c, d].map((r) => store.isLive(r))).toEqual([false, true, true, true]);
    store.revoke({ userId: 1 }, "passwd");
    expect([a, b, c, d].map((r) => store.isLive(r))).toEqual([false, true, true, false]);
    store.revoke({ listener: "lan" }, "rotate");
    expect([b, c].map((r) => store.isLive(r))).toEqual([false, true]);
    store.revoke({ listener: "loopback" }, "rotate");
    expect(store.isLive(c)).toBe(false);
    const e = mint(store);
    store.revoke("all", "close");
    expect(store.isLive(e)).toBe(false);
    expect(store.revokeSeq()).toBe(5);
    expect(store.size).toBe(0);
  });

  it("a revoke that matches nothing still bumps the seq (mint race detection depends on it)", () => {
    const { store } = setup();
    store.revoke({ sidTag: "nobody" }, "logout");
    expect(store.revokeSeq()).toBe(1);
  });

  it("revoke aborts in-flight controllers, cancels queued waiters, and defers the dir close until leases drain", async () => {
    const { store, mint, ends } = setup();
    const rec = mint(store);
    const l1 = store.lease(rec)!;
    const l2 = store.lease(rec)!;
    const cancelled: string[] = [];
    const w = { cancel: (r: string) => void cancelled.push(r) };
    expect(store.addWaiter(rec, w)).toBe(true);
    store.revoke({ sidTag: "sid-a" }, "logout");
    expect(l1.signal.aborted).toBe(true);
    expect(l2.signal.aborted).toBe(true);
    expect(cancelled).toEqual(["revoked"]);
    expect(ends[0]).toMatchObject({ end: "revoked" });
    await flush();
    const h = rec.dirFh as PreviewHandle & { closed: number };
    expect(h.closed).toBe(0); // in-flight users still hold the fd
    l1.release();
    await flush();
    expect(h.closed).toBe(0);
    l2.release();
    l2.release(); // idempotent
    await flush();
    expect(h.closed).toBe(1);
    expect(store.lease(rec)).toBeUndefined();
    expect(store.addWaiter(rec, w)).toBe(false);
  });

  it("dispose ⇒ every cap ends `close`, dir fds closed, later mints refused", async () => {
    const { store, mint, ends, input } = setup();
    const a = mint(store);
    mint(store, { principal: "q" });
    store.dispose();
    store.dispose();
    await flush();
    expect(ends.map((e) => e.end)).toEqual(["close", "close"]);
    expect((a.dirFh as PreviewHandle & { closed: number }).closed).toBe(1);
    expect(store.mintChecked(store.revokeSeq(), input())).toMatchObject({ ok: false });
  });
});

describe("html-cap store: endCap (single cap)", () => {
  it("ends exactly that cap; same-principal/session siblings stay live; seq bumps once", async () => {
    const { store, mint, ends } = setup();
    const a = mint(store);
    const b = mint(store); // same principal + sidTag
    const la = store.lease(a)!;
    const lb = store.lease(b)!;
    const cancelled: string[] = [];
    store.addWaiter(a, { cancel: (r) => void cancelled.push(r) });
    const seq0 = store.revokeSeq();
    store.endCap(a);
    expect(store.revokeSeq()).toBe(seq0 + 1);
    expect(store.isLive(a)).toBe(false);
    expect(store.isLive(b)).toBe(true);
    expect(la.signal.aborted).toBe(true);
    expect(lb.signal.aborted).toBe(false);
    expect(cancelled).toEqual(["revoked"]);
    expect(store.lookup(a.cap, "loopback", a.origin)).toBeUndefined();
    expect(store.lookup(b.cap, "loopback", b.origin)).toBe(b);
    expect(store.size).toBe(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ end: "revoked", capTag: a.capTag });
    await flush();
    expect((b.dirFh as PreviewHandle & { closed: number }).closed).toBe(0);
    lb.release();
  });

  it("closes the dir fd only after in-flight refs drop, exactly once", async () => {
    const { store, mint } = setup();
    const rec = mint(store);
    const l1 = store.lease(rec)!;
    const l2 = store.lease(rec)!;
    store.endCap(rec);
    await flush();
    const h = rec.dirFh as PreviewHandle & { closed: number };
    expect(h.closed).toBe(0);
    l1.release();
    await flush();
    expect(h.closed).toBe(0);
    l2.release();
    await flush();
    expect(h.closed).toBe(1);
    store.endCap(rec);
    await flush();
    expect(h.closed).toBe(1);
  });

  it("with no leases the fd closes immediately; the reason can be `close`", async () => {
    const { store, mint, ends } = setup();
    const rec = mint(store);
    store.endCap(rec, "close");
    await flush();
    expect((rec.dirFh as PreviewHandle & { closed: number }).closed).toBe(1);
    expect(ends[0]).toMatchObject({ end: "close" });
  });

  it("is idempotent: a second end (or ending an expired/revoked cap) is a no-op", () => {
    const { store, mint, ends, advance } = setup();
    const a = mint(store);
    store.endCap(a);
    const seq = store.revokeSeq();
    store.endCap(a);
    store.endCap(a, "close");
    expect(store.revokeSeq()).toBe(seq);
    expect(ends).toHaveLength(1);
    const b = mint(store);
    store.revoke({ sidTag: "sid-a" }, "logout");
    const seq2 = store.revokeSeq();
    store.endCap(b);
    expect(store.revokeSeq()).toBe(seq2);
    expect(ends).toHaveLength(2);
    const c = mint(store);
    advance(PV_HARD_TTL_MS);
    store.sweep();
    const seq3 = store.revokeSeq();
    store.endCap(c);
    expect(store.revokeSeq()).toBe(seq3);
    expect(ends).toHaveLength(3);
  });

  it("a per-cap tombstone never trips an unrelated mint's revoked check", () => {
    const { store, mint, input } = setup();
    const a = mint(store);
    const s0 = store.revokeSeq();
    store.endCap(a);
    expect(store.revokedSince(s0, { listener: "loopback", sidTag: "sid-a" })).toBe("clear");
    expect(store.mintChecked(s0, input()).ok).toBe(true);
  });
});

describe("html-cap store: mintChecked race semantics (§R2, T-H16/T-H16b)", () => {
  it("seq0 captured BEFORE authorize: a revoke landing after is detected (sid match)", () => {
    const { store, input } = setup();
    const seq0 = store.revokeSeq();
    store.revoke({ sidTag: "sid-a" }, "logout"); // lands "during authorize"
    const dirFh = fh();
    const r = store.mintChecked(seq0, input({ dirFh }));
    expect(r).toEqual({ ok: false, reason: "revoked" });
    expect(store.size).toBe(0);
  });

  it("passwd (userId), listener rotate and `all` since seq0 are detected; unrelated revokes are not", () => {
    const { store, input } = setup();
    const mk = (over: Partial<HtmlCapMintInput>) => input({ listener: "lan", userId: 5, sidTag: "s", ...over });
    let s0 = store.revokeSeq();
    store.revoke({ userId: 5 }, "passwd");
    expect(store.mintChecked(s0, mk({}))).toMatchObject({ reason: "revoked" });
    s0 = store.revokeSeq();
    store.revoke({ userId: 6 }, "passwd");
    store.revoke({ sidTag: "zzz" }, "logout");
    store.revoke({ listener: "loopback" }, "rotate");
    expect(store.mintChecked(s0, mk({})).ok).toBe(true);
    s0 = store.revokeSeq();
    store.revoke({ listener: "lan" }, "rotate");
    expect(store.mintChecked(s0, mk({})).ok).toBe(false);
    s0 = store.revokeSeq();
    store.revoke("all", "close");
    expect(store.revokedSince(s0, { listener: "lan" })).toBe("revoked");
  });

  it("a mint whose binding lacks sidTag/userId is not matched by sid/user tombstones", () => {
    const { store, input } = setup();
    const s0 = store.revokeSeq();
    store.revoke({ sidTag: "a" }, "logout");
    store.revoke({ userId: 1 }, "passwd");
    expect(store.mintChecked(s0, input({ sidTag: undefined, userId: undefined })).ok).toBe(true);
  });

  it("seq0 older than the retained tombstones ⇒ fail closed (tombstone-gap)", () => {
    const { store, input } = setup({ tombstones: 4 });
    const s0 = store.revokeSeq();
    for (let i = 0; i < 6; i += 1) store.revoke({ sidTag: `x${i}` }, "logout");
    expect(store.revokedSince(s0, { listener: "loopback", sidTag: "sid-a" })).toBe("unknown");
    expect(store.mintChecked(s0, input())).toEqual({ ok: false, reason: "tombstone-gap" });
    // a seq0 inside the window is fine
    expect(store.mintChecked(store.revokeSeq(), input()).ok).toBe(true);
    expect(PV_TOMBSTONE_RING).toBe(256);
  });
});

describe("html-cap store: accounting & leases", () => {
  it("counts requests/bytes/denied (code table bounded) and throttles denial audits", () => {
    const { store, mint, advance, ends } = setup();
    const rec = mint(store);
    store.noteRequest(rec);
    store.noteRequest(rec);
    store.noteBytes(rec, 100);
    store.noteBytes(rec, -5);
    expect(store.noteDenied(rec, "denylist")).toBe(true);
    expect(store.noteDenied(rec, "denylist")).toBe(false); // throttled
    advance(1000);
    expect(store.noteDenied(rec, "outside")).toBe(true);
    for (let i = 0; i < 40; i += 1) store.noteDenied(rec, `c${i}`);
    expect(Object.keys(rec.codes).length).toBeLessThanOrEqual(16);
    store.revoke("all", "close");
    expect(ends[0]).toMatchObject({ reqs: 2, bytes: 100, end: "close" });
    expect(ends[0]!.denied).toBeGreaterThan(40);
  });

  it("lease release slides the idle clock; totals() sums active + queued", () => {
    const { store, mint, advance } = setup();
    const rec = mint(store);
    const l = store.lease(rec)!;
    store.addWaiter(rec, { cancel: () => undefined });
    expect(store.totals()).toEqual({ active: 1, queued: 1 });
    advance(PV_IDLE_TTL_MS - 5);
    l.release();
    advance(PV_IDLE_TTL_MS - 5);
    expect(store.isLive(rec)).toBe(true);
  });

  it("an expired cap aborts its in-flight lease on the next sweep", () => {
    const { store, mint, advance } = setup();
    const rec = mint(store);
    const l = store.lease(rec)!;
    advance(PV_HARD_TTL_MS);
    store.sweep();
    expect(l.signal.aborted).toBe(true);
  });
});
