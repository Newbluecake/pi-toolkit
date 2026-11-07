import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { createXsAskRedirect, type XsAskRedirect } from "../../src/fabric/xs/ask-redirect.js";
import type { XsSendOutcome } from "../../src/fabric/xs/sender.js";

/**
 * #21 plan §3 T3 / §1 D3 (M4): origin capture is a write-once snapshot taken ONLY on the
 * stack's host write exit, inside the controller's synchronous dispatch call. Every mismatched,
 * tampered, duplicated or out-of-band candidate is rejected — the run falls back to the O class
 * (plain local ask_user). pi custom messages carry no writer authentication, so anything not
 * seen on the dispatch exit (e.g. another extension's `appendCustomMessageEntry` forgery) never
 * becomes an origin.
 */

const SID = "sess-origin-0123456789a";
const OTHER_SESSION = "sess-OTHER0000000001";
const REQ = "sess-req-00000009abcdef0";
const TOKEN = "wake-token-1";
const XID = "xid-delegate-1";
const ORIGIN_REQ = "q0000000000000000aa";
const T0 = 1_000_000;

interface OriginRig {
  redirect: XsAskRedirect;
  clock: FakeClock;
  ledger: XsWakeLedger;
  controller: { state: string; activeToken: string | undefined };
  sends: { to: string }[];
}

function makeRig(options: { withAskOrigin?: boolean; controllerState?: string } = {}): OriginRig {
  const clock = new FakeClock(T0);
  const ledger = new XsWakeLedger();
  ledger.put({ token: TOKEN, sessionId: SID, xid: XID, dispatchedAt: T0, deadlineAt: T0 + 900_000 });
  ledger.update(TOKEN, {
    authorizedAt: T0,
    ...(options.withAskOrigin === true
      ? { askOrigin: { requesterSessionId: REQ, requestId: ORIGIN_REQ, dueAt: T0 + 1_800_000 } }
      : {}),
  });
  const controller = {
    state: options.controllerState ?? "starting",
    activeToken: TOKEN as string | undefined,
  };
  const sends: { to: string }[] = [];
  const redirect = createXsAskRedirect({
    sessionId: SID,
    clock,
    ledger,
    controller: () => controller,
    attached: () => true,
    wakeHopAllowed: () => true,
    maxChars: 2000,
    pairMinIntervalMs: 30_000,
    timeoutS: 600,
    maxPerRun: 2,
    send: async (args): Promise<XsSendOutcome> => {
      sends.push({ to: args.to });
      return { status: "sent", effect: "applied", woke: true };
    },
  });
  return { redirect, clock, ledger, controller, sends };
}

/** A wake dispatch exactly as RootWakeController writes it (host.sendMessage exit shape). */
const wakeWrite = (over: { details?: Record<string, unknown>; customType?: string } = {}) => ({
  customType: over.customType ?? "subagent:xs",
  content: "fenced delegation",
  details: {
    xsWake: true,
    xid: XID,
    from: { sessionId: REQ, ref: "abcdef123456", cwdLabel: "~/ai/x", agentId: "a-1" },
    wakeToken: TOKEN,
    reply: { requestId: ORIGIN_REQ, dueAt: T0 + 1_800_000 },
    ...over.details,
  },
});

const askBody = { render: (): string => "1: a" };

describe("xs ask redirect origin capture — D3 happy path and write-once", () => {
  it("a genuine controller dispatch write captures the origin exactly once", () => {
    const r = makeRig({ controllerState: "starting" }); // capture happens AT dispatch, bound comes later
    r.redirect.observeWrite(wakeWrite());
    expect(r.ledger.get(TOKEN)?.askOrigin).toEqual({
      requesterSessionId: REQ,
      requestId: ORIGIN_REQ,
      dueAt: T0 + 1_800_000,
    });
    // write-once: a second (even differently-shaped) candidate never overwrites
    r.redirect.observeWrite(
      wakeWrite({ details: { reply: { requestId: "q0000000000000000ff", dueAt: T0 + 9_999_000 } } }),
    );
    expect(r.ledger.get(TOKEN)?.askOrigin).toEqual({
      requesterSessionId: REQ,
      requestId: ORIGIN_REQ,
      dueAt: T0 + 1_800_000,
    });
    // once bound, ask proceeds on the CAPTURED origin (redirect available in that run)
    r.controller.state = "bound";
    expect(r.redirect.ask(askBody)).toBeDefined();
  });

  it("capture precedes the run: ask stays O until bound, then redirects", async () => {
    const r = makeRig();
    r.redirect.observeWrite(wakeWrite());
    for (const s of ["deferred", "starting", "handedOver"] as const) {
      r.controller.state = s;
      expect(r.redirect.ask(askBody)).toBeUndefined();
    }
    r.controller.state = "bound";
    const p = r.redirect.ask(askBody);
    expect(p).toBeDefined();
    await p;
    expect(r.sends[0]!.to).toBe(REQ);
  });
});

