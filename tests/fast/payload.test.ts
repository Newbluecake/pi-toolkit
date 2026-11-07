import { describe, expect, it } from "vitest";
import { classifyResponsesPayload, rewriteFastPayload } from "../../src/fast/payload.js";
const body = (extra: object = {}): Record<string, unknown> => ({
  model: "any-deployment",
  input: [],
  stream: true,
  store: false,
  ...extra,
});
const snap = (mode: "on" | "off" | "inherit") => ({ mode, revision: 1, incarnation: {} });
const shape = (p: unknown) => expect(classifyResponsesPayload(p).kind).toBe("responses");
describe("strict Responses payload", () => {
  it("inherit does not inspect, clone, or remove original tier", () => {
    const p = new Proxy(
      {},
      {
        get() {
          throw Error("read");
        },
        ownKeys() {
          throw Error("enumerate");
        },
        getPrototypeOf() {
          throw Error("prototype");
        },
      },
    );
    expect(rewriteFastPayload(p, snap("inherit"))).toBeUndefined();
  });
  it("applies only shallow tier replacement, preserves sampling/reasoning and frozen originals", () => {
    const reasoning = Object.freeze({ effort: "xhigh" });
    const input = Object.freeze([]);
    const original = Object.freeze(body({ reasoning, input, service_tier: "flex", store: true }));
    for (const [mode, tier] of [
      ["on", "priority"],
      ["off", "default"],
    ] as const) {
      const r = rewriteFastPayload(original, snap(mode));
      expect(r?.kind).toBe("applied");
      if (r?.kind !== "applied") throw Error("not applied");
      expect(r.replacement).not.toBe(original);
      expect(r.replacement).toEqual({ ...original, service_tier: tier });
      expect(r.replacement.input).toBe(input);
      expect(r.replacement.reasoning).toBe(reasoning);
    }
    expect(original.service_tier).toBe("flex");
  });
  it("delivered body retains callback snapshot across changes and retries", () => {
    const state = snap("on");
    const p = body();
    const first = rewriteFastPayload(p, state);
    state.mode = "off";
    const second = rewriteFastPayload(p, state);
    expect(first?.kind === "applied" && first.replacement.service_tier).toBe("priority");
    expect(second?.kind === "applied" && second.replacement.service_tier).toBe("default");
    expect(p).not.toHaveProperty("service_tier");
  });
  it.each([null, [], {}, { input: [] }, { messages: [] }])("other/unknown cannot inject %s", (p) => {
    expect(rewriteFastPayload(p, snap("on"))?.kind).not.toBe("applied");
  });
  it.each([
    { messages: undefined },
    { contents: [] },
    { prompt: "x" },
    { system: undefined },
    { generationConfig: {} },
    { generation_config: {} },
    { inferenceConfig: {} },
    { anthropic_version: "x" },
    { unknown: 1 },
    { background: true },
    { stream: false },
    { store: "false" },
    { model: " " },
    { input: "text" },
    { temperature: NaN },
    { top_p: Infinity },
    { max_output_tokens: 0 },
    { tools: [{ type: "function", function: { name: "x" } }] },
    { tool_choice: { type: "function", function: { name: "x" } } },
    { input: [{ type: "unknown" }] },
    { input: [{ role: "tool", content: "x" }] },
    { input: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] },
    { input: [{ type: "function_call", call_id: "x", name: "x", arguments: {} }] },
    { input: [{ type: "reasoning", summary: [{ type: "summary_text", text: 2 }] }] },
    { input: [{ type: "configuration_update", reasoning: { effort: 3 } }] },
  ])("rejects malformed/mixed %s without original payload in diagnostics", (extra) => {
    const p = body(extra);
    const result = rewriteFastPayload(p, snap("on"));
    expect(result?.kind).toBe("unsupported");
    expect(Object.keys(result!)).toEqual(["kind", "reason"]);
    expect(p).toEqual(body(extra));
  });
  it("rejects accessors/prototype pollution without execution", () => {
    let calls = 0;
    const evil = Object.defineProperty(body(), "model", {
      get() {
        calls++;
        return "x";
      },
    });
    expect(classifyResponsesPayload(evil)).toEqual({ kind: "unsupported", reason: "unsafe-object" });
    expect(classifyResponsesPayload(Object.assign(Object.create({ model: "x" }), body()))).toEqual({
      kind: "unsupported",
      reason: "unsafe-object",
    });
    const input = Object.defineProperty([], "0", {
      get() {
        calls++;
        return {};
      },
    });
    input.length = 1;
    expect(classifyResponsesPayload(body({ input })).kind).toBe("unsupported");
    expect(calls).toBe(0);
  });
  it("covers all known item/tool variants including native-warm empty input", () => {
    const tools = [
      { type: "function", name: "f", parameters: { type: "object" }, strict: null },
      {
        type: "custom",
        name: "g",
        format: { type: "grammar", syntax: "lark", definition: "start: /a/" },
        defer_loading: true,
      },
    ];
    const input = [
      { role: "developer", content: "system" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
        id: "msg",
        status: "completed",
        phase: "final_answer",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
        ],
      },
      { type: "function_call", call_id: "c", name: "f", arguments: "{}", namespace: "n" },
      { type: "custom_tool_call", call_id: "c", name: "g", input: "a" },
      ...["function_call_output", "custom_tool_call_output"].map((type) => ({
        type,
        call_id: "c",
        output: [{ type: "input_text", text: "x" }],
      })),
      { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "h" }], encrypted_content: null },
      { type: "additional_tools", role: "developer", tools },
      { type: "configuration_update", reasoning: { effort: "xhigh" } },
      { type: "tool_search_call", call_id: "s", execution: "client", arguments: { query: "f", limit: 1 } },
      { type: "tool_search_output", call_id: "s", execution: "client", tools },
    ];
    shape(body({ input, tools, tool_choice: { type: "custom", name: "g" } }));
    shape(body());
  });
});
it("validates every optional root field and preserves all legal roots by shallow reference", () => {
  const extra = {
    instructions: "local",
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "max" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
    max_output_tokens: 256,
    temperature: 0,
    top_p: 0.8,
    service_tier: null,
    prompt_cache_key: "local",
    prompt_cache_retention: "24h",
    prompt_cache_options: { mode: "explicit" },
    metadata: { local: "value" },
    user: "local",
    safety_identifier: "local",
    truncation: "auto",
    max_tool_calls: 3,
    previous_response_id: "resp",
    conversation: { id: "conv" },
    background: false,
    stream_options: { include_usage: true },
  };
  expect(classifyResponsesPayload(body(extra)).kind).toBe("responses");
  for (const key of Object.keys(extra)) {
    const bad = { ...extra, [key]: Symbol("invalid") };
    expect(classifyResponsesPayload(body(bad)).kind, key).toBe("unsupported");
  }
  const r = rewriteFastPayload(body(extra), snap("on"));
  if (r?.kind !== "applied") throw Error("expected applied");
  for (const [k, v] of Object.entries(extra)) if (k !== "service_tier") expect(r.replacement[k], k).toBe(v);
});
it("nested accessors never run; schema descendants remain opaque", () => {
  let reads = 0;
  const tool = Object.defineProperty({ type: "function", name: "f", parameters: {} }, "strict", {
    get() {
      reads++;
      return true;
    },
    enumerable: true,
  });
  const p = body({ tools: [tool] });
  expect(classifyResponsesPayload(p).kind).toBe("unsupported");
  expect(reads).toBe(0);
  const schema = Object.defineProperty({ type: "object" }, "properties", {
    get() {
      throw Error("opaque schema must not be traversed");
    },
    enumerable: true,
  });
  expect(classifyResponsesPayload(body({ tools: [{ type: "function", name: "f", parameters: schema }] })).kind).toBe(
    "responses",
  );
});
it("seeded rewrite invariants preserve inherited bytes and callback-delivered bodies", async () => {
  const fc = await import("fast-check");
  fc.assert(
    fc.property(fc.string(), fc.string(), (model, effort) => {
      const original = Object.freeze(
        body({ model: `m-${model}`, reasoning: Object.freeze({ effort }), service_tier: "flex" }),
      );
      const bytes = JSON.stringify(original);
      const state = snap("on");
      const delivered = rewriteFastPayload(original, state);
      state.mode = "off";
      const next = rewriteFastPayload(original, state);
      expect(delivered?.kind === "applied" && delivered.replacement.service_tier).toBe("priority");
      expect(next?.kind === "applied" && next.replacement.service_tier).toBe("default");
      expect(rewriteFastPayload(original, snap("inherit"))).toBeUndefined();
      expect(JSON.stringify(original)).toBe(bytes);
    }),
    { seed: 5502, numRuns: 100 },
  );
});

