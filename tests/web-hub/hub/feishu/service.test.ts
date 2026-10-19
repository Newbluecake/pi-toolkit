import { afterEach, describe, it, expect, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { f8Rig, eventually, sentContent } from "../../../fixtures/feishu/f8.js";
import { messageEnvelope, callbackEnvelope, OWNER, NOW } from "../../../fixtures/feishu/f6.js";
import { createFakeFeishu } from "../../../fixtures/feishu/fake-http.js";
import { realFeishuFs } from "../../../../src/web-hub/hub/feishu/credentials.js";
import type { CmdFrame, CmdResultFrame } from "../../../../src/web-hub/protocol/messages.js";
import { createFsAdmitter, denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
async function rig(...args: Parameters<typeof f8Rig>) {
  const r = await f8Rig(...args);
  cleanups.push(() => r.close());
  await r.ready();
  return r;
}
const prompt = (r: Awaited<ReturnType<typeof f8Rig>>) =>
  r.request.mock.calls.find(([f]) => f.cmd.op === "prompt" && !f.queryOnly)?.[0];

describe("F8 in-process service composition", () => {
  it("durable DM admission → frozen session route → token run → final chunks/outbox → ACK, Typing removed", async () => {
    const r = await rig();
    await r.bind();
    const before = r.fake.sent.length,
      acks = r.ackCount();
    r.send(messageEnvelope("work", "write a report"));
    await eventually(() => expect(prompt(r)).toBeDefined());
    const frame = prompt(r)!;
    expect(frame.cmd.op).toBe("prompt");
    if (frame.cmd.op !== "prompt") return;
    expect(frame.cmd.text).toMatch(/^\[飞书 · .* · .* · #[A-Za-z0-9_-]{12}\]\nwrite a report$/);
    await eventually(() => expect(r.ackCount()).toBe(acks + 1));
    expect((await r.disk())["requests"][frame.id].payload.body).toBe("write a report");
    await eventually(() => expect(r.fake.callsTo("POST", /reactions$/).length).toBe(1));
    r.consumed(frame.id);
    r.event({ type: "message_start", message: { role: "user", content: [{ type: "text", text: frame.cmd.text }] } });
    r.event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "段落\n\n".repeat(5_000) }], stopReason: "stop" },
    });
    r.event({ type: "agent_end" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(r.fake.sent.length).toBe(before);
    r.event({ type: "agent_settled" });
    await eventually(() => expect(r.fake.sent.length).toBeGreaterThan(before));
    await eventually(() => expect(r.fake.callsTo("DELETE", /reactions/).length).toBe(1));
    expect(sentContent(r)).toContain("One · sessio");
    expect(
      r.fake.sent
        .filter((s) => s.body["msg_type"] === "interactive")
        .every((s) => Buffer.byteLength(String(s.body["content"])) <= 20_000),
    ).toBe(true);
    await eventually(() => expect(r.service.snapshot().outbox.ok).toBeGreaterThan(1));
    expect(r.request).toHaveBeenCalledTimes(1);
  });
  it("a local prompt without a Feishu dialog card is not pushed (unanswerable from Feishu); compaction failure still is", async () => {
    const r = await rig();
    await r.bind();
    r.event({ type: "ui_prompt_start", kind: "select", title: "some other extension prompt" });
    r.event({ type: "ui_prompt_start", kind: "custom" });
    // Queued after the prompts on the same work queue: once its notice is out, any prompt notice
    // would already have been sent.
    r.event({ type: "session_compact_failed", willRetry: false });
    await eventually(() => expect(sentContent(r)).toContain("failed: 请到 web/终端查看"));
    expect(sentContent(r)).not.toContain("waiting:");
  });
  it("group /use and final reply remain thread-bound, never chat-send", async () => {
    const r = await rig();
    const options = { chatType: "group" as const, threadId: "thread-1", mentions: true };
    await r.bind(options);
    r.send(messageEnvelope("topic", "topic task", options));
    await eventually(() => expect(prompt(r)).toBeDefined());
    const f = prompt(r)!;
    if (f.cmd.op !== "prompt") return;
    r.finish(f.cmd.text, "topic result");
    await eventually(() => expect(sentContent(r)).toContain("topic result"));
    expect(r.fake.sent.every((s) => s.kind === "reply" && s.body["reply_in_thread"] === true)).toBe(true);
    expect(sentContent(r)).toContain(OWNER);
  });
  it("card callback answers the live ask_user through admission; replay cannot answer again", async () => {
    const r = await rig();
    await r.bind();
    r.send(messageEnvelope("ask-work", "choose"));
    await eventually(() => expect(prompt(r)).toBeDefined());
    r.emit({
      type: "dialogs",
      agentKey: "agent-1",
      epoch: "dialog-epoch",
      open: [
        {
          dialogId: "dialog-1",
          source: "ask_user",
          toolCallId: "tool-1",
          questions: [{ question: "Which?", options: [{ label: "Yes" }, { label: "No" }] }],
          allowCancel: true,
          openedAt: NOW,
        },
      ],
      closed: [],
    });
    await eventually(() =>
      expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("callback"))).toBe(true),
    );
    const patch = r.fake.callsTo("PATCH", /messages/).at(-1)!;
    const nonce = Object.values((await r.disk())["nonces"]).find(
      (n: any) => n.action === "dialog" && JSON.parse(n.target).op === "option" && JSON.parse(n.target).option === 0,
    ) as { nonce: string } | undefined;
    expect(nonce).toBeDefined();
    const card = (await r.disk())["dialogCards"];
    const record = Object.values(card)[0] as { messageId: string; chatId: string };
    const cb = callbackEnvelope(nonce!.nonce, { chatId: record.chatId, messageId: record.messageId });
    r.send(cb);
    await eventually(() => expect(r.request.mock.calls.some(([f]) => f.cmd.op === "dialog_answer")).toBe(true));
    const answer = r.request.mock.calls.find(([f]) => f.cmd.op === "dialog_answer")![0];
    expect(answer.cmd).toEqual({
      op: "dialog_answer",
      dialogId: "dialog-1",
      epoch: "dialog-epoch",
      answers: [{ selected: ["Yes"], other: null }],
    });
    r.send(cb);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.request.mock.calls.filter(([f]) => f.cmd.op === "dialog_answer")).toHaveLength(1);
  });
  it("owner-only approval nonce allows stranger without ever dispatching their dropped prompt", async () => {
    const r = await rig();
    await r.bind();
    r.send(messageEnvelope("stranger", "run malicious", { sender: "ou_stranger" }));
    await eventually(() =>
      expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("允许"))).toBe(true),
    );
    expect(r.request).not.toHaveBeenCalled();
    const disk = await r.disk();
    const approval = disk["approvals"]["ou_stranger"];
    const nonce = disk["nonces"][approval.nonce];
    expect(nonce.operatorOpenId).toBe(OWNER);
    r.send(
      callbackEnvelope(approval.nonce, {
        sender: "ou_stranger",
        id: "forged",
        chatId: nonce.chatId,
        messageId: nonce.messageId,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.service.snapshot().allow).toHaveLength(1);
    r.send(callbackEnvelope(approval.nonce, { id: "approve", chatId: nonce.chatId, messageId: nonce.messageId }));
    await eventually(() => expect(r.service.snapshot().allow).toHaveLength(2));
    expect(r.request).not.toHaveBeenCalled();
  });
  it("undecodable payload gives durable ACK and one owner notice", async () => {
    const r = await rig();
    r.send({
      schema: "2.0",
      header: { event_id: "bad", event_type: "im.message.receive_v1", app_id: "cli_test", tenant_key: "tenant" },
      event: {},
    });
    await eventually(() => expect(r.ackCount()).toBe(1));
    await eventually(() => expect(sentContent(r)).toContain("undecodable:message-invalid"));
    expect(r.service.snapshot().degraded).toContain("undecodable-events");
    expect(r.fake.sent[0]!.body["receive_id"]).toBe(OWNER);
  });
  it("owner decode-failure notices debounce per code; unsupported/stale never page the owner", async () => {
    const r = await rig();
    const bad = (id: string) => ({
      schema: "2.0",
      header: { event_id: id, event_type: "im.message.receive_v1", app_id: "cli_test", tenant_key: "tenant" },
      event: {},
    });
    r.send(bad("bad-1"));
    await eventually(() => expect(sentContent(r)).toContain("undecodable:message-invalid"));
    // Same decode code again: no second page.
    r.send(bad("bad-2"));
    await eventually(() => expect(r.ackCount()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sentContent(r).match(/飞书机器人状态/g)).toHaveLength(1);
    // A different decode code is a separate debounce bucket.
    const contentBad: any = messageEnvelope("bad-3", "hi");
    contentBad.event.message.content = "{";
    r.send(contentBad);
    await eventually(() => expect(sentContent(r)).toContain("undecodable:content-invalid"));
    // Unsubscribed event type and a stale redelivery: ACKed + counted, never paged.
    const unknown: any = messageEnvelope("unknown-1");
    unknown.header.event_type = "im.chat.disbanded_v1";
    unknown.event = { chat_id: "chat" };
    r.send(unknown);
    r.send(messageEnvelope("stale-1", "old", { createdAt: String(NOW - 301_000) }));
    await eventually(() => expect(r.ackCount()).toBe(5));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sentContent(r).match(/飞书机器人状态/g)).toHaveLength(2);
    expect(sentContent(r)).not.toContain("stale");
    const dropped = r.service.snapshot().counters.dropped;
    expect(dropped["unsupported"]).toBe(1);
    expect(dropped["stale"]).toBe(1);
  });
  it("persistence failure pauses further inbound processing; healed writer resumes", async () => {
    let fail = false;
    const fs = {
      ...realFeishuFs,
      openWriteExcl: (path: string, mode: number) => {
        if (fail && path.endsWith("state.json.tmp")) return Promise.reject(new Error("disk unavailable"));
        return realFeishuFs.openWriteExcl(path, mode);
      },
    };
    const r = await rig({ fs });
    await r.bind();
    const before = r.ackCount();
    fail = true;
    r.send(messageEnvelope("persist", "not yet"));
    await eventually(() => expect(r.service.snapshot().degraded).toContain("persist-failed"));
    r.send(messageEnvelope("paused", "ignored until redelivery"));
    expect(r.request).not.toHaveBeenCalled();
    expect(r.ackCount()).toBe(before);
    fail = false;
    await eventually(() => expect(r.service.snapshot().degraded ?? []).not.toContain("persist-failed"));
    r.send(messageEnvelope("persist", "not yet"));
    await eventually(() => expect(r.request).toHaveBeenCalledTimes(1));
  });
  it("dispose mid-dispatch fences effects, is idempotent, and preserves dispatching for query-only boot", async () => {
    const r = await rig();
    await r.bind();
    let resolve!: (value: CmdResultFrame) => void;
    r.request.mockImplementationOnce(
      (frame: CmdFrame) =>
        new Promise<CmdResultFrame>((done) => {
          resolve = done;
        }),
    );
    r.send(messageEnvelope("shutdown", "uncertain effect"));
    await eventually(() => expect(prompt(r)).toBeDefined());
    const frame = prompt(r)!;
    const first = r.service.dispose(),
      second = r.service.dispose();
    expect(first).toBe(second);
    expect(r.ws.sockets[0]!.closeCalls).toBeGreaterThan(0);
    resolve({ t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: { op: "prompt", delivery: "observed" } });
    await first;
    expect((await r.disk())["requests"][frame.id].state).toBe("dispatching");
    expect(r.service.snapshot().keepalive).toBe(true);
    const restarted = await f8Rig({ stateDir: r.stateDir });
    cleanups.push(() => restarted.service.dispose());
    await restarted.ready();
    await eventually(() => expect(restarted.request).toHaveBeenCalled());
    expect(restarted.request.mock.calls.every(([f]) => f.queryOnly === true)).toBe(true);
    expect(sentContent(restarted)).not.toContain("uncertain effect");
  });
  it("accepted run after restart is unattributed, never backfilled from idle", async () => {
    const r = await rig();
    await r.bind();
    r.send(messageEnvelope("before-restart", "old task"));
    await eventually(() => expect(prompt(r)).toBeDefined());
    await eventually(() => expect(r.fake.callsTo("POST", /reactions$/)).toHaveLength(1));
    await r.service.dispose();
    const restarted = await f8Rig({ stateDir: r.stateDir });
    cleanups.push(() => restarted.service.dispose());
    await restarted.ready();
    await eventually(() => expect(sentContent(restarted)).toContain("结果无法确认归属"));
    expect(restarted.request).not.toHaveBeenCalled();
  });
  it("off-by-absence assembly is not done here; unsafe/corrupt state never opens connector", async () => {
    const r = await rig();
    await r.service.dispose();
    await writeFile(join(r.stateDir, "feishu-bot", "state.json"), "bad JSON", { mode: 0o600 });
    const next = await f8Rig({ stateDir: r.stateDir });
    cleanups.push(() => next.service.dispose());
    expect(next.ws.sockets).toHaveLength(0);
    expect(next.service.snapshot().degraded).toContain("state-corrupt");
    expect(next.service.keepalive()).toBe(true);
    const repaired = await next.service.admin({ t: "fsb_req", rid: "repair", op: "repair", confirm: true });
    expect(repaired.ok).toBe(true);
    await next.ready();
    const reset = await next.service.admin({ t: "fsb_req", rid: "reset", op: "reset", confirm: true });
    expect(reset.ok).toBe(true);
    expect(next.service.keepalive()).toBe(false);
  });
});

