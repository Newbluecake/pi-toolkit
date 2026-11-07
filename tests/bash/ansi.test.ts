import { describe, expect, it } from "vitest";
import {
  ANSI_LOOKBACK_BYTES,
  ANSI_STATE_RUN_CAP,
  createAnsiStripper,
  stripAnsiSlice,
  stripAnsiText,
} from "../../src/bash/ansi.js";

/**
 * stripAnsi 包：ANSI 清洗器本体（A 点流式 / B 点 one-shot 切片）的单元行为。
 *
 * 真值口径（文件头已写明设计依据）：node 的 `stripVTControlCharacters` 对冒号子参数、
 * `\x1b[>c`、带中间字节的 CSI、DCS/PM/APC 有实测缺口（"\x1b[38:5:196m" 会泄 ":5:196m"），
 * 所以删除口径以本扫描器为准——下面的期望值都是「应然」值，不是 node 的输出。
 */
const ESC = "\x1b";

/** 覆盖面电池：CSI/OSC/DCS/SOS/PM/APC/ESC 派发/C1/Unicode/残片。 */
const BATTERY: [name: string, input: string, expected: string][] = [
  ["SGR basic", `${ESC}[31mred${ESC}[0m`, "red"],
  ["SGR many params", `${ESC}[1;2;3;4;5mX${ESC}[0m`, "X"],
  ["SGR colon subparams", `${ESC}[38:5;196mX${ESC}[38:2;10;20;30:0mY`, "XY"],
  ["CSI ? private", `${ESC}[?25hX`, "X"],
  ["CSI > private", `${ESC}[>cX`, "X"],
  ["CSI intermediate space", `${ESC}[1 F X`, " X"],
  ["CSI intermediate $ p", `${ESC}[38;2;1;2;3$ p X`, " X"],
  ["CSI cursor", `${ESC}[2J${ESC}[Hhome`, "home"],
  ["CSI long params", `${ESC}[1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20mX`, "X"],
  ["OSC BEL", `${ESC}]0;title\x07after`, "after"],
  ["OSC ST esc-backslash", `${ESC}]0;title${ESC}\\after`, "after"],
  ["OSC ST C1", `${ESC}]0;t\x9cafter`, "after"],
  ["OSC 8 hyperlink", `${ESC}]8;;http://u${ESC}\\link${ESC}]8;;${ESC}\\ after`, "link after"],
  ["OSC 9 desktop notify", `${ESC}]9;notice\x07after`, "after"],
  ["OSC nested ESC", `${ESC}]0;a${ESC}Ab\x07after`, "after"],
  ["DCS", `${ESC}Pq payload${ESC}\\after`, "after"],
  ["SOS", `${ESC}Xs${ESC}\\after`, "after"],
  ["PM", `${ESC}^pm${ESC}\\after`, "after"],
  ["APC", `${ESC}_apc${ESC}\\after`, "after"],
  ["ESC dispatch 7", `a${ESC}7b`, "ab"],
  ["ESC dispatch charset", `a${ESC}(Bb`, "ab"],
  ["ESC dispatch single", `a${ESC}mb`, "ab"],
  ["ESC + printable is dropped too", `a${ESC}bb`, "ab"],
  ["C1 CSI", `\x9b31mafter`, "after"],
  ["stray C1 ST dropped", `a\x9cb`, "ab"],
  ["trailing incomplete CSI dropped", `pre${ESC}[31`, "pre"],
  ["trailing incomplete OSC dropped", `pre${ESC}]0;tit`, "pre"],
  ["lone trailing ESC dropped", `ok${ESC}`, "ok"],
  ["consecutive ESC then sequence", `a${ESC}${ESC}[31mb`, "ab"],
  ["unicode untouched", `中文 ${ESC}[31m彩色\x1b[0m emoji 🎉 tail`, "中文 彩色 emoji 🎉 tail"],
  ["ESC then control keeps the control", `a${ESC}\nb`, "a\nb"],
  ["ESC then non-ASCII keeps the text", `a${ESC}éb`, "aéb"],
  ["CSI broken by control char", `${ESC}[3\n1mX`, "\n1mX"],
];

describe("bash ansi stripper: one-shot (stripAnsiText)", () => {
  for (const [name, input, expected] of BATTERY) {
    it(name, () => {
      expect(stripAnsiText(input)).toBe(expected);
    });
  }
  it("empty string passes through", () => {
    expect(stripAnsiText("")).toBe("");
  });
});

