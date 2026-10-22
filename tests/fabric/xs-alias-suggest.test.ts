import { describe, expect, it } from "vitest";
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
});