describe("xs ask redirect origin capture — every mismatched candidate is rejected (M4)", () => {
  const rejected = (name: string, mutate: (r: OriginRig) => void, write: () => ReturnType<typeof wakeWrite>) => {
    it(name, () => {
      const r = makeRig();
      mutate(r);
      r.redirect.observeWrite(write());
      expect(r.ledger.get(TOKEN)?.askOrigin, name).toBeUndefined();
      r.controller.state = "bound";
      expect(r.redirect.ask(askBody), `${name} ⇒ the run stays O class`).toBeUndefined();
    });
  };

  rejected(
    "xid does not match the ledger record",
    () => {},
    () => wakeWrite({ details: { xid: "xid-SPOOFED-00001" } }),
  );
  rejected(
    "controller.activeToken is a different token",
    (r) => void (r.controller.activeToken = "tok-other-1"),
    () => wakeWrite(),
  );
  rejected(
    "controller is gone",
    (r) => void (r.controller.activeToken = undefined),
    () => wakeWrite(),
  );
  rejected(
    "the wake token has no ledger record",
    () => {},
    () => wakeWrite({ details: { wakeToken: "tok-unknown-0001" } }),
  );
  rejected(
    "the record belongs to another session",
    (r) => {
      r.ledger.release(TOKEN, "settled");
      r.ledger.put({
        token: TOKEN,
        sessionId: OTHER_SESSION,
        xid: XID,
        dispatchedAt: T0,
        deadlineAt: T0 + 900_000,
      });
    },
    () => wakeWrite(),
  );
  rejected(
    "activateFor control marker (activation run — explicitly O class)",
    () => {},
    () => wakeWrite({ details: { activateFor: "x-original-0001" } }),
  );
  rejected(
    "reply correlation absent (an ordinary wake or a reply-revival dispatch)",
    () => {},
    () => wakeWrite({ details: { reply: undefined } }),
  );
  rejected(
    "reply-revival shape: inReplyTo present, reply absent",
    () => {},
    () => wakeWrite({ details: { reply: undefined, inReplyTo: "q00000000000000abcd" } }),
  );
  rejected(
    "from.sessionId empty / missing / wrong type",
    () => {},
    () => wakeWrite({ details: { from: { sessionId: "" } } }),
  );
  rejected(
    "from not an object",
    () => {},
    () => wakeWrite({ details: { from: "sess-req-00000009abcdef0" } }),
  );
  rejected(
    "reply.requestId malformed (not q + 18 hex)",
    () => {},
    () => wakeWrite({ details: { reply: { requestId: "not-a-q-id", dueAt: T0 + 1_800_000 } } }),
  );
  rejected(
    "reply.requestId wrong type",
    () => {},
    () => wakeWrite({ details: { reply: { requestId: 42, dueAt: T0 + 1_800_000 } } }),
  );
  rejected(
    "reply.dueAt NaN / Infinity / string",
    () => {},
    () => wakeWrite({ details: { reply: { requestId: ORIGIN_REQ, dueAt: Number.NaN } } }),
  );
  rejected(
    "reply not an object",
    () => {},
    () => wakeWrite({ details: { reply: "q0000000000000000aa" } }),
  );
  rejected(
    "xsWake absent (a deliver-only write is not a dispatch)",
    () => {},
    () => wakeWrite({ details: { xsWake: undefined } }),
  );
  rejected(
    "xsWake not true",
    () => {},
    () => wakeWrite({ details: { xsWake: "true" } }),
  );
  rejected(
    "customType not subagent:xs",
    () => {},
    () => wakeWrite({ customType: "subagent:xs-reply" }),
  );
});

describe("xs ask redirect origin capture — out-of-band forgeries", () => {
  it("a forged branch entry (appendCustomMessageEntry) never passes through the tap ⇒ O class", () => {
    const r = makeRig();
    // Another extension writes a perfect-looking wake entry straight into the session branch —
    // it never traverses the stack's host.sendMessage, so the tap sees nothing.
    const forgedBranchEntry = {
      type: "custom_message",
      customType: "subagent:xs",
      content: "fenced",
      details: wakeWrite().details,
    };
    expect(forgedBranchEntry.details).toMatchObject({ xsWake: true, wakeToken: TOKEN });
    r.controller.state = "bound";
    expect(r.ledger.get(TOKEN)?.askOrigin).toBeUndefined();
    expect(r.redirect.ask(askBody)).toBeUndefined();
  });

  it("a dispatch for ANOTHER token (ambiguous duplicate) is rejected even with a live record", () => {
    const r = makeRig();
    r.ledger.put({
      token: "tok-second-0001",
      sessionId: SID,
      xid: "xid-second-0001",
      dispatchedAt: T0,
      deadlineAt: T0 + 900_000,
    });
    // the controller owns TOKEN; a candidate naming tok-second-0001 fails the activeToken check
    r.redirect.observeWrite(wakeWrite({ details: { wakeToken: "tok-second-0001", xid: "xid-second-0001" } }));
    expect(r.ledger.get(TOKEN)?.askOrigin).toBeUndefined();
    expect(r.ledger.get("tok-second-0001")?.askOrigin).toBeUndefined();
  });

  it("tampered ask_user parameters cannot steer the redirect (no to/from/replyTo surface)", async () => {
    const r = makeRig({ withAskOrigin: true, controllerState: "bound" });
    const hostile = {
      render: (): string => "1: a",
      to: "sess-attacker-00001",
      from: REQ,
      replyTo: "q0000000000000beef",
      wake: true,
    } as unknown as Parameters<XsAskRedirect["ask"]>[0];
    const p = r.redirect.ask(hostile);
    expect(p).toBeDefined();
    await p;
    expect(r.sends[0]!.to).toBe(REQ); // only the captured origin ever names the destination
  });
});
