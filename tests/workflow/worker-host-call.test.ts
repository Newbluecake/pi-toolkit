import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import type { WorkerHost, WorkflowStageError } from "../../src/workflow/types.js";

/**
 * M3.2 verification Blocker B (fixed here): `HostAckEnvelope`/
 * `HostSettleEnvelope` (src/workflow/types.ts) previously had **no `kind`
 * field**, and `host.ts` sent them to the worker exactly as-is via
 * `WorkerHost.send()`. But `worker-source.ts`'s inbound dispatch
 * (`commPort.on("message", ...)`) switches on `msg.kind === "host_ack"` /
 * `"host_settle"` and silently drops anything that doesn't match. The net
 * effect: **every real `agent()`/`gate()` call's ack and settle were
 * dropped worker-side**, and the calling script's `await agent(...)` hung
 * until the worker-side HR1 client-side timeout fired (or, with a large
 * `hostCallMs`, effectively hung until WT8).
 *
 * `host.test.ts`'s M3.2 coverage never caught this because it always used a
 * `FakeWorkerHost` double whose `.send()` just records the payload — it
 * never round-tripped through the real worker-source.ts dispatcher (the
 * milestone task's own doc comment for `host.test.ts` references a
 * "wc-host-call.test.ts" that never existed — this file is that missing
 * test, under the name the M3.3 verification asked for).
 *
 * These tests boot a **real** `node:worker_threads` worker (via
 * `createWorkerHost`/`lifecycle.ts`, not a fake `WorkerLike`) running a
 * script that calls the real, unmodified `agent()`/`gate()` sandboxed
 * globals (worker-source.ts), and wire it to `attachHostCallHandler`
 * (host.ts) with a scripted `ChildSpawner` standing in for `SpawnService`.
 * If the `kind` field regresses, every one of these tests times out instead
 * of asserting a value — that is deliberate: HR1's own timeout message
 * ("did not settle before its deadline") is itself the regression signal.
 */

function scriptWith(body: string): string {
  return `export const meta = { name: "t", description: "t" };\n${body}`;
}

async function bootReal(
  script: string,
  spawner: ChildSpawner,
  budgetOverrides: { maxParallel?: number } = {},
): Promise<{
  host: WorkerHost;
  outcome: Promise<{ returned?: unknown; threw?: { message: string } }>;
  stageErrors: WorkflowStageError[];
  workerErrors: unknown[];
}> {
  const host = createWorkerHost({ clock: systemClock });
  const stageErrors: WorkflowStageError[] = [];
  const workerErrors: unknown[] = [];
  host.events.onStageError((e) => stageErrors.push(e));
  host.events.onError((e) => workerErrors.push(e));
  attachHostCallHandler({
    clock: systemClock,
    workerHost: host,
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    budget: {
      hostCallMs: 3_000,
      gateMs: 3_000,
      maxParallel: 4,
      maxChildren: 10,
      maxBatchItems: 10,
      childBudgetPolicy: "inherit_remaining",
      ...budgetOverrides,
    },
    workflowDeadlineAt: Date.now() + 30_000,
  });
  const boot = await host.boot({
    scriptSource: script,
    scriptSliceMs: 2_000,
    heartbeatMs: 0,
    workerBootMs: 5_000,
    terminateConfirmMs: 2_000,
    hostCallMs: 3_000,
    gateMs: 3_000,
  });
  expect(boot.ok).toBe(true);

  const outcome = new Promise<{ returned?: unknown; threw?: { message: string } }>((resolve) => {
    let done = false;
    host.events.onScriptReturned((returned) => {
      if (done) return;
      done = true;
      resolve({ returned });
    });
    host.events.onScriptThrew((threw) => {
      if (done) return;
      done = true;
      resolve({ threw });
    });
  });
  return { host, outcome, stageErrors, workerErrors };
}

describe("real-worker agent() host-call round trip (M3.2/M3.3 Blocker B regression coverage)", () => {
  it("a normal agent() call round-trips through the real worker and resolves to the fake child's result", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r1", label: "worker-label" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "hello from child" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(scriptWith('return await agent("do the thing");'), spawner);
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("hello from child");
    await host.terminate("test-done");
  }, 10_000);

  it("fullResult returns the settle envelope identity while the default remains a string", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r-full", label: "full-label" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "full text" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'const a = await agent("x", { fullResult: true }); const b = await agent("y"); return JSON.stringify({ a, b });',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.returned).toBe(
      JSON.stringify({ a: { text: "full text", runId: "r-full", label: "full-label" }, b: "full text" }),
    );
    await host.terminate("test-done");
  }, 10_000);

  it("a child that fails resolves agent() to null (§5.2/§5.3 upstream-plugin-compatible semantics), not a hang", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r2" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "failed" as const, error: { message: "child boom" } })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith('const r = await agent("x"); return r === null ? "was-null" : "not-null:" + JSON.stringify(r);'),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("was-null");
    await host.terminate("test-done");
  }, 10_000);

  it("maps a failed fullResult settle to null without identity fields", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r-failed", label: "failed-label" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "failed" as const, error: { message: "boom" } })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith('const r = await agent("x", { fullResult: true }); return r === null ? "null" : JSON.stringify(r);'),
      spawner,
    );
    expect((await outcome).returned).toBe("null");
    await host.terminate("test-done");
  }, 10_000);

  it("an admission-time error (e.g. unknown agentType / budget exhausted) rejects agent(), catchable by the script", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ error: { message: "unknown agent type 'nope'" } }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("x", { agentType: "nope" }); return "no-throw"; } ' +
          'catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("caught:unknown agent type 'nope'");
    await host.terminate("test-done");
  }, 10_000);

  it("gate() also round-trips through the real worker (single-segment ack, same kind-tagged envelope)", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(scriptWith('const r = await gate("true"); return r.ok;'), spawner);
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe(true);
    await host.terminate("test-done");
  }, 10_000);
});

