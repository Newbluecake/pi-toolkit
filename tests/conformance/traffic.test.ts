/**
 * traffic 合并 T6 conformance — 真 pi `AgentSession` + 本地 provider stub（plan r3 §8.3）。
 *
 * 钉住的 pi 事实（peer 升级闸门；任一在新 pi 上不成立 ⇒ 本文件失败）：
 * - CT1 每个会话请求的钩子/网络顺序恰为 headers → payload → fetch → response，
 *   且 headers 钩子就地可变、payload 钩子返回值会替换后续负载。
 * - CT2 票据头 `x-pi-traffic-ticket` 经各白名单 SDK（anthropic-messages /
 *   openai-completions / openai-responses）到达 `globalThis.fetch`，且被 traffic
 *   拦截层剥离 —— provider stub 从未收到票据头（§5.3 白名单前提，R-b）。
 * - CT3 同一请求只有 400 strict-tools 回退会再次触发 `onPayload`（headers 只一次）；
 *   2xx 响应头之后不再有 `onPayload`；非 2xx 不调用 `after_provider_response`。
 * - CT4 traffic 录到 cache-ttl `mode=on` 改写后的 payload（activate 顺序：traffic 在
 *   cache-ttl 之后注册 ⇒ 看到的是改写结果）。
 * - CT5 pi 原生 cache warmer 复制会话 requestOptions（transformHeaders + onPayload），
 *   触发 headers 与 payload 两个钩子（§5.3 退役规则 ② 的前提）。
 * - CT6 compaction 只触发 headers 钩子（options 不含 onPayload）。
 * - CT7 子会话（同进程第二个 AgentSession = 生产子会话的同一装配路径）的请求以
 *   子会话自身 id 落库。
 * - CT8/CT9 Codex（openai-codex-responses）：SSE transport 票据可达且被剥离；默认
 *   （auto/websocket）transport 的 WS 握手携带票据头且不经 `globalThis.fetch` ⇒
 *   无法剥离 ⇒ 维持白名单外（R-b，结论见 T6-report）。
 *
 * 全程临时 HOME/agentDir，无外网；`traffic.enabled` 在临时 settings 显式开启。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  initTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { peekEngine } from "../../src/traffic/engine.js";
import { resetTrafficGlobalForTest } from "../../src/traffic/container.js";
import { resetTrafficSessionSlotsForTest } from "../../src/traffic/index.js";
import { resetTrafficClaimForTest } from "../../src/traffic/claim.js";
import { AnthropicStub, type StubReply } from "./fixtures/anthropic-stub.js";
import { OpenAIStub } from "./fixtures/openai-stub.js";

/**
 * 真实 toolkit 入口（jiti 加载，sourceInfo 指向包内路径——factory 加载的合成 sourceInfo
 * 会被认领复核 fail-closed 误判为外部录制器，那本身就是生产行为，不用绕）。
 */
const TOOLKIT_ENTRY = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts"));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const KEEPALIVE_PORT_KEY = Symbol.for("pi-subagent:traffic-keepalive-port");
const REWRITE_MARKS_KEY = Symbol.for("pi-subagent:traffic-rewrite-marks");
const TICKET_HEADER = "x-pi-traffic-ticket";

type ApiId = "anthropic-messages" | "openai-completions" | "openai-responses" | "openai-codex-responses";

// ── 进程级清理（符号 / engine / fetch 探针 / env）──────────────────────────────

interface FetchCall {
  seq: number;
  url: string;
  method: string;
  ticket: string | null;
  authorization: string | null;
}

const probes: Array<() => void> = [];
const hosts: Array<() => Promise<void>> = [];
const stubs: Array<{ close(): Promise<void> }> = [];
const scratchDirs: string[] = [];

/** 装在 traffic 拦截层**之上**（/record on 之后安装）⇒ 观测 SDK 传给 globalThis.fetch 的原始头。 */
function installFetchProbe(): FetchCall[] {
  const downstream = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawHeaders =
      init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined);
    const headers = new Headers(rawHeaders as HeadersInit | undefined);
    calls.push({
      seq: seq++,
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"),
      ticket: headers.get(TICKET_HEADER),
      authorization: headers.get("authorization") ?? headers.get("x-api-key"),
    });
    return downstream(input, init);
  }) as typeof fetch;
  probes.push(() => {
    globalThis.fetch = downstream;
  });
  return calls;
}

