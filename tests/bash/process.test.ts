import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  ALLOWED_SHELL_BASENAMES,
  createLogTail,
  createProcessPort,
  defaultShellConfig,
  LOG_CAP_BLOCK_BYTES,
  probePid,
  readJobExitFile,
  readProcStartTime,
  resolveShell,
  type JobStdioOptions,
  type ProcessPort,
  type SpawnedJob,
  watchChild,
} from "../../src/bash/process.js";

/** §3.3 process boundary, exercised against **real** child processes: fakes
 * cannot prove the thing that matters here (a detached group leader whose
 * descendants die with it, and an idempotent ESRCH path).
 *
 * Every spawn is registered in `spawned` and force-killed in `afterEach`, so a
 * failing assertion can never leak a `sleep 60` into the developer's machine.
 */

const posix = process.platform !== "win32";
const linux = process.platform === "linux";

let port: ProcessPort;
const spawned: SpawnedJob[] = [];
const envShellBackup = process.env.SHELL;

async function launch(command: string, cwd = process.cwd()): Promise<SpawnedJob> {
  const job = await port.spawnJob(command, cwd);
  spawned.push(job);
  return job;
}

function collect(job: SpawnedJob): { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  job.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  job.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  return { out: () => out, err: () => err };
}

/** Poll until `predicate` holds; returns false on timeout (no fake timers here). */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

describe("resolveShell (2026-10-17 revision: explicit → pi shellPath → pi's default chain; $SHELL never read)", () => {
  it("pins the allow-list itself (explicit zsh stays legal; fish/nu stay out)", () => {
    expect([...ALLOWED_SHELL_BASENAMES].sort()).toEqual(["bash", "sh", "zsh"]);
  });

  it("prefers an explicit allow-listed shellPath and always uses -c", () => {
    expect(resolveShell("/opt/custom/bin/bash", "/bin/zsh")).toEqual({
      shell: "/opt/custom/bin/bash",
      args: ["-c"],
    });
  });

  it("an explicit zsh path is still allowed (both settings sources)", () => {
    expect(resolveShell("/opt/custom/bin/zsh", "/bin/bash")).toEqual({ shell: "/opt/custom/bin/zsh", args: ["-c"] });
    expect(resolveShell(undefined, "/opt/custom/bin/zsh")).toEqual({
      shell: "/opt/custom/bin/zsh",
      args: ["-c"],
    });
  });

  it("falls through to pi's shellPath when the explicit one is absent/blank/allow-list-rejected", () => {
    expect(resolveShell(undefined, "/opt/pi/bash")).toEqual({ shell: "/opt/pi/bash", args: ["-c"] });
    expect(resolveShell("   ", "/opt/pi/bash")).toEqual({ shell: "/opt/pi/bash", args: ["-c"] });
    expect(resolveShell("/opt/weird/fish", "/opt/pi/bash")).toEqual({ shell: "/opt/pi/bash", args: ["-c"] });
  });

  it("rejects non-allow-listed basenames from BOTH settings sources (fallback, not error)", () => {
    expect(resolveShell("/bin/fish", "/usr/bin/nu")).not.toEqual({ shell: "/bin/fish", args: ["-c"] });
    expect(resolveShell("/bin/fish", "/usr/bin/nu")).not.toEqual({ shell: "/usr/bin/nu", args: ["-c"] });
    expect(resolveShell(undefined, "/usr/bin/nu")).not.toEqual({ shell: "/usr/bin/nu", args: ["-c"] });
  });

  it("resolves pi's default chain when neither settings source yields a shell", () => {
    if (posix) {
      // /bin/bash exists on every supported POSIX image; the injected-deps
      // matrix in the defaultShellConfig describe pins the full ladder.
      const config = resolveShell();
      expect(["/bin/bash", "sh"]).toContain(config.shell);
      expect(config.args).toEqual(["-c"]);
    }
  });
});

