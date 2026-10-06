import { describe, expect, it } from "vitest";
import {
  MIN_CORE_HANDOFF_CHARS,
  MAX_KEY_FILES,
  MAX_KEY_FILE_CHARS,
  MAX_HANDOFF_CHARS,
  MAX_APPENDIX_SKILLS,
  composeHandoff,
  fileListsFromFileOps,
  renderAppendix,
  renderHandoffCore,
  skillBlocksFromBranch,
  validateHandoff,
} from "../../src/context-switch/handoff.js";

const longGoal = "把 compact-hint 的动作层换成模型自写交接内容的上下文切换工具，替换而非并存。".repeat(2);
const longProgress = "已核实 session_before_compact 可回传 compaction 结果，工具与钩子已落地，正在补测试。".repeat(2);
const longNext = "补齐 handoff/store/hook/tool 四组单测，再跑 typecheck 与全量测试，最后更新文档。".repeat(2);

function validInput(extra: Record<string, unknown> = {}) {
  return { goal: longGoal, progress: longProgress, next_steps: longNext, ...extra };
}

describe("context-switch/handoff", () => {
  it("rejects non-objects and missing required fields with an actionable reason", () => {
    for (const input of [undefined, null, 0, "nope", [], [1]]) {
      const result = validateHandoff(input);
      expect(result.ok).toBe(false);
    }
    const missing = validateHandoff({ goal: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain("progress");
      expect(missing.reason).toContain("next_steps");
      expect(missing.reason).not.toContain("goal（");
    }
  });

  it("rejects a handoff that is too short to replace the conversation", () => {
    const result = validateHandoff({ goal: "改 A", progress: "改了一半", next_steps: "继续改" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(String(MIN_CORE_HANDOFF_CHARS));
  });

  it("counts code points, not UTF-16 units, when measuring length", () => {
    // 60 个星体字符 = 120 UTF-16 units，但只有 60 码点：必须判为过短。
    const astral = "𝔞".repeat(60);
    const result = validateHandoff({ goal: astral, progress: "a", next_steps: "b" });
    expect(result.ok).toBe(false);
  });

  it("normalizes optional fields: trims, drops empties, caps key_files", () => {
    const result = validateHandoff(
      validInput({
        decisions: "   ",
        key_files: [
          "  src/a.ts — 入口  ",
          "",
          7,
          "x".repeat(MAX_KEY_FILE_CHARS + 50),
          ...Array(MAX_KEY_FILES).fill("src/b.ts"),
        ],
        pitfalls: " 别用 newSession ",
        open_questions: "",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions).toBeUndefined();
    expect(result.value.open_questions).toBeUndefined();
    expect(result.value.pitfalls).toBe("别用 newSession");
    expect(result.value.key_files?.[0]).toBe("src/a.ts — 入口");
    expect(result.value.key_files).toHaveLength(MAX_KEY_FILES);
    expect(result.value.key_files?.every((entry) => [...entry].length <= MAX_KEY_FILE_CHARS)).toBe(true);
  });

  it("rejects a non-array key_files", () => {
    expect(validateHandoff(validInput({ key_files: "src/a.ts" })).ok).toBe(false);
  });

  it("renders the core sections and omits absent optional ones", () => {
    const result = validateHandoff(validInput({ decisions: "不新建会话" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const core = renderHandoffCore(result.value);
    expect(core).toContain("# 上下文交接（switch_context）");
    expect(core).toContain("## 当前目标");
    expect(core).toContain("## 进展");
    expect(core).toContain("## 下一步");
    expect(core).toContain("## 已定决策与约束");
    expect(core).not.toContain("## 关键文件");
    expect(core).not.toContain("## 未决问题");
  });

  it("clips an absurdly long handoff", () => {
    const core = renderHandoffCore({
      goal: "g".repeat(MAX_HANDOFF_CHARS),
      progress: "p",
      next_steps: "n",
    });
    expect([...core].length).toBe(MAX_HANDOFF_CHARS);
    expect(core.endsWith("…")).toBe(true);
  });

  it("derives read/modified file lists from pi's fileOps sets, without double-counting", () => {
    const lists = fileListsFromFileOps({
      read: new Set(["a.ts", "b.ts", "c.ts"]),
      written: new Set(["b.ts"]),
      edited: new Set(["c.ts", 42]),
    });
    expect(lists.modifiedFiles.sort()).toEqual(["b.ts", "c.ts"]);
    expect(lists.readFiles).toEqual(["a.ts"]);
    // 宽容任意形状（数组 / 缺字段 / 非对象）。
    expect(fileListsFromFileOps(undefined)).toEqual({ modifiedFiles: [], readFiles: [] });
    expect(fileListsFromFileOps({ read: ["x"] }).readFiles).toEqual(["x"]);
  });

  it("renders an empty appendix as an empty string and skips zero-ish fields", () => {
    expect(renderAppendix({})).toBe("");
    expect(renderAppendix({ tokensBefore: 0, modifiedFiles: [], runs: [] })).toBe("");
  });

  it("renders appendix facts and truncates long lists", () => {
    const rendered = renderAppendix({
      sessionFile: "/tmp/s.jsonl",
      tokensBefore: 123_400,
      modifiedFiles: Array.from({ length: 30 }, (_, index) => `f${index}.ts`),
      runs: ["dev-1 (abcd1234) — running/working"],
      bashJobs: ["deadbeef — npm test"],
      todos: ["#1 写测试 [in_progress]"],
    });
    expect(rendered).toContain("/tmp/s.jsonl");
    expect(rendered).toContain("约 123k tokens");
    expect(rendered).toContain("另有 5 项");
    expect(rendered).toContain("dev-1");
    expect(rendered).toContain("npm test");
    expect(rendered).toContain("#1 写测试");
  });

  it("composes core + appendix and flags a total context drop", () => {
    const composed = composeHandoff("CORE", { sessionFile: "/tmp/s.jsonl", droppedEverything: true });
    expect(composed.startsWith("CORE")).toBe(true);
    expect(composed).toContain("机械附录");
    expect(composed).toContain("丢弃了压缩点之前的**全部**消息");
    // 无附录时不产生空的分隔线。
    const bare = composeHandoff("CORE", {});
    expect(bare).toBe("CORE");
  });

  it("renders no skills line and stays byte-identical to the pre-skills appendix when skills is absent/empty", () => {
    const base = {
      sessionFile: "/tmp/s.jsonl",
      tokensBefore: 123_400,
      modifiedFiles: ["a.ts"],
      readFiles: ["b.ts"],
      runs: ["dev-1 (abcd1234) — running/working"],
    };
    const withoutField = renderAppendix(base);
    const withUndefined = renderAppendix({ ...base, skills: undefined });
    const withEmpty = renderAppendix({ ...base, skills: [] });
    expect(withoutField).not.toContain("在役 skill");
    expect(withUndefined).toBe(withoutField);
    expect(withEmpty).toBe(withoutField);
  });

  it("renders the in-service-skills line before the file lists, capped at MAX_APPENDIX_SKILLS", () => {
    const skills = Array.from({ length: MAX_APPENDIX_SKILLS + 3 }, (_, i) => ({
      name: `skill-${i}`,
      location: `/a/skills/skill-${i}/SKILL.md`,
    }));
    const rendered = renderAppendix({ skills, modifiedFiles: ["x.ts"] });
    expect(rendered).toContain("在役 skill（正文已随切换丢失；继续前先重新 read 这些 SKILL.md）：");
    expect(rendered).toContain("  - skill-0 — /a/skills/skill-0/SKILL.md");
    expect(rendered).toContain("…另 3 个");
    const skillsIdx = rendered.indexOf("在役 skill");
    const filesIdx = rendered.indexOf("改写过的文件");
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(filesIdx).toBeGreaterThan(skillsIdx);
  });

  it("renders a bare skill name (no location) without a dash suffix", () => {
    const rendered = renderAppendix({ skills: [{ name: "agent-handoff" }] });
    expect(rendered).toContain("  - agent-handoff");
    expect(rendered).not.toContain("agent-handoff —");
  });

  it("drops a skill's SKILL.md from the read-files list to avoid duplication", () => {
    const rendered = renderAppendix({
      skills: [{ name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" }],
      readFiles: ["/a/skills/dev-flow/SKILL.md", "/a/other.ts"],
    });
    const skillLines = rendered.split("\n").filter((l) => l.includes("/a/skills/dev-flow/SKILL.md"));
    expect(skillLines).toHaveLength(1);
    expect(rendered).toContain("/a/other.ts");
  });

  describe("skillBlocksFromBranch", () => {
    function userEntry(content: string) {
      return { type: "message", message: { role: "user", content } };
    }

    it("scans user messages in range for pi's expanded /skill:xxx block header", () => {
      const branch = [
        userEntry("hello"),
        userEntry('<skill name="dev-flow" location="/a/skills/dev-flow/SKILL.md">\nbody\n</skill>'),
        { type: "message", message: { role: "assistant", content: [] } },
      ];
      expect(skillBlocksFromBranch(branch, 0, branch.length - 1)).toEqual([
        { name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" },
      ]);
    });

    it("ignores entries outside the range and non-user/malformed entries", () => {
      const branch = [
        userEntry('<skill name="out-of-range" location="/x/SKILL.md">\nbody\n</skill>'),
        userEntry("plain"),
        { type: "compaction" },
      ];
      expect(skillBlocksFromBranch(branch, 1, 2)).toEqual([]);
    });
  });
});
