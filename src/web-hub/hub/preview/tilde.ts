/**
 * web-hub content-preview — `~/` expansion (tilde-expansion addendum to dir-plan v3.1).
 *
 * Agents and tools print `~/...` paths constantly; `logic/preview.js`'s recognition layer
 * (gated behind the NEW `preview.tilde.v1` cap — see that module's doc comment) turns a
 * `~/<rest>` span into a clickable ref whose `path` is sent to the hub VERBATIM, still
 * starting with `~`. This module is the ONE place that resolves it — into an absolute path
 * rooted at the HUB's own home directory (the hub always runs as the same uid as the agents,
 * so "its own home" is the only sane interpretation of a bare `~`) — and it runs BEFORE any
 * admission check (`routes.ts`'s step ③, right after the raw `path` query param is read):
 * the expanded string is what the denylist/virtual-root/realpath/open chain in `admit.ts`
 * then sees, unchanged otherwise. Nothing about that chain is weakened — expansion only
 * REWRITES the string handed to it; the chain still runs in full on the result, including the
 * two denylist checks (literal `input.path` pre-realpath, and the post-realpath form), and
 * `PreviewDenyContext.homes` already carries this same home in BOTH literal and canonical
 * form (`resolvePreviewDenyContext`), so a `~/.ssh/id_rsa`-style request denylists exactly
 * like typing the expanded path out by hand would.
 *
 * `~user/...` (a tilde immediately followed by a username, not `/` or end-of-string) is
 * NEVER expanded: POSIX shells only expand a BARE `~` for the INVOKING user — `~bob/...`
 * names bob's home, which this hub has no business resolving (and must never silently
 * rewrite into ITS OWN home, which would be a confused-deputy substitution). Left unexpanded,
 * `~bob/...` simply fails the ordinary `/`-prefix path gate exactly as it would have before
 * this feature existed (400 `E_BAD_REQUEST`), never 403/404 from a half-admitted guess.
 */

/**
 * @param path the raw request `path` query value, verbatim.
 * @param home the hub's own home directory, LITERAL form (`PreviewDenyContext.homes[0]`) —
 *   already trimmed of any trailing slash (`resolvePreviewDenyContext`'s convention). Returns
 *   `path` unchanged when it is not a bare `~` / `~/...` form, or when `home` is empty
 *   (defensive only — `resolvePreviewDenyContext` always resolves at least the literal form;
 *   an empty `home` here would otherwise turn `~/x` into the non-absolute `/x`, which is
 *   actually fine too, but refusing to touch the string at all is the more obviously-correct
 *   fail-safe).
 */
export function expandTildePath(path: string, home: string): string {
  if (typeof path !== "string" || home === "") return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}
