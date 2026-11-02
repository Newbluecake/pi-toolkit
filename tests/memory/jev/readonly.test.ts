// jev gate coarse filter step 2b — the purely read-only command whitelist
// (`src/memory/jev/readonly.ts`): every parsed segment read-only (command
// substitutions included), parse ok, no redirect ⇒ exempt. Anything else —
// write segments, redirects, failed parses, unknown programs — is NOT
// exempt (conservative fallback to the normal gate path). Wire-level
// behavior (zero await, no classifier) is covered in wire-gate.test.ts.

import { describe, expect, test } from "vitest";
import { isPureReadonlyShell } from "../../../src/memory/jev/readonly.js";
import { parseShell } from "../../../src/memory/jev/shell-parse.js";

const exempt = (cmd: string): boolean => isPureReadonlyShell(parseShell(cmd));

describe("isPureReadonlyShell — exempt shapes", () => {
  test("the interception screenshot: read-only git chain with cd", () => {
    expect(exempt("cd x && git status --short; git stash list; git log --oneline -1; git reflog -3")).toBe(true);
  });

  test("git read-only subcommands (any flags, any ref/path args)", () => {
    for (const cmd of [
      "git",
      "git --version",
      "git version",
      "git status",
      "git status --short --branch",
      "git log --oneline -5",
      "git log --all --graph --decorate",
      "git reflog",
      "git reflog -3",
      "git reflog show",
      "git reflog show --all",
      "git reflog exists refs/heads/main",
      "git diff",
      "git diff --stat HEAD~1..HEAD",
      "git show HEAD:package.json",
      "git blame -L 5,10 src/a.ts",
      "git describe --tags",
      "git shortlog -sn",
      "git rev-parse --abbrev-ref HEAD",
      "git ls-files",
      "git branch",
      "git branch -a",
      "git branch --list",
      "git tag",
      "git tag -l",
      "git tag -l 'v*'",
      "git remote",
      "git remote -v",
      "git config -l",
      "git config --list",
      "git config --get user.name",
      "git stash list",
      "git worktree list",
    ]) {
      expect(exempt(cmd), cmd).toBe(true);
    }
  });

  test("git global options are stripped before the whitelist (cwd tracking irrelevant)", () => {
    for (const cmd of [
      "git -C /tmp/x status",
      "git -c core.pager=cat log -1",
      "git --no-pager log -1",
      "git --git-dir=/x/.git status",
      "git --work-tree /x -C /x diff",
    ]) {
      expect(exempt(cmd), cmd).toBe(true);
    }
  });

  test("generic read-only programs, pipes, assignments, wrappers, subshells", () => {
    for (const cmd of [
      "ls -la /tmp",
      "pwd",
      "cat package.json",
      "head -5 x.log",
      "tail -f x.log",
      "grep -rn foo src/",
      "rg -g '*.ts' foo",
      "find . -name '*.ts'",
      "ps aux",
      "which node",
      "whoami",
      "hostname",
      "hostname -f",
      "date",
      "date -u",
      "wc -l x",
      "stat x",
      "du -sh .",
      "df -h",
      "file x",
      "readlink f",
      "realpath f",
      "basename a/b",
      "dirname a/b",
      "uname -a",
      "uptime",
      "free -m",
      "echo hi",
      "echo -n hi",
      "true",
      "false",
      "test -f x",
      "cat a | grep b | head -5",
      "FOO=1 git status",
      "sudo git status",
      "timeout 30 git status",
      "env git status",
      "(git status)",
      "cd /x && git log -1 && pwd",
      "/usr/bin/git status",
    ]) {
      expect(exempt(cmd), cmd).toBe(true);
    }
  });

  test("command substitution: inner segments judged too (shared sink)", () => {
    expect(exempt("echo $(git status)")).toBe(true);
    expect(exempt("cat $(git rev-parse --show-toplevel)/package.json")).toBe(true);
  });

  test("substitution residue inside quotes never becomes a segment ⇒ conservative reject", () => {
    // the tokenizer does not recurse into double quotes: the substitution
    // executes for real in a shell but is invisible to the segment list.
    expect(exempt('git status "$(git commit -m x)"')).toBe(false); // double-quoted $()
    expect(exempt('git status "`git commit -m x`"')).toBe(false); // double-quoted backticks
    expect(exempt('git status "$(rm -rf x)"')).toBe(false);
    // read-only inner is still invisible — rejected all the same
    expect(exempt('echo "$(git status)"')).toBe(false);
    expect(exempt('echo "`git log -1`"')).toBe(false);
    // single-quoted `$()` is bash-literal (safe), rejected conservatively
    expect(exempt("git status '$(git commit -m x)'")).toBe(false);
    expect(exempt('git log --grep "$(git tag -l v*)" -1')).toBe(false);
  });
});

