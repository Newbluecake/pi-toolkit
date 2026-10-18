/**
 * Feishu bot credential file + private-file primitives (bot plan §4.4 / §R2-a / §R2-e, package F4).
 * Pi-free (hub boundary): only `node:*` and `../../protocol/*`.
 *
 * `<stateDir>/feishu-bot/credentials.json`, dir 0700, file 0600, ≤4 KiB, atomic replace (tmp +
 * fsync + rename + best-effort dir fsync — the `hub/privacy/store.ts` pattern hardened with
 * `O_EXCL|O_NOFOLLOW` temp creation). Shape (strict — an unknown key is a schema failure):
 * `{v:1, brand, appId, appSecret, ownerOpenId, botOpenId?, createdAt, gen, installSecret}`.
 *
 * Load-time checks (fail closed ⇒ status `unsafe`, `degraded(credentials-unsafe)`, credentials NOT
 * loaded, the file is NEVER auto-overwritten — a `commit()` while unsafe is refused until `reset`
 * removes the file): directory not a symlink/owned by the hub uid/0700-tightened; file `lstat`
 * regular (no symlink), owner = hub uid, `mode & 0o077 === 0`, ≤4 KiB, re-validated on the opened
 * fd (`O_NOFOLLOW`, dev/ino unchanged), schema valid.
 *
 * `gen` (number) is the credentials generation consumed by `token.ts` (`TokenCredentials.gen`) and
 * the upload principal `feishu:<installGen>:<openId>`. It is `max(clock.now(), lastGen + 1)` —
 * strictly increasing inside a process (also across reset/replace), epoch-ms based across
 * restarts, and it is a safe integer.
 *
 * `installSecret` (R2-a request token key, 32 random bytes base64url) lives HERE rather than in
 * state.json (deliberate deviation from §R2-a's wording, per the F4 task text): the credential
 * file is the one place with the type/owner/mode checks, `reset` deletes it (⇒ rotation on reset
 * for free), `replace` mints a new one with the new gen, and `repair` (state-only) keeps it — the
 * token HMAC is recomputable from the frozen request fields either way.
 *
 * Secrets never leave this module except through `current()`/`tokenCredentials()`/`secrets()` to
 * in-process callers: nothing here logs, throws a message containing a secret, or serializes one.
 * All timers/clocks are seams; no module-scope mutable state.
 */
