import { describe, it, expect, vi } from "vitest";
import {
  createFeishuNotify,
  feishuBackgroundIdle,
  type FeishuIdleEvidence,
} from "../../../../src/web-hub/hub/feishu/notify.js";
import { f6Rig, cleanupF6, NOW } from "../../../fixtures/feishu/f6.js";
import { afterEach } from "vitest";
afterEach(cleanupF6);
const complete = (): FeishuIdleEvidence => ({
  at: NOW,
  fleet: { complete: true, terminal: [true, true] },
  bash: { complete: true, running: 0 },
});
describe("F8 notification evidence", () => {
  it.each([
    undefined,
    { ...complete(), at: NOW - 10_001 },
    { ...complete(), at: NOW + 1 },
    { ...complete(), fleet: undefined },
    { ...complete(), bash: undefined },
    { ...complete(), fleet: { complete: false, terminal: [true] } },
    { ...complete(), bash: { complete: false, running: 0 } },
    { ...complete(), fleet: { complete: true, terminal: [false] } },
    { ...complete(), bash: { complete: true, running: 1 } },
  ])("unknown/stale/truncated/busy evidence suppresses done: %j", (evidence) =>
    expect(feishuBackgroundIdle(evidence, NOW)).toBe(false),
  );
  it("requires both complete, fresh, positively idle projections", () =>
    expect(feishuBackgroundIdle(complete(), NOW)).toBe(true));
  it("bound-only, own-run suppression, per-session cadence, failed unaffected by idle evidence", async () => {
    const r = await f6Rig(),
      send = vi.fn(async () => {});
    const notify = createFeishuNotify({
      state: r.state,
      now: r.clock.now,
      owner: () => "ou_owner",
      enabled: true,
      label: () => "label",
      target: (b) => ({ scope: "p2p", via: "send", receiveIdType: "chat_id", receiveId: b.chatId }),
      send,
    });
    await notify.session({ sessionId: "session-1", kind: "done", text: "busy", feishuInitiated: false });
    expect(send).not.toHaveBeenCalled();
    await notify.session({
      sessionId: "session-1",
      kind: "done",
      text: "ours",
      feishuInitiated: true,
      evidence: complete(),
    });
    expect(send).not.toHaveBeenCalled();
    await notify.session({
      sessionId: "session-1",
      kind: "done",
      text: "native",
      feishuInitiated: false,
      evidence: complete(),
    });
    expect(send).toHaveBeenCalledTimes(1);
    await notify.session({
      sessionId: "session-1",
      kind: "done",
      text: "too soon",
      feishuInitiated: false,
      evidence: complete(),
    });
    expect(send).toHaveBeenCalledTimes(1);
    await notify.session({ sessionId: "session-1", kind: "failed", text: "failure", feishuInitiated: false });
    expect(send).toHaveBeenCalledTimes(2);
    await notify.session({ sessionId: "unbound", kind: "failed", text: "unbound", feishuInitiated: false });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("owner diagnostics are static, hourly, globally capped and never expose bodies", async () => {
    const r = await f6Rig(),
      send = vi.fn(async () => {});
    const notify = createFeishuNotify({
      state: r.state,
      now: r.clock.now,
      owner: () => "ou_owner",
      enabled: false,
      label: () => "label",
      target: () => undefined,
      send,
    });
    await notify.owner("auth_failed");
    await notify.owner("auth_failed");
    await notify.owner("secret /home/user/path");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].message.content).toContain("auth_failed");
    for (let i = 0; i < 30; i++) await notify.owner(`degraded-${i}`);
    expect(send).toHaveBeenCalledTimes(20);
    notify.dispose();
    await notify.owner("new");
    expect(send).toHaveBeenCalledTimes(20);
  });
});
