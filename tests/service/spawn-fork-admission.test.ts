import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { CONSULT_MAIN_AGENT_TYPE } from "../../src/core/types.js";
import type { AgentTypeConfig, RunOutcome, StopCause } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

/**
 * consult plan §9 T-7 (package B): fork-request admission through the REAL
 * createSpawnService. This is the anchor review-1 #1 demanded — a mock-based
 * spawnAndWait test could never notice that the canSpawn gate rejects every
 * consult, because the asking run's type has no canSpawn for the *expert's*
 * type. Fixtures follow review-2 #6: the expert type itself carries canSpawn
 * (so the old "nesting naturally lacks canSpawn" argument is unambiguously
 * dead — the fork run's type HAS one and must still not pass it on).
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
  };
}

function typesRegistry(types: AgentTypeConfig[]) {
  return {
    get: (name: string) => types.find((t) => t.name === name),
    list: () => types,
    reload: async () => ({ types, errors: [] }),
  };
}

/** The expert type has canSpawn (review-2 #6 fixture); the asker type has none. */
const expertType: AgentTypeConfig = {
  name: "expert",
  description: "x",
  systemPrompt: "",
  promptMode: "append",
  canSpawn: ["expert", "worker"],
};
const askerType: AgentTypeConfig = { name: "asker", description: "x", systemPrompt: "", promptMode: "append" };
const workerType: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };

