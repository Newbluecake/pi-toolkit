// #36 P4 (root ruling 2026-11-06) — the `/mem doctor` production wiring's
// blocks branch: a blocks-format directory reports D20–D25 (arch 附录 A)
// through `collectDoctorFindings`; files/absent directories keep the legacy
// path byte-identical. The doctor golden fixtures themselves are P3's
// (tests/memory/blocks/doctor-blocks.test.ts) — this file pins the
// PRODUCTION dispatch only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { collectDoctorFindings } from "../../src/memory/doctor-command.js";
import { formatDoctorReport, summaryLine } from "../../src/memory/doctor.js";
import { writeBlocksDir, type BlockSpec } from "./blocks/helpers.js";
import { writeIndexPatch } from "../../src/memory/jev/index-store.js";
import { entryHash } from "../../src/memory/jev/entries.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(specs: readonly BlockSpec[] = [], extra?: { strays?: readonly string[] }) {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-doctorcmd-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  if (specs.length > 0 || extra !== undefined) writeBlocksDir(memDir, specs, extra);
  return { tmp, cwd, paths, memDir };
}

const settings = (over: Partial<MemorySettings> = {}): MemorySettings => ({
  ...DEFAULT_SETTINGS.memory,
  ...over,
});

describe("collectDoctorFindings — blocks branch (D20–D25)", () => {
  test("a healthy blocks directory reports nothing (layout:blocks)", () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- fine" }]);
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "blocks" }));
    expect(findings).toEqual([]);
    // a tiered SETTING over a blocks directory adds exactly the D24 info line
    const tiered = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "tiered" }));
    expect(tiered.map((f) => f.id)).toEqual(["D24"]);
  });

  test("oversize + stray + tiered-setting D24 + root snapshot D24 all surface", () => {
    const fx = fixture(
      [
        { id: "big.001", body: "x".repeat(1100), allowOversize: true },
        { id: "ok.001", body: "- fine" },
      ],
      { strays: ["STRAY.md"] },
    );
    // root rollback snapshot: two legacy v2 files stay in the memDir root
    writeFileSync(join(fx.memDir, "core.md"), "---\nsource: agent\n---\n\n- legacy\n");
    writeFileSync(join(fx.memDir, "notes.md"), "---\nsource: agent\n---\n\n- legacy\n");
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "tiered" }));
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("D20");
    expect(ids).toContain("D23");
    expect(ids.filter((i) => i === "D24").length).toBeGreaterThanOrEqual(2); // setting mismatch + rollback snapshot
    const report = formatDoctorReport(findings);
    expect(report).toContain("layout setting is tiered but the directory is block-format");
    expect(report).toContain("Root keeps 2 legacy file(s)");
    expect(summaryLine(findings)).toContain("doctor:");
  });

  test("D21 uses the settings residentBytes; D22 needs archived ids from archive/", () => {
    const fx = fixture([
      { id: "gen.001", authority: "user", scope: "global", body: "- " + "a".repeat(500) },
      { id: "gen.002", authority: "user", scope: "global", body: "- " + "b".repeat(500) },
      { id: "old.001", supersededBy: "gone.009", body: "- dangling" },
    ]);
    mkdirSync(join(fx.memDir, "blocks", "archive"), { recursive: true });
    writeFileSync(
      join(fx.memDir, "blocks", "archive", "arch.001.md"),
      "---\nkind: block\nauthority: agent\nstatus: superseded\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nversion: 1\nsupersededBy: gen.001\n---\n\n- archived\n",
    );
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ residentBytes: 512 }));
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("D21");
    expect(ids).toContain("D22");
    // archived id known ⇒ old.001→gone.009 dangles, arch.001→gen.001 resolves
    const d22 = findings.filter((f) => f.id === "D22");
    expect(d22.every((f) => f.message.includes("gone.009"))).toBe(true);
  });

  test("D25: a staging dir without owner.json", () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    mkdirSync(join(fx.memDir, ".blocks-staging-20261106T000000000Z-123-ab12cd"), { recursive: true });
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "blocks" }));
    const d25 = findings.filter((f) => f.id === "D25");
    expect(d25.length).toBe(1);
    expect(d25[0]!.message).toContain("staging dir(s) missing owner.json");
  });

  test("D25 via the production dispatch with a real .blocks-hold + blocks/ still present (fix round: held routes to the blocks branch)", () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    writeFileSync(
      join(fx.memDir, ".blocks-hold"),
      JSON.stringify({
        v: 1,
        at: "2026-11-06T00:00:00.000Z",
        reason: "rollback",
        gen: 2,
        rollback: { from: "blocks", to: ".blocks-rolledback-1770000000", done: false },
      }),
    );
    // dirFormat is now "held" — the dispatch still reports the blocks codes
    // plus the rollback-unfinished hold finding, and NEVER the legacy file
    // codes against the block files.
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "blocks" }));
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("D25");
    expect(findings.some((f) => f.id === "D25" && f.message.includes("Rollback unfinished"))).toBe(true);
    for (const legacy of ["D01", "D04", "D05", "D06", "D11"]) {
      expect(ids).not.toContain(legacy);
    }
  });

  test("D25 fix round 2: held with a COMPLETED rollback and blocks/ gone runs the files doctor (no false D24, legacy codes restored)", () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    // rollback finished: hold says done, blocks/ removed, rolled-back legacy
    // files restored at the root
    rmSync(join(fx.memDir, "blocks"), { recursive: true, force: true });
    writeFileSync(
      join(fx.memDir, ".blocks-hold"),
      JSON.stringify({
        v: 1,
        at: "2026-11-06T00:00:00.000Z",
        reason: "rollback",
        gen: 2,
        rollback: { from: "blocks", to: ".blocks-rolledback-1770000000", done: true },
      }),
    );
    writeFileSync(join(fx.memDir, "core.md"), "---\nsource: agent\n---\n\n## Rules\n\n- one\n");
    writeFileSync(join(fx.memDir, "notes.md"), "---\nsource: agent\n---\n\n## Notes\n\n- a topic file\n");
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings());
    const ids = findings.map((f) => f.id);
    // files-layout doctor: no blocks codes…
    for (const blocksCode of ["D20", "D21", "D22", "D23", "D24", "D25"]) {
      expect(ids).not.toContain(blocksCode);
    }
    // …and the legacy file codes are back (core.md without description/read_when)
    expect(ids).toContain("D06");
  });

  test("D25 fix round 2: held with a COMPLETED rollback but blocks/ still present keeps the blocks dispatch", () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    writeFileSync(
      join(fx.memDir, ".blocks-hold"),
      JSON.stringify({
        v: 1,
        at: "2026-11-06T00:00:00.000Z",
        reason: "rollback",
        gen: 2,
        rollback: { from: "blocks", to: ".blocks-rolledback-1770000000", done: true },
      }),
    );
    // blocks/ is still a real directory — the blocks layout is live, so a
    // tiered setting still reports the D24 setting-mismatch line
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "tiered" }));
    expect(findings.map((f) => f.id)).toContain("D24");
  });

  test("D25 fix round 2: an UNFINISHED rollback reaches the blocks dispatch even without blocks/ (D25 rollback-unfinished stays reachable)", () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    rmSync(join(fx.memDir, "blocks"), { recursive: true, force: true });
    writeFileSync(
      join(fx.memDir, ".blocks-hold"),
      JSON.stringify({
        v: 1,
        at: "2026-11-06T00:00:00.000Z",
        reason: "rollback",
        gen: 2,
        rollback: { from: "blocks", to: ".blocks-rolledback-1770000000", done: false },
      }),
    );
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "blocks" }));
    expect(findings.some((f) => f.id === "D25" && f.message.includes("Rollback unfinished"))).toBe(true);
  });

  test("legacy drift counts changed root files (D24)", () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    // seed the migration report so drift is computable: write a root file whose
    // sha differs from the report's expectation
    const report = {
      files: [{ name: "core.md", sha256: "0".repeat(64) }],
      created: [],
      at: "2026-11-06T00:00:00.000Z",
    };
    writeFileSync(join(fx.memDir, "blocks", ".migration-report.json"), JSON.stringify(report));
    writeFileSync(join(fx.memDir, "core.md"), "---\nsource: agent\n---\n\n- changed after migration\n");
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings());
    expect(findings.some((f) => f.id === "D24" && f.message.includes("Legacy drift: 1 root file(s)"))).toBe(true);
  });

  test("the sidecar (blocks/.jev) does not disturb doctor findings", async () => {
    const fx = fixture([{ id: "ok.001", body: "- fine" }]);
    await writeIndexPatch(fx.memDir, { upsert: {}, lastTaggedAt: "2026-11-06T00:00:00.000Z" });
    expect(collectDoctorFindings(fx.cwd, fx.paths, settings({ layout: "blocks" }))).toEqual([]);
    void entryHash;
  });
});

