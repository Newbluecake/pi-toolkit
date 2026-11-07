/** Real SDK1.5 AgentSession → production Fast hooks → final SSE/WS transports.
 * All transports are in-process numeric-loopback guarded; real sockets are forbidden.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { wireFastMain, type FastSessionPorts } from "../../src/fast/wire.js";

type Body = Record<string, unknown>;
const fakeToken = `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE_LOCAL_ONLY" } })).toString("base64url")}.fake`;
let http: Body[];
let ws: Body[];
let serial = 0;
let holdNext: boolean;
let releaseHeld: (() => void) | undefined;
const roots: string[] = [];
const sessions: AgentSession[] = [];
function loopback(raw: string) {
  const u = new URL(raw);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "[::1]") throw Error("External endpoint forbidden");
}
function events() {
  const id = `resp_local_${++serial}`;
  return [
    { type: "response.created", response: { id, service_tier: "default" } },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        service_tier: "default",
        output: [],
        usage: { input_tokens: 50000, output_tokens: 0, total_tokens: 50000 },
      },
    },
  ];
}
const localFetch: typeof fetch = async (input, init) => {
  loopback(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const bytes = init?.body;
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes as Uint8Array);
  http.push(JSON.parse(text) as Body);
  if (holdNext) {
    holdNext = false;
    await new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
  }
  return new Response(
    events()
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};
class LocalWebSocket extends EventTarget {
  readyState = 0;
  constructor(url: string) {
    super();
    loopback(url);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(text: string) {
    ws.push(JSON.parse(text) as Body);
    const reply = events();
    setImmediate(() => {
      for (const e of reply) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(e) }));
    });
  }
  close() {
    this.readyState = 3;
  }
}
beforeEach(() => {
  http = [];
  ws = [];
  holdNext = false;
  releaseHeld = undefined;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw Error("Real sockets forbidden");
  });
  vi.stubGlobal("fetch", localFetch);
  vi.stubGlobal("WebSocket", LocalWebSocket);
});
afterEach(() => {
  releaseHeld?.();
  for (const session of sessions.splice(0)) session.dispose();
  closeOpenAICodexWebSocketSessions();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(warm = false) {
  const root = mkdtempSync(join(tmpdir(), "fast-wiring-wire-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const model = (api: string, id: string) => ({
    id,
    name: id,
    api,
    reasoning: false,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 1024,
    cost: { input: 100, output: 1, cacheRead: 0.1, cacheWrite: 100 },
    promptCache: { short: 11 },
    samplingParams: { service_tier: "flex" },
  });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "fast-local": {
          baseUrl: "http://127.0.0.1:19555/v1",
          api: "openai-responses",
          apiKey: "FAKE_LOCAL_ONLY",
          models: [model("openai-responses", "wire-common")],
        },
        "fast-codex": {
          baseUrl: "http://127.0.0.1:19555/v1",
          api: "openai-codex-responses",
          apiKey: fakeToken,
          models: [model("openai-codex-responses", "wire-codex")],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(root, "catalog"),
    allowModelNetwork: false,
  });
  const settings = SettingsManager.inMemory({
    cacheWarming: warm ? "idle" : "off",
    transport: "auto",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  let ports: FastSessionPorts | undefined;
  const captures: Body[] = [];
  const originals: Body[] = [];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      (pi) => {
        pi.on("before_provider_request", (event) => {
          originals.push(event.payload as Body);
        });
        const fast = wireFastMain(pi, true)!;
        pi.on("session_start", (_event, ctx) => {
          ports = fast.open(ctx);
        });
        // A later traffic-like observer sees Fast's replacement (no rewrite of its own).
        pi.on("before_provider_request", (event) => {
          captures.push(event.payload as Body);
        });
      },
    ],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("fast-local", "wire-common")!,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: "all",
  });
  sessions.push(session);
  const notify = vi.fn();
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { notify, setStatus: vi.fn() } as unknown as ExtensionUIContext,
  });
  return { session, ports: () => ports!, runtime, manager, captures, originals, notify };
}
async function spin(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
}

describe("Fast real session final wire", () => {
  it("SSE + real native CacheWarmer overlap: delivered on body remains priority; later warm follows off, observation is uncorrelated", async () => {
    const f = await fixture(true);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await f.session.prompt("first local fixture");
    expect(http).toHaveLength(1);
    expect(http[0]!.service_tier).toBe("flex");
    expect(f.manager.getBranch().filter((e) => e.type === "custom" && e.customType === "subagent:fast")).toHaveLength(
      0,
    );
    await f.session.prompt("/fast on");
    holdNext = true;
    const normal = f.session.prompt("second local fixture");
    await spin(() => http.length === 2 && releaseHeld !== undefined);
    const delivered = http[1]!;
    expect(delivered.service_tier).toBe("priority");
    await f.session.prompt("/fast off");
    expect(f.session.cacheWarmingStatus?.state).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(1001);
    await spin(() => http.length === 3);
    expect(http[2]!.service_tier).toBe("default");
    expect(http[2]!.max_output_tokens).toBe(16); // Real streamSimple clamps its requested one-token warm cap to 16.
    expect(delivered.service_tier).toBe("priority");
    releaseHeld!();
    await normal;
    expect(f.manager.getBranch().filter((e) => e.type === "usage" && e.kind === "cache_warm")).toHaveLength(1);
    await f.session.prompt("/fast status");
    const status = f.notify.mock.calls.at(-1)?.[0] as string;
    expect(status).toContain("requested=off");
    expect(status).toContain("latest observed=default (origin unknown)");
    expect(status).toContain("premium");
    expect(http).toHaveLength(3);
    expect(f.captures.map((b) => b.service_tier)).toEqual(["flex", "priority", "default"]);
    f.ports().dispose();
  });
  it("public SDK setModel during an in-flight SSE request does not rewrite the delivered old body", async () => {
    const f = await fixture();
    await f.session.prompt("/fast on");
    holdNext = true;
    const pending = f.session.prompt("held common stream");
    await spin(() => http.length === 1 && releaseHeld !== undefined);
    expect(http[0]!.model).toBe("wire-common");
    expect(http[0]!.service_tier).toBe("priority");
    await f.session.setModel(f.runtime.getModel("fast-codex", "wire-codex")!);
    await f.session.prompt("/fast off");
    expect(f.session.model?.api).toBe("openai-codex-responses");
    expect(http[0]!.model).toBe("wire-common");
    expect(http[0]!.service_tier).toBe("priority");
    releaseHeld!();
    await pending;
    await f.session.prompt("new physical API");
    expect(http).toHaveLength(1);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.model).toBe("wire-codex");
    expect(ws[0]!.service_tier).toBe("default");
    f.ports().dispose();
  });

  it("cross-API selection change and real Codex cached WS continuation invalidate prior context on tier switch", async () => {
    const f = await fixture();
    await f.session.prompt("/fast on");
    await f.session.prompt("common");
    expect(http.at(-1)?.service_tier).toBe("priority");
    await f.session.setModel(f.runtime.getModel("fast-codex", "wire-codex")!);
    await f.session.prompt("codex first");
    expect(ws).toHaveLength(1);
    expect(ws[0]!.service_tier).toBe("priority");
    await f.session.prompt("codex continuation");
    expect(ws).toHaveLength(2);
    expect(ws[1]!.previous_response_id).toMatch(/^resp_local_/);
    expect(ws[1]!.service_tier).toBe("priority");
    await f.session.prompt("/fast off");
    await f.session.prompt("codex after switch");
    expect(ws).toHaveLength(3);
    expect(ws[2]!.service_tier).toBe("default");
    expect(ws[2]).not.toHaveProperty("previous_response_id");
    expect(ws[0]!.service_tier).toBe("priority");
    await f.session.prompt("/fast reset");
    await f.session.prompt("codex inherit");
    expect(ws).toHaveLength(4);
    expect(ws[3]).not.toHaveProperty("service_tier");
    expect(f.captures.at(-1)).toBe(f.originals.at(-1)); // inherit preserves actual SDK body, not a reconstructed tier
    expect(http).toHaveLength(1);
    expect(f.captures.map((b) => b.service_tier)).toEqual(["priority", "priority", "priority", "default", undefined]);
    f.ports().dispose();
  });
});
