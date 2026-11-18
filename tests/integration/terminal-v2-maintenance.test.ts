/** Real fixed executable, measured O7239 + actual SDK/hub/native PTY, NOT ControlledAudit.
 * Every file/PTY/process belongs to a newly constructed private scope. Evidence retained.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
const exec = promisify(execFile),
  root = resolve("."),
  sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
async function run(operation: "fresh" | "cycle", entry = "terminal-v2-maintenance.ts") {
  const parent = mkdtempSync(join(tmpdir(), "t51-m-"));
  chmodSync(parent, 0o700);
  const { stdout } = await exec(
    process.execPath,
    [
      join(root, "node_modules/tsx/dist/cli.mjs"),
      join(root, "scripts/web-hub", entry),
      operation,
      "--private-parent",
      parent,
    ],
    { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim()) as any;
}
it("fresh executable proves a NEW constructed history and publishes actual durable v2 state", async () => {
  const result = await run("fresh");
  expect(result.result).toMatchObject({ operation: "fresh", outcome: "committed", deploymentChanged: false });
  const marker = JSON.parse(readFileSync(join(result.stateDir, "terminal-v2/marker.json"), "utf8"));
  const witness = JSON.parse(readFileSync(join(result.stateDir, ".terminal-initialized-v2"), "utf8"));
  const ledger = JSON.parse(readFileSync(join(result.stateDir, "terminal-v2/ledger.json"), "utf8"));
  expect(marker).toEqual(witness);
  expect(marker.initialization).toBe("fresh");
  expect(marker.checkpointId).toBe(result.result.checkpointId);
  expect(ledger).toEqual({ v: 2, storeId: marker.storeId, revision: 0, allocations: [] });
  expect(sha(join(result.newMeasurement, "runtime.mjs"))).toBe(result.newVersion.artifactSha256);
  const prepared = JSON.parse(
    readFileSync(join(result.evidenceDir, result.result.transaction, "prepared.json"), "utf8"),
  );
  expect(prepared.audit.kind).toBe("fresh");
  expect(prepared.audit.history.state).toBe("never-initialized");
  expect(prepared.audit.history.evidenceSha256).toBe(sha(join(result.scope, "construction.json")));
  expect(prepared.audit.publisherFence.state).toBe("disabled");
  expect(readdirSync(result.stateDir)).not.toContain("terminal-v1");
}, 120000);
it("actual O7239 open/reap/exact ACK → checkpoint → N input/proof/prune/dispose → rollback → actual O login/open/reap", async () => {
  const result = await run("cycle");
  expect(result.oldVersion.sourceCommit).toBe("7239dd115ac66039e2c4f80308ea5d08520aa6af");
  expect(result.checkpoint).toMatchObject({ operation: "checkpoint", outcome: "committed", deploymentChanged: false });
  expect(result.rollback).toMatchObject({
    operation: "rollback",
    outcome: "rollback-eligible",
    deploymentChanged: false,
  });
  expect(result.realKernelReboot).toBe(false);
  expect(sha(join(result.oldMeasurement, "runtime.mjs"))).toBe(result.oldVersion.artifactSha256);
  expect(sha(join(result.newMeasurement, "runtime.mjs"))).toBe(result.newVersion.artifactSha256);
  const measurement = JSON.parse(readFileSync(join(result.oldMeasurement, "measurement.json"), "utf8"));
  expect(measurement.patch).toHaveLength(5);
  for (const patch of measurement.patch) {
    const { stdout } = await exec("git", ["show", `${result.oldVersion.sourceCommit}:${patch.path}`], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
    expect(patch.before).toBe(stdout);
    expect(createHash("sha256").update(stdout).digest("hex")).toBe(patch.beforeSha256);
    expect(patch.beforeSha256).not.toBe(patch.afterSha256);
  }
  const old = JSON.parse(readFileSync(join(result.scope, "old-drain.json"), "utf8"));
  expect(old.worker.state).toBe("stopped");
  expect(old.worker.owner.pendingFutures).toBe(0);
  expect(old.worker.owner.resources).toEqual([]);
  expect(old.worker.owner.receipts).toEqual([]);
  expect(old.worker.owner.authorityActive).toBe(false);
  expect(old.beforeStop.fence.state).toBe("cleared");
  const ack = old.worker.owner.acks[0];
  const prune = old.fence.commits.find((commit: any) => commit.after.revision === ack.journalRevision);
  expect(prune.before.resources[0].status).toBe("resolved");
  expect(prune.after.resources).toEqual([]);
  expect(ack.identities[0]).toEqual(prune.before.resources[0].entry.identity);
  const next = JSON.parse(readFileSync(join(result.scope, "new-drain.json"), "utf8"));
  expect(next.disposeResult).toEqual({ clean: true, unresolved: 0 });
  expect(next.service).toMatchObject({
    stopped: true,
    consistent: true,
    pendingCreates: 0,
    contextFlights: 0,
    mutationFlights: 0,
    physicalPrunes: 1,
    allocationCount: 0,
    runtimes: [],
  });
  expect(next.backends[0].physical).toMatchObject({
    outcome: "reaped",
    spawnSettled: true,
    ptyClosed: true,
    helperReaped: true,
    managedGroupsGone: true,
  });
  const marker = JSON.parse(readFileSync(join(result.stateDir, "terminal-v2/marker.json"), "utf8"));
  expect(marker.initialization).toBe("v1-clean-checkpoint");
  expect(JSON.parse(readFileSync(join(result.stateDir, "terminal-v2/ledger.json"), "utf8"))).toEqual(
    next.service.ledger,
  );
  expect(readdirSync(join(result.stateDir, "terminal-v1/authority"))).toEqual([]);
  expect(readdirSync(join(result.stateDir, "terminal-v1/receipts"))).toEqual([]);
  const returned = JSON.parse(readFileSync(join(result.scope, "returned-old-drain.json"), "utf8"));
  expect(returned.fence.journal.resources).toEqual([]);
  expect(returned.worker.owner.acks[0].journalRevision).toBeGreaterThan(ack.journalRevision);
  for (const value of Object.values(result.shells) as any[]) {
    expect(value.pid).toBeGreaterThan(1);
    expect(value.termId).toEqual(expect.any(String));
    // These actual owned shell PIDs were printed by their own PTY and reaped. No signal is sent.
    expect(() => readFileSync(`/proc/${value.pid}/stat`)).toThrow();
  }
}, 120000);

it("checkpoint script has a real fixed fresh route, not unconditional CLI78", async () => {
  const result = await run("fresh", "terminal-v2-checkpoint.ts");
  expect(result.result).toMatchObject({ operation: "fresh", outcome: "committed" });
  expect(readFileSync(join(result.evidenceDir, result.result.transaction, "complete.json"), "utf8")).toContain(
    "checkpoint-durable",
  );
}, 120000);
