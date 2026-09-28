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
import type { LanOffReason, LanStatus } from "../protocol/lan.js";
import { ensurePrivateDir, resolveHubPaths, type HubPaths, type SocketIdentity } from "../protocol/paths.js";
import { PROTO, P2_HUB_CAPS } from "../protocol/version.js";
import { createAdminHandler, recoverRotateIntent, type RotateRecoveryOutcome } from "./admin.js";
import { createAgentServer } from "./agent-server.js";
import { createCommandRouter } from "./commands.js";
import { createHistoryService } from "./history.js";
import { createHubJsonWriter, type HubJsonWriter, type HubRecord } from "./hub-json.js";
import { createIdleMonitor } from "./idle.js";
import { withDeadline, withSignal, createScope, type Scope } from "./lifecycle.js";
import { createHubLog } from "./log.js";
import { defaultLanAssembly, LanAssemblyOffError } from "./lan-assembly.js";
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
import type { Auth } from "./auth.js";
import type { LanStore } from "./lan-store.js";

/**
 * §6.7.1 (C8) — the duck-typed extras `http.ts`'s `createHttpFrontend` attaches beyond the
 * frozen `HttpFrontend` shape (same widening pattern as `storeWithUnavailable` in `http.ts`
 * itself): never part of the `HttpFrontend` type, only ever reached through this cast.
 */
type HttpFrontendExt = HttpFrontend & {
  auth?: Auth;
  revokeAllSse?(): number;
  bumpLanRevokeGen?(): void;
};
type LanFacadeExt = NonNullable<HttpFrontend["lan"]> & { revokeAll?(): number };

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
/** \u00a76.7.1 (C8) "hub \u8fd0\u884c\u671f": "\u6bcf 10s\uff08unref\uff09\u4e0e\u6bcf\u6b21 agent hello \u65f6" \u2014 the hello-triggered half
 * lives in `agent-server.ts` (C3's file, out of this package's W3 list); this constant only
 * covers the timer half. */
