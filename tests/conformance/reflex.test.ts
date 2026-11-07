/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex conformance C-R1…C-R8 (plan R0 step 15; arch §6.3). Real-pi assertions for the premises the
 * R layer's input interception is built on. Re-run on every pi peer bump (`npm run test:conformance`).
 * No reflex code is loaded: the probe extensions injected via `extensionFactories` are this file's fixtures.
 *
 * If a future pi flips one of these, change the `it` to `it.fails` with a comment naming the fallback
 * (plan §9) — never silently weaken the assertion.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { assistantTextMsg, disposeHarnessDirs, withSession, type ScriptedTurn } from "./agent-session-harness.js";
import { createTuiHarness, textTurn as tuiTextTurn } from "./tui-harness.js";

afterEach(() => disposeHarnessDirs());

const textTurn = (text: string): ScriptedTurn => ({ toolCall: false, build: (m) => assistantTextMsg(m, text) });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(5);
  }
}

interface ProbePi {
  on(event: string, handler: (...args: any[]) => unknown): void;
  sendMessage(message: any, options?: any): void;
  appendEntry(customType: string, data?: unknown): void;
}
const probe = (setup: (pi: ProbePi) => void) => (pi: unknown) => setup(pi as ProbePi);
const jsonOf = (messages: unknown[]) => JSON.stringify(messages);

