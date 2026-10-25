/**
 * Real-child-process regression for `waitLeaseReleased` (convert.mjs): the back-off sleep must be REF'd.
 * In-process tests cannot see this — vitest itself keeps the loop alive — but in the CLI an unref'd
 * back-off is the only live handle, so the process silently exits (code 0, no output) on the first retry.
 * The child has no other handle (stdin ignored), exactly like the real rollback tail.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CONVERT = pathToFileURL(resolve(__dirname, "../../src/secure/bin/convert.mjs")).href;
const dir = mkdtempSync(join(tmpdir(), "lease-wait-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runChild(script: string) {
  const file = join(dir, `c-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, `import { waitLeaseReleased } from ${JSON.stringify(CONVERT)};\n${script}\n`);
  const r = spawnSync(process.execPath, [file], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("waitLeaseReleased in a real child process (ref'd back-off)", () => {
  it("first probe held, then free ⇒ the child waits, re-probes and reports free (exit 0, output present)", () => {
    const r = runChild(`
let n = 0;
const res = await waitLeaseReleased(async () => (++n <= 2 ? "held" : "free"), {}, { budgetMs: 500, stepMs: 20 });
console.log(JSON.stringify({ res, n }));
`);
    expect(r.err).toBe("");
    expect(r.out).toBe(JSON.stringify({ res: "free", n: 3 }));
    expect(r.code).toBe(0);
  });

  it("held throughout ⇒ the child waits out the cap and reports held with the exact probe count (fail-safe path reachable)", () => {
    const r = runChild(`
let n = 0;
const res = await waitLeaseReleased(async () => (n++, "held"), {}, { budgetMs: 100, stepMs: 20 });
console.log(JSON.stringify({ res, n }));
process.exitCode = res === "held" ? 74 : 0;
`);
    expect(r.err).toBe("");
    expect(r.out).toBe(JSON.stringify({ res: "held", n: 6 }));
    expect(r.code).toBe(74);
  });
});
