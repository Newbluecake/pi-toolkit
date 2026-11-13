import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWithOptions } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import * as sdk from "@earendil-works/pi-coding-agent";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { loadSettings } from "../../../src/config/settings.js";
import {
  openProbeCatalog,
  buildClosureManifest,
  requireProbeAuth,
  requireQuote,
  ProbeRegistry,
  runClosureHost,
} from "../../../scripts/dev/p50-closure-runtime.js";
import {
  closureManifestBytes,
  manifestSha256,
  probeMain,
  probeErrorCode,
  runApprovedClosureProbe,
} from "../../../scripts/dev/p50-closure-live-probe.js";
const SECRET = "synthetic-credential-NEVER-PRINT-5df9b2";
/** JSON.stringify(Error) is {}, so scan rendered diagnostics, not JSON mock calls.
 * Restore locally even on failure so Vitest's own reporting is never swallowed. */
async function captureOutput<T>(run: () => Promise<T>) {
  const output: string[] = [];
  const consoles = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args) => {
      output.push(
        formatWithOptions(
          { colors: false, getters: false, depth: null, maxStringLength: null, maxArrayLength: null },
          ...args,
        ) + "\n",
      );
    }),
  );
  const write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const done = typeof encoding === "function" ? encoding : callback;
    done?.();
    return true;
  };
  const streams = [process.stdout, process.stderr].map((stream) => vi.spyOn(stream, "write").mockImplementation(write));
  try {
    return { value: await run(), output: output.join("") };
  } finally {
    for (const spy of [...consoles, ...streams]) spy.mockRestore();
  }
}
it("diagnostic capture sees Error messages/causes on all five console methods and both raw streams", async () => {
  const captured = await captureOutput(async () => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      console[method](`console.${method}`, new Error("outer", { cause: new Error(SECRET) }));
    process.stdout.write(`stdout:${SECRET.slice(0, 12)}`);
    process.stdout.write(SECRET.slice(12));
    process.stderr.write(Buffer.from(`stderr:${SECRET}`));
  });
  for (const channel of [
    "console.log",
    "console.info",
    "console.warn",
    "console.error",
    "console.debug",
    "stdout",
    "stderr",
  ])
    expect(captured.output).toContain(channel);
  expect(captured.output.split(SECRET)).toHaveLength(8);
});
const roots: string[] = [];
afterEach(() => {
  clearHealthTable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "p50-auth-bridge-"));
  roots.push(path);
  return path;
}
async function catalog(key: string | undefined = SECRET, credentialReader = sdk.readStoredCredential) {
  const agent = root();
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "p50-offline": {
          baseUrl: "https://p50.invalid/v1",
          ...(key ? { apiKey: key } : {}),
          models: [
            {
              id: "r",
              name: "r",
              type: "classifier",
              api: "typesafe-system-one",
              input: ["text"],
              contextWindow: 32000,
              cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
            },
            {
              id: "g",
              name: "g",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 2048,
              compat: { maxTokensField: "max_tokens" },
              cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const opened = await openProbeCatalog(agent, true, credentialReader);
  const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8")).providers["p50-offline"].models;
  opened.registry.registerProvider("p50-offline", {
    baseUrl: "https://p50.invalid/v1",
    ...(key ? { apiKey: key } : {}),
    models,
    classifiers: { "typesafe-system-one": { classify } },
  });
  await opened.runtime.refresh({ allowNetwork: false });
  const settings = loadSettings({
    memory: {
      jev: {
        classifiers: ["p50-offline/r", "unused/second"],
        proxy: "",
        predict: { model: { models: ["p50-offline/g", "unused/other"] } },
      },
    },
  }).memory;
  const manifest = buildClosureManifest(settings, opened.registry, root());
  return { ...opened, settings, manifest, agent };
}
function http(failAt = 0) {
  let attempts = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    const payload = JSON.parse(String(init?.body));
    if (++attempts === failAt) throw Error(`untrusted fetch echoed ${SECRET}`);
    if (payload.questions)
      return new Response(
        JSON.stringify({
          answers: {
            revisionRelation: {
              type: "choice",
              choice: "conflict",
              probabilities: { conflict: 0.99, supersedes: 0.005, unrelated: 0.005 },
              confidence: 0.99,
            },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const coverage = String(payload.messages[0].content).includes('"verdict"');
    const text = coverage
      ? '{"verdict":"unknown"}'
      : "Synthetic release policy: retain both directory Alpha and Beta policies for human review. Preserve audit logs and verify checksums.";
    return new Response(
      `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: "unverified-backend", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: "unverified-backend", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
}
function sdkCall(registry: ProbeRegistry, kind: "classify" | "complete", maxRetries = 0) {
  if (kind === "classify") {
    return registry.classify(
      registry.getModelOfType("classifier", "p50-offline", "r")!,
      {
        state: { synthetic: true },
        questions: {
          revisionRelation: {
            type: "choice",
            instructions: "Compare synthetic policies",
            criteria: { conflict: "Conflict", supersedes: "Supersedes", unrelated: "Unrelated" },
          },
        },
      },
      { maxRetries },
    );
  }
  return registry.complete(
    registry.find("p50-offline", "g")!,
    { messages: [{ role: "user", content: "Synthetic offline request", timestamp: 0 }] },
    { maxRetries },
  );
}
it.each(["classify", "complete"] as const)(
  "guarded %s sanitizes a real bottom-fetch rejection and stops with zero extra HTTP",
  async (kind) => {
    const c = await catalog();
    const upstream = new Error(`untrusted bottom fetch echoed ${SECRET}`);
    const trace: string[] = [];
    // No stock binding wrapper here: its one-request guard would mask a second
    // fallback invocation in ProbeRegistry.guarded(). Count at the actual wire.
    const bottomFetch = vi.fn<typeof fetch>(async () => {
      trace.push("bottom-fetch");
      throw upstream;
    });
    vi.stubGlobal("fetch", bottomFetch);
    const before = vi.fn(() => {
      trace.push("before-http");
    });
    const registry = new ProbeRegistry(c.runtime, before);
    await requireProbeAuth(c.runtime, c.registry, c.manifest);
    const captured = await captureOutput(async () => {
      const failed = await sdkCall(registry, kind);
      const stopped = await sdkCall(registry, kind);
      return { failed, stopped };
    });
    // The callback succeeded; the exact secret-bearing rejection originated at
    // the lowest fake fetch, traversed guarded's catch, and was sanitized there.
    expect(before).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledWith(
      "R1",
      c.manifest.routes[kind === "classify" ? 0 : 2]!.endpoint,
      expect.any(Object),
    );
    expect(bottomFetch).toHaveBeenCalledTimes(1);
    await expect(bottomFetch.mock.results[0]!.value).rejects.toBe(upstream);
    expect(trace).toEqual(["before-http", "bottom-fetch"]);
    const [url, init] = bottomFetch.mock.calls[0]!;
    expect(String(url)).toBe(c.manifest.routes[kind === "classify" ? 0 : 2]!.endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(init?.redirect).toBe("error");
    for (const result of Object.values(captured.value))
      expect(result).toMatchObject({ stopReason: "error", errorMessage: "PROVIDER_FAILED" });
    expect(captured.output).not.toContain(SECRET);
    expect(
      formatWithOptions({ colors: false, depth: null, maxStringLength: null, maxArrayLength: null }, captured.value),
    ).not.toContain(SECRET);
  },
);
it("SDK classify/complete receive maxRetries === 0 independently of HTTP counts and caller options", async () => {
  const c = await catalog();
  const bottomFetch = http();
  vi.stubGlobal("fetch", bottomFetch);
  // Call-through spies at the SDK boundary, AFTER ProbeRegistry's option merge;
  // successful HTTP would not expose a maxRetries regression by request count.
  const classify = vi.spyOn(c.runtime, "classify");
  const complete = vi.spyOn(c.runtime, "complete");
  const registry = new ProbeRegistry(c.runtime, () => {});
  const r = await sdkCall(registry, "classify", 7);
  const g = await sdkCall(registry, "complete", 7);
  expect(r.stopReason).toBe("stop");
  expect(g.stopReason).toBe("stop");
  expect(classify).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(classify.mock.calls[0]![2]?.maxRetries).toBe(0);
  expect(complete.mock.calls[0]![2]?.maxRetries).toBe(0);
  expect(bottomFetch).toHaveBeenCalledTimes(2);
});
it("no --live rejects before catalog/auth/network; print is deterministic, credential-free, exact routes/prices and no sensitive payload body", async () => {
  const c = await catalog();
  const fetch = http();
  vi.stubGlobal("fetch", fetch);
  const open = vi.fn(async () => c),
    auth = vi.fn(),
    run = vi.fn();
  const ports = { open, auth, run };
  expect(await probeMain([], ports)).toEqual({ code: 2, output: "APPROVAL_REQUIRED\n" });
  expect(open).not.toHaveBeenCalled();
  const args = ["--print-manifest", "--root", c.manifest.root];
  const printed = await probeMain(args, ports);
  expect(printed.code).toBe(0);
  expect(await probeMain(args, ports)).toEqual(printed);
  expect(open).toHaveBeenCalledWith(expect.any(String), false);
  expect(auth).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  const out = JSON.parse(printed.output);
  expect(out.manifest.routes.map((r: { route: string }) => r.route)).toEqual([
    "p50-offline/r",
    "p50-offline/r",
    "p50-offline/g",
    "p50-offline/g",
  ]);
  expect(out.manifest.approval).toMatchObject({
    callPlan: "2R+1G+1C",
    retries: 0,
    serverEnforced: false,
    billing: "UNKNOWN",
    auto: false,
  });
  expect(out.manifest.budgetUsd).toBeLessThanOrEqual(0.01);
  expect(out.manifestSha256).toBe(manifestSha256(closureManifestBytes(out.manifest)));
  expect(printed.output).not.toContain(SECRET);
  expect(printed.output).not.toContain("publish release artifacts");
});
it("bad manifest sha and >$1 quote refuse BEFORE catalog/auth/runner/fetch", async () => {
  const c = await catalog();
  const file = join(root(), "approval.json");
  writeFileSync(file, JSON.stringify({ manifest: c.manifest }));
  const open = vi.fn(),
    auth = vi.fn(),
    run = vi.fn(),
    fetch = http();
  vi.stubGlobal("fetch", fetch);
  expect(
    await probeMain(["--live", "--manifest", file, "--manifest-sha", "f".repeat(64)], { open, auth, run }),
  ).toEqual({ code: 2, output: "APPROVAL_HASH_MISMATCH\n" });
  const huge = { ...c.manifest, budgetUsd: 1.01, plannedReserveUsd: 1.01 };
  writeFileSync(file, JSON.stringify({ manifest: huge }));
  expect(
    await probeMain(["--live", "--manifest", file, "--manifest-sha", manifestSha256(closureManifestBytes(huge))], {
      open,
      auth,
      run,
    }),
  ).toEqual({ code: 2, output: "RESERVATION_LIMIT\n" });
  expect(() => requireQuote(huge)).toThrow("RESERVATION_LIMIT");
  expect(open).not.toHaveBeenCalled();
  expect(auth).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("SDK auth absent (or SDK throws credential text) => AUTH_UNAVAILABLE, both before HTTP; no token in returned error", async () => {
  const c = await catalog("");
  const fetch = http();
  vi.stubGlobal("fetch", fetch);
  await expect(requireProbeAuth(c.runtime, c.registry, c.manifest)).rejects.toThrow("AUTH_UNAVAILABLE");
  const getAuth = vi.fn(async () => {
    throw Error(SECRET);
  });
  const caught = await requireProbeAuth({ getAuth }, c.registry, c.manifest).catch((error) => error);
  expect(String(caught)).toBe("Error: AUTH_UNAVAILABLE");
  expect(JSON.stringify(caught)).not.toContain(SECRET);
  expect(probeErrorCode(Error(SECRET))).toBe("PROBE_FAILED");
  expect(fetch).not.toHaveBeenCalled();
});
it("valid CLI manifest still refuses missing auth, route drift and unsupported proxy before runner/data/network", async () => {
  const c = await catalog("");
  const file = join(root(), "approved.json");
  writeFileSync(file, JSON.stringify({ manifest: c.manifest }));
  const args = ["--live", "--manifest", file, "--manifest-sha", manifestSha256(closureManifestBytes(c.manifest))];
  const fetch = http();
  vi.stubGlobal("fetch", fetch);
  const run = vi.fn(),
    auth = vi.fn(requireProbeAuth),
    open = vi.fn(async () => c);
  expect(await probeMain(args, { open, auth, run })).toEqual({ code: 2, output: "AUTH_UNAVAILABLE\n" });
  expect(auth).toHaveBeenCalledTimes(1);
  expect(readdirSync(c.manifest.root)).toEqual([]);
  const changed = loadSettings({
    memory: { ...c.settings, jev: { ...c.settings.jev, classifiers: ["missing/model"] } },
  }).memory;
  expect(await probeMain(args, { open: async () => ({ ...c, settings: changed }), auth, run })).toEqual({
    code: 2,
    output: "ROUTE_UNAVAILABLE\n",
  });
  const proxySettings = { ...c.settings, jev: { ...c.settings.jev, proxy: "http://127.0.0.1:9" } };
  const proxyManifest = buildClosureManifest(proxySettings, c.registry, c.manifest.root);
  expect(proxyManifest.approval).toMatchObject({ executionGate: "PROXY_UNAVAILABLE" });
  writeFileSync(file, JSON.stringify({ manifest: proxyManifest }));
  expect(
    await probeMain(
      ["--live", "--manifest", file, "--manifest-sha", manifestSha256(closureManifestBytes(proxyManifest))],
      { open: async () => ({ ...c, settings: proxySettings }), auth, run },
    ),
  ).toEqual({ code: 2, output: "PROXY_UNAVAILABLE\n" });
  expect(auth).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("public SDK stored-credential reader is used only by LIVE auth, never print; OAuth refuses without refresh or writes", async () => {
  const reader = vi.fn(sdk.readStoredCredential);
  const c = await catalog("", reader);
  reader.mockClear();
  const file = join(c.agent, "auth.json");
  const raw = JSON.stringify({ "p50-offline": { type: "api_key", key: SECRET } });
  writeFileSync(file, raw);
  const fetch = http();
  vi.stubGlobal("fetch", fetch);
  const offline = await openProbeCatalog(c.agent, false, reader);
  await probeMain(["--print-manifest", "--root", c.manifest.root], {
    open: async () => ({ ...offline, settings: c.settings }),
    auth: requireProbeAuth,
    run: runClosureHost,
  });
  expect(reader).not.toHaveBeenCalled();
  await requireProbeAuth(c.runtime, c.registry, c.manifest);
  expect(reader).toHaveBeenCalledWith("p50-offline", file);
  expect(fetch).not.toHaveBeenCalled();
  expect(readFileSync(file, "utf8")).toBe(raw);
  writeFileSync(
    file,
    JSON.stringify({ "p50-offline": { type: "oauth", access: SECRET, refresh: SECRET, expires: 0 } }),
  );
  await expect(requireProbeAuth(c.runtime, c.registry, c.manifest)).rejects.toThrow("AUTH_UNAVAILABLE");
  for (const key of ["!echo never-execute", "$P50_NEVER_READ_KEY"]) {
    writeFileSync(file, JSON.stringify({ "p50-offline": { type: "api_key", key } }));
    await expect(requireProbeAuth(c.runtime, c.registry, c.manifest)).rejects.toThrow("AUTH_UNAVAILABLE");
  }
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [0, false],
  [0, true],
  [1, false],
  [3, false],
] as const)(
  "public SDK auth → wire/host (failAt=%s, stored=%s); four calls or stop without retry/key leaks",
  async (failAt, stored) => {
    const c = await catalog(stored ? "" : SECRET);
    if (stored)
      writeFileSync(join(c.agent, "auth.json"), JSON.stringify({ "p50-offline": { type: "api_key", key: SECRET } }));
    const fetch = http(failAt);
    vi.stubGlobal("fetch", fetch);
    await requireProbeAuth(c.runtime, c.registry, c.manifest);
    expect(fetch).not.toHaveBeenCalled();
    const bytes = closureManifestBytes(c.manifest);
    const captured = await captureOutput(async () => {
      try {
        return await runApprovedClosureProbe(bytes, manifestSha256(bytes), async (ctx) => {
          const registry = new ProbeRegistry(c.runtime, ctx.beforeHttp);
          return runClosureHost(ctx, registry, c.settings);
        });
      } catch (failure) {
        return probeErrorCode(failure);
      }
    });
    const outcome = captured.value;
    if (failAt) {
      expect(outcome).toBe("INCOMPLETE_CLOSURE");
      expect(fetch).toHaveBeenCalledTimes(failAt);
    } else {
      expect(outcome).toMatchObject({
        verdict: "PASS",
        effect: {
          suggestions: 1,
          autoEligible: false,
          automaticCommitCalls: 0,
          targetRawUnchanged: true,
          contextRawUnchanged: true,
          auditState: "prepared",
          usage: { calls: 4 },
        },
      });
      expect(fetch).toHaveBeenCalledTimes(4);
      expect((outcome as { events: { stage: string }[] }).events.map((e) => e.stage)).toEqual(["R1", "R2", "G1", "C1"]);
    }
    expect(captured.output).not.toContain(SECRET);
    expect(
      formatWithOptions({ colors: false, depth: null, maxStringLength: null, maxArrayLength: null }, outcome),
    ).not.toContain(SECRET);
    // Inspect all synthetic reports/audit sidecars, not just console text.
    const visit = (dir: string): string =>
      readdirSync(dir, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? visit(join(dir, d.name)) : readFileSync(join(dir, d.name), "utf8")))
        .join("");
    expect(visit(c.manifest.root)).not.toContain(SECRET);
    expect(readFileSync(join(c.agent, stored ? "auth.json" : "models.json"), "utf8")).toContain(SECRET); // real synthetic credential, not a vacuous stub
  },
  15000,
);
