import { describe, expect, it, vi } from "vitest";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";
import { interruptedFromJournal } from "../../src/core/run-journal.js";
import { createMentionChannel } from "../../src/fabric/mention.js";
import { inboxDurability } from "../../src/fabric/wake.js";
import {
  flush,
  inboxRecord,
  inboxRig,
  runEntry,
  sender,
  sessionFile,
  snapshot,
  successor,
  target,
} from "../helpers/fabric-inbox.js";

const reserved = () => inboxRecord({ reserved: { rsv: "reservation", runId: successor, at: 0 } });
const terminalSnapshot = (diag: Partial<ReturnType<typeof snapshot>["diag"]> = {}) => {
  const s = snapshot(successor, { status: "failed", phase: "settled" });
  return { ...s, diag: { ...s.diag, ...diag } };
};

describe("W3 persistence capabilities / parking", () => {
  it("uses getSessionFile capability, not file existence, and never probes it without readBack", () => {
    const file = vi.fn(() => "/not-created-yet.jsonl");
    expect(inboxDurability(false, { getSessionFile: file })).toBe("stack-memory");
    expect(file).not.toHaveBeenCalled();
    expect(inboxDurability(true, { getSessionFile: file })).toBe("disk");
    expect(inboxDurability(true, { getSessionFile: () => undefined })).toBe("session-memory");
    expect(inboxDurability(true, {})).toBe("session-memory");
  });
  it.each(["disk", "session-memory"] as const)(
    "parks finding once in %s, enforces cap and dead-letters exactly at TTL",
    (durability) => {
      const h = inboxRig({ durability });
      for (let i = 0; i < 8; i++) {
        const admitted = h.router.admit(sender, {
          to: target,
          kind: "finding",
          text: `payload ${i}`,
          generation: 1,
          wake: false,
          canMessage: ["sibling"],
        });
        expect(admitted).toMatchObject({
          ok: true,
          wake: false,
          ...(durability === "session-memory" ? { inboxDurability: durability } : {}),
        });
        if (!admitted.ok) throw new Error(admitted.status);
        expect(h.store.list().find((r) => r.key === admitted.key)).toMatchObject({
          state: "pending",
          parked: { at: 0, reason: "wake_false" },
        });
      }
      expect(
        h.router.admit(sender, {
          to: target,
          kind: "finding",
          text: "overflow",
          generation: 1,
          wake: false,
          canMessage: ["sibling"],
        }),
      ).toMatchObject({ ok: false, status: "target_backpressure" });
      h.mailbox.pump();
      expect(h.wake.stats().parked).toBe(8);
      expect(h.mailbox.inFlightCount).toBe(0);
      h.clock.advance(1000);
      const parked = h.engine.select((r) => r.parked !== undefined);
      expect(parked).toHaveLength(8);
      expect(parked.every((r) => r.state === "abandoned" && r.deadLetter?.reason === "ttl_expired")).toBe(true);
      h.mailbox.dispose();
    },
  );
  it("stack-memory uses legacy target_gone with an explicit parkUnavailable receipt", () => {
    const h = inboxRig({ durability: "stack-memory" });
    const result = h.router.admit(sender, {
      to: target,
      kind: "finding",
      text: "x",
      generation: 1,
      wake: false,
      canMessage: ["sibling"],
    });
    expect(result).toMatchObject({ ok: true, parkUnavailable: "stack_memory" });
    h.mailbox.pump();
    expect(h.engine.select((r) => r.to === target)[0]).toMatchObject({
      state: "dropped",
      deadLetter: { reason: "target_gone" },
    });
    expect(h.wake.stats().parked).toBe(0);
    h.mailbox.dispose();
  });
  it("progress never parks and wake:true progress is rejected", () => {
    const h = inboxRig();
    expect(
      h.router.admit(sender, {
        to: target,
        kind: "progress",
        text: "x",
        generation: 1,
        wake: true,
        canMessage: ["sibling"],
      }),
    ).toMatchObject({ status: "invalid_wake" });
    h.router.admit(sender, {
      to: target,
      kind: "progress",
      text: "x",
      generation: 1,
      wake: false,
      canMessage: ["sibling"],
    });
    h.mailbox.pump();
    expect(h.engine.select((r) => r.kind === "progress")[0]).toMatchObject({
      state: "dropped",
      terminalReason: "target_gone",
    });
    expect(h.wake.stats().parked).toBe(0);
    h.mailbox.dispose();
  });
  it("handles the running-to-terminal race and wake-refused downgrade without resuming", () => {
    const h = inboxRig();
    const other = "r_12345678";
    h.snapshots.set(other, snapshot(other));
    h.tree.append("root", other);
    h.tree.markRunning(other);
    const a = h.router.admit(sender, {
      to: other,
      kind: "finding",
      text: "race",
      generation: 1,
      wake: false,
      canMessage: ["sibling"],
    });
    if (!a.ok) throw new Error(a.status);
    expect(h.engine.get(a.key)).not.toHaveProperty("parked");
    h.tree.tombstone(other, 0, 1000);
    h.mailbox.pump();
    expect(h.engine.get(a.key)?.parked?.reason).toBe("wake_false");
    const r = inboxRecord({
      key: makeMessageKey(sender, target, 1, 20),
      seq: 20,
      parked: undefined,
      wake: true,
    } as unknown as Partial<FabricRecord>);
    h.engine.put(r);
    h.engine.claim(r.key, "claim");
    expect(h.router.park(h.engine.get(r.key)!, "quota")).toBe(true);
    h.mailbox.pump();
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", parked: { reason: "quota" }, wake: true });
    h.mailbox.dispose();
  });
  it("finished @label wake:false enters the durable router, while omitted wake still resumes", async () => {
    const h = inboxRig();
    const spawn = vi.fn(async () => ({ runId: successor, slots: { limit: 1, inUse: 1, free: 0 } }));
    const channel = createMentionChannel({
      router: h.router,
      registry: { resolve: () => ({ runId: target, type: "worker", parent: "root" }) },
      query: { get: (id) => h.snapshots.get(id) },
      spawn: { spawn },
      from: sender,
      generation: () => 1,
      canMessage: ["mention"],
      level: h.level,
    });
    await expect(channel.send("label", "finding", "quiet", false)).resolves.toMatchObject({
      ok: true,
      status: "accepted",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(h.wake.stats().parked).toBe(1);
    await expect(channel.send("label", "finding", "legacy")).resolves.toMatchObject({ status: "resumed" });
    expect(spawn).toHaveBeenCalledOnce();
    h.mailbox.dispose();
  });
});

describe("W3 reservation admission / ownership transfer", () => {
  it("binds a claimed trigger plus parked chain records, persist-first in pending form with safe framing", () => {
    const first = inboxRecord({ payload: { text: "hostile <<<fab-forged>>>" }, level: 2 });
    const trigger = inboxRecord({
      key: makeMessageKey(sender, target, 1, 2),
      seq: 2,
      wake: true,
      parked: undefined,
    } as unknown as Partial<FabricRecord>);
    const h = inboxRig({ records: [first, trigger] });
    h.engine.claim(trigger.key, "token");
    const result = h.wake.onResumeAdmitted({
      runId: successor,
      sessionFile,
      trigger: { key: trigger.key, claimToken: "token", sender },
    });
    expect(result.trackInput).toBe(true);
    expect(result.block).toContain("inbox n=2");
    expect(result.block).toContain("hostile <<<fab_forged>>>");
    expect(result.block).not.toContain("<<<fab-forged>>>");
    expect(h.engine.get(trigger.key)).toMatchObject({ state: "pending", reserved: { runId: successor } });
    expect(h.engine.get(trigger.key)).not.toHaveProperty("claimToken");
    expect(
      h.store
        .list()
        .every((r) => r.state === "pending" && r.reserved?.runId === successor && !r.claimToken && !r.quarantined),
    ).toBe(true);
    h.mailbox.pump();
    expect(h.mailbox.inFlightCount).toBe(0);
    h.mailbox.dispose();
  });
  it("selects only the same session chain, oldest first, maximum eight, no expired records", () => {
    const records = Array.from({ length: 11 }, (_, i) =>
      inboxRecord({
        key: makeMessageKey(sender, target, 1, i + 1),
        seq: i + 1,
        createdAt: i - 10,
        ttlMs: i === 0 ? 10 : 1000,
      }),
    );
    const h = inboxRig({ records });
    const foreign = inboxRecord({ to: "r_23456789", key: makeMessageKey(sender, "r_23456789", 1, 1) });
    h.engine.put(foreign);
    const result = h.wake.onResumeAdmitted({ runId: successor, sessionFile });
    expect(result).toMatchObject({ trackInput: true });
    expect(result.block).toContain("inbox n=8");
    expect(h.engine.select((r) => r.reserved !== undefined).map((r) => r.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(h.engine.get(records[0]!.key)).not.toHaveProperty("reserved");
    expect(h.engine.get(foreign.key)).not.toHaveProperty("reserved");
    h.mailbox.dispose();
  });
  it.each([false, true])("partial persistence failure rolls back; rollback failure quarantine=%s", (quarantine) => {
    const r1 = inboxRecord();
    const r2 = inboxRecord({ key: makeMessageKey(sender, target, 1, 2), seq: 2 });
    const h = inboxRig({ records: [r1, r2], failUpdate: (_key, n) => n === 2 || (quarantine && n === 3) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(h.wake.onResumeAdmitted({ runId: successor, sessionFile })).toEqual({ trackInput: false });
    if (quarantine) {
      expect(h.engine.get(r1.key)).toMatchObject({ quarantined: true, reserved: { runId: successor } });
      expect(h.store.list()[0]).not.toHaveProperty("quarantined");
      h.mailbox.pump();
      expect(h.engine.get(r1.key)).toMatchObject({ state: "consumed", terminalReason: "reservation_quarantined" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fabric inbox reservation_quarantined"));
    } else expect(h.engine.get(r1.key)).not.toHaveProperty("reserved");
    expect(h.engine.get(r2.key)).not.toHaveProperty("reserved");
    warn.mockRestore();
    h.mailbox.dispose();
  });
  it("partial failure restores the trigger claim so retry attempts/backoff cannot be evaded", async () => {
    const trigger = inboxRecord({
      to: sender,
      key: makeMessageKey(sender, sender, 1, 1),
      wake: true,
      parked: undefined,
    } as unknown as Partial<FabricRecord>);
    const parked = inboxRecord();
    let sends = 0;
    const h = inboxRig({
      records: [trigger, parked],
      failUpdate: (key) => key === parked.key,
      inject: async (r) => {
        if (r.kind === "dead_letter") return { ok: true };
        sends++;
        expect(
          h.wake.onResumeAdmitted({
            runId: successor,
            sessionFile,
            trigger: { key: r.key, claimToken: r.claimToken!, sender },
          }),
        ).toEqual({ trackInput: false, persistFailed: true });
        expect(h.engine.get(r.key)).toMatchObject({ state: "claimed", claimToken: r.claimToken });
        return { ok: false, retryable: true, reason: "inbox_persist_failed" };
      },
    });
    h.mailbox.pump();
    await flush();
    expect(sends).toBe(1);
    expect(h.engine.get(trigger.key)).toMatchObject({ state: "pending", attempts: 1 });
    h.mailbox.pump();
    await flush();
    expect(sends).toBe(1);
    h.clock.advance(10);
    await flush();
    expect(sends).toBe(2);
    h.clock.advance(20);
    await flush();
    expect(sends).toBe(3);
    expect(h.engine.get(trigger.key)).toMatchObject({
      state: "dropped",
      attempts: 3,
      deadLetter: { reason: "attempts_exhausted" },
    });
    h.mailbox.dispose();
  });
  it("failed trigger claim restoration quarantines rather than returning a deliverable record", () => {
    const trigger = inboxRecord();
    const parked = inboxRecord({ key: makeMessageKey(sender, target, 1, 2), seq: 2 });
    const h = inboxRig({ records: [trigger, parked], failUpdate: (_key, n) => n === 2 });
    h.engine.claim(trigger.key, "original");
    const restore = vi.spyOn(h.engine, "claim").mockReturnValue(undefined);
    expect(
      h.wake.onResumeAdmitted({
        runId: successor,
        sessionFile,
        trigger: { key: trigger.key, claimToken: "original", sender },
      }),
    ).toEqual({ trackInput: false, persistFailed: true });
    expect(h.engine.get(trigger.key)).toMatchObject({ state: "pending", quarantined: true });
    h.mailbox.pump();
    expect(h.engine.get(trigger.key)?.terminalReason).toBe("reservation_quarantined");
    restore.mockRestore();
    h.mailbox.dispose();
  });
  it("trigger persistence failure refuses admission; a claim conflict is never silently bound", () => {
    const r = inboxRecord();
    const h = inboxRig({ records: [r], failUpdate: () => true });
    h.engine.claim(r.key, "held");
    expect(
      h.wake.onResumeAdmitted({ runId: successor, sessionFile, trigger: { key: r.key, claimToken: "held", sender } }),
    ).toEqual({ trackInput: false, persistFailed: true });
    expect(h.engine.get(r.key)).toMatchObject({ state: "claimed", claimToken: "held" });
    expect(
      h.wake.onResumeAdmitted({ runId: successor, sessionFile, trigger: { key: r.key, claimToken: "wrong", sender } }),
    ).toEqual({ trackInput: false, persistFailed: true });
    h.mailbox.dispose();
  });
  it("ownership transfer clears inFlight on verdict, then makes finite progress with no reserved-message spin", async () => {
    const r = inboxRecord({ parked: undefined } as unknown as Partial<FabricRecord>);
    let sends = 0;
    const h = inboxRig({
      records: [r],
      inject: async (record) => {
        sends++;
        expect(
          h.engine.reserveStrict(
            record.key,
            { state: "claimed", claimToken: record.claimToken! },
            { rsv: "owned", runId: successor, at: 0 },
            0,
            record.ttlMs,
          ),
        ).toEqual({ ok: true });
        return { ok: true };
      },
    });
    // Point at a running node; the injected port stands in for W5's synchronous revive admission.
    h.engine.annotate(r.key, { to: sender });
    h.mailbox.pump();
    expect(h.mailbox.inFlightCount).toBe(1);
    await flush();
    expect(h.mailbox.inFlightCount).toBe(0);
    expect(sends).toBe(1);
    h.mailbox.pump();
    await flush();
    expect(sends).toBe(1);
    h.clock.advance(1000);
    expect(h.engine.get(r.key)?.state).toBe("pending");
    h.mailbox.dispose();
  });
});

describe("W3 stale mailbox verdict identity", () => {
  it("an ownership-lost verdict never clears another key's inFlight slot", () => {
    const h = inboxRig();
    const old = inboxRecord();
    h.engine.put(old);
    // The callback seam is private; expose only bookkeeping needed to simulate an out-of-order stale completion.
    const mailbox = h.mailbox as unknown as {
      inFlight: Map<string, string>;
      verdict(key: string, target: string, token: string, v: { ok: true }): void;
    };
    mailbox.inFlight.set(target, "newer-key");
    mailbox.verdict(old.key, target, "obsolete-token", { ok: true });
    expect(mailbox.inFlight.get(target)).toBe("newer-key");
    expect(h.engine.get(old.key)?.state).toBe("pending");
    h.mailbox.dispose();
  });
});

describe("W3 disposition table — live evidence", () => {
  it.each([
    ["accepted while running", { inputAcceptedAt: 0, promptDispatchedAt: 0 }, "running", "resume_injected"],
    ["accepted then failed", { inputAcceptedAt: 1, promptDispatchedAt: 0 }, "failed", "resume_injected"],
    ["no dispatch", {}, "failed", undefined],
    ["rejected pre accept", { promptDispatchedAt: 0, promptOutcome: "rejected_pre_accept" }, "failed", undefined],
    ["attempt timed out", { promptDispatchedAt: 0 }, "timed_out", "resume_unverified"],
    ["attempt cancelled", { promptDispatchedAt: 0 }, "aborted", "resume_unverified"],
    ["external completed without acceptance", { promptDispatchedAt: 0 }, "completed", "resume_unverified"],
  ] as const)("%s", (_label, diag, status, reason) => {
    const h = inboxRig();
    const r = inboxRecord({ level: 2 });
    h.engine.put(r);
    h.wake.onResumeAdmitted({ runId: successor, sessionFile });
    const s = snapshot(successor, { status, diag: { ...snapshot().diag, ...diag } });
    h.snapshots.set(successor, s);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.wake.onSnapshot(s);
    const current = h.engine.get(r.key)!;
    if (reason) expect(current).toMatchObject({ state: "consumed", terminalReason: reason });
    else {
      expect(current.state).toBe("pending");
      expect(current).not.toHaveProperty("reserved");
    }
    if (reason === "resume_injected") {
      expect(current.revivedAs).toBe(successor);
      expect(h.raised).toEqual([{ runId: successor, level: 2 }]);
    }
    if (reason === "resume_unverified") expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    h.mailbox.dispose();
  });
  it("no acceptance on a running attempt remains reserved beyond message TTL", () => {
    const h = inboxRig();
    const r = inboxRecord();
    h.engine.put(r);
    h.wake.onResumeAdmitted({ runId: successor, sessionFile });
    h.snapshots.set(successor, snapshot());
    h.mailbox.pump();
    h.clock.advance(1000);
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", reserved: { runId: successor } });
    h.mailbox.dispose();
  });
  it("strict commit/release failures leave memory reserved and retry on next evidence", () => {
    let fail = true;
    const h = inboxRig({ failUpdate: (_key, n) => n > 1 && fail });
    const r = inboxRecord();
    h.engine.put(r);
    h.wake.onResumeAdmitted({ runId: successor, sessionFile });
    h.wake.onSnapshot(terminalSnapshot());
    expect(h.engine.get(r.key)?.reserved).toBeDefined();
    fail = false;
    h.wake.onSnapshot(terminalSnapshot());
    expect(h.engine.get(r.key)).not.toHaveProperty("reserved");
    h.wake.onResumeAdmitted({ runId: successor, sessionFile });
    fail = true;
    h.wake.onSnapshot(terminalSnapshot({ inputAcceptedAt: 0 }));
    expect(h.engine.get(r.key)?.state).toBe("pending");
    fail = false;
    h.wake.onSnapshot(terminalSnapshot({ inputAcceptedAt: 0 }));
    expect(h.engine.get(r.key)?.state).toBe("consumed");
    h.mailbox.dispose();
  });
  it("runner throw before any snapshot releases its reservations", () => {
    const h = inboxRig();
    const r = inboxRecord();
    h.engine.put(r);
    h.wake.onResumeAdmitted({ runId: successor, sessionFile });
    h.wake.onRunGone(successor);
    expect(h.engine.get(r.key)).not.toHaveProperty("reserved");
    h.mailbox.dispose();
  });
});

describe("W3 five crash windows and recovery disposition", () => {
  it("① crash after reserve before start: no run entry is ambiguous, audited consume", () => {
    const r = reserved();
    const h = inboxRig({ records: [r] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.wake.reconcile();
    expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "resume_unverified" });
    expect(warn).toHaveBeenCalledOnce();
    expect(h.reads).toBe(0);
    warn.mockRestore();
    h.mailbox.dispose();
  });
  it("② accepted then crash: journal-only (even with acceptance) is never retried", () => {
    const r = reserved();
    const s = snapshot();
    s.diag.inputAcceptedAt = 0;
    const h = inboxRig({ records: [r], entries: [runEntry(s)] });
    h.snapshots.set(successor, interruptedFromJournal(s));
    h.wake.reconcile();
    expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "resume_unverified" });
    h.mailbox.dispose();
  });
  it.each([
    ["③ terminal without dispatch", {}, undefined],
    ["terminal rejected-pre-accept", { promptDispatchedAt: 0, promptOutcome: "rejected_pre_accept" }, undefined],
    ["terminal accepted", { inputAcceptedAt: 0, promptDispatchedAt: 0 }, "resume_injected"],
    ["terminal attempted without acceptance", { promptDispatchedAt: 0 }, "resume_unverified"],
  ] as const)("%s", (_label, diag, reason) => {
    const r = reserved();
    const s = terminalSnapshot(diag);
    const h = inboxRig({ records: [r], entries: [runEntry(s)] });
    h.wake.reconcile();
    if (reason) expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: reason });
    else expect(h.engine.get(r.key)).not.toHaveProperty("reserved");
    expect(h.reads).toBe(0);
    h.mailbox.dispose();
  });
  it("④ live-session file defers; onReaped re-reads getBranch once and releases on new terminal proof", () => {
    const r = reserved();
    const s = snapshot();
    const live = vi.fn(() => true);
    const h = inboxRig({ records: [r], entries: [runEntry(s)], live });
    h.snapshots.set(successor, interruptedFromJournal(s));
    h.wake.reconcile();
    h.mailbox.pump();
    h.clock.advance(1000);
    expect(h.engine.get(r.key)?.reserved).toBeDefined();
    expect(h.reads).toBe(0);
    h.entries.push(runEntry(terminalSnapshot()));
    h.wake.onReaped(successor);
    expect(h.reads).toBe(1);
    expect(h.engine.get(r.key)).not.toHaveProperty("reserved");
    // Release happened BEFORE TTL: the expired parked message now follows its normal dead-letter path.
    expect(h.engine.get(r.key)?.deadLetter?.reason).toBe("ttl_expired");
    h.wake.onReaped(successor);
    expect(h.reads).toBe(1);
    h.mailbox.dispose();
  });
  it("⑤ 60s timeout rechecks once; still no terminal even if live => audited consume, no rearm", () => {
    const r = reserved();
    const h = inboxRig({ records: [r], entries: [runEntry(snapshot())], live: () => true });
    h.wake.reconcile();
    h.mailbox.pump();
    h.clock.advance(59_999);
    expect(h.engine.get(r.key)?.reserved).toBeDefined();
    expect(h.reads).toBe(0);
    h.clock.advance(1);
    expect(h.reads).toBe(1);
    expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "resume_unverified" });
    h.clock.advance(60_000);
    expect(h.reads).toBe(1);
    h.mailbox.dispose();
  });
  it("an accepted journal on a live session does NOT cause a 1ms recovery spin", () => {
    const r = reserved();
    const journal = snapshot();
    journal.diag.inputAcceptedAt = 0;
    const h = inboxRig({ records: [r], entries: [runEntry(journal)], live: () => true });
    h.wake.reconcile();
    expect(h.wake.nextSweepAt(0)).toBe(60_000);
    h.mailbox.pump();
    h.clock.advance(59_999);
    expect(h.engine.get(r.key)?.reserved).toBeDefined();
    expect(h.reads).toBe(0);
    h.clock.advance(1);
    expect(h.engine.get(r.key)?.terminalReason).toBe("resume_unverified");
    expect(h.reads).toBe(1);
    h.mailbox.dispose();
  });
  it("failed disposition persistence gets a bounded retry wake without spinning", () => {
    let fail = true;
    const r = reserved();
    const h = inboxRig({
      records: [r],
      entries: [runEntry(terminalSnapshot({ inputAcceptedAt: 0 }))],
      failUpdate: () => fail,
    });
    h.mailbox.pump();
    expect(h.engine.get(r.key)?.reserved).toBeDefined();
    expect(h.wake.nextSweepAt(0)).toBe(1000);
    h.clock.advance(999);
    expect(h.engine.get(r.key)?.state).toBe("pending");
    fail = false;
    h.clock.advance(1);
    expect(h.engine.get(r.key)?.terminalReason).toBe("resume_injected");
    h.mailbox.dispose();
  });
  it("a rollback-failed reservation survives reload without the memory-only quarantine flag, then consumes as ambiguous", () => {
    const r = inboxRecord();
    const next = inboxRecord({ key: makeMessageKey(sender, target, 1, 2), seq: 2 });
    const before = inboxRig({ records: [r, next], failUpdate: (_key, n) => n === 2 || n === 3 });
    before.wake.onResumeAdmitted({ runId: successor, sessionFile });
    expect(before.engine.get(r.key)?.quarantined).toBe(true);
    const persisted = JSON.parse(JSON.stringify(before.store.list())) as FabricRecord[];
    expect(persisted[0]).not.toHaveProperty("quarantined");
    expect(persisted[0]?.reserved).toBeDefined();
    before.mailbox.dispose();
    const after = inboxRig({ records: persisted });
    after.wake.reconcile();
    expect(after.engine.get(r.key)?.terminalReason).toBe("resume_unverified");
    after.mailbox.dispose();
  });
  it("missing run entry still defers using the target's session file; disposal cancels the recheck", () => {
    const r = reserved();
    const h = inboxRig({ records: [r], live: () => true });
    h.wake.reconcile();
    expect(h.engine.get(r.key)?.reserved).toBeDefined();
    h.mailbox.dispose();
    h.clock.advance(60_000);
    expect(h.reads).toBe(0);
  });
  it("sweep precedes TTL, processes at most 32, and schedules its own remaining backlog", () => {
    const records = Array.from({ length: 40 }, (_, i) =>
      inboxRecord({
        key: makeMessageKey(sender, target, 1, i + 1),
        seq: i + 1,
        reserved: { rsv: String(i), runId: successor, at: 0 },
      }),
    );
    const h = inboxRig({ records, entries: [runEntry(terminalSnapshot({ inputAcceptedAt: 0 }))] });
    h.clock.advance(1000);
    h.mailbox.pump();
    expect(h.engine.select((r) => r.state === "consumed")).toHaveLength(32);
    expect(h.engine.select((r) => r.state === "pending" && r.reserved !== undefined)).toHaveLength(8);
    h.clock.advance(1);
    expect(h.engine.select((r) => r.terminalReason === "resume_injected")).toHaveLength(40);
    expect(h.engine.select((r) => r.deadLetter !== undefined)).toHaveLength(0);
    h.mailbox.dispose();
  });
  it("reservation hard bound: registry hardDeadline+reap+60s, otherwise reserved.at+24h", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const known of [true, false]) {
      const h = inboxRig();
      const r = inboxRecord();
      h.engine.put(r);
      h.wake.onResumeAdmitted({ runId: successor, sessionFile });
      if (known) h.snapshots.set(successor, snapshot());
      const at = known ? 100_000 + 20 + 60_000 : 24 * 3_600_000;
      h.mailbox.pump();
      h.clock.advance(at - 1);
      expect(h.engine.get(r.key)?.state).toBe("pending");
      h.clock.advance(1);
      expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "reservation_expired" });
      h.mailbox.dispose();
    }
    warn.mockRestore();
  });
});
