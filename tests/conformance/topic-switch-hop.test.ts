/**
 * topic-switch S0 package (plan.md §1 "Step 0 — conformance 探针"): real-pi assertions for probes
 * S1-S9, the assumptions P3b's hold/release/recovery machinery is built on. Result: all nine probes
 * confirm the plan's assumptions against real pi (no `it.fails`/skip needed) — see each test's inline
 * comments for exactly what was verified and, for S6/S9, methodology notes (S6: RPC-mode editor text
 * is write-only through `ctx.ui`, confirming §1's fallback is the only possible design, not a gap;
 * S9: the model-runtime-level fake cannot reach the real event's call site, so the harness reproduces
 * the one timing property that matters via `requestOptions.onPayload` instead — see
 * `fakeModelRuntime`'s doc comment). If a future pi upgrade flips any of these, change the relevant
 * `it` to `it.fails` with a comment naming the plan.md §1 fallback P3b must switch to — never silently
 * weaken the assertion.
 *
 * Harness: `topic-switch-runtime-harness.ts`. No topic-switch code is loaded (`src/topic-switch/`
 * does not exist yet — this package runs in parallel with P1-P4); the probe extension injected via
 * `extensionFactories` is this test file's own fixture.
 *
 * pi 1.2 (docs/dev/pi-1.2-compat/plan.md §4): S4's wait condition was revised for the startup
 * window (a run counts as busy only from `_startRun` on, so `!isStreaming` alone is satisfied by
 * the pre-start gap right after the `input` event) and S4b was added as a pi ≥1.2-only contract
 * (back-to-back followUp reinjections each reach the model exactly once). On pi ≤1.1 the same
 * burst LOSES messages — 1.1's release-queue correctness relies on the inter-item barrier
 * (wire.ts's ordered echo + agent_start), which is exactly why S4b is `it.runIf(piMinor >= 2)`.
 */
import { describe, expect, it } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  createProbeHarness,
  sleep,
  textTurn,
  type ProbeEvent,
  type ProbeHooks,
} from "./topic-switch-runtime-harness.js";

/** Reading the pi version in a TEST is fine — I14 only forbids version gates in `src/`. */
const piMinor = Number(VERSION.split(".")[1] ?? 0);

