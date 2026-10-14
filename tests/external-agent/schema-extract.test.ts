import { describe, expect, it } from "vitest";
import { extractStructuredJson } from "../../src/external-agent/schema-extract.js";

describe("extractStructuredJson (external-agent plan §2.12)", () => {
  it("parses the final ```json fenced block", () => {
    const r = extractStructuredJson('thoughts…\n```json\n{"verdict": "pass"}\n```\ndone? no');
    expect(r).toEqual({ ok: true, value: { verdict: "pass" } });
  });

  it("multiple blocks ⇒ the LAST qualifying one wins", () => {
    const text = '```json\n{"a":1}\n```\nmiddle\n```json\n{"b":2}\n```';
    expect(extractStructuredJson(text)).toEqual({ ok: true, value: { b: 2 } });
  });

  it("a later non-json fence does not shadow an earlier json fence", () => {
    const text = '```json\n{"a":1}\n```\n```\nplain text fence\n```';
    expect(extractStructuredJson(text)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("unlabeled fence with { / [ content qualifies", () => {
    expect(extractStructuredJson('```\n{"x": [1,2]}\n```')).toEqual({ ok: true, value: { x: [1, 2] } });
    expect(extractStructuredJson("```\n[1,2,3]\n```")).toEqual({ ok: true, value: [1, 2, 3] });
    // unlabeled non-JSON content does not qualify
    expect(extractStructuredJson("```\nplain text\n```")).toEqual({ ok: false });
  });

  it("whole-text JSON when no fence and the trim starts with { / [", () => {
    expect(extractStructuredJson('  {"k":1} ')).toEqual({ ok: true, value: { k: 1 } });
    expect(extractStructuredJson("[1]")).toEqual({ ok: true, value: [1] });
  });

  it("no fence, no JSON start ⇒ ok:false", () => {
    expect(extractStructuredJson("just prose")).toEqual({ ok: false });
    expect(extractStructuredJson("")).toEqual({ ok: false });
    expect(extractStructuredJson("   \n  ")).toEqual({ ok: false });
  });

  it("broken JSON in the fence falls back to whole-text, then fails", () => {
    // fence content invalid JSON; whole text does not start with { / [
    expect(extractStructuredJson("```json\n{oops}\n```")).toEqual({ ok: false });
    // fence invalid AND whole text starts with { — whole-text parse is attempted on
    // the ENTIRE text (which contains the fence, so trailing content breaks it).
    const text = '{"ok":true}\n```json\n{broken}\n```';
    expect(extractStructuredJson(text)).toEqual({ ok: false });
    // only when the ENTIRE text is a valid JSON document does the fallback succeed
    expect(extractStructuredJson('{"ok":true}')).toEqual({ ok: true, value: { ok: true } });
  });

  it("unterminated fence is not a fence (falls through to whole-text rules)", () => {
    expect(extractStructuredJson('```json\n{"a":1}')).toEqual({ ok: false });
  });
});
