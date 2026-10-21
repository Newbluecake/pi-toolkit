/**
 * web-hub-slash-args plan §9 P4 — integration: real in-process hub (`startHub` +
 * `createHttpFrontend`) + the REAL agent-side assembly (`activate()` from src/index.ts with a
 * fake pi), the same harness family as web-hub-e2e.test.ts, plus a raw-protocol "old agent"
 * (no `cmd.args.v1` cap) client for the compat matrix.
 *
 * Coverage (plan §8 集成行 + P4 task sheet):
 *  - cap negotiation: cmdArgs-configured hub ⇒ live link caps carry `cmd.args.v1`, the commands
 *    slot keeps `args` (registry view + SSE `commands` event), POST /api/command/complete works;
 *    a hub WITHOUT `HubConfig.cmdArgs` ⇒ hello_ack lacks the cap, the agent's slot-flush strips
 *    `args` from the commands frame (r1 评审 #1 ②) and the route is absent (404);
 *  - an "old agent" (raw client, no cap in hello.caps) ⇒ local `E_UNSUPPORTED` and NO
 *    `complete_req` frame ever reaches the agent socket;
 *  - POST /api/command/complete end-to-end through the REAL agent engine: S-own (`/webhub`,
 *    registered by the real assembly with its real completer — only `status` survives the
 *    per-item deny filter), an overridden-deny command refused, unknown command 404, and the
 *    50-item cap via a controlled S-tui provider (80 items ⇒ 50 + truncated);
 *  - agent-side timeout: a controlled S-tui provider that never resolves ⇒ the agent's 1.5s
 *    hard-timeout race answers E_DEADLINE and the hub's HTTP reply lands well inside 2s;
 *  - browser disconnect: destroying the HTTP client mid-flight releases the hub's in-flight
 *    slots (audit `code:"aborted"`, r1 #6) — a follow-up request on the same principal still
 *    succeeds instead of eating a leaked-slot 429/503.
 */
import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { currentConnection } from "../../src/web-hub/agent/connection.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import type { FrontendDeps, FrontendFactory, HubEvent } from "../../src/web-hub/hub/ports.js";
import { COMMAND_COMPLETE_PATH } from "../../src/web-hub/protocol/http-contract.js";
import { CMD_ARGS_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import type { CommandInfoWire } from "../../src/web-hub/protocol/messages.js";
import { AGENT_ID_KEY, resetGlobals, waitUntil } from "../web-hub/agent/helpers.js";
import { config as hubConfig, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { spawnHub, resolveJitiCli, type LauncherPlan } from "../../src/web-hub/agent/launcher.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const HOST_KEY = Symbol.for("pi-subagent:host");

type Handler = (event: unknown, ctx: unknown) => unknown;
type RawCommand = { name: string; description?: string; handler?: unknown };

function fakePi(commands: RawCommand[]) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    // pi's API has two shapes — `registerCommand(def)` and `registerCommand(name, def)` (our own
    // topic-switch/feishu registrations use the latter); normalize both, real-pi-style, so
    // `getCommands()` never surfaces a nameless row (it would fail the hub's closed schema and
    // silently drop the WHOLE commands frame).
    registerCommand(...args: unknown[]) {
      const cmd = (
        typeof args[0] === "string" ? { ...(args[1] as Record<string, unknown>), name: args[0] } : args[0]
      ) as RawCommand | undefined;
      if (cmd !== null && typeof cmd === "object" && typeof cmd.name === "string" && cmd.name !== "")
        commands.push(cmd);
    },
    getCommands() {
      return commands
        .filter((c) => typeof c.name === "string" && c.name !== "")
        .map((c) => ({
          name: c.name,
          ...(c.description !== undefined ? { description: c.description } : {}),
          source: "extension",
        }));
    },
    registerTool() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  const fire = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, fire };
}

interface CtxState {
  leaf: string | null;
}

