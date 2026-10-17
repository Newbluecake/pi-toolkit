/** Permanent target↔origin bindings (§3.3). Injected fs/clock, bounded single-flight transactions.
 * A timeout latches broken and fences EVERY later step, including late IO completions. The physical
 * operation keeps its slot until settle; no retry/automatic reset/rewriting of a corrupt file.
 */
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PROXY_MAX_PROXIES_MAX,
  PROXY_PORT_BIND_ATTEMPTS,
  PROXY_PORTS_FILE_NAME,
  PROXY_PORTS_FILE_VERSION,
  PROXY_STATE_DIR_NAME,
  parseProxyPortRange,
} from "../../protocol/proxy.js";
import { canonicalAddr, classifyProxyAddr, parseProxyTarget } from "./target.js";
import { systemProxyTimer, type ProxyTimerPort } from "./dns-gate.js";

// Deliberately internal, NOT frozen X0 values (X0-report decision 2).
const LOAD_MAX_BYTES = 64 * 1024;
const LOAD_MS = 1_000;
const WRITE_MS = 2_000;
export interface ProxyPortsHandle {
  stat(): Promise<{ size: number; isFile(): boolean }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  chmod(mode: number): Promise<void>;
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface ProxyPortsFs {
  open(path: string, flags: number, mode?: number): Promise<ProxyPortsHandle>;
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
export interface ProxyPortEntry {
  readonly key: string;
  readonly port: number;
  readonly boundAt: number;
}
export interface ProxyPortsMapDeps {
  readonly stateDir: string;
  readonly range: readonly [number, number];
  readonly fs: ProxyPortsFs;
  now(): number;
  readonly timer?: ProxyTimerPort;
  readonly tempId?: () => string;
  readonly budgets?: { readonly loadMs?: number; readonly writeMs?: number; readonly maxBytes?: number };
}
export type ProxyPortFailure = { ok: false; reason: "ports-store" | "ports-exhausted" | "port-busy" };
export type ProxyPortBinding<T> = { ok: true; port: number; value: T; reused: boolean } | ProxyPortFailure;
export interface ProxyBoundListener<T> {
  readonly value: T;
  close(): unknown;
}
export interface ProxyPortsMap {
  /** Runtime reservations only; permanent bindings are never released. */
  readonly reserved: number;
  /** Idempotent; ENOENT alone means empty. Never creates a file. */
  load(): Promise<boolean>;
  status(): "loading" | "ok" | "broken";
  entries(): readonly ProxyPortEntry[];
  /** Listen first; commit+fsync BEFORE returning any listener to a code-issuing caller.
   * listen must be caller-deadline-bounded (X1b); a late listener is closed here too.
   * No unbounded queue: at most the frozen global instance ceiling can enter this lane.
   */
  bind<T>(key: string, listen: (port: number) => Promise<ProxyBoundListener<T>>): Promise<ProxyPortBinding<T>>;
}
function errno(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
}
function validKey(key: string): boolean {
  const parts = key.split("|");
  if (parts.length !== 3) return false;
  const [ip = "", port = "", host = ""] = parts;
  const address = canonicalAddr(ip);
  if (
    address === undefined ||
    address.key !== ip ||
    !classifyProxyAddr(address).ok ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    Number(port) > 65535
  )
    return false;
  const target = parseProxyTarget(
    `${host}${host.startsWith("[") ? (host.endsWith("]") ? ":80" : "") : host.includes(":") ? "" : ":80"}`,
  );
  return (
    target.ok &&
    target.target.port === Number(port) &&
    target.target.hostHeader === host &&
    target.target.nextPath === "/"
  );
}
/** JSON.parse alone silently overwrites duplicate keys. Scan valid JSON tokens as well, comparing
 * decoded property names per object (so "v" and "\\u0076" collide). Strings cannot smuggle braces.
 */
function duplicateJsonKeys(text: string): boolean {
  const stack: Array<Set<string> | undefined> = [];
  for (const m of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const token = m[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(undefined);
    else if (token === "}" || token === "]") stack.pop();
    else {
      let i = m.index! + token.length;
      while (/[\t\n\r ]/.test(text[i] ?? "x")) i += 1;
      if (text[i] !== ":") continue;
      const keys = stack[stack.length - 1];
      const key: string = JSON.parse(token);
      if (keys?.has(key)) return true;
      keys?.add(key);
    }
  }
  return false;
}

/** Strict v1 schema; BOM, duplicate JSON keys/targets/ports, unknown fields and range changes fail closed. */
export function parseProxyPortsFile(
  text: string,
  range: readonly [number, number],
): readonly ProxyPortEntry[] | undefined {
  try {
    if (text.charCodeAt(0) === 0xfeff) return undefined;
    const obj: unknown = JSON.parse(text);
    if (duplicateJsonKeys(text)) return undefined;
    if (
      !plain(obj) ||
      !exact(obj, ["v", "entries"]) ||
      obj.v !== PROXY_PORTS_FILE_VERSION ||
      !Array.isArray(obj.entries) ||
      obj.entries.length > range[1] - range[0] + 1
    )
      return undefined;
    const ports = new Set<number>();
    const keys = new Set<string>();
    const entries: ProxyPortEntry[] = [];
    for (const e of obj.entries) {
      if (
        !plain(e) ||
        !exact(e, ["key", "port", "boundAt"]) ||
        typeof e.key !== "string" ||
        !validKey(e.key) ||
        typeof e.port !== "number" ||
        !Number.isInteger(e.port) ||
        e.port < range[0] ||
        e.port > range[1] ||
        typeof e.boundAt !== "number" ||
        !Number.isSafeInteger(e.boundAt) ||
        e.boundAt < 0 ||
        ports.has(e.port) ||
        keys.has(e.key)
      )
        return undefined;
      ports.add(e.port);
      keys.add(e.key);
      entries.push(Object.freeze({ key: e.key, port: e.port, boundAt: e.boundAt }));
    }
    return entries;
  } catch {
    return undefined;
  }
}
export function createProxyPortsMap(deps: ProxyPortsMapDeps): ProxyPortsMap {
  const timer = deps.timer ?? systemProxyTimer;
  const fs = deps.fs;
  const directory = join(deps.stateDir, PROXY_STATE_DIR_NAME);
  const file = join(directory, PROXY_PORTS_FILE_NAME);
  const maxBytes = Math.min(LOAD_MAX_BYTES, deps.budgets?.maxBytes ?? LOAD_MAX_BYTES);
  let state: "loading" | "ok" | "broken" = "loading";
  let bindings: readonly ProxyPortEntry[] = [];
  let loaded: Promise<boolean> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const reserved = new Set<number>();
  const opening = new Set<string>();
  const check = (): void => {
    if (state === "broken") throw new Error("ports-store");
  };
  const close = async (h: ProxyPortsHandle): Promise<void> => {
    await h.close();
  };
  // Only the caller race times out. Underlying work and cleanup remain serialized; no slot reuse.
  const bounded = <T>(ms: number, op: () => Promise<T>, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      let done = false;
      const cancel = timer.after(ms, () => {
        if (!done) {
          done = true;
          state = "broken";
          resolve(fallback);
        }
      });
      Promise.resolve()
        .then(op)
        .then(
          (v) => {
            if (!done) {
              done = true;
              cancel();
              resolve(v);
            }
          },
          () => {
            state = "broken";
            if (!done) {
              done = true;
              cancel();
              resolve(fallback);
            }
          },
        );
    });
  const load = (): Promise<boolean> => {
    if (loaded !== undefined) return loaded;
    loaded = bounded(
      deps.budgets?.loadMs ?? LOAD_MS,
      async () => {
        if (parseProxyPortRange(`${deps.range[0]}-${deps.range[1]}`) === undefined) throw new Error("ports-store");
        // A no-follow file open alone would still traverse a symlinked proxy/ directory.
        // Inspect that directory before reading any binding, even if ports.json is absent.
        let directoryHandle: ProxyPortsHandle;
        try {
          directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        } catch (err) {
          check();
          if (errno(err) === "ENOENT") {
            state = "ok";
            return true;
          }
          throw err;
        }
        try {
          check();
        } finally {
          await close(directoryHandle);
        }
        check();
        let h: ProxyPortsHandle;
        try {
          h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch (err) {
          check();
          if (errno(err) === "ENOENT") {
            state = "ok";
            return true;
          }
          throw err;
        }
        try {
          check();
          const st = await h.stat();
          check();
          if (!st.isFile() || !Number.isSafeInteger(st.size) || st.size < 0 || st.size > maxBytes)
            throw new Error("ports-store");
          const buffer = Buffer.alloc(maxBytes + 1);
          let size = 0;
          for (;;) {
            const { bytesRead } = await h.read(buffer, size, buffer.length - size, size);
            check();
            if (bytesRead === 0) break;
            if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - size)
              throw new Error("ports-store");
            size += bytesRead;
            if (size > maxBytes) throw new Error("ports-store");
          }
          const entries = parseProxyPortsFile(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)),
            deps.range,
          );
          if (entries === undefined) throw new Error("ports-store");
          bindings = entries;
        } finally {
          await close(h);
        }
        check();
        state = "ok";
        return true;
      },
      false,
    );
    return loaded;
  };
  const persist = async (text: string): Promise<void> => {
    check();
    const id = (deps.tempId ?? randomUUID)();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("ports-store");
    const temp = join(directory, `.${PROXY_PORTS_FILE_NAME}.${id}.tmp`);
    let h: ProxyPortsHandle | undefined;
    let dir: ProxyPortsHandle | undefined;
    let renamed = false;
    let owned = false;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      check();
      // Refuse a symlink inserted since load BEFORE opening/writing any temporary file.
      dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      check();
      h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = true;
      check();
      await h.chmod(0o600);
      check();
      await h.writeFile(text);
      check();
      await h.sync();
      check();
      await close(h);
      h = undefined;
      check();
      await fs.rename(temp, file);
      renamed = true;
      check();
      await dir.sync();
      check();
      await close(dir);
      dir = undefined;
      check();
    } finally {
      // Late opens are always owned. A failed cleanup is not retried and latches broken as well.
      try {
        if (h !== undefined) await close(h);
      } finally {
        try {
          if (dir !== undefined) await close(dir);
        } finally {
          if (owned && !renamed) {
            try {
              await fs.unlink(temp);
            } catch {
              /* never touch the committed file */
            }
          }
        }
      }
    }
  };
  return {
    load,
    status: () => state,
    entries: () => [...bindings],
    get reserved() {
      return reserved.size;
    },
    async bind<T>(key: string, listen: (port: number) => Promise<ProxyBoundListener<T>>): Promise<ProxyPortBinding<T>> {
      const failed: ProxyPortFailure = { ok: false, reason: "ports-store" };
      if (!(await load()) || state === "broken" || !validKey(key)) return failed;
      if (opening.has(key) || opening.size >= PROXY_MAX_PROXIES_MAX) return { ok: false, reason: "port-busy" };
      opening.add(key);
      let heldPort: number | undefined;
      let lease: ProxyBoundListener<T> | undefined;
      let success = false;
      try {
        const known = bindings.find((e) => e.key === key);
        let attempts = 0;
        for (let port = known?.port ?? deps.range[0]; port <= (known?.port ?? deps.range[1]); port += 1) {
          check();
          if (reserved.has(port) || (known === undefined && bindings.some((e) => e.port === port))) continue;
          if (attempts >= PROXY_PORT_BIND_ATTEMPTS) return { ok: false, reason: "port-busy" };
          attempts += 1;
          reserved.add(port);
          heldPort = port;
          try {
            lease = await listen(port);
          } catch (err) {
            reserved.delete(port);
            heldPort = undefined;
            check();
            if (known === undefined && errno(err) === "EADDRINUSE") continue;
            return { ok: false, reason: "port-busy" };
          }
          check();
          if (known === undefined) {
            if (pending >= PROXY_MAX_PROXIES_MAX) return { ok: false, reason: "port-busy" };
            pending += 1;
            const entry = Object.freeze({ key, port, boundAt: deps.now() });
            const real = tail.then(async () => {
              try {
                check();
                if (!Number.isSafeInteger(entry.boundAt) || entry.boundAt < 0) throw new Error("ports-store");
                const next = [...bindings, entry];
                const text = JSON.stringify({ v: PROXY_PORTS_FILE_VERSION, entries: next });
                // Pure serialization capacity is a refusal of THIS bind, not damaged storage.
                // Return normally so both the write lane and its caller keep the store usable.
                if (Buffer.byteLength(text) > maxBytes) return false;
                await persist(text);
                check();
                bindings = next;
                return true;
              } catch (err) {
                // Latch BEFORE releasing the real tail: a queued writer must never start
                // between this failure and the caller race's rejection handler.
                state = "broken";
                throw err;
              }
            });
            // Real physical work owns the lane, NOT the caller's timeout race.
            tail = real
              .then(
                () => undefined,
                () => undefined,
              )
              .finally(() => {
                pending -= 1;
              });
            const committed = await bounded(deps.budgets?.writeMs ?? WRITE_MS, () => real, false);
            if (!committed) return failed;
          }
          check();
          success = true;
          return { ok: true, port, value: lease.value, reused: known !== undefined };
        }
        return {
          ok: false,
          reason: bindings.length === deps.range[1] - deps.range[0] + 1 ? "ports-exhausted" : "port-busy",
        };
      } catch {
        state = "broken";
        return failed;
      } finally {
        opening.delete(key);
        if (heldPort !== undefined) reserved.delete(heldPort);
        if (!success && lease !== undefined) {
          try {
            void Promise.resolve(lease.close()).catch(() => {});
          } catch {
            /* engine owns close deadline; never expose this listener to a code issuer */
          }
        }
      }
    },
  };
}
