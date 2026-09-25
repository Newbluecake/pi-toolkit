// sysprompt-stable plan v3.1 §4.6 / §7.1 M3: the `pi_project_memory` section
// folded into the hub alongside `pi_subagent_types` / `pi_subagent_models`.
//
// Golden test (task scope item 1): `mode: "legacy"` output for all three
// sections together is byte-identical to the pre-M3 chain of three
// independent `before_agent_start` appends (memory hook -> agent-types
// append -> available-models append), in the same order. That pre-M3 chain
// no longer exists as code (createMemoryInjectHook was removed by M3), so it
// is inlined here as the oracle -- it is exactly `prompt + "\n\n" + block`
// repeated per non-empty section, which is also what `foldSections` does
// (already covered independently for types/models in
// tests/prompt-sections/stable-fold.test.ts).
//
// Stable-mode tests cover the parts that are new in M3: writing memory keeps
// the folded system prompt byte-identical on the next turn (frozen snapshot)
// and a tail update message announces the change; `injectInChildSessions`
// gates the section in child sessions exactly as it did pre-M3.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub, type PromptSectionHub, type PromptSectionHubOpts } from "../../src/sysprompt/hub.js";
import { agentTypesSection, availableModelsSection } from "../../src/sysprompt/core-sections.js";
import { appendAgentTypesToSystemPrompt } from "../../src/config/agent-types.js";
import { appendAvailableModelsToSystemPrompt } from "../../src/config/available-models.js";
import { memorySection, memoryTitle } from "../../src/memory/inject.js";
import { RenderCache } from "../../src/memory/render.js";
import { toSlug } from "../../src/memory/paths.js";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import type { AgentTypeConfig } from "../../src/core/types.js";

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    on(event: string, handler: any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    appendEntry() {
      // stable-mode tests below only assert on the returned systemPrompt /
      // message, not on persistence (covered by tests/prompt-sections/store.test.ts).
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function fire(host: FakePi, event: string, payload: unknown, ctx: unknown = {}): unknown[] {
  return (host.handlers.get(event) ?? []).map((h) => h(payload, ctx));
}

const TYPES: AgentTypeConfig[] = [
  { name: "reviewer", description: "Reviews code changes.", systemPrompt: "", promptMode: "append" },
];
const MODELS = [{ provider: "anthropic", id: "claude", name: "Claude" }];

function makeHub(host: FakePi, opts: Partial<PromptSectionHubOpts> = {}): PromptSectionHub {
  return createPromptSectionHub(host.pi, {
    mode: opts.mode ?? (() => "legacy"),
    wakeReplay: opts.wakeReplay ?? false,
    adoptForeignForcedPrompt: opts.adoptForeignForcedPrompt ?? false,
  });
}

function registerCoreSections(hub: PromptSectionHub): void {
  hub.register("pi_subagent_types", agentTypesSection({ types: { list: () => TYPES }, foregroundAutoBackgroundMs: 0 }));
  hub.register("pi_subagent_models", availableModelsSection({ stackAvailable: () => MODELS }));
}

function fixture(settings: Partial<MemorySettings> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-hub-"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const memoryDir = join(tmp, "mem", toSlug(cwd));
  mkdirSync(memoryDir, { recursive: true });
  const cache = new RenderCache();
  const frozenBlocks = new Map<string, string | undefined>();
  const memDeps = {
    settings: { ...DEFAULT_SETTINGS.memory, ...settings },
    isChildSession: false,
    cache,
    frozenBlocks,
    paths: { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") },
  };
  return { tmp, cwd, memoryDir, memDeps, cache, frozenBlocks };
}

function fakeCtx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, mode: "rpc" } as unknown as ExtensionContext;
}

function beforeAgentStart(host: FakePi, systemPrompt: string, cwd: string): any {
  const [handler] = host.handlers.get("before_agent_start") ?? [];
  return handler!(
    { type: "before_agent_start", prompt: "go", systemPrompt, systemPromptOptions: { cwd } },
    fakeCtx(cwd),
  );
}

describe("memory section registered in the hub (M3)", () => {
  test("golden: legacy mode == pre-M3 three-hook chain, byte-for-byte", () => {
    const fx = fixture();
    writeFileSync(join(fx.memoryDir, "notes.md"), "remember this");
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_project_memory", memorySection(fx.memDeps));
    registerCoreSections(hub);

    const result = beforeAgentStart(host, "BASE", fx.cwd);

    // Oracle: the pre-M3 chain was memory-hook append -> agent-types append
    // -> available-models append, each `prompt + "\n\n" + text` when non-empty.
    const memoryBlock = memorySection(fx.memDeps).provider({ ctx: fakeCtx(fx.cwd), promptText: "BASE" } as any);
    let oracle = "BASE";
    if (typeof memoryBlock === "string" && memoryBlock !== "") oracle += "\n\n" + memoryBlock;
    oracle = appendAgentTypesToSystemPrompt(oracle, TYPES, { foregroundAutoBackgroundMs: 0 });
    oracle = appendAvailableModelsToSystemPrompt(oracle, MODELS);

    expect(result.systemPrompt).toBe(oracle);
    expect(result.systemPrompt).toContain("remember this");
    expect(result.systemPrompt.indexOf("## Memory (")).toBeLessThan(
      result.systemPrompt.indexOf("## Available subagent types"),
    );
    expect(result.systemPrompt.indexOf("## Available subagent types")).toBeLessThan(
      result.systemPrompt.indexOf("## Available models"),
    );
  });

  test("stable mode: writing memory keeps the folded prompt byte-identical next turn, with a tail update message", () => {
    const fx = fixture();
    const host = fakePi();
    const hub = makeHub(host, { mode: () => "stable" });
    hub.register("pi_project_memory", memorySection(fx.memDeps));
    registerCoreSections(hub);

    // Turn 1: no memory files yet -> memory section contributes nothing.
    const first = beforeAgentStart(host, "BASE", fx.cwd);
    expect(first?.systemPrompt).not.toContain("## Memory (");

    // A write happens mid-session (simulating the memory tool + cache
    // invalidation that wireMemory wires up in production).
    writeFileSync(join(fx.memoryDir, "notes.md"), "fresh note");
    fx.cache.delete(fx.cwd);

    // Turn 2: prefixFresh is false (no compaction happened) -> the memory
    // section's SNAPSHOT stays frozen (empty, from turn 1) even though the
    // live content changed; the folded system prompt is therefore
    // byte-identical to turn 1 (G2), and the change surfaces only as a tail
    // update message. Like production, pi hands us the same raw base prompt
    // each turn (it does not remember our own prior injections) -- only OUR
    // fold output would change, and here it does not.
    const second = beforeAgentStart(host, "BASE", fx.cwd);
    expect(second?.systemPrompt).toBe(first?.systemPrompt); // opening bytes unchanged (G2)
    expect(second?.systemPrompt).not.toContain("fresh note");
    expect(second?.message).toBeDefined();
    expect(second!.message.customType).toBe("subagent:prompt-section-update");
    expect(second!.message.content).toContain("fresh note");
    expect(second!.message.content).toContain(memoryTitle(toSlug(fx.cwd)));
    // P3 (live acceptance 2026-09-25): the frozen head had no memory section, so the update
    // must say it ADDS one — not that it replaces a section the prompt never contained.
    expect(second!.message.content).toContain("ADDS a section to your system prompt");
    expect(second!.message.content).not.toContain("REPLACES");
  });

  test("stable mode: a memory section present at freeze time is REPLACED by later updates", () => {
    const fx = fixture();
    writeFileSync(join(fx.memoryDir, "notes.md"), "first note");
    const host = fakePi();
    const hub = makeHub(host, { mode: () => "stable" });
    hub.register("pi_project_memory", memorySection(fx.memDeps));
    registerCoreSections(hub);

    const first = beforeAgentStart(host, "BASE", fx.cwd);
    expect(first?.systemPrompt).toContain("first note");

    writeFileSync(join(fx.memoryDir, "notes.md"), "second note");
    fx.cache.delete(fx.cwd);
    const second = beforeAgentStart(host, "BASE", fx.cwd);
    expect(second?.systemPrompt).toBe(first?.systemPrompt);
    expect(second!.message.content).toContain("REPLACES the section of your system prompt");
    expect(second!.message.content).not.toContain("ADDS a section");
  });

  test("child session: injectInChildSessions=false makes the section inert", () => {
    const fx = fixture({ injectInChildSessions: false });
    writeFileSync(join(fx.memoryDir, "notes.md"), "should not appear");
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_project_memory", memorySection({ ...fx.memDeps, isChildSession: true }));
    registerCoreSections(hub);

    const result = beforeAgentStart(host, "BASE", fx.cwd);
    expect(result.systemPrompt).not.toContain("should not appear");
    expect(result.systemPrompt).not.toContain("## Memory (");
  });

  test("child session: injectInChildSessions=true (default) still injects", () => {
    const fx = fixture();
    writeFileSync(join(fx.memoryDir, "notes.md"), "child-visible");
    const host = fakePi();
    const hub = makeHub(host);
    hub.register("pi_project_memory", memorySection({ ...fx.memDeps, isChildSession: true }));

    const result = beforeAgentStart(host, "BASE", fx.cwd);
    expect(result.systemPrompt).toContain("child-visible");
  });
});
