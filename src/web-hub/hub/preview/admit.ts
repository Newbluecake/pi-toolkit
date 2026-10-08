/**
 * web-hub content-preview — GLOBAL fs admission (dir-plan v3.1 §2.1, superseding plan v3 §4.3's
 * cwd-class admitter; U4 2026-10-08: the admitted set is "uploads / any absolute
 * path" — the defences are NOT relaxed, the root-containment pair simply left with the root).
 *
 * The defence stack, §2.1's renumbered table: literal denylist + virtual-root decision (steps
 * 1–3, ZERO fs — a hostile path is answered before a single syscall) → realpath (step 4) →
 * `rp === "/"` + denylist + virtual-root re-check on the RESOLVED path (step 5) → stat →
 * `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY)` → fstat dev/ino identity → regular-file →
 * `/proc/self/fd/N` readlink re-check (fail closed, R3: skipped only when `procFdAvailable()`
 * is false). Deleted vs the cwd admitter: the root-literal checks (old 1–2), `realpath(root)`
 * (old 5) and the segment-aligned `withinRoot` containment (old 7) — `outside` can no longer
 * be produced (`PreviewDenyReason` keeps the literal for old-UI i18n only).
 *
 * Every fs call goes through `previewFsStep` (`fs.ts`): `min(stepCapMs, deadline.remaining())`,
 * unref'd timer, lazy initiation, abort-aware — and (§2.4) tracked: the admitter's deps carry
 * the routes instance's `PreviewIoTracker`, so a raced-out step counts as a zombie until it
 * settles and a tripped tracker fast-fails `busy` (503) before any new fs work. A raced-out
 * `open` that still resolves later is closed (迟到回收), so no fd ever leaks from an abandoned
 * admission.
 *
 * Error results carry the mapped HTTP response (`mapFsError` table) except aborts, which use
 * `status: 0` + `code: "E_ABORT"` — "不应答" is the caller's (routes, PV3) decision because
 * only it knows whether its controller aborted for a client disconnect or hub shutdown.
 */

import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import {
  defaultPreviewFs,
  isPreviewIoError,
  mapFsError,
  PREVIEW_READ_FLAGS,
  previewFsStep,
  type PreviewIoTracker,
} from "./fs.js";

// ---------------------------------------------------------------------------
// §4.3 injectable fs surface (the ONLY disk boundary; real adapter lives in fs.ts)
// ---------------------------------------------------------------------------

/** Structural slice of `fs.Stats` the admission/stream/verify kernels rely on. */
export interface PreviewStat {
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
  nlink: number;
  isFile(): boolean;
}

/** Structural slice of `fs.promises.FileHandle` (fakes only need these; `read` is positioned —
 * pread semantics — so concurrent readers on the same underlying file never share an offset). */
