import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { markLiveSessionFile, releaseLiveSessionFile } from "../../src/core/live-session-files.js";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";
import type { DriverEvent, RunSnapshot } from "../../src/core/types.js";
import { PiSessionDriver, type PiSessionHandle, type SessionHandle } from "../../src/runtime/session-driver.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { inboxRecord, sessionFile, snapshot, target, sender } from "../helpers/fabric-inbox.js";
import { applyDiag, type DiagPatch } from "../helpers/fabric-revive.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * W5 end-to-end: a REAL stack (router, mailbox, WakeService, SpawnService, runner, reducer, outbox, notifier) where a
 * finished run is revived by a `wake:true` message. Only the child session driver is scripted (no network).
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
const types = {
  get: (n: string) => (n === "worker" ? worker : undefined),
  list: () => [worker],
  reload: async () => ({ types: [worker], errors: [] }),
  configHashOf: () => undefined,
} as AgentTypeRegistry;
function settings(wake = true): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: wake },
      minIntervalMs: 0,
      rootMinIntervalMs: 0,
    },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
}
const WAKE_KEY = (n: number) => makeMessageKey(sender, target, 1, n);
function setup(
  opts: {
    wake?: boolean;
    diag?: DiagPatch;
    wakeLevel?: number;
    messages?: string[];
    wakeFlag?: boolean;
  } = {},
) {
  const sm = SessionManager.inMemory(process.cwd());
  const dir = mkdtempSync(join(tmpdir(), "w5-integration-"));
  dirs.push(dir);
  const file = join(dir, "child.jsonl");
  writeFileSync(file, "persisted child session");
  const prev = snapshot(target, { status: "completed", phase: "settled", updatedAt: Date.now() });
  applyDiag(prev.diag, {
    sessionFile: file,
    agentType: "worker",
    label: "worker-label",
    wakeExclusion: "none",
    model: { provider: "pin-provider", id: "pin-model" },
    thinkingLevel: "high",
    ...(opts.wakeLevel === undefined ? {} : { wakeLevel: opts.wakeLevel }),
    ...opts.diag,
  });
  sm.appendCustomEntry("subagent:run", prev);
  const records: FabricRecord[] = (opts.messages ?? ["please look again"]).map((text, i) => {
    const r = inboxRecord({
      key: WAKE_KEY(i + 1),
      seq: i + 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ttlMs: 120_000,
      wake: opts.wakeFlag ?? true,
      level: 1,
      payload: { text },
    });
    delete (r as { parked?: unknown }).parked;
    sm.appendCustomEntry("subagent:fabric", r);
    return r;
  });
  const sendMessage = vi.fn();
  const pi = {
    appendEntry: (kind: string, data: unknown) => sm.appendCustomEntry(kind, data),
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
  const build = () => {
    const stack = buildSessionStack(pi, ctx, settings(opts.wake ?? true), types, []);
    stacks.push(stack);
    return stack;
  };
  const latestOf = (key: string) =>
    sm
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === "subagent:fabric")
      .map((e) => (e as { data: FabricRecord }).data)
      .filter((x) => x.key === key)
      .at(-1)!;
  return { sm, file, pi, ctx, records, build, latestOf, sendMessage };
}
function stubDriver(opts: { gated?: boolean } = {}) {
  let event: ((e: DriverEvent) => void) | undefined;
  let text: string | undefined;
  let release: (() => void) | undefined;
  let open!: () => void;
  const gate = opts.gated ? new Promise<void>((r) => (open = r)) : Promise.resolve();
  const steered: string[] = [];
  const resumeSpecs: { model?: unknown; thinkingLevel?: string }[] = [];
  const handle: SessionHandle = {
    sessionId: "w5-child",
    sessionFile,
    prompt: (input) => {
      text = input;
      event?.({ t: "input_accepted" });
      event?.({ t: "turn_start" });
      return new Promise<void>((r) => {
        release = r;
      });
    },
    steer: async (t: string) => {
      steered.push(t);
    },
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools() {},
    getActiveTools: () => [],
    getLastAssistantText: () => "revived result text",
    getUsage: () => undefined,
  };
  const resume = vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async (_file, spec) => {
    resumeSpecs.push(spec as { model?: unknown; thinkingLevel?: string });
    await gate;
    return handle as PiSessionHandle;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockImplementation(async (_h, cb) => {
    event = cb;
  });
  return {
    get text() {
      return text;
    },
    steered,
    resumeSpecs,
    resume,
    open: () => open(),
    finish: () => release?.(),
  };
}
async function until(check: () => boolean, ms = 3000) {
  for (let i = 0; i < ms / 5; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}
const revivedRun = (stack: Stack, h: ReturnType<typeof setup>): RunSnapshot => {
  const id = h.latestOf(WAKE_KEY(1)).revivedAs!;
  return stack.query.get(id)!;
};

describe("W5 end-to-end: a finished run is revived by a wake:true message", () => {
  it("revives through WakeService (pinned model/thinking, fixed absolute budget, root-direct) and delivers the result to the owner", async () => {
    const h = setup({ wakeLevel: 0 });
    const driver = stubDriver();
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => driver.text !== undefined);
    // the message body rides the reserved inbox block, behind the host banner
    expect(driver.text).toContain("[fabric wake");
    expect(driver.text).toContain("[fabric inbox n=1]");
    expect(driver.text).toContain("please look again");
    // model + thinking are pinned from the original run into the child session spec
    expect(driver.resume).toHaveBeenCalledTimes(1);
    expect(driver.resumeSpecs[0]).toMatchObject({
      model: { provider: "pin-provider", id: "pin-model" },
      thinkingLevel: "high",
    });
    const trigger = h.latestOf(WAKE_KEY(1));
    expect(trigger).toMatchObject({ state: "consumed", terminalReason: "resume_injected" });
    const run = revivedRun(stack, h);
    expect(run.runId).toBe(trigger.revivedAs);
    expect(run.diag).toMatchObject({
      wakeExclusion: "none",
      wakeLevel: 2, // max(origin level 1 + 1, prevFinal 0)
      timeoutPolicy: "fixed",
      wakeOrigin: { by: sender, key: WAKE_KEY(1), level: 1, via: "fabric" },
    });
    expect(JSON.stringify(run.diag.wakeOrigin)).not.toContain("claimToken");
    // absolute deadline: enqueue + resumeBudgetS * 1000 (600 s default), fixed ⇒ no grace window above it
    expect(run.deadlines.deadlineAt! - run.deadlines.enqueuedAt).toBe(600_000);
    expect(run.deadlines.hardDeadlineAt).toBe(run.deadlines.deadlineAt);
    expect(run.parentRunId).toBeUndefined();
    // the persisted run entry carries provenance without the claim token
    const entries = h.sm.getEntries().filter((e) => e.type === "custom" && e.customType === "subagent:run");
    expect(JSON.stringify(entries)).not.toContain("claimToken");
    driver.finish();
    await until(() => stack.query.get(run.runId)?.status === "completed");
    // result delivered to the owner (root) through the normal completion notice
    await until(() =>
      h.sendMessage.mock.calls.some(
        ([m]) =>
          (m as { customType?: string; details?: { runId?: string } }).customType === "subagent:notification" &&
          (m as { details?: { runId?: string } }).details?.runId === run.runId,
      ),
    );
  });

  it("a message that arrives while the run is still reviving JOINS it: one resume, the second text is steered exactly once", async () => {
    const h = setup({ messages: ["first wake", "second wake"] });
    const driver = stubDriver({ gated: true });
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => driver.resume.mock.calls.length === 1);
    stack.fabric!.pump();
    await new Promise((r) => setTimeout(r, 20));
    // starting successor ⇒ the second message waits (not dead-lettered, not steered, not a second revive)
    expect(h.latestOf(WAKE_KEY(2))).toMatchObject({ state: "pending" });
    expect(h.latestOf(WAKE_KEY(2))).not.toHaveProperty("steerAttempt");
    expect(driver.steered).toEqual([]);
    driver.open();
    await until(() => driver.steered.length > 0);
    expect(driver.steered).toHaveLength(1);
    expect(driver.steered[0]).toContain("second wake");
    await until(() => h.latestOf(WAKE_KEY(2)).state === "delivered");
    expect(driver.resume).toHaveBeenCalledTimes(1);
    expect(driver.text).toContain("first wake");
    expect(driver.text).not.toContain("second wake");
    driver.finish();
    await until(() => revivedRun(stack, h)?.status === "completed");
  });
});

