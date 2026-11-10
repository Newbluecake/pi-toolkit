// I2 actual SDK + owned loopback CONNECT/TLS/SSE, no provider network or global TLS changes.
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createRegistryRevisionTransport,
  prepareRevisionOutbound,
  revisionRequestDigests,
} from "../../src/memory/jev/client.js";
import type {
  ControlledRevisionTransport,
  FetchLike,
  RegistryRevisionBinding,
  RevisionRegistryLike,
  RevisionStreamProxyCapability,
} from "../../src/memory/jev/contracts.js";
import { createSdkP50Binding, resolveNativeP50Binding } from "../../src/memory/jev/p50-binding.js";
import type { ProxyStreamFetch } from "../../src/memory/jev/proxy-stream-fetch.js";
import { wireJev } from "../../src/memory/jev/wire.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../src/memory/settings.js";
import { fakePi, emitAll } from "./helpers/schedule-activate.js";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { chunk, frame, provider, reply, sdkProxyLab, body, usage } from "./helpers/memory-p50-sdk-proxy.js";
import { deferred, streamTestCertificates } from "./helpers/memory-proxy-stream.js";

let certificates: ReturnType<typeof streamTestCertificates>;
let h: Awaited<ReturnType<typeof sdkProxyLab>> | undefined;
beforeAll(() => {
  certificates = streamTestCertificates();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const unavailable = { kind: "unavailable", reason: "revision-unavailable" };
async function idle() {
  await h!.lab.idle;
  expect(h!.lab.sockets.size).toBe(0);
}
function noDirect() {
  const direct = vi.fn(() => {
    throw Error("direct fetch forbidden");
  });
  vi.stubGlobal("fetch", direct);
  return direct;
}

describe("I2 real ModelRegistry → runtime → SDK openai-completions → R3 CONNECT/TLS/SSE", () => {
  it("parses the first provider event before EOF; registry token update, caps, raw identity/usage and one attempt", async () => {
    const eof = deferred();
    let ended = false;
    h = await sdkProxyLab(certificates, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(chunk(body, "backend-gen", null)));
      void eof.promise.then(() => {
        ended = true;
        res.write(frame(chunk("")));
        res.write(frame({ choices: [], usage }));
        res.end("data: [DONE]\n\n");
      });
    });
    const direct = noDirect();
    expect(h.binding.isCurrent()).toBe(true);
    await h.auth.modify(provider, async () => ({ type: "api_key", key: "synthetic-new-runtime-token" }));
    expect(h.binding.isCurrent()).toBe(true);
    const pending = h.client.generateRevision(h.request());
    await h.firstParsed;
    expect(ended).toBe(false);
    expect(h.events[0]).toMatchObject(chunk(body, "backend-gen", null));
    expect(h.client.usage().budget?.outstanding).toBe(1);
    eof.resolve();
    const result = await pending;
    expect(result).toMatchObject({
      kind: "ok",
      body,
      costUsd: 0.000035,
      provenance: { provider, model: "backend-gen", requestedModel: "gen", trusted: true },
    });
    expect(h.attempts).toEqual([{ maxRetries: 0, hasFetch: true, signal: expect.any(AbortSignal) }]);
    expect(h.lab.connects).toHaveLength(1);
    expect(h.lab.requests).toHaveLength(1);
    expect(h.lab.connects[0]!.headers).toMatchObject({
      "proxy-authorization": `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`,
    });
    expect(h.lab.connects[0]!.headers.authorization).toBeUndefined();
    expect(h.lab.requests[0]).toMatchObject({
      path: "/v1/chat/completions",
      sni: "localhost",
      headers: { authorization: "Bearer synthetic-new-runtime-token" },
    });
    expect(h.lab.requests[0]!.headers["proxy-authorization"]).toBeUndefined();
    const payload = JSON.parse(h.lab.requests[0]!.body.toString());
    expect(payload).toMatchObject({
      model: "gen",
      max_tokens: 128,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(direct).not.toHaveBeenCalled();
    expect(h.client.usage()).toMatchObject({
      calls: 1,
      costUsd: 0.000035,
      budget: { outstanding: 0, zombies: 0, reservedCalls: 0, reservedCostUsd: 0, costSource: "usage" },
    });
    await idle();
  });

  it("reads each request's updated credential from runtime, without rebinding or hand-filled Authorization", async () => {
    h = await sdkProxyLab(certificates);
    const direct = noDirect();
    expect((await h.client.generateRevision(h.request())).kind).toBe("ok");
    await h.auth.modify(provider, async () => ({ type: "api_key", key: "synthetic-second-runtime-token" }));
    expect((await h.client.generateRevision(h.request())).kind).toBe("ok");
    expect(h.lab.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer synthetic-old-runtime-token",
      "Bearer synthetic-second-runtime-token",
    ]);
    expect(h.attempts).toHaveLength(2);
    expect(h.lab.connects).toHaveLength(2);
    expect(direct).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no raw model or usage", model: null },
    { name: "model but no usage", model: "backend-gen" },
    { name: "malformed usage", model: "backend-gen", usage: { prompt_tokens: 10, total_tokens: 10 } },
  ])("$name stays independently unknown, reserve is retained and cannot be reused", async (option) => {
    h = await sdkProxyLab(certificates, (_req, res) => reply(res, option));
    noDirect();
    const result = await h.client.generateRevision(h.request({ jobId: "one-unknown", jobCostCapUsd: 0.0015 }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw Error("expected body");
    expect(result.provenance.trusted).toBe(option.model !== null);
    if (option.model === null)
      expect(result.provenance).toMatchObject({ provider: "", model: "", routeIdentity: "unknown" });
    const reserve = result.costUsd;
    expect(reserve).toBeGreaterThan(0.000035);
    expect(h.client.usage().budget?.costSource).toBe("reserve");
    expect(await h.client.generateRevision(h.request({ jobId: "one-unknown", jobCostCapUsd: 0.0015 }))).toEqual(
      unavailable,
    );
    expect(h.lab.requests).toHaveLength(1);
    await idle();
  });

  it("missing actual identity demotes a complete coverage response to unknown even with valid raw usage", async () => {
    h = await sdkProxyLab(certificates, (_req, res) =>
      reply(res, { model: null, usage, content: '{"verdict":"complete"}' }),
    );
    noDirect();
    const req = h.request();
    const result = await h.client.judgeRevisionCoverage({
      registry: req.registry,
      target: req.target,
      candidateBody: body,
      mode: "sync",
      budgetMs: req.budgetMs,
      maxOutputTokens: req.maxOutputTokens,
      jobCostCapUsd: 1,
    });
    expect(result).toMatchObject({
      kind: "ok",
      verdict: "unknown",
      provenance: { trusted: false, model: "" },
      costUsd: 0.000035,
    });
    expect(h.lab.requests).toHaveLength(1);
    await idle();
  });

  it.each([302, 307, 401, 429, 500])(
    "HTTP %s is one SDK attempt / CONNECT / request, never retry/redirect/direct fallback",
    async (status) => {
      h = await sdkProxyLab(certificates, (_req, res) => {
        res.writeHead(status, { location: "https://must-not-follow.invalid/" });
        res.end("owned failure");
      });
      const direct = noDirect();
      expect(await h.client.generateRevision(h.request())).toEqual(unavailable);
      expect(h.attempts).toHaveLength(1);
      expect(h.attempts[0]!.maxRetries).toBe(0);
      expect(h.lab.connects).toHaveLength(1);
      expect(h.lab.requests).toHaveLength(1);
      expect(direct).not.toHaveBeenCalled();
      await idle();
    },
  );

  it("invalid proxy construction (undefined R3 result) is refusal, not a native fetch capability", async () => {
    h = await sdkProxyLab(certificates);
    noDirect();
    for (const proxy of ["", "socks5://localhost:1", "http://bad%ZZ:pw@localhost:1", "not-a-url"]) {
      expect(createSdkP50Binding({ ...h.spec, streamingProxy: { proxy } })).toBeUndefined();
    }
    expect(h.attempts).toHaveLength(0);
    expect(h.lab.connects).toHaveLength(0);
  });

  it.each(["missing", "proxy", "registry", "version", "false", "throw", "cleared"])(
    "%s streaming contract fails closed before dispatch/reservation",
    async (mode) => {
      h = await sdkProxyLab(certificates);
      const direct = noDirect();
      const cap = h.binding.revision.transport.streamingProxy!;
      const replacement: RevisionStreamProxyCapability = {
        ...cap,
        ...(mode === "proxy" ? { proxy: "http://different.invalid:8080" } : {}),
        ...(mode === "registry" ? { registry: {} } : {}),
        ...(mode === "version" ? { chainVersion: "wrong-version" } : {}),
        ...(mode === "false" ? { isCurrent: () => false } : {}),
        ...(mode === "throw"
          ? {
              isCurrent: () => {
                throw Error("revoked");
              },
            }
          : {}),
      };
      const model = h.registry.find(provider, "gen")!;
      const b: RegistryRevisionBinding = {
        registry: h.registry,
        model,
        requestChainId: `${provider}/gen`,
        adapterId: "negative-only",
        chainVersion: h.spec.adapterVersion,
        maxTokensEnforced: true,
        outputLimitField: "max_tokens",
        maxOutputTokens: 128,
        quoteInput: () => ({ maxInputTokens: 100, priceUsdPerMillion: { input: 2, output: 3 } }),
        resolveRoute: () => undefined,
        ...(mode === "missing" ? {} : { streamingProxy: replacement }),
      };
      const transport = createRegistryRevisionTransport([b]);
      if (mode === "cleared") h.config.proxy = "";
      const client = h.makeClient({ enabled: true, revision: { ...h.binding.revision, transport } });
      expect(await client.generateRevision(h.request())).toEqual(unavailable);
      expect(client.usage()).toMatchObject({
        calls: 0,
        costUsd: 0,
        budget: { outstanding: 0, reservedCalls: 0, reservedCostUsd: 0 },
      });
      expect(h.attempts).toHaveLength(0);
      expect(h.lab.connects).toHaveLength(0);
      expect(direct).not.toHaveBeenCalled();
    },
  );

  it.each(["dispose", "caller", "background", "capability", "proxy", "throw"])(
    "final current callback synchronously %s: zero dispatch, no fees",
    async (mode) => {
      h = await sdkProxyLab(certificates);
      noDirect();
      const abort = new AbortController();
      let calls = 0;
      const client = h.makeClient({
        enabled: true,
        current: () => {
          if (++calls > 1) {
            if (mode === "dispose") client.dispose();
            if (mode === "caller") abort.abort();
            if (mode === "background") client.abortBackground();
            if (mode === "proxy") h!.config.proxy = "";
            if (mode === "capability") return undefined;
            if (mode === "throw") throw Error("current unavailable");
          }
          return h!.binding;
        },
      });
      expect(await client.generateRevision(h.request({ mode: "background", signal: abort.signal }))).toEqual(
        unavailable,
      );
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(h.attempts).toHaveLength(0);
      expect(h.lab.connects).toHaveLength(0);
      expect(client.usage()).toMatchObject({
        calls: 0,
        costUsd: 0,
        budget: { outstanding: 0, zombies: 0, reservedCalls: 0 },
      });
    },
  );

  it.each(["caller", "background", "dispose", "timeout"])(
    "SDK parsed stream %s converges sockets and the original accounting observer",
    async (mode) => {
      h = await sdkProxyLab(certificates, (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame(chunk(body, "backend-gen", null)));
      });
      noDirect();
      const abort = new AbortController();
      const pending = h.client.generateRevision(
        h.request({ mode: "background", signal: abort.signal, budgetMs: mode === "timeout" ? 150 : 2000 }),
      );
      await h.firstParsed;
      if (mode === "caller") abort.abort();
      if (mode === "background") h.client.abortBackground();
      if (mode === "dispose") h.client.dispose();
      expect(await pending).toEqual(unavailable);
      await idle();
      await vi.waitFor(() =>
        expect(h!.client.usage().budget).toMatchObject({
          outstanding: 0,
          zombies: 0,
          reservedCalls: 0,
          reservedCostUsd: 0,
        }),
      );
      expect(h.client.usage().calls).toBe(1);
      expect(h.client.usage().budget?.costSource).toBe("reserve");
      expect(h.attempts).toHaveLength(1);
      expect(h.lab.requests).toHaveLength(1);
    },
  );

  it("last payload token recount failure produces no CONNECT and cannot escape via buffered fetch", async () => {
    h = await sdkProxyLab(certificates);
    const direct = noDirect();
    const routes = h.spec.generation.map((r) => ({
      ...r,
      tokens: { ...r.tokens, countPayload: () => Number.MAX_SAFE_INTEGER },
    }));
    const b = createSdkP50Binding({ ...h.spec, generation: routes })!;
    expect(b).toBeDefined();
    const client = h.makeClient({ enabled: true, current: () => b });
    expect(await client.generateRevision(h.request())).toEqual(unavailable);
    expect(h.attempts).toHaveLength(1);
    expect(h.lab.connects).toHaveLength(0);
    expect(direct).not.toHaveBeenCalled();
  });

  it.each(["proxy", "cap", "binding replacement", "capability replacement", "unchanged"])(
    "last payload recount %s rechecks original client authority before CONNECT",
    async (mode) => {
      h = await sdkProxyLab(certificates);
      const direct = noDirect();
      let live = true;
      let counts = 0;
      let selected: ReturnType<typeof createSdkP50Binding>;
      const generation = h.spec.generation.map((r) => ({
        ...r,
        tokens: {
          ...r.tokens,
          countPayload(p: Readonly<Record<string, unknown>>) {
            counts++;
            if (mode === "proxy") h!.config.proxy = "http://changed.invalid:1";
            if (mode === "cap") live = false;
            if (mode === "binding replacement") selected = h!.binding;
            // Same revision/transport, different original client capability identity.
            if (mode === "capability replacement") selected = { ...binding };
            return r.tokens.countPayload(p);
          },
        },
      }));
      const binding = createSdkP50Binding({ ...h.spec, generation })!;
      expect(binding).toBeDefined();
      selected = binding;
      const client = h.makeClient({ enabled: true, current: () => (live ? selected : undefined) });
      const result = await client.generateRevision(h.request());
      expect(counts).toBe(1);
      expect(h.attempts).toHaveLength(1);
      expect(h.attempts[0]!.maxRetries).toBe(0);
      expect(direct).not.toHaveBeenCalled();
      if (mode === "unchanged") {
        expect(result).toMatchObject({ kind: "ok", body, costUsd: 0.000035 });
        expect(h.lab.connects).toHaveLength(1);
        expect(h.lab.requests).toHaveLength(1);
        expect(client.usage().budget?.costSource).toBe("usage");
        await idle();
      } else {
        expect(result).toEqual(unavailable);
        expect(h.lab.connects).toHaveLength(0);
        expect(h.lab.requests).toHaveLength(0);
        expect(h.events).toHaveLength(0);
        // No raw usage was observed. The sole original observer conservatively
        // retains its reserve; it must not invent a known zero/no-charge proof.
        expect(client.usage()).toMatchObject({
          calls: 1,
          budget: { outstanding: 0, zombies: 0, reservedCalls: 0, reservedCostUsd: 0, costSource: "reserve" },
        });
        expect(client.usage().costUsd).toBeGreaterThan(0.000035);
      }
    },
  );

  it.each(["proxy", "cap", "binding replacement", "capability replacement", "unchanged"])(
    "after real payload verification %s is rechecked at the actual SDK fetch boundary",
    async (mode) => {
      let afterPayload = false;
      let live = true;
      h = await sdkProxyLab(certificates, undefined, undefined, () => {
        afterPayload = true;
        if (mode === "proxy") h!.config.proxy = "http://changed.invalid:1";
        if (mode === "cap") live = false;
        if (mode === "binding replacement") selected = replacement;
        if (mode === "capability replacement") selected = { ...h!.binding };
      });
      const direct = noDirect();
      const replacement = createSdkP50Binding(h.spec)!;
      let selected = h.binding;
      let httpChecks = 0;
      const client = h.makeClient({
        enabled: true,
        current: () => {
          if (afterPayload) httpChecks++;
          return live ? selected : undefined;
        },
      });
      const result = await client.generateRevision(h.request());
      expect(afterPayload).toBe(true);
      expect(httpChecks).toBeGreaterThanOrEqual(1);
      expect(h.attempts).toHaveLength(1);
      expect(direct).not.toHaveBeenCalled();
      if (mode === "unchanged") {
        expect(result).toMatchObject({ kind: "ok", body, costUsd: 0.000035 });
        expect(h.lab.connects).toHaveLength(1);
        expect(h.lab.requests).toHaveLength(1);
        await idle();
      } else {
        expect(result).toEqual(unavailable);
        expect(h.lab.connects).toHaveLength(0);
        expect(h.lab.requests).toHaveLength(0);
        expect(h.events).toHaveLength(0);
        expect(client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0, costSource: "reserve" });
      }
    },
  );

  it.each(["provider", "provider+dispose", "model", "registered model", "unchanged"])(
    "B1 second repair: armed real current callback %s after onPayload has zero stale HTTP",
    async (mode) => {
      let armed = false;
      h = await sdkProxyLab(certificates, undefined, undefined, () => {
        armed = true;
      });
      const direct = noDirect();
      const observations: { before: boolean; after: boolean; aborted: boolean }[] = [];
      let reentered = false;
      const client = h.makeClient({
        enabled: true,
        current: () => {
          if (armed && !reentered) {
            reentered = true;
            const before = h!.binding.isCurrent();
            if (mode.startsWith("provider"))
              h!.registry.registerProvider(provider, { baseUrl: new URL("/v1", h!.lab.url).href });
            if (mode === "provider+dispose") client.dispose();
            if (mode === "model") Object.assign(h!.spec.generation[0]!.model, { maxTokens: 4095 });
            if (mode === "registered model")
              Object.assign(h!.registry.getRegisteredProviderConfig(provider)!.models![0]!, { maxTokens: 4095 });
            observations.push({ before, after: h!.binding.isCurrent(), aborted: h!.attempts[0]!.signal!.aborted });
          }
          return h!.binding;
        },
      });
      const result = await client.generateRevision(h.request());
      expect(reentered).toBe(true);
      expect(observations).toEqual([
        { before: true, after: mode === "unchanged", aborted: mode === "provider+dispose" },
      ]);
      expect(h.attempts).toHaveLength(1);
      expect(direct).not.toHaveBeenCalled();
      if (mode === "unchanged") {
        expect(result).toMatchObject({ kind: "ok", body, costUsd: 0.000035 });
        expect(h.lab.connects).toHaveLength(1);
        expect(h.lab.requests).toHaveLength(1);
        await idle();
      } else {
        expect(result).toEqual(unavailable);
        expect(h.lab.connects).toHaveLength(0);
        expect(h.lab.requests).toHaveLength(0);
        expect(h.events).toHaveLength(0);
        await vi.waitFor(() => expect(client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 }));
      }
    },
  );

  it.each(["model getter", "model toJSON", "registered model getter", "provider method", "registry getter"])(
    "B1 terminal data witness rejects %s without invoking it in the synchronous HTTP boundary",
    async (mode) => {
      let armed = false;
      h = await sdkProxyLab(certificates, undefined, undefined, () => {
        armed = true;
      });
      const direct = noDirect();
      let leftBoundary = false;
      const callbackPhases: boolean[] = [];
      const unexpectedCallback = vi.fn(() => {
        callbackPhases.push(leftBoundary);
        throw Error("untrusted descriptor callback");
      });
      let changed = false;
      const client = h.makeClient({
        enabled: true,
        current: () => {
          if (armed && !changed) {
            changed = true;
            // A resolved SDK error may be observed again after await. Distinguish
            // that normal observation from the MUST-be-pure synchronous hop.
            queueMicrotask(() => {
              leftBoundary = true;
            });
            if (mode === "model getter")
              Object.defineProperty(h!.spec.generation[0]!.model, "maxTokens", { get: unexpectedCallback });
            if (mode === "model toJSON") Object.assign(h!.spec.generation[0]!.model, { toJSON: unexpectedCallback });
            if (mode === "registered model getter")
              Object.defineProperty(h!.registry.getRegisteredProviderConfig(provider)!, "models", {
                get: unexpectedCallback,
              });
            if (mode === "provider method")
              Object.assign(h!.registry.getProvider(provider)!, { getModels: unexpectedCallback });
            if (mode === "registry getter")
              Object.defineProperty(h!.registry, "complete", { configurable: true, get: unexpectedCallback });
          }
          return h!.binding;
        },
      });
      expect(await client.generateRevision(h.request())).toEqual(unavailable);
      expect(changed).toBe(true);
      expect(callbackPhases).toEqual([true]);
      expect(unexpectedCallback).toHaveBeenCalledTimes(1);
      expect(h.attempts).toHaveLength(1);
      expect(h.lab.connects).toHaveLength(0);
      expect(h.lab.requests).toHaveLength(0);
      expect(h.events).toHaveLength(0);
      expect(direct).not.toHaveBeenCalled();
    },
  );

  it("prepared SDK adapter keeps optional no-client-callback compatibility with real HTTP/usage", async () => {
    h = await sdkProxyLab(certificates);
    const direct = noDirect();
    const outbound = prepareRevisionOutbound(h.request(), "generate")!.outbound;
    const prepared = h.binding.revision.transport.prepare({
      registry: h.registry,
      requestChainId: `${provider}/gen`,
      outbound,
      maxOutputTokens: 128,
      requestDigest: revisionRequestDigests(outbound, 128).requestDigest,
    })!;
    const result = await prepared.dispatch({
      signal: new AbortController().signal,
      fetch: prepared.streamingProxy!.fetch,
    });
    expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: body }] });
    expect(prepared.resultEvidence(result)).toMatchObject({
      actual: { provider, model: "backend-gen" },
      costUsd: 0.000035,
    });
    expect(h.attempts).toMatchObject([{ maxRetries: 0, hasFetch: true }]);
    expect(h.lab.connects).toHaveLength(1);
    expect(h.lab.requests).toHaveLength(1);
    expect(direct).not.toHaveBeenCalled();
    await idle();
  });

  it.each(["dispose", "caller", "background", "proxy", "registry method", "epoch"])(
    "last HTTP dynamic current callback synchronously changes %s: no callback may reopen HTTP after the pure guard",
    async (mode) => {
      let afterPayload = false;
      h = await sdkProxyLab(certificates, undefined, undefined, () => {
        afterPayload = true;
      });
      const direct = noDirect();
      const abort = new AbortController();
      let reentered = false;
      const client = h.makeClient({
        enabled: true,
        current: () => {
          if (afterPayload && !reentered) {
            reentered = true;
            if (mode === "dispose") client.dispose();
            if (mode === "caller") abort.abort();
            if (mode === "background") client.abortBackground();
            if (mode === "proxy") h!.config.proxy = "http://changed.invalid:1";
            if (mode === "registry method") h!.registry.complete = h!.registry.complete.bind(h!.registry);
            if (mode === "epoch") {
              // Observe a replacement through the SAME client, advancing its
              // original capability epoch without dispatching another request.
              alternate = true;
              void client.generateRevision(h!.request({ maxOutputTokens: 0 }));
            }
          }
          const result = alternate ? replacement : h!.binding;
          alternate = false;
          return result;
        },
      });
      const replacement = { ...h.binding };
      let alternate = false;
      expect(await client.generateRevision(h.request({ mode: "background", signal: abort.signal }))).toEqual(
        unavailable,
      );
      expect(reentered).toBe(true);
      expect(h.attempts).toHaveLength(1);
      expect(h.lab.connects).toHaveLength(0);
      expect(h.lab.requests).toHaveLength(0);
      expect(direct).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 }));
    },
  );

  it.each(["proxy", "cap", "fetch identity"])(
    "last HTTP stream callback changes %s before the original client dynamic gate",
    async (mode) => {
      let afterPayload = false;
      let live = true;
      let revoked = false;
      h = await sdkProxyLab(certificates, undefined, undefined, () => {
        afterPayload = true;
      });
      const direct = noDirect();
      const cap = h.binding.revision.transport.streamingProxy!;
      const streaming = {
        ...cap,
        isCurrent() {
          if (afterPayload) {
            revoked = true;
            if (mode === "proxy") h!.config.proxy = "http://changed.invalid:1";
            if (mode === "cap") live = false;
            if (mode === "fetch identity") streaming.fetch = direct;
          }
          return true;
        },
      };
      const transport = createRegistryRevisionTransport([
        {
          registry: h.registry,
          model: h.registry.find(provider, "gen")!,
          requestChainId: `${provider}/gen`,
          adapterId: "owned-last-http-callback",
          chainVersion: h.spec.adapterVersion,
          maxTokensEnforced: true,
          outputLimitField: "max_tokens",
          maxOutputTokens: 128,
          streamingProxy: streaming,
          quoteInput: () => ({ maxInputTokens: 4096, priceUsdPerMillion: { input: 2, output: 3 } }),
          resolveRoute: () => undefined,
        },
      ]);
      const binding = { ...h.binding, revision: { ...h.binding.revision, transport } };
      const client = h.makeClient({ enabled: true, current: () => (live ? binding : undefined) });
      expect(await client.generateRevision(h.request())).toEqual(unavailable);
      expect(revoked).toBe(true);
      expect(h.attempts).toHaveLength(1);
      expect(h.lab.connects).toHaveLength(0);
      expect(h.lab.requests).toHaveLength(0);
      expect(direct).not.toHaveBeenCalled();
    },
  );

  it("uses the original sync semaphore (3 active + 4 queued), rejects the fifth waiter and cancels all original SDK streams", async () => {
    h = await sdkProxyLab(certificates, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(chunk(body, "backend-gen", null)));
    });
    noDirect();
    const pending = Array.from({ length: 7 }, () => h!.client.generateRevision(h!.request()));
    await vi.waitFor(() => {
      expect(h!.lab.requests).toHaveLength(3);
      expect(h!.client.usage().budget?.queued).toEqual({ sync: 4, background: 0 });
    });
    expect(await h.client.generateRevision(h.request())).toEqual(unavailable);
    expect(h.attempts).toHaveLength(3);
    h.client.dispose();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 7 }, () => unavailable));
    await idle();
    await vi.waitFor(() =>
      expect(h!.client.usage().budget).toMatchObject({
        outstanding: 0,
        zombies: 0,
        reservedCalls: 0,
        reservedCostUsd: 0,
      }),
    );
    expect(h.client.usage().calls).toBe(3);
    expect(h.lab.connects).toHaveLength(3);
    expect(h.lab.requests).toHaveLength(3);
  });

  it.each(["proxy", "binding", "registry-remap", "runtime-auth-resync"])(
    "%s changes while queued/in flight revoke old success and queued dispatch; fees remain honest",
    async (mode) => {
      const release = deferred();
      h = await sdkProxyLab(certificates, (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame(chunk(body, "backend-gen", null)));
        void release.promise.then(() => {
          res.write(frame(chunk("")));
          res.write(frame({ choices: [], usage }));
          res.end("data: [DONE]\n\n");
        });
      });
      noDirect();
      let current = true;
      const client = h.makeClient({ enabled: true, current: () => (current ? h!.binding : undefined) });
      const pending = Array.from({ length: 4 }, () => client.generateRevision(h!.request()));
      await vi.waitFor(() => expect(h!.lab.requests).toHaveLength(3));
      expect(client.usage().budget?.queued.sync).toBe(1);
      if (mode === "proxy") h.config.proxy = "http://different.invalid:1";
      if (mode === "binding") current = false;
      if (mode === "registry-remap") h.registry.registerProvider(provider, { baseUrl: "https://remapped.invalid/v1" });
      // This SDK API recomposes the provider, unlike credential-store refresh.
      // A changed provider generation MUST revoke the old capability.
      if (mode === "runtime-auth-resync") await h.runtime.setRuntimeApiKey(provider, "synthetic-recomposed-token");
      release.resolve();
      expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => unavailable));
      expect(h.attempts).toHaveLength(3);
      expect(h.lab.requests).toHaveLength(3);
      expect(client.usage()).toMatchObject({
        calls: 3,
        costUsd: expect.closeTo(0.000105, 12),
        budget: { outstanding: 0, zombies: 0, reservedCalls: 0, reservedCostUsd: 0, costSource: "usage" },
      });
    },
  );

  it("controlled classifier still uses ONLY its old buffered proxy FetchLike", async () => {
    h = await sdkProxyLab(certificates);
    noDirect();
    const buffered = vi.fn<FetchLike>(async (_url, init) => {
      expect(init?.method).toBe("POST");
      const payload = JSON.parse(init!.body!);
      expect(payload.max_output_tokens).toBe(128);
      const raw = {
        answers: { q: { type: "noul", noul: 0.95 } },
        p50: { provider, model: "backend-relation" },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify(raw),
        json: async () => raw,
      };
    });
    const makeFetch = vi.fn(() => buffered);
    const client = h.makeClient({ enabled: true, current: () => h!.binding }, { makeFetch });
    const result = await client.ask({
      duty: "tag",
      registry: h.spec.registry,
      mode: "sync",
      budgetMs: 2000,
      state: {},
      questions: { q: { type: "bool", instructions: "Keep?", criteria: { true: "keep", false: "discard" } } },
      jobId: "buffered",
      jobCostCapUsd: 1,
    });
    expect(result).toMatchObject({ ok: true, answers: { q: { type: "bool", probability: 0.95 } } });
    expect(makeFetch).toHaveBeenCalledWith(h.lab.proxyUrl);
    expect(buffered).toHaveBeenCalledTimes(1);
    expect(h.attempts).toHaveLength(0);
    expect(h.lab.connects).toHaveLength(0);
  });

  it("real wireJev only lifts its proxy gate for the current certified capability; inline fixture does not certify stock", async () => {
    h = await sdkProxyLab(certificates);
    noDirect();
    const f = fakePi();
    const invalidate = vi.fn();
    const settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      incremental: { ...DEFAULT_MEMORY_SETTINGS.incremental, enabled: true, jobCostCapUsd: 1 },
    };
    const wire = wireJev(f.pi, {
      config: h.config,
      settings,
      isChildSession: false,
      dirFor: () => undefined,
      getRenderInfo: () => undefined,
      onAfterWriteHook: () => {},
      client: h.client,
      p50: {
        resolveBinding: () => ({ kind: "ready", binding: h!.binding }),
        available: () => true,
        isCurrent: () => true,
        onAfterWrite: () => {},
        invalidate,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = { modelRegistry: h.registry, cwd: "/unused-owned-test-context", hasUI: false };
    await emitAll(f, "turn_end", { message: { stopReason: "stop" } }, ctx);
    expect(wire.p50?.ready()).toBe(true);
    // This explicit CODE resolver is a synthetic test seam, not a native stock
    // registration. Absent native provider capability still stays unsupported.
    expect(resolveNativeP50Binding(h.spec.registry, h.binding.classifiers)).toEqual({
      kind: "unsupported",
      reason: "provider-contract-missing",
    });
    h.config.proxy = "http://changed.invalid:1";
    expect(wire.p50?.ready()).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toContain("streaming-proxy-contract-missing");
    expect(h.lab.connects).toHaveLength(0);
    await emitAll(f, "session_shutdown", { reason: "shutdown" }, ctx);
  });

  it.each(["dispose", "caller", "background"])(
    "stream capability callback can synchronously %s at final admission without dispatch",
    async (mode) => {
      h = await sdkProxyLab(certificates);
      noDirect();
      const abort = new AbortController();
      let checks = 0;
      const cap = h.binding.revision.transport.streamingProxy!;
      const liveCap = {
        ...cap,
        isCurrent() {
          if (++checks === 3) {
            if (mode === "dispose") client.dispose();
            if (mode === "caller") abort.abort();
            if (mode === "background") client.abortBackground();
          }
          return true;
        },
      };
      const transport = createRegistryRevisionTransport([
        {
          registry: h.registry,
          model: h.registry.find(provider, "gen")!,
          requestChainId: `${provider}/gen`,
          adapterId: "owned-reentrant-test",
          chainVersion: h.spec.adapterVersion,
          maxTokensEnforced: true,
          outputLimitField: "max_tokens",
          maxOutputTokens: 128,
          streamingProxy: liveCap,
          quoteInput: () => ({ maxInputTokens: 4096, priceUsdPerMillion: { input: 2, output: 3 } }),
          resolveRoute: () => undefined,
        },
      ]);
      const client = h.makeClient({ enabled: true, revision: { ...h.binding.revision, transport } });
      expect(await client.generateRevision(h.request({ mode: "background", signal: abort.signal }))).toEqual(
        unavailable,
      );
      expect(checks).toBe(3);
      expect(h.attempts).toHaveLength(0);
      expect(h.lab.connects).toHaveLength(0);
      expect(client.usage()).toMatchObject({
        calls: 0,
        costUsd: 0,
        budget: { outstanding: 0, zombies: 0, reservedCalls: 0, reservedCostUsd: 0 },
      });
    },
  );

  it("final payload count callback may synchronously dispose: pure signal recheck forbids HTTP", async () => {
    h = await sdkProxyLab(certificates);
    const direct = noDirect();
    const routes = h.spec.generation.map((r) => ({
      ...r,
      tokens: {
        ...r.tokens,
        countPayload(p: Readonly<Record<string, unknown>>) {
          client.dispose();
          return r.tokens.countPayload(p);
        },
      },
    }));
    const b = createSdkP50Binding({ ...h.spec, generation: routes })!;
    const client = h.makeClient({ enabled: true, current: () => b });
    expect(await client.generateRevision(h.request())).toEqual(unavailable);
    await vi.waitFor(() => expect(client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 }));
    expect(h.attempts).toHaveLength(1);
    expect(h.lab.connects).toHaveLength(0);
    expect(direct).not.toHaveBeenCalled();
  });

  it.each(["truncated", "missing finish"])(
    "SDK %s stream is one request and unknown fee, not a successful generated body",
    async (mode) => {
      h = await sdkProxyLab(certificates, (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          ...(mode === "truncated" ? { "content-length": "10000" } : {}),
        });
        res.write(frame(chunk(body, "backend-gen", null)));
        if (mode === "truncated") res.socket!.end();
        else res.end("data: [DONE]\n\n");
      });
      noDirect();
      expect(await h.client.generateRevision(h.request())).toEqual(unavailable);
      expect(h.attempts).toHaveLength(1);
      expect(h.lab.requests).toHaveLength(1);
      expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0, costSource: "reserve" });
      await idle();
    },
  );

  it.each(["fetch", "version", "proxy"])(
    "capability callback mutating %s cannot authorize the changed transport",
    async (mode) => {
      h = await sdkProxyLab(certificates);
      const direct = noDirect();
      let checks = 0;
      const cap = h.binding.revision.transport.streamingProxy!;
      const liveCap = {
        ...cap,
        isCurrent() {
          if (++checks === 3) {
            if (mode === "fetch") liveCap.fetch = globalThis.fetch;
            if (mode === "version") liveCap.chainVersion = "changed-v2";
            if (mode === "proxy") liveCap.proxy = "http://changed.invalid:1";
          }
          return true;
        },
      };
      const transport = createRegistryRevisionTransport([
        {
          registry: h.registry,
          model: h.registry.find(provider, "gen")!,
          requestChainId: `${provider}/gen`,
          adapterId: "owned-mutation-test",
          chainVersion: h.spec.adapterVersion,
          maxTokensEnforced: true,
          outputLimitField: "max_tokens",
          maxOutputTokens: 128,
          streamingProxy: liveCap,
          quoteInput: () => ({ maxInputTokens: 4096, priceUsdPerMillion: { input: 2, output: 3 } }),
          resolveRoute: () => undefined,
        },
      ]);
      const client = h.makeClient({ enabled: true, revision: { ...h.binding.revision, transport } });
      expect(await client.generateRevision(h.request())).toEqual(unavailable);
      expect(checks).toBe(3);
      expect(h.attempts).toHaveLength(0);
      expect(h.lab.connects).toHaveLength(0);
      expect(client.usage().calls).toBe(0);
      expect(direct).not.toHaveBeenCalled();
    },
  );

  it("standard streaming fetch and legacy JSON-only fetch cannot be interchanged (strict type negatives)", () => {
    expectTypeOf<ModelRegistry>().toMatchTypeOf<RevisionRegistryLike>();
    function typesOnly(
      buffered: FetchLike,
      standard: ProxyStreamFetch,
      prepared: NonNullable<ReturnType<ControlledRevisionTransport["prepare"]>>,
    ) {
      void prepared.dispatch({
        signal: new AbortController().signal,
        // @ts-expect-error The last-hop authority guard must be synchronous.
        isCurrent: async () => true,
      });
      void prepared.dispatch({
        signal: new AbortController().signal,
        // @ts-expect-error The internal pure witness must also be synchronous.
        terminalCurrent: async () => true,
      });
      // @ts-expect-error JSON response is not a streaming Response.
      const bad: ProxyStreamFetch = buffered;
      const cap: RevisionStreamProxyCapability = {
        registry: {},
        proxy: "http://localhost:1",
        chainVersion: "v1",
        // @ts-expect-error A revision capability requires a real standard fetch.
        fetch: buffered,
        isCurrent: () => true,
      };
      const good: ProxyStreamFetch = standard;
      return { bad, cap, good };
    }
    expectTypeOf(typesOnly).parameter(1).toEqualTypeOf<ProxyStreamFetch>();
  });
});
