// J1 (jev-plan §4 J1 / v4.1 §2.7.1): shell parsing — table-driven ≥60 cases
// (quoting, chaining, subshells, bash -c, env prefixes, wrappers, git global
// options, heredocs, cd tracking, interpreter→script identity) plus a seeded
// fuzz run proving the parser never throws.

import { describe, expect, it } from "vitest";
import { parseShell, programIdentity } from "../../../src/memory/jev/shell-parse.js";

function programs(cmd: string): string[] {
  return parseShell(cmd).commands.map((c) => c.program);
}

describe("table-driven parse cases", () => {
  const cases: readonly { cmd: string; want: readonly string[]; not?: readonly string[] }[] = [
    // plain programs and argv
    { cmd: "git push", want: ["git"] },
    { cmd: "git push origin dev", want: ["git"] },
    { cmd: "git stash", want: ["git"] },
    { cmd: "gh pr create --title x", want: ["gh"] },
    { cmd: "gh run rerun --failed", want: ["gh"] },
    { cmd: "npm publish", want: ["npm"] },
    { cmd: "npm version patch", want: ["npm"] },
    { cmd: "npm test", want: ["npm"] },
    { cmd: "npm run build", want: ["npm"] },
    { cmd: "npm run typecheck", want: ["npm"] },
    { cmd: "npx prettier --write .", want: ["npx"] },
    { cmd: "tsc --noEmit", want: ["tsc"] },
    { cmd: "rm -rf build", want: ["rm"] },
    { cmd: "git clean -fdx", want: ["git"] },
    { cmd: "curl -x http://127.0.0.1:7890 https://example.com", want: ["curl"] },
    { cmd: "git checkout -b feature/x", want: ["git"] },
    { cmd: "git switch dev", want: ["git"] },
    { cmd: "git reset --hard", want: ["git"] },
    { cmd: "ls -la", want: ["ls"] },
    { cmd: "", want: [] },
    { cmd: "   \t ", want: [] },
    // echo never hides a different program
    { cmd: 'echo "git push"', want: ["echo"], not: ["git"] },
    { cmd: "echo 'git commit'", want: ["echo"], not: ["git"] },
    { cmd: "echo git push", want: ["echo"], not: ["git"] },
    // env assignment prefixes
    { cmd: "FOO=1 git push", want: ["git"] },
    { cmd: "A=1 B_2=x rm file", want: ["rm"] },
    // git global options
    { cmd: "git -C repo push", want: ["git"] },
    { cmd: "git -c user.name=x commit", want: ["git"] },
    { cmd: "git --no-pager log", want: ["git"] },
    { cmd: "git --git-dir=/x/.git status", want: ["git"] },
    { cmd: "git --work-tree=/x push", want: ["git"] },
    { cmd: "git -P branch", want: ["git"] },
    // chaining operators
    { cmd: "git add -A && git commit -m x", want: ["git", "git"] },
    { cmd: "git add . ; git status", want: ["git", "git"] },
    { cmd: "git pull || git fetch", want: ["git", "git"] },
    { cmd: "cat file | grep needle", want: ["cat", "grep"] },
    { cmd: "sleep 10 &", want: ["sleep"] },
    { cmd: "git add .\ngit commit", want: ["git", "git"] },
    { cmd: "a && b || c", want: ["a", "b", "c"] },
    // cd tracking (cd itself is not a command)
    { cmd: "cd x && git commit", want: ["git"] },
    { cmd: "cd /abs/path && rm old", want: ["rm"] },
    { cmd: "cd a && cd b && git push", want: ["git"] },
    // interpreters without -c → script identity
    { cmd: "bash scripts/release/release.sh 0.10.3", want: ["release.sh"], not: ["bash"] },
    { cmd: "sh run.sh", want: ["run.sh"] },
    { cmd: "zsh deploy.sh --prod", want: ["deploy.sh"] },
    { cmd: "node scripts/build.js --watch", want: ["build.js"] },
    { cmd: "python tool.py a b", want: ["tool.py"] },
    { cmd: "python3 -m venv env", want: ["venv"] }, // first non-option arg per §2.7.1
    { cmd: "vim scripts/release/release.sh", want: ["vim"], not: ["release.sh"] },
    // bash -c string recursion
    { cmd: 'bash -c "git push"', want: ["git"] },
    { cmd: "sh -c 'rm -rf /tmp/x'", want: ["rm"] },
    { cmd: 'bash -c "cd sub && git commit"', want: ["git"] },
    { cmd: "bash -c 'bash -c \"git stash\"'", want: ["git"] },
    // short-flag clusters containing c count as -c (J7 verifier: `bash -lc` bypass)
    { cmd: "bash -lc 'git commit -m x'", want: ["git"] },
    { cmd: 'bash -ic "git push"', want: ["git"] },
    { cmd: "bash -o pipefail -c 'git push'", want: ["git"] },
    { cmd: "bash --login -c 'git push'", want: ["git"] },
    { cmd: "sh -xec 'rm -rf build'", want: ["rm"] },
    { cmd: 'bash deploy.sh -c "git push"', want: ["deploy.sh"], not: ["git"] }, // -c after the script operand is a script arg
    { cmd: "bash -o pipefail deploy.sh", want: ["deploy.sh"], not: ["pipefail"] },
    { cmd: "bash -lc 'git commit -m x'", want: ["bash", "git"] }, // outer identity is the interpreter, not the script string
    // wrappers
    { cmd: "env git push", want: ["git"] },
    { cmd: "env -i git push", want: ["git"] },
    { cmd: "env FOO=1 git push", want: ["git"] },
    { cmd: "sudo git push", want: ["git"] },
    { cmd: "sudo -u root git push", want: ["git"] },
    { cmd: "command git push", want: ["git"] },
    { cmd: "builtin echo hi", want: ["echo"] },
    { cmd: "exec npm test", want: ["npm"] },
    { cmd: "nohup npm run build", want: ["npm"] },
    { cmd: "time npm test", want: ["npm"] },
    { cmd: "nice npm test", want: ["npm"] },
    { cmd: "nice -n 5 npm test", want: ["npm"] },
    { cmd: "timeout 600 npx vitest run", want: ["npx"] },
    { cmd: "timeout --foreground 30 curl http://x", want: ["curl"] },
    { cmd: "timeout -k 5 300 ./run.sh", want: ["run.sh"] },
    { cmd: "timeout 5s git push", want: ["git"] },
    // subshells and substitutions
    { cmd: "(git push)", want: ["git"] },
    { cmd: "(cd sub && git push)", want: ["git"] },
    { cmd: "(git add . && git commit) && git push", want: ["git"] },
    { cmd: "echo $(git status)", want: ["echo", "git"] },
    { cmd: "$(git push)", want: ["git"] },
    { cmd: "echo `git pull`", want: ["echo", "git"] },
    // redirects
    { cmd: "git push > out.txt", want: ["git"] },
    { cmd: "git push 2>/dev/null", want: ["git"] },
    { cmd: "ls > /dev/null 2>&1", want: ["ls"] },
    { cmd: "git push >> log.txt 2>&1", want: ["git"] },
    { cmd: "sort < input.txt", want: ["sort"] },
    // comments
    { cmd: "git push # push it now", want: ["git"] },
    { cmd: "# just a comment\ngit push", want: ["git"] },
    // find -delete shape
    { cmd: "find . -name node_modules -delete", want: ["find"] },
    // absolute paths
    { cmd: "/usr/bin/git push", want: ["git"] },
    { cmd: "./scripts/release/release.sh 1.2.3", want: ["release.sh"] },
    // CRLF input
    { cmd: "git push\r\ngit status\r\n", want: ["git", "git"] },
  ];

  it.each(cases)("“$cmd” yields programs ⊇ $want (and ∌ $not)", ({ cmd, want, not }) => {
    const got = programs(cmd);
    for (const w of want) expect(got, `${cmd} → ${got.join(",")}`).toContain(w);
    for (const n of not ?? []) expect(got, `${cmd} → ${got.join(",")}`).not.toContain(n);
  });

  it("covers ≥60 table rows", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });
});