function makeCtx(cwd: string, sessionFile: string, state: CtxState, tuiFactories: unknown[]): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { provider: "test", id: "m" },
    thinkingLevel: "low",
    getContextUsage: () => ({ tokens: 10, contextWindow: 200_000, percent: 0.1 }),
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      // web-hub-slash-args §4.5: the passthrough factory the wiring registers lands here; the
      // test invokes it with a CONTROLLED provider (see feedTuiProvider) so S-tui answers come
      // from deterministic fixtures instead of pi's real base provider.
      addAutocompleteProvider: (f: unknown) => {
        tuiFactories.push(f);
      },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => state.leaf,
      getSessionFile: () => sessionFile,
      getSessionId: () => "slash-args-session",
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;
}

const SETTINGS = (over: { webCommandPolicy?: Record<string, string> } = {}) => ({
  reload: { defer: false },
  webHub: {
    enabled: true,
    autoStart: false,
    port: 0,
    idleExitMinutes: 10,
    ...(over.webCommandPolicy !== undefined ? { webCommandPolicy: over.webCommandPolicy } : {}),
  },
  hud: { enabled: false },
  sessionNav: { enabled: false },
  feishuNotify: { enabled: false },
  memory: { enabled: false },
  webSearch: { enabled: false },
  todo: { enabled: false },
  askUser: { enabled: false },
  quota: { enabled: false },
  goal: { enabled: false },
  cacheTtl: { mode: "off" },
  fleetWidget: false,
});

/** A controlled stand-in for the TUI base provider the wiring's passthrough factory captures. */
interface ControlledProvider {
  provider: {
    getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean },
    ): Promise<{ items: { value: string; label: string; description?: string }[]; prefix: string } | null>;
  };
  calls: { line: string; signal: AbortSignal }[];
  setHandler(
    h: (
      line: string,
    ) => Promise<{ items: { value: string; label: string; description?: string }[]; prefix: string } | null>,
  ): void;
}

function controlledProvider(): ControlledProvider {
  const calls: ControlledProvider["calls"] = [];
  let handler: ControlledProvider["setHandler"] extends (h: infer H) => void ? H : never = async () => null;
  return {
    calls,
    setHandler: (h) => {
      handler = h;
    },
    provider: {
      getSuggestions: async (lines, _cl, _cc, options) => {
        const line = lines[0] ?? "";
        calls.push({ line, signal: options.signal });
        return handler(line);
      },
    },
  };
}

interface Env {
  home: string;
  cwd: string;
  sessionFile: string;
  hub: RunningHub;
  feDeps: FrontendDeps;
  agentKey: string;
  pi: ReturnType<typeof fakePi>;
  ctx: ExtensionContext;
  ctxState: CtxState;
  cookie: string;
  sse: SseConn[];
  restoreHome: () => void;
  tuiFactories: unknown[];
}

async function setup(
  opts: { cmdArgs?: "all" | "toolkit"; webCommandPolicy?: Record<string, string> } = {},
): Promise<Env> {
  const home = sandboxHome();
  const settingsPath = join(home.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(SETTINGS({ ...(opts.webCommandPolicy ? { webCommandPolicy: opts.webCommandPolicy } : {}) })) + "\n",
    "utf8",
  );
  const cwd = mkdtempSync(join(tmpdir(), "wh-slash-args-cwd-"));
  const sessionFile = join(cwd, "session.jsonl");
  const ts = "2026-10-21T00:00:00.000Z";
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "sess-slash-args", timestamp: ts, cwd }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: "fixture", timestamp: 1 },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  let feDeps: FrontendDeps | undefined;
  const frontend: FrontendFactory = (d) => {
    feDeps = d;
    return createHttpFrontend(d);
  };
  const started = await startHub(
    hubConfig({ home: home.home, port: 0, ...(opts.cmdArgs !== undefined ? { cmdArgs: opts.cmdArgs } : {}) }),
    frontend,
    { uid: process.getuid?.() ?? 0 },
  );
  if ("exists" in started) throw new Error("unexpected hub singleton collision");
  const hub = started;

  // Test-injected extension commands (registered on the RAW pi before activate so they are
  // visible to pi.getCommands() but were never routed through wrapCommandApi's proxy — exactly
  // the S-tui/third-party shape: no S-own completer, kind "extension").
  const commands: RawCommand[] = [
    { name: "bulkcmd", description: "bulk completion probe" },
    { name: "slowcmd", description: "hanging completion probe" },
    // denycmd is deny only in the override-carrying test; elsewhere it is an ordinary
    // third-party row (pre-registered because the commands slot does not republish on
    // later registerCommand calls)
    { name: "denycmd", description: "override-deny probe" },
  ];
  const pi = fakePi(commands);
  activate(pi.pi);
  const ctxState: CtxState = { leaf: "u1" };
  const tuiFactories: unknown[] = [];
  const ctx = makeCtx(cwd, sessionFile, ctxState, tuiFactories);
  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => feDeps!.registry.list().length === 1, 8_000, "agent registered");
  const agentKey = feDeps!.registry.list()[0]!.agentKey;
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);

  env = {
    home: home.home,
    cwd,
    sessionFile,
    hub,
    feDeps: feDeps!,
    agentKey,
    pi,
    ctx,
    ctxState,
    cookie,
    sse: [],
    restoreHome: home.restore,
    tuiFactories,
  };
  return env;
}

