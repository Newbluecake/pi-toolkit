import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence, type SessionFence } from "../../src/fabric/xs/fence.js";
import { XsDedup } from "../../src/fabric/xs/dedup.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import { XsReceiver, type XsDeliverHost, type XsDeliverInput } from "../../src/fabric/xs/receiver.js";
import { createXsReplyInboxPort, XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import type { RootWakeDispatchResult } from "../../src/fabric/root-wake.js";

/**
 * RX5 Minor#2 / reply-plan §6.3, §12.1: random event sequences driven through the REAL
 * `XsReceiver` + REAL `XsReplyLedger` + real fence/inbox/dedup (only the pi host and the
 * RootWakeController are scripted). Core invariant: per requestId, AT MOST ONE possibly-effective
 * dispatch — a Controller call that did not provably return `none`/downgrade (dispatched, or
 * threw after the dispatch boundary) or a host `sendMessage` that did not throw synchronously.
 * Events cover duplicate / synchronously re-entrant replies, every Controller verdict, host
 * throws, a fence rejection, sweep timing, wrong senders / unknown ids, and a /reload (a new
 * receiver stack over the SAME process ledger).
 */

const SESSION = "sess-main-0123456789abcdef";
const REPLIER = "sess-other-9876543210fedcba";
const OTHER = "sess-third-00000000000000aa";
const TIMEOUT_MS = 60_000;
const GRACE_MS = 120_000;

type CtlMode = "applied" | "unknown" | "none" | "downgrade" | "throw" | "none-after-fence";
type HostMode = "ok" | "throw" | "reenter" | "busy";

type Ev =
  | { t: "issue"; wake: boolean; human: boolean }
  | { t: "reply"; idx: number; sender: "ok" | "wrong"; fresh: boolean }
  | { t: "unknown_reply" }
  | { t: "ctl"; mode: CtlMode }
  | { t: "host"; mode: HostMode }
  | { t: "fence"; open: boolean }
  | { t: "advance"; ms: number }
  | { t: "sweep" }
  | { t: "reload" }
  | { t: "controller"; present: boolean };

const evArb: fc.Arbitrary<Ev> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("issue" as const), wake: fc.boolean(), human: fc.boolean() }) },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant("reply" as const),
      idx: fc.nat(5),
      sender: fc.constantFrom("ok" as const, "ok" as const, "wrong" as const),
      fresh: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ t: "unknown_reply" as const }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant("ctl" as const),
      mode: fc.constantFrom<CtlMode>("applied", "unknown", "none", "downgrade", "throw", "none-after-fence"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("host" as const),
      mode: fc.constantFrom<HostMode>("ok", "throw", "reenter", "busy"),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("fence" as const), open: fc.boolean() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("advance" as const),
      ms: fc.constantFrom(1, 1_000, TIMEOUT_MS, GRACE_MS, TIMEOUT_MS + GRACE_MS),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ t: "sweep" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "reload" as const }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("controller" as const), present: fc.boolean() }) },
);

