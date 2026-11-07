// jev-plan §4 J6: inject.ts additions — `onRender`'s third argument
// (JevRenderInfo: primary / omittedSections / coreInlined) and the
// `stripInlineMeta` switch (jev on ⇒ `<!-- mem … -->` stripped from the
// injected block; off ⇒ kept byte-for-byte).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import type { JevRenderInfo } from "../../src/memory/jev/contracts.js";
import { jevRenderInfoOf, memorySection, type MemorySectionDeps } from "../../src/memory/inject.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { RenderCache } from "../../src/memory/render.js";
import { renderTiered } from "../../src/memory/tiered.js";

let envTmp: string;
let cwd: string;

beforeEach(() => {
  envTmp = mkdtempSync(join(tmpdir(), "inject-jev-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(memoryDirFor(cwd), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
});

function seed(name: string, text: string): void {
  writeFileSync(join(memoryDirFor(cwd), name), text);
}

function render(settings: Partial<MemorySettings>, extra: Partial<MemorySectionDeps> = {}) {
  const calls: { cwd: string; block: string | undefined; info: JevRenderInfo | undefined }[] = [];
  const section = memorySection({
    settings: { ...DEFAULT_SETTINGS.memory, ...settings },
    isChildSession: false,
    cache: new RenderCache(),
    frozenBlocks: new Map(),
    onRender: (c, block, info) => calls.push({ cwd: c, block, info }),
    ...extra,
  });
  const out = section.provider({
    ctx: { cwd, sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionContext,
    promptText: "",
    optionsCwd: cwd,
  });
  return { out: String(out), calls };
}

const CORE_WITH_COMMENTS =
  "# Core\n\n## Rules\n\n- run long commands with timeout <!-- mem user gate -->\n- exact paths only <!--mem lesson-->\n";

describe("inject.ts — jev additions", () => {
  test("onRender third argument: primary inlined whole ⇒ coreInlined, no omitted sections", () => {
    seed("core.md", CORE_WITH_COMMENTS);
    const { calls } = render({});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.info).toEqual({ primary: "core.md", omittedSections: [], coreInlined: true });
  });

  test("section-level admission ⇒ omittedSections carried; L4 demotion ⇒ coreInlined false", () => {
    const big = (title: string) =>
      `## ${title}\n\n${Array.from({ length: 40 }, (_, i) => `- ${title} line ${i} ${"x".repeat(40)}`).join("\n")}\n`;
    seed("core.md", `# Core\n\n## Small\n\n- tiny rule\n\n${big("Huge")}`);
    const partial = render({ coreBytes: 900, blockBytes: 4000 });
    expect(partial.calls[0]!.info).toEqual({ primary: "core.md", omittedSections: ["Huge"], coreInlined: true });
    // preamble alone larger than the core budget ⇒ the primary is demoted (L4)
    seed("core.md", `# Core\n\n${"p".repeat(2000)}\n\n## Small\n\n- tiny\n`);
    const demoted = render({ coreBytes: 600, blockBytes: 4000 });
    expect(demoted.calls[0]!.info?.coreInlined).toBe(false);
  });

  test("jevRenderInfoOf: no primary at all ⇒ not inlined", () => {
    seed("topic.md", "# Topic\n\n- something\n");
    const r = renderTiered({ cwd, profile: "full", access: "memory", coreBytes: 2000, blockBytes: 6000, indexMax: 20 });
    expect(jevRenderInfoOf(r)).toEqual({ omittedSections: [], coreInlined: false });
  });

  test("stripInlineMeta=true strips `<!-- mem … -->` from the block; absent keeps it byte-for-byte", () => {
    seed("core.md", CORE_WITH_COMMENTS);
    const off = render({});
    expect(off.out).toContain("<!-- mem user gate -->");
    expect(off.out).toContain("<!--mem lesson-->");
    const on = render({}, { stripInlineMeta: true });
    expect(on.out).not.toContain("<!-- mem");
    expect(on.out).not.toContain("<!--mem");
    expect(on.out).toContain("- run long commands with timeout\n");
    // onRender sees the stripped block (the freeze source stays consistent)
    expect(on.calls[0]!.block).toBe(on.out);
    // a block without inline comments is identical with the switch on or off
    seed("core.md", "# Core\n\n## Rules\n\n- plain rule\n");
    expect(render({}, { stripInlineMeta: true }).out).toBe(render({}).out);
  });

  test("legacy layout passes no render info", () => {
    seed("core.md", CORE_WITH_COMMENTS);
    const { calls } = render({ layout: "legacy" });
    expect(calls[0]!.info).toBeUndefined();
  });
});
