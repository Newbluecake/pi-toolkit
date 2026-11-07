/**
 * rebind-plan r3 §3.2/§4.7/§4.9 (agent package): ThreadEngine's acquire/rebind round trips and
 * the directory rev plumbing. Acceptance rows covered here: A4b (forced acquire before rebind
 * when the directory has no trusted rev), A9 (no thr.rebind.v1 ⇒ LOCAL E_THR_UNSUPPORTED, ZERO
 * frames), A12 (first takeover), A13 (re-takeover after a rebound-away), plus the §4.7
 * E_THR_STALE re-acquire-and-retry-once law and the dispose guard (§6 实施要点 7).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import { ThreadEngine, type ThreadEngineDeps } from "../../../src/fabric/thread/engine.js";
import type { ThrResFrame } from "../../../src/web-hub/protocol/thread.js";
import { flushMicrotasks, H1, RUN_A } from "./harness.js";

const SID_WORKER = "worker-session-full-id";

const owned = (h: string, label: string, rev: number): ThrResFrame =>
  ({ t: "thr_res", rid: "rid", ok: true, data: { owned: true, h, label, rev } }) as ThrResFrame;
const rebound = (h: string, sessionId: string, rev: number, changed: boolean, label: string): ThrResFrame =>
  ({ t: "thr_res", rid: "rid", ok: true, data: { rebound: true, h, sessionId, rev, changed, label } }) as ThrResFrame;
const thrErr = (code: string, effect: "none" | "unknown"): ThrResFrame =>
  ({ t: "thr_res", rid: "rid", ok: false, code, effect }) as ThrResFrame;

interface RebindWorld {
  engine: ThreadEngine;
  capable: { value: boolean };
  acquire: ReturnType<typeof vi.fn<(h: string) => Promise<ThrResFrame>>>;
  rebind: ReturnType<typeof vi.fn<(h: string, to: string, fromRev: number) => Promise<ThrResFrame>>>;
}

function makeWorld(): RebindWorld {
  const clock = new FakeClock(0);
  const capable = { value: true };
  const acquire = vi.fn<(h: string) => Promise<ThrResFrame>>();
  const rebind = vi.fn<(h: string, to: string, fromRev: number) => Promise<ThrResFrame>>();
  const deps: ThreadEngineDeps = {
    clock,
    runFacts: (runId) => (runId === RUN_A ? { direct: true, status: "running", steerable: true } : undefined),
    hubCapable: () => true,
    steerThread: () => Promise.resolve("queued"),
    replyRouted: () => undefined,
    releaseToNative: () => true,
    requestAutoReturn: () => undefined,
    replyStaleCtx: () => undefined,
    display: () => undefined,
    hint: () => undefined,
    audit: () => undefined,
    rebind: {
      hubRebindCapable: () => capable.value,
      acquire: (h) => acquire(h),
      rebind: (h, to, fromRev) => rebind(h, to, fromRev),
    },
  };
  return { engine: new ThreadEngine(deps), capable, acquire, rebind };
}

describe("ThreadEngine acquireThread (rebind-plan §3.2 step 7 / §4.7)", () => {
  it("A9: no thr.rebind.v1 ⇒ LOCAL E_THR_UNSUPPORTED with ZERO frames (acquire AND rebind)", async () => {
    const w = makeWorld();
    w.capable.value = false;
    w.engine.noteThread(H1, "topic");
    // the acquire fast path is LOCAL (zero frames by construction) — A9 targets the paths that
    // WOULD send: force acquire and rebind.
    const acq = await w.engine.acquireThread(H1, { force: true });
    expect(acq).toEqual({ ok: false, code: "E_THR_UNSUPPORTED", effect: "none" });
    const reb = await w.engine.rebindThread(H1, SID_WORKER);
    expect(reb).toEqual({ ok: false, code: "E_THR_UNSUPPORTED", effect: "none" });
    expect(w.acquire).not.toHaveBeenCalled();
    expect(w.rebind).not.toHaveBeenCalled();
  });

  it("A9 companion: the open fast path stays LOCAL under an old hub (zero frames, no cap needed)", async () => {
    const w = makeWorld();
    w.capable.value = false;
    w.engine.noteThread(H1, "topic", 41);
    const res = await w.engine.acquireThread(H1); // no force ⇒ local fast path
    expect(res).toEqual({ ok: true, already: true, label: "topic", rev: 41 });
    expect(w.acquire).not.toHaveBeenCalled();
  });

  it("open fast path: isOpen ∧ no force ⇒ local answer, NO round trip, rev NOT refreshed", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    const res = await w.engine.acquireThread(H1);
    expect(res).toEqual({ ok: true, already: true, label: "topic", rev: 41 });
    expect(w.acquire).not.toHaveBeenCalled();
  });

  it("force:true skips the fast path and ALWAYS refreshes from the hub (§4.7)", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    w.acquire.mockResolvedValue(owned(H1, "topic", 44));
    const res = await w.engine.acquireThread(H1, { force: true });
    expect(res).toEqual({ ok: true, already: false, label: "topic", rev: 44 });
    expect(w.acquire).toHaveBeenCalledTimes(1);
    expect(w.engine.directory.get(H1)?.rev).toBe(44);
  });

  it("A12: first takeover — subscribe refuses unknown ⇒ acquire reopens ⇒ subscribe succeeds, rev = receipt", async () => {
    const w = makeWorld();
    const first = w.engine.subscribe({ runId: RUN_A, h: H1, label: "worker-a", scope: "s", createdBy: "root" });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toBe("thread_unknown");
    w.acquire.mockResolvedValue(owned(H1, "topic", 41));
    const acq = await w.engine.acquireThread(H1);
    expect(acq.ok).toBe(true);
    expect(w.engine.directory.isOpen(H1)).toBe(true);
    expect(w.engine.directory.get(H1)?.rev).toBe(41);
    const second = w.engine.subscribe({ runId: RUN_A, h: H1, label: "worker-a", scope: "s", createdBy: "root" });
    expect(second.ok).toBe(true);
  });

  it("A13: re-takeover — rebound-away closes + clears rev; forced acquire reopens and subscribe works again", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    const sub = w.engine.subscribe({ runId: RUN_A, h: H1, label: "worker-a", scope: "s", createdBy: "root" });
    expect(sub.ok).toBe(true);
    w.engine.threadClosed(H1, "rebound");
    expect(w.engine.directory.isOpen(H1)).toBe(false);
    expect(w.engine.directory.get(H1)?.rev).toBeUndefined(); // §4.7: close clears rev
    w.acquire.mockResolvedValue(owned(H1, "topic", 52));
    const acq = await w.engine.acquireThread(H1, { force: true });
    expect(acq).toEqual({ ok: true, already: false, label: "topic", rev: 52 });
    expect(w.engine.directory.isOpen(H1)).toBe(true);
    expect(w.engine.directory.get(H1)?.rev).toBe(52);
    const again = w.engine.subscribe({ runId: RUN_A, h: H1, label: "worker-a", scope: "s", createdBy: "root" });
    expect(again.ok).toBe(true);
  });

  it("E_THR_NO_OWNER on acquire passes through (the old holder can never reopen)", async () => {
    const w = makeWorld();
    w.acquire.mockResolvedValue(thrErr("E_THR_NO_OWNER", "none"));
    const res = await w.engine.acquireThread(H1);
    expect(res).toEqual({ ok: false, code: "E_THR_NO_OWNER", effect: "none" });
    expect(w.engine.directory.isOpen(H1)).toBe(false);
  });

  it("a thrown round trip maps to E_TIMEOUT/unknown (§4.9 P2 — never blind-retry); E_NO_CAP maps to E_THR_UNSUPPORTED", async () => {
    const w = makeWorld();
    w.acquire.mockRejectedValueOnce(new Error("E_TIMEOUT: admin request timed out"));
    expect(await w.engine.acquireThread(H1)).toEqual({ ok: false, code: "E_TIMEOUT", effect: "unknown" });
    w.acquire.mockRejectedValueOnce(new Error("E_NO_CAP: thr.rebind.v1"));
    expect(await w.engine.acquireThread(H1)).toEqual({ ok: false, code: "E_THR_UNSUPPORTED", effect: "none" });
  });

  it("dispose while the round trip is in flight ⇒ NO directory write (§6 实施要点 7)", async () => {
    const w = makeWorld();
    let settle: (res: ThrResFrame) => void = () => undefined;
    w.acquire.mockImplementation(
      () =>
        new Promise<ThrResFrame>((resolve) => {
          settle = resolve;
        }),
    );
    const pending = w.engine.acquireThread(H1);
    w.engine.dispose();
    settle(owned(H1, "topic", 41));
    await flushMicrotasks();
    const res = await pending;
    expect(res).toEqual({ ok: false, code: "E_THREAD_DISPOSED", effect: "none" });
    expect(w.engine.directory.get(H1)).toBeUndefined(); // never written after dispose
  });
});

describe("ThreadEngine rebindThread (rebind-plan §4.7 fromRev injection / §4.9)", () => {
  it("directory rev is injected as fromRev — NO acquire round trip when it exists", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    w.rebind.mockResolvedValue(rebound(H1, SID_WORKER, 42, true, "topic"));
    const res = await w.engine.rebindThread(H1, SID_WORKER);
    expect(res).toEqual({ ok: true, h: H1, sessionId: SID_WORKER, rev: 42, changed: true, label: "topic" });
    expect(w.acquire).not.toHaveBeenCalled();
    expect(w.rebind).toHaveBeenCalledWith(H1, SID_WORKER, 41);
    // §4.7: the success receipt is a trusted rev source (monotonic)
    expect(w.engine.directory.get(H1)?.rev).toBe(42);
  });

  it("A4b: directory has NO rev ⇒ ONE forced acquire first; its rev becomes fromRev (CAS input)", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic"); // no rev — e.g. hub never attached ThreadMeta.rev
    w.acquire.mockResolvedValue(owned(H1, "topic", 41));
    w.rebind.mockResolvedValue(rebound(H1, SID_WORKER, 42, true, "topic"));
    const res = await w.engine.rebindThread(H1, SID_WORKER);
    expect(res.ok).toBe(true);
    expect(w.acquire).toHaveBeenCalledTimes(1);
    expect(w.rebind).toHaveBeenCalledTimes(1);
    expect(w.rebind).toHaveBeenCalledWith(H1, SID_WORKER, 41); // the ACQUIRE rev, not a guess
    // call order: acquire strictly before rebind
    expect(w.acquire.mock.invocationCallOrder[0]!).toBeLessThan(w.rebind.mock.invocationCallOrder[0]!);
  });

  it("E_THR_STALE ⇒ re-acquire the current rev and retry ONCE (never hard-retry the stale value)", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    w.rebind.mockResolvedValueOnce(thrErr("E_THR_STALE", "none"));
    w.acquire.mockResolvedValue(owned(H1, "topic", 47));
    w.rebind.mockResolvedValueOnce(rebound(H1, SID_WORKER, 48, true, "topic"));
    const res = await w.engine.rebindThread(H1, SID_WORKER);
    expect(res).toEqual({ ok: true, h: H1, sessionId: SID_WORKER, rev: 48, changed: true, label: "topic" });
    expect(w.rebind).toHaveBeenCalledTimes(2);
    expect(w.rebind).toHaveBeenNthCalledWith(1, H1, SID_WORKER, 41);
    expect(w.acquire).toHaveBeenCalledTimes(1);
    expect(w.rebind).toHaveBeenNthCalledWith(2, H1, SID_WORKER, 47); // fresh rev, exactly one retry
  });

  it("a SECOND E_THR_STALE is returned as-is (one retry is all §4.7 allows)", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    w.rebind.mockResolvedValue(thrErr("E_THR_STALE", "none"));
    w.acquire.mockResolvedValue(owned(H1, "topic", 47));
    const res = await w.engine.rebindThread(H1, SID_WORKER);
    expect(res).toEqual({ ok: false, code: "E_THR_STALE", effect: "none" });
    expect(w.rebind).toHaveBeenCalledTimes(2);
  });

  it("definitive hub errors pass through untouched (E_THR_NO_OWNER / E_THR_COMMIT unknown)", async () => {
    const w = makeWorld();
    w.engine.noteThread(H1, "topic", 41);
    w.rebind.mockResolvedValueOnce(thrErr("E_THR_NO_OWNER", "none"));
    expect(await w.engine.rebindThread(H1, SID_WORKER)).toEqual({
      ok: false,
      code: "E_THR_NO_OWNER",
      effect: "none",
    });
    w.rebind.mockResolvedValueOnce(thrErr("E_THR_COMMIT", "unknown"));
    expect(await w.engine.rebindThread(H1, SID_WORKER)).toEqual({
      ok: false,
      code: "E_THR_COMMIT",
      effect: "unknown",
    });
    expect(w.rebind).toHaveBeenCalledTimes(2);
    expect(w.acquire).not.toHaveBeenCalled(); // no STALE ⇒ no recovery acquire
  });
});
