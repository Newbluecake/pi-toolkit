/**
 * Alias-plan §7.1 (ALW): raw `/fabric alias` completion hints — the cwd's last segment, the session name's first
 * word and the cwd's CJK path runs. Pure (no I/O, no pi imports); the command normalizes + filters every hint
 * through `normalizeAlias` itself, so anything returned here is only a candidate.
 */

const MAX_HINTS = 8;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu;

export function aliasSuggestions(input: { cwd?: string | undefined; sessionName?: string | undefined }): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    if (raw === undefined || raw === "" || out.includes(raw) || out.length >= MAX_HINTS) return;
    out.push(raw);
  };
  const segments = (input.cwd ?? "").split(/[\\/]+/).filter((s) => s !== "");
  push(segments[segments.length - 1]);
  const firstWord = (input.sessionName ?? "").split(/[^\p{L}\p{N}_-]+/u).find((w) => w !== "");
  push(firstWord);
  // newest (deepest) CJK runs first
  for (const segment of [...segments].reverse()) {
    for (const run of segment.match(CJK_RUN_RE) ?? []) push(run);
  }
  return out;
}
