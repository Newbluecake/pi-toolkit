import { describe, expect, it } from "vitest";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { TombstoneStore } from "../../src/service/tombstone.js";

/**
 * fabric-cross-session plan v3 §3.4a (S0): `resumeLocks: Set` → `resumeOwners: Map<key, RunId>` + `successorOf`.
 * Mutual exclusion and release points are unchanged (tests/service/resume.test.ts still pins them); the new fact is
 * WHO owns the resume, readable synchronously by session file.
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const sessionFile = new URL("../../package.json", import.meta.url).pathname;
const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
function outcome(runId: string): RunOutcome {
  return {
    runId,
    status: "completed",
    turns: 1,
    durationMs: 1,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 1,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      sessionFile,
    },
  };
}
/** Runner whose resume runs (those with resumeFrom) are held until `release()`; first runs finish at once. */
function controlled() {
  const held: Array<() => void> = [];
  let failResume = false;
  const runner: Runner = {
    run: async (spec) => {
      if (spec.request.resumeFrom !== undefined) {
        await new Promise<void>((resolve) => held.push(resolve));
        if (failResume) throw new Error("runner exploded");
      }
      return outcome(spec.runId);
    },
  };
  const service = createSpawnService({
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    tombstones: new TombstoneStore(),
    now: () => Date.now(),
    budget: { totalMs: 1000 },
  });
  return {
    service,
    release: () => held.shift()?.(),
    failNext: () => {
      failResume = true;
    },
  };
}

describe("successorOf / resumeOwners (plan §3.4a)", () => {
  it("is undefined for a session nobody is resuming (including a plain first run)", async () => {
    const c = controlled();
    const first = await c.service.spawn({ type: "worker", prompt: "first", label: "owned" });
    expect(first).toHaveProperty("runId");
    await c.service.waitAll({ waitMs: 50 });
    expect(c.service.successorOf(sessionFile)).toBeUndefined();
    expect(c.service.successorOf("/no/such/session.jsonl")).toBeUndefined();
  });

  it("names the resume run synchronously the moment spawn() returns, and releases it at the terminal state", async () => {
    const c = controlled();
    await c.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    const resumed = await c.service.spawn({ type: "worker", prompt: "again", resumeFrom: "owned" });
    if ("error" in resumed) throw new Error(resumed.error.message);
    // visible right away — before the resumed run has done anything
    expect(c.service.successorOf(sessionFile)).toBe(resumed.runId);
    c.release();
    await c.service.waitAll({ waitMs: 50 });
    expect(c.service.successorOf(sessionFile)).toBeUndefined();
    // and the session is resumable again (lock semantics unchanged)
    const again = await c.service.spawn({ type: "worker", prompt: "third", resumeFrom: "owned" });
    expect(again).toHaveProperty("runId");
    expect(c.service.successorOf(sessionFile)).toBe((again as { runId: string }).runId);
    c.release();
    await c.service.waitAll({ waitMs: 50 });
  });

  it("a second resume is rejected resume_locked and does not steal ownership", async () => {
    const c = controlled();
    await c.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    const one = await c.service.spawn({ type: "worker", prompt: "a", resumeFrom: "owned" });
    const two = await c.service.spawn({ type: "worker", prompt: "b", resumeFrom: "owned" });
    expect(two).toMatchObject({ error: { reason: "resume_locked", kind: "config", retryable: false } });
    expect(c.service.successorOf(sessionFile)).toBe((one as { runId: string }).runId);
    c.release();
    await c.service.waitAll({ waitMs: 50 });
    expect(c.service.successorOf(sessionFile)).toBeUndefined();
  });

  it("releases ownership when the runner throws (start() failure path)", async () => {
    const c = controlled();
    await c.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    c.failNext();
    const resumed = await c.service.spawn({ type: "worker", prompt: "again", resumeFrom: "owned" });
    expect(c.service.successorOf(sessionFile)).toBe((resumed as { runId: string }).runId);
    c.release();
    await c.service.waitAll({ waitMs: 50 });
    expect(c.service.successorOf(sessionFile)).toBeUndefined();
  });

  it("a rejected resume admission never registers an owner", async () => {
    const c = controlled();
    const rejected = await c.service.spawn({ type: "worker", prompt: "x", resumeFrom: "missing" });
    expect("error" in rejected).toBe(true);
    expect(c.service.successorOf(sessionFile)).toBeUndefined();
  });
});
