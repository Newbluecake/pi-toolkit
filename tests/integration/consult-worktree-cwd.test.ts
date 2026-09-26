import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "./helpers/home-sandbox.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeConfig, AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { ConsultExpertRef } from "../../src/core/types.js";
import { buildSessionStack } from "../../src/stack.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import type { SessionHandle } from "../../src/runtime/session-driver.js";
import { createWorktreeExtension, type ExecResult, type WorktreeExec } from "../../src/extensions/worktree.js";

/**
 * D10 (docs/dev/workflow-worktree/plan.md §2, plan §6 test #12): an
 * isolated asker's consult (fork header cwd AND spawn request cwd) always
 * runs in the ASKER's own worktree — never touching the EXPERT's original
 * (or since-deleted) checkout via the two-level `resolveForkCwd` rule.
 *
 * Real `SpawnService` + `RuntimeRunner` + real `createWorktreeExtension`
 * (fake exec that only fabricates the ONE directory `git worktree add`
 * would have created — no real git binary, no real commits) + real
 * `wireConsult`/fork-store operating on real tmp files. Only
 * `PiSessionDriver.create/resume/bind` are faked, matching the established
 * `tests/integration/consult.test.ts` / `consult-wiring.test.ts` harness.
 */

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
const tempDirs: string[] = [];
const parentGates: Array<() => void> = [];

beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  for (const release of parentGates.splice(0)) release();
  vi.restoreAllMocks();
  homeSandbox?.restore();
  homeSandbox = undefined;
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function tempDir(prefix = "consult-wt-cwd-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function budget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 300,
    startupMs: 300,
    bindMs: 300,
    firstEventMs: 200,
    idleMs: 1_000,
    modelTurnMs: 1_000,
    toolMs: 1_000,
    totalMs: 3_000,
    totalGraceMs: 0,
    abortGraceMs: 50,
    steerMs: 20,
    reapMs: 100,
    retrySlackMs: 20,
  };
}

type Entry = { type: string; customType?: string; data?: unknown };

function harness(entries: Entry[] = []) {
  const appended: Entry[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      appended.push(entry);
    },
    sendMessage() {},
    registerEntryRenderer() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: { on: () => () => undefined, emit: () => undefined },
    setModel: () => undefined,
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "consult-wt-cwd" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    hasUI: false,
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
  return { pi, ctx, appended };
}

const dispatcherType: AgentTypeConfig = {
  name: "dispatcher",
  description: "dispatches",
  systemPrompt: "You dispatch.",
  promptMode: "append",
};
const expertType: AgentTypeConfig = {
  name: "explorer",
  description: "explores",
  systemPrompt: "You explore.",
  promptMode: "append",
};
const types = {
  get: (name: string) => (name === "dispatcher" ? dispatcherType : name === "explorer" ? expertType : undefined),
  list: () => [dispatcherType, expertType],
  reload: async () => ({ types: [dispatcherType, expertType], errors: [] }),
} as unknown as AgentTypeRegistry;

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    budget: budget(),
    fleetWidget: false,
    fabric: { ...DEFAULT_SETTINGS.fabric, enabled: false },
    workflow: { ...DEFAULT_SETTINGS.workflow, enabled: false },
    quota: { ...DEFAULT_SETTINGS.quota, enabled: false },
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false, adaptiveEnabled: false },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    consult: { ...DEFAULT_SETTINGS.consult, enabled: true, timeoutMs: 5_000 },
    ...overrides,
  };
}

/**
 * Fake `git` for `createWorktreeExtension` — no real git binary. `rev-parse
 * --show-toplevel` reports the given repo path; `worktree add --detach
 * <path>` fabricates exactly the one directory H2 would have created (real
 * fs, so a later `existsSync`/two-level `resolveForkCwd` check behaves like
 * production). Every other git subcommand (status/switch/add/commit/
 * remove — H3, never reached by these tests since the asker run never
 * settles within the test) trivially succeeds.
 */
