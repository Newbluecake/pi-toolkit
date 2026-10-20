import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createFeishuApi } from "../../../../src/web-hub/hub/feishu/api.js";
import type { BootstrapFailure } from "../../../../src/web-hub/hub/feishu/api.js";
import { createFeishuHttp } from "../../../../src/web-hub/hub/feishu/http.js";
import type { FeishuFailure, FeishuHttpEvent, FeishuResult } from "../../../../src/web-hub/hub/feishu/http.js";
import { createTokenManager } from "../../../../src/web-hub/hub/feishu/token.js";
import { createFakeClock, createFakeFeishu, settle } from "../../../fixtures/feishu/fake-http.js";

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const MIB = 1024 * 1024;

function rig(opts: { base?: string; events?: FeishuHttpEvent[] } = {}) {
  const fake = createFakeFeishu();
  const clock = createFakeClock();
  const state = { creds: { appId: fake.appId, appSecret: fake.appSecret, gen: 1 } };
  let token: ReturnType<typeof createTokenManager>;
  const http = createFeishuHttp({
    apiBase: opts.base ?? "https://open.feishu.cn",
    fetch: fake.fetch,
    clock,
    secrets: () => [state.creds.appSecret, ...(token?.peek() ? [token.peek()!] : [])],
    ...(opts.events ? { onEvent: (e) => opts.events!.push(e) } : {}),
  });
  token = createTokenManager({ http, clock, credentials: () => state.creds });
  const api = createFeishuApi({ http, token });
  return { fake, clock, state, http, token, api };
}

function fail<T>(r: FeishuResult<T>): FeishuFailure {
  if (r.ok) throw new Error("expected failure");
  return r;
}
function ok<T>(r: FeishuResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.data;
}
function bfail(r: { ok: true } | BootstrapFailure): BootstrapFailure {
  if (r.ok) throw new Error("expected bootstrap failure");
  return r;
}

