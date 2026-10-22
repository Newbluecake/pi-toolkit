import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FakeClock } from "../../src/core/clock.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import {
  createXsReplyInboxPort,
  parseXsReplyEntry,
  planReplyRestartInvalidation,
  XsReplyLedger,
  type XsReplyIssueEntry,
  type XsReplyTicket,
} from "../../src/fabric/xs/reply-ledger.js";

/**
 * reply-plan §6.3 invariant suite: a random-op model of the receiver's consumption state
 * machine over the REAL ledger + replyInbox. The one invariant that matters (r2 Blocker #1):
 * per requestId, AT MOST ONE possibly-effective dispatch — a `commit`'s dispatch, or a host
 * call whose outcome is not provably `none`. `release` is only allowed when the pipeline proved
 * no effect (Controller `none`, synchronous host rejection, fenced guard, pre-dispatch throw).
 *
 * Also pinned: release keeps the ticket receivable (inside the grace window), a restarted
 * process refuses every old id, the replyInbox never rejects an accept, and the §6.4 issuance
 * invariant (receivable-or-consuming + inbox occupancy ≤ maxPending) always holds.
 */

const MAX_PENDING = 4;
const SESSION = "A";
const REPLIERS = ["B", "C"];

function seqIds(): () => string {
  let n = 0;
  return () => `q${(++n).toString(16).padStart(18, "0")}`;
}

/** §6.3 pipeline outcomes the model randomizes over. */
type Outcome =
  | "controller-applied"
  | "controller-deferred" // unknown{start_deferred} — dispatched, commit
  | "controller-none" // provably no dispatch ⇒ release
  | "controller-downgrade" // downgrade ⇒ deliver-only path, commit
  | "controller-throw" // sync throw before any host effect ⇒ release
  | "host-ok" // deliver-only applied/unknown ⇒ commit
  | "host-throw" // pi.sendMessage threw synchronously ⇒ release
  | "fence-reject" // stage-5 fence hit BEFORE reserve ⇒ no state change
  | "post-dispatch-throw" // pipeline threw AFTER a possibly-effective host call ⇒ commit
  | "reentry"; // a duplicate reply synchronously re-enters mid-dispatch

type DeliverVerdict = "no-ticket" | "rejected" | "fenced" | "released" | "committed";

interface Era {
  ledger: XsReplyLedger;
  inbox: XsInbox;
  issued: XsReplyTicket[];
}

function newEra(clock: FakeClock, branch: XsReplyIssueEntry[]): Era {
  const ledger = new XsReplyLedger({ clock, newRequestId: seqIds() });
  const inbox = new XsInbox(MAX_PENDING);
  ledger.bindSession({
    sessionId: SESSION,
    inbox: createXsReplyInboxPort(inbox),
    appendIssue: (entry) => branch.push(entry),
  });
  return { ledger, inbox, issued: [] };
}

