import { createHash } from "node:crypto";
import {
  AVATAR_CLOSE_WAIT_MS,
  AVATAR_DELETE_STEP_CAPS,
  AVATAR_MAX_BYTES,
  AVATAR_PENDING_CEILING_MS,
  AVATAR_PUT_STEP_CAPS,
  AVATAR_STORE_MIN_MS,
  type AvatarInfo,
  type AvatarRejectReason,
} from "../../protocol/avatar.js";
import {
  avatarFilePath,
  avatarTempPath,
  createAvatarFs,
  type AvatarDirIdentity,
  type AvatarFs,
  type AvatarHandle,
} from "./fs.js";
import { validateAvatar } from "./validate.js";
import { PreviewIoError, racePreviewIo } from "../preview/fs.js";
import type { ReqDeadline } from "../req-deadline.js";

export type AvatarStoreState = "loading" | "ready" | "writing" | "pending" | "disabled" | "closing";
export type AvatarStoreDisabledReason = "dir" | "dir-swapped" | "zombie" | "load-io";

export interface AvatarMemory {
  readonly bytes: Uint8Array;
  readonly v: string;
  readonly side: number;
}
export interface AvatarStoreSnapshot {
  readonly state: AvatarStoreState;
  readonly memory: AvatarMemory | undefined;
  readonly info: AvatarInfo | undefined;
  readonly disabledReason?: AvatarStoreDisabledReason;
}
export interface AvatarStoreChange {
  readonly info: AvatarInfo;
  readonly memory: AvatarMemory | undefined;
  readonly op: "load" | "put" | "delete" | "reconcile";
}

export class AvatarStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "AvatarStoreError";
  }
}

export interface AvatarStoreDeps {
  stateDir: string;
  fs?: AvatarFs;
  now?: () => number;
  getuid?: () => number;
  validate?: (bytes: Uint8Array) => { ok: true; side: number } | { ok: false; reason: AvatarRejectReason };
  onChange?: (change: AvatarStoreChange) => void;
  audit?: (record: Record<string, unknown>) => void;
  log?: { warn(msg: string, data?: object): void; error(msg: string, data?: object): void };
}

export interface AvatarStore {
  readonly state: AvatarStoreState;
  readonly gen: number;
  readonly disabledReason: AvatarStoreDisabledReason | undefined;
  load(): Promise<void>;
  snapshot(): AvatarStoreSnapshot;
  put(
    bytes: Uint8Array,
    v: string,
    deadline: ReqDeadline,
  ): Promise<{ info: AvatarInfo; side: number; bytes: number; dedup?: boolean }>;
  remove(deadline: ReqDeadline): Promise<{ info: AvatarInfo }>;
  close(deadlineAt?: number): Promise<void>;
}

interface Pending {
  op: "put" | "delete";
  expected: AvatarMemory | undefined;
  since: number;
  epoch: number;
  settle: Promise<void>;
}

