import { describe, expect, it, vi } from "vitest";
import {
  ANCHOR_1H_ROUTES,
  installConsultAnchor,
  resolveAnchor,
  withoutCacheControl,
} from "../../src/consult/anchor.js";

const model = { api: "anthropic-messages", provider: "test", id: "model" };
function payload(ttl?: string, oauth = false): any {
  const cc = { type: "ephemeral", ...(ttl === undefined ? {} : { ttl }) };
  return {
    model: "model",
    system: [
      ...(oauth ? [{ type: "text", text: "oauth", cache_control: cc }] : []),
      { type: "text", text: "system", cache_control: cc },
    ],
    tools: [{ name: "read", cache_control: cc }],
    messages: [
      { role: "user", content: [{ type: "text", text: "history" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "signed" },
          { type: "text", text: "expert answer" },
          { type: "redacted_thinking", data: "signed-redacted" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "host question", cache_control: cc }] },
    ],
  };
}
const spec = { prompt: "host question" };
function points(body: any): number {
  return (JSON.stringify(body).match(/"cache_control":/g) ?? []).length;
}

describe("expert-history cache anchor", () => {
  it("adds 3→4 at the last eligible expert block, never on thinking; content bytes unchanged", () => {
    const before = payload();
    const json = JSON.stringify(before);
    const decision = resolveAnchor(before, spec, model);
    expect(decision.state).toBe("added");
    expect(decision.identity).toMatchObject({
      k: 2,
      block: 1,
      blockType: "text",
      route: { provider: "test", model: "model", api: "anthropic-messages" },
      ttl: "",
    });
    expect((decision.payload as any).messages[1].content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(points(decision.payload)).toBe(4);
    expect(withoutCacheControl(decision.payload)).toEqual(withoutCacheControl(before));
    expect(JSON.stringify(before)).toBe(json);
    expect((decision.payload as any).system).toBe(before.system);
    expect((decision.payload as any).tools).toBe(before.tools);
  });

  it("counts only provider markers, not application cache_control keys in inputs/schemas/results", () => {
    const before = payload();
    before.messages[1].content.unshift({
      type: "tool_use",
      id: "t",
      name: "read",
      input: { cache_control: { type: "ephemeral" } },
    });
    before.messages[0].content.push({
      type: "tool_result",
      content: [{ type: "text", cache_control: "application-data", text: "nested result" }],
    });
    before.tools[0].input_schema = { type: "object", properties: { cache_control: { type: "string" } } };
    const original = JSON.stringify(before);
    const decision = resolveAnchor(before, spec, model);
    expect(decision.state).toBe("added");
    expect(decision.degraded).toBeUndefined();
    const after = decision.payload as any;
    expect(after.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(after.messages[1].content[2].cache_control).toEqual({ type: "ephemeral" });
    expect(after.messages[1].content[0].input).toEqual(before.messages[1].content[0].input);
    expect(after.tools).toBe(before.tools);
    expect(JSON.stringify(before)).toBe(original);
    const noRealMarkers = withoutCacheControl(before) as any;
    noRealMarkers.tools[0].input_schema.properties.cache_control = { type: "string" };
    expect(resolveAnchor(noRealMarkers, spec, model)).toMatchObject({ state: "n/a", payload: noRealMarkers });
  });

  it.each(["text", "tool_use", "tool_result", "image"])("supports eligible %s blocks", (type) => {
    const body = payload();
    body.messages[1].content = [{ type, value: "same bytes" }];
    expect(resolveAnchor(body, spec, model).identity?.blockType).toBe(type);
  });

  it.each([
    ["non-Anthropic", (p: any) => p, { ...model, api: "other" }, "n/a"],
    ["cacheRetention:none", (p: any) => withoutCacheControl(p), model, "n/a"],
    [
      "prompt mismatch",
      (p: any) => {
        p.messages[2].content[0].text += "!";
        return p;
      },
      model,
      "skipped:shape",
    ],
    [
      "non-unique text",
      (p: any) => {
        p.messages[2].content.push({ type: "text", text: "extra" });
        return p;
      },
      model,
      "skipped:shape",
    ],
    [
      "string question",
      (p: any) => {
        p.messages[2].content = "host question";
        return p;
      },
      model,
      "skipped:shape",
    ],
    [
      "assistant question",
      (p: any) => {
        p.messages[2].role = "assistant";
        return p;
      },
      model,
      "skipped:shape",
    ],
    [
      "thinking only",
      (p: any) => {
        p.messages[1].content.splice(1, 1);
        return p;
      },
      model,
      "skipped:block",
    ],
    [
      "no history",
      (p: any) => {
        p.messages = p.messages.slice(-1);
        return p;
      },
      model,
      "skipped:shape",
    ],
    [
      "unexpected breakpoint",
      (p: any) => {
        p.messages[0].content[0].cache_control = { type: "ephemeral" };
        return p;
      },
      model,
      "skipped:shape",
    ],
  ] as const)("leaves %s requests reference-identical", (_name, mutate, route, expected) => {
    const body = mutate(payload());
    const decision = resolveAnchor(body, spec, route);
    expect(decision.state).toBe(expected);
    expect(decision.payload).toBe(body);
  });

  it.each([undefined, "5m", "1h"])("copies ttl %s without changing system/tools or adding a default upgrade", (ttl) => {
    const body = payload(ttl);
    const route = ttl === "1h" ? { ...model, provider: "cr-anthropic", id: "claude-opus-5-5" } : model;
    const decision = resolveAnchor(body, spec, route);
    expect(decision.state).toBe("added");
    expect((decision.payload as any).messages[1].content[1].cache_control).toEqual(
      body.messages[2].content[0].cache_control,
    );
    expect(decision.identity?.ttl).toBe(ttl ?? "");
  });

  it.each([undefined, "5m"])("refuses a 1h anchor after a preceding short marker (ttl=%s)", (shortTtl) => {
    const route = { ...model, provider: "cr-anthropic", id: "claude-opus-5-5" };
    for (const oauth of [false, true]) {
      for (const source of ["tools", "system"]) {
        const body = payload("1h", oauth);
        body[source][0].cache_control = { type: "ephemeral", ...(shortTtl ? { ttl: shortTtl } : {}) };
        const bytes = JSON.stringify(body);
        const decision = resolveAnchor(body, spec, route);
        expect(decision.state).toBe("skipped:ttl-order");
        expect(decision.payload).toBe(body);
        expect(JSON.stringify(body)).toBe(bytes);
      }
    }
  });

  it("accepts the legal 1h → 5m ordering without changing the existing markers", () => {
    const body = payload("5m");
    body.tools[0].cache_control = { type: "ephemeral", ttl: "1h" };
    body.system[0].cache_control = { type: "ephemeral", ttl: "1h" };
    const decision = resolveAnchor(body, spec, model);
    expect(decision.state).toBe("added");
    expect((decision.payload as any).messages[1].content[1].cache_control.ttl).toBe("5m");
    expect((decision.payload as any).system).toBe(body.system);
    expect((decision.payload as any).tools).toBe(body.tools);
  });

  it("freezes the P0 full-shape 1h allowlist and skips landing-only/unproven routes unchanged", () => {
    expect(ANCHOR_1H_ROUTES).toEqual(["cr-anthropic/claude-opus-5-5"]);
    for (const id of ["claude-sonnet-5", "other"]) {
      const body = payload("1h");
      const decision = resolveAnchor(body, spec, { ...model, provider: "cr-anthropic", id });
      expect(decision.state).toBe("skipped:ttl-1h-unproven");
      expect(decision.payload).toBe(body);
    }
  });

  it("relocates only the fresh first 4-breakpoint request and marks untested OAuth degraded", () => {
    const body = payload(undefined, true);
    const first = resolveAnchor(body, spec, model);
    expect(first.state).toBe("relocated");
    expect(first.degraded).toBe(true);
    expect(points(first.payload)).toBe(4);
    expect((first.payload as any).messages.at(-1).content[0].cache_control).toBeUndefined();
    expect(withoutCacheControl(first.payload)).toEqual(withoutCacheControl(body));
    for (const decision of [
      resolveAnchor(body, { ...spec, base: first.identity! }, model),
      resolveAnchor(body, spec, model, { identity: first.identity!, first: false }),
    ]) {
      expect(decision.state).toBe("skipped:limit");
      expect(decision.degraded).toBe(true);
      expect(decision.payload).toBe(body);
    }
    body.tools.push({ name: "extra", cache_control: { type: "ephemeral" } });
    const overflow = resolveAnchor(body, spec, model);
    expect(overflow.state).toBe("skipped:limit");
    expect(overflow.payload).toBe(body);
  });

  it("replays OAuth relocation idempotently for first-request retries, never after context advances", async () => {
    const session = { agent: { onPayload: undefined as unknown } };
    const installation = installConsultAnchor(session, spec);
    const apply = session.agent.onPayload as Function;
    for (let attempt = 0; attempt < 3; attempt++) {
      const repeated = payload(undefined, true);
      const result = await apply(repeated, model);
      expect(installation.current()?.state).toBe("relocated");
      expect(points(result)).toBe(4);
      expect(result.messages.at(-1).content[0].cache_control).toBeUndefined();
    }
    // Same message count is not enough: a new last user identity is a later request.
    const changed = payload(undefined, true);
    changed.messages[2].content[0].text = "next question";
    expect(await apply(changed, model)).toBe(changed);
    expect(installation.current()?.state).toBe("skipped:limit");
    const originalAgain = payload(undefined, true);
    expect(await apply(originalAgain, model)).toBe(originalAgain);
    expect(installation.current()?.state).toBe("skipped:limit");
    installation.close();
  });

  it("replays the trusted anchor beyond the 20-block lookback on every request", async () => {
    const session = { agent: { onPayload: undefined as unknown } };
    const installation = installConsultAnchor(session, spec);
    const apply = session.agent.onPayload as Function;
    await apply(payload(), model);
    const identity = installation.current()?.identity;
    for (let round = 1; round <= 3; round++) {
      const body = payload();
      delete body.messages[2].content[0].cache_control;
      for (let i = 0; i < 12 * round; i++)
        body.messages.push(
          { role: "assistant", content: [{ type: "tool_use", id: `id-${i}` }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: `id-${i}`, content: "result" }] },
        );
      body.messages.at(-1).content[0].cache_control = { type: "ephemeral" };
      const result = await apply(body, model);
      expect(installation.current()?.state).toBe("added");
      expect(installation.current()?.identity).toEqual(identity);
      expect(result.messages[1].content[1].cache_control).toEqual({ type: "ephemeral" });
      expect(points(result)).toBe(4);
      expect(withoutCacheControl(result)).toEqual(withoutCacheControl(body));
    }
    installation.close();
  });

  it.each(["prefix", "block", "system", "tools", "provider", "model", "api", "ttl", "coordinate"])(
    "rejects changed %s identity unchanged and stops retrying for the run",
    async (field) => {
      const session = { agent: { onPayload: undefined as unknown } };
      const installation = installConsultAnchor(session, spec);
      const apply = session.agent.onPayload as Function;
      await apply(payload(), model);
      const body = payload();
      let route = { ...model };
      switch (field) {
        case "prefix":
          body.messages[0].content[0].text = "changed";
          break;
        case "block":
          body.messages[1].content[1].text = "changed";
          break;
        case "system":
          body.system[0].text = "changed";
          break;
        case "tools":
          body.tools[0].name = "write";
          break;
        case "provider":
          route.provider = "changed";
          break;
        case "model":
          route.id = "changed";
          break;
        // A new API is n/a, so use a base with a mismatching saved route below.
        case "api":
          installation.current()!.identity!.route.api = "other";
          break;
        case "ttl":
          body.messages[2].content[0].cache_control.ttl = "5m";
          break;
        case "coordinate":
          installation.current()!.identity!.block = 200;
          break;
      }
      expect(await apply(body, route)).toBe(body);
      expect(installation.current()?.state).toBe("skipped:identity");
      const restored = payload();
      expect(await apply(restored, model)).toBe(restored);
      expect(installation.current()?.state).toBe("skipped:identity");
      installation.close();
    },
  );

  it.each(["n/a", "skipped:shape", "skipped:block"])(
    "never bootstraps a later history after first %s",
    async (state) => {
      const session = { agent: { onPayload: undefined as unknown } };
      const installation = installConsultAnchor(session, spec);
      const apply = session.agent.onPayload as Function;
      const first = payload();
      if (state === "n/a") delete first.messages[2].content[0].cache_control;
      if (state === "n/a") {
        delete first.system[0].cache_control;
        delete first.tools[0].cache_control;
      }
      if (state === "skipped:shape") first.messages[2].content[0].text = "not the host prompt";
      if (state === "skipped:block") first.messages[1].content.splice(1, 1);
      expect(await apply(first, model)).toBe(first);
      expect(installation.current()?.state).toBe(state);
      const later = payload();
      expect(await apply(later, model)).toBe(later);
      expect(installation.current()?.state).toBe(state);
      installation.close();
    },
  );

  it("verifies a thread's base before adding and does not derive it from current breakpoints", () => {
    const base = resolveAnchor(payload(), spec, model).identity!;
    const body = payload();
    body.messages[2].content[0].text = "follow-up #2";
    expect(resolveAnchor(body, { prompt: "follow-up #2", base }, model).state).toBe("added");
    body.messages[0].content[0].text = "tampered";
    expect(resolveAnchor(body, { prompt: "follow-up #2", base }, model)).toMatchObject({
      payload: body,
      state: "skipped:identity",
    });
  });

  it("applies before extensions, respects replacement/undefined, restores its hook on close, and propagates errors", async () => {
    const original = vi.fn((p: any) => {
      expect(p.messages[1].content[1].cache_control).toEqual({ type: "ephemeral" });
    });
    const session = { agent: { onPayload: original as unknown } };
    const installation = installConsultAnchor(session, spec);
    const result = await (session.agent.onPayload as Function)(payload(), model);
    expect(result.messages[1].content[1].cache_control).toBeDefined();
    expect(original).toHaveBeenCalledTimes(1);
    installation.close();
    installation.close();
    expect(session.agent.onPayload).toBe(original);
    const replacement = { replaced: true };
    session.agent.onPayload = () => replacement;
    installConsultAnchor(session, spec);
    expect(await (session.agent.onPayload as Function)(payload(), model)).toBe(replacement);
    const failure = new Error("extension failure");
    session.agent.onPayload = () => {
      throw failure;
    };
    installConsultAnchor(session, spec);
    await expect((session.agent.onPayload as Function)(payload(), model)).rejects.toBe(failure);
  });
});
