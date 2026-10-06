import { describe, expect, it, vi } from "vitest";
import { DROP_ALL_SENTINEL, createSwitchContextCompactHook } from "../../src/context-switch/hook.js";
import { PendingHandoffStore } from "../../src/context-switch/store.js";

function event(overrides: Record<string, unknown> = {}) {
  return {
    reason: "manual" as const,
    preparation: {
      firstKeptEntryId: "entry-42",
      tokensBefore: 180_000,
      fileOps: { read: new Set(["r.ts"]), written: new Set(["w.ts"]), edited: new Set<string>() },
    },
    ...overrides,
  };
}

describe("context-switch/hook", () => {
  it("does nothing when no handoff is pending (pi runs its own summary)", () => {
    const store = new PendingHandoffStore();
    const hook = createSwitchContextCompactHook({ store });
    expect(hook(event())).toBeUndefined();
  });

  it("supplies the handoff as the compaction summary and keeps pi's cut point", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE TEXT", keepRecent: true, resume: true });
    const onApplied = vi.fn();
    const hook = createSwitchContextCompactHook({ store, onApplied });
    const result = hook(event());
    expect(result?.compaction.firstKeptEntryId).toBe("entry-42");
    expect(result?.compaction.tokensBefore).toBe(180_000);
    expect(result?.compaction.summary).toContain("CORE TEXT");
    expect(result?.compaction.summary).toContain("w.ts");
    expect(result?.compaction.summary).toContain("r.ts");
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ keepRecent: true, reason: "manual", seq: 1 }));
  });

  it("drops everything before the cut point when keep_recent is false", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: false, resume: true });
    const hook = createSwitchContextCompactHook({ store });
    const result = hook(event());
    expect(result?.compaction.firstKeptEntryId).toBe(DROP_ALL_SENTINEL);
    expect(result?.compaction.summary).toContain("全部**消息");
  });

  it("falls back to the sentinel when pi gives no usable cut point", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const hook = createSwitchContextCompactHook({ store });
    const result = hook(event({ preparation: { firstKeptEntryId: "", tokensBefore: Number.NaN } }));
    expect(result?.compaction.firstKeptEntryId).toBe(DROP_ALL_SENTINEL);
    expect(result?.compaction.tokensBefore).toBe(0);
  });

  it("consumes the handoff so a second compaction never reuses it", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const hook = createSwitchContextCompactHook({ store });
    expect(hook(event())).toBeDefined();
    expect(hook(event())).toBeUndefined();
    expect(store.hasFresh()).toBe(false);
  });

  it("ignores a stale handoff (a threshold compaction minutes later runs pi's summary)", () => {
    let clock = 0;
    const store = new PendingHandoffStore({ ttlMs: 100, now: () => clock });
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    clock = 101;
    const hook = createSwitchContextCompactHook({ store });
    expect(hook(event({ reason: "threshold" }))).toBeUndefined();
  });

  it("serves automatic threshold/overflow compactions with a fresh handoff", () => {
    for (const reason of ["threshold", "overflow"] as const) {
      const store = new PendingHandoffStore();
      store.stage({ core: "CORE", keepRecent: true, resume: true });
      const hook = createSwitchContextCompactHook({ store });
      expect(hook(event({ reason }))?.compaction.summary).toContain("CORE");
    }
  });

  it("degrades silently when the session-facts provider throws", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const hook = createSwitchContextCompactHook({
      store,
      sessionFacts: () => {
        throw new Error("stale ctx");
      },
    });
    const result = hook(event());
    expect(result?.compaction.summary).toContain("CORE");
  });

  it("passes the handler ctx through to the facts provider", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const sessionFacts = vi.fn(() => ({ sessionFile: "/tmp/s.jsonl" }));
    const hook = createSwitchContextCompactHook({ store, sessionFacts });
    const ctx = { marker: true };
    const result = hook(event(), ctx);
    expect(sessionFacts).toHaveBeenCalledWith(ctx);
    expect(result?.compaction.summary).toContain("/tmp/s.jsonl");
  });

  it("identifies in-service skills from touched SKILL.md paths in fileOps", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const readSkillFile = () => "---\nname: dev-flow\n---\n";
    const hook = createSwitchContextCompactHook({ store, readSkillFile });
    const result = hook(
      event({
        preparation: {
          firstKeptEntryId: "entry-42",
          tokensBefore: 1000,
          fileOps: { read: new Set(["/a/skills/dev-flow/SKILL.md"]), written: new Set(), edited: new Set() },
        },
      }),
    );
    expect(result?.compaction.summary).toContain("在役 skill");
    expect(result?.compaction.summary).toContain("dev-flow — /a/skills/dev-flow/SKILL.md");
    // 该 SKILL.md 也在 readFiles 里，不应在「本段读过的文件」里重复出现（整个附录里不应有 "本段读过（未改）的文件" 这条字样行）。
    expect(result?.compaction.summary).not.toContain("本段读过（未改）的文件");
  });

  it("identifies in-service skills from pi's expanded /skill:xxx message blocks in messagesToSummarize", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const hook = createSwitchContextCompactHook({ store });
    const result = hook(
      event({
        preparation: {
          firstKeptEntryId: "entry-42",
          tokensBefore: 1000,
          fileOps: {},
          messagesToSummarize: [
            {
              role: "user",
              content: '<skill name="agent-handoff" location="/a/skills/agent-handoff/SKILL.md">\nbody\n</skill>',
            },
            { role: "assistant", content: [] },
          ],
        },
      }),
    );
    expect(result?.compaction.summary).toContain("agent-handoff");
  });

  it("merges auto-detected skills with the model's reported skills, deduping by name", () => {
    const store = new PendingHandoffStore();
    store.stage({
      core: "CORE",
      keepRecent: true,
      resume: true,
      reportedSkills: [{ name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" }, { name: "manual-skill" }],
    });
    const readSkillFile = () => "---\nname: dev-flow\n---\n";
    const hook = createSwitchContextCompactHook({ store, readSkillFile });
    const result = hook(
      event({
        preparation: {
          firstKeptEntryId: "entry-42",
          tokensBefore: 1000,
          fileOps: { read: new Set(["/a/skills/dev-flow/SKILL.md"]), written: new Set(), edited: new Set() },
        },
      }),
    );
    const summary = result?.compaction.summary ?? "";
    expect(summary).toContain("manual-skill");
    // 并非重复两次 dev-flow条目（自动识别和模型自报指向同一个 name）：只应有一条 "- dev-flow — " 开头的行。
    const devFlowBullets = summary.split("\n").filter((line) => line.trim().startsWith("- dev-flow —"));
    expect(devFlowBullets).toHaveLength(1);
  });

  it("omits the skills line when nothing touched a SKILL.md and nothing was reported", () => {
    const store = new PendingHandoffStore();
    store.stage({ core: "CORE", keepRecent: true, resume: true });
    const hook = createSwitchContextCompactHook({ store });
    const result = hook(event());
    expect(result?.compaction.summary).not.toContain("在役 skill");
  });
});
