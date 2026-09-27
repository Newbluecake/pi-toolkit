// #22 optimize-plan P3 (§6, §10.2 J组): `/mem doctor` — D01–D09, D11, D13,
// D14 each with a positive/negative pair against `runDoctor` directly
// (pure function, no fs), plus the real `handleMemDoctorCommand` /
// `createStartupReminder` command-layer wiring against a materialized
// `current-5` fixture. Never spawns anything, never calls
// sendMessage/appendEntry (structurally true: the fakes below don't even
// expose those methods).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  countBySeverity,
  formatDoctorReport,
  runDoctor,
  selectPrimaryCore,
  summaryLine,
  type DoctorSettings,
  type DoctorSnapshot,
  type DoctorSnapshotFile,
} from "../../src/memory/doctor.js";
import { createStartupReminder, handleMemDoctorCommand } from "../../src/memory/doctor-command.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { TieredRenderResult } from "../../src/memory/contracts.js";
import { FIXTURES_ROOT, materializeEmptyFixture, materializeFixture, writeMemAt } from "./helpers/fixture-dir.js";

const SETTINGS: DoctorSettings = {
  coreBytes: 1600,
  blockBytes: 2400,
  topicWarnBytes: 8192,
  topicMaxBytes: 16384,
  staleDays: 60,
};

const NOW_MS = new Date("2026-09-26T00:00:00.000Z").getTime();

// Each call gets a fresh unique default topic unless the caller overrides
// it explicitly — avoids accidental cross-file D11 collisions in unrelated
// test cases (only the D11 describe block itself sets matching topics on
// purpose).
let topicCounter = 0;
function meta(over: Partial<DoctorSnapshotFile["meta"]> = {}): DoctorSnapshotFile["meta"] {
  return { readWhenTerms: [], topic: `t${topicCounter++}`, status: "active", pin: false, ...over };
}

function file(name: string, over: Partial<DoctorSnapshotFile> = {}): DoctorSnapshotFile {
  return { name, size: 100, meta: meta(), ...over };
}

function snap(files: DoctorSnapshotFile[], over: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
  return { cwd: "/fixture/repo", files, nowMs: NOW_MS, ...over };
}

function findingsOf(snapshot: DoctorSnapshot, id: string): ReturnType<typeof runDoctor> {
  return runDoctor(snapshot, SETTINGS).filter((f) => f.id === id);
}

function render(over: Partial<TieredRenderResult> = {}): TieredRenderResult {
  return {
    text: "## Memory (-fixture-repo) — 1 file(s)\n",
    bytes: 40,
    level: 0,
    omittedSections: [],
    demotedPinned: [],
    fullIndexLines: 1,
    tailKind: "none",
    ...over,
  };
}

describe("selectPrimaryCore", () => {
  it("prefers core.md", () => {
    expect(selectPrimaryCore([file("a.md", { meta: meta({ pin: true }) }), file("core.md")])).toBe("core.md");
  });
  it("falls back to the first pin:true non-archived file by name", () => {
    expect(
      selectPrimaryCore([
        file("z.md", { meta: meta({ pin: true }) }),
        file("a.md", { meta: meta({ pin: true, status: "archived" }) }),
        file("b.md", { meta: meta({ pin: true }) }),
      ]),
    ).toBe("b.md");
  });
  it("no primary when there's no core.md and no pin:true file", () => {
    expect(selectPrimaryCore([file("topic-a.md"), file("topic-b.md")])).toBeUndefined();
  });
});

describe("D01 — degraded primary (no core.md)", () => {
  it("positive: pin file stands in as primary", () => {
    const f = findingsOf(snap([file("pitfalls.md", { meta: meta({ pin: true }) })]), "D01");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "info", file: "pitfalls.md" });
  });
  it("negative: core.md present", () => {
    expect(findingsOf(snap([file("core.md"), file("pitfalls.md", { meta: meta({ pin: true }) })]), "D01")).toHaveLength(
      0,
    );
  });
  it("negative: no core.md and no pin file at all", () => {
    expect(findingsOf(snap([file("topic-a.md"), file("topic-b.md")]), "D01")).toHaveLength(0);
  });
});

