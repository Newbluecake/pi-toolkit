import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REPORTED_SKILLS,
  MAX_REPORTED_SKILL_CHARS,
  MAX_SKILL_LOCATION_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_SNIFF_BYTES,
  isSkillMdPath,
  mergeSkillRefs,
  normalizeReportedSkills,
  readSkillFileSniffSync,
  sanitizeSkillRef,
  skillNameFromFrontmatter,
  skillRefFromExpandedBlockText,
  skillRefFromSkillMdPath,
  skillRefsFromTouchedPaths,
  skillRefsFromUserMessages,
  type SkillFileReader,
} from "../../src/context-switch/skills.js";

describe("context-switch/skills", () => {
  describe("readSkillFileSniffSync (real fs)", () => {
    it("reads only the head of a file larger than MAX_SKILL_SNIFF_BYTES", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-toolkit-skills-test-"));
      try {
        const path = join(dir, "SKILL.md");
        const frontmatter = "---\nname: dev-flow\n---\n";
        const body = "x".repeat(MAX_SKILL_SNIFF_BYTES * 4);
        writeFileSync(path, frontmatter + body, "utf8");
        const content = readSkillFileSniffSync(path);
        expect(content).toBeDefined();
        expect(content!.length).toBeLessThanOrEqual(MAX_SKILL_SNIFF_BYTES);
        // 头部仍能解析出 frontmatter name（头部足够小，在整个头部 buffer 里）。
        expect(skillNameFromFrontmatter(content!)).toBe("dev-flow");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("never loads the whole file into memory first (reads a bounded head even for a huge file)", () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-toolkit-skills-test-"));
      try {
        const path = join(dir, "SKILL.md");
        // 远超单次打开/截断的实际问题规模，只是用来验证返回内容确实被扣在 MAX_SKILL_SNIFF_BYTES。
        writeFileSync(path, "y".repeat(MAX_SKILL_SNIFF_BYTES * 10), "utf8");
        const content = readSkillFileSniffSync(path);
        expect(content!.length).toBeLessThanOrEqual(MAX_SKILL_SNIFF_BYTES);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back silently (undefined) when the file does not exist", () => {
      expect(readSkillFileSniffSync("/no/such/path/SKILL.md")).toBeUndefined();
    });

    it("skillRefFromSkillMdPath falls back to the parent directory name when the real read fails", () => {
      const ref = skillRefFromSkillMdPath("/no/such/dev-flow/SKILL.md", readSkillFileSniffSync);
      expect(ref).toEqual({ name: "dev-flow", location: "/no/such/dev-flow/SKILL.md" });
    });
  });

  describe("sanitizeSkillRef", () => {
    it("strips CR/LF and other C0/C1 control characters, including ANSI ESC", () => {
      const ref = sanitizeSkillRef({
        name: "dev\r\n-flow\u001b[31m",
        location: "/a/SKILL\u0007.md",
      });
      expect(ref?.name).not.toMatch(/[\r\n]/);
      // eslint-disable-next-line no-control-regex
      expect(ref?.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      // eslint-disable-next-line no-control-regex
      expect(ref?.location).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });

    it("collapses consecutive whitespace", () => {
      const ref = sanitizeSkillRef({ name: "dev   flow\t\tmulti", location: "/a/b   /SKILL.md" });
      expect(ref?.name).toBe("dev flow multi");
      expect(ref?.location).toBe("/a/b /SKILL.md");
    });

    it("caps name at MAX_SKILL_NAME_CHARS and location at MAX_SKILL_LOCATION_CHARS with an ellipsis", () => {
      const longName = "n".repeat(MAX_SKILL_NAME_CHARS + 50);
      const longLocation = "/" + "p".repeat(MAX_SKILL_LOCATION_CHARS + 50) + "/SKILL.md";
      const ref = sanitizeSkillRef({ name: longName, location: longLocation });
      expect(ref?.name.length).toBe(MAX_SKILL_NAME_CHARS);
      expect(ref?.name.endsWith("…")).toBe(true);
      expect(ref?.location?.length).toBe(MAX_SKILL_LOCATION_CHARS);
      expect(ref?.location?.endsWith("…")).toBe(true);
    });

    it("drops a ref whose name sanitizes down to empty", () => {
      expect(sanitizeSkillRef({ name: "\u0000\u0001\u0002" })).toBeUndefined();
    });

    it("leaves location undefined when absent", () => {
      expect(sanitizeSkillRef({ name: "dev-flow" })).toEqual({ name: "dev-flow" });
    });
  });

  describe("sanitization applied at every source", () => {
    it("sanitizes a name/location resolved from a SKILL.md path's frontmatter", () => {
      const readFile: SkillFileReader = () => "---\nname: dev\r\n-flow\n---\n";
      const ref = skillRefFromSkillMdPath("/a/skills/dev\u001b[31m-flow/SKILL.md", readFile);
      expect(ref?.name).not.toMatch(/[\r\n]/);
      expect(ref?.location).not.toMatch(/\u001b/);
    });

    it("sanitizes a name/location parsed from an expanded /skill:xxx block header", () => {
      const text = '<skill name="dev\r\nflow" location="/a/SKILL\u001b.md">\nbody\n</skill>';
      const ref = skillRefFromExpandedBlockText(text);
      expect(ref?.name).not.toMatch(/[\r\n]/);
      expect(ref?.location).not.toMatch(/\u001b/);
    });

    it("sanitizes a model-reported bare skill name", () => {
      const [ref] = normalizeReportedSkills(["dev\r\nflow\u001b[0m"], () => undefined);
      expect(ref?.name).not.toMatch(/[\r\n]/);
      expect(ref?.name).not.toMatch(/\u001b/);
    });

    it("caps an over-long location resolved from a touched SKILL.md path (source ①)", () => {
      const longPath = `/${"p".repeat(MAX_SKILL_LOCATION_CHARS + 100)}/SKILL.md`;
      const [ref] = skillRefsFromTouchedPaths([longPath], () => undefined);
      expect(ref?.location?.length).toBe(MAX_SKILL_LOCATION_CHARS);
      expect(ref?.location?.endsWith("…")).toBe(true);
      // 读不到文件 ⇒ name 回退父目录名（同样超长），也要被截到 name 上限。
      expect(ref?.name?.length).toBe(MAX_SKILL_NAME_CHARS);
      expect(ref?.name?.endsWith("…")).toBe(true);
    });

    it("caps an over-long location parsed from an expanded /skill:xxx block header (source ②)", () => {
      const longLocation = `/${"q".repeat(MAX_SKILL_LOCATION_CHARS + 100)}/SKILL.md`;
      const ref = skillRefFromExpandedBlockText(`<skill name="dev-flow" location="${longLocation}">`);
      expect(ref?.name).toBe("dev-flow");
      expect(ref?.location?.length).toBe(MAX_SKILL_LOCATION_CHARS);
      expect(ref?.location?.endsWith("…")).toBe(true);
    });

    it("caps reported items at MAX_REPORTED_SKILL_CHARS before path detection: an over-long path degrades to a name (source ③)", () => {
      const longPath = `/${"r".repeat(MAX_REPORTED_SKILL_CHARS + 100)}/SKILL.md`;
      const [ref] = normalizeReportedSkills([longPath], () => undefined);
      // 先截到 512 字符 ⇒ 不再以 /SKILL.md 结尾 ⇒ 当作裸名字处理（同样被清洗、截到 name 上限）。
      expect(ref).toBeDefined();
      expect(ref?.location).toBeUndefined();
      expect(ref?.name?.length).toBe(MAX_SKILL_NAME_CHARS);
      expect(ref?.name?.endsWith("…")).toBe(true);
    });
  });

  describe("isSkillMdPath", () => {
    it("matches paths ending with /SKILL.md or the bare file name", () => {
      expect(isSkillMdPath("/home/u/.agents/skills/dev-flow/SKILL.md")).toBe(true);
      expect(isSkillMdPath("SKILL.md")).toBe(true);
      expect(isSkillMdPath("/home/u/skills/dev-flow/SKILL.md.bak")).toBe(false);
      expect(isSkillMdPath("/home/u/skills/dev-flow/README.md")).toBe(false);
    });
  });

  describe("skillNameFromFrontmatter", () => {
    it("extracts the frontmatter name field", () => {
      const content = "---\nname: dev-flow\ndescription: foo\n---\n\n# body";
      expect(skillNameFromFrontmatter(content)).toBe("dev-flow");
    });

    it("tolerates quotes around the name", () => {
      expect(skillNameFromFrontmatter('---\nname: "dev-flow"\n---\n')).toBe("dev-flow");
      expect(skillNameFromFrontmatter("---\nname: 'dev-flow'\n---\n")).toBe("dev-flow");
    });

    it("returns undefined when there is no frontmatter or no name field", () => {
      expect(skillNameFromFrontmatter("# just a heading")).toBeUndefined();
      expect(skillNameFromFrontmatter("---\ndescription: foo\n---\n")).toBeUndefined();
    });
  });

  describe("skillRefFromSkillMdPath", () => {
    it("prefers the frontmatter name when the file is readable", () => {
      const readFile: SkillFileReader = () => "---\nname: dev-flow\n---\n";
      const ref = skillRefFromSkillMdPath("/a/skills/dev-flow/SKILL.md", readFile);
      expect(ref).toEqual({ name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" });
    });

    it("falls back to the parent directory name when frontmatter has no name", () => {
      const readFile: SkillFileReader = () => "no frontmatter here";
      const ref = skillRefFromSkillMdPath("/a/skills/dev-flow/SKILL.md", readFile);
      expect(ref).toEqual({ name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" });
    });

    it("falls back to the parent directory name when the read fails (silent)", () => {
      const readFile: SkillFileReader = () => {
        throw new Error("EACCES");
      };
      const ref = skillRefFromSkillMdPath("/a/skills/dev-flow/SKILL.md", readFile);
      expect(ref).toEqual({ name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" });
    });

    it("falls back when readFile returns undefined", () => {
      const readFile: SkillFileReader = () => undefined;
      const ref = skillRefFromSkillMdPath("/a/skills/dev-flow/SKILL.md", readFile);
      expect(ref?.name).toBe("dev-flow");
    });

    it("returns undefined for a non-SKILL.md path", () => {
      expect(skillRefFromSkillMdPath("/a/skills/dev-flow/README.md", () => "x")).toBeUndefined();
    });
  });

  describe("skillRefsFromTouchedPaths", () => {
    it("dedupes by path, keeps first-seen order, skips non-SKILL.md paths", () => {
      const readFile: SkillFileReader = (path) =>
        path.includes("dev-flow") ? "---\nname: dev-flow\n---\n" : "---\nname: agent-handoff\n---\n";
      const refs = skillRefsFromTouchedPaths(
        [
          "/a/skills/dev-flow/SKILL.md",
          "/a/src/index.ts",
          "/a/skills/agent-handoff/SKILL.md",
          "/a/skills/dev-flow/SKILL.md",
        ],
        readFile,
      );
      expect(refs).toEqual([
        { name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" },
        { name: "agent-handoff", location: "/a/skills/agent-handoff/SKILL.md" },
      ]);
    });

    it("returns an empty list for an empty/non-matching input", () => {
      expect(skillRefsFromTouchedPaths([], () => undefined)).toEqual([]);
      expect(skillRefsFromTouchedPaths(["/a/src/index.ts"], () => undefined)).toEqual([]);
    });
  });

  describe("skillRefFromExpandedBlockText / skillRefsFromUserMessages", () => {
    it("parses pi's expanded /skill:xxx block header", () => {
      const text = '<skill name="dev-flow" location="/a/skills/dev-flow/SKILL.md">\nbody here\n</skill>';
      expect(skillRefFromExpandedBlockText(text)).toEqual({
        name: "dev-flow",
        location: "/a/skills/dev-flow/SKILL.md",
      });
    });

    it("parses the header even when a trailing user message follows the closing tag", () => {
      const text = '<skill name="dev-flow" location="/a/skills/dev-flow/SKILL.md">\nbody\n</skill>\n\n帮我规划一下开发';
      expect(skillRefFromExpandedBlockText(text)).toEqual({
        name: "dev-flow",
        location: "/a/skills/dev-flow/SKILL.md",
      });
    });

    it("ignores malformed or unrelated text", () => {
      expect(skillRefFromExpandedBlockText("just a normal message")).toBeUndefined();
      expect(skillRefFromExpandedBlockText('<skill name="x">missing location</skill>')).toBeUndefined();
      expect(skillRefFromExpandedBlockText("")).toBeUndefined();
    });

    it("only scans user-role messages, in order, ignoring non-string content", () => {
      const messages = [
        { role: "assistant", content: '<skill name="nope" location="/x/SKILL.md">\n</skill>' },
        { role: "user", content: '<skill name="dev-flow" location="/a/SKILL.md">\nbody\n</skill>' },
        { role: "user", content: "plain follow-up, no skill block" },
        { role: "user", content: [{ type: "text", text: "array content is not scanned" }] },
      ];
      expect(skillRefsFromUserMessages(messages)).toEqual([{ name: "dev-flow", location: "/a/SKILL.md" }]);
    });
  });

  describe("normalizeReportedSkills", () => {
    it("accepts bare names and resolves SKILL.md paths via frontmatter", () => {
      const readFile: SkillFileReader = () => "---\nname: dev-flow\n---\n";
      const refs = normalizeReportedSkills(["agent-handoff", "/a/skills/dev-flow/SKILL.md"], readFile);
      expect(refs).toEqual([{ name: "agent-handoff" }, { name: "dev-flow", location: "/a/skills/dev-flow/SKILL.md" }]);
    });

    it("bounds item count and per-item length", () => {
      const many = Array.from({ length: MAX_REPORTED_SKILLS + 5 }, (_, i) => `skill-${i}`);
      const refs = normalizeReportedSkills(many, () => undefined);
      expect(refs).toHaveLength(MAX_REPORTED_SKILLS);
      // 输入本身被截断到 MAX_REPORTED_SKILL_CHARS，但最终展示的 name 还要经清洗层再截断到 MAX_SKILL_NAME_CHARS。
      const long = "x".repeat(MAX_REPORTED_SKILL_CHARS + 100);
      const [clipped] = normalizeReportedSkills([long], () => undefined);
      expect(clipped?.name.length).toBe(MAX_SKILL_NAME_CHARS);
      expect(clipped?.name.endsWith("…")).toBe(true);
    });

    it("tolerates non-array / non-string entries", () => {
      expect(normalizeReportedSkills(undefined, () => undefined)).toEqual([]);
      expect(normalizeReportedSkills("not-an-array", () => undefined)).toEqual([]);
      expect(normalizeReportedSkills([42, "", "  ", "ok"], () => undefined)).toEqual([{ name: "ok" }]);
    });
  });

  describe("mergeSkillRefs", () => {
    it("dedupes by name, keeping first-seen order across sources", () => {
      const merged = mergeSkillRefs(
        [{ name: "dev-flow", location: "/a/SKILL.md" }],
        [{ name: "agent-handoff" }, { name: "dev-flow", location: "/different/SKILL.md" }],
        [{ name: "third" }],
      );
      expect(merged).toEqual([
        { name: "dev-flow", location: "/a/SKILL.md" },
        { name: "agent-handoff" },
        { name: "third" },
      ]);
    });

    it("handles empty lists", () => {
      expect(mergeSkillRefs([], [], [])).toEqual([]);
      expect(mergeSkillRefs()).toEqual([]);
    });
  });
});
