/**
 * jev-reflex · #25 B0 draft validation (BA §4.5): the pure gate every draft file must pass before
 * it can load (rules ①–⑦) plus the loader constants the runtime (B4 `drafts/load.ts`) and the
 * generator (B2) share. Pure functions, no pi imports, no module-scope mutable state (I4/R-I10).
 *
 * validateDraft NEVER throws: every failure is a {@link DraftReject} carrying a
 * {@link DraftRejectCode} (the same code space the loader reports in `/reflex drafts`).
 */

import { evaluateGate } from "./gate.js";
import { compileCatalog } from "./match.js";
import { MVP_PORTS, portDefaultsOf } from "./port-defaults.js";
import { parseDrx } from "./draft-regex.js";
import { regexSourceProblems, validateScript } from "./schema.js";
import type { Capability, DraftRejectCode, PortId, RScriptV1 } from "./types.js";

export interface DraftReject {
  readonly code: DraftRejectCode;
  readonly detail?: string;
}

/** §4.5 rule ⑤ caps — counts per draft file. */
export const DRAFT_CAPS = Object.freeze({
  strong: 12,
  weak: 8,
  exclude: 32,
  examplesMin: 5,
  examplesMax: 20,
});

/** BA §4.6 rule 5: whole-load budget (I/O only — matching cost is bounded by the DRX grammar). */
export const DRAFT_LOAD_BUDGET_MS = 500;
/** BA §4.6 rule 2: streaming dirent cap; the 65th dirent ⇒ whole-directory `dir-cap`. */
export const DIR_SCAN_CAP = 64;
/** BA §4.6 rule 2: how many validly-named files are actually read (sorted; the rest ⇒ `cap`). */
export const DRAFT_FILE_READ_CAP = 16;
/** BA §4.6 rule 3: per-file read cap (+1 byte overread detects post-stat growth). */
export const DRAFT_MAX_FILE_BYTES = 16 * 1024;
/** BA §4.6 rule 2: file-name whitelist inside the drafts directory. */
export const DRAFT_NAME_RE = /^[a-z0-9.-]{1,64}\.json$/;

/** §4.5 rule ③ — draft ids (and their optional lineage). */
const DRAFT_ID_RE = /^draft\.[a-z0-9-]+$/;
const DRAFT_LINEAGE_RE = /^[a-z0-9.-]+$/;

/** §4.5 rule ① — the exact allowed key set at every level (typebox alone tolerates extras). */
const ALLOWED_KEYS: ReadonlyArray<{ at: string; keys: readonly string[] }> = [
  {
    at: "$",
    keys: [
      "schema",
      "id",
      "version",
      "origin",
      "risk",
      "lineage",
      "intent",
      "port",
      "requires",
      "budgetMs",
      "render",
      "agreement",
    ],
  },
  { at: "$.intent", keys: ["strong", "weak", "exclude", "examples"] },
  { at: "$.intent.examples", keys: ["hit", "miss"] },
  { at: "$.port", keys: ["id"] },
  { at: "$.render", keys: ["title", "emptyText", "maxLines"] },
  { at: "$.agreement", keys: ["tools", "bashShapes"] },
];