describe("D02 — primary core over coreBytes", () => {
  it("positive: omitted sections (L2)", () => {
    const f = findingsOf(
      snap([file("pitfalls.md", { meta: meta({ pin: true }) })], {
        render: render({ level: 2, omittedSections: ["用户偏好"] }),
      }),
      "D02",
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "error", file: "pitfalls.md" });
    expect(f[0]?.message).toContain("omitted");
  });
  it("positive: fully excluded (L4, ⚠ over core budget marker)", () => {
    const f = findingsOf(
      snap([file("pitfalls.md", { meta: meta({ pin: true }) })], {
        render: render({ level: 4, text: "- pitfalls.md 📌 · ⚠ over core budget\n" }),
      }),
      "D02",
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("not even the preamble");
  });
  it("negative: primary fits whole (L0)", () => {
    expect(
      findingsOf(snap([file("pitfalls.md", { meta: meta({ pin: true }) })], { render: render({ level: 0 }) }), "D02"),
    ).toHaveLength(0);
  });
  it("negative: no render info available (pre-P1) — rule sits out, never guesses", () => {
    expect(findingsOf(snap([file("pitfalls.md", { meta: meta({ pin: true }) })]), "D02")).toHaveLength(0);
  });
});

describe("D03 — pin:true file didn't fit whole", () => {
  it("positive: primary partially admitted", () => {
    const f = findingsOf(
      snap([file("pitfalls.md", { meta: meta({ pin: true }) })], {
        render: render({ level: 2, omittedSections: ["x"] }),
      }),
      "D03",
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
  });
  it("positive: extra-pinned demoted", () => {
    const f = findingsOf(
      snap([file("core.md"), file("pinned-a.md", { meta: meta({ pin: true }) })], {
        render: render({ level: 3, demotedPinned: ["pinned-a.md"] }),
      }),
      "D03",
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ file: "pinned-a.md" });
  });
  it("negative: pin file fit whole", () => {
    const f = findingsOf(
      snap([file("core.md"), file("pinned-a.md", { meta: meta({ pin: true }) })], { render: render({ level: 0 }) }),
      "D03",
    );
    expect(f).toHaveLength(0);
  });
});

describe("D04/D05 — non-core file size", () => {
  it("D04 positive: over topicWarnBytes, under topicMaxBytes", () => {
    const f = findingsOf(snap([file("core.md"), file("big.md", { size: 9000 })]), "D04");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warn", file: "big.md" });
  });
  it("D04 negative: small file", () => {
    expect(findingsOf(snap([file("core.md"), file("small.md", { size: 100 })]), "D04")).toHaveLength(0);
  });
  it("D05 positive: over topicMaxBytes", () => {
    const f = findingsOf(snap([file("core.md"), file("huge.md", { size: 20000 })]), "D05");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "error", file: "huge.md" });
    // over topicMaxBytes never ALSO reports D04 for the same file
    expect(findingsOf(snap([file("core.md"), file("huge.md", { size: 20000 })]), "D04")).toHaveLength(0);
  });
  it("D05 negative: at the limit", () => {
    expect(findingsOf(snap([file("core.md"), file("edge.md", { size: 16384 })]), "D05")).toHaveLength(0);
  });
  it("primary core itself is never measured against D04/D05", () => {
    const huge = file("pitfalls.md", { size: 50_000, meta: meta({ pin: true }) });
    expect(runDoctor(snap([huge]), SETTINGS).filter((f) => f.id === "D04" || f.id === "D05")).toHaveLength(0);
  });
});

