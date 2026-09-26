import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";
import { forgetWorktreeOrigin, resolveWorktreeOrigin } from "../../src/core/worktree-origin.js";
import { createWorktreeExtension, type ExecResult, type WorktreeExec } from "../../src/extensions/worktree.js";
import { trackedWorktrees } from "../../src/extensions/worktree-orphans.js";

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
    /** `git branch <name> HEAD` failure code (the headAdvanced+clean path). */
    branchCode?: number;
    /** sha `git rev-parse HEAD` reports in the main repo (H2, cwd "/repo") — the base commit recorded on the record. Default "base-sha". */
    baseHead?: string;
    /** sha `git rev-parse HEAD` reports inside the worktree (H3) — defaults to `baseHead` (HEAD unchanged). Set different from `baseHead` to simulate the sub agent committing on its own. */
    worktreeHead?: string;
    /** H2's pre-add `rev-parse HEAD` in the repo fails (unborn HEAD / transient failure — record.baseHead stays unset). */
    headRevParseFails?: boolean;
    /** H2's OWN post-add fallback `rev-parse HEAD` inside the fresh worktree (only runs when `headRevParseFails` is set) also fails — baseHead stays permanently unset even though H3's later rev-parse succeeds normally. */
    fallbackRevParseFails?: boolean;
    /** H3's `rev-parse HEAD` inside the worktree fails — the "cannot determine, treat as unsafe" path. */
    worktreeRevParseFails?: boolean;
  } = {},
) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const branches = new Set<string>();
  const baseHead = opts.baseHead ?? "base-sha";
  const worktreeHead = opts.worktreeHead ?? baseHead;
  let worktreeHeadCallCount = 0;
  const exec: WorktreeExec = async (_cmd, args, commandOpts) => {
    calls.push({ args: [...args], cwd: commandOpts.cwd });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      if (commandOpts.cwd === "/repo") {
        return opts.headRevParseFails ? { code: 1, stdout: "", stderr: "no head" } : ok(`${baseHead}\n`);
      }
      worktreeHeadCallCount += 1;
      // The very first worktree-cwd call only exists when the repo capture
      // above failed — it is H2's OWN post-add fallback, not H3's later call.
      if (worktreeHeadCallCount === 1 && opts.headRevParseFails && opts.fallbackRevParseFails) {
        return { code: 1, stdout: "", stderr: "no head" };
      }
      return opts.worktreeRevParseFails ? { code: 1, stdout: "", stderr: "no head" } : ok(`${worktreeHead}\n`);
    }
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
    if (args[0] === "branch") {
      if (opts.branchCode) return { code: opts.branchCode, stdout: "", stderr: "branch exists" };
      branches.add(args[1]);
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
      "base-sha",
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
    const calls: Array<{ state: string; branch?: string; commit?: string }> = [];
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-dirty"));
    await ext.beforeReap?.(outcome("r-dirty"), {
      cwd: "/tmp/test-worktrees/r-dirty",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    expect(fake.branches.has("pi-agent-r-dirty")).toBe(true);
    // replay-verify plan D1: `status` now runs first on every path, and the
    // dirty path's own rev-parse HEAD (to obtain the commit sha) runs LAST,
    // after commit — report-before-5-commands stays true.
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "HEAD"],
      ["worktree", "add", "--detach", "/tmp/test-worktrees/r-dirty", "base-sha"],
      ["status", "--porcelain"],
      ["switch", "-c", "pi-agent-r-dirty"],
      ["add", "-A"],
      ["commit", "-m", "pi-agent r-dirty"],
      ["rev-parse", "HEAD"],
      ["worktree", "remove", "--force", "/tmp/test-worktrees/r-dirty"],
    ]);
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-dirty", commit: "base-sha" }]);
  });

  it("replay-verify plan D1: a dirty commit whose trailing rev-parse HEAD fails still reports 'committed' (no downgrade to 'kept') and the worktree is still removed, just without a sha", async () => {
    const fake = fakeGit({ dirty: true, worktreeRevParseFails: true });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const calls: Array<{ state: string; branch?: string; commit?: string }> = [];
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-dirty-no-sha"));
    await ext.beforeReap?.(outcome("r-dirty-no-sha"), {
      cwd: "/tmp/test-worktrees/r-dirty-no-sha",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-dirty-no-sha" }]);
    expect(calls[0] && "commit" in calls[0]).toBe(false);
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
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

describe("data-loss fix: HEAD moved without a dirty working tree (sub agent committed on its own)", () => {
  it("HEAD advanced + clean working tree \u21d2 builds pi-agent-<runId> at HEAD and reports committed (not clean)", async () => {
    const fake = fakeGit({ worktreeHead: "child-sha" }); // sub agent ran `git commit` itself, then left a clean tree
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-head-advanced-clean"));
    const calls: Array<{ state: string; branch?: string; commit?: string }> = [];
    await ext.beforeReap?.(outcome("r-head-advanced-clean"), {
      cwd: "/tmp/test-worktrees/r-head-advanced-clean",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    // built via `git branch <name> HEAD`, never `git switch -c` (that would
    // disturb whatever ref the sub agent's HEAD currently resolves to)
    expect(fake.calls.some((c) => c.args[0] === "switch")).toBe(false);
    expect(fake.calls).toContainEqual(
      expect.objectContaining({ args: ["branch", "pi-agent-r-head-advanced-clean", "HEAD"] }),
    );
    expect(fake.branches.has("pi-agent-r-head-advanced-clean")).toBe(true);
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-head-advanced-clean", commit: "child-sha" }]);
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
  });

  it("HEAD advanced + dirty working tree \u21d2 unchanged existing switch-c/add/commit path (branch naturally includes the sub agent's own commit)", async () => {
    const fake = fakeGit({ dirty: true, worktreeHead: "child-sha" });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const calls: Array<{ state: string; branch?: string; commit?: string }> = [];
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-head-advanced-dirty"));
    await ext.beforeReap?.(outcome("r-head-advanced-dirty"), {
      cwd: "/tmp/test-worktrees/r-head-advanced-dirty",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    // replay-verify plan D1: `status` runs first; the dirty path no longer
    // reads HEAD up front (headAdvanced is irrelevant to it) \u2014 its own
    // rev-parse HEAD now runs LAST, after commit, purely to obtain a sha.
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "HEAD"],
      ["worktree", "add", "--detach", "/tmp/test-worktrees/r-head-advanced-dirty", "base-sha"],
      ["status", "--porcelain"],
      ["switch", "-c", "pi-agent-r-head-advanced-dirty"],
      ["add", "-A"],
      ["commit", "-m", "pi-agent r-head-advanced-dirty"],
      ["rev-parse", "HEAD"],
      ["worktree", "remove", "--force", "/tmp/test-worktrees/r-head-advanced-dirty"],
    ]);
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-head-advanced-dirty", commit: "child-sha" }]);
  });

  it("HEAD unchanged + clean working tree \u21d2 still the plain clean-remove path (unaffected)", async () => {
    const fake = fakeGit(); // worktreeHead defaults to baseHead — nothing happened
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-head-unchanged-clean"));
    const calls: Array<{ state: string; branch?: string }> = [];
    await ext.beforeReap?.(outcome("r-head-unchanged-clean"), {
      cwd: "/tmp/test-worktrees/r-head-unchanged-clean",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    expect(fake.branches.size).toBe(0);
    expect(calls).toEqual([{ state: "clean" }]);
  });

  it("HEAD advanced + clean but `git branch` fails (e.g. branch already exists) ⇒ kept, never removed", async () => {
    const fake = fakeGit({ worktreeHead: "agent-commit", branchCode: 128 });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-branch-fail"));
    const calls: Array<{ state: string; path?: string }> = [];
    await ext.beforeReap?.(outcome("r-branch-fail"), {
      cwd: "/tmp/test-worktrees/r-branch-fail",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    expect(fake.calls.some((c) => c.args[0] === "branch")).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    expect(calls).toEqual([{ state: "kept", path: "/tmp/test-worktrees/r-branch-fail" }]);
  });

  it("H3's own `rev-parse HEAD` failing \u21d2 treated as unsafe: kept, never removed (cannot prove anything)", async () => {
    const fake = fakeGit({ worktreeRevParseFails: true });
    const diagnostics: Array<{ message: string }> = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-revparse-fail"));
    const calls: Array<{ state: string; path?: string }> = [];
    await ext.beforeReap?.(outcome("r-revparse-fail"), {
      cwd: "/tmp/test-worktrees/r-revparse-fail",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    expect(fake.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    expect(calls).toEqual([{ state: "kept", path: "/tmp/test-worktrees/r-revparse-fail" }]);
    expect(diagnostics[0]?.message).toContain("worktree preserved at /tmp/test-worktrees/r-revparse-fail");
  });

  it("a record with no recorded baseHead (old/recovered record) never takes the clean-remove shortcut, even if the tree is clean and HEAD never moved", async () => {
    // Both of H2's own capture attempts fail (pre-add rev-parse in the repo,
    // then its post-add fallback rev-parse inside the fresh worktree) —
    // record.baseHead stays permanently unset even though H3's later
    // rev-parse (a transient failure can resolve itself) succeeds normally.
    const fake = fakeGit({ headRevParseFails: true, fallbackRevParseFails: true });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-no-base"));
    const calls: Array<{ state: string; branch?: string }> = [];
    await ext.beforeReap?.(outcome("r-no-base"), {
      cwd: "/tmp/test-worktrees/r-no-base",
      deadlineMs: 1000,
      setWorktreeDisposition: (d) => calls.push(d),
    });
    // conservative: baseHead unknown ⇒ always treated as "cannot prove
    // unchanged" ⇒ branch built rather than silently removed
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-no-base", commit: "base-sha" }]);
    expect(fake.branches.has("pi-agent-r-no-base")).toBe(true);
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

describe("worktree disposition reporting (X1 agent-tree marker)", () => {
  const reported = () => {
    const calls: Array<{ state: string; branch?: string }> = [];
    return {
      calls,
      ctx: {
        cwd: "/tmp/test-worktrees/r-x",
        deadlineMs: 1000,
        setWorktreeDisposition: (d: { state: "committed" | "kept" | "clean"; branch?: string; path?: string }) =>
          calls.push(d),
      },
    };
  };

  it("reports committed (with the pi-agent branch) for a dirty worktree", async () => {
    const fake = fakeGit({ dirty: true });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-report-dirty"));
    const { calls, ctx } = reported();
    await ext.beforeReap?.(outcome("r-report-dirty"), ctx);
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-report-dirty", commit: "base-sha" }]);
  });

  it("reports clean for an untouched worktree", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-report-clean"));
    const { calls, ctx } = reported();
    await ext.beforeReap?.(outcome("r-report-clean"), ctx);
    expect(calls).toEqual([{ state: "clean" }]);
  });

  it.each([
    ["the commit is rejected", { commitCode: 1 }],
    ["the branch switch fails", { switchCode: 1 }],
    ["the status check itself fails (cleanliness unknown)", { statusCode: 1 }],
  ])("reports kept when %s — the worktree stays on disk", async (_label, opts) => {
    const fake = fakeGit({ dirty: true, ...opts });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-report-kept"));
    const { calls, ctx } = reported();
    await ext.beforeReap?.(outcome("r-report-kept"), ctx);
    expect(calls).toEqual([{ state: "kept", path: "/tmp/test-worktrees/r-report-kept" }]);
  });

  it("still reports committed when only the final remove fails — the work is safe on the branch", async () => {
    const fake = fakeGit({ dirty: true, removeCode: 1 });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-remove-fail"));
    const { calls, ctx } = reported();
    await ext.beforeReap?.(outcome("r-remove-fail"), ctx);
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-remove-fail", commit: "base-sha" }]);
  });

  it("reports nothing for a run without a worktree record and tolerates a legacy ctx", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const { calls, ctx } = reported();
    // no resolveSessionSpec → no record → beforeReap is a no-op
    await ext.beforeReap?.(outcome("r-unknown"), ctx);
    expect(calls).toEqual([]);
    // legacy ctx (no callback at all) must not throw
    await expect(ext.beforeReap?.(outcome("r-unknown"), { cwd: "/repo", deadlineMs: 1000 })).resolves.toBeUndefined();
  });
});

describe("owner marker & token (§3, v2.1 condition 3)", () => {
  const markerPath = (root: string, runId: string) => join(root, ".owners", `${runId}.json`);

  it("writes the marker as 'creating' before `worktree add` runs, then rewrites it to 'active' after success", async () => {
    const root = "/tmp/test-worktrees-marker-1";
    const observed: string[] = [];
    const fake = fakeGit();
    const wrapped: WorktreeExec = async (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        observed.push(JSON.parse(readFileSync(markerPath(root, "r-marker"), "utf8")).state);
      }
      return fake.exec(cmd, args, opts);
    };
    const ext = createWorktreeExtension({ exec: wrapped, settings: { enabled: true }, worktreeRoot: root });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-marker"));
    expect(observed).toEqual(["creating"]);
    const after = JSON.parse(readFileSync(markerPath(root, "r-marker"), "utf8"));
    expect(after.state).toBe("active");
    expect(after.owner).toMatchObject({ pid: process.pid });
    expect(typeof after.owner.instanceId).toBe("string");
  });

  it("two extension instances carry different owner instanceIds", async () => {
    const root = "/tmp/test-worktrees-marker-2";
    const fake1 = fakeGit();
    const fake2 = fakeGit();
    const ext1 = createWorktreeExtension({ exec: fake1.exec, settings: { enabled: true }, worktreeRoot: root });
    const ext2 = createWorktreeExtension({ exec: fake2.exec, settings: { enabled: true }, worktreeRoot: root });
    await ext1.resolveSessionSpec?.({ cwd: "/repo" }, request("r-inst-1"));
    await ext2.resolveSessionSpec?.({ cwd: "/repo" }, request("r-inst-2"));
    const id1 = JSON.parse(readFileSync(markerPath(root, "r-inst-1"), "utf8")).owner.instanceId;
    const id2 = JSON.parse(readFileSync(markerPath(root, "r-inst-2"), "utf8")).owner.instanceId;
    expect(id1).not.toBe(id2);
  });

  it("adds the path to the process-wide tracked set while creating/active, removes it once beforeReap finishes", async () => {
    const root = "/tmp/test-worktrees-marker-3";
    const fake = fakeGit();
    const ext = createWorktreeExtension({ exec: fake.exec, settings: { enabled: true }, worktreeRoot: root });
    const path = `${root}/r-tracked`;
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-tracked"));
    expect(trackedWorktrees().has(path)).toBe(true);
    await ext.beforeReap?.(outcome("r-tracked"), { cwd: path, deadlineMs: 1000 });
    expect(trackedWorktrees().has(path)).toBe(false);
  });

  it("removes the marker file after beforeReap even when the worktree ends up 'kept'", async () => {
    const root = "/tmp/test-worktrees-marker-4";
    const fake = fakeGit({ dirty: true, commitCode: 1 });
    const ext = createWorktreeExtension({ exec: fake.exec, settings: { enabled: true }, worktreeRoot: root });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-kept-marker"));
    await ext.beforeReap?.(outcome("r-kept-marker"), { cwd: `${root}/r-kept-marker`, deadlineMs: 1000 });
    expect(existsSync(markerPath(root, "r-kept-marker"))).toBe(false);
  });
});

describe("D12: H2 cancellation & abandon compensation (v2.1 condition 1)", () => {
  const root = "/tmp/test-worktrees-d12";
  const markerPath = (runId: string) => join(root, ".owners", `${runId}.json`);

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true }); // no stale marker/state from a prior (possibly-failed) run
  });

  /** Real git leaves a real directory behind after `worktree add` and removes
   *  it on `worktree remove` — compensate()'s existsSync-gated branching only
   *  means anything if the fake mirrors that side effect. */
  function fakeFsGit(opts: { removeCode?: number; addCode?: number } = {}) {
    const calls: string[][] = [];
    const exec: WorktreeExec = async (_cmd, args) => {
      calls.push([...args]);
      if (args[0] === "rev-parse") return ok("/repo\n");
      if (args[0] === "worktree" && args[1] === "add") {
        if (opts.addCode) return { code: opts.addCode, stdout: "", stderr: "cannot create" };
        mkdirSync(args[3]!, { recursive: true });
        return ok();
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        if (opts.removeCode) return { code: opts.removeCode, stdout: "", stderr: "cannot remove" };
        rmSync(args[3]!, { recursive: true, force: true });
        return ok();
      }
      return ok();
    };
    return { exec, calls };
  }

  it("compensates (worktree remove) when `abandonSessionSpec` fires while `worktree add` is still creating", async () => {
    let releaseAdd!: () => void;
    const addGate = new Promise<void>((resolve) => (releaseAdd = resolve));
    const inner = fakeFsGit();
    const exec: WorktreeExec = async (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") await addGate;
      return inner.exec(cmd, args, opts);
    };
    const ext = createWorktreeExtension({ exec, settings: { enabled: true }, worktreeRoot: root });
    const pending = ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-creating"));
    // wait deterministically for H2 to reach `worktree add` (marker written "creating")
    // rather than a fixed setImmediate tick, which races the real mkdir() calls above it.
    const start = Date.now();
    while (Date.now() - start < 2000) {
      if (existsSync(markerPath("r-d12-creating"))) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    await ext.abandonSessionSpec?.("r-d12-creating", { reason: "startup_timeout" });
    // marker still exists (H2 will compensate itself once add returns)
    expect(existsSync(markerPath("r-d12-creating"))).toBe(true);
    releaseAdd();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(inner.calls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
    expect(existsSync(markerPath("r-d12-creating"))).toBe(false);
    expect(existsSync(`${root}/r-d12-creating`)).toBe(false);
    expect(trackedWorktrees().has(`${root}/r-d12-creating`)).toBe(false);
  });

  it("compensates when abandonSessionSpec lands during the post-add fallback rev-parse (last await of the creating phase)", async () => {
    let releaseFallback!: () => void;
    const fallbackGate = new Promise<void>((resolve) => (releaseFallback = resolve));
    let fallbackStarted = false;
    const inner = fakeFsGit();
    const exec: WorktreeExec = async (cmd, args, opts) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        // pre-add capture in the repo fails ⇒ H2 takes the fallback inside the worktree
        if (opts.cwd === "/repo") return { code: 1, stdout: "", stderr: "no head" };
        fallbackStarted = true;
        await fallbackGate;
        return ok("fallback-sha\n");
      }
      return inner.exec(cmd, args, opts);
    };
    const ext = createWorktreeExtension({ exec, settings: { enabled: true }, worktreeRoot: root });
    const pending = ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-fallback"));
    const start = Date.now();
    while (Date.now() - start < 2000 && !fallbackStarted) await new Promise((r) => setTimeout(r, 2));
    expect(fallbackStarted).toBe(true);
    await ext.abandonSessionSpec?.("r-d12-fallback", { reason: "startup_timeout" });
    releaseFallback();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(inner.calls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
    expect(existsSync(markerPath("r-d12-fallback"))).toBe(false);
    expect(existsSync(`${root}/r-d12-fallback`)).toBe(false);
    expect(trackedWorktrees().has(`${root}/r-d12-fallback`)).toBe(false);
  });

  it("compensates an already-active worktree when abandonSessionSpec fires after H2 succeeded (h2_failed / pre_runner_exit)", async () => {
    const fake = fakeFsGit();
    const ext = createWorktreeExtension({ exec: fake.exec, settings: { enabled: true }, worktreeRoot: root });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-active"));
    expect(existsSync(markerPath("r-d12-active"))).toBe(true);
    await ext.abandonSessionSpec?.("r-d12-active", { reason: "h2_failed" });
    expect(fake.calls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
    expect(existsSync(markerPath("r-d12-active"))).toBe(false);
    expect(existsSync(`${root}/r-d12-active`)).toBe(false);
    expect(resolveWorktreeOrigin(`${root}/r-d12-active`)).toBeUndefined();
  });

  it("abandonSessionSpec is a no-op for an unknown runId", async () => {
    const ext = createWorktreeExtension({
      exec: vi.fn(async () => ok()),
      settings: { enabled: true },
      worktreeRoot: root,
    });
    await expect(ext.abandonSessionSpec?.("no-such-run", { reason: "pre_runner_exit" })).resolves.toBeUndefined();
  });

  it("marks the worktree 'abandoned' (preserved) when the compensating remove fails, and warns via onDiagnostic", async () => {
    const fake = fakeFsGit({ removeCode: 1 });
    const diagnostics: Array<{ message: string }> = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: root,
      onDiagnostic: (e) => diagnostics.push(e),
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-abandoned"));
    await ext.abandonSessionSpec?.("r-d12-abandoned", { reason: "h2_failed" });
    const marker = JSON.parse(readFileSync(markerPath("r-d12-abandoned"), "utf8"));
    expect(marker.state).toBe("abandoned");
    expect(existsSync(`${root}/r-d12-abandoned`)).toBe(true); // preserved, not deleted
    expect(diagnostics.some((d) => d.message.includes("abandoned at"))).toBe(true);
  });

  it("compensation is idempotent: concurrent abandon calls share one compensation run (one `worktree remove`)", async () => {
    const fake = fakeFsGit();
    const ext = createWorktreeExtension({ exec: fake.exec, settings: { enabled: true }, worktreeRoot: root });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-idempotent"));
    await Promise.all([
      ext.abandonSessionSpec?.("r-d12-idempotent", { reason: "h2_failed" }),
      ext.abandonSessionSpec?.("r-d12-idempotent", { reason: "pre_runner_exit" }),
    ]);
    expect(fake.calls.filter((c) => c[0] === "worktree" && c[1] === "remove")).toHaveLength(1);
  });

  it("`worktree add` itself failing compensates and still throws the original error", async () => {
    const fake = fakeFsGit({ addCode: 1 });
    const ext = createWorktreeExtension({ exec: fake.exec, settings: { enabled: true }, worktreeRoot: root });
    await expect(ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-add-fail"))).rejects.toThrow(
      /cannot create/,
    );
    // add never actually created the directory in this fake — compensate finds it already gone
    expect(existsSync(markerPath("r-d12-add-fail"))).toBe(false);
    expect(trackedWorktrees().has(`${root}/r-d12-add-fail`)).toBe(false);
  });

  it("forwards ctx.signal to the `worktree add` exec call", async () => {
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const exec: WorktreeExec = async (_cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") sawSignal = opts.signal;
      if (args[0] === "rev-parse") return ok("/repo\n");
      return ok();
    };
    const ext = createWorktreeExtension({ exec, settings: { enabled: true }, worktreeRoot: root });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-d12-signal"), { signal: controller.signal });
    expect(sawSignal).toBe(controller.signal);
  });
});
