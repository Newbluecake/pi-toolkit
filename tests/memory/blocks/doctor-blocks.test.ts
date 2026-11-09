// #36 P3 (arch r5 附录 A) — the blocks-only doctor codes D20–D25 and the
// runDoctor blocks dispatch (D01/D02/D09 silent, D17 user-only), plus the
// doctor-golden blocks-*.json (B tier, generate-once:
// PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1; an existing file is NEVER overwritten).
//
// Root ruling 2026-11-06: the goldens are driven through the PURE functions
// (runDoctor blocks dispatch + runDoctorBlocks → formatDoctorReport) — the
// production /mem doctor wiring lands in P4/P5b (doctor-command.ts is outside
// P3's file domain).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  formatDoctorReport,
  runDoctor,
  runDoctorBlocks,
  type DoctorBlocksInput,
  type DoctorSnapshot,
} from "../../../src/memory/doctor.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import { writeBlocksDir, blockRaw, type BlockSpec } from "./helpers.js";
import type { BlocksStateV1, BlocksHoldV1 } from "../../../src/memory/blocks/state.js";

const TODAY = "2026-11-06";
const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function blocksDir(specs: readonly BlockSpec[], extra?: { strays?: readonly string[] }): string {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-doctor-blocks-"));
  tmpRoots.push(tmp);
  // return the realDir (…/mem/blocks) — callers hand it straight to readCorpus
  return writeBlocksDir(join(tmp, "mem"), specs, extra);
}

function input(over: Partial<DoctorBlocksInput> = {}): DoctorBlocksInput {
  return {
    blocks: [],
    strays: [],
    settingsLayout: "blocks",
    rootFileCount: 0,
    residentBytes: 2048,
    today: TODAY,
    ...over,
  };
}

describe("D20 oversize (migration-exempt)", () => {
  test("a >1024B body warns; a 1024B body does not", () => {
    const memDir = blocksDir([
      { id: "quota.001", body: "x".repeat(1024) },
      { id: "quota.002", body: "x".repeat(1025), allowOversize: true },
    ]);
    const corpus = readCorpus(memDir);
    expect(corpus.blocks.map((b) => b.id)).toEqual(["quota.001", "quota.002"]);
    const findings = runDoctorBlocks(input({ blocks: corpus.blocks }));
    const d20 = findings.filter((f) => f.id === "D20");
    expect(d20).toHaveLength(1);
    expect(d20[0]).toMatchObject({ severity: "warn", file: "quota.002.md" });
  });
});

describe("D21 resident budget (main-session口径)", () => {
  test("over budget warns, over 4× errors, within stays silent", () => {
    const memDir = blocksDir(
      Array.from({ length: 5 }, (_, i) => ({
        id: `general.00${i + 1}`,
        authority: "user" as const,
        scope: "global" as const,
        body: `- rule ${i + 1}: ${"x".repeat(400)}`,
      })),
    );
    const blocks = readCorpus(memDir).blocks;
    // 5 × ~400B ⇒ ~2k ⇒ warn at 2048? build a stronger case: same blocks, tiny budget
    const warn = runDoctorBlocks(input({ blocks, residentBytes: 1500 }));
    expect(warn.filter((f) => f.id === "D21").map((f) => f.severity)).toEqual(["warn"]);
    const error = runDoctorBlocks(input({ blocks, residentBytes: 400 }));
    expect(error.filter((f) => f.id === "D21").map((f) => f.severity)).toEqual(["error"]);
    expect(runDoctorBlocks(input({ blocks, residentBytes: 16384 })).filter((f) => f.id === "D21")).toEqual([]);
  });
});

describe("D22 supersededBy edges", () => {
  test("dangling target warns; a→b→a cycle warns; a healthy edge stays silent", () => {
    const memDir = blocksDir([
      { id: "quota.001", supersededBy: "quota.999", body: "- old, target missing" },
      { id: "quota.002", supersededBy: "quota.003", body: "- old in cycle a" },
      { id: "quota.003", supersededBy: "quota.002", body: "- old in cycle b" },
      { id: "quota.004", body: "- new active" },
      { id: "quota.005", supersededBy: "quota.004", body: "- healthy edge to an active block" },
    ]);
    const blocks = readCorpus(memDir).blocks;
    const d22 = runDoctorBlocks(input({ blocks })).filter((f) => f.id === "D22");
    expect(d22.map((f) => f.file).sort()).toEqual(["quota.001.md", "quota.002.md", "quota.003.md"]);
    // quota.005's target exists AND is active ⇒ silent (asserted by its absence above);
    // archived targets are known
    const withArchive = runDoctorBlocks(input({ blocks, archivedIds: ["quota.999"] }));
    expect(withArchive.filter((f) => f.id === "D22" && f.file === "quota.001.md")).toEqual([]);
  });
});

