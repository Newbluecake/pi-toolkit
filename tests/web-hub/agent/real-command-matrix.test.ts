/**
 * #32 C12 review P2② — real command matrix: exercises the ACTUAL production `registerCommand`
 * factories (not fake `mycmd` stand-ins) through the real `wrapCommandApi` + `createCommandCaptureEngine`
 * round trip, covering the plan's §4.9 real-command examples explicitly called out by the reviewer:
 * `/tasklist` (no-arg text fallback, `currentUI` must NOT be swapped for the capture proxy),
 * `/agent status` (an "allow"-class read-only command), and `/mem doctor` (editor prefill capture,
 * §4.9 point 5's `editor` row).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import {
  createCommandCaptureEngine,
  wrapCommandApi,
  type CaptureInvocation,
  type CommandCaptureEngine,
} from "../../../src/web-hub/agent/command-capture.js";
import { createStatusCommand, type StatusCommandDeps } from "../../../src/commands/status.js";
import { wireTodo } from "../../../src/todo/index.js";
import { createMemCommand } from "../../../src/memory/command.js";
import { DEFAULT_SETTINGS } from "../../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../../src/memory/paths.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "req-1" };

function invocationOf(overrides: Partial<CaptureInvocation> = {}): CaptureInvocation {
  return {
    cmdId: "cmd-1",
    reqId: "req-1",
    origin: ORIGIN,
    name: "mycmd",
    args: "",
    deadlineAt: Date.now() + 10_000,
    ...overrides,
  };
}

function fakeApi(): ExtensionAPI & {
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  tools: Map<string, unknown>;
} {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const tools = new Map<string, unknown>();
  const api = {
    commands,
    tools,
    registerTool(def: { name: string }) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, command);
    },
    on() {
      return () => undefined;
    },
    appendEntry() {
      return "entry";
    },
    sendMessage() {},
    events: { on: () => () => undefined, emit: () => undefined },
  };
  return api as unknown as ExtensionAPI & typeof api;
}

/** Dispatches `engine.arm(inv)` then invokes the wrapped handler exactly like `pi` invoking the
 * command synchronously, mirroring §4.9 point 3's "同步前缀" (same helper as capture-commands.test.ts). */
