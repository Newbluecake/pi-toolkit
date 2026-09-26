/**
 * hub composition root (plan §1.4.2 / §1.3.3 / §3.1 — frozen interface, S1-W1
 * 接口包). Wires singleton → registry → history → agent server → injected
 * HTTP frontend (never imports http.ts: package C is passed in as a
 * `FrontendFactory`), then writes hub.json atomically once the socket and
 * HTTP both listen. `close()` is idempotent and bounded.
 *
 * Startup cancellation chain (§3.1): a single `AbortController` (`startup`)
 * covers steps ①–⑦; `HUB_START_DEADLINE_MS` aborts it. Every step is wrapped
 * in `withSignal` so `startHub` itself always settles within the deadline
 * regardless of how slow an individual step (or an injected test double) is;
 * each step is independently responsible for noticing the abort once its own
 * work eventually completes and cleaning up after itself (`acquireSingleton`'s
 * `SingletonDeps.signal`, `HttpFrontend.listen`'s `opts.signal`). On any
 * failure — including the deadline — already-created resources are released
 * in reverse order via `cleanup`, then `rootScope.dispose()` runs before the
 * error is (re-)thrown.
 *
 * The listening socket server stays ref'd (the hub is meant to live until the
 * idle monitor fires); every timer here is unref'd.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LanStatus } from "../protocol/lan.js";
import { ensurePrivateDir, resolveHubPaths, type HubPaths, type SocketIdentity } from "../protocol/paths.js";
import { PROTO } from "../protocol/version.js";
import { createAgentServer } from "./agent-server.js";
import { createHistoryService } from "./history.js";
import { createHubJsonWriter, type HubJsonWriter, type HubRecord } from "./hub-json.js";
import { createIdleMonitor } from "./idle.js";
import { withDeadline, withSignal, createScope, type Scope } from "./lifecycle.js";
import { createHubLog } from "./log.js";
import { defaultLanAssembly } from "./lan-assembly.js";
import type {
  FrontendFactory,
  HttpFrontend,
  HubConfig,
  HubInfo,
  HubLog,
  LanAssembly,
  LanFrontendDeps,
} from "./ports.js";
import type { FsDeps } from "../protocol/paths.js";
import { createRegistry } from "./registry.js";
import { acquireSingleton, startFence } from "./singleton.js";

export interface RunningHub {
  paths: HubPaths;
  httpPort: number;
  info: HubInfo;
  identity: SocketIdentity;
  lan?: import("./ports.js").LanFacade;
  lanStatus(): LanStatus | undefined;
  close(reason: string): Promise<void>;
  readonly closed: Promise<string>;
}

export const REGISTRY_TICK_MS = 5_000;
/** Overall startup cancellation budget (§3.1); a single `AbortController` covers steps ①–⑦. */
export const HUB_START_DEADLINE_MS = 20_000;
/** Overall shutdown budget (§3.1); individual steps still use the smaller `STEP_DEADLINE_MS`. */
export const HUB_CLOSE_DEADLINE_MS = 10_000;
/** Per-step bound for cleanup/close steps; kept separate from the crash-only hard exit in `installProcessHandlers`. */
const STEP_DEADLINE_MS = 3_000;

export interface StartHubDeps {
  now?: () => number;
  uid?: number;
  xdgRuntimeDir?: string;
  fs?: Partial<FsDeps> | undefined;
  /** Default: `defaultLanAssembly` (throws `E_NOT_IMPLEMENTED:LD` — W1 stub). */
  lanAssembly?: LanAssembly;
  /** Set by `main.ts` when `parseHubLanConfig` rejects `config.lan`; mutually exclusive with `config.lan`. */
  lanConfigError?: { detail: string };
}

