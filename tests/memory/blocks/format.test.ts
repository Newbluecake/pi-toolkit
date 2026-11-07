import { describe, expect, it } from "vitest";
import {
  bodyBytes,
  isExpired,
  isResident,
  parseBlockFile,
  serializeBlock,
  type BlockMeta,
} from "../../../src/memory/blocks/format.js";
const base: BlockMeta = {
  kind: "block",
  authority: "user",
  status: "active",
  created: "2026-11-06T00:00:00.000Z",
  updated: "2026-11-06T00:00:00.000Z",
  version: 3,
};
describe("block format", () => {
  it("round trips every field in fixed order", () => {
    const meta: BlockMeta = {
      ...base,
      scope: "global",
      audience: "main",
      expires: "2026-12-01",
      until: 'a "quoted" event',
      section: "section",
      heading: "A › B",
      residue: true,
      origin: { file: "core.md", lines: [12, 18] },
      tags: { add: ["release"], remove: ["docs"] },
      private: true,
      title: "title",
      when: "when",
    };
    const raw = serializeBlock(meta, "中文正文");
    const parsed = parseBlockFile("quota.007.md", raw);
    expect(parsed).toMatchObject({ meta, body: "中文正文", errors: [], id: "quota.007", seq: 7 });
    expect(raw.indexOf("heading:")).toBeLessThan(raw.indexOf("residue:"));
    expect(raw).toContain("origin: core.md#L12-L18");
    expect(serializeBlock({ ...base, supersededBy: "quota.008", status: "superseded" }, "x")).toContain(
      "supersededBy: quota.008",
    );
  });
  it("accepts BOM and CRLF while rev hashes original bytes", () => {
    const raw = serializeBlock(base, "line\nnext");
    const a = parseBlockFile("x.001.md", raw),
      b = parseBlockFile("x.001.md", "\uFEFF" + raw.replace(/\n/g, "\r\n"));
    expect(a).toMatchObject({ body: "line\nnext" });
    expect(b).toMatchObject({ body: "line\nnext" });
    if (!("stray" in a) && !("stray" in b)) expect(a.rev).not.toBe(b.rev);
  });
  it("counts UTF-8 body bytes, excludes frontmatter and trailing whitespace", () => {
    expect(bodyBytes("中".repeat(341) + "a \n")).toBe(1024);
    expect(serializeBlock(base, "中".repeat(341) + "a")).toContain("kind: block");
    expect(() => serializeBlock(base, "中".repeat(341) + "ab")).toThrow("E_TOO_LARGE");
    expect(bodyBytes(serializeBlock(base, "abc"))).toBe(3);
  });
  it("migration preserves oversized body and section, while default writes stay strict", () => {
    const body = "中".repeat(341) + "ab";
    const section = "中".repeat(34) + "a";
    expect(bodyBytes(body)).toBe(1025);
    expect(Buffer.byteLength(section)).toBe(103);
    expect(() => serializeBlock(base, body)).toThrow("E_TOO_LARGE");
    expect(() => serializeBlock({ ...base, section }, "short")).toThrow("E_SECTION_TOO_LARGE");
    const raw = serializeBlock({ ...base, section }, body, { allowOversize: true });
    const parsed = parseBlockFile("x.001.md", raw);
    expect(parsed).toMatchObject({ body, meta: { section }, errors: ["E_SECTION_TOO_LARGE", "E_TOO_LARGE"] });
    if ("stray" in parsed) throw new Error("unexpected stray");
    expect(serializeBlock(parsed.meta, parsed.body, { allowOversize: true })).toBe(raw);
    expect(() => serializeBlock(parsed.meta, parsed.body)).toThrow("E_TOO_LARGE");
    // The migration exemption must not suppress other metadata/frontmatter errors.
    expect(() => serializeBlock({ ...base, section: "bad\nline" }, body, { allowOversize: true })).toThrow("E_META");
    expect(() => serializeBlock({ ...base, heading: "中".repeat(41) }, body, { allowOversize: true })).toThrow(
      "E_META",
    );
    expect(() => serializeBlock({ ...base, section: "x".repeat(2048) }, body, { allowOversize: true })).toThrow(
      "frontmatter exceeds limit",
    );
    expect(() => serializeBlock(base, "x <!-- mem user -->", { allowOversize: true })).toThrow("E_META");
  });
  it("drops unknown fields with errors; malformed/absent kind is stray", () => {
    const parsed = parseBlockFile(
      "x.001.md",
      serializeBlock(base, "x").replace("kind: block", "kind: block\nunknown: yes"),
    );
    expect(parsed).toMatchObject({ errors: ["unknown field: unknown"] });
    if (!("stray" in parsed)) expect(parsed.meta).not.toHaveProperty("unknown");
    expect(parseBlockFile("bad.md", serializeBlock(base, "x"))).toEqual({ stray: true, name: "bad.md" });
    expect(parseBlockFile("x.001.md", "no metadata")).toHaveProperty("stray", true);
  });
  it("invalid fields never throw in tolerant reads", () => {
    const raw = serializeBlock(base, "x").replace("version: 3", "version: -2\nexpires: 2026-99-99\nscope: wrong");
    expect(parseBlockFile("x.001.md", raw)).toMatchObject({
      errors: expect.arrayContaining(["invalid expires", "invalid version", "invalid scope"]),
    });
    expect(() => serializeBlock({ ...base, heading: "中".repeat(41) }, "x")).toThrow("E_META");
    expect(() => serializeBlock(base, "x <!-- mem user -->")).toThrow("E_META");
  });
  it("expiry is strict before today; residence requires user/global/active", () => {
    expect(isExpired({ ...base, expires: "2026-11-06" }, "2026-11-06")).toBe(false);
    expect(isExpired({ ...base, expires: "2026-11-05" }, "2026-11-06")).toBe(true);
    for (const authority of ["user", "agent"] as const)
      for (const scope of ["global", "topic", undefined] as const)
        for (const status of ["active", "archived", "superseded"] as const) {
          expect(isResident({ ...base, authority, status, ...(scope ? { scope } : {}) })).toBe(
            authority === "user" && scope === "global" && status === "active",
          );
        }
    expect(
      parseBlockFile("x.001.md", serializeBlock({ ...base, authority: "agent", scope: "global" }, "x")),
    ).toMatchObject({ meta: { authority: "agent" } });
  });
});
