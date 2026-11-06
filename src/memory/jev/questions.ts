// Classifier question construction for the five Jev duties (jev-arch
// §6.1.1/§6.1.4/§6.2.2/§6.2.3/§6.3.3, jev-plan J2; the gate duty was removed
// with the gate feature, 2026-11).
//
// Convention (not individually frozen — J2's own choice, documented for
// J4/J6/J7 callers): every `build*Questions` function returns
// `{ state, questions }`, ready to hand straight to `splitBatches` and then
// `JevClient.ask`. Question ids follow the plan's id scheme (`e<n>`, `m_*`,
// `t_<id>`, `c<n>`, `p<n>`, `o<n>`).
//
// `scripts/dev/jev-eval.mjs` keeps a literal copy of the STATIC templates
// (the parts that don't depend on project-specific taxonomy/compare input) —
// `tests/memory/jev/questions-eval-parity.test.ts` pins the two in sync.
//
// Pi-free root; pure functions only, no module state (I4).

import { QUESTION_BATCH_TOKENS } from "./contracts.js";
import type { EntryType, JevQuestion, JsonObject, TagDef, Taxonomy } from "./contracts.js";
import { tagCriteria } from "./taxonomy.js";

// ───────────────────────────── token estimation & batching (§6.1.1) ─────────────────────────────

function criteriaText(q: JevQuestion): string {
  if (q.type === "choice") return Object.values(q.criteria).join(" ");
  if (q.type === "score") return q.criteria.join(" ");
  return `${q.criteria.true} ${q.criteria.false}`;
}

/** `est(q) = ceil(utf8(instructions + criteria) / 3) + 40` (jev-arch §5.1). */
export function estimateTokens(q: JevQuestion): number {
  const bytes = Buffer.byteLength(`${q.instructions} ${criteriaText(q)}`, "utf8");
  return Math.ceil(bytes / 3) + 40;
}

function estimateStateTokens(state: JsonObject): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(state), "utf8") / 3);
}

export interface QuestionBatch {
  readonly state: JsonObject;
  readonly questions: Record<string, JevQuestion>;
}

/** Greedily packs `questions` into batches of at most `cap` tokens
 *  (`state`'s estimated cost is charged against every batch, since every
 *  batch carries it — jev-arch §5.1). A single question heavier than `cap`
 *  still gets its own batch (never split below one question here). Preserves
 *  insertion order; never produces an empty-questions batch unless the input
 *  was itself empty (one empty batch, so callers always have something to
 *  send/await). */
export function splitBatches(
  state: JsonObject,
  questions: Record<string, JevQuestion>,
  cap: number = QUESTION_BATCH_TOKENS,
): readonly QuestionBatch[] {
  const stateTokens = estimateStateTokens(state);
  const entries = Object.entries(questions);
  const groups: Record<string, JevQuestion>[] = [];
  let current: Record<string, JevQuestion> = {};
  let currentTokens = stateTokens;
  for (const [id, q] of entries) {
    const qTokens = estimateTokens(q);
    if (Object.keys(current).length > 0 && currentTokens + qTokens > cap) {
      groups.push(current);
      current = {};
      currentTokens = stateTokens;
    }
    current[id] = q;
    currentTokens += qTokens;
  }
  if (Object.keys(current).length > 0 || groups.length === 0) groups.push(current);
  return groups.map((qs) => ({ state, questions: qs }));
}

// ───────────────────────────── U/E layer: recall & error (§6.1.1/§6.1.4) ─────────────────────────────

export interface RecallEntryLike {
  readonly type?: EntryType;
  readonly authority: "user" | "agent";
  readonly importance?: 0 | 1 | 2 | 3;
  readonly tags?: readonly string[];
}

const IMPORTANCE_WORDS = ["background", "useful", "important", "critical"] as const;

/** Bracket label e.g. `[rule · user rule · critical · tags: release]`
 *  (jev-arch §6.1.1 example). Exported so the eval script's hand-rolled
 *  entries (which embed a pre-built label) and J4's candidate builder agree
 *  on the shape. */
export function recallLabel(entry: RecallEntryLike): string {
  const parts: string[] = [];
  if (entry.type !== undefined) parts.push(entry.type);
  parts.push(entry.authority === "user" ? "user rule" : "assistant lesson");
  if (entry.importance !== undefined) parts.push(IMPORTANCE_WORDS[entry.importance]);
  if (entry.tags !== undefined && entry.tags.length > 0) parts.push(`tags: ${entry.tags.join(", ")}`);
  return parts.join(" · ");
}

export interface RecallQuestionEntry {
  readonly label: string;
  readonly file: string;
  readonly excerpt: string;
}

/** The single e<n> question template (jev-arch §6.1.1 JSON example), VERBATIM
 *  — mirrored literally in `scripts/dev/jev-eval.mjs`'s `buildRecallQuestion`
 *  (parity-tested). `state` is accepted but unused: the wording doesn't
 *  reference it, only the id's position in `state` does (the caller's job). */