describe("W5 refusals and parks (real admission)", () => {
  it("LEGACY entry (no admission verdict) fails closed: wake_refused dead letter, nothing resumed", async () => {
    const h = setup({ diag: { wakeExclusion: undefined } });
    const driver = stubDriver();
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => h.latestOf(WAKE_KEY(1)).state === "dropped");
    expect(h.latestOf(WAKE_KEY(1))).toMatchObject({
      terminalReason: "wake_refused",
      deadLetter: { reason: "wake_refused", detail: "legacy_unknown" },
    });
    expect(driver.resume).not.toHaveBeenCalled();
  });
  it("Q6: a user-stopped run is not revived", async () => {
    const h = setup({ diag: { stopCause: "user_stop" } });
    const driver = stubDriver();
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => h.latestOf(WAKE_KEY(1)).state === "dropped");
    expect(h.latestOf(WAKE_KEY(1))).toMatchObject({ deadLetter: { reason: "wake_refused", detail: "user_aborted" } });
    expect(driver.resume).not.toHaveBeenCalled();
  });
  it("Q4: an external (droid) run is not revived", async () => {
    const h = setup({ diag: { wakeExclusion: "external_agent" } });
    const driver = stubDriver();
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => h.latestOf(WAKE_KEY(1)).state === "dropped");
    expect(h.latestOf(WAKE_KEY(1))).toMatchObject({ deadLetter: { detail: "external_agent" } });
    expect(driver.resume).not.toHaveBeenCalled();
  });
  it("a temporary refusal (session still closing) PARKS the message; a later human resume then carries it", async () => {
    const h = setup();
    const driver = stubDriver();
    markLiveSessionFile(h.file, "r_OLDSTACK");
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => h.latestOf(WAKE_KEY(1)).parked !== undefined);
    expect(h.latestOf(WAKE_KEY(1))).toMatchObject({
      state: "pending",
      wake: true,
      parked: { reason: "session_closing" },
    });
    expect(driver.resume).not.toHaveBeenCalled();
    // not re-attempted by later pumps (no unbounded queue/retry)
    stack.fabric!.pump();
    await new Promise((r) => setTimeout(r, 20));
    expect(driver.resume).not.toHaveBeenCalled();
    releaseLiveSessionFile(h.file, "r_OLDSTACK");
    const human = await stack.spawn.spawn({ type: "worker", prompt: "human continues", resumeFrom: target });
    if (!("runId" in human)) throw new Error(human.error.message);
    await until(() => driver.text !== undefined);
    expect(driver.text).toContain("human continues");
    expect(driver.text).toContain("please look again");
    await until(() => h.latestOf(WAKE_KEY(1)).state === "consumed");
    expect(h.latestOf(WAKE_KEY(1)).terminalReason).toBe("resume_injected");
    driver.finish();
    await until(() => stack.query.get(human.runId)?.status === "completed");
  });
});

describe("W5 off state", () => {
  it("wake off: wake:true on a stored record is ignored — legacy target_gone dead letter, no revive, no new diag keys", async () => {
    const h = setup({ wake: false });
    const driver = stubDriver();
    const stack = h.build();
    stack.fabric!.pump();
    await until(() => h.latestOf(WAKE_KEY(1)).state === "dropped");
    expect(h.latestOf(WAKE_KEY(1))).toMatchObject({ terminalReason: "target_gone" });
    expect(driver.resume).not.toHaveBeenCalled();
    // and an ordinary resume in a wake-off stack writes none of the wake diag keys
    const run = await stack.spawn.spawn({ type: "worker", prompt: "plain", resumeFrom: target });
    if (!("runId" in run)) throw new Error(run.error.message);
    await until(() => driver.text !== undefined);
    const diag = stack.query.get(run.runId)!.diag;
    for (const k of ["wakeExclusion", "wakeOrigin", "wakeLevel", "inputAcceptedAt", "promptDispatchedAt"])
      expect(diag).not.toHaveProperty(k);
    driver.finish();
    await until(() => stack.query.get(run.runId)?.status === "completed");
  });
});
