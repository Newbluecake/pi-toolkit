/**
 * jev-reflex · #25 B4 shared test helpers for the draft loader / wire / command suites:
 *  - `tmpAgent()`: a throw-away `<agentDir>/reflex/drafts` pair with the trusted modes (0700);
 *  - `fakeDraftFs()`: a fully scripted `DraftFs` (call recording + hang hooks) for race / budget tests;
 *  - `queueDraft()`: a valid draft whose vocabulary the BUILTIN catalog never matches (so it is
 *    only reachable through the draft layer — builtin hits would short-circuit it, K2).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftDirLike, DraftFileHandleLike, DraftFs, DraftStatLike } from "../../../src/reflex/drafts/load.js";
import type { PortId, RScriptV1 } from "../../../src/reflex/core/types.js";
import { makeDraft } from "../helpers/turn.js";

export interface TmpAgent {
  root: string;
  reflexDir: string;
  draftsDir: string;
  /** Write `<draftsDir>/<name>` (object ⇒ JSON) with `mode` (default 0600). */
  write(name: string, body: unknown, mode?: number): string;
  cleanup(): void;
}

export function tmpAgent(): TmpAgent {
  const root = mkdtempSync(join(tmpdir(), "reflex-drafts-"));
  const reflexDir = join(root, "reflex");
  const draftsDir = join(reflexDir, "drafts");
  mkdirSync(draftsDir, { recursive: true });
  chmodSync(reflexDir, 0o700);
  chmodSync(draftsDir, 0o700);
  return {
    root,
    reflexDir,
    draftsDir,
    write(name, body, mode = 0o600) {
      const path = join(draftsDir, name);
      writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
      chmodSync(path, mode);
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Draft ids are `draft.[a-z0-9-]+`; the queue vocabulary below never touches a builtin template. */
const QUEUE_HITS = ["队列还剩多少活", "队列里还剩多少活", "队列现在还剩多少活", "当前队列还剩多少活", "队列还有多少活"];
const QUEUE_MISSES = ["帮我清空队列", "把队列停掉", "今天天气怎么样", "队列的日志在哪", "谢谢你"];

/** A valid draft on `port` answering the "queue" sentences (works for any MVP port: defaults follow the port). */
export function queueDraft(id = "draft.queue", port: PortId = "jobs.list", over: Partial<RScriptV1> = {}): RScriptV1 {
  return makeDraft({
    id,
    port: { id: port },
    intent: {
      strong: [...QUEUE_HITS],
      weak: ["队列"],
      exclude: ["清空", "停掉"],
      examples: { hit: [...QUEUE_HITS], miss: [...QUEUE_MISSES] },
    },
    ...over,
  });
}
export const QUEUE_Q = QUEUE_HITS[0]!;
export const QUEUE_Q2 = QUEUE_HITS[1]!;

// ---------------------------------------------------------------------------------------------

export interface FakeFsOptions {
  /** name → file body. The directory listing is the key order (plus `extraNames`). */
  files?: Record<string, string>;
  extraNames?: readonly string[];
  uid?: number;
  /** Awaited before `open(name)` resolves — return a never-settling promise to hang it. */
  openHook?: (name: string, n: number) => Promise<void> | void;
  /** Awaited inside `read`. */
  readHook?: (name: string) => Promise<void> | void;
}

export interface FakeFsCalls {
  lstat: string[];
  opendir: number;
  next: number;
  open: string[];
  flags: number[];
  closed: number;
  openedHandles: number;
  dirClosed: number;
}

export function fakeDraftFs(opts: FakeFsOptions = {}): { fs: DraftFs; calls: FakeFsCalls } {
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const files = opts.files ?? {};
  const names = [...Object.keys(files), ...(opts.extraNames ?? [])];
  const calls: FakeFsCalls = {
    lstat: [],
    opendir: 0,
    next: 0,
    open: [],
    flags: [],
    closed: 0,
    openedHandles: 0,
    dirClosed: 0,
  };
  const dirStat = (ino: number): DraftStatLike => ({
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid,
    gid: uid,
    mode: 0o040700,
    size: 4096,
    dev: 1,
    ino,
  });
  const fileStat = (size: number, ino: number): DraftStatLike => ({
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    uid,
    gid: uid,
    mode: 0o100600,
    size,
    dev: 1,
    ino,
  });
  const fs: DraftFs = {
    async lstat(path) {
      calls.lstat.push(path);
      return dirStat(path.endsWith("drafts") ? 11 : 10);
    },
    async opendir() {
      calls.opendir += 1;
      let i = 0;
      const dir: DraftDirLike = {
        async close() {
          calls.dirClosed += 1;
        },
        [Symbol.asyncIterator]() {
          return {
            async next() {
              calls.next += 1;
              const name = names[i++];
              return name === undefined
                ? { done: true as const, value: undefined }
                : { done: false as const, value: { name } };
            },
          };
        },
      };
      return dir;
    },
    async open(path, flags) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      calls.open.push(name);
      calls.flags.push(flags);
      await opts.openHook?.(name, calls.open.length);
      calls.openedHandles += 1;
      const body = Buffer.from(files[name] ?? "");
      const handle: DraftFileHandleLike = {
        async stat() {
          return fileStat(body.length, 100 + calls.openedHandles);
        },
        async read(buffer, position, length) {
          await opts.readHook?.(name);
          const from = position ?? 0;
          const n = Math.max(0, Math.min(length, body.length - from, buffer.length));
          body.copy(buffer, 0, from, from + n);
          return { bytesRead: n };
        },
        async close() {
          calls.closed += 1;
        },
      };
      return handle;
    },
  };
  return { fs, calls };
}

/** Never-settling promise (hang injection). */
export const hang = (): Promise<void> => new Promise<void>(() => undefined);
