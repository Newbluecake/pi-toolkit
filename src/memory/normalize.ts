// §4.2 v2 alias/mutual-exclusion normalization — P2 real implementation
// (todo #22 optimize-plan §14.1).
//
// **Frozen-surface gap (reported, not self-fixed — see this package's final
// report)**: contracts.ts's frozen `NormalizedCall.op: MemoryCommand` only
// allows the 7 `command` literals, but §4.2's alias table and §4.3's command
// table both require `action:"write"`/`action:"append"` to flow through
// `normalizeMemoryCall` as their OWN ops (distinct write-overwrite vs.
// create's no-clobber vs. append's frontmatter-preserving-append semantics
// — confirmed with the plan author, who called this a P0 oversight and
// recommended widening `contracts.ts` to `op: MemoryCommand | "write" |
// "append"`). Since nothing outside this package (`src/memory/normalize.ts`
// + `tool-v2.ts`) consumes `contracts.ts`'s `NormalizedCall`/`MemoryCommand`
// today, this file defines its OWN slightly-widened `NormalizedCall` (same
// shape, `op` widened) instead of editing the frozen file — `tool-v2.ts`
// imports the type FROM HERE, never from `contracts.js` directly.

import type { MemoryCommand, NormalizedCall as FrozenNormalizedCall } from "./contracts.js";
import type { MemoryToolParamsV2 } from "./tool-surface.js";

export type MemoryOpV2 = MemoryCommand | "write" | "append";

export interface NormalizedCall extends Omit<FrozenNormalizedCall, "op"> {
  op: MemoryOpV2;
}

const TARGET_FIELDS = ["path", "name", "old_path"] as const;
type TargetField = (typeof TARGET_FIELDS)[number];

const BODY_FIELDS = ["file_text", "content", "insert_text"] as const;
type BodyField = (typeof BODY_FIELDS)[number];

/** Per-op accepted body field aliases, primary alias first (used to build
 *  the "X takes A (or B)" error message — §4.2 rule 2). */
const BODY_ACCEPT: Partial<Record<MemoryOpV2, readonly [BodyField, BodyField]>> = {
  create: ["file_text", "content"],
  write: ["file_text", "content"],
  insert: ["insert_text", "content"],
  append: ["content", "insert_text"],
};

function present(v: unknown): v is string {
  return v !== undefined;
}

/** Resolve a family of mutually-aliasing fields to one slot value.
 *  - 0 given → undefined.
 *  - 1 given → that value.
 *  - ≥2 given, all equal → that value + a "both given (same value)" note.
 *  - ≥2 given, differing → throws (§4.2 rule 1). */
function resolveAliasSlot(
  given: readonly { field: string; value: string | undefined }[],
  notes: string[],
): string | undefined {
  const provided = given.filter((g) => present(g.value)) as { field: string; value: string }[];
  if (provided.length === 0) return undefined;
  if (provided.length === 1) return provided[0]!.value;
  const first = provided[0]!;
  for (const other of provided.slice(1)) {
    if (other.value !== first.value) {
      throw new Error(
        `conflicting ${first.field}/${other.field}: ${JSON.stringify(first.value)} vs ${JSON.stringify(other.value)}`,
      );
    }
  }
  notes.push(`${provided.map((p) => p.field).join(" and ")} both given (same value)`);
  return first.value;
}

/** §4.2 rule 5: op defaults to "view"; `command`/`action` are mutually
 *  exclusive (always an error when both given, never compared for equality
 *  — they carry different semantics even when superficially compatible). */
function resolveOp(params: MemoryToolParamsV2): MemoryOpV2 {
  if (params.command !== undefined && params.action !== undefined) {
    throw new Error("command and action are mutually exclusive");
  }
  // typebox's `Union(values.map(Type.Literal))` built from a runtime `string[]`
  // (rather than a literal tuple) loses literal inference in `Static<>` — the
  // schema still enforces the enum at runtime, so these casts are sound.
  if (params.command !== undefined) return params.command as MemoryCommand;
  if (params.action !== undefined) return params.action === "list" ? "view" : (params.action as "write" | "append");
  return "view";
}