const tempDirs: string[] = [];
function forkFile(): string {
  const d = mkdtempSync(join(tmpdir(), "consult-admission-"));
  tempDirs.push(d);
  const f = join(d, "fork-copy.jsonl");
  writeFileSync(f, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: d })}\n`);
  return f;
}
afterAll(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("SpawnService: consult fork admission (T-7)", () => {
  it("admits a fork request under a parent whose type has no canSpawn (review-1 #1)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });

    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);

    const consult = await svc.spawn({
      type: "expert",
      prompt: "question",
      parentRunId: asker.runId,
      forkSessionFrom: forkFile(),
    });
    expect("error" in consult).toBe(false);
    if ("error" in consult) throw new Error(consult.error.message);
    expect(consult.label).toBeTruthy(); // normal label registration ("question" base)
  });

  it("still rejects the same nested spawn WITHOUT forkSessionFrom (canSpawn gate intact)", async () => {
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
      },
    });
  });

  it("rejects forkSessionFrom combined with resumeFrom (mutually exclusive)", async () => {
    const { runner, settle } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });
    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);
    const other = await svc.spawn({ type: "asker", prompt: "b" });
    if ("error" in other) throw new Error(other.error.message);
    settle(other.runId); // a finished run → resumable

    const both = await svc.spawn({
      type: "expert",
      prompt: "q",
      parentRunId: asker.runId,
      forkSessionFrom: forkFile(),
      resumeFrom: other.runId,
    });
    expect(both).toEqual({
      error: { kind: "config", message: "forkSessionFrom and resumeFrom are mutually exclusive", retryable: false },
    });
  });

  it("rejects a fork session path that does not exist (or is not a file)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });
    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);

    const missing = await svc.spawn({
      type: "expert",
      prompt: "q",
      parentRunId: asker.runId,
      forkSessionFrom: "/definitely/not/there.jsonl",
    });
    expect(missing).toEqual({
      error: {
        kind: "config",
        message: "fork session file missing: /definitely/not/there.jsonl",
        retryable: false,
      },
    });
  });

  it("fork requests take no resume locks: two concurrent forks of the same file both admit", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });
    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);
    const file = forkFile(); // SAME file for both — each run gets its own copy in production; the point is no mutex

    const first = await svc.spawn({ type: "expert", prompt: "q1", parentRunId: asker.runId, forkSessionFrom: file });
    const second = await svc.spawn({ type: "expert", prompt: "q2", parentRunId: asker.runId, forkSessionFrom: file });
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
  });

  it("still counts fork runs toward maxNestedDepth (depth = parent.depth + 1)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({
      types: typesRegistry([expertType, askerType]),
      pool,
      runner,
      now: () => 0,
      maxNestedDepth: 1,
    });
    const asker = await svc.spawn({ type: "asker", prompt: "a" }); // depth 0
    if ("error" in asker) throw new Error(asker.error.message);
    const consult = await svc.spawn({
      type: "expert",
      prompt: "q",
      parentRunId: asker.runId,
      forkSessionFrom: forkFile(),
    });
    expect("error" in consult).toBe(false); // depth 1 == max, ok
    if ("error" in consult) throw new Error(consult.error.message);

    const tooDeep = await svc.spawn({
      type: "expert",
      prompt: "q2",
      parentRunId: consult.runId,
      forkSessionFrom: forkFile(),
    });
    expect(tooDeep).toEqual({
      error: {
        kind: "config",
        message: "nested delegation depth 2 exceeds the configured maximum (1)",
        retryable: false,
      },
    });
  });

  it("a consult run's nesting entry carries no canSpawn: it cannot delegate even its own type (review-2 #6)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });
    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);
    const consult = await svc.spawn({
      type: "expert", // the expert's own type HAS canSpawn ["expert","worker"]
      prompt: "q",
      parentRunId: asker.runId,
      forkSessionFrom: forkFile(),
    });
    expect("error" in consult).toBe(false);
    if ("error" in consult) throw new Error(consult.error.message);

    // Old behavior: consult's nesting inherited config.canSpawn → this would
    // pass. New: no canSpawn → rejected, "expert" not in [].
    const child = await svc.spawn({ type: "expert", prompt: "child", parentRunId: consult.runId });
    expect(child).toEqual({
      error: {
        kind: "config",
        message: 'nested delegation is not permitted: parent\'s agent type may only spawn [], not "expert"',
        retryable: false,
      },
    });
    const childWorker = await svc.spawn({ type: "worker", prompt: "child", parentRunId: consult.runId });
    expect("error" in childWorker).toBe(true);
  });

  it("a non-fork nested run still inherits canSpawn normally (control group)", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([expertType, workerType]), pool, runner, now: () => 0 });
    const top = await svc.spawn({ type: "expert", prompt: "a" }); // expert can spawn worker
    if ("error" in top) throw new Error(top.error.message);
    const child = await svc.spawn({ type: "worker", prompt: "b", parentRunId: top.runId });
    expect("error" in child).toBe(false);
  });
});

/**
 * consult (plan §16 "consult the main session"): the "no type" admission
 * branch for `CONSULT_MAIN_AGENT_TYPE`. No agent type of that name is ever
 * registered here — the point is that admission still succeeds when
 * `forkSessionFrom` is set, and still fails exactly like any other unknown
 * type when it is not.
 */
describe('SpawnService: consult("main") no-type fork admission (§16)', () => {
  it("admits a fork request naming CONSULT_MAIN_AGENT_TYPE even though it is registered nowhere", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([askerType]), pool, runner, now: () => 0 });
    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);

    const consult = await svc.spawn({
      type: CONSULT_MAIN_AGENT_TYPE,
      prompt: "question for main",
      parentRunId: asker.runId,
      forkSessionFrom: forkFile(),
    });
    expect("error" in consult).toBe(false);
    if ("error" in consult) throw new Error(consult.error.message);
    expect(consult.label).toBeTruthy();
  });

  it("still rejects CONSULT_MAIN_AGENT_TYPE without forkSessionFrom as an unknown type", async () => {
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([askerType]), pool, runner, now: () => 0 });
    const asker = await svc.spawn({ type: "asker", prompt: "a" });
    if ("error" in asker) throw new Error(asker.error.message);

    const rejected = await svc.spawn({ type: CONSULT_MAIN_AGENT_TYPE, prompt: "q", parentRunId: asker.runId });
    expect("error" in rejected).toBe(true);
    if (!("error" in rejected)) throw new Error("expected an error");
    expect(rejected.error.message).toContain(`unknown agent type: ${CONSULT_MAIN_AGENT_TYPE}`);
  });

  it("a real registered type literally named CONSULT_MAIN_AGENT_TYPE is untouched by the bypass", async () => {
    // §16: the bypass is keyed off the sentinel string AND forkSessionFrom
    // together — a real type sharing that exact name (contrived, but the
    // collision the design deliberately avoids) still resolves through the
    // registry for a PLAIN dispatch (no forkSessionFrom).
    const shadow: AgentTypeConfig = {
      name: CONSULT_MAIN_AGENT_TYPE,
      description: "a real type that happens to share the sentinel name",
      systemPrompt: "real prompt",
      promptMode: "append",
    };
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([shadow]), pool, runner, now: () => 0 });
    const plain = await svc.spawn({ type: CONSULT_MAIN_AGENT_TYPE, prompt: "q" });
    expect("error" in plain).toBe(false);
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
    const { runner } = controllableRunner();
    const svc0 = createSpawnService({ types: typesRegistry([expertType, askerType]), pool, runner, now: () => 0 });
    const asker = await svc0.spawn({ type: "asker", prompt: "a" }); // stays running
    if ("error" in asker) throw new Error(asker.error.message);

    const { runner: boom } = throwingRunner();
    const notified: RunOutcome[] = [];
    const svc = createSpawnService({
      types: typesRegistry([expertType, askerType]),
      pool,
      runner: boom,
      now: () => 0,
      notifyTerminalFailure: (o) => notified.push(o),
    });
    const nested = await svc.spawn({
      type: "expert",
      prompt: "b",
      parentRunId: asker.runId, // any tracked parent id would do; reuse a live one
      forkSessionFrom: forkFile(),
    });
    if ("error" in nested) throw new Error(nested.error.message);
    const waited = await svc.waitOutcome(nested.runId);
    if (waited.kind !== "settled") throw new Error("outcome never settled");
    expect(waited.outcome.status).toBe("failed");
    // The run still settles and its outcome is retrievable — only the
    // top-level notification is suppressed (the parent gets the outcome
    // through spawnAndWait/waitOutcome, not through the notifier).
    expect(notified).toEqual([]);
  });
});
