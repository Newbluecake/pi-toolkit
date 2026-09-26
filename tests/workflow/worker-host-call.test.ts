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
 * workflow-worktree plan §6 P2 tests 19-20: `fullResult`'s `worktree` key
 * end-to-end through the real worker — present (and only present) for an
 * isolated call's SUCCESSFUL settle, absent for every other shape, and the
 * failure/abort path still resolves to plain `null` (never throws, never
 * hangs) exactly like the pre-D5 baseline.
 */
describe("real-worker agent({isolation}) worktree field (workflow-worktree plan D5, §6 tests 19-20)", () => {
  it("fullResult carries worktree only for an isolated call, and Object.keys stays exactly [text,runId,label] otherwise", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r-wt", label: "wt-label" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "wt text" })),
        pending: [],
      }),
      worktreeAvailable: () => true,
      awaitWorktree: async () => ({ state: "committed", branch: "pi-agent-r-wt" }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'const iso = await agent("x", { isolation: "worktree", fullResult: true }); ' +
          'const plain = await agent("y", { fullResult: true }); ' +
          "return JSON.stringify({ isoKeys: Object.keys(iso).sort(), iso: iso, plainKeys: Object.keys(plain).sort() });",
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    const parsed = JSON.parse(result.returned as string);
    expect(parsed.isoKeys).toEqual(["label", "runId", "text", "worktree"]);
    expect(parsed.iso.worktree).toEqual({ state: "committed", branch: "pi-agent-r-wt" });
    expect(parsed.plainKeys).toEqual(["label", "runId", "text"]); // unisolated: byte-identical to the pre-D5 shape
  }, 10_000);

  it("replay-verify plan D1.3 Object.keys regression: `worktree.commit` is present only for a committed disposition WITH a reported sha, and never changes the non-isolated shape", async () => {
    const cases: Array<{
      label: string;
      disposition: {
        state: "committed" | "clean" | "kept" | "pending" | "none";
        branch?: string;
        path?: string;
        commit?: string;
      };
      expectTopKeys: readonly string[];
      expectWtKeys: readonly string[];
    }> = [
      {
        label: "committed-with-sha",
        disposition: { state: "committed", branch: "pi-agent-r-wt", commit: "a".repeat(40) },
        expectTopKeys: ["label", "runId", "text", "worktree"],
        expectWtKeys: ["branch", "commit", "state"],
      },
      {
        label: "committed-without-sha",
        disposition: { state: "committed", branch: "pi-agent-r-wt" },
        expectTopKeys: ["label", "runId", "text", "worktree"],
        expectWtKeys: ["branch", "state"],
      },
      {
        label: "kept",
        disposition: { state: "kept", path: "/tmp/wt" },
        expectTopKeys: ["label", "runId", "text", "worktree"],
        expectWtKeys: ["path", "state"],
      },
      {
        label: "clean",
        disposition: { state: "clean" },
        expectTopKeys: ["label", "runId", "text", "worktree"],
        expectWtKeys: ["state"],
      },
    ];
    for (const { label, disposition, expectTopKeys, expectWtKeys } of cases) {
      const spawner: ChildSpawner = {
        spawn: async () => ({ runId: `r-${label}`, label: `${label}-label` }),
        abort: async () => true,
        waitAll: async ({ runIds }) => ({
          settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "wt text" })),
          pending: [],
        }),
        worktreeAvailable: () => true,
        awaitWorktree: async () => disposition,
      };
      const { outcome } = await bootReal(
        scriptWith(
          'const iso = await agent("x", { isolation: "worktree", fullResult: true }); ' +
            "return JSON.stringify({ topKeys: Object.keys(iso).sort(), wtKeys: Object.keys(iso.worktree).sort() });",
        ),
        spawner,
      );
      const result = await outcome;
      expect(result.threw).toBeUndefined();
      const parsed = JSON.parse(result.returned as string);
      expect(parsed.topKeys, `${label}: top-level keys`).toEqual([...expectTopKeys].sort());
      expect(parsed.wtKeys, `${label}: worktree keys`).toEqual([...expectWtKeys].sort());
    }
  }, 10_000);

  it("a failed isolated child still resolves agent() to plain null (§5.2/§5.3 semantics), fullResult included", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r-wt-fail" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "failed" as const, error: { message: "boom" } })),
        pending: [],
      }),
      worktreeAvailable: () => true,
      awaitWorktree: async () => ({ state: "kept", path: "/tmp/wt/r-wt-fail" }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'const a = await agent("x", { isolation: "worktree" }); ' +
          'const b = await agent("y", { isolation: "worktree", fullResult: true }); ' +
          "return JSON.stringify({ a, b });",
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(JSON.parse(result.returned as string)).toEqual({ a: null, b: null });
    await host.terminate("test-done");
  }, 10_000);

  it('isolation:"worktree" rejected by the D2 availability gate is a catchable rejection, not a null/hang', async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
      worktreeAvailable: () => false,
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("x", { isolation: "worktree" }); return "no-throw"; } ' +
          'catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toMatch(/^caught:/);
    expect(result.returned).toContain("worktree.enabled");
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

