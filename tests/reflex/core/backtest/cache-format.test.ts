import { describe, expect, it } from "vitest";
import {
  cacheVersions,
  decodeCache,
  encodeCache,
  invalidationKey,
  type CorpusCache,
  type FileStamp,
} from "../../../../src/reflex/core/backtest/cache-format.js";
import { makeHeader, makeTurn } from "../../helpers/turn.js";

const stamp: FileStamp = { file: "/sessions/a.jsonl", size: 100, mtimeMs: 22, dev: 1, ino: 2 };
const key = invalidationKey([stamp]);
const cache: CorpusCache = {
  key,
  files: [{ stamp, header: makeHeader({ file: stamp.file, id: "a" }), lines: 2, lastEntryId: "u" }],
  turns: [makeTurn({ session: "a", entryId: "u" })],
  corrections: [{ session: "a", entryId: "c", at: 23, origin: "tui", corrHit: true }],
  liveRows: [],
  counts: { users: 1 },
};
describe("B3 cache", () => {
  it("round trips private Turn + CorrectionFact + header byte-equivalently", () => {
    expect(decodeCache(encodeCache(cache), key)).toEqual(cache);
    expect(encodeCache(decodeCache(encodeCache(cache), key)!)).toBe(encodeCache(cache));
  });
  it.each(["size", "mtimeMs", "dev", "ino"] as const)("invalidates changed %s", (field) => {
    expect(invalidationKey([{ ...stamp, [field]: stamp[field] + 1 }])).not.toBe(key);
  });
  it.each(["normalizeVersion", "markersVersion", "correctionHash", "cacheV"] as const)("invalidates %s", (field) => {
    const versions = cacheVersions();
    expect(
      invalidationKey([stamp], {
        ...versions,
        [field]: typeof versions[field] === "number" ? 3 : "changed",
      } as typeof versions),
    ).not.toBe(key);
  });
  it("sorts stamps and includes added/deleted files (parent dependencies)", () => {
    const b = { ...stamp, file: "/sessions/b.jsonl" };
    expect(invalidationKey([stamp, b])).toBe(invalidationKey([b, stamp]));
    expect(invalidationKey([stamp, b])).not.toBe(key);
  });
  it("rejects truncated, corrupted, unknown and stale cache rows", () => {
    const text = encodeCache(cache);
    expect(decodeCache(text.slice(0, -100), key)).toBeUndefined();
    expect(decodeCache(text.replace('"corrHit":true', '"corrHit":false'), key)).toBeUndefined();
    expect(decodeCache(text.replace('"k":"turn"', '"k":"evil"'), key)).toBeUndefined();
    expect(decodeCache(text, "other")).toBeUndefined();
    expect(decodeCache(text.replace('"unknownFacts":[]', '"unknownFacts":["fake"]'), key)).toBeUndefined();
  });
});
