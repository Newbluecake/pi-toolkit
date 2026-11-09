// Jev core contracts (jev-plan §2 interface freeze table, jev-arch §3.1).
//
// EVERY named type that appears in the frozen signatures of the Jev packages
// lives here — J1 defines, J0's eval script / J2–J8 consume. These shapes are
// FROZEN: downstream packages must not change them; adding a field requires
// reporting to the root session, which appends an optional field here in a
// separate commit. Only types, constants and the two customType literals —
// implementations live in their own packages.
//
// This file (like everything in src/memory/jev/ except wire.ts / segment.ts)
// is a pi-free root: no `@earendil-works/*` imports, not even as types
// (tests/boundary/pi-free.test.ts). `ClassifierRegistryLike` / `JevQuestion`
// / `JevAnswer` / `FetchLike` are the local structural mirrors of
// pi-ai's classifier API (jev-arch §5.1) so the jev directory never has to
// import pi. No module-scope mutable state (I4).

import type { MemoryWriteGate } from "../contracts.js";
import type { IncrementalDirectory } from "../govern/incremental.js";

// ───────────────────────────── entry model (jev-arch §4.1) ─────────────────────────────

/** sha1(normalizeBody(body)).slice(0, 12) — sidecar key; changing ONLY the
 *  inline authority comment does not change it, so derived tags survive
 *  authority edits. */
export type EntryHash = string;

export type EntryType = "rule" | "pitfall" | "procedure" | "preference" | "fact" | "pointer";

/** 0 background · 1 useful · 2 important · 3 critical (jev-arch §4.3.1). */
export type Importance = 0 | 1 | 2 | 3;

/**
 * Entry splitting rules (jev-arch §4.1, rules 1–5 — pinned by
 * tests/memory/jev/entries.test.ts):
 *
 * 1. `# ` H1 is the file title, never an entry.
 * 2. `## `/`### ` open a new context region. `section` is the nearest `## `
 *    title text ("" before any `## ` — the file head; §6.1.1's static-core
 *    detection keys on it). `heading` is `A` or `A › B` when a `### ` is
 *    open under `## A`.
 * 3. A column-0 list item (`- ` / `* ` / `+ ` / `N. `) starts an entry. Its
 *    continuation lines are: later lines indented ≥2 spaces, blank lines
 *    inside the list, fenced blocks belonging to it, and indented
 *    tables/quote blocks. The entry ends at the next column-0 list item, a
 *    heading, a column-0 block-level structure (table / quote / HTML block),
 *    or a non-indented ordinary paragraph.
 * 4. A `## ` section containing NO column-0 list item is ONE entry (its
 *    whole body, tables/quotes included).
 * 5. Block-level structures outside lists each form their own entry:
 *    a run of column-0 `|` lines (one GFM table), a run of column-0 `>`
 *    lines (one quote block), an HTML block (from a `<tag` line through the
 *    next blank line), and an ordinary paragraph of ≥40 code points. A
 *    SHORTER paragraph is merged into the NEXT entry as context; at end of
 *    file, where no next entry exists, it merges into the PREVIOUS entry
 *    (J1 default for the plan's open question — reported to root).
 *
 * Lines inside fenced code blocks never take part in any of these decisions.
 */
export interface MemEntry {
  readonly file: string;
  readonly heading?: string;
  /** Owning `## ` section title; "" for the file head before any `## `. */
  readonly section: string;
  /** 1-based ordinal within its `## ` section (display anchor component). */
  readonly ordinal: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Entry lines INCLUDING the inline authority comment (normalized: trailing
   *  whitespace stripped, `\n` line endings, blank-line runs collapsed). */
  readonly raw: string;
  /** `raw` minus every `<!-- mem … -->` comment, same normalization. */
  readonly body: string;
  readonly hash: EntryHash;
  /** sha1 of normalized `raw` (comment included) — Q4 pairing key: editing the
   *  `user` marker changes it. */
  readonly guardHash: string;
  readonly inline: InlineMeta;
  /** Parse problems of the inline comment (→ D18). Never thrown. */
  readonly inlineErrors: readonly string[];
  readonly authority: "user" | "agent";
  readonly fileStatus: "active" | "stale";
  /** body hits SECRET_PATTERNS or the loose key/value rule (same source as
   *  doctor D13, src/memory/secret-patterns.ts). */
  readonly secret: boolean;
  /** Programs the body names explicitly (jev-arch §6.4.2) — extraction rules
   *  live in match.ts `namedPrograms`. */
  readonly namedPrograms: readonly string[];
  /** #36 blocks layout (arch r5 §4.2/§4.4): present when this entry was
   *  projected from a block file via `blockToEntry`. r5 裁定 6: `heading` is
   *  NOT here — it lives on `MemEntry.heading` like every other layout. */
  readonly block?: {
    readonly id: string;
    readonly scope?: "global" | "topic";
    readonly audience?: "all" | "main" | "child";
    readonly status: "active" | "superseded" | "archived";
    readonly supersededBy?: string;
    readonly snapshot?: boolean;
    readonly updated: string;
  };
}

/** Parsed `<!-- mem … -->` authority comment (jev-arch §4.2). Written by the
 *  user or the agent — Jev never writes these. */
export interface InlineMeta {
  /** A `<!-- mem … -->` comment was found on the entry's first non-empty
   *  line (true even when it only produced errors). */
  readonly present: boolean;
  /** `user` (user order — only the user may void it, Q4) or `lesson`
   *  (agent-owned lesson); overrides the file-level default authority. */
  readonly authority?: "user" | "lesson";
  /** `expires=YYYY-MM-DD` — after it passes the entry lands in D17 /
   *  `/mem expired` (prompt only, Q1). Valid on the day itself. */
  readonly expires?: string;
  /** `until="event"` — event-type expiry; listed for confirmation only. */
  readonly until?: string;
  /** Blocks v3 write-only section override. */
  readonly section?: string;
  readonly clearSection?: true;
  /** `gate` (guard once) / `gate=hold` / `nogate` — parsed for backward
   *  compatibility with memory files written before the gate feature was
   *  removed (2026-11); carrying one has no effect anymore. */
  readonly gate?: "gate" | "hold" | "nogate";
  /** `tags=+a,-b` — manual tag add/remove; wins over Jev's judgment and works
   *  while Jev is unavailable. */
  readonly tagsAdd?: readonly string[];
  readonly tagsRemove?: readonly string[];
  /** `private` — never sent to Jev (no tagging/recall/review), static
   *  block only. */
  readonly isPrivate?: boolean;
  // ── #36 memory-governance (plan §4 P0 / arch r5 §4.4 — append-only) ──
  /** `scope=global|topic` — user-rule scoping (arch §3.3.2; only meaningful
   *  with `authority:user`, default topic). */
  readonly scope?: "global" | "topic";
  /** `audience=all|main|child` — session-audience filter (arch §6.1). */
  readonly audience?: "all" | "main" | "child";
  /** `supersedes=<id>[,<id>]` — write-time syntax declaring the new entry
   *  supersedes the listed blocks; never persisted into BlockMeta (single-
   *  sided `supersededBy` is the only on-disk relation, arch §5.4). */
  readonly supersedes?: readonly string[];
  /** `title=` — CC single-fact block title (block-level metadata, shown in
   *  `view <topic>` lists only; never feeds the topic index, arch r3 N1). */
  readonly title?: string;
  /** `when=` — CC single-fact read-condition, same scope as `title`. */
  readonly when?: string;
  /** `expires=none` — clears a previously set expiry (arch §4.1.4). */
  readonly clearExpires?: true;
  /** `until=none` — clears a previously set event expiry. */
  readonly clearUntil?: true;
}

// ───────────────────────────── taxonomy (jev-arch §4.3) ─────────────────────────────