export async function startHub(
  config: HubConfig,
  frontend: FrontendFactory,
  deps: StartHubDeps = {},
): Promise<RunningHub | { exists: true }> {
  if (config.lan !== undefined && deps.lanConfigError !== undefined) {
    throw new Error("web-hub: startHub received both config.lan and deps.lanConfigError");
  }
  const now = deps.now ?? Date.now;
  const startup = new AbortController(); // ① startup scope: the sole cancellation source
  const startTimer = setTimeout(() => startup.abort(new Error("web-hub: start timeout")), HUB_START_DEADLINE_MS);
  startTimer.unref();
  const paths = resolveHubPaths({
    home: config.home,
    uid: deps.uid ?? process.getuid?.() ?? 0,
    xdgRuntimeDir: deps.xdgRuntimeDir ?? process.env["XDG_RUNTIME_DIR"],
  });
  const log = createHubLog(paths.logFile);
  const rootScope: Scope = createScope({ log, now }); // ③ hub-lifetime scope
  const cleanup: Array<() => Promise<void>> = []; // executed in reverse on failure, each bounded

  try {
    await withSignal(ensurePrivateDir(paths.stateDir, paths.policies.stateDir, deps.fs), startup.signal); // ②

    const single = await withSignal(
      acquireSingleton(paths, { now, fs: deps.fs, signal: startup.signal }), // ④
      startup.signal,
    );
    if (single.kind === "exists") {
      clearTimeout(startTimer);
      log.info("hub already running", single.hubPid === undefined ? {} : { hubPid: single.hubPid });
      log.close();
      await rootScope.dispose();
      return { exists: true };
    }
    if (single.kind === "failed") throw new Error(`web-hub: ${single.error}`);
    const owner = single; // narrow once here; closures defined below (e.g. `close`) don't retain flow narrowing
    cleanup.push(() => owner.release());

    const registry = createRegistry({ now, log, hubVersion: config.pluginVersion });
    const history = createHistoryService({ registry, log });
    cleanup.push(async () => history.dispose());
    let httpPort = 0;
    const agentServer = createAgentServer(owner.server, { registry, config, log, now, httpPort: () => httpPort });
    cleanup.push(() => agentServer.close());

    const info: HubInfo = {
      version: config.pluginVersion,
      buildId: config.buildId,
      pid: process.pid,
      startedAt: now(),
      proto: PROTO,
    };
    const hubJson: HubJsonWriter = createHubJsonWriter(paths.hubJson, log);

    let lanDeps: LanFrontendDeps | undefined;
    if (config.lan !== undefined) {
      lanDeps = await withSignal(
        (deps.lanAssembly ?? defaultLanAssembly).build({
          cfg: config.lan,
          paths,
          log,
          now,
          scope: rootScope.child(),
          onStatus: (s) => hubJson.patchLan(s),
        }), // ⑤
        startup.signal,
      );
    }

    const fe = frontend({
      config,
      paths,
      registry,
      bus: registry.bus,
      history,
      log,
      info: () => info,
      now,
      ...(lanDeps === undefined ? {} : { lan: lanDeps }),
    });
    cleanup.push(() => fe.close());

    httpPort = (await withSignal(fe.listen({ signal: startup.signal }), startup.signal)).port; // ⑥

    const initialLan: LanStatus | undefined =
      deps.lanConfigError !== undefined
        ? { state: "off", reason: "bad-config", detail: deps.lanConfigError.detail }
        : fe.lan !== undefined
          ? { state: "starting" }
          : undefined;
    hubJson.write({
      pid: process.pid,
      nonce: randomBytes(12).toString("base64url"),
      version: config.pluginVersion,
      buildId: config.buildId,
      proto: PROTO,
      socket: paths.socketPath,
      port: httpPort,
      startedAt: info.startedAt,
      ...(await withSignal(identityFields(), startup.signal)),
      ...(initialLan === undefined ? {} : { lan: initialLan }),
    }); // ⑦

    clearTimeout(startTimer); // startup complete; further cancellation is close()'s job
    if (fe.lan !== undefined) {
      void fe.lan.start().then(
        (s) => hubJson.patchLan(s),
        (err: unknown) => hubJson.patchLan({ state: "off", reason: "timeout", detail: String(err) }),
      );
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

    const stopFence = startFence(paths.socketPath, owner.identity, (why) => {
      log.warn("socket fence lost: another hub owns the socket path", { why });
      void close("fence");
    });

    const idle = createIdleMonitor({
      counts: () => ({
        agents: Math.max(agentServer.connectionCount(), registry.list().length),
        sse: fe.clientCount(),
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
      const inner = (async (): Promise<void> => {
        log.info("hub closing", { reason });
        stopFence();
        idle.stop();
        clearInterval(tick);
        await bounded(fe.close());
        history.dispose();
        await bounded(agentServer.close());
        await bounded(rootScope.dispose());
        await bounded(owner.release());
        hubJson.removeIfOurs();
        log.info("hub closed", { reason });
        log.close();
        resolveClosed(reason);
      })();
      closing = withDeadline(inner, HUB_CLOSE_DEADLINE_MS).catch((err: unknown) => {
        log.error("web-hub: hub close exceeded deadline", { error: String(err) });
        process.exit(1);
      });
      return closing;
    }

    return {
      paths,
      httpPort,
      info,
      identity: owner.identity,
      ...(fe.lan === undefined ? {} : { lan: fe.lan }),
      lanStatus: () => hubJson.current()?.lan,
      close,
      closed,
    };
  } catch (err) {
    clearTimeout(startTimer);
    for (const step of cleanup.reverse()) await bounded(step()); // ⑧ reverse-order release of created resources
    await bounded(rootScope.dispose());
    log.close();
    throw err instanceof Error ? err : new Error(String(err));
  }
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
    // Crash-only hard exit stays at 3s (not unified with HUB_CLOSE_DEADLINE_MS, plan v8 §15.7 #6):
    // process state is untrusted after an uncaughtException, so a fast respawn beats a full cleanup.
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

/** Linux: field 22 (1-indexed) of `/proc/self/stat`; other platforms return `{}` (no identity fields). */
async function identityFields(): Promise<Pick<HubRecord, "procStartTicks" | "argv">> {
  if (process.platform !== "linux") return {};
  try {
    const stat = await readFile("/proc/self/stat", "utf8");
    const afterComm = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    // Fields after `pid (comm)`: state(0) ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5) flags(6)
    // minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12) cutime(13) cstime(14)
    // priority(15) nice(16) num_threads(17) itrealvalue(18) starttime(19) — field 22 overall.
    const raw = afterComm[19];
    const procStartTicks = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(procStartTicks)) return {};
    return { procStartTicks, argv: process.argv.slice() };
  } catch {
    return {};
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
