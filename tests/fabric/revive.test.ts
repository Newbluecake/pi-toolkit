import { describe, expect, it } from "vitest";
import type { AdmissionReason } from "../../src/core/types.js";
import { FakeClock } from "../../src/core/clock.js";
import { mapAdmissionReason } from "../../src/fabric/wake.js";
import type { Tombstone } from "../../src/service/tombstone.js";
import { flush, snapshot } from "../helpers/fabric-inbox.js";
import { revivable, reviveRig, sender, sessionFile, target, type DiagPatch } from "../helpers/fabric-revive.js";

void FakeClock;
const pending = (rig: ReturnType<typeof reviveRig>) => rig.engine.select((r) => r.to === target);

describe("W5 admission reason → revive verdict (plan §4.6), row by row", () => {
  const rows: [AdmissionReason | undefined, unknown][] = [
    ["pool_full", { park: "pool_full" }],
    ["load", { park: "load" }],
    ["quota", { park: "quota" }],
    ["session_closing", { park: "session_closing" }],
    ["resume_locked", { park: "resume_locked" }],
    ["inbox_persist_failed", { retry: "inbox_persist_failed" }],
    ["target_running", { retry: "target_running" }],
    ["stack_closed", { hold: true }],
    ["unknown_type", { refuse: "unknown_type" }],
    ["external_unavailable", { refuse: "external_unavailable" }],
    ["config", { refuse: "config" }],
  ];
  it.each(rows)("%s", (reason, verdict) => {
    expect(mapAdmissionReason(reason, "message")).toEqual(verdict);
  });
  it("covers every AdmissionReason value (a new reason must add a row)", () => {
    const covered = new Set(rows.map(([r]) => r));
    const all: AdmissionReason[] = [
      "pool_full",
      "load",
      "quota",
      "resume_locked",
      "session_closing",
      "target_running",
      "stack_closed",
      "unknown_type",
      "external_unavailable",
      "inbox_persist_failed",
      "config",
    ];
    for (const r of all) expect(covered.has(r)).toBe(true);
  });
  it("an admission error with no cause code is a permanent refusal, never a retry loop", () => {
    expect(mapAdmissionReason(undefined, "boom")).toEqual({ refuse: "config:boom" });
  });
});