function unknownKeys(input: unknown): string[] {
  const problems: string[] = [];
  const root = input as Record<string, unknown> | null;
  if (root === null || typeof root !== "object") return problems;
  const at = (obj: Record<string, unknown>, path: string, keys: readonly string[]): void => {
    for (const k of Object.keys(obj))
      if (!keys.includes(k)) problems.push(`${path === "$" ? "" : path.slice(1)}.${k}`.replace(/^\./, ""));
  };
  at(root, "$", ALLOWED_KEYS[0]!.keys);
  const intent = root.intent as Record<string, unknown> | undefined;
  if (intent !== undefined && typeof intent === "object") {
    at(intent, "$.intent", ALLOWED_KEYS[1]!.keys);
    const ex = intent.examples as Record<string, unknown> | undefined;
    if (ex !== undefined && typeof ex === "object") at(ex, "$.intent.examples", ALLOWED_KEYS[2]!.keys);
  }
  for (const key of ["port", "render", "agreement"] as const) {
    const obj = root[key] as Record<string, unknown> | undefined;
    if (obj !== undefined && typeof obj === "object")
      at(obj, `$.${key}`, ALLOWED_KEYS.find((a) => a.at === `$.${key}`)!.keys);
  }
  return problems;
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The ideal TUI facts a draft's examples are judged under (BA §4.5 rule ⑦; same shape as `/reflex explain`). */
function idealGate(text: string): { pass: boolean; norm?: string } {
  const gate = evaluateGate({
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: 0,
    text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  });
  return gate.pass ? { pass: true, norm: gate.norm.norm } : { pass: false };
}

/**
 * BA §4.5 rules ①–⑦. `builtinIds` are the catalog ids the draft must not shadow ("namespace").
 * Duplicate detection AMONG drafts is the loader's job (it sees the whole directory).
 */
export function validateDraft(raw: unknown, builtinIds: ReadonlySet<string>): RScriptV1 | DraftReject {
  // ① structural schema + no unknown keys at any level
  let script: RScriptV1;
  try {
    script = validateScript(raw);
  } catch (err) {
    return { code: "schema", detail: (err as Error).message.slice(0, 200) };
  }
  const extra = unknownKeys(raw);
  if (extra.length > 0) return { code: "schema", detail: `unknown keys: ${extra.join(", ")}` };
  // ② draft-only origin/risk
  if (script.origin !== "extracted")
    return { code: "schema", detail: `origin must be "extracted" (got "${script.origin}")` };
  if (script.risk !== "readonly") return { code: "schema", detail: `risk must be "readonly"` };
  // ③ id namespace + lineage shape
  if (!DRAFT_ID_RE.test(script.id))
    return { code: "namespace", detail: `id must match ${DRAFT_ID_RE.source} (got "${script.id}")` };
  if (builtinIds.has(script.id)) return { code: "namespace", detail: `id shadows builtin "${script.id}"` };
  if (script.lineage !== undefined && !DRAFT_LINEAGE_RE.test(script.lineage))
    return { code: "namespace", detail: `lineage must match ${DRAFT_LINEAGE_RE.source}` };
  // ④ port binding + per-field defaults equality (K3 — a draft cannot tweak its own agreement)
  const port = script.port.id as PortId;
  if (!MVP_PORTS.includes(port)) return { code: "port-mismatch", detail: `port "${port}" has no builtin script` };
  const d = portDefaultsOf(port);
  if (d === undefined) return { code: "port-mismatch", detail: `no defaults for port "${port}"` };
  if (!sameStrings(script.requires, d.requires))
    return { code: "port-mismatch", detail: `requires must equal the port default [${d.requires.join(",")}]` };
  if (
    !sameStrings(script.agreement.tools, d.agreement.tools) ||
    !sameStrings(script.agreement.bashShapes, d.agreement.bashShapes)
  )
    return { code: "port-mismatch", detail: `agreement must equal the port default` };
  if (
    script.render.title !== d.render.title ||
    script.render.emptyText !== d.render.emptyText ||
    script.render.maxLines !== d.render.maxLines
  )
    return { code: "port-mismatch", detail: `render must equal the port default` };
  // ⑤ no budgetMs; count caps
  if (script.budgetMs !== undefined) return { code: "schema", detail: "drafts must not set budgetMs" };
  if (script.intent.strong.length === 0) return { code: "schema", detail: "strong must not be empty" };
  if (script.intent.strong.length > DRAFT_CAPS.strong)
    return { code: "cap", detail: `strong ${script.intent.strong.length} > ${DRAFT_CAPS.strong}` };
  if (script.intent.weak.length > DRAFT_CAPS.weak)
    return { code: "cap", detail: `weak ${script.intent.weak.length} > ${DRAFT_CAPS.weak}` };
  if (script.intent.exclude.length > DRAFT_CAPS.exclude)
    return { code: "cap", detail: `exclude ${script.intent.exclude.length} > ${DRAFT_CAPS.exclude}` };
  for (const side of ["hit", "miss"] as const) {
    const n = script.intent.examples[side].length;
    if (n < DRAFT_CAPS.examplesMin || n > DRAFT_CAPS.examplesMax)
      return {
        code: "cap",
        detail: `examples.${side} ${n} outside ${DRAFT_CAPS.examplesMin}–${DRAFT_CAPS.examplesMax}`,
      };
  }
  // ⑥ DRX grammar per role + the legacy hygiene scan (compile-ability etc.)
  const roles: ReadonlyArray<[readonly string[], "strong" | "weak" | "exclude"]> = [
    [script.intent.strong, "strong"],
    [script.intent.weak, "weak"],
    [script.intent.exclude, "exclude"],
  ];
  for (const [sources, role] of roles) {
    for (const src of sources) {
      const r = parseDrx(src, role);
      if (!r.ok) return { code: "regex", detail: `${role} "${src.slice(0, 60)}": ${r.problem}` };
      const legacy = regexSourceProblems(src);
      if (legacy.length > 0) return { code: "regex", detail: `${role} "${src.slice(0, 60)}": ${legacy.join("; ")}` };
    }
  }
  // ⑦ example self-check under ideal TUI facts, judged against THIS draft alone
  const matcher = compileCatalog([script]);
  const caps = new Set<Capability>(script.requires);
  for (const hit of script.intent.examples.hit) {
    const g = idealGate(hit);
    if (!g.pass) return { code: "examples", detail: `hit example vetoed by S0: "${hit.slice(0, 40)}"` };
    const m = matcher.match(g.norm!, caps);
    if (m.kind !== "hit" || m.band !== "high" || m.scriptId !== script.id)
      return { code: "examples", detail: `hit example is not high for this draft: "${hit.slice(0, 40)}"` };
  }
  for (const miss of script.intent.examples.miss) {
    const g = idealGate(miss);
    if (g.pass) {
      const m = matcher.match(g.norm!, caps);
      if (m.kind === "hit" && m.band === "high" && m.scriptId === script.id)
        return { code: "examples", detail: `miss example scores high for this draft: "${miss.slice(0, 40)}"` };
    }
  }
  return script;
}