export function buildRecallQuestion(entry: RecallQuestionEntry, _state?: JsonObject): JevQuestion {
  return {
    type: "bool",
    instructions:
      `Project memory entry [${entry.label}] from ${entry.file}: 「${entry.excerpt}」. ` +
      "Would reminding the assistant of this entry right now help it handle user_message correctly or avoid a known mistake (previous_user_message is context only)?",
    criteria: {
      true: "Yes: it applies to this request — a rule, pitfall or procedure the assistant should follow here",
      false: "No: unrelated, or only shares surface keywords without affecting how to handle this request",
    },
  };
}

export interface RecallCandidate extends RecallEntryLike {
  readonly id: string; // e.g. `e17` — caller-assigned, stable within one call
  readonly file: string;
  readonly excerpt: string; // already redacted/truncated (jev/redact.ts "entry" field)
}

export function buildRecallQuestions(input: {
  readonly userMessage: string;
  readonly previousUserMessage?: string;
  readonly session: "main" | "child";
  readonly today: string;
  readonly candidates: readonly RecallCandidate[];
}): QuestionBatch {
  const state: JsonObject = {
    user_message: input.userMessage,
    ...(input.previousUserMessage === undefined ? {} : { previous_user_message: input.previousUserMessage }),
    session: input.session,
    today: input.today,
  };
  const questions: Record<string, JevQuestion> = {};
  for (const c of input.candidates) {
    questions[c.id] = buildRecallQuestion({ label: recallLabel(c), file: c.file, excerpt: c.excerpt });
  }
  return { state, questions };
}

export interface ErrorCandidate {
  readonly id: string;
  readonly file: string;
  readonly excerpt: string;
  readonly type?: EntryType;
}

/** E-layer failure-recall questions (jev-arch §6.1.4): `state = {tool,
 *  command, exit_code, error_excerpt}`, one bool per candidate. */
export function buildErrorQuestions(input: {
  readonly tool: string;
  readonly command: string;
  readonly exitCode: number | undefined;
  readonly errorExcerpt: string;
  readonly candidates: readonly ErrorCandidate[];
}): QuestionBatch {
  const state: JsonObject = {
    tool: input.tool,
    command: input.command,
    ...(input.exitCode === undefined ? {} : { exit_code: input.exitCode }),
    error_excerpt: input.errorExcerpt,
  };
  const questions: Record<string, JevQuestion> = {};
  for (const c of input.candidates) {
    questions[c.id] = {
      type: "bool",
      instructions:
        `Project memory entry${c.type === undefined ? "" : ` [${c.type}]`} from ${c.file}: 「${c.excerpt}」. ` +
        "Can this entry explain the failure described in state, or say how to fix or avoid it?",
      criteria: {
        true: "Yes, it explains the failure or how to fix/avoid it",
        false: "No, unrelated to this failure",
      },
    };
  }
  return { state, questions };
}

// ───────────────────────────── tagging (§6.2.2/§6.2.3) ─────────────────────────────

/** The 5 fixed `m_*` questions (jev-arch §6.2.2, VERBATIM) — their wording
 *  never references the entry itself, only `taxonomy.types`'s descriptions
 *  (also fixed, `taxonomy.ts` `ENTRY_TYPES`). Exported standalone so
 *  `scripts/dev/jev-eval.mjs` can mirror exactly this subset (parity-tested)
 *  without needing the full taxonomy/compare machinery. */
export function buildTagCoreQuestions(taxonomy: Taxonomy): Record<string, JevQuestion> {
  return {
    m_type: {
      type: "choice",
      instructions: "What kind of project-memory entry is this?",
      criteria: Object.fromEntries(taxonomy.types.map((t) => [t.id, t.description])),
    },
    m_importance: {
      type: "score",
      instructions: "How costly is it for the assistant to ignore this entry?",
      criteria: [
        "background",
        "useful",
        "important: ignoring causes rework",
        "critical: ignoring causes an incident or violates an explicit user order",
      ],
    },
    m_guard: {
      type: "bool",
      instructions:
        "Does this entry restrict, or require checks before, a dangerous or irreversible action (push, release, delete, history rewrite, dependency change, credential use, dispatching agents)?",
      criteria: { true: "Yes, it guards such an action", false: "No" },
    },
    m_temporal: {
      type: "choice",
      instructions: "Is this entry permanent or temporary?",
      criteria: {
        permanent: "Holds until someone changes it",
        dated: "Temporary, tied to a date or period",
        event: "Temporary, until some event happens",
      },
    },
    m_userlike: {
      type: "bool",
      instructions:
        "Does this entry read like an order, ruling or preference stated by the user (not a lesson the assistant learned)?",
      criteria: { true: "User order/ruling/preference", false: "Assistant's own lesson or fact" },
    },
  };
}

export interface TagCompareCandidate {
  readonly id: string; // `c1`..`c20`
  readonly file: string;
  readonly excerpt: string;
}

/** #36 P4 (arch r5 §5.3) — the g1 scope question's id, exported for
 *  tagOne/write-port answer extraction and tests. */
