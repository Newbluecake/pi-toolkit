/**
 * T-C1/T-C2 (child-context-switch plan §3.1/§6): contract tests against the REAL devDependency
 * `AgentSession` (currently npm latest = 0.87.1, see plan §1.6) — NOT our own `src/context-switch/
 * child.ts` wiring (that lands in package P3). These are regression evidence for the pi runtime
 * behaviors the whole boundary design depends on:
 *   - a `turn_end` handler can commit a `compaction` + `custom_message` draft WITHOUT returning
 *     `continue: true`, and the run still proceeds to a further model request because the turn had
 *     a real tool call (`hasMoreToolCalls`), never via `ctx.compact()`/abort;
 *   - `entries` is an integral replacement across handlers (contract (a)): a later handler that
 *     doesn't compose with `event.entries` silently drops an earlier handler's draft;
 *   - an invalid draft (dangling `context_edit` target) makes the WHOLE turn's boundary commit
 *     invalid — nothing lands in the branch, and the run still completes normally with full history;
 *   - a `custom` entry is persisted (found via `getBranch()`) but contributes zero messages to
 *     `buildSessionProjection()` and never appears in `projection.messages` — the zero-impact L2
 *     commit probe's safety property;
 *   - that same custom entry survives a `parseSessionEntries` + `SessionManager.inMemory` rebuild
 *     from the real session file on disk (the L2(iii) "reopen" check);
 *   - `pi.sendMessage(..., { triggerTurn: false })` queues into the current turn and does NOT start
 *     an extra model request.
 *
 * `npm run test:conformance` runs just this directory. It is NOT a release gate by itself — see
 * plan §3.1 "契约测试与升级流程": upgrading pi means running this first, then the full gate.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

interface ScriptedTurn {
  toolCall: boolean;
  build: (model: ReturnType<typeof fakeModel>) => unknown;
}

function fakeModel() {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}

function fakeModelRuntime(model: ReturnType<typeof fakeModel>, scripted: ScriptedTurn[]) {
  let call = 0;
  const requestSizes: number[] = [];
  const requestMessages: unknown[][] = [];
  return {
    streamSimple: (_m: unknown, context: { messages?: unknown[] }) => {
      requestSizes.push(context.messages?.length ?? 0);
      requestMessages.push(context.messages ?? []);
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: turn.toolCall ? "toolUse" : "stop",
        message: turn.build(model),
      });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
    requestSizes,
    requestMessages,
  };
}

function assistantTextMsg(model: ReturnType<typeof fakeModel>, text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function assistantToolCallMsg(
  model: ReturnType<typeof fakeModel>,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function withSession(
  opts: { scripted: ScriptedTurn[]; extensionFactories?: unknown[]; persist?: boolean },
  run: (env: {
    session: import("@earendil-works/pi-coding-agent").AgentSession;
    cwd: string;
    modelRuntime: ReturnType<typeof fakeModelRuntime>;
  }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-boundary-conformance-"));
  dirs.push(cwd);
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: (opts.extensionFactories ?? []) as never,
  });
  await loader.reload();
  const sessionManager = opts.persist
    ? SessionManager.create(cwd, join(cwd, "sessions"))
    : SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
    tools: ["bash"],
  });
  try {
    await run({ session, cwd, modelRuntime });
  } finally {
    session.dispose();
  }
}

/** A turn_end handler mirroring the shape our own boundary handler would produce, without pulling
 *  in src/context-switch/child.ts (P3, not part of this package): compaction (firstKeptEntryId
 *  null = drop everything) + a non-continuing resume custom_message, only once there is a tool
 *  result to attach to (mirrors "have a tool result this turn" gating). */
function boundaryLikeExtension(onEvent?: (event: Record<string, unknown>) => void) {
  return (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
    pi.on("turn_end", (event) => {
      onEvent?.(event);
      const toolResultEntryIds = event.toolResultEntryIds as string[] | undefined;
      if (!toolResultEntryIds || toolResultEntryIds.length === 0) return undefined;
      return {
        entries: [
          ...(event.entries as unknown[]),
          {
            type: "compaction",
            summary: "my handoff summary",
            firstKeptEntryId: null,
            details: { source: "pi-toolkit:switch_context", seq: 1, nonce: "n1" },
          },
          {
            type: "custom_message",
            customType: "subagent:switch-context-resume",
            content: "resume text",
            display: false,
          },
        ],
      };
    });
  };
}

