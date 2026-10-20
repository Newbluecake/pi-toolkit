/**
 * P1 (ask-user-async plan §4, §6.3): the parked-question registry — pi-free state and
 * (de)serialization. index.ts owns the wiring (appendEntry persistence, getBranch restore,
 * status bar, settle notify, compact reminder).
 *
 * A question is "parked" when its ask_user dialog ended unanswered because of the background
 * interrupt (or the pre-open deferred check). Re-asking is the MODEL's job (§4: best-effort,
 * not guaranteed); the registry makes sure counts, drafts and reminders survive.
 */
import { createHash } from "node:crypto";

import type { DraftQuestionState, DraftSnapshot, Question } from "./types.js";

export const PARKED_CUSTOM_TYPE = "ask-user:parked";
export const PARKED_REMINDER_CUSTOM_TYPE = "ask-user:parked-reminder";
export const PARKED_LIMIT = 16;
export const PARKED_TTL_MS = 24 * 60 * 60 * 1000;
/** r3 (2026-10-20): the post-compact reminder only lists (and only retains) entries parked
 *  within this window — anything older is pruned at compact time so the status-bar count
 *  matches what is retained. Independent of the 24h hard TTL above. */
export const PARKED_REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000;
/** r1 (2026-10-20): answer-sweep threshold — a parked entry is resolved by a LATER answered
 *  ask_user call when the normalized char-bigram Dice similarity between its question text
 *  and an answered question's text is >= this value (or their normalized headers are equal).
 *  Chosen so reworded re-asks (same decision, different wording) match while unrelated
 *  questions stay parked. */
export const SWEEP_SIMILARITY_THRESHOLD = 0.6;

const SWEEP_WS_RE = /[\s\u0000-\u001f\u007f]+/g;

/** Lowercase + whitespace-collapse for similarity/header comparison. */
function normalizeForSweep(text: string): string {
  return text.toLowerCase().replace(SWEEP_WS_RE, " ").trim();
}

/** r1: multiset char-bigram Dice coefficient over normalized text. Deterministic, symmetric,
 *  in [0, 1]; identical normalized text is exactly 1, bigram-less short strings only match
 *  when identical. */
export function questionSimilarity(a: string, b: string): number {
  const na = normalizeForSweep(a);
  const nb = normalizeForSweep(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < na.length; i++) {
    const bigram = na.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i + 1 < nb.length; i++) {
    const bigram = nb.slice(i, i + 2);
    const count = counts.get(bigram) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(bigram, count - 1);
    }
  }
  return (2 * intersection) / (na.length - 1 + (nb.length - 1));
}

/** §6.3 single-question fingerprint, computed AFTER normalizeQuestions. */
export function questionFingerprint(question: Question): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        question.question,
        question.options.map((option) => option.label),
        question.multiSelect === true,
      ]),
    )
    .digest("hex");
}

/** Per-question draft plus the tab the user was on (same value duplicated on every entry
 *  drafted from the same dialog; the restore side reads the first one it finds). */
export interface ParkedDraft extends DraftQuestionState {
  activeTab: number;
}

export interface ParkedEntry {
  fp: string;
  question: string;
  header?: string | undefined;
  interrupts: number;
  deferrals: number;
  draft?: ParkedDraft | undefined;
  parkedAt: number;
  lastReaskAt?: number | undefined;
  /** Agent run that produced this entry and has not re-asked it since (§4.4 settle notify).
   *  0 = nothing pending (re-asked, or restored from disk — the producing run is gone). */
  runSeq: number;
  /** r2 (2026-10-20) move-on retire: the runSeq whose agent_settled fired the settle notify
   *  (markNotified). Once a LATER full agent run (runSeq > notifiedRunSeq) settles without
   *  re-asking it, the entry is retired — the model saw the notify and decided. undefined =
   *  never notified in this process. Restored entries carry 0 (documented: they retire after
   *  the first full run following the restore unless re-asked). */
  notifiedRunSeq?: number | undefined;
}

