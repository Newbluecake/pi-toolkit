import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { TMP_RETENTION_MS } from "../../src/bash/job-store.js";
import {
  adoptOrphans,
  gcSessionDir,
  migrateFlatRecords,
  reconcileRootDir,
  sanitizeSessionDirName,
  sweepJobFiles,
} from "../../src/bash/session-dirs.js";
import type { ProcessPort } from "../../src/bash/process.js";
import { createJobRecord } from "../../src/bash/types.js";

const processPort = {
  probePid: () => false,
  checkPidOwnership: () => "dead",
} as unknown as ProcessPort;
const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function options(rootDir: string, clock = new FakeClock(10_000)) {
  return {
    rootDir,
    selfDirName: sanitizeSessionDirName("session-a"),
    sessionId: "session-a",
    retentionMs: 1_000,
    clock,
    processPort,
  };
}
function record(rootDir: string, status: "running" | "completed" = "running", jobId = "b_TEST0001") {
  const base = createJobRecord({
    jobId,
    command: "sleep 1",
    cwd: "/tmp",
    sessionId: "session-a",
    hostPid: 999999,
    logPath: join(rootDir, `${jobId}.log`),
    createdAt: 1,
  });
  // `createJobRecord` only ever produces a fresh `staged` record (by design,
  // §2.1) — this helper's fixtures need arbitrary lifecycle fields, so they
  // are applied as an override *after* construction (not folded into the
  // `NewJobRecordInit` the function actually reads).
  return {
    ...base,
    pid: 999999,
    status,
    spawnedAt: 1,
    ...(status === "completed" ? { endedAt: 1 } : {}),
    backgroundedAt: 2,
    exitCode: status === "completed" ? 0 : null,
  };
}

describe("session bash job directories", () => {
  it("keeps uuidv7 ids unchanged and hashes other valid ids", () => {
    expect(sanitizeSessionDirName("0192f2d8-7e34-7abc-8def-0123456789ab")).toBe("0192f2d8-7e34-7abc-8def-0123456789ab");
    expect(sanitizeSessionDirName("Work")).toMatch(/^work-[0-9a-f]{8}$/);
    expect(sanitizeSessionDirName("")).toBe("_unscoped");
  });

  it("migrates a dead flat record with logPath rewritten and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const rec = record(root, "completed");
    await writeFile(join(root, "b_TEST0001.json"), JSON.stringify(rec));
    await writeFile(join(root, "b_TEST0001.log"), "done\n");
    const opts = options(root);
    await migrateFlatRecords(opts);
    const target = join(root, sanitizeSessionDirName("session-a"));
    const moved = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(target, "b_TEST0001.json"), "utf8"),
    ) as typeof rec;
    expect(moved.logPath).toBe(join(target, "b_TEST0001.log"));
    await migrateFlatRecords(opts);
    expect((await readdir(target)).filter((name) => name === "b_TEST0001.json")).toHaveLength(1);
  });

  it("never deletes non-terminal jobs and keeps stale session directories non-empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const dir = join(root, "dead-session-abcdef12");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    const rec = record(root);
    await writeFile(join(dir, "b_TEST0001.json"), JSON.stringify(rec));
    await writeFile(join(dir, "b_TEST0001.json.1.1.0.tmp"), "tmp");
    await utimes(join(dir, "b_TEST0001.json.1.1.0.tmp"), 0, 0);
    await gcSessionDir(dir, { ...options(root), clock: new FakeClock(TMP_RETENTION_MS + 10_000) });
    expect(await stat(join(dir, "b_TEST0001.json"))).toBeTruthy();
    expect(
      await stat(join(dir, "b_TEST0001.json.1.1.0.tmp")).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    await writeFile(join(root, "keep.txt"), "keep");
    await reconcileRootDir(options(root));
    expect(await stat(join(root, "keep.txt"))).toBeTruthy();
  });

  it("cleans a lone session marker and removes expired root terminal records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const empty = join(root, "old-session-abcdef12");
    await (await import("node:fs/promises")).mkdir(empty, { recursive: true });
    await writeFile(join(empty, "session-id"), "old-session\n");
    await gcSessionDir(empty, options(root));
    expect(
      await stat(empty).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    const rec = record(root, "completed");
    await writeFile(join(root, "b_TEST0001.json"), JSON.stringify(rec));
    await writeFile(join(root, "b_TEST0001.log"), "done\n");
    await reconcileRootDir(options(root));
    expect(
      await stat(join(root, "b_TEST0001.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await stat(join(root, "b_TEST0001.log")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("allows unknown files and retention-disabled records to remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const dir = join(root, "old-session-abcdef12");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".DS_Store"), "user file");
    await writeFile(join(dir, "b_TEST0001.json"), JSON.stringify(record(root, "completed")));
    await writeFile(join(dir, "b_TEST0001.log"), "done\n");
    await gcSessionDir(dir, { ...options(root), retentionMs: 0, clock: new FakeClock(TMP_RETENTION_MS + 10_000) });
    expect(await stat(join(dir, ".DS_Store"))).toBeTruthy();
    expect(await stat(join(dir, "b_TEST0001.json"))).toBeTruthy();
  });

  it("adopts dead-owner records from a sibling directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const from = join(root, "old-session-abcdef12");
    await (await import("node:fs/promises")).mkdir(from, { recursive: true });
    const rec = record(from);
    await writeFile(join(from, "b_TEST0001.json"), JSON.stringify({ ...rec, logPath: join(from, "b_TEST0001.log") }));
    await writeFile(join(from, "b_TEST0001.log"), "live\n");
    await adoptOrphans(options(root));
    expect(await stat(join(root, sanitizeSessionDirName("session-a"), "b_TEST0001.json"))).toBeTruthy();
  });
});

