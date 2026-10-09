import { describe, expect, it } from "vitest";
import {
  ANAPHORA_CJK,
  ANAPHORA_EN,
  SHORT_REPLY_TABLE,
  assistantAsked,
  classifyText,
  hasAnaphora,
  isShortReply,
  sourceAllowed,
} from "../../src/topic-switch/filters.js";
import type { InputSourceLike } from "../../src/topic-switch/types.js";

describe("sourceAllowed (I1)", () => {
  it("origin input: interactive/rpc held, extension skipped", () => {
    expect(sourceAllowed("input", "interactive")).toBe(true);
    expect(sourceAllowed("input", "rpc")).toBe(true);
    expect(sourceAllowed("input", "extension")).toBe(false);
  });
  it("origin web: always allowed (claimed at the dispatch point, I2)", () => {
    for (const source of ["interactive", "rpc", "extension"] as const satisfies readonly InputSourceLike[]) {
      expect(sourceAllowed("web", source)).toBe(true);
    }
  });
});

describe("classifyText", () => {
  it("prefix: /, //, ! after trim", () => {
    expect(classifyText("/topic-switch status", 0, 8)).toBe("prefix");
    expect(classifyText("//literal slash", 0, 8)).toBe("prefix");
    expect(classifyText("!bash ls", 0, 8)).toBe("prefix");
    expect(classifyText("  /cmd  ", 0, 8)).toBe("prefix");
    expect(classifyText("1/2 比例怎么调", 0, 8)).not.toBe("prefix"); // 非开头
  });

  it("short: code points < minChars (astral chars count as one each)", () => {
    expect(classifyText("好的", 0, 8)).toBe("short");
    expect(classifyText("continue", 0, 8)).toBe("continuation"); // 8 cp passes the length gate, then hits the EN table
    expect(classifyText("continue !", 0, 8)).toBe("continuation"); // whole word split is whitespace-based
    expect(classifyText("continue!", 0, 8)).toBe("ok"); // documented edge: no-space form matches neither rule
    expect(classifyText("七个字七个字七", 0, 8)).toBe("short"); // 7 cp
    expect(classifyText("😀😀😀😀😀😀😀", 0, 8)).toBe("short"); // 7 code points (surrogate pairs)
    expect(classifyText("😀😀😀😀😀😀😀😀", 0, 8)).not.toBe("short"); // 8 code points
  });

  it("short: pure images are short (images do not rescue length)", () => {
    expect(classifyText("", 3, 8)).toBe("short");
    expect(classifyText("", 0, 0)).toBe("ok"); // minChars 0 disables the length gate entirely
  });

  it("table: whole-sentence short replies with trailing punctuation and case", () => {
    expect(classifyText("好的。", 0, 0)).toBe("continuation");
    expect(classifyText("OK!", 0, 0)).toBe("continuation");
    expect(classifyText("LGTM", 0, 0)).toBe("continuation");
    expect(classifyText("merge。！", 0, 0)).toBe("continuation");
    expect(classifyText("好的，就这样", 0, 0)).toBe("ok"); // 非整句
    expect(classifyText("方案二", 0, 0)).toBe("continuation");
    expect(classifyText("方案 2", 0, 0)).toBe("ok"); // 带空格非整句模式
    expect(classifyText("选C", 0, 0)).toBe("continuation");
    expect(classifyText("选d", 0, 0)).toBe("ok"); // d 不在 [一二三abc1-9]
    expect(classifyText("42", 0, 0)).toBe("continuation");
    expect(classifyText("4.2", 0, 0)).toBe("ok");
  });

  it("anaphora CJK: substring within first 12 code points", () => {
    expect(classifyText("这个再改一下，其他都不用动哦真的不用动了呢", 0, 0)).toBe("continuation");
    expect(classifyText("把它换成蓝色的那种", 0, 0)).toBe("continuation");
    expect(classifyText("上一个方案的思路更好一些啊", 0, 0)).toBe("continuation");
    // 超出前 12 码点的指代词不算（弱信号，宁漏勿误）
    expect(classifyText("麻烦帮我看一下这一大段文字里最后那个它", 0, 0)).not.toBe("continuation");
  });

  it("anaphora EN: whole word within first 3 words, case-insensitive", () => {
    expect(classifyText("This looks wrong", 0, 0)).toBe("continuation");
    expect(classifyText("what about THIS one", 0, 0)).toBe("continuation");
    expect(classifyText("please fix it now", 0, 0)).toBe("continuation");
    expect(classifyText("continue with the migration", 0, 0)).toBe("continuation");
    expect(classifyText("_same as before", 0, 0)).toBe("ok"); // 非整词
    expect(classifyText("thistle is a flower", 0, 0)).toBe("ok"); // 子串不算
    expect(classifyText("please check spitting again later", 0, 0)).toBe("ok"); // again 在第 4 词
  });

  it("ok: self-contained longer requests", () => {
    expect(classifyText("写一首关于秋天的七言绝句", 0, 8)).toBe("ok");
    expect(classifyText("Help me write a JSON parser in Rust", 0, 8)).toBe("ok");
  });
});

describe("isShortReply / tables", () => {
  it("exported tables are frozen arrays (rule #14)", () => {
    expect(Object.isFrozen(SHORT_REPLY_TABLE)).toBe(true);
    expect(Object.isFrozen(ANAPHORA_CJK)).toBe(true);
    expect(Object.isFrozen(ANAPHORA_EN)).toBe(true);
  });
  it("table entries themselves classify as continuation at minChars 0", () => {
    for (const entry of SHORT_REPLY_TABLE) {
      expect(isShortReply(entry)).toBe(true);
    }
  });
});

describe("hasAnaphora", () => {
  it("CJK head window is 12 code points, EN head window is 3 words", () => {
    expect(hasAnaphora("刚才那个")).toBe(true);
    expect(hasAnaphora("")).toBe(false);
    expect(hasAnaphora("it")).toBe(true);
    expect(hasAnaphora("exit")).toBe(false);
  });
});

describe("assistantAsked", () => {
  it("ends with ? or ？ after trimEnd", () => {
    expect(assistantAsked("要继续吗？", false)).toBe(true);
    expect(assistantAsked("Shall we proceed? ", false)).toBe(true);
    expect(assistantAsked("Shall we proceed?", false)).toBe(true);
    expect(assistantAsked("ok.\n", false)).toBe(false);
  });
  it("ask_user flag alone suffices; undefined text tolerated", () => {
    expect(assistantAsked(undefined, true)).toBe(true);
    expect(assistantAsked(undefined, false)).toBe(false);
    expect(assistantAsked("no question here", true)).toBe(true);
  });
});
