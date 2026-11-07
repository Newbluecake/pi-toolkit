import { describe, expect, it, vi } from "vitest";
import { createPortRegistry } from "../../../src/reflex/ports/index.js";
import { REFLEX_GIT_ARGV } from "../../../src/reflex/ports/git.js";
import { deps, env, gitResult, head, tracked } from "./helpers.js";

describe("git.status", () => {
  it("pins read-only argv and bounded minimal execution; input never enters argv", async () => {
    expect(REFLEX_GIT_ARGV).toEqual([
      "--no-replace-objects",
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=normal",
    ]);
    expect(Object.isFrozen(REFLEX_GIT_ARGV)).toBe(true);
    const git = vi.fn(async () => gitResult());
    const e = env({ cwd: "/tmp/--evil; touch bad", budgetMs: 9999 });
    await createPortRegistry(deps({ git })).get("git.status")!.run(e);
    expect(git).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith(REFLEX_GIT_ARGV, {
      cwd: e.cwd,
      timeoutMs: 1200,
      maxStdoutBytes: 65536,
      envPolicy: "minimal",
      pathOverride: "/usr/bin:/bin",
      signal: e.signal,
    });
  });
  it.each([
    [gitResult({ code: 128 }), "unavailable", "git unavailable"],
    [gitResult({ spawnError: "ENOENT" }), "unavailable", "git unavailable"],
    [gitResult({ killed: "timeout", code: null }), "error", "timeout"],
    [gitResult({ stdoutCapped: true }), "error", "overflow"],
    [gitResult({ killed: "overflow", code: null }), "error", "overflow"],
    [gitResult({ killed: "abort", code: null }), "error", "aborted"],
    [gitResult({ code: 1 }), "error", "exit"],
    [gitResult({ code: null }), "error", "exit"],
    [gitResult({ stdout: "invalid" }), "error", "parse"],
  ] as const)("maps runner failure %#", async (result, kind, reason) => {
    expect(
      await createPortRegistry(deps({ git: async () => result }))
        .get("git.status")!
        .run(env()),
    ).toEqual({ kind, reason });
  });
  it("renders changed status plus first 15 paths; facts do not contain paths", async () => {
    const stdout = head + tracked("MM", "file") + Array.from({ length: 20 }, (_, i) => `? new ${i}\0`).join("");
    const out = await createPortRegistry(deps({ git: async () => gitResult({ stdout }) }))
      .get("git.status")!
      .run(env());
    expect(out).toMatchObject({
      kind: "ok",
      facts: { branch: "dev", ahead: 0, behind: 0, staged: 1, modified: 1, untracked: 20, unmerged: 0, clean: false },
      truncated: true,
    });
    if (out.kind !== "ok") throw new Error("wrong outcome");
    expect(out.lines).toHaveLength(17);
    expect(out.lines[0]).toBe("dev · upstream none · ahead 0/behind 0");
    expect(out.lines[1]).toBe("staged 1/modified 1/untracked 20/unmerged 0");
    expect(out.lines[2]).toBe("file");
    expect(Object.keys(out.facts)).not.toContain("paths");
  });
  it("clean always preserves branch summary and emptyText semantics (root-approved deviation)", async () => {
    expect(await createPortRegistry(deps()).get("git.status")!.run(env())).toEqual({
      kind: "ok",
      lines: ["dev · upstream none · ahead 0/behind 0", "working tree clean"],
      facts: { branch: "dev", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, unmerged: 0, clean: true },
      truncated: false,
    });
  });
  it.each([
    [head + "# branch.upstream origin/dev\0# branch.ab +2 -3\0", "dev · upstream origin/dev · ahead 2/behind 3"],
    [head.replace("branch.head dev", "branch.head (detached)"), "HEAD (detached) · upstream none · ahead 0/behind 0"],
    ["# branch.oid (initial)\0# branch.head main\0", "main · upstream none · ahead 0/behind 0"],
  ])("summarizes upstream/detached/initial explicitly %#", async (stdout, summary) => {
    const outcome = await createPortRegistry(deps({ git: async () => gitResult({ stdout }) }))
      .get("git.status")!
      .run(env());
    expect(outcome).toMatchObject({ kind: "ok", lines: [summary, "working tree clean"], facts: { clean: true } });
  });
  it("pre-abort and invalid direct budgets do not spawn", async () => {
    const git = vi.fn(async () => gitResult());
    const controller = new AbortController();
    controller.abort();
    const port = createPortRegistry(deps({ git })).get("git.status")!;
    expect(await port.run(env({ signal: controller.signal }))).toEqual({ kind: "error", reason: "aborted" });
    expect(await port.run(env({ budgetMs: 0 }))).toEqual({ kind: "error", reason: "timeout" });
    expect(git).not.toHaveBeenCalled();
  });
});
