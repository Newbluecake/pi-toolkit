import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const runBounded = (args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`print-mode child timed out\n${stdout}\n${stderr}`));
    }, 10_000);
    timer.unref();
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

describe("sysload print mode", () => {
  it("does not leave a sampling timer keeping the process alive", async () => {
    const result = await runBounded([
      'import { parseLoadSettings } from "./src/config/settings.ts"; import { createLoadActivation } from "./src/sysload/activation.ts"; const a=createLoadActivation({settings:parseLoadSettings({})}); a.start({mode:"print"}); console.log("exited");',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("exited");
  }, 15_000);
});
