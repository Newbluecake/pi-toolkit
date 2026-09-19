import { describe, expect, it, vi } from "vitest";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";
import { forgetWorktreeOrigin, resolveWorktreeOrigin } from "../../src/core/worktree-origin.js";
import { createWorktreeExtension, type ExecResult, type WorktreeExec } from "../../src/extensions/worktree.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const outcome = (runId: string): RunOutcome => ({
  runId,
  status: "completed",
  turns: 1,
  durationMs: 1,
  diag: {} as RunOutcome["diag"],
});
const request = (runId: string): SpawnRequest => ({
  runId,
  type: "worker",
  prompt: "work",
  cwd: "/repo",
  isolation: "worktree",
});

function fakeGit(
  opts: {
    dirty?: boolean;
    addCode?: number;
    removeCode?: number;
    statusCode?: number;
    switchCode?: number;
    commitCode?: number;
  } = {},
) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const branches = new Set<string>();
  const exec: WorktreeExec = async (_cmd, args, commandOpts) => {
    calls.push({ args: [...args], cwd: commandOpts.cwd });
    if (args[0] === "rev-parse") return ok("/repo\n");
    if (args[0] === "worktree" && args[1] === "add")
      return opts.addCode ? { code: opts.addCode, stdout: "", stderr: "cannot create" } : ok();
    if (args[0] === "status")
      return opts.statusCode
        ? { code: opts.statusCode, stdout: "", stderr: "status failed" }
        : ok(opts.dirty ? " M file.txt\n" : "");
    if (args[0] === "switch") {
      if (opts.switchCode) return { code: opts.switchCode, stdout: "", stderr: "branch exists" };
      branches.add(args[2]);
      return ok();
    }
    if (args[0] === "commit")
      return opts.commitCode ? { code: opts.commitCode, stdout: "", stderr: "hook rejected" } : ok();
    if (args[0] === "worktree" && args[1] === "remove")
      return { code: opts.removeCode ?? 0, stdout: "", stderr: opts.removeCode ? "cannot remove" : "" };
    return ok();
  };
  return { exec, calls, branches };
}

