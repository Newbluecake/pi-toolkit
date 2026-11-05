import { describe, expect, it } from "vitest";
import { extractReflexRows, scanReflexLine } from "../../../src/reflex/core/shadow-scan.js";
import {
  accumulate,
  countCrossSessionRepeats,
  evaluatePromotion,
  msPercentiles,
  type ScriptStats,
} from "../../../src/reflex/core/promotion.js";
import type { ReflexRecordV1 } from "../../../src/reflex/core/types.js";

function record(index = 0, at = 1_000_000): ReflexRecordV1 {
  return {
    v: 1,
    kind: "shadow",
    at,
    scriptId: "jobs.list",
    scriptVer: 1,
    state: "shadow",
    band: "high",
    requestDigest: `digest-${index}`,
    chars: 8,
    port: { outcome: "ok", ms: index + 1, portVer: 1 },
    model: { agree: "agree", tools: ["bash_job:list"] },
  };
}
function recordLine(rec = record()): string {
  return JSON.stringify({ type: "custom", customType: "subagent:reflex-record", id: "rec-1", data: rec });
}
function correctionLine(): string {
  return JSON.stringify({
    type: "custom",
    customType: "subagent:reflex-correction",
    data: {
      v: 1,
      at: 1_000_001,
      targetKind: "shadow",
      targetScriptId: "jobs.list",
      targetScriptVer: 1,
      targetDigest: "digest-0",
      deltaMs: 1,
      correctionDigest: "correction-1",
    },
  });
}
function answerLine(): string {
  return JSON.stringify({
    type: "custom_message",
    customType: "subagent:reflex",
    timestamp: new Date(1_000_000).toISOString(),
    content: "private answer body",
    details: {
      v: 1,
      scriptId: "jobs.list",
      scriptVer: 1,
      portId: "jobs.list",
      portVer: 1,
      ms: 12,
      requestDigest: "digest-0",
      lines: 7,
      truncated: false,
      facts: { running: 1 },
    },
  });
}

/** Test the actual extraction + frozen promotion APIs, not hand-built verdicts. */
function summarize(sessions: readonly (readonly string[])[]): ScriptStats {
  const stats = new Map<string, ScriptStats>();
  const occurrences: { session: string; at: number; key: string; digest: string }[] = [];
  const samples: number[] = [];
  sessions.forEach((lines, session) => {
    for (const line of lines) {
      const row = extractReflexRows(line);
      expect(row).toBeDefined();
      if (row === undefined) throw new Error("bad acceptance sample");
      accumulate(stats, row);
      if (row.kind === "correction") continue;
      const data = row.kind === "record" ? row.rec : row.details;
      const at = row.kind === "record" ? row.rec.at : Date.parse(JSON.parse(line).timestamp);
      if (row.kind === "answer" || row.rec.kind === "shadow")
        occurrences.push({
          session: String(session),
          at,
          key: `${data.scriptId}@${data.scriptVer}`,
          digest: data.requestDigest,
        });
      const ms = row.kind === "answer" ? row.details.ms : row.rec.kind === "shadow" ? row.rec.port?.ms : undefined;
      if (ms !== undefined) samples.push(ms);
    }
  });
  const s = stats.get("jobs.list@1");
  if (!s) throw new Error("missing stats");
  s.crossSessionRepeats = countCrossSessionRepeats(occurrences).get("jobs.list@1");
  const percentiles = msPercentiles(samples);
  if (percentiles.p50 !== undefined) s.p50ms = percentiles.p50;
  if (percentiles.p95 !== undefined) s.p95ms = percentiles.p95;
  return s;
}

