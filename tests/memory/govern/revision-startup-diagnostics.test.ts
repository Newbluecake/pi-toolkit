import * as fs from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { startupFixture, startupTree } from "./revision-startup-helpers.js";
import { createMemoryOwner } from "../../../src/memory/scopes/owner.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import {
  runRevisionStartupDiagnostics,
  REVISION_STARTUP_SAMPLE_LIMIT,
  REVISION_STARTUP_BUDGET_MS,
} from "../../../src/memory/govern/revision-startup-diagnostics.js";
import type { RevisionStartupDiagnosticsInput } from "../../../src/memory/govern/revision-startup-diagnostics.js";
import type { RevisionAuditPort, RevisionRecoveryDiagnostic } from "../../../src/memory/jev/contracts.js";
import * as auditModule from "../../../src/memory/govern/revision-audit.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import * as lockModule from "../../../src/memory/lock.js";

const closes: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0)) close();
});
function inputFor(dir: string) {
  const manager = SessionManager.inMemory("/");
  const ctx = { mode: "tui", hasUI: true, sessionManager: manager };
  const lifecycle = new AbortController();
  const state = { current: true, gate: true, locked: false };
  const runtime = createMemoryOwner({
    manager,
    append: vi.fn(),
    enabled: { session: true, hub: false },
    child: false,
    sessionEpoch: 1,
    branchGen: 0,
    reason: "startup",
    context: () => ctx as unknown as ExtensionContext,
    isCurrent: () => state.current,
    locked: () => state.locked,
    commandContext: () => ({ mode: "tui", hasUI: true, isWeb: false }),
    remote: () => undefined,
    gate: { check: () => ({ ok: true }) },
  });
  if (!runtime) throw Error("actual owner missing");
  closes.push(() => runtime.dispose());
  const input: RevisionStartupDiagnosticsInput = {
    memoryDir: dir,
    actualContext: ctx,
    settings: { ...DEFAULT_MEMORY_SETTINGS, scopes: { session: true, hub: false } },
    domain: "plain",
    isChildSession: false,
    scopes: { current: () => (runtime.current() ? runtime : undefined) },
    gate: { capture() {}, check: () => (state.gate ? { ok: true } : { ok: false, reason: "locked" }) },
    signal: lifecycle.signal,
    isCurrent: () => state.current,
    warn: vi.fn(),
  };
  return { input, manager, ctx, lifecycle, state, runtime };
}
function observeScan(after?: () => void, rows?: readonly RevisionRecoveryDiagnostic[]) {
  const create = auditModule.createRevisionAuditPort;
  const scan = vi.fn<RevisionAuditPort["scanPendingLocked"]>();
  const factory = vi.spyOn(auditModule, "createRevisionAuditPort").mockImplementation((dir, deps) => {
    const port = create(dir, deps);
    scan.mockImplementation(() => {
      expect(fs.existsSync(join(dir, ".lock"))).toBe(true);
      const result = rows ?? port.scanPendingLocked();
      after?.();
      return result;
    });
    return { ...port, scanPendingLocked: scan };
  });
  return { scan, factory };
}

it.each([
  "disabled",
  "child",
  "rpc",
  "web",
  "secure",
  "locked",
  "no-owner",
  "scopes-off",
  "wrong-manager",
  "host-stale",
  "owner-stale",
  "aborted",
  "owner-aborted",
  "no-ui",
  "no-mode",
  "no-warning",
  "gate",
  "capability",
])("%s: identity gate is BEFORE directory discovery/lock/C scan", async (mode) => {
  const f = await startupFixture(["marker-missing"]);
  const h = inputFor(f.dir),
    input = h.input;
  switch (mode) {
    case "disabled":
      Object.assign(input.settings, { enabled: false });
      break;
    case "child":
      Object.assign(input, { isChildSession: true });
      break;
    case "rpc":
      Object.assign(h.ctx, { mode: "rpc" });
      break;
    case "web":
      Object.assign(h.ctx, { webInvocation: true });
      break;
    case "secure":
    case "locked":
      Object.assign(input, { domain: mode });
      break;
    case "no-owner":
      Object.assign(input, { scopes: undefined });
      break;
    case "scopes-off":
      Object.assign(input.settings, { scopes: { session: false, hub: false } });
      break;
    case "wrong-manager":
      Object.assign(h.ctx, { sessionManager: SessionManager.inMemory("/") });
      break;
    case "host-stale":
      h.state.current = false;
      break;
    case "owner-stale":
      h.manager.newSession();
      break;
    case "aborted":
      h.lifecycle.abort();
      break;
    case "owner-aborted":
      h.runtime.dispose();
      break;
    case "no-ui":
      Object.assign(h.ctx, { hasUI: false });
      break;
    case "no-mode":
      Object.assign(h.ctx, { mode: undefined });
      break;
    case "no-warning":
      Object.assign(input, { warn: undefined });
      break;
    case "gate":
      h.state.gate = false;
      break;
    case "capability":
      h.state.locked = true;
      break;
  }
  const tree = startupTree(f.dir);
  const discovery = vi.spyOn(safeFs, "canonicalDir");
  const lock = vi.spyOn(lockModule, "withMemoryDirLock");
  const { factory, scan } = observeScan();
  expect(await runRevisionStartupDiagnostics(input)).toEqual({ kind: "skipped" });
  expect(discovery).not.toHaveBeenCalled();
  expect(lock).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  if (input.warn) expect(input.warn).not.toHaveBeenCalled();
  expect(startupTree(f.dir)).toEqual(tree);
});

