// §4.1/§4.5's v2 tool surface: frozen parameter schema + prompt text, plus
// the byte-accounting/canonical-JSON helpers the golden test
// (`tests/memory/tool-surface.test.ts`, `tests/fixtures/memory-tool-surface.json`)
// pins against. `tool-v2.ts` (P2) is the only consumer of the schema/text —
// this file exists so the frozen text and its byte budget are reviewed and
// locked in P0-b, before any tool factory is built around them.
//
// typebox note (§4.5): pi 0.87.1 aliases `@sinclair/typebox` to its own
// bundled `typebox@1.3.27`; this repo's devDependency is `^0.34.49`. Both
// produce the same byte COUNT for `JSON.stringify(parameters)` but a
// different KEY ORDER, so the golden compares `canonicalJson()` output, not
// the raw serialization.

import { Type, type Static } from "@sinclair/typebox";

const S = () => Type.Optional(Type.String());
const lit = (values: readonly string[]) => Type.Optional(Type.Union(values.map((v) => Type.Literal(v))));

/** §4.1's frozen v2 parameter schema. */
export const MemoryToolParamsV2 = Type.Object({
  command: lit(["view", "create", "str_replace", "insert", "delete", "rename", "search"]),
  path: S(),
  view_range: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
  section: S(),
  file_text: S(),
  old_str: S(),
  new_str: S(),
  insert_line: Type.Optional(Type.Integer({ minimum: 0 })),
  insert_text: S(),
  old_path: S(),
  new_path: S(),
  query: S(),
  action: lit(["list", "write", "append"]),
  name: S(),
  content: S(),
});
export type MemoryToolParamsV2 = Static<typeof MemoryToolParamsV2>;

/** §4.5's frozen v2 tool text — do not edit without updating this section AND
 *  `tests/fixtures/memory-tool-surface.json` in the same change (a golden
 *  mismatch is a deliberate cross-check, not busywork). */
export const MEMORY_TOOL_V2_TEXT = {
  description:
    "Project memory (cwd-keyed; core + topic index auto-injected). command: view [path] [view_range|section] · " +
    "search query · create path file_text · str_replace path old_str [new_str] · insert path insert_line|section " +
    "insert_text · delete path · rename old_path new_path. path: x.md or /memories/x.md; omit to list. Legacy: " +
    "action list|write|append + name/content. Never store secrets.",
  promptSnippet: "Project memory: view/search, edit in place",
  promptGuidelines: [
    "memory: open a topic only when its `when` matches; fix stale facts with str_replace instead of appending duplicates; keep core.md to always-needed rules.",
  ],
} as const;

/** §9.3's jev-on description variant: the v2 text with the auto-tagging +
 *  inline-authority sentence appended (jev-plan J5). Everything else —
 *  promptSnippet, promptGuidelines and above all the SCHEMA — is shared
 *  with the base variant (Q32: `tag_add` deferred, schema byte-identical).
 *  Do not edit without updating `tests/fixtures/memory-tool-surface.json`
 *  (the `jev` key) in the same change. */
const MEMORY_TOOL_V2_JEV_SUFFIX =
  "Entries are tagged automatically after writes. Inline authority (end of the entry's first line): " +
  '<!-- mem user|lesson expires=YYYY-MM-DD until="…" tags=+a,-b private -->.';

export const MEMORY_TOOL_V2_TEXT_JEV: {
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
} = {
  ...MEMORY_TOOL_V2_TEXT,
  description: `${MEMORY_TOOL_V2_TEXT.description} ${MEMORY_TOOL_V2_JEV_SUFFIX}`,
};

/** #36 arch r5 §4.1.1 — the v3 (blocks layout) parameter schema. The
 *  frozen v2 exports above are untouched. `action`/`name`/`content`/
 *  `old_str`/`new_str`/`insert_*`/`old_path`/`new_path`/`view_range`/
 *  `section` are deliberately GONE; a model still sending them gets either
 *  the host's schema rejection (unknown `command` enum values never reach
 *  `execute`) or `normalizeV3`'s `E_UNSUPPORTED_COMMAND` (extra properties
 *  pass typebox's default-tolerant validation and are inspected there). */
export const MemoryToolParamsV3 = Type.Object({
  command: lit(["view", "create", "update", "delete", "search"]),
  path: S(), // block id (quota.007 / quota.007.md / /memories/quota.007.md); view also accepts a topic name
  topic: S(), // create: [a-z0-9-]{1,48}
  text: S(), // create/update: whole-block body, first line may carry <!-- mem … -->
  rev: S(), // update required, delete optional
  query: S(), // search
});
export type MemoryToolParamsV3 = Static<typeof MemoryToolParamsV3>;

/** arch r5 §4.1.1 — the v3 tool text (blocks layout). Do not edit without
 *  updating `tests/fixtures/memory-tool-surface.json` (the `blocks` /
 *  `blocksJev` / `bytes.blocks` / `bytes.blocksJev` keys) in the same
 *  change. Budget ceiling: 1700B. */
export const MEMORY_TOOL_V3_TEXT = {
  description:
    "Project memory as blocks (one fact per file, body ≤1024B). User rules with scope=global are always injected; " +
    "other blocks are injected when relevant; a topic index is shown. view [path] (omit = list; <topic> = its blocks) · " +
    "search query · create topic text · update path rev text (whole-block replace; rev from view) · delete path [rev]. " +
    "Never store secrets.",
  promptSnippet: "Project memory: view/search; one fact per block",
  promptGuidelines: [
    "memory: fix a stale fact with update (view first for rev) instead of creating a duplicate; one durable fact per block; mark user orders with <!-- mem user -->.",
  ],
} as const;

/** arch r5 §4.1.1 — the jev-on variant: only the description swaps (the
 *  write-syntax sentence is appended); schema/snippet/guidelines shared
 *  with the base variant (same rule as v2's `MEMORY_TOOL_V2_TEXT_JEV`). */
export const MEMORY_TOOL_V3_TEXT_JEV: {
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
} = {
  ...MEMORY_TOOL_V3_TEXT,
  description:
    `${MEMORY_TOOL_V3_TEXT.description} Entries are tagged automatically. Meta on the text's first line: ` +
    '<!-- mem user|lesson scope=global audience=main|child expires=YYYY-MM-DD until="…" supersedes=id tags=+a,-b private -->.',
};

export interface ToolSurfaceText {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters: unknown;
}

/** §4.5's byte-budget formula: description + promptSnippet + promptGuidelines
 *  (newline-joined) + `JSON.stringify(parameters)`, all UTF-8 bytes.
 *  `name`/`label` are constants and excluded. */
export function toolSurfaceBytes(def: ToolSurfaceText): number {
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  return (
    bytes(def.description) +
    bytes(def.promptSnippet ?? "") +
    bytes((def.promptGuidelines ?? []).join("\n")) +
    bytes(JSON.stringify(def.parameters))
  );
}

/**
 * Recursively key-sorted, whitespace-free JSON — used ONLY to compare a
 * typebox schema's shape across the two `@sinclair/typebox` builds this repo
 * runs under (§4.5): they emit the same key/value set in a different order.
 * Arrays keep their original order (schema arrays are semantically ordered:
 * `enum`/`required`/`minItems` tuples). Non-plain-object values (including
 * typebox's internal `Symbol` keys, which `JSON.stringify` already drops)
 * pass through `JSON.stringify` unchanged.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}
