import { describe, it, expect, vi } from "vitest";
import { TerminalRevocationFence } from "../../../../src/web-hub/hub/terminal/revocation-fence.js";
import { createAuthRevokeBus } from "../../../../src/web-hub/hub/auth-revoke.js";
import type { AuthIdentity } from "../../../../src/web-hub/hub/auth-identity.js";
const id: AuthIdentity = {
  listener: "lan",
  principal: "u1",
  sidTag: "sid",
  userId: 1,
  parentExpiresAt: 1000000,
  lan: { userId: 1, epoch: 1, sidHash: "sid", absoluteExpiresAt: 1000000 },
};
describe("T-REV first emit fence (§3.1.1)", () => {
  it.each([{ sidTag: "sid" }, { userId: 1 }, { listener: "lan" as const }, "all" as const])(
    "synchronous denial for %j before delete settles, callbacks cannot un-deny",
    async (selector) => {
      const bus = createAuthRevokeBus({ error: vi.fn() }),
        f = new TerminalRevocationFence(() => 0, bus);
      expect(() => f.proof(id)).toThrow("E_AUTH");
      expect(f.loginComplete(id, 1, 0)).toBe(true);
      const denied: unknown[] = [];
      f.subscribe(() => {
        try {
          f.proof(id);
        } catch (e) {
          denied.push(e);
        }
      });
      bus.emit({ sel: selector, reason: "logout" });
      expect(denied).toHaveLength(1);
      expect(() => f.proof(id)).toThrow("E_AUTH_REVOKING");
      expect(f.loginComplete({ ...id, sidTag: "new" }, 1, 0)).toBe(false);
      expect(await f.repair(selector, f.revision, 2, async () => false)).toBe(false);
      expect(() => f.proof(id)).toThrow("E_AUTH_REVOKING");
      expect(
        await f.repair(selector, f.revision, 2, async () => {
          throw Error("delete failed");
        }),
      ).toBe(false);
      expect(() => f.proof(id)).toThrow("E_AUTH_REVOKING");
    },
  );
  it("broad repair is revision CAS + cutoff, only real new login after completion opens", async () => {
    const f = new TerminalRevocationFence(() => 0);
    f.loginComplete(id, 1, 0);
    const rev = f.revoke({ userId: 1 });
    let settle!: (b: boolean) => void;
    const pending = f.repair({ userId: 1 }, rev, 2, () => new Promise((r) => (settle = r)));
    f.revoke({ userId: 1 });
    settle(true);
    expect(await pending).toBe(false);
    expect(await f.repair({ userId: 1 }, rev, 2, async () => true)).toBe(false);
    expect(await f.repair({ userId: 1 }, f.revision, 2, async () => true)).toBe(true);
    expect(() => f.proof(id)).toThrow("E_AUTH");
    const next = { ...id, sidTag: "next", lan: { ...id.lan!, sidHash: "next", epoch: 2 } };
    expect(f.loginComplete(next, 2, rev)).toBe(false);
    expect(f.loginComplete(next, 2, f.revision)).toBe(true);
    expect(f.proof(next).sidTag).toBe("next");
    expect(() => f.proof(id)).toThrow();
    f.revoke({ sidTag: "next" });
    expect(() => f.proof(next)).toThrow("E_AUTH_REVOKING");
  });
  it("saturates exact entries into sticky deny, never LRU/TTL; consumer failure poisons all", () => {
    let n = 0;
    const f = new TerminalRevocationFence(() => n);
    for (let i = 0; i < 2048; i++) f.revoke({ sidTag: `s${i}` });
    expect(f.size()).toBe(2048);
    f.revoke({ sidTag: "overflow" });
    expect(f.size()).toBe(1);
    n = 1e12;
    expect(() => f.proof(id)).toThrow("E_AUTH_REVOKING");
    const g = new TerminalRevocationFence(() => 0);
    g.subscribe(() => {
      throw Error("consumer failed");
    });
    g.revoke({ sidTag: "irrelevant" });
    expect(() => g.proof(id)).toThrow("E_AUTH_REVOKING");
  });
  it("hard expiry rejects without waiting for timer or sliding auth", () => {
    let n = 0;
    const f = new TerminalRevocationFence(() => n);
    f.loginComplete(id, 1, 0);
    n = id.parentExpiresAt;
    expect(() => f.proof({ ...id, parentExpiresAt: n + 10000 })).toThrow("E_AUTH");
  });
});
