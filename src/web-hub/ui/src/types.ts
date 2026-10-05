/**
 * View-model types shared by every Vue component (vue-plan.md v2.1 §3.2, §5.2 — P0 frozen).
 *
 * Frozen: after P0 lands, extend only by adding OPTIONAL fields — never remove/rename/narrow
 * an existing field or widen a required one, and never touch this file from a package other
 * than the main session (plan §5.2's "冻结面" escalation flow covers everything else).
 *
 * `AgentState` / `Prompt` / `LiveTool` / `Item` / `Sub` / `HubState` mirror the shapes
 * `@logic/state.js`'s JSDoc `@typedef`s document (that file stays the single behavioral
 * source of truth — `reduce()`/`initialState()` are pure JS, unit-tested in
 * `tests/web-hub/web/state.test.ts`). Duplicating them here as real TS interfaces — rather than
 * `import("@logic/state.js").AgentState`-style JSDoc-type imports — keeps `vue-tsc` checking
 * of every `.vue` file's `<script setup lang="ts">` robust to how far TS's JS-JSDoc inference
 * happens to reach, at the cost of needing to keep the two in sync by hand (P1's `route`/
 * `routed`/`wanted` extension, plan §3.3, only touches reducer-internal fields not surfaced
 * here, so this file doesn't need a change for it).
 */
import type { Ref } from "vue";
import type { ConnState } from "./transport/types.js";
import type {
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnOutcome,
  SpawnStopOutcome,
  SpawnTransport,
} from "./transport/types.js";
import type { FirstPromptState, SpawnsPayload } from "@protocol/spawn.js";

export type { ConnState };
// Re-exported so a component only needs `import type { … } from "./types.js"` — never a
// second, possibly-drifting import path for the same type (same rule as `HistoryPayload` in
// `contracts.ts`).
export type { SpawnDirsOutcome, SpawnListOutcome, SpawnOutcome, SpawnStopOutcome };

// ---------------------------------------------------------------------------
// @logic/state.js mirror (read-only view — the reducer itself lives in JS)
// ---------------------------------------------------------------------------

export interface Prompt {
  readonly kind: string;
  readonly title?: string;
  readonly since: number;
}

export interface LiveTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly partial?: string;
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly done: boolean;
  readonly truncated?: boolean;
}

export type ItemKind = "message" | "custom" | "compaction" | "branch_summary" | "model_change";

export interface Item {
  readonly id: string;
  readonly kind: ItemKind;
  readonly entryId?: string;
  readonly seq?: number;
  readonly key?: string;
  readonly message?: Record<string, unknown>;
  readonly entry?: Record<string, unknown>;
  readonly truncated?: boolean;
}

export interface Sub {
  readonly clientId: string;
  readonly pending: boolean;
  readonly failed?: boolean;
}

export type HistoryState = "none" | "waiting" | "loaded" | "error";

/** Mirrors `@logic/state.js`'s `AgentState` typedef. */
export interface AgentState {
  readonly key: string;
  readonly card: Record<string, unknown>;
  readonly down: boolean;
  readonly downReason?: string;
  readonly session?: Record<string, unknown>;
  readonly status?: Record<string, unknown>;
  readonly prompts: readonly Prompt[];
  readonly fleet: readonly unknown[];
  readonly items: readonly Item[];
  readonly uid: number;
  readonly lastSeq: number;
  readonly streaming: Record<string, unknown> | null;
  readonly tools: readonly LiveTool[];
  readonly history: HistoryState;
  readonly historyError?: string;
  readonly hasMore: boolean;
  readonly oldestEntryId?: string;
  readonly paging: boolean;
  readonly needsResync: boolean;
  readonly sub: Sub | null;
  readonly dialogs?: { epoch: string; open: readonly unknown[]; closed: readonly unknown[] };
  readonly queue?: readonly unknown[];
  readonly pendingCtl?: readonly unknown[];
  readonly ctl?: readonly unknown[];
  readonly commands?: readonly unknown[];
}

