import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { createThreadCommand } from "../../src/commands/thread.js";
import type { ThreadMainOps } from "../../src/tools/thread-tool.js";
import { feishuThreadMetaFor } from "../../src/web-hub/hub/feishu/thread-hub.js";
import type { FeishuRequestRecord } from "../../src/web-hub/hub/feishu/state.js";
import { wireWebHub } from "../../src/web-hub/agent/index.js";
import { DEFAULT_FEISHU_BOT_SETTINGS } from "../../src/web-hub/agent/settings.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import {
  ackFrame,
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  tmpDir,
} from "../web-hub/agent/helpers.js";
import { resetSettingsFiles, sandboxHome } from "./helpers/home-sandbox.js";

/**
 * fabric-thread rebind plan r3 §7 A16 (P0b): the threads-ON × rebind-OFF golden. Captured BEFORE any
 * rebind wire/settings/cap change, with `fabric.enabled: true` + `fabric.threads.enabled: true` and
 * `fabric.threads.rebind` absent (its default — off). It pins byte-for-byte the surfaces the rebind
 * packages must NOT move while the gate is off:
 *
 *   (a) `mainSessionTools` / `commands` — the ordered registration tables of a real `activate()`
 *       under threads-on (the `thread` tool + `/thread` command exist; nothing rebind-shaped);
 *   (b) `threadTool` — the main-session `thread` tool's description + parameters JSON (the Legacy
 *       shape of rebind-plan §4.8: three actions, no `to`);
 *   (c) `threadCommand` — the `/thread` command's description and its help USAGE text;
 *   (d) `wiring` — a real `wireWebHub` against a fake hub socket with the threads deps wired the
 *       way src/index.ts wires them under threads-on × rebind-off: the `hello` frame (caps carry
 *       `thr.v1`, NOT `thr.rebind.v1`), the slot sequence, the `status` frame body and the spawned
 *       `HubConfig` (`feishuBot.threads` = the five clamped leaves, NO `rebind` key);
 *   (e) `cmdThreadMeta` — a real `feishuThreadMetaFor` output under both-ends-`thr.v1`: exactly
 *       `{h, label, sentAt}`, NO `rev` (rev rides only when BOTH ends carry `thr.rebind.v1`, §6 实施要点 4).
 *
 * Never regenerate this to make a failing test pass: a diff here means a threads-on × rebind-off
 * behaviour change. The THREAD_REBIND_OFF_GOLDEN_UPDATE=1 escape hatch refuses to overwrite an
 * existing fixture (same rule as thread-off-golden).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "thread-rebind-off-golden.json");

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");

function releaseGuards(): void {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
}

interface CapturedTool {
  name: string;
  description: unknown;
  parameters: unknown;
}
type CapturedCommand = { name: string; description: unknown };

/** Recording main-session pi: every registered tool (name + description + parameters) and command. */
function recordingPi(): { pi: ExtensionAPI; tools: CapturedTool[]; commands: CapturedCommand[] } {
  const tools: CapturedTool[] = [];
  const commands: CapturedCommand[] = [];
  const pi = {
    registerTool(t: { name: string; description?: unknown; parameters?: unknown }) {
      tools.push({ name: t.name, description: t.description, parameters: t.parameters });
    },
    registerCommand(name: string, cmd: { description?: unknown }) {
      commands.push({ name, description: cmd.description });
    },
    registerEntryRenderer() {},
    on: () => () => undefined,
    sendMessage() {},
    appendEntry() {},
    getCommands() {
      return [];
    },
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, tools, commands };
}