/** Feed the wiring's captured passthrough factory our controlled provider (S-tui readiness).
 * Two factories register in TUI mode (the web-hub passthrough + src/index.ts's @label mention
 * wrapper) — identify ours by its transparency: it returns `current` UNCHANGED. */
function feedTuiProvider(e: Env, cp: ControlledProvider): void {
  expect(e.tuiFactories.length).toBeGreaterThanOrEqual(1);
  const marker = {};
  const factory = e.tuiFactories.find((f) => (f as (current: unknown) => unknown)(marker) === marker);
  expect(factory).toBeDefined();
  const out = (factory as (current: unknown) => unknown)(cp.provider);
  expect(out).toBe(cp.provider); // transparent passthrough — never a new object
}

function rowsOf(e: Env): CommandInfoWire[] {
  const rows = e.feDeps.registry.get(e.agentKey)?.commands;
  expect(rows).toBeDefined();
  return rows as CommandInfoWire[];
}

function complete(
  e: Env,
  body: { name: string; prefix?: string; agentKey?: string },
): Promise<{ status: number; body: string; json: any }> {
  return postJson(
    e.hub.httpPort,
    COMMAND_COMPLETE_PATH,
    {
      agentKey: body.agentKey ?? e.agentKey,
      name: body.name,
      prefix: body.prefix ?? "",
    },
    // strictCsrf: same-origin Origin, exactly like the browser would send
    { Cookie: e.cookie, Origin: `http://127.0.0.1:${e.hub.httpPort}` },
  ).then((res) => ({
    status: res.status,
    body: res.body,
    json: (() => {
      try {
        return JSON.parse(res.body);
      } catch {
        return undefined;
      }
    })(),
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

/** Fire + destroy one POST mid-flight (browser disconnect). Resolves once the socket is gone. */
function fireAndDestroy(e: Env, name: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ agentKey: e.agentKey, name, prefix: "" });
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: e.hub.httpPort,
        method: "POST",
        path: COMMAND_COMPLETE_PATH,
        headers: {
          "Content-Type": "application/json",
          "X-PWH": "1",
          Cookie: e.cookie,
          Origin: `http://127.0.0.1:${e.hub.httpPort}`,
          "Content-Length": String(Buffer.byteLength(body)),
        },
        agent: false,
      },
      () => {
        /* we expect to destroy before any response; a fast reply is also fine */
      },
    );
    req.on("error", () => resolve()); // ECONNRESET after destroy — the expected end
    req.on("close", () => resolve());
    req.write(body);
    req.end();
    // give the hub time to admit the request and forward complete_req, then hang up
    const t = setTimeout(() => req.destroy(), 150);
    t.unref();
    // safety net: never hang the test on a silent socket
    setTimeout(resolve, 8_000).unref();
  });
}

/** Parse the hub's log file for command-complete audit records. */
function auditRecords(e: Env): Array<Record<string, unknown>> {
  try {
    const text = readFileSync(e.hub.paths.logFile, "utf8");
    const out: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      if (!line.includes("command-complete")) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        out.push((parsed.data as Record<string, unknown>) ?? parsed);
      } catch {
        /* non-JSON line — ignore */
      }
    }
    return out;
  } catch {
    return [];
  }
}

