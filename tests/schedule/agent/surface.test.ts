/**
 * schedule-auto-approve r2: the surface no longer owns a confirm module — it registers exactly the two
 * status/digest hooks (`turn_start`, `agent_settled`), exposes no `confirm()`, and starts / stops the
 * status bar + digest per session.
 */
import { afterEach, describe, expect, it } from "vitest";
import { wireScheduleSurface } from "../../../src/schedule/agent/surface.js";
import { a3Env, type A3Env } from "./a3-helpers.js";

let env: A3Env;
afterEach(() => env?.cleanup());

function fakePi() {
  const handlers = new Map<string, Array<(e: any, c?: any) => unknown>>();
  return {
    pi: {
      on: (ev: string, fn: (e: any) => unknown) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
      sendMessage: () => undefined,
    } as never,
    handlers,
    fire: (ev: string, payload: any = {}) => (handlers.get(ev) ?? []).map((fn) => fn(payload)),
  };
}

function setup(mode: "interactive" | "print" = "interactive") {
  env = a3Env({}, mode === "print" ? "print" : undefined);
  const pi = fakePi();
  const surface = wireScheduleSurface(pi.pi, {
    settings: { defaultTimeoutMs: 1_800_000, maxTimeoutMs: 14_400_000 },
    types: { get: () => undefined, list: () => [] } as never,
    current: () => env.agent,
  });
  const statuses: Array<string | undefined> = [];
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    ui: { setStatus: (_k: string, t: string | undefined) => void statuses.push(t), notify: () => undefined },
    isIdle: () => true,
    sessionManager: { getSessionFile: () => undefined },
  };
  return { pi, surface, ctx, statuses };
}

describe("schedule surface (no confirm)", () => {
  it("registers only turn_start + agent_settled — none of the retired #61 confirm hooks", () => {
    const s = setup();
    expect([...s.pi.handlers.keys()].sort()).toEqual(["agent_settled", "turn_start"]);
    expect(s.surface).not.toHaveProperty("confirm");
  });

  it("start() on an interactive session runs the opening digest without throwing; both hooks are safe before/after shutdown", async () => {
    const s = setup();
    await s.surface.start(s.ctx, env.agent);
    expect(() => s.pi.fire("turn_start")).not.toThrow();
    expect(() => s.pi.fire("agent_settled")).not.toThrow();
    s.surface.shutdown();
    expect(() => s.pi.fire("agent_settled")).not.toThrow();
  });

  it("a non-interactive agent starts nothing (no status writes)", async () => {
    const s = setup("print");
    await s.surface.start(s.ctx, env.agent);
    s.pi.fire("turn_start");
    expect(s.statuses).toEqual([]);
  });

  it("start(undefined) is a no-op", async () => {
    const s = setup();
    await s.surface.start(s.ctx, undefined);
    expect(s.statuses).toEqual([]);
  });
});
