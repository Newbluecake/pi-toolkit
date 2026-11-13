/** P50 approval tooling only. Catalog inspection never resolves auth. LIVE uses
 * the public pi SDK credential reader and registry request-time auth, not a
 * second HTTP client or a probe-owned auth.json/env-key parser. */
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore, ModelsStore } from "@earendil-works/pi-ai";
// Already pinned by the pi 1.5 SDK in package-lock; standalone dev probe only.
import { Agent, fetch as directFetch } from "undici";
import { readSettingsNoMigrate, loadSettings } from "../../src/config/settings.js";
import type { MemorySettings } from "../../src/memory/settings.js";
import { serializeBlock, parseBlockFile } from "../../src/memory/blocks/format.js";
import {
  revisionBlockFromRaw,
  revisionRelationContextForBlocks,
  revisionCanonicalJson,
} from "../../src/memory/govern/revision.js";
import { revisionTransportContext, type JevClientHandle } from "../../src/memory/jev/client.js";
import { jevConfigOf } from "../../src/memory/jev/config.js";
import { createSegmentedClock } from "../../src/core/clock.js";
import {
  estimatePayload,
  stockClassifyPayload,
  stockRevisionPayload,
  stockRevisionThinkingDisabled,
  STOCK_ESTIMATE_PROFILE,
} from "../../src/memory/jev/p50-estimate.js";
import { createStockEstimateP50Binding } from "../../src/memory/jev/p50-binding.js";
import { registryOf, wireJev } from "../../src/memory/jev/wire.js";
import { wireMemoryScopes } from "../../src/memory/scopes/wire.js";
import { createIncrementalScheduler } from "../../src/memory/govern/incremental.js";
import { readIncrementalCorpus } from "../../src/memory/govern/incremental-corpus.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
import { ProbeDiagnostics, transportErrorClass } from "./p50-closure-diagnostics.js";
import {
  manifestSha256,
  type ClosureManifest,
  type ClosureRunnerContext,
  type ProbeStage,
  type ProbeTransport,
} from "./p50-closure-live-probe.js";

export const SYNTHETIC_BODIES = [
  "Synthetic release policy: publish release artifacts to directory Alpha. Preserve audit logs and verify checksums.",
  "Synthetic release policy: publish release artifacts to directory Beta, not Alpha. Preserve audit logs and verify checksums.",
] as const;
export function syntheticBlocks() {
  return SYNTHETIC_BODIES.map((body, i) => {
    const id = `closure.00${i + 1}`;
    const raw = serializeBlock(
      { kind: "block", authority: "agent", status: "active", created: "2026-11-13", updated: "2026-11-13", version: 1 },
      body,
    );
    const parsed = parseBlockFile(`${id}.md`, raw);
    if ("stray" in parsed || parsed.errors.length) throw Error("SYNTHETIC_DATA");
    return revisionBlockFromRaw(id, Buffer.from(raw), parsed.rev);
  });
}
/** Optional SDK framing is quoted conservatively but not required on the wire.
 * Hash the full semantic template; no prompt/body is included in public output. */
