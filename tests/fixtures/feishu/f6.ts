import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createFeishuState } from "../../../src/web-hub/hub/feishu/state.js";
import { systemFeishuClock } from "../../../src/web-hub/hub/feishu/http.js";
import {
  createFeishuSessions,
  type FeishuSessionView,
  type FeishuManagedSession,
} from "../../../src/web-hub/hub/feishu/sessions.js";
import {
  createFeishuAdmission,
  type FeishuInstallation,
  type FeishuIdentityContext,
} from "../../../src/web-hub/hub/feishu/admission.js";
import {
  createFeishuRequests,
  type FeishuRequestEvent,
  type FeishuReceiveInput,
} from "../../../src/web-hub/hub/feishu/requests.js";
import { createFeishuRouter, type FeishuRouterIntent } from "../../../src/web-hub/hub/feishu/router.js";
import {
  createFeishuInbound,
  type FeishuInboundIntent,
  type FeishuMessage,
} from "../../../src/web-hub/hub/feishu/inbound.js";
import { createCmdLimit } from "../../../src/web-hub/hub/cmd-limit.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { createFakeClock } from "./fake-http.js";

export const OWNER = "ou_owner";
export const OTHER = "ou_other";
export const NOW = 1_790_000_000_000;
const cleanup: Array<() => Promise<void>> = [];
export async function cleanupF6() {
  for (const fn of cleanup.splice(0).reverse()) await fn();
}
export async function f6Rig(
  options: { debounceMs?: number; staleMessageS?: number; groups?: boolean; roots?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "feishu-f6-"));
  const clock = createFakeClock(NOW);
  const state = createFeishuState({ dir, groupCommitMs: 0, clock: { ...systemFeishuClock, now: clock.now } });
  cleanup.push(async () => {
    state.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await state.load();
  await state.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
  state.tenant.pin("tenant");
  state.bindings.set("p2p:chat", { chatId: "chat", chatType: "p2p", sessionId: "session-1" });
  await state.commit();
  const live: FeishuSessionView[] = [
    { sessionId: "session-1", agentKey: "agent-1", cwd: "/repo", name: "One", mode: "tui", live: true, state: "idle" },
  ];
  const managed: FeishuManagedSession[] = [];
  let installation: FeishuInstallation | undefined = {
    appId: "cli_test",
    gen: 1,
    ownerOpenId: OWNER,
    botOpenId: "ou_bot",
    installSecret: "a-secret-key",
    active: true,
  };
  const install = () => installation;
  const sessions = createFeishuSessions(
    { views: () => live, managed: () => managed, bindings: state.bindings.list },
    clock.now,
  );
  const request = vi.fn(async (frame: CmdFrame, _agentKey: string): Promise<CmdResultFrame> => ({
    t: "cmd_result",
    rid: frame.rid,
    id: frame.id,
    ok: true,
    data: {} as never,
  }));
  const commands = { request, inflight: vi.fn(() => 0), peekIdempotent: vi.fn((): "done" | undefined => undefined) };
  const limit = createCmdLimit(clock.now);
  const admit = vi.spyOn(limit, "admit");
  const admission = createFeishuAdmission({ installation: install, state, sessions, limit, commands });
  const events: FeishuRequestEvent[] = [];
  const health: object[] = [];
  const requests = createFeishuRequests({
    state,
    installation: install,
    admission,
    clock,
    debounceMs: options.debounceMs ?? 1_500,
    staleMessageS: options.staleMessageS ?? 300,
    emit: (e) => events.push(e),
    onHealth: (e) => health.push(e),
  });
  const intents: FeishuRouterIntent[] = [];
  const router = createFeishuRouter({
    state,
    sessions,
    requests,
    groupRootTopics: options.roots ?? false,
    spawnScope: options.roots ? "roots" : "known",
    emit: (e) => intents.push(e),
    onHealth: (e) => health.push(e),
  });
  const inboundIntents: FeishuInboundIntent[] = [];
  const audits: object[] = [];
  const inbound = createFeishuInbound({
    state,
    installation: install,
    admission,
    allowGroups: options.groups ?? true,
    staleMessageS: options.staleMessageS ?? 300,
    now: clock.now,
    prepare: router.prepare,
    emit: (e) => inboundIntents.push(e),
    audit: (e) => audits.push(e),
    onHealth: (e) => health.push(e),
  });
  cleanup.push(async () => {
    inbound.dispose();
    router.dispose();
    requests.dispose();
  });
  const identity: FeishuIdentityContext = { installGen: 1, tenantKey: "tenant", senderOpenId: OWNER };
  function input(id: string, text = id): FeishuReceiveInput {
    return {
      sessionId: "session-1",
      bindingKey: "p2p:chat",
      bindingRev: state.bindings.get("p2p:chat")!.rev,
      senderOpenId: OWNER,
      senderDisplay: "Owner",
      chatLabel: "Private",
      chatId: "chat",
      chatType: "p2p",
      triggerMessageId: id,
      payload: { body: text, messageIds: [id], uploadIds: [] },
      sourceCreatedAt: clock.now(),
      installGen: 1,
      tenantKey: "tenant",
    };
  }
  return {
    dir,
    clock,
    state,
    live,
    managed,
    sessions,
    commands,
    request,
    limit,
    admit,
    admission,
    events,
    requests,
    router,
    intents,
    inbound,
    inboundIntents,
    audits,
    health,
    identity,
    install,
    setInstall(value: FeishuInstallation | undefined) {
      installation = value;
    },
    input,
  };
}
export function messageEnvelope(
  id = "m1",
  text = "hello",
  options: {
    sender?: string;
    tenant?: string;
    app?: string;
    createdAt?: string;
    chatType?: "p2p" | "group";
    threadId?: string;
    mentions?: boolean;
  } = {},
) {
  return {
    schema: "2.0",
    header: {
      event_id: `event-${id}`,
      event_type: "im.message.receive_v1",
      app_id: options.app ?? "cli_test",
      tenant_key: options.tenant ?? "tenant",
      create_time: String(NOW),
    },
    event: {
      sender: {
        sender_id: { open_id: options.sender ?? OWNER, user_id: null },
        sender_type: "user",
        tenant_key: options.tenant ?? "tenant",
      },
      message: {
        message_id: id,
        chat_id: "chat",
        chat_type: options.chatType ?? "p2p",
        message_type: "text",
        create_time: options.createdAt ?? String(NOW),
        content: JSON.stringify({ text }),
        ...(options.threadId ? { thread_id: options.threadId } : {}),
        ...(options.mentions ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } : {}),
      },
    },
  };
}
export function callbackEnvelope(
  nonce: string,
  options: { sender?: string; id?: string; chatId?: string; messageId?: string; tenant?: string } = {},
) {
  return {
    schema: "2.0",
    header: {
      event_id: options.id ?? "callback-1",
      event_type: "card.action.trigger",
      app_id: "cli_test",
      tenant_key: options.tenant ?? "tenant",
      create_time: `${NOW}000`,
    },
    event: {
      operator: { open_id: options.sender ?? OWNER, tenant_key: options.tenant ?? "tenant" },
      host: "im_message",
      context: { open_chat_id: options.chatId ?? "owner-chat", open_message_id: options.messageId ?? "card" },
      action: { value: { n: nonce }, tag: "button" },
    },
  };
}
export function normalizedMessage(id = "m1", text = "hello"): FeishuMessage {
  return {
    eventId: `e-${id}`,
    senderOpenId: OWNER,
    senderDisplay: "Owner",
    senderType: "user",
    tenantKey: "tenant",
    messageId: id,
    chatId: "chat",
    chatType: "p2p",
    chatLabel: "Private",
    createdAt: NOW,
    messageType: "text",
    content: { text },
    text,
    mentions: [],
  };
}
export async function untilF6(check: () => boolean) {
  const end = Date.now() + 3_000;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error("F6 condition not reached");
}
