import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DriverEvent } from "../../src/core/types.js";
import { PiSessionDriver, type PiSessionHandle, type SessionHandle } from "../../src/runtime/session-driver.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { snapshot, target } from "../helpers/fabric-inbox.js";
import { applyDiag } from "../helpers/fabric-revive.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * W6 end to end on a REAL stack: two running sender runs wake the same finished run through their REAL
 * `message_agent` tools; the second coalesces into the revived run. When it ends, each sender receives exactly one
 * `wake_result` steer (level inherited from the revived run), and the owner's completion is quiet.
 */
let home: ReturnType<typeof sandboxHome>;
const dirs: string[] = [];
const stacks: Stack[] = [];
beforeEach(() => {
  home = sandboxHome();
});
afterEach(() => {
  for (const s of stacks.splice(0)) {
    s.fabric?.dispose();
    s.worktreeLate?.dispose();
    s.bashJobs?.dispose();
    s.keepalive?.dispose();
    s.quota?.dispose();
  }
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  home.restore();
});
const worker = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" as const };
const waker = { ...worker, name: "waker", canMessage: ["sibling" as const] };
const types = {
  get: (n: string) => (n === "worker" ? worker : n === "waker" ? waker : undefined),
  list: () => [worker, waker],
  reload: async () => ({ types: [worker, waker], errors: [] }),
  configHashOf: () => undefined,
} as AgentTypeRegistry;
const settings: AgentSettings = {
  ...DEFAULT_SETTINGS,
  fleetWidget: false,
  fabric: {
    ...DEFAULT_SETTINGS.fabric,
    enabled: true,
    wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: true },
    minIntervalMs: 0,
    rootMinIntervalMs: 0,
  },
  bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
};
async function until(check: () => boolean, ms = 4000) {
  for (let i = 0; i < ms / 5; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}
type MessageTool = { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> };

describe("W6 subscribers end to end (real stack, real message_agent tools)", () => {
  it("both senders get exactly one wake_result; the owner's completion is quiet", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const dir = mkdtempSync(join(tmpdir(), "w6-subs-"));
    dirs.push(dir);
    const file = join(dir, "child.jsonl");
    writeFileSync(file, "persisted child session");
    const prev = snapshot(target, { status: "completed", phase: "settled", updatedAt: Date.now() });
    applyDiag(prev.diag, { sessionFile: file, agentType: "worker", label: "old-worker", wakeExclusion: "none" });
    sm.appendCustomEntry("subagent:run", prev);
    const sendMessage = vi.fn();
    const pi = {
      appendEntry: (k: string, d: unknown) => sm.appendCustomEntry(k, d),
      sendMessage,
      registerEntryRenderer() {},
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
      events: { on: () => () => undefined, emit() {} },
    } as unknown as ExtensionAPI;
    const ctx = {
      sessionManager: sm,
      cwd: process.cwd(),
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: {},
    } as unknown as ExtensionContext;

    // scripted sessions: wakers hang until released; the revived run finishes on demand
    const wakerTools: MessageTool[] = [];
    const wakerSteers: string[][] = [];
    const wakerRelease: (() => void)[] = [];
    const callbacks = new Map<SessionHandle, (e: DriverEvent) => void>();
    const reviveSteers: string[] = [];
    let finishRevived: (() => void) | undefined;
    const base = (steers: string[]): Omit<SessionHandle, "prompt"> => ({
      sessionId: "w6-child",
      sessionFile: undefined,
      steer: async (t: string) => {
        steers.push(t);
      },
      requestAbort: async () => undefined,
      dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
      killableHandles: new Set(),
      setActiveTools() {},
      getActiveTools: () => [],
      getLastAssistantText: () => "revived answer",
      getUsage: () => undefined,
    });
    vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation((async (spec: { customTools?: unknown[] }) => {
      const steers: string[] = [];
      wakerSteers.push(steers);
      wakerTools.push(
        (spec.customTools ?? []).find((t) => (t as { name?: string }).name === "message_agent") as MessageTool,
      );
      const handle: SessionHandle = {
        ...base(steers),
        prompt: () => {
          callbacks.get(handle)?.({ t: "turn_start" }); // a live turn ⇒ the run reaches `running`
          return new Promise<void>((r) => wakerRelease.push(r));
        },
      };
      return handle;
    }) as never);
    vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation((async () => {
      const handle: SessionHandle = {
        ...base(reviveSteers),
        prompt: () => {
          callbacks.get(handle)?.({ t: "input_accepted" });
          callbacks.get(handle)?.({ t: "turn_start" });
          return new Promise<void>((r) => {
            finishRevived = r;
          });
        },
      };
      return handle as PiSessionHandle;
    }) as never);
    vi.spyOn(PiSessionDriver.prototype, "bind").mockImplementation((async (
      h: SessionHandle,
      cb: (e: DriverEvent) => void,
    ) => {
      callbacks.set(h, cb);
    }) as never);

    const stack = buildSessionStack(pi, ctx, settings, types, []);
    stacks.push(stack);
    const spawnWaker = async () => {
      const r = await stack.spawn.spawn({ type: "waker", prompt: "i am a sender" });
      if (!("runId" in r)) throw new Error(r.error.message);
      await until(() => stack.query.get(r.runId)?.status === "running");
      return r.runId;
    };
    const a = await spawnWaker();
    const b = await spawnWaker();
    await until(() => wakerTools.length === 2);

    // A wakes the finished run through its real tool ⇒ revive
    const first = await wakerTools[0]!.execute("t1", {
      to: target,
      kind: "finding",
      text: "wake: please redo",
      wake: true,
    });
    expect(first.details).toMatchObject({ ok: true, status: "accepted", wake: true });
    await until(() => finishRevived !== undefined);
    const revived = stack.query.list().find((s) => s.diag.wakeOrigin !== undefined)!;
    await until(() => stack.query.get(revived.runId)?.status === "running");

    // B coalesces into the now-running revived run (redirect steer) and subscribes
    const second = await wakerTools[1]!.execute("t2", { to: target, kind: "finding", text: "me too", wake: true });
    expect(second.details).toMatchObject({ ok: true, status: "accepted", wake: true });
    await until(() => reviveSteers.some((t) => t.includes("me too")));
    expect(stack.query.list().filter((s) => s.diag.wakeOrigin !== undefined)).toHaveLength(1); // one resume only

    // nothing yet: results arrive at terminal
    expect(wakerSteers[0]).toEqual([]);
    expect(wakerSteers[1]).toEqual([]);
    finishRevived!();
    await until(() => stack.query.get(revived.runId)?.status === "completed");
    await until(() => wakerSteers[0]!.length > 0 && wakerSteers[1]!.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    for (const steers of wakerSteers) {
      expect(steers).toHaveLength(1);
      expect(steers[0]).toContain("[fabric wake_result");
      expect(steers[0]).toContain(`run="${revived.runId}"`);
      expect(steers[0]).toContain("revived answer");
    }
    // seam C: the wakers inherited the revived run's effective level (revive hop: origin 0 + 1)
    const level = stack.query.get(revived.runId)!.diag.wakeLevel!;
    expect(level).toBeGreaterThanOrEqual(1);
    for (const id of [a, b]) expect(stack.query.get(id)!.diag.wakeLevel ?? 0).toBeGreaterThanOrEqual(level);

    // the OWNER still gets the (quiet) completion notice
    await until(() =>
      sendMessage.mock.calls.some(([m]) => (m as { details?: { runId?: string } }).details?.runId === revived.runId),
    );
    const notice = sendMessage.mock.calls.find(
      ([m]) => (m as { details?: { runId?: string } }).details?.runId === revived.runId,
    )!;
    expect(notice[1]).toEqual({ triggerTurn: false });
    expect((notice[0] as { details: { quiet?: boolean } }).details.quiet).toBe(true);

    for (const r of wakerRelease) r();
    await until(() => stack.query.get(a)?.status === "completed" && stack.query.get(b)?.status === "completed");
  }, 20_000);
});
