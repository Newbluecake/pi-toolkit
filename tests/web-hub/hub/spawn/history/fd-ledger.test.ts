/**
 * web-hub session-history plan v3.3 W1 (`fd-ledger.ts`): reserve-before-open accounting,
 * plus the v3.4 X3.1 over-release discipline (assert-and-report, never silently clamp) —
 * including a real `pinSession`/`snapshotFork` lifecycle proving the counter stays 0 on the
 * pin and temp paths too.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import { createHistoryIoGate } from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { createFdLedger } from "../../../../../src/web-hub/hub/spawn/history/fd-ledger.js";
import { defaultHistoryFs } from "../../../../../src/web-hub/hub/spawn/history/fs.js";
import { createPinAdmission, pinSession } from "../../../../../src/web-hub/hub/spawn/history/pin.js";
import { createForkSrcDirState, snapshotFork } from "../../../../../src/web-hub/hub/spawn/history/snapshot.js";

const UID = process.getuid?.() ?? 0;

let root: string;
let forkSrcDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-fdl-"));
  forkSrcDir = join(root, "fork-src");
});

describe("createFdLedger", () => {
  it("reserves up to max, rejects beyond it, and releases exactly what was reserved", () => {
    const ledger = createFdLedger(4);
    expect(ledger.reserve(2, "gen")).toBe(true);
    expect(ledger.reserve(2, "pin")).toBe(true);
    expect(ledger.counts()).toEqual({ gen: 2, pin: 2, temp: 0, max: 4 });
    expect(ledger.reserve(1, "temp")).toBe(false); // would exceed max
    ledger.release(2, "pin");
    expect(ledger.counts()).toEqual({ gen: 2, pin: 0, temp: 0, max: 4 });
    expect(ledger.reserve(1, "temp")).toBe(true);
    expect(ledger.counts()).toEqual({ gen: 2, pin: 0, temp: 1, max: 4 });
  });

  it("never goes negative on over-release (defensive clamp, X3 #1/#2) — v3.4 X3.1: now counted and reported, never silent", () => {
    const ledger = createFdLedger(4);
    const warns: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(String(args[0]));
    });
    try {
      ledger.reserve(1, "gen");
      ledger.release(5, "gen"); // over-release — impossible by construction, must be counted
      expect(ledger.counts()).toEqual({ gen: 0, pin: 0, temp: 0, max: 4 }); // clamp keeps counts sane
      expect(ledger.overRelease()).toBe(1);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("over-release");
      // a second over-release is counted again, not deduped away
      ledger.release(1, "gen");
      expect(ledger.overRelease()).toBe(2);
      // the clamp never poisons unrelated kinds' admission
      expect(ledger.reserve(1, "pin")).toBe(true);
      ledger.release(1, "pin");
      expect(ledger.counts()).toEqual({ gen: 0, pin: 0, temp: 0, max: 4 });
    } finally {
      warn.mockRestore();
    }
  });

  it("stays at 0 across a balanced reserve/release lifecycle", () => {
    const ledger = createFdLedger(8);
    ledger.reserve(2, "gen");
    ledger.release(2, "gen");
    ledger.reserve(3, "pin");
    ledger.release(3, "pin");
    ledger.reserve(1, "temp");
    ledger.release(1, "temp");
    expect(ledger.overRelease()).toBe(0);
  });

  it("n<=0 reserve/release are no-ops", () => {
    const ledger = createFdLedger(2);
    expect(ledger.reserve(0, "gen")).toBe(true);
    expect(ledger.counts().gen).toBe(0);
    ledger.release(0, "gen");
    expect(ledger.counts().gen).toBe(0);
  });

  it("concurrent independent kinds never interfere — totals are summed across kinds for admission", () => {
    const ledger = createFdLedger(3);
    expect(ledger.reserve(1, "gen")).toBe(true);
    expect(ledger.reserve(1, "pin")).toBe(true);
    expect(ledger.reserve(1, "temp")).toBe(true);
    expect(ledger.reserve(1, "gen")).toBe(false); // total already at max
    ledger.release(1, "pin");
    expect(ledger.reserve(1, "gen")).toBe(true);
  });
});

describe("fd-ledger over-release stays 0 on the real pin/temp paths (v3.4 X3.1)", () => {
  it("a full pin lifecycle (open 3 fds, fail() cleanup, snapshot temp fds, release) never over-releases", async () => {
    const sessionsDir = join(root, "sessions");
    mkdirSync(join(sessionsDir, "d1"), { recursive: true });
    writeFileSync(
      join(sessionsDir, "d1", "f1.jsonl"),
      `${JSON.stringify({ type: "session", id: "sess-aaaa1", cwd: "/w/p", timestamp: "t" })}\n`,
    );
    const fs = defaultHistoryFs();
    const gate = createHistoryIoGate();
    const ledger = createFdLedger(32);
    const pinDeps = {
      agentDir: root,
      uid: UID,
      fs,
      gate,
      ledger,
      admission: createPinAdmission(),
      now: () => 0,
    };

    // 1) a FAILING resolve (missing session) exercises pinSession's fail() cleanup — the
    //    opened root/dir fds must be closed+released exactly once each.
    const missing = await pinSession(
      { key: "d1/nope.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      pinDeps,
    );
    expect(missing).toEqual({ ok: false, status: 400, code: "E_DIR", reason: "session-missing" });
    expect(ledger.counts().pin).toBe(0);
    expect(ledger.overRelease()).toBe(0);

    // 2) a succeeding resolve pins 3 fds ("pin"), a snapshot opens 2 more ("temp"), and every
    //    release path pairs 1:1 with its reserve.
    const resolved = await pinSession(
      { key: "d1/f1.jsonl", id: "sess-aaaa1" },
      "/w/p",
      createReqDeadline(() => 0, 5000),
      pinDeps,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(ledger.counts().pin).toBe(3);

    const snap = await snapshotFork(
      resolved.pin,
      createReqDeadline(() => 0, 8000),
      { forkSrcDir, fs, gate, ledger, now: () => 0 },
      createForkSrcDirState(),
    );
    expect(snap.ok).toBe(true);
    if (snap.ok) snap.snapshot.discard();
    expect(ledger.counts()).toEqual({ gen: 0, pin: 3, temp: 0, max: 32 });

    resolved.pin.release();
    resolved.pin.release(); // idempotent — must NOT double-release the 3 pin reservations
    expect(ledger.counts()).toEqual({ gen: 0, pin: 0, temp: 0, max: 32 });
    expect(ledger.overRelease()).toBe(0);
  });
});
