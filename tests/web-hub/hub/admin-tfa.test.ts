/**
 * LAN security r2 §5.8 / §10 row F: hub-side `tfa_req` dispatch in `hub/admin.ts`.
 *
 * Runs against the P0 fake store (`tests/web-hub/contract/fakes.ts`) — no real sqlite/TOTP
 * crypto. Proves: per-op mapping + error codes, primary-account resolution, `passwd` /
 * `2fa-changed` emit seams (P0 addendum item 6), cap advertisement gated on `advertiseTfa`,
 * repair working with the LAN store OFF, and the §5.8 secret-transport boundary (no secret,
 * URI or user-entered code ever reaches the log/audit lines). Every response is validated
 * against the frozen `TfaResSchema`.
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { fakeKdf, fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { createAdminHandler, type AdminDeps, type AdminMeta } from "../../../src/web-hub/hub/admin.js";
import type { SecurityEvent } from "../../../src/web-hub/hub/security-events.js";
import type { RepairLan2faResult } from "../../../src/web-hub/hub/lan-store.js";
import {
  RECOVERY_CODE_RE,
  TfaResSchema,
  type TfaReqFrame,
  type TfaResFrame,
} from "../../../src/web-hub/protocol/lan-2fa.js";
import { LAN_2FA_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { memLog, type MemLog } from "./helpers.js";

const META: AdminMeta = { agentKey: "a1", agentPid: 99 };
const NOW = 1_800_000_000_000;

function seedAdmin(store: FakeLanStore): void {
  store.seedUser({
    id: 1,
    username: "admin",
    kdf: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    salt: new Uint8Array(16),
    hash: new Uint8Array(32),
    epoch: 1,
    initialPassword: "abc-def-ghi",
    initialCreatedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
  });
}

interface Harness {
  deps: AdminDeps;
  log: MemLog;
  store: FakeLanStore;
  emitted: SecurityEvent[];
  call(frame: Omit<TfaReqFrame, "t" | "rid"> & { rid?: string }): Promise<TfaResFrame>;
}

function harness(over: Partial<AdminDeps> = {}, storeOptions: Parameters<typeof fakeLanStore>[0] = {}): Harness {
  const log = memLog();
  const store = fakeLanStore(storeOptions);
  const emitted: SecurityEvent[] = [];
  const deps: AdminDeps = {
    log,
    hasLan: () => true,
    store: () => store,
    kdf: () => undefined,
    limiter: () => undefined,
    lan: () => undefined,
    lanStatus: () => undefined,
    shutdown: () => {},
    now: () => NOW,
    emit: (e) => emitted.push(e),
    advertiseTfa: true,
    ...over,
  };
  const admin = createAdminHandler(deps);
  return {
    deps,
    log,
    store,
    emitted,
    call: (frame) => admin.handleTfaReq({ ...frame, t: "tfa_req", rid: frame.rid ?? "r1" } as TfaReqFrame, META),
  };
}

/** Every assertion below only accepts schema-valid frames (the wire contract, P0 §5.8). */
function expectValid(res: TfaResFrame): void {
  expect(Value.Check(TfaResSchema, res), JSON.stringify(res)).toBe(true);
}

function logText(log: MemLog): string {
  return JSON.stringify(log.lines);
}

async function enrollTotp(h: Harness): Promise<{ secretB32: string; codes: string[] }> {
  const begin = await h.call({ op: "totp_begin" });
  expect(begin.ok).toBe(true);
  if (!begin.ok || begin.data.kind !== "totp_begin") throw new Error("begin failed");
  const confirm = await h.call({ op: "totp_confirm", code: "123456", rid: "r2" });
  expect(confirm.ok).toBe(true);
  if (!confirm.ok || confirm.data.kind !== "totp_confirm") throw new Error("confirm failed");
  return { secretB32: begin.data.secretB32, codes: confirm.data.recoveryCodes };
}

const totpStepOk = (_secret: string, code: string, now: number): number | undefined =>
  code === "123456" ? Math.floor(now / 30000) : undefined;

