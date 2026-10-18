// Writes a synthetic pi session (no real data) for the TUI screenshot.
import { writeFileSync } from "node:fs";
const cwd = process.env.CWD;
const OUT_FILE = process.env.OUT_FILE;
const T = Date.parse("2026-10-18T09:12:00Z");
let n = 0,
  parent = null;
const L = [];
const iso = (ms) => new Date(T + ms).toISOString();
const add = (o, ms) => {
  const id = `d${(++n).toString(16).padStart(7, "0")}`;
  L.push({ ...o, id, parentId: parent, timestamp: iso(ms) });
  parent = id;
  return id;
};
L.push({ type: "session", version: 3, id: "0192f3a1-aaaa-7d2e-9a41-5c8e1f0b6a11", timestamp: iso(0), cwd });
add({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-5-5" }, 10);
add({ type: "thinking_level_change", thinkingLevel: "medium" }, 20);
const usage = (i, o, cr) => ({
  input: i,
  output: o,
  cacheRead: cr,
  cacheWrite: 0,
  totalTokens: i + o + cr,
  cost: {
    input: i * 3e-6,
    output: o * 15e-6,
    cacheRead: cr * 3e-7,
    cacheWrite: 0,
    total: i * 3e-6 + o * 15e-6 + cr * 3e-7,
  },
});
const asst = (content, ms, u) =>
  add(
    {
      type: "message",
      message: {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        usage: u,
        stopReason: "stop",
        timestamp: T + ms,
      },
    },
    ms,
  );
add(
  {
    type: "message",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Order placement is tightly coupled to payment. Split it up and add unit tests." },
      ],
      timestamp: T + 1000,
    },
  },
  1000,
);
asst(
  [
    { type: "text", text: "First, let me read `OrderService` and find every `charge()` call site." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/orders/order-service.ts" } },
  ],
  4000,
  usage(21000, 1300, 0),
);
add(
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [
        {
          type: "text",
          text: "export class OrderService {\n  async placeOrder(cart: Cart) {\n    const total = this.price(cart);\n    await this.gateway.charge(total);\n    return this.db.insert(cart, total);\n  }\n}",
        },
      ],
      isError: false,
      timestamp: T + 5000,
    },
  },
  5000,
);
asst(
  [
    {
      type: "text",
      text: "Pricing, charging and persistence are tangled in one method. Plan:\n\n- split into `priceCart`, `authorize` (behind a `PaymentPort`) and `commitOrder`\n- dispatch subagents in parallel: unit tests, regression checks, stale-docs sweep\n\nAll three are running in the background — progress is in the agent tree below; I'll be notified on completion.",
    },
  ],
  12000,
  usage(2500, 900, 142000),
);
writeFileSync(OUT_FILE, L.map((x) => JSON.stringify(x)).join("\n") + "\n");