describe("W5 wake-ability preflight (plan §4.5) — exclusion matrix", () => {
  const check = (diag: DiagPatch, opts: Parameters<typeof reviveRig>[0] = {}) =>
    reviveRig({ snapshots: [revivable(diag)], ...opts }).wake.preflight(target);

  it("a revivable run passes and exposes the pinned facts", () => {
    const r = check({});
    expect(r).toMatchObject({
      ok: true,
      facts: {
        sessionFile,
        agentType: "worker",
        label: "worker-label",
        model: { provider: "p", id: "m" },
        thinking: "high",
      },
    });
  });
  it.each(["consult_fork", "readonly_domain", "caller_owned", "external_agent"] as const)(
    "dispatch-time exclusion %s",
    (reason) => expect(check({ wakeExclusion: reason })).toEqual({ ok: false, reason }),
  );
  it("LEGACY entry without a recorded verdict fails CLOSED (legacy_unknown)", () => {
    expect(check({ wakeExclusion: undefined })).toEqual({ ok: false, reason: "legacy_unknown" });
  });
  it("no session file ⇒ no_session", () => {
    expect(check({ sessionFile: undefined })).toEqual({ ok: false, reason: "no_session" });
  });
  it("worktree: only a KEPT worktree whose path still exists is wakeable", () => {
    for (const state of ["active", "committed", "clean"] as const)
      expect(check({ worktree: { state } })).toEqual({ ok: false, reason: "worktree_gone" });
    expect(check({ worktree: { state: "kept" } })).toEqual({ ok: false, reason: "worktree_gone" });
    expect(check({ worktree: { state: "kept", path: "/wt" } }, { pathExists: () => false })).toEqual({
      ok: false,
      reason: "worktree_gone",
    });
    expect(check({ worktree: { state: "kept", path: "/wt" } }, { pathExists: (p) => p === "/wt" })).toMatchObject({
      ok: true,
    });
  });
  it("a throwing existence probe counts as gone (fail closed)", () => {
    expect(
      check(
        { worktree: { state: "kept", path: "/wt" } },
        {
          pathExists: () => {
            throw new Error("EIO");
          },
        },
      ),
    ).toEqual({ ok: false, reason: "worktree_gone" });
  });
  it("agent type that no longer exists (or was never recorded) ⇒ unknown_type", () => {
    expect(check({}, { types: () => false })).toEqual({ ok: false, reason: "unknown_type" });
    expect(check({ agentType: undefined })).toEqual({ ok: false, reason: "unknown_type" });
  });
  it("Q6: a user stop is not wakeable; other stop causes are", () => {
    expect(check({ stopCause: "user_stop" })).toEqual({ ok: false, reason: "user_aborted" });
    for (const c of ["timeout", "parent_abort", "shutdown", "parent_gone"] as const)
      expect(check({ stopCause: c })).toMatchObject({ ok: true });
  });
  it("root / system are never wakeable targets", () => {
    const rig = reviveRig();
    expect(rig.wake.preflight("root")).toMatchObject({ ok: false });
    expect(rig.wake.preflight("system")).toMatchObject({ ok: false });
  });

  describe("evicted snapshot: the tombstone carries the verdict", () => {
    const tomb = (patch: Partial<Tombstone> = {}): Tombstone => ({
      runId: target,
      generation: 1,
      sessionFile,
      createdAt: 0,
      expiresAt: 1e9,
      ...patch,
    });
    const evicted = (t: Tombstone | undefined) =>
      reviveRig({ snapshots: [], ...(t ? { tombstones: [t] } : {}) }).wake.preflight(target);
    it("real verdict instead of legacy_unknown", () => {
      expect(evicted(tomb({ wakeExclusion: "consult_fork" }))).toEqual({ ok: false, reason: "consult_fork" });
      expect(
        evicted(tomb({ wakeExclusion: "none", agentType: "worker", model: { provider: "p", id: "m" } })),
      ).toMatchObject({
        ok: true,
        facts: { agentType: "worker", model: { provider: "p", id: "m" } },
      });
    });
    it("user stop and a gone worktree survive eviction", () => {
      expect(evicted(tomb({ wakeExclusion: "none", agentType: "worker", userStopped: true }))).toEqual({
        ok: false,
        reason: "user_aborted",
      });
      expect(evicted(tomb({ wakeExclusion: "none", agentType: "worker", worktree: { state: "committed" } }))).toEqual({
        ok: false,
        reason: "worktree_gone",
      });
    });
    it("a legacy tombstone (no verdict) or no tombstone at all fails closed", () => {
      expect(evicted(tomb())).toEqual({ ok: false, reason: "legacy_unknown" });
      expect(evicted(undefined)).toEqual({ ok: false, reason: "legacy_unknown" });
    });
  });
});

