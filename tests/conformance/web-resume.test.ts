/**
 * web-resume plan §4 "P4 conformance" — the C-pins against the REAL devDependency pi 1.2
 * (real `AgentSession` / `AgentSessionRuntime` / `SessionManager`, and for C2 the real
 * `pi --mode rpc` CLI exactly the way the hub forks it). No network to model providers: every
 * in-process session runs on the shared scripted fake runtime (agent-session-harness.ts), the
 * rpc child never issues a model request (boot + resume switch need none).
 *
 *  C1 TUI-shaped: `pi.sendUserMessage("/…", {deliverAs:"followUp", expandPromptTemplates:true})`
 *     runs the extension-command handler's SYNC prefix before the call returns — idle (F5),
 *     while streaming (F5 "even during streaming"), and NOT during `agent_settled` emission
 *     (deferred re-entry — §2.5 step 7's "still armed" window). Then `ctx.switchSession`
 *     through a REAL `AgentSessionRuntime` fires `session_start` (reason "resume",
 *     previousSessionFile) on the target and hands `withSession` the new session.
 *  C2 `--mode rpc`: `resume __list`/`__pick` over the real agent socket against a real target
 *     session file — sync `completion:"async"` decision, a NEW `session` frame carrying the
 *     target id (F7: rpc mode wires ctx.switchSession), exactly one `cmd_late` ok.
 *  C3 `SessionManager.list` over a symlink temp dir (the recent loader's shape): 3-arg
 *     progress — partial rows published on `loaded===1`/interval/last, `undefined` in between
 *     — and every partial/final row carries the TEMP-dir path (F4); a non-default sessionDir
 *     filters foreign-header-cwd sessions out of BOTH partials and the final list.
 *  C4 a REAL child run (`PiSessionDriver` create + prompt, real marker) never appears in
 *     either list: the TUI recent loader (real `SessionManager.list`) partials+final and the
 *     web `createResumeList` generation both drop it (D1); line 2 of the file is the marker.
 *  C5 `SessionManager.open` of a MISSING path initialises a NEW empty session at that path
 *     (F6): new id, file still absent until a message, append materialises it at OUR path with
 *     the NEW header id — the fact `resume:mismatch` (effect unknown) is built on. Also pinned
 *     through the real runtime: a switch to a deleted path completes `cancelled:false` onto a
 *     session whose id ≠ the (gone) target's.
 *
 * Skipped where their real dependency is absent (C2: the pi CLI file; C4: posix — the env
 * redirect premise). `npm run test:conformance` runs this directory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionRuntime,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { assistantTextMsg, disposeHarnessDirs, fakeModel } from "./agent-session-harness.js";
import { listRecentSessions } from "../../src/session-nav/recent-sessions.js";
import { PiSessionDriver, SUBAGENT_CHILD_CUSTOM_TYPE } from "../../src/runtime/session-driver.js";
import { createResumeList, defaultResumeCore } from "../../src/web-hub/agent/resume-list.js";
import type { CmdArgs, CmdFrame, CmdOrigin, ResumeSessionsWire } from "../../src/web-hub/protocol/messages.js";
import { RESTORE_SESSION_ID_RE } from "../../src/web-hub/protocol/spawn.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PI_CLI = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const POSIX = process.platform !== "win32";
const HOST_KEY = Symbol.for("pi-subagent:host");

afterEach(() => {
  disposeHarnessDirs();
});

const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const userMsg = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

// ---------------------------------------------------------------------------
// C1 harness — a REAL AgentSessionRuntime (createAgentSessionRuntime), wired the way the
// modes wire it: bindExtensions({mode, commandContextActions}) with switchSession → the
// runtime, setRebindSession → re-bind after every replacement. Extension factories re-run on
// every runtime creation (exactly what a switch does in a real mode).
// ---------------------------------------------------------------------------

interface GateTurn {
  toolCall: boolean;
  build: (model: ReturnType<typeof fakeModel>) => unknown;
  /** Hold this model call open until the promise resolves (deterministic streaming state). */
  gate?: Promise<void>;
}

