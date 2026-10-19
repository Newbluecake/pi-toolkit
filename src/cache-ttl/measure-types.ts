/**
 * FROZEN interface for `/cache-ttl measure` (docs/dev/cache-ttl-keepalive/measure-plan.md r4), package M0.
 *
 * Owned by the main session. P1 (transport + anthropic reader/validator/route), P2 (openai reader/validator), P3
 * (prefix/plan/actions/classify/renewal/runner/store/claim/args) and P4 (command wiring) code against these types and
 * constants in parallel; none of them edits this file — a change here is a plan revision.
 *
 * pi-free: type-only imports, no runtime code beyond `as const` constants and a few one-line type guards. Every
 * section points at the plan section that fixes it ("§n").
 */

import type { Millis } from "../core/types.js";
import type {
  PipelineMeasureRouteKey,
  PipelinePingContext,
  PipelinePingResult,
  PipelineWireProfile,
} from "./pipeline-ping-types.js";

// =====================================================================================================================
// Frozen constants
// =====================================================================================================================

/** §2: the protocols v1 measures (ruling 1). Same members as `PipelineWireProfile`. */
export const MEASURE_APIS = ["anthropic-messages", "openai-responses", "openai-completions"] as const;
export type MeasureApi = PipelineWireProfile;

/** §0/§5.1: the six independent TTL arms (ruling 9), one prefix each, probed once at `anchor + gap`. */
export const TTL_GAPS_MS = [180_000, 360_000, 660_000, 1_260_000, 1_860_000, 3_660_000] as const;
export const SLOT_COUNT = 6 as const;
/** §5.1: the control read runs on the 61-min slot (its anchor moves to the control touch). */
export const CONTROL_SLOT = 5 as const;

/** §4.1: the hard request cap — 6 writes + 2 replacement writes + 2 control reads + 6 TTL probes + 1 renewal read. */
export const REQUEST_BUDGET = {
  writes: 6,
  replacements: 2,
  controls: 2,
  probes: 6,
  renewal: 1,
  total: 17,
} as const;

/** §3.1/§3.3/§4.3: output caps — the same constants feed `maxTokens`, the validator and the estimate. */
export const OUTPUT_CAP = {
  "anthropic-messages": 1,
  "openai-completions": 1,
  "openai-responses": 16,
} as const satisfies Record<MeasureApi, number>;

/** Live C2 allowance for provider-reported output (including reasoning), NOT the wire max-token cap. */
export const OUTPUT_ALLOWANCE_TOKENS = {
  "anthropic-messages": 64,
  "openai-completions": 512,
  "openai-responses": 512,
} as const satisfies Record<MeasureApi, number>;

/** §3.1: filler length of the synthetic prefix (≈ 15k tokens of log-shaped filler). */
export const PREFIX_CHARS = 37_500 as const;
/** §3.1: chars-per-token estimates for the filler (lo = chars/4, mid = chars/2.5, hi = chars/2.3). Estimates, not bounds. */
export const CHARS_PER_TOKEN = { lo: 4, mid: 2.5, hi: 2.3 } as const;
/**
 * §3.1/§4.3 derived token figures: `T_LO = ceil(37500/4)`, `T_MID = ceil(37500/2.5)`, `T_HI = ceil(37500/2.3)`,
 * `P_BOUND = T_HI + INJECTION_ALLOWANCE` (P3's plan tests assert these formulas).
 */
export const T_LO_TOKENS = 9_375 as const;
export const T_MID_TOKENS = 15_000 as const;
export const T_HI_TOKENS = 16_305 as const;
/** §4.3: relay injection headroom — cr-response's observed 4096–4224 injected baseline + 384 slack. */
export const INJECTION_ALLOWANCE_TOKENS = 4_608 as const;
/** §4.3: the ONE per-request prompt bound used by the estimate, the runtime guard (C1) and context admission. */
export const P_BOUND_TOKENS = 20_913 as const;
/** §1: admission requires `model.contextWindow ≥ P_BOUND_TOKENS + CONTEXT_ADMISSION_MARGIN_TOKENS`. */
export const CONTEXT_ADMISSION_MARGIN_TOKENS = 2_048 as const;

