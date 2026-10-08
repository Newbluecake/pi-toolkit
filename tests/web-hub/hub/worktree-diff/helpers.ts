/**
 * worktree-diff D3 shared test harness: a scripted git runner + an in-memory `PreviewFs`
 * modeling a main worktree, a linked worktree and the `/proc/self/fd/<fd>/…` re-entry, plus
 * the route-level fakes (io / res / req / registry) every worktree-diff test file drives.
 *
 * The fake fs resolves `/proc/self/fd/<fd>/<rest>` through a handle table (each handle records
 * the CANONICAL path it was opened at — exactly the procfs magic-symlink semantics the
 * production code leans on), which is what makes the three-fd pinning, the `.git`-pointer read
 * through the pinned worktree fd and the info/attributes read through the pinned commondir fd
 * testable without touching the real disk.
 */

import type { ServerResponse } from "node:http";

import type { GitRunOptions, GitRunResult, GitRunner } from "../../../../src/git/run.js";
import type { PreviewRouteIo } from "../../../../src/web-hub/hub/ports.js";
import type { HubLog } from "../../../../src/web-hub/hub/ports.js";
import type {
  PreviewDirHandle,
  PreviewFs,
  PreviewHandle,
  PreviewStat,
} from "../../../../src/web-hub/hub/preview/admit.js";
import { memLog } from "../helpers.js";

export { memLog };
export type { HubLog };

// ---------------------------------------------------------------------------
// the scripted git runner
// ---------------------------------------------------------------------------

export type Scripted = GitRunResult | ((call: { argv: readonly string[]; opts: GitRunOptions }) => GitRunResult);

export interface ScriptedRunner extends GitRunner {
  calls: Array<{ argv: string[]; opts: GitRunOptions }>;
  push(...responses: Scripted[]): void;
  /** per-call handler taking precedence over the FIFO queue (concurrency tests where the
   * call order is not deterministic route their responses by argv shape; may hang). */
  setHandler(
    fn: ((call: { argv: readonly string[]; opts: GitRunOptions }) => GitRunResult | Promise<GitRunResult>) | undefined,
  ): void;
  /** all argv seen so far, joined — handy for "C4 never executed" assertions */
  argvLog(): string[];
}

export function okRun(stdout = ""): GitRunResult {
  return { code: 0, stdout, stdoutCapped: false, stderr: "" };
}

export function scriptedRunner(): ScriptedRunner {
  const queue: Scripted[] = [];
  const calls: Array<{ argv: string[]; opts: GitRunOptions }> = [];
  let handler:
    ((call: { argv: readonly string[]; opts: GitRunOptions }) => GitRunResult | Promise<GitRunResult>) | undefined;
  // a FUNCTION with the introspection props attached — assignable to GitRunner directly
  const runner = Object.assign(
    (argv: readonly string[], opts: GitRunOptions): Promise<GitRunResult> => {
      calls.push({ argv: [...argv], opts });
      if (handler !== undefined) return Promise.resolve(handler({ argv, opts }));
      const next = queue.shift();
      if (next === undefined) {
        return Promise.resolve({
          code: 128,
          stdout: "",
          stdoutCapped: false,
          stderr: `unexpected git call: ${argv.join(" ")}`,
        });
      }
      return Promise.resolve(typeof next === "function" ? next({ argv, opts }) : next);
    },
    {
      calls,
      push: (...responses: Scripted[]) => {
        queue.push(...responses);
      },
      setHandler: (
        fn:
          | ((call: { argv: readonly string[]; opts: GitRunOptions }) => GitRunResult | Promise<GitRunResult>)
          | undefined,
      ) => {
        handler = fn;
      },
      argvLog: () => calls.map((c) => c.argv.join(" ")),
    },
  ) as ScriptedRunner;
  return runner;
}

