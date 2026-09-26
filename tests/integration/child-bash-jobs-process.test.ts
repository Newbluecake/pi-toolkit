import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import { wireChildBashJobs } from "../../src/bash/child.js";
import { getChildBashRegistry } from "../../src/bash/child-registry.js";
import { probePid } from "../../src/bash/process.js";

/**
 * bash-timeout-grace plan §3.3/§3.6 (P5, T28): real-process verification of
 * `sealAndKill` — a real detached `sleep 30` group is actually SIGTERM'd (and
 * SIGKILL'd if it ignores it), `killAll`'s bound holds, and a `reserve()`
 * after sealing is refused synchronously (no process spawned). win32 has no
 * POSIX process groups (§2.5/R6 — the whole feature is off there), skipped.
 */
const posix = process.platform !== "win32";

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { name: string; execute: (...args: never[]) => unknown }>();
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: never[]) => unknown }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, tools };
}

function fakeCtx(sessionId: string, cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    model: { provider: "test", id: "test-model" },
  } as unknown as ExtensionContext;
}

function settingsWith(dir: string): AgentSettings {
  return { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir } };
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-toolkit-child-bash-proc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!posix)("child bash jobs — real process (§3.3/T28)", () => {
  it("sealAndKill actually kills a real detached sleep, done resolves, and probePid goes false", async () => {
    const { pi, tools } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith(dir) });
    const bash = tools.get("bash")!;
    const ctx = fakeCtx(sessionId, dir);
    const result = (await bash.execute(
      "call-1",
      { command: "sleep 30", run_in_background: true },
      undefined,
      undefined,
      ctx,
    )) as { details?: { jobId?: string; pid?: number } };
    const jobId = result.details?.jobId;
    expect(jobId).toBeTruthy();

    const bashJob = tools.get("bash_job")!;
    // Confirm the process is really up (poll status for a pid).
    let pid: number | undefined;
    await waitUntil(async () => {
      const status = (await bashJob.execute(
        "call-2",
        { action: "status", job_id: jobId },
        undefined,
        undefined,
        ctx,
      )) as {
        details?: { pid?: number };
      };
      pid = status.details?.pid;
      return pid !== undefined;
    });
    expect(pid).toBeTruthy();
    expect(probePid(pid!)).toBe(true);

    const sealed = getChildBashRegistry().sealAndKill(sessionId, 300);
    expect(sealed).toBeDefined();
    await sealed!.done;
    expect(probePid(pid!)).toBe(false);
  }, 15_000);

  it("create-after-seal is refused synchronously — no new process is spawned", async () => {
    const { pi, tools } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith(dir) });
    const bash = tools.get("bash")!;
    const ctx = fakeCtx(sessionId, dir);
    // Build the manager first (so the registry entry exists) with a throwaway job.
    await bash.execute("call-1", { command: "true", run_in_background: true }, undefined, undefined, ctx);
    const sealed = getChildBashRegistry().sealAndKill(sessionId, 300);
    expect(sealed).toBeDefined();
    await expect(
      bash.execute("call-2", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx),
    ).rejects.toThrow(/ending/i);
  }, 15_000);

  it("killAll settles within its bound (grace + backstop margin) even for a SIGTERM-ignoring process", async () => {
    const { pi, tools } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith(dir) });
    const bash = tools.get("bash")!;
    const ctx = fakeCtx(sessionId, dir);
    const result = (await bash.execute(
      "call-1",
      { command: "trap '' TERM; sleep 30", run_in_background: true },
      undefined,
      undefined,
      ctx,
    )) as { details?: { jobId?: string } };
    const jobId = result.details?.jobId;
    const bashJob = tools.get("bash_job")!;
    let pid: number | undefined;
    await waitUntil(async () => {
      const status = (await bashJob.execute(
        "call-2",
        { action: "status", job_id: jobId },
        undefined,
        undefined,
        ctx,
      )) as {
        details?: { pid?: number };
      };
      pid = status.details?.pid;
      return pid !== undefined;
    });
    expect(pid).toBeTruthy();
    // Give the shell a moment to install its `trap '' TERM` (mirrors
    // tests/bash/process.test.ts's own "escalates to SIGKILL" case) before
    // sealing — otherwise the first SIGTERM can land before the trap exists
    // and kill the shell (and the plain "terminated" outcome, not "killed",
    // never exercises the escalation this test is about).
    await new Promise((resolve) => setTimeout(resolve, 250));

    const graceMs = 300;
    const started = Date.now();
    const sealed = getChildBashRegistry().sealAndKill(sessionId, graceMs);
    const report = await sealed!.done;
    const elapsed = Date.now() - started;
    // grace (SIGTERM→SIGKILL escalation) + the registry's own defensive
    // backstop margin (KILL_ALL_BACKSTOP_MARGIN_MS, 3s) — generous upper
    // bound so this stays robust under CI scheduling jitter.
    expect(elapsed).toBeLessThan(graceMs + 3_000 + 5_000);
    // `sealed.done` resolving on "killed" means the SIGKILL was sent, not
    // that the OS has already reaped the process — poll briefly for that
    // (mirrors tests/bash/process.test.ts's own `until(() => !probePid(...))`).
    await waitUntil(() => !probePid(pid!), 3_000);
    expect(probePid(pid!)).toBe(false);
    expect([...report.killed, ...report.alreadyDone, ...report.pending]).toContain(jobId);
  }, 15_000);
});