describe("defaultShellConfig (mirrors pi's getShellConfig Unix branch, dist/utils/shell.js)", () => {
  it("1. /bin/bash when it exists", () => {
    expect(defaultShellConfig({ exists: (p) => p === "/bin/bash", which: () => "/usr/bin/bash" })).toEqual({
      shell: "/bin/bash",
      args: ["-c"],
    });
  });

  it("2. then bash on PATH via which", () => {
    expect(
      defaultShellConfig({ exists: () => false, which: (n) => (n === "bash" ? "/usr/bin/bash" : undefined) }),
    ).toEqual({ shell: "/usr/bin/bash", args: ["-c"] });
  });

  it("3. then sh — never $SHELL, never zsh by default", () => {
    expect(defaultShellConfig({ exists: () => false, which: () => undefined })).toEqual({
      shell: "sh",
      args: ["-c"],
    });
  });

  it("real machine: /bin/bash on Linux", () => {
    if (linux) expect(defaultShellConfig()).toEqual({ shell: "/bin/bash", args: ["-c"] });
  });
});

describe("watchChild", () => {
  function fake(): { child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }; emit: EventEmitter["emit"] } {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    return { child, emit: child.emit.bind(child) };
  }

  it("uses the first exit/close result and shares the frozen object", async () => {
    const cases: Array<[string, (child: EventEmitter) => void, number | null]> = [
      [
        "exit then close",
        (child) => {
          child.emit("exit", 3, null);
          child.emit("close", 0, null);
        },
        3,
      ],
      [
        "close then exit",
        (child) => {
          child.emit("close", 0, null);
          child.emit("exit", 3, null);
        },
        0,
      ],
      [
        "null close",
        (child) => {
          child.emit("exit", 4, null);
          child.emit("close", null, null);
        },
        4,
      ],
    ];
    for (const [, drive, code] of cases) {
      const { child } = fake();
      const watched = watchChild(child as never, 600);
      drive(child);
      child.stdout.end();
      child.stderr.end();
      const exit = await watched.processExitPromise;
      const drained = await watched.drainedPromise;
      expect(exit.exitCode).toBe(code);
      expect(drained.stop).toBe("ended");
      expect(Object.isFrozen(exit)).toBe(true);
      expect(drained.exit).toBe(exit);
    }
  });

  it("settles both promises with error before exit", async () => {
    const { child } = fake();
    const watched = watchChild(child as never, 600);
    const error = new Error("pipe");
    child.emit("error", error);
    child.emit("exit", 0, null);
    const exit = await watched.processExitPromise;
    const drained = await watched.drainedPromise;
    expect(exit.error).toBe(error);
    expect(drained).toEqual({ exit, stop: "error" });
  });

  it("ignores post-exit errors and caps a busy pipe", async () => {
    const { child } = fake();
    const watched = watchChild(child as never, 20);
    child.emit("exit", 0, null);
    child.emit("error", new Error("noise"));
    const exit = await watched.processExitPromise;
    const drained = await watched.drainedPromise;
    expect(exit.error).toBeUndefined();
    expect(drained.stop).toBe("capped");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});
describe.skipIf(!posix)("createProcessPort (POSIX)", () => {
  afterEach(async () => {
    // Belt-and-braces reaper: kill anything the test left running.
    for (const job of spawned.splice(0)) {
      try {
        process.kill(-job.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (envShellBackup === undefined) delete process.env.SHELL;
    else process.env.SHELL = envShellBackup;
    await Promise.resolve();
  });

  it("spawns, streams both pipes and reports the exit code", async () => {
    port = createProcessPort();
    const job = await launch("echo out; echo err 1>&2; exit 7");
    const streams = collect(job);

    expect(job.pid).toBeGreaterThan(0);
    const { exit } = await job.drainedPromise;

    expect(exit.exitCode).toBe(7);
    expect(exit.signal).toBeNull();
    expect(exit.error).toBeUndefined();
    expect(streams.out()).toContain("out");
    expect(streams.err()).toContain("err");
  });

  it("makes the child a process group leader (pgid === pid)", async () => {
    port = createProcessPort();
    const job = await launch("exit 0");
    expect(job.pgid).toBe(job.pid);
    await job.drainedPromise;
  });

  it("honours cwd", async () => {
    port = createProcessPort();
    const job = await launch("pwd", "/tmp");
    const streams = collect(job);
    await job.drainedPromise;
    // /tmp may be a symlink (macOS → /private/tmp); pwd resolves the logical path.
    expect(streams.out().trim().endsWith("/tmp")).toBe(true);
  });

  it("rejects when the shell or cwd does not exist (spawn error, not a hang)", async () => {
    // Allow-listed basename (bash) but nonexistent file: the explicit path is
    // honoured, so the spawn's own ENOENT surfaces (2026-10-17 revision —
    // fail-soft at spawn, never a throw at resolve time).
    const missingShell = createProcessPort({ shellPath: "/nonexistent/bash" });
    await expect(missingShell.spawnJob("echo hi", process.cwd())).rejects.toThrow(/ENOENT/);

    port = createProcessPort();
    await expect(port.spawnJob("echo hi", "/nonexistent/dir-xyz")).rejects.toThrow(/ENOENT/);
  });

  it("kills the whole process group so grandchildren die with the shell", async () => {
    port = createProcessPort({ graceMs: 500 });
    // The shell exec's nothing: `sleep 60 &` is a background grandchild that
    // would survive a plain kill(pid) but not kill(-pgid).
    const job = await launch("sleep 60 & echo $! ; wait");
    const streams = collect(job);
    expect(await until(() => streams.out().trim().length > 0)).toBe(true);
    const grandchild = Number.parseInt(streams.out().trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(probePid(grandchild)).toBe(true);

    const outcome = await port.killJobTree(job.pid);
    expect(["terminated", "killed"]).toContain(outcome);

    const exit = await job.drainedPromise;
    expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    expect(await until(() => !probePid(job.pid))).toBe(true);
    expect(await until(() => !probePid(grandchild))).toBe(true);
  });

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    port = createProcessPort({ graceMs: 150, killPollMs: 20 });
    const job = await launch("trap '' TERM; sleep 60");
    // Give the shell a moment to install the trap.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const outcome = await port.killJobTree(job.pid);
    expect(outcome).toBe("killed");
    await job.drainedPromise;
    expect(await until(() => !probePid(job.pid))).toBe(true);
  });

  it("is idempotent: a second kill of a dead group reports already-dead (ESRCH)", async () => {
    port = createProcessPort({ graceMs: 200, killPollMs: 20 });
    const job = await launch("sleep 60");
    expect(["terminated", "killed"]).toContain(await port.killJobTree(job.pid));
    await job.drainedPromise;
    expect(await until(() => !probePid(job.pid))).toBe(true);

    expect(await port.killJobTree(job.pid)).toBe("already-dead");
    expect(await port.killJobTree(job.pid)).toBe("already-dead");
  });

  it("refuses to signal pid <= 1 or a recycled pid", async () => {
    port = createProcessPort({ graceMs: 50 });
    expect(await port.killJobTree(1)).toBe("refused");
    expect(await port.killJobTree(0)).toBe("refused");
    expect(await port.killJobTree(-5)).toBe("refused");

    const job = await launch("sleep 60");
    if (linux) {
      // A starttime mismatch means the pid was reused: nothing may be signalled.
      expect(await port.killJobTree(job.pid, { expectedProcStartTime: "1" })).toBe("refused");
      expect(probePid(job.pid)).toBe(true);
      // The real starttime still kills.
      expect(["terminated", "killed"]).toContain(
        await port.killJobTree(job.pid, { expectedProcStartTime: job.procStartTime ?? "" }),
      );
    }
    await port.killJobTree(job.pid);
    await job.drainedPromise;
  });

  it("decouples process exit from a chatty detached writer (exit ≠ drain)", async () => {
    port = createProcessPort();
    // The shell exits at once; the detached writer keeps the inherited pipe
    // busy every 50ms for ~2s. Before the exit/drain split this wedged the
    // job in "running" until the writer stopped; a 100ms-only idle cutoff
    // (no re-arm) would silently truncate the tail instead.
    // t0 BEFORE launch: under load the spawn/launch await can itself take long, and the writer's
    // ~2s clock starts at spawn — measuring from after launch made the lower bound flaky.
    const t0 = Date.now();
    const job = await launch("(i=0; while [ $i -lt 40 ]; do echo tick; i=$((i+1)); sleep 0.05; done &) ; exit 0");
    const streams = collect(job);
    const tLaunched = Date.now();

    const exit = await job.processExitPromise;
    expect(exit.exitCode).toBe(0);
    expect(Date.now() - tLaunched).toBeLessThan(1_000);

    // The writer is still going: drained must not have settled yet.
    const drainedEarly = await Promise.race([
      job.drainedPromise.then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(drainedEarly).toBe(false);

    const drained = await job.drainedPromise;
    // The tail was captured in full (idle re-armed by writes), not cut at 100ms.
    expect(Date.now() - t0).toBeGreaterThan(1_500);
    expect(drained.stop === "ended" || drained.stop === "idle").toBe(true);
    expect(drained.exit).toBe(exit);
    expect(streams.out().match(/tick/g)?.length).toBe(40);
  });

  it("caps the drain of a perpetually busy pipe and destroys it (cap >= idle window)", async () => {
    port = createProcessPort({ drainTimeoutMs: 600 });
    const job = await launch("(while :; do echo tick; sleep 0.05; done &) ; exit 0");
    collect(job);
    const t0 = Date.now();

    const exit = await job.processExitPromise;
    expect(exit.exitCode).toBe(0);

    const drained = await job.drainedPromise;
    const elapsed = Date.now() - t0;
    expect(drained.stop).toBe("capped");
    // The idle window (100ms) can never fire while writes arrive every 50ms,
    // so settling at ~600ms proves the cap — not the idle timer — fired.
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(3_000);
    expect(job.stdout.destroyed).toBe(true);
    expect(job.stderr.destroyed).toBe(true);
    // afterEach SIGKILLs the group, reaping the infinite writer.
  });

  it("probePid distinguishes live from dead pids", async () => {
    port = createProcessPort({ graceMs: 100, killPollMs: 20 });
    expect(port.probePid(process.pid)).toBe(true);
    expect(port.probePid(0)).toBe(false);
    expect(port.probePid(-1)).toBe(false);
    // pid 1 exists everywhere and is not ours → EPERM counts as alive
    // (unless the test runs as root/PID-1 namespace, where it is plainly alive).
    expect(port.probePid(1)).toBe(true);

    const job = await launch("exit 0");
    await job.drainedPromise;
    expect(await until(() => !port.probePid(job.pid))).toBe(true);
  });

  it("ignores $SHELL entirely (2026-10-17 revision)", async () => {
    // Basename `zsh` would have been honoured pre-revision; the path does not
    // exist, so honouring it would reject the spawn with ENOENT. Ignored ⇒ the
    // command runs under the default chain's bash.
    process.env.SHELL = "/definitely/not/installed/zsh";
    port = createProcessPort();
    const job = await launch('echo "shell=${BASH_VERSION:+bash}"');
    const streams = collect(job);
    const { exit } = await job.drainedPromise;
    expect(exit.exitCode).toBe(0);
    // Only bash defines BASH_VERSION (zsh/fish never would).
    expect(streams.out()).toContain("shell=bash");
  });

  it("spawns through piShellPath (allow-listed basename) even with $SHELL set", async () => {
    process.env.SHELL = "/bin/fish"; // must not matter
    port = createProcessPort({ piShellPath: "/bin/bash" });
    const job = await launch("echo via-pi-shell");
    const streams = collect(job);
    const { exit } = await job.drainedPromise;
    expect(exit.exitCode).toBe(0);
    expect(streams.out()).toContain("via-pi-shell");
  });

  it("a bogus allow-listed piShellPath surfaces as the spawn's own error (fail-soft, no throw at resolve)", async () => {
    port = createProcessPort({ piShellPath: "/definitely/not/installed/bash" });
    await expect(launch("echo nope")).rejects.toThrow();
  });

  it("checkPidOwnership: alive for our own child, dead once it exits", async () => {
    port = createProcessPort({ graceMs: 100, killPollMs: 20 });
    const job = await launch("sleep 60");
    const identity = {
      pid: job.pid,
      spawnedAt: Date.now(),
      ...(job.procStartTime !== undefined ? { procStartTime: job.procStartTime } : {}),
    };
    // Linux records a starttime → verifiable "alive"; elsewhere the honest
    // answer is "unsafe" (never killed, marked orphaned by the caller).
    expect(port.checkPidOwnership(identity)).toBe(linux ? "alive" : "unsafe");

    await port.killJobTree(job.pid);
    await job.drainedPromise;
    expect(await until(() => port.checkPidOwnership(identity) === "dead")).toBe(true);
  });

  it("checkPidOwnership: missing pid is dead, unverifiable identity is unsafe", () => {
    port = createProcessPort();
    expect(port.checkPidOwnership({ pid: undefined })).toBe("dead");
    expect(port.checkPidOwnership({ pid: 0 })).toBe("dead");
    // Live pid, no recorded identity → cannot prove it is ours.
    expect(port.checkPidOwnership({ pid: process.pid })).toBe("unsafe");
    // Live pid whose record predates the last boot → certainly stale.
    expect(port.checkPidOwnership({ pid: process.pid, spawnedAt: 0 })).toBe("dead");
  });

  it("readProcStartTime is a stable digit string on Linux and undefined elsewhere", () => {
    const value = readProcStartTime(process.pid);
    if (linux) {
      expect(value).toMatch(/^\d+$/);
      expect(readProcStartTime(process.pid)).toBe(value);
    } else {
      expect(value).toBeUndefined();
    }
    expect(readProcStartTime(0)).toBeUndefined();
  });
});

// ── Issue #73 (plan A+): file-fd stdio, wrapper exit file, log tail ────────

describe("readJobExitFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function file(content: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-exitfile-"));
    dirs.push(dir);
    const path = join(dir, "b_X.exit");
    if (content !== undefined) writeFileSync(path, content);
    return path;
  }

  it("parses the wrapper's `<n>\\n` format", () => {
    expect(readJobExitFile(file("0\n"))).toBe(0);
    expect(readJobExitFile(file("7\n"))).toBe(7);
    expect(readJobExitFile(file("143"))).toBe(143);
  });

  it("treats a missing, empty, torn or nonsensical file as 'no authoritative code'", () => {
    expect(readJobExitFile(file(undefined))).toBeUndefined();
    expect(readJobExitFile(file(""))).toBeUndefined();
    expect(readJobExitFile(file("\n"))).toBeUndefined();
    expect(readJobExitFile(file("abc\n"))).toBeUndefined();
    expect(readJobExitFile(file("-1\n"))).toBeUndefined();
    expect(readJobExitFile(file("256\n"))).toBeUndefined();
    expect(readJobExitFile(file("7 8\n"))).toBeUndefined();
  });
});

describe("createLogTail", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function logFile(content = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tail-"));
    dirs.push(dir);
    const path = join(dir, "b_X.log");
    writeFileSync(path, content);
    return path;
  }
  async function collectAll(stream: NodeJS.ReadableStream): Promise<string> {
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    await new Promise<void>((resolve) => stream.once("end", () => resolve()));
    return text;
  }

  it("streams appended bytes in order, then ends at the first EOF after the process exited", async () => {
    const path = logFile("one\n");
    let exited = false;
    const tail = createLogTail(path, () => exited, { pollMs: 10, idlePollMs: 10 });
    const done = collectAll(tail);
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(path, "one\ntwo\n");
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(path, "one\ntwo\nthree\n");
    exited = true;
    expect(await done).toBe("one\ntwo\nthree\n");
  });

  it("an exit event wakes the poll at once instead of waiting out the idle interval", async () => {
    const path = logFile("fast\n");
    const emitter = new EventEmitter();
    let exited = false;
    // idle interval far longer than the assertion window: only the wake can end it in time
    const tail = createLogTail(path, () => exited, { pollMs: 5_000, idlePollMs: 5_000, wakeOn: emitter });
    const done = collectAll(tail);
    await new Promise((r) => setTimeout(r, 30)); // first poll read "fast\n", next one is 5s away
    exited = true;
    const t0 = Date.now();
    emitter.emit("exit");
    expect(await done).toBe("fast\n");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("does not end while the process is alive, however quiet the file is", async () => {
    const path = logFile("x\n");
    let ended = false;
    const tail = createLogTail(path, () => false, { pollMs: 10, idlePollMs: 10 });
    tail.on("data", () => undefined);
    tail.once("end", () => {
      ended = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(ended).toBe(false);
    tail.destroy();
  });

  it("stops reading at maxBytes (the cap) and ends", async () => {
    const path = logFile("0123456789abcdef");
    const tail = createLogTail(path, () => true, { pollMs: 5, idlePollMs: 5, maxBytes: 10 });
    expect(await collectAll(tail)).toBe("0123456789");
  });

  it("emits every byte exactly once when a consumer attaches late (single-flight pump)", async () => {
    const path = logFile("hello\nworld\n");
    const tail = createLogTail(path, () => true, { pollMs: 5, idlePollMs: 5 });
    await new Promise((r) => setTimeout(r, 60)); // the timer-armed poll runs before any listener
    expect(await collectAll(tail)).toBe("hello\nworld\n");
  });

  it("destroy() releases its timer and fd (no further reads, no event-loop hold)", async () => {
    const path = logFile("a");
    const tail = createLogTail(path, () => false, { pollMs: 5, idlePollMs: 5 });
    tail.on("data", () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    tail.destroy();
    expect(tail.destroyed).toBe(true);
    // Appending after destroy must not resurrect it.
    writeFileSync(path, "ab");
    await new Promise((r) => setTimeout(r, 40));
    expect(tail.destroyed).toBe(true);
  });
});

describe.skipIf(!posix)("createProcessPort file-fd mode (issue #73)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const job of spawned.splice(0)) {
      try {
        process.kill(-job.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    await Promise.resolve();
  });

  function stdioFor(maxLogBytes = 10 * 1024 * 1024): JobStdioOptions {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-fdmode-"));
    dirs.push(dir);
    return { logPath: join(dir, "b_X.log"), exitPath: join(dir, "b_X.exit"), maxLogBytes };
  }
  async function launchFd(command: string, stdio: JobStdioOptions): Promise<SpawnedJob> {
    port = createProcessPort({ graceMs: 300, killPollMs: 20 });
    const job = await port.spawnJob(command, process.cwd(), undefined, stdio);
    spawned.push(job);
    return job;
  }

  it("the log is a plain file the child writes: stdout+stderr merged, in write order", async () => {
    const stdio = stdioFor();
    const job = await launchFd("echo out1; echo err1 >&2; echo out2; exit 0", stdio);
    expect(job.logWrittenByChild).toBe(true);
    expect(job.exitFilePath).toBe(stdio.exitPath);
    let streamed = "";
    job.stdout.on("data", (chunk: Buffer) => {
      streamed += chunk.toString("utf8");
    });
    await job.drainedPromise;
    expect(readFileSync(stdio.logPath, "utf8")).toBe("out1\nerr1\nout2\n");
    // The tail relays exactly the file's bytes (that is what `onData` sees).
    expect(streamed).toBe("out1\nerr1\nout2\n");
  });

  it("persists the inner shell's exit code atomically, and the event carries the same code", async () => {
    for (const [command, code] of [
      ["exit 0", 0],
      ["exit 7", 7],
      ["cd /nonexistent-dir-xyz", 1],
      ["true; false", 1],
    ] as const) {
      const stdio = stdioFor();
      const job = await launchFd(command, stdio);
      const { exit } = await job.drainedPromise;
      expect(exit.exitCode).toBe(code);
      expect(readJobExitFile(stdio.exitPath)).toBe(code);
      expect(existsSync(`${stdio.exitPath}.tmp`)).toBe(false);
    }
  });

  it("a user EXIT trap does not disturb the recorded code (only the outer sh writes it)", async () => {
    const stdio = stdioFor();
    const job = await launchFd("trap 'echo bye' EXIT; exit 5", stdio);
    const { exit } = await job.drainedPromise;
    expect(exit.exitCode).toBe(5);
    expect(readJobExitFile(stdio.exitPath)).toBe(5);
    expect(readFileSync(stdio.logPath, "utf8")).toBe("bye\n");
  });

  it("the command is a positional parameter: quotes, $() and newlines cannot reach the wrapper", async () => {
    const stdio = stdioFor();
    const nasty = 'echo \'a"b\' "$(echo sub)" ; echo line2\necho line3 # \\';
    const job = await launchFd(nasty, stdio);
    await job.drainedPromise;
    expect(readFileSync(stdio.logPath, "utf8")).toBe('a"b sub\nline2\nline3\n');
    expect(readJobExitFile(stdio.exitPath)).toBe(0);
  });

  it("caps the log inside the job tree: the file stops growing but the command runs to its own exit", async () => {
    const cap = 2_048;
    const stdio = stdioFor(cap);
    const job = await launchFd("yes | head -c 100000; echo after-cap; exit 9", stdio);
    let streamed = 0;
    job.stdout.on("data", (chunk: Buffer) => {
      streamed += chunk.length;
    });
    const { exit } = await job.drainedPromise;
    expect(exit.exitCode).toBe(9); // the command was NOT killed by the cap (no SIGPIPE)
    expect(readJobExitFile(stdio.exitPath)).toBe(9);
    const size = statSync(stdio.logPath).size;
    // At most one `dd` block past the cap (that overshoot byte is the truncation witness).
    expect(size).toBeGreaterThan(cap);
    expect(size).toBeLessThanOrEqual(cap + LOG_CAP_BLOCK_BYTES);
    expect(readFileSync(stdio.logPath, "utf8")).not.toContain("after-cap");
    // The tail never reads past the capped file.
    expect(streamed).toBe(size);
  });

  it("keeps running, and keeps logging, after the spawning process lets go (no SIGPIPE on a closed reader)", async () => {
    // The in-process half of the #73 property: destroying every pi-side stream
    // (what a vanished reader looks like) must not hurt the job at all.
    const stdio = stdioFor();
    const job = await launchFd("sleep 0.3; echo late-write; exit 4", stdio);
    job.stdout.destroy();
    job.stderr.destroy();
    await job.processExitPromise;
    expect(readFileSync(stdio.logPath, "utf8")).toBe("late-write\n");
    expect(readJobExitFile(stdio.exitPath)).toBe(4);
  });

  it("external SIGTERM of the shell is a failure (143) with an exit file — known, accepted semantics change", async () => {
    // Pipe mode reported `signal: SIGTERM` here (→ status `killed`). With the
    // wrapper, the *inner* shell's death-by-signal is folded into `$?` = 128+n
    // and recorded; only a kill of the whole group (what `bash_job kill` does)
    // still takes the outer sh down too. Documented in docs/dev/bash-timeout-grace.
    const stdio = stdioFor();
    const job = await launchFd("kill -TERM $$", stdio);
    const { exit } = await job.drainedPromise;
    expect(exit.exitCode).toBe(143);
    expect(exit.signal).toBeNull();
    expect(readJobExitFile(stdio.exitPath)).toBe(143);
  });

  it("killJobTree on the group still ends the job, leaves no exit file and reports a signal", async () => {
    const stdio = stdioFor();
    const job = await launchFd("sleep 60", stdio);
    expect(await port.killJobTree(job.pid, { graceMs: 300 })).toMatch(/terminated|killed/);
    const { exit } = await job.drainedPromise;
    expect(exit.signal === "SIGTERM" || exit.signal === "SIGKILL").toBe(true);
    // The wrapper itself died before it could write: honest "no code".
    expect(readJobExitFile(stdio.exitPath)).toBeUndefined();
    expect(await until(() => !probePid(job.pid))).toBe(true);
  });

  it("recreates a swept exit directory (fork/handoff GCs the old session dir mid-job)", async () => {
    const stdio = stdioFor();
    const job = await launchFd("sleep 0.4; exit 6", stdio);
    // Simulate the GC: the exit file's directory vanishes while the job runs
    // (the job's already-open log fd stays valid, like in a real handoff).
    rmSync(join(stdio.exitPath, ".."), { recursive: true, force: true });
    await job.processExitPromise;
    expect(readJobExitFile(stdio.exitPath)).toBe(6);
  });

  it("without stdio options the classic pipe topology is unchanged", async () => {
    port = createProcessPort();
    const job = await port.spawnJob("echo piped", process.cwd());
    spawned.push(job);
    expect(job.logWrittenByChild).toBe(false);
    expect(job.exitFilePath).toBeUndefined();
    const streams = collect(job);
    await job.drainedPromise;
    expect(streams.out()).toBe("piped\n");
  });
});
