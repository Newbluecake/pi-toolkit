import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleBatchTidyCommand, parseTidyBatchArgs } from "../../src/memory/tidy/batch-command.js";
import { DEFAULT_TIDY_BATCH_SETTINGS } from "../../src/memory/tidy/batch-settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";

function settings() {
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
      batch: { ...DEFAULT_TIDY_BATCH_SETTINGS },
    },
  };
}
function context(cwd: string, notifications: string[]): ExtensionCommandContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
}
const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): { cwd: string; paths: MemoryPaths; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "tidy-p3a-"));
  tmpRoots.push(root);
  const cwd = join(root, "project");
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return { cwd, paths, dir };
}

describe("tidy batch P3a orchestration", () => {
  it("parses the bounded batch flags without treating them as file names", () => {
    expect(parseTidyBatchArgs("--batch --dry-run --archive-only note.md")).toEqual({
      batch: true,
      dryRun: true,
      status: false,
      breakLock: false,
      triage: false,
      archiveOnly: true,
      files: ["note.md"],
    });
  });

  it("serves --status without a spawn port and performs no writes", async () => {
    const fx = fixture();
    const messages: string[] = [];
    await handleBatchTidyCommand("--batch --status", context(fx.cwd, messages), {
      paths: fx.paths,
      settings: settings(),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("lock: free");
    expect(messages[0]).toContain("lease: free");
  });

  it("--status shows a held directory lock's holder without touching it", async () => {
    const fx = fixture();
    const lock = JSON.stringify({ pid: 1, host: "other-host", token: "t", at: 1_700_000_000_000 });
    writeFileSync(join(fx.dir, ".lock"), lock);
    const messages: string[] = [];
    await handleBatchTidyCommand("--batch --status", context(fx.cwd, messages), {
      paths: fx.paths,
      settings: settings(),
    });
    expect(messages[0]).toContain("lock: pid 1 on other-host since 2023-11-14T22:13:20.000Z");
    expect(readFileSync(join(fx.dir, ".lock"), "utf8")).toBe(lock);
  });

  it("serves RPC dry-run without a spawn port and reports the plan", async () => {
    const fx = fixture();
    writeFileSync(join(fx.dir, "note.md"), "---\nsource: agent\n---\n# note\nplain memory\n");
    const messages: string[] = [];
    await handleBatchTidyCommand("--batch --dry-run", context(fx.cwd, messages), {
      paths: fx.paths,
      settings: settings(),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("tidy --batch --dry-run");
    expect(messages[0]).toContain("normalize batches 1");
  });
});
