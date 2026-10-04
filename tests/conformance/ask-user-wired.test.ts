/**
 * P2-5 conformance (ask-user-async plan §10 P2-5): re-run the S0 criteria that survive REAL
 * wiring — real `wireAskUser` (src/ask-user/index.ts default export), the real
 * background-completion hub (src/service/background-completions.ts), and real background bash
 * notifications driven by a real `BashJobManager` whose `notify` rides the hub's
 * `createSender(pi.sendMessage)` — instead of S0's `ask_probe` stand-in.
 *
 * What changes versus S0 (tests/conformance/ask-user-interrupt.test.ts), and why:
 *  - The interrupt is no longer a synchronous `probe.fire()`: it is produced by the REAL
 *    coordinator (InterruptCoordinator) from a REAL hub broadcast, so it lands at the earliest
 *    `delayMs` after the broadcast plus one macrotask (the coordinator's schedule(0) floor).
 *    C1's "resolves within 1 macrotask" is therefore adapted to "resolves promptly (bounded
 *    wall clock), outcome interrupted, zero unhandled rejections".
 *  - T2 (claim in the factory→mount microtask gap) is UNREACHABLE under real wiring: the
 *    coordinator's interrupt always comes from a macrotask timer, never from the microtask
 *    gap. The "before the dialog" half of the timing matrix is covered by what real wiring
 *    can actually produce: a QUEUED ask interrupted without ever calling ui.custom (W2) and
 *    the §5.4 deferred path (W4).
 *  - T3(c)'s same-tick submit-vs-claim race degenerates: the interrupt can never win a tick
 *    against a keystroke (it is ≥1 macrotask away), so "submit first ⇒ answered, notice still
 *    arrives" is the only reachable branch (W3).
 *  - C3's dispose-count assertion needs an instrumented component; the real AskUserComponent
 *    is not observable that way from outside. The close-path half (showExtensionCustom.close:
 *    dispose exactly once, no post-close render/input) stays pinned by S0's recording probe —
 *    the wired rerun asserts the externally visible half (editor restore + input routing +
 *    exactly-one ui_prompt pair per dialog).
 *  - P1's documented `closeSessionAsBackground` cast (index.ts: the `("background","aborted")`
 *    close that P3 will type properly) is asserted via a recording remote port on BOTH the
 *    interrupted and the deferred outcomes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import wireAskUser from "../../src/ask-user/index.js";
import type { AskUserComponent } from "../../src/ask-user/component.js";
import type { AskUserRemoteSession, RemoteOutcome } from "../../src/ask-user/remote.js";
import type { BackgroundCompletion } from "../../src/ask-user/background.js";
import { createBashJobManager, type BashJobManager } from "../../src/bash/manager.js";
import { createJobStore } from "../../src/bash/job-store.js";
import { createProcessPort } from "../../src/bash/process.js";
import { systemClock } from "../../src/core/clock.js";
import {
  createBackgroundCompletionHub,
  type BackgroundCompletionHub,
  type SendCompletion,
} from "../../src/service/background-completions.js";
import { formatBashJobNotification } from "../../src/stack.js";
import { mockTui, stubTheme } from "../ask-user/fixtures.js";
import {
  createTuiHarness,
  fakeModel,
  fakeModelRuntime,
  assistantToolCallMsg,
  textTurn,
  toolTurn,
  type FakeModel,
  type ScriptedTurn,
  type TuiHarness,
} from "./tui-harness.js";

const DRAFT = "draft-xyz";
/** ask_user args shared by every scenario (the re-ask must reuse them for the fingerprint). */
const ASK_PARAMS = {
  questions: [{ question: "WiredGate decision?", options: [{ label: "Alpha" }, { label: "Beta" }] }],
};
/** Real-wiring interrupt settings: 30ms merge window, no quiet/defer/dwell protection. */
const INTERRUPT = {
  enabled: true,
  delayMs: 30,
  quietMs: 0,
  maxDeferMs: 0,
  reaskDwellMs: 0,
  maxPerQuestion: 3,
  rpc: false,
};

// ---------------------------------------------------------------------------
// small helpers (S0 file keeps its own copies; these are the wired variants)
// ---------------------------------------------------------------------------

function oneMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function trackUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  return { seen, stop: () => process.off("unhandledRejection", handler) };
}

async function until<T>(fn: () => T | undefined | false, what = "condition"): Promise<T> {
  for (let i = 0; i < 1000; i++) {
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

/** All toolResult texts of one request (a batch may carry several). */
function toolResultTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const m of classifyRequestMessages(messages)) {
    if (!m.toolResult || !Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type?: string; text?: string }>)
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

/** Injected custom notices in the tail after the LAST toolResult (converted user-role text
 *  messages; earlier requests' notices stay in carried-over history and must not re-count).
 *  Returns the raw text blocks in order. */
function noticeTexts(messages: unknown[], accepted: string[]): string[] {
  const cls = classifyRequestMessages(messages);
  const lastToolResultIdx = cls.map((m) => m.toolResult).lastIndexOf(true);
  const tail = cls.slice(lastToolResultIdx + 1);
  const texts: string[] = [];
  for (const m of tail) {
    if (m.role !== "user" || !Array.isArray(m.content) || m.content.length !== 1) continue;
    const block = m.content[0] as { type?: string; text?: string };
    if (block?.type === "text" && typeof block.text === "string" && accepted.includes(block.text))
      texts.push(block.text);
  }
  return texts;
}

/** C6: within a request the injected notification sits right after assistant(toolCall) →
 *  toolResult, content byte-identical to what the hub's sender handed pi.sendMessage. */
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
  expect(noticeTexts(messages, [expectedContent])).toEqual([expectedContent]);
}

/** C4: ui_prompt_start/ui_prompt_end strictly interleaved. */
function expectUiPromptPairs(uiPrompts: string[]): void {
  expect(uiPrompts.length % 2).toBe(0);
  for (let i = 0; i < uiPrompts.length; i += 2) {
    expect(uiPrompts[i]).toBe("start");
    expect(uiPrompts[i + 1]).toBe("end");
  }
}

/** C2: editor visible holding the draft (+ anything typed since), further keystrokes land IN it. */
function expectDraftRestoredAndTypedInto(harness: TuiHarness, typedSoFar: string, ...keystrokes: string[]): void {
  const before = harness.renderFullFrame();
  expect(before.some((l) => l.includes(DRAFT))).toBe(true);
  for (const key of keystrokes) harness.terminal.type(key);
  const after = harness.renderFullFrame();
  const expected = DRAFT + typedSoFar + keystrokes.join("");
  expect(after.some((l) => l.replace(/\s/g, "").includes(expected.replace(/\s/g, "")))).toBe(true);
}

// ---------------------------------------------------------------------------
// the wired extension: REAL wireAskUser + REAL hub + REAL BashJobManager notify
// ---------------------------------------------------------------------------

class RecordingRemoteSession implements AskUserRemoteSession {
  private callback?: (outcome: RemoteOutcome) => boolean;
  /** Receives `["background","aborted"]` through P1's documented cast — the field is
   *  deliberately wider than the declared signature so the cast path is recorded verbatim. */
  closed: [string, string] | undefined;
  setOnRemote(callback: (outcome: RemoteOutcome) => boolean): void {
    this.callback = callback;
  }
  close(by: "tui" | "abort" | "error", outcome: "answered" | "cancelled" | "aborted"): void {
    this.closed = [by, outcome];
  }
}

interface EventLogEntry {
  type: string;
  seq: number;
  role?: string | undefined;
}

interface WiredAsk {
  factory: ExtensionFactory;
  hub: BackgroundCompletionHub;
  /** Every BackgroundCompletion the hub broadcast (the coordinator's real input). */
  completions: BackgroundCompletion[];
  /** role-"custom" message_start payloads seen by this extension (C7). */
  customMessages: Array<{ customType: string; content: unknown }>;
  uiPrompts: string[];
  events: EventLogEntry[];
  remoteSessions: RecordingRemoteSession[];
  sendCompletion: () => SendCompletion;
  /** Create a REAL background bash job and wait for its process to exit; the manager's
   *  settle finalization then fires notify → hub sendCompletion asynchronously. */
  settleBash(command?: string): Promise<void>;
  dispose(): Promise<void>;
}

