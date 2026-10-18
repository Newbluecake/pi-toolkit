/**
 * WP0a gate of `docs/dev/cache-ttl-keepalive/capture-pairing-plan.md` (r7 §5/§6): pins the pi
 * provider-pipeline facts the keepalive payload replay relies on, on the REAL chain —
 * `createAgentSession` + `ModelRuntime.create` (temp models.json → local Anthropic stub) +
 * the real pi-ai anthropic-messages provider + the real Anthropic SDK. No fake runtime.
 *
 *  F1  before_provider_headers (H) fires before before_provider_request (P) inside one call;
 *      compaction / branch-summary calls send H-only (no P).
 *  F2  the Anthropic strict-tools fallback is H, P, P′ with exactly 2 server POSTs.
 *  F3  a replay through `ctx.modelRegistry.streamSimple` (onPayload returns the captured payload
 *      once, maxRetries:0) puts the SAME wire on the socket as the real request (body + headers,
 *      except the informational x-stainless-timeout) and fires ZERO extension hooks.
 *  F4  the Anthropic SDK's non-unref'd fetch timer keeps a process alive while the fetch never
 *      settles; a fetch that settles lets it exit early (child node process, short timeoutMs).
 *
 * Re-run (`npm run test:conformance`) before any pi bump. Everything is local: no network, HOME and
 * the agent dir are temp, timers are unref'd, every wait is bounded.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AnthropicStub, type StubDirective, type StubReply, type StubRequest } from "./fixtures/anthropic-stub.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const STRICT_400 = "Too many strict tools (stub-forced)";

const stubs: AnthropicStub[] = [];
const sessions: AgentSession[] = [];
const scratch: string[] = [];

beforeEach(() => {
  // Isolate every home-relative lookup; the agent dir is passed explicitly as well.
  const home = mkdtempSync(join(tmpdir(), "keepalive-facts-home-"));
  scratch.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi-agent"));
  vi.stubEnv("PI_CACHE_RETENTION", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const stub of stubs.splice(0)) await stub.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** One ordered log shared by the extension hooks and the stub's POST arrivals. */
type Mark = "H" | "P" | "POST" | "RESPONSE" | "STREAM_EVENT";

interface Env {
  session: AgentSession;
  stub: AnthropicStub;
  marks: Mark[];
  /** every payload handed to before_provider_request, deep-cloned at the moment of the hook */
  payloads: Record<string, unknown>[];
  /** header objects handed to before_provider_headers, snapshotted at the moment of the hook */
  headerSnapshots: Record<string, string>[];
  ctx: () => ExtensionContext;
  runtime: ModelRuntime;
  model: ReturnType<typeof stubModel>;
  count: (mark: Mark) => number;
}

function stubModel(baseUrl: string, opts: { reasoning?: boolean; strictTools?: boolean }) {
  return {
    id: "claude-facts",
    name: "Claude facts stub",
    api: "anthropic-messages" as const,
    provider: "anthropic-stub",
    baseUrl,
    reasoning: opts.reasoning === true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 4096,
    // sendSessionAffinityHeaders makes the request's sessionId observable on the wire (x-session-affinity,
    // api-key/header-owned auth path only; the OAuth identity path never adds it).
    compat: { sendSessionAffinityHeaders: true, ...(opts.strictTools ? { supportsStrictTools: true } : {}) },
  };
}

async function startStub(
  marks: Mark[],
  respond?: (request: StubRequest, index: number) => StubDirective | undefined,
  reply?: (request: StubRequest, index: number) => StubReply,
): Promise<AnthropicStub> {
  const stub = await AnthropicStub.start({
    respond: (request, index) => {
      marks.push("POST");
      return respond?.(request, index);
    },
    reply: reply ?? ((_request, index) => ({ kind: "text", text: `answer-${index}` })),
  });
  stubs.push(stub);
  return stub;
}

