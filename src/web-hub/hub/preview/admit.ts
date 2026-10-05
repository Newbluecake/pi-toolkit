/**
 * web-hub content-preview — cwd-class admission (web-hub-preview plan v3 §4.3, PV2a).
 *
 * The cwd-class defence stack, verbatim from §4.3's 13 steps: literal prefix decision (steps
 * 1–4 touch NO fs at all — a hostile root/path is answered before a single syscall) → realpath
 * ×2 → segment-aligned `withinRoot` (reused from `hub/spawn/dirs.ts`) → denylist + virtual-root
 * re-check on the *resolved* path → stat → `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY)` →
 * fstat dev/ino identity → `/proc/self/fd/N` readlink re-check (fail closed, R3: skipped only
 * when `procFdAvailable()` is false).
 *
 * Every fs call goes through `previewFsStep` (`fs.ts`): `min(stepCapMs, deadline.remaining())`,
 * unref'd timer, lazy initiation, abort-aware — the §4.3 budget "cwd 类最多 7 次 fs 调用" (this
 * module makes 6 of them; the two sniff reads belong to the caller and stay inside the same
 * shared `ReqDeadline`). A raced-out `open` that still resolves later is closed (迟到回收), so
 * no fd ever leaks from an abandoned admission.
 *
 * Error results carry the mapped HTTP response (`mapFsError` table) except aborts, which use
 * `status: 0` + `code: "E_ABORT"` — "不应答" is the caller's (routes, PV3) decision because
 * only it knows whether its controller aborted for a client disconnect or hub shutdown.
 */

import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import { withinRoot } from "../spawn/dirs.js";
import { defaultPreviewFs, isPreviewIoError, mapFsError, PREVIEW_READ_FLAGS, previewFsStep } from "./fs.js";

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

export interface CwdAdmitInput {
  path: string;
  /** session.cwd — the preview root (home is ALLOWED here: U2, denylist is the backstop). */
  root: string;
}

export type CwdAdmitResult =
  | { ok: true; fh: PreviewHandle; size: number; realpath: string }
  | { ok: false; status: number; code: string; reason?: string };

// ---------------------------------------------------------------------------
// virtual roots + denylist (§4.3 — pure, zero-fs; applied to BOTH the literal
// request path (steps 3/4) and the realpath result (step 8))
// ---------------------------------------------------------------------------

/** `/proc`, `/sys`, `/dev`, `/run` — compared path-SEGMENT-aligned, literally AND on realpath. */
const VIRTUAL_ROOTS: readonly string[] = ["/proc", "/sys", "/dev", "/run"];

export function isVirtualFsPath(p: string): boolean {
  for (const root of VIRTUAL_ROOTS) {
    if (p === root || p.startsWith(`${root}/`)) return true;
  }
  return false;
}

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
]);

/** Consecutive-segment subpath equal to one of these ⇒ denied (slash-joined entries of any
 * length — the plan's list is mostly two segments plus `.local/share/keyrings`). */
const DENY_SUBPATHS: readonly string[] = [
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
]);

const DENY_BASENAME_PATTERNS: readonly RegExp[] = [/^\.env(\..+)?$/, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/];

/** File extensions (case-INsensitive) ⇒ denied. */
const DENY_EXTENSIONS: readonly string[] = [".pem", ".key", ".p12", ".pfx", ".kdbx"];

function denyPrefixes(home: string): string[] {
  return [
    `${home}/.pi/agent/web-hub`,
    `${home}/.pi/agent/auth.json`,
    `${home}/.pi/agent/models.json`,
    `${home}/.config/pi/web-search.env`,
  ];
}

/**
 * §4.3 拒绝列表 — depth-defence only (D11: the security boundary is the cwd subtree + virtual
 * roots; with home as cwd (U2) this list is what keeps the obvious secrets out). `home` is the
 * hub process's own home (`createCwdAdmitter`'s `deps.home`), never a request-controlled value.
 */
