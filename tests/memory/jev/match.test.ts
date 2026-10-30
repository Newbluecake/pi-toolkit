// J1 (jev-plan §4 J1 / arch §6.4.2, §6.1.3): command patterns, globs, tool
// matching, lexical prefilter (ASCII + CJK bigrams, user-token tie-break) and
// namedPrograms.

import { describe, expect, it } from "vitest";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import {
  globMatch,
  lexicalScore,
  matchCommandPattern,
  matchTags,
  namedPrograms,
  prefilter,
} from "../../../src/memory/jev/match.js";

const TAX = mergeTaxonomy(undefined);
if (!TAX.ok) throw new Error("preset taxonomy failed to merge");

describe("matchCommandPattern (v4.1 §2.7.1 cmd= lexing)", () => {
  it("git commit matches the §2.7.1 canonical shapes; echo does not", () => {
    expect(matchCommandPattern("git commit", "git commit -m 'fix: hud width'")).toBe(true);
    expect(matchCommandPattern("git commit", "git -C repo commit -m x")).toBe(true);
    expect(matchCommandPattern("git commit", "cd x && git commit")).toBe(true);
    expect(matchCommandPattern("git commit", "FOO=1 git commit")).toBe(true);
    expect(matchCommandPattern("git commit", 'echo "git commit"')).toBe(false);
    expect(matchCommandPattern("git push", "git -C x push")).toBe(true);
  });

  it("glob words and option-like pattern words", () => {
    expect(matchCommandPattern("*release*.sh", "bash scripts/release/release.sh 0.10.3")).toBe(true);
    expect(matchCommandPattern("*release*.sh", "bash scripts/build.sh")).toBe(false);
    expect(matchCommandPattern("find -delete", "find . -name node_modules -delete")).toBe(true);
    expect(matchCommandPattern("find -delete", "find . -name node_modules")).toBe(false);
  });

  it("degrades to substring matching when parsing fails", () => {
    expect(matchCommandPattern("git push", 'echo "unterminated && git push')).toBe(true);
    expect(matchCommandPattern("git push", 'echo "unterminated')).toBe(false);
  });

  it("prefix semantics: extra positionals are fine, wrong first positional is not", () => {
    expect(matchCommandPattern("git push", "git push origin dev")).toBe(true);
    expect(matchCommandPattern("git push", "git pull")).toBe(false);
    expect(matchCommandPattern("gh pr create", "gh pr create --title x")).toBe(true);
  });
});

