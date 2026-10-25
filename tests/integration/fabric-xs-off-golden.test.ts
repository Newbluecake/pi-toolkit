import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { RESERVED_TOOL_NAMES } from "../../src/runtime/tool-scope.js";
import { MessageAgentParams } from "../../src/tools/message-agent-tool.js";
import { wireWebHub, type WebHubDeps } from "../../src/web-hub/agent/index.js";
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
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * fabric phase-2 XS0 (phase2-plan.md §2.8 H3 / §10.1 XI1): the xs-OFF golden. Captured from
 * `dev` BEFORE any phase-2 code change, it pins byte-for-byte what the toolkit's surface looks
 * like while cross-session fabric is off (the only mode that exists before X2/XW):
 *
 *   (a) `mainSessionTools` — the ordered tool table a real `activate()` registers on a
 *       main-session fake pi under DEFAULT settings (xs off, fabric off, webHub off);
 *   (b) `reservedToolNames` + `messageAgentSchema` — the child-scope reservation list and the
 *       frozen phase-1 `message_agent` schema (`list_sessions`/`message_session` must NOT be
 *       reserved this phase, review #12 / §4.3);
 *   (c) `wiring` — a real `wireWebHub` against a fake hub socket (webHub on, everything else
 *       default): the `hello` frame (caps!), the ordered slot-frame sequence after hello_ack,
 *       the `status` frame body (`StatusInfo` — `xs` must stay absent) and the `HubConfig`
 *       captured from the spawn path (`crossSession` key must stay absent).
 *
 * Never regenerate this to make a failing test pass: a diff here means an xs-off behaviour
 * change (X2/XW must keep these bytes identical while `fabric.crossSession.enabled` is false).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "fabric-xs-off-golden.json");

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");

function releaseGuards(): void {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
}

