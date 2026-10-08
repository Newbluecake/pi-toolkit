/**
 * web-hub agent client wiring (plan §包 D — index.ts; arch §3.2).
 *
 * `wireWebHub` runs once per `activate()` (post-guard, gated by
 * `settings.webHub.enabled` in src/index.ts — package I). It registers every
 * handler up front; handlers are synchronous and return on their first line
 * while not attached. print/json modes never attach ⇒ zero sockets, zero
 * spawns, zero git calls.
 *
 * Session lifetime (spike K4, two paths):
 *  1. same module instance (`/new`, `/resume`, `/fork`): `session_shutdown`
 *     detaches (session_detached + 10s grace), the re-run activate finds the
 *     global connection with the same implVersion and reuses the socket; the new
 *     `session_start` attaches and sends a fresh `session` frame;
 *  2. re-evaluated module (`/reload`): new implVersion ⇒ the old instance says
 *     `bye{handover}`, the new one reconnects with the same agentId / new epoch.
 * An activate without a matching session_start takes no connection.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ObserveRunResult, RunObserverListener, RunSnapshot, RunStatus } from "../../core/types.js";
import { isTerminalStatus } from "../../core/status.js";
import { defaultPluginInfoDeps, pluginRoot, readPluginInfo } from "../../hud/plugin-info.js";
import type { HubConfig, HubLanConfig } from "../hub/ports.js";
import type { HubSpawnConfig } from "../protocol/spawn.js";
import { PREVIEW_DEFAULT_MODE, type PreviewMode } from "../protocol/preview.js";
import {
  FORWARDED_EVENTS,
  type AgentKind,
  type LanInfoPayload,
  type LanReqFrame,
  type SessionInfo,
} from "../protocol/messages.js";
import { resolveHubPaths, type HubPaths } from "../protocol/paths.js";
import { pidAlive } from "../protocol/pid.js";
import { UPLOAD_AGENT_CAPS, RUNTX_AGENT_CAPS, HOLD_AGENT_CAPS, HOLD_CAP } from "../protocol/version.js";
import type { LanStatus } from "../protocol/lan.js";
import {
  acquireConnection,
  currentConnection,
  MODULE_INSTANCE,
  newAdminRid,
  type BindingPort,
  type HubConnection,
} from "./connection.js";
import { createRunTranscripts, type RunTranscriptPort } from "./run-transcript.js";
import { createEventTap } from "./event-tap.js";
import { formatLanStatusLines, type LanStatusPaths } from "./lan-status.js";
import { formatUiStatusLines } from "./ui-status.js";
import { packageUiDistDir } from "../protocol/paths.js";
import type { UiStatus } from "../hub/ui-root.js";
import { resolveJitiCli, spawnHub, type LauncherPlan } from "./launcher.js";
import { MaskedInputComponent, runPasswdPrompt, type PasswdOutcome } from "./passwd-prompt.js";
import { verifyProcIdentity, readStartTicksNow } from "./proc-identity.js";
import { ctlLivenessProbe, restartHub, type RestartOutcome } from "./restart.js";
import { buildBranchReply, buildSnapshotReply } from "./snapshot.js";
import { fleetFingerprint, projectFleet, readStatus } from "./status.js";
import { createGitRunner, type GitRunner } from "../../git/run.js";
import { createWorktreeSampler } from "./worktree-sampler.js";
import { bashJobsLightFingerprint, bashJobsRowSignature, projectBashJobs, selectJobs } from "./bash-jobs.js";
import { createBashJobsSampler, type BashJobsSource } from "./bash-jobs-sampler.js";
import type { BashJobsWire } from "../protocol/messages.js";
import { todoLightFingerprint } from "./todo.js";
import type { TodoState } from "../../todo/state.js";
import { projectQuota, quotaFingerprint } from "./quota-sampler.js";
import type { QuotaWire } from "../protocol/messages.js";
import type { ProviderVerdict } from "../../quota/ladder.js";
import { createCommandCapture, type CommandCapturePort } from "./command-capture.js";
import { createCommandHandler, type InputEventLike, type MessageStartLike } from "./commands.js";
import { createCommandLedger } from "./ledger.js";
import { createQueueMirror } from "./queue-mirror.js";
import { createCompactionState } from "./compaction-state.js";
import { createOriginEntry, registerOriginEntryRenderer } from "./origin-entry.js";
import { createHoldBuffer, holdWired } from "./hold.js";
import { createHoldDriver, type HoldDriver, type TurnEndLike } from "./hold-driver.js";
import { appendToolTimingEntries, registerToolTimingEntryRenderer } from "./tool-timing.js";
import { createBuiltinBridge, type BuiltinBridgeDeps } from "./builtin-bridge.js";
import { classifyCommand, listSlashCommands } from "./slash.js";
import { modelsFingerprint, projectModels } from "./models.js";
import { effectivePolicy, parameterizedBuiltinPolicy } from "./command-policy.js";
import { createDialogBridge } from "./dialogs.js";
import { clearRestoreVetoSync, createAdminCommands, type AdminCommands } from "./admin-cmds.js";
import type { AskUserRemotePort } from "../../ask-user/remote.js";

export interface WebHubLanSettings {
  enabled: boolean;
  port: number;
  extraHosts: string[];
  trustProxyFrom: string[];
  externalOrigins: string[];
} // I 在 settings.ts 预定义五个 webHub.lan.* 键（§9.1），校验后按这个形状传进来；LE 只消费，不做自己的校验

/**
 * web-hub-spawn plan §SP2 / arch v2 §6.2: the settings-layer shape of `webHub.spawn` — the seven
 * `HubSpawnConfig` policy fields plus `enabled`. Only `enabled === true` puts a `spawn` key into
 * `HubConfig` (`buildHubConfig` below); the feature's wire-level off state is the key's absence
 * (response matrix, arch §8.2).
 */
export interface WebHubSpawnSettings extends HubSpawnConfig {
  enabled: boolean;
  /** web-hub-spawn-restore plan D18: settings-layer default `true`; crosses the wire as
   * `HubSpawnConfig.restore` only inside an enabled spawn block. */
  restore: boolean;
  /** web-hub-session-history plan §3.7 (P-cfg): settings-layer default `true`; crosses the
   * wire as `HubSpawnConfig.history` only inside an enabled spawn block. */
  history: boolean;
}

export interface WebHubSettings {
  enabled: boolean;
  autoStart: boolean;
  port: number;
  idleExitMinutes: number;
  nodeLoader: string;
  control?: boolean;
  remoteAskUser?: boolean;
  webCommands?: boolean;
  webCommandPolicy?: Record<string, "allow" | "confirm" | "deny">;
  /** web-hub-upload plan §0/§5.1: file-upload availability. `"on"` (default) advertises both
   * `upload.v1` and `upload.lan.v1`; `"loopback"` advertises only `upload.v1` (LAN uploads
   * disabled); `"off"` advertises neither. Ignored (treated as `"off"`) when `control` is false. */
  uploads?: "on" | "loopback" | "off";
  /** web-hub-preview plan v3 §4.1/U1 (PV1): content-preview availability (`GET /api/preview`).
   * Default `"on"` (U1: the user is the LAN's only user and explicitly accepts §5.1's risk);
   * `"loopback"` keeps the endpoint off LAN; `"off"` leaves `HubConfig.preview` unset, keeping
   * `PI_WEBHUB_CONFIG` deep-equal to the pre-preview shape. Non-live like the rest of webHub.*:
   * change needs `/reload` then `/webhub restart`. */
  preview?: PreviewMode;
  /** web-hub-fleet-drawer plan §4.4 (F2): subagent-transcript (fleet drawer) availability.
   * `"all"` (default) advertises `runtx.v1` + `runtx.lan.v1`; `"loopback"` only `runtx.v1`;
   * `"off"` neither. This is the READ plane — deliberately independent of `control`. */
  subagentTranscript?: "all" | "loopback" | "off";
  /** quota-web plan §2/D8: `StatusInfo.quota` availability. Default `true`; `false` ⇒ the agent
   * never threads a `quota` getter into `WebHubDeps` at all — the sampler never runs, the
   * `quota` field never appears on the wire (byte-equal to the pre-feature shape). Independent of
   * `settings.quota.enabled` (the underlying `QuotaService` itself): with no verdicts the field
   * is already absent, this flag is purely the web-hub-side kill switch. */
  quota?: boolean;
  /** web-hub-steer-recall plan §2/§4.7 (A6) / arch §11 Q1: hold busy web steer/followUp in the
   *  agent-side buffer until pi's next queue drain so the browser can recall/re-edit them.
   *  Default `true`; `false` (or `control:false`) ⇒ no driver, no hold handlers, no `hold.v1`
   *  cap, no `status.held` — byte-identical to the pre-feature agent (W1/W2). Non-live like the
   *  rest of webHub.* (captured at activate; change → /reload). */
  steerRecall?: boolean;
  /** 未设置或 `enabled:false` ⇒ `HubConfig.lan` 不被构造，`PI_WEBHUB_CONFIG` 与 P1 深相等（§11 LE 行）。 */
  lan?: WebHubLanSettings;
  /** web-hub-spawn §SP2: headless spawn 策略；未设置或 `enabled:false` ⇒ `HubConfig.spawn` 不被构造，
   * `PI_WEBHUB_CONFIG` 与 spawn 合入前深相等（arch §8.2 未启用矩阵）。 */
  spawn?: WebHubSpawnSettings;
} // I 在 settings.ts `import type` 并 re-export（D 不改 settings.ts）