const done = Promise.resolve();
function unrefTimer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}
function codeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}
function isDeadline(err: unknown): boolean {
  return err instanceof PreviewIoError && err.ioFail === "deadline";
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createAvatarStore(deps: AvatarStoreDeps): AvatarStore {
  const now = deps.now ?? Date.now;
  const fs = deps.fs ?? createAvatarFs({ stateDir: deps.stateDir, now });
  const validate = deps.validate ?? validateAvatar;
  let currentState: AvatarStoreState = "loading";
  let memory: AvatarMemory | undefined;
  let currentGen = 0;
  let dirIdentity: AvatarDirIdentity | undefined;
  let disabledReason: AvatarStoreDisabledReason | undefined;
  let epoch = 0;
  let closed = false;
  let loadP: Promise<void> | undefined;
  let writingP: Promise<void> | undefined;
  let pending: Pending | undefined;
  let loadRejectReason: string | undefined;

  const snapshot = (): AvatarStoreSnapshot => {
    if (pending !== undefined && now() - pending.since > AVATAR_PENDING_CEILING_MS && guarded(pending.epoch)) {
      currentState = "disabled";
      disabledReason = "zombie";
    }
    return {
      state: currentState,
      memory,
      info: currentGen > 0 ? { gen: currentGen, ...(memory ? { v: memory.v } : {}) } : undefined,
      ...(disabledReason ? { disabledReason } : {}),
    };
  };
  const guarded = (e: number): boolean => !closed && currentState !== "closing" && e === epoch;
  function publish(op: AvatarStoreChange["op"], e: number, next: AvatarMemory | undefined, forceGen = true): void {
    if (!guarded(e)) return;
    memory = next;
    if (forceGen) currentGen += 1;
    const info: AvatarInfo = { gen: currentGen, ...(next ? { v: next.v } : {}) };
    deps.onChange?.({ info, memory: next, op });
  }
  function disable(reason: AvatarStoreDisabledReason, e = epoch): void {
    if (guarded(e)) {
      currentState = "disabled";
      disabledReason = reason;
    }
  }
  function busyCheck(): void {
    if (closed || currentState === "closing") throw new AvatarStoreError(503, "E_HUB_RESTARTING");
    if (currentState === "loading") throw new AvatarStoreError(503, "E_BUSY", { reason: "loading" });
    if (currentState === "disabled")
      throw new AvatarStoreError(503, "E_BUSY", { reason: disabledReason ?? "disabled" });
    if (pending !== undefined) {
      if (now() - pending.since > AVATAR_PENDING_CEILING_MS) {
        disable("zombie");
        throw new AvatarStoreError(503, "E_BUSY", { reason: "disabled" });
      }
      throw new AvatarStoreError(503, "E_BUSY", { reason: "pending" });
    }
    if (currentState === "writing") throw new AvatarStoreError(503, "E_BUSY", { reason: "inflight" });
  }
  function checkDir(actual: AvatarDirIdentity): void {
    if (dirIdentity === undefined || actual.dev !== dirIdentity.dev || actual.ino !== dirIdentity.ino) {
      disable("dir-swapped");
      throw new AvatarStoreError(503, "E_BUSY", { reason: "disabled" });
    }
  }
  async function step<T>(start: () => Promise<T>, deadlineAt: number, cap: number): Promise<T> {
    const at = Math.min(deadlineAt, now() + cap);
    if (deadlineAt - now() <= 0) throw new PreviewIoError("deadline", "avatar deadline");
    // Most AvatarFs methods own the tracked race. The outer race is deliberately untracked so
    // one underlying operation can never be counted twice by the zombie breaker.
    return racePreviewIo(start(), at, undefined, now);
  }
  async function trackedStep<T>(start: () => Promise<T>, deadlineAt: number, cap: number): Promise<T> {
    const at = Math.min(deadlineAt, now() + cap);
    if (deadlineAt - now() <= 0) throw new PreviewIoError("deadline", "avatar deadline");
    return racePreviewIo(start(), at, undefined, now, fs.tracker);
  }
  function requireSuffix(deadline: ReqDeadline, caps: readonly number[], i: number): void {
    const suffix = caps.slice(i).reduce((a, b) => a + b, 0);
    if (deadline.remaining() < suffix) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "none" });
  }
  async function closeHandle(handle: AvatarHandle | undefined): Promise<void> {
    if (handle === undefined) return;
    try {
      await Promise.race([handle.close(), unrefTimer(1_000)]);
    } catch {
      /* fd cleanup is best effort */
    }
  }
  async function readFile(deadlineAt: number): Promise<Uint8Array | undefined> {
    let h: AvatarHandle | undefined;
    try {
      h = await fs.openRead(avatarFilePath(deps.stateDir), deadlineAt);
      const st = await racePreviewIo(h.stat(), deadlineAt, undefined, now, fs.tracker);
      const uid = deps.getuid?.() ?? process.getuid?.() ?? -1;
      if (!st.isFile || st.isSymbolicLink) {
        loadRejectReason = "file-type";
        return undefined;
      }
      if (uid >= 0 && st.uid !== uid) {
        loadRejectReason = "file-owner";
        return undefined;
      }
      if (st.nlink !== 1) {
        loadRejectReason = "file-nlink";
        return undefined;
      }
      if ((st.mode & 0o077) !== 0) {
        loadRejectReason = "file-mode";
        return undefined;
      }
      if (st.size > AVATAR_MAX_BYTES) {
        loadRejectReason = "size";
        return undefined;
      }
      const out = new Uint8Array(AVATAR_MAX_BYTES + 1);
      let at = 0;
      while (at < out.length) {
        const n = await racePreviewIo(h.read(at, out, at, out.length - at), deadlineAt, undefined, now, fs.tracker);
        if (n <= 0) break;
        at += n;
      }
      return out.slice(0, at);
    } finally {
      await closeHandle(h);
    }
  }

  async function load(): Promise<void> {
    if (loadP !== undefined) return loadP;
    if (closed) return;
    const e = epoch;
    loadP = (async () => {
      try {
        dirIdentity = await fs.ensureDir(now() + 5_000);
        try {
          await fs.unlinkTemp(now() + 5_000);
        } catch (err) {
          if (codeOf(err) !== "ENOENT") throw err;
        }
        let bytes: Uint8Array | undefined;
        try {
          bytes = await readFile(now() + 5_000);
        } catch (err) {
          const code = codeOf(err);
          if (code === "ENOENT") {
            // Missing avatar is the normal empty state.
          } else if (code === "ELOOP") {
            loadRejectReason = "file-type";
            bytes = undefined;
          } else if (code === "EACCES" || code === "EPERM") {
            loadRejectReason = "file-mode";
            bytes = undefined;
          } else throw err;
        }
        if (bytes === undefined || bytes.length === 0) {
          if (guarded(e)) {
            currentState = "ready";
            currentGen = 1;
            publish("load", e, undefined, false);
            if (loadRejectReason !== undefined) deps.log?.warn("avatar load rejected", { reason: loadRejectReason });
            deps.audit?.({
              op: "load",
              phase: "request",
              ok: loadRejectReason === undefined,
              ...(loadRejectReason === undefined ? {} : { reason: loadRejectReason }),
            });
          }
          return;
        }
        const checked = validate(bytes);
        if (!checked.ok || bytes.length > AVATAR_MAX_BYTES) {
          if (guarded(e)) {
            currentState = "ready";
            currentGen = 1;
            publish("load", e, undefined, false);
            const reason = checked.ok ? "size" : checked.reason;
            deps.log?.warn("avatar load rejected", { reason });
            deps.audit?.({ op: "load", phase: "request", ok: false, reason });
          }
          return;
        }
        if (guarded(e)) {
          const m = { bytes, v: digest(bytes), side: checked.side };
          memory = m;
          currentState = "ready";
          currentGen = 1;
          deps.onChange?.({ info: { gen: 1, v: m.v }, memory: m, op: "load" });
          deps.audit?.({ op: "load", phase: "request", ok: true, bytes: bytes.length, side: m.side, v: m.v, gen: 1 });
        }
      } catch (err) {
        if (!guarded(e)) return;
        const reason = codeOf(err) === "dir" ? "dir" : "load-io";
        disable(reason === "dir" ? "dir" : "load-io", e);
        deps.audit?.({
          op: "load",
          phase: "request",
          ok: false,
          reason,
          io: isDeadline(err) ? "deadline" : "errno",
        });
      } finally {
        if (guarded(e) && currentState === "loading") currentState = "ready";
      }
    })();
    return loadP;
  }

  async function put(bytes: Uint8Array, v: string, deadline: ReqDeadline) {
    busyCheck();
    if (bytes.length > AVATAR_MAX_BYTES)
      throw new AvatarStoreError(413, "E_AVATAR_TOO_LARGE", { max: AVATAR_MAX_BYTES });
    const inputChecked = validate(bytes);
    if (!inputChecked.ok) throw new AvatarStoreError(415, "E_AVATAR_UNSUPPORTED", { reason: inputChecked.reason });
    if (memory?.v === v) return { info: { gen: currentGen, v }, side: memory.side, bytes: bytes.length, dedup: true };
    currentState = "writing";
    const e = epoch;
    let h: AvatarHandle | undefined;
    let tempCreated = false;
    let committed = false;
    const task = (async () => {
      try {
        requireSuffix(deadline, AVATAR_PUT_STEP_CAPS, 0);
        checkDir(
          await step(
            () => fs.lstatDir(Math.min(deadline.at, now() + AVATAR_PUT_STEP_CAPS[0])),
            deadline.at,
            AVATAR_PUT_STEP_CAPS[0],
          ),
        );
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        requireSuffix(deadline, AVATAR_PUT_STEP_CAPS, 1);
        try {
          h = await step(
            () => fs.openTemp(avatarTempPath(deps.stateDir), Math.min(deadline.at, now() + AVATAR_PUT_STEP_CAPS[1])),
            deadline.at,
            AVATAR_PUT_STEP_CAPS[1],
          );
          if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
          tempCreated = true;
        } catch (err) {
          if (codeOf(err) === "EEXIST") throw new AvatarStoreError(503, "E_BUSY", { reason: "tmp-exists" });
          throw err;
        }
        requireSuffix(deadline, AVATAR_PUT_STEP_CAPS, 2);
        if (h === undefined) throw new AvatarStoreError(500, "E_INTERNAL");
        const handle = h;
        let at = 0;
        while (at < bytes.length) {
          const n = await step(() => handle.write(bytes.subarray(at), at), deadline.at, AVATAR_PUT_STEP_CAPS[2]);
          if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
          if (n <= 0) throw new Error("short-write");
          at += n;
        }
        requireSuffix(deadline, AVATAR_PUT_STEP_CAPS, 3);
        await step(() => handle.datasync(), deadline.at, AVATAR_PUT_STEP_CAPS[3]);
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        await closeHandle(handle);
        h = undefined;
        requireSuffix(deadline, AVATAR_PUT_STEP_CAPS, 4);
        checkDir(
          await step(
            () => fs.lstatDir(Math.min(deadline.at, now() + AVATAR_PUT_STEP_CAPS[4])),
            deadline.at,
            AVATAR_PUT_STEP_CAPS[4],
          ),
        );
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        requireSuffix(deadline, AVATAR_PUT_STEP_CAPS, 5);
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        let commit: Promise<void> | undefined;
        try {
          await trackedStep(
            () => {
              commit = fs.renameTemp(Math.min(deadline.at, now() + AVATAR_PUT_STEP_CAPS[5]));
              return commit;
            },
            deadline.at,
            AVATAR_PUT_STEP_CAPS[5],
          );
        } catch (err) {
          if (isDeadline(err)) {
            const validated = validate(bytes);
            const expected = { bytes, v, side: validated.ok ? validated.side : 0 };
            pending = {
              op: "put",
              expected,
              since: now(),
              epoch: e,
              settle: (commit ?? Promise.reject(new Error("commit-not-started"))).then(
                () => reconcile(true),
                () => reconcile(false),
              ),
            };
            // A close() that won the race already moved the store to "closing" — never write
            // "pending" back over it (reconcile() stays fenced by the epoch either way).
            if (guarded(e)) currentState = "pending";
            throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
          }
          throw err;
        }
        if (!guarded(e)) {
          const validated = validate(bytes);
          return { info: { gen: currentGen, v }, side: validated.ok ? validated.side : 0, bytes: bytes.length };
        }
        const checked = validate(bytes);
        if (!checked.ok) throw new AvatarStoreError(415, "E_AVATAR_UNSUPPORTED", { reason: checked.reason });
        publish("put", e, { bytes, v, side: checked.side });
        committed = true;
        void fs.fsyncDir(now() + 1_000).catch(() => undefined);
        return { info: { gen: currentGen, v }, side: checked.side, bytes: bytes.length };
      } catch (err) {
        if (!guarded(e)) {
          if (h !== undefined) await closeHandle(h);
          throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        }
        if (tempCreated && !committed && !(pending?.epoch === e)) {
          if (h !== undefined) await closeHandle(h);
          const identityFailed = err instanceof AvatarStoreError && err.extra.reason === "disabled";
          const tmpAlreadyExists = err instanceof AvatarStoreError && err.extra.reason === "tmp-exists";
          if (!identityFailed && !tmpAlreadyExists) {
            void fs.unlinkTemp(Date.now() + 1_000).catch(() => undefined);
          }
        }
        if (err instanceof AvatarStoreError) throw err;
        if (isDeadline(err)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "none" });
        throw new AvatarStoreError(500, "E_INTERNAL");
      } finally {
        if (guarded(e) && currentState === "writing") currentState = "ready";
      }
    })();
    writingP = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  async function reconcile(success: boolean): Promise<void> {
    const p = pending;
    if (p === undefined) return;
    pending = undefined;
    if (!guarded(p.epoch)) return;
    const wasDisabled = currentState === "disabled";
    if (success) {
      publish("reconcile", p.epoch, p.expected);
    }
    currentState = wasDisabled ? "disabled" : "ready";
    deps.audit?.({ op: p.op, phase: "reconcile", ok: success });
  }
  async function remove(deadline: ReqDeadline) {
    busyCheck();
    currentState = "writing";
    const e = epoch;
    const task = (async () => {
      try {
        requireSuffix(deadline, AVATAR_DELETE_STEP_CAPS, 0);
        checkDir(
          await step(
            () => fs.lstatDir(Math.min(deadline.at, now() + AVATAR_DELETE_STEP_CAPS[0])),
            deadline.at,
            AVATAR_DELETE_STEP_CAPS[0],
          ),
        );
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        requireSuffix(deadline, AVATAR_DELETE_STEP_CAPS, 1);
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        let operation: Promise<void> | undefined;
        try {
          await trackedStep(
            () => {
              operation = fs.unlinkAvatar(Math.min(deadline.at, now() + AVATAR_DELETE_STEP_CAPS[1]));
              return operation;
            },
            deadline.at,
            AVATAR_DELETE_STEP_CAPS[1],
          );
        } catch (err) {
          if (codeOf(err) === "ENOENT") {
            /* idempotent success */
          } else if (isDeadline(err)) {
            pending = {
              op: "delete",
              expected: undefined,
              since: now(),
              epoch: e,
              settle: (operation ?? Promise.reject(new Error("delete-not-started"))).then(
                () => reconcile(true),
                () => reconcile(false),
              ),
            };
            // A close() that won the race already moved the store to "closing" — never write
            // "pending" back over it (reconcile() stays fenced by the epoch either way).
            if (guarded(e)) currentState = "pending";
            throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
          } else throw err;
        }
        if (guarded(e)) {
          publish("delete", e, undefined);
          void fs.fsyncDir(now() + 1_000).catch(() => undefined);
        }
        return { info: { gen: currentGen } };
      } catch (err) {
        if (!guarded(e)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "unknown" });
        if (err instanceof AvatarStoreError) throw err;
        if (isDeadline(err)) throw new AvatarStoreError(504, "E_DEADLINE", { effect: "none" });
        throw new AvatarStoreError(500, "E_INTERNAL");
      } finally {
        if (guarded(e) && currentState === "writing") currentState = "ready";
      }
    })();
    writingP = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  async function close(deadlineAt?: number): Promise<void> {
    if (closed) return;
    closed = true;
    currentState = "closing";
    epoch += 1;
    const waitMs = Math.min(
      AVATAR_CLOSE_WAIT_MS,
      deadlineAt === undefined ? AVATAR_CLOSE_WAIT_MS : Math.max(0, deadlineAt - now()),
    );
    await Promise.race([Promise.all([loadP ?? done, writingP ?? done]), unrefTimer(waitMs)]);
  }
  return {
    get state() {
      return currentState;
    },
    get gen() {
      return currentGen;
    },
    get disabledReason() {
      return disabledReason;
    },
    load,
    snapshot,
    put,
    remove,
    close,
  };
}

export { AVATAR_STORE_MIN_MS };
