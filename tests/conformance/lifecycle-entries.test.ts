/**
 * #56 ⑦ step 7-0 — extension module lifecycle per session entry (docs/dev/source-governance/batch2-plan.md §4.1).
 *
 * REAL pi `AgentSessionRuntime` (the same factory shape main.js uses for every /new /resume /fork) driving a
 * path-loaded probe extension (tests/conformance/fixtures/lifecycle-probe-extension.ts). It pins, per entry:
 *  - whether pi re-imports the extension module (jiti `moduleCache:false` + the `extensionCache`) or reuses it,
 *  - how many times the factory (= `activate()`) runs,
 *  - the order of old-shutdown → new-activate → new-session_start,
 *  - that several `session_shutdown` handlers are awaited strictly one after another.
 *
 * Why it exists: the toolkit's teardown has a module-level handoff (`previous*` in src/stack.ts) that only works when
 * the module instance is reused, and shutdown-time teardown that is the ONLY path when it is not. Which entry takes
 * which path is a pi-internal fact; when a pi bump changes it, this suite fails first (peer bump checklist, step 2).
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  assistantTextMsg,
  createFakeUiContext,
  createUiCallLog,
  fakeModel,
  fakeModelRuntime,
  textTurn,
} from "./topic-switch-runtime-harness.js";

const PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lifecycle-probe-extension.ts");
const KEY = Symbol.for("pi-toolkit:test:lifecycle-probe");
interface Probe {
  moduleLoads: number;
  activations: number;
  log: string[];
}
const slot = globalThis as unknown as Record<symbol, Probe | undefined>;
const probe = (): Probe => {
  const p = slot[KEY];
  if (p === undefined) throw new Error("probe not initialised");
  return p;
};

let root = "";
let prevAgentDir: string | undefined;
let prevOffline: string | undefined;
const runtimes: AgentSessionRuntime[] = [];

beforeEach(() => {
  slot[KEY] = { moduleLoads: 0, activations: 0, log: [] };
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-lifecycle-")));
  mkdirSync(join(root, "agent"), { recursive: true });
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  prevOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.dispose();
    } catch {
      /* already disposed by the test */
    }
  }
  delete slot[KEY];
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  if (prevOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = prevOffline;
  rmSync(root, { recursive: true, force: true });
});

function makeCwd(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same two calls main.js's createRuntime closure makes for every session replacement. */
async function open(cwd: string, sessionManager: SessionManager): Promise<AgentSessionRuntime> {
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, [textTurn("ok")]);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: rCwd,
    agentDir,
    sessionManager: sm,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.create(rCwd, agentDir);
    const services = await createAgentSessionServices({
      cwd: rCwd,
      agentDir,
      settingsManager,
      modelRuntime: modelRuntime as never,
      resourceLoaderOptions: { additionalExtensionPaths: [PROBE_PATH] } as never,
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: sm,
      ...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
      model: model as never,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: join(root, "agent"),
    sessionManager,
  });
  const uiLog = createUiCallLog();
  const rebind = async (session: AgentSession) => {
    await session.bindExtensions({
      uiContext: createFakeUiContext(uiLog),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (o) => runtime.newSession(o),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: false }),
        switchSession: async () => ({ cancelled: true }),
        reload: () => session.reload(),
      },
      shutdownHandler: () => {},
      onError: (err) => {
        probe().log.push(`extension_error:${String(err.error)}`);
      },
    });
  };
  runtime.setRebindSession(rebind);
  await rebind(runtime.session);
  runtimes.push(runtime);
  return runtime;
}

/** A persisted session file (two messages so pi really writes it) in `cwd`. */
function persistedSession(cwd: string): { path: string; entryId: string } {
  const sm = SessionManager.create(cwd, join(root, "sessions"));
  const model = fakeModel();
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as never);
  const entryId = sm.appendMessage(assistantTextMsg(model, "hello") as never);
  const path = sm.getSessionFile();
  if (path === undefined || !existsSync(path)) throw new Error("persisted session was not written");
  return { path, entryId };
}

/** Log entries appended since `from`, plus the module/activation counters. */
function since(from: number): string[] {
  return probe().log.slice(from);
}

/** Shutdown of activation `n` for `reason`, as pi must emit it: both handlers, strictly sequential. */
const shutdownLog = (n: number, reason: string): string[] => [
  `shutdown:${n}:${reason}:1:begin`,
  `shutdown:${n}:${reason}:1:end`,
  `shutdown:${n}:${reason}:2`,
];

