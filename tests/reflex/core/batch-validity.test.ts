import { describe, expect, it } from "vitest";
import { admitBatch, batchValidity, lastRevisedAt } from "../../../src/reflex/core/promotion.js";
import type {
  CorpusManifestV1,
  EvalBatchV1,
  EvidenceIdentity,
  ExposureRecordV1,
  RevisionRecordV1,
} from "../../../src/reflex/core/types.js";
import { makeTurn } from "../helpers/turn.js";

const identity: EvidenceIdentity = { lineage: "draft.x", templateHash: "H2", portId: "jobs.list", portVer: 1 };
const batch: EvalBatchV1 = {
  v: 1,
  batchId: "B1",
  lineage: "draft.x",
  manifestHash: "M",
  cutoffAt: 0,
  since: 0,
  until: 100,
  turnKeys: ["key"],
  turnDigests: ["old"],
  createdAt: 100,
};
const manifest: CorpusManifestV1 = { v: 1, manifestHash: "M", normalizeVersion: "1", files: [] };
const exposure: ExposureRecordV1 = {
  v: 1,
  lineage: "draft.x",
  templateHash: "H1",
  batchId: "B1",
  at: 100,
  via: "show",
};
const revision: RevisionRecordV1 = {
  v: 1,
  lineage: "draft.x",
  templateHash: "H2",
  firstSeenAt: 200,
  gitCommitAt: 250,
  source: "catalog",
};

describe("batch validity r3", () => {
  it("same hash exposure is valid, another hash invalidates", () => {
    expect(batchValidity(batch, { ...identity, templateHash: "H1" }, [exposure], [manifest])).toEqual({ ok: true });
    expect(batchValidity(batch, identity, [exposure], [manifest])).toEqual({
      ok: false,
      reason: "exposed-then-modified",
    });
  });
  it("manifest missing fails closed", () => {
    expect(batchValidity(batch, identity, [], [])).toEqual({ ok: false, reason: "manifest-missing" });
  });
  it("another batch or lineage exposure has no effect; unexposed old batch stays valid", () => {
    expect(batchValidity(batch, identity, [{ ...exposure, batchId: "other" }], [manifest])).toEqual({ ok: true });
    expect(batchValidity(batch, identity, [{ ...exposure, lineage: "other" }], [manifest])).toEqual({ ok: true });
    expect(batchValidity(batch, identity, [], [manifest])).toEqual({ ok: true });
  });
  it("revision cutoff takes max(firstSeen, gitCommit), first-seen cannot be overwritten", () => {
    expect(lastRevisedAt("draft.x", [revision])).toBe(250);
    expect(lastRevisedAt("draft.x", [revision, { ...revision, firstSeenAt: 1000 }])).toBe(250);
    expect(lastRevisedAt("draft.x", [revision, { ...revision, templateHash: "H3", firstSeenAt: 300 }])).toBe(300);
    expect(lastRevisedAt("other", [revision])).toBe(0);
  });
  it("e2e: exposure → revision → repack rejection → new holdout admission", () => {
    const turns = [makeTurn({ session: "s", entryId: "t", split: "holdout", at: 251, digest: "old" })];
    expect(batchValidity(batch, identity, [exposure], [manifest]).reason).toBe("exposed-then-modified");
    expect(admitBatch(turns, "draft.x", [revision], [batch], [exposure])).toEqual({
      ok: false,
      reason: "reused-exposed-turns",
      cutoffAt: 250,
    });
    expect(admitBatch([{ at: 250, digest: "new" }], "draft.x", [revision], [batch], [exposure]).reason).toBe(
      "before-revision",
    );
    expect(admitBatch([{ at: 251, digest: "new" }], "draft.x", [revision], [batch], [exposure])).toEqual({
      ok: true,
      cutoffAt: 250,
    });
    const fresh = { ...batch, batchId: "B2", cutoffAt: 250, turnDigests: ["new"] };
    expect(batchValidity(fresh, identity, [exposure], [manifest])).toEqual({ ok: true });
    expect(admitBatch([{ at: 251, digest: "old" }], "other-lineage", [], [batch], [exposure]).reason).toBe(
      "reused-exposed-turns",
    );
  });
});