export type StopResult =
  | { ok: true; escalatedTo: "L2" | "L3" | "L4" }
  | { ok: false; reason: "unknown_run" }
  | { ok: false; reason: "already_terminal"; status: string }
  | { ok: false; reason: "stop_failed"; escalatedTo: "L2" | "L3" | "L4" };
export interface QueryControlPort {
  get(runId: string): { status: string; diag?: { sessionFile?: string; finalLeafId?: string } } | undefined;
  steer(runId: string, text: string): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
  stop(runId: string, cause: "user_stop"): Promise<StopResult>;
  /** fleet-drawer §4.4 (F2): live-run branch peek for transcript snapshots — a structural
   * passthrough of `QueryService.branchOf` (undefined for unknown/terminal/handle-less runs). */
  branchOf?(runId: string): readonly unknown[] | undefined;
  /** fleet-drawer §4.4 (F2): attach a live observer to a running run's session stream —
   * `QueryService.observe`'s synchronous four-state verdict. */
  observe?(runId: string, l: RunObserverListener): ObserveRunResult;
}
export interface WebHubDeps {
  settings: WebHubSettings;
  fleet: () => readonly RunSnapshot[];
  query?: () => QueryControlPort | undefined; // I: () => holder.current?.query.list() ?? []
  fleetTypeOf?: (runId: string) => string | undefined;
  /** D14/§3.1: whether `askUser.enabled` in the host settings — gates `dialog.v1` broadcast
   * alongside `settings.remoteAskUser`. Unset ⇒ treated as enabled (D10 default-on posture). */
  askUserEnabled?: () => boolean;
  /** P1 fix (#32 C12 review): the same `Set<string>` `wrapCommandApi`'s `registerCommand` proxy
   * writes real toolkit command names into, handed straight through to `createCommandCapture` so
   * `owns()`/`settleArm()` answer from true registration state, not from `arm()` history. */
  ownedCommandNames?: Set<string>;
  /** todo-web plan §3.3 (T3): live main-session todo state for the `StatusInfo.todo`
   *  projection. Unset (todo.enabled=false ⇒ `wireTodo` never ran) ⇒ the field is never
   *  set — the status frame stays byte-equal to the pre-feature shape. */
  todo?: () => TodoState;
  /** bash-jobs-panel plan §3.7/§3.8 (包 A, D3-4): late-bound bash-jobs source port. `current()`
   *  re-reads the holder on every call (NEVER captures a manager — each session_start/stack
   *  rebuild swaps the instance, and a disposed manager's `list()` keeps returning stale
   *  entries); unset (bashJobsEnabled=false in src/index.ts) ⇒ the whole slot stays absent. */
  bashJobs?: {
    current(): BashJobsSource | undefined;
    retentionMs(): number;
  };
  /** quota-web plan §2 (包 quota-web, D3): live getter for the main session's `QuotaService`
   *  verdicts — same late-bound-closure precedent as `todo` above (`src/index.ts` threads
   *  `() => holder.current?.quota?.verdicts() ?? []`). Unset (webHub.quota=false, or the quota
   *  feature itself produces no verdicts) ⇒ the `StatusInfo.quota` field is never set. */
  quota?: () => readonly ProviderVerdict[];
  hubMainPath?: string; // 默认 fileURLToPath(new URL("../hub/main.ts", import.meta.url))
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // ---- test seams (optional; production leaves them unset) ----
  netConnect?: typeof import("node:net").connect;
  spawnImpl?: typeof import("node:child_process").spawn;
  /** worktree-web plan §4.4 (W3): test seam for `createWorktreeSampler`'s `GitRunner` —
   * production leaves this unset (`createGitRunner()` is used). */
  gitRunner?: GitRunner;
  /** worktree-web plan §4.3/§4.4 (W3): test seam for `createWorktreeSampler`'s `realpath` —
   * production leaves this unset (`fs.promises.realpath`, real I/O). Overriding it in tests
   * avoids a genuine libuv round trip the fake-timer `advanceTimersByTimeAsync` loop can't
   * deterministically wait out under load. */
  gitRealpath?: (p: string) => Promise<string>;
  paths?: HubPaths;
  buildInfo?: () => Promise<{ pluginVersion: string; buildId: string }>;
  argv1?: string;
}

export interface WebHubStatusView {
  state: "off" | "connecting" | "live" | "backoff" | "loader" | "proto";
  agentKey?: string;
  hubVersion?: string;
  httpPort?: number;
  lastError?: string;
  stopMarker?: "absent" | "stopped" | "unknown";
  /** acc32-B8 (plan §6.7.2): the marker's own timestamp, when `stopMarker === "stopped"` and the
   * marker file's JSON carried one — lets `/webhub status` render "hub stopped since <time>".
   * `statusLineText`'s compact HUD marker ignores this. */
  stopMarkerAt?: number;
  /** acc32-B8: the `readStopMarkerSync` error code, when `stopMarker === "unknown"` — lets
   * `/webhub status` render "stop marker unreadable (<code>)". */
  stopMarkerCode?: string;
  /** acc32-B8: the stop-marker file path, when `stopMarker === "unknown"` — lets `/webhub status`
   * render "check <path>". */
  stopMarkerPath?: string;
  attached: boolean;
}

export type LanAdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unavailable" } // not live, or hub didn't advertise lan.v1
  | { ok: false; reason: "rejected"; code: string; message: string };

export interface WebHubControl {
  readonly capture?: CommandCapturePort;
  internalExec(args: string, ctx: unknown): Promise<{ ok: true } | { ok: false; code: "E_UNSUPPORTED" }>;
  askUserRemote(): AskUserRemotePort | undefined;
  readonly admin: AdminCommands;
  status(): WebHubStatusView;
  /** http://127.0.0.1:<port>/#t=<token>; port from hello_ack (live) or hub.json (pid alive); else a hint. */
  url(): { url: string } | { hint: string };
  /** S1 LAN admin surface (plan §8.1/§8.2/§9.3; wired by LI's `/webhub passwd|unlock|restart`). */
  lan: {
    /** LAN status lines for `/webhub status` (plan §9.3), read straight from `hub.json` on disk
     * — works even when the admin socket isn't live. */
    statusLines(): string[];
    /** Raw `lan_req{op:"info"}` result; callers decide how to render `initialPassword` (never here —
     * see `lan-status.ts`'s `formatInitialPasswordLines`, keyed on UI mode). */
    info(): Promise<LanAdminResult<LanInfoPayload | undefined>>;
    unlock(): Promise<LanAdminResult<void>>;
    /** Runs the full interactive TUI flow (username → masked password twice → `lan_req passwd`). */
    changePasswordInteractive(): Promise<PasswdOutcome>;
    restart(): Promise<RestartOutcome>;
  };
  /** vue-plan.md v2.1 §2.3（P5b）：Vue UI 状态行，同样直接读 `hub.json`（无需 admin socket）。 */
  ui: {
    statusLines(): string[];
  };
}

export const WEB_HUB_STATUS_KEY = "pi-subagent:web-hub";
const BUILD_INFO_WAIT_MS = 3_000;

