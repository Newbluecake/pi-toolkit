// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";
import {
  createMarkdownSegmenter,
  createSourceSegmenter,
  classifyChunkOutcome,
  nextChunkAction,
  PREVIEW_MD_PENDING_MAX,
  PREVIEW_MD_STREAM_NODE_MAX,
  SOURCE_FORCE_CHARS,
  STREAM_AUTO_RETRY_MAX,
} from "../../../src/web-hub/ui/src/logic/previewStream.js";
import { PREVIEW_CHUNK_MIN_GAP_MS } from "../../../src/web-hub/protocol/preview.js";

/**
 * chunked-plan §4.2/§4.3 (package P2a): the two segmenters and the stream state machine.
 *
 * Pinned properties:
 * - markdown: with force-cut and budgets disabled, `segments.flatMap(parse) ≡ parse(whole)`
 *   for seeded documents fed in random-size chunks (§6.2);
 * - source (r2 定稿规则 §4.3.4): (a) every non-final segment is non-empty and does not end
 *   with "\n"; (b) `segments.map(s => s.text + s.sep).join("")` is STRICTLY the consumed
 *   input; (c) `sep === "\n"` iff the segment is neither `forced` nor `final`; (d) with the
 *   force cut disabled no `forced` segment exists.
 */

/** mulberry32 — deterministic PRNG (same discipline as logic-preview.test.ts). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/* ---------------------------------------------------------------------------
 * Seeded markdown document generator (\n-only — the segmenter normalizes input itself).
 * ------------------------------------------------------------------------- */
function genMarkdownDoc(r: () => number): string {
  const blocks: string[] = [];
  const n = 6 + Math.floor(r() * 14);
  for (let b = 0; b < n; b++) {
    const kind = Math.floor(r() * 8);
    if (kind === 0) {
      blocks.push(`# H${b}`);
    } else if (kind === 1) {
      const lines = 1 + Math.floor(r() * 3);
      blocks.push(Array.from({ length: lines }, (_, i) => `para ${b} line ${i} with *em* and \`code\``).join("\n"));
    } else if (kind === 2) {
      const fence = pick(r, ["```", "~~~", "````", "``````"] as const);
      const body: string[] = [];
      const bl = 1 + Math.floor(r() * 4);
      for (let i = 0; i < bl; i++) {
        // body lines include blanks and fence-LOOKING lines that must not close early
        body.push(pick(r, ["code line", "", "```", "~~~", " ```", "| a | b |", "> not quote"] as const));
      }
      const close = r() < 0.85 ? `\n${fence}${r() < 0.3 ? fence[0] : ""}` : ""; // 15% unclosed
      blocks.push(`${fence}js\n${body.join("\n")}${close}`);
    } else if (kind === 3) {
      blocks.push(`| h${b} | x |\n| --- | ---: |\n| 1 | 2 |\n| \`\`\`a | b |`);
    } else if (kind === 4) {
      const lines = [`> quote ${b}`];
      if (r() < 0.5) lines.push(">");
      if (r() < 0.5) lines.push(`lazy continuation ${b}`);
      lines.push(`> end ${b}`);
      blocks.push(lines.join("\n"));
    } else if (kind === 5) {
      blocks.push(`- item ${b}a\n- item ${b}b\n  continuation\n1. one\n2. two`);
    } else if (kind === 6) {
      blocks.push(`reference [a][r] stays literal\n\n[r]: https://example.com/${b}`);
    } else {
      blocks.push(`plain ${b}`);
    }
    blocks.push("\n".repeat(Math.floor(r() * 3))); // 0–2 blank lines between blocks
  }
  let doc = blocks.join("\n");
  if (r() < 0.5) doc += "\n"; // trailing newline or not
  if (r() < 0.3) doc += "incomplete tail"; // mid-line end
  return doc;
}

type MdSeg =
  | { id: number; kind: "md"; nodes: unknown[]; forced?: true; tailIncomplete?: true; final?: true }
  | { id: number; kind: "src"; reason: string; text: string; forced?: true; tailIncomplete?: true; final?: true };

const segNodes = (s: MdSeg): unknown[] => (s.kind === "md" ? s.nodes : (parseMarkdown(s.text) as unknown[]));

