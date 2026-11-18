/** Original auth dispatch + memory fence, controlled store facts. Real same-transaction
 * SQLite receipt coverage is in integration/terminal-v2-hub.test.ts. No terminal IO. */
import { describe, expect, it, vi } from "vitest";
import { createAdminHandler, type AdminDeps } from "../../../src/web-hub/hub/admin.js";
import { passwordCommitFact, type PasswordFactStore } from "../../../src/web-hub/hub/auth-store-facts.js";
import { TerminalRevocationFenceV2 } from "../../../src/web-hub/hub/terminal/v2/revocation-fence.js";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { memLog } from "./helpers.js";
function setup() {
  const store = fakeLanStore();
  store.seedUser({
    id: 7,
    username: "alice",
    epoch: 3,
    kdf: "scrypt",
    n: 16384,
    r: 8,
    p: 1,
    salt: new Uint8Array(16),
    hash: new Uint8Array(32),
    createdAt: 1,
    updatedAt: 1,
  });
  const fence = new TerminalRevocationFenceV2();
  const id = {
    listener: "lan" as const,
    principal: "u7",
    sidTag: "a".repeat(43),
    userId: 7,
    parentExpiresAt: Date.now() + 30000,
  };
  const deps: AdminDeps = {
    log: memLog(),
    hasLan: () => true,
    store: () => store,
    kdf: () => fakeKdf(),
    limiter: () => undefined,
    lan: () => undefined,
    lanStatus: () => undefined,
    terminalAuth: () => fence,
    shutdown() {},
  };
  const password = () =>
    createAdminHandler(deps).handleLanReq(
      { t: "lan_req", rid: "r", op: "passwd", username: "alice", password: "Auth-Only-Mutation-7738!" },
      { agentKey: "test" },
    );
  return { store, fence, id, deps, password };
}
describe("P6 original auth commit-fact bridge", () => {
  it("invalidates before original transaction await, no repair roundtrip, success reopens new-login admission", async () => {
    const h = setup();
    const get = h.store.getUser.bind(h.store),
      set = h.store.setPassword.bind(h.store);
    const queries = vi.spyOn(h.store, "getUser"),
      ordinarySet = vi.spyOn(h.store, "setPassword");
    const bridge = h.store as typeof h.store & PasswordFactStore;
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    bridge.setPasswordWithFact = vi.fn(async (input) => {
      expect(() => h.fence.check(h.id, h.fence.revision)).toThrow();
      entered();
      await barrier;
      const before = (await get(input.username))!;
      await set(input);
      const after = (await get(input.username))!;
      return passwordCommitFact({
        kind: "password-committed",
        userId: before.id,
        beforeEpoch: before.epoch,
        afterEpoch: after.epoch,
      });
    });
    const response = h.password();
    await reached;
    expect(queries).not.toHaveBeenCalled();
    expect(ordinarySet).not.toHaveBeenCalled();
    release();
    expect(await response).toEqual({ t: "lan_res", rid: "r", ok: true });
    expect(bridge.setPasswordWithFact).toHaveBeenCalledOnce();
    expect(queries).toHaveBeenCalledTimes(1); // Only original post-commit fan-out lookup.
    expect(() => h.fence.check({ ...h.id, sidTag: "new-login" }, h.fence.revision)).not.toThrow();
  });
  it("DB failure remains original admin E_INTERNAL and retains deny; terminal callback faults never replace successful auth", async () => {
    const h = setup(),
      bridge = h.store as typeof h.store & PasswordFactStore;
    bridge.setPasswordWithFact = async () => {
      throw Object.assign(new Error("original DB failed"), { code: "E_DB" });
    };
    expect(await h.password()).toMatchObject({ ok: false, code: "E_INTERNAL" });
    expect(() => h.fence.check(h.id, h.fence.revision)).toThrow();
    const other = setup(),
      set = other.store.setPassword.bind(other.store),
      get = other.store.getUser.bind(other.store);
    (other.store as typeof other.store & PasswordFactStore).setPasswordWithFact = async (input) => {
      const before = (await get(input.username))!;
      await set(input);
      const after = (await get(input.username))!;
      return passwordCommitFact({
        kind: "password-committed",
        userId: before.id,
        beforeEpoch: before.epoch,
        afterEpoch: after.epoch,
      });
    };
    other.fence.finishUserMutation = () => {
      throw new Error("terminal only");
    };
    expect(await other.password()).toEqual({ t: "lan_res", rid: "r", ok: true });
  });
  it("original business refusal is no-change, not a fake deleted-user fact", async () => {
    const h = setup(),
      cleanup = vi.fn();
    h.fence.subscribeCreators(cleanup);
    const response = await createAdminHandler(h.deps).handleLanReq(
      { t: "lan_req", rid: "r", op: "user_delete", username: "alice" },
      { agentKey: "test" },
    );
    expect(response).toMatchObject({ ok: false, code: "E_LAST_USER" });
    expect(() => h.fence.check(h.id, h.fence.revision)).not.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { kind: "password-committed", userId: 7, beforeEpoch: 3, afterEpoch: 3 },
    { kind: "password-committed", userId: 7, beforeEpoch: 3, afterEpoch: 4, extra: true },
  ])("rejects malformed/non-advancing original receipt %j", (fact) => {
    expect(() => passwordCommitFact(fact)).toThrow("E_DB");
  });
});
