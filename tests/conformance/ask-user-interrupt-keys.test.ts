/**
 * P1 §9 measurement (docs/dev/ask-user-async/known-limitations.md): what a keystroke that
 * arrives in the same instant as the interrupt-close actually does once it lands in the
 * EDITOR (the close path restores focus to the editor; S0 covered printable keys — this
 * suite pins Enter and Esc on the REAL InteractiveMode, harness: tui-harness.ts).
 *
 * Measured behavior (pi 0.87.1):
 *  - Esc while the agent is still streaming → pi aborts the in-flight agent work: the pending
 *    tool call settles with an "Operation aborted" toolResult and the run continues with the
 *    model's next step. The editor draft survives. (The residual §9 risk.)
 *  - Enter while streaming → the editor submits the restored draft with
 *    `streamingBehavior: "steer"`; it is injected as a user text message in the NEXT model
 *    request.
 *  - Enter after the run went idle → the editor pushes the draft onto InteractiveMode's
 *    `pendingUserInputs` (in production the REPL input loop submits it as the next user
 *    message; the harness never runs that loop, so we pin the queue itself).
 */
import { describe, expect, it } from "vitest";
import { createAskProbeExtension } from "./ask-probe.js";
import { createTuiHarness, textTurn, toolTurn } from "./tui-harness.js";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = fn();
    if (value !== undefined && value !== false && value !== null) return value;
    await wait(2);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const DRAFT = "draft-xyz";

interface BranchEntry {
  type?: string;
  customType?: string;
  message?: { role?: string; content?: unknown };
}

function branchEntries(session: { sessionManager: { getBranch(): unknown[] } }): BranchEntry[] {
  return session.sessionManager.getBranch() as BranchEntry[];
}

function toolResultTexts(entries: BranchEntry[]): string[] {
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; text?: string }[]) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts;
}

describe("§9: keystrokes landing in the editor at the close instant", () => {
  it("Esc while streaming aborts the in-flight agent work (Operation aborted); the draft survives", async () => {
    const probeExt = createAskProbeExtension();
    let releaseTurn2!: () => void;
    const turn2 = toolTurn("ask_probe", { timing: "T3a" }); // a SECOND probe call we can watch
    turn2.gate = new Promise<void>((resolve) => {
      releaseTurn2 = resolve;
    });
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3a" }), turn2, textTurn("turn-3")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run probe");
      const attempt = await until(() => probe.attempts[0], "first attempt");
      await attempt.whenMounted;
      probe.fire(); // interrupt: close() restores the editor (focus + draft)
      await until(() => harness.modelRuntime.callCount() === 2, "turn-2 model call");
      // The Esc lands in the EDITOR while the agent is still streaming (turn 2 gated).
      harness.terminal.type("\x1b");
      await wait(50);
      releaseTurn2();
      await runDone;
      // Measured: turn 2's tool call never executed (its probe dialog never opened) and
      // settled as "Operation aborted"; the run continued to turn 3.
      expect(probe.attempts).toHaveLength(1);
      expect(toolResultTexts(branchEntries(harness.session))).toContain("Operation aborted");
      expect(harness.modelRuntime.callCount()).toBe(3);
      // The editor draft survives the abort.
      expect(harness.renderFullFrame().some((line) => line.includes(DRAFT))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("Enter while streaming steer-submits the restored draft into the next model request", async () => {
    const probeExt = createAskProbeExtension();
    let releaseTurn2!: () => void;
    const turn2 = textTurn("done");
    turn2.gate = new Promise<void>((resolve) => {
      releaseTurn2 = resolve;
    });
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3a" }), turn2, textTurn("after-draft")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run probe");
      const attempt = await until(() => probe.attempts[0], "first attempt");
      await attempt.whenMounted;
      probe.fire();
      await until(() => harness.modelRuntime.callCount() === 2, "turn-2 model call");
      harness.terminal.type("\r"); // lands in the editor: submit with streamingBehavior "steer"
      await wait(50);
      releaseTurn2();
      await until(() => harness.modelRuntime.callCount() === 3, "turn-3 model call");
      // Measured: the draft arrives as a user text message in the NEXT request.
      const third = JSON.stringify(harness.modelRuntime.requestMessages[2]);
      expect(third).toContain(`"role":"user"`);
      expect(third).toContain(DRAFT);
      await runDone;
      // (The draft text now also renders in the chat transcript as the steered user message,
      // so screen content cannot pin the editor-clear — the request above is the real pin.)
    } finally {
      await harness.dispose();
    }
  });

  it("Enter after the run went idle queues the draft as the next user input", async () => {
    const probeExt = createAskProbeExtension();
    const harness = await createTuiHarness({
      scripted: [toolTurn("ask_probe", { timing: "T3a" }), textTurn("done")],
      extensionFactories: [probeExt.factory],
    });
    try {
      const probe = probeExt.probe;
      harness.terminal.type(DRAFT);
      const runDone = harness.session.prompt("run probe");
      const attempt = await until(() => probe.attempts[0], "first attempt");
      await attempt.whenMounted;
      probe.fire();
      await runDone; // the run is fully over: the agent is idle
      await wait(20);
      harness.terminal.type("\r");
      await wait(50);
      // Measured: no new run starts from the tool side; the draft sits in InteractiveMode's
      // pendingUserInputs. In production the REPL input loop (mode.run(), not used by this
      // harness) submits it as the next user message.
      const mode = harness.mode as unknown as { pendingUserInputs: string[] };
      expect(mode.pendingUserInputs).toContain(DRAFT);
      expect(harness.modelRuntime.callCount()).toBe(2);
    } finally {
      await harness.dispose();
    }
  });
});
