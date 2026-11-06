import { describe, expect, it, vi } from "vitest";
import { createFastController, createFastSessionPorts } from "../../src/fast/wire.js";
import type { FastMode } from "../../src/core/types.js";

const record = (mode: FastMode) => ({ type: "custom", customType: "subagent:fast", data: { v: 1, mode } });
function harness(initial: unknown[] = []) {
  let branch = initial;
  let live = true;
  const append = vi.fn((type: string, data: unknown) => {
    branch = [...branch, { type: "custom", customType: type, data }];
  });
  const notify = vi.fn();
  const status = vi.fn();
  const controller = createFastController({
    getBranch: () => branch,
    appendEntry: append,
    isCurrent: () => live,
    notify,
    setStatus: status,
  });
  return {
    controller,
    append,
    notify,
    status,
    branch: (next: unknown[]) => {
      branch = next;
    },
    expire: () => {
      live = false;
    },
  };
}
const body = () =>
  Object.freeze({
    model: "physical",
    input: [],
    store: false,
    stream: true,
    service_tier: "flex",
    reasoning: Object.freeze({ effort: "high" }),
  });
describe("Fast controller", () => {
  it("startup/inherit/status/usage/idempotence are zero writes and no initial footer", () => {
    const h = harness();
    expect(h.append).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    const poison = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw Error("touched");
        },
      },
    );
    expect(h.controller.rewrite(poison)).toBeUndefined();
    for (const cmd of ["status", "wut", "on off", "reset", "inherit"]) h.controller.command(cmd);
    expect(h.append).not.toHaveBeenCalled();
    expect(h.controller.snapshot()?.mode).toBe("inherit");
  });
  it("persists before mode apply, uses P1 parser and preserves delivered body after switch", () => {
    const h = harness();
    h.controller.command(" ON ");
    expect(h.append).toHaveBeenLastCalledWith("subagent:fast", { v: 1, mode: "on" });
    const original = body();
    const first = h.controller.rewrite(original) as Record<string, unknown>;
    expect(first.service_tier).toBe("priority");
    expect(first.reasoning).toBe(original.reasoning);
    h.controller.command("on");
    expect(h.append).toHaveBeenCalledTimes(1);
    h.controller.command("");
    expect(h.controller.snapshot()?.mode).toBe("off");
    expect((h.controller.rewrite(original) as Record<string, unknown>).service_tier).toBe("default");
    expect(first.service_tier).toBe("priority");
    expect(original.service_tier).toBe("flex");
    h.controller.command("reset");
    expect(h.controller.rewrite(original)).toBeUndefined();
    expect(h.notify.mock.calls.flat().join(" ")).toContain("premium");
  });
  it("append throws: last success persists, failed value is not inherited; notify failure is not storage failure", () => {
    const h = harness([record("off")]);
    h.append.mockImplementationOnce(() => {
      throw Error("private disk path");
    });
    h.controller.command("on");
    expect(h.controller.snapshot()?.mode).toBe("off");
    expect(h.controller.describe()).toContain("storage-fault");
    expect(h.controller.describe()).not.toContain("private disk path");
    h.notify.mockImplementation(() => {
      throw Error("closed ui");
    });
    h.controller.command("on");
    expect(h.controller.snapshot()?.mode).toBe("on");
    expect(h.controller.describe()).not.toContain("storage-fault");
  });
  it("last invalid/future masks on; explicit reset repairs it with a tombstone once", () => {
    const h = harness([record("on"), { type: "custom", customType: "subagent:fast", data: { v: 99, mode: "on" } }]);
    expect(h.controller.snapshot()?.mode).toBe("inherit");
    h.controller.command("status");
    expect(h.append).not.toHaveBeenCalled();
    h.controller.command("reset");
    h.controller.command("inherit");
    expect(h.append).toHaveBeenCalledTimes(1);
    expect(h.append).toHaveBeenCalledWith("subagent:fast", { v: 1, mode: "inherit" });
    expect(h.controller.describe()).not.toContain("invalid-record");
  });
  it("branch/fork/compaction reads current branch, closed and expired commands never append", () => {
    const h = harness([record("on")]);
    const s = h.controller.snapshot()!;
    h.branch([record("off")]);
    expect(h.controller.snapshot()?.mode).toBe("off");
    expect(h.controller.snapshot()?.revision).toBeGreaterThan(s.revision);
    expect(h.controller.snapshot()?.incarnation).toBe(s.incarnation);
    h.expire();
    h.controller.command("on");
    expect(h.append).not.toHaveBeenCalled();
    expect(h.controller.snapshot()).toBeUndefined();
    expect(h.controller.rewrite(body())).toBeUndefined();
  });
  it("suspended/unsupported notifications dedupe in bounded state, observations never correlate with requests", () => {
    const h = harness([record("on")]);
    h.controller.rewrite({ messages: [] });
    h.controller.rewrite({ messages: [] });
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.controller.rewrite({ model: "m", input: [], store: false, stream: true, unknown: true });
    expect(h.notify).toHaveBeenCalledTimes(2);
    h.controller.rewrite(body());
    h.controller.observe(
      { type: "response.completed", response: { service_tier: "default", secret: "not retained" } },
      "openai-responses",
    );
    expect(h.controller.describe()).toContain("at-hook=priority");
    expect(h.controller.describe()).toContain("latest observed=default");
    expect(h.controller.describe()).toContain("origin unknown");
    expect(h.controller.describe()).not.toContain("secret");
    h.controller.command("off");
    h.controller.observe({ type: "response.completed", response: { service_tier: "priority" } }, "openai-responses");
    expect(h.controller.describe()).toContain("requested=off");
    expect(h.controller.describe()).toContain("latest observed=priority");
    h.controller.dispose();
    h.controller.observe({ type: "response.completed", response: { service_tier: "default" } }, "openai-responses");
    expect(h.controller.snapshot()).toBeUndefined();
  });
  it("dispose clears an owned footer exactly once and never reopens its incarnation", () => {
    const h = harness([record("on")]);
    expect(h.status.mock.calls).toEqual([["Fast requested"]]);
    const incarnation = h.controller.snapshot()!.incarnation;
    h.controller.dispose();
    h.controller.dispose();
    expect(h.status.mock.calls).toEqual([["Fast requested"], [undefined]]);
    expect(h.controller.snapshot()).toBeUndefined();
    expect(harness([record("on")]).controller.snapshot()!.incarnation).not.toBe(incarnation);
  });

  it("concurrent roots, child ABA bindings, close and owner-bound workflow never read another root", () => {
    const a = harness([record("on")]);
    const b = harness([record("off")]);
    const pa = createFastSessionPorts(a.controller);
    const pb = createFastSessionPorts(b.controller);
    const o1 = { parentRunId: "child", incarnation: {} };
    const o2 = { parentRunId: "child", incarnation: {} };
    const clean1 = pa.childState.bind(o1, () => "off");
    expect(pa.parent.snapshot("child")).toEqual({ v: 1, mode: "off" });
    const clean2 = pa.childState.bind(o2, () => "inherit");
    clean1();
    expect(pa.parent.snapshot("child")).toEqual({ v: 1, mode: "inherit" });
    expect(pb.parent.snapshot("child")).toBeUndefined();
    expect(pa.parent.snapshot("unknown")).toBeUndefined();
    expect(pa.workflow.capture()).toEqual({ v: 1, mode: "on" });
    pa.dispose();
    clean2();
    expect(pa.workflow.capture()).toBeUndefined();
    expect(pa.parent.snapshot()).toBeUndefined();
    expect(pb.workflow.capture()).toEqual({ v: 1, mode: "off" });
  });
});
