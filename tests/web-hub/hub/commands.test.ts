import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CmdFrame, CmdOrigin } from "../../../src/web-hub/protocol/messages.js";
import { createCommandRouter, createFeishuCommandOrigin } from "../../../src/web-hub/hub/commands.js";
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

describe("commands router: async extension command (agent async-late channel, fix 2026-10-22)", () => {
  const asyncReply = {
    ok: true,
    data: { op: "command", kind: "extension", completion: "async", captured: true },
  };
  const lateOutput = {
    op: "command",
    kind: "extension",
    completion: "sync",
    captured: true,
    output: { entries: [{ kind: "notify", level: "info", text: "recording on" }] },
  };
  const cmdFrame = (over: Partial<CmdFrame> = {}): CmdFrame => ({
    ...promptFrame(),
    cmd: { op: "command", name: "record", args: "on" },
    ...over,
  });

  it("the provisional completion:'async' reply is NOT the final cache entry: an early queryOnly is forwarded to the agent, and cmd_late upgrades the entry so a later queryOnly carries the captured output", async () => {
    const h = harness();
    const frame = cmdFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, asyncReply);
    await expect(p).resolves.toMatchObject({ ok: true, data: { completion: "async" } });

    // queryOnly BEFORE cmd_late: the cached provisional reply must not answer "ok" — the agent's
    // ledger is still running, so the query is forwarded and the agent says so.
    const q1 = h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    const sentQ = h.conn.sent.at(-1) as { t: string; rid: string; queryOnly?: true };
    expect(sentQ.t).toBe("cmd");
    expect(sentQ.queryOnly).toBe(true);
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sentQ.rid,
      id: frame.id,
      ok: true,
      data: { op: "query", state: "running" },
    } as never);
    await expect(q1).resolves.toMatchObject({ ok: true, data: { op: "query", state: "running" } });

    // The capture window finishes: cmd_late carries the FULL result (output included).
    h.registry.onFrame(h.agentKey, {
      t: "cmd_late",
      id: frame.id,
      op: "command",
      at: h.clock.t,
      ok: true,
      data: lateOutput,
    } as never);

    // A later queryOnly is served from the upgraded entry — WITH the output, no new frame.
    const before = h.conn.sent.length;
    const q2 = await h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    expect(q2).toMatchObject({
      ok: true,
      data: { op: "query", state: "ok", result: { ok: true, data: { output: lateOutput.output } } },
    });
    expect(h.conn.sent.length).toBe(before);
  });

  it("queryOnly AFTER cmd_late without an intervening query also carries the output (the incident's exact order)", async () => {
    const h = harness();
    const frame = cmdFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, asyncReply);
    await p;
    h.registry.onFrame(h.agentKey, {
      t: "cmd_late",
      id: frame.id,
      op: "command",
      at: h.clock.t,
      ok: true,
      data: lateOutput,
    } as never);
    const q = await h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    expect(q).toMatchObject({
      ok: true,
      data: { op: "query", state: "ok", result: { ok: true, data: { output: lateOutput.output } } },
    });
  });

  it("a same-id NON-queryOnly resend inside the async window re-forwards once with retry:true (the agent ledger short-circuits, no re-execution), and cmd_late still upgrades the entry to the full result", async () => {
    const h = harness();
    const frame = cmdFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, asyncReply);
    await p;

    // Same id + same payload, NOT queryOnly, before cmd_late: the entry is \"unknown\", so the hub
    // re-forwards exactly once, marked retry — the no-double-EXECUTION guarantee is the agent
    // ledger's (`beginOrReply` \"running\" outcome, agent commands.ts), which answers the running
    // short-circuit instead of re-dispatching. Simulate that exact reply.
    const resent = h.router.request(frame, h.agentKey);
    const sentRetry = h.conn.sent.at(-1) as { t: string; rid: string; retry?: true; queryOnly?: true };
    expect(sentRetry.t).toBe("cmd");
    expect(sentRetry.retry).toBe(true);
    expect(sentRetry.queryOnly).toBeUndefined();
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sentRetry.rid,
      id: frame.id,
      ok: false,
      code: "E_DEADLINE",
      retryable: true,
      effect: "unknown",
    } as never);
    await expect(resent).resolves.toMatchObject({ ok: false, code: "E_DEADLINE", effect: "unknown" });

    // Exactly two cmd frames total (original + the retry-marked one) — a third would mean the hub
    // executed something on its own.
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(2);

    // cmd_late still upgrades the SAME entry to the authoritative result, output included.
    h.registry.onFrame(h.agentKey, {
      t: "cmd_late",
      id: frame.id,
      op: "command",
      at: h.clock.t,
      ok: true,
      data: lateOutput,
    } as never);
    const before = h.conn.sent.length;
    const q = await h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    expect(q).toMatchObject({
      ok: true,
      data: { op: "query", state: "ok", result: { ok: true, data: { output: lateOutput.output } } },
    });
    expect(h.conn.sent.length).toBe(before);
  });

  it("a BUILTIN async reply (/compact, /model) keeps the legacy final caching — their cmd_late is an upgrade, not the primary settle", async () => {
    const h = harness();
    const frame = cmdFrame({ cmd: { op: "command", name: "compact", args: "" } });
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "command", kind: "builtin", completion: "async" } });
    await expect(p).resolves.toMatchObject({ ok: true });
    const before = h.conn.sent.length;
    const q = await h.router.request({ ...frame, queryOnly: true }, h.agentKey);
    expect(q).toMatchObject({ ok: true, data: { op: "query", state: "ok" } });
    expect(h.conn.sent.length).toBe(before); // answered from cache, not forwarded
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