describe("logic/previewStream.js createMarkdownSegmenter (chunked-plan §4.3.3)", () => {
  it("property: chunked segmentation parses ≡ whole parse (force cut + budgets off)", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const doc = genMarkdownDoc(r);
      const seg = createMarkdownSegmenter({
        pendingMax: Number.MAX_SAFE_INTEGER,
        totalNodeMax: Number.MAX_SAFE_INTEGER,
      });
      const out: MdSeg[] = [];
      let at = 0;
      while (at < doc.length) {
        const len = 1 + Math.floor(r() * 200);
        out.push(...(seg.push(doc.slice(at, at + len)) as MdSeg[]));
        at += len;
      }
      out.push(...(seg.flush("eof") as MdSeg[]));
      expect(out.every((s) => s.kind === "md")).toBe(true);
      const want = parseMarkdown(doc);
      const got = out.flatMap(segNodes);
      expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(JSON.stringify(want)));
    }
  });

  it("unclosed fence to EOF: flush('eof') equals the whole parse", () => {
    const doc = "intro\n\n```js\nline1\n**not bold**\nline3";
    const seg = createMarkdownSegmenter();
    // The blank BEFORE the fence is still a safe cut; the fence tail stays pending.
    const first = seg.push(doc) as MdSeg[];
    expect(first).toHaveLength(1);
    expect(segNodes(first[0]!)).toEqual(parseMarkdown("intro\n\n"));
    const rest = seg.flush("eof") as MdSeg[];
    expect(rest).toHaveLength(1);
    expect([...first, ...rest].flatMap(segNodes)).toEqual(parseMarkdown(doc));
  });

  it("force cut inside a fence closes + reopens it; the two blocks' texts conserve the original", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const doc = `\`\`\`js\n${body}\n`; // no closing fence, no blank line
    const seg = createMarkdownSegmenter({ pendingMax: 100 });
    const out = seg.push(doc) as MdSeg[];
    expect(out).toHaveLength(1);
    const first = out[0]!;
    expect(first.kind).toBe("md");
    expect(first.forced).toBe(true);
    const rest = seg.flush("eof") as MdSeg[];
    // The first block ends with a synthesized closing fence; the second re-opens it.
    // (An empty re-opened tail contributes no lines.)
    const lines = [...out, ...rest].flatMap((s) =>
      segNodes(s).flatMap((n) => {
        const node = n as { type: string; text?: string };
        return node.type === "code_block" && node.text !== "" ? (node.text ?? "").split("\n") : [];
      }),
    );
    expect(lines).toEqual(Array.from({ length: 40 }, (_, i) => `line ${i}`));
  });

  it("force cut at the last complete line outside a fence (marked forced)", () => {
    const doc = `${"x".repeat(60)}\n${"y".repeat(60)}\n${"z".repeat(60)}`; // no blank lines
    const seg = createMarkdownSegmenter({ pendingMax: 100 });
    const out = seg.push(doc) as MdSeg[];
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("md");
    expect(out[0]!.forced).toBe(true);
    expect(segNodes(out[0]!)).toEqual(parseMarkdown(`${"x".repeat(60)}\n${"y".repeat(60)}\n`));
    const tail = seg.flush("eof") as MdSeg[];
    expect(segNodes(tail[0]!)).toEqual(parseMarkdown("z".repeat(60)));
  });

  it("a single >pendingMax line with no newline goes out as src reason:forced", () => {
    const seg = createMarkdownSegmenter({ pendingMax: 50 });
    const out = seg.push("x".repeat(120)) as MdSeg[];
    expect(out).toEqual([{ id: 1, kind: "src", reason: "forced", text: "x".repeat(120), forced: true }]);
  });

  it("a chunk-trailing \\r is HELD: a split CRLF normalizes to one \\n, a lone \\r to \\n at the next push", () => {
    const seg = createMarkdownSegmenter();
    expect(seg.push("a\r")).toEqual([]); // "\r" held
    expect(seg.push("\nb\n\nc")).toHaveLength(1); // "a\nb\n\n" cut, "c" pending
    const out = seg.flush("eof") as MdSeg[];
    const seg2 = createMarkdownSegmenter();
    const o2: MdSeg[] = [];
    o2.push(...(seg2.push("a\r") as MdSeg[]));
    o2.push(...(seg2.push("\nb\n\nc") as MdSeg[]));
    o2.push(...(seg2.flush("eof") as MdSeg[]));
    expect(o2.flatMap(segNodes)).toEqual(parseMarkdown("a\nb\n\nc"));
    expect(out).toHaveLength(1);
  });

  it("flush('stop') drops the incomplete last line (B5 semantics) and marks tailIncomplete", () => {
    const seg = createMarkdownSegmenter();
    expect(seg.push("a\n\nb\npartial")).toHaveLength(1); // "a\n\n"
    const out = seg.flush("stop") as MdSeg[];
    expect(out).toHaveLength(1);
    expect(out[0]!.tailIncomplete).toBe(true);
    expect(out[0]!.final).toBe(true);
    expect(segNodes(out[0]!)).toEqual(parseMarkdown("b\n"));
  });

  it("flush('stop') with no complete line keeps the pending verbatim", () => {
    const seg = createMarkdownSegmenter();
    seg.push("no-newline-here");
    const out = seg.flush("stop") as MdSeg[];
    expect(segNodes(out[0]!)).toEqual(parseMarkdown("no-newline-here"));
  });

  it("per-segment node budget degrades ONLY that segment (reason:node-budget)", () => {
    const seg = createMarkdownSegmenter({ nodeMax: 3 });
    const out = seg.push("# big\n\n- a\n- b\n- c\n\nsmall") as MdSeg[]; // cut before "small"
    expect(out[0]!.kind).toBe("src");
    expect((out[0]! as { reason?: string }).reason).toBe("node-budget");
    const tail = seg.flush("eof") as MdSeg[];
    expect(tail[0]!.kind).toBe("md"); // next segment unaffected
  });

  it("the global node budget is STICKY (reason:total-budget) once exceeded", () => {
    const seg = createMarkdownSegmenter({ totalNodeMax: 5 });
    const o1 = seg.push("# a\n\npara one\n\n") as MdSeg[]; // heading + paragraph ≈ 3 nodes
    expect(o1[0]!.kind).toBe("md");
    const o2 = seg.push("# b\n\npara two\n\n") as MdSeg[]; // would exceed the global budget
    expect(o2[0]!.kind).toBe("src");
    expect((o2[0]! as { reason?: string }).reason).toBe("total-budget");
    seg.push("tail"); // stays pending (no complete line boundary)
    const o3 = seg.flush("eof") as MdSeg[]; // sticky: everything after degrades too
    expect(o3[0]!.kind).toBe("src");
    expect((o3[0]! as { reason?: string }).reason).toBe("total-budget");
  });

  it("empty chunks and a BOM-carrying first chunk are harmless", () => {
    const seg = createMarkdownSegmenter();
    expect(seg.push("")).toEqual([]);
    expect(seg.push("")).toEqual([]);
    const out = seg.push("\ufeff# t\n\nbody\n") as MdSeg[];
    out.push(...(seg.flush("eof") as MdSeg[]));
    const whole = parseMarkdown("\ufeff# t\n\nbody\n");
    expect(out.flatMap(segNodes)).toEqual(whole);
  });

  it("default constants match the plan (D8 / §4.3.3)", () => {
    expect(PREVIEW_MD_PENDING_MAX).toBe(512 * 1024);
    expect(PREVIEW_MD_STREAM_NODE_MAX).toBe(160_000);
    expect(SOURCE_FORCE_CHARS).toBe(512 * 1024);
  });
});