/** §5.3: classification thresholds. */
export const CLASSIFY = {
  /** `C − B ≥ hitShare·S` ⇒ hit. */
  hitShare: 0.8,
  /** `C − B ≤ missShare·S` ⇒ miss. */
  missShare: 0.2,
  /** Minimum own prefix `S ≥ minOwnTokens` … */
  minOwnTokens: 4_096,
  /** … and `S ≥ minOwnShare·P_w`. */
  minOwnShare: 0.5,
  /** `slack(P) = max(slackMinTokens, ceil(slackShare·P))`; `|P − P_w| > slack(P_w)` ⇒ backend-mismatch. */
  slackMinTokens: 512,
  slackShare: 0.02,
} as const;

/** §5.1/§1: timings. */
export const MEASURE_TIMING = {
  /** Control read delays after slot 5's write (second attempt only on anything but a valid hit). */
  controlDelaysMs: [30_000, 60_000],
  /** Per-send deadline `min(now + perSendDeadlineMs, hardAt)`. */
  perSendDeadlineMs: 30_000,
  /** `hardAt = start + hardDeadlineMs`. */
  hardDeadlineMs: 80 * 60_000,
  /** HTTP 429 on a write ⇒ wait before the replacement (§4.2). */
  rateLimitWaitMs: 5_000,
  /** A send later than `due + max(lateMinMs, lateFraction·gap)` ⇒ `not-sent{guard}` ⇒ inconclusive(late). */
  lateMinMs: 30_000,
  lateFraction: 0.1,
  /** Confirm dialog timeout. */
  confirmTimeoutMs: 60_000,
} as const;

/** §5.5: renewal arm constants. */
export const RENEWAL = {
  /** `R` is sent this long after the slot-`b` miss response. */
  delayAfterMissMs: 10_000,
  /** `idleR.hi + idleMarginMs < survival`. */
  idleMarginMs: 10_000,
  /** `ageR.lo ≥ K + ageMarginMs[basis]`. */
  ageMarginMs: { "documented-ceiling": 30_000, "paired-empirical": 10_000 },
  /** Authoritative write-expiry ceilings, only for {@link DOCUMENTED_CEILING_ORIGIN}. */
  documentedCeilingMs: { ephemeral: 300_000, "ephemeral-1h": 3_600_000 },
  /** Assumptions stored with every `paired-empirical` `true`. */
  pairedAssumptions: ["same backend class", "same eviction pressure", "same cache policy across prefixes"],
} as const;
/** §5.5: the only origin whose documented semantics may serve as the renewal ceiling. */
export const DOCUMENTED_CEILING_ORIGIN = "https://api.anthropic.com" as const;

/** §5.4: consumer eligibility. */
export const ELIGIBILITY = { minLowerMs: 150_000, maxAgeMs: 30 * 24 * 3_600_000 } as const;

/** §3.3: validator limits. */
export const VALIDATOR_LIMITS = {
  maxSerializedBytes: 256 * 1024,
  /** Total input text ≤ expected + extraTextChars. */
  extraTextChars: 256,
  /** OAuth identity system block (stock pi-ai construction) ≤ this many chars. */
  oauthIdentityMaxChars: 200,
} as const;

/** §6: bounded clone of the terminal frame's raw usage object. */
export const MEASURE_RAW_USAGE_MAX_BYTES = 4_096 as const;

/** §8: store file, schema version and budget. */
export const MEASURE_STORE_VERSION = 1 as const;
export const MEASURE_STORE_FILE = "cache-ttl-measurements.json" as const;
export const MEASURE_STORE_CORRUPT_SUFFIX = ".corrupt" as const;
export const MEASURE_STORE_LIMITS = {
  routeCap: 64,
  writeBudgetBytes: 192 * 1024,
  readCapBytes: 256 * 1024,
  /** §7.3: each persistence step (read-merge, write tmp, rename) is raced against this deadline. */
  persistStepDeadlineMs: 2_000,
  dirMode: 0o700,
  fileMode: 0o600,
} as const;

/** §7.1: process-level claim key (pattern of `ping-ledger.ts`). */
export const MEASURE_CLAIM_KEY = Symbol.for("pi-subagent:cache-ttl-measure");
/** §7.2: `ctx.ui.setStatus` key for progress (English tokens only). */
export const MEASURE_STATUS_KEY = "cache-ttl-measure" as const;

// =====================================================================================================================
// §1 Args
// =====================================================================================================================