describe("bash ansi stripper: streaming (createAnsiStripper)", () => {
  it("matches the one-shot result for every 2-way byte split of the battery corpus", () => {
    const corpus = BATTERY.map(([, input]) => input).join("·") + "tail 中文 🎉";
    const expected = stripAnsiText(corpus);
    for (let k = 1; k < corpus.length; k++) {
      const stripper = createAnsiStripper();
      const out = stripper.push(corpus.slice(0, k)) + stripper.push(corpus.slice(k));
      expect(out + stripper.finish()).toBe(expected);
    }
  });

  it("matches the one-shot result for seeded random multi-way splits", () => {
    const corpus = BATTERY.map(([, input]) => input).join("\n");
    const expected = stripAnsiText(corpus);
    let seed = 0x2a2a2a2a;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let trial = 0; trial < 500; trial++) {
      const stripper = createAnsiStripper();
      let out = "";
      let rest = corpus;
      while (rest.length > 0) {
        const take = 1 + Math.floor(rnd() * 9);
        out += stripper.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      expect(out).toBe(expected);
    }
  });

  it("a dangling cross-chunk CSI leaves nothing behind and no bare ESC leaks", () => {
    const stripper = createAnsiStripper();
    expect(stripper.push(`pre${ESC}[3`)).toBe("pre");
    expect(stripper.push(`1mred`)).toBe("red");
    expect(stripper.finish()).toBe("");
  });

  it("a dangling cross-chunk OSC title is swallowed until its terminator", () => {
    const stripper = createAnsiStripper();
    expect(stripper.push(`${ESC}]0;lo`)).toBe("");
    expect(stripper.push(`ng ti`)).toBe("");
    expect(stripper.push(`tle\x07after`)).toBe("after");
  });

  it("finish() drops the pending sequence, emits nothing, and is idempotent", () => {
    const stripper = createAnsiStripper();
    expect(stripper.push(`done${ESC}[38;5;`)).toBe("done");
    expect(stripper.finish()).toBe("");
    expect(stripper.finish()).toBe("");
    // 状态已复位：后续 push 从 ground 开始。
    expect(stripper.push(`${ESC}[31mnext`)).toBe("next");
  });

  it("runaway unterminated string is cut at the run cap and later text flows", () => {
    const stripper = createAnsiStripper();
    const body = "a".repeat(5_000);
    const out = stripper.push(`${ESC}]${body}`);
    // ESC(1) + ']'(1) 之后最多再吞 ANSI_STATE_RUN_CAP - 2 个字符。
    expect(out).toBe("a".repeat(5_000 - (ANSI_STATE_RUN_CAP - 2)));
    expect(stripper.push("tail")).toBe("tail");
    expect(stripper.finish()).toBe("");
  });

  it("two strippers never share state (per-exec isolation)", () => {
    const a = createAnsiStripper();
    const b = createAnsiStripper();
    expect(a.push(`${ESC}[3`)).toBe("");
    expect(b.push(`plain`)).toBe("plain");
    expect(a.push(`1mred`)).toBe("red");
    expect(b.push(` text`)).toBe(" text");
  });
});

describe("bash ansi stripper: off is byte-identical passthrough", () => {
  it("returns every chunk unchanged, including raw ESC/CSI/OSC bytes", () => {
    for (const [, input] of BATTERY) {
      const stripper = createAnsiStripper({ enabled: false });
      // 任意切法都逐字节一致
      const whole = stripper.push(input) + stripper.finish();
      expect(whole).toBe(input);
      const mid = Math.max(1, Math.floor(input.length / 2));
      const split = createAnsiStripper({ enabled: false });
      expect(split.push(input.slice(0, mid)) + split.push(input.slice(mid))).toBe(input);
    }
  });
});

describe("bash ansi stripper: one-shot slice with lookback (B point)", () => {
  it("a read starting mid-CSI (ESC in the lookback window) drops the 31m fragment", () => {
    expect(stripAnsiSlice("1mRED", `x${ESC}[3`)).toBe("RED");
    // 引导符前面有普通文本填充（窗口内仍有明确 ESC 证据）也成立
    expect(stripAnsiSlice("1mRED", "x".repeat(200) + `\u001b[3`)).toBe("RED");
  });

  it("a read starting mid-OSC continues the string state until its terminator", () => {
    expect(stripAnsiSlice("tle\x07after", `${ESC}]0;long ti`)).toBe("after");
  });

  it("a full window of pure CSI param bytes does NOT assume mid-CSI (no heuristic)", () => {
    // 误报原例：纯数字/分号 lookback 不得触发中截残片剥离（引导符不在窗口内 ⇒ 不剥）。
    expect(stripAnsiSlice("mTAIL", "1;2;3;4;5;6;7;8;9;0;1;2")).toBe("mTAIL");
    expect(stripAnsiSlice("789;111 other text", "1234567890123456")).toBe("789;111 other text");
    // 整窗 256B 全是 CSI 参数字节也不触发——不得丢可见文本
    expect(stripAnsiSlice("mTAIL", "1;".repeat(128))).toBe("mTAIL");
    expect(stripAnsiSlice("789;111 other text", "9".repeat(256))).toBe("789;111 other text");
  });

  it("a short param-only lookback does NOT trigger the heuristic", () => {
    expect(stripAnsiSlice("mTAIL", "1;2;3")).toBe("mTAIL");
  });

  it("a plain-text lookback leaves the content untouched when it is not a fragment", () => {
    expect(stripAnsiSlice("31m of rain", "hello world 1234")).toBe("31m of rain");
  });

  it("a lookback ending in a bare ESC dispatches with the content's first char", () => {
    expect(stripAnsiSlice("[31mred", "abc" + ESC)).toBe("red");
  });

  it("an empty lookback (offset 0) strips normally", () => {
    expect(stripAnsiSlice(`${ESC}[31mred${ESC}[0m`, "")).toBe("red");
  });

  it("a trailing incomplete sequence is dropped (one-shot semantics)", () => {
    expect(stripAnsiSlice(`done${ESC}[31`, "prefix")).toBe("done");
  });

  it("empty content passes through", () => {
    expect(stripAnsiSlice("", `${ESC}[3`)).toBe("");
  });

  it("the lookback constant is 256 bytes", () => {
    expect(ANSI_LOOKBACK_BYTES).toBe(256);
  });
});
