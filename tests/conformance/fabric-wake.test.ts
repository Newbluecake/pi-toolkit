/**
 * W2 peer-upgrade gates C-P1/C-P2 (fabric-cross-session plan v3 §8/R10).
 * Real pi AgentSession + SessionManager.open + PiSessionDriver + RuntimeRunner.
 * Only the provider is scripted, using the existing boundary harness: no network,
 * API keys or opt-in required. These tests assert events AND the resulting evidence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { RunState, SessionSpec } from "../../src/core/types.js";
import { RuntimeRunner, BasicEffectInterpreter } from "../../src/runtime/runner.js";
import { PiSessionDriver, PiSessionHandle, type SessionDriver } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { assistantTextMsg, disposeHarnessDirs, withSession } from "./agent-session-harness.js";

afterEach(disposeHarnessDirs);
const scripted = [
  { toolCall: false, build: (model: Parameters<typeof assistantTextMsg>[0]) => assistantTextMsg(model, "answer") },
];
const budget = { ...DEFAULT_BUDGET, totalMs: 60_000, totalGraceMs: 0 };
function runner(driver: SessionDriver) {
  const clock = new FakeClock();
  const states: RunState[] = [];
  const store = new MemoryRunStore();
  const runtime = new RuntimeRunner({
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store,
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter({
      persist_snapshot: (e) => {
        if (e.kind === "persist_snapshot") store.put(e.snapshot);
      },
    }),
    emit() {},
    deliver() {},
    onStateChange: (_id, state) => {
      states.push(state);
    },
  });
  return { runtime, states, store };
}

describe("fabric wake input markers — real pi contracts", () => {
  it("C-P1: resume prompt emits user message_end for NEW input, and persists inputAcceptedAt", async () => {
    await withSession({ scripted, persist: true, tools: [] }, async ({ session, cwd, modelRuntime }) => {
      await session.prompt("previous turn (must not be mistaken for acceptance)");
      const file = session.sessionFile!;
      expect(existsSync(file)).toBe(true);
      const pi = new PiSessionDriver();
      const raw: Array<{ type: string; message?: { role?: string; content?: unknown } }> = [];
      let resumed: PiSessionHandle | undefined;
      const driver: SessionDriver = {
        create: (spec) => pi.create(spec),
        resume: async (path, spec) => {
          // Dependency injection follows agent-session-harness: real pi, scripted provider only.
          const options = {
            ...spec,
            cwd,
            agentDir: join(cwd, ".pi-agent"),
            modelRuntime,
            resourceLoader: session.resourceLoader,
            settingsManager: session.settingsManager,
            tools: [],
          };
          resumed = (await pi.resume(path, options)) as PiSessionHandle;
          resumed.session.subscribe((event) => raw.push(event as never));
          return resumed;
        },
        bind: (h, cb) => pi.bind(h, cb),
        onLateArrival: (p, cb) => pi.onLateArrival(p, cb),
      };
      const t = runner(driver);
      const outcome = await t.runtime.run(
        { runId: "r_resume_input", prompt: "new resumed input", resumeFrom: file, trackInput: true },
        budget,
      );
      expect(outcome.status).toBe("completed");
      const users = raw.filter((e) => e.type === "message_end" && e.message?.role === "user");
      expect(users).toHaveLength(1);
      expect(JSON.stringify(users[0]!.message?.content)).toContain("new resumed input");
      expect(JSON.stringify(users)).not.toContain("previous turn");
      expect(raw.some((e) => e.type === "turn_start")).toBe(true);
      expect(outcome.diag.promptDispatchedAt).toBe(0);
      expect(outcome.diag.inputAcceptedAt).toBe(0);
      expect(outcome.diag).not.toHaveProperty("promptOutcome");
      expect(t.states.some((s) => s.status !== "completed" && s.diag.inputAcceptedAt === 0)).toBe(true);
      expect(t.store.get("r_resume_input")?.outcome?.diag.inputAcceptedAt).toBe(0);
      expect(
        resumed!.session.sessionManager
          .getBranch()
          .some(
            (e) =>
              e.type === "message" &&
              e.message.role === "user" &&
              JSON.stringify(e.message.content).includes("new resumed input"),
          ),
      ).toBe(true);
    });
  });

  it("C-P2: invalid (missing) model rejects prompt before turn_start / user acceptance", async () => {
    await withSession({ scripted, tools: [] }, async ({ session, modelRuntime }) => {
      // AgentSession's documented prompt preflight: no selected model. Public Agent state,
      // not a mocked prompt or injected rejection; no provider request should be made.
      session.agent.state.model = undefined as never;
      const raw: Array<{ type: string; message?: { role?: string } }> = [];
      session.subscribe((event) => raw.push(event as never));
      const pi = new PiSessionDriver();
      const handle = new PiSessionHandle(session);
      const driver: SessionDriver = {
        create: async (_spec: SessionSpec) => handle,
        bind: (h, cb) => pi.bind(h, cb),
        onLateArrival: (p, cb) => pi.onLateArrival(p, cb),
      };
      const t = runner(driver);
      const outcome = await t.runtime.run(
        { runId: "r_rejected_input", prompt: "refuse this before run", trackInput: true },
        budget,
      );
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.message).toMatch(/no model/i);
      expect(raw.filter((e) => e.type === "turn_start")).toEqual([]);
      expect(raw.filter((e) => e.type === "message_end" && e.message?.role === "user")).toEqual([]);
      expect(modelRuntime.callCount()).toBe(0);
      expect(outcome.diag.promptDispatchedAt).toBe(0);
      expect(outcome.diag).not.toHaveProperty("inputAcceptedAt");
      expect(outcome.diag).not.toHaveProperty("lastTurnStartAt");
      expect(outcome.diag.promptOutcome).toBe("rejected_pre_accept");
      expect(t.store.get("r_rejected_input")?.outcome?.diag.promptOutcome).toBe("rejected_pre_accept");
    });
  });
});
