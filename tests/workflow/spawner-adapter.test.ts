import { describe, expect, it, vi } from "vitest";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { SpawnRequest, SpawnService } from "../../src/service/spawn-service.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";

/**
 * spawner-adapter.ts: the production `ChildSpawner` over the real
 * `SpawnService`. The interesting part for `agent()`'s per-call
 * model/thinking overrides is pure forwarding — `handleAgent` (host.ts)
 * already split `opts.model` into `modelOverride`/`modelHintOverride` with
 * the Agent tool's own rules; if any of the three override fields were
 * dropped here, spawn admission would silently run the child on the agent
 * type's frontmatter model instead (the exact regression this file pins).
 */

function fakeSpawnService(
  spawnImpl?: (req: SpawnRequest) => Promise<{ runId: string } | { error: { message: string } }>,
) {
  const requests: SpawnRequest[] = [];
  const service = {
    spawn: async (req: SpawnRequest) => {
      requests.push(req);
      if (spawnImpl) return spawnImpl(req);
      return { runId: "run-1" };
    },
    abort: async () => true,
    waitAll: async () => ({ settled: [], pending: [] }),
    stopChildrenOf: async () => ({ stopped: [], pending: [] }),
  } as unknown as SpawnService;
  return { service, requests };
}

function fakeTypes(): AgentTypeRegistry {
  return { configHashOf: (name) => `cfg:${name}` } as unknown as AgentTypeRegistry;
}

