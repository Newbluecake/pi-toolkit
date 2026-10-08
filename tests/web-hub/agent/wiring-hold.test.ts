/**
 * Assembly-level hold wiring for web-hub-steer-recall (plan §4.7 A6, §9 anchor `wiring-hold`:
 * W1–W11). Everything here drives the REAL `wireWebHub` assembly — real command handler, real
 * hold driver, real hold buffer (the process `Symbol.for` bag), real ledger — over scriptable
 * fake sockets (`fakeNet`), the same harness style as `wiring.test.ts`'s todo/worktree/
 * bash-jobs slot describes. The driver's own state machine (phases, B1, hooks) is P-core's
 * `hold-driver.test.ts`; this file only proves the WIRING: gate truth table, handler ownership,
 * projection gating (D3), cap advertisement, the TUI marker, session boundaries and the
 * connection-state republish rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, WEB_HUB_STATUS_KEY, statusLineText, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame, CmdFrame } from "../../../src/web-hub/protocol/messages.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

const HOLD_BAG_KEY = Symbol.for("pi-subagent:web-hub:hold-buffer");
const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-hold-");
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY];
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY];
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

const HOLD_ACK_CAPS = ["cmd.v1", "hold.v1"];

function cmdFrame(id: string, cmd: CmdFrame["cmd"]): AgentFrame & { t: "cmd" } {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" },
    cmd,
  } as AgentFrame & { t: "cmd" };
}

function promptCmd(id: string, text: string, deliver: "steer" | "followUp" = "steer") {
  return cmdFrame(id, { op: "prompt", text, deliver });
}

function recallCmd(id: string, target: string) {
  return cmdFrame(id, { op: "recall", target });
}

type Socket = ReturnType<typeof fakeNet>["sockets"][number];

/** The fake ctx's hardcoded cwd (/tmp/wa) doesn't exist — git spawns against it would race the
 * worktree sampler's hard deadline under long fake-timer advances and surface as an unhandled
 * spawn ENOENT; point the sampler at a real (non-repo) directory instead. */
function ctxIn(p: { dir: string }, init: Partial<ReturnType<typeof fakeCtx>["state"]> = {}) {
  const c = fakeCtx(init);
  (c.ctx as unknown as { cwd: string }).cwd = p.dir;
  return c;
}

/** session_start → connect → hello_ack(caps) → live; returns the agent's socket. */
async function goLive(
  n: ReturnType<typeof fakeNet>,
  fire: ReturnType<typeof fakePi>["fire"],
  ctx: ReturnType<typeof fakeCtx>["ctx"],
  caps: string[] = HOLD_ACK_CAPS,
): Promise<Socket> {
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await vi.advanceTimersByTimeAsync(0);
  const s = n.sockets[0]!;
  s.emit("connect");
  await vi.advanceTimersByTimeAsync(0);
  s.hub(ackFrame("a1-holdaaa", 4242, caps));
  await vi.advanceTimersByTimeAsync(0);
  return s;
}

/** Drain vi's timer queue plus pending microtask chains (hello/buildInfo promises). */
async function drain(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
}

const statusFrames = (s: Socket) => s.frames().filter((f) => f.t === "status");
const ctlFrames = (s: Socket) => s.frames().filter((f) => f.t === "ctl");
const resultFrames = (s: Socket, id: string) =>
  s.frames().filter((f) => f.t === "cmd_result" && (f as { id?: string }).id === id);

function holdBagItems(): Map<string, { owner?: string; sessionId?: string; state?: string }> {
  const bag = (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY] as
    { items: Map<string, { owner?: string; sessionId?: string; state?: string }> } | undefined;
  return bag?.items ?? new Map();
}

