import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader, SettingsManager, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import { normalizeContext, toToolDeclaration, validateToolArguments, type Model } from "@earendil-works/pi-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { getJsonSchemaToolParameters } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createScheduleTool } from "../../src/tools/schedule-tool.js";
import { a3Env, type A3Env } from "../schedule/agent/a3-helpers.js";
import { readOk } from "../schedule/core/fixtures.js";

// A fresh, real SDK registry (not a hand-written registerTool mock), original-schema validation,
// SDK wrapper, production execute/ops/writer. FakeClock is never advanced and no executor is attached.
// All stores/resources are temporary; no provider, credentials or actual scheduled dispatch is used.
let env: A3Env;
afterEach(() => env?.cleanup());

async function registered() {
  env = a3Env();
  const source = createScheduleTool({ agent: () => env.agent, ports: () => env.ports, now: () => env.fake.now() });
  const loader = new DefaultResourceLoader({
    cwd: env.dir,
    agentDir: env.dir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerTool(source)],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  const registration = loaded.extensions[0]!.tools.get("schedule")!;
  expect(registration.definition).toBe(source);
  expect(registration.definition.parameters.required).toEqual(["action"]);
  const tool = wrapRegisteredTool(registration, { createToolContext: () => ({}) } as never);
  expect(tool.parameters).toBe(source.parameters);
  const execute = vi.spyOn(source, "execute");
  async function call(input: Record<string, unknown>) {
    const args = validateToolArguments(tool, {
      type: "toolCall",
      name: "schedule",
      id: "sdk-schedule-id",
      arguments: input,
    });
    const result = await tool.execute("sdk-schedule-id", args, undefined, undefined);
    return {
      args: args as Record<string, unknown>,
      text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
      details: result.details as Record<string, unknown>,
    };
  }
  return { source, tool, execute, call };
}

const MINIMAL = {
  action: "create",
  name: "safe dummy",
  form: "message",
  every: "20m",
  prompt: "Safe dummy prompt; never dispatched.",
  feishu: false,
};
const USER_SHAPE = {
  action: "create",
  agentType: "general-purpose",
  at: "",
  cron: "",
  every: "20m",
  feishu: false,
  form: "message",
  handoff: false,
  id: "",
  isolation: "none",
  model: "",
  name: "主会话调度规则与TODO巡检",
  prompt: "安全复现占位提示。".repeat(100),
  thinking: "low",
  timeoutS: 1800,
  tz: "",
};
const BG_FIELDS = ["agentType", "model", "thinking", "timeoutS", "handoff", "isolation"] as const;

function bytes(): Buffer {
  const store = env.agent.store()!;
  return readFileSync(join(store.root.real, store.dirName, "state.json"));
}

describe("schedule #83 — fresh SDK registration → validation → execute", () => {
  it("fresh SDK jiti loading of the actual source preserves Optional across the host TypeBox alias", async () => {
    env = a3Env();
    const path = join(env.ports.ownerCwd(), "schema-probe-extension.ts");
    // Pi source installations use jiti with @sinclair/typebox aliased to the host's typebox.
    // Import the real source through that loader too, not only through Vitest's module loader.
    writeFileSync(
      path,
      `import { createScheduleTool } from ${JSON.stringify(resolve("src/tools/schedule-tool.ts"))};
export default function(pi) {
  pi.registerTool(createScheduleTool({agent: () => undefined, ports: () => { throw new Error("schema probe has no store"); }}));
}\n`,
    );
    const loader = new DefaultResourceLoader({
      cwd: env.ports.ownerCwd(),
      agentDir: env.ports.ownerCwd(),
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [path],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const t = loaded.extensions
      .flatMap((e) => [...e.tools.values()])
      .find((t) => t.definition.name === "schedule")!.definition;
    expect(t.parameters.required).toEqual(["action"]);
    expect(JSON.parse(JSON.stringify(t.parameters))).toEqual(
      JSON.parse(JSON.stringify(createScheduleTool({ agent: () => env.agent, ports: () => env.ports }).parameters)),
    );
    const validated = validateToolArguments(t, {
      type: "toolCall",
      name: "schedule",
      id: "jiti-schema",
      arguments: { ...MINIMAL, id: null },
    });
    expect(validated).toEqual(MINIMAL);
    expect(env.agent.store()).toBeUndefined();
  });

  it.each([undefined, "", null])(
    "create id=%j assigns an id (only the empty id placeholder is normalized)",
    async (id) => {
      const h = await registered();
      const input = { ...MINIMAL, ...(id === undefined ? {} : { id }) };
      const r = await h.call(input);
      expect(r.args).toEqual({ ...MINIMAL, ...(id === "" ? { id: "" } : {}) });
      expect(input).toEqual({ ...MINIMAL, ...(id === undefined ? {} : { id }) });
      expect(h.execute).toHaveBeenCalledWith("sdk-schedule-id", r.args, undefined, undefined, {});
      expect(r.details).toEqual({ ok: true, id: expect.stringMatching(/^s_[a-z2-7]{8}$/) });
      const state = readOk(env.agent.store()!);
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0]).toMatchObject({ id: r.details.id, form: "message", feishu: false });
      expect(state.tasks[0]!.when).toEqual({ kind: "every", everyMs: 1_200_000, anchorAt: env.fake.now() });
      expect(state.tasks[0]).not.toHaveProperty("bg");
      expect(state.runs).toEqual([]);
    },
  );

  it.each(["s_aaaaaaaa", " ", "not-an-id"])("create nonempty id=%j is still forbidden before store IO", async (id) => {
    const h = await registered();
    const r = await h.call({ ...MINIMAL, id });
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).toContain("`id` cannot be set through this tool (ids are assigned)");
    expect(r.text).toContain("Omit id on create");
    expect(r.text).toContain('"action":"create"');
    expect(env.agent.store()).toBeUndefined();
    expect(existsSync(env.dir)).toBe(false);
  });

  it("exact user shape with dummy prompt exposes each remaining validation layer without swallowing placeholders", async () => {
    const h = await registered();
    const ensure = vi.spyOn(env.agent, "ensureStore");
    const unchanged = structuredClone(USER_SHAPE);
    const r = await h.call(USER_SHAPE);
    expect(r.args).toEqual(USER_SHAPE); // SDK does NOT remove empty strings/default/false values.
    expect(USER_SHAPE).toEqual(unchanged);
    expect(r.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(r.text).not.toContain("ids are assigned");
    expect(r.text).toContain("give exactly one of cron, at, every");
    expect(r.text).toContain("cron: string(empty");
    expect(r.text).toContain("at: string(empty");
    expect(r.text).toContain("tz: string(empty");
    expect(r.text).toContain("For form=message omit agentType/model/thinking/timeoutS/handoff/isolation");

    const { at: _at, cron: _cron, ...onlyEvery } = USER_SHAPE;
    const tzError = await h.call(onlyEvery);
    expect(tzError.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(tzError.text).toContain("every uses elapsed UTC time; remove tz");
    const { tz: _tz, ...noTz } = onlyEvery;
    const bgError = await h.call(noTz);
    expect(bgError.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(bgError.text).toContain("bg options only apply to background tasks");
    for (const key of BG_FIELDS) {
      const isolated = await h.call({ ...MINIMAL, id: "", [key]: USER_SHAPE[key] });
      expect(isolated.details).toEqual({ ok: false, code: "E_INVALID" });
      expect(isolated.text).toContain("bg options only apply to background tasks");
    }
    expect(ensure).not.toHaveBeenCalled();
    expect(existsSync(env.dir)).toBe(false);
    const match = r.text.match(/\{"action":"create"[^\n]+?\}/);
    expect(match).not.toBeNull();
    const example = JSON.parse(match![0]) as Record<string, unknown>;
    expect(example).toEqual({ ...MINIMAL, name: "message", prompt: "<完整提示>" });
    const fixed = await h.call(example);
    expect(fixed.details.ok).toBe(true);
    expect(readOk(env.agent.store()!).tasks).toHaveLength(1);
    expect(readOk(env.agent.store()!).runs).toEqual([]);
  });

  it("strict SDK response conversion preserves nullable slots; original-schema validation removes only nulls", async () => {
    const h = await registered();
    const original = JSON.stringify(h.tool.parameters);
    const ordinary = convertResponsesTools([h.tool], { strict: false })[0]!;
    const strict = convertResponsesTools([h.tool], { strict: true })[0]!;
    if (ordinary.type !== "function" || strict.type !== "function") throw new Error("expected JSON function tools");
    expect(ordinary.parameters.required).toEqual(["action"]);
    expect(strict.parameters).toEqual(getJsonSchemaToolParameters(h.tool, true));
    expect(strict.strict).toBe(true);
    expect(strict.parameters.required).toEqual(Object.keys(h.source.parameters.properties));
    const properties = strict.parameters.properties as Record<string, { anyOf?: unknown[] }>;
    for (const key of Object.keys(h.source.parameters.properties).filter((k) => k !== "action")) {
      expect(properties[key]!.anyOf).toContainEqual({ type: "null" });
    }
    expect(JSON.stringify(h.tool.parameters)).toBe(original);
    const strictCall = {
      ...Object.fromEntries(Object.keys(properties).map((key) => [key, null])),
      ...MINIMAL,
    };
    const r = await h.call(strictCall);
    expect(r.args).toEqual(MINIMAL);
    expect(strictCall.id).toBeNull();
    expect(r.details.ok).toBe(true);
    expect(readOk(env.agent.store()!).runs).toEqual([]);
  });

  it("SDK HTTP-boundary outbound schema is optional by default and required+nullable in explicit strict control", async () => {
    const h = await registered();
    const original = JSON.stringify(h.source.parameters);
    const declaration = toToolDeclaration(h.tool);
    expect(declaration.parameters).toEqual(JSON.parse(original)); // Actual TypeBox → JSON round-trip.
    expect(declaration.parameters.required).toEqual(["action"]);
    expect(h.source.constrainedSampling).toBeUndefined();
    const model: Model<"openai-responses"> = {
      id: "schema-probe",
      name: "schema-probe",
      provider: "schema-probe",
      api: "openai-responses",
      baseUrl: "https://schema-probe.invalid/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 4096,
      maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStrictMode: true },
    };
    for (const strict of [false, true]) {
      const transmitted = strict
        ? { ...h.tool, constrainedSampling: { type: "json_schema" as const, strict: "require" as const } }
        : h.tool;
      let payload: Record<string, unknown> | undefined;
      let requests = 0;
      const response = streamResponses(
        model,
        normalizeContext({
          messages: [{ role: "user", content: "Safe schema probe", timestamp: 0 }],
          tools: [transmitted],
        }),
        {
          apiKey: "dummy-schema-probe-not-a-credential",
          maxRetries: 0,
          fetch: async (_url, init) => {
            requests++;
            expect(typeof init?.body).toBe("string");
            payload = JSON.parse(init!.body as string) as Record<string, unknown>;
            return new Response(
              `data: ${JSON.stringify({ type: "response.completed", response: { id: "schema-only", status: "completed", output: [] } })}\n\n`,
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          },
        },
      );
      const result = await response.result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toBe(1); // Only the injected in-memory fetch; never global fetch/network.
      const tools = payload!.tools as Array<{
        name: string;
        strict: boolean;
        parameters: { required: string[]; properties: Record<string, { anyOf?: unknown[] }> };
      }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("schedule");
      expect(tools[0]!.strict).toBe(strict);
      expect(tools[0]!.parameters.required).toEqual(strict ? Object.keys(h.source.parameters.properties) : ["action"]);
      if (strict) {
        for (const key of Object.keys(h.source.parameters.properties).filter((k) => k !== "action")) {
          expect(tools[0]!.parameters.properties[key]!.anyOf).toContainEqual({ type: "null" });
        }
      } else expect(tools[0]!.parameters).toEqual(JSON.parse(original));
    }
    expect(JSON.stringify(h.source.parameters)).toBe(original);
    expect(env.agent.store()).toBeUndefined();
  });

  it("background model empty-string is still an explicit clear; false and none are applied, not omitted", async () => {
    const h = await registered();
    const c = await h.call({
      ...MINIMAL,
      form: "background",
      feishu: true,
      agentType: "reviewer",
      model: "provider/model",
      thinking: "high",
      timeoutS: 600,
      handoff: true,
      isolation: "worktree",
    });
    expect(c.details.ok).toBe(true);
    const before = structuredClone(readOk(env.agent.store()!).tasks[0]!);
    const r = await h.call({
      action: "update",
      id: c.details.id,
      model: "",
      feishu: false,
      handoff: false,
      isolation: "none",
    });
    expect(r.details).toEqual({ ok: true, id: c.details.id });
    expect(r.args.model).toBe("");
    const { model: _model, isolation: _isolation, ...oldBg } = before.bg!;
    expect(readOk(env.agent.store()!).tasks[0]).toEqual({ ...before, feishu: false, bg: { ...oldBg, handoff: false } });
    const saved = bytes();
    const bad = await h.call({ action: "update", id: c.details.id, timeoutS: 0 });
    expect(bad.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(bytes()).toEqual(saved);
  });

  it("update uses its effective id as selector and preserves all omitted fields; empty/null id never becomes create", async () => {
    const h = await registered();
    const c = await h.call(MINIMAL);
    const before = structuredClone(readOk(env.agent.store()!).tasks[0]!);
    const r = await h.call({ action: "update", id: c.details.id, prompt: "Safe replacement" });
    expect(r.details).toEqual({ ok: true, id: c.details.id });
    expect(readOk(env.agent.store()!).tasks[0]).toEqual({ ...before, prompt: "Safe replacement" });
    const saved = bytes();
    for (const id of [undefined, "", null]) {
      const bad = await h.call({ action: "update", ...(id === undefined ? {} : { id }), prompt: "not applied" });
      expect(bad.details).toEqual({ ok: false, code: "E_INVALID" });
      expect(bad.text).toContain("`id` (s_xxxxxxxx) is required for update");
      expect(bad.text).toContain('{"action":"list"}');
      expect(bytes()).toEqual(saved);
    }
    for (const fields of [{ cron: "", at: "" }, { cron: "0 8 * * *", every: "20m" }, { tz: "" }]) {
      const bad = await h.call({ action: "update", id: c.details.id, prompt: "not applied", ...fields });
      expect(bad.details).toEqual({ ok: false, code: "E_INVALID" });
      expect(bytes()).toEqual(saved);
    }
    const forbidden = await h.call({ ...MINIMAL, id: "s_aaaaaaaa" });
    expect(forbidden.details).toEqual({ ok: false, code: "E_INVALID" });
    expect(bytes()).toEqual(saved);
    expect(readOk(env.agent.store()!).tasks).toHaveLength(1);
    expect(readOk(env.agent.store()!).runs).toEqual([]);
  });
});