import { fakeDirs, fakeFirstPrompt, fakeSpawnPrefs, fakeSpawnSupervisor } from "../../http/spawn-kit.js";
function spawnPort() {
  const supervisor = fakeSpawnSupervisor(),
    dirs = fakeDirs(),
    firstPrompt = fakeFirstPrompt(),
    prefs = fakeSpawnPrefs();
  return {
    supervisor,
    dirs,
    firstPrompt,
    prefs,
    registerTimeoutS: 30,
    restore: true,
    relaunch: supervisor.relaunch,
    lookup: (id: string) => {
      const r = supervisor.recordsOut.find((rec) => rec.spawnId === id);
      return r
        ? {
            ...(r.agentKey ? { agentKey: r.agentKey } : {}),
            ...(r.sessionId ? { sessionId: r.sessionId } : {}),
            terminal: r.state === "failed" || r.state === "exited",
          }
        : undefined;
    },
  };
}
describe("F8 spawn and group-root seams", () => {
  it("groupRootTopics opens an UNBOUND topic, never auto-selects the p2p current session", async () => {
    const r = await rig({}, { groupRootTopics: true });
    await r.bind();
    r.send(messageEnvelope("root", "private task", { chatType: "group", mentions: true }));
    await eventually(() => expect(sentContent(r)).toContain("未绑定前不会运行"));
    await eventually(() => expect(r.service.snapshot().bindings.total).toBe(2));
    await eventually(async () => {
      const binding = (await r.disk())["bindings"]["grp:chat:omt_fake_root"];
      expect(binding).toMatchObject({ chatType: "group", threadId: "omt_fake_root" });
      expect(binding.sessionId).toBeUndefined();
    });
    expect(r.request).not.toHaveBeenCalled();
  });
  it("/new uses F5 once, waits for live coords, then routes the persisted first prompt through F6", async () => {
    const spawn = spawnPort();
    const r = await rig({ spawn });
    r.send(messageEnvelope("new", "/new /known first task"));
    await eventually(() => expect(spawn.supervisor.startCalls).toHaveLength(1));
    expect(spawn.firstPrompt.accepts).toEqual([]);
    expect(r.request).not.toHaveBeenCalled();
    const rec = spawn.supervisor.recordsOut[0]!;
    rec.state = "live";
    rec.agentKey = "agent-1";
    rec.sessionId = "session-1";
    r.emit({ type: "spawns" });
    await eventually(() => expect(r.request).toHaveBeenCalledTimes(1));
    const f = r.request.mock.calls[0]![0];
    expect(f.cmd.op === "prompt" && f.cmd.text).toMatch(/\]\nfirst task$/);
    expect(spawn.supervisor.startCalls[0]!.owner).toMatchObject({
      listener: "lan",
      user: `feishu:${r.service.snapshot().gen}:ou_owner`,
    });
    r.emit({ type: "spawns" });
    r.send(messageEnvelope("new", "/new /known first task"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spawn.supervisor.startCalls).toHaveLength(1);
    expect(r.request).toHaveBeenCalledTimes(1);
  });
  it("failed launch closes the first prompt and tells the sender, rather than waiting forever", async () => {
    const spawn = spawnPort();
    const r = await rig({ spawn });
    r.send(messageEnvelope("failed-new", "/new /known must not run"));
    await eventually(() => expect(spawn.supervisor.startCalls).toHaveLength(1));
    spawn.supervisor.recordsOut[0]!.state = "failed";
    r.emit({ type: "spawns" });
    await eventually(() => expect(sentContent(r)).toContain("首条消息已关闭"));
    expect(r.request).not.toHaveBeenCalled();
    expect(
      Object.values((await r.disk())["requests"]).some(
        (record: any) => record.state === "reply-failed" && record.payload === undefined,
      ),
    ).toBe(true);
  });
  it("roots confirms canonical cwd, unknown known-scope refuses with R2-j prose", async () => {
    const spawn = spawnPort();
    spawn.dirs.setAdmitResult({ ok: false, code: "E_DIR", message: "not known" });
    const r = await rig({ spawn });
    r.send(messageEnvelope("unknown", "/new /unknown"));
    await eventually(() => expect(sentContent(r)).toContain("该目录不在已知目录中"));
    expect(spawn.supervisor.startCalls).toHaveLength(0);
    const roots = spawnPort();
    roots.dirs.setAdmitResult({ ok: true, realpath: "/canonical", known: false, dev: 1, ino: 2 });
    const next = await rig({ spawn: roots }, { spawnScope: "roots" });
    next.send(messageEnvelope("roots", "/new /unknown first"));
    await eventually(() =>
      expect(next.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("创建"))).toBe(true),
    );
    const nonce = Object.values((await next.disk())["nonces"]).find((n: any) => n.action === "new") as any;
    expect(JSON.parse(nonce.target).cwd).toBe("/canonical");
    expect(roots.supervisor.startCalls).toHaveLength(0);
    next.send(callbackEnvelope(nonce.nonce, { chatId: nonce.chatId, messageId: nonce.messageId }));
    await eventually(() => expect(roots.supervisor.startCalls).toHaveLength(1));
    expect(roots.dirs.admitCalls).toEqual([
      { raw: "/unknown", scope: "roots" },
      { raw: "/unknown", scope: "roots" },
    ]);
  });
  it("offline managed /cur offers Relaunch and surfaces B-alive refusal without agent dispatch", async () => {
    const spawn = spawnPort();
    const r = await rig({ spawn });
    await r.bind();
    r.views[0]!.live = false;
    spawn.supervisor.seedRecord({
      spawnId: "spawn-1234567890",
      sessionId: "session-1",
      agentKey: "agent-1",
      state: "exited",
    });
    spawn.supervisor.setRelaunchResult({ ok: false, code: "E_AGENT_ONLINE", reason: "exit-unconfirmed" });
    r.send(messageEnvelope("cur-offline", "/cur"));
    await eventually(() =>
      expect(r.fake.callsTo("PATCH", /messages/).some((c) => JSON.stringify(c.json).includes("Relaunch"))).toBe(true),
    );
    const nonce = Object.values((await r.disk())["nonces"]).find((n: any) => n.action === "relaunch") as any;
    r.send(callbackEnvelope(nonce.nonce, { chatId: nonce.chatId, messageId: nonce.messageId }));
    await eventually(() => expect(sentContent(r)).toContain("exit-unconfirmed"));
    expect(spawn.supervisor.relaunchCalls).toEqual([{ spawnId: "spawn-1234567890" }]);
    expect(r.request).not.toHaveBeenCalled();
  });
});

