// D17–D19 + startup-reminder-extension tests (jev-plan §4 J8). D17/D18/D19
// run ONLY when `runDoctor`'s optional `jev` param is present; absent, the
// existing doctor suite + the off-golden harness already pin byte-identical
// output, so this file only adds the jev-present behavior, plus the
// `settingsWarnings` / `JevDoctorPort` extensions to the startup reminder.

import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  runDoctor,
  type DoctorSettings,
  type DoctorSnapshot,
  type DoctorSnapshotFile,
} from "../../src/memory/doctor.js";
import { createStartupReminder } from "../../src/memory/doctor-command.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { splitEntries } from "../../src/memory/jev/entries.js";
import type { JevDoctorPort } from "../../src/memory/jev/contracts.js";
import { materializeEmptyFixture, writeMemAt } from "./helpers/fixture-dir.js";

const SETTINGS: DoctorSettings = {
  coreBytes: 1600,
  blockBytes: 2400,
  topicWarnBytes: 8192,
  topicMaxBytes: 16384,
  staleDays: 60,
};

const NOW_MS = new Date("2026-09-26T00:00:00.000Z").getTime();

function entriesOf(name: string, body: string): DoctorSnapshotFile["entries"] {
  return splitEntries(name, body, { status: "active", handWritten: false });
}

function fileWithEntries(name: string, body: string, over: Partial<DoctorSnapshotFile> = {}): DoctorSnapshotFile {
  return {
    name,
    size: Buffer.byteLength(body, "utf8"),
    meta: { readWhenTerms: [], topic: name, status: "active", pin: false },
    entries: entriesOf(name, body),
    ...over,
  };
}

function snap(files: DoctorSnapshotFile[], over: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
  return { cwd: "/fixture/repo", files, nowMs: NOW_MS, ...over };
}

describe("D17 (expiry)", () => {
  it("expires in the past ⇒ warn, line points at the entry", () => {
    const body = "- rule one <!-- mem expires=2020-01-01 -->\n";
    const findings = runDoctor(snap([fileWithEntries("core.md", body)]), SETTINGS, { today: "2026-09-26" });
    const d17 = findings.filter((f) => f.id === "D17");
    expect(d17).toHaveLength(1);
    expect(d17[0]!.severity).toBe("warn");
    expect(d17[0]!.file).toBe("core.md");
    expect(d17[0]!.line).toBe(entriesOf("core.md", body)![0]!.lineStart);
  });

  it("expires exactly today ⇒ not reported yet", () => {
    const body = "- rule one <!-- mem expires=2026-09-26 -->\n";
    const findings = runDoctor(snap([fileWithEntries("core.md", body)]), SETTINGS, { today: "2026-09-26" });
    expect(findings.filter((f) => f.id === "D17")).toHaveLength(0);
  });

  it("until-only ⇒ info, not warn", () => {
    const body = '- rule one <!-- mem until="v2.0 ships" -->\n';
    const findings = runDoctor(snap([fileWithEntries("core.md", body)]), SETTINGS, { today: "2026-09-26" });
    const d17 = findings.filter((f) => f.id === "D17");
    expect(d17).toHaveLength(1);
    expect(d17[0]!.severity).toBe("info");
  });

  it("absent jev param ⇒ no D17 even with expired entries", () => {
    const body = "- rule one <!-- mem expires=2020-01-01 -->\n";
    const findings = runDoctor(snap([fileWithEntries("core.md", body)]), SETTINGS);
    expect(findings.filter((f) => f.id === "D17")).toHaveLength(0);
  });
});

describe("D18 (inline comment syntax errors)", () => {
  it("unterminated comment ⇒ error, one per inlineErrors entry", () => {
    const body = "- rule one <!-- mem expires=2020-01-01\n";
    const findings = runDoctor(snap([fileWithEntries("core.md", body)]), SETTINGS, { today: "2026-09-26" });
    const d18 = findings.filter((f) => f.id === "D18");
    expect(d18).toHaveLength(1);
    expect(d18[0]!.severity).toBe("error");
    expect(d18[0]!.message).toContain("unterminated");
  });

  it("clean inline comment ⇒ no D18", () => {
    const body = "- rule one <!-- mem user -->\n";
    const findings = runDoctor(snap([fileWithEntries("core.md", body)]), SETTINGS, { today: "2026-09-26" });
    expect(findings.filter((f) => f.id === "D18")).toHaveLength(0);
  });
});

describe("D19 (core usage ≥80%)", () => {
  it("primary at/over 80% of coreBytes, no D02/D03 ⇒ warn", () => {
    const body = "x".repeat(1300); // 1300/1600 ≈ 81%
    const files = [{ ...fileWithEntries("core.md", ""), size: body.length }];
    const findings = runDoctor(snap(files), SETTINGS, { today: "2026-09-26" });
    const d19 = findings.filter((f) => f.id === "D19");
    expect(d19).toHaveLength(1);
    expect(d19[0]!.file).toBe("core.md");
  });

  it("under 80% ⇒ silent", () => {
    const files = [{ ...fileWithEntries("core.md", ""), size: 800 }];
    const findings = runDoctor(snap(files), SETTINGS, { today: "2026-09-26" });
    expect(findings.filter((f) => f.id === "D19")).toHaveLength(0);
  });

  it("suppressed when D02 already fired for the primary", () => {
    const files = [{ ...fileWithEntries("core.md", ""), size: 1300 }];
    const render = {
      text: "",
      bytes: 10,
      level: 1 as const,
      omittedSections: ["Rules"],
      demotedPinned: [],
      fullIndexLines: 0,
      tailKind: "none" as const,
    };
    const findings = runDoctor(snap(files, { render }), SETTINGS, { today: "2026-09-26" });
    expect(findings.filter((f) => f.id === "D19")).toHaveLength(0);
    expect(findings.filter((f) => f.id === "D02")).toHaveLength(1);
  });
});