describe("collectDoctorFindings — files/absent paths unchanged (legacy/tiered goldens intact)", () => {
  test("files directory: the legacy D01/D06 behavior is byte-identical", () => {
    const fx = fixture();
    mkdirSync(fx.memDir, { recursive: true });
    writeFileSync(join(fx.memDir, "core.md"), "---\nsource: agent\n---\n\n## Rules\n\n- one\n");
    writeFileSync(join(fx.memDir, "notes.md"), "---\nsource: agent\n---\n\n## Notes\n\n- a topic file\n");
    const findings = collectDoctorFindings(fx.cwd, fx.paths, settings());
    const ids = findings.map((f) => f.id);
    expect(ids).not.toContain("D20");
    expect(ids).not.toContain("D23");
    expect(ids).not.toContain("D24");
    // a core.md WITHOUT description/read_when hits the legacy D06 pair — the
    // exact pre-#36 codes, proving the files path didn't move
    expect(ids).toContain("D06");
  });

  test("absent directory: empty findings, no throw", () => {
    const fx = fixture();
    expect(collectDoctorFindings(fx.cwd, fx.paths, settings())).toEqual([]);
  });

  test("blocks branch never runs the legacy file codes (no D01/D04/D06/D11 on block files)", () => {
    const fx = fixture([{ id: "core.001", authority: "user", scope: "global", body: "- not a file-layout core" }]);
    const ids = collectDoctorFindings(fx.cwd, fx.paths, settings()).map((f) => f.id);
    for (const legacy of ["D01", "D03", "D04", "D05", "D06", "D07", "D11", "D14"]) {
      expect(ids).not.toContain(legacy);
    }
  });
});
