import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { RESERVED_TOOL_NAMES, buildToolScopePolicy } from "../../src/runtime/tool-scope.js";
import { wireWebHub } from "../../src/web-hub/agent/index.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import { UNKNOWN_SLASH_TEXT_FEATURE_V1 } from "../../src/web-hub/protocol/messages.js";
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
 * fabric-thread P0 (arch §9.3, A-tier): the threads-OFF golden. Captured from `dev` BEFORE any
 * thread code change, with `fabric.enabled: true` and `fabric.threads` absent (threads off — the
 * only mode that exists before P3/P2 wire the feature). It pins byte-for-byte what the toolkit's
 * surface looks like while thread subscription is off:
 *
 *   (a) `mainSessionTools` — the ordered tool table a real `activate()` registers on a
 *       main-session fake pi under `fabric.enabled: true` (the thread main-session tool must
 *       NOT exist this phase, §9.2);
 *   (b) `reservedToolNames` + `grantDeny` — the frozen global reservation list (unchanged by
 *       thread, §9.2) and a representative `buildToolScopePolicy(...)` deny set: with the
 *       feature off the caller passes no `extraReserved`, so `thread` must NOT be denied (a
 *       same-named MCP tool stays untouched, exactly like `message_session` in XS0);
 *   (c) `wiring` — a real `wireWebHub` against a fake hub socket (webHub on): the `hello`
 *       frame (caps! — no `thr.v1`), the ordered slot-frame sequence after hello_ack (no
 *       `thr_*` frames), the `status` frame body (`StatusInfo` — `threads` slot absent) and
 *       the `HubConfig` captured from the spawn path (`threads` key must stay absent).
 *
 * Never regenerate this to make a failing test pass: a diff here means a threads-off behaviour
 * change (P2/P3/P4 must keep these bytes identical while `fabric.threads.enabled` is false,
 * and P0 itself must not move them either — G2a).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "thread-off-golden.json");

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

async function captureWiring(): Promise<WiringCapture> {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  const tmp = tmpDir("wh-thread-golden-");
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
      // Same posture as the xs-off golden: cmd-history is off here so the frozen fixture stays
      // byte-stable; its default-on behaviour is pinned by the xs golden's dedicated assertion.
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
    // #40 ruling (2026-11-06): `unknown-slash-text.v1` is a declared orthogonal default-on
    // feature token that post-dates this A-tier fixture (the fixture file itself NEVER
    // changes). Only for this named token the historical snapshot is a shallow copy with
    // that single token removed; no generic strip, no `delete features` — any other
    // features diff still fails the golden toEqual. Raw status stays untouched; the
    // orthogonal default-on change is protected by the raw pin below (token exactly once).
    const rawFeatures = (status as { features?: string[] }).features ?? [];
    expect(rawFeatures.filter((f) => f === UNKNOWN_SLASH_TEXT_FEATURE_V1)).toHaveLength(1);
    const statusFrame: Record<string, unknown> = { ...(status as Record<string, unknown>) };
    statusFrame.features = rawFeatures.filter((f) => f !== UNKNOWN_SLASH_TEXT_FEATURE_V1);
    expect(statusFrame.features).toEqual(["resume.v1"]);
    const configRaw = spawnEnv.map((env) => JSON.parse(String(env.PI_WEBHUB_CONFIG))) as Record<string, unknown>[];
    expect(configRaw.length).toBe(1);
    return {
      hello: hello as Record<string, unknown>,
      slotSequence: all.slice(1).map((f) => String(f.t)),
      statusFrame,
      hubConfig: configRaw[0]!,
    };
  } finally {
    resetGlobals();
    vi.useRealTimers();
    tmp.cleanup();
  }
}

async function capture(): Promise<Record<string, unknown>> {
  // (a) main-session tool table via a REAL activate() under fabric.enabled:true + threads off
  const home = sandboxHome();
  releaseGuards();
  try {
    resetSettingsFiles(home.home);
    const agentDir = join(home.home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "pi-toolkit.json"), JSON.stringify({ fabric: { enabled: true } }, null, 2) + "\n");
    const rec = recordingPi();
    activate(rec.pi);
    const mainSessionTools = [...rec.tools];
    // (b) child-scope grant: the off-feature policy a direct-dispatch run gets today — no
    // extraReserved is passed by any caller while threads is off, so "thread" must not be denied.
    const policy = buildToolScopePolicy({
      tools: ["read", "grep", "bash"],
      granted: ["message_agent", "Agent", "get_run_result"],
    });
    return normalize({
      note: "threads-off golden captured from dev before P0 (fabric-thread arch §9.3; fabric.enabled=true, threads off). Never regenerate to fix a diff.",
      mainSessionTools,
      reservedToolNames: [...RESERVED_TOOL_NAMES],
      grantDeny: [...policy.deny].sort(),
      wiring: await captureWiring(),
    }) as Record<string, unknown>;
  } finally {
    releaseGuards();
    home.restore();
  }
}

describe("fabric threads-off golden (fabric-thread arch §9.3)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    if (process.env.THREAD_OFF_GOLDEN_UPDATE === "1" && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), "golden missing — capture it BEFORE changing any source").toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    expect(actual).toEqual(golden);
  });

  it("is deterministic and carries no thread surface while off", async () => {
    const first = (await capture()) as {
      mainSessionTools: string[];
      reservedToolNames: string[];
      grantDeny: string[];
      wiring: WiringCapture & Record<string, unknown>;
    };
    const second = await capture();
    expect(second).toEqual(first);
    // §9.2: the main-session thread tool does not exist this phase; "thread" is neither a
    // reserved name nor denied by any run's policy while the feature is off.
    expect(first.mainSessionTools).not.toContain("thread");
    expect(first.reservedToolNames).not.toContain("thread");
    expect(first.grantDeny).not.toContain("thread");
    // hello caps / slot frames / StatusInfo / HubConfig carry no thr trace
    const hello = first.wiring.hello as { caps?: string[] };
    expect(hello.caps).toBeDefined();
    expect(hello.caps!.some((c) => c === "thr.v1" || c.startsWith("thr."))).toBe(false);
    expect(first.wiring.slotSequence.some((t) => t.startsWith("thr_"))).toBe(false);
    expect(Object.keys(first.wiring.statusFrame)).not.toContain("threads");
    const configJson = JSON.stringify(first.wiring.hubConfig);
    expect(configJson).not.toContain("threads");
    expect(configJson).not.toContain("thr:");
  });
});
