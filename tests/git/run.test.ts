import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createGitRunner } from "../../src/git/run.js";

async function script(body: string): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-git-run-"));
  const file = join(dir, "fake-git.mjs");
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return { file, dir };
}

function pidFrom(stdout: string): number {
  const pid = Number(stdout.trim().split(/\s+/)[0]);
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function groupIsDead(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && (!isDead(pid) || !groupIsDead(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("createGitRunner", () => {
  it("kills a SIGTERM-ignoring process group at the deadline and settles immediately", async () => {
    const { file, dir } = await script(
      "console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    );
    const started = Date.now();
    const result = await createGitRunner({ gitBinary: file })([], {
      timeoutMs: 100,
      maxStdoutBytes: 1024,
    });
    const pid = pidFrom(result.stdout);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.killed).toBe("timeout");
    await waitForDead(pid);
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
  });

  it("does not wait for a grandchild holding stdout open and kills the group", async () => {
    const { file, dir } = await script(
      "console.log(process.pid); const cp = await import('node:child_process'); cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', process.stdout, 'ignore']}); process.exit(0);",
    );
    const started = Date.now();
    const result = await createGitRunner({ gitBinary: file })([], {
      timeoutMs: 100,
      maxStdoutBytes: 1024,
    });
    const pid = pidFrom(result.stdout);
    expect(result.killed).toBe("timeout");
    await waitForDead(pid);
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
  });

  it("kills on 10 MiB stdout overflow with a 64 KiB cap", async () => {
    const { file, dir } = await script(
      "process.stdout.write(process.pid + '\\n' + 'x'.repeat(10 * 1024 * 1024)); setInterval(() => {}, 1000);",
    );
    const result = await createGitRunner({ gitBinary: file })([], {
      timeoutMs: 5000,
      maxStdoutBytes: 64 * 1024,
    });
    const pid = pidFrom(result.stdout);
    expect(result.killed).toBe("overflow");
    expect(result.stdoutCapped).toBe(true);
    await waitForDead(pid);
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
  });

  it("aborts and kills the process group", async () => {
    const { file, dir } = await script(
      "console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    );
    const controller = new AbortController();
    const pending = createGitRunner({ gitBinary: file })([], {
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50).unref();
    const result = await pending;
    const pid = pidFrom(result.stdout);
    await waitForDead(pid);
    expect(isDead(pid)).toBe(true);
    expect(groupIsDead(pid)).toBe(true);
    await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
  });

  it("reports an ENOENT spawn error", async () => {
    const result = await createGitRunner({ gitBinary: "/definitely/missing/pi-toolkit-git" })([], {
      timeoutMs: 1000,
      maxStdoutBytes: 1024,
    });
    expect(result.spawnError).toMatch(/ENOENT/);
    expect(result.code).toBeNull();
  });

  it("unrefs the deadline timer", async () => {
    const timers: NodeJS.Timeout[] = [];
    const original = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const timer = original(handler, timeout, ...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      await createGitRunner({ gitBinary: process.execPath })(["-e", ""], {
        timeoutMs: 1000,
        maxStdoutBytes: 1024,
      });
      expect(timers.some((timer) => !timer.hasRef())).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the hardened git arguments and environment", async () => {
    const { file, dir } = await script(
      "console.log(JSON.stringify({argv: process.argv.slice(2), env: {locks: process.env.GIT_OPTIONAL_LOCKS, prompt: process.env.GIT_TERMINAL_PROMPT, locale: process.env.LC_ALL}}));",
    );
    const result = await createGitRunner({ gitBinary: file })(["status"], {
      timeoutMs: 1000,
      maxStdoutBytes: 4096,
    });
    const parsed = JSON.parse(result.stdout) as { argv: string[]; env: Record<string, string> };
    expect(parsed.argv.slice(0, 6)).toEqual([
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
    ]);
    expect(parsed.env).toEqual({ locks: "0", prompt: "0", locale: "C" });
    await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
  });
});