function fakeGitExec(repo: string): WorktreeExec {
  return async (cmd, args): Promise<ExecResult> => {
    if (cmd !== "git") return { code: 1, stdout: "", stderr: `unexpected command ${cmd}` };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: `${repo}\n`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const path = args[args.length - 1]!;
      mkdirSync(path, { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** A hand-written, minimally-valid expert session (header + one message) at a chosen header cwd. */
function expertSessionAt(dir: string, headerCwd: string, id: string): string {
  const file = join(dir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: headerCwd };
  const message = { type: "message", id: "m1", parentId: null, timestamp: "t", message: { role: "assistant" } };
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  return file;
}

function readHeader(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as Record<string, unknown>;
}

type SpecLike = { customTools?: unknown[]; cwd?: string; forkSessionFrom?: string };
interface DriverCall {
  kind: "create" | "resume";
  file?: string;
  spec: SpecLike;
}

function spyOnDriver(
  opts: {
    onResume?: (file: string, spec: SpecLike) => SessionHandle | Promise<SessionHandle>;
  } = {},
): { calls: DriverCall[] } {
  const calls: DriverCall[] = [];
  const fakeHandle = (overrides: Partial<SessionHandle> = {}): SessionHandle => ({
    sessionId: "s",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  });
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async (spec) => {
    const s = spec as SpecLike;
    calls.push({ kind: "create", spec: s });
    // The dispatcher's own turn stays open until the test releases it — a
    // real consult() call happens inside the asker's own tool call, and
    // fork admission rejects an asker that is stopping or gone.
    const gate = new Promise<void>((resolve) => parentGates.push(resolve));
    return fakeHandle({ prompt: () => gate }) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async (file, spec) => {
    const s = spec as SpecLike;
    calls.push({ kind: "resume", file, spec: s });
    return ((await opts.onResume?.(file, s)) ?? fakeHandle({ sessionFile: file })) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
  return { calls };
}

async function waitUntil(pred: () => boolean, timeoutMs = 3_000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

interface ConsultToolLike {
  name: string;
  execute(
    toolCallId: string,
    params: { expert: string; question: string },
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown>; usage?: unknown }>;
}
function findConsultTool(spec: SpecLike): ConsultToolLike {
  const tool = (spec.customTools ?? []).find((t) => (t as { name?: string }).name === "consult");
  if (!tool) throw new Error("consult tool was not injected");
  return tool as ConsultToolLike;
}

/** Spawns an isolated ("worktree") dispatcher and returns its consult tool + the worktree cwd H2 gave it. */
async function spawnIsolatedAsker(
  stack: ReturnType<typeof buildSessionStack>,
  repo: string,
  calls: DriverCall[],
  expertRef: ConsultExpertRef,
) {
  const spawned = await stack.spawn.spawn({
    type: "dispatcher",
    prompt: "consult the expert from my own worktree",
    cwd: repo,
    isolation: "worktree",
    consultExperts: [expertRef],
  });
  if ("error" in spawned) throw new Error(spawned.error.message);
  await waitUntil(() => calls.some((c) => c.kind === "create"));
  const createSpec = calls.find((c) => c.kind === "create")!.spec;
  const askerCwd = createSpec.cwd;
  expect(askerCwd).toBeDefined();
  expect(askerCwd).not.toBe(repo); // H2 actually rewrote it to a worktree path
  return { tool: findConsultTool(createSpec), askerCwd: askerCwd! };
}

describe("consult integration: isolated asker's consult runs in ITS OWN worktree (D10, test #12)", () => {
  const scenarios: Array<{ name: string; headerCwd: (opts: { worktreeRoot: string }) => string }> = [
    // Unisolated expert: an ordinary, still-existing checkout.
    { name: "unisolated expert (ordinary checkout)", headerCwd: () => tempDir("consult-wt-cwd-expert-plain-") },
    // Isolated & committed: the expert's own worktree was removed after H3
    // committed its changes — the header cwd no longer exists on disk.
    {
      name: "isolated & committed expert (header cwd gone)",
      headerCwd: ({ worktreeRoot }) => join(worktreeRoot, "expert-committed-gone"),
    },
    // Isolated & kept: the expert's worktree is still on disk (H3 could not
    // commit, so it was preserved) — header cwd DOES exist.
    {
      name: "isolated & kept expert (header cwd still exists)",
      headerCwd: ({ worktreeRoot }) => {
        const p = join(worktreeRoot, "expert-kept");
        mkdirSync(p, { recursive: true });
        return p;
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`fork header cwd AND spawn cwd are the asker's worktree, regardless of the expert's state: ${scenario.name}`, async () => {
      const repo = tempDir("consult-wt-cwd-repo-");
      const worktreeRoot = tempDir("consult-wt-cwd-root-");
      const worktreeExt = createWorktreeExtension({
        exec: fakeGitExec(repo),
        settings: { enabled: true },
        worktreeRoot,
      });
      const expertDir = tempDir("consult-wt-cwd-expertdir-");
      const expertHeaderCwd = scenario.headerCwd({ worktreeRoot });
      const expertFile = expertSessionAt(expertDir, expertHeaderCwd, "s_expert");
      const expertRef: ConsultExpertRef = { runId: "r_EXPERT1", sessionFile: expertFile, agentType: "explorer" };

      const { calls } = spyOnDriver({
        onResume: async (file) => ({
          sessionId: "consult-run",
          sessionFile: file,
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          requestAbort: () => Promise.resolve(),
          dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
          killableHandles: new Set(),
          setActiveTools: () => undefined,
          getActiveTools: () => [],
          getLastAssistantText: () => "the isolated asker's answer",
          getUsage: () => undefined,
        }),
      });
      const h = harness();
      const stack = buildSessionStack(h.pi, h.ctx, settings(), types, [worktreeExt]);

      const { tool, askerCwd } = await spawnIsolatedAsker(stack, repo, calls, expertRef);
      const result = await tool.execute("call-1", { expert: "r_EXPERT1", question: "what cwd am I forked into?" });
      expect(result.details.outcome).toBe("completed");

      const resumeCall = calls.find((c) => c.kind === "resume");
      expect(resumeCall).toBeDefined();
      // spawn cwd: the driver's resume() spec carries the SAME cwd H2 gave
      // the asker — never the expert's header cwd, whatever state it is in.
      expect(resumeCall!.spec.cwd).toBe(askerCwd);
      expect(resumeCall!.spec.cwd).not.toBe(expertHeaderCwd);
      // fork header cwd: forced to the asker's worktree (forceCwd:true) —
      // resolveForkCwd's two-level rule against the expert's header is
      // never consulted at all.
      const forkPath = resumeCall!.spec.forkSessionFrom!;
      expect(forkPath).toBeDefined();
      const forkHeader = readHeader(forkPath);
      expect(forkHeader["cwd"]).toBe(resolvePath(askerCwd));
      expect(forkHeader["cwd"]).not.toBe(resolvePath(expertHeaderCwd));

      await waitUntil(() => !existsSync(forkPath));
    });
  }
});

describe("consult integration: unisolated top-level asker regression (D10)", () => {
  it("an UNISOLATED asker's consult cwd is unaffected by D10 — the pre-existing two-level rule against the expert's header cwd still applies", async () => {
    const repo = tempDir("consult-wt-cwd-repo-plain-");
    const expertDir = tempDir("consult-wt-cwd-expertdir-plain-");
    const expertHeaderCwd = tempDir("consult-wt-cwd-expert-home-");
    const expertFile = expertSessionAt(expertDir, expertHeaderCwd, "s_expert_plain");
    const expertRef: ConsultExpertRef = { runId: "r_EXPERT2", sessionFile: expertFile, agentType: "explorer" };

    const { calls } = spyOnDriver({
      onResume: async (file) => ({
        sessionId: "consult-run",
        sessionFile: file,
        prompt: () => Promise.resolve(),
        steer: () => Promise.resolve(),
        requestAbort: () => Promise.resolve(),
        dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
        killableHandles: new Set(),
        setActiveTools: () => undefined,
        getActiveTools: () => [],
        getLastAssistantText: () => "unisolated answer",
        getUsage: () => undefined,
      }),
    });
    const h = harness();
    // NO worktree extension at all — this asker never requests isolation.
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, []);
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult the expert from my ordinary checkout",
      cwd: repo,
      consultExperts: [expertRef],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await waitUntil(() => calls.some((c) => c.kind === "create"));
    const createSpec = calls.find((c) => c.kind === "create")!.spec;
    expect(createSpec.cwd).toBe(repo); // no H2 ever touched it

    const tool = findConsultTool(createSpec);
    const result = await tool.execute("call-1", { expert: "r_EXPERT2", question: "where do you run?" });
    expect(result.details.outcome).toBe("completed");

    const resumeCall = calls.find((c) => c.kind === "resume")!;
    // Pre-D10 baseline: the expert's own (still-existing) header cwd wins
    // over the asker's checkout — two-level resolution, unchanged.
    expect(resumeCall.spec.cwd).toBe(resolvePath(expertHeaderCwd));
    const forkHeader = readHeader(resumeCall.spec.forkSessionFrom!);
    expect(forkHeader["cwd"]).toBe(resolvePath(expertHeaderCwd));

    await waitUntil(() => !existsSync(resumeCall.spec.forkSessionFrom!));
  });
});
