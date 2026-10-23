/** Real topic-switch hold -> read-only fenceActive port -> real xs receiver. No boolean port stub. */
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { wireTopicSwitch } from "../../src/topic-switch/wire.js";
import { DEFAULT_TOPIC_SWITCH_SETTINGS } from "../../src/topic-switch/settings.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import { XsReceiver } from "../../src/fabric/xs/receiver.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
const handlers = new Map<string, Function[]>();
afterEach(async () => {
  for (const h of handlers.get("session_shutdown") ?? []) await h({ reason: "exit" }, {});
  handlers.clear();
});
it("topic-switch held prompt rejects xs with none/fenced:topic_switch until real hold shutdown", () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "previous answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const pi: any = {
    on: (n: string, h: Function) => handlers.set(n, [...(handlers.get(n) ?? []), h]),
    registerCommand() {},
    appendEntry: (n: string, d: unknown) => manager.appendCustomEntry(n, d),
    sendUserMessage() {},
    getSessionName() {},
  };
  const ctx: any = {
    sessionManager: manager,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
    model: { provider: "anthropic", id: "test", cost: { input: 3, cacheWrite: 3.75, tiers: [] } },
    modelRegistry: { find: () => undefined },
    ui: { setStatus() {}, notify() {}, setEditorText() {} },
  };
  const topic = wireTopicSwitch(pi, {
    settings: () => DEFAULT_TOPIC_SWITCH_SETTINGS,
    titleModel: "",
    warmth: { assess: () => ({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" }) },
    stack: () => ({ activeRuns: () => 0, backgroundBash: () => 0, goalBusy: () => false }),
    remote: () => undefined,
  });
  for (const h of handlers.get("session_start") ?? []) h({ reason: "startup" }, ctx);
  const fence = createSessionFence({ ports: { topicSwitch: () => topic.fenceActive() } });
  const membership = new XsMembership({ sessionId: manager.getSessionId(), persist: () => {} });
  membership.attach();
  membership.join();
  const sendMessage = vi.fn();
  const receiver = new XsReceiver({
    sessionId: manager.getSessionId(),
    membership,
    fence,
    inbox: new XsInbox(8),
    recvPerHour: 30,
    wakesInPerHour: 12,
    host: { isIdle: () => true, hasPendingMessages: () => false, sendMessage, getLeafEntry: () => undefined },
  });
  expect(topic.fenceActive()).toBe(false);
  expect(
    topic.webGate.tryClaim(
      { cmdId: "new-topic", text: "please refactor the entire billing subsystem to support multi-currency ledgers" },
      ctx,
      { current: () => "dispatched", elsewhere() {} },
    ),
  ).toBe(true);
  expect(topic.fenceActive()).toBe(true);
  expect(
    receiver.deliver({
      xid: "topic-fence-integration",
      to: { sessionId: manager.getSessionId(), epoch: membership.epoch },
      from: { sessionId: "other", ref: "other", agentId: "other", cwdLabel: "/tmp" },
      text: "must not append",
      wake: true,
      expiresAt: Date.now() + 5000,
    }),
  ).toMatchObject({ effect: "none", reason: "fenced:topic_switch" });
  expect(sendMessage).not.toHaveBeenCalled();
  for (const h of handlers.get("session_shutdown") ?? []) h({ reason: "exit" }, ctx);
  expect(topic.fenceActive()).toBe(false);
  expect(fence.check()).toEqual({ ok: true });
  fence.dispose();
});