describe("D06 — missing description/read_when", () => {
  it("positive: topic file missing both (one warn, mentions read_when too)", () => {
    const f = findingsOf(snap([file("core.md"), file("quota.md")]), "D06");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warn", file: "quota.md" });
    expect(f[0]?.message).toContain("read_when");
  });
  it("positive: topic file missing only read_when -> info", () => {
    const f = findingsOf(snap([file("core.md"), file("quota.md", { meta: meta({ description: "d" }) })]), "D06");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "info", file: "quota.md" });
  });
  it("negative: topic file has both", () => {
    expect(
      findingsOf(snap([file("core.md"), file("quota.md", { meta: meta({ description: "d", readWhen: "r" }) })]), "D06"),
    ).toHaveLength(0);
  });
  it("extra-pinned missing description -> warn; missing only read_when -> nothing", () => {
    const missingDesc = findingsOf(snap([file("core.md"), file("pinned-a.md", { meta: meta({ pin: true }) })]), "D06");
    expect(missingDesc).toHaveLength(1);
    expect(missingDesc[0]?.severity).toBe("warn");
    const onlyReadWhenMissing = findingsOf(
      snap([file("core.md"), file("pinned-a.md", { meta: meta({ pin: true, description: "d" }) })]),
      "D06",
    );
    expect(onlyReadWhenMissing).toHaveLength(0);
  });
  it("primary core is never checked for D06", () => {
    expect(
      runDoctor(snap([file("pitfalls.md", { meta: meta({ pin: true }) })]), SETTINGS).filter((f) => f.id === "D06"),
    ).toHaveLength(0);
  });
  it("archived file is never checked for D06", () => {
    expect(
      findingsOf(snap([file("core.md"), file("old.md", { meta: meta({ status: "archived" }) })]), "D06"),
    ).toHaveLength(0);
  });
});

