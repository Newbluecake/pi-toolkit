import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DriverEvent } from "../../src/core/types.js";
import type { FabricRecord } from "../../src/core/message.js";
import { PiSessionDriver, type PiSessionHandle, type SessionHandle } from "../../src/runtime/session-driver.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { createAgentTool } from "../../src/tools/agent-tool.js";
import { createMentionChannel } from "../../src/fabric/mention.js";
import { inboxDurability } from "../../src/fabric/wake.js";
import { inboxRecord, snapshot, target, sessionFile, flush } from "../helpers/fabric-inbox.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

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
  get: () => worker,
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
function setup(wake = true) {
  const sm = SessionManager.inMemory(process.cwd());
  const dir = mkdtempSync(join(tmpdir(), "w3-integration-"));
  dirs.push(dir);
  const file = join(dir, "child.jsonl");
  writeFileSync(file, "persisted child session");
  const prev = snapshot(target, { status: "completed", phase: "settled", updatedAt: Date.now() });
  prev.diag.sessionFile = file;
  prev.diag.agentType = "worker";
  prev.diag.label = "worker-label";
  const r = inboxRecord({
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttlMs: 120_000,
    parked: { at: Date.now(), reason: "wake_false" },
    payload: { text: "carry this parked finding" },
  });
  sm.appendCustomEntry("subagent:run", prev);
  sm.appendCustomEntry("subagent:fabric", r);
  const pi = {
    appendEntry: (kind: string, data: unknown) => sm.appendCustomEntry(kind, data),
    sendMessage() {},
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
    const stack = buildSessionStack(pi, ctx, settings(wake), types, []);
    stacks.push(stack);
    return stack;
  };
  const latest = () =>
    sm
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === "subagent:fabric")
      .map((e) => (e as { data: FabricRecord }).data)
      .filter((x) => x.key === r.key)
      .at(-1)!;
  return { sm, file, pi, ctx, r, build, latest };
}
function stubDriver() {
  let event: ((e: DriverEvent) => void) | undefined;
  let text: string | undefined;
  let release: (() => void) | undefined;
  const handle: SessionHandle = {
    sessionId: "w3-child",
    sessionFile,
    prompt: (input) => {
      text = input;
      event?.({ t: "input_accepted" });
      event?.({ t: "turn_start" });
      return new Promise<void>((r) => {
        release = r;
      });
    },
    steer: async () => undefined,
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools() {},
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
  };
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async () => handle as PiSessionHandle);
  vi.spyOn(PiSessionDriver.prototype, "bind").mockImplementation(async (_h, cb) => {
    event = cb;
  });
  return {
    get text() {
      return text;
    },
    finish: () => release?.(),
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(check()).toBe(true);
}

describe("W3 real stack assembly", () => {
  it("ordinary Agent({resume}) carries parked messages across stack rebuild and commits at live acceptance", async () => {
    const h = setup();
    const driver = stubDriver();
    const initial = h.build();
    initial.fabric!.pump();
    expect(h.latest()).toMatchObject({ state: "pending", parked: { reason: "wake_false" } });
    initial.fabric!.dispose();
    const stack = h.build();
    const tool = createAgentTool({ spawn: stack.spawn });
    const result = await tool.execute(
      "resume",
      { description: "continue", subagent_type: "worker", prompt: "ordinary human request", resume: target },
      undefined,
      undefined,
      h.ctx as ExtensionToolContext,
    );
    const id = (result.details as { runId: string }).runId;
    expect(id).toMatch(/^r_/);
    await until(() => driver.text !== undefined);
    expect(driver.text).toContain("ordinary human request");
    expect(driver.text).toContain("[fabric inbox n=1]");
    expect(driver.text).toContain("carry this parked finding");
    expect(h.latest()).toMatchObject({ state: "consumed", terminalReason: "resume_injected", revivedAs: id });
    expect(stack.query.get(id)?.diag).toHaveProperty("inputAcceptedAt");
    expect(stack.query.get(id)?.diag).not.toHaveProperty("wakeOrigin");
    const reservation = h.sm
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === "subagent:fabric")
      .map((e) => (e as { data: FabricRecord }).data)
      .find((r) => r.reserved?.runId === id);
    expect(reservation).toMatchObject({ state: "pending", reserved: { runId: id } });
    expect(reservation).not.toHaveProperty("claimToken");
    driver.finish();
    await until(() => stack.query.get(id)?.status === "completed");
    await flush();
  });
  it("legacy @label resume also carries the same parked inbox (no fabricated wakeOrigin)", async () => {
    const h = setup();
    const driver = stubDriver();
    const stack = h.build();
    const channel = createMentionChannel({
      router: {
        admit: () => {
          throw new Error("legacy must resume directly");
        },
        targetState: () => "gone",
      },
      registry: { resolve: () => ({ runId: target, type: "worker", parent: "root" }) },
      query: stack.query,
      spawn: stack.spawn,
      from: "r_SENDER01",
      generation: () => 1,
      canMessage: ["mention"],
      level: stack.wake!.level,
    });
    const result = await channel.send("worker-label", "finding", "legacy followup");
    expect(result).toMatchObject({ status: "resumed" });
    if (result.status !== "resumed") throw new Error("not resumed");
    await until(() => driver.text !== undefined);
    expect(driver.text).toContain("legacy followup");
    expect(driver.text).toContain("carry this parked finding");
    expect(stack.query.get(result.runId)?.diag).not.toHaveProperty("wakeOrigin");
    expect(h.latest().revivedAs).toBe(result.runId);
    driver.finish();
    await until(() => stack.query.get(result.runId)?.status === "completed");
    await flush();
  });
  it("C-P5 partial: REAL SessionManager.inMemory retains the parked record through a stack rebuild", () => {
    const h = setup();
    expect(h.sm.getSessionFile()).toBeUndefined();
    expect(inboxDurability(true, h.sm)).toBe("session-memory");
    const first = h.build();
    first.fabric!.pump();
    first.fabric!.dispose();
    const second = h.build();
    second.fabric!.pump();
    expect(h.latest()).toMatchObject({ state: "pending", parked: { reason: "wake_false" } });
  });
  it("wake off does not activate reservation/trackInput for an ordinary resume", async () => {
    const h = setup(false);
    const driver = stubDriver();
    const stack = h.build();
    const a = await stack.spawn.spawn({ type: "worker", prompt: "off", resumeFrom: target });
    if (!("runId" in a)) throw new Error(a.error.message);
    await until(() => driver.text !== undefined);
    expect(driver.text).toBe("off");
    expect(stack.query.get(a.runId)?.diag).not.toHaveProperty("inputAcceptedAt");
    expect(h.latest()).not.toHaveProperty("reserved");
    driver.finish();
    await until(() => stack.query.get(a.runId)?.status === "completed");
  });
});
