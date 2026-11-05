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
  /** `^[a-z][a-z0-9-]*\.[a-z0-9-]+$`, globally unique. Builtin ids never start with `draft.`. */
  id: string;
  /** Positive integer; bump on any intent/port/render change (records are grouped by version). */
  version: number;
  /** "extracted" only ever appears in offline report drafts; the catalog self-check refuses to load it. */
  origin: "builtin" | "extracted";
  /** `^[a-z0-9.-]+$` (#25 BA §4.5): evidence lineage — a draft `draft.x` rewritten into the catalog keeps
   *  `lineage:"draft.x"` so repeat/correction evidence survives the rename. Default = `id`. */
  lineage?: string;
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
  port?: {
    outcome: ExecOutcome["kind"];
    ms: number;
    reason?: string;
    portVer: number; /** #25: draft rows name the port directly; builtin rows NEVER write it (BD11). */
    portId?: PortId;
  };
  /** Tool names + bash shapes, never arguments. */
  model?: { agree: Agreement; tools: readonly string[] };
  /** plan PD6: same digest became a candidate for the same script again within REPEAT_WINDOW_MS. */
  reasked?: true;
  /** #25 BA §4.5 (draft rows only — builtin records stay byte-identical, BD11). */
  origin?: "draft";
  draftHash?: string;
  templateHash?: string;
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
  /** #25 BA §4.5: set when the corrected target was a draft (builtin corrections stay byte-identical). */
  targetOrigin?: "draft";
  targetTemplateHash?: string;
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

// ---------------------------------------------------------------------------
// #25 历史回测 / 草案生成 / 运行时草案加载 — 跨包契约（B0 一次性冻结；BA §4.2–§4.7）。
// 后续包（B1/B2/B4/B5/B3）只读消费：缺字段 ⇒ 停下上报，不改本文件。
// ---------------------------------------------------------------------------

/** BA §4.2 — how a user turn reached the session. web/injected never count as corpus turns. */
export type TurnOrigin = "tui" | "web" | "replay" | "injected" | "steer";

/** BA §4.2 — 60/40 family split; unresolved family roots land in "unscored" (regression only). */
export type Split = "train" | "holdout" | "unscored";

/** BA §4.2 — gate facts the offline scan cannot prove; non-empty ⇔ the turn is lenient. */
export type GateFactName = "idle" | "pendingMessages" | "topicSwitchActive" | "goalBusy" | "inFlight" | "sourceMode";

export interface Turn {
  session: string;
  familyRoot?: string;
  /** familyRoot 缺省 ⇔ unresolved ⇔ split="unscored". */
  split: Split;
  entryId: string;
  at: number;
  settledAt: number;
  cwd: string;
  /** 原句只进内存与 0600 缓存（BA §7.2 风险 4）。 */
  text: string;
  /** sha256(norm) first 16 hex（与运行时 requestDigest 同口径）。 */
  digest: string;
  imageCount: number;
  origin: TurnOrigin;
  shapes: readonly string[];
  toolCount: number;
  hasWrite: boolean;
  /** 离线推不出、按宽松假设放行的 gate 事实；空 ⇔ confirmed。 */
  unknownFacts: readonly GateFactName[];
}

/** BA §4.2（纠正时间线）— produced for EVERY user entry (any origin/length); never stores text. */
export interface CorrectionFact {
  session: string;
  entryId: string;
  at: number;
  origin: TurnOrigin;
  corrHit: boolean;
}

/** BA §4.2 — the parsed `{type:"session",…}` header of one session file. */
export interface SessionHeaderFact {
  file: string;
  id: string;
  /** pi writes the PARENT'S FILE PATH here (not an id) — resolution order BA §4.2. */
  parentSession?: string;
  timestamp: number;
  cwd: string;
}

/** BA §4.2 家族索引：第一遍全量 header 的双索引（扫描范围不受 `--cwd` 过滤）。 */
export interface FamilyIndex {
  /** `path.resolve(file)` → that file's header. */
  byPath: ReadonlyMap<string, SessionHeaderFact>;
  /** header id → header. */
  byId: ReadonlyMap<string, SessionHeaderFact>;
  /** ids that appeared in ≥2 files — never used for parent fallback (unresolved if that was the only lead). */
  duplicateIds: ReadonlySet<string>;
}

/** BA §4.2 — scan-range parameters (mirror of the CLI `--days`/`--cwd` flags). */
export interface CorpusFilter {
  /** Lower bound (ms, inclusive) on a turn's `at`. */
  since: number;
  /** Upper bound (ms, exclusive); undefined ⇒ unbounded. */
  until?: number;
  /** Restrict TURN harvesting to sessions whose header cwd resolves to this absolute path; the family
   *  index itself is always built over ALL headers (BA §4.2). */
  cwd?: string;
}

/** BA §4.3 — confirmed ⇔ unknownFacts 为空；lenient 只进覆盖率统计。 */
export type Acceptance = "confirmed" | "lenient";

export type ReplayClass =
  | { k: "veto"; code: VetoCode; wouldHit?: string }
  | { k: "miss" }
  | { k: "ambiguous"; candidates: readonly string[] }
  | { k: "high"; scriptId: string; layer: "builtin" | "draft"; agree: Agreement };

export interface ReplayRow {
  turn: Turn;
  cls: ReplayClass;
  acceptance: Acceptance;
  reasked: boolean;
  corrected: boolean;
  suspect?: SuspectCode;
}

/** BA §4.3 — hit-turn-only suspect codes (reasked/corrected are also waivable via review records). */
export type SuspectCode = "diverge" | "write-turn" | "other-port" | "reviewed-misfire" | "reasked" | "corrected";

