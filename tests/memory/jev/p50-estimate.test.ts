import { expect, it } from "vitest";
import { payloadTemplateHash } from "../../../scripts/dev/p50-closure-runtime.js";
import {
  estimatePayload,
  stockClassifyPayload,
  stockRevisionPayload,
  stockRevisionThinkingDisabled,
  stockRevisionPayloadSupported,
  STOCK_ESTIMATE_PROFILE,
} from "../../../src/memory/jev/p50-estimate.js";
it.each(["ASCII", "中文模板", "😀🚀", '\\"\n\t', "正文".repeat(1000)])("full JSON UTF8 local estimate %s", (text) => {
  const p = { model: "stock", messages: [{ role: "user", content: text }] };
  expect(estimatePayload(p)).toBe(2 * Math.ceil(Buffer.byteLength(JSON.stringify(p)) / 3) + 256);
  expect(estimatePayload({ ...p, extra: text + text })).toBeGreaterThan(estimatePayload(p)!);
});
it("bounded serializer refuses accessors/toJSON/cycles/oversize rather than invoking or truncating", () => {
  let invoked = 0;
  const getter = {
    get payload() {
      invoked++;
      return "secret";
    },
  };
  expect(estimatePayload(getter)).toBeUndefined();
  expect(
    estimatePayload({
      toJSON() {
        invoked++;
        return {};
      },
    }),
  ).toBeUndefined();
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(estimatePayload(cycle)).toBeUndefined();
  expect(estimatePayload({ body: "a".repeat(131073) })).toBeUndefined();
  expect(invoked).toBe(0);
});
it("versioned templates map bool to noul, include whole framing and reject unsupported fields", () => {
  const p = stockClassifyPayload("r", {
    state: { body: "中文" },
    questions: { q: { type: "bool", instructions: "Answer", criteria: { true: "yes", false: "no" } } },
  });
  expect(p).toMatchObject({ model: "r", questions: { q: { type: "noul" } } });
  expect(p).not.toHaveProperty("max_output_tokens");
  const chat = stockRevisionPayload(
    "g",
    { systemPrompt: "system", messages: [{ role: "user", content: "body", timestamp: 1 }] },
    384,
  );
  expect(chat).toMatchObject({
    model: "g",
    max_tokens: 384,
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "body" },
    ],
  });
  expect(stockRevisionPayloadSupported(chat)).toBe(true);
  expect(stockRevisionPayloadSupported({ ...chat, tools: [] })).toBe(false);
  expect(STOCK_ESTIMATE_PROFILE).toMatchObject({
    serverEnforced: false,
    identityEvidence: "unknown",
    billingStatus: "UNKNOWN",
  });
});

it("DeepSeek thinking-off is exact, included in the semantic template/hash and quote, never enables reasoning", () => {
  const context = { systemPrompt: "system", messages: [{ role: "user" as const, content: "body", timestamp: 1 }] };
  const native = {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    compat: { thinkingFormat: "deepseek" },
  };
  expect(stockRevisionThinkingDisabled(native)).toBe(true);
  const plain = stockRevisionPayload("g", context, 384);
  const off = stockRevisionPayload("g", context, 384, stockRevisionThinkingDisabled(native));
  expect(off.thinking).toEqual({ type: "disabled" });
  expect(stockRevisionPayloadSupported(off)).toBe(true);
  expect(estimatePayload(off)).toBeGreaterThan(estimatePayload(plain)!);
  expect(payloadTemplateHash(off)).not.toBe(payloadTemplateHash(plain));
  expect(stockRevisionThinkingDisabled({ ...native, reasoning: false })).toBe(false);
  expect(stockRevisionThinkingDisabled({ ...native, thinkingLevelMap: { off: null } })).toBe(false);
  expect(stockRevisionThinkingDisabled({ ...native, compat: { thinkingFormat: "qwen" } })).toBe(false);
  expect(stockRevisionThinkingDisabled({ provider: "other", reasoning: true })).toBe(false);
  let invoked = 0;
  expect(
    stockRevisionThinkingDisabled({
      get reasoning() {
        invoked++;
        return true;
      },
    }),
  ).toBe(false);
  expect(invoked).toBe(0);
});
it.each([
  { type: "enabled" },
  { type: "disabled", extra: true },
  { type: "disabled", budget_tokens: 1 },
  {},
  null,
  "disabled",
  { enable: false },
])("stock framing rejects unsupported thinking %j", (thinking) => {
  const payload = stockRevisionPayload("g", { systemPrompt: "s", messages: [] }, 384);
  expect(stockRevisionPayloadSupported({ ...payload, thinking })).toBe(false);
});
