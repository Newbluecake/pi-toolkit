/**
 * bash-timeout-grace plan §3.5 — real-`AgentSession` regression for the 真机验收 finding: the
 * `agent_before_settle` handler's old 检查 3 (`if (!event.context.canContinue) return undefined`)
 * read pi's PRE-injection entry context (`extensions/runner.js`'s `emitBoundary` first
 * `buildContext([])` call, before any handler ever runs), not the POST-commit `finalContext` pi
 * itself uses to validate a returned `continue:true` (`agent-session.js`'s
 * `_runBeforeSettleBoundary`: `_commitBoundaryDrafts(result.entries)` THEN
 * `_buildBoundaryContext([], "agent_before_settle")`). In the exact target scenario — a model
 * ending its turn with plain text, no queued/pending messages — pi's own `_buildBoundaryContext`
 * computes `canContinue: false` for that pre-injection context (`hasNonSystemContext &&
 * finalRole !== "assistant"` is false; no pending/queued messages either), so the old check 3
 * released EVERY TIME and the settle-hold (§3.5, U2) never fired in real use, despite passing
 * every existing test — none of which drove a REAL `AgentSession` boundary.
 *
 * This suite exercises the real, unmodified devDependency `AgentSession` (same harness style as
 * `tests/conformance/pi-boundary.test.ts` / `tests/integration/child-switch-runner.test.ts`), with
 * `wireChildBashJobs` as the extension under test — not a hand-rolled fake `event.context`. It
 * fails against the pre-fix code (checked manually: temporarily reinstating the old check 3 makes
 * every test below fail) and passes against `src/bash/child.ts` as fixed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { wireChildBashJobs } from "../../src/bash/child.js";
import { getChildBashRegistry, type HostRunView } from "../../src/bash/child-registry.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";

const posix = process.platform !== "win32";

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
  return {
    streamSimple: (_m: unknown, _context: unknown) => {
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: turn.toolCall ? "toolUse" : "stop", message: turn.build(model) });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
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
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function settingsWith(dir: string): AgentSettings {
  return { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir } };
}

async function withSession(
  opts: { scripted: ScriptedTurn[]; settings: AgentSettings },
  run: (env: {
    session: import("@earendil-works/pi-coding-agent").AgentSession;
    modelRuntime: ReturnType<typeof fakeModelRuntime>;
  }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-child-bash-real-session-"));
  dirs.push(cwd);
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [(pi: unknown) => wireChildBashJobs(pi as never, { settings: opts.settings })] as never,
  });
  await loader.reload();
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });
  try {
    await run({ session, modelRuntime });
  } finally {
    session.dispose();
  }
}

describe.skipIf(!posix)("real AgentSession: settle-hold survives a pure-text turn end (§3.5 fix regression)", () => {
  it(
    "model backgrounds a short job then ends the turn with plain text -> agent_before_settle STILL holds " +
      "(a real pi boundary computes context.canContinue:false here) -> the run continues for a further model " +
      "request -> the job finishes normally (never killed early) -> the NEXT settle releases the run",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-child-bash-real-jobs-"));
      dirs.push(dir);
      const settings = settingsWith(dir);

      await withSession(
        {
          settings,
          scripted: [
            // Turn 1: model backgrounds a short-lived job.
            {
              toolCall: true,
              build: (m) =>
                assistantToolCallMsg(m, "tc1", "bash", { command: "sleep 0.3 && true", run_in_background: true }),
            },
            // Turn 2: model ends the run with PLAIN TEXT — no tool call, no queued/pending
            // messages. This is exactly the scenario where pi's real `_buildBoundaryContext`
            // computes `canContinue: false` for the pre-injection entry context (the old,
            // now-deleted check 3 read exactly this value and always released here).
            { toolCall: false, build: (m) => assistantTextMsg(m, "background started, ending turn") },
            // Turn 3: only reached if the settle-hold actually asked for a further model
            // request (§3.5's `continue:true`) once the job finished.
            { toolCall: false, build: (m) => assistantTextMsg(m, "post-hold final answer") },
          ],
        },
        async ({ session, modelRuntime }) => {
          const sessionId = session.sessionManager.getSessionId();
          // Mirrors production wiring (src/stack.ts's `registry.attachHost`, done by the MAIN
          // session independently of any bash call): attach a host view up front so the
          // settle-hold hook has somewhere to read `watchdogDueAt`/`maxExtensions`/`stopping`
          // from. Defaults (no watchdog deadline) mean `hold` resolves to the 120s ceiling, but
          // the actual wait races the job's real exit (§3.5), so this test still completes fast.
          const hostView: HostRunView = {
            runId: `run-${sessionId}`,
            watchdogDueAt: () => undefined,
            hardDeadlineAt: () => undefined,
            maxExtensions: () => 3,
            stopping: () => false,
            noteToolReturn: () => undefined,
          };
          getChildBashRegistry().attachHost(sessionId, hostView);

          await session.prompt("please run a background task");

          // The run really continued for a THIRD model request — proof the settle-hold's
          // `continue:true` was honored by the real AgentSession, not silently discarded by the
          // old check 3 always seeing `canContinue:false` and releasing on turn 2.
          expect(modelRuntime.callCount()).toBe(3);

          const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
          const holdEntries = branch.filter((e) => e.customType === "bash-job:settle-hold");
          expect(holdEntries.length).toBeGreaterThan(0);
          // "finished ... exit 0" (not "killed") — the job was allowed to finish naturally
          // inside the hold instead of being reaped early when the run first tried to settle.
          const holdText = String((holdEntries[0] as { content?: unknown }).content ?? "");
          expect(holdText).toMatch(/finished/i);
          expect(holdText).toMatch(/exit 0/);

          // The run completed normally afterwards, with the model's real post-hold text.
          const lastMessage = branch[branch.length - 1];
          expect((lastMessage?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe(
            "post-hold final answer",
          );
        },
      );
    },
    15_000,
  );

  it("sanity: WITHOUT any non-terminal job, the same pure-text settle releases immediately (no spurious hold)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-child-bash-real-nojob-"));
    dirs.push(dir);
    const settings = settingsWith(dir);

    await withSession(
      {
        settings,
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "done, nothing backgrounded") }],
      },
      async ({ session, modelRuntime }) => {
        const sessionId = session.sessionManager.getSessionId();
        getChildBashRegistry().attachHost(sessionId, {
          runId: `run-${sessionId}`,
          watchdogDueAt: () => undefined,
          hardDeadlineAt: () => undefined,
          maxExtensions: () => 3,
          stopping: () => false,
          noteToolReturn: () => undefined,
        });

        await session.prompt("say hi");
        expect(modelRuntime.callCount()).toBe(1);
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        expect(branch.some((e) => e.customType === "bash-job:settle-hold")).toBe(false);
      },
    );
  }, 10_000);
});