let seq = 0;

/**
 * CT8/CT9 探针：在 headers 钩子注入同形票据头（与 traffic 铸票同一注入点、同一传播路径）。
 * codex 不在白名单，traffic 不会为它铸票据——本探针证明的是「若入白名单」的可达性/剥离性。
 */
function ticketInjectingSpy(value: string): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    pi.on("before_provider_headers", (event) => {
      (event.headers as Record<string, string>)[TICKET_HEADER] = value;
    });
  };
}

interface SpyEvent {
  seq: number;
  kind: "headers" | "payload" | "response" | "warming-decision";
  api: string | null;
  maxTokens: number | null;
  status: number | null;
  ticketInHeaders: boolean;
}

/** 观察扩展：记录钩子事件的全局顺序（注册在 activate 之后 ⇒ 收到最终 payload）。 */
function hookSpy() {
  const events: SpyEvent[] = [];
  const factory = (pi: ExtensionAPI): void => {
    pi.on("before_provider_headers", (event) => {
      const headers = event.headers as Record<string, unknown>;
      events.push({
        seq: seq++,
        kind: "headers",
        api: null,
        maxTokens: null,
        status: null,
        ticketInHeaders: typeof headers[TICKET_HEADER] === "string",
      });
    });
    pi.on("before_provider_request", (event) => {
      const payload = event.payload as { max_tokens?: unknown; model?: unknown };
      events.push({
        seq: seq++,
        kind: "payload",
        api: typeof payload.model === "string" ? payload.model : null,
        maxTokens: typeof payload.max_tokens === "number" ? payload.max_tokens : null,
        status: null,
        ticketInHeaders: false,
      });
    });
    pi.on("after_provider_response", (event) => {
      events.push({
        seq: seq++,
        kind: "response",
        api: null,
        maxTokens: null,
        status: event.status,
        ticketInHeaders: false,
      });
    });
    pi.on("cache_warming_decision", () => {
      events.push({
        seq: seq++,
        kind: "warming-decision",
        api: null,
        maxTokens: null,
        status: null,
        ticketInHeaders: false,
      });
      return undefined;
    });
  };
  return { events, factory };
}

// ── 主机会话夹具（consult-production 模式：真 activate → 真 AgentSession）──────

interface TrafficHostOptions {
  api: ApiId;
  baseUrl: string;
  /** anthropic stub 回复（默认 text "stub answer"）。 */
  reply?: (request: unknown, index: number) => StubReply;
  cacheTtlMode?: "on" | "off";
  cacheWarming?: "off" | "idle";
  promptCacheShortSeconds?: number;
  usageInputTokens?: number;
  transport?: "auto" | "sse";
  spies?: ((pi: ExtensionAPI) => void)[];
  compactionKeepRecentTokens?: number;
  /** 追加到模型定义的 compat（CT3 需要 supportsStrictTools 触发严格工具优先路径）。 */
  modelCompat?: Record<string, unknown>;
  /** 模型 contextWindow（CT5 的 1M 假 usage 需要 4M 窗口避免触发强制压缩）。 */
  contextWindowTokens?: number;
}

interface TrafficHost {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionId: string;
  agentDir: string;
  recordOn: () => Promise<void>;
  requestRows: () => Promise<RequestRow[]>;
  prompt: (text: string) => Promise<void>;
  shutdown: () => Promise<void>;
}

interface RequestRow {
  id: number;
  session_id: string;
  provider: string | null;
  model: string | null;
  payload: string;
  status: number | null;
  rewrite_status: string | null;
}

function conformanceModel(
  api: ApiId,
  baseUrl: string,
  promptCacheShort?: number,
  compat?: Record<string, unknown>,
  contextWindow?: number,
) {
  const providerByApi: Record<ApiId, string> = {
    "anthropic-messages": "traffic-anthropic-stub",
    "openai-completions": "traffic-openai-stub",
    "openai-responses": "traffic-openai-stub",
    "openai-codex-responses": "traffic-codex-stub",
  };
  return {
    id: `traffic-${api}`,
    name: `traffic conformance ${api}`,
    api,
    provider: providerByApi[api],
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: contextWindow ?? 200_000,
    maxTokens: 1024,
    ...(promptCacheShort !== undefined ? { promptCache: { short: promptCacheShort } } : {}),
    ...(compat !== undefined ? { compat } : {}),
  };
}

