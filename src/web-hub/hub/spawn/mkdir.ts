/**
 * web-hub spawn-dirmkdir — the DirPicker browse panel's 「新建文件夹」 service
 * (`POST /api/headless/mkdir`, user 拍板 2026-10: 目录浏览器里还要能创建文件夹). The preview
 * endpoints stay 100% read-only, so this WRITE lives in the spawn namespace (spawn.enabled
 * gated, same as every other `/api/headless*`) — but its ADMISSION reuses preview's deny
 * chain verbatim: literal denylist + virtual-root check on the requested child path (zero
 * fs), `realpath(parent)`, then the SAME two checks again on the resolved parent and the
 * resolved child (`admit.ts`'s step 1–3 → 4 → 5 shape, minus the open/fstat tail — a create
 * has no existing file to pin). Both the literal and resolved forms are checked so symlink
 * spellings are caught on the resolved side exactly like preview's admitter.
 *
 * Semantics: NON-recursive `mkdir(2)` on the resolved child — EEXIST ⇒ 409
 * `E_CONFLICT{reason:"exists"}`, a missing parent (the realpath's ENOENT) ⇒ 404
 * `E_NOT_FOUND`, ENOTDIR ⇒ 409 `{reason:"not-directory"}`, EROFS ⇒ 403 `E_DENIED{reason:
 * "readonly"}`, EACCES/EPERM ⇒ 403 `{reason:"permission"}`; a denylist/virtual-fs hit ⇒ 403
 * `E_DENIED` with NO path in the body or the audit line (preview's §2.8 oracle discipline).
 * Every fs call rides `previewFsStep` (`fs.ts`'s bounded-IO pattern: per-step cap, unref'd
 * timer, lazy initiation, the caller's zombie tracker fast-failing `busy` ⇒ 503 `E_BUSY`,
 * deadline ⇒ 504 `E_DEADLINE`).
 *
 * `~`/`~/<rest>` parents are expanded against the hub's own home BEFORE admission
 * (`tilde.ts`'s `expandTildePath` — the identical rule `GET /api/preview` applies), so the
 * browse panel can create inside a `~`-rooted listing it is currently showing; `~user/...`
 * stays unexpanded and fails the absolute-path gate.
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`).
 */
import { mkdir, realpath } from "node:fs/promises";
import { validatePreviewPath } from "../../protocol/preview.js";
import { isValidMkdirName } from "../../protocol/spawn.js";
import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import { denyListHit, isVirtualFsPath, type PreviewDenyContext } from "../preview/admit.js";
import { isPreviewIoError, previewFsStep, type PreviewIoTracker } from "../preview/fs.js";
import { expandTildePath } from "../preview/tilde.js";

/** The ONLY disk boundary (injectable — tests fake/errno-inject it; the real adapter is the
 * two `node:fs/promises` calls below). */
export interface MkdirFs {
  realpath(p: string): Promise<string>;
  /** Non-recursive create; rejects with an errno Error (EEXIST/ENOENT/ENOTDIR/…). */
  mkdir(p: string): Promise<void>;
}

export interface MkdirServiceDeps {
  /** preview's §2.6 deny context (homes[]/agentDirs[], literal + canonical) — the SAME object
   * preview admission uses, resolved once at hub start. */
  denyCtx: PreviewDenyContext;
  /** The zombie-fs circuit breaker shared with preview's semantics (`previewFsStep`). */
  tracker: PreviewIoTracker;
  fs?: Partial<MkdirFs>;
  log: HubLog;
  now(): number;
  /** per-step cap override; defaults to `PREVIEW_FS_STEP_MS` (exposed for fast tests only). */
  stepCapMs?: number;
}

export type MkdirResult =
  | { ok: true; /** the created directory's RESOLVED absolute path */ path: string }
  | { ok: false; status: number; code: string; reason?: string };

export interface MkdirService {
  mkdir(parent: string, name: string, deadline: ReqDeadline): Promise<MkdirResult>;
}