/** Recording main-session pi: names of every registered tool, in registration order. */
function recordingPi(): { pi: ExtensionAPI; tools: string[] } {
  const tools: string[] = [];
  const pi = {
    registerTool(t: { name: string }) {
      tools.push(t.name);
    },
    registerCommand() {},
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
  return { pi: pi as unknown as ExtensionAPI, tools };
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
    .replace(/([("[,])\/[^\n"')]*\/node(?=[",)\]])/g, "$1<node>");
  return JSON.parse(json) as unknown;
}

const FIXED_NOW = 1_769_000_000_000;

interface WiringCapture {
  hello: Record<string, unknown>;
  slotSequence: string[];
  statusFrame: Record<string, unknown>;
  hubConfig: Record<string, unknown>;
}

async function captureWiring(): Promise<WiringCapture> {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  const tmp = tmpDir("wh-xs-golden-");
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
      // web-hub-cmd-history A1 (main-session ruling 2026-10-24): the xs off golden pins ONLY
      // the xs surface; cmd-history is an orthogonal feature, so it is switched OFF here to
      // keep the frozen fixture byte-stable. Its real default-on behavior (the
      // `cmd.history.v1` feature token on a persisted session) is pinned by the dedicated
      // assertion below — NOT by this golden.
      settings: { ...SETTINGS, autoStart: true, nodeLoader, cmdHistory: false },
      fleet: () => [],
      env: { HOME: tmp.dir },
      paths: { ...pathsIn(tmp.dir), stoppedFile: join(tmp.dir, "stopped") },
      buildInfo: async () => ({ pluginVersion: "0.0.0-golden", buildId: "golden-build" }),
      argv1: "/nonexistent/pi",
      netConnect: net.netConnect,
      spawnImpl,
      now: () => FIXED_NOW,
    });
    fire("session_start", { reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await vi.advanceTimersByTimeAsync(50);
    // No hub listening (socket still "connecting"): an ENOENT down-transition runs the
    // auto-start gate exactly once — spawnImpl captures the HubConfig this launch would use.
    net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    // The post-spawn retry (fastDelay, jitter-free) opens the next socket: that one meets the
    // fake hub.
    for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const socket = net.sockets[1]!;
    socket.emit("connect");
    const ackCaps = [...P2_HUB_CAPS, VERSION_HUB_CAP];
    socket.hub(ackFrame("a1-key", 4242, ackCaps));
    const frames = socket.frames();
    const hello = frames[0]!;
    expect(hello.t).toBe("hello");
    // slot replay + first projections land synchronously on hello_ack; 50ms covers the
    // async settle without reaching the 10s ping tick.
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

async function capture(): Promise<Record<string, unknown>> {
  // (a) main-session tool table via a REAL activate() under default settings
  const home = sandboxHome();
  releaseGuards();
  try {
    rmSync(join(home.home, ".pi", "agent", "pi-subagent.json"), { force: true });
    const rec = recordingPi();
    activate(rec.pi);
    const mainSessionTools = [...rec.tools];
    return normalize({
      note: "xs-off golden captured from dev before XS0 (fabric-cross-session phase2-plan §2.8 H3). Never regenerate to fix a diff.",
      mainSessionTools,
      reservedToolNames: [...RESERVED_TOOL_NAMES],
      messageAgentSchema: MessageAgentParams,
      wiring: await captureWiring(),
    }) as Record<string, unknown>;
  } finally {
    releaseGuards();
    home.restore();
  }
}

describe("fabric xs-off golden (phase2-plan §2.8 H3 / §10.1 XI1)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    if (process.env.FABRIC_XS_GOLDEN_UPDATE === "1" && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    expect(actual).toEqual(golden);
  });

  it("cmd-history default-on adds exactly the cmd.history.v1 feature token (A1 pin, orthogonal to the frozen golden)", async () => {
    // Same capture harness, default settings (cmdHistory on): the persisted fake session meets
    // plan §4.6's gate, so statusFrame.features is [resume.v1, cmd.history.v1] and nothing else
    // changes — this is the assertion the frozen golden deliberately does NOT carry.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const tmp = tmpDir("wh-xs-cmdhistory-");
    resetGlobals();
    try {
      const nodeLoader = join(tmp.dir, "jiti.mjs");
      writeFileSync(nodeLoader, "");
      const net = fakeNet();
      const { pi, fire } = fakePi();
      wireWebHub(pi, {
        settings: { ...SETTINGS, autoStart: true, nodeLoader },
        fleet: () => [],
        env: { HOME: tmp.dir },
        paths: { ...pathsIn(tmp.dir), stoppedFile: join(tmp.dir, "stopped") },
        buildInfo: async () => ({ pluginVersion: "0.0.0-golden", buildId: "golden-build" }),
        argv1: "/nonexistent/pi",
        netConnect: net.netConnect,
        spawnImpl: ((_e: string, _a: string[], _o: { env: NodeJS.ProcessEnv }) => ({
          on: () => undefined,
          unref: () => undefined,
        })) as never,
        now: () => FIXED_NOW,
      });
      fire("session_start", { reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
      await vi.advanceTimersByTimeAsync(50);
      net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
      for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
      const socket = net.sockets[1]!;
      socket.emit("connect");
      socket.hub(ackFrame("a1-key", 4242, [...P2_HUB_CAPS, VERSION_HUB_CAP]));
      vi.advanceTimersByTime(50);
      const status = socket.frames().find((f) => f.t === "status") as { features?: string[] };
      expect(status.features).toEqual(["resume.v1", "cmd.history.v1"]);
    } finally {
      resetGlobals();
      vi.useRealTimers();
      tmp.cleanup();
    }
  });

  it("is deterministic and contains no xs surface while off", async () => {
    const first = (await capture()) as {
      mainSessionTools: string[];
      reservedToolNames: string[];
      wiring: WiringCapture & Record<string, unknown>;
    };
    const second = await capture();
    expect(second).toEqual(first);
    // §4.3 (#12): the two cross-session tools exist nowhere while xs is off, and are NOT
    // reserved names this phase (child sessions keep a same-named MCP tool untouched).
    expect(first.mainSessionTools).not.toContain("message_session");
    expect(first.mainSessionTools).not.toContain("list_sessions");
    expect(first.reservedToolNames).not.toContain("message_session");
    expect(first.reservedToolNames).not.toContain("list_sessions");
    // hello caps / slot frames / StatusInfo / HubConfig carry no xs trace
    const hello = first.wiring.hello as { caps?: string[] };
    expect(hello.caps).toBeDefined();
    expect(hello.caps!.some((c) => c.startsWith("xs."))).toBe(false);
    expect(first.wiring.slotSequence.some((t) => t.startsWith("xs_"))).toBe(false);
    expect(Object.keys(first.wiring.statusFrame)).not.toContain("xs");
    const configJson = JSON.stringify(first.wiring.hubConfig);
    expect(configJson).not.toContain("crossSession");
    expect(configJson).not.toContain("xs");
  });
});