export interface TagDef {
  /** ^[a-z][a-z0-9-]{1,31}$ */
  readonly id: string;
  /** ≤40B. */
  readonly label: string;
  /** ≤240B — used verbatim as the Jev criteria (`criteria.true`). */
  readonly description: string;
  readonly risk: "normal" | "high";
  readonly match?: {
    readonly tools?: readonly string[];
    /** argv prefix patterns (v4.1 §2.7.1 `cmd=` lexing — see match.ts). */
    readonly commands?: readonly string[];
    /** Globs relative to the repo root. */
    readonly paths?: readonly string[];
  };
  readonly source: "preset" | "user"; // "agent" reserved for phase 2 (Q32)
  /** +1 when `description` changes; matcher-only edits do NOT bump it. */
  readonly rev: number;
}

export interface Taxonomy {
  /** sha1 of every enabled TagDef's description+rev (see taxonomy.ts). */
  readonly rev: string;
  readonly types: readonly { id: EntryType; description: string }[];
  readonly importance: readonly string[];
  /** Enabled tags only, sorted by id. */
  readonly tags: readonly TagDef[];
}

/** `/mem tags add` input shape (JevCommandPort.tags.add). */
export interface TagDefInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly risk?: "normal" | "high";
  readonly commands?: readonly string[];
  readonly paths?: readonly string[];
  readonly tools?: readonly string[];
}

/** `<slug>/.jev/taxonomy.json` (J4 writes, taxonomy.ts merges). */
export interface TaxonomyFileV1 {
  readonly v: 1;
  readonly tags: readonly TagDef[];
  readonly disabledPresets: readonly string[];
}

// ───────────────────────────── sidecar index (jev-arch §4.4) ─────────────────────────────

export interface EntryTags {
  readonly file: string;
  readonly type: EntryType;
  readonly typeP: number;
  readonly importance: Importance;
  /** Only p ≥ 0.3 judgments are stored. */
  readonly tags: Record<string, { p: number; rev: number }>;
  readonly guard: number;
  readonly temporal: "permanent" | "dated" | "event";
  readonly userLike: number;
  readonly model: string;
  readonly at: string;
  readonly taxonomyRev: string;
  /** #36 §5.3 g1 scope-question answer, keyed by body hash so multiple
   *  blocks sharing one entry body share the judgment (arch r5 §4.4). */
  readonly globalP?: number;
}

/** Review-suggestion kinds. The first five are the pre-#36 set (decide.ts
 *  emits, review-command.ts routes); #36 appends the governance kinds
 *  (arch r5 §4.4). Sanitizer/read tolerance lives in index-store.ts. */
export type ReviewSuggestionKind =
  | "duplicate"
  | "supersedes"
  | "conflict"
  | "obsolete"
  | "user-like"
  | "expired-user"
  | "until-check"
  | "snapshot"
  | "pointer"
  | "oversize"
  | "resident-budget"
  | "scope-check"
  | "legacy-drift";

export interface ReviewSuggestion {
  readonly id: string;
  readonly kind: ReviewSuggestionKind;
  readonly a: { hash: EntryHash; anchor: string };
  /** Absent for `obsolete` / `user-like` (single-entry suggestions). */
  readonly b?: { hash: EntryHash; anchor: string };
  readonly p: number;
  readonly at: string;
  /** P50 factory-only payload. D must reject an invalid revision as a whole
   * suggestion, never strip it into a legacy executable suggestion. No wire. */
  readonly revision?: RevisionProposal;
}

export interface DismissedPair {
  /** sort(hashA, hashB).join("+") */
  readonly hashKey: string;
  /** sort(anchor(a), anchor(b)).join("+"); anchor = file + "|" + section + "|"
   *  + first 24 code points of the normalized body. */
  readonly anchorKey: string;
  /** #36: which suggestion kind this dismissal targets — absent = the legacy
   *  pairwise dismissal semantics (kind-agnostic). */
  readonly kind?: ReviewSuggestionKind;
  /** Stable source/kind/entry identity for permanent dismissal. */
  readonly suggestionKey?: string;
  /** Legacy deadline retained for compatibility; dismissals are permanent. */
  readonly until?: string;
}

export interface ReviewState {
  readonly lastRunAt: string;
  readonly corpusFp: string;
  readonly suggestions: readonly ReviewSuggestion[];
  readonly dismissed: readonly DismissedPair[];
  /** Independent governance sweep clock; absent on legacy sidecars. */
  readonly sweepLastRunAt?: string;
  readonly sweepCorpusFp?: string;
  /** Stable keys explicitly resolved by the user. */
  readonly resolved?: readonly string[];
}

export interface JevIndexV1 {
  readonly v: 1;
  readonly entries: Record<EntryHash, EntryTags>;
  /** Last successful tagging time — shown by the partial status line. */
  readonly lastTaggedAt?: string;
  readonly review?: ReviewState;
  /** A-layer cross-session cooldown stamps: hash → ISO time of the last A
   *  injection (2026-11-03 noise fix). Independent of tagging upserts — the
   *  map survives re-tagging and applies to pending (untagged) entries too. */
  readonly aInjectedAt?: Record<EntryHash, string>;
  /** P-layer cross-session cooldown stamps (memory-predict plan §2.1/§5.3) —
   *  same shape and cap as `aInjectedAt`, independent map. */
  readonly pInjectedAt?: Record<EntryHash, string>;
}

/** `/mem review --list` row: the stored suggestion plus its stale flag
 *  (either side's hash no longer in the corpus ⇒ stale, skipped). */
export interface ReviewSuggestionView {
  readonly suggestion: ReviewSuggestion;
  readonly stale: boolean;
}

/** Input of J4's `writeIndexPatch` (read → merge by hash → atomic replace,
 *  inside the directory lock). */
export interface IndexPatch {
  readonly upsert?: Readonly<Record<EntryHash, EntryTags>>;
  readonly remove?: readonly EntryHash[];
  readonly lastTaggedAt?: string;
  readonly review?: ReviewState;
  /** Snapshot seen by a review run, for detecting in-flight changes. */
  readonly reviewBase?: ReviewState | null;
  /** Upserted into the A-layer cooldown map (per-key replace). */
  readonly aInjectedAt?: Readonly<Record<EntryHash, string>>;
  /** Upserted into the P-layer cooldown map (per-key replace). */
  readonly pInjectedAt?: Readonly<Record<EntryHash, string>>;
}

/** Result of J4's `tagBulk` (migration / re-tagging runs). */
export interface BulkResult {
  readonly calls: number;
  readonly costUsd: number;
  readonly tagged: number;
  readonly pending: number;
}

// ───────────────────────────── classifier mirror (jev-arch §5.1) ─────────────────────────────

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };

