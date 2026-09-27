// optimize-plan §4.5 / §10 D group (todo #22 P0-b): the v2 tool surface's
// frozen text/schema, byte-budget accounting, and the canonical-JSON
// comparison that makes the golden fixture meaningful across the two
// `@sinclair/typebox` builds this repo runs under (devDependency `^0.34.49`
// vs. the `typebox@1.3.27` pi 0.87.1 aliases `@sinclair/typebox` to at
// runtime — same key/value set, different key order).

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type as DevType } from "@sinclair/typebox";
import {
  canonicalJson,
  MEMORY_TOOL_V2_TEXT,
  MemoryToolParamsV2,
  toolSurfaceBytes,
  type ToolSurfaceText,
} from "../../src/memory/tool-surface.js";
import { createMemoryTool } from "../../src/memory/tool.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/memory-tool-surface.json", import.meta.url), "utf8")) as {
  legacy: { description: string; promptSnippet: string; promptGuidelines: string; parameters: string };
  v2: { description: string; promptSnippet: string; promptGuidelines: string; parameters: string };
  bytes: { legacy: number; v2: number };
};

// The legacy tool is NEVER edited by this package (optimize-plan §2.7 复审
// 新-3) — build the real tool definition instead of duplicating its text.
const legacyTool = createMemoryTool({
  settings: DEFAULT_SETTINGS.memory,
  isChildSession: false,
  onAfterWrite: () => {},
});
const legacyText: ToolSurfaceText = {
  description: legacyTool.description,
  ...(legacyTool.promptSnippet === undefined ? {} : { promptSnippet: legacyTool.promptSnippet }),
  ...(legacyTool.promptGuidelines === undefined ? {} : { promptGuidelines: legacyTool.promptGuidelines }),
  parameters: legacyTool.parameters,
};

// Same schema shape as src/memory/tool.ts, rebuilt against an explicit
// typebox namespace so it can be run under BOTH typebox builds below.
function buildLegacyParams(T: typeof DevType) {
  return T.Object({
    action: T.Optional(T.Union([T.Literal("list"), T.Literal("write"), T.Literal("append")])),
    name: T.Optional(
      T.String({
        description: 'Memory file name, e.g. "decisions.md". Required for write/append. *.md only, no path separators.',
      }),
    ),
    content: T.Optional(
      T.String({ description: "Full file body (write) or text to append (append). Required for write/append." }),
    ),
  });
}

// Same shape as src/memory/tool-surface.ts's MemoryToolParamsV2.
function buildV2Params(T: typeof DevType) {
  const S = () => T.Optional(T.String());
  const lit = (values: readonly string[]) => T.Optional(T.Union(values.map((v) => T.Literal(v))));
  return T.Object({
    command: lit(["view", "create", "str_replace", "insert", "delete", "rename", "search"]),
    path: S(),
    view_range: T.Optional(T.Array(T.Integer(), { minItems: 2, maxItems: 2 })),
    section: S(),
    file_text: S(),
    old_str: S(),
    new_str: S(),
    insert_line: T.Optional(T.Integer({ minimum: 0 })),
    insert_text: S(),
    old_path: S(),
    new_path: S(),
    query: S(),
    action: lit(["list", "write", "append"]),
    name: S(),
    content: S(),
  });
}

/**
 * Locate `node_modules/<name>` above `fromDir` (plain directory walk, no
 * Node resolution algorithm involved) — vitest's SSR transform strips
 * `import.meta.resolve` (the mechanism the plan's §11.2 real-Node runner
 * uses), so this test resolves the runtime `typebox` build the pi package
 * ships with the same end result via a directory walk instead.
 */
