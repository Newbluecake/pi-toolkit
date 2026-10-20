import { describe, expect, it } from "vitest";
import { fakeLanStore } from "./fakes.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { NEW_IP_WINDOW_MS } from "../../../src/web-hub/protocol/lan-2fa.js";
async function fixture(options: Parameters<typeof fakeLanStore>[0] = {}) {
  const store = fakeLanStore(options);
  await store.setPassword({
    username: "test",
    kdf: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    salt: new Uint8Array(16),
    hash: new Uint8Array(32),
  });
  const user = (await store.getUser("test"))!;
  return {
    store,
    user,
    input: {
      userId: user.id,
      expectedEpoch: user.epoch,
      expectedFactorGen: 0,
      boundOrigin: "http://test:7879",
      createdIp: "192.168.1.2",
      now: 1000,
    },
  };
}
describe("P0 fake LAN security store (not production crypto)", () => {
  it("checks epoch and generation at atomic insertion; caps 32 and reports evictions", async () => {
    const { store, user, input } = await fixture();
    expect(await store.createSessionChecked({ ...input, expectedEpoch: user.epoch + 1 })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await store.createSessionChecked({ ...input, expectedFactorGen: 1 })).toEqual({
      ok: false,
      reason: "stale",
    });
    const first = await store.createSessionChecked(input);
    expect(first.ok).toBe(true);
    for (let i = 1; i < 32; i++)
      expect(await store.createSessionChecked({ ...input, now: 1000 + i })).toMatchObject({ ok: true, evicted: [] });
    const last = await store.createSessionChecked({ ...input, now: 1032, ua: "device" });
    expect(last).toMatchObject({ ok: true, evicted: [hashSid(first.ok ? first.sid : "")] });
    const list = await store.listSessions(user.id, 1032);
    expect(list).toHaveLength(32);
    expect(list.at(-1)?.ua).toBe("device");
    const keep = last.ok ? hashSid(last.sid) : "";
    expect(await store.deleteSessionsExcept(user.id, keep)).toMatchObject({ more: false, deleted: expect.any(Array) });
    expect(await store.listSessions(user.id, 1032)).toHaveLength(1);
  });
  it("touch enforces current epoch, expiry/idle and throttled last_ip", async () => {
    const { store, user, input } = await fixture({ idleMs: 300000 });
    const made = await store.createSessionChecked(input);
    if (!made.ok) throw Error("fixture");
    const hash = hashSid(made.sid);
    await store.touchSession(hash, 2000, { ip: "short" });
    expect((await store.listSessions(user.id, 2000))[0]?.lastIp).toBeUndefined();
    await store.touchSession(hash, 61000, { ip: "new" });
    expect((await store.listSessions(user.id, 61000))[0]).toMatchObject({ lastIp: "new", lastSeenAt: 61000 });
    expect(await store.touchSession(hash, 361000)).toBeUndefined();
    user.epoch++;
    expect(await store.touchSession(hash, 62000)).toBeUndefined();
  });
  it("note history is bounded, time-windowed and cleared by first enrollment", async () => {
    const { store, user } = await fixture();
    expect(await store.noteLoginIp(1, "a", 0)).toEqual({ wasKnown: false });
    expect(await store.noteLoginIp(1, "a", 1)).toEqual({ wasKnown: true });
    expect(await store.isKnownIp(1, "a", NEW_IP_WINDOW_MS + 1, NEW_IP_WINDOW_MS)).toBe(false);
    for (let i = 0; i < 257; i++) await store.noteLoginIp(1, `ip${i}`, i + 2);
    expect(await store.knownIpCount(1, 300, NEW_IP_WINDOW_MS)).toBe(256);
    expect(await store.isKnownIp(1, "ip0", 300, NEW_IP_WINDOW_MS)).toBe(false);
    const enrolled = await store.setFeishu2fa({ userId: user.id, on: true, now: 300 });
    expect(enrolled.recoveryCodes).toHaveLength(10);
    expect(await store.knownIpCount(1, 300, NEW_IP_WINDOW_MS)).toBe(0);
    expect(await store.get2faState(user.id)).toEqual({
      state: "enrolled",
      totp: false,
      feishu: true,
      recoveryLeft: 10,
      factorGen: 1,
    });
    await store.noteLoginIp(1, "new", 301);
    await store.forgetLoginIps();
    expect(await store.isKnownIp(1, "new", 302, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.get2faState(user.id)).toMatchObject({ state: "enrolled", factorGen: 2 });
  });
  it("recovery is single-use, stale gen refuses, regeneration invalidates the set", async () => {
    const { store, user } = await fixture();
    const { recoveryCodes } = await store.setFeishu2fa({ userId: user.id, on: true, now: 1 });
    const input = { userId: user.id, code: recoveryCodes![0]!, expectedGen: 1, now: 2 };
    const two = await Promise.all([store.consumeRecovery(input), store.consumeRecovery(input)]);
    expect(two).toEqual([
      { ok: true, recoveryLeft: 9 },
      { ok: false, reason: "replay" },
    ]);
    expect(await store.consumeRecovery({ ...input, expectedGen: 0 })).toEqual({ ok: false, reason: "stale" });
    await store.regenRecovery(user.id, 3);
    expect(await store.consumeRecovery({ ...input, expectedGen: 2 })).toEqual({ ok: false, reason: "bad" });
    await store.reset2fa(user.id, 4);
    expect(await store.get2faState(user.id)).toMatchObject({ state: "none", recoveryLeft: 0, factorGen: 3 });
  });
  it("TOTP requires an explicit verifier seam, confirms pending state, rejects replays", async () => {
    const { store, user } = await fixture({
      totpStep: (_s, c, now) => (c === "123456" ? Math.floor(now / 30000) : undefined),
    });
    const begin = await store.beginTotp({ userId: user.id, now: 0 });
    expect(begin.secretB32).toMatch(/^[A-Z2-7]{32}$/);
    expect(await store.commitTotp({ userId: user.id, code: "000000", expectedGen: 0, now: 0 })).toEqual({
      ok: false,
      reason: "bad",
    });
    expect(await store.commitTotp({ userId: user.id, code: "123456", expectedGen: 0, now: 0 })).toMatchObject({
      ok: true,
      recoveryCodes: expect.any(Array),
    });
    expect(await store.verifyTotp({ userId: user.id, code: "123456", expectedGen: 1, now: 0 })).toEqual({
      ok: false,
      reason: "replay",
    });
    expect(await store.verifyTotp({ userId: user.id, code: "123456", expectedGen: 1, now: 30000 })).toEqual({
      ok: true,
    });
    expect(await store.verifyTotp({ userId: user.id, code: "123456", expectedGen: 0, now: 60000 })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await store.get2faState(user.id)).not.toHaveProperty("secretB32");
    const other = await fixture();
    await other.store.beginTotp({ userId: other.user.id, now: 0 });
    expect(await other.store.commitTotp({ userId: other.user.id, code: "123456", expectedGen: 0, now: 0 })).toEqual({
      ok: false,
      reason: "bad",
    });
  });
  it("latches model dispatched operations; state is checked AFTER release", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { store, user, input } = await fixture({
      beforeOp: async (op) => {
        if (op === "createSessionChecked") await gate;
      },
    });
    const inflight = store.createSessionChecked(input);
    user.epoch++;
    release();
    expect(await inflight).toEqual({ ok: false, reason: "stale" });
    expect(store.sessionsBySidHash.size).toBe(0);
  });
});