describe("admin tfa_req caps (§5.8, P0: advertise only after routing exists)", () => {
  it("advertiseTfa absent ⇒ cap list byte-identical to pre-F", () => {
    const h = harness({ advertiseTfa: undefined });
    expect(createAdminHandler(h.deps).caps()).toEqual(["ctl.v1", "lan.v1"]);
    const off = harness({ advertiseTfa: undefined, hasLan: () => false });
    expect(createAdminHandler(off.deps).caps()).toEqual(["ctl.v1"]);
  });

  it("advertiseTfa: true ⇒ lan.2fa.v1 appended on both LAN-on and LAN-off configurations", () => {
    expect(createAdminHandler(harness().deps).caps()).toEqual(["ctl.v1", "lan.v1", LAN_2FA_HUB_CAP]);
    expect(createAdminHandler(harness({ hasLan: () => false }).deps).caps()).toEqual(["ctl.v1", LAN_2FA_HUB_CAP]);
  });
});

describe("admin tfa_req ops (§5.8)", () => {
  it("status before enrollment ⇒ state none, zero counts, schema-valid", async () => {
    const h = harness();
    seedAdmin(h.store);
    const res = await h.call({ op: "status" });
    expectValid(res);
    expect(res).toEqual({
      t: "tfa_res",
      rid: "r1",
      ok: true,
      data: { kind: "status", state: "none", totp: false, feishu: false, recoveryLeft: 0, knownIps: 0 },
    });
    expect(h.emitted).toEqual([]);
  });

  it("status reflects enrollment and the 30d known-IP count", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    await enrollTotp(h);
    await h.store.noteLoginIp(1, "192.168.32.38", NOW);
    await h.store.noteLoginIp(1, "192.168.32.39", NOW - 31 * 24 * 3_600_000); // outside the window
    const res = await h.call({ op: "status" });
    expectValid(res);
    if (!res.ok || res.data.kind !== "status") throw new Error("bad status");
    expect(res.data).toMatchObject({ state: "enrolled", totp: true, feishu: false, recoveryLeft: 10, knownIps: 1 });
  });

  it.each(["2fa-at-v1", "2fa-schema", "2fa-missing-row"])(
    "status uses B's actual open refusal detail with LAN store off: %s",
    async (detail) => {
      const h = harness({ store: () => undefined, lanStatus: () => ({ state: "off", reason: "db-invalid", detail }) });
      const res = await h.call({ op: "status" });
      expectValid(res);
      expect(res).toMatchObject({ ok: true, data: { kind: "status", state: "inconsistent", repairNeeded: detail } });
    },
  );

  it("totp_begin ⇒ secret stays inside the response variant; second begin without replace ⇒ E_2FA_ENROLLED", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    const begin = await h.call({ op: "totp_begin" });
    expectValid(begin);
    if (!begin.ok || begin.data.kind !== "totp_begin") throw new Error("begin failed");
    expect(begin.data.secretB32).toMatch(/^[A-Z2-7]{16,128}$/);
    expect(begin.data.otpauthUri.startsWith("otpauth://totp/")).toBe(true);

    await enrollTotp(h);
    const again = await h.call({ op: "totp_begin", rid: "r3" });
    expectValid(again);
    expect(again).toMatchObject({ ok: false, code: "E_2FA_ENROLLED" });
    const replaced = await h.call({ op: "totp_begin", replace: true, rid: "r4" });
    expectValid(replaced);
    expect(replaced.ok).toBe(true);
  });

  it("totp_confirm ⇒ 10 unique recovery codes + 2fa-changed emit; bad code ⇒ E_2FA_CODE; no pending ⇒ E_2FA_NONE", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    const { codes } = await enrollTotp(h);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(RECOVERY_CODE_RE);
    expect(h.emitted).toEqual([{ type: "2fa-changed", op: "totp_confirm" }]);

    // bad code on a fresh pending enrollment ⇒ E_2FA_CODE (never echoes the code)
    await h.call({ op: "totp_begin", replace: true, rid: "b1" });
    const bad = await h.call({ op: "totp_confirm", code: "654321", rid: "b2" });
    expectValid(bad);
    expect(bad).toMatchObject({ ok: false, code: "E_2FA_CODE" });
    expect(JSON.stringify(bad)).not.toContain("654321");

    // no pending enrollment ⇒ E_2FA_NONE
    const h2 = harness({}, { totpStep: totpStepOk });
    seedAdmin(h2.store);
    const none = await h2.call({ op: "totp_confirm", code: "123456" });
    expectValid(none);
    expect(none).toMatchObject({ ok: false, code: "E_2FA_NONE" });
  });

  it("commitTotp preserving an existing recovery set (B contract: recoveryCodes: []) ⇒ {kind:'ok'} variant", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    const { codes } = await enrollTotp(h);
    // Explicitly test the preserved-recovery response variant (fake and SQLite now both preserve it).
    await h.call({ op: "totp_begin", replace: true, rid: "e1" });
    const res = await h.call({ op: "totp_confirm", code: "123456", rid: "e2" });
    expectValid(res);
    expect(res).toMatchObject({ ok: true, data: { kind: "ok" } });
    expect(h.emitted.at(-1)).toEqual({ type: "2fa-changed", op: "totp_confirm" });
    // the pre-existing recovery set survives untouched
    const gen = (await h.store.get2faState(1)).factorGen;
    const verdict = await h.store.consumeRecovery({ userId: 1, code: codes[0]!, expectedGen: gen, now: NOW });
    expect(verdict.ok).toBe(true);
  });

  it("feishu on (first, Feishu-only enrollment, Q19) ⇒ recovery_regen variant; off as sole factor ⇒ unenrolled", async () => {
    const h = harness({ feishuOwner: () => true });
    seedAdmin(h.store);
    const on = await h.call({ op: "feishu", on: true });
    expectValid(on);
    if (!on.ok || on.data.kind !== "recovery_regen") throw new Error("expected recovery_regen variant");
    expect(on.data.recoveryCodes).toHaveLength(10);
    expect(h.emitted).toEqual([{ type: "2fa-changed", op: "feishu" }]);
    expect((await h.store.get2faState(1)).state).toBe("enrolled");

    const off = await h.call({ op: "feishu", on: false });
    expectValid(off);
    expect(off).toMatchObject({ ok: true, data: { kind: "ok" } });
    expect((await h.store.get2faState(1)).state).toBe("none");
    expect(h.emitted).toHaveLength(2);
  });

  it("feishu on refused without a bot owner; dep absent ⇒ fail closed", async () => {
    const refused = harness({ feishuOwner: () => false });
    seedAdmin(refused.store);
    const res = await refused.call({ op: "feishu", on: true });
    expectValid(res);
    expect(res).toMatchObject({ ok: false, code: "E_NO_FEISHU" });
    expect((await refused.store.get2faState(1)).state).toBe("none");

    const legacy = harness({ feishuOwner: undefined });
    seedAdmin(legacy.store);
    const ok = await legacy.call({ op: "feishu", on: true });
    expectValid(ok);
    expect(ok).toMatchObject({ ok: false, code: "E_NO_FEISHU" });
  });

  it("recovery_regen ⇒ new set, old codes die; not enrolled ⇒ E_2FA_NONE", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    const { codes: oldCodes } = await enrollTotp(h);
    const regen = await h.call({ op: "recovery_regen" });
    expectValid(regen);
    if (!regen.ok || regen.data.kind !== "recovery_regen") throw new Error("regen failed");
    expect(regen.data.recoveryCodes).toHaveLength(10);
    expect(h.emitted.at(-1)).toEqual({ type: "2fa-changed", op: "recovery_regen" });

    const gen = (await h.store.get2faState(1)).factorGen;
    const oldVerdict = await h.store.consumeRecovery({ userId: 1, code: oldCodes[0]!, expectedGen: gen, now: NOW });
    expect(oldVerdict).toEqual({ ok: false, reason: "bad" });
    const newVerdict = await h.store.consumeRecovery({
      userId: 1,
      code: regen.data.recoveryCodes[0]!,
      expectedGen: gen,
      now: NOW,
    });
    expect(newVerdict.ok).toBe(true);

    const h2 = harness();
    seedAdmin(h2.store);
    const none = await h2.call({ op: "recovery_regen" });
    expectValid(none);
    expect(none).toMatchObject({ ok: false, code: "E_2FA_NONE" });
  });

  it("reset clears every factor (state none) and emits; forget_ips empties trust history and emits", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    await enrollTotp(h);
    await h.store.noteLoginIp(1, "192.168.32.38", NOW);

    const forgot = await h.call({ op: "forget_ips" });
    expectValid(forgot);
    expect(forgot).toMatchObject({ ok: true, data: { kind: "ok" } });
    expect(await h.store.isKnownIp(1, "192.168.32.38", NOW, 30 * 24 * 3_600_000)).toBe(false);
    expect(h.emitted.at(-1)).toEqual({ type: "2fa-changed", op: "forget_ips" });

    const reset = await h.call({ op: "reset", confirm: true });
    expectValid(reset);
    expect(reset).toMatchObject({ ok: true, data: { kind: "ok" } });
    expect((await h.store.get2faState(1)).state).toBe("none");
    expect(h.emitted.at(-1)).toEqual({ type: "2fa-changed", op: "reset" });
  });

  it("repair works with the LAN store OFF (maintenance path, §5.2); failure ⇒ E_DB", async () => {
    const storeOff = harness({
      store: () => undefined,
      repair2fa: async (): Promise<RepairLan2faResult> => ({ ok: true }),
    });
    const ok = await storeOff.call({ op: "repair", confirm: true });
    expectValid(ok);
    expect(ok).toMatchObject({ ok: true, data: { kind: "ok" } });
    expect(storeOff.emitted).toEqual([{ type: "2fa-changed", op: "repair" }]);
    // B contract (binding): repairLan2fa self-audits the repair op — admin.ts must not duplicate it.
    expect(
      storeOff.log.lines.filter(
        (l) =>
          (l.data as { audit?: string; op?: string } | undefined)?.audit === "lan-2fa" &&
          (l.data as { op?: string }).op === "repair",
      ),
    ).toEqual([]);

    const notWired = harness({ repair2fa: undefined });
    seedAdmin(notWired.store);
    const unsupported = await notWired.call({ op: "repair", confirm: true });
    expectValid(unsupported);
    expect(unsupported).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });

    const failing = harness({
      store: () => undefined,
      repair2fa: async (): Promise<RepairLan2faResult> => ({ ok: false, reason: "db-invalid", detail: "disk" }),
    });
    const bad = await failing.call({ op: "repair", confirm: true });
    expectValid(bad);
    expect(bad).toMatchObject({ ok: false, code: "E_DB" });
    if (!bad.ok) expect(bad.message).toContain("db-invalid");
  });

  it("E_NO_LAN when LAN is off / store missing; E_NO_USER without a LAN account", async () => {
    const off = harness({ hasLan: () => false, store: () => undefined });
    for (const frame of [{ op: "status" }, { op: "totp_begin" }] as const) {
      const res = await off.call(frame);
      expectValid(res);
      expect(res).toMatchObject({ ok: false, code: "E_NO_LAN" });
    }
    const noUser = harness();
    const res = await noUser.call({ op: "status" });
    expectValid(res);
    expect(res).toMatchObject({ ok: false, code: "E_NO_USER" });
  });

  it("a throwing store ⇒ E_INTERNAL with a redacted log line (no secret-shaped fields leak)", async () => {
    const h = harness();
    seedAdmin(h.store);
    const boom = Object.assign(new Error("sqlite exploded"), { password: "hunter2-hunter2" });
    const throwing = new Proxy(h.store, {
      get(target, key, receiver) {
        if (key === "get2faState") return async () => Promise.reject(boom);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    h.deps.store = () => throwing;
    const res = await h.call({ op: "status" });
    expectValid(res);
    expect(res).toMatchObject({ ok: false, code: "E_INTERNAL" });
    const errLine = h.log.lines.find((l) => l.level === "error");
    expect(errLine?.msg).toContain("tfa_req");
    const text = logText(h.log);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("hunter2-hunter2");
  });
});

describe("admin tfa_req audit + secret boundary (§8, §5.8, §10 row F)", () => {
  it("every op writes exactly one {op, ok} audit line; a full enrollment leaks nothing into the log", async () => {
    const h = harness({}, { totpStep: totpStepOk });
    seedAdmin(h.store);
    const { secretB32, codes } = await enrollTotp(h);
    await h.call({ op: "status", rid: "s1" });
    await h.call({ op: "recovery_regen", rid: "s2" });
    await h.call({ op: "totp_confirm", code: "123456", rid: "s3" }); // no pending ⇒ E_2FA_NONE

    const auditLines = h.log.lines.filter((l) => (l.data as { audit?: string } | undefined)?.audit === "lan-2fa");
    expect(auditLines.map((l) => (l.data as { op?: string }).op)).toEqual([
      "totp_begin",
      "totp_confirm",
      "status",
      "recovery_regen",
      "totp_confirm",
    ]);
    for (const l of auditLines) {
      expect(Object.keys(l.data as object).sort()).toEqual(["audit", "ok", "op"]);
    }

    // §5.8 boundary: no secret / URI / recovery code / user-entered code in ANY log line.
    const text = logText(h.log);
    expect(text).not.toContain(secretB32);
    expect(text).not.toContain("otpauth://");
    for (const c of codes) expect(text).not.toContain(c);
    expect(text).not.toContain("123456");
  });

  it("passwd emits {type:'passwd'} after the commit (P0 addendum item 6)", async () => {
    const h = harness({ kdf: () => fakeKdf() });
    seedAdmin(h.store);
    const admin = createAdminHandler(h.deps);
    const res = await admin.handleLanReq(
      { t: "lan_req", rid: "p1", op: "passwd", username: "admin", password: "new-password-123" },
      META,
    );
    expect(res.ok).toBe(true);
    expect(h.emitted).toEqual([{ type: "passwd" }]);
  });

  it("a failing op emits nothing", async () => {
    const h = harness();
    seedAdmin(h.store);
    await h.call({ op: "totp_confirm", code: "123456" }); // E_2FA_NONE
    await h.call({ op: "recovery_regen" }); // E_2FA_NONE
    expect(h.emitted).toEqual([]);
  });
});

describe("#66 P6 TOTP key errors are append-only, status remains strict", () => {
  it("E_TOTP_KEY returns fixed recovery hint and no error/key material", async () => {
    const h = harness();
    seedAdmin(h.store);
    h.store.commitTotp = async () => {
      throw Object.assign(Error("should-not-appear-in-logs"), { code: "E_TOTP_KEY" });
    };
    const res = await h.call({ op: "totp_confirm", code: "123456" });
    expectValid(res);
    expect(res).toMatchObject({ ok: false, code: "E_TOTP_KEY" });
    if (res.ok) throw Error("expected refusal");
    expect(res.message).toContain("/webhub restart");
    expect(res.message).toContain("reset or repair");
    expect(logText(h.log)).not.toContain("should-not-appear-in-logs");
    expect(logText(h.log)).not.toContain("123456");
  });
  it("internal totpUsable=false never leaks into strict status payload", async () => {
    const h = harness();
    seedAdmin(h.store);
    h.store.get2faState = async () => ({
      state: "enrolled",
      totp: true,
      totpUsable: false,
      feishu: true,
      recoveryLeft: 10,
      factorGen: 7,
    });
    const res = await h.call({ op: "status" });
    expectValid(res);
    expect(res).toMatchObject({ ok: true, data: { state: "enrolled", totp: true, feishu: true, recoveryLeft: 10 } });
    expect(JSON.stringify(res)).not.toContain("totpUsable");
  });
});
