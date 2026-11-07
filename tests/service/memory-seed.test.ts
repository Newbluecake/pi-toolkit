/**
 * #39 P2 (memory-scopes arch §6.3): the spawn-admission half of the memory-seed
 * pipeline. The capture happens ONCE at the synchronous admission point (the
 * fastSeed capture site — after every admission gate, before inbox/labels/slots
 * and any async work), is validated against the frozen P0 validator, deep-copied
 * and deep-frozen, and travels on `SpawnRequest.memorySeed` only. External agents
 * and resumes never carry a seed; a capture failure (throw OR an invalid capture,
 * including the legally reachable exhaustion sentinel nextN=1_000_000) fails
 * closed as a config error with locks released — never dropped, degraded to
 * empty or retried.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { MemorySeedCapture } from "../../src/memory/scopes/types.js";
import type { RunnerSpec } from "../../src/service/ports.js";

const worker: AgentTypeConfig = {
  name: "worker",
  description: "worker",
  systemPrompt: "",
  promptMode: "append",
  canSpawn: ["worker"],
};

const STAMP = "2026-11-07T17:57:00.000Z";
const item = (id: string, text = `note ${id}`) => ({
  id,
  text,
  authority: "agent" as const,
  created: STAMP,
  updated: STAMP,
});
const dataCapture = (nextN = 3): MemorySeedCapture => ({
  v: 1,
  state: "captured",
  seed: {
    v: 1,
    fromSid: "parent-sid",
    frozenAt: STAMP,
    items: [item("n1"), item("n2")],
    nextN,
  },
});

function setup(snapshot?: (parent?: string) => MemorySeedCapture | undefined) {
  const accepted: RunnerSpec[] = [];
  const capture = vi.fn(snapshot);
  const service = createSpawnService({
    types: {
      configHashOf: () => undefined,
      get: (name) => (name === "worker" ? worker : undefined),
      list: () => [worker],
      reload: async () => ({ types: [worker], errors: [] }),
    },
    pool: {
      stats: { limit: 1, inUse: 0, queued: 0, slotless: 0 },
      acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }),
    },
    runner: {
      run: (spec) => {
        accepted.push(spec);
        return new Promise(() => {});
      },
    },
    ...(snapshot ? { memoryParent: { snapshot: capture } } : {}),
  });
  return { service, accepted, capture };
}

describe("memory seed spawn admission", () => {
  it("captures once at admission, validates + deep-freezes, keeps queue stable", async () => {
    const volatile = dataCapture();
    const { service, accepted, capture } = setup(() => volatile);
    await service.spawn({ type: "worker", prompt: "one" });
    const two = await service.spawn({ type: "worker", prompt: "two" });
    expect(two).toHaveProperty("queued.position", 1);
    // Parent mutated while queued: the queued request must not re-read it.
    volatile.seed.items[0] = { ...item("n1"), text: "MUTATED" };
    const seeds = accepted.map((s) => s.request.memorySeed);
    expect(seeds[0]).toEqual(dataCapture());
    expect(seeds[0]).toEqual(seeds[1]);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.map((c) => c[0])).toEqual([undefined, undefined]);
    // Deep-frozen: wrapper, seed, items array, each item.
    expect(Object.isFrozen(seeds[0])).toBe(true);
    expect(Object.isFrozen((seeds[0] as { seed: unknown }).seed)).toBe(true);
    const items = (seeds[0] as { seed: { items: unknown[] } }).seed.items;
    expect(Object.isFrozen(items)).toBe(true);
    expect(items.every((i) => Object.isFrozen(i))).toBe(true);
    // The accepted value is a rebuilt copy, not the port's backing object.
    expect(seeds[0]).not.toBe(volatile);
    expect(items[0]).not.toBe(volatile.seed.items[0]);
  });

  it("explicit empty is preserved (blocks dequeue re-reads) and passes the trusted parent id", async () => {
    const { service, accepted, capture } = setup(() => ({ v: 1, state: "empty" as const }));
    const root = await service.spawn({ type: "worker", prompt: "root" });
    if ("error" in root) throw new Error(root.error.message);
    await service.spawn({ type: "worker", prompt: "child", parentRunId: root.runId });
    expect(accepted.map((s) => s.request.memorySeed)).toEqual([
      { v: 1, state: "empty" },
      { v: 1, state: "empty" },
    ]);
    expect(capture.mock.calls.map((c) => c[0])).toEqual([undefined, root.runId]);
  });

  it.each([false, true])("no port / disabled absence adds no key (disabled=%s)", async (disabled) => {
    const { service, accepted } = setup(disabled ? () => undefined : undefined);
    await service.spawn({ type: "worker", prompt: "legacy" });
    expect(Object.hasOwn(accepted[0]!.request, "memorySeed")).toBe(false);
    expect(Object.hasOwn(accepted[0]!.request, "fastSeed")).toBe(false);
  });

  it("keeps the workflow's earlier capture without calling the port (including empty)", async () => {
    const { service, accepted, capture } = setup(() => dataCapture());
    await service.spawn({ type: "worker", prompt: "fifo", memorySeed: dataCapture(7) });
    await service.spawn({ type: "worker", prompt: "fifo2", memorySeed: { v: 1, state: "empty" } });
    expect(capture).not.toHaveBeenCalled();
    expect(accepted[0]!.request.memorySeed).toMatchObject({ state: "captured", seed: { nextN: 7 } });
    expect(accepted[1]!.request.memorySeed).toEqual({ v: 1, state: "empty" });
  });

  it("capture failure fails closed: config error, locks released, zero runs", async () => {
    const { service, accepted, capture } = setup(() => {
      throw new Error("storage-fault");
    });
    expect(
      await service.spawn({ type: "worker", prompt: "valid", label: "same", poolFullPolicy: "reject" }),
    ).toMatchObject({ error: { kind: "config", retryable: false } });
    expect(accepted).toEqual([]);
    expect(service.runningIds()).toEqual([]);
    capture.mockImplementation(() => ({ v: 1, state: "empty" }));
    // Locks/reservations were released before the failure: an immediate retry succeeds.
    const retry = await service.spawn({ type: "worker", prompt: "retry", label: "same" });
    expect(retry).toHaveProperty("runId");
  });

  it("exhaustion sentinel (nextN 1_000_000) fails closed, not degraded — no million ops", async () => {
    // Legally reachable high-watermark: P1's fold may publish an internal sentinel
    // 1_000_000 while the frozen P0 product validator caps at 999_999 by design.
    const { service, accepted } = setup(() => dataCapture(1_000_000));
    const out = await service.spawn({ type: "worker", prompt: "full", poolFullPolicy: "reject" });
    expect(out).toMatchObject({
      error: {
        kind: "config",
        message: expect.stringContaining("memory seed capture failed"),
        retryable: false,
      },
    });
    expect(accepted).toEqual([]);
  });

  it("invalid capture shape fails closed the same way", async () => {
    const { service, accepted } = setup(
      () => ({ v: 1, state: "captured", seed: { v: 1, fromSid: "s", frozenAt: "nope", items: [], nextN: 1 } }) as never,
    );
    expect(await service.spawn({ type: "worker", prompt: "x" })).toHaveProperty(
      "error.message",
      "memory seed capture failed: invalid memory seed capture (frozenAt)",
    );
    expect(accepted).toEqual([]);
  });

  it("a resume never captures or inherits: caller-provided seeds are stripped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "memory39-resume-"));
    const sessionFile = join(tmp, "child-session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s1" }) + "\n", "utf8");
    const outcomeOf = (runId: string): RunOutcome =>
      ({
        runId,
        status: "completed",
        turns: 1,
        durationMs: 2,
        diag: {
          createdAt: 0,
          phase: "settled",
          phaseEnteredAt: 2,
          settledAt: 2,
          pendingTools: 0,
          turns: 1,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          sessionFile,
        },
      }) as never as RunOutcome;
    const accepted: RunnerSpec[] = [];
    const capture = vi.fn(() => dataCapture());
    const service = createSpawnService({
      types: {
        configHashOf: () => undefined,
        get: (name) => (name === "worker" ? worker : undefined),
        list: () => [worker],
        reload: async () => ({ types: [worker], errors: [] }),
      },
      pool: {
        stats: { limit: 1, inUse: 0, queued: 0, slotless: 0 },
        acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }),
      },
      runner: {
        run: (spec) => {
          accepted.push(spec);
          return Promise.resolve(outcomeOf(spec.runId));
        },
      },
      memoryParent: { snapshot: capture },
    });
    try {
      const first = await service.spawnAndWait({ type: "worker", prompt: "first", label: "res" });
      expect(first.status).toBe("completed");
      const resumed = await service.spawn({
        type: "worker",
        prompt: "again",
        resumeFrom: first.runId,
        memorySeed: dataCapture(99),
      });
      if ("error" in resumed) throw new Error(resumed.error.message);
      // The FIRST (create) call captured; the resume must neither capture nor inherit.
      expect(capture).toHaveBeenCalledTimes(1);
      expect(accepted.map((s) => Object.hasOwn(s.request, "memorySeed"))).toEqual([true, false]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("coexists with fastSeed: both captured, and Fast stays byte-identical without the memory port", async () => {
    const volatile = dataCapture();
    const accepted: RunnerSpec[] = [];
    const service = createSpawnService({
      types: {
        configHashOf: () => undefined,
        get: (name) => (name === "worker" ? worker : undefined),
        list: () => [worker],
        reload: async () => ({ types: [worker], errors: [] }),
      },
      pool: {
        stats: { limit: 1, inUse: 0, queued: 0, slotless: 0 },
        acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }),
      },
      runner: {
        run: (spec) => {
          accepted.push(spec);
          return new Promise(() => {});
        },
      },
      fastParent: { snapshot: () => ({ v: 1, mode: "on" }) },
      memoryParent: { snapshot: () => volatile },
    });
    const out = await service.spawn({ type: "worker", prompt: "both" });
    if ("error" in out) throw new Error(out.error.message);
    expect(accepted[0]!.request.fastSeed).toEqual({ v: 1, mode: "on" });
    expect(accepted[0]!.request.memorySeed).toEqual(dataCapture());
  });
});