// ---------------------------------------------------------------------------
// W1 — steerRecall off (or control off): no hold.v1 cap, zero new handlers
// ---------------------------------------------------------------------------
describe("W1 — holdWired gate: caps + handler registration", () => {
  const HOLD_EVENTS = ["context", "turn_start", "turn_end", "agent_end", "agent_settled"];

  it("steerRecall:false ⇒ hello caps carry no hold.v1; exactly zero hold handlers registered", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect, settings: { ...SETTINGS, steerRecall: false } }));
    const { ctx } = ctxIn(tmp, { mode: "tui" });
    const s = await goLive(n, fire, ctx);
    const hello = s.frames().find((f) => f.t === "hello") as { caps?: string[] };
    expect(hello.caps).not.toContain("hold.v1");
    // Off-state baselines: `context` has NO other registrant (0); turn_start/turn_end/agent_end/
    // agent_settled each carry exactly the FORWARDED-loop handler (1); input carries exactly the
    // FORWARDED-loop observer. Zero NEW handlers — that is W1's whole claim.
    expect(handlers.get("context") ?? []).toHaveLength(0);
    for (const ev of ["turn_start", "turn_end", "agent_end", "agent_settled"])
      expect(handlers.get(ev) ?? [], ev).toHaveLength(1);
    expect(handlers.get("input") ?? []).toHaveLength(1); // the FORWARDED-loop observer only
  });

  it("control:false also kills the cap (holdWired truth table row)", async () => {
    const n = fakeNet();
    const { pi, fire, handlers } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect, settings: { ...SETTINGS, control: false } }));
    const { ctx } = ctxIn(tmp, { mode: "tui" });
    const s = await goLive(n, fire, ctx);
    const hello = s.frames().find((f) => f.t === "hello") as { caps?: string[] };
    expect(hello.caps).not.toContain("hold.v1");
    expect(handlers.get("context") ?? []).toHaveLength(0);
  });

  it("default (unset) ⇒ hold.v1 advertised and exactly +1 handler on each hold event", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const { ctx } = ctxIn(tmp, { mode: "tui" });
    const s = await goLive(n, fire, ctx);
    const hello = s.frames().find((f) => f.t === "hello") as { caps?: string[] };
    expect(hello.caps).toContain("hold.v1");

    const base = fakePi();
    wireWebHub(base.pi, deps({ netConnect: fakeNet().netConnect, settings: { ...SETTINGS, steerRecall: false } }));
    for (const ev of HOLD_EVENTS) {
      expect(handlers.get(ev)?.length ?? 0, ev).toBe((base.handlers.get(ev)?.length ?? 0) + 1);
    }
    expect(handlers.get("input")!.length).toBe(base.handlers.get("input")!.length); // no input barrier (Q2)
  });
});

// ---------------------------------------------------------------------------
// W2 — steerRecall off ⇒ outbound frames carry none of the hold vocabulary
// ---------------------------------------------------------------------------
describe("W2 — off ⇒ byte-identical outbound frames (no hold.v1 / held / heldRev / heldEpoch)", () => {
  it("a full session cycle never mentions hold on the wire", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect, settings: { ...SETTINGS, steerRecall: false } }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx);
    fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w2-prompt-00000010", "native while hold off"));
    await drain();
    fire(
      "turn_end",
      { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, outcome: "completed" },
      c.ctx,
    );
    await drain();
    expect(sentUserMessages).toHaveLength(1); // native path, never held
    const hello = s.frames().find((f) => f.t === "hello") as { caps?: string[] };
    expect(hello.caps).not.toContain("hold.v1");
    for (const f of s.frames()) {
      expect(JSON.stringify(f)).not.toContain("held");
      expect(JSON.stringify(f)).not.toContain("hold.v1");
    }
    const reply = resultFrames(s, "w2-prompt-00000010")[0] as { data?: { delivery?: string } };
    expect(reply?.data?.delivery).not.toBe("held");
  });
});

