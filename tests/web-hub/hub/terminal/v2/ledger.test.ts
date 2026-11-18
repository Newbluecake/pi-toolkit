import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, rename, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mapRetainedObligations } from "../../../../../scripts/web-hub/terminal-v2-retained/mapping.js";
import { createTerminalAllocationLedgerV2 } from "../../../../../src/web-hub/hub/terminal/v2/ledger.js";
import { retireOldKernelAllocationsV2 } from "../../../../../src/web-hub/hub/terminal/v2/retirement.js";
import type { AllocationV2, LedgerV2 } from "../../../../../src/web-hub/protocol/terminal-v2.js";
const roots: string[] = [];
const id = (s: string) => s.repeat(24).slice(0, 24);
const boot = "11111111-1111-4111-8111-111111111111",
  old = "22222222-2222-4222-8222-222222222222";
const signal = () => new AbortController().signal;
const a = (n: string, b = boot): AllocationV2 => ({
  allocationId: id(n),
  termId: id(n.toUpperCase()),
  hubInstance: id("h"),
  kernelBootId: b,
  scope: { agentKey: "a", sessionId: "s", epoch: "e" },
  quotaSessionKey: "s",
  principalKey: "lan:u1",
  creatorSidTag: "a".repeat(43),
});
async function fixture(allocations: AllocationV2[] = [], legacy?: LedgerV2["legacyObligations"]) {
  const root = await mkdtemp(join(tmpdir(), "v2-ledger-"));
  roots.push(root);
  await chmod(root, 0o700);
  await mkdir(join(root, "terminal-v2"), { mode: 0o700 });
  const marker = {
    v: 2,
    storeId: id("s"),
    initialization: legacy === undefined ? "fresh" : "offline-retained-unknown",
    checkpointId: id("c"),
  };
  const ledger: LedgerV2 = {
    v: 2,
    storeId: id("s"),
    revision: 0,
    allocations,
    ...(legacy !== undefined ? { legacyObligations: legacy } : {}),
  };
  const ledgerPath = join(root, "terminal-v2/ledger.json");
  await writeFile(join(root, "terminal-v2/marker.json"), JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(root, ".terminal-initialized-v2"), JSON.stringify(marker), { mode: 0o600 });
  await writeFile(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
  const deps = { stateDir: root, current: () => true };
  return { root, ledgerPath, ledger, deps };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("v2 ledger pure-resource durable CAS", () => {
  it("loads once per identity, appends durably, exact prune and repeated load no double count", async () => {
    const f = await fixture();
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect(await l.load(signal())).toEqual({ kind: "loaded", ledger: f.ledger });
    const next = { ...f.ledger, revision: 1, allocations: [a("a")] };
    expect(await l.commit(0, next, signal())).toEqual({ kind: "committed", revision: 1 });
    expect(JSON.parse(await readFile(f.ledgerPath, "utf8"))).toEqual(next);
    expect(await l.load(signal())).toEqual({ kind: "loaded", ledger: next });
    expect(await l.commit(0, next, signal())).toEqual({ kind: "conflict" });
    expect(await l.commit(1, { ...next, revision: 2, allocations: [] }, signal())).toEqual({
      kind: "committed",
      revision: 2,
    });
    expect((await readdir(join(f.root, "terminal-v2"))).sort()).toEqual(["ledger.json", "marker.json"]);
  });
  it.each([
    "missing-witness",
    "missing-root",
    "json",
    "version",
    "owner-fields",
    "duplicate",
    "quota-key",
    "permissions",
    "symlink",
  ])("rejects %s without heal or reset", async (kind) => {
    const f = await fixture([a("a")]);
    if (kind === "missing-witness") await rm(join(f.root, ".terminal-initialized-v2"));
    if (kind === "missing-root") await rm(join(f.root, "terminal-v2"), { recursive: true });
    if (kind === "json") await writeFile(f.ledgerPath, "{");
    if (kind === "version") await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, v: 1 }));
    if (kind === "owner-fields") {
      const row = { ...a("a"), principalKey: undefined };
      await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, allocations: [row] }));
    }
    if (kind === "duplicate")
      await writeFile(f.ledgerPath, JSON.stringify({ ...f.ledger, allocations: [a("a"), a("a")] }));
    if (kind === "quota-key")
      await writeFile(
        f.ledgerPath,
        JSON.stringify({ ...f.ledger, allocations: [{ ...a("a"), quotaSessionKey: "other" }] }),
      );
    if (kind === "permissions") await chmod(f.ledgerPath, 0o644);
    if (kind === "symlink") {
      await rename(f.ledgerPath, `${f.ledgerPath}.real`);
      await symlink(`${f.ledgerPath}.real`, f.ledgerPath);
    }
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect(await l.load(signal())).toEqual({ kind: "unavailable" });
    expect(await l.commit(0, { ...f.ledger, revision: 1, allocations: [] }, signal())).toEqual({
      kind: "unavailable",
      effect: "none",
    });
  });
  it("semantic equal marker/witness accepted initially, equivalent byte replacement rejected at runtime", async () => {
    const f = await fixture();
    const witness = join(f.root, ".terminal-initialized-v2");
    const m = JSON.parse(await readFile(witness, "utf8"));
    await writeFile(
      witness,
      JSON.stringify({ checkpointId: m.checkpointId, initialization: m.initialization, storeId: m.storeId, v: m.v }),
    );
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect((await l.load(signal())).kind).toBe("loaded");
    await writeFile(`${witness}.swap`, await readFile(witness), { mode: 0o600 });
    await rename(`${witness}.swap`, witness);
    expect(await l.commit(0, { ...f.ledger, revision: 1 }, signal())).toEqual({ kind: "unavailable", effect: "none" });
    expect(await l.load(signal())).toEqual({ kind: "unavailable" });
  });
  it("directory identity remains pinned even when original file inodes/bytes move into replacement root", async () => {
    const f = await fixture();
    const l = createTerminalAllocationLedgerV2(f.deps);
    await l.load(signal());
    const root = join(f.root, "terminal-v2"),
      oldRoot = join(f.root, "moved");
    await rename(root, oldRoot);
    await mkdir(root, { mode: 0o700 });
    await rename(join(oldRoot, "marker.json"), join(root, "marker.json"));
    await rename(join(oldRoot, "ledger.json"), join(root, "ledger.json"));
    expect(await l.commit(0, { ...f.ledger, revision: 1 }, signal())).toEqual({ kind: "unavailable", effect: "none" });
    expect((await l.load(signal())).kind).toBe("unavailable");
  });
  it.each(["temp-sync", "before-rename", "after-rename", "parent-sync"] as const)(
    "fault at %s conservatively classifies commit",
    async (stage) => {
      const f = await fixture();
      let fail = true;
      const l = createTerminalAllocationLedgerV2({
        ...f.deps,
        stage: async (s) => {
          if (s === stage && fail) throw new Error("ENOSPC");
        },
      });
      await l.load(signal());
      const next = { ...f.ledger, revision: 1, allocations: [a("a")] };
      const unknown = stage === "after-rename" || stage === "parent-sync";
      expect(await l.commit(0, next, signal())).toEqual({ kind: "unavailable", effect: unknown ? "unknown" : "none" });
      expect(JSON.parse(await readFile(f.ledgerPath, "utf8"))).toEqual(unknown ? next : f.ledger);
      fail = false;
      expect(await l.commit(0, next, signal())).toEqual(
        unknown ? { kind: "unavailable", effect: "none" } : { kind: "committed", revision: 1 },
      );
    },
  );
  it("abort before rename seals late work, cannot mutate or overwrite new lifetime", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const l = createTerminalAllocationLedgerV2({
      ...f.deps,
      stage: async (s) => {
        if (s === "before-rename") {
          entered();
          await gate;
        }
      },
    });
    await l.load(signal());
    const abort = new AbortController();
    const work = l.commit(0, { ...f.ledger, revision: 1, allocations: [a("a")] }, abort.signal);
    await entry;
    abort.abort();
    expect(await work).toEqual({ kind: "unavailable", effect: "none" });
    release();
    // Wait for actual late IO settlement, not a guessed sleep.
    await gate;
    await Promise.resolve();
    expect(JSON.parse(await readFile(f.ledgerPath, "utf8"))).toEqual(f.ledger);
  });
  it("no v1 import/read required: unreadable legacy paths don't participate", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "terminal-v1"), { mode: 0o000 });
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect((await l.load(signal())).kind).toBe("loaded");
    expect(await l.commit(0, { ...f.ledger, revision: 1 }, signal())).toEqual({ kind: "committed", revision: 1 });
    await chmod(join(f.root, "terminal-v1"), 0o700);
  });
});
describe("old-kernel evidence retirement (simulated UUID, not real reboot)", () => {
  const kernelEvidence = async () => ({
    bootId: boot,
    pidNamespace: "pid:[1]",
    mountNamespace: "mnt:[2]",
    userNamespace: "user:[3]",
  });
  it("mixed eligible/current retains current unknown and durably archives exact old rows first", async () => {
    const f = await fixture([a("a", old), a("b")]);
    const l = createTerminalAllocationLedgerV2(f.deps);
    const result = await retireOldKernelAllocationsV2({ ...f.deps, ledger: l, kernelEvidence }, signal());
    expect(result).toEqual({ kind: "retired", count: 1 });
    expect(JSON.parse(await readFile(f.ledgerPath, "utf8")).allocations).toEqual([a("b")]);
    const archive = join(f.root, ".terminal-allocation-archive-v2"),
      entries = await readdir(archive);
    expect(entries).toHaveLength(1);
    const evidence = JSON.parse(await readFile(join(archive, entries[0]!, "evidence.json"), "utf8"));
    expect(evidence.eligible).toEqual([a("a", old)]);
    expect(evidence.ledger).toEqual(f.ledger);
  });
  it("same kernel never releases, regardless of restart/TTL/no backend", async () => {
    const f = await fixture([a("a")]);
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect(await retireOldKernelAllocationsV2({ ...f.deps, ledger: l, kernelEvidence }, signal())).toEqual({
      kind: "unchanged",
      count: 0,
    });
    expect(JSON.parse(await readFile(f.ledgerPath, "utf8"))).toEqual(f.ledger);
  });
  it("archive preparation failure retains old rows but leaves ledger usable for available balance", async () => {
    const f = await fixture([a("a", old)]);
    await writeFile(join(f.root, ".terminal-allocation-archive-v2"), "blocked", { mode: 0o600 });
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect((await retireOldKernelAllocationsV2({ ...f.deps, ledger: l, kernelEvidence }, signal())).kind).toBe(
      "retained",
    );
    expect(await l.commit(0, { ...f.ledger, revision: 1, allocations: [a("a", old), a("b")] }, signal())).toEqual({
      kind: "committed",
      revision: 1,
    });
  });
  it("archive transaction capacity including empty partials retains quota without poisoning writes", async () => {
    const f = await fixture([a("a", old)]),
      archive = join(f.root, ".terminal-allocation-archive-v2");
    await mkdir(archive, { mode: 0o700 });
    for (let n = 0; n < 64; n++) await mkdir(join(archive, n.toString(16).padStart(32, "0")), { mode: 0o700 });
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect((await retireOldKernelAllocationsV2({ ...f.deps, ledger: l, kernelEvidence }, signal())).kind).toBe(
      "retained",
    );
    expect(await l.commit(0, { ...f.ledger, revision: 1, allocations: [a("a", old), a("b")] }, signal())).toEqual({
      kind: "committed",
      revision: 1,
    });
  });
  it("retirement prune unknown poisons resource admission, never guesses release from archive", async () => {
    const f = await fixture([a("a", old), a("b")]);
    const l = createTerminalAllocationLedgerV2({
      ...f.deps,
      stage: async (stage) => {
        if (stage === "parent-sync") throw new Error("EIO");
      },
    });
    expect(await retireOldKernelAllocationsV2({ ...f.deps, ledger: l, kernelEvidence }, signal())).toEqual({
      kind: "unavailable",
    });
    expect(await l.load(signal())).toEqual({ kind: "unavailable" });
    // The new bytes may be visible but an uncertain fsync is not a resource admission fact.
    expect(JSON.parse(await readFile(f.ledgerPath, "utf8")).allocations).toEqual([a("b")]);
  });
  it("singleton loss/proc failure forbids retirement", async () => {
    const f = await fixture([a("a", old)]);
    const l = createTerminalAllocationLedgerV2(f.deps);
    expect(
      (await retireOldKernelAllocationsV2({ ...f.deps, ledger: l, current: () => false, kernelEvidence }, signal()))
        .kind,
    ).toBe("retained");
    expect(
      (
        await retireOldKernelAllocationsV2(
          {
            ...f.deps,
            ledger: l,
            kernelEvidence: async () => {
              throw new Error("proc");
            },
          },
          signal(),
        )
      ).kind,
    ).toBe("retained");
    expect(JSON.parse(await readFile(f.ledgerPath, "utf8"))).toEqual(f.ledger);
  });
});