function recallFrame(over: Partial<CmdFrame> = {}): CmdFrame {
  return {
    t: "cmd",
    rid: "",
    id: "r".repeat(16),
    deadlineMs: 5_000,
    origin: origin(),
    cmd: { op: "recall", target: "t".repeat(16) },
    ...over,
  };
}

// web-hub-steer-recall plan §2.3 S4 / §5.8: the recall op's hub-side contract — cap admission
// (cmd.v1 + hold.v1), the exact forwarded frame shape, and the typed-result boundary
// (RecallResultDataSchema + 48 KiB byte cap) on the execution, LRU-replay and queryOnly paths.
describe("commands router: recall op (steer-recall §2.3 S4)", () => {
  it("missing hold.v1 ⇒ E_UNSUPPORTED, no frame sent, no LRU entry", async () => {
    const h = harness(["ev.v1", "cmd.v1"]); // has cmd.v1, lacks hold.v1
    const result = await h.router.request(recallFrame(), h.agentKey);
    expect(result).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(0);
    // a retry with the same id reaches the agent fresh once the agent re-hellos WITH the cap
    h.registry.register(hello({ caps: ["ev.v1", "cmd.v1", "hold.v1"] }), h.conn);
    const p2 = h.router.request(recallFrame(), h.agentKey);
    const sent = h.conn.sent.filter((f) => (f as { t: string }).t === "cmd").at(-1) as { rid: string };
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sent.rid,
      id: recallFrame().id,
      ok: true,
      data: { op: "recall", outcome: "too_late" },
    } as never);
    await expect(p2).resolves.toMatchObject({ ok: true, data: { outcome: "too_late" } });
  });

  it("with hold.v1: forwards EXACTLY {op:'recall', target}; a valid result passes through and caches", async () => {
    const h = harness(["ev.v1", "cmd.v1", "hold.v1"]);
    const frame = recallFrame();
    const p = h.router.request(frame, h.agentKey);
    const sent = h.conn.sent.filter((f) => (f as { t: string }).t === "cmd").at(-1) as CmdFrame;
    expect(sent.cmd).toEqual({ op: "recall", target: "t".repeat(16) });
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sent.rid,
      id: frame.id,
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "full body" },
    } as never);
    await expect(p).resolves.toMatchObject({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", text: "full body" },
    });
    // same id + same payload ⇒ LRU dup replays the SAME typed result, no re-send
    const retry = await h.router.request(frame, h.agentKey);
    expect(retry).toMatchObject({ ok: true, dup: true, data: { outcome: "recalled", text: "full body" } });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1);
  });

  it("a result failing RecallResultDataSchema is rewritten to E_UNSUPPORTED effect:'unknown' and cached that way", async () => {
    const h = harness(["ev.v1", "cmd.v1", "hold.v1"]);
    const frame = recallFrame();
    const p = h.router.request(frame, h.agentKey);
    const sent = h.conn.sent.filter((f) => (f as { t: string }).t === "cmd").at(-1) as CmdFrame;
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sent.rid,
      id: frame.id,
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "x", extra: 1 },
    } as never);
    const result = await p;
    expect(result).toMatchObject({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "unknown" });
    // non-retryable ⇒ cached as done; a retry replays the REWRITTEN failure
    const retry = await h.router.request(frame, h.agentKey);
    expect(retry).toMatchObject({ ok: false, code: "E_UNSUPPORTED", effect: "unknown" });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(1);
  });

  it("a recalled text over the 48 KiB byte cap is rewritten the same way (boundary included, one byte over rejected)", async () => {
    const h = harness(["ev.v1", "cmd.v1", "hold.v1"]);
    const oversized = "x".repeat(48 * 1024 + 1);
    const frame = recallFrame();
    const p = h.router.request(frame, h.agentKey);
    const sent = h.conn.sent.filter((f) => (f as { t: string }).t === "cmd").at(-1) as CmdFrame;
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sent.rid,
      id: frame.id,
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "followUp", text: oversized },
    } as never);
    await expect(p).resolves.toMatchObject({ ok: false, code: "E_UNSUPPORTED", effect: "unknown" });
  });

  it("queryOnly: an embedded recall result is validated too — a bad one is rewritten inside the query body", async () => {
    const h = harness(["ev.v1", "cmd.v1", "hold.v1"]);
    const frame = recallFrame({ queryOnly: true });
    const p = h.router.request(frame, h.agentKey);
    const sent = h.conn.sent.filter((f) => (f as { t: string }).t === "cmd").at(-1) as CmdFrame;
    expect(sent.queryOnly).toBe(true);
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: sent.rid,
      id: frame.id,
      ok: true,
      data: {
        op: "query",
        state: "ok",
        result: { ok: true, data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "" } },
      },
    } as never);
    // text:"" fails the schema's minLength — the embedded result is rewritten, the query envelope stays
    const result = await p;
    expect(result).toMatchObject({
      ok: true,
      data: { op: "query", state: "ok", result: { ok: false, code: "E_UNSUPPORTED", effect: "unknown" } },
    });
  });
  it("late cmd_result after a hub-side wait timeout: a violating recall result is rewritten BEFORE it lands in the LRU (schema / 48 KiB); a valid one is kept verbatim", async () => {
    // Verifier condition for the THIRD recall-validation site: registry.setLateResultHandler's
    // callback — the path a cmd_result takes when the hub's own wait already resolved the
    // request as `unknown`. The observable is the LRU replay (a retry reads exactly what the
    // late handler cached): a violating body must surface as the rewritten
    // E_UNSUPPORTED{effect:"unknown", message:"bad recall result"}, never the raw data.
    const h = harness(["ev.v1", "cmd.v1", "hold.v1"]);
    const mk = (last: string): CmdFrame => ({
      ...recallFrame(),
      id: `${"a".repeat(15)}${last}`,
      deadlineMs: 20, // registry wait = 20 + 1000 grace ⇒ E_DEADLINE, LRU left "unknown"
      cmd: { op: "recall", target: "t".repeat(15) + last },
    });
    const badSchema = mk("1"); // extra key ⇒ fails RecallResultDataSchema
    const overCap = mk("2"); // text one byte over the 48 KiB cap
    const valid = mk("3"); // positive control — kept verbatim
    const ps = [badSchema, overCap, valid].map((f) => h.router.request(f, h.agentKey));
    const ridOf = (id: string): string =>
      (h.conn.sent.find((f) => (f as { t: string; id?: string }).t === "cmd" && f.id === id) as { rid: string }).rid;
    // hub-side wait timeouts: all three requests reject E_DEADLINE, entries sit at "unknown"
    for (const p of ps) await expect(p).rejects.toMatchObject({ code: "E_DEADLINE" });
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(3);

    // the agent's answers arrive LATE (their rids are gone from `pending` ⇒ setLateResultHandler)
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: ridOf(badSchema.id),
      id: badSchema.id,
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text: "x", extra: 1 },
    } as never);
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: ridOf(overCap.id),
      id: overCap.id,
      ok: true,
      data: {
        op: "recall",
        outcome: "recalled",
        from: "held",
        deliver: "followUp",
        text: "x".repeat(48 * 1024 + 1),
      },
    } as never);
    h.registry.onFrame(h.agentKey, {
      t: "cmd_result",
      rid: ridOf(valid.id),
      id: valid.id,
      ok: true,
      data: { op: "recall", outcome: "too_late" },
    } as never);

    // retries replay whatever the late handler cached — the rewritten error, never the raw data
    const rewritten = {
      ok: false,
      code: "E_UNSUPPORTED",
      retryable: false,
      effect: "unknown",
      message: "bad recall result",
    };
    expect(await h.router.request(badSchema, h.agentKey)).toMatchObject(rewritten);
    expect(await h.router.request(overCap, h.agentKey)).toMatchObject(rewritten);
    expect(await h.router.request(valid, h.agentKey)).toMatchObject({
      ok: true,
      dup: true,
      data: { op: "recall", outcome: "too_late" },
    });
    // nothing was ever re-forwarded to the agent
    expect(h.conn.sent.filter((f) => (f as { t: string }).t === "cmd")).toHaveLength(3);
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