it.each([undefined, null, "opaque"])(
  "preserves opaque reasoning replay content with encrypted_content=%s",
  (encrypted) => {
    let reads = 0;
    const part = Object.defineProperty({ type: "reasoning_text" }, "text", {
      enumerable: true,
      get() {
        reads++;
        throw Error("opaque");
      },
    });
    const content = Object.freeze([part]);
    const reasoning = Object.freeze({
      type: "reasoning",
      summary: [],
      content,
      status: null,
      ...(encrypted === undefined ? {} : { encrypted_content: encrypted }),
    });
    const input = Object.freeze([reasoning]);
    const p = Object.freeze(body({ input, reasoning: { effort: "high" }, service_tier: "flex" }));
    for (const mode of ["on", "off"] as const) {
      const r = rewriteFastPayload(p, snap(mode));
      expect(r?.kind).toBe("applied");
      if (r?.kind !== "applied") throw Error("expected applied");
      expect(r.replacement.input).toBe(input);
      expect((r.replacement.input as typeof input)[0]).toBe(reasoning);
      expect(reasoning.content).toBe(content);
      expect(r.replacement.reasoning).toBe(p.reasoning);
      expect(r.replacement.service_tier).toBe(mode === "on" ? "priority" : "default");
    }
    expect(rewriteFastPayload(p, snap("inherit"))).toBeUndefined();
    expect(reads).toBe(0);
    expect(p.service_tier).toBe("flex");
  },
);
it.each([{ content: "invalid" }, { content: null }, { unknown: true }, { messages: [] }, { status: 1 }])(
  "rejects illegal reasoning replay fields %s",
  (extra) => {
    expect(
      classifyResponsesPayload(
        body({ input: [{ type: "reasoning", summary: [], content: [], status: null, ...extra }] }),
      ),
    ).toEqual({ kind: "unsupported", reason: "invalid-input" });
  },
);
it("does not extend nullable status to other items", () => {
  expect(
    classifyResponsesPayload(
      body({ input: [{ type: "message", role: "assistant", content: "fixture", status: null }] }),
    ).kind,
  ).toBe("unsupported");
});