import { createHmac, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";

import {
  FEISHU_CREDENTIALS_MAX_BYTES,
  FEISHU_OPEN_ID_RE,
  FEISHU_REQUEST_TOKEN_LEN,
  isFeishuBrand,
} from "../../protocol/feishu.js";
import type { FeishuBrand } from "../../protocol/feishu.js";
import { systemFeishuClock } from "./http.js";
import type { FeishuClock } from "./http.js";

// ---------------------------------------------------------------------------
// fs seam + private-file primitives (shared with state.ts)
// ---------------------------------------------------------------------------

export interface FsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
  size: number;
  dev: number;
  ino: number;
}
export interface FsReadHandle {
  stat(): Promise<FsStat>;
  read(buf: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface FsWriteHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Narrow fs seam: production = {@link realFeishuFs}; tests wrap it to inject failures (chmod games don't work as root). */
export interface FeishuFs {
  lstat(path: string): Promise<FsStat>;
  /** `mkdir -p` with `mode` */
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` */
  openRead(path: string): Promise<FsReadHandle>;
  /** `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` */
  openWriteExcl(path: string, mode: number): Promise<FsWriteHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** fsync a directory; best effort (callers ignore a rejection) */
  fsyncDir(path: string): Promise<void>;
  getuid(): number | undefined;
}

export const realFeishuFs: FeishuFs = {
  lstat: (p) => fsp.lstat(p),
  mkdir: async (p, mode) => {
    await fsp.mkdir(p, { recursive: true, mode });
  },
  chmod: (p, mode) => fsp.chmod(p, mode),
  openRead: async (p) => {
    const h = await fsp.open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    return {
      stat: () => h.stat(),
      read: (buf, offset, length, position) => h.read(buf, offset, length, position),
      close: () => h.close(),
    };
  },
  openWriteExcl: async (p, mode) => {
    const h = await fsp.open(
      p,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      mode,
    );
    return {
      writeFile: (data) => h.writeFile(data),
      sync: () => h.sync(),
      close: () => h.close(),
    };
  },
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
  fsyncDir: async (p) => {
    const h = await fsp.open(p, "r");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  },
  getuid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
};

export function fsErrCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
}

export type PrivateDirResult = { ok: true } | { ok: false; check: string };

/**
 * `ensurePrivateDir`: create (0700), then `lstat` — must be a real directory (never a symlink)
 * owned by the hub uid; a looser mode on a directory WE own is tightened to 0700 (self-heal), a
 * foreign owner / failed tighten is `unsafe`. Never throws.
 */
export async function ensurePrivateDir(fs: FeishuFs, dir: string): Promise<PrivateDirResult> {
  try {
    await fs.mkdir(dir, 0o700);
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink()) return { ok: false, check: "directory-symlink" };
    if (!st.isDirectory()) return { ok: false, check: "directory-not-directory" };
    const uid = fs.getuid();
    if (uid !== undefined && st.uid !== uid) return { ok: false, check: "directory-owner" };
    if ((st.mode & 0o077) !== 0) {
      await fs.chmod(dir, 0o700);
      const again = await fs.lstat(dir);
      if ((again.mode & 0o077) !== 0) return { ok: false, check: "directory-mode" };
    }
    return { ok: true };
  } catch {
    return { ok: false, check: "directory-io" };
  }
}

export type PrivateReadResult =
  { kind: "absent" } | { kind: "ok"; bytes: Uint8Array } | { kind: "unsafe"; check: string };

function checkFileStat(st: FsStat, uid: number | undefined, maxBytes: number): string | undefined {
  if (st.isSymbolicLink()) return "file-symlink";
  if (!st.isFile()) return "file-not-regular";
  if (uid !== undefined && st.uid !== uid) return "file-owner";
  if ((st.mode & 0o077) !== 0) return "file-mode";
  if (st.size > maxBytes) return "file-size";
  return undefined;
}

/**
 * Read a private regular file: `lstat` checks (no symlink / regular / owner / mode / size), then
 * the same checks again on the `O_NOFOLLOW` fd plus dev/ino identity against the `lstat`. Never
 * throws; a missing file is `absent` (the normal first-run state), anything else odd is `unsafe`
 * with a static `check` name.
 */
export async function readPrivateFile(fs: FeishuFs, path: string, maxBytes: number): Promise<PrivateReadResult> {
  const uid = fs.getuid();
  let before: FsStat;
  try {
    before = await fs.lstat(path);
  } catch (err) {
    return fsErrCode(err) === "ENOENT" ? { kind: "absent" } : { kind: "unsafe", check: "read-failed" };
  }
  const bad = checkFileStat(before, uid, maxBytes);
  if (bad !== undefined) return { kind: "unsafe", check: bad };
  let handle: FsReadHandle;
  try {
    handle = await fs.openRead(path);
  } catch (err) {
    return fsErrCode(err) === "ENOENT" ? { kind: "absent" } : { kind: "unsafe", check: "read-failed" };
  }
  try {
    const st = await handle.stat();
    const bad2 = checkFileStat(st, uid, maxBytes);
    if (bad2 !== undefined) return { kind: "unsafe", check: bad2 };
    if (st.dev !== before.dev || st.ino !== before.ino) return { kind: "unsafe", check: "file-identity-changed" };
    const buffer = new Uint8Array(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead <= 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { kind: "unsafe", check: "file-size" };
    return { kind: "ok", bytes: buffer.slice(0, total) };
  } catch {
    return { kind: "unsafe", check: "read-failed" };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Atomic private replace: `<path>.tmp` (stale one unlinked first, then `O_EXCL|O_NOFOLLOW` 0600) →
 * write → fsync → close → optional `guard()` (evaluated synchronously right before the rename —
 * the commit point; `false` ⇒ tmp removed, nothing replaced, returns `"guarded"`) → rename →
 * best-effort directory fsync. Any I/O failure cleans the tmp file and rethrows (the caller maps
 * it to `persist-failed`/`write-failed`); the previous file is intact in every failure case.
 */
export async function writeFileAtomicPrivate(
  fs: FeishuFs,
  path: string,
  bytes: Uint8Array,
  guard?: () => boolean,
): Promise<"written" | "guarded"> {
  const tmp = `${path}.tmp`;
  try {
    await fs.unlink(tmp);
  } catch (err) {
    if (fsErrCode(err) !== "ENOENT") throw err;
  }
  let handle: FsWriteHandle | undefined;
  try {
    handle = await fs.openWriteExcl(tmp, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (guard !== undefined && !guard()) {
      await fs.unlink(tmp).catch(() => {});
      return "guarded";
    }
    await fs.rename(tmp, path);
  } catch (err) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  try {
    await fs.fsyncDir(join(path, ".."));
  } catch {
    /* best effort — the rename already landed */
  }
  return "written";
}

// ---------------------------------------------------------------------------
// credential model + validation
// ---------------------------------------------------------------------------

export const FEISHU_CREDENTIALS_FILE = "credentials.json";
/** installSecret = 32 random bytes, base64url without padding. */
export const FEISHU_INSTALL_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
export const FEISHU_APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,64}$/;
export const FEISHU_APP_SECRET_RE = /^[\x21-\x7e]{1,512}$/;

export interface FeishuCredentials {
  v: 1;
  brand: FeishuBrand;
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  botOpenId?: string;
  /** ISO-8601 */
  createdAt: string;
  /** credentials generation (see module doc) */
  gen: number;
  installSecret: string;
}

/** What setup hands to {@link CredentialStore.commit}; gen/installSecret/createdAt are minted by the store. */
export interface CredentialInput {
  brand: FeishuBrand;
  appId: string;
  appSecret: string;
  ownerOpenId: string;
  botOpenId?: string;
}

const CREDENTIAL_KEYS = new Set([
  "v",
  "brand",
  "appId",
  "appSecret",
  "ownerOpenId",
  "botOpenId",
  "createdAt",
  "gen",
  "installSecret",
]);

/** Strict structural validation; `undefined` on any deviation (never throws). */
export function parseCredentials(raw: unknown): FeishuCredentials | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!CREDENTIAL_KEYS.has(key)) return undefined;
  if (r["v"] !== 1) return undefined;
  const brand = r["brand"];
  if (!isFeishuBrand(brand)) return undefined;
  const appId = r["appId"];
  const appSecret = r["appSecret"];
  const ownerOpenId = r["ownerOpenId"];
  const botOpenId = r["botOpenId"];
  const createdAt = r["createdAt"];
  const gen = r["gen"];
  const installSecret = r["installSecret"];
  if (typeof appId !== "string" || !FEISHU_APP_ID_RE.test(appId)) return undefined;
  if (typeof appSecret !== "string" || !FEISHU_APP_SECRET_RE.test(appSecret)) return undefined;
  if (typeof ownerOpenId !== "string" || !FEISHU_OPEN_ID_RE.test(ownerOpenId)) return undefined;
  if (botOpenId !== undefined && (typeof botOpenId !== "string" || !FEISHU_OPEN_ID_RE.test(botOpenId)))
    return undefined;
  if (typeof createdAt !== "string" || createdAt.length === 0 || createdAt.length > 40) return undefined;
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen <= 0) return undefined;
  if (typeof installSecret !== "string" || !FEISHU_INSTALL_SECRET_RE.test(installSecret)) return undefined;
  const out: FeishuCredentials = { v: 1, brand, appId, appSecret, ownerOpenId, createdAt, gen, installSecret };
  if (botOpenId !== undefined) out.botOpenId = botOpenId;
  return out;
}

/** Validate a {@link CredentialInput} (the registration output / tests). */
export function validateCredentialInput(input: unknown): input is CredentialInput {
  if (input === null || typeof input !== "object") return false;
  const r = input as Record<string, unknown>;
  const brand = r["brand"];
  const appId = r["appId"];
  const appSecret = r["appSecret"];
  const owner = r["ownerOpenId"];
  const bot = r["botOpenId"];
  return (
    isFeishuBrand(brand) &&
    typeof appId === "string" &&
    FEISHU_APP_ID_RE.test(appId) &&
    typeof appSecret === "string" &&
    FEISHU_APP_SECRET_RE.test(appSecret) &&
    typeof owner === "string" &&
    FEISHU_OPEN_ID_RE.test(owner) &&
    (bot === undefined || (typeof bot === "string" && FEISHU_OPEN_ID_RE.test(bot)))
  );
}

/**
 * §R2-a request token: `b64url(HMAC-SHA256(installSecret, cmdId))[0:12]`. Lives here (not in the
 * `node:*`-free protocol module) so F6 and the tests share ONE definition of the algorithm.
 */
export function computeRequestToken(installSecret: string, cmdId: string): string {
  return createHmac("sha256", installSecret).update(cmdId).digest("base64url").slice(0, FEISHU_REQUEST_TOKEN_LEN);
}

// ---------------------------------------------------------------------------
// credential store
// ---------------------------------------------------------------------------

export type CredentialStatus = "unloaded" | "absent" | "loaded" | "unsafe";

export type CredentialLoad =
  { kind: "absent" } | { kind: "loaded"; credentials: FeishuCredentials } | { kind: "unsafe"; check: string };

export type CommitResult =
  | { ok: true; credentials: FeishuCredentials }
  | { ok: false; reason: "guard" | "unsafe" | "invalid" | "dir" | "write-failed" };

export interface CredentialStoreDeps {
  /** `<stateDir>/feishu-bot` (created 0700 on first commit; never created by `load`). */
  dir: string;
  fs?: FeishuFs;
  clock?: FeishuClock;
  /** crypto-random bytes seam (tests only) */
  random?: (n: number) => Uint8Array;
}

export interface CredentialStore {
  readonly path: string;
  /** Read + validate the file. Idempotent; never throws; never writes. */
  load(): Promise<CredentialLoad>;
  status(): CredentialStatus;
  /** Name of the failed check while `status() === "unsafe"` (static string, no path). */
  unsafeCheck(): string | undefined;
  /** In-memory credentials (a defensive copy); `undefined` unless `status() === "loaded"`. */
  current(): FeishuCredentials | undefined;
  /** `createTokenManager({credentials})` provider shape. */
  tokenCredentials(): { appId: string; appSecret: string; gen: number } | undefined;
  /** Literals to redact (`createFeishuHttp({secrets})`): the app secret. */
  secrets(): string[];
  /**
   * Atomically install new credentials (setup success / `--replace`). Mints `gen`, `installSecret`,
   * `createdAt`. Serialized with every other mutation. `guard` is evaluated synchronously right
   * before the rename (setup passes its `setupGen` recheck): `false` ⇒ `{reason:"guard"}`, nothing
   * written. Refused while `unsafe` (reset first). Memory changes only after the write landed.
   */
  commit(input: CredentialInput, opts?: { guard?: () => boolean }): Promise<CommitResult>;
  /** Record the bot's own open_id (from `botInfo`) — only if `gen` is still the loaded generation. */
  setBotOpenId(gen: number, botOpenId: string): Promise<boolean>;
  /** `reset`: delete the credential file by exact path (works on an unsafe file too — a symlink is unlinked, never followed). */
  remove(): Promise<{ ok: true } | { ok: false; reason: "write-failed" }>;
}

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  const fs = deps.fs ?? realFeishuFs;
  const clock = deps.clock ?? systemFeishuClock;
  const random = deps.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const path = join(deps.dir, FEISHU_CREDENTIALS_FILE);

  let status: CredentialStatus = "unloaded";
  let unsafeCheck: string | undefined;
  let credentials: FeishuCredentials | undefined;
  let lastGen = 0;
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function adopt(c: FeishuCredentials | undefined, check?: string): void {
    credentials = c;
    if (c !== undefined) {
      status = "loaded";
      unsafeCheck = undefined;
      lastGen = Math.max(lastGen, c.gen);
    } else if (check !== undefined) {
      status = "unsafe";
      unsafeCheck = check;
    } else {
      status = "absent";
      unsafeCheck = undefined;
    }
  }

  /** Directory checks on load WITHOUT creating it: a missing directory is simply "absent". */
  async function dirProblem(): Promise<string | undefined> {
    let st: FsStat;
    try {
      st = await fs.lstat(deps.dir);
    } catch (err) {
      return fsErrCode(err) === "ENOENT" ? undefined : "directory-io";
    }
    if (st.isSymbolicLink()) return "directory-symlink";
    if (!st.isDirectory()) return "directory-not-directory";
    const uid = fs.getuid();
    if (uid !== undefined && st.uid !== uid) return "directory-owner";
    if ((st.mode & 0o077) !== 0) {
      const res = await ensurePrivateDir(fs, deps.dir);
      if (!res.ok) return res.check;
    }
    return undefined;
  }

  async function doLoad(): Promise<CredentialLoad> {
    const dir = await dirProblem();
    if (dir !== undefined) {
      adopt(undefined, dir);
      return { kind: "unsafe", check: dir };
    }
    const res = await readPrivateFile(fs, path, FEISHU_CREDENTIALS_MAX_BYTES);
    if (res.kind === "absent") {
      adopt(undefined);
      return { kind: "absent" };
    }
    if (res.kind === "unsafe") {
      adopt(undefined, res.check);
      return { kind: "unsafe", check: res.check };
    }
    let parsed: FeishuCredentials | undefined;
    try {
      parsed = parseCredentials(JSON.parse(new TextDecoder().decode(res.bytes)));
    } catch {
      adopt(undefined, "file-json");
      return { kind: "unsafe", check: "file-json" };
    }
    if (parsed === undefined) {
      adopt(undefined, "file-schema");
      return { kind: "unsafe", check: "file-schema" };
    }
    adopt(parsed);
    return { kind: "loaded", credentials: { ...parsed } };
  }

  function mintGen(): number {
    const next = Math.max(Math.floor(clock.now()), lastGen + 1);
    lastGen = next;
    return next;
  }

  async function persist(next: FeishuCredentials, guard?: () => boolean): Promise<"written" | "guarded"> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(next)}\n`);
    if (bytes.length > FEISHU_CREDENTIALS_MAX_BYTES) throw new Error("credentials-too-large");
    return writeFileAtomicPrivate(fs, path, bytes, guard);
  }

  return {
    path,
    load: () => enqueue(doLoad),
    status: () => status,
    unsafeCheck: () => unsafeCheck,
    current: () => (credentials === undefined ? undefined : { ...credentials }),
    tokenCredentials: () =>
      credentials === undefined
        ? undefined
        : { appId: credentials.appId, appSecret: credentials.appSecret, gen: credentials.gen },
    secrets: () => (credentials === undefined ? [] : [credentials.appSecret]),
    commit: (input, opts) =>
      enqueue(async (): Promise<CommitResult> => {
        if (!validateCredentialInput(input)) return { ok: false, reason: "invalid" };
        if (status === "unloaded") await doLoad();
        if (status === "unsafe") return { ok: false, reason: "unsafe" };
        const dir = await ensurePrivateDir(fs, deps.dir);
        if (!dir.ok) return { ok: false, reason: "dir" };
        if (opts?.guard !== undefined && !opts.guard()) return { ok: false, reason: "guard" };
        const next: FeishuCredentials = {
          v: 1,
          brand: input.brand,
          appId: input.appId,
          appSecret: input.appSecret,
          ownerOpenId: input.ownerOpenId,
          createdAt: new Date(clock.now()).toISOString(),
          gen: mintGen(),
          installSecret: Buffer.from(random(32)).toString("base64url"),
        };
        if (input.botOpenId !== undefined) next.botOpenId = input.botOpenId;
        try {
          const outcome = await persist(next, opts?.guard);
          if (outcome === "guarded") return { ok: false, reason: "guard" };
        } catch {
          return { ok: false, reason: "write-failed" };
        }
        adopt(next);
        return { ok: true, credentials: { ...next } };
      }),
    setBotOpenId: (gen, botOpenId) =>
      enqueue(async () => {
        if (credentials === undefined || credentials.gen !== gen) return false;
        if (!FEISHU_OPEN_ID_RE.test(botOpenId)) return false;
        const next: FeishuCredentials = { ...credentials, botOpenId };
        try {
          const outcome = await persist(next, () => credentials !== undefined && credentials.gen === gen);
          if (outcome === "guarded") return false;
        } catch {
          return false;
        }
        credentials = next;
        return true;
      }),
    remove: () =>
      enqueue(async () => {
        try {
          await fs.unlink(path);
        } catch (err) {
          if (fsErrCode(err) !== "ENOENT") return { ok: false as const, reason: "write-failed" as const };
        }
        try {
          await fs.unlink(`${path}.tmp`);
        } catch {
          /* best effort */
        }
        adopt(undefined);
        return { ok: true as const };
      }),
  };
}