describe("commands router: peekIdempotent digest check (C3 re-review Blocker #2, plan \u00a73.4/\u00a76.3)", () => {
  it("same id + same payload \u21d2 peek reports the cached state (a real dup, http.ts may skip rate limiting)", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await p;
    expect(h.router.peekIdempotent!(origin(), h.agentKey, frame.id, frame.cmd)).toBe("done");
  });

  it("same id + DIFFERENT payload \u21d2 peek returns undefined, even though an LRU entry exists for that id (never a real dup \u2014 request() itself would reject it E_BAD_REQUEST)", async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await p;
    const differentCmd = { op: "prompt" as const, text: "different", deliver: "steer" as const };
    expect(h.router.peekIdempotent!(origin(), h.agentKey, frame.id, differentCmd)).toBeUndefined();
    // and request() with that same different payload really does reject, confirming peek's undefined matches reality
    const reused = await h.router.request({ ...frame, cmd: differentCmd }, h.agentKey);
    expect(reused).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
  });

  it("unknown id \u21d2 undefined (no LRU entry at all)", () => {
    const h = harness();
    expect(h.router.peekIdempotent!(origin(), h.agentKey, "z".repeat(16), { op: "abort" })).toBeUndefined();
  });

  it('an inflight entry with the same payload reports "inflight"', async () => {
    const h = harness();
    const frame = promptFrame();
    const p = h.router.request(frame, h.agentKey);
    expect(h.router.peekIdempotent!(origin(), h.agentKey, frame.id, frame.cmd)).toBe("inflight");
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await p;
  });
});