export type MeasureArgsError =
  | "unknown-flag"
  | "duplicate-flag"
  | "extra-model"
  | "bad-model-ref" // not `<provider>/<id>` with both parts non-empty
  | "flags-after-subcommand" // anything after `status` / `cancel`
  | "unexpected-argument";

/** Result of the pure `parseMeasureArgs(rawArgs)` (P3 `measure-args.ts`), shared with the web policy (P4). */
export type MeasureArgs =
  | {
      ok: true;
      command: "start";
      /** Case preserved; absent ⇒ `ctx.model`. */
      model?: { provider: string; id: string };
      long: boolean;
      /** Never sends (web `allow`). */
      estimate: boolean;
      /** Skips the TUI confirm only; the estimate is still printed. */
      yes: boolean;
    }
  | { ok: true; command: "status" }
  | { ok: true; command: "cancel" }
  | { ok: false; error: MeasureArgsError; detail: string };

// =====================================================================================================================
// §3 Prefix, payload, tiers
// =====================================================================================================================

export type RequestedRetention = "short" | "long";
/** §3.4: the tier actually on the wire, read from the validated params. */
export type EffectiveTier = "ephemeral" | "ephemeral-1h" | "auto" | "retention-24h" | "explicit-30m";
/** §3.4: Anthropic long — did the 1h write land (`false` = collapsed to 5m, `unknown` = split not reported). */
export type Landed1h = boolean | "unknown";

/** §3.1: one synthetic prefix (one slot attempt). */
export interface SyntheticPrefix {
  slot: number;
  /** 0 for the original write, +1 per replacement (always a fresh nonce). */
  attempt: number;
  /** 24 hex chars, `sha256(runId:slot:attempt)`. */
  nonce: string;
  /** `ttl-measure-<runId>-<slot>-<attempt>`; identical on every send of this prefix. */
  sessionId: string;
  systemPrompt: string;
  userText: string;
  /** pi-ai context built from `systemPrompt` + one user message. */
  context: PipelinePingContext;
}

/** §3.3: refusal codes of `validateMeasurePayload` (all ⇒ 0 POSTs, run `failed(payload:<code>)`). */
export type PayloadRejectionCode =
  | "extra-input" // extra text/parts/messages, `instructions`, Responses `prompt`, oversize text
  | "missing-synthetic-content"
  | "model-mismatch"
  | "not-streaming"
  | "tools"
  | "n"
  | "too-large"
  | "no-output-cap"
  | "bad-output-cap" // not a positive integer equal to OUTPUT_CAP
  | "conflicting-output-caps"
  | "billing-tier"
  | "thinking" // budget/enabled thinking, or managed effort on a non-managed model
  | "server-tools" // Anthropic `mcp_servers` / `container`
  | "no-cache-control"
  | "store"
  | "server-state" // `previous_response_id` / `conversation` / `background`
  | "prompt-cache-key"
  | "no-stream-usage"
  | "server-billed" // `audio` / `prediction` / `web_search_options` / audio `modalities`
  | "long-unsupported";

/** §3.3: what the validator expects (built by the runner from the prefix + model). */
export interface PayloadExpectation {
  api: MeasureApi;
  wireModel: string;
  expectedSystem: string;
  expectedUser: string;
  outputCap: number;
  requestedRetention: RequestedRetention;
  /** Auth is an OAuth token ⇒ one extra leading Anthropic identity block is accepted. */
  oauth: boolean;
  /** `model.compat.supportsMidConvoEffort === true` ⇒ the managed-effort construction is accepted. */
  managedEffort: boolean;
  /** Anthropic forceAdaptiveThinking build requested low reasoning; exact stock mapped output_config.effort. */
  adaptiveEffort?: string;
  /** Responses: `clamp(sessionId)` the built `prompt_cache_key` must equal. */
  promptCacheKey?: string;
  /**
   * Extra top-level param names the built payload must NOT carry, beyond the validator's own protected set —
   * e.g. the model's configured `compat.thinkingTokenBudgetField` (an opaque custom budget key the validator can't
   * otherwise tell apart from a tolerated unknown sampling key, ruling 12). Filled by P4 from the model's compat;
   * absent/empty ⇒ only the built-in protected set applies. A hit refuses with the closest existing code.
   */
  forbiddenKeys?: readonly string[];
  /** Measurement requested low Responses reasoning; require this exact mapped stock effort on the wire. */
  reasoningEffort?: string;
}

