import { execFile as realExecFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runBounded, type RunDeps } from "../../src/web-hub/protocol/sysload-darwin.js";

/**
 * runBounded real-process discipline (sysload darwin-plan §4.4, S0 deliverable; acceptance
 * L7). Tier 2 by directory, deliberately WITHOUT a platform gate: every command used here
 * (`/bin/sleep`, `/bin/echo`, `/bin/sh`, `ps`) exists on both Linux CI and macOS, so the
 * process rules (validated positive budget, SIGKILL, reaping, no residue, unref) are proven on every
 * push — this file does NOT prove anything about macOS sysctl/ps output shapes (that is
 * E-MAC, tests/integration/sysload-darwin.test.ts, S4).
 *
 * Residue evidence follows the plan: a spy wraps the REAL execFile and records the child
 * pid; unique markers (`31.713`, `31.714`, `s0mb31.715` — unique across the repo) make any
 * surviving process line visible in `ps -A -o command=`.
 */
const ROOT = resolve(import.meta.dirname, "../..");

interface ExecRecord {
  file: string;
  args: readonly string[];
  options: { env: Record<string, string>; killSignal: string; maxBuffer: number };
  pid: number | undefined;
}

/** Wraps the real execFile, recording (file, args, options, pid) for every spawn. */
function spyExecFile(): { execFile: NonNullable<RunDeps["execFile"]>; calls: ExecRecord[] } {
  const calls: ExecRecord[] = [];
  const execFile = ((
    file: string,
    args: readonly string[],
    options: ExecRecord["options"],
    callback: (err: Error | null, stdout: string) => void,
  ) => {
    const record: ExecRecord = { file, args: [...args], options, pid: undefined };
    calls.push(record);
    const child = realExecFile(file, args, options as never, callback as never);
    record.pid = child.pid;
    return child;
  }) as unknown as NonNullable<RunDeps["execFile"]>;
  return { execFile, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `process.kill(pid, 0)` until the pid is proven gone (ESRCH) within the budget. */
async function waitPidGone(pid: number, budgetMs = 1_000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (Date.now() - started >= budgetMs) return false;
    await sleep(50);
  }
}

function psCommandLines(): string[] {
  const result = spawnSync("ps", ["-A", "-o", "command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`ps unavailable: ${String(result.error ?? result.status)}`);
  }
  return result.stdout.split("\n");
}

const markerLines = (marker: string): string[] => psCommandLines().filter((line) => line.includes(marker));

/** Polls until no process line carries the marker (bounded), then reports success. */
async function waitMarkerGone(marker: string, budgetMs = 3_000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (markerLines(marker).length === 0) return true;
    if (Date.now() - started >= budgetMs) return false;
    await sleep(100);
  }
}

describe("runBounded real-process discipline (darwin-plan §4.4, no platform gate)", () => {
  it("1. SIGKILL on timeout: ETIMEDOUT rejection, wall clock < timeout+400ms, pid reaped — and no raw `timeout` reaches the child (I5 deviation, see header)", async () => {
    const { execFile, calls } = spyExecFile();
    const started = Date.now();
    const promise = runBounded("/bin/sleep", ["31.713"], { timeoutMs: 150, maxBytes: 1024 }, { execFile });
    await expect(promise).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(550);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/bin/sleep");
    expect(calls[0]!.args).toEqual(["31.713"]);
    // the validated budget is enforced by our own unref'd SIGKILL timer; Node's execFile
    // `timeout` option carries a ref'd internal timer (I5) and is never forwarded (darwin-plan
    // §4.4-1 deviation, reported to the dispatcher — the entry RangeError gate closes the trap)
    expect("timeout" in calls[0]!.options).toBe(false);
    expect(calls[0]!.options.killSignal).toBe("SIGKILL");
    expect(calls[0]!.options.maxBuffer).toBe(1024);
    const pid = calls[0]!.pid;
    expect(typeof pid).toBe("number");
    await expect(waitPidGone(pid!)).resolves.toBe(true);
  }, 10_000);

  it("2. no residue: no `sleep 31.713` process line survives the kill", async () => {
    expect(existsSync("/bin/sleep")).toBe(true);
    expect(markerLines("31.713")).toEqual([]);
    await expect(runBounded("/bin/sleep", ["31.713"], { timeoutMs: 200, maxBytes: 1024 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(await waitMarkerGone("31.713")).toBe(true);
    expect(markerLines("31.713")).toEqual([]);
  }, 15_000);

  it("3. invalid timeoutMs rejects with RangeError immediately — the spy sees zero spawns (timeout:0 trap)", async () => {
    const { execFile, calls } = spyExecFile();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5000]) {
      const promise = runBounded("/bin/sleep", ["31.713"], { timeoutMs: bad, maxBytes: 1024 }, { execFile });
      await expect(promise, `timeoutMs=${bad}`).rejects.toThrow(RangeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("4. maxBuffer overflow rejects and leaves no orphan pipeline behind (unique marker in the sh command line)", async () => {
    const marker = "s0mb31.715";
    expect(markerLines(marker)).toEqual([]);
    await expect(
      runBounded("/bin/sh", ["-c", `yes ${marker} | head -c 5000000`], { timeoutMs: 2_000, maxBytes: 1024 }),
    ).rejects.toThrow();
    expect(await waitMarkerGone(marker)).toBe(true);
    expect(markerLines(marker)).toEqual([]);
  }, 15_000);

  it("5. status 0 resolves stdout verbatim (/bin/echo)", async () => {
    await expect(runBounded("/bin/echo", ["hi"], { timeoutMs: 900, maxBytes: 1024 })).resolves.toBe("hi\n");
  }, 10_000);

  it("6. unref: a child script that starts runBounded and never awaits still exits <1s (I5)", async () => {
    expect(existsSync("/bin/sleep")).toBe(true);
    const childScript = `
const { runBounded } = await import(${JSON.stringify(`${ROOT}/src/web-hub/protocol/sysload-darwin.ts`)});
void runBounded("/bin/sleep", ["31.714"], { timeoutMs: 1500, maxBytes: 1024 }).catch(() => undefined);
console.log("S0-STARTED");
`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let startedAt: number | undefined;
    let exitedAt: number | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (startedAt === undefined && chunk.toString("utf8").includes("S0-STARTED")) startedAt = Date.now();
    });
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectExit(new Error("child script did not exit within 30s — the sleep handle is keeping it alive"));
      }, 30_000);
      timer.unref();
      child.once("exit", (code) => {
        clearTimeout(timer);
        exitedAt = Date.now();
        resolveExit(code);
      });
    });
    expect(exitCode).toBe(0);
    expect(startedAt).toBeDefined();
    expect(exitedAt! - startedAt!).toBeLessThan(1_000);
    // Accepted I5 residual: the unref'd kill timer died with the script, so the sleep may
    // linger up to its own 31s — sweep it here rather than leaking it on the CI machine.
    try {
      spawnSync("pkill", ["-f", "sleep 31.714"]);
    } catch {
      /* pkill unavailable — the sleep self-expires within 31s */
    }
  }, 40_000);
});