const STATUS_EVENTS = new Set(["agent_start", "agent_end", "agent_settled", "turn_end", "session_compact"]);
// worktree-web plan §4.4: these two also deserve a fresher worktree sample than the baseline
// interval (a turn/subagent finishing is a natural point for repo state to have moved).
const WT_KICK_EVENTS = new Set(["turn_end", "agent_settled"]);
const SESSION_EVENTS = new Set(["model_select", "thinking_level_select", "session_info_changed"]);

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export function wireWebHub(pi: ExtensionAPI, deps: WebHubDeps): WebHubControl {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const settings = deps.settings;
  const modelsEnabled = settings.control !== false && settings.webCommands !== false;
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const paths =
    deps.paths ??
    resolveHubPaths({
      home,
      uid: process.getuid?.() ?? 0,
      xdgRuntimeDir: env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "" ? env.XDG_RUNTIME_DIR : undefined,
    });
  const hubMainPath = deps.hubMainPath ?? fileURLToPath(new URL("../hub/main.ts", import.meta.url));
  const argv1 = deps.argv1 ?? process.argv[1];

  let ctx: ExtensionContext | undefined;
  let conn: HubConnection | undefined;
  let attached = false;
  let generation = 0;
  let sessionReason = "startup";
  let lastLeaf: string | null | undefined;
  let lastFleetFp: string | undefined;
  // todo-web plan §3.3 (T3): the todo fingerprint gate — same lifecycle as lastFleetFp
  // (reset on session_start so the first tick after a /new・/resume・/fork always re-aligns).
  let lastTodoFp: string | undefined;
  // bash-jobs-panel plan §3.7 (包 A): the bash-jobs light-fingerprint gate + its per-row
  // signature diff (which rows a fingerprint edge should kick) — same lifecycle as lastTodoFp.
  let lastBashFp: string | undefined;
  let lastBashSigs: Map<string, string> | undefined;
  // quota-web plan §2 (D3): same lifecycle as lastTodoFp/lastBashFp — reset on session_start.
  let lastQuotaFp: string | undefined;
  let connGen = 0;
  let lastModelsKey: string | undefined;
  let modelsTick = 0;
  let tick: NodeJS.Timeout | undefined;
  let statusText: string | undefined;
  let buildInfo: Promise<{ pluginVersion: string; buildId: string }> | undefined;
  let launcher: LauncherPlan | { error: string } | undefined;
  // §4.6 "/webhub __exec": one-shot, 5s-TTL nonce armed by the builtin bridge's `/new` dispatch
  // and consumed by `internalExec` below (acc32-B4 — this closure slot never existed before, so
  // the stub always returned E_UNSUPPORTED regardless of what nonce the terminal typed back in).
  let pendingExec: { op: string; nonce: string; expiresAt: number } | undefined;
  const EXEC_NONCE_TTL_MS = 5_000;
  const armExec = (op: string): string => {
    const nonce = randomBytes(16).toString("hex");
    pendingExec = { op, nonce, expiresAt: now() + EXEC_NONCE_TTL_MS };
    return nonce;
  };
  const takeExec = (op: string, nonce: string): boolean => {
    const p = pendingExec;
    if (p === undefined || p.op !== op || p.nonce !== nonce || now() > p.expiresAt) return false;
    pendingExec = undefined;
    return true;
  };

  const tap = createEventTap(
    (e, droppable) => {
      const c = conn;
      if (c === undefined) return;
      c.send({ t: "ev", seq: c.nextSeq(), e }, { droppable });
    },
    {
      now,
      setTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return { cancel: () => clearTimeout(t) };
      },
      currentSeq: () => conn?.seq ?? 0,
      // C0 frozen call-site slot (plan §12.3): identity no-op until C2 wires the real dialog-
      // correlation logic into `event-tap.ts`. Pre-adding this key here — rather than leaving C2
      // to add it during W2 — keeps C1's (this file's own owner from W2) and C2's parallel edits
      // to non-overlapping keys of this same options object.
      attributePrompt: (e) => e,
    },
  );

  // worktree-web plan §4.3/§4.4 (W3): per-activate sampler, closure-local state only
  // (AGENTS.md: no module-scope mutable state). `isLive`/`onChange` are late-bound refs
  // into this same closure's `conn`/`publishStatus` — defined after `publishStatus` exists,
  // referenced here through the `publishStatus` call wrapped in a thunk so declaration order
  // doesn't matter.
  const wtSampler = createWorktreeSampler({
    run: deps.gitRunner ?? createGitRunner(),
    home,
    now,
    isLive: () => conn?.status().state === "live",
    onChange: () => publishStatus(),
    ...(deps.gitRealpath !== undefined ? { realpath: deps.gitRealpath } : {}),
  });

  // bash-jobs-panel plan §3.7 (包 A): per-activate sampler, closure-local state only — same
  // late-bound isLive/onChange refs as wtSampler above (declaration order resolved at call time).
  // All tail I/O goes through the deps.bashJobs holder port (D3-4); `retentionMs` is read fresh
  // from settings every call, never cached.
  const bashSampler = createBashJobsSampler({
    source: () => deps.bashJobs?.current(),
    retentionMs: () => deps.bashJobs?.retentionMs() ?? 0,
    now,
    isLive: () => conn?.status().state === "live",
    onChange: () => publishStatus(),
  });
  /** `readStatus`'s bash-jobs projection closure (hot path: source read + in-memory list + cache
   *  — zero fs I/O; the sampler owns every read). Rows and tails provably share one source
   *  generation: `tails(src.gen)` reconciles on mismatch (D3-4 ③/④). */
  const bashJobsProjection = (): BashJobsWire | undefined => {
    const d = deps.bashJobs;
    if (d === undefined) return undefined;
    const src = d.current();
    if (src === undefined) return undefined;
    return projectBashJobs(src.list(), bashSampler.tails(src.gen), now(), d.retentionMs());
  };

  // quota-web plan §2 (D3): pure, stateless projection — `QuotaService.verdicts()` is already a
  // synchronous in-memory read, so there is no sampler state to own here (see quota-sampler.ts's
  // module docstring). Re-evaluated fresh on every call; the 1Hz tick below only decides whether
  // a given evaluation is worth publishing.
  const quotaProjection = (): QuotaWire | undefined => {
    const d = deps.quota;
    if (d === undefined) return undefined;
    return projectQuota(d(), now());
  };

  const commandLedger = createCommandLedger();
  const queueMirror = createQueueMirror();
  const compactionState = createCompactionState(pi);
  const originEntry = createOriginEntry(pi);

  // ── web-hub-steer-recall plan §4.7 (A6): hold wiring ──────────────────────────────────────
  // `holdOn` is the ONE gate (plan §8.1): it decides cap advertisement, handler registration and
  // the `status.held` projection together. `false` (⇐ `steerRecall:false` or `control:false`)
  // ⇒ no driver, no hold handlers, no cap, no held rows — the agent is byte-identical to the
  // pre-feature agent on the wire (W1/W2). The buffer is the process-level `Symbol.for` bag
  // (plain data, survives /reload — P-core's `hold.ts`); creating it here even when off is
  // allocation-only and invisible on the wire.
  const holdOn = holdWired(settings);
  const holdBuffer = createHoldBuffer();
  /** PURE read of the current link (plan C1 / §4.7 step 2): same shape as `isLiveWithCap` — read
   *  at hold-decision time and at every tick, never cached, never bound to a link generation. */
  const holdCap = (): boolean => conn?.status().state === "live" && (conn?.caps.includes(HOLD_CAP) ?? false);
  /** `true` ⇔ the link is live AND the hub demonstrably lacks `hold.v1` — the ONLY case where
   *  the ctl projection filters the hold vocabulary (§4.7 step 11): a hub without the cap has a
   *  CLOSED CtlItemSchema that would drop the whole frame on a `state:"held"` row. While
   *  disconnected nothing is filtered — the slot keeps the full projection and replays
   *  correctly to whatever hub comes next (D3). */
  const capKnownAbsent = (): boolean =>
    holdOn && conn?.status().state === "live" && !(conn?.caps.includes(HOLD_CAP) ?? false);

  // fleet-drawer §4.4 (F2): the run-transcript service. Enabled only while the live link's
  // hello_ack.caps carries runtx.v1 AND webHub.subagentTranscript ≠ "off" (§3.2 compat:
  // anything else is silently ignored); reads go through the F1 QueryService passthroughs.
  const runTxEnabled = (): boolean =>
    (settings.subagentTranscript ?? "all") !== "off" && (conn?.caps.includes("runtx.v1") ?? false);
  const runTxPort = (): RunTranscriptPort | undefined => {
    const q = deps.query?.();
    if (q === undefined) return undefined;
    return {
      info: (runId) => {
        const s = q.get(runId);
        if (s === undefined) return undefined;
        const info: { status: string; terminal: boolean; sessionFile?: string; finalLeafId?: string } = {
          status: s.status,
          terminal: isTerminalStatus(s.status as RunStatus),
        };
        if (s.diag?.sessionFile !== undefined) info.sessionFile = s.diag.sessionFile;
        if (s.diag?.finalLeafId !== undefined) info.finalLeafId = s.diag.finalLeafId;
        return info;
      },
      branch: (runId) => q.branchOf?.(runId),
      observe: (runId, l) => q.observe?.(runId, l) ?? { kind: "unknown" },
    };
  };
  const runTx = createRunTranscripts({
    port: runTxPort,
    trySend: (frame, o) => conn?.trySend(frame, o) ?? "not_live",
    enabled: runTxEnabled,
    now,
    setTimer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { cancel: () => clearTimeout(t) };
    },
  });
  // One capture instance for the whole control (`WebHubControl.capture`, the builtin bridge's
  // §4.9 echo and the commands slot's `output` badge) — the return value used to build a second,
  // disconnected one (todo #32 C11 wiring).
  const commandCapture = createCommandCapture(deps.ownedCommandNames);
  // Late-bound: the bridge is constructed before the command handler (which it needs for the
  // §4.6/D22 async-completion channel), so sendLate goes through this ref. Before the handler
  // exists (or after a settle raced ahead) the late frame is simply dropped — bounded, and the
  // ledger already carries `completion:"unknown"` from the immediate reply.
  const bridgeLate: { current?: BuiltinBridgeDeps["sendLate"] } = {};
  const builtinBridge = createBuiltinBridge({
    pi,
    getCtx: () => ctx,
    getSessionId: () => safe(() => ctx?.sessionManager.getSessionId() ?? "", ""),
    now,
    capture: () => commandCapture,
    overrides: () => deps.settings.webCommandPolicy,
    sendLate: (frame, result) => bridgeLate.current?.(frame, result),
    armExec,
  });
  registerOriginEntryRenderer(pi);
  // tool-duration plan: the TUI must render NOTHING for the per-turn timing entries (the
  // renderer's `undefined` return is pi's sanctioned "no content" — see tool-timing.ts).
  registerToolTimingEntryRenderer(pi);

  /** Tool-duration plan: persist the turn's completed tool timings as bounded custom entries.
   *  Drains the tap; never throws, never blocks (appendToolTimingEntries swallows everything). */
  const flushToolTimings = (): void => {
    try {
      appendToolTimingEntries(pi, tap.drainToolTimings());
    } catch {
      /* a failed flush must never affect the turn */
    }
  };

  const readFleet = (): readonly RunSnapshot[] => {
    try {
      return deps.fleet();
    } catch {
      return [];
    }
  };

  const setStatusLine = (text: string | undefined): void => {
    const c = ctx;
    if (c === undefined || text === statusText) return;
    try {
      if (c.mode !== "tui" || !c.hasUI) return;
      c.ui.setStatus(WEB_HUB_STATUS_KEY, text);
      statusText = text;
    } catch {
      /* stale ctx */
    }
  };

  /** §4.7 step 14 (A6) + arch §11.1: the `held N` line is rendered from the driver's CURRENT
   *  held count; the exact marker is the literal `web held N` (see `statusLineText`). Called from
   *  the driver's publish callback (every buffer mutation) and the connection-state path so the
   *  count on screen can never drift from `status.held`. No-op in non-TUI modes / not attached
   *  (setStatusLine's own guards) and a no-op while hold is off (`held: 0` ⇒ plain marker). */
  const refreshStatusLine = (): void => {
    const v = conn?.status() ?? { state: "off" as const, attached: false };
    setStatusLine(statusLineText(v, readStatusTheme(ctx), { held: holdDriver?.heldCount() ?? 0 }));
  };

  const publishStatus = (): void => {
    const c = conn;
    const x = ctx;
    if (c === undefined || x === undefined) return;
    const s = readStatus(
      x,
      tap,
      readFleet(),
      queueMirror,
      deps.todo,
      () => wtSampler.current(),
      deps.bashJobs !== undefined ? bashJobsProjection : undefined,
      deps.quota !== undefined ? quotaProjection : undefined,
      // §4.7 step 10 (A6): held rows ride the OPEN status slot — gated ONLY on holdWired, never
      // on holdCap() (D3): a disconnect keeps the full projection in the slot, and an old hub's
      // open StatusInfoSchema ignores the unknown fields instead of dropping the frame.
      holdOn
        ? () => {
            const sid = safe(() => ctx?.sessionManager.getSessionId() ?? "", "");
            return { items: holdBuffer.project(sid, now()), rev: holdBuffer.rev(), epoch: MODULE_INSTANCE };
          }
        : undefined,
    );
    lastLeaf = s.leafId;
    c.setSlot("status", { t: "status", ...s });
  };

  const projectCurrentModels = (x: ExtensionContext) =>
    projectModels({
      available: () => x.modelRegistry.getAvailable(),
      registryError: () => {
        const getError = (x.modelRegistry as unknown as { getError?: () => string | undefined }).getError;
        return typeof getError === "function" ? getError.call(x.modelRegistry) : undefined;
      },
      scoped: () => safe(() => x.scopedModels, []),
      current: () => safe(() => x.model, undefined),
      policy: (name) => effectivePolicy(parameterizedBuiltinPolicy(name, deps.settings.webCommandPolicy), false),
      shadowed: (name) =>
        classifyCommand(pi, name)?.kind !== undefined && classifyCommand(pi, name)?.kind !== "builtin",
      now,
    });

  /** The only session-frame construction path. Model snapshots are deliberately recomputed from
   * live ctx here so stale pi getters become an explicit error snapshot rather than disappearing. */
  const emitSession = (mode: "attach" | "update", override?: Partial<SessionInfo>): void => {
    const c = conn;
    const x = ctx;
    if (c === undefined || x === undefined) return;
    const info: SessionInfo = { ...sessionInfo(x, sessionReason), ...override };
    if (modelsEnabled) {
      const models = projectCurrentModels(x);
      info.models = models;
      lastModelsKey = `${connGen}|${info.sessionId}|${modelsFingerprint(models)}`;
    } else {
      delete info.models;
      lastModelsKey = undefined;
    }
    if (mode === "attach") c.attach(binding, info);
    else c.setSlot("session", { t: "session", ...info });
  };

  const refreshModelsIfChanged = (): void => {
    if (!modelsEnabled || !attached || conn === undefined || ctx === undefined) return;
    const models = projectCurrentModels(ctx);
    const sessionId = safe(() => ctx?.sessionManager.getSessionId() ?? "", "");
    const key = `${connGen}|${sessionId}|${modelsFingerprint(models)}`;
    if (key === lastModelsKey) return;
    emitSession("update");
  };

  const publishSession = (override?: Partial<SessionInfo>): void => {
    emitSession("update", override);
  };

  const onTick = (): void => {
    const c = conn;
    const x = ctx;
    if (!attached || c === undefined || x === undefined) return;
    try {
      // spike K7④: idle custom_message never reaches extensions — a leaf move is the only signal.
      const leaf = x.sessionManager.getLeafId();
      if (leaf !== lastLeaf) publishStatus();
    } catch {
      /* stale ctx */
    }
    // todo-web plan §3.3 (T3): todo changes never fire an extension event either
    // (Task* tool results settle inside the enqueue queue), so the same 1Hz tick
    // carries a light-fingerprint gate — publish only on real change (lastFleetFp
    // pattern). `deps.todo` reads only our own closure, so no stale-ctx guard needed.
    const todoFp = deps.todo !== undefined ? todoLightFingerprint(deps.todo()) : undefined;
    if (todoFp !== lastTodoFp) {
      lastTodoFp = todoFp;
      publishStatus();
    }
    // quota-web plan §2 (D3): `QuotaService` has no events either — same 1Hz tick fingerprint
    // gate (quotaFingerprint excludes the ever-moving `at` field, see its own docstring).
    if (deps.quota !== undefined) {
      const quotaFp = quotaFingerprint(quotaProjection());
      if (quotaFp !== lastQuotaFp) {
        lastQuotaFp = quotaFp;
        publishStatus();
      }
    }
    // bash-jobs-panel plan §3.7 (包 A, D3-1): the manager has no events, so the same 1Hz tick
    // carries a light-fingerprint gate over the selectJobs result (running logBytes and
    // second-level elapsed stay OUT; terminal logBytes — the footer patch — is IN, R3-2). A
    // change publishes the status frame IMMEDIATELY (state is authoritative, tails follow) and
    // kicks exactly the changed rows into the sampler.
    if (deps.bashJobs !== undefined) {
      const src = deps.bashJobs.current();
      let fp = "";
      const sigs = new Map<string, string>();
      if (src !== undefined) {
        const selected = selectJobs(src.list(), now(), deps.bashJobs.retentionMs());
        fp = bashJobsLightFingerprint(selected, now());
        for (const r of selected.rows) sigs.set(r.jobId, bashJobsRowSignature(r, now()));
      }
      if (fp !== lastBashFp) {
        const changed: string[] = [];
        for (const [id, sig] of sigs) {
          if (lastBashSigs === undefined || lastBashSigs.get(id) !== sig) changed.push(id);
        }
        lastBashFp = fp;
        lastBashSigs = sigs;
        bashSampler.kick(changed);
        publishStatus();
      }
    }
    try {
      commandHandler.onPendingSample(x.hasPendingMessages());
    } catch {
      /* stale ctx */
    }
    commandHandler.releaseSettledSteerLocks();
    const rows = projectFleet(readFleet(), now(), deps.fleetTypeOf);
    const fp = fleetFingerprint(rows);
    if (fp !== lastFleetFp) {
      lastFleetFp = fp;
      c.setSlot("fleet", { t: "fleet", runs: rows, ...(rows.omitted !== undefined ? { omitted: rows.omitted } : {}) });
      wtSampler.kick(); // worktree-web plan §4.4: a fleet shape change (e.g. a pi-agent-* run
      // starting/ending) is worth a fresher worktree sample sooner than the baseline interval.
    }
    runTx.tick(); // §3.3 #3/#4: 1Hz gap retries + endedPending redelivery
    // worktree-web plan §4.3/§4.4 (W3): baseline/backoff scan cadence + staleMin recompute,
    // driven off this same existing 1Hz tick (no second interval is created for it).
    if (wtSampler.tick(now())) publishStatus();
    // bash-jobs-panel plan §3.7 (包 A, D3-2): needs-sample recomputation + round scheduling off
    // the same 1Hz tick; completions publish through the sampler's onChange instead.
    if (bashSampler.tick(now())) publishStatus();
    modelsTick += 1;
    if (modelsTick % 5 === 0) refreshModelsIfChanged();
    // §4.7 step 8 (A6): the hold driver's 1Hz housekeeping — HOLD_MAX_MS expiry, the 15 s
    // cap-unavailable grace, buffer sweep. Never touches the phase machine (P-core §5.6).
    holdDriver?.onTick(x);
  };

  const publishCtl = (): void => {
    const c = conn;
    if (c === undefined) return;
    const sessionId = safe(() => ctx?.sessionManager.getSessionId() ?? "", "");
    // §4.7 step 11 (A6): filter the hold vocabulary ONLY while the link is live against a hub
    // that demonstrably lacks hold.v1 (its closed CtlItemSchema would drop the whole frame);
    // while disconnected the full projection stays in the slot (D3). With hold off this is
    // always `{filterHeld:false}` — byte-identical output to the no-opts call.
    c.setSlot("ctl", { ...commandLedger.frame(sessionId, MODULE_INSTANCE, now(), { filterHeld: capKnownAbsent() }) });
  };

  const commandHandler = createCommandHandler({
    pi,
    getCtx: () => ctx,
    getSessionId: () => safe(() => ctx?.sessionManager.getSessionId() ?? "", ""),
    ledger: commandLedger,
    queueMirror,
    compactionState,
    originEntry,
    builtinBridge,
    controlEnabled: () => settings.control !== false,
    now,
    send: (frame) => conn?.send(frame),
    onChanged: () => {
      publishStatus();
      publishCtl();
      // commands.ts's own hold-buffer mutations (prompt held 0→1, recall 1→0, dispatch/return)
      // bypass the driver's publish callback, so the `web held N` marker refreshes here too —
      // setStatusLine's text dedupe makes this a no-op for every unrelated ledger mutation.
      refreshStatusLine();
    },
    setTimer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { cancel: () => clearTimeout(t) };
    },
    ...(deps.query !== undefined ? { query: deps.query } : {}),
    // web-hub-steer-recall §4.7 step 3 (A6): the hold driver, looked up lazily so the driver can
    // be constructed after the handler it dispatches through (no temporal-dead-zone cycle).
    // `owner` (Y4/Y7.3) scopes every ledger lookup this handler makes to THIS module instance.
    ...(holdOn ? { hold: () => holdDriver, owner: MODULE_INSTANCE } : {}),
  });
  bridgeLate.current = (frame, result) => commandHandler.handleBridgeLate(frame, result);

  // §4.7 step 4 (A6): the hold driver — `undefined` while `holdWired(settings)` is false (no
  // handlers registered below, no cap advertised, prompts take the native path unconditionally).
  // `setRefTimer` is REF'd (v4.3 Y3 / T-REF): the driver uses it exclusively inside its ≤200 ms
  // bounded confirm phase — a wait pi is actually awaiting — while every other timer this wiring
  // owns (commands' 30s/3s display timers, the 1Hz tick) stays unref'd so `pi -p` never wedges.
  const holdDriver: HoldDriver | undefined = holdOn
    ? createHoldDriver({
        buffer: holdBuffer,
        owner: MODULE_INSTANCE,
        getSessionId: () => safe(() => ctx?.sessionManager.getSessionId() ?? "", ""),
        holdCap,
        dispatchToPi: (item) => commandHandler.dispatchHeld(item),
        onReturned: (items) => {
          for (const it of items) {
            commandLedger.updatePrompt(
              it.cmdId,
              { promptState: "returned", ...(it.reason !== undefined ? { reason: it.reason } : {}) },
              now(),
            );
          }
        },
        publish: () => {
          publishStatus();
          publishCtl();
          refreshStatusLine();
        },
        now,
        setRefTimer: (ms, fn) => {
          const t = setTimeout(fn, ms);
          return { cancel: () => clearTimeout(t) };
        },
        nextMacrotask: () => new Promise<void>((r) => setImmediate(r)),
      })
    : undefined;

  /** §3.2 commands slot: the web's slash palette (policy + §4.9 output badge), refreshed on
   * (re)connect and `resources_discover` (extensions loaded mid-session change the list). */
  const publishCommands = (): void => {
    const c = conn;
    if (c === undefined) return;
    c.setSlot("commands", {
      t: "commands",
      epoch: MODULE_INSTANCE,
      items: listSlashCommands(pi, {
        ...(deps.settings.webCommandPolicy !== undefined ? { overrides: deps.settings.webCommandPolicy } : {}),
        output: (name) => (commandCapture.owns?.(name) === true ? "captured" : undefined),
      }),
    });
  };
  const remoteAskUserEnabled = (): boolean =>
    settings.control !== false && settings.remoteAskUser !== false && (deps.askUserEnabled?.() ?? true);
  const dialogBridge = createDialogBridge({
    setSlot: (kind, f) => conn?.setSlot(kind, f),
    isAttached: () => attached,
    notify: (message) => {
      const x = ctx;
      try {
        if (x === undefined || x.mode !== "tui" || !x.hasUI) return;
        x.ui.notify(message);
      } catch {
        /* a stale ctx / notify failure must never affect the reply already sent */
      }
    },
    now,
    enabled: remoteAskUserEnabled(),
    epoch: MODULE_INSTANCE,
    send: (frame) => conn?.send(frame),
    // ask-user-async §7.2 (P3): live hub caps — drives the by:"background" → "abort" downgrade
    // in dialogs.ts while the connected hub lacks `dialog.bg.v1` (empty until hello_ack lands).
    hubCaps: () => conn?.caps ?? [],
  });
  const binding: BindingPort = {
    onCmd: (frame) => {
      // dialog_answer/dialog_cancel are routed straight to the dialog bridge (C2's `dialogs.ts`) —
      // never through `commandHandler`, which would otherwise have to special-case them right back
      // out again (they never carry a ledger entry: the dialog bridge owns its own open/closed
      // bookkeeping, §5).
      if (frame.cmd.op === "dialog_answer" || frame.cmd.op === "dialog_cancel") {
        dialogBridge.handle(frame);
        return;
      }
      commandHandler.handle(frame);
    },
    onSuperseded: (frame) => {
      // §6.7.3 forced path: the terminal user must hear that the hub is being replaced under
      // them — and when dialogs are open, that web answering is suspended and the terminal is
      // where to answer (the web form goes read-only-suspended on the same frame).
      const x = ctx;
      if (x === undefined) return;
      try {
        const open = typeof frame.openDialogs === "number" && frame.openDialogs > 0;
        x.ui.notify(
          open
            ? `web-hub upgrading to v${frame.nextVersion}${frame.forced === true ? " (forced)" : ""} · answer ask_user in the terminal`
            : `web-hub upgrading to v${frame.nextVersion}${frame.forced === true ? " (forced)" : ""}`,
          "info",
        );
      } catch {
        /* stale ctx */
      }
    },
    onSnapshotReq: (rid) => {
      const c = conn;
      const x = ctx;
      if (!attached || c === undefined || x === undefined) return;
      tap.flush(); // pending deltas get their seq BEFORE the snapshot's seq is read
      const snaps = readFleet();
      c.send(
        buildSnapshotReply(rid, {
          seq: c.seq,
          ctx: x,
          tap,
          status: readStatus(
            x,
            tap,
            snaps,
            queueMirror,
            deps.todo,
            () => wtSampler.current(),
            deps.bashJobs !== undefined ? bashJobsProjection : undefined,
            deps.quota !== undefined ? quotaProjection : undefined,
          ),
          fleet: projectFleet(snaps, now(), deps.fleetTypeOf),
        }),
      );
    },
    onBranchReq: (rid, maxBytes) => {
      const c = conn;
      const x = ctx;
      if (!attached || c === undefined || x === undefined) return;
      c.send(buildBranchReply(rid, x, maxBytes));
    },
    onRunTxReq: (frame) => {
      if (attached) runTx.onReq(frame);
    },
    onRunWatch: (frame) => {
      if (attached) runTx.onWatch(frame.runId, frame.on);
    },
    onStateChange: (v) => {
      runTx.onLink(v.state === "live"); // §3.3 #3: link-up retries gaps / pending ends
      if (attached) setStatusLine(statusLineText(v, readStatusTheme(ctx), { held: holdDriver?.heldCount() ?? 0 }));
      // web-hub-steer-recall §4.7 step 9 (A6): a fresh live link immediately gets the CURRENT
      // status/ctl projections (slot replay happened before notify() in connection.ts, so this
      // re-setSlot lands after it) — filtered per `capKnownAbsent()` so a no-cap hub still gets
      // a parseable ctl. Non-live states never republish here (W11).
      if (attached && v.state === "live") {
        publishStatus();
        publishCtl();
      }
    },
  };

  const getBuildInfo = (): Promise<{ pluginVersion: string; buildId: string }> => {
    buildInfo ??= (deps.buildInfo ?? defaultBuildInfo)();
    const fallbackVersion = packageVersionSync();
    return new Promise((resolve) => {
      const fallback = { pluginVersion: fallbackVersion, buildId: `${fallbackVersion}@unknown` };
      const t = setTimeout(() => resolve(fallback), BUILD_INFO_WAIT_MS);
      t.unref();
      buildInfo!.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve(fallback);
        },
      );
    });
  };

  const resolveLauncher = (): LauncherPlan | { error: string } => {
    if (launcher !== undefined) return launcher;
    const r = resolveJitiCli({ argv1, override: settings.nodeLoader });
    launcher = r.ok ? { execPath: process.execPath, jitiCli: r.jitiCli, argv1: argv1 ?? "" } : { error: r.reason };
    return launcher;
  };

  const buildHubConfig = (info: { pluginVersion: string; buildId: string }): HubConfig => {
    const config: HubConfig = {
      v: 1,
      home,
      port: settings.port,
      idleExitMinutes: settings.idleExitMinutes,
      pluginVersion: info.pluginVersion,
      buildId: info.buildId,
    };
    if (argv1 !== undefined) config.launcher = [process.execPath, argv1];
    if (settings.lan?.enabled === true) {
      const lan: HubLanConfig = {
        port: settings.lan.port,
        extraHosts: settings.lan.extraHosts,
        trustProxyFrom: settings.lan.trustProxyFrom,
        externalOrigins: settings.lan.externalOrigins,
      };
      config.lan = lan;
    }
    // web-hub-spawn §SP2: only an explicitly enabled spawn block reaches the hub — `undefined`
    // and `enabled:false` alike leave `config.spawn` unset, so the hub's "not enabled" response
    // matrix (arch §8.2) stays byte-identical to a pre-spawn hub. Exactly the nine policy
    // fields (the ninth, `history`, is session-history plan §3.7/P-cfg); `enabled` itself
    // never crosses the wire.
    if (settings.spawn?.enabled === true) {
      const spawn: HubSpawnConfig = {
        roots: settings.spawn.roots,
        maxProcesses: settings.spawn.maxProcesses,
        maxPerPrincipal: settings.spawn.maxPerPrincipal,
        ratePerMinute: settings.spawn.ratePerMinute,
        maxLifetimeMinutes: settings.spawn.maxLifetimeMinutes,
        registerTimeoutS: settings.spawn.registerTimeoutS,
        lan: settings.spawn.lan,
        // web-hub-spawn-restore plan §10.5: the eighth field, only inside an enabled block.
        restore: settings.spawn.restore,
        // web-hub-session-history plan §3.7 (P-cfg): the ninth field, only inside an enabled block.
        history: settings.spawn.history,
      };
      config.spawn = spawn;
    }
    // web-hub-preview plan v3 §4.1 (PV1): preview mode rides PI_WEBHUB_CONFIG as its own key —
    // "on" (default, U1)/"loopback" cross the wire for the hub to re-validate (main.ts drops
    // anything else); "off" is the key's ABSENCE, the same wire-level off pattern as spawn/lan.
    const preview = settings.preview ?? PREVIEW_DEFAULT_MODE;
    if (preview !== "off") config.preview = preview;
    return config;
  };

  const capsExtra = (): readonly string[] => {
    const caps: string[] = [];
    // fleet-drawer §4.4 (F2): runtx is the READ plane — advertised independently of `control`
    // ("all" ⇒ runtx.v1 + runtx.lan.v1, "loopback" ⇒ runtx.v1 only, "off" ⇒ neither).
    const runtx = settings.subagentTranscript ?? "all";
    if (runtx === "all") caps.push(...RUNTX_AGENT_CAPS);
    else if (runtx === "loopback") caps.push("runtx.v1");
    const control = settings.control !== false;
    if (!control) return caps;
    caps.push("cmd.v1");
    const remoteAskUser = settings.remoteAskUser !== false && (deps.askUserEnabled?.() ?? true);
    if (remoteAskUser) caps.push("dialog.v1");
    if (settings.webCommands !== false) caps.push("command.v1");
    // web-hub-upload plan §5.1: "on" (default) ⇒ both upload caps, "loopback" ⇒ upload.v1 only,
    // "off" ⇒ neither.
    const uploads = settings.uploads ?? "on";
    if (uploads === "on") caps.push(...UPLOAD_AGENT_CAPS);
    else if (uploads === "loopback") caps.push("upload.v1");
    // web-hub-steer-recall §4.7 step 13 (A6): the hold cap rides the agent surface only while the
    // feature is wired (`holdWired`: control ∧ steerRecall) — the hub mirrors it on BOTH of its
    // cap surfaces, and an agent advertising hold.v1 is the ONLY thing that makes the hub accept
    // `recall` forwards (S4). Unreachable while control is false (early return above), which is
    // exactly holdWired's own truth table row.
    if (holdWired(settings)) caps.push(...HOLD_AGENT_CAPS);
    return caps;
  };

  const connectWith = (info: { pluginVersion: string; buildId: string }): void => {
    const x = ctx;
    if (!attached || x === undefined) return;
    const plan = resolveLauncher();
    const config = buildHubConfig(info);
    const c = acquireConnection({
      buildId: info.buildId,
      pluginVersion: info.pluginVersion,
      kind: x.mode as AgentKind,
      cwd: safe(() => x.cwd, process.cwd()),
      paths,
      settings,
      launcher: plan,
      now,
      ...(deps.netConnect !== undefined ? { netConnect: deps.netConnect } : {}),
      headless: env.PI_WEBHUB_HEADLESS === "1",
      spawn: () => {
        if (!("error" in plan)) spawnHub(plan, hubMainPath, config, deps.spawnImpl);
      },
      capsExtra,
    });
    conn = c;
    connGen += 1;
    emitSession("attach");
    // The dialogs slot exists (D14-gated, only actually sent once the hub advertises dialog.v1) so
    // C2 only replaces `dialogBridge.frame()`'s content, not this call.
    c.setSlot("dialogs", dialogBridge.frame());
    publishCommands();
    publishStatus();
    publishCtl();
    onTick();
    wtSampler.kick(); // worktree-web plan §4.4: a (re)connect is worth a fresh sample promptly.
    bashSampler.kick(); // bash-jobs-panel plan §3.7: reconnect replays the slot and re-samples.
    setStatusLine(statusLineText(c.status(), readStatusTheme(x), { held: holdDriver?.heldCount() ?? 0 }));
  };

  const startTick = (): void => {
    if (tick !== undefined) return;
    tick = setInterval(onTick, 1_000);
    tick.unref();
  };
  const stopTick = (): void => {
    if (tick !== undefined) clearInterval(tick);
    tick = undefined;
  };

  const on = pi.on.bind(pi) as unknown as (event: string, handler: AnyHandler) => void;

  on("session_start", (event, c) => {
    if (c.mode !== "tui" && c.mode !== "rpc") return; // print/json: never attach
    generation += 1;
    const gen = generation;
    ctx = c;
    attached = true;
    sessionReason = reasonOf(event);
    lastLeaf = undefined;
    lastFleetFp = undefined;
    lastTodoFp = undefined;
    lastBashFp = undefined;
    lastBashSigs = undefined;
    lastQuotaFp = undefined;
    lastModelsKey = undefined;
    modelsTick = 0;
    tap.resetForSession(Number.NaN);
    // web-hub-steer-recall §4.7 step 7 (A6): BEFORE `commandHandler.onSessionBoundary()` — the
    // driver's `adopt` moves any process-bag leftovers of previous owners/sessions to
    // `returned` (W5) and resets its own phase/abort/cap-grace state for the new session.
    holdDriver?.onSessionStart(c);
    commandHandler.onSessionBoundary();
    wtSampler.start(safe(() => c.cwd, "")); // worktree-web plan §4.4: first sample attempt
    // happens immediately (subject to isLive()); same-cwd /new・/resume・/fork keeps the cache.
    bashSampler.start(); // bash-jobs-panel plan §3.7: clear cache/generations + re-kick — a new
    // stack means a new manager instance anyway (D3-4 session boundaries).
    // O(branch entries) cost sum, deferred so session_start returns at once.
    const im = setImmediate(() => {
      if (gen !== generation) return;
      tap.setBaseCost(branchCost(c));
      publishStatus();
    });
    im.unref();
    startTick();
    const existing = currentConnection();
    const suffix = `#${MODULE_INSTANCE}`;
    if (existing !== undefined && existing.implVersion.endsWith(suffix) && existing.status().state !== "off") {
      // path 1: same module instance ⇒ reuse synchronously (acquireConnection matches implVersion).
      connectWith({ pluginVersion: "", buildId: existing.implVersion.slice(0, -suffix.length) });
      return;
    }
    void getBuildInfo().then((info) => {
      if (gen === generation && attached) connectWith(info);
    });
  });

  on("session_shutdown", (event) => {
    if (!attached) return;
    attached = false;
    generation += 1;
    stopTick();
    wtSampler.stop(); // worktree-web plan §4.4: abort any in-flight scan, no leaked process/thread.
    bashSampler.stop(); // bash-jobs-panel plan §3.7: discard in-flight results by generation.
    // web-hub-steer-recall §4.7 step 7 (A6): BEFORE `commandHandler.onSessionBoundary()` — every
    // held item of this session becomes `returned{reload|session}` (Q6: /reload mid-turn ⇒
    // returned; the NEXT activation's `onSessionStart`/`adopt` is the defensive backstop).
    holdDriver?.onSessionShutdown(reasonOf(event));
    commandHandler.onSessionBoundary();
    dialogBridge.detachAll();
    tap.dispose();
    // §4.4 (F2 verifier P1): session replacement is a RESET, not a kill — /new・/resume・/fork
    // re-enter session_start inside this same activation and the run service must answer again
    // (same lifecycle as tap.dispose() above / tap.resetForSession() on session_start).
    runTx.resetForSession();
    setStatusLine(undefined);
    const reason = reasonOf(event);
    const detachReason =
      reason === "reload" || reason === "new" || reason === "resume" || reason === "fork" ? reason : "quit";
    conn?.detach(detachReason);
  });

  // `resources_discover` has a result contract (extra resource paths), so it stays out of
  // FORWARDED_EVENTS' fire-and-forget loop; we only use it as the signal to refresh the
  // commands slot (mid-session extension loads change the slash palette).
  pi.on("resources_discover", () => {
    if (attached) {
      publishCommands();
      refreshModelsIfChanged();
    }
    return {};
  });

  for (const type of FORWARDED_EVENTS) {
    on(type, (event, c) => {
      if (!attached) return;
      if (c !== undefined) ctx = c;
      tap.handle(event as { type: string } & Record<string, unknown>);
      // tool-duration plan: `turn_end` fires after the turn's tool executions (pi-agent-core
      // emits it from the loop right after executeToolCalls), so it is the flush point.
      if (type === "turn_end") flushToolTimings();
      if (type === "input") commandHandler.onInputEvent(event as InputEventLike);
      if (type === "message_start") {
        commandHandler.onMessageStart(event as MessageStartLike);
        // §4.7 step 6 (A6): assistant message_start arms the hold phase as the context-event
        // fallback (P-core §5.1) — user message_start (consumption) is NOT an arm signal.
        if (holdDriver !== undefined) {
          const cx = ctx;
          if (cx !== undefined && (event as MessageStartLike).message?.role === "assistant") {
            holdDriver.onAssistantMessageStart(cx);
          }
        }
      }
      if ((type === "session_compact" || type === "session_compact_failed") && reasonOf(event) === "manual") {
        // D26 (spike K13, todo #32 finding 1): pi emits `session_compact` before clearing
        // `_compactionAbortController` — re-sampling the queue mirror right here, synchronously,
        // would race pi's own not-yet-settled state. Defer at least one tick (unref'd
        // setTimeout(0)) before touching `ctx` again for this boundary.
        compactionState.deferAfterManualCompaction(() => {
          if (!attached) return;
          const x2 = ctx;
          if (x2 === undefined) return;
          try {
            commandHandler.onPendingSample(x2.hasPendingMessages());
          } catch {
            /* stale ctx */
          }
        });
      }
      if (STATUS_EVENTS.has(type)) publishStatus();
      if (WT_KICK_EVENTS.has(type)) wtSampler.kick();
      if (SESSION_EVENTS.has(type)) publishSession(sessionOverride(type, event));
    });
  }

  // web-hub-steer-recall §4.7 step 5 (A6): the hold driver's OWN handlers, registered exactly
  // once per activate() — this wiring is their single owner (W5: /new・/resume・/fork re-enter
  // session_start inside the same activation and re-register nothing). They sit AFTER the
  // FORWARDED loop above so the tap/publish bookkeeping for the same event runs first; the
  // `turn_end`/`agent_end` handlers may return a Promise (pi awaits them — the bounded confirm
  // phase) and NEVER return `entries`/`continue` (the loop's own turn_end handler owns those
  // semantics). Every handler detaches on its first line while not attached (child sessions,
  // print mode). Registered ONLY while `holdOn` (W1: zero new handlers with steerRecall off).
  if (holdDriver !== undefined) {
    const drv = holdDriver;
    // Plan §4.7 step 5's handler preamble, verbatim order: detach FIRST, then adopt the event's
    // ctx — an unattached event (child session / post-shutdown) writes nothing at all.
    const guard = (c: ExtensionContext | undefined): ExtensionContext | undefined => {
      if (!attached) return undefined;
      if (c !== undefined) ctx = c;
      return ctx;
    };
    on("context", (_event, c) => {
      const x = guard(c);
      if (x === undefined) return undefined;
      drv.onContext(x); // ARM (P-core §5.1): the only phase a new prompt can be held in
      return undefined;
    });
    on("turn_start", (_event, c) => {
      const x = guard(c);
      if (x === undefined) return undefined;
      drv.onTurnStart(x); // best-effort skip-detect (C4/A-SKIP): phase still armed ⇒ last turn_end never ran
      return undefined;
    });
    on("turn_end", (event, c) => {
      const x = guard(c);
      if (x === undefined) return undefined;
      return drv.onTurnEnd(event as TurnEndLike, x); // Promise ⇔ exactly one item was handed to pi
    });
    on("agent_end", (_event, c) => {
      const x = guard(c);
      if (x === undefined) return undefined;
      return drv.onAgentEnd(x); // run ending: B1-blocked leftovers return to the browser (R-A)
    });
    on("agent_settled", (_event, c) => {
      const x = guard(c);
      if (x === undefined) return undefined;
      drv.onAgentSettled(x); // NEVER dispatches (I-EMPTY / C3); defensive leftovers ⇒ returned{stale}
      return undefined;
    });
  }

  interface HubJsonSnapshot {
    pid?: number;
    procStartTicks?: number;
    argv?: string[];
    lan?: LanStatus;
    ui?: UiStatus;
  }

  const readHubJsonRecord = (): HubJsonSnapshot | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(paths.hubJson, "utf8")) as Record<string, unknown>;
      const rec: HubJsonSnapshot = {};
      if (typeof parsed.pid === "number") rec.pid = parsed.pid;
      if (typeof parsed.procStartTicks === "number") rec.procStartTicks = parsed.procStartTicks;
      if (Array.isArray(parsed.argv) && parsed.argv.every((a) => typeof a === "string")) {
        rec.argv = parsed.argv as string[];
      }
      if (parsed.lan !== undefined) rec.lan = parsed.lan as LanStatus;
      // structural validation only — a malformed `ui` (old hub, corrupt write) is treated as
      // "absent" (agent/ui-status.ts's `formatUiStatusLines` fallback path), never thrown.
      if (isStructurallyUiStatus(parsed.ui)) rec.ui = parsed.ui as UiStatus;
      return rec;
    } catch {
      return undefined;
    }
  };

  /** §2.3's "结构校验失败当作缺失" — just enough shape-checking to safely narrow `unknown` to
   * `UiStatus` without importing a schema validator; `formatUiStatusLines` only ever reads the
   * fields checked here. */
  function isStructurallyUiStatus(v: unknown): v is UiStatus {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (o.state === "unbuilt") return Array.isArray(o.candidates);
    if (o.state === "ok") {
      return (
        typeof o.source === "string" &&
        typeof o.version === "string" &&
        typeof o.commit === "string" &&
        typeof o.builtAt === "string" &&
        Array.isArray(o.candidates)
      );
    }
    return false;
  }

  /** §2.3 pi 侧提示：`hub.json` 的 `ui` 字段（hub 未运行/旧 hub 时缺失 ⇒ 回退本地
   * `existsSync` 检查）。 */
  const uiStatusLines = (): string[] => {
    const rec = readHubJsonRecord();
    const pkgRoot = pluginRoot();
    const version = packageVersionSync();
    const pkgDir = pkgRoot ?? packageUiDistDir();
    const hasLocalDist = existsSync(join(packageUiDistDir(), "build-info.json"));
    return formatUiStatusLines(rec?.ui, { pkgDir, version, hasLocalDist });
  };

  /** §9.3 LAN status lines, straight off `hub.json` — no admin RPC needed. */
  const lanStatusLines = (): string[] => {
    const rec = readHubJsonRecord();
    const lanPaths: LanStatusPaths = { dbFile: paths.dbFile, lanPortSetting: settings.lan?.port ?? 0 };
    return formatLanStatusLines(rec?.lan, {
      settingsEnabled: settings.lan?.enabled === true,
      ...(rec?.pid !== undefined ? { hubPid: rec.pid } : {}),
      paths: lanPaths,
    });
  };

  const sendLanReq = async (op: "info" | "unlock"): Promise<LanAdminResult<LanInfoPayload | undefined>> => {
    const c = conn;
    if (c === undefined) return { ok: false, reason: "unavailable" };
    const frame: LanReqFrame =
      op === "info"
        ? { t: "lan_req", rid: newAdminRid(), op: "info" }
        : { t: "lan_req", rid: newAdminRid(), op: "unlock" };
    try {
      const res = await c.request(frame, "lan.v1");
      if (res.t !== "lan_res") return { ok: false, reason: "unavailable" };
      if (!res.ok) return { ok: false, reason: "rejected", code: res.code, message: res.message };
      return { ok: true, value: res.info };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  };

  const lanInfo = (): Promise<LanAdminResult<LanInfoPayload | undefined>> => sendLanReq("info");

  const lanUnlock = async (): Promise<LanAdminResult<void>> => {
    const res = await sendLanReq("unlock");
    if (!res.ok) return res;
    return { ok: true, value: undefined };
  };

  const changePasswordInteractive = async (): Promise<PasswdOutcome> => {
    const x = ctx;
    const c = conn;
    if (x === undefined || x.mode !== "tui" || !x.hasUI || c === undefined) return { ok: false, reason: "no-cap" };
    return runPasswdPrompt({
      hasCap: (cap) => c.caps.includes(cap),
      promptUsername: async () => {
        try {
          return await x.ui.input("用户名");
        } catch {
          return undefined;
        }
      },
      promptPassword: async (title) => {
        try {
          return await x.ui.custom<string | undefined>(
            (tui, _theme, _keybindings, done) => new MaskedInputComponent(title, tui, done),
          );
        } catch {
          return undefined;
        }
      },
      request: async (frame, cap) => {
        const res = await c.request(frame, cap);
        if (res.t !== "lan_res") throw new Error("E_UNEXPECTED_FRAME: expected lan_res");
        return res;
      },
    });
  };

  /** Fire-and-forget: reuses the auto-start launcher path, rebuilding `HubConfig` with fresh build info. */
  const respawnSoon = (): void => {
    const plan = resolveLauncher();
    if ("error" in plan) return;
    void getBuildInfo().then((info) => {
      spawnHub(plan, hubMainPath, buildHubConfig(info), deps.spawnImpl);
    });
  };

  const restart = (): Promise<RestartOutcome> => {
    // web-hub-spawn-restore plan D13/§10.5: an explicit restart overrides an earlier `/webhub
    // stop`'s one-shot restore veto — removed BEFORE the hub_ctl goes out (failure: best-effort).
    clearRestoreVetoSync(paths.stateDir);
    return restartHubWithDeps();
  };

  const restartHubWithDeps = (): Promise<RestartOutcome> =>
    restartHub({
      isLiveWithCap: (cap) => conn?.status().state === "live" && (conn?.caps.includes(cap) ?? false),
      request: async (frame, cap) => {
        const c = conn;
        if (c === undefined) throw new Error("E_NOT_CONNECTED");
        return c.request(frame, cap);
      },
      readHubRecord: () => {
        const rec = readHubJsonRecord();
        if (rec?.pid === undefined) return undefined;
        const out: { pid: number; procStartTicks?: number; argv?: string[] } = { pid: rec.pid };
        if (rec.procStartTicks !== undefined) out.procStartTicks = rec.procStartTicks;
        if (rec.argv !== undefined) out.argv = rec.argv;
        return out;
      },
      pidAlive: (pid) => ctlLivenessProbe(pid),
      verifyIdentity: (expected) => verifyProcIdentity(expected),
      readStartTicksNow: (pid) => readStartTicksNow(pid),
      kill: (pid, signal) => {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone — nothing to signal */
        }
      },
      spawn: respawnSoon,
      now,
    });

  const admin = createAdminCommands();
  return {
    // todo #32 P0 fix: without this, `src/index.ts`'s `if (webHubRef.current.capture !== undefined)
    // commandCaptureRef.current = webHubRef.current.capture;` line never fires, so the web call
    // path (`wrapCommandApi`'s `getCapture()`) can never reach a capture port at all. It stays
    // `command-capture.ts`'s C0 fast-path stub (`arm` no-op, `take` returns undefined), which is
    // what makes this a zero-visible-change addition: every existing command still runs
    // byte-identically once the ref is actually populated.
    capture: commandCapture,
    internalExec: async (args, ctx) => {
      const parts = args
        .trim()
        .split(/\s+/)
        .filter((p) => p.length > 0);
      const op = parts[0];
      const nonce = parts[1];
      if (op !== "new" || nonce === undefined || !takeExec(op, nonce)) {
        return { ok: false, code: "E_UNSUPPORTED" };
      }
      try {
        await (ctx as ExtensionCommandContext).newSession();
      } catch {
        return { ok: false, code: "E_UNSUPPORTED" };
      }
      return { ok: true };
    },
    askUserRemote: () => (remoteAskUserEnabled() ? dialogBridge : undefined),
    admin,
    status: () => conn?.status() ?? { state: "off", attached: false },
    url: () => hubUrl(paths, conn),
    lan: {
      statusLines: lanStatusLines,
      info: lanInfo,
      unlock: lanUnlock,
      changePasswordInteractive,
      restart,
    },
    ui: {
      statusLines: uiStatusLines,
    },
  };
}