export type PayloadVerdict =
  { ok: true; effectiveTier: EffectiveTier } | { ok: false; code: PayloadRejectionCode; detail?: string };

// =====================================================================================================================
// §5.2 Strict raw usage reader
// =====================================================================================================================

/** Normalised measurement usage; `undefined` = not reported (never zero-filled). */
export interface MeasureUsage {
  /** Total prompt tokens including cached/written ones. */
  P: number;
  /** Cache-read tokens. */
  C: number;
  W?: number;
  W1h?: number;
  output?: number;
}

export type CacheEvidenceInvalidReason =
  | "no-terminal-frame"
  | "missing-prompt"
  | "missing-cached"
  | "not-integer"
  | "negative"
  | "cached-exceeds-prompt" // C > P
  | "cached-plus-write-exceeds-prompt" // C + W > P (Responses/Completions)
  | "write1h-exceeds-write"; // W1h > W

export type CacheEvidence = { kind: "valid" } | { kind: "invalid"; reason: CacheEvidenceInvalidReason };

/** §5.2/§4.3: unreported billing components (each priced into `unknownUsd`). `"all"` = sent but no usage at all. */
export type BillingItem = "output" | "write1h-split" | "write" | "all";
export type Billing = { kind: "complete" } | { kind: "unknown"; items: readonly BillingItem[] };

/** Output of the strict reader for one request. `usage` is present iff `cacheEvidence.kind === "valid"`. */
export interface UsageReading {
  usage?: MeasureUsage;
  cacheEvidence: CacheEvidence;
  billing: Billing;
}

// =====================================================================================================================
// §4.2 Outcome → action table
// =====================================================================================================================

export type MeasureRequestKind = "write" | "control" | "probe" | "renewal";

/** Classes a `PipelineOutcome` (+ `measured` + reader result) is mapped to before the table lookup (rows of §4.2). */
export type MeasureOutcomeClass =
  | "not-sent-transient" // guard (not late) / deadline / aborted / provider-error
  | "not-sent-late" // guard refused a late send (lateness rule §5.1)
  | "not-sent-auth"
  | "not-sent-rejected" // capability + `measured.rejection`
  | "not-sent-route" // capability + route/model mismatch
  | "http-redirect" // 3xx, never followed
  | "http-auth" // 401/403
  | "http-429"
  | "http-4xx" // other 4xx
  | "http-5xx"
  | "sent-lost" // network / accepted-then-lost / malformed / deadline after send
  | "usage-invalid" // usage frame, cacheEvidence invalid
  | "usage-valid";

export type InconclusiveReason =
  | "not-sent"
  | "late"
  | "io-busy"
  | "rate-limited"
  | "http-5xx"
  | "sent-lost"
  | "no-usage"
  | "own-prefix-small"
  | "backend-mismatch"
  | "partial"
  | "budget";

export type MeasureFailReason =
  | "auth"
  | "auth-http"
  | `payload:${PayloadRejectionCode}`
  | "route"
  | "redirect"
  | `http-${number}`
  | "bound-exceeded"
  | "unavailable-slots"
  | "internal";

export type RenewalUnknownReason =
  | "no-expiry-observed"
  | "pair-ineligible"
  | "renewal-miss"
  | "budget"
  | "not-sent"
  | "late"
  | "rate-limited"
  | "http"
  | "sent-lost"
  | "no-usage"
  | "backend-mismatch"
  | "own-prefix-small"
  | "partial"
  | "cancelled";

export type MeasureAction =
  /** Write: take a replacement from the pool (fresh nonce + sessionId); pool empty ⇒ slot `unavailable`. */
  | { kind: "replacement"; possiblyBilled: boolean; nonceBurned: boolean; waitMs?: number }
  /** Control: use the single second attempt. */
  | { kind: "retry-control"; possiblyBilled: boolean; flagRateLimited?: true }
  | { kind: "inconclusive"; reason: InconclusiveReason; possiblyBilled: boolean; flagRateLimited?: true }
  | { kind: "renewal-unknown"; reason: RenewalUnknownReason; possiblyBilled: boolean }
  /** Ends the run. `failed(http-<s>)` carries the status in `reason`. */
  | { kind: "failed"; reason: MeasureFailReason }
  | { kind: "anchor" }
  | { kind: "classify" }
  | { kind: "evaluate-renewal" };

