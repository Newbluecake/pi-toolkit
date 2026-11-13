import { describe, it, expect } from "vitest";
import { TerminalCreationTickets } from "../../../../src/web-hub/hub/terminal/creation-ticket.js";
const owner = {
  listener: "lan",
  principal: "u1",
  sidTag: "sid",
  agentKey: "a",
  sessionId: "s",
  epoch: "e",
  ownerInstance: "o",
};
describe("T-ID terminal creation tickets (§4.2.1)", () => {
  it("binds MAC, boot, full owner and payload; redeem is a single synchronous CAS", () => {
    const a = new TerminalCreationTickets(() => 1000),
      t = a.prepare(owner, 80, 24);
    expect(a.redeem(t, owner, 80, 24, "term1")).toMatchObject({
      fresh: true,
      row: { phase: "accepted", termId: "term1" },
    });
    expect(a.redeem(t, owner, 80, 24, "term2")).toMatchObject({ fresh: false, row: { termId: "term1" } });
    for (const changed of [
      { ...t, mac: "0".repeat(64) },
      { ...t, bootId: "other" },
      { ...t, expiresAt: t.expiresAt + 1 },
    ])
      expect(() => a.verify(changed, owner)).toThrow("E_STALE_CREATION");
    for (const o of [
      { ...owner, sidTag: "other" },
      { ...owner, listener: "loopback" },
      { ...owner, ownerInstance: "other" },
    ])
      expect(() => a.verify(t, o)).toThrow("E_STALE_CREATION");
    expect(() => a.redeem(t, owner, 81, 24, "term2")).toThrow("E_STALE_CREATION");
    expect(() => new TerminalCreationTickets(() => 1000).verify(t, owner)).toThrow("E_STALE_CREATION");
  });
  it("pins live/closing/poison beyond 10 minutes and preserves exit tombstone past output disposal", () => {
    let n = 1000;
    const a = new TerminalCreationTickets(() => n),
      t = a.prepare(owner, 80, 24);
    a.redeem(t, owner, 80, 24, "term1");
    n = t.expiresAt + 100_000;
    expect(a.redeem(t, owner, 80, 24, "term2")).toMatchObject({ fresh: false, row: { termId: "term1" } });
    a.exited(t.ticketId);
    n += 60_000;
    expect(a.verify(t, owner)?.phase).toBe("exited");
    n++;
    expect(() => a.redeem(t, owner, 80, 24, "term3")).toThrow("E_EXPIRED");
  });
  it("expiry ±1 and 64/2048 capacities refuse rather than evict live keys", () => {
    let n = 0;
    const a = new TerminalCreationTickets(() => n),
      t = a.prepare(owner, 80, 24);
    n = t.expiresAt - 1;
    expect(a.verify(t, owner)?.phase).toBe("issued");
    n++;
    expect(() => a.verify(t, owner)).toThrow("E_EXPIRED");
    n = 0;
    const b = new TerminalCreationTickets(() => n);
    for (let i = 0; i < 64; i++) b.prepare(owner, 80, 24);
    expect(() => b.prepare(owner, 80, 24)).toThrow("E_LIMIT");
    for (let u = 1; u < 32; u++)
      for (let i = 0; i < 64; i++) b.prepare({ ...owner, principal: `u${u + 1}`, sidTag: `sid${u}` }, 80, 24);
    expect(b.size()).toBe(2048);
    expect(() => b.prepare({ ...owner, sidTag: "new" }, 80, 24)).toThrow("E_LIMIT");
    n = 600_001;
    expect(b.size()).toBe(0);
    expect(b.prepare(owner, 80, 24).issuedAt).toBe(n);
  });
});
