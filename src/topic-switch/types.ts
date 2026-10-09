/**
 * topic-switch · shared structural types (plan.md §P1 "types.ts").
 *
 * Pi-free by construction: every pi shape (session entries, judge verdicts,
 * confirm outcomes, shutdown reasons, the r3 in-process transfer record) is
 * modeled as a structural look-alike so the decision core never imports the
 * pi / pi-ai packages. P3b (wire) feeds real pi objects in; P3a (confirm.ts)
 * feeds its `ConfirmOutcome` union into the hold reducer via
 * {@link ConfirmOutcomeLike}. Keep exported names exactly as plan.md lists
 * them — downstream packages compile against these.
 */

/** pi `InputSource` look-alike (`interactive` TUI · `rpc` transport · `extension` sendUserMessage). */
export type InputSourceLike = "interactive" | "rpc" | "extension";

/** pi `ImageContent` look-alike (base64 data + mime). */
export interface ImageLike {
  type: "image";
  data: string;
  mimeType: string;
}

/** The held request, persisted verbatim in pending/handoff records. */
export interface HeldPayload {
  text: string;
  images?: ImageLike[];
  imagesOmitted?: number;
  /** sha256(text ‖ 每图 mimeType+data) over the FULL payload (capped images included). */
  digest: string;
}

/** Structural slice of cache-ttl's `CacheWarmth` — the only fields the gate reads. */
export interface WarmthView {
  state: "warm" | "cold" | "unknown";
  reason: string;
  nextWriteTtl?: "5m" | "1h" | "none";
}

/** Terminal outcomes recorded via the `record` hold effect (plan §P1 types.ts). */
export type Outcome =
  | "switched"
  | "stayed"
  | "declined"
  | "confirm-timeout"
  | "confirm-cancel"
  | "related"
  | "judge-timeout"
  | "judge-error"
  | "judge-parse"
  | "no-model"
  | "ui-unavailable"
  | "hop-timeout"
  | "switch-cancelled"
  | "switch-failed"
  | "newcomer"
  | "watchdog"
  | "shutdown"
  | "preflight";

/** First failing gate of `evaluateSyncGates` (gate order, plan §P1 gate.ts). */
export type SkipReason =
  | "disabled"
  | "no-ui"
  | "busy-turn"
  | "compacting"
  | "draining"
  | "cooldown"
  | "background"
  | "goal"
  | "todo"
  | "source"
  | "prefix"
  | "short"
  | "continuation"
  | "asked"
  | "first-turn"
  | "warm"
  | "warmth-unknown"
  | "unpriced"
  | "no-usage"
  | "cheap"
  | "fact-error";

/** Cheap facts are values; expensive ones are thunks, evaluated lazily in gate order (throw ⇒ fact-error). */
export interface GateFacts {
  hasUI: boolean;
  mode: string;
  streamingBehavior: "steer" | "followUp" | undefined;
  idle: boolean;
  pendingMessages: boolean;
  compacting: boolean;
  draining: boolean;
  cooldownActive: boolean;
  activeRuns: number;
  backgroundBash: number;
  goalBusy: boolean;
  origin: "input" | "web";
  source: InputSourceLike;
  text: string;
  imageCount: number;
  branch: () => BranchView;
  warmth: () => WarmthView;
  prefixTokens: () => number | null | undefined;
  modelCost: () => unknown;
}

/** One `getBranch()` scan, shared by gates 1e/2d/2e and the judge input. */
export interface BranchView {
  hasAssistant: boolean;
  lastAssistantText: string | undefined;
  lastTurnAskedUser: boolean;
  todoInProgress: boolean;
  recentUserTexts: string[];
  lastCompactionSummary: string | undefined;
}

/** Structural session-entry slice the decision core needs (custom + compaction + user message). */
export interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  /** Present on `type:"message"` entries: `{role, content}` (pi AgentMessage). */
  message?: unknown;
}

/**
 * pi `SessionShutdownEvent.reason` look-alike. Drives the `abort shutdown`
 * hold event and the `reason` field of pending records / transfer entries.
 */
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** pi `SessionStartEvent.reason` look-alike. Drives `planRecovery`. */
export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** Judge verdict slice the hold reducer discriminates on (full verdict from judge.ts adds `ms`). */
export type JudgeVerdictLike =
  | { kind: "ok"; related: boolean; confidence: number }
  | { kind: "timeout" | "error" | "parse-error" | "aborted" | "no-model" };

/** Confirm outcome slice (P3a's `ConfirmOutcome` union is structurally assignable). */
export interface ConfirmOutcomeLike {
  kind: "switch" | "stay" | "timeout" | "cancel" | "unavailable" | "error" | "aborted";
}

/**
 * The r3 in-process transfer record (plan §6.6 N3 / §7): the process-global
 * `Symbol.for("pi-subagent:topic-switch-transfer")` entry shared by the
 * withSession callback, `/topic-switch last --send`, the PONR watchdog and
 * recovery. CAS state machine: `pending → delivering → resolved`, bypass
 * `pending → cancelled | manual`. `delivering` never auto-redelivers (I5).
 */
export type TransferState = "pending" | "delivering" | "resolved" | "cancelled" | "manual";

export interface TransferLike {
  holdId: string;
  payload: HeldPayload;
  fromSessionId: string;
  /** `"switch"` when armed by the /topic-switch __go command; the shutdown reason when armed by persist-pending. */
  reason: string;
  state: TransferState;
  at: number;
}