function gatedModelRuntime(model: ReturnType<typeof fakeModel>, scripted: GateTurn[]) {
  let call = 0;
  return {
    streamSimple: (_m: unknown, context: { messages?: unknown[] }) => {
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const finish = () => {
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: turn.toolCall ? "toolUse" : "stop",
          message: turn.build(model),
        });
        return stream;
      };
      return turn.gate ? turn.gate.then(finish) : finish();
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
  };
}

interface RuntimeEnv {
  runtime: import("@earendil-works/pi-coding-agent").AgentSessionRuntime;
  session: import("@earendil-works/pi-coding-agent").AgentSession;
  cwd: string;
  sessionDir: string;
}

async function withRuntimeSession(
  opts: { scripted: GateTurn[]; extensionFactories?: unknown[] },
  run: (env: RuntimeEnv) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "web-resume-conf-"));
  const agentDir = join(cwd, ".pi-agent");
  const sessionDir = join(cwd, "sessions");
  const model = fakeModel();
  const modelRuntime = gatedModelRuntime(model, opts.scripted);
  const factory = async (o: {
    cwd: string;
    agentDir: string;
    sessionManager: unknown;
    sessionStartEvent?: unknown;
  }) => {
    const settingsManager = SettingsManager.create(o.cwd, o.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: o.cwd,
      agentDir: o.agentDir,
      settingsManager,
      extensionFactories: (opts.extensionFactories ?? []) as never,
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: o.cwd,
      agentDir: o.agentDir,
      model: model as never,
      modelRuntime: modelRuntime as never,
      sessionManager: o.sessionManager as never,
      settingsManager,
      resourceLoader,
      tools: [],
      sessionStartEvent: o.sessionStartEvent as never,
    });
    return {
      ...result,
      services: { cwd: o.cwd, agentDir: o.agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
    } as never;
  };
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const runtime = await createAgentSessionRuntime(factory as never, { cwd, agentDir, sessionManager });
  const rebind = async (): Promise<void> => {
    const session = runtime.session;
    await session.bindExtensions({
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => runtime.newSession(options),
        fork: async (entryId, forkOptions) => {
          const result = await runtime.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => {},
      },
    } as never);
  };
  runtime.setRebindSession(async () => {
    await rebind();
  });
  await rebind();
  try {
    await run({ runtime, session: runtime.session, cwd, sessionDir });
  } finally {
    try {
      runtime.session.dispose();
    } catch {
      /* already disposed by a switch */
    }
  }
}

/** Recorder extension: /wr command + session_start/session_shutdown/agent_settled observers.
 *  `switchTo` makes the command perform a real `ctx.switchSession` (the /webhub __exec shape);
 *  `settleNonce` makes the agent_settled handler re-enter the command surface from INSIDE the
 *  settle emission (the §2.5 step-6 re-entry). */
interface Recorder {
  order: string[];
  starts: Array<{ reason: string; previousSessionFile?: string }>;
  shutdowns: Array<{ reason: string; targetSessionFile?: string }>;
  switchTo?: { path: string; withSessionIds: string[]; results: string[] };
  settleNonce?: string;
}

