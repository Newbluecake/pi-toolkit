import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "./helpers/home-sandbox.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { buildSessionStack } from "../../src/stack.js";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";
import { WAKE_LEVEL_CUSTOM_TYPE } from "../../src/fabric/wake-level.js";

/**
 * fabric-cross-session plan v3 §3.1 (root matrix) + §3.3 L3/L6 (W1), through the REAL stack assembly: the mailbox's
 * delivery ports (`sendMessage` call shape per matrix column), the causal level's propagation on delivery, the
 * `subagent:wake-level` session entry and its restore on a rebuild. Records are seeded as pending, exactly like
 * fabric-wiring.test.ts's T17.
 */
let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
});

const run = "r_ABCDEFGH" as const;
type Entry = { type: string; customType?: string; data?: unknown };
type Sent = { message: Record<string, unknown>; options: Record<string, unknown> | undefined };

function harness(entries: Entry[]) {
  const sent: Sent[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      sent.push({ message, options });
    },
    registerEntryRenderer() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: { on: () => () => undefined, emit: () => undefined },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => "wake-level-integration",
      getSessionFile: () => "/tmp/wake-level-integration.jsonl",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
  return { pi, ctx, sent };
}
const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;
function settings(wakeEnabled: boolean): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      progressChannel: "context",
      minIntervalMs: 0,
      rootMinIntervalMs: 0,
      wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: wakeEnabled },
    },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
}
function record(patch: Partial<FabricRecord> = {}): FabricRecord {
  return {
    key: makeMessageKey(run, "root", 1, 1),
    from: run,
    to: "root",
    kind: "finding",
    seq: 1,
    generation: 1,
    payload: { text: "result" },
    ttlMs: 100_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: "pending",
    attempts: 0,
    ...patch,
  };
}
const runEntry: Entry = {
  type: "custom",
  customType: "subagent:run",
  data: { runId: run, parentRunId: "root", status: "running" },
};
const fabricEntry = (r: FabricRecord): Entry => ({ type: "custom", customType: "subagent:fabric", data: r });
const levelEntries = (entries: Entry[]) =>
  entries.filter((e) => e.customType === WAKE_LEVEL_CUSTOM_TYPE).map((e) => e.data);
async function deliver(entries: Entry[], wakeEnabled = true) {
  const h = harness(entries);
  const stack = buildSessionStack(h.pi, h.ctx, settings(wakeEnabled), types, []);
  stack.fabric!.pump();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  return { ...h, stack };
}

describe("root matrix — delivery call shape (plan §3.1)", () => {
  it("omitted wake: today's steer + triggerTurn:true call, and the delivery counts as a hop (root L1 → 2)", async () => {
    const entries = [runEntry, fabricEntry(record({ level: 1 }))];
    const { sent, stack } = await deliver(entries);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(stack.wake?.level.root).toBe(2);
    expect(levelEntries(entries)).toEqual([expect.objectContaining({ v: 1, level: 2 })]);
    stack.fabric!.dispose();
  });

  it("explicit wake:true: the IDENTICAL legacy call + a hop", async () => {
    const entries = [runEntry, fabricEntry(record({ level: 1, wake: true }))];
    const { sent, stack } = await deliver(entries);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(stack.wake?.level.root).toBe(2);
    stack.fabric!.dispose();
  });

  it("wake:false: deliver-only sendMessage(…, {triggerTurn:false}), carrying the level WITHOUT counting (root 0 → 1)", async () => {
    const entries = [runEntry, fabricEntry(record({ level: 1, wake: false }))];
    const { sent, stack } = await deliver(entries);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ triggerTurn: false });
    expect(sent[0]!.message).toMatchObject({ customType: "subagent:fabric", display: false });
    expect(stack.wake?.level.root).toBe(1);
    stack.fabric!.dispose();
  });

  it("wake:false progress on the context channel is deliver-only too (the channel change in the matrix)", async () => {
    const entries = [runEntry, fabricEntry(record({ kind: "progress", level: 0, wake: false }))];
    const { sent } = await deliver(entries);
    expect(sent[0]!.options).toEqual({ triggerTurn: false });
  });

  it("legacy progress on the context channel keeps triggerTurn:true", async () => {
    const entries = [runEntry, fabricEntry(record({ kind: "progress", level: 0 }))];
    const { sent } = await deliver(entries);
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });
});

describe("root level persistence (plan §3.3 L6)", () => {
  it("is restored from the session branch on a stack rebuild (/reload) — and a later reset to 0 wins", async () => {
    const entries = [runEntry, fabricEntry(record({ level: 1, wake: true }))];
    const first = await deliver(entries);
    expect(first.stack.wake?.level.root).toBe(2);
    first.stack.fabric!.dispose();

    const second = harness(entries);
    const rebuilt = buildSessionStack(second.pi, second.ctx, settings(true), types, []);
    expect(rebuilt.wake?.level.root).toBe(2); // survived the rebuild
    rebuilt.wake!.level.resetRoot(); // proven human input
    expect(levelEntries(entries).at(-1)).toMatchObject({ v: 1, level: 0 });
    rebuilt.fabric!.dispose();

    const third = harness(entries);
    const again = buildSessionStack(third.pi, third.ctx, settings(true), types, []);
    expect(again.wake?.level.root).toBe(0);
    again.fabric!.dispose();
  });

  it("a fresh session starts at 0 and writes nothing until the level actually changes", () => {
    const entries: Entry[] = [];
    const h = harness(entries);
    const stack = buildSessionStack(h.pi, h.ctx, settings(true), types, []);
    expect(stack.wake?.level.root).toBe(0);
    stack.wake!.level.resetRoot();
    expect(levelEntries(entries)).toEqual([]);
    stack.fabric!.dispose();
  });
});

describe("wake OFF (fabric.wake.enabled=false): nothing new is wired", () => {
  it("no causal level on the stack, no wake-level entry, legacy delivery call, no level propagation", async () => {
    const entries = [runEntry, fabricEntry(record())];
    const { sent, stack } = await deliver(entries, false);
    expect(stack.wake).toBeUndefined();
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(levelEntries(entries)).toEqual([]);
    stack.fabric!.dispose();
  });

  it("a root level persisted earlier is ignored while off (no stack.wake, nothing re-written)", () => {
    const entries: Entry[] = [{ type: "custom", customType: WAKE_LEVEL_CUSTOM_TYPE, data: { v: 1, level: 2, at: 1 } }];
    const h = harness(entries);
    const stack = buildSessionStack(h.pi, h.ctx, settings(false), types, []);
    expect(stack.wake).toBeUndefined();
    expect(levelEntries(entries)).toHaveLength(1);
    stack.fabric!.dispose();
  });
});