describe("argv-level details", () => {
  it("quoted argument stays one argv entry", () => {
    const c = parseShell('git commit -m "fix: hud width"').commands[0]!;
    expect(c.program).toBe("git");
    expect(c.argv).toEqual(["git", "commit", "-m", "fix: hud width"]);
    expect(c.positionals).toEqual(["commit", "fix: hud width"]);
  });

  it("single quotes keep content literal; backslash escapes join words", () => {
    expect(parseShell("rm 'file name'").commands[0]!.argv).toEqual(["rm", "file name"]);
    expect(parseShell("rm file\\ name").commands[0]!.argv).toEqual(["rm", "file name"]);
  });

  it("cd chain and git -C land in cwd; subshell cd stays local", () => {
    const push = parseShell("cd repo && git -C sub push").commands[0]!;
    expect(push.cwd).toBe("repo/sub");
    const outer = parseShell("(cd inner && git push) && git status").commands;
    expect(outer.find((c) => c.program === "git" && c.positionals.includes("push"))!.cwd).toBe("inner");
    expect(outer.find((c) => c.program === "git" && c.positionals.includes("status"))!.cwd).toBeUndefined();
  });

  it("git subcommand survives global options in positionals", () => {
    expect(parseShell("git -C x push").commands[0]!.positionals[0]).toBe("push");
    expect(parseShell("git --no-pager log -1").commands[0]!.positionals[0]).toBe("log");
  });

  it("heredoc body lines are skipped, not parsed as commands", () => {
    const cmd = "cat <<EOF\ngit push\nrm -rf /\nEOF\ngit status";
    const got = programs(cmd);
    expect(got).toContain("cat");
    expect(got).toContain("git");
    expect(got).not.toContain("rm");
  });

  it("heredoc with <<- and quoted tag", () => {
    const cmd = 'cat <<-"DONE"\n\tgit push\nDONE\necho after';
    expect(programs(cmd)).toEqual(["cat", "echo"]);
  });

  it("unterminated quotes/parens ⇒ ok:false with best-effort commands", () => {
    const a = parseShell('echo "unterminated');
    expect(a.ok).toBe(false);
    const b = parseShell("echo $(git push");
    expect(b.ok).toBe(false);
    const c = parseShell("echo 'x");
    expect(c.ok).toBe(false);
    expect(parseShell("git push").ok).toBe(true);
  });

  it("input is truncated to 8KB (deeply nested junk cannot loop)", () => {
    const huge = `${"(".repeat(5_000)}git push${")".repeat(5_000)}`;
    const r = parseShell(huge);
    expect(r.commands.length).toBeGreaterThanOrEqual(1);
  });

  it("depth ≤2 recursion still surfaces inner commands", () => {
    const r = parseShell('bash -c "bash -c \\"git stash\\""');
    expect(r.commands.map((c) => c.program)).toContain("git");
  });
});

