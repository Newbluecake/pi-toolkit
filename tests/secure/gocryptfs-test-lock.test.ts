/**
 * todo #31 — the gocryptfs test lock must die with the test run. A child node process (the stand-in
 * for a vitest worker) takes the lock through the real module; when it — or its parent, the stand-in
 * for vitest's main process — is SIGKILLed, the lock must be acquirable at once (≤0.5 s) with no
 * process left holding the lock file open.
 * Uses a private lock file in a mktemp dir, never the shared GOCRYPTFS_TEST_LOCK.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";

const MODULE = join(import.meta.dirname, "gocryptfs-test-lock.ts");
const dir = mkdtempSync(join(tmpdir(), "pi-secure-lock31-"));
const lockFile = join(dir, "test.lock");
const haveFlock = spawnSync("flock", ["--version"]).status === 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tryLock = (): number | null => spawnSync("flock", ["-n", lockFile, "true"]).status;

function ppidOf(pid: number): number | undefined {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}
function procState(pid: number): string | undefined {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, "utf8");
    return t.slice(t.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}
function childrenOf(pid: number): number[] {
  return readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((n) => ppidOf(n) === pid && procState(n) !== "Z");
}

/** pids (other than ours) that hold an fd on `file`. */
function holders(file: string): number[] {
  const out: number[] = [];
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${p}/fd`);
    } catch {
      continue;
    }
    for (const f of fds) {
      try {
        if (readlinkSync(`/proc/${p}/fd/${f}`) === file) {
          out.push(Number(p));
          break;
        }
      } catch {
        /* raced */
      }
    }
  }
  return out;
}

describe.skipIf(!haveFlock)("gocryptfs test lock (todo #31)", () => {
  it("in-process: exclusive, bounded wait, released by the release function", async () => {
    const rel = await acquireGocryptfsTestLock(5_000, lockFile);
    expect(tryLock()).toBe(1);
    await expect(acquireGocryptfsTestLock(1_000, lockFile)).rejects.toThrow(/not acquired/);
    rel();
    rel(); // idempotent
    expect(await freeWithin(500)).toBeLessThan(500);
    const again = await acquireGocryptfsTestLock(2_000, lockFile);
    again();
  });

  /** Spawn `node -e <script>` and wait for its "held" line. */
  async function heldBy(script: string, marker = "held"): Promise<{ child: ChildProcess; out: () => string }> {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: join(import.meta.dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stderr!.on("data", (b: Buffer) => (err += b.toString()));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`never locked: ${err}`)), 20_000);
      child.stdout!.on("data", (b: Buffer) => {
        out += b.toString();
        if (out.includes(marker)) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", (c) => reject(new Error(`exited ${c}: ${err}`)));
    });
    return { child, out: () => out };
  }
  const acquireSrc =
    `const { acquireGocryptfsTestLock } = await import(${JSON.stringify(MODULE)});` +
    `await acquireGocryptfsTestLock(5000, ${JSON.stringify(lockFile)});`;
  async function freeWithin(ms: number): Promise<number> {
    const t0 = Date.now();
    while (tryLock() !== 0) {
      if (Date.now() - t0 > ms) throw new Error(`lock still held after ${ms} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return Date.now() - t0;
  }

  it("the test process SIGKILLed ⇒ the lock is free at once and nothing keeps the file open", async () => {
    const { child } = await heldBy(`${acquireSrc} process.stdout.write("held\\n"); setInterval(() => {}, 1000);`);
    expect(tryLock()).toBe(1); // really held
    const hs = holders(lockFile);
    expect(hs.length).toBe(1); // exactly one holder: the small watcher, not the test process itself
    expect(hs).not.toContain(child.pid);
    expect(ppidOf(hs[0]!)).toBe(child.pid);
    const exited = new Promise((r) => child.on("exit", r));
    process.kill(child.pid!, "SIGKILL");
    await exited;
    expect(await freeWithin(500)).toBeLessThan(500);
    expect(holders(lockFile)).toEqual([]);
  }, 30_000);

  it("vitest's MAIN process SIGKILLed while its worker lives on ⇒ the lock is still released (≤0.5 s)", async () => {
    // P stands in for vitest's main process, W (P's child) for the fork worker holding the lock.
    // Killing P orphans W (exactly what SIGKILL of vitest's main does); W keeps running.
    const wSrc = `${acquireSrc} process.stdout.write("held " + process.pid + "\\n"); setInterval(() => {}, 1000);`;
    const pSrc =
      `const { spawn } = await import("node:child_process");` +
      `const w = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(wSrc)}], { stdio: ["ignore", "inherit", "inherit"] });` +
      `setInterval(() => {}, 1000);`;
    const { child: p, out } = await heldBy(pSrc);
    const wPid = Number(/held (\d+)/.exec(out())![1]);
    expect(ppidOf(wPid)).toBe(p.pid);
    expect(tryLock()).toBe(1);
    const exited = new Promise((r) => p.on("exit", r));
    process.kill(p.pid!, "SIGKILL");
    await exited;
    try {
      expect(await freeWithin(500)).toBeLessThan(500);
      expect(existsSync(`/proc/${wPid}`)).toBe(true); // the orphaned worker is still alive …
      expect(holders(lockFile)).toEqual([]); // … but nothing holds the lock any more
    } finally {
      try {
        process.kill(wPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 30_000);

  it("WAITING for the lock: vitest's MAIN process SIGKILLed while its worker lives on ⇒ the waiting watcher exits at once (review m1)", async () => {
    const mine = await acquireGocryptfsTestLock(5000, lockFile); // taken ⇒ the worker below must wait
    const wSrc =
      `const { acquireGocryptfsTestLock } = await import(${JSON.stringify(MODULE)});` +
      `acquireGocryptfsTestLock(60000, ${JSON.stringify(lockFile)}).then(() => process.stdout.write("GOT\\n"), () => {});` +
      `process.stdout.write("waiting " + process.pid + "\\n"); setInterval(() => {}, 1000);`;
    const pSrc =
      `const { spawn } = await import("node:child_process");` +
      `spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(wSrc)}], { stdio: ["ignore", "inherit", "inherit"] });` +
      `setInterval(() => {}, 1000);`;
    const { child: p, out } = await heldBy(pSrc, "waiting");
    const wPid = Number(/waiting (\d+)/.exec(out())![1]);
    try {
      // the waiter's watcher: a child of W running the holder script, polling with flock -n
      let watcher: number | undefined;
      const t0 = Date.now();
      while ((watcher = childrenOf(wPid).find((c) => cmdlineOf(c).includes("flock -n -x 3"))) === undefined) {
        if (Date.now() - t0 > 10_000) throw new Error("waiting watcher never appeared");
        await new Promise((r) => setTimeout(r, 20));
      }
      const exited = new Promise((r) => p.on("exit", r));
      process.kill(p.pid!, "SIGKILL");
      await exited;
      const t1 = Date.now();
      while (existsSync(`/proc/${watcher}`) && procState(watcher) !== "Z") {
        if (Date.now() - t1 > 500) throw new Error("waiting watcher still alive 500 ms after the main process died");
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(existsSync(`/proc/${wPid}`)).toBe(true); // the orphaned worker lives on …
      expect(childrenOf(watcher)).toEqual([]); // … no flock/sleep child of the watcher is left …
      const hs = holders(lockFile);
      expect(hs.length).toBe(1); // … and only OUR holder still has the lock file open
      expect(ppidOf(hs[0]!)).toBe(process.pid);
      expect(out()).not.toContain("GOT");
    } finally {
      try {
        process.kill(wPid, "SIGKILL");
      } catch {
        /* gone */
      }
      mine();
    }
    expect(await freeWithin(500)).toBeLessThan(500);
  }, 30_000);

  it("no detached long-lived holder remains in the module (pin)", () => {
    const src = readFileSync(MODULE, "utf8");
    expect(src).not.toMatch(/sleep 3600|detached:\s*true/);
  });
});
