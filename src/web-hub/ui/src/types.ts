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
import type { PreviewDims } from "@protocol/preview.js";
import type { FleetRowWire, TodoTaskWire, TodoWire } from "@protocol/messages.js";
import type { PreviewProbeHandle } from "./composables/usePreviewProbe.js";
import type { ConnState, PreviewTransport } from "./transport/types.js";
import type {
  RemoveAgentOutcome,
  RemoveTarget,
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnOutcome,
  SpawnPrefsOutcome,
  SpawnStopOutcome,
  SpawnTransport,
} from "./transport/types.js";
import type { FirstPromptState, SpawnPrefsWire, SpawnsPayload } from "@protocol/spawn.js";

export type { ConnState };
// Re-exported so a component only needs `import type { … } from "./types.js"` — never a
// second, possibly-drifting import path for the same type (same rule as `HistoryPayload` in
// `contracts.ts`).
export type { RemoveAgentOutcome, RemoveTarget, SpawnDirsOutcome, SpawnListOutcome, SpawnOutcome, SpawnStopOutcome };
// default-model plan F1: the prefs outcome/wire shapes (SpawnRow/SettingsView consume them
// through this single re-export, same no-second-import-path rule as above).
export type { SpawnPrefsOutcome, SpawnPrefsWire };
// todo-web §4 (T4): the detail TodoPanel's prop type. `import type` only — the protocol
// module never becomes a runtime dependency of the UI bundle through this file.
export type { TodoTaskWire, TodoWire };

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
  /** fleet-drawer plan §6.5 (F5): the drawer's selected run (`null` = drawer closed for this
   * agent). Optional per the frozen-types convention; the reducer always sets it. */
  readonly runSel?: string | null;
  /** fleet-drawer §6.5 (F5): the selected run's transcript state (§3.3 browser state machine).
   * `null` until a run is selected; a `run_select` resets it to `null`. */
  readonly runTx?: RunTxState | null;
  /** fleet-drawer §3.2/#12 (F5): counts of fleet rows the projection caps dropped (absent
   * when nothing was omitted) — drives the “另有 N 个未列出” rows in `FleetTree`. */
  readonly fleetOmitted?: FleetOmittedWire;
  /** todo-web §4 (T4): the status reducer's mirror of `StatusInfo.todo` (the main session's
   * task-list summary). Absent = no tasks / todo disabled / web-hub off — the detail header's
   * TodoPanel renders nothing then. Optional per the frozen-types convention. */
  readonly todo?: TodoWire;
}

/** Mirrors `@logic/state.js`'s `FleetOmitted` JSDoc typedef (the `fleet` frame's `omitted`). */
export interface FleetOmittedWire {
  readonly active: number;
  readonly terminal: number;
}

/**
 * Mirrors `@logic/state.js`'s `RunTxState` JSDoc typedef (fleet-drawer plan §6.5 — that file
 * stays the behavioral source of truth; this mirror exists for the same reason the
 * `AgentState` mirror above does: robust `vue-tsc` checking of `.vue` consumers).
 *
 * §3.3 browser state machine, for quick reference: `lastSeq = fromSeq - 1` after every
 * `run_history` (wholesale replace); `run_ev` applies only at `seq === lastSeq + 1` with a
 * matching `tapId`; a hole or a mismatched `run_end.lastSeq` sets `needsResync` (useHub
 * re-subscribes, rate-limited); `terminal` never clears `items` (§3.6); `pendingSince !==
 * undefined` is the connecting/reconnecting badge; `retries` is the watchdog attempt counter
 * (error state after 2 — U13); `lastRow` keeps the last-seen `FleetRowWire` once the run
 * leaves the projected rows (§6.3 — header fallback + “不在列表中” marker).
 */
