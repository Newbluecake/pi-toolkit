/** Read-only command projections: never run sweep or mutate the suggestion index. */
import { join } from "node:path";
import { readCorpus } from "../blocks/store.js";
import { isExpired } from "../blocks/format.js";
import { mergeReview, readIndex } from "../jev/index-store.js";
import { entryHash, expiredEntries } from "../jev/entries.js";
import type { MemEntry } from "../jev/contracts.js";
import { blockAnchor, governanceToday } from "./supersede.js";
import { planSweep } from "./sweep-plan.js";

export function blockReviewDisplay(dir: string, today = governanceToday()): string {
  const corpus = readCorpus(join(dir, "blocks"));
  const index = readIndex(dir).index;
  const all = [
    ...(index.review?.suggestions ?? []),
    ...planSweep(corpus, index, corpus.legacy, today, "startup").suggestions,
  ];
  const matches = (ref: { hash: string; anchor: string }) =>
    corpus.blocks.some((b) => entryHash(b.body) === ref.hash && (blockAnchor(b) === ref.anchor || b.id === ref.anchor));
  // Reuse the index's semantic identity and dismissal semantics rather than
  // historical classifier IDs, which can collide across distinct questions.
  const suggestions = mergeReview(undefined, {
    lastRunAt: "",
    corpusFp: "",
    suggestions: all.filter((s) => s.revision || (matches(s.a) && (!s.b || matches(s.b)))),
    dismissed: index.review?.dismissed ?? [],
    ...(index.review?.resolved === undefined ? {} : { resolved: index.review.resolved }),
  }).suggestions;
  if (!suggestions.length) return "review: no suggestions";
  return [
    `review: ${suggestions.length} suggestions`,
    ...suggestions.map((s) => {
      const p = s.revision;
      if (!p) return `[${s.kind}] ${s.a.anchor.split("|")[0]}${s.b ? ` vs ${s.b.anchor.split("|")[0]}` : ""}`;
      const live = corpus.blocks.find((b) => b.id === p.targetId);
      const context = p.contextId ? corpus.blocks.find((b) => b.id === p.contextId) : undefined;
      const stale =
        !live ||
        live.rev !== p.expectedRev ||
        live.meta.status !== "active" ||
        (p.contextId !== undefined &&
          (!context || context.rev !== p.contextExpectedRev || context.meta.status !== "active"));
      const expires =
        p.action === "expires"
          ? ` expires=${p.expiry.op === "set" ? p.expiry.nextExpires : "clear"} dateRuleVersion=${p.expiry.dateRuleVersion}`
          : "";
      return `[revision ${p.action}] ${p.targetId}@${p.expectedRev}${p.contextId ? ` vs ${p.contextId}@${p.contextExpectedRev}` : ""}${p.autoEligible ? " ·auto-eligible (hint only)" : " ·suggestion"}${stale ? " ·stale" : ""}${expires}`;
    }),
  ].join("\n");
}

export function blockExpiredDisplay(dir: string, today = governanceToday()): string {
  const corpus = readCorpus(join(dir, "blocks"));
  const rows: string[] = [];
  for (const b of corpus.blocks) {
    if (b.meta.status !== "active" || b.meta.supersededBy) continue;
    if (isExpired(b.meta, today)) rows.push(`[${b.meta.authority} expires] ${b.id} expires=${b.meta.expires}`);
    if (b.meta.until) rows.push(`[${b.meta.authority} until] ${b.id} until=${b.meta.until}`);
  }
  return rows.length
    ? [`expired: ${rows.length} entries`, ...rows, "期限条件仅供核对，不会自动修改记忆。"].join("\n")
    : "expired: no entries";
}

export function fileExpiredDisplay(entries: readonly MemEntry[], today = governanceToday()): string {
  const active = entries.filter((e) => e.block === undefined || (e.block.status === "active" && !e.block.supersededBy));
  const expired = new Set(expiredEntries(active, today));
  const rows: string[] = [];
  for (const e of active) {
    const where = `${e.file}:${e.lineStart}`;
    if (expired.has(e)) rows.push(`[${e.authority} expires] ${where} expires=${e.inline.expires}`);
    if (e.inline.until) rows.push(`[${e.authority} until] ${where} until=${e.inline.until}`);
  }
  return rows.length
    ? [`expired: ${rows.length} entries`, ...rows, "期限条件仅供核对，不会自动修改记忆。"].join("\n")
    : "expired: no entries";
}
