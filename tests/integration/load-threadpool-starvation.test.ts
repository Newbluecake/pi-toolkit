import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const childFixture = resolve("tests/integration/fixtures/sysload/starvation-child.mjs");

function runFixture(mode: "activation" | "top"): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", childFixture, mode], {
      env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`starvation fixture timed out (${mode}): ${output}`));
    }, 10_000);
    child.stdout.on("data", () => {
      if (output.includes('"verdict":"pass"')) child.kill("SIGKILL");
    });
    timer.unref();
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      // The fixture ends in a deliberately-stuck top-level await and is SIGKILLed by us, so
      // its own `finally` (mkfifo cleanup) is unreachable — reclaim the fifo from the parent
      // (its path is derived from the child pid, so this is race-free once exit has fired).
      rmSync(join(tmpdir(), `pi-toolkit-sysload-${child.pid}.fifo`), { force: true });
      resolveResult({ code, output });
    });
  });
}

/** The report is the last line that parses to a JSON object carrying a `verdict` — stdout and
 * stderr are merged, and stderr may carry Node diagnostics (e.g. the unsettled-TLA warning,
 * loader noise) that arrive AFTER the report line, so the literal last line is not trustworthy.
 * On total failure the full child output rides along in the error message. */
function parseReport(mode: string, output: string): Record<string, unknown> {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.verdict === "string") return parsed;
    } catch {
      // not the report line — keep scanning upward
    }
  }
  throw new Error(`no verdict report line in ${mode} fixture output:\n${output}`);
}

describe.skipIf(process.platform !== "linux")("sysload thread-pool starvation", () => {
  it("runs the real activation/sampleOnce/top loop without starving unrelated IO", async () => {
    const result = await runFixture("activation");
    expect(result.code).toBeNull();
    const report = parseReport("activation", result.output);
    expect(report.verdict).toBe("pass");
    expect(report.active).toBeLessThanOrEqual(2);
    expect(report.lateDiscarded).toBe(true);
    expect(report.elapsedMs).toBeLessThan(200);
  }, 15_000);

  it("does not double-fire a stuck top enumeration", async () => {
    const result = await runFixture("top");
    expect(result.code).toBeNull();
    const report = parseReport("top", result.output);
    expect(report.verdict).toBe("pass");
    expect(report.active).toBe(1);
  }, 15_000);
});