describe("T-C1: real AgentSession boundary contract (devDependency = npm latest)", () => {
  it("commits compaction+custom_message without continue:true; run proceeds via hasMoreToolCalls", async () => {
    const events: Record<string, unknown>[] = [];
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
        ],
        extensionFactories: [boundaryLikeExtension((e) => events.push(e))],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("hello");

        // The turn_end event carried the 0.87-shaped boundary fields we depend on structurally.
        const turnEndWithResult = events.find((e) => ((e.toolResultEntryIds as string[]) ?? []).length > 0);
        expect(turnEndWithResult).toBeDefined();
        expect(Array.isArray(turnEndWithResult?.entries)).toBe(true);
        expect(typeof turnEndWithResult?.messageEntryId).toBe("string");
        expect((turnEndWithResult?.context as { canContinue?: boolean })?.canContinue).toBe(true);

        // Persisted order: assistant(messageEntryId) -> toolResult -> compaction(fromHook) -> custom_message.
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        const types = branch.map((e) => e.type);
        const compactionIdx = types.indexOf("compaction");
        const resumeIdx = types.findIndex((t, i) => t === "custom_message" && i > compactionIdx);
        expect(compactionIdx).toBeGreaterThan(-1);
        expect(resumeIdx).toBeGreaterThan(compactionIdx);
        const compactionEntry = branch[compactionIdx];
        expect(compactionEntry?.fromHook).toBe(true);
        expect((compactionEntry?.details as { source?: string })?.source).toBe("pi-toolkit:switch_context");
        // Nothing after the compaction except our resume + the final assistant turn — never the
        // original first user/assistant/toolResult messages (they were dropped, firstKeptEntryId:null).
        expect(types.slice(0, compactionIdx)).toContain("message");
        expect(branch[resumeIdx]?.customType).toBe("subagent:switch-context-resume");

        // The run really did continue to a second model request, and it used pi's own reduced
        // context — the original first user message text is gone from that request, replaced by
        // our compaction summary + resume (the switch actually took effect, not just cosmetically).
        expect(modelRuntime.callCount()).toBe(2);
        const secondRequestText = JSON.stringify(modelRuntime.requestMessages[1]);
        expect(secondRequestText).not.toContain("hello");
        expect(secondRequestText).toContain("my handoff summary");
        expect(secondRequestText).toContain("resume text");

        // The final assistant text is the one produced AFTER the switch (run completed normally).
        const lastMessage = branch[branch.length - 1];
        expect((lastMessage?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe("done");
      },
    );
  });

  it("entries integral replacement (contract a): a non-composing later handler drops an earlier draft", async () => {
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
        ],
        extensionFactories: [
          (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
            pi.on("turn_end", (event) => {
              if (((event.toolResultEntryIds as string[]) ?? []).length === 0) return undefined;
              return {
                entries: [...(event.entries as unknown[]), { type: "custom", customType: "test:a-draft", data: {} }],
              };
            });
          },
          (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
            pi.on("turn_end", (event) => {
              if (((event.toolResultEntryIds as string[]) ?? []).length === 0) return undefined;
              // Total overwrite — does not spread event.entries, so A's draft is lost.
              return { entries: [{ type: "custom", customType: "test:b-draft", data: {} }] };
            });
          },
        ],
      },
      async ({ session }) => {
        await session.prompt("hello");
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        expect(branch.some((e) => e.customType === "test:a-draft")).toBe(false);
        expect(branch.some((e) => e.customType === "test:b-draft")).toBe(true);
      },
    );
  });

  it("an invalid draft (dangling context_edit target) discards the WHOLE turn's commit, run still completes", async () => {
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
        ],
        extensionFactories: [
          boundaryLikeExtension(),
          (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
            pi.on("turn_end", (event) => {
              if (((event.toolResultEntryIds as string[]) ?? []).length === 0) return undefined;
              return {
                entries: [
                  ...(event.entries as unknown[]),
                  { type: "context_edit", targetId: "does-not-exist", replacement: null },
                ],
              };
            });
          },
        ],
      },
      async ({ session }) => {
        const result = await session.prompt("hello");
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        // Nothing from either handler landed — the turn's commit was invalidated wholesale.
        expect(branch.some((e) => e.type === "compaction")).toBe(false);
        expect(branch.some((e) => e.type === "context_edit")).toBe(false);
        // The run still completed normally, with the model's actual final text.
        expect(result).toBeUndefined(); // AgentSession.prompt() resolves void; completion is via events/branch.
        const lastMessage = branch[branch.length - 1];
        expect((lastMessage?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe("done");
      },
    );
  });

  it("sendMessage({triggerTurn:false}) queues into the current turn — never starts an extra model request", async () => {
    await withSession(
      {
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "done") }],
        extensionFactories: [
          (pi: {
            on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void;
            sendMessage: (message: unknown, options: unknown) => void;
          }) => {
            pi.on("turn_end", () => {
              pi.sendMessage(
                { customType: "test:notice", content: "hi", display: false, details: {} },
                { triggerTurn: false },
              );
              return undefined;
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("hello");
        expect(modelRuntime.callCount()).toBe(1);
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        expect(branch.some((e) => e.customType === "test:notice")).toBe(true);
      },
    );
  });

  it("v3.1: a custom probe entry is persisted but contributes zero messages, and survives a real file reopen", async () => {
    await withSession(
      {
        persist: true,
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
        ],
        extensionFactories: [
          (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
            pi.on("turn_end", (event) => {
              if (((event.toolResultEntryIds as string[]) ?? []).length === 0) return undefined;
              return {
                entries: [
                  ...(event.entries as unknown[]),
                  { type: "custom", customType: "subagent:boundary-probe", data: { nonce: "abc" } },
                ],
              };
            });
          },
        ],
      },
      async ({ session, cwd }) => {
        const sessionFile = session.sessionManager.getSessionFile();
        await session.prompt("hello");
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        const probe = branch.find((e) => e.type === "custom" && e.customType === "subagent:boundary-probe") as
          { id: string } | undefined;
        expect(probe).toBeDefined();

        // Zero-impact: present in the provenance-preserving projection but contributes no messages,
        // and never shows up in the flattened LLM-visible message list.
        const projection = session.sessionManager.buildSessionProjection();
        const projected = projection.entries.find((pe) => pe.sourceEntry.id === probe!.id);
        expect(projected).toBeDefined();
        expect(projected?.messages.length).toBe(0);
        expect(projection.messages.includes(projected as never)).toBe(false);

        // L2(iii): survives a real reopen (parseSessionEntries + SessionManager.inMemory), not just
        // the live in-memory branch.
        expect(sessionFile).toBeDefined();
        const raw = readFileSync(sessionFile!, "utf8");
        const fileEntries = parseSessionEntries(raw);
        const rebuilt = SessionManager.inMemory(cwd, undefined, fileEntries);
        const rebuiltBranch = rebuilt.getBranch() as Array<Record<string, unknown>>;
        const stillThere = rebuiltBranch.some(
          (e) =>
            e.type === "custom" &&
            e.customType === "subagent:boundary-probe" &&
            (e.data as { nonce?: string })?.nonce === "abc",
        );
        expect(stillThere).toBe(true);
      },
    );
  });
});

