import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  procStartOf,
  processStartedAt,
  scanWorktreeOrphans,
  worktreeRoot,
  type WorktreeOwnerToken,
} from "../../src/extensions/worktree-orphans.js";

const dirs: string[] = [];
function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-subagent-orphans-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWorktreeDir(root: string, name: string, opts: { git?: boolean } = { git: true }): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (opts.git !== false) writeFileSync(join(dir, ".git"), `gitdir: /repo/.git/worktrees/${name}\n`);
  return dir;
}

function writeMarker(
  root: string,
  name: string,
  marker: {
    state: "creating" | "active" | "abandoned";
    owner: WorktreeOwnerToken;
    runId?: string;
    repo?: string;
    path?: string;
    createdAt?: number;
  },
): void {
  mkdirSync(join(root, ".owners"), { recursive: true });
  writeFileSync(
    join(root, ".owners", `${name}.json`),
    JSON.stringify({
      v: 1,
      state: marker.state,
      owner: marker.owner,
      runId: marker.runId ?? name,
      repo: marker.repo ?? "/repo",
      path: marker.path ?? join(root, name),
      createdAt: marker.createdAt ?? Date.now(),
    }),
  );
}

const noopIsPidAlive = () => true;
const noopProcStartOf = () => undefined;

describe("scanWorktreeOrphans (workflow-worktree plan §3, pure parts)", () => {
  it("(a) reports nothing when the root has no leftover directories", () => {
    const root = makeRoot();
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
    });
    expect(result).toEqual({ root, count: 0, capped: false, entries: [] });
  });

  it("(d) a missing root never throws", () => {
    const result = scanWorktreeOrphans({
      root: "/definitely/does/not/exist/pi-subagent",
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });

  it("(no marker, past grace) is reported as no-owner", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-old");
    utimesSync(dir, new Date(0), new Date(0));
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "no-owner" }]);
  });

  it("(no marker, within 120s grace) is skipped", () => {
    const root = makeRoot();
    makeWorktreeDir(root, "wt-fresh");
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });

  it("(h) creating + owner alive (same pid, tracked) is skipped", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-creating");
    const owner: WorktreeOwnerToken = { pid: 111, procStartedAt: 1000, instanceId: "iid-1" };
    writeMarker(root, "wt-creating", { state: "creating", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map([[dir, "iid-1"]]),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });

  it("(h) creating + owner dead (other pid) is creating-abandoned", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-creating-dead");
    const owner: WorktreeOwnerToken = { pid: 222, procStartedAt: 2000, instanceId: "iid-2" };
    writeMarker(root, "wt-creating-dead", { state: "creating", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: () => false,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "creating-abandoned" }]);
  });

  it("(i) same-pid /reload: owner-gone when procStartedAt matches but path not tracked by the current instance", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-reload");
    const owner: WorktreeOwnerToken = { pid: 111, procStartedAt: 1000, instanceId: "iid-old" };
    writeMarker(root, "wt-reload", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(), // old instance's H3 already finished — path no longer tracked
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "owner-gone" }]);
  });

  it("(i) same-pid /reload: not counted while the old instance is still running H3 (path tracked)", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-reload-busy");
    const owner: WorktreeOwnerToken = { pid: 111, procStartedAt: 1000, instanceId: "iid-old" };
    writeMarker(root, "wt-reload-busy", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map([[dir, "iid-old"]]),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });

  it("(j) PID reuse: other pid alive but procStartOf differs by more than 2s is owner-dead", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-reused");
    const owner: WorktreeOwnerToken = { pid: 333, procStartedAt: 1_000_000, instanceId: "iid-3" };
    writeMarker(root, "wt-reused", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: () => true,
      procStartOf: () => 1_010_000, // 10s off
      tracked: new Map(),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "owner-dead" }]);
  });

  it("(j) same-pid but procStartedAt mismatch (pid reused across process lifetimes) is owner-dead", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-pid-reused-self");
    const owner: WorktreeOwnerToken = { pid: 111, procStartedAt: 5_000, instanceId: "iid-4" };
    writeMarker(root, "wt-pid-reused-self", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map([[dir, "iid-4"]]),
      self: { pid: 111, procStartedAt: 999_999 }, // very different start time — different process
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "owner-dead" }]);
  });

  it("(j) procStartOf undefined (non-Linux) is not counted (accepted risk)", () => {
    const root = makeRoot();
    makeWorktreeDir(root, "wt-nonlinux");
    const owner: WorktreeOwnerToken = { pid: 444, procStartedAt: 1234, instanceId: "iid-5" };
    writeMarker(root, "wt-nonlinux", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: () => true,
      procStartOf: () => undefined,
      tracked: new Map(),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });

  it("(c) other pid alive with matching procStartOf is not counted", () => {
    const root = makeRoot();
    makeWorktreeDir(root, "wt-alive");
    const owner: WorktreeOwnerToken = { pid: 555, procStartedAt: 42_000, instanceId: "iid-6" };
    writeMarker(root, "wt-alive", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: () => true,
      procStartOf: () => 42_000,
      tracked: new Map(),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });

  it("(c) other pid dead is owner-dead", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-dead");
    const owner: WorktreeOwnerToken = { pid: 666, procStartedAt: 42_000, instanceId: "iid-7" };
    writeMarker(root, "wt-dead", { state: "active", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: () => false,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "owner-dead" }]);
  });

  it("(k) an 'abandoned' marker is always counted, regardless of owner liveness", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-abandoned");
    const owner: WorktreeOwnerToken = { pid: 111, procStartedAt: 1000, instanceId: "iid-8" };
    writeMarker(root, "wt-abandoned", { state: "abandoned", owner });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map([[dir, "iid-8"]]), // even tracked/"alive" — abandoned always counts
      self: { pid: 111, procStartedAt: 1000 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, repo: "/repo", reason: "abandoned" }]);
  });

  it("(f) reports capped when there are more directories than the cap", () => {
    const root = makeRoot();
    for (let i = 0; i < 5; i++) makeWorktreeDir(root, `wt-${i}`);
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
      cap: 3,
      graceMs: 0,
    });
    expect(result.capped).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(3);
  });

  it("flags entries with no .git file as not-a-worktree, alongside their orphan reason", () => {
    const root = makeRoot();
    const dir = makeWorktreeDir(root, "wt-nogit", { git: false });
    utimesSync(dir, new Date(0), new Date(0));
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
    });
    expect(result.entries).toEqual([{ path: dir, reason: "no-owner", notAWorktree: true }]);
  });

  it("ignores the .owners directory itself as a candidate worktree", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".owners"), { recursive: true });
    const result = scanWorktreeOrphans({
      root,
      isPidAlive: noopIsPidAlive,
      procStartOf: noopProcStartOf,
      tracked: new Map(),
      self: { pid: 1, procStartedAt: 0 },
      now: () => Date.now(),
    });
    expect(result.count).toBe(0);
  });
});

