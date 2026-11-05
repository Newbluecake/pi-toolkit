/**
 * R1 · schema (plan R1 step 6): typebox validation of one script + catalog self-check rules
 * (R-I12: builtin-only, unique ids, budget ceiling, regex hygiene).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { regexSourceProblems, validateCatalog, validateScript } from "../../../src/reflex/core/schema.js";
import type { RScriptV1 } from "../../../src/reflex/core/types.js";

const VALID: RScriptV1 = BUILTIN_SCRIPTS[0]!;

function variant(patch: (draft: Record<string, unknown>) => void): unknown {
  const draft = structuredClone(VALID) as Record<string, unknown>;
  patch(draft);
  return draft;
}

describe("validateScript (typebox structural check)", () => {
  it("accepts the shipped jobs.list verbatim", () => {
    expect(validateScript(VALID).id).toBe("jobs.list");
  });

  it.each([
    ["wrong schema literal", (d: Record<string, unknown>) => (d["schema"] = "rscript/2")],
    ["bad id pattern", (d: Record<string, unknown>) => (d["id"] = "Jobs.list")],
    ["bad id separator", (d: Record<string, unknown>) => (d["id"] = "jobslist")],
    ["version not a positive integer", (d: Record<string, unknown>) => (d["version"] = 0)],
    ["risk literal (only readonly exists)", (d: Record<string, unknown>) => (d["risk"] = "write")],
    [
      "fewer than 5 hit examples",
      (d: Record<string, unknown>) =>
        ((d["intent"] as Record<string, unknown>)["examples"] = { hit: ["a", "b"], miss: ["c", "d", "e", "f", "g"] }),
    ],
    ["missing render", (d: Record<string, unknown>) => delete d["render"]],
    ["budgetMs above REFLEX_BUDGET_MS", (d: Record<string, unknown>) => (d["budgetMs"] = 1201)],
    ["budgetMs non-integer", (d: Record<string, unknown>) => (d["budgetMs"] = 100.5)],
  ])("rejects: %s", (_name, patch) => {
    expect(() => validateScript(variant(patch as (d: Record<string, unknown>) => void))).toThrow();
  });
});

describe("validateCatalog (R-I12 self-check)", () => {
  it("rejects origin 'extracted'", () => {
    const extracted = variant((d) => (d["origin"] = "extracted"));
    expect(() => validateCatalog([extracted])).toThrow(/extracted/);
  });

  it("rejects duplicate ids", () => {
    expect(() => validateCatalog([VALID, structuredClone(VALID)])).toThrow(/duplicate/i);
  });

  it("rejects unknown port ids and capabilities", () => {
    const badPort = variant((d) => {
      (d["port"] as Record<string, unknown>)["id"] = "shell.exec";
    });
    expect(() => validateCatalog([badPort])).toThrow(/unknown port/i);
    const badCap = variant((d) => {
      d["requires"] = ["printer"];
    });
    expect(() => validateCatalog([badCap])).toThrow(/unknown capability/i);
  });

  it("an over-budget script never validates (schema ceiling + catalog rule, defense in depth)", () => {
    const over = variant((d) => (d["budgetMs"] = 1201));
    expect(() => validateCatalog([over])).toThrow(); // the typebox ceiling fires first
  });

  it("rejects regex sources: serialized /g literal, nested quantifiers, non-compiling", () => {
    expect(() =>
      validateCatalog([variant((d) => ((d["intent"] as Record<string, unknown>)["weak"] = ["/foo/g"]))]),
    ).toThrow(/serialized/i);
    expect(() =>
      validateCatalog([variant((d) => ((d["intent"] as Record<string, unknown>)["weak"] = ["(a+)+b"]))]),
    ).toThrow(/nested/i);
    expect(() =>
      validateCatalog([variant((d) => ((d["intent"] as Record<string, unknown>)["weak"] = ["(a*)*b"]))]),
    ).toThrow(/nested/i);
    expect(() =>
      validateCatalog([variant((d) => ((d["intent"] as Record<string, unknown>)["weak"] = ["[unclosed"]))]),
    ).toThrow(/compile/i);
  });
});

describe("regexSourceProblems (unit)", () => {
  it("accepts plain and legitimately quantified sources", () => {
    expect(regexSourceProblems("bash jobs?")).toEqual([]);
    expect(regexSourceProblems("(现在)?后台(还)?有几个任务(在跑)?")).toEqual([]);
    expect(regexSourceProblems("\\d+h ?额度(用了|还?剩)多少")).toEqual([]);
    expect(regexSourceProblems("[a-z]+ status")).toEqual([]); // class-internal + is fine
  });

  it("flags serialized literals with any flag letters", () => {
    expect(regexSourceProblems("/x/g")).toContainEqual(expect.stringContaining("serialized"));
    expect(regexSourceProblems("/x/i")).toContainEqual(expect.stringContaining("serialized"));
    expect(regexSourceProblems("/ab+/")).toContainEqual(expect.stringContaining("serialized"));
  });

  it("flags nested quantifier shapes incl. {n,m} tails, ignoring escapes and classes", () => {
    for (const src of ["(a+)+", "(a*)*", "(?:ab+){2,}", "(a{2,})+", "x(\\++)*"]) {
      expect(regexSourceProblems(src), src).toContainEqual(expect.stringContaining("nested"));
    }
    expect(regexSourceProblems("a\\/b")).toEqual([]); // escaped slash is not a literal
    expect(regexSourceProblems("[a+]+z")).toEqual([]); // class-internal quantifier is flat
  });
});

// ---------------------------------------------------------------------------
// #25 B0 (BA §4.5): optional `lineage` on rscript/1 + the catalog's draft-namespace refusal.
// ---------------------------------------------------------------------------
describe("#25 lineage + draft namespace (validateCatalog)", () => {
  const withLineage = (lineage: string | undefined): unknown =>
    lineage === undefined
      ? JSON.parse(JSON.stringify(BUILTIN_SCRIPTS))
      : BUILTIN_SCRIPTS.map((s) => ({ ...s, ...(s.id === "jobs.list" ? { lineage } : {}) }));

  it("accepts a builtin script with a valid lineage; rejects invalid lineage shapes", () => {
    expect(() => validateCatalog(withLineage("draft.jobs"))).not.toThrow();
    expect(() => validateCatalog(withLineage("Draft!"))).toThrow(/validation failed/);
  });

  it("refuses a draft-namespace id in the builtin catalog (R-I12, #25)", () => {
    const withDraft = BUILTIN_SCRIPTS.map((s) => ({ ...s, ...(s.id === "jobs.list" ? { id: "draft.jobs" } : {}) }));
    expect(() => validateCatalog(withDraft)).toThrow(/draft-namespace/);
  });
});