export interface RunTxState {
  readonly runId: string;
  readonly tapId?: string;
  readonly lastSeq: number;
  readonly items: readonly Item[];
  /** Internal dedupe sets (entry ids / message keys) — exposed for completeness; components
   * read `items`, never these. */
  readonly keys: ReadonlySet<string>;
  readonly entryIds: ReadonlySet<string>;
  readonly uid: number;
  readonly streaming: Record<string, unknown> | null;
  readonly tools: readonly LiveTool[];
  readonly history: HistoryState;
  readonly historyError?: string;
  /** §3.6 denial reason (`not_persisted` …) — error states and disabled "load older" paging. */
  readonly reason?: string;
  readonly hasMore: boolean;
  readonly oldestEntryId?: string;
  readonly paging: boolean;
  readonly terminal: boolean;
  readonly status: string;
  /** `live === false && !terminal` with `reason: undefined` maps to `watching:false` (§6.6). */
  readonly live: boolean;
  readonly source?: "live" | "file";
  readonly pendingSince?: number;
  readonly retries: number;
  readonly lastRow?: FleetRowWire;
  /** Internal: re-subscribe wanted (hole / run_end mismatch). useHub consumes; components don't. */
  readonly needsResync: boolean;
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
  /** web-hub-delete-session plan v2 §5.1: agent keys removed by a hub `agent_removed`
   * broadcast, bounded FIFO (`@logic/state.js`'s `REMOVED_CAP`). `DashboardView.vue` reads
   * this to render the 「已删除」 empty state for a selected key instead of 「未连接」 — absent
   * on a pre-delete-session reducer snapshot (none exists pre-feature), so every reader treats
   * a missing field the same as an empty set. */
  readonly removed?: ReadonlySet<string>;
  /** First-`agents`-snapshot-arrived flag (deep-link refresh flicker fix): `false` until the
   * hub's first `agents` frame lands, stays `true` across reconnects (the old cards are kept).
   * DashboardView/AgentList render a loading state instead of their empty states while falsy. */
  readonly synced?: boolean;
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
  // `id` is optional (defaults to a freshly generated one inside `createControl`) — the caller
  // may instead generate it itself and pass it through, so it can track the request by id
  // BEFORE the wire round-trip settles (web-model-switch plan v2 §5.2 #6, same precedent as
  // `answerDialog`'s id above / AgentDetail.vue's `trackOwnDialogCmdId`).
  runCommand(agentKey: string, name: string, args: string, opts?: { confirm?: true; id?: string }): Promise<CmdOutcome>;
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
  /** web-hub-preview plan v3 §4.6 (PV4): the `GET /api/preview` call surface. Optional per
   * the frozen-types convention — `useHub` provides it iff the underlying transport does;
   * `usePreview`'s scope derivation (`previewScopeOf`'s `hasTransport`) yields `null` without
   * it and every path in the transcript renders as plain text. */
  readonly preview?: PreviewTransport;
  /** fleet-drawer plan §6.5 (F5): run-transcript selection + paging. Optional per the
   * frozen-types convention — `useHub` always provides both; component-level fakes may omit
   * them (the drawer then renders its not-connected state). */
  readonly selectRun?: (agentKey: string, runId: string | null) => void;
  readonly pageRun?: (agentKey: string) => void;
  /** web-hub-delete-session plan v2 §5.3/§5.4: `POST /api/agents/remove`, called from
   * `RemoveButton.vue`. Optional per the frozen-types convention — `useHub` always provides
   * it (degrading to `E_UNSUPPORTED` when the transport lacks `removeAgent`); component-level
   * fakes may omit it entirely (the button then shows the `unsupported` failure text). */
  removeAgent?(target: RemoveTarget): Promise<RemoveAgentOutcome>;
  dispatch(msg: { event: string; data?: unknown; id?: number }): void;
}

// ---------------------------------------------------------------------------
// web-hub-preview plan v3 §3.2/§4.6 (package PV4) — preview overlay view models
// ---------------------------------------------------------------------------

/** Mirrors `@logic/preview.js`'s (PV4) `PathScope` JSDoc typedef (that module stays the
 * behavioral source of truth — same mirror discipline as the `@logic/state.js` shapes above).
 *
 * dir-plan §2.5.1 (P2): `abs` / `dirs` are the hub-cap flags (`preview.abs.v1` /
 * `preview.dir.v1`) — optional per the frozen-types convention, and ABSENT means absent on
 * the wire too (`previewScopeOf` only adds the key when the cap is present). */
export interface PreviewPathScope {
  readonly agentKey: string;
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly uploads: boolean;
  /** C4: absolute-path recognition outside cwd (validatePreviewPath ≥2 segments only). */
  readonly abs?: true;
  /** A4/A5: directory candidates (`dir=1` / `dirs:true` + the (a)/(b)/(c) recognition rules). */
  readonly dirs?: true;
}

/** plan §3.2's UI-side state machine (state lives in `usePreview`, App-level — never in the
 * reducer). `image.dataUrl` is a `data:` URL (D1: CSP is not relaxed; no `blob:`). */
export type PreviewView =
  | { readonly phase: "closed" }
  | { readonly phase: "loading"; readonly path: string }
  | {
      readonly phase: "image";
      readonly path: string;
      readonly dataUrl: string;
      readonly mime: string;
      readonly dims: PreviewDims;
      readonly size: number;
    }
  | {
      readonly phase: "text";
      readonly path: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly size: number;
    }
  | { readonly phase: "unsupported"; readonly path: string; readonly reason?: string; readonly size?: number }
  | {
      readonly phase: "tooLarge";
      readonly path: string;
      readonly reason?: string;
      readonly size?: number;
      readonly max?: number;
      readonly dims?: PreviewDims;
    }
  | {
      readonly phase: "error";
      readonly path: string;
      readonly error: string;
      readonly retryable: boolean;
      readonly retryAfterS?: number;
    };

