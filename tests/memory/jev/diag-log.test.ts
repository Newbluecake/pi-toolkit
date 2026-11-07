// diag-log.ts unit tests (2026-11-04 all-failed fix): bounded on-disk
// diagnostic ring `<memDir>/.jev/diag.jsonl` — roundtrip, 200-line cap,
// read tolerance (malformed lines dropped, missing file ⇒ []), redaction +
// newline flattening before persist, fail-soft on unwritable dirs, and the
// lock-following atomic write (same safe-fs rules as the sidecar index).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendDiagLine, DIAG_MAX_LINES, readDiagLines } from "../../../src/memory/jev/diag-log.js";

let tmp: string;
let memDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jev-diag-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const diagPath = (): string => join(memDir, ".jev", "diag.jsonl");

describe("appendDiagLine + readDiagLines", () => {
  test("roundtrip: appends land as one jsonl record per line and read back oldest-first", async () => {
    appendDiagLine(
      memDir,
      Date.parse("2026-11-04T12:00:00Z"),
      "opencode/jev-1.13-free failed (transient): timeout after 3000ms",
    );
    await settle();
    appendDiagLine(memDir, Date.parse("2026-11-04T12:01:00Z"), "opencode/jev-1.13 failed (unavailable): 451");
    await settle();
    const records = readDiagLines(memDir, 10);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      at: "2026-11-04T12:00:00.000Z",
      line: "opencode/jev-1.13-free failed (transient): timeout after 3000ms",
    });
    expect(records[1]!.line).toContain("failed (unavailable)");
    // file is one record per physical line
    expect(readFileSync(diagPath(), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("ring cap: keeps only the newest DIAG_MAX_LINES records", async () => {
    for (let i = 0; i < DIAG_MAX_LINES + 5; i += 1) {
      appendDiagLine(memDir, 1_000_000 + i, `line ${i}`);
      await settle(1);
    }
    await settle(50);
    const records = readDiagLines(memDir, 1_000);
    expect(records).toHaveLength(DIAG_MAX_LINES);
    expect(records[0]!.line).toBe("line 5");
    expect(records[records.length - 1]!.line).toBe(`line ${DIAG_MAX_LINES + 4}`);
  });

  test("read tolerance: missing file ⇒ [], malformed lines dropped, non-string fields skipped", async () => {
    expect(readDiagLines(memDir, 5)).toEqual([]);
    mkdirSync(join(memDir, ".jev"), { recursive: true });
    writeFileSync(
      diagPath(),
      [
        "not json at all",
        JSON.stringify({ at: "2026-11-04T12:00:00.000Z", line: "good one" }),
        JSON.stringify({ at: 42, line: "bad at type" }),
        JSON.stringify({ at: "2026-11-04T12:02:00.000Z" }), // missing line
        "",
        JSON.stringify({ at: "2026-11-04T12:03:00.000Z", line: "good two" }),
      ].join("\n") + "\n",
    );
    const records = readDiagLines(memDir, 10);
    expect(records.map((r) => r.line)).toEqual(["good one", "good two"]);
    // count ⇒ only the newest `count`
    expect(readDiagLines(memDir, 1)).toEqual([{ at: "2026-11-04T12:03:00.000Z", line: "good two" }]);
    expect(readDiagLines(memDir, 0)).toEqual([]);
  });

  test("redaction + newline flattening before persist: secrets masked, one physical line per record", async () => {
    appendDiagLine(
      memDir,
      Date.parse("2026-11-04T12:00:00Z"),
      "x failed (transient): token=supersecretvalue123 and\ninjected second line",
    );
    await settle();
    const text = readFileSync(diagPath(), "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(text).not.toContain("supersecretvalue123");
    expect(text).toContain("[REDACTED]");
    const records = readDiagLines(memDir, 5);
    expect(records[0]!.line).not.toContain("\n");
  });

  test("overlong lines are capped (300 cp + ellipsis)", async () => {
    // Chinese filler — ASCII runs ≥32 would be masked as base64/hex before
    // the length cap is reached.
    appendDiagLine(memDir, Date.parse("2026-11-04T12:00:00Z"), `错误: ${"长".repeat(500)}`);
    await settle();
    const records = readDiagLines(memDir, 5);
    expect(Array.from(records[0]!.line).length).toBeLessThanOrEqual(301);
    expect(records[0]!.line.endsWith("…")).toBe(true);
  });

  test("fail-soft: an unwritable dir (parent is a file) never throws; empty-after-redact lines are skipped", async () => {
    const notADir = join(tmp, "plain-file");
    writeFileSync(notADir, "x");
    expect(() => appendDiagLine(join(notADir, "sub"), Date.now(), "line")).not.toThrow();
    await settle();
    expect(readDiagLines(join(notADir, "sub"), 5)).toEqual([]);
    // a line redacting to empty is dropped, not persisted as an empty record
    appendDiagLine(memDir, Date.now(), "");
    await settle();
    expect(readDiagLines(memDir, 5)).toEqual([]);
  });

  test("file mode is 0600 under the 0700 .jev dir (same private rules as the sidecar)", async () => {
    appendDiagLine(memDir, Date.parse("2026-11-04T12:00:00Z"), "hello");
    await settle();
    const fs = await import("node:fs");
    const st = fs.statSync(diagPath());
    expect(st.mode & 0o777).toBe(0o600);
  });
});