// ---------------------------------------------------------------------------
// W3 — on, but the hub has no hold.v1 ⇒ holdCap() false ⇒ native dispatch
// ---------------------------------------------------------------------------
describe("W3 — feature on, hub without the cap ⇒ prompts take the native path", () => {
  it("prompt while armed+busy still goes straight to sendUserMessage, no held rows", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx, ["cmd.v1"]); // live, but NO hold.v1
    fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w3-prompt-00000010", "native because no cap"));
    await drain();
    expect(sentUserMessages).toHaveLength(1);
    const reply = resultFrames(s, "w3-prompt-00000010")[0] as { data?: { delivery?: string } };
    expect(reply?.data?.delivery).not.toBe("held");
    for (const f of statusFrames(s)) expect("held" in f).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W4 — statusLineText without extra is unchanged (full matrix in ui-status.test.ts)
// ---------------------------------------------------------------------------
describe("W4 — statusLineText extra invariance", () => {
  it("no extra ⇒ pre-feature strings, byte for byte", () => {
    expect(statusLineText({ state: "live", attached: true } as never)).toBe("web ●");
    expect(statusLineText({ state: "connecting", attached: true } as never)).toBe("web ○");
    expect(statusLineText({ state: "off", attached: false } as never)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W5 — session boundaries: no handler re-registration, adopt/returnSession wired
// ---------------------------------------------------------------------------
describe("W5 — /new・/resume・/fork・/reload: handler ownership + adopt", () => {
  it("repeated session_start never re-registers handlers (wireWebHub is the single owner)", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const a = ctxIn(tmp, { mode: "tui" });
    const b = ctxIn(tmp, { mode: "tui", sessionId: "sess-2" });
    const counts = () =>
      ["context", "turn_start", "turn_end", "agent_end", "agent_settled", "input"].map(
        (ev) => (handlers.get(ev) ?? []).length,
      );
    fire("session_start", { type: "session_start", reason: "startup" }, a.ctx);
    await goLive(n, fire, a.ctx); // registers once at wireWebHub time; counts below pin that
    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, a.ctx);
    fire("session_start", { type: "session_start", reason: "new" }, b.ctx);
    fire("session_shutdown", { type: "session_shutdown", reason: "resume" }, b.ctx);
    fire("session_start", { type: "session_start", reason: "resume" }, a.ctx);
    expect(counts()).toEqual([1, 2, 2, 2, 2, 1]); // +1 context vs FORWARDED baseline; turn_* ×2 = loop + hold
  });

  it("/new ⇒ held item returned{session} and still visible as a returned row for the next session", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const a = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, a.ctx);
    fire("context", { type: "context" }, a.ctx);
    s.hub(promptCmd("w5-hold-0000000100", "held across /new"));
    await drain();
    expect(sentUserMessages).toHaveLength(0);
    expect(statusFrames(s).at(-1)).toMatchObject({ held: [expect.objectContaining({ state: "held" })] });

    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, a.ctx);
    const b = ctxIn(tmp, { mode: "tui", sessionId: "sess-2", idle: false });
    fire("session_start", { type: "session_start", reason: "new" }, b.ctx);
    await drain(20);
    const last = statusFrames(s).at(-1) as { held?: Array<{ state: string; reason?: string }> };
    expect(last.held).toEqual([expect.objectContaining({ state: "returned", reason: "session" })]);
  });

  it("reload adopt: a foreign-owner leftover held item becomes returned{reload} on the next session_start", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const a = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, a.ctx);
    fire("context", { type: "context" }, a.ctx);
    s.hub(promptCmd("w5-adopt-000000100", "stale leftover"));
    await drain();
    // Simulate the pre-/reload instance's leftover: foreign owner AND a session id no live
    // session owns (its session_shutdown never ran — the defensive path adopt exists for).
    const item = holdBagItems().get("w5-adopt-000000100") as { owner: string; sessionId: string };
    item.owner = "old-instance";
    item.sessionId = "sess-old";
    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, a.ctx);
    const b = ctxIn(tmp, { mode: "tui", sessionId: "sess-2", idle: false });
    fire("session_start", { type: "session_start", reason: "new" }, b.ctx);
    await drain(20);
    const last = statusFrames(s).at(-1) as { held?: Array<{ state: string; reason?: string }> };
    expect(last.held).toEqual([expect.objectContaining({ state: "returned", reason: "reload" })]);
  });
});

