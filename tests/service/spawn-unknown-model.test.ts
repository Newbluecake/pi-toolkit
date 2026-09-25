import { describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";
import type { ModelCandidate } from "../../src/config/model-hint.js";

/**
 * Dispatch-time strict provider/id admission (incident 2026-09-25: a renamed
 * provider `cloudrouter-anthropic` → `cr-anthropic` was accepted, the run was
 * created and died ~2s later reporting only "cancelled"). An unknown pair must
 * now be rejected before any run exists, with a "did you mean"; an unusable
 * registry must never block.
 */
const plain: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const pinned: AgentTypeConfig = {
  ...plain,
  name: "pinned",
  model: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
};
const pinnedOk: AgentTypeConfig = {
  ...plain,
  name: "pinned-ok",
  model: { provider: "cr-anthropic", id: "claude-opus-5-5" },
};
const hinted: AgentTypeConfig = { ...plain, name: "hinted", modelHint: "opus" };
const TYPES = [plain, pinned, pinnedOk, hinted];

const REGISTRY: ModelCandidate[] = [
  { provider: "cr-anthropic", id: "claude-opus-5-5" },
  { provider: "cr-anthropic", id: "claude-sonnet-5" },
  { provider: "zai", id: "glm-5.3" },
];
const known = (m: { provider: string; id: string }) => REGISTRY.some((c) => c.provider === m.provider && c.id === m.id);

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

function harness(modelExists?: (m: { provider: string; id: string }) => boolean | undefined) {
  const runs: Array<{ runId: string; model?: unknown }> = [];
  const runner: Runner = {
    run: async (spec) => {
      runs.push({ runId: spec.runId, model: (spec as { model?: unknown }).model });
      return outcome(spec.runId);
    },
  };
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  const labels: string[] = [];
  const service = createSpawnService({
    types: {
      get: (n: string) => TYPES.find((t) => t.name === n),
      list: () => TYPES,
      reload: async () => ({ types: TYPES, errors: [] }),
    },
    pool,
    runner,
    now: () => 0,
    resolveModelHint: (hint) => (hint === "opus" ? { provider: "cr-anthropic", id: "claude-opus-5-5" } : undefined),
    availableModels: () => REGISTRY,
    onLabel: (label) => labels.push(label),
    ...(modelExists ? { modelExists } : {}),
  });
  return { service, runs, labels };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("spawn admission: strict provider/id existence", () => {
  it("rejects an unknown provider with the same-id candidate and creates no run", async () => {
    const h = harness(known);
    const result = await h.service.spawn({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
    });
    await flush();
    expect(result).toMatchObject({ error: { kind: "config", retryable: false } });
    const message = "error" in result ? result.error.message : "";
    expect(message).toContain('Unknown model "cloudrouter-anthropic/claude-opus-5-5"');
    expect(message).toContain("Did you mean: cr-anthropic/claude-opus-5-5");
    expect(h.runs).toEqual([]); // runner never entered
    expect(h.labels).toEqual([]); // zero mutable admission state
    expect(h.service.snapshots()).toEqual([]);
  });

  it("rejects an unknown id under a known provider, suggesting close ids of that provider", async () => {
    const h = harness(known);
    const result = await h.service.spawn({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-6" },
    });
    const message = "error" in result ? result.error.message : "";
    expect(message).toContain('Unknown model "cr-anthropic/claude-sonnet-6"');
    expect(message).toContain("Did you mean: cr-anthropic/claude-sonnet-5");
    expect(h.runs).toEqual([]);
  });

  it("admits a known pair unchanged", async () => {
    const h = harness(known);
    const result = await h.service.spawnAndWait({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "zai", id: "glm-5.3" },
    });
    expect(result.status).toBe("completed");
    expect(h.runs.map((r) => r.model)).toEqual([{ provider: "zai", id: "glm-5.3" }]);
  });

  it("does not block when the registry is unavailable (undefined verdict)", async () => {
    const h = harness(() => undefined);
    const result = await h.service.spawnAndWait({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
    });
    expect(result.status).toBe("completed");
    expect(h.runs).toHaveLength(1);
  });

  it("without the port wired there is no dispatch-time check (pre-existing behavior)", async () => {
    const h = harness();
    const result = await h.service.spawnAndWait({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
    });
    expect(result.status).toBe("completed");
  });

  it("checks an agent type's frontmatter default pair and names it as the source", async () => {
    const h = harness(known);
    const result = await h.service.spawn({ type: "pinned", prompt: "x" });
    const message = "error" in result ? result.error.message : "";
    expect(message).toContain('Unknown model "cloudrouter-anthropic/claude-opus-5-5"');
    expect(message).toContain('(agent type "pinned" frontmatter model)');
    expect(h.runs).toEqual([]);
  });

  it("a valid request override still wins over a stale frontmatter default", async () => {
    const h = harness(known);
    const result = await h.service.spawnAndWait({
      type: "pinned",
      prompt: "x",
      modelOverride: { provider: "cr-anthropic", id: "claude-sonnet-5" },
    });
    expect(result.status).toBe("completed");
    expect(h.runs.map((r) => r.model)).toEqual([{ provider: "cr-anthropic", id: "claude-sonnet-5" }]);
  });

  it("valid frontmatter defaults and resolved fuzzy hints are not regressed", async () => {
    const h = harness(known);
    expect((await h.service.spawnAndWait({ type: "pinned-ok", prompt: "x" })).status).toBe("completed");
    expect((await h.service.spawnAndWait({ type: "hinted", prompt: "x" })).status).toBe("completed");
    expect((await h.service.spawnAndWait({ type: "worker", prompt: "x", modelHintOverride: "opus" })).status).toBe(
      "completed",
    );
    expect(h.runs.map((r) => r.model)).toEqual([
      { provider: "cr-anthropic", id: "claude-opus-5-5" },
      { provider: "cr-anthropic", id: "claude-opus-5-5" },
      { provider: "cr-anthropic", id: "claude-opus-5-5" },
    ]);
    // An unresolvable hint keeps its own (unchanged) error text.
    const bad = await h.service.spawn({ type: "worker", prompt: "x", modelHintOverride: "nope" });
    expect("error" in bad && bad.error.message).toContain('unknown model hint: "nope"');
  });

  it("no model at all (pi session default) is not checked", async () => {
    let asked = 0;
    const h = harness((m) => {
      asked++;
      return known(m);
    });
    expect((await h.service.spawnAndWait({ type: "worker", prompt: "x" })).status).toBe("completed");
    expect(asked).toBe(0);
  });

  it("spawnAndWait (nested Agent / workflow / goal verifier path) surfaces the same error", async () => {
    const h = harness(known);
    await expect(
      h.service.spawnAndWait({
        type: "worker",
        prompt: "x",
        modelOverride: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
      }),
    ).rejects.toThrow(/Unknown model "cloudrouter-anthropic\/claude-opus-5-5".*cr-anthropic\/claude-opus-5-5/);
  });
});