describe("W5 revive request (plan §3.7)", () => {
  it("pins model + thinking, fixed budget, reject policies, wakeOrigin; message text rides the inbox block, not the prompt", async () => {
    const rig = reviveRig();
    const result = rig.send({ wake: true, text: "SECRET-BODY" });
    expect(result).toMatchObject({ ok: true, status: "accepted", wake: true });
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).toHaveBeenCalledTimes(1);
    const req = rig.spawnCalls[0]!;
    expect(req).toMatchObject({
      type: "worker",
      label: "worker-label",
      resumeFrom: target,
      modelOverride: { provider: "p", id: "m" },
      thinkingOverride: "high",
      timeoutPolicy: "fixed",
      poolFullPolicy: "reject",
      loadPolicy: "reject",
      budgetOverride: { totalMs: 600_000 },
      wakeOrigin: { by: sender, level: 0, via: "fabric" },
    });
    expect(req.wakeOrigin!.trigger).toMatchObject({ key: (result as { key: string }).key });
    expect(typeof req.wakeOrigin!.trigger!.claimToken).toBe("string");
    // root-direct: no parent
    expect(req).not.toHaveProperty("parentRunId");
    expect(req.prompt).toContain("[fabric wake");
    expect(req.prompt).not.toContain("SECRET-BODY");
  });
  it("a diag without model/thinking leaves them unpinned (no invented values)", async () => {
    const rig = reviveRig({ snapshots: [revivable({ model: undefined, thinkingLevel: undefined })] });
    rig.send({ wake: true });
    rig.mailbox.pump();
    await flush();
    expect(rig.spawnCalls[0]).not.toHaveProperty("modelOverride");
    expect(rig.spawnCalls[0]).not.toHaveProperty("thinkingOverride");
  });
  it("an unknown thinking string is not pinned", async () => {
    const rig = reviveRig({ snapshots: [revivable({ thinkingLevel: "turbo" })] });
    rig.send({ wake: true });
    rig.mailbox.pump();
    await flush();
    expect(rig.spawnCalls[0]).not.toHaveProperty("thinkingOverride");
  });
  it.each([
    [600, 600_000],
    [5, 60_000],
    [99_999, 3_600_000],
    [Number.NaN, 600_000],
    [Number.POSITIVE_INFINITY, 600_000],
    [90.9, 90_000],
  ])("resumeBudgetS %s is validated to %s ms", async (seconds, ms) => {
    const rig = reviveRig({ wake: { resumeBudgetS: seconds } });
    rig.send({ wake: true });
    rig.mailbox.pump();
    await flush();
    expect(rig.spawnCalls[0]!.budgetOverride).toEqual({ totalMs: ms });
  });
  it("success: the trigger is reserved by the resume (ownership left the mailbox), nothing dead-lettered or re-sent", async () => {
    const rig = reviveRig();
    const r = rig.send({ wake: true }) as { key: string };
    rig.mailbox.pump();
    await flush();
    expect(rig.rec(r.key)).toMatchObject({ state: "pending", reserved: { runId: "r_REVIVE01" } });
    expect(rig.mailbox.inFlightCount).toBe(0);
    expect(rig.injected).toEqual([]);
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("W5 mailbox verdict mapping (park / dead letter / retry / hold)", () => {
  it.each(["pool_full", "load", "quota", "session_closing", "resume_locked"] as const)(
    "temporary %s ⇒ the message is PARKED (kept for a later resume, wake intent kept) and the sender is told",
    async (reason) => {
      const rig = reviveRig({
        spawn: () => ({ error: { kind: "config", message: reason, retryable: true, reason } }),
      });
      const r = rig.send({ wake: true }) as { key: string };
      rig.mailbox.pump();
      await flush();
      expect(rig.rec(r.key)).toMatchObject({ state: "pending", wake: true, parked: { reason }, attempts: 0 });
      // sender receipt: system → sender result mentioning the key and the reason
      const receipt = rig.engine.select((x) => x.from === "system" && x.to === sender);
      expect(receipt).toHaveLength(1);
      expect(receipt[0]!.payload.text).toContain(r.key);
      expect(receipt[0]!.payload.text).toContain(reason);
      // parked ⇒ never re-revived by later pumps (no unbounded retry)
      for (let i = 0; i < 3; i++) {
        rig.mailbox.pump();
        await flush();
      }
      expect(rig.spawn).toHaveBeenCalledTimes(1);
    },
  );
  it("permanent unknown_type / external_unavailable / config ⇒ wake_refused dead letter carrying the cause", async () => {
    for (const reason of ["unknown_type", "external_unavailable", "config"] as const) {
      const rig = reviveRig({ spawn: () => ({ error: { kind: "config", message: "x", retryable: false, reason } }) });
      const r = rig.send({ wake: true }) as { key: string };
      rig.mailbox.pump();
      await flush();
      expect(rig.rec(r.key)).toMatchObject({
        state: "dropped",
        terminalReason: "wake_refused",
        deadLetter: { reason: "wake_refused", detail: reason, status: "issued" },
      });
      expect(rig.engine.select((x) => x.kind === "dead_letter" && x.to === sender)).toHaveLength(1);
      expect(rig.spawn).toHaveBeenCalledTimes(1);
    }
  });
  it("inbox_persist_failed / target_running ⇒ bounded retry ending in attempts_exhausted (never unbounded)", async () => {
    for (const reason of ["inbox_persist_failed", "target_running"] as const) {
      const rig = reviveRig({
        maxAttempts: 3,
        spawn: () => ({ error: { kind: "config", message: reason, retryable: true, reason } }),
      });
      const r = rig.send({ wake: true }) as { key: string };
      for (let i = 0; i < 12 && rig.rec(r.key).state !== "dropped"; i++) {
        rig.mailbox.pump();
        await flush();
        rig.clock.advance(1000);
        await flush();
      }
      expect(rig.rec(r.key)).toMatchObject({ state: "dropped", terminalReason: "attempts_exhausted" });
      expect(rig.spawn).toHaveBeenCalledTimes(3);
    }
  });
  it("stack_closed ⇒ hold: stays pending, nothing charged, no spin", async () => {
    const rig = reviveRig({
      spawn: () => ({ error: { kind: "config", message: "closed", retryable: false, reason: "stack_closed" } }),
    });
    const r = rig.send({ wake: true }) as { key: string };
    rig.mailbox.pump();
    await flush();
    expect(rig.rec(r.key)).toMatchObject({ state: "pending", attempts: 0 });
    expect(rig.rec(r.key)).not.toHaveProperty("parked");
    expect(rig.mailbox.inFlightCount).toBe(0);
    await flush();
    expect(rig.spawn).toHaveBeenCalledTimes(1);
  });
  it("spawn throwing is a bounded retry, not a lost message", async () => {
    const rig = reviveRig({
      spawn: () => {
        throw new Error("kaboom");
      },
    });
    const r = rig.send({ wake: true }) as { key: string };
    rig.mailbox.pump();
    await flush();
    expect(rig.rec(r.key)).toMatchObject({ state: "pending", attempts: 1 });
  });
  it("stack-memory durability cannot park: a temporary cause retries (bounded), a hop/rate cause is refused", async () => {
    const temp = reviveRig({
      durability: "stack-memory",
      maxAttempts: 2,
      spawn: () => ({ error: { kind: "config", message: "full", retryable: true, reason: "pool_full" } }),
    });
    // stack-memory admission cannot park, so wake:true stays a real revive request
    const r = temp.send({ wake: true }) as { key: string };
    for (let i = 0; i < 8 && temp.rec(r.key).state !== "dropped"; i++) {
      temp.mailbox.pump();
      await flush();
      temp.clock.advance(1000);
      await flush();
    }
    expect(temp.rec(r.key)).toMatchObject({ state: "dropped", terminalReason: "attempts_exhausted" });
    expect(temp.rec(r.key)).not.toHaveProperty("parked");
  });
  it("stack-memory + a hop limit that cannot be parked ⇒ wake_refused with the limit as detail", async () => {
    const rig = reviveRig({ durability: "stack-memory" });
    const r = rig.putRaw(1, { level: 2 });
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.rec(r.key)).toMatchObject({
      state: "dropped",
      deadLetter: { reason: "wake_refused", detail: "level_limit" },
    });
  });
  it("a full park cap falls back to the bounded retry (never an unbounded queue)", async () => {
    const rig = reviveRig({
      parkCap: 1,
      maxAttempts: 2,
      spawn: () => ({ error: { kind: "config", message: "full", retryable: true, reason: "load" } }),
    });
    const a = rig.send({ wake: true, text: "a" }) as { key: string };
    rig.mailbox.pump();
    await flush();
    expect(rig.rec(a.key)).toMatchObject({ parked: { reason: "load" } });
    const b = rig.send({ wake: true, text: "b" }) as { key: string };
    for (let i = 0; i < 8 && rig.rec(b.key).state !== "dropped"; i++) {
      rig.mailbox.pump();
      await flush();
      rig.clock.advance(1000);
      await flush();
    }
    expect(rig.rec(b.key)).toMatchObject({ state: "dropped", terminalReason: "attempts_exhausted" });
  });
  it("omitted wake (legacy) to a finished run is NOT revived: target_gone dead letter exactly as before", async () => {
    const rig = reviveRig();
    const r = rig.send() as { key: string };
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.rec(r.key)).toMatchObject({ state: "dropped", terminalReason: "target_gone" });
  });
  it("revive-time exclusion (target changed after admission) ⇒ wake_refused with the exclusion as detail", async () => {
    const rig = reviveRig();
    const r = rig.putRaw();
    rig.snaps.get(target)!.diag.stopCause = "user_stop";
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.rec(r.key)).toMatchObject({
      state: "dropped",
      deadLetter: { reason: "wake_refused", detail: "user_aborted" },
    });
  });
  it("a live successor wins over a revive (coalescing): the mailbox waits instead of spawning", async () => {
    const owners = new Map([[sessionFile, "r_OWNER001"]]);
    const rig = reviveRig({ owners });
    rig.tree.append("root", "r_OWNER001");
    const r = rig.send({ wake: true }) as { key: string };
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.rec(r.key)).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("W5 admission-time gate (router) and rate limits", () => {
  it("unwakeable finished target: wake:true is refused synchronously, nothing queued, no seq spent", () => {
    const rig = reviveRig({ snapshots: [revivable({ wakeExclusion: undefined })] });
    expect(rig.send({ wake: true })).toEqual({ ok: false, status: "not_wakeable", reason: "legacy_unknown" });
    expect(pending(rig)).toHaveLength(0);
    // park (wake:false) stays allowed for the very same legacy target and takes seq 1
    expect(rig.send({ wake: false })).toMatchObject({ ok: true, seq: 1 });
  });
  it.each(["consult_fork", "readonly_domain", "caller_owned", "external_agent", "user_aborted"] as const)(
    "%s ⇒ not_wakeable at admission",
    (reason) => {
      const diag = reason === "user_aborted" ? { stopCause: "user_stop" as const } : { wakeExclusion: reason };
      const rig = reviveRig({ snapshots: [revivable(diag)] });
      expect(rig.send({ wake: true })).toEqual({ ok: false, status: "not_wakeable", reason });
    },
  );
  it("hop gate: a sender at the level ceiling is downgraded to deliver-only PARK (reported), never revived", async () => {
    const rig = reviveRig({ maxLevel: 0 });
    const res = rig.send({ wake: true }) as { key: string; wakeDowngraded?: string; wake?: boolean };
    expect(res).toMatchObject({ ok: true, wake: false, wakeDowngraded: "level_limit" });
    expect(rig.rec(res.key)).toMatchObject({ wake: false, parked: { reason: "level_limit" } });
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).not.toHaveBeenCalled();
  });
  const revived = (n: number, by = sender, atMs = 0, file = sessionFile) =>
    Array.from({ length: n }, (_, i) => {
      const s = snapshot(`r_PRIOR${String(i).padStart(3, "0")}`, { status: "completed", phase: "settled" });
      s.diag.createdAt = atMs;
      s.diag.sessionFile = file;
      s.diag.wakeOrigin = { by, key: `${by}:${target}:1:${i + 1}` as never, level: 0, via: "fabric" };
      return s;
    });
  it("perRunQuota counts the sender's earlier revives (persisted wakeOrigin) ⇒ rate_limited park", () => {
    const rig = reviveRig({
      snapshots: [revivable(), ...revived(3, sender, 0, "/other.jsonl")],
      wake: { resumesPerHour: 99, resumesPerTargetPerHour: 99 },
    });
    expect(rig.send({ wake: true })).toMatchObject({ ok: true, wake: false, wakeDowngraded: "rate_limited" });
    // a different sender is unaffected
    const other = reviveRig({
      snapshots: [revivable(), ...revived(3, "r_OTHER001", 0, "/other.jsonl")],
      wake: { resumesPerHour: 99, resumesPerTargetPerHour: 99 },
    });
    expect(other.send({ wake: true })).toMatchObject({ ok: true, wake: true });
  });
  it("resumesPerHour: only revives created within the last hour count", () => {
    const old = reviveRig({ snapshots: [revivable(), ...revived(6, "r_A00000A", -3_600_001, "/o.jsonl")] });
    expect(old.send({ wake: true })).toMatchObject({ wake: true });
    const fresh = reviveRig({ snapshots: [revivable(), ...revived(6, "r_A00000A", 0, "/o.jsonl")] });
    expect(fresh.send({ wake: true })).toMatchObject({ wake: false, wakeDowngraded: "rate_limited" });
  });
  it("resumesPerTargetPerHour: per session file", () => {
    const sameTarget = reviveRig({ snapshots: [revivable(), ...revived(2, "r_A00000A")] });
    expect(sameTarget.send({ wake: true })).toMatchObject({ wake: false, wakeDowngraded: "rate_limited" });
    const elsewhere = reviveRig({ snapshots: [revivable(), ...revived(2, "r_A00000A", 0, "/o.jsonl")] });
    expect(elsewhere.send({ wake: true })).toMatchObject({ wake: true });
  });
  it("the revive-time re-check (race after admission) parks with the limit instead of spawning", async () => {
    const rig = reviveRig();
    const res = rig.putRaw();
    for (const s of revived(2, "r_A00000A")) rig.snaps.set(s.runId, s);
    rig.mailbox.pump();
    await flush();
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.rec(res.key)).toMatchObject({ parked: { reason: "rate_limited" }, wake: true });
  });
  it("stats().resumesLastHour reports the persisted count", () => {
    const rig = reviveRig({ snapshots: [revivable(), ...revived(2, "r_A00000A")] });
    expect(rig.wake.stats().resumesLastHour).toBe(2);
  });
  it("wake:true to a RUNNING target is not the expensive class: no gate, no revive", () => {
    const rig = reviveRig();
    rig.tree.append("root", "r_RN000001");
    rig.tree.markRunning("r_RN000001");
    const res = rig.router.admit(sender, {
      to: "r_RN000001",
      kind: "finding",
      text: "steer",
      generation: 1,
      canMessage: ["sibling", "parent"],
      wake: true,
    });
    expect(res).toMatchObject({ ok: true, wake: true });
    expect(rig.spawn).not.toHaveBeenCalled();
  });
});
