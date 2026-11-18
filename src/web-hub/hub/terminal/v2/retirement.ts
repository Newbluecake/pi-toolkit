/** Cold old-kernel retirement only: durable evidence BEFORE exact atomic prune.
 * Same-kernel unknown never released; archive failure keeps rows and does not poison ledger.
 * P6 runs under existing singleton BEFORE service.initialize (no hot backend at this point). */
import { constants } from "node:fs";
import { open, lstat, realpath, mkdir, readdir, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { TerminalAllocationLedgerPortV2 } from "../../terminal-v2-ports.js";
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
export async function retireOldKernelAllocationsV2(
  deps: {
    stateDir: string;
    ledger: TerminalAllocationLedgerPortV2;
    current(): boolean;
    /** Test-only simulated boot/proc evidence; never env/config/wire. UUID fixtures are NOT real reboot evidence. */
    kernelEvidence?(): Promise<KernelEvidenceV2>;
  },
  signal: AbortSignal,
): Promise<{ kind: "unchanged" | "retired" | "retained"; count: number } | { kind: "unavailable" }> {
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const at = Date.now() + L.contextMs;
  const check = () => {
    if (controller.signal.aborted || Date.now() >= at || !deps.current()) throw new Error("E_STOP");
  };
  let pruneEntered = false;
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
            if (files.length > 1 || files.some((f) => f !== "evidence.json")) throw new Error("E_ARCHIVE");
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
        if (bytes + evidence.length > L.archiveBytes) throw new Error("E_CAPACITY");
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
          const exact = new Set(eligible.map((a) => a.allocationId));
          const next: LedgerV2 = {
            ...ledger,
            revision: ledger.revision + 1,
            allocations: ledger.allocations.filter((a) => !exact.has(a.allocationId)),
          };
          check();
          pruneEntered = true;
          const result = await deps.ledger.commit(ledger.revision, next, controller.signal);
          if (result.kind === "committed") return { kind: "retired" as const, count: eligible.length };
          if (result.kind === "unavailable" && result.effect === "none")
            return { kind: "retained" as const, count: eligible.length };
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
    return await boundedV2(work, at, controller.signal);
  } catch {
    controller.abort();
    return pruneEntered ? { kind: "unavailable" } : { kind: "retained", count: 0 };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
