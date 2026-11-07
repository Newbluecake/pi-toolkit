import { describe, expect, it } from "vitest";
import { buildReport, renderReport, renderShow, safeText } from "../../../../src/reflex/core/backtest/report.js";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { templateHash } from "../../../../src/reflex/core/identity.js";
import type { OrchestrateOptions, ScanResult } from "../../../../src/reflex/core/backtest/orchestrate.js";
import { makeTurn } from "../../helpers/turn.js";
import type { ReplayRow } from "../../../../src/reflex/core/types.js";
const scan: ScanResult = {
  corpus: { key: "cache", files: [], turns: [], corrections: [], liveRows: [], counts: {} },
  turns: [],
  corrections: [],
  liveRows: [],
  manifest: { v: 1, normalizeVersion: "n", files: [], manifestHash: "a".repeat(64) },
  scanComplete: true,
  errors: [],
  cacheMode: "cold",
  scannedBytes: 100,
  counts: { train: 1, holdout: 2, unscored: 3 },
  unresolved: { "missing-parent": 1 },
};
const opts: OrchestrateOptions = { builtin: BUILTIN_SCRIPTS, drafts: [], caps: new Set(), portVersions: new Map() };
function row(text: string): ReplayRow {
  return {
    turn: makeTurn({ session: "/home/private/session.jsonl", entryId: "u", text, unknownFacts: ["sourceMode"] }),
    cls: { k: "high", scriptId: "jobs.list", layer: "builtin", agree: "diverge" },
    acceptance: "lenient",
    reasked: false,
    corrected: false,
    suspect: "diverge",
  };
}
describe("B3 export hygiene", () => {
  it("reports aggregate splits, confirmed/lenient, unknown facts and identity tuples", () => {
    const s = BUILTIN_SCRIPTS.find((s) => s.id === "jobs.list")!;
    const identity = { lineage: s.id, templateHash: templateHash(s), portId: s.port.id, portVer: 1 };
    const report = buildReport(
      scan,
      [row("后台状态")],
      opts,
      [{ identity, verdict: "not-eligible", reasons: ["review-incomplete"] }],
      [row("后台状态")],
    );
    expect(report.filters).toEqual({ train: 1, holdout: 2, unscored: 3 });
    expect(report.confirmed).toBe(0);
    expect(report.lenient).toBe(1);
    expect(report.unknownFacts).toEqual({ sourceMode: 1 });
    expect(report.identities[0]?.identity).toEqual({
      lineage: "jobs.list",
      templateHash: identity.templateHash,
      port: "jobs.list@1",
    });
    expect(renderReport(report)).toContain("应用缓存冷");
    expect(report.suspects[0]?.head).toBe("后台状态");
  });
  it("aggregate-only reports have no detail even with suspects", () => {
    expect(buildReport(scan, [row("secret question")], opts).suspects).toEqual([]);
  });
  it("property: exported JSON and markdown never contain slash, home, filename or argv", () => {
    let seed = 123;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 1000; i++) {
      const text = [
        "/home/private/p.jsonl",
        "~/private/session.jsonl",
        "C:\\users\\me",
        "argv=rm -rf /secret",
        "https://user:pwd@host/a",
        "x.jsonl",
        "密码 password=hunter2",
        "😀".repeat(30),
      ][rand() % 8]!;
      const exported = buildReport(scan, [row(text)], opts, [], [row(text)]);
      for (const output of [JSON.stringify(exported), renderReport(exported)]) {
        expect(output).not.toMatch(/\/|~\/|\.jsonl|argv/i);
        expect(output).not.toContain("hunter2");
      }
      expect(Array.from(exported.suspects[0]!.head).length).toBeLessThanOrEqual(24);
    }
  });
  it("redacts before clipping and counts codepoints", () => {
    expect(safeText("password=superSecret " + "😀".repeat(100))).not.toContain("superSecret");
    expect(Array.from(safeText("😀".repeat(50))).length).toBe(24);
  });
  it("local show includes redacted question and shapes, not arguments or envelope", () => {
    const output = renderShow(row("password=superSecret 状态"));
    expect(output).toContain("tools: bash_job:list");
    expect(output).not.toContain("superSecret");
    expect(output).not.toContain("session.jsonl");
    expect(output).toContain("origin=tui split=train");
  });
});
