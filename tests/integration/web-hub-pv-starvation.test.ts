/**
 * web-hub HTML preview plan v2 §8 T-I1 — the `/pv` starvation suite (P3): a REAL child
 * process (`UV_THREADPOOL_SIZE=4`, pi's bundled jiti runs fixtures/pv-starvation-child.ts)
 * with a REAL FIFO (a blocking open whose `O_NONBLOCK` the PV fs seam strips) and a REAL
 * never-settling handle close, both through `createPreviewRoutes({ html })` on a REAL
 * `createHttpFrontend` (loopback + LAN listeners).
 *
 * With both `PV_IO_SLOTS` held by never-settling ops, the child proves T-I1: `/pv` degrades to
 * bounded 503s while ordinary `/api/preview`, a full upload begin→chunk→commit POST and a LAN
 * login (real async scrypt) all complete within their normal budgets. The child performs every
 * assertion itself and reports the verdict as its LAST stdout JSON line; it can never exit on
 * its own (a pending blocking threadpool open blocks `process.exit` — measured on Node 22), so
 * this wrapper reads the verdict, then SIGKILLs. The wrapper re-asserts the hard fields from
 * the report so a silent child regression cannot pass, and surfaces the full report + child
 * stderr on any failure.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveJitiCli } from "../../src/web-hub/agent/launcher.js";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const CHILD = resolve("tests/integration/fixtures/pv-starvation-child.ts");
const IS_LINUX = process.platform === "linux";

function jiti(): string | undefined {
  if (!existsSync(PI_CLI)) return undefined;
  const r = resolveJitiCli({ argv1: PI_CLI, override: "" });
  return r.ok ? r.jitiCli : undefined;
}

const JITI = jiti();

interface PhaseReport {
  status: number;
  ms: number;
}

interface ChildReport {
  verdict?: "pass" | "fail";
  error?: string;
  pvSanity?: PhaseReport;
  fifoWedge?: PhaseReport;
  closeWedge?: PhaseReport;
  closeStarted?: number;
  pvDegraded?: PhaseReport;
  previewRead?: PhaseReport;
  uploadBegin?: PhaseReport;
  uploadChunk?: PhaseReport;
  uploadCommit?: PhaseReport;
  lanLogin?: PhaseReport;
  scryptWithPoolWedged?: { ms: number };
}

describe.skipIf(!IS_LINUX || JITI === undefined)("web-hub HTML preview — /pv libuv starvation (T-I1)", () => {
  it("PV_IO_SLOTS wedged by never-settling ops (blocking FIFO open + never-settling close): /pv degrades to bounded 503s while preview/uploads/LAN scrypt stay live", async () => {
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
    // the wedged child can never exit on its own (a pending blocking threadpool open blocks
    // process.exit) — every path through this test must still SIGKILL it and BOUNDEDLY await
    // exit + pipe close.
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
        child.once("exit", (code, signal) => {
          clearTimeout(t);
          clearInterval(poll);
          rejectVerdict(
            new Error(
              `starvation child exited on its own (code=${code} signal=${signal}) — it must stay wedged:\nSTDOUT:\n${out}\nSTDERR:\n${err}`,
            ),
          );
        });
      });
    } catch (e) {
      await killAndWait();
      throw e;
    }
    try {
      const report = JSON.parse(verdictLine) as ChildReport;
      // re-assert the hard fields — a silent child regression must not pass
      expect(report.verdict).toBe("pass");
      expect(report.error).toBeUndefined();
      expect(report.pvSanity?.status).toBe(200);
      // the blocking FIFO open: 503 at the 2s per-op race, never a hang
      expect(report.fifoWedge?.status).toBe(503);
      expect(report.fifoWedge?.ms ?? Infinity).toBeLessThan(7_000);
      // the never-settling close held slot 2 after a normal 200
      expect(report.closeWedge?.status).toBe(200);
      expect(report.closeStarted ?? 0).toBeGreaterThan(0);
      // both slots zombie ⇒ bounded busy 503 within the 4s admit deadline
      expect(report.pvDegraded?.status).toBe(503);
      expect(report.pvDegraded?.ms ?? Infinity).toBeLessThan(7_000);
      // T-I1 liveness: the rest of the hub keeps its budgets
      expect(report.previewRead?.status).toBe(200);
      expect(report.previewRead?.ms ?? Infinity).toBeLessThan(2_000);
      expect(report.uploadBegin?.status).toBe(200);
      expect(report.uploadChunk?.status).toBe(200);
      expect(report.uploadCommit?.status).toBe(200);
      expect(report.uploadCommit?.ms ?? Infinity).toBeLessThan(3_000);
      expect(report.lanLogin?.status).toBe(200);
      expect(report.lanLogin?.ms ?? Infinity).toBeLessThan(5_000);
      // phase 3 is record-only (§2.5's honest boundary) — surfaced, never asserted
      expect(report.scryptWithPoolWedged).toBeTypeOf("object");
    } catch (e) {
      await killAndWait();
      throw new Error(`${String(e)}\nCHILD REPORT:\n${out}\nCHILD STDERR:\n${err}`);
    }
    await killAndWait();
  }, 150_000);
});
