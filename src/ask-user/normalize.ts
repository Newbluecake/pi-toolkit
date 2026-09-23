import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

import { HEADER_MAX_CHARS, type InputQuestion } from "./types.js";

export interface NormalizeResult {
  questions: InputQuestion[];
  /** Number of headers auto-derived (originally missing/blank), reported back to the model. */
  derivedHeaders: number;
}

/** Runs of whitespace and control characters (incl. newlines/tabs) collapse to one space. */
const COLLAPSE_RE = /[\s\u0000-\u001f\u007f]+/g;
/** Clause terminators used when deriving a short tab header from a question. */
const CLAUSE_SPLIT_RE = /[？?：:，,。.；;、!！]/;
/** Guard against pathological suffix loops; with 1-4 questions this is never reached. */
const MAX_SUFFIX = 999;

interface HeaderPlan {
  /** Pre-truncation source text; the dedupe pass re-truncates from here. */
  base: string;
  /** Final header value; only the dedupe pass reassigns it. */
  value: string;
  /** Trimmed header as written by the model (undefined when derived). */
  explicitRaw: string | undefined;
  /** True when the model omitted the header and we derived it. */
  derived: boolean;
}

/**
 * truncateToWidth wraps its ellipsis in ANSI reset sequences; headers are plain
 * data (tab labels and RPC answer keys), so strip the escapes again.
 */
function truncate(text: string, maxWidth: number): string {
  return stripTerminalSequences(truncateToWidth(text, maxWidth));
}

function normalizeText(text: string): string {
  return text.replace(COLLAPSE_RE, " ").trim();
}

function firstClause(question: string): string {
  const match = CLAUSE_SPLIT_RE.exec(question);
  return (match === null ? question : question.slice(0, match.index)).trim();
}

function planDerivedHeader(question: string, index: number): HeaderPlan {
  let base = firstClause(question);
  if (base === "") base = question;
  if (base === "") base = `Q${index + 1}`;
  return { base, value: truncate(base, HEADER_MAX_CHARS), explicitRaw: undefined, derived: true };
}

function withSuffix(plan: HeaderPlan, suffix: string): string {
  return truncate(plan.base, HEADER_MAX_CHARS - suffix.length) + suffix;
}

/**
 * Normalize presentation-layer concerns that should never fail a call:
 * - question text: collapse whitespace/control-character runs to single spaces (always);
 * - explicit headers (ALWAYS, single- and multi-question alike): trim, cap to
 *   HEADER_MAX_CHARS display columns, and drop a blank one entirely — `header: ""`
 *   is not nullish, so it would otherwise key the RPC answer on the empty string
 *   (channel-handler.ts `header ?? question`) and silently lose the answer;
 * - derivation + de-duplication (multi-question calls ONLY): a missing header is
 *   derived from the question's first clause, and values WE produced (derived or
 *   reshaped by truncation) take a numeric suffix until unique. Single-question
 *   calls never get a header invented for them, so their RPC answer key stays the
 *   question text. Two headers the model wrote identically stay identical — that
 *   is a genuine mistake validateInput must keep rejecting.
 *
 * Pure function: no I/O, no mutation of the input array or its objects.
 */
export function normalizeQuestions(questions: InputQuestion[]): NormalizeResult {
  const normalized = questions.map((question) => ({
    ...question,
    question: normalizeText(question.question),
  }));

  if (normalized.length <= 1) {
    // Single-question calls never derive a header (that would move the RPC
    // answer key off the question text), but an explicitly supplied one still
    // gets the same hygiene as in multi-question mode: trim + width-cap, and a
    // blank header is dropped entirely — `header: ""` is not nullish, so it
    // would otherwise reach `toProtoQuestions` and key the RPC answer on the
    // empty string (channel-handler.ts `header ?? question`), silently losing
    // the answer.
    return {
      questions: normalized.map(({ header, ...rest }) => {
        const trimmed = header?.trim();
        return trimmed === undefined || trimmed === ""
          ? rest
          : { ...rest, header: truncate(trimmed, HEADER_MAX_CHARS) };
      }),
      derivedHeaders: 0,
    };
  }

  const plans = normalized.map((question, index): HeaderPlan => {
    const raw = question.header === undefined ? undefined : question.header.trim();
    if (raw === undefined || raw === "") return planDerivedHeader(question.question, index);
    return { base: raw, value: truncate(raw, HEADER_MAX_CHARS), explicitRaw: raw, derived: false };
  });

  const committed: HeaderPlan[] = [];
  const isUnique = (value: string): boolean => committed.every((plan) => plan.value !== value);

  function makeUnique(plan: HeaderPlan): void {
    // Restarting the counter at 2 still converges: `plan` is either not yet in
    // `committed` or sits there under its OLD value, so a candidate it already
    // owns can never be reported unique back to it — each pass moves to the
    // next free slot instead of oscillating.
    for (let suffixNumber = 2; suffixNumber <= MAX_SUFFIX; suffixNumber += 1) {
      const candidate = withSuffix(plan, String(suffixNumber));
      if (isUnique(candidate) || suffixNumber === MAX_SUFFIX) {
        plan.value = candidate;
        return;
      }
    }
  }

  for (const plan of plans) {
    const conflicts = committed.filter((other) => other.value === plan.value);

    // The model wrote colliding headers with the same text on both sides: keep
    // them as-is so validateInput reports the duplicate.
    const modelWrittenDuplicate =
      plan.explicitRaw !== undefined && conflicts.every((other) => other.explicitRaw === plan.explicitRaw);

    if (conflicts.length === 0 || modelWrittenDuplicate) {
      committed.push(plan);
      continue;
    }

    if (plan.explicitRaw === undefined || plan.value !== plan.explicitRaw) {
      // Derived by us, or reshaped by truncation: this side takes the suffix.
      makeUnique(plan);
      committed.push(plan);
      continue;
    }

    // Pristine explicit header colliding with a header we produced: keep the
    // model's value and retro-bump ours instead.
    for (const other of conflicts) {
      if (other.explicitRaw === undefined || other.value !== other.explicitRaw) makeUnique(other);
    }
    committed.push(plan);
  }

  const derivedHeaders = plans.filter((plan) => plan.derived).length;
  return {
    questions: normalized.map((question, index) => ({ ...question, header: plans[index]!.value })),
    derivedHeaders,
  };
}
