/**
 * Fleet row presentation helpers (pure, DOM-free): the square type-letter badge and the short
 * model label used by `FleetTree.vue` ("variant C" row layout).
 */

/** Number of badge colour tones; `fleet.css` defines `.run-type[data-tone="0".."9"]`. */
export const TYPE_TONE_COUNT = 10;

/** Fixed palette entries for the known agent types (lowercase keys). `general-purpose` shares
 *  `general`'s tone on purpose — same letter, same colour. */
const KNOWN_TONES: Readonly<Record<string, number>> = {
  general: 0,
  "general-purpose": 0,
  verifier: 1,
  reviewer: 2,
  explore: 3,
  plan: 4,
  architect: 5,
  "frontend-dev": 6,
};

export interface TypeBadge {
  readonly letter: string;
  readonly tone: number;
}

function hashTone(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % TYPE_TONE_COUNT;
}

/** Badge for an agent type, or `null` for an empty type / one without any letter or digit. */
export function typeBadge(type: string): TypeBadge | null {
  const t = type.trim();
  const m = /[\p{L}\p{N}]/u.exec(t);
  if (m === null) return null;
  const known = KNOWN_TONES[t.toLowerCase()];
  return { letter: m[0].toUpperCase(), tone: known ?? hashTone(t.toLowerCase()) };
}

/** `claude-sonnet-5-5` → `sonnet-5.5`; `claude-fable-5` → `fable-5`; anything else unchanged
 *  apart from a trailing `-<d>-<d>` version, which becomes `-<d>.<d>`. Input is the id half
 *  (no provider). */
export function shortModelLabel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, "-$1.$2");
}