type ConformanceModel = ReturnType<typeof conformanceModel>;

/** codex adapter 要求 JWT 形 apiKey（extractAccountId）；合成一个最小 JWT。 */
function codexApiKey(): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-conformance" } })}.conformance`;
}

async function createTrafficHost(options: TrafficHostOptions): Promise<TrafficHost> {
  const cwd = mkdtempSync(join(tmpdir(), "traffic-conformance-"));
  scratchDirs.push(cwd);
  const home = join(cwd, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  initTheme("dark", false);
  const selectedModel = conformanceModel(
    options.api,
    options.baseUrl,
    options.promptCacheShortSeconds,
    options.modelCompat,
    options.contextWindowTokens,
  );
  const apiKey =
    options.api === "openai-codex-responses"
      ? codexApiKey()
      : options.api === "anthropic-messages"
        ? "traffic-stub-key"
        : "sk-traffic-stub";
  writeFileSync(
    join(agentDir, "pi-subagent.json"),
    JSON.stringify({
      rememberAgents: true,
      fleetWidget: false,
      webSearch: { enabled: false },
      todo: { enabled: false },
      memory: { enabled: false },
      date: { enabled: false },
      hud: { enabled: false },
      feishuNotify: { enabled: false },
      askUser: { enabled: false },
      sessionNav: { enabled: false },
      title: { enabled: false },
      topicSwitch: { enabled: false },
      quota: { enabled: false },
      load: { enabled: false },
      workflow: { enabled: false },
      fabric: { enabled: false },
      bashJobs: { autoBackgroundS: 0 },
      compact: { childSessions: false, hintPercent: 0, dynamicThreshold: { mode: "off" } },
      cacheTtl: { mode: options.cacheTtlMode ?? "off", keepalive: false, childKeepalive: false },
      consult: { enabled: false },
      traffic: { enabled: true, childSessions: true, web: { host: "127.0.0.1", port: 4177 } },
    }),
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [],
      packages: [],
      compaction: { enabled: true, keepRecentTokens: options.compactionKeepRecentTokens ?? 0 },
      retry: { enabled: false },
      cacheWarming: options.cacheWarming ?? "off",
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
    }),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [selectedModel.provider]: {
          baseUrl: selectedModel.baseUrl,
          api: selectedModel.api,
          apiKey,
          models: [selectedModel],
        },
      },
    }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [TOOLKIT_ENTRY],
    extensionFactories: options.spies ?? [],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  // 不传 modelRuntime：让 sdk 用 agentDir 下的 models.json 建真 ModelRuntime ——
  // applyAuth → transformHeaders（→ before_provider_headers 钩子）在真实路径上发生。
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: selectedModel as never,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    tools: ["read"],
  } as never);
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
  expect(errors).toEqual([]);

  const runner = session.extensionRunner!;
  const recordOn = async (): Promise<void> => {
    const command = runner.getCommand("record");
    if (!command) throw new Error("traffic activate did not register /record");
    await command.handler("on", runner.createCommandContext() as never);
  };
  const requestRows = async (): Promise<RequestRow[]> => {
    const engine = peekEngine();
    if (!engine) throw new Error("no traffic engine after /record on");
    await engine.dbPort.whenIdle();
    const db = new DatabaseSync(engine.dbPath, { readOnly: true });
    try {
      return db
        .prepare("SELECT id, session_id, provider, model, payload, status, rewrite_status FROM requests ORDER BY id")
        .all() as unknown as RequestRow[];
    } finally {
      db.close();
    }
  };
  let shut = false;
  const shutdown = async (): Promise<void> => {
    if (shut) return;
    shut = true;
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  };
  hosts.push(shutdown);
  return {
    session,
    sessionId: session.sessionId,
    agentDir,
    recordOn,
    requestRows,
    prompt: async (text: string) => {
      await session.prompt(text);
    },
    shutdown,
  };
}

