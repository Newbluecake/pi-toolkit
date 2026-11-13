/** Executable SDK boundary for explicitly certified provider CODE, never models.json.
 * Stock pi 1.5 has no tokenizer/canonical route/classifier output-cap contract.
 * Without a native provider supplying this port, resolution is unsupported, NOT
 * permission to guess limits, routes, prices or to disable legacy Jev.
 * The separately named stock-estimate factory below is suggest-only, NOT that
 * certification. No client/ledger/global mutable registry; authority is activation-local. */
import {
  STOCK_ESTIMATE_PROFILE,
  estimatePayload,
  stockClassifyPayload,
  stockRevisionPayload,
  stockRevisionPayloadSupported,
} from "./p50-estimate.js";
import type {
  CanonicalClassifyRoute,
  ClassifierRegistryLike,
  ClassifyBounds,
  ClassifyContext,
  ClassifyResult,
  ControlledClassifyTransport,
  RevisionRegistryLike,
  RevisionResultEvidence,
  RevisionStreamProxyCapability,
  RevisionTransportContext,
} from "./contracts.js";
import { createRegistryRevisionTransport, type P50ClientCapabilities } from "./client.js";
import { createProxyStreamFetch, type ProxyStreamFetchOptions } from "./proxy-stream-fetch.js";
import type { RevisionHostBinding } from "../govern/revision-host.js";

/** Native provider implementation port, not a string property accepted from JSON.
 * The provider returns one stable binding, constructed for THIS actual registry. */
export const P50_SDK_BINDING = Symbol.for("pi-subagent:memory-p50-sdk-binding-v1");
export interface P50SdkBinding extends RevisionHostBinding, P50ClientCapabilities {
  readonly classifiers: readonly string[];
  /** Rechecks registry/provider/method references and full model descriptors; no requests or reservations. */
  isCurrent(): boolean;
}
export type P50BindingResolution =
  | { readonly kind: "ready"; readonly binding: P50SdkBinding }
  | {
      readonly kind: "unsupported";
      readonly reason: "provider-contract-missing" | "binding-invalid" | "binding-ambiguous";
    };
export type P50BindingResolver = (
  registry: ClassifierRegistryLike,
  classifiers: readonly string[],
) => P50BindingResolution;

/** Optional production integration supplied by trusted native provider code.
 * No reads of user models/auth/config files and no network capability probing. */
export const resolveNativeP50Binding: P50BindingResolver = (registry, classifiers) => {
  const r = registry as ClassifierRegistryLike & { getRegisteredNativeProvider?(id: string): object | undefined };
  if (typeof r.getRegisteredNativeProvider !== "function")
    return { kind: "unsupported", reason: "provider-contract-missing" };
  try {
    const ports = new Set<unknown>();
    for (const id of classifiers) {
      const provider = r.getRegisteredNativeProvider(id.slice(0, id.indexOf("/")));
      if (provider) {
        const port = (provider as { [P50_SDK_BINDING]?: unknown })[P50_SDK_BINDING];
        if (port !== undefined && typeof port !== "function") return { kind: "unsupported", reason: "binding-invalid" };
        if (typeof port === "function") ports.add(port);
      }
    }
    if (!ports.size) return { kind: "unsupported", reason: "provider-contract-missing" };
    if (ports.size !== 1) return { kind: "unsupported", reason: "binding-ambiguous" };
    const port = [...ports][0] as (registry: ClassifierRegistryLike) => P50SdkBinding | undefined;
    const binding = port(registry);
    return binding &&
      binding.registry === registry &&
      binding.isCurrent() &&
      JSON.stringify(binding.classifiers) === JSON.stringify(classifiers)
      ? { kind: "ready", binding }
      : { kind: "unsupported", reason: "binding-invalid" };
  } catch {
    return { kind: "unsupported", reason: "binding-invalid" };
  }
};

