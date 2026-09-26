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
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-report-dirty" }]);
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
    expect(calls).toEqual([{ state: "committed", branch: "pi-agent-r-remove-fail" }]);
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