/* ------------------------------------------------------------------------- */

type SrcSeg = { id: number; text: string; sep: string; forced?: true; final?: true };

function genSourceText(r: () => number): string {
  const pieces: string[] = [];
  const n = 4 + Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.3)
      pieces.push("\n".repeat(1 + Math.floor(r() * 4))); // blank runs
    else if (k < 0.45)
      pieces.push(`line ${i}\r\n`); // CRLF
    else if (k < 0.5)
      pieces.push("\r"); // lone CR
    else if (k < 0.55)
      pieces.push(`${"long".repeat(50 + Math.floor(r() * 100))}\n`); // long line
    else pieces.push(`line ${i} abc 中文🎉\n`);
  }
  let text = pieces.join("");
  if (r() < 0.3) text = text.replace(/\n$/, ""); // sometimes no trailing newline
  if (r() < 0.1) text = "\n".repeat(1 + Math.floor(r() * 5)); // all-newline documents
  return text;
}

/** Feed `text` in random-size chunks; returns all segments incl. the eof flush. */
function runSource(r: () => number, text: string, forceChars: number): SrcSeg[] {
  const seg = createSourceSegmenter({ forceChars });
  const out: SrcSeg[] = [];
  let at = 0;
  while (at < text.length) {
    const len = 1 + Math.floor(r() * 97);
    out.push(...(seg.push(text.slice(at, at + len)) as SrcSeg[]));
    at += len;
  }
  out.push(...(seg.flush("eof") as SrcSeg[]));
  return out;
}

