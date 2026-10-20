import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createMessageAgentTool,
  messageAgentParams,
  MessageAgentParams,
  MessageAgentParamsWithWake,
} from "../../src/tools/message-agent-tool.js";

const generation = () => 3;
const FIXTURE = new URL("../fixtures/message-agent-wake-schema-golden.json", import.meta.url);
const OFF_GOLDEN = new URL("../fixtures/fabric-wake-off-golden.json", import.meta.url);

describe("message_agent wake schema (plan §4.2, frozen per activation)", () => {
  it("wake off: the factory returns the pre-wake INSTANCE and its JSON equals the S0 off-state golden byte for byte", () => {
    expect(messageAgentParams({ wake: false })).toBe(MessageAgentParams);
    const golden = JSON.parse(readFileSync(OFF_GOLDEN, "utf8")) as { messageAgentSchema: unknown };
    expect(JSON.parse(JSON.stringify(messageAgentParams({ wake: false })))).toEqual(golden.messageAgentSchema);
    expect(MessageAgentParams.properties).not.toHaveProperty("wake");
  });

  it("wake on: today's three fields unchanged + ONE optional boolean `wake`, pinned by a golden", () => {
    const on = JSON.parse(JSON.stringify(messageAgentParams({ wake: true }))) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const off = JSON.parse(JSON.stringify(MessageAgentParams)) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(messageAgentParams({ wake: true })).toBe(MessageAgentParamsWithWake);
    for (const key of Object.keys(off.properties)) expect(on.properties[key]).toEqual(off.properties[key]);
    expect(Object.keys(on.properties)).toEqual([...Object.keys(off.properties), "wake"]);
    expect(on.required).toEqual(off.required); // wake is optional
    expect(on.properties["wake"]).toMatchObject({ type: "boolean" });
    if (process.env.MESSAGE_AGENT_WAKE_GOLDEN_UPDATE === "1" && !existsSync(FIXTURE))
      writeFileSync(FIXTURE, `${JSON.stringify(on, null, 2)}\n`);
    expect(on).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("the tool exposes the frozen schema chosen at construction", () => {
    const router = { admit: vi.fn() } as never;
    const off = createMessageAgentTool({ router, from: "r_CHILD001", generation });
    const on = createMessageAgentTool({ router, from: "r_CHILD001", generation, wakeOn: true });
    expect(off.parameters).toBe(MessageAgentParams);
    expect(on.parameters).toBe(MessageAgentParamsWithWake);
  });
});

describe("message_agent wake execution", () => {
  const admitOk = () => ({ ok: true as const, status: "accepted" as const, key: "k", seq: 1 });

  it("wake on: forwards an explicit wake to the router; omitted wake adds NO key (legacy admission input)", async () => {
    const admit = vi.fn(admitOk);
    const tool = createMessageAgentTool({ router: { admit } as never, from: "r_CHILD001", generation, wakeOn: true });
    await tool.execute("c", { to: "root", kind: "finding", text: "x", wake: true } as never);
    await tool.execute("c", { to: "root", kind: "finding", text: "x", wake: false } as never);
    await tool.execute("c", { to: "root", kind: "finding", text: "x" });
    const inputs = admit.mock.calls.map((c) => (c as unknown as [string, Record<string, unknown>])[1]);
    expect(inputs[0]).toMatchObject({ wake: true });
    expect(inputs[1]).toMatchObject({ wake: false });
    expect(inputs[2]).not.toHaveProperty("wake");
  });

  it("wake on: progress + wake:true is invalid_wake and never reaches the router or the mention channel", async () => {
    const admit = vi.fn(admitOk);
    const send = vi.fn();
    const tool = createMessageAgentTool({
      router: { admit } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
      wakeOn: true,
    });
    for (const to of ["root", "@builder"]) {
      const result = await tool.execute("c", { to, kind: "progress", text: "x", wake: true } as never);
      expect(result.details).toEqual({ ok: false, status: "invalid_wake", reason: "progress_never_wakes" });
    }
    expect(admit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("wake on: the explicit wake rides to the @label channel as a 4th argument only when given", async () => {
    const send = vi.fn(async () => ({ ok: false as const, status: "unknown_label" as const, label: "b" }));
    const tool = createMessageAgentTool({
      router: { admit: vi.fn() } as never,
      mention: { send } as never,
      from: "r_CHILD001",
      generation,
      wakeOn: true,
    });
    await tool.execute("c", { to: "@b", kind: "finding", text: "x", wake: false } as never);
    await tool.execute("c", { to: "@b", kind: "finding", text: "x" });
    expect(send.mock.calls[0]).toEqual(["b", "finding", "x", false]);
    expect(send.mock.calls[1]).toEqual(["b", "finding", "x"]);
  });

  it("wake OFF: a stray `wake` argument is dropped — router input and invalid_wake behave exactly as before", async () => {
    const admit = vi.fn(admitOk);
    const tool = createMessageAgentTool({ router: { admit } as never, from: "r_CHILD001", generation });
    const result = await tool.execute("c", { to: "root", kind: "progress", text: "x", wake: true } as never);
    expect(result.details).toMatchObject({ ok: true });
    expect(admit).toHaveBeenCalledWith("r_CHILD001", { to: "root", kind: "progress", text: "x", generation: 3 });
  });

  it("relays the router's wakeDowngraded verbatim in the result text the model sees", async () => {
    const admit = vi.fn(() => ({
      ok: true as const,
      status: "accepted" as const,
      key: "k",
      seq: 1,
      wake: false,
      wakeDowngraded: "level_limit" as const,
    }));
    const tool = createMessageAgentTool({ router: { admit } as never, from: "r_CHILD001", generation, wakeOn: true });
    const result = await tool.execute("c", { to: "root", kind: "finding", text: "x", wake: true } as never);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      wake: false,
      wakeDowngraded: "level_limit",
    });
  });
});