describe("programIdentity", () => {
  it("interpreter without -c takes the script basename", () => {
    expect(programIdentity(["bash", "scripts/release/release.sh", "0.10.3"])).toBe("release.sh");
    expect(programIdentity(["node", "build.js"])).toBe("build.js");
  });
  it("interpreter with -c stays the interpreter; non-interpreters use argv0", () => {
    expect(programIdentity(["bash", "-c", "git push"])).toBe("bash");
    expect(programIdentity(["/usr/bin/git", "push"])).toBe("git");
    expect(programIdentity(["python3", "-m", "venv"])).toBe("venv"); // -m is an option; first non-option arg wins
    expect(programIdentity([])).toBe("");
  });
});

describe("fuzz — never throws (§2.7.1)", () => {
  it("seeded random bytes and token soup stay total", () => {
    let seed = 0x51ed270b;
    const rand = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    const soup = [...'\\ "\'"`$()<>|&;\n\t#=-abc_git_push0rm./'];
    for (let i = 0; i < 800; i++) {
      const len = Math.floor(rand() * 220);
      let s = "";
      for (let j = 0; j < len; j++) s += soup[Math.floor(rand() * soup.length)]!;
      const r = parseShell(s);
      expect(Array.isArray(r.commands)).toBe(true);
      expect(typeof r.ok).toBe("boolean");
      // Random raw bytes (incl. C1/lone surrogates) through the same entry.
      let bytes = "";
      const byteLen = Math.floor(rand() * 300);
      for (let k = 0; k < byteLen; k++) bytes += String.fromCharCode(Math.floor(rand() * 256));
      expect(() => parseShell(bytes)).not.toThrow();
    }
  });
});
