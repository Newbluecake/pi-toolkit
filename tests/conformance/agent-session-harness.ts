/**
 * Shared real-`AgentSession` harness for the conformance tests (todo-archive plan §3): the
 * `fakeModel` / `fakeModelRuntime` / `withSession` triple moved VERBATIM out of
 * `pi-boundary.test.ts` so later conformance suites (todo-archive) reuse the exact same scripted
 * model + extensionFactories + SessionManager plumbing instead of growing a second harness.
 *
 * Two opt-in knobs exist beyond the verbatim base (both default to the original behavior):
 *  - `tools`: the createAgentSession allowlist (pi-boundary keeps ["bash"]);
 *  - `compaction.keepRecentTokens`: pre-writes `{"compaction":{"keepRecentTokens":N}}` into the
 *    temp agentDir's settings.json BEFORE SettingsManager.create. pi's default is 20000, which
 *    makes prepareCompaction return undefined for these tiny scripted sessions ("Nothing to
 *    compact") — a small budget guarantees first AND second compact() find a summarizable range
 *    (todo-archive plan §8 ruling).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface ScriptedTurn {
  toolCall: boolean;
  build: (model: ReturnType<typeof fakeModel>) => unknown;
}

export function fakeModel() {
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

export function fakeModelRuntime(model: ReturnType<typeof fakeModel>, scripted: ScriptedTurn[]) {
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

export function assistantTextMsg(model: ReturnType<typeof fakeModel>, text: string) {
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

export function assistantToolCallMsg(
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

/** Test files call this from afterEach (the harness file itself cannot register hooks). */
export function disposeHarnessDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function withSession(
  opts: {
    scripted: ScriptedTurn[];
    extensionFactories?: unknown[];
    persist?: boolean;
    tools?: string[];
    /** Optional compaction budget override; omitted ⇒ pi defaults (keepRecentTokens=20000). */
    compaction?: { keepRecentTokens: number };
  },
  run: (env: {
    session: import("@earendil-works/pi-coding-agent").AgentSession;
    cwd: string;
    modelRuntime: ReturnType<typeof fakeModelRuntime>;
  }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-boundary-conformance-"));
  dirs.push(cwd);
  const agentDir = join(cwd, ".pi-agent");
  if (opts.compaction) {
    // Must exist BEFORE SettingsManager.create reads it (todo-archive plan §8).
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: opts.compaction.keepRecentTokens } }),
    );
  }
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
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
    tools: opts.tools ?? ["bash"],
  });
  try {
    await run({ session, cwd, modelRuntime });
  } finally {
    session.dispose();
  }
}