describe("F8 /help transport", () => {
  it("/help and unknown leading slash emit short usage text via outbox; paths/later slash remain prompts", async () => {
    const r = await rig();
    await r.bind();
    r.send(messageEnvelope("help", "/help"));
    r.send(messageEnvelope("unknown", "/xxx"));
    await eventually(() => expect(sentContent(r)).toContain("未知命令 /xxx"));
    for (const command of [
      "/list",
      "/use <n|sid-prefix|name>",
      "/cur",
      "/new <dir> [first message]",
      "/unbind",
      "/file <abs path>",
      "/help",
    ])
      expect(sentContent(r).replaceAll("\u200b", "")).toContain(command);
    expect(sentContent(r)).toContain("@ 机器人");
    expect(r.request).not.toHaveBeenCalled();
    r.send(messageEnvelope("path", "/home/me/file.txt 帮我看看"));
    await eventually(() => expect(r.request).toHaveBeenCalledTimes(1));
    r.send(messageEnvelope("sentence", "正常句子里的 /xxx\n/home/x"));
    await eventually(() => expect(r.request).toHaveBeenCalledTimes(2));
    expect(r.request.mock.calls[0]![0].cmd).toMatchObject({
      op: "prompt",
      text: expect.stringContaining("/home/me/file.txt 帮我看看"),
    });
    expect(r.request.mock.calls[1]![0].cmd).toMatchObject({
      op: "prompt",
      text: expect.stringContaining("正常句子里的 /xxx\n/home/x"),
    });
  });
  it.each(["resolve", "reject"] as const)(
    "approved F6 lifecycle fence: late router %s cannot mutate a disposed installation",
    async (how) => {
      const r = await rig();
      await r.bind();
      let resolve!: (value: CmdResultFrame) => void, reject!: () => void;
      r.request.mockImplementationOnce(
        () =>
          new Promise<CmdResultFrame>((done, fail) => {
            resolve = done;
            reject = () => fail(new Error("late"));
          }),
      );
      r.send(messageEnvelope(`late-${how}`, "late"));
      await eventually(() => expect(prompt(r)).toBeDefined());
      const frame = prompt(r)!;
      const stopped = r.service.dispose();
      if (how === "resolve")
        resolve({
          t: "cmd_result",
          rid: frame.rid,
          id: frame.id,
          ok: true,
          data: { op: "prompt", delivery: "observed" },
        });
      else reject();
      await stopped;
      expect((await r.disk())["requests"][frame.id].state).toBe("dispatching");
    },
  );
});