describe("worktree extension", () => {
  it("rewrites cwd and creates a detached worktree only when explicitly requested", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const spec = await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-create"));
    expect(spec?.cwd).toBe("/tmp/test-worktrees/r-create");
    expect(fake.calls.map((c) => c.args)).toContainEqual([
      "worktree",
      "add",
      "--detach",
      "/tmp/test-worktrees/r-create",
    ]);

    const untouched = await ext.resolveSessionSpec?.({ cwd: "/repo" }, { type: "worker", prompt: "work" });
    expect(untouched).toEqual({ cwd: "/repo" });
  });

  it("surfaces worktree creation failure so the adapter can return failed(config)", async () => {
    const fake = fakeGit({ addCode: 1 });
    const diagnostics: unknown[] = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await expect(ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-create-fail"))).rejects.toThrow(/cannot create/);
    expect(diagnostics[0]).toMatchObject({ runId: "r-create-fail", phase: "create" });
  });

  it("fails explicitly when isolation is requested while disabled", async () => {
    const exec = vi.fn<WorktreeExec>(async () => ok("/repo\n"));
    const ext = createWorktreeExtension({ exec });
    await expect(ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-disabled"))).rejects.toThrow(/disabled/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("commits dirty worktree changes to pi-agent-runId before removing it", async () => {
    const fake = fakeGit({ dirty: true });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-dirty"));
    await ext.beforeReap?.(outcome("r-dirty"), { cwd: "/tmp/test-worktrees/r-dirty", deadlineMs: 1000 });
    expect(fake.branches.has("pi-agent-r-dirty")).toBe(true);
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["worktree", "add", "--detach", "/tmp/test-worktrees/r-dirty"],
      ["status", "--porcelain"],
      ["switch", "-c", "pi-agent-r-dirty"],
      ["add", "-A"],
      ["commit", "-m", "pi-agent r-dirty"],
      ["worktree", "remove", "--force", "/tmp/test-worktrees/r-dirty"],
    ]);
  });

  it("removes a clean worktree without creating a branch", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-clean"));
    await ext.beforeReap?.(outcome("r-clean"), { cwd: "/tmp/test-worktrees/r-clean", deadlineMs: 1000 });
    expect(fake.branches.size).toBe(0);
    expect(fake.calls.at(-1)?.args).toEqual(["worktree", "remove", "--force", "/tmp/test-worktrees/r-clean"]);
  });

  it("reports cleanup failure without throwing or changing the run outcome", async () => {
    const fake = fakeGit({ removeCode: 1 });
    const diagnostics: unknown[] = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-cleanup-fail"));
    await expect(
      ext.beforeReap?.(outcome("r-cleanup-fail"), { cwd: "/tmp/test-worktrees/r-cleanup-fail", deadlineMs: 1000 }),
    ).resolves.toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      runId: "r-cleanup-fail",
      phase: "cleanup",
      message: "worktree cleanup failed",
    });
  });

  it.each([
    ["commit fails", { commitCode: 1 }],
    ["branch switch fails", { switchCode: 1 }],
  ])("preserves a dirty worktree when %s — never force-removes uncommitted work", async (_label, opts) => {
    const fake = fakeGit({ dirty: true, ...opts });
    const diagnostics: Array<{ message: string }> = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-preserve"));
    await ext.beforeReap?.(outcome("r-preserve"), { cwd: "/tmp/test-worktrees/r-preserve", deadlineMs: 1000 });
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("worktree preserved at /tmp/test-worktrees/r-preserve");
    // bookkeeping is still dropped — the preserved directory is for manual recovery
    expect(resolveWorktreeOrigin("/tmp/test-worktrees/r-preserve")).toBeUndefined();
  });

  it("preserves the worktree when the status check itself fails (cleanliness unknown)", async () => {
    const fake = fakeGit({ statusCode: 1 });
    const diagnostics: Array<{ message: string }> = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-status-fail"));
    await ext.beforeReap?.(outcome("r-status-fail"), { cwd: "/tmp/test-worktrees/r-status-fail", deadlineMs: 1000 });
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    expect(diagnostics[0]?.message).toContain("worktree preserved at /tmp/test-worktrees/r-status-fail");
  });
});

describe("worktree-origin wiring (B3, 方案 §5.6/§7.9)", () => {
  it("records worktree path → original cwd on resolveSessionSpec; beforeReap forgets it", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const spec = await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-origin"));
    const worktreePath = spec?.cwd;
    expect(worktreePath).toBe("/tmp/test-worktrees/r-origin");
    // memory's inject/tool cwd chain resolves the worktree back to the main repo
    expect(resolveWorktreeOrigin(worktreePath!)).toBe("/repo");

    await ext.beforeReap?.(outcome("r-origin"), { cwd: worktreePath!, deadlineMs: 1000 });
    expect(resolveWorktreeOrigin(worktreePath!)).toBeUndefined(); // reap cleans the entry
  });

  it("does not record anything for non-worktree requests", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const spec = await ext.resolveSessionSpec?.({ cwd: "/repo" }, { type: "worker", prompt: "work" });
    expect(spec).toEqual({ cwd: "/repo" });
    expect(resolveWorktreeOrigin("/repo")).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("does not record when worktree creation fails", async () => {
    const fake = fakeGit({ addCode: 1 });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await expect(ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-origin-fail"))).rejects.toThrow();
    expect(resolveWorktreeOrigin("/tmp/test-worktrees/r-origin-fail")).toBeUndefined();
  });

  it("forget is idempotent", () => {
    forgetWorktreeOrigin("/tmp/test-worktrees/never-recorded");
    expect(resolveWorktreeOrigin("/tmp/test-worktrees/never-recorded")).toBeUndefined();
  });
});