function recorderExtension(rec: Recorder) {
  return (pi: {
    registerCommand: (
      name: string,
      def: {
        description: string;
        handler: (
          args: string,
          ctx: { switchSession(path: string, options?: unknown): Promise<unknown> },
        ) => Promise<void>;
      },
    ) => void;
    on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
    sendUserMessage: (text: string, options?: unknown) => void;
  }) => {
    pi.registerCommand("wr", {
      description: "web-resume conformance test command",
      handler: async (args, ctx) => {
        rec.order.push(`cmd:${args}`);
        if (rec.switchTo !== undefined && args.startsWith("switch ")) {
          const ids: string[] = [];
          const rc = (await ctx.switchSession(rec.switchTo.path, {
            withSession: async (rc2: { sessionManager: { getSessionId(): string } }) => {
              ids.push(rc2.sessionManager.getSessionId());
            },
          })) as { cancelled?: boolean };
          rec.switchTo.withSessionIds.push(...ids);
          rec.switchTo.results.push(JSON.stringify(rc));
        }
      },
    });
    pi.on("session_start", (event) => {
      const e = event as unknown as { reason: string; previousSessionFile?: string };
      rec.starts.push({ reason: e.reason, previousSessionFile: e.previousSessionFile });
    });
    pi.on("session_shutdown", (event) => {
      const e = event as unknown as { reason: string; targetSessionFile?: string };
      rec.shutdowns.push({ reason: e.reason, targetSessionFile: e.targetSessionFile });
    });
    pi.on("agent_settled", () => {
      if (rec.settleNonce !== undefined) {
        pi.sendUserMessage(`/wr ${rec.settleNonce}`, {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
        rec.order.push("settled-return");
      }
    });
  };
}

describe.skipIf(!existsSync(PI_CLI))(
  "C1: real AgentSession + AgentSessionRuntime — F5 sync prefix + switchSession",
  () => {
    it("idle: the command handler's sync prefix runs BEFORE sendUserMessage returns (F5)", async () => {
      const rec: Recorder = { order: [], starts: [], shutdowns: [] };
      await withRuntimeSession(
        {
          scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "done") }],
          extensionFactories: [recorderExtension(rec)],
        },
        async ({ session }) => {
          const p = session.sendUserMessage("/wr idle-nonce", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          // NOT awaited on purpose: the §2.5 step-7 premise is that by the time the
          // (fire-and-forget) sendUserMessage returns, the ticket is already rejected/switching.
          expect(rec.order).toEqual(["cmd:idle-nonce"]);
          await p;
          expect(rec.order).toEqual(["cmd:idle-nonce"]);
        },
      );
    }, 30_000);

    it("streaming: the command still executes immediately — never queued behind the run (F5)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const rec: Recorder = { order: [], starts: [], shutdowns: [] };
      await withRuntimeSession(
        {
          scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "done"), gate }],
          extensionFactories: [recorderExtension(rec)],
        },
        async ({ session }) => {
          const promptP = session.prompt("go");
          await until(() => session.isStreaming, 5_000, "session to start streaming");
          const p = session.sendUserMessage("/wr while-streaming", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          expect(rec.order).toEqual(["cmd:while-streaming"]); // executed immediately, not queued
          await p;
          release();
          await promptP;
          expect(rec.order).toEqual(["cmd:while-streaming"]);
        },
      );
    }, 30_000);

    it("agent_settled emission: sendUserMessage is DEFERRED — the command runs only after settle (the 'still armed' window)", async () => {
      const rec: Recorder = { order: [], starts: [], shutdowns: [], settleNonce: "deferred-nonce" };
      await withRuntimeSession(
        {
          scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "done") }],
          extensionFactories: [recorderExtension(rec)],
        },
        async ({ session }) => {
          await session.prompt("go");
          // Deferred re-entry: the settle handler returned BEFORE the command ran, and the
          // deferred action executed within the same prompt() — the order is deterministic.
          expect(rec.order).toEqual(["settled-return", "cmd:deferred-nonce"]);
        },
      );
    }, 30_000);

    it("ctx.switchSession through the REAL runtime: session_start(reason resume) on the target, withSession sees it, old session shuts down", async () => {
      // a REAL target session in its own dir
      const targetCwd = mkdtempSync(join(tmpdir(), "web-resume-target-"));
      const targetDir = join(targetCwd, "sessions");
      const targetSm = SessionManager.create(targetCwd, targetDir);
      targetSm.appendMessage(userMsg("target session"));
      const targetFile = targetSm.getSessionFile()!;
      const targetId = targetSm.getSessionId();

      const rec: Recorder = {
        order: [],
        starts: [],
        shutdowns: [],
        switchTo: { path: targetFile, withSessionIds: [], results: [] },
      };
      await withRuntimeSession(
        {
          scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "boot done") }],
          extensionFactories: [recorderExtension(rec)],
        },
        async ({ session, runtime }) => {
          await session.prompt("boot hello");
          const bootFile = session.sessionManager.getSessionFile();
          expect(bootFile).toBeDefined();

          await session.sendUserMessage("/wr switch now", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });

          // the switch really happened through the runtime
          expect(rec.switchTo!.results).toEqual(['{"cancelled":false}']);
          expect(runtime.session.sessionManager.getSessionId()).toBe(targetId);
          expect(runtime.session.sessionManager.getSessionFile()).toBe(targetFile);
          expect(rec.switchTo!.withSessionIds).toEqual([targetId]);
          // session_start on the target, carrying the previous file (why web-hub re-binds)
          const resume = rec.starts.find((s) => s.reason === "resume");
          expect(resume).toBeDefined();
          expect(resume!.previousSessionFile).toBe(bootFile);
          // the outgoing session saw session_shutdown(reason resume, targetSessionFile)
          const shutdown = rec.shutdowns.find((s) => s.reason === "resume");
          expect(shutdown).toBeDefined();
          expect(shutdown!.targetSessionFile).toBe(targetFile);
        },
      );
      rmSync(targetCwd, { recursive: true, force: true });
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// C2 — real `pi --mode rpc` × a fake hub socket: the full §2.4/§2.5 chain against real pi.
// ---------------------------------------------------------------------------

