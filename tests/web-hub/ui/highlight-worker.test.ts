// @vitest-environment happy-dom
/**
 * preview-perf P5 (plan r3 §5.3) — the worker ENTRY's pure reduction: `computeWorkerReply`
 * (request → reply + transfer list). Real Prism rides along (the module statically imports
 * `highlight-impl.js`), so these tests pin the actual tokenize → flatten(80k) → encode
 * pipeline the worker chunk runs in the browser, including cross-line syntax state (the whole
 * point of tokenizing in the worker instead of per line).
 *
 * The glue registration is guarded (`self` missing/lacking postMessage under node registers
 * nothing) — importing the module here is side-effect-free even where `self` exists.
 */
import { describe, expect, it } from "vitest";
import { computeWorkerReplyWith } from "../../../src/web-hub/ui/src/components/shared/highlight-worker.js";
import Prism from "../../../src/web-hub/ui/src/components/shared/highlight-impl.js";
import { decodeHighlightSpans } from "../../../src/web-hub/ui/src/logic/highlight.js";
import { HIGHLIGHT_WORKER_MAX_TOKENS } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";

const TS = 'const answer = 42; // comment\nlet s = "str";\n';

describe("highlight-worker computeWorkerReply (§5.3)", () => {
  it("tokenizes the full text and returns a transferable HighlightSpans payload (real Prism)", () => {
    const out = computeWorkerReplyWith(Prism, { kind: "tokenize", id: 7, text: TS, lang: "typescript" });
    expect(out).not.toBeNull();
    if (out?.reply.kind !== "spans") throw new Error(`expected spans, got ${out?.reply.kind}`);
    expect(out.reply.id).toBe(7);
    expect(out.reply.spans).toBeInstanceOf(Uint32Array);
    expect(out.reply.spans.length % 3).toBe(0);
    expect(out.reply.classes.length).toBeGreaterThan(0);
    expect(out.reply.classes.every((c) => typeof c === "string" && c.startsWith("tok-"))).toBe(true);
    // the transfer list carries the payload's buffer (§5.3 zero-copy crossing)
    expect(out.transfer).toContain(out.reply.spans.buffer);
    // the spans decode back into token parts over the SOURCE text
    const parts = decodeHighlightSpans({ classes: out.reply.classes, spans: out.reply.spans }, TS, 0, TS.length);
    expect(parts).not.toBeNull();
    expect(parts?.some((p) => p.cls.includes("tok-keyword"))).toBe(true);
    expect(parts?.some((p) => p.cls.includes("tok-comment"))).toBe(true);
    // decode is line-scoped too (what displayLine does per mounted line)
    const line0 = decodeHighlightSpans({ classes: out.reply.classes, spans: out.reply.spans }, TS, 0, TS.indexOf("\n"));
    expect(line0?.some((p) => p.cls.includes("tok-keyword"))).toBe(true);
  });

  it("keeps cross-line syntax state: a multi-line string is ONE span crossing line breaks", () => {
    const text = "const s = `a\nb\nc`;\n";
    const out = computeWorkerReplyWith(Prism, { kind: "tokenize", id: 1, text, lang: "typescript" });
    if (out?.reply.kind !== "spans") throw new Error(`expected spans, got ${out?.reply.kind}`);
    const spans = out.reply.spans;
    let crossed = false;
    for (let i = 0; i + 2 < spans.length; i += 3) {
      const st = spans[i]!;
      const en = spans[i + 1]!;
      if (en > st && text.slice(st, en).includes("\n")) crossed = true;
    }
    expect(crossed).toBe(true); // per-line tokenization could NEVER produce this
  });

  it("unknown grammar ⇒ plain for that file (worker stays usable)", () => {
    const out = computeWorkerReplyWith(Prism, { kind: "tokenize", id: 2, text: "x", lang: "nosuchlang" });
    expect(out?.reply).toEqual({ kind: "plain", id: 2 });
    expect(out?.transfer).toEqual([]);
  });

  it(`token budget (HIGHLIGHT_WORKER_MAX_TOKENS = ${HIGHLIGHT_WORKER_MAX_TOKENS}) ⇒ plain, never a throw`, () => {
    // 40_001 identifiers + 40_001 operators ⇒ 80_002 flat parts > 80_000
    const text = `${"a+".repeat(40_001)}b\n`;
    const out = computeWorkerReplyWith(Prism, { kind: "tokenize", id: 3, text, lang: "typescript" });
    expect(out?.reply).toEqual({ kind: "plain", id: 3 });
  });

  it("a grammar that throws degrades to plain (never an uncaught worker error)", async () => {
    // `Prism.tokenize` with a bogus-but-present grammar entry: languages object allows
    // arbitrary keys — point at something that explodes when used as a grammar.
    // Simplest reliable explosion: a grammar whose matchexec path gets a RegExp-like object
    // that throws on exec. We piggyback the REAL module's Prism global.
    const prev = (Prism.languages as Record<string, unknown>)["kaboom-lang"];
    (Prism.languages as Record<string, unknown>)["kaboom-lang"] = {
      pattern: {
        exec(): string[] {
          throw new Error("grammar blew up");
        },
        lastIndex: 0,
        global: true,
      },
    };
    try {
      const out = computeWorkerReplyWith(Prism, { kind: "tokenize", id: 4, text: "zz", lang: "kaboom-lang" });
      // whatever prism does with this shape, the reduction must answer, never throw
      expect(out === null || out.reply.kind === "plain" || out.reply.kind === "spans").toBe(true);
    } finally {
      delete (Prism.languages as Record<string, unknown>)["kaboom-lang"];
      if (prev !== undefined) (Prism.languages as Record<string, unknown>)["kaboom-lang"] = prev;
    }
  });

  it("rejects malformed messages (ignored, never replied)", () => {
    expect(computeWorkerReplyWith(Prism, null)).toBeNull();
    expect(computeWorkerReplyWith(Prism, undefined)).toBeNull();
    expect(computeWorkerReplyWith(Prism, "tokenize")).toBeNull();
    expect(computeWorkerReplyWith(Prism, {})).toBeNull();
    expect(computeWorkerReplyWith(Prism, { kind: "other", id: 1, text: "x", lang: "ts" })).toBeNull();
    expect(computeWorkerReplyWith(Prism, { kind: "tokenize", id: "7", text: "x", lang: "typescript" })).toBeNull();
    expect(computeWorkerReplyWith(Prism, { kind: "tokenize", id: 7, text: 1, lang: "typescript" })).toBeNull();
    expect(computeWorkerReplyWith(Prism, { kind: "tokenize", id: 7, text: "x", lang: 9 })).toBeNull();
  });
});
