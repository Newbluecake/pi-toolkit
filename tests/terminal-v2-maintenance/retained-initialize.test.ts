/** Retained transaction component tests with real private fs. Guard is explicitly
 * a component double, not evidence of real producer/singleton sealing. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HeldDirectory } from "../../scripts/web-hub/terminal-v2-maintenance/files.js";
import { initializeRetained } from "../../scripts/web-hub/terminal-v2-retained/engine.js";
import { legacyLayout, put, setup, tree } from "./helpers.js";
function fixture(count = 1) {
  const h = setup();
  legacyLayout(h.stateDir);
  const installationPath = join(h.base, "installation");
  mkdirSync(installationPath, { mode: 0o700 });
  const path = join(h.stateDir, "terminal-v1/terminal-resource-fence-v1.json");
  put(path, {
    v: 1,
    revision: 4,
    resources: Array.from({ length: count }, (_, i) => ({
      entry: {
        identity: {
          agentSessionId: `old-session-${i}`,
          termId: `term-${i}`,
          epoch: "epoch",
          ownerInstance: "owner",
          reservationId: `r${i}`,
        },
        agentProcessIdentity: {
          bootId: "11111111-1111-4111-8111-111111111111",
          pid: 123,
          starttime: "1",
          uid: process.getuid!(),
        },
        managed: [],
        spawnState: "settled",
        state: "live",
      },
      status: "unresolved",
    })),
  });
  let calls = 0,
    valid = true;
  const open = () => {
    const state = new HeldDirectory(h.stateDir),
      installation = new HeldDirectory(installationPath),
      evidence = new HeldDirectory(h.evidenceDir);
    return {
      state,
      installation,
      evidence,
      guard() {
        calls++;
        if (!valid) throw new Error("owned-guard-lost");
      },
      close() {
        evidence.close();
        installation.close();
        state.close();
      },
    };
  };
  return {
    ...h,
    path,
    installationPath,
    open,
    calls: () => calls,
    lose: () => {
      valid = false;
    },
  };
}
it.each([0, 1, 2, 9, 32])(
  "initializes exact retained obligations (%s), stable across independent handles and never publishes",
  (count) => {
    const h = fixture(count),
      old = tree(join(h.stateDir, "terminal-v1"));
    const first = h.open();
    let operation: string, ids: string[], installationId: string;
    try {
      const result = initializeRetained(first);
      operation = result.operationId;
      installationId = result.sourceInstallationId;
      expect(result).toMatchObject({
        phase: "initialization-complete",
        publication: "not-asserted",
        outcome: "committed",
        legacyObligations: count,
        normalAllocations: 0,
      });
      const ledger = JSON.parse(readFileSync(join(h.stateDir, "terminal-v2/ledger.json"), "utf8"));
      expect(ledger.allocations).toEqual([]);
      expect(ledger.legacyObligations).toHaveLength(count);
      ids = ledger.legacyObligations.map((r: { obligationId: string }) => r.obligationId);
      expect(JSON.parse(readFileSync(join(h.stateDir, "terminal-v2/marker.json"), "utf8")).initialization).toBe(
        "offline-retained-unknown",
      );
      expect(ledger.legacyObligations.every((r: object) => !("principalKey" in r) && !("scope" in r))).toBe(true);
    } finally {
      first.close();
    }
    const before = tree(h.base),
      second = h.open();
    try {
      const result = initializeRetained(second);
      expect(result.operationId).toBe(operation!);
      expect(result.sourceInstallationId).toBe(installationId!);
      expect(result.outcome).toBe("already-complete");
      const ledger = JSON.parse(readFileSync(join(h.stateDir, "terminal-v2/ledger.json"), "utf8"));
      expect(ledger.legacyObligations.map((r: { obligationId: string }) => r.obligationId)).toEqual(ids!);
      expect(tree(h.base)).toEqual(before);
      expect(tree(join(h.stateDir, "terminal-v1"))).toEqual(old);
      expect(h.calls()).toBeGreaterThan(20);
    } finally {
      second.close();
    }
  },
);
it("completed retry preserves subsequent normal allocations and revision, not initial A=[]", () => {
  const h = fixture(),
    first = h.open();
  try {
    initializeRetained(first);
  } finally {
    first.close();
  }
  const file = join(h.stateDir, "terminal-v2/ledger.json"),
    ledger = JSON.parse(readFileSync(file, "utf8"));
  // Explicit valid cold allocation fixture, not a real backend/proof.
  ledger.revision = 7;
  ledger.allocations = [
    {
      allocationId: "a".repeat(24),
      termId: "t".repeat(24),
      hubInstance: "h".repeat(24),
      scope: { agentKey: "agent", sessionId: "session", epoch: "epoch" },
      quotaSessionKey: "session",
      principalKey: "loopback:user",
      creatorSidTag: "s".repeat(43),
      kernelBootId: "11111111-1111-4111-8111-111111111111",
    },
  ];
  put(file, ledger);
  const before = readFileSync(file),
    second = h.open();
  try {
    const result = initializeRetained(second);
    expect(result.normalAllocations).toBe(1);
    expect(readFileSync(file)).toEqual(before);
  } finally {
    second.close();
  }
});
it.each([
  "source-bytes",
  "source-inode",
  "mapping",
  "backup",
  "missing-debt",
  "wrong-evidence",
  "partial-v2",
  "anchor-missing",
])("independent retry refuses %s without repair", (fault) => {
  const h = fixture(),
    first = h.open();
  try {
    initializeRetained(first);
  } finally {
    first.close();
  }
  if (fault === "source-bytes") put(h.path, { v: 1, revision: 4, resources: [] });
  if (fault === "source-inode") {
    renameSync(h.path, h.path + ".old");
    writeFileSync(h.path, readFileSync(h.path + ".old"), { mode: 0o600 });
  }
  if (fault === "mapping") put(join(h.evidenceDir, "mapping.json"), []);
  if (fault === "backup") put(join(h.evidenceDir, "backup/file-0000"), "changed");
  if (fault === "missing-debt") {
    const p = join(h.stateDir, "terminal-v2/ledger.json"),
      ledger = JSON.parse(readFileSync(p, "utf8"));
    ledger.legacyObligations = [];
    ledger.revision++;
    put(p, ledger);
  }
  if (fault === "wrong-evidence") {
    const p = join(h.installationPath, "active-operation.json"),
      intent = JSON.parse(readFileSync(p, "utf8"));
    intent.evidencePath += "-other";
    put(p, intent);
  }
  if (fault === "partial-v2")
    renameSync(join(h.stateDir, "terminal-v2/marker.json"), join(h.stateDir, "terminal-v2/marker.partial"));
  if (fault === "anchor-missing")
    renameSync(
      join(h.installationPath, "installation-anchor.json"),
      join(h.installationPath, "installation-anchor.partial"),
    );
  const before = tree(h.base),
    second = h.open();
  try {
    expect(() => initializeRetained(second)).toThrow();
    expect(tree(h.base)).toEqual(before);
  } finally {
    second.close();
  }
});
it("guard loss before any mutation does not prepare or initialize", () => {
  const h = fixture(),
    before = tree(h.base),
    port = h.open();
  h.lose();
  try {
    expect(() => initializeRetained(port)).toThrow("owned-guard-lost");
    expect(tree(h.base)).toEqual(before);
  } finally {
    port.close();
  }
});
