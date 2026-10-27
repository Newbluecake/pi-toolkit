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
import { type GitRunner } from "../../git/run.js";
import { resolveAgentDir } from "../protocol/agent-dir.js";
import { FEISHU_SHUTDOWN_BUDGET_MS, type FsbReqFrame } from "../protocol/feishu.js";
import type { LanOffReason, LanStatus } from "../protocol/lan.js";
import type { FsDeps } from "../protocol/paths.js";
import {
  ensurePrivateDir,
  packageRootDir,
  resolveHubPaths,
  type HubPaths,
  type SocketIdentity,
} from "../protocol/paths.js";
import { parseCmdline } from "../protocol/proc-identity.js";
import type { HubUiBuildWire } from "../protocol/version-info.js";
import {
  DIALOG_BG_HUB_CAPS,
  FSB_HUB_CAP,
  HOLD_HUB_CAPS,
  P2_HUB_CAPS,
  PROTO,
  QUOTA_POOLS_HUB_CAPS,
  RUNTX_HUB_CAPS,
  TODO_ARCHIVE_HUB_CAPS,
  UPLOAD_HUB_CAPS,
} from "../protocol/version.js";
import type { XsAliasHubStatus } from "../protocol/xs-alias.js";
import { createAdminHandler, recoverRotateIntent, type RotateRecoveryOutcome } from "./admin.js";
import { createAgentRemoveService } from "./agent-remove.js";
import { createAgentServer } from "./agent-server.js";
import { assembleHubCaps, assembleXsRelay, prepareHubChannels } from "./assembly-channels.js";
import { assembleFeishu } from "./assembly-feishu.js";
import { assemblePreview } from "./assembly-preview.js";
import { assembleRegistry } from "./assembly-registry.js";
import { assembleSupersede, proxyStatusOf, startRuntimeMonitors } from "./assembly-runtime.js";
import { assembleSchedule } from "./assembly-schedule.js";
import { assembleSpawn, spawnStatusOf } from "./assembly-spawn.js";
import { assembleAvatarStore, assembleUploads, loadPrivacyStore } from "./assembly-storage.js";
import { createHubAssembly, type HttpFrontendExt, type LanFacadeExt } from "./assembly.js";
import { createClientAllowGuard } from "./client-allow.js";
import { createCmdLimit } from "./cmd-limit.js";
import { createCommandCompleteRoutes } from "./command-complete.js";
import { createCommandRouter } from "./commands.js";
import { createFeishuLinks } from "./feishu/link.js";
import { type FeishuBotService, type FeishuBotServiceDeps } from "./feishu/service.js";
import { createHubJsonWriter, type HubJsonWriter, type HubRecord } from "./hub-json.js";
import { defaultLanAssembly, LanAssemblyOffError } from "./lan-assembly.js";
import { verifyPassword } from "./lan-auth.js";
import { repairLan2fa, type LanStore } from "./lan-store.js";
import { createScope, withDeadline, withSignal, type Scope } from "./lifecycle.js";
import { createHubLog } from "./log.js";
import type { FrontendDeps, FrontendFactory, HubConfig, HubEvent, HubInfo, HubLog, LanAssembly } from "./ports.js";
import { createPrivacyRoutes } from "./privacy/routes.js";
import { proxyErrCode } from "./proxy/audit.js";
import { createProxyRoutes } from "./proxy/routes.js";
import { createProxyService } from "./proxy/service.js";
import { createReqDeadline, type ReqDeadline } from "./req-deadline.js";
import { createSecurityEventBus } from "./security-events.js";
import { createSelfRestartStore, type SelfRestartDecision } from "./self-restart.js";
import { acquireSingleton } from "./singleton.js";
import { type PlatformProbeDeps } from "./spawn/config.js";
import { type FirstPromptForwarder } from "./spawn/first-prompt.js";
import type { HistoryService as SpawnHistoryService } from "./spawn/history/ports.js";
import type { ProcFs, ProcSyncFs } from "./spawn/history/proc.js";
import { type Reaper } from "./spawn/reaper.js";
import { type SpawnSupervisor, type SpawnSupervisorDeps } from "./spawn/supervisor.js";
import { SUPERSEDE_YIELD_MS } from "./supersede.js";
import { createVersionInfoService } from "./version-info.js";

export interface RunningHub {
  paths: HubPaths;
  httpPort: number;
  info: HubInfo;
  identity: SocketIdentity;
  lan?: import("./ports.js").LanFacade;
  lanStatus(): LanStatus | undefined;
  /** web-hub-spawn plan §SP10 (arch §7.6, review #4): optional per-call absolute deadline.
   * The default (`HUB_CLOSE_DEADLINE_MS`) covers every legacy caller; `installProcessHandlers`'
   * crash path passes a 2.5s deadline (plus FA's bot-stop reservation when enabled), so the
   * spawn subsystem's graded shutdown happens before the matching hard exit. */
  close(reason: string, opts?: { deadline?: ReqDeadline }): Promise<void>;
  readonly closed: Promise<string>;
}

