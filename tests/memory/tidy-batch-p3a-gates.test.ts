import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunOutcome, RunSnapshot } from "../../src/core/types.js";
import type { Ident, Loc, TidyManifest, TidyPort } from "../../src/memory/contracts.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { createMemCommand } from "../../src/memory/command.js";
import { lockCreate, observeLoc, openRunDirs, readEpoch } from "../../src/memory/safe-fs.js";
import * as safeFs from "../../src/memory/safe-fs.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { sha256Hex } from "../../src/memory/tidy/snapshot.js";
import { handleMemTidyCommand, type TidyCommandDeps } from "../../src/memory/tidy/command.js";
import {
  formatTidyRevokedMessage,
  handleBatchTidyCommand,
  normalizeBatches,
  parseTidyBatchArgs,
  recoverInterruptedRuns,
} from "../../src/memory/tidy/batch-command.js";
import { DEFAULT_TIDY_BATCH_SETTINGS } from "../../src/memory/tidy/batch-settings.js";
import { applyRestore } from "../../src/memory/tidy/restore.js";
import { leaseRead } from "../../src/memory/tidy/lease.js";
import { recoverRun, runStep, type TxnOperation } from "../../src/memory/tidy/txn.js";

const roots: string[] = [];
function fixture(): { cwd: string; paths: MemoryPaths; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "tidy-p3a-gates-"));
  roots.push(root);
  const cwd = join(root, "project");
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "archive"));
  mkdirSync(join(dir, ".trash"));
  return { cwd, paths, dir };
}
function writeAgent(dir: string, name: string, body = "body"): void {
  writeFileSync(join(dir, name), `---\nsource: agent\nstatus: active\n---\n${body}\n`);
}
function modelContext(
  cwd: string,
  ui: Record<string, unknown>,
  mode: "tui" | "rpc" | "print" = "tui",
): ExtensionCommandContext {
  const model = { provider: "test", id: "model", cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 } };
  return {
    cwd,
    mode,
    hasUI: true,
    model,
    modelRegistry: { find: () => model },
    ui,
  } as unknown as ExtensionCommandContext;
}
function result(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "r-test",
    status: "completed",
    turns: 1,
    durationMs: 1,
    diag: { dispatchMeasure: { payloadBytes: 100 } },
    structuredResult: { files: [], dropped: [] },
    ...overrides,
  } as unknown as RunOutcome;
}
interface FakePort {
  port: TidyPort;
  requests: unknown[];
  aborts: { runId: string; cause?: string }[];
  outcomes: (RunOutcome | "pending")[];
}
function fakePort(outcomes: (RunOutcome | "pending")[]): FakePort {
  const state: FakePort = { requests: [], aborts: [], outcomes, port: undefined as unknown as TidyPort };
  let spawnIndex = 0;
  state.port = {
    spawn: async (request) => {
      state.requests.push(request);
      return { runId: `r-${++spawnIndex}` };
    },
    waitOutcome: async (runId) => {
      const index = Number(runId.slice(2)) - 1;
      const item = state.outcomes[index] ?? "pending";
      return item === "pending" ? { kind: "pending" } : { kind: "settled", outcome: item };
    },
    abort: async (runId, cause) => {
      state.aborts.push({ runId, cause });
      return true;
    },
    snapshot: (_runId: string) => undefined as RunSnapshot | undefined,
  };
  return state;
}
function batchSettings(overrides: Partial<typeof DEFAULT_TIDY_BATCH_SETTINGS> = {}) {
  return { ...DEFAULT_TIDY_BATCH_SETTINGS, ...overrides, totalTimeoutMs: overrides.totalTimeoutMs ?? 120_000 };
}
function normalizeSettings(overrides: Partial<typeof DEFAULT_TIDY_BATCH_SETTINGS> = {}) {
  return {
    coreBytes: 1600,
    topicMaxBytes: 16_384,
    tidy: {
      agentType: "Plan",
      model: "",
      timeoutMs: 30_000,
      maxInputBytes: 49_152,
      maxOutputBytes: 65_536,
      maxCostUsd: 2,
      maxTurns: 4,
      batch: batchSettings(overrides),
    },
  };
}
function uiScript(
  options: {
    select?: (title: string, values: string[]) => string | undefined;
    confirm?: (title: string, message: string) => boolean;
    seenSignals?: AbortSignal[];
  } = {},
) {
  const opts = options.seenSignals ?? [];
  const ui = {
    notify: vi.fn(),
    select: vi.fn(async (title: string, values: string[], dialog?: { signal?: AbortSignal }) => {
      if (dialog?.signal) opts.push(dialog.signal);
      return options.select?.(title, values);
    }),
    confirm: vi.fn(async (title: string, message: string, dialog?: { signal?: AbortSignal }) => {
      if (dialog?.signal) opts.push(dialog.signal);
      return options.confirm?.(title, message) ?? true;
    }),
    custom: async () => undefined,
    editor: async () => undefined,
  };
  return { ui, opts };
}
function txnFixture(): {
  root: string;
  dirs: ReturnType<typeof openRunDirs>;
  id: string;
  cwd: string;
  paths: MemoryPaths;
} {
  const base = mkdtempSync(join(tmpdir(), "tidy-p3a-txn-"));
  roots.push(base);
  const cwd = join(base, "project");
  const paths = { memoryRoot: join(base, "memory"), ccProjectsRoot: join(base, "cc") };
  mkdirSync(cwd, { recursive: true });
  const root = memoryDirFor(cwd, paths);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "archive"));
  mkdirSync(join(root, ".trash"));
  const id = "20260101T000000000Z-1-abcdef";
  return { root, dirs: openRunDirs(root, id, { createArchive: true, createBackup: true }), id, cwd, paths };
}
function live(name: string): Loc {
  return { area: "live", name };
}
function identFrom(value: ReturnType<typeof observeLoc>): Ident {
  if (value.kind !== "file") throw new Error("expected regular file");
  return { dev: value.dev, ino: value.ino, sha: value.sha, size: value.size };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("P3a gate coverage", () => {
  it("blocker: one batch holds the lease across a blocked child and a concurrent second batch is refused", async () => {
    const fx = fixture();
    writeAgent(fx.dir, "topic.md", "topic body");
    let release!: (value: { kind: "settled"; outcome: RunOutcome }) => void;
    const requests: unknown[] = [];
    const blocking: TidyPort = {
      spawn: async (request) => {
        requests.push(request);
        return { runId: "r-blocked" };
      },
      waitOutcome: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      abort: async () => true,
      snapshot: () => undefined,
    };
    const firstUi = uiScript({ select: (_title, values) => values.at(-1) });
    const first = handleBatchTidyCommand("--batch", modelContext(fx.cwd, firstUi.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
      port: blocking,
    });
    for (let attempt = 0; attempt < 300 && requests.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests.length, JSON.stringify(vi.mocked(firstUi.ui.notify).mock.calls)).toBeGreaterThan(0);
    const statusUi = uiScript();
    await handleBatchTidyCommand("--batch --status", modelContext(fx.cwd, statusUi.ui, "rpc"), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(vi.mocked(statusUi.ui.notify).mock.calls.flat().join(" ")).toContain("draining r-blocked");
    const secondUi = uiScript();
    await handleBatchTidyCommand("--batch", modelContext(fx.cwd, secondUi.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
      port: blocking,
    });
    expect(vi.mocked(secondUi.ui.notify).mock.calls.flat().join(" ")).toContain("active tidy run");
    release({ kind: "settled", outcome: result() });
    await first;
    expect(leaseRead(fx.dir)).toBeUndefined();
  });

  it("major: onAfterWrite fires separately for archive/index and normalize writes", async () => {
    const fx = fixture();
    writeFileSync(join(fx.dir, "memory.md"), "- [Old](old.md)\n");
    writeFileSync(join(fx.dir, "old.md"), "---\nstatus: archived\nsource: agent\n---\nold\n");
    let refreshes = 0;
    const archiveUi = uiScript({ select: (_title, values) => values[0], confirm: () => true });
    await handleBatchTidyCommand("--batch --archive-only", modelContext(fx.cwd, archiveUi.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
      onAfterWrite: () => refreshes++,
    });
    expect(refreshes).toBe(2);

    const normalizeFx = fixture();
    writeAgent(normalizeFx.dir, "topic.md", "topic");
    const child = fakePort([
      result({
        structuredResult: {
          files: [{ name: "topic.md", action: "rewrite", content: "new", reason: "clean" }],
          dropped: [],
        },
      }),
    ]);
    const ui = uiScript({ select: (_title, values) => values[0] });
    await handleBatchTidyCommand("--batch", modelContext(normalizeFx.cwd, ui.ui), {
      paths: normalizeFx.paths,
      settings: normalizeSettings(),
      port: child.port,
      onAfterWrite: () => refreshes++,
    });
    // The archive-only phase above proves archive/index refreshes; this
    // second invocation proves normalize apply refreshes as well.
    expect(refreshes).toBe(3);
  });

  it("major: dialog time is excluded from the activity deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fx = fixture();
    writeAgent(fx.dir, "a.md", "a");
    writeAgent(fx.dir, "b.md", "b");
    const child = fakePort([result(), result()]);
    let dialogCalls = 0;
    const ui = uiScript({
      select: (_title, values) => {
        dialogCalls++;
        now.mockReturnValue(dialogCalls * 100_000);
        return values.at(-1);
      },
    });
    await normalizeBatches(
      modelContext(fx.cwd, ui.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings(),
      normalizeSettings().tidy,
      120_000,
      { startedAt: 0, dialogMs: 0, uiMs: 0 },
    );
    expect(child.requests).toHaveLength(2);
    now.mockRestore();
  });

  it("D04 coupling (2026-10-16): a batch prompt names files over topicWarnBytes and demands the split", async () => {
    const fx = fixture();
    const lines = Array.from(
      { length: 300 },
      (_, i) => `pitfall rule ${String(i).padStart(3, "0")} — re-check the caller first`,
    );
    writeAgent(fx.dir, "pitfalls.md", `# Pitfalls\n\n${lines.join("\n")}`);
    writeAgent(fx.dir, "core.md", "# Core\n");
    const child = fakePort([result()]);
    const ui = uiScript({ select: (_title, values) => values.at(-1) });
    await normalizeBatches(
      modelContext(fx.cwd, ui.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings(),
      {
        ...normalizeSettings().tidy,
        coreBytes: 1600,
        topicMaxBytes: 16_384,
        topicWarnBytes: 8192,
      },
      Date.now() + 120_000,
    );
    expect(child.requests).toHaveLength(1);
    const prompt = String((child.requests[0] as { prompt?: string }).prompt ?? "");
    expect(prompt).toContain("8192-byte warn threshold (doctor D04)");
    expect(prompt).toContain("Over the warn threshold now: pitfalls.md (");
    // the primary core is never flagged (D04 is a non-core finding)
    expect(prompt).not.toContain("threshold now: core.md");
  });

  it("major: UI_TOTAL_MS is shared across phase-3 dialogs", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fx = fixture();
    writeAgent(fx.dir, "a.md", "a");
    writeAgent(fx.dir, "b.md", "b");
    writeAgent(fx.dir, "c.md", "c");
    const child = fakePort([result(), result(), result()]);
    let calls = 0;
    const ui = uiScript({
      select: (_title, values) => {
        calls++;
        now.mockReturnValue(calls * 1_800_000);
        return values.at(-1);
      },
    });
    await normalizeBatches(
      modelContext(fx.cwd, ui.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings(),
      normalizeSettings().tidy,
      10_000_000,
      { startedAt: 0, dialogMs: 0, uiMs: 0 },
    );
    expect(child.requests).toHaveLength(3);
    expect(calls).toBe(2);
    now.mockRestore();
  });

  it("G-surface/G-dialog: completion surface and every interactive dialog carries an abort signal", async () => {
    const fx = fixture();
    const command = createMemCommand({ paths: fx.paths });
    expect(command.getArgumentCompletions("tidy --b").map((x) => x.value)).toContain("tidy --batch");
    expect(command.getArgumentCompletions("tidy --batch --s").map((x) => x.value)).toContain("tidy --batch --status");
    const seenSignals: AbortSignal[] = [];
    writeFileSync(join(fx.dir, "old.md"), "---\nstatus: archived\nsource: agent\n---\nold\n");
    const script = uiScript({
      seenSignals,
      select: (_title, values) => values[0],
      confirm: () => true,
    });
    await handleBatchTidyCommand("--batch --archive-only", modelContext(fx.cwd, script.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(seenSignals.length).toBeGreaterThanOrEqual(2);
    expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("G-surface: pure batch RPC is refused before dialogs or spawn", async () => {
    const fx = fixture();
    const script = uiScript();
    await handleBatchTidyCommand("--batch", modelContext(fx.cwd, script.ui, "rpc"), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(vi.mocked(script.ui.select)).not.toHaveBeenCalled();
    expect(vi.mocked(script.ui.notify).mock.calls.flat().join(" ")).toContain("needs the terminal UI");
  });
  it.each(["rpc", "print"] as const)("G-breaklock: %s is refused before touching disk", async (mode) => {
    const fx = fixture();
    const holder = { pid: 999_999, host: "other-host", token: "holder", at: Date.now() };
    lockCreate(fx.dir, holder);
    const before = readFileSync(join(fx.dir, ".lock"), "utf8");
    const script = uiScript();
    await handleBatchTidyCommand("--break-lock", modelContext(fx.cwd, script.ui, mode), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(readFileSync(join(fx.dir, ".lock"), "utf8")).toBe(before);
    expect(vi.mocked(script.ui.confirm)).not.toHaveBeenCalled();
  });

  it("G-breaklock: displays holder, requires confirmation, cancel is zero-change, then bumps epoch before lockBreak", async () => {
    const fx = fixture();
    lockCreate(fx.dir, { pid: 999_999, host: "other-host", token: "holder", at: Date.now() });
    const cancel = uiScript({ confirm: () => false });
    await handleBatchTidyCommand("--break-lock", modelContext(fx.cwd, cancel.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(vi.mocked(cancel.ui.confirm).mock.calls[0]?.[1]).toContain("other-host");
    expect(readEpoch(fx.dir)).toBe(0);
    expect(readFileSync(join(fx.dir, ".lock"), "utf8")).toContain("holder");

    const order: string[] = [];
    const originalBump = safeFs.bumpEpoch;
    const originalBreak = safeFs.lockBreak;
    vi.spyOn(safeFs, "bumpEpoch").mockImplementation((...args) => {
      order.push("epoch");
      return originalBump(...args);
    });
    vi.spyOn(safeFs, "lockBreak").mockImplementation((...args) => {
      order.push("lock");
      return originalBreak(...args);
    });
    const proceed = uiScript({ confirm: () => true });
    await handleBatchTidyCommand("--break-lock", modelContext(fx.cwd, proceed.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(order).toEqual(["epoch", "lock"]);
    expect(readEpoch(fx.dir)).toBe(1);
    expect(vi.mocked(proceed.ui.notify).mock.calls.at(-1)?.[0]).toContain("owner epoch 0 → 1");
  });

  it("G-breaklock: automatic batch recovery never calls lockBreak for an unprovable busy lock", async () => {
    const fx = fixture();
    lockCreate(fx.dir, { pid: process.pid, host: "other-host", token: "busy", at: Date.now() });
    const spy = vi.spyOn(safeFs, "lockBreak");
    await expect(
      handleBatchTidyCommand("--batch --archive-only", modelContext(fx.cwd, uiScript().ui), {
        paths: fx.paths,
        settings: normalizeSettings(),
      }),
    ).rejects.toThrow(/busy/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("G-breaklock: an old owner gets the exact revocation text on its next mutating step", () => {
    expect(formatTidyRevokedMessage("20260101T000000000Z-1-abcdef", 3, 4)).toMatch(
      /^tidy run 20260101T000000000Z-1-abcdef stopped: ownership was revoked by \/mem tidy --break-lock \(epoch 3 → 4\).*Nothing more was written by this run; its journal will be recovered by the next \/mem tidy --batch\.$/u,
    );
  });

  it("G-abort/G-bounds: pending child is aborted and no later batch is spawned", async () => {
    const fx = fixture();
    writeAgent(fx.dir, "a.md", "a".repeat(100));
    writeAgent(fx.dir, "b.md", "b".repeat(100));
    const child = fakePort(["pending"]);
    const script = uiScript();
    await normalizeBatches(
      modelContext(fx.cwd, script.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings(),
      normalizeSettings().tidy,
      Date.now() + 120_000,
    );
    expect(child.requests).toHaveLength(1);
    expect(child.aborts).toEqual([{ runId: "r-1", cause: "timeout" }]);
  });

  it("G-cost: reservation stops dispatch before exceeding the bounded cap and reports it", async () => {
    const fx = fixture();
    writeAgent(fx.dir, "a.md", "a".repeat(100));
    const child = fakePort([result()]);
    const script = uiScript();
    await normalizeBatches(
      modelContext(fx.cwd, script.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings({ maxTotalCostUsd: 0.000001 }),
      normalizeSettings().tidy,
      Date.now() + 120_000,
    );
    expect(child.requests).toHaveLength(0);
    expect(vi.mocked(script.ui.notify).mock.calls.flat().join(" ")).toContain("bounded cost cap");
  });

  it("G-bounds: maxModelRuns limits dispatch and an oversized proposal is discarded", async () => {
    const fx = fixture();
    writeAgent(fx.dir, "a.md", "a".repeat(100));
    writeAgent(fx.dir, "b.md", "b".repeat(100));
    const child = fakePort([
      result({
        structuredResult: {
          files: [{ name: "a.md", action: "rewrite", content: "x".repeat(100_000), reason: "too large" }],
          dropped: [],
        },
      }),
      result(),
    ]);
    const script = uiScript({ select: (_title, values) => values.at(-1) });
    await normalizeBatches(
      modelContext(fx.cwd, script.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings({ maxModelRuns: 1 }),
      normalizeSettings().tidy,
      Date.now() + 120_000,
    );
    expect(child.requests).toHaveLength(1);
    expect(vi.mocked(script.ui.notify).mock.calls.flat().join(" ")).toContain("invalid proposal");
  });

  it("G-bounds: totalTimeoutMs leaves less than one minute and dispatches nothing", async () => {
    const fx = fixture();
    writeAgent(fx.dir, "a.md", "a".repeat(100));
    const child = fakePort([result()]);
    await normalizeBatches(
      modelContext(fx.cwd, uiScript().ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings({ totalTimeoutMs: 59_999 }),
      normalizeSettings().tidy,
      Date.now() + 59_999,
    );
    expect(child.requests).toHaveLength(0);
  });

  it("G-index-skip: a CAS-skipped archive leaves MEMORY.md and ARCHIVE.md untouched", async () => {
    const fx = fixture();
    writeFileSync(join(fx.dir, "memory.md"), "- [Old](old.md)\n");
    writeFileSync(join(fx.dir, "old.md"), "---\nstatus: archived\n---\nold\n");
    const script = uiScript({
      select: (_title, values) => values[0],
      confirm: (_title, message) => {
        if (message.includes("Move 1 files")) writeFileSync(join(fx.dir, "old.md"), "changed after review\n");
        return true;
      },
    });
    await handleBatchTidyCommand("--batch --archive-only", modelContext(fx.cwd, script.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(readFileSync(join(fx.dir, "memory.md"), "utf8")).toBe("- [Old](old.md)\n");
    expect(readFileSync(join(fx.dir, "old.md"), "utf8")).toContain("changed after review");
    expect(() => readFileSync(join(fx.dir, "archive", "ARCHIVE.md"), "utf8")).toThrow();
  });

  it("§4.5 input-budget failure re-splits and never retries the same input size", async () => {
    const fx = fixture();
    writeAgent(fx.dir, "topic-a.md", "a".repeat(100));
    writeAgent(fx.dir, "topic-b.md", "b".repeat(100));
    const child = fakePort([
      result({
        status: "failed",
        error: { kind: "config", message: "input-budget: measured 100 tokens > 1", retryable: false } as never,
      }),
      result(),
      result(),
    ]);
    const script = uiScript({ select: (_title, values) => values.at(-1) });
    await normalizeBatches(
      modelContext(fx.cwd, script.ui),
      (await import("../../src/memory/tidy/snapshot.js")).snapshotMemoryDir(fx.cwd, { paths: fx.paths }),
      child.port,
      fx.cwd,
      batchSettings(),
      normalizeSettings().tidy,
      Date.now() + 120_000,
    );
    expect(child.requests.length).toBeGreaterThanOrEqual(2);
    const budgets = child.requests.map(
      (request) => (request as { inputBudget: { maxInputTokens: number } }).inputBudget.maxInputTokens,
    );
    expect(budgets[1]).toBeLessThan(budgets[0]);
  });

  it("recoverRun wiring recovers an interrupted run before new work and invalid manifests are rejected", async () => {
    const { root, dirs, id } = txnFixture();
    writeFileSync(join(root, "a.md"), "a");
    const before = identFrom(observeLoc(dirs, live("a.md")));
    const operation: TxnOperation = {
      seq: 1,
      phase: "archive",
      op: { prim: "MOVE", src: live("a.md"), dst: { area: "archive", name: "a.md" }, obj: before },
    };
    expect(() =>
      runStep({
        dirs,
        id,
        ops: [operation],
        hooks: {
          onEvent: (event) => {
            if (event.ev === "intent") throw new Error("crash");
          },
        },
      }),
    ).toThrow();
    expect((await recoverInterruptedRuns(root)).length).toBe(1);
    expect(recoverRun(dirs, id).state).toMatch(/recovered|complete/);

    const fx = fixture();
    const badId = "20260101T000000000Z-1-abcdef";
    mkdirSync(join(fx.dir, ".backup", badId), { recursive: true });
    writeFileSync(
      join(fx.dir, ".backup", badId, "manifest.json"),
      JSON.stringify({ v: 2, id: badId, kind: "batch", createdAt: "now", events: [{ ev: "invalid" }] }),
    );
    const script = uiScript();
    await handleBatchTidyCommand("--batch --archive-only", modelContext(fx.cwd, script.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    const invalidMessage = vi.mocked(script.ui.notify).mock.calls.flat().join(" ");
    expect(invalidMessage).toContain("invalid manifest");
    expect(invalidMessage).toContain("events[0].ev");
  });

  it("G-e2e: crash after REPLACE staged content, recover, then restore returns original bytes", async () => {
    const { root, dirs, id, cwd, paths } = txnFixture();
    writeFileSync(join(root, "a.md"), "original");
    const before = identFrom(observeLoc(dirs, live("a.md")));
    const tmpContent: Loc = { area: "tmp", within: "live", name: ".pt-abcdef01-1-c.tmp" };
    const backup: Loc = { area: "backup", name: "s1-1-live--a.md" };
    const operation: TxnOperation = {
      seq: 1,
      phase: "normalize",
      op: {
        prim: "REPLACE",
        target: live("a.md"),
        before,
        afterSha: sha256Hex("new"),
        backup,
        tmpBackup: { area: "tmp", within: "backup", name: ".pt-abcdef01-1-b.tmp" },
        tmpContent,
      },
    };
    expect(() =>
      runStep({
        dirs,
        id,
        ops: [operation],
        contents: new Map([["tmp:live:.pt-abcdef01-1-c.tmp", "new"]]),
        hooks: {
          afterAction: () => {
            throw new Error("kill after staged");
          },
        },
      }),
    ).toThrow();
    const recovered = recoverRun(dirs, id);
    expect(recovered.state).toMatch(/recovered|complete/);
    const restored = await applyRestore(cwd, id, new Map([["a.md", "restore"]]), paths);
    expect(restored.restored).toContain("a.md");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("original");
  });

  it("G-e2e: --legacy restore routes through /mem command and refreshes injection", async () => {
    const fx = fixture();
    const id = "20260101T000000000Z-1-abcdef";
    mkdirSync(join(fx.dir, ".backup", id), { recursive: true });
    writeFileSync(join(fx.dir, ".backup", id, "old.md"), "old bytes");
    const manifest: TidyManifest = {
      v: 1,
      id,
      kind: "tidy",
      createdAt: "now",
      entries: [{ name: "old.md", op: "delete", backupFile: "old.md", beforeSha256: "0".repeat(64) }],
    };
    writeFileSync(join(fx.dir, ".backup", id, "manifest.json"), JSON.stringify(manifest));
    const script = uiScript({ confirm: () => true });
    let refreshes = 0;
    const deps: TidyCommandDeps = {
      isChildSession: false,
      getTidyPort: () => fakePort([]).port,
      paths: fx.paths,
      settings: () => DEFAULT_SETTINGS.memory,
      onAfterWrite: () => refreshes++,
    };
    await handleMemTidyCommand("restore", `${id} --legacy`, modelContext(fx.cwd, script.ui), deps);
    expect(readFileSync(join(fx.dir, "old.md"), "utf8"), JSON.stringify(vi.mocked(script.ui.notify).mock.calls)).toBe(
      "old bytes",
    );
    expect(refreshes).toBe(1);
  });

  it("--triage is explicit rather than silently ignored", async () => {
    const fx = fixture();
    const script = uiScript();
    await handleBatchTidyCommand("--batch --triage", modelContext(fx.cwd, script.ui), {
      paths: fx.paths,
      settings: normalizeSettings(),
    });
    expect(vi.mocked(script.ui.notify).mock.calls.flat().join(" ")).toContain("P3b");
  });
});

describe("bounded viewer contract", () => {
  it("uses a deadline-bounded custom UI and exposes a close-capable component", async () => {
    const { showBoundedViewer } = await import("../../src/memory/tidy/ui/bounded-viewer.js");
    let factory: ((...args: never[]) => unknown) | undefined;
    const ui = {
      custom: async (value: typeof factory) => {
        factory = value as typeof factory;
        return undefined;
      },
    };
    await showBoundedViewer(ui, "diff", "line 1\nline 2", { maxMs: 25 });
    expect(factory).toBeDefined();
  });
});
