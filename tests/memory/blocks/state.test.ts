import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readBlocksState,
  readHold,
  writeBlocksStateLocked,
  writeHoldLocked,
} from "../../../src/memory/blocks/state.js";
import { readMarker } from "../../../src/memory/blocks/marker.js";
const roots: string[] = [];
function root(): string {
  const p = mkdtempSync(join(tmpdir(), "blocks-state-"));
  roots.push(p);
  return p;
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("state defaults gen to zero and persists monotonic generation", () => {
  const p = root();
  expect(readBlocksState(p)).toEqual({ v: 1, gen: 0, overBudgetStreak: 0 });
  writeFileSync(join(p, ".blocks-state.json"), '{"v":1,"overBudgetStreak":2}');
  expect(readBlocksState(p).gen).toBe(0);
  const state = { v: 1 as const, gen: 3, overBudgetStreak: 2, lastOutcome: "committed" as const, lastAt: "now" };
  writeBlocksStateLocked(p, state);
  expect(readBlocksState(p)).toEqual(state);
  expect(() => writeBlocksStateLocked(p, { ...state, gen: 2 })).toThrow("generation");
  writeFileSync(join(p, ".blocks-state.json"), '{"v":1,"gen":-1}');
  expect(() => readBlocksState(p)).toThrow("E_STATE");
  writeFileSync(join(p, ".blocks-state.json"), "broken");
  expect(() => readBlocksState(p)).toThrow("E_STATE");
});
it("hold round trips, corrupt/symlink holds are never absent", () => {
  const p = root();
  expect(readHold(p)).toBeUndefined();
  const hold = {
    v: 1 as const,
    at: "now",
    reason: "rollback" as const,
    gen: 4,
    rollback: { from: "blocks" as const, to: ".blocks-rolledback-20261106", done: false },
  };
  writeHoldLocked(p, hold);
  expect(readHold(p)).toEqual(hold);
  writeFileSync(join(p, ".blocks-hold"), "broken");
  expect(readHold(p)).toHaveProperty("v", 1);
  rmSync(join(p, ".blocks-hold"));
  symlinkSync("missing", join(p, ".blocks-hold"));
  expect(readHold(p)).toHaveProperty("v", 1);
});
it("marker preserves valid source/gen/files; corrupt existing marker is a sentinel", () => {
  const p = root();
  expect(readMarker(p)).toBeUndefined();
  writeFileSync(join(p, ".layout.json"), "broken");
  expect(readMarker(p)).toEqual({ v: 1 });
  const marker = {
    v: 1,
    source: "fresh",
    gen: 2,
    files: [{ path: "archive/x.001.md", sha256: "a".repeat(64), size: 12 }],
  };
  writeFileSync(join(p, ".layout.json"), JSON.stringify(marker));
  expect(readMarker(p)).toEqual(marker);
});
