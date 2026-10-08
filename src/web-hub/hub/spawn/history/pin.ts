/**
 * web-hub session-history plan §4.5.6 (`pin.ts`): fd-anchored resolution (`pinSession`),
 * resume preflight (`verifyForSpawn`), and the path-based restore-preflight pair
 * (`captureSessionPathPin` / `verifySessionPathPin`, PD24 / v3.4 X1 — no sessionsRoot
 * ownership requirement, every `--session <file>` restore gets the identical capture).
 *
 * `pinSession` holds its three fds through a module-private `WeakMap` keyed by the public
 * `SessionPin` object, so the frozen port shape (`ports.ts`) stays free of raw fd numbers while
 * `verifyForSpawn` can still reach the pinned `fileFd` for its synchronous `fstatSync`.
 */
import { dirname } from "node:path";
import { isValidSessionKey, type HistoryKind } from "../../../protocol/session-history.js";
import type { ReqDeadline } from "../../req-deadline.js";
import type {
  CaptureSessionPathPin,
  InodeRef,
  ResolveResult,
  SessionPathPin,
  SessionPin,
  VerifySessionPathPin,
} from "./ports.js";
import { HISTORY_PIN_MAX } from "./ports.js";
import { checkSessionHeader, createHeadParser, type HeadResult } from "./head.js";
import {
  errCodeOf,
  fdPath,
  HISTORY_DIR_OPEN_FLAGS,
  HISTORY_FILE_OPEN_FLAGS,
  type HistoryFs,
  type HistoryHandle,
  type HistorySyncFs,
} from "./fs.js";
import { boundedClose, boundedFdOpen, historyStep, type HistoryIoGate } from "./budget.js";
import { HISTORY_HEAD_BLOCK_BYTES, HISTORY_HEAD_MAX_BYTES, HISTORY_HEADER_LINE_MAX, PIN_BUDGET_MS } from "./budget.js";
import type { FdLedger } from "./fd-ledger.js";

interface PinFds {
  rootFd: number;
  dirFd: number;
  fileFd: number;
}

/** Keeps raw fds OFF the frozen `SessionPin` shape while still letting `verifyForSpawn` reach
 * them synchronously. */
const pinFds = new WeakMap<SessionPin, PinFds>();

/**
 * Finding 2b fix: a dedicated, synchronous admission counter for concurrently-held
 * `SessionPin`s — deliberately NOT derived from the fd ledger's `"pin"` kind count (which
 * counts 3 fds per pin, not pin OBJECTS). Capped at `HISTORY_PIN_MAX`. One instance is created
 * per `service.ts` instance and threaded through `PinSessionDeps`.
 */
export interface PinAdmission {
  tryAcquire(): boolean;
  release(): void;
}

export function createPinAdmission(max: number = HISTORY_PIN_MAX): PinAdmission {
  let count = 0;
  return {
    tryAcquire(): boolean {
      if (count >= max) return false;
      count += 1;
      return true;
    },
    release(): void {
      count = Math.max(0, count - 1);
    },
  };
}

export interface PinSessionDeps {
  agentDir: string;
  uid: number;
  fs: HistoryFs;
  gate: HistoryIoGate;
  ledger: FdLedger;
  admission: PinAdmission;
  now(): number;
  /** Optional header-index lookup (dev/ino ⇒ cached kind), avoiding a redundant 256 KiB read. */
  indexedKind?: (dev: number, ino: number) => HistoryKind | undefined;
}

interface PinOpenBusyError extends Error {
  pinOpenReason: "busy" | "deadline";
}

function createPinOpenBusyError(reason: "busy" | "deadline"): PinOpenBusyError {
  return Object.assign(new Error(`pin open ${reason}`), { pinOpenReason: reason });
}

function isPinOpenBusy(err: unknown): err is PinOpenBusyError {
  if (typeof err !== "object" || err === null || !("pinOpenReason" in err)) return false;
  const reason = err.pinOpenReason;
  return reason === "busy" || reason === "deadline";
}

/** Finding 1 fix: the sole open-a-pin-fd call path. Reserves exactly 1 `"pin"` fd via
 * `boundedFdOpen` and throws a `PinOpenBusyError` on busy/deadline (routed to 504 by the
 * caller) or the real fs error otherwise (routed through the existing ENOENT/else mapping). */
