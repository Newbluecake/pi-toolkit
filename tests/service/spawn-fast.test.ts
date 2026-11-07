import { describe, it, expect, vi } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, FastMode } from "../../src/core/types.js";
import type { RunnerSpec } from "../../src/service/ports.js";

const worker: AgentTypeConfig = {
  name: "worker",
  description: "worker",
  systemPrompt: "",
  promptMode: "append",
  canSpawn: ["worker"],
};
function setup(snapshot?: (parent?: string) => { v: 1; mode: FastMode } | undefined) {
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
    ...(snapshot ? { fastParent: { snapshot: capture } } : {}),
  });
  return { service, accepted, capture };
}
describe("Fast synchronous admission", () => {
  it("captures once, projects v/mode and keeps queued acceptance stable", async () => {
    const volatile = { v: 1 as const, mode: "on" as FastMode, revision: 7, incarnation: {} };
    const { service, accepted, capture } = setup(() => volatile);
    await service.spawn({ type: "worker", prompt: "one" });
    const two = await service.spawn({ type: "worker", prompt: "two" });
    expect(two).toHaveProperty("queued.position", 1);
    volatile.mode = "off";
    expect(accepted.map((s) => s.request.fastSeed)).toEqual([
      { v: 1, mode: "on" },
      { v: 1, mode: "on" },
    ]);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(accepted[0]!.request.fastSeed).not.toBe(volatile);
  });
  it("keeps workflow's earlier seed without calling snapshot", async () => {
    const { service, accepted, capture } = setup(() => ({ v: 1, mode: "off" }));
    await service.spawn({ type: "worker", prompt: "fifo", fastSeed: { v: 1, mode: "on" } });
    expect(capture).not.toHaveBeenCalled();
    expect(accepted[0]!.request.fastSeed).toEqual({ v: 1, mode: "on" });
  });
  it.each([false, true])("no port/disabled has no undefined key, disabled=%s", async (disabled) => {
    const { service, accepted } = setup(disabled ? () => undefined : undefined);
    await service.spawn({ type: "worker", prompt: "legacy" });
    expect(Object.hasOwn(accepted[0]!.request, "fastSeed")).toBe(false);
  });
  it("does not snapshot invalid admission or reserve a slot on snapshot throw", async () => {
    const { service, accepted, capture } = setup(() => {
      throw new Error("storage-fault");
    });
    expect(await service.spawn({ type: "missing", prompt: "invalid type" })).toHaveProperty("error");
    expect(capture).not.toHaveBeenCalled();
    expect(
      await service.spawn({ type: "worker", prompt: "valid", label: "same", poolFullPolicy: "reject" }),
    ).toHaveProperty("error.message", "Fast parent snapshot failed: storage-fault");
    expect(accepted).toEqual([]);
    expect(service.runningIds()).toEqual([]);
    capture.mockImplementation(() => ({ v: 1, mode: "inherit" }));
    expect(
      await service.spawn({ type: "worker", prompt: "retry", label: "same", poolFullPolicy: "reject" }),
    ).toHaveProperty("runId");
  });
  it("passes the trusted immediate parent at both nested layers", async () => {
    const { service, accepted, capture } = setup((parent) => ({ v: 1, mode: parent ? "off" : "on" }));
    const root = await service.spawn({ type: "worker", prompt: "root" });
    if ("error" in root) throw new Error(root.error.message);
    const child = await service.spawn({ type: "worker", prompt: "child", parentRunId: root.runId });
    if ("error" in child) throw new Error(child.error.message);
    await service.spawn({ type: "worker", prompt: "grandchild", parentRunId: child.runId });
    expect(capture.mock.calls.map((c) => c[0])).toEqual([undefined, root.runId, child.runId]);
    expect(accepted.map((s) => s.request.fastSeed?.mode)).toEqual(["on", "off", "off"]);
  });
});