function createWiredAskExtension(opts: { tmpRoot: string; interrupt: unknown }): WiredAsk {
  let streaming = false;
  let seq = 0;
  let manager: BashJobManager | undefined;
  let sender: SendCompletion | undefined;
  const hub = createBackgroundCompletionHub({ isStreaming: () => streaming, now: () => Date.now() });
  const completions: BackgroundCompletion[] = [];
  hub.subscribe((event) => completions.push(event));
  const customMessages: WiredAsk["customMessages"] = [];
  const uiPrompts: string[] = [];
  const events: EventLogEntry[] = [];
  const remoteSessions: RecordingRemoteSession[] = [];
  const log = (type: string, role?: string): void => {
    events.push({ type, seq: seq++, ...(role === undefined ? {} : { role }) });
  };

  const factory: ExtensionFactory = (pi) => {
    sender = hub.createSender((message, options) => pi.sendMessage(message, options));
    pi.on("agent_start", () => {
      streaming = true;
      log("agent_start");
    });
    pi.on("agent_end", () => {
      streaming = false;
      hub.noteAgentEnd();
      log("agent_end");
    });
    pi.on("agent_settled", () => {
      streaming = false;
      hub.noteAgentSettled();
    });
    pi.on("message_start", (event) => {
      const message = (event as { message?: { role?: string; customType?: string; content?: unknown } }).message;
      hub.noteMessageStart(message ?? {});
      log("message_start", message?.role);
      if (message?.role === "custom")
        customMessages.push({ customType: message.customType ?? "?", content: message.content });
    });
    pi.on("ui_prompt_start", () => {
      uiPrompts.push("start");
    });
    pi.on("ui_prompt_end", () => {
      uiPrompts.push("end");
    });

    // The REAL ask_user, wired the way src/index.ts:287 wires it (minus the holder indirection).
    wireAskUser(pi, {
      background: () => hub,
      interrupt: () => opts.interrupt,
      remote: () => ({
        open: () => {
          const session = new RecordingRemoteSession();
          remoteSessions.push(session);
          return session;
        },
      }),
    });

    // Deterministic in-batch completion source for the §5.4 deferred scenario: a tool whose
    // execute mints a token through the REAL sender while the batch is still running, so the
    // sibling ask_user in the same batch observes pendingTokens() > 0 before opening.
    pi.registerTool({
      name: "wired_fire",
      label: "Wired Fire",
      description: "P2-5 probe: synchronously sends a background-completion notice via the real hub sender.",
      parameters: Type.Object({ content: Type.String() }),
      execute: async (_id: string, params: { content: string }) => {
        sender?.(
          "subagent",
          { customType: "subagent:notification", content: params.content, display: true },
          { triggerTurn: true },
        );
        return { content: [{ type: "text", text: "fired" }] };
      },
    } as never);

    // REAL background bash: the same construction src/stack.ts's buildBashJobManager uses —
    // real processes, real job store, notify → sendCompletion("bash", …).
    const store = createJobStore({
      dir: join(opts.tmpRoot, "bash-jobs"),
      retentionMs: 3_600_000,
      clock: systemClock,
    });
    manager = createBashJobManager({
      store,
      processPort: createProcessPort(),
      clock: systemClock,
      sessionId: "wired-conformance",
      hostPid: process.pid,
      notify: (record) => {
        sender?.(
          "bash",
          {
            customType: "bash-job:notification",
            content: formatBashJobNotification(record),
            display: true,
            details: { kind: "bash-job", jobId: record.jobId, status: record.status },
          },
          { triggerTurn: true },
        );
      },
    });
  };

  return {
    factory,
    hub,
    completions,
    customMessages,
    uiPrompts,
    events,
    remoteSessions,
    sendCompletion: () => {
      if (sender === undefined) throw new Error("wired extension not activated yet");
      return sender;
    },
    settleBash: async (command = "true") => {
      if (manager === undefined) throw new Error("wired extension not activated yet");
      const job = await manager.create({ command, cwd: process.cwd() });
      // A REAL background job: the tool marks it backgrounded when it leaves the foreground
      // (shouldNotifyJob requires backgroundedAt — a foreground-settled job never notifies).
      await manager.markBackgrounded(job.jobId);
      await job.exit;
    },
    dispose: async () => {
      try {
        manager?.dispose();
      } catch {
        /* best effort */
      }
      hub.dispose();
      await Promise.resolve();
    },
  };
}