export interface ParkedRegistry {
  find(fp: string): ParkedEntry | undefined;
  /** Successful background interrupt: bump per-question counts, store drafts, mark runSeq. */
  recordInterrupt(args: {
    fps: string[];
    questions: Question[];
    draft?: DraftSnapshot | undefined;
    runSeq: number;
    now: number;
  }): void;
  /** Pre-open deferral (§5.4): bump deferral counts. Deferred questions take part in the
   *  settle notify exactly like interrupted ones (they are equally not-yet-re-asked). */
  recordDeferral(args: { fps: string[]; questions: Question[]; runSeq: number; now: number }): void;
  /** The re-asked dialog actually appeared (factory returned): stamp lastReaskAt, clear the
   *  pending notify flag. Not a persisted change on its own (§6.3). */
  noteReask(fps: string[], now: number): void;
  /** Clear the pending notify flag after the §4.4 settle notify fired (exactly-once);
   *  stamps notifiedRunSeq with the notifying run so a later run can retire it (r2). */
  markNotified(fps: string[], atRunSeq: number): void;
  /** Answered or user-cancelled: drop the entries (budget resets, §5.2.1 重置条件).
   *  Returns whether anything was removed. */
  resolve(fps: string[]): boolean;
  /** r1 answer-sweep: a LATER call was answered (skipped answers count as answered) — drop
   *  every parked entry matching one of the answered questions by equal normalized header
   *  OR question-text similarity >= SWEEP_SIMILARITY_THRESHOLD. Returns whether anything
   *  was removed. */
  sweepAnswered(questions: Question[]): boolean;
  /** r2 move-on retire: drop entries whose settle notify fired in an EARLIER run
   *  (notifiedRunSeq !== undefined && notifiedRunSeq < runSeq). Returns whether anything
   *  was removed. */
  retireMoveOn(runSeq: number): boolean;
  /** r4 dismissParked: drop every entry; returns how many were removed. */
  clear(): number;
  items(): ParkedEntry[];
  /** Drop entries older than maxAgeMs (default the 24h TTL); returns whether anything changed. */
  prune(now: number, maxAgeMs?: number): boolean;
  /** Replace all entries (restore path). */
  load(entries: ParkedEntry[]): void;
  snapshot(): { v: 1; items: ParkedEntry[] };
}

function clampToLimit(entries: ParkedEntry[]): ParkedEntry[] {
  // FIFO: the oldest entries (lowest parkedAt, stable insertion order) go first.
  return entries.slice(Math.max(0, entries.length - PARKED_LIMIT));
}

export function createParkedRegistry(): ParkedRegistry {
  let entries: ParkedEntry[] = [];

  const upsert = (fp: string, update: (existing: ParkedEntry | undefined) => ParkedEntry): void => {
    const index = entries.findIndex((entry) => entry.fp === fp);
    const existing = index >= 0 ? entries[index] : undefined;
    const next = update(existing);
    if (index >= 0) entries.splice(index, 1);
    entries.push(next); // refresh recency
    entries = clampToLimit(entries);
  };

  return {
    find(fp) {
      return entries.find((entry) => entry.fp === fp);
    },
    recordInterrupt({ fps, questions, draft, runSeq, now }) {
      fps.forEach((fp, index) => {
        const question = questions[index]!;
        const draftState = draft?.states[index];
        upsert(fp, (existing) => ({
          fp,
          question: question.question,
          header: question.header,
          interrupts: (existing?.interrupts ?? 0) + 1,
          deferrals: existing?.deferrals ?? 0,
          // A queued ask interrupted before it was ever shown has no new draft — keep the
          // previous one (it is still the user's partial input).
          draft: draftState !== undefined ? { ...draftState, activeTab: draft?.activeTab ?? 0 } : existing?.draft,
          parkedAt: now,
          lastReaskAt: existing?.lastReaskAt,
          runSeq,
          // A new parking cycle: any earlier move-on tracking no longer applies (r2).
          notifiedRunSeq: undefined,
        }));
      });
    },
    recordDeferral({ fps, questions, runSeq, now }) {
      fps.forEach((fp, index) => {
        const question = questions[index]!;
        upsert(fp, (existing) => ({
          fp,
          question: question.question,
          header: question.header,
          interrupts: existing?.interrupts ?? 0,
          deferrals: (existing?.deferrals ?? 0) + 1,
          draft: existing?.draft,
          parkedAt: now,
          lastReaskAt: existing?.lastReaskAt,
          runSeq,
          notifiedRunSeq: undefined,
        }));
      });
    },
    noteReask(fps, now) {
      for (const fp of fps) {
        const entry = entries.find((candidate) => candidate.fp === fp);
        if (entry === undefined) continue;
        entry.lastReaskAt = now;
        entry.runSeq = 0;
        // Re-asked: the move-on clock restarts — it needs a fresh notify before retiring (r2).
        entry.notifiedRunSeq = undefined;
      }
    },
    markNotified(fps, atRunSeq) {
      for (const fp of fps) {
        const entry = entries.find((candidate) => candidate.fp === fp);
        if (entry !== undefined) {
          entry.runSeq = 0;
          entry.notifiedRunSeq = atRunSeq;
        }
      }
    },
    resolve(fps) {
      const drop = new Set(fps);
      const kept = entries.filter((entry) => !drop.has(entry.fp));
      if (kept.length === entries.length) return false;
      entries = kept;
      return true;
    },
    sweepAnswered(questions) {
      const answered = questions.map((question) => ({
        header: question.header === undefined ? undefined : normalizeForSweep(question.header),
        text: question.question,
      }));
      const kept = entries.filter(
        (entry) =>
          !answered.some((answeredQuestion) => {
            const entryHeader = entry.header === undefined ? undefined : normalizeForSweep(entry.header);
            if (
              entryHeader !== undefined &&
              entryHeader !== "" &&
              answeredQuestion.header !== undefined &&
              entryHeader === answeredQuestion.header
            )
              return true;
            return questionSimilarity(entry.question, answeredQuestion.text) >= SWEEP_SIMILARITY_THRESHOLD;
          }),
      );
      if (kept.length === entries.length) return false;
      entries = kept;
      return true;
    },
    retireMoveOn(runSeq) {
      const kept = entries.filter((entry) => entry.notifiedRunSeq === undefined || entry.notifiedRunSeq >= runSeq);
      if (kept.length === entries.length) return false;
      entries = kept;
      return true;
    },
    clear() {
      const count = entries.length;
      entries = [];
      return count;
    },
    items() {
      return [...entries];
    },
    prune(now, maxAgeMs = PARKED_TTL_MS) {
      const kept = entries.filter((entry) => now - entry.parkedAt < maxAgeMs);
      if (kept.length === entries.length) return false;
      entries = kept;
      return true;
    },
    load(next) {
      entries = clampToLimit([...next]);
    },
    snapshot() {
      return { v: 1, items: [...entries] };
    },
  };
}

