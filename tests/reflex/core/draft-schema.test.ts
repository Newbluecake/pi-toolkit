/**
 * jev-reflex · #25 B0 draft validation (BA §4.5 rules ①–⑦) + the loader constants the runtime
 * (B4) and the generator (B2) share. `makeDraft` (tests/reflex/helpers/turn.ts) is the VALID base;
 * every rule gets a positive and a negative case.
 */
import { describe, expect, it } from "vitest";
import { SESSION_READ_FLAGS } from "../../../src/session-nav/session-head.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import {
  DIR_SCAN_CAP,
  DRAFT_CAPS,
  DRAFT_FILE_READ_CAP,
  DRAFT_LOAD_BUDGET_MS,
  DRAFT_MAX_FILE_BYTES,
  DRAFT_NAME_RE,
  validateDraft,
  type DraftReject,
} from "../../../src/reflex/core/draft-schema.js";
import { DRAFT_READ_FLAGS } from "../../../src/reflex/drafts/load.js";
import { makeDraft } from "../helpers/turn.js";
import type { RScriptV1 } from "../../../src/reflex/core/types.js";

const BUILTIN_IDS = new Set(BUILTIN_SCRIPTS.map((s) => s.id));

const expectReject = (raw: unknown, code: DraftReject["code"]): void => {
  const r = validateDraft(raw, BUILTIN_IDS);
  expect(r, `${code}: ${JSON.stringify(raw).slice(0, 80)}`).toMatchObject({ code });
};

describe("validateDraft — the valid base passes (rules ①–⑦)", () => {
  it("makeDraft() is accepted and returned as-is", () => {
    const draft = makeDraft({ id: "draft.jobs-n" });
    expect(validateDraft(draft, BUILTIN_IDS)).toEqual(draft);
  });
});

describe("rule ① — structural schema + no unknown keys at any level", () => {
  it("unknown keys are rejected (typebox alone would tolerate them)", () => {
    expectReject({ ...makeDraft({ id: "draft.a" }), extra: 1 }, "schema");
    expectReject(
      { ...makeDraft({ id: "draft.a" }), intent: { ...makeDraft({ id: "draft.a" }).intent, extra: 1 } },
      "schema",
    );
    const withNested = makeDraft({ id: "draft.a" });
    (withNested.intent.examples as unknown as Record<string, unknown>).extra = 1;
    expectReject(withNested, "schema");
    const withRenderExtra = makeDraft({ id: "draft.a" });
    (withRenderExtra.render as unknown as Record<string, unknown>).extra = 1;
    expectReject(withRenderExtra, "schema");
  });

  it("type failures are rejected", () => {
    expectReject({ ...makeDraft({ id: "draft.a" }), version: 0 }, "schema");
    expectReject({ ...makeDraft({ id: "draft.a" }), intent: "x" }, "schema");
    expectReject(null, "schema");
  });
});

describe("rule ② — origin/risk", () => {
  it("origin builtin is refused; risk stays readonly by schema", () => {
    expectReject({ ...makeDraft({ id: "draft.a" }), origin: "builtin" }, "schema");
  });
});

describe("rule ③ — id namespace and lineage shape", () => {
  it("non-draft ids and builtin shadows are refused; pattern failures surface as schema", () => {
    expectReject(makeDraft({ id: "jobs.list" }), "namespace"); // pattern ok, not draft.*
    expectReject(makeDraft({ id: "custom.jobs" }), "namespace");
    expectReject(makeDraft({ id: "draft.A" }), "schema"); // fails the rscript/1 id pattern first
    expectReject(makeDraft({ id: "draft." }), "schema");
    expectReject(makeDraft({ id: "just.a.name" }), "schema"); // two dots fail the id pattern
  });
  it("lineage is optional; bad shapes surface via the schema pattern (belt-and-braces in validateDraft)", () => {
    expect(validateDraft(makeDraft({ id: "draft.a", lineage: "draft.a" }), BUILTIN_IDS)).toMatchObject({
      id: "draft.a",
    });
    expectReject(makeDraft({ id: "draft.a", lineage: "Draft A" }), "schema");
    expectReject(makeDraft({ id: "draft.a", lineage: "x/y" }), "schema");
  });
});

describe("rule ④ — port binding + per-field defaults equality (K3)", () => {
  it("a port without a builtin script is refused", () => {
    expectReject(makeDraft({ id: "draft.a", port: { id: "sessions.recent" } }), "port-mismatch");
  });
  it("requires/agreement/render must equal the port defaults field by field", () => {
    const d = portDraft();
    expectReject({ ...d, requires: [...d.requires, "git"] as RScriptV1["requires"] }, "port-mismatch");
    expectReject({ ...d, agreement: { tools: [], bashShapes: [] } }, "port-mismatch");
    expectReject({ ...d, agreement: { tools: d.agreement.tools, bashShapes: ["git status"] } }, "port-mismatch");
    expectReject({ ...d, render: { ...d.render, emptyText: "自定义" } }, "port-mismatch");
    expectReject({ ...d, render: { ...d.render, maxLines: 99 } }, "port-mismatch");
  });
  it("makeDraft re-binds to another signed port's defaults automatically", () => {
    const git = makeDraft({ id: "draft.g", port: { id: "git.status" } });
    expect(validateDraft(git, BUILTIN_IDS)).toEqual(git);
    expect(git.agreement.bashShapes).toEqual(["git status", "git diff"]);
  });
});

