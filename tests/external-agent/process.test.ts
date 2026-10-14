import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { classifiedInfo } from "../../src/core/errors.js";
import { createSpawnChild, spawnManagedChild } from "../../src/external-agent/process.js";
import type { ManagedChild } from "../../src/external-agent/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "fixtures", "proc-child.mjs");
const PARENT = join(HERE, "fixtures", "proc-parent.mjs");
const ROOT = join(HERE, "..", "..");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function start(
  mode: string,
  extra: { extraEnv?: Record<string, string>; killGraceMs?: number; ownerWatchdog?: boolean } = {},
) {
  const child = spawnManagedChild({
    binary: process.execPath,
    args: [CHILD, mode],
    cwd: ROOT,
    extraEnv: extra.extraEnv ?? {},
    killGraceMs: extra.killGraceMs ?? 500,
    ownerWatchdog: extra.ownerWatchdog ?? false,
    clock: systemClock,
  });
  cleanups.push(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  });
  let out = "";
  child.onStdout((c) => {
    out += c.toString();
  });
  return { child, out: () => out };
}

function gcPid(out: string): number | undefined {
  const m = /gc:(\d+)/.exec(out);
  return m ? Number(m[1]) : undefined;
}

describe("spawnManagedChild", () => {
  it("ENOENT binary ⇒ ClassifiedError{config}; missing cwd ⇒ config; never startup_transient", () => {
    const base = { args: [], extraEnv: {}, killGraceMs: 100, ownerWatchdog: false, clock: systemClock };
    let e1: unknown;
    try {
      spawnManagedChild({ ...base, binary: "/nonexistent/definitely-not-here", cwd: ROOT });
    } catch (e) {
      e1 = e;
    }
    expect(classifiedInfo(e1)?.kind).toBe("config");
    expect(classifiedInfo(e1)?.retryable).toBe(false);
    let e2: unknown;
    try {
      spawnManagedChild({ ...base, binary: process.execPath, cwd: "/nonexistent-dir-xyz" });
    } catch (e) {
      e2 = e;
    }
    expect(classifiedInfo(e2)?.kind).toBe("config");
    let e3: unknown;
    try {
      spawnManagedChild({ ...base, binary: "no-such-binary-on-path-xyz", cwd: ROOT });
    } catch (e) {
      e3 = e;
    }
    expect(classifiedInfo(e3)?.kind).toBe("config");
  });

  it("round-trips stdin/stdout, merges extraEnv by key (values never echoed), redacts stderr", async () => {
    const { child, out } = start("echo", { extraEnv: { PTK_TEST_X: "supersecretvalue" } });
    await waitFor(() => out().includes("ready"), 5000, "ready");
    expect(child.write("hi\n")).toBe(true);
    await waitFor(() => out().includes("echo:hi"), 5000, "echo");
    child.write("env\n");
    await waitFor(() => out().includes("envkeys:"), 5000, "envkeys");
    expect(out()).toContain("envkeys:PTK_TEST_X");
    expect(out()).not.toContain("supersecretvalue");
    child.write("stderr\n");
    await waitFor(() => out().includes("stderr-done"), 5000, "stderr-done");
    await waitFor(() => child.stderrTail().includes("boom"), 5000, "stderr");
    const tail = child.stderrTail();
    expect(tail).not.toContain("SUPERSECRET123");
    expect(tail).not.toContain("abcdef");
    expect(tail).toContain("***");
    expect(tail.length).toBeLessThanOrEqual(2048);
    child.terminate("now");
    await child.exited;
  });

  it("write after exit throws ClassifiedError{internal}", async () => {
    const { child, out } = start("echo");
    await waitFor(() => out().includes("ready"), 5000, "ready");
    child.terminate("now");
    const exit = await child.exited;
    expect(exit.signal).toBe("SIGKILL");
    expect(child.exitInfo()).toEqual(exit);
    let err: unknown;
    try {
      child.write("x\n");
    } catch (e) {
      err = e;
    }
    expect(classifiedInfo(err)?.kind).toBe("internal");
  });

  it("graceful terminate kills the whole group: no surviving grandchild", async () => {
    const { child, out } = start("grandchild");
    await waitFor(() => gcPid(out()) !== undefined, 5000, "grandchild pid");
    const gc = gcPid(out()) as number;
    expect(alive(gc)).toBe(true);
    const r = child.terminate("graceful");
    expect(r.signalled).toBe(true);
    expect(child.terminating()).toBe(true);
    await child.exited;
    await waitFor(() => !alive(gc), 3000, "grandchild death");
    expect(groupAlive(child.pid)).toBe(false);
    expect(child.graceExpired()).toBe(false);
    // idempotent
    expect(child.terminate("graceful").signalled).toBe(false);
    expect(child.terminate("now").signalled).toBe(false);
  });

  it("SIGTERM ignored ⇒ SIGKILL after killGraceMs; graceExpired() is true", async () => {
    const { child, out } = start("ignore-term", { killGraceMs: 300 });
    await waitFor(() => gcPid(out()) !== undefined, 5000, "grandchild pid");
    const gc = gcPid(out()) as number;
    const t0 = Date.now();
    child.terminate("graceful");
    await new Promise((r) => setTimeout(r, 120));
    expect(child.exitInfo()).toBeUndefined(); // still alive within grace
    expect(child.graceExpired()).toBe(false);
    const exit = await child.exited;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(exit.signal).toBe("SIGKILL");
    expect(child.graceExpired()).toBe(true);
    await waitFor(() => !alive(gc), 3000, "grandchild death");
  });

  it('terminate("now") escalates an in-progress graceful immediately', async () => {
    const { child } = start("ignore-term", { killGraceMs: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    child.terminate("graceful");
    const t0 = Date.now();
    expect(child.terminate("now").signalled).toBe(true);
    const exit = await child.exited;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(exit.signal).toBe("SIGKILL");
    expect(child.graceExpired()).toBe(false);
  });

  it("natural exit sweeps leftover group members", async () => {
    const { child, out } = start("grandchild-exit");
    await waitFor(() => gcPid(out()) !== undefined, 5000, "grandchild pid");
    const gc = gcPid(out()) as number;
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    await waitFor(() => !alive(gc), 3000, "grandchild death");
  });

  it("stdin EOF is observable (graceful terminate ends stdin)", async () => {
    const { child, out } = start("exit-on-eof", { killGraceMs: 5000 });
    await waitFor(() => out().includes("ready"), 5000, "ready");
    child.terminate("graceful");
    const exit = await child.exited;
    // SIGTERM may win the race with EOF; either way it ends well inside the grace window.
    expect(child.graceExpired()).toBe(false);
    expect(exit.code === 0 || exit.signal === "SIGTERM").toBe(true);
  });

  it("registers in the process-global table and installs the exit hook once", async () => {
    const before = process.listenerCount("exit");
    const a = start("exit-on-eof");
    const afterFirst = process.listenerCount("exit");
    const b = start("exit-on-eof");
    const afterSecond = process.listenerCount("exit");
    expect(afterFirst - before).toBeLessThanOrEqual(1);
    expect(afterSecond).toBe(afterFirst);
    const reg = (globalThis as Record<symbol, { procs: Map<number, unknown>; hookInstalled: boolean } | undefined>)[
      Symbol.for("pi-subagent:external-agent-procs")
    ];
    expect(reg?.hookInstalled).toBe(true);
    expect(reg?.procs.has(a.child.pid)).toBe(true);
    expect(reg?.procs.has(b.child.pid)).toBe(true);
    a.child.terminate("now");
    b.child.terminate("now");
    await Promise.all([a.child.exited, b.child.exited]);
    expect(reg?.procs.has(a.child.pid)).toBe(false);
  });

  it("injected redactor is used for stderrTail", async () => {
    const mk = createSpawnChild((t) => t.replaceAll("boom", "BANG"));
    const child: ManagedChild = mk({
      binary: process.execPath,
      args: [CHILD, "echo"],
      cwd: ROOT,
      extraEnv: {},
      killGraceMs: 200,
      ownerWatchdog: false,
      clock: systemClock,
    });
    cleanups.push(() => child.terminate("now"));
    child.write("stderr\n");
    await waitFor(() => child.stderrTail().includes("BANG"), 5000, "stderr");
    expect(child.stderrTail()).not.toContain("boom");
    child.terminate("now");
    await child.exited;
  });
});

function runParent(mode: string, childMode: string) {
  const p = spawn(process.execPath, ["--import", "tsx", PARENT, mode, CHILD, childMode], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(() => p.kill("SIGKILL"));
  let out = "";
  p.stdout.on("data", (c: Buffer) => {
    out += c.toString();
  });
  return { p, out: () => out };
}

describe("lifecycle through a real parent process", () => {
  it("ownerWatchdog: stdin passes through; SIGKILL of the parent ⇒ whole group dead ≤3s", async () => {
    const { p, out } = runParent("watchdog", "grandchild");
    await waitFor(() => /pid:\d+/.test(out()) && /gc:\d+/.test(out()), 15000, "child+grandchild up");
    const pgid = Number(/pid:(\d+)/.exec(out())?.[1]);
    const gc = gcPid(out()) as number;
    cleanups.push(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    });
    expect(alive(gc)).toBe(true);
    expect(groupAlive(pgid)).toBe(true);
    p.kill("SIGKILL");
    const t0 = Date.now();
    await waitFor(() => !groupAlive(pgid) && !alive(gc), 3000, "group wiped");
    expect(Date.now() - t0).toBeLessThanOrEqual(3000);
  }, 30_000);

  it("ownerWatchdog: stdin (0<&0) reaches the wrapped binary and the watchdog env does not leak", async () => {
    const { p, out } = runParent("watchdog", "echo");
    await waitFor(() => out().includes("echo:hello"), 15000, "stdin passthrough");
    const pgid = Number(/pid:(\d+)/.exec(out())?.[1]);
    p.kill("SIGKILL");
    await waitFor(() => !groupAlive(pgid), 4000, "group wiped");
  }, 30_000);

  it("ownerWatchdog child env hides the watchdog variables", async () => {
    const child = spawnManagedChild({
      binary: process.execPath,
      args: [CHILD, "echo"],
      cwd: ROOT,
      extraEnv: { PTK_VISIBLE: "1" },
      killGraceMs: 300,
      ownerWatchdog: true,
      clock: systemClock,
    });
    cleanups.push(() => child.terminate("now"));
    let out = "";
    child.onStdout((c) => {
      out += c.toString();
    });
    await waitFor(() => out.includes("ready"), 5000, "ready");
    child.write("env\n");
    await waitFor(() => out.includes("envkeys:"), 5000, "envkeys");
    expect(out).toContain("envkeys:PTK_VISIBLE\n");
    expect(out).not.toContain("__PTK_OWNER");
    child.terminate("graceful");
    await child.exited;
  }, 30_000);

  it("all timers are unref'd and the exit hook sweeps: parent exits by itself, child group dies", async () => {
    const { p, out } = runParent("unref", "ignore-term");
    const exitCode = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(-999), 15000);
      p.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(exitCode).toBe(0); // a ref'd 60s grace timer / socket would keep it alive (−999)
    const pgid = Number(/pid:(\d+)/.exec(out())?.[1]);
    cleanups.push(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    });
    await waitFor(() => !groupAlive(pgid), 3000, "group swept by exit hook");
  }, 30_000);
});
