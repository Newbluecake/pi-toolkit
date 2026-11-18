/** Actual pi 1.5 SDK event context, no fabricated ExtensionAPI/ExtensionContext.
 * Explicit private ResourceLoader/agentDir/auth paths; no model prompt or credential use. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../../src/config/settings.js";
import { wireWebHub, type WebHubControl } from "../../../src/web-hub/agent/index.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
export async function createTerminalSdkAgent(options: {
  home: string;
  cwd: string;
  socketDir: string;
  version: string;
  /** Actual SDK-created prior session file for migration/restart fixtures. */
  sessionFile?: string;
}) {
  const agentDir = join(options.home, ".pi/agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let context: ExtensionContext | undefined, control: WebHubControl | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (api) => {
        control = wireWebHub(api, {
          settings: {
            ...DEFAULT_SETTINGS.webHub,
            enabled: true,
            autoStart: false,
            control: true,
            webCommands: true,
            terminal: {
              enabled: true,
              maxPerSession: 2,
              maxPerPrincipal: 2,
              maxTotal: 8,
              inputIdleMs: 3600000,
              maxLifetimeMs: 28800000,
            },
          },
          terminalTrust: { domain: "plain", isChild: false },
          terminalGuard: (ctx) => ctx.mode === "rpc",
          fleet: () => [],
          paths: resolveHubPaths({ home: options.home, uid: process.getuid!(), xdgRuntimeDir: options.socketDir }),
          env: { HOME: options.home, PI_CODING_AGENT_DIR: agentDir, PI_WEBHUB_TERMINAL_SOURCE: "plain" },
          argv1: "/nonexistent/private-pi",
          buildInfo: async () => ({ pluginVersion: options.version, buildId: "terminal-v2-real-sdk" }),
        });
        api.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error("isolated SDK extension load failed");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = getModel("anthropic", "claude-sonnet-4-5");
  if (!model) throw new Error("SDK built-in fixture model unavailable");
  const manager = options.sessionFile ? SessionManager.open(options.sessionFile) : SessionManager.inMemory(options.cwd);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: manager,
    tools: [],
  });
  try {
    await session.bindExtensions({ mode: "rpc" });
    if (!context || !control) throw new Error("actual SDK context not delivered");
  } catch (error) {
    session.dispose();
    throw error;
  }
  let closed = false;
  return {
    session,
    manager,
    control: control!,
    get context() {
      return context!;
    },
    async close() {
      if (closed) return;
      closed = true;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}
