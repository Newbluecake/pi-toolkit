import { afterEach, describe, expect, it, vi } from "vitest";
import { createHumanGrantPort, type InvocationRef } from "../../src/fabric/xs/human-grant.js";
import { createHumanRuntime } from "../../src/runtime/human-runtime.js";
import type { XsSender } from "../../src/fabric/xs/sender.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const grants = createHumanGrantPort();
  const ref = grants.issue({
    inputId: "human-input",
    sessionId: "session",
    owner: "root",
    via: "rpc",
    issuedAt: Date.now(),
  })!;
  grants.bindContext(ref, "root-run", 1);
  const parent: InvocationRef = {
    sessionId: "session",
    owner: "root",
    runKey: "root-run",
    contextSeq: 1,
    toolCallId: "Agent-call",
    toolName: "Agent",
  };
  grants.registerInvocation(parent);
  const runtime = createHumanRuntime({
    grants,
    rootOwner: "root",
    source: () => ({ sessionId: "session", epoch: 1 }),
    sender: () => ({}) as XsSender,
    runLevel: () => 1,
    reply: true,
    alias: false,
  });
  return { grants, ref, parent, runtime };
}
describe("P2c owner CAS / bounded admission", () => {
  it("real edge without exact result waits once, has unref timer, and fails closed at 1s", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.grants.observeSpawnEdge("session", "root", "child");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const opening = h.runtime.prepare("child");
    expect(vi.getTimerCount()).toBe(1);
    expect(timeout.mock.results[0]!.value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await opening).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("unsigned / mismatched edge never waits or manufactures authorization", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.grants.observeSpawnEdge("session", "other-parent", "child");
    expect(await h.runtime.prepare("child")).toBeUndefined();
    expect(await h.runtime.prepare("invented-runId")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("precise result wakes the pending child; duplicate driver cannot take its owner", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.grants.observeSpawnEdge("session", "root", "child");
    const opening = h.runtime.prepare("child");
    h.grants.linkInvocation(h.parent, "child");
    h.runtime.childLinked("child");
    const binding = await opening;
    expect(binding).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    const duplicate = h.runtime.prepare("child");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await duplicate).toBeUndefined();
    binding!.dispose();
    expect(await h.runtime.prepare("child")).toBeUndefined();
  });
  it("detach clears active bindings and pending waits synchronously on shutdown/reload", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.grants.observeSpawnEdge("session", "root", "active");
    h.grants.linkInvocation(h.parent, "active");
    const binding = await h.runtime.prepare("active");
    expect(binding).toBeDefined();
    h.grants.observeSpawnEdge("session", "root", "pending");
    const waiting = h.runtime.prepare("pending");
    expect(vi.getTimerCount()).toBe(1);
    h.runtime.detach();
    expect(vi.getTimerCount()).toBe(0);
    expect(await waiting).toBeUndefined();
    expect(h.grants.openChild("session", "root", "active", "new-owner")).toBeUndefined();
    binding!.dispose(); // idempotent after façade detach
  });
  it("a waiting child cannot overflow capacity filled while its precise parent result was pending", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.grants.observeSpawnEdge("session", "root", "waiting");
    const waiting = h.runtime.prepare("waiting");
    const next = h.grants.issue({
      inputId: "next-input",
      sessionId: "session",
      owner: "root",
      via: "rpc",
      issuedAt: Date.now(),
    })!;
    h.grants.bindContext(next, "root-run", 2);
    const parent = { ...h.parent, contextSeq: 2, toolCallId: "next-Agent" };
    h.grants.registerInvocation(parent);
    for (let n = 0; n < 64; n++) {
      const runId = `ready-${n}`;
      h.grants.observeSpawnEdge("session", "root", runId);
      h.grants.linkInvocation(parent, runId);
      expect(await h.runtime.prepare(runId)).toBeDefined();
    }
    h.grants.linkInvocation(h.parent, "waiting");
    h.runtime.childLinked("waiting");
    expect(await waiting).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    h.runtime.detach();
  });
  it("child context needs the same root owner AND exclusively acquired driver owner", () => {
    const h = setup();
    h.grants.observeSpawnEdge("session", "root", "child");
    h.grants.linkInvocation(h.parent, "child");
    expect(h.grants.openChild("session", "reload-owner", "child", "driver")).toBeUndefined();
    expect(h.grants.openChild("session", "root", "child", "driver")).toEqual(h.ref);
    expect(h.grants.openChild("session", "root", "child", "other-driver")).toBeUndefined();
    expect(h.grants.bindChildContext(h.ref, "child", "other-driver", 1)).toBe(false);
    expect(h.grants.bindChildContext(h.ref, "child", "driver", 1)).toBe(true);
    const child = { ...h.parent, runKey: "child", owner: "driver", toolCallId: "send", toolName: "message_session" };
    h.grants.registerInvocation(child);
    expect(h.grants.resolve(child)).toEqual(h.ref);
    expect(h.grants.resolve({ ...child, owner: "root" })).toBeUndefined();
    expect(h.grants.resolve({ ...child, contextSeq: 2 })).toBeUndefined();
    h.grants.endRun("session", "child");
    expect(h.grants.resolve(child)).toBeUndefined();
    expect(h.grants.openChild("session", "root", "child", "driver")).toBeUndefined();
  });
  it("parent end preserves live nested descendants, not historical parent calls", () => {
    const h = setup();
    h.grants.observeSpawnEdge("session", "root", "child");
    h.grants.linkInvocation(h.parent, "child");
    h.grants.openChild("session", "root", "child", "driver");
    h.grants.bindChildContext(h.ref, "child", "driver", 1);
    const child = { ...h.parent, runKey: "child", owner: "driver", toolCallId: "nested-Agent" };
    h.grants.registerInvocation(child);
    h.grants.observeSpawnEdge("session", "child", "nested");
    h.grants.linkInvocation(child, "nested");
    h.grants.endRun("session", "root-run");
    h.grants.endRun("session", "child");
    expect(h.grants.resolve(h.parent)).toBeUndefined();
    expect(h.grants.resolve(child)).toBeUndefined();
    expect(h.grants.openChild("session", "root", "nested", "nested-driver")).toEqual(h.ref);
    h.grants.revokeSession("session");
    expect(h.grants.openChild("session", "root", "nested", "nested-driver")).toBeUndefined();
  });
});