afterEach(async () => {
  const e = env;
  env = undefined;
  if (e === undefined) return;
  try {
    await e.pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, e.ctx);
  } catch {
    /* best effort */
  }
  for (const sse of e.sse.splice(0)) sse.close();
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  await e.hub.close("slash-args-test-teardown").catch(() => undefined);
  e.restoreHome();
  rmSync(e.cwd, { recursive: true, force: true });
});

let env: Env | undefined;

describe("web-hub slash-args integration — real hub × real assembly", () => {
  it("cap on: hub advertises cmd.args.v1, commands frame keeps args (registry + SSE), route works", async () => {
    const e = await setup({ cmdArgs: "all" });
    await waitUntil(
      () => rowsOf(e).some((r) => r.name === "webhub" && r.args !== undefined),
      8_000,
      "commands row with args",
    );

    // live link caps (agent side) — the cap the strip-flush keys on
    expect(currentConnection()?.caps).toContain(CMD_ARGS_HUB_CAP);

    const rows = rowsOf(e);
    const webhub = rows.find((r) => r.name === "webhub");
    expect(webhub?.args?.complete).toBe(true); // S-own registered by the real assembly
    expect(typeof webhub?.args?.usage).toBe("string");
    // a builtin row: table usage, never dynamic completion (§3.1)
    const model = rows.find((r) => r.name === "model");
    expect(model?.args?.usage).toBe("<provider/model>");
    expect(model?.args?.complete).toBeUndefined();
    // a third-party (test-injected) row: r1 #9's OPTIMISTIC complete — "all" mode marks every
    // extension row complete:true even before S-tui readiness (empty results are normal)
    const bulk = rows.find((r) => r.name === "bulkcmd");
    expect(bulk?.args?.complete).toBe(true);

    // SSE: open the browser, then flip S-tui readiness — the republished commands event is
    // what the P3 UI keys on (args !== undefined as the positive capability signal).
    const sse = await openSse(e.hub.httpPort, { cookie: e.cookie });
    e.sse.push(sse);
    await sse.waitFor((ev) => ev.event === "hello", 5_000);
    feedTuiProvider(e, controlledProvider());
    const ev = await sse.waitFor(
      (x) =>
        x.event === "commands" &&
        Array.isArray(x.data.items) &&
        x.data.items.some((r: any) => r.name === "bulkcmd" && r.args?.complete === true),
      8_000,
    );
    expect(ev.data.items.find((r: any) => r.name === "webhub")?.args?.usage).toBeTruthy();
  }, 30_000);

  it("cap on: S-own round trip (/webhub) with per-item deny filter + unknown/deny commands refused", async () => {
    const e = await setup({
      cmdArgs: "all",
      webCommandPolicy: { denycmd: "deny" },
    });
    await waitUntil(
      () => {
        const rows = e.feDeps.registry.get(e.agentKey)?.commands ?? [];
        return rows.some((r) => r.name === "webhub" && r.args !== undefined) && rows.some((r) => r.name === "denycmd");
      },
      8_000,
      "commands rows (webhub + denycmd)",
    );

    // S-own: the real /webhub completer returns every subcommand; the agent's per-item policy
    // filter drops everything except `status` (command-policy.ts: only status is web-allow).
    const ok = await complete(e, { name: "webhub", prefix: "" });
    expect(ok.status).toBe(200);
    expect(ok.json.source).toBe("own");
    const values: string[] = ok.json.items.map((i: any) => i.value);
    expect(values).toContain("status");
    for (const denied of ["passwd", "2fa", "user", "open", "unlock", "restart", "stop", "start", "token", "feishu"]) {
      expect(values).not.toContain(denied);
      expect(values.some((v) => v.startsWith(`${denied} `))).toBe(false);
    }
    // prefix filtering still happens inside the completer itself (typed prefix)
    const typed = await complete(e, { name: "webhub", prefix: "st" });
    expect(typed.status).toBe(200);
    expect(typed.json.items.map((i: any) => i.value)).toEqual(["status"]);

    // deny command (webCommandPolicy override ⇒ row policy deny): refused, never completed
    const deny = await complete(e, { name: "denycmd", prefix: "" });
    expect(deny.status).toBe(403);
    expect(deny.json.error).toBe("E_COMMAND_DENIED");

    // unknown command: local 404 (never forwarded)
    const unknown = await complete(e, { name: "nosuchcmd", prefix: "" });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("E_UNKNOWN_COMMAND");
  }, 30_000);

  it("cap on: S-tui 80 items ⇒ 50 + truncated:true (item cap end-to-end)", async () => {
    const e = await setup({ cmdArgs: "all" });
    const cp = controlledProvider();
    cp.setHandler(async (line) => {
      if (!line.startsWith("/bulkcmd ")) return null;
      const prefix = line.slice("/bulkcmd ".length);
      return {
        prefix,
        items: Array.from({ length: 80 }, (_, i) => ({ value: `v${i}`, label: `l${i}` })),
      };
    });
    feedTuiProvider(e, cp);
    await waitUntil(() => rowsOf(e).some((r) => r.name === "bulkcmd"), 8_000, "commands rows");
    const res = await complete(e, { name: "bulkcmd", prefix: "" });
    expect(res.status).toBe(200);
    expect(res.json.source).toBe("tui");
    expect(res.json.items.length).toBe(50);
    expect(res.json.truncated).toBe(true);
    expect(cp.calls.length).toBe(1);
    expect(cp.calls[0]!.line).toBe("/bulkcmd ");
  }, 30_000);

  it("agent timeout: hanging S-tui provider ⇒ E_DEADLINE well inside 2s, signal aborted", async () => {
    const e = await setup({ cmdArgs: "all" });
    const cp = controlledProvider();
    cp.setHandler(
      () =>
        new Promise(() => {
          /* never settles — the agent's 1.5s hard-timeout race must win */
        }),
    );
    feedTuiProvider(e, cp);
    await waitUntil(() => rowsOf(e).some((r) => r.name === "slowcmd"), 8_000, "commands rows");
    const t0 = Date.now();
    const res = await complete(e, { name: "slowcmd", prefix: "" });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(504);
    expect(res.json.error).toBe("E_DEADLINE");
    // agent races at 1500ms; anything beyond the hub's 4s route budget would be a hang, and the
    // P4 acceptance bound is "hub answers the error within 2s"
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(2_000);
    // the S-tui abort signal fired the moment the timeout won (§4.3 #4)
    await waitUntil(() => cp.calls[0]?.signal.aborted === true, 2_000, "S-tui abort signal");
  }, 30_000);

  it("browser disconnect: in-flight requests released (audit aborted) and the route stays usable", async () => {
    const e = await setup({ cmdArgs: "all" });
    const cp = controlledProvider();
    cp.setHandler(
      () =>
        new Promise(() => {
          /* hang past the disconnect */
        }),
    );
    feedTuiProvider(e, cp);
    await waitUntil(() => rowsOf(e).some((r) => r.name === "webhub"), 8_000, "commands rows");

    // 3 hanging requests on the SAME principal (hub per-principal in-flight cap is 3): destroy
    // each mid-flight. Two genuinely hang agent-side; the third settles fast (agent in-flight
    // cap 2 ⇒ E_RATE) — either way the hub must release every slot.
    await Promise.all([fireAndDestroy(e, "slowcmd"), fireAndDestroy(e, "slowcmd"), fireAndDestroy(e, "slowcmd")]);
    // let the agent's 1.5s timeout settle the two real hangs before re-probing the route
    await delay(1_800);

    // the route is still fully usable on the same principal: no leaked-slot 429/503
    const good = await complete(e, { name: "webhub", prefix: "" });
    expect(good.status).toBe(200);
    expect(good.json.items.map((i: any) => i.value)).toContain("status");

    // r1 #6: every destroyed request audited code:"aborted" — and never any prefix/item text
    const aborted = auditRecords(e).filter((r) => r.code === "aborted");
    expect(aborted.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(auditRecords(e));
    expect(serialized).not.toContain("prefix");
    expect(serialized).not.toContain("v0");
  }, 30_000);

  it("hub without cmdArgs: no cap, commands frame carries no args, route absent (404)", async () => {
    const e = await setup({}); // no cmdArgs key in HubConfig
    await waitUntil(() => rowsOf(e).some((r) => r.name === "webhub"), 8_000, "commands rows");
    expect(currentConnection()?.caps).not.toContain(CMD_ARGS_HUB_CAP);
    for (const row of rowsOf(e)) {
      expect(row.args).toBeUndefined(); // r1 评审 #1 ②: strip-flush against CURRENT hub caps
    }
    const res = await complete(e, { name: "webhub", prefix: "" });
    expect(res.status).toBe(404); // route never constructed
  }, 30_000);

  it("old agent (no cmd.args.v1 cap): local E_UNSUPPORTED, zero complete_req frames on its socket", async () => {
    const e = await setup({ cmdArgs: "all" });
    let client: TestClient | undefined;
    try {
      client = await connectClient(e.hub.paths.socketPath);
      client.send(
        hello({
          agentId: { pid: process.pid, nonce: "oldagentnonce000" },
          epoch: "eOld",
          cwd: "/tmp/old-agent",
          caps: ["ev.v1", "cmd.v1", "command.v1"], // everything EXCEPT cmd.args.v1
        }),
      );
      const ack = await client.waitFrame((f) => f["t"] === "hello_ack", 5_000);
      const oldKey = ack["agentKey"] as string;
      client.send({
        t: "commands",
        epoch: "eOld",
        items: [{ name: "oldcmd", kind: "extension", description: "old agent command", policy: "allow" }],
      });
      await delay(100); // hub-side onFrame is synchronous on the socket data event

      const res = await complete(e, { name: "oldcmd", prefix: "", agentKey: oldKey });
      expect(res.status).toBe(501);
      expect(res.json.error).toBe("E_UNSUPPORTED");

      await delay(300); // a forwarded complete_req would arrive within one hub tick
      const reqs = (client.frames as Array<Record<string, unknown>>).filter((f) => f["t"] === "complete_req");
      expect(reqs).toEqual([]);
    } finally {
      client?.sock.destroy();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Real hub CHILD PROCESSES (the production boot path — hub/main.ts config
// re-validation, cap folding and route construction all run in the forked
// jiti child, exactly as `pi` itself would start it). Skipped off Linux or
// when pi's bundled jiti is not resolvable, mirroring web-hub-worktree-diff's
// D6 gate.
// ---------------------------------------------------------------------------

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const HUB_MAIN = resolve("src/web-hub/hub/main.ts");
const IS_LINUX = process.platform === "linux";

const CHILD_PLAN: LauncherPlan | undefined = (() => {
  if (!IS_LINUX) return undefined;
  if (!existsSync(PI_CLI)) return undefined;
  const r = resolveJitiCli({ argv1: PI_CLI, override: "" });
  if (!r.ok) return undefined;
  return { execPath: process.execPath, jitiCli: r.jitiCli, argv1: PI_CLI };
})();

interface ChildEnv {
  home: string;
  hubPid: number;
  port: number;
  cookie: string;
  cwd: string;
  pi: ReturnType<typeof fakePi>;
  ctx: ExtensionContext;
  sse: SseConn[];
  restoreHome: () => void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

async function bootChildHub(opts: { cmdArgs?: "all" | "toolkit" }): Promise<{
  home: string;
  hubPid: number;
  port: number;
  tokenFile: string;
  cwd: string;
  restoreHome: () => void;
}> {
  const sandbox = sandboxHome();
  const cwd = mkdtempSync(join(tmpdir(), "wh-slash-args-child-"));
  // the hub child needs a token file dir etc.; settings land BEFORE either side boots
  const settingsPath = join(sandbox.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(SETTINGS()) + "\n", "utf8");
  const paths = resolveHubPaths({ home: sandbox.home, uid: process.getuid?.() ?? 0 });
  spawnHub(
    CHILD_PLAN!,
    HUB_MAIN,
    hubConfig({
      home: sandbox.home,
      port: 0,
      idleExitMinutes: 10,
      ...(opts.cmdArgs !== undefined ? { cmdArgs: opts.cmdArgs } : {}),
    }),
  );
  await waitUntil(
    () => {
      try {
        const j = JSON.parse(readFileSync(paths.hubJson, "utf8")) as { pid?: unknown; port?: unknown };
        return typeof j.pid === "number" && typeof j.port === "number" && pidAlive(j.pid);
      } catch {
        return false;
      }
    },
    40_000,
    "child hub up",
  );
  const hubJson = JSON.parse(readFileSync(paths.hubJson, "utf8")) as { pid: number; port: number };
  return {
    home: sandbox.home,
    hubPid: hubJson.pid,
    port: hubJson.port,
    tokenFile: paths.tokenFile,
    cwd,
    restoreHome: sandbox.restore,
  };
}

describe.skipIf(CHILD_PLAN === undefined)("web-hub slash-args integration — real hub child process", () => {
  let child: ChildEnv | undefined;

  afterEach(async () => {
    const e = child;
    child = undefined;
    if (e === undefined) return;
    try {
      await e.pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, e.ctx);
    } catch {
      /* best effort */
    }
    for (const sse of e.sse.splice(0)) sse.close();
    resetGlobals();
    delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    try {
      process.kill(e.hubPid, "SIGTERM");
    } catch {
      /* already gone */
    }
    await waitUntil(() => !pidAlive(e.hubPid), 10_000, "child hub exit").catch(() => {
      try {
        process.kill(e.hubPid, "SIGKILL");
      } catch {
        /* gone */
      }
    });
    e.restoreHome();
    rmSync(e.cwd, { recursive: true, force: true });
  });

  it("cmdArgs config: production boot ⇒ cap advertised, agent assembly connects, completion round-trips", async () => {
    const boot = await bootChildHub({ cmdArgs: "all" });
    const cookie = await login(boot.port, boot.tokenFile);
    const sse = await openSse(boot.port, { cookie });
    child = {
      home: boot.home,
      hubPid: boot.hubPid,
      port: boot.port,
      cookie,
      cwd: boot.cwd,
      pi: fakePi([]),
      ctx: undefined as unknown as ExtensionContext,
      sse: [sse],
      restoreHome: boot.restoreHome,
    };
    await sse.waitFor((ev) => ev.event === "hello", 5_000);

    // the REAL agent-side assembly (fake pi) against the CHILD hub
    activate(child.pi.pi);
    const ctxState: CtxState = { leaf: null };
    const tuiFactories: unknown[] = [];
    child.ctx = makeCtx(boot.cwd, join(boot.cwd, "session.jsonl"), ctxState, tuiFactories);
    await child.pi.fire("session_start", { type: "session_start", reason: "startup" }, child.ctx);

    // the hub only pushes an `agents` snapshot on hello (no re-broadcast on later joins) —
    // the live join signal for a browser that connected FIRST is `agent_up`
    const upEv = await sse.waitFor((ev) => ev.event === "agent_up" && typeof ev.data.agentKey === "string", 10_000);
    const agentKey = upEv.data.agentKey as string;
    expect(currentConnection()?.caps).toContain(CMD_ARGS_HUB_CAP);

    // the commands frame (SSE) keeps args through the production cap path
    const cmdsEv = await sse.waitFor(
      (ev) =>
        ev.event === "commands" &&
        Array.isArray(ev.data.items) &&
        ev.data.items.some((r: any) => r.name === "webhub" && r.args?.complete === true),
      10_000,
    );
    expect(cmdsEv.data.agentKey).toBe(agentKey);

    // full round trip through the forked hub's HTTP route
    const res = await postJson(
      boot.port,
      COMMAND_COMPLETE_PATH,
      { agentKey, name: "webhub", prefix: "" },
      { Cookie: cookie, Origin: `http://127.0.0.1:${boot.port}` },
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("own");
    expect(body.items.map((i: any) => i.value)).toEqual(["status"]);
  }, 90_000);

  it("no cmdArgs key: production boot ⇒ route absent (404) even with a fresh agent", async () => {
    const boot = await bootChildHub({});
    const cookie = await login(boot.port, boot.tokenFile);
    child = {
      home: boot.home,
      hubPid: boot.hubPid,
      port: boot.port,
      cookie,
      cwd: boot.cwd,
      pi: fakePi([]),
      ctx: undefined as unknown as ExtensionContext,
      sse: [],
      restoreHome: boot.restoreHome,
    };
    const res = await rawRequest(boot.port, {
      method: "POST",
      path: COMMAND_COMPLETE_PATH,
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: cookie },
      body: JSON.stringify({ agentKey: "a1-abcdef", name: "webhub", prefix: "" }),
    });
    expect(res.status).toBe(404);
  }, 90_000);
});
