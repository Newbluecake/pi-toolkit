/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex R0: the closed skeleton of `wireReflex` — exactly six registrations in a frozen order,
 * zero registrations outside the plain domain, an inert fail-open sync input handler, and the PD11
 * re-arm protocol (generation / disposed) that later packages build on.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REFLEX_SETTINGS } from "../../src/reflex/core/settings.js";
import { wireReflex, type ReflexWireDeps } from "../../src/reflex/wire.js";

interface Rec {
  pi: ExtensionAPI;
  calls: string[];
  handlers: Map<string, Array<(e: any, c: any) => any>>;
  commands: Map<string, any>;
  renderers: Map<string, unknown>;
}

function recPi(opts: { renderer?: boolean } = {}): Rec {
  const calls: string[] = [];
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, unknown>();
  const pi: Record<string, unknown> = {
    on(event: string, handler: (e: any, c: any) => any) {
      calls.push(`on(${event})`);
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, cmd: unknown) {
      calls.push(`registerCommand(${name})`);
      commands.set(name, cmd);
    },
    sendMessage: () => calls.push("sendMessage"),
    sendUserMessage: () => calls.push("sendUserMessage"),
    appendEntry: () => calls.push("appendEntry"),
  };
  if (opts.renderer !== false)
    pi.registerMessageRenderer = (customType: string, r: unknown) => {
      calls.push(`registerMessageRenderer(${customType})`);
      renderers.set(customType, r);
    };
  return { pi: pi as unknown as ExtensionAPI, calls, handlers, commands, renderers };
}

const deps = (kind: ReflexWireDeps["secureDomainKind"] = "plain"): ReflexWireDeps => ({
  settings: () => ({ ...DEFAULT_REFLEX_SETTINGS, enabled: true }),
  secureDomainKind: kind,
  ports: {
    bashJobs: () => undefined,
    fleet: () => undefined,
    quota: () => undefined,
    git: (async () => ({}) as never) as never,
  },
  fences: { topicSwitchActive: () => false, goalBusy: () => false },
});

const ctx = {} as any;

describe("wireReflex skeleton", () => {
  it("plain domain ⇒ exactly the six registrations, in the frozen order", () => {
    const r = recPi();
    const wiring = wireReflex(r.pi, deps());
    expect(wiring).toBeDefined();
    expect(r.calls).toEqual([
      "on(input)",
      "on(agent_settled)",
      "on(session_start)",
      "on(session_shutdown)",
      "registerMessageRenderer(subagent:reflex)",
      "registerCommand(reflex)",
    ]);
  });

  it("skips the renderer when the host has no registerMessageRenderer (other five unchanged)", () => {
    const r = recPi({ renderer: false });
    wireReflex(r.pi, deps());
    expect(r.calls).toEqual([
      "on(input)",
      "on(agent_settled)",
      "on(session_start)",
      "on(session_shutdown)",
      "registerCommand(reflex)",
    ]);
  });

  it.each(["secure", "locked"] as const)("secureDomainKind=%s ⇒ undefined and zero registrations", (kind) => {
    const r = recPi();
    expect(wireReflex(r.pi, deps(kind))).toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it("input handler: always `continue`, returns a non-thenable, never touches send/append APIs", () => {
    const r = recPi();
    wireReflex(r.pi, deps());
    const input = r.handlers.get("input")![0]!;
    for (const text of ["后台还有几个 job", "/reflex", "", "x".repeat(500)]) {
      const out = input({ type: "input", text, source: "interactive" }, ctx);
      expect(out).toEqual({ action: "continue" });
      expect(typeof (out as { then?: unknown }).then).not.toBe("function");
    }
    // malformed events are tolerated too (fail-open)
    expect(input(undefined, undefined)).toEqual({ action: "continue" });
    expect(r.calls.filter((c) => /send|append/i.test(c))).toEqual([]);
  });

  it("the command skeleton confirms it is armed and never throws without a UI", async () => {
    const r = recPi();
    wireReflex(r.pi, deps());
    const messages: string[] = [];
    await r.commands.get("reflex").handler("", { ui: { notify: (m: string) => messages.push(m) } });
    expect(messages).toEqual(["reflex: enabled (skeleton)"]);
    await expect(r.commands.get("reflex").handler("", {})).resolves.toBeUndefined();
  });

  it("PD11 re-arm: shutdown bumps generation and marks disposed; session_start re-arms the same closure", () => {
    const r = recPi();
    const wiring = wireReflex(r.pi, deps())!;
    const input = r.handlers.get("input")![0]!;
    const fire = (event: string) => r.handlers.get(event)!.forEach((h) => h({ type: event }, ctx));

    fire("session_start");
    const g0 = wiring.generation();
    expect(wiring.snapshot()).toMatchObject({ disposed: false, inFlight: false, generation: g0 });
    expect(wiring.isStale(g0)).toBe(false);

    fire("session_shutdown");
    expect(wiring.snapshot().disposed).toBe(true);
    expect(wiring.generation()).toBe(g0 + 1);
    expect(wiring.isStale(g0)).toBe(true);
    // synchronous entries do NOT early-return on disposed: the handler still serves
    expect(input({ type: "input", text: "hi", source: "interactive" }, ctx)).toEqual({ action: "continue" });

    fire("session_start");
    const g1 = wiring.generation();
    expect(g1).toBe(g0 + 1);
    expect(wiring.snapshot().disposed).toBe(false);
    expect(wiring.isStale(g0)).toBe(true); // an old async continuation stays stale
    expect(wiring.isStale(g1)).toBe(false);
    expect(input({ type: "input", text: "hi", source: "interactive" }, ctx)).toEqual({ action: "continue" });
  });

  it("repeated shutdown→start cycles accumulate nothing but the generation counter", () => {
    const r = recPi();
    const wiring = wireReflex(r.pi, deps())!;
    const fire = (event: string) => r.handlers.get(event)!.forEach((h) => h({ type: event }, ctx));
    for (let i = 0; i < 5; i++) {
      fire("session_start");
      fire("session_shutdown");
    }
    fire("session_start");
    expect(wiring.generation()).toBe(5);
    expect(wiring.snapshot()).toMatchObject({ disposed: false, inFlight: false, counters: {}, scripts: [] });
    expect(r.calls.filter((c) => c.startsWith("on(")).length).toBe(4); // no re-registration
    expect(wiring.isStale(5)).toBe(false);
    expect(wiring.isStale(4)).toBe(true);
  });

  it("each activation has isolated closure state (no module-scope state, R-I8)", () => {
    const a = recPi();
    const b = recPi();
    const wa = wireReflex(a.pi, deps())!;
    const wb = wireReflex(b.pi, deps())!;
    a.handlers.get("session_shutdown")!.forEach((h) => h({}, ctx));
    expect(wa.generation()).toBe(1);
    expect(wb.generation()).toBe(0);
    expect(wb.snapshot().disposed).toBe(false);
  });
});
