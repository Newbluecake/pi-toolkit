import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointTerminalV2 } from "../../scripts/web-hub/terminal-v2-checkpoint.js";
import { rollbackCli, rollbackTerminalV2 } from "../../scripts/web-hub/terminal-v2-rollback.js";
import { MaintenanceError } from "../../scripts/web-hub/terminal-v2-maintenance/audit.js";
import { legacyLayout, put, setup, tree } from "./helpers.js";

describe("P5 independent rollback: controlled components, real private disk (not O→N→O)", () => {
  it("requires two real drain observations via the adapter, leaves both generations untouched", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    const checkpoint = await checkpointTerminalV2("checkpoint", h.options);
    // Model N using then pruning its ledger: only disk behavior, not a real shell.
    const ledger = JSON.parse(readFileSync(join(h.stateDir, "terminal-v2/ledger.json"), "utf8"));
    put(join(h.stateDir, "terminal-v2/ledger.json"), { ...ledger, revision: 2 });
    h.audit.nextRevision = 2;
    const before = tree(h.stateDir);
    const result = await rollbackTerminalV2(h.options);
    expect(result).toMatchObject({
      operation: "rollback",
      outcome: "rollback-eligible",
      deploymentChanged: false,
      checkpointId: checkpoint.checkpointId,
    });
    expect(tree(h.stateDir)).toEqual(before);
    expect(JSON.parse(readFileSync(join(h.evidenceDir, result.transaction, "prepared.json"), "utf8"))).toMatchObject({
      audit: { kind: "rollback", next: { durableRevision: 2 } },
    });
    const all = tree(h.base);
    expect((await rollbackTerminalV2(h.options)).outcome).toBe("already-complete");
    expect(tree(h.base)).toEqual(all);
    expect(existsSync(join(h.stateDir, ".terminal-initialized-v2"))).toBe(true);
    expect(h.audit.validations).toBeGreaterThanOrEqual(6);
  });

  it.each([
    "allocation",
    "invalid-ledger",
    "unknown-version",
    "unknown-file",
    "v1-dirty",
    "v1-changed",
    "active",
    "future",
    "publisher",
    "revision",
  ])("refuses %s with zero additional file changes", async (fault) => {
    const h = setup();
    legacyLayout(h.stateDir);
    await checkpointTerminalV2("checkpoint", h.options);
    const ledgerPath = join(h.stateDir, "terminal-v2/ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (fault === "allocation")
      put(ledgerPath, {
        ...ledger,
        allocations: [
          {
            allocationId: "a".repeat(32),
            termId: "t".repeat(32),
            kernelBootId: "00000000-0000-0000-0000-000000000000",
            hubInstance: "h".repeat(32),
            scope: { agentKey: "a", sessionId: "s", epoch: "e" },
            quotaSessionKey: "s",
            principalKey: "lan:one",
            creatorSidTag: "s".repeat(43),
          },
        ],
      });
    if (fault === "invalid-ledger") put(ledgerPath, "broken");
    if (fault === "unknown-version") put(ledgerPath, { ...ledger, v: 3 });
    if (fault === "unknown-file") put(join(h.stateDir, "terminal-v2/unknown"), "unknown");
    if (fault === "v1-dirty") put(join(h.stateDir, "terminal-v1/receipts/unknown.json"), {});
    if (fault === "v1-changed") {
      put(join(h.stateDir, "terminal-v1/terminal-resource-fence-v1.json"), { v: 1, revision: 8, resources: [] });
      h.audit.revision = 8;
    }
    if (fault === "active") h.audit.active = 1;
    if (fault === "future") h.audit.pending = 1;
    if (fault === "publisher") h.audit.publisher = true;
    if (fault === "revision") h.audit.nextRevision = 99;
    const before = tree(h.base);
    const expected: Record<string, string> = {
      allocation: "v2-allocations-not-empty",
      "invalid-ledger": "invalid-json",
      "unknown-version": "invalid-v2-checkpoint",
      "unknown-file": "unknown-v2-layout",
      "v1-dirty": "v1-receipts-not-empty",
      "v1-changed": "legacy-changed-since-checkpoint",
      active: "component-not-drained",
      future: "component-not-drained",
      publisher: "old-publisher-active",
      revision: "v2-drain-unproven",
    };
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({ code: expected[fault], effect: "none" });
    expect(tree(h.base)).toEqual(before);
  });

  it("no marker and no N drain port is never a rollback approval", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    const before = tree(h.base);
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({ code: "v2-checkpoint-required" });
    expect(tree(h.base)).toEqual(before);
  });

  it("incomplete checkpoint cannot authorize downgrade even with an otherwise valid marker", async () => {
    const h = setup();
    legacyLayout(h.stateDir);
    await expect(
      checkpointTerminalV2("checkpoint", h.options, {
        before(stage) {
          if (stage === "complete-write") throw new MaintenanceError("simulated-crash");
        },
      }),
    ).rejects.toMatchObject({ effect: "unknown" });
    const before = tree(h.base);
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({ effect: "none" });
    expect(tree(h.base)).toEqual(before);
    expect(readdirSync(h.evidenceDir).length).toBe(1);
  });

  it("fresh is not a fabricated O checkpoint for rollback", async () => {
    const h = setup();
    await checkpointTerminalV2("fresh", h.options);
    const before = tree(h.base);
    await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({ effect: "none" });
    expect(tree(h.base)).toEqual(before);
  });

  it("CLI explicitly says no old-binary marker gate and never launches anything", () => {
    expect(rollbackCli(["--help"]).message).toContain("Old O does not understand v2 markers");
    expect(rollbackCli(["--drained=true", "--force"]).exitCode).toBe(78);
    expect(rollbackCli([]).message).toContain("no rollback performed");
  });
});

it("strict ACK rollback never treats retained initialization as clean O terminal-on, even with zero L", async () => {
  const h = setup();
  legacyLayout(h.stateDir);
  await checkpointTerminalV2("checkpoint", h.options);
  const path = join(h.stateDir, "terminal-v2/marker.json"),
    marker = JSON.parse(readFileSync(path, "utf8"));
  marker.initialization = "offline-retained-unknown";
  put(path, marker);
  put(join(h.stateDir, ".terminal-initialized-v2"), marker);
  const ledgerPath = join(h.stateDir, "terminal-v2/ledger.json"),
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  put(ledgerPath, { ...ledger, legacyObligations: [] });
  const before = tree(h.base);
  await expect(rollbackTerminalV2(h.options)).rejects.toMatchObject({
    code: "retained-initialization-requires-off-rollback",
  });
  expect(tree(h.base)).toEqual(before);
});