/** MUST come from a provider's audited tokenizer + serializer/template contract.
 * quoteInput covers the exact context plus server formatting overhead. The
 * final payload is recounted immediately before HTTP; exceeding that reservation
 * rejects before dispatch. No byte heuristic or context-window constant here.
 * protocolEvidence/tokenizerEvidence identify the real contract/version, not
 * model-authored flags. Merely filling these strings does NOT certify a provider.
 * Only trusted integration code may construct this object after verification. */
export interface SdkTokenContract<TContext> {
  readonly protocolEvidence: string;
  readonly tokenizerEvidence: string;
  readonly priceUsdPerMillion: { readonly input: number; readonly output: number };
  quoteInput(context: TContext, maxOutputTokens: number): number | undefined;
  countPayload(payload: Readonly<Record<string, unknown>>): number | undefined;
}
interface SdkRoute<TContext> {
  readonly requestChainId: string;
  readonly model: object;
  readonly route: CanonicalClassifyRoute;
  readonly tokens: SdkTokenContract<TContext>;
}
export interface SdkP50BindingSpec {
  readonly registry: ClassifierRegistryLike &
    RevisionRegistryLike & {
      find?(provider: string, id: string): object | undefined;
      getProvider?(provider: string): object | undefined;
      /** SDK public raw extension-config Map reader; same PURE-read contract
       * as getProvider. Only model fields are witnessed, never credentials. */
      getRegisteredProviderConfig?(provider: string): object | undefined;
    };
  /** Certified SystemOne extension: max_output_tokens is enforced by the
   * authenticated server; raw JSON p50.provider/model is backend identity.
   * Stock typesafe-system-one/llama-cpp do NOT certify this extension. */
  readonly classifiers: readonly SdkRoute<ClassifyContext>[];
  /** Certified openai-completions with last onPayload + raw SSE observation. */
  readonly generation: readonly SdkRoute<RevisionTransportContext>[];
  readonly coverage: readonly SdkRoute<RevisionTransportContext>[];
  /** Trusted transport contract for this exact binding. Never inferred from
   * settings or models.json. Options only scope verification to an owned CA;
   * no global TLS changes, credentials, retry or direct-transport escape. */
  readonly streamingProxy?: { readonly proxy: string; readonly options?: ProxyStreamFetchOptions };
  readonly adapterVersion: string;
  readonly maxOutputTokens: number;
  readonly classifyMaxOutputTokens: number;
  readonly budgetMs: number;
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const positiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 1024;
function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
    ? (v as Record<string, unknown>)
    : undefined;
}
const modelIdentity = (model: object) => model as { provider?: unknown; id?: unknown; api?: unknown };
function checkedRoute<T>(r: SdkRoute<T>, api: string): boolean {
  const m = modelIdentity(r.model),
    route = r.route;
  const price = r.model && record((r.model as { cost?: unknown }).cost);
  return (
    !!m &&
    m.api === api &&
    text(m.id) &&
    text(m.provider) &&
    r.requestChainId === `${m.provider}/${m.id}` &&
    text(route.provider) &&
    text(route.model) &&
    /^[a-f0-9]{64}$/.test(route.routeIdentity) &&
    route.routeAliases.length > 0 &&
    route.routeAliases.length <= 32 &&
    route.routeAliases.every(text) &&
    route.routeAliases.includes(r.requestChainId) &&
    route.routeAliases.includes(`${route.provider}/${route.model}`) &&
    text(r.tokens.protocolEvidence) &&
    text(r.tokens.tokenizerEvidence) &&
    finite(r.tokens.priceUsdPerMillion.input) &&
    finite(r.tokens.priceUsdPerMillion.output) &&
    !!price &&
    [price.input, price.output, price.cacheRead, price.cacheWrite].every(finite) &&
    r.tokens.priceUsdPerMillion.input >=
      Math.max(price.input as number, price.cacheRead as number, price.cacheWrite as number) &&
    r.tokens.priceUsdPerMillion.output >= (price.output as number) &&
    typeof r.tokens.countPayload === "function" &&
    typeof r.tokens.quoteInput === "function"
  );
}
function snapshotRoute<T>(r: SdkRoute<T>): SdkRoute<T> {
  return Object.freeze({
    ...r,
    route: Object.freeze({ ...r.route, routeAliases: Object.freeze([...r.route.routeAliases]) }),
    tokens: Object.freeze({ ...r.tokens, priceUsdPerMillion: Object.freeze({ ...r.tokens.priceUsdPerMillion }) }),
  });
}
function quote<T>(r: SdkRoute<T>, context: T, maxOutputTokens: number): ClassifyBounds | undefined {
  const input = r.tokens.quoteInput(context, maxOutputTokens);
  return positiveInt(input)
    ? Object.freeze({ maxInputTokens: input, maxOutputTokens, priceUsdPerMillion: r.tokens.priceUsdPerMillion })
    : undefined;
}
function payloadFits<T>(r: SdkRoute<T>, payload: Readonly<Record<string, unknown>>, b: ClassifyBounds): boolean {
  const n = r.tokens.countPayload(payload);
  return payload.model === modelIdentity(r.model).id && positiveInt(n) && n <= b.maxInputTokens;
}