function normalize(value: unknown): unknown {
  const json = JSON.stringify(value)
    // mkdtemp home / tmp paths (hub config home, state dirs)
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>")
    // module-instance epochs / uuids (hello.epoch, nonce ids)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    // the process agent identity (pid + random nonce) — stable within one process, not across runs
    .replace(/"agentId":\{"pid":[0-9]+,"nonce":"[^"]*"\}/g, '"agentId":"<agentId>"')
    // process.execPath inside launcher pairs
    .replace(/([("(,])\/[^\n"')]*\/node(?=[",)\]])/g, "$1<node>");
  return JSON.parse(json) as unknown;
}

const FIXED_NOW = 1_769_000_000_000;

interface WiringCapture {
  hello: Record<string, unknown>;
  slotSequence: string[];
  statusFrame: Record<string, unknown>;
  hubConfig: Record<string, unknown>;
}

/** The threads-on × rebind-off wiring capture: same harness as thread-off-golden, but with the
 *  threads deps wired exactly like src/index.ts under `fabric.threads.enabled:true` and rebind off
 *  (threadsCapOn true; threadsHubConfig = the five clamped leaves, no `rebind` key). */
async function captureWiring(): Promise<WiringCapture> {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  const tmp = tmpDir("wh-thread-rebind-golden-");
  resetGlobals();
  try {
    const nodeLoader = join(tmp.dir, "jiti.mjs");
    writeFileSync(nodeLoader, "");
    const net = fakeNet();
    const { pi, fire } = fakePi();
    const spawnEnv: NodeJS.ProcessEnv[] = [];
    const spawnImpl = ((_exe: string, _argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawnEnv.push(opts.env);
      return { on: () => undefined, unref: () => undefined } as never;
    }) as never;
    wireWebHub(pi, {
      settings: { ...SETTINGS, autoStart: true, nodeLoader, cmdHistory: false },
      fleet: () => [],
      env: { HOME: tmp.dir },
      paths: { ...pathsIn(tmp.dir), stoppedFile: join(tmp.dir, "stopped") },
      buildInfo: async () => ({ pluginVersion: "0.0.0-golden", buildId: "golden-build" }),
      argv1: "/nonexistent/pi",
      netConnect: net.netConnect,
      spawnImpl,
      now: () => FIXED_NOW,
      // threads-on deps (rebind-plan r3 §4.2, rebind OFF): same shape src/index.ts passes.
      feishuBot: { ...DEFAULT_FEISHU_BOT_SETTINGS, enabled: true },
      threads: () => undefined,
      threadsCapOn: () => true,
      threadsHubConfig: () => ({
        handbackWindowMin: 10,
        startTimeoutMin: 8,
        retainMin: 15,
        replyPerThreadPerMin: 6,
        replyPerThreadPerHour: 60,
      }),
    });
    fire("session_start", { reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await vi.advanceTimersByTimeAsync(50);
    net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const socket = net.sockets[1]!;
    socket.emit("connect");
    const ackCaps = [...P2_HUB_CAPS, VERSION_HUB_CAP];
    socket.hub(ackFrame("a1-key", 4242, ackCaps));
    const frames = socket.frames();
    const hello = frames[0]!;
    expect(hello.t).toBe("hello");
    vi.advanceTimersByTime(50);
    const all = socket.frames();
    const status = all.find((f) => f.t === "status");
    expect(status).toBeDefined();
    const configRaw = spawnEnv.map((env) => JSON.parse(String(env.PI_WEBHUB_CONFIG))) as Record<string, unknown>[];
    expect(configRaw.length).toBe(1);
    return {
      hello: hello as Record<string, unknown>,
      slotSequence: all.slice(1).map((f) => String(f.t)),
      statusFrame: status as Record<string, unknown>,
      hubConfig: configRaw[0]!,
    };
  } finally {
    resetGlobals();
    vi.useRealTimers();
    tmp.cleanup();
  }
}

/** A representative group-topic record (mirrors tests/web-hub/hub/feishu/thread-hub.test.ts). */
const META_RECORD: FeishuRequestRecord = {
  id: "fs" + "a".repeat(30),
  batchId: "b".repeat(64),
  state: "dispatching",
  createdAt: 1_790_000_000_000,
  stateAt: 1_790_000_000_000,
  sessionId: "session-1",
  agentKey: "agent-1",
  bindingKey: "grp:chat:t1",
  bindingRev: 1,
  senderOpenId: "ou_owner",
  senderDisplay: "Owner",
  chatLabel: "ProjTopic",
  chatId: "chat",
  chatType: "group",
  threadId: "t1",
  triggerMessageId: "m1",
  textDigest: "d".repeat(64),
  sourceCreatedAt: 1_790_000_000_123,
};

/** The `/thread` help USAGE, captured from the REAL command factory (the closure-local USAGE is
 *  not exported; a stub surface lets the handler reach its help branch). */
async function captureThreadUsage(): Promise<string> {
  const stub: ThreadMainOps = {
    list: () => "(stub list)",
    subscribe: () => ({ ok: false, reason: "stub" }),
    unsubscribe: () => ({ ok: false, reason: "stub" }),
    origins: () => [],
  };
  const cmd = createThreadCommand({ current: () => stub });
  const notices: string[] = [];
  const ctx = { ui: { notify: (m: string) => notices.push(m) } };
  await cmd.handler("help", ctx as never);
  expect(notices.length).toBe(1);
  return notices[0]!;
}

async function capture(): Promise<Record<string, unknown>> {
  // (a)+(b) main-session tables via a REAL activate() under fabric+threads on (rebind absent = off)
  const home = sandboxHome();
  releaseGuards();
  try {
    resetSettingsFiles(home.home);
    const agentDir = join(home.home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "pi-toolkit.json"),
      JSON.stringify({ fabric: { enabled: true, threads: { enabled: true } } }, null, 2) + "\n",
    );
    const rec = recordingPi();
    activate(rec.pi);
    const threadTool = rec.tools.find((t) => t.name === "thread");
    expect(threadTool, "threads on ⇒ the main-session thread tool is registered").toBeDefined();
    const threadCmd = rec.commands.find((c) => c.name === "thread");
    expect(threadCmd, "threads on ⇒ /thread is registered").toBeDefined();
    return normalize({
      note: "threads-on × rebind-off golden (rebind-plan r3 §7 A16), captured before the rebind wire/settings/cap changes. Never regenerate to fix a diff.",
      mainSessionTools: rec.tools.map((t) => t.name),
      commands: rec.commands.map((c) => c.name),
      threadTool: { description: threadTool!.description, parameters: threadTool!.parameters },
      threadCommand: { description: threadCmd!.description, usage: await captureThreadUsage() },
      wiring: await captureWiring(),
      cmdThreadMeta: feishuThreadMetaFor({
        record: META_RECORD,
        agentKey: "agent-1",
        installSecret: "golden-secret",
        agentCaps: ["cmd.v1", "thr.v1"],
      }),
    }) as Record<string, unknown>;
  } finally {
    releaseGuards();
    home.restore();
  }
}

describe("fabric threads-on × rebind-off golden (rebind-plan r3 §7 A16)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    if (process.env.THREAD_REBIND_OFF_GOLDEN_UPDATE === "1" && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), "golden missing — capture it BEFORE changing any source").toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    expect(actual).toEqual(golden);
  });

  it("is deterministic and carries no rebind surface while the gate is off", async () => {
    const first = (await capture()) as {
      mainSessionTools: string[];
      threadTool: { description: string; parameters: Record<string, unknown> };
      threadCommand: { description: string; usage: string };
      wiring: WiringCapture & Record<string, unknown>;
      cmdThreadMeta: Record<string, unknown>;
    };
    const second = await capture();
    expect(second).toEqual(first);
    // tool table: thread exists; the tool schema/description carry no rebind/acquire shape
    expect(first.mainSessionTools).toContain("thread");
    const toolJson = JSON.stringify(first.threadTool);
    expect(toolJson).not.toContain("rebind");
    expect(toolJson).not.toContain("acquire");
    expect(first.threadTool.parameters).not.toHaveProperty("properties.to");
    // /thread USAGE carries no rebind/acquire verbs
    expect(first.threadCommand.usage).not.toContain("rebind");
    expect(first.threadCommand.usage).not.toContain("acquire");
    // hello caps: thr.v1 (threads on) but NEVER a rebind cap while the gate is off
    const hello = first.wiring.hello as { caps?: string[] };
    expect(hello.caps).toContain("thr.v1");
    expect(hello.caps!.some((c) => c.startsWith("thr.rebind"))).toBe(false);
    // HubConfig.feishuBot.threads: the five clamped leaves and NOTHING rebind-shaped
    const cfg = first.wiring.hubConfig as { feishuBot?: { threads?: Record<string, unknown> } };
    expect(cfg.feishuBot?.threads).toBeDefined();
    expect(Object.keys(cfg.feishuBot!.threads!)).toEqual([
      "handbackWindowMin",
      "startTimeoutMin",
      "retainMin",
      "replyPerThreadPerMin",
      "replyPerThreadPerHour",
    ]);
    // cmd.thread field set: exactly {h,label,sentAt} — no rev under rebind-off
    expect(Object.keys(first.cmdThreadMeta)).toEqual(["h", "label", "sentAt"]);
  });
});
