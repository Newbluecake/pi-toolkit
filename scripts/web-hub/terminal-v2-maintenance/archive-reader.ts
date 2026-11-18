/** Tool-only old-kernel archive audit. A parseable completion is NOT a historical
 * fsync receipt. Under the caller's real drained maintenance lease we re-fsync the
 * exact files/directories and recheck all pins in THIS window. No replay or deletion. */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { terminalLedgerV2Ok, type LedgerV2 } from "../../../src/web-hub/protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L } from "../../../src/web-hub/protocol/terminal-v2-values.js";
import { fail } from "./audit.js";
import { HeldDirectory, digest, exactKeys, parse } from "./files.js";
import type { SnapshotFile } from "./legacy-reader.js";
const NAME = ".terminal-allocation-archive-v2";
const hasField = (value: unknown, key: string): boolean =>
  typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
function kernel() {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidNamespace = readlinkSync("/proc/self/ns/pid"),
    mountNamespace = readlinkSync("/proc/self/ns/mnt"),
    userNamespace = readlinkSync("/proc/self/ns/user");
  if (
    !lstatSync("/proc").isDirectory() ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bootId) ||
    !/^pid:\[\d+\]$/.test(pidNamespace) ||
    !/^mnt:\[\d+\]$/.test(mountNamespace) ||
    !/^user:\[\d+\]$/.test(userNamespace)
  )
    fail("archive-kernel-unproven");
  return { bootId, pidNamespace, mountNamespace, userNamespace };
}
export interface RetirementArchive {
  files: SnapshotFile[];
  verify(): void;
  proveDurable(guard: () => void): void;
  close(): void;
}
export function readRetirementArchive(state: HeldDirectory, ledger?: LedgerV2): RetirementArchive {
  if (state.absent(NAME))
    return {
      files: [],
      verify() {
        if (!state.absent(NAME)) fail("archive-changed");
      },
      proveDurable() {},
      close() {},
    };
  if (!ledger) fail("archive-without-v2-ledger");
  const root = new HeldDirectory(join(state.path, NAME)),
    directories: HeldDirectory[] = [root];
  try {
    const names = root.names();
    if (names.length > L.archiveTransactions) fail("archive-capacity");
    const observed = kernel(),
      files: SnapshotFile[] = [],
      removed = new Set<string>(),
      revisions = new Set<number>();
    let bytes = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{32}$/.test(name)) fail("unknown-archive-layout");
      const tx = new HeldDirectory(join(root.path, name));
      directories.push(tx);
      // Missing completion, a prepared temp or any unknown member is deliberately
      // not repaired/adopted, even if the live ledger happens to be empty.
      if (tx.names().join(",") !== "completion.json,evidence.json") fail("incomplete-retirement-archive");
      const evidenceFile = tx.read("evidence.json", 2 * L.ledgerBytes + 4096),
        completionFile = tx.read("completion.json", 8192),
        evidence = parse(evidenceFile.bytes),
        completion = parse(completionFile.bytes);
      bytes += evidenceFile.bytes.length + completionFile.bytes.length;
      if (bytes > L.archiveBytes) fail("archive-capacity");
      if (
        !exactKeys(evidence, [
          "v",
          "kind",
          "kernel",
          "ledger",
          "eligible",
          ...(hasField(evidence, "eligibleLegacy") ? ["eligibleLegacy"] : []),
        ]) ||
        evidence.v !== 2 ||
        evidence.kind !== "old-kernel-allocation-retirement" ||
        !exactKeys(evidence.kernel, ["bootId", "pidNamespace", "mountNamespace", "userNamespace"]) ||
        typeof evidence.kernel.bootId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(evidence.kernel.bootId) ||
        typeof evidence.kernel.pidNamespace !== "string" ||
        !/^pid:\[\d+\]$/.test(evidence.kernel.pidNamespace) ||
        typeof evidence.kernel.mountNamespace !== "string" ||
        !/^mnt:\[\d+\]$/.test(evidence.kernel.mountNamespace) ||
        typeof evidence.kernel.userNamespace !== "string" ||
        !/^user:\[\d+\]$/.test(evidence.kernel.userNamespace) ||
        (evidence.kernel.bootId === observed.bootId &&
          (evidence.kernel.pidNamespace !== observed.pidNamespace ||
            evidence.kernel.mountNamespace !== observed.mountNamespace ||
            evidence.kernel.userNamespace !== observed.userNamespace)) ||
        !terminalLedgerV2Ok(evidence.ledger) ||
        evidence.ledger.storeId !== ledger.storeId ||
        !Array.isArray(evidence.eligible)
      )
        fail("invalid-retirement-evidence");
      const archivedKernel = evidence.kernel.bootId;
      const eligible = evidence.ledger.allocations.filter((a) => a.kernelBootId !== archivedKernel);
      // Archives survive subsequent boots, but can never release a row belonging
      // to the maintenance reader's actual current kernel.
      if (eligible.some((a) => a.kernelBootId === observed.bootId)) fail("archive-current-kernel-row");
      const eligibleLegacy = (evidence.ledger.legacyObligations ?? []).filter(
        (row) => row.kernelBinding.kind === "known" && row.kernelBinding.bootId !== archivedKernel,
      );
      if (
        eligibleLegacy.some((row) => row.kernelBinding.kind !== "known" || row.kernelBinding.bootId === observed.bootId)
      )
        fail("archive-current-kernel-row");
      if (
        (eligibleLegacy.length
          ? JSON.stringify(eligibleLegacy) !== JSON.stringify(evidence.eligibleLegacy)
          : hasField(evidence, "eligibleLegacy")) ||
        (!eligible.length && !eligibleLegacy.length) ||
        JSON.stringify(eligible) !== JSON.stringify(evidence.eligible)
      )
        fail("invalid-retirement-set");
      if (
        !exactKeys(completion, [
          "v",
          "kind",
          "transactionId",
          "storeId",
          "evidenceSha256",
          "beforeRevision",
          "afterRevision",
          "removedAllocationIds",
          ...(hasField(completion, "removedLegacyObligationIds") ? ["removedLegacyObligationIds"] : []),
        ]) ||
        completion.v !== 2 ||
        completion.kind !== "old-kernel-allocation-retirement-committed" ||
        completion.transactionId !== name ||
        completion.storeId !== ledger.storeId ||
        completion.evidenceSha256 !== digest(evidenceFile.bytes) ||
        completion.beforeRevision !== evidence.ledger.revision ||
        completion.afterRevision !== evidence.ledger.revision + 1 ||
        !Number.isSafeInteger(completion.afterRevision) ||
        ledger.revision < (completion.afterRevision as number) ||
        JSON.stringify(completion.removedAllocationIds) !== JSON.stringify(eligible.map((a) => a.allocationId)) ||
        (eligibleLegacy.length
          ? JSON.stringify(completion.removedLegacyObligationIds) !==
            JSON.stringify(eligibleLegacy.map((row) => row.obligationId))
          : hasField(completion, "removedLegacyObligationIds")) ||
        revisions.has(evidence.ledger.revision)
      )
        fail("invalid-retirement-completion");
      revisions.add(evidence.ledger.revision);
      for (const row of eligible) {
        if (removed.has(row.allocationId) || ledger.allocations.some((a) => a.allocationId === row.allocationId))
          fail("retirement-row-still-present-or-reused");
        removed.add(row.allocationId);
      }
      for (const row of eligibleLegacy) {
        if (
          removed.has(row.obligationId) ||
          (ledger.legacyObligations ?? []).some((current) => current.obligationId === row.obligationId)
        )
          fail("retirement-row-still-present-or-reused");
        removed.add(row.obligationId);
      }
      for (const file of [evidenceFile, completionFile])
        files.push({ path: `${NAME}/${name}/${file.name}`, directory: tx, file });
    }
    const verify = () => {
      if (root.names().join(",") !== names.join(",") || JSON.stringify(kernel()) !== JSON.stringify(observed))
        fail("archive-changed");
      for (const tx of directories.slice(1))
        if (tx.names().join(",") !== "completion.json,evidence.json") fail("archive-changed");
      for (const file of files) file.directory.verify(file.file);
    };
    return {
      files,
      verify,
      proveDurable(guard) {
        guard();
        verify();
        for (const file of files) {
          guard();
          file.directory.syncFile(file.file);
          guard();
        }
        for (const directory of [...directories].reverse()) {
          guard();
          directory.sync();
          guard();
        }
        state.sync();
        guard();
        verify();
      },
      close() {
        for (const directory of [...directories].reverse()) directory.close();
      },
    };
  } catch (e) {
    for (const directory of directories.reverse()) directory.close();
    throw e;
  }
}