// ---------------------------------------------------------------------------
// W6 — live onStateChange republish: status/ctl projected per the CURRENT link
// ---------------------------------------------------------------------------
describe("W6 — reconnect republish (§4.7 step 9)", () => {
  it("held row + `web held N` marker appear; republish after reconnect carries the held row", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx);
    fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w6-hold-0000000100", "held over a reconnect"));
    await drain();
    expect(statusFrames(s).at(-1)).toMatchObject({
      held: [expect.objectContaining({ cmdId: "w6-hold-0000000100", state: "held" })],
      heldEpoch: expect.any(String),
      heldRev: expect.any(Number),
    });
    expect(c.state.statusCalls).toContainEqual([WEB_HUB_STATUS_KEY, "web held 1"]); // arch §11.1 literal

    const before = statusFrames(s).length;
    s.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(700); // past the 0.5s±20% backoff
    const s2 = n.sockets.at(-1)!;
    expect(s2).not.toBe(s);
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-holdaaa", 4242, HOLD_ACK_CAPS));
    await drain(12);
    // step 9: the fresh live link got the CURRENT projections — the held row survived (D3:
    // status.held is gated on holdWired, not on the transient link state).
    const replayed = statusFrames(s2).at(-1) as { held?: unknown[] };
    expect(replayed.held).toEqual([expect.objectContaining({ cmdId: "w6-hold-0000000100", state: "held" })]);
    expect(statusFrames(s2).length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    // recall still works after the republish — full text comes back
    s2.hub(recallCmd("w6-recall-00000010", "w6-hold-0000000100"));
    await drain();
    const rr = resultFrames(s2, "w6-recall-00000010")[0] as { ok?: boolean; data?: Record<string, unknown> };
    expect(rr).toMatchObject({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", text: "held over a reconnect" },
    });
    expect(c.state.statusCalls).toContainEqual([WEB_HUB_STATUS_KEY, "web ●"]); // 1 → 0 back to the plain marker
  });
});

// ---------------------------------------------------------------------------
// W7 — hub replaced by one WITHOUT the cap: ctl filters immediately, 15 s ⇒ hand out
// ---------------------------------------------------------------------------
describe("W7 — no-cap hub: projection filter + 15 s cap grace", () => {
  it("ctl hides the held row right after live; the tick hands the item to pi once the grace lapses", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx);
    fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w7-hold-0000000100", "held when the hub loses the cap"));
    await drain();

    s.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(700);
    const s2 = n.sockets.at(-1)!;
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-holdaaa", 4242, ["cmd.v1"])); // live, no hold.v1
    await drain(12);
    // step 11 (filterHeld): a no-cap hub's CLOSED ctl schema must never be LEFT with a
    // state:"held" row. D3's exact sequence on a no-cap reconnect: the pre-notify slot REPLAY
    // still carries the full projection (that is by design — the slot was stored while
    // disconnected), and the live republish immediately replaces it with the filtered one.
    const ctlOn = (sock: Socket) => ctlFrames(sock) as Array<{ items?: Array<{ state?: string }> }>;
    const lastCtl = ctlOn(s2).at(-1)!;
    expect(lastCtl.items).toBeDefined();
    for (const it of lastCtl.items ?? []) expect(it.state).not.toBe("held");
    const heldIdx = ctlOn(s2).findIndex((f) => (f.items ?? []).some((it) => it.state === "held"));
    expect(heldIdx).toBeGreaterThanOrEqual(0); // the replay came first…
    expect(ctlOn(s2).length - 1).toBeGreaterThan(heldIdx); // …and the filtered republish followed
    // status is NOT cap-gated (D3) — the row is still there, shown as unavailable by the UI
    expect(statusFrames(s2).at(-1)).toMatchObject({ held: [expect.objectContaining({ state: "held" })] });

    await vi.advanceTimersByTimeAsync(16_000); // ≥ HOLD_CAP_GRACE_MS of ticks with a busy ctx
    await drain(4);
    expect(sentUserMessages).toEqual([expect.objectContaining({ text: "held when the hub loses the cap" })]); // handed out exactly once
    const lastStatus = statusFrames(s2).at(-1) as { held?: unknown[] };
    expect(lastStatus.held).toBeUndefined(); // handed off ⇒ no more held rows
  });
});

