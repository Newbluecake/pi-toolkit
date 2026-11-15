import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { evaluateRetained, parseArgs, validateSnapshots, run } from "../../../scripts/dev/memory-pe-relevance-eval.mjs";
import { legacyErrorCandidateAllowed } from "../../../src/memory/jev/error-relevance.js";

const snapshot = {
  v: 1,
  id: "e1",
  provenance: "synthetic-selection-time",
  meta: { pending: false, tags: ["deletion"], type: "pitfall" },
  hitTags: ["deletion"],
  highRiskTagIds: ["deletion"],
};
const samples = {
  childP: [{ id: "p1", type: "child", item: { hash: "hp" } }],
  Eall: [{ id: "e1", type: "child", item: { hash: "he" } }],
};
const labels = { p1: { grade: "useful" }, e1: { grade: "neutral" } };

describe("P0 offline retained-only evidence contract", () => {
  it("has no default data/root/output and rejects LIVE/exact/frozen modes", () => {
    expect(() => parseArgs([])).toThrow("Required");
    expect(() => parseArgs(["--live", "yes"])).toThrow("Unknown");
    const args = ["--data", "/tmp/data", "--before-root", "/tmp/b", "--after-root", "/tmp/a", "--out", "/tmp/out"];
    expect(() => parseArgs([...args, "--evidence", "exact-request-replay"])).toThrow("retained-only");
    expect(() => parseArgs([...args, "--evidence", "frozen-answer-counterfactual"])).toThrow("retained-only");
    expect(parseArgs([...args, "--evidence", "retained-only"])["--data"]).toBe("/tmp/data");
  });

  it("retains unknowns in the denominator, never fabricates baseline inputs", () => {
    const result = evaluateRetained(
      samples,
      labels,
      new Map(),
      legacyErrorCandidateAllowed,
      legacyErrorCandidateAllowed,
    );
    expect(result.summary.coverage).toEqual({ originalN: 2, knownN: 0, unknownN: 2 });
    expect(result.summary.tables.childP.recordedBaseline.useful).toBe(1);
    expect(result.summary.tables.childP.usefulRetention).toEqual({ original: 1, retained: 0, unknown: 1 });
    expect(result.summary.tables.Eall.retainedIrrelevantRatio).toBeNull();
    expect(result.summary.retainedRegressionVerdict).toBe("NOT-EVALUATED");
    expect(result.summary.qualityVerdict).toBe("NOT-EVALUATED");
    expect(result.instances.map((row) => row.decision)).toEqual(["unknown", "unknown"]);
  });

  it("uses the production kernel for same-input E parity without inventing P inputs", () => {
    const result = evaluateRetained(
      samples,
      labels,
      validateSnapshots([snapshot]),
      legacyErrorCandidateAllowed,
      legacyErrorCandidateAllowed,
    );
    expect(result.summary.coverage).toEqual({ originalN: 2, knownN: 1, unknownN: 1 });
    expect(result.instances[1]).toMatchObject({
      beforeAllowed: true,
      afterAllowed: true,
      decision: "retained",
      provenance: "synthetic-selection-time",
    });
    expect(result.summary.tables.Eall.retained.neutral).toBe(1);
    expect(result.summary.frozenAnswerAppendix.verdict).toBe("NOT-EVALUATED");
    expect(result.summary.qualityVerdict).toBe("NOT-EVALUATED");
  });

  it("reports a baseline mismatch rather than blessing inconsistent historical inputs", () => {
    const rows = validateSnapshots([{ ...snapshot, hitTags: [] }]);
    const result = evaluateRetained(
      { childP: [], Eall: samples.Eall },
      labels,
      rows,
      legacyErrorCandidateAllowed,
      legacyErrorCandidateAllowed,
    );
    expect(result.summary.tables.Eall.baselineMismatches).toBe(1);
    expect(result.summary.tables.Eall.neutralLossIds).toEqual(["e1"]);
    expect(result.summary.retainedRegressionVerdict).toBe("FAIL");
    expect(result.summary.qualityVerdict).toBe("NOT-EVALUATED");
  });

  it("writes private evidence with hashes, without any network or default user-directory reads", async () => {
    const data = mkdtempSync(join(tmpdir(), "pe-"));
    const out = `${data}-out`;
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      writeFileSync(join(data, "samples.json"), JSON.stringify(samples));
      writeFileSync(join(data, "labels.json"), JSON.stringify(labels));
      const args = [
        "--data",
        data,
        "--before-root",
        root,
        "--after-root",
        root,
        "--evidence",
        "retained-only",
        "--out",
        out,
      ];
      await run(args);
      const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      expect(summary.coverage.unknownN).toBe(2);
      expect(manifest.inputSha256["samples.json"]).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.code.after.sourceSha256["src/memory/jev/error-relevance.ts"]).toMatch(/^[a-f0-9]{64}$/);
      expect(statSync(out).mode & 0o777).toBe(0o700);
      expect(statSync(join(out, "summary.json")).mode & 0o777).toBe(0o600);
      expect(fetch).not.toHaveBeenCalled();
      await expect(run(args)).rejects.toThrow("NEW private");
      await expect(run([...args.slice(0, -1), join(root, "forbidden-eval-output")])).rejects.toThrow("NEW private");
    } finally {
      fetch.mockRestore();
      log.mockRestore();
      rmSync(data, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("rejects missing provenance, raw sidecar-shaped tags, duplicates and missing grades", () => {
    expect(() => validateSnapshots([{ ...snapshot, provenance: "" }])).toThrow("Invalid");
    expect(() =>
      validateSnapshots([{ ...snapshot, meta: { ...snapshot.meta, tags: { deletion: { p: 1 } } } }]),
    ).toThrow("Invalid");
    expect(() => validateSnapshots([snapshot, snapshot])).toThrow("Duplicate");
    expect(() =>
      evaluateRetained(samples, {}, new Map(), legacyErrorCandidateAllowed, legacyErrorCandidateAllowed),
    ).toThrow("unlabelled");
  });
});
