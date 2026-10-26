/**
 * #61 C1: the surface builds one confirm per interactive session start, forwards the pi events the
 * presenter needs, hands the model notice to `pi.sendMessage(triggerTurn:false)` and tears it down.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireScheduleSurface } from "../../../src/schedule/agent/surface.js";
import { createTask } from "../../../src/schedule/agent/ops.js";
import { SCHED_CUSTOM_TYPE } from "../../../src/schedule/core/spec.js";
import { a3Env, basicRaw, type A3Env } from "./a3-helpers.js";

let env: A3Env;
afterEach(() => env?.cleanup());

function fakePi() {
  const handlers = new Map<string, Array<(e: any, c?: any) => unknown>>();
  const sent: Array<{ message: any; options: any }> = [];
  return {
    pi: {
      on: (ev: string, fn: (e: any) => unknown) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
      sendMessage: (message: any, options: any) => void sent.push({ message, options }),
    } as never,
    sent,
    fire: (ev: string, payload: any = {}) => (handlers.get(ev) ?? []).map((fn) => fn(payload)),
  };
}

function setup(over: { hasUI?: boolean; mode?: string } = {}) {
  env = a3Env();
  const pi = fakePi();
  const surface = wireScheduleSurface(pi.pi, {
    settings: { defaultTimeoutMs: 1_800_000, maxTimeoutMs: 14_400_000 },
    types: { get: () => undefined, list: () => [] } as never,
    current: () => env.agent,
  });
  const selects: Array<{ title: string; argc: number }> = [];
  const frames: any[] = [];
  // the C2 coordinator members, read structurally by the surface
  Object.defineProperty(env.agent, "coordinator", {
    value: { kind: "hub", changed() {}, bound() {}, offers: (f: any) => frames.push(f), confirmReady: () => false },
    configurable: true,
  });
  const ctx: any = {
    hasUI: over.hasUI ?? true,
    mode: over.mode ?? "tui",
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      select: (...a: unknown[]) => {
        selects.push({ title: a[0] as string, argc: a.length });
        return new Promise(() => undefined);
      },
    },
    isIdle: () => true,
    sessionManager: { getSessionFile: () => undefined },
  };
  return { pi, surface, ctx, selects, frames };
}

describe("schedule surface × confirm", () => {
  it("start() builds a confirm for an interactive session; it opens the select with 2 args, publishes through the coordinator, and shutdown withdraws", async () => {
    const s = setup();
    expect(s.surface.confirm()).toBeUndefined();
    await s.surface.start(s.ctx, env.agent);
    const confirm = s.surface.confirm()!;
    expect(confirm).toBeDefined();
    const created = await createTask(env.ports, basicRaw() as never, { by: "agent", via: "tool" });
    if (!created.ok) throw new Error(created.detail);
    expect(confirm.offer(created.value, { kind: "create" })).toBe("offered");
    expect(s.selects).toHaveLength(1);
    expect(s.selects[0]!.argc).toBe(2);
    expect(s.frames.at(-1)).toMatchObject({ sessionId: env.agent.sessionId, open: [{ taskId: created.value.id }] });
    s.surface.shutdown();
    expect(s.surface.confirm()).toBeUndefined();
    expect(s.frames.at(-1)).toMatchObject({ open: [], closed: [{ taskId: created.value.id, outcome: "withdrawn" }] });
  });

  it("a non-interactive agent gets no confirm; a restart replaces (and disposes) the previous one", async () => {
    const s = setup();
    await s.surface.start(s.ctx, undefined);
    expect(s.surface.confirm()).toBeUndefined();
    await s.surface.start(s.ctx, env.agent);
    const first = s.surface.confirm()!;
    const spy = vi.spyOn(first, "dispose");
    await s.surface.start(s.ctx, env.agent);
    expect(spy).toHaveBeenCalled();
    expect(s.surface.confirm()).not.toBe(first);
  });

  it("without hasUI and without a hub channel nobody can be asked (offer ⇒ unavailable)", async () => {
    const s = setup({ hasUI: false });
    await s.surface.start(s.ctx, env.agent);
    const created = await createTask(env.ports, basicRaw() as never, { by: "agent", via: "tool" });
    if (!created.ok) throw new Error(created.detail);
    expect(s.surface.confirm()!.offer(created.value, { kind: "create" })).toBe("unavailable");
    expect(s.selects).toHaveLength(0);
  });

  it("the decision notice reaches pi.sendMessage as a quiet schedule message (triggerTurn:false, kind confirm)", async () => {
    const s = setup();
    await s.surface.start(s.ctx, env.agent);
    const confirm = s.surface.confirm()!;
    const created = await createTask(env.ports, basicRaw() as never, { by: "agent", via: "tool" });
    if (!created.ok) throw new Error(created.detail);
    confirm.offer(created.value, { kind: "create" });
    const live = confirm.liveOffer(created.value.id)!;
    await confirm.decide({
      taskId: created.value.id,
      defHash: live.defHash,
      decision: "reject",
      via: "feishu",
      offerId: live.offerId,
    });
    expect(s.pi.sent).toHaveLength(1);
    const m = s.pi.sent[0]!;
    expect(m.options).toEqual({ triggerTurn: false });
    expect(m.message).toMatchObject({
      customType: SCHED_CUSTOM_TYPE,
      display: true,
      details: { kind: "confirm", taskId: created.value.id, outcome: "rejected", by: "feishu" },
    });
    expect(m.message.content).toContain("已删除");
  });

  it("forwards input / turn / ui-prompt events to the CURRENT confirm; extension-sourced input is ignored; nothing forwards after shutdown", async () => {
    const s = setup();
    await s.surface.start(s.ctx, env.agent);
    const confirm = s.surface.confirm()!;
    const spies = {
      input: vi.spyOn(confirm, "onInput"),
      start: vi.spyOn(confirm, "onBeforeAgentStart"),
      settled: vi.spyOn(confirm, "onAgentSettled"),
      prompt: vi.spyOn(confirm, "onUiPrompt"),
    };
    expect(s.pi.fire("input", { source: "interactive", text: "hi" })).toEqual([{ action: "continue" }]);
    expect(s.pi.fire("input", { source: "extension", text: "x" })).toEqual([{ action: "continue" }]);
    expect(spies.input).toHaveBeenCalledTimes(1);
    s.pi.fire("before_agent_start");
    s.pi.fire("agent_settled");
    s.pi.fire("ui_prompt_start", { kind: "confirm", title: "T" });
    s.pi.fire("ui_prompt_end", { kind: "confirm", title: "T" });
    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(spies.settled).toHaveBeenCalledTimes(1);
    expect(spies.prompt.mock.calls).toEqual([
      [true, { kind: "confirm", title: "T" }],
      [false, { kind: "confirm", title: "T" }],
    ]);
    s.surface.shutdown();
    s.pi.fire("input", { source: "interactive" });
    s.pi.fire("agent_settled");
    expect(spies.input).toHaveBeenCalledTimes(1);
    expect(spies.settled).toHaveBeenCalledTimes(1);
  });
});