describe("bootstrap (§2.1)", () => {
  it("POSTs {AppID,AppSecret} with locale/charset headers and no bearer; returns url/ids/clamped config", async () => {
    const { fake, api } = rig();
    const r = await api.bootstrap({ appId: fake.appId, appSecret: fake.appSecret });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      serviceId: 33,
      deviceId: "7000000000000000001",
      config: { pingIntervalMs: 90_000, reconnectIntervalMs: 90_000, reconnectNonceMs: 25_000 },
    });
    expect(new URL(r.data.url).hostname).toBe("msg-frontier.feishu.cn");
    const c = fake.calls[0]!;
    expect(c).toMatchObject({ method: "POST", path: "/callback/ws/endpoint" });
    expect(c.json).toEqual({ AppID: fake.appId, AppSecret: fake.appSecret });
    expect(c.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(c.headers["locale"]).toBe("zh");
    expect(c.headers["authorization"]).toBeUndefined();
    expect(fake.callsTo("POST", TOKEN_PATH)).toHaveLength(0);
  });

  it("clamps hostile ClientConfig values", async () => {
    const { fake, api } = rig();
    fake.on("POST", "/callback/ws/endpoint", () => ({
      json: {
        code: 0,
        data: {
          URL: "wss://msg-frontier.feishu.cn/ws?device_id=d&service_id=1",
          ClientConfig: { PingInterval: 0.001, ReconnectInterval: 1e9, ReconnectNonce: -5 },
        },
      },
    }));
    const r = await api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" });
    expect(r.ok && r.data.config).toEqual({
      pingIntervalMs: 10_000,
      reconnectIntervalMs: 600_000,
      reconnectNonceMs: 0,
    });
  });

  it.each([
    [1, "retry"],
    [1000040343, "retry"],
    [1000040350, "conn_limit"],
    [514, "auth_failed"],
    [403, "auth_failed"],
    [10003, "auth_failed"],
    [10014, "auth_failed"],
    [1000040345, "auth_failed"],
    [777, "auth_failed"],
  ])("code %i ⇒ %s (carries code + sanitized msg)", async (code, cls) => {
    const { fake, api } = rig();
    fake.on("POST", "/callback/ws/endpoint", () => ({ json: { code, msg: "why" } }));
    const f = bfail(await api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" }));
    expect(f).toMatchObject({ class: cls, code, reason: `api-code-${code}`, msg: "why" });
  });

  it("wrong secret against the fake tenant (V11) ⇒ auth_failed 1000040345", async () => {
    const { fake, api } = rig();
    expect(bfail(await api.bootstrap({ appId: fake.appId, appSecret: "nope-nope-nope" })).class).toBe("auth_failed");
  });

  it("transport / timeout / 5xx / code-less 4xx ⇒ retry; abort ⇒ aborted", async () => {
    const { fake, clock, api } = rig();
    fake.script(
      "POST",
      "/callback/ws/endpoint",
      { networkError: true },
      { status: 503, text: "x" },
      { status: 403, text: "<html>waf</html>" },
      { hang: true },
      { hang: true },
    );
    const p = { appId: "a", appSecret: "secret-xxxxx" };
    expect(bfail(await api.bootstrap(p))).toMatchObject({ class: "retry", reason: "unreachable" });
    expect(bfail(await api.bootstrap(p))).toMatchObject({ class: "retry", reason: "http-503" });
    expect(bfail(await api.bootstrap(p))).toMatchObject({ class: "retry", reason: "http-403" });
    const t = api.bootstrap(p);
    await settle(2);
    clock.advance(8_000); // FEISHU_BOOTSTRAP.timeoutMs
    expect(bfail(await t)).toMatchObject({ class: "retry", reason: "timeout" });
    const ac = new AbortController();
    const a = api.bootstrap({ ...p, signal: ac.signal });
    await settle(2);
    ac.abort();
    expect(bfail(await a).class).toBe("aborted");
  });

  it.each([
    "ws://msg-frontier.feishu.cn/ws?device_id=d&service_id=1",
    "wss://evil.example/ws?device_id=d&service_id=1",
    "wss://feishu.cn/ws?device_id=d&service_id=1",
    "wss://msg-frontier.feishu.cn.evil.com/ws?device_id=d&service_id=1",
    "wss://msg-frontier.feishu.cn:8443/ws?device_id=d&service_id=1",
    "wss://u:p@msg-frontier.feishu.cn/ws?device_id=d&service_id=1",
    "wss://192.168.0.1/ws?device_id=d&service_id=1",
  ])("refuses a returned WS URL outside the allowlist: %s", async (URL) => {
    const { fake, api } = rig();
    fake.on("POST", "/callback/ws/endpoint", () => ({ json: { code: 0, data: { URL, ClientConfig: {} } } }));
    const f = bfail(await api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" }));
    expect(f).toMatchObject({ class: "refused", reason: "ws-url-not-allowed" });
    expect(JSON.stringify(f)).not.toContain("evil");
  });

  it.each([
    "wss://msg-frontier.feishu.cn/ws?device_id=d",
    "wss://msg-frontier.feishu.cn/ws?service_id=1",
    "wss://msg-frontier.feishu.cn/ws?device_id=d&service_id=abc",
    "wss://msg-frontier.feishu.cn/ws?device_id=d&service_id=2147483648",
    "wss://msg-frontier.feishu.cn/ws?device_id=&service_id=1",
  ])("missing/invalid service_id/device_id ⇒ retry (protocol): %s", async (URL) => {
    const { fake, api } = rig();
    fake.on("POST", "/callback/ws/endpoint", () => ({ json: { code: 0, data: { URL } } }));
    expect(bfail(await api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" }))).toMatchObject({
      class: "retry",
      reason: "protocol:endpoint-missing-ids",
    });
  });

  it("a missing data member and non-string URL are refused; a bad base is refused without a fetch", async () => {
    const { fake, api } = rig();
    fake.script("POST", "/callback/ws/endpoint", { json: { code: 0 } }, { json: { code: 0, data: { URL: 7 } } });
    expect(bfail(await api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" })).class).toBe("refused");
    expect(bfail(await api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" })).class).toBe("refused");
    const bad = rig({ base: "https://evil.example" });
    expect(bfail(await bad.api.bootstrap({ appId: "a", appSecret: "secret-xxxxx" })).class).toBe("refused");
    expect(bad.fake.calls).toHaveLength(0);
    expect(bfail(await api.bootstrap({ appId: "", appSecret: "x" })).class).toBe("refused");
  });

  it("the app secret and the WS ticket never appear in a failure, even when the platform echoes them", async () => {
    const { fake, api } = rig();
    fake.on("POST", "/callback/ws/endpoint", () => ({
      json: { code: 514, msg: `bad ${fake.appSecret} wss://msg-frontier.feishu.cn/ws?ticket=TKT999` },
    }));
    const f = bfail(await api.bootstrap({ appId: fake.appId, appSecret: fake.appSecret }));
    expect(JSON.stringify(f)).not.toMatch(new RegExp(`${fake.appSecret}|TKT999`));
  });
});

describe("send / reply", () => {
  it("send: probe-verified request shape; bearer from the token cache; typed result", async () => {
    const { fake, api } = rig();
    const r = ok(
      await api.send({
        receiveIdType: "chat_id",
        receiveId: "oc_1",
        msgType: "text",
        content: '{"text":"hi"}',
        uuid: "u-1",
      }),
    );
    expect(r).toMatchObject({ chatId: "oc_1" });
    expect(r.messageId).toMatch(/^om_fake_/);
    const c = fake.callsTo("POST", "/open-apis/im/v1/messages")[0]!;
    expect(c.query).toEqual({ receive_id_type: "chat_id" });
    expect(c.json).toEqual({ receive_id: "oc_1", msg_type: "text", content: '{"text":"hi"}', uuid: "u-1" });
    expect(c.headers["authorization"]).toMatch(/^Bearer t-fake1/);
  });

  it("open_id receive type works; the same uuid yields the same message (platform idempotency modelled)", async () => {
    const { fake, api } = rig();
    const p = {
      receiveIdType: "open_id" as const,
      receiveId: "ou_abc",
      msgType: "text" as const,
      content: "{}",
      uuid: "same",
    };
    const a = ok(await api.send(p));
    const b = ok(await api.send(p));
    expect(b.messageId).toBe(a.messageId);
    expect(fake.sent).toHaveLength(1);
    expect(fake.calls.find((c) => c.path.endsWith("/messages"))!.query).toEqual({ receive_id_type: "open_id" });
  });

  it("reply: path-encoded id, reply_in_thread only when true, thread_id surfaced (V8)", async () => {
    const { fake, api } = rig();
    const plain = ok(await api.reply({ messageId: "om_a.b-c", msgType: "text", content: "{}", uuid: "r1" }));
    expect(plain.threadId).toBeUndefined();
    expect(fake.callsTo("POST", "/reply")[0]!.json).toEqual({ msg_type: "text", content: "{}", uuid: "r1" });
    const th = ok(
      await api.reply({ messageId: "om_a", msgType: "interactive", content: "{}", uuid: "r2", replyInThread: true }),
    );
    expect(th).toMatchObject({ threadId: "omt_fake_om_a", rootId: "om_a" });
    expect(fake.callsTo("POST", "/reply")[1]!.json).toMatchObject({ reply_in_thread: true, msg_type: "interactive" });
    expect(fake.callsTo("POST", "/reply")[1]!.path).toBe("/open-apis/im/v1/messages/om_a/reply");
  });

  it.each([
    ["receiveIdType", { receiveIdType: "user_id" }],
    ["receiveId", { receiveId: "" }],
    ["receiveId", { receiveId: "a/b" }],
    ["receiveId", { receiveId: "a?b" }],
    ["receiveId", { receiveId: ".." }],
    ["receiveId", { receiveId: "x".repeat(257) }],
    ["msgType", { msgType: "audio" }],
    ["content", { content: "" }],
    ["uuid", { uuid: "" }],
    ["uuid", { uuid: "x".repeat(51) }],
    ["uuid", { uuid: "bad uuid" }],
    ["card-too-large", { msgType: "interactive", content: "é".repeat(10_001) }],
  ])("send refuses bad %s locally (effect none, no network)", async (field, patch) => {
    const { fake, api } = rig();
    const f = fail(
      await api.send({
        receiveIdType: "chat_id",
        receiveId: "oc_1",
        msgType: "text",
        content: "{}",
        uuid: "u",
        ...patch,
      } as never),
    );
    expect(f).toMatchObject({ kind: "bad-request", reason: `bad-request:${field}`, effect: "none" });
    expect(fake.calls).toHaveLength(0);
  });

  it("card at the 20 000-byte cap is accepted, one byte over is refused (UTF-8 bytes, not chars)", async () => {
    const { api } = rig();
    const at = "x".repeat(20_000);
    expect(
      (await api.send({ receiveIdType: "chat_id", receiveId: "oc", msgType: "interactive", content: at, uuid: "a" }))
        .ok,
    ).toBe(true);
    expect(
      fail(
        await api.send({
          receiveIdType: "chat_id",
          receiveId: "oc",
          msgType: "interactive",
          content: at + "x",
          uuid: "b",
        }),
      ).reason,
    ).toBe("bad-request:card-too-large");
  });

  it("reply refuses a bad message id", async () => {
    const { api } = rig();
    expect(fail(await api.reply({ messageId: "om/../x", msgType: "text", content: "{}", uuid: "u" })).reason).toBe(
      "bad-request:messageId",
    );
  });

  it("send classification: 230020 / timeout / 5xx / unreachable ⇒ effect unknown; plain rejection ⇒ none", async () => {
    const { fake, clock, api } = rig();
    const p = {
      receiveIdType: "chat_id" as const,
      receiveId: "oc",
      msgType: "text" as const,
      content: "{}",
      uuid: "u",
    };
    fake.script(
      "POST",
      "/open-apis/im/v1/messages",
      { json: { code: 230020, msg: "frequency limit" } },
      { status: 502, text: "bad gateway" },
      { networkError: true },
      { json: { code: 230001, msg: "bad param" } },
      { hang: true },
    );
    expect(fail(await api.send(p))).toMatchObject({ code: 230020, effect: "unknown", retryable: true });
    expect(fail(await api.send(p))).toMatchObject({ reason: "http-502", effect: "unknown", retryable: true });
    expect(fail(await api.send(p))).toMatchObject({ reason: "unreachable", effect: "unknown" });
    expect(fail(await api.send(p))).toMatchObject({ code: 230001, effect: "none", retryable: false });
    const t = api.send(p);
    await settle(3);
    clock.advance(8_000);
    expect(fail(await t)).toMatchObject({ reason: "timeout", effect: "unknown" });
  });

  it("a 2xx without a message id is a protocol failure with effect unknown (the message may exist)", async () => {
    const { fake, api } = rig();
    fake.script("POST", "/open-apis/im/v1/messages", { json: { code: 0, data: {} } });
    expect(
      fail(await api.send({ receiveIdType: "chat_id", receiveId: "oc", msgType: "text", content: "{}", uuid: "u" })),
    ).toMatchObject({ kind: "protocol", effect: "unknown" });
  });

  it.each([99991672, 230027])("code %i is flagged capabilityDenied (§4 runtime capability probing)", async (code) => {
    const { fake, api } = rig();
    fake.script("POST", /\/reactions$/, { status: 400, json: { code, msg: "need im:message.reactions:write_only" } });
    const f = fail(await api.addReaction({ messageId: "om_1", emojiType: "Typing" }));
    expect(f).toMatchObject({ capabilityDenied: true, code, scopes: ["im:message.reactions:write_only"] });
  });
});

describe("token integration", () => {
  it("a stale token (99991663) is invalidated and the call repeated ONCE with a fresh token", async () => {
    const { fake, api } = rig();
    await api.botInfo(); // issue token #1
    fake.expireTokens();
    const r = await api.send({ receiveIdType: "chat_id", receiveId: "oc", msgType: "text", content: "{}", uuid: "u" });
    expect(r.ok).toBe(true);
    expect(fake.tokensIssued()).toBe(2);
    expect(fake.callsTo("POST", "/open-apis/im/v1/messages")).toHaveLength(2);
    expect(fake.sent).toHaveLength(1);
  });

  it.each([99991663, 99991664])("code %i twice ⇒ exactly one retry, then the failure surfaces", async (code) => {
    const { fake, api } = rig();
    fake.on("POST", "/open-apis/im/v1/messages", () => ({ status: 400, json: { code, msg: "invalid" } }));
    const f = fail(
      await api.send({ receiveIdType: "chat_id", receiveId: "oc", msgType: "text", content: "{}", uuid: "u" }),
    );
    expect(f).toMatchObject({ code, effect: "none" });
    expect(fake.callsTo("POST", "/open-apis/im/v1/messages")).toHaveLength(2);
    expect(fake.tokensIssued()).toBe(2);
  });

  it("wrong credentials ⇒ kind auth/auth_failed, and NO im call is ever made", async () => {
    const { fake, state, api } = rig();
    state.creds = { ...state.creds, appSecret: "wrong-wrong-wrong-wrong" };
    const f = fail(
      await api.send({ receiveIdType: "chat_id", receiveId: "oc", msgType: "text", content: "{}", uuid: "u" }),
    );
    expect(f).toMatchObject({ kind: "auth", auth: "auth_failed", code: 10014, effect: "none" });
    expect(fake.calls.filter((c) => c.path.startsWith("/open-apis/im"))).toHaveLength(0);
  });

  it("unconfigured (reset) ⇒ auth/unconfigured with no network at all", async () => {
    const { fake, token, api } = rig();
    token.dispose();
    expect(fail(await api.botInfo())).toMatchObject({ kind: "auth", auth: "unconfigured" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("patchCard", () => {
  it("PATCHes {content} to the message", async () => {
    const { fake, api } = rig();
    const card = JSON.stringify({ schema: "2.0", config: { update_multi: true } });
    expect((await api.patchCard({ messageId: "om_9", card })).ok).toBe(true);
    const c = fake.callsTo("PATCH", "/open-apis/im/v1/messages/om_9")[0]!;
    expect(c.json).toEqual({ content: card });
  });
  it("refuses empty / oversize cards and bad ids locally", async () => {
    const { fake, api } = rig();
    expect(fail(await api.patchCard({ messageId: "om_9", card: "" })).reason).toBe("bad-request:card");
    expect(fail(await api.patchCard({ messageId: "om_9", card: "x".repeat(20_001) })).reason).toBe(
      "bad-request:card-too-large",
    );
    expect(fail(await api.patchCard({ messageId: "", card: "{}" })).reason).toBe("bad-request:messageId");
    expect(fake.calls).toHaveLength(0);
  });
  it("surfaces api failures (e.g. expired card)", async () => {
    const { fake, api } = rig();
    fake.script("PATCH", /messages\/om_9$/, { status: 400, json: { code: 230099, msg: "card expired" } });
    expect(fail(await api.patchCard({ messageId: "om_9", card: "{}" }))).toMatchObject({
      code: 230099,
      effect: "none",
    });
  });
});

describe("deleteMessage", () => {
  const path = "/open-apis/im/v1/messages/om_9";
  it("recalls the bot message with DELETE, bearer and no body, including a single token refresh", async () => {
    const { fake, api } = rig();
    await api.botInfo();
    fake.expireTokens();
    expect(await api.deleteMessage({ messageId: "om_9" })).toEqual({ ok: true, data: undefined });
    const calls = fake.callsTo("DELETE", path);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: "DELETE", path, json: undefined, redirect: "error" });
    expect(calls[1]!.headers["authorization"]).toMatch(/^Bearer t-fake2/);
    expect(fake.tokensIssued()).toBe(2);
  });
  it.each(["", "..", "om/escape", "x".repeat(257)])(
    "invalid message id %s never touches the network",
    async (messageId) => {
      const { fake, api } = rig();
      expect(fail(await api.deleteMessage({ messageId }))).toMatchObject({
        reason: "bad-request:messageId",
        effect: "none",
      });
      expect(fake.calls).toHaveLength(0);
    },
  );
  it.each([230027, 230099])("permission/age rejection %i is mapped and not retried", async (code) => {
    const { fake, api } = rig();
    fake.script("DELETE", path, { status: 400, json: { code, msg: `denied ${fake.appSecret}` } });
    const result = fail(await api.deleteMessage({ messageId: "om_9" }));
    expect(result).toMatchObject({ kind: "api", code, effect: "none", retryable: false });
    expect(JSON.stringify(result)).not.toContain(fake.appSecret);
    expect(fake.callsTo("DELETE", path)).toHaveLength(1);
  });
  it("network and deadline failures surface without retries or sensitive event fields", async () => {
    const events: FeishuHttpEvent[] = [];
    const { fake, api, clock } = rig({ events });
    fake.script("DELETE", path, { networkError: true }, { hang: true });
    expect(fail(await api.deleteMessage({ messageId: "om_9" }))).toMatchObject({
      reason: "unreachable",
      effect: "unknown",
    });
    const pending = api.deleteMessage({ messageId: "om_9", timeoutMs: 100 });
    await settle(4);
    clock.advance(100);
    expect(fail(await pending)).toMatchObject({ reason: "timeout", effect: "unknown" });
    expect(fake.callsTo("DELETE", path)).toHaveLength(2);
    expect(events.filter((e) => e.op === "delete-message")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/om_9|Bearer|t-fake|secret/);
  });
});

describe("reactions", () => {
  it("add sends {reaction_type:{emoji_type}} and returns reaction_id; delete targets it", async () => {
    const { fake, api } = rig();
    const { reactionId } = ok(await api.addReaction({ messageId: "om_1", emojiType: "Typing" }));
    expect(fake.callsTo("POST", "/reactions")[0]!.json).toEqual({ reaction_type: { emoji_type: "Typing" } });
    expect((await api.deleteReaction({ messageId: "om_1", reactionId })).ok).toBe(true);
    expect(fake.callsTo("DELETE", "/reactions/")[0]!.path).toBe(
      `/open-apis/im/v1/messages/om_1/reactions/${reactionId}`,
    );
  });
  it("validates emoji / ids locally; a response without reaction_id is a protocol failure", async () => {
    const { fake, api } = rig();
    expect(fail(await api.addReaction({ messageId: "om_1", emojiType: "bad emoji" })).reason).toBe(
      "bad-request:emojiType",
    );
    expect(fail(await api.deleteReaction({ messageId: "om_1", reactionId: "a/b" })).reason).toBe(
      "bad-request:reactionId",
    );
    expect(fake.calls).toHaveLength(0);
    fake.script("POST", /\/reactions$/, { json: { code: 0, data: {} } });
    expect(fail(await api.addReaction({ messageId: "om_1", emojiType: "Typing" })).kind).toBe("protocol");
  });
});

describe("uploads (multipart)", () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

  it("uploadImage: image_type=message + named part; returns image_key", async () => {
    const { fake, api } = rig();
    const { imageKey } = ok(await api.uploadImage({ bytes: png, fileName: "shot.png" }));
    expect(imageKey).toMatch(/^img_v3_fake_/);
    const c = fake.callsTo("POST", "/open-apis/im/v1/images")[0]!;
    expect(c.form).toEqual({
      fields: { image_type: "message" },
      file: { field: "image", name: "shot.png", size: 7, type: "" },
    });
    expect(c.headers["content-type"]).toBeUndefined(); // fetch derives the multipart boundary itself
    expect(c.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("uploadFile: file_type defaults to stream; name carried in both fields; Blob input and explicit type", async () => {
    const { fake, api } = rig();
    expect(
      ok(await api.uploadFile({ bytes: new Blob(["hello"], { type: "text/plain" }), fileName: "a b.txt" })).fileKey,
    ).toMatch(/^file_v3_fake_/);
    expect((await api.uploadFile({ bytes: png, fileName: "d.pdf", fileType: "pdf" })).ok).toBe(true);
    const [a, b] = fake.callsTo("POST", "/open-apis/im/v1/files");
    expect(a!.form).toEqual({
      fields: { file_type: "stream", file_name: "a b.txt" },
      file: { field: "file", name: "a b.txt", size: 5, type: "text/plain" },
    });
    expect(b!.form!.fields["file_type"]).toBe("pdf");
  });

  it("size caps: empty ⇒ refused, image > 10 MiB, file > 30 MiB (no network)", async () => {
    const { fake, api } = rig();
    const sized = (n: number) => Object.defineProperty(new Blob(["x"]), "size", { value: n });
    expect(fail(await api.uploadImage({ bytes: new Uint8Array() })).reason).toBe("bad-request:empty");
    expect(fail(await api.uploadImage({ bytes: sized(10 * MIB + 1) })).reason).toBe("bad-request:image-too-large");
    expect(fail(await api.uploadFile({ bytes: sized(30 * MIB + 1), fileName: "x" })).reason).toBe(
      "bad-request:file-too-large",
    );
    expect(fail(await api.uploadFile({ bytes: new Uint8Array(), fileName: "x" })).reason).toBe("bad-request:empty");
    expect(fake.calls).toHaveLength(0);
    expect((await api.uploadImage({ bytes: sized(10 * MIB) })).ok).toBe(true);
    expect((await api.uploadFile({ bytes: sized(30 * MIB), fileName: "x" })).ok).toBe(true);
  });

  it.each(["", "a/b", "a\\b", "..", "a\u0000b", "é".repeat(128)])("refuses file name %j", async (fileName) => {
    const { fake, api } = rig();
    expect(fail(await api.uploadFile({ bytes: png, fileName })).reason).toBe("bad-request:fileName");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an unknown file_type; a response without a key is a protocol failure", async () => {
    const { fake, api } = rig();
    expect(fail(await api.uploadFile({ bytes: png, fileName: "x", fileType: "exe" as never })).reason).toBe(
      "bad-request:fileType",
    );
    fake.script("POST", "/open-apis/im/v1/images", { json: { code: 0, data: {} } });
    fake.script("POST", "/open-apis/im/v1/files", { json: { code: 0, data: {} } });
    expect(fail(await api.uploadImage({ bytes: png })).reason).toBe("protocol:missing-image-key");
    expect(fail(await api.uploadFile({ bytes: png, fileName: "x" })).reason).toBe("protocol:missing-file-key");
  });

  it("a stale token on an upload re-sends the form once (fresh FormData per attempt)", async () => {
    const { fake, api } = rig();
    await api.botInfo();
    fake.expireTokens();
    expect((await api.uploadFile({ bytes: png, fileName: "x" })).ok).toBe(true);
    const calls = fake.callsTo("POST", "/open-apis/im/v1/files");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.form!.file!.size).toBe(7);
  });

  it("uploads default to a 30 s deadline, not the 8 s call default", async () => {
    const { fake, clock, api } = rig();
    await api.botInfo();
    fake.script("POST", "/open-apis/im/v1/files", { hang: true });
    const p = api.uploadFile({ bytes: png, fileName: "x" });
    await settle(3);
    clock.advance(8_000);
    await settle(2);
    expect(fake.callsTo("POST", "/files")[0]!.signal!.aborted).toBe(false);
    clock.advance(22_000);
    expect(fail(await p)).toMatchObject({ reason: "timeout", effect: "unknown" });
  });
});

describe("downloadResource", () => {
  const sink = () => {
    const got: Uint8Array[] = [];
    return { got, fn: (c: Uint8Array) => void got.push(c), total: () => got.reduce((n, c) => n + c.length, 0) };
  };

  it("streams a resource through the sink (type in the query, key encoded in the path)", async () => {
    const { fake, api } = rig();
    fake.resources.set("img_v3_k", { bytes: new Uint8Array(1000).fill(9), contentType: "image/png" });
    const s = sink();
    const r = ok(
      await api.downloadResource({ messageId: "om_1", fileKey: "img_v3_k", type: "image", maxBytes: 4096, sink: s.fn }),
    );
    expect(r).toEqual({ bytes: 1000, contentType: "image/png" });
    expect(s.total()).toBe(1000);
    const c = fake.callsTo("GET", "/resources/")[0]!;
    expect(c.path).toBe("/open-apis/im/v1/messages/om_1/resources/img_v3_k");
    expect(c.query).toEqual({ type: "image" });
    expect(c.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("enforces the byte cap by Content-Length (nothing sunk) and by running count when length is absent", async () => {
    const { fake, api } = rig();
    fake.resources.set("a", { bytes: new Uint8Array(500) });
    fake.resources.set("b", { bytes: new Uint8Array(500), contentLength: false });
    const s1 = sink();
    expect(
      fail(await api.downloadResource({ messageId: "m", fileKey: "a", type: "file", maxBytes: 499, sink: s1.fn })).kind,
    ).toBe("too-large");
    expect(s1.got).toHaveLength(0);
    const s2 = sink();
    expect(
      fail(await api.downloadResource({ messageId: "m", fileKey: "b", type: "file", maxBytes: 499, sink: s2.fn })).kind,
    ).toBe("too-large");
  });

  it("platform errors surface as api failures with nothing sunk; a stale token retries once before any sink call", async () => {
    const { fake, api } = rig();
    const s = sink();
    expect(
      fail(await api.downloadResource({ messageId: "m", fileKey: "missing", type: "file", maxBytes: 10, sink: s.fn }))
        .code,
    ).toBe(234043);
    expect(s.got).toHaveLength(0);

    fake.resources.set("k", { bytes: new Uint8Array(3).fill(1) });
    await api.botInfo();
    fake.expireTokens();
    const s2 = sink();
    expect(
      (await api.downloadResource({ messageId: "m", fileKey: "k", type: "file", maxBytes: 10, sink: s2.fn })).ok,
    ).toBe(true);
    expect(s2.total()).toBe(3);
  });

  it("default deadline is the 30 s inbound per-file budget", async () => {
    const { fake, clock, api } = rig();
    await api.botInfo();
    fake.script("GET", /resources/, { chunks: [new Uint8Array(2)], hangAfter: true });
    const s = sink();
    const p = api.downloadResource({ messageId: "m", fileKey: "k", type: "file", maxBytes: 10, sink: s.fn });
    await settle(3);
    clock.advance(29_999);
    await settle(2);
    expect(fake.callsTo("GET", "/resources/")[0]!.signal!.aborted).toBe(false);
    clock.advance(1);
    expect(fail(await p).kind).toBe("timeout");
  });

  it("validates arguments locally", async () => {
    const { fake, api } = rig();
    const base = { messageId: "m", fileKey: "k", type: "file" as const, maxBytes: 10, sink: () => undefined };
    expect(fail(await api.downloadResource({ ...base, type: "audio" as never })).reason).toBe("bad-request:type");
    expect(fail(await api.downloadResource({ ...base, maxBytes: 0 })).reason).toBe("bad-request:maxBytes");
    expect(fail(await api.downloadResource({ ...base, maxBytes: Number.NaN })).reason).toBe("bad-request:maxBytes");
    expect(fail(await api.downloadResource({ ...base, fileKey: "a/b" })).reason).toBe("bad-request:fileKey");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("botInfo", () => {
  it("reads the TOP-LEVEL `bot` object (and tolerates data.bot)", async () => {
    const { fake, api } = rig();
    expect(ok(await api.botInfo())).toEqual({ openId: "ou_fakebot00000001", appName: "pi@fake-host" });
    fake.script("GET", "/open-apis/bot/v3/info", { json: { code: 0, data: { bot: { open_id: "ou_nested0001" } } } });
    expect(ok(await api.botInfo())).toEqual({ openId: "ou_nested0001" });
  });
  it("rejects a missing / non-open_id value as a protocol failure", async () => {
    const { fake, api } = rig();
    fake.script(
      "GET",
      "/open-apis/bot/v3/info",
      { json: { code: 0, bot: {} } },
      { json: { code: 0, bot: { open_id: "x y" } } },
    );
    expect(fail(await api.botInfo()).kind).toBe("protocol");
    expect(fail(await api.botInfo()).kind).toBe("protocol");
  });
});

describe("redaction proof across the whole surface", () => {
  it("no failure or event from any call contains the app secret, a live token, a WS ticket, an id or a URL", async () => {
    const events: FeishuHttpEvent[] = [];
    const { fake, api, token } = rig({ events });
    const live = ok(await api.botInfo());
    void live;
    const tok = token.peek()!;
    const hostile = `leak ${fake.appSecret} Bearer ${tok} ${tok} wss://msg-frontier.feishu.cn/ws?ticket=TKT000 https://open.feishu.cn/x`;
    for (const [m, p] of [
      ["POST", /\/messages$/],
      ["POST", /\/reply$/],
      ["PATCH", /\/messages\/[^/]+$/],
      ["POST", /\/reactions$/],
      ["DELETE", /\/reactions\//],
      ["POST", /\/images$/],
      ["POST", /\/files$/],
      ["GET", /\/resources\//],
      ["GET", /\/bot\/v3\/info$/],
      ["POST", /\/callback\/ws\/endpoint$/],
    ] as const) {
      fake.on(m, p, () => ({ status: 400, json: { code: 4001, msg: hostile } }));
    }
    const results: unknown[] = [
      await api.send({
        receiveIdType: "chat_id",
        receiveId: "oc_SECRETCHAT",
        msgType: "text",
        content: "{}",
        uuid: "u",
      }),
      await api.reply({ messageId: "om_SECRETMSG", msgType: "text", content: "{}", uuid: "u2" }),
      await api.patchCard({ messageId: "om_SECRETMSG", card: "{}" }),
      await api.addReaction({ messageId: "om_SECRETMSG", emojiType: "Typing" }),
      await api.deleteReaction({ messageId: "om_SECRETMSG", reactionId: "rx_SECRET" }),
      await api.uploadImage({ bytes: new Uint8Array([1]) }),
      await api.uploadFile({ bytes: new Uint8Array([1]), fileName: "x" }),
      await api.downloadResource({
        messageId: "om_SECRETMSG",
        fileKey: "img_SECRET",
        type: "image",
        maxBytes: 9,
        sink: () => undefined,
      }),
      await api.botInfo(),
      await api.bootstrap({ appId: fake.appId, appSecret: fake.appSecret }),
    ];
    for (const r of results) expect((r as { ok: boolean }).ok).toBe(false);
    const dump = JSON.stringify([results, events]);
    for (const leak of [
      fake.appSecret,
      tok,
      "TKT000",
      "msg-frontier",
      "SECRETCHAT",
      "SECRETMSG",
      "img_SECRET",
      "rx_SECRET",
      "https://",
      "wss://",
    ]) {
      expect(dump, `leaked ${leak}`).not.toContain(leak);
    }
  });
});

describe("frozen constants are imported, never re-declared", () => {
  const files = ["http", "token", "api"].map(
    (n) => [n, readFileSync(new URL(`../../../../src/web-hub/hub/feishu/${n}.ts`, import.meta.url), "utf8")] as const,
  );
  it.each(files)("%s.ts has no literal copy of a frozen code / origin / path", (_n, src) => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(?:99991663|99991664|1000040343|1000040345|1000040350|230020|99991672|230027|10014)\b/);
    expect(code).not.toMatch(/open\.feishu\.cn|open\.larksuite\.com|accounts\.feishu/);
    expect(code).not.toContain("/open-apis/auth/v3");
    expect(code).not.toContain("/callback/ws/endpoint");
  });
  it.each(files)("%s.ts reads no env and keeps no module-scope mutable state", (_n, src) => {
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/^(?:let|var)\s/m);
    expect(src).not.toMatch(/^\s*import .* from "node:/m);
  });
});
