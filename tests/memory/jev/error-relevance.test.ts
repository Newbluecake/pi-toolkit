import { describe, expect, it } from "vitest";
import { legacyErrorCandidateAllowed, type ErrorRelevanceMeta } from "../../../src/memory/jev/error-relevance.js";

const high = new Set(["deletion"]);

// Expected booleans audited against `git show 4969929f:src/memory/jev/wire.ts`
// recallE's inline filter: !pending && tags.length>0 && every(high) &&
// !some(hit) rejects before pending || pitfall || procedure || some(hit).
// In particular, empty effective tags are NOT rejected by vacuous every().
describe("E baseline extraction parity (r3 §3.4)", () => {
  it.each(["pitfall", "procedure"] as const)("empty effective tags: %s", (type) => {
    expect(legacyErrorCandidateAllowed({ pending: false, tags: [], type }, new Set(), high)).toBe(true);
  });

  it.each([{ tags: [] }, { tags: ["deletion"] }])("pending with effective tags $tags", ({ tags }) => {
    expect(legacyErrorCandidateAllowed({ pending: true, tags, type: undefined }, new Set(), high)).toBe(true);
  });

  it.each(["pitfall", "procedure"] as const)("pure high: %s", (type) => {
    const meta: ErrorRelevanceMeta = { pending: false, tags: ["deletion"], type };
    expect(legacyErrorCandidateAllowed(meta, new Set(), high)).toBe(false);
    expect(legacyErrorCandidateAllowed(meta, new Set(["memory-system"]), high)).toBe(false);
    expect(legacyErrorCandidateAllowed(meta, new Set(["deletion"]), high)).toBe(true);
  });

  it.each(["pitfall", "procedure"] as const)("mixed normal: %s", (type) => {
    const meta: ErrorRelevanceMeta = { pending: false, tags: ["deletion", "memory-system"], type };
    expect(legacyErrorCandidateAllowed(meta, new Set(), high)).toBe(true);
    expect(legacyErrorCandidateAllowed(meta, new Set(["memory-system"]), high)).toBe(true);
  });

  it("does not promote other tagged types without a hit", () => {
    const meta: ErrorRelevanceMeta = { pending: false, tags: ["memory-system"], type: "rule" };
    expect(legacyErrorCandidateAllowed(meta, new Set(), high)).toBe(false);
    expect(legacyErrorCandidateAllowed(meta, new Set(["memory-system"]), high)).toBe(true);
    expect(legacyErrorCandidateAllowed({ ...meta, tags: [] }, new Set(), high)).toBe(false);
  });

  it("preserves guard and return short-circuit order", () => {
    const reads: string[] = [];
    const meta: ErrorRelevanceMeta = {
      get pending() {
        reads.push("pending");
        return false;
      },
      get tags() {
        reads.push("tags");
        return ["deletion"];
      },
      get type() {
        reads.push("type");
        return "pitfall";
      },
    };
    const hit = {
      has: (tag: string) => {
        reads.push(`hit:${tag}`);
        return false;
      },
    } as ReadonlySet<string>;
    const risk = {
      has: (tag: string) => {
        reads.push(`high:${tag}`);
        return true;
      },
    } as ReadonlySet<string>;
    expect(legacyErrorCandidateAllowed(meta, hit, risk)).toBe(false);
    expect(reads).toEqual(["pending", "tags", "tags", "high:deletion", "tags", "hit:deletion"]);
    reads.length = 0;
    expect(legacyErrorCandidateAllowed({ pending: true, tags: [], type: undefined }, hit, risk)).toBe(true);
    expect(reads).toEqual([]);
  });
});