export interface ClosedHub {
  /** Preserve legacy callers' `"exists" in result` non-running-result guard. */
  exists: false;
  closed: true;
  reason: string;
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
/** F8's shared 6s business/transport budget plus scheduler margin, added only when enabled. */
export const FEISHU_STOP_RESERVE_MS = Object.values(FEISHU_SHUTDOWN_BUDGET_MS).reduce((sum, ms) => sum + ms, 0) + 500;
/** Per-step bound for cleanup/close steps; kept separate from the crash-only hard exit in `installProcessHandlers`. */
const STEP_DEADLINE_MS = 3_000;
/** session-history plan v3.3 W3: the hub-side cap on `HistoryService.dispose()` — dispose's own
 * internal budget (HISTORY_DISPOSE_MS, P-scan) is 2s; the extra half second covers the force-close
 * epsilon. The service resolves by its own deadline regardless, so this is a belt-and-suspenders
 * bound, not the primary one. */
const HISTORY_SERVICE_DISPOSE_MS = 2_500;
/**
 * web-hub-spawn-restore plan D2/§10.4: the `close(reason)` reasons whose spawn shutdown runs in
 * `restore` mode (only when `config.spawn.restore === true`). `stop` / `signal` / `fence` / `idle`
 * (and anything else) terminate exactly as before.
 */
export const RESTORE_REASONS: ReadonlySet<string> = new Set(["restart", "superseded", "crash"]);
export interface StartHubDeps {
  now?: () => number;
  uid?: number;
  xdgRuntimeDir?: string;
  fs?: Partial<FsDeps> | undefined;
  /** Default: `defaultLanAssembly` (throws `E_NOT_IMPLEMENTED:LD` — W1 stub). */
  lanAssembly?: LanAssembly;
  /** Set by `main.ts` when `parseHubLanConfig` rejects `config.lan`; mutually exclusive with `config.lan`. */
  lanConfigError?: { detail: string };
  /** web-hub-spawn §SP2: the umask this hub process inherited before `main.ts` switched it to
   * 0o077 (`process.umask(0o077)`'s return value). SP10 hands it to the spawn supervisor, which
   * restores it around each fork so spawned pi processes keep the user's own umask. */
  childUmask?: number;
  /** web-hub-spawn §SP10: test seams for the spawn assembly (production callers leave this
   * undefined and get the real `probePlatform`/`createReaper`/`spawn`). `probe` feeds
   * `probePlatform` (simulate non-Linux / broken procfs); `reaper`/`spawnFn` replace the real
   * watchdog/fork; `wrapSupervisor`/`wrapFirstPrompt` let a test capture/spy on those surfaces
   * (shutdown order/deadline, first-prompt freshness) without replacing them. Ignored entirely
   * when `config.spawn` is undefined. */
  spawnSeams?: {
    probe?: PlatformProbeDeps;
    reaper?: Reaper;
    spawnFn?: SpawnSupervisorDeps["spawnFn"];
    wrapSupervisor?: (sup: SpawnSupervisor) => SpawnSupervisor;
    wrapFirstPrompt?: (fwd: FirstPromptForwarder) => FirstPromptForwarder;
    /** web-hub-spawn-restore plan HR1 test hook: the restore stability window. */
    restoreStableMs?: number;
    /** session-history plan PD22 (§4.8 step 1): programmatic-only seams for the spawn-history
     * service. `historyProcFs` overrides the occupancy scan's async /proc reads (tests expose
     * only the pids they spawned — a dev machine's live pi processes would otherwise force
     * every resume test into a fork); `wrapHistory` observes the constructed service (the
     * assembly tests read `diag().procFsSource` through it). `main.ts` sets NEITHER, and no env
     * or HubConfig key can reach them — pinned by tests/web-hub/hub/hub-history-assembly.test.ts. */
    historyProcFs?: Partial<ProcFs>;
    /** Verifier P2 (P-int flake round): the SYNC re-prove's /proc view, same programmatic-only
     *  seam discipline as `historyProcFs` — tests scope the synchronous re-stat to the pids
     *  they own so a saturated machine's /proc churn can never surface as a 409. */
    historyProcSyncFs?: Partial<ProcSyncFs>;
    wrapHistory?: (svc: SpawnHistoryService) => SpawnHistoryService;
  };
  /** dir-plan v3.1 §2.9 (P1a): the uid the preview root-warning checks — `0` ⇒ the one-shot
   * `preview.root_uid` WARN after the preview routes are built. Default: `process.getuid?.()`;
   * tests inject `() => 0` / `() => 1000` / leave it undefined (no getuid on the platform). */
  getuid?: () => number;
  /** worktree-diff plan §1.6 (D3): the git runner the worktree-diff routes execute every
   * hub-side git command through (D15). Default: the real `createGitRunner()`; tests inject a
   * scripted fake so no git process is ever spawned. */
  gitRunner?: GitRunner;
  /** Programmatic-only fake HTTP/WS seams; main.ts never supplies them. Ignored when off. */
  feishuSeams?: Pick<FeishuBotServiceDeps, "clock" | "fetch" | "webSocket" | "fs"> & {
    wrapService?(service: FeishuBotService, deps: FeishuBotServiceDeps): FeishuBotService;
  };
}

export async function startHub(
  config: HubConfig,
  frontend: FrontendFactory,
  deps: StartHubDeps = {},
): Promise<RunningHub | { exists: true } | ClosedHub> {
  if (config.lan !== undefined && deps.lanConfigError !== undefined) {
    throw new Error("web-hub: startHub received both config.lan and deps.lanConfigError");
  }
  const hubAgentDir = resolveAgentDir(process.env, config.home).dir;
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
  let closing: Promise<void> | undefined = undefined;
  let botCleanup: Promise<void> | undefined;
  // Shared by rollback and close. Call stop synchronously FIRST; dispose cancels setup in
  // parallel, not as another 2s tail after the 6s stop budget.
  function stopBot(): Promise<void> {
    if (botCleanup !== undefined) return botCleanup;
    if (ctx.bot === undefined) return Promise.resolve();
    let stopped: Promise<void> = Promise.resolve();
    let disposed: Promise<void> = Promise.resolve();
    try {
      stopped = ctx.bot.stop(); // Still the first cleanup call, even if an implementation throws.
    } catch {
      log.error("web-hub feishu: stop threw; continuing bounded cleanup");
    }
    try {
      disposed = ctx.bot.dispose(); // A throwing stop must not skip the independent final fence.
    } catch {
      log.error("web-hub feishu: dispose threw; continuing bounded cleanup");
    }
    botCleanup = bounded(
      Promise.allSettled([stopped, disposed]).then(() => {}),
      FEISHU_STOP_RESERVE_MS,
    );
    return botCleanup;
  }
  let resolveClosed: (reason: string) => void = () => {};
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });
  // Resource-producing steps own a late result even if cancellation wins the race.
  async function startupStep<T>(pending: Promise<T>, disposeLate?: (value: T) => Promise<void> | void): Promise<T> {
    const guarded = pending.then(async (value) => {
      if (startup.signal.aborted) {
        if (disposeLate !== undefined) await bounded(Promise.resolve(disposeLate(value)));
        throw startup.signal.reason;
      }
      return value;
    });
    const value = await withSignal(guarded, startup.signal);
    if (startup.signal.aborted) {
      if (disposeLate !== undefined) await bounded(Promise.resolve(disposeLate(value)));
      throw startup.signal.reason;
    }
    return value;
  }

  async function closedResult(): Promise<ClosedHub> {
    await closing;
    return { exists: false, closed: true, reason: await closed };
  }

  const ctx = createHubAssembly({
    config,
    deps,
    hubAgentDir,
    paths,
    log,
    now,
    startup,
    rootScope,
    cleanup,
    startupStep,
    isClosing: () => closing !== undefined,
    stopBot,
    bounded,
    stepDeadlineMs: STEP_DEADLINE_MS,
    registryTickMs: REGISTRY_TICK_MS,
    rotateScanMs: ROTATE_SCAN_MS,
  });

  try {
    await withSignal(ensurePrivateDir(paths.stateDir, paths.policies.stateDir, fsWithWarn), startup.signal); // ②

    const single = await startupStep(
      acquireSingleton(paths, { now, fs: fsWithWarn, signal: startup.signal }), // ④
      async (late) => {
        if (late.kind !== "exists" && late.kind !== "failed") await late.release();
      },
    );
    if (single.kind === "exists") {
      clearTimeout(startTimer);
      log.info("hub already running", single.hubPid === undefined ? {} : { hubPid: single.hubPid });
      log.close();
      await rootScope.dispose();
      return { exists: true };
    }
    if (single.kind === "failed") throw new Error(`web-hub: ${single.error}`);
    ctx.socketIdentity = single.identity;
    const owner = single; // narrow once here; closures defined below (e.g. `close`) don't retain flow narrowing
    cleanup.push(() => owner.release());
    startup.signal.throwIfAborted();
    const channelsReady = prepareHubChannels(ctx);
    if (channelsReady !== undefined) await channelsReady;
    const { spawnPlatform, htmlEnabled, xsAliasDegraded } = ctx;
    const extraHubCaps = assembleHubCaps(ctx);
    const security = config.lan === undefined ? undefined : createSecurityEventBus(log);
    ctx.security = security;
    const proxyRoutes =
      config.proxy === undefined
        ? undefined
        : createProxyRoutes({
            service: () => ctx.proxyService,
            log,
            now,
            ...(security === undefined ? {} : { security }),
          });
    const botDialogSlots =
      config.feishuBot === undefined ? undefined : new Map<string, Extract<HubEvent, { type: "dialogs" }>>();
    ctx.botDialogSlots = botDialogSlots;
    const { registry, unsubscribeBotSlots, history, runFileReader, runTx } = assembleRegistry(ctx);
    let httpPort = 0;
    ctx.httpPort = httpPort;
    const feishuLinks =
      config.feishuBot === undefined
        ? undefined
        : createFeishuLinks({
            loopbackPort: () => httpPort,
            ...(config.lan === undefined ? {} : { lan: config.lan }),
            snapshot: () => (ctx.fe as HttpFrontendExt).lanHostSnapshot?.(),
          });
    ctx.feishuLinks = feishuLinks;
    // One restart entry point for both admin `/webhub restart` and the DB
    // breaker. Keeping this as one function is important: self-restart must
    // publish the same superseded frame and stop banner semantics as admin.
    function requestAdminShutdown(reason: "restart" | "stop"): void {
      if (closing !== undefined) return;
      if (reason === "restart") {
        registry.broadcast({ t: "superseded", nextVersion: config.pluginVersion, yieldMs: SUPERSEDE_YIELD_MS });
      }
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
    }
    // Admin getters and close() dependencies are initialized before socket exposure.
    // Keeping ctl.v1 available does not depend on LAN assembly succeeding.
    const admin = createAdminHandler({
      log,
      hasLan: () => config.lan !== undefined,
      // D/E/F/G gates passed together: expose local setup only with configured LAN.
      advertiseTfa: config.lan !== undefined,
      emit: (e) => security?.emit(e),
      repair2fa: () => repairLan2fa({ dbFile: paths.dbFile, log }),
      feishuOwner: () => ctx.bot?.snapshot().owner !== undefined,
      store: () => ctx.lanDeps?.store,
      kdf: () => ctx.lanDeps?.kdf,
      limiter: () => ctx.lanDeps?.limiter,
      lan: () => ctx.fe.lan,
      lanStatus: () => hubJson.current()?.lan,
      shutdown: requestAdminShutdown,
      now,
      // Token rotation is only supported once the frontend has supplied its auth port.
      auth: () => (ctx.fe as HttpFrontendExt).auth!,
      rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
      revokeLanSessions: async () => {
        const store = ctx.lanDeps?.store as Partial<LanStore> | undefined;
        return (await store?.revokeAllSessions?.()) ?? 0;
      },
      revokeLoopbackSse: () => (ctx.fe as HttpFrontendExt).revokeAllSse?.() ?? 0,
      revokeLanSse: () => (ctx.fe.lan as LanFacadeExt | undefined)?.revokeAll?.() ?? 0,
      bumpLanRevokeGen: () => (ctx.fe as HttpFrontendExt).bumpLanRevokeGen?.(),
    });
    // Install the listener only after every admin getter and teardown dependency exists.
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
      // ask-user-async plan §7.2 (P3): DIALOG_BG_HUB_CAPS joins the same two surfaces the same
      // way — it gates `dialogs.closed[].by === "background"` (agents degrade to "abort"
      // against hubs without the cap).
      // web-hub-spawn plan §SP10: `extraHubCaps` (spawn.v1 + spawn.model.v1, only when
      // `config.spawn` exists) is the same source array `agent-server.ts` spreads into
      // `hello_ack.caps` — 同源数组展开（集合/顺序一致，非同一实例），same append-only pattern as
      // UPLOAD/DIALOG_BG before it.
      // fleet-drawer plan §5.3 (F3b): RUNTX_HUB_CAPS joins the same two surfaces the same way
      // (§8.4's caps-coexist test pins the set equality).
      // web-hub-steer-recall plan §2.3 S4: HOLD_HUB_CAPS rides the same two surfaces (inserted
      // right after DIALOG_BG_HUB_CAPS in both files, so the lists stay byte-identical).
      caps: [
        ...admin.caps(),
        ...P2_HUB_CAPS,
        ...UPLOAD_HUB_CAPS,
        ...DIALOG_BG_HUB_CAPS,
        ...HOLD_HUB_CAPS,
        ...RUNTX_HUB_CAPS,
        ...QUOTA_POOLS_HUB_CAPS,
        // todo-archive plan v2.1 §2 (D5): unconditional, both surfaces — same position as
        // agent-server.ts's hello_ack.caps fold (caps-coexist pins the set equality).
        ...TODO_ARCHIVE_HUB_CAPS,
        ...extraHubCaps,
      ],
    };
    ctx.info = info;
    const hubJson: HubJsonWriter = createHubJsonWriter(paths.hubJson, log);
    ctx.hubJson = hubJson;
    assembleAvatarStore(ctx);
    const selfRestart = createSelfRestartStore(`${paths.stateDir}/self-restart.json`);
    let unsubscribeDbRestart = (): void => {};
    function requestDbSelfRestart(): void {
      if (closing !== undefined) return;
      const decision: SelfRestartDecision = selfRestart.tryAcquire(now());
      if (!decision.allowed) {
        // Keep the existing LAN-off vocabulary so old clients remain compatible,
        // but expose why the automatic restart was suppressed in status detail and
        // in the hub log. Structural DB failures never create a store, so they
        // cannot reach this callback.
        const detail = `self-restart-${decision.reason}`;
        log.error("web-hub db-client: self-restart suppressed", { reason: decision.reason });
        hubJson.patchLan({ state: "off", reason: "db-unavailable", detail });
        return;
      }
      log.warn("web-hub db-client: requesting self-restart through admin restart path", {
        reason: "db-unavailable",
        restartCount: decision.timestamps.length,
      });
      // Route through the exact same admin shutdown entry as `/webhub restart`:
      // it publishes superseded and uses the existing lifecycle semantics. No
      // replacement DB is created here.
      requestAdminShutdown("restart");
    }
    const xsRelay = assembleXsRelay(ctx);
    const scheduleHub = assembleSchedule(ctx);
    ctx.scheduleHub = scheduleHub;
    ctx.close = close;
    ctx.agentServer = createAgentServer(owner.server, {
      registry,
      config,
      log,
      now,
      httpPort: () => httpPort,
      admin,
      extraHubCaps,
      // scheduled-reports H1: `sched_*` frame routing (never the registry).
      ...(scheduleHub === undefined ? {} : { schedule: scheduleHub }),
      ...(xsRelay === undefined ? {} : { xs: xsRelay.router }),
      ...(config.feishuBot === undefined
        ? {}
        : {
            feishuAdmin: (frame: FsbReqFrame) =>
              ctx.bot?.admin(frame) ??
              Promise.resolve({
                t: "fsb_res" as const,
                rid: frame.rid,
                ok: false as const,
                code: "E_FSB_STATE",
                message: "机器人正在启动或关闭",
              }),
          }),
      onHello: () => ctx.recoverRotateOnHello?.(),
      restoreCount: () => ctx.spawnSup?.restoreCandidateCount() ?? 0,
    });
    cleanup.push(() => ctx.agentServer!.close());
    // §4.1's recognized db-open failures degrade to loopback-only (never fail the whole hub) —
    // `LanAssemblyOffError` is `defaultLanAssembly`'s (LD's own file) way of saying exactly that;
    // any other rejection (a real bug, an injected test double's `E_NOT_IMPLEMENTED:LD`, …) still
    // propagates to this function's own outer `catch` below and fails `startHub` as before.
    const clientAllow =
      config.lan === undefined
        ? undefined
        : createClientAllowGuard({
            ...(config.lan.allowClients === undefined ? {} : { entries: config.lan.allowClients }),
            log,
            now,
          });
    if (clientAllow !== undefined && security !== undefined) {
      const off = clientAllow.onBurst((b) =>
        security.emit({ type: "allowlist-burst", count: b.count, ips: [...b.ips], lastIp: b.lastIp }),
      );
      cleanup.push(async () => off());
    }
    let lanAssemblyOff: { reason: LanOffReason; detail?: string } | undefined;

    if (config.lan !== undefined) {
      try {
        const scope = rootScope.child();
        // A slow assembly may register its store cleanup after root disposal completed.
        const assemblyScope: Scope = {
          ...scope,
          defer: (fn) => {
            if (scope.signal.aborted) void bounded(Promise.resolve().then(fn));
            else scope.defer(fn);
          },
        };
        ctx.lanDeps = await startupStep(
          (deps.lanAssembly ?? defaultLanAssembly).build({
            cfg: config.lan,
            ...(security === undefined ? {} : { security }),
            paths,
            log,
            now,
            scope: assemblyScope,
            onStatus: (s) => {
              if (!startup.signal.aborted) hubJson.patchLan(s);
            },
          }), // ⑤
          (late) => late.scope.dispose(),
        );
        startup.signal.throwIfAborted();
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
    if (ctx.lanDeps !== undefined) {
      if (clientAllow !== undefined) ctx.lanDeps!.clientAllow = clientAllow;
      if (security !== undefined) ctx.lanDeps!.security = security;
      if (feishuLinks) ctx.lanDeps!.onAuthenticated = feishuLinks.authenticated;
      ctx.lanDeps!.onLoginCore = (core) => {
        ctx.lanLoginCore = core;
      };
      // D/E/F/G are wired and verified. Internal invariant, never configurable through settings/env.
      ctx.lanDeps!.secondFactorEnabled = true;
      const dbRestartStore = ctx.lanDeps!.store as Partial<LanStore>;
      if (typeof dbRestartStore.onRestartNeeded === "function") {
        unsubscribeDbRestart = dbRestartStore.onRestartNeeded(requestDbSelfRestart);
        cleanup.push(async () => unsubscribeDbRestart());
      }
      // KDF work is not part of the command router's in-flight counter, but it
      // must keep the quiet replacement path from cutting across a login. #66: EVERY compute
      // method counts (`run` and `runPadded`) — a padded compensation run is still a login.
      const countInFlight = <A extends unknown[]>(fn: (...args: A) => Promise<Uint8Array>) => {
        return (...args: A): Promise<Uint8Array> => {
          ctx.kdfInFlight++;
          try {
            return Promise.resolve(fn(...args)).finally(() => {
              ctx.kdfInFlight = Math.max(0, ctx.kdfInFlight - 1);
            });
          } catch (err) {
            ctx.kdfInFlight = Math.max(0, ctx.kdfInFlight - 1);
            throw err;
          }
        };
      };
      const kdfPort = ctx.lanDeps!.kdf;
      const originalKdfRun = kdfPort.run.bind(kdfPort);
      kdfPort.run = countInFlight(originalKdfRun);
      if (kdfPort.runPadded !== undefined) {
        const originalRunPadded = kdfPort.runPadded.bind(kdfPort);
        kdfPort.runPadded = countInFlight(originalRunPadded);
      }
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
      ctx.lanDeps !== undefined
        ? async (): Promise<number> => {
            const store = ctx.lanDeps!.store as Partial<LanStore>;
            return (await store.revokeAllSessions?.()) ?? 0;
          }
        : undefined;
    const rotateRecovery: RotateRecoveryOutcome = await startupStep(
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
    );
    startup.signal.throwIfAborted();
    ctx.lanBlockedByRotate = rotateRecovery.lanBlocked === true;
    /** Set when the runtime scan had to close an already-open LAN listener (permanent) — the
     * "previously blocked, now resolved ⇒ start()" path must not try to resurrect it. */
    ctx.lanClosedByRotateScan = false;

    if (config.privacy === true) await loadPrivacyStore(ctx);
    const commandRouter = createCommandRouter({ registry, log, now });
    ctx.commandRouter = commandRouter;
    const cmdLimit = createCmdLimit(now);
    ctx.cmdLimit = cmdLimit; // ONE HTTP + Feishu admission limiter (same agent bucket).
    if (config.spawn !== undefined) await assembleSpawn(ctx);
    const uploadMetrics = assembleUploads(ctx);
    if (config.preview !== undefined) await assemblePreview(ctx);
    if (config.feishuBot !== undefined) await assembleFeishu(ctx);
    // web-hub-delete-session plan v2 §2.9: the removal route frontend is wired UNCONDITIONALLY
    // (unlike spawn/preview/upload) — deleting an offline/stale TUI card never depended on
    // managed spawn being enabled at all; `managed` is simply absent when it isn't, and
    // `agentKey`-form requests fall straight to `registry.remove` (§2.4 row 6).
    const agentRemoveService = createAgentRemoveService({
      registry,
      ...(ctx.spawnSup !== undefined && config.spawn !== undefined
        ? { managed: { sup: ctx.spawnSup, lan: config.spawn.lan } }
        : {}),
      log,
      now,
    });
    // web-hub-privacy plan v2.1 (P1): the privacy-lock ROUTES (the store was created/loaded
    // above, before the spawn assembly — see the comment there). Gated on the same
    // `config.privacy === true`; off ⇒ no routes, no `privacy` frame, no cap.
    let privacyRoutes: ReturnType<typeof createPrivacyRoutes> | undefined;
    if (ctx.privacyStore !== undefined) {
      privacyRoutes = createPrivacyRoutes({
        store: ctx.privacyStore,
        registry,
        // 「校验管线」(v2 评审 #3): the extracted `verifyPassword` rides the SAME LAN store/KDF/
        // limiter/admission instances login uses — fail-only limiter accounting lives inside
        // `verifyPassword` itself. Absent LAN assembly ⇒ verify 404s and LAN unlocks fail closed.
        ...(ctx.lanDeps === undefined
          ? {}
          : {
              verifyPassword: (userId: number, password: string, clientIp: string) =>
                verifyPassword({ clientIp }, userId, password, {
                  store: ctx.lanDeps!.store,
                  kdf: ctx.lanDeps!.kdf,
                  limiter: ctx.lanDeps!.limiter,
                  admission: ctx.lanDeps!.admission,
                  ...(ctx.lanDeps!.kdfPolicy === undefined ? {} : { kdfPolicy: ctx.lanDeps!.kdfPolicy }),
                  onCorruptKdfParams: (username, reason) => {
                    log.error("web-hub privacy: corrupt kdf params (db-invalid:kdf)", { username, reason });
                  },
                }),
            }),
        log,
        now,
      });
    }
    // web-hub-version plan §3.5/§3.7: the version-info service (no resident timers; `dispose`d
    // on both teardown paths) and the served-UI identity sink (`HubInfo.ui` + one `hub` frame
    // per real change; `onUiStatus → hubJson.patchUi` below stays untouched).
    ctx.versionService = createVersionInfoService({
      pkgRoot: packageRootDir(),
      info,
      now,
      log,
      publish: () => {
        if (closing === undefined) registry.publish({ type: "hub" });
      },
    });
    const versionSvc = ctx.versionService;
    cleanup.push(async () => versionSvc.dispose());
    const sameUi = (a: HubUiBuildWire | undefined, b: HubUiBuildWire | undefined): boolean =>
      a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
    const frontendDeps: FrontendDeps = {
      config,
      paths,
      registry,
      bus: registry.bus,
      history,
      log,
      info: () => info,
      now,
      onUiStatus: (s) => hubJson.patchUi(s),
      version: versionSvc,
      onUiServed: (next) => {
        if (sameUi(info.ui, next)) return;
        if (next === undefined) delete info.ui;
        else info.ui = next;
        if (closing === undefined) registry.publish({ type: "hub" });
      },
      // §6.1 (C0 P0 fix): constructed here so the frontend factory can reach it via
      // `FrontendDeps.commands` — today's stub always answers `E_UNSUPPORTED` and is never read
      // §6.1 (C3): the real command router — hub-side idempotent LRU, agent-capability
      // admission, effect classification, queryOnly, drain — replacing C0's always-`E_UNSUPPORTED`
      // stub. `registry` (constructed above) is the same instance the agent socket layer feeds.
      commands: commandRouter,
      cmdLimit,
      ...(config.cmdArgs === "all" || config.cmdArgs === "toolkit"
        ? { commandComplete: createCommandCompleteRoutes({ registry, log, now }) }
        : {}),
      uploadMetrics,
      agentRemove: agentRemoveService,
      ...(ctx.avatarRoutes === undefined ? {} : { avatar: ctx.avatarRoutes }),
      ...(privacyRoutes === undefined ? {} : { privacy: privacyRoutes }),
      ...(ctx.uploads === undefined ? {} : { uploads: ctx.uploads }),
      ...(ctx.spawnRoutes === undefined ? {} : { spawn: ctx.spawnRoutes }),
      ...(ctx.previewRoutes === undefined ? {} : { preview: ctx.previewRoutes }),
      ...(ctx.worktreeDiffRoutes === undefined ? {} : { worktreeDiff: ctx.worktreeDiffRoutes }),
      ...(ctx.worktreeGraphRoutes === undefined ? {} : { worktreeGraph: ctx.worktreeGraphRoutes }),
      ...(proxyRoutes === undefined ? {} : { proxy: proxyRoutes }),
      ...(ctx.lanDeps === undefined ? {} : { lan: ctx.lanDeps }),
      // fleet-drawer plan §5.3 (F3b): the run-transcript service — F4's `createRunRoutes`
      // reads it through this dep (absent ⇒ no `/api/run/*` wiring, byte-identical today).
      runTx,
    };
    // scheduled-reports H1: the coordinator rides FrontendDeps as a duck-typed extra (ports.ts
    // frozen for this package — http.ts reads it through the same widening; the GET route + SSE
    // sinks only exist when `config.schedule` does, so an off hub stays byte-identical).
    if (scheduleHub !== undefined) {
      (frontendDeps as FrontendDeps & { schedules?: typeof scheduleHub }).schedules = scheduleHub;
    }
    ctx.fe = frontend(frontendDeps);
    cleanup.push(() => ctx.fe.close());
    // web-hub-preview plan v3 §4.5.1 (PV3): pushed right after the frontend's own entry so the
    // startup-failure reverse-order unwind runs preview dispose BEFORE `fe.close()` — the same
    // domain-first order the runtime `close()` path below uses; before the spawn push so the two
    // unwind in the same relative order as the runtime path (spawn shutdown → preview dispose →
    // fe.close).
    if (ctx.previewRoutes !== undefined) {
      cleanup.push(() => ctx.previewRoutes!.dispose("startup-failure", createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    if (ctx.avatarRoutes !== undefined) {
      cleanup.push(() => ctx.avatarRoutes!.dispose("startup-failure", createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    // worktree-diff plan §1.6 (D3): right after preview's push — the startup-failure unwind
    // disposes wtdiff AFTER preview and BEFORE `fe.close()`, mirroring the runtime order below.
    if (ctx.worktreeDiffRoutes !== undefined) {
      cleanup.push(() => ctx.worktreeDiffRoutes!.dispose("startup-failure", createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    // worktree-graph plan v2 §2.6 (P2): right after wtdiff's push — the startup-failure unwind
    // disposes wtgraph AFTER wtdiff and BEFORE `fe.close()`, mirroring the runtime order below.
    if (ctx.worktreeGraphRoutes !== undefined) {
      cleanup.push(() => ctx.worktreeGraphRoutes!.dispose("startup-failure", createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    // web-hub-spawn §SP10 (startup-failure path only — the runtime close() path wires its own
    // call inside `close`): pushed right after the frontend's entry so reverse-order release
    // runs the spawn shutdown BEFORE `fe.close()` (arch §7.6's domain-first order; see the
    // comment at the spawn assembly above for why the push had to live here, SP13 P3).
    // Verifier r2 P1: this LATER entry shares the SAME idempotent once-promise as the early
    // entry inside the spawn assembly — on failures past this point it runs FIRST (SP13
    // order preserved); on earlier failures the early entry already ran it and this call is
    // the same settled promise (exactly-once either way).
    if (ctx.spawnShutdownOnce !== undefined) {
      cleanup.push(() => ctx.spawnShutdownOnce!());
    }
    // §2.2.4: the startup scan never blocks listen(); `begin` answers 503 E_BUSY until it lands.
    if (ctx.uploads !== undefined) {
      void ctx
        .uploads!.recover()
        .catch((err: unknown) =>
          log.error("web-hub: upload startup recovery rejected unexpectedly", { error: String(err) }),
        );
    }
    // §6.7.1: "恢复后无条件 auth.reload()，双保险" — cheap even when nothing was recovered (the very
    // next real call is `auth.token()` inside `fe.listen()` below, so there is nothing cached yet
    // in the startup path; this still matters once the periodic scan reuses the same helper).
    (ctx.fe as HttpFrontendExt).auth?.reload();

    assembleSupersede(ctx);

    httpPort = (await startupStep(ctx.fe.listen({ signal: startup.signal }), () => ctx.fe.close())).port; // ⑥
    ctx.httpPort = httpPort;
    startup.signal.throwIfAborted();

    // web-hub-proxy plan v2 §3.4/§12 (X1c): the service needs the ACTUAL bound ports (the
    // loopback listener falls back to a random port on EADDRINUSE), so it is built only now.
    // Every failure path from here on — and every normal close — awaits `dispose()` (cleanup
    // entry pushed right after construction; reverse order ⇒ it runs BEFORE `fe.close()`).
    // A construction failure degrades to "proxy unavailable" (routes answer 503 `closing`), it
    // never fails the hub; an aborted startup rethrows so the late service is disposed.
    if (config.proxy !== undefined) {
      try {
        const created = await startupStep(
          createProxyService({
            config: config.proxy,
            lan: config.lan !== undefined,
            clientAllow: clientAllow ?? createClientAllowGuard({}),
            stateDir: paths.stateDir,
            hubPort: httpPort,
            ...(config.lan === undefined ? {} : { lanPort: config.lan.port }),
            lanHostSnapshot: () => (ctx.fe as HttpFrontendExt).lanHostSnapshot?.(),
            log,
            now,
          }),
          (late) => late.dispose(),
        );
        ctx.proxyService = created;
        cleanup.push(() => created.dispose());
        // §4.2: the service's revocation hook rides the frontend's bus; unsubscribed on close.
        const unsubscribe = (ctx.fe as HttpFrontendExt).subscribeAuthRevoke?.((ev) => created.revoke(ev));
        if (unsubscribe !== undefined) {
          ctx.unsubscribeProxyRevoke = unsubscribe;
          cleanup.push(async () => unsubscribe());
        }
      } catch (err) {
        if (startup.signal.aborted) throw err;
        // code only — an fs/DNS error message can carry paths (plan §7: never log such text)
        log.error("web-hub proxy: service construction failed (proxy unavailable)", { code: proxyErrCode(err) });
      }
      startup.signal.throwIfAborted();
    }

    // vue-plan.md v2.1 §2.1（P5b）："启动：hub 在写 hub.json 前 await ui.refresh()（≤3s，超时按未构建
    // 上报、后台继续）" — `refresh()` itself is single-flight and bounded by `UI_ROOT_RESOLVE_TIMEOUT_MS`
    // (ui-root.ts), so this can never itself blow the hub's own `HUB_START_DEADLINE_MS` budget. This
    // first `refresh()` call is also what fires `onUiStatus` for the initial status (wired above), so
    // `hubJson`'s `pendingUi` picks it up before `write()` below even runs (same queue-before-first-
    // write race `lan`'s `onStatus` already relies on, §2.1's "诊断" bullet).
    const initialUi = await startupStep(ctx.fe.ui.refresh());
    startup.signal.throwIfAborted();

    const initialLan: LanStatus | undefined =
      deps.lanConfigError !== undefined
        ? { state: "off", reason: "bad-config", detail: deps.lanConfigError.detail }
        : ctx.lanBlockedByRotate
          ? // acc32-B7 (verifier r_29729WTC): `rotate-pending` must outrank `lanAssemblyOff` here,
            // not just come after it — a store that failed to open (e.g. `db-invalid`) is exactly
            // the case where `recoverRotateIntent`'s fail-closed revoke also has no store to
            // revoke against, so `ctx.lanBlockedByRotate` and `lanAssemblyOff` are routinely BOTH set
            // at once. Checking `lanAssemblyOff` first (the original order) always won that race
            // and reported the (real but less actionable) `db-invalid` reason while masking the
            // fact that a rotation is stuck pending recovery — exactly the security-relevant state
            // §6.7.1 requires `/webhub status` to surface ("lan off · rotate-pending · /webhub
            // restart to retry"). `deps.lanConfigError` stays first: it implies `config.lan ===
            // undefined` (the constructor guard above), so `hasLan` was `false` for the rotate
            // recovery call and `ctx.lanBlockedByRotate` can never be true alongside it — no ordering
            // conflict there.
            { state: "off", reason: "rotate-pending" }
          : lanAssemblyOff !== undefined
            ? {
                state: "off",
                reason: lanAssemblyOff.reason,
                ...(lanAssemblyOff.detail === undefined ? {} : { detail: lanAssemblyOff.detail }),
              }
            : ctx.fe.lan !== undefined
              ? { state: "starting" }
              : undefined;
    let initialSpawn: { count: number; reason?: string } | undefined;
    if (ctx.spawnSup !== undefined) {
      initialSpawn = spawnStatusOf(ctx.spawnSup);
      ctx.lastSpawnStatus = initialSpawn;
    }
    // web-hub-privacy plan v2.1 (P3): surface the store's load-time `degraded` flag through
    // hub.json so `/webhub status` can warn about a corrupted-then-renamed privacy.json. The
    // store loads once at boot (above, before spawn assembly), so the flag rides the FIRST
    // write() — no patchPrivacy needed. Key absent when the feature is off (hub.json stays
    // byte-identical to a hub without the feature).
    const initialPrivacy =
      config.privacy === true && ctx.privacyStore !== undefined ? { degraded: ctx.privacyStore.degraded } : undefined;
    // web-hub-proxy (X1c): `/webhub status` reads the ports-store state from hub.json. Key absent
    // when the proxy is off (hub.json byte-identical); `unavailable` construction ⇒ no key either.
    ctx.lastProxyPortsStore = proxyStatusOf(ctx)?.portsStore;
    const initialProxy = proxyStatusOf(ctx);
    const initialAlias: XsAliasHubStatus | undefined =
      xsAliasDegraded === undefined ? undefined : { degraded: true, ...xsAliasDegraded };
    const identity = await startupStep(identityFields());
    // No await separates this gate from hub.json and the running log publication.
    if (closing !== undefined) return await closedResult();
    startup.signal.throwIfAborted();
    hubJson.write({
      pid: process.pid,
      nonce: randomBytes(12).toString("base64url"),
      version: config.pluginVersion,
      buildId: config.buildId,
      proto: PROTO,
      socket: paths.socketPath,
      port: httpPort,
      startedAt: info.startedAt,
      ...identity,
      ...(resolveAgentDir(process.env, config.home).source === "env" ? { agentDir: hubAgentDir } : {}),
      ...(initialLan === undefined ? {} : { lan: initialLan }),
      ...(initialSpawn === undefined ? {} : { spawn: initialSpawn }),
      ...(initialPrivacy === undefined ? {} : { privacy: initialPrivacy }),
      ...(initialProxy === undefined ? {} : { proxy: initialProxy }),
      ...(initialAlias === undefined ? {} : { alias: initialAlias }),
      ui: initialUi,
    }); // ⑦

    clearTimeout(startTimer); // startup complete; further cancellation is close()'s job
    // web-hub-version plan §3.5: one-shot, silent-on-failure boot HEAD observation (git, bounded,
    // aborted by dispose); broadcasts one `hub` frame when it lands.
    ctx.versionService.captureBootHead();
    if (ctx.fe.lan !== undefined && !ctx.lanBlockedByRotate) {
      // Review fix (LC, plan §1.4/§3, W3 acceptance item 1/3): `LanFacade.start()` is bounded by
      // its own `LAN_START_DEADLINE_MS` and always *resolves* with a correctly classified
      // `LanStatus` (`off/timeout`, `off/listen-failed`, ...) instead of rejecting for any
      // recognized outcome — mislabeling every rejection here as `timeout` used to hide real
      // causes (e.g. a port conflict) behind the wrong reason. A rejection reaching this handler
      // therefore means something escaped that classification (a genuine bug in `start()` itself),
      // so log it loudly rather than writing a second, silently-wrong guess into `hub.json`.
      void ctx.fe.lan.start().then(
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

    startRuntimeMonitors(ctx, uploadMetrics);

    function close(reason: string, opts?: { deadline?: ReqDeadline }): Promise<void> {
      if (closing !== undefined) return closing;
      // web-hub-spawn plan §SP10 (arch §7.6, review #4): one absolute deadline per close call —
      // the default covers every legacy caller; `installProcessHandlers`' crash path passes a
      // legacy 2.5s one PLUS the bot-stop reservation when enabled. Bot shutdown runs FIRST;
      // individual later steps still carry their own `bounded()` STEP caps.
      const closeBudget = HUB_CLOSE_DEADLINE_MS + (config.feishuBot === undefined ? 0 : FEISHU_STOP_RESERVE_MS);
      const deadline: ReqDeadline = opts?.deadline ?? createReqDeadline(now, closeBudget);
      // Publish the once-promise before any abort listener can re-enter close().
      const botStopped = stopBot();
      const inner = Promise.resolve().then(async (): Promise<void> => {
        await botStopped; // FIRST cleanup operation: connector must stop ACKing before any teardown.
        unsubscribeBotSlots();
        log.info("hub closing", { reason });
        ctx.unsubscribeSupersedeOnDialogs();
        unsubscribeDbRestart();
        for (const cancel of [...ctx.supersedeWaitCancels]) cancel();
        ctx.supersede?.dispose();
        if (ctx.supersedeTimer !== undefined) clearInterval(ctx.supersedeTimer);
        ctx.stopFence();
        ctx.idle.stop();
        ctx.versionService?.dispose();
        if (ctx.tick !== undefined) clearInterval(ctx.tick);
        if (ctx.rotateScan !== undefined) clearInterval(ctx.rotateScan);
        if (ctx.uploadInflightTick !== undefined) clearInterval(ctx.uploadInflightTick);
        if (ctx.uploadSweepTick !== undefined) clearInterval(ctx.uploadSweepTick);
        // web-hub-spawn plan §SP10 (arch §7.6): the spawn domain shuts down BEFORE the HTTP
        // face stops accepting — supervisor.shutdown is itself bounded (graceful wait budget
        // deriveBudget(r,3000,6500) ⇒ 0 on the crash deadline; verified SIGTERM to survivors;
        // store.flushAndClose still persists once even at zero budget; reaper stdin closes
        // LAST so its EOF-armed TERM→KILL escalation covers whatever outlives this process).
        // The forwarder is disposed first: unsent first prompts become `expired{hub_restart}`
        // (arch §4.6) while the bus is still live enough for the final `spawns` push.
        ctx.firstPromptFwd?.dispose("hub_restart");
        // web-hub-spawn-restore plan §10.4: reason → mode, in this ONE place (D2).
        if (ctx.spawnSup !== undefined) {
          const mode = config.spawn?.restore === true && RESTORE_REASONS.has(reason) ? "restore" : "terminate";
          await ctx.spawnSup.shutdown(deadline, { mode });
        }
        // session-history plan v3.3 W3 / X3.4 #4: history dispose — AFTER the spawn supervisor
        // shut down, BEFORE the HTTP face stops accepting. Awaited and bounded at 2.5s: dispose
        // retires every gen, force-releases pins and the fd ledger's remaining kinds, and every
        // in-flight request settles `busy` inside its own HISTORY_DISPOSE_MS budget — no leaked
        // fds and no never-settling promise can outlive the hub. Idempotent: the startup-failure
        // cleanup array holds the same underlying promise. (The fleet-history dispose above used
        // to run un-awaited only after the HTTP frontend had already closed — moved up into this
        // same window so both history services tear down domain-first.)
        if (ctx.spawnHistory !== undefined) await bounded(ctx.spawnHistory.dispose(), HISTORY_SERVICE_DISPOSE_MS);
        history.dispose();
        // web-hub-preview plan v3 §4.5.1 (PV3): preview dispose — after the spawn domain shuts
        // down, BEFORE the HTTP face stops accepting. Bounded (≤1s inside dispose itself:
        // verifier tasks aborted, every active request aborted "hub-close", head-sent streams
        // destroyed) and idempotent (shares the startup-failure promise).
        if (ctx.previewRoutes !== undefined) await bounded(ctx.previewRoutes!.dispose("close", deadline));
        // worktree-diff plan §1.6 (D3): after preview dispose, still BEFORE the HTTP face stops
        // accepting — aborts every in-flight request and single-flight git execution, waits
        // ≤1 s, idempotent (shares the startup-failure promise).
        if (ctx.worktreeDiffRoutes !== undefined) await bounded(ctx.worktreeDiffRoutes!.dispose("close", deadline));
        // worktree-graph plan v2 §2.6 (P2): after wtdiff dispose, still BEFORE the HTTP face
        // stops accepting — same bounded/idempotent contract.
        if (ctx.worktreeGraphRoutes !== undefined) await bounded(ctx.worktreeGraphRoutes!.dispose("close", deadline));
        if (ctx.avatarRoutes !== undefined) await bounded(ctx.avatarRoutes!.dispose("close", deadline));
        // web-hub-proxy §3.4 (X1c): unsubscribe the revocation hook, then the irreversible
        // closing fence (destroys every proxied socket, closes the proxy listeners) — BEFORE the
        // HTTP face stops accepting, bounded, idempotent (shares the startup-failure promise).
        ctx.unsubscribeProxyRevoke();
        if (ctx.proxyService !== undefined) await bounded(ctx.proxyService.dispose());
        await bounded(ctx.fe.close());
        // web-hub-upload plan §2.6 #13 (U3): AFTER the frontend has stopped accepting requests
        // (srv.close + closeAllConnections), poison+reap in-flight upload dirs (committed files
        // are retained) before the rest of the teardown. The crash path may not reach this —
        // those orphans are the next startup's sweep("startup") job (§2.2.4).
        if (ctx.uploads !== undefined) await bounded(ctx.uploads!.close());
        // web-hub-privacy plan v2.1 (P1): drain the privacy store's write chain AFTER the
        // frontend stopped accepting requests (no new mutations can start), same posture as the
        // upload store above. The chain itself carries no timers; close() never rejects.
        if (ctx.privacyStore !== undefined) await bounded(ctx.privacyStore.close());
        // fleet-drawer plan §5.3 (F3b): explicit runtime-path dispose (the cleanup array is
        // startup-failure-only, upload plan #13) — service first (drops the bus subscription
        // and held watches), then the reader (fails in-flight scans as `busy`).
        runTx.dispose();
        runFileReader.dispose();
        xsRelay?.dispose();
        if (ctx.agentServer !== undefined) await bounded(ctx.agentServer.close());
        await bounded(rootScope.dispose());
        await bounded(owner.release());
        hubJson.removeIfOurs();
        log.info("hub closed", { reason });
        log.close();
        resolveClosed(reason);
      });
      closing = withDeadline(inner, closeBudget).catch((err: unknown) => {
        log.error("web-hub: hub close exceeded deadline", { error: String(err) });
        process.exit(1);
      });
      clearTimeout(startTimer);
      startup.abort(new Error(`web-hub: closing (${reason})`));
      return closing;
    }

    return {
      paths,
      httpPort,
      info,
      identity: owner.identity,
      ...(ctx.fe.lan === undefined ? {} : { lan: ctx.fe.lan }),
      lanStatus: () => hubJson.current()?.lan,
      close,
      closed,
    };
  } catch (err) {
    clearTimeout(startTimer);
    if (closing !== undefined) return await closedResult();
    await stopBot(); // FIRST on startup failure too, before abort-triggered resource teardown.
    startup.abort(err);
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
    // Legacy crash budget remains 3s / 2.5s for graded spawn shutdown. FA reserves the
    // bot's 6s shared stop + 0.5s margin FIRST on enabled hubs, before that legacy budget.
    // Never let the old 3s hard exit cut across durable receive/outbox shutdown.
    const crashBudget = STEP_DEADLINE_MS + (hub.info.caps.includes(FSB_HUB_CAP) ? FEISHU_STOP_RESERVE_MS : 0);
    const force = setTimeout(() => process.exit(1), crashBudget);
    force.unref();
    void hub
      .close("crash", { deadline: createReqDeadline(Date.now, crashBudget - 500) })
      .finally(() => process.exit(1));
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
    let cmdline: string | undefined;
    try {
      cmdline = await readFile("/proc/self/cmdline", "utf8");
    } catch {
      cmdline = undefined;
    }
    return { procStartTicks, argv: identityArgv(cmdline, process.argv) };
  } catch {
    return {};
  }
}

/**
 * The argv recorded in hub.json must be the *kernel's* view (`/proc/self/cmdline`), because that is
 * exactly what `verifyProcIdentity` later compares against. `process.argv` is NOT that: pi's bundled
 * `jiti-cli.mjs` does `process.argv.splice(2, 1)` and overwrites `argv[1]` with the resolved script, so
 * the hub sees `[node, main.ts]` while `/proc` shows `[node, jiti-cli.mjs, main.ts]` — recording
 * `process.argv` made every restart fallback fail with `argv-shape`. `process.argv` is only a fallback
 * for an unreadable/empty cmdline.
 */
export function identityArgv(cmdline: string | undefined, fallback: readonly string[]): string[] {
  const parts = cmdline === undefined ? [] : parseCmdline(cmdline);
  return parts.length > 0 ? parts : fallback.slice();
}

function bounded(p: Promise<void>, ms: number = STEP_DEADLINE_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
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