/** Join a child segment onto a parent path (`/` is the one parent that needs no separator). */
function joinChild(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/** errno extraction without `as` (the source-scan contract) — `"code" in err` narrowing. */
function errCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/** fs failure → wire result (the mkdir-flavored subset of `fs.ts`'s `mapFsError` table, plus
 * EEXIST/ENOTDIR/EROFS which a read-only preview never produces). */
function mapMkdirError(err: unknown): Extract<MkdirResult, { ok: false }> {
  if (isPreviewIoError(err)) {
    // mkdir takes no caller abort signal — only deadline / the tracker breaker are reachable
    return err.ioFail === "busy"
      ? { ok: false, status: 503, code: "E_BUSY" }
      : { ok: false, status: 504, code: "E_DEADLINE" };
  }
  switch (errCodeOf(err)) {
    case "EEXIST":
      return { ok: false, status: 409, code: "E_CONFLICT", reason: "exists" };
    case "ENOENT":
      return { ok: false, status: 404, code: "E_NOT_FOUND" };
    case "ENOTDIR":
      return { ok: false, status: 409, code: "E_CONFLICT", reason: "not-directory" };
    case "EROFS":
      return { ok: false, status: 403, code: "E_DENIED", reason: "readonly" };
    case "EACCES":
    case "EPERM":
      return { ok: false, status: 403, code: "E_DENIED", reason: "permission" };
    case "EMFILE":
    case "ENFILE":
    case "ENOSPC":
    case "EAGAIN":
      return { ok: false, status: 503, code: "E_BUSY" };
    default:
      return { ok: false, status: 500, code: "E_INTERNAL" };
  }
}

export function createMkdirService(deps: MkdirServiceDeps): MkdirService {
  // plain named imports only (the hub/spawn/** zero-`as` contract bans even import aliases) —
  // the arrows keep the property names from shadowing them.
  const fs: MkdirFs = { realpath: (p) => realpath(p), mkdir: (p) => mkdir(p), ...deps.fs };

  return {
    async mkdir(parentRaw, name, deadline): Promise<MkdirResult> {
      const step = <T>(lazy: () => Promise<T>): Promise<T> =>
        previewFsStep(lazy, deadline, undefined, {
          ...(deps.stepCapMs === undefined ? {} : { stepCapMs: deps.stepCapMs }),
          now: deps.now,
          tracker: deps.tracker,
        });
      const denied = (reason: string): MkdirResult => ({ ok: false, status: 403, code: "E_DENIED", reason });

      // -- step 0: shape (defense-in-depth — the route's schema gate already enforced both;
      //    a direct caller still gets the same refusal) --------------------------------------
      if (!isValidMkdirName(name)) {
        return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "name-invalid" };
      }
      const parent = expandTildePath(parentRaw, deps.denyCtx.homes[0] ?? "");
      if (!validatePreviewPath(parent, { minSegments: 1 })) {
        return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "path-invalid" };
      }

      // -- steps 1–3: literal decisions on parent AND child, ZERO fs (admit.ts's shape) ------
      const childLiteral = joinChild(parent, name);
      if (denyListHit(parent, deps.denyCtx) || denyListHit(childLiteral, deps.denyCtx)) return denied("denylist");
      if (isVirtualFsPath(parent)) return denied("virtual-fs");

      try {
        // -- step 4: realpath(parent) — a missing/unreadable parent maps here (404/403) ------
        const rp = await step(() => fs.realpath(parent));

        // -- step 5: re-checks on the RESOLVED parent + child --------------------------------
        const child = joinChild(rp, name);
        if (denyListHit(rp, deps.denyCtx) || denyListHit(child, deps.denyCtx)) return denied("denylist");
        if (isVirtualFsPath(rp)) return denied("virtual-fs");

        // -- step 6: non-recursive create ------------------------------------------------------
        await step(() => fs.mkdir(child));
        return { ok: true, path: child };
      } catch (err) {
        const mapped = mapMkdirError(err);
        if (mapped.code === "E_INTERNAL") {
          deps.log.error("web-hub mkdir: unexpected fs error", { error: String(err) });
        }
        return mapped;
      }
    },
  };
}