it("one original-lock scan: prepared/proposed keep C skipped, missing marker stays unknown, bounded safe warning", async () => {
  const f = await startupFixture([
    "prepared",
    "proposed",
    "marker-missing",
    "unknown",
    "committed",
    "corrupt",
    "missing",
  ]);
  const h = inputFor(f.dir),
    before = startupTree(f.dir);
  const { scan } = observeScan();
  const result = await runRevisionStartupDiagnostics(h.input);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    kind: "scanned",
    warned: true,
    summary: {
      counts: {
        skipped: 2,
        "commit-unknown": 2,
        committed: 1,
        corrupted: 2,
        unavailable: 0,
      },
      samples: expect.arrayContaining([{ state: "commit-unknown", actionId: f.records[2]!.frozen.actionId }]),
    },
  });
  expect(h.input.warn).toHaveBeenCalledTimes(1);
  const output = JSON.stringify(result) + String(vi.mocked(h.input.warn!).mock.calls[0]?.[0]);
  for (const secret of [
    f.dir,
    "PRIVATE_TEST_BODY",
    "SECRET_REASON",
    "rules.001",
    "unexpected-current",
    "expected-after-without-commit-marker",
  ])
    expect(output).not.toContain(secret);
  expect(startupTree(f.dir)).toEqual(before);
});

it.each(["absent", "no-blocks", "files", "held"])("%s directory is never created or scanned", async (mode) => {
  const f = await startupFixture();
  const dir = mode === "absent" ? join(f.dir, "absent") : f.dir;
  if (mode === "no-blocks" || mode === "files") fs.rmSync(f.blocks, { recursive: true });
  if (mode === "files") fs.writeFileSync(join(f.dir, "core.md"), "# Legacy\n");
  if (mode === "held") fs.writeFileSync(join(f.dir, ".blocks-hold"), "hold");
  const tree = startupTree(f.dir),
    h = inputFor(dir),
    { scan, factory } = observeScan();
  expect(await runRevisionStartupDiagnostics(h.input)).toEqual({ kind: "skipped" });
  expect(scan).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(startupTree(f.dir)).toEqual(tree);
});

it.each(["empty", "completed", "no-commit"])(
  "healthy %s scan is silent and does not create any namespace",
  async (mode) => {
    const f = await startupFixture(mode === "empty" ? [] : [mode === "completed" ? "committed" : "prepared"]);
    const tree = startupTree(f.dir),
      h = inputFor(f.dir),
      { scan } = observeScan();
    expect(await runRevisionStartupDiagnostics(h.input)).toMatchObject({ kind: "scanned", warned: false });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(h.input.warn).not.toHaveBeenCalled();
    expect(startupTree(f.dir)).toEqual(tree);
  },
);

it("live busy lock: one acquisition attempt, zero scan, no sleep/retry/delivery", async () => {
  const f = await startupFixture(["unknown"]),
    h = inputFor(f.dir);
  expect(safeFs.lockCreate(f.dir, { pid: process.pid, host: "foreign-test-host", token: "held", at: 0 })).toBe(true);
  const tree = startupTree(f.dir),
    lockBytes = fs.readFileSync(join(f.dir, ".lock"));
  const acquire = vi.spyOn(safeFs, "lockCreate"),
    timer = vi.spyOn(globalThis, "setTimeout");
  const { scan } = observeScan();
  expect(await runRevisionStartupDiagnostics(h.input)).toEqual({ kind: "skipped" });
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(timer).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(h.input.warn).not.toHaveBeenCalled();
  expect(fs.readFileSync(join(f.dir, ".lock"))).toEqual(lockBytes);
  expect(startupTree(f.dir)).toEqual(tree);
});