/** Mirrors `@logic/state.js`'s `State` typedef (renamed to avoid colliding with the DOM global). */
export interface HubState {
  readonly clientId: string | null;
  readonly hub: Record<string, unknown> | null;
  readonly conn: ConnState;
  readonly lastEventId?: number;
  readonly selected: string | null;
  readonly agents: ReadonlyMap<string, AgentState>;
  readonly order: readonly string[];
  readonly control?: boolean;
  readonly hubState?: "running" | "stopping" | "restarting";
  readonly nextVersion?: string;
  readonly supersedePending?: boolean;
  readonly supersedeDeadlineAt?: number;
  readonly forced?: boolean;
  readonly draining?: boolean;
  /** §6.7.3 ①: stop marker holding the supersede back — HubStateBanner's "升级已暂停" state. */
  readonly supersedeBlocked?: "stopped" | "unknown";
  /** web-hub-spawn SP11 / arch §8.2: the `spawns` SSE slot (`SpawnsPayload` snapshot, Public
   * projection only). `null` until the first valid `spawns` frame arrives (a hub with spawn
   * disabled never sends one — the slot stays `null`, matching "feature off"). */
  readonly spawns?: SpawnsPayload | null;
}

/**
 * `useHub()`'s return shape (P1's exclusive `composables/useHub.ts` implements this — this
 * frozen interface is what every other component (via `contracts.ts`) is allowed to depend
 * on). `state` is the render-gated view (`renderGate.ts`, plan §3.5) of the reducer's `raw`;
 * `dispatch` feeds every local UI event `@logic/state.js`'s `LOCAL_EVENTS` (plus the P1-added
 * `"route"`) understands — components never call the reducer directly.
 */
export interface CmdOutcome {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly effect?: "none" | "unknown";
}

// ---------------------------------------------------------------------------
// web-hub-upload plan §4.2/§4.3 (package U4b) — attachment tray view models
// ---------------------------------------------------------------------------

/** Mirrors `@logic/upload.js`'s (U4a) `Attachment` JSDoc typedef — that module stays the
 * behavioral source of truth (`attachmentReduce`); this mirror exists for the same reason the
 * other `@logic/state.js` mirrors below do: robust `vue-tsc` checking of `.vue` consumers. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string | null;
  readonly state: "queued" | "uploading" | "ready" | "failed" | "removing";
  readonly uploadedBytes?: number;
  /** Absolute hub path (ready items only) — what `composePrompt` folds into the prompt. */
  readonly path?: string;
  readonly error?: string;
  readonly retryable?: boolean;
  readonly message?: string;
}

/** Why `useUploads.add` refused a file (tray admission — U4a's header assigns caps/dedup to U4b). */
export type AddRejectReason = "invalid" | "too-large" | "duplicate" | "too-many";

export interface AddReject {
  readonly file: unknown;
  readonly reason: AddRejectReason;
}

export interface AddResult {
  /** Ids of the attachments actually queued (already scheduled for upload). */
  readonly added: readonly string[];
  readonly rejected: readonly AddReject[];
}

/** `useUploads`'s (U4b) handle — exposed to Composer/AttachmentTray via `ControlHandle.uploads`. */
export interface UploadsHandle {
  /** The per-agent tray (Composer-local UI state, §4.3 — survives agent switches, lost on refresh). */
  tray(agentKey: string): Readonly<Ref<readonly Attachment[]>>;
  /** Tray admission: `UPLOAD_ATTACH_MAX_PER_MSG` count cap, 100 MiB size cap, `fileFingerprint` dedup. */
  add(agentKey: string, files: readonly unknown[]): AddResult;
  /** §4.2: mark `removing`, abort the in-flight request, call the `abort` endpoint, then drop. */
  remove(agentKey: string, id: string): void;
  /** §4.3: a failed item retries from scratch under a FRESH id (the reducer's `retry` transition). */
  retry(agentKey: string, id: string): void;
  /** §2.6/#8: `ready → failed` for attachments the hub reports evicted (`E_UPLOAD_GONE` off `/api/cmd`). */
  failGone(agentKey: string, ids: readonly string[]): void;
  /** §3.2 (U5 patch, plan-author ruled file-domain exception): post-send tray clear — drops
   * items WITHOUT calling the abort endpoint, because the just-sent prompt now references
   * those hub paths (an abort would delete the committed file out from under it; hub-side
   * pins only block sweep eviction, not an explicit abort). In-flight fetches are locally
   * aborted (controller only); a never-committed server-side partial is left to the hub's
   * 10-min idle voiding. Omitting `ids` clears the agent's whole tray. Optional per the
   * frozen-types convention (additive members only); `createUploads` always provides it. */
  discard?(agentKey: string, ids?: readonly string[]): void;
  /** Abort everything and drop all per-agent state (unmount / teardown). */
  dispose(): void;
}

