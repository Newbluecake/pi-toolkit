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
import {
  ensurePrivateDir,
  resolveHubPaths,
  webHubSpawnFiles,
  webHubUploadsDir,
  type HubPaths,
  type SocketIdentity,
} from "../protocol/paths.js";
import {
  PROTO,
  P2_HUB_CAPS,
  UPLOAD_HUB_CAPS,
  DIALOG_BG_HUB_CAPS,
  RUNTX_HUB_CAPS,
  SPAWN_HUB_CAP,
  SPAWN_MODEL_HUB_CAP,
  PREVIEW_HUB_CAP,
  PREVIEW_LAN_HUB_CAP,
  PREVIEW_ABS_HUB_CAP,
  PREVIEW_DIR_HUB_CAP,
  WTDIFF_HUB_CAP,
} from "../protocol/version.js";
import { createAdminHandler, recoverRotateIntent, type RotateRecoveryOutcome } from "./admin.js";
import { createAgentServer } from "./agent-server.js";
import { createAgentRemoveService } from "./agent-remove.js";
import { auditSpawn, auditUpload, createUploadHttpMetrics, uploadStatsFields } from "./audit.js";
import { createCmdLimit } from "./cmd-limit.js";
import { createCommandRouter } from "./commands.js";
import { createSupersede, SUPERSEDE_YIELD_MS, type SupersedeController } from "./supersede.js";
import { createHistoryService } from "./history.js";
import { createHubJsonWriter, type HubJsonWriter, type HubRecord } from "./hub-json.js";
import { createIdleMonitor } from "./idle.js";
import { withDeadline, withSignal, createScope, type Scope } from "./lifecycle.js";
import { createHubLog } from "./log.js";
import { defaultLanAssembly, LanAssemblyOffError } from "./lan-assembly.js";
import { createReqDeadline, type ReqDeadline } from "./req-deadline.js";
import { createRunFileReader } from "./run-file-reader.js";
import { createRunTranscriptService } from "./run-transcript.js";
import { probePlatform, type PlatformProbeDeps } from "./spawn/config.js";
import { createDirService } from "./spawn/dirs.js";
import { createFirstPromptForwarder, type FirstPromptForwarder } from "./spawn/first-prompt.js";
import type { SpawnFrontendPort } from "./spawn/ports.js";
import { createReaper, type Reaper } from "./spawn/reaper.js";
import { createSpawnRoutes } from "./spawn/routes.js";
import { createSpawnPrefs } from "./spawn/prefs.js";
import { createPreviewRoutes } from "./preview/routes.js";
import { createPreviewIoTracker, previewProcFdAvailable, resolvePreviewDenyContext } from "./preview/fs.js";
import { createWorktreeDiffRoutes } from "./worktree-diff/routes.js";
import { createGitRunner, type GitRunner } from "../../git/run.js";
import { createSpawnStore } from "./spawn/store.js";
import { createSpawnSupervisor, type SpawnSupervisor, type SpawnSupervisorDeps } from "./spawn/supervisor.js";
import { createUploadStore, type UploadStore } from "./uploads.js";
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
import { parseCmdline } from "../protocol/proc-identity.js";
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
  /** web-hub-spawn plan §SP10 (arch §7.6, review #4): optional per-call absolute deadline.
   * The default (`HUB_CLOSE_DEADLINE_MS`) covers every legacy caller; `installProcessHandlers`'
   * crash path passes a 2.5s deadline so the spawn subsystem's graded shutdown (wait budget 0 ⇒
   * immediate SIGTERM + one synchronous persist) happens before the 3s hard exit. */
  close(reason: string, opts?: { deadline?: ReqDeadline }): Promise<void>;
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
/**
 * web-hub-spawn-restore plan D2/§10.4: the `close(reason)` reasons whose spawn shutdown runs in
 * `restore` mode (only when `config.spawn.restore === true`). `stop` / `signal` / `fence` / `idle`
 * (and anything else) terminate exactly as before.
 */
export const RESTORE_REASONS: ReadonlySet<string> = new Set(["restart", "superseded", "crash"]);
/** web-hub-spawn plan §SP10: supervisor `init()`'s own startup budget (store load + orphan
 * recovery + launcher check ≤1s + reaper ready ≤2s — see arch §4.2/§7.3), folded into the
 * hub's overall `HUB_START_DEADLINE_MS` via `withSignal`. */