describe("extractReflexRows", () => {
  it("extracts exact record/answer/correction payloads without content or entry metadata", () => {
    for (const [line, kind, field] of [
      [recordLine(), "record", "rec"],
      [answerLine(), "answer", "details"],
      [correctionLine(), "correction", "c"],
    ] as const) {
      const entry = JSON.parse(line);
      expect(extractReflexRows(line)).toEqual({ kind, [field]: field === "details" ? entry.details : entry.data });
      expect(Object.keys(extractReflexRows(line)!)).toEqual(["kind", field]);
    }
  });
  it.each(["", " ", "{broken", "null", "[]", "3", '"text"'])("skips invalid/unrelated JSON: %s", (line) => {
    expect(extractReflexRows(line)).toBeUndefined();
  });
  it("rejects wrong envelope and v !== 1 for all three entry kinds", () => {
    for (const line of [recordLine(), answerLine(), correctionLine()]) {
      for (const v of [0, 2, "1", undefined]) {
        const e = JSON.parse(line);
        (e.data ?? e.details).v = v;
        expect(extractReflexRows(JSON.stringify(e))).toBeUndefined();
      }
      const e = JSON.parse(line);
      e.type = "message";
      expect(extractReflexRows(JSON.stringify(e))).toBeUndefined();
      e.type = JSON.parse(line).type;
      e.customType = "other:reflex";
      expect(extractReflexRows(JSON.stringify(e))).toBeUndefined();
    }
  });
  it("keeps append-only extra fields", () => {
    const e = JSON.parse(recordLine());
    e.data.future = { count: 1 };
    expect(extractReflexRows(JSON.stringify(e))).toEqual({ kind: "record", rec: e.data });
  });
  it("rejects corrupt payloads rather than manufacturing eligible stats", () => {
    for (const patch of [
      { scriptId: null },
      { scriptVer: 0 },
      { scriptVer: 1.5 },
      { at: "now" },
      { requestDigest: "" },
      { kind: "made-up" },
      { state: "enabled" },
      { band: "low" },
      { reasked: false },
      { port: { outcome: "ok", ms: -1, portVer: 1 } },
      { port: { outcome: "fake", ms: 1, portVer: 1 } },
      { model: { agree: "agree", tools: null } },
      { model: { agree: "fake", tools: [] } },
    ]) {
      const e = JSON.parse(recordLine());
      Object.assign(e.data, patch);
      expect(extractReflexRows(JSON.stringify(e))).toBeUndefined();
    }
    for (const line of [recordLine(), answerLine(), correctionLine()]) {
      const e = JSON.parse(line);
      if (e.data) e.data = null;
      else e.details = [];
      expect(extractReflexRows(JSON.stringify(e))).toBeUndefined();
    }
  });
  it("rejects malformed answer/correction fields", () => {
    const answer = JSON.parse(answerLine());
    answer.details.facts = { running: {} };
    expect(extractReflexRows(JSON.stringify(answer))).toBeUndefined();
    const correction = JSON.parse(correctionLine());
    correction.data.targetScriptVer = "1";
    expect(extractReflexRows(JSON.stringify(correction))).toBeUndefined();
  });
});

describe("R3b promotion acceptance (JSONL across sessions)", () => {
  function sample(n: number): string[][] {
    return Array.from({ length: 3 }, (_, session) =>
      Array.from({ length: n }, (_, i) => i)
        .filter((i) => i % 3 === session)
        .map((i) => recordLine(record(i, 1_000_000 + i * 1000))),
    );
  }
  it("60 shadow candidates across 3 sessions, unique digests, no correction => eligible", () => {
    const s = summarize(sample(60));
    expect(s).toMatchObject({
      candidates: 60,
      portRuns: 60,
      portOk: 60,
      judged: 60,
      agree: 60,
      diverge: 0,
      reasked: 0,
      crossSessionRepeats: 0,
      corrected: 0,
      p50ms: 31,
      p95ms: 58,
    });
    expect(evaluatePromotion(s)).toEqual({ eligible: true, reasons: [] });
  });
  it("49 => 候选不足 50", () => {
    const s = summarize(sample(49));
    expect(s.candidates).toBe(49);
    expect(evaluatePromotion(s)).toEqual({
      eligible: false,
      reasons: ["候选不足 50（当前 49）", "port 运行数不足 50（当前 49）", "判定样本不足 50（当前 49）"],
    });
  });
  it("60 plus independent correction => ineligible, no next record required (PD12)", () => {
    const sessions = sample(60);
    sessions[0]!.push(correctionLine());
    const s = summarize(sessions);
    expect(s.corrected).toBe(1);
    expect(evaluatePromotion(s)).toEqual({ eligible: false, reasons: ["存在纠正（1）"] });
  });
  it.each([
    [5, 1],
    [11, 0],
  ])("same digest in two JSONL sessions %imin apart => repeats=%i", (minutes, repeats) => {
    const sessions = sample(60);
    sessions[0]!.push(recordLine(record(999, 2_000_000)));
    sessions[1]!.push(recordLine(record(999, 2_000_000 + minutes * 60_000)));
    const s = summarize(sessions);
    expect(s.crossSessionRepeats).toBe(repeats);
    expect(evaluatePromotion(s)).toEqual({ eligible: repeats === 0, reasons: repeats ? ["存在跨会话重复（1）"] : [] });
  });
  it("AUTO answers contribute repeats, not shadow candidates", () => {
    const sessions = sample(60);
    sessions[1]!.push(answerLine());
    const s = summarize(sessions);
    expect(s.candidates).toBe(60);
    expect(s.answered).toBe(1);
    expect(s.crossSessionRepeats).toBe(1);
    expect(evaluatePromotion(s)).toEqual({ eligible: false, reasons: ["存在跨会话重复（1）"] });
  });
  it("reasked and script version separation preserve U5", () => {
    const sessions = sample(60);
    sessions[0]!.push(recordLine({ ...record(100), reasked: true }));
    sessions[1]!.push(recordLine({ ...record(0), scriptVer: 2 }));
    const s = summarize(sessions);
    expect(s.candidates).toBe(61);
    expect(s.crossSessionRepeats).toBe(0);
    expect(evaluatePromotion(s)).toEqual({ eligible: false, reasons: ["存在重复提问（1）"] });
  });
});

