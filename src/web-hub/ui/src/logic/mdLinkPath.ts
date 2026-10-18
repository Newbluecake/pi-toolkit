/**
 * Pure resolver for relative / absolute-path markdown link targets (`[t](../x.md)`), the
 * UI half of the parser's `pathlink` node (the parser stays resolution-free).
 *
 * `resolveMdLinkTarget(target, base, scope)` ⇒ the request path (+ `dir` flag) to hand to the
 * preview handle, or `null` ⇒ render the link text only. The hub re-checks admission anyway;
 * the checks here only avoid offering links that can never open (same disablement rules as
 * path chips: no abs cap ⇒ must stay segment-aligned under a real `scope.cwd`).
 */

export interface MdLinkScope {
  readonly cwd: string | null;
  readonly abs?: true | undefined;
  readonly dirs?: true | undefined;
  readonly tilde?: true | undefined;
  readonly uploads?: boolean | undefined;
}

export interface ResolvedMdLink {
  readonly path: string;
  readonly dir: boolean;
}

/** Directory part of an absolute / `~/` file path (`/a/b.md` ⇒ `/a`); `null` when none. */
export function dirOfPreviewPath(path: string): string | null {
  if (path === "") return null;
  const i = path.lastIndexOf("/");
  if (i < 0) return null;
  if (i === 0) return "/";
  return path.slice(0, i);
}

/**
 * Collapse `.`/`..` of `base + "/" + rel` (or `rel` alone when absolute). Roots: `/` or `~`.
 * Never escapes above its root (`null` instead). Returns the path and whether it ended in `/`.
 */
function normalize(rel: string, base: string | null): { path: string; trailingSlash: boolean } | null {
  let root: "/" | "~";
  let segs: string[];
  if (rel.startsWith("/")) {
    root = "/";
    segs = [];
  } else {
    if (base === null || base === "") return null;
    if (base === "~" || base.startsWith("~/")) {
      root = "~";
      segs = base.slice(1).split("/");
    } else if (base.startsWith("/")) {
      root = "/";
      segs = base.split("/");
    } else return null;
  }
  segs = segs.filter((x) => x !== "" && x !== ".");
  const parts = rel.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length === 0) {
        if (root === "/") continue; // clamp at `/` — never above it
        return null; // above `~`
      }
      segs.pop();
      continue;
    }
    segs.push(part);
  }
  const last = parts[parts.length - 1];
  const trailingSlash = last === "" || last === "." || last === "..";
  const body = segs.join("/");
  const path = root === "/" ? `/${body}` : body === "" ? "~" : `~/${body}`;
  return { path, trailingSlash };
}

function underCwd(path: string, cwd: string | null): boolean {
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return false;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return path === base || path.startsWith(`${base}/`);
}

export function resolveMdLinkTarget(
  target: string,
  base: string | null,
  scope: MdLinkScope | null,
): ResolvedMdLink | null {
  if (scope === null) return null;
  let t = target;
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  const q = t.indexOf("?");
  if (q >= 0) t = t.slice(0, q);
  if (t === "") return null;
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep the raw text */
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(t)) return null;
  const effectiveBase = base !== null && base !== "" ? base : scope.cwd;
  const n = normalize(t, effectiveBase);
  if (n === null) return null;
  const dir = n.trailingSlash || n.path === "/";
  if (dir && scope.dirs !== true) return null;
  const { path } = n;
  if (path === "/" || path === "~") return null;
  if (path === "~" || path.startsWith("~/")) {
    if (scope.tilde !== true) return null;
  } else if (scope.abs !== true && !underCwd(path, scope.cwd)) {
    return null;
  }
  return { path, dir };
}
