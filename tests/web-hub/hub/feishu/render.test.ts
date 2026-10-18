import { describe, expect, it } from "vitest";

import { FEISHU_FILE_LIMITS, FEISHU_REPLY_LIMITS } from "../../../../src/web-hub/protocol/feishu.js";
import {
  EMPTY_REPLY_PLACEHOLDER,
  KIND_TEMPLATE,
  OUTPUT_INCOMPLETE_LABEL,
  OVERFLOW_FILE_NOTE_PREFIX,
  OVERFLOW_TRUNCATED_NOTE,
  cardTitle,
  neutralizeMarkdown,
  neutralizeTags,
  renderNotice,
  renderReply,
  safeHref,
  sanitizeLabel,
  markupSafeLabel,
  sanitizeText,
} from "../../../../src/web-hub/hub/feishu/render.js";
import type { ReplyInput, RenderedPart } from "../../../../src/web-hub/hub/feishu/render.js";

const ZW = "\u200B";
const OPEN_ID = "ou_0123456789abcdef";
const CAP = FEISHU_REPLY_LIMITS.maxCardBytes;

interface Card {
  schema: string;
  config: { update_multi: boolean };
  header: { title: { tag: string; content: string }; template: string };
  body: { elements: Array<{ tag: string; content: string }> };
}
const parse = (p: { content: string }): Card => JSON.parse(p.content) as Card;
const md = (p: { content: string }): string => parse(p).body.elements[0]!.content;
const base = (over: Partial<ReplyInput> = {}): ReplyInput => ({
  kind: "done",
  label: "api · a1b2c3",
  text: "hi",
  ...over,
});

/** any tag-shaped `<` that is NOT immediately followed by a zero-width space */
const LIVE_TAG = /<(?![\u200B])[A-Za-z/!?]/;

describe("sanitizeText / sanitizeLabel", () => {
  it("strips controls, bidi, ZWSP/BOM/soft hyphen; keeps \\n \\t ZWJ ZWNJ and emoji sequences", () => {
    const dirty = "a\u0000b\u0007c\u202ed\u200be\ufeff\u00adf\u0085g\th\u200di\u200cj👨‍👩‍👧\nk";
    expect(sanitizeText(dirty)).toBe("abcdefg\th\u200di\u200cj👨‍👩‍👧\nk");
  });
  it("normalizes CRLF, CR and line/paragraph separators; fixes lone surrogates", () => {
    expect(sanitizeText("a\r\nb\rc\u2028d\u2029e")).toBe("a\nb\nc\nd\ne");
    expect(sanitizeText("x\ud800y\udc00z😀")).toBe("x\uFFFDy\uFFFDz😀");
  });
  it("non-strings are empty", () => {
    expect(sanitizeText(undefined as unknown as string)).toBe("");
  });
  it("labels are one line, bounded to 48 code points and never empty", () => {
    expect(sanitizeLabel("  a\n\tb  ")).toBe("a b");
    expect(sanitizeLabel("")).toBe("session");
    const long = sanitizeLabel("字".repeat(100));
    expect([...long]).toHaveLength(48);
    expect(long.endsWith("…")).toBe(true);
    expect(sanitizeLabel("x\u202e<at id=all>")).toBe("x<at id=all>"); // plain_text header: no markup meaning
  });
  it("cardTitle numbers only multi-part titles", () => {
    expect(cardTitle("l")).toBe("pi · l");
    expect(cardTitle("l", 2, 3)).toBe("pi · l (2/3)");
  });
});

describe("neutralizeTags", () => {
  it("breaks tag-shaped sequences only", () => {
    expect(neutralizeTags("<at id=all></at>")).toBe(`<${ZW}at id=all><${ZW}/at>`);
    expect(neutralizeTags("<!-- c --> <?x ?> <a href=1>")).toBe(`<${ZW}!-- c --> <${ZW}?x ?> <${ZW}a href=1>`);
    expect(neutralizeTags("a < b << 3 <3 <")).toBe("a < b << 3 <3 <");
  });
});

