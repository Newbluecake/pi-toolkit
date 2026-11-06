// Single-entry and bulk tagging orchestration (jev-arch §6.2.2/§6.2.3,
// jev-plan J4).
//
// `tagOne` is the per-write call: 5 `m_*` + one `t_<id>` per enabled tag +
// up to 20 `c*` comparisons (question building and the p ≥ 0.3 sidecar
// filter live in J2's `questions.ts` / `decide.ts`).
//
// `tagBulk` is the migration / backfill run (Q28): the TAG part issues one
// tag-major call per enabled tag (`state = {tag}`, one bool per entry),
// then the ENTRY part issues one 5-`m_*` call per still-pending entry with
// background concurrency 4. Any failed call (the client already failed over
// internally) stops the run — unprocessed entries simply stay pending. The
// optional `onEntryTags` sink delivers merged `EntryTags` records; results
// are merged over `base` (the current sidecar) so a single-tag backfill
// updates already-tagged entries in place.
//
// Private and secret entries are never sent (§7.2). All outbound text goes
// through `redactForJev`. Pi-free root; no module-scope state (I4).

import { decideTagging } from "./decide.js";
import {
  buildTagMajorQuestions,
  buildTagQuestions,
  SCOPE_QUESTION_ID,
  splitBatches,
  type TagCompareCandidate,
} from "./questions.js";
import { redactForJev } from "./redact.js";
import type {
  BulkResult,
  ClassifierRegistryLike,
  EntryHash,
  EntryTags,
  JevClient,
  JevOutcome,
  MemEntry,
  Taxonomy,
} from "./contracts.js";

/** Per-write tagging budget (J5's orchestration caps the WHOLE write at the
 *  same figure; a single call gets it and lets the client clamp). Raised
 *  3000 → 6000 (2026-11-04 all-failed fix): the client's §5.2 per-try cap is
 *  ceil(total/2), so at 3000 the paid fallback tier only ever saw ~1500ms
 *  while healthy proxy requests take 1.2–1.5s — zero margin. At 6000 each
 *  tier gets its full ~3000ms. */
const TAG_ONE_SYNC_BUDGET_MS = 6_000;
/** Background (bulk) calls get more headroom — no user is waiting sync. */
const TAG_ONE_BACKGROUND_BUDGET_MS = 6_000;
/**
 * Tag-major batch cap — the ONE deliberate exception to the §5.2
 * QUESTION_BATCH_TOKENS=12k rule (root-approved; to be written back into the
 * arch doc at J9). At 12k the arch's reference corpus (150 entries × ~81
 * estimated tokens/question ≈ 12.2k) splits into two batches per tag,
 * turning §6.2.3's "22 calls" into 44 and breaking the pinned 172-call
 * acceptance. The opencode channel's context is 32k, `est` (utf8/3 + 40)
 * already overestimates, and context-class errors still get the client's
 * split-in-half retry as a backstop — so 20k keeps one call per tag up to
 * ~200 entries while staying safely under the channel limit. All other
 * question kinds keep using QUESTION_BATCH_TOKENS.
 */
export const TAG_MAJOR_BATCH_TOKENS = 20_000;
/** Background entry-part concurrency (jev-arch §6.2.3 "后台并发 4"). */
const BULK_CONCURRENCY = 4;

