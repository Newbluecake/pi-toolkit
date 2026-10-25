/**
 * web-hub-cmd-history plan §8.3 协议（P0）: `subagent:cmd` record v1 — sanitizeCmdRecord matrix
 * (docs/dev/web-hub-cmd-history/plan.md §4.1/§4.5).
 *
 * Pins: the frozen constants; valid start/end round-trips; every structural violation ⇒
 * undefined (⇒ pure tombstone in the projection); the output budgets re-applied on read
 * (kind/level whitelist, 8 KiB/entry clip, 64-entry / 32 KiB window, front kept, `truncated`
 * accumulates); content NEVER modified (Q1 原文 — no redaction, no ANSI re-sanitization).
 */
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  CMD_HISTORY_RUNNING_MAX,
  CMD_RECORD_ARGS_MAX_CHARS,
  CMD_RECORD_CMD_ID_RE,
  CMD_RECORD_ENTRY_TYPE,
  CMD_RECORD_ERROR_MAX_CHARS,
  CMD_RECORD_NAME_RE,
  CMD_RECORD_OUTPUT_MAX_ENTRIES,
  CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES,
  CMD_RECORD_OUTPUT_MAX_KEY_CHARS,
  CMD_RECORD_OUTPUT_MAX_TITLE_CHARS,
  CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES,
  CMD_RECORD_VERSION,
  sanitizeCmdRecord,
} from "../../../src/web-hub/protocol/cmd-record.js";

const CMD_ID = "cAbCdEfGhIjKlMnOpQrS"; // 21 chars, local-shape
const STARTED_AT = 1_792_000_000_000;

function startRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    cmdId: CMD_ID,
    phase: "start",
    name: "record",
    args: "status",
    source: "tui",
    startedAt: STARTED_AT,
    ...over,
  };
}

function endRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    cmdId: CMD_ID,
    phase: "end",
    name: "record",
    args: "status",
    source: "web",
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 4_000,
    state: "done",
    output: { entries: [out("traffic viewer: http://127.0.0.1:1234/record?token=abc")] },
    ...over,
  };
}

function out(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "notify", level: "info", text, ...over };
}

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

describe("cmd-record constants (plan §4.1/§4.5/§4.6)", () => {
  it("entry type / version", () => {
    expect(CMD_RECORD_ENTRY_TYPE).toBe("subagent:cmd");
    expect(CMD_RECORD_VERSION).toBe(1);
  });

  it("cmdId / name patterns (frame-id shape / CommandArgsSchema.name shape)", () => {
    expect(CMD_RECORD_CMD_ID_RE.test("cABCDEFGHIJKLMNOPQRST")).toBe(true);
    expect(CMD_RECORD_CMD_ID_RE.test("cmd_0123456789abcdef")).toBe(true);
    expect(CMD_RECORD_CMD_ID_RE.test("c123")).toBe(false); // <16
    expect(CMD_RECORD_CMD_ID_RE.test("bad id with spaces!!")).toBe(false);
    expect(CMD_RECORD_CMD_ID_RE.test(`c${"x".repeat(64)}`)).toBe(false); // >64
    expect(CMD_RECORD_NAME_RE.test("record")).toBe(true);
    expect(CMD_RECORD_NAME_RE.test("topic-switch")).toBe(true);
    expect(CMD_RECORD_NAME_RE.test("a:b_.c-1")).toBe(true);
    expect(CMD_RECORD_NAME_RE.test("")).toBe(false);
    expect(CMD_RECORD_NAME_RE.test("with space")).toBe(false);
    expect(CMD_RECORD_NAME_RE.test("/slash")).toBe(false);
  });

  it("budgets mirror the capture engine numbers", () => {
    expect(CMD_RECORD_ARGS_MAX_CHARS).toBe(512);
    expect(CMD_RECORD_ERROR_MAX_CHARS).toBe(512);
    expect(CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES).toBe(8 * 1024);
    expect(CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES).toBe(32 * 1024);
    expect(CMD_RECORD_OUTPUT_MAX_ENTRIES).toBe(64);
    expect(CMD_RECORD_OUTPUT_MAX_TITLE_CHARS).toBe(200);
    expect(CMD_RECORD_OUTPUT_MAX_KEY_CHARS).toBe(64);
    expect(CMD_HISTORY_RUNNING_MAX).toBe(16);
  });
});

