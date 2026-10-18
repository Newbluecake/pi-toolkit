import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { cleanupF6, f6Rig, messageEnvelope, callbackEnvelope, OWNER, OTHER, NOW } from "../../../fixtures/feishu/f6.js";
import {
  createFeishuInbound,
  decodeFeishuEvent,
  FeishuDropCache,
  FEISHU_INBOUND_TRANSIENT,
} from "../../../../src/web-hub/hub/feishu/inbound.js";

afterEach(cleanupF6);
describe("F6 envelope validation", () => {
  it("decodes probe message/open_id, strips mention placeholders, normalizes ms and µs", () => {
    const msg = decodeFeishuEvent(
      messageEnvelope("m", "@_user_1 hello", { mentions: true, threadId: "thread", chatType: "group" }),
      "cli_test",
    );
    expect(msg).toMatchObject({
      kind: "message",
      message: { senderOpenId: OWNER, text: "hello", threadId: "thread", createdAt: NOW },
    });
    const callback = decodeFeishuEvent(callbackEnvelope("x".repeat(22)), "cli_test");
    expect(callback).toMatchObject({ kind: "callback", callback: { senderOpenId: OWNER, createdAt: NOW } });
  });
  it.each(["header-app", "header-tenant", "sender-tenant", "operator-tenant", "operator-app", "sender-app"])(
    "rejects %s consistency violations",
    (where) => {
      const e: any = where.startsWith("operator") ? callbackEnvelope("n".repeat(22)) : messageEnvelope();
      if (where === "header-app") e.header.app_id = "cli_other";
      if (where === "header-tenant") e.header.tenant_key = "";
      if (where === "sender-tenant") e.event.sender.tenant_key = "other";
      if (where === "sender-app") e.event.sender.app_id = "cli_other";
      if (where === "operator-tenant") e.event.operator.tenant_key = "other";
      if (where === "operator-app") e.event.operator.app_id = "cli_other";
      expect(decodeFeishuEvent(e, "cli_test").kind).toBe("drop");
    },
  );
  it.each(["schema", "event-id", "content", "open-id", "chat-type", "callback-target"])(
    "fails closed on malformed %s",
    (where) => {
      const e: any = where === "callback-target" ? callbackEnvelope("x".repeat(22)) : messageEnvelope();
      if (where === "schema") e.schema = "1.0";
      if (where === "event-id") e.header.event_id = "bad/id";
      if (where === "content") e.event.message.content = "{";
      if (where === "open-id") {
        delete e.event.sender.sender_id.open_id;
        e.event.sender.sender_id.user_id = "user-id-not-identity";
      }
      if (where === "chat-type") e.event.message.chat_type = "unknown";
      if (where === "callback-target") e.event.action.value.target = "attacker-target";
      expect(decodeFeishuEvent(e, "cli_test").kind).toBe("drop");
    },
  );
  it("ACK/drops bot-added and unknown events without attempting a message decoder", async () => {
    const r = await f6Rig();
    const e: any = messageEnvelope();
    e.header.event_type = "im.chat.member.bot.added_v1";
    e.event = { chat_id: "chat" };
    expect(await r.inbound.handle(e)).toEqual({ ack: true, reason: "unsupported-event" });
    expect(r.request).not.toHaveBeenCalled();
  });
});
describe("F6 identity, dedup and ACK barrier", () => {
  it("ACKs only after singleton payload and both dedup keys are durable", async () => {
    const r = await f6Rig();
    let release!: (ok: boolean) => void;
    const commit = r.state.commit.bind(r.state);
    vi.spyOn(r.state, "commit").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const pending = r.inbound.handle(messageEnvelope()).then((x) => {
      settled = true;
      return x;
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(settled).toBe(false);
    expect(r.state.requests.list()).toHaveLength(1);
    expect(r.state.dedup.has("e:event-m1")).toBe(true);
    expect(r.state.dedup.has("m:m1")).toBe(true);
    expect(r.requests.bufferedChats).toBe(0);
    expect(r.request).not.toHaveBeenCalled();
    release(await commit());
    expect(await pending).toEqual({ ack: true, reason: "received" });
    expect(r.requests.bufferedChats).toBe(1);
  });
  it("does not ACK a memory-only duplicate when commit returns false", async () => {
    const r = await f6Rig();
    r.state.dedup.add("m:m1");
    vi.spyOn(r.state, "commit").mockResolvedValue(false);
    expect(await r.inbound.handle(messageEnvelope())).toEqual({ ack: false, reason: "duplicate" });
    expect(r.state.requests.list()).toHaveLength(0);
  });
  it("coalesces in-flight same-message/different-event copies while staging, without premature ACK", async () => {
    const r = await f6Rig();
    let ready!: () => void;
    const prepare = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        ready = resolve;
      });
      return {};
    });
    const inbound = createFeishuInbound({
      state: r.state,
      installation: r.install,
      admission: r.admission,
      allowGroups: true,
      staleMessageS: 300,
      now: r.clock.now,
      prepare,
      emit: () => {},
    });
    try {
      const p = inbound.handle(messageEnvelope());
      const second = messageEnvelope();
      second.header.event_id = "another-event";
      const q = inbound.handle(second);
      expect(q).toBe(p);
      expect(prepare).toHaveBeenCalledTimes(1);
      ready();
      expect(await p).toEqual({ ack: true, reason: "received" });
      expect(await q).toEqual({ ack: true, reason: "received" });
    } finally {
      inbound.dispose();
    }
  });
  it("dedups event and message ids, not text, and no duplicate consumes rate tokens", async () => {
    const r = await f6Rig();
    await r.inbound.handle(messageEnvelope("m1", "same"));
    const second = messageEnvelope("m1", "same");
    second.header.event_id = "new-event";
    expect((await r.inbound.handle(second)).reason).toBe("duplicate");
    expect((await r.inbound.handle(messageEnvelope("m2", "same"))).reason).toBe("received");
    expect(r.state.requests.list()).toHaveLength(2);
    expect(r.admit).not.toHaveBeenCalled();
  });
  it("TOFU pins only an owner user event, then rejects other tenants without a reply", async () => {
    const r = await f6Rig();
    await r.state.destroy();
    await r.state.load();
    await r.state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
    expect((await r.inbound.handle(messageEnvelope("stranger", "hello", { sender: OTHER }))).reason).toBe(
      "tenant-unpinned",
    );
    expect(r.state.tenant.get()).toBeUndefined();
    await r.inbound.handle(messageEnvelope("owner"));
    expect(r.state.tenant.get()).toBe("tenant");
    const count = r.inboundIntents.length;
    expect((await r.inbound.handle(messageEnvelope("cross", "hello", { tenant: "other" }))).reason).toBe(
      "tenant-mismatch",
    );
    expect(r.inboundIntents).toHaveLength(count);
  });
  it.each(["bot", "no-at", "groups-off", "stale", "unknown-time"])(
    "drops %s without an agent effect",
    async (reason) => {
      const r = await f6Rig({ groups: reason !== "groups-off" });
      const e = messageEnvelope("m", "hello", {
        chatType: reason === "no-at" || reason === "groups-off" ? "group" : "p2p",
        mentions: reason === "groups-off",
        createdAt: reason === "stale" ? String(NOW - 300_001) : reason === "unknown-time" ? "1234567890" : String(NOW),
      });
      if (reason === "bot") e.event.sender.sender_type = "app";
      const result = await r.inbound.handle(e);
      expect(result.ack).toBe(true);
      expect(result.reason).not.toBe("received");
      expect(r.state.requests.list()).toHaveLength(0);
      expect(r.request).not.toHaveBeenCalled();
    },
  );
  it("strangers get no reply; owner receives one approval intent per sender/24h, cap16", async () => {
    const r = await f6Rig();
    for (let i = 0; i < 18; i++)
      await r.inbound.handle(messageEnvelope(`s${i}`, "secret-body", { sender: `ou_stranger${i}` }));
    expect(r.inboundIntents).toHaveLength(16);
    expect(r.inboundIntents.every((i) => i.type === "approval-request" && i.ownerOpenId === OWNER)).toBe(true);
    await r.inbound.handle(messageEnvelope("again", "again", { sender: "ou_stranger0" }));
    expect(r.inboundIntents).toHaveLength(16);
    expect(r.state.requests.list()).toHaveLength(0);
    expect(JSON.stringify(r.audits)).not.toContain("secret-body");
    expect(JSON.stringify(r.audits)).not.toContain("ou_stranger");
  });
  it("approval nonces are owner/chat/message/gen/tenant-bound, one-shot; no target in card values", async () => {
    const r = await f6Rig();
    await r.inbound.handle(messageEnvelope("s", "hello", { sender: OTHER }));
    const card = await r.inbound.attachApproval({
      senderOpenId: OTHER,
      chatId: "owner-chat",
      messageId: "card",
      installGen: 1,
      tenantKey: "tenant",
    });
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expect(Object.keys(card.allow)).toEqual(["n"]);
    r.state.allowList.add("ou_attacker");
    expect(
      (await r.inbound.handle(callbackEnvelope(card.allow.n, { sender: "ou_attacker", id: "attack" }))).reason,
    ).toBe("nonce-mismatch");
    expect((await r.inbound.handle(callbackEnvelope(card.allow.n, { messageId: "wrong", id: "wrong" }))).reason).toBe(
      "nonce-mismatch",
    );
    expect(r.state.allowList.has(OTHER)).toBe(false);
    expect((await r.inbound.handle(callbackEnvelope(card.allow.n, { id: "good" }))).ack).toBe(true);
    expect(r.state.allowList.has(OTHER)).toBe(true);
    expect(r.inboundIntents.at(-1)).toMatchObject({ type: "approval-decided", allowed: true });
    expect((await r.inbound.handle(callbackEnvelope(card.allow.n, { id: "replay" }))).reason).toBe("nonce-unknown");
  });
  it("Allow rechecks current owner, expiry, and allow-list capacity", async () => {
    const r = await f6Rig();
    await r.inbound.handle(messageEnvelope("s", "hi", { sender: OTHER }));
    const card = await r.inbound.attachApproval({
      senderOpenId: OTHER,
      chatId: "owner-chat",
      messageId: "card",
      installGen: 1,
      tenantKey: "tenant",
    });
    if (!card.ok) throw new Error("card");
    for (let i = 0; i < 31; i++) r.state.allowList.add(`ou_user${i}`);
    expect((await r.inbound.handle(callbackEnvelope(card.allow.n))).reason).toBe("allow-list-full");
    expect(r.state.allowList.has(OTHER)).toBe(false);
  });
  it("dedup-full stops ACKing; queue-full ACKs with a durable notice instead of losing work", async () => {
    const r = await f6Rig();
    const receive = vi.spyOn(r.requests, "receive").mockReturnValue({ ok: false, refused: "budget" });
    expect((await r.inbound.handle(messageEnvelope())).ack).toBe(true);
    expect(r.intents.at(-1)).toMatchObject({ type: "notice", code: "queue-full" });
    receive.mockRestore();
    vi.spyOn(r.state.dedup, "add").mockReturnValue({ ok: false, refused: "cap" });
    expect(await r.inbound.handle(messageEnvelope("another"))).toEqual({ ack: false, reason: "dedup-full" });
  });
  it("a commit-failed receive is released exactly once when a duplicate later commits", async () => {
    const r = await f6Rig();
    const realCommit = r.state.commit.bind(r.state);
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    expect(await r.inbound.handle(messageEnvelope())).toEqual({ ack: false, reason: "persist-failed" });
    expect(r.requests.bufferedChats).toBe(0);
    await realCommit();
    expect(await r.inbound.handle(messageEnvelope())).toEqual({ ack: true, reason: "duplicate" });
    expect(r.requests.bufferedChats).toBe(1);
    expect(await r.inbound.handle(messageEnvelope())).toEqual({ ack: true, reason: "duplicate" });
    await r.requests.flushChat("chat");
    expect(r.request).toHaveBeenCalledTimes(1);
  });

  it("preserves plain message whitespace and does not coalesce app-mismatched events", async () => {
    const r = await f6Rig();
    const text = "  exact body  ";
    await r.inbound.handle(messageEnvelope("spaces", text));
    expect(r.state.requests.list()[0]?.payload?.body).toBe(text);
    expect(await r.inbound.handle(messageEnvelope("spaces", "evil", { app: "wrong" }))).toEqual({
      ack: true,
      reason: "app-mismatch",
    });
    expect(r.state.requests.list()).toHaveLength(1);
  });
  it("an allowed-then-denied stranger cannot generate a second approval inside 24h", async () => {
    const r = await f6Rig();
    await r.inbound.handle(messageEnvelope("first", "hi", { sender: OTHER }));
    const card = await r.inbound.attachApproval({
      senderOpenId: OTHER,
      chatId: "owner-chat",
      messageId: "card",
      installGen: 1,
      tenantKey: "tenant",
    });
    if (!card.ok) throw new Error("card");
    await r.inbound.handle(callbackEnvelope(card.allow.n));
    r.state.allowList.remove(OTHER);
    await r.inbound.handle(messageEnvelope("second", "hi", { sender: OTHER }));
    expect(r.inboundIntents.filter((i) => i.type === "approval-request")).toHaveLength(1);
  });

  it("stale group messages without @ never cause a notice outside a topic", async () => {
    const r = await f6Rig();
    await r.inbound.handle(
      messageEnvelope("stalegroup", "old", { chatType: "group", createdAt: String(NOW - 300_001) }),
    );
    expect(r.inboundIntents).toHaveLength(0);
  });

  it("dialog action data survives as an untrusted F8 intent, not authorization", async () => {
    const r = await f6Rig();
    const nonce = r.state.nonces.issue({
      installGen: 1,
      tenantKey: "tenant",
      operatorOpenId: OWNER,
      chatId: "owner-chat",
      messageId: "card",
      action: "dialog-answer",
      target: "dialog-1",
    });
    if (!nonce.ok) throw new Error("nonce");
    const raw = callbackEnvelope(nonce.value.nonce);
    Object.assign(raw.event.action, { form_value: { selected: "x" } });
    await r.inbound.handle(raw);
    expect(r.inboundIntents[0]).toMatchObject({
      type: "action",
      record: { action: "dialog-answer", target: "dialog-1" },
      action: { form_value: { selected: "x" } },
    });
    expect(JSON.stringify(r.audits)).not.toContain("selected");
  });
  it("20k same-tenant stranger messages never consume durable dedup or block an owner ACK", async () => {
    const r = await f6Rig();
    for (let i = 0; i < 20_000; i++) {
      const result = await r.inbound.handle(messageEnvelope(`flood-${i}`, "untrusted", { sender: OTHER }));
      expect(result.ack).toBe(true);
    }
    expect(r.state.dedup.size).toBe(0);
    expect(r.inbound.stats().drops).toBeLessThanOrEqual(FEISHU_INBOUND_TRANSIENT.dropMax);
    expect(r.inbound.stats().inflight).toBe(0);
    expect(r.inboundIntents.filter((i) => i.type === "approval-request")).toHaveLength(1);
    expect(await r.inbound.handle(messageEnvelope("owner-after-flood"))).toEqual({ ack: true, reason: "received" });
    expect(r.state.dedup.size).toBe(2);
    expect(r.state.requests.list()).toHaveLength(1);
  }, 20_000);

  it("concurrent unauthorized deliveries do not occupy the authorized inflight admission slots", async () => {
    const r = await f6Rig();
    const flood = Array.from({ length: 600 }, (_, i) =>
      r.inbound.handle(messageEnvelope(`parallel-${i}`, "x", { sender: OTHER })),
    );
    const owner = await r.inbound.handle(messageEnvelope("owner-in-parallel"));
    expect(owner).toEqual({ ack: true, reason: "received" });
    expect((await Promise.all(flood)).every((x) => x.ack)).toBe(true);
    expect(r.state.dedup.size).toBe(2);
  });

  it("no-@, non-user and stale-without-notice drops use no durable dedup slots", async () => {
    const r = await f6Rig();
    const noAt = messageEnvelope("no-at", "x", { chatType: "group" });
    const bot = messageEnvelope("non-user");
    bot.event.sender.sender_type = "app";
    const stale = messageEnvelope("stale-no-notice", "x", { chatType: "group", createdAt: String(NOW - 300_001) });
    for (const raw of [noAt, bot, stale]) expect((await r.inbound.handle(raw)).ack).toBe(true);
    expect(r.state.dedup.size).toBe(0);
    expect(r.inboundIntents).toHaveLength(0);
  });

  it("drop suppression evicts/expunges entries and never hides a newly allowed sender", async () => {
    const r = await f6Rig();
    const cache = new FeishuDropCache(r.clock.now);
    for (let i = 0; i <= FEISHU_INBOUND_TRANSIENT.dropMax; i++) cache.remember(`drop-${i}`);
    expect(cache.size).toBe(FEISHU_INBOUND_TRANSIENT.dropMax);
    expect(cache.has("drop-0")).toBe(false);
    r.clock.advance(FEISHU_INBOUND_TRANSIENT.dropTtlMs);
    expect(cache.size).toBe(0);
    const raw = messageEnvelope("now-allowed", "x", { sender: OTHER, createdAt: String(r.clock.now()) });
    await r.inbound.handle(raw);
    expect((await r.inbound.handle(raw)).reason).toBe("duplicate-drop");
    r.state.allowList.add(OTHER);
    expect((await r.inbound.handle(raw)).reason).toBe("received");
    expect(r.state.requests.list()[0]?.senderOpenId).toBe(OTHER);
  });

  it("pending deferred continuations expire, are cleaned up and signal degraded health", async () => {
    const r = await f6Rig();
    vi.spyOn(r.state, "commit").mockResolvedValueOnce(false);
    expect((await r.inbound.handle(messageEnvelope("pending-expiry"))).ack).toBe(false);
    expect(r.inbound.stats().pending).toBe(1);
    r.clock.advance(FEISHU_INBOUND_TRANSIENT.pendingTtlMs);
    expect(r.inbound.stats().pending).toBe(0);
    expect(r.health).toContainEqual({ degraded: true, reason: "pending-expired" });
    expect(r.requests.bufferedChats).toBe(0);
    expect(r.request).not.toHaveBeenCalled();
    expect(
      (await r.inbound.handle(messageEnvelope("later-owner", "hi", { createdAt: String(r.clock.now()) }))).ack,
    ).toBe(true);
  });

  it("unseen schema-2 message shapes persist undecodable evidence and signal degraded without content", async () => {
    const r = await f6Rig();
    const raw: any = messageEnvelope("unknown-shape", "DO-NOT-LOG-content");
    raw.event.message.chat_type = "topic_group";
    expect(await r.inbound.handle(raw)).toEqual({ ack: true, reason: "message-invalid" });
    expect(r.state.undecodable.snapshot()).toMatchObject({
      count: 1,
      ring: [{ reason: "im.message.receive_v1:message-invalid" }],
    });
    expect(r.health).toContainEqual({
      degraded: true,
      reason: "undecodable-events",
      eventType: "im.message.receive_v1",
      code: "message-invalid",
    });
    expect(JSON.stringify([r.audits, r.health, r.state.undecodable.snapshot()])).not.toContain("DO-NOT-LOG");
    expect(r.state.dedup.size).toBe(0);
  });

  it("approval attachment is idempotent on the same card, rejects moving it, and survives reload", async () => {
    const r = await f6Rig();
    await r.inbound.handle(messageEnvelope("approval", "x", { sender: OTHER }));
    const input = { senderOpenId: OTHER, chatId: "owner-chat", messageId: "card", installGen: 1, tenantKey: "tenant" };
    const [first, second] = await Promise.all([r.inbound.attachApproval(input), r.inbound.attachApproval(input)]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(r.state.nonces.size).toBe(2);
    expect(await r.inbound.attachApproval({ ...input, messageId: "different-card" })).toEqual({
      ok: false,
      code: "approval-attached",
    });
    expect(r.state.nonces.size).toBe(2);
    const boot = createFeishuState({ dir: r.dir, groupCommitMs: 0, clock: { ...systemFeishuClock, now: r.clock.now } });
    await boot.load();
    const resumed = createFeishuInbound({
      state: boot,
      installation: r.install,
      admission: r.admission,
      allowGroups: true,
      staleMessageS: 300,
      now: r.clock.now,
      prepare: () => ({}),
      emit: () => {},
    });
    try {
      expect(await resumed.attachApproval(input)).toEqual(first);
      expect(boot.nonces.size).toBe(2);
    } finally {
      resumed.dispose();
      boot.dispose();
    }
  });

  it("a partially issued approval pair rolls back the unexposed nonce", async () => {
    const r = await f6Rig();
    await r.inbound.handle(messageEnvelope("approval-partial", "x", { sender: OTHER }));
    const issue = r.state.nonces.issue.bind(r.state.nonces);
    vi.spyOn(r.state.nonces, "issue").mockImplementationOnce(issue).mockReturnValueOnce({ ok: false, refused: "cap" });
    expect(
      await r.inbound.attachApproval({
        senderOpenId: OTHER,
        chatId: "owner-chat",
        messageId: "card",
        installGen: 1,
        tenantKey: "tenant",
      }),
    ).toEqual({ ok: false, code: "nonce-full" });
    expect(r.state.nonces.size).toBe(0);
  });
  it("uncommitted deferred continuations refuse at 256 instead of retaining an unbounded closure queue", async () => {
    const r = await f6Rig();
    vi.spyOn(r.state, "commit").mockResolvedValue(false);
    for (let i = 0; i < FEISHU_INBOUND_TRANSIENT.pendingMax; i++) {
      expect((await r.inbound.handle(messageEnvelope(`pending-cap-${i}`))).ack).toBe(false);
    }
    expect(r.inbound.stats().pending).toBe(FEISHU_INBOUND_TRANSIENT.pendingMax);
    expect(await r.inbound.handle(messageEnvelope("pending-cap-overflow"))).toEqual({
      ack: false,
      reason: "pending-full",
    });
    expect(r.inbound.stats().pending).toBe(FEISHU_INBOUND_TRANSIENT.pendingMax);
    expect(r.health).toContainEqual({ degraded: true, reason: "pending-full" });
    r.clock.advance(FEISHU_INBOUND_TRANSIENT.pendingTtlMs);
    expect(r.inbound.stats().pending).toBe(0);
  });
});
