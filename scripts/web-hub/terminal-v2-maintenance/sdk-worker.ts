/** Internal fixed-artifact child, not a CLI/module loader. One actual pi1.5 SDK host
 * per OS process (O/N Symbol.for runtime state must never share a VM). Only the
 * inherited private IPC parent can request the fixed start/observe/stop/exit lifecycle.
 * No prompt/LLM, discovered extension, arbitrary command, repair or receipt deletion.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TerminalTestFixture } from "../../../src/web-hub/hub/terminal/v2/environment.js";
import { HeldDirectory } from "./files.js";
const config = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
export async function runSdkWorker(runtime: any): Promise<void> {
  if (!process.send || !process.env.T51_PRIVATE_CHANNEL || process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT)
    throw new Error("internal owned IPC required");
  const channel = process.env.T51_PRIVATE_CHANNEL;
  let state: "new" | "live" | "stopped" = "new";
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let owner: any;
  const ownerFactories = new Set<Promise<any>>();
  let ownerFactoryRuns = 0;
  let sdkContext: any;
  let sessionId: string | undefined;
  const send = (rid: string, result: unknown, ok = true) => process.send?.({ channel, rid, ok, result });
  let work = Promise.resolve();
  let stopping: Promise<void> | undefined;
  let closing = false;
  const stop = () => {
    closing = true;
    return (stopping ??= (async () => {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      await Promise.allSettled([...ownerFactories]);
      if (owner) await owner.dispose();
      state = "stopped";
    })());
  };
  // Parent loss cannot strand a controlled SDK/PTY indefinitely. Original cleanup
  // runs; a hard exit is UNKNOWN, never an audit/drain result. Only this owned
  // worker is exited, no unrelated/user process is signalled.
  process.once("disconnect", () => {
    if (state === "stopped") return;
    process.exitCode = 75;
    const timer = setTimeout(() => process.exit(75), 12000);
    timer.unref();
    void stop().then(
      () => clearTimeout(timer),
      () => {
        /* keep unknown hard bound */
      },
    );
  });
  const observe = () => ({
    state,
    pid: process.pid,
    sessionId,
    ownerFactoryFlights: ownerFactories.size,
    ownerFactoryRuns,
    owner: runtime.kind === "old" ? owner?.maintenanceSnapshot() : undefined,
  });
  async function execute(raw: any) {
    if (!raw || raw.channel !== channel || typeof raw.rid !== "string") return;
    const rid = raw.rid;
    try {
      if (raw.op === "observe") {
        send(rid, observe());
        return;
      }
      if (raw.op === "start") {
        if (closing || state !== "new" || session) throw new Error("single SDK host only");
        const { home, cwd, socketDir, fixture } = raw as {
          home: string;
          cwd: string;
          socketDir: string;
          fixture: TerminalTestFixture;
        };
        for (const p of [home, cwd, socketDir]) {
          const held = new HeldDirectory(p);
          held.close();
        }
        if (fixture.home !== home || fixture.cwd !== cwd) throw new Error("owned fixture mismatch");
        const agentDir = join(home, ".pi/agent");
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
          extensionFactories: [
            (api) => {
              runtime.wireWebHub(api, {
                settings: {
                  ...runtime.defaults,
                  enabled: true,
                  autoStart: false,
                  control: true,
                  webCommands: true,
                  terminal: { enabled: true, ...config },
                },
                terminalTrust: { domain: "plain", isChild: false },
                terminalGuard: (ctx: any) => !closing && ctx.mode === "rpc",
                fleet: () => [],
                paths: runtime.resolveHubPaths({ home, uid: process.getuid!(), xdgRuntimeDir: socketDir }),
                env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_WEBHUB_TERMINAL_SOURCE: "plain" },
                argv1: "/nonexistent/controlled-tool-pi",
                buildInfo: async () => ({ pluginVersion: "0.12.2", buildId: "t51-fixed-tool-sdk" }),
                ...(runtime.kind === "old"
                  ? {
                      terminalOwnerFactory: async (options: any) => {
                        if (closing || owner) throw new Error("single live old owner only");
                        ownerFactoryRuns++;
                        const original = runtime.createTerminalOwner({
                          ...options,
                          backend: (options: any) => runtime.createTerminalTestBackend(options, fixture),
                        });
                        ownerFactories.add(original);
                        try {
                          owner = await original;
                          return owner;
                        } finally {
                          ownerFactories.delete(original);
                        }
                      },
                    }
                  : {}),
              });
              api.on("session_start", (_event, ctx) => {
                sdkContext = ctx;
                sessionId = ctx.sessionManager.getSessionId();
              });
            },
          ],
        });
        await loader.reload();
        if (loader.getExtensions().errors.length) throw new Error("private SDK extension load failed");
        const modelRuntime = await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
        });
        const model = getModel("anthropic", "claude-sonnet-4-5");
        if (!model) throw new Error("SDK built-in model missing");
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRuntime,
          resourceLoader: loader,
          settingsManager,
          sessionManager: SessionManager.inMemory(cwd),
          tools: [],
        }));
        if (closing) {
          session.dispose();
          throw new Error("owned parent unavailable");
        }
        await session.bindExtensions({ mode: "rpc" });
        if (closing) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
          throw new Error("owned parent unavailable");
        }
        if (!sdkContext) throw new Error("real SDK context missing");
        state = "live";
        send(rid, observe());
        return;
      }
      if (raw.op === "stop") {
        if (state === "stopped") {
          send(rid, observe());
          return;
        }
        await stop(); // ORIGINAL promises, never inferred from SDK event return.
        send(rid, observe());
        return;
      }
      if (raw.op === "exit" && state === "stopped") {
        send(rid, observe());
        process.disconnect();
        return;
      }
      throw new Error("unsupported internal lifecycle action");
    } catch (error) {
      send(
        rid,
        {
          error: "E_FIXED_WORKER_ACTION",
          state,
          reason: error instanceof Error ? error.name + ": " + error.message : "unknown",
        },
        false,
      );
    }
  }
  process.on("message", (message) => {
    work = work.then(() => execute(message));
  });
}
