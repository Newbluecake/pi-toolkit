/**
 * web-resume plan v2 §4 P3 — pure logic: the intent matrix, the §2.7 feature signal (old
 * agents ⇒ everything off), palette decoration, the §2.4 FROZEN wire validator,
 * `knownLiveElsewhere` (§7 D5-a), and the i18n parity of BOTH dictionary halves (the eager
 * 2-key `i18n/{en,zh}/resume.ts` + the lazy `i18n/resume-extra.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  decoratePalette,
  parseResumeIntent,
  resumeAvailable,
  type PaletteRowLike,
} from "../../../src/web-hub/ui/src/logic/resume.js";
import { knownLiveElsewhere, validateSessionsWire } from "../../../src/web-hub/ui/src/composables/useResume.js";
import { RESUME_EXTRA } from "../../../src/web-hub/ui/src/i18n/resume-extra.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import enEager from "../../../src/web-hub/ui/src/i18n/en/resume.js";
import zhEager from "../../../src/web-hub/ui/src/i18n/zh/resume.js";

describe("parseResumeIntent (§2.6 intent matrix)", () => {
  const cases: ReadonlyArray<[string, "recent" | "all" | null]> = [
    ["resume", "recent"],
    ["resume --all", "all"],
    ["/resume", "recent"],
    ["/resume --all", "all"],
    ["/resume-recent", "recent"],
    ["/resume-recent --all", "all"],
    ["  resume  ", "recent"],
    ["\t/resume --all \n", "all"],
    // NOT intents — keep today's routing byte-for-byte:
    ["resume-recent", null], // bare alias never existed in the TUI
    ["resume foo", null],
    ["/resume --all extra", null],
    ["/resumeall", null],
    ["/resumes", null],
    ["Resume", null], // case-sensitive, like the TUI commands
    ["please resume", null],
    ["/resume\n\n<attachment>", null], // composed attachment block never matches
    ["", null],
    ["/other", null],
  ];
  it.each(cases)("%j ⇒ %s", (text, scope) => {
    const intent = parseResumeIntent(text);
    if (scope === null) expect(intent).toBeNull();
    else expect(intent).toEqual({ scope });
  });
});

describe("resumeAvailable (§2.7 — status.features resume.v1)", () => {
  it("true only when features carries the token", () => {
    expect(resumeAvailable({ features: ["resume.v1"] })).toBe(true);
    expect(resumeAvailable({ features: ["other.v1", "resume.v1"] })).toBe(true);
  });

  it("false for old agents / feature off (golden old behaviour)", () => {
    expect(resumeAvailable(undefined)).toBe(false);
    expect(resumeAvailable(null)).toBe(false);
    expect(resumeAvailable({})).toBe(false);
    expect(resumeAvailable({ features: undefined })).toBe(false);
    expect(resumeAvailable({ features: "resume.v1" })).toBe(false); // not an array
    expect(resumeAvailable({ features: ["resume.v2"] })).toBe(false);
    expect(resumeAvailable({ busy: true, features: [] })).toBe(false);
  });
});

describe("decoratePalette (§2.6 — /resume rows runnable when available)", () => {
  const rows: readonly PaletteRowLike[] = [
    { name: "resume", description: "", policy: "deny", output: "terminal" },
    { name: "resume-recent", description: "", policy: "deny", output: null },
    { name: "model", description: "switch model", policy: "allow", output: null },
  ];

  it("desc ⇒ the resume rows become allow + described, others untouched", () => {
    const out = decoratePalette(rows, "恢复会话");
    expect(out[0]).toEqual({ name: "resume", description: "恢复会话", policy: "allow", output: "terminal" });
    expect(out[1]).toEqual({ name: "resume-recent", description: "恢复会话", policy: "allow", output: null });
    expect(out[2]).toBe(rows[2]); // untouched reference
  });

  it("desc null (feature off) ⇒ rows unchanged (deny badge stays, old UI behaviour)", () => {
    expect(decoratePalette(rows, null)).toBe(rows);
  });
});

describe("validateSessionsWire (§2.4 FROZEN shape)", () => {
  const valid = {
    v: 1,
    scope: "recent",
    windowHours: 48,
    gen: "g1",
    total: 2,
    rows: [
      { id: "s1", title: "one", titleSource: "name", modifiedMs: 123 },
      { id: "s2", title: "two", titleSource: "first", modifiedMs: 456, current: true, forked: true },
    ],
    provenance: "complete",
    builtAt: 789,
  };

  it("accepts the minimal shape and echoes it", () => {
    expect(validateSessionsWire(valid)).toEqual(valid);
  });

  it("accepts every optional field", () => {
    const w = validateSessionsWire({
      ...valid,
      q: "xx",
      next: "g1.100.h",
      reset: true,
      partial: true,
      truncated: true,
      ambiguous: 2,
    });
    expect(w?.next).toBe("g1.100.h");
    expect(w?.reset).toBe(true);
  });

  it.each([
    ["not an object", null],
    ["not an object", "x"],
    ["v", { ...valid, v: 2 }],
    ["scope", { ...valid, scope: "hour" }],
    ["windowHours", { ...valid, windowHours: 24 }],
    ["gen missing", { ...valid, gen: undefined }],
    ["gen empty", { ...valid, gen: "" }],
    ["total", { ...valid, total: "2" }],
    ["rows", { ...valid, rows: {} }],
    ["row id", { ...valid, rows: [{ ...valid.rows[0], id: "" }] }],
    ["row title", { ...valid, rows: [{ ...valid.rows[0], title: 5 }] }],
    ["row titleSource", { ...valid, rows: [{ ...valid.rows[0], titleSource: "x" }] }],
    ["row modifiedMs", { ...valid, rows: [{ ...valid.rows[0], modifiedMs: NaN }] }],
    ["row current", { ...valid, rows: [{ ...valid.rows[0], current: "yes" }] }],
    ["row forked", { ...valid, rows: [{ ...valid.rows[0], forked: 1 }] }],
    ["q", { ...valid, q: 5 }],
    ["next empty", { ...valid, next: "" }],
    ["reset flag", { ...valid, reset: false }],
    ["partial flag", { ...valid, partial: 1 }],
    ["ambiguous", { ...valid, ambiguous: "2" }],
    ["provenance", { ...valid, provenance: "nope" }],
    ["builtAt", { ...valid, builtAt: Infinity }],
  ])("rejects a bad %s", (_label, bad) => {
    expect(validateSessionsWire(bad)).toBeNull();
  });
});

describe("knownLiveElsewhere (§7 D5-a)", () => {
  const agents = new Map<string, { key: string; down?: boolean; session?: { sessionId?: unknown } }>([
    ["self", { key: "self", session: { sessionId: "s-target" } }],
    ["other", { key: "other", session: { sessionId: "s-target" } }],
    ["down", { key: "down", down: true, session: { sessionId: "s-target" } }],
    ["idle", { key: "idle", session: { sessionId: "s-other" } }],
  ]);

  it("another live card on the same session ⇒ true; self/down/other-session ⇒ false", () => {
    expect(knownLiveElsewhere("s-target", agents, "self")).toBe(true);
    expect(knownLiveElsewhere("s-other", agents, "self")).toBe(true); // idle's session — also live elsewhere
    expect(knownLiveElsewhere("s-private", agents, "self")).toBe(false);
    expect(knownLiveElsewhere("s-gone", agents, "self")).toBe(false);
    expect(knownLiveElsewhere("s-target", undefined, "self")).toBe(false);
    expect(knownLiveElsewhere("", agents, "self")).toBe(false);
  });

  it("only the OTHER card ⇒ that session is not live elsewhere", () => {
    const solo = new Map([["self", { key: "self", session: { sessionId: "s1" } }]]);
    expect(knownLiveElsewhere("s1", solo, "self")).toBe(false);
  });
});

describe("resume i18n parity (eager + lazy halves)", () => {
  const placeholdersOf = (s: string): Set<string> => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));

  it("eager en/zh key sets match", () => {
    expect(Object.keys(zhEager).sort()).toEqual(Object.keys(enEager).sort());
  });

  it("lazy en/zh key sets + placeholders match", () => {
    expect(Object.keys(RESUME_EXTRA.zh).sort()).toEqual(Object.keys(RESUME_EXTRA.en).sort());
    for (const [k, en] of Object.entries(RESUME_EXTRA.en)) {
      expect(placeholdersOf(RESUME_EXTRA.zh[k]!)).toEqual(placeholdersOf(en));
    }
  });

  it("the lazy half registers into MESSAGES.<lang>.resume without clobbering eager keys", async () => {
    const { registerResumeExtra } = await import("../../../src/web-hub/ui/src/i18n/resume-extra.js");
    const before = MESSAGES.en["resume"]?.openTitle;
    registerResumeExtra();
    expect(MESSAGES.en["resume"]?.openTitle).toBe(before); // eager key kept
    expect(typeof MESSAGES.en["resume"]?.dialogTitle).toBe("string");
    expect(typeof MESSAGES.zh["resume"]?.d5Footer).toBe("string");
  });
});