describe("ID_ORDER", () => {
  it("D17/D18/D19 sort after D14, and findings stay sorted overall", () => {
    const body = "- rule one <!-- mem expires=2020-01-01 -->\n- rule two <!-- mem expires=2020-02-01\n- rule three\n";
    const files = [{ ...fileWithEntries("core.md", body), size: 1300, nlink: 2 }];
    const findings = runDoctor(snap(files), SETTINGS, { today: "2026-09-26" });
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("D17");
    expect(ids).toContain("D18");
    expect(ids).toContain("D19");
    const idxD14 = ids.indexOf("D14");
    const idxD17 = ids.indexOf("D17");
    const idxD18 = ids.indexOf("D18");
    const idxD19 = ids.indexOf("D19");
    expect(idxD14).toBeGreaterThanOrEqual(0);
    expect(idxD17).toBeGreaterThan(idxD14);
    expect(idxD18).toBeGreaterThan(idxD17);
    expect(idxD19).toBeGreaterThan(idxD18);
  });

  it("no jev findings ⇒ ID_ORDER append never shows up (no behavior change)", () => {
    const files = [fileWithEntries("core.md", "- rule one\n")];
    const findings = runDoctor(snap(files), SETTINGS);
    expect(findings.some((f) => f.id === "D17" || f.id === "D18" || f.id === "D19")).toBe(false);
  });
});

// ───────────────────────────── startup reminder extensions (jev-plan §4 J8) ─────────────────────────────

function fakeExtensionContext(over: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  const calls: { message: string; level?: string }[] = [];
  const base = {
    ui: { notify: (message: string, level?: string) => calls.push({ message, level }) },
    hasUI: true,
    cwd: "/fixture/repo",
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as ExtensionCommandContext;
  const ctx = { ...base, ...over };
  (ctx as unknown as { __calls: typeof calls }).__calls = calls;
  return ctx;
}

function notifyCalls(ctx: ExtensionCommandContext): { message: string; level?: string }[] {
  return (ctx as unknown as { __calls: { message: string; level?: string }[] }).__calls;
}

function fakeJevDoctorPort(lines: readonly string[]): JevDoctorPort {
  return { extraReminder: () => lines };
}

describe("createStartupReminder: jev port + settingsWarnings (jev-plan §4 J8)", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:memory-doctor-reminders")];
  });

  it("jev port with no doctor findings: still notifies with just the extra lines", () => {
    const fx = materializeEmptyFixture();
    try {
      writeMemAt(fx.memDir, "core.md", "# Core\n\n## Rules\n\n- rule one\n", "2026-09-01T00:00:00.000Z");
      const reminder = createStartupReminder({
        isChildSession: false,
        paths: fx.paths,
        settings: DEFAULT_SETTINGS.memory,
        now: () => NOW_MS,
        jev: fakeJevDoctorPort(["2 entries expired — /mem expired", "jev 3 suggestions — /mem review"]),
      });
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      reminder.check({ type: "session_start", reason: "new" }, ctx);
      const calls = notifyCalls(ctx);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.message).toContain("2 entries expired");
      expect(calls[0]!.message).toContain("jev 3 suggestions");
    } finally {
      fx.cleanup();
    }
  });

  it("settingsWarnings alone (no jev port, no findings) still notifies, byte-exact single line plus the warning", () => {
    const fx = materializeEmptyFixture();
    try {
      writeMemAt(fx.memDir, "core.md", "# Core\n\n## Rules\n\n- rule one\n", "2026-09-01T00:00:00.000Z");
      const reminder = createStartupReminder({
        isChildSession: false,
        paths: fx.paths,
        settings: DEFAULT_SETTINGS.memory,
        now: () => NOW_MS,
        settingsWarnings: ["memory.jev.classifiers: all entries invalid (…) — jev off"],
      });
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      reminder.check({ type: "session_start", reason: "new" }, ctx);
      const calls = notifyCalls(ctx);
      expect(calls).toEqual([
        { message: "memory.jev.classifiers: all entries invalid (…) — jev off", level: "warning" },
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("no jev port, no settingsWarnings, no findings: never notifies (byte-identical to before)", () => {
    const fx = materializeEmptyFixture();
    try {
      writeMemAt(fx.memDir, "core.md", "# Core\n\n## Rules\n\n- rule one\n", "2026-09-01T00:00:00.000Z");
      const reminder = createStartupReminder({
        isChildSession: false,
        paths: fx.paths,
        settings: DEFAULT_SETTINGS.memory,
        now: () => NOW_MS,
      });
      const ctx = fakeExtensionContext({ cwd: fx.cwd });
      reminder.check({ type: "session_start", reason: "new" }, ctx);
      expect(notifyCalls(ctx)).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
