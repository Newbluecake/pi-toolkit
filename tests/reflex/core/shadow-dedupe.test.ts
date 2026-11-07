import { expect, it } from "vitest";
import { createRowDeduper } from "../../../src/reflex/core/shadow-dedupe.js";
import { scanReflexLine } from "../../../src/reflex/core/shadow-scan.js";
import { buildLiveEvidence, type LiveEvidenceRow } from "../../../src/reflex/core/promotion.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { makeRecord } from "../helpers/turn.js";

it("id/at/digest dedupes copies even if scriptKey differs; any key component change survives", () => {
  const accept = createRowDeduper();
  const r = { entryId: "e", at: 1, digest: "d", scriptKey: "a" };
  expect(accept(r)).toBe(true);
  expect(accept({ ...r, scriptKey: "b" })).toBe(false);
  expect(accept({ ...r, entryId: "f" })).toBe(true);
  expect(accept({ ...r, at: 2 })).toBe(true);
  expect(accept({ ...r, digest: "other" })).toBe(true);
  expect(createRowDeduper()(r)).toBe(true);
});
it("legacy key includes scriptKey and keeps different timestamps", () => {
  const accept = createRowDeduper();
  const r = { at: 1, digest: "d", scriptKey: "a" };
  expect(accept(r)).toBe(true);
  expect(accept(r)).toBe(false);
  expect(accept({ ...r, scriptKey: "b" })).toBe(true);
  expect(accept({ ...r, at: 2 })).toBe(true);
});
it("scanner → fork copies → V2, while genuinely new cross-session repeats survive", () => {
  const rec = makeRecord({ scriptId: "jobs.list", at: 1, port: { outcome: "ok", ms: 1, portVer: 1 } });
  const scanned = scanReflexLine(
    JSON.stringify({ type: "custom", customType: "subagent:reflex-record", id: "e", data: rec }),
  );
  expect(scanned.entryId).toBe("e");
  expect(scanned.row).toEqual({ kind: "record", rec });
  const rows: LiveEvidenceRow[] = [
    { ...scanned.row!, entryId: "e", session: "a" },
    { ...scanned.row!, entryId: "e", session: "fork" },
    { kind: "record", entryId: "new", session: "b", rec: { ...rec, at: 2 } },
  ];
  const e = buildLiveEvidence(rows, BUILTIN_SCRIPTS, []);
  expect(e.ports.get("jobs.list@1")?.runs).toBe(2);
  expect([...e.stats.values()][0]?.crossSessionRepeats).toBe(1);
});
