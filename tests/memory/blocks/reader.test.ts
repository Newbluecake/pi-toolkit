import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "../../../src/memory/safe-fs.js";
import { createBlockLocked, readCorpus, type CorpusReaderState } from "../../../src/memory/blocks/store.js";
const roots: string[] = [];
function setup(): { p: string; dir: string } {
  const p = mkdtempSync(join(tmpdir(), "blocks-reader-"));
  roots.push(p);
  const dir = join(p, "blocks");
  mkdirSync(dir);
  writeFileSync(join(dir, ".layout.json"), '{"v":1}');
  writeFileSync(join(p, "core.md"), "OLD ROOT MUST NOT BECOME CORPUS");
  return { p, dir };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("mid-read rename returns previous result, warns once and never falls back to legacy", () => {
  const { p, dir } = setup();
  const meta = { authority: "agent" as const };
  createBlockLocked(dir, "topic", meta, "one", new Date());
  createBlockLocked(dir, "topic", meta, "two", new Date());
  const warn = vi.fn(),
    state: CorpusReaderState = { warned: false, warn };
  const previous = readCorpus(dir, state);
  expect(previous.blocks).toHaveLength(2);
  const read = vi.spyOn(fs, "readRegular");
  read.mockClear();
  let moved = false;
  const result = readCorpus(dir, state, {
    afterRead: () => {
      if (!moved) {
        moved = true;
        renameSync(dir, join(p, "rolledback"));
      }
    },
  });
  expect(result).toBe(previous);
  expect(warn).toHaveBeenCalledOnce();
  expect(read.mock.calls.some(([path]) => path === p)).toBe(false);
  expect(readCorpus(dir, state)).toBe(previous);
  expect(warn).toHaveBeenCalledOnce();
});
it("no previous result returns empty, and a replaced directory invalidates the read", () => {
  const { p, dir } = setup();
  createBlockLocked(dir, "topic", { authority: "user" }, "one", new Date());
  const state: CorpusReaderState = { warned: false };
  const result = readCorpus(dir, state, {
    afterRead: () => {
      renameSync(dir, join(p, "old"));
      mkdirSync(dir);
      writeFileSync(join(dir, ".layout.json"), '{"v":1}');
    },
  });
  expect(result.blocks).toEqual([]);
  expect(state.warned).toBe(true);
  expect(state.previous).toBeUndefined();
});