export interface PreviewHandle {
  readonly fd: number;
  stat(): Promise<PreviewStat>;
  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface PreviewFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<PreviewStat>;
  open(p: string, flags: number): Promise<PreviewHandle>;
  readlink(p: string): Promise<string>;
  procFdAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// §2.6 deny context — homes[]/agentDirs[] (literal + canonical), built by
// `resolvePreviewDenyContext` at hub start (fs.ts); `denyCtxOf` is the pure-literal form.
// ---------------------------------------------------------------------------

export interface PreviewDenyContext {
  /** the hub process's home, literal and canonical(realpath) deduped. */
  homes: string[];
  /** `PI_CODING_AGENT_DIR ?? ${home}/.pi/agent`, literal and canonical deduped. */
  agentDirs: string[];
}

/** Pure literal construction (zero fs) — tests and any assembly that deliberately skips the
 * startup realpath resolution. The canonical half is simply absent, which the §2.3 global
 * twins backstop (every context rule has a home-independent twin). */
export function denyCtxOf(home: string, agentDir: string): PreviewDenyContext {
  const trim = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  return { homes: [trim(home)], agentDirs: [trim(agentDir)] };
}

// ---------------------------------------------------------------------------
// virtual roots + denylist v2 (§2.3 — pure, zero-fs; applied to BOTH the literal
// request path (steps 1–3) and the realpath result (step 5))
// ---------------------------------------------------------------------------

/** `/proc`, `/sys`, `/dev`, `/run` — compared path-SEGMENT-aligned, literally AND on realpath. */
const VIRTUAL_ROOTS: readonly string[] = ["/proc", "/sys", "/dev", "/run"];

export function isVirtualFsPath(p: string): boolean {
  for (const root of VIRTUAL_ROOTS) {
    if (p === root || p.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * §2.3/§2.7: denylist v2's version — bump when ANY rule below changes, and update
 * `tests/fixtures/preview-denylist-corpus.json` (whose `version` must equal this) plus its
 * corpus test in the same PR. Changelog:
 * - v1 (plan v3 §4.3): cwd-class segments/subpaths/basenames/patterns/extensions + the four
 *   `${home}`-rooted pi paths.
 * - v2 (dir-plan §2.3): absolute system prefixes; `.pki`; `.vault-token`/`kubeconfig`/
 *   `.terraformrc`; `ssh_host_*_key` and `*.tfstate(.backup)` patterns; the home-independent
 *   twins for the pi paths plus the new tool-credential subpaths.
 */
export const PREVIEW_DENYLIST_VERSION = 2;

/** §2.3 绝对前缀 — system-level credential material, independent of any home. */
const DENY_ABSOLUTE_PREFIXES: readonly string[] = [
  "/etc/shadow",
  "/etc/shadow-",
  "/etc/gshadow",
  "/etc/gshadow-",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/ssl/private",
  "/etc/NetworkManager/system-connections",
  "/etc/wireguard",
  "/root",
  "/var/lib/sss",
];

/** §2.6 上下文前缀 — suffixes rooted at every `ctx.agentDirs[]` member (literal AND canonical
 * representations both live in the arrays, so all four request×ctx spellings are covered). */
const DENY_AGENTDIR_SUFFIXES: readonly string[] = ["web-hub", "auth.json", "models.json"];

/** §2.6 上下文前缀 — suffixes rooted at every `ctx.homes[]` member. */
const DENY_HOME_SUFFIXES: readonly string[] = [".config/pi"];

/** Any single path segment equal to one of these ⇒ denied. */
const DENY_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".mozilla",
  ".thunderbird",
  ".terraform.d",
  ".pki",
]);

/**
 * Consecutive-segment subpath equal to one of these ⇒ denied, ANYWHERE in the path — the
 * home-independent twins of the context rules above (§2.1's invariant: ctx missing either
 * representation cannot widen the pipeline) plus the v1 list.
 */
const DENY_SUBPATHS: readonly string[] = [
  // v1 (plan v3 §4.3)
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".local/share/keyrings",
  ".git/config",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  // v2 (dir-plan §2.3) — twins first, then the new tool-credential subpaths
  ".pi/agent/web-hub",
  ".pi/agent/auth.json",
  ".pi/agent/models.json",
  ".config/pi",
  ".config/op",
  ".config/rclone",
  ".config/sops",
  ".config/age",
  ".config/github-copilot",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".local/share/password-store",
];

/** basename equal ⇒ denied. */
const DENY_BASENAMES: ReadonlySet<string> = new Set([
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".psql_history",
  ".mysql_history",
  ".node_repl_history",
  ".lesshst",
  ".viminfo",
  ".vault-token",
  "kubeconfig",
  ".terraformrc",
]);

const DENY_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^ssh_host_.*_key$/,
  /\.tfstate(\.backup)?$/,
];

/** File extensions (case-INsensitive) ⇒ denied. */
const DENY_EXTENSIONS: readonly string[] = [".pem", ".key", ".p12", ".pfx", ".kdbx"];

/** Segment-aligned containment: `p === base` or `p` under `base/` (`/a/b` never matches `/a/b2`). */
function underBase(p: string, base: string): boolean {
  return p === base || p.startsWith(`${base}/`);
}

/**
 * §2.3/§2.6 拒绝列表 v2 — depth-defence only (§2.7's boundary statement: an authenticated
 * user may read anything the hub uid can read that this list does not name; the list is a
 * best-effort credential blacklist, NOT a whitelist boundary). `p` is the SINGLE path being
 * judged; the admitter calls this exactly twice — the request's literal path (steps 1–3) and
 * its realpath (step 5) — with the SAME rule set, so symlink spellings are caught on the
 * resolved side and literal spellings on the literal side.
 */
export function denyListHit(p: string, ctx: PreviewDenyContext): boolean {
  // context-prefix layer (§2.6): every homes[]/agentDirs[] member × its suffixes
  for (const base of ctx.agentDirs) {
    for (const suffix of DENY_AGENTDIR_SUFFIXES) {
      if (underBase(p, `${base}/${suffix}`)) return true;
    }
  }
  for (const base of ctx.homes) {
    for (const suffix of DENY_HOME_SUFFIXES) {
      if (underBase(p, `${base}/${suffix}`)) return true;
    }
  }
  // global layer (§2.3) — home-independent
  for (const prefix of DENY_ABSOLUTE_PREFIXES) {
    if (underBase(p, prefix)) return true;
  }
  const segments = p.slice(1).split("/");
  const base = segments[segments.length - 1] ?? "";
  if (DENY_BASENAMES.has(base)) return true;
  for (const pattern of DENY_BASENAME_PATTERNS) {
    if (pattern.test(base)) return true;
  }
  const dot = base.lastIndexOf(".");
  if (dot > 0 && DENY_EXTENSIONS.includes(base.slice(dot).toLowerCase())) return true;
  for (const segment of segments) {
    if (DENY_SEGMENTS.has(segment)) return true;
  }
  for (const sub of DENY_SUBPATHS) {
    const parts = sub.split("/");
    const plen = parts.length;
    for (let i = 0; i + plen <= segments.length; i += 1) {
      let hit = true;
      for (let j = 0; j < plen; j += 1) {
        if (segments[i + j] !== parts[j]) {
          hit = false;
          break;
        }
      }
      if (hit) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// the admitter (§2.1)
// ---------------------------------------------------------------------------

export interface FsAdmitterDeps {
  /** §2.6: homes[]/agentDirs[] (literal + canonical deduped) — `resolvePreviewDenyContext`'s
   * startup product, or `denyCtxOf` for tests. */
  denyCtx: PreviewDenyContext;
  /** §2.4: realpath/stat/open/fstat/readlink each go through the routes instance's tracker. */
  tracker: PreviewIoTracker;
  fs?: Partial<PreviewFs>;
  log: HubLog;
  now(): number;
  /** per-step cap override; defaults to `PREVIEW_FS_STEP_MS` (exposed for fast tests only). */
  stepCapMs?: number;
}

export interface FsAdmitInput {
  /** the request path, verbatim (absolute). */
  path: string;
  /** §3.1 (P1b): admits a DIRECTORY instead of refusing 415 — only ever honoured when
   * `/proc/self/fd` is available (§3.6 fail-closed). P1a keeps directories at 415. */
  allowDir?: boolean;
}

export type FsAdmitResult =
  | { ok: true; fh: PreviewHandle; size: number; realpath: string; dir?: true }
  | { ok: false; status: number; code: string; reason?: string }; // status 0 = E_ABORT (不应答)

export interface FsAdmitter {
  admit(input: FsAdmitInput, deadline: ReqDeadline, signal: AbortSignal): Promise<FsAdmitResult>;
}

function closeQuiet(fh: PreviewHandle): Promise<void> {
  return fh.close().then(
    () => undefined,
    () => undefined,
  );
}

export function createFsAdmitter(deps: FsAdmitterDeps): FsAdmitter {
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };

  return {
    async admit(input, deadline, signal): Promise<FsAdmitResult> {
      const step = <T>(lazy: () => Promise<T>): Promise<T> =>
        previewFsStep(
          lazy,
          deadline,
          signal,
          deps.stepCapMs === undefined
            ? { now: deps.now, tracker: deps.tracker }
            : { stepCapMs: deps.stepCapMs, now: deps.now, tracker: deps.tracker },
        );
      const denied = (reason: string): FsAdmitResult => ({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason });
      const mapped = (err: unknown): FsAdmitResult => {
        const m = mapFsError(err);
        if (m.kind === "abort") return { ok: false, status: 0, code: "E_ABORT" };
        return m.body.reason === undefined
          ? { ok: false, status: m.body.status, code: m.body.code }
          : { ok: false, status: m.body.status, code: m.body.code, reason: m.body.reason };
      };

      // -- steps 1–3: literal decisions, ZERO fs --------------------------------------------
      if (denyListHit(input.path, deps.denyCtx)) return denied("denylist");
      if (isVirtualFsPath(input.path)) return denied("virtual-fs");

      let fh: PreviewHandle | undefined;
      try {
        // -- step 4: realpath(path) ----------------------------------------------------------
        // fail-closed: without an `rp` the pipeline never reaches step 6's open — every
        // failure here maps through `mapFsError` (404 / 403 unreadable / 409 / 504 / 503).
        const rp = await step(() => fs.realpath(input.path));

        // -- step 5: re-checks on the resolved path ------------------------------------------
        if (rp === "/") return denied("root-too-broad");
        if (denyListHit(rp, deps.denyCtx)) return denied("denylist");
        if (isVirtualFsPath(rp)) return denied("virtual-fs");

        // -- step 6: stat ----------------------------------------------------------------------
        const st = await step(() => fs.stat(rp));

        // -- step 7: open (raced-out opens resolve late ⇒ their fd is recovered) ---------------
        let openInitiated: Promise<PreviewHandle> | undefined;
        const openPromise = step(() => {
          openInitiated = Promise.resolve().then(() => fs.open(rp, PREVIEW_READ_FLAGS));
          return openInitiated;
        });
        openPromise.catch((err: unknown) => {
          if (openInitiated !== undefined && isPreviewIoError(err)) {
            // §4.3 迟到的 open 回收: the race gave up, but the open may still hand us an fd
            openInitiated.then(closeQuiet).catch(() => undefined);
          }
        });
        fh = await openPromise;
        const h: PreviewHandle = fh;

        // -- step 8: fstat identity + regular-file --------------------------------------------
        // (§3.1/P1b will add the allowDir ∧ directory ∧ /proc branch here; P1b's land.)
        const fst = await step(() => h.stat());
        if (fst.dev !== st.dev || fst.ino !== st.ino) {
          await closeQuiet(h);
          return { ok: false, status: 409, code: "E_PREVIEW_CHANGED" };
        }
        if (!fst.isFile()) {
          await closeQuiet(h);
          return { ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" };
        }

        // -- step 9: /proc/self/fd re-check (fail closed) ------------------------------------
        if (fs.procFdAvailable()) {
          const fdPath = `/proc/self/fd/${h.fd}`;
          try {
            const target = await step(() => fs.readlink(fdPath));
            if (target !== rp || target.endsWith(" (deleted)")) {
              await closeQuiet(h);
              return { ok: false, status: 409, code: "E_PREVIEW_CHANGED" };
            }
          } catch (err) {
            if (isPreviewIoError(err)) throw err; // deadline/abort keep their own mapping
            deps.log.warn("preview readlink recheck failed", { code: "E_PREVIEW_CHANGED" });
            await closeQuiet(h);
            return { ok: false, status: 409, code: "E_PREVIEW_CHANGED" };
          }
        }

        // -- step 10 --------------------------------------------------------------------------
        return { ok: true, fh: h, size: fst.size, realpath: rp };
      } catch (err) {
        if (fh !== undefined) await closeQuiet(fh);
        if (signal.aborted || (isPreviewIoError(err) && err.ioFail === "abort")) {
          return { ok: false, status: 0, code: "E_ABORT" };
        }
        return mapped(err);
      }
    },
  };
}