async function dispatch(
  api: { commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">> },
  engine: CommandCaptureEngine,
  invocation: CaptureInvocation,
  ctx: ExtensionCommandContext,
): Promise<unknown> {
  engine.registerOwned(invocation.name);
  engine.arm(invocation);
  const command = api.commands.get(invocation.name);
  if (command === undefined) throw new Error(`command ${invocation.name} not registered`);
  return command.handler(invocation.args, ctx);
}

function setup() {
  const api = fakeApi();
  const ownedNames = new Set<string>();
  const engine = createCommandCaptureEngine({ ownedNames });
  const pi = wrapCommandApi(api, () => engine, ownedNames);
  return { api, engine, pi, ownedNames };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("real command matrix — /tasklist (todo)", () => {
  it("no-arg dispatch: real formatTaskList() text fallback is captured, real ctx.ui.notify still fires, and currentUI (the long-lived widget host set by session_start) is NOT swapped for the one-shot capture proxy", async () => {
    const { api, engine, pi } = setup();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    (api as unknown as { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }).on = (
      event,
      handler,
    ) => handlers.set(event, handler);
    wireTodo(pi, {});

    // Establish a real, long-lived `currentUI` the way production does: session_start's `restore()`
    // hook assigns it (src/todo/index.ts:193), independent of any command dispatch.
    let realWidgetCalls = 0;
    const terminalUi = {
      notify: () => undefined,
      setWidget: () => {
        realWidgetCalls += 1;
      },
      setStatus: () => undefined,
    };
    const sessionCtx = {
      mode: "tui",
      hasUI: true,
      ui: terminalUi,
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionCommandContext;
    await handlers.get("session_start")?.({}, sessionCtx);

    // Now a web-claimed `/tasklist` dispatch, with its OWN distinct `ui` — if `:428`'s
    // `currentUI = ctx.ui` guard regressed (dropped the `!isWebInvocation(ctx)` check), this call
    // would silently rebind the long-lived widget host to this short-lived captured proxy.
    const realNotify: Array<{ message: string; level?: string }> = [];
    const webUi = {
      notify: (message: string, level?: string) => realNotify.push({ message, level }),
      setWidget: () => undefined,
      setStatus: () => undefined,
    };
    const webCtx = {
      mode: "tui",
      hasUI: true,
      ui: webUi,
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionCommandContext;
    const inv = invocationOf({ name: "tasklist", args: "" });
    await dispatch(api, engine, inv, webCtx);

    expect(engine.owns("tasklist")).toBe(true);
    // Real terminal notify still happened (§4.9 point 5's notify row: forwarded AND collected).
    expect(realNotify).toHaveLength(1);
    expect(typeof realNotify[0]?.message).toBe("string");
    const out = engine.outputFor(inv.cmdId);
    expect(out?.entries).toEqual([{ kind: "notify", level: "info", text: realNotify[0]!.message }]);

    // §4.9 point 6: creating a task (any state mutation that calls the module-level
    // `refreshWidget()`) must still land on the ORIGINAL terminal `ui`, proving `currentUI` was
    // never rebound to the web call's `ui` above.
    const taskCreate = api.tools.get("TaskCreate") as {
      execute: (id: string, params: unknown, a: unknown, b: unknown, ctx: ExtensionCommandContext) => Promise<unknown>;
    };
    await taskCreate.execute(
      "call-1",
      { subject: "probe", description: "probe task" },
      undefined,
      undefined,
      sessionCtx,
    );
    expect(realWidgetCalls).toBeGreaterThan(0); // the REAL terminal ui got the widget update
  });
});

describe("real command matrix — /agent status", () => {
  function statusDeps(): StatusCommandDeps {
    return {
      query: {
        list: () => [],
        get: () => undefined,
        wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
        waitAll: async () => ({ settled: [], pending: [] }),
        steer: async () => undefined,
        stop: async () => false,
      },
      orphans: {
        register: () => undefined,
        recordLateRecovered: () => undefined,
        recent: [],
        totalCount: 0,
        lateRecoveredCount: 0,
        countInWindow: () => 0,
        byReason: new Map(),
        resetCircuit: () => undefined,
      },
      notifier: {
        enqueue: () => undefined,
        consume: () => false,
        reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
        verifyPersisted: () => ({ missing: [] }),
        stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
        degraded: [],
      },
    } as unknown as StatusCommandDeps;
  }

  it("no-arg dispatch: real renderStatus() text is captured via notify, needsTerminal absent (read-only, no interactive UI)", async () => {
    const { api, engine, pi } = setup();
    pi.registerCommand("agent", createStatusCommand(statusDeps()));
    const realNotify: string[] = [];
    const ui = { notify: (message: string) => realNotify.push(message) };
    const ctx = { mode: "tui", hasUI: true, ui } as unknown as ExtensionCommandContext;
    const inv = invocationOf({ name: "agent", args: "" });
    await dispatch(api, engine, inv, ctx);

    expect(engine.owns("agent")).toBe(true);
    expect(realNotify).toHaveLength(1);
    const out = engine.outputFor(inv.cmdId);
    expect(out?.entries).toEqual([{ kind: "notify", level: "info", text: realNotify[0] }]);
    expect(out?.needsTerminal).toBeUndefined();
  });
});

describe("real command matrix — /mem doctor", () => {
  function fixture(): { cwd: string; paths: MemoryPaths } {
    const tmp = mkdtempSync(join(tmpdir(), "pi-mem-real-matrix-"));
    dirs.push(tmp);
    const cwd = join(tmp, "proj");
    mkdirSync(cwd, { recursive: true });
    const paths: MemoryPaths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
    const memDir = memoryDirFor(cwd, paths);
    mkdirSync(memDir, { recursive: true });
    // 21 files each marked `status: stale` ⇒ 21 D08 findings, over the handler's own >20 threshold
    // for switching from `ctx.ui.notify` to `ctx.ui.editor` (doctor-command.ts's `handleMemDoctorCommand`).
    for (let i = 0; i < 21; i++) {
      writeFileSync(
        join(memDir, `topic-${i}.md`),
        `---\ntopic: topic-${i}\nstatus: stale\ndescription: test topic ${i}\n---\nbody ${i}\n`,
        "utf8",
      );
    }
    return { cwd, paths };
  }

  it(">20 findings: real handleMemDoctorCommand() report is captured as an editor prefill (text) + interactive marker, real terminal editor never opens, needsTerminal is set", async () => {
    const fx = fixture();
    const { api, engine, pi } = setup();
    pi.registerCommand(
      "mem",
      createMemCommand({ paths: fx.paths, settings: DEFAULT_SETTINGS.memory }) as unknown as Omit<
        RegisteredCommand,
        "name" | "sourceInfo"
      >,
    );
    let realEditorCalled = false;
    const ui = {
      notify: () => undefined,
      editor: async (_title: string, _prefill?: string) => {
        realEditorCalled = true;
        return "SHOULD-NOT-BE-CALLED";
      },
    };
    const ctx = { mode: "tui", hasUI: true, cwd: fx.cwd, ui } as unknown as ExtensionCommandContext;
    const inv = invocationOf({ name: "mem", args: "doctor" });
    await dispatch(api, engine, inv, ctx);

    expect(engine.owns("mem")).toBe(true);
    expect(realEditorCalled).toBe(false); // §4.9 point 5: editor never opens for a captured invocation
    const out = engine.outputFor(inv.cmdId);
    const textEntry = out?.entries.find((e) => e.kind === "text");
    expect(textEntry?.title).toBe("memory doctor");
    expect(textEntry?.text).toContain("D08"); // real doctor report, not a stub
    expect(out?.entries.some((e) => e.kind === "interactive" && e.text === "editor")).toBe(true);
    expect(out?.needsTerminal).toBe(true);
  });
});
