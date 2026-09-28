/**
 * Assembly-order guarantee (plan §4.1): web-hub's own `input` observer must be the LAST
 * pi-toolkit `input` handler registered by `src/index.ts`'s `activate()` — everything else
 * (currently `installMentionInput`) runs first, so a `@label` mention that gets `handled` never
 * reaches web-hub's observer (§4.3 step 2's "unobserved" fallback is the intended outcome there,
 * not a wiring accident).
 *
 * Method: activate() twice against fresh fake `pi`s — once with `webHub.enabled:false` (baseline,
 * every OTHER `input` handler still registers) and once with `webHub.enabled:true` — and diff the
 * `input` handler arrays by `toString()`. Exactly one handler must be added, and it must land at
 * the last index of the enabled run's array.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../../src/index.js";
import { sandboxHome } from "../../integration/helpers/home-sandbox.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");

function releaseGuards(): void {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    sendMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

let home: ReturnType<typeof sandboxHome>;
beforeEach(() => {
  home = sandboxHome();
  releaseGuards();
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

describe("web-hub's input observer registers last (plan §4.1)", () => {
  it("exactly one new 'input' handler appears when webHub.enabled flips on, at the tail of the array", () => {
    writeSettings({ webHub: { enabled: false } });
    const baseline = fakePi();
    activate(baseline.pi);
    const baselineInput = (baseline.handlers.get("input") ?? []).map((f) => f.toString());
    expect(baselineInput.length).toBeGreaterThan(0); // installMentionInput's own handler

    releaseGuards();
    writeSettings({ webHub: { enabled: true, autoStart: false } });
    const enabled = fakePi();
    activate(enabled.pi);
    const enabledInput = (enabled.handlers.get("input") ?? []).map((f) => f.toString());

    expect(enabledInput.length).toBe(baselineInput.length + 1);
    // Every baseline handler is still present, in the same relative order, before the new one.
    expect(enabledInput.slice(0, baselineInput.length)).toEqual(baselineInput);
    // The new (web-hub) handler is the last element, not spliced in earlier.
    expect(baselineInput).not.toContain(enabledInput.at(-1));
  });
});
