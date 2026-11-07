import { webHubSpawnFiles } from "../protocol/paths.js";
import type { HubAssembly } from "./assembly.js";
import { auditSpawn } from "./audit.js";
import { createCmdLimit } from "./cmd-limit.js";
import { createPreviewIoTracker, resolvePreviewDenyContext } from "./preview/fs.js";
import { createReqDeadline } from "./req-deadline.js";
import { probePlatform } from "./spawn/config.js";
import { createCreatedDirsStore } from "./spawn/created-dirs.js";
import { createDirService } from "./spawn/dirs.js";
import { createFirstPromptForwarder } from "./spawn/first-prompt.js";
import { defaultHistorySyncFs } from "./spawn/history/fs.js";
import { makeCaptureSessionPathPin, makeVerifySessionPathPin } from "./spawn/history/pin.js";
import type { ManagedSessionView } from "./spawn/history/ports.js";
import { createHistoryService as createSpawnHistoryService } from "./spawn/history/service.js";
import { createMkdirService } from "./spawn/mkdir.js";
import { createSpawnPrefs } from "./spawn/prefs.js";
import { createReaper, type Reaper } from "./spawn/reaper.js";
import { createSpawnRoutes } from "./spawn/routes.js";
import { createSpawnStore, isTerminalSpawnState } from "./spawn/store.js";
import type { SpawnSupervisor } from "./spawn/supervisor.js";
import { createSpawnSupervisor, type InternalRecord } from "./spawn/supervisor.js";
/** web-hub-spawn §SP10: unchanged bounded supervisor startup budget. */
const SPAWN_INIT_BUDGET_MS = 4_000;

