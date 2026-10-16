/**
 * Top-bar build stamps (user request 2026-09-28): show enough of the running build's identity
 * to confirm versions at a glance — the hub's `buildId` (`<version>@<commit12>[-dirty]`, from
 * the SSE `hub` frame) and the UI bundle's own `__PWH_UI_BUILD__` (baked by vite.config's
 * `define`, see `src/build-info.ts`). Compact English markers only (AGENTS.md UI text split).
 */

/**
 * `<version>@<commit>` / raw commit → 7-char short commit; `null` when nothing usable.
 * Accepts BOTH dirty spellings the wire ever carries (web-hub-version plan §5.1): the hub
 * buildId's terminal `*` (`0.5.5@6451c63abc12*` — the pre-V2 bug: only `-dirty` was stripped,
 * so a dirty hub rendered no stamp at all) and the UI manifest's `-dirty`
 * (`0.5.5@6451c63abc12-dirty`). The dirty flag itself is intentionally NOT returned here —
 * callers that need it use `@protocol/version-info.ts`'s `normalizeCommit`.
 * @param {unknown} buildId e.g. `"0.2.1@6451c63abc12"`, `"0.2.1@6451c63abc12*"` or `"0.2.1@6451c63abc12-dirty"`
 * @returns {string | null}
 */
export function shortCommit(buildId) {
  if (typeof buildId !== "string") return null;
  const at = buildId.includes("@") ? buildId.slice(buildId.lastIndexOf("@") + 1) : buildId;
  let hex = at;
  if (hex.endsWith("*")) hex = hex.slice(0, -1);
  else if (hex.endsWith("-dirty")) hex = hex.slice(0, -"-dirty".length);
  return /^[0-9a-f]{7,40}$/.test(hex) ? hex.slice(0, 7) : null;
}

/**
 * `"0.2.1@6451c63abc12"` (or separate version + buildId) → `"0.2.1@6451c63"`.
 * @param {unknown} version
 * @param {unknown} buildId
 * @returns {string | null}
 */
export function hubVersionStamp(version, buildId) {
  if (typeof version !== "string" || version === "") return null;
  const c = shortCommit(buildId);
  return c === null ? version : `${version}@${c}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * UI build stamp `ui <version>@<commit7> · MM-DD HH:mm` (local time); the time part drops
 * silently when `builtAt` is unparseable (e.g. an older bundle without the field).
 * @param {{ version?: unknown, commit?: unknown, builtAt?: unknown }} build
 * @returns {string | null}
 */
export function uiBuildStamp(build) {
  if (build === null || typeof build !== "object") return null;
  const version = typeof build.version === "string" && build.version !== "" ? build.version : null;
  const c = shortCommit(build.commit);
  const head = version === null ? null : c === null ? version : `${version}@${c}`;
  if (head === null) return null;
  const t = typeof build.builtAt === "string" ? new Date(build.builtAt) : null;
  if (t === null || Number.isNaN(t.getTime())) return head;
  return `${head} · ${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

/**
 * web-hub-version plan §4: the TAB's bundle identity — the `/assets/*` resource paths this
 * page actually loaded, read once from its own DOM at startup (`script[type=module]` +
 * `link[rel=stylesheet]`, both `^="/assets/"`). Vite content-hash filenames make the sorted
 * list a fingerprint that changes on every rebuild even when `version`/`commit`/`builtAt` do
 * not (fixed `SOURCE_DATE_EPOCH`, dirty rebuilds) — exactly what `tab-stale` compares
 * against `hub.ui.assets`.
 *
 * `null` when nothing matches (a `vite dev` server serves `/src/main.ts`-style paths, not
 * hashed `/assets/*`): "unknown", never an empty-list claim of equality.
 * @param {Document | null | undefined} doc
 * @returns {string[] | null}
 */
export function tabAssets(doc) {
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
  /** @type {Set<string>} */
  const out = new Set();
  for (const s of doc.querySelectorAll('script[type="module"][src^="/assets/"]')) {
    const v = s.getAttribute("src");
    if (typeof v === "string" && v !== "") out.add(v);
  }
  for (const l of doc.querySelectorAll('link[rel="stylesheet"][href^="/assets/"]')) {
    const v = l.getAttribute("href");
    if (typeof v === "string" && v !== "") out.add(v);
  }
  return out.size === 0 ? null : [...out].sort();
}