describe("globMatch", () => {
  it.each([
    ["tests/fixtures/**", "tests/fixtures/memory/jev-off-golden.json", true],
    ["tests/fixtures/**", "tests/fixtures/a/b/c.txt", true],
    ["tests/fixtures/**", "tests/fixture/x", false],
    ["**/settings*.json", "settings.json", true],
    ["**/settings*.json", "a/b/c/settings-dev.json", true],
    ["**/settings*.json", "a/b/c/other.json", false],
    ["**/.env*", ".env", true],
    ["**/.env*", "sub/.env.local", true],
    ["**/*.pem", "auth/server.pem", true],
    ["docs/**", "docs/dev/memory/README.md", true],
    ["docs/**", "src/docs/x.md", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["package.json", "package.json", true],
    ["*release*.sh", "scripts/release/release.sh", false], // `*` stays within one segment
    ["*release*.sh", "audit-release.sh", true],
    ["*release*.sh", "scripts/build.sh", false],
    ["**/pi-toolkit.json", "pi-toolkit.json", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**/b", "a/b", true],
    ["?.md", "a.md", true],
    ["?.md", "ab.md", false],
  ])("%s × %s → %s", (glob, path, want) => {
    expect(globMatch(glob as string, path as string)).toBe(want);
  });
});

describe("matchTags", () => {
  it("bash command hits command matchers (git-commit via git commit)", () => {
    const hit = matchTags({ tool: "bash", input: { command: "git add -A && git commit -m x" } }, TAX.taxonomy);
    expect(hit).toContain("git-commit");
    expect(hit).not.toContain("git-push");
  });

  it("release.sh hits release; echo noise hits nothing high-risk", () => {
    expect(
      matchTags({ tool: "bash", input: { command: "bash scripts/release/release.sh 0.10.3" } }, TAX.taxonomy),
    ).toContain("release");
    expect(matchTags({ tool: "bash", input: { command: 'echo "npm publish"' } }, TAX.taxonomy)).toEqual([]);
  });

  it("tool matchers: dispatch (Agent), background-jobs (bash_job), memory-system (memory)", () => {
    expect(matchTags({ tool: "Agent", input: { prompt: "go" } }, TAX.taxonomy)).toContain("dispatch");
    expect(matchTags({ tool: "Agent", input: { prompt: "go" } }, TAX.taxonomy)).toContain("model-routing");
    expect(matchTags({ tool: "bash_job", input: { action: "status" } }, TAX.taxonomy)).toContain("background-jobs");
    expect(matchTags({ tool: "memory", input: { command: "view" } }, TAX.taxonomy)).toContain("memory-system");
  });

  it("path matchers: frozen-files and dependencies via input paths", () => {
    expect(
      matchTags({ tool: "edit", input: { file: "tests/fixtures/memory/doctor-golden/current-5.json" } }, TAX.taxonomy),
    ).toContain("frozen-files");
    expect(matchTags({ tool: "edit", input: { file: "package.json" } }, TAX.taxonomy)).toContain("dependencies");
  });

  it("deletion matches rm/git rm/trash commands but NOT the memory tool (ruling #3)", () => {
    const tax = TAX.taxonomy;
    expect(matchTags({ tool: "bash", input: { command: "rm -rf build" } }, tax)).toContain("deletion");
    expect(matchTags({ tool: "bash", input: { command: "git rm old.md" } }, tax)).toContain("deletion");
    expect(matchTags({ tool: "bash", input: { command: "trash old.md" } }, tax)).toContain("deletion");
    expect(matchTags({ tool: "bash", input: { command: "git clean -fdx" } }, tax)).toContain("deletion");
    expect(matchTags({ tool: "memory", input: { command: "delete", file: "old.md" } }, tax)).not.toContain("deletion");
    expect(matchTags({ tool: "memory", input: { command: "str_replace", file: "old.md" } }, tax)).not.toContain(
      "deletion",
    );
  });

  it("preset pre-parsed commands are used without re-parsing", () => {
    const hit = matchTags(
      {
        tool: "bash",
        input: { command: "git push" },
        parsed: [{ argv: ["git", "push"], program: "git", positionals: ["push"] }],
      },
      TAX.taxonomy,
    );
    expect(hit).toContain("git-push");
  });

  it("network matcher hits git fetch and curl", () => {
    expect(matchTags({ tool: "bash", input: { command: "git fetch origin" } }, TAX.taxonomy)).toContain("network");
    expect(matchTags({ tool: "bash", input: { command: "curl http://x" } }, TAX.taxonomy)).toContain("network");
  });
});

describe("namedPrograms (§6.4.2)", () => {
  it("release.sh enters, git does not; backtick first-words and suffix words", () => {
    expect(namedPrograms("release.sh 运行期间禁止 commit —— 见 `release.sh --dry-run`")).toEqual(["release.sh"]);
    expect(namedPrograms("先跑 `gh release create`，再跑 scripts/deploy.py 和 build.mjs")).toEqual([
      "deploy.py",
      "build.mjs",
    ]);
    expect(namedPrograms("`git push` 前 export 代理")).toEqual([]);
    expect(namedPrograms("运行 release.sh、audit.ts 两份脚本")).toEqual(["release.sh", "audit.ts"]);
  });
});

describe("lexical prefilter (§6.1.1 >360 case)", () => {
  it("ASCII words and CJK bigrams overlap", () => {
    expect(lexicalScore("release patch", "release notes: default patch")).toBeGreaterThan(0.5);
    expect(lexicalScore("发版", "发版前要确认 CI 绿")).toBeGreaterThan(0);
    expect(lexicalScore("那发版呢", "发版规则：默认 patch")).toBeGreaterThan(0);
    expect(lexicalScore("", "anything")).toBe(0);
    expect(lexicalScore("zzz", "release")).toBe(0);
  });

  it("prefilter ranks by overlap, caps n, tie-breaks user-first", () => {
    const items = [
      { text: "代理设置：GitHub 走代理见 pitfalls-git", user: false },
      { text: "发版规则：默认 patch；feat ≥50 才 minor", user: true },
      { text: "completely unrelated tooling notes", user: false },
    ];
    const top = prefilter(
      items,
      (i) => i.text,
      "发版 默认 patch",
      2,
      (a, b) => (a.user === b.user ? 0 : a.user ? -1 : 1),
    );
    expect(top).toHaveLength(2);
    expect(top[0]!.text).toContain("发版规则");
    // Equal scores order user tokens first.
    const pair = [
      { text: "alpha beta", user: false },
      { text: "alpha beta", user: true },
    ];
    expect(
      prefilter(
        pair,
        (i) => i.text,
        "alpha",
        2,
        (a, b) => (a.user === b.user ? 0 : a.user ? -1 : 1),
      )[0]!.user,
    ).toBe(true);
    expect(prefilter(pair, (i) => i.text, "alpha", 1)).toHaveLength(1);
  });
});