describe("D23 strays and parse errors", () => {
  test("stray files and error-carrying blocks warn; oversize is D20's, not D23's", () => {
    const memDir = blocksDir([{ id: "quota.001", body: "- fine" }], { strays: ["NOTABLOCK.md"] });
    const corpus = readCorpus(memDir);
    const findings = runDoctorBlocks(input({ blocks: corpus.blocks, strays: corpus.strays }));
    const d23 = findings.filter((f) => f.id === "D23");
    expect(d23.map((f) => f.file)).toEqual(["NOTABLOCK.md"]);
    expect(findings.filter((f) => f.id === "D20")).toEqual([]); // not double-reported
  });
});

describe("D23 over-limit section (acceptance fix #3)", () => {
  test("a >120B section reports as D23; D20 stays about the body only", () => {
    // serializeBlock REFUSES an oversize section, so write the file raw —
    // exactly what a hand-edited block looks like on disk.
    const tmp = mkdtempSync(join(tmpdir(), "pi-mem-d23-"));
    tmpRoots.push(tmp);
    const realDir = writeBlocksDir(join(tmp, "mem"), []);
    const longSection = "S".repeat(121);
    writeFileSync(
      join(realDir, "quota.001.md"),
      [
        "---",
        "kind: block",
        "authority: agent",
        `section: ${longSection}`,
        'created: "2026-01-01T00:00:00.000Z"',
        'updated: "2026-01-02T00:00:00.000Z"',
        "version: 1",
        "---",
        "",
        "- fine short body",
        "",
      ].join("\n"),
    );
    const corpus = readCorpus(realDir);
    expect(corpus.blocks[0]!.errors).toContain("E_SECTION_TOO_LARGE");
    const findings = runDoctorBlocks(input({ blocks: corpus.blocks }));
    expect(findings.filter((f) => f.id === "D20")).toEqual([]); // body is fine
    expect(findings.find((f) => f.id === "D23")?.message).toContain("E_SECTION_TOO_LARGE");
  });
});

describe("D24 layout mismatch / rollback snapshot / drift", () => {
  test("all three info lines appear only when their condition holds", () => {
    const memDir = blocksDir([{ id: "quota.001", body: "- fine" }]);
    const blocks = readCorpus(memDir).blocks;
    const all = runDoctorBlocks(input({ blocks, settingsLayout: "tiered", rootFileCount: 17, driftCount: 2 }));
    const d24 = all.filter((f) => f.id === "D24");
    expect(d24).toHaveLength(3);
    expect(d24.every((f) => f.severity === "info")).toBe(true);
    const none = runDoctorBlocks(input({ blocks, settingsLayout: "blocks", rootFileCount: 0, driftCount: 0 }));
    expect(none.filter((f) => f.id === "D24")).toEqual([]);
  });
});

describe("D25 overBudgetStreak / ownerless staging / unfinished rollback", () => {
  test("the three conditions", () => {
    const state: BlocksStateV1 = { v: 1, gen: 4, overBudgetStreak: 3 };
    const hold: BlocksHoldV1 = {
      v: 1,
      at: "2026-11-06T00:00:00.000Z",
      reason: "rollback",
      gen: 4,
      rollback: { from: "blocks", to: ".blocks-rolledback-1", done: false },
    };
    const findings = runDoctorBlocks(input({ state, hold, stagingWithoutOwner: [".blocks-staging-abc"] }));
    const d25 = findings.filter((f) => f.id === "D25");
    expect(d25).toHaveLength(3);
    expect(d25.every((f) => f.severity === "warn")).toBe(true);
    // done:true rollback and streak 2 stay silent
    const quiet = runDoctorBlocks(
      input({
        state: { ...state, overBudgetStreak: 2 },
        hold: { ...hold, rollback: { ...hold.rollback!, done: true } },
      }),
    );
    expect(quiet.filter((f) => f.id === "D25")).toEqual([]);
  });
});