describe("isPureReadonlyShell — NOT exempt (conservative)", () => {
  test("git write subcommands", () => {
    for (const cmd of [
      "git add .",
      "git commit -m x",
      "git push",
      "git reset --hard",
      "git checkout x",
      "git switch x",
      "git merge x",
      "git rebase x",
      "git cherry-pick x",
      "git clean -fd",
      "git rm x",
      "git fetch",
      "git pull",
      "git clone https://x",
      "git stash",
      "git stash push",
      "git stash pop",
      "git worktree add ../x",
      "git branch -D x",
      "git branch -m a b",
      "git branch new-branch",
      "git tag v1.0.0",
      "git tag -a v1",
      "git remote add o https://x",
      "git config user.name x",
      "git config --unset user.name",
      "git reflog expire --all",
      "git reflog delete HEAD@{1}",
      "git reflog --expire=now --all",
      "git reflog --expire-unreachable=90.days",
      "git update-index --refresh",
    ]) {
      expect(exempt(cmd), cmd).toBe(false);
    }
  });

  test("write programs and mixed chains", () => {
    for (const cmd of [
      "rm -rf build",
      "mkdir x",
      "touch x",
      "cp a b",
      "mv a b",
      "sed -i s/a/b/ f",
      "chmod +x f",
      "npm test",
      "node x.js",
      "bash x.sh",
      "git status && rm -rf x",
      "git status && git commit -m x",
      "git status && npm run build",
      "sudo rm -rf x",
      "timeout 30 git fetch",
      "echo $(git commit -m x)",
      "bash -c 'git status'", // outer interpreter is not whitelisted (conservative)
    ]) {
      expect(exempt(cmd), cmd).toBe(false);
    }
  });

  test("write forms of otherwise read-only programs", () => {
    for (const cmd of [
      "find . -name x -delete",
      "find . -name x -exec rm {} ;",
      "find . -name x -execdir rm {} ;",
      "find . -fprintf /tmp/o %p",
      "date -s 2020-01-01",
      "date --set=2020-01-01",
      "date 0102030405", // bare operand sets the clock
      "date -u 0102030405.06",
      "hostname foo.example.com",
      "hostname -F /etc/hostname",
      "hostname --file /etc/hostname",
      "hostname --file=/etc/hostname",
    ]) {
      expect(exempt(cmd), cmd).toBe(false);
    }
    // `+FORMAT` operands stay display-only
    expect(exempt("date +%Y-%m-%d")).toBe(true);
    expect(exempt("date -u +%s")).toBe(true);
    expect(exempt("hostname -f")).toBe(true);
  });

  test("redirects anywhere in the chain kill the exemption (argv alone is not the whole story)", () => {
    for (const cmd of [
      "git status > /tmp/x",
      "git status >> /tmp/x",
      "git log -1 >out.txt",
      "git diff < patch.txt",
      "cat x 2>&1 | grep y",
      "echo hi > /tmp/x",
      "echo $(git status > /tmp/inner)",
      "tee /tmp/x < /dev/null",
    ]) {
      expect(parseShell(cmd).hasRedirect, cmd).toBe(true);
      expect(exempt(cmd), cmd).toBe(false);
    }
  });

  test("parse failure (ok=false) or empty command list ⇒ not exempt", () => {
    expect(parseShell("git status '").ok).toBe(false); // unterminated quote
    expect(exempt("git status '")).toBe(false);
    expect(parseShell('echo "unclosed').ok).toBe(false);
    expect(exempt('echo "unclosed')).toBe(false);
    expect(exempt("   ")).toBe(false); // no commands at all
    expect(exempt("FOO=1")).toBe(false); // assignment only ⇒ no command segment
  });
});
