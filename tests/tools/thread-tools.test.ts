import { describe, expect, it, vi } from "vitest";
import type { HubConnection } from "../../src/web-hub/agent/connection.js";
import type { ThrResFrame } from "../../src/web-hub/protocol/thread.js";
import {
  createThreadChildTool,
  thrHandbackWithRetry,
  thrPostWithRetry,
  type ThreadChildOps,
} from "../../src/tools/thread-child-tool.js";
import { createThreadTool, type ThreadMainOps } from "../../src/tools/thread-tool.js";

/** Minimal fake link: only `request` is exercised by the retry helpers. */
const fakeConn = (impl: (frame: unknown) => Promise<ThrResFrame>): HubConnection =>
  ({ request: impl }) as unknown as HubConnection;

const ok = (
  data: ThrResFrame extends never ? never : { queued: true } | { requestId: string; dup?: true },
): ThrResFrame => ({ t: "thr_res", rid: "rid-1", ok: true, data }) as ThrResFrame;
const err = (code: string, effect: "none" | "unknown"): ThrResFrame => ({
  t: "thr_res",
  rid: "rid-1",
  ok: false,
  code,
  effect,
});

describe("thrPostWithRetry (§7.3: one same-postId retry, then unknown)", () => {
  it("succeeds on the retry with the SAME postId", async () => {
    const frames: Array<{ postId?: string }> = [];
    const conn = fakeConn((frame) => {
      frames.push(frame as { postId?: string });
      return frames.length === 1 ? Promise.reject(new Error("E_TIMEOUT")) : Promise.resolve(ok({ queued: true }));
    });
    const out = await thrPostWithRetry(() => conn, {
      h: "fs:AAAAAAAAAAAA",
      sessionId: "s1",
      by: { runId: "r_0123456Q", label: "w1" },
      postId: "r_0123456Q:1",
      text: "hi",
    });
    expect(out).toEqual({ ok: true, queued: true });
    expect(frames).toHaveLength(2);
    expect(frames[0]!.postId).toBe("r_0123456Q:1");
    expect(frames[1]!.postId).toBe("r_0123456Q:1");
  });

  it("both attempts reject ⇒ unknown (possibly sent — do not repeat)", async () => {
    const conn = fakeConn(() => Promise.reject(new Error("E_TIMEOUT")));
    const out = await thrPostWithRetry(() => conn, {
      h: "fs:AAAAAAAAAAAA",
      sessionId: "s1",
      by: { runId: "r_0123456Q", label: "w1" },
      postId: "r_0123456Q:1",
      text: "hi",
    });
    expect(out).toEqual({ unknown: true });
  });

  it("a definitive error does NOT retry", async () => {
    const calls: number[] = [];
    const conn = fakeConn(() => {
      calls.push(1);
      return Promise.resolve(err("E_THR_RATE", "none"));
    });
    const out = await thrPostWithRetry(() => conn, {
      h: "fs:AAAAAAAAAAAA",
      sessionId: "s1",
      by: { runId: "r_0123456Q", label: "w1" },
      postId: "r_0123456Q:1",
      text: "hi",
    });
    expect(out).toEqual({ error: "E_THR_RATE", effect: "none" });
    expect(calls).toHaveLength(1);
  });

  it("no live connection ⇒ E_THR_STATE/none without sending", async () => {
    const out = await thrPostWithRetry(() => undefined, {
      h: "fs:AAAAAAAAAAAA",
      sessionId: "s1",
      by: { runId: "r_0123456Q", label: "w1" },
      postId: "r_0123456Q:1",
      text: "hi",
    });
    expect(out).toEqual({ error: "E_THR_STATE", effect: "none" });
  });
});

