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

describe("createGitRunner env policy (worktree-diff §2.7)", () => {
  const BANNED = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_ATTR_SOURCE",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_PAGER",
    "GIT_EXEC_PATH",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "GIT_TRACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMON_DIR",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "SSH_AUTH_SOCK",
    "TMPDIR",
    "USER",
  ];
  const saved: Record<string, string | undefined> = {};

  function pollute(): void {
    for (const key of BANNED) {
      saved[key] = process.env[key];
      process.env[key] = "/definitely/not/real";
    }
  }

  function restore(): void {
    for (const key of BANNED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }

  async function envDumpScript(): Promise<{ file: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pi-git-env-"));
    const file = join(dir, "fake-git.mjs");
    await writeFile(
      file,
      [
        `#!${process.execPath}`,
        "import { readFileSync } from 'node:fs';",
        "let fd4 = null;",
        "try { fd4 = readFileSync('/proc/self/fd/4/HEAD', 'utf8'); } catch {}",
        "console.log(JSON.stringify({",
        "  keys: Object.keys(process.env).sort(),",
        "  path: process.env.PATH ?? null,",
        "  common: process.env.GIT_COMMON_DIR ?? null,",
        "  cwd: process.cwd(),",
        "  fd4: fd4 === null ? null : fd4.trim(),",
        "}));",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { file, dir };
  }

  it("minimal passes exactly the allowlisted keys and the fixed PATH", async () => {
    const { file, dir } = await envDumpScript();
    pollute();
    try {
      const result = await createGitRunner({ gitBinary: file })(["status"], {
        timeoutMs: 5000,
        maxStdoutBytes: 64 * 1024,
        envPolicy: "minimal",
        pathOverride: "/usr/bin:/bin",
      });
      const parsed = JSON.parse(result.stdout) as { keys: string[]; path: string | null };
      const expected = [
        "PATH",
        ...(process.env.HOME !== undefined ? ["HOME"] : []),
        ...(process.env.XDG_CONFIG_HOME !== undefined ? ["XDG_CONFIG_HOME"] : []),
        "GIT_ATTR_NOSYSTEM",
        "GIT_OPTIONAL_LOCKS",
        "GIT_TERMINAL_PROMPT",
        "LANG",
        "LC_ALL",
      ].sort();
      expect(parsed.keys).toEqual(expected); // exactly equal — any extra GIT_*/LD_* key fails
      expect(parsed.path).toBe("/usr/bin:/bin");
    } finally {
      restore();
      await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
    }
  });

  it("minimal adds GIT_COMMON_DIR=/proc/self/fd/5 only in pinned mode, overriding an inherited value", async () => {
    const { file, dir } = await envDumpScript();
    const pinDir = await mkdtemp(join(tmpdir(), "pi-git-pin-"));
    await writeFile(join(pinDir, "HEAD"), "ref: refs/heads/pinned\n");
    const fh = await import("node:fs/promises").then(({ open, constants }) =>
      open(pinDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC),
    );
    pollute(); // sets process.env.GIT_COMMON_DIR = "/definitely/not/real"
    try {
      const pinned = await createGitRunner({ gitBinary: file })(
        ["-C", "/proc/self/fd/3", "--git-dir=/proc/self/fd/4", "--work-tree=/proc/self/fd/3", "status"],
        {
          timeoutMs: 5000,
          maxStdoutBytes: 64 * 1024,
          envPolicy: "minimal",
          pathOverride: "/usr/bin:/bin",
          pins: { wt: fh.fd, git: fh.fd, common: fh.fd },
        },
      );
      const parsed = JSON.parse(pinned.stdout) as {
        keys: string[];
        common: string | null;
        cwd: string;
        fd4: string | null;
      };
      expect(parsed.common).toBe("/proc/self/fd/5"); // host value ignored, pinned value forced
      expect(parsed.keys).toContain("GIT_COMMON_DIR");
      expect(parsed.cwd).toBe("/"); // pinned mode forces cwd "/"
      expect(parsed.fd4).toBe("ref: refs/heads/pinned"); // stdio[4] received the git dir fd
      const unpinned = await createGitRunner({ gitBinary: file })(["status"], {
        timeoutMs: 5000,
        maxStdoutBytes: 64 * 1024,
        envPolicy: "minimal",
        pathOverride: "/usr/bin:/bin",
      });
      expect((JSON.parse(unpinned.stdout) as { keys: string[] }).keys).not.toContain("GIT_COMMON_DIR");
    } finally {
      await fh.close();
      restore();
      await import("node:fs/promises").then(({ rm }) => rm(pinDir, { force: true, recursive: true }));
      await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
    }
  });

  it("a host-PATH git shim runs under inherit but not under minimal", async () => {
    const shimDir = await mkdtemp(join(tmpdir(), "pi-git-shim-"));
    const marker = join(shimDir, "marker.txt");
    const shim = join(shimDir, "git");
    await writeFile(shim, `#!/bin/sh\necho shim >> ${JSON.stringify(marker)}\nexec /usr/bin/git "$@"\n`, {
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    try {
      const inherit = await createGitRunner()(["--version"], { timeoutMs: 5000, maxStdoutBytes: 4096 });
      expect(inherit.code).toBe(0);
      expect(await import("node:fs/promises").then(({ readFile }) => readFile(marker, "utf8"))).toContain("shim"); // control: the shim is reachable via host PATH
      const minimal = await createGitRunner()(["--version"], {
        timeoutMs: 5000,
        maxStdoutBytes: 4096,
        envPolicy: "minimal",
        pathOverride: "/usr/bin:/bin",
      });
      expect(minimal.code).toBe(0);
      expect(minimal.stdout.trim()).toMatch(/^git version \d+\./); // real git, not the shim
      const after = await import("node:fs/promises").then(({ readFile }) => readFile(marker, "utf8"));
      expect(after.split("\n").filter((l) => l === "shim")).toHaveLength(1); // minimal did NOT go through the shim
    } finally {
      process.env.PATH = originalPath;
      await import("node:fs/promises").then(({ rm }) => rm(shimDir, { force: true, recursive: true }));
    }
  });

  it("pinned mode refuses to spawn when the argv does not start with PINNED_PREFIX", async () => {
    let spawns = 0;
    const spawnImpl = (() => {
      throw new Error("must not be called");
    }) as unknown as typeof import("node:child_process").spawn;
    const recording = (...args: unknown[]) => {
      spawns++;
      return (spawnImpl as (...a: unknown[]) => never)(...args);
    };
    const fh = await import("node:fs/promises").then(({ open, constants }) =>
      open(tmpdir(), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC),
    );
    try {
      const result = await createGitRunner({ spawnImpl: recording, gitBinary: "/nonexistent" })(["status"], {
        timeoutMs: 1000,
        maxStdoutBytes: 1024,
        pins: { wt: fh.fd, git: fh.fd, common: fh.fd },
      });
      expect(result.spawnError).toMatch(/PINNED_PREFIX/);
      expect(result.code).toBeNull();
      expect(spawns).toBe(0); // never spawned
      // a PINNED_PREFIX-prefixed argv passes the gate (fails later at ENOENT — spawn DID happen)
      const prefixed = await createGitRunner({ gitBinary: "/definitely/missing/git" })(
        ["-C", "/proc/self/fd/3", "--git-dir=/proc/self/fd/4", "--work-tree=/proc/self/fd/3", "status"],
        { timeoutMs: 1000, maxStdoutBytes: 1024, pins: { wt: fh.fd, git: fh.fd, common: fh.fd } },
      );
      expect(prefixed.spawnError).toMatch(/ENOENT/); // reached spawn — gate passed
    } finally {
      await fh.close();
    }
  });

  it("pathOverride is ignored outside minimal mode", async () => {
    const { file, dir } = await envDumpScript();
    try {
      const result = await createGitRunner({ gitBinary: file })(["status"], {
        timeoutMs: 5000,
        maxStdoutBytes: 64 * 1024,
        envPolicy: "inherit",
        pathOverride: "/usr/bin:/bin",
      });
      const parsed = JSON.parse(result.stdout) as { path: string | null };
      expect(parsed.path).toBe(process.env.PATH); // host PATH inherited, override ignored
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(dir, { force: true, recursive: true }));
    }
  });
});
