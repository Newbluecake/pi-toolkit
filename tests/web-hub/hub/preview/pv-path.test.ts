/** web-hub-html-preview plan v2 T-H1 — `hub/preview/pv-path.ts` (corpus-driven). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  errCode,
  isPvLogUrl,
  parsePvRelPath,
  parsePvwRest,
  redactLogUrl,
  splitPvRest,
} from "../../../../src/web-hub/hub/preview/pv-path.js";

interface Corpus {
  version: number;
  ok: { raw: string; rel: string }[];
  reject: { raw: string; why: string }[];
}
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/pv-path-corpus.json", import.meta.url)), "utf8"),
) as Corpus;

const CAP = "A".repeat(43);

describe("parsePvRelPath corpus", () => {
  it("corpus is non-trivial", () => {
    expect(corpus.ok.length).toBeGreaterThan(5);
    expect(corpus.reject.length).toBeGreaterThan(25);
  });
  for (const c of corpus.ok) {
    it(`accepts ${JSON.stringify(c.raw.slice(0, 40))}`, () => {
      const r = parsePvRelPath(c.raw);
      expect(r).toMatchObject({ ok: true, rel: c.rel });
      if (r.ok) {
        expect(r.rel.startsWith("/")).toBe(false);
        expect(r.segments.join("/")).toBe(r.rel);
      }
    });
  }
  for (const c of corpus.reject) {
    it(`rejects ${JSON.stringify(c.raw.slice(0, 40))} as ${c.why}`, () => {
      expect(parsePvRelPath(c.raw)).toEqual({ ok: false, reason: c.why });
    });
  }
  it("never throws on non-strings", () => {
    expect(parsePvRelPath(undefined as unknown as string)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("splitPvRest / parsePvwRest", () => {
  it("splits cap and raw rel", () => {
    expect(splitPvRest(`${CAP}/a/b.css`)).toEqual({ cap: CAP, rawRel: "a/b.css" });
    expect(splitPvRest(CAP)).toEqual({ cap: CAP, rawRel: "" });
  });
  it("bad caps ⇒ undefined", () => {
    expect(splitPvRest("short/x")).toBeUndefined();
    expect(splitPvRest(`${CAP}x/y`)).toBeUndefined();
    expect(splitPvRest(`${"!".repeat(43)}/y`)).toBeUndefined();
    expect(splitPvRest("")).toBeUndefined();
  });
  it("wrapper takes exactly one cap", () => {
    expect(parsePvwRest(CAP)).toBe(CAP);
    expect(parsePvwRest(`${CAP}/`)).toBeUndefined();
    expect(parsePvwRest(`${CAP}/x`)).toBeUndefined();
  });
});

describe("redactLogUrl / errCode (§2.6)", () => {
  it("redacts pv and pvw URLs, leaves the rest", () => {
    expect(redactLogUrl(`/pv/${CAP}/secret.html`)).toBe("/pv/[redacted]");
    expect(redactLogUrl(`/pvw/${CAP}`)).toBe("/pvw/[redacted]");
    expect(redactLogUrl(`http://host:1/pv/${CAP}/x`)).toBe("/pv/[redacted]");
    expect(redactLogUrl("/api/preview?path=/x")).toBe("/api/preview?path=/x");
    expect(redactLogUrl("/pvx/a")).toBe("/pvx/a");
    expect(isPvLogUrl(`/pv/${CAP}/a`)).toBe(true);
    expect(isPvLogUrl("/api/x")).toBe(false);
  });
  it("errCode prefers code, then name", () => {
    expect(errCode(Object.assign(new Error("open '/home/u/secret' failed"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errCode(new TypeError("/home/u/secret"))).toBe("TypeError");
    expect(errCode("boom")).toBe("string");
  });
});