describe("sanitizeCmdRecord — valid records", () => {
  it("minimal start record round-trips exactly", () => {
    const data = startRecord();
    expect(sanitizeCmdRecord(data)).toEqual(data);
  });

  it("full end record round-trips exactly (endedAt/state/output/notice/error)", () => {
    const data = endRecord({ notice: "no-output", error: "boom" });
    expect(sanitizeCmdRecord(data)).toEqual(data);
  });

  it("drops unknown top-level fields (reader tolerates, never forwards)", () => {
    const wire = sanitizeCmdRecord(startRecord({ injected: "x", nested: { a: 1 } }));
    expect(wire).toEqual(startRecord());
    expect(Object.keys(wire!)).not.toContain("injected");
  });

  it("is deterministic (same input → deep-equal output)", () => {
    expect(sanitizeCmdRecord(endRecord())).toEqual(sanitizeCmdRecord(endRecord()));
  });
});

describe("sanitizeCmdRecord — structural violations ⇒ undefined (pure tombstone)", () => {
  const invalid: Array<[string, unknown]> = [
    ["null", null],
    ["array", [startRecord()]],
    ["non-object", "record"],
    ["v:2", startRecord({ v: 2 })],
    ["v missing", without(startRecord(), "v")],
    ["cmdId too short", startRecord({ cmdId: "c123" })],
    ["cmdId bad chars", startRecord({ cmdId: "bad id with spaces!!" })],
    ["cmdId non-string", startRecord({ cmdId: 42 })],
    ["name empty", startRecord({ name: "" })],
    ["name bad chars", startRecord({ name: "/webhub" })],
    ["name too long", startRecord({ name: "n".repeat(65) })],
    ["phase unknown", startRecord({ phase: "middle" })],
    ["source unknown", startRecord({ source: "gui" })],
    ["args 513 chars", startRecord({ args: "a".repeat(513) })],
    ["args non-string", startRecord({ args: 1 })],
    ["startedAt missing", without(startRecord(), "startedAt")],
    ["startedAt NaN", startRecord({ startedAt: Number.NaN })],
    ["startedAt Infinity", startRecord({ startedAt: Number.POSITIVE_INFINITY })],
    ["startedAt negative", startRecord({ startedAt: -1 })],
    ["endedAt negative", endRecord({ endedAt: -1 })],
    ["endedAt non-number", endRecord({ endedAt: "soon" })],
    ["state unknown", endRecord({ state: "cancelled" })],
    ["notice unknown", endRecord({ notice: "oops" })],
    ["error 513 chars", endRecord({ error: "e".repeat(513) })],
    ["output non-object", endRecord({ output: "see terminal" })],
    ["output.entries missing", endRecord({ output: {} })],
    ["output.entries non-array", endRecord({ output: { entries: "x" } })],
    [
      "output.truncated negative",
      endRecord({ output: { entries: [], truncated: { droppedEntries: -1, droppedBytes: 0 } } }),
    ],
    ["output.truncated half-shaped", endRecord({ output: { entries: [], truncated: { droppedEntries: 1 } } })],
  ];
  for (const [label, data] of invalid) {
    it(label, () => {
      expect(sanitizeCmdRecord(data)).toBeUndefined();
    });
  }
});