/** The single §4.2 table (P3 `measure-actions.ts` exports one value of this type; runner and tests read it). */
export type MeasureActionTable = {
  readonly [O in MeasureOutcomeClass]: { readonly [K in MeasureRequestKind]: MeasureAction };
};

// =====================================================================================================================
// §4 Execution plan, §4.3 cost
// =====================================================================================================================

export type CostCondition = "C1" | "C2" | "C3";
/** `[lo, hi]` in USD. */
export type CostRange = readonly [lo: number, hi: number];

/** Token breakdown handed to the injected price function (pi-ai `calculateCost` semantics; tier from the total). */
export interface PriceTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  output: number;
}
/** Injected by the command (P4); `undefined` = unpriced (any needed rate missing/0). */
export type MeasurePriceFn = (tokens: PriceTokens) => number | undefined;

/** §4.3: pre-run estimate; `null` USD ⇒ unpriced (the request cap still applies). */
export interface CostEstimate {
  typicalUsd: number | null;
  conditionalWorstUsd: number | null;
  pBound: number;
  requestCap: number;
  conditions: readonly CostCondition[];
}

/** §4.3: accounting per request and summed per run. Never called "actual cost". */
export interface CostAccount {
  /** Σ every reported component, each request priced at its own tier; `null` ⇒ unpriced. */
  knownUsd: number | null;
  /** Unreported components only; `null` ⇒ unpriced. `[0, 0]` when nothing is unknown. */
  unknownUsd: CostRange | null;
  /** Display items, e.g. `"output×12"`, `"all×1"`. */
  unknownItems: readonly string[];
}

export interface PlannedSlot {
  slot: number;
  gapMs: number;
  /** Slot 5 carries the control read. */
  control: boolean;
}

/** §4: ONE frozen plan; estimate, confirm text, runner counters and tests all read it. */
export interface ExecutionPlan {
  runId: string;
  api: MeasureApi;
  wireModel: string;
  requestedRetention: RequestedRetention;
  outputCap: number;
  slots: readonly PlannedSlot[];
  budget: typeof REQUEST_BUDGET;
  tokens: { lo: number; mid: number; hi: number; pBound: number };
  timing: typeof MEASURE_TIMING;
  estimate: CostEstimate;
}

// =====================================================================================================================
// §5 Timeline, samples, results, renewal
// =====================================================================================================================

/** `[lo, hi]` in ms; two touches x→y: `[y.sentAt − x.headersAt, y.headersAt − x.sentAt]` (§5.1). */
export type IntervalMs = readonly [lo: number, hi: number];

export interface RequestTiming {
  sentAt: Millis;
  headersAt: Millis;
}

/** In-memory record of one request (runner state; summarised into the store record). */
export interface MeasureRequestRecord {
  kind: MeasureRequestKind;
  slot: number;
  attempt: number;
  outcomeClass: MeasureOutcomeClass;
  /** Base fetch invoked (consumes the cap). */
  sent: boolean;
  possiblyBilled: boolean;
  timing?: RequestTiming;
  reading?: UsageReading;
  cost?: CostAccount;
  action: MeasureAction;
}

/** Per-slot write baseline (§5.3): `B = C_w`, `S = P_w − B`. */
export interface SlotBaseline {
  P_w: number;
  B: number;
  S: number;
}

export type ClassifyResult = { kind: "hit" } | { kind: "miss" } | { kind: "inconclusive"; reason: InconclusiveReason };

export type SampleVerdict = "hit" | "miss" | "inconclusive" | "skipped" | "unavailable";
export type SkipReason = "implied-miss" | "budget" | "cancelled" | "hard-deadline" | "run-ended";

/** §8 store shape of one TTL arm. `idleMs` absent when the probe never produced timings. */
export interface TtlSampleRecord {
  gapMs: number;
  verdict: SampleVerdict;
  reason?: InconclusiveReason | SkipReason;
  idleMs?: IntervalMs;
  P?: number;
  C?: number;
  B?: number;
  S?: number;
  cacheEvidence?: "valid" | "invalid";
  billing?: "complete" | "unknown";
}

export interface ControlRecord {
  verdict: "hit" | "miss" | "inconclusive" | "not-run";
  attempts: 0 | 1 | 2;
  reason?: InconclusiveReason;
}