export async function assembleSpawn(ctx: HubAssembly): Promise<void> {
  const { config, deps, paths, log, now, startup, cleanup, startupStep } = ctx;
  const registry = ctx.registry!;
  const commandRouter = ctx.commandRouter!;
  const security = ctx.security;
  const spawnPlatform = ctx.spawnPlatform;
  const hubAgentDir = ctx.hubAgentDir;
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
    // created-dirs plan r2 §5: source ④ — folders made through the hub's mkdir inside
    // `spawn.roots`. Sync single-writer store, loaded once here; no cleanup entry (no timers).
    const createdDirsStore = createCreatedDirsStore({ file: spawnFiles.createdDirsJson, log, now });
    const platform = spawnPlatform ?? probePlatform(deps.spawnSeams?.probe);
    // session-history plan §4.8 step 1: the effective history switch — the config flag AND the
    // platform probe. Everything history-related below (service, sessionPathPin, forkSrcDir,
    // routes dep, the SPAWN_HISTORY_HUB_CAP tail above) keys off this one value, so `history`
    // off ⇒ the whole hub stays byte-identical (§5): no service, no cap, routes 404 as P-route
    // already guarantees, restore never captures a path pin.
    const historyOn = spawnCfg.history === true && platform.ok;
    // One shared sync-fs for the capture/verify pair (§4.5.6): pure object factory, no fd, no
    // timer — harmless to build even on the (platform-failed) off path, read only when on.
    const historySyncFs = defaultHistorySyncFs();
    if (!platform.ok) {
      // §7.1 fail closed: caps still carry spawn.v1 (so the UI can explain), but supervisor
      // init() is a no-op past this point — no reaper, no spawns.json write, no fork.
      log.warn("web-hub: spawn platform probe failed — managed spawn disabled (fail closed)", {
        detail: platform.detail,
      });
    }
    const spawnStore = createSpawnStore({ file: spawnFiles.spawnsJson, log, now });
    const rawReaper: Reaper = deps.spawnSeams?.reaper ?? createReaper({ log, now });
    const spawnReaper: Reaper = {
      ...rawReaper,
      get available() {
        return rawReaper.available;
      },
      start: (deadline) => {
        if (startup.signal.aborted) return Promise.reject(startup.signal.reason);
        return startupStep(rawReaper.start(deadline), () => rawReaper.close());
      },
    };
    const spawnDirs = createDirService({
      home: config.home,
      // SP3 source ② of known dirs: one resolved agentDir shared with history and preview.
      agentDir: hubAgentDir,
      roots: spawnCfg.roots,
      registry,
      spawnHistory: () => ctx.spawnSup?.records() ?? [],
      now,
      createdDirs: () => createdDirsStore.list(),
    });
    ctx.firstPromptFwd = createFirstPromptForwarder({
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
        const sup = ctx.spawnSup;
        if (sup === undefined) return;
        const view = ctx.firstPromptFwd?.state(spawnId);
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
      ctx.firstPromptFwd = deps.spawnSeams.wrapFirstPrompt(ctx.firstPromptFwd);
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
      // spawn-relaunch: the base for `locateSessionFile`'s default-session-dir fallback (same
      // expression as spawnDirs'/history's agentDir above).
      agentDir: hubAgentDir,
      // session-history plan §4.6.3/§4.8 (v3.4 X1): the restore re-fork's path-pin pair —
      // injected ONLY when history is on; absent ⇒ restore keeps its exact pre-history
      // behavior (no capture, no goLive verify, §5). Same `HistorySyncFs` for both halves.
      ...(historyOn
        ? {
            sessionPathPin: {
              capture: makeCaptureSessionPathPin(historySyncFs),
              verify: makeVerifySessionPathPin(historySyncFs),
            },
            forkSrcDir: spawnFiles.forkSrcDir,
          }
        : {}),
      onLive: (rec) => {
        if (rec.agentKey !== undefined && rec.sessionId !== undefined) {
          ctx.firstPromptFwd?.onLive(rec.spawnId, rec.agentKey, rec.sessionId, rec.control === true);
        }
      },
      onLink: (spawnId, linked) => ctx.firstPromptFwd?.onLink(spawnId, linked),
      onTerminal: (spawnId, reason) => ctx.firstPromptFwd?.onTerminal(spawnId, reason),
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
    ctx.spawnSup =
      deps.spawnSeams?.wrapSupervisor === undefined ? rawSupervisor : deps.spawnSeams.wrapSupervisor(rawSupervisor);
    // session-history plan §4.8 step 1: the history service — built only when `historyOn`, with
    // the P0-frozen dep shape. `managed`/`deathOf` read the supervisor LAZILLY per call (the
    // closures resolve `spawnSup` at call time, long after this assignment). The PD22 seams
    // (procFs / wrapHistory) arrive exclusively through `deps.spawnSeams` — never env/config.
    if (historyOn) {
      let historySvc = createSpawnHistoryService(
        {
          agentDir: hubAgentDir,
          forkSrcDir: spawnFiles.forkSrcDir,
          registry,
          managed: () => (ctx.spawnSup?.records() ?? []).map(toManagedView),
          deathOf: (id) => ctx.spawnSup?.deathOf(id),
          uid: deps.uid ?? process.getuid?.() ?? -1,
          hubPid: process.pid,
          now,
          log,
        },
        deps.spawnSeams?.historyProcFs === undefined && deps.spawnSeams?.historyProcSyncFs === undefined
          ? undefined
          : {
              ...(deps.spawnSeams?.historyProcFs === undefined ? {} : { procFs: deps.spawnSeams.historyProcFs }),
              ...(deps.spawnSeams?.historyProcSyncFs === undefined
                ? {}
                : { procSyncFs: deps.spawnSeams.historyProcSyncFs }),
            },
      );
      if (deps.spawnSeams?.wrapHistory !== undefined) historySvc = deps.spawnSeams.wrapHistory(historySvc);
      ctx.spawnHistory = historySvc;
      // v3.3 W3 / X3.4 #4 + verifier P1-a: the rollback dispose is registered HERE, at the
      // assignment — a failure in `spawnSup.init()`, `createSpawnRoutes()` or ANY later
      // assembly step must still unwind the service's fds/gens (previously the push lived
      // further down, past init/routes/frontend assembly, and leaked on those failures).
      // Idempotent (dispose shares one underlying promise) and bounded (the rollback's own
      // `bounded()` wrapper + dispose's internal HISTORY_DISPOSE_MS); the runtime close()
      // path awaits the SAME promise and never runs this cleanup array, so the two can never
      // double-run. Ordering: the spawn shutdown entry is pushed LATER (after the frontend's
      // own entries, keeping §SP13's domain-first unwind), so the reverse-order rollback
      // still runs supervisor shutdown BEFORE this dispose — the runtime close() order.
      cleanup.push(() => ctx.spawnHistory!.dispose());
    }
    // Verifier r2 P1: an EARLY idempotent supervisor-shutdown entry, registered immediately
    // after the history dispose entry above — a startup failure anywhere between here
    // (init/routes/uploads/frontend CONSTRUCTION — before the §SP13 entry further down)
    // used to roll back the history service with NO supervisor shutdown. Reverse order
    // still runs this shutdown BEFORE the history dispose, the runtime close() order.
    // Bounded (`ctx.stepDeadlineMs`) and never throws out of rollback; `shutdown` on a
    // supervisor whose init() rejected is safe (first-call-wins promise; the catch keeps a
    // rejection from aborting the unwind — the rollback's own `bounded()` also swallows).
    const supForRollback = ctx.spawnSup;
    let shutdownPromise: Promise<void> | undefined;
    ctx.spawnShutdownOnce = (): Promise<void> => {
      if (shutdownPromise === undefined) {
        shutdownPromise = supForRollback.shutdown(createReqDeadline(now, ctx.stepDeadlineMs)).catch(() => undefined);
      }
      return shutdownPromise;
    };
    cleanup.push(() => ctx.spawnShutdownOnce!());
    // Bounded init (plan §SP10: store load + orphan recovery + launcher check ≤1s + reaper
    // ready ≤2s — 4s total budget); `withSignal` folds a startup abort into the same await.
    await startupStep(ctx.spawnSup.init(createReqDeadline(now, SPAWN_INIT_BUDGET_MS)));
    startup.signal.throwIfAborted();
    // spawn-dirmkdir: the browse panel's 「新建文件夹」 endpoint reuses preview's §2.6 deny
    // chain, so its deny context resolves HERE when spawn is on — even with preview off (the
    // preview block below reuses this value when it runs). Same 2s/never-fails semantics as
    // the preview resolution (a degraded member keeps its literal form + a path-free WARN).
    ctx.previewDenyCtx = await startupStep(
      resolvePreviewDenyContext(
        { home: config.home, agentDir: hubAgentDir },
        {
          tracker: createPreviewIoTracker(),
          now,
          log,
          signal: startup.signal,
        },
      ),
    );
    startup.signal.throwIfAborted();
    const mkdirSvc = createMkdirService({
      denyCtx: ctx.previewDenyCtx,
      tracker: createPreviewIoTracker(),
      log,
      now,
      identify: true,
      // 2026-10-16 用户拍板（「新建文件夹」可以和终端一样是 775）: the hub's own 0o077 umask must
      // not mask web-created folders — main.ts's captured pre-hub umask becomes the explicit
      // post-create mode (best-effort inside the service: failure ⇒ warn, still ok:true).
      ...(deps.childUmask === undefined ? {} : { dirMode: 0o777 & ~deps.childUmask }),
    });
    ctx.spawnRoutes = createSpawnRoutes({
      ...(security === undefined ? {} : { security }),
      supervisor: ctx.spawnSup,
      dirs: spawnDirs,
      firstPrompt: ctx.firstPromptFwd,
      prefs: spawnPrefs,
      cfg: spawnCfg,
      limit: createCmdLimit(now),
      rejectAudit429: new Map(),
      log,
      now,
      mkdir: mkdirSvc,
      createdDirs: createdDirsStore,
      // session-history plan §4.8: `historyOn` already required it — absent keeps the route
      // surface byte-identical to history-off (P-route's §5 gate reads `deps.history`).
      ...(ctx.spawnHistory === undefined ? {} : { history: ctx.spawnHistory }),
      // web-hub-privacy plan v2.1 (P1, 「Fork 继承」): a hub-initiated fork inherits a locked
      // source session's mark — the store was created/loaded ABOVE this assembly, so the
      // dependency is available exactly when the feature is on (off ⇒ byte-identical).
      ...(ctx.privacyStore === undefined ? {} : { privacy: ctx.privacyStore }),
    });
    if (config.feishuBot !== undefined) {
      ctx.botSpawn = {
        dirs: spawnDirs,
        supervisor: ctx.spawnSup,
        firstPrompt: ctx.firstPromptFwd,
        prefs: spawnPrefs,
        registerTimeoutS: spawnCfg.registerTimeoutS,
        restore: spawnCfg.restore === true,
        relaunch: (...args) => ctx.spawnSup!.relaunch(...args),
        lookup: (id) => {
          const record = ctx.spawnSup!.records().find((r) => r.spawnId === id);
          return record === undefined
            ? undefined
            : {
                ...(record.agentKey === undefined ? {} : { agentKey: record.agentKey }),
                ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
                terminal: isTerminalSpawnState(record.state),
              };
        },
      };
    }
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
}

/** session-history plan §4.8 step 1: the supervisor's `InternalRecord` → the P0-frozen
 * `ManagedSessionView` the history service's occupancy checks consume — a FIELD-BY-FIELD copy
 * (including `procStartTicks`, C2's pid+starttime pairing) so the service can never reach a
 * mutable record through it. Terminal states keep their exact strings; `sessionTarget` rides
 * along so a restore re-fork's record still counts as occupying its target session. */
function toManagedView(r: InternalRecord): ManagedSessionView {
  const view: ManagedSessionView = { spawnId: r.spawnId, state: r.state };
  if (r.agentKey !== undefined) view.agentKey = r.agentKey;
  if (r.pid !== undefined) view.pid = r.pid;
  if (r.procStartTicks !== undefined) view.procStartTicks = r.procStartTicks;
  if (r.sessionId !== undefined) view.sessionId = r.sessionId;
  if (r.sessionFile !== undefined) view.sessionFile = r.sessionFile;
  if (r.sessionTarget !== undefined) view.sessionTarget = { ...r.sessionTarget };
  return view;
}

// web-hub-spawn plan §SP10 (arch §7.8 "/webhub stop、restart 在 TUI 提示中显示 hub.json 的
// spawn.count"): the hub.json `spawn` summary — supervisor `liveCount` plus the policy
// `reason` whenever the loopback view of the policy is currently refusing spawns. Seeded
// into the step-⑦ `write()` below, then re-synced by the registry tick (change-gated).
export function spawnStatusOf(sup: SpawnSupervisor): { count: number; reason?: string } {
  const count = sup.liveCount();
  const policy = sup.policy("loopback:token", "loopback", "http", false);
  if (policy.allowed || policy.reason === undefined) return { count };
  return { count, reason: policy.reason };
}
export function syncSpawnStatus(ctx: HubAssembly): void {
  const hubJson = ctx.hubJson!;
  if (ctx.spawnSup === undefined) return;
  const next = spawnStatusOf(ctx.spawnSup);
  const prev = ctx.lastSpawnStatus;
  if (prev !== undefined && prev.count === next.count && prev.reason === next.reason) return;
  ctx.lastSpawnStatus = next;
  hubJson.patchSpawn(next);
}
