import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createHumanGrantHost, createHumanGrantPort, type InvocationRef } from "../../src/fabric/xs/human-grant.js";
import { createXsSender, type XsPortSendArgs } from "../../src/fabric/xs/sender.js";
import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import { createHumanRuntime } from "../../src/runtime/human-runtime.js";
import { PiSessionDriver, PiSessionHandle, CHILD_SWITCH_CONTEXT_SOURCE } from "../../src/runtime/session-driver.js";
import { createAgentTool } from "../../src/tools/agent-tool.js";
import type { NestedSpawnPort } from "../../src/tools/agent-tool.js";
import type { SessionSpec, RunOutcome, SpawnRequest } from "../../src/core/types.js";
import { buildToolScopePolicy, createToolScopeEnforcer } from "../../src/runtime/tool-scope.js";
import {
  assistantTextMsg,
  assistantToolCallMsg,
  fakeModel,
  fakeModelRuntime,
  disposeHarnessDirs,
  withSession,
} from "../conformance/agent-session-harness.js";
import { makeFakeVault, freezeDomain } from "../secure/helpers.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import type { ScriptedTurn } from "../conformance/agent-session-harness.js";

const dirs: string[] = [];
const handles: PiSessionHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  disposeHarnessDirs();
});
const SEND = { to: "target-session", text: "delegated body", expectReply: {} };
function sendTurns(id = "child-send", params: Record<string, unknown> = SEND): ScriptedTurn[] {
  return [
    { toolCall: true, build: (m) => assistantToolCallMsg(m, id, "message_session", params) },
    { toolCall: false, build: (m) => assistantTextMsg(m, "finished") },
  ];
}
function harness() {
  const grants = createHumanGrantPort();
  const sent: XsPortSendArgs[] = [];
  let source: { sessionId: string; epoch: number } | undefined = { sessionId: "source-session", epoch: 1 };
  let currentLevel = 1;
  let resolveBarrier: Promise<void> | undefined;
  let resolveEntered: (() => void) | undefined;
  const sender = createXsSender({
    activation: true,
    humanGrants: grants,
    origin: { current: () => source },
    port: {
      list: async () => ({ kind: "off" }),
      stateCapable: () => true,
      replyCapable: () => true,
      resolve: async () => {
        resolveEntered?.();
        await resolveBarrier;
        return {
          kind: "res",
          targetState: true,
          res: { t: "xs_res", rid: "resolve", ok: true, target: { sessionId: "target-session", ref: "target" } },
        };
      },
      send: async (args) => {
        sent.push(args);
        return {
          kind: "res",
          res: { t: "xs_res", rid: "send", ok: true, effect: "applied" },
          progress: {
            messageId: "original-body-id",
            activationKey: "original-key",
            revision: 0,
            deliveryEffect: "applied",
            observation: "live",
            wake: { requested: args.wake === true, decision: "unknown" },
          },
        };
      },
    },
    wakeOn: true,
    level: { levelOfRoot: () => 0, hopAllowed: (level) => level + 1 <= 4 },
    reply: {
      ledger: new XsReplyLedger(),
      defaultTimeoutS: 1800,
      maxTimeoutS: 86400,
      lateGraceS: 600,
      maxPending: 8,
      maxPendingPerTarget: 4,
      receivable: () => "ok",
      inbound: () => undefined,
    },
  });
  const runtime = createHumanRuntime({
    grants,
    rootOwner: "root-owner",
    source: () => source,
    sender: () => sender,
    runLevel: () => currentLevel,
    reply: true,
    alias: false,
  });
  const host = createHumanGrantHost(grants, "root-owner", (id) => runtime.childLinked(id));
  const model = fakeModel();
  const driver = new PiSessionDriver(false, () => model, runtime);
  async function child(
    runId: string,
    turns = sendTurns(),
    extra: Partial<SessionSpec> = {},
    observer?: ExtensionFactory,
  ) {
    const cwd = mkdtempSync(join(tmpdir(), "pi-human-child-"));
    dirs.push(cwd);
    const agentDir = join(cwd, ".pi");
    const settingsManager = SettingsManager.create(cwd, agentDir);
    let baseContexts = 0;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        (pi) => {
          pi.on("context", () => {
            baseContexts++;
          });
        },
        ...(observer ? [observer] : []),
      ],
    });
    await loader.reload();
    const modelRuntime = fakeModelRuntime(model, turns);
    const scope = {
      policy: buildToolScopePolicy({ tools: ["Agent"], granted: ["Agent"] }),
      enforcer: createToolScopeEnforcer(),
    };
    const request = {
      cwd,
      agentDir,
      model: { provider: model.provider, id: model.id },
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      persist: false,
      tools: ["Agent"],
      runId,
      toolScope: scope,
      ...extra,
    } as SessionSpec;
    const handle = (await driver.create(request)) as PiSessionHandle;
    handles.push(handle);
    scope.enforcer.onBind(handle, scope.policy);
    await driver.bind(handle, () => {});
    return { handle, modelRuntime, baseContexts: () => baseContexts, scope, request };
  }
  function authorize(runId: string, callId = "root-Agent") {
    const sid = source!.sessionId;
    const user = { role: "user", content: "human delegation", timestamp: Date.now() };
    host.input({ source: "rpc", text: "human delegation" }, sid);
    host.message(user, sid);
    host.context({ messages: [structuredClone(user)] }, sid);
    host.toolCall(callId, "Agent", sid);
    grants.observeSpawnEdge(sid, "root", runId);
    host.toolResult(callId, "Agent", { runId }, false);
    return host.invocation(callId, "Agent")!;
  }
  return {
    grants,
    sent,
    runtime,
    driver,
    host,
    child,
    authorize,
    source: () => source,
    setSource: (s: typeof source) => {
      source = s;
    },
    setLevel: (n: number) => {
      currentLevel = n;
    },
    pauseResolve: () => {
      let release!: () => void;
      resolveBarrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      return { release, entered };
    },
  };
}

