/** v2-only resource persistence. Initialization belongs to tools, never infer fresh from ENOENT.
 * No authentication intent, v1 reader, repair/reset, or process-liveness release. */
import { constants } from "node:fs";
import { open, lstat, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  terminalMarkersV2Match,
  RETAINED_UNKNOWN_INITIALIZATION,
  terminalLedgerV2Ok,
  type LedgerV2,
  type TerminalMarkerV2,
} from "../../../protocol/terminal-v2.js";
import { terminalV2Files } from "../../../protocol/terminal-v2-paths.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import type { TerminalAllocationLedgerPortV2 } from "../../terminal-v2-ports.js";
import { boundedV2 } from "./timing.js";

type Image = { bytes: Buffer; dev: number; ino: number };
type Directory = { path: string; handle: FileHandle; dev: number; ino: number };
export interface TerminalLedgerDependenciesV2 {
  stateDir: string;
  /** Existing singleton/startup identity. Must remain true through every mutation. */
  current(): boolean;
  /** Test-only barriers/fault injection; never settings/env/HTTP. */
  stage?(stage: "read" | "temp-sync" | "before-rename" | "after-rename" | "parent-sync"): Promise<void>;
}
/** P1-local physical-evidence capability. NOT part of the frozen P0 port.
 * Only trusted resource code may supply a bounded synchronous read-only guard. */
