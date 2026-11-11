import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readIncrementalCorpus } from "../../../src/memory/govern/incremental-corpus.js";
import { blockRaw } from "../blocks/helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "p50-corpus-"));
  roots.push(root);
  mkdirSync(join(root, "blocks"));
  const stat = statSync(root);
  const directory = { realpath: realpathSync(root), dev: stat.dev, ino: stat.ino, sessionEpoch: 1 };
  const put = (n: number, options: Partial<Parameters<typeof blockRaw>[0]> = {}) => {
    const id = `rule.${String(n).padStart(3, "0")}`;
    writeFileSync(
      join(root, "blocks", `${id}.md`),
      blockRaw({ id, authority: "agent", body: `fact ${n}`, ...options }),
    );
  };
  return { root, directory, put };
}
it("selection contains only local active safe candidates, no raw body/path/audit evidence", () => {
  const h = setup();
  h.put(1);
  h.put(2, { private: true });
  h.put(3, { status: "archived" });
  h.put(4, { body: "token=ghs_9f8e7d6c5b4a39281706" });
  const result = readIncrementalCorpus(h.directory)!;
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toEqual({ id: "rule.001", rev: expect.any(String), topic: "rule", authority: "agent" });
  expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const before = result.fingerprint;
  h.put(1, { body: "edited latest fact" });
  expect(readIncrementalCorpus(h.directory)?.fingerprint).not.toBe(before);
});
it("sixteen selected candidates are deterministic, excess remains counted evidence", () => {
  const h = setup();
  for (let n = 20; n > 0; n--) h.put(n);
  const result = readIncrementalCorpus(h.directory)!;
  expect(result.candidates.map((c) => c.id)).toEqual(
    Array.from({ length: 16 }, (_, i) => `rule.${String(i + 1).padStart(3, "0")}`),
  );
  expect(result.omittedCount).toBe(4);
});
it("directory identity mismatch and no-follow file symlinks never yield stale candidate data", () => {
  const h = setup();
  h.put(1);
  expect(readIncrementalCorpus({ ...h.directory, ino: h.directory.ino + 1 })).toBeUndefined();
  writeFileSync(join(h.root, "outside.md"), blockRaw({ id: "rule.002", body: "foreign" }));
  symlinkSync(join(h.root, "outside.md"), join(h.root, "blocks", "rule.002.md"));
  expect(readIncrementalCorpus(h.directory)).toBeUndefined();
});
