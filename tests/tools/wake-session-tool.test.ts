import { describe, expect, it, vi } from "vitest";
import { createWakeSessionTool, WakeSessionParams, wakeSessionHint } from "../../src/tools/wake-session-tool.js";
import type { XsActivationPort } from "../../src/fabric/xs/session-activation.js";

const run = (tool: ReturnType<typeof createWakeSessionTool>, params: object) =>
  tool.execute("tc", params as never, undefined as never, undefined as never, undefined as never);
const port = (): XsActivationPort & { activate: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } => ({
  activate: vi.fn(async (a: { messageId: string; activationKey: string }) => ({
    status: "accepted" as const,
    effect: "applied" as const,
    messageId: a.messageId,
    activationKey: a.activationKey,
    retryable: false,
  })),
  query: vi.fn(async (a: { messageId: string }) => ({ status: "unavailable" as const, messageId: a.messageId })),
});

describe("wake_session tool", () => {
  it("schema carries NO text/prompt/body parameter: only to/messageId/activationKey/action", () => {
    expect(Object.keys(WakeSessionParams.properties).sort()).toEqual(["action", "activationKey", "messageId", "to"]);
    expect(WakeSessionParams.required?.sort()).toEqual(["activationKey", "messageId", "to"]);
  });

  it("default action activates through the port with the original message + key (no extra args)", async () => {
    const p = port();
    const out = await run(createWakeSessionTool({ port: p }), { to: "s", messageId: "m", activationKey: "k" });
    expect(p.activate).toHaveBeenCalledWith({ to: "s", messageId: "m", activationKey: "k", action: "activate" });
    expect(p.query).not.toHaveBeenCalled();
    expect(out.details).toMatchObject({ status: "accepted" });
  });

  it('action:"query" is read-only — the activate port is never touched, a miss says so and never activates', async () => {
    const p = port();
    const out = await run(createWakeSessionTool({ port: p }), {
      to: "s",
      messageId: "m",
      activationKey: "k",
      action: "query",
    });
    expect(p.activate).not.toHaveBeenCalled();
    expect(p.query).toHaveBeenCalledWith({ messageId: "m", activationKey: "k" });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("查询不会触发任何激活");
  });

  it("unknown outcome hint fixes the model on query-only; refused names retryAfterAt; never advises resending", () => {
    expect(wakeSessionHint("unknown", "unknown")).toContain('action:"query"');
    expect(wakeSessionHint("unknown", "unknown")).toContain("不要再次 activate");
    const refused = wakeSessionHint("refused", "none", "pair_wake_rate", 1_700_000_000_000);
    expect(refused).toContain("pair_wake_rate");
    expect(refused).toContain("2023-");
    expect(refused).toContain("不要换 key");
    expect(wakeSessionHint("accepted", "applied")).toContain("不要重复激活");
  });
});
