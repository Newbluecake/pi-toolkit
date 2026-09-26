import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { resetChildSwitchCapabilityForTests } from "../../src/context-switch/capability.js";

/**
 * child-context-switch plan.md §7 P3 — T-S6 / T-Z1 (registration wiring only; the real
 * turn_end/context/agent_end behavior is covered by tests/context-switch/child.test.ts and
 * tests/integration/child-switch-runner.test.ts).
 *
 * Mirrors merged-plugins-wiring.test.ts's fakePi()/HOST_KEY convention: runs against a throwaway
 * $HOME, pre-claims HOST_KEY to activate() as a child session.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-child-switch-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, unknown>();
  const appended: { customType: string; data: unknown }[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    getActiveTools: () => [...tools.keys()],
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, tools, appended };
}

function writeSettings(raw: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  rmSync(settingsPath, { force: true });
  resetChildSwitchCapabilityForTests();
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  rmSync(settingsPath, { force: true });
  resetChildSwitchCapabilityForTests();
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

/** Events genuinely new for a child session (nothing pre-guard registers them today) — valid for
 *  an absolute presence/absence check. `agent_end` is deliberately excluded here: BOTH sub-
 *  features (context-switch AND keepalive) register it, so disabling only one leaves it present. */
const CHILD_SWITCH_NEW_EVENTS = ["context"];
const CHILD_KEEPALIVE_NEW_EVENTS = [
  "before_provider_request",
  "before_provider_headers",
  "message_end",
  "thinking_level_select",
  "session_compact_failed",
];
/** Events this package shares with other pre-guard registrants (todo / the sysprompt hub) — T-Z1
 *  must be checked by comparing the HANDLER COUNT with the feature on vs. off, not by presence. */
/** Events this package shares with other pre-guard registrants (todo / the sysprompt hub) — T-Z1
 *  must be checked by comparing the HANDLER COUNT with the feature on vs. off, not by presence.
 *  Value = how many of THIS package's two sub-features (context-switch, keepalive) register this
 *  exact event name (turn_end and session_compact are registered by BOTH). */
const SHARED_EVENT_DELTAS: Record<string, number> = {
  turn_end: 2,
  tool_execution_start: 1,
  tool_execution_end: 1,
  session_compact: 2,
  model_select: 1,
  agent_settled: 1,
};

function activateAsChild(): ReturnType<typeof fakePi> {
  (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
  const h = fakePi();
  activate(h.pi);
  return h;
}

describe("child-context-switch wiring (T-S6): both features default on", () => {
  it("registers the boundary-mode switch_context tool and the turn_end/context/agent_end handlers", () => {
    const { tools, handlers } = activateAsChild();
    expect(tools.has("switch_context")).toBe(true);
    expect(tools.has("compact_context")).toBe(false);
    expect(handlers.get("session_before_compact")).toBeUndefined();
    for (const event of [...CHILD_SWITCH_NEW_EVENTS, "turn_end", "agent_end"]) {
      expect(handlers.has(event), `expected ${event} to be registered`).toBe(true);
    }
  });

  it("registers the child keepalive event set", () => {
    const { handlers } = activateAsChild();
    for (const event of [
      ...CHILD_KEEPALIVE_NEW_EVENTS,
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
      "agent_end",
    ]) {
      expect(handlers.has(event), `expected ${event} to be registered`).toBe(true);
    }
  });
});

describe("child-context-switch wiring (T-Z1): both switches off ⇒ zero new registration/audit/network", () => {
  it("compact.childSessions=false ⇒ no switch_context tool, no new turn_end/context/agent_end handler", () => {
    const on = activateAsChild();
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    writeSettings({ compact: { childSessions: false }, cacheTtl: { childKeepalive: false } });
    const off = activateAsChild();

    expect(off.tools.has("switch_context")).toBe(false);
    for (const event of [...CHILD_SWITCH_NEW_EVENTS, ...CHILD_KEEPALIVE_NEW_EVENTS, "agent_end"]) {
      expect(off.handlers.has(event), `expected ${event} NOT to be registered`).toBe(false);
    }
    for (const [event, delta] of Object.entries(SHARED_EVENT_DELTAS)) {
      expect(
        (off.handlers.get(event) ?? []).length,
        `expected ${event}'s handler count to be unaffected by the child switch/keepalive feature`,
      ).toBe((on.handlers.get(event) ?? []).length - delta);
    }
    expect(off.appended.some((entry) => entry.customType.startsWith("subagent:"))).toBe(false);
  });

  it("compact.enabled=false alone also disables the child switch surface", () => {
    writeSettings({ compact: { enabled: false } });
    const { tools, handlers } = activateAsChild();
    expect(tools.has("switch_context")).toBe(false);
    for (const event of CHILD_SWITCH_NEW_EVENTS) expect(handlers.has(event)).toBe(false);
  });

  it("compact.switchTool=false alone also disables the child switch surface", () => {
    writeSettings({ compact: { switchTool: false } });
    const { tools, handlers } = activateAsChild();
    expect(tools.has("switch_context")).toBe(false);
    for (const event of CHILD_SWITCH_NEW_EVENTS) expect(handlers.has(event)).toBe(false);
  });

  it("cacheTtl.keepalive=false alone also disables the child keepalive surface", () => {
    writeSettings({ cacheTtl: { keepalive: false } });
    const { handlers } = activateAsChild();
    for (const event of CHILD_KEEPALIVE_NEW_EVENTS) expect(handlers.has(event)).toBe(false);
    // switch_context is unaffected by the keepalive switch.
    expect(handlers.has("context")).toBe(true);
  });
});
