/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import { wireWebHub } from "../../src/web-hub/agent/index.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import {
  ackFrame,
  fakeCtx as hubFakeCtx,
  fakeNet,
  fakePi as hubFakePi,
  pathsIn,
  resetGlobals as hubReset,
  SETTINGS,
  tmpDir,
} from "../web-hub/agent/helpers.js";
import {
  BASELINE,
  emit,
  fakeCtx,
  fakePi,
  resetGlobals,
  sandbox,
  systemPromptFor,
} from "./helpers/schedule-activate.js";

/**
 * scheduled-reports I1 (plan r3 §14 「off golden」): what the toolkit looks like while `schedule` is OFF
 * (the default). Pinned byte for byte:
 *   (a) the ordered tool table and the command table of a real `activate()` (no `schedule` tool, no `/schedule`);
 *   (b) the per-event handler counts — the OFF footprint is ONLY the orphan guard
 *       (`before_agent_start` / `context` / `agent_settled`, hooks without any IO or surface);
 *   (c) the system prompt a session folds (no `pi_schedules` section, no schedule text);
 *   (d) a real `wireWebHub` capture: hello caps carry no `sched.v1`, the HubConfig has no `schedule` key;
 *   (e) nothing is written: neither the retired `pi-subagent-schedules.json` nor a `schedules/` directory.
 * The retired global engine's file is never created again (A0 退役).
 *
 * Never regenerate this to make a failing test pass: a diff here means the OFF surface changed. The other
 * frozen fixtures (fabric-xs-off / fabric-wake-off / fabric-xs-reply-off, keepalive-legacy, secure-off,
 * legacy-xs-v071) are untouched by this package.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "schedule-off-golden.json");
const FIXED_NOW = 1_769_000_000_000;

function normalize(value: unknown): unknown {
  const json = JSON.stringify(value)
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/"agentId":\{"pid":[0-9]+,"nonce":"[^"]*"\}/g, '"agentId":"<agentId>"')
    .replace(/([("[,])\/[^\n"')]*\/node(?=[",)\]])/g, "$1<node>");
  return JSON.parse(json) as unknown;
}

async function captureWiring(): Promise<Record<string, unknown>> {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  const tmp = tmpDir("wh-sched-golden-");
  hubReset();
  try {
    const nodeLoader = join(tmp.dir, "jiti.mjs");
    writeFileSync(nodeLoader, "");
    const net = fakeNet();
    const { pi, fire } = hubFakePi();
    const spawnEnv: NodeJS.ProcessEnv[] = [];
    wireWebHub(pi, {
      // orthogonal feature switched off, exactly like the xs golden (cmd-history has its own pin there)
      settings: { ...SETTINGS, autoStart: true, nodeLoader, cmdHistory: false },
      fleet: () => [],
      env: { HOME: tmp.dir },
      paths: { ...pathsIn(tmp.dir), stoppedFile: join(tmp.dir, "stopped") },
      buildInfo: async () => ({ pluginVersion: "0.0.0-golden", buildId: "golden-build" }),
      argv1: "/nonexistent/pi",
      netConnect: net.netConnect,
      spawnImpl: ((_e: string, _a: string[], opts: { env: NodeJS.ProcessEnv }) => {
        spawnEnv.push(opts.env);
        return { on: () => undefined, unref: () => undefined } as never;
      }) as never,
      now: () => FIXED_NOW,
    });
    fire("session_start", { reason: "startup" }, hubFakeCtx({ mode: "tui" }).ctx);
    await vi.advanceTimersByTimeAsync(50);
    net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const socket = net.sockets[1]!;
    socket.emit("connect");
    socket.hub(ackFrame("a1-key", 4242, [...P2_HUB_CAPS, VERSION_HUB_CAP]));
    vi.advanceTimersByTime(50);
    const frames = socket.frames();
    const status = frames.find((f) => f.t === "status") as Record<string, unknown>;
    return {
      helloCaps: (frames[0] as { caps?: string[] }).caps,
      slotSequence: frames.slice(1).map((f) => String(f.t)),
      statusKeys: Object.keys(status).sort(),
      hubConfig: JSON.parse(String(spawnEnv[0]!.PI_WEBHUB_CONFIG)),
    };
  } finally {
    hubReset();
    vi.useRealTimers();
    tmp.cleanup();
  }
}

async function captureSurface(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sb = sandbox("pi-sched-off-");
  resetGlobals();
  try {
    sb.writeSettings({ ...BASELINE, ...settings });
    const h = fakePi();
    activate(h.pi);
    const c = fakeCtx(sb.home);
    await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
    const prompt = await systemPromptFor(h, c.ctx);
    await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, c.ctx);
    await emit(h, "agent_settled", { aborted: false }, c.ctx);
    await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx);
    const agentDir = join(sb.home, ".pi", "agent");
    return {
      tools: h.toolOrder,
      commands: h.commandOrder,
      handlerCounts: Object.fromEntries([...h.handlers].map(([k, v]) => [k, v.length]).sort()),
      systemPrompt: prompt,
      statuses: c.statuses.filter(([k]) => k.includes("sched")),
      legacyFileExists: existsSync(join(agentDir, "pi-subagent-schedules.json")),
      schedulesDirExists: existsSync(join(agentDir, "schedules")),
    };
  } finally {
    resetGlobals();
    sb.cleanup();
  }
}

async function capture(): Promise<Record<string, unknown>> {
  return normalize({
    note: "schedule-off golden captured at scheduled-reports I1. Never regenerate to fix a diff.",
    surface: await captureSurface({}),
    wiring: await captureWiring(),
  }) as Record<string, unknown>;
}

describe("schedule off golden (plan r3 §14)", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    if (process.env.SCHEDULE_OFF_GOLDEN_UPDATE === "1" && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("is deterministic; `schedule:{enabled:false}` is identical to an absent section", async () => {
    const first = await captureSurface({});
    expect(normalize(await captureSurface({}))).toEqual(normalize(first));
    expect(normalize(await captureSurface({ schedule: { enabled: false } }))).toEqual(normalize(first));
  });

  it("carries no schedule surface: no tool / command / status / prompt text / hub cap / HubConfig key / files", async () => {
    const a = (await capture()) as any;
    expect(a.surface.tools).not.toContain("schedule");
    expect(a.surface.commands).not.toContain("schedule");
    expect(a.surface.systemPrompt).not.toMatch(/schedul/i);
    expect(a.surface.statuses).toEqual([]);
    expect(a.surface.legacyFileExists).toBe(false);
    expect(a.surface.schedulesDirExists).toBe(false);
    expect(a.wiring.helloCaps.some((cap: string) => cap.startsWith("sched."))).toBe(false);
    expect(Object.keys(a.wiring.hubConfig)).not.toContain("schedule");
    expect(JSON.stringify(a.wiring.hubConfig)).not.toContain("sched");
  });

  it("OFF footprint = the orphan guard only: a pending scheduled wake that survived a /reload that switched the feature off is aborted on sight and its model calls are refused; user prompts are untouched", async () => {
    const sb = sandbox("pi-sched-off-guard-");
    resetGlobals();
    try {
      sb.writeSettings({ ...BASELINE });
      const h = fakePi();
      activate(h.pi);
      const c = fakeCtx(sb.home);
      await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
      // user prompt: nothing aborted
      await emit(
        h,
        "before_agent_start",
        { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "" },
        c.ctx,
      );
      expect(c.aborts.n).toBe(0);
      // a scheduled wake with no scheduler anywhere = orphan: aborted, and the later model call is refused too
      await emit(
        h,
        "before_agent_start",
        {
          type: "before_agent_start",
          messageType: "custom",
          message: {
            customType: "subagent:schedule",
            details: { kind: "message", token: "t", runKey: "x", noteId: "n" },
          },
        },
        c.ctx,
      );
      expect(c.aborts.n).toBe(1);
      await emit(h, "context", { messages: [] }, c.ctx);
      expect(c.aborts.n).toBe(2);
      // quiet kinds (results / digests) never start a run: ignored
      await emit(
        h,
        "before_agent_start",
        {
          type: "before_agent_start",
          messageType: "custom",
          message: { customType: "subagent:schedule", details: { kind: "result" } },
        },
        c.ctx,
      );
      expect(c.aborts.n).toBe(2);
      // the guard touches nothing on disk
      expect(existsSync(join(sb.home, ".pi", "agent", "schedules"))).toBe(false);
      await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx);
    } finally {
      resetGlobals();
      sb.cleanup();
    }
  });
});