/** Entries Jev may ever see: neither `private` nor secret-shaped (§7.2). */
export function taggableEntries(entries: readonly MemEntry[]): readonly MemEntry[] {
  return entries.filter((e) => e.inline.isPrivate !== true && !e.secret);
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function excerptOf(entry: MemEntry): string {
  return redactForJev(entry.body, "entry");
}

// ───────────────────────────── tagOne (§6.2.2) ─────────────────────────────

export interface TagOneInput {
  readonly client: JevClient;
  readonly registry: ClassifierRegistryLike;
  readonly entry: MemEntry;
  readonly taxonomy: Taxonomy;
  readonly compare: readonly TagCompareCandidate[];
  readonly mode: "sync" | "background";
  readonly signal?: AbortSignal;
  /** #36 P4 (arch r5 §4.4/§5.3): true ⇒ the g1 scope question joins this
   *  entry's askAll (same call, one round trip) and a bool answer lands in
   *  `EntryTags.globalP`. Default false ⇒ question set byte-identical. */
  readonly askScope?: boolean;
}

export interface TagOneResult {
  readonly tags?: EntryTags;
  readonly outcome: JevOutcome;
}

/** One full tagging call for one entry. Never throws. */
export async function tagOne(input: TagOneInput): Promise<TagOneResult> {
  if (input.entry.inline.isPrivate === true || input.entry.secret) {
    return {
      outcome: { ok: false, reason: "off", detail: "private/secret entries are never sent to Jev (§7.2)" },
    };
  }
  const { state, questions } = buildTagQuestions(
    {
      body: excerptOf(input.entry),
      file: input.entry.file,
      ...(input.entry.heading === undefined ? {} : { heading: input.entry.heading }),
      today: todayString(),
    },
    input.taxonomy,
    input.compare,
    ...(input.askScope === true ? [{ includeScope: true }] : []),
  );
  const outcome = await input.client.ask({
    duty: "tag",
    registry: input.registry,
    state,
    questions,
    budgetMs: input.mode === "sync" ? TAG_ONE_SYNC_BUDGET_MS : TAG_ONE_BACKGROUND_BUDGET_MS,
    mode: input.mode,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!outcome.ok) return { outcome };
  const tags = decideTagging(
    outcome.answers,
    input.taxonomy,
    outcome.model,
    new Date().toISOString(),
    input.entry.file,
  );
  // #36 P4 (arch r5 §5.3): the g1 answer shares the tagging askAll; a bool
  // answer's `probability` IS `globalP` (probability that this user rule is
  // a standing global rule). No answer ⇒ no field (never a default).
  const scopeAnswer = outcome.answers[SCOPE_QUESTION_ID];
  if (input.askScope === true && scopeAnswer !== undefined && scopeAnswer.type === "bool") {
    return { tags: { ...tags, globalP: scopeAnswer.probability }, outcome };
  }
  return { tags, outcome };
}

// ───────────────────────────── tagBulk (§6.2.3) ─────────────────────────────

export interface TagBulkInput {
  readonly client: JevClient;
  readonly registry: ClassifierRegistryLike;
  readonly entries: readonly MemEntry[];
  readonly taxonomy: Taxonomy;
  /** Tag id: run ONLY that tag's tag-major part (new/changed-description
   *  tag backfill). */
  readonly onlyTag?: string;
  readonly signal?: AbortSignal;
  /**
   * Current sidecar records — tag-major probabilities merge into these in
   * place. Omit (or pass `{}`) to force full re-tagging of every entry
   * (`/mem jev retag --all`).
   */
  readonly base?: Readonly<Record<EntryHash, EntryTags>>;
  /**
   * Result sink: called once per finalized `EntryTags` record (both merged
   * tag-major updates and fresh entry-major records). Without it the run
   * still counts calls/cost but drops the judgments.
   */
  readonly onEntryTags?: (hash: EntryHash, tags: EntryTags) => void;
}

interface BulkRunState {
  calls: number;
  costUsd: number;
  stopped: JevOutcome | undefined;
}

/**
 * Bulk tagging. Tag part: one call per tag (batched at
 * TAG_MAJOR_BATCH_TOKENS), every eligible entry one bool question. Entry
 * part (skipped for `onlyTag`): one call per pending entry (no sidecar
 * record under its current hash AND none produced in this run), 5 `m_*`
 * questions only, concurrency 4. The run stops as soon as the client
 * reports `off`/`partial` (checked before every ask — §6.2.3 "partial 时停",
 * explicit, not inferred from a failed call) or a call fails/aborts —
 * remaining entries stay pending. Never throws.
 */
export async function tagBulk(input: TagBulkInput): Promise<BulkResult> {
  const eligible = taggableEntries(input.entries);
  const base = input.base ?? {};
  const records = new Map<EntryHash, EntryTags>();
  const staged = new Map<EntryHash, Record<string, { p: number; rev: number }>>();
  const run: BulkRunState = { calls: 0, costUsd: 0, stopped: undefined };

  const recordFor = (hash: EntryHash): EntryTags | undefined => records.get(hash) ?? base[hash];
  const emit = (hash: EntryHash, tags: EntryTags): void => {
    records.set(hash, tags);
    input.onEntryTags?.(hash, tags);
  };
  /** §6.2.3 "partial 时停" is EXPLICIT: before every ask, read the client's
   *  status and stop once it is `off` or `partial` (`probing` still has an
   *  unknown-but-usable set; `full` obviously continues). This does not rely
   *  on the implicit premise "a failed ask implies partial" — though the
   *  real J2 client does degrade to partial on exactly those failures
   *  (all-failed / budget / off), which `run.stopped` below also catches
   *  (verifier item 5; pinned by the "status reports partial" test). */
  const degraded = (): boolean => {
    const s = input.client.status();
    return s.kind === "off" || s.kind === "partial";
  };
  const halted = (): boolean => run.stopped !== undefined || degraded() || input.signal?.aborted === true;

  const ask = async (
    duty: "tag" | "tag-major",
    state: Parameters<JevClient["ask"]>[0]["state"],
    questions: Parameters<JevClient["ask"]>[0]["questions"],
  ): Promise<JevOutcome> => {
    const outcome = await input.client.ask({
      duty,
      registry: input.registry,
      state,
      questions,
      budgetMs: TAG_ONE_BACKGROUND_BUDGET_MS,
      mode: "background",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    run.calls += 1;
    if (outcome.ok) run.costUsd += outcome.costUsd;
    return outcome;
  };

  const askTagMajor = async (tagId: string, targets: readonly MemEntry[]): Promise<boolean> => {
    const tag = input.taxonomy.tags.find((t) => t.id === tagId);
    if (tag === undefined || targets.length === 0) return true;
    const ids = targets.map((_, i) => `q${i + 1}`);
    const { state, questions } = buildTagMajorQuestions(
      tag,
      targets.map((entry, i) => ({ id: ids[i]!, excerpt: excerptOf(entry) })),
    );
    for (const batch of splitBatches(state, questions, TAG_MAJOR_BATCH_TOKENS)) {
      if (halted()) return false;
      const outcome = await ask("tag-major", batch.state, batch.questions);
      if (!outcome.ok) {
        run.stopped = outcome;
        return false;
      }
      for (const [id, answer] of Object.entries(outcome.answers)) {
        if (answer.type !== "bool") continue;
        const idx = ids.indexOf(id);
        if (idx === -1) continue;
        const target = targets[idx]!;
        const p = answer.probability;
        const existing = recordFor(target.hash);
        if (existing !== undefined) {
          const tags = { ...existing.tags };
          if (p >= 0.3) tags[tag.id] = { p, rev: tag.rev };
          else delete tags[tag.id];
          emit(target.hash, { ...existing, tags, taxonomyRev: input.taxonomy.rev });
        } else {
          const partial = staged.get(target.hash) ?? {};
          if (p >= 0.3) partial[tag.id] = { p, rev: tag.rev };
          else delete partial[tag.id];
          staged.set(target.hash, partial);
        }
      }
      // Questions this batch asked but the model left unanswered keep the
      // previous value (staged/existing) — missing answers are not evidence.
    }
    return true;
  };

  const askEntryMajor = async (entry: MemEntry): Promise<boolean> => {
    const { state, questions } = buildTagQuestions(
      {
        body: excerptOf(entry),
        file: entry.file,
        ...(entry.heading === undefined ? {} : { heading: entry.heading }),
        today: todayString(),
      },
      input.taxonomy,
      [], // bulk entry part asks the 5 m_* only (§6.2.3)
    );
    const outcome = await ask("tag", state, questions);
    if (!outcome.ok) {
      run.stopped = outcome;
      return false;
    }
    let tags = decideTagging(outcome.answers, input.taxonomy, outcome.model, new Date().toISOString(), entry.file);
    const partial = staged.get(entry.hash);
    if (partial !== undefined) tags = { ...tags, tags: { ...partial, ...tags.tags } };
    emit(entry.hash, tags);
    return true;
  };

  const runLimited = async (targets: readonly MemEntry[]): Promise<void> => {
    let next = 0;
    let stop = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop || halted()) return;
        const i = next++;
        if (i >= targets.length) return;
        if (!(await askEntryMajor(targets[i]!))) {
          stop = true;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, targets.length) }, worker));
  };

  const onlyTagDef = input.onlyTag === undefined ? undefined : input.taxonomy.tags.find((t) => t.id === input.onlyTag);
  if (input.onlyTag !== undefined && onlyTagDef === undefined) {
    // Unknown/disabled tag id — nothing to ask; everything stays as-is.
    const tagged = eligible.filter((e) => recordFor(e.hash) !== undefined).length;
    return { calls: 0, costUsd: 0, tagged, pending: eligible.length - tagged };
  }

  // Tag part: every enabled tag (or just `onlyTag`), over all eligible entries.
  const tagIds = onlyTagDef === undefined ? input.taxonomy.tags.map((t) => t.id) : [onlyTagDef.id];
  for (const tagId of tagIds) {
    if (halted()) break;
    if (!(await askTagMajor(tagId, eligible))) break;
  }

  // Entry part: pending entries only (skipped entirely for `onlyTag`).
  if (onlyTagDef === undefined && !halted()) {
    const pendingTargets = eligible.filter((e) => recordFor(e.hash) === undefined);
    await runLimited(pendingTargets);
  }

  const tagged = eligible.filter((e) => recordFor(e.hash) !== undefined).length;
  return { calls: run.calls, costUsd: run.costUsd, tagged, pending: eligible.length - tagged };
}