void vi; // referenced for future fake-timer extensions without an unused-import lint churn

describe("FA follow-up: Feishu command-ledger principal isolation", () => {
  it("legacy LAN username feishu:ou_x and bot ou_x keep independent entries for the SAME agent/id", async () => {
    const h = harness();
    const lanOrigin = origin({ listener: "lan", ip: "feishu", user: "feishu:ou_x" });
    const botOrigin = createFeishuCommandOrigin(1, "ou_x", lanOrigin.reqId);
    // The wire attribution is intentionally identical; only trusted in-process admission
    // can brand an origin for the separate top-level fsb:<gen>:<openId> ledger namespace.
    expect(JSON.parse(JSON.stringify(botOrigin))).toEqual(lanOrigin);
    const lanFrame = promptFrame({ origin: lanOrigin });
    const lan = h.router.request(lanFrame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await expect(lan).resolves.toMatchObject({ ok: true });
    expect(h.router.peekIdempotent(botOrigin, h.agentKey, lanFrame.id, lanFrame.cmd)).toBeUndefined();
    const botFrame = promptFrame({ origin: botOrigin, cmd: { op: "prompt", text: "bot body", deliver: "followUp" } });
    const bot = h.router.request(botFrame, h.agentKey);
    expect(h.conn.sent.filter((f) => f.t === "cmd")).toHaveLength(2);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await expect(bot).resolves.toMatchObject({ ok: true });
    await expect(h.router.request(lanFrame, h.agentKey)).resolves.toMatchObject({ ok: true, dup: true });
    await expect(h.router.request(botFrame, h.agentKey)).resolves.toMatchObject({ ok: true, dup: true });
    expect(h.conn.sent.filter((f) => f.t === "cmd")).toHaveLength(2);
    expect(
      h.router.peekIdempotent(createFeishuCommandOrigin(2, "ou_x", "next"), h.agentKey, botFrame.id, botFrame.cmd),
    ).toBeUndefined();
  });
  it("an HTTP/JSON origin or a chosen LAN username cannot supply the private bot brand", async () => {
    const h = harness();
    const botOrigin = createFeishuCommandOrigin(1, "ou_x", "request");
    const frame = promptFrame({ origin: botOrigin });
    const pending = h.router.request(frame, h.agentKey);
    replyLatest(h, { ok: true, data: { op: "prompt", delivery: "observed" } });
    await pending;
    for (const fake of [
      JSON.parse(JSON.stringify(botOrigin)),
      origin({ listener: "lan", user: "fsb:1:ou_x" }),
      origin({ listener: "lan", user: "feishu:ou_x" }),
    ]) {
      expect(h.router.peekIdempotent(fake, h.agentKey, frame.id, frame.cmd)).toBeUndefined();
    }
  });
});

it("origin-derived ledger keys stay hub-only and are computed before registry serialization", () => {
  const hub = readFileSync(new URL("../../../src/web-hub/hub/commands.ts", import.meta.url), "utf8");
  // Exactly the request + peek call sites derive origin principals. Both live here, not in
  // the serialized frame, and the request key is established before either forward path.
  expect(hub.match(/principalOf\(/g)).toHaveLength(3); // declaration + request + peek
  expect(hub).toContain("const principal = principalOf(frame.origin)");
  expect(hub).toContain("`${principalOf(origin)}|${agentKey}|${id}`");
  expect(hub.indexOf("const principal = principalOf(frame.origin)")).toBeLessThan(
    hub.indexOf("const entry: LruEntry =", hub.indexOf("async request(")),
  );
  const agentCommands = readFileSync(new URL("../../../src/web-hub/agent/commands.ts", import.meta.url), "utf8");
  const agentLedger = readFileSync(new URL("../../../src/web-hub/agent/ledger.ts", import.meta.url), "utf8");
  const agentIndex = readFileSync(new URL("../../../src/web-hub/agent/index.ts", import.meta.url), "utf8");
  expect(agentCommands).toContain("deps.ledger.begin(frame.id,");
  expect(agentLedger).toContain("bag.entries.get(id)");
  expect(agentLedger).not.toMatch(/origin\.(?:user|listener)/);
  expect(agentIndex).toContain("createCommandLedger()");
  expect(agentIndex).not.toMatch(/origin\.(?:user|listener)/);
});