export interface ControlHandle {
  sendPrompt(agentKey: string, text: string, deliver: "steer" | "followUp"): Promise<CmdOutcome>;
  abort(agentKey: string): Promise<CmdOutcome>;
  steerSub(agentKey: string, runId: string, text: string): Promise<CmdOutcome>;
  stopSub(agentKey: string, runId: string): Promise<CmdOutcome>;
  // `id` is optional (defaults to a freshly generated one inside `createControl`) — the caller
  // may instead generate it itself and pass it through, so it can be tracked synchronously
  // BEFORE the wire round-trip settles (acc32-B3 fix, see AgentDetail.vue's `onDialogAnswer`).
  answerDialog(agentKey: string, dialogId: string, epoch: string, answers: unknown, id?: string): Promise<CmdOutcome>;
  cancelDialog(agentKey: string, dialogId: string, epoch: string, id?: string): Promise<CmdOutcome>;
  runCommand(agentKey: string, name: string, args: string, opts?: { confirm?: true }): Promise<CmdOutcome>;
  query(agentKey: string, id: string): Promise<CmdOutcome>;
  retry(agentKey: string, id: string): Promise<CmdOutcome>;
  discard(agentKey: string, id: string): void;
  draft(agentKey: string): string;
  setDraft(agentKey: string, text: string): void;
  /** Present only when the transport provides `upload` (U4b) — the attachment-tray driver. */
  readonly uploads?: UploadsHandle;
}
export interface HubHandle {
  readonly state: Readonly<Ref<HubState>>;
  readonly control?: ControlHandle;
  /** web-hub-spawn SP11: the `/api/headless*` call surface + the §3.2 new-session orchestrator.
   * Optional per the frozen-types convention (additive members only) — `useHub` always
   * provides it; component-level fakes may omit it (menus then hide every pick-dir entry via
   * `spawnAvailability`'s no-cap/unknown states). */
  readonly spawn?: HubSpawnHandle;
  dispatch(msg: { event: string; data?: unknown; id?: number }): void;
}

// ---------------------------------------------------------------------------
// web-hub-spawn plan SP11 / arch §8.3, plan §3.2 — new-session flow view models
// ---------------------------------------------------------------------------

/** `classifySpawnError`'s (`@logic/spawn.js`) taxonomy plus the two flow-local failure classes. */
export type NewSessionFailKind =
  | "confirm"
  | "dir"
  | "denied"
  | "limit"
  | "rate"
  | "launcher"
  | "deadline"
  | "network"
  | "spawn" // the record itself went failed/exited (hint/endReason carry the detail)
  | "first-prompt"; // the session died before/while the first prompt could be delivered

export interface NewSessionInput {
  readonly cwd: string;
  readonly firstPrompt?: { readonly text: string; readonly deliver?: "steer" | "followUp" };
}

/** The flow's mirror of the record's `firstPrompt` slot (plan §3.2 首条消息结果 row). */
export interface FirstPromptMirror {
  readonly state: FirstPromptState;
  readonly code?: string;
  /** Set on the terminal failed/expired mirror when the body went back into the composer draft. */
  readonly refilled?: "draft";
}

/**
 * plan §3.2's UI-side state machine (state lives in `useNewSession`, never in the reducer):
 * `idle → submitting → (409 ⇒ confirming ⇢ cancel|confirm) → awaiting → done | failed`,
 * plus `unknown` (the local watchdog timeout — keep listening, SSE snapshots still settle
 * it). `input` rides every in-flight phase so a `failed` phase can offer retry (new id) and
 * the DirPicker can restore the first-prompt body (`refilled:"picker"`).
 */
export type NewSessionFlow =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting"; readonly reqId: string; readonly input: NewSessionInput }
  | {
      readonly phase: "confirming";
      readonly reqId: string;
      readonly input: NewSessionInput;
      /** The admitted realpath from 409 `E_CONFIRM_REQUIRED` — rendered via textContent, echoed back as `expectCwd`. */
      readonly resolvedCwd: string;
      readonly reason?: string;
    }
  | {
      readonly phase: "awaiting";
      readonly reqId: string;
      readonly spawnId: string;
      readonly input: NewSessionInput;
      readonly firstPrompt?: FirstPromptMirror;
    }
  | {
      readonly phase: "done";
      readonly spawnId: string;
      readonly agentKey?: string;
      readonly firstPrompt?: FirstPromptMirror;
    }
  | {
      readonly phase: "failed";
      readonly kind: NewSessionFailKind;
      readonly message?: string;
      readonly hint?: string;
      readonly code?: string;
      readonly retryAfterS?: number;
      readonly reqId?: string;
      readonly spawnId?: string;
      readonly agentKey?: string;
      readonly input?: NewSessionInput;
      /** Where the retained first-prompt body went: composer draft vs. back to the DirPicker. */
      readonly refilled?: "draft" | "picker";
    }
  | {
      /** 状态未知: the local `registerTimeoutS+15s` watchdog fired — keep listening (SSE
       * reconnect snapshots still settle this flow). */
      readonly phase: "unknown";
      readonly reqId: string;
      readonly spawnId: string;
      readonly input: NewSessionInput;
    };

