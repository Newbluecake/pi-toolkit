// #32 C12 review P2① — 可复核的 "child session capture is always undefined" evidence.
//
// The verifier's preferred evidence (`pi install` into an isolated `$HOME` + a real main session
// dispatching real Agent-tool child sessions) is prohibitively heavy for a unit/integration suite;
// their own explicit fallback is a structural/executable assertion that `src/index.ts`'s `HOST_KEY`
// early-return (`if (g[HOST_KEY]) return;`) runs strictly BEFORE the web-hub wiring block (the only
// place `commandCaptureRef.current` is ever assigned) — which is exactly what makes a child
// subagent session's `wrapCommandApi` `getCapture()` return `undefined` forever, taking the C0 fast
// path for every command it re-registers.
//
// Method (baseline-comparison, same convention as `web-hub-disabled.test.ts` and
// `child-extension-activation-signal.test.ts`): mock `wireWebHub` to a counting spy, activate() once
// as the MAIN session (claims HOST_KEY itself) with `webHub.enabled: true` — the spy fires once,
// proving the settings really do reach the wiring call for a host activation. Then, WITHOUT
// releasing the HOST_KEY claim, activate() a SECOND TIME with a fresh fake `pi` — this is exactly
// what happens in-process for every real child subagent session (same `Symbol.for` global, same
// process, `src/runtime/session-driver.ts` re-imports and re-activates this module for every spawned
// child). The spy call count must NOT advance, `/webhub` must never be registered on the child's
// `pi`, and a real pre-guard toolkit command (`/tasklist`, registered before the HOST_KEY check runs
// for either activation) must still execute in the child instance without throwing — proving the
// child's wrapped `registerCommand` handler took the passthrough fast path (no capture ever wired to
// throw against) and produced a usable result, not just "didn't crash before returning".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const wireMock = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/web-hub/agent/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/web-hub/agent/index.js")>();
  return {
    ...orig,
    wireWebHub: (...args: never[]) => {
      wireMock.calls += 1;
      // Never delegates to the real implementation — this suite only cares whether the call
      // happens at all, never about the hub's own behavior once wired (that's web-hub-e2e's job).
      return { status: () => ({ state: "off", attached: false }), url: () => ({ hint: "mocked" }) };
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
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => unknown }>();
  const pi = {
    registerTool() {},
    registerCommand(name: string, cmd: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) {
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
  return { pi: pi as unknown as ExtensionAPI, commands };
}

describe("web-hub capture — child session evidence (P2①, #32 C12 review)", () => {
  let home: ReturnType<typeof sandboxHome>;
  beforeEach(() => {
    home = sandboxHome();
    releaseGuards();
    wireMock.calls = 0;
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

  it("HOST_KEY early-return runs before web-hub wiring: a child activation never calls wireWebHub, never registers /webhub, and its own pre-guard commands still run (fast path, capture forever undefined)", async () => {
    writeSettings({ webHub: { enabled: true, autoStart: false } });

    // ① Host activation — HOST_KEY not yet claimed, so this call becomes the host and DOES reach
    // the web-hub wiring block. Control assertion: proves the mock/settings actually exercise the
    // call path this test is about, so a later "0 calls" for the child isn't a tautology.
    const host = fakePi();
    activate(host.pi);
    expect(wireMock.calls).toBe(1);
    expect(host.commands.has("webhub")).toBe(true);

    // ② Child activation — HOST_KEY is STILL claimed (by ①, never released — exactly the in-process
    // state every real spawned child subagent session sees, per `src/index.ts`'s own HOST_KEY
    // guard doc comment: "child instances stay inert"). A brand new fake `pi` stands in for the
    // separate ExtensionAPI instance pi hands each child session.
    const child = fakePi();
    activate(child.pi);

    // The core claim: wireWebHub — the ONLY place `commandCaptureRef.current` is ever assigned —
    // was never invoked for the child activation, even though `webHub.enabled: true` is the exact
    // same settings file the host just used successfully.
    expect(wireMock.calls).toBe(1); // unchanged — no second call
    expect(child.commands.has("webhub")).toBe(false);

    // A real pre-guard toolkit command (`/tasklist`, todo.enabled defaults to true) IS registered
    // in the child (pre-guard registrations run for every session, before the HOST_KEY check), and
    // its wrapped handler — the exact same `wrapCommandApi` proxy used by the whole extension —
    // must run to completion and produce real, usable output. Since this child's `commandCaptureRef`
    // was never populated (proven above), `getCapture()` returns `undefined` for every call the
    // handler makes, so this only exercises the C0 fast path: had `command-capture.ts` regressed
    // to throw or hang on an unwired capture, this call would fail/hang instead of resolving.
    const tasklist = child.commands.get("tasklist");
    expect(tasklist).toBeDefined();
    const notified: Array<{ message: string; level?: string }> = [];
    const ctx = {
      mode: "rpc", // non-tui ⇒ the handler's own text fallback fires regardless of isWebInvocation
      hasUI: true,
      ui: { notify: (message: string, level?: string) => notified.push({ message, level }) },
    } as unknown as ExtensionCommandContext;
    await tasklist!.handler("", ctx);
    expect(notified).toHaveLength(1);
    expect(typeof notified[0]?.message).toBe("string"); // real formatTaskList() output, not a throw
  });
});
