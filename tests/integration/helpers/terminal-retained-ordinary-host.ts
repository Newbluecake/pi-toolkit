/** Independent ordinary O test host. Its runtime is compiled from UNPATCHED O7239.
 * Exposes only start port/session ID and normal shutdown, no owner/resource/ACK
 * facts, maintenanceSnapshot, drain assertion or live-constructor capability. */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
export async function runOrdinaryTerminalHost(runtime: any) {
  let hub: any,
    session: any,
    deps: any,
    ownerPromise: Promise<any> | undefined,
    closing = false;
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      closing = true;
      // Normal hub shutdown withdraws the old control channel BEFORE normal agent
      // disposal. No fake ACK/drain, signal, inspector or cleanup proof is supplied.
      if (hub) await hub.close("ordinary-maintenance");
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      if (ownerPromise) await (await ownerPromise).dispose();
    })());
  process.once("disconnect", () => {
    const timer = setTimeout(() => process.exit(75), 12000);
    timer.unref();
    void stop().then(
      () => process.exit(0),
      () => process.exit(75),
    );
  });
  process.on("message", (raw: any) => {
    void (async () => {
      let phase = "START";
      try {
        if (raw.op === "stop") {
          await stop();
          process.send?.({ rid: raw.rid, ok: true, stopped: true }, () => process.exit(0));
          return;
        }
        if (raw.op === "public-scope" && deps && !closing) {
          const target = deps.registry
            .list()
            .find((agent: any) => agent.session?.sessionId === raw.sessionId && agent.status?.terminalSession);
          process.send?.({
            rid: raw.rid,
            ok: true,
            ...(target
              ? { scope: { agentKey: target.agentKey, sessionId: target.session.sessionId, epoch: target.epoch } }
              : {}),
          });
          return;
        }
        if (raw.op !== "start" || hub || session || closing) throw new Error("ordinary host state");
        const { home, fixture, socketDir } = raw,
          agentDir = join(home, ".pi/agent");
        process.env.HOME = home;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
        const setting = JSON.parse(readFileSync(join(agentDir, "pi-toolkit.json"), "utf8"));
        const policy = runtime.parseTerminalPolicy(setting);
        const expectTerminal = raw.expectTerminal !== false;
        if (policy.state === "unavailable" || (expectTerminal && policy.state !== "enabled"))
          throw new Error("ordinary terminal policy");
        const terminalSettings = policy.state === "enabled" ? { enabled: true, ...policy.policy } : { enabled: false };
        phase = "HUB";
        if (!raw.agentOnly)
          hub = await runtime.startHub(
            {
              v: 1,
              home,
              port: 0,
              idleExitMinutes: 10,
              privacy: true,
              pluginVersion: "0.12.2",
              buildId: "ordinary-O7239-unpatched",
            },
            (current: any) => {
              deps = current;
              return runtime.createHttpFrontend(current);
            },
            { xdgRuntimeDir: socketDir },
          );
        if (!raw.agentOnly && (!hub || !("httpPort" in hub))) throw new Error("ordinary hub start refused");
        let sessionId: string | undefined;
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd: fixture.cwd,
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
                settings: { ...runtime.defaults, ...setting.webHub, terminal: terminalSettings },
                terminalTrust: { domain: "plain", isChild: false },
                terminalGuard: (ctx: any) => !closing && ctx.mode === "rpc",
                fleet: () => [],
                paths: runtime.resolveHubPaths({ home, uid: process.getuid!(), xdgRuntimeDir: socketDir }),
                env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_WEBHUB_TERMINAL_SOURCE: "plain" },
                argv1: process.argv[1],
                buildInfo: async () => ({ pluginVersion: "0.12.2", buildId: "ordinary-O7239-unpatched" }),
                terminalOwnerFactory: (options: any) => {
                  if (closing || ownerPromise) throw new Error("ordinary owner state");
                  return (ownerPromise = runtime.createTerminalOwner({
                    ...options,
                    backend: (options: any) => runtime.createTerminalTestBackend(options, fixture),
                  }));
                },
              });
              api.on("session_start", (_event, ctx) => {
                sessionId = ctx.sessionManager.getSessionId();
              });
            },
          ],
        });
        phase = "SDK_LOAD";
        await loader.reload();
        if (loader.getExtensions().errors.length) throw new Error("ordinary SDK load");
        const modelRuntime = await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
        });
        phase = "MANAGER";
        const sessionDir = join(agentDir, "sessions");
        mkdirSync(sessionDir, { mode: 0o700, recursive: true });
        const manager = SessionManager.create(fixture.cwd, sessionDir);
        manager.appendMessage({
          role: "user",
          content: "Owned ordinary O terminal fixture; no model invocation.",
          timestamp: Date.now(),
        });
        phase = "SDK_CREATE";
        const created = await createAgentSession({
          cwd: fixture.cwd,
          agentDir,
          model: getModel("anthropic", "claude-sonnet-4-5"),
          modelRuntime,
          resourceLoader: loader,
          settingsManager,
          sessionManager: manager,
          tools: [],
        });
        session = created.session;
        phase = "SDK_BIND";
        await session.bindExtensions({ mode: "rpc" });
        if (raw.agentOnly) {
          process.send?.({ rid: raw.rid, ok: true, sessionId, sessionFile: manager.getSessionFile() });
          return;
        }
        phase = "DECLARE";
        const deadline = Date.now() + 8000;
        let target: any;
        while (Date.now() < deadline) {
          target = deps.registry
            .list()
            .find(
              (agent: any) =>
                agent.session?.sessionId === sessionId &&
                (expectTerminal ? agent.status?.terminalSession : !!agent.status),
            );
          if (target) break;
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 25);
            t.unref();
          });
        }
        if (!target) throw new Error("ordinary declaration deadline");
        process.send?.({
          rid: raw.rid,
          ok: true,
          port: hub.httpPort,
          caps: hub.info.caps ?? [],
          terminalDeclared: !!target.status?.terminalSession,
          sessionFile: manager.getSessionFile(),
          scope: { agentKey: target.agentKey, sessionId, epoch: target.epoch },
        });
      } catch {
        process.send?.({ rid: raw.rid, ok: false, error: `E_ORDINARY_HOST_${phase}` });
      }
    })();
  });
}
