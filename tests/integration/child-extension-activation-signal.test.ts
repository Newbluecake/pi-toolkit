import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { childActivationSnapshot } from "../../src/child/activation-signal.js";

/**
 * todo #27 (child-extension-missing diagnostic), end-to-end wiring slice: confirms
 * `src/index.ts`'s `isChildSession` branch actually calls `markChildExtensionActivated()`
 * UNCONDITIONALLY (no feature-setting gate) every time this package's `activate()` runs for a
 * child session — the one fact `PiSessionDriver.create()`/`resume()` (session-driver.ts)
 * depends on to detect a child session that never activates it at all (the `-e`/
 * `--no-extensions` scenario AGENTS.md documents). Mirrors
 * tests/integration/child-context-switch.test.ts's fakePi()/HOST_KEY convention: runs against a
 * throwaway $HOME, pre-claims HOST_KEY so `activate()` takes the child-session branch.
 *
 * What this test does NOT (and cannot cheaply) cover: the actual negative case — a REAL parent
 * process started with `-e` never re-importing this module for its children at all, so the
 * counter never advances and `computeChildExtensionMissing` (unit-tested directly in
 * tests/runtime/session-driver.test.ts) returns `true`. That absence-of-a-call is exactly what
 * this test proves does NOT happen on the normal (package properly installed) path — the
 * regression this guards against is "the isChildSession branch stops calling
 * markChildExtensionActivated()", which would make the detection permanently false-positive for
 * every properly-installed child session too.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-child-activation-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, unknown>();
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    appendEntry() {},
    getActiveTools: () => [...tools.keys()],
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI };
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("todo #27: src/index.ts's isChildSession branch marks the process-wide activation signal", () => {
  it("activate() as a child session advances the activation-signal counter", () => {
    const before = childActivationSnapshot();
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    activate(fakePi().pi);
    expect(childActivationSnapshot()).toBeGreaterThan(before);
  });

  it("activate() as the MAIN session (HOST_KEY not yet claimed) does NOT advance the counter", () => {
    const before = childActivationSnapshot();
    activate(fakePi().pi); // claims HOST_KEY itself — this IS the main-session activation
    expect(childActivationSnapshot()).toBe(before);
  });

  it("marks unconditionally regardless of any feature setting (no settings file written at all)", () => {
    // No writeSettings() call here on purpose: the default (no settings.json) config must
    // still mark the signal — this must never depend on bashJobs/compact/cacheTtl toggles.
    const before = childActivationSnapshot();
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    activate(fakePi().pi);
    expect(childActivationSnapshot()).toBeGreaterThan(before);
  });
});