const SPAWN_INIT_BUDGET_MS = 4_000;
/** web-hub-upload plan §2.6 (U3): committed-file TTL sweep + `upload stats` aggregate row cadence. */
const UPLOAD_SWEEP_TICK_MS = 30 * 60_000;
/** §2.6: idle in-flight invalidation (10 min idle TTL) + dirty `referencedAt` flush retry cadence. */
const UPLOAD_INFLIGHT_TICK_MS = 60_000;

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
  };
  /** dir-plan v3.1 §2.9 (P1a): the uid the preview root-warning checks — `0` ⇒ the one-shot
   * `preview.root_uid` WARN after the preview routes are built. Default: `process.getuid?.()`;
   * tests inject `() => 0` / `() => 1000` / leave it undefined (no getuid on the platform). */
  getuid?: () => number;
  /** worktree-diff plan §1.6 (D3): the git runner the worktree-diff routes execute every
   * hub-side git command through (D15). Default: the real `createGitRunner()`; tests inject a
   * scripted fake so no git process is ever spawned. */
  gitRunner?: GitRunner;
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
    // web-hub-spawn plan §SP10 (arch §7.1): `spawn.v1` rides BOTH cap surfaces whenever
    // `config.spawn` exists — even when the platform probe or launcher check failed (the UI
    // needs the cap to explain WHY spawn is unavailable, `GET /api/headless` carries the
    // `policy.reason`). Absent (feature off) ⇒ caps stay byte-identical to pre-SP10.
    // web-hub-spawn default-model plan §2/D4: `spawn.model.v1` joins the SAME conditional tail
    // (prefs endpoint + `model` tri-state + the record vocabulary) — an old browser ignores the
    // unknown string (`caps.includes`), and a browser without it MUST NOT send `model` anywhere
    // (the pre-feature schema is `additionalProperties:false` ⇒ an old hub would 400).
    // web-hub-preview plan v3 §4.1/§4.7 (PV3): the two preview caps ride the same two surfaces
    // (同源数组展开，集合与顺序一致 — the §4.7 "两处声明的集合必须一致" invariant; the two consumers
    // each SPREAD this one source array, so they are not the same array instance, but the sets
    // and order can never drift): `preview.v1` whenever `config.preview` exists (mode loopback
    // OR on), `preview.lan.v1` only when mode is on. Absent (mode off) ⇒ caps stay
    // byte-identical to pre-PV3.
    // dir-plan v3.1 §2.2/§1.2 (P1a): `PREVIEW_ABS_HUB_CAP` rides the SAME `preview.v1` feature
    // gate (the mere presence of `config.preview`) — global-path admission is not a separate
    // setting, and the cap's only job is telling the UI it may widen recognition (C4).
    // dir-plan §3.5/§3.6 (P1b): `PREVIEW_DIR_HUB_CAP` rides the same gate AND the /proc probe —
    // the listing itself is `/proc/self/fd`-bound, so a platform without /proc never declares
    // it (the UI then never sends `dir=1` / `dirs:true`, and directories stay 415 fail-closed).
    const extraHubCaps: readonly string[] = [
      ...(config.spawn === undefined ? [] : [SPAWN_HUB_CAP, SPAWN_MODEL_HUB_CAP]),
      ...(config.preview === undefined
        ? []
        : [
            PREVIEW_HUB_CAP,
            PREVIEW_ABS_HUB_CAP,
            ...(previewProcFdAvailable() ? [PREVIEW_DIR_HUB_CAP] : []),
            // worktree-diff D21: `wtdiff.v1` rides the SAME preview gate AND the /proc probe —
            // the three-fd pin is /proc-bound, so a platform without it never declares the cap
            // (and hub.ts below never builds the routes at all).
            ...(previewProcFdAvailable() ? [WTDIFF_HUB_CAP] : []),
          ]),
      ...(config.preview === "on" ? [PREVIEW_LAN_HUB_CAP] : []),
    ];

    let supersede: SupersedeController | undefined;
    // web-hub-spawn plan §SP10: the spawn assembly handles, declared early (same lazy-closure
    // pattern as `supersede`) — the registry's `onVersion` below reads `spawnSup` long before
    // the assembly itself is constructed further down (after `commandRouter`).
    let spawnSup: SpawnSupervisor | undefined;
    let spawnRoutes: SpawnFrontendPort | undefined;
    let firstPromptFwd: FirstPromptForwarder | undefined;
    let recoverRotateOnHello: (() => void) | undefined;
    const registry = createRegistry({
      now,
      log,
      hubVersion: config.pluginVersion,
      // web-hub-spawn plan §SP10 (arch §4.3 “版本观察”): a MANAGED agent's plugin version never
      // reaches `supersede.observe` — a hub-spawned agent that merely loaded a newer pi-toolkit
      // (settings.json pointing at a newer package) would otherwise trigger a hub version
      // replacement that ends its own session with the stdin EOF; it only records a
      // `hint:"newer-plugin"` on the spawn record instead.
      onVersion: (pluginVersion, agentKey) => {
        if (spawnSup?.isManaged(agentKey) === true) {
          spawnSup.noteVersion(agentKey, pluginVersion);
          return;
        }
        supersede?.observe(pluginVersion, agentKey);
      },
      onTick: () => supersede?.tick(),
    });
    const history = createHistoryService({ registry, log });
    cleanup.push(async () => history.dispose());
    // fleet-drawer plan §5.2/§5.3 (F3b): the run-transcript service + its F3a file reader —
    // constructed unconditionally (per-request capability gating happens against the AGENT's
    // hello caps in the service's `requireCap`, §7.1; an agent without `runtx.*` caps is simply
    // refused there). The service owns no timers; `dispose()` drops its bus subscription and
    // every held watch. Both the runtime `close()` below and this startup-failure `cleanup`
    // entry dispose explicitly — the runtime path never runs the cleanup array (upload plan
    // #13's finding), so `close()` carries its own calls next to `history.dispose()`.
    const runFileReader = createRunFileReader({ now });
    const runTx = createRunTranscriptService({ registry, reader: runFileReader, log, now });
    cleanup.push(async () => {
      runTx.dispose();
      runFileReader.dispose();
    });
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
      // web-hub-spawn plan §SP10 (arch §7.1): the SAME source array feeds both this
      // agent-facing `hello_ack.caps` and the browser-facing `HubInfo.caps` below — the two
      // consumers each spread it (同源数组展开，集合/顺序一致，非同一实例), so the two surfaces are
      // frozen-protocol twins (§3.1 compat matrix) and can never drift.
      extraHubCaps,
      // C10/C8: every hello is also a rotate-intent recovery opportunity. The
      // callback is assigned before the first listener can accept a connection.
      onHello: () => recoverRotateOnHello?.(),
      // spawn-restore §9.3: restart acks carry the restore-candidate count for the TUI hint.
      restoreCount: () => spawnSup?.restoreCandidateCount() ?? 0,
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
      // ask-user-async plan §7.2 (P3): DIALOG_BG_HUB_CAPS joins the same two surfaces the same
      // way — it gates `dialogs.closed[].by === "background"` (agents degrade to "abort"
      // against hubs without the cap).
      // web-hub-spawn plan §SP10: `extraHubCaps` (spawn.v1 + spawn.model.v1, only when
      // `config.spawn` exists) is the same source array `agent-server.ts` spreads into
      // `hello_ack.caps` — 同源数组展开（集合/顺序一致，非同一实例），same append-only pattern as
      // UPLOAD/DIALOG_BG before it.
      // fleet-drawer plan §5.3 (F3b): RUNTX_HUB_CAPS joins the same two surfaces the same way
      // (§8.4's caps-coexist test pins the set equality).
      caps: [
        ...admin.caps(),
        ...P2_HUB_CAPS,
        ...UPLOAD_HUB_CAPS,
        ...DIALOG_BG_HUB_CAPS,
        ...RUNTX_HUB_CAPS,
        ...extraHubCaps,
      ],
    };
    const hubJson: HubJsonWriter = createHubJsonWriter(paths.hubJson, log);
    // web-hub-spawn plan §SP10 (arch §7.8 "/webhub stop、restart 在 TUI 提示中显示 hub.json 的
    // spawn.count"): the hub.json `spawn` summary — supervisor `liveCount` plus the policy
    // `reason` whenever the loopback view of the policy is currently refusing spawns. Seeded
    // into the step-⑦ `write()` below, then re-synced by the registry tick (change-gated).
    function spawnStatusOf(sup: SpawnSupervisor): { count: number; reason?: string } {
      const count = sup.liveCount();
      const policy = sup.policy("loopback:token", "loopback", "http", false);
      if (policy.allowed || policy.reason === undefined) return { count };
      return { count, reason: policy.reason };
    }
    let lastSpawnStatus: { count: number; reason?: string } | undefined;
    function syncSpawnStatus(): void {
      if (spawnSup === undefined) return;
      const next = spawnStatusOf(spawnSup);
      const prev = lastSpawnStatus;
      if (prev !== undefined && prev.count === next.count && prev.reason === next.reason) return;
      lastSpawnStatus = next;
      hubJson.patchSpawn(next);
    }

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
    // ---------------------------------------------------------------------
    // web-hub-spawn plan §SP10 (arch §4.1/§7): the managed-spawn assembly — the ONLY place
    // SP1–SP9's parts meet. Everything below runs only when `config.spawn` exists (feature
    // off ⇒ no reaper process, no spawns.json, no spawn key anywhere: caps/hub.json/FrontendDeps
    // stay byte-identical, arch §8.2's not-enabled matrix). Order (plan §SP10): probe →
    // store → reaper → dirs → first-prompt forwarder → supervisor → bounded init → routes.
    // `registry` (above) and `commandRouter` (above) are passed directly as the supervisor's /
    // forwarder's ports — no casts (#3 硬门槛: pinned by tests/web-hub/contract/types.test-d.ts).
    if (config.spawn !== undefined) {
      const spawnCfg = config.spawn;
      const spawnFiles = webHubSpawnFiles(paths.stateDir);
      // default-model plan §3/§3.1 (D1): the hub-wide 「新建会话默认模型」 preference — one
      // global value under <stateDir>/spawn-prefs.json, loaded synchronously HERE (hub boot,
      // the one and only load), served by GET /api/headless's `prefs` and written synchronously
      // by POST /api/headless/prefs. `close()` is a no-op by design (no pending writes), so it
      // needs no cleanup entry.
      const spawnPrefs = createSpawnPrefs({ file: spawnFiles.prefsJson, log });
      const platform = probePlatform(deps.spawnSeams?.probe);
      if (!platform.ok) {
        // §7.1 fail closed: caps still carry spawn.v1 (so the UI can explain), but supervisor
        // init() is a no-op past this point — no reaper, no spawns.json write, no fork.
        log.warn("web-hub: spawn platform probe failed — managed spawn disabled (fail closed)", {
          detail: platform.detail,
        });
      }
      const spawnStore = createSpawnStore({ file: spawnFiles.spawnsJson, log, now });
      const spawnReaper: Reaper = deps.spawnSeams?.reaper ?? createReaper({ log, now });
      const spawnDirs = createDirService({
        home: config.home,
        // SP3: `process.env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`` — source ② of known dirs.
        agentDir: process.env["PI_CODING_AGENT_DIR"] ?? `${config.home}/.pi/agent`,
        roots: spawnCfg.roots,
        registry,
        spawnHistory: () => spawnSup?.records() ?? [],
        now,
      });
      firstPromptFwd = createFirstPromptForwarder({
        router: commandRouter,
        now,
        log,
        audit: (r) => auditSpawn(log, r),
        // SP9 hand-off (plan §SP10): the forwarder owns the AUTHORITATIVE first-prompt state;
        // the supervisor's record slice (which its SSE `spawns` push renders, §6.4 Public
        // projection) is advisory only. Sync the slice from the authoritative view BEFORE
        // `noteSpawnChanged` so the SSE push and the GET snapshot (which reads
        // `firstPrompt.state()` through SP9's routes) can never disagree.
        onChange: (spawnId) => {
          const sup = spawnSup;
          if (sup === undefined) return;
          const view = firstPromptFwd?.state(spawnId);
          if (view !== undefined) {
            const rec = sup.records().find((r) => r.spawnId === spawnId);
            if (rec !== undefined) {
              rec.firstPrompt = { state: view.state, textLen: view.textLen, attempts: view.attempts };
            }
          }
          sup.noteSpawnChanged(spawnId);
        },
      });
      if (deps.spawnSeams?.wrapFirstPrompt !== undefined) {
        firstPromptFwd = deps.spawnSeams.wrapFirstPrompt(firstPromptFwd);
      }
      const rawSupervisor = createSpawnSupervisor({
        cfg: spawnCfg,
        registry,
        log,
        now,
        store: spawnStore,
        reaper: spawnReaper,
        dirs: spawnDirs,
        launcher: config.launcher,
        env: process.env,
        childUmask: deps.childUmask,
        platform,
        audit: (r) => auditSpawn(log, r),
        pluginVersion: config.pluginVersion,
        stderrDir: spawnFiles.logDir,
        onLive: (rec) => {
          if (rec.agentKey !== undefined && rec.sessionId !== undefined) {
            firstPromptFwd?.onLive(rec.spawnId, rec.agentKey, rec.sessionId, rec.control === true);
          }
        },
        onLink: (spawnId, linked) => firstPromptFwd?.onLink(spawnId, linked),
        onTerminal: (spawnId, reason) => firstPromptFwd?.onTerminal(spawnId, reason),
        // web-hub-delete-session plan v2 §2.2/§2.9: a managed record's death was confirmed and it
        // was actually deleted — drop the matching agent card too. `allowConnected:true` is safe
        // here specifically because `deleteRecord` only ever runs AFTER the supervisor's own
        // death confirmation (§2.1); a registry record still `live`/`claiming` at that instant
        // just means its socket-close bookkeeping hasn't caught up yet.
        onRemoved: (_spawnId, agentKey) => {
          if (agentKey !== undefined) registry.remove(agentKey, { allowConnected: true });
        },
        // web-hub-spawn-restore plan D9/§10.4: a restore confirmed the OLD process dead — its card
        // (if it ever reconnected to this hub) goes too; `agent_removed` lets the UI switch to the
        // successor. Same post-death-confirmation safety argument as `onRemoved` above.
        onPrevAgentGone: (_spawnId, prevAgentKey) => {
          registry.remove(prevAgentKey, { allowConnected: true });
        },
        restoreVetoFile: spawnFiles.restoreVeto,
        ...(deps.spawnSeams?.restoreStableMs === undefined ? {} : { restoreStableMs: deps.spawnSeams.restoreStableMs }),
        ...(deps.spawnSeams?.spawnFn === undefined ? {} : { spawnFn: deps.spawnSeams.spawnFn }),
      });
      spawnSup =
        deps.spawnSeams?.wrapSupervisor === undefined ? rawSupervisor : deps.spawnSeams.wrapSupervisor(rawSupervisor);
      // Bounded init (plan §SP10: store load + orphan recovery + launcher check ≤1s + reaper
      // ready ≤2s — 4s total budget); `withSignal` folds a startup abort into the same await.
      await withSignal(spawnSup.init(createReqDeadline(now, SPAWN_INIT_BUDGET_MS)), startup.signal);
      spawnRoutes = createSpawnRoutes({
        supervisor: spawnSup,
        dirs: spawnDirs,
        firstPrompt: firstPromptFwd,
        prefs: spawnPrefs,
        cfg: spawnCfg,
        limit: createCmdLimit(now),
        rejectAudit429: new Map(),
        log,
        now,
      });
      // SP13 (SP10 acceptance leftover P3): the shutdown entry itself is pushed AFTER the
      // frontend's own cleanup entry further below — reverse-order release then runs it BEFORE
      // `fe.close()`, the same domain-first order the runtime `close()` path uses (arch §7.6:
      // spawn subsystem shuts down before the HTTP face stops accepting). The push CANNOT live
      // here: it would run AFTER `fe.close()` in the startup-failure unwind (last pushed runs
      // first), contradicting the order it was documenting. A frontend factory that throws
      // before its own cleanup push leaves no shutdown call, but that path still ends the hub
      // process — the reaper child's stdin EOF (L3) bounds any leak, and no spawn request can
      // have arrived before `fe.listen()`.
    }
    // web-hub-upload plan §2.2/§2.6 (U3): the upload store is constructed unconditionally —
    // `webHub.uploads` gating happens through agent hello caps (§5.1), not here. Construction
    // never throws for an unusable root (the store disables itself and `begin` answers
    // `E_UPLOAD_DISABLED`); a synchronous throw (a bug, not a fs state) degrades uploads to 501
    // while the rest of the hub starts normally (plan §6 U3: "根校验失败 ⇒ 不传 store").
    let uploads: UploadStore | undefined;
    try {
      uploads = createUploadStore({
        root: webHubUploadsDir(config.home),
        now,
        log,
        audit: (e) => auditUpload(log, e),
      });
    } catch (err) {
      log.error("web-hub: upload store construction failed — /api/upload/* will answer 501", {
        error: String(err),
      });
      uploads = undefined;
    }
    // §5.4 (U3 P2-2): HTTP-layer (pre-store) upload reject counters, shared by both listeners and
    // merged into the 30-min `upload stats` row below.
    const uploadMetrics = createUploadHttpMetrics();
    // §2.6 #13: pushed BEFORE the frontend's own cleanup so the startup-failure reverse-order
    // path also closes the store after the frontend stops accepting requests.
    cleanup.push(async () => {
      await uploads?.close();
    });
    // web-hub-preview plan v3 §4.5/§6 (PV3): the preview route frontend — constructed only when
    // `config.preview` exists (PV1: mode "off" is the key's ABSENCE, so the cap declaration and
    // this construction read the same config key and can never disagree). Pure closure
    // building: no fs, no I/O, nothing that can fail. The limiter is deliberately NOT passed —
    // `createPreviewRoutes` defaults to its own private `CmdLimit` (§7-D14: preview bucket
    // churn must never evict the cmd/upload lines' buckets).
    //
    // dir-plan v3.1 §2.6 (P1a): BEFORE the routes are built, home/agentDir are resolved to
    // their literal+canonical forms (each may itself be a symlink; under global admission a
    // literal-only deny context would miss every canonical-path request). The resolution is
    // tracked by its OWN startup tracker (never the request instance, §2.4's parameter-flow
    // table), bounded at 2 s, and NEVER fails the hub — a degraded member keeps its literal
    // form + a path-free WARN, backstopped by the §2.3 global twins. agentDir shares the
    // spawn assembly's exact source (L512's SP3): `PI_CODING_AGENT_DIR ?? ${home}/.pi/agent`.
    let previewRoutes: ReturnType<typeof createPreviewRoutes> | undefined;
    let worktreeDiffRoutes: ReturnType<typeof createWorktreeDiffRoutes> | undefined;
    if (config.preview !== undefined) {
      const denyCtx = await withSignal(
        resolvePreviewDenyContext(
          { home: config.home, agentDir: process.env["PI_CODING_AGENT_DIR"] ?? `${config.home}/.pi/agent` },
          {
            tracker: createPreviewIoTracker(),
            now,
            log,
            signal: startup.signal,
          },
        ),
        startup.signal,
      );
      previewRoutes = createPreviewRoutes({
        mode: config.preview,
        denyCtx,
        uploadsRoot: webHubUploadsDir(config.home),
        registry,
        ...(uploads === undefined
          ? {}
          : {
              uploads: {
                openForPreview: (p, ctx) => uploads!.openForPreview(p, ctx),
              },
            }),
        log,
        now,
      });
      // dir-plan v3.1 §2.9 (P1a): ONE stable WARN per hub process when preview runs as root —
      // OS permission checks no longer bound what preview could read, only the denylist does
      // (the §2.7 boundary). Only `event` and `mode` ride the line — never a path or username.
      // `/webhub restart` produces a new process, which warns again by design.
      const uid = deps.getuid?.() ?? process.getuid?.();
      if (uid === 0) {
        log.warn(
          "web-hub preview: hub is running as root — OS permission checks no longer limit preview; only the denylist applies",
          { event: "preview.root_uid", mode: config.preview },
        );
      }
      // worktree-diff plan §1.6 (D3): the worktree-diff route frontend — same feature gate as
      // preview (`config.preview` exists) PLUS the /proc probe (D21: the three-fd pin is
      // /proc-bound; without /proc the routes are never built and `wtdiff.v1` never declared —
      // loopback AND LAN both fall back to the not-enabled matrix byte-identically). Shares the
      // SAME denyCtx object preview just resolved (§2.5) and takes the hub-side git runner
      // (D15). Pure closure building — nothing here can fail.
      if (previewProcFdAvailable()) {
        worktreeDiffRoutes = createWorktreeDiffRoutes({
          mode: config.preview,
          denyCtx,
          registry,
          run: deps.gitRunner ?? createGitRunner(),
          log,
          now,
        });
      }
    }
    // web-hub-delete-session plan v2 §2.9: the removal route frontend is wired UNCONDITIONALLY
    // (unlike spawn/preview/upload) — deleting an offline/stale TUI card never depended on
    // managed spawn being enabled at all; `managed` is simply absent when it isn't, and
    // `agentKey`-form requests fall straight to `registry.remove` (§2.4 row 6).
    const agentRemoveService = createAgentRemoveService({
      registry,
      ...(spawnSup !== undefined && config.spawn !== undefined
        ? { managed: { sup: spawnSup, lan: config.spawn.lan } }
        : {}),
      log,
      now,
    });
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
      uploadMetrics,
      agentRemove: agentRemoveService,
      ...(uploads === undefined ? {} : { uploads }),
      ...(spawnRoutes === undefined ? {} : { spawn: spawnRoutes }),
      ...(previewRoutes === undefined ? {} : { preview: previewRoutes }),
      ...(worktreeDiffRoutes === undefined ? {} : { worktreeDiff: worktreeDiffRoutes }),
      ...(lanDeps === undefined ? {} : { lan: lanDeps }),
      // fleet-drawer plan §5.3 (F3b): the run-transcript service — F4's `createRunRoutes`
      // reads it through this dep (absent ⇒ no `/api/run/*` wiring, byte-identical today).
      runTx,
    });
    cleanup.push(() => fe.close());
    // web-hub-preview plan v3 §4.5.1 (PV3): pushed right after the frontend's own entry so the
    // startup-failure reverse-order unwind runs preview dispose BEFORE `fe.close()` — the same
    // domain-first order the runtime `close()` path below uses; before the spawn push so the two
    // unwind in the same relative order as the runtime path (spawn shutdown → preview dispose →
    // fe.close).
    if (previewRoutes !== undefined) {
      cleanup.push(() => previewRoutes.dispose("startup-failure", createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    // worktree-diff plan §1.6 (D3): right after preview's push — the startup-failure unwind
    // disposes wtdiff AFTER preview and BEFORE `fe.close()`, mirroring the runtime order below.
    if (worktreeDiffRoutes !== undefined) {
      cleanup.push(() => worktreeDiffRoutes.dispose("startup-failure", createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    // web-hub-spawn §SP10 (startup-failure path only — the runtime close() path wires its own
    // call inside `close`): pushed right after the frontend's entry so reverse-order release
    // runs the spawn shutdown BEFORE `fe.close()` (arch §7.6's domain-first order; see the
    // comment at the spawn assembly above for why the push had to live here, SP13 P3).
    if (spawnSup !== undefined) {
      cleanup.push(() => spawnSup.shutdown(createReqDeadline(now, STEP_DEADLINE_MS)));
    }
    // §2.2.4: the startup scan never blocks listen(); `begin` answers 503 E_BUSY until it lands.
    if (uploads !== undefined) {
      void uploads
        .recover()
        .catch((err: unknown) =>
          log.error("web-hub: upload startup recovery rejected unexpectedly", { error: String(err) }),
        );
    }
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
      // web-hub-spawn plan §SP10 (arch §7.8): quiet also requires zero busy managed spawns —
      // replacing the hub under a busy web-spawned agent ends that session with the stdin EOF.
      // SP13（SP10 验收遗留评估）：busy 分量并入首条消息在途/退避重发计数（`sending` 状态）——
      // 一条尚未送达的首条消息同样会被 hub 替换的 stdin EOF 打断，绝不计为 quiet。
      managedBusy: () => (spawnSup?.busyCount() ?? 0) + (firstPromptFwd?.sendingCount() ?? 0),
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
    let initialSpawn: { count: number; reason?: string } | undefined;
    if (spawnSup !== undefined) {
      initialSpawn = spawnStatusOf(spawnSup);
      lastSpawnStatus = initialSpawn;
    }
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
      ...(initialSpawn === undefined ? {} : { spawn: initialSpawn }),
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
      // web-hub-spawn plan §SP10: ride the same 5s tick to re-sync hub.json's `spawn` summary
      // (pure in-memory compare; the file is only rewritten when the value actually changed).
      syncSpawnStatus();
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

    // web-hub-upload plan §2.6 (U3): upload lifecycle ticks (both unref'd). The 60s tick covers
    // idle in-flight invalidation (10 min TTL) and retries dirty `referencedAt` persistence
    // (sweep() always flushes dirty references first); the 30-min tick additionally writes the
    // §5.4 `upload stats` aggregate row. `sweep("tick")`'s committed-file TTL eviction is
    // exact-time based, so running it at both cadences changes nothing semantically.
    const uploadInflightTick =
      uploads === undefined
        ? undefined
        : setInterval(() => {
            void uploads
              .sweep("tick")
              .catch((err: unknown) => log.error("web-hub: upload sweep tick failed", { error: String(err) }));
          }, UPLOAD_INFLIGHT_TICK_MS);
    uploadInflightTick?.unref();
    const uploadSweepTick =
      uploads === undefined
        ? undefined
        : setInterval(() => {
            void uploads
              .sweep("tick")
              .then(() => {
                log.info("upload stats", {
                  audit: "upload-stats",
                  ...uploadStatsFields(uploads.stats(), uploadMetrics.snapshot()),
                });
              })
              .catch((err: unknown) => log.error("web-hub: upload sweep tick failed", { error: String(err) }));
          }, UPLOAD_SWEEP_TICK_MS);
    uploadSweepTick?.unref();

    const stopFence = startFence(paths.socketPath, owner.identity, (why) => {
      log.warn("socket fence lost: another hub owns the socket path", { why });
      void close("fence");
    });

    const idle = createIdleMonitor({
      counts: () => ({
        agents: Math.max(agentServer.connectionCount(), registry.list().length),
        sse: fe.clientCount(),
        // web-hub-spawn plan §SP10 (arch §7.8 "idle 自退"): a live managed child keeps the
        // hub alive — the absolute lifetime deadline (§6.5 maxLifetimeMinutes) is the backstop.
        headless: spawnSup?.liveCount() ?? 0,
      }),
      idleMs: Math.max(1, config.idleExitMinutes) * 60_000,
      now,
      onIdle: () => {
        log.info("idle timeout reached");
        void close("idle");
      },
    });

    function close(reason: string, opts?: { deadline?: ReqDeadline }): Promise<void> {
      if (closing !== undefined) return closing;
      // web-hub-spawn plan §SP10 (arch §7.6, review #4): one absolute deadline per close call —
      // the default covers every legacy caller; `installProcessHandlers`' crash path passes a
      // 2.5s one so the spawn subsystem degrades to "wait 0, SIGTERM now, persist once" before
      // the 3s hard exit. Individual steps below still carry their own `bounded()` STEP caps.
      const deadline: ReqDeadline = opts?.deadline ?? createReqDeadline(now, HUB_CLOSE_DEADLINE_MS);
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
        if (uploadInflightTick !== undefined) clearInterval(uploadInflightTick);
        if (uploadSweepTick !== undefined) clearInterval(uploadSweepTick);
        // web-hub-spawn plan §SP10 (arch §7.6): the spawn domain shuts down BEFORE the HTTP
        // face stops accepting — supervisor.shutdown is itself bounded (graceful wait budget
        // deriveBudget(r,3000,6500) ⇒ 0 on the crash deadline; verified SIGTERM to survivors;
        // store.flushAndClose still persists once even at zero budget; reaper stdin closes
        // LAST so its EOF-armed TERM→KILL escalation covers whatever outlives this process).
        // The forwarder is disposed first: unsent first prompts become `expired{hub_restart}`
        // (arch §4.6) while the bus is still live enough for the final `spawns` push.
        firstPromptFwd?.dispose("hub_restart");
        // web-hub-spawn-restore plan §10.4: reason → mode, in this ONE place (D2).
        if (spawnSup !== undefined) {
          const mode = config.spawn?.restore === true && RESTORE_REASONS.has(reason) ? "restore" : "terminate";
          await spawnSup.shutdown(deadline, { mode });
        }
        // web-hub-preview plan v3 §4.5.1 (PV3): preview dispose — after the spawn domain shuts
        // down, BEFORE the HTTP face stops accepting. Bounded (≤1s inside dispose itself:
        // verifier tasks aborted, every active request aborted "hub-close", head-sent streams
        // destroyed) and idempotent (shares the startup-failure promise).
        if (previewRoutes !== undefined) await bounded(previewRoutes.dispose("close", deadline));
        // worktree-diff plan §1.6 (D3): after preview dispose, still BEFORE the HTTP face stops
        // accepting — aborts every in-flight request and single-flight git execution, waits
        // ≤1 s, idempotent (shares the startup-failure promise).
        if (worktreeDiffRoutes !== undefined) await bounded(worktreeDiffRoutes.dispose("close", deadline));
        await bounded(fe.close());
        // web-hub-upload plan §2.6 #13 (U3): AFTER the frontend has stopped accepting requests
        // (srv.close + closeAllConnections), poison+reap in-flight upload dirs (committed files
        // are retained) before the rest of the teardown. The crash path may not reach this —
        // those orphans are the next startup's sweep("startup") job (§2.2.4).
        if (uploads !== undefined) await bounded(uploads.close());
        history.dispose();
        // fleet-drawer plan §5.3 (F3b): explicit runtime-path dispose (the cleanup array is
        // startup-failure-only, upload plan #13) — service first (drops the bus subscription
        // and held watches), then the reader (fails in-flight scans as `busy`).
        runTx.dispose();
        runFileReader.dispose();
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
    // web-hub-spawn plan §SP10 (arch §7.6 "uncaughtException" row): hand close() a 2.5s deadline —
    // the spawn subsystem's wait budget derives to 0, so it SIGTERMs the children immediately
    // and still flushes spawns.json once (sync, in-memory) before the hard exit below.
    const force = setTimeout(() => process.exit(1), STEP_DEADLINE_MS);
    force.unref();
    void hub
      .close("crash", { deadline: createReqDeadline(Date.now, STEP_DEADLINE_MS - 500) })
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