// ---------------------------------------------------------------------------
// W8 — disconnect < 15 s, same-cap hub back: held untouched, republish on live
// ---------------------------------------------------------------------------
describe("W8 — brief disconnect (< 15 s): held items unaffected", () => {
  it("reconnect within the grace window: nothing dispatched, republish carries the row, recall works", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx);
    fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w8-hold-0000000100", "brief outage"));
    await drain();

    s.fail("ECONNRESET");
    // First retry lands at ~0.5–0.7 s (0.5s±20% backoff); a longer blind advance would let the
    // 1 s connect-timeout abandon sockets. Still comfortably inside the 15 s grace.
    await vi.advanceTimersByTimeAsync(700);
    expect(sentUserMessages).toHaveLength(0); // never handed out during the outage
    const s2 = n.sockets.at(-1)!;
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-holdaaa", 4242, HOLD_ACK_CAPS));
    await drain(12);
    expect(statusFrames(s2).at(-1)).toMatchObject({ held: [expect.objectContaining({ state: "held" })] });
    s2.hub(recallCmd("w8-recall-00000010", "w8-hold-0000000100"));
    await drain();
    const rr = resultFrames(s2, "w8-recall-00000010")[0] as { data?: Record<string, unknown> };
    expect(rr?.data).toMatchObject({ outcome: "recalled", text: "brief outage" });
  });
});

