import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// release-script.test.ts exercises scripts/release/release.sh against a disposable,
// fully isolated git repo fixture. It NEVER touches this real repo's git state, tags
// or remote: every repo under test lives under a mkdtemp() directory, has no
// `origin` remote configured (so the "up to date with origin/<branch>" check warns
// and continues instead of hitting the network), and every test uses --dry-run or
// --changelog / --skip-push so no `git push` or `gh` call is ever reached — there is
// nothing to stub.

const REAL_ROOT = process.cwd();
const RELEASE_SCRIPT = join(REAL_ROOT, "scripts/release/release.sh");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commitEmpty(cwd: string, subject: string, body?: string): void {
  const args = ["commit", "--allow-empty", "-m", subject];
  if (body) args.push("-m", body);
  git(cwd, ...args);
}

/** Builds a minimal, isolated repo fixture pre-seeded with a v0.1.0 tag. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-toolkit-release-test-"));
  tmpDirs.push(dir);

  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Release Test");
  // No `origin` remote on purpose: the up-to-date and GH-slug-derived compare-link
  // steps must degrade gracefully (WARN, not abort / not write bogus links).

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-pkg", version: "0.1.0" }, null, 2) + "\n");
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify(
      {
        name: "fixture-pkg",
        version: "0.1.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "fixture-pkg", version: "0.1.0", license: "MIT" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "All notable changes to this project will be documented in this file.",
      "",
      "## [Unreleased]",
      "",
      "## [0.1.0] - 2026-01-01",
      "",
      "### Added",
      "",
      "- Initial release",
      "",
      "[Unreleased]: https://github.com/acme/fixture-pkg/compare/v0.1.0...HEAD",
      "[0.1.0]: https://github.com/acme/fixture-pkg/releases/tag/v0.1.0",
      "",
    ].join("\n"),
  );
  git(dir, "add", "package.json", "package-lock.json", "CHANGELOG.md");
  git(dir, "commit", "-q", "-m", "chore: seed fixture");
  git(dir, "tag", "-a", "v0.1.0", "-m", "Release v0.1.0");

  mkdirSync(join(dir, "scripts/release"), { recursive: true });
  const script = readFileSync(RELEASE_SCRIPT, "utf8");
  writeFileSync(join(dir, "scripts/release/release.sh"), script);
  chmodSync(join(dir, "scripts/release/release.sh"), 0o755);
  // Keep the fixture's working tree clean: the copied script itself must be
  // tracked, otherwise every test would trip the script's own dirty-tree guard.
  git(dir, "add", "scripts/release/release.sh");
  git(dir, "commit", "-q", "-m", "chore: add release script fixture");

  // A fake-but-well-formed origin remote: config only, never fetched (no test
  // ever reaches real network — `origin/master` is never created locally, so
  // the up-to-date check WARNs and continues instead of fetching), but its URL
  // lets the compare-link generation resolve a github.com slug like a real repo.
  git(dir, "remote", "add", "origin", "https://github.com/acme/fixture-pkg.git");

  return dir;
}

function writeChangelog(dir: string, content: string): void {
  writeFileSync(join(dir, "CHANGELOG.md"), content);
  git(dir, "add", "CHANGELOG.md");
  git(dir, "commit", "-q", "-m", "chore: rewrite fixture CHANGELOG for this test");
}

function run(dir: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("bash", [join(dir, "scripts/release/release.sh"), ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = String(err.stdout ?? "") + String(err.stderr ?? "");
    return { stdout, status: err.status ?? 1 };
  }
}

describe("scripts/release/release.sh", () => {
  it("does not mutate the real pi-toolkit repo", () => {
    // Sanity guard for the whole suite: if this ever fails, every other test's
    // "isolated fixture" assumption is void. Compares git status/tags around a
    // --dry-run invocation against THIS repo (read-only by design).
    const before = git(REAL_ROOT, "status", "--porcelain");
    const beforeTags = git(REAL_ROOT, "tag");
    run(REAL_ROOT, ["9.9.9", "--dry-run", "--skip-tests"]);
    const after = git(REAL_ROOT, "status", "--porcelain");
    const afterTags = git(REAL_ROOT, "tag");
    expect(after).toBe(before);
    expect(afterTags).toBe(beforeTags);
  });

  it("suggests patch by default (fix/chore-dominated history)", () => {
    const dir = makeFixture();
    commitEmpty(dir, "fix(core): handle empty input");
    commitEmpty(dir, "chore: tidy lint config");
    const { stdout, status } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/suggested bump: patch -> v0\.1\.1/);
    expect(stdout).not.toMatch(/WARN.*is a .* bump, suggested is/);
  });

  it("suggests minor once feat commits reach 50 since the last vX.Y.0 tag", () => {
    const dir = makeFixture();
    for (let i = 0; i < 50; i++) {
      commitEmpty(dir, `feat(widgets): add widget number ${i}`);
    }
    const { stdout, status } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/suggested bump: minor -> v0\.2\.0/);
    expect(stdout).toMatch(/50 feat commits accumulated/);
    // 0.1.1 is a patch bump but minor was suggested -> mismatch WARN
    expect(stdout).toMatch(/Given version v0\.1\.1 is a patch bump, suggested is minor/);
  });

  it("does not reset the feat count across intermediate patch tags", () => {
    const dir = makeFixture();
    for (let i = 0; i < 30; i++) commitEmpty(dir, `feat(a): feature ${i}`);
    git(dir, "tag", "-a", "v0.1.1", "-m", "Release v0.1.1"); // patch tag, NOT vX.Y.0
    for (let i = 0; i < 25; i++) commitEmpty(dir, `feat(b): feature ${i}`);
    const { stdout, status } = run(dir, ["0.1.2", "--dry-run", "--skip-tests"]);
    expect(status).toBe(0);
    // base stays v0.1.0 (the latest vX.Y.0), so the count is 30 + 25 = 55, not just 25
    expect(stdout).toMatch(/55 feat commits accumulated.*range v0\.1\.0\.\.HEAD/);
    expect(stdout).toMatch(/suggested bump: minor/);
  });

  it("suggests major on a BREAKING CHANGE (subject bang or body footer)", () => {
    const dir = makeFixture();
    commitEmpty(dir, "feat(api)!: drop the legacy endpoint");
    const { stdout, status } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/suggested bump: major -> v1\.0\.0/);
    expect(stdout).toMatch(/BREAKING CHANGE detected/);
    expect(stdout).toMatch(/Given version v0\.1\.1 is a patch bump, suggested is major/);
  });

  it("suggests major from a BREAKING CHANGE: body footer with a plain subject", () => {
    const dir = makeFixture();
    commitEmpty(dir, "fix(api): change default timeout", "BREAKING CHANGE: timeout unit changed to ms");
    const { stdout } = run(dir, ["1.0.0", "--dry-run", "--skip-tests"]);
    expect(stdout).toMatch(/suggested bump: major -> v1\.0\.0/);
  });

  it("--changelog groups commits by conventional-commit type, skips chore(release), and syncs versions", () => {
    const dir = makeFixture();
    commitEmpty(dir, "feat(widgets): add a widget");
    commitEmpty(dir, "fix(widgets): fix widget overflow");
    commitEmpty(dir, "docs: update README");
    commitEmpty(dir, "test(widgets): add widget tests");
    commitEmpty(dir, "chore(release): bump version to v0.1.0"); // must never resurface
    const { status } = run(dir, ["0.1.1", "--changelog"]);
    expect(status).toBe(0);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.version).toBe("0.1.1");
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("0.1.1");
    expect(lock.packages[""].version).toBe("0.1.1");

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}/);
    expect(changelog).toMatch(/### Added\n\n- \*\*widgets\*\*: add a widget/);
    expect(changelog).toMatch(/### Fixed\n\n- \*\*widgets\*\*: fix widget overflow/);
    expect(changelog).toMatch(/### Documentation\n\n- update README/);
    expect(changelog).toMatch(/### Tests\n\n- \*\*widgets\*\*: add widget tests/);
    expect(changelog).not.toMatch(/bump version to v0\.1\.0/);
    expect(changelog).toMatch(/Stats: 1 feat, 1 fix, 1 docs, 1 test/);
  });

  it("merges hand-written [Unreleased] content to the top of each matching section and empties Unreleased", () => {
    const dir = makeFixture();
    writeChangelog(
      dir,
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- **hand-written**: a feature nobody committed as a conventional commit",
        "",
        "## [0.1.0] - 2026-01-01",
        "",
        "### Added",
        "",
        "- Initial release",
        "",
        "[Unreleased]: https://github.com/acme/fixture-pkg/compare/v0.1.0...HEAD",
        "[0.1.0]: https://github.com/acme/fixture-pkg/releases/tag/v0.1.0",
        "",
      ].join("\n"),
    );
    commitEmpty(dir, "feat(widgets): add a generated widget");

    const { status } = run(dir, ["0.1.1", "--changelog"]);
    expect(status).toBe(0);

    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    const newSectionMatch = changelog.match(/## \[0\.1\.1\][\s\S]*?(?=\n## \[)/);
    expect(newSectionMatch).not.toBeNull();
    const newSection = newSectionMatch![0];

    // hand-written bullet is merged in and appears BEFORE the generated one.
    const handIdx = newSection.indexOf("hand-written");
    const genIdx = newSection.indexOf("add a generated widget");
    expect(handIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(-1);
    expect(handIdx).toBeLessThan(genIdx);

    // [Unreleased] is left empty (no more "hand-written" bullet up there).
    const unreleasedMatch = changelog.match(/## \[Unreleased\]([\s\S]*?)(?=\n## \[)/);
    expect(unreleasedMatch).not.toBeNull();
    expect(unreleasedMatch![1]).not.toMatch(/hand-written/);
  });

  it("updates the [Unreleased] compare link and adds the new version's link ref", () => {
    const dir = makeFixture();
    commitEmpty(dir, "fix(core): small fix");
    const { status } = run(dir, ["0.1.1", "--changelog"]);
    expect(status).toBe(0);
    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/\[Unreleased\]: https:\/\/github\.com\/acme\/fixture-pkg\/compare\/v0\.1\.1\.\.\.HEAD/);
    expect(changelog).toMatch(/\[0\.1\.1\]: https:\/\/github\.com\/acme\/fixture-pkg\/compare\/v0\.1\.0\.\.\.v0\.1\.1/);
  });

  it("--dry-run writes no files and leaves the fixture repo untouched", () => {
    const dir = makeFixture();
    commitEmpty(dir, "feat(widgets): add a widget");
    const before = git(dir, "status", "--porcelain");
    const beforeTags = git(dir, "tag");
    const pkgBefore = readFileSync(join(dir, "package.json"), "utf8");
    const changelogBefore = readFileSync(join(dir, "CHANGELOG.md"), "utf8");

    const { status } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
    expect(status).toBe(0);

    expect(git(dir, "status", "--porcelain")).toBe(before);
    expect(git(dir, "tag")).toBe(beforeTags);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(pkgBefore);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(changelogBefore);
  });

  it("aborts without creating a tag when the working tree is dirty (non-dry-run)", () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "untracked.txt"), "dirty");
    const { status, stdout } = run(dir, ["0.1.1", "--skip-tests"]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/dirty/i);
    expect(git(dir, "tag")).not.toMatch(/v0\.1\.1/);
  });

  it("aborts when the target tag already exists", () => {
    const dir = makeFixture();
    git(dir, "tag", "-a", "v0.1.1", "-m", "already released");
    const { status, stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/already exists/);
  });

  it("aborts a patch on a feature branch", () => {
    const dir = makeFixture();
    git(dir, "checkout", "-q", "-b", "feature/x");
    const { status, stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/Must release a patch from 'dev'/);
  });

  it("aborts a minor on a feature branch", () => {
    const dir = makeFixture();
    git(dir, "checkout", "-q", "-b", "feature/x");
    const { status, stdout } = run(dir, ["0.2.0", "--dry-run", "--skip-tests"]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/Must release a minor from 'master'/);
  });

  describe("dev/master branch rules", () => {
    it("allows a patch on dev", () => {
      const dir = makeFixture();
      git(dir, "checkout", "-q", "-b", "dev");
      const { status, stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/Patch release on dev/);
      expect(stdout).not.toMatch(/transitional/);
    });

    it("rejects a patch on master once dev exists", () => {
      const dir = makeFixture();
      git(dir, "branch", "dev");
      const { status, stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
      expect(status).not.toBe(0);
      expect(stdout).toMatch(/Patch releases must be cut on 'dev'/);
    });

    it("rejects a patch on master when only origin/dev exists", () => {
      const dir = makeFixture();
      git(dir, "update-ref", "refs/remotes/origin/dev", "HEAD");
      const { status, stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
      expect(status).not.toBe(0);
      expect(stdout).toMatch(/Patch releases must be cut on 'dev'/);
    });

    it("allows a patch on master with a transition WARN when no dev exists", () => {
      const dir = makeFixture();
      const { status, stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/dev branch not created yet — transitional release from master/);
      expect(stdout).toMatch(/git switch -c dev && git push -u origin dev/);
    });

    it.each(["0.2.0", "1.0.0"])("rejects minor/major %s on dev", (version) => {
      const dir = makeFixture();
      git(dir, "checkout", "-q", "-b", "dev");
      const { status, stdout } = run(dir, [version, "--dry-run", "--skip-tests"]);
      expect(status).not.toBe(0);
      expect(stdout).toMatch(/Must not release a (minor|major) on 'dev'/);
    });

    it.each([
      ["0.2.0", "minor"],
      ["1.0.0", "major"],
    ])("allows %s (%s) on master even when dev exists", (version, kind) => {
      const dir = makeFixture();
      git(dir, "branch", "dev");
      const { status, stdout } = run(dir, [version, "--dry-run", "--skip-tests"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(new RegExp(`${kind} release on master`));
    });

    it("patch on dev: tag lands on dev's ancestor chain and master is untouched", () => {
      const dir = makeFixture();
      git(dir, "checkout", "-q", "-b", "dev");
      commitEmpty(dir, "fix(widgets): fix widget overflow");
      const masterBefore = git(dir, "rev-parse", "master").trim();
      const { status, stdout } = run(dir, ["0.1.1", "--skip-tests", "--skip-push"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/Verified v0\.1\.1 is an ancestor of dev/);
      expect(() => git(dir, "merge-base", "--is-ancestor", "v0.1.1", "dev")).not.toThrow();
      expect(() => git(dir, "merge-base", "--is-ancestor", "v0.1.1", "master")).toThrow();
      expect(git(dir, "rev-parse", "master").trim()).toBe(masterBefore);
      expect(stdout).toMatch(/git push origin dev && git push origin v0\.1\.1/);
    });

    it("minor on master: ancestor check names master", () => {
      const dir = makeFixture();
      git(dir, "branch", "dev");
      const { status, stdout } = run(dir, ["0.2.0", "--skip-tests", "--skip-push"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/Verified v0\.2\.0 is an ancestor of master/);
      expect(() => git(dir, "merge-base", "--is-ancestor", "v0.2.0", "master")).not.toThrow();
    });

    it("up-to-date check targets origin/<release branch>", () => {
      const dir = makeFixture();
      git(dir, "checkout", "-q", "-b", "dev");
      const { stdout } = run(dir, ["0.1.1", "--dry-run", "--skip-tests"]);
      expect(stdout).toMatch(/No origin\/dev remote-tracking ref found/);
    });
  });

  it("full flow with --skip-tests --skip-push commits and tags locally, never touching a remote", () => {
    const dir = makeFixture();
    commitEmpty(dir, "feat(widgets): add a widget");
    commitEmpty(dir, "fix(widgets): fix widget overflow");

    const { status, stdout } = run(dir, ["0.1.1", "--skip-tests", "--skip-push"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Skipped push \(--skip-push\)/);

    // Commit + tag were created locally.
    const log = git(dir, "log", "-1", "--format=%s").trim();
    expect(log).toBe("chore(release): bump version to v0.1.1");
    const tags = git(dir, "tag");
    expect(tags).toMatch(/v0\.1\.1/);
    const tagAnnotation = git(dir, "tag", "-l", "--format=%(contents)", "v0.1.1");
    expect(tagAnnotation).toMatch(/Release v0\.1\.1/);
    expect(tagAnnotation).toMatch(/add a widget/);

    // The commit touched exactly the three version/changelog files, nothing else
    // (never `git add -A`).
    const changedFiles = git(dir, "show", "--stat", "--format=", "HEAD").trim().split("\n");
    const fileNames = changedFiles
      .filter((l) => l.includes("|"))
      .map((l) => l.split("|")[0]?.trim())
      .filter((f): f is string => !!f);
    expect(fileNames.sort()).toEqual(["CHANGELOG.md", "package-lock.json", "package.json"]);

    // Tag is (trivially) an ancestor of master since it was cut from HEAD.
    expect(() => git(dir, "merge-base", "--is-ancestor", "v0.1.1", "master")).not.toThrow();
  });
});