describe("thrHandbackWithRetry (§5.5 #5: effect:unknown or timeout retries once after 2s)", () => {
  it("retries an effect:unknown reply once with identical parameters, then reports ok", async () => {
    const frames: unknown[] = [];
    const conn = fakeConn((frame) => {
      frames.push(frame);
      return frames.length === 1
        ? Promise.resolve(err("E_THR_STATE", "unknown"))
        : Promise.resolve(ok({ requestId: "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await thrHandbackWithRetry(
      () => conn,
      { eventId: "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", sessionId: "s1", by: "system", note: "n" },
      sleep,
    );
    expect(out).toEqual({ ok: true, requestId: "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(frames).toHaveLength(2);
    // rid is the per-attempt correlation id (newAdminRid); every BUSINESS field is identical.
    const strip = (f: unknown): Record<string, unknown> => {
      const { rid: _rid, ...rest } = f as Record<string, unknown>;
      return rest;
    };
    expect(strip(frames[0])).toEqual(strip(frames[1]));
  });

  it("both attempts unclear ⇒ unknown (no finding — a successor may exist)", async () => {
    const conn = fakeConn(() => Promise.resolve(err("E_THR_STATE", "unknown")));
    const out = await thrHandbackWithRetry(
      () => conn,
      { eventId: "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", sessionId: "s1", by: "system", note: "n" },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(out).toEqual({ unknown: true });
  });

  it("E_THR_HANDBACK_GONE is definitive (effect none — no retry)", async () => {
    const calls: number[] = [];
    const conn = fakeConn(() => {
      calls.push(1);
      return Promise.resolve(err("E_THR_HANDBACK_GONE", "none"));
    });
    const out = await thrHandbackWithRetry(
      () => conn,
      { eventId: "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", sessionId: "s1", by: "system", note: "n" },
      vi.fn(),
    );
    expect(out).toEqual({ error: "E_THR_HANDBACK_GONE", effect: "none" });
    expect(calls).toHaveLength(1);
  });
});

const baseOps = (over: Partial<ThreadChildOps> = {}): ThreadChildOps => ({
  disposed: () => false,
  listForRun: () => [],
  activeSubOf: () => undefined,
  lastEventOf: () => undefined,
  unsubscribe: () => ({ ok: false as const, reason: "no_subscription" }),
  requestHandback: () => ({ ok: false as const, reason: "window_expired" }),
  markHandback: () => ({ degrade: "none" as const }),
  noteRevokedHandback: () => undefined,
  sendHandbackFinding: () => undefined,
  recordReply: () => undefined,
  hubCapable: () => true,
  sessionId: () => "s1",
  conn: () => undefined,
  ...over,
});

const runTool = async (tool: ReturnType<typeof createThreadChildTool>, params: unknown): Promise<string> => {
  const out = await tool.execute("tc1", params as never, undefined, undefined, {} as never);
  return (out as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;
};

describe("thread child tool (§5.5/§6.8 surface)", () => {
  it("disposed host stack ⇒ E_THREAD_DISPOSED", async () => {
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops: baseOps({ disposed: () => true }) });
    expect(await runTool(tool, { action: "list" })).toContain("E_THREAD_DISPOSED");
  });

  it("reply without an ACTIVE subscription ⇒ E_THREAD_UNKNOWN, postId never consumed", async () => {
    const request = vi.fn();
    const ops = baseOps({ conn: () => fakeConn(request as never) });
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops });
    expect(await runTool(tool, { action: "reply", h: "fs:AAAAAAAAAAAA", text: "x" })).toContain("E_THREAD_UNKNOWN");
    expect(request).not.toHaveBeenCalled();
  });

  it("reply posts with postId <runId>:<seq> and records the reply on success", async () => {
    const recordReply = vi.fn();
    const seen: Array<{ postId?: string; by?: unknown }> = [];
    const ops = baseOps({
      activeSubOf: () => ({ subId: "t1", scope: "s" }),
      recordReply,
      conn: () =>
        fakeConn((frame) => {
          seen.push(frame as { postId?: string; by?: unknown });
          return Promise.resolve(ok({ queued: true }));
        }),
    });
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops });
    expect(await runTool(tool, { action: "reply", h: "fs:AAAAAAAAAAAA", text: "hello" })).toContain("queued");
    expect(await runTool(tool, { action: "reply", h: "fs:AAAAAAAAAAAA", text: "again" })).toContain("queued");
    expect(seen.map((f) => f.postId)).toEqual(["r_0123456Q:1", "r_0123456Q:2"]);
    expect(seen[0]!.by).toEqual({ runId: "r_0123456Q", label: "w1" });
    expect(recordReply).toHaveBeenCalledTimes(2);
  });

  it("reply body over 8 KiB ⇒ E_THR_TOO_LARGE without sending", async () => {
    const request = vi.fn();
    const ops = baseOps({ activeSubOf: () => ({ subId: "t1", scope: "s" }), conn: () => fakeConn(request as never) });
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops });
    expect(await runTool(tool, { action: "reply", h: "fs:AAAAAAAAAAAA", text: "x".repeat(8 * 1024 + 1) })).toContain(
      "E_THR_TOO_LARGE",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("handback outside the window ⇒ E_THREAD_WINDOW, hub never called", async () => {
    const request = vi.fn();
    const ops = baseOps({
      requestHandback: () => ({ ok: false as const, reason: "window_expired" }),
      lastEventOf: () => "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      conn: () => fakeConn(request as never),
    });
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops });
    expect(await runTool(tool, { action: "handback", h: "fs:AAAAAAAAAAAA", reason: "out of scope" })).toContain(
      "E_THREAD_WINDOW",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("handback GONE degrades to a finding (§5.5 #5)", async () => {
    const finding = vi.fn();
    const marked: Array<string> = [];
    const ops = baseOps({
      requestHandback: () => ({ ok: true as const }),
      markHandback: (_id, state) => {
        marked.push(state);
        return { degrade: "none" as const };
      },
      sendHandbackFinding: finding,
      lastEventOf: () => "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      conn: () => fakeConn(() => Promise.resolve(err("E_THR_HANDBACK_GONE", "none"))),
    });
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops });
    const text = await runTool(tool, { action: "handback", h: "fs:AAAAAAAAAAAA", reason: "not mine" });
    expect(text).toContain("E_THR_HANDBACK_GONE");
    expect(finding).toHaveBeenCalledOnce();
    expect(marked).toContain("gone");
  });

  it("handback REVOKED: subscription ends, NO finding", async () => {
    const finding = vi.fn();
    const revoked = vi.fn();
    const ops = baseOps({
      requestHandback: () => ({ ok: true as const }),
      sendHandbackFinding: finding,
      noteRevokedHandback: revoked,
      lastEventOf: () => "fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      conn: () => fakeConn(() => Promise.resolve(err("E_THR_REVOKED", "none"))),
    });
    const tool = createThreadChildTool({ runId: "r_0123456Q", label: "w1", ops });
    const text = await runTool(tool, { action: "handback", h: "fs:AAAAAAAAAAAA", reason: "x" });
    expect(text).toContain("E_THR_REVOKED");
    expect(finding).not.toHaveBeenCalled();
    // P4 §5.5 #5: exactly ONE host-side display entry (context-free audit line), no finding.
    expect(revoked).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith("fsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("thread main tool (§5.1 surface mapping)", () => {
  const mainOps = (over: Partial<ThreadMainOps> = {}): ThreadMainOps => ({
    list: () => "…",
    subscribe: () => ({ ok: false as const, reason: "hub_unsupported" }),
    unsubscribe: () => ({ ok: false as const, reason: "unknown_sub" }),
    origins: () => [],
    ...over,
  });
  const runMain = async (ops: ThreadMainOps, params: unknown): Promise<string> => {
    const tool = createThreadTool({ current: () => ops });
    const out = await tool.execute("tc1", params as never, undefined, undefined, {} as never);
    return (out as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;
  };

  it("no live stack ⇒ fixed off line", async () => {
    const tool = createThreadTool({ current: () => undefined });
    const out = await tool.execute("tc1", { action: "list" } as never, undefined, undefined, {} as never);
    expect((out as { content: Array<{ type: "text"; text: string }> }).content[0]!.text).toContain(
      "fabric.threads.enabled=false",
    );
  });

  it("subscribe deny reasons map to self-correcting hints", async () => {
    expect(
      await runMain(mainOps({ subscribe: () => ({ ok: false, reason: "run_not_direct" }) }), {
        action: "subscribe",
        run: "r_0123456Q",
        h: "fs:AAAAAAAAAAAA",
      }),
    ).toContain("workflow-internal / external / nested");
    expect(
      await runMain(mainOps({ subscribe: () => ({ ok: false, reason: "ambiguous_origin", detail: "a, b" }) }), {
        action: "subscribe",
        run: "r_0123456Q",
        h: "origin",
      }),
    ).toContain("several threads");
  });

  it("subscribe success names the subId and the resolved thread", async () => {
    const text = await runMain(
      mainOps({ subscribe: () => ({ ok: true, subId: "t1", created: true, h: "fs:AAAAAAAAAAAA", label: "话题" }) }),
      { action: "subscribe", run: "r_0123456Q", h: "fs:AAAAAAAAAAAA" },
    );
    expect(text).toContain("t1");
    expect(text).toContain("fs:AAAAAAAAAAAA");
    expect(text).toContain("话题");
  });
});
