/**
 * workflow-worktree plan D9 (linkPaths): pure canonicalization + validation
 * for one `worktree.linkPaths` entry. Deliberately conservative — rejects
 * instead of silently correcting, so a typo in settings surfaces as a
 * warning (settings.ts) rather than a surprising symlink somewhere else.
 *
 * Shared by settings loading (settings.ts) AND the worktree extension's H2
 * (worktree.ts) — the exact same function, called at both points, so a value
 * that survives settings parsing is guaranteed to pass this check again at
 * H2 time (defense in depth, never two diverging rulesets).
 */

const FORBIDDEN_CHARS = /[:*?[\]!\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export type CanonicalLinkPathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validate and canonicalize one `linkPaths` entry. Never throws.
 *
 * Rejects: non-string, empty/too-long (1-255 chars), leading/trailing
 * whitespace, NUL/control chars, absolute paths, leading `-` (looks like a
 * git flag), backslashes, git pathspec metacharacters (`: * ? [ ] !`), any
 * empty/`.`/`..` path segment, and a value whose canonical form
 * (`segments.join("/")`) differs from the original (no silent correction).
 * Also enforces a max of 16 unique entries via `dedupeLinkPaths` below (this
 * function validates one entry at a time and knows nothing about siblings).
 */
export function canonicalLinkPath(raw: unknown): CanonicalLinkPathResult {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  if (raw.length < 1 || raw.length > 255) return { ok: false, reason: "length must be 1-255 characters" };
  if (raw.trim() !== raw) return { ok: false, reason: "leading/trailing whitespace" };
  if (CONTROL_CHARS.test(raw)) return { ok: false, reason: "contains a NUL or control character" };
  if (raw.startsWith("/")) return { ok: false, reason: "absolute paths are not allowed" };
  if (raw.startsWith("-")) return { ok: false, reason: "must not start with '-'" };
  if (raw.includes("\\")) return { ok: false, reason: "backslashes are not allowed" };
  if (FORBIDDEN_CHARS.test(raw)) return { ok: false, reason: "contains a forbidden character (: * ? [ ] !)" };
  const segments = raw.split("/");
  for (const seg of segments) {
    if (seg === "") return { ok: false, reason: "empty path segment" };
    if (seg === ".") return { ok: false, reason: "'.' path segment" };
    if (seg === "..") return { ok: false, reason: "'..' path segment" };
  }
  const canonical = segments.join("/");
  if (canonical !== raw) return { ok: false, reason: "not in canonical form" };
  return { ok: true, path: canonical };
}

/**
 * Validate a raw `linkPaths` array (from settings): drop non-array / invalid
 * entries (each with a warn callback so the caller can log it), dedupe, and
 * cap at 16.
 */
export function dedupeLinkPaths(raw: unknown, onInvalid?: (raw: unknown, reason: string) => void): readonly string[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) onInvalid?.(raw, "linkPaths must be an array");
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const check = canonicalLinkPath(entry);
    if (!check.ok) {
      onInvalid?.(entry, check.reason);
      continue;
    }
    if (seen.has(check.path)) continue;
    seen.add(check.path);
    result.push(check.path);
    if (result.length >= 16) break;
  }
  return result;
}
