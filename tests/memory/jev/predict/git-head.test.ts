// git-head.ts unit tests (plan.md v3.2 section 7.3).

import { describe, expect, it } from "vitest";
import { readGitBranch, readHeadAt, type GitHeadIo } from "../../../../src/memory/jev/predict/git-head.js";

function ioFrom(files: Record<string, string>): GitHeadIo {
  return {
    readTextFile: (path) => files[path],
  };
}

describe("readGitBranch", () => {
  it("reads a normal branch ref from a regular repo (.git is a directory)", () => {
    const io = ioFrom({ "/repo/.git/HEAD": "ref: refs/heads/dev\n" });
    expect(readGitBranch("/repo", io)).toBe("dev");
  });

  it("returns undefined for a detached HEAD (40-hex SHA)", () => {
    const io = ioFrom({ "/repo/.git/HEAD": "a".repeat(40) + "\n" });
    expect(readGitBranch("/repo", io)).toBeUndefined();
  });

  it("returns undefined when there is no .git at all", () => {
    expect(readGitBranch("/repo", ioFrom({}))).toBeUndefined();
  });

  it("follows a linked worktree's .git FILE (absolute gitdir) to the real HEAD", () => {
    // 真实 linked worktree 布局：<cwd>/.git 是文本文件，内容 gitdir: <main>/.git/worktrees/<name>；
    // 该目录下的 HEAD 直接就是 ref: refs/heads/<branch>（不会再指向另一个 gitdir）。
    const io = ioFrom({
      "/repo/.git": "gitdir: /main/.git/worktrees/wt1\n",
      "/main/.git/worktrees/wt1/HEAD": "ref: refs/heads/feat/x\n",
    });
    expect(readGitBranch("/repo", io)).toBe("feat/x");
  });

  it("resolves a relative gitdir path against cwd", () => {
    const io = ioFrom({
      "/repo/.git": "gitdir: ../main/.git/worktrees/wt1\n",
      "/main/.git/worktrees/wt1/HEAD": "ref: refs/heads/feat/y\n",
    });
    expect(readGitBranch("/repo", io)).toBe("feat/y");
  });

  it("does not treat a HEAD file that anomalously contains another gitdir as a branch", () => {
    const io = ioFrom({
      "/repo/.git": "gitdir: /main/.git/worktrees/wt1\n",
      "/main/.git/worktrees/wt1/HEAD": "gitdir: /somewhere/else\n",
    });
    expect(readGitBranch("/repo", io)).toBeUndefined();
  });

  it("rejects a malformed .git file (no gitdir prefix, garbage content)", () => {
    const io = ioFrom({ "/repo/.git": "not a gitdir pointer\n" });
    expect(readGitBranch("/repo", io)).toBeUndefined();
  });

  it("rejects a branch name that looks like a path traversal or lock file", () => {
    expect(readGitBranch("/repo", ioFrom({ "/repo/.git/HEAD": "ref: refs/heads/../../etc/passwd\n" }))).toBeUndefined();
    expect(readGitBranch("/repo", ioFrom({ "/repo/.git/HEAD": "ref: refs/heads/foo.lock\n" }))).toBeUndefined();
  });

  it("never throws on a huge or malformed HEAD file", () => {
    const io = ioFrom({ "/repo/.git/HEAD": "ref: refs/heads/" + "x".repeat(1000) + "\n" });
    expect(() => readGitBranch("/repo", io)).not.toThrow();
    expect(readGitBranch("/repo", io)).toBeUndefined();
  });

  it("tolerates trailing slashes in cwd", () => {
    const io = ioFrom({ "/repo/.git/HEAD": "ref: refs/heads/dev\n" });
    expect(readGitBranch("/repo/", io)).toBe("dev");
  });
});

describe("readHeadAt", () => {
  it("is a pure read with no throwing on IO failure", () => {
    const io: GitHeadIo = { readTextFile: () => undefined };
    expect(readHeadAt("/x", io)).toEqual({});
  });
});
