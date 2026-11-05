/**
 * #27 P2 — real-wiring test of the secure preflight hooks (plan r3 §2 P2, acceptance ruling r3-1).
 *
 * A throwaway workspace is generated per run in a mkdtemp dir (a plain-object config — no
 * `vitest/config` import — so nothing needs node_modules resolution from the temp root; vitest
 * aliases the `vitest` import of the case file itself): one trivial case file + the REAL
 * tests/setup/secure-preflight.{global,setup}.ts, run as child `vitest run` processes. This
 * suite never runs the repo's secure project itself and none of the three scenarios takes the
 * real /tmp run lock (incapable and disabled never probe it; the fake replaces probing), so it
 * cannot contend with a parallel #27 P3 secure round.
 *
 *  ① PATH with only sh (no gocryptfs/fusermount3) ⇒ incapable: exit 0, the case passes, no
 *     [secure-preflight] output, every hook of the case ran (byte-identical worker behaviour);
 *  ② PI_TOOLKIT_SECURE_PREFLIGHT=0 ⇒ disabled: exit 0, the case passes, no output, no lock;
 *  ③ PI_TOOLKIT_SECURE_PREFLIGHT_FAKE=<dirty JSON> (tests-only injection): non-zero exit, the
 *     output carries the [secure-preflight] error with the fix commands, the case body and the
 *     nested/file-level beforeAll never ran (markers absent) while the file-level afterAll did
 *     (marker present). Per r3-1 no failed/passed counts are asserted — vitest 2.1.9 marks the
 *     subtests skipped, which is expected.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const VITEST_BIN = join(REPO, "node_modules", "vitest", "vitest.mjs");
const GLOBAL_HOOK = join(REPO, "tests", "setup", "secure-preflight.global.ts");
const WORKER_HOOK = join(REPO, "tests", "setup", "secure-preflight.setup.ts");

const root = mkdtempSync(join(tmpdir(), "p2-secure-preflight-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Scenario ①'s PATH: sh alone — enough for the capability probe's `command -v`, without
// gocryptfs/fusermount3 (which live in /usr/bin together with sh on the dev machine).
const bin = join(root, "bin");
mkdirSync(bin);
symlinkSync(existsSync("/bin/sh") ? "/bin/sh" : "/usr/bin/sh", join(bin, "sh"));

writeFileSync(
  join(root, "vitest.config.mts"),
  [
    "// plain object on purpose: importing vitest/config would need node_modules resolution",
    "// from this temp root (plan r3 §2 P2 keeps the throwaway workspace outside the repo)",
    "export default { test: {",
    '  include: ["case.test.ts"],',
    "  maxWorkers: 1, minWorkers: 1,",
    `  globalSetup: [${JSON.stringify(GLOBAL_HOOK)}],`,
    `  setupFiles: [${JSON.stringify(WORKER_HOOK)}],`,
    "} };",
    "",
  ].join("\n"),
);

const ALL_MARKS = ["afterAll", "body", "fileAll", "nestedAll"] as const;

writeFileSync(
  join(root, "case.test.ts"),
  [
    'import { afterAll, beforeAll, describe, it } from "vitest";',
    'import { writeFileSync } from "node:fs";',
    'const mark = (n: string) => writeFileSync(process.env.CASE_MARK_DIR + "/" + n, "");',
    'beforeAll(() => mark("fileAll"));',
    'afterAll(() => mark("afterAll"));',
    'describe("trivial", () => {',
    '  beforeAll(() => mark("nestedAll"));',
    '  it("body", () => mark("body"));',
    "});",
    "",
  ].join("\n"),
);

interface RunResult {
  status: number | null;
  out: string;
  marks: Set<string>;
}

function runCase(name: string, envOver: Record<string, string>): RunResult {
  const markDir = join(root, "marks-" + name);
  rmSync(markDir, { recursive: true, force: true });
  mkdirSync(markDir);
  const env: NodeJS.ProcessEnv = { ...process.env, CASE_MARK_DIR: markDir };
  delete env.PI_TOOLKIT_SECURE_PREFLIGHT; // the outer run's env must not leak in
  delete env.PI_TOOLKIT_SECURE_PREFLIGHT_FAKE;
  Object.assign(env, envOver);
  const res = spawnSync(process.execPath, [VITEST_BIN, "run", "--config", join(root, "vitest.config.mts")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(res.error, String(res.error)).toBeUndefined();
  const marks = new Set(existsSync(markDir) ? readdirSync(markDir) : []);
  return { status: res.status, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}`, marks };
}

describe("secure preflight hooks — real wiring via a child vitest run (#27 P2)", () => {
  it("① PATH without the FUSE binaries ⇒ incapable: exit 0, case passes, hooks silent", () => {
    const r = runCase("incapable", { PATH: bin });
    expect(r.status).toBe(0);
    expect(r.out).toContain("1 passed");
    expect(r.out).not.toContain("failed");
    expect(r.out).not.toContain("skipped");
    expect(r.out).not.toContain("[secure-preflight]");
    expect([...r.marks].sort()).toEqual([...ALL_MARKS]);
  }, 180_000);

  it("② PI_TOOLKIT_SECURE_PREFLIGHT=0 ⇒ disabled: exit 0, case passes, no lock, no output", () => {
    const r = runCase("disabled", { PI_TOOLKIT_SECURE_PREFLIGHT: "0" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("1 passed");
    expect(r.out).not.toContain("failed");
    expect(r.out).not.toContain("skipped");
    expect(r.out).not.toContain("[secure-preflight]");
    expect(r.marks).toContain("body");
  }, 180_000);

  it("③ injected dirty verdict ⇒ suite fails with the preflight error; bodies/beforeAlls skipped, afterAll runs", () => {
    const r = runCase("fake-dirty", {
      PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: JSON.stringify({
        state: "dirty",
        fuse: true,
        private: true,
        reasons: ["gocryptfs-mounted: /tmp/p2-fake-vault (injected via PI_TOOLKIT_SECURE_PREFLIGHT_FAKE)"],
        notes: [],
      }),
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("[secure-preflight]");
    expect(r.out).toContain("gocryptfs-mounted");
    expect(r.out).toContain("pi-secure lock");
    expect(r.out).toContain("fusermount3 -u");
    expect(r.marks.has("body")).toBe(false);
    expect(r.marks.has("nestedAll")).toBe(false);
    expect(r.marks.has("fileAll")).toBe(false);
    expect(r.marks.has("afterAll")).toBe(true);
  }, 180_000);
});