describe("pi session-entry lifecycle (7-0, plan §4.1)", () => {
  it("startup: one module load, one activation, then session_start(startup)", async () => {
    await open(makeCwd("a"), SessionManager.inMemory(join(root, "a")));
    expect(probe().moduleLoads).toBe(1);
    expect(probe().activations).toBe(1);
    expect(probe().log).toEqual(["activate:1:module1", "start:1:startup"]);
  });

  it("new (same cwd): old shutdown fully awaited, then the SAME module activates again", async () => {
    const cwd = makeCwd("a");
    const runtime = await open(cwd, SessionManager.inMemory(cwd));
    const mark = probe().log.length;
    await runtime.newSession();
    expect(probe().moduleLoads).toBe(1); // extensionCache hit ⇒ module top level did not run again
    expect(probe().activations).toBe(2);
    expect(since(mark)).toEqual([...shutdownLog(1, "new"), "activate:2:module1", "start:2:new"]);
  });

  it("resume (same cwd): module reused, activation re-runs", async () => {
    const cwd = makeCwd("a");
    const runtime = await open(cwd, SessionManager.inMemory(cwd));
    const target = persistedSession(cwd);
    const mark = probe().log.length;
    await runtime.switchSession(target.path);
    expect(probe().moduleLoads).toBe(1);
    expect(probe().activations).toBe(2);
    expect(since(mark)).toEqual([...shutdownLog(1, "resume"), "activate:2:module1", "start:2:resume"]);
  });

  it("resume (different cwd): pi clears its extension cache ⇒ a NEW module instance", async () => {
    const cwdA = makeCwd("a");
    const cwdB = makeCwd("b");
    const runtime = await open(cwdA, SessionManager.inMemory(cwdA));
    const target = persistedSession(cwdB);
    const mark = probe().log.length;
    await runtime.switchSession(target.path);
    expect(runtime.session.sessionManager.getCwd()).toBe(cwdB);
    expect(probe().moduleLoads).toBe(2);
    expect(probe().activations).toBe(2);
    expect(since(mark)).toEqual([...shutdownLog(1, "resume"), "activate:2:module2", "start:2:resume"]);
  });

  it("fork (same cwd): module reused, activation re-runs", async () => {
    const cwd = makeCwd("a");
    const own = persistedSession(cwd);
    const runtime = await open(cwd, SessionManager.open(own.path, join(root, "sessions")));
    const mark = probe().log.length;
    const result = await runtime.fork(own.entryId, { position: "at" });
    expect(result.cancelled).toBe(false);
    expect(probe().moduleLoads).toBe(1);
    expect(probe().activations).toBe(2);
    expect(since(mark)).toEqual([...shutdownLog(1, "fork"), "activate:2:module1", "start:2:fork"]);
  });

  it("/reload: shutdown(reload) on the old runner, then a FRESH module instance activates", async () => {
    const cwd = makeCwd("a");
    const runtime = await open(cwd, SessionManager.inMemory(cwd));
    const mark = probe().log.length;
    await runtime.session.reload();
    expect(probe().moduleLoads).toBe(2); // resource-loader.reload() clears the cache once `loaded` is true
    expect(probe().activations).toBe(2);
    expect(since(mark)).toEqual([...shutdownLog(1, "reload"), "activate:2:module2", "start:2:reload"]);
  });

  it("/new then /reload: the reload still re-imports (the replacement loader is `loaded` by then)", async () => {
    const cwd = makeCwd("a");
    const runtime = await open(cwd, SessionManager.inMemory(cwd));
    await runtime.newSession();
    expect(probe().moduleLoads).toBe(1);
    const mark = probe().log.length;
    await runtime.session.reload();
    expect(probe().moduleLoads).toBe(2);
    expect(since(mark)).toEqual([...shutdownLog(2, "reload"), "activate:3:module2", "start:3:reload"]);
  });

  it("/reload then /new: the re-imported module is the one the next same-cwd switch reuses", async () => {
    const cwd = makeCwd("a");
    const runtime = await open(cwd, SessionManager.inMemory(cwd));
    await runtime.session.reload();
    const mark = probe().log.length;
    await runtime.newSession();
    expect(probe().moduleLoads).toBe(2); // no third import
    expect(since(mark)).toEqual([...shutdownLog(2, "new"), "activate:3:module2", "start:3:new"]);
  });

  it("quit: shutdown(quit) handlers are awaited in order and nothing activates afterwards", async () => {
    const cwd = makeCwd("a");
    const runtime = await open(cwd, SessionManager.inMemory(cwd));
    const mark = probe().log.length;
    await runtime.dispose();
    expect(since(mark)).toEqual(shutdownLog(1, "quit"));
    expect(probe().activations).toBe(1);
    expect(probe().moduleLoads).toBe(1);
  });
});