describe("P2c real PiSessionDriver / SDK child invocation consumption", () => {
  it("admitted child uses exact context/call, custom resource loader and per-run scope; one original receipt", async () => {
    const h = harness();
    const parent = h.authorize("real-child");
    const child = await h.child("real-child");
    expect(child.handle.getActiveTools()).toContain("message_session");
    expect(child.scope.policy.allow?.has("message_session")).toBe(true);
    await child.handle.prompt("work");
    expect(child.modelRuntime.callCount()).toBe(2);
    expect(child.baseContexts()).toBe(2);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.wake).toBe(true);
    expect(h.sent[0]!.level).toBe(1);
    expect(h.sent[0]!.wakeView?.defaulted).toBe(true);
    const result = child.handle.session.messages.find((m) => m.role === "toolResult");
    expect(JSON.stringify(result)).toContain("original-body-id");
    expect(JSON.stringify(result)).toContain("original-key");
    expect(JSON.stringify(child.modelRuntime.requestMessages)).not.toContain(parent.owner);
    expect(JSON.stringify(child.modelRuntime.requestMessages)).not.toContain("contextSeq");
    // SDK agent_end is the actual authority boundary, not session_shutdown.
    expect(await h.runtime.prepare("real-child")).toBeUndefined();
  });

  it("authorized resume consumes the NEW real runId rather than historical child metadata", async () => {
    const h = harness();
    const original = await h.child(
      "old-history",
      [{ toolCall: false, build: (m) => assistantTextMsg(m, "old history") }],
      { persist: true },
    );
    await original.handle.prompt("history only");
    expect(original.handle.sessionFile).toBeTruthy();
    original.handle.dispose();
    h.authorize("fresh-resume");
    const modelRuntime = fakeModelRuntime(fakeModel(), sendTurns("resume-send"));
    const resumed = (await h.driver.resume(original.handle.sessionFile!, {
      ...original.request,
      runId: "fresh-resume",
      modelRuntime,
    } as SessionSpec)) as PiSessionHandle;
    handles.push(resumed);
    await h.driver.bind(resumed, () => {});
    expect(resumed.getActiveTools()).toContain("message_session");
    await resumed.prompt("new authorized task");
    expect(modelRuntime.callCount()).toBe(2);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.wake).toBe(true);
    expect(JSON.stringify(resumed.session.messages)).toContain("original-body-id");
    expect(await h.runtime.prepare("fresh-resume")).toBeUndefined();
  });

  it.each([false, true])("real root Agent → child Agent → nested child; nested background=%s", async (background) => {
    const h = harness();
    let first: Awaited<ReturnType<typeof h.child>> | undefined;
    let nested: Awaited<ReturnType<typeof h.child>> | undefined;
    let firstDone: Promise<void> | undefined;
    let nestedDone: Promise<void> | undefined;
    let seq = 0;
    const admitted: SpawnRequest[] = [];
    const port: NestedSpawnPort = {
      async spawn(req) {
        admitted.push(req);
        const runId = `actual-run-${++seq}`;
        h.grants.observeSpawnEdge(h.source()!.sessionId, req.parentRunId ?? "root", runId);
        if (!req.parentRunId) {
          // Start create BEFORE the root result arrives: bounded wait consumes
          // the exact result later. The actual production Agent tool is used.
          firstDone = h
            .child(
              runId,
              [
                {
                  toolCall: true,
                  build: (m) =>
                    assistantToolCallMsg(m, "nested-Agent-call", "Agent", {
                      description: "nested work",
                      prompt: "nested task",
                      subagent_type: "worker",
                      run_in_background: background,
                    }),
                },
                { toolCall: false, build: (m) => assistantTextMsg(m, "parent done") },
              ],
              {
                customTools: [
                  createAgentTool({ spawn: port, parentRunId: runId, allowedTypes: ["worker"], forceSlotless: true }),
                ],
              },
            )
            .then(async (env) => {
              first = env;
              await env.handle.prompt(req.prompt);
            });
        } else {
          nestedDone = h.child(runId).then(async (env) => {
            nested = env;
            await env.handle.prompt(req.prompt);
          });
        }
        return { runId };
      },
      async spawnAndWait(req) {
        const spawned = await port.spawn(req);
        if ("error" in spawned) throw new Error(spawned.error.message);
        await nestedDone;
        return {
          runId: spawned.runId,
          status: "completed",
          text: "nested finished",
          turns: 2,
          durationMs: 1,
          diag: { label: "nested" },
        } as RunOutcome;
      },
    };
    await withSession(
      {
        tools: ["Agent"],
        scripted: [
          {
            toolCall: true,
            build: (m) =>
              assistantToolCallMsg(m, "root-real-Agent", "Agent", {
                description: "child work",
                prompt: "child task",
                subagent_type: "worker",
              }),
          },
          { toolCall: false, build: (m) => assistantTextMsg(m, "root done") },
        ],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.registerTool(createAgentTool({ spawn: port }));
            pi.on("message_start", (e, ctx) => h.host.message(e.message, ctx.sessionManager.getSessionId()));
            pi.on("context", (e, ctx) => h.host.context(e, ctx.sessionManager.getSessionId()));
            pi.on("tool_call", (e, ctx) =>
              h.host.toolCall(e.toolCallId, e.toolName, ctx.sessionManager.getSessionId(), e.parentToolCallId),
            );
            pi.on("tool_result", (e) => h.host.toolResult(e.toolCallId, e.toolName, e.details, e.isError));
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        h.setSource({ sessionId: session.sessionId, epoch: 1 });
        h.host.input({ source: "rpc", text: "root human task" }, session.sessionId);
        await session.prompt("root human task");
        await firstDone;
        await nestedDone;
        expect(modelRuntime.callCount()).toBe(2);
        expect(first!.modelRuntime.callCount()).toBe(2);
        expect(nested!.modelRuntime.callCount()).toBe(2);
        expect(admitted).toHaveLength(2);
        expect(admitted[1]!.parentRunId).toBe("actual-run-1");
        expect(admitted[1]!.slotless).toBe(true);
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]!.wake).toBe(true);
        expect(h.sent[0]!.wakeView?.defaulted).toBe(true);
        expect(JSON.stringify(nested!.handle.session.messages)).toContain("original-body-id");
        expect(await h.runtime.prepare("actual-run-2")).toBeUndefined();
      },
    );
  });

  it("two concurrent blocking nested Agent executes retain separate parent grants across awaits", async () => {
    const h = harness();
    const aParent = h.authorize("parent-A", "root-A");
    const bParent = h.authorize("parent-B", "root-B");
    expect(h.grants.resolve(aParent)).not.toEqual(h.grants.resolve(bParent));
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const nestedModels: Array<ReturnType<typeof fakeModelRuntime>> = [];
    const port: NestedSpawnPort = {
      async spawn() {
        throw new Error("nested default must use blocking spawnAndWait");
      },
      async spawnAndWait(req) {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const side = req.parentRunId === "parent-A" ? "A" : "B";
        if (side === "A") await gateA;
        else releaseA(); // B enters after A, then A resumes while B is still live.
        const runId = `nested-${side}`;
        h.grants.observeSpawnEdge(h.source()!.sessionId, req.parentRunId!, runId);
        const child = await h.child(runId, sendTurns(`send-${side}`, { ...SEND, text: `payload-${side}` }));
        nestedModels.push(child.modelRuntime);
        await child.handle.prompt(req.prompt);
        concurrent--;
        return { runId, status: "completed", text: "done", turns: 2, durationMs: 1, diag: {} } as RunOutcome;
      },
    };
    const makeParent = (runId: string) =>
      h.child(
        runId,
        [
          {
            toolCall: true,
            build: (m) =>
              assistantToolCallMsg(m, `${runId}-call`, "Agent", {
                description: runId,
                prompt: "nested work",
                subagent_type: "worker",
              }),
          },
          { toolCall: false, build: (m) => assistantTextMsg(m, "parent done") },
        ],
        {
          customTools: [
            createAgentTool({ spawn: port, parentRunId: runId, allowedTypes: ["worker"], forceSlotless: true }),
          ],
        },
      );
    const [a, b] = await Promise.all([makeParent("parent-A"), makeParent("parent-B")]);
    await Promise.all([a.handle.prompt("A"), b.handle.prompt("B")]);
    expect(maxConcurrent).toBe(2);
    expect(nestedModels.map((m) => m.callCount())).toEqual([2, 2]);
    expect(h.sent).toHaveLength(2);
    expect(new Set(h.sent.map((s) => s.text))).toEqual(new Set(["payload-A", "payload-B"]));
    // Independent root inputs each have exactly one allowance. Mixing ALS
    // would either fail the parent edge or consume the wrong shared allowance.
    expect(h.sent.every((s) => s.wake === true && s.wakeView?.defaulted === true)).toBe(true);
  });

  it("nested create with an admitted edge for a different parent cannot consume ALS authority", async () => {
    const h = harness();
    h.authorize("parent-match");
    let nested: Awaited<ReturnType<typeof h.child>> | undefined;
    const port: NestedSpawnPort = {
      async spawn() {
        throw new Error("blocking path required");
      },
      async spawnAndWait(req) {
        expect(req.parentRunId).toBe("parent-match");
        h.grants.observeSpawnEdge(h.source()!.sessionId, "different-parent", "wrong-edge-child");
        nested = await h.child("wrong-edge-child");
        await nested.handle.prompt("no authority");
        return {
          runId: "wrong-edge-child",
          status: "completed",
          turns: 2,
          durationMs: 1,
          text: "done",
          diag: {},
        } as RunOutcome;
      },
    };
    const parent = await h.child(
      "parent-match",
      [
        {
          toolCall: true,
          build: (m) =>
            assistantToolCallMsg(m, "nested-call", "Agent", {
              description: "mismatch",
              prompt: "nested task",
              subagent_type: "worker",
            }),
        },
        { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
      ],
      {
        customTools: [
          createAgentTool({ spawn: port, parentRunId: "parent-match", allowedTypes: ["worker"], forceSlotless: true }),
        ],
      },
    );
    await parent.handle.prompt("work");
    expect(nested!.handle.getActiveTools()).not.toContain("message_session");
    expect(nested!.modelRuntime.callCount()).toBe(2);
    expect(h.sent).toEqual([]);
  });

  it("one CAS across simultaneous real children, regardless of target", async () => {
    const h = harness();
    h.authorize("one");
    h.host.toolCall("second-Agent", "Agent", h.source()!.sessionId);
    h.grants.observeSpawnEdge(h.source()!.sessionId, "root", "two");
    h.host.toolResult("second-Agent", "Agent", { runId: "two" }, false);
    const [one, two] = await Promise.all([h.child("one"), h.child("two", sendTurns("second-send"))]);
    await Promise.all([one.handle.prompt("one"), two.handle.prompt("two")]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.filter((s) => s.wake === true)).toHaveLength(1);
    expect(h.sent.filter((s) => s.wakeView?.defaulted === true)).toHaveLength(1);
  });

  it("reads live child causal level and never resets it to human/root level", async () => {
    const h = harness();
    h.authorize("limited");
    const child = await h.child("limited");
    h.setLevel(4);
    await child.handle.prompt("work");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.level).toBe(4);
    expect(h.sent[0]!.wake).toBeUndefined();
    expect(JSON.stringify(child.handle.session.messages)).toContain("level_limit");
  });

  it("level raised DURING address resolve is read at wake decision, not captured at execute", async () => {
    const h = harness();
    h.authorize("late-level");
    const child = await h.child("late-level");
    const barrier = h.pauseResolve();
    const turn = child.handle.prompt("work");
    await barrier.entered;
    h.setLevel(4);
    barrier.release();
    await turn;
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.level).toBe(4);
    expect(h.sent[0]!.wake).toBeUndefined();
    expect(JSON.stringify(child.handle.session.messages)).toContain("level_limit");
  });

  it.each([undefined, true])("dispose DURING resolve cannot send after child revocation, wake=%s", async (wake) => {
    const h = harness();
    h.authorize("late-dispose");
    const child = await h.child(
      "late-dispose",
      sendTurns("late-call", { ...SEND, ...(wake === undefined ? {} : { wake }) }),
    );
    const barrier = h.pauseResolve();
    const turn = child.handle.prompt("work");
    await barrier.entered;
    child.handle.dispose();
    barrier.release();
    await turn;
    expect(h.sent).toEqual([]);
    expect(await h.runtime.prepare("late-dispose")).toBeUndefined();
  });

  it.each(["reload", "switch", "dispose", "abort", "revoke"])(
    "%s rejects existing child authority",
    async (boundary) => {
      const h = harness();
      h.authorize("terminated");
      const child = await h.child("terminated");
      if (boundary === "dispose") child.handle.dispose();
      else if (boundary === "abort") await child.handle.requestAbort();
      else if (boundary === "revoke") h.grants.revokeSession(h.source()!.sessionId);
      else if (boundary === "reload") h.setSource(undefined);
      else h.setSource({ sessionId: "next-session", epoch: 2 });
      if (boundary !== "dispose") await child.handle.prompt("no remaining grant");
      expect(h.sent).toEqual([]);
      expect(await h.runtime.prepare("terminated")).toBeUndefined();
    },
  );

  it("actual SDK switch boundary entry revokes child delegation before the next provider call", async () => {
    const h = harness();
    h.authorize("boundary-child");
    let committed = false;
    const child = await h.child(
      "boundary-child",
      [
        { toolCall: true, build: (m) => assistantToolCallMsg(m, "before-switch", "Agent", {}) },
        ...sendTurns("after-switch"),
      ],
      {
        customTools: [
          {
            name: "Agent",
            label: "Agent",
            description: "Boundary test tool",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "boundary" }], details: {} }),
          },
        ],
      },
      (pi) => {
        pi.on("turn_end", (event) => {
          if (committed) return;
          committed = true;
          return {
            entries: [
              ...event.entries,
              {
                type: "compaction",
                summary: "new context",
                firstKeptEntryId: null,
                details: { source: CHILD_SWITCH_CONTEXT_SOURCE, seq: 1, keepRecent: false },
              },
            ],
          };
        });
      },
    );
    await child.handle.prompt("perform boundary then send");
    expect(committed).toBe(true);
    expect(child.modelRuntime.callCount()).toBe(3);
    expect(child.handle.getSwitchTail()?.seq).toBe(1);
    expect(h.sent).toEqual([]);
    expect(JSON.stringify(child.handle.session.messages)).toContain("not_joined");
  });

  it("secure domain keeps even an authorized real child on the inert path", async () => {
    const h = harness();
    h.authorize("secure-child");
    const vault = makeFakeVault();
    try {
      expect(freezeDomain(vault).domain.kind).toBe("secure");
      const child = await h.child("secure-child", [
        { toolCall: false, build: (m) => assistantTextMsg(m, "secure inert") },
      ]);
      expect(child.handle.getActiveTools()).not.toContain("message_session");
      await child.handle.prompt("secure work");
      expect(child.modelRuntime.callCount()).toBe(1);
      expect(h.sent).toEqual([]);
    } finally {
      resetSecureDomainForTests();
      vault.cleanup();
    }
  });

  it.each(["no proof", "forged meta", "noTools", "readonly", "excluded", "façade off"])(
    "%s never injects host tool",
    async (mode) => {
      const h = harness();
      if (!["no proof", "forged meta", "façade off"].includes(mode)) h.authorize("untrusted");
      const extra: Partial<SessionSpec> =
        mode === "noTools"
          ? { noTools: "all" }
          : mode === "excluded"
            ? { excludeTools: ["message_session"] }
            : mode === "readonly"
              ? ({ toolScope: { policy: { deny: new Set(), provenance: new Map() } } } as Partial<SessionSpec>)
              : mode === "forged meta"
                ? ({
                    meta: { human: true, parentInvocation: "root-Agent", runId: "untrusted" },
                  } as Partial<SessionSpec>)
                : {};
      if (mode === "façade off") h.setSource(undefined);
      const child = await h.child(
        "untrusted",
        [{ toolCall: false, build: (m) => assistantTextMsg(m, "no grant") }],
        extra,
      );
      expect(child.handle.getActiveTools()).not.toContain("message_session");
      await child.handle.prompt("untrusted human true meta source");
      expect(child.modelRuntime.callCount()).toBe(1);
      expect(h.sent).toEqual([]);
    },
  );
});