describe("neutralizeMarkdown", () => {
  const hostile = [
    "<at id=all></at>",
    '<at user_id="ou_x">x</at>',
    "<font color='red'>x</font>",
    "<a href='https://evil'>x</a>",
    "<person id='ou_1'></person>",
    "<local_datetime millisecond='1'></local_datetime>",
    "<script>alert(1)</script>",
    "<img src=x onerror=1>",
    "</at>",
    "<!--x-->",
  ];
  it("no raw tag survives in prose, inline code or fences (default policy)", () => {
    for (const h of hostile) {
      for (const wrapped of [
        h,
        `text ${h} text`,
        `\`${h}\``,
        `\`\`${h}\`\``,
        `\`\`\`\n${h}\n\`\`\``,
        `> ${h}`,
        `# ${h}`,
        `- ${h}`,
        `[${h}](https://a.example/x)`,
      ]) {
        const out = neutralizeMarkdown(wrapped);
        expect(out, wrapped).not.toMatch(LIVE_TAG);
      }
    }
  });
  it("codeTags:'literal' keeps code literal but still neutralizes prose", () => {
    expect(neutralizeMarkdown("`<b>x</b>` <b>", { codeTags: "literal" })).toBe(`\`<b>x</b>\` <${ZW}b>`);
    expect(neutralizeMarkdown("```\n<b>\n```\n<b>", { codeTags: "literal" })).toBe(`\`\`\`\n<b>\n\`\`\`\n<${ZW}b>`);
  });
  it("leaves ordinary markdown, math-ish angle brackets and code untouched otherwise", () => {
    const text =
      "# Title\n\n- a < b and c > d\n- **bold** _it_ `x`\n\n```ts\nconst a = 1 < 2;\n```\n\n| a | b |\n|---|---|";
    expect(neutralizeMarkdown(text)).toBe(text);
  });
  it("is idempotent", () => {
    const text = "<at id=all> [x](javascript:alert(1)) ![i](https://a.example/p.png) `<b>`";
    const once = neutralizeMarkdown(text);
    expect(neutralizeMarkdown(once)).toBe(once);
  });
  it("keeps http(s)/mailto links (re-serialized, parentheses encoded)", () => {
    expect(neutralizeMarkdown("[doc](https://example.com/a)")).toBe("[doc](https://example.com/a)");
    expect(neutralizeMarkdown("see [w](https://en.wikipedia.org/wiki/Foo_(bar)) ok")).toBe(
      "see [w](https://en.wikipedia.org/wiki/Foo_%28bar%29) ok",
    );
    expect(neutralizeMarkdown("[m](mailto:a@b.example)")).toBe("[m](mailto:a@b.example)");
    expect(neutralizeMarkdown('[t](https://a.example/x "title")')).toBe("[t](https://a.example/x)");
    expect(neutralizeMarkdown("[t](<https://a.example/x>)")).toBe("[t](https://a.example/x)");
  });
  it("turns every other scheme / relative target into an inert code span", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:x",
      "data:text/html;base64,AAAA",
      "lark://client/x",
      "file:///etc/passwd",
      "/rel/path",
      "#frag",
      "//host/x",
      "https://u:p@a.example/",
      "https://a.example\\@b.example",
    ]) {
      const out = neutralizeMarkdown(`[click](${url})`);
      expect(out, url).toMatch(/^click \(`.*`\)$/);
      expect(out, url).not.toMatch(/\]\(/);
    }
  });
  it("flattens images to a link (allowed url) or alt text, never an image reference", () => {
    expect(neutralizeMarkdown("![logo](https://a.example/p.png)")).toBe("[🖼 logo](https://a.example/p.png)");
    expect(neutralizeMarkdown("![](https://a.example/p.png)")).toBe("[🖼 image](https://a.example/p.png)");
    const out = neutralizeMarkdown("![alt](img_v2_abcdef)");
    expect(out).toBe("alt (`img_v2_abcdef`)");
    expect(out).not.toContain("![");
  });
  it("does not rewrite links inside inline code or fences", () => {
    expect(neutralizeMarkdown("`[x](javascript:1)`")).toBe("`[x](javascript:1)`");
    expect(neutralizeMarkdown("```\n[x](javascript:1)\n```")).toBe("```\n[x](javascript:1)\n```");
  });
  it("a code span inside link text does not hide the destination from validation", () => {
    const out = neutralizeMarkdown("[`x`](javascript:evil)");
    expect(out).toBe("`x` (`javascript:evil`)");
  });
  it("tag-like text in a link destination or title cannot go live", () => {
    expect(neutralizeMarkdown("[x](javascript:<at id=all></at>)")).not.toMatch(LIVE_TAG);
  });
  it("malformed link syntax is left alone (no catastrophic scanning)", () => {
    const evil = `${"[".repeat(5000)}${"](".repeat(2000)}`;
    const t0 = Date.now();
    neutralizeMarkdown(evil);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(neutralizeMarkdown("[a](")).toBe("[a](");
    expect(neutralizeMarkdown("[a] (b)")).toBe("[a] (b)");
  });
  it("sanitizes control characters first", () => {
    expect(neutralizeMarkdown("a\u202e<\u0000at id=all>")).toBe(`a<${ZW}at id=all>`);
  });
});