describe("xs reply receiver — at-most-once possibly-effective dispatch (property)", () => {
  it("per requestId at most one possibly-effective dispatch, whatever the interleaving", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let totalEffective = 0;
    fc.assert(
      fc.property(fc.array(evArb, { minLength: 1, maxLength: 60 }), (body) => {
        const events: Ev[] = [
          { t: "issue", wake: true, human: false },
          { t: "issue", wake: false, human: true },
          ...body,
        ];
        const clock = new FakeClock(1_000);
        const ledger = new XsReplyLedger({ clock });
        const effective = new Map<string, number>();
        const bump = (id: string | undefined): void => {
          if (id !== undefined) effective.set(id, (effective.get(id) ?? 0) + 1);
        };
        let ctlMode: CtlMode = "applied";
        let hostMode: HostMode = "ok";
        let controllerPresent = true;
        let xidSeq = 0;
        const issued: string[] = [];
        let fenceOpen = false;
        let stackSeq = 0;

        interface Stack {
          receiver: XsReceiver;
          fence: SessionFence;
          membership: XsMembership;
          setHostIdle(v: boolean): void;
          host: XsDeliverHost;
        }
        const build = (): Stack => {
          stackSeq++;
          const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => {}, replyEnabled: true });
          membership.attach();
          membership.join();
          membership.setReceive("wake");
          const fence = createSessionFence({ clock });
          const replyInbox = new XsInbox(4, clock);
          ledger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(replyInbox) });
          let idle = true;
          const host: XsDeliverHost = {
            isIdle: () => idle,
            hasPendingMessages: () => false,
            sendMessage: (message) => {
              const id = (message.details as { inReplyTo?: string } | undefined)?.inReplyTo;
              if (hostMode === "throw") throw new Error("host rejected");
              bump(id);
              if (hostMode === "reenter" && id !== undefined) {
                // a synchronous duplicate must be refused while the ticket is `consuming`
                receiverRef.current?.deliver(mkInput(id, REPLIER, `re${xidSeq++}`));
              }
            },
            getLeafEntry: () => undefined,
          };
          const receiver = new XsReceiver({
            sessionId: SESSION,
            membership,
            fence,
            inbox: new XsInbox(12, clock),
            replyLedger: ledger,
            recvPerHour: 1000,
            wakesInPerHour: 1000,
            host,
            dedup: new XsDedup(256, clock),
            clock,
            warn: () => {},
          });
          const apply = (): void => {
            receiver.setController(
              controllerPresent
                ? {
                    dispatch: (request): RootWakeDispatchResult => {
                      const id = request.inReplyTo;
                      switch (ctlMode) {
                        case "applied":
                          bump(id);
                          return { dispatched: true, effect: "applied", woke: true, token: "t" };
                        case "unknown":
                          bump(id);
                          return {
                            dispatched: true,
                            effect: "unknown",
                            woke: true,
                            token: "t",
                            reason: "start_deferred",
                          };
                        case "none":
                          return { dispatched: false, effect: "none", reason: "rejected", woke: false };
                        case "downgrade":
                          return { dispatched: false, wakeDowngraded: "busy" };
                        case "none-after-fence":
                          fence.onEvent({ type: "session_before_compact" });
                          return { dispatched: false, wakeDowngraded: "busy" };
                        case "throw":
                          bump(id); // thrown after the dispatch boundary ⇒ possibly effective
                          throw new Error("controller boom");
                      }
                    },
                  }
                : undefined,
            );
          };
          applyRef.current = apply;
          apply();
          return {
            receiver,
            fence,
            membership,
            setHostIdle: (v) => {
              idle = v;
            },
            host,
          };
        };
        const receiverRef: { current: XsReceiver | undefined } = { current: undefined };
        const applyRef: { current: (() => void) | undefined } = { current: undefined };
        const mkInput = (requestId: string | undefined, from: string, xid: string): XsDeliverInput => ({
          xid,
          to: { sessionId: SESSION, epoch: stack.membership.epoch },
          from: { sessionId: from, ref: "ab12cd34ef56", cwdLabel: "~/p" },
          text: "reply",
          wake: false,
          expiresAt: clock.now() + 5_000,
          ...(requestId === undefined ? {} : { inReplyTo: requestId }),
        });
        let stack = build();
        receiverRef.current = stack.receiver;

        for (const ev of events) {
          switch (ev.t) {
            case "issue": {
              const r = ledger.issue({
                requesterSessionId: SESSION,
                replierSessionId: REPLIER,
                replierRef: "ab12cd34ef56",
                origin: ev.human ? "human" : "model",
                wakeOnReply: ev.wake,
                requesterLevel: 1,
                timeoutMs: TIMEOUT_MS,
                lateGraceMs: GRACE_MS,
                maxPending: 4,
                maxPendingPerTarget: 4,
              });
              if (r.ok) issued.push(r.ticket.requestId);
              break;
            }
            case "reply": {
              const id = issued[ev.idx % Math.max(1, issued.length)];
              if (id === undefined) break;
              const xid = ev.fresh ? `x${xidSeq++}` : `x${Math.max(0, xidSeq - 1)}`;
              stack.receiver.deliver(mkInput(id, ev.sender === "ok" ? REPLIER : OTHER, xid));
              break;
            }
            case "unknown_reply":
              stack.receiver.deliver(mkInput("q" + "f".repeat(18), REPLIER, `x${xidSeq++}`));
              break;
            case "ctl":
              ctlMode = ev.mode;
              break;
            case "host":
              hostMode = ev.mode;
              stack.setHostIdle(ev.mode !== "busy");
              break;
            case "fence":
              if (ev.open !== fenceOpen) {
                fenceOpen = ev.open;
                stack.fence.onEvent({ type: ev.open ? "session_before_compact" : "session_compact" });
              }
              break;
            case "advance":
              clock.advance(ev.ms);
              break;
            case "sweep":
              ledger.sweep();
              break;
            case "reload":
              // /reload: stack rebuilt, process ledger survives; fence/inbox/dedup start fresh
              ledger.unbindSession(SESSION);
              stack = build();
              receiverRef.current = stack.receiver;
              fenceOpen = false;
              break;
            case "controller":
              controllerPresent = ev.present;
              applyRef.current?.();
              break;
          }
          // Every step: the invariant + no consuming ticket left behind outside a dispatch.
          for (const [id, n] of effective) expect(n, `requestId ${id}`).toBeLessThanOrEqual(1);
          for (const ticket of ledger.entries()) expect(ticket.state).not.toBe("consuming");
          expect(stackSeq).toBeGreaterThan(0);
        }
        for (const n of effective.values()) totalEffective += n;
      }),
      { numRuns: 300 },
    );
    warn.mockRestore();
    expect(totalEffective).toBeGreaterThan(100); // the generator really reaches effective dispatches
  });

  it("sanity: the model really produces effective dispatches and refused duplicates", () => {
    const clock = new FakeClock(1_000);
    const ledger = new XsReplyLedger({ clock });
    const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => {}, replyEnabled: true });
    membership.attach();
    membership.join();
    ledger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(new XsInbox(4, clock)) });
    let sends = 0;
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership,
      fence: createSessionFence({ clock }),
      inbox: new XsInbox(12, clock),
      replyLedger: ledger,
      recvPerHour: 1000,
      wakesInPerHour: 1000,
      host: {
        isIdle: () => true,
        hasPendingMessages: () => false,
        sendMessage: () => {
          sends++;
        },
        getLeafEntry: () => undefined,
      },
      dedup: new XsDedup(256, clock),
      clock,
      warn: () => {},
    });
    const issued = ledger.issue({
      requesterSessionId: SESSION,
      replierSessionId: REPLIER,
      replierRef: "r",
      origin: "human",
      wakeOnReply: false,
      requesterLevel: 0,
      timeoutMs: TIMEOUT_MS,
      lateGraceMs: GRACE_MS,
      maxPending: 4,
      maxPendingPerTarget: 4,
    });
    if (!issued.ok) throw new Error("issue");
    const input = (xid: string): XsDeliverInput => ({
      xid,
      to: { sessionId: SESSION, epoch: membership.epoch },
      from: { sessionId: REPLIER, ref: "r", cwdLabel: "~" },
      text: "t",
      wake: false,
      expiresAt: clock.now() + 5_000,
      inReplyTo: issued.ticket.requestId,
    });
    expect(receiver.deliver(input("a")).effect).not.toBe("none"); // idle host, no leaf proof ⇒ unknown
    expect(receiver.deliver(input("b"))).toMatchObject({ effect: "none", reason: "rejected" });
    expect(sends).toBe(1);
  });
});
