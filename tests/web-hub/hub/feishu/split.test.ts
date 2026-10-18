import { describe, expect, it } from "vitest";

import {
  SOFT_BREAK_MIN_FILL,
  classifyLines,
  jsonBytes,
  partSuffix,
  partSuffixReserveBytes,
  splitMarkdown,
} from "../../../../src/web-hub/hub/feishu/split.js";

const flat = (budget: number) => ({ budgetFor: () => budget, maxParts: 1000 });
const strip = (s: string) => s.replace(/\s+/g, "");
const isFenceMarker = (l: string) => /^ {0,3}(`{3,}|~{3,})/.test(l);
/** content with fence marker lines and whitespace removed: invariant under splitting */
const content = (s: string) =>
  strip(
    s
      .split("\n")
      .filter((l) => !isFenceMarker(l))
      .join("\n"),
  );

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("jsonBytes / partSuffix", () => {
  it("equals the bytes a string occupies inside a serialized JSON document", () => {
    for (const s of ["", "abc", "你好", "line\nbreak", 'q"uote\\', "\u0001ctl", "😀", "\ud800lone", "tab\t"]) {
      const doc = JSON.stringify({ k: s });
      expect(jsonBytes(s)).toBe(Buffer.byteLength(doc) - Buffer.byteLength(JSON.stringify({ k: "" })));
    }
  });
  it("numbers parts only when there are several", () => {
    expect(partSuffix(1, 1)).toBe("");
    expect(partSuffix(2, 3)).toBe(" (2/3)");
    expect(partSuffixReserveBytes(4)).toBe(" (4/4)".length);
  });
});

describe("splitMarkdown basics", () => {
  it("returns one part when everything fits", () => {
    const r = splitMarkdown("hello\n\nworld", flat(1000));
    expect(r).toEqual({ parts: ["hello\n\nworld"], complete: true });
  });
  it("empty text ⇒ one empty part", () => {
    expect(splitMarkdown("", flat(100))).toEqual({ parts: [""], complete: true });
  });
  it("every part is within the JSON-escaped budget (escape-heavy text counts its escapes)", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line "${i}" \\ with\ttab`).join("\n");
    const budget = 200;
    const { parts } = splitMarkdown(text, flat(budget));
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(jsonBytes(p)).toBeLessThanOrEqual(budget);
    expect(content(parts.join("\n"))).toBe(content(text));
  });
  it("prefers a paragraph boundary when the part is at least 40% full", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    const c = "c".repeat(60);
    const { parts } = splitMarkdown(`${a}\n\n${b}\n\n${c}`, flat(150));
    expect(parts).toEqual([`${a}\n\n${b}`, c]);
    expect(SOFT_BREAK_MIN_FILL).toBe(0.4);
  });
  it("falls back to a line boundary when the only paragraph break is too early", () => {
    const lines = ["x".repeat(8), "", ...Array.from({ length: 6 }, () => "y".repeat(30))];
    const { parts } = splitMarkdown(lines.join("\n"), flat(100));
    // soft break after 8 bytes is < 40% of 100 ⇒ the first part keeps filling past it
    expect(parts[0]!.startsWith("xxxxxxxx\n\nyyy")).toBe(true);
  });
  it("drops leading blank lines of a part and never ends one with a blank line", () => {
    const { parts } = splitMarkdown(`${"a".repeat(50)}\n\n\n\n${"b".repeat(50)}`, flat(60));
    expect(parts).toEqual(["a".repeat(50), "b".repeat(50)]);
  });
  it("maxParts ⇒ complete:false and exactly maxParts parts", () => {
    const text = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
    const r = splitMarkdown(text, { budgetFor: () => 30, maxParts: 2 });
    expect(r.complete).toBe(false);
    expect(r.parts).toHaveLength(2);
  });
  it("budgetFor is evaluated per part (part 1 may be smaller)", () => {
    const text = Array.from({ length: 30 }, () => "w".repeat(20)).join("\n");
    const { parts } = splitMarkdown(text, { budgetFor: (i) => (i === 0 ? 50 : 200), maxParts: 10 });
    expect(jsonBytes(parts[0]!)).toBeLessThanOrEqual(50);
    expect(jsonBytes(parts[1]!)).toBeLessThanOrEqual(200);
    expect(jsonBytes(parts[1]!)).toBeGreaterThan(50);
  });
});