// ---------------------------------------------------------------------------
// #25 B0 (BD2): draft-era optional fields are accepted leniently; scanReflexLine surfaces the
// entry id for fork dedup. extractReflexRows itself keeps its exact R3b behaviour.
// ---------------------------------------------------------------------------

function correctionData(at: number): Record<string, unknown> {
  return {
    v: 1,
    at,
    targetKind: "shadow",
    targetScriptId: "jobs.list",
    targetScriptVer: 1,
    targetDigest: "digest-0",
    deltaMs: 1,
    correctionDigest: `correction-${at}`,
  };
}
describe("#25 scanReflexLine + draft-era lenient fields", () => {
  const recordLineWith = (over: Record<string, unknown>): string =>
    JSON.stringify({ type: "custom", customType: "subagent:reflex-record", data: { ...record(1, 1_000), ...over } });

  it("accepts draft-era record fields: origin/draftHash/templateHash/port.portId", () => {
    const line = recordLineWith({
      origin: "draft",
      draftHash: "abc",
      templateHash: "def",
      port: { outcome: "ok", ms: 1, portVer: 1, portId: "jobs.list" },
    });
    const row = extractReflexRows(line);
    expect(row).toMatchObject({ kind: "record" });
    if (row?.kind === "record") {
      expect(row.rec.origin).toBe("draft");
      expect(row.rec.templateHash).toBe("def");
      expect(row.rec.port?.portId).toBe("jobs.list");
    }
  });

  it("skips wrong-typed draft-era fields", () => {
    expect(extractReflexRows(recordLineWith({ origin: "builtin" }))).toBeUndefined();
    expect(extractReflexRows(recordLineWith({ templateHash: 5 }))).toBeUndefined();
    expect(
      extractReflexRows(recordLineWith({ port: { outcome: "ok", ms: 1, portVer: 1, portId: "nope" } })),
    ).toBeUndefined();
  });

  it("accepts draft-targeted corrections with targetOrigin/targetTemplateHash; skips wrong shapes", () => {
    const ok = JSON.stringify({
      type: "custom",
      customType: "subagent:reflex-correction",
      data: { ...correctionData(1_500), targetOrigin: "draft", targetTemplateHash: "beef" },
    });
    const row = extractReflexRows(ok);
    expect(row).toMatchObject({ kind: "correction" });
    if (row?.kind === "correction") expect(row.c.targetTemplateHash).toBe("beef");
    expect(
      extractReflexRows(
        JSON.stringify({
          type: "custom",
          customType: "subagent:reflex-correction",
          data: { ...correctionData(1_500), targetOrigin: "builtin" },
        }),
      ),
    ).toBeUndefined();
  });

  it("scanReflexLine surfaces entryId and delegates rows; non-reflex and malformed lines", () => {
    const line = JSON.stringify({
      type: "custom",
      customType: "subagent:reflex-record",
      data: record(1, 1_000),
      id: "0f07645b",
      timestamp: "2026-11-05T00:00:00.000Z",
    });
    const scanned = scanReflexLine(line);
    expect(scanned.entryId).toBe("0f07645b");
    expect(scanned.row).toEqual(extractReflexRows(line));
    // non-reflex custom entries: entryId still surfaces, row undefined
    const other = JSON.stringify({ type: "custom", customType: "subagent:child", data: { v: 1 }, id: "aaaa" });
    expect(scanReflexLine(other)).toEqual({ entryId: "aaaa" });
    // no id, not reflex
    expect(scanReflexLine(JSON.stringify({ type: "message", message: { role: "user", content: "x" } }))).toEqual({});
    // malformed JSON / non-object
    expect(scanReflexLine("not json")).toEqual({});
    expect(scanReflexLine("42")).toEqual({});
  });
});