/**
 * workflow-agent-queue §7 (stage A), real worker: queued dispatch end to end.
 */
function delayedSpawner(opts: { delayMsOf?(prompt: string): number; errorFor?(prompt: string): string | undefined }) {
  const promptOf = new Map<string, string>();
  const spawned: string[] = [];
  let n = 0;
  const spawner: ChildSpawner = {
    spawn: async (req) => {
      const err = opts.errorFor?.(req.prompt);
      if (err !== undefined) return { error: { message: err } };
      spawned.push(req.prompt);
      const runId = `r${++n}`;
      promptOf.set(runId, req.prompt);
      return { runId };
    },
    abort: async () => true,
    waitAll: async ({ runIds }) => ({
      settled: await Promise.all(
        runIds.map(async (runId) => {
          const prompt = promptOf.get(runId) ?? "";
          const delay = opts.delayMsOf?.(prompt) ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          return { runId, status: "completed" as const, text: `done:${prompt}` };
        }),
      ),
      pending: [],
    }),
  };
  return { spawner, spawned };
}

describe("real-worker agent() queueing (workflow-agent-queue stage A)", () => {
  it("field repro: an un-awaited slow agent() + await parallel([4 thunks]) at maxParallel 4 — every slot non-null, no stage_error", async () => {
    const { spawner, spawned } = delayedSpawner({ delayMsOf: (p) => (p === "slow" ? 300 : 50) });
    const { host, outcome, stageErrors } = await bootReal(
      scriptWith(
        'const slow = agent("slow");\n' +
          'const r = await parallel([1, 2, 3, 4].map((i) => () => agent("t" + i)));\n' +
          "const s = await slow;\n" +
          "return JSON.stringify({ r, s });",
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(JSON.parse(result.returned as string)).toEqual({
      r: ["done:t1", "done:t2", "done:t3", "done:t4"],
      s: "done:slow",
    });
    expect(spawned).toHaveLength(5);
    expect(stageErrors).toEqual([]);
    await host.terminate("test-done");
  }, 15_000);

  it("a rejected settle (queued call whose dispatch-time spawn fails) makes agent() reject — catchable by the script", async () => {
    const { spawner } = delayedSpawner({
      delayMsOf: (p) => (p === "hold" ? 100 : 0),
      errorFor: (p) => (p === "bad" ? "unknown agent type 'nope'" : undefined),
    });
    const { host, outcome, stageErrors } = await bootReal(
      scriptWith(
        'const hold = agent("hold");\n' +
          'let caught = "no-throw";\n' +
          'try { await agent("bad", { agentType: "nope" }); } catch (e) { caught = "caught:" + e.message; }\n' +
          'return caught + "|" + (await hold);',
      ),
      spawner,
      { maxParallel: 1 },
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("caught:unknown agent type 'nope'|done:hold");
    expect(stageErrors).toEqual([]);
    await host.terminate("test-done");
  }, 15_000);

  it("review v2 #2: an un-awaited agent() that rejects is reported as stage_error(source:'unhandled') and the worker keeps running", async () => {
    const { spawner } = delayedSpawner({
      delayMsOf: (p) => (p === "good" ? 150 : 0),
      errorFor: (p) => (p === "bad" ? "unknown agent type 'nope'" : undefined),
    });
    const { host, outcome, stageErrors, workerErrors } = await bootReal(
      scriptWith('agent("bad", { agentType: "nope" });\nreturn await agent("good");'),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("done:good");
    expect(workerErrors).toEqual([]);
    expect(stageErrors).toEqual([
      {
        source: "unhandled",
        itemIndex: 0,
        message: expect.stringContaining("unknown agent type 'nope'"),
      },
    ]);
    await host.terminate("test-done");
  }, 15_000);
});

describe("worker-source: a buffered settle still carries rejected:true", () => {
  it("settle(rejected) racing ahead of its own ack is buffered and still makes agent() reject", async () => {
    const host = createWorkerHost({ clock: systemClock });
    host.events.onHostCall((env) => {
      // Deliberately out of order: the settle lands before the ack.
      host.send({
        kind: "host_settle",
        callId: env.id,
        ok: false,
        error: { message: "dispatch failed" },
        rejected: true,
      });
      host.send({
        kind: "host_ack",
        id: env.id,
        ok: true,
        value: { callId: env.id, deadlineAt: Date.now() + 10_000, queued: true },
      });
    });
    const boot = await host.boot({
      scriptSource: scriptWith(
        'try { await agent("x"); return "no-throw"; } catch (e) { return "caught:" + e.message; }',
      ),
      scriptSliceMs: 2_000,
      heartbeatMs: 0,
      workerBootMs: 5_000,
      terminateConfirmMs: 2_000,
      hostCallMs: 3_000,
      gateMs: 3_000,
    });
    expect(boot.ok).toBe(true);
    const returned = await new Promise<unknown>((resolve) => {
      host.events.onScriptReturned(resolve);
      host.events.onScriptThrew((e) => resolve({ threw: e }));
    });
    expect(returned).toBe("caught:dispatch failed");
    await host.terminate("test-done");
  }, 15_000);
});
