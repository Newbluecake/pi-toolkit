/**
 * #66 phase gate (`hub/hardening.ts`, docs/dev/web-hub-auth-hardening/plan.md §4.0/§9 P1).
 */
import { describe, expect, it } from "vitest";
import {
  HARDENING_PHASE,
  nextReaderMarker,
  parseReaderMarker,
  READER_MARKER_KEY,
  READER_MARKER_VERSION,
  WRITER_SOAK_MS,
  writerActive,
} from "../../../src/web-hub/hub/hardening.js";

const NOW = 2_000_000_000_000;

describe("writerActive truth table", () => {
  it("is the first-release phase, with a 14 day soak and a v1 marker", () => {
    expect(HARDENING_PHASE).toBe(1);
    expect(WRITER_SOAK_MS).toBe(14 * 86_400_000);
    expect(READER_MARKER_VERSION).toBe(1);
    expect(READER_MARKER_KEY).toBe("hardening_reader");
  });

  it("phase 1 is never active, whatever the marker says", () => {
    expect(writerActive(1, undefined, NOW)).toBe(false);
    expect(writerActive(1, { v: 1, since: 0 }, NOW)).toBe(false);
    expect(writerActive(1, { v: 9, since: NOW - 10 * WRITER_SOAK_MS }, NOW)).toBe(false);
  });

  it("phase 2: no marker, a young marker, or a future `since` are all inactive", () => {
    expect(writerActive(2, undefined, NOW)).toBe(false);
    expect(writerActive(2, { v: 1, since: NOW }, NOW)).toBe(false);
    expect(writerActive(2, { v: 1, since: NOW - WRITER_SOAK_MS + 1 }, NOW)).toBe(false);
    expect(writerActive(2, { v: 1, since: NOW + 1 }, NOW)).toBe(false);
    expect(writerActive(2, { v: 1, since: NOW + 10 * WRITER_SOAK_MS }, NOW)).toBe(false);
  });

  it("phase 2: a marker older than the version we need is inactive", () => {
    expect(writerActive(2, { v: 0, since: 0 }, NOW)).toBe(false);
  });

  it("phase 2: active exactly once the marker has existed for the full soak", () => {
    expect(writerActive(2, { v: 1, since: NOW - WRITER_SOAK_MS }, NOW)).toBe(true);
    expect(writerActive(2, { v: 1, since: NOW - WRITER_SOAK_MS - 1 }, NOW)).toBe(true);
    expect(writerActive(2, { v: 2, since: 0 }, NOW)).toBe(true);
  });

  it("non-finite inputs never activate the writer", () => {
    expect(writerActive(2, { v: 1, since: Number.NaN }, NOW)).toBe(false);
    expect(writerActive(2, { v: 1, since: 0 }, Number.NaN)).toBe(false);
  });
});

describe("reader marker", () => {
  it("parseReaderMarker accepts only a well-formed {v,since}", () => {
    expect(parseReaderMarker('{"v":1,"since":123}')).toEqual({ v: 1, since: 123 });
    for (const bad of [
      undefined,
      null,
      5,
      "",
      "nope",
      "[]",
      "null",
      '{"v":1}',
      '{"v":"1","since":1}',
      '{"v":1,"since":-1}',
    ]) {
      expect(parseReaderMarker(bad)).toBeUndefined();
    }
  });

  it("nextReaderMarker: stamps a missing marker, only raises an older v, never moves `since`", () => {
    expect(nextReaderMarker(undefined, NOW)).toEqual({ v: 1, since: NOW });
    expect(nextReaderMarker({ v: 0, since: 5 }, NOW)).toEqual({ v: 1, since: 5 });
    expect(nextReaderMarker({ v: 1, since: 5 }, NOW)).toEqual({ v: 1, since: 5 });
    expect(nextReaderMarker({ v: 3, since: 5 }, NOW)).toEqual({ v: 3, since: 5 });
  });
});
