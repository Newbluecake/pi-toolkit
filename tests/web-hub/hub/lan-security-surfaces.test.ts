import { describe, expect, it, vi } from "vitest";
import { createSecurityEventBus } from "../../../src/web-hub/hub/security-events.js";
import { auditClientDeny, auditLanSession, auditLan2fa } from "../../../src/web-hub/hub/audit.js";
import { repairLan2fa } from "../../../src/web-hub/hub/lan-store.js";
describe("P0 security event and audit surfaces", () => {
  it("is instance-local, no-op without subscribers, sync ordered, isolated and idempotently unsubscribed", () => {
    const log = { error: vi.fn() },
      bus = createSecurityEventBus(log),
      other = createSecurityEventBus(log),
      seen: string[] = [];
    bus.emit({ type: "passwd" });
    const first = bus.subscribe(() => {
      seen.push("first");
      throw Error("sensitive payload must not be logged");
    });
    bus.subscribe(() => seen.push("second"));
    other.emit({ type: "passwd" });
    expect(seen).toEqual([]);
    bus.emit({ type: "passwd" });
    expect(seen).toEqual(["first", "second"]);
    expect(log.error).toHaveBeenCalledWith(expect.any(String), { type: "passwd" });
    first();
    first();
    bus.emit({ type: "passwd" });
    expect(seen).toEqual(["first", "second", "second"]);
  });
  it("snapshots subscriptions during emit", () => {
    const bus = createSecurityEventBus({ error: () => {} }),
      seen: string[] = [];
    let remove = () => {};
    bus.subscribe(() => {
      remove();
      bus.subscribe(() => seen.push("late"));
    });
    remove = bus.subscribe(() => seen.push("old"));
    bus.emit({ type: "passwd" });
    expect(seen).toEqual(["old"]);
    bus.emit({ type: "passwd" });
    expect(seen).toEqual(["old", "late"]);
  });
  it("whitelists at runtime, including admin ops, never spreads secret fields", () => {
    const log = { info: vi.fn() },
      secrets = {
        secretB32: "secret",
        otpauthUri: "uri",
        recoveryCodes: ["private"],
        token: "private",
        sidHash: "private",
        ua: "private",
        challengeId: "private",
      };
    auditClientDeny(log, {
      listener: "lan",
      ip: "1.2.3.4",
      via: "peer",
      reason: "not-allowed",
      suppressed: 2,
      ...secrets,
    });
    expect(log.info).toHaveBeenLastCalledWith("client-deny", {
      audit: "client-deny",
      listener: "lan",
      ip: "1.2.3.4",
      via: "peer",
      reason: "not-allowed",
      suppressed: 2,
    });
    auditLanSession(log, { op: "others", ip: "1.2.3.4", ok: true, n: 3, complete: false, ...secrets });
    expect(log.info).toHaveBeenLastCalledWith("lan-session", {
      audit: "lan-session",
      op: "others",
      ip: "1.2.3.4",
      ok: true,
      n: 3,
      complete: false,
    });
    auditLan2fa(log, { phase: "verify", method: "totp", ok: false, code: "E_2FA_CODE", reason: "replay", ...secrets });
    expect(log.info).toHaveBeenLastCalledWith("lan-2fa", {
      audit: "lan-2fa",
      phase: "verify",
      method: "totp",
      ok: false,
      code: "E_2FA_CODE",
      reason: "replay",
    });
    auditLan2fa(log, { phase: "admin", op: "repair", ok: true, ip: "must-not-log", ...secrets });
    expect(log.info).toHaveBeenLastCalledWith("lan-2fa", { audit: "lan-2fa", op: "repair", ok: true });
  });
  it("B repair is async and honours cancellation", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(repairLan2fa({ dbFile: "/not-opened", log, signal: AbortSignal.abort() })).resolves.toEqual({
      ok: false,
      reason: "db-timeout",
    });
    expect(log.info).toHaveBeenCalledWith("lan-2fa", { audit: "lan-2fa", op: "repair", ok: false });
  });
});