/** `useNewSession`'s (SP11) handle — the plan §3.2 orchestrator. */
export interface NewSessionHandle {
  readonly flow: Readonly<Ref<NewSessionFlow>>;
  /** Start a flow with a FRESH id. `false` when a submit is already in flight (double-click guard). */
  submit(input: NewSessionInput): Promise<boolean>;
  /** confirming ⇒ resend the SAME id with `confirm:true` + `expectCwd:resolvedCwd`. */
  confirm(): Promise<void>;
  /** confirming ⇒ idle; failed/done/unknown ⇒ dismissed to idle. */
  cancel(): void;
  /** failed ⇒ resubmit the same input under a NEW id (§3.2 失败后重试). */
  retry(): Promise<boolean>;
  /** `useHub` feeds every reducer `spawns` slot change through here. */
  noteSpawns(payload: SpawnsPayload | null): void;
  dispose(): void;
  /** Test/diagnostic hooks (same pattern as the logic clients' `stats()`). */
  stats(): { readonly retainedTexts: number };
}

/** `HubHandle.spawn` — arch §8.3's `SpawnTransport` plus the §3.2 orchestrator. */
export interface HubSpawnHandle extends SpawnTransport {
  readonly newSession: NewSessionHandle;
}

// ---------------------------------------------------------------------------
// derived / presentation-only view models
// ---------------------------------------------------------------------------

/** Mirrors `@logic/render/tools.js`'s `ToolView` typedef. */
export interface ToolView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly state: "running" | "done" | "error" | "pending";
  readonly partial?: string;
  readonly result?: string;
  readonly truncated?: boolean;
}

/** ui-design.md §3.2's run/agent state vocabulary — one shared enum for cards, pills, fleet rows and tool cards. */
export type RunVisualState =
  | "running"
  | "thinking"
  | "tool"
  | "idle"
  | "queued"
  | "done"
  | "failed"
  | "timed_out"
  | "waiting"
  | "stale"
  | "offline"
  | "aborted";

/** `AgentList.vue` / `AgentCard.vue` row model (ui-design.md §5.1). */
export interface AgentCardView {
  readonly key: string;
  readonly kind: "tui" | "rpc";
  readonly shortCwd: string;
  /** Session name, else the first 8 chars of `sessionId`, else `"(no session name)"`. */
  readonly sessionLabel: string;
  /** Model id without the provider prefix; `""` when unknown. */
  readonly modelShort: string;
  readonly contextPercent: number | null;
  readonly runningSubCount: number;
  /** Pre-formatted `own [+ sub $x]` cost label (tabular-nums display string). */
  readonly costLabel: string;
  readonly visualState: RunVisualState;
  /** Status pill text; `null` when idle and nothing worth flagging. */
  readonly statusLabel: string | null;
  readonly stale: boolean;
  readonly down: boolean;
  readonly outdated: boolean;
}

/** `@logic/render/fleet.js`'s `fleetTree(rows)` output, folded into a renderable nested tree. */
export interface FleetTreeNode {
  readonly row: Record<string, unknown>; // FleetRowWire (protocol/messages.ts) — kept structural here to avoid a hard @protocol dependency in a UI-only type
  readonly depth: number;
  readonly children: readonly FleetTreeNode[];
}

/** ui-design.md §10 — global/agent-level notice banners. */
export type NoticeTone = "info" | "warn" | "danger" | "muted";

export interface NoticeAction {
  readonly label: string;
}

export interface Notice {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly title: string;
  readonly body?: string;
  readonly action?: NoticeAction;
  /** Safety notices (initial password, plaintext HTTP) are never dismissible. */
  readonly persistent: boolean;
}

/** `usePasswordAuth`'s (P1) mapped view of `LoginResult.kind` for `LoginView.vue`. */
export interface LoginErrorView {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly countdownS?: number;
}

/** `useHashRoute.ts` (§3.7) — the single source of truth for "which agent is selected". */
export type Route = { readonly name: "list" } | { readonly name: "agent"; readonly key: string };

/** §3.9 — three-state theme preference persisted under the `pwh_theme` localStorage key. */
export type ThemePref = "system" | "light" | "dark";
