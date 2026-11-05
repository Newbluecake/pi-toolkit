// `JevWritePort` implementation (jev-plan §4 J5; the port shape itself is
// frozen in contracts.ts). Consumed by `tool-v2.ts` — the only bridge between
// the v2 `memory` tool and jev:
//
//  - `checkInline`        pre-write synchronous validation: inline authority
//                         comments that this write would NEWLY break reject
//                         the write (pre-existing errors stay doctor-only,
//                         decision 8 — same rule as frontmatter errors).
//  - `touchedUserEntries` user-order guard pairing (arch §6.2.5, v4.1 §3.2).
//  - `afterWrite`         post-commit tagging (arch §6.2.1): called OUTSIDE
//                         the directory lock after the write landed; diffs
//                         entry hashes before/after, tags every changed entry
//                         in parallel under a 3000ms total budget, merges the
//                         verdicts into the sidecar, and returns the §6.2.4
//                         echo lines plus the C-J12 usage. Never rejects; a
//                         tagging failure never undoes the write.
//
// Pi-free root; no direct node:fs (fs-guard); no module-scope state (I4) —
// the EntryIndex and client handles are owned by the caller's closure.
// I5: the deadline timer below is unref'd.

import { frontmatterSource } from "../frontmatter.js";
import { parseMemoryMeta } from "../meta.js";
import { clampSpanMs } from "../../core/deadline.js";
import { splitEntries, type EntryFileInfo, type EntryIndex } from "./entries.js";
import type { MemEntry } from "./contracts.js";
import { formatWriteEcho, type WriteEchoInput } from "./format.js";
import { touchedUserEntries as pairedUserEntries } from "./guard.js";
import { writeIndexPatch } from "./index-store.js";
import { prefilter } from "./match.js";
import { redactForJev } from "./redact.js";
import { tagOne } from "./tagging.js";
import type { ClassifierRegistryLike, EntryHash, EntryTags, JevClient, JevWritePort, Taxonomy } from "./contracts.js";

/** §6.2.1 total cap, raised 3000 → 6000 with the per-tier budget (2026-11-04
 *  all-failed fix — see tagging.ts). One unref'd abort timer caps the whole
 *  afterWrite tagging pass; each `tagOne` still gets its own 6000ms sync
 *  budget and the client clamps to whichever fires first. */
export const WRITE_TAG_TOTAL_BUDGET_MS = 6_000;
/** Backstop-only slack on the outer abort timer: the client's own per-tier
 *  deadlines (2 × ~3000ms) expire at ~6000ms, and without slack the outer
 *  abort would win that race by scheduling jitter — turning the last tier's
 *  timeout into `aborted` and hiding the real failure detail. The outer
 *  timer is a zombie reaper, not the budget itself. */
const WRITE_TAG_OUTER_SLACK_MS = 500;

/** Compare-question pool: lexically closest 12 corpus entries plus the same
 *  file's entries, §6.2.2 ("比较对象取词面最相似的前 12 条，加上同一文件里的条目"). */
const COMPARE_TOP_N = 12;
const COMPARE_MAX = 20;

/** Echo detail cap (code points) — short enough for a tool echo, long enough
 *  to carry both tiers' one-line errors. */
const ECHO_DETAIL_MAX_CP = 200;

/** Flatten the detail to one line before truncation: `redactForJev` keeps
 *  `\n`/`\t`, and a tool echo is a single line — collapse every run of
 *  control chars (C0 + DEL) to a single space. */
