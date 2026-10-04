/**
 * S0 conformance (ask-user-async plan §2): lock pi's TUI close path + delivery semantics that the
 * ask_user background-interrupt design depends on, against the REAL devDependency pi (0.87.1).
 *
 * Suite A (C1–C5): the REAL `InteractiveMode` + real `showExtensionCustom` via tui-harness
 * (FakeTerminal keystroke injection, full-frame screen capture), probe extension `ask_probe`.
 * Timing matrix per plan §2.2: T1 (claim before factory) / T2 (claim in the factory→mount
 * microtask gap) / T3a,b,c (mounted, racing keystrokes in the same tick).
 * Suite B (C6–C11): `bindExtensions({ uiContext, mode: "tui" })` with a hanging fake `ui.custom`
 * (delivery semantics only — the close path is NOT under test here; that was review #1's point).
 *
 * S0 writes no implementation (nothing under src/ changes); these tests pin the pi-side facts the
 * plan's §2.3 go/no-go table decides on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAskProbeExtension, PROBE_CUSTOM_TYPE, type AskProbe } from "./ask-probe.js";
import {
  createTuiHarness,
  fakeModel,
  fakeModelRuntime,
  textTurn,
  toolTurn,
  type ScriptedTurn,
  type TuiHarness,
} from "./tui-harness.js";

const DRAFT = "draft-xyz";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Exactly one macrotask boundary (C1's "resolve within 1 macrotask"). */
function oneMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function trackUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  return { seen, stop: () => process.off("unhandledRejection", handler) };
}

/** Poll until fn() returns a truthy-ready value (undefined/false/null = keep waiting). */
async function until<T>(fn: () => T | undefined | false, what = "condition"): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = fn();
    if (value !== undefined && value !== false && value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface RequestMessage {
  role: string;
  customType?: string | undefined;
  content?: unknown;
  toolCall: boolean;
  toolResult: boolean;
}

function classifyRequestMessages(messages: unknown[]): RequestMessage[] {
  return messages.map((m) => {
    const msg = m as { role?: string; customType?: string; content?: unknown };
    let toolCall = false;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string }>) if (block?.type === "toolCall") toolCall = true;
    }
    return {
      role: msg.role ?? "?",
      customType: msg.customType,
      content: msg.content,
      toolCall,
      toolResult: msg.role === "toolResult",
    };
  });
}

function customContents(messages: unknown[], payloads: string[]): string[] {
  return noticeTexts(messages, payloads);
}

/** pi-agent-core converts an injected custom steer to a user-role text message at the provider
 *  boundary (content string verbatim; this very conversion is one of the facts S0 locks) — a
 *  "notice" is such a converted message whose single text block is one of `payloads`. Only the
 *  tail after the LAST toolResult counts: earlier requests' injected notices remain in the
 *  carried-over history and must not be re-counted. */
function noticeTexts(messages: unknown[], payloads: string[]): string[] {
  const cls = classifyRequestMessages(messages);
  const lastToolResultIdx = cls.map((m) => m.toolResult).lastIndexOf(true);
  const tail = cls.slice(lastToolResultIdx + 1);
  const texts: string[] = [];
  for (const m of tail) {
    if (m.role !== "user" || !Array.isArray(m.content) || m.content.length !== 1) continue;
    const block = m.content[0] as { type?: string; text?: string };
    if (block?.type === "text" && typeof block.text === "string" && payloads.includes(block.text))
      texts.push(block.text);
  }
  return texts;
}

/** C6: within a request, the injected notification sits right after assistant(toolCall) → toolResult,
 *  delivered as a converted user-role text message with the payload verbatim. */