describe("fences", () => {
  const code = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n");
  it("re-opens a cut fence with its original opener (info string kept) and closes the previous part", () => {
    const text = `intro\n\n\`\`\`ts title="x"\n${code}\n\`\`\`\n\noutro`;
    const { parts } = splitMarkdown(text, flat(220));
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(jsonBytes(p)).toBeLessThanOrEqual(220);
    const fenced = parts.filter((p) => p.includes("```"));
    for (const p of fenced) {
      const opens = p.split("\n").filter((l) => /^```/.test(l)).length;
      expect(opens % 2).toBe(0); // balanced in every part
    }
    const middle = parts[1]!;
    expect(middle.startsWith('```ts title="x"\n')).toBe(true);
    expect(parts[parts.length - 1]).toContain("outro");
    expect(content(parts.join("\n"))).toBe(content(text));
  });
  it("keeps tilde fences and longer fences intact when re-opening", () => {
    const text = `~~~~py\n${code}\n~~~~`;
    const { parts } = splitMarkdown(text, flat(180));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.startsWith("~~~~py\n")).toBe(true);
      expect(p.endsWith("\n~~~~")).toBe(true);
    }
  });
  it("a fence that fits a whole part moves to its own part instead of being cut", () => {
    const small = "```\nshort\n```";
    const text = `${"p".repeat(120)}\n\n${small}`;
    const { parts } = splitMarkdown(text, flat(130));
    expect(parts).toEqual(["p".repeat(120), small]);
  });
  it("a part is never just an opener plus closer", () => {
    for (let budget = 40; budget < 120; budget += 7) {
      const { parts } = splitMarkdown(`\`\`\`js\n${code}\n\`\`\``, flat(budget));
      for (const p of parts) {
        const body = p.split("\n").filter((l) => !/^```/.test(l));
        expect(body.length).toBeGreaterThan(0);
      }
    }
  });
  it("an opener that would end a part moves to the next part with its body (never an empty code block)", () => {
    const text = `intro paragraph\n\`\`\`js\n${code}\n\`\`\``;
    for (let budget = 60; budget < 160; budget += 11) {
      const { parts } = splitMarkdown(text, flat(budget));
      for (const p of parts) {
        const body = p.split("\n").filter((l) => !/^```/.test(l));
        expect(body.length).toBeGreaterThan(0);
        expect(jsonBytes(p)).toBeLessThanOrEqual(budget);
      }
      expect(parts[0]).not.toMatch(/```js\n```$/);
    }
  });
  it("an unterminated fence is closed at the end of its last part", () => {
    const { parts } = splitMarkdown("```\nnever closed\nstill code", flat(1000));
    expect(parts).toEqual(["```\nnever closed\nstill code\n```"]);
  });
  it("an opener-looking line with a backtick info string is not a fence", () => {
    expect(classifyLines("``` `x`\nplain")).toEqual([
      { text: "``` `x`", fenced: false },
      { text: "plain", fenced: false },
    ]);
  });
  it("classifyLines marks opener/body/closer as fenced", () => {
    expect(classifyLines("a\n```\nb\n```\nc").map((l) => l.fenced)).toEqual([false, true, true, true, false]);
  });
  it("the closer needs the same char and at least the opening length", () => {
    const l = classifyLines("````\n```\nstill\n````\nout");
    expect(l.map((x) => x.fenced)).toEqual([true, true, true, true, false]);
  });
});

describe("long lines", () => {
  it("cuts at a whitespace boundary when it keeps half the piece", () => {
    const text = `${"word ".repeat(40)}end`;
    const { parts } = splitMarkdown(text, flat(60));
    for (const p of parts.slice(0, -1)) expect(p.endsWith(" ")).toBe(true);
    expect(parts.join("")).toBe(text);
  });
  it("CJK text is cut by grapheme (3 bytes each) and reassembles exactly", () => {
    const text = "汉字测试".repeat(100);
    const { parts } = splitMarkdown(text, flat(100));
    for (const p of parts) expect(jsonBytes(p)).toBeLessThanOrEqual(100);
    expect(parts.join("")).toBe(text);
  });
  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(80);
    for (const budget of [5, 6, 7, 9, 10, 11]) {
      const { parts } = splitMarkdown(text, flat(budget));
      for (const p of parts) {
        expect(p).toBe(p.toWellFormedCompat());
        expect([...p].every((c) => c === "😀")).toBe(true);
      }
      expect(parts.join("")).toBe(text);
    }
  });
  it("never splits a ZWJ family emoji or a combining sequence when it fits", () => {
    const fam = "👨‍👩‍👧‍👦"; // 25 bytes
    const text = `${fam}`.repeat(10);
    const { parts } = splitMarkdown(text, flat(60));
    for (const p of parts)
      expect(
        [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(p)].every((s) => s.segment === fam),
      ).toBe(true);
    const comb = "e\u0301".repeat(50);
    const r2 = splitMarkdown(comb, flat(31));
    for (const p of r2.parts) expect(p.length % 2).toBe(0);
  });
  it("a grapheme cluster larger than the whole budget falls back to code points but still progresses", () => {
    const zalgo = `a${"\u0301".repeat(200)}`;
    const { parts } = splitMarkdown(zalgo, flat(40));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(jsonBytes(p)).toBeLessThanOrEqual(40);
    expect(parts.join("")).toBe(zalgo);
  });
  it("a pathological tiny budget still terminates and loses nothing", () => {
    const text = "ab😀\nx\nz";
    const { parts } = splitMarkdown(text, flat(1));
    expect(parts.length).toBeGreaterThan(3);
    expect(content(parts.join("\n"))).toBe(content(text));
    // with fences it must still terminate (markers themselves may be cut at such budgets)
    expect(splitMarkdown("```\nx\n```\nz", { budgetFor: () => 1, maxParts: 1000 }).complete).toBe(true);
  });
  it("cuts a very long line inside a fence into re-opened parts", () => {
    const text = `\`\`\`\n${"x".repeat(500)}\n\`\`\``;
    const { parts } = splitMarkdown(text, flat(100));
    for (const p of parts) {
      expect(jsonBytes(p)).toBeLessThanOrEqual(100);
      expect(p.startsWith("```\n")).toBe(true);
      expect(p.endsWith("\n```")).toBe(true);
    }
    expect(parts.map((p) => p.split("\n")[1]).join("")).toBe("x".repeat(500));
  });
});

describe("fence opener larger than the budget (r_ASBT6095 F1)", () => {
  const body = Array.from({ length: 40 }, (_, i) => `code line ${i}`).join("\n");
  const noTicks = (s: string) => strip(s.replace(/`/g, ""));
  it("the rest of a cut opener is plain text: later parts do not re-emit the oversized opener and stay in budget", () => {
    const opener = `\`\`\`${"info".repeat(125)}`; // 503 B opener
    const text = `${opener}\n${body}\n\`\`\``;
    for (const budget of [100, 150, 220, 400]) {
      const { parts, complete } = splitMarkdown(text, flat(budget));
      expect(complete).toBe(true);
      for (const p of parts) expect(jsonBytes(p), `budget ${budget}`).toBeLessThanOrEqual(budget);
      // round trip: everything except fence marks survives in order
      expect(noTicks(parts.join("\n"))).toBe(noTicks(text));
      // the code after the opener is still fenced: later parts re-open with a BARE marker
      const withBody = parts.filter((p) => p.includes("code line"));
      expect(withBody.length).toBeGreaterThan(0);
      for (const p of withBody.slice(1)) expect(p.startsWith("```\n")).toBe(true);
    }
  });
  it("a normal-sized info string is still re-opened verbatim", () => {
    const text = `\`\`\`ts title="x"\n${body}\n\`\`\``;
    const { parts } = splitMarkdown(text, flat(220));
    expect(parts[1]!.startsWith('```ts title="x"\n')).toBe(true);
  });
  it("an oversized unterminated opener alone terminates and round-trips", () => {
    const text = `\`\`\`${"z".repeat(5000)}`;
    const { parts } = splitMarkdown(text, flat(300));
    for (const p of parts) expect(jsonBytes(p)).toBeLessThanOrEqual(300);
    expect(noTicks(parts.join(""))).toBe(noTicks(text));
  });
});

describe("small-budget corners (r_ASBT6095 F3): a part exceeds the budget only when one code point cannot fit", () => {
  const text = [
    'intro \u0001 "quoted"',
    '```ts title="t"',
    ...Array.from({ length: 12 }, (_, i) => `const v${i} = "😀${i}\\";`),
    "```",
    "tail 汉字 \u0001\u0001",
  ].join("\n");
  it("budgets ≥ 24 B are never exceeded", () => {
    for (let budget = 24; budget <= 90; budget++) {
      const { parts, complete } = splitMarkdown(text, flat(budget));
      expect(complete).toBe(true);
      for (const p of parts) expect(jsonBytes(p), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });
  it("tinier budgets always terminate, lose nothing, and overshoot by less than one code point (≤6 B) + a fence closer", () => {
    const plain = 'a\u0001b😀c"d';
    for (let budget = 1; budget < 24; budget++) {
      for (const t of [plain, text]) {
        const { parts, complete } = splitMarkdown(t, flat(budget));
        expect(complete).toBe(true);
        for (const p of parts) expect(jsonBytes(p), `budget ${budget}`).toBeLessThanOrEqual(Math.max(budget, 6) + 8);
      }
      const r = splitMarkdown(plain, flat(budget));
      expect(strip(r.parts.join(""))).toBe(strip(plain));
    }
  });
});

describe("seeded property: budget respected, content preserved", () => {
  const alphabet = ["a", "b", " ", "汉", "字", "😀", "👨‍👩‍👧", "\\", '"'];
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const nLines = 1 + Math.floor(r() * 40);
      const lines: string[] = [];
      for (let i = 0; i < nLines; i++) {
        const roll = r();
        if (roll < 0.12) lines.push("");
        else if (roll < 0.2) lines.push(r() < 0.5 ? "```ts" : "```");
        else if (roll < 0.24) lines.push("~~~");
        else if (roll < 0.28) lines.push("## head");
        else {
          const n = Math.floor(r() * 90);
          let l = "";
          for (let k = 0; k < n; k++) l += alphabet[Math.floor(r() * alphabet.length)];
          lines.push(l);
        }
      }
      const text = lines.join("\n");
      const budget = 40 + Math.floor(r() * 160);
      const res = splitMarkdown(text, flat(budget));
      expect(res.complete).toBe(true);
      for (const p of res.parts) expect(jsonBytes(p)).toBeLessThanOrEqual(budget);
      expect(content(res.parts.join("\n"))).toBe(content(text));
      // determinism
      expect(splitMarkdown(text, flat(budget))).toEqual(res);
    });
  }
});

declare global {
  interface String {
    toWellFormedCompat(): string;
  }
}
String.prototype.toWellFormedCompat = function (this: string) {
  return this.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
};