// ------------------------------------------------------------------ helpers

function reasonOf(event: unknown): string {
  const r = event !== null && typeof event === "object" ? (event as { reason?: unknown }).reason : undefined;
  return typeof r === "string" ? r : "startup";
}

function sessionInfo(ctx: ExtensionContext, reason: string): SessionInfo {
  const sm = ctx.sessionManager;
  const info: SessionInfo = {
    sessionId: safe(() => sm.getSessionId(), ""),
    cwd: safe(() => ctx.cwd, ""),
    reason,
    leafId: safe(() => sm.getLeafId(), null),
    mode: ctx.mode === "rpc" ? "rpc" : "tui",
  };
  const file = safe(() => sm.getSessionFile(), undefined);
  if (file !== undefined) info.sessionFile = file;
  const name = safe(() => sm.getSessionName(), undefined);
  if (name !== undefined) info.name = name;
  const model = safe(() => ctx.model, undefined);
  if (model !== undefined) info.model = { provider: String(model.provider), id: model.id };
  const level = safe(() => ctx.thinkingLevel, undefined);
  if (level !== undefined) info.thinkingLevel = String(level);
  return info;
}

function sessionOverride(type: string, event: unknown): Partial<SessionInfo> {
  const e = (event ?? {}) as Record<string, unknown>;
  if (type === "model_select") {
    const m = e.model as { provider?: unknown; id?: unknown } | undefined;
    if (m !== undefined && typeof m.provider === "string" && typeof m.id === "string") {
      return { model: { provider: m.provider, id: m.id } };
    }
  }
  if (type === "thinking_level_select" && typeof e.level === "string") return { thinkingLevel: e.level };
  if (type === "session_info_changed" && typeof e.name === "string") return { name: e.name };
  return {};
}