function expectNotificationAfterToolResult(messages: unknown[], expectedContent: string): void {
  const cls = classifyRequestMessages(messages);
  const toolResultIdx = cls.findIndex((m) => m.toolResult);
  expect(toolResultIdx).toBeGreaterThan(0);
  expect(cls[toolResultIdx - 1]?.toolCall).toBe(true);
  expect(cls[toolResultIdx - 1]?.role).toBe("assistant");
  const injected = cls[toolResultIdx + 1];
  expect(injected?.role).toBe("user");
  const content = injected?.content as Array<{ type?: string; text?: string }> | undefined;
  expect(content?.length).toBe(1);
  expect(content?.[0]?.type).toBe("text");
  expect(content?.[0]?.text).toBe(expectedContent);
  // exactly one notice in this request
  expect(noticeTexts(messages, [expectedContent])).toEqual([expectedContent]);
}

/** C4: ui_prompt_start/ui_prompt_end strictly interleaved (paired). */
function expectUiPromptPairs(probe: AskProbe): void {
  const kinds = probe.events.filter((e) => e.type.startsWith("ui_prompt_")).map((e) => e.type);
  expect(kinds.length % 2).toBe(0);
  for (let i = 0; i < kinds.length; i += 2) {
    expect(kinds[i]).toBe("ui_prompt_start");
    expect(kinds[i + 1]).toBe("ui_prompt_end");
  }
}

/** C2: editor visible with the saved draft (+ anything already typed since), then further
 *  keystrokes land IN the editor. */
function expectDraftRestoredAndTypedInto(harness: TuiHarness, typedSoFar: string, ...keystrokes: string[]): void {
  const before = harness.renderFullFrame();
  expect(before.some((l) => l.includes(DRAFT))).toBe(true);
  for (const key of keystrokes) harness.terminal.type(key);
  const after = harness.renderFullFrame();
  const expected = DRAFT + typedSoFar + keystrokes.join("");
  expect(after.some((l) => l.replace(/\s/g, "").includes(expected.replace(/\s/g, "")))).toBe(true);
}

// ---------------------------------------------------------------------------
// Suite B helper: REAL bindExtensions({ uiContext, mode: "tui" }) with a hanging ui.custom
// ---------------------------------------------------------------------------

const HANGING_TUI = {} as never;
const HANGING_THEME = {} as never;
const HANGING_KEYS = {} as never;

function hangingUIContext(): ExtensionUIContext {
  return {
    custom: (factory: (tui: never, theme: never, keys: never, done: (result: unknown) => void) => unknown) =>
      new Promise((resolve) => {
        factory(HANGING_TUI, HANGING_THEME, HANGING_KEYS, (result) => resolve(result));
      }),
  } as unknown as ExtensionUIContext;
}

const suiteBDirs: string[] = [];
afterEach(() => {
  for (const d of suiteBDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function withDeliverySession(
  opts: { scripted: ScriptedTurn[]; steeringMode?: "all" | "one-at-a-time" },
  run: (env: {
    session: AgentSession;
    probe: AskProbe;
    requestMessages: unknown[][];
    callCount: () => number;
  }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "ask-user-delivery-"));
  suiteBDirs.push(cwd);
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const probeExt = createAskProbeExtension();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [probeExt.factory] as never,
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });
  try {
    if (opts.steeringMode) session.setSteeringMode(opts.steeringMode);
    await session.bindExtensions({ uiContext: hangingUIContext(), mode: "tui" });
    await run({
      session,
      probe: probeExt.probe,
      requestMessages: modelRuntime.requestMessages,
      callCount: modelRuntime.callCount,
    });
  } finally {
    session.dispose();
  }
}

/** Start a Suite A scenario: type the draft, kick off the scripted run, surface attempt 0. */
async function startTuiScenario(
  harness: TuiHarness,
  probe: AskProbe,
): Promise<{ runDone: Promise<void>; attempt: NonNullable<AskProbe["attempts"][number]> }> {
  harness.terminal.type(DRAFT);
  const runDone = harness.session.prompt("run probe");
  const attempt = await until(() => probe.attempts[0], "first ask_probe attempt");
  await attempt.whenEntered;
  return { runDone, attempt };
}

