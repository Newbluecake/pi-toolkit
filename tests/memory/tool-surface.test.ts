// optimize-plan §4.5 / §10 D group (todo #22 P0-b): the v2 tool surface's
// frozen text/schema, byte-budget accounting, and the canonical-JSON
// comparison that makes the golden fixture meaningful across the two
// `@sinclair/typebox` builds this repo runs under (devDependency `^0.34.49`
// vs. the `typebox@1.3.27` pi 0.87.1 aliases `@sinclair/typebox` to at
// runtime — same key/value set, different key order).

import { createHash } from "node:crypto";
import { memoryV4Surface, MemoryToolParamsV4, measureMemorySurface } from "../../src/memory/unified/surface.js";
import { wireMemory } from "../../src/memory/index.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { fakePi } from "../integration/helpers/schedule-activate.js";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type as DevType } from "@sinclair/typebox";
import {
  canonicalJson,
  MEMORY_TOOL_V2_TEXT,
  MEMORY_TOOL_V2_TEXT_JEV,
  MEMORY_TOOL_V3_TEXT,
  MEMORY_TOOL_V3_TEXT_JEV,
  MemoryToolParamsV2,
  MemoryToolParamsV3,
  toolSurfaceBytes,
  type ToolSurfaceText,
} from "../../src/memory/tool-surface.js";
import { createMemoryTool } from "../../src/memory/tool.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/memory-tool-surface.json", import.meta.url), "utf8")) as {
  legacy: { description: string; promptSnippet: string; promptGuidelines: string; parameters: string };
  v2: { description: string; promptSnippet: string; promptGuidelines: string; parameters: string };
  /** J5 (jev-plan §4): description-variant key — additions only, the legacy
   *  and v2 groups above are byte-frozen. */
  jev: { description: string; bytes: number };
  /** #36 P4 (arch r5 §4.1.6): v3 block-surface keys — additions only. */
  blocks: { description: string; promptSnippet: string; promptGuidelines: string; parameters: string };
  blocksJev: { description: string };
  blocksUnified: Record<string, string>;
  blocksUnifiedJev: Record<string, string>;
  blocksUnifiedChild: Record<string, string>;
  bytes: {
    legacy: number;
    v2: number;
    blocks: number;
    blocksJev: number;
    blocksUnified: number;
    blocksUnifiedJev: number;
    blocksUnifiedChild: number;
  };
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

// Same shape as src/memory/tool-surface.ts's MemoryToolParamsV3 (arch r5
// §4.1.1) — rebuilt against an explicit typebox namespace so both builds
// can be compared.
function buildV3Params(T: typeof DevType) {
  const S = () => T.Optional(T.String());
  const lit = (values: readonly string[]) => T.Optional(T.Union(values.map((v) => T.Literal(v))));
  return T.Object({
    command: lit(["view", "create", "update", "delete", "search"]),
    path: S(),
    topic: S(),
    text: S(),
    rev: S(),
    query: S(),
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

  // J5 (jev-plan §4 / arch §9.3): the jev-on variant ONLY swaps the
  // description — the schema's canonical JSON is byte-identical to v2 and
  // promptSnippet/promptGuidelines are shared. Budget updated in this same
  // test per the plan ("字节预算断言更新在同一测试").
  it("jev variant: description = v2 text + §9.3 sentence, schema/snippet/guidelines unchanged, budget 1616B (≤1700B ceiling)", async () => {
    const RuntimeType = await resolveRuntimeType();
    // description: original + " " + the §9.3 sentence, verbatim.
    expect(MEMORY_TOOL_V2_TEXT_JEV.description.startsWith(MEMORY_TOOL_V2_TEXT.description)).toBe(true);
    expect(MEMORY_TOOL_V2_TEXT.description.endsWith("Never store secrets.")).toBe(true);
    expect(MEMORY_TOOL_V2_TEXT_JEV.description).toContain(
      "Entries are tagged automatically after writes. Inline authority (end of the entry's first line): " +
        '<!-- mem user|lesson expires=YYYY-MM-DD until="…" tags=+a,-b private -->.',
    );
    // ~250B suffix per §9.3 (194B + the joining space, pinned exactly).
    expect(
      Buffer.byteLength(MEMORY_TOOL_V2_TEXT_JEV.description, "utf8") -
        Buffer.byteLength(MEMORY_TOOL_V2_TEXT.description, "utf8"),
    ).toBe(173);
    // shared fields — NOT part of the variant.
    expect(MEMORY_TOOL_V2_TEXT_JEV.promptSnippet).toBe(MEMORY_TOOL_V2_TEXT.promptSnippet);
    expect(MEMORY_TOOL_V2_TEXT_JEV.promptGuidelines).toStrictEqual([...MEMORY_TOOL_V2_TEXT.promptGuidelines]);
    // schema byte-identical under canonicalJson, on BOTH typebox builds.
    const runtimeV2Params = buildV2Params(RuntimeType);
    expect(toolSurfaceBytes({ ...MEMORY_TOOL_V2_TEXT_JEV, parameters: MemoryToolParamsV2 })).toBe(1616);
    expect(toolSurfaceBytes({ ...MEMORY_TOOL_V2_TEXT_JEV, parameters: runtimeV2Params })).toBe(1616);
    expect(toolSurfaceBytes({ ...MEMORY_TOOL_V2_TEXT_JEV, parameters: MemoryToolParamsV2 })).toBeLessThanOrEqual(1700);
    expect(fixture.jev.bytes).toBe(1616);
    // fixture: the new key matches the constant (canonical form).
    expect(canonicalJson(MEMORY_TOOL_V2_TEXT_JEV.description)).toBe(fixture.jev.description);
    expect(fixture.jev.description.startsWith(fixture.v2.description.slice(0, -1))).toBe(true);
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

// ── #36 P4 (arch r5 §4.1.1/§4.1.6): the v3 block surface — declared update ──

describe("v3 tool surface (#36 blocks, declared golden addition)", () => {
  it("canonical JSON matches the new fixture keys on the dev typebox", async () => {
    expect(canonicalJson(MemoryToolParamsV3)).toBe(fixture.blocks.parameters);
    expect(canonicalJson(buildV3Params(DevType))).toBe(fixture.blocks.parameters);
    expect(canonicalJson(MEMORY_TOOL_V3_TEXT.description)).toBe(fixture.blocks.description);
    expect(canonicalJson(MEMORY_TOOL_V3_TEXT.promptSnippet)).toBe(fixture.blocks.promptSnippet);
    expect(canonicalJson(MEMORY_TOOL_V3_TEXT.promptGuidelines)).toBe(fixture.blocks.promptGuidelines);
  });

  it("runtime typebox (resolved from the pi package): same canonical JSON, different raw key order", async () => {
    const RuntimeType = await resolveRuntimeType();
    expect(canonicalJson(buildV3Params(RuntimeType))).toBe(fixture.blocks.parameters);
    expect(JSON.stringify(buildV3Params(RuntimeType))).not.toBe(JSON.stringify(buildV3Params(DevType)));
  });

  it("v3 drops every v2 editing field; the five commands are the only enum members", () => {
    const params = JSON.parse(fixture.blocks.parameters) as {
      properties: Record<string, { anyOf?: { const: string }[] }>;
    };
    expect(Object.keys(params.properties).sort()).toEqual(["command", "path", "query", "rev", "text", "topic"]);
    expect(params.properties.command.anyOf?.map((m) => m.const)).toEqual([
      "view",
      "create",
      "update",
      "delete",
      "search",
    ]);
    for (const gone of [
      "action",
      "name",
      "content",
      "old_str",
      "new_str",
      "insert_line",
      "insert_text",
      "old_path",
      "new_path",
      "view_range",
      "section",
      "file_text",
    ]) {
      expect(params.properties).not.toHaveProperty(gone);
    }
  });

  it("byte budget: blocks is 923B, blocksJev is 1111B (≤1700B ceiling), stable across both typebox builds", async () => {
    const RuntimeType = await resolveRuntimeType();
    const devBytes = toolSurfaceBytes({ ...MEMORY_TOOL_V3_TEXT, parameters: buildV3Params(DevType) });
    const runtimeBytes = toolSurfaceBytes({ ...MEMORY_TOOL_V3_TEXT, parameters: buildV3Params(RuntimeType) });
    expect(devBytes).toBe(923);
    expect(runtimeBytes).toBe(923);
    expect(fixture.bytes.blocks).toBe(923);
    const jevDev = toolSurfaceBytes({ ...MEMORY_TOOL_V3_TEXT_JEV, parameters: buildV3Params(DevType) });
    const jevRuntime = toolSurfaceBytes({ ...MEMORY_TOOL_V3_TEXT_JEV, parameters: buildV3Params(RuntimeType) });
    expect(jevDev).toBe(1111);
    expect(jevRuntime).toBe(1111);
    expect(fixture.bytes.blocksJev).toBe(1111);
    expect(jevDev).toBeLessThanOrEqual(1700);
  });

  it("jev variant: description = v3 text + write-syntax sentence; schema/snippet/guidelines shared", () => {
    expect(MEMORY_TOOL_V3_TEXT_JEV.description.startsWith(MEMORY_TOOL_V3_TEXT.description)).toBe(true);
    expect(MEMORY_TOOL_V3_TEXT_JEV.promptSnippet).toBe(MEMORY_TOOL_V3_TEXT.promptSnippet);
    expect(MEMORY_TOOL_V3_TEXT_JEV.promptGuidelines).toStrictEqual([...MEMORY_TOOL_V3_TEXT.promptGuidelines]);
    expect(canonicalJson(MEMORY_TOOL_V3_TEXT_JEV.description)).toBe(fixture.blocksJev.description);
    expect(fixture.blocksJev.description.startsWith(fixture.blocks.description.slice(0, -1))).toBe(true);
    expect(
      Buffer.byteLength(MEMORY_TOOL_V3_TEXT_JEV.description, "utf8") -
        Buffer.byteLength(MEMORY_TOOL_V3_TEXT.description, "utf8"),
    ).toBe(188);
  });

  it("declared-addition fence: the pre-#36 keys keep their frozen bytes (legacy 1333 / v2 1443 / jev 1616)", () => {
    expect(fixture.bytes.legacy).toBe(1333);
    expect(fixture.bytes.v2).toBe(1443);
    expect(fixture.jev.bytes).toBe(1616);
    // the legacy/v2/v3 descriptions are three distinct surfaces
    expect(fixture.blocks.description).not.toBe(fixture.v2.description);
  });
});

// Stage 2 declared additions only: old variants are not re-recorded.
describe("v4 unified blocks surface (declared canonical variants)", () => {
  const variants = {
    blocksUnified: { options: {}, bytes: 2231, limit: 4096 },
    blocksUnifiedJev: { options: { jev: true }, bytes: 2315, limit: 4608 },
    blocksUnifiedChild: { options: { child: true }, bytes: 2295, limit: 4096 },
  };
  it.each(Object.entries(variants))("%s has all four canonical fields and exact measured bytes", (key, variant) => {
    const surface = memoryV4Surface(variant.options);
    const recorded = fixture[key as keyof typeof variants];
    expect(Object.keys(recorded).sort()).toEqual(["description", "parameters", "promptGuidelines", "promptSnippet"]);
    expect(recorded).toEqual(
      Object.fromEntries(Object.entries(surface).map(([name, value]) => [name, canonicalJson(value)])),
    );
    expect(toolSurfaceBytes(surface)).toBe(variant.bytes);
    expect(measureMemorySurface(surface)).toBe(variant.bytes);
    expect(fixture.bytes[key as keyof typeof variants]).toBe(variant.bytes);
    expect(variant.bytes).toBeLessThanOrEqual(variant.limit);
  });

  it("production child sees the closed unified schema independently of the frozen Agent surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-child-surface-"));
    vi.stubEnv("ARMORY_MEMORY_ROOT", root);
    try {
      const f = fakePi();
      wireMemory(f.pi, {
        settings: { ...DEFAULT_SETTINGS.memory, jev: { ...DEFAULT_SETTINGS.memory.jev, enabled: false } },
        isChildSession: true,
        sections: createPromptSectionHub(f.pi, {
          mode: () => "stable",
          wakeReplay: false,
          adoptForeignForcedPrompt: false,
        }),
      });
      const tool = f.tools.get("memory") as ToolDefinition;
      expect(tool.description).toBe(memoryV4Surface({ child: true }).description);
      expect(tool.description).toContain("omit authority; Hub is unavailable");
      for (const [key, value] of Object.entries(memoryV4Surface({ child: true }))) {
        expect(canonicalJson(tool[key as keyof ToolDefinition])).toBe(fixture.blocksUnifiedChild[key]);
        expect(canonicalJson(value)).toBe(fixture.blocksUnifiedChild[key]);
      }
      expect(toolSurfaceBytes(tool)).toBe(fixture.bytes.blocksUnifiedChild);
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.required).toEqual(["command"]);
      expect(Object.keys(tool.parameters.properties).sort()).toEqual([
        "authority",
        "command",
        "from",
        "id",
        "path",
        "query",
        "rev",
        "scope",
        "text",
        "topic",
      ]);
      expect(tool.parameters.properties.scope.default).toBe("project");
      expect(tool.parameters.properties).not.toHaveProperty("op");
      expect(tool.parameters.properties).not.toHaveProperty("storageScope");
      expect(tool.parameters).toEqual(MemoryToolParamsV4);
      for (const authority of ["agent", "user"]) {
        const result = await tool.execute(
          "child",
          { command: "view", scope: "hub", authority, unexpected: true },
          undefined,
          undefined,
          undefined as never,
        );
        expect(JSON.parse(result.content.map((c) => ("text" in c ? c.text : "")).join(""))).toMatchObject({
          ok: false,
          code: "E_CHILD_AUTHORITY",
        });
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("all pre-v4 fixture keys and existing byte counters retain their exact serialized bytes", () => {
    const oldHashes = {
      typeboxDev: "af7ec3a921efd1aa6e33276ab59ee3c2ef6d82d88f3724e4cba79f382cd916e0",
      generatedAt: "acf2da7e3cc29509bd5569b65b38881d984bb5a95fb7d69ea93a97ca7b566918",
      legacy: "e0f9922f05a9238a40803354df72b43cd3a71f99be09568398ee6185950d7b36",
      v2: "94360b40017a48e17b3866bd348bb3ac4448f0d47472fb0683c06efe8f9198be",
      jev: "4ac99d8d919c7e81c584f6ec59b0819c9a933618793e722845deaae1616459d7",
      bytes: "633b9c0a9dd96042fd5a94407f2104c5d79f3593ed9d6b9c2193c7d2370f59ff",
      blocks: "ac184b21c7279169169ceb6d13cee44488006e7a190b1c9c525dd64eed4ac491",
      blocksJev: "19224dc01eac04671b8550ed4d712c0793db582be99ebb9768c1b9161474d1bd",
    };
    const record = fixture as unknown as Record<string, unknown>;
    for (const [key, digest] of Object.entries(oldHashes)) {
      const value =
        key === "bytes"
          ? Object.fromEntries(Object.entries(fixture.bytes).filter(([name]) => !(name in variants)))
          : record[key];
      expect(createHash("sha256").update(JSON.stringify(value)).digest("hex"), key).toBe(digest);
    }
    expect(Object.keys(fixture).sort()).toEqual([...Object.keys(oldHashes), ...Object.keys(variants)].sort());
    expect(Object.keys(fixture.bytes).sort()).toEqual(
      ["legacy", "v2", "blocks", "blocksJev", ...Object.keys(variants)].sort(),
    );
  });
});
