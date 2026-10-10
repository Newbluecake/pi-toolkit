import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSelfRestartStore,
  MAX_SELF_RESTART_FILE_BYTES,
  SELF_RESTART_MAX_PER_WINDOW,
  SELF_RESTART_WINDOW_MS,
} from "../../../src/web-hub/hub/self-restart.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "wh-self-restart-"));
  dirs.push(dir);
  return join(dir, "self-restart.json");
}

describe("persistent DB breaker self-restart admission", () => {
  it("allows two restarts per hour and persists a private bounded record", () => {
    const path = file();
    const store = createSelfRestartStore(path);
    expect(store.tryAcquire(1000).allowed).toBe(true);
    expect(store.tryAcquire(2000).allowed).toBe(true);
    expect(store.tryAcquire(3000)).toEqual({ allowed: false, reason: "limit" });
    const record = JSON.parse(readFileSync(path, "utf8")) as { v: number; timestamps: number[] };
    expect(record.v).toBe(1);
    expect(record.timestamps).toHaveLength(SELF_RESTART_MAX_PER_WINDOW);
    expect(record.timestamps.every(Number.isFinite)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("expires old timestamps and never keeps more than four", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ v: 1, timestamps: [1, 2, 3, 4] }), { mode: 0o600 });
    const store = createSelfRestartStore(path);
    expect(store.tryAcquire(SELF_RESTART_WINDOW_MS + 10).allowed).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8")) as { timestamps: number[] };
    expect(record.timestamps).toEqual([SELF_RESTART_WINDOW_MS + 10]);
  });

  it("fails safe for corrupt state and for a clock moving backwards", () => {
    const corrupt = file();
    writeFileSync(corrupt, "not-json\n");
    expect(createSelfRestartStore(corrupt).tryAcquire(1000)).toEqual({ allowed: false, reason: "invalid-state" });

    const backwards = file();
    writeFileSync(backwards, JSON.stringify({ v: 1, timestamps: [2000] }), { mode: 0o600 });
    expect(createSelfRestartStore(backwards).tryAcquire(1000)).toEqual({
      allowed: false,
      reason: "clock-backwards",
    });
  });

  it("rejects oversized state before reading it", () => {
    const path = file();
    writeFileSync(path, "x".repeat(MAX_SELF_RESTART_FILE_BYTES + 1));
    expect(createSelfRestartStore(path).tryAcquire(1000)).toEqual({ allowed: false, reason: "invalid-state" });
  });

  it("rejects malformed finite-number records", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ v: 1, timestamps: [null] }));
    expect(createSelfRestartStore(path).tryAcquire(1000)).toEqual({ allowed: false, reason: "invalid-state" });
  });
});
