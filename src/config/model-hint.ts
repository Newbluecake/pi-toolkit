/**
 * Model-hint resolution (parity with upstream @tintinweb/pi-subagents):
 * agent frontmatter `model:` and the Agent tool's `model` param accept
 * either a strict `provider/id` pair or a fuzzy hint — a bare model id
 * ("kimi-k3") or a case-insensitive substring alias ("sonnet", "haiku") —
 * resolved against pi's available models at spawn time.
 *
 * This module is pure: the candidate list is supplied by the caller
 * (stack.ts feeds `ctx.modelRegistry.getAvailable()`), so config parsing
 * and spawn admission stay free of any pi-registry import edge.
 */

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelCandidate extends ModelRef {
  /** Human display name (pi's Model.name), e.g. "Claude Sonnet 5". */
  name?: string;
}

/**
 * Short, self-correcting candidate list for config errors. Empty input → empty string.
 *
 * `annotate` (quota-plan §4.3) appends an optional per-candidate suffix (the
 * quota mark, e.g. " [5h 93% ⛔]"). Returning undefined marks nothing; when
 * `annotate` is omitted — or returns undefined for every visible candidate —
 * the output is byte-for-byte identical to the pre-quota implementation
 * (locked by tests/config/model-hint.test.ts).
 */
export function formatModelCandidates(
  candidates: readonly ModelCandidate[],
  limit = 8,
  annotate?: (candidate: ModelCandidate) => string | undefined,
): string {
  const visible = candidates.slice(0, limit);
  if (visible.length === 0) return "";
  const rest = candidates.length - visible.length;
  return `Available: ${visible
    .map((candidate) => `${candidate.provider}/${candidate.id}${annotate?.(candidate) ?? ""}`)
    .join(", ")}${rest > 0 ? `, … +${rest} more` : ""}`;
}

/**
 * Strict `provider/id` split — the only form that needs no registry lookup.
 * Returns undefined for bare ids, empty sides, or missing "/".
 */
export function parseStrictModelRef(value: string): ModelRef | undefined {
  const idx = value.indexOf("/");
  if (idx <= 0 || idx === value.length - 1) return undefined;
  const provider = value.slice(0, idx).trim();
  const id = value.slice(idx + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

/**
 * Resolve a fuzzy hint to a concrete {provider, id}. Matching tiers, first
 * non-empty tier wins, ties broken by candidate order (the caller orders
 * candidates by preference — stack.ts passes pi's registry order):
 *
 *  1. strict `provider/id` exact match (case-insensitive both parts)
 *  2. exact id match ("kimi-k3" — even when several providers serve it)
 *  3. id prefix match ("claude-opus" → claude-opus-4-8, …)
 *  4. id substring match ("sonnet" → claude-sonnet-5)
 *  5. display-name substring match ("opus 5" → "Claude Opus 5")
 *
 * Returns undefined when no candidate matches — the caller turns that into
 * a self-correcting config error rather than silently inheriting the parent
 * model (a silently-ignored hint runs the task on the wrong model).
 */
export function resolveModelHint(hint: string, candidates: readonly ModelCandidate[]): ModelRef | undefined {
  const q = hint.trim().toLowerCase();
  if (!q) return undefined;
  const pick = (tier: (c: ModelCandidate) => boolean): ModelRef | undefined => {
    const hit = candidates.find(tier);
    return hit ? { provider: hit.provider, id: hit.id } : undefined;
  };
  const strict = parseStrictModelRef(hint);
  if (strict) {
    const p = strict.provider.toLowerCase();
    const i = strict.id.toLowerCase();
    return pick((c) => c.provider.toLowerCase() === p && c.id.toLowerCase() === i);
  }
  return (
    pick((c) => c.id.toLowerCase() === q) ??
    pick((c) => c.id.toLowerCase().startsWith(q)) ??
    pick((c) => c.id.toLowerCase().includes(q)) ??
    pick((c) => (c.name ?? "").toLowerCase().includes(q))
  );
}

/** Classic Levenshtein distance (two-row DP); inputs are short model refs. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * "Did you mean" candidates for a strict `provider/id` that is not in pi's
 * model registry (typically a renamed provider: `cloudrouter-anthropic/x` →
 * `cr-anthropic/x`). Ranking, first tier wins ties, candidate order breaks
 * the rest:
 *
 * -1. the same pair differing only in case (pi's lookup is exact);
 *  0. same id under another provider (case-insensitive) — the rename case;
 *  1. same provider, similar id;
 *  2. any provider, similar id or similar full ref.
 *
 * Tiers 1–2 only keep candidates within an edit-distance threshold
 * (≈ a third of the longer string, at least 2), so an unrelated model is
 * never offered as a "correction". Pure; at most `limit` distinct refs.
 */
export function suggestModelRefs(ref: ModelRef, candidates: readonly ModelCandidate[], limit = 3): ModelCandidate[] {
  const p = ref.provider.toLowerCase();
  const i = ref.id.toLowerCase();
  const full = `${p}/${i}`;
  const close = (a: string, b: string, d: number) => d <= Math.max(2, Math.floor(Math.max(a.length, b.length) / 3));
  const scored: Array<{ c: ModelCandidate; tier: number; d: number; order: number }> = [];
  const seen = new Set<string>();
  candidates.forEach((c, order) => {
    const key = `${c.provider}/${c.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const cp = c.provider.toLowerCase();
    const ci = c.id.toLowerCase();
    // Case-only mismatch: pi's registry lookup is exact, so this is the best fix.
    if (cp === p && ci === i) return void scored.push({ c, tier: -1, d: 0, order });
    if (ci === i) return void scored.push({ c, tier: 0, d: editDistance(p, cp), order });
    const dId = editDistance(i, ci);
    if (cp === p) {
      if (close(i, ci, dId)) scored.push({ c, tier: 1, d: dId, order });
      return;
    }
    const cfull = `${cp}/${ci}`;
    const dFull = editDistance(full, cfull);
    if (close(i, ci, dId) || close(full, cfull, dFull)) scored.push({ c, tier: 2, d: Math.min(dId, dFull), order });
  });
  scored.sort((a, b) => a.tier - b.tier || a.d - b.d || a.order - b.order);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.c);
}

/**
 * Self-correcting admission error for a strict `provider/id` pi's registry
 * does not know. `source` names where the pair came from when it is not the
 * caller's own `model` param (an agent type's frontmatter default).
 */
export function formatUnknownModelError(
  ref: ModelRef,
  candidates: readonly ModelCandidate[],
  opts: { source?: string; annotate?: (candidate: ModelCandidate) => string | undefined } = {},
): string {
  const head =
    `Unknown model "${ref.provider}/${ref.id}"${opts.source ? ` (${opts.source})` : ""} — ` +
    `not in pi's model registry, so no run was started.`;
  const suggestions = suggestModelRefs(ref, candidates);
  if (suggestions.length > 0)
    return `${head} Did you mean: ${suggestions
      .map((c) => `${c.provider}/${c.id}${opts.annotate?.(c) ?? ""}`)
      .join(", ")}?`;
  const list = formatModelCandidates(candidates, 8, opts.annotate);
  return `${head} Pass the FULL provider/id of an available model (pi /model lists them).${list ? ` ${list}` : ""}`;
}
