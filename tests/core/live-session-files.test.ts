import { afterEach, describe, expect, it } from "vitest";
import { isLiveSessionFile, markLiveSessionFile, releaseLiveSessionFile } from "../../src/core/live-session-files.js";

/** run-persistence plan D8 / §5 P4: process-wide live child-session-file registry. */
const KEY = Symbol.for("pi-subagent:live-session-files");
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("live-session-files (run-persistence plan D8)", () => {
  it("mark → live; release by the same owner → not live", () => {
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(false);
    markLiveSessionFile("/tmp/a.jsonl", "r1");
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(true);
    expect(isLiveSessionFile("/tmp/b.jsonl")).toBe(false);
    releaseLiveSessionFile("/tmp/a.jsonl", "r1");
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(false);
  });

  it("stays live until every owner released (same file, multiple owners)", () => {
    markLiveSessionFile("/tmp/a.jsonl", "r1");
    markLiveSessionFile("/tmp/a.jsonl", "r2");
    releaseLiveSessionFile("/tmp/a.jsonl", "r1");
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(true);
    releaseLiveSessionFile("/tmp/a.jsonl", "r2");
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(false);
  });

  it("releasing an unknown owner or an unknown file has no side effect", () => {
    markLiveSessionFile("/tmp/a.jsonl", "r1");
    releaseLiveSessionFile("/tmp/a.jsonl", "r_other");
    releaseLiveSessionFile("/tmp/never.jsonl", "r1");
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(true);
    expect(isLiveSessionFile("/tmp/never.jsonl")).toBe(false);
  });

  it("normalizes paths and keeps its state on the shared Symbol.for global", () => {
    markLiveSessionFile("/tmp/x/../a.jsonl", "r1");
    expect(isLiveSessionFile("/tmp/a.jsonl")).toBe(true);
    expect((globalThis as Record<symbol, unknown>)[KEY]).toBeInstanceOf(Map);
  });
});
