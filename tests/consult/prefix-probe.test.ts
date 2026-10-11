import { describe, expect, it, vi } from "vitest";
import { comparePayloadPrefix } from "../../src/consult/preserve-identity.js";
import {
  compareRecordedPrefix,
  getPrefixProbeRegistry,
  installPrefixProbe,
  type PrefixRequestRecord,
} from "../../src/consult/prefix-probe.js";

function fakeSession(original?: (payload: unknown, model: unknown) => unknown) {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    agent: { onPayload: original },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event);
    },
  };
  return session;
}

async function capture(
  runId: string,
  payload: Record<string, unknown>,
  consult: boolean,
): Promise<PrefixRequestRecord> {
  const session = fakeSession();
  const cleanup = installPrefixProbe(session, { runId, ...(consult ? { consultGuard: {} } : {}) });
  await (session.agent.onPayload as (payload: unknown, model: unknown) => Promise<unknown>)(payload, {
    api: "anthropic-messages",
    provider: "test",
    id: "model",
  });
  session.emit({ type: "agent_settled" });
  const record = getPrefixProbeRegistry().get(runId);
  cleanup();
  if (!record?.latest) throw new Error("probe did not capture a request");
  return consult ? record.requests?.[0]! : record.latest;
}

describe("consult prefix probe", () => {
  it("matches comparePayloadPrefix for a corpus of raw payload pairs", async () => {
    const base: Record<string, unknown> = {
      model: "model",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
      ],
      max_tokens: 200,
      stream: true,
      betas: ["prompt-caching-2024-07-31"],
      system: [{ type: "text", text: "system" }],
      temperature: 0.2,
      tools: [{ name: "read", description: "read" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { format: "text" },
      metadata: { user_id: "u" },
      tool_choice: { type: "auto" },
      fallbacks: [{ model: "backup" }],
    };
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [base, { ...base, messages: [...(base.messages as unknown[]), { role: "assistant", content: "new" }] }],
      [base, { ...base, tools: [{ name: "write", description: "write" }] }],
      [base, { ...base, temperature: 0.8 }],
      [base, { ...base, messages: [{ role: "user", content: [{ type: "text", text: "changed" }] }] }],
      [
        base,
        {
          ...base,
          messages: [
            {
              role: "user",
              content: [{ type: "text", cache_control: { type: "ephemeral", ttl: "1h" }, text: "hello" }],
            },
          ],
        },
      ],
      [
        base,
        {
          ...base,
          messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            {
              role: "user",
              content: [{ type: "text", cache_control: { type: "ephemeral", ttl: "5m" }, text: "later" }],
            },
          ],
        },
      ],
      [
        base,
        {
          ...base,
          messages: [
            {
              role: "user",
              content: [{ type: "text", cache_control: { type: "ephemeral", ttl: "5m" }, text: "hello" }],
            },
            {
              role: "user",
              content: [{ type: "text", cache_control: { type: "ephemeral", ttl: "5m" }, text: "later" }],
            },
          ],
        },
      ],
    ];

    for (const [index, [expert, consult]] of pairs.entries()) {
      const expertRecord = await capture(`corpus-expert-${index}`, expert, false);
      const consultRecord = await capture(`corpus-consult-${index}`, consult, true);
      expect(compareRecordedPrefix(expertRecord, consultRecord)).toEqual(comparePayloadPrefix(expert, consult));
    }
  });

  it("stores every consult request but only first/latest for ordinary runs", async () => {
    const ordinary = fakeSession();
    const ordinaryCleanup = installPrefixProbe(ordinary, { runId: "ordinary-prefix" });
    const ordinaryPayload = { model: "m", messages: [{ role: "user", content: "ordinary" }] };
    await (ordinary.agent.onPayload as Function)(ordinaryPayload, { api: "a", provider: "p", id: "m" });
    await (ordinary.agent.onPayload as Function)(
      { ...ordinaryPayload, max_tokens: 1 },
      { api: "a", provider: "p", id: "m" },
    );
    ordinary.emit({ type: "agent_settled" });
    const ordinaryRecord = getPrefixProbeRegistry().get("ordinary-prefix")!;
    expect(ordinaryRecord.requests).toBeUndefined();
    expect(ordinaryRecord.first?.seq).toBe(0);
    expect(ordinaryRecord.latest?.seq).toBe(1);
    ordinaryCleanup();

    const consult = fakeSession();
    const consultCleanup = installPrefixProbe(consult, { runId: "consult-prefix", consultGuard: {} });
    await (consult.agent.onPayload as Function)(ordinaryPayload, { api: "a", provider: "p", id: "m" });
    await (consult.agent.onPayload as Function)(
      { ...ordinaryPayload, max_tokens: 1 },
      { api: "a", provider: "p", id: "m" },
    );
    consult.emit({ type: "agent_settled" });
    expect(
      getPrefixProbeRegistry()
        .get("consult-prefix")
        ?.requests?.map((r) => r.seq),
    ).toEqual([0, 1]);
    consultCleanup();
  });

  it("pairs assistant usage in order and ignores keepalive/non-assistant messages", async () => {
    const session = fakeSession();
    const cleanup = installPrefixProbe(session, { runId: "usage-prefix", consultGuard: {} });
    const payload = { model: "m", messages: [{ role: "user", content: "x" }] };
    await (session.agent.onPayload as Function)(payload, { api: "a", provider: "p", id: "m" });
    session.emit({ type: "message_end", message: { role: "user", usage: { input: 99 } } });
    session.emit({ type: "entry_appended", entry: { customType: "subagent:cache-keepalive" } });
    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 2, cacheRead: 3, cacheWrite: 4, output: 5, cost: { total: 0.6 } } },
    });
    const request = getPrefixProbeRegistry().get("usage-prefix")?.requests?.[0];
    expect(request?.usage).toEqual({ input: 2, cacheRead: 3, cacheWrite: 4, output: 5, costUsd: 0.6 });
    expect(request?.endedAt).toBeTypeOf("number");
    cleanup();
  });

  it("returns the original onPayload result unchanged and preserves original errors", async () => {
    const transformed = { model: "transformed", messages: [] };
    const original = vi.fn(async () => transformed);
    const session = fakeSession(original);
    const cleanup = installPrefixProbe(session, { runId: "identity-prefix" });
    const result = await (session.agent.onPayload as Function)({ model: "original" }, { id: "m" });
    expect(result).toBe(transformed);
    expect(original).toHaveBeenCalledTimes(1);
    cleanup();

    const failure = new Error("provider transform failed");
    const throwing = fakeSession(() => {
      throw failure;
    });
    const throwingCleanup = installPrefixProbe(throwing, { runId: "throwing-prefix" });
    await expect((throwing.agent.onPayload as Function)({ model: "m" }, { id: "m" })).rejects.toBe(failure);
    throwingCleanup();
  });

  it("keeps only hashes and enforces a FIFO of 64 runs", async () => {
    for (let i = 0; i < 65; i++) {
      const session = fakeSession();
      const cleanup = installPrefixProbe(session, { runId: `fifo-prefix-${i}` });
      await (session.agent.onPayload as Function)(
        { model: "m", secret: `never-store-${i}`, messages: [] },
        { id: "m" },
      );
      session.emit({ type: "agent_settled" });
      cleanup();
    }
    const registry = getPrefixProbeRegistry();
    expect(registry.get("fifo-prefix-0")).toBeUndefined();
    expect(registry.get("fifo-prefix-1")).toBeDefined();
    expect(registry.get("fifo-prefix-64")).toBeDefined();
    expect(JSON.stringify(registry.get("fifo-prefix-64"))).not.toContain("never-store-64");
  });
});
