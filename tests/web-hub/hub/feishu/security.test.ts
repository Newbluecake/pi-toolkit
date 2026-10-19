/**
 * LAN security r2 §4.3 (package E): the Feishu security notifier + shared notice budget.
 *
 * Pins: per-kind cooldowns; the 5s coalesce window; cooldown-0 ⇒ a unique key per message (two
 * passwd events never swallow each other); cooldown>0 ⇒ one initial alert + one cooldown-end
 * aggregate; shared-budget exhaustion drops and counts without throwing; the ≤128-key bound;
 * suppression of known-IP logins and card-already-sent challenges; dispose clears timers and
 * unsubscribes.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createFeishuSecurity,
  createNoticeBudget,
  type FeishuSecurity,
  type FeishuSecurityStats,
} from "../../../../src/web-hub/hub/feishu/security.js";
import { createSecurityEventBus, type SecurityEvent } from "../../../../src/web-hub/hub/security-events.js";
import { createFakeClock, type FakeClock } from "../../../fixtures/feishu/fake-http.js";

const hash12 = (disc: string) => createHash("sha256").update(disc).digest("base64url").slice(0, 12);

function rig(clock: FakeClock, owner: () => string | undefined = () => "ou_owner") {
  const bus = createSecurityEventBus({ error: () => {} });
  const send = vi.fn(async () => {});
  const budget = createNoticeBudget(clock);
  const security = createFeishuSecurity({ security: bus, clock, owner, budget, send }) as FeishuSecurity & {
    stats(): FeishuSecurityStats;
  };
  return { bus, send, budget, security };
}

describe("Feishu security notifier (§4.3)", () => {
  it("cooldown-0 kinds send one unique-key message per event (two passwd in an hour never swallow)", () => {
    const clock = createFakeClock(0);
    const { send, security } = rig(clock);
    security.onEvent({ type: "passwd" });
    clock.advance(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    security.onEvent({ type: "passwd" });
    clock.advance(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    const [a, b] = [send.mock.calls[0]![0].key, send.mock.calls[1]![0].key];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^sec-passwd-\d+-[A-Za-z0-9_-]{8}$/);
    expect(send.mock.calls[0]![0].target).toEqual({
      scope: "p2p",
      via: "send",
      receiveIdType: "open_id",
      receiveId: "ou_owner",
    });
  });

  it("coalesces rapid repeats within 5s into one message with a count suffix", () => {
    const clock = createFakeClock(0);
    const { send, security } = rig(clock);
    security.onEvent({ type: "passwd" });
    security.onEvent({ type: "passwd" });
    security.onEvent({ type: "passwd" });
    clock.advance(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0].message.content)).toContain("（3 次）");
  });

  it("cooldown>0 sends one initial alert then one aggregate at cooldown end", () => {
    const clock = createFakeClock(0);
    const { send, security } = rig(clock);
    security.onEvent({ type: "lan-spawn", ip: "1.2.3.4", mode: "new", dirTail: "a/b" });
    clock.advance(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].key).toBe(`sec-spawn-${hash12("1.2.3.4")}-0`);
    // Two more inside the same 10-minute window: counted, not sent.
    security.onEvent({ type: "lan-spawn", ip: "1.2.3.4", mode: "new" });
    security.onEvent({ type: "lan-spawn", ip: "1.2.3.4", mode: "new" });
    clock.advance(600_000 - 5_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0].message.content)).toContain("（另有 2 次）");
    expect(send.mock.calls[1]![0].key).toBe(`sec-spawn-${hash12("1.2.3.4")}-1`);
  });

  it("known-IP login-success and card-sent challenges are suppressed", () => {
    const clock = createFakeClock(0);
    const { send, security } = rig(clock);
    security.onEvent({ type: "login-success", ip: "1.2.3.4", method: "password", device: "Chrome", newIp: false });
    security.onEvent({ type: "login-2fa-challenge", ip: "1.2.3.4", device: "Chrome", cardSent: true });
    clock.advance(5_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("new-IP login and Feishu-unavailable challenges alert", () => {
    const clock = createFakeClock(0);
    const { send, security } = rig(clock);
    security.onEvent({ type: "login-success", ip: "9.9.9.9", method: "totp", device: "Safari", newIp: true });
    clock.advance(5_000);
    security.onEvent({ type: "login-2fa-challenge", ip: "9.9.9.9", device: "Safari", cardSent: false });
    clock.advance(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[0]![0].message.content)).toContain("9.9.9.9");
  });

  it("shared-budget exhaustion drops and counts without throwing", () => {
    const clock = createFakeClock(0);
    const { send, budget, security } = rig(clock);
    for (let i = 0; i < 20; i++) budget.reserve(`exhaust-${i}`, 0);
    security.onEvent({ type: "passwd" });
    clock.advance(5_000);
    expect(send).not.toHaveBeenCalled();
    expect(security.stats().dropped).toBe(1);
  });

  it("zero-gap keys never consume the 1024-key dedup map (a gap-0 burst cannot starve a gap key)", () => {
    const clock = createFakeClock(0);
    const budget = createNoticeBudget(clock);
    // 1100 unique gap-0 keys: the global 20/min window is reset every 60s so all are admitted.
    for (let i = 0; i < 1100; i++) {
      if (i > 0 && i % 20 === 0) clock.advance(60_000);
      expect(budget.reserve(`sec-${i}`, 0)).toBe(true);
    }
    clock.advance(60_000); // reset the global window before the gap-gated reserve
    expect(budget.reserve("completion:abc", 60_000)).toBe(true);
  });

  it("no owner ⇒ dropped silently", () => {
    const clock = createFakeClock(0);
    const { send, security } = rig(clock, () => undefined);
    security.onEvent({ type: "passwd" });
    clock.advance(5_000);
    expect(send).not.toHaveBeenCalled();
    expect(security.stats().dropped).toBe(0);
  });

  it("bounds pending keys at 128 and counts the overflow", () => {
    const clock = createFakeClock(0);
    const { security } = rig(clock);
    for (let i = 0; i < 200; i++) {
      security.onEvent({ type: "login-lockout", ip: `10.0.${i >> 8}.${i & 255}`, failures: 3, lockMs: 1_000 });
    }
    expect(security.stats().pending).toBe(128);
    expect(security.stats().dropped).toBe(200 - 128);
  });

  it("dispose clears timers and unsubscribes the bus", () => {
    const clock = createFakeClock(0);
    const { bus, send, security } = rig(clock);
    security.onEvent({ type: "passwd" });
    security.dispose();
    security.onEvent({ type: "passwd" });
    bus.emit({ type: "passwd" } as SecurityEvent);
    clock.advance(5_000);
    expect(send).not.toHaveBeenCalled();
    expect(security.stats().pending).toBe(0);
  });
});