async function openPinFd(
  openFn: () => Promise<HistoryHandle>,
  deadlineAt: number,
  deps: PinSessionDeps,
): Promise<HistoryHandle> {
  const res = await boundedFdOpen(1, "pin", openFn, deadlineAt, {
    gate: deps.gate,
    ledger: deps.ledger,
    now: deps.now,
  });
  if (res.ok) return res.handle;
  if (res.reason === "busy" || res.reason === "deadline") {
    throw createPinOpenBusyError(res.reason);
  }
  throw res.err;
}

function closeQuiet(h: HistoryHandle | undefined, deps: { gate: HistoryIoGate; now(): number }): void {
  if (h === undefined) return;
  void boundedClose(() => h.close(), deps);
}

export async function pinSession(
  ref: { key: string; id: string },
  cwd: string,
  deadline: ReqDeadline,
  deps: PinSessionDeps,
): Promise<ResolveResult> {
  if (!isValidSessionKey(ref.key)) {
    return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "session-ref" };
  }
  // Finding 2b fix: the pin-admission cap check, right after key-shape validation and BEFORE
  // any fd work. Cap exhaustion surfaces as 504 E_DEADLINE because the frozen ResolveResult has
  // no 503 slot (dispatcher ruling — accepted trade-off, no code change).
  if (!deps.admission.tryAcquire()) {
    return { ok: false, status: 504, code: "E_DEADLINE" };
  }
  const slash = ref.key.indexOf("/");
  const dir = ref.key.slice(0, slash);
  const file = ref.key.slice(slash + 1);

  const budgetMs = Math.min(PIN_BUDGET_MS, deadline.remaining());
  if (budgetMs <= 0) {
    deps.admission.release();
    return { ok: false, status: 504, code: "E_DEADLINE" };
  }
  const deadlineAt = deps.now() + budgetMs;
  const step = <T>(lazy: () => Promise<T>): Promise<T> => historyStep(deps.gate, lazy, deadlineAt, deps.now);
  const closeDeps = { gate: deps.gate, now: deps.now };

  let rootH: HistoryHandle | undefined;
  let dirH: HistoryHandle | undefined;
  let fileH: HistoryHandle | undefined;
  const fail = (result: ResolveResult): ResolveResult => {
    // Finding 1 fix: close + release exactly the fds that were actually opened — `openPinFd`
    // (via `boundedFdOpen`) already released the ledger reservation for anything that FAILED
    // to open, so releasing again here would double-release.
    if (fileH !== undefined) {
      closeQuiet(fileH, closeDeps);
      deps.ledger.release(1, "pin");
    }
    if (dirH !== undefined) {
      closeQuiet(dirH, closeDeps);
      deps.ledger.release(1, "pin");
    }
    if (rootH !== undefined) {
      closeQuiet(rootH, closeDeps);
      deps.ledger.release(1, "pin");
    }
    deps.admission.release();
    return result;
  };

  let root: InodeRef;
  let R = "";
  try {
    R = await step(() => deps.fs.realpath(`${deps.agentDir}/sessions`));
    rootH = await openPinFd(() => deps.fs.open(R, HISTORY_DIR_OPEN_FLAGS), deadlineAt, deps);
    const st = await step(() => rootH!.stat());
    if (!st.isDirectory() || st.uid !== deps.uid) {
      return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
    }
    root = { dev: st.dev, ino: st.ino };
  } catch (err) {
    if (isPinOpenBusy(err)) return fail({ ok: false, status: 504, code: "E_DEADLINE" });
    return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  }

  let dirRef: InodeRef;
  try {
    dirH = await openPinFd(() => deps.fs.open(fdPath(rootH!.fd, dir), HISTORY_DIR_OPEN_FLAGS), deadlineAt, deps);
  } catch (err) {
    if (isPinOpenBusy(err)) return fail({ ok: false, status: 504, code: "E_DEADLINE" });
    const code = errCodeOf(err);
    if (code === "ENOENT") return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-missing" });
    return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" }); // ENOTDIR/ELOOP and others
  }
  try {
    const st = await step(() => dirH!.stat());
    if (!st.isDirectory() || st.uid !== deps.uid) {
      return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
    }
    dirRef = { dev: st.dev, ino: st.ino };
  } catch {
    return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  }

  let fileRef: InodeRef;
  let size: number;
  try {
    fileH = await openPinFd(() => deps.fs.open(fdPath(dirH!.fd, file), HISTORY_FILE_OPEN_FLAGS), deadlineAt, deps);
  } catch (err) {
    if (isPinOpenBusy(err)) return fail({ ok: false, status: 504, code: "E_DEADLINE" });
    const code = errCodeOf(err);
    if (code === "ENOENT") return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-missing" });
    return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" }); // ELOOP and others
  }
  try {
    const st = await step(() => fileH!.stat());
    if (!st.isFile() || st.uid !== deps.uid || st.nlink !== 1) {
      return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
    }
    fileRef = { dev: st.dev, ino: st.ino };
    size = st.size;
  } catch {
    return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  }

  // Step 5/6: header mismatch check + kind (index lookup, else a combined read up to 256 KiB —
  // the first block always carries the full header line since HISTORY_HEAD_BLOCK_BYTES (32 KiB)
  // comfortably exceeds HISTORY_HEADER_LINE_MAX (4 KiB), so one pass yields both).
  let headText = "";
  let head: HeadResult | undefined;
  const cachedKind = deps.indexedKind?.(fileRef.dev, fileRef.ino);
  try {
    if (cachedKind !== undefined) {
      const buf = Buffer.alloc(Math.min(HISTORY_HEADER_LINE_MAX, size));
      const { bytesRead } = await step(() => fileH!.read(buf, 0, buf.length, 0));
      headText = buf.subarray(0, bytesRead).toString("utf8");
      const nl = headText.indexOf("\n");
      if (nl >= 0) headText = headText.slice(0, nl);
    } else {
      const parser = createHeadParser();
      const maxBytes = Math.min(size, HISTORY_HEAD_MAX_BYTES);
      let position = 0;
      let gotFirstLine = false;
      while (position < maxBytes) {
        const blockLen = Math.min(HISTORY_HEAD_BLOCK_BYTES, maxBytes - position);
        const buf = Buffer.alloc(blockLen);
        const { bytesRead } = await step(() => fileH!.read(buf, 0, blockLen, position));
        if (bytesRead <= 0) break;
        const chunk = bytesRead === blockLen ? buf : buf.subarray(0, bytesRead);
        if (!gotFirstLine) {
          const nl = chunk.indexOf(0x0a);
          if (nl >= 0) {
            headText = chunk.subarray(0, nl).toString("utf8");
            gotFirstLine = true;
          }
        }
        position += bytesRead;
        if (parser.push(chunk) === "done") break;
      }
      head = parser.finish();
      if (!gotFirstLine) headText = "";
    }
  } catch {
    return fail({ ok: false, status: 400, code: "E_DIR", reason: "session-invalid" });
  }

  const checked = checkSessionHeader(headText, { id: ref.id, cwd });
  if (!checked.ok) {
    const reason =
      checked.detail === "header id mismatch" || checked.detail === "header cwd mismatch"
        ? "session-mismatch"
        : "session-invalid";
    return fail({ ok: false, status: 400, code: "E_DIR", reason });
  }

  const kind = cachedKind ?? head?.kind ?? "unknown";
  const absPath = `${R}/${ref.key}`;

  const pin: SessionPin = {
    id: ref.id,
    cwd,
    kind,
    size,
    abs: absPath,
    root,
    dir: dirRef,
    file: fileRef,
    release(): void {
      const fds = pinFds.get(pin);
      if (fds === undefined) return; // already released
      pinFds.delete(pin);
      closeQuiet(fileH, closeDeps);
      closeQuiet(dirH, closeDeps);
      closeQuiet(rootH, closeDeps);
      deps.ledger.release(1, "pin");
      deps.ledger.release(1, "pin");
      deps.ledger.release(1, "pin");
      deps.admission.release();
    },
  };
  pinFds.set(pin, { rootFd: rootH.fd, dirFd: dirH.fd, fileFd: fileH.fd });
  return { ok: true, pin };
}

