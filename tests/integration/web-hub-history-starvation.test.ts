/**
 * web-hub session-history plan §4.8 step 4 (P-int) — the starvation suite: a REAL child process
 * (`UV_THREADPOOL_SIZE=4`, pi's bundled jiti runs fixtures/history-starvation-child.ts) with a
 * REAL FIFO and the REAL history service whose open seam blocks the pool for that one path.
 *
 * The child performs every assertion itself and reports the verdict as its LAST stdout JSON
 * line (`"verdict":"pass"|"fail"`); it can never exit on its own (a pending blocking threadpool
 * open blocks process.exit — measured on Node 22), so this wrapper reads the verdict, then
 * SIGKILLs. The wrapper re-asserts the hard fields from the report so a silent child
 * regression cannot pass, and surfaces the full report + child stderr on any failure.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveJitiCli } from "../../src/web-hub/agent/launcher.js";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const CHILD = resolve("tests/integration/fixtures/history-starvation-child.ts");
const IS_LINUX = process.platform === "linux";

function jiti(): string | undefined {
  if (!existsSync(PI_CLI)) return undefined;
  const r = resolveJitiCli({ argv1: PI_CLI, override: "" });
  return r.ok ? r.jitiCli : undefined;
}

const JITI = jiti();

describe.skipIf(!IS_LINUX || JITI === undefined)("web-hub session history — libuv starvation (PD4)", () => {
  it("history wedged on a blocking FIFO holds ≤ HISTORY_FS_SLOTS threads; preview/uploads/scrypt stay live; preview-wedged case recorded only", async () => {
    const child = spawn(process.execPath, [JITI!, CHILD], {
      env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    // P1-b: the wedged child can never exit on its own (a pending blocking threadpool open
    // blocks process.exit) — every path through this test, including a verdict timeout AND
    // any later assertion throw, must still SIGKILL it and BOUNDEDLY await exit + pipe close.
    const killAndWait = async (): Promise<void> => {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        t.unref();
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    let verdictLine: string;
    try {
      // the verdict line lands long before this bound; the child cannot exit by itself
      verdictLine = await new Promise<string>((resolveVerdict, rejectVerdict) => {
        const t = setTimeout(
          () => rejectVerdict(new Error(`starvation child never reported:\nSTDOUT:\n${out}\nSTDERR:\n${err}`)),
          120_000,
        );
        t.unref();
        const poll = setInterval(() => {
          const lines = out
            .trim()
            .split("\n")
            .filter((l) => l.startsWith("{"));
          const last = lines[lines.length - 1];
          if (last !== undefined && (last.includes('"verdict":"pass"') || last.includes('"verdict":"fail"'))) {
            clearTimeout(t);
            clearInterval(poll);
            resolveVerdict(last);
          }
        }, 100);
        poll.unref();
      });
    } finally {
      await killAndWait();
    }
    const report = JSON.parse(verdictLine) as Record<string, unknown>;
    if (report["verdict"] !== "pass") {
      throw new Error(`starvation child failed: ${verdictLine}\nSTDERR:\n${err}`);
    }
    // hard fields re-asserted here so a silent child regression cannot pass
    const previewRead = report["previewRead"] as { outcome?: string };
    const uploadsWrite = report["uploadsWrite"] as { outcome?: string };
    const scrypt1 = report["scrypt"] as { outcome?: string };
    expect(previewRead?.outcome).toBe("ok");
    expect(uploadsWrite?.outcome).toBe("ok");
    expect(scrypt1?.outcome).toBe("ok");
    const history = report["history"] as { resolveMs?: number[]; pageMs?: number[] };
    expect(history.resolveMs?.every((ms) => ms < 2_000)).toBe(true);
    expect(history.pageMs?.every((ms) => ms < 2_000)).toBe(true);
  }, 150_000);
});
