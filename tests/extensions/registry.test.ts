import { describe, expect, it, vi } from "vitest";
import { mergeExtensionPoints } from "../../src/extensions/registry.js";
import type { DeliveryPayload, LifecycleEvent, RunOutcome, SubagentExtensionPoints } from "../../src/core/types.js";

const lifecycleEvent: LifecycleEvent = { runId: "r", generation: 1, status: "completed", at: 0 };
const outcome: RunOutcome = {
  runId: "r",
  status: "completed",
  turns: 0,
  durationMs: 0,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
};
const payload: DeliveryPayload = {
  key: "r:1:completed",
  runId: "r",
  generation: 1,
  status: "completed",
  textPreview: "",
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
};

describe("mergeExtensionPoints", () => {
  it("returns an extension-less object with no hooks defined when given an empty list", () => {
    const merged = mergeExtensionPoints([]);
    expect(merged.onLifecycle).toBeUndefined();
    expect(merged.resolveSessionSpec).toBeUndefined();
    expect(merged.beforeReap).toBeUndefined();
    expect(merged.onDelivery).toBeUndefined();
  });

  it("H1: fans out onLifecycle to every extension, isolating a throw from one so the rest still run", () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      onLifecycle: () => {
        calls.push("a");
        throw new Error("boom from a");
      },
    };
    const b: SubagentExtensionPoints = { onLifecycle: () => calls.push("b") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b]);
    expect(() => merged.onLifecycle?.(lifecycleEvent)).not.toThrow();
    expect(calls).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("H2: composes resolveSessionSpec in registration order, each extension seeing the previous one's output", () => {
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => ({ ...spec, cwd: `${spec.cwd ?? ""}/a` }),
    };
    const b: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => ({ ...spec, cwd: `${spec.cwd ?? ""}/b` }),
    };
    const merged = mergeExtensionPoints([a, b]);
    return Promise.resolve(merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" })).then((spec) => {
      expect(spec?.cwd).toBe("/a/b");
    });
  });

  it("H2: does NOT swallow a thrown/rejected resolveSessionSpec — the caller must see the failure", async () => {
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad worktree config");
      },
    };
    const merged = mergeExtensionPoints([a]);
    await expect(Promise.resolve(merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" }))).rejects.toThrow(
      "bad worktree config",
    );
  });

  it("D12: threads ctx through to every extension unchanged (old extensions ignoring the 3rd param keep working)", async () => {
    const seen: Array<{ signal: AbortSignal | undefined }> = [];
    const controller = new AbortController();
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: (spec, _req, ctx) => {
        seen.push({ signal: ctx?.signal });
        return spec;
      },
    };
    // old-style extension: no 3rd param declared at all
    const b: SubagentExtensionPoints = { resolveSessionSpec: (spec) => spec };
    const merged = mergeExtensionPoints([a, b]);
    await merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" }, { signal: controller.signal });
    expect(seen).toEqual([{ signal: controller.signal }]);
  });

  it("D12: an already-aborted signal stops the chain BEFORE calling the next extension", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => {
        calls.push("a");
        return spec;
      },
    };
    const merged = mergeExtensionPoints([a]);
    await expect(
      Promise.resolve(merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" }, { signal: controller.signal })),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("D12: a signal that fires mid-chain (between two extensions) stops the SECOND one from ever starting", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => {
        calls.push("a");
        controller.abort();
        return spec;
      },
    };
    const b: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => {
        calls.push("b");
        return spec;
      },
    };
    const merged = mergeExtensionPoints([a, b]);
    await expect(
      Promise.resolve(merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" }, { signal: controller.signal })),
    ).rejects.toThrow();
    expect(calls).toEqual(["a"]);
  });

  it("D12: abandonSessionSpec fans out to every extension that declares it; one throwing does not block another", async () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      abandonSessionSpec: () => {
        calls.push("a");
        throw new Error("compensation failed");
      },
    };
    const b: SubagentExtensionPoints = { abandonSessionSpec: async () => calls.push("b") };
    // old extension without abandonSessionSpec at all
    const c: SubagentExtensionPoints = { onLifecycle: () => undefined };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b, c]);
    await expect(merged.abandonSessionSpec?.("r1", { reason: "startup_timeout" })).resolves.toBeUndefined();
    expect(calls).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("is undefined when no extension declares abandonSessionSpec", () => {
    const merged = mergeExtensionPoints([{ onLifecycle: () => undefined }]);
    expect(merged.abandonSessionSpec).toBeUndefined();
  });

  it("H3: runs beforeReap sequentially, catching a throw so remaining extensions and the caller still complete", async () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      beforeReap: async () => {
        calls.push("a");
        throw new Error("commit failed");
      },
    };
    const b: SubagentExtensionPoints = { beforeReap: async () => calls.push("b") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b]);
    await expect(merged.beforeReap?.(outcome, { cwd: "/tmp/x", deadlineMs: 5000 })).resolves.toBeUndefined();
    expect(calls).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("H4: fans out onDelivery to every extension, isolating a throw from one so the rest still run", () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      onDelivery: () => {
        calls.push("a");
        throw new Error("webhook down");
      },
    };
    const b: SubagentExtensionPoints = { onDelivery: () => calls.push("b") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b]);
    expect(() => merged.onDelivery?.(payload, "delivered")).not.toThrow();
    expect(calls).toEqual(["a", "b"]);
    warn.mockRestore();
  });
});
