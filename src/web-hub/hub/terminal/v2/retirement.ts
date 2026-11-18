/** Cold old-kernel retirement only: durable evidence BEFORE exact atomic prune.
 * Same-kernel unknown never released; archive failure keeps rows and does not poison ledger.
 * P6 runs under existing singleton BEFORE service.initialize (no hot backend at this point). */
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync } from "node:fs";
import { open, lstat, realpath, mkdir, readdir, readFile, readlink, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { GuardedTerminalAllocationLedgerV2, TerminalLedgerCommitGuardV2 } from "./ledger.js";
import { terminalLedgerV2Ok, type LedgerV2 } from "../../../protocol/terminal-v2.js";
import { terminalV2Files } from "../../../protocol/terminal-v2-paths.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import { boundedV2 } from "./timing.js";
export interface KernelEvidenceV2 {
  bootId: string;
  pidNamespace: string;
  mountNamespace: string;
  userNamespace: string;
}
export async function currentKernelEvidenceV2(): Promise<KernelEvidenceV2> {
  const [boot, stat, proc, pidNamespace, mountNamespace, userNamespace] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/proc/self/stat", "utf8"),
    lstat("/proc"),
    readlink("/proc/self/ns/pid"),
    readlink("/proc/self/ns/mnt"),
    readlink("/proc/self/ns/user"),
  ]);
  if (
    !proc.isDirectory() ||
    !stat.startsWith(`${process.pid} (`) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot.trim()) ||
    !/^pid:\[\d+\]$/.test(pidNamespace) ||
    !/^mnt:\[\d+\]$/.test(mountNamespace) ||
    !/^user:\[\d+\]$/.test(userNamespace)
  )
    throw new Error("E_KERNEL");
  return { bootId: boot.trim(), pidNamespace, mountNamespace, userNamespace };
}
/** Only bounded synchronous read-only syscalls; no async work, user callback or evidence
 * mutation. Reopens original pinned paths so it also works after async fd cleanup ended. */