export const ROTATE_SCAN_MS = 10_000;
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
  // Review fix (LP, §1.3.1): default `FsDeps.onWarn` to the real hub log so the
  // TMP-fallback socket-dir repair's "chmod 0700 + warn" is actually observable in
  // production, not just in tests that inject their own sink. A caller-supplied
  // `deps.fs.onWarn` (tests) still wins — spread order keeps this the default only.
  const fsWithWarn: Partial<FsDeps> = {
    onWarn: (dir, detail) => log.warn("web-hub: private dir repaired", { dir, detail }),
    ...deps.fs,
  };
  const rootScope: Scope = createScope({ log, now }); // ③ hub-lifetime scope
  const cleanup: Array<() => Promise<void>> = []; // executed in reverse on failure, each bounded

  try {
    await withSignal(ensurePrivateDir(paths.stateDir, paths.policies.stateDir, fsWithWarn), startup.signal); // ②

    const single = await withSignal(
      acquireSingleton(paths, { now, fs: fsWithWarn, signal: startup.signal }), // ④
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
    // Admin control plane (plan §8, S1-W3 LD): constructed once, ahead of `lanDeps`/`fe`/`close`
    // (all still `undefined`/not-yet-declared at this point) — every getter below is a closure
    // over this function's own `let`/`const` bindings, read lazily whenever an actual `lan_req`/
    // `hub_ctl` frame arrives (always well after every one of them has settled; `close` is a
    // hoisted function declaration in this same scope, so referencing it here before its textual
    // definition is safe). This is what lets `hello_ack.caps` include `"ctl.v1"` unconditionally
    // and `"lan.v1"` once `config.lan` is set, regardless of whether LAN assembly ever succeeds.
    const admin = createAdminHandler({
      log,
      hasLan: () => config.lan !== undefined,
      store: () => lanDeps?.store,
      kdf: () => lanDeps?.kdf,
      limiter: () => lanDeps?.limiter,
      lan: () => fe.lan,
      lanStatus: () => hubJson.current()?.lan,
      shutdown: (reason) => void close(reason),
      now,
      // §6.7.1 (C8): same lazy-closure pattern as the getters above — `fe`/`lanDeps` aren't
      // declared until further down this same function body, but these closures are only ever
      // invoked later (once an actual `hub_ctl{rotate_token}` frame arrives, always well after
      // startup finishes).
      auth: () => (fe as HttpFrontendExt).auth!,
      rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
      revokeLanSessions: async () => {
        const store = lanDeps?.store as Partial<LanStore> | undefined;
        return (await store?.revokeAllSessions?.()) ?? 0;
      },
      revokeLoopbackSse: () => (fe as HttpFrontendExt).revokeAllSse?.() ?? 0,
      revokeLanSse: () => (fe.lan as LanFacadeExt | undefined)?.revokeAll?.() ?? 0,
      bumpLanRevokeGen: () => (fe as HttpFrontendExt).bumpLanRevokeGen?.(),
    });
    const agentServer = createAgentServer(owner.server, {
      registry,
      config,
      log,
      now,
      httpPort: () => httpPort,
      admin,
    });
    cleanup.push(() => agentServer.close());

    const info: HubInfo = {
      version: config.pluginVersion,
      buildId: config.buildId,
      pid: process.pid,
      startedAt: now(),
      proto: PROTO,
      // C3 (plan §3.1/§6.6): browser-facing capability list (SSE `hub` frame's `caps`,
      // `HubInfo.caps`) always advertises the P2 control-plane capabilities the hub itself now
      // supports, on top of whatever `admin.caps()` reports (`ctl.v1`/`lan.v1`). This now matches
      // `hello_ack.caps` (the agent-facing frame, wired in `agent-server.ts`) byte-for-byte —
      // both are frozen-protocol invariants (§3.1's compat matrix), and agent-side
      // `connection.ts`'s D14 slot gating reads `hello_ack.caps` to decide whether to ever send
      // the `dialogs`/`ctl`/`commands` slots at all.
      caps: [...admin.caps(), ...P2_HUB_CAPS],
    };
    const hubJson: HubJsonWriter = createHubJsonWriter(paths.hubJson, log);

    let lanDeps: LanFrontendDeps | undefined;
    // §4.1's recognized db-open failures degrade to loopback-only (never fail the whole hub) —
    // `LanAssemblyOffError` is `defaultLanAssembly`'s (LD's own file) way of saying exactly that;
    // any other rejection (a real bug, an injected test double's `E_NOT_IMPLEMENTED:LD`, …) still
    // propagates to this function's own outer `catch` below and fails `startHub` as before.
    let lanAssemblyOff: { reason: LanOffReason; detail?: string } | undefined;
    if (config.lan !== undefined) {
      try {
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
      } catch (err) {
        if (err instanceof LanAssemblyOffError) {
          log.warn("web-hub: LAN assembly reported an off status, starting loopback-only", {
            reason: err.reason,
            detail: err.detail,
          });
          lanAssemblyOff = { reason: err.reason, ...(err.detail === undefined ? {} : { detail: err.detail }) };
        } else {
          throw err;
        }
      }
    }

    // §6.7.1 (C8) — "意图恢复是 hub 启动的第一步": before `auth.token()`'s first real call (inside
    // `fe.listen()`), before `fe.lan.start()`, before the first `hubJson.write()` — synchronously
    // finish whichever half of a previous rotation didn't complete before a crash. `hasLan` here
    // is gated on `lanAssemblyOff === undefined` too: a store that never opened has nothing to
    // revoke against, and that (unrelated) off-status already covers the user-visible outcome.
    const revokeLanForRecovery =
      lanDeps !== undefined
        ? async (): Promise<number> => {
            const store = lanDeps!.store as Partial<LanStore>;
            return (await store.revokeAllSessions?.()) ?? 0;
          }
        : undefined;
    const rotateRecovery: RotateRecoveryOutcome = await withSignal(
      recoverRotateIntent({
        paths: {
          tokenFile: paths.tokenFile,
          rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
        },
        log,
        hasLan: config.lan !== undefined && lanAssemblyOff === undefined,
        ...(revokeLanForRecovery === undefined ? {} : { revokeLan: revokeLanForRecovery }),
        now,
        audit: (fields) => log.info("web-hub admin op", { audit: "admin", op: "rotate_token", ...fields }),
      }),
      startup.signal,
    );
    let lanBlockedByRotate = rotateRecovery.lanBlocked === true;
    /** Set when the runtime scan had to close an already-open LAN listener (permanent) — the
     * "previously blocked, now resolved ⇒ start()" path must not try to resurrect it. */
    let lanClosedByRotateScan = false;

    const fe = frontend({
      config,
      paths,
      registry,
      bus: registry.bus,
      history,
      log,
      info: () => info,
      now,
      onUiStatus: (s) => hubJson.patchUi(s),
      // §6.1 (C0 P0 fix): constructed here so the frontend factory can reach it via
      // `FrontendDeps.commands` — today's stub always answers `E_UNSUPPORTED` and is never read
      // §6.1 (C3): the real command router — hub-side idempotent LRU, agent-capability
      // admission, effect classification, queryOnly, drain — replacing C0's always-`E_UNSUPPORTED`
      // stub. `registry` (constructed above) is the same instance the agent socket layer feeds.
      commands: createCommandRouter({ registry, log, now }),
      ...(lanDeps === undefined ? {} : { lan: lanDeps }),
    });
    cleanup.push(() => fe.close());
    // §6.7.1: "恢复后无条件 auth.reload()，双保险" — cheap even when nothing was recovered (the very
    // next real call is `auth.token()` inside `fe.listen()` below, so there is nothing cached yet
    // in the startup path; this still matters once the periodic scan reuses the same helper).
    (fe as HttpFrontendExt).auth?.reload();

    httpPort = (await withSignal(fe.listen({ signal: startup.signal }), startup.signal)).port; // ⑥

    // vue-plan.md v2.1 §2.1（P5b）："启动：hub 在写 hub.json 前 await ui.refresh()（≤3s，超时按未构建
    // 上报、后台继续）" — `refresh()` itself is single-flight and bounded by `UI_ROOT_RESOLVE_TIMEOUT_MS`
    // (ui-root.ts), so this can never itself blow the hub's own `HUB_START_DEADLINE_MS` budget. This
    // first `refresh()` call is also what fires `onUiStatus` for the initial status (wired above), so
    // `hubJson`'s `pendingUi` picks it up before `write()` below even runs (same queue-before-first-
    // write race `lan`'s `onStatus` already relies on, §2.1's "诊断" bullet).
    const initialUi = await withSignal(fe.ui.refresh(), startup.signal);

    const initialLan: LanStatus | undefined =
      deps.lanConfigError !== undefined
        ? { state: "off", reason: "bad-config", detail: deps.lanConfigError.detail }
        : lanAssemblyOff !== undefined
          ? {
              state: "off",
              reason: lanAssemblyOff.reason,
              ...(lanAssemblyOff.detail === undefined ? {} : { detail: lanAssemblyOff.detail }),
            }
          : lanBlockedByRotate
            ? // §6.7.1: "LAN listener 不开放，LanStatus{state:"off", reason:"rotate-pending"}，意图保留，
              // loopback 照常可用" — token is already new (recovery finished ①–② already), only the
              // LAN half of invalidation failed/timed out, so `fe.lan` itself is left intact
              // (the periodic scan calls `start()` once recovery finally succeeds) — only its own
              // `start()` call is skipped this boot.
              { state: "off", reason: "rotate-pending" }
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
      ui: initialUi,
    }); // ⑦

    clearTimeout(startTimer); // startup complete; further cancellation is close()'s job
    if (fe.lan !== undefined && !lanBlockedByRotate) {
      // Review fix (LC, plan §1.4/§3, W3 acceptance item 1/3): `LanFacade.start()` is bounded by
      // its own `LAN_START_DEADLINE_MS` and always *resolves* with a correctly classified
      // `LanStatus` (`off/timeout`, `off/listen-failed`, ...) instead of rejecting for any
      // recognized outcome — mislabeling every rejection here as `timeout` used to hide real
      // causes (e.g. a port conflict) behind the wrong reason. A rejection reaching this handler
      // therefore means something escaped that classification (a genuine bug in `start()` itself),
      // so log it loudly rather than writing a second, silently-wrong guess into `hub.json`.
      void fe.lan.start().then(
        (s) => hubJson.patchLan(s),
        (err: unknown) => {
          log.error("web-hub: LAN start() rejected unexpectedly (not a classified LanStatus)", {
            error: String(err),
          });
          hubJson.patchLan({ state: "off", reason: "listen-failed", detail: String(err) });
        },
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

    // \u00a76.7.1 (C8) "hub \u8fd0\u884c\u671f" row: every `ROTATE_SCAN_MS` (unref), re-run the same
    // recovery helper against whatever is on disk right now \u2014 catches an intent this hub process
    // didn't itself create (the offline agent path, or another hub racing this one), and retries a
    // previously-`lanBlocked` revoke once the LAN store is healthy again. NOTE (delivery report):
    // the plan also asks for a scan on every agent `hello`; that hook lives in `agent-server.ts`
    // (owned by C3, not in this package's W3 file list) and is therefore not wired here \u2014 the
    // 10s cadence below is the only trigger this package can deliver on its own.
    const rotateScan = setInterval(() => {
      const revokeLan =
        lanDeps === undefined
          ? undefined
          : async (): Promise<number> => {
              const store = lanDeps!.store as Partial<LanStore>;
              return (await store.revokeAllSessions?.()) ?? 0;
            };
      void recoverRotateIntent({
        paths: {
          tokenFile: paths.tokenFile,
          rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
        },
        log,
        hasLan: config.lan !== undefined && lanDeps !== undefined,
        ...(revokeLan === undefined ? {} : { revokeLan }),
        now,
        audit: (fields) => log.info("web-hub admin op", { audit: "admin", op: "rotate_token", ...fields }),
      })
        .then((outcome) => {
          if (!outcome.recovered) return;
          (fe as HttpFrontendExt).auth?.reload();
          // §6.7.1 运行期 row (C8 review P1): a rotation this process didn't initiate must
          // invalidate exactly like the online path — already-open loopback SSE streams die
          // (their cookie predates the new token); on the LAN side the SSE sweep + revoke-gen
          // bump mirror `admin.ts`'s ④.
          (fe as HttpFrontendExt).revokeAllSse?.();
          if (outcome.lanBlocked === true) {
            lanBlockedByRotate = true;
            // The listener may already be open from this boot — fail closed. NOTE:
            // `LanFacade.close()` is permanent (no in-process restart), so after the pending
            // rotate completes a `/webhub restart` is required to re-open LAN; the scan keeps
            // retrying the revoke in the meantime (main-session ruling — the plan's "重新 start()"
            // assumed a restartable facade).
            if (fe.lan !== undefined) {
              lanClosedByRotateScan = true;
              log.warn(
                "web-hub: closing the LAN listener (rotate revoke failed); run /webhub restart to re-open it once the pending rotate completes",
              );
              void fe.lan.close().catch((err: unknown) =>
                log.error("web-hub: failed to close LAN listener after rotate revoke failure", {
                  error: String(err),
                }),
              );
            }
            hubJson.patchLan({ state: "off", reason: "rotate-pending" });
            return;
          }
          if (fe.lan !== undefined) {
            (fe.lan as LanFacadeExt | undefined)?.revokeAll?.();
            (fe as HttpFrontendExt).bumpLanRevokeGen?.();
          }
          if (lanBlockedByRotate && fe.lan !== undefined && !lanClosedByRotateScan) {
            // Previously blocked at startup (the listener never opened), now resolved — open it.
            lanBlockedByRotate = false;
            void fe.lan.start().then(
              (s) => hubJson.patchLan(s),
              (err: unknown) => {
                log.error("web-hub: LAN start() (post rotate-pending recovery) rejected unexpectedly", {
                  error: String(err),
                });
              },
            );
          }
        })
        .catch((err: unknown) => {
          log.error("web-hub: periodic rotate-intent scan failed", { error: String(err) });
        });
    }, ROTATE_SCAN_MS);
    rotateScan.unref();

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
        clearInterval(rotateScan);
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