describe("F8 registration lifecycle", () => {
  it("replace installs a new generation only after stopping old connector and emits owner welcome", async () => {
    const r = await rig();
    const originalGen = r.service.snapshot().gen;
    r.fake.on("POST", "/oauth/v1/app/registration", () => ({
      json: {
        device_code: "device-secret",
        verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=test",
        expires_in: 60,
        interval: 1,
      },
    }));
    // Registration uses urlencoded bodies; the fixture fetch is wrapped without widening destinations.
    const fetch = r.deps.fetch!;
    const registrationFetch = async (url: string, init: RequestInit) => {
      if (url.includes("/oauth/v1/app/registration")) {
        const body = new URLSearchParams(String(init.body));
        return Response.json(
          body.get("action") === "begin"
            ? {
                device_code: "device-secret",
                verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=test",
                expires_in: 60,
                interval: 1,
              }
            : { client_id: r.fake.appId, client_secret: r.fake.appSecret, user_info: { open_id: OWNER } },
        );
      }
      return fetch(url, init);
    };
    await r.service.dispose();
    const replacement = await f8Rig({ stateDir: r.stateDir, fetch: registrationFetch });
    cleanups.push(() => replacement.service.dispose());
    await replacement.ready();
    const refusal = await replacement.service.admin({ t: "fsb_req", rid: "exists", op: "setup_begin" });
    expect(refusal).toMatchObject({ ok: false, code: "E_FSB_CONFIRM_REQUIRED" });
    const result = await replacement.service.admin({
      t: "fsb_req",
      rid: "setup",
      op: "setup_begin",
      replace: true,
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("device-secret");
    await eventually(() => expect(replacement.service.snapshot().gen).toBeGreaterThan(originalGen), 7_000);
    await eventually(() => expect(replacement.ws.sockets).toHaveLength(2));
    expect(replacement.ws.peak()).toBe(1);
    await eventually(() => expect(sentContent(r)).toContain("configured"));
    expect(JSON.stringify(replacement.service.snapshot())).not.toContain(r.fake.appSecret);
  });
});

describe("F8 /list session-switch card (session-card-plan r3)", () => {
  const diskNonces = async (r: Awaited<ReturnType<typeof rig>>, action: string) =>
    Object.values((await r.disk())["nonces"] as Record<string, any>).filter((n) => n.action === action);

  it("/list sends a button card; a click binds end-to-end, re-issues one nonce, sets cardCallback ok", async () => {
    const r = await rig();
    r.views.push({
      sessionId: "session-2",
      agentKey: "agent-2",
      cwd: r.stateDir,
      name: "Two",
      mode: "tui",
      live: true,
      state: "idle",
    });
    r.send(messageEnvelope("list-1", "/list"));
    await eventually(async () => {
      expect(await diskNonces(r, "session-card")).toHaveLength(1); // the anchor
      expect(await diskNonces(r, "session-pick")).toHaveLength(2); // one per online session
    });
    const anchor = (await diskNonces(r, "session-card"))[0];
    expect(JSON.parse(anchor.target)).toMatchObject({ k: "p2p:chat" });
    expect(r.fake.sent.some((s) => s.body["msg_type"] === "interactive")).toBe(true);
    expect(r.fake.callsTo("PATCH", /\/open-apis\/im\/v1\/messages\//).length).toBeGreaterThan(0);
    const pick = (await diskNonces(r, "session-pick")).find((n) => JSON.parse(n.target).s === "session-2")!;
    const sentBefore = r.fake.sent.length;
    r.send(callbackEnvelope(pick.nonce, { id: "pick-1", chatId: pick.chatId, messageId: pick.messageId }));
    await eventually(() => expect(sentContent(r)).toContain("已绑定"));
    await eventually(async () => expect((await r.disk())["bindings"]["p2p:chat"].sessionId).toBe("session-2"));
    expect(r.service.snapshot().caps.cardCallback).toBe("ok");
    // the card stays open: exactly one fresh nonce for the consumed button, anchor untouched
    await eventually(async () => {
      const picks = await diskNonces(r, "session-pick");
      expect(picks).toHaveLength(2);
      expect(picks.map((n) => n.nonce)).not.toContain(pick.nonce);
    });
    expect(await diskNonces(r, "session-card")).toHaveLength(1);
    expect((await r.disk())["nonces"][anchor.nonce]).toBeDefined();
    // the success receipt replies to the card message (relaunch-style target)
    const receipt = r.fake.sent.slice(sentBefore).find((s) => String(s.body["content"]).includes("已绑定"));
    expect(receipt).toBeDefined();
    // a second click on the re-issued nonce switches back — the card is reusable
    const back = (await diskNonces(r, "session-pick")).find((n) => JSON.parse(n.target).s === "session-1")!;
    r.send(callbackEnvelope(back.nonce, { id: "pick-2", chatId: back.chatId, messageId: back.messageId }));
    await eventually(async () => expect((await r.disk())["bindings"]["p2p:chat"].sessionId).toBe("session-1"));
    expect(r.request).not.toHaveBeenCalled(); // clicks never dispatch work
  });

  it("capability-denied cards degrade /list to today's plain text list", async () => {
    const r = await rig();
    r.fake.on("PATCH", /\/open-apis\/im\/v1\/messages\//, () => ({
      json: { code: 230027, msg: "card scope denied" },
    }));
    r.send(messageEnvelope("list-1", "/list"));
    await eventually(() => expect(r.service.snapshot().caps.cards).toBe("denied"));
    const cards = () => r.fake.sent.filter((s) => s.body["msg_type"] === "interactive").length;
    const before = cards();
    r.send(messageEnvelope("list-2", "/list"));
    await eventually(() => expect(sentContent(r).replaceAll("\u200b", "")).toContain("1. One · sessio [idle/tui]"));
    expect(cards()).toBe(before); // no new card after the denial
    expect(r.request).not.toHaveBeenCalled();
  });

  it("G2: restart adopts the open card before the connector starts; the old card still switches", async () => {
    const r = await rig();
    r.send(messageEnvelope("list-1", "/list"));
    await eventually(async () => expect(await diskNonces(r, "session-pick")).toHaveLength(1));
    const pick = (await diskNonces(r, "session-pick"))[0]!;
    await r.service.dispose(); // keep stateDir — anchors stay on disk
    const restarted = await f8Rig({ stateDir: r.stateDir });
    cleanups.push(() => restarted.service.dispose());
    await restarted.ready(); // sessionCard.start() ran before connector.start()
    restarted.send(
      callbackEnvelope(pick.nonce, { id: "pick-restart", chatId: pick.chatId, messageId: pick.messageId }),
    );
    await eventually(() => expect(sentContent(restarted)).toContain("已绑定"));
    expect((await restarted.disk())["bindings"]["p2p:chat"].sessionId).toBe("session-1");
  });
  it("G2 bound: a stuck card adoption never blocks the connector (timeout path logged, bot keeps serving)", async () => {
    const r = await rig();
    r.send(messageEnvelope("list-1", "/list"));
    await eventually(async () => expect(await diskNonces(r, "session-pick")).toHaveLength(1));
    const pick = (await diskNonces(r, "session-pick"))[0]!;
    await r.service.dispose();
    // simulate "button redeemed just before the crash": adoption will want to re-issue + refresh-PATCH
    const file = join(r.stateDir, "feishu-bot", "state.json");
    const doc = JSON.parse(await readFile(file, "utf8"));
    for (const [k, n] of Object.entries<any>(doc.nonces)) if (n.action === "session-pick") delete doc.nonces[k];
    await writeFile(file, JSON.stringify(doc), { mode: 0o600 });
    // the refresh PATCH hangs forever ⇒ start() would never finish
    const hung = createFakeFeishu({ appId: "cli_test" });
    hung.on("PATCH", /\/open-apis\/im\/v1\/messages\//, () => new Promise(() => {}));
    const restarted = await f8Rig({ stateDir: r.stateDir, fetch: hung.fetch, cardAdoptionBudgetMs: 300 });
    cleanups.push(() => restarted.service.dispose());
    const started = Date.now();
    await restarted.ready(); // connector came up although adoption is still parked on the PATCH
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(restarted.logs).toContainEqual({ event: "session-card", reason: "adoption-timeout" });
    expect(restarted.ws.sockets.length).toBeGreaterThan(0);
    // the bot keeps serving while adoption is parked: a fresh /list is answered (via the hung-PATCH fake)
    restarted.send(messageEnvelope("list-2", "/list"));
    await eventually(() => expect(hung.sent.length).toBeGreaterThan(0));
    void pick;
  });
});