describe("reflex conformance — the pi premises of input interception", () => {
  it("C-R1: input `handled` ⇒ prompt() returns, no agent_start, no model call, no user message entry", async () => {
    const events: string[] = [];
    await withSession(
      {
        scripted: [textTurn("never")],
        extensionFactories: [
          probe((pi) => {
            pi.on("input", () => ({ action: "handled" }));
            pi.on("agent_start", () => void events.push("agent_start"));
          }),
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("RFX-HANDLED-C1");
        expect(events).toEqual([]);
        expect(modelRuntime.callCount()).toBe(0);
        const user = session.sessionManager
          .getEntries()
          .filter((e: any) => e.type === "message" && e.message?.role === "user");
        expect(user).toHaveLength(0);
        expect(session.isStreaming).toBe(false);
      },
    );
  });

  it("C-R2: async input handlers are awaited; `handled` short-circuits later handlers; `continue` passes the text through untouched", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await withSession(
      {
        scripted: [textTurn("ok")],
        extensionFactories: [
          probe((pi) => {
            pi.on("input", async (e: any) => {
              calls.push(`a:${e.text}`);
              await gate;
              return e.text === "STOP-C2" ? { action: "handled" } : { action: "continue" };
            });
            pi.on("input", (e: any) => {
              calls.push(`b:${e.text}`);
              return { action: "continue" };
            });
          }),
        ],
      },
      async ({ session, modelRuntime }) => {
        // handled short-circuits b, and the run never starts
        const p1 = session.prompt("STOP-C2");
        await sleep(30);
        expect(calls).toEqual(["a:STOP-C2"]); // awaited: b has not run while a is pending
        release();
        await p1;
        expect(calls).toEqual(["a:STOP-C2"]);
        expect(modelRuntime.callCount()).toBe(0);
        // continue: b runs and the ORIGINAL text reaches the model
        await session.prompt("KEEP-C2");
        expect(calls).toEqual(["a:STOP-C2", "a:KEEP-C2", "b:KEEP-C2"]);
        expect(modelRuntime.callCount()).toBe(1);
        expect(jsonOf(modelRuntime.requestMessages[0] ?? [])).toContain("KEEP-C2");
      },
    );
  });

  it("C-R3: idle sendMessage({display:true}) without options appends a custom_message, starts no run, and is a user-role text in the next run's context", async () => {
    let send!: () => void;
    await withSession(
      {
        scripted: [textTurn("answer")],
        extensionFactories: [
          probe((pi) => {
            send = () =>
              pi.sendMessage({
                customType: "subagent:reflex",
                content: "<reflex>RFX-CTX-C3</reflex>",
                display: true,
                details: { v: 1 },
              });
          }),
        ],
      },
      async ({ session, modelRuntime }) => {
        send();
        await sleep(30);
        expect(modelRuntime.callCount()).toBe(0);
        const custom = session.sessionManager
          .getEntries()
          .filter((e: any) => e.type === "custom_message" && e.customType === "subagent:reflex");
        expect(custom).toHaveLength(1);
        await session.prompt("next question");
        const ctxMsgs = (modelRuntime.requestMessages[0] ?? []) as any[];
        const hit = ctxMsgs.find((m) => JSON.stringify(m).includes("RFX-CTX-C3"));
        expect(hit?.role).toBe("user");
      },
    );
  });

  it("C-R4: appendEntry entries never enter the next run's context", async () => {
    let append!: () => void;
    await withSession(
      {
        scripted: [textTurn("answer")],
        extensionFactories: [
          probe((pi) => {
            append = () => pi.appendEntry("subagent:reflex-record", { v: 1, marker: "RFX-REC-C4" });
          }),
        ],
      },
      async ({ session, modelRuntime }) => {
        append();
        const entries = session.sessionManager.getEntries() as any[];
        expect(entries.some((e) => e.type === "custom" && e.customType === "subagent:reflex-record")).toBe(true);
        await session.prompt("next question");
        expect(jsonOf(modelRuntime.requestMessages[0] ?? [])).not.toContain("RFX-REC-C4");
      },
    );
  });

  it('C-R5: session.prompt(text) without a source reports source:"interactive" (why the R layer must be post-guard)', async () => {
    const seen: any[] = [];
    await withSession(
      {
        scripted: [textTurn("ok")],
        extensionFactories: [
          probe((pi) => {
            pi.on("input", (e: any) => {
              seen.push({ source: e.source, text: e.text });
              return { action: "continue" };
            });
          }),
        ],
      },
      async ({ session }) => {
        await session.prompt("SRC-C5");
        expect(seen).toEqual([{ source: "interactive", text: "SRC-C5" }]);
      },
    );
  });

  it.todo(
    "C-R6: covered by tests/conformance/topic-switch-hop.test.ts › S5: pi.sendUserMessage during compaction never reaches the input handler (prompt() throws before _runInputHandlers)",
  );
  it("C-R6 reference exists", () => {
    const text = readFileSync(new URL("./topic-switch-hop.test.ts", import.meta.url), "utf8");
    expect(text).toContain('it("S5: pi.sendUserMessage during compaction never reaches the input handler');
  });

  it("C-R7: the TUI main loop is serial — a second submit while an input handler awaits does not run a second handler concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const harness = await createTuiHarness({
      scripted: [tuiTextTurn("ok"), tuiTextTurn("ok")],
      extensionFactories: [
        probe((pi) => {
          pi.on("input", async (e: any) => {
            calls.push(e.text);
            await gate;
            return { action: "handled" };
          });
        }),
      ],
    });
    try {
      // init() is idempotent; run() adds the real main loop (`getUserInput` → `await session.prompt`) on top of it.
      void harness.mode.run().catch(() => undefined);
      harness.terminal.type("FIRST-C7");
      harness.terminal.type("\r");
      await waitUntil(() => calls.length >= 1);
      harness.terminal.type("SECOND-C7");
      harness.terminal.type("\r");
      await sleep(150);
      // concurrency would show a second handler invocation while the first still awaits
      expect(calls).toEqual(["FIRST-C7"]);
      release();
      // the second submit was queued by the main loop, not dropped, and runs strictly after the first finished
      await waitUntil(() => calls.length >= 2);
      expect(calls).toEqual(["FIRST-C7", "SECOND-C7"]);
    } finally {
      release();
      await harness.dispose();
    }
  });

  it('C-R8: ExtensionContext.mode is "tui" under InteractiveMode and not "tui" under the SDK', async () => {
    const sdkModes: unknown[] = [];
    await withSession(
      {
        scripted: [textTurn("ok")],
        extensionFactories: [
          probe((pi) => {
            pi.on("input", (_e: any, ctx: any) => {
              sdkModes.push(ctx.mode);
              return { action: "continue" };
            });
          }),
        ],
      },
      async ({ session }) => {
        await session.prompt("mode probe");
      },
    );
    expect(sdkModes).toHaveLength(1);
    expect(sdkModes[0]).not.toBe("tui");

    const tuiModes: unknown[] = [];
    const harness = await createTuiHarness({
      scripted: [tuiTextTurn("ok")],
      extensionFactories: [
        probe((pi) => {
          pi.on("input", (_e: any, ctx: any) => {
            tuiModes.push(ctx.mode);
            return { action: "handled" };
          });
        }),
      ],
    });
    try {
      void harness.mode.run().catch(() => undefined);
      harness.terminal.type("MODE-C8");
      harness.terminal.type("\r");
      await waitUntil(() => tuiModes.length >= 1);
      expect(tuiModes[0]).toBe("tui");
    } finally {
      await harness.dispose();
    }
  });
});
