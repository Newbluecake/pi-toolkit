import { describe, expect, it } from "vitest";
import { deriveAutoAlias } from "../../src/fabric/xs/alias-auto.js";
import { aliasSuggestions } from "../../src/fabric/xs/alias-suggest.js";

describe("alias-plan §7.1 (ALW): /fabric alias completion hints", () => {
  it("cwd tail first, then the session name's first word, then CJK path runs (deepest first), de-duplicated", () => {
    expect(aliasSuggestions({ cwd: "/home/u/ai/web-前端/admin", sessionName: "Fix login: 登录页" })).toEqual([
      "admin",
      "Fix",
      "前端",
    ]);
    expect(aliasSuggestions({ cwd: "/home/u/项目/前端", sessionName: "前端 调试" })).toEqual(["前端", "项目"]);
  });
  it("missing inputs ⇒ no hints; capped at 8", () => {
    expect(aliasSuggestions({})).toEqual([]);
    expect(aliasSuggestions({ cwd: "/", sessionName: "   " })).toEqual([]);
    const deep = "/" + Array.from({ length: 12 }, (_, i) => `段${"一二三四五六七八九十甲乙"[i]}`).join("/");
    expect(aliasSuggestions({ cwd: deep })).toHaveLength(8);
  });
  it("alias-force-default §5.2-6: the cwd-tail hint ≡ deriveAliasFromDirName (chip and auto agree)", () => {
    expect(aliasSuggestions({ cwd: "/home/u/ai/my.toolkit" })).toEqual(["my-toolkit"]);
    expect(aliasSuggestions({ cwd: "/home/u/ai/My Project" })).toEqual(["my-project"]);
    expect(aliasSuggestions({ cwd: "/home/u/ai/.dotfiles" })).toEqual(["dotfiles"]);
    expect(aliasSuggestions({ cwd: "/home/u/ai/" + "x".repeat(20) })).toEqual(["x".repeat(16)]);
    for (const cwd of ["/home/u/ai/my.toolkit", "/home/u/ai/My Project", "/home/u/ai/web", "/home/u/ai/项目 v2"]) {
      const auto = deriveAutoAlias(cwd);
      expect(auto.ok).toBe(true);
      expect(aliasSuggestions({ cwd })[0]).toBe(auto.ok ? auto.alias : undefined);
    }
  });
  it("a tail that cannot be derived offers no cwd-tail hint (reserved prefix is skipped, not stripped)", () => {
    expect(aliasSuggestions({ cwd: "/home/u/ai/pi.toolkit" })).toEqual([]);
    expect(aliasSuggestions({ cwd: "/home/u/ai/pi-toolkit", sessionName: "Fix login" })).toEqual(["Fix"]);
    expect(deriveAutoAlias("/home/u/ai/pi.toolkit")).toEqual({ ok: false, reason: "invalid" });
    // the other candidate kinds are unchanged: CJK runs of the cwd still appear
    expect(aliasSuggestions({ cwd: "/home/u/项目/pi-toolkit" })).toEqual(["项目"]);
  });
});