// ── bash-timeout-grace plan §2.5 step 4 (T31): abort checkpoints ────────────

describe("session bash job directories: recovery cancellation (§2.5 step 4)", () => {
  it("migrateFlatRecords: an already-aborted signal touches nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const rec = record(root, "completed");
    await writeFile(join(root, "b_TEST0001.json"), JSON.stringify(rec));
    await writeFile(join(root, "b_TEST0001.log"), "done\n");
    const controller = new AbortController();
    controller.abort();
    await migrateFlatRecords(options(root), undefined, undefined, controller.signal);
    // Nothing moved: the flat record is exactly where it started.
    expect(await stat(join(root, "b_TEST0001.json"))).toBeTruthy();
    expect(
      await stat(join(root, sanitizeSessionDirName("session-a"), "b_TEST0001.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("adoptOrphans: an already-aborted signal adopts nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const from = join(root, "old-session-abcdef12");
    await (await import("node:fs/promises")).mkdir(from, { recursive: true });
    const rec = record(from);
    await writeFile(join(from, "b_TEST0001.json"), JSON.stringify({ ...rec, logPath: join(from, "b_TEST0001.log") }));
    await writeFile(join(from, "b_TEST0001.log"), "live\n");
    const controller = new AbortController();
    controller.abort();
    await adoptOrphans(options(root), [], controller.signal);
    expect(
      await stat(join(root, sanitizeSessionDirName("session-a"), "b_TEST0001.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("sweepJobFiles/gcSessionDir: an already-aborted signal deletes nothing, even past retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const dir = join(root, "dead-session-abcdef12");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    const rec = record(root, "completed");
    await writeFile(join(dir, "b_TEST0001.json"), JSON.stringify(rec));
    await writeFile(join(dir, "b_TEST0001.log"), "done\n");
    const opts = { ...options(root), clock: new FakeClock(TMP_RETENTION_MS + 10_000) };
    const controller = new AbortController();
    controller.abort();
    await gcSessionDir(dir, opts, true, controller.signal);
    expect(await stat(join(dir, "b_TEST0001.json"))).toBeTruthy();
    expect(await stat(join(dir, "b_TEST0001.log"))).toBeTruthy();
    expect(await stat(dir)).toBeTruthy(); // not rmdir'd either
  });

  it("reconcileRootDir: an already-aborted signal is a full no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const rec = record(root, "completed");
    await writeFile(join(root, "b_TEST0001.json"), JSON.stringify(rec));
    await writeFile(join(root, "b_TEST0001.log"), "done\n");
    const controller = new AbortController();
    controller.abort();
    await reconcileRootDir(options(root), controller.signal);
    // A non-aborted call would prune this expired root-level terminal record
    // (see the existing "cleans a lone session marker..." test); aborted must not.
    expect(await stat(join(root, "b_TEST0001.json"))).toBeTruthy();
  });

  it("migrateFlatRecords: aborting mid-scan stops before the next record, but an already-started move completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-session-dirs-"));
    dirs.push(root);
    const recA = record(root, "completed", "b_TEST0001");
    const recB = record(root, "completed", "b_TEST0002");
    await writeFile(join(root, "b_TEST0001.json"), JSON.stringify(recA));
    await writeFile(join(root, "b_TEST0001.log"), "a\n");
    await writeFile(join(root, "b_TEST0002.json"), JSON.stringify(recB));
    await writeFile(join(root, "b_TEST0002.log"), "b\n");
    const controller = new AbortController();
    // `probePid` is called once per record, synchronously, strictly between
    // that record's `readRecord` and its `moveRecordFiles` — aborting on the
    // *second* call deterministically lands after record A's move has fully
    // finished (the loop only reaches record B once record A's `await
    // moveRecordFiles(...)` has settled) and before record B's own move ever
    // starts, without needing to stub `node:fs`.
    let probePidCalls = 0;
    const abortingPort: ProcessPort = {
      ...processPort,
      probePid: () => {
        probePidCalls += 1;
        if (probePidCalls === 2) controller.abort();
        return false;
      },
    };
    const opts = { ...options(root), processPort: abortingPort };
    await migrateFlatRecords(opts, undefined, undefined, controller.signal);
    expect(probePidCalls).toBe(2);
    const target = sanitizeSessionDirName("session-a");
    const movedA = await stat(join(root, target, "b_TEST0001.json")).then(
      () => true,
      () => false,
    );
    const movedB = await stat(join(root, target, "b_TEST0002.json")).then(
      () => true,
      () => false,
    );
    // Whichever record `readdir` visited first fully migrated (its own move
    // ran to completion before the abort landed on the second `probePid`
    // call); the other is untouched — exactly one of the two, regardless of
    // `readdir`'s (unspecified) enumeration order.
    expect(movedA).not.toBe(movedB);
    if (!movedA) expect(await stat(join(root, "b_TEST0001.json"))).toBeTruthy();
    if (!movedB) expect(await stat(join(root, "b_TEST0002.json"))).toBeTruthy();
  });
});