describe("sanitizeCmdRecord — output budgets re-applied (§4.5)", () => {
  it("keeps the front 64 of 65 entries and tallies the drop", () => {
    const entries = Array.from({ length: 65 }, (_, i) => out(`line ${i}`));
    const wire = sanitizeCmdRecord(endRecord({ output: { entries } }));
    const output = wire!.output!;
    expect(output.entries).toHaveLength(CMD_RECORD_OUTPUT_MAX_ENTRIES);
    expect(output.entries[0]!.text).toBe("line 0");
    expect(output.entries[63]!.text).toBe("line 63");
    expect(output.truncated).toEqual({ droppedEntries: 1, droppedBytes: Buffer.byteLength("line 64", "utf8") });
  });

  it("clips a 9 KiB single text to 8 KiB + '…' with clipped:true, never splitting a code point", () => {
    const text = "x".repeat(CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES + 768);
    const wire = sanitizeCmdRecord(endRecord({ output: { entries: [out(text)] } }));
    const e = wire!.output!.entries[0]!;
    expect(e.clipped).toBe(true);
    expect(e.text.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(e.text, "utf8")).toBeLessThanOrEqual(CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES);
    expect(e.text).not.toContain("\uFFFD");
  });

  it("clips multi-byte text on a code-point boundary", () => {
    const text = "汉".repeat(3_000); // 3 bytes each ⇒ 9000 bytes
    const wire = sanitizeCmdRecord(endRecord({ output: { entries: [out(text)] } }));
    const e = wire!.output!.entries[0]!;
    expect(e.clipped).toBe(true);
    expect(Buffer.byteLength(e.text, "utf8")).toBeLessThanOrEqual(CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES);
    expect(e.text).not.toContain("\uFFFD");
  });

  it("enforces the 32 KiB window: 6×7 KiB entries keep the front 4, drop 2, tally bytes", () => {
    const sevenKib = "y".repeat(7 * 1024);
    const entries = Array.from({ length: 6 }, () => out(sevenKib));
    const wire = sanitizeCmdRecord(endRecord({ output: { entries } }));
    const output = wire!.output!;
    expect(output.entries).toHaveLength(4);
    const total = output.entries.reduce((n, e) => n + Buffer.byteLength(e.text, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES);
    expect(output.truncated).toEqual({ droppedEntries: 2, droppedBytes: 2 * 7 * 1024 });
  });

  it("drops unknown kinds / bad levels / non-string texts and counts them", () => {
    const entries = [
      out("ok"),
      out("ghost", { kind: "ghost" }),
      out("bad-level", { level: "fatal" }),
      { text: "no-kind" },
      { kind: "text", text: 42 },
    ];
    const wire = sanitizeCmdRecord(endRecord({ output: { entries } }));
    const output = wire!.output!;
    expect(output.entries).toHaveLength(1);
    expect(output.entries[0]!.text).toBe("ok");
    expect(output.truncated!.droppedEntries).toBe(4);
  });

  it("merges pre-existing truncated counters (累加 — they only ever accumulate)", () => {
    const entries = Array.from({ length: 65 }, (_, i) => out(`l${i}`));
    const wire = sanitizeCmdRecord(
      endRecord({ output: { entries, truncated: { droppedEntries: 2, droppedBytes: 100 } } }),
    );
    expect(wire!.output!.truncated).toEqual({
      droppedEntries: 3,
      droppedBytes: 100 + Buffer.byteLength("l64", "utf8"),
    });
  });

  it("slices key/title to 64/200; non-string key/title are dropped, not fatal; clipped survives under budget", () => {
    const wire = sanitizeCmdRecord(
      endRecord({
        output: {
          entries: [
            out("short", { key: "k".repeat(80), title: "t".repeat(300), clipped: true }),
            out("plain", { key: 42, title: null }),
          ],
        },
      }),
    );
    const [first, second] = wire!.output!.entries;
    expect(first!.key).toBe("k".repeat(CMD_RECORD_OUTPUT_MAX_KEY_CHARS));
    expect(first!.title).toBe("t".repeat(CMD_RECORD_OUTPUT_MAX_TITLE_CHARS));
    expect(first!.clipped).toBe(true); // preserved even though the text fits
    expect(second!.key).toBeUndefined();
    expect(second!.title).toBeUndefined();
  });

  it("preserves needsTerminal only when === true; an empty entries array survives", () => {
    const on = sanitizeCmdRecord(endRecord({ output: { entries: [], needsTerminal: true } }));
    expect(on!.output).toEqual({ entries: [], needsTerminal: true });
    const off = sanitizeCmdRecord(endRecord({ output: { entries: [], needsTerminal: false } }));
    expect(off!.output).toEqual({ entries: [] });
  });
});

describe("sanitizeCmdRecord — content is never modified (Q1 原文落盘)", () => {
  it("keeps credentials-bearing text verbatim (?token= / --take= samples, §5.3)", () => {
    const text = "viewer: http://192.168.1.4:1234/record?token=deadbeef / alias --take=tok123";
    const wire = sanitizeCmdRecord(endRecord({ output: { entries: [out(text)] } }));
    expect(wire!.output!.entries[0]!.text).toBe(text);
  });

  it("does NOT re-sanitize ANSI escapes on the read side (write side owns sanitization)", () => {
    const text = "\u001b[31mred\u001b[0m";
    const wire = sanitizeCmdRecord(endRecord({ output: { entries: [out(text)] } }));
    expect(wire!.output!.entries[0]!.text).toBe(text);
  });

  it("keeps args / error verbatim (no redaction, no trimming)", () => {
    const wire = sanitizeCmdRecord(
      endRecord({ args: "/fabric alias name --take=tok123", error: "E_VERIFY: bad token" }),
    );
    expect(wire!.args).toBe("/fabric alias name --take=tok123");
    expect(wire!.error).toBe("E_VERIFY: bad token");
  });
});