interface PreparedHome {
  home: string;
  workdir: string;
  agentDir: string;
  sessionDir: string;
}

function prepareResumeHome(): PreparedHome {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pwh-conf-wr-")));
  const workdir = join(home, "work");
  mkdirSync(workdir, { recursive: true });
  const agentDir = join(home, ".pi", "agent");
  // pi's getDefaultSessionDirPath encoding — where a fresh rpc child's sessionManager lives.
  const safe = `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safe);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
  writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify({ webHub: { enabled: true } }));
  return { home, workdir, agentDir, sessionDir };
}

interface RpcRun {
  child: ChildProcess;
  frames: Array<Record<string, unknown>>;
  send(frame: unknown): void;
  exit: Promise<{ code: number | null; signal: string | null }>;
  cleanup(): void;
}

function launchRpc(prepared: PreparedHome): RpcRun {
  const { home, workdir, agentDir } = prepared;
  const stateDir = join(agentDir, "web-hub");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const socketPath = join(stateDir, "hub.sock");
  rmSync(socketPath, { force: true });
  const frames: Array<Record<string, unknown>> = [];
  let activeSock: net.Socket | undefined;
  let acked = false;
  const server = net.createServer((sock) => {
    activeSock = sock;
    const dec = new NdjsonDecoder({
      maxFrameBytes: 512 * 1024,
      onFrame: (raw: unknown) => {
        const frame = raw as Record<string, unknown>;
        frames.push(frame);
        if (frame["t"] === "hello" && !acked) {
          acked = true;
          sock.write(
            `${JSON.stringify({
              t: "hello_ack",
              hubVersion: "1.2.3",
              buildId: "1.2.3@conf",
              proto: { major: PROTO.major, minor: PROTO.minor },
              agentKey: "a-conf-webresume-0001",
              pingMs: 10_000,
              leaseMs: 30_000,
              http: { port: 0 },
              caps: ["ctl.v1", "cmd.v1", "dialog.v1", "command.v1", "ctl.v2"],
            })}\n`,
          );
        }
      },
      onError: () => {},
    });
    sock.on("data", (c: Buffer) => dec.push(c));
    sock.on("error", () => {});
  });
  server.listen(socketPath);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("PI_WEBHUB_") || k === "FORCE_COLOR") continue;
    env[k] = v;
  }
  env["HOME"] = home;
  env["PI_WEBHUB_HEADLESS"] = "1";
  env["PI_WEBHUB_SPAWN_ID"] = `conf-webresume-${Date.now().toString(36)}`;
  const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc"], {
    cwd: workdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.resume(); // drain (pi-toolkit boot warnings)
  child.stdout?.resume();
  const exit = new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.once("exit", (code, signal) => res({ code, signal }));
  });
  return {
    child,
    frames,
    send(frame) {
      activeSock?.write(`${JSON.stringify(frame)}\n`);
    },
    exit,
    cleanup() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      server.close();
      server.closeAllConnections?.();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const WR_ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" };
function wrCmdFrame(id: string, args: string): CmdFrame {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: WR_ORIGIN,
    cmd: { op: "command", name: "resume", args } as CmdArgs & { op: "command" },
  };
}

describe.skipIf(!existsSync(PI_CLI))("C2: real pi --mode rpc — resume __list/__pick over the agent socket", () => {
  // Regression pin (2026-10-16): this test caught a real product bug — after the REAL session
  // replacement the first activation's ctx is stale and pi's guarded `ctx.ui` getter throws;
  // `onChanged()` → refreshStatusLine() → readStatusTheme(ctx) used to throw BEFORE
  // commands.ts's settleLate sent the pick's `cmd_late`, silently dropping §2.5 d's "exactly one
  // late result per armed ticket". Fixed in src/web-hub/agent/index.ts (readStatusTheme never
  // throws; onChanged/publish isolate each step). P2's wiring tests had faked switchSession, so
  // the ctx never went stale there (tests/web-hub/agent/wiring-resume.test.ts now arms a stale
  // getter too). The session frame is asserted BEFORE the late wait, so a regression isolates
  // exactly the lost cmd_late.
  it("list → pick → real switchSession: sync async-completion decision, new session frame with the target id, exactly one cmd_late ok", async () => {
    const prepared = prepareResumeHome();
    // a REAL target session in the child's own default session dir, header cwd = workdir
    const sm = SessionManager.create(prepared.workdir, prepared.sessionDir);
    sm.appendMessage(userMsg("web resume target"));
    const targetFile = sm.getSessionFile()!;
    const targetId = sm.getSessionId();
    const old = new Date(Date.now() - 120_000); // D5-a: outside the 30 s recent-write window
    utimesSync(targetFile, old, old);

    const run = launchRpc(prepared);
    try {
      await until(() => run.frames.some((f) => f["t"] === "session"), 30_000, "boot session frame");
      const bootId = run.frames.find((f) => f["t"] === "session")!["sessionId"];
      expect(typeof bootId).toBe("string");

      // __list over the socket (the only async builtin op)
      run.send(wrCmdFrame("cmd00000000000001", `__list ${JSON.stringify({ scope: "all" })}`));
      await until(
        () => run.frames.some((f) => f["t"] === "cmd_result" && f["id"] === "cmd00000000000001"),
        15_000,
        "__list reply",
      );
      const listReply = run.frames.find((f) => f["t"] === "cmd_result" && f["id"] === "cmd00000000000001") as {
        ok: boolean;
        data: { sessions?: ResumeSessionsWire };
      };
      expect(listReply.ok).toBe(true);
      const wire = listReply.data.sessions!;
      expect(wire.v).toBe(1);
      expect(wire.scope).toBe("all");
      expect(wire.rows.map((r) => r.id)).toContain(targetId);

      // __pick — the §2.5 synchronous decision
      run.send(wrCmdFrame("cmd00000000000002", `__pick ${JSON.stringify({ id: targetId, gen: wire.gen })}`));
      await until(
        () => run.frames.some((f) => f["t"] === "cmd_result" && f["id"] === "cmd00000000000002"),
        15_000,
        "__pick reply",
      );
      const pickReply = run.frames.find((f) => f["t"] === "cmd_result" && f["id"] === "cmd00000000000002") as {
        ok: boolean;
        data: { completion?: string };
      };
      expect(pickReply.ok).toBe(true);
      expect(pickReply.data.completion).toBe("async");

      // the switch landed in the REAL rpc runtime: a fresh session frame names the target
      await until(
        () => run.frames.some((f) => f["t"] === "session" && f["sessionId"] === targetId),
        20_000,
        "post-switch session frame",
      );
      // and exactly one cmd_late ok settles the ticket (§2.5 d — the mandated single late).
      // This is the assertion the KNOWN PRODUCT BUG above makes fail (see the describe comment).
      await until(
        () => run.frames.some((f) => f["t"] === "cmd_late" && f["id"] === "cmd00000000000002"),
        15_000,
        "cmd_late",
      );
      const lates = run.frames.filter((f) => f["t"] === "cmd_late" && f["id"] === "cmd00000000000002");
      expect(lates).toHaveLength(1);
      expect(lates[0]!["ok"]).toBe(true);
    } finally {
      run.cleanup();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C3 — real SessionManager.list over a symlink temp dir (the recent loader's exact shape).
// ---------------------------------------------------------------------------

describe("C3: SessionManager.list — 3-arg progress, temp paths, foreign-cwd filter (F4)", () => {
  it("partials carry TEMP-dir paths; published on 1st/interval/last with undefined between; foreign-cwd rows vanish from partials AND final", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-resume-c3-"));
    try {
      const cwdA = join(root, "a");
      const cwdB = join(root, "b");
      mkdirSync(cwdA, { recursive: true });
      mkdirSync(cwdB, { recursive: true });
      const realDir = join(root, "sessions");
      mkdirSync(realDir, { recursive: true });

      // 12 same-cwd files (pi's publish interval is 10, so 13 files ⇒ both progress shapes)
      for (let i = 0; i < 12; i++) {
        SessionManager.create(cwdA, realDir).appendMessage(userMsg(`session ${i}`));
      }
      // one foreign-cwd session — same dir, different header cwd
      const foreignSm = SessionManager.create(cwdB, realDir);
      foreignSm.appendMessage(userMsg("foreign cwd"));

      // the recent loader's temp-dir shape: symlink every candidate in, list over the temp dir
      const tempDir = mkdtempSync(join(tmpdir(), "web-resume-c3-temp-"));
      try {
        for (const name of readdirSync(realDir).filter((n) => n.endsWith(".jsonl"))) {
          symlinkSync(join(realDir, name), join(tempDir, name), "file");
        }
        const calls: Array<{ loaded: number; total: number; partials: readonly SessionInfo[] | undefined }> = [];
        const finalRows = await SessionManager.list(cwdA, tempDir, (loaded, total, partials) => {
          calls.push({ loaded, total, partials });
        });

        // 3-arg shape: BOTH forms occur — array partials (1st/10th/last) and undefined between
        expect(calls.length).toBeGreaterThanOrEqual(13);
        expect(calls.some((c) => Array.isArray(c.partials))).toBe(true);
        expect(calls.some((c) => c.partials === undefined)).toBe(true);
        expect(calls[0]!.loaded).toBe(1);
        expect(calls[0]!.partials).toBeDefined();

        // partial rows carry TEMP paths (r1 #5 — why wrappedProgress must map them first)…
        for (const c of calls) {
          for (const row of c.partials ?? []) {
            expect(row.path.startsWith(tempDir)).toBe(true);
            expect(row.path.includes(realDir)).toBe(false);
          }
        }
        // …and the foreign-cwd row never reaches even a partial (filterCwd wraps partials too)
        const foreignName = (foreignSm.getSessionFile() ?? "").split("/").pop() ?? "";
        for (const c of calls) {
          for (const row of c.partials ?? []) {
            expect(row.path.endsWith(foreignName)).toBe(false);
          }
        }
        // final rows: temp paths as well (the loader restores real paths itself)
        expect(finalRows).toHaveLength(12);
        for (const row of finalRows) {
          expect(row.path.startsWith(tempDir)).toBe(true);
          expect(row.cwd).toBe(cwdA);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// C4 — a REAL child run (PiSessionDriver + real pi session) is hidden from both lists (D1).
// ---------------------------------------------------------------------------

describe.skipIf(!POSIX)("C4: real child run — line-2 marker, never in the TUI or web list", () => {
  const envRestore: Array<() => void> = [];
  let hostKeyReleased: (() => void) | undefined;
  let scratchRoot: string | undefined;
  let scratchCwd: string | undefined;

  afterEach(() => {
    hostKeyReleased?.();
    hostKeyReleased = undefined;
    for (const restore of envRestore.splice(0)) restore();
    if (scratchRoot !== undefined) rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = undefined;
    scratchCwd = undefined;
  });

  function childRuntime(model: ReturnType<typeof fakeModel>, reply: string) {
    return {
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: assistantTextMsg(model, reply) });
        return stream;
      },
      getAuth: async () => undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ ok: true }),
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
    };
  }

  it("marker on line 2; the child is absent from listRecentSessions partials+final AND from the web resume generation", async () => {
    // scratch + env redirect — the real child-session shape: settings.json lists THIS package,
    // host key claimed, agentDir/HOME redirected so everything lands in the sandbox
    scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "web-resume-c4-")));
    scratchCwd = join(scratchRoot, "work");
    const agentDir = join(scratchRoot, "agent");
    mkdirSync(scratchCwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(scratchRoot, "home"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", agentDir],
      ["HOME", join(scratchRoot, "home")],
    ] as const) {
      const prev = process.env[key];
      process.env[key] = value;
      envRestore.push(() => {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      });
    }
    expect(homedir()).toBe(join(scratchRoot, "home"));
    const g = globalThis as Record<symbol, unknown>;
    const prevHost = g[HOST_KEY];
    g[HOST_KEY] = { activatedAt: Date.now() };
    hostKeyReleased = () => {
      if (prevHost === undefined) delete g[HOST_KEY];
      else g[HOST_KEY] = prevHost;
    };

    // --- a real child run through the real driver (marker at create; the file materialises
    //     lazily with the first user message — exactly the production path)
    const model = fakeModel();
    const driver = new PiSessionDriver(true, () => model);
    const handle = await driver.create({
      cwd: scratchCwd,
      model: model as never,
      modelRuntime: childRuntime(model, "child answer") as never,
      persist: true,
    } as never);
    let childFile: string;
    try {
      await handle.prompt("child task");
      childFile = handle.sessionFile!;
      expect(childFile).toBeDefined();
    } finally {
      handle.dispose();
    }

    // --- line 1 header, line 2 marker (F3)
    const lines = readFileSync(childFile, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(JSON.parse(lines[0]!).type).toBe("session");
    expect(lines[1]!.startsWith(`{"type":"custom","customType":"${SUBAGENT_CHILD_CUSTOM_TYPE}"`)).toBe(true);
    const childId = JSON.parse(lines[0]!).id as string;

    // --- a real MAIN session in the same dir, with a real subagent:run mark naming the child
    const sessionDir = dirname(childFile);
    const mainSm = SessionManager.create(scratchCwd, sessionDir);
    mainSm.appendMessage(userMsg("main task"));
    mainSm.appendCustomEntry("subagent:run", { diag: { sessionFile: childFile } });
    const mainFile = mainSm.getSessionFile()!;
    const mainId = mainSm.getSessionId();

    // --- TUI list (real SessionManager.list under the hood): the child never surfaces
    const partials: SessionInfo[][] = [];
    const tui = await listRecentSessions(scratchCwd, sessionDir, 48, (_l, _t, p) => {
      if (p !== undefined) partials.push([...p]);
    });
    expect(tui.map((s) => s.path)).toContain(mainFile);
    expect(tui.map((s) => s.path)).not.toContain(childFile);
    for (const p of partials) {
      expect(p.map((s) => s.path)).not.toContain(childFile);
    }

    // --- web list (real generation build): the child row is absent
    const webList = createResumeList({
      getSessionDir: () => sessionDir,
      cwd: () => scratchCwd!,
      currentSessionId: () => "not-in-this-dir",
      now: () => Date.now(),
      core: defaultResumeCore(),
    });
    const listArgsStr = `__list ${JSON.stringify({ scope: "all" })}`;
    const listResult = await webList.list(wrCmdFrame("cmd00000000000001", listArgsStr), {
      op: "command",
      name: "resume",
      args: listArgsStr,
    });
    expect(listResult.ok).toBe(true);
    const wire = (listResult.data as { sessions?: ResumeSessionsWire }).sessions!;
    expect(wire.rows.map((r) => r.id)).toContain(mainId);
    expect(wire.rows.map((r) => r.id)).not.toContain(childId);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C5 — SessionManager.open of a missing path (F6): the resume:mismatch basis.
// ---------------------------------------------------------------------------

describe("C5: SessionManager.open(missing path) initialises a NEW empty session at that path (F6)", () => {
  it("open-level: new id, nothing on disk until a message, append materialises OUR path with the NEW header id", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-resume-c5-"));
    try {
      const missing = join(root, "sessions", "deleted-target.jsonl");
      const sm = SessionManager.open(missing);
      expect(existsSync(missing)).toBe(false); // lazy — the open alone writes nothing
      expect(sm.getSessionFile()).toBe(missing); // path-only API: OUR path is kept
      expect(sm.isPersisted()).toBe(true);
      const newId = sm.getSessionId();
      expect(typeof newId).toBe("string");
      expect(newId.length).toBeGreaterThan(0);
      expect(RESTORE_SESSION_ID_RE.test(newId)).toBe(true); // a fresh valid id — never the
      // deleted target's, which is exactly why withSession's id check reports resume:mismatch.

      sm.appendMessage(userMsg("after deletion"));
      expect(existsSync(missing)).toBe(true); // materialised AT our path…
      const header = JSON.parse(readFileSync(missing, "utf8").split("\n", 1)[0]!) as {
        type: string;
        id: string;
      };
      expect(header.type).toBe("session");
      expect(header.id).toBe(newId); // …carrying the NEW id (pi adopted a different session)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("runtime-level: switchSession to a deleted path completes cancelled:false onto a session whose id ≠ the target's", async () => {
    const rec: Recorder = { order: [], starts: [], shutdowns: [] };
    await withRuntimeSession(
      {
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "boot done") }],
        extensionFactories: [recorderExtension(rec)],
      },
      async ({ session, runtime, sessionDir }) => {
        await session.prompt("boot hello");
        const beforeId = session.sessionManager.getSessionId();
        // the file pi is handed does not exist (the W1/file-gone race end-state)
        const gone = join(sessionDir, "gone-during-switch.jsonl");
        const rc = await runtime.switchSession(gone);
        expect(rc).toEqual({ cancelled: false }); // pi does NOT refuse — it adopts a new session
        const afterId = runtime.session.sessionManager.getSessionId();
        expect(afterId).not.toBe(beforeId);
        expect(runtime.session.sessionManager.getSessionFile()).toBe(gone);
        expect(existsSync(gone)).toBe(false); // still lazy: nothing written yet
        const resume = rec.starts.find((s) => s.reason === "resume");
        expect(resume).toBeDefined(); // a session_start fired on the new (empty) session
      },
    );
  }, 60_000);
});