/** True when the argv is the named wtdiff command (C1a/C1/C0/Cc/C2/Ca/C3/C4 by shape). */
export function isCmd(argv: readonly string[], cmd: string): boolean {
  const j = argv.join(" ");
  switch (cmd) {
    case "C1a":
      return j.includes("rev-parse") && j.includes("--git-common-dir");
    case "C1":
      return j.includes("worktree list --porcelain");
    case "C0":
      return j.includes("rev-parse") && j.includes("--show-object-format HEAD");
    case "Cc":
      return j.includes("config") && j.includes("--get-regexp");
    case "C2":
      return j.includes("status --porcelain=v2");
    case "Ca":
      return j.includes("check-attr");
    case "C3":
      return j.includes("diff-index --numstat");
    case "C4":
      return j.includes("diff-index -p");
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// the in-memory fs
// ---------------------------------------------------------------------------

export const O_RDONLY = 0;
export const O_DIRECTORY = 0o200000;
export const O_NOFOLLOW = 0o400000;

type FakeNodeType = "dir" | "file" | "symlink";

class FakeNode {
  children = new Map<string, FakeNode>();
  content = Buffer.alloc(0);
  target = "";
  size = 0;
  ctimeMs = 1_000;
  constructor(
    readonly type: FakeNodeType,
    readonly ino: number,
    readonly dev: number,
  ) {
    if (type === "dir") this.size = 128;
  }
  stat(): PreviewStat {
    const self = this;
    return {
      dev: self.dev,
      ino: self.ino,
      size: self.size,
      ctimeMs: self.ctimeMs,
      nlink: 1,
      isFile: () => self.type === "file",
      isDirectory: () => self.type === "dir",
    };
  }
}

export interface FakeFs extends PreviewFs {
  node(at: string): FakeNode | undefined;
  mkdir(at: string): void;
  writeFile(at: string, content: string | Buffer): FakeNode;
  symlink(at: string, target: string): void;
  replaceDir(at: string): void;
  leakCount(): number;
  /** make the NEXT handle opened with this fd's close() hang until the returned release fn */
  hangNextClose(): () => void;
  openFds: Set<number>;
  closedFds: number[];
  fdPaths: Map<number, string>;
  statInoOverride: Map<string, number>;
}

/**
 * A factory, NOT a class: the production code builds its fs as `{...defaultPreviewFs(),
 * ...deps.fs}` — an object spread only carries OWN properties, so a class instance's prototype
 * methods would silently vanish. Every method here is an own property of the returned object
 * (same shape as `defaultPreviewFs` itself).
 */
export function createFakeFs(root: FakeNode = new FakeNode("dir", 1, 1)): FakeFs {
  let inoSeq = 100;
  let fdSeq = 7;
  const openFds = new Set<number>();
  const closedFds: number[] = [];
  const fdPaths = new Map<number, string>();
  /** path → ino override for `stat()` (the dev/ino-mismatch races: the fake's path-stat and
   * handle-stat otherwise can never diverge). */
  const statInoOverride = new Map<string, number>();
  let hangingClose: (() => void) | null = null;
  const releaseListeners: Array<() => void> = [];

  const split = (p: string): string[] => p.split("/").filter((s) => s.length > 0);

  /** Resolve a path, following symlink hops (mid-path always; final only when `follow`). */
  const lookup = (p: string, follow: boolean): { node?: FakeNode; canonical?: string } => {
    let parts = split(p);
    let walked: string[] = [];
    let cur: FakeNode | undefined = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      if (cur === undefined || cur.type !== "dir") return {};
      const next = cur.children.get(name);
      if (next === undefined) return {};
      if (next.type === "symlink" && (follow || i < parts.length - 1)) {
        parts = split(next.target).concat(parts.slice(i + 1));
        i = -1;
        cur = root;
        walked = [];
        continue;
      }
      if (next.type === "symlink" && !follow) {
        return { node: next, canonical: [...walked, name].join("/") };
      }
      walked.push(name);
      cur = next;
    }
    return { node: cur, canonical: "/" + walked.join("/") };
  };

  /** `/proc/self/fd/<fd>[/rest]` → the canonical path behind the handle. */
  const resolveProcFd = (p: string): string | undefined => {
    const m = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(p);
    if (m === null) return undefined;
    const base = fdPaths.get(Number(m[1]));
    if (base === undefined) return undefined;
    return m[2] === undefined ? base : `${base}/${m[2]}`;
  };

  const fs: FakeFs = {
    openFds,
    closedFds,
    fdPaths,
    statInoOverride,

    node: (at) => {
      let cur: FakeNode | undefined = root;
      for (const p of split(at)) {
        if (cur === undefined || cur.type !== "dir") return undefined;
        cur = cur.children.get(p);
      }
      return cur;
    },

    mkdir: (at) => {
      let cur = root;
      for (const p of split(at)) {
        let next = cur.children.get(p);
        if (next === undefined) {
          next = new FakeNode("dir", inoSeq++, 1);
          cur.children.set(p, next);
        }
        cur = next;
      }
    },

    writeFile: (at, content) => {
      const dir = at.slice(0, at.lastIndexOf("/")) || "/";
      fs.mkdir(dir);
      const parent = fs.node(dir)!;
      const name = at.slice(at.lastIndexOf("/") + 1);
      const n = new FakeNode("file", inoSeq++, 1);
      n.content = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      n.size = n.content.length;
      parent.children.set(name, n);
      return n;
    },

    symlink: (at, target) => {
      const dir = at.slice(0, at.lastIndexOf("/")) || "/";
      fs.mkdir(dir);
      const parent = fs.node(dir)!;
      const n = new FakeNode("symlink", inoSeq++, 1);
      n.target = target;
      n.size = target.length;
      parent.children.set(at.slice(at.lastIndexOf("/") + 1), n);
    },

    replaceDir: (at) => {
      const dir = at.slice(0, at.lastIndexOf("/")) || "/";
      const parent = fs.node(dir)!;
      parent.children.set(at.slice(at.lastIndexOf("/") + 1), new FakeNode("dir", inoSeq++, 1));
    },

    realpath: async (p) => {
      const target = resolveProcFd(p) ?? p;
      const r = lookup(target, true);
      if (r.node === undefined || r.canonical === undefined) throw errOf("ENOENT", target);
      return r.canonical;
    },

    stat: async (p) => {
      const target = resolveProcFd(p) ?? p;
      const r = lookup(target, true);
      if (r.node === undefined) throw errOf("ENOENT", target);
      const st = r.node.stat();
      const ino = statInoOverride.get(target);
      return ino === undefined ? st : { ...st, ino };
    },

    lstat: async (p) => {
      const target = resolveProcFd(p) ?? p;
      const r = lookup(target, false);
      if (r.node === undefined) throw errOf("ENOENT", target);
      const n = r.node;
      return {
        size: n.size,
        mtimeMs: n.ctimeMs,
        isFile: () => n.type === "file",
        isDirectory: () => n.type === "dir",
        isSymbolicLink: () => n.type === "symlink",
      };
    },

    open: async (p, flags) => {
      const target = resolveProcFd(p) ?? p;
      const noFollow = (flags & O_NOFOLLOW) !== 0;
      const r = lookup(target, !noFollow);
      if (r.node === undefined) throw errOf("ENOENT", target);
      if (noFollow && r.node.type === "symlink") throw errOf("ELOOP", target);
      if ((flags & O_DIRECTORY) !== 0 && r.node.type !== "dir") throw errOf("ENOTDIR", target);
      const fd = fdSeq++;
      openFds.add(fd);
      fdPaths.set(fd, r.canonical ?? target);
      const node = r.node;
      return {
        get fd() {
          return fd;
        },
        stat: async () => node.stat(),
        read: async (buf: Buffer, off: number, len: number, pos: number) => {
          const want = Math.min(len, node.content.length - pos);
          if (want > 0) node.content.copy(buf, off, pos, pos + want);
          return { bytesRead: Math.max(0, want) };
        },
        close: async () => {
          if (hangingClose !== null) {
            const release = hangingClose;
            hangingClose = null;
            await new Promise<void>((resolve) => {
              releaseListeners.push(() => {
                openFds.delete(fd);
                closedFds.push(fd);
                resolve();
              });
              release();
            });
            return;
          }
          openFds.delete(fd);
          closedFds.push(fd);
        },
      };
    },

    readlink: async (p) => {
      const viaFd = resolveProcFd(p);
      if (viaFd !== undefined) return viaFd; // the procfs magic symlink → the handle's path
      const r = lookup(p, false);
      if (r.node === undefined || r.node.type !== "symlink") throw errOf("EINVAL", p);
      return r.node.target;
    },

    opendir: async () => {
      throw new Error("not needed by worktree-diff");
    },

    procFdAvailable: () => true,

    leakCount: () => openFds.size,

    hangNextClose: () => {
      // arm: the NEXT close() hangs; the returned fn settles it (and completes the close)
      let settled = false;
      const arm = (): void => {
        hangingClose = (): void => undefined; // armed — close() takes the hanging branch
      };
      arm();
      return (): void => {
        if (settled) return;
        settled = true;
        hangingClose = null;
        for (const fn of releaseListeners.splice(0)) fn();
      };
    },
  };
  return fs;
}

function errOf(code: string, p: string): Error {
  const e = new Error(`${code}: ${p}`) as Error & { code?: string };
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// the standard repo fixture (main worktree + one linked worktree)
// ---------------------------------------------------------------------------

export const REPO = "/w/repo";
export const REPO_GIT = "/w/repo/.git";
export const LINKED = "/w/linked";
export const LINKED_GITDIR = "/w/repo/.git/worktrees/lw";
export const SESSION = "sess-wtd";
export const AGENT = "a-wtdiff";
export const HEAD_SHA1 = "0123456789abcdef0123456789abcdef01234567";

export interface RepoFixture {
  fs: FakeFs;
  runner: ScriptedRunner;
  porcelain: string;
  /** script the admission + head + driver-scan happy path */
  scriptAdmission(opts?: { head?: string; commonDir?: string; list?: string }): void;
}

/**
 * Layout: main worktree `/w/repo` (`.git` dir with an `index` + optional `info/attributes`),
 * one linked worktree `/w/linked` whose `.git` file points at
 * `/w/repo/.git/worktrees/lw` (which exists as a directory).
 */
export function repoFixture(opts: { infoAttrs?: string; linkedGitdir?: string } = {}): RepoFixture {
  const fs = createFakeFs();
  fs.mkdir(REPO);
  fs.mkdir(REPO_GIT);
  fs.mkdir(`${REPO_GIT}/info`);
  fs.writeFile(`${REPO_GIT}/index`, Buffer.from([1, 2, 3]));
  if (opts.infoAttrs !== undefined) fs.writeFile(`${REPO_GIT}/info/attributes`, opts.infoAttrs);
  fs.mkdir(LINKED);
  const linkedGitdir = opts.linkedGitdir ?? LINKED_GITDIR;
  fs.writeFile(`${LINKED}/.git`, `gitdir: ${linkedGitdir}\n`);
  fs.mkdir(LINKED_GITDIR);
  fs.writeFile(`${LINKED_GITDIR}/index`, Buffer.from([9]));

  const porcelain = [
    `worktree ${REPO}`,
    `HEAD ${HEAD_SHA1}`,
    "branch refs/heads/main",
    "",
    `worktree ${LINKED}`,
    `HEAD ${HEAD_SHA1}`,
    "branch refs/heads/feat",
    "",
    "",
  ].join("\n");

  const runner = scriptedRunner();
  return {
    fs,
    runner,
    porcelain,
    scriptAdmission(o = {}) {
      runner.push(
        okRun((o.commonDir ?? REPO_GIT) + "\n"), // C1a
        okRun(o.list ?? porcelain), // C1
        okRun(`sha1\n${o.head ?? HEAD_SHA1}\n`), // C0 (object format line + the oid)
      );
    },
  };
}

/** C2 stdout: `# branch.oid <oid>` + the given `-z` records (NUL-joined, NUL-terminated). */
export function statusV2Z(oid: string, records: string[]): string {
  return [`# branch.oid ${oid}`, ...records].map((r) => `${r}\0`).join("");
}

// ---------------------------------------------------------------------------
// route-level fakes
// ---------------------------------------------------------------------------

export interface SentResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeIo extends PreviewRouteIo {
  sent: SentResponse[];
}

export function fakeIo(listener: "loopback" | "lan" = "loopback"): FakeIo {
  const sent: SentResponse[] = [];
  return {
    listener,
    ip: "127.0.0.1",
    expectedOrigin: "http://127.0.0.1:8080",
    authorize: async () => ({ ip: "127.0.0.1" }),
    sendJson: (_res, status, body, headers = {}) => {
      sent.push({ status, body, headers });
    },
    sent,
  };
}

export function fakeReq(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

export function fakeRes(): ServerResponse {
  const res = {
    headersSent: false,
    writableFinished: true,
    destroyed: false,
    once: () => {},
    destroy() {
      (this as { destroyed: boolean }).destroyed = true;
    },
  };
  return res as unknown as ServerResponse;
}

export function fakeRegistry(cwd: string, agentKey = AGENT, sessionId = SESSION) {
  return {
    get: (k: string) => (k === agentKey ? { session: { sessionId, cwd } } : undefined),
    list: () => [],
  };
}

export function query(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}
