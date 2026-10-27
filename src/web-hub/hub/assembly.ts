import type { HubPaths } from "../protocol/paths.js";
import type { createAgentServer } from "./agent-server.js";
import type { createCmdLimit } from "./cmd-limit.js";
import type { createCommandRouter } from "./commands.js";
import type { createFeishuLinks } from "./feishu/link.js";
import type { FeishuBotService, FeishuSpawnPort } from "./feishu/service.js";
import type { HubJsonWriter } from "./hub-json.js";
import type { StartHubDeps } from "./hub.js";
import type { createIdleMonitor } from "./idle.js";
import type { Scope } from "./lifecycle.js";
import type {
  AvatarRoutes,
  HttpFrontend,
  HubConfig,
  HubEvent,
  HubInfo,
  HubLog,
  LanFrontendDeps,
  ProxyService,
} from "./ports.js";
import type { FsAdmitter, PreviewDenyContext } from "./preview/admit.js";
import type { createPreviewRoutes } from "./preview/routes.js";
import type { PrivacyStore } from "./privacy/store.js";
import type { createRegistry } from "./registry.js";
import type { createScheduleService } from "./schedule/service.js";
import type { createSecurityEventBus } from "./security-events.js";
import type { probePlatform } from "./spawn/config.js";
import type { FirstPromptForwarder } from "./spawn/first-prompt.js";
import type { HistoryService as SpawnHistoryService } from "./spawn/history/ports.js";
import type { SpawnFrontendPort } from "./spawn/ports.js";
import type { SpawnSupervisor } from "./spawn/supervisor.js";
import type { SupersedeController } from "./supersede.js";
import type { UploadStore } from "./uploads.js";
import type { createVersionInfoService } from "./version-info.js";
import type { createWorktreeDiffRoutes } from "./worktree-diff/routes.js";
import type { createWorktreeGraphRoutes } from "./worktree-graph/routes.js";
import type { XsAliasBinding } from "./xs/router.js";
export interface HubAssemblyBase {
  config: HubConfig;
  hubAgentDir: string;
  deps: StartHubDeps;
  paths: HubPaths;
  log: HubLog;
  now: () => number;
  startup: AbortController;
  rootScope: Scope;
  cleanup: Array<() => Promise<void>>;
  startupStep<T>(pending: Promise<T>, disposeLate?: (value: T) => Promise<void> | void): Promise<T>;
  stepDeadlineMs: number;
  isClosing(): boolean;
  stopBot(): Promise<void>;
  bounded(p: Promise<void>, ms?: number): Promise<void>;
}
/** Per-startHub state. Late handles are initialized before the agent socket is exposed.
 * Helpers read stable phase outputs only after the root publishes them; callbacks read
 * mutable handles from this same object, never a snapshot of a later assignment. */
export interface HubAssembly extends HubAssemblyBase {
  bot: FeishuBotService | undefined;
  botSpawn: FeishuSpawnPort | undefined;
  scheduleHub?: ReturnType<typeof createScheduleService> | undefined;

  supersede: SupersedeController | undefined;

  // web-hub-spawn plan §SP10: the spawn assembly handles, declared early (same lazy-closure
  // pattern as `supersede`) — the registry's `onVersion` below reads `spawnSup` long before
  // the assembly itself is constructed further down (after `commandRouter`).

  spawnSup: SpawnSupervisor | undefined;

  spawnRoutes: SpawnFrontendPort | undefined;

  firstPromptFwd: FirstPromptForwarder | undefined;

  // session-history plan §4.8 (P-int): P-scan's history service, constructed inside the spawn
  // assembly only when `config.spawn.history === true` AND the platform probe passes; disposed
  // on BOTH shutdown paths (v3.3 W3 — see the close()/cleanup pushes below).

  spawnHistory: SpawnHistoryService | undefined;

  /** Verifier r2 P1: the ONE idempotent, bounded supervisor shutdown both rollback entries
   * share (assigned inside the spawn assembly; `SpawnSupervisor.shutdown` itself is
   * first-call-wins, so a second entry's call resolves through the same promise). */

  spawnShutdownOnce: (() => Promise<void>) | undefined;

  recoverRotateOnHello: (() => void) | undefined;

  // Initialize every late teardown binding before exposing admin shutdown on the socket.

  supersedeWaitCancels: Set<() => void>;

  supersedeTimer: ReturnType<typeof setInterval> | undefined;

  unsubscribeSupersedeOnDialogs: () => void;

  stopFence: () => void;

  idle: Pick<ReturnType<typeof createIdleMonitor>, "stop">;

  tick: ReturnType<typeof setInterval> | undefined;

  rotateScan: ReturnType<typeof setInterval> | undefined;