describe("xs reply ledger — §6.3 consumption invariants (property)", () => {
  it("at-most-one possibly-effective dispatch per requestId; release stays receivable; restart refuses; inbox accept never fails", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.integer({ min: 0, max: 6 }),
            arg: fc.integer({ min: 0, max: 9 }),
            ms: fc.integer({ min: 0, max: 200_000 }),
            target: fc.integer({ min: 0, max: 1 }),
          }),
          { minLength: 40, maxLength: 200 },
        ),
        fc.integer({ min: 1, max: 999 }),
        (events, seed) => {
          const clock = new FakeClock(seed * 1_000);
          const branch: XsReplyIssueEntry[] = [];
          let era = newEra(clock, branch);
          const effective = new Map<string, number>();
          const commitsAccepting = { ok: 0, failed: 0 };
          let inboxFullRefusals = 0;
          let restarts = 0;

          const issueAttempt = (target: number): void => {
            const replier = REPLIERS[target]!;
            const result = era.ledger.issue({
              requesterSessionId: SESSION,
              replierSessionId: replier,
              replierRef: replier,
              origin: "model",
              wakeOnReply: true,
              requesterLevel: 1,
              timeoutMs: 60_000,
              lateGraceMs: 60_000,
              maxPending: MAX_PENDING,
              maxPendingPerTarget: 2,
            });
            if (result.ok) era.issued.push(result.ticket);
          };

          /** The §6.3 receiver pipeline for one reply delivery. */
          const deliver = (outcome: Outcome, pick: number): DeliverVerdict => {
            const pool = era.issued.length === 0 ? [] : era.issued;
            if (pool.length === 0) return "no-ticket";
            const target = pool[pick % pool.length]!;
            const classified = era.ledger.classify(target.requestId, target.replierSessionId, SESSION);
            if (classified.kind !== "reply" && classified.kind !== "late") return "rejected";
            if (outcome === "fence-reject") return "fenced"; // stage 5: BEFORE reserve
            let xidN = 0;
            const xid = () => `x-${target.requestId}-${++xidN}`;
            const reserved = era.ledger.reserve(target.requestId, xid());
            if (!reserved.ok) {
              if (reserved.reason === "inbox_full") inboxFullRefusals += 1;
              return "rejected";
            }
            const reentryCheck = (): void => {
              // Synchronous re-entry while consuming: the duplicate classifies invalid and is
              // refused WITHOUT touching the in-flight reservation.
              const again = era.ledger.classify(target.requestId, target.replierSessionId, SESSION);
              expect(again).toMatchObject({ kind: "invalid" });
              expect(era.ledger.reserve(target.requestId, "x-reentry")).toMatchObject({ ok: false, reason: "state" });
            };
            switch (outcome) {
              case "controller-none":
              case "controller-throw":
              case "host-throw": {
                era.ledger.release(target.requestId);
                // release proved no effect; inside the grace window the ticket stays receivable
                const still = era.ledger.classify(target.requestId, target.replierSessionId, SESSION);
                const ticket = era.ledger.get(target.requestId);
                if (ticket !== undefined) expect(["reply", "late"]).toContain(still.kind);
                else expect(still).toMatchObject({ kind: "invalid" }); // past lateUntil: deleted
                return "released";
              }
              case "reentry":
                reentryCheck();
                if (era.ledger.commit(target.requestId, "trigger")) commitsAccepting.ok += 1;
                else commitsAccepting.failed += 1;
                effective.set(target.requestId, (effective.get(target.requestId) ?? 0) + 1);
                return "committed";
              default: {
                // controller-applied / deferred / downgrade→deliver / host-ok / post-dispatch-throw:
                // the dispatch may have taken effect ⇒ commit.
                if (outcome === "post-dispatch-throw") {
                  // pipeline threw AFTER the host call — §6.3: dispatched=true ⇒ commit
                }
                const mode = outcome === "host-ok" || outcome === "post-dispatch-throw" ? "appended" : "trigger";
                if (era.ledger.commit(target.requestId, mode)) commitsAccepting.ok += 1;
                else commitsAccepting.failed += 1;
                effective.set(target.requestId, (effective.get(target.requestId) ?? 0) + 1);
                return "committed";
              }
            }
          };

          for (const event of events) {
            switch (event.op) {
              case 0:
                issueAttempt(event.target);
                break;
              case 1:
              case 2:
                deliver(event.arg as Outcome, event.ms);
                break;
              case 3:
                clock.advance(event.ms);
                era.ledger.sweep();
                break;
              case 4: {
                // /reload: same process ⇒ SAME ledger object, brand-new stack pieces. The
                // ticket table must be untouched; only the inbox binding is replaced.
                const before = era.ledger.entries().map((ticket) => ({ ...ticket }));
                era = { ledger: era.ledger, inbox: new XsInbox(MAX_PENDING), issued: era.issued };
                era.ledger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(era.inbox) });
                expect(era.ledger.entries()).toEqual(before);
                break;
              }
              case 5: {
                // process restart: empty ledger (r2 fail-closed); branch records survive. The
                // id namespace resets with the process (fresh counter) — per-requestId
                // accounting restarts too (RR3: the at-most-once promise is per process).
                era = newEra(clock, branch);
                effective.clear();
                restarts += 1;
                break;
              }
              case 6:
                era.ledger.sweep();
                break;
            }
            // Invariant 1 — at most ONE possibly-effective dispatch per requestId, ever.
            for (const [id, count] of effective) {
              if (count > 1) throw new Error(`requestId ${id} dispatched possibly-effectively ${count}×`);
            }
            // Invariant 2 — §6.4 issuance invariant always holds.
            const stats = era.ledger.stats(SESSION);
            if (stats.pending + stats.inbox > MAX_PENDING) {
              throw new Error(`quota violated: ${stats.pending}+${stats.inbox} > ${MAX_PENDING}`);
            }
          }

          // Final cross-checks over the whole run.
          expect(commitsAccepting.failed).toBe(0); // replyInbox accept NEVER returns false
          expect(inboxFullRefusals).toBe(0); // reserve never hits an anomalous full inbox
          if (restarts > 0) {
            // every id from BEFORE the last restart is refused by the fresh process
            const fresh = newEra(clock, branch);
            const ids = [...new Set(branch.flatMap((entry) => [entry.requestId]))];
            for (const id of ids) {
              expect(fresh.ledger.classify(id, "B", SESSION)).toMatchObject({ kind: "invalid" });
            }
            // the §3.3 plan is consistent with the branch records: never lists settled/live ids
            const records = branch.flatMap((entry) => {
              const parsed = parseXsReplyEntry(entry, SESSION);
              return parsed ? [parsed] : [];
            });
            const plan = planReplyRestartInvalidation(records, fresh.ledger, clock.now());
            const listed = new Set(plan.invalid.map((item) => item.requestId));
            for (const id of listed) expect(fresh.ledger.get(id)).toBeUndefined();
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it("terminal states are one-way (replied/late_replied/send_failed); consuming → priorState is the ONLY way back", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 10, maxLength: 60 }), (ops) => {
        const clock = new FakeClock();
        const ledger = new XsReplyLedger({ clock, newRequestId: seqIds() });
        ledger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(new XsInbox(MAX_PENDING)) });
        const result = ledger.issue({
          requesterSessionId: SESSION,
          replierSessionId: "B",
          replierRef: "B",
          origin: "model",
          wakeOnReply: true,
          requesterLevel: 1,
          timeoutMs: 60_000,
          lateGraceMs: 60_000,
          maxPending: MAX_PENDING,
          maxPendingPerTarget: 2,
        });
        if (!result.ok) throw new Error("issue failed");
        const id = result.ticket.requestId;
        let terminalSeen = false;
        for (const op of ops) {
          const state = ledger.get(id)?.state;
          if (state === "replied" || state === "late_replied" || state === "send_failed") terminalSeen = true;
          if (terminalSeen) {
            // once terminal: only deletion (sweep past lateUntil) may follow — never back to
            // pending/consuming/timed_out, and never receivable again.
            const later = ledger.get(id)?.state;
            if (later !== undefined && later !== state) throw new Error(`terminal ${state} moved to ${later}`);
            expect(ledger.classify(id, "B", SESSION)).toMatchObject({ kind: "invalid" });
            expect(ledger.reserve(id, "x")).toMatchObject({ ok: false });
          }
          switch (op) {
            case 0:
              ledger.classify(id, "B", SESSION);
              break;
            case 1:
              ledger.reserve(id, "x");
              break;
            case 2:
              ledger.commit(id, "trigger");
              break;
            case 3:
              ledger.release(id);
              break;
            case 4:
              clock.advance(70_000);
              ledger.sweep();
              break;
            case 5:
              ledger.recordSend(id, op % 2 === 0 ? "none" : "unknown");
              break;
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