/** Single pass over the active branch: sum assistant `usage.cost.total` (no serialization, no abandoned branches). */
function branchCost(ctx: ExtensionContext): number {
  let total = 0;
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as unknown as {
        type?: unknown;
        message?: { role?: unknown; usage?: { cost?: { total?: unknown } } };
      };
      if (e.type !== "message" || e.message?.role !== "assistant") continue;
      const t = e.message.usage?.cost?.total;
      if (typeof t === "number" && Number.isFinite(t)) total += t;
    }
  } catch {
    /* stale ctx: keep what we have */
  }
  return total;
}

/** The subset of pi's Theme the status line needs; structural so tests need no pi UI. */
export interface WebHubStatusTheme {
  fg(color: string, text: string): string;
}

/**
 * HUD status token. Plain text without a theme; with one, the label is dim and
 * the marker carries the state colour (live ● green, connecting ○ dim, ✗ red).
 *
 * web-hub-steer-recall §4.7 step 14 (A6) + arch §11.1: while `extra.held > 0` the marker is the
 * LITERAL `web held N` — the held count REPLACES the state glyph (explicitly NOT the
 * `web ● held N` variant the plan body once described). Without `extra` (or with `held <= 0`)
 * the output is byte-identical to the pre-feature rendering (W4).
 */