/** Pure data witness for already materialized SDK descriptors. Unlike
 * JSON.stringify(model), this never runs getters/toJSON. Accessors, functions,
 * cycles, symbols and non-data prototypes are unsupported, not silently read.
 * Trusted SDK/host objects must not be Proxies: JS has no trap-free Proxy read. */
function modelDataSignature(model: object): string | undefined {
  let remaining = 4096;
  const active = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 32) throw Error("model witness bounds");
    if (v === undefined) return ["undefined"];
    if (v === null || typeof v === "string" || typeof v === "boolean") return [typeof v, v];
    if (typeof v === "number" && Number.isFinite(v)) return ["number", v];
    if (typeof v !== "object" || v === null || active.has(v)) throw Error("model witness data");
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype))
      throw Error("model witness prototype");
    active.add(v);
    const entries = Reflect.ownKeys(v).map((key) => {
      if (typeof key !== "string") throw Error("model witness symbol");
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in d)) throw Error("model witness accessor");
      return [key, visit(d.value, depth + 1)];
    });
    active.delete(v);
    return [array ? "array" : "object", entries];
  };
  try {
    return JSON.stringify(visit(model, 0));
  } catch {
    return undefined;
  }
}
function dataField(value: object, key: PropertyKey): unknown {
  for (let at: object | null = value; at !== null; at = Object.getPrototypeOf(at) as object | null) {
    const d = Object.getOwnPropertyDescriptor(at, key);
    if (d !== undefined) return "value" in d ? d.value : d;
  }
  return undefined;
}

/** Concrete implementation, not an unavailable transport. All requests pass
 * through the current SDK registry/auth. Caller certifies server semantics and
 * tokenizer; this factory enforces/recounts the last payload and observes raw
 * identity/usage. It cannot conjure missing provider capabilities. */