afterEach(async () => {
  // 探针先卸（让 engine 关闭时能认领还原 globalThis.fetch），再关会话/engine。
  for (const uninstall of probes.splice(0)) uninstall();
  for (const shutdown of hosts.splice(0)) await shutdown();
  for (const stub of stubs.splice(0)) await stub.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const engine = peekEngine();
  if (engine) await engine.close("test-teardown");
  resetTrafficGlobalForTest();
  resetTrafficClaimForTest();
  resetTrafficSessionSlotsForTest();
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[KEEPALIVE_PORT_KEY];
  delete (globalThis as Record<symbol, unknown>)[REWRITE_MARKS_KEY];
  seq = 0;
  vi.unstubAllEnvs();
});

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe("traffic conformance — real pi AgentSession + local stubs (plan §8.3)", () => {
  it("CT1: per-request hook order is headers → payload → fetch → response with stable shapes (anthropic-messages)", async () => {
    const stub = await AnthropicStub.start();
    stubs.push(stub);
    const spy = hookSpy();
    const host = await createTrafficHost({
      api: "anthropic-messages",
      baseUrl: `${stub.baseUrl}/v1`,
      spies: [spy.factory],
    });
    await host.recordOn();
    const fetches = installFetchProbe();
    await host.prompt("order probe");
    expect(stub.requests).toHaveLength(1);
    const headers = spy.events.filter((event) => event.kind === "headers");
    const payloads = spy.events.filter((event) => event.kind === "payload");
    const responses = spy.events.filter((event) => event.kind === "response");
    expect(headers).toHaveLength(1);
    expect(payloads).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(fetches).toHaveLength(1);
    // 全局单调序：headers < payload < fetch < response。
    expect(headers[0]!.seq).toBeLessThan(payloads[0]!.seq);
    expect(payloads[0]!.seq).toBeLessThan(fetches[0]!.seq);
    expect(fetches[0]!.seq).toBeLessThan(responses[0]!.seq);
    expect(responses[0]!.status).toBe(200);
    // 形状：payload 事件携带完整请求体；fetch 是 POST 到 stub 的 JSON 请求。
    const payloadBody = stub.requests[0]!.json;
    expect(payloadBody.model).toBe("traffic-anthropic-messages");
    expect(Array.isArray(payloadBody.messages)).toBe(true);
    expect(fetches[0]!.method).toBe("POST");
    expect(fetches[0]!.url).toContain("127.0.0.1");
  }, 90_000);

  it("CT2: the ticket header reaches globalThis.fetch through every whitelisted SDK and the provider never receives it", async () => {
    for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
      const stub = api === "anthropic-messages" ? await AnthropicStub.start() : await OpenAIStub.start();
      stubs.push(stub);
      const host = await createTrafficHost({ api, baseUrl: `${stub.baseUrl}/v1` });
      await host.recordOn();
      const fetches = installFetchProbe();
      await host.prompt(`ticket probe ${api}`);
      expect(stub.requests.length, api).toBeGreaterThanOrEqual(1);
      // (a) SDK 把票据头带到了 globalThis.fetch（探针在拦截层之上）。
      expect(fetches.length, api).toBeGreaterThanOrEqual(1);
      for (const call of fetches) {
        expect(call.ticket, `${api} fetch url ${call.url}`).toMatch(/^[0-9a-f]{32}$/);
      }
      // (b) traffic 拦截层已剥离 —— provider 侧从未收到票据头。
      for (const request of stub.requests) {
        expect(request.headers[TICKET_HEADER], `${api} stub saw ticket`).toBeUndefined();
      }
      // (c) 该请求被票据精确绑定（非 unattributed）并落库。
      const rows = await host.requestRows();
      expect(rows.length, api).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(row.rewrite_status, api).toBeNull();
      expect(rows[0]!.session_id, api).toBe(host.sessionId);
      await host.shutdown();
      // 卸载两层，下一 API 干净开始。
      for (const uninstall of probes.splice(0)) uninstall();
    }
  }, 240_000);

  it("CT3: only the 400 strict-tools fallback re-triggers onPayload; no onPayload after 2xx response headers; non-2xx never reaches after_provider_response", async () => {
    const stub = await AnthropicStub.start({
      respond: (request, index) =>
        index === 0
          ? {
              kind: "error",
              status: 400,
              type: "invalid_request_error",
              message: "Too many strict tools (50); limit is 16 for this API",
            }
          : undefined,
      reply: (_request, index): StubReply => ({ kind: "text", text: `fallback-ok-${index}` }),
    });
    stubs.push(stub);
    const spy = hookSpy();
    const host = await createTrafficHost({
      api: "anthropic-messages",
      baseUrl: `${stub.baseUrl}/v1`,
      spies: [spy.factory],
      // 未声明 supportsStrictTools 的模型不会走严格工具优先路径（pi-ai compat 默认 false）。
      modelCompat: { supportsStrictTools: true },
    });
    await host.recordOn();
    installFetchProbe();
    await host.prompt("strict tools probe");
    // 首发被 400 拒绝，strict 回退重发 ⇒ stub 收到两个 POST。
    expect(stub.requests).toHaveLength(2);
    const first = JSON.stringify(stub.requests[0]!.json);
    const second = JSON.stringify(stub.requests[1]!.json);
    expect(first).toContain('"strict":true');
    expect(second).not.toContain('"strict":true');
    expect(second).not.toBe(first); // 回退正文确实不同（strict 已去除）
    const headers = spy.events.filter((event) => event.kind === "headers");
    const payloads = spy.events.filter((event) => event.kind === "payload");
    const responses = spy.events.filter((event) => event.kind === "response");
    // 同一请求：headers 一次、payload 两次（仅 strict 回退）、fetch 两次。
    expect(headers).toHaveLength(1);
    expect(payloads).toHaveLength(2);
    // 2xx 响应头之后不再有 onPayload：turn 结束后计数不再增长。
    const payloadCountAfterTurn = payloads.length;
    await new Promise((resolve) => setImmediate(resolve));
    expect(spy.events.filter((event) => event.kind === "payload")).toHaveLength(payloadCountAfterTurn);
    // 400 未调用 after_provider_response（只有 2xx 那次）。
    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe(200);
    // 落库：两个 generation 各一行（400 与 200），都归属本会话。
    const rows = await host.requestRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual([400, 200]);
    for (const row of rows) {
      expect(row.session_id).toBe(host.sessionId);
      expect(row.rewrite_status).toBeNull();
    }
  }, 90_000);

  it("CT4: traffic records the payload as rewritten by cache-ttl mode=on (registration order: traffic after cache-ttl)", async () => {
    const stub = await AnthropicStub.start();
    stubs.push(stub);
    const host = await createTrafficHost({
      api: "anthropic-messages",
      baseUrl: `${stub.baseUrl}/v1`,
      cacheTtlMode: "on",
    });
    await host.recordOn();
    installFetchProbe();
    await host.prompt("cache ttl probe");
    // 线上字节带 1h TTL（cache-ttl 改写真的生效了）。
    expect(stub.requests[0]!.body).toContain('"ttl":"1h"');
    // traffic 录到的是改写后的 payload（不是 cache-ttl 改写前的）。
    const rows = await host.requestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toContain('"ttl":"1h"');
    expect(rows[0]!.rewrite_status).toBeNull();
  }, 90_000);

  it("CT5: the pi cache warmer request triggers both before_provider_headers and before_provider_request (retirement rule ② premise)", async () => {
    const stub = await AnthropicStub.start({
      reply: (_request, index): StubReply => ({
        kind: "text",
        text: `warm-${index}`,
        // 1M input tokens + 默认价表（cacheRead 0.1 / cacheWrite 1.25 $/MTok）⇒
        // idle 相似度 0.15 下期望收益 0.0725 ≥ 0.05（warmer 决策 warm）。
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    });
    stubs.push(stub);
    const spy = hookSpy();
    // promptCache short=11s ⇒ warmer 延迟 max(1, min(9.9s, 1s)) = 1s；idle 模式在 turn
    // 结束后继续暖；usage 1M + 默认价表 ⇒ 期望收益 0.0725 ≥ $0.05（决策 warm）。
    const host = await createTrafficHost({
      api: "anthropic-messages",
      baseUrl: `${stub.baseUrl}/v1`,
      cacheWarming: "idle",
      promptCacheShortSeconds: 11,
      // 4M 窗口：1M 假 usage 不得越过强制压缩线（否则 compaction 请求混入计数）。
      contextWindowTokens: 4_000_000,
      spies: [spy.factory],
    });
    await host.recordOn();
    installFetchProbe();
    await host.prompt("warm me");
    // warm 请求最迟在首个请求 1s 后（promptCache short=11s ⇒ 延迟 1000ms）；TTL 短意味着
    // warmer 会周期性重发，后续断言全部用「≥1 + 配对」而非精确计数。
    await stub.waitForRequests(2, 8_000);
    const warmRequest = stub.requests.find((request) => request.json.max_tokens === 1);
    expect(warmRequest).toBeDefined();
    // warmer 请求触发两个钩子：payload 事件里 max_tokens===1 的那些 + 每请求恰一个 headers。
    const warmPayloads = spy.events.filter((event) => event.kind === "payload" && event.maxTokens === 1);
    expect(warmPayloads.length).toBeGreaterThanOrEqual(1);
    const allPayloads = spy.events.filter((event) => event.kind === "payload");
    const headers = spy.events.filter((event) => event.kind === "headers");
    // 前提（§5.3 退役规则 ②）：每个请求（agent loop 与 warmer 一致）都是 headers+payload 成对。
    expect(headers.length).toBe(allPayloads.length);
    expect(headers.length).toBeGreaterThanOrEqual(2);
    const decisions = spy.events.filter((event) => event.kind === "warming-decision");
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    // warmer 的 headers 事件先于其 payload 事件（复用会话 requestOptions 的两个钩子）。
    const warmPayloadSeq = warmPayloads[0]!.seq;
    const pairedHeader = headers.filter((event) => event.seq < warmPayloadSeq).at(-1)!;
    expect(pairedHeader.seq).toBeGreaterThan(allPayloads[0]!.seq);
    // 落库：turn + ≥1 条 warm，均归属本会话。
    const rows = await host.requestRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.session_id).toBe(host.sessionId);
    expect(rows.some((row) => row.payload.includes('"max_tokens":1'))).toBe(true);
  }, 90_000);

  it("CT6: compaction triggers before_provider_headers only (its requestOptions carry no onPayload)", async () => {
    const stub = await AnthropicStub.start();
    stubs.push(stub);
    const spy = hookSpy();
    const host = await createTrafficHost({
      api: "anthropic-messages",
      baseUrl: `${stub.baseUrl}/v1`,
      spies: [spy.factory],
      compactionKeepRecentTokens: 0,
    });
    await host.recordOn();
    await host.prompt("first turn for compaction");
    await host.prompt("second turn for compaction");
    expect(stub.requests).toHaveLength(2);
    await host.session.compact();
    // compaction 到达 stub ⇒ 第 3/4 个 POST（keepRecentTokens=0 把切点落在 turn 内时，
    // 除主 summarization 外还有一次 turn-prefix summarization —— 两者都是 compaction 路径）。
    expect(stub.requests).toHaveLength(4);
    expect(JSON.stringify(stub.requests[2]!.json)).toContain("conversation to summarize");
    expect(JSON.stringify(stub.requests[3]!.json)).toContain("earlier context from an ongoing conversation");
    const headers = spy.events.filter((event) => event.kind === "headers");
    const payloads = spy.events.filter((event) => event.kind === "payload");
    // 4 个请求都触发 headers；只有两个 agent turn 触发 payload。
    expect(headers).toHaveLength(4);
    expect(payloads).toHaveLength(2);
    // compaction 的 requestOptions 连 onResponse 也不带 ⇒ 响应钩子只有两个 turn 的。
    const responses = spy.events.filter((event) => event.kind === "response");
    expect(responses).toHaveLength(2);
    // 第 3 个请求（summarization）的 headers 事件在最后一个 payload 之后 ⇒ 没有 payload 钩子。
    const lastHeader = headers.at(-1)!;
    expect(lastHeader.seq).toBeGreaterThan(payloads.at(-1)!.seq);
    // 落库仍是两行（compaction 请求不产生 payload 行）。
    const rows = await host.requestRows();
    expect(rows).toHaveLength(2);
  }, 90_000);

  it("CT7: a child session (second in-process AgentSession, the production child assembly path) is recorded under its own session id", async () => {
    const stub = await AnthropicStub.start();
    stubs.push(stub);
    // 主会话：真 activate 认领 HOST_KEY ⇒ host 装配。
    const host = await createTrafficHost({ api: "anthropic-messages", baseUrl: `${stub.baseUrl}/v1` });
    await host.recordOn();
    const fetches = installFetchProbe();
    await host.prompt("host turn");
    // 子会话：同进程第二个 AgentSession（生产子会话由 PiSessionDriver 以同一
    // createAgentSession + 同一 settings 在本进程创建；第二次 activate 走 child 分支）。
    const cwd = mkdtempSync(join(tmpdir(), "traffic-conformance-child-"));
    scratchDirs.push(cwd);
    const agentDir = host.agentDir;
    vi.stubEnv("HOME", join(agentDir, "..", ".."));
    const selectedModel = conformanceModel("anthropic-messages", `${stub.baseUrl}/v1`);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [TOOLKIT_ENTRY],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const childManager = SessionManager.create(cwd, join(cwd, "child-sessions"));
    const { session: childSession } = await createAgentSession({
      cwd,
      agentDir,
      model: selectedModel as never,
      settingsManager,
      resourceLoader,
      sessionManager: childManager,
      tools: ["read"],
    } as never);
    hosts.push(async () => {
      await childSession.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      childSession.dispose();
    });
    await childSession.bindExtensions({ mode: "print", onError: () => undefined });
    const childSessionId = childSession.sessionId;
    expect(childSessionId).not.toBe(host.sessionId);
    await childSession.prompt("child turn");
    expect(stub.requests).toHaveLength(2);
    // 子会话请求同样铸票据（child 钩子）且 stub 从未收到票据。
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    expect(fetches[1]!.ticket).toMatch(/^[0-9a-f]{32}$/);
    for (const request of stub.requests) expect(request.headers[TICKET_HEADER]).toBeUndefined();
    // 两条请求行各归各的会话 id。
    const rows = await host.requestRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.session_id).toBe(host.sessionId);
    expect(rows[1]!.session_id).toBe(childSessionId);
  }, 180_000);

  it("CT8 (codex SSE): with transport=sse a ticket-style header injected by the headers hook reaches globalThis.fetch and the traffic tap strips it before the stub", async () => {
    const stub = await OpenAIStub.start();
    stubs.push(stub);
    const host = await createTrafficHost({
      api: "openai-codex-responses",
      baseUrl: `${stub.baseUrl}/v1`,
      transport: "sse",
      // codex 不在票据白名单（CT9 证明 WS 握手不可剥离）⇒ traffic 不会为它铸票据；
      // 本用例用观察钩子注入同形票据头，钉住「若入白名单，SSE 路径可达且可剥离」。
      spies: [ticketInjectingSpy("6edeadbeef6edeadbeef6edeadbeef6e")],
    });
    await host.recordOn();
    const fetches = installFetchProbe();
    await host.prompt("codex sse probe");
    expect(stub.requests.length).toBeGreaterThanOrEqual(1);
    expect(stub.wsHandshakes).toHaveLength(0); // transport=sse ⇒ 不尝试 WS
    const codex = fetches.filter((call) => call.url.includes("/codex/responses"));
    expect(codex.length).toBeGreaterThanOrEqual(1);
    for (const call of codex) expect(call.ticket).toBe("6edeadbeef6edeadbeef6edeadbeef6e");
    for (const request of stub.requests) expect(request.headers[TICKET_HEADER]).toBeUndefined();
  }, 90_000);

  it("CT9 (codex default transport): the WebSocket handshake carries the ticket header and never passes through globalThis.fetch — cannot be stripped", async () => {
    const stub = await OpenAIStub.start();
    stubs.push(stub);
    const host = await createTrafficHost({
      api: "openai-codex-responses",
      baseUrl: `${stub.baseUrl}/v1`,
      // 不传 transport ⇒ 默认 auto：先 WS，失败回退 SSE。
      spies: [ticketInjectingSpy("feedfacefeedfacefeedfacefeedface99")],
    });
    await host.recordOn();
    const fetches = installFetchProbe();
    await host.prompt("codex ws probe");
    await stub.waitForHandshakes(1, 8_000);
    const handshake = stub.wsHandshakes[0]!;
    expect(handshake.url).toContain("/codex/responses");
    // 关键事实：WS 握手头里**未剥离**的票据（Node 原生 WebSocket 支持 headers 选项，
    // 握手不经 globalThis.fetch ⇒ traffic 拦截层看不到、剥不掉）。
    expect(String(handshake.headers[TICKET_HEADER])).toBe("feedfacefeedfacefeedfacefeedface99");
    // WS 失败后回退 SSE：fetch 层那条被拦截层剥离。
    const codexFetch = fetches.filter((call) => call.url.includes("/codex/responses"));
    expect(codexFetch.length).toBeGreaterThanOrEqual(1);
    for (const call of codexFetch) expect(call.ticket).toBe("feedfacefeedfacefeedfacefeedface99");
    for (const request of stub.requests) expect(request.headers[TICKET_HEADER]).toBeUndefined();
  }, 90_000);
});
