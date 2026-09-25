// web-hub plan §包 I + §6 + §9 #7: default-OFF zero side effects.
//
// Baseline-comparison method (评审修订 #7): instead of counting handlers
// against a hardcoded list, run activate() twice —
//   ① baseline: `wireWebHub` mocked to a no-op spy (settings enable webHub, so
//     the call path itself is exercised but registers nothing);
//   ② real module with DEFAULT settings (webHub.enabled=false).
// For every pi event type, the multiset of handler sources (`fn.toString()`)
// must be IDENTICAL between ② and ① (both diff directions empty), the spy
// stays uncalled, no `webhub` command exists, `$HOME/.pi/agent/web-hub` is
// never created and `net.connect` is never invoked. A third run with
// enabled=true against the REAL wireWebHub must then show a non-empty diff
// landing exclusively on package D's event types — proving the comparison
// can actually detect wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { FORWARDED_EVENTS } from "../../src/web-hub/protocol/messages.js";
import { webHubStateDir } from "../../src/web-hub/protocol/paths.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const wireMock = vi.hoisted(() => ({
  calls: 0,
  passthrough: false,
  real: undefined as ((...args: never[]) => unknown) | undefined,
}));

vi.mock("../../src/web-hub/agent/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/web-hub/agent/index.js")>();
  wireMock.real = orig.wireWebHub as (...args: never[]) => unknown;
  return {
    ...orig,
    wireWebHub: (...args: never[]) => {
      wireMock.calls += 1;
      if (wireMock.passthrough) return wireMock.real!(...args);
      return { status: () => ({ state: "off", attached: false }), url: () => ({ hint: "mocked" }) };
    },
  };
});

const netMock = vi.hoisted(() => ({ connects: 0 }));

vi.mock("node:net", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:net")>();
  return {
    ...orig,
    connect: (...args: Parameters<typeof orig.connect>) => {
      netMock.connects += 1;
      return orig.connect(...args);
    },
  };
});

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");

function releaseGuards(): void {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, unknown>();
  const pi = {
    registerTool() {},
    registerCommand(name: string, cmd: unknown) {
      commands.set(name, cmd);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, emit };
}

/** Sorted multiset of handler sources per event type. */
function handlerMultisets(handlers: Map<string, Handler[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [event, list] of handlers) out.set(event, list.map((f) => f.toString()).sort());
  return out;
}

/** All event types where the two snapshots differ (either direction). */
function diffEventTypes(a: Map<string, string[]>, b: Map<string, string[]>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => {
    const x = a.get(k) ?? [];
    const y = b.get(k) ?? [];
    return x.length !== y.length || x.some((v, i) => v !== y[i]);
  });
}

describe("web-hub disabled ⇒ zero side effects (plan §6, §9 #7)", () => {
  let home: ReturnType<typeof sandboxHome>;
  beforeEach(() => {
    home = sandboxHome();
    releaseGuards();
    wireMock.calls = 0;
    wireMock.passthrough = false;
    netMock.connects = 0;
  });
  afterEach(() => {
    releaseGuards();
    home.restore();
    rmSync(home.home, { recursive: true, force: true });
  });

  function writeSettings(raw: unknown): void {
    const path = join(home.home, ".pi", "agent", "pi-subagent.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw) + "\n", "utf8");
  }

  const sessionCtx = () => ({ modelRegistry: { getAvailable: () => [], find: () => undefined } });

  it("default settings ≡ no-op wireWebHub baseline: identical handler multisets, zero net, zero disk", async () => {
    // ① baseline: webHub "enabled" but wireWebHub is a no-op spy.
    writeSettings({ webHub: { enabled: true, autoStart: false } });
    const baseline = fakePi();
    activate(baseline.pi);
    await baseline.emit("session_start", {}, sessionCtx());
    expect(wireMock.calls).toBe(1); // the call path itself is real; only the body is mocked away
    const baselineHandlers = handlerMultisets(baseline.handlers);
    // Release every module-level host guard the honest way (feishu-notify et
    // al. keep their own Symbol.for claims across activations) so the second
    // activate registers the full surface again.
    await baseline.emit("session_shutdown", { reason: "quit" });
    releaseGuards();

    // ② real module, default settings (webHub.enabled=false).
    wireMock.calls = 0;
    wireMock.passthrough = true; // even if called, delegate to the real wiring
    rmSync(join(home.home, ".pi", "agent", "pi-subagent.json"), { force: true });
    writeSettings({});
    const real = fakePi();
    activate(real.pi);
    await real.emit("session_start", {}, sessionCtx());
    const realHandlers = handlerMultisets(real.handlers);

    // Per-event-type multiset equality ⇒ both diff directions empty.
    expect(diffEventTypes(realHandlers, baselineHandlers)).toEqual([]);
    expect(wireMock.calls).toBe(0); // wireWebHub never invoked when disabled
    expect(real.commands.has("webhub")).toBe(false);
    expect(existsSync(webHubStateDir(home.home))).toBe(false);
    expect(netMock.connects).toBe(0);

    await real.emit("session_shutdown", { reason: "quit" });
  });

  it("control: enabled=true with the REAL wireWebHub changes exactly package D's event types", async () => {
    // Baseline again (no-op).
    writeSettings({ webHub: { enabled: true, autoStart: false } });
    const baseline = fakePi();
    activate(baseline.pi);
    const baselineHandlers = handlerMultisets(baseline.handlers);
    expect(wireMock.calls).toBe(1);
    await baseline.emit("session_shutdown", { reason: "quit" });
    releaseGuards();

    // Enabled + real wiring (registration only; no session_start ⇒ no socket).
    wireMock.passthrough = true;
    const enabled = fakePi();
    activate(enabled.pi);
    expect(wireMock.calls).toBe(2);
    const enabledHandlers = handlerMultisets(enabled.handlers);

    const changed = diffEventTypes(enabledHandlers, baselineHandlers);
    const expected = new Set(["session_start", "session_shutdown", ...FORWARDED_EVENTS]);
    expect(changed.length).toBeGreaterThan(0);
    for (const event of changed) expect(expected.has(event), `unexpected diff on ${event}`).toBe(true);
    // D registers one handler on every forwarded event type.
    for (const event of FORWARDED_EVENTS) expect(changed, `missing handler on ${event}`).toContain(event);
    expect(enabled.commands.has("webhub")).toBe(true);
    expect(netMock.connects).toBe(0);
    expect(existsSync(webHubStateDir(home.home))).toBe(false);
  });
});
