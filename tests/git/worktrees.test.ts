import { describe, expect, it } from "vitest";

import type { GitRunResult, GitRunner } from "../../src/git/run.js";
import {
  parseStatusV2,
  parseWorktreePorcelain,
  rankWorktrees,
  scanWorktrees,
  type ScannedWorktree,
} from "../../src/git/worktrees.js";

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stdoutCapped: false, stderr: "" });

describe("worktree parsing", () => {
  it("parses normal, detached, bare, locked, and prunable records", () => {
    const input = [
      "worktree /repo",
      "HEAD abcdef0123456789",
      "branch refs/heads/main",
      "",
      "worktree /repo/detached",
      "HEAD 1234567890abcdef",
      "detached",
      "",
      "worktree /repo/bare",
      "bare",
      "",
      "worktree /repo/locked",
      "HEAD deadbeef",
      "locked reason",
      "",
      "worktree /gone",
      "prunable reason",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(input, false)).toEqual([
      { path: "/repo", head: "abcdef0123456789", branch: "main" },
      { path: "/repo/detached", head: "1234567890abcdef", detached: true },
      { path: "/repo/bare", bare: true },
      { path: "/repo/locked", head: "deadbeef", locked: true },
      { path: "/gone", prunable: true },
    ]);
    expect(parseWorktreePorcelain(input.slice(0, -1), true)).toHaveLength(4);
  });

  it("drops malformed newline-path fragments without throwing", () => {
    expect(parseWorktreePorcelain("worktree /repo/with\nnewline\nHEAD abc\nbranch refs/heads/main\n\n", false)).toEqual(
      [],
    );
  });

  it("keeps branch headers and drops a capped status fragment", () => {
    expect(parseStatusV2("# branch.head main\n# branch.ab +2 -1\n1 .M file\n? new\n", false)).toEqual({
      dirty: 2,
      dirtyCapped: false,
      upstream: false,
      ahead: 2,
      behind: 1,
    });
    expect(
      parseStatusV2("# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n1 .M file\n? partial", true),
    ).toEqual({ dirty: 1, dirtyCapped: true, upstream: true, ahead: 1, behind: 0 });
  });

  it("ranks current, main, regular, agent, then prunable paths", () => {
    const row = (path: string, fields: Partial<ScannedWorktree> = {}): ScannedWorktree => ({
      path,
      main: false,
      current: false,
      ...fields,
    });
    expect(
      rankWorktrees([
        row("/z", { prunable: true }),
        row("/agent", { agentRunId: "x" }),
        row("/main", { main: true }),
        row("/current", { current: true }),
        row("/regular"),
      ]).map((r) => r.path),
    ).toEqual(["/current", "/main", "/regular", "/agent", "/z"]);
  });

  it.each(["/proc/self/fd/7", "/proc/123/fd/7"])(
    "fails closed for proc fd cwd %s without invoking git",
    async (cwd) => {
      let calls = 0;
      const run: GitRunner = async () => {
        calls++;
        return ok("");
      };
      await expect(scanWorktrees(run, cwd, { signal: new AbortController().signal })).resolves.toEqual({
        kind: "not-repo",
        reason: "proc-fd-cwd",
      });
      expect(calls).toBe(0);
    },
  );

  it("falls back to string comparison when realpath fails", async () => {
    const run: GitRunner = async (args) => {
      if (args.includes("rev-parse")) return ok("/repo\n");
      if (args.includes("worktree")) return ok("worktree /repo\nHEAD abc\nbranch refs/heads/main\n");
      return ok("# branch.head main\n");
    };
    const result = await scanWorktrees(run, "/repo", {
      signal: new AbortController().signal,
      realpath: async () => {
        throw new Error("missing");
      },
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.worktrees[0]?.current).toBe(true);
  });

  it("uses realpath equality, degraded -uno, probe cap, and skips prunable rows", async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      if (args.includes("rev-parse")) return ok("/top\n");
      if (args.includes("worktree"))
        return ok(
          "worktree /link\nHEAD a\nbranch refs/heads/main\n\nworktree /other\nHEAD b\nbranch refs/heads/pi-agent-run\n\nworktree /gone\nprunable missing\n",
        );
      return ok("# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -2\n1 .M file\n");
    };
    const result = await scanWorktrees(run, "/cwd", {
      signal: new AbortController().signal,
      realpath: async (path) => (path === "/top" || path === "/link" ? "/real" : path),
      degraded: new Set(["/real"]),
      maxProbes: 1,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.worktrees[0]?.current).toBe(true);
    expect(result.worktrees[0]?.probe?.untrackedSkipped).toBe(true);
    expect(result.worktrees[1]?.unprobed).toBe("cap");
    expect(result.worktrees[2]?.prunable).toBe(true);
    expect(calls.some((args) => args.includes("no"))).toBe(true);
  });
});
