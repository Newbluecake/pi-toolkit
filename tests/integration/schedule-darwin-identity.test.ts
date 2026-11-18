/**
 * Darwin schedule identity against the REAL `ps` / `sysctl` (darwin-plan §3.P1 测试; E-MAC).
 *
 * Tier 2 (integration/ prefix ⇒ real child processes). Self-gated: everything under the
 * describe only runs on macOS; Linux CI shows it skipped and must never record that as
 * Darwin evidence. The pure/parser/probe-logic coverage lives in
 * tests/web-hub/protocol/sched-identity.test.ts (tier 1, injected host).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createDarwinIdentity } from "../../src/web-hub/protocol/sched-identity.js";
import { SCHED_EPOCH_MS_FLOOR } from "../../src/schedule/core/recovery.js";

describe.skipIf(process.platform !== "darwin")("darwin schedule identity (real ps/sysctl)", () => {
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  });

  it("readSelf() yields an epoch-ms identity with a boot-session UUID", () => {
    const self = createDarwinIdentity().readSelf();
    expect(self).toBeDefined();
    expect(self!.start).toBeGreaterThanOrEqual(SCHED_EPOCH_MS_FLOOR);
    expect(self!.start % 1_000).toBe(0);
    expect(self!.boot).toMatch(/^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/);
    expect(typeof self!.host).toBe("string");
    expect(self!.host.length).toBeGreaterThan(0);
    expect(self!.pid).toBe(process.pid);
  });

  it("probe.startOf(self pid) equals readSelf().start", () => {
    const id = createDarwinIdentity();
    const self = id.readSelf();
    expect(id.probe.startOf(process.pid)).toBe(self!.start);
  });

  it("startOf tracks a spawned child, then reports it gone after SIGKILL", async () => {
    const id = createDarwinIdentity();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(child);
    const start = id.probe.startOf(child.pid!);
    expect(typeof start).toBe("number");
    expect(start as number).toBeGreaterThanOrEqual(SCHED_EPOCH_MS_FLOOR);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(id.probe.startOf(child.pid!)).toBeUndefined();
    expect(id.probe.pidMayExist(child.pid!)).toBe(false);
  });

  it("pidMayExist(999999) is false (proven ESRCH beyond the macOS pid range)", () => {
    expect(createDarwinIdentity().probe.pidMayExist(999_999)).toBe(false);
  });

  it("boot matches a direct sysctl read", () => {
    const self = createDarwinIdentity().readSelf();
    const direct = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
    }).trim();
    expect(self!.boot).toBe(direct);
  });
});
