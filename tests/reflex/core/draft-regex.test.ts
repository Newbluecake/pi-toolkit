/**
 * jev-reflex · #25 B0 DRX parser (BA §4.5, Blocker 1): the accept set parses; the reject set is
 * REFUSED SYNTACTICALLY — this suite never compiles or executes a rejected source (the ReDoS
 * isolation lives in draft-regex-redos.test.ts, BA §4.5 测试编排 ①).
 */
import { describe, expect, it } from "vitest";
import {
  DRX_MAX_ALTERNATION,
  DRX_MAX_SOURCE_CHARS,
  DRX_MAX_WEAK_LITS,
  drxToSource,
  parseDrx,
  type DrxAst,
} from "../../../src/reflex/core/draft-regex.js";

describe("parseDrx — accept set", () => {
  it("plain literals (CJK, spaces, digits as literals, punctuation)", () => {
    for (const src of ["后台还有几个 job", "bash jobs 状态", "第3个后台任务", "git\\?\\?状态"]) {
      expect(parseDrx(src, "strong"), src).toMatchObject({ ok: true });
    }
    expect(parseDrx("git??状态", "strong")).toMatchObject({ ok: false }); // unescaped ? is a reject
  });

  it("escaped metacharacters are literals", () => {
    const r = parseDrx("后台\\?job \\(列表\\) \\.\\|\\*", "strong");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.ast.role).toBe("strong");
      const seq = (r.ast as Extract<DrxAst, { role: "strong" }>).seqs[0]!;
      expect(seq.units.map((u) => (u.t === "lit" ? u.ch : "D"))).toEqual([
        "后",
        "台",
        "?",
        "j",
        "o",
        "b",
        " ",
        "(",
        "列",
        "表",
        ")",
        " ",
        ".",
        "|",
        "*",
      ]);
    }
  });

  it("\\d{1,4} parses alone and at seq boundaries / between non-digit literals", () => {
    for (const src of ["\\d{1,4}", "第\\d{1,4}个", "\\d{1,4}个任务", "后台第\\d{1,4}个 job(?:吗|呢)?"]) {
      expect(parseDrx(src, "strong"), src).toMatchObject({ ok: true });
    }
  });

  it("the fixed tail (?:吗|呢)? is accepted exactly once, seq-finally", () => {
    const r = parseDrx("工作区干净(?:吗|呢)?|git 状态(?:吗|呢)?", "strong");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      const seqs = (r.ast as Extract<DrxAst, { role: "strong" }>).seqs;
      expect(seqs.every((s) => s.tail === "吗|呢")).toBe(true);
    }
  });

  it(`alternation up to ${DRX_MAX_ALTERNATION} branches (13th rejected in the reject suite)`, () => {
    const twelve = Array.from({ length: DRX_MAX_ALTERNATION }, (_, i) => `分支${i}`).join("|");
    expect(parseDrx(twelve, "strong")).toMatchObject({ ok: true });
  });

  it("weak/exclude accept pure literals only (metachars must be escaped)", () => {
    expect(parseDrx("后台任务", "weak")).toMatchObject({ ok: true });
    expect(parseDrx("未提交", "exclude")).toMatchObject({ ok: true });
    expect(parseDrx("a\\.b \\(括号\\)", "weak")).toMatchObject({ ok: true });
    expect(parseDrx("a.b (括号)", "weak")).toMatchObject({ ok: false }); // unescaped metachars
  });
});

describe("parseDrx — reject set (Blocker 1 shapes, never executed)", () => {
  const REJECTS: ReadonlyArray<[string, string]> = [
    ["a+".repeat(20) + "b", "adjacent重叠 + 组合爆炸"],
    ["(a|a)+", "nested quantifier group"],
    ["\\d+\\d+", "unbounded quantifiers"],
    ["\\d{1,4}\\d{1,4}", "two DIGITS units in one seq"],
    ["\\d{1,4}2", "digit literal directly after DIGITS"],
    ["2\\d{1,4}", "digit literal directly before DIGITS"],
    ["x?".repeat(9), "optional-quantifier chain"],
    ["[a-z]+", "character class"],
    [".*", "dot-star"],
    ["(?=a)", "lookahead"],
    ["\\1", "backreference"],
    ["\\d{2,3}", "wrong bounded quantifier"],
    ["\\d{1,4}?", "quantified DIGITS"],
    ["\\w+", "shorthand class"],
    ["a|b|", "empty last branch"],
    ["|a", "empty first branch"],
    ["(吗|呢)?", "bare group without the (?:…) shape"],
    ["工作区干净(?:吗|呢)?吗", "tail not seq-final"],
    ["工作区干净(?:吗|呢)?(?:吗|呢)?", "two tails in one seq"],
    ["工作区干净(", "unbalanced paren"],
    ["工作区干净\\", "dangling escape"],
    ["a" + "x".repeat(DRX_MAX_SOURCE_CHARS) + "b", "over length cap"],
    ["", "empty source"],
  ];

  it.each(REJECTS)("rejects %s (%s) for every role", (src) => {
    for (const role of ["strong", "weak", "exclude"] as const)
      expect(parseDrx(src, role), `${role}: ${src.slice(0, 40)}`).toMatchObject({ ok: false });
  });

  it(`rejects the ${DRX_MAX_ALTERNATION + 1}th alternation branch`, () => {
    const thirteen = Array.from({ length: DRX_MAX_ALTERNATION + 1 }, (_, i) => `分支${i}`).join("|");
    expect(parseDrx(thirteen, "strong")).toMatchObject({ ok: false });
  });

  it("rejects non-literals in weak/exclude roles (digits unit, alternation, tail)", () => {
    for (const src of ["第\\d{1,4}个", "吗|呢", "干净(?:吗|呢)?", "a?"]) {
      for (const role of ["weak", "exclude"] as const)
        expect(parseDrx(src, role), `${role}: ${src}`).toMatchObject({ ok: false });
    }
  });

  it(`rejects weak sources beyond ${DRX_MAX_WEAK_LITS} literals`, () => {
    const long = "字".repeat(DRX_MAX_WEAK_LITS + 1);
    expect(parseDrx(long, "weak")).toMatchObject({ ok: false });
    expect(parseDrx("字".repeat(DRX_MAX_WEAK_LITS), "weak")).toMatchObject({ ok: true });
  });
});

describe("drxToSource — canonical emission & round-trip", () => {
  it("emits the canonical spelling (escaped metachars, exact DIGITS/tail literals)", () => {
    const r = parseDrx("后台\\?第\\d{1,4}个 job(?:吗|呢)?|b", "strong");
    if (!r.ok) throw new Error("expected parse");
    expect(drxToSource(r.ast)).toBe("后台\\?第\\d{1,4}个 job(?:吗|呢)?|b");
  });

  it("round-trips: parse(drxToSource(ast)) succeeds with an equal AST, for every role", () => {
    for (const [src, role] of [
      ["后台\\?第\\d{1,4}个 job(?:吗|呢)?|分支二", "strong"],
      ["后台任务 清单", "weak"],
      ["未提交 改动", "exclude"],
    ] as const) {
      const first = parseDrx(src, role);
      if (!first.ok) throw new Error(src);
      const again = parseDrx(drxToSource(first.ast), role);
      expect(again).toMatchObject({ ok: true });
      if (again.ok) expect(again.ast).toEqual(first.ast);
    }
  });
});
