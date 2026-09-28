import { describe, expect, it, vi } from "vitest";
import type { CmdFrame, CmdOrigin } from "../../../src/web-hub/protocol/messages.js";
import { createCommandRouter } from "../../../src/web-hub/hub/commands.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { fakeConn, hello, memLog } from "./helpers.js";

function origin(over: Partial<CmdOrigin> = {}): CmdOrigin {
  return { listener: "loopback", ip: "127.0.0.1", reqId: "r".repeat(16), ...over };
}

function promptFrame(over: Partial<CmdFrame> = {}): CmdFrame {
  return {
    t: "cmd",
    rid: "",
    id: "a".repeat(16),
    deadlineMs: 5_000,
    origin: origin(),
    cmd: { op: "prompt", text: "hi", deliver: "steer" },
    ...over,
  };
}

function harness(caps: string[] = ["ev.v1", "cmd.v1", "dialog.v1", "command.v1"]) {
  const clock = { t: 1_000_000 };
  const log = memLog();
  const registry = createRegistry({ now: () => clock.t, log, pidAlive: () => true });
  const conn = fakeConn();
  const { agentKey } = registry.register(hello({ caps }), conn);
  const router = createCommandRouter({ registry, log, now: () => clock.t });
  return { clock, log, registry, conn, agentKey, router };
}

/** Answers the most recently sent `cmd` frame with a given result body. */
function replyLatest(h: ReturnType<typeof harness>, body: object): void {
  const sent = h.conn.sent.filter((f) => (f as { t: string }).t === "cmd");
  const last = sent.at(-1) as { rid: string; id: string };
  h.registry.onFrame(h.agentKey, { t: "cmd_result", rid: last.rid, id: last.id, ...body } as never);
}

describe("commands router: caps admission", () => {
  it("E_UNSUPPORTED when the agent never advertised the required cap \u2014 no frame sent, no LRU entry", async () => {
    const h = harness(["ev.v1"]); // no cmd.v1 at all
    const frame = promptFrame();
    const result = await h.router.request(frame, h.agentKey);
    expect(result).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(0);
    // A retry with the same id must reach the agent fresh (no LRU entry was ever created) once the
    // agent gains the capability.
    h.registry.onFrame; // no-op reference to keep import usage obvious in diffs
    const withCap = createCommandRouter({ registry: h.registry, log: h.log, now: () => h.clock.t });
    h.conn.sent.length = 0;
    // Re-register the same agentId with cmd.v1 added (simulates a reconnect with an upgraded build).
    h.registry.register(hello({ caps: ["ev.v1", "cmd.v1"] }), h.conn);
    const p2 = withCap.request(frame, h.agentKey);
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: (h.conn.sent.at(-1) as { rid: string }).rid,
      id: frame.id,
      ok: true,
      data: { op: "prompt", delivery: "observed" },
    });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("command op additionally needs command.v1; dialog ops additionally need dialog.v1", async () => {
    const h = harness(["cmd.v1"]); // missing dialog.v1/command.v1
    const cmdResult = await h.router.request(
      { ...promptFrame(), id: "b".repeat(16), cmd: { op: "command", name: "status", args: "" } },
      h.agentKey,
    );
    expect(cmdResult).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
    const dialogResult = await h.router.request(
      { ...promptFrame(), id: "c".repeat(16), cmd: { op: "dialog_cancel", dialogId: "d1", epoch: "e1" } },
      h.agentKey,
    );
    expect(dialogResult).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
  });

  it("unknown agentKey rejects with E_AGENT_GONE (thrown, not resolved \u2014 not a CmdErrorCode)", async () => {
    const h = harness();
    await expect(h.router.request(promptFrame(), "no-such-agent")).rejects.toMatchObject({ code: "E_AGENT_GONE" });
  });
});

describe("commands router: LRU three-state idempotency (\u00a73.4)", () => {
  it("success caches as done; a retry with the same id and same payload returns dup:true without re-sending", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await expect(p).resolves.toMatchObject({ ok: true, data: { delivery: "observed" } });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1);

    const retry = await h.router.request(frame, h.agentKey);
    expect(retry).toMatchObject({ ok: true, dup: true, data: { delivery: "observed" } });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1); // no re-send
  });

  it("a retryable effect:none failure is forgotten \u2014 a retry re-executes from scratch", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: false, code: "E_STALE_CTX", retryable: true, effect: "none" });
    await expect(p).resolves.toMatchObject({ ok: false, code: "E_STALE_CTX" });

    const retry = h.router.request(frame, h.agentKey);
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(2); // re-sent
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await expect(retry).resolves.toMatchObject({ ok: true });
  });

  it("a non-retryable failure is cached as done (dup on retry)", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: false, code: "E_SESSION_CHANGED", retryable: false, effect: "none" });
    await expect(p).resolves.toMatchObject({ ok: false, code: "E_SESSION_CHANGED" });
    const retry = await h.router.request(frame, h.agentKey);
    expect(retry).toMatchObject({ ok: false, code: "E_SESSION_CHANGED" });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1);
  });

  it("same id, different payload \u21d2 E_BAD_REQUEST (id reused), original entry untouched", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    const reused = await h.router.request(
      { ...frame, cmd: { op: "prompt", text: "different", deliver: "steer" } },
      h.agentKey,
    );
    expect(reused).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it("concurrent requests with the same id share the single in-flight result (only one frame sent)", async () => {
    const h = harness();
    const frame = promptFrame();
    const p1 = h.router.request(frame, h.agentKey);
    const p2 = h.router.request(frame, h.agentKey);
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ ok: true });
    expect(r2).toMatchObject({ ok: true, dup: true });
  });
});

