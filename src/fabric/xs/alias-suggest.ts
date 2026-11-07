/**
 * Alias-plan §7.1 (ALW): raw `/fabric alias` completion hints — the cwd's last segment, the session name's first
 * word and the cwd's CJK path runs. Pure (no I/O, no pi imports); the command normalizes + filters every hint
 * through `normalizeAlias` itself, so anything returned here is only a candidate.
 * Alias-force-default §5.2-6 (AF0): the cwd-tail hint is `deriveAliasFromDirName(tail)` — the SAME derivation the cwd
 * auto-claim uses — so the chip and the auto result never disagree; a tail that cannot be derived yields no hint.
 */

import { deriveAliasFromDirName } from "../../web-hub/protocol/xs-alias.js";

const MAX_HINTS = 8;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu;

export function aliasSuggestions(input: { cwd?: string | undefined; sessionName?: string | undefined }): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    if (raw === undefined || raw === "" || out.includes(raw) || out.length >= MAX_HINTS) return;
    out.push(raw);
  };
  const segments = (input.cwd ?? "").split(/[\\/]+/).filter((s) => s !== "");
  const tail = segments[segments.length - 1];
  if (tail !== undefined) {
    const derived = deriveAliasFromDirName(tail);
    if (derived.ok) push(derived.alias);
  }
  const firstWord = (input.sessionName ?? "").split(/[^\p{L}\p{N}_-]+/u).find((w) => w !== "");
  push(firstWord);
  // newest (deepest) CJK runs first
  for (const segment of [...segments].reverse()) {
    for (const run of segment.match(CJK_RUN_RE) ?? []) push(run);
  }
  return out;
}
