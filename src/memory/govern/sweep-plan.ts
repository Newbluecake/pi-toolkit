import { createHash } from "node:crypto";
import type { BlockCorpus, LegacyFingerprint } from "../blocks/store.js";
import { isExpired } from "../blocks/format.js";
import type { JevIndexV1, ReviewSuggestion, ReviewSuggestionKind } from "../jev/contracts.js";
import { entryHash } from "../jev/entries.js";
import { blockAnchor } from "./supersede.js";
import { looksLikeStateSnapshot } from "./snapshot.js";
export type SweepReason = "startup" | "reload" | "write" | "task-done" | "push" | "release" | "budget";
export interface SweepPlan {
  archive: readonly { id: string; rev: string }[];
  suggestions: readonly ReviewSuggestion[];
  drift: readonly string[];
}
export function planSweep(
  corpus: BlockCorpus,
  index: JevIndexV1,
  legacy: LegacyFingerprint,
  today: string,
  _reason: SweepReason,
  render?: { residentBytes: number; residentBudget: number; indexOverflow: boolean },
): SweepPlan {
  const archive: { id: string; rev: string }[] = [],
    suggestions: ReviewSuggestion[] = [];
  const add = (kind: ReviewSuggestionKind, b: (typeof corpus.blocks)[number]): void => {
    const a = { hash: entryHash(b.body), anchor: blockAnchor(b) };
    const id = createHash("sha1").update(`${kind}|${a.anchor}|${a.hash}`).digest("hex").slice(0, 16);
    if (
      index.review?.dismissed.some(
        (d) =>
          (!d.kind || d.kind === kind) &&
          (!d.until || d.until >= today) &&
          (d.hashKey === a.hash || d.anchorKey === a.anchor),
      )
    )
      return;
    const existing = index.review?.suggestions.find((s) => s.id === id);
    // until checks recur after 14 days only when the old suggestion was resolved.
    if (existing) return;
    if (
      kind === "until-check" &&
      index.review?.lastRunAt &&
      Date.parse(today) - Date.parse(index.review.lastRunAt) < 14 * 86400000 &&
      index.review.corpusFp === corpus.fingerprint
    )
      return;
    suggestions.push({ id, kind, a, p: 1, at: `${today}T00:00:00.000Z` });
  };
  for (const b of corpus.blocks) {
    if (b.meta.status !== "active") continue;
    if (isExpired(b.meta, today)) {
      if (b.meta.authority === "agent") archive.push({ id: b.id, rev: b.rev });
      else add("expired-user", b);
    }
    if (b.meta.until) add("until-check", b);
    const age = Date.parse(today) - Date.parse(b.meta.updated.slice(0, 10));
    if (
      b.meta.authority === "agent" &&
      !b.meta.expires &&
      !b.meta.until &&
      age > 7 * 86400000 &&
      looksLikeStateSnapshot(b.body)
    )
      add("snapshot", b);
    if (b.meta.residue) add("pointer", b);
    if (Buffer.byteLength(b.body) > 1024) add("oversize", b);
    if (b.meta.authority === "user" && b.meta.scope !== "global" && b.meta.origin?.file === "pin.md")
      add("scope-check", b);
    if (
      render &&
      (render.residentBytes > render.residentBudget || render.indexOverflow) &&
      b.meta.authority === "user" &&
      b.meta.scope === "global"
    )
      add("resident-budget", b);
    const temporal = index.entries[entryHash(b.body)]?.temporal;
    if (
      b.meta.authority === "agent" &&
      !b.meta.expires &&
      !b.meta.until &&
      age > 30 * 86400000 &&
      (temporal === "dated" || temporal === "event")
    )
      add("snapshot", b);
  }
  const known = new Map(legacy.files.map((f) => [f.name, f.sha256]));
  const drift = corpus.legacy.files.filter((f) => known.get(f.name) !== f.sha256).map((f) => f.name);
  if (drift.length && corpus.blocks[0]) add("legacy-drift", corpus.blocks[0]);
  return { archive, suggestions, drift };
}
