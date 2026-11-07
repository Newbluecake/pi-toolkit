/** alias-force-default plan §5.2 (AF0): `deriveAliasFromDirName` + `isAliasCodePoint` (pure, protocol/). */
import { describe, expect, it } from "vitest";
import {
  XS_ALIAS_MAX_BYTES,
  XS_ALIAS_MAX_GRAPHEMES,
  aliasGraphemeCount,
  deriveAliasFromDirName,
  isAliasCodePoint,
  normalizeAlias,
} from "../../../src/web-hub/protocol/xs-alias.js";

const ok = (input: string): string | undefined => {
  const r = deriveAliasFromDirName(input);
  return r.ok ? r.alias : undefined;
};
const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("deriveAliasFromDirName", () => {
  it("a name normalizeAlias already accepts is adopted as-is (lower-cased)", () => {
    expect(ok("web")).toBe("web");
    expect(ok("My-App")).toBe("my-app");
    expect(ok("前端")).toBe("前端");
    expect(ok("web-前端")).toBe("web-前端");
    expect(ok("Ｆｏｏ")).toBe("foo"); // full-width via NFKC
  });

  it("sanitizes: non-whitelisted code points → '-', runs merged, head [-_ー] and tail [-_] trimmed", () => {
    expect(ok("my.toolkit")).toBe("my-toolkit");
    expect(ok("My Project")).toBe("my-project");
    expect(ok(".dotfiles")).toBe("dotfiles");
    expect(ok("🚀app")).toBe("app");
    expect(ok("项目 v2")).toBe("项目-v2");
    expect(ok("a  ..  b")).toBe("a-b");
    expect(ok("_foo")).toBe("foo");
    expect(ok("foo_.")).toBe("foo");
    expect(ok("foo__")).toBe("foo__"); // already legal ⇒ adopted verbatim, no trimming (§5.2-2)
    expect(ok("ーfoo")).toBe("foo");
    expect(ok("@foo")).toBe("foo"); // '@' is not a name character here (stripAt:false) — sanitised away
  });

  it("the result always round-trips through normalizeAlias unchanged", () => {
    for (const n of ["web", "My Project", ".dotfiles", "🚀app", "项目 v2", "x".repeat(40), "汉".repeat(30)]) {
      const r = deriveAliasFromDirName(n);
      expect(r.ok, n).toBe(true);
      if (r.ok) expect(normalizeAlias(r.alias, { stripAt: false })).toEqual(r);
    }
  });

  it("too long: truncated on a grapheme boundary to ≤16 clusters and ≤48 bytes", () => {
    expect(ok("x".repeat(20))).toBe("x".repeat(16)); // ASCII: 16-cluster limit
    expect(ok("汉".repeat(20))).toBe("汉".repeat(16)); // CJK: 16 × 3 B = 48 B, exactly both limits
    const ext = ok("\u{20000}".repeat(20)); // Han extension B: 4 B each ⇒ the 48-byte limit bites first
    expect(ext).toBe("\u{20000}".repeat(12));
    expect(bytes(ext!)).toBe(48);
    expect(aliasGraphemeCount(ext!)).toBeLessThanOrEqual(XS_ALIAS_MAX_GRAPHEMES);
    expect(ok("a-b-c-d-e-f-g-h-i-j")).toBe("a-b-c-d-e-f-g-h"); // trailing '-' of the cut is trimmed
    expect(ok("x".repeat(600))).toBe("x".repeat(16)); // absurd input stays bounded
    for (const n of ["x".repeat(20), "汉".repeat(20), "\u{20000}".repeat(20)]) {
      const a = ok(n)!;
      expect(aliasGraphemeCount(a)).toBeLessThanOrEqual(XS_ALIAS_MAX_GRAPHEMES);
      expect(bytes(a)).toBeLessThanOrEqual(XS_ALIAS_MAX_BYTES);
    }
  });

  it("id_like ⇒ skipped (never repaired)", () => {
    expect(deriveAliasFromDirName("deadbeef")).toEqual({ ok: false, reason: "invalid" });
    expect(deriveAliasFromDirName("0123-4567-89ab")).toEqual({ ok: false, reason: "invalid" });
    // truncation can land on an id-like prefix: still skipped
    expect(deriveAliasFromDirName("abcdef0123456789xyz-long")).toEqual({ ok: false, reason: "invalid" });
  });

  it("reserved word / reserved prefix ⇒ skipped; the prefix is NOT stripped (D4)", () => {
    for (const n of [
      "pi-toolkit",
      "pi.toolkit",
      "pi toolkit",
      "PI-Toolkit",
      "root",
      "all",
      "r_abc",
      "wf_run",
      "系统",
    ]) {
      expect(deriveAliasFromDirName(n), n).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("nothing usable ⇒ skipped", () => {
    for (const n of ["", "---", "___", "...", "🚀", "123", "-", " "]) {
      expect(deriveAliasFromDirName(n), JSON.stringify(n)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(deriveAliasFromDirName(undefined)).toEqual({ ok: false, reason: "invalid" });
    expect(deriveAliasFromDirName(42)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("isAliasCodePoint", () => {
  it("accepts the whitelist: ASCII alnum/_/-, Han, kana, ー, precomposed Hangul", () => {
    for (const ch of ["a", "Z", "0", "_", "-", "前", "〇", "あ", "カ", "ー", "한", "\u{20000}"]) {
      expect(isAliasCodePoint(ch), ch).toBe(true);
    }
  });
  it("rejects punctuation, whitespace, controls, marks, Jamo, VS, emoji, '@', multi-code-point input", () => {
    for (const ch of [
      ".",
      " ",
      "@",
      "\n",
      "\u0301",
      "\u1100",
      "\u3164",
      "\uFE0F",
      "\u200B",
      "🚀",
      "é",
      "ab",
      "",
      "\uD800",
      "口".repeat(2),
    ]) {
      expect(isAliasCodePoint(ch), JSON.stringify(ch)).toBe(false);
    }
    expect(isAliasCodePoint(undefined as unknown as string)).toBe(false);
  });
  it("agrees with normalizeAlias' character screening over a scan of the BMP and a slice of the astral planes", () => {
    const probe = (cp: number): void => {
      const ch = String.fromCodePoint(cp);
      // "x" + ch + "x" keeps the letter/first-char/length rules out of the way; only the character screen can reject.
      const r = normalizeAlias(`x${ch}x`, { stripAt: false });
      expect(isAliasCodePoint(ch), `U+${cp.toString(16)}`).toBe(r.ok || r.reason !== "invalid");
    };
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      // NFKC may rewrite a compatibility char into something else; normalizeAlias screens the NFKC form, the helper the raw
      // code point — the plan only requires them to coincide on NFKC-stable code points.
      if (String.fromCodePoint(cp).normalize("NFKC") !== String.fromCodePoint(cp)) continue;
      probe(cp);
    }
    for (const base of [0x10000, 0x1f300, 0x20000, 0x2a700, 0xe0100]) {
      for (let cp = base; cp < base + 512; cp++) {
        if (String.fromCodePoint(cp).normalize("NFKC") !== String.fromCodePoint(cp)) continue;
        probe(cp);
      }
    }
  });
});