describe("commands router: effect classification / \u00a73.5 assertions", () => {
  it("assertion 5: agent_down while in-flight \u21d2 the pending request rejects E_AGENT_GONE (unknown effect surfaces via the router's own state, retryable decided by the caller from registry.get)", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    expect(h.registry.get(h.agentKey)).toBeDefined();
    h.registry.onClose(h.agentKey, false);
    h.clock.t += 100_000; // past detachGrace + reap
    h.registry.tick(h.clock.t);
    expect(h.registry.get(h.agentKey)).toBeUndefined(); // fully down now
    await expect(p).rejects.toMatchObject({ code: "E_AGENT_GONE" });
  });

  it("assertion 6: a late cmd_result (registry wait already expired) upgrades the LRU from unknown to done; a subsequent retry never re-forwards", async () => {
    const h = harness();
    const frame = { ...promptFrame(), deadlineMs: 20 };
    const p = h.router.request(frame, h.agentKey);
    await expect(p).rejects.toMatchObject({ code: "E_DEADLINE" }); // hub-side wait timeout: rejects, not a resolved CmdResultBody
    // The registry's own wait already timed out and cleared its pending map; the agent's answer
    // now arrives "late" (same rid is gone from `pending`, but registry.onFrame still routes it).
    const sentRid = (h.conn.sent.find((f) => (f as { t: string }).t === "cmd") as { rid: string }).rid;
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sentRid,
      id: frame.id,
      ok: true,
      data: { op: "prompt", delivery: "observed" },
    });
    const retry = await h.router.request(frame, h.agentKey);
    expect(retry).toMatchObject({ ok: true, dup: true, data: { delivery: "observed" } });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1); // never re-forwarded
  });
});

describe("commands router: queryOnly (\u00a73.4)", () => {
  it("done entry \u21d2 answered directly, no frame sent", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await p;
    const before = h.conn.sent.length;
    const q = await h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    expect(q).toMatchObject({ ok: true, data: { op: "query", state: "ok" } });
    expect(h.conn.sent.length).toBe(before); // no new frame
  });

  it("inflight entry \u21d2 answered state:running without touching the agent", async () => {
    const h = harness();
    const frame = promptFrame();
    void h.router.request(frame, h.agentKey);
    const before = h.conn.sent.length;
    const q = await h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    expect(q).toMatchObject({ ok: true, data: { op: "query", state: "running" } });
    expect(h.conn.sent.length).toBe(before);
  });

  it("no entry \u21d2 forwarded to the agent as queryOnly; E_UNKNOWN_ID leaves nothing cached", async () => {
    const h = harness();
    const frame = { ...promptFrame(), queryOnly: true as const };
    const p = h.router.request(frame, h.agentKey);
    const sent = h.conn.sent.at(-1) as { t: string; rid: string; queryOnly?: true };
    expect(sent.t).toBe("cmd");
    expect(sent.queryOnly).toBe(true);
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sent.rid,
      id: frame.id,
      ok: false,
      code: "E_UNKNOWN_ID",
      retryable: false,
      effect: "none",
    });
    await expect(p).resolves.toMatchObject({ ok: false, code: "E_UNKNOWN_ID" });
  });
});

describe("commands router: drain (v2.1 \u00a76.7.3)", () => {
  it("after drain() is called, a fresh request is rejected E_HUB_RESTARTING before any frame is sent and no LRU entry is built", async () => {
    const h = harness();
    void h.router.drain();
    const frame = promptFrame();
    const result = await h.router.request(frame, h.agentKey);
    expect(result).toMatchObject({ ok: false, code: "E_HUB_RESTARTING", retryable: true, effect: "none" });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(0);
  });

  it("drain() resolves once in-flight requests settle, and reports inflight()", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    expect(h.router.inflight()).toBe(1);
    const drainP = h.router.drain();
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await p;
    await expect(drainP).resolves.toEqual({ inflight: 0, timedOut: false });
    expect(h.router.inflight()).toBe(0);
  });
});

describe("commands router: audit (U7 \u2014 no body content)", () => {
  it("never logs prompt text, command args, or their hashes", async () => {
    const h = harness();
    const secretText = "the quick brown fox jumps over the lazy dog SECRET";
    const frame = { ...promptFrame(), cmd: { op: "prompt" as const, text: secretText, deliver: "steer" as const } };
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await p;
    const dump = JSON.stringify(h.log.lines);
    expect(dump).not.toContain(secretText);
    expect(dump).not.toContain("SECRET");
    const sha = await import("node:crypto").then((c) => c.createHash("sha256").update(secretText).digest("hex"));
    expect(dump).not.toContain(sha);
  });
});

describe("commands router: output byte budget (v2.1 \u00a74.9)", () => {
  it("truncates an oversized CommandOutputWire before caching/returning it", async () => {
    const h = harness();
    const frame = { ...promptFrame(), id: "d".repeat(16), cmd: { op: "command" as const, name: "status", args: "" } };
    const p = h.router.request(frame, h.agentKey);
    const bigText = "x".repeat(30 * 1024);
    replyLatest(h, {
      ok: true,
      data: {
        op: "command",
        kind: "builtin",
        completion: "sync",
        output: {
          entries: [
            { kind: "text", text: bigText },
            { kind: "text", text: bigText },
          ],
        },
      },
    });
    const result = await p;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data as {
      op: "command";
      output?: { entries: unknown[]; truncated?: { droppedEntries: number } };
    };
    expect(data.output!.entries.length).toBeLessThan(2);
    expect(data.output!.truncated?.droppedEntries).toBeGreaterThan(0);
  });
});

void vi; // referenced for future fake-timer extensions without an unused-import lint churn
