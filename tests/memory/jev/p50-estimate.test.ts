import { expect, it } from "vitest";
import {
  estimatePayload,
  stockClassifyPayload,
  stockRevisionPayload,
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
