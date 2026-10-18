import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuInbound } from "../../../../src/web-hub/hub/feishu/inbound.js";
import { cleanupF6, f6Rig, normalizedMessage, OWNER, messageEnvelope, untilF6 } from "../../../fixtures/feishu/f6.js";
import {
  createFeishuRouter,
  feishuNewDirectoryDecision,
  parseFeishuCommand,
} from "../../../../src/web-hub/hub/feishu/router.js";

afterEach(cleanupF6);
describe("F6 command grammar", () => {
  it.each([
    ["hello\n/list", { op: "prompt", text: "hello\n/list" }],
    ["//new /tmp", { op: "prompt", text: "/new /tmp" }],
    ["/list", { op: "list" }],
    ["/cur", { op: "cur" }],
    ["/unbind", { op: "unbind" }],
    ["/help", { op: "help" }],
    ["/use 1", { op: "use", selector: "1" }],
    ["/use name with spaces", { op: "use", selector: "name with spaces" }],
    ["/new /repo first message\nnext line", { op: "new", cwd: "/repo", firstPrompt: "first message\nnext line" }],
    ['/new "/space dir" hello', { op: "new", cwd: "/space dir", firstPrompt: "hello" }],
    ["/file /abs path", { op: "file", path: "/abs path" }],
    ["/unknown", { op: "help" }],
    ["/List", { op: "help" }],
    ["/list args", { op: "help" }],
    ["/list\nbody", { op: "help" }],
    ["/new", { op: "help" }],
    ['/new "broken', { op: "help" }],
    ["/file relative", { op: "help" }],
  ])("parses %s", (text, expected) => {
    expect(parseFeishuCommand(text as string)).toEqual(expected);
  });
  it("R2-j known never confirms an unknown directory; roots does", () => {
    expect(feishuNewDirectoryDecision("known", false)).toBe("refused");
    expect(feishuNewDirectoryDecision("roots", false)).toBe("confirm");
    expect(feishuNewDirectoryDecision("known", true)).toBe("create");
  });
});
describe("F6 routing intents and bindings", () => {
  it("/list → /use numeric → /cur → /unbind round trip, preserving revision monotonicity", async () => {
    const r = await f6Rig();
    const original = r.state.bindings.get("p2p:chat")!.rev;
    for (const [id, text] of [
      ["a", "/list"],
      ["b", "/use 1"],
      ["c", "/cur"],
    ]) {
      const prepared = await r.router.prepare(normalizedMessage(id!, text!), r.identity);
      expect(r.intents.length).toBe(text === "/list" ? 0 : text === "/use 1" ? 1 : 2);
      await r.state.commit();
      prepared.durable?.();
    }
    expect(r.intents.map((i) => i.type)).toEqual(["list", "bound", "current"]);
    expect(r.state.bindings.get("p2p:chat")!.rev).toBeGreaterThan(original);
    const unbind = await r.router.prepare(normalizedMessage("d", "/unbind"), r.identity);
    await r.state.commit();
    unbind.durable?.();
    expect(r.state.bindings.get("p2p:chat")).toBeUndefined();
    const rebound = await r.router.prepare(normalizedMessage("e", "/use One"), r.identity);
    await r.state.commit();
    rebound.durable?.();
    expect(r.state.bindings.get("p2p:chat")!.rev).toBeGreaterThan(original + 1);
    expect(r.request).not.toHaveBeenCalled();
  });
  it("unbound plain messages are not held; unknown slash commands never forward", async () => {
    const r = await f6Rig();
    r.state.bindings.remove("p2p:chat");
    for (const text of ["plain", "/unknown", "/newer /repo"]) {
      const p = await r.router.prepare(normalizedMessage(text.replace(/[^a-z]/g, ""), text), r.identity);
      await r.state.commit();
      p.durable?.();
    }
    expect(r.intents.map((i) => (i.type === "notice" ? i.code : i.type))).toEqual(["no-session-bound", "help", "help"]);
    expect(r.state.requests.list()).toHaveLength(0);
    expect(r.requests.bufferedChats).toBe(0);
    expect(r.request).not.toHaveBeenCalled();
  });
  it("durable callback releases literal slash text to a followUp request", async () => {
    const r = await f6Rig();
    const p = await r.router.prepare(normalizedMessage("m", "//help"), r.identity);
    expect(r.requests.bufferedChats).toBe(0);
    expect(r.state.requests.list()[0]?.payload?.body).toBe("/help");
    await r.state.commit();
    p.durable?.();
    await r.requests.flushChat("chat");
    const cmd = r.request.mock.calls[0]![0].cmd;
    expect(cmd).toMatchObject({ op: "prompt", deliver: "followUp", expect: { sessionId: "session-1" } });
    expect(cmd.op === "prompt" && cmd.text.endsWith("\n/help")).toBe(true);
  });
  it("group root never sends agent output outside a topic; opt-in emits topic creation intent", async () => {
    for (const roots of [false, true]) {
      const r = await f6Rig({ roots });
      const m = { ...normalizedMessage(), chatType: "group" as const };
      const p = await r.router.prepare(m, r.identity);
      await r.state.commit();
      p.durable?.();
      expect(r.intents[0]).toMatchObject(roots ? { type: "open-topic" } : { type: "notice", code: "use-topic" });
      expect(r.state.requests.list()).toHaveLength(0);
    }
  });
  it("binds only the returned topic id; a different topic cannot borrow the binding", async () => {
    const r = await f6Rig();
    expect(r.router.bindTopic({ chatId: "chat", threadId: "t1", sessionId: "session-1" }).ok).toBe(true);
    for (const threadId of ["t1", "t2"]) {
      const p = await r.router.prepare({ ...normalizedMessage(threadId), chatType: "group", threadId }, r.identity);
      await r.state.commit();
      p.durable?.();
    }
    expect(r.state.requests.list()).toHaveLength(1);
    expect(r.state.requests.list()[0]?.bindingKey).toBe("grp:chat:t1");
    expect(r.intents.at(-1)).toMatchObject({ type: "notice", code: "no-session-bound" });
  });
  it("/new emits a non-session F5 intent only after durability, with the exact scope", async () => {
    const r = await f6Rig();
    const p = await r.router.prepare(normalizedMessage("n", "/new /repo first"), r.identity);
    expect(r.intents).toHaveLength(0);
    await r.state.commit();
    p.durable?.();
    expect(r.intents[0]).toMatchObject({
      type: "new",
      cwd: "/repo",
      firstPrompt: "first",
      identity: r.identity,
      policy: { scope: "known", confirm: "unknown-dir" },
    });
    expect(r.state.requests.list()).toHaveLength(0);
  });
  it("delegates files and long text to a committed+pinned payload port, never truncates", async () => {
    const r = await f6Rig();
    let pinned = false;
    const router = createFeishuRouter({
      state: r.state,
      sessions: r.sessions,
      requests: r.requests,
      groupRootTopics: false,
      spawnScope: "known",
      preparePayload: async (m, _text, identity) => {
        expect(identity.senderOpenId).toBe(OWNER);
        pinned = true;
        return { body: "[attachment staging.txt]", messageIds: [m.messageId], uploadIds: ["upload-1"] };
      },
      emit: (i) => r.intents.push(i),
    });
    const p = await router.prepare(normalizedMessage("long", "x".repeat(20_000)), r.identity);
    expect(pinned).toBe(true);
    expect(r.state.requests.list()[0]?.payload).toEqual({
      body: "[attachment staging.txt]",
      messageIds: ["long"],
      uploadIds: ["upload-1"],
    });
    await r.state.commit();
    p.durable?.();
    router.dispose();
    const unsupported = await r.router.prepare(normalizedMessage("noport", "x".repeat(20_000)), r.identity);
    await r.state.commit();
    unsupported.durable?.();
    expect(r.intents.at(-1)).toMatchObject({ type: "notice", code: "text-staging-required" });
  });
  it.each(["", "   ", "\n\t "])("empty text %j produces a usage hint, never a header-only prompt", async (text) => {
    const r = await f6Rig();
    const prepared = await r.router.prepare(normalizedMessage("empty", text), r.identity);
    await r.state.commit();
    prepared.durable?.();
    expect(r.intents).toMatchObject([{ type: "notice", code: "usage" }]);
    expect(r.state.requests.list()).toHaveLength(0);
    expect(r.request).not.toHaveBeenCalled();
  });

  it("bare @bot in a bound topic emits usage and no request", async () => {
    const r = await f6Rig();
    r.router.bindTopic({ chatId: "chat", threadId: "thread", sessionId: "session-1" });
    const result = await r.inbound.handle(
      messageEnvelope("bare-at", "@_user_1 ", { chatType: "group", threadId: "thread", mentions: true }),
    );
    expect(result.ack).toBe(true);
    expect(r.intents.at(-1)).toMatchObject({ type: "notice", code: "usage" });
    expect(r.state.requests.list()).toHaveLength(0);
    expect(r.request).not.toHaveBeenCalled();
  });

  it("revocation while staging is silent, not queue-full, and uses no durable dedup", async () => {
    const r = await f6Rig();
    let resume!: () => void;
    const router = createFeishuRouter({
      state: r.state,
      sessions: r.sessions,
      requests: r.requests,
      groupRootTopics: false,
      spawnScope: "known",
      emit: (intent) => r.intents.push(intent),
      preparePayload: async (m) => {
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
        return { body: "staged", messageIds: [m.messageId], uploadIds: ["staged-upload"] };
      },
    });
    const inbound = createFeishuInbound({
      state: r.state,
      installation: r.install,
      admission: r.admission,
      allowGroups: true,
      staleMessageS: 300,
      now: r.clock.now,
      prepare: router.prepare,
      emit: (intent) => r.inboundIntents.push(intent),
    });
    try {
      const pending = inbound.handle(messageEnvelope("staged-revoked"));
      await vi.waitFor(() => expect(resume).toBeDefined());
      await r.requests.revokeSender(OWNER);
      resume();
      expect(await pending).toEqual({ ack: true, reason: "sender-denied" });
      expect(r.intents).toHaveLength(0);
      expect(r.inboundIntents).toHaveLength(0);
      expect(r.state.requests.list()).toHaveLength(0);
      expect(r.state.dedup.size).toBe(0);
    } finally {
      inbound.dispose();
      router.dispose();
    }
  });

  it("detached command flush failures reach a static degraded health sink", async () => {
    const r = await f6Rig();
    vi.spyOn(r.requests, "flushChat").mockRejectedValueOnce(new Error("private-path-DO-NOT-LOG"));
    const prepared = await r.router.prepare(normalizedMessage("command", "/cur"), r.identity);
    await r.state.commit();
    prepared.durable?.();
    await untilF6(() => r.health.some((event: any) => event.operation === "flush"));
    expect(r.health).toContainEqual({ degraded: true, reason: "background-failed", operation: "flush" });
    expect(JSON.stringify(r.health)).not.toContain("DO-NOT-LOG");
  });

  it("a staging port cannot turn a nonempty message into a whitespace-only dispatched body", async () => {
    const r = await f6Rig();
    const router = createFeishuRouter({
      state: r.state,
      sessions: r.sessions,
      requests: r.requests,
      groupRootTopics: false,
      spawnScope: "known",
      preparePayload: async (m) => ({ body: "  ", messageIds: [m.messageId], uploadIds: [] }),
      emit: (intent) => r.intents.push(intent),
    });
    try {
      const prepared = await router.prepare(normalizedMessage("empty-staged", "original"), r.identity);
      await r.state.commit();
      prepared.durable?.();
      expect(r.intents.at(-1)).toMatchObject({ type: "notice", code: "usage" });
      expect(r.state.requests.list()).toHaveLength(0);
    } finally {
      router.dispose();
    }
  });
});
