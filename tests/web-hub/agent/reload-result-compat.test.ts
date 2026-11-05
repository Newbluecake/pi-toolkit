/**
 * #30 reload-result plan §3 G1 — the reload-result compat golden.
 *
 * Captured from UNMODIFIED dev BEFORE any P-A source change
 * (`PI_TOOLKIT_RELOAD_RESULT_GOLDEN_CAPTURE=1`; refuses to overwrite an existing file), over the
 * REAL agent-side stack a web "reload this agent" request travels: the real `wireWebHub`
 * (real command handler, real builtin bridge, real capture engine, real command recorder) on a
 * fakeNet socket, plus the real `wrapCommandApi`-registered `/agent` command, the real
 * `DeferredReloadController` and the real `createReloadCommandPort`. The only fakes are pi
 * (whose `sendUserMessage` dispatches the registered command like pi's idle path), the ctx and
 * the socket. Frames are captured as RAW NDJSON lines (per-frame bytes, order preserved).
 *
 * Three scenarios:
 *   s1  TUI `/agent reload`, idle, including the shutdown{reload} → start{reload} handover —
 *       the COMPLETE frame sequence must stay byte-identical after the change: a TUI reload is
 *       never tracked (plan Q1), so no record, no `status.reload`, no extra frame may appear.
 *   s2  Web `agent reload` (cmd frame, idle) — reload actually runs. Every non-status frame
 *       must stay byte-equal; a status frame may differ ONLY by the appended `reload` field
 *       (D6 class ①) and status frames may be INSERTED (one per projection change, D6 class ②).
 *   s3  Web `agent reload` while the fleet is busy (parked), then Web `agent reload cancel` —
 *       same allow-list as s2.
 *
 * Never regenerate the golden to make a diff pass: a diff outside the allow-list means
 * observable wire behavior changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { wrapCommandApi } from "../../../src/commands/capture.js";
import { createStatusCommand } from "../../../src/commands/status.js";
import { createReloadCommandPort } from "../../../src/reload/command-port.js";
import { DeferredReloadController } from "../../../src/reload/defer.js";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { parseSlashCommand } from "../../../src/web-hub/agent/slash.js";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir, waitUntil } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "fixtures", "web-hub", "reload-result-compat-golden.json");
const CAPTURE = process.env.PI_TOOLKIT_RELOAD_RESULT_GOLDEN_CAPTURE === "1";

/** Fixed agent clock: every `at`/ledger timestamp on the wire is deterministic. */
const T = 1_700_000_000_000;

const ORIGIN = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" } as const;

/**
 * The frames' only cross-process non-determinism: the hello `agentId` (real pid + random
 * nonce), every `epoch` (MODULE_INSTANCE — a fresh UUID per process) and the `launcher` pair
 * (real node/exec paths). Each is normalized to a JSON-safe sentinel so the stored lines stay
 * parseable — everything else (frame order, event names, JSON bytes) is compared verbatim.
 */
function normalize(text: string): string {
  return text
    .replace(/"pid":\d+/g, '"pid":0')
    .replace(/"nonce":"[^"]+"/g, '"nonce":"<n>"')
    .replace(/"epoch":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"epoch":"<epoch>"')
    .replace(/"launcher":\[[^\]]*\]/g, '"launcher":["<exec>","<argv1>"]');
}

interface Harness {
  rawFrames: () => string[];
  parsedFrames: () => unknown[];
  frames: () => AgentFrame[];
  hub: (frame: unknown) => void;
  connect: () => void;
  socketCount: () => number;
  fire: (ev: string, event: unknown) => void;
  command: (args: string) => Promise<void>;
  ctxState: ReturnType<typeof fakeCtx>["state"];
  ctl: DeferredReloadController;
  cleanup: () => void;
}