export function createSdkP50Binding(spec: SdkP50BindingSpec): P50SdkBinding | undefined {
  return createBinding(spec, false);
}
function createBinding(spec: SdkP50BindingSpec, stock: boolean): P50SdkBinding | undefined {
  const chains = [spec.classifiers, spec.generation, spec.coverage];
  if (
    !text(spec.adapterVersion) ||
    !positiveInt(spec.maxOutputTokens) ||
    !positiveInt(spec.classifyMaxOutputTokens) ||
    !positiveInt(spec.budgetMs) ||
    chains.some((a) => !a.length || a.length > 4 || new Set(a.map((r) => r.requestChainId)).size !== a.length) ||
    spec.classifiers.some((r) => !checkedRoute(r, "typesafe-system-one")) ||
    [...spec.generation, ...spec.coverage].some((r) => !checkedRoute(r, "openai-completions"))
  )
    return undefined;
  const { adapterVersion, budgetMs, maxOutputTokens, classifyMaxOutputTokens } = spec;
  const revisionRoutes = new Map<string, SdkRoute<RevisionTransportContext>>();
  for (const r of [...spec.generation, ...spec.coverage]) {
    if (revisionRoutes.has(r.requestChainId) && revisionRoutes.get(r.requestChainId) !== r) return undefined;
    revisionRoutes.set(r.requestChainId, r);
  }
  const registry = spec.registry,
    classify = registry.classify,
    complete = registry.complete;
  if (!classify || !complete || !registry.find || !registry.getModelOfType) return undefined;
  const classifiers = spec.classifiers.map(snapshotRoute),
    generation = spec.generation.map(snapshotRoute),
    coverage = spec.coverage.map(snapshotRoute);
  const find = registry.find,
    get = registry.getModelOfType;
  // SDK composed providers materialize fresh model objects on every lookup.
  // Exact REGISTRY/provider/method references + the full immutable descriptor
  // are the binding, not an impossible fresh-object reference comparison.
  const modelSignature = (model: object | undefined) => (model === undefined ? undefined : JSON.stringify(model));
  const routes = [...classifiers, ...generation, ...coverage];
  const models = routes.map((r) => ({ model: r.model, signature: modelSignature(r.model) }));
  const getProvider = registry.getProvider;
  const getRegisteredProviderConfig = registry.getRegisteredProviderConfig;
  const rawApply = Reflect.apply;
  const modelConfigSignature = (config: object) =>
    modelDataSignature({
      api: dataField(config, "api"),
      baseUrl: dataField(config, "baseUrl"),
      models: dataField(config, "models"),
    });
  const providers = [...new Set(routes.map((r) => String(modelIdentity(r.model).provider)))].map((id) => ({
    id,
    value: getProvider?.call(registry, id),
  }));
  // A configured streaming capability needs a real raw provider witness. The
  // optional registry surface remains compatible for non-streaming callers.
  if (spec.streamingProxy !== undefined && (getProvider === undefined || providers.some((p) => p.value === undefined)))
    return undefined;
  const modelSources = providers.map((p) => {
    const value = getRegisteredProviderConfig?.call(registry, p.id);
    return { id: p.id, value, signature: value === undefined ? undefined : modelConfigSignature(value) };
  });
  if (modelSources.some((s) => s.value !== undefined && s.signature === undefined)) return undefined;
  const modelWitnesses = models.map((m) => ({ model: m.model, signature: modelDataSignature(m.model) }));
  // Public pi 1.5 getProvider -> ModelRuntime.getProvider -> Models.getProvider
  // is a raw Map.get, NOT provider.getModels/getAllModels. Only that audited
  // SDK accessor is trusted pure here; custom registry implementations must
  // honor the same contract. No registry monkey-patch or invented generation.
  // find/getModelOfType and all host callbacks remain in isCurrent, NEVER here.
  if (modelWitnesses.some((m) => m.signature === undefined)) return undefined;
  const providerWitnesses = providers.map((p) => ({
    ...p,
    fields:
      p.value === undefined ? [] : Reflect.ownKeys(p.value).map((key) => ({ key, value: dataField(p.value!, key) })),
  }));
  const terminalBindingCurrent = (): boolean => {
    try {
      return (
        dataField(registry, "classify") === classify &&
        dataField(registry, "complete") === complete &&
        dataField(registry, "find") === find &&
        dataField(registry, "getModelOfType") === get &&
        dataField(registry, "getProvider") === getProvider &&
        dataField(registry, "getRegisteredProviderConfig") === getRegisteredProviderConfig &&
        modelWitnesses.every((m) => modelDataSignature(m.model) === m.signature) &&
        // SDK lookups can materialize clones. Also witness the public raw
        // registered model source, so an in-place source edit cannot hide
        // behind an unchanged provider object and old materialized clone.
        modelSources.every((s) => s.value === undefined || modelConfigSignature(s.value) === s.signature) &&
        providerWitnesses.every(
          (p) =>
            p.value === undefined ||
            (Reflect.ownKeys(p.value).length === p.fields.length &&
              p.fields.every((f) => {
                const d = Object.getOwnPropertyDescriptor(p.value!, f.key);
                return d !== undefined && "value" in d && d.value === f.value;
              })),
        ) &&
        modelSources.every(
          (s) =>
            getRegisteredProviderConfig === undefined ||
            rawApply(getRegisteredProviderConfig, registry, [s.id]) === s.value,
        ) &&
        providers.every((p) => getProvider === undefined || rawApply(getProvider, registry, [p.id]) === p.value)
      );
    } catch {
      return false;
    }
  };
  const isCurrent = (): boolean => {
    try {
      return (
        registry.classify === classify &&
        registry.complete === complete &&
        registry.find === find &&
        registry.getModelOfType === get &&
        registry.getProvider === getProvider &&
        providers.every((p) => getProvider?.call(registry, p.id) === p.value) &&
        models.every((m) => modelSignature(m.model) === m.signature) &&
        classifiers.every((r) => {
          const m = modelIdentity(r.model);
          return (
            modelSignature(get.call(registry, "classifier", String(m.provider), String(m.id))) ===
            modelSignature(r.model)
          );
        }) &&
        [...generation, ...coverage].every((r) => {
          const m = modelIdentity(r.model);
          return modelSignature(find.call(registry, String(m.provider), String(m.id))) === modelSignature(r.model);
        }) &&
        (!stock || terminalBindingCurrent())
      );
    } catch {
      return false;
    }
  };
  const proxy = spec.streamingProxy;
  const streamFetch = proxy === undefined ? undefined : createProxyStreamFetch(proxy.proxy, proxy.options);
  // R3 returns undefined for invalid URLs: that is refusal, NOT native fetch.
  if (proxy !== undefined && streamFetch === undefined) return undefined;
  const streamingProxy: RevisionStreamProxyCapability | undefined =
    proxy === undefined || streamFetch === undefined
      ? undefined
      : Object.freeze({ registry, chainVersion: adapterVersion, proxy: proxy.proxy, fetch: streamFetch, isCurrent });
  const transport: ControlledClassifyTransport = {
    prepare(input) {
      if (input.registry !== registry || !isCurrent()) return undefined;
      const r = classifiers.find(
        (r) => r.requestChainId === input.requestChainId && modelSignature(r.model) === modelSignature(input.model),
      );
      if (!r) return undefined;
      const q = quote(r, input.context, classifyMaxOutputTokens);
      const bounds = q && (stock ? Object.freeze({ ...q, accountingProfile: STOCK_ESTIMATE_PROFILE }) : q);
      if (!bounds) return undefined;
      const exactInput = JSON.stringify({
        state: input.context.state,
        questions: Object.fromEntries(
          Object.entries(input.context.questions).map(([id, q]) => [
            id,
            q.type === "bool" ? { ...q, type: "noul" } : q,
          ]),
        ),
      });
      const observations = new WeakMap<ClassifyResult, RevisionResultEvidence>();
      return {
        adapterId: stock ? "p50-stock-estimate-v1" : "p50-sdk-systemone-bounded-v1",
        chainVersion: adapterVersion,
        bounds,
        resultEvidence: (result) => observations.get(result) ?? {},
        resolveRoute: () => (stock ? undefined : r.route),
        dispatch(opts) {
          if (!isCurrent() || opts.signal.aborted) throw Error("P50 binding revoked");
          let raw: unknown;
          let requests = 0,
            payloadVerified = false;
          // Wrap the provided proxy fetch when present, never silently bypass it.
          const request = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
          const pending = classify.call(registry, r.model, input.context, {
            signal: opts.signal,
            maxRetries: 0,
            onPayload(payload) {
              const p = record(payload);
              if (!p || !isCurrent()) throw Error("P50 invalid classifier payload");
              const copy = { ...p };
              for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) delete copy[key];
              if (!stock) copy.max_output_tokens = bounds.maxOutputTokens;
              if (
                Object.keys(copy).sort().join(",") !==
                  (stock ? "model,questions,state" : "max_output_tokens,model,questions,state") ||
                JSON.stringify({ state: copy.state, questions: copy.questions }) !== exactInput ||
                !payloadFits(r, copy, bounds)
              )
                throw Error("P50 classifier input/quote/route mismatch");
              payloadVerified = true;
              return copy;
            },
            fetch: async (url, init) => {
              const live = isCurrent();
              if (
                ++requests !== 1 ||
                !payloadVerified ||
                !live ||
                (stock && (!terminalBindingCurrent() || opts.terminalCurrent?.() === false || opts.signal.aborted))
              )
                throw Error("P50 hidden classifier retry");
              const response = await request(url, init);
              return {
                status: response.status,
                ok: response.ok,
                headers: response.headers,
                text: () => response.text(),
                json: async () => {
                  raw = await response.json();
                  return raw;
                },
              };
            },
          });
          // Observe before A registers its observer; return EXACT original SDK promise.
          void pending.then(
            (result) => {
              const body = record(raw),
                actual = record(body?.p50),
                usage = record(body?.usage);
              const inputTokens = usage?.input_tokens,
                outputTokens = usage?.output_tokens;
              const price = record((r.model as { cost?: unknown }).cost)!;
              const cost =
                finite(inputTokens) &&
                Number.isSafeInteger(inputTokens) &&
                finite(outputTokens) &&
                Number.isSafeInteger(outputTokens)
                  ? (inputTokens * (price.input as number) + outputTokens * (price.output as number)) / 1e6
                  : undefined;
              observations.set(
                result,
                Object.freeze({
                  ...(!stock && text(actual?.provider) && text(actual?.model)
                    ? { actual: { provider: actual.provider, model: actual.model } }
                    : {}),
                  ...(finite(cost) &&
                  result.usage?.input === inputTokens &&
                  finite(result.usage?.cost?.total) &&
                  Math.abs(result.usage!.cost!.total - cost) < 1e-12
                    ? { costUsd: cost }
                    : {}),
                }),
              );
            },
            () => {},
          );
          return pending;
        },
      };
    },
  };
  const revision = createRegistryRevisionTransport(
    [...new Map([...generation, ...coverage].map((r) => [r.requestChainId, r])).values()].map((r) => ({
      registry,
      ...(streamingProxy === undefined ? {} : { streamingProxy }),
      model: r.model,
      requestChainId: r.requestChainId,
      adapterId: stock ? "p50-stock-estimate-v1" : "p50-sdk-openai-completions-v1",
      chainVersion: adapterVersion,
      ...(stock ? { accountingProfile: STOCK_ESTIMATE_PROFILE } : { maxTokensEnforced: true as const }),
      outputLimitField: "max_tokens" as const,
      maxOutputTokens: maxOutputTokens,
      resultEvidence: "openai-completions" as const,
      quoteInput: (context: RevisionTransportContext) => (isCurrent() ? quote(r, context, maxOutputTokens) : undefined),
      verifyPayload: (
        payload: Readonly<Record<string, unknown>>,
        bounds: ClassifyBounds,
        context: RevisionTransportContext,
      ) => {
        const expected = [
          { role: "system", content: context.systemPrompt },
          ...context.messages.map((m) => ({ role: m.role, content: m.content })),
        ];
        return (
          isCurrent() &&
          (!stock || stockRevisionPayloadSupported(payload)) &&
          JSON.stringify(payload.messages) === JSON.stringify(expected) &&
          payloadFits(r, payload, bounds) &&
          isCurrent()
        );
      },
      resolveRoute: () => (stock ? undefined : r.route),
    })),
    terminalBindingCurrent,
  );
  return Object.freeze({
    registry,
    ...(stock ? { accountingProfile: STOCK_ESTIMATE_PROFILE } : {}),
    classifiers: Object.freeze(classifiers.map((r) => r.requestChainId)),
    transport,
    revision: Object.freeze({
      transport: revision,
      models: Object.freeze(generation.map((r) => r.requestChainId)),
      coverageModels: Object.freeze(coverage.map((r) => r.requestChainId)),
    }),
    budgetMs: budgetMs,
    maxOutputTokens: maxOutputTokens,
    isCurrent,
  });
}

