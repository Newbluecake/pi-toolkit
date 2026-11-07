/** Real PromptSectionHub + memorySection factories, manually registered.
 * This is adapter-level prompt evidence, NOT P4c/UI/production hook assembly. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub, type SystemPromptMode, type SectionProviderInput } from "../../src/sysprompt/hub.js";
import { createScopedProjection } from "../../src/memory/scoped-projection.js";
import { memorySection } from "../../src/memory/inject.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { RenderCache } from "../../src/memory/render.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { PROMPT_SECTIONS_ENTRY_TYPE } from "../../src/prompt-sections/store.js";
import { POINTED, SKIP, type SectionName } from "../../src/prompt-sections/stable-section.js";
import type { SessionMemoryView, HubMemoryView, MemoryOwner } from "../../src/memory/scopes/types.js";
import { writeBlocksDir } from "../memory/blocks/helpers.js";
import { parseResidentSection } from "../../src/memory/blocks/render.js";
import * as safeFs from "../../src/memory/safe-fs.js";
import * as entries from "../../src/memory/jev/entries.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const date = "2026-11-07T00:00:00.000Z";
const view = (text = "- same", authority: "agent" | "user" = "user"): SessionMemoryView => ({
  items: [{ item: { id: "n1", text, authority, created: date, updated: date }, rev: "12345678" }],
  dropped: [],
  nextN: 2,
  opsSinceSnap: 0,
  persistence: "memory-only",
  poisoned: false,
});
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fixture(
  layout: "legacy" | "tiered" | "blocks" = "legacy",
  mode: SystemPromptMode = "stable",
  stripInlineMeta = false,
) {
  const root = mkdtempSync(join(tmpdir(), "p4a2-prompt-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  vi.stubEnv("ARMORY_MEMORY_ROOT", paths.memoryRoot);
  const memDir = memoryDirFor(cwd, paths);
  mkdirSync(memDir, { recursive: true });
  if (layout === "blocks")
    writeBlocksDir(memDir, [{ id: "general.001", authority: "user", scope: "global", body: "- same" }]);
  else writeFileSync(join(memDir, "core.md"), "---\nsource: agent\n---\n- same");
  let session = view();
  let hubView: HubMemoryView = { state: "absent", items: [] };
  let owner: MemoryOwner = { incarnation: {}, sid: "own", sessionEpoch: 1, branchGen: 1 };
  let locked = false;
  let enabled = true;
  let failSession = false;
  let sessionReads = 0;
  let hubReads = 0;
  const handlers = new Map<string, Handler>();
  const entries: unknown[] = [];
  let branch: unknown[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  } as unknown as ExtensionAPI;
  const hub = createPromptSectionHub(pi, {
    mode: () => mode,
    wakeReplay: true,
    adoptForeignForcedPrompt: false,
    log: () => undefined,
  });
  const projection = createScopedProjection({
    enabled: () => enabled,
    owner: () => owner,
    mode: () => mode,
    state: hub,
    session: {
      available: () => !locked,
      view: () => {
        sessionReads++;
        if (failSession) throw new Error("own read fault");
        return session;
      },
    },
    hub: {
      available: () => !locked,
      view: () => {
        hubReads++;
        return hubView;
      },
    },
  });
  const renders: { text: string | undefined; resident: ReadonlyMap<string, string> | undefined }[] = [];
  const frozenBlocks = new Map<string, string | undefined>();
  const section = memorySection({
    settings: { ...DEFAULT_SETTINGS.memory, layout, inlineMax: 5, byteCap: 12000, coreBytes: 6000, blockBytes: 12000 },
    paths,
    isChildSession: false,
    cache: new RenderCache(),
    frozenBlocks,
    projection,
    stripInlineMeta,
    getActiveTools: () => ["memory", "read"],
    onRender: (_cwd, text, _info, resident) => renders.push({ text, resident }),
  });
  const inputObjects: SectionProviderInput[] = [];
  for (const [name, registration] of [
    ["pi_project_memory", section],
    ["pi_session_memory", projection.sessionSection!],
    ["pi_hub_memory", projection.hubSection!],
  ] as const) {
    hub.register(name, {
      ...registration,
      provider: (input) => {
        inputObjects.push(input);
        return registration.provider(input);
      },
    });
  }
  hub.register("pi_subagent_models", { title: "Models", provider: () => "MODELS" });
  const ctx = {
    cwd,
    getSystemPrompt: () => "BASE",
    sessionManager: { getSessionId: () => "own", getBranch: () => branch },
  } as unknown as ExtensionContext;
  const invoke = (event: string, data: unknown = {}) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(event);
    return handler(data, ctx);
  };
  const start = () =>
    invoke("before_agent_start", { type: "before_agent_start", prompt: "go", systemPrompt: "BASE" }) as
      BeforeAgentStartEventResult | undefined;
  return {
    cwd,
    memDir,
    paths,
    section,
    projection,
    renders,
    frozenBlocks,
    hub,
    start,
    inputObjects,
    invoke,
    entries,
    ctx,
    reads: () => [sessionReads, hubReads],
    setFailSession: (v: boolean) => {
      failSession = v;
    },
    setSession: (v: SessionMemoryView) => {
      session = v;
    },
    setHub: (v: HubMemoryView) => {
      hubView = v;
    },
    setLocked: (v: boolean) => {
      locked = v;
    },
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    changeOwner: () => {
      owner = { ...owner, branchGen: owner.branchGen + 1 };
    },
    restore: (sections: Record<string, unknown>) => {
      branch = [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: { v: 1, sections } }];
      invoke("session_start", { reason: "reload" });
    },
  };
}
const persisted = (snapshot: string, extra: Record<string, unknown> = {}) => ({
  snapshot,
  sentCount: 0,
  sentBytes: 0,
  ...extra,
});

describe("actual prompt projection via manually registered production factories", () => {
  it.each(["legacy", "tiered", "blocks"] as const)("%s emits actual project loser in the system prompt", (layout) => {
    const f = fixture(layout);
    const result = f.start();
    expect(result?.systemPrompt).toContain("(dup of session n1)");
    expect(result?.systemPrompt).toContain("Session memory");
    expect(result?.systemPrompt).toContain("MODELS");
    expect(f.renders.at(-1)?.text).toContain("(dup of session n1)");
    expect(f.reads()).toEqual([1, 1]);
    expect(new Set(f.inputObjects).size).toBe(1);
    expect(f.inputObjects.every((i) => i.phase === "turn")).toBe(true);
    if (layout === "blocks") expect(f.renders.at(-1)?.resident).toEqual(parseResidentSection(f.renders.at(-1)!.text!));
  });
  it.each(["legacy", "tiered", "blocks"] as const)(
    "%s full vs index/private project authority uses REAL admissions",
    (layout) => {
      for (const visibility of ["full", "index", "private", "audience"] as const) {
        const f = fixture(layout);
        f.setSession(view("- same", "agent"));
        if (layout === "blocks") {
          writeBlocksDir(f.memDir, [
            {
              id: "general.001",
              authority: "user",
              scope: visibility === "index" ? "topic" : "global",
              body: "- same",
              ...(visibility === "private" ? { private: true } : {}),
              ...(visibility === "audience" ? { audience: "child" as const } : {}),
            },
          ]);
        } else {
          const comment =
            visibility === "private" ? "user private" : visibility === "audience" ? "user audience=child" : "user";
          writeFileSync(
            join(f.memDir, "core.md"),
            `---\nsource: agent\n${visibility === "index" ? "status: archived\n" : ""}---\n- same <!-- mem ${comment} -->`,
          );
          if (visibility === "index" && layout === "legacy") {
            // Legacy renders archived files historically; use its actual inlineMax
            // gate through a separate registration rather than assuming tiered rules.
            const noInline = memorySection({
              settings: { ...DEFAULT_SETTINGS.memory, layout: "legacy", inlineMax: 0 },
              isChildSession: false,
              cache: new RenderCache(),
              frozenBlocks: new Map(),
              paths: f.paths,
              projection: f.projection,
            });
            const input: SectionProviderInput = { ctx: f.ctx, promptText: "BASE", phase: "turn" };
            expect(noInline.provider(input)).not.toContain("dup of session");
            expect(f.projection.sessionSection!.provider(input)).not.toContain("dup of project");
            continue;
          }
        }
        f.start();
        const sessionText = f.hub._state("pi_session_memory")?.snapshot;
        if (visibility === "full") expect(sessionText).toContain("dup of project p");
        else expect(sessionText).not.toContain("dup of project");
      }
    },
  );
  it.each(["legacy", "tiered", "blocks"] as const)(
    "%s optional projection OFF has no new parsing/views/source cache or byte change",
    (layout) => {
      const f = fixture(layout);
      f.setEnabled(false);
      const split = vi.spyOn(entries, "splitEntries");
      const baseline = memorySection({
        settings: {
          ...DEFAULT_SETTINGS.memory,
          layout,
          inlineMax: 5,
          byteCap: 12000,
          coreBytes: 6000,
          blockBytes: 12000,
        },
        paths: f.paths,
        isChildSession: false,
        cache: new RenderCache(),
        frozenBlocks: new Map(),
        getActiveTools: () => ["memory", "read"],
      });
      const input: SectionProviderInput = { ctx: f.ctx, promptText: "BASE", phase: "turn" };
      const old = baseline.provider(input);
      if (typeof old !== "string" || old === "") throw new Error("baseline must render real own-temp source");
      expect(f.section.provider({ ...input })).toBe(old);
      expect(f.reads()).toEqual([0, 0]);
      expect(split).not.toHaveBeenCalled();
      expect(f.section.projectSources.source(f.cwd)).toBeUndefined();
      expect(f.start()!.systemPrompt).toBe(`BASE\n\n${old}\n\nMODELS`);
    },
  );
  it("memoized source output still checks owner before returning on the SAME input", () => {
    const f = fixture();
    const input: SectionProviderInput = { ctx: f.ctx, promptText: "BASE", phase: "turn" };
    const first = f.section.provider(input);
    expect(first).toContain("- same");
    const count = f.renders.length;
    expect(f.section.provider(input)).toBe(first);
    expect(f.renders).toHaveLength(count);
    f.changeOwner();
    expect(f.section.provider(input)).toBe(SKIP);
  });
  it.each(["legacy", "tiered", "blocks"] as const)(
    "%s reaches a REAL SDK local-provider request through manual factory registration only",
    async (layout) => {
      const f = fixture(layout);
      vi.stubEnv("HOME", f.paths.memoryRoot);
      const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
        await import("@earendil-works/pi-coding-agent");
      const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
      const agentDir = join(f.cwd, "agent");
      mkdirSync(agentDir);
      const manager = SessionManager.create(f.cwd, join(f.cwd, "sessions"));
      const settings = SettingsManager.create(f.cwd, agentDir);
      const requests: string[] = [];
      const model = {
        id: "p4a2-local",
        name: "p4a2-local",
        api: "anthropic-messages",
        provider: "p4a2-local",
        baseUrl: "http://invalid.local",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0 },
        contextWindow: 200000,
        maxTokens: 1000,
      };
      const runtime = {
        streamSimple(_model: unknown, context: unknown) {
          const messages = (context as { messages: { role: string; content: string }[] }).messages;
          requests.push(
            messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n"),
          );
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "local answer" }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            },
          } as never);
          return stream;
        },
        getAuth: async () => undefined,
        hasConfiguredAuth: () => true,
        checkAuth: async () => ({ ok: true }),
        isUsingOAuth: () => false,
        getAvailableSnapshot: () => [model],
        getModel: () => model,
      };
      let rendered: string | undefined;
      const loader = new DefaultResourceLoader({
        cwd: f.cwd,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "LOCAL P4a2 ADAPTER FIXTURE",
        extensionFactories: [
          (pi: ExtensionAPI) => {
            const hub = createPromptSectionHub(pi, {
              mode: () => "stable",
              wakeReplay: false,
              adoptForeignForcedPrompt: false,
            });
            const owner: MemoryOwner = { incarnation: {}, sid: manager.getSessionId(), sessionEpoch: 1, branchGen: 1 };
            const coordinator = createScopedProjection({
              enabled: () => true,
              owner: () => owner,
              mode: () => "stable",
              state: hub,
              session: { available: () => true, view: () => view() },
              hub: { available: () => true, view: () => ({ state: "absent", items: [] }) },
            });
            const memory = memorySection({
              settings: {
                ...DEFAULT_SETTINGS.memory,
                layout,
                inlineMax: 5,
                byteCap: 12000,
                coreBytes: 6000,
                blockBytes: 12000,
              },
              paths: f.paths,
              isChildSession: false,
              cache: new RenderCache(),
              frozenBlocks: new Map(),
              projection: coordinator,
              getActiveTools: () => [],
              onRender: (_cwd, text) => {
                rendered = text;
              },
            });
            hub.register("pi_project_memory", memory);
            hub.register("pi_session_memory", coordinator.sessionSection!);
            hub.register("pi_hub_memory", coordinator.hubSection!);
          },
        ],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: f.cwd,
        agentDir,
        model: model as never,
        modelRuntime: runtime as never,
        sessionManager: manager,
        settingsManager: settings,
        resourceLoader: loader,
        tools: [],
      });
      try {
        await session.bindExtensions({ mode: "rpc", shutdownHandler: async () => undefined });
        await session.prompt("local projection probe", { source: "rpc" });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("LOCAL P4a2 ADAPTER FIXTURE");
        expect(requests[0]).toContain("dup of session n1");
        expect(requests[0]).toContain("Session memory");
        expect(rendered).toContain("dup of session n1");
        expect(requests[0]).toContain(rendered!);
      } finally {
        session.dispose();
      }
    },
  );
  it("reload without project manifest resets ONLY project and samples same first turn, not skip", () => {
    const f = fixture();
    f.restore({
      pi_project_memory: persisted("OLD PROJECT SECRET"),
      pi_subagent_models: persisted("RESTORED MODELS"),
      pi_session_memory: persisted("OLD SESSION", { sid: "own" }),
    });
    const result = f.start();
    expect(result?.systemPrompt).not.toContain("OLD PROJECT SECRET");
    expect(result?.systemPrompt).toContain("### core.md");
    expect(result?.systemPrompt).toContain("OLD SESSION");
    expect(result?.systemPrompt).toContain("RESTORED MODELS");
    expect(f.hub._state("pi_subagent_models")?.snapshot).toBe("RESTORED MODELS");
    expect(f.renders).toHaveLength(1);
    expect(f.reads()).toEqual([1, 1]);
  });
  it("identical stripped text is not proof of restored historical authority", () => {
    const f = fixture("legacy", "stable", true);
    f.setSession(view("- same", "agent"));
    writeFileSync(join(f.memDir, "core.md"), "---\nsource: agent\n---\n- same <!-- mem user -->");
    // A different activation's snapshot could have been agent, despite exactly
    // these visible bytes. It is replaced, not blessed as historical user.
    f.restore({ pi_project_memory: persisted("## Memory (old)\n- same") });
    const first = f.start();
    expect(first?.systemPrompt).not.toContain("## Memory (old)");
    expect(first?.systemPrompt).not.toContain("<!-- mem user -->");
    expect(first?.systemPrompt).toContain("dup of project p");
    const snapshot = f.hub._state("pi_project_memory")?.snapshot;
    f.start();
    expect(f.hub._state("pi_project_memory")?.snapshot).toBe(snapshot); // not repeatedly reset after strip
  });
  it("same stripped bytes do NOT upgrade an existing snapshot to new disk authority", () => {
    const f = fixture("legacy", "stable", true);
    f.setSession(view("unrelated", "agent"));
    const path = join(f.memDir, "core.md");
    const before = "---\nsource: agent\n---\n- same <!-- mem lesson -->";
    const after = "---\nsource: agent\n---\n- same <!-- mem user   -->";
    expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after));
    writeFileSync(path, before);
    f.start();
    const snapshot = f.hub._state("pi_project_memory")!.snapshot;
    writeFileSync(path, after);
    const future = new Date(Date.now() + 4000);
    utimesSync(path, future, future);
    f.setSession(view("- same", "agent"));
    f.start();
    expect(f.hub._state("pi_project_memory")!.snapshot).toBe(snapshot);
    expect(f.section.projectSources.source(f.cwd)!.entries[0]!.authority).toBe("user"); // new SOURCE, not old snapshot provenance
    expect(f.hub._state("pi_session_memory")!.announced).not.toContain("dup of project");
    f.invoke("model_select");
    f.start(); // now a real refresh may establish the new user authority
    expect(f.hub._state("pi_session_memory")!.snapshot).toContain("dup of project p");
  });
  it("a read exception keeps the same own snapshot; only disabled/locked/inert can invalidate", () => {
    const f = fixture();
    f.start();
    const snapshot = f.hub._state("pi_session_memory")!.snapshot;
    f.setFailSession(true);
    f.start();
    expect(f.hub._state("pi_session_memory")!.snapshot).toBe(snapshot);
    expect(f.hub._state("pi_subagent_models")!.snapshot).toBe("MODELS");
    expect(f.reads()).toEqual([2, 2]);
  });
  it("seed recovery samples current project in same input shared by all providers", async () => {
    const f = fixture();
    f.restore({
      pi_project_memory: persisted("OLD PROJECT"),
      pi_session_memory: persisted("OLD SESSION", { sid: "own" }),
    });
    const result = (await f.invoke("context_with_system", {
      messages: [{ role: "system", content: "BASE", timestamp: 1 }],
    })) as { messages: { content: string }[] } | undefined;
    expect(JSON.stringify(result)).toContain("### core.md");
    expect(JSON.stringify(result)).not.toContain("OLD PROJECT");
    expect(f.inputObjects.every((i) => i.phase === "seed")).toBe(true);
    expect(new Set(f.inputObjects).size).toBe(1);
    expect(f.reads()).toEqual([1, 1]);
  });
  it("session-only changes reproject project while project body read count stays flat", () => {
    const f = fixture();
    const read = vi.spyOn(safeFs, "readRegular");
    const head = vi.spyOn(safeFs, "readRegularHead");
    f.start();
    const count = read.mock.calls.length;
    const heads = head.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    f.setSession(view("- unrelated"));
    const next = f.start();
    expect(read.mock.calls.length).toBe(count);
    expect(head.mock.calls.length).toBe(heads);
    expect(f.renders.at(-1)?.text).toContain("dup of session"); // old snapshot is still ACTUALLY visible
    f.invoke("model_select");
    f.start(); // lawful refresh makes only the new body visible
    expect(f.renders.at(-1)?.text).not.toContain("dup of session");
    expect(read.mock.calls.length).toBe(count);
    expect(head.mock.calls.length).toBe(heads);
    // Historical prefix can keep its old marker; fresh tail carries the new
    // actual projection rather than pretending the old prefix was erased.
    expect(next?.systemPrompt).toContain("dup of session");
    expect(next?.message?.content).toContain("unrelated");
  });
  it("freeze holds SOURCE+manifest across disk edits, but markers follow current layer views", () => {
    const f = fixture();
    f.start();
    const source = f.section.projectSources.source(f.cwd);
    expect(f.section.projectSources.freeze(f.cwd)).toBe(true);
    writeFileSync(join(f.memDir, "core.md"), "- completely different <!-- mem user -->");
    f.setSession(view("unrelated"));
    f.invoke("model_select");
    const read = vi.spyOn(safeFs, "readRegular");
    const heads = vi.spyOn(safeFs, "readRegularHead");
    f.start();
    expect(read).not.toHaveBeenCalled();
    expect(heads).not.toHaveBeenCalled();
    expect(f.section.projectSources.source(f.cwd)).toBe(source);
    expect(f.renders.at(-1)?.text).toContain("- same");
    expect(f.renders.at(-1)?.text).not.toContain("completely different");
    expect(f.renders.at(-1)?.text).not.toContain("dup of session");
    expect(f.renders.at(-1)?.text).toBe(f.hub._state("pi_project_memory")?.announced);
    f.setHub({
      state: "ok",
      items: [
        {
          id: "general.001",
          topic: "general",
          text: "- same",
          authority: "user",
          created: date,
          updated: date,
          grant: { via: "command", by: "user", turn: "12345678", cap: "12345678" },
          src: { project: "0123456789ab", label: "own", sid8: "12345678" },
        },
      ],
    });
    f.invoke("model_select");
    f.start();
    expect(f.renders.at(-1)?.text).toContain("dup of hub general.001");
    expect(f.renders.at(-1)?.text).not.toContain("completely different");
    expect(read).not.toHaveBeenCalled();
    expect(heads).not.toHaveBeenCalled();
  });
  it("frozen blocks Jev resident keys follow FINAL marker changes, not original source keys", () => {
    const f = fixture("blocks");
    f.start();
    const before = f.renders.at(-1)!.resident;
    f.section.projectSources.freeze(f.cwd);
    f.setSession(view("unrelated"));
    f.invoke("model_select");
    f.start();
    const after = f.renders.at(-1)!;
    expect(after.resident).toEqual(parseResidentSection(after.text!));
    expect(after.resident).not.toEqual(before);
    expect(after.text).toContain("- [general.001] same");
    expect(after.text).not.toContain("dup of session");
  });
  it("bare frozen string never acquires current disk authority; startup clear recovers", () => {
    const f = fixture();
    f.frozenBlocks.set(f.cwd, "BARE OLD BODY");
    const input: SectionProviderInput = { ctx: f.ctx, promptText: "BASE", phase: "turn" };
    expect(f.section.provider(input)).toBe(SKIP);
    expect(f.section.projectSources.freeze(f.cwd)).toBe(false);
    f.frozenBlocks.clear();
    expect(f.section.provider({ ...input })).toContain("- same");
  });
  it("owner boundary cannot reuse old frozen source; local clear/delete ports do not clear hub/foreign sections", () => {
    const f = fixture();
    f.start();
    f.section.projectSources.freeze(f.cwd);
    f.changeOwner();
    const input: SectionProviderInput = { ctx: f.ctx, promptText: "BASE", phase: "turn" };
    expect(f.section.provider(input)).toBe(SKIP);
    f.section.projectSources.delete(f.cwd);
    expect(f.section.provider({ ...input })).toContain("- same");
    expect(f.hub._state("pi_subagent_models")?.snapshot).toBe("MODELS");
    f.section.projectSources.clear();
    expect(f.section.projectSources.source(f.cwd)).toBeUndefined();
  });
  it("locked invalidates scoped names own-only, not project data or other providers", () => {
    const f = fixture();
    f.start();
    f.setLocked(true);
    const reads = f.reads();
    const result = f.start();
    expect(f.reads()).toEqual(reads);
    expect(result?.systemPrompt).toContain("MODELS");
    expect(f.hub._state("pi_session_memory")?.snapshot).toBeUndefined();
    expect(f.hub._state("pi_hub_memory")?.snapshot).toBeUndefined();
    expect(f.hub._state("pi_project_memory")?.snapshot).toContain("### core.md");
  });
  it("resampleIf throw is own-only failclosed outside fallback; absent field retains old recovered bytes", () => {
    const f = fixture();
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (n: string, h: Handler) => handlers.set(n, h),
      appendEntry: () => undefined,
    } as unknown as ExtensionAPI;
    const hub = createPromptSectionHub(pi, {
      mode: () => "stable",
      wakeReplay: false,
      adoptForeignForcedPrompt: false,
    });
    let broken = false;
    let calls = 0;
    hub.register("pi_project_memory", {
      title: "Project",
      resampleIf: () => {
        if (broken) throw new Error("secret");
        return false;
      },
      provider: () => {
        calls++;
        return "OWN";
      },
    });
    hub.register("pi_subagent_models", { title: "Models", provider: () => "OTHER" });
    const start = () =>
      handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, f.ctx) as BeforeAgentStartEventResult;
    start();
    broken = true;
    expect(start().systemPrompt).toBe("BASE\n\nOTHER");
    expect(calls).toBe(1);
    expect(hub._state("pi_project_memory")?.snapshot).toBeUndefined();
    expect(hub._state("pi_subagent_models")?.snapshot).toBe("OTHER");
    broken = false;
    expect(start().systemPrompt).toContain("OWN");
  });
  it("normal deletion uses removed tail then lawful stale refresh, not global reset", () => {
    const f = fixture();
    f.start();
    writeFileSync(join(f.memDir, "core.md"), "");
    f.start();
    // Empty file still has a layout header; real directory removal is tested
    // by deleting exactly our own file, not clearing other section states.
    rmSync(join(f.memDir, "core.md"));
    const removed = f.start();
    expect(removed?.systemPrompt).toContain("### core.md");
    expect(removed?.message?.content).toContain("no longer applies");
    f.invoke("model_select");
    const refreshed = f.start();
    expect(refreshed?.systemPrompt).not.toContain("### core.md");
    expect(refreshed?.systemPrompt).toContain("MODELS");
  });
  it("fresh input does not turn a project pointer latest source into a full winner", () => {
    const f = fixture();
    f.setSession(view("unrelated"));
    f.start();
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(f.memDir, "core.md"), `- update${i}${" ".repeat(i)}`);
      f.start();
    }
    expect(f.hub._state("pi_project_memory")?.announced).toBe(POINTED);
    f.setSession(view("- latest <!-- mem lesson -->", "agent"));
    writeFileSync(join(f.memDir, "core.md"), "- latest <!-- mem user -->");
    f.start();
    expect(f.hub._state("pi_session_memory")?.announced).not.toContain("dup of project");
  });
});