function flattenDetail(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

function truncateDetail(text: string): string {
  const chars = Array.from(text);
  return chars.length <= ECHO_DETAIL_MAX_CP ? text : `${chars.slice(0, ECHO_DETAIL_MAX_CP).join("")}…`;
}

export interface JevWritePortDeps {
  readonly client: JevClient;
  readonly entryIndex: EntryIndex;
  /** Canonical memory slug dir for a cwd; `undefined` ⇒ no memory here. */
  readonly dirFor: (cwd: string) => string | undefined;
  readonly taxonomyFor: (dir: string) => Taxonomy;
  readonly now: () => number;
}

interface CompareCandidate {
  readonly cand: { readonly id: string; readonly file: string; readonly excerpt: string };
  readonly entry: MemEntry;
}

function fileInfoOf(raw: string, name: string): EntryFileInfo {
  const { meta } = parseMemoryMeta(raw, name.replace(/\.md$/, ""));
  return {
    status: meta.status === "stale" ? "stale" : "active",
    handWritten: frontmatterSource(raw) !== "agent",
  };
}

/** Index-parity entry view of a raw file (entries.ts `EntryIndex.splitFile`
 *  semantics, verifier minor #4): an `archived` file yields NO entries —
 *  archived content is never tagged nor written to the sidecar. */
function entriesOfRaw(file: string, raw: string | undefined): readonly MemEntry[] {
  if (raw === undefined) return [];
  const { meta } = parseMemoryMeta(raw, file.replace(/\.md$/, ""));
  if (meta.status === "archived") return [];
  return splitEntries(file, raw, fileInfoOf(raw, file));
}

function errorCounts(entries: readonly MemEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of entries) {
    for (const err of entry.inlineErrors) out.set(err, (out.get(err) ?? 0) + 1);
  }
  return out;
}

/** §6.2.2 compare pool: top-12 lexical (user orders first on ties) + same-file
 *  entries, deduped by hash, capped at 20 (`c1`..`c20`). Private/secret
 *  entries are never candidates (§7.2). */
function pickCompareCandidates(entry: MemEntry, corpus: readonly MemEntry[]): readonly CompareCandidate[] {
  const others = corpus.filter((e) => e.hash !== entry.hash);
  const top = prefilter(
    others,
    (e) => e.body,
    entry.body,
    COMPARE_TOP_N,
    (a, b) => (a.authority === b.authority ? 0 : a.authority === "user" ? -1 : 1),
  );
  const picked: MemEntry[] = [...top];
  for (const e of others) {
    if (e.file !== entry.file) continue;
    if (picked.some((p) => p.hash === e.hash)) continue;
    picked.push(e);
  }
  return picked.slice(0, COMPARE_MAX).map((e, i) => ({
    cand: { id: `c${i + 1}`, file: e.file, excerpt: redactForJev(e.body, "entry") },
    entry: e,
  }));
}

/** Narrow a raw answer record to JevAnswer's choice variant (type guard —
 *  answers ride through `JevOutcome` as plain records). */
function asChoiceAnswer(
  value: unknown,
): { choice: string; probabilities: Record<string, number>; confidence: number } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const a = value as Record<string, unknown>;
  if (a["type"] !== "choice" || typeof a["choice"] !== "string") return undefined;
  const probabilities =
    typeof a["probabilities"] === "object" && a["probabilities"] !== null
      ? (a["probabilities"] as Record<string, number>)
      : {};
  return {
    choice: a["choice"],
    probabilities,
    confidence: typeof a["confidence"] === "number" ? a["confidence"] : 0,
  };
}

/** arch §6.2.4 (verifier major #2): `similar:` and `conflict:` are
 *  INDEPENDENT picks over the `c*` answers — `similar` is the strongest
 *  non-`unrelated` relation of the whole pool, `conflict` the strongest of
 *  {duplicate, conflict, supersedes} (formatWriteEcho applies its p ≥ 0.75
 *  gate). A high complementary must not mask a conflict, nor vice versa. */
function relationPicks(
  answers: Record<string, unknown> | undefined,
  compare: readonly CompareCandidate[],
): {
  similar: { relation: string; p: number; entry: MemEntry } | undefined;
  conflict: { relation: string; p: number; entry: MemEntry } | undefined;
} {
  let similar: { relation: string; p: number; entry: MemEntry } | undefined;
  let conflict: { relation: string; p: number; entry: MemEntry } | undefined;
  if (answers === undefined) return { similar, conflict };
  for (const c of compare) {
    const answer = asChoiceAnswer(answers[c.cand.id]);
    if (answer === undefined || answer.choice === "unrelated") continue;
    const p = answer.probabilities[answer.choice] ?? answer.confidence;
    if (similar === undefined || p > similar.p) similar = { relation: answer.choice, p, entry: c.entry };
    const conflictKind =
      answer.choice === "duplicate" || answer.choice === "conflict" || answer.choice === "supersedes";
    if (conflictKind && (conflict === undefined || p > conflict.p)) {
      conflict = { relation: answer.choice, p, entry: c.entry };
    }
  }
  return { similar, conflict };
}