/**
 * §4.2's pure normalization: resolve `op`, then the `target`/`dest`/`body`/
 * `old`/`new`/`view_range`/`section`/`insert_line`/`query` slots per rule
 * 1–4, collecting mutex-equal notes and an "ignored params: …" note for any
 * field left over. Throws a plain `Error` (never `MemoryError` — §4.2's
 * "command-facing error convention") on a conflicting/invalid combination.
 */
export function normalizeMemoryCall(params: MemoryToolParamsV2): NormalizedCall {
  const op = resolveOp(params);
  const notes: string[] = [];
  const consumed = new Set<string>(["command", "action"]);

  // ── body (rule 2: wrong alias for an op that HAS a body slot ⇒ error) ──
  const bodyAccept = BODY_ACCEPT[op];
  let body: string | undefined;
  if (bodyAccept) {
    const [primary, secondary] = bodyAccept;
    const wrong = BODY_FIELDS.find((f) => f !== primary && f !== secondary);
    if (wrong !== undefined && present(params[wrong])) {
      throw new Error(`${op} takes ${primary} (or ${secondary})`);
    }
    body = resolveAliasSlot(
      [
        { field: primary, value: params[primary] },
        { field: secondary, value: params[secondary] },
      ],
      notes,
    );
    consumed.add(primary).add(secondary);
    if (wrong !== undefined) consumed.add(wrong); // absent anyway (else we threw above)
  }

  // ── target (path/name/old_path — every op but search) ──
  let target: string | undefined;
  if (op !== "search") {
    target = resolveAliasSlot(
      TARGET_FIELDS.map((f) => ({ field: f, value: params[f] })),
      notes,
    );
    for (const f of TARGET_FIELDS) consumed.add(f);
  }

  // ── dest (new_path — rename only) ──
  let dest: string | undefined;
  if (op === "rename") {
    dest = params.new_path;
    consumed.add("new_path");
  }

  // ── old/new (str_replace only, no aliasing) ──
  let oldStr: string | undefined;
  let newStr: string | undefined;
  if (op === "str_replace") {
    oldStr = params.old_str;
    newStr = params.new_str;
    consumed.add("old_str").add("new_str");
  }

  // ── view_range (view only) ──
  let viewRange: readonly [number, number] | undefined;
  if (op === "view") {
    consumed.add("view_range");
    if (params.view_range !== undefined) {
      const [a, b] = params.view_range;
      viewRange = [a as number, b as number];
    }
  }

  // ── section (view + insert) ──
  let section: string | undefined;
  if (op === "view" || op === "insert") {
    consumed.add("section");
    section = params.section;
  }

  // ── insert_line (insert only) ──
  let insertLine: number | undefined;
  if (op === "insert") {
    consumed.add("insert_line");
    insertLine = params.insert_line;
  }

  // ── query (search only) ──
  let query: string | undefined;
  if (op === "search") {
    consumed.add("query");
    query = params.query;
  }

  // ── ignored fields (rule 3) ──
  const ALL_FIELDS: readonly (keyof MemoryToolParamsV2)[] = [
    "path",
    "view_range",
    "section",
    "file_text",
    "old_str",
    "new_str",
    "insert_line",
    "insert_text",
    "old_path",
    "new_path",
    "query",
    "name",
    "content",
  ];
  const ignored: string[] = [];
  for (const f of ALL_FIELDS) {
    if (consumed.has(f)) continue;
    if (present(params[f])) ignored.push(f);
  }
  if (ignored.length > 0) notes.push(`ignored params: ${ignored.join(", ")}`);

  return {
    op,
    ...(target === undefined ? {} : { target }),
    ...(dest === undefined ? {} : { dest }),
    ...(body === undefined ? {} : { body }),
    ...(oldStr === undefined ? {} : { oldStr }),
    ...(newStr === undefined ? {} : { newStr }),
    ...(viewRange === undefined ? {} : { viewRange }),
    ...(section === undefined ? {} : { section }),
    ...(insertLine === undefined ? {} : { insertLine }),
    ...(query === undefined ? {} : { query }),
    notes,
  };
}