describe("createWorkflowChildSpawner: model/thinking override forwarding", () => {
  it("forwards modelOverride / modelHintOverride / thinkingOverride to SpawnService.spawn", async () => {
    const { service, requests } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await adapter.spawn({
      type: "general",
      prompt: "p1",
      modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" },
    });
    await adapter.spawn({ type: "general", prompt: "p2", modelHintOverride: "sonnet" });
    await adapter.spawn({ type: "general", prompt: "p3", thinkingOverride: "high" });
    await adapter.spawn({ type: "general", prompt: "p4", modelHintOverride: "glm", thinkingOverride: "low" });

    expect(requests[0]).toMatchObject({ modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" } });
    expect(requests[0]).not.toHaveProperty("modelHintOverride");
    expect(requests[0]).not.toHaveProperty("thinkingOverride");
    expect(requests[1]).toMatchObject({ modelHintOverride: "sonnet" });
    expect(requests[1]).not.toHaveProperty("modelOverride");
    expect(requests[2]).toMatchObject({ thinkingOverride: "high" });
    expect(requests[3]).toMatchObject({ modelHintOverride: "glm", thinkingOverride: "low" });
  });

  it("adds no override keys when none were passed (SpawnRequest shape unchanged)", async () => {
    const { service, requests } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await adapter.spawn({ type: "general", prompt: "p" });
    expect(requests[0]).not.toHaveProperty("modelOverride");
    expect(requests[0]).not.toHaveProperty("modelHintOverride");
    expect(requests[0]).not.toHaveProperty("thinkingOverride");
  });

  it("keeps the label/deadlineAt/budgetOverride forwarding intact alongside the new fields", async () => {
    const { service, requests } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await adapter.spawn({
      type: "verifier",
      prompt: "p",
      label: "verify:1",
      deadlineAt: 123_000,
      parentRunId: "wf_1",
      budgetOverride: { totalMs: 10_000, queueWaitMs: 5_000 },
      modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" },
      thinkingOverride: "medium",
    });
    expect(requests[0]).toMatchObject({
      type: "verifier",
      prompt: "p",
      label: "verify:1",
      deadlineAt: 123_000,
      parentRunId: "wf_1",
      budgetOverride: { totalMs: 10_000, queueWaitMs: 5_000 },
      modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" },
      thinkingOverride: "medium",
    });
  });

  it("narrows a spawn error to { error: { message } } verbatim — unknown-model suggestions survive the adapter", async () => {
    const { service } = fakeSpawnService(async () => ({
      error: {
        message: 'Unknown model "ghost/model-x" — Did you mean: zai/glm-5.3?',
      },
    }));
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    const result = await adapter.spawn({
      type: "general",
      prompt: "p",
      modelOverride: { provider: "ghost", id: "model-x" },
    });
    expect(result).toEqual({ error: { message: expect.stringContaining("Did you mean: zai/glm-5.3?") } });
  });

  it("wires configHashOf through to the AgentTypeRegistry", async () => {
    const { service } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    expect(adapter.configHashOf?.("general")).toBe("cfg:general");
  });
});

describe("createWorkflowChildSpawner: workflow-experts (§4.8)", () => {
  it("forwards consultExperts verbatim to SpawnService.spawn when present, and omits the key entirely when absent", async () => {
    const { service, requests } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    const refs = [{ runId: "r1", sessionFile: "/tmp/r1.jsonl", agentType: "gp" }];
    await adapter.spawn({ type: "general", prompt: "p", consultExperts: refs });
    await adapter.spawn({ type: "general", prompt: "p2" });
    expect(requests[0]).toMatchObject({ consultExperts: refs });
    expect(requests[1]).not.toHaveProperty("consultExperts");
  });

  it("omits consultExperts when the array is empty (never sends an empty whitelist)", async () => {
    const { service, requests } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await adapter.spawn({ type: "general", prompt: "p", consultExperts: [] });
    expect(requests[0]).not.toHaveProperty("consultExperts");
  });

  it("resolveExperts is absent from the ChildSpawner when no option was supplied", () => {
    const { service } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    expect(adapter.resolveExperts).toBeUndefined();
  });

  it("resolveExperts always calls the injected resolver with { completedOnly: true } fixed (D8), regardless of caller intent", () => {
    const { service } = fakeSpawnService();
    const injected = vi.fn(() => ({ refs: [] }));
    const adapter = createWorkflowChildSpawner(service, fakeTypes(), { resolveExperts: injected });
    adapter.resolveExperts!(["dev"]);
    expect(injected).toHaveBeenCalledWith(["dev"], { completedOnly: true });
  });

  it("a throwing injected resolver is caught and turned into { error } (D17 belt-and-braces)", () => {
    const { service } = fakeSpawnService();
    const injected = vi.fn(() => {
      throw new Error("consult exploded");
    });
    const adapter = createWorkflowChildSpawner(service, fakeTypes(), { resolveExperts: injected });
    expect(adapter.resolveExperts!(["dev"])).toEqual({ error: { message: "consult exploded" } });
  });

  it("a successful injected resolver's refs/error pass through verbatim", () => {
    const { service } = fakeSpawnService();
    const refs = [{ runId: "r1", sessionFile: "/tmp/r1.jsonl", agentType: "gp" }];
    const injected = vi.fn(() => ({ refs }));
    const adapter = createWorkflowChildSpawner(service, fakeTypes(), { resolveExperts: injected });
    expect(adapter.resolveExperts!(["dev"])).toEqual({ refs });
  });
});

describe("createWorkflowChildSpawner: workflow-worktree (D1/D2/D5)", () => {
  it('forwards isolation:"worktree" verbatim to SpawnService.spawn, and omits the key entirely when absent', async () => {
    const { service, requests } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await adapter.spawn({ type: "general", prompt: "p", isolation: "worktree" });
    await adapter.spawn({ type: "general", prompt: "p2" });
    expect(requests[0]).toMatchObject({ isolation: "worktree" });
    expect(requests[1]).not.toHaveProperty("isolation");
  });

  it("worktreeAvailable is absent from the adapter when no option was supplied", () => {
    const { service } = fakeSpawnService();
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    expect(adapter.worktreeAvailable).toBeUndefined();
  });

  it("worktreeAvailable reads the injected getter's LIVE value on every call (not a dispatch-time snapshot)", () => {
    const { service } = fakeSpawnService();
    let flag = false;
    const adapter = createWorkflowChildSpawner(service, fakeTypes(), { worktreeAvailable: () => flag });
    expect(adapter.worktreeAvailable!()).toBe(false);
    flag = true;
    expect(adapter.worktreeAvailable!()).toBe(true);
  });

  it("awaitWorktree maps a 'settled' SpawnService result onto ChildWorktreeInfo, branch/path included only when present", async () => {
    const { service } = fakeSpawnService();
    (
      service as unknown as { waitWorktreeDisposition: SpawnService["waitWorktreeDisposition"] }
    ).waitWorktreeDisposition = async (_runId, _opts) => ({
      kind: "settled",
      disposition: { state: "committed", branch: "pi-agent-r1" },
    });
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await expect(adapter.awaitWorktree!("r1", { horizon: "settle" })).resolves.toEqual({
      state: "committed",
      branch: "pi-agent-r1",
    });
  });

  it("awaitWorktree maps 'timeout' and 'disposed' both onto state:'pending' — host.ts never needs to tell them apart", async () => {
    const { service } = fakeSpawnService();
    const results: Array<{ kind: "timeout" } | { kind: "disposed" }> = [{ kind: "timeout" }, { kind: "disposed" }];
    (
      service as unknown as { waitWorktreeDisposition: SpawnService["waitWorktreeDisposition"] }
    ).waitWorktreeDisposition = async () => results.shift()!;
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await expect(adapter.awaitWorktree!("r1", { horizon: "settle" })).resolves.toEqual({ state: "pending" });
    await expect(adapter.awaitWorktree!("r1", { horizon: "late" })).resolves.toEqual({ state: "pending" });
  });

  it("awaitWorktree maps 'none' onto state:'none'", async () => {
    const { service } = fakeSpawnService();
    (
      service as unknown as { waitWorktreeDisposition: SpawnService["waitWorktreeDisposition"] }
    ).waitWorktreeDisposition = async () => ({ kind: "none" });
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await expect(adapter.awaitWorktree!("r1", { horizon: "settle" })).resolves.toEqual({ state: "none" });
  });

  it("awaitWorktree degrades to state:'none' when the underlying SpawnService has no waitWorktreeDisposition at all", async () => {
    const { service } = fakeSpawnService();
    delete (service as { waitWorktreeDisposition?: unknown }).waitWorktreeDisposition;
    const adapter = createWorkflowChildSpawner(service, fakeTypes());
    await expect(adapter.awaitWorktree!("r1", { horizon: "settle" })).resolves.toEqual({ state: "none" });
  });
});
