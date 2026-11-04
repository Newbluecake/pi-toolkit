/**
 * jev-reflex · S1 catalog matcher (plan R1 step 7; arch §4.4). Compiled once per catalog;
 * strong sources are implicitly anchored (`^(?:…)$`) over the normalized text, weak/exclude
 * are substring anchors. All regexes compile WITHOUT flags (no /g state — I4 hygiene).
 *
 * Bands: exactly one strong hit and no other script's strong/weak hit ⇒ `high`; anything else
 * with at least one hit ⇒ `ambiguous` (candidates in catalog order, scriptId = first, bookkeeping
 * only — ambiguous NEVER reaches S2, arch D10); `requires` not satisfied ⇒ script invisible.
 */

import type { Capability, MatchResult, RScriptV1 } from "./types.js";

export interface Matcher {
  match(norm: string, caps: ReadonlySet<Capability>): MatchResult;
}

interface CompiledScript {
  script: RScriptV1;
  strong: readonly RegExp[];
  weak: readonly RegExp[];
  exclude: readonly RegExp[];
}

export function compileCatalog(scripts: readonly RScriptV1[]): Matcher {
  const compiled: CompiledScript[] = scripts.map((script) => ({
    script,
    strong: script.intent.strong.map((src) => new RegExp(`^(?:${src})$`)),
    weak: script.intent.weak.map((src) => new RegExp(src)),
    exclude: script.intent.exclude.map((src) => new RegExp(src)),
  }));
  return {
    match(norm: string, caps: ReadonlySet<Capability>): MatchResult {
      const strongHits: CompiledScript[] = [];
      const weakHits: CompiledScript[] = [];
      for (const c of compiled) {
        if (!c.script.requires.every((cap) => caps.has(cap))) continue;
        if (c.exclude.some((re) => re.test(norm))) continue;
        if (c.strong.some((re) => re.test(norm))) {
          strongHits.push(c);
          continue;
        }
        if (c.weak.some((re) => re.test(norm))) weakHits.push(c);
      }
      const candidates = [...strongHits, ...weakHits]
        .filter((c, i, all) => all.findIndex((o) => o.script.id === c.script.id) === i)
        .map((c) => c.script.id);
      if (strongHits.length === 1 && candidates.length === 1) {
        return { kind: "hit", band: "high", scriptId: strongHits[0]!.script.id, candidates };
      }
      if (candidates.length > 0) {
        return { kind: "hit", band: "ambiguous", scriptId: candidates[0]!, candidates };
      }
      return { kind: "miss" };
    },
  };
}
