import { describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { SpawnService } from "../../src/service/spawn-service.js";
import { attachHostCallHandler } from "../../src/workflow/host.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";

// Real worker -> host validator -> production adapter, including deprecated stack wiring.
describe("workflow experts removal compatibility", () => {
  it.each(['["main"]', "[]", "undefined", "[function () {}]"])(
    "rejects experts=%s and .catch() recovers to a normal dispatch",
    async (experts) => {
      const spawn = vi.fn(async (_req: Parameters<SpawnService["spawn"]>[0]) => ({ runId: "plain-run" }));
      const resolveExperts = vi.fn(() => {
        throw new Error("deprecated resolver must not run");
      });
      const service = {
        spawn,
        waitAll: async () => ({
          settled: [{ runId: "plain-run", status: "completed", text: "plain-result" }],
          pending: [],
        }),
        abort: async () => true,
      } as unknown as SpawnService;
      const adapter = createWorkflowChildSpawner(
        service,
        { configHashOf: () => "hash" } as unknown as AgentTypeRegistry,
        { resolveExperts },
      );
      const host = createWorkerHost({ clock: systemClock });
      const handler = attachHostCallHandler({
        clock: systemClock,
        workerHost: host,
        spawner: adapter,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        budget: {
          hostCallMs: 3000,
          gateMs: 3000,
          maxParallel: 4,
          maxChildren: 10,
          maxBatchItems: 10,
          childBudgetPolicy: "inherit_remaining",
        },
        workflowDeadlineAt: Date.now() + 30000,
      });
      const outcome = new Promise<{ returned?: unknown; threw?: unknown }>((resolve) => {
        host.events.onScriptReturned((returned) => resolve({ returned }));
        host.events.onScriptThrew((threw) => resolve({ threw }));
      });
      try {
        const boot = await host.boot({
          scriptSource: `export const meta = { name: "removed-experts", description: "compat" };
          const error = await agent("removed", { experts: ${experts} }).catch(e => e.message);
          return { error, value: await agent("plain", { label: "plain" }) };`,
          scriptSliceMs: 2000,
          heartbeatMs: 0,
          workerBootMs: 5000,
          terminateConfirmMs: 2000,
          hostCallMs: 3000,
          gateMs: 3000,
        });
        expect(boot.ok).toBe(true);
        const result = await outcome;
        expect(result.threw).toBeUndefined();
        expect(result.returned).toEqual({
          error: expect.stringContaining("opts.experts is no longer supported"),
          value: "plain-result",
        });
        expect(resolveExperts).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0]![0]).toMatchObject({ prompt: "plain", label: "plain" });
        expect(spawn.mock.calls[0]![0]).not.toHaveProperty("consultExperts");
        expect(handler.children).toHaveLength(1);
        expect(handler.children[0]).not.toHaveProperty("experts");
      } finally {
        await host.terminate("test-done");
      }
    },
    10000,
  );
});