function findPackageDir(name: string, fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find node_modules/${name} above ${fromDir}`);
}

/** Resolve the SAME `typebox` build pi 0.87.1's extension loader aliases
 *  `@sinclair/typebox` to at runtime (§4.5) — from the pi package itself, not
 *  hoisting/guessing. Throws (failing the test, never skipping) if it can't. */
async function resolveRuntimeType(): Promise<typeof DevType> {
  const pkgDir = findPackageDir("@earendil-works/pi-coding-agent", process.cwd());
  const req = createRequire(join(pkgDir, "package.json"));
  const resolved = req.resolve("typebox");
  const mod = (await import(resolved)) as { Type: typeof DevType };
  return mod.Type;
}

describe("v2 tool surface (§4.5 frozen text)", () => {
  it("promptGuidelines is exactly one line", () => {
    expect(MEMORY_TOOL_V2_TEXT.promptGuidelines).toHaveLength(1);
  });

  it("dev typebox: canonical JSON matches the golden fixture (legacy + v2)", () => {
    const v2Params = buildV2Params(DevType);
    expect(canonicalJson(legacyText.description)).toBe(fixture.legacy.description);
    expect(canonicalJson(legacyText.promptSnippet)).toBe(fixture.legacy.promptSnippet);
    expect(canonicalJson(legacyText.promptGuidelines)).toBe(fixture.legacy.promptGuidelines);
    expect(canonicalJson(MemoryToolParamsV2)).toBe(fixture.v2.parameters);
    expect(canonicalJson(v2Params)).toBe(fixture.v2.parameters);
    expect(canonicalJson(MEMORY_TOOL_V2_TEXT.description)).toBe(fixture.v2.description);
    expect(canonicalJson(MEMORY_TOOL_V2_TEXT.promptSnippet)).toBe(fixture.v2.promptSnippet);
    expect(canonicalJson(MEMORY_TOOL_V2_TEXT.promptGuidelines)).toBe(fixture.v2.promptGuidelines);
  });

  it("dev typebox: legacy parameters canonical JSON matches the golden fixture", () => {
    expect(canonicalJson(buildLegacyParams(DevType))).toBe(fixture.legacy.parameters);
    expect(canonicalJson(legacyText.parameters)).toBe(fixture.legacy.parameters);
  });

  it("runtime typebox (resolved from the pi package): same canonical JSON, different raw key order", async () => {
    const RuntimeType = await resolveRuntimeType();
    const runtimeV2Params = buildV2Params(RuntimeType);
    const runtimeLegacyParams = buildLegacyParams(RuntimeType);
    expect(canonicalJson(runtimeV2Params)).toBe(fixture.v2.parameters);
    expect(canonicalJson(runtimeLegacyParams)).toBe(fixture.legacy.parameters);
    // The whole point of canonicalization: raw JSON.stringify key order
    // differs between the two builds for at least the union members, but the
    // byte COUNT is identical (§4.5's实测).
    expect(JSON.stringify(runtimeV2Params)).not.toBe(JSON.stringify(buildV2Params(DevType)));
  });

  it("byte budget: legacy is 1333B, v2 is 1443B (≤1500B ceiling), stable across both typebox builds", async () => {
    const RuntimeType = await resolveRuntimeType();
    const devBytes = toolSurfaceBytes({ ...legacyText, parameters: buildLegacyParams(DevType) });
    const runtimeBytes = toolSurfaceBytes({ ...legacyText, parameters: buildLegacyParams(RuntimeType) });
    expect(devBytes).toBe(1333);
    expect(runtimeBytes).toBe(1333);
    expect(fixture.bytes.legacy).toBe(1333);

    const v2DevBytes = toolSurfaceBytes({ ...MEMORY_TOOL_V2_TEXT, parameters: buildV2Params(DevType) });
    const v2RuntimeBytes = toolSurfaceBytes({ ...MEMORY_TOOL_V2_TEXT, parameters: buildV2Params(RuntimeType) });
    expect(v2DevBytes).toBe(1443);
    expect(v2RuntimeBytes).toBe(1443);
    expect(v2DevBytes).toBeLessThanOrEqual(1500);
    expect(fixture.bytes.v2).toBe(1443);
  });
});

describe("canonicalJson", () => {
  it("recursively sorts object keys, keeps array order, and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: [3, 1, 2], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"z":[3,1,2]}');
    expect(
      canonicalJson([
        { b: 1, a: 1 },
        { d: 1, c: 1 },
      ]),
    ).toBe('[{"a":1,"b":1},{"c":1,"d":1}]');
    expect(canonicalJson("plain string")).toBe('"plain string"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
  });

  it("golden itself is idempotent under a second canonicalization (never compare raw text)", () => {
    for (const group of [fixture.legacy, fixture.v2]) {
      for (const value of Object.values(group)) {
        expect(canonicalJson(JSON.parse(value))).toBe(value);
      }
    }
  });
});