export function statusLineText(
  v: WebHubStatusView,
  theme?: WebHubStatusTheme,
  extra?: { held?: number },
): string | undefined {
  const heldN = extra?.held ?? 0;
  const heldText = heldN > 0 ? `held ${heldN}` : undefined;
  const paint = (color: string, marker: string): string => {
    const m = heldText ?? marker;
    return theme === undefined ? `web ${m}` : `${theme.fg("dim", "web")} ${theme.fg(color, m)}`;
  };
  if (v.stopMarker === "stopped")
    return theme === undefined ? "web stopped" : `${theme.fg("dim", "web")} ${theme.fg("error", "stopped")}`;
  if (v.stopMarker === "unknown")
    return theme === undefined ? "web stop?" : `${theme.fg("dim", "web")} ${theme.fg("error", "stop?")}`;
  switch (v.state) {
    case "live":
      return paint("success", "●");
    case "connecting":
      return paint("dim", "○");
    case "loader":
      return paint("error", "✗loader");
    case "proto":
      return paint("error", "✗proto");
    case "backoff":
      return paint("error", "✗");
    case "off":
      return undefined;
  }
}

function readStatusTheme(c: unknown): WebHubStatusTheme | undefined {
  const theme = (c as { ui?: { theme?: unknown } } | undefined)?.ui?.theme;
  return typeof (theme as WebHubStatusTheme | undefined)?.fg === "function" ? (theme as WebHubStatusTheme) : undefined;
}

