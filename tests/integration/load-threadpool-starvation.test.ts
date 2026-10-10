import { spawn } from "node:child_process";
import { resolve } from "node:path";
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
      resolveResult({ code, output });
    });
  });
}

describe.skipIf(process.platform !== "linux")("sysload thread-pool starvation", () => {
  it("runs the real activation/sampleOnce/top loop without starving unrelated IO", async () => {
    const result = await runFixture("activation");
    expect(result.code).toBeNull();
    const report = JSON.parse(result.output.trim().split("\n").at(-1) ?? "{}");
    expect(report.verdict).toBe("pass");
    expect(report.active).toBeLessThanOrEqual(2);
    expect(report.lateDiscarded).toBe(true);
    expect(report.elapsedMs).toBeLessThan(200);
  }, 15_000);

  it("does not double-fire a stuck top enumeration", async () => {
    const result = await runFixture("top");
    expect(result.code).toBeNull();
    const report = JSON.parse(result.output.trim().split("\n").at(-1) ?? "{}");
    expect(report.verdict).toBe("pass");
    expect(report.active).toBe(1);
  }, 15_000);
});