function sanitizeDraft(raw: unknown): ParkedDraft | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.optionCount !== "number" || !Number.isInteger(record.optionCount) || record.optionCount < 0)
    return undefined;
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    optionCount: record.optionCount,
    cursorIndex: typeof record.cursorIndex === "number" ? record.cursorIndex : 0,
    selectedIndex: typeof record.selectedIndex === "number" ? record.selectedIndex : null,
    selectedIndices: Array.isArray(record.selectedIndices)
      ? record.selectedIndices.filter((value): value is number => typeof value === "number")
      : [],
    confirmed: record.confirmed === true,
    freeTextValue: str(record.freeTextValue),
    freeDraft: str(record.freeDraft),
    mode: record.mode === "freeform" ? "freeform" : "options",
    draftText: typeof record.draftText === "string" ? record.draftText : "",
    savedOptionsCursorIndex: typeof record.savedOptionsCursorIndex === "number" ? record.savedOptionsCursorIndex : 0,
    skipped: record.skipped === true,
    activeTab: typeof record.activeTab === "number" ? record.activeTab : 0,
  };
}

/**
 * Validate a persisted `ask-user:parked` snapshot's `items`, dropping malformed entries and
 * TTL-expired ones (§6.3). runSeq is reset to 0: the producing agent run does not survive the
 * process/session boundary the snapshot was loaded across. notifiedRunSeq is set to 0 (r2,
 * documented): a restored entry counts as already-notified, so it retires after the FIRST
 * full agent run following the restore unless the model re-asks it.
 */
export function sanitizeParkedEntries(raw: unknown, now: number): ParkedEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ParkedEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.fp !== "string" || typeof record.question !== "string") continue;
    if (typeof record.parkedAt !== "number" || now - record.parkedAt >= PARKED_TTL_MS) continue;
    out.push({
      fp: record.fp,
      question: record.question,
      header: typeof record.header === "string" ? record.header : undefined,
      interrupts:
        typeof record.interrupts === "number" && Number.isInteger(record.interrupts) && record.interrupts >= 0
          ? record.interrupts
          : 0,
      deferrals:
        typeof record.deferrals === "number" && Number.isInteger(record.deferrals) && record.deferrals >= 0
          ? record.deferrals
          : 0,
      draft: sanitizeDraft(record.draft),
      parkedAt: record.parkedAt,
      lastReaskAt: typeof record.lastReaskAt === "number" ? record.lastReaskAt : undefined,
      runSeq: 0,
      notifiedRunSeq: 0,
    });
  }
  return clampToLimit(out);
}
