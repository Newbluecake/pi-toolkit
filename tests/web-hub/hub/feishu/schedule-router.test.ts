/** F1 §7.4: `/schedule` and `/schedule run <n>` grammar + router admission. */
import { afterEach, describe, expect, it } from "vitest";
import {
  createFeishuRouter,
  parseFeishuCommand,
  type FeishuRouterIntent,
} from "../../../../src/web-hub/hub/feishu/router.js";
import { createBindingTransfer } from "../../../../src/web-hub/hub/feishu/bindings-transfer.js";
import { cleanupF6, f6Rig, normalizedMessage, OTHER, untilF6 } from "../../../fixtures/feishu/f6.js";

afterEach(cleanupF6);
const ON = { schedule: true } as const;

describe("parseFeishuCommand with schedule enabled", () => {
  it.each([
    ["/schedule", { op: "schedule" }],
    ["/schedule run 3", { op: "schedule-run", n: 3 }],
    ["/schedule run   12", { op: "schedule-run", n: 12 }],
    ["/schedule run", { op: "help" }],
    ["/schedule run x", { op: "help" }],
    ["/schedule run 0", { op: "help" }],
    ["/schedule run 1 2", { op: "help" }],
    ["/schedule rm 1", { op: "help" }],
    ["/schedule\nbody", { op: "help" }],
    ["/scheduler", { op: "prompt", text: "/scheduler" }],
    ["//schedule", { op: "prompt", text: "/schedule" }],
  ])("%s", (text, expected) => {
    expect(parseFeishuCommand(text as string, ON)).toEqual(expected);
  });
  it("schedule disabled/absent ⇒ original plain text, not an executable bot command", () => {
    expect(parseFeishuCommand("/schedule")).toEqual({ op: "prompt", text: "/schedule" });
    expect(parseFeishuCommand("/schedule run 1", { schedule: false })).toEqual({
      op: "prompt",
      text: "/schedule run 1",
    });
  });
});

async function scheduleRouter() {
  const r = await f6Rig();
  const intents: FeishuRouterIntent[] = [];
  const router = createFeishuRouter({
    state: r.state,
    sessions: r.sessions,
    requests: r.requests,
    bindingTransfer: createBindingTransfer({ state: r.state, log: () => {} }),
    groupRootTopics: false,
    spawnScope: "known",
    schedule: true,
    emit: (e) => intents.push(e),
  });
  const run = async (id: string, text: string, over: Partial<ReturnType<typeof normalizedMessage>> = {}) => {
    const m = { ...normalizedMessage(id, text), ...over };
    const p = await router.prepare(
      m,
      over.senderOpenId ? { ...r.identity, senderOpenId: over.senderOpenId } : r.identity,
    );
    await r.state.commit();
    p.durable?.();
  };
  return { r, intents, run };
}

describe("router /schedule", () => {
  it("emits schedule / schedule-run intents for an allow-listed p2p sender, with or without a binding", async () => {
    const { r, intents, run } = await scheduleRouter();
    await run("a", "/schedule");
    await run("b", "/schedule run 2");
    r.state.bindings.remove("p2p:chat");
    await run("c", "/schedule");
    expect(intents.map((i) => i.type)).toEqual(["schedule", "schedule-run", "schedule"]);
    expect((intents[1] as { n: number }).n).toBe(2);
    expect(r.request).not.toHaveBeenCalled();
    expect(r.state.requests.list()).toHaveLength(0);
  });

  it("group chats get a p2p-only notice, never an intent", async () => {
    const { intents, run } = await scheduleRouter();
    await run("g", "/schedule", { chatType: "group", threadId: "t1", chatId: "g1" });
    expect(intents.map((i) => (i.type === "notice" ? i.code : i.type))).toEqual(["schedule-p2p-only"]);
  });

  it("non-allow-listed senders are dropped silently", async () => {
    const { intents, run } = await scheduleRouter();
    const m = normalizedMessage("x", "/schedule");
    const p = await (
      await scheduleRouterRaw()
    ).prepare({ ...m, senderOpenId: OTHER }, { senderOpenId: OTHER, tenantKey: "tenant", installGen: 1 });
    expect(p).toEqual({ drop: true });
    expect(intents).toHaveLength(0);
    void run;
  });

  it("a router without schedule submits the original text once through normal admission", async () => {
    const r = await f6Rig({ debounceMs: 0 });
    const text = "/schedule run 1\n  /reload raw  ";
    const deliver = async () => {
      const p = await r.router.prepare(normalizedMessage("u", text), r.identity);
      await r.state.commit();
      p.durable?.();
      await r.requests.flushChat("chat");
    };
    await deliver();
    await untilF6(() => r.request.mock.calls.length === 1);
    const frame = r.request.mock.calls[0]![0];
    expect(frame.cmd.op).toBe("prompt");
    if (frame.cmd.op !== "prompt") throw new Error("not a text admission");
    expect(frame.cmd.text.slice(frame.cmd.text.indexOf("\n") + 1)).toBe(text);
    expect(r.state.requests.list()[0]?.payload?.body).toBe(text);
    expect(r.intents).toEqual([]); // no schedule/schedule-run or unknown-help intent
    await deliver();
    expect(r.request).toHaveBeenCalledTimes(1);
    r.state.bindings.remove("p2p:chat");
    const refused = await r.router.prepare(normalizedMessage("unbound", text), r.identity);
    await r.state.commit();
    refused.durable?.();
    expect(r.intents).toMatchObject([{ type: "notice", code: "no-session-bound" }]);
    const stranger = await r.router.prepare(normalizedMessage("stranger", text), {
      ...r.identity,
      senderOpenId: OTHER,
    });
    expect(stranger).toEqual({ drop: true });
    expect(r.request).toHaveBeenCalledTimes(1);
  });

  it("/scheduler is plain text even when schedule is enabled; enabled bad arguments remain help", async () => {
    const { r, intents, run } = await scheduleRouter();
    const text = "/scheduler  raw  ";
    await run("prefix", text);
    await r.requests.flushChat("chat");
    await untilF6(() => r.request.mock.calls.length === 1);
    expect(r.request.mock.calls[0]![0].cmd).toMatchObject({ op: "prompt" });
    const cmd = r.request.mock.calls[0]![0].cmd;
    expect(cmd.op === "prompt" && cmd.text.slice(cmd.text.indexOf("\n") + 1)).toBe(text);
    await run("bad-args", "/schedule run nope");
    expect(intents).toMatchObject([{ type: "notice", code: "help" }]);
    expect(r.request).toHaveBeenCalledTimes(1);
  });
});

async function scheduleRouterRaw() {
  const r = await f6Rig();
  return createFeishuRouter({
    state: r.state,
    sessions: r.sessions,
    requests: r.requests,
    bindingTransfer: createBindingTransfer({ state: r.state, log: () => {} }),
    groupRootTopics: false,
    spawnScope: "known",
    schedule: true,
    emit: () => {},
  });
}