// ---------------------------------------------------------------------------
// W9 — a prompt that arrives while holding is impossible is never held
// ---------------------------------------------------------------------------
describe("W9 — prompts during a link outage take the native path, never the buffer", () => {
  it("link down: a cmd frame on the dead socket never holds or dispatches; after reconnect (no cap) the retry goes native", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx);
    fire("context", { type: "context" }, c.ctx);
    s.fail("ECONNRESET"); // link down BEFORE the frame — the connection drops it
    s.hub(promptCmd("w9-prompt-00000010", "arrives during the outage"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentUserMessages).toHaveLength(0);
    expect(holdBagItems().size).toBe(0); // neither held nor anything else

    await vi.advanceTimersByTimeAsync(700);
    const s2 = n.sockets.at(-1)!;
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-holdaaa", 4242, ["cmd.v1"])); // still no cap while shaken
    await drain(4);
    fire("context", { type: "context" }, c.ctx);
    s2.hub(promptCmd("w9-prompt-00000020", "retry once live"));
    await drain();
    expect(sentUserMessages).toEqual([expect.objectContaining({ text: "retry once live" })]);
    const last = statusFrames(s2).at(-1) as { held?: unknown[] };
    expect(last.held).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W10 — outage ≥ 15 s: the tick hands out (busy) or returns (session mismatch)
// ---------------------------------------------------------------------------
describe("W10 — ≥ 15 s outage: tick flush", () => {
  it("busy ctx ⇒ handed to pi exactly once per tick (I-SERIAL), the rest stays held", async () => {
    const n = fakeNet();
    const a = fakePi();
    wireWebHub(a.pi, deps({ netConnect: n.netConnect }));
    const busy = ctxIn(tmp, { mode: "tui", idle: false });
    const s1 = await goLive(n, a.fire, busy.ctx);
    a.fire("context", { type: "context" }, busy.ctx);
    s1.hub(promptCmd("w10-busy-0000010", "handed out by the tick"));
    s1.hub(promptCmd("w10-busy-0000020", "second held item"));
    await drain();
    expect(statusFrames(s1).at(-1)).toMatchObject({ held: [expect.anything(), expect.anything()] });

    s1.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(16_000); // ≥ HOLD_CAP_GRACE_MS of ticks while busy
    await drain(6);
    expect(a.sentUserMessages.map((m) => m.text)).toEqual(["handed out by the tick"]); // ONE per tick
    expect(holdBagItems().get("w10-busy-0000020")).toMatchObject({ state: "held" }); // still recallable
  });

  it("a settled run with a leftover held item returns it (zero dispatches) — M11/D-LEFTOVER", async () => {
    const n = fakeNet();
    const b = fakePi();
    wireWebHub(b.pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, b.fire, c.ctx);
    b.fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w10-mis-000000010", "leftover at settle"));
    await drain();
    // The run settles with the item still buffered (the defensive branch: settle never dispatches)
    b.fire("agent_settled", { type: "agent_settled" }, c.ctx);
    await drain(4);
    expect(b.sentUserMessages).toHaveLength(0); // ZERO sendUserMessage — returned, never auto-sent
    expect(holdBagItems().get("w10-mis-000000010")).toMatchObject({ state: "returned", reason: "stale" });
    const last = statusFrames(s).at(-1) as { held?: Array<{ state?: string; reason?: string }> };
    expect(last.held).toEqual([expect.objectContaining({ state: "returned", reason: "stale" })]);
  });
});

describe("W11 — non-live transitions don't republish", () => {
  it("connect→fail (backoff): no new status/ctl frames beyond the tick's (static) baseline", async () => {
    const n = fakeNet();
    const { pi, fire, handlers, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false });
    const s = await goLive(n, fire, c.ctx);
    fire("context", { type: "context" }, c.ctx);
    s.hub(promptCmd("w11-hold-000000100", "held while the link sags"));
    await drain();
    const statusBefore = statusFrames(s).length;
    const ctlBefore = ctlFrames(s).length;
    s.fail("ECONNRESET"); // backoff — onStateChange fires with a NON-live view
    await vi.advanceTimersByTimeAsync(3_000); // ticks keep running but nothing changes
    expect(statusFrames(s)).toHaveLength(statusBefore);
    expect(ctlFrames(s)).toHaveLength(ctlBefore);
  });
});

// ---------------------------------------------------------------------------
// v4.3 Y3 / T-REF — the confirm phase's timers are REF'd; the wiring's own timers unref'd
// ---------------------------------------------------------------------------
describe("Y3 — timer ref policy (T-REF)", () => {
  it("the 200 ms confirm timer is ref'd; the 1 Hz tick interval is unref'd", async () => {
    vi.useRealTimers(); // real timers so setTimeout/setInterval return real Timeout handles
    const n = fakeNet();
    const { pi, fire, sentUserMessages } = fakePi();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    const c = ctxIn(tmp, { mode: "tui", idle: false, pending: false });

    const timeouts: Array<{ delay: number; handle: unknown }> = [];
    const intervals: Array<{ handle: unknown }> = [];
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realSetInterval = globalThis.setInterval.bind(globalThis);
    const sto = vi.spyOn(globalThis, "setTimeout");
    const si = vi.spyOn(globalThis, "setInterval");
    sto.mockImplementation(((fn: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
      const handle = realSetTimeout(fn as () => void, delay, ...(rest as []));
      timeouts.push({ delay: delay ?? 0, handle });
      return handle;
    }) as typeof setTimeout);
    si.mockImplementation(((fn: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
      const handle = realSetInterval(fn as () => void, delay, ...(rest as []));
      intervals.push({ handle });
      return handle;
    }) as typeof setInterval);

    try {
      // session_start AFTER the spies: the wiring's own 1 Hz tick interval gets captured at creation
      fire("session_start", { type: "session_start", reason: "startup" }, c.ctx);
      await new Promise((r) => setTimeout(r, 5));
      const s = n.sockets[0]!;
      s.emit("connect");
      await new Promise((r) => setTimeout(r, 1));
      s.hub(ackFrame("a1-holdaaa", 4242, HOLD_ACK_CAPS));
      await new Promise((r) => setTimeout(r, 5));
      fire("context", { type: "context" }, c.ctx);
      s.hub(promptCmd("y3-hold-0000000001", "confirm phase timer"));
      await new Promise((r) => setTimeout(r, 5));
      expect(sentUserMessages).toHaveLength(0); // held, not dispatched
      fire(
        "turn_end",
        { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, outcome: "completed" },
        c.ctx,
      );
      // The dispatch happened synchronously inside the handler; the confirm phase's ≤200 ms cap
      // timer (HANDOFF_CONFIRM_MS) is now armed through setRefTimer…
      const confirmTimers = timeouts.filter((t) => t.delay === 200);
      expect(confirmTimers.length).toBeGreaterThanOrEqual(1);
      for (const t of confirmTimers) expect((t.handle as { hasRef(): boolean }).hasRef()).toBe(true); // …REF'd (Y3)
      expect(intervals.length).toBeGreaterThanOrEqual(1); // the 1 Hz tick…
      for (const i of intervals) expect((i.handle as { hasRef(): boolean }).hasRef()).toBe(false); // …unref'd (pi -p)
      expect(sentUserMessages).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 260)); // ≤200 ms confirm bound + slack
    } finally {
      sto.mockRestore();
      si.mockRestore();
    }
  });
});
