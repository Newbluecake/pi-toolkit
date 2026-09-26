import { describe, expect, it } from "vitest";
import { canonicalLinkPath, dedupeLinkPaths } from "../../src/extensions/worktree-link-paths.js";

describe("canonicalLinkPath (workflow-worktree plan D9)", () => {
  it("accepts a simple canonical repo-relative path", () => {
    expect(canonicalLinkPath("node_modules")).toEqual({ ok: true, path: "node_modules" });
    expect(canonicalLinkPath("vendor/lib")).toEqual({ ok: true, path: "vendor/lib" });
  });

  it.each([
    ["empty string", ""],
    ["'.'", "."],
    ["'..'", ".."],
    ["parent segment", "a/../b"],
    ["double slash", "a//b"],
    ["trailing slash", "a/"],
    ["absolute path", "/abs"],
    ["leading dash", "-x"],
    ["backslash", "a\\b"],
    ["colon", "a:b"],
    ["asterisk", "a*b"],
    ["question mark", "a?b"],
    ["open bracket", "a[b"],
    ["close bracket", "a]b"],
    ["bang", "a!b"],
    ["control char", "a\tb"],
    ["leading whitespace", " a"],
    ["trailing whitespace", "a "],
    ["non-string", 42],
    ["too long", "a".repeat(256)],
  ])("rejects %s", (_label, value) => {
    expect(canonicalLinkPath(value).ok).toBe(false);
  });
});

describe("dedupeLinkPaths", () => {
  it("passes through valid unique entries", () => {
    expect(dedupeLinkPaths(["node_modules", "vendor"])).toEqual(["node_modules", "vendor"]);
  });

  it("drops duplicates, keeping the first occurrence", () => {
    expect(dedupeLinkPaths(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("caps at 16 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => `dep${i}`);
    expect(dedupeLinkPaths(many)).toHaveLength(16);
  });

  it("reports each invalid entry via onInvalid and drops it", () => {
    const invalid: unknown[] = [];
    const result = dedupeLinkPaths(["ok", "/bad", ".."], (raw) => invalid.push(raw));
    expect(result).toEqual(["ok"]);
    expect(invalid).toEqual(["/bad", ".."]);
  });

  it("non-array input yields [] and warns iff defined", () => {
    const invalid: unknown[] = [];
    expect(dedupeLinkPaths(undefined, (raw) => invalid.push(raw))).toEqual([]);
    expect(invalid).toEqual([]);
    expect(dedupeLinkPaths("nope", (raw) => invalid.push(raw))).toEqual([]);
    expect(invalid).toEqual(["nope"]);
  });
});
