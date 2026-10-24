/** F1 §7.4: `/schedule` and `/schedule run <n>` grammar + router admission. */
import { afterEach, describe, expect, it } from "vitest";
import {
  createFeishuRouter,
  parseFeishuCommand,
  type FeishuRouterIntent,
} from "../../../../src/web-hub/hub/feishu/router.js";
import { cleanupF6, f6Rig, normalizedMessage, OTHER } from "../../../fixtures/feishu/f6.js";

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
    ["/scheduler", { op: "help", unknown: "/scheduler" }],
    ["//schedule", { op: "prompt", text: "/schedule" }],
  ])("%s", (text, expected) => {
    expect(parseFeishuCommand(text as string, ON)).toEqual(expected);
  });
  it("schedule disabled/absent ⇒ unknown command, byte-identical to before", () => {
    expect(parseFeishuCommand("/schedule")).toEqual({ op: "help", unknown: "/schedule" });
    expect(parseFeishuCommand("/schedule run 1", { schedule: false })).toEqual({ op: "help", unknown: "/schedule" });
  });
});

async function scheduleRouter() {
  const r = await f6Rig();
  const intents: FeishuRouterIntent[] = [];
  const router = createFeishuRouter({
    state: r.state,
    sessions: r.sessions,
    requests: r.requests,
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

  it("a router without the schedule flag treats /schedule as an unknown command", async () => {
    const r = await f6Rig();
    const p = await r.router.prepare(normalizedMessage("u", "/schedule"), r.identity);
    await r.state.commit();
    p.durable?.();
    expect(r.intents.map((i) => (i.type === "notice" ? `${i.code}:${i.unknownCommand}` : i.type))).toEqual([
      "help:/schedule",
    ]);
  });
});

async function scheduleRouterRaw() {
  const r = await f6Rig();
  return createFeishuRouter({
    state: r.state,
    sessions: r.sessions,
    requests: r.requests,
    groupRootTopics: false,
    spawnScope: "known",
    schedule: true,
    emit: () => {},
  });
}
