/**
 * D — the post-release hub restart step of scripts/release/release.sh.
 *
 * Two layers: `hub-restart-step.sh` driven directly with stub runners (its contract: ALWAYS exit 0,
 * every failure mode is a WARN), and the real release.sh driven through its WHOLE flow in a
 * disposable repo — a local bare repo stands in for origin, `gh` and package.sh are stubs, and the
 * restart runner is a stub that leaves a marker file. Nothing here touches this repo's git state,
 * a real remote, GitHub, or a real hub (the real restart-hub.ts is covered by restart-hub.test.ts
 * and tests/integration/web-hub-restart-script.test.ts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REAL_ROOT = process.cwd();
const RELEASE_SCRIPT = join(REAL_ROOT, "scripts/release/release.sh");
const STEP_SCRIPT = join(REAL_ROOT, "scripts/release/hub-restart-step.sh");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function stub(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// hub-restart-step.sh in isolation
// ---------------------------------------------------------------------------

function runStep(env: Record<string, string>): { code: number; out: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync("bash", [STEP_SCRIPT], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
}

describe("hub-restart-step.sh — best-effort contract (always exit 0)", () => {
  it("runner succeeds ⇒ exit 0, no WARN, the runner got the restart-hub.ts path", () => {
    const d = mk("pwh-step-");
    const marker = join(d, "argv");
    const tsx = stub(d, "tsx", `echo "$@" > "${marker}"; echo "[OK] hub-restart: fake"`);
    const r = runStep({ PI_TOOLKIT_TSX: tsx });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[WARN]");
    expect(readFileSync(marker, "utf8")).toContain("scripts/release/restart-hub.ts");
  });

  it("runner fails (exit 3) ⇒ still exit 0, with a WARN pointing at /webhub restart", () => {
    const d = mk("pwh-step-");
    const r = runStep({ PI_TOOLKIT_TSX: stub(d, "tsx", "exit 3") });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[WARN\] hub restart did not complete \(exit 3\).*\/webhub restart/);
  });

  it("runner hangs ⇒ killed by `timeout`, WARN says timed out, exit 0, and it was fast", () => {
    const d = mk("pwh-step-");
    const r = runStep({ PI_TOOLKIT_TSX: stub(d, "tsx", "sleep 30"), PI_TOOLKIT_HUB_RESTART_TIMEOUT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("timed out after 1s");
    expect(r.ms).toBeLessThan(15_000);
  });

  it("runner that ignores SIGTERM is still reaped (timeout -k) ⇒ exit 0", () => {
    const d = mk("pwh-step-");
    const r = runStep({
      PI_TOOLKIT_TSX: stub(d, "tsx", `trap '' TERM; while true; do sleep 1; done`),
      PI_TOOLKIT_HUB_RESTART_TIMEOUT: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/timed out after 1s/);
    expect(r.ms).toBeLessThan(20_000);
  });

  it("missing runner ⇒ WARN + exit 0 (a fresh checkout without npm install)", () => {
    const r = runStep({ PI_TOOLKIT_TSX: "/nonexistent/tsx" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("[WARN] hub restart skipped: tsx not found");
  });

  it("garbage timeout falls back to the default instead of breaking `timeout`", () => {
    const d = mk("pwh-step-");
    const r = runStep({ PI_TOOLKIT_TSX: stub(d, "tsx", "exit 0"), PI_TOOLKIT_HUB_RESTART_TIMEOUT: "abc" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[WARN]");
  });
});

// ---------------------------------------------------------------------------
// release.sh full flow (stubs for gh / package.sh / the restart runner)
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  bin: string;
  marker: string;
}

function makeFlowFixture(runnerBody: string): Fixture {
  const dir = mk("pwh-relflow-");
  const origin = mk("pwh-relorigin-");
  git(origin, "init", "-q", "--bare", "-b", "master");
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fx", version: "0.1.0" }, null, 2)}\n`);
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify({ name: "fx", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "fx", version: "0.1.0" } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- Initial release\n\n[Unreleased]: https://github.com/acme/fx/compare/v0.1.0...HEAD\n[0.1.0]: https://github.com/acme/fx/releases/tag/v0.1.0\n",
  );
  mkdirSync(join(dir, "scripts/release"), { recursive: true });
  writeFileSync(join(dir, "scripts/release/release.sh"), readFileSync(RELEASE_SCRIPT, "utf8"));
  writeFileSync(join(dir, "scripts/release/hub-restart-step.sh"), readFileSync(STEP_SCRIPT, "utf8"));
  chmodSync(join(dir, "scripts/release/release.sh"), 0o755);
  chmodSync(join(dir, "scripts/release/hub-restart-step.sh"), 0o755);
  // package.sh stub: only produces the files `gh release create` is handed.
  stub(
    join(dir, "scripts/release"),
    "package.sh",
    `mkdir -p release; v="$1"; for f in pi-toolkit-$v.zip pi-toolkit-$v.zip.sha256 pi-toolkit-web-ui-$v.zip pi-toolkit-web-ui-$v.zip.sha256 CHANGELOG-$v.md; do echo x > "release/$f"; done`,
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed fixture");
  git(dir, "tag", "-a", "v0.1.0", "-m", "Release v0.1.0");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fix(core): a fix to release");
  git(dir, "remote", "add", "origin", origin); // local bare repo ⇒ real push, no network
  git(dir, "push", "-q", "origin", "master");
  git(dir, "fetch", "-q", "origin");

  const bin = mk("pwh-relbin-");
  stub(bin, "gh", `echo "gh $*" >> "${join(bin, "gh.log")}"; exit 0`);
  const marker = join(bin, "runner-ran");
  stub(bin, "tsx", `echo ran > "${marker}"; ${runnerBody}`);
  return { dir, bin, marker };
}

function runRelease(fx: Fixture, args: string[]): { code: number; out: string } {
  const r = spawnSync("bash", [join(fx.dir, "scripts/release/release.sh"), "0.1.1", "--skip-tests", ...args], {
    cwd: fx.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env["PATH"]}`,
      PI_TOOLKIT_TSX: join(fx.bin, "tsx"),
      PI_TOOLKIT_HUB_RESTART_TIMEOUT: "5",
    },
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe("release.sh × hub restart step (full flow, stubs)", () => {
  it("default: runs the restart step AFTER gh release create, and the release succeeds", () => {
    const fx = makeFlowFixture(`echo "[OK] hub-restart: stub"`);
    const r = runRelease(fx, []);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(fx.marker)).toBe(true);
    expect(git(fx.dir, "tag")).toContain("v0.1.1");
    const released = r.out.indexOf("Released v0.1.1");
    const restarted = r.out.indexOf("restarting the local web-hub");
    expect(released).toBeGreaterThan(-1);
    expect(restarted).toBeGreaterThan(released); // strictly after the publish
    expect(readFileSync(join(fx.bin, "gh.log"), "utf8")).toContain("release create v0.1.1");
  });

  it("--skip-hub-restart: the runner is never invoked; INFO says so; release still succeeds", () => {
    const fx = makeFlowFixture(`echo "[OK] hub-restart: stub"`);
    const r = runRelease(fx, ["--skip-hub-restart"]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(fx.marker)).toBe(false);
    expect(r.out).toContain("Skipping local web-hub restart (--skip-hub-restart)");
    expect(git(fx.dir, "tag")).toContain("v0.1.1");
  });

  it("a FAILING runner is only a WARN: exit 0, tag + gh release intact", () => {
    const fx = makeFlowFixture("exit 7");
    const r = runRelease(fx, []);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(fx.marker)).toBe(true);
    expect(r.out).toMatch(/\[WARN\].*hub restart did not complete \(exit 7\)/);
    expect(r.out).toContain("Released v0.1.1");
  });

  it("a HANGING runner is bounded by the timeout and still only a WARN", () => {
    const fx = makeFlowFixture("sleep 60");
    const t0 = Date.now();
    const r = runRelease(fx, []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("timed out after 5s");
    expect(Date.now() - t0).toBeLessThan(60_000);
  });

  it("--skip-push / --skip-publish never reach the step (nothing was published)", () => {
    for (const flag of ["--skip-push", "--skip-publish"]) {
      const fx = makeFlowFixture(`echo "[OK] hub-restart: stub"`);
      const r = runRelease(fx, [flag]);
      expect(r.code, r.out).toBe(0);
      expect(existsSync(fx.marker), flag).toBe(false);
    }
  });

  it("the flag is accepted on --dry-run and unknown flags are still rejected", () => {
    const fx = makeFlowFixture("exit 0");
    const ok = runRelease(fx, ["--dry-run", "--skip-hub-restart"]);
    expect(ok.code, ok.out).toBe(0);
    const bad = runRelease(fx, ["--skip-hub-restar"]);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("Unknown argument");
  });
});
