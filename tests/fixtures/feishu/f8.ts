import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, expect } from "vitest";
import { createFakeFeishu } from "./fake-http.js";
import { createFakeWebSockets } from "./fake-ws-server.js";
import { messageEnvelope, NOW, OWNER } from "./f6.js";
import {
  createFeishuBotService,
  type FeishuBotServiceDeps,
  type FeishuServiceEvent,
} from "../../../src/web-hub/hub/feishu/service.js";
import { createCredentialStore } from "../../../src/web-hub/hub/feishu/credentials.js";
import { createCmdLimit } from "../../../src/web-hub/hub/cmd-limit.js";
import { systemFeishuClock } from "../../../src/web-hub/hub/feishu/http.js";
import { encodeFrame, decodeFrame, header } from "../../../src/web-hub/hub/feishu/frame.js";
import { normalizeFeishuBotHubConfig } from "../../../src/web-hub/protocol/feishu.js";
import type { CmdFrame, CmdResultFrame, WireEvent } from "../../../src/web-hub/protocol/messages.js";
import type { FeishuSessionView } from "../../../src/web-hub/hub/feishu/sessions.js";

export async function eventually(check: () => unknown, ms = 6_000): Promise<void> {
  const end = Date.now() + ms;
  let error: unknown;
  do {
    try {
      await check();
      return;
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < end);
  throw error;
}
export async function f8Rig(options: Partial<FeishuBotServiceDeps> = {}, config: Record<string, unknown> = {}) {
  const stateDir = options.stateDir ?? (await mkdtemp(join(tmpdir(), "feishu-f8-")));
  const clock = options.clock ?? { ...systemFeishuClock, now: () => NOW + Date.now() - start };
  const start = Date.now();
  const fake = createFakeFeishu({ appId: "cli_test" });
  const ws = createFakeWebSockets(clock);
  const credentials = createCredentialStore({ dir: join(stateDir, "feishu-bot"), clock });
  if (!options.stateDir) {
    expect(
      (
        await credentials.commit({
          brand: "feishu",
          appId: fake.appId,
          appSecret: fake.appSecret,
          ownerOpenId: OWNER,
          botOpenId: "ou_bot",
        })
      ).ok,
    ).toBe(true);
  }
  const views: FeishuSessionView[] = [
    { sessionId: "session-1", agentKey: "agent-1", cwd: stateDir, name: "One", mode: "tui", live: true, state: "idle" },
  ];
  const listeners = new Set<(e: FeishuServiceEvent) => void>();
  let seq = 0;
  const emit = (event: FeishuServiceEvent) => {
    for (const fn of listeners) fn(event);
  };
  const event = (e: WireEvent) => emit({ type: "ev", agentKey: "agent-1", seq: ++seq, e });
  const consumed = (id: string) =>
    emit({
      type: "ctl",
      agentKey: "agent-1",
      epoch: "epoch-one",
      sessionId: views[0]!.sessionId,
      items: [{ cmdId: id, op: "prompt", state: "consumed", at: clock.now(), updatedAt: clock.now() }],
    });
  const request = vi.fn(async (frame: CmdFrame, _key: string): Promise<CmdResultFrame> => ({
    t: "cmd_result",
    rid: frame.rid,
    id: frame.id,
    ok: true,
    data: frame.queryOnly ? { op: "query", state: "running" } : { op: "prompt", delivery: "observed" },
  }));
  const statuses: object[] = [],
    logs: object[] = [];
  const deps: FeishuBotServiceDeps = {
    stateDir,
    config: normalizeFeishuBotHubConfig({
      allowGroups: true,
      groupRootTopics: false,
      notify: "bound",
      spawnScope: "known",
      staleMessageS: 300,
      debounceMs: 0,
      files: { inbound: true, outbound: "auto", maxInboundMiB: 30 },
      ...config,
    })!,
    limit: createCmdLimit(clock.now),
    commands: { request, inflight: () => 0, peekIdempotent: () => undefined },
    sessions: { views: () => views, managed: () => [] },
    events: {
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    clock,
    fetch: fake.fetch,
    webSocket: ws.create,
    link: (key) => `http://localhost:7777/#/agent/${key}`,
    onStatus: (status) => {
      statuses.push(status);
    },
    log: (e) => {
      logs.push(e);
    },
    ...options,
  };
  const service = createFeishuBotService(deps);
  await service.start();
  const send = (raw: unknown) => {
    ws.sockets.at(-1)!.message(
      encodeFrame({
        seqId: 1n,
        logId: 2n,
        service: 33,
        method: 1,
        headers: [
          { key: "type", value: "event" },
          { key: "message_id", value: `wire-${Math.random()}` },
          { key: "sum", value: "1" },
          { key: "seq", value: "0" },
        ],
        payloadEncoding: "",
        payload: Buffer.from(JSON.stringify(raw)),
      }),
    );
  };
  const ackCount = () =>
    ws.sockets.flatMap((s) => s.sent.map(decodeFrame)).filter((f) => header(f, "biz_rt") !== undefined).length;
  return {
    service,
    deps,
    clock,
    fake,
    ws,
    views,
    request,
    send,
    emit,
    event,
    consumed,
    ackCount,
    stateDir,
    credentials,
    statuses,
    logs,
    async ready() {
      await eventually(() => expect(service.snapshot().status).toBe("open"));
    },
    async bind(options: Parameters<typeof messageEnvelope>[2] = {}) {
      const n = ackCount();
      send(messageEnvelope(`bind${n}`, "/use session-1", options));
      await eventually(() => expect(ackCount()).toBe(n + 1));
      await eventually(() => expect(fake.sent.some((s) => String(s.body["content"]).includes("已绑定"))).toBe(true));
    },
    async disk() {
      return JSON.parse(await readFile(join(stateDir, "feishu-bot", "state.json"), "utf8")) as Record<string, any>;
    },
    async close(remove = true) {
      await service.dispose();
      if (remove) await rm(stateDir, { recursive: true, force: true });
    },
    finish(text: string, output = "done", stopReason = "stop") {
      const frame = request.mock.calls.find(([f]) => f.cmd.op === "prompt" && f.cmd.text === text)?.[0];
      if (!frame) throw new Error("no-frame");
      consumed(frame.id);
      event({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      event({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: output }], stopReason },
      });
      event({ type: "agent_settled" });
    },
  };
}
export const sentContent = (rig: Awaited<ReturnType<typeof f8Rig>>) =>
  rig.fake.sent.map((s) => String(s.body["content"])).join("\n");
