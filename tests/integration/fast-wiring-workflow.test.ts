import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { SpawnService } from "../../src/service/spawn-service.js";
import type { FastMode, SpawnRequest } from "../../src/core/types.js";
import { createFastController, createFastSessionPorts } from "../../src/fast/wire.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import { buildWorkflowRunBudget } from "../../src/workflow/run-budget.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator } from "../../src/workflow/orchestrator.js";

// Real worker/orchestrator/journal + production spawner bridge, controlled lower service.
// Slot queue preservation is separately pinned by P3's real runtime-adapter/SingleSlotPool cases.
describe("Fast production orchestrator's spawner-only capture bridge", () => {
  it("mode affects replay keys; inherit=disabled legacy; closed A cannot read live B", async () => {
    const root = mkdtempSync(join(tmpdir(), "fast-wiring-orch-"));
    const requests: SpawnRequest[] = [];
    let n = 0;
    const service = {
      spawn: async (request: SpawnRequest) => {
        requests.push(request);
        return { runId: `r${++n}` };
      },
      abort: async () => true,
      waitAll: async ({ runIds }: { runIds: readonly string[] }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed", text: "local child" })),
        pending: [],
      }),
      stopChildrenOf: async () => [],
    } as unknown as SpawnService;
    const types = { configHashOf: () => "stable-agent-config" } as unknown as AgentTypeRegistry;
    const makeOwner = (initial: FastMode) => {
      let branch: unknown[] = [{ type: "custom", customType: "subagent:fast", data: { v: 1, mode: initial } }];
      const controller = createFastController({
        getBranch: () => branch,
        isCurrent: () => true,
        appendEntry: (customType, data) => {
          branch = [...branch, { type: "custom", customType, data }];
        },
      });
      return { controller, ports: createFastSessionPorts(controller) };
    };
    const a = makeOwner("on");
    const b = makeOwner("off");
    const run = async (owner?: typeof a) => {
      const spawner = createWorkflowChildSpawner(service, types, owner ? { fastWorkflow: owner.ports.workflow } : {});
      const orchestrator = createOrchestrator({
        clock: systemClock,
        createWorkerHost: () => createWorkerHost({ clock: systemClock }),
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        journalRootDir: root,
      });
      const start = requests.length;
      const outcome = await orchestrator.run({
        workflowId: `wf_${++n}`,
        script: 'export const meta={name:"fast-wiring",description:"offline"}; return await agent("same prompt");',
        budget: {
          ...buildWorkflowRunBudget(DEFAULT_SETTINGS),
          heartbeatMs: 0,
          workerBootMs: 5000,
          workflowTotalMs: 15000,
        },
        journal: "shared",
      });
      expect(outcome.status).toBe("completed");
      return requests.slice(start).map((r) => r.fastSeed);
    };
    try {
      expect(await run(a)).toEqual([{ v: 1, mode: "on" }]);
      expect(await run(a)).toEqual([]); // actual journal hit, no service call
      a.controller.command("off");
      expect(await run(a)).toEqual([{ v: 1, mode: "off" }]);
      expect(await run()).toEqual([undefined]); // legacy misses on/off
      a.controller.command("reset");
      expect(await run(a)).toEqual([]); // inherit uses legacy key
      a.ports.dispose();
      expect(a.ports.workflow.capture()).toBeUndefined();
      expect(b.ports.workflow.capture()).toEqual({ v: 1, mode: "off" });
      expect(await run(a)).toEqual([]); // closed capture uses legacy, never B's off
      expect(await run(b)).toEqual([]); // B's off hits prior off journal
    } finally {
      a.ports.dispose();
      b.ports.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