export function createJevWritePort(deps: JevWritePortDeps): JevWritePort {
  const EMPTY: { echo: readonly string[] } = { echo: [] };

  const runAfterWrite = async (input: {
    cwd: string;
    file: string;
    before: string | undefined;
    after: string;
    signal?: AbortSignal;
    registry: ClassifierRegistryLike | undefined;
  }): Promise<{ echo: readonly string[]; usage?: { costUsd: number; calls: number } }> => {
    const dir = deps.dirFor(input.cwd);
    if (dir === undefined) return EMPTY;

    const afterEntries = entriesOfRaw(input.file, input.after);
    const beforeHashes = new Set(entriesOfRaw(input.file, input.before).map((e) => e.hash));
    // Private/secret entries are never sent (§7.2) — they stay silent here
    // (no tagging, no "not tagged" noise).
    const changed = afterEntries.filter((e) => !beforeHashes.has(e.hash) && e.inline.isPrivate !== true && !e.secret);
    if (changed.length === 0) return EMPTY;

    if (input.registry === undefined) {
      return { echo: [formatWriteEcho({ kind: "not-tagged", reason: "off: pi-api", long: false })] };
    }
    const status = deps.client.status();
    if (status.kind === "off") {
      return { echo: [formatWriteEcho({ kind: "not-tagged", reason: `off: ${status.reason}`, long: false })] };
    }
    if (status.kind === "partial") {
      // §6.2.1: the write already landed; the entry stays pending (no sidecar
      // record) and the fast path will not see it until tagged.
      return { echo: [formatWriteEcho({ kind: "not-tagged", reason: `partial: ${status.reason}`, long: true })] };
    }

    // NOTE (verifier nit #9): the compare pool below reads the corpus through
    // `deps.entryIndex` — its fingerprint cache means pool correctness depends
    // on the CALLER having let the write land (or invalidated the index)
    // before afterWrite runs. tool-v2 calls afterWrite only after the write
    // committed and onAfterWrite ran.
    const taxonomy = deps.taxonomyFor(dir);
    const corpus = deps.entryIndex.get(dir).filter((e) => e.inline.isPrivate !== true && !e.secret);
    const compares = changed.map((entry) => pickCompareCandidates(entry, corpus));

    // I1: every computed deadline goes through clampSpanMs.
    const budgetMs = clampSpanMs(WRITE_TAG_TOTAL_BUDGET_MS) ?? WRITE_TAG_TOTAL_BUDGET_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), budgetMs + WRITE_TAG_OUTER_SLACK_MS);
    timer.unref?.();
    const signal = input.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, input.signal]);
    try {
      const results = await Promise.all(
        changed.map(async (entry, i) => {
          const compare = compares[i]!;
          const result = await tagOne({
            client: deps.client,
            registry: input.registry!,
            entry,
            taxonomy,
            compare: compare.map((c) => c.cand),
            mode: "sync",
            signal,
          });
          return { entry, compare, result };
        }),
      );

      const echo: string[] = [];
      const upserts: Record<EntryHash, EntryTags> = {};
      let costUsd = 0;
      const failures: string[] = [];
      let firstFailureDetail: string | undefined;
      for (const r of results) {
        const outcome = r.result.outcome;
        if (r.result.tags !== undefined && outcome.ok) {
          upserts[r.entry.hash] = r.result.tags;
          costUsd += outcome.costUsd;
          const tags = r.result.tags;
          const picks = relationPicks(outcome.answers, r.compare);
          const anchorOf = (e: MemEntry): string => `${e.file} L${e.lineStart}`;
          const input2: WriteEchoInput = {
            kind: "tagged",
            anchor: {
              file: r.entry.file,
              ordinal: r.entry.ordinal,
              lineStart: r.entry.lineStart,
              lineEnd: r.entry.lineEnd,
            },
            type: tags.type,
            typeP: tags.typeP,
            importance: tags.importance,
            tags: Object.entries(tags.tags)
              .map(([id, v]) => ({ id, p: v.p }))
              .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
            guard: tags.guard,
            temporal: tags.temporal,
            ...(picks.similar === undefined
              ? {}
              : {
                  similar: {
                    anchor: anchorOf(picks.similar.entry),
                    relation: picks.similar.relation,
                    p: picks.similar.p,
                  },
                }),
            userLike: tags.userLike,
            authority: r.entry.authority,
            ...(r.entry.inline.expires !== undefined || r.entry.inline.until !== undefined ? { hasExpiry: true } : {}),
            ...(picks.conflict === undefined
              ? {}
              : {
                  conflict: {
                    anchor: anchorOf(picks.conflict.entry),
                    userRule: picks.conflict.entry.authority === "user",
                    relation: picks.conflict.relation,
                    p: picks.conflict.p,
                  },
                }),
          };
          echo.push(formatWriteEcho(input2));
        } else if (!outcome.ok) {
          failures.push(outcome.reason);
          // 2026-11-04 fix: `all-failed` carries per-tier failure notes in
          // its detail — surface a redacted, flattened, truncated copy in
          // the echo. Verifier condition: only the FIRST failure decides —
          // when `failures[0]` is e.g. `aborted`, the echo keeps its exact
          // detail-less bytes even if a LATER entry failed all-failed.
          if (failures.length === 1 && outcome.reason === "all-failed" && outcome.detail !== "") {
            firstFailureDetail = outcome.detail;
          }
        }
      }
      if (failures.length > 0) {
        const now2 = deps.client.status();
        echo.push(
          formatWriteEcho({
            kind: "not-tagged",
            ...(now2.kind === "partial"
              ? { reason: `partial: ${now2.reason}`, long: true }
              : {
                  reason: failures[0]!,
                  long: false,
                  ...(firstFailureDetail === undefined
                    ? {}
                    : { detail: truncateDetail(flattenDetail(redactForJev(firstFailureDetail, "error"))) }),
                }),
          }),
        );
      }
      if (Object.keys(upserts).length > 0) {
        // Sidecar merge runs in its own directory-lock turn (writeIndexPatch)
        // — we are outside the tool's lock here, so "busy" only drops the
        // patch (never throws; the next tagging rewrites the same data).
        await writeIndexPatch(dir, {
          upsert: upserts,
          lastTaggedAt: new Date(deps.now()).toISOString(),
        }).catch(() => "busy" as const);
      }
      return { echo, usage: { costUsd, calls: changed.length } };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async afterWrite(input) {
      try {
        return await runAfterWrite(input);
      } catch {
        // Never rejects (frozen contract): a tagging crash must not turn a
        // committed write into a tool error.
        return { echo: [] };
      }
    },
    checkInline(file, before, after) {
      const beforeErrors = before === undefined ? new Map<string, number>() : errorCounts(entriesOfRaw(file, before));
      const fresh: string[] = [];
      for (const [text, n] of errorCounts(entriesOfRaw(file, after))) {
        if ((beforeErrors.get(text) ?? 0) < n) fresh.push(text);
      }
      if (fresh.length === 0) return undefined;
      return `refused: ${file} would introduce inline-comment errors — ${fresh.join("; ")}`;
    },
    touchedUserEntries(file, before, after, handWritten) {
      // guard.ts pairs by guardHash with a placeholder file name; re-stamp
      // the real file so confirm-dialog anchors are correct.
      return pairedUserEntries(before, after, handWritten).map((e) => ({ ...e, file }));
    },
  };
}