function evidenceGuardV2(pins: {
  directories: Array<{ path: string; dev: number; ino: number }>;
  filePath: string;
  identity: { dev: number; ino: number };
  bytes: Buffer;
  uid: number;
  signal: AbortSignal;
  at: number;
}): TerminalLedgerCommitGuardV2 {
  if (pins.bytes.length > 2 * L.ledgerBytes + 4096) throw new Error("E_ARCHIVE");
  return () => {
    if (pins.signal.aborted || Date.now() >= pins.at) throw new Error("E_STOP");
    const opened: number[] = [];
    try {
      for (const pin of pins.directories) {
        const fd = openSync(pin.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        opened.push(fd);
        const held = fstatSync(fd),
          path = lstatSync(pin.path);
        if (
          !held.isDirectory() ||
          held.uid !== pins.uid ||
          (held.mode & 0o777) !== 0o700 ||
          held.dev !== pin.dev ||
          held.ino !== pin.ino ||
          path.dev !== pin.dev ||
          path.ino !== pin.ino ||
          realpathSync(pin.path) !== pin.path
        )
          throw new Error("E_ARCHIVE");
      }
      const fd = openSync(pins.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      opened.push(fd);
      const stat = fstatSync(fd),
        path = lstatSync(pins.filePath);
      if (
        !stat.isFile() ||
        stat.uid !== pins.uid ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.nlink !== 1 ||
        stat.size !== pins.bytes.length ||
        stat.dev !== pins.identity.dev ||
        stat.ino !== pins.identity.ino ||
        path.dev !== stat.dev ||
        path.ino !== stat.ino
      )
        throw new Error("E_ARCHIVE");
      const bytes = Buffer.alloc(pins.bytes.length + 1);
      let count = 0;
      while (count < bytes.length) {
        const n = readSync(fd, bytes, count, bytes.length - count, count);
        if (!n) break;
        count += n;
      }
      const after = fstatSync(fd);
      if (
        count !== pins.bytes.length ||
        !bytes.subarray(0, count).equals(pins.bytes) ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      )
        throw new Error("E_ARCHIVE");
      if (pins.signal.aborted || Date.now() >= pins.at) throw new Error("E_STOP");
    } finally {
      let closeFailed = false;
      for (const fd of opened.reverse()) {
        try {
          closeSync(fd);
        } catch {
          closeFailed = true;
        }
      }
      if (closeFailed) throw new Error("E_ARCHIVE");
    }
    return undefined;
  };
}
export async function retireOldKernelAllocationsV2(
  deps: {
    stateDir: string;
    ledger: GuardedTerminalAllocationLedgerV2;
    current(): boolean;
    /** Test-only simulated boot/proc evidence; never env/config/wire. UUID fixtures are NOT real reboot evidence. */
    kernelEvidence?(): Promise<KernelEvidenceV2>;
  },
  signal: AbortSignal,
): Promise<{ kind: "unchanged" | "retired" | "retained"; count: number } | { kind: "unavailable" }> {
  if (typeof deps.ledger.commitGuarded !== "function") return { kind: "unavailable" };
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const at = Date.now() + L.contextMs;
  const check = () => {
    if (controller.signal.aborted || Date.now() >= at || !deps.current()) throw new Error("E_STOP");
  };
  // A plain P0 ledger cannot provide the physical evidence fence. Never fall back.
  let pruneEntered = false;
  let finalGuard: TerminalLedgerCommitGuardV2 | undefined;
  const work = (async () => {
    check();
    const loaded = await deps.ledger.load(controller.signal);
    if (loaded.kind !== "loaded" || !terminalLedgerV2Ok(loaded.ledger)) return { kind: "unavailable" as const };
    const ledger = loaded.ledger;
    const probe = deps.kernelEvidence ?? currentKernelEvidenceV2;
    const before = await probe();
    check();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(before.bootId))
      throw new Error("E_KERNEL");
    const eligible = ledger.allocations.filter((a) => a.kernelBootId !== before.bootId);
    if (!eligible.length) return { kind: "unchanged" as const, count: 0 };
    const paths = terminalV2Files(resolve(deps.stateDir)),
      uid = process.getuid?.();
    const directory = async (path: string) => {
      const h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const s = await h.stat(),
          p = await lstat(path);
        if (
          !s.isDirectory() ||
          s.uid !== uid ||
          (s.mode & 0o777) !== 0o700 ||
          p.ino !== s.ino ||
          p.dev !== s.dev ||
          (await realpath(path)) !== path
        )
          throw new Error("E_ARCHIVE");
        return h;
      } catch (e) {
        await h.close();
        throw e;
      }
    };
    const parent = await directory(resolve(deps.stateDir));
    try {
      check();
      try {
        await mkdir(`/proc/self/fd/${parent.fd}/.terminal-allocation-archive-v2`, { mode: 0o700 });
        await parent.sync();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const archive = await directory(paths.archive);
      try {
        const rootStat = await archive.stat();
        const entries = await readdir(paths.archive);
        if (entries.length >= L.archiveTransactions) throw new Error("E_CAPACITY");
        let bytes = 0;
        for (const name of entries) {
          if (!/^[a-f0-9]{32}$/.test(name)) throw new Error("E_ARCHIVE");
          const tx = await directory(`${paths.archive}/${name}`);
          try {
            const files = await readdir(`${paths.archive}/${name}`);
            // Count prepared/committed/partial publication bytes without replaying them.
            if (
              files.length > 3 ||
              files.some((f) => !["evidence.json", ".completion-prepared", "completion.json"].includes(f))
            )
              throw new Error("E_ARCHIVE");
            for (const f of files) {
              const s = await lstat(`${paths.archive}/${name}/${f}`);
              if (!s.isFile() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
                throw new Error("E_ARCHIVE");
              bytes += s.size;
            }
          } finally {
            await tx.close();
          }
          check();
        }
        const evidence = Buffer.from(
          JSON.stringify({ v: 2, kind: "old-kernel-allocation-retirement", kernel: before, ledger, eligible }) + "\n",
        );
        if (bytes + evidence.length + 8192 > L.archiveBytes) throw new Error("E_CAPACITY");
        check();
        const transactionTag = randomBytes(16).toString("hex");
        const transaction = `${paths.archive}/${transactionTag}`;
        await mkdir(`/proc/self/fd/${archive.fd}/${transactionTag}`, { mode: 0o700 });
        check();
        const tx = await directory(transaction);
        try {
          check();
          const file = await open(
            `/proc/self/fd/${tx.fd}/evidence.json`,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          let writtenIdentity: { dev: number; ino: number };
          try {
            check();
            await file.writeFile(evidence);
            await file.sync();
            const st = await file.stat();
            writtenIdentity = { dev: st.dev, ino: st.ino };
          } finally {
            await file.close();
          }
          await tx.sync();
          await archive.sync();
          await parent.sync();
          const after = await probe();
          check();
          const root = await lstat(paths.archive),
            base = await lstat(resolve(deps.stateDir)),
            held = await parent.stat();
          if (
            JSON.stringify(after) !== JSON.stringify(before) ||
            root.ino !== rootStat.ino ||
            root.dev !== rootStat.dev ||
            base.ino !== held.ino ||
            base.dev !== held.dev
          )
            throw new Error("E_KERNEL");
          const txPath = await lstat(transaction),
            txHeld = await tx.stat();
          if (
            txPath.ino !== txHeld.ino ||
            txPath.dev !== txHeld.dev ||
            !txPath.isDirectory() ||
            txPath.uid !== uid ||
            (txPath.mode & 0o777) !== 0o700
          )
            throw new Error("E_ARCHIVE");
          const verify = await open(
            `/proc/self/fd/${tx.fd}/evidence.json`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const st = await verify.stat();
            if (
              st.ino !== writtenIdentity.ino ||
              st.dev !== writtenIdentity.dev ||
              !st.isFile() ||
              st.uid !== uid ||
              (st.mode & 0o777) !== 0o600 ||
              st.nlink !== 1 ||
              st.size !== evidence.length
            )
              throw new Error("E_ARCHIVE");
            const bytes = Buffer.alloc(evidence.length + 1);
            const read = await verify.read(bytes, 0, bytes.length, 0);
            if (read.bytesRead !== evidence.length || !bytes.subarray(0, read.bytesRead).equals(evidence))
              throw new Error("E_ARCHIVE");
          } finally {
            await verify.close();
          }
          if (uid === undefined) throw new Error("E_ARCHIVE");
          finalGuard = evidenceGuardV2({
            directories: [
              { path: resolve(deps.stateDir), dev: held.dev, ino: held.ino },
              { path: paths.archive, dev: rootStat.dev, ino: rootStat.ino },
              { path: transaction, dev: txHeld.dev, ino: txHeld.ino },
            ],
            filePath: `${transaction}/evidence.json`,
            identity: writtenIdentity,
            bytes: evidence,
            uid,
            signal: controller.signal,
            at,
          });
          const exact = new Set(eligible.map((a) => a.allocationId));
          const next: LedgerV2 = {
            ...ledger,
            revision: ledger.revision + 1,
            allocations: ledger.allocations.filter((a) => !exact.has(a.allocationId)),
          };
          check();
          pruneEntered = true;
          const result = await deps.ledger.commitGuarded(ledger.revision, next, controller.signal, finalGuard);
          if (result.kind === "committed") {
            // Prepared evidence never proves a prune. Only this actual committed result
            // may start completion publication. Surviving names still need a maintenance
            // reader's current-window durability normalization before rollback approval.
            check();
            finalGuard();
            const completion = Buffer.from(
              JSON.stringify({
                v: 2,
                kind: "old-kernel-allocation-retirement-committed",
                transactionId: transactionTag,
                storeId: ledger.storeId,
                evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
                beforeRevision: ledger.revision,
                afterRevision: next.revision,
                removedAllocationIds: eligible.map((a) => a.allocationId),
              }) + "\n",
            );
            if (completion.length > 8192) throw new Error("E_ARCHIVE");
            const temp = await open(
              `/proc/self/fd/${tx.fd}/.completion-prepared`,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            let completionIdentity: { dev: number; ino: number };
            try {
              check();
              finalGuard();
              await temp.writeFile(completion);
              check();
              await temp.sync();
              const st = await temp.stat();
              completionIdentity = { dev: st.dev, ino: st.ino };
            } finally {
              await temp.close();
            }
            check();
            finalGuard();
            const preparedGuard = evidenceGuardV2({
              directories: [
                { path: resolve(deps.stateDir), dev: held.dev, ino: held.ino },
                { path: paths.archive, dev: rootStat.dev, ino: rootStat.ino },
                { path: transaction, dev: txHeld.dev, ino: txHeld.ino },
              ],
              filePath: `${transaction}/.completion-prepared`,
              identity: completionIdentity,
              bytes: completion,
              uid,
              signal: controller.signal,
              at,
            });
            preparedGuard();
            check();
            await rename(`/proc/self/fd/${tx.fd}/.completion-prepared`, `/proc/self/fd/${tx.fd}/completion.json`);
            check();
            await tx.sync();
            check();
            await archive.sync();
            check();
            const evidenceGuard = finalGuard;
            const completionGuard = evidenceGuardV2({
              directories: [
                { path: resolve(deps.stateDir), dev: held.dev, ino: held.ino },
                { path: paths.archive, dev: rootStat.dev, ino: rootStat.ino },
                { path: transaction, dev: txHeld.dev, ino: txHeld.ino },
              ],
              filePath: `${transaction}/completion.json`,
              identity: completionIdentity,
              bytes: completion,
              uid,
              signal: controller.signal,
              at,
            });
            finalGuard = () => {
              evidenceGuard();
              completionGuard();
              return undefined;
            };
            finalGuard();
            return { kind: "retired" as const, count: eligible.length };
          }
          if (result.kind === "unavailable" && result.effect === "none") {
            pruneEntered = false;
            return { kind: "retained" as const, count: eligible.length };
          }
          return { kind: "unavailable" as const };
        } finally {
          await tx.close();
        }
      } finally {
        await archive.close();
      }
    } finally {
      await parent.close();
    }
  })();
  try {
    const result = await boundedV2(work, at, controller.signal);
    // No await may follow this success fence: ledger and retirement fd cleanup are done.
    if (result.kind === "retired") {
      check();
      finalGuard!();
      check();
    }
    return result;
  } catch {
    controller.abort();
    return pruneEntered ? { kind: "unavailable" } : { kind: "retained", count: 0 };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