/** §5.4: TTL result. `lowerMs` absent ⇒ unknown; `missMs` is an observed miss, never a TTL ceiling. */
export interface TtlResult {
  lowerMs?: number;
  missMs?: number;
  /** A valid hit at the 61-min arm ⇒ display "≥ 61 min". */
  reachedMaxGap: boolean;
  consistent: boolean;
  validHits: number;
  validMisses: number;
  eligible: boolean;
}

export type RenewalBasis = "documented-ceiling" | "paired-empirical";
/** Ruling 10's enum. `"false"` is reserved: v1 never writes it; readers treat it as `"unknown"` (§5.5). */
export type RenewsOnRead = "true" | "false" | "unknown";

/** §5.5 verdict as produced by v1. */
export type RenewalVerdict =
  | { renewsOnRead: "true"; basis: RenewalBasis; assumptions?: readonly string[] }
  | { renewsOnRead: "unknown"; reason: RenewalUnknownReason };

export interface RenewalReadRecord {
  verdict: "hit" | "miss" | "inconclusive" | "not-sent";
  sentAt?: Millis;
  headersAt?: Millis;
  P?: number;
  C?: number;
  B?: number;
  S?: number;
}

/** §5.5/§8 store shape — raw timings kept. */
export interface RenewalRecord {
  renewsOnRead: RenewsOnRead;
  basis?: RenewalBasis;
  reason?: RenewalUnknownReason;
  assumptions?: readonly string[];
  touchedGapMs?: number;
  untouchedGapMs?: number;
  ceilingMs?: number;
  ageRMs?: IntervalMs;
  idleRMs?: IntervalMs;
  missAgeMs?: IntervalMs;
  read?: RenewalReadRecord;
}

// =====================================================================================================================
// §8 Store schema v1
// =====================================================================================================================

export type MeasureRunStatus =
  | "running"
  | "complete"
  | "partial"
  | "no-cache"
  | "control-inconclusive"
  | "inconclusive" // statusReason "prefix-too-small"
  | "failed"
  | "cancelled"
  | "interrupted";

export type MeasureStatusReason =
  MeasureFailReason | "prefix-too-small" | MeasureCancelReason | "budget" | "hard-deadline";

/** Route identity (§6): digest key + redacted label; provider names and raw URLs are never stored. */
export interface MeasureRouteIdentity {
  /** `sha256:<hex>`. */
  key: string;
  label: string;
  api: MeasureApi;
  wireModel: string;
  requestedRetention: RequestedRetention;
  effectiveTier: EffectiveTier;
}

export interface MeasureBoundExceeded {
  condition: "C1" | "C2";
  observed: number;
  limit: number;
}

export interface MeasureRunRecord {
  runId: string;
  status: MeasureRunStatus;
  statusReason?: MeasureStatusReason;
  /** Actual condition/value that stopped the run; absent in older persisted records. */
  boundExceeded?: MeasureBoundExceeded;
  /** Redacted provider error excerpt; never headers or a raw response body. */
  httpError?: { status: number; message: string };
  startedAt: Millis;
  finishedAt?: Millis;
  load: { prefixes: number; ownTokens: number };
  ttl: TtlResult;
  samples: readonly TtlSampleRecord[];
  control: ControlRecord;
  landed1h?: Landed1h;
  renewal?: RenewalRecord;
  requests: { cap: number; sent: number; possiblyBilled: number };
  cost: CostAccount & { estimate: CostEstimate };
  toolkitVersion?: string;
  piVersion?: string;
}

export interface MeasureRouteRecord extends MeasureRouteIdentity {
  latest: MeasureRunRecord | null;
  inProgress: MeasureRunRecord | null;
}

export interface MeasureStoreFile {
  version: typeof MEASURE_STORE_VERSION;
  routes: MeasureRouteRecord[];
}

/** §8 consumer API result (eligible records only). */
export interface LearnedTtl {
  lowerMs: number;
  renewsOnRead: RenewsOnRead;
  renewalBasis?: RenewalBasis;
  sampledAt: Millis;
}

/** §7.3: single-writer persistence state. */
export type MeasurePersistState = "idle" | "writing" | "zombie";

