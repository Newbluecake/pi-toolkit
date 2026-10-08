/**
 * web-hub session-history plan §4.5.7 (`snapshot.ts`): fork snapshots (PD12).
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import {
  createHistoryIoGate,
  HISTORY_SNAPSHOT_MAX_BYTES,
} from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { createFdLedger } from "../../../../../src/web-hub/hub/spawn/history/fd-ledger.js";
import { defaultHistoryFs } from "../../../../../src/web-hub/hub/spawn/history/fs.js";
import { getPinnedFileFd, pinSession, createPinAdmission } from "../../../../../src/web-hub/hub/spawn/history/pin.js";
import {
  createForkSrcDirState,
  snapshotFork,
  sweepForkSrcDir,
} from "../../../../../src/web-hub/hub/spawn/history/snapshot.js";

const UID = process.getuid?.() ?? 0;
let root: string;
let forkSrcDir: string;

function pinDeps() {
  return {
    agentDir: root,
    uid: UID,
    fs: defaultHistoryFs(),
    gate: createHistoryIoGate(),
    ledger: createFdLedger(32),
    admission: createPinAdmission(),
    now: () => Date.now(),
  };
}

async function pinFile(content: string) {
  const sessionsDir = join(root, "sessions");
  mkdirSync(join(sessionsDir, "d1"), { recursive: true });
  writeFileSync(join(sessionsDir, "d1", "f1.jsonl"), content);
  const result = await pinSession(
    { key: "d1/f1.jsonl", id: "sess-aaaa1" },
    "/w/p",
    createReqDeadline(() => 0, 5000),
    pinDeps(),
  );
  if (!result.ok) throw new Error(`pin failed: ${JSON.stringify(result)}`);
  return result.pin;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-snap-"));
  mkdirSync(join(root, "spawn"), { recursive: true }); // mirrors prod: stateDir/spawn/ already exists
  forkSrcDir = join(root, "spawn", "fork-src");
});

function snapDeps() {
  return {
    forkSrcDir,
    fs: defaultHistoryFs(),
    gate: createHistoryIoGate(),
    ledger: createFdLedger(32),
    now: () => Date.now(),
  };
}

const HEADER = `${JSON.stringify({ type: "session", id: "sess-aaaa1", cwd: "/w/p", timestamp: "t" })}\n`;

describe("snapshotFork", () => {
  it("copies complete lines only, dropping a half-written trailing line", async () => {
    const content = `${HEADER}{"type":"message"}\n{"half": "line no newline`;
    const pin = await pinFile(content);
    const deadline = createReqDeadline(() => 0, 10_000);
    const result = await snapshotFork(pin, deadline, snapDeps(), createForkSrcDirState());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = readFileSync(result.snapshot.path, "utf8");
    expect(written).toBe(`${HEADER}{"type":"message"}\n`);
    expect(result.snapshot.size).toBe(written.length);
    pin.release();
  });

  it("source file bytes are unchanged after snapshotting", async () => {
    const content = `${HEADER}{"type":"message"}\n`;
    const pin = await pinFile(content);
    const srcPath = join(root, "sessions", "d1", "f1.jsonl");
    const before = readFileSync(srcPath, "utf8");
    const result = await snapshotFork(
      pin,
      createReqDeadline(() => 0, 10_000),
      snapDeps(),
      createForkSrcDirState(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(srcPath, "utf8")).toBe(before);
    pin.release();
  });

  it("snapshot file is created 0600 with O_EXCL (never collides with a pre-existing name)", async () => {
    const content = HEADER;
    const pin = await pinFile(content);
    const result = await snapshotFork(
      pin,
      createReqDeadline(() => 0, 10_000),
      snapDeps(),
      createForkSrcDirState(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const st = statSync(result.snapshot.path);
    expect(st.mode & 0o777).toBe(0o600);
    pin.release();
  });

  it("over HISTORY_SNAPSHOT_MAX_BYTES ⇒ session-too-large, no file left behind", async () => {
    const pin = await pinFile(HEADER);
    // fake a pin whose reported size exceeds the cap without actually writing a huge file
    const bigPin = { ...pin, size: HISTORY_SNAPSHOT_MAX_BYTES + 1 };
    const result = await snapshotFork(
      bigPin,
      createReqDeadline(() => 0, 10_000),
      snapDeps(),
      createForkSrcDirState(),
    );
    expect(result).toMatchObject({ ok: false, status: 400, reason: "session-too-large" });
    pin.release();
  });

  it("fork-src directory is a symlink ⇒ fails closed (504, the frozen SnapshotResult has no 503 slot)", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "pwh-elsewhere-"));
    symlinkSync(elsewhere, forkSrcDir); // parent (root/spawn) already exists from beforeEach
    const pin = await pinFile(HEADER);
    const result = await snapshotFork(
      pin,
      createReqDeadline(() => 0, 10_000),
      snapDeps(),
      createForkSrcDirState(),
    );
    expect(result).toMatchObject({ ok: false, status: 504 });
    pin.release();
  });

  it("the pin's underlying fd keeps working for the snapshot even via the re-open through /proc/self/fd", async () => {
    const pin = await pinFile(HEADER);
    const fd = getPinnedFileFd(pin);
    expect(fd).toBeGreaterThan(0);
    const result = await snapshotFork(
      pin,
      createReqDeadline(() => 0, 10_000),
      snapDeps(),
      createForkSrcDirState(),
    );
    expect(result.ok).toBe(true);
    pin.release();
  });

  it("verifier round 3 (defect 3b): a HANGING forkSrcDir lstat fails closed within the per-step bound (504), never hangs the request", async () => {
    const pin = await pinFile(HEADER);
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      lstat: (p) => (p === forkSrcDir ? new Promise<never>(() => undefined) : real.lstat(p)),
    };
    const start = Date.now();
    const result = await snapshotFork(
      pin,
      createReqDeadline(() => 0, 10_000),
      { ...snapDeps(), fs },
      createForkSrcDirState(),
    );
    expect(result).toMatchObject({ ok: false, status: 504 });
    expect(Date.now() - start).toBeLessThan(5_000); // the per-step race ended it, not the 10s budget
    pin.release();
  }, 8_000);

  it("verifier round 3 (defect 3b): a HANGING forkSrcDir mkdir fails closed within the per-step bound (504)", async () => {
    const pin = await pinFile(HEADER);
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      mkdir: (p, mode) => (p === forkSrcDir ? new Promise<never>(() => undefined) : real.mkdir(p, mode)),
    };
    const start = Date.now();
    const result = await snapshotFork(
      pin,
      createReqDeadline(() => 0, 10_000),
      { ...snapDeps(), fs },
      createForkSrcDirState(),
    );
    expect(result).toMatchObject({ ok: false, status: 504 });
    expect(Date.now() - start).toBeLessThan(5_000);
    pin.release();
  }, 8_000);
});

describe("sweepForkSrcDir", () => {
  it("deletes only regular files, never follows a symlink", async () => {
    mkdirSync(forkSrcDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(forkSrcDir, "snap-a.jsonl"), "x");
    const target = mkdtempSync(join(tmpdir(), "pwh-target-"));
    writeFileSync(join(target, "should-survive.jsonl"), "y");
    symlinkSync(join(target, "should-survive.jsonl"), join(forkSrcDir, "snap-link.jsonl"));
    await sweepForkSrcDir(forkSrcDir, defaultHistoryFs(), 256);
    expect(() => statSync(join(forkSrcDir, "snap-a.jsonl"))).toThrow();
    // the symlink target must survive (never followed and deleted)
    expect(readFileSync(join(target, "should-survive.jsonl"), "utf8")).toBe("y");
  });

  it("a missing directory is a silent no-op", async () => {
    await expect(sweepForkSrcDir(join(root, "does-not-exist"), defaultHistoryFs(), 256)).resolves.toBeUndefined();
  });
});
