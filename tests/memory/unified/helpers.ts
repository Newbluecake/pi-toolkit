import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SessionManager, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import { createOpApprovalPort } from "../../../src/memory/scopes/authorize.js";
import { createHubMemoryProvider } from "../../../src/memory/scopes/hub-store.js";
import { createScopedMemoryTool } from "../../../src/memory/scopes/tool.js";
import type { MemoryOwner } from "../../../src/memory/scopes/types.js";
import { createMemoryToolV3, createProjectInspectorV4 } from "../../../src/memory/tool-v3.js";
import { createMemoryToolV4 } from "../../../src/memory/unified/tool.js";
import type { MemoryV4Params } from "../../../src/memory/unified/types.js";
import { fakePi } from "../../integration/helpers/schedule-activate.js";

export const STAMP = "2026-11-09T08:00:00.000Z";
export function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) visit(name);
      else result[relative(dir, name)] = readFileSync(name).toString("base64");
    }
  }
  visit(dir);
  return result;
}
export function harness(
  options: { child?: boolean; scopesOn?: boolean; active?: boolean; registered?: boolean; allowChild?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "memory-v4-"));
  const child = options.child ?? false;
  const scopesOn = options.scopesOn ?? true;
  const manager = SessionManager.inMemory(dir);
  const owner: MemoryOwner = { incarnation: {}, sid: manager.getSessionId(), sessionEpoch: 1, branchGen: 1 };
  const abort = new AbortController();
  let branchError: Error | undefined;
  let fileError: Error | undefined;
  let leafError: Error | undefined;
  let failAppend = false;
  const tracker = createHumanTurnTracker();
  const caps = createMemoryOpCapRegistry(() => tracker.current());
  const getBranch = vi.fn(() => {
    if (branchError) throw branchError;
    return manager.getBranch();
  });
  const append = vi.fn((type: string, data: unknown) => {
    if (failAppend) throw new Error("append failed");
    manager.appendCustomEntry(type, data);
  });
  const session = createSessionMemoryStore({
    currentOwner: () => owner,
    getBranch,
    getSessionId: () => owner.sid,
    getSessionFile: () => {
      if (fileError) throw fileError;
      return manager.getSessionFile();
    },
    getLeafId: () => {
      if (leafError) throw leafError;
      return manager.getLeafId() ?? undefined;
    },
    getManager: () => manager,
    isLocked: () => false,
    appendCustomEntry: append,
    isChildSession: child,
    now: () => STAMP,
    caps,
    sessionWriteGate: { check: () => ({ ok: true }) },
    poisonRegistry: createSessionPoisonRegistry(),
  });
  const select = vi.fn(async (_title: string, choices: readonly string[]) => choices[1]);
  const approval = createOpApprovalPort({ tracker, registry: caps, select });
  const hub = createHubMemoryProvider({
    capability: () => "ok",
    registry: caps,
    owner: () => owner,
    slot: () => ({ effectiveStateDir: join(dir, "hub-state"), uid: process.getuid?.() ?? 0, source: "default-slot" }),
    gate: { check: () => ({ ok: true }) },
    isChildSession: () => child,
    now: () => new Date(STAMP),
  });
  const scopedDeps = {
    enabled: { session: true, hub: true },
    child,
    capability: () => "ok" as const,
    currentOwner: () => owner,
    session,
    hub,
    signal: () => abort.signal,
    sharedApproval: approval,
    caps,
    humanTurn: () => tracker.current(),
    projectLabel: () => "test-project",
  };
  const registration = { active: options.active ?? false, registered: options.registered ?? false };
  const alias = createScopedMemoryTool(scopedDeps, { v4Registration: () => registration });
  const originalAlias = createScopedMemoryTool(scopedDeps);
  const projectDeps = {
    settings: {
      ...DEFAULT_MEMORY_SETTINGS,
      allowWriteInChildSessions: options.allowChild ?? false,
      jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
      governance: { ...DEFAULT_MEMORY_SETTINGS.governance, enabled: false },
    },
    isChildSession: child,
    onAfterWrite: vi.fn(),
    paths: { memoryRoot: join(dir, "project"), ccProjectsRoot: join(dir, "cc") },
  };
  const ctx = { cwd: dir } as ExtensionToolContext;
  const v3 = createMemoryToolV3(projectDeps);
  const projectRun = vi.fn(
    (id: string, params: MemoryV4Params, signal: AbortSignal | undefined, context: ExtensionToolContext) =>
      v3.execute(id, params, signal, undefined, context),
  );
  const projectInspect = vi.fn(createProjectInspectorV4(projectDeps));
  const currentScoped = vi.fn(() => alias);
  const v4 = createMemoryToolV4({
    project: { run: projectRun, inspect: projectInspect },
    currentScoped,
    child,
    scopesOn,
  });
  const f = fakePi();
  // A real v4 ToolDefinition can be registered without a pi dependency in unified/.
  f.pi.registerTool(v4 satisfies ToolDefinition);
  f.pi.registerTool(alias);
  const call = (params: object) => v4.run("v4-test", params, undefined, ctx);
  const registeredCall = async (params: object) => {
    const result = await (f.tools.get("memory") as ToolDefinition).execute(
      "v4-test",
      params,
      undefined,
      undefined,
      ctx,
    );
    return JSON.parse(result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
  };
  return {
    dir,
    owner,
    manager,
    session,
    hub,
    alias,
    originalAlias,
    v3,
    v4,
    ctx,
    projectDeps,
    call,
    registeredCall,
    registration,
    select,
    tracker,
    caps,
    append,
    projectRun,
    projectInspect,
    currentScoped,
    getBranch,
    scopedDeps,
    human: () => tracker.noteInteractive(owner),
    breakBranch: (error: Error | undefined) => {
      branchError = error;
    },
    breakFile: (error: Error | undefined) => {
      fileError = error;
    },
    breakLeaf: (error: Error | undefined) => {
      leafError = error;
    },
    failAppend: () => {
      failAppend = true;
    },
    close: () => {
      abort.abort();
      session.dispose();
      hub.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