export function denyListHit(p: string, home: string): boolean {
  for (const prefix of denyPrefixes(home)) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return true;
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
// the admitter
// ---------------------------------------------------------------------------

export interface CwdAdmitterDeps {
  home: string;
  fs?: Partial<PreviewFs>;
  log: HubLog;
  now(): number;
  /** per-step cap override; defaults to `PREVIEW_FS_STEP_MS` (exposed for fast tests only). */
  stepCapMs?: number;
}

export interface CwdAdmitter {
  admit(input: CwdAdmitInput, deadline: ReqDeadline, signal: AbortSignal): Promise<CwdAdmitResult>;
}

function closeQuiet(fh: PreviewHandle): Promise<void> {
  return fh.close().then(
    () => undefined,
    () => undefined,
  );
}

export function createCwdAdmitter(deps: CwdAdmitterDeps): CwdAdmitter {
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  const home = deps.home.endsWith("/") && deps.home.length > 1 ? deps.home.slice(0, -1) : deps.home;

  return {
    async admit(input, deadline, signal): Promise<CwdAdmitResult> {
      const step = <T>(lazy: () => Promise<T>): Promise<T> =>
        previewFsStep(
          lazy,
          deadline,
          signal,
          deps.stepCapMs === undefined ? { now: deps.now } : { stepCapMs: deps.stepCapMs, now: deps.now },
        );
      const denied = (reason: string): CwdAdmitResult => ({ ok: false, status: 403, code: "E_PREVIEW_DENIED", reason });
      const mapped = (err: unknown): CwdAdmitResult => {
        const m = mapFsError(err);
        if (m.kind === "abort") return { ok: false, status: 0, code: "E_ABORT" };
        return m.body.reason === undefined
          ? { ok: false, status: m.body.status, code: m.body.code }
          : { ok: false, status: m.body.status, code: m.body.code, reason: m.body.reason };
      };

      // -- steps 1–4: literal decisions, ZERO fs calls --------------------------------------
      if (!input.root.startsWith("/")) return denied("root-too-broad");
      const root = input.root.length > 1 && input.root.endsWith("/") ? input.root.slice(0, -1) : input.root;
      if (root.length === 0 || root === "/") return denied("root-too-broad");
      if (isVirtualFsPath(root)) return denied("virtual-fs");
      if (!input.path.startsWith(`${root}/`)) return denied("outside");
      if (denyListHit(input.path, home)) return denied("denylist");
      if (isVirtualFsPath(input.path)) return denied("virtual-fs");

      let fh: PreviewHandle | undefined;
      try {
        // -- step 5: realpath(root) ----------------------------------------------------------
        const rootRp = await step(() => fs.realpath(root));
        if (rootRp === "/") return denied("root-too-broad");
        if (isVirtualFsPath(rootRp)) return denied("virtual-fs");

        // -- step 6: realpath(path) ----------------------------------------------------------
        const rp = await step(() => fs.realpath(input.path));

        // -- steps 7/8: containment + re-check on the resolved path --------------------------
        if (!withinRoot(rootRp, rp) || rp === rootRp) return denied("outside");
        if (denyListHit(rp, home)) return denied("denylist");
        if (isVirtualFsPath(rp)) return denied("virtual-fs");

        // -- step 9: stat ----------------------------------------------------------------------
        const st = await step(() => fs.stat(rp));

        // -- step 10: open (raced-out opens resolve late ⇒ their fd is recovered) --------------
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

        // -- step 11: fstat identity + regular-file -----------------------------------------
        const fst = await step(() => h.stat());
        if (fst.dev !== st.dev || fst.ino !== st.ino) {
          await closeQuiet(h);
          return { ok: false, status: 409, code: "E_PREVIEW_CHANGED" };
        }
        if (!fst.isFile()) {
          await closeQuiet(h);
          return { ok: false, status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" };
        }

        // -- step 12: /proc/self/fd re-check (fail closed) ----------------------------------
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

        // -- step 13 --------------------------------------------------------------------------
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
