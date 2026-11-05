import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import {
  XS_ASK_MARGIN_MS,
  XS_ASK_REDIRECT_INSTRUCTIONS,
  classifyAskSend,
  createXsAskRedirect,
  xsAskRedirectHeader,
  type AskUserRedirectResult,
  type XsAskRedirect,
  type XsAskRedirectDeps,
  type XsAskRedirectSendArgs,
} from "../../src/fabric/xs/ask-redirect.js";
import type { XsSendOutcome, XsSendStatus } from "../../src/fabric/xs/sender.js";
import type { XsWakeDowngraded } from "../../src/web-hub/protocol/xs.js";
import { DEFAULT_FABRIC_SETTINGS, parseFabricXsAskRedirectSettings } from "../../src/fabric/settings.js";

/**
 * #21 plan §3 T4–T10 (B1 half): the ask redirect core — O/U classification (D2), admission and
 * per-token serialisation (D4), the two absolute deadlines (D5), the call state machine and
 * cancellation (D6), send-outcome classification incl. the exhaustive matrix (D7/M8), the D8
 * header/budget and the cross-reload ledger persistence (T6). The fake send mirrors the REAL
 * sender's contract: the ticket issue (with the [60, maxTimeoutS] clamp) is synchronous with
 * `onIssued`, the receipt arrives a microtask later.
 */

const SID = "sess-askred-0123456789a";
const REQ = "sess-req-00000009abcdef0";
const TOKEN = "wake-token-1";
const XID = "xid-delegate-1";
const ORIGIN_REQ = "q0000000000000000aa"; // q + 18 hex
const T0 = 1_000_000;
const PAIR_MS = 30_000;

let qSeq = 0;
const nextQ2 = (): string => `q${(++qSeq + 0x10).toString(16).padStart(18, "0")}`;

interface UnitRig {
  redirect: XsAskRedirect;
  clock: FakeClock;
  ledger: XsWakeLedger;
  controller: { state: string; activeToken: string | undefined };
  state: { attached: boolean; hop: boolean };
  sends: XsAskRedirectSendArgs[];
  /** q2 ids the fake sender issued, in send order. */
  issued: string[];
  setSend(impl: (args: XsAskRedirectSendArgs) => Promise<XsSendOutcome | undefined>): void;
}

interface RigOptions {
  origin?: { requesterSessionId?: string; requestId?: string; dueAt?: number } | null;
  deadlineAt?: number;
  maxPerRun?: number;
  timeoutS?: number;
  maxChars?: number;
  pairMs?: number;
}