it.each([
  "before-lock",
  "inside-lock",
  "during-scan",
  "after-lock",
  "gate-after-scan",
  "deadline-before-lock",
  "deadline-during-scan",
])("%s revocation/deadline never delivers", async (when) => {
  const f = await startupFixture(["marker-missing"]),
    h = inputFor(f.dir),
    tree = startupTree(f.dir);
  let tick = 0;
  vi.spyOn(performance, "now").mockImplementation(() => tick);
  const expire = () => {
    tick = REVISION_STARTUP_BUDGET_MS;
  };
  const { scan } = observeScan(() => {
    if (when === "during-scan") h.lifecycle.abort();
    if (when === "gate-after-scan") h.state.gate = false;
    if (when === "deadline-during-scan") expire();
  });
  const lock = lockModule.withMemoryDirLock;
  vi.spyOn(lockModule, "withMemoryDirLock").mockImplementation(async (dir, body, opts) => {
    if (when === "before-lock") {
      h.lifecycle.abort();
      return undefined;
    }
    if (when === "deadline-before-lock") {
      expire();
      return undefined;
    }
    const r = await lock(
      dir,
      () => {
        if (when === "inside-lock") h.runtime.dispose();
        return body();
      },
      opts,
    );
    if (when === "after-lock") h.lifecycle.abort();
    return r;
  });
  expect(await runRevisionStartupDiagnostics(h.input)).toEqual({ kind: "skipped" });
  expect(scan).toHaveBeenCalledTimes(["before-lock", "inside-lock", "deadline-before-lock"].includes(when) ? 0 : 1);
  expect(h.input.warn).not.toHaveBeenCalled();
  expect(startupTree(f.dir)).toEqual(tree);
});

it("closed counts and samples are capped; never read reason/batchId even when scanner rows carry them", async () => {
  const f = await startupFixture(),
    h = inputFor(f.dir);
  const rows: RevisionRecoveryDiagnostic[] = Array.from({ length: 300 }, (_, i) => ({
    kind: "action",
    batchId: "private-batch",
    actionId: i.toString(16).padStart(64, "0"),
    state: "commit-unknown",
    get reason(): string {
      throw Error("must not access arbitrary reason");
    },
  }));
  const { scan } = observeScan(undefined, rows);
  const tree = startupTree(f.dir),
    result = await runRevisionStartupDiagnostics(h.input);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    kind: "scanned",
    warned: true,
    summary: { counts: { "commit-unknown": 256, unavailable: 1 }, incomplete: true, omitted: null },
  });
  if (result.kind !== "scanned") throw Error("expected bounded summary");
  expect(result.summary.samples).toHaveLength(REVISION_STARTUP_SAMPLE_LIMIT);
  expect(Object.keys(result.summary.counts)).toEqual([
    "prepared",
    "proposed",
    "committed",
    "skipped",
    "failed",
    "commit-unknown",
    "restored",
    "corrupted",
    "unavailable",
  ]);
  expect(Buffer.byteLength(vi.mocked(h.input.warn!).mock.calls[0]![0])).toBeLessThan(2048);
  expect(JSON.stringify(result)).not.toContain("private-batch");
  expect(startupTree(f.dir)).toEqual(tree);
});

it("throwing warning channel is not persisted or retried", async () => {
  const f = await startupFixture(["unknown"]),
    h = inputFor(f.dir),
    tree = startupTree(f.dir);
  const warn = vi.fn(() => {
    throw Error("UI unavailable /private");
  });
  expect(await runRevisionStartupDiagnostics({ ...h.input, warn })).toMatchObject({ kind: "scanned", warned: false });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(startupTree(f.dir)).toEqual(tree);
});

it.each(["wide-permissions", "namespace-symlink"])(
  "C incomplete %s is a fixed unavailable warning, never raw reason or healthy-empty",
  async (mode) => {
    const f = await startupFixture(["prepared"]),
      h = inputFor(f.dir);
    const revisions = join(f.blocks, ".jev", "revisions");
    if (mode === "wide-permissions") fs.chmodSync(revisions, 0o755);
    else {
      fs.renameSync(revisions, `${revisions}-original`);
      fs.symlinkSync(`${revisions}-original`, revisions);
    }
    const tree = startupTree(f.dir),
      { scan } = observeScan();
    const result = await runRevisionStartupDiagnostics(h.input);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "scanned",
      warned: true,
      summary: { counts: { unavailable: 1 }, samples: [] },
    });
    expect(h.input.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.input.warn!).mock.calls[0]![0]).not.toContain(f.dir);
    expect(vi.mocked(h.input.warn!).mock.calls[0]![0]).not.toContain("revision scan");
    expect(startupTree(f.dir)).toEqual(tree);
  },
);

it("gate callback returning ok cannot hide synchronous owner revocation before discovery", async () => {
  const f = await startupFixture(["unknown"]),
    h = inputFor(f.dir),
    tree = startupTree(f.dir);
  const gate = {
    capture() {},
    check() {
      h.runtime.dispose();
      return { ok: true as const };
    },
  };
  const discovery = vi.spyOn(safeFs, "canonicalDir"),
    { scan } = observeScan();
  expect(await runRevisionStartupDiagnostics({ ...h.input, gate })).toEqual({ kind: "skipped" });
  expect(discovery).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(h.input.warn).not.toHaveBeenCalled();
  expect(startupTree(f.dir)).toEqual(tree);
});