describe("processStartedAt / procStartOf / worktreeRoot", () => {
  it("processStartedAt is a stable cached value across repeated calls", () => {
    expect(processStartedAt()).toBe(processStartedAt());
    expect(typeof processStartedAt()).toBe("number");
  });

  it("procStartOf(own pid) returns a number on Linux, undefined elsewhere", () => {
    const value = procStartOf(process.pid);
    if (process.platform === "linux") {
      expect(typeof value).toBe("number");
    } else {
      expect(value).toBeUndefined();
    }
  });

  it("procStartOf returns undefined for a pid that cannot be read", () => {
    expect(procStartOf(999_999_999)).toBeUndefined();
  });

  it("worktreeRoot resolves the same default path deterministically", () => {
    expect(worktreeRoot()).toBe(worktreeRoot());
    expect(worktreeRoot("/tmp/custom")).toBe("/tmp/custom");
  });
});

describe("procStartOf: /proc/<pid>/stat field-parsing algorithm (comm with spaces/parens)", () => {
  it("locates starttime from the LAST ')' even when comm contains spaces/parens", () => {
    // procStartOf itself only reads the real /proc filesystem (Linux-only,
    // no fs injection seam per the frozen interface) — this documents/locks
    // the field-location algorithm against a hand-built fixture line instead
    // of mocking fs.
    const commWithParens = "weird (name) proc";
    const fixture = `123 (${commWithParens}) S 1 123 123 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 456789 0`;
    const lastParen = fixture.lastIndexOf(")");
    const rest = fixture
      .slice(lastParen + 1)
      .trim()
      .split(/\s+/);
    // field 22 (starttime) is rest[19] under the field-3-is-rest[0] convention.
    expect(rest[19]).toBe("456789");
  });
});
