import { describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome, StopCause } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

/**
 * Nested-spawn admission through the REAL createSpawnService (kept from the consult fork-admission suite, #40 PS1a).
 * The consult fork bypass is gone: the canSpawn gate applies to every nested request — a legacy
 * `forkSessionFrom` on a request no longer skips it, is no longer validated, and no longer changes the nesting entry.
 */

const pool: SlotPool = { acquire: (runId) => Promise.resolve({ ok: true, ticket: { runId, release() {} } }) };

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
    },
  };
}

/** Runs never settle on their own — nesting entries stay alive for the whole test. */
function controllableRunner() {
  const pending = new Map<string, (o: RunOutcome) => void>();
  const abortCalls: Array<{ runId: string; cause?: StopCause }> = [];
  const runner: Runner = {
    run: (spec) =>
      new Promise<RunOutcome>((resolve) => {
        pending.set(spec.runId, resolve);
      }),
    abort: async (runId, cause) => {
      abortCalls.push({ runId, cause });
      return { ok: true, escalatedTo: "L2" };
    },
  };
  return {
    runner,
    abortCalls,
    settle: (runId: string) => {
      pending.get(runId)?.(outcome(runId));
      pending.delete(runId);
    },
    settleAs: (runId: string, status: RunOutcome["status"]) => {
      pending.get(runId)?.({ ...outcome(runId), status });
      pending.delete(runId);
    },
  };
}

function typesRegistry(types: AgentTypeConfig[]) {
  return {
    get: (name: string) => types.find((t) => t.name === name),
    list: () => types,
    reload: async () => ({ types, errors: [] }),
  };
}

/** `expertType` can spawn; `askerType` cannot. */
const expertType: AgentTypeConfig = {
  name: "expert",
  description: "x",
  systemPrompt: "",
  promptMode: "append",
  canSpawn: ["expert", "worker"],
};
const askerType: AgentTypeConfig = { name: "asker", description: "x", systemPrompt: "", promptMode: "append" };
const workerType: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };

describe("SpawnService: nested admission (canSpawn gate, #40 — no fork bypass)", () => {
  it("rejects a nested spawn whose type the parent may not spawn (canSpawn gate intact)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });

    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);

    const rejected = await svc.spawn({ type: "expert", prompt: "question", parentRunId: asker.runId });
    expect(rejected).toEqual({
      error: {
        kind: "config",
        message: 'nested delegation is not permitted: parent\'s agent type may only spawn [], not "expert"',
        retryable: false,
        reason: "config",
      },
    });
  });

  it("a legacy forkSessionFrom no longer bypasses the canSpawn gate, and its (missing) file is never checked", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });

    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);

    const rejected = await svc.spawn({
      type: "expert",
      prompt: "question",
      parentRunId: asker.runId,
      forkSessionFrom: "/definitely/not/there.jsonl",
    });
    expect(rejected).toEqual({
      error: {
        kind: "config",
        message: 'nested delegation is not permitted: parent\'s agent type may only spawn [], not "expert"',
        retryable: false,
        reason: "config",
      },
    });
  });

  it("a nested run inherits canSpawn normally (control group)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, workerType]), pool, runner, now: () => 0 });
    const top = await svc.spawn({ type: "expert", prompt: "a" }); // expert can spawn worker
    if ("error" in top) throw new Error(top.error.message);
    const child = await svc.spawn({ type: "worker", prompt: "b", parentRunId: top.runId });
    expect("error" in child).toBe(false);
  });

  it("a legacy forkSessionFrom request under a parent that may spawn its type admits as an ordinary nested run (canSpawn kept)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, workerType]), pool, runner, now: () => 0 });
    const top = await svc.spawn({ type: "expert", prompt: "a" });
    if ("error" in top) throw new Error(top.error.message);
    const child = await svc.spawn({ type: "expert", prompt: "b", parentRunId: top.runId, forkSessionFrom: "/x.jsonl" });
    if ("error" in child) throw new Error(child.error.message);
    // nesting entry carries canSpawn like any other run: the grandchild of a worker type is admitted.
    const grand = await svc.spawn({ type: "worker", prompt: "c", parentRunId: child.runId });
    expect("error" in grand).toBe(false);
  });
});

describe("SpawnService: notifyTerminalFailure nested-run gap (T-8, §6 B-6)", () => {
  /** A runner whose run() rejects — the path spawn-service's start() catch exists for. */
  function throwingRunner() {
    const seen: string[] = [];
    const runner: Runner = {
      run: async (spec) => {
        seen.push(spec.runId);
        throw new Error("runner exploded");
      },
    };
    return { runner, seen };
  }

  it("notifies for a top-level run whose runner.run throws", async () => {
    const { runner } = throwingRunner();
    const notified: RunOutcome[] = [];
    const svc = createSpawnService({
      types: typesRegistry([askerType]),
      pool,
      runner,
      now: () => 0,
      notifyTerminalFailure: (o) => notified.push(o),
    });
    const result = await svc.spawnAndWait({ type: "asker", prompt: "b" });
    expect(result.status).toBe("failed");
    expect(notified.map((o) => o.runId)).toEqual([result.runId]);
  });

  it("suppresses the notification for a NESTED run (parentRunId set) — no top-level leak past CC2", async () => {
    // One runner: the top run's run() hangs forever to "stay running"; the nested run's run() rejects.
    const notified: RunOutcome[] = [];
    const runner: Runner = {
      run: (spec) =>
        spec.request.type === "expert"
          ? new Promise<RunOutcome>(() => {}) // never settles — the parent "stays running"
          : Promise.reject(new Error("runner exploded")),
    };
    const svc = createSpawnService({
      types: typesRegistry([expertType, workerType]),
      pool,
      runner,
      now: () => 0,
      notifyTerminalFailure: (o) => notified.push(o),
    });
    const top = await svc.spawn({ type: "expert", prompt: "a" });
    if ("error" in top) throw new Error(top.error.message);

    const nested = await svc.spawn({ type: "worker", prompt: "b", parentRunId: top.runId });
    if ("error" in nested) throw new Error(nested.error.message);
    const waited = await svc.waitOutcome(nested.runId);
    if (waited.kind !== "settled") throw new Error("outcome never settled");
    expect(waited.outcome.status).toBe("failed");
    // The run still settles and its outcome is retrievable — only the
    // top-level notification is suppressed.
    expect(notified).toEqual([]);
  });
});

describe("SpawnService: nested spawn admission during abort", () => {
  it("a nested spawn is still admitted by ordinary canSpawn/depth rules while the parent is being aborted", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, workerType]), pool, runner, now: () => 0 });
    const top = await svc.spawn({ type: "expert", prompt: "a" }); // expert can spawn worker
    if ("error" in top) throw new Error(top.error.message);

    const abortP = svc.abort(top.runId);
    const nested = await svc.spawn({ type: "worker", prompt: "b", parentRunId: top.runId });
    expect("error" in nested).toBe(false);

    await abortP;
  });
});