/** Poll until `pred()` is true or `timeoutMs` elapses (every one of our waits must be bounded —
 *  AGENTS.md zero-hang invariant, even in test helpers). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    }
    await sleep(stepMs);
  }
}

function textOf(e: ProbeEvent): string | undefined {
  return typeof e["text"] === "string" ? (e["text"] as string) : undefined;
}

describe("topic-switch conformance S0 — runtime probes S1-S9", () => {
  it("S1: command ctx.newSession({withSession}) — gen1 shutdown(new) -> gen2 start(new) -> withSession, new session id", async () => {
    const hooks: ProbeHooks = {
      commands: {
        go: async (_args, ctx, gen) => {
          const r = await ctx.newSession({
            withSession: async (rctx) => {
              harnessEvents.push({ gen, t: "withSession", sessionId: rctx.sessionManager.getSessionId() });
            },
          });
          harnessEvents.push({ gen, t: "s1-result", cancelled: r.cancelled });
        },
      },
    };
    const harness = await createProbeHarness({ scripted: [textTurn("ok")], hooks });
    const harnessEvents = harness.events; // alias so the command closure above can push into it
    try {
      const oldSessionId = harness.session().sessionManager.getSessionId();
      await harness.session().prompt("/go", { expandPromptTemplates: true });

      const order = harness.events.map((e) => e.t);
      const shutdownIdx = order.indexOf("session_shutdown");
      const startIdx = order.indexOf("session_start", shutdownIdx + 1); // skip gen1's own startup session_start
      const withSessionIdx = order.indexOf("withSession");
      expect(shutdownIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(shutdownIdx);
      expect(withSessionIdx).toBeGreaterThan(startIdx);

      const shutdownEv = harness.events[shutdownIdx]!;
      const startEv = harness.events[startIdx]!;
      expect(shutdownEv["reason"]).toBe("new");
      expect(startEv["reason"]).toBe("new");
      expect(shutdownEv["gen"]).toBe(1);
      expect(startEv["gen"]).toBe(2);

      const withSessionEv = harness.events.find((e) => e.t === "withSession")!;
      expect(withSessionEv["sessionId"]).not.toBe(oldSessionId);
      expect(withSessionEv["sessionId"]).toBe(harness.session().sessionManager.getSessionId());

      const result = harness.events.find((e) => e.t === "s1-result")!;
      expect(result["cancelled"]).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it("S2: rctx.sendUserMessage([text,image]) inside withSession — new-session input, old session untouched, promise resolves after the turn", async () => {
    // A real (tiny, valid) 1x1 PNG — pi resizes/validates inline images and silently drops anything
    // that fails to decode (replaced with a text placeholder), so a synthetic non-image byte string
    // does not exercise this probe.
    const IMG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const hooks: ProbeHooks = {
      commands: {
        go: async (_args, ctx) => {
          await ctx.newSession({
            withSession: async (rctx) => {
              await rctx.sendUserMessage([
                { type: "text", text: "S2-MARKER-TEXT" },
                { type: "image", data: IMG_DATA, mimeType: "image/png" },
              ]);
            },
          });
        },
      },
    };
    const harness = await createProbeHarness({ scripted: [textTurn("got it")], hooks });
    try {
      const oldSession = harness.session();
      await harness.session().prompt("/go", { expandPromptTemplates: true });

      // gen2 input: source extension, 1 image, carrying our marker text.
      const inputEv = harness.events.find((e) => e.t === "input" && textOf(e) === "S2-MARKER-TEXT");
      expect(inputEv).toBeDefined();
      expect(inputEv!["source"]).toBe("extension");
      expect(inputEv!["images"]).toBe(1);

      // The fake model actually received the text + image in its request.
      const reqText = JSON.stringify(harness.modelRuntime.requestMessages);
      expect(reqText).toContain("S2-MARKER-TEXT");
      expect(reqText).toContain(IMG_DATA);

      // Old session's branch has no trace of it.
      const oldBranchText = JSON.stringify(oldSession.sessionManager.getBranch());
      expect(oldBranchText).not.toContain("S2-MARKER-TEXT");

      // The promise returned by prompt("/go") only resolved once the whole turn (model call
      // included) had finished — otherwise callCount() would be 0 here.
      expect(harness.modelRuntime.callCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await harness.dispose();
    }
  });

  it("S3: pi.sendUserMessage('/cmd ...', {expandPromptTemplates:true}) from a timer dispatches the command, bypassing input handlers and the LLM", async () => {
    let inputHandlerCalls = 0;
    const hooks: ProbeHooks = {
      onInput: () => {
        inputHandlerCalls += 1;
        return undefined; // continue
      },
      commands: {
        __go: (_args, ctx) => {
          // S3 only needs to prove the command ran with a real ctx.newSession available.
          expect(typeof ctx.newSession).toBe("function");
        },
      },
    };
    const harness = await createProbeHarness({ scripted: [textTurn("unused")], hooks });
    try {
      setTimeout(() => {
        harness.currentPi().sendUserMessage("/__go n", { expandPromptTemplates: true });
      }, 0);

      await waitUntil(() => harness.events.some((e) => e.t === "command" && e["name"] === "__go"));
      await sleep(30); // let any (unexpected) async follow-up settle before asserting negatives

      expect(inputHandlerCalls).toBe(0);
      expect(harness.modelRuntime.callCount()).toBe(0);
      const reqText = JSON.stringify(harness.modelRuntime.requestMessages);
      expect(reqText).not.toContain("__go");
    } finally {
      await harness.dispose();
    }
  });

  it("S4: reinjection via pi.sendUserMessage(text,{deliverAs:'followUp'}) while idle — handled input leaves no trace, each reinjection is exactly one input event, source extension, streamingBehavior undefined (idle opens a turn immediately; pi 1.2 wait semantics: plan.md §4)", async () => {
    const hooks: ProbeHooks = {
      onInput: (ev) => {
        if (ev.text === "ORIGINAL") return { action: "handled" };
        return undefined;
      },
    };
    const harness = await createProbeHarness({ scripted: [textTurn("ack")], hooks });
    try {
      await harness.session().prompt("ORIGINAL");
      expect(harness.modelRuntime.callCount()).toBe(0);
      // model_change/thinking_level_change bookkeeping entries always exist; the handled input
      // left no "message" entry behind.
      expect(
        harness
          .session()
          .sessionManager.getBranch()
          .some((e) => e.type === "message"),
      ).toBe(false);

      const markers = ["FOLLOWUP-1", "FOLLOWUP-2", "FOLLOWUP-3"];
      for (const [i, marker] of markers.entries()) {
        harness.currentPi().sendUserMessage(marker, { deliverAs: "followUp" });
        await waitUntil(() => harness.events.some((e) => e.t === "input" && textOf(e) === marker));
        // pi 1.2: a run counts as busy only from _startRun on — the input event fires BEFORE
        // that, so `!isStreaming` alone is satisfied by the pre-start gap. Wait for this
        // marker's OWN model call AND the run's end before reinjecting the next one (each
        // marker must open its own idle turn; verified green on pi 1.1 AND 1.2 — plan.md §4.4).
        await waitUntil(() => harness.modelRuntime.callCount() >= i + 1 && !harness.session().isStreaming);
      }

      for (const marker of ["FOLLOWUP-1", "FOLLOWUP-2", "FOLLOWUP-3"]) {
        const matches = harness.events.filter((e) => e.t === "input" && textOf(e) === marker);
        expect(matches).toHaveLength(1);
        expect(matches[0]!["source"]).toBe("extension");
        expect(matches[0]!["streamingBehavior"]).toBeUndefined();
      }
      expect(harness.modelRuntime.callCount()).toBe(3);
      // Each request's LAST followUp marker is that request's own marker: request i carries
      // markers[0..i] with markers[i] exactly once at the tail — one model call each, in order.
      harness.modelRuntime.requestMessages.forEach((messages, i) => {
        const text = JSON.stringify(messages);
        expect(text.lastIndexOf("FOLLOWUP-")).toBe(text.indexOf(markers[i]!));
      });
    } finally {
      await harness.dispose();
    }
  });

  it.runIf(piMinor >= 2)(
    "S4b (pi ≥1.2): back-to-back followUp reinjections from idle — each reaches the model exactly once, in order, one request each",
    async () => {
      // Pins pi 1.2's startup-window semantics — the safety margin topic-switch's release queue
      // relies on there. On pi ≤1.1 the same burst LOSES messages (F2 never reaches the model,
      // no extension_error — plan.md §4.2): 1.1 correctness depends on the inter-item barrier
      // instead, so this test must NOT run there (hence runIf). Version reads live in tests
      // only; `src/` stays version-gate-free (I14).
      const harness = await createProbeHarness({ scripted: [textTurn("ack")] });
      try {
        const markers = ["B-1", "B-2", "B-3"];
        for (const m of markers) harness.currentPi().sendUserMessage(m, { deliverAs: "followUp" });
        await waitUntil(() => harness.modelRuntime.callCount() >= 3 && !harness.session().isStreaming);
        expect(harness.modelRuntime.callCount()).toBe(3);
        expect((JSON.stringify(harness.modelRuntime.requestMessages[2] ?? []).match(/B-\d/g) ?? []).join(",")).toBe(
          markers.join(","),
        );
        expect(harness.events.filter((e) => e.t === "extension_error")).toHaveLength(0);
      } finally {
        await harness.dispose();
      }
    },
  );

  it("S5: pi.sendUserMessage during compaction never reaches the input handler (prompt() throws before _runInputHandlers)", async () => {
    let compactHookResolve:
      ((v: { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } }) => void) | undefined;
    const compactHookCalled = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    const hooks: ProbeHooks = {
      onBeforeCompact: (ev) => {
        compactHookCalled.resolve();
        const leafId = ev.branchEntries[ev.branchEntries.length - 1]!.id;
        return new Promise((resolve) => {
          compactHookResolve = (v) => resolve(v);
          // stash the leaf id where the release call below can reach it
          (compactHookCalled as { leafId?: string }).leafId = leafId;
        });
      },
      commands: {
        go: (_args, ctx) => {
          ctx.compact();
        },
      },
    };
    const harness = await createProbeHarness({
      scripted: [textTurn("turn A"), textTurn("turn B"), textTurn("turn C")],
      hooks,
      settingsJson: { compaction: { keepRecentTokens: 1, reserveTokens: 1 } },
    });
    try {
      // Build up a few real turns so prepareCompaction() has something to cut.
      await harness.session().prompt("message one, needs to be long enough to carry some tokens");
      await harness.session().prompt("message two, needs to be long enough to carry some tokens");
      await harness.session().prompt("message three, needs to be long enough to carry some tokens");

      await harness.session().prompt("/go", { expandPromptTemplates: true });
      await compactHookCalled.promise; // _compactionAbortController is now set, compact() is parked in our hook

      harness.currentPi().sendUserMessage("DURING-COMPACTION");
      await sleep(50);

      const inputEv = harness.events.find((e) => e.t === "input" && textOf(e) === "DURING-COMPACTION");
      expect(inputEv).toBeUndefined();
      const errEv = harness.events.find((e) => e.t === "extension_error" && e["event"] === "send_user_message");
      expect(errEv).toBeDefined();

      const leafId = (compactHookCalled as { leafId?: string }).leafId!;
      compactHookResolve?.({ compaction: { summary: "s5-summary", firstKeptEntryId: leafId, tokensBefore: 1 } });
      await waitUntil(() => harness.events.some((e) => e.t === "session_compact"));
    } finally {
      await harness.dispose();
    }
  });

  it("S7: session_before_switch returning {cancel:true} cancels newSession before teardown — old activation stays alive, no shutdown/start, no withSession", async () => {
    const hooks: ProbeHooks = {
      onBeforeSwitch: () => ({ cancel: true }),
      commands: {
        go: async (_args, ctx, gen) => {
          const r = await ctx.newSession({
            withSession: async () => {
              harnessEvents.push({ gen, t: "withSession-should-not-happen" });
            },
          });
          harnessEvents.push({ gen, t: "s7-result", cancelled: r.cancelled });
        },
      },
    };
    const harness = await createProbeHarness({ scripted: [textTurn("unused")], hooks });
    const harnessEvents = harness.events;
    try {
      const oldSessionId = harness.session().sessionManager.getSessionId();
      await harness.session().prompt("/go", { expandPromptTemplates: true });

      const result = harness.events.find((e) => e.t === "s7-result")!;
      expect(result["cancelled"]).toBe(true);
      expect(harness.events.some((e) => e.t === "session_shutdown")).toBe(false);
      expect(harness.events.some((e) => e.t === "session_start" && e["gen"] !== 1)).toBe(false);
      expect(harness.events.some((e) => e.t === "withSession-should-not-happen")).toBe(false);
      expect(harness.session().sessionManager.getSessionId()).toBe(oldSessionId);
      expect(harness.currentGen()).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("S8: with an agent_start barrier, A then B(followUp) reach the model in that order, each exactly once", async () => {
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const barrierReached = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    const hooks: ProbeHooks = {
      onAgentStart: () => barrierReached.resolve(),
    };
    const harness = await createProbeHarness({
      scripted: [
        {
          toolCall: false,
          build: (m) => ({ ...JSON.parse(JSON.stringify(textTurn("A-done").build(m))) }),
          gate: gateA,
        },
        textTurn("B-done"),
      ],
      hooks,
    });
    try {
      const promptA = harness.session().prompt("A-MARKER");
      await barrierReached.promise;
      harness.currentPi().sendUserMessage("B-MARKER", { deliverAs: "followUp" });
      await sleep(20); // give the followUp queueing a chance to land before releasing A
      releaseA?.();
      await promptA;
      await waitUntil(() => harness.modelRuntime.callCount() >= 2);

      const secondRequestText = JSON.stringify(harness.modelRuntime.requestMessages[1]);
      const idxA = secondRequestText.indexOf("A-MARKER");
      const idxB = secondRequestText.indexOf("B-MARKER");
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThan(idxA);
      expect(secondRequestText.indexOf("A-MARKER", idxA + 1)).toBe(-1); // exactly once
      expect(secondRequestText.indexOf("B-MARKER", idxB + 1)).toBe(-1); // exactly once
    } finally {
      await harness.dispose();
    }
  });

  it("S9: the prompt's user message entry is already in getBranch() before before_provider_request fires", async () => {
    // The real `before_provider_request` hook fires from inside pi-ai's per-provider HTTP code
    // (e.g. `api/anthropic-messages.js`), which a model-runtime-level fake never reaches. The
    // harness's `fakeModelRuntime.streamSimple` instead invokes the SAME `requestOptions.onPayload`
    // callback at the point real pi hands control to the provider layer (confirmed chain:
    // `core/sdk.js`'s `streamFn` builds `requestOptions` by spreading the agent loop's
    // `onPayload: transformProviderPayload` straight through to `modelRuntime.streamSimple`'s 3rd
    // arg), so this reproduces the one thing S9 asks about — branch state at that exact call-time
    // point — without needing a real HTTP layer. See the `fakeModelRuntime` doc comment.
    let sawUserEntryBeforeRequest: boolean | undefined;
    const harness = await createProbeHarness({ scripted: [textTurn("ok")] });
    const pi = harness.currentPi();
    pi.on("before_provider_request", (_ev, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      sawUserEntryBeforeRequest = branch.some(
        (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
      );
      return undefined;
    });
    try {
      await harness.session().prompt("S9-MARKER");
      expect(sawUserEntryBeforeRequest).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("S6: pi.appendEntry during session_shutdown(reload) is readable via getBranch() on the next activation's session_start; editor text set during shutdown is recorded, but NOT readable back through ctx.ui (rpc-mode's getEditorText() is a hardcoded stub)", async () => {
    const hooks: ProbeHooks = {
      onSessionShutdown: (ev, ctx, _gen, pi) => {
        if (ev.reason === "reload") {
          pi.appendEntry("test:s6-marker", { tag: "s6-payload" });
          ctx.ui.setEditorText("s6-editor-marker");
        }
      },
      onSessionStart: (ev, ctx, gen) => {
        if (ev.reason === "reload") {
          const branch = ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
          const found = branch.find((e) => e.type === "custom" && e.customType === "test:s6-marker");
          harness.events.push({ gen, t: "s6-readback", found: found !== undefined, data: found?.data });
        }
      },
    };
    const harness = await createProbeHarness({ scripted: [textTurn("unused")], hooks });
    try {
      await harness.session().reload();

      const readback = harness.events.find((e) => e.t === "s6-readback");
      expect(readback).toBeDefined();
      expect(readback!["found"]).toBe(true);
      expect(readback!["data"]).toEqual({ tag: "s6-payload" });

      // Finding (confirms plan.md §1's S6 fallback applies): the host's editor state is not
      // reachable through `ctx.ui` in rpc-mode — `getEditorText()` always returns "" there
      // (rpc-mode.js: "Synchronous method can't wait for RPC response"), so a shutdown-time
      // `setEditorText` call is observable only as the outgoing RPC request (recorded here), never
      // as something the NEXT activation can read back. P3b.5's "unsent newcomer ⇒ notify-only text
      // preview" fallback is therefore the correct (only possible) design for RPC-bound sessions.
      expect(harness.ui.editorTextCalls).toContain("s6-editor-marker");
    } finally {
      await harness.dispose();
    }
  });
});
