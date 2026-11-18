/** Actual filesystem deployment + original kernel singleton, no fake audit port. */
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ControlledDeployment } from "../../scripts/web-hub/terminal-v2-maintenance/deployment.js";
import { ControlledScope } from "../../scripts/web-hub/terminal-v2-maintenance/scope.js";
import { controlledMaintenanceCli } from "../../scripts/web-hub/terminal-v2-maintenance.js";
import type { MaintenanceAuditPort } from "../../scripts/web-hub/terminal-v2-maintenance/audit.js";
const parent = () => {
  const dir = mkdtempSync(join(tmpdir(), "t51-fence-"));
  chmodSync(dir, 0o700);
  return dir;
};
it("rejects arbitrary module/JSON/empty-state adoption flags BEFORE creating a scope", async () => {
  const directory = parent(),
    before = readdirSync(directory);
  for (const args of [
    ["fresh", "--adapter", directory],
    ["checkpoint", "--state", directory],
    ["fresh", "--drained", "true"],
    ["fresh", "--private-parent", directory, "--force"],
  ])
    expect((await controlledMaintenanceCli(args)).exitCode).toBe(64);
  expect(readdirSync(directory)).toEqual(before);
  vi.stubEnv("PI_SECURE_SESSION", "1");
  try {
    expect((await controlledMaintenanceCli(["fresh", "--private-parent", directory])).exitCode).toBe(1);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(readdirSync(directory)).toEqual(before);
});
it("uses exclusive construction, physical paths and no publisher/fresh-history inference", () => {
  const directory = parent(),
    alias = join(directory, "alias");
  symlinkSync(directory, alias, "dir");
  expect(() => ControlledScope.create(alias)).toThrow();
  const scope = ControlledScope.create(directory);
  try {
    const publisher = scope.beginPublisher("old");
    expect(() => scope.enterMaintenance()).toThrow(/publisher-active/);
    publisher.stopped();
    const lease = scope.enterMaintenance();
    expect(() => scope.beginPublisher("old")).toThrow(/deployment-busy/);
    expect(() => scope.freshHistory()).toThrow(/fresh-history-unproven/); // even with an empty state directory
    lease.release();
    scope.checkpointCommitted();
    expect(() => scope.beginPublisher("old")).toThrow(/deployment-floor/);
    expect(publisher.current()).toBe(false);
  } finally {
    scope.close();
  }
});
it("actual singleton lease accepts only its own immutable snapshot and old release cannot unlock successor", async () => {
  const deployment = await ControlledDeployment.create(parent());
  const audit = (deployment as unknown as { audit: MaintenanceAuditPort }).audit;
  const input = {
    stateDir: deployment.scope.state.path,
    operation: "fresh" as const,
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
  };
  try {
    const a = await audit.acquire(input),
      old = await a.observe();
    expect(Object.isFrozen(old)).toBe(true);
    expect(Object.isFrozen(old.publisherFence)).toBe(true);
    expect(a.current(old)).toBe(true);
    expect(a.current({ ...old })).toBe(false);
    await a.release();
    const b = await audit.acquire(input),
      next = await b.observe();
    await a.release();
    expect(a.current(old)).toBe(false);
    expect(b.current(old)).toBe(false);
    expect(b.current(next)).toBe(true);
    expect(() => deployment.scope.beginPublisher("old")).toThrow(/deployment-busy/);
    await b.revalidate(next);
    b.guardOwnership!(next);
    await b.release();
  } finally {
    await deployment.close();
  }
}, 60000);
it("actual artifact or original singleton replacement invalidates final synchronous guard, no v2 healing", async () => {
  for (const replace of ["artifact", "socket"] as const) {
    const deployment = await ControlledDeployment.create(parent());
    const audit = (deployment as unknown as { audit: MaintenanceAuditPort }).audit;
    const lease = await audit.acquire({
      stateDir: deployment.scope.state.path,
      operation: "fresh",
      signal: new AbortController().signal,
      deadline: Date.now() + 30000,
    });
    try {
      const snapshot = await lease.observe();
      if (replace === "artifact") appendFileSync(deployment.newBuild.artifact, "\n// owned tamper\n");
      else {
        const paths = (await deployment.newBuild.load()).resolveHubPaths({
          home: deployment.scope.home,
          uid: process.getuid!(),
          xdgRuntimeDir: deployment.scope.socketDir,
        });
        unlinkSync(paths.socketPath);
      }
      expect(() => lease.guardOwnership!(snapshot)).toThrow();
      expect(lease.current(snapshot)).toBe(false);
      expect(readdirSync(deployment.scope.state.path)).not.toContain("terminal-v2");
      expect(readdirSync(deployment.scope.evidence.path)).toEqual([]);
    } finally {
      await lease.release();
      await deployment.close();
    }
  }
}, 60000);
it("tool system-rc mirror differs only by standalone TS7 definite-assignment annotations", () => {
  const original = readFileSync("tests/integration/web-hub-terminal-system-rc.ts", "utf8");
  const tool = readFileSync("scripts/web-hub/terminal-v2-maintenance/system-rc.ts", "utf8");
  const body = tool.slice(tool.indexOf("/** Test-only pre-exec audit:"));
  expect(body.replace(/let (physical|st|text)!:/g, "let $1:")).toBe(original);
});