  uploadInflightTick: ReturnType<typeof setInterval> | undefined;

  uploadSweepTick: ReturnType<typeof setInterval> | undefined;

  uploads: UploadStore | undefined;

  // spawn-dirmkdir: preview's §2.6 deny context, hoisted to assembly scope — `POST
  // /api/headless/mkdir`'s admission reuses the SAME deny chain, so spawn-on hubs resolve it
  // even when preview itself is off (the preview block below reuses the resolved value
  // instead of resolving twice). `undefined` when neither feature is on.

  previewDenyCtx: PreviewDenyContext | undefined;

  botPreview: FsAdmitter | undefined;

  // web-hub-privacy plan v2.1 (P1): DECLARED here with every other early assembly binding —
  // `close()` reads it (the write-chain drain below) and can run BEFORE the assembly point
  // further down ever executes (a `let` at the assembly point would be a TDZ throw in that
  // window — the startup-gate tests pin exactly this).

  privacyStore: PrivacyStore | undefined;

  previewRoutes: ReturnType<typeof createPreviewRoutes> | undefined;

  worktreeDiffRoutes: ReturnType<typeof createWorktreeDiffRoutes> | undefined;

  worktreeGraphRoutes: ReturnType<typeof createWorktreeGraphRoutes> | undefined;

  lanDeps: LanFrontendDeps | undefined;

  lanLoginCore: import("./ports.js").LanLoginCore | undefined;

  // web-hub-version plan §3.7: assigned just before the frontend is built; close() may run
  // earlier (admin close during startup), hence `?.` there.

  versionService: ReturnType<typeof createVersionInfoService> | undefined;

  // web-hub-proxy (X1c): declared with the other early bindings — `close()` is a hoisted
  // function that can run (admin close during startup) before the assembly point below.
  // Constructed ONLY when `config.proxy` exists, AFTER `fe.listen()` (it needs the real ports).

  proxyService: ProxyService | undefined;

  unsubscribeProxyRevoke: () => void;

  agentServer: ReturnType<typeof createAgentServer> | undefined;

  fe: HttpFrontend;

  botOnHello: ((key: string) => void) | undefined;

  /** scheduled-reports H1: the bot's event listener, captured so sched_bound frames (which
   *  never reach the registry) can be forwarded as FeishuServiceEvents (§7.5). */

  botSchedEventListener: ((event: never) => void) | undefined;
  avatarRoutes: AvatarRoutes | undefined;
  registry?: ReturnType<typeof createRegistry>;
  info?: HubInfo;
  hubJson?: HubJsonWriter;
  commandRouter?: ReturnType<typeof createCommandRouter>;
  cmdLimit?: ReturnType<typeof createCmdLimit>;
  security?: ReturnType<typeof createSecurityEventBus> | undefined;
  botDialogSlots?: Map<string, Extract<HubEvent, { type: "dialogs" }>> | undefined;
  feishuLinks?: ReturnType<typeof createFeishuLinks> | undefined;
  httpPort: number;
  spawnPlatform?: ReturnType<typeof probePlatform> | undefined;
  htmlEnabled: boolean;
  xsAlias?: XsAliasBinding;
  xsAliasDegraded?: { reason: string; path: string };
}
export function createHubAssembly(base: HubAssemblyBase): HubAssembly {
  return {
    ...base,
    httpPort: 0,
    htmlEnabled: false,
    avatarRoutes: undefined,
    bot: undefined,
    botSpawn: undefined,
    supersede: undefined,
    spawnSup: undefined,
    spawnRoutes: undefined,
    firstPromptFwd: undefined,
    spawnHistory: undefined,
    spawnShutdownOnce: undefined,
    recoverRotateOnHello: undefined,
    supersedeWaitCancels: new Set<() => void>(),
    supersedeTimer: undefined,
    unsubscribeSupersedeOnDialogs: (): void => {},
    stopFence: (): void => {},
    idle: { stop() {} },
    tick: undefined,
    rotateScan: undefined,
    uploadInflightTick: undefined,
    uploadSweepTick: undefined,
    uploads: undefined,
    previewDenyCtx: undefined,
    botPreview: undefined,
    privacyStore: undefined,
    previewRoutes: undefined,
    worktreeDiffRoutes: undefined,
    worktreeGraphRoutes: undefined,
    lanDeps: undefined,
    lanLoginCore: undefined,
    versionService: undefined,
    proxyService: undefined,
    unsubscribeProxyRevoke: () => {},
    agentServer: undefined,
    fe: {
      listen: async () => ({ port: 0 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        probe: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    },
    botOnHello: undefined,
    botSchedEventListener: undefined,
  };
}
