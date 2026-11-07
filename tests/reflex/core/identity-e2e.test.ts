import { expect, it } from "vitest";
import {
  buildLiveEvidence,
  evaluateMergedPromotion,
  type LiveEvidenceRow,
} from "../../../src/reflex/core/promotion.js";
import { identityKey, templateHash } from "../../../src/reflex/core/identity.js";
import { makeDraft, makeRecord } from "../helpers/turn.js";

it("same id/version with changed template keeps separate identity evidence", () => {
  const old = makeDraft({ id: "draft.x" });
  const next = makeDraft({ id: "draft.x", intent: { ...old.intent, strong: ["different"] } });
  const rows: LiveEvidenceRow[] = [old, next].map((s, i) => ({
    kind: "record",
    entryId: `e${i}`,
    session: "s",
    rec: makeRecord({
      scriptId: s.id,
      at: i,
      origin: "draft",
      templateHash: templateHash(s),
      port: { outcome: "ok", ms: 1, portVer: 1, portId: "jobs.list" },
    }),
  }));
  const evidence = buildLiveEvidence(rows, [], [next]);
  expect(evidence.stats.size).toBe(2);
  expect([...evidence.stats.values()].map((s) => s.judged)).toEqual([1, 1]);
});
it("draft correction survives removal of draft and rewrite as builtin foo with same lineage/template", () => {
  const draft = makeDraft({ id: "draft.x" });
  const builtin = { ...draft, id: "foo", origin: "builtin" as const, lineage: "draft.x" };
  const rows: LiveEvidenceRow[] = Array.from({ length: 50 }, (_, i) => ({
    kind: "record",
    entryId: `e${i}`,
    session: "s",
    rec: makeRecord({
      scriptId: "foo",
      at: i,
      requestDigest: `d${i}`,
      port: { outcome: "ok", ms: 1, portVer: 1, portId: "jobs.list" },
    }),
  }));
  rows.unshift({
    kind: "correction",
    entryId: "c",
    session: "s",
    c: {
      v: 1,
      at: 0,
      targetKind: "shadow",
      targetScriptId: "draft.x",
      targetScriptVer: 1,
      targetDigest: "d",
      deltaMs: 1,
      correctionDigest: "c",
      targetOrigin: "draft",
      targetTemplateHash: templateHash(draft),
    },
  });
  const e = buildLiveEvidence(rows, [builtin], []);
  expect(e.stats.size).toBe(1);
  const s = [...e.stats.values()][0]!;
  expect(identityKey(s.identity)).toBe(`draft.x#${templateHash(draft)}`);
  expect(s.corrected).toBe(1);
  expect(s.judged).toBe(50);
  const verdict = evaluateMergedPromotion({
    identity: { ...s.identity, portVer: 1 },
    live: s,
    port: e.ports.get("jobs.list@1")!,
    scanComplete: true,
  });
  expect(verdict.verdict).toBe("not-eligible");
  expect(verdict.reasons).toContain("corrected");
});
it("missing draft results bind to its port and taint known-version successes", () => {
  const draft = makeDraft({ id: "draft.x" });
  const rows: LiveEvidenceRow[] = [
    {
      kind: "record",
      entryId: "1",
      session: "s",
      rec: makeRecord({ scriptId: draft.id, origin: "draft", templateHash: templateHash(draft) }),
    },
    {
      kind: "record",
      entryId: "2",
      session: "s",
      rec: makeRecord({
        scriptId: draft.id,
        at: 1,
        origin: "draft",
        templateHash: templateHash(draft),
        port: { portId: "jobs.list", portVer: 2, outcome: "ok", ms: 1 },
      }),
    },
  ];
  const e = buildLiveEvidence(rows, [], [draft]);
  expect(e.ports.get("jobs.list@0")?.missing).toBe(1);
  expect(e.ports.get("jobs.list@2")?.missing).toBe(1);
});

it("removed draft still binds a missing result using same-template recorded port evidence", () => {
  const draft = makeDraft({ id: "draft.x" });
  const rows: LiveEvidenceRow[] = [
    {
      kind: "record",
      entryId: "missing",
      session: "s",
      rec: makeRecord({ scriptId: draft.id, origin: "draft", templateHash: templateHash(draft) }),
    },
    {
      kind: "record",
      entryId: "ok",
      session: "s",
      rec: makeRecord({
        scriptId: draft.id,
        at: 1,
        origin: "draft",
        templateHash: templateHash(draft),
        port: { portId: "jobs.list", portVer: 1, outcome: "ok", ms: 1 },
      }),
    },
  ];
  const e = buildLiveEvidence(rows, [], []);
  expect([...e.stats.values()][0]?.judged).toBe(2);
  expect(e.ports.get("jobs.list@0")?.missing).toBe(1);
  expect(e.ports.get("jobs.list@1")?.missing).toBe(1);
});