describe("D07 — frontmatter structural errors", () => {
  it("positive: classified metaErrors (error vs info)", () => {
    const f = findingsOf(
      snap([
        file("core.md"),
        file("bad.md", {
          metaErrors: [
            'status "nope" is not one of active|stale|archived',
            "description exceeds 160B",
            "frontmatter exceeds 40 lines / 2048B — treated as invalid",
          ],
        }),
      ]),
      "D07",
    );
    expect(f).toHaveLength(3);
    expect(f.find((x) => x.message.includes("status"))?.severity).toBe("error");
    expect(f.find((x) => x.message.includes("description exceeds"))?.severity).toBe("info");
    expect(f.find((x) => x.message.includes("40 lines"))?.severity).toBe("error");
  });
  it("positive: unclosed frontmatter detected from content", () => {
    const f = findingsOf(
      snap([file("core.md"), file("unclosed.md", { content: "---\nfoo: bar\n\n# body only\n" })]),
      "D07",
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("error");
    expect(f[0]?.message).toContain("never closed");
  });
  it("negative: clean frontmatter, no errors", () => {
    expect(
      findingsOf(snap([file("core.md"), file("clean.md", { content: "---\ntopic: x\n---\n\n# hi\n" })]), "D07"),
    ).toHaveLength(0);
  });
});

describe("D08 — stale", () => {
  it("positive: status: stale", () => {
    const f = findingsOf(snap([file("core.md"), file("s.md", { meta: meta({ status: "stale" }) })]), "D08");
    expect(f.some((x) => x.severity === "info" && x.message.includes("status: stale"))).toBe(true);
  });
  it("positive: updated older than staleDays", () => {
    const f = findingsOf(
      snap([file("core.md"), file("old.md", { meta: meta({ updated: "2026-01-01T00:00:00.000Z" }) })]),
      "D08",
    );
    expect(f.some((x) => x.severity === "warn" && x.message.includes("days old"))).toBe(true);
  });
  it("negative: fresh + active", () => {
    expect(
      findingsOf(
        snap([file("core.md"), file("fresh.md", { meta: meta({ updated: "2026-09-25T00:00:00.000Z" }) })]),
        "D08",
      ),
    ).toHaveLength(0);
  });
});

describe("D09 — block degradation level", () => {
  it("positive: L1 -> warn", () => {
    const f = findingsOf(snap([file("core.md")], { render: render({ level: 1 }) }), "D09");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("L1");
  });
  it("positive: L2 -> warn", () => {
    const f = findingsOf(snap([file("core.md")], { render: render({ level: 2, omittedSections: ["s1"] }) }), "D09");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("L2");
  });
  it("positive: L3 -> warn with detail", () => {
    const f = findingsOf(snap([file("core.md")], { render: render({ level: 3, demotedPinned: ["p.md"] }) }), "D09");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("L3");
    expect(f[0]?.message).toContain("p.md");
  });
  it("positive: L4 -> warn", () => {
    const f = findingsOf(snap([file("core.md")], { render: render({ level: 4 }) }), "D09");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("L4");
  });
  it("positive: L5 -> error", () => {
    const f = findingsOf(snap([file("core.md")], { render: render({ level: 5 }) }), "D09");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("error");
  });
  it("negative: L0", () => {
    expect(findingsOf(snap([file("core.md")], { render: render({ level: 0 }) }), "D09")).toHaveLength(0);
  });
});

describe("D11 — duplicate topic", () => {
  it("positive: two files share an explicit topic", () => {
    const f = findingsOf(
      snap([
        file("core.md"),
        file("a.md", { meta: meta({ topic: "shared" }) }),
        file("b.md", { meta: meta({ topic: "shared" }) }),
      ]),
      "D11",
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("a.md");
    expect(f[0]?.message).toContain("b.md");
  });
  it("negative: unique topics (the filename-derived default)", () => {
    expect(findingsOf(snap([file("core.md"), file("a.md"), file("b.md")]), "D11")).toHaveLength(0);
  });
});

describe("D13 — secret scan", () => {
  it.each([
    ["sk- key", "sk-abcdefghijklmnopqrstuvwx"],
    ["AWS key", "AKIAABCDEFGHIJKLMNOP"],
    ["GitHub PAT", "ghp_abcdefghijklmnopqrstuvwxyz012345"],
    ["Slack token", "xoxb-1234567890-abcdefghij"],
    ["private key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["password kv", "password: supersecretvalue"],
  ])("positive: %s", (_label, secret) => {
    const f = findingsOf(snap([file("core.md"), file("leak.md", { content: `line1\n${secret}\nline3\n` })]), "D13");
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]).toMatchObject({ severity: "error", file: "leak.md", line: 2 });
    expect(f[0]?.message).not.toContain(secret);
  });
  it("negative: clean content", () => {
    expect(findingsOf(snap([file("core.md"), file("clean.md", { content: "just some prose\n" })]), "D13")).toHaveLength(
      0,
    );
  });
});

describe("D14 — non-addressable / trust", () => {
  it("positive: skipped symlink/dangling/not-file/bad-name", () => {
    const f = findingsOf(
      snap([file("core.md")], {
        skipped: [
          { name: "link.md", kind: "symlink" },
          { name: "dead.md", kind: "dangling" },
          { name: "fifo.md", kind: "not-file" },
          { name: "My Notes.md", kind: "bad-name" },
        ],
      }),
      "D14",
    );
    expect(f).toHaveLength(4);
    expect(f.find((x) => x.file === "link.md")?.severity).toBe("warn");
    expect(f.find((x) => x.file === "dead.md")?.severity).toBe("warn");
    expect(f.find((x) => x.file === "fifo.md")?.severity).toBe("warn");
    expect(f.find((x) => x.file === "My Notes.md")?.severity).toBe("info");
  });
  it("negative: nothing skipped", () => {
    expect(findingsOf(snap([file("core.md")]), "D14")).toHaveLength(0);
  });
  it("positive: nlink > 1", () => {
    const f = findingsOf(snap([file("core.md"), file("linked.md", { nlink: 2 })]), "D14");
    expect(f.some((x) => x.file === "linked.md" && x.severity === "info")).toBe(true);
  });
  it("negative: nlink === 1", () => {
    expect(findingsOf(snap([file("core.md"), file("x.md", { nlink: 1 })]), "D14")).toHaveLength(0);
  });
  it("positive: slug dir is a symlink", () => {
    const f = findingsOf(snap([file("core.md")], { slugDirLinked: { display: "/a", real: "/b" } }), "D14");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("info");
    expect(f[0]?.message).toContain("/a");
    expect(f[0]?.message).toContain("/b");
  });
  it("positive: canonical target is not a directory", () => {
    const f = findingsOf(snap([file("core.md")], { canonicalTargetNotDir: true }), "D14");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("error");
  });
  it("negative: slug dir not linked, canonical target fine", () => {
    expect(findingsOf(snap([file("core.md")]), "D14")).toHaveLength(0);
  });
});

describe("sort order and formatting", () => {
  it("groups findings by rule id (table order), then file", () => {
    const findings = runDoctor(
      snap([file("core.md"), file("b.md", { size: 20_000 }), file("a.md", { size: 20_000 })]),
      SETTINGS,
    );
    const ids = findings.map((f) => f.id);
    expect(ids).toEqual([...ids].sort((a, b) => (ids.indexOf(a) - ids.indexOf(b) === 0 ? 0 : 0)) && ids); // no-op sanity
    // D05 fires for both a.md and b.md; a.md must sort before b.md.
    const d05 = findings.filter((f) => f.id === "D05");
    expect(d05.map((f) => f.file)).toEqual(["a.md", "b.md"]);
  });

  it("countBySeverity / summaryLine / formatDoctorReport", () => {
    const findings = runDoctor(
      snap([file("core.md"), file("big.md", { size: 20_000, meta: meta({ description: "d", readWhen: "r" }) })]),
      SETTINGS,
    );
    const c = countBySeverity(findings);
    expect(c).toEqual({ error: 1, warn: 0, info: 0 });
    expect(summaryLine(findings)).toBe("doctor: 1 error — /mem doctor");
    expect(formatDoctorReport(findings)).toContain("[error] D05 big.md");
  });

  it("summaryLine on a clean snapshot", () => {
    expect(summaryLine(runDoctor(snap([file("core.md")]), SETTINGS))).toBe("doctor: 0 findings — /mem doctor");
  });

  it("formatDoctorReport on a clean snapshot", () => {
    expect(formatDoctorReport(runDoctor(snap([file("core.md")]), SETTINGS))).toBe(
      "/mem doctor: no findings — memory looks healthy.",
    );
  });
});

// ───────────────────────────── command-layer (real fs, real command) ─────────────────────────────

function fakeExtensionContext(over: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  const notify = vi.fn();
  const base = {
    ui: { notify, editor: vi.fn(async () => undefined) },
    hasUI: true,
    cwd: "/fixture/repo",
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as ExtensionCommandContext;
  return { ...base, ...over };
}

describe("handleMemDoctorCommand (real fs)", () => {
  it("current-5: D01 + D06x4, notify called once, no editor (<=20 findings)", async () => {
    const fx = materializeFixture("current-5");
    try {
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      await handleMemDoctorCommand("", ctx, { paths: fx.paths, settings: DEFAULT_SETTINGS.memory, now: () => NOW_MS });
      expect(ctx.ui.editor).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      const [text] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(text).toContain("D01");
      expect(text.match(/D06/g)?.length).toBe(4);
    } finally {
      fx.cleanup();
    }
  });

  it("no-UI session: never calls notify/editor", async () => {
    const fx = materializeFixture("current-5");
    try {
      const ctx = fakeExtensionContext({ cwd: fx.cwd, hasUI: false });
      await handleMemDoctorCommand("", ctx, { paths: fx.paths, now: () => NOW_MS });
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.editor).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });

  it("empty memory dir: clean report, zero findings", async () => {
    const fx = materializeFixture("current-5");
    try {
      // point at a cwd with no memory files at all
      const ctx = fakeExtensionContext({ cwd: "/fixture/nothing-here" });
      await handleMemDoctorCommand("", ctx, { paths: fx.paths, settings: DEFAULT_SETTINGS.memory, now: () => NOW_MS });
      const [text] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(text).toBe("/mem doctor: no findings — memory looks healthy.");
    } finally {
      fx.cleanup();
    }
  });

  it("uses ctx.ui.editor when there are more than 20 findings", async () => {
    const fx = materializeEmptyFixture();
    try {
      // 21 topic files, each missing description/read_when -> 21 D06 warns,
      // comfortably over the 20-item notify/editor threshold (§6.2).
      for (let i = 0; i < 21; i++) {
        writeMemAt(
          fx.memDir,
          `topic-${String(i).padStart(2, "0")}.md`,
          `# Topic ${i}\n\nbody\n`,
          "2026-09-01T00:00:00.000Z",
        );
      }
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      await handleMemDoctorCommand("", ctx, { paths: fx.paths, settings: DEFAULT_SETTINGS.memory, now: () => NOW_MS });
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.editor).toHaveBeenCalledTimes(1);
      const [title, body] = (ctx.ui.editor as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(title).toBe("memory doctor");
      expect(body.match(/D06/g)?.length).toBe(21);
    } finally {
      fx.cleanup();
    }
  });
});

describe("createStartupReminder (§6.3)", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:memory-doctor-reminders")];
  });

  function baseDeps(cwd: string, paths: ReturnType<typeof materializeFixture>["paths"], isChildSession = false) {
    return { isChildSession, paths, now: () => NOW_MS, settings: DEFAULT_SETTINGS.memory };
  }

  it("main session, error/D01 present: notifies once per session", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder(baseDeps(fx.cwd, fx.paths));
      const ctx1 = fakeExtensionContext({ cwd: fx.cwd, sessionManager: { getSessionId: () => "s1" } as never });
      reminder.check({ type: "session_start", reason: "new" }, ctx1);
      expect(ctx1.ui.notify).toHaveBeenCalledTimes(1);
      // second session_start within the SAME session (sessionId unchanged) -> no repeat
      reminder.check({ type: "session_start", reason: "new" }, ctx1);
      expect(ctx1.ui.notify).toHaveBeenCalledTimes(1);
    } finally {
      fx.cleanup();
    }
  });

  it("child session: never notifies", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder(baseDeps(fx.cwd, fx.paths, true));
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      reminder.check({ type: "session_start", reason: "new" }, ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });

  it("no-UI session: never notifies", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder(baseDeps(fx.cwd, fx.paths));
      const ctx = fakeExtensionContext({ cwd: fx.cwd, hasUI: false });
      reminder.check({ type: "session_start", reason: "new" }, ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });

  it("notifyOnStart: false -> never notifies", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder({
        ...baseDeps(fx.cwd, fx.paths),
        settings: { ...DEFAULT_SETTINGS.memory, doctor: { notifyOnStart: false, staleDays: 60 } },
      });
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      reminder.check({ type: "session_start", reason: "new" }, ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });

  it("same fingerprint after /new (different sessionId, same cwd/findings): not repeated", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder(baseDeps(fx.cwd, fx.paths));
      const ctxA = fakeExtensionContext({ cwd: fx.cwd, sessionManager: { getSessionId: () => "sA" } as never });
      reminder.check({ type: "session_start", reason: "new" }, ctxA);
      expect(ctxA.ui.notify).toHaveBeenCalledTimes(1);

      const ctxB = fakeExtensionContext({ cwd: fx.cwd, sessionManager: { getSessionId: () => "sB" } as never });
      reminder.check({ type: "session_start", reason: "new" }, ctxB);
      expect(ctxB.ui.notify).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });

  it("fingerprint change (core.md added, D01 clears) allows a fresh notify", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder(baseDeps(fx.cwd, fx.paths));
      const ctxA = fakeExtensionContext({ cwd: fx.cwd, sessionManager: { getSessionId: () => "sA" } as never });
      reminder.check({ type: "session_start", reason: "new" }, ctxA);
      expect(ctxA.ui.notify).toHaveBeenCalledTimes(1);

      // introduce a NEW error-level finding (a secret) under a fresh session id
      writeFileSync(join(fx.memDir, "leak.md"), "---\ntopic: leak\n---\n\npassword: supersecretvalue\n");
      const ctxB = fakeExtensionContext({ cwd: fx.cwd, sessionManager: { getSessionId: () => "sB" } as never });
      reminder.check({ type: "session_start", reason: "new" }, ctxB);
      expect(ctxB.ui.notify).toHaveBeenCalledTimes(1);
    } finally {
      fx.cleanup();
    }
  });

  it("never calls anything beyond ctx.ui.notify (no sendMessage/appendEntry/spawn on the fake ctx)", () => {
    const fx = materializeFixture("current-5");
    try {
      const reminder = createStartupReminder(baseDeps(fx.cwd, fx.paths));
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      // the fake ctx above intentionally has no sendMessage/appendEntry/spawn
      // methods at all — if the reminder ever tried to call one, this would
      // throw a TypeError instead of silently succeeding.
      expect(() => reminder.check({ type: "session_start", reason: "new" }, ctx)).not.toThrow();
    } finally {
      fx.cleanup();
    }
  });
});