describe("safeHref", () => {
  it("accepts only parseable http(s)/mailto without userinfo/backslash/controls", () => {
    expect(safeHref("https://example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
    expect(safeHref("HTTP://EXAMPLE.com")).toBe("http://example.com/");
    expect(safeHref("ftp://x")).toBeUndefined();
    expect(safeHref("https://a.example/x y")).toBeUndefined();
    expect(safeHref("https://a.example/\u0001")).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
    expect(safeHref(`https://a.example/${"x".repeat(3000)}`)).toBeUndefined();
  });
});

describe("renderReply: card shape", () => {
  it("is a schema-2.0 card with a colored header, one markdown element, update_multi", () => {
    const r = renderReply(base({ text: "hello **world**" }));
    expect(r.parts).toHaveLength(1);
    const p = r.parts[0]!;
    expect(p.msgType).toBe("interactive");
    const c = parse(p);
    expect(c.schema).toBe("2.0");
    expect(c.config).toEqual({ update_multi: true });
    expect(c.header.title).toEqual({ tag: "plain_text", content: "pi · api · a1b2c3" });
    expect(c.header.template).toBe("green");
    expect(c.body.elements).toEqual([{ tag: "markdown", content: "hello **world**" }]);
    expect(p).toMatchObject({ index: 1, total: 1, bytes: Buffer.byteLength(p.content) });
    expect(r.incomplete).toBe(false);
    expect(r.overflow).toBeUndefined();
  });
  it("colors per kind", () => {
    expect(KIND_TEMPLATE).toEqual({ done: "green", failed: "red", waiting: "orange", info: "grey" });
    for (const kind of ["done", "failed", "waiting", "info"] as const)
      expect(parse(renderReply(base({ kind })).parts[0]!).header.template).toBe(KIND_TEMPLATE[kind]);
  });
  it("empty assistant text gets a placeholder", () => {
    expect(md(renderReply(base({ text: "  \n " })).parts[0]!)).toBe(EMPTY_REPLY_PLACEHOLDER);
  });
  it("the session label is sanitized and cannot inject through the header", () => {
    const r = renderReply(base({ label: `ev\u202eil\n<at id=all></at> ${"x".repeat(200)}` }));
    const title = parse(r.parts[0]!).header.title;
    expect(title.tag).toBe("plain_text");
    expect(title.content).not.toContain("\n");
    expect([...title.content].length).toBeLessThanOrEqual(5 + 48);
  });
  it("CJK, emoji and JSON-hostile characters round-trip through JSON", () => {
    const text = '汉字 "quoted" \\ back 😀 tab\tend';
    expect(md(renderReply(base({ text })).parts[0]!)).toBe(text);
  });
});

describe("renderReply: failed-run cards", () => {
  it("red card with a lead line, the quoted (neutralized) error and the partial text", () => {
    const r = renderReply(
      base({
        kind: "failed",
        text: "partial answer",
        failure: { stopReason: "error", message: "boom <at id=all></at>\nline2" },
      }),
    );
    const c = parse(r.parts[0]!);
    expect(c.header.template).toBe("red");
    const body = c.body.elements[0]!.content;
    expect(body.startsWith("**❌ 运行失败** · error\n> boom ")).toBe(true);
    expect(body).toContain("\n> line2\n\npartial answer");
    expect(body).not.toMatch(LIVE_TAG);
  });
  it("aborted is orange and says so", () => {
    const c = parse(renderReply(base({ kind: "failed", text: "", failure: { stopReason: "aborted" } })).parts[0]!);
    expect(c.header.template).toBe("orange");
    expect(c.body.elements[0]!.content).toBe("**⏹ 运行已中止**");
  });
  it("a failed card without details still renders", () => {
    expect(md(renderReply(base({ kind: "failed", text: "" })).parts[0]!)).toBe("**❌ 运行失败**");
  });
  it("very long error messages are clipped", () => {
    const body = md(renderReply(base({ kind: "failed", text: "", failure: { message: "e".repeat(5000) } })).parts[0]!);
    expect(body.length).toBeLessThan(700);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("renderReply: wire truncation + mention", () => {
  it("truncated text carries the explicit incomplete label at the end", () => {
    const r = renderReply(base({ text: "cut off mid", truncated: true }));
    expect(r.incomplete).toBe(true);
    expect(md(r.parts[0]!)).toBe(`cut off mid\n\n${OUTPUT_INCOMPLETE_LABEL}`);
    expect(OUTPUT_INCOMPLETE_LABEL).toContain("output incomplete (truncated in transit)");
  });
  it("the label is on the LAST part of a multi-part reply only", () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i} ${"x".repeat(900)}`).join("\n\n");
    const r = renderReply(base({ text, truncated: true }));
    expect(r.parts.length).toBeGreaterThan(1);
    r.parts.forEach((p, i) => expect(md(p).includes(OUTPUT_INCOMPLETE_LABEL)).toBe(i === r.parts.length - 1));
  });
  it("a valid open_id is @-mentioned on the first part only; an invalid one never becomes a tag", () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i} ${"y".repeat(900)}`).join("\n\n");
    const r = renderReply(base({ text, mention: OPEN_ID }));
    expect(md(r.parts[0]!).startsWith(`<at id=${OPEN_ID}></at> `)).toBe(true);
    for (const p of r.parts.slice(1)) expect(md(p)).not.toContain("<at");
    for (const bad of ["ou_x y", "all", "<at id=all></at>", "ou_", ""]) {
      expect(md(renderReply(base({ mention: bad })).parts[0]!)).toBe("hi");
    }
  });
  it("the mention is the ONLY live tag in the card", () => {
    const body = md(renderReply(base({ text: "<at id=all></at> hi", mention: OPEN_ID })).parts[0]!);
    const live = body.match(/<(?!\u200B)[A-Za-z/!?][^>]*>/g) ?? [];
    expect(live[0]).toBe(`<at id=${OPEN_ID}>`);
    expect(live.slice(1)).toEqual(["</at>"]);
  });
});

describe("renderReply: size cap + splitting", () => {
  const sizes = (parts: RenderedPart[]): number[] => parts.map((p) => Buffer.byteLength(p.content, "utf8"));

  it("a short reply is one part with no numbering", () => {
    const r = renderReply(base({ text: "x".repeat(10_000) }));
    expect(r.parts).toHaveLength(1);
    expect(parse(r.parts[0]!).header.title.content).not.toMatch(/\(\d\/\d\)/);
  });
  it("every part's serialized card is ≤ 20 000 UTF-8 bytes — ASCII, CJK, emoji, escape-heavy", () => {
    const samples: Record<string, string> = {
      ascii: Array.from({ length: 80 }, (_, i) => `line ${i} ${"a".repeat(300)}`).join("\n"),
      cjk: Array.from({ length: 30 }, (_, i) => `第${i}段 ${"汉字内容".repeat(200)}`).join("\n\n"),
      emoji: "😀👨‍👩‍👧".repeat(3000),
      escapes: Array.from({ length: 200 }, () => `"\\\t${"\u0001".repeat(10)}"`).join("\n"),
      code: `intro\n\n\`\`\`ts\n${Array.from({ length: 800 }, (_, i) => `const v${i} = "${i}";`).join("\n")}\n\`\`\`\n\noutro`,
    };
    for (const [name, text] of Object.entries(samples)) {
      for (const overflow of ["file", "truncate"] as const) {
        const r = renderReply(base({ text, overflow, truncated: true, mention: OPEN_ID }));
        for (const b of sizes(r.parts)) expect(b, `${name}/${overflow}`).toBeLessThanOrEqual(CAP);
        expect(r.parts.length).toBeLessThanOrEqual(FEISHU_REPLY_LIMITS.maxParts);
        r.parts.forEach((p, i) => expect(p).toMatchObject({ index: i + 1, total: r.parts.length }));
      }
    }
  });
  it("part titles are numbered (i/n) and the content is preserved in order", () => {
    const paras = Array.from({ length: 30 }, (_, i) => `PARA${i}-${"z".repeat(1000)}`);
    const r = renderReply(base({ text: paras.join("\n\n") }));
    expect(r.parts.length).toBeGreaterThanOrEqual(2);
    expect(r.parts.length).toBeLessThanOrEqual(4);
    r.parts.forEach((p, i) =>
      expect(parse(p).header.title.content).toBe(`pi · api · a1b2c3 (${i + 1}/${r.parts.length})`),
    );
    const joined = r.parts.map(md).join("\n\n");
    for (const para of paras) expect(joined).toContain(para);
    expect(r.overflow).toBeUndefined();
  });
  it("code fences are balanced in every part and re-opened with their language", () => {
    const text = `\`\`\`python\n${Array.from({ length: 1500 }, (_, i) => `print(${i})`).join("\n")}\n\`\`\``;
    const r = renderReply(base({ text, overflow: "truncate" }));
    for (const p of r.parts) {
      const m = md(p);
      expect(m.split("\n").filter((l) => /^```/.test(l)).length % 2).toBe(0);
      expect(m.startsWith("```python\n")).toBe(true);
    }
  });
  it("overflow:file (default): part 1 + an attachment note + the full sanitized text for upload", () => {
    const text = Array.from({ length: 200 }, (_, i) => `row ${i} ${"q".repeat(500)}`).join("\n\n");
    const r = renderReply(base({ text, shortId: "a1b2c3d4" }));
    expect(r.parts).toHaveLength(1);
    expect(parse(r.parts[0]!).header.title.content).toBe("pi · api · a1b2c3");
    expect(md(r.parts[0]!)).toContain(`${OVERFLOW_FILE_NOTE_PREFIX}\`reply-a1b2c3.md\``);
    expect(r.overflow).toEqual({ fullText: text, fileName: "reply-a1b2c3.md", clipped: false });
    expect(r.truncatedByOverflow).toBe(false);
  });
  it("the attachment is the RAW sanitized text (not neutralized) and carries the incomplete label when truncated", () => {
    const text = `<b>x</b>\n${"w".repeat(100_000)}`;
    const r = renderReply(base({ text, truncated: true }));
    expect(r.overflow!.fullText.startsWith("<b>x</b>\n")).toBe(true);
    expect(r.overflow!.fullText.endsWith(`${OUTPUT_INCOMPLETE_LABEL}\n`)).toBe(true);
    expect(md(r.parts[0]!)).not.toMatch(LIVE_TAG);
    expect(md(r.parts[0]!).endsWith(OUTPUT_INCOMPLETE_LABEL)).toBe(true);
  });
  it("the attachment is clipped to the upload cap", () => {
    const big = "a".repeat(FEISHU_FILE_LIMITS.outboundUploadMaxBytes + 1000);
    const r = renderReply(base({ text: big }));
    expect(r.overflow!.clipped).toBe(true);
    expect(Buffer.byteLength(r.overflow!.fullText)).toBeLessThanOrEqual(FEISHU_FILE_LIMITS.outboundUploadMaxBytes);
  });
  it("overflow:truncate: exactly maxParts parts, a visible note on the last, no attachment", () => {
    const text = Array.from({ length: 200 }, (_, i) => `row ${i} ${"q".repeat(500)}`).join("\n\n");
    const r = renderReply(base({ text, overflow: "truncate" }));
    expect(r.parts).toHaveLength(4);
    expect(r.overflow).toBeUndefined();
    expect(r.truncatedByOverflow).toBe(true);
    expect(md(r.parts[3]!).endsWith(OVERFLOW_TRUNCATED_NOTE)).toBe(true);
    for (const p of r.parts.slice(0, 3)) expect(md(p)).not.toContain(OVERFLOW_TRUNCATED_NOTE);
  });
  it("maxParts / maxCardBytes seams are honoured", () => {
    const text = Array.from({ length: 20 }, (_, i) => `p${i} ${"k".repeat(400)}`).join("\n\n");
    const r = renderReply(base({ text, maxCardBytes: 2_000, maxParts: 10 }));
    expect(r.parts.length).toBeGreaterThan(4);
    for (const b of sizes(r.parts)) expect(b).toBeLessThanOrEqual(2_000);
  });
  it("neutralization happens BEFORE splitting: the cap accounts for the added zero-width spaces", () => {
    const text = "<b>".repeat(8_000);
    const r = renderReply(base({ text, overflow: "truncate" }));
    for (const b of sizes(r.parts)) expect(b).toBeLessThanOrEqual(CAP);
    for (const p of r.parts) expect(md(p)).not.toMatch(LIVE_TAG);
  });
  it("is deterministic", () => {
    const text = "x\n\n".repeat(20_000);
    expect(renderReply(base({ text }))).toEqual(renderReply(base({ text })));
  });
});

describe("renderNotice", () => {
  it("is a text message prefixed with 【label】", () => {
    const n = renderNotice({ label: "api · a1b2c3", text: "没有绑定会话 — /list 然后 /use" });
    expect(n.msgType).toBe("text");
    expect(JSON.parse(n.content)).toEqual({ text: "【api · a1b2c3】没有绑定会话 — /list 然后 /use" });
    expect(n.bytes).toBe(Buffer.byteLength(n.content));
  });
  it("neutralizes tags, strips controls, mentions a valid open_id with the text-message syntax", () => {
    const n = renderNotice({ label: "l", text: '<at user_id="all"></at>\u0007x', mention: OPEN_ID });
    const text = (JSON.parse(n.content) as { text: string }).text;
    expect(text.startsWith(`<at user_id="${OPEN_ID}"></at> 【l】`)).toBe(true);
    expect(text.slice(`<at user_id="${OPEN_ID}"></at> `.length)).not.toMatch(LIVE_TAG);
    expect(renderNotice({ label: "l", text: "x", mention: "<at>" }).content).toBe(JSON.stringify({ text: "【l】x" }));
  });
  it("over-long text is cut with an ellipsis and stays under the cap", () => {
    const n = renderNotice({ label: "l", text: "汉".repeat(30_000) });
    expect(n.bytes).toBeLessThanOrEqual(CAP);
    expect((JSON.parse(n.content) as { text: string }).text.endsWith("…")).toBe(true);
  });
  it("empty text gets the placeholder", () => {
    expect((JSON.parse(renderNotice({ label: "l", text: "  " }).content) as { text: string }).text).toBe(
      `【l】${EMPTY_REPLY_PLACEHOLDER}`,
    );
  });
});

describe("labels embedded in markdown/text content cannot go live (r_ASBT6095 F2)", () => {
  it("stopReason is neutralized in the failed-card lead line", () => {
    for (const stopReason of ["<at id=all></at>", "<font color='red'>x", "</at><at id=all>"]) {
      const r = renderReply(base({ kind: "failed", text: "", failure: { stopReason } }));
      expect(md(r.parts[0]!), stopReason).not.toMatch(LIVE_TAG);
      expect(md(r.parts[0]!).startsWith("**❌ 运行失败** · ")).toBe(true);
    }
  });
  it("the notice label (inside 【】 of a TEXT message, where <at> parses) is neutralized; the mention stays the only live tag", () => {
    for (const label of ['<at user_id="all"></at>', "<at id=all>", "x</at>"]) {
      const n = renderNotice({ label, text: "t", mention: OPEN_ID });
      const text = (JSON.parse(n.content) as { text: string }).text;
      const afterMention = text.slice(`<at user_id="${OPEN_ID}"></at> `.length);
      expect(afterMention, label).not.toMatch(LIVE_TAG);
      const noMention = (JSON.parse(renderNotice({ label, text: "t" }).content) as { text: string }).text;
      expect(noMention, label).not.toMatch(LIVE_TAG);
    }
  });
  it("markupSafeLabel = sanitizeLabel + neutralized tags", () => {
    expect(markupSafeLabel("a\u202e<at id=all>")).toBe(`a<${ZW}at id=all>`);
    expect(markupSafeLabel("")).toBe("session");
  });
  it("the plain_text card header is unchanged (no markup meaning there)", () => {
    expect(cardTitle("<at id=all>")).toBe("pi · <at id=all>");
  });
});

describe("renderNotice size re-check (r_ASBT6095 F6)", () => {
  it("never exceeds its cap, for any cap and escape-heavy / multi-byte / hostile input", () => {
    const texts = [
      "汉".repeat(5_000),
      '"\\\t\u0001'.repeat(2_000),
      "😀".repeat(3_000),
      "<at id=all>".repeat(500),
      "x".repeat(10_000),
    ];
    for (let cap = 256; cap <= 700; cap += 37) {
      for (const text of texts) {
        for (const label of ["l", '"\\\u0001'.repeat(10), "字".repeat(100)]) {
          const n = renderNotice({ label, text, mention: OPEN_ID, maxBytes: cap });
          expect(n.bytes).toBe(Buffer.byteLength(n.content));
          expect(n.bytes, `cap ${cap}`).toBeLessThanOrEqual(cap);
          expect(() => JSON.parse(n.content)).not.toThrow();
        }
      }
    }
  });
});

describe("oversized fence opener through renderReply (r_ASBT6095 F1)", () => {
  it("a ~19.9 KB single ```-prefixed line keeps its content in truncate mode (no fallback card), every card ≤ cap", () => {
    const text = `\`\`\`${"a".repeat(19_900)}\nmore code\n\`\`\``;
    for (const overflow of ["truncate", "file"] as const) {
      const r = renderReply(base({ text, overflow }));
      for (const p of r.parts) expect(p.bytes).toBeLessThanOrEqual(CAP);
      const joined = r.parts.map(md).join("\n");
      expect(joined, overflow).not.toContain("回复无法渲染");
      expect(joined, overflow).toContain("aaaaaaaaaa");
      if (overflow === "truncate") expect(joined).toContain("more code");
    }
  });
});