function makeRig(options: RigOptions = {}): UnitRig {
  const clock = new FakeClock(T0);
  const ledger = new XsWakeLedger();
  const deadlineAt = options.deadlineAt ?? T0 + 900_000;
  const origin =
    options.origin === null
      ? undefined
      : {
          requesterSessionId: options.origin?.requesterSessionId ?? REQ,
          requestId: options.origin?.requestId ?? ORIGIN_REQ,
          dueAt: options.origin?.dueAt ?? T0 + 1_800_000,
        };
  ledger.put({ token: TOKEN, sessionId: SID, xid: XID, dispatchedAt: T0, deadlineAt });
  ledger.update(TOKEN, { authorizedAt: T0, ...(origin !== undefined ? { askOrigin: origin } : {}) });
  const controller = { state: "bound" as string, activeToken: TOKEN as string | undefined };
  const state = { attached: true, hop: true };
  const sends: XsAskRedirectSendArgs[] = [];
  const issued: string[] = [];
  /** The default fake mirrors the real sender: issue → onIssued (sync) → receipt (a tick later). */
  let sendImpl: (args: XsAskRedirectSendArgs) => Promise<XsSendOutcome | undefined> = async (args) => {
    sends.push(args);
    const timeoutS = Math.min(86_400, Math.max(60, args.expectReply.timeoutS));
    const requestId = nextQ2();
    const dueAt = clock.now() + timeoutS * 1000;
    issued.push(requestId);
    args.onIssued?.({ requestId, dueAt });
    return {
      status: "sent",
      effect: "applied",
      woke: true,
      reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" },
    };
  };
  const deps: XsAskRedirectDeps = {
    sessionId: SID,
    clock,
    ledger,
    controller: () => controller,
    attached: () => state.attached,
    wakeHopAllowed: () => state.hop,
    maxChars: options.maxChars ?? 2000,
    pairMinIntervalMs: options.pairMs ?? PAIR_MS,
    timeoutS: options.timeoutS ?? 600,
    maxPerRun: options.maxPerRun ?? 2,
    send: (args) => sendImpl(args),
  };
  return {
    redirect: createXsAskRedirect(deps),
    clock,
    ledger,
    controller,
    state,
    sends,
    issued,
    setSend: (impl) => {
      sendImpl = impl;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A model-facing ask input: fixed body, records the budget it was rendered with. */
const askInput = (body = "1: 继续；2: 停下", signal?: AbortSignal) => {
  const budgets: number[] = [];
  return {
    budgets,
    input: {
      render: (b: number): string | undefined => {
        budgets.push(b);
        return body;
      },
      ...(signal !== undefined ? { signal } : {}),
    },
  };
};

const answerWrite = (q2: string, from = REQ, text = "1: a") => ({
  customType: "subagent:xs",
  content: `[xs] from=… reply_to=${q2}\n${text}`,
  details: { xid: "xanswer1", from: { sessionId: from }, inReplyTo: q2 },
});

const lastQ2 = (r: { issued: string[] }): string => {
  const q2 = r.issued.at(-1);
  expect(q2, "the fake sender must have issued a ticket first").toBeDefined();
  return q2!;
};

async function expectUnavailable(
  p: Promise<AskUserRedirectResult> | undefined,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<AskUserRedirectResult> {
  expect(p).toBeDefined();
  const r = await p!;
  expect(r).toMatchObject({ kind: "unavailable", reason, limit: 2, ...extra });
  return r;
}

describe("xs ask redirect — D2 O class (every miss keeps the local dialog)", () => {
  it("controller absent / not bound / no active token ⇒ undefined", () => {
    const r = makeRig();
    for (const s of ["idle", "deferred", "starting", "handedOver", "aborting", "stuck"] as const) {
      r.controller.state = s;
      expect(r.redirect.ask(askInput().input)).toBeUndefined();
    }
    r.controller.state = "bound";
    r.controller.activeToken = undefined;
    expect(r.redirect.ask(askInput().input)).toBeUndefined();
  });

  it("record missing / tombstone / abortIssued / unauthorized / handed / no askOrigin ⇒ undefined", () => {
    const r = makeRig({ origin: null });
    expect(r.redirect.ask(askInput().input)).toBeUndefined(); // no askOrigin
    r.ledger.update(TOKEN, { askOrigin: { requesterSessionId: REQ, requestId: ORIGIN_REQ, dueAt: T0 + 1_800_000 } });
    expect(r.redirect.ask(askInput().input)).toBeDefined();
    r.controller.activeToken = "another-token";
    expect(r.redirect.ask(askInput().input)).toBeUndefined(); // record missing for that token
    r.controller.activeToken = TOKEN;
    r.ledger.update(TOKEN, { handed: true });
    expect(r.redirect.ask(askInput().input)).toBeUndefined(); // handed: the human is at B
    r.ledger.update(TOKEN, { handed: false, abortIssuedAt: T0 });
    expect(r.redirect.ask(askInput().input)).toBeUndefined();
    r.ledger.update(TOKEN, { abortIssuedAt: undefined, authorizedAt: undefined });
    expect(r.redirect.ask(askInput().input)).toBeUndefined();
    r.ledger.tombstone(TOKEN);
    expect(r.redirect.ask(askInput().input)).toBeUndefined();
  });

  it("a foreign-session record under the same token ⇒ undefined", () => {
    const ledger = new XsWakeLedger();
    ledger.put({
      token: TOKEN,
      sessionId: "sess-OTHER0000000001",
      xid: XID,
      dispatchedAt: T0,
      deadlineAt: T0 + 900_000,
    });
    const redirect = createXsAskRedirect({
      sessionId: SID,
      clock: new FakeClock(T0),
      ledger,
      controller: () => ({ state: "bound", activeToken: TOKEN }),
      attached: () => true,
      wakeHopAllowed: () => true,
      maxChars: 2000,
      pairMinIntervalMs: PAIR_MS,
      timeoutS: 600,
      maxPerRun: 2,
      send: () => undefined,
    });
    expect(redirect.ask(askInput().input)).toBeUndefined();
  });

  it("disposed instance ⇒ undefined (no redirect after stack dispose)", () => {
    const r = makeRig();
    r.redirect.dispose();
    expect(r.redirect.ask(askInput().input)).toBeUndefined();
  });
});

describe("xs ask redirect — D2 U class (explicit text, never a local dialog)", () => {
  it("detached", async () => {
    const r = makeRig();
    r.state.attached = false;
    await expectUnavailable(r.redirect.ask(askInput().input), "detached", { attempt: 1 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBeUndefined(); // nothing billed
  });

  it("run_window: the record deadline minus 60s leaves <60s", async () => {
    const r = makeRig({ deadlineAt: T0 + XS_ASK_MARGIN_MS + 30_000 });
    await expectUnavailable(r.redirect.ask(askInput().input), "run_window", { attempt: 1 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBeUndefined();
  });

  it("origin_window: the origin dueAt minus 60s binds first", async () => {
    const r = makeRig({ deadlineAt: T0 + 500_000, origin: { dueAt: T0 + XS_ASK_MARGIN_MS + 10_000 } });
    await expectUnavailable(r.redirect.ask(askInput().input), "origin_window", { attempt: 1 });
  });

  it("level_limit: the local hop pre-check fails", async () => {
    const r = makeRig();
    r.state.hop = false;
    await expectUnavailable(r.redirect.ask(askInput().input), "level_limit", { attempt: 1 });
  });

  it("too_large: render answered undefined — no billing, no send", async () => {
    const r = makeRig();
    await expectUnavailable(r.redirect.ask({ render: () => undefined }), "too_large", { attempt: 1 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBeUndefined();
    expect(r.sends).toHaveLength(0);
  });

  it("limit: two billed calls refuse the third synchronously", async () => {
    const r = makeRig();
    r.ledger.update(TOKEN, { askUsed: 2 });
    await expectUnavailable(r.redirect.ask(askInput().input), "limit", { attempt: 3 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(2);
  });
});

describe("xs ask redirect — D4/D5 admission, serialisation and deadlines", () => {
  it("three parallel asks on one tick: #1 sends, #2 queues, #3 is refused with limit", async () => {
    const r = makeRig();
    const a = r.redirect.ask(askInput("Q1").input)!;
    void r.redirect.ask(askInput("Q2").input)!;
    await expectUnavailable(r.redirect.ask(askInput("Q3").input), "limit", { attempt: 3 });
    await tick();
    expect(r.sends).toHaveLength(1); // serial per token: only #1 has left
    expect(r.sends[0]!.text).toContain("Q1");
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(2); // billed + in-flight
    r.redirect.dispose();
    await expect(a).resolves.toEqual({ kind: "disposed" });
  });

  it("#2 sends only after #1's terminal AND the pair interval; header carries attempt 2/2", async () => {
    const r = makeRig();
    const a = r.redirect.ask(askInput("Q1").input)!;
    void r.redirect.ask(askInput("Q2").input)!;
    await tick();
    r.clock.advance(10_000);
    r.redirect.observeWrite(answerWrite(lastQ2(r)));
    await expect(a).resolves.toMatchObject({ kind: "answered", requestId: lastQ2(r) });
    await tick();
    // #1's terminal at +10s. The hub stamps the pair at the requester's REPLY too (replies skip
    // the interval check, not the stamp), so the interval runs from the answer: earliest +40s.
    expect(r.sends).toHaveLength(1);
    r.clock.advance(29_000); // t = +39s — still inside the interval
    await tick();
    expect(r.sends).toHaveLength(1);
    r.clock.advance(1_001); // the queue timer fires at +40s ⇒ #2 leaves
    await tick();
    expect(r.sends).toHaveLength(2);
    expect(r.sends[1]!.text.startsWith(xsAskRedirectHeader(2, 2, ORIGIN_REQ))).toBe(true);
    expect(r.sends[1]!.text).toContain(XS_ASK_REDIRECT_INSTRUCTIONS);
  });

  it("a LATER ask after the queue emptied still waits out the pair interval (stamp outlives the queue)", async () => {
    const r = makeRig();
    const a = r.redirect.ask(askInput("Q1").input)!;
    await tick();
    r.clock.advance(1_000);
    r.redirect.observeWrite(answerWrite(lastQ2(r))); // answered ⇒ queue emptied and deleted
    await expect(a).resolves.toMatchObject({ kind: "answered" });
    await tick();
    r.clock.advance(5_000); // the model's next turn asks again, inside the interval (answer at +1s)
    void r.redirect.ask(askInput("Q2").input)!;
    await tick();
    expect(r.sends).toHaveLength(1); // not sent: hub would answer rate_pair_interval
    r.clock.advance(25_001); // +31.001s … answer stamp at +1s + 30s
    await tick();
    expect(r.sends).toHaveLength(2);
  });

  it("queue_window: #2 queued past its own absolute window ⇒ refunded unavailable", async () => {
    // origin dueAt ⇒ waitUntil = t0+80s; #2 may only leave at +40s (pair interval from the answer at +10s), leaving 40s < 60s
    const r = makeRig({ origin: { dueAt: T0 + 80_000 + XS_ASK_MARGIN_MS } });
    const a = r.redirect.ask(askInput("Q1").input)!;
    const b = r.redirect.ask(askInput("Q2").input)!;
    await tick();
    r.clock.advance(10_000);
    r.redirect.observeWrite(answerWrite(lastQ2(r)));
    await expect(a).resolves.toMatchObject({ kind: "answered" });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(2); // #1 answered stays billed + #2 reserved while queued
    r.clock.advance(30_001); // pair interval elapses ⇒ queue timer ⇒ head recompute fails (<60s)
    await expect(b).resolves.toMatchObject({ kind: "unavailable", reason: "queue_window", attempt: 2 });
    expect(r.sends).toHaveLength(1);
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // #2 never sent ⇒ refunded; #1's billing stays
  });

  it("unknown bills: an unknown send outcome stays pending, then times out billed", async () => {
    const r = makeRig();
    r.setSend(async (args) => {
      r.sends.push(args);
      const requestId = nextQ2();
      const dueAt = r.clock.now() + args.expectReply.timeoutS * 1000;
      r.issued.push(requestId);
      args.onIssued?.({ requestId, dueAt });
      return {
        status: "unanswered",
        effect: "unknown",
        reason: "queued",
        reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" },
      };
    });
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    r.clock.advance(600_000); // waitUntil = t0+600s (timeoutS) — before the run/origin ends
    await expect(p).resolves.toMatchObject({ kind: "timeout", requestId: lastQ2(r), attempt: 1, waitedS: 600 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // unknown ⇒ billed, never refunded
  });

  it("none refunds: a provably-unsent outcome returns the reservation", async () => {
    const r = makeRig();
    r.setSend(async () => ({ status: "reply_quota", effect: "none", reason: "reply_quota" }));
    await expectUnavailable(r.redirect.ask(askInput().input)!, "send_none:reply_quota", { attempt: 1 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(0);
  });

  it("none AFTER a terminal does not refund a second time (early answer, late receipt)", async () => {
    const r = makeRig();
    let release!: (o: XsSendOutcome) => void;
    r.setSend(
      (args) =>
        new Promise<XsSendOutcome>((resolve) => {
          r.sends.push(args);
          const requestId = nextQ2();
          r.issued.push(requestId);
          const dueAt = r.clock.now() + 600_000;
          args.onIssued?.({ requestId, dueAt });
          release = (o) =>
            resolve({ ...o, reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" } });
        }),
    );
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    const q2 = lastQ2(r);
    r.redirect.observeWrite(answerWrite(q2)); // answered BEFORE the send receipt lands
    await expect(p).resolves.toMatchObject({ kind: "answered", requestId: q2 });
    release({ status: "sent", effect: "none", reason: "origin_changed" }); // late receipt: none
    await tick();
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // terminal already claimed — no refund
  });

  it("maxPerRun injected 3 / 4 / 1e9 keeps the effective cap at 2 (r3 ruling)", async () => {
    for (const maxPerRun of [3, 4, 1e9]) {
      const r = makeRig({ maxPerRun });
      void r.redirect.ask(askInput("Q1").input)!;
      void r.redirect.ask(askInput("Q2").input)!;
      await expectUnavailable(r.redirect.ask(askInput("Q3").input), "limit", { limit: 2, attempt: 3 });
      expect(r.ledger.get(TOKEN)?.askUsed).toBe(2);
    }
  });

  it("parse path clamps maxPerRun into 1..2 and timeoutS into 60..3600 (D9)", () => {
    const d = DEFAULT_FABRIC_SETTINGS.crossSession.askRedirect;
    expect(d).toEqual({ enabled: true, timeoutS: 600, maxPerRun: 2 });
    expect(parseFabricXsAskRedirectSettings({ maxPerRun: 3 }).maxPerRun).toBe(2);
    expect(parseFabricXsAskRedirectSettings({ maxPerRun: 4 }).maxPerRun).toBe(2);
    expect(parseFabricXsAskRedirectSettings({ maxPerRun: 1e9 }).maxPerRun).toBe(2);
    expect(parseFabricXsAskRedirectSettings({ maxPerRun: 0 }).maxPerRun).toBe(1);
    expect(parseFabricXsAskRedirectSettings({ maxPerRun: 0.5 }).maxPerRun).toBe(1);
    expect(parseFabricXsAskRedirectSettings({ timeoutS: 1 }).timeoutS).toBe(60);
    expect(parseFabricXsAskRedirectSettings({ timeoutS: 99_999 }).timeoutS).toBe(3_600);
    expect(parseFabricXsAskRedirectSettings({ enabled: false })).toEqual({
      enabled: false,
      timeoutS: 600,
      maxPerRun: 2,
    });
    expect(parseFabricXsAskRedirectSettings("junk")).toEqual(d);
  });

  it("D5: the host wait ends at min(waitUntil, q2DueAt) once the real dueAt is known", async () => {
    const r = makeRig({ timeoutS: 600 });
    r.setSend(async (args) => {
      r.sends.push(args);
      const timeoutS = Math.min(300, Math.max(60, args.expectReply.timeoutS)); // the ledger clamps to 300s
      const requestId = nextQ2();
      r.issued.push(requestId);
      const dueAt = r.clock.now() + timeoutS * 1000;
      args.onIssued?.({ requestId, dueAt });
      return {
        status: "sent",
        effect: "applied",
        woke: true,
        reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" },
      };
    });
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    expect(r.sends[0]!.expectReply.timeoutS).toBe(600); // head recompute passes the remaining window
    r.clock.advance(300_000); // q2DueAt = t0+300s < waitUntil t0+600s ⇒ the EARLIER one fires
    await expect(p).resolves.toMatchObject({ kind: "timeout", waitedS: 300 });
  });
});

describe("xs ask redirect — D6 state machine, cancellation and races (T7/T8)", () => {
  it("abort during the resolve round trip ⇒ no frame leaves (the sender's guard sees !invocationLive)", async () => {
    const r = makeRig();
    const ctl = new AbortController();
    let liveProbe = true;
    r.setSend(async (args) => {
      r.sends.push(args);
      // the REAL sender's resolve round trip: an await BEFORE the invocationLive check
      await new Promise<void>((resolve) => setImmediate(resolve));
      liveProbe = args.invocationLive();
      if (!liveProbe) return { status: "origin_changed", effect: "none", reason: "origin_changed" };
      const requestId = nextQ2();
      r.issued.push(requestId);
      const dueAt = r.clock.now() + 600_000;
      args.onIssued?.({ requestId, dueAt });
      return {
        status: "sent",
        effect: "applied",
        woke: true,
        reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" },
      };
    });
    const p = r.redirect.ask({ ...askInput().input, signal: ctl.signal })!;
    ctl.abort(); // claims the single terminal before the fake send observes it
    await expect(p).resolves.toEqual({ kind: "aborted" });
    await tick();
    expect(liveProbe).toBe(false); // the sender saw a dead invocation ⇒ no ticket, no frame
    expect(r.issued).toHaveLength(0);
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // terminal — the later none does not refund
  });

  it("abort after the frame left ⇒ aborted; the late receipt is conservative bookkeeping", async () => {
    const r = makeRig();
    const ctl = new AbortController();
    let release!: (o: XsSendOutcome) => void;
    r.setSend(
      (args) =>
        new Promise<XsSendOutcome>((resolve) => {
          r.sends.push(args);
          const requestId = nextQ2();
          r.issued.push(requestId);
          const dueAt = r.clock.now() + 600_000;
          args.onIssued?.({ requestId, dueAt });
          release = (o) =>
            resolve({ ...o, reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" } });
        }),
    );
    const p = r.redirect.ask({ ...askInput().input, signal: ctl.signal })!;
    await tick();
    ctl.abort();
    await expect(p).resolves.toEqual({ kind: "aborted" });
    release({ status: "sent", effect: "applied", woke: true });
    await tick();
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // billed (the frame may have landed)
  });

  it("timeout and the answer in one tick ⇒ exactly one terminal (timeout first)", async () => {
    const r = makeRig();
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    const q2 = lastQ2(r);
    r.clock.advance(600_000); // the deadline timer fires inside advance()
    r.redirect.observeWrite(answerWrite(q2)); // same tick, after the timer
    await expect(p).resolves.toMatchObject({ kind: "timeout" });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1);
  });

  it("answer after timeout / duplicate answers / wrong q2 / wrong from / NoticeGate quiet write never match", async () => {
    const r = makeRig();
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    const q2 = lastQ2(r);
    r.clock.advance(600_000);
    await expect(p).resolves.toMatchObject({ kind: "timeout" });
    r.redirect.observeWrite(answerWrite(q2)); // after the terminal
    r.redirect.observeWrite(answerWrite(nextQ2())); // unregistered q2
    r.redirect.observeWrite(answerWrite(q2, "sess-attacker-00001")); // wrong sender
    // NoticeGate's quiet write exit carries a DIFFERENT customType ("subagent:xs-reply")
    r.redirect.observeWrite({ customType: "subagent:xs-reply", content: "notice", details: { inReplyTo: q2 } });
    r.redirect.observeWrite({
      customType: "subagent:xs",
      content: "no inReplyTo",
      details: { xid: "x9", from: { sessionId: REQ } },
    });
    await tick();
    await expect(p).resolves.toMatchObject({ kind: "timeout" }); // unchanged — no revival
  });

  it("dispose settles in-flight calls as disposed (billed); answers never revive them (T6)", async () => {
    const r = makeRig();
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    r.redirect.dispose();
    await expect(p).resolves.toEqual({ kind: "disposed" });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // disposed is billed
    r.redirect.observeWrite(answerWrite(lastQ2(r)));
    await expect(p).resolves.toEqual({ kind: "disposed" });
  });

  it("cross reload: the SAME ledger keeps the count — a fresh redirect still refuses the 3rd (T6)", async () => {
    const ledger = new XsWakeLedger();
    const clock = new FakeClock(T0);
    ledger.put({ token: TOKEN, sessionId: SID, xid: XID, dispatchedAt: T0, deadlineAt: T0 + 900_000 });
    ledger.update(TOKEN, {
      authorizedAt: T0,
      askOrigin: { requesterSessionId: REQ, requestId: ORIGIN_REQ, dueAt: T0 + 1_800_000 },
    });
    const issued: string[] = [];
    const build = () =>
      createXsAskRedirect({
        sessionId: SID,
        clock,
        ledger,
        controller: () => ({ state: "bound", activeToken: TOKEN }),
        attached: () => true,
        wakeHopAllowed: () => true,
        maxChars: 2000,
        pairMinIntervalMs: PAIR_MS,
        timeoutS: 600,
        maxPerRun: 2,
        send: async (args) => {
          const requestId = nextQ2();
          issued.push(requestId);
          const dueAt = clock.now() + 600_000;
          args.onIssued?.({ requestId, dueAt });
          return {
            status: "sent",
            effect: "applied",
            woke: true,
            reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" },
          };
        },
      });
    const first = build();
    const p1 = first.ask(askInput("Q1").input)!; // billed 1
    await tick();
    first.observeWrite(answerWrite(issued.at(-1)!)); // answered (billed stays)
    await expect(p1).resolves.toMatchObject({ kind: "answered" });
    const p2 = first.ask(askInput("Q2").input)!; // billed 2, in flight
    await expectUnavailable(first.ask(askInput("Q3").input), "limit", { attempt: 3 });
    first.dispose(); // /reload #1
    await expect(p2).resolves.toEqual({ kind: "disposed" }); // in-flight at dispose: billed
    expect(ledger.get(TOKEN)?.askUsed).toBe(2);
    const second = build(); // new stack, same process ledger, controller recover()
    await expectUnavailable(second.ask(askInput("Q4").input), "limit", { attempt: 3 });
    second.dispose(); // /reload #2
    const third = build();
    await expectUnavailable(third.ask(askInput("Q5").input), "limit", { attempt: 3 });
  });
});

describe("xs ask redirect — D7 classifyAskSend exhaustive matrix (T10)", () => {
  const DOWNGRADES: (XsWakeDowngraded | undefined)[] = [
    undefined,
    "wake_disabled",
    "controller_disabled",
    "host_unverified",
    "host_unsupported",
    "receiver_policy",
    "busy",
    "goal",
    "level_limit",
    "inbound_wake_rate",
    "outbound_wake_rate",
    "pair_wake_rate",
    "sender_wake_disabled",
    "broadcast_wake_fanout",
    "broadcast_wake_rate",
    "ledger_full",
  ];
  const STATUSES: XsSendStatus[] = [
    "sent",
    "unanswered",
    "no_target",
    "ambiguous",
    "bad_target",
    "stale_origin",
    "origin_changed",
    "off",
    "too_large",
    "bad_frame",
    "bad_args",
    "reply_unsupported",
    "reply_unreceivable",
    "reply_quota",
    "reply_target_mismatch",
    "not_joined",
    "alias_unavailable",
    "error",
  ];
  const TICKET = { requestId: "q00000000000000ff01", dueAt: "2026-01-01T00:00:00.000Z", state: "pending" } as const;

  it("status × effect × woke × downgrade with a pending ticket follows the ordered rules", () => {
    let checked = 0;
    for (const status of STATUSES) {
      for (const effect of ["none", "unknown", "applied"] as const) {
        for (const woke of [true, undefined] as const) {
          for (const wakeDowngraded of DOWNGRADES) {
            const o = {
              status,
              effect,
              ...(woke !== undefined ? { woke } : {}),
              ...(wakeDowngraded !== undefined ? { wakeDowngraded } : {}),
              reply: TICKET,
            } as XsSendOutcome;
            let want: "none" | "no_ticket" | "wait" | "not_woken";
            if (effect === "none")
              want = "none"; // rule 1 — regardless of everything else
            else if (effect === "unknown")
              want = "wait"; // rule 3 — never none/not_woken
            else if (woke === true)
              want = "wait"; // rule 4
            else if (wakeDowngraded !== undefined)
              want = "not_woken"; // rule 5
            else want = "wait"; // rule 6 — conservative
            expect(
              { status, effect, woke, wakeDowngraded, got: classifyAskSend(o) },
              `${status}/${effect}/woke=${woke}/dg=${wakeDowngraded}`,
            ).toMatchObject({ got: want });
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(STATUSES.length * 3 * 2 * DOWNGRADES.length);
  });

  it("a missing / non-pending ticket with a non-none effect ⇒ no_ticket (rule 2)", () => {
    for (const reply of [undefined, { ...TICKET, state: "send_failed" as const }]) {
      for (const effect of ["unknown", "applied"] as const) {
        expect(classifyAskSend({ status: "sent", effect, reply, woke: true } as XsSendOutcome)).toBe("no_ticket");
      }
    }
  });

  it("plan-named rows: applied+busy ⇒ not_woken; unknown+queued+busy ⇒ wait; none wins over the ticket", () => {
    expect(classifyAskSend({ status: "sent", effect: "applied", wakeDowngraded: "busy", reply: TICKET })).toBe(
      "not_woken",
    );
    expect(
      classifyAskSend({
        status: "unanswered",
        effect: "unknown",
        reason: "queued",
        wakeDowngraded: "busy",
        reply: TICKET,
      }),
    ).toBe("wait");
    expect(
      classifyAskSend({ status: "off", effect: "none", code: "E_XS_OFF", reply: { ...TICKET, state: "send_failed" } }),
    ).toBe("none");
  });
});

describe("xs ask redirect — D8 header, budget and result payloads", () => {
  it("the sent text is header + instructions + body; the render budget subtracts the overhead", async () => {
    const r = makeRig({ maxChars: 2000 });
    const { input, budgets } = askInput("BODY-CONTENT");
    const p = r.redirect.ask(input)!;
    await tick();
    expect(budgets).toHaveLength(1);
    const header = xsAskRedirectHeader(1, 2, ORIGIN_REQ);
    expect(budgets[0]).toBe(2000 - ([...header].length + [...XS_ASK_REDIRECT_INSTRUCTIONS].length + 4));
    expect(r.sends[0]!.text).toBe(`${header}\n\n${XS_ASK_REDIRECT_INSTRUCTIONS}\n\nBODY-CONTENT`);
    const q2 = lastQ2(r);
    r.redirect.observeWrite(answerWrite(q2));
    await expect(p).resolves.toMatchObject({
      kind: "answered",
      requestId: q2,
      originRequestId: ORIGIN_REQ,
      answerText: expect.stringContaining("1: a"),
    });
  });

  it("answered carries BOTH the q2 requestId and the original delegation originRequestId (root ruling)", async () => {
    const r = makeRig();
    const p = r.redirect.ask(askInput().input)!;
    await tick();
    const q2 = lastQ2(r);
    expect(q2).not.toBe(ORIGIN_REQ);
    r.redirect.observeWrite(answerWrite(q2));
    await expect(p).resolves.toMatchObject({
      kind: "answered",
      requestId: q2,
      originRequestId: ORIGIN_REQ,
      attempt: 1,
      limit: 2,
    });
  });

  it("the ask input cannot steer the destination — extra to/from/replyTo fields are ignored (T3)", async () => {
    const r = makeRig();
    const hostile = {
      ...askInput().input,
      to: "sess-attacker-00001",
      from: "spoofed",
      replyTo: "q0000000000000beef",
    } as unknown as Parameters<XsAskRedirect["ask"]>[0];
    void r.redirect.ask(hostile)!;
    await tick();
    expect(r.sends[0]!.to).toBe(REQ); // always the captured askOrigin requester
  });

  it("not_woken returns immediately with the downgrade token (user ruling)", async () => {
    const r = makeRig();
    r.setSend(async (args) => {
      r.sends.push(args);
      const requestId = nextQ2();
      r.issued.push(requestId);
      const dueAt = r.clock.now() + 600_000;
      args.onIssued?.({ requestId, dueAt });
      return {
        status: "sent",
        effect: "applied",
        wakeDowngraded: "busy",
        reply: { requestId, dueAt: new Date(dueAt).toISOString(), state: "pending" },
      };
    });
    const p = r.redirect.ask(askInput().input)!;
    await expect(p).resolves.toMatchObject({
      kind: "not_woken",
      downgrade: "busy",
      requestId: lastQ2(r),
      attempt: 1,
      limit: 2,
    });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(1); // billed (the message WAS delivered)
  });

  it("a send that returns undefined (no sender) is provably unsent ⇒ send_none + refund", async () => {
    const r = makeRig();
    r.setSend(() => undefined);
    await expectUnavailable(r.redirect.ask(askInput().input)!, "send_none:send_threw", { attempt: 1 });
    expect(r.ledger.get(TOKEN)?.askUsed).toBe(0);
  });

  it("observeWrite swallows garbage without throwing (observation only)", () => {
    const r = makeRig();
    expect(() => {
      r.redirect.observeWrite(null);
      r.redirect.observeWrite({ customType: "subagent:xs", details: 42 });
      r.redirect.observeWrite({ customType: "subagent:xs", details: { xsWake: "yes", inReplyTo: 7 } });
      r.redirect.observeWrite(undefined);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stack-level (T1 B1 half + D3/D6 through the REAL controller & receiver):
// the delegation dispatch captures askOrigin on the real wake ledger, BAS binds the run,
// and the receiver's answer write resolves the pending ask — no fakes between the tap and
// the receiver. The off / unwired variants must leave `stack.askRedirect` absent (I9).
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildStackXs } from "../../src/fabric/xs/stack.js";
import { getXsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { getXsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";

const SSID = "sess-stack-0123456789ab";
const SREQ = "sess-delegator-0000001";

interface StackFake {
  branch: Record<string, unknown>[];
  idle: boolean;
  writes: { customType: string; details: unknown }[];
}

function buildStack(fake: StackFake, options: { askRedirectOn?: boolean; wire?: boolean } = {}) {
  const settings = {
    fabric: {
      ...DEFAULT_FABRIC_SETTINGS,
      wake: { ...DEFAULT_FABRIC_SETTINGS.wake, enabled: true },
      crossSession: {
        ...DEFAULT_FABRIC_SETTINGS.crossSession,
        autoJoin: true,
        ...(options.askRedirectOn === false
          ? { askRedirect: { ...DEFAULT_FABRIC_SETTINGS.crossSession.askRedirect, enabled: false } }
          : {}),
      },
    },
  };
  const pi = {
    appendEntry: (type: string, data: unknown) =>
      fake.branch.push({ type: "custom", customType: type, data, id: `p${fake.branch.length}` }),
    sendMessage: (message: { customType: string; details?: unknown }, options2: { triggerTurn: boolean }) => {
      fake.writes.push({ customType: message.customType, details: message.details });
      if (options2.triggerTurn) fake.idle = false;
      else if (fake.idle)
        fake.branch.push({
          type: "custom_message",
          customType: message.customType,
          content: (message as { content?: string }).content,
          details: message.details,
          id: `m${fake.branch.length}`,
        });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getSessionId: () => SSID,
      getBranch: () => fake.branch,
      getLeafEntry: () => fake.branch.at(-1) ?? null,
      getEntries: () => [],
    },
    isIdle: () => fake.idle,
    hasPendingMessages: () => false,
    abort: () => {},
  } as unknown as ExtensionContext;
  const sends: XsAskRedirectSendArgs[] = [];
  const issued: string[] = [];
  const input =
    options.wire === false
      ? {}
      : {
          askRedirect: {
            send: async (args: XsAskRedirectSendArgs) => {
              sends.push(args);
              const ledger = getXsReplyLedger();
              const ticket = ledger.issue({
                requesterSessionId: SSID,
                replierSessionId: SREQ,
                replierRef: "delegator12",
                origin: "model",
                wakeOnReply: true,
                requesterLevel: 0,
                timeoutMs: args.expectReply.timeoutS * 1000,
                lateGraceMs: 600_000,
                maxPending: 8,
                maxPendingPerTarget: 3,
              });
              if (!ticket.ok) return { status: "reply_quota", effect: "none" as const, reason: "reply_quota" };
              issued.push(ticket.ticket.requestId);
              args.onIssued?.({ requestId: ticket.ticket.requestId, dueAt: ticket.ticket.dueAt });
              return {
                status: "sent" as const,
                effect: "applied" as const,
                woke: true,
                reply: { requestId: ticket.ticket.requestId, state: "pending" as const },
              };
            },
            wakeHopAllowed: () => true,
            attached: () => true,
          },
        };
  const xs = buildStackXs(pi, ctx, settings as never, "startup", undefined, input);
  return { xs, sends, issued };
}

const delegationFrame = (epoch: number, q1: string, now: number) => ({
  t: "xs_deliver" as const,
  rid: "rd1",
  xid: "xdel000000000001",
  to: { sessionId: SSID, epoch },
  from: { sessionId: SREQ, ref: "delegator12", cwdLabel: "~/ai/x", agentId: "a-deleg" },
  text: "please do the thing",
  wake: true,
  reply: { requestId: q1, dueAt: now + 600_000 },
  expiresAt: now + 5_000,
});

const answerFrame = (epoch: number, q2: string, now: number) => ({
  t: "xs_deliver" as const,
  rid: "rd2",
  xid: "xans000000000001",
  to: { sessionId: SSID, epoch },
  from: { sessionId: SREQ, ref: "delegator12", cwdLabel: "~/ai/x", agentId: "a-deleg" },
  text: "1: ship it",
  inReplyTo: q2,
  expiresAt: now + 5_000,
});

const basTrigger = (token: string) => ({
  messageType: "custom",
  message: {
    customType: "subagent:xs",
    details: { xsWake: true, xid: "xdel000000000001", wakeToken: token },
  },
});

describe("xs ask redirect — stack wiring (T1: off ⇒ absent; on ⇒ real controller+receiver E2E)", () => {
  afterEach(() => {
    // drop the process-level ledgers the real stack wired itself into
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-wake-ledger")] = undefined;
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-reply-ledger")] = undefined;
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-membership-handoff")] = undefined;
  });

  it("askRedirect off ⇒ no port on the stack (byte-identical surface, I9)", () => {
    const fake: StackFake = { branch: [], idle: true, writes: [] };
    const { xs } = buildStack(fake, { askRedirectOn: false });
    expect(xs.controller).toBeDefined(); // wake on
    expect(xs.reply).toBeDefined(); // reply on
    expect(xs.askRedirect).toBeUndefined();
    xs.dispose();
  });

  it("no activation wiring ⇒ no port even with the leaf on", () => {
    const fake: StackFake = { branch: [], idle: true, writes: [] };
    const { xs } = buildStack(fake, { wire: false });
    expect(xs.askRedirect).toBeUndefined();
    xs.dispose();
  });

  it("delegation dispatch captures askOrigin; BAS binds; ask redirects; the real receiver's answer write resolves it", async () => {
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-wake-ledger")] = undefined;
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-reply-ledger")] = undefined;
    const fake: StackFake = { branch: [], idle: true, writes: [] };
    const { xs, sends, issued } = buildStack(fake);
    expect(xs.askRedirect).toBeDefined();
    const now = Date.now();
    const epoch = xs.membership.epoch;
    const q1 = "q0000000000000abcd1";

    // ① the delegation lands while idle ⇒ controller dispatch ⇒ the tap captures the origin
    const verdict = xs.deliver(delegationFrame(epoch, q1, now));
    expect(verdict.woke).toBe(true);
    const token = xs.controller!.activeToken!;
    expect(token).toBeDefined();
    const rec = getXsWakeLedger().get(token);
    expect(rec?.askOrigin).toEqual({ requesterSessionId: SREQ, requestId: q1, dueAt: now + 600_000 });

    // ② BAS authorizes the run ⇒ bound; before that ask is O (undefined)
    expect(xs.askRedirect!.ask({ render: () => "1: a" })).toBeUndefined(); // not bound yet
    xs.beforeAgentStart(basTrigger(token));
    expect(xs.controller!.state).toBe("bound");

    // ③ the redirect asks through the injected sender; the ticket lands in the REAL reply ledger
    const p = xs.askRedirect!.ask({ render: () => "1: 继续；2: 停下" });
    expect(p).toBeDefined();
    await tick();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(SREQ);
    const q2 = issued.at(-1)!;
    expect(q2).not.toBe(q1);

    // ④ A's answer arrives through the REAL receiver: solicited, controller busy ⇒ deliver-only
    //    write with inReplyTo ⇒ the tap resolves the pending ask
    xs.deliver(answerFrame(epoch, q2, now + 1_000));
    const out = await p!;
    expect(out).toMatchObject({
      kind: "answered",
      requestId: q2,
      originRequestId: q1, // the ORIGINAL delegation stays where the final result must go
      attempt: 1,
      limit: 2,
    });
    expect(out.kind === "answered" && out.answerText).toContain("1: ship it");
    expect(getXsWakeLedger().get(token)?.askUsed).toBe(1);
    xs.dispose();
  });
});
