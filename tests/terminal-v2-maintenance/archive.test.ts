/** Real private fs + real guarded ledger/retirement, simulated old UUID and audit
 * drain double. NOT a real reboot, O/N maintenance adapter or full O→N→O evidence. */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointTerminalV2 } from "../../scripts/web-hub/terminal-v2-checkpoint.js";
import { rollbackTerminalV2 } from "../../scripts/web-hub/terminal-v2-rollback.js";
import { createTerminalAllocationLedgerV2 } from "../../src/web-hub/hub/terminal/v2/ledger.js";
import { currentKernelEvidenceV2, retireOldKernelAllocationsV2 } from "../../src/web-hub/hub/terminal/v2/retirement.js";
import { HeldDirectory, digest } from "../../scripts/web-hub/terminal-v2-maintenance/files.js";
import { readRetirementArchive } from "../../scripts/web-hub/terminal-v2-maintenance/archive-reader.js";
import type { AllocationV2, LedgerV2 } from "../../src/web-hub/protocol/terminal-v2.js";
import { legacyLayout, put, setup, tree } from "./helpers.js";
async function fixture() {
  const h = setup();
  legacyLayout(h.stateDir);
  await checkpointTerminalV2("checkpoint", h.options);
  const path = join(h.stateDir, "terminal-v2/ledger.json");
  const initial: LedgerV2 = JSON.parse(readFileSync(path, "utf8"));
  const kernel = await currentKernelEvidenceV2();
  const old =
    kernel.bootId === "11111111-1111-4111-8111-111111111111"
      ? "22222222-2222-4222-8222-222222222222"
      : "11111111-1111-4111-8111-111111111111";
  const row: AllocationV2 = {
    allocationId: "a".repeat(24),
    termId: "t".repeat(24),
    kernelBootId: old,
    hubInstance: "h".repeat(24),
    scope: { agentKey: "a", sessionId: "s", epoch: "e" },
    quotaSessionKey: "s",
    principalKey: "lan:u",
    creatorSidTag: "a".repeat(43),
  };
  put(path, { ...initial, revision: 1, allocations: [row] });
  const ledger = createTerminalAllocationLedgerV2({ stateDir: h.stateDir, current: () => true });
  expect(
    await retireOldKernelAllocationsV2(
      { stateDir: h.stateDir, ledger, current: () => true },
      new AbortController().signal,
    ),
  ).toEqual({ kind: "retired", count: 1 });
  h.audit.nextRevision = 2;
  const root = join(h.stateDir, ".terminal-allocation-archive-v2"),
    tx = join(root, readdirSync(root)[0]!);
  const evidencePath = join(tx, "evidence.json"),
    completionPath = join(tx, "completion.json");
  return { ...h, path, root, tx, evidencePath, completionPath, row, ledger };
}
describe("P6 strict retirement archive reader and current-window normalization", () => {
  it("consumes real committed completion and preserves all v1/v2/archive bytes during rollback eligibility", async () => {
    const h = await fixture(),
      before = tree(h.stateDir);
    const completion = JSON.parse(readFileSync(h.completionPath, "utf8"));
    expect(completion).toMatchObject({
      beforeRevision: 1,
      afterRevision: 2,
      removedAllocationIds: [h.row.allocationId],
    });
    const result = await rollbackTerminalV2(h.options);
    expect(result.outcome).toBe("rollback-eligible");
    expect(tree(h.stateDir)).toEqual(before);
    const prepared = JSON.parse(readFileSync(join(h.evidenceDir, result.transaction, "prepared.json"), "utf8"));
    expect(prepared.files.filter((f: { path: string }) => f.path.includes("archive-v2/"))).toHaveLength(2);
    expect((await rollbackTerminalV2(h.options)).outcome).toBe("already-complete");
    expect(tree(h.stateDir)).toEqual(before);
  });
  it.each([
    "missing-completion",
    "partial-temp",
    "bad-hash",
    "bad-store",
    "bad-tx",
    "bad-before",
    "bad-after",
    "bad-set",
    "extra-key",
    "kernel-mismatch",
    "eligible-mismatch",
    "prepared-only",
    "unknown-layout",
    "current-row",
  ])("rejects %s without replay, repair or any additional bytes", async (fault) => {
    const h = await fixture();
    const c = JSON.parse(readFileSync(h.completionPath, "utf8")),
      e = JSON.parse(readFileSync(h.evidencePath, "utf8"));
    if (fault === "missing-completion") unlinkSync(h.completionPath);
    if (fault === "partial-temp") put(join(h.tx, ".completion-prepared"), c);
    if (fault === "bad-hash") put(h.completionPath, { ...c, evidenceSha256: "0".repeat(64) });
    if (fault === "bad-store") put(h.completionPath, { ...c, storeId: "b".repeat(24) });
    if (fault === "bad-tx") put(h.completionPath, { ...c, transactionId: "0".repeat(32) });
    if (fault === "bad-before") put(h.completionPath, { ...c, beforeRevision: 0 });
    if (fault === "bad-after") put(h.completionPath, { ...c, afterRevision: 3 });
    if (fault === "bad-set") put(h.completionPath, { ...c, removedAllocationIds: [] });
    if (fault === "extra-key") put(h.completionPath, { ...c, approved: true });
    if (fault === "kernel-mismatch") put(h.evidencePath, { ...e, kernel: { ...e.kernel, pidNamespace: "pid:[1]" } });
    if (fault === "eligible-mismatch") put(h.evidencePath, { ...e, eligible: [] });
    if (fault === "prepared-only") renameSync(h.completionPath, join(h.tx, ".completion-prepared"));
    if (fault === "unknown-layout") mkdirSync(join(h.root, "foreign"), { mode: 0o700 });
    if (fault === "current-row") {
      const l = JSON.parse(readFileSync(h.path, "utf8"));
      put(h.path, { ...l, allocations: [h.row] });
    }
    const before = tree(h.base);
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({ effect: "none" });
    expect(tree(h.base)).toEqual(before);
  });
  it("accepts a completed archive from an earlier retirement boot, never an actual current-kernel removed row", async () => {
    const h = await fixture();
    const evidence = JSON.parse(readFileSync(h.evidencePath, "utf8"));
    const completion = JSON.parse(readFileSync(h.completionPath, "utf8"));
    // Synthetic earlier retirement kernel, distinct from both actual current and row boot.
    evidence.kernel.bootId = "33333333-3333-4333-8333-333333333333";
    put(h.evidencePath, evidence);
    put(h.completionPath, { ...completion, evidenceSha256: digest(readFileSync(h.evidencePath)) });
    expect((await rollbackTerminalV2(h.options)).outcome).toBe("rollback-eligible");
    const actual = await currentKernelEvidenceV2();
    evidence.ledger.allocations[0].kernelBootId = actual.bootId;
    evidence.eligible[0].kernelBootId = actual.bootId;
    put(h.evidencePath, evidence);
    put(h.completionPath, { ...completion, evidenceSha256: digest(readFileSync(h.evidencePath)) });
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({
      code: "archive-current-kernel-row",
      effect: "none",
    });
  });
  it("pins original inode, not just the digest of equivalent completion bytes across revalidate", async () => {
    const h = await fixture();
    let replaced = false;
    h.audit.onRevalidate = () => {
      if (replaced) return;
      replaced = true;
      const replacement = join(h.tx, "replacement");
      writeFileSync(replacement, readFileSync(h.completionPath), { mode: 0o600 });
      renameSync(replacement, h.completionPath);
    };
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({ code: "file-changed", effect: "none" });
    expect(replaced).toBe(true);
  });
  it("re-fsyncs exact completion/evidence and both directory levels; a failure is not proof", async () => {
    const h = await fixture(),
      state = new HeldDirectory(h.stateDir);
    const ledger: LedgerV2 = JSON.parse(readFileSync(h.path, "utf8"));
    const archive = readRetirementArchive(state, ledger),
      synced: string[] = [];
    try {
      const directory = archive.files[0]!.directory;
      const original = directory.syncFile.bind(directory);
      directory.syncFile = (file, links) => {
        synced.push(file.name);
        original(file, links);
        if (file.name === "completion.json") throw new Error("simulated fsync failure after actual syscall");
      };
      expect(() => archive.proveDurable(() => {})).toThrow("simulated fsync failure");
      expect(synced).toEqual(["evidence.json", "completion.json"]);
    } finally {
      archive.close();
      state.close();
    }
  });
});
