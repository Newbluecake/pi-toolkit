/**
 * jev-reflex · rscript/1 typebox schema + catalog self-check (plan R1 step 6; arch §4.5, R-I12).
 *
 * typebox is a peer (host-aliased) — a VALUE import here is fine, it is not pi (pi-free gate
 * follows value edges; PD3). `validateScript` checks one shape, `validateCatalog` adds the
 * cross-script rules (unique ids, builtin-only, budget ceiling, regex hygiene). Pure, no
 * module-scope mutable state (I4); the schema is built once from `budget.ts` constants.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { REFLEX_BUDGET_MS } from "./budget.js";
import type { Capability, PortId, RScriptV1 } from "./types.js";

const PORT_IDS: readonly PortId[] = ["jobs.list", "fleet.status", "quota.summary", "git.status", "sessions.recent"];
const CAPABILITIES: readonly Capability[] = ["bashJobs", "fleet", "quota", "git", "sessionDir"];

export const RScriptV1Schema = Type.Object({
  schema: Type.Literal("rscript/1"),
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*\\.[a-z0-9-]+$" }),
  version: Type.Integer({ minimum: 1 }),
  origin: Type.Union([Type.Literal("builtin"), Type.Literal("extracted")]),
  risk: Type.Literal("readonly"),
  intent: Type.Object({
    strong: Type.Array(Type.String(), { minItems: 1 }),
    weak: Type.Array(Type.String()),
    exclude: Type.Array(Type.String()),
    examples: Type.Object({
      hit: Type.Array(Type.String(), { minItems: 5 }),
      miss: Type.Array(Type.String(), { minItems: 5 }),
    }),
  }),
  port: Type.Object({ id: Type.String() }),
  requires: Type.Array(Type.String()),
  budgetMs: Type.Optional(Type.Integer({ exclusiveMinimum: 0, maximum: REFLEX_BUDGET_MS })),
  render: Type.Object({
    title: Type.String(),
    emptyText: Type.String(),
    maxLines: Type.Integer({ minimum: 1 }),
  }),
  agreement: Type.Object({ tools: Type.Array(Type.String()), bashShapes: Type.Array(Type.String()) }),
});

/** Structural validation of one script; throws with the collected typebox problems. */
export function validateScript(input: unknown): RScriptV1 {
  if (!Value.Check(RScriptV1Schema, input)) {
    const problems = [...Value.Errors(RScriptV1Schema, input)].map((e) => `${e.path}: ${e.message}`);
    throw new Error(`rscript/1 validation failed: ${problems.join("; ")}`);
  }
  return input as RScriptV1;
}

/**
 * A serialized regex literal (`/foo/g`) as a source string — the only way `/g` semantics can
 * smuggle in, since compile helpers never pass flags. Sources must be bare.
 */
const SERIALIZED_LITERAL_RE = /^\/[\s\S]*\/[a-z]*$/;

/** `+`/`*`/`{…}` directly before `)` followed by a quantifier — `(…+)+` shapes (catastrophic). */
const NESTED_QUANTIFIER_RE = /(?:\+|\*|\})\)(?:\+|\*|\?|\{)/;

function stripClassesAndEscapes(src: string): string {
  return src.replace(/\\./g, "x").replace(/\[(?:[^\]\\]|\\.)*\]/g, "x");
}

/** Regex hygiene scan shared by the catalog check and the unit tests. */
export function regexSourceProblems(source: string): string[] {
  const problems: string[] = [];
  if (source === "") problems.push("empty regex source");
  if (SERIALIZED_LITERAL_RE.test(source)) problems.push(`serialized literal (flags semantics): ${source}`);
  if (NESTED_QUANTIFIER_RE.test(stripClassesAndEscapes(source))) problems.push(`nested quantifier: ${source}`);
  try {
    // Compiled WITHOUT flags — the only sanctioned shape; a compile failure is also a problem.
    // eslint-disable-next-line no-new
    new RegExp(source);
  } catch (err) {
    problems.push(`does not compile: ${(err as Error).message}`);
  }
  return problems;
}

/**
 * Catalog self-check (R-I12): every script structurally valid, builtin-only, uniquely id'd,
 * within the budget ceiling, with known port ids / capabilities and clean regex sources.
 * Throws on the first rule set that fails; returns the (validated) input for convenience.
 */
export function validateCatalog(scripts: readonly unknown[]): readonly RScriptV1[] {
  const seen = new Set<string>();
  const out: RScriptV1[] = [];
  for (const raw of scripts) {
    const script = validateScript(raw);
    const label = script.id || "<no id>";
    if (script.origin !== "builtin") throw new Error(`catalog refuses origin "${script.origin}" (${label}) — R-I12`);
    if (!PORT_IDS.includes(script.port.id)) throw new Error(`unknown port id "${script.port.id}" (${label})`);
    for (const cap of script.requires) {
      if (!CAPABILITIES.includes(cap)) throw new Error(`unknown capability "${cap}" (${label})`);
    }
    if (seen.has(script.id)) throw new Error(`duplicate script id "${script.id}"`);
    seen.add(script.id);
    if (script.budgetMs !== undefined && script.budgetMs > REFLEX_BUDGET_MS) {
      throw new Error(`budgetMs ${script.budgetMs} > REFLEX_BUDGET_MS ${REFLEX_BUDGET_MS} (${label})`);
    }
    const sources = [...script.intent.strong, ...script.intent.weak, ...script.intent.exclude];
    for (const src of sources) {
      const problems = regexSourceProblems(src);
      if (problems.length > 0) throw new Error(`bad intent regex (${label}): ${problems.join("; ")}`);
    }
    out.push(script);
  }
  return out;
}