async function createEnv(
  opts: {
    apiKey?: string;
    reasoning?: boolean;
    strictTools?: boolean;
    tools?: string[];
    respond?: (request: StubRequest, index: number) => StubDirective | undefined;
    compactionKeepRecentTokens?: number;
  } = {},
): Promise<Env> {
  const marks: Mark[] = [];
  const stub = await startStub(marks, opts.respond);
  const root = mkdtempSync(join(tmpdir(), "keepalive-facts-"));
  scratch.push(root);
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const model = stubModel(stub.baseUrl, opts);
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "anthropic-stub": {
          baseUrl: model.baseUrl,
          api: "anthropic-messages",
          apiKey: opts.apiKey ?? "stub-api-key",
          models: [model],
        },
      },
    }),
  );
  if (opts.compactionKeepRecentTokens !== undefined)
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: opts.compactionKeepRecentTokens } }),
    );

  const payloads: Record<string, unknown>[] = [];
  const headerSnapshots: Record<string, string>[] = [];
  let lastCtx: ExtensionContext | undefined;
  const spy = (pi: ExtensionAPI) => {
    pi.on("before_provider_headers", (event, ctx) => {
      lastCtx = ctx;
      marks.push("H");
      headerSnapshots.push({ ...(event.headers as Record<string, string>) });
    });
    pi.on("before_provider_request", (event) => {
      marks.push("P");
      payloads.push(structuredClone(event.payload) as Record<string, unknown>);
      return undefined;
    });
    pi.on("after_provider_response", () => {
      marks.push("RESPONSE");
    });
    pi.on("provider_stream_event", () => {
      marks.push("STREAM_EVENT");
    });
  };

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [spy] });
  await resourceLoader.reload();
  // The REAL runtime: models.json → provider composer → provider chain (incl. the outer await).
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const resolved = runtime.getModel(model.provider, model.id);
  expect(resolved, "model resolved from models.json by the real runtime").toBeDefined();
  const created = await createAgentSession({
    cwd,
    agentDir,
    model: resolved as never,
    modelRuntime: runtime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: opts.tools ?? ["read"],
  } as never);
  sessions.push(created.session);
  if (opts.reasoning) created.session.setThinkingLevel("medium");
  return {
    session: created.session,
    stub,
    marks,
    payloads,
    headerSnapshots,
    runtime,
    model,
    ctx: () => {
      if (!lastCtx) throw new Error("no extension context captured yet (no provider call has happened)");
      return lastCtx;
    },
    count: (mark) => marks.filter((m) => m === mark).length,
  };
}

/** Collapse RESPONSE/STREAM_EVENT noise so the assertions read as the request-side protocol. */
function requestSide(marks: Mark[]): Mark[] {
  return marks.filter((m) => m === "H" || m === "P" || m === "POST");
}

function headerMap(request: StubRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers))
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : (value ?? "");
  return out;
}

