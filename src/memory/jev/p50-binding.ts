/** Executable SDK boundary for explicitly certified provider CODE, never models.json.
 * Stock pi 1.5 has no tokenizer/canonical route/classifier output-cap contract.
 * Without a native provider supplying this port, resolution is unsupported, NOT
 * permission to guess limits, routes, prices or to disable legacy Jev.
 * No client/ledger/global mutable registry; all authority is activation-local. */
import type {
  CanonicalClassifyRoute,
  ClassifierRegistryLike,
  ClassifyBounds,
  ClassifyContext,
  ClassifyResult,
  ControlledClassifyTransport,
  RevisionRegistryLike,
  RevisionResultEvidence,
  RevisionTransportContext,
} from "./contracts.js";
import { createRegistryRevisionTransport, type P50ClientCapabilities } from "./client.js";
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
    };
  /** Certified SystemOne extension: max_output_tokens is enforced by the
   * authenticated server; raw JSON p50.provider/model is backend identity.
   * Stock typesafe-system-one/llama-cpp do NOT certify this extension. */
  readonly classifiers: readonly SdkRoute<ClassifyContext>[];
  /** Certified openai-completions with last onPayload + raw SSE observation. */
  readonly generation: readonly SdkRoute<RevisionTransportContext>[];
  readonly coverage: readonly SdkRoute<RevisionTransportContext>[];
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

/** Concrete implementation, not an unavailable transport. All requests pass
 * through the current SDK registry/auth. Caller certifies server semantics and
 * tokenizer; this factory enforces/recounts the last payload and observes raw
 * identity/usage. It cannot conjure missing provider capabilities. */
export function createSdkP50Binding(spec: SdkP50BindingSpec): P50SdkBinding | undefined {
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
  const providers = [...new Set(routes.map((r) => String(modelIdentity(r.model).provider)))].map((id) => ({
    id,
    value: getProvider?.call(registry, id),
  }));
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
        })
      );
    } catch {
      return false;
    }
  };
  const transport: ControlledClassifyTransport = {
    prepare(input) {
      if (input.registry !== registry || !isCurrent()) return undefined;
      const r = classifiers.find(
        (r) => r.requestChainId === input.requestChainId && modelSignature(r.model) === modelSignature(input.model),
      );
      if (!r) return undefined;
      const bounds = quote(r, input.context, classifyMaxOutputTokens);
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
        adapterId: "p50-sdk-systemone-bounded-v1",
        chainVersion: adapterVersion,
        bounds,
        resultEvidence: (result) => observations.get(result) ?? {},
        resolveRoute: () => r.route,
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
              copy.max_output_tokens = bounds.maxOutputTokens;
              if (
                Object.keys(copy).sort().join(",") !== "max_output_tokens,model,questions,state" ||
                JSON.stringify({ state: copy.state, questions: copy.questions }) !== exactInput ||
                !payloadFits(r, copy, bounds)
              )
                throw Error("P50 classifier input/quote/route mismatch");
              payloadVerified = true;
              return copy;
            },
            fetch: async (url, init) => {
              if (++requests !== 1 || !payloadVerified || !isCurrent()) throw Error("P50 hidden classifier retry");
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
                  ...(text(actual?.provider) && text(actual?.model)
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
      model: r.model,
      requestChainId: r.requestChainId,
      adapterId: "p50-sdk-openai-completions-v1",
      chainVersion: adapterVersion,
      maxTokensEnforced: true as const,
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
          JSON.stringify(payload.messages) === JSON.stringify(expected) &&
          payloadFits(r, payload, bounds)
        );
      },
      resolveRoute: () => r.route,
    })),
  );
  return Object.freeze({
    registry,
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
