/** Governance-only review, including Jev-off. Block edits never use legacy
 * line editing: every action rechecks the live revision inside the lock. */
import { join } from "node:path";
import { looksSecret } from "../secret-patterns.js";
import type { MemoryWriteGate } from "../contracts.js";
import type { MemCommandUiLike, ReviewSuggestion, ReviewSuggestionKind } from "../jev/contracts.js";
import { readIndex } from "../jev/index-store.js";
import { entryHash } from "../jev/entries.js";
import { readCorpus, trashBlockLocked } from "../blocks/store.js";
import { residentBlocksOf, residentMeteredBytes } from "../blocks/render.js";
import { withMemoryDirLock } from "../lock.js";
import {
  blockAnchor,
  governanceGate,
  governanceToday,
  readGovernBlock,
  replaceGovernBlockLocked,
  writeGovernIndexLocked,
} from "./supersede.js";
import { planSweep } from "./sweep-plan.js";
import { archiveBlockLocked, createSweepRunner } from "./sweep.js";
export const GOVERNANCE_KINDS: readonly ReviewSuggestionKind[] = [
  "expired-user",
  "until-check",
  "snapshot",
  "pointer",
  "oversize",
  "resident-budget",
  "scope-check",
  "legacy-drift",
  "conflict",
  "supersedes",
];
export interface ReviewLiteOptions {
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  interactive: boolean;
  enabled: boolean;
  residentBudget: number;
  onAfterWrite?: () => void;
  now?: Date;
}
function days(today: string, n: number): string {
  return new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
}
export async function handleReviewLite(
  memDir: string,
  args: string,
  ui: MemCommandUiLike,
  opts: ReviewLiteOptions,
): Promise<void> {
  const now = opts.now ?? new Date(),
    today = governanceToday(now);
  let corpus = readCorpus(join(memDir, "blocks"));
  if (args.trim() === "--run" && opts.enabled && opts.interactive) {
    const runner = createSweepRunner({
      enabled: true,
      ...(opts.gate ? { gate: opts.gate } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: () => now.getTime(),
      render: {
        residentBytes: residentMeteredBytes(residentBlocksOf(corpus.blocks, { isChild: false, today }), today),
        residentBudget: opts.residentBudget,
        indexOverflow: false,
      },
    });
    await runner.runSweep(memDir, "budget", opts.signal);
    corpus = readCorpus(join(memDir, "blocks"));
  }
  const index = readIndex(memDir).index;
  const transient = planSweep(corpus, index, corpus.legacy, today, "startup").suggestions;
  const suggestions = [...(index.review?.suggestions ?? []), ...transient].filter(
    (s, i, all) =>
      all.findIndex((x) => x.id === s.id) === i &&
      GOVERNANCE_KINDS.includes(s.kind) &&
      corpus.blocks.some(
        (b) => entryHash(b.body) === s.a.hash && (blockAnchor(b) === s.a.anchor || b.id === s.a.anchor),
      ) &&
      (!s.b ||
        corpus.blocks.some(
          (b) => entryHash(b.body) === s.b!.hash && (blockAnchor(b) === s.b!.anchor || b.id === s.b!.anchor),
        )),
  );
  if (!opts.interactive || args.trim() === "--list") {
    ui.notify(
      suggestions.length
        ? `review: ${suggestions.length} governance suggestions\n${suggestions.map((s) => `[${s.kind}] ${s.a.anchor.split("|")[0]}`).join("\n")}`
        : "review: no suggestions",
    );
    return;
  }
  for (const s of suggestions) {
    const block = corpus.blocks.find(
      (b) => entryHash(b.body) === s.a.hash && (blockAnchor(b) === s.a.anchor || b.id === s.a.anchor),
    );
    if (!block) continue;
    const options = [
      { value: "open", label: "Open / hand to agent" },
      { value: "keep", label: "Keep" },
      { value: "skip", label: "Skip" },
    ];
    if (s.kind === "expired-user")
      options.unshift({ value: "extend", label: "Extend 30 days" }, { value: "delete", label: "Delete" });
    if ((s.kind === "until-check" || s.kind === "snapshot") && block.meta.authority === "agent")
      options.unshift({ value: "archive", label: "Archive" }, { value: "extend", label: "Set expires +30 days" });
    if (s.kind === "resident-budget") options.unshift({ value: "topic", label: "Downgrade to topic" });
    if (s.kind === "scope-check") options.unshift({ value: "global", label: "Set global" });
    const choice = await ui.select(`review · ${s.kind} · ${block.id}`, options);
    if (!choice || choice === "skip" || !options.some((option) => option.value === choice)) continue;
    if (choice === "open") {
      const instruction = `Review memory block ${block.id}${s.b ? ` vs ${s.b.anchor.split("|")[0]}` : ""} (${s.kind}); view before editing/merging.`;
      if (ui.setEditorText) ui.setEditorText(instruction);
      else ui.notify(instruction);
      continue;
    }
    try {
      governanceGate(memDir, opts.gate, opts.signal);
      await withMemoryDirLock(
        memDir,
        () => {
          governanceGate(memDir, opts.gate, opts.signal);
          const live = readGovernBlock(memDir, block.id);
          if (live.rev !== block.rev) throw new Error("entry changed — skipped");
          const latest = readIndex(memDir).index,
            review = latest.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
          if (choice === "archive")
            archiveBlockLocked(memDir, live.id, live.rev, {
              ...(opts.gate ? { gate: opts.gate } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              now,
            });
          else if (choice === "delete")
            trashBlockLocked(join(memDir, "blocks"), `${live.id}.md`, live.rev, opts.gate ? { gate: opts.gate } : {});
          else if (choice !== "keep") {
            const meta = { ...live.meta };
            if (choice === "extend") meta.expires = days(today, 30);
            if (choice === "topic" || choice === "global") meta.scope = choice;
            // A user archive is deliberately not offered as an automatic action.
            replaceGovernBlockLocked(memDir, live, meta, {
              ...(opts.gate ? { gate: opts.gate } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              now,
            });
          }
          const duration = s.kind === "expired-user" ? 30 : s.kind === "resident-budget" ? 7 : 14;
          const dismissed =
            choice === "keep"
              ? [
                  ...review.dismissed,
                  {
                    hashKey: s.b ? [s.a.hash, s.b.hash].sort().join("+") : s.a.hash,
                    anchorKey: s.b ? [s.a.anchor, s.b.anchor].sort().join("+") : s.a.anchor,
                    kind: s.kind,
                    ...(s.kind === "scope-check" || s.kind === "conflict" || s.kind === "supersedes"
                      ? {}
                      : { until: days(today, duration) }),
                  },
                ]
              : review.dismissed;
          writeGovernIndexLocked(
            memDir,
            {
              ...latest,
              review: { ...review, suggestions: review.suggestions.filter((x) => x.id !== s.id), dismissed },
            },
            opts.gate,
            opts.signal,
          );
        },
        { timeoutMs: 500 },
      );
      opts.onAfterWrite?.();
    } catch (e) {
      ui.notify(`review: ${(e as Error).message}`);
    }
  }
}
/** Migration's first semantic pass is suggestions-only and user↔user only.
 * The judge is supplied by the host (P5b); this port never calls a model or
 * auto-executes a relation. Rev mismatches discard late answers. */
export async function firstUserReviewPass(
  memDir: string,
  judge: (pairs: readonly { a: string; b: string }[]) => Promise<readonly { a: string; b: string; p: number }[]>,
  opts: { gate?: MemoryWriteGate; signal?: AbortSignal } = {},
): Promise<number> {
  governanceGate(memDir, opts.gate, opts.signal);
  const users = readCorpus(join(memDir, "blocks")).blocks.filter(
    (b) => b.meta.authority === "user" && b.meta.status === "active" && b.meta.private !== true && !looksSecret(b.body),
  );
  const pairs = users.flatMap((a, i) => users.slice(i + 1).map((b) => ({ a: a.id, b: b.id })));
  if (!pairs.length) return 0;
  const answers = await judge(pairs);
  governanceGate(memDir, opts.gate, opts.signal);
  return withMemoryDirLock(
    memDir,
    () => {
      governanceGate(memDir, opts.gate, opts.signal);
      const index = readIndex(memDir).index,
        review = index.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
      const suggestions: ReviewSuggestion[] = [];
      for (const answer of answers) {
        const a = users.find((b) => b.id === answer.a),
          b = users.find((b) => b.id === answer.b);
        if (!a || !b || a.id === b.id || !Number.isFinite(answer.p) || answer.p < 0 || answer.p > 1) continue;
        try {
          if (readGovernBlock(memDir, a.id).rev !== a.rev || readGovernBlock(memDir, b.id).rev !== b.rev) continue;
        } catch {
          continue;
        }
        const id = `migration-${[a.id, b.id].sort().join("-")}`;
        if (review.suggestions.some((s) => s.id === id) || suggestions.some((s) => s.id === id)) continue;
        const hashKey = [entryHash(a.body), entryHash(b.body)].sort().join("+");
        const anchorKey = [blockAnchor(a), blockAnchor(b)].sort().join("+");
        if (
          review.dismissed.some(
            (d) => (!d.until || d.until >= governanceToday()) && (d.hashKey === hashKey || d.anchorKey === anchorKey),
          )
        )
          continue;
        suggestions.push({
          id,
          kind: "conflict",
          a: { hash: entryHash(a.body), anchor: blockAnchor(a) },
          b: { hash: entryHash(b.body), anchor: blockAnchor(b) },
          p: answer.p,
          at: new Date().toISOString(),
        });
      }
      if (suggestions.length)
        writeGovernIndexLocked(
          memDir,
          { ...index, review: { ...review, suggestions: [...review.suggestions, ...suggestions] } },
          opts.gate,
          opts.signal,
        );
      return suggestions.length;
    },
    { timeoutMs: 500 },
  );
}
