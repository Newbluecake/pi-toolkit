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
import { PROTO, P2_HUB_CAPS, UPLOAD_HUB_CAPS } from "../protocol/version.js";
import { createAdminHandler, recoverRotateIntent, type RotateRecoveryOutcome } from "./admin.js";
import { createAgentServer } from "./agent-server.js";
import { createCommandRouter } from "./commands.js";
import { createSupersede, SUPERSEDE_YIELD_MS, type SupersedeController } from "./supersede.js";
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

    let supersede: SupersedeController | undefined;
    let recoverRotateOnHello: (() => void) | undefined;
    const registry = createRegistry({
      now,
      log,
      hubVersion: config.pluginVersion,
      onVersion: (pluginVersion, agentKey) => supersede?.observe(pluginVersion, agentKey),
      onTick: () => supersede?.tick(),
    });
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
      shutdown: (reason) => {
        // acc32-B6: only the NEW `reason:"stop"` protocol value maps to the dedicated "hub 已由
        // 终端停止" banner — `info.state` used to only ever get set by the supersede path
        // (`restart` below), so the stop path left it `undefined` and never broadcast anything,
        // meaning a still-connected browser only ever saw the SSE connection drop (the generic
        // "reconnecting" copy) with no way to distinguish an intentional stop from a network
        // blip. `reason:"restart"` (old-agent `ctl.v1` fallback, or a real `/webhub restart`) is
        // deliberately left alone — it is expected to bounce right back up.
        if (reason === "stop") {
          info.state = "stopping";
          registry.publish({ type: "hub" });
        }
        void close(reason);
      },
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
      // C10/C8: every hello is also a rotate-intent recovery opportunity. The
      // callback is assigned before the first listener can accept a connection.
      onHello: () => recoverRotateOnHello?.(),
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
      // web-hub-upload plan §5.1: hub also advertises UPLOAD_HUB_CAPS alongside P2_HUB_CAPS, on
      // both this browser-facing frame and hello_ack (agent-server.ts) — kept byte-identical.
      caps: [...admin.caps(), ...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS],
    };
    const hubJson: HubJsonWriter = createHubJsonWriter(paths.hubJson, log);

    let lanDeps: LanFrontendDeps | undefined;
    // §4.1's recognized db-open failures degrade to loopback-only (never fail the whole hub) —
    // `LanAssemblyOffError` is `defaultLanAssembly`'s (LD's own file) way of saying exactly that;
    // any other rejection (a real bug, an injected test double's `E_NOT_IMPLEMENTED:LD`, …) still
    // propagates to this function's own outer `catch` below and fails `startHub` as before.
    let lanAssemblyOff: { reason: LanOffReason; detail?: string } | undefined;
    let kdfInFlight = 0;
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
    if (lanDeps !== undefined) {
      // KDF work is not part of the command router's in-flight counter, but it
      // must keep the quiet replacement path from cutting across a login.
      const originalKdfRun = lanDeps.kdf.run;
      lanDeps.kdf.run = (...args: Parameters<typeof originalKdfRun>) => {
        kdfInFlight++;
        try {
          return Promise.resolve(originalKdfRun(...args)).finally(() => {
            kdfInFlight = Math.max(0, kdfInFlight - 1);
          });
        } catch (err) {
          kdfInFlight = Math.max(0, kdfInFlight - 1);
          throw err;
        }
      };
    }

    // §6.7.1 (C8) — "意图恢复是 hub 启动的第一步": before `auth.token()`'s first real call (inside
    // `fe.listen()`), before `fe.lan.start()`, before the first `hubJson.write()` — synchronously
    // finish whichever half of a previous rotation didn't complete before a crash. `hasLan` here
    // must NOT be gated on `lanAssemblyOff === undefined` (acc32-B7): a store that failed to open
    // (e.g. `db-invalid` from a `chmod 000` on `hub.db`) may still hold real, unrevoked LAN
    // session rows from before the fault — treating that as "no LAN, nothing to revoke" let the
    // rotate intent get deleted while those rows stayed live, so once the DB fault cleared and the
    // hub restarted, the pre-rotation sessions were still valid (200s, `sessions` rows unchanged).
    // Passing `hasLan:true` here with `revokeLanForRecovery` left `undefined` (below) routes
    // through `recoverRotateIntent`'s own `deps.revokeLan === undefined` branch, which already
    // does the right fail-closed thing: `lanBlocked:true`, intent kept on disk for the next pass.
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
        hasLan: config.lan !== undefined,
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

    const commandRouter = createCommandRouter({ registry, log, now });
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
      commands: commandRouter,
      ...(lanDeps === undefined ? {} : { lan: lanDeps }),
    });
    cleanup.push(() => fe.close());
    // §6.7.1: "恢复后无条件 auth.reload()，双保险" — cheap even when nothing was recovered (the very
    // next real call is `auth.token()` inside `fe.listen()` below, so there is nothing cached yet
    // in the startup path; this still matters once the periodic scan reuses the same helper).
    (fe as HttpFrontendExt).auth?.reload();

    // C10: assemble version replacement only after the command router and
    // frontend exist; agents cannot hello before listen() below completes.
    // Cancel handles for in-flight acc32-B9 dialogs-handshake waits — drained on close/dispose
    // so a pending one-shot bus subscription never outlives the hub.
    const supersedeWaitCancels = new Set<() => void>();
    supersede = createSupersede({
      hubVersion: config.pluginVersion,
      now,
      ...(paths.stoppedFile === undefined ? {} : { stopFile: paths.stoppedFile }),
      openDialogs: () =>
        registry.list().flatMap((a) => {
          const dialogs = a.dialogs as { open?: unknown[] } | null | undefined;
          const count = dialogs?.open?.length ?? 0;
          return count === 0 ? [] : [{ agentKey: a.agentKey, count }];
        }),
      inflight: () => commandRouter.inflight(),
      kdfInflight: () => kdfInFlight,
      // acc32-B9: a reliable handshake for the first quiet judgment after a hello — resolve
      // immediately if the registry already has *any* dialogs snapshot for this agent (a
      // reclaimed/reconnected Rec whose `dialogs` field survived the reconnect, §registry.ts
      // `register()`'s reclaim branch never touches it), otherwise wait for the one-shot
      // `dialogs` bus event for this exact `agentKey` or the bounded timeout, whichever is first.
      awaitDialogsSlot: (agentKey, timeoutMs) => {
        if (registry.get(agentKey)?.dialogs !== undefined) return Promise.resolve();
        return new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            supersedeWaitCancels.delete(finish);
            clearTimeout(timer);
            unsubscribe();
            resolve();
          };
          // Registered so hub close/dispose can cancel a still-pending handshake wait
          // immediately instead of leaking the bus subscription until the timeout fires.
          supersedeWaitCancels.add(finish);
          const unsubscribe = registry.bus.subscribe((e) => {
            if (e.type === "dialogs" && e.agentKey === agentKey) finish();
          });
          const timer = setTimeout(finish, timeoutMs);
          timer.unref();
        });
      },
      stateChanged: (s) => {
        if (s === undefined) {
          delete info.state;
          delete info.nextVersion;
          info.supersedePending = false;
          delete info.supersedeDeadlineAt;
          delete info.forced;
          delete info.draining;
          delete info.supersedeBlocked;
        } else {
          info.supersedePending = true;
          info.nextVersion = s.nextVersion;
          info.supersedeDeadlineAt = s.deadlineAt;
          if (s.forced === true) info.forced = true;
          if (s.blocked !== undefined) info.supersedeBlocked = s.blocked;
          else delete info.supersedeBlocked;
        }
      },
      audit: (op, fields) => log.info("web-hub admin op", { audit: "admin", op, ...fields }),
      log,
      restart: async ({ nextVersion, forced, openDialogs, inflightAtDrain }) => {
        info.state = "restarting";
        info.nextVersion = nextVersion;
        info.supersedePending = true;
        info.forced = forced;
        info.draining = forced;
        if (forced) {
          const drained = await commandRouter.drain();
          info.draining = false;
          // §6.7.3's audit row carries `drainTimedOut` — folded into the SAME tagged audit
          // channel (`audit:"admin"`), emitted here because the controller's begin()-time audit
          // necessarily precedes the drain (C10 verifier finding).
          log.info("web-hub admin op", {
            audit: "admin",
            op: "supersede",
            phase: "drain",
            nextVersion,
            forced,
            inflightAtDrain,
            drainTimedOut: drained.timedOut,
            inflight: drained.inflight,
          });
        }
        const openByAgent = new Map(openDialogs.map((x) => [x.agentKey, x.count]));
        registry.broadcast((agentKey) => {
          const count = openByAgent.get(agentKey) ?? 0;
          return {
            t: "superseded",
            nextVersion,
            yieldMs: SUPERSEDE_YIELD_MS,
            ...(forced ? { forced: true as const } : {}),
            ...(count > 0 ? { openDialogs: count } : {}),
          };
        });
        await close("superseded");
      },
    });
    const supersedeTimer = setInterval(() => supersede?.tick(), 250);
    supersedeTimer.unref();
    // acc32-B9 defense in depth: re-check quiet immediately whenever a `dialogs` slot changes
    // (a dialog opening OR closing), rather than relying solely on the 250ms periodic tick —
    // this is on top of (not instead of) `observe()`'s own deferred first check above.
    const unsubscribeSupersedeOnDialogs = registry.bus.subscribe((e) => {
      if (e.type === "dialogs") supersede?.tick();
    });
    cleanup.push(async () => {
      unsubscribeSupersedeOnDialogs();
      clearInterval(supersedeTimer);
      for (const cancel of [...supersedeWaitCancels]) cancel();
      supersede?.dispose();
    });
    const scanRotateIntent = async (): Promise<void> => {
      const revokeLan =
        lanDeps === undefined
          ? undefined
          : async (): Promise<number> => (await (lanDeps!.store as Partial<LanStore>).revokeAllSessions?.()) ?? 0;
      const outcome = await recoverRotateIntent({
        paths: {
          tokenFile: paths.tokenFile,
          rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
        },
        log,
        // acc32-B7: same fix as the startup pass above — `hasLan` must not fold in whether LAN
        // assembly ever succeeded (`lanDeps !== undefined`); a still-unopened store still needs
        // `revokeLan === undefined` to reach `recoverRotateIntent`'s own fail-closed branch rather
        // than being masked as "no LAN configured".
        hasLan: config.lan !== undefined,
        ...(revokeLan === undefined ? {} : { revokeLan }),
        now,
        audit: (fields) => log.info("web-hub admin op", { audit: "admin", op: "rotate_token", ...fields }),
      });
      if (!outcome.recovered) return;
      (fe as HttpFrontendExt).auth?.reload();
      (fe as HttpFrontendExt).revokeAllSse?.();
      if (outcome.lanBlocked === true) {
        lanBlockedByRotate = true;
        if (fe.lan !== undefined) {
          lanClosedByRotateScan = true;
          log.warn(
            "web-hub: closing the LAN listener (rotate revoke failed); run /webhub restart to re-open it once the pending rotate completes",
          );
          void fe.lan
            .close()
            .catch((err: unknown) =>
              log.error("web-hub: failed to close LAN listener after rotate revoke failure", { error: String(err) }),
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
        lanBlockedByRotate = false;
        void fe.lan.start().then(
          (s) => hubJson.patchLan(s),
          (err: unknown) =>
            log.error("web-hub: LAN start() (post rotate-pending recovery) rejected unexpectedly", {
              error: String(err),
            }),
        );
      }
    };
    recoverRotateOnHello = () => {
      void scanRotateIntent().catch((err: unknown) =>
        log.error("web-hub: hello rotate-intent scan failed", { error: String(err) }),
      );
    };

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
        : lanBlockedByRotate
          ? // acc32-B7 (verifier r_29729WTC): `rotate-pending` must outrank `lanAssemblyOff` here,
            // not just come after it — a store that failed to open (e.g. `db-invalid`) is exactly
            // the case where `recoverRotateIntent`'s fail-closed revoke also has no store to
            // revoke against, so `lanBlockedByRotate` and `lanAssemblyOff` are routinely BOTH set
            // at once. Checking `lanAssemblyOff` first (the original order) always won that race
            // and reported the (real but less actionable) `db-invalid` reason while masking the
            // fact that a rotation is stuck pending recovery — exactly the security-relevant state
            // §6.7.1 requires `/webhub status` to surface ("lan off · rotate-pending · /webhub
            // restart to retry"). `deps.lanConfigError` stays first: it implies `config.lan ===
            // undefined` (the constructor guard above), so `hasLan` was `false` for the rotate
            // recovery call and `lanBlockedByRotate` can never be true alongside it — no ordering
            // conflict there.
            { state: "off", reason: "rotate-pending" }
          : lanAssemblyOff !== undefined
            ? {
                state: "off",
                reason: lanAssemblyOff.reason,
                ...(lanAssemblyOff.detail === undefined ? {} : { detail: lanAssemblyOff.detail }),
              }
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
    // The same recovery helper is also invoked by agent-server.ts on every
    // successful hello; this timer covers offline rotations and quiet periods.
    const rotateScan = setInterval(() => {
      void scanRotateIntent().catch((err: unknown) =>
        log.error("web-hub: periodic rotate-intent scan failed", { error: String(err) }),
      );
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
        unsubscribeSupersedeOnDialogs();
        for (const cancel of [...supersedeWaitCancels]) cancel();
        supersede?.dispose();
        clearInterval(supersedeTimer);
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