/** Stock CODE profile. Same registry/SDK/ledger, honest local estimates and
 * unknown identity. No provider result can promote this profile to certified. */
export function createStockEstimateP50Binding(spec: {
  readonly registry: SdkP50BindingSpec["registry"];
  readonly classifier: string;
  readonly revisionModel: string;
  readonly streamingProxy?: SdkP50BindingSpec["streamingProxy"];
}): P50SdkBinding | undefined {
  try {
    const route = <T>(id: string, classifier: boolean): SdkRoute<T> | undefined => {
      const slash = id.indexOf("/"),
        provider = id.slice(0, slash),
        name = id.slice(slash + 1);
      if (slash < 1 || !name) return undefined;
      const model = classifier
        ? spec.registry.getModelOfType?.("classifier", provider, name)
        : spec.registry.find?.(provider, name);
      if (!model) return undefined;
      const price = record((model as { cost?: unknown }).cost);
      if (!price || ![price.input, price.output, price.cacheRead, price.cacheWrite].every(finite)) return undefined;
      return {
        requestChainId: id,
        model,
        // Internal placeholder ONLY to reuse descriptor validation. Never exposed as evidence.
        route: { provider, model: name, routeIdentity: "0".repeat(64), routeAliases: [id] },
        tokens: {
          protocolEvidence: "stock-estimate-v1: local estimate, serverEnforced:false",
          tokenizerEvidence: STOCK_ESTIMATE_PROFILE.estimatorId,
          priceUsdPerMillion: {
            input: Math.max(price.input as number, price.cacheRead as number, price.cacheWrite as number),
            output: price.output as number,
          },
          quoteInput: (ctx, output) =>
            estimatePayload(
              classifier
                ? stockClassifyPayload(name, ctx as ClassifyContext)
                : stockRevisionPayload(name, ctx as RevisionTransportContext, output),
            ),
          countPayload: estimatePayload,
        },
      };
    };
    const r = route<ClassifyContext>(spec.classifier, true),
      g = route<RevisionTransportContext>(spec.revisionModel, false);
    if (!r || !g) return undefined;
    return createBinding(
      {
        registry: spec.registry,
        classifiers: [r],
        generation: [g],
        coverage: [g],
        adapterVersion: "stock-estimate-v1",
        maxOutputTokens: 384,
        classifyMaxOutputTokens: 128,
        budgetMs: 30000,
        ...(spec.streamingProxy ? { streamingProxy: spec.streamingProxy } : {}),
      },
      true,
    );
  } catch {
    return undefined;
  }
}
/** Activation-local default fallback. Native invalid/ambiguous is never downgraded. */
export function createDefaultP50BindingResolver(revisionModel: string | undefined): P50BindingResolver {
  let cached: P50SdkBinding | undefined;
  return (registry, classifiers) => {
    const native = resolveNativeP50Binding(registry, classifiers);
    if (native.kind === "ready" || native.reason !== "provider-contract-missing") return native;
    if (cached?.registry === registry && cached.classifiers[0] === classifiers[0] && cached.isCurrent())
      return { kind: "ready", binding: cached };
    // Never renew a revoked binding in this activation or try a second model.
    if (cached || !classifiers[0] || !revisionModel) return { kind: "unsupported", reason: "binding-invalid" };
    cached = createStockEstimateP50Binding({ registry, classifier: classifiers[0], revisionModel });
    return cached ? { kind: "ready", binding: cached } : { kind: "unsupported", reason: "provider-contract-missing" };
  };
}