/** One assistant turn carrying SEVERAL tool calls (pi runs the batch in parallel). */
function multiToolTurn(calls: Array<{ name: string; args: Record<string, unknown> }>): ScriptedTurn {
  return {
    toolCall: true,
    build: (model: FakeModel) => {
      const base = assistantToolCallMsg(model, "tc-multi-0", calls[0]!.name, calls[0]!.args) as {
        content: unknown[];
      };
      base.content = calls.map((call, index) => ({
        type: "toolCall",
        id: `tc-multi-${index}`,
        name: call.name,
        arguments: call.args,
      }));
      return base;
    },
  };
}

const wiredDirs: string[] = [];
afterEach(() => {
  for (const d of wiredDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function wiredTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-user-wired-"));
  wiredDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Suite A: real InteractiveMode close path under real wiring
// ---------------------------------------------------------------------------

describe("P2-5 wired TUI: real wireAskUser + real hub + real bash (C1–C5 adapted)", () => {
  it("W1 (main path): bash settle interrupts the mounted dialog — C1′ prompt interrupted, C2 editor restored, C4 re-ask works, C6/C7 notice lands verbatim; closeSessionAsBackground cast taken", async () => {
    let releaseTurn2!: () => void;
    const reaskTurn = toolTurn("ask_user", ASK_PARAMS, "tc-reask");
    reaskTurn.gate = new Promise<void>((r) => (releaseTurn2 = r));
    const wired = createWiredAskExtension({
      tmpRoot: wiredTmpRoot(),
      interrupt: INTERRUPT,
    });
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_user", ASK_PARAMS, "tc-ask-1"), reaskTurn, textTurn("done")],
      extensionFactories: [wired.factory],
    });
    const unhandled = trackUnhandledRejections();
    try {
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run wired");
      // Dialog mounted: ui.custom entered (prompt_start) and the editor (holding the draft)
      // is swapped out for the component. The question text itself stays in the transcript
      // forever (renderCall), so it cannot mark open/close — prompt events + draft
      // visibility can.
      await until(
        () => wired.uiPrompts.length === 1 && !harness.renderFullFrame().some((l) => l.includes(DRAFT)),
        "dialog mount",
      );
      await oneMacrotask();

      // REAL background bash completes out-of-stack → notify → mint + broadcast → coordinator.
      const interruptFiredAt = Date.now();
      await wired.settleBash("true");
      await until(() => wired.completions.length === 1, "bash completion broadcast");
      expect(wired.completions[0]).toMatchObject({ kind: "bash", count: 1 });
      expect(wired.completions[0]!.token).toBeTypeOf("number"); // streaming send minted

      // C1′ (adapted): the execute resolves PROMPTLY with the interrupted outcome — the real
      // coordinator lands the interrupt delayMs + ≥1 macrotask after the broadcast, never in
      // the probe's single macrotask.
      await until(
        () => wired.uiPrompts.length === 2 && harness.renderFullFrame().some((l) => l.includes(DRAFT)),
        "dialog closed + editor restored",
      );
      expect(Date.now() - interruptFiredAt).toBeLessThan(5_000);
      // P1's documented cast path: background win closes the remote session as ("background","aborted").
      expect(wired.remoteSessions.length).toBe(1);
      expect(wired.remoteSessions[0]!.closed).toEqual(["background", "aborted"]);

      // C2 — editor restored with the saved draft; further keystrokes land in the editor.
      expectDraftRestoredAndTypedInto(harness, "", "abc");

      // C6/C7 (real path) — the turn-2 request is assistant(toolCall) → toolResult → the REAL
      // bash notification; the extension's message_start saw byte-identical content.
      await until(() => (harness.modelRuntime.requestMessages[1] ?? []).length > 0, "turn-2 request");
      const bashNotice = wired.customMessages.find((m) => m.customType === "bash-job:notification");
      expect(bashNotice).toBeDefined();
      expectNotificationAfterToolResult(harness.modelRuntime.requestMessages[1] ?? [], bashNotice!.content as string);
      // The tool result carries the §6.2 interrupted boilerplate.
      expect(toolResultTexts(harness.modelRuntime.requestMessages[1] ?? []).join("\n")).toContain(
        "ask_user was interrupted before the user answered",
      );
      // The minted token was confirmed by the boundary's message_start — so the re-ask's
      // pre-open deferred check (§5.4) sees pendingTokens() === 0 and DOES open the dialog.
      expect(wired.hub.tokenState(wired.completions[0]!.token!)).toBe("consumed");

      // C4 — the model's re-ask opens a SECOND dialog that mounts, takes input, submits.
      releaseTurn2();
      await until(
        () => wired.uiPrompts.length === 3 && !harness.renderFullFrame().some((l) => l.includes(DRAFT)),
        "re-ask dialog mount",
      );
      harness.terminal.type("\r"); // submit the default-selected option
      await runDone;
      expect(wired.uiPrompts).toEqual(["start", "end", "start", "end"]);
      expectUiPromptPairs(wired.uiPrompts);
      expect(wired.remoteSessions.length).toBe(2);
      expect(wired.remoteSessions[1]!.closed).toEqual(["tui", "answered"]);
      expect(harness.modelRuntime.callCount()).toBe(3); // no extra agent run
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
      await harness.dispose();
      await wired.dispose();
    }
  });

  it("W2 (queued ask — the reachable T1 analog): one completion settles BOTH asks of a batch without a second dialog; the queued one's remote session is still closed via the cast", async () => {
    const wired = createWiredAskExtension({
      tmpRoot: wiredTmpRoot(),
      interrupt: INTERRUPT,
    });
    const harness = await createTuiHarness({
      scripted: [
        multiToolTurn([
          { name: "ask_user", args: ASK_PARAMS },
          { name: "ask_user", args: ASK_PARAMS },
        ]),
        textTurn("done"),
      ],
      extensionFactories: [wired.factory],
    });
    const unhandled = trackUnhandledRejections();
    try {
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run wired");
      await until(
        () => wired.uiPrompts.length === 1 && !harness.renderFullFrame().some((l) => l.includes(DRAFT)),
        "first dialog mount",
      );
      await oneMacrotask();
      // §5.3: the remote session opens at ENQUEUE time — the web sees the whole queue.
      await until(() => wired.remoteSessions.length === 2, "queued ask's remote session");

      await wired.settleBash("true");
      await until(() => wired.completions.length === 1, "bash completion broadcast");
      await until(
        () => wired.uiPrompts.length === 2 && harness.renderFullFrame().some((l) => l.includes(DRAFT)),
        "dialog closed",
      );
      await runDone;

      // Exactly ONE ui_prompt pair: the queued ask was interrupted before ever calling ui.custom.
      expect(wired.uiPrompts).toEqual(["start", "end"]);
      // Both outcomes are interrupted — the mounted one via component.cancel(), the queued one
      // via queueHandle.wake("interrupted") — and BOTH close their remote session through the
      // P1 cast as ("background","aborted").
      // Both asks settled WITHOUT a second dialog. The mounted one is interrupted via
      // component.cancel(). The queued one has TWO legitimate outcomes under real timing
      // (both §5.3/§5.4-conformant): its interrupt timer may win (outcome interrupted), or
      // the mutex release from the first ask's settle may reach it first — it then acquires
      // and hits the §5.4 pre-open check with the still-unconfirmed token (outcome deferred).
      // Either way: never shown, both remote sessions closed through the P1 cast.
      expect(wired.remoteSessions[0]!.closed).toEqual(["background", "aborted"]);
      expect(wired.remoteSessions[1]!.closed).toEqual(["background", "aborted"]);
      const results = toolResultTexts(harness.modelRuntime.requestMessages[1] ?? []);
      const interrupted = results.filter((t) => t.includes("ask_user was interrupted before the user answered"));
      const deferred = results.filter((t) => t.includes("ask_user was not shown yet"));
      expect(interrupted.length).toBeGreaterThanOrEqual(1);
      expect(interrupted.length + deferred.length).toBe(2);
      // C2 — editor restored with the draft; typing lands in the editor.
      expectDraftRestoredAndTypedInto(harness, "", "abc");
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
      await harness.dispose();
      await wired.dispose();
    }
  });

  it("W3 (submit race, reachable branch): a same-tick submit always beats the coordinator's interrupt — answered wins, the notice still arrives after the answer (C5(c) degenerate, C6)", async () => {
    const wired = createWiredAskExtension({
      tmpRoot: wiredTmpRoot(),
      interrupt: INTERRUPT,
    });
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_user", ASK_PARAMS, "tc-ask-race"), textTurn("done")],
      extensionFactories: [wired.factory],
    });
    const unhandled = trackUnhandledRejections();
    try {
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run wired");
      await until(
        () => wired.uiPrompts.length === 1 && !harness.renderFullFrame().some((l) => l.includes(DRAFT)),
        "dialog mount",
      );
      await oneMacrotask();

      harness.terminal.type("\r"); // submit FIRST…
      await wired.settleBash("true"); // …the REAL job settles asynchronously, after the batch
      await until(() => wired.completions.length === 1, "bash completion broadcast");
      await runDone;

      // Answered wins (deterministic under real wiring: the interrupt is ≥1 macrotask out —
      // here the job hadn't even exited when the batch settled).
      expect(wired.remoteSessions[0]!.closed).toEqual(["tui", "answered"]);
      expect(wired.uiPrompts).toEqual(["start", "end"]);
      // C2 — the close path is the same restoreEditor() regardless of the winner.
      expectDraftRestoredAndTypedInto(harness, "", "abc");
      // C6 variant — the notice still arrives AFTER the answer: the run had already ended, so
      // the triggerTurn send starts a NEW run (C11 semantics; idle ⇒ no token minted) and the
      // notice lands after the (carried-over) tool result in that run's request.
      expect(wired.completions[0]!.token).toBeUndefined();
      const bashNotice = wired.customMessages.find((m) => m.customType === "bash-job:notification");
      await until(() => bashNotice !== undefined || wired.customMessages.length > 0, "bash notice message_start");
      await until(() => harness.modelRuntime.callCount() === 3, "notice-triggered run");
      const notice = wired.customMessages.find((m) => m.customType === "bash-job:notification")!;
      expect(noticeTexts(harness.modelRuntime.requestMessages[2] ?? [], [notice.content as string])).toEqual([
        notice.content as string,
      ]);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
      await harness.dispose();
      await wired.dispose();
    }
  });

  it("W4 (§5.4 deferred under real wiring): a token minted earlier in the SAME batch keeps ask_user from ever opening — deferred outcome, cast close, token confirmed after the batch", async () => {
    const wired = createWiredAskExtension({
      tmpRoot: wiredTmpRoot(),
      interrupt: INTERRUPT,
    });
    const harness = await createTuiHarness({
      scripted: [
        multiToolTurn([
          { name: "wired_fire", args: { content: "defer-notice" } },
          { name: "ask_user", args: ASK_PARAMS },
        ]),
        textTurn("done"),
      ],
      extensionFactories: [wired.factory],
    });
    const unhandled = trackUnhandledRejections();
    try {
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run wired");
      await until(() => wired.completions.length === 1, "completion broadcast");
      await runDone;

      // The dialog NEVER opened (pre-open check saw pendingTokens() > 0)…
      expect(wired.uiPrompts).toEqual([]);
      // …the outcome is the §6.2 deferred text…
      const results = toolResultTexts(harness.modelRuntime.requestMessages[1] ?? []).join("\n");
      expect(results).toContain("ask_user was not shown yet");
      // …and the remote session (opened at enqueue) was closed through the cast.
      expect(wired.remoteSessions.length).toBe(1);
      expect(wired.remoteSessions[0]!.closed).toEqual(["background", "aborted"]);
      // The minted token is confirmed once the batch settles and the boundary injects the notice.
      expect(wired.hub.tokenState(wired.completions[0]!.token!)).toBe("consumed");
      expect(wired.hub.diag.orphaned).toBe(0);
      // C7 — the extension saw the injected custom with byte-identical content.
      expect(wired.customMessages.some((m) => m.content === "defer-notice")).toBe(true);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
      await harness.dispose();
      await wired.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite B: C6–C11 delivery semantics under real wiring (bindExtensions, no TUI)
// ---------------------------------------------------------------------------

interface DeliveryEnv {
  session: AgentSession;
  wired: WiredAsk;
  components: AskUserComponent[];
  requestMessages: unknown[][];
  callCount: () => number;
  /** Programmatically submit the latest dialog (what Enter does on the default option). */
  answerLatest(): void;
}

async function withWiredDeliverySession(
  opts: { scripted: ScriptedTurn[]; steeringMode?: "all" | "one-at-a-time" },
  run: (env: DeliveryEnv) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "ask-user-wired-delivery-"));
  wiredDirs.push(cwd);
  const wired = createWiredAskExtension({ tmpRoot: cwd, interrupt: INTERRUPT });
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [wired.factory] as never,
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
  const components: AskUserComponent[] = [];
  const uiContext = {
    custom: (factoryFn: (tui: never, theme: never, keys: never, done: (result: unknown) => void) => unknown) =>
      new Promise((resolve) => {
        const component = factoryFn(mockTui as never, stubTheme as never, {} as never, (result) =>
          resolve(result),
        ) as AskUserComponent;
        components.push(component);
      }),
  } as unknown as ExtensionUIContext;
  try {
    if (opts.steeringMode) session.setSteeringMode(opts.steeringMode);
    await session.bindExtensions({ uiContext, mode: "tui" });
    await run({
      session,
      wired,
      components,
      requestMessages: modelRuntime.requestMessages,
      callCount: modelRuntime.callCount,
      answerLatest: () => {
        const component = components[components.length - 1];
        if (component === undefined) throw new Error("no dialog to answer");
        component.handleInput("\r");
      },
    });
  } finally {
    session.dispose();
    await wired.dispose();
  }
}

describe("P2-5 wired delivery semantics (C6–C11)", () => {
  it("C6+C7 (real wiring): hub sendCompletion steers the notice; next request is assistant(toolCall) → toolResult → custom, content untouched, token confirmed, no extra run", async () => {
    await withWiredDeliverySession(
      { scripted: [toolTurn("ask_user", ASK_PARAMS, "tc-b1"), textTurn("done")] },
      async ({ session, wired, components, requestMessages, callCount, answerLatest }) => {
        const runDone = session.prompt("go");
        await until(() => components.length === 1, "dialog open");
        wired.sendCompletion()(
          "subagent",
          { customType: "subagent:notification", content: "wired-c6-notice", display: true },
          { triggerTurn: true },
        );
        expect(wired.completions).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);
        answerLatest();
        await runDone;
        expectNotificationAfterToolResult(requestMessages[1] ?? [], "wired-c6-notice");
        expect(callCount()).toBe(2);
        const seen = wired.customMessages.find((m) => m.content === "wired-c6-notice");
        expect(seen).toBeDefined();
        expect(seen?.customType).toBe("subagent:notification");
        expect(wired.hub.tokenState(1)).toBe("consumed");
        expect(wired.hub.diag).toEqual({ mismatch: 0, unmatched: 0, orphaned: 0 });
        expect(wired.remoteSessions[0]?.closed).toEqual(["tui", "answered"]);
      },
    );
  });

  it("C8 (real wiring): sendCompletion returns synchronously-steered — hasQueuedMessages() is true in the same tick (compat assumption A1)", async () => {
    await withWiredDeliverySession(
      { scripted: [toolTurn("ask_user", ASK_PARAMS, "tc-b2"), textTurn("done")] },
      async ({ session, wired, components, answerLatest }) => {
        const runDone = session.prompt("go");
        await until(() => components.length === 1, "dialog open");
        wired.sendCompletion()(
          "bash",
          { customType: "bash-job:notification", content: "wired-c8-notice", display: true },
          { triggerTurn: true },
        );
        // No await between the send and the check — A1.
        expect(session.agent.hasQueuedMessages()).toBe(true);
        answerLatest();
        await runDone;
      },
    );
  });

  it("C9 (real wiring): one-at-a-time — 3 hub sends while hanging each ride their own boundary, exactly 1 per request, in send order, each token confirmed", async () => {
    await withWiredDeliverySession(
      {
        scripted: [
          toolTurn("ask_user", ASK_PARAMS, "tc-b3-1"),
          toolTurn("ask_user", ASK_PARAMS, "tc-b3-2"),
          toolTurn("ask_user", ASK_PARAMS, "tc-b3-3"),
          textTurn("done"),
        ],
        steeringMode: "one-at-a-time",
      },
      async ({ session, wired, components, requestMessages, callCount, answerLatest }) => {
        const runDone = session.prompt("go");
        const payloads = ["wired-notice-1", "wired-notice-2", "wired-notice-3"];
        for (let i = 0; i < 3; i++) {
          await until(() => components.length === i + 1, `dialog ${i}`);
          wired.sendCompletion()(
            "subagent",
            { customType: "subagent:notification", content: payloads[i]!, display: true },
            { triggerTurn: true },
          );
          answerLatest();
        }
        await runDone;
        expect(callCount()).toBe(4); // 3 boundaries, no extra runs
        for (let i = 0; i < 3; i++) expect(noticeTexts(requestMessages[i + 1] ?? [], payloads)).toEqual([payloads[i]!]);
        expect(wired.hub.pendingTokens()).toBe(0);
        expect(wired.hub.diag).toEqual({ mismatch: 0, unmatched: 0, orphaned: 0 });
      },
    );
  });

  it("C10 (real wiring): all — 3 hub sends while hanging land in ONE request, in send order", async () => {
    await withWiredDeliverySession(
      { scripted: [toolTurn("ask_user", ASK_PARAMS, "tc-b4"), textTurn("done")], steeringMode: "all" },
      async ({ session, wired, components, requestMessages, callCount, answerLatest }) => {
        const runDone = session.prompt("go");
        await until(() => components.length === 1, "dialog open");
        const payloads = ["wired-notice-1", "wired-notice-2", "wired-notice-3"];
        for (const payload of payloads)
          wired.sendCompletion()(
            "subagent",
            { customType: "subagent:notification", content: payload, display: true },
            { triggerTurn: true },
          );
        answerLatest();
        await runDone;
        expect(callCount()).toBe(2);
        expect(noticeTexts(requestMessages[1] ?? [], payloads)).toEqual(payloads);
        expect(wired.hub.pendingTokens()).toBe(0);
        expect(wired.hub.diag).toEqual({ mismatch: 0, unmatched: 0, orphaned: 0 });
      },
    );
  });

  it("C11 (real wiring): idle send with triggerTurn starts a new run; the custom message_start arrives inside that run; the hub mints NO token and counts the confirmation unmatched", async () => {
    await withWiredDeliverySession(
      { scripted: [textTurn("one"), textTurn("two")] },
      async ({ session, wired, callCount }) => {
        await session.prompt("hello");
        expect(callCount()).toBe(1); // agent idle
        wired.sendCompletion()(
          "subagent",
          { customType: "subagent:notification", content: "wired-idle-notice", display: true },
          { triggerTurn: true },
        );
        // Non-streaming send: broadcast WITHOUT a token (§3.2).
        expect(wired.completions).toEqual([{ kind: "subagent", count: 1, token: undefined, at: expect.any(Number) }]);
        expect(wired.hub.pendingTokens()).toBe(0);
        await until(() => callCount() === 2, "second run");
        await until(() => wired.customMessages.some((m) => m.content === "wired-idle-notice"), "custom message_start");
        await until(() => wired.events.filter((e) => e.type === "agent_end").length === 2, "second run settled");
        const agentStarts = wired.events.filter((e) => e.type === "agent_start").map((e) => e.seq);
        const agentEnds = wired.events.filter((e) => e.type === "agent_end").map((e) => e.seq);
        const customSeq = wired.events.find((e) => e.type === "message_start" && e.role === "custom")?.seq;
        expect(agentStarts.length).toBe(2);
        expect(agentEnds.length).toBe(2);
        expect(customSeq).toBeDefined();
        expect(customSeq!).toBeGreaterThan(agentStarts[1]!);
        expect(customSeq!).toBeLessThan(agentEnds[1]!);
        // Nothing was pending for that message_start to confirm (§3.4 re-send/idle rule).
        expect(wired.hub.diag.unmatched).toBe(1);
        expect(wired.hub.diag.orphaned).toBe(0);
      },
    );
  });
});