/** §4.5.7: the snapshot step reads through the SAME pinned fd via its own `/proc/self/fd/<fd>`
 * magic-link re-open (a fresh, independent file description on the same inode — never a
 * by-path walk). `undefined` once the pin has been released. */
export function getPinnedFileFd(pin: SessionPin): number | undefined {
  return pinFds.get(pin)?.fileFd;
}

/** §4.5.6: resume-only sync preflight against the fds `pinSession` already holds. */
export function verifyForSpawn(
  pin: SessionPin,
  syncFs: HistorySyncFs,
): { ok: true } | { ok: false; reason: "session-changed" } {
  const fds = pinFds.get(pin);
  if (fds === undefined) return { ok: false, reason: "session-changed" };
  try {
    const fileStat = syncFs.fstatSync(fds.fileFd);
    if (fileStat.nlink !== 1) return { ok: false, reason: "session-changed" };
    const dirOfAbs = dirname(pin.abs);
    const rootOfAbs = dirname(dirOfAbs);
    const rootLstat = syncFs.lstatSync(rootOfAbs);
    const dirLstat = syncFs.lstatSync(dirOfAbs);
    const fileLstat = syncFs.lstatSync(pin.abs);
    if (rootLstat.isSymbolicLink() || dirLstat.isSymbolicLink() || fileLstat.isSymbolicLink()) {
      return { ok: false, reason: "session-changed" };
    }
    if (rootLstat.dev !== pin.root.dev || rootLstat.ino !== pin.root.ino)
      return { ok: false, reason: "session-changed" };
    if (dirLstat.dev !== pin.dir.dev || dirLstat.ino !== pin.dir.ino) return { ok: false, reason: "session-changed" };
    if (fileLstat.dev !== pin.file.dev || fileLstat.ino !== pin.file.ino)
      return { ok: false, reason: "session-changed" };
    if (fileLstat.nlink !== 1) return { ok: false, reason: "session-changed" };
    if (syncFs.realpathSync(pin.abs) !== pin.abs) return { ok: false, reason: "session-changed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "session-changed" };
  }
}

// ---------------------------------------------------------------------------
// restore preflight (PD24 / v3.4 X1): path-based, no sessionsRoot requirement
// ---------------------------------------------------------------------------

export function makeCaptureSessionPathPin(syncFs: HistorySyncFs): CaptureSessionPathPin {
  return function captureSessionPathPin(abs: string, uid: number) {
    try {
      const dirOfAbs = dirname(abs);
      const rootOfAbs = dirname(dirOfAbs);
      const rootLstat = syncFs.lstatSync(rootOfAbs);
      const dirLstat = syncFs.lstatSync(dirOfAbs);
      const fileLstat = syncFs.lstatSync(abs);
      if (rootLstat.isSymbolicLink() || dirLstat.isSymbolicLink() || fileLstat.isSymbolicLink()) {
        return { ok: false, detail: "a path level is a symlink" };
      }
      if (!rootLstat.isDirectory()) return { ok: false, detail: "sessionsRoot level is not a directory" };
      if (!dirLstat.isDirectory()) return { ok: false, detail: "session dir level is not a directory" };
      if (!fileLstat.isFile()) return { ok: false, detail: "session file is not a regular file" };
      if (fileLstat.nlink !== 1) return { ok: false, detail: "session file has nlink !== 1" };
      if (fileLstat.uid !== uid) return { ok: false, detail: "session file owner mismatch" };
      if (syncFs.realpathSync(abs) !== abs) return { ok: false, detail: "realpath mismatch" };
      const pin: SessionPathPin = {
        abs,
        root: { dev: rootLstat.dev, ino: rootLstat.ino },
        dir: { dev: dirLstat.dev, ino: dirLstat.ino },
        file: { dev: fileLstat.dev, ino: fileLstat.ino },
      };
      return { ok: true, pin };
    } catch (err) {
      return { ok: false, detail: `lstat failed: ${errCodeOf(err) ?? "unknown"}` };
    }
  };
}

export function makeVerifySessionPathPin(syncFs: HistorySyncFs): VerifySessionPathPin {
  return function verifySessionPathPin(pin: SessionPathPin, reported: string | undefined) {
    if (reported === undefined || reported !== pin.abs) {
      return { ok: false, detail: "sessionFile differs from launched path" };
    }
    try {
      const dirOfAbs = dirname(pin.abs);
      const rootOfAbs = dirname(dirOfAbs);
      const rootLstat = syncFs.lstatSync(rootOfAbs);
      const dirLstat = syncFs.lstatSync(dirOfAbs);
      const fileLstat = syncFs.lstatSync(pin.abs);
      if (rootLstat.isSymbolicLink() || dirLstat.isSymbolicLink() || fileLstat.isSymbolicLink()) {
        return { ok: false, detail: "a path level is a symlink" };
      }
      if (rootLstat.dev !== pin.root.dev || rootLstat.ino !== pin.root.ino) {
        return { ok: false, detail: "sessionsRoot level changed" };
      }
      if (dirLstat.dev !== pin.dir.dev || dirLstat.ino !== pin.dir.ino) {
        return { ok: false, detail: "session dir level changed" };
      }
      if (!fileLstat.isFile() || fileLstat.dev !== pin.file.dev || fileLstat.ino !== pin.file.ino) {
        return { ok: false, detail: "session file changed" };
      }
      if (fileLstat.nlink !== 1) return { ok: false, detail: "session file has nlink !== 1" };
      if (syncFs.realpathSync(pin.abs) !== pin.abs) return { ok: false, detail: "realpath mismatch" };
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: `lstat failed: ${errCodeOf(err) ?? "unknown"}` };
    }
  };
}
