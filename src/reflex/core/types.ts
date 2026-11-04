/**
 * jev-reflex · frozen contract types (plan R0 step 2; arch §4.3–§4.8, §4.10).
 *
 * pi-free (R-I10). Frozen on R0 acceptance: later packages may only APPEND fields/members (I10 spirit);
 * anything else goes back to the main session. customTypes are `subagent:reflex*` (I7 — never `pi-toolkit:*`).
 */

export type PortId = "jobs.list" | "fleet.status" | "quota.summary" | "git.status" | "sessions.recent";
export type Capability = "bashJobs" | "fleet" | "quota" | "git" | "sessionDir";

export interface RScriptV1 {
  schema: "rscript/1";
  /** `^[a-z][a-z0-9-]*\.[a-z0-9-]+$`, globally unique. */
  id: string;
  /** Positive integer; bump on any intent/port/render change (records are grouped by version). */
  version: number;
  /** "extracted" only ever appears in offline report drafts; the catalog self-check refuses to load it. */
  origin: "builtin" | "extracted";
  /** MVP has this single literal; write-class scripts are rscript/2. */
  risk: "readonly";
  intent: {
    /** Whole-sentence templates (regex source over the normalized text, implicitly anchored). */
    strong: readonly string[];
    /** Substring anchors (yield `ambiguous` only). */
    weak: readonly string[];
    /** Any hit vetoes this script. */
    exclude: readonly string[];
    /** ≥5 each; also the unit-test corpus. */
    examples: { hit: readonly string[]; miss: readonly string[] };
  };
  port: { id: PortId };
  requires: readonly Capability[];
  /** ≤ REFLEX_BUDGET_MS; defaults to it. */
  budgetMs?: number;
  render: { title: string; emptyText: string; maxLines: number };
  agreement: {
    /** Tool shapes counted as "agree" in shadow comparison, e.g. "bash_job:list", "get_run_result". */
    tools: readonly string[];
    /** `predict/shape` program[ subcommand] shapes, e.g. "git status". */
    bashShapes: readonly string[];
  };
}

export interface PortEnv {
  cwd: string;
  now: number;
  signal: AbortSignal;
  budgetMs: number;
}

export type PortOutcome =
  | {
      kind: "ok";
      lines: readonly string[];
      facts: Readonly<Record<string, string | number | boolean>>;
      truncated: boolean;
    }
  /** Data may be stale / incomplete ⇒ fall back, no strike. */
  | { kind: "uncertain"; reason: string }
  /** Runtime capability missing (not a git repo, manager not built yet) ⇒ fall back, no strike. */
  | { kind: "unavailable"; reason: string }
  /** Threw / parse failure / unexpected exit code / output overflow ⇒ fall back, strike. */
  | { kind: "error"; reason: string };

/** `timeout` is produced by the budget race and counts as a strike. */
export type ExecOutcome = PortOutcome | { kind: "timeout"; reason: "budget" };

export interface GateFacts {
  source: "interactive" | "rpc" | "extension";
  mode: "tui" | "rpc" | "json" | "print";
  streamingBehavior: "steer" | "followUp" | undefined;
  /** `ctx.isIdle()` */
  idle: boolean;
  /** `ctx.hasPendingMessages()` */
  pendingMessages: boolean;
  imageCount: number;
  /** `event.text` after earlier handlers' transforms. */
  text: string;
  topicSwitchActive: boolean;
  goalBusy: boolean;
  /** This activation already has an S2 awaiting. */
  inFlight: boolean;
}

export type VetoCode =
  | "source"
  | "mode"
  | "streaming"
  | "busy"
  | "image"
  | "fence-topic"
  | "fence-goal"
  | "in-flight"
  | "length"
  | "multiline"
  | "prefix"
  | "short-reply"
  | "anaphora"
  | "cancel"
  | "negation"
  | "imperative";

export type Band = "high" | "ambiguous";

export type MatchResult =
  { kind: "miss" } | { kind: "hit"; band: Band; scriptId: string; candidates: readonly string[] };

export type ScriptState = "shadow" | "auto" | "demoted";

export interface ScriptRuntime {
  strikes: number;
  demoted: boolean;
  demotedAt?: number;
  /** plan PD5: AUTO + repeat/correction demotes immediately, same overlay as strikes. */
  demoteReason?: "strikes" | "repeat" | "corrected";
}

export type Agreement = "agree" | "no-tool" | "diverge" | "unknown";

/** `custom_message` `subagent:reflex` details (append-only fields). */
export interface ReflexAnswerDetailsV1 {
  v: 1;
  scriptId: string;
  scriptVer: number;
  portId: PortId;
  portVer: number;
  /** Monotonic S2 duration. */
  ms: number;
  /** sha256(norm) first 16 hex. */
  requestDigest: string;
  lines: number;
  truncated: boolean;
  /** Count-like facts only — no paths, no commands. */
  facts: Readonly<Record<string, string | number | boolean>>;
}

/** `appendEntry("subagent:reflex-record", …)` — never stores the original text, only digest + length. */
export interface ReflexRecordV1 {
  v: 1;
  kind: "shadow" | "fallback" | "ambiguous" | "repeat";
  at: number;
  scriptId: string;
  scriptVer: number;
  candidates?: readonly string[];
  state: ScriptState;
  band: Band;
  requestDigest: string;
  chars: number;
  port?: { outcome: ExecOutcome["kind"]; ms: number; reason?: string; portVer: number };
  /** Tool names + bash shapes, never arguments. */
  model?: { agree: Agreement; tools: readonly string[] };
  /** plan PD6: same digest became a candidate for the same script again within REPEAT_WINDOW_MS. */
  reasked?: true;
}

/** `appendEntry("subagent:reflex-correction", …)` written synchronously in the input step (plan PD12). */
export interface ReflexCorrectionV1 {
  v: 1;
  at: number;
  targetKind: "shadow" | "answer";
  targetScriptId: string;
  targetScriptVer: number;
  targetDigest: string;
  deltaMs: number;
  correctionDigest: string;
}

/** Read-only snapshot for `/reflex status` and tests. */
export interface ReflexStatusSnapshot {
  enabled: boolean;
  generation: number;
  disposed: boolean;
  inFlight: boolean;
  scripts: ReadonlyArray<{
    id: string;
    state: ScriptState;
    strikes: number;
    demoteReason?: ScriptRuntime["demoteReason"];
  }>;
  counters: Readonly<Record<string, number>>;
  unknownAutoResolve: readonly string[];
}

export interface ReflexDisambiguator {
  /**
   * Only called for band==="ambiguous" with ≤3 candidates; budget = min(800ms, remaining in-band budget).
   * Returns a choice (candidate id or "none") and score — never parameters. Timeout/throw/undefined ⇒ "none".
   * MVP does not wire this (arch §4.10).
   */
  choose(
    input: { text: string; candidates: readonly { id: string; hint: string }[] },
    signal: AbortSignal,
  ): Promise<{ choice: string; score: number } | undefined>;
}
