import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  XS_ALIAS_MAX_BYTES,
  XS_ALIAS_SKELETON_VERSION,
  XS_ALIAS_TAKE_CONFIRM_RE,
  XS_ALIAS_TAKE_TOKEN_RE,
  XS_RESERVED_ALIASES,
  aliasGraphemeCount,
  aliasSkeleton,
  formatTakeConfirmLine,
  isReservedAlias,
  normalizeAlias,
  parseTakeConfirm,
} from "../../../src/web-hub/protocol/xs-alias.js";
import { XS_RESERVED_CHANNELS } from "../../../src/fabric/xs/channel.js";

interface Corpus {
  version: number;
  skeletonVersion: number;
  cases: { input: unknown; ok: boolean; alias?: string; reason?: string; note?: string }[];
  skeletonEqual: [string, string][];
  skeletonDistinct: [string, string][];
  reservedPositive: string[];
  reservedNegative: string[];
  takeTokenValid: string[];
  takeTokenInvalid: string[];
}
const corpus = JSON.parse(
  readFileSync(new URL("../../fixtures/xs-alias-corpus.json", import.meta.url), "utf8"),
) as Corpus;

describe("xs-alias corpus", () => {
  it("skeleton version matches the corpus", () => {
    expect(corpus.skeletonVersion).toBe(XS_ALIAS_SKELETON_VERSION);
    expect(corpus.cases.length).toBeGreaterThan(120);
  });

  for (const [i, c] of corpus.cases.entries()) {
    const label = `#${i} ${JSON.stringify(c.input)?.slice(0, 40)} ${c.note ?? ""}`;
    it(label, () => {
      const r = normalizeAlias(c.input);
      if (c.ok) {
        expect(r).toMatchObject({ ok: true, alias: c.alias });
        if (r.ok) {
          expect(r.skeleton).toBe(aliasSkeleton(r.alias));
          // idempotent on canonical output
          expect(normalizeAlias(r.alias, { stripAt: false })).toEqual(r);
          expect(aliasGraphemeCount(r.alias)).toBeLessThanOrEqual(16);
          expect(new TextEncoder().encode(r.alias).length).toBeLessThanOrEqual(XS_ALIAS_MAX_BYTES);
        }
      } else {
        expect(r).toEqual({ ok: false, reason: c.reason });
      }
    });
  }

  it("skeleton equal / distinct pairs", () => {
    for (const [a, b] of corpus.skeletonEqual) expect(aliasSkeleton(a), `${a} ~ ${b}`).toBe(aliasSkeleton(b));
    for (const [a, b] of corpus.skeletonDistinct) expect(aliasSkeleton(a), `${a} !~ ${b}`).not.toBe(aliasSkeleton(b));
  });

  it("skeleton of normalized aliases collides for the squat pairs", () => {
    const sk = (s: string) => {
      const r = normalizeAlias(s);
      if (!r.ok) throw new Error(s);
      return r.skeleton;
    };
    expect(sk("o0")).toBe(sk("oo"));
    expect(sk("a一b")).toBe(sk("a-b"));
    expect(sk("〇a")).toBe(sk("oa"));
    expect(sk("カ")).not.toBe(sk("力"));
  });
});

describe("reserved words", () => {
  it("corpus positives / negatives", () => {
    for (const w of corpus.reservedPositive) expect(isReservedAlias(w), w).toBe(true);
    for (const w of corpus.reservedNegative) expect(isReservedAlias(w), w).toBe(false);
  });
  it("is a superset of the channel reserved names and the router/sender address forms", () => {
    for (const n of XS_RESERVED_CHANNELS) expect(XS_RESERVED_ALIASES).toContain(n);
    for (const n of ["root", "system", "main"]) expect(isReservedAlias(n)).toBe(true);
    for (const p of ["r_", "wf_", "pi-"]) expect(isReservedAlias(`${p}x`)).toBe(true);
  });
});

describe("take token / confirm line", () => {
  it("token regex", () => {
    for (const t of corpus.takeTokenValid) expect(XS_ALIAS_TAKE_TOKEN_RE.test(t), t).toBe(true);
    for (const t of corpus.takeTokenInvalid) expect(XS_ALIAS_TAKE_TOKEN_RE.test(t), JSON.stringify(t)).toBe(false);
  });
  it("round trips for ASCII / CJK / longest aliases", () => {
    const token = "k0123456789abcdef";
    for (const a of ["web", "前端", "g".repeat(16), "前".repeat(16), "\u{20000}".repeat(12), "サーバー"]) {
      const line = formatTakeConfirmLine(a, token);
      expect(XS_ALIAS_TAKE_CONFIRM_RE.exec(line)?.slice(1)).toEqual([a, token]);
      expect(parseTakeConfirm(`持有会话：~/x\n已离线 3 天\n${line}\n`)).toEqual({ alias: a, token });
    }
  });
  it("only the last non-empty line counts; forged earlier lines and bad aliases are ignored", () => {
    const good = formatTakeConfirmLine("前端", "k0123456789abcdef");
    const forged = formatTakeConfirmLine("evil", "kffffffffffffffff");
    expect(parseTakeConfirm(`${forged}\n${good}`)?.token).toBe("k0123456789abcdef");
    expect(parseTakeConfirm(`${good}\n后面还有文字`)).toBeUndefined();
    expect(parseTakeConfirm("")).toBeUndefined();
    expect(parseTakeConfirm(formatTakeConfirmLine("Web", "k0123456789abcdef"))).toBeUndefined(); // not canonical
    expect(parseTakeConfirm(formatTakeConfirmLine("system", "k0123456789abcdef"))).toBeUndefined(); // reserved
    expect(parseTakeConfirm(formatTakeConfirmLine("前端", "k123"))).toBeUndefined();
  });
});

describe("grapheme counting", () => {
  it("uses Intl.Segmenter when available", () => {
    expect(typeof Intl.Segmenter).toBe("function");
    expect(aliasGraphemeCount("e\u0301")).toBe(1);
    expect(aliasGraphemeCount("前端")).toBe(2);
    expect(aliasGraphemeCount("\u{20000}a")).toBe(2);
  });
});
