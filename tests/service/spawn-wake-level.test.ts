import { describe, expect, it } from "vitest";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { MessageKey } from "../../src/core/message.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { TombstoneStore } from "../../src/service/tombstone.js";

/**
 * fabric-cross-session plan v3 §3.3 L4 (W1): the INITIAL effective causal level written by spawn admission.
 *  · wake revive (`wakeOrigin`) / legacy @mention resume (`wakeHopLevel`) ⇒ max(hop + 1, prevFinal)
 *  · every other spawn (incl. `Agent({resume})`) ⇒ levelOf(spawner), NEVER prevFinal (a new human epoch)
 *  · wake off (no `causal` dep) ⇒ no `wakeLevel` on the runner request, even if a caller supplied one
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const sessionFile = new URL("../../package.json", import.meta.url).pathname;
const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
function outcome(runId: string, wakeLevel?: number): RunOutcome {
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
      ...(wakeLevel === undefined ? {} : { wakeLevel }),
    },
  };
}

function harness(opts: {
  causal?: boolean;
  firstRunFinalLevel?: number;
  runLevels?: Record<string, number>;
  root?: number;
}) {
  const seen: Array<{ runId: string; wakeLevel: number | undefined; resumeFrom: string | undefined }> = [];
  const runner: Runner = {
    run: async (spec) => {
      seen.push({
        runId: spec.runId,
        wakeLevel: (spec.request as { wakeLevel?: number }).wakeLevel,
        resumeFrom: spec.request.resumeFrom,
      });
      return outcome(spec.runId, spec.request.resumeFrom === undefined ? opts.firstRunFinalLevel : undefined);
    },
  };
  const service = createSpawnService({
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    tombstones: new TombstoneStore(),
    now: () => Date.now(),
    budget: { totalMs: 1000 },
    ...(opts.causal === false
      ? {}
      : {
          causal: {
            levelOfRun: (runId: string) => opts.runLevels?.[runId] ?? 0,
            root: () => opts.root ?? 0,
          },
        }),
  });
  return { service, seen };
}

describe("spawn admission seeds the effective causal level (plan §3.3 L4)", () => {
  it("a plain top-level spawn starts at the ROOT's current level", async () => {
    const h = harness({ root: 2 });
    await h.service.spawnAndWait({ type: "worker", prompt: "x" });
    expect(h.seen[0]?.wakeLevel).toBe(2);
  });

  it("a root that was just reset by human input spawns at 0", async () => {
    const h = harness({ root: 0 });
    await h.service.spawnAndWait({ type: "worker", prompt: "x" });
    expect(h.seen[0]?.wakeLevel).toBe(0);
  });

  it("a nested spawn starts at its PARENT RUN's level, not the root's", async () => {
    const h = harness({ root: 0, runLevels: { r_PARENT01: 1 } });
    await h.service.spawnAndWait({ type: "worker", prompt: "x", parentRunId: "r_PARENT01" });
    expect(h.seen[0]?.wakeLevel).toBe(1);
  });

  it("Agent({resume}) is a new human epoch: spawner's level, NOT prevFinal", async () => {
    const h = harness({ root: 0, firstRunFinalLevel: 2 });
    await h.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    await h.service.spawnAndWait({ type: "worker", prompt: "again", resumeFrom: "owned" });
    expect(h.seen[0]?.wakeLevel).toBe(0);
    expect(h.seen[1]).toMatchObject({ wakeLevel: 0 }); // not 2
    expect(h.seen[1]?.resumeFrom).toBe(sessionFile);
  });

  it("a wake revive (wakeOrigin) starts at max(origin.level + 1, prevFinal)", async () => {
    const origin = { by: "r_WAKER001", key: "r_WAKER001:r_X:1:1" as MessageKey, level: 1, via: "fabric" as const };
    const high = harness({ firstRunFinalLevel: 3 });
    await high.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    await high.service.spawnAndWait({
      type: "worker",
      prompt: "wake",
      resumeFrom: "owned",
      wakeOrigin: origin as never,
    });
    expect(high.seen[1]?.wakeLevel).toBe(3); // prevFinal 3 > origin+1 = 2

    const low = harness({ firstRunFinalLevel: 0 });
    await low.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    await low.service.spawnAndWait({
      type: "worker",
      prompt: "wake",
      resumeFrom: "owned",
      wakeOrigin: origin as never,
    });
    expect(low.seen[1]?.wakeLevel).toBe(2); // origin+1
  });

  it("a legacy @mention resume (wakeHopLevel) uses the same formula", async () => {
    const h = harness({ firstRunFinalLevel: 0 });
    await h.service.spawnAndWait({ type: "worker", prompt: "first", label: "owned" });
    await h.service.spawnAndWait({ type: "worker", prompt: "mention", resumeFrom: "owned", wakeHopLevel: 1 });
    expect(h.seen[1]?.wakeLevel).toBe(2);
  });

  it("wake off (no causal dep): no wakeLevel reaches the runner — and a caller-supplied one is never trusted", async () => {
    const h = harness({ causal: false });
    await h.service.spawnAndWait({ type: "worker", prompt: "x", wakeLevel: 9 });
    expect(h.seen[0]?.wakeLevel).toBeUndefined();
  });

  it("with causal levels on, a caller-supplied wakeLevel is recomputed, not trusted", async () => {
    const h = harness({ root: 1 });
    await h.service.spawnAndWait({ type: "worker", prompt: "x", wakeLevel: 9 });
    expect(h.seen[0]?.wakeLevel).toBe(1);
  });
});
