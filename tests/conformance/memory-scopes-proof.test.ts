/** P3b real SDK + production source factory. Local scripted runtime, own HOME/agentDir,
 * no auth/network/model calls. This is not P4/root assembly or a live TUI viewport test.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createHumanDispatchProof,
  createHumanDispatchHookOwner,
  createHumanOpApproval,
} from "../../src/web-hub/agent/human-dispatch-proof.js";
import { createDialogBridge } from "../../src/web-hub/agent/dialogs.js";
import { createCommandHandler } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../src/memory/scopes/op-cap.js";
import { createHubMemoryProvider } from "../../src/memory/scopes/hub-store.js";
import { createEffectiveHubSlotPort } from "../../src/web-hub/agent/effective-paths.js";
import { scopedOpDigest, bodyTextDigest } from "../../src/memory/scopes/limits.js";
import type { MemoryOwner, OpApprovalResult, HumanTurn } from "../../src/memory/scopes/types.js";
import type { CmdOrigin, CmdFrame } from "../../src/web-hub/protocol/messages.js";

const browser: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "proof-browser" };
async function fixture(run: (f: Awaited<ReturnType<typeof build>>) => Promise<void>, mode: "tui" | "rpc" = "tui") {
  const f = await build(mode);
  try {
    await run(f);
  } finally {
    f.release();
    f.handler.dispose();
    f.proof.dispose();
    f.approval.dispose();
    f.dialogs.dispose();
    f.provider.dispose();
    f.session.dispose();
    rmSync(f.root, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, Symbol.for("pi-subagent:web-hub:cmd-ledger"));
    vi.unstubAllEnvs();
  }
}
async function build(mode: "tui" | "rpc") {
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagent:web-hub:cmd-ledger"));
  const root = mkdtempSync(join(tmpdir(), "memory39-proof-"));
  vi.stubEnv("HOME", root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const sm = SessionManager.create(root, join(root, "sessions"));
  const settings = SettingsManager.create(root, agentDir);
  let ctx: ExtensionContext, api: ExtensionAPI;
  let owner: MemoryOwner = { incarnation: {}, sid: sm.getSessionId(), sessionEpoch: 1, branchGen: 1 };
  const tracker = createHumanTurnTracker(() => registry?.revoke());
  const registry = createMemoryOpCapRegistry(() => tracker.current());
  const proof = createHumanDispatchProof({ owner: () => owner, context: () => ctx, tracker, enabled: () => true });
  const wire = createHumanDispatchHookOwner(proof);
  const dialogs = createDialogBridge({ enabled: true, epoch: "p3b", isAttached: () => true });
  const approval = createHumanOpApproval({ tracker, registry, context: () => ctx, remote: dialogs });
  const slot = createEffectiveHubSlotPort({
    enabled: true,
    domain: "plain",
    paths: () => ({
      paths: { stateDir: join(root, "state") },
      env: {},
      getuid: () => process.getuid?.() ?? 0,
    }),
  })!;
  const provider = createHubMemoryProvider({
    capability: () => "ok",
    registry,
    owner: () => owner,
    slot: () => slot.resolve(),
  });
  const writes: unknown[] = [];
  const starts: Array<{ type: string; turn: HumanTurn | undefined; idle: boolean }> = [];
  const ingresses: Array<{ mode: string; source: string; idle: boolean; pending: boolean }> = [];
  const outcomes: OpApprovalResult[] = [],
    receipts: unknown[] = [],
    requests: unknown[] = [];
  let behavior = "continue",
    hold = false,
    askTool = false;
  let finish: (() => void) | undefined;
  let afterInput: (() => void) | undefined;
  let atSettled: (() => void) | undefined;
  let auth = true;
  const model = {
    id: "local",
    name: "local",
    api: "anthropic-messages",
    provider: "local",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
  const operation = Object.freeze({
    storageScope: "hub" as const,
    authority: "user" as const,
    op: "create" as const,
    topic: "rule",
    text: "Full raw body\n第二行 exact",
  });
  const runtime = {
    streamSimple(_m: unknown, context: unknown, options?: { signal?: AbortSignal }) {
      requests.push(context);
      const stream = createAssistantMessageEventStream();
      const tool = askTool;
      askTool = false;
      const done = () =>
        stream.push({
          type: "done",
          reason: tool ? "toolUse" : "stop",
          message: {
            role: "assistant",
            content: tool
              ? [{ type: "toolCall", id: "actual-sdk-tool-call", name: "memory_probe", arguments: {} }]
              : [{ type: "text", text: "local answer" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: tool ? "toolUse" : "stop",
            timestamp: Date.now(),
          },
        } as never);
      if (hold) {
        hold = false;
        finish = done;
        options?.signal?.addEventListener("abort", done, { once: true });
      } else done();
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => auth,
    checkAuth: async () => (auth ? { ok: true } : undefined),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
  };
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Local source proof fixture.",
    extensionFactories: [
      (pi: ExtensionAPI) => {
        api = pi;
        pi.on("session_start", (_e, context) => {
          ctx = context;
        });
        // Secure-first equivalent; record actual public gate before any transform/reentry.
        pi.on("input", (event, context) => {
          ctx = context;
          ingresses.push({
            mode: context.mode,
            source: event.source,
            idle: context.isIdle(),
            pending: context.hasPendingMessages(),
          });
          return { action: "continue" };
        });
        wire(pi);
        wire(pi); // same owner helper must not double-sign/register
        pi.on("input", async (event) => {
          await Promise.resolve();
          afterInput?.();
          if (behavior === "handled") return { action: "handled" };
          if (behavior === "transform") return { action: "transform", text: `${event.text} transformed` };
          if (behavior === "throw") throw new Error("nonfatal input error");
          if (behavior === "nested") {
            behavior = "continue";
            await session.sendUserMessage("same text");
          }
          if (behavior === "custom") {
            behavior = "continue";
            await session.sendCustomMessage(
              { customType: "machine", content: "same text", display: false },
              { triggerTurn: true },
            );
          }
          return { action: "continue" };
        });
        pi.on("agent_settled", () => {
          const callback = atSettled;
          atSettled = undefined;
          callback?.();
        });
        pi.on("before_agent_start", (event, context) => {
          starts.push({ type: event.messageType, turn: tracker.current(), idle: context.isIdle() });
        });
        pi.registerTool({
          name: "memory_probe",
          label: "memory_probe",
          description: "Local proof approval probe",
          parameters: Type.Object({}),
          async execute(toolCallId) {
            const turn = tracker.current();
            const pending = approval.request({
              operation,
              binding: {
                owner,
                humanTurn: turn as HumanTurn,
                toolCallId,
                nonce: "a".repeat(32),
                opDigest: scopedOpDigest(operation)!,
                textDigest: bodyTextDigest(operation.text),
              },
              projectLabel: "own fixture",
            });
            const dialog = dialogs.frame().open[0];
            if (dialog) {
              expect(dialog.questions[0]?.question).toContain(operation.text);
              receipts.push(
                dialogs.handle({
                  t: "cmd",
                  rid: "reply",
                  id: "answer",
                  deadlineMs: 8000,
                  origin: browser,
                  cmd: {
                    op: "dialog_answer",
                    dialogId: dialog.dialogId,
                    epoch: "p3b",
                    answers: [{ selected: [dialog.questions[0]!.options[1]!.label], other: null }],
                  },
                } as CmdFrame),
              );
            }
            const outcome = await pending;
            outcomes.push(outcome);
            if (outcome.approved) {
              const reserved = registry.reserve(outcome.cap, owner);
              expect(reserved?.binding.toolCallId).toBe("actual-sdk-tool-call");
              expect(reserved?.operation).toEqual(operation);
              const result = await provider.enqueue({ operation, owner, cap: outcome.cap });
              writes.push(result);
              expect(result.ok).toBe(true);
              expect(registry.consume(outcome.cap)).toBe(false);
              expect(provider.view().items[0]?.text).toBe(operation.text);
            }
            return { content: [{ type: "text", text: outcome.approved ? "approved" : outcome.code }], details: {} };
          },
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: model as never,
    modelRuntime: runtime as never,
    sessionManager: sm,
    settingsManager: settings,
    resourceLoader: loader,
    tools: ["memory_probe"],
  });
  await session.bindExtensions({ mode, shutdownHandler: async () => {} });
  session.setActiveToolsByName(["memory_probe"]);
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const handler = createCommandHandler({
    pi: api!,
    getCtx: () => ctx,
    getSessionId: () => sm.getSessionId(),
    memoryProof: () => proof,
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, deferAfterManualCompaction: (fn) => fn(), dispose() {} },
    originEntry: { appendOrigin() {}, notify() {}, dispose() {} },
    builtinBridge: {
      execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }),
      isQuiet: () => false,
    },
    controlEnabled: () => true,
    now: Date.now,
    send: () => {},
    onChanged() {},
    setTimer(ms, fn) {
      const t = setTimeout(fn, ms);
      t.unref();
      timers.push(t);
      return { cancel: () => clearTimeout(t) };
    },
  });
  // Void ExtensionAPI.sendUserMessage path, exactly as production command dispatch uses it.
  function web(id: string, origin = browser, deliver: "steer" | "followUp" = "followUp") {
    handler.handle({
      t: "cmd",
      rid: `r-${id}`,
      id,
      deadlineMs: 8000,
      origin,
      cmd: { op: "prompt", text: "same text", deliver },
    });
  }
  return {
    root,
    session,
    sm,
    proof,
    tracker,
    approval,
    dialogs,
    handler,
    provider,
    writes,
    starts,
    ingresses,
    outcomes,
    receipts,
    requests,
    api: () => api!,
    ctx: () => ctx,
    web,
    behavior(value: string) {
      behavior = value;
    },
    afterInput(fn?: () => void) {
      afterInput = fn;
    },
    hold() {
      hold = true;
    },
    askTool() {
      askTool = true;
    },
    rejectDispatch() {
      auth = false;
    },
    onSettled(fn: () => void) {
      atSettled = fn;
    },
    changeOwner() {
      owner = { ...owner, incarnation: {} };
    },
    release() {
      finish?.();
      finish = undefined;
      for (const t of timers) clearTimeout(t);
    },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("local fixture deadline");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2);
      t.unref();
    });
  }
}

describe("P3b production source bridge × real SDK 1.5", () => {
  it("native normal idle TUI -> private source -> actual SDK tool -> exact Web dialog receipt -> cap", async () =>
    fixture(async (f) => {
      f.askTool();
      await f.session.prompt("same text");
      expect(f.ingresses[0]).toEqual({ mode: "tui", source: "interactive", idle: true, pending: false });
      expect(f.starts[0]?.turn?.channel).toBe("tui");
      expect(f.starts[0]?.idle).toBe(false); // prepareRun is busy: NEVER recheck isIdle at BAS
      expect(f.outcomes).toMatchObject([{ approved: true }]);
      expect(f.receipts).toMatchObject([{ ok: true }]);
      expect(f.writes).toMatchObject([{ ok: true }]);
      expect(f.tracker.current()).toBeUndefined();
    }));
  it("idle Web production command send returns void but ALS reaches tool and real dialog bridge", async () =>
    fixture(async (f) => {
      f.askTool();
      f.web("web-positive");
      await until(() => f.outcomes.length === 1);
      await f.session.waitForIdle();
      expect(f.ingresses[0]).toMatchObject({ source: "extension", idle: true, pending: false });
      expect(f.starts[0]?.turn?.channel).toBe("web");
      expect(f.outcomes).toMatchObject([{ approved: true }]);
      expect(f.receipts).toMatchObject([{ ok: true }]);
      expect(f.writes).toMatchObject([{ ok: true }]);
    }, "rpc"));
  it.each(["transform", "throw"])("trusted native chain survives legal %s without text equality", async (behavior) =>
    fixture(async (f) => {
      f.behavior(behavior);
      await f.session.prompt("same text");
      expect(f.starts[0]?.turn?.channel).toBe("tui");
    }),
  );
  it.each(["nested", "custom", "handled"])("%s cannot steal a pending native human candidate", async (behavior) =>
    fixture(async (f) => {
      f.behavior(behavior);
      await f.session.prompt("same text");
      expect(f.starts.every((s) => s.turn === undefined)).toBe(true);
      if (behavior === "handled") {
        await f.session.sendCustomMessage(
          { customType: "machine", content: "same text", display: false },
          { triggerTurn: true },
        );
        expect(f.starts).toHaveLength(1);
        expect(f.starts[0]?.type).toBe("custom");
        expect(f.starts[0]?.turn).toBeUndefined();
      } else expect(f.starts.length).toBeGreaterThan(0);
    }),
  );
  it("native RPC, extension API and Feishu same-text sources have no human authority", async () =>
    fixture(async (f) => {
      await f.session.prompt("same text"); // raw interactive in RPC mode is NOT native TUI authority
      await f.session.prompt("same text", { source: "rpc" });
      await f.session.sendUserMessage("same text");
      f.web("feishu-negative", { ...browser, ip: "feishu" });
      await until(() => f.starts.length === 4);
      await f.session.waitForIdle();
      expect(f.starts.length).toBe(4);
      expect(f.starts.map((s) => s.turn)).toEqual([undefined, undefined, undefined, undefined]);
    }, "rpc"));
  it("trusted Web transform keeps original source while the actual submitted prompt changes", async () =>
    fixture(async (f) => {
      f.behavior("transform");
      f.web("web-transform");
      await until(() => f.starts.length === 1);
      await f.session.waitForIdle();
      expect(f.starts[0]?.turn?.channel).toBe("web");
      expect(JSON.stringify(f.requests)).toContain("same text transformed");
    }, "rpc"));
  it("held/browser-origin release sends normally but mints no fresh memory ticket", async () =>
    fixture(async (f) => {
      f.askTool();
      expect(
        f.handler.dispatchHeld({
          cmdId: "old-held",
          sessionId: f.sm.getSessionId(),
          owner: "old-owner",
          text: "same text",
          deliver: "followUp",
          origin: browser,
          at: 1,
          updatedAt: 1,
          state: "handing",
        }),
      ).toBe("sent");
      await until(() => f.outcomes.length === 1);
      await f.session.waitForIdle();
      expect(f.starts[0]?.turn).toBeUndefined();
      expect(f.outcomes).toEqual([{ approved: false, code: "E_HUB_NEEDS_HUMAN_TURN" }]);
      expect(f.dialogs.frame().open).toEqual([]);
      expect(f.writes).toEqual([]);
    }));
  it("handled Web and later identical machine text never inherit a ticket", async () =>
    fixture(async (f) => {
      f.behavior("handled");
      f.web("handled-web");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10);
        t.unref();
      });
      expect(f.starts).toHaveLength(0);
      f.behavior("continue");
      await f.session.sendUserMessage("same text");
      expect(f.starts[0]?.turn).toBeUndefined();
    }));
  it("owner change between ingress and prepareRun denies source", async () =>
    fixture(async (f) => {
      f.afterInput(() => f.changeOwner());
      await f.session.prompt("same text");
      expect(f.starts[0]?.turn).toBeUndefined();
    }));
  it("concurrent same-text native submissions do not cross-claim", async () =>
    fixture(async (f) => {
      await Promise.allSettled([f.session.prompt("same text"), f.session.prompt("same text")]);
      expect(f.starts.length).toBeGreaterThan(0);
      expect(f.starts.map((s) => s.turn)).toEqual(f.starts.map(() => undefined));
    }));
  it("two concurrent same-text Web commands cannot cross-claim generations", async () =>
    fixture(async (f) => {
      f.web("concurrent-one");
      f.web("concurrent-two");
      await until(() => f.ingresses.length === 2);
      await until(() => f.starts.length > 0);
      await f.session.waitForIdle();
      expect(f.starts.map((s) => s.turn)).toEqual(f.starts.map(() => undefined));
    }, "rpc"));
  it("SDK settled-deferred Web delivery does not inherit a dispatch ticket", async () =>
    fixture(async (f) => {
      f.onSettled(() => {
        f.askTool();
        f.web("settled-deferred");
      });
      await f.session.prompt("same text");
      await until(() => f.outcomes.length === 1);
      await f.session.waitForIdle();
      expect(f.starts).toHaveLength(2);
      expect(f.starts[1]?.turn).toBeUndefined();
      expect(f.outcomes).toEqual([{ approved: false, code: "E_HUB_NEEDS_HUMAN_TURN" }]);
      expect(f.writes).toEqual([]);
      expect(f.dialogs.frame().open).toEqual([]);
    }));
  it("real SDK dispatch rejection never confirms a turn", async () =>
    fixture(async (f) => {
      f.rejectDispatch();
      // The production convenience path obtains the actual private owner; return the real SDK
      // Promise here to verify rejection observation (ExtensionAPI's void path simply has no BAS).
      await expect(
        f.proof.dispatchWeb("rejected", browser, () => f.session.sendUserMessage("same text")),
      ).rejects.toThrow();
      expect(f.tracker.current()).toBeUndefined();
      expect(f.starts).toHaveLength(0);
      expect(f.writes).toEqual([]);
      expect(f.dialogs.frame().open).toEqual([]);
    }));
  it.each(["steer", "followUp"] as const)(
    "busy native %s is delivered normally but cannot authorize a memory tool",
    async (deliver) =>
      fixture(async (f) => {
        f.hold();
        const first = f.session.prompt("same text");
        await until(() => f.starts.length === 1);
        f.web("busy-web", browser, deliver);
        await until(() => f.ingresses.length === 2);
        expect(f.tracker.current()).toBeUndefined();
        expect(f.dialogs.frame().open).toHaveLength(0);
        f.askTool();
        f.release();
        await first;
        expect(f.outcomes).toEqual([{ approved: false, code: "E_HUB_NEEDS_HUMAN_TURN" }]);
        expect(f.writes).toEqual([]);
        expect(f.starts.length).toBe(1);
        expect(f.requests.length).toBeGreaterThanOrEqual(2); // native queue was not dropped or resent
      }),
  );
});