export function payloadTemplateHash(payload: Record<string, unknown>): string {
  const { store: _store, stream_options: _usage, ...semantic } = payload;
  return manifestSha256(revisionCanonicalJson(semantic));
}
export function buildClosureManifest(
  settings: MemorySettings,
  registry: ModelRegistry,
  root: string,
  transport: ProbeTransport = "proxy",
): ClosureManifest {
  const r = settings.jev.classifiers[0],
    g = settings.jev.predict.model.models[0];
  const view = registryOf({ modelRegistry: registry });
  if (!r || !g || !view || !createStockEstimateP50Binding({ registry: view, classifier: r, revisionModel: g }))
    throw Error("ROUTE_UNAVAILABLE");
  const models = [r, r, g, g].map((route, i) => {
    const slash = route.indexOf("/"),
      provider = route.slice(0, slash),
      id = route.slice(slash + 1);
    const m = i < 2 ? registry.getModelOfType("classifier", provider, id) : registry.find(provider, id);
    if (!m) throw Error("ROUTE_UNAVAILABLE");
    const url = new URL(m.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw Error("ROUTE_UNAVAILABLE");
    return { route, model: m, endpoint: `${m.baseUrl.replace(/\/$/, "")}/${i < 2 ? "systemone" : "chat/completions"}` };
  });
  const [a, b] = syntheticBlocks();
  const target = a!.block,
    context = b!.block;
  const outboundBlock = (x: typeof target) => ({
    id: x.id,
    rev: x.rev,
    authority: x.authority,
    topic: x.topic,
    body: x.body,
  });
  const common = { target: outboundBlock(target), context: outboundBlock(context) };
  const payloads = [
    stockClassifyPayload(models[0]!.model.id, revisionRelationContextForBlocks(a!, b!)),
    stockClassifyPayload(models[1]!.model.id, revisionRelationContextForBlocks(b!, a!)),
    stockRevisionPayload(
      models[2]!.model.id,
      revisionTransportContext({ purpose: "generate", instruction: "merge-survivor", ...common }),
      384,
      stockRevisionThinkingDisabled(models[2]!.model),
    ),
    // 1024 input bytes, each requiring maximal JSON escaping at EVERY nested
    // serialization layer. This is an envelope, never a real candidate/request.
    stockRevisionPayload(
      models[3]!.model.id,
      revisionTransportContext({ purpose: "coverage", ...common, candidateBody: "\u0001".repeat(1024) }),
      384,
      stockRevisionThinkingDisabled(models[3]!.model),
    ),
  ];
  const routes = models.map(({ route, model, endpoint }, i) => {
    const inputUsdPerMillion = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
    const outputUsdPerMillion = model.cost.output;
    const estimatedInputTokens = estimatePayload(payloads[i]);
    if (!estimatedInputTokens || ![inputUsdPerMillion, outputUsdPerMillion].every((n) => Number.isFinite(n) && n >= 0))
      throw Error("QUOTE_UNAVAILABLE");
    return {
      stage: (["R1", "R2", "G1", "C1"] as const)[i]!,
      endpoint,
      model: model.id,
      provider: model.provider,
      route,
      api: model.api,
      priceSource: "pi-1.5.0 static SDK catalog + current models.json overrides (no remote refresh)",
      priceSnapshotSha256: manifestSha256(revisionCanonicalJson({ route, api: model.api, endpoint, cost: model.cost })),
      inputUsdPerMillion,
      outputUsdPerMillion,
      estimatedInputTokens,
      outputAllowance: i < 2 ? 128 : 384,
      estimatedListReserveUsd:
        (estimatedInputTokens * inputUsdPerMillion + (i < 2 ? 128 : 384) * outputUsdPerMillion) / 1e6,
      payload: {
        kind: i === 3 ? "candidate-envelope" : "semantic-template",
        utf8Bytes: Buffer.byteLength(JSON.stringify(payloads[i])),
        templateSha256: payloadTemplateHash(payloads[i]!),
        sensitiveBodyIncluded: false,
      },
      ...(i < 3 ? { payloadTemplateSha256: payloadTemplateHash(payloads[i]!) } : {}),
    };
  });
  const plannedReserveUsd = routes.reduce(
    (n, r) => n + (r.estimatedInputTokens * r.inputUsdPerMillion + r.outputAllowance * r.outputUsdPerMillion) / 1e6,
    0,
  );
  const absolute = resolve(root);
  return {
    contract: "p50-stock-estimate-suggest-only-v1",
    transport,
    root: absolute,
    paths: {
      home: join(absolute, "home"),
      cache: join(absolute, "cache"),
      tmp: join(absolute, "tmp"),
      config: join(absolute, "config"),
      agent: join(absolute, "agent"),
      cwd: join(absolute, "project"),
      memory: join(absolute, "memory"),
      ccProjects: join(absolute, "cc-projects"),
    },
    maxAttempts: 4,
    budgetUsd: plannedReserveUsd,
    plannedReserveUsd,
    cEnvelopeEstimatedInputTokens: routes[3]!.estimatedInputTokens,
    routes,
    approval: {
      realSettings: {
        enabled: settings.incremental.enabled,
        auto: settings.incremental.auto,
        jobCostCapUsd: settings.incremental.jobCostCapUsd,
      },
      clientCallSlots: 5,
      httpAttemptLimit: 4,
      proxyConfigured: settings.jev.proxy !== "",
      proxyBypassed: settings.jev.proxy !== "" && transport === "direct-user-approved",
      executionGate:
        settings.jev.proxy && transport !== "direct-user-approved" ? "PROXY_UNAVAILABLE" : "READY_FOR_APPROVAL",
      callPlan: "2R+1G+1C",
      retries: 0,
      fallback: false,
      listTargetUsd: 0.01,
      reservationLimitUsd: 1,
      requestBudgetMs: 30000,
      serverEnforced: false,
      mayExceedLocalReserve: true,
      quoteFormula: "(estimatedInputTokens * inputUsdPerMillion + outputAllowance * outputUsdPerMillion) / 1e6",
      billing: "UNKNOWN",
      provenance: "unknown",
      auto: false,
      settingsModified: false,
      profile: STOCK_ESTIMATE_PROFILE,
      syntheticRawSha256: syntheticBlocks().map((b) => b.rawDigest),
    },
  };
}
export function requireQuote(m: ClosureManifest): void {
  if (!Number.isFinite(m.plannedReserveUsd) || m.plannedReserveUsd <= 0 || m.plannedReserveUsd > 1 || m.budgetUsd > 1)
    throw Error("RESERVATION_LIMIT");
  if (m.plannedReserveUsd > 0.01 || m.plannedReserveUsd > m.budgetUsd) throw Error("LIST_TARGET_EXCEEDED");
}
/** Entirely offline: SDK config/catalog construction only; no availability,
 * getAuth(), credential parsing, refresh(), cache writes or provider calls. */
export async function openProbeCatalog(agentDir: string, live: boolean, credentialReader = readStoredCredential) {
  const credentials: CredentialStore = {
    async read(provider) {
      if (!live) return undefined;
      const credential = credentialReader(provider, join(agentDir, "auth.json"));
      // No refresh/login/credential persistence/network side channel in this probe.
      if (credential?.type === "oauth") throw Error("AUTH_UNAVAILABLE");
      // The public one-off SDK reader deliberately does NOT resolve stored
      // !commands/$templates (AuthStorage itself is not a public export in 1.5).
      // Never transmit such an unresolved reference as a literal credential,
      // and never implement our own environment/key-command resolver here.
      if (
        credential &&
        (credential.type !== "api_key" ||
          (credential.key !== undefined &&
            (typeof credential.key !== "string" || credential.key.startsWith("!") || credential.key.includes("$"))))
      )
        throw Error("AUTH_UNAVAILABLE");
      return credential;
    },
    async list() {
      return [];
    },
    async modify() {
      throw Error("AUTH_UNAVAILABLE");
    },
    async delete() {
      throw Error("AUTH_UNAVAILABLE");
    },
  };
  const modelsStore: ModelsStore = {
    async read() {
      return undefined;
    },
    async write() {
      throw Error("CATALOG_WRITE_FORBIDDEN");
    },
    async delete() {
      throw Error("CATALOG_WRITE_FORBIDDEN");
    },
  };
  try {
    const runtime = await ModelRuntime.create({
      credentials,
      modelsStore,
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    if (registry.getError()) throw Error("ROUTE_UNAVAILABLE");
    return {
      runtime,
      registry,
      settings: readSettingsNoMigrate(
        join(agentDir, existsSync(join(agentDir, "pi-toolkit.json")) ? "pi-toolkit.json" : "pi-subagent.json"),
      ).memory,
    };
  } catch {
    throw Error("ROUTE_UNAVAILABLE");
  }
}
/** Preflight BOTH selected routes before any provider dispatch. No auth result,
 * token, headers, upstream message/cause or credential is returned/logged. SDK
 * alone resolves configured keys and supplies auth to classify/complete later. */
export async function requireProbeAuth(
  runtime: Pick<ModelRuntime, "getAuth">,
  registry: ModelRegistry,
  m: ClosureManifest,
): Promise<void> {
  try {
    for (const r of [m.routes[0]!, m.routes[2]!]) {
      const slash = r.route!.indexOf("/");
      const model =
        r.stage === "R1"
          ? registry.getModelOfType("classifier", r.route!.slice(0, slash), r.model)
          : registry.find(r.route!.slice(0, slash), r.model);
      if (!model) throw Error();
      const result = await runtime.getAuth(model);
      if (
        !result ||
        (!result.auth.apiKey &&
          !Object.values(result.auth.headers ?? {}).some((value) => typeof value === "string" && value.length > 0)) ||
        (result.auth.baseUrl && result.auth.baseUrl.replace(/\/$/, "") !== model.baseUrl.replace(/\/$/, ""))
      )
        throw Error();
    }
  } catch {
    throw Error("AUTH_UNAVAILABLE");
  }
}

/** Only the standalone CLI calls this, after hash/transport/route/auth admission.
 * Stock G/C guards capture global fetch while the host is built; pin its final
 * dispatcher here too, without replacing those guards or the SDK serializers.
 * A fresh plain Agent uses direct Pool/Client connectors, never EnvHttpProxyAgent
 * or the ambient global dispatcher (even if SDK code configured one). The
 * explicit per-request dispatcher wins over caller init and environment proxies.
 * No settings/env writes; restore fetch and destroy sockets even on failure. */
export async function withDirectProbeTransport<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const dispatchers: Agent[] = [];
  globalThis.fetch = async (url, init) => {
    // Only the SHA-checked SDK JSON POST shape is needed here. Pair the Agent
    // with its own undici fetch: Node 22's bundled undici has a different major
    // dispatcher-handler protocol. No unsafe cross-version dispatcher cast.
    if ((typeof url !== "string" && !(url instanceof URL)) || init?.method !== "POST" || typeof init.body !== "string")
      throw Error("PROVIDER_FAILED");
    const dispatcher = new Agent({ connections: 1, allowH2: false, maxOrigins: 1 });
    dispatchers.push(dispatcher);
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    let attempts = 0;
    dispatcher.dispatch = (options, handler) => {
      // fetch itself can replay a 421 even with SDK maxRetries=0. Permit one
      // low-level dispatch per SHA-approved POST, never that hidden replay.
      if (++attempts !== 1) throw Error("PROBE_STOPPED");
      return dispatch({ ...options, idempotent: false }, handler);
    };
    const response = await directFetch(url, {
      method: "POST",
      body: init.body,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.signal ? { signal: init.signal } : {}),
      dispatcher,
      redirect: "error",
    });
    // Bridge the standard streaming body/headers, not nominal SDK/Node types.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.destroy()));
  }
}

/** SDK adapter only; original registry implementations retain request-time auth.
 * Override the EXISTING fetch injection seam, not SDK serializer/provider logic.
 * Every upstream error is collapsed before it reaches client diagnostics. */
export class ProbeRegistry extends ModelRegistry {
  constructor(
    runtime: ModelRuntime,
    private readonly before: ClosureRunnerContext["beforeHttp"],
    private readonly http: typeof fetch = globalThis.fetch,
    private readonly diagnostics?: ProbeDiagnostics,
  ) {
    super(runtime);
  }
  private count = 0;
  private stopped = false;
  private rCalls = 0;
  private gCalls = 0;
  private guarded(fallback: typeof fetch = this.http, callStage: ProbeStage = "R1"): typeof fetch {
    return async (url, init) => {
      if (this.stopped) throw Error("PROBE_STOPPED");
      try {
        const stage = (["R1", "R2", "G1", "C1"] as ProbeStage[])[this.count++];
        if (!stage) throw Error();
        this.before(stage, String(url), JSON.parse(String(init?.body)));
        let response: Response;
        try {
          response = await fallback(url, { ...init, redirect: "error" });
        } catch (error) {
          this.diagnostics?.error(callStage, transportErrorClass(error, init?.signal));
          throw Error("PROVIDER_FAILED");
        }
        this.diagnostics?.status(callStage, response.status);
        if (!response.ok) {
          this.stopped = true;
          throw Error();
        }
        return response;
      } catch {
        this.stopped = true;
        throw Error("PROVIDER_FAILED");
      }
    };
  }
  override async classify(...[model, context, opts]: Parameters<ModelRegistry["classify"]>) {
    const stage = this.rCalls++ === 0 ? "R1" : "R2";
    this.diagnostics?.started(stage);
    try {
      const result = await super.classify(model, context, {
        ...opts,
        maxRetries: 0,
        fetch: this.guarded(opts?.fetch, stage),
      });
      this.diagnostics?.result(stage, result.stopReason !== "stop", result.usage);
      if (result.stopReason !== "stop") return { ...result, errorMessage: "PROVIDER_FAILED" };
      return result;
    } catch {
      this.diagnostics?.result(stage, true);
      throw Error("PROVIDER_FAILED");
    }
  }
  override async complete<T extends Parameters<ModelRegistry["complete"]>[0]["api"]>(
    model: import("@earendil-works/pi-ai").Model<T>,
    context: Parameters<ModelRegistry["complete"]>[1],
    opts?: import("@earendil-works/pi-ai").ModelsApiStreamOptions<T>,
  ) {
    const stage = this.gCalls++ === 0 ? "G1" : "C1";
    this.diagnostics?.started(stage);
    try {
      // For stock G/C, opts.fetch is the binding's final pure guard. It calls
      // captured global fetch. Place observation before that existing guard.
      const result = await super.complete(model, context, {
        ...opts,
        maxRetries: 0,
        fetch: this.guarded(opts?.fetch ?? this.http, stage),
      } as import("@earendil-works/pi-ai").ModelsApiStreamOptions<T>);
      this.diagnostics?.result(stage, result.stopReason === "error" || result.stopReason === "aborted", result.usage);
      if (result.stopReason === "error" || result.stopReason === "aborted")
        return { ...result, errorMessage: "PROVIDER_FAILED" };
      return result;
    } catch {
      this.diagnostics?.result(stage, true);
      throw Error("PROVIDER_FAILED");
    }
  }
}

/** Real wireJev + actual SDK scopes/proof + original scheduler/host/D/C/review.
 * Only isolated synthetic blocks are written; no memory tool/tagging producer,
 * predictor, title, auto-commit or second opportunity is installed. */
export async function runClosureHost(ctx: ClosureRunnerContext, registry: ModelRegistry, source: MemorySettings) {
  const { manifest: m, environment: env, memoryDir } = ctx.isolation;
  // Preserve ONLY path/control variables we replace, never enumerate/read
  // ambient credential values. SDK auth owns any key/environment lookup.
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldCwd = process.cwd();
  const handlers = new Map<string, ((event: unknown, context: ExtensionContext) => unknown)[]>();
  let shutdown: (() => Promise<void>) | undefined;
  let usage: (() => ReturnType<JevClientHandle["usage"]>) | undefined;
  try {
    for (const path of Object.values(m.paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
    Object.assign(process.env, env);
    process.chdir(m.paths.cwd);
    const manager = SessionManager.inMemory(m.paths.cwd);
    const actual = {
      cwd: m.paths.cwd,
      mode: "rpc",
      hasUI: false,
      ui: {},
      sessionManager: manager,
      modelRegistry: registry,
      isIdle: () => true,
      hasPendingMessages: () => false,
    } as unknown as ExtensionContext;
    const pi = {
      on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
      sendMessage() {
        throw Error("UNEXPECTED_MESSAGE");
      },
      events: { on: () => () => {}, emit() {} },
    } as unknown as ExtensionAPI;
    const emit = async (name: string, event: object) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, actual);
    };
    // The host's postflight admission uses calls < maxCalls even after C. One
    // bookkeeping headroom slot is necessary to save prepared evidence; the
    // independent SDK HTTP gate permits at most FOUR dispatches, never five.
    const settings = loadSettings({
      memory: {
        ...source,
        migrate: { auto: false },
        doctor: { notifyOnStart: false },
        scopes: { session: true, hub: false },
        incremental: {
          enabled: true,
          auto: false,
          changeThreshold: 2,
          quietSec: 0,
          idleSec: 0,
          cooldownSec: 3600,
          jobCostCapUsd: m.budgetUsd,
        },
        jev: {
          ...source.jev,
          // One-shot, SHA-approved probe-local copy ONLY. Production/stock I2
          // still refuses missing proxy capability; never persist this override.
          proxy: m.transport === "direct-user-approved" ? "" : source.jev.proxy,
          maxCalls: 5,
          maxCostUsd: m.budgetUsd,
          predict: { ...source.jev.predict, enabled: false },
          review: { enabled: false },
        },
      },
    }).memory;
    const scopes = wireMemoryScopes(pi, {
      settings,
      child: false,
      domain: "plain",
      gate: { check: () => ({ ok: true }) },
      locked: () => false,
      remote: () => undefined,
      hubPaths: () => undefined,
    });
    if (!scopes) {
      ctx.diagnostics.fail("NO_SCHEDULE");
      throw Error("OWNER_UNAVAILABLE");
    }
    const blocks = join(memoryDir, "blocks");
    // One-shot directory: never adopt or reuse evidence from an earlier run.
    if (existsSync(memoryDir)) throw Error("ISOLATION_NOT_EMPTY");
    mkdirSync(blocks, { recursive: true, mode: 0o700 });
    writeFileSync(join(blocks, ".layout.json"), '{"v":1,"source":"fresh"}', { mode: 0o600, flag: "wx" });
    const pair = syntheticBlocks();
    for (const b of pair) writeFileSync(join(blocks, `${b.id}.md`), b.rawBefore, { mode: 0o600, flag: "wx" });
    let active = true;
    let scheduler: ReturnType<typeof createIncrementalScheduler> | undefined;
    // Start the actual scopes/proof owner before installing wireJev. The
    // standalone probe deliberately has NO Jev startup health-check producer.
    await emit("session_start", { type: "session_start", reason: "startup" });
    const wire = wireJev(pi, {
      config: jevConfigOf(settings),
      settings,
      isChildSession: false,
      dirFor: () => memoryDir,
      getRenderInfo: () => undefined,
      onAfterWriteHook() {},
      log() {},
      p50: {
        available: () => active && !!scopes.current(),
        isCurrent: () => active && !!scopes.current(),
        onAfterWrite() {
          throw Error("AUTOMATIC_WRITE");
        },
        invalidate: () => scheduler?.stop(),
      },
    });
    const client = wire.client as JevClientHandle;
    usage = () => client.usage();
    const generate = client.generateRevision;
    const coverage = client.judgeRevisionCoverage;
    client.generateRevision = (request) => ctx.diagnostics.observeRevision("G1", generate(request));
    client.judgeRevisionCoverage = (request) => ctx.diagnostics.observeRevision("C1", coverage(request));
    shutdown = async () => {
      active = false;
      scheduler?.stop();
      await emit("session_shutdown", { type: "session_shutdown", reason: "shutdown" });
      scopes.dispose();
    };
    await emit("tool_result", {
      type: "tool_result",
      toolCallId: "probe-bootstrap",
      toolName: "read",
      input: {},
      content: [],
      isError: false,
    });
    const owner = scopes.current();
    if (!owner || !wire.p50?.ready()) {
      ctx.diagnostics.fail("NO_SCHEDULE");
      throw Error("OWNER_UNAVAILABLE");
    }
    const stat = statSync(memoryDir);
    const directory = { realpath: memoryDir, dev: stat.dev, ino: stat.ino, sessionEpoch: 1 };
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    // A standalone CLI has no pi UI/event-loop owner. Bootstrap only already-due
    // work via a cancellable microtask (not a ref'd keepalive/poll timer). Future
    // deadlines still use real wall time, segmented clocks and unref'd timers.
    const clock = createSegmentedClock({
      now: Date.now,
      set(ms, fn) {
        let cancelled = false;
        let timer: NodeJS.Timeout | undefined;
        if (ms === 0)
          queueMicrotask(() => {
            if (!cancelled) fn();
          });
        else {
          timer = setTimeout(fn, ms);
          timer.unref();
        }
        return {
          cancel() {
            cancelled = true;
            if (timer) clearTimeout(timer);
          },
        };
      },
      clear(handle) {
        (handle as { cancel(): void }).cancel();
      },
    });
    scheduler = createIncrementalScheduler({
      clock,
      settings: settings.incremental,
      jobCostCapUsd: m.budgetUsd,
      activity: () => scopes.activity?.(),
      isCurrent: () => active && scopes.current() === owner,
      readCorpus: readIncrementalCorpus,
      canAttempt: wire.p50.canAttempt,
      handler: async (batch, attempt) => {
        ctx.diagnostics.schedule();
        try {
          return await wire.p50!.handle(batch, attempt);
        } finally {
          complete();
        }
      },
    });
    const corpus = readIncrementalCorpus(directory);
    if (!corpus) throw Error("SYNTHETIC_DATA");
    scheduler.externalWrite(directory, corpus, "external");
    scheduler.externalWrite(directory, corpus, "external");
    // Shell timeout remains required. This local timer is unref'd and cleared;
    // no poll/retry/automatic second job is installed.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctx.diagnostics.timeout();
            reject(Error("PROBE_TIMEOUT"));
          }, 150000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const suggestions = readIndex(memoryDir).index.review?.suggestions.filter((s) => s.revision) ?? [];
    const p = suggestions[0]?.revision;
    if (!p) ctx.diagnostics.fail(ctx.diagnostics.noSuggestion());
    let audit: { state: string; commitOrigin?: string } | undefined;
    try {
      audit = p
        ? (JSON.parse(readFileSync(join(blocks, ".jev/revisions", p.batchId, p.actionId, "audit.json"), "utf8")) as {
            state: string;
            commitOrigin?: string;
          })
        : undefined;
      if (p && audit?.state !== "prepared") ctx.diagnostics.fail("AUDIT_MISSING");
    } catch {
      ctx.diagnostics.fail("AUDIT_MISSING");
      throw Error("INCOMPLETE_CLOSURE");
    }
    return {
      suggestions: suggestions.length,
      autoEligible: p?.autoEligible ?? false,
      automaticCommitCalls: audit?.commitOrigin === "p50-auto" ? 1 : 0,
      targetRawUnchanged: pair[0]!.rawBefore.equals(readFileSync(join(blocks, `${pair[0]!.id}.md`))),
      contextRawUnchanged: pair[1]!.rawBefore.equals(readFileSync(join(blocks, `${pair[1]!.id}.md`))),
      auditState: audit?.state ?? "missing",
      usage: (wire.client as JevClientHandle).usage(),
    };
  } catch {
    ctx.diagnostics.fail("RUNNER_FAILED");
    throw Error("INCOMPLETE_CLOSURE");
  } finally {
    if (usage) ctx.diagnostics.usage(usage());
    await shutdown?.();
    process.chdir(oldCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