export const SCOPE_QUESTION_ID = "g1";

/** Full per-write tagging call (jev-arch §6.2.2): 5 `m_*` + one `t_<id>` per
 *  enabled tag (≤64) + up to 20 `c<n>` comparisons. #36 P4: the optional
 *  fourth argument adds the g1 scope question (asked in the SAME askAll as
 *  the tagging questions — arch r5 §4.4); without it the question set is
 *  byte-identical to the pre-#36 shape. */
export function buildTagQuestions(
  entry: { readonly body: string; readonly file: string; readonly heading?: string; readonly today: string },
  taxonomy: Taxonomy,
  compare: readonly TagCompareCandidate[],
  opts?: { readonly includeScope?: boolean },
): QuestionBatch {
  const state: JsonObject = {
    entry: entry.body,
    file: entry.file,
    heading: entry.heading ?? "",
    today: entry.today,
  };
  const questions: Record<string, JevQuestion> = { ...buildTagCoreQuestions(taxonomy) };
  for (const tag of taxonomy.tags) questions[`t_${tag.id}`] = tagCriteria(tag);
  for (const c of compare.slice(0, 20)) {
    questions[c.id] = {
      type: "choice",
      instructions: `Compare the entry in state with this existing entry from ${c.file}: 「${c.excerpt}」. What is their relation?`,
      criteria: {
        unrelated: "Unrelated topics",
        duplicate: "Same content",
        conflict: "They contradict each other",
        supersedes: "The entry in state replaces the existing one",
        complementary: "Related, both needed",
      },
    };
  }
  if (opts?.includeScope === true) {
    questions[SCOPE_QUESTION_ID] = {
      type: "bool",
      instructions:
        "Is the user rule in state a standing rule that applies to all work in this project (global), " +
        "rather than a decision about one feature or subsystem (topic)?",
      criteria: {
        true: "Global standing rule — applies to every task in this project",
        false: "Topic-scoped decision — only applies to one feature or subsystem",
      },
    };
  }
  return { state, questions };
}

export interface TagMajorEntry {
  readonly id: string;
  readonly excerpt: string;
}

/** Batch "tag-major" call (jev-arch §6.2.3): one call per tag, `state =
 *  {tag: "<id>: <description>"}`, one bool question per entry. */
export function buildTagMajorQuestions(tag: TagDef, entries: readonly TagMajorEntry[]): QuestionBatch {
  const state: JsonObject = { tag: `${tag.id}: ${tag.description}` };
  const questions: Record<string, JevQuestion> = {};
  for (const e of entries) {
    questions[e.id] = {
      type: "bool",
      instructions: `Is the project-memory entry below about the scenario named by "tag" in state? Entry: 「${e.excerpt}」`,
      criteria: { true: "Yes, about this tag's scenario", false: "No" },
    };
  }
  return { state, questions };
}

// ───────────────────────────── review (§6.3.3) ─────────────────────────────

export interface ReviewPairInput {
  readonly id: string; // `p<n>`
  readonly a: { readonly file: string; readonly updatedAt: string; readonly excerpt: string };
  readonly b: { readonly file: string; readonly updatedAt: string; readonly excerpt: string };
}

export interface StaleCandidateInput {
  readonly id: string; // `o<n>`
  readonly updatedAt: string;
  readonly temporal: "dated" | "event";
  readonly excerpt: string;
}

/** Review-pass questions (jev-arch §6.3.3): `p<n>` relation choice per pair,
 *  `o<n>` obsolescence bool per stale candidate. `state = {project, today}`. */
export function buildReviewQuestions(
  project: string,
  today: string,
  pairs: readonly ReviewPairInput[],
  staleCands: readonly StaleCandidateInput[],
): QuestionBatch {
  const state: JsonObject = { project, today };
  const questions: Record<string, JevQuestion> = {};
  for (const p of pairs) {
    questions[p.id] = {
      type: "choice",
      instructions:
        `Entry A (${p.a.file}, updated ${p.a.updatedAt}): 「${p.a.excerpt}」. ` +
        `Entry B (${p.b.file}, updated ${p.b.updatedAt}): 「${p.b.excerpt}」. ` +
        "What is the relation between A and B?",
      criteria: {
        unrelated: "Different topics",
        duplicate: "Same content; one can be removed",
        conflict: "They contradict and neither clearly replaces the other",
        a_supersedes_b: "A is newer/authoritative and makes B obsolete",
        b_supersedes_a: "B is newer/authoritative and makes A obsolete",
        complementary: "Related; both needed",
      },
    };
  }
  for (const o of staleCands) {
    questions[o.id] = {
      type: "bool",
      instructions:
        "Given today's date in state, is this temporary entry likely obsolete now? " +
        `Entry (updated ${o.updatedAt}, temporal: ${o.temporal}): 「${o.excerpt}」`,
      criteria: { true: "Likely obsolete; ask the user to confirm removal", false: "Still likely valid" },
    };
  }
  return { state, questions };
}