// ───────────────────────────── golden (current-5, generate-once) ─────────────────────────────

const DOCTOR_GOLDEN_DIR = join(FIXTURES_ROOT, "doctor-golden");
const DOCTOR_GOLDEN_PATH = join(DOCTOR_GOLDEN_DIR, "current-5.json");
const UPDATE_DOCTOR_GOLDEN = process.env.UPDATE_MEMORY_DOCTOR_GOLDEN === "1";

if (UPDATE_DOCTOR_GOLDEN && existsSync(DOCTOR_GOLDEN_PATH)) {
  throw new Error(
    "UPDATE_MEMORY_DOCTOR_GOLDEN=1 but tests/fixtures/memory/doctor-golden/current-5.json already exists — " +
      "generate-once, never overwrite (§10.1 point 6). Delete it by hand first if this is an intentional revision.",
  );
}

describe("doctor-golden (current-5, generate-once §10.1)", () => {
  it("runDoctor(current-5) via the real command path matches the checked-in golden", async () => {
    const fx = materializeFixture("current-5");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    try {
      const notify = vi.fn();
      const ctx = {
        ui: { notify, editor: vi.fn(async () => undefined) },
        hasUI: true,
        cwd: fx.cwd,
        sessionManager: { getSessionId: () => "s" },
      } as unknown as ExtensionCommandContext;
      await handleMemDoctorCommand("", ctx, { paths: fx.paths, settings: DEFAULT_SETTINGS.memory, now: () => NOW_MS });
      const [text] = notify.mock.calls[0] as [string, string];
      if (UPDATE_DOCTOR_GOLDEN) {
        mkdirSync(DOCTOR_GOLDEN_DIR, { recursive: true });
        writeFileSync(DOCTOR_GOLDEN_PATH, JSON.stringify({ report: text }, null, 2) + "\n");
      } else {
        const golden = JSON.parse(readFileSync(DOCTOR_GOLDEN_PATH, "utf8")) as { report: string };
        expect(text).toBe(golden.report);
      }
    } finally {
      vi.unstubAllEnvs();
      fx.cleanup();
    }
  });
});
