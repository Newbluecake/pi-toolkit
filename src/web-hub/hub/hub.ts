/**
 * hub composition root (plan §包 B). Wires singleton → registry → history →
 * agent server → injected HTTP frontend (never imports http.ts: package C is
 * passed in as a `FrontendFactory`), then writes hub.json atomically once the
 * socket and HTTP both listen. `close()` is idempotent and bounded.
 *
 * The listening socket server stays ref'd (the hub is meant to live until the
 * idle monitor fires); every timer here is unref'd.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { ensurePrivateDir, resolveHubPaths, type HubPaths } from "../protocol/paths.js";
import { PROTO } from "../protocol/version.js";
import { createAgentServer } from "./agent-server.js";
import { createHistoryService } from "./history.js";
import { createIdleMonitor } from "./idle.js";
import { createHubLog } from "./log.js";
import type { FrontendFactory, HttpFrontend, HubConfig, HubInfo, HubLog } from "./ports.js";
import { createRegistry } from "./registry.js";
import { acquireSingleton, startFence } from "./singleton.js";

export interface RunningHub {
  paths: HubPaths;
  httpPort: number;
  info: HubInfo;
  close(reason: string): Promise<void>;
  readonly closed: Promise<string>;
}

export const REGISTRY_TICK_MS = 5_000;
const STEP_DEADLINE_MS = 3_000;

export async function startHub(
  config: HubConfig,
  frontend: FrontendFactory,
  deps?: { now?: () => number; uid?: number; xdgRuntimeDir?: string },
): Promise<RunningHub | { exists: true }> {
  const now = deps?.now ?? Date.now;
  const paths = resolveHubPaths({
    home: config.home,
    uid: deps?.uid ?? process.getuid?.() ?? 0,
    xdgRuntimeDir: deps?.xdgRuntimeDir ?? process.env["XDG_RUNTIME_DIR"],
  });
  ensurePrivateDir(paths.stateDir);
  const log = createHubLog(paths.logFile);

  const single = await acquireSingleton(paths, { now });
  if (single.kind === "exists") {
    log.info("hub already running", single.hubPid === undefined ? {} : { hubPid: single.hubPid });
    log.close();
    return { exists: true };
  }
  if (single.kind === "failed") {
    log.error("singleton acquisition failed", { error: single.error });
    log.close();
    throw new Error(`web-hub: ${single.error}`);
  }

  const registry = createRegistry({ now, log, hubVersion: config.pluginVersion });
  const history = createHistoryService({ registry, log });
  let httpPort = 0;
  const agentServer = createAgentServer(single.server, { registry, config, log, now, httpPort: () => httpPort });
  const info: HubInfo = {
    version: config.pluginVersion,
    buildId: config.buildId,
    pid: process.pid,
    startedAt: now(),
    proto: PROTO,
  };

  let fe: HttpFrontend | undefined;
  try {
    fe = frontend({
      config,
      paths,
      registry,
      bus: registry.bus,
      history,
      log,
      info: () => info,
      now,
    });
    httpPort = (await fe.listen()).port;
  } catch (err) {
    log.error("http frontend failed to start", { error: String(err) });
    if (fe !== undefined) await bounded(fe.close());
    history.dispose();
    await bounded(agentServer.close());
    await single.release();
    log.close();
    throw err instanceof Error ? err : new Error(String(err));
  }
  const frontendRef = fe;

  const nonce = randomBytes(12).toString("base64url");
  try {
    writeHubJson(paths.hubJson, {
      pid: process.pid,
      nonce,
      version: config.pluginVersion,
      buildId: config.buildId,
      proto: PROTO,
      socket: paths.socketPath,
      port: httpPort,
      startedAt: info.startedAt,
    });
  } catch (err) {
    log.error("hub.json write failed", { error: String(err) });
  }
  log.info("hub started", { pid: process.pid, port: httpPort, socket: paths.socketPath, version: info.version });

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | undefined;

  const tick = setInterval(() => {
    try {
      registry.tick(now());
    } catch (err) {
      log.error("registry tick threw", { error: String(err) });
    }
  }, REGISTRY_TICK_MS);
  tick.unref();

  const stopFence = startFence(paths.socketPath, single.inode, () => {
    log.warn("socket fence lost: another hub owns the socket path");
    void close("fence");
  });

  const idle = createIdleMonitor({
    counts: () => ({
      agents: Math.max(agentServer.connectionCount(), registry.list().length),
      sse: frontendRef.clientCount(),
      headless: 0,
    }),
    idleMs: Math.max(1, config.idleExitMinutes) * 60_000,
    now,
    onIdle: () => {
      log.info("idle timeout reached");
      void close("idle");
    },
  });

  function close(reason: string): Promise<void> {
    if (closing !== undefined) return closing;
    closing = (async () => {
      log.info("hub closing", { reason });
      idle.stop();
      stopFence();
      clearInterval(tick);
      history.dispose();
      await bounded(frontendRef.close());
      await bounded(agentServer.close());
      await bounded(single.kind === "owner" ? single.release() : Promise.resolve());
      removeHubJsonIfOurs(paths.hubJson);
      log.info("hub closed", { reason });
      log.close();
      resolveClosed(reason);
    })();
    return closing;
  }

  return { paths, httpPort, info, close, closed };
}

/**
 * Process-level handlers for the hub process (installed by main.ts): SIGTERM /
 * SIGINT ⇒ `close("signal")`; uncaughtException ⇒ log, `close("crash")`,
 * `process.exit(1)` (bounded by a deadline). Returns an uninstaller.
 */
export function installProcessHandlers(hub: RunningHub, log: HubLog): () => void {
  const onSignal = (sig: NodeJS.Signals): void => {
    log.info("signal received", { signal: sig });
    void hub.close("signal");
  };
  const onCrash = (err: unknown): void => {
    log.error("uncaught exception", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    const force = setTimeout(() => process.exit(1), STEP_DEADLINE_MS);
    force.unref();
    void hub.close("crash").finally(() => process.exit(1));
  };
  const onRejection = (reason: unknown): void => {
    log.error("unhandled rejection", { error: String(reason) });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("uncaughtException", onCrash);
    process.removeListener("unhandledRejection", onRejection);
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function writeHubJson(file: string, content: object): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function removeHubJsonIfOurs(file: string): void {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    if (parsed.pid === process.pid) unlinkSync(file);
  } catch {
    // missing / foreign / corrupt: leave it
  }
}

function bounded(p: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STEP_DEADLINE_MS);
    timer.unref();
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