function hubUrl(paths: HubPaths, conn: HubConnection | undefined): { url: string } | { hint: string } {
  const view = conn?.status();
  const port = (view?.state === "live" ? view.httpPort : undefined) ?? hubJsonPort(paths.hubJson);
  if (port === undefined) {
    return { hint: `hub 未运行：state=${view?.state ?? "off"}，见 ${paths.logFile}` };
  }
  const base = `http://127.0.0.1:${port}/`;
  let token = "";
  try {
    token = readFileSync(paths.tokenFile, "utf8").trim();
  } catch {
    /* missing */
  }
  if (token === "") {
    const partial: { url: string; hint: string } = { url: base, hint: `token 文件缺失：${paths.tokenFile}` };
    return partial;
  }
  return { url: `${base}#t=${encodeURIComponent(token)}` };
}

function hubJsonPort(file: string): number | undefined {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const pid = j.pid;
    if (typeof pid !== "number" || !pidAlive(pid)) return undefined;
    const http = j.http as { port?: unknown } | undefined;
    const port = j.port ?? j.httpPort ?? http?.port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function packageVersionSync(): string {
  try {
    const root = pluginRoot();
    if (root === undefined) return "0.0.0";
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function defaultBuildInfo(): Promise<{ pluginVersion: string; buildId: string }> {
  const d = defaultPluginInfoDeps();
  const info = d === undefined ? {} : await readPluginInfo(d);
  const version = info.version ?? packageVersionSync();
  return { pluginVersion: version, buildId: `${version}@${info.commit ?? "nogit"}${info.dirty === true ? "*" : ""}` };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