describe("runDoctor blocks dispatch (D01/D02/D09 silent, D17 user-only)", () => {
  const snapshot = (entries: { file: string; authority: "user" | "agent"; expires?: string }[]): DoctorSnapshot => ({
    cwd: "/x",
    files: [
      { name: "core.md", size: 100, meta: { status: "active" } as never, entries: [] },
      ...entries.map((e) => ({
        name: `${e.file}.md`,
        size: 100,
        meta: { status: "active" } as never,
        entries: [
          {
            file: `${e.file}.md`,
            section: "",
            ordinal: 1,
            lineStart: 1,
            lineEnd: 1,
            raw: "x",
            body: "x",
            hash: `h-${e.file}`,
            guardHash: "g",
            inline: e.expires === undefined ? { present: false } : { present: true, expires: e.expires },
            inlineErrors: [],
            authority: e.authority,
            fileStatus: "active",
            secret: false,
            namedPrograms: [],
          },
        ],
      })),
    ],
  });

  test("layout:blocks — D01 degraded-primary stays silent, D17 reports user expiry only", () => {
    const settings = {
      coreBytes: 1600,
      blockBytes: 2400,
      topicWarnBytes: 8000,
      topicMaxBytes: 16000,
      staleDays: 30,
      layout: "blocks" as const,
    };
    // core.md absent ⇒ a pin stand-in would normally D01-info; blocks stays silent
    const pinStandin = {
      cwd: "/x",
      files: [{ name: "notes.md", size: 100, meta: { status: "active", pin: true } as never }],
    };
    expect(runDoctor(pinStandin as DoctorSnapshot, settings).filter((f) => f.id === "D01")).toEqual([]);
    // expired agent + expired user ⇒ only the user one reports under blocks
    const snap = snapshot([
      { file: "agentx", authority: "agent", expires: "2026-11-01" },
      { file: "userx", authority: "user", expires: "2026-11-01" },
    ]);
    const d17 = runDoctor(snap, settings, { today: TODAY }).filter((f) => f.id === "D17");
    expect(d17.map((f) => f.file)).toEqual(["userx.md"]);
    // …while a tiered layout reports both (parity with the pre-#36 behavior)
    const tiered = runDoctor(snap, { ...settings, layout: "tiered" as const }, { today: TODAY }).filter(
      (f) => f.id === "D17",
    );
    expect(tiered.map((f) => f.file).sort()).toEqual(["agentx.md", "userx.md"]);
  });
});

// ───────────────────────── doctor-golden blocks-*.json (generate-once) ─────────────────────────

const GOLDEN_DIR = join(import.meta.dirname, "..", "..", "fixtures", "memory", "doctor-golden");
const UPDATE = process.env.PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN === "1";

function goldenInputs(): { name: string; report: string }[] {
  // blocks-current: D20 + D21(warn) + D22(dangling+cycle) + D23(stray) + D24(×3)
  const currentDir = blocksDir(
    [
      {
        id: "general.001",
        authority: "user",
        scope: "global",
        body: "- 常驻规则：always ask via ask_user before deciding (2026-11-02 用户令)。",
      },
      {
        id: "general.002",
        authority: "user",
        scope: "global",
        body: "- 常驻规则：验收优先 deepseek-flash（2026-11-05 用户令）。",
      },
      { id: "pitfalls.001", supersededBy: "pitfalls.999", body: "- dangling supersede edge" },
      { id: "pitfalls.002", supersededBy: "pitfalls.003", body: "- cycle a" },
      { id: "pitfalls.003", supersededBy: "pitfalls.002", body: "- cycle b" },
      { id: "quota.001", body: "- fine active block" },
      { id: "oversize.001", body: "x".repeat(1100), allowOversize: true },
    ],
    { strays: ["STRAY.md"] },
  );
  const currentCorpus = readCorpus(currentDir);
  const current = runDoctorBlocks(
    input({
      blocks: currentCorpus.blocks,
      strays: currentCorpus.strays,
      settingsLayout: "tiered",
      rootFileCount: 17,
      driftCount: 1,
      residentBytes: 120, // the two resident rules exceed this ⇒ D21 warn
    }),
  );

  // blocks-d25: the three D25 conditions, nothing else
  const d25Dir = blocksDir([{ id: "quota.001", body: "- fine" }]);
  const d25Corpus = readCorpus(d25Dir);
  const d25 = runDoctorBlocks(
    input({
      blocks: d25Corpus.blocks,
      state: { v: 1, gen: 9, overBudgetStreak: 3, lastOutcome: "over-budget", lastAt: "2026-11-06T01:02:03.000Z" },
      hold: {
        v: 1,
        at: "2026-11-06T01:02:03.000Z",
        reason: "rollback",
        gen: 9,
        rollback: { from: "blocks", to: ".blocks-rolledback-1770000000", done: false },
      },
      stagingWithoutOwner: [".blocks-staging-20261106T000000000Z-1234-ab12cd"],
    }),
  );

  return [
    { name: "blocks-current.json", report: formatDoctorReport(current) },
    { name: "blocks-d25.json", report: formatDoctorReport(d25) },
  ];
}

describe("doctor-golden blocks-*.json (generate-once)", () => {
  for (const testCase of goldenInputs()) {
    test(testCase.name, () => {
      const path = join(GOLDEN_DIR, testCase.name);
      if (UPDATE) {
        if (existsSync(path))
          throw new Error(
            `PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1 but ${path} already exists — generate-once, never overwrite`,
          );
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, JSON.stringify({ report: testCase.report }, null, 2) + "\n", "utf8");
        return;
      }
      if (!existsSync(path)) throw new Error(`${path} missing — run once with PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN=1`);
      const golden = JSON.parse(readFileSync(path, "utf8")) as { report: string };
      expect(testCase.report).toBe(golden.report);
    });
  }
});