describe("rule ⑤ — no budgetMs; count caps", () => {
  it("budgetMs is refused on drafts", () => {
    expectReject({ ...portDraft(), budgetMs: 800 }, "schema");
  });
  it("strong/weak/exclude/examples caps", () => {
    const thirteen = Array.from({ length: DRAFT_CAPS.strong + 1 }, (_, i) => `第${i}个后台 job`);
    expectReject(portDraft({ intent: { ...portDraft().intent, strong: thirteen } }), "cap");
    expectReject(
      portDraft({ intent: { ...portDraft().intent, weak: Array.from({ length: DRAFT_CAPS.weak + 1 }, () => "词") } }),
      "cap",
    );
    expectReject(
      portDraft({
        intent: { ...portDraft().intent, exclude: Array.from({ length: DRAFT_CAPS.exclude + 1 }, () => "词") },
      }),
      "cap",
    );
    expectReject(
      portDraft({ intent: { ...portDraft().intent, examples: { hit: ["只有一个"], miss: missOf() } } }),
      "schema",
    ); // typebox minItems=5 fires first
    expectReject(portDraft({ intent: { ...portDraft().intent, examples: { hit: hitOf(21), miss: missOf() } } }), "cap");
  });
});

describe("rule ⑥ — every intent source must parse under DRX (and stay legacy-clean)", () => {
  it("regex shapes outside DRX are refused per role", () => {
    expectReject(portDraft({ intent: { ...portDraft().intent, strong: ["\\d+h ?额度(用了|还?剩)多少"] } }), "regex");
    expectReject(portDraft({ intent: { ...portDraft().intent, weak: ["第\\d{1,4}个"] } }), "regex");
    expectReject(portDraft({ intent: { ...portDraft().intent, exclude: ["(a|a)+"] } }), "regex");
    expectReject(portDraft({ intent: { ...portDraft().intent, strong: ["(a|a)+"] } }), "regex");
  });
});

describe("rule ⑦ — example self-check under ideal TUI facts", () => {
  it("a hit that S0 vetoes is refused", () => {
    expectReject(
      portDraft({
        intent: { ...portDraft().intent, examples: { hit: ["帮我看看后台 job", ...hitOf(4)], miss: missOf() } },
      }),
      "examples",
    );
  });
  it("a hit that is not high for THIS draft is refused", () => {
    expectReject(
      portDraft({
        intent: { ...portDraft().intent, examples: { hit: ["完全无关的句子", ...hitOf(4)], miss: missOf() } },
      }),
      "examples",
    );
  });
  it("a miss that scores high for THIS draft is refused", () => {
    expectReject(
      portDraft({
        intent: { ...portDraft().intent, examples: { hit: hitOf(), miss: ["后台 job 有哪些", ...missOf(4)] } },
      }),
      "examples",
    );
  });
});

describe("loader constants (BA §4.6)", () => {
  it("DRAFT_READ_FLAGS mirrors SESSION_READ_FLAGS exactly", () => {
    expect(DRAFT_READ_FLAGS).toBe(SESSION_READ_FLAGS);
  });
  it("budget/caps/names match the BA §4.6 numbers", () => {
    expect(DRAFT_LOAD_BUDGET_MS).toBe(500);
    expect(DIR_SCAN_CAP).toBe(64);
    expect(DRAFT_FILE_READ_CAP).toBe(16);
    expect(DRAFT_MAX_FILE_BYTES).toBe(16 * 1024);
    expect(DRAFT_CAPS).toEqual({ strong: 12, weak: 8, exclude: 32, examplesMin: 5, examplesMax: 20 });
    expect(DRAFT_NAME_RE.test("draft.a-1.json")).toBe(true);
    expect(DRAFT_NAME_RE.test("plain.json")).toBe(true);
    expect(DRAFT_NAME_RE.test("A.json")).toBe(false);
    expect(DRAFT_NAME_RE.test("a b.json")).toBe(false);
    expect(DRAFT_NAME_RE.test("../x.json")).toBe(false);
    expect(DRAFT_NAME_RE.test(`${"a".repeat(65)}.json`)).toBe(false);
  });
});

/** A valid jobs.list draft, with overridable intent (uses the shared helper's defaults). */
function portDraft(over: { intent?: RScriptV1["intent"] } = {}): RScriptV1 {
  const base = makeDraft({ id: "draft.t" });
  return { ...base, ...(over.intent !== undefined ? { intent: over.intent } : {}) };
}
const hitOf = (n = 5): string[] =>
  n <= 5
    ? ["后台 job 有哪些", "后台?job 有哪些", "后台第3个 job", "后台第10个 job 吗", "后台第2个 job 呢"].slice(0, n)
    : [...hitOf(5), ...Array.from({ length: n - 5 }, (_, i) => `后台第${i + 20}个 job`)];
const missOf = (n = 5): string[] =>
  n <= 5
    ? ["把后台 job 都停了", "后台 job 的日志", "新开一个后台 job", "帮我看看后台 job", "后台 job 状态怎么样"].slice(
        0,
        n,
      )
    : [...missOf(5), ...Array.from({ length: n - 5 }, (_, i) => `无关句子${i}号`)];