// ---------------------------------------------------------------------------
// Suite A: C1–C5 on the real TUI close path
// ---------------------------------------------------------------------------

describe("S0-A real TUI close path (C1–C5)", () => {
  it("T1 (claim before factory): C1 interrupted in 1 macrotask; C2 editor restored; C3 never mounted, no dispose; C4 one prompt pair", async () => {
    const probeExt = createAskProbeExtension();
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T1" }), textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      const { runDone, attempt } = await startTuiScenario(harness, probe);
      const unhandled = trackUnhandledRejections();
      try {
        probe.fire(); // send + claim("background") + releaseGate (component not created yet)
        await oneMacrotask();
        // C1
        expect(attempt.outcome).toEqual({ kind: "interrupted" });
        expect(unhandled.seen).toEqual([]);
        // C3 — factory-time winner: queueMicrotask(cancel) fired inside the factory, the mount
        // `.then` saw `closed` and returned: component never reached the tree.
        expect(attempt.focusEvents).toBe(0);
        expect(attempt.renders).toBe(0);
        expect(attempt.inputs).toEqual([]);
        expect(attempt.disposed).toBe(0);
        // C2 — editor restored with the saved draft, typing lands in the editor
        expectDraftRestoredAndTypedInto(harness, "", "abc");
        await runDone;
        // C4 — exactly one paired ui_prompt round for this dialog
        expectUiPromptPairs(probe);
        expect(probe.events.filter((e) => e.type === "ui_prompt_start").length).toBe(1);
      } finally {
        unhandled.stop();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("T2 (claim in the factory→mount microtask gap): C1 interrupted in 1 macrotask; C2 editor restored; C3 close() beat the mount; C4 one prompt pair", async () => {
    const probeExt = createAskProbeExtension();
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T2" }), textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      const { runDone, attempt } = await startTuiScenario(harness, probe);
      const unhandled = trackUnhandledRejections();
      try {
        await attempt.whenFactoryReturned; // the queued fire microtask runs in the gap, before the mount `.then`
        await oneMacrotask();
        // C1
        expect(attempt.outcome).toEqual({ kind: "interrupted" });
        expect(unhandled.seen).toEqual([]);
        // C3 — close() ran before mount: never focused, never rendered, no dispose
        expect(attempt.focusEvents).toBe(0);
        expect(attempt.renders).toBe(0);
        expect(attempt.disposed).toBe(0);
        // C2
        expectDraftRestoredAndTypedInto(harness, "", "abc");
        await runDone;
        // C4
        expectUiPromptPairs(probe);
        expect(probe.events.filter((e) => e.type === "ui_prompt_start").length).toBe(1);
      } finally {
        unhandled.stop();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("T3a (mounted, key then claim, same tick): C1/C2/C3 dispose exactly once; no post-close render/handleInput; C4 pair", async () => {
    const probeExt = createAskProbeExtension();
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3a" }), textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      const { runDone, attempt } = await startTuiScenario(harness, probe);
      await attempt.whenMounted;
      harness.terminal.type("1"); // keystroke racing the interrupt
      const unhandled = trackUnhandledRejections();
      try {
        probe.fire();
        await oneMacrotask();
        // C1
        expect(attempt.outcome).toEqual({ kind: "interrupted" });
        expect(unhandled.seen).toEqual([]);
        // C3 — mounted component: dispose called EXACTLY once; no render/handleInput afterwards
        expect(attempt.disposed).toBe(1);
        expect(attempt.inputs).toEqual(["1"]);
        const rendersAfterClose = attempt.renders;
        const inputsAfterClose = attempt.inputs.length;
        expectDraftRestoredAndTypedInto(harness, "", "abc"); // C2
        expect(attempt.renders).toBe(rendersAfterClose);
        expect(attempt.inputs.length).toBe(inputsAfterClose);
        await runDone;
        // C4
        expectUiPromptPairs(probe);
        expect(probe.events.filter((e) => e.type === "ui_prompt_start").length).toBe(1);
      } finally {
        unhandled.stop();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("T3b (mounted, claim then key, same tick): C5(b) key falls through to the editor; C4 re-ask dialog mounts/inputs/submits; C6 real-path notification order", async () => {
    const probeExt = createAskProbeExtension();
    let releaseTurn2!: () => void;
    const turn2Gate = new Promise<void>((r) => (releaseTurn2 = r));
    const reaskTurn = toolTurn("ask_probe", { timing: "T3b" });
    reaskTurn.gate = turn2Gate; // keep the re-ask dialog from opening before the editor checks
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3b" }), reaskTurn, textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      const { runDone, attempt } = await startTuiScenario(harness, probe);
      await attempt.whenMounted;
      const unhandled = trackUnhandledRejections();
      try {
        probe.fire();
        await oneMacrotask();
        // C1
        expect(attempt.outcome).toEqual({ kind: "interrupted" });
        expect(unhandled.seen).toEqual([]);
        expect(attempt.disposed).toBe(1);
        const rendersAfterClose = attempt.renders;
        // C5(b) — after the claim, a keystroke lands on the EDITOR, not the (disposed) component
        const inputsBefore = attempt.inputs.length;
        harness.terminal.type("1");
        expect(attempt.inputs.length).toBe(inputsBefore);
        expectDraftRestoredAndTypedInto(harness, "1", "abc"); // C2 (draft-xyz1abc now)
        // C3 — no render/handleInput after close
        expect(attempt.renders).toBe(rendersAfterClose);
        // C6 (real-path variant) — turn-2 request (captured when turn 2's model call entered,
        // before its gate resolves): assistant(toolCall) → toolResult → injected notification
        await until(() => (harness.modelRuntime.requestMessages[1] ?? []).length > 0, "turn-2 request");
        expectNotificationAfterToolResult(harness.modelRuntime.requestMessages[1] ?? [], "bg-done-0");
        expect(harness.modelRuntime.callCount()).toBeGreaterThanOrEqual(2);
        // C4 — the model's re-ask (turn 2) opens a SECOND dialog that mounts, takes input, submits
        releaseTurn2();
        const reask = await until(() => probe.attempts[1], "re-ask attempt");
        await reask.whenMounted;
        harness.terminal.type("2");
        harness.terminal.type("\r");
        await runDone;
        expect(reask.outcome).toEqual({ kind: "answered", answer: 2 });
        expectUiPromptPairs(probe);
        expect(probe.events.filter((e) => e.type === "ui_prompt_start").length).toBe(2);
        expect(harness.modelRuntime.callCount()).toBe(3); // no extra agent run
      } finally {
        unhandled.stop();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("T3c (mounted, submit vs claim, submit first): C5(c) answered wins, notification still arrives after the answer; C2 editor restored; C3/C4; no unhandled rejection", async () => {
    const probeExt = createAskProbeExtension();
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3c" }), textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      const { runDone, attempt } = await startTuiScenario(harness, probe);
      await attempt.whenMounted;
      const unhandled = trackUnhandledRejections();
      try {
        harness.terminal.type("\r"); // submit arrives first
        probe.fire(); // same tick: send still goes out; claim loses
        await oneMacrotask();
        expect(attempt.outcome).toEqual({ kind: "answered", answer: 1 }); // C5(c)
        expect(unhandled.seen).toEqual([]);
        // C3 — submit-close also goes through showExtensionCustom.close(): dispose exactly once,
        // no render/handleInput afterwards
        expect(attempt.disposed).toBe(1);
        const rendersAfterClose = attempt.renders;
        const inputsAfterClose = attempt.inputs.length;
        // C2 — the close path is the same restoreEditor() regardless of who won: the draft is
        // back in the editor and further keystrokes land there
        expectDraftRestoredAndTypedInto(harness, "", "abc");
        expect(attempt.renders).toBe(rendersAfterClose);
        expect(attempt.inputs.length).toBe(inputsAfterClose);
        await runDone;
        // The notification still lands AFTER the answer, inside the next request
        expectNotificationAfterToolResult(harness.modelRuntime.requestMessages[1] ?? [], "bg-done-0");
        expect(harness.modelRuntime.callCount()).toBe(2);
        // C4 — one paired ui_prompt round
        expectUiPromptPairs(probe);
        expect(probe.events.filter((e) => e.type === "ui_prompt_start").length).toBe(1);
      } finally {
        unhandled.stop();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("T3c-reverse (mounted, claim vs submit, claim first): C5(c) first-come-wins symmetric half — the late submit is a no-op, outcome interrupted; C1/C3; notification still arrives", async () => {
    const probeExt = createAskProbeExtension();
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3c" }), textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      const { runDone, attempt } = await startTuiScenario(harness, probe);
      await attempt.whenMounted;
      const unhandled = trackUnhandledRejections();
      try {
        probe.fire(); // claim("background") + cancel lands first
        probe.answer(2); // the LOSING side arrives late: race.claim("tui") must fail, no done()
        await oneMacrotask();
        // C5(c) reverse — first-come-wins: outcome stays interrupted, the late submit produced
        // no answer and no second done()
        expect(attempt.outcome).toEqual({ kind: "interrupted" });
        expect(unhandled.seen).toEqual([]); // C1
        // C3 — dispose exactly once; the component never saw the late submit as input
        expect(attempt.disposed).toBe(1);
        expect(attempt.inputs).toEqual([]);
        const rendersAfterClose = attempt.renders;
        // C2 — editor restored; a printable keystroke lands in the editor, not the component
        expectDraftRestoredAndTypedInto(harness, "", "abc");
        expect(attempt.renders).toBe(rendersAfterClose);
        expect(attempt.inputs).toEqual([]);
        await runDone;
        // The notification still arrives, after the (interrupted) tool result
        expectNotificationAfterToolResult(harness.modelRuntime.requestMessages[1] ?? [], "bg-done-0");
        expect(harness.modelRuntime.callCount()).toBe(2);
        expectUiPromptPairs(probe); // C4
      } finally {
        unhandled.stop();
      }
    } finally {
      await harness.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite B: C6–C11 delivery semantics (bindExtensions, no TUI)
// ---------------------------------------------------------------------------

describe("S0 pi delivery semantics (C6–C11)", () => {
  it("C6+C7: interrupt sends the notification as steer; next request is assistant(toolCall) → toolResult → custom, content untouched, no extra run", async () => {
    await withDeliverySession(
      { scripted: [toolTurn("ask_probe", { timing: "plain" }), textTurn("done")] },
      async ({ session, probe, requestMessages, callCount }) => {
        const runDone = session.prompt("go");
        const attempt = await until(() => probe.attempts[0], "attempt");
        await attempt.whenEntered;
        probe.fire();
        await runDone;
        expect(attempt.outcome).toEqual({ kind: "interrupted" });
        // C6 — injected after the tool result, before the next model output
        expectNotificationAfterToolResult(requestMessages[1] ?? [], "bg-done-0");
        expect(callCount()).toBe(2);
        // C7 — the extension's message_start saw the custom message with content === (string identity)
        expect(probe.customMessages.length).toBeGreaterThanOrEqual(1);
        const seen = probe.customMessages.find((m) => m.content === "bg-done-0");
        expect(seen).toBeDefined();
        expect(seen?.customType).toBe(PROBE_CUSTOM_TYPE);
      },
    );
  });

  it("C8: pi.sendMessage returns synchronously-steered — hasQueuedMessages() is true in the same tick", async () => {
    await withDeliverySession(
      { scripted: [toolTurn("ask_probe", { timing: "plain" }), textTurn("done")] },
      async ({ session, probe }) => {
        const runDone = session.prompt("go");
        const attempt = await until(() => probe.attempts[0], "attempt");
        await attempt.whenEntered;
        probe.send("same-tick-check");
        // No await between send and the check — compat assumption A1 (plan §3.2)
        expect(session.agent.hasQueuedMessages()).toBe(true);
        probe.answer(1);
        await runDone;
      },
    );
  });

  it("C9: one-at-a-time — 3 sends while hanging each ride their own boundary, exactly 1 per request, in send order", async () => {
    await withDeliverySession(
      {
        scripted: [
          toolTurn("ask_probe", { timing: "plain" }),
          toolTurn("ask_probe", { timing: "plain" }),
          toolTurn("ask_probe", { timing: "plain" }),
          textTurn("done"),
        ],
        steeringMode: "one-at-a-time",
      },
      async ({ session, probe, requestMessages, callCount }) => {
        const runDone = session.prompt("go");
        const payloads = ["notice-1", "notice-2", "notice-3"];
        for (let i = 0; i < 3; i++) {
          const attempt = await until(() => probe.attempts[i], `attempt ${i}`);
          await attempt.whenEntered;
          probe.send(payloads[i]!);
          probe.answer(1); // settle the batch -> boundary -> next request
        }
        await runDone;
        expect(callCount()).toBe(4); // 3 boundaries, no extra runs
        for (let i = 0; i < 3; i++)
          expect(customContents(requestMessages[i + 1] ?? [], payloads)).toEqual([payloads[i]!]);
      },
    );
  });

  it("C10: all — 3 sends while hanging all land in ONE request, in send order", async () => {
    await withDeliverySession(
      { scripted: [toolTurn("ask_probe", { timing: "plain" }), textTurn("done")], steeringMode: "all" },
      async ({ session, probe, requestMessages, callCount }) => {
        const runDone = session.prompt("go");
        const attempt = await until(() => probe.attempts[0], "attempt");
        await attempt.whenEntered;
        probe.send("notice-1");
        probe.send("notice-2");
        probe.send("notice-3");
        probe.answer(1);
        await runDone;
        expect(callCount()).toBe(2);
        expect(customContents(requestMessages[1] ?? [], ["notice-1", "notice-2", "notice-3"])).toEqual([
          "notice-1",
          "notice-2",
          "notice-3",
        ]);
      },
    );
  });

  it("C11: idle send with triggerTurn starts a new run; the custom message_start arrives inside that run", async () => {
    await withDeliverySession(
      { scripted: [textTurn("one"), textTurn("two")] },
      async ({ session, probe, callCount }) => {
        await session.prompt("hello");
        expect(callCount()).toBe(1); // agent idle
        probe.send("idle-notice");
        await until(() => callCount() === 2, "second run");
        await until(() => probe.customMessages.some((m) => m.content === "idle-notice"), "custom message_start");
        await until(() => probe.events.filter((e) => e.type === "agent_end").length === 2, "second run settled");
        // The custom's message_start must be INSIDE the second agent run (between its
        // agent_start and agent_end) — the "does not count tokens while idle" premise (§1.4/A4).
        const agentStartSeqs = probe.events.filter((e) => e.type === "agent_start").map((e) => e.seq);
        const agentEndSeqs = probe.events.filter((e) => e.type === "agent_end").map((e) => e.seq);
        expect(agentStartSeqs.length).toBe(2);
        expect(agentEndSeqs.length).toBe(2);
        const customSeq = probe.events.find((e) => e.type === "message_start" && e.role === "custom")?.seq;
        expect(customSeq).toBeDefined();
        expect(customSeq!).toBeGreaterThan(agentStartSeqs[1]!);
        expect(customSeq!).toBeLessThan(agentEndSeqs[1]!);
      },
    );
  });
});