/** BA §4.4 — why a cluster produced no draft. */
export type SkipReason = "small" | "low-purity" | "unmapped" | "examples" | "regex" | "exclude-cap" | "validate";

/** BA §4.6 — loader rejection codes; `dir-*`/`timeout`/`aborted` are whole-directory. */
export type DraftRejectCode =
  | "dir-untrusted"
  | "dir-cap"
  | "dir-changed"
  | "cap"
  | "name"
  | "not-regular"
  | "perm"
  | "size"
  | "json"
  | "schema"
  | "namespace"
  | "port-mismatch"
  | "regex"
  | "examples"
  | "duplicate"
  | "timeout"
  | "aborted";

export interface LoadedDraft {
  file: string;
  script: RScriptV1;
  /** identity/draftHash of the file as loaded (audit: hand edits without a version bump show here). */
  draftHash: string;
  templateHash: string;
}

export interface DraftFileRejection {
  file: string;
  code: DraftRejectCode;
  detail?: string;
}

export interface DraftLoadResult {
  loaded: readonly LoadedDraft[];
  rejected: readonly DraftFileRejection[];
  /** Whole-directory failure (dir-untrusted/dir-cap/dir-changed) or budget abort (timeout/aborted):
   *  nothing loads, per-file rejects stay empty. */
  failure?: { code: DraftRejectCode; detail?: string };
}

/** BA §4.5 — evidence identity: lineage + templateHash (K8). Key: `${lineage}#${templateHash}`. */
export interface EvidenceIdentity {
  lineage: string;
  templateHash: string;
  portId: PortId;
  portVer: number;
}

/** BA §4.7 — port reliability per `(portId, portVer)`; missing>0 ⇒ undetermined (Major 13). */
export interface PortReliability {
  portId: PortId;
  portVer: number;
  runs: number;
  ok: number;
  missing: number;
  unavailable: number;
}

/** BA §4.7 — live (shadow/AUTO) stats per identity; crossSessionRepeats must be DETERMINED to pass. */
export interface StatsV2 {
  identity: EvidenceIdentity;
  judged: number;
  diverge: number;
  reasked: number;
  crossSessionRepeats?: number;
  corrected: number;
}

/** BA §4.7 — backtest-side evidence from ONE frozen holdout batch. */
export interface BacktestEvidence {
  batchId: string;
  manifestHash: string;
  identity: EvidenceIdentity;
  confirmed: { judged: number; diverge: number };
  lenient: { judged: number; diverge: number; unknownFacts: Record<GateFactName, number> };
  reasked: number;
  crossSessionRepeats: number;
  corrected: number;
  /** reasked/corrected suspects waived by an (unverified) review record. */
  waived: number;
  suspects: number;
  reviewed: number;
  misfires: number;
  unscored: number;
}

/** BA §4.7 — batch validity under the exposure ledger (Blocker 4 / BD12). */
export interface BatchValidity {
  ok: boolean;
  reason?: "exposed-then-modified" | "manifest-missing";
}

export interface MergedEvidence {
  identity: EvidenceIdentity;
  backtest?: BacktestEvidence;
  batchValid?: BatchValidity;
  live?: StatsV2;
  port?: PortReliability;
  scanComplete: boolean;
}

/** BA §4.7 — merged V2 verdict; a suggestion for a human-approved catalog PR, never an auto action. */
export interface PromotionVerdictV2 {
  verdict: "eligible" | "not-eligible" | "undetermined";
  reasons: readonly string[];
  identity: EvidenceIdentity;
  /** Full tuple for the PR description (BA §4.7). */
  batchId?: string;
  manifestHash?: string;
}

/** BA §4.7 — immutable corpus manifest (written once with `wx` at `batch freeze`). */
export interface CorpusManifestV1 {
  v: 1;
  normalizeVersion: string;
  files: ReadonlyArray<{
    sessionId: string;
    pathHash: string;
    size: number;
    mtimeMs: number;
    lines: number;
    lastEntryId: string;
  }>;
  manifestHash: string;
}

/** BA §4.7 — frozen holdout batch; batchId = sha256(lineage + sorted turnKeys). */
export interface EvalBatchV1 {
  v: 1;
  batchId: string;
  lineage: string;
  manifestHash: string;
  /** lastRevisedAt(lineage) at freeze time — turns must post-date it. */
  cutoffAt: number;
  since: number;
  until: number;
  /** sha256(entryId\0at) — never the text. */
  turnKeys: readonly string[];
  /** requestDigest of the same turns (admitBatch's reuse check). */
  turnDigests: readonly string[];
  createdAt: number;
}

/** BA §4.7/BD12 — exposure ledger row, appended whenever holdout failure detail is displayed. */
export interface ExposureRecordV1 {
  v: 1;
  lineage: string;
  templateHash: string;
  batchId: string;
  at: number;
  via: "report" | "review" | "show";
}

/** BA §4.7 — append-only template revision ledger (first-seen wins, never rewritten). */
export interface RevisionRecordV1 {
  v: 1;
  lineage: string;
  templateHash: string;
  firstSeenAt: number;
  gitCommitAt?: number;
  source: "draft-file" | "drafts-out" | "catalog";
}

/** BA §4.8 — UNVERIFIED human-review record (K7): read for stats, never trusted as authentication. */
export interface ReviewFileV1 {
  v: 1;
  entries: ReadonlyArray<{ digest: string; portId: string; verdict: "ok" | "misfire"; at: number }>;
  unverified: true;
}