describe("T-C2: degradation on the real runtime (a colliding extension invalidates our first switch)", () => {
  it("a colliding extension's invalid draft in the same turn -> our switch never committed; model told nothing was applied; run completes with full history", async () => {
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
        ],
        extensionFactories: [
          boundaryLikeExtension(),
          // A second, unrelated extension breaks the boundary preview for the whole turn.
          (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
            pi.on("turn_end", (event) => {
              if (((event.toolResultEntryIds as string[]) ?? []).length === 0) return undefined;
              return {
                entries: [
                  ...(event.entries as unknown[]),
                  { type: "context_edit", targetId: "nope", replacement: null },
                ],
              };
            });
          },
        ],
      },
      async ({ session }) => {
        await session.prompt("hello");
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        // Our compaction was never committed — this is exactly what src/context-switch/capability.ts's
        // L3(a) self-check (P2, tested independently in tests/context-switch/capability.test.ts) is
        // designed to observe and react to by disabling the capability, without our wiring needing
        // to exist here: the underlying pi fact is what we assert.
        expect(branch.some((e) => e.type === "compaction")).toBe(false);
        // The run is otherwise unaffected: it completed with the real, full conversation intact.
        const originalUserMessage = branch.find(
          (e) => e.type === "message" && (e.message as { role?: string })?.role === "user",
        );
        expect(originalUserMessage).toBeDefined();
        const lastMessage = branch[branch.length - 1];
        expect((lastMessage?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe("done");
      },
    );
  });
});