// ---------------------------------------------------------------------------------------------
describe("keepalive pipeline facts — real ModelRuntime chain", () => {
  it("F1a: before_provider_headers (H) fires before before_provider_request (P) within one call", async () => {
    const env = await createEnv();
    await env.session.prompt("first request");
    await env.session.prompt("second request");
    expect(env.stub.requests).toHaveLength(2);
    // Per call: H, P, then the POST. Never P-before-H (the premise of the pre-fix matcher).
    expect(requestSide(env.marks)).toEqual(["H", "P", "POST", "H", "P", "POST"]);
    expect(env.payloads).toHaveLength(2);
    // The payload P saw IS the body that reached the wire (same object content, same key order/bytes;
    // betas, if any, only move to a header after the hook — this stub model has none).
    expect(env.payloads).toHaveLength(2);
    for (const [i, payload] of env.payloads.entries()) {
      expect(env.stub.requests[i]!.json).toEqual(payload);
      expect(env.stub.requests[i]!.body).toBe(JSON.stringify(payload));
    }
    expect(JSON.stringify(env.payloads[0])).toContain("first request");
    expect(JSON.stringify(env.payloads[1])).toContain("second request");
    // H handlers got a (mutable) header object per call. The api key is NOT in it (the SDK adds
    // x-api-key after the hook), so the wire is the only place auth is visible.
    expect(env.headerSnapshots).toHaveLength(2);
    for (const [i, snapshot] of env.headerSnapshots.entries()) {
      expect(Object.keys(snapshot).map((k) => k.toLowerCase())).not.toContain("x-api-key");
      expect(JSON.stringify(snapshot)).not.toContain("stub-api-key");
      expect(env.stub.requests[i]!.headers["x-api-key"]).toBe("stub-api-key");
    }
  });

  it("F1b: compaction and branch-summary calls send H-only (no P)", async () => {
    const env = await createEnv({ compactionKeepRecentTokens: 1 });
    await env.session.prompt("alpha request one");
    await env.session.prompt("beta request two");
    await env.session.prompt("gamma request three");
    expect(requestSide(env.marks)).toEqual(["H", "P", "POST", "H", "P", "POST", "H", "P", "POST"]);

    // --- compaction ---
    const beforeCompaction = env.marks.length;
    await env.session.compact();
    const compaction = requestSide(env.marks.slice(beforeCompaction));
    expect(compaction.length).toBeGreaterThan(0);
    expect(compaction).toEqual(compaction.flatMap(() => ["H", "POST"] as Mark[]).slice(0, compaction.length));
    expect(compaction).not.toContain("P");
    expect(env.payloads).toHaveLength(3); // no new P payload
    // Structural (not prompt-wording) proof that it was the summarization request: pi persisted a
    // compaction entry, and the request is toolless where every agent-loop request carried tools.
    expect(env.session.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
    expect(env.stub.requests[0]!.json.tools, "agent-loop requests carry tools").toBeDefined();
    for (const request of env.stub.requests.slice(3)) expect(request.json.tools).toBeUndefined();

    // --- branch summary (tree navigation with summarize) ---
    await env.session.prompt("delta request four");
    const entries = env.session.sessionManager.getEntries();
    const firstUser = entries.find((e) => e.type === "message" && e.message.role === "user");
    expect(firstUser).toBeDefined();
    const beforeBranch = env.marks.length;
    const postsBeforeBranch = env.stub.requests.length;
    const payloadsBeforeBranch = env.payloads.length;
    await env.session.navigateTree(firstUser!.id, { summarize: true });
    const branch = requestSide(env.marks.slice(beforeBranch));
    expect(env.stub.requests.length).toBeGreaterThan(postsBeforeBranch);
    expect(branch).toEqual(
      Array.from({ length: env.stub.requests.length - postsBeforeBranch }, () => ["H", "POST"]).flat(),
    );
    expect(env.payloads).toHaveLength(payloadsBeforeBranch);
    expect(env.session.sessionManager.getEntries().some((e) => e.type === "branch_summary")).toBe(true);
    for (const request of env.stub.requests.slice(postsBeforeBranch)) expect(request.json.tools).toBeUndefined();
  });

  it("F2: Anthropic strict-tools fallback is H, P, P′ with exactly 2 server POSTs", async () => {
    const env = await createEnv({
      strictTools: true,
      tools: ["bash"],
      respond: (_request, index) =>
        index === 0 ? { kind: "error", status: 400, type: "invalid_request_error", message: STRICT_400 } : undefined,
    });
    await env.session.prompt("strict fallback please");
    expect(env.stub.requests).toHaveLength(2);
    expect(requestSide(env.marks)).toEqual(["H", "P", "POST", "P", "POST"]);
    expect(env.payloads).toHaveLength(2);
    const strictOf = (body: Record<string, unknown>) =>
      ((body.tools ?? []) as Array<{ strict?: boolean }>).some((tool) => tool.strict === true);
    expect(strictOf(env.payloads[0]!), "P carried preferred-strict tools").toBe(true);
    expect(strictOf(env.payloads[1]!), "P′ is the downgraded rebuild").toBe(false);
    expect(env.stub.requests[0]!.json).toEqual(env.payloads[0]);
    expect(env.stub.requests[1]!.json).toEqual(env.payloads[1]);
    // The downgrade is the ONLY thing that changed; H was not re-fired for the second POST.
    expect(env.count("H")).toBe(1);
  });

  describe("F3: replay through ctx.modelRegistry.streamSimple reproduces the real wire with 0 hooks", () => {
    const cases: Array<{ name: string; env: Parameters<typeof createEnv>[0]; expectBeta: boolean }> = [
      { name: "api-key", env: {}, expectBeta: false },
      { name: "OAuth", env: { apiKey: "sk-ant-oat01-stub-oauth-token" }, expectBeta: true },
      { name: "thinking", env: { reasoning: true }, expectBeta: true },
    ];
    for (const c of cases) {
      it(`F3 ${c.name}`, async () => {
        const env = await createEnv(c.env);
        await env.session.prompt("real request for replay");
        expect(env.stub.requests).toHaveLength(1);
        const captured = structuredClone(env.payloads.at(-1)!);
        const real = env.stub.requests[0]!;
        const hooksBefore = {
          H: env.count("H"),
          P: env.count("P"),
          R: env.count("RESPONSE"),
          S: env.count("STREAM_EVENT"),
        };
        expect(hooksBefore.R, "spy sanity: after_provider_response fires for real requests").toBeGreaterThan(0);
        expect(hooksBefore.S, "spy sanity: provider_stream_event fires for real requests").toBeGreaterThan(0);

        const registry = env.ctx().modelRegistry;
        expect(typeof registry.streamSimple).toBe("function");
        const model = env.ctx().model!;
        const controller = new AbortController();
        let onPayloadCalls = 0;
        let fetchCalls = 0;
        let transformCalls = 0;
        const streamEvents: string[] = [];
        const stream = registry.streamSimple(
          model,
          { messages: [{ role: "user", content: "keepalive", timestamp: Date.now() }] },
          {
            sessionId: env.session.sessionManager.getSessionId(),
            maxRetries: 0,
            signal: controller.signal,
            timeoutMs: 30_000,
            onPayload: () => {
              onPayloadCalls += 1;
              if (onPayloadCalls > 1) throw new Error("second onPayload call (would be a second HTTP request)");
              return structuredClone(captured);
            },
            fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              fetchCalls += 1;
              return fetch(input, init);
            },
            onProviderStreamEvent: (event: { type?: string }) => {
              streamEvents.push(String(event.type));
            },
            transformHeaders: (headers: Record<string, string>) => {
              transformCalls += 1;
              return headers;
            },
          } as never,
        );
        const result = await Promise.race([
          stream.result(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("replay timed out")), 10_000).unref()),
        ]);
        expect(result.stopReason).toBe("stop");
        expect(onPayloadCalls).toBe(1);
        expect(fetchCalls).toBe(1);
        expect(transformCalls).toBe(1);
        expect(streamEvents).toContain("message_start");

        // ZERO extension hooks fired by the replay.
        expect({
          H: env.count("H"),
          P: env.count("P"),
          R: env.count("RESPONSE"),
          S: env.count("STREAM_EVENT"),
        }).toEqual(hooksBefore);

        // Same wire.
        expect(env.stub.requests).toHaveLength(2);
        const replay = env.stub.requests[1]!;
        expect(replay.method).toBe(real.method);
        expect(replay.url).toBe(real.url);
        expect(replay.body).toBe(real.body); // byte-identical
        const realHeaders = headerMap(real);
        const replayHeaders = headerMap(replay);
        expect(replayHeaders["x-stainless-timeout"], "informational header present on both").toBeDefined();
        expect(realHeaders["x-stainless-timeout"]).toBeDefined();
        delete realHeaders["x-stainless-timeout"];
        delete replayHeaders["x-stainless-timeout"];
        expect(replayHeaders).toEqual(realHeaders);

        // Shape facts the plan leans on.
        if (c.expectBeta) {
          expect(Array.isArray(captured.betas) && captured.betas.length > 0, "P carries betas").toBe(true);
          expect(realHeaders["anthropic-beta"]).toBeDefined();
        } else expect(captured.betas).toBeUndefined();
        expect(real.json.betas, "betas never reach the wire body (SDK moves them to anthropic-beta)").toBeUndefined();
        if (Array.isArray(captured.betas) && captured.betas.length > 0)
          for (const beta of captured.betas as string[]) expect(realHeaders["anthropic-beta"]).toContain(beta);
        const sessionId = env.session.sessionManager.getSessionId();
        if (c.name === "OAuth") expect(realHeaders["x-session-affinity"]).toBeUndefined();
        else {
          // sessionId propagation is observable: the replay carries the agent's id, same as the real request.
          expect(realHeaders["x-session-affinity"]).toBe(sessionId);
          expect(replayHeaders["x-session-affinity"]).toBe(sessionId);
        }
        if (c.name === "api-key") expect(replayHeaders["x-api-key"]).toBe("stub-api-key");
        if (c.name === "OAuth") expect(replayHeaders["authorization"]).toBe("Bearer sk-ant-oat01-stub-oauth-token");
        if (c.name === "thinking") {
          const thinking = real.json.thinking as { type?: string } | undefined;
          expect(thinking?.type, "thinking block present on the wire").toBeDefined();
          expect(replay.json.thinking).toEqual(real.json.thinking);
          expect(replay.json.max_tokens).toBe(real.json.max_tokens);
        }
      });
    }
  });

  describe("F4: the SDK's non-unref'd fetch timeout keeps the process alive (child node process)", () => {
    const TIMEOUT_MS = 3_000;
    const SETTLE_MS = 250;

    function childSource(mode: "never" | "settles", root: string): string {
      return `
        import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
        const runtime = await ModelRuntime.create({ authPath: ${JSON.stringify(join(root, "auth.json"))}, modelsPath: ${JSON.stringify(join(root, "models.json"))} });
        const registry = new ModelRegistry(runtime);
        const model = registry.find("anthropic-stub", "claude-facts");
        if (!model) throw new Error("model missing");
        const fetchImpl = ${
          mode === "never"
            ? "() => new Promise(() => {})"
            : `() => new Promise((_resolve, reject) => { setTimeout(() => reject(new Error("settled-at-deadline")), ${SETTLE_MS}).unref(); })`
        };
        const stream = registry.streamSimple(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, {
          maxRetries: 0, timeoutMs: ${TIMEOUT_MS}, fetch: fetchImpl, onPayload: undefined,
        });
        stream.result().catch(() => {});
        console.log("READY " + Date.now());
      `;
    }

    async function runChild(mode: "never" | "settles"): Promise<{ aliveMs: number; code: number | null }> {
      const root = mkdtempSync(join(tmpdir(), "keepalive-facts-f4-"));
      scratch.push(root);
      writeFileSync(
        join(root, "models.json"),
        JSON.stringify({
          providers: {
            "anthropic-stub": {
              baseUrl: "http://127.0.0.1:1", // never dialled: fetch is replaced
              api: "anthropic-messages",
              apiKey: "stub-api-key",
              models: [stubModel("http://127.0.0.1:1", {})],
            },
          },
        }),
      );
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childSource(mode, root)], {
          cwd: REPO_ROOT,
          env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        let readyAt: number | undefined;
        const guard = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`F4 child (${mode}) did not exit in 30 s; stderr=${err.slice(0, 500)}`));
        }, 30_000);
        guard.unref();
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /READY (\d+)/.exec(out);
          if (match && readyAt === undefined) readyAt = Date.now();
        });
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
        child.on("error", reject);
        child.on("exit", (code) => {
          clearTimeout(guard);
          if (readyAt === undefined)
            return reject(new Error(`F4 child (${mode}) never became ready; stderr=${err.slice(0, 500)}`));
          resolve({ aliveMs: Date.now() - readyAt, code });
        });
      });
    }

    it("a never-settling fetch keeps the process alive until the SDK timer (timeoutMs) fires", async () => {
      const { aliveMs, code } = await runChild("never");
      expect(code).toBe(0);
      // Only the SDK's ref'd setTimeout(timeoutMs) holds the loop open: alive for ~timeoutMs, then exits.
      expect(aliveMs).toBeGreaterThanOrEqual(TIMEOUT_MS * 0.75);
      expect(aliveMs).toBeLessThan(TIMEOUT_MS + 8_000);
    }, 45_000);

    it("a fetch that settles at the deadline lets the process exit immediately (timer cleared)", async () => {
      const { aliveMs, code } = await runChild("settles");
      expect(code).toBe(0);
      // Exits at ≈ SETTLE_MS, long before the SDK timer's TIMEOUT_MS would have.
      expect(aliveMs).toBeLessThan(TIMEOUT_MS / 2);
    }, 45_000);
  });
});
