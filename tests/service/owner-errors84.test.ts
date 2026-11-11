import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import type { AgentTypeConfig, ErrorInfo, RunOutcome, RunSnapshot } from "../../src/core/types.js";
import { createQueryService } from "../../src/service/query-service.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { createAgentTool } from "../../src/tools/agent-tool.js";

const ctx = new Proxy({} as ExtensionToolContext, {
  get() {
    throw new Error("unexpected SDK context access");
  },
});
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const diag: RunSnapshot["diag"] = {
  createdAt: 0,
  phase: "model_turn",
  phaseEnteredAt: 0,
  pendingTools: 0,
  turns: 1,
  escalation: [],
  orphaned: false,
  generation: 1,
  degraded: [],
  staleInputs: 0,
  unkillable: [],
};
const outcome: RunOutcome = { runId: "r84", status: "completed", turns: 1, durationMs: 1, diag };
const snap = (status: RunSnapshot["status"] = "running"): RunSnapshot => ({
  runId: "r84",
  generation: 1,
  status,
  phase: "model_turn",
  diag,
  deadlines: { enqueuedAt: 0, deadlineAt: 100, queueDeadlineAt: undefined },
  updatedAt: 0,
});
const secret = "private-provider-credential";
async function errorMessage(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected rejection");
}
function spawnService() {
  const run = vi.fn(async () => outcome);
  const acquire = vi.fn(async (runId: string) => ({ ok: true as const, ticket: { runId, release() {} } }));
  const service = createSpawnService({
    types: {
      get: (name) => (name === "worker" ? type : undefined),
      list: () => [type],
      reload: async () => ({ types: [type], errors: [] }),
      configHashOf: () => undefined,
    },
    pool: { acquire },
    runner: { run },
  });
  return { service, run, acquire };
}

describe("#84 blocking Agent admission boundary", () => {
  it.each(["spawnAndWait", "spawnAndWaitWithSlots"] as const)(
    "real %s refusal reaches only Error.message and creates no run",
    async (method) => {
      const { service, run, acquire } = spawnService();
      const request = { type: "missing", prompt: "do not repeat", label: "rejected" };
      const text = await errorMessage(service[method]!(request));
      expect(text).toContain(
        "code=agent_admission_rejected kind=config reason=unknown_type retryable=false effect=none",
      );
      expect(service.snapshots()).toEqual([]);
      expect(service.runningIds()).toEqual([]);
      expect(service.getLabel?.("rejected")).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      const tool = createAgentTool({
        spawn: method === "spawnAndWait" ? { spawn: service.spawn, spawnAndWait: service.spawnAndWait } : service,
        allowedTypes: ["missing"],
      });
      const toolText = await errorMessage(
        tool.execute(
          "tc84",
          { description: "d", prompt: "do not repeat", subagent_type: "missing" },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(toolText).toContain(
        "code=agent_admission_rejected kind=config reason=unknown_type retryable=false effect=none",
      );
      expect(toolText).toContain("do not automatically resubmit");
      expect(run).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    },
  );
  it.each(["spawnAndWait", "spawnAndWaitWithSlots"] as const)(
    "%s keeps authoritative facts but never internal message/stack",
    async (method) => {
      for (const facts of [
        { kind: "auth", reason: "config", retryable: false },
        { kind: "startup_transient", reason: "load", retryable: true },
        { kind: "config", reason: "session_closing", retryable: true },
        { kind: "aborted", retryable: false },
      ] satisfies Omit<ErrorInfo, "message">[]) {
        const { service, run } = spawnService();
        const spawn = vi
          .spyOn(service, "spawn")
          .mockResolvedValue({ error: { ...facts, message: secret, stack: secret } });
        const tool = createAgentTool({
          spawn: method === "spawnAndWait" ? { spawn: service.spawn, spawnAndWait: service.spawnAndWait } : service,
          allowedTypes: ["worker"],
        });
        const text = await errorMessage(
          tool.execute(
            "tc84",
            { description: "d", prompt: "original", subagent_type: "worker" },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(text).toContain(
          `kind=${facts.kind} reason=${"reason" in facts ? facts.reason : "unknown"} retryable=${facts.retryable} effect=none`,
        );
        expect(text).toContain("code=agent_admission_rejected");
        expect(text).not.toContain(secret);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0]?.[0]).toMatchObject({ expectAck: true, prompt: "original" });
        expect(run).not.toHaveBeenCalled();
      }
    },
  );
});

describe("#84 QueryService classified failures", () => {
  it.each([undefined, "ETIMEDOUT", "EPIPE", "BAD_SECRET_CODE"])(
    "steer exposes only allowlisted errno (%s), never arbitrary exceptions",
    async (code) => {
      const steer = vi.fn(async () => {
        throw Object.assign(new Error(secret), code ? { code } : {});
      });
      const onSteered = vi.fn();
      const q = createQueryService({
        registry: { get: () => snap(), list: () => [] },
        runner: { run: async () => outcome, steer },
        onSteered,
      });
      expect(await q.steer("r84", "original")).toEqual({
        ok: false,
        reason: code === "ETIMEDOUT" ? "steer_timeout" : "steer_rejected",
        detail: code === "ETIMEDOUT" || code === "EPIPE" ? code : "unknown",
      });
      expect(steer).toHaveBeenCalledTimes(1);
      expect(onSteered).not.toHaveBeenCalled();
    },
  );
  it.each(["completed", "running", "read_failed"] as const)(
    "abort rejection checks terminal read before reporting %s",
    async (state) => {
      let aborted = false;
      const abort = vi.fn(async () => {
        aborted = true;
        throw new Error(secret);
      });
      const get = vi.fn(() => {
        if (aborted && state === "read_failed") throw new Error(secret);
        return snap(aborted && state === "completed" ? "completed" : "running");
      });
      const q = createQueryService({ registry: { get, list: () => [] }, runner: { run: async () => outcome, abort } });
      expect(await q.stop("r84")).toEqual(
        state === "completed"
          ? { ok: false, reason: "already_terminal", status: "completed" }
          : { ok: false, reason: "stop_failed", escalatedTo: "L4" },
      );
      expect(get).toHaveBeenCalledTimes(2);
      expect(abort).toHaveBeenCalledTimes(1);
    },
  );
  it("a later poll read error remains a rejection, not a wait_timeout or terminal outcome", async () => {
    const clock = new FakeClock();
    let reads = 0;
    const q = createQueryService({
      clock,
      registry: {
        get: () => {
          if (++reads === 3) throw Object.assign(new Error(secret), { code: "EPIPE" });
          return snap();
        },
        list: () => [],
      },
      runner: { run: async () => outcome },
    });
    const pending = errorMessage(q.wait("r84", { waitMs: 50 }));
    clock.advance(10);
    const text = await pending;
    expect(text).toContain("code=result_read_failed reason=EPIPE retryable=false effect=none");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("wait_timeout");
  });
});