export type TerminalLedgerCommitGuardV2 = () => undefined;
export interface GuardedTerminalAllocationLedgerV2 extends TerminalAllocationLedgerPortV2 {
  commitGuarded(
    expectedRevision: number,
    next: LedgerV2,
    signal: AbortSignal,
    guard: TerminalLedgerCommitGuardV2,
  ): ReturnType<TerminalAllocationLedgerPortV2["commit"]>;
}
export function createTerminalAllocationLedgerV2(
  deps: TerminalLedgerDependenciesV2,
): GuardedTerminalAllocationLedgerV2 {
  const files = terminalV2Files(resolve(deps.stateDir));
  const uid = process.getuid?.();
  let directories: Directory[] = [],
    images: { marker: Image; witness: Image; ledger: Image } | undefined;
  const directoryPins = new Map<string, { dev: number; ino: number }>();
  let initialization: TerminalMarkerV2["initialization"] | undefined;
  let current: LedgerV2 | undefined,
    poisoned = false,
    busy = false;
  const clone = <T>(v: T): T => structuredClone(v);
  function check(signal: AbortSignal, at: number) {
    if (signal.aborted || Date.now() >= at || !deps.current()) throw new Error("E_STORE");
  }
  async function directory(path: string): Promise<Directory> {
    const h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const s = await h.stat(),
        p = await lstat(path);
      if (
        uid === undefined ||
        !s.isDirectory() ||
        s.uid !== uid ||
        (s.mode & 0o777) !== 0o700 ||
        p.dev !== s.dev ||
        p.ino !== s.ino ||
        (await realpath(path)) !== path
      )
        throw new Error("E_STORE");
      const pin = directoryPins.get(path);
      if (pin && (pin.dev !== s.dev || pin.ino !== s.ino)) throw new Error("E_STORE");
      directoryPins.set(path, { dev: s.dev, ino: s.ino });
      return { path, handle: h, dev: s.dev, ino: s.ino };
    } catch (e) {
      await h.close();
      throw e;
    }
  }
  async function checkDirectories() {
    for (const d of directories) {
      const s = await lstat(d.path),
        held = await d.handle.stat();
      if (
        !s.isDirectory() ||
        s.uid !== uid ||
        (s.mode & 0o777) !== 0o700 ||
        s.dev !== d.dev ||
        s.ino !== d.ino ||
        held.dev !== s.dev ||
        held.ino !== s.ino ||
        (await realpath(d.path)) !== d.path
      )
        throw new Error("E_STORE");
    }
  }
  async function image(path: string, max: number = L.ledgerBytes): Promise<Image> {
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat();
      if (!s.isFile() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > max)
        throw new Error("E_STORE");
      const bytes = Buffer.alloc(s.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const r = await h.read(bytes, count, bytes.length - count, count);
        if (!r.bytesRead) break;
        count += r.bytesRead;
      }
      const after = await h.stat(),
        p = await lstat(path);
      if (
        count !== s.size ||
        after.size !== s.size ||
        after.mtimeMs !== s.mtimeMs ||
        p.dev !== s.dev ||
        p.ino !== s.ino
      )
        throw new Error("E_STORE");
      return { bytes: bytes.subarray(0, count), dev: s.dev, ino: s.ino };
    } finally {
      await h.close();
    }
  }
  function equal(a: Image, b: Image) {
    return a.dev === b.dev && a.ino === b.ino && a.bytes.equals(b.bytes);
  }
  async function unchanged(expected = images) {
    await checkDirectories();
    if (
      !expected ||
      !equal(expected.marker, await image(files.marker, 4096)) ||
      !equal(expected.witness, await image(files.witness, 4096)) ||
      !equal(expected.ledger, await image(files.ledger))
    )
      throw new Error("E_STORE");
  }
  async function releaseDirs() {
    const ds = directories;
    directories = [];
    await Promise.all(ds.map((d) => d.handle.close()));
  }
  /** Cleanup is part of the bounded IO work. No candidate is ever adopted in that work:
   * after a logical timeout it may settle/close fds, but can no longer change images/current. */
  async function commitGuarded(
    expectedRevision: number,
    next: LedgerV2,
    signal: AbortSignal,
    guard: TerminalLedgerCommitGuardV2,
  ): ReturnType<TerminalAllocationLedgerPortV2["commit"]> {
    if (poisoned || busy || !current || !images) return { kind: "unavailable", effect: "none" };
    if (current.revision !== expectedRevision) return { kind: "conflict" };
    if (
      typeof guard !== "function" ||
      !terminalLedgerV2Ok(next) ||
      next.storeId !== current.storeId ||
      (initialization === RETAINED_UNKNOWN_INITIALIZATION
        ? !Array.isArray(next.legacyObligations)
        : next.legacyObligations !== undefined) ||
      next.revision !== expectedRevision + 1
    )
      return { kind: "unavailable", effect: "none" };
    next = clone(next);
    busy = true;
    const at = Date.now() + L.contextMs,
      controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    let renameEntered = false,
      externalChange = false,
      settled = false,
      waiterFinished = false;
    let tmp = `${files.root}/.ledger-${randomBytes(16).toString("hex")}.tmp`;
    const work = (async () => {
      try {
        check(controller.signal, at);
        directories.push(await directory(resolve(deps.stateDir)));
        directories.push(await directory(files.root));
        try {
          await unchanged();
        } catch (e) {
          externalChange = true;
          throw e;
        }
        check(controller.signal, at);
        tmp = `/proc/self/fd/${directories[1]!.handle.fd}/${tmp.slice(tmp.lastIndexOf("/") + 1)}`;
        const h = await open(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await h.writeFile(JSON.stringify(next) + "\n");
          await deps.stage?.("temp-sync");
          check(controller.signal, at);
          await h.sync();
        } finally {
          await h.close();
        }
        await deps.stage?.("before-rename");
        try {
          await unchanged();
        } catch (e) {
          externalChange = true;
          throw e;
        }
        check(controller.signal, at);
        // LAST await is above. Guard failure is strictly before the rename syscall => none.
        // Guard must not await, invoke user callbacks, or mutate evidence.
        if (guard() !== undefined) throw new Error("E_GUARD");
        check(controller.signal, at);
        renameEntered = true;
        await rename(tmp, `/proc/self/fd/${directories[1]!.handle.fd}/ledger.json`);
        await deps.stage?.("after-rename");
        check(controller.signal, at);
        await deps.stage?.("parent-sync");
        await directories[1]!.handle.sync();
        check(controller.signal, at);
        await checkDirectories();
        const written = await image(files.ledger);
        if (!written.bytes.equals(Buffer.from(JSON.stringify(next) + "\n"))) throw new Error("E_STORE");
        if (
          !equal(images!.marker, await image(files.marker, 4096)) ||
          !equal(images!.witness, await image(files.witness, 4096))
        )
          throw new Error("E_STORE");
        return written;
      } finally {
        try {
          await unlink(tmp);
        } catch {
          /* only our own random staging name */
        }
        await releaseDirs();
      }
    })();
    void work.then(
      () => {
        settled = true;
        if (waiterFinished) busy = false;
      },
      () => {
        settled = true;
        if (waiterFinished) busy = false;
      },
    );
    try {
      const written = await boundedV2(work, at, controller.signal);
      // ALL async IO (including final witness reads and fd cleanup) has ended. Neither
      // old generations nor late IO may publish success/adopt a candidate after this point.
      check(controller.signal, at);
      if (guard() !== undefined) throw new Error("E_GUARD");
      check(controller.signal, at);
      images!.ledger = written;
      current = clone(next);
      return { kind: "committed", revision: next.revision };
    } catch {
      controller.abort();
      if (renameEntered || externalChange) poisoned = true;
      return { kind: "unavailable", effect: renameEntered ? "unknown" : "none" };
    } finally {
      signal.removeEventListener("abort", abort);
      waiterFinished = true;
      if (settled) busy = false;
    }
  }
  return {
    async load(signal) {
      if (poisoned || busy) return { kind: "unavailable" };
      busy = true;
      const at = Date.now() + L.contextMs,
        controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      let settled = false,
        waiterFinished = false;
      const work = (async () => {
        try {
          check(controller.signal, at);
          directories.push(await directory(resolve(deps.stateDir)));
          directories.push(await directory(files.root));
          if (current) {
            await unchanged();
            return { ledger: clone(current), images: images! };
          }
          await deps.stage?.("read");
          check(controller.signal, at);
          const markerImage = await image(files.marker, 4096),
            witness = await image(files.witness, 4096),
            ledgerImage = await image(files.ledger);
          const m: unknown = JSON.parse(markerImage.bytes.toString("utf8")),
            w: unknown = JSON.parse(witness.bytes.toString("utf8")),
            l: unknown = JSON.parse(ledgerImage.bytes.toString("utf8"));
          if (!terminalMarkersV2Match(m, w) || !terminalLedgerV2Ok(l) || l.storeId !== (m as TerminalMarkerV2).storeId)
            throw new Error("E_STORE");
          if (
            (m as TerminalMarkerV2).initialization === RETAINED_UNKNOWN_INITIALIZATION
              ? !Array.isArray(l.legacyObligations)
              : l.legacyObligations !== undefined
          )
            throw new Error("E_STORE");
          const candidateImages = { marker: markerImage, witness, ledger: ledgerImage };
          await unchanged(candidateImages);
          return { ledger: clone(l), images: candidateImages, initialization: (m as TerminalMarkerV2).initialization };
        } finally {
          await releaseDirs();
        }
      })();
      void work.then(
        () => {
          settled = true;
          if (waiterFinished) busy = false;
        },
        () => {
          settled = true;
          if (waiterFinished) busy = false;
        },
      );
      try {
        const candidate = await boundedV2(work, at, controller.signal);
        check(controller.signal, at);
        images = candidate.images;
        if ("initialization" in candidate) initialization = candidate.initialization;
        current = clone(candidate.ledger);
        return { kind: "loaded", ledger: clone(candidate.ledger) };
      } catch {
        controller.abort();
        poisoned = true;
        return { kind: "unavailable" };
      } finally {
        signal.removeEventListener("abort", abort);
        waiterFinished = true;
        if (settled) busy = false;
      }
    },
    commit(expectedRevision, next, signal) {
      // Ordinary reserve/prune may NEVER alter retained obligations. Retirement is
      // the separate trusted physical-evidence commitGuarded capability.
      if (JSON.stringify(next.legacyObligations) !== JSON.stringify(current?.legacyObligations))
        return Promise.resolve({ kind: "unavailable" as const, effect: "none" as const });
      return commitGuarded(expectedRevision, next, signal, () => undefined);
    },
    commitGuarded,
  };
}