export interface FetchResponseLike {
  readonly status: number;
  /** pi-ai's classifier transport rejects any response whose `ok` is falsy. */
  readonly ok: boolean;
  /** pi-ai's `headersToRecord` iterates `entries()` (onResponse hook). */
  readonly headers: {
    get(name: string): string | null;
    forEach(cb: (value: string, key: string) => void): void;
    entries(): IterableIterator<[string, string]>;
  };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** Structural subset of `fetch` — the native fetch satisfies it; J2's
 *  proxy-fetch produces it. */
export interface FetchLike {
  (input: string | URL, init?: FetchInitLike): Promise<FetchResponseLike>;
}

/** JSON-serializable state object sent to the classifier (already redacted
 *  and truncated by jev/redact.ts). */
export type JsonObject = Record<string, unknown>;

/** Structural subset of `ctx.modelRegistry` (model-registry.d.ts:44-47).
 *  Missing any method ⇒ `off("pi-api")`. Never cached across activations. */
export interface ClassifierRegistryLike {
  getModelOfType?(type: "classifier", provider: string, id: string): object | undefined;
  getAvailableOfType?(type: "classifier"): Promise<readonly { provider: string; id: string }[]>;
  classify?(
    model: object,
    ctx: { state: JsonObject; questions: Record<string, JevQuestion> },
    opts?: { signal?: AbortSignal; fetch?: FetchLike },
  ): Promise<{
    stopReason: "stop" | "error" | "aborted";
    answers: Record<string, JevAnswer>;
    errorMessage?: string;
    usage?: { input: number; cost?: { total: number } };
    provider: string;
    model: string;
  }>;
}

// ───────────────────────────── P50 controlled classify (opt-in only) ─────────────────────────────

export type ClassifyResult = Awaited<ReturnType<NonNullable<ClassifierRegistryLike["classify"]>>>;
export type ClassifyContext = { state: JsonObject; questions: Record<string, JevQuestion> };

/** Actual successful identity. Unknown/unverified routes are diagnostic only,
 * NEVER independent-source evidence. Digests are SHA-256 of canonical JSON. */
export interface ClientProvenance {
  readonly provider: string;
  readonly model: string;
  readonly adapterId: string;
  readonly chainVersion: string;
  readonly routeIdentity: string;
  readonly routeAliases: readonly string[];
  readonly requestChainId: string;
  readonly requestDigest: string;
  readonly inputDigest: string;
  readonly trusted: boolean;
  /** Revision SDK request identity, separate from verified actual provider/model. */
  readonly requestedProvider?: string;
  readonly requestedModel?: string;
  /** Verified canonical identity; absent when the response cannot be bound. */
  readonly canonicalProvider?: string;
  readonly canonicalModel?: string;
}

export interface CanonicalClassifyRoute {
  readonly provider: string;
  readonly model: string;
  /** Canonical route digest, not the requested chain id. */
  readonly routeIdentity: string;
  /** Complete canonical alias set, including the requested and returned ids. */
  readonly routeAliases: readonly string[];
}

export interface ClassifyBounds {
  /** Verified bound including provider formatting/prompt overhead, not bytes/4. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly priceUsdPerMillion: { readonly input: number; readonly output: number };
}

/** Trusted host seam, NOT implemented by the stock pi 1.5 classify API.
 * prepare is synchronous/pure, binds the exact frozen DTO, and returns undefined
 * unless input AND executable provider output limits and prices are known.
 * dispatch must issue exactly ONE provider call (no hidden retries), enforce
 * both bounds at transport level, and return the original provider promise and
 * actual identity/usage, including late/errored responses. Abort is advisory.
 * A provider ignoring bounds can still overbill: client records all actual cost.
 * resolveRoute must use canonical registry/adapter evidence, never simply copy
 * result.provider/model or split the requested id. Missing proof => untrusted.
 * No default implementation: passing an arbitrary maxTokens option to the SDK
 * is NOT proof that the provider enforces it. */
export interface ControlledClassifyTransport {
  prepare(input: {
    readonly registry: ClassifierRegistryLike;
    readonly model: object;
    readonly requestChainId: string;
    readonly context: ClassifyContext;
    readonly requestDigest: string;
  }):
    | {
        readonly adapterId: string;
        readonly chainVersion: string;
        readonly bounds: ClassifyBounds;
        dispatch(opts: { readonly signal: AbortSignal; readonly fetch?: FetchLike }): Promise<ClassifyResult>;
        resolveRoute(result: ClassifyResult): CanonicalClassifyRoute | undefined;
      }
    | undefined;
}

// ───────────────────────────── P50 revision transport (host opt-in, no wire) ─────────────────────────────

/** Frozen local admission evidence, not an outbound DTO. Unknown privacy or
 * parse status is refused, not defaulted. The caller must read the real block;
 * this seam does not freeze raw files or grant permission to commit. */
export interface RevisionBlockInput {
  readonly id: string;
  readonly rev: string;
  readonly authority: "user" | "agent";
  readonly topic: string;
  readonly section?: string;
  readonly body: string;
  readonly private: boolean;
  readonly secret: boolean;
  readonly parseErrors: readonly string[];
  readonly status: "active";
  readonly storageScope?: "hub";
  readonly residue?: true;
  readonly origin?: unknown;
}
export interface RevisionOutboundBlock {
  readonly id: string;
  readonly rev: string;
  readonly authority: "user" | "agent";
  readonly topic: string;
  readonly section?: string;
  readonly body: string;
}
export type RevisionOutbound =
  | {
      readonly purpose: "generate";
      readonly instruction: "rewrite-single" | "merge-survivor";
      readonly target: RevisionOutboundBlock;
      readonly context?: RevisionOutboundBlock;
    }
  | {
      readonly purpose: "coverage";
      readonly target: RevisionOutboundBlock;
      readonly context?: RevisionOutboundBlock;
      readonly candidateBody: string;
    };

/** Structural mirror of registry.complete. No direct fetch or provider lookup
 * is allowed in the controlled adapter. Stock registry identity alone does NOT
 * certify prompt token bounds, no retries, aliases or provider limit support. */
export interface RevisionRegistryLike {
  complete?(
    model: object,
    context: RevisionTransportContext,
    opts: {
      signal: AbortSignal;
      maxTokens: number;
      maxRetries: 0;
      onPayload(payload: unknown): unknown;
      onProviderStreamEvent?(event: unknown): void;
    },
  ): Promise<RevisionTransportResult>;
}
export interface RevisionTransportContext {
  systemPrompt: string;
  messages: { role: "user"; content: string; timestamp: number }[];
}
export interface RevisionTransportResult {
  readonly stopReason: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly provider: string;
  readonly model: string;
  /** SDK model is the requested alias, NOT necessarily the actual response model. */
  readonly responseModel?: string;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly totalTokens?: number;
    readonly cost?: { readonly total: number };
  };
}
/** Trusted adapter observation, not fields inferred from SDK default zeros.
 * No evidence means unknown cost (reserve) and unknown actual identity. */
export interface RevisionResultEvidence {
  readonly actual?: { readonly provider: string; readonly model: string };
  readonly costUsd?: number;
}
export interface ControlledRevisionTransport {
  prepare(input: {
    readonly registry: RevisionRegistryLike;
    readonly requestChainId: string;
    readonly outbound: RevisionOutbound;
    readonly maxOutputTokens: number;
    readonly requestDigest: string;
  }):
    | {
        readonly adapterId: string;
        readonly chainVersion: string;
        readonly bounds: ClassifyBounds;
        dispatch(opts: { readonly signal: AbortSignal; readonly fetch?: FetchLike }): Promise<RevisionTransportResult>;
        resultEvidence(result: RevisionTransportResult): RevisionResultEvidence;
        resolveRoute(result: RevisionTransportResult): CanonicalClassifyRoute | undefined;
      }
    | undefined;
}

/** Host attestation for ONE actual registered model/adapter version. A binding
 * is trusted code, not a setting or model-supplied assertion. quoteInput must
 * cover the exact serialized prompt including adapter overhead; no bytes/4
 * heuristic. maxTokensEnforced certifies the actual provider serializer and
 * no-hidden-retry behavior, not just the presence of an SDK option. Unknown
 * capabilities must not be bound. Production conformance is still required. */
export interface RegistryRevisionBinding {
  readonly registry: RevisionRegistryLike;
  readonly requestChainId: string;
  readonly model: object;
  readonly adapterId: string;
  readonly chainVersion: string;
  readonly maxTokensEnforced: true;
  /** Verified last-hop onPayload support for this exact provider adapter. */
  readonly outputLimitField: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
  readonly maxOutputTokens: number;
  /** Explicit verified observer for this adapter. The SDK mode consumes raw
   * onProviderStreamEvent evidence, never default usage/model. A callback is
   * only for a different host-controlled protocol with its own evidence;
   * simply copying SDK result.usage.cost/model is NOT a valid attestation.
   * Omitted => reserve accounting and untrusted provenance, even for zero. */
  readonly resultEvidence?: "openai-completions" | ((result: RevisionTransportResult) => RevisionResultEvidence);
  quoteInput(context: RevisionTransportContext):
    | {
        readonly maxInputTokens: number;
        readonly priceUsdPerMillion: { readonly input: number; readonly output: number };
      }
    | undefined;
  resolveRoute(result: RevisionTransportResult): CanonicalClassifyRoute | undefined;
}
export interface RevisionRequestBudget {
  readonly registry: RevisionRegistryLike;
  readonly mode: "sync" | "background";
  readonly budgetMs: number;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
  readonly jobId?: string;
  /** Missing means zero: revision is never an implicit paid opt-in. */
  readonly jobCostCapUsd?: number;
}
export interface RevisionGenerateRequest extends RevisionRequestBudget {
  readonly instruction: "rewrite-single" | "merge-survivor";
  readonly target: RevisionBlockInput;
  readonly context?: RevisionBlockInput;
}
export interface RevisionCoverageRequest extends RevisionRequestBudget {
  readonly target: RevisionBlockInput;
  readonly context?: RevisionBlockInput;
  readonly candidateBody: string;
}
export type RevisionUnavailable = {
  readonly kind: "unavailable";
  readonly reason: "revision-unavailable" | "invalid-output";
};
export type RevisionGenerateResult =
  | RevisionUnavailable
  | {
      readonly kind: "ok";
      readonly body: string;
      readonly outputDigest: string;
      readonly provenance: ClientProvenance;
      /** False means generation can only support a suggestion, not full coverage. */
      readonly inputComplete: boolean;
      readonly costUsd: number;
    };
export type RevisionCoverageResult =
  | RevisionUnavailable
  | {
      readonly kind: "ok";
      readonly verdict: "complete" | "partial" | "unknown";
      readonly targetRev: string;
      readonly beforeDigest: string;
      readonly candidateDigest: string;
      readonly promptVersion: string;
      readonly provenance: ClientProvenance;
      readonly inputComplete: boolean;
      readonly costUsd: number;
    };

// ───────────────────────────── P50 C0 shared revision contracts (factory-only, no wire) ─────────────────────────────
// Sole cross-C/D type owner. No audit/revision runtime imports or implementations.
// D's FreezeSpec/Deps/PlanInput/PrepareDeps/ReviewDeps remain private to D (§3.3).

/** File bytes admitted by D only after lossless UTF-8 round-trip and strict parse.
 * Copy custody is a runtime obligation: copy rawBefore on ingress, retain the
 * private copy, return a fresh copy on every read. readonly/Object.freeze do NOT
 * make Buffer bytes immutable. Do not send rawBefore/path/meta to the client. */
export interface FrozenRevisionBlock {
  readonly id: string;
  readonly rev: string;
  readonly rawBefore: Buffer;
  readonly rawDigest: string;
  readonly block: RevisionBlockInput & {
    readonly private: false;
    readonly secret: false;
    readonly parseErrors: readonly [];
    readonly storageScope?: never;
    readonly residue?: never;
    readonly origin?: never;
  };
}

export interface FrozenRevisionInput {
  readonly v: 1;
  /** Canonical MEMORY root, not blocks root. Epoch remains a separate live gate. */
  readonly directory: IncrementalDirectory;
  /** SHA-256 binding canonical realpath/dev/ino, not sessionEpoch. */
  readonly directoryIdentityDigest: string;
  /** P50.1 selection key, diagnostic only; never the final raw-evidence batch. */
  readonly selectionBatchId: string;
  /** SHA-256(sessionEpoch, directory identity, sorted frozen action set, policy). */
  readonly batchId: string;
  readonly policyVersion: string;
  /** SHA-256(batchId, action, target.id, target.rev). IDs are 64 lowercase hex. */
  readonly actionId: string;
  readonly action: RevisionProposal["action"];
  readonly target: FrozenRevisionBlock;
  readonly context?: FrozenRevisionBlock;
}

export interface RelationEvidence {
  readonly kind: "conflict" | "supersedes";
  readonly p: number;
  /** Frozen pair id/rev/RAW digest; NOT provenance.inputDigest (outbound DTO). */
  readonly inputDigest: string;
  readonly provenance: ClientProvenance;
}

export interface WholeCoverageEvidence {
  readonly v: 1;
  readonly verdict: "complete";
  readonly targetRev: string;
  /** Full BODY digests from B; audit.beforeDigest separately binds raw bytes. */
  readonly beforeDigest: string;
  readonly candidateDigest: string;
  readonly promptVersion: string;
  readonly provenance: ClientProvenance;
  readonly evidenceDigest: string;
}

/** Independently recomputed expectations, never copied from returned provenance.
 * Structurally consumed by B's independentCoverageSources once all three exist.
 * Missing entries can support suggestions only, never automatic permission. */
export type RevisionEvidenceBindings = Readonly<
  Partial<
    Record<
      "relation" | "generation" | "coverage",
      {
        readonly requestDigest: string;
        readonly inputDigest: string;
      }
    >
  >
>;

export type ExpiryPayload =
  | { readonly op: "set"; readonly nextExpires: string; readonly dateRuleVersion: string }
  | { readonly op: "clear"; readonly dateRuleVersion: string; readonly nextExpires?: never };

export interface RevisionProposalBase {
  readonly v: 1;
  readonly actionId: string;
  readonly batchId: string;
  readonly targetId: string;
  readonly expectedRev: string;
  readonly contextId?: string;
  readonly contextExpectedRev?: string;
  readonly reason: "conflict" | "supersedes" | "expired" | "duplicate" | "budget";
  readonly relation?: RelationEvidence;
  readonly coverage?: WholeCoverageEvidence;
  readonly policyVersion: string;
  readonly directoryIdentityDigest: string;
  readonly evidenceBindings: RevisionEvidenceBindings;
  /** Canonical digest of the ENTIRE payload except this field. No Buffer,
   * registry, signal, function or filesystem path may be persisted in a proposal. */
  readonly proposalDigest: string;
  /** Hint only, never commit authorization. E must recheck every locked gate. */
  readonly autoEligible: boolean;
}

/** Reuses B's successful generation shape, preserving truncation evidence.
 * A deterministic suggestion may omit the whole bundle, never part of it.
 * Body must pass the existing govern/revision-output.ts validator in D. */
export type RevisionGenerationPayload =
  | {
      readonly generatedBody: string;
      readonly outputDigest: RevisionGenerateSuccess["outputDigest"];
      readonly generationProvenance: RevisionGenerateSuccess["provenance"];
      readonly generationInputComplete: RevisionGenerateSuccess["inputComplete"];
    }
  | {
      readonly generatedBody?: never;
      readonly outputDigest?: never;
      readonly generationProvenance?: never;
      readonly generationInputComplete?: never;
    };
type RevisionGenerateSuccess = Extract<RevisionGenerateResult, { readonly kind: "ok" }>;

export type RevisionProposal = RevisionProposalBase &
  (
    | ({ readonly action: "rewrite-single" | "merge-survivor"; readonly expiry?: never } & RevisionGenerationPayload)
    | {
        readonly action: "retire" | "delete";
        readonly expiry?: never;
        readonly generatedBody?: never;
        readonly outputDigest?: never;
        readonly generationProvenance?: never;
        readonly generationInputComplete?: never;
      }
    | {
        readonly action: "expires";
        readonly expiry: ExpiryPayload;
        readonly generatedBody?: never;
        readonly outputDigest?: never;
        readonly generationProvenance?: never;
        readonly generationInputComplete?: never;
      }
  );

type WithoutProposalDigest<T> = T extends unknown ? Omit<T, "proposalDigest"> : never;
export type RevisionProposalDigestInput = WithoutProposalDigest<RevisionProposal>;

/** Exact E-constructed bytes; C must not serialize a proposal to manufacture them.
 * Same copy custody as rawBefore, including all getter/read-result boundaries. */
export type ExpectedAfter =
  | { readonly kind: "file"; readonly raw: Buffer; readonly digest: string; readonly rev: string }
  | { readonly kind: "missing"; readonly raw?: never; readonly digest?: never; readonly rev?: never };

/** At most two relative, validated basenames. Never accept absolute paths from
 * an audit as write targets. C must enforce basename/byte bounds at runtime. */
export type RevisionPathEvidence = readonly [
  { readonly area: "blocks" | "trash" | "temp"; readonly name: string },
  { readonly area: "blocks" | "trash" | "temp"; readonly name: string }?,
];

/** Root's C0 technical clarification of the already-approved delete/link
 * semantics (not new product authorization): the old single rename shape could
 * not express missing. A trash link alone never proves source deletion.
 * Only trusted synchronous syscall observers in C/E may construct applied;
 * neither proposals nor post-hoc reads prove application. No applier in C0. */
export type ApplyObservation =
  | { readonly kind: "not-applied" }
  | {
      readonly kind: "applied";
      readonly expectedAfter: { readonly kind: "file"; readonly digest: string; readonly rev: string };
      readonly proof: "rename-observed" | "link-observed";
      readonly paths?: RevisionPathEvidence;
    }
  | {
      readonly kind: "applied";
      readonly expectedAfter: { readonly kind: "missing"; readonly digest?: never; readonly rev?: never };
      readonly proof: "unlink-observed";
      readonly paths?: RevisionPathEvidence;
    }
  | { readonly kind: "unknown"; readonly reason: string; readonly paths?: RevisionPathEvidence };

export interface RevisionAudit {
  readonly v: 1;
  readonly origin: "p50-auto" | "p50-suggestion" | "web-b3";
  readonly batchId: string;
  readonly actionId: string;
  readonly directoryIdentityDigest: string;
  readonly action: RevisionProposal["action"];
  readonly targetId: string;
  readonly expectedRev: string;
  readonly contextId?: string;
  readonly contextExpectedRev?: string;
  readonly contextRawDigest?: string;
  readonly inputDigest: string;
  readonly proposalDigest: string;
  readonly expiry?: ExpiryPayload;
  readonly relation?: RelationEvidence;
  readonly generationProvenance?: ClientProvenance;
  readonly generationInputComplete?: boolean;
  readonly outputDigest?: string;
  readonly coverage?: WholeCoverageEvidence;
  readonly evidenceBindings?: RevisionEvidenceBindings;
  /** Observation of the EXISTING client ledger, never a second budget owner. */
  readonly budget?: NonNullable<JevUsage["budget"]>;
  readonly beforeDigest: string;
  /** No redundant expectedAfterDigest/Rev: one source of expected identity. */
  readonly expectedAfter?:
    | { readonly kind: "file"; readonly digest: string; readonly rev: string; readonly file: "after.md" }
    | { readonly kind: "missing"; readonly digest?: never; readonly rev?: never; readonly file?: never };
  readonly beforeFile: "before.md";
  readonly policyVersion: string;
  readonly state: "prepared" | "proposed" | "committed" | "skipped" | "failed" | "commit-unknown" | "restored";
  readonly reason?: string;
  readonly createdAt: string;
  readonly settledAt?: string;
  /** Persisted BEFORE restore data syscall. An unresolved attempt forbids a
   * blind ordinary restore retry; committed/restored are not scan-downgraded. */
  readonly restoreAttempt?: {
    readonly state: "intent" | "effect-unknown";
    readonly startedAt: string;
    readonly observation?: ApplyObservation;
    readonly reason?: string;
  };
}

export type CommitActionResult =
  | { readonly kind: "committed"; readonly actionId: string; readonly afterRev?: string }
  | {
      readonly kind: "skipped";
      readonly actionId: string;
      readonly reason: "stale" | "permission" | "gate" | "digest" | "unavailable";
    }
  | {
      readonly kind: "effect-unknown";
      readonly actionId: string;
      readonly dataApplied: boolean | "unknown";
      readonly expectedAfterRev?: string;
      readonly reason: "post-apply-failure" | "observation-mismatch" | "finalization-failure";
    };

export type RestoreRevisionResult =
  | { readonly kind: "restored"; readonly actionId: string }
  | {
      readonly kind: "refused";
      readonly reason: "state" | "stale" | "permission" | "gate" | "corrupted" | "unavailable" | "ambiguous";
    }
  | { readonly kind: "effect-unknown"; readonly dataApplied: true | "unknown"; readonly reason: string };

/** Read-only, bounded classification. Unavailable includes incomplete scans;
 * never present a truncated enumeration as a complete absence of pending work. */
export type RevisionRecoveryDiagnostic =
  | {
      readonly kind: "action";
      readonly batchId: string;
      readonly actionId: string;
      readonly state: RevisionAudit["state"] | "corrupted";
      readonly reason?: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RevisionAuditDeps {
  readonly gate?: MemoryWriteGate;
  readonly signal?: AbortSignal;
  /** Host epoch/owner/directory lifetime; rechecked inside the SAME memDir lock. */
  isCurrent(): boolean;
  now(): Date;
}
export type AuditReadResult =
  | {
      readonly kind: "ok";
      readonly audit: RevisionAudit;
      readonly before: Buffer;
      readonly expectedAfter?: ExpectedAfter;
    }
  | { readonly kind: "missing" | "corrupted" | "unavailable"; readonly reason?: string };

export interface RevisionAuditPort {
  // All Locked calls are synchronous; caller already owns the memDir lock.
  readActionLocked(batchId: string, actionId: string): AuditReadResult;
  persistPreparedBarrierLocked(input: {
    readonly frozen: FrozenRevisionInput;
    readonly proposal: RevisionProposal;
    readonly origin: RevisionAudit["origin"];
  }): AuditReadResult;
  persistExpectedAfterBarrierLocked(input: {
    readonly batchId: string;
    readonly actionId: string;
    readonly proposalDigest: string;
    readonly expected: ExpectedAfter;
  }): AuditReadResult;
  /** Audit finalization seam ONLY; not E's commitAction, never applies a body. */
  finalizeCommitLocked(input: {
    readonly batchId: string;
    readonly actionId: string;
    readonly proposalDigest: string;
    readonly observation: ApplyObservation;
    readonly dataDirectories: readonly string[];
  }): CommitActionResult;
  scanPendingLocked(): readonly RevisionRecoveryDiagnostic[];
}

/** Signatures only: C implements these in govern/revision-audit.ts later. No
 * factory, restore command or runtime binding is exported/implemented by C0. */
export type CreateRevisionAuditPort = (memDir: string, deps: RevisionAuditDeps) => RevisionAuditPort;
export interface RestoreRevisionRequest {
  readonly actionId: string;
  readonly signal?: AbortSignal;
}
export type RestoreRevisionRaw = (
  memDir: string,
  request: RestoreRevisionRequest,
  deps: RevisionAuditDeps,
) => Promise<RestoreRevisionResult>;
export type RestoreRevisionRawLocked = (
  memDir: string,
  request: RestoreRevisionRequest,
  deps: RevisionAuditDeps,
) => RestoreRevisionResult;

/** Closure-owned identity token; forged/copied tokens are not accepted. These
 * helpers are shared by ask and the future in-client generate implementation;
 * callers cannot dispatch a provider with a reservation outside this kernel. */
export interface ClientAttemptReservation {
  readonly id: string;
  readonly jobId?: string;
  readonly maxProviderCalls: number;
  readonly reservedCostUsd: number;
}
export interface ClientAttemptBudgetInput {
  readonly mode: "sync" | "background";
  readonly jobId?: string;
  readonly jobCostCapUsd?: number;
  readonly maxProviderCalls: number;
  readonly worstCostUsd: number;
}

export interface ClientAnswerProvenance {
  readonly questionIds: readonly string[];
  readonly provenance: ClientProvenance;
}

// ───────────────────────────── client / status (jev-arch §5.1–§5.3) ─────────────────────────────

export type JevDuty = "probe" | "recall" | "error" | "tag" | "tag-major" | "review";

export interface JevRequest {
  readonly duty: JevDuty;
  readonly registry: ClassifierRegistryLike;
  readonly state: JsonObject;
  readonly questions: Record<string, JevQuestion>;
  readonly budgetMs: number;
  /** sync: ≤3 batches in flight · background: ≤4, aborted on session_shutdown. */
  readonly mode: "sync" | "background";
  readonly signal?: AbortSignal;
  /** P50 only; absent job cap is the client cap. A named job requires a cap. */
  readonly jobId?: string;
  readonly jobCostCapUsd?: number;
}

export type JevOutcome =
  | {
      readonly ok: true;
      readonly model: string;
      readonly answers: Record<string, JevAnswer>;
      readonly missing: readonly string[];
      readonly costUsd: number;
      readonly latencyMs: number;
      /** P50 only. Split answers retain per-dispatch evidence; never flatten. */
      readonly sources?: readonly ClientAnswerProvenance[];
      readonly provenance?: ClientProvenance;
    }
  | {
      readonly ok: false;
      readonly reason: "off" | "unavailable" | "budget" | "timeout" | "aborted" | "all-failed";
      readonly detail: string;
    };

export interface JevUsage {
  readonly costUsd: number;
  readonly calls: number;
  /** P50 only; absent off, so legacy reports remain byte-identical. */
  readonly budget?: {
    readonly settledCostUsd: number;
    readonly reservedCostUsd: number;
    readonly reservedCalls: number;
    readonly outstanding: number;
    readonly zombies: number;
    readonly queued: { readonly sync: number; readonly background: number };
    readonly costSource: "none" | "usage" | "reserve" | "mixed";
    readonly overReservedUsd: number;
    readonly adjustmentUsd: number;
    readonly exhausted: boolean;
    readonly disposed: boolean;
  };
}

export interface JevClient {
  /** Synchronous, zero IO. */
  status(): JevStatus;
  /** Never rejects. */
  ask(req: JevRequest): Promise<JevOutcome>;
  /** Optional for legacy client facades. Only the real handle implements these. */
  generateRevision?(req: RevisionGenerateRequest): Promise<RevisionGenerateResult>;
  judgeRevisionCoverage?(req: RevisionCoverageRequest): Promise<RevisionCoverageResult>;
  /** Forces an availability-cache refresh (review #12). */
  probe(registry: ClassifierRegistryLike, signal?: AbortSignal): Promise<JevStatus>;
}

/** Off reasons (settings-period: disabled/legacy/secure/empty-list; runtime:
 *  pi-api). Shared by JevStatus and resolveJevWiring's report. */
export type JevStatusReason = "disabled" | "secure" | "legacy" | "pi-api" | "empty-list";

export type JevStatus =
  | { kind: "off"; reason: JevStatusReason }
  | { kind: "probing" }
  | { kind: "full"; model: string }
  | { kind: "partial"; reason: string; retryAt?: number; inactive: boolean };

/** Per-model health states stored in the process-level shared table. */
export type HealthState = "unknown" | "ok" | "unavailable" | "transient" | "not-found" | "no-auth";

export interface HealthEntry {
  readonly state: HealthState;
  readonly code?: string;
  /** Isolation deadline (epoch ms); reaching it returns the model to unknown. */
  readonly until?: number;
  /** Consecutive transient failures (3 ⇒ 10-minute isolation). */
  readonly transientFails?: number;
}

/** Process-level table behind `Symbol.for("pi-subagent:memory-jev-health")`
 *  (≤ HEALTH_TABLE_MAX entries; J2 implements, `/reload` clears). */
export interface HealthTable {
  get(model: string): HealthEntry | undefined;
  set(model: string, entry: HealthEntry): void;
  entries(): readonly (readonly [string, HealthEntry])[];
  clear(): void;
}

/** Child-session token bucket behind `Symbol.for("pi-subagent:memory-jev-bucket")`
 *  — TOKEN_BUCKET_CAPACITY takes within TOKEN_BUCKET_WINDOW_MS (J2). */
export interface TokenBucket {
  tryTake(now: number): boolean;
}

/** `notifyFor(prev, next, ctx)` verdicts (J2 health.ts). */
export type NotifyKind = "first-full" | "degraded" | "recovered" | "startup-partial";

/** A-layer (tool_call fast path) admission + cooldown knobs (2026-11-03
 *  noise fix, run r_YE7XM20Q data: generic tags like testing/ci/workflow
 *  fired ~71% of injections). Eligibility: `risk:"high"` tags plus
 *  `allowTags`, minus `denyTags`. */
export interface JevFastPathConfig {
  /** Extra tag ids allowed to trigger the A layer (on top of risk:"high"). */
  readonly allowTags: readonly string[];
  /** Tag ids never allowed to trigger the A layer (wins over risk/allow). */
  readonly denyTags: readonly string[];
  /** Per-entry cross-session A-injection cooldown; 0 disables. */
  readonly cooldownMs: number;
}

export const DEFAULT_JEV_FAST_PATH: JevFastPathConfig = {
  allowTags: [],
  denyTags: [],
  cooldownMs: 86_400_000, // 24h
};

/** `memory.jev.predict.model.*` (memory-predict plan §10) — parsed in P1b,
 *  consumed only in P2 (§11.2); nothing in `src/memory/jev/predict/*` or
 *  `wire.ts`'s P1b orchestration reads this block yet. */
export interface PredictModelConfig {
  readonly enabled: boolean;
  readonly models: readonly string[];
  readonly threshold: number;
  readonly waitMs: number;
  readonly requestBudgetMs: number;
  readonly maxCallsPerDay: number;
  readonly maxUsdPerDay: number;
}

/** `memory.jev.predict.*` (memory-predict plan §10/§11.1) — the pure config
 *  J6-style `jevConfigOf` maps out of `MemorySettings.jev.predict`. */
export interface PredictJevConfig {
  readonly enabled: boolean;
  readonly childSessions: boolean;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly cooldownMs: number;
  readonly hintU: boolean;
  readonly model: PredictModelConfig;
  readonly cacheTtlMin: number;
}

/** `JevConfig` — the pure config J6 maps out of `MemorySettings.jev` (J3).
 *  Frozen verbatim from jev-plan §2 (+ the fastPath block added by the
 *  2026-11-03 noise fix). */
export interface JevConfig {
  readonly classifiers: readonly string[]; // provider/id, deduped in order
  readonly proxy: string; // "" ⇒ do not pass a fetch
  readonly childSessions: boolean;
  readonly recall: { threshold: number; maxEntries: number; maxBytes: number; waitMs: number };
  readonly reviewIntervalDays: number;
  readonly maxCostUsd: number;
  readonly maxCalls: number;
  readonly fastPath: JevFastPathConfig;
  /** memory-predict plan §10 — P1b wires rules/state/carry/select off this;
   *  `predict.model` is parsed but not consumed until P2 (§11.2). */
  readonly predict: PredictJevConfig;
}

// ───────────────────────────── injection wire shapes (jev-arch §6.1.6) ─────────────────────────────

export type InjectLayer = "U" | "A" | "E" | "B" | "P" | "R"; // #36: R = 常驻变更通知（arch §3.3.5）

/** I7: runtime names never move — `subagent:` prefix stays. */
export const MEMORY_INJECT_CUSTOM_TYPE = "subagent:memory-inject";
export const MEMORY_RECALL_CUSTOM_TYPE = "subagent:memory-recall";
/** memory-predict plan §3.3/§9.4: per-turn carry/call ledger entries
 *  (`kind: "final" | "call"`); only `wire.ts` + `predict/carry.ts` interpret
 *  the payload — this file just reserves the customType string (I7). */
export const MEMORY_PREDICT_CUSTOM_TYPE = "subagent:memory-predict";

export interface MemoryRecallItemV1 {
  readonly file: string;
  readonly anchor: string;
  readonly hash: EntryHash;
  readonly authority: "user" | "agent";
  readonly type?: EntryType;
  readonly p?: number;
}

/** One layer's worth of injected items inside a merged `before_agent_start`
 *  return (memory-predict plan §5.3/§6.1 field table; C-J16 proved the
 *  channel with this exact shape). */
export interface MemoryInjectPartV1 {
  readonly layer: InjectLayer;
  readonly trigger: string;
  readonly model?: string;
  readonly partial?: true;
  readonly items: readonly MemoryRecallItemV1[];
}

/** `subagent:memory-inject` message details — append-only fields (v1 base).
 *  `parts`/`predict` are memory-predict plan §5.3 additions: present only on
 *  a merged P+U message (P1b, §11.1) — a U-only message stays byte-identical
 *  to pre-P1 (no `parts`, no `predict`). */
export interface MemoryInjectDetailsV1 {
  readonly v: 1;
  readonly layer: InjectLayer;
  readonly trigger: string;
  readonly model?: string;
  readonly partial?: true;
  readonly items: readonly MemoryRecallItemV1[];
  /** Present only when this message merges more than one layer (plan §5.3). */
  readonly parts?: readonly MemoryInjectPartV1[];
  /** Predict summary riding along the merged message (plan §5.3/§6.1):
   *  informational only, never consumed by the model logic itself. */
  readonly predict?: {
    readonly tags: readonly string[];
    readonly state?: readonly string[];
    readonly origin: string;
    /** #36 §6.4: this turn's P injection used the high-risk-tag cooldown
     *  starvation bypass (≤1 per turn, ≤1 per block per segment). */
    readonly bypass?: true;
  };
  /** #36 R 层（arch §3.3.5，r5 裁定 8）：本条 R 通知发出时的常驻账本快照 ——
   *  resume/reload 后按 snapshotKey 匹配最近一条恢复 ledger；"ledger 是 id →
   *  renderKey 的有序对"，消费方只在 wire.ts（P5b 接线）。Append-only：不
   *  带 resident 的旧消息不受影响。 */
  readonly resident?: { readonly snapshotKey: string; readonly ledger: readonly (readonly [string, string])[] };
}

/** `subagent:memory-recall` appendEntry record — segment dedup seeding.
 *  (Historic records may still carry a `gates` array from the removed gate
 *  feature; the seeder ignores unknown keys.) */
export interface MemoryRecallEntryV1 {
  readonly v: 1;
  readonly layer: InjectLayer;
  readonly keys: readonly EntryHash[];
  /** compaction id, B-layer re-injection only. */
  readonly bFor?: string;
}

/** `subagent:memory-predict` appendEntry `kind:"call"` 记录（§9.4 账目，每
 *  个真正 STARTED 的 flight 一条；被拒的准入不记）。wire.ts 目前以字面量构
 *  造；#36 P0 在此先行声明形状（含 §6.5 追加的 windowMs/attempts），P6a 接
 *  管构造点后按本类型对齐。 */
export interface PredictCallEntry {
  readonly v: 1;
  readonly kind: "call";
  readonly at: string;
  /** `ok` 时为实际模型，否则模型链逗号串。 */
  readonly model: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly reason?: string;
  readonly reserveUsd: number;
  readonly costUsd: number;
  readonly costSource: string;
  readonly timely: boolean;
  /** #36 §6.5：本次实际生效的等待窗口与 failover 尝试档数。 */
  readonly windowMs?: number;
  readonly attempts?: number;
}

// ───────────────────────────── effective metadata (jev-arch §4.4) ─────────────────────────────

/** Inline authority ⊕ sidecar derived ⊕ defaults (jev-arch §4.4) — J2's
 *  `effectiveMeta` output. */
export interface EffectiveMeta {
  /** Sidecar tags with p ≥ 0.6 ∪ inline `+` − inline `-`. */
  readonly tags: readonly string[];
  readonly authority: "user" | "agent";
  /** Undefined for pending entries without inline data (fast path then treats
   *  manual-tag entries as important rules, §6.1.3). */
  readonly importance: Importance | undefined;
  readonly type: EntryType | undefined;
  /** No sidecar tags under the current hash (edited since last tagging). */
  readonly pending: boolean;
}

// ───────────────────────────── ports (consumed by J4–J8) ─────────────────────────────

/** `JevWritePort` — frozen verbatim from jev-plan §2; #36 (arch r5 §4.4,
 *  裁定 9) appends the OPTIONAL `block`/`askScope` inputs and `relations`
 *  return field on the SAME method name — no `runAfterWrite`. Omitting the
 *  new fields keeps the v2 call form byte-identical (v2 callers unchanged). */
export interface JevWritePort {
  /** 写入提交后、锁外调用；永不 reject；返回回显行与 usage（C-J12 决定 usage 放哪个字段）。 */
  afterWrite(input: {
    cwd: string;
    /** blocks 布局下为 "<id>.md"。 */
    file: string;
    /** blocks 布局下为旧块文件全文（create 时 undefined）。 */
    before: string | undefined;
    /** blocks 布局下为新块文件全文。 */
    after: string;
    signal?: AbortSignal;
    registry: ClassifierRegistryLike | undefined;
    // ── #36 追加（均可缺省；缺省时行为与 HEAD 逐字节相同）──
    /** blocks 布局写入时由 tool-v3 传入；v2 路径不传。 */
    readonly block?: {
      readonly id: string;
      /** 写入后的 rev，供取代判定记录。 */
      readonly rev: string;
      readonly authority: "user" | "agent";
      /** 本次写入是否显式写了 scope=。 */
      readonly scopeExplicit: boolean;
    };
    /** true ⇒ 本次打标问句集合中加入 g1（arch §5.3）；缺省 false。 */
    readonly askScope?: boolean;
    /** Governance-only directed whole-block relation criteria; omitted by v2/off callers. */
    readonly wholeRelation?: boolean;
  }): Promise<{
    echo: readonly string[];
    usage?: { costUsd: number; calls: number };
    /** #36 追加：取代/冲突判定结果 —— 只判定不执行；执行在 govern/supersede.ts（P5a）。缺省 = 未判定。 */
    readonly relations?: readonly RelationVerdict[];
  }>;
  /** 写前同步校验：新引入的行内注释错误 ⇒ 返回错误文本（拒写）。 */
  checkInline(file: string, before: string | undefined, after: string): string | undefined;
  /** 用户令守卫：返回被删改的 user 条目（guardHash 配对，arch §6.2.5 / v4.1 §3.2）。 */
  touchedUserEntries(file: string, before: string, after: string, handWritten: boolean): readonly MemEntry[];
}

/** #36 写入时取代/冲突判定结果（arch r5 §4.4）。`auto` 已在判定侧应用取代
 *  矩阵、阈值与「每次写入合计 ≤2 条」上限；执行侧（P5a）在锁内复核
 *  `oldRev` 后才落地。 */
export interface RelationVerdict {
  readonly kind: "supersedes" | "conflict";
  readonly newId: string;
  readonly newRev: string;
  readonly oldId: string;
  /** 判定时读到的旧块 rev，执行时锁内复核。 */
  readonly oldRev: string;
  readonly p: number;
  /** 是否达到自动执行阈值。 */
  readonly auto: boolean;
}

/** `JevCommandPort` — frozen verbatim from jev-plan §2. */
export interface JevCommandPort {
  statusLine(cwd: string): string; // `/mem` default-list trailer line
  report(cwd: string, registry: ClassifierRegistryLike | undefined): Promise<string>; // `/mem jev`
  probe(registry: ClassifierRegistryLike | undefined): Promise<string>;
  retag(cwd: string, all: boolean, registry: ClassifierRegistryLike | undefined): Promise<string>;
  resetIndex(cwd: string): Promise<string>;
  tags: {
    list(cwd: string): string;
    add(cwd: string, def: TagDefInput): Promise<string>;
    remove(cwd: string, id: string): Promise<string>;
    setEnabled(cwd: string, id: string, enabled: boolean): Promise<string>;
  };
  review: {
    list(cwd: string): readonly ReviewSuggestionView[]; // includes stale flags
    run(cwd: string, registry: ClassifierRegistryLike | undefined): Promise<string>;
    dismiss(cwd: string, id: string): Promise<void>;
    resolve(cwd: string, id: string): Promise<void>;
  };
  readonly isChildSession: boolean;
}

export interface JevDoctorPort {
  /** D17–D19 switches + startup-reminder extras (expired count, core usage,
   *  open suggestions, Jev status). */
  extraReminder(cwd: string): readonly string[];
}

export interface JevRenderInfo {
  readonly primary?: string; // primary core file name
  readonly omittedSections: readonly string[]; // from TieredRenderResult.omittedSections
  readonly coreInlined: boolean;
  /** #36（arch §3.3.5）：常驻块的账本 id 集合（= ledger 的 id 集，不是当前
   *  渲染结果）——U/P 候选排除用。缺省 = 无常驻块（旧布局）。 */
  readonly residentBlocks?: readonly string[];
}

// ───────────────────────────── predict ports (memory-predict plan §2.1/§11.1) ─────────────────────────────

/** Todo snapshot port wire.ts reads for signal T (plan §1/§2.1). Structural
 *  mirror of the todo module's own snapshot shape so `src/memory/jev` never
 *  imports `src/todo`. */
export interface JevTodoPort {
  list(): readonly { id: number; subject: string; status: string }[];
}

/** Active-subagent-run count for signal W (plan §2.1 `activeSubagents`). */
export interface JevFleetPort {
  activeRuns(): number;
}

/** Minimal bash-job view for signal W (plan §2.1 `bashJobs`) — a narrower
 *  structural port than the full bashJobs module surface (status/command
 *  only; this is what `src/index.ts` already exposes via `holder.current
 *  ?.bashJobs?.list()`). */
export interface JevBashJobsLitePort {
  list(): readonly { status: string; command: string }[];
}

/** Structured UI port for pi-free command handlers (review/expired flows).
 *  `setEditorText` is optional — C-J14 verifies availability (P0 risk). */
export interface MemCommandUiLike {
  notify(text: string): void;
  confirm(title: string, body: string, opts?: { timeout?: number }): Promise<boolean>;
  select<T extends string>(title: string, options: readonly { value: T; label: string }[]): Promise<T | undefined>;
  setEditorText?(text: string): void;
}

// ───────────────────────────── `/mem jev` report view (jev-arch §9.4) ─────────────────────────────

/** Data shape behind format.ts `formatJevReport` — filled in by J4/J6. */
export interface JevReportModelRow {
  readonly id: string;
  /** e.g. "unavailable (451) until 12:40 — 451 多为地区拦截，可设 memory.jev.proxy". */
  readonly note?: string;
}

export interface JevReportView {
  /** Text after the `jev` label, e.g. "enabled · partial (…) · next probe 12:40". */
  readonly status: string;
  readonly models: readonly JevReportModelRow[];
  readonly stopped: readonly string[];
  readonly running: readonly string[];
  readonly tags: {
    readonly tagged: number;
    readonly total: number;
    readonly pending: number;
    readonly lastTaggedAt?: string;
    readonly taxonomyRev: string;
  };
  /** Text after the `proxy` label (credentials masked); absent ⇒ no proxy line. */
  readonly proxy?: string;
  readonly usage: { readonly calls: number; readonly costUsd: number; readonly maxCostUsd: number };
  readonly segment: {
    readonly injectedByLayer: Readonly<Partial<Record<InjectLayer, number>>>;
    readonly injectedTotal: number;
  };
  readonly review: { readonly lastRunAt?: string; readonly open: number };
  /** memory-predict plan §9.4 P1b slice: rule-engine fire count only (no
   *  model/cache/cost columns yet — those land with P2, §11.2). Absent
   *  ⇒ `predict.enabled=false` (I9: the report line disappears entirely). */
  readonly predict?: { readonly rules: number };
}

// ───────────────────────────── misc unnamed-type registrations ─────────────────────────────

/** jev/redact.ts field selector — each field has its own truncation budget
 *  (jev-arch §7.1 table). The P2 fields (predictRequest/predictPrev/todo/
 *  branch/tagDesc, memory-predict plan §11.2) are reserved here now so
 *  `RedactField` stays append-only; P1b never passes them to `redactForJev`. */
export type RedactField =
  | "user"
  | "previousUser"
  | "command"
  | "error"
  | "entry"
  | "predictRequest"
  | "predictPrev"
  | "todo"
  | "branch"
  | "tagDesc";

/** v4.1 §2.7.1 shell-parse output unit. */
export interface SimpleCommand {
  readonly argv: readonly string[];
  readonly program: string;
  readonly positionals: readonly string[];
  readonly cwd?: string;
}

/** `/mem expired` grouping (J8): date-passed vs event-condition entries. */
export type ExpiredKind = "expired" | "until";

// ───────────────────────────── frozen constants (jev-plan §2 freeze table) ─────────────────────────────

/** Recall candidate cap; beyond it a local lexical prefilter trims to this. */
export const RECALL_MAX_CANDIDATES = 360;
/** Token cap per question batch (estimateTokens accounting, J2). */
export const QUESTION_BATCH_TOKENS = 12_000;
/** Segment injection cap (this-segment dedup bound, §6.1.6). */
export const SEGMENT_MAX_INJECTED = 30;
/** Process-level health table capacity. */
export const HEALTH_TABLE_MAX = 32;
/** Child-session token bucket: takes per window. */
export const TOKEN_BUCKET_CAPACITY = 30;
export const TOKEN_BUCKET_WINDOW_MS = 60_000;
/** Sidecar index: max entries / max file bytes before GC. */
export const SIDECAR_MAX_ENTRIES = 2000;
export const SIDECAR_MAX_BYTES = 1_000_000;
/** A-layer cooldown map cap (oldest stamps evicted first). */
export const A_INJECTED_AT_MAX = 512;
/** P-layer cooldown map cap — same size as the A-layer table (memory-predict
 *  plan §2.1). */
export const P_INJECTED_AT_MAX = A_INJECTED_AT_MAX;
/** Max enabled tags (presets + user). */
export const MAX_ENABLED_TAGS = 64;
/** Inline authority comment byte budget (§4.2: ≤200B). */
export const INLINE_META_MAX_BYTES = 200;

// ───────────────────────────── #36 S0 governance names (not wired) ─────────────────────────────
// docs/dev/memory-governance/p5b-contracts.md is the lifecycle/ownership contract.
// Additive names only: no existing interface, default, hook or wire payload changes.

/** Successful operation edges, coalesced at the next existing turn_end.
 * Intent, read-only results and aborts never create a governance event. */
export const JEV_GOVERNANCE_EVENTS = ["task-done", "push", "release"] as const;
export type JevGovernanceEvent = (typeof JEV_GOVERNANCE_EVENTS)[number];

/** Renderer observations; dedup belongs to govern/signals.ts, not the
 * ordinary sweep corpus fingerprint. Resident budgets never truncate rules. */
export const JEV_GOVERNANCE_BUDGET_SIGNALS = ["resident-over-budget", "index-overflow"] as const;
export type JevGovernanceBudgetSignal = (typeof JEV_GOVERNANCE_BUDGET_SIGNALS)[number];

/** Reserved keys in blocks/.jev/governance-markers.json (format v:1).
 * Only govern/markers.ts may persist them; neither belongs in JevIndexV1.
 * Completed review means one bounded pass, NOT exhaustive corpus coverage. */
export const JEV_GOVERNANCE_FIRST_USER_REVIEW_MARKER = "first-user-review/v1";
export const JEV_GOVERNANCE_RELOAD_REMINDER_MARKER = "migration-reload-reminder/v1";
export type JevGovernanceMarkerKey =
  typeof JEV_GOVERNANCE_FIRST_USER_REVIEW_MARKER | typeof JEV_GOVERNANCE_RELOAD_REMINDER_MARKER;