/** `usePreview`'s (PV4) handle — provided at the App level by PV6 for PathText/PreviewHost. */
export interface PreviewHandle {
  readonly view: Readonly<Ref<PreviewView>>;
  /** The §4.6 scope derivation (`null` ⇒ no path is clickable). */
  readonly scope: Readonly<Ref<PreviewPathScope | null>>;
  /** closed/any ⇒ loading (a no-op without a scope); aborts whatever was in flight. */
  open(ref: { readonly path: string }): void;
  /** Any ⇒ closed; aborts the in-flight fetch (§3.2 作用域失效 uses the same path). */
  close(): void;
  /** error(retryable) ⇒ re-open the same path; a no-op in every other phase. */
  retry(): void;
  dispose(): void;
  /** 2026-10-07 修订「先探测后标记」: the batch probe controller — present iff the transport
   * implements `probe`. Absent ⇒ `PathText` keeps the legacy always-clickable rendering
   * (every frozen component fake stays valid). */
  readonly probe?: PreviewProbeHandle;
  /** dir-plan §0.2 A3 (P2 types / P3 composable): in-dialog navigation — descend into a
   * listed entry / a path ref clicked INSIDE the open dialog (path algebra from
   * `childPreviewPath`/`parentPreviewPath` in `@logic/preview.js`). Optional per the
   * frozen-types convention: a pre-dir-plan handle or component fake omits it and
   * PreviewHost degrades to open-only navigation. */
  navigate?(ref: { readonly path: string }): void;
  /** A3: pop the in-dialog history stack (cap 64, P3) — a no-op at its bottom. */
  back?(): void;
  /** A3: go to `parentPreviewPath(view.path)` — a no-op / greyed at one-segment paths. */
  up?(): void;
}

// ---------------------------------------------------------------------------
// web-hub-spawn plan SP11 / arch §8.3, plan §3.2 — new-session flow view models
// ---------------------------------------------------------------------------

/** `classifySpawnError`'s (`@logic/spawn.js`) taxonomy plus the two flow-local failure classes.
 * `"gone"` (web-hub-delete-session plan v2 §2.5) joined the taxonomy when a replayed spawn
 * request hits the hub's idempotency LRU but the record was deleted — `useNewSession.ts`
 * folds `classifySpawnError`'s result straight into this field, so the union must track it. */
export type NewSessionFailKind =
  | "confirm"
  | "dir"
  | "denied"
  | "limit"
  | "rate"
  | "launcher"
  | "deadline"
  | "network"
  | "gone"
  | "model" // default-model plan F1: hub-side 400 E_BAD_REQUEST{reason:"model-invalid"}
  | "spawn" // the record itself went failed/exited (hint/endReason carry the detail)
  | "first-prompt"; // the session died before/while the first prompt could be delivered

export interface NewSessionInput {
  readonly cwd: string;
  readonly firstPrompt?: { readonly text: string; readonly deliver?: "steer" | "followUp" };
  /** default-model plan F1 (D2 tri-state): `provider/id` ⇒ use it; `""` ⇒ explicit pi default;
   * ABSENT ⇒ the hub preference resolves. `useNewSession` only ever puts it on the wire when
   * the hub advertises `spawn.model.v1` (the second cap guard — D4), so a caller may set it
   * unconditionally. */
  readonly model?: string;
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
  /** default-model plan F1 (D1/D2): the last prefs any successful `list()`/`setDefaultModel()`
   * returned (`null` until one does — a pre-feature hub never carries the slot). */
  readonly prefs: Readonly<Ref<SpawnPrefsWire | null>>;
  /** Refetch `GET /api/headless` and fold its `prefs` slot into {@link HubSpawnHandle.prefs}. */
  refreshPrefs(): Promise<SpawnListOutcome>;
  /** `POST /api/headless/prefs` (`""` clears); on success `prefs` updates to the 200 echo.
   * Degrades to `E_UNSUPPORTED` on a transport without `setPrefs`. */
  setDefaultModel(defaultModel: string): Promise<SpawnPrefsOutcome>;
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

/** `useHashRoute.ts` (§3.7) — the single source of truth for "which agent is selected".
 * `#/settings` (user-decided 2026-10) is the standalone preferences page (theme / font size /
 * default delivery mode) — reached from the top bar's gear entry, left via browser back. */
export type Route =
  { readonly name: "list" } | { readonly name: "agent"; readonly key: string } | { readonly name: "settings" };

/** §3.9 — three-state theme preference persisted under the `pwh_theme` localStorage key. */
export type ThemePref = "system" | "light" | "dark";