/** One full agent-side stack: wireWebHub + wrapped `/agent` + controller + port, on fakeNet. */
function buildHarness(runs: () => Array<{ runId: string; status: string }>): Harness {
  resetGlobals();
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for("pi-subagent:web-hub:reload-track")];
  const tmp = tmpDir("wh-d-rr-");
  const n = fakeNet();
  const raw = fakePi();
  const registered = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const { ctx, state } = fakeCtx({ leaf: "L1", idle: true });
  const commandCtx: Record<string, unknown> = ctx;
  const reloadHooks: { onReload?: () => void } = {};
  void reloadHooks;
  // pi's idle path: sendUserMessage dispatches the registered command (async microtask), so the
  // capture window's synchronous-prefix/await semantics match the real host exactly.
  const basePi = {
    ...raw.pi,
    getCommands: () => [{ name: "agent", source: "extension" }],
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      registered.set(name, command);
    },
    sendUserMessage(text: string) {
      const parsed = parseSlashCommand(text);
      if (parsed === undefined) return;
      const command = registered.get(parsed.name);
      if (command !== undefined)
        void Promise.resolve((command.handler as (a: string, c: unknown) => unknown)(parsed.args, commandCtx)).catch(
          () => undefined,
        );
    },
  };
  const captureRef: { current?: unknown } = {};
  const recorderRef: { current?: unknown } = {};
  const owned = new Set<string>();
  const pi = wrapCommandApi(
    basePi as unknown as ExtensionAPI,
    () => captureRef.current as never,
    owned,
    new Map(),
    () => recorderRef.current as never,
  );
  const ctl = new DeferredReloadController({
    fire: () => pi.sendUserMessage("/agent reload fire", { deliverAs: "followUp", expandPromptTemplates: true }),
  });
  const control = wireWebHub(pi, {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    netConnect: n.netConnect,
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "b1@t" }),
    argv1: "/none",
    now: () => T,
    ownedCommandNames: owned,
    // deterministic non-repo answer — never a real git exec
    gitRunner: (async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "not a repo" })) as never,
  });
  captureRef.current = control.capture;
  if (control.recorder !== undefined) recorderRef.current = control.recorder;
  // #30 P-A: the phase sink is late-bound exactly like src/index.ts wires it. On the unmodified
  // implementation `onReloadPhase` does not exist yet and the port emits nothing, so the sink
  // never fires during capture; after the change this is the D6 observer under test.
  const port = createReloadCommandPort(
    () => ctl,
    pi,
    (event) => (control as { onReloadPhase?: (e: unknown) => void }).onReloadPhase?.(event),
  );
  pi.registerCommand(
    "agent",
    createStatusCommand({
      query: { list: () => runs() },
      orphans: { register: () => undefined, recent: [], totalCount: 0 },
      notifier: { enqueue: () => undefined },
      reload: port,
    } as never),
  );
  // Real AgentSession.reload shape: shutdown{reload} → invalidate → start{reload}, all inside
  // the awaited reload() promise.
  commandCtx.reload = async () => {
    raw.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    raw.fire("session_start", { type: "session_start", reason: "reload" }, ctx);
  };
  commandCtx.waitForIdle = async () => {
    state.idle = true;
  };
  const sockets = () => n.sockets;
  return {
    rawFrames: () =>
      sockets()
        .flatMap((s) => s.written)
        .join("")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => normalize(l)),
    parsedFrames: () => sockets().flatMap((s) => s.frames()),
    frames: () => sockets().flatMap((s) => s.frames()) as unknown as AgentFrame[],
    hub: (frame) =>
      sockets()
        .at(-1)
        ?.hub(frame as never),
    connect: () => sockets().at(-1)?.emit("connect"),
    socketCount: () => sockets().length,
    fire: (ev, event) => raw.fire(ev, event, ctx),
    command: (args) =>
      (registered.get("agent")!.handler as unknown as (a: string, c: unknown) => Promise<void>)(args, commandCtx),
    ctxState: state,
    ctl,
    cleanup: () => {
      resetGlobals();
      tmp.cleanup();
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/** Bring a harness live: session_start → socket → connect → hello_ack, then wait for the burst. */
async function goLive(h: Harness): Promise<void> {
  h.fire("session_start", { type: "session_start", reason: "startup" });
  await waitUntil(() => h.socketCount() > 0, 3_000, "socket");
  h.connect();
  await waitUntil(() => h.frames().some((f) => f.t === "hello"), 3_000, "hello");
  h.hub(ackFrame());
  await settle();
}

interface RunOut {
  raw: string[];
  parsed: unknown[];
}

async function runS1(): Promise<RunOut> {
  const h = buildHarness(() => []);
  try {
    await goLive(h);
    // TUI `/agent reload`, idle: direct deferred reload through the real port/controller.
    await h.command("reload");
    await settle();
    await settle();
    return { raw: h.rawFrames(), parsed: h.parsedFrames() };
  } finally {
    h.cleanup();
  }
}

async function runS2(): Promise<RunOut> {
  const h = buildHarness(() => []);
  try {
    await goLive(h);
    h.hub({
      t: "cmd",
      rid: "r-c1",
      id: "cmdrr000000000001",
      deadlineMs: 8_000,
      origin: ORIGIN,
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await waitUntil(() => h.frames().some((f) => f.t === "cmd_late" || f.t === "cmd_result"), 3_000, "cmd reply");
    await settle();
    await settle();
    return { raw: h.rawFrames(), parsed: h.parsedFrames() };
  } finally {
    h.cleanup();
  }
}

async function runS3(): Promise<RunOut> {
  const h = buildHarness(() => [{ runId: "r1", status: "running" }]);
  try {
    await goLive(h);
    h.hub({
      t: "cmd",
      rid: "r-c2",
      id: "cmdrr000000000002",
      deadlineMs: 8_000,
      origin: ORIGIN,
      cmd: { op: "command", name: "agent", args: "reload", confirm: true },
    });
    await waitUntil(() =>
      h.frames().some((f) => f.t === "cmd_result" && (f as { id?: string }).id === "cmdrr000000000002"),
    );
    await settle();
    h.hub({
      t: "cmd",
      rid: "r-c3",
      id: "cmdrr000000000003",
      deadlineMs: 8_000,
      origin: ORIGIN,
      cmd: { op: "command", name: "agent", args: "reload cancel", confirm: true },
    });
    await waitUntil(() =>
      h.frames().some((f) => f.t === "cmd_result" && (f as { id?: string }).id === "cmdrr000000000003"),
    );
    await settle();
    return { raw: h.rawFrames(), parsed: h.parsedFrames() };
  } finally {
    h.cleanup();
  }
}

const RUNNERS: Record<string, () => Promise<RunOut>> = {
  "s1-tui-reload-idle-handover": runS1,
  "s2-web-reload-idle": runS2,
  "s3-web-reload-busy-cancel": runS3,
};

async function captureAll(): Promise<Record<string, RunOut>> {
  const out: Record<string, RunOut> = {};
  for (const [name, run] of Object.entries(RUNNERS)) out[name] = await run();
  return out;
}

// ------------------------------------------------------------ allow-list compare

interface Parsed {
  t: string;
  reload?: unknown;
  [k: string]: unknown;
}

/**
 * D6's two allowed difference classes for the tracked-Web scenarios:
 *  ① an existing status frame may carry an appended `reload` field;
 *  ② status frames may be INSERTED (one per projection change).
 * Every non-status frame must be byte-equal, in order; the golden's status sequence
 * (reload-stripped) must be a subsequence of the live one, and every INSERTED live status frame
 * must itself carry a `reload` field (a bare inserted status frame is not an allowed class).
 */
function expectCompat(goldenRaw: string[], liveRaw: string[], label: string): void {
  const strip = (p: Parsed): string => {
    const { reload: _drop, ...rest } = p;
    void _drop;
    return JSON.stringify(rest);
  };
  const g = goldenRaw.map((r) => JSON.parse(r) as Parsed);
  const l = liveRaw.map((r) => JSON.parse(r) as Parsed);
  expect(
    g.filter((f) => f.t !== "status").map((f) => JSON.stringify(f)),
    `${label}: non-status frames must stay byte-equal`,
  ).toEqual(l.filter((f) => f.t !== "status").map((f) => JSON.stringify(f)));
  const gs = g.filter((f) => f.t === "status");
  const ls = l.filter((f) => f.t === "status");
  let i = 0;
  for (const lf of ls) {
    if (i < gs.length && strip(lf) === strip(gs[i]!)) {
      i += 1;
      continue;
    }
    // not matching the next golden status ⇒ this must be an inserted projection-change frame
    expect(
      lf.reload !== undefined,
      `${label}: inserted status frame must carry the reload field (D6 class ②); got ${JSON.stringify(lf)}`,
    ).toBe(true);
  }
  expect(i, `${label}: every golden status frame must still appear (modulo the reload key)`).toBe(gs.length);
}

// ---------------------------------------------------------------------- the suite

describe("#30 reload-result compat golden (plan §3 G1, recorded pre-change on dev)", () => {
  it("s1 TUI reload: the COMPLETE frame sequence stays byte-identical; s2/s3 stay within the D6 allow-list", async () => {
    const fresh = await captureAll();
    if (CAPTURE && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      const out = {
        note: "#30 P-A compat golden — captured on UNMODIFIED dev (pre reload-result). Never regenerate to fix a diff.",
        scenarios: Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, { frames: v.raw }])),
      };
      writeFileSync(FIXTURE, `${JSON.stringify(out, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), "golden missing — capture it BEFORE changing any source").toBe(true);
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as { scenarios: Record<string, { frames: string[] }> };
    // s1: full byte equality (TUI reloads are never tracked — Q1)
    expect(fresh["s1-tui-reload-idle-handover"]!.raw, "s1 full sequence").toEqual(
      golden.scenarios["s1-tui-reload-idle-handover"]!.frames,
    );
    expectCompat(
      golden.scenarios["s2-web-reload-idle"]!.frames,
      fresh["s2-web-reload-idle"]!.raw,
      "s2-web-reload-idle",
    );
    expectCompat(
      golden.scenarios["s3-web-reload-busy-cancel"]!.frames,
      fresh["s3-web-reload-busy-cancel"]!.raw,
      "s3-web-reload-busy-cancel",
    );
  });

  it("s1 self-check: the TUI scenario involves a real reload handover (shutdown{reload} → start{reload} on the wire)", async () => {
    // A sanity pin so the golden cannot silently degrade into "no reload ever ran": the s1
    // sequence must contain the post-handover re-attach burst (a second session frame with
    // reason "reload").
    const run = await runS1();
    const sessions = (run.parsed as Parsed[]).filter((f) => f.t === "session");
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect((sessions.at(-1) as { reason?: string }).reason).toBe("reload");
  });

  it("is deterministic: two fresh s1/s2 runs are byte-identical", async () => {
    const a = await runS1();
    const b = await runS1();
    expect(b.raw).toEqual(a.raw);
    const c = await runS2();
    const d = await runS2();
    expect(d.raw).toEqual(c.raw);
  });
});
