// sysprompt-stable plan v3.1 §4.4 / §7.3: the pure wake-replay core. The
// golden-shape assertions mirror pi 0.87.1's forced-prompt projection
// (agent-session.js `_installAgentForcedPromptProjection`) field by field;
// pi-ai's real `getCurrentSystemMessage` is exercised in hub.test.ts
// (production path, M2's hub owns the wiring S1 used to own) while these
// tests use a small faithful fake for full control over "helper returns
// undefined / no toolsAdded" branches.

import { describe, expect, test } from "vitest";
import {
  buildReplayMessages,
  createWakeReplay,
  type GetCurrentSystemMessage,
  type MessageLike,
} from "../../src/sysprompt/wake-replay.js";

/** Faithful minimal stand-in for pi-ai getCurrentSystemMessage: first system
 *  timestamp, tools resolved from toolsAdded arrays in order. */
const fakeGetCurrent: GetCurrentSystemMessage = (messages) => {
  let timestamp: number | undefined;
  const tools: unknown[] = [];
  let sawSystem = false;
  for (const message of messages) {
    if (message.role !== "system") continue;
    sawSystem = true;
    timestamp ??= typeof message.timestamp === "number" ? message.timestamp : undefined;
    if (Array.isArray(message.toolsAdded)) tools.push(...message.toolsAdded);
  }
  if (!sawSystem && tools.length === 0) return undefined;
  return {
    ...(tools.length > 0 ? { toolsAdded: tools } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
};

const FIXED_NOW = 1_700_000_123_456;

describe("buildReplayMessages (projection shape, I8)", () => {
  const system: MessageLike = {
    role: "system",
    content: "base-preamble",
    timestamp: 111,
    toolsAdded: [{ name: "bash" }, { name: "Agent" }],
  };
  const system2: MessageLike = {
    role: "system",
    content: "mid-conversation system message that must be dropped",
    timestamp: 222,
  };
  const user: MessageLike = { role: "user", content: "hi" };
  const assistant: MessageLike = { role: "assistant", content: "yo" };

  test("golden: forced head + non-system passthrough, other system messages dropped", () => {
    const forced = "base-preamble\n\n## Memory (slug) — 2 file(s)\n<block>";
    const out = buildReplayMessages([system, user, assistant, system2], forced, fakeGetCurrent);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      role: "system",
      content: forced,
      toolsAdded: [{ name: "bash" }, { name: "Agent" }],
      timestamp: 111, // preserved from the first system message
    });
    // non-system entries pass through as the SAME references (pi's projection is shallow)
    expect(out[1]).toBe(user);
    expect(out[2]).toBe(assistant);
  });

  test("no system message at all ⇒ no toolsAdded key, timestamp from now()", () => {
    const out = buildReplayMessages([user, assistant], "forced", fakeGetCurrent, () => FIXED_NOW);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "system", content: "forced", timestamp: FIXED_NOW });
    expect(Object.hasOwn(out[0] as object, "toolsAdded")).toBe(false);
    expect(out[1]).toBe(user);
    expect(out[2]).toBe(assistant);
  });

  test("system present but without toolsAdded/timestamp ⇒ head copies nothing but keeps now() timestamp", () => {
    const bare: MessageLike = { role: "system", content: "base" };
    const out = buildReplayMessages([bare, user], "forced", fakeGetCurrent, () => FIXED_NOW);
    expect(out[0]).toEqual({ role: "system", content: "forced", timestamp: FIXED_NOW });
    expect(Object.hasOwn(out[0] as object, "toolsAdded")).toBe(false);
  });

  test("idempotent: applying it to its own output reproduces the same head (review-3 conclusion 1)", () => {
    const forced = "base\n\n## Available subagent types (pi-subagent)";
    const once = buildReplayMessages([system, user, system2], forced, fakeGetCurrent, () => FIXED_NOW);
    const twice = buildReplayMessages(once, forced, fakeGetCurrent, () => FIXED_NOW + 999);
    expect(twice).toEqual(once); // second now() must not be consulted: timestamp comes from `current`
  });

  test("does not mutate the input array or its entries", () => {
    const input = [system, user, assistant, system2];
    const snapshot = structuredClone(input);
    buildReplayMessages(input, "forced", fakeGetCurrent, () => FIXED_NOW);
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(system); // no entry reordering/replacement either
  });
});

describe("createWakeReplay (single-state cell, review-2 #5)", () => {
  test("fresh cell: nothing captured, apply is a no-op", () => {
    const replay = createWakeReplay({ getCurrentSystemMessage: fakeGetCurrent });
    expect(replay.captured()).toBeUndefined();
    expect(replay.apply([{ role: "user", content: "hi" }])).toBeUndefined();
  });

  test("capture → apply replays exactly the captured bytes; capture(undefined) clears", () => {
    const replay = createWakeReplay({ getCurrentSystemMessage: fakeGetCurrent });
    const captured = "base\n\n## Memory (s) — 1 file(s)";
    replay.capture(captured);
    expect(replay.captured()).toBe(captured);
    const messages: MessageLike[] = [{ role: "system", content: "base", timestamp: 5 }];
    const out = replay.apply(messages);
    expect(out?.[0]).toEqual({ role: "system", content: captured, timestamp: 5 });
    replay.capture(undefined);
    expect(replay.captured()).toBeUndefined();
    expect(replay.apply(messages)).toBeUndefined();
  });

  test("reset() clears the capture", () => {
    const replay = createWakeReplay({ getCurrentSystemMessage: fakeGetCurrent });
    replay.capture("x");
    replay.reset();
    expect(replay.captured()).toBeUndefined();
  });

  test("helpers unavailable ⇒ apply never replays (§4.8: no helper ⇒ no replay)", () => {
    const replay = createWakeReplay({ getCurrentSystemMessage: undefined });
    replay.capture("captured");
    expect(replay.captured()).toBe("captured");
    expect(replay.apply([{ role: "user", content: "hi" }])).toBeUndefined();
  });
});