function assertSourceInvariants(text: string, segs: SrcSeg[], forceEnabled: boolean) {
  for (const s of segs) {
    if (s.final !== true) {
      expect(s.text).not.toBe(""); // (a)
      expect(s.text.endsWith("\n")).toBe(false);
    }
    // (c)
    expect(s.sep === "\n").toBe(s.forced !== true && s.final !== true);
    if (!forceEnabled) expect(s.forced).toBeUndefined(); // (d)
  }
  // (b) strict copy conservation
  expect(segs.map((s) => s.text + s.sep).join("")).toBe(text);
}

describe("logic/previewStream.js createSourceSegmenter (chunked-plan §4.3.4, r2)", () => {
  it("property: invariants (a)–(d) over seeded texts, random chunking, force cut OFF", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const r = rng(10_000 + seed);
      const text = genSourceText(r);
      assertSourceInvariants(text, runSource(r, text, Number.MAX_SAFE_INTEGER), false);
    }
  });

  it("property: invariants (a)–(c) still hold with a tiny force threshold", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const r = rng(20_000 + seed);
      const text = genSourceText(r);
      assertSourceInvariants(text, runSource(r, text, 64), true);
    }
  });

  it("fixed table (§4.3.4): 'a\\n\\nb' ⇒ 'a' | '\\nb'", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("a\n\nb")).toEqual([{ id: 1, text: "a", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([{ id: 2, text: "\nb", sep: "", final: true }]);
  });

  it("fixed table: 'a\\n\\n\\nb' ⇒ 'a' | '\\n\\nb'", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("a\n\n\nb")).toEqual([{ id: 1, text: "a", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([{ id: 2, text: "\n\nb", sep: "", final: true }]);
  });

  it("fixed table: 'a\\nb\\n' fed per line ⇒ 'a' | 'b', nothing left at EOF", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("a\n")).toEqual([{ id: 1, text: "a", sep: "\n" }]);
    expect(seg.push("b\n")).toEqual([{ id: 2, text: "b", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([]);
  });

  it("fixed table: 'x\\n\\n\\n' at EOF ⇒ 'x' | final '\\n\\n'", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("x\n\n\n")).toEqual([{ id: 1, text: "x", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([{ id: 2, text: "\n\n", sep: "", final: true }]);
  });

  it("fixed table: '\\n\\nb\\nc' ⇒ '\\n\\nb' | 'c'", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("\n\nb\nc")).toEqual([{ id: 1, text: "\n\nb", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([{ id: 2, text: "c", sep: "", final: true }]);
  });

  it("fixed table: 'a\\n\\n' holds the trailing '\\n' until more text arrives", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("a\n\n")).toEqual([{ id: 1, text: "a", sep: "\n" }]);
    expect(seg.pendingLength).toBe(1);
    expect(seg.push("b\n\nc")).toEqual([{ id: 2, text: "\nb", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([{ id: 3, text: "\nc", sep: "", final: true }]);
  });

  it("an all-newline pending is HELD (never force-cut) and flushed at EOF/stop", () => {
    const seg = createSourceSegmenter({ forceChars: 2 });
    expect(seg.push("\n\n\n\n\n")).toEqual([]);
    expect(seg.pendingLength).toBe(5);
    expect(seg.flush("eof")).toEqual([{ id: 1, text: "\n\n\n\n\n", sep: "", final: true }]);
    const seg2 = createSourceSegmenter({ forceChars: 2 });
    seg2.push("\n\n\n");
    expect(seg2.flush("stop")).toEqual([{ id: 1, text: "\n\n\n", sep: "", final: true }]);
  });

  it("CRLF is raw: 'a\\r\\n\\r\\nb' cuts to 'a\\r\\n\\r' | 'b' (chars identical to one <pre>)", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("a\r\n\r\nb")).toEqual([{ id: 1, text: "a\r\n\r", sep: "\n" }]);
    expect(seg.flush("eof")).toEqual([{ id: 2, text: "b", sep: "", final: true }]);
  });

  it("force cut on one long newline-free line: sep '' and copy conservation", () => {
    const seg = createSourceSegmenter({ forceChars: 16 });
    const long = "x".repeat(100);
    const out = seg.push(`\n\n${long}`) as SrcSeg[]; // no legal cut (every \n precedes another \n/pos 0)
    expect(out).toEqual([{ id: 1, text: `\n\n${long}`, sep: "", forced: true }]);
    expect(out.map((s) => s.text + s.sep).join("")).toBe(`\n\n${long}`);
  });

  it("empty input flushes to nothing", () => {
    const seg = createSourceSegmenter();
    expect(seg.push("")).toEqual([]);
    expect(seg.flush("eof")).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */

const STREAM = { loaded: 100, total: 1_000, cap: 8 * 1024 * 1024, autoRetries: 0 };

describe("logic/previewStream.js nextChunkAction (chunked-plan §4.2)", () => {
  it("more + gap elapsed + loaded < min(total, cap) ⇒ load", () => {
    expect(nextChunkAction({ ...STREAM, state: "more" }, 10_000, 0)).toEqual({ type: "load" });
  });

  it("more + gap too short ⇒ schedule the remaining delay (coalesced)", () => {
    expect(nextChunkAction({ ...STREAM, state: "more" }, 100, 0)).toEqual({
      type: "schedule",
      delayMs: PREVIEW_CHUNK_MIN_GAP_MS - 100,
    });
    expect(nextChunkAction({ ...STREAM, state: "more" }, PREVIEW_CHUNK_MIN_GAP_MS, 0)).toEqual({ type: "load" });
  });

  it("more + loaded >= min(total, cap) ⇒ none", () => {
    expect(nextChunkAction({ ...STREAM, state: "more", loaded: 1_000 }, 10_000, 0)).toEqual({ type: "none" });
    expect(nextChunkAction({ ...STREAM, state: "more", loaded: STREAM.cap }, 10_000, 0)).toEqual({ type: "none" });
  });

  it("loading / waiting / done / cap / changed ⇒ none (single-flight + terminal)", () => {
    for (const state of ["loading", "waiting", "done", "cap", "changed"] as const) {
      expect(nextChunkAction({ ...STREAM, state }, 10_000, 0)).toEqual({ type: "none" });
    }
  });

  it("error: retryable ⇒ load with resetRetries (manual 重试); non-retryable ⇒ none", () => {
    expect(nextChunkAction({ ...STREAM, state: "error", retryable: true }, 10_000, 0)).toEqual({
      type: "load",
      resetRetries: true,
    });
    expect(nextChunkAction({ ...STREAM, state: "error", retryable: false }, 10_000, 0)).toEqual({ type: "none" });
  });
});

describe("logic/previewStream.js classifyChunkOutcome (chunked-plan §4.2)", () => {
  const loading = { ...STREAM, state: "loading" as const };

  it("200 text, bytes > 0, size === total, truncated ⇒ more (append, autoRetries reset)", () => {
    const d = classifyChunkOutcome(
      { ...loading, autoRetries: 2 },
      {
        ok: true,
        kind: "text",
        size: 1_000,
        truncated: true,
        bytes: 200,
        text: "chunk",
      },
    );
    expect(d).toEqual({ state: "more", append: { text: "chunk", bytes: 200 }, loaded: 300, autoRetries: 0 });
  });

  it("200 truncated crossing the cap ⇒ cap", () => {
    const d = classifyChunkOutcome(
      { ...loading, cap: 250 },
      {
        ok: true,
        kind: "text",
        size: 1_000,
        truncated: true,
        bytes: 200,
        text: "chunk",
      },
    );
    expect(d).toEqual({ state: "cap", append: { text: "chunk", bytes: 200 }, loaded: 300, autoRetries: 0 });
  });

  it("200 !truncated with loaded === total ⇒ done", () => {
    const d = classifyChunkOutcome(loading, {
      ok: true,
      kind: "text",
      size: 1_000,
      truncated: false,
      bytes: 900,
      text: "tail",
    });
    expect(d).toEqual({ state: "done", append: { text: "tail", bytes: 900 }, loaded: 1_000, autoRetries: 0 });
  });

  it("200 !truncated but loaded !== total ⇒ changed (no append)", () => {
    const d = classifyChunkOutcome(loading, {
      ok: true,
      kind: "text",
      size: 1_000,
      truncated: false,
      bytes: 100,
      text: "x",
    });
    expect(d).toEqual({ state: "changed" });
  });

  it("200 with size !== total ⇒ changed (no append)", () => {
    const d = classifyChunkOutcome(loading, {
      ok: true,
      kind: "text",
      size: 2_000,
      truncated: true,
      bytes: 100,
      text: "x",
    });
    expect(d).toEqual({ state: "changed" });
  });

  it("200 bytes === 0 && truncated ⇒ non-retryable error (protocol violation)", () => {
    const d = classifyChunkOutcome(loading, {
      ok: true,
      kind: "text",
      size: 1_000,
      truncated: true,
      bytes: 0,
      text: "",
    });
    expect(d).toEqual({ state: "error", error: "E_BAD_RESPONSE", retryable: false });
  });

  it("200 bytes === 0 && !truncated at exactly total ⇒ done (empty tail)", () => {
    const d = classifyChunkOutcome(
      { ...loading, loaded: 1_000 },
      {
        ok: true,
        kind: "text",
        size: 1_000,
        truncated: false,
        bytes: 0,
        text: "",
      },
    );
    expect(d).toEqual({ state: "done", append: { text: "", bytes: 0 }, loaded: 1_000, autoRetries: 0 });
  });

  it("200 of a non-text kind (a broken hub) ⇒ non-retryable E_BAD_RESPONSE", () => {
    expect(classifyChunkOutcome(loading, { ok: true, kind: "image" })).toEqual({
      state: "error",
      error: "E_BAD_RESPONSE",
      retryable: false,
    });
  });

  it("409 E_PREVIEW_CHANGED / 404 / 415 ⇒ changed (terminal)", () => {
    for (const o of [
      { ok: false, status: 409, error: "E_PREVIEW_CHANGED" },
      { ok: false, status: 404, error: "E_NOT_FOUND" },
      { ok: false, status: 415, error: "E_PREVIEW_UNSUPPORTED" },
    ]) {
      expect(classifyChunkOutcome(loading, o)).toEqual({ state: "changed" });
    }
  });

  it("409 E_SESSION_CHANGED ⇒ close", () => {
    expect(classifyChunkOutcome(loading, { ok: false, status: 409, error: "E_SESSION_CHANGED" })).toEqual({
      close: true,
    });
  });

  it("429/503 (E_RATE / E_BUSY / E_HUB_RESTARTING) ⇒ waiting with Retry-After while under the streak cap", () => {
    const d = classifyChunkOutcome(loading, { ok: false, status: 429, error: "E_RATE", retryAfterS: 2 });
    expect(d).toEqual({ state: "waiting", retryAfterS: 2, autoRetries: 1 });
    const d2 = classifyChunkOutcome(loading, { ok: false, status: 503, error: "E_BUSY" });
    expect(d2).toEqual({ state: "waiting", retryAfterS: 1, autoRetries: 1 });
    const d3 = classifyChunkOutcome(loading, { ok: false, status: 503, error: "E_HUB_RESTARTING" });
    expect(d3).toEqual({ state: "waiting", retryAfterS: 1, autoRetries: 1 });
  });

  it(`429/503 beyond ${STREAM_AUTO_RETRY_MAX} consecutive auto-retries ⇒ retryable error`, () => {
    const s = { ...loading, autoRetries: STREAM_AUTO_RETRY_MAX };
    expect(classifyChunkOutcome(s, { ok: false, status: 429, error: "E_RATE", retryAfterS: 1 })).toEqual({
      state: "error",
      error: "E_RATE",
      retryable: true,
    });
    expect(classifyChunkOutcome(s, { ok: false, status: 503, error: "E_BUSY" })).toEqual({
      state: "error",
      error: "E_BUSY",
      retryable: true,
    });
  });

  it("E_DEADLINE / E_NETWORK / 500 / E_AUTH ⇒ retryable error", () => {
    for (const o of [
      { ok: false, status: 0, error: "E_DEADLINE" },
      { ok: false, status: 0, error: "E_NETWORK" },
      { ok: false, status: 500, error: "E_INTERNAL" },
      { ok: false, status: 401, error: "E_AUTH" },
    ]) {
      expect(classifyChunkOutcome(loading, o)).toEqual({
        state: "error",
        error: (o as { error: string }).error,
        retryable: true,
      });
    }
  });

  it("403 / 400 / E_BAD_RESPONSE ⇒ non-retryable error", () => {
    for (const o of [
      { ok: false, status: 403, error: "E_FORBIDDEN" },
      { ok: false, status: 400, error: "E_BAD_REQUEST" },
      { ok: false, status: 0, error: "E_BAD_RESPONSE" },
    ]) {
      const d = classifyChunkOutcome(loading, o);
      expect(d).toMatchObject({ state: "error", retryable: false });
    }
  });

  it("E_ABORT ⇒ drop (the controller already moved on)", () => {
    expect(classifyChunkOutcome(loading, { ok: false, status: 0, error: "E_ABORT" })).toEqual({ drop: true });
  });
});
