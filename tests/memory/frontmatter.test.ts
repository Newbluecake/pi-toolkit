import { describe, expect, it } from "vitest";
import {
  frontmatterSource,
  isPinned,
  parseFrontmatter,
  stripFrontmatter,
  upsertFrontmatterFields,
} from "../../src/memory/frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns undefined without a frontmatter block", () => {
    expect(parseFrontmatter("hello\nworld")).toBeUndefined();
    expect(parseFrontmatter("")).toBeUndefined();
    expect(parseFrontmatter("--\npin: true\n---\n")).toBeUndefined();
  });

  it("parses simple key/value pairs", () => {
    const fm = parseFrontmatter("---\nsource: agent\nupdated: 2026-01-01\n---\nbody");
    expect(fm).toBeDefined();
    expect(fm?.fields.get("source")).toBe("agent");
    expect(fm?.fields.get("updated")).toBe("2026-01-01");
  });

  it("recognizes pin variants: 'pin: true' and 'pin:true' count, 'pin: yes' does not", () => {
    expect(parseFrontmatter("---\npin: true\n---\nx")?.fields.get("pin")).toBe("true");
    expect(parseFrontmatter("---\npin:true\n---\nx")?.fields.get("pin")).toBe("true");
    expect(parseFrontmatter("---\npin: yes\n---\nx")?.fields.get("pin")).toBe("yes");
  });

  it("parses source: agent", () => {
    expect(parseFrontmatter("---\nsource: agent\n---\nx")?.fields.get("source")).toBe("agent");
  });

  it("ignores a frontmatter-looking block that is not at the head", () => {
    expect(parseFrontmatter("intro\n---\npin: true\n---\nbody")).toBeUndefined();
    expect(parseFrontmatter("\n---\npin: true\n---\nbody")).toBeUndefined();
  });

  it("returns undefined for an unterminated block", () => {
    expect(parseFrontmatter("---\npin: true\nbody without fence")).toBeUndefined();
    expect(parseFrontmatter("---\npin: true")).toBeUndefined();
  });

  it("tolerates non-kv lines inside the block", () => {
    const fm = parseFrontmatter("---\n# comment-ish\nnot a pair\npin: true\n---\nx");
    expect(fm?.fields.get("pin")).toBe("true");
    expect(fm?.fields.size).toBe(1);
  });
});

describe("stripFrontmatter", () => {
  it("strips the block and leading blank lines", () => {
    expect(stripFrontmatter("---\npin: true\n---\n\nbody\n")).toBe("body\n");
    expect(stripFrontmatter("---\npin: true\n---\nbody")).toBe("body");
  });

  it("returns content unchanged without a block", () => {
    expect(stripFrontmatter("plain\nbody")).toBe("plain\nbody");
  });
});

describe("isPinned / frontmatterSource", () => {
  it("isPinned only for head-block pin: true", () => {
    expect(isPinned("---\npin: true\n---\nx")).toBe(true);
    expect(isPinned("---\npin: yes\n---\nx")).toBe(false);
    expect(isPinned("no fm\n---\npin: true\n---\n")).toBe(false);
    expect(isPinned("plain")).toBe(false);
  });

  it("frontmatterSource returns the source value or undefined", () => {
    expect(frontmatterSource("---\nsource: agent\n---\nx")).toBe("agent");
    expect(frontmatterSource("---\nsource: user\n---\nx")).toBe("user");
    expect(frontmatterSource("---\npin: true\n---\nx")).toBeUndefined();
    expect(frontmatterSource("plain")).toBeUndefined();
  });
});

describe("upsertFrontmatterFields", () => {
  it("creates a new block when none exists", () => {
    const out = upsertFrontmatterFields("body text", { source: "agent", updated: "2026-01-01T00:00:00.000Z" });
    expect(out).toBe("---\nsource: agent\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nbody text");
  });

  it("updates existing keys in place and appends missing keys", () => {
    const input = "---\nsource: agent\nupdated: 2000-01-01\n---\n\nbody";
    const out = upsertFrontmatterFields(input, { source: "agent", updated: "2026-02-02", extra: "1" });
    expect(out).toBe("---\nsource: agent\nupdated: 2026-02-02\nextra: 1\n---\n\nbody");
  });

  it("preserves unrelated keys (pin: true survives a provenance upsert)", () => {
    const input = "---\npin: true\nsource: agent\n---\n\nbody";
    const out = upsertFrontmatterFields(input, { source: "agent", updated: "2026-02-02" });
    expect(out).toBe("---\npin: true\nsource: agent\nupdated: 2026-02-02\n---\n\nbody");
    expect(isPinned(out)).toBe(true);
  });

  it("is idempotent for identical values", () => {
    const once = upsertFrontmatterFields("body", { source: "agent", updated: "T" });
    const twice = upsertFrontmatterFields(once, { source: "agent", updated: "T" });
    expect(twice).toBe(once);
  });

  it("keeps the body byte-for-byte after the closing fence", () => {
    const input = "---\na: 1\n---\nline1\n\nline2\n";
    const out = upsertFrontmatterFields(input, { b: "2" });
    expect(out).toBe("---\na: 1\nb: 2\n---\nline1\n\nline2\n");
  });
});