describe("real-worker agent() model/thinking opts (per-call overrides)", () => {
  it("forwards opts.model/opts.thinking verbatim: a strict pair reaches spawn as modelOverride (+ thinkingOverride)", async () => {
    const spawns: Parameters<ChildSpawner["spawn"]>[0][] = [];
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        spawns.push(req);
        return { runId: "r-model" };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith('await agent("do", { model: "cr-anthropic/claude-sonnet-5", thinking: "high" }); return "done";'),
      spawner,
    );
    const result = await outcome;
    expect(result.returned).toBe("done");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" },
      thinkingOverride: "high",
    });
    await host.terminate("test-done");
  }, 10_000);

  it("an unknown model rejects agent() with the spawn-service message preserved (Did you mean suggestion)", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({
        error: {
          message:
            'Unknown model "cloudrouter-anthropic/claude-opus-5-5" — not in pi\'s model registry, so no run ' +
            "was started. Did you mean: cr-anthropic/claude-opus-5-5?",
        },
      }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("do", { model: "cloudrouter-anthropic/claude-opus-5-5" }); return "not-rejected"; }' +
          ' catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe(
      'caught:Unknown model "cloudrouter-anthropic/claude-opus-5-5" — not in pi\'s model registry, so no ' +
        "run was started. Did you mean: cr-anthropic/claude-opus-5-5?",
    );
    await host.terminate("test-done");
  }, 10_000);

  it("a non-string model / out-of-set thinking reject client-side with a TypeError — no host round-trip, no spawn", async () => {
    const spawns: Parameters<ChildSpawner["spawn"]>[0][] = [];
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        spawns.push(req);
        return { runId: "r" };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        "const r = {};\n" +
          'try { await agent("x", { model: 42 }); r.m = "no-reject"; } catch (e) { r.m = e.name + ":" + e.message; }\n' +
          'try { await agent("x", { thinking: "max" }); r.t = "no-reject"; } catch (e) { r.t = e.name + ":" + e.message; }\n' +
          "return r;",
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toMatchObject({
      m: "TypeError:agent(prompt, opts?): opts.model must be a string",
      t: expect.stringContaining("opts.thinking must be one of"),
    });
    expect(spawns).toHaveLength(0);
    await host.terminate("test-done");
  }, 10_000);
});

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §4.5, N1, §6 test
 * A#10): the worker-side JS mirror of agent-opts.ts's structural snapshot,
 * exercised through a REAL sandbox realm — only here can a genuine getter/
 * Proxy/function object literal be constructed the way a script actually
 * would. N1's core claim (never `postMessage` an unclonable value, so a
 * defect is reported *immediately* rather than after HR1's timeout) is
 * pinned by the elapsed-time assertions below: `hostCallMs` is 3s in this
 * harness, so anything that resolves in well under a second could not have
 * gone through the pre-fix DataCloneError-swallowed-by-`send()` path.
 */
describe("real-worker agent() opts snapshot (workflow-experts §4.5, N1)", () => {
  it("a function value on a known key fails immediately (well under HR1's timeout), never waits for a settle", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const started = Date.now();
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("x", { label: function () {} }); return "no-reject"; }' +
          ' catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    const elapsedMs = Date.now() - started;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toContain("caught:");
    expect(result.returned).toContain("plain object");
    expect(elapsedMs).toBeLessThan(1_500); // HR1/hostCallMs here is 3_000ms
    await host.terminate("test-done");
  }, 10_000);

  it("a getter on a known key is rejected without ever being invoked (its side effect never fires)", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        "const opts = {};\n" +
          'Object.defineProperty(opts, "model", { enumerable: true, configurable: true, get: function () { throw new Error("getter ran"); } });\n' +
          'try { await agent("x", opts); return "no-reject"; } catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toContain("caught:");
    expect(result.returned).not.toContain("getter ran");
    expect(result.returned).toContain("accessors are not allowed");
    await host.terminate("test-done");
  }, 10_000);

  it("a real Proxy as the whole opts object is rejected without its traps ever firing", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'const opts = new Proxy({}, { ownKeys: function () { throw new Error("trap fired"); } });\n' +
          'try { await agent("x", opts); return "no-reject"; } catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toContain("caught:");
    expect(result.returned).not.toContain("trap fired");
    expect(result.returned).toContain("Proxy");
    await host.terminate("test-done");
  }, 10_000);

  it("a function element inside experts[] is bad_array, immediately, never spawns", async () => {
    const spawns: unknown[] = [];
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        spawns.push(req);
        return { runId: "r" };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("x", { experts: [function () {}] }); return "no-reject"; }' +
          ' catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toContain("caught:");
    expect(result.returned).toContain("experts");
    expect(spawns).toHaveLength(0);
    await host.terminate("test-done");
  }, 10_000);

  it("an unknown key (effort) round-trips fine on the wire but is still rejected — host generates the message", async () => {
    const spawns: unknown[] = [];
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        spawns.push(req);
        return { runId: "r" };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("x", { effort: "low" }); return "no-reject"; }' +
          ' catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toContain("caught:");
    expect(result.returned).toContain('"effort"');
    expect(result.returned).toContain("thinking");
    expect(spawns).toHaveLength(0);
    await host.terminate("test-done");
  }, 10_000);

  it("a well-formed experts array round-trips through the real worker and reaches the ChildSpawner", async () => {
    const spawns: Parameters<ChildSpawner["spawn"]>[0][] = [];
    const refs = [{ runId: "r-expert", sessionFile: "/tmp/r-expert.jsonl", agentType: "gp" }];
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        spawns.push(req);
        return { runId: "r1" };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
      resolveExperts: (handles) => ({ refs: handles.map(() => refs[0]!) }),
    };
    const { host, outcome } = await bootReal(scriptWith('return await agent("x", { experts: ["dev"] });'), spawner);
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("ok");
    expect(spawns[0]).toMatchObject({ consultExperts: refs });
    await host.terminate("test-done");
  }, 10_000);
});
