// `resolveJevWiring` — the single "is Jev wired?" verdict (jev-plan §1.1,
// jev-arch §9.2). Pure, synchronous, pi-free.
//
// on ⇔ memory.jev.enabled ∧ layout = tiered ∧ toolSurface = v2 ∧ domain =
// plain ∧ classifiers non-empty. Every other combination is one of the four
// settings-period off reasons; `wireMemory` then never calls `wireJev` and
// passes no jev port to any existing module (I9 — proven by the off golden).
// The runtime-only `off(pi-api)` reason is NOT decided here: it needs a ctx
// (jev/wire.ts decides it per handler call).
//
// Precedence when several hold at once (first match wins): secure → legacy →
// disabled → empty-list. secure first so a vault session always reports the
// I11 reason; legacy before disabled because a legacy layout/tool surface is
// a hard incompatibility while `enabled` is a preference.

import type { MemorySettings } from "../settings.js";
import type { JevConfig } from "./contracts.js";

export type JevDomainKind = "plain" | "secure" | "locked";

export type JevOffReason = "disabled" | "legacy" | "secure" | "empty-list";

export type JevWiring =
  { readonly on: true; readonly config: JevConfig } | { readonly on: false; readonly reason: JevOffReason };

/** Map `MemorySettings.jev` (J3) onto the frozen pure `JevConfig` (J1). */
export function jevConfigOf(memory: MemorySettings): JevConfig {
  const jev = memory.jev;
  const seen = new Set<string>();
  const classifiers: string[] = [];
  for (const id of jev.classifiers) {
    if (seen.has(id)) continue;
    seen.add(id);
    classifiers.push(id);
  }
  return {
    classifiers,
    proxy: jev.proxy,
    childSessions: jev.childSessions,
    recall: {
      threshold: jev.recall.threshold,
      maxEntries: jev.recall.maxEntries,
      maxBytes: jev.recall.maxBytes,
      waitMs: jev.recall.waitMs,
    },
    reviewIntervalDays: jev.review.intervalDays,
    maxCostUsd: jev.maxCostUsd,
    maxCalls: jev.maxCalls,
    confirmTimeoutMs: jev.confirmTimeoutMs,
    fastPath: {
      allowTags: jev.fastPathAllowTags,
      denyTags: jev.fastPathDenyTags,
      cooldownMs: jev.fastPathCooldownH * 3_600_000,
    },
  };
}

export function resolveJevWiring(memory: MemorySettings, domainKind: JevDomainKind): JevWiring {
  if (domainKind !== "plain") return { on: false, reason: "secure" };
  if (memory.layout !== "tiered" || memory.toolSurface !== "v2") return { on: false, reason: "legacy" };
  if (!memory.jev.enabled) return { on: false, reason: "disabled" };
  if (memory.jev.classifiers.length === 0) return { on: false, reason: "empty-list" };
  return { on: true, config: jevConfigOf(memory) };
}
