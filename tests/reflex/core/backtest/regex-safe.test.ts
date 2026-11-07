/**
 * jev-reflex · #25 B2 regex-safe (BA §4.4 step 1): every product is built from DRX ASTs via
 * `drxToSource`, round-trips through `parseDrx`, and matches what it was built from. The reject
 * cases here assert the BUILDER refuses (never emits an out-of-grammar source).
 */
import { describe, expect, it } from "vitest";
import { drxToSource, parseDrx } from "../../../../src/reflex/core/draft-regex.js";
import { branchSource, literalSource } from "../../../../src/reflex/core/backtest/regex-safe.js";

const lit = (text: string): { t: "lit"; text: string } => ({ t: "lit", text });
const digits = (): { t: "digits" } => ({ t: "digits" });

describe("branchSource — accept set", () => {
  it("emits a pure-literal branch that parses and matches", () => {
    const r = branchSource([lit("后台任务状态如何")]);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(parseDrx(r.src, "strong").ok).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("后台任务状态如何")).toBe(true);
  });

  it("emits `<n>` as \\d{1,4} with non-digit literal neighbours", () => {
    const r = branchSource([lit("后台第 "), digits(), lit(" 个 job")]);
    expect(r).toMatchObject({ ok: true, src: "后台第 \\d{1,4} 个 job" });
    if (!r.ok) return;
    expect(parseDrx(r.src, "strong").ok).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("后台第 3 个 job")).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("后台第 1000 个 job")).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("后台第 个 job")).toBe(false);
  });

  it("digits at a branch boundary (no literal neighbour on that side) is accepted", () => {
    expect(branchSource([digits(), lit(" 个 job 在跑")])).toMatchObject({ ok: true, src: "\\d{1,4} 个 job 在跑" });
    expect(branchSource([lit("还有 "), digits()])).toMatchObject({ ok: true, src: "还有 \\d{1,4}" });
    expect(branchSource([digits()])).toMatchObject({ ok: true, src: "\\d{1,4}" });
  });

  it("tail emits the fixed (?:吗|呢)? and keeps the bare form matching", () => {
    const r = branchSource([lit("工作区干净")], { tail: true });
    expect(r).toMatchObject({ ok: true, src: "工作区干净(?:吗|呢)?" });
    if (!r.ok) return;
    expect(parseDrx(r.src, "strong").ok).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("工作区干净")).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("工作区干净吗")).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("工作区干净呢")).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("工作区干净啊")).toBe(false);
  });

  it("metacharacters in literals are escaped and still match the literal text", () => {
    const r = branchSource([lit("v1.2 (stable) 的 job?")]);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(parseDrx(r.src, "strong").ok).toBe(true);
    expect(new RegExp(`^(?:${r.src})$`).test("v1.2 (stable) 的 job?")).toBe(true);
    expect(r.src).toBe("v1\\.2 \\(stable\\) 的 job\\?");
  });

  it("round-trips: parseDrx(drxToSource(ast)) accepts every emitted source", () => {
    const cases: ReadonlyArray<ReturnType<typeof lit>[]> = [[lit("纯中文句子")], [lit("a"), digits(), lit("b")]];
    for (const parts of cases) {
      const r = branchSource(parts);
      if (!r.ok) throw new Error(r.problem);
      const back = parseDrx(r.src, "strong");
      expect(back.ok).toBe(true);
      if (back.ok) expect(drxToSource(back.ast)).toBe(r.src);
    }
  });
});

describe("branchSource — reject set (the builder refuses, nothing is emitted)", () => {
  it("refuses a second digits unit", () => {
    expect(branchSource([lit("从 "), digits(), lit(" 到 "), digits(), lit(" 行")]).ok).toBe(false);
  });
  it("refuses a digit literal adjacent to the digits unit", () => {
    expect(branchSource([lit("第 3"), digits(), lit(" 个")]).ok).toBe(false); // ends with digit
    expect(branchSource([lit("第 "), digits(), lit("3 个")]).ok).toBe(false); // starts with digit
  });
  it("refuses empty shapes", () => {
    expect(branchSource([]).ok).toBe(false);
    expect(branchSource([lit("")]).ok).toBe(false);
    expect(branchSource([lit(""), digits(), lit("")]).ok).toBe(false);
  });
  it("refuses an over-long emission (>160 chars)", () => {
    const long = "很".repeat(161);
    expect(branchSource([lit(long)]).ok).toBe(false);
  });
});

describe("literalSource — weak/exclude pure literals", () => {
  it("emits escaped literals that parse in both roles", () => {
    for (const role of ["weak", "exclude"] as const) {
      const r = literalSource("额度.还剩", role);
      expect(r).toMatchObject({ ok: true, src: "额度\\.还剩" });
      if (!r.ok) return;
      expect(parseDrx(r.src, role).ok).toBe(true);
    }
  });
  it("digits are ordinary literals in weak/exclude (no quantifiers involved)", () => {
    const r = literalSource("第 3 个", "exclude");
    expect(r).toMatchObject({ ok: true, src: "第 3 个" });
  });
  it("refuses empty and over-cap literals (>40 lits / >160 chars)", () => {
    expect(literalSource("", "weak").ok).toBe(false);
    expect(literalSource("词".repeat(41), "exclude").ok).toBe(false);
    expect(literalSource("a".repeat(161), "weak").ok).toBe(false);
    expect(literalSource("词".repeat(40), "exclude")).toMatchObject({ ok: true });
  });
});