function legacyRows() {
  return mapRetainedObligations("a".repeat(64), "b".repeat(64), [
    {
      identity: {
        agentSessionId: "s",
        termId: "legacy",
        epoch: "e",
        ownerInstance: "owner",
        reservationId: "reservation",
      },
      recordKey: "terminal-v1/terminal-resource-fence-v1.json#resources/0",
      sessionVerified: true,
      bootId: boot,
    },
  ]);
}
it("plain ledger reserve/prune cannot drop or rewrite L, retained marker required and normal writer remains usable", async () => {
  const rows = legacyRows(),
    f = await fixture([], rows),
    l = createTerminalAllocationLedgerV2(f.deps);
  expect((await l.load(signal())).kind).toBe("loaded");
  expect(await l.commit(0, { ...f.ledger, revision: 1, legacyObligations: [] }, signal())).toEqual({
    kind: "unavailable",
    effect: "none",
  });
  expect(await l.commit(0, { ...f.ledger, revision: 1, allocations: [a("a")] }, signal())).toEqual({
    kind: "committed",
    revision: 1,
  });
  expect(JSON.parse(await readFile(f.ledgerPath, "utf8")).legacyObligations).toEqual(rows);
  const bad = await fixture([], rows);
  const marker = JSON.parse(await readFile(join(bad.root, "terminal-v2/marker.json"), "utf8"));
  marker.initialization = "fresh";
  for (const file of [join(bad.root, "terminal-v2/marker.json"), join(bad.root, ".terminal-initialized-v2")])
    await writeFile(file, JSON.stringify(marker));
  expect(await createTerminalAllocationLedgerV2(bad.deps).load(signal())).toEqual({ kind: "unavailable" });
});
it("retained same boot and unknown boot never retire; simulated genuine boot change produces exact legacy CAS/completion", async () => {
  const rows = legacyRows();
  rows.push({
    ...rows[0]!,
    obligationId: "c".repeat(64),
    legacyIdentity: { ...rows[0]!.legacyIdentity, reservationId: "unknown" },
    kernelBinding: { kind: "unknown" },
  });
  const f = await fixture([], rows),
    l = createTerminalAllocationLedgerV2(f.deps);
  const { currentKernelEvidenceV2 } = await import("../../../../../src/web-hub/hub/terminal/v2/retirement.js");
  const actual = await currentKernelEvidenceV2();
  const first = await retireOldKernelAllocationsV2(
    { ...f.deps, ledger: l, kernelEvidence: async () => ({ ...actual, bootId: boot }) },
    signal(),
  );
  expect(first).toEqual({ kind: "unchanged", count: 0 });
  const changed = await retireOldKernelAllocationsV2(
    { ...f.deps, ledger: l, kernelEvidence: async () => ({ ...actual, bootId: old }) },
    signal(),
  );
  expect(changed).toEqual({ kind: "retired", count: 1 });
  const persisted = JSON.parse(await readFile(f.ledgerPath, "utf8"));
  expect(persisted.legacyObligations).toEqual([rows[1]]);
  const root = join(f.root, ".terminal-allocation-archive-v2"),
    tx = (await readdir(root))[0]!;
  const completion = JSON.parse(await readFile(join(root, tx, "completion.json"), "utf8"));
  expect(completion.removedLegacyObligationIds).toEqual([rows[0]!.obligationId]);
  expect(completion.removedAllocationIds).toEqual([]);
});
