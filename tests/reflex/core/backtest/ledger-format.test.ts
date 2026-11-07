import { describe, expect, it } from "vitest";
import {
  createBatch,
  createManifest,
  decodeLedger,
  encodeLedger,
  type LedgerKind,
  type LedgerValue,
} from "../../../../src/reflex/core/backtest/ledger-format.js";
import { makeHeader, makeTurn } from "../../helpers/turn.js";
const manifest = createManifest([
  {
    stamp: { file: "/s/a.jsonl", size: 100, mtimeMs: 3, dev: 1, ino: 1 },
    header: makeHeader({ file: "/s/a.jsonl", id: "a" }),
    lines: 4,
    lastEntryId: "e",
  },
]);
const turn = makeTurn({ session: "a", entryId: "u", split: "holdout" });
const batch = createBatch("draft.x", manifest.manifestHash, [turn], 0, 0, turn.at + 1, turn.at + 1);
const values: [LedgerKind, LedgerValue][] = [
  ["manifest", manifest],
  ["batch", batch],
  ["exposure", { v: 1, lineage: "draft.x", templateHash: "abc", batchId: batch.batchId, at: 100, via: "show" }],
  [
    "revision",
    { v: 1, lineage: "draft.x", templateHash: "abc", firstSeenAt: 100, gitCommitAt: 200, source: "catalog" },
  ],
  [
    "review",
    { v: 1, unverified: true, entries: [{ digest: turn.digest, portId: "jobs.list", verdict: "ok", at: 12 }] },
  ],
];
describe("B3 ledger codecs", () => {
  it.each(values)("round trips %s without authentication claims", (kind, value) => {
    expect(decodeLedger(kind, encodeLedger(value))).toEqual(value);
    expect(decodeLedger(kind, '{"v":2}')).toBeUndefined();
  });
  it("manifest includes path hashes, not paths; tampering invalidates hash", () => {
    expect(encodeLedger(manifest)).not.toContain("/s/");
    expect(decodeLedger("manifest", encodeLedger(manifest).replace('"size":100', '"size":101'))).toBeUndefined();
  });
  it("batch IDs are deterministic and train cannot sneak in", () => {
    const b = makeTurn({ session: "b", entryId: "v", split: "holdout" });
    expect(createBatch("L", manifest.manifestHash, [turn, b], 0, 0, 2, 3)).toEqual(
      createBatch("L", manifest.manifestHash, [b, turn], 0, 0, 2, 3),
    );
    expect(() => createBatch("L", manifest.manifestHash, [{ ...turn, split: "train" }], 0, 0, 2, 3)).toThrow("holdout");
    expect(() => createBatch("L", manifest.manifestHash, [turn, turn], 0, 0, 2, 3)).toThrow("duplicate");
    expect(decodeLedger("batch", encodeLedger({ ...batch, lineage: "tamper" }))).toBeUndefined();
  });
  it("reviews must explicitly declare unverified; malformed journals rejected", () => {
    expect(decodeLedger("review", '{"v":1,"entries":[]}')).toBeUndefined();
    expect(
      decodeLedger("revision", '{"v":1,"lineage":"L","templateHash":"H","firstSeenAt":-1,"source":"catalog"}'),
    ).toBeUndefined();
    expect(decodeLedger("exposure", JSON.stringify({ ...values[2]![1], via: "fake" }))).toBeUndefined();
  });
});