/** §7.3/§8: the store port (P3 `measure-store.ts`). `persist` is fire-and-forget and never throws. */
export interface MeasureStorePort {
  persist(route: MeasureRouteIdentity, slot: "latest" | "inProgress", run: MeasureRunRecord | null): void;
  readonly persistState: MeasurePersistState;
  /** Last successful save (status line "saved 2m ago"). */
  readonly lastSavedAt: Millis | undefined;
  readRoute(key: string): Promise<MeasureRouteRecord | undefined>;
  lookupLearnedTtl(key: string, now: Millis): Promise<LearnedTtl | undefined>;
}

// =====================================================================================================================
// §7 Claim, runner, progress
// =====================================================================================================================

export type MeasureCancelReason =
  "user" | "session-quit" | "session-reload" | "session-new" | "session-resume" | "session-fork";

export type MeasureClaimState = "free" | "preparing" | "running" | "draining";

export interface MeasureClaimOwner {
  activationId: string;
  sessionId: string;
  runId: string;
  generation: number;
}

/** Opaque token returned by `prepare`; compared by identity + generation. */
export interface MeasureClaimToken {
  readonly owner: MeasureClaimOwner;
}

export type MeasureClaimPrepare =
  { ok: true; token: MeasureClaimToken } | { ok: false; reason: "busy" | "busy-io-pending"; since?: Millis };

/** Live progress snapshot (status line, `measure status`, web). */
export interface MeasureProgress {
  runId: string;
  label: string;
  status: MeasureRunStatus;
  startedAt: Millis;
  /** TTL arms with a final verdict / `SLOT_COUNT`. */
  slotsDone: number;
  nextDueAt?: Millis;
  nextKind?: MeasureRequestKind;
  nextGapMs?: number;
  sent: number;
  cost: CostAccount;
  lastSavedAt?: Millis;
  physicalPending: number;
}

export interface MeasureRunHandle {
  snapshot(): MeasureProgress;
  /** Idempotent; never awaits persistence or IO. */
  cancel(reason: MeasureCancelReason): void;
  /** Never rejects. */
  readonly done: Promise<MeasureRunRecord>;
}

/** §7.1: the process-level claim (P3 `measure-claim.ts`), stored at `globalThis[MEASURE_CLAIM_KEY]`. */
export interface MeasureClaim {
  readonly state: MeasureClaimState;
  readonly generation: number;
  /** Sends whose transport `settled` has not resolved; survives /reload·/new·/resume·fork. */
  readonly physicalPending: number;
  readonly drainingSince: Millis | undefined;
  /** Only from `free`; registered BEFORE the estimate/confirm await. */
  prepare(owner: Omit<MeasureClaimOwner, "generation">, now: Millis): MeasureClaimPrepare;
  /** Same generation, activation, session; not revoked. Checked after every await. */
  owns(token: MeasureClaimToken): boolean;
  revoke(token: MeasureClaimToken): void;
  /** `preparing → running`; `false` if the token no longer owns the claim. */
  start(token: MeasureClaimToken, run: MeasureRunHandle): boolean;
  /** Logical end (complete/cancel): `running → draining` (or `free` when no IO pending). */
  finishLogical(token: MeasureClaimToken, now: Millis): void;
  /** Physical IO ledger; `ioSettled` is NOT token-gated (an old generation's IO still settles). */
  ioBegin(): void;
  ioSettled(): void;
  /** Live run of any generation (status from a new activation). */
  current(): MeasureProgress | undefined;
}

/** What the runner asks the transport adapter to send (P3 builds it; P4 binds it to `sendPipelinePing`). */
export interface MeasureSendRequest {
  kind: MeasureRequestKind;
  slot: number;
  attempt: number;
  sessionId: string;
  /** Build mode (writes) — context + validator; replays carry `body`. */
  build?: { context: PipelinePingContext; validate: (params: Record<string, unknown>) => string | undefined };
  body?: Readonly<Record<string, unknown>>;
  routeKey: (requestUrl: string) => PipelineMeasureRouteKey;
  expectRouteKey?: string;
  deadlineAt: Millis;
  /** Lateness + ownership guard, evaluated by the transport right before the base fetch. */
  guard: () => boolean;
  signal: AbortSignal;
}
export type MeasureSendFn = (request: MeasureSendRequest) => Promise<PipelinePingResult>;

// =====================================================================================================================
// Tiny type guards
// =====================================================================================================================

export function isMeasureApi(api: unknown): api is MeasureApi {
  return typeof api === "string" && (MEASURE_APIS as readonly string[]).includes(api);
}
