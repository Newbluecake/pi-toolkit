/** #66 P6: real AES/GCM, real SQLite/child IPC, and deterministic fs faults. Temp homes only. */
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMaintScript, buildQueryScript, TOTP_KEY_PRELUDE } from "../../../src/web-hub/hub/db-child.js";
import { createLanStore, repairLan2fa, type LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { resolveHubPaths, webHubTotpKeyFile } from "../../../src/web-hub/protocol/paths.js";
import { HARDENING_PHASE, WRITER_SOAK_MS } from "../../../src/web-hub/hub/hardening.js";
import { formatLanOnLines } from "../../../src/web-hub/agent/lan-status.js";
import { formatTfaError, formatTfaStatusLines } from "../../../src/web-hub/agent/twofa-cmd.js";
import { startLan, lanPostJson, fakeClock } from "../http/lan-helpers.js";
import type { FakeLanStore } from "../contract/fakes.js";
import { memLog } from "./helpers.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const exec = promisify(execFile);
const at = 1_800_000_000_000;
const fp = (key: Buffer) => crypto.createHmac("sha256", key).update("pi-webhub-totp-key-check\0v1").digest();
function decode(s: string): Buffer {
  const bits = [...s].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}
function code(s: string, now: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = crypto.createHmac("sha1", decode(s)).update(counter).digest();
  return String((h.readUInt32BE(h[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
interface KeyApi {
  keyFingerprint(key: Buffer): Buffer;
  encryptTotp(secret: Buffer, key: Buffer, user: number): Buffer;
  decryptTotp(row: Buffer, key: Buffer | undefined, fp: Buffer | undefined, user: number): Buffer | undefined;
  createTotpKey(): Buffer | undefined;
  readTotpKey(): Buffer | undefined;
}
function keyApi(file: string, over: Partial<typeof fs> = {}): KeyApi {
  return runInNewContext(
    `const fs=require('node:fs'),crypto=require('node:crypto'); ${TOTP_KEY_PRELUDE}
    ({keyFingerprint,encryptTotp,decryptTotp,createTotpKey,readTotpKey})`,
    {
      Buffer,
      require: (id: string) => (id === "node:fs" ? { ...fs, ...over } : require(id)),
      process: { env: { PI_WEBHUB_TOTP_KEY: file }, pid: process.pid, getuid: process.getuid, stderr: { write() {} } },
    },
    { timeout: 2000 },
  ) as KeyApi;
}
let home: string, file: string, keyFile: string, store: LanStore | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "p6-totp-"));
  const paths = resolveHubPaths({ home, uid: process.getuid!() });
  file = paths.dbFile;
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  keyFile = paths.totpKeyFile!;
});
afterEach(async () => {
  await store?.close();
  store = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});
function sql<T>(fn: (db: import("node:sqlite").DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function open(phase: 1 | 2 = 1, now = at, extra: Partial<Parameters<typeof createLanStore>[0]> = {}) {
  const r = await createLanStore({
    dbFile: file,
    log: memLog(),
    maintHardening: { hardeningPhase: phase, now },
    ...extra,
  });
  if (!r.ok) throw Error(JSON.stringify(r));
  store = r.store;
  await store.getUserSummary(1);
  return r;
}
async function stop() {
  await store!.close();
  store = undefined;
}
async function enroll(userId = 1, now = at, replace = false) {
  const st = await store!.get2faState(userId);
  const pending = await store!.beginTotp({ userId, now, replace });
  const r = await store!.commitTotp({ userId, now, expectedGen: st.factorGen, code: code(pending.secretB32, now) });
  if (!r.ok) throw Error(r.reason);
  return { ...pending, codes: r.recoveryCodes, gen: st.factorGen + 1 };
}
function row(user = 1): Buffer {
  return Buffer.from(
    sql((db) => db.prepare("SELECT totp_secret FROM twofa WHERE user_id=?").get(user)!.totp_secret as Uint8Array),
  );
}
function storedFp(): string | undefined {
  return sql((db) => db.prepare("SELECT value FROM meta WHERE key='totp_key_fp'").get()?.value as string | undefined);
}
async function encrypted() {
  await open();
  const p = await enroll();
  await stop();
  const r = await open(2, at + WRITER_SOAK_MS);
  expect(r.hardening.totpMigrated).toBe(1);
  expect(row()).toHaveLength(53);
  return p;
}

it("fixed home-only path, phase 1 frozen, and query never computes writerActive", () => {
  expect(webHubTotpKeyFile(home)).toBe(`${home}/.local/state/pi-webhub/totp.key`);
  expect(keyFile).not.toContain("/.pi/");
  expect(HARDENING_PHASE).toBe(1);
  expect(buildQueryScript()).not.toContain("WRITER_SOAK");
  expect(buildQueryScript()).not.toContain("writerActiveVerdict");
  expect(buildQueryScript()).not.toContain("hardening_reader");
});

describe("envelope + atomic key filesystem", () => {
  it("53B layout, independent fingerprint, GCM roundtrip; every mutated byte and user AAD fail", () => {
    const api = keyApi(keyFile),
      key = crypto.randomBytes(32),
      secret = crypto.randomBytes(20);
    const r = api.encryptTotp(secret, key, 17);
    expect(api.keyFingerprint(key)).toEqual(fp(key));
    expect(r).toHaveLength(53);
    expect(r[0]).toBe(1);
    expect(r.subarray(1, 5)).toEqual(fp(key).subarray(0, 4));
    expect(api.decryptTotp(r, key, fp(key), 17)).toEqual(secret);
    expect(api.encryptTotp(secret, key, 17)).not.toEqual(r); // nonce is fresh
    for (let i = 0; i < 53; i++) {
      const bad = Buffer.from(r);
      bad[i] = bad[i]! ^ 1;
      expect(api.decryptTotp(bad, key, fp(key), 17), `byte ${i}`).toBeUndefined();
    }
    expect(api.decryptTotp(r, key, fp(key), 18)).toBeUndefined();
    expect(api.decryptTotp(r, undefined, fp(key), 17)).toBeUndefined();
    expect(api.decryptTotp(r, key, undefined, 17)).toBeUndefined();
    expect(api.decryptTotp(secret, undefined, undefined, 18)).toEqual(secret);
  });
  it("wx → file fsync → rename → directory fsync → readback, 0700/0600", () => {
    const events: string[] = [],
      fds = new Map<number, string>();
    const api = keyApi(keyFile, {
      openSync: ((p, flags, ...rest) => {
        const fd = fs.openSync(p, flags, ...rest);
        fds.set(fd, String(p));
        events.push(flags === "wx" ? "wx" : String(p) === dirname(keyFile) ? "dir-open" : "read-open");
        return fd;
      }) as typeof fs.openSync,
      fsyncSync: (fd) => {
        events.push(fds.get(fd) === dirname(keyFile) ? "dir-fsync" : "file-fsync");
        fs.fsyncSync(fd);
      },
      renameSync: (a, b) => {
        events.push("rename");
        fs.renameSync(a, b);
      },
    });
    const key = api.createTotpKey();
    expect(key).toHaveLength(32);
    expect(fs.readFileSync(keyFile)).toEqual(key);
    expect(events).toEqual(["wx", "file-fsync", "rename", "dir-open", "dir-fsync", "read-open"]);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dirname(keyFile))).toEqual(["totp.key"]);
  });
  it.each(["mkdir", "open", "write", "fsync", "close", "rename", "directory-fsync", "readback"])(
    "%s failure returns no key and cleans tmp",
    (fault) => {
      const over: Partial<typeof fs> = {};
      let fired = false;
      const fail = () => {
        fired = true;
        throw Object.assign(Error("injected"), { code: "EIO" });
      };
      if (fault === "mkdir") over.mkdirSync = (() => fail()) as typeof fs.mkdirSync;
      if (fault === "open")
        over.openSync = ((p, f, ...rest) => (f === "wx" ? fail() : fs.openSync(p, f, ...rest))) as typeof fs.openSync;
      if (fault === "write") over.writeFileSync = (() => fail()) as typeof fs.writeFileSync;
      if (fault === "fsync") over.fsyncSync = () => fail();
      if (fault === "close")
        over.closeSync = (fd) => {
          if (!fired) fail();
          fs.closeSync(fd);
        };
      if (fault === "rename") over.renameSync = () => fail();
      if (fault === "directory-fsync") {
        let n = 0;
        over.fsyncSync = (fd) => {
          if (++n === 2) fail();
          fs.fsyncSync(fd);
        };
      }
      if (fault === "readback") over.readFileSync = (() => fail()) as typeof fs.readFileSync;
      expect(keyApi(keyFile, over).createTotpKey()).toBeUndefined();
      expect(fired).toBe(true);
      if (fs.existsSync(dirname(keyFile)))
        expect(fs.readdirSync(dirname(keyFile)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    },
  );
  it.each(["EINVAL", "EISDIR"])("directory fsync unsupported (%s) is tolerated", (code) => {
    let n = 0;
    const api = keyApi(keyFile, {
      fsyncSync: (fd) => {
        if (++n === 2) throw Object.assign(Error("unsupported"), { code });
        fs.fsyncSync(fd);
      },
    });
    expect(api.createTotpKey()).toEqual(fs.readFileSync(keyFile));
  });
});

describe("real maintenance/state/enrollment", () => {
  it("phase1 and phase2 before soak neither create nor migrate; phase1 can read phase2 rows", async () => {
    await open(1);
    const p = await enroll();
    expect(row()).toHaveLength(20);
    expect(fs.existsSync(keyFile)).toBe(false);
    await stop();
    let r = await open(2, at + WRITER_SOAK_MS - 1);
    expect(r.hardening.writerActive).toBe(false);
    expect(row()).toHaveLength(20);
    expect(fs.existsSync(keyFile)).toBe(false);
    await stop();
    r = await open(2, at + WRITER_SOAK_MS);
    expect(r.hardening.writerActive).toBe(true);
    expect(r.hardening.totpKey).toBe("ok");
    expect(row()).toHaveLength(53);
    expect((await store!.get2faState(1)).factorGen).toBe(p.gen);
    await stop();
    r = await open(1, at + WRITER_SOAK_MS);
    expect(r.hardening.writerActive).toBe(false);
    expect(r.hardening.totpMigrated).toBe(0);
    expect(
      await store!.verifyTotp({ userId: 1, expectedGen: p.gen, now: at + 30000, code: code(p.secretB32, at + 30000) }),
    ).toEqual({ ok: true });
    await store!.reset2fa(1, at);
    await enroll();
    expect(row()).toHaveLength(20);
  });
  it.each([undefined, "stale", "missing"])(
    "rows53=0 ignores %s fp and adopts existing key even phase1",
    async (variant) => {
      await open();
      await stop();
      fs.mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
      const key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      if (variant !== undefined)
        sql((db) => db.prepare("INSERT INTO meta(key,value) VALUES('totp_key_fp',?)").run(variant));
      const r = await open(1);
      expect(r.hardening.totpKey).toBe("none");
      expect(storedFp()).toBe(fp(key).toString("base64url"));
      expect(fs.readFileSync(keyFile)).toEqual(key);
    },
  );
  it.each(["missing", "31B", "symlink", "foreign-owner", "fp-missing", "mismatch"])(
    "rows53>0: %s keeps LAN on, recovery/Feishu/reset usable, never replaces key/fp",
    async (kind) => {
      const p = await encrypted();
      await store!.setFeishu2fa({ userId: 1, on: true, now: at });
      await stop();
      const oldFp = storedFp();
      if (kind === "missing") fs.unlinkSync(keyFile);
      if (kind === "31B") fs.writeFileSync(keyFile, Buffer.alloc(31));
      if (kind === "symlink") {
        fs.renameSync(keyFile, `${keyFile}.target`);
        fs.symlinkSync(`${keyFile}.target`, keyFile);
      }
      if (kind === "foreign-owner") {
        // Deterministic owner fault in maintenance below (works without root privileges).
        return ownerMatrix(true);
      }
      if (kind === "fp-missing") sql((db) => db.exec("DELETE FROM meta WHERE key='totp_key_fp'"));
      if (kind === "mismatch") fs.writeFileSync(keyFile, crypto.randomBytes(32));
      const before = fs.existsSync(keyFile) ? fs.lstatSync(keyFile) : undefined;
      const r = await open(2, at + WRITER_SOAK_MS);
      const expected = kind === "fp-missing" || kind === "mismatch" ? "mismatch" : "missing";
      expect(r.hardening.totpKey).toBe(expected);
      expect(store!.warnings()).toContain(`totp-key-${expected}`);
      expect(await store!.get2faState(1)).toMatchObject({
        state: "enrolled",
        totp: true,
        totpUsable: false,
        feishu: true,
        recoveryLeft: 10,
      });
      expect(
        await store!.verifyTotp({
          userId: 1,
          expectedGen: p.gen + 1,
          now: at + 30000,
          code: code(p.secretB32, at + 30000),
        }),
      ).toEqual({ ok: false, reason: "unavailable" });
      expect(await store!.consumeRecovery({ userId: 1, expectedGen: p.gen + 1, now: at, code: p.codes[0]! })).toEqual({
        ok: true,
        recoveryLeft: 9,
      });
      expect(storedFp()).toBe(kind === "fp-missing" ? undefined : oldFp);
      if (before) expect(fs.lstatSync(keyFile).ino).toBe(before.ino);
      else expect(fs.existsSync(keyFile)).toBe(false);
      await store!.reset2fa(1, at);
      expect((await store!.get2faState(1)).state).toBe("none");
    },
  );
  it("single bad kid or GCM tag only disables its own row; valid peer still verifies", async () => {
    const p = await encrypted();
    await addUser();
    const q = await enroll(2);
    await stop();
    const bad = row();
    bad[1] = bad[1]! ^ 1;
    sql((db) => db.prepare("UPDATE twofa SET totp_secret=? WHERE user_id=1").run(bad));
    const r = await open(1);
    expect(r.hardening.totpKey).toBe("ok");
    expect((await store!.get2faState(1)).totpUsable).toBe(false);
    expect(
      await store!.verifyTotp({ userId: 1, expectedGen: p.gen, now: at + 30000, code: code(p.secretB32, at + 30000) }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await store!.verifyTotp({ userId: 2, expectedGen: q.gen, now: at + 30000, code: code(q.secretB32, at + 30000) }),
    ).toEqual({ ok: true });
    const tag = row(2);
    tag[52] = tag[52]! ^ 1;
    sql((db) => db.prepare("UPDATE twofa SET totp_secret=? WHERE user_id=2").run(tag));
    expect(
      await store!.verifyTotp({ userId: 2, expectedGen: q.gen, now: at + 60000, code: code(q.secretB32, at + 60000) }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
  it.each([false, true])(
    "key-missing → reset → restart (delete key=%s) → fp refreshed → enroll → ok",
    async (deleteKey) => {
      await encrypted();
      const keyA = fs.readFileSync(keyFile);
      await stop();
      fs.unlinkSync(keyFile);
      expect((await open(2, at + WRITER_SOAK_MS)).hardening.totpKey).toBe("missing");
      await store!.reset2fa(1, at);
      await stop();
      if (!deleteKey) fs.writeFileSync(keyFile, keyA, { mode: 0o600 });
      const r = await open(2, at + WRITER_SOAK_MS);
      expect(r.hardening.totpKey).toBe("none");
      const keyB = fs.readFileSync(keyFile);
      if (deleteKey) expect(keyB).not.toEqual(keyA);
      else expect(keyB).toEqual(keyA);
      expect(storedFp()).toBe(fp(keyB).toString("base64url"));
      const p = await enroll();
      expect(row()).toHaveLength(53);
      expect(row().subarray(1, 5)).toEqual(fp(keyB).subarray(0, 4));
      await stop();
      expect((await open(1)).hardening.totpKey).toBe("ok");
      expect(
        await store!.verifyTotp({
          userId: 1,
          expectedGen: p.gen,
          now: at + 30000,
          code: code(p.secretB32, at + 30000),
        }),
      ).toEqual({ ok: true });
    },
  );
  it("runtime reset + replacement refreshes fp atomically; no file falls back to 20B and next open migrates", async () => {
    await encrypted();
    await store!.reset2fa(1, at);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key);
    await enroll();
    expect(storedFp()).toBe(fp(key).toString("base64url"));
    expect(row().subarray(1, 5)).toEqual(fp(key).subarray(0, 4));
    await store!.reset2fa(1, at);
    fs.unlinkSync(keyFile);
    const p = await enroll();
    expect(row()).toHaveLength(20);
    await stop();
    const r = await open(2, at + WRITER_SOAK_MS);
    expect(r.hardening.totpMigrated).toBe(1);
    expect(row()).toHaveLength(53);
    expect(
      await store!.verifyTotp({ userId: 1, expectedGen: p.gen, now: at + 30000, code: code(p.secretB32, at + 30000) }),
    ).toEqual({ ok: true });
  });
  it("others53>0 + key mismatch/missing refuses commit E_TOTP_KEY without changing any data", async () => {
    await encrypted();
    await addUser();
    const original = row(),
      oldFp = storedFp();
    for (const missing of [false, true]) {
      if (missing) fs.unlinkSync(keyFile);
      else fs.writeFileSync(keyFile, crypto.randomBytes(32));
      const p = await store!.beginTotp({ userId: 2, now: at });
      await expect(
        store!.commitTotp({ userId: 2, expectedGen: 0, now: at, code: code(p.secretB32, at) }),
      ).rejects.toMatchObject({ code: "E_TOTP_KEY" });
      expect(row()).toEqual(original);
      expect(storedFp()).toBe(oldFp);
      expect((await store!.get2faState(2)).state).toBe("none");
    }
  });
  it.each(["missing", "mismatch"])(
    "explicit repair bypasses %s decryption, deletes fp but retains key",
    async (state) => {
      await encrypted();
      await stop();
      if (state === "missing") fs.unlinkSync(keyFile);
      else fs.writeFileSync(keyFile, crypto.randomBytes(32));
      const existed = fs.existsSync(keyFile),
        key = existed ? fs.readFileSync(keyFile) : undefined;
      expect(await repairLan2fa({ dbFile: file, log: memLog() })).toMatchObject({ ok: true });
      expect(storedFp()).toBeUndefined();
      expect(sql((db) => db.prepare("SELECT count(*) AS n FROM twofa").get()!.n)).toBe(0);
      expect(fs.existsSync(keyFile)).toBe(existed);
      if (key) expect(fs.readFileSync(keyFile)).toEqual(key);
    },
  );
  it.each(["31B", "symlink", "directory"])("rows53=0 handles noncompliant %s per r3 #4", async (kind) => {
    await open();
    await stop();
    fs.mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    const target = join(home, "target"),
      sentinel = Buffer.from("must not overwrite");
    fs.writeFileSync(target, sentinel);
    if (kind === "31B") fs.writeFileSync(keyFile, Buffer.alloc(31), { mode: 0o600 });
    if (kind === "symlink") fs.symlinkSync(target, keyFile);
    if (kind === "directory") {
      fs.mkdirSync(keyFile);
      fs.writeFileSync(join(keyFile, "keep"), sentinel);
    }
    const log = memLog(),
      r = await open(2, at + WRITER_SOAK_MS, { log });
    expect(r.hardening.totpKey).toBe("none");
    expect(log.lines.some((l) => JSON.stringify(l).includes("TOTP key warning"))).toBe(true);
    if (kind === "directory") {
      expect(fs.lstatSync(keyFile).isDirectory()).toBe(true);
      expect(storedFp()).toBeUndefined();
    } else {
      expect(fs.lstatSync(keyFile).isFile()).toBe(true);
      expect(fs.readFileSync(keyFile)).toHaveLength(32);
      expect(storedFp()).toBe(fp(fs.readFileSync(keyFile)).toString("base64url"));
    }
    expect(fs.readFileSync(target)).toEqual(sentinel);
  });
  it("0644 is chmod repaired/adopted, never rekeyed (even with encrypted rows)", async () => {
    await encrypted();
    const key = fs.readFileSync(keyFile);
    await stop();
    fs.chmodSync(keyFile, 0o644);
    fs.chmodSync(dirname(keyFile), 0o755);
    expect((await open(1)).hardening.totpKey).toBe("ok");
    expect(fs.readFileSync(keyFile)).toEqual(key);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);
  });
  it.each([false, true])(
    "foreign owner rows53=%s: deterministic fs spy, never touches encrypted key",
    async (hasRows) => {
      if (hasRows) await encrypted();
      else {
        await open();
        await stop();
        fs.mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
      }
      await stopIfNeeded();
      await ownerMatrix(hasRows);
    },
  );
  it("foreign-owned key directory refuses creation", async () => {
    await open();
    await stop();
    fs.mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    const writes = vi.fn(fs.renameSync);
    const r = maintVm({
      lstatSync: ((p, ...args) => {
        const st = fs.lstatSync(p, ...args);
        return String(p) === dirname(keyFile) ? Object.assign(Object.create(st), { uid: process.getuid!() + 1 }) : st;
      }) as typeof fs.lstatSync,
      renameSync: writes,
    });
    expect(r.hardening.totpKey).toBe("none");
    expect(r.hardening.totpWarnings).toContain("create-failed");
    expect(writes).not.toHaveBeenCalled();
    expect(fs.existsSync(keyFile)).toBe(false);
  });
  it.each(["key-created", "migration-committed"] as const)(
    "crash at %s recovers same key/fp, migration and truncate idempotently",
    async (crash) => {
      await open();
      const p = await enroll();
      await stop();
      await expect(
        exec(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "-e",
            buildMaintScript({ hardeningPhase: 2, now: at + WRITER_SOAK_MS, totpCrashAt: crash }),
          ],
          {
            env: {
              ...process.env,
              PI_WEBHUB_DB_PATH: file,
              PI_WEBHUB_DB_OP: "open-check-migrate",
              PI_WEBHUB_DB_DEADLINE_MS: "5000",
              PI_WEBHUB_TOTP_KEY: keyFile,
            },
            timeout: 5000,
            killSignal: "SIGKILL",
          },
        ),
      ).rejects.toMatchObject({ signal: "SIGKILL" });
      const key = fs.readFileSync(keyFile);
      expect(row()).toHaveLength(crash === "key-created" ? 20 : 53);
      const r = await open(2, at + WRITER_SOAK_MS);
      expect(fs.readFileSync(keyFile)).toEqual(key);
      expect(storedFp()).toBe(fp(key).toString("base64url"));
      expect(row()).toHaveLength(53);
      expect(r.hardening.truncateFailed).toBe(false);
      for (const name of [file, `${file}-wal`])
        if (fs.existsSync(name)) expect(fs.readFileSync(name).includes(decode(p.secretB32))).toBe(false);
      expect(
        await store!.verifyTotp({
          userId: 1,
          expectedGen: p.gen,
          now: at + 30000,
          code: code(p.secretB32, at + 30000),
        }),
      ).toEqual({ ok: true });
    },
  );
  it("real blocked TRUNCATE produces residue warning; retry removes old plaintext without bump gen", async () => {
    await open();
    const p = await enroll();
    await stop();
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN");
    holder.prepare("SELECT * FROM twofa").all();
    try {
      const r = await open(2, at + WRITER_SOAK_MS, { maintOpenDeadlineMs: 1000 });
      expect(r.hardening.totpMigrated).toBe(1);
      expect(r.hardening.truncateFailed).toBe(true);
      expect(store!.warnings()).toContain("totp-plaintext-residue");
      expect((await store!.get2faState(1)).factorGen).toBe(p.gen);
      holder.exec("ROLLBACK");
      holder.close();
      await stop();
      const next = await open(2, at + WRITER_SOAK_MS);
      expect(next.hardening.truncateFailed).toBe(false);
      expect(store!.warnings()).not.toContain("totp-plaintext-residue");
      for (const name of [file, `${file}-wal`])
        if (fs.existsSync(name)) expect(fs.readFileSync(name).includes(decode(p.secretB32))).toBe(false);
    } finally {
      try {
        holder.close();
      } catch {}
    }
  });
  it("all migrations preserve recovery hashes/salts, factor_gen and sessions; logs have no secrets/fp", async () => {
    await open();
    const p = await enroll();
    const recover = sql((db) => db.prepare("SELECT * FROM recovery_codes").all());
    const factor = sql((db) => db.prepare("SELECT recovery_salt,factor_gen FROM twofa").get());
    const session = await store!.createSessionChecked({
      userId: 1,
      expectedEpoch: 1,
      expectedFactorGen: p.gen,
      createdIp: "192.0.2.1",
      boundOrigin: "http://hub",
      now: at,
    });
    expect(session.ok).toBe(true);
    await stop();
    const log = memLog();
    await open(2, at + WRITER_SOAK_MS, { log });
    expect(sql((db) => db.prepare("SELECT * FROM recovery_codes").all())).toEqual(recover);
    expect(sql((db) => db.prepare("SELECT recovery_salt,factor_gen FROM twofa").get())).toEqual(factor);
    expect(await store!.listSessions(1, at)).toHaveLength(1);
    const logs = JSON.stringify(log.lines);
    for (const secret of [
      p.secretB32,
      decode(p.secretB32).toString("base64"),
      fs.readFileSync(keyFile).toString("base64"),
      storedFp()!,
    ])
      expect(logs).not.toContain(secret);
  });
});
async function stopIfNeeded() {
  if (store) await stop();
}
async function addUser() {
  await store!.setPassword({
    username: "second",
    kdf: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16),
    hash: Buffer.alloc(32),
  });
}
// VM runs the EXACT maintenance script with real sqlite/fs and just a deterministic lstat fault.
function maintVm(over: Partial<typeof fs> = {}) {
  let output = "";
  runInNewContext(
    buildMaintScript({ hardeningPhase: 2, now: at + WRITER_SOAK_MS }),
    {
      Buffer,
      require: (id: string) => (id === "node:fs" ? { ...fs, ...over } : require(id)),
      process: {
        env: {
          PI_WEBHUB_DB_PATH: file,
          PI_WEBHUB_DB_OP: "open-check-migrate",
          PI_WEBHUB_DB_DEADLINE_MS: "1000",
          PI_WEBHUB_TOTP_KEY: keyFile,
        },
        getuid: process.getuid,
        pid: process.pid,
        stdout: {
          write(s: string) {
            output += s;
          },
        },
        stderr: { write() {} },
      },
    },
    { timeout: 2000 },
  );
  const r = JSON.parse(output.trim()) as { ok: boolean; hardening: { totpKey: string; totpWarnings: string[] } };
  expect(r.ok).toBe(true);
  return r;
}
async function ownerMatrix(hasRows: boolean) {
  await stopIfNeeded();
  const before = fs.readFileSync(keyFile),
    oldFp = storedFp(),
    oldIno = fs.lstatSync(keyFile).ino;
  const rename = vi.fn(fs.renameSync),
    write = vi.fn(fs.writeFileSync),
    open = vi.fn(fs.openSync);
  const r = maintVm({
    lstatSync: ((p, ...args) => {
      const st = fs.lstatSync(p, ...args);
      return String(p) === keyFile && st.ino === oldIno
        ? Object.assign(Object.create(st), { uid: process.getuid!() + 1 })
        : st;
    }) as typeof fs.lstatSync,
    renameSync: rename,
    writeFileSync: write,
    openSync: open,
  });
  expect(r.hardening.totpKey).toBe(hasRows ? "missing" : "none");
  expect(r.hardening.totpWarnings).toContain("invalid-file");
  if (hasRows) {
    expect(rename).not.toHaveBeenCalled();
    expect(open.mock.calls.some(([, flags]) => flags === "wx")).toBe(false);
    expect(fs.readFileSync(keyFile)).toEqual(before);
    expect(storedFp()).toBe(oldFp);
  } else {
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(keyFile)).not.toEqual(before);
    expect(storedFp()).toBe(fp(fs.readFileSync(keyFile)).toString("base64url"));
  }
}

it("new warning tokens render recovery instructions, old unknown tokens stay ignored, repair keeps key file", () => {
  for (const warning of ["totp-key-missing", "totp-key-mismatch", "totp-plaintext-residue"]) {
    const lines = formatLanOnLines({
      state: "on",
      hosts: ["192.0.2.1"],
      port: 1234,
      omitted: [],
      warnings: [warning, "future-unknown"],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("/webhub restart");
    if (warning !== "totp-plaintext-residue") {
      expect(lines[1]).toContain("恢复码或飞书");
      expect(lines[1]).toContain("reset --confirm");
      expect(lines[1]).toContain("repair --confirm");
    }
  }
  expect(formatTfaError("E_TOTP_KEY", "secret-never-echoed")).not.toContain("secret-never-echoed");
  expect(formatTfaError("E_TOTP_KEY", "")).toContain("密钥文件保留");
  expect(
    formatTfaStatusLines({
      kind: "status",
      state: "inconsistent",
      totp: false,
      feishu: false,
      recoveryLeft: 0,
      knownIps: 0,
    }).join("\n"),
  ).toContain("同时解除 TOTP 密钥绑定");
});

it("XDG_STATE_HOME never changes home-derived key paths", () => {
  vi.stubEnv("XDG_STATE_HOME", join(home, "other"));
  try {
    expect(resolveHubPaths({ home, uid: process.getuid!() }).totpKeyFile).toBe(keyFile);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("real HTTP + SQLite keeps LAN on with missing key, advertises recovery only, recovery completes", async () => {
  const p = await encrypted();
  await stop();
  fs.unlinkSync(keyFile);
  await open(1);
  const credentials = { username: "http-owner", password: "a-real-P6-password" },
    salt = crypto.randomBytes(16);
  // Replace the initial user's password without touching the encrypted factor row.
  const initial = await store!.initialInfo();
  await store!.setPassword({
    username: initial!.username,
    kdf: "scrypt",
    n: 16384,
    r: 8,
    p: 1,
    salt,
    hash: crypto.scryptSync(credentials.password, salt, 32, { N: 16384, r: 8, p: 1 }),
  });
  credentials.username = initial!.username;
  // Helper's type is fake-only, but the object here is the actual SQLite port, with no mocked behavior.
  const h = await startLan({
    store: store as unknown as FakeLanStore,
    secondFactorEnabled: true,
    clock: fakeClock(at + 30000),
  });
  try {
    expect(h.fe.lan!.status()).toMatchObject({ state: "on", warnings: expect.arrayContaining(["totp-key-missing"]) });
    const challenge = await lanPostJson(h.port, "/api/login", credentials);
    expect(challenge.status).toBe(401);
    expect(JSON.parse(challenge.body)).toMatchObject({ error: "E_2FA", methods: ["recovery"] });
    const cookie = challenge.headers["set-cookie"]![0]!.split(";")[0]!;
    const success = await lanPostJson(
      h.port,
      "/api/login/2fa",
      { method: "recovery", code: p.codes[0]! },
      { Cookie: cookie },
    );
    expect(success.status).toBe(200);
    expect(success.headers["set-cookie"]![0]).toContain("pwh_lan=");
    expect(await store!.listSessions(1, at + 30000)).toMatchObject([{ method: "recovery" }]);
  } finally {
    await h.cleanup();
  }
});

it("running query uses cached key after deletion; a restarted query reports unavailable", async () => {
  const p = await encrypted();
  fs.unlinkSync(keyFile);
  expect(
    await store!.verifyTotp({ userId: 1, expectedGen: p.gen, now: at + 30000, code: code(p.secretB32, at + 30000) }),
  ).toEqual({ ok: true });
  await stop();
  await open(1);
  expect(
    await store!.verifyTotp({ userId: 1, expectedGen: p.gen, now: at + 60000, code: code(p.secretB32, at + 60000) }),
  ).toEqual({ ok: false, reason: "unavailable" });
});

it("reset and recovery NEVER decrypt, even a valid encrypted envelope (fs/crypto spy)", async () => {
  const p = await encrypted();
  await stop();
  const decipher = vi.fn(crypto.createDecipheriv);
  const child = runInNewContext(
    buildQueryScript() + "\n({handle,db})",
    {
      Buffer,
      require: (id: string) =>
        id === "node:crypto"
          ? { ...crypto, createDecipheriv: decipher }
          : id === "node:readline"
            ? { createInterface: () => ({ on() {} }) }
            : require(id),
      process: {
        env: { PI_WEBHUB_DB_PATH: file, PI_WEBHUB_TOTP_KEY: keyFile },
        getuid: process.getuid,
        pid: process.pid,
        stdout: { write() {}, on() {} },
        stderr: { write() {} },
        stdin: { on() {} },
      },
    },
    { timeout: 2000 },
  ) as { handle(op: string, args: Record<string, unknown>): unknown; db: import("node:sqlite").DatabaseSync };
  try {
    expect(child.handle("consumeRecovery", { userId: 1, expectedGen: p.gen, code: p.codes[0], now: at })).toEqual({
      ok: true,
      recoveryLeft: 9,
    });
    expect(decipher).not.toHaveBeenCalled();
    child.handle("get2faState", { userId: 1 });
    expect(decipher).toHaveBeenCalledTimes(1);
    decipher.mockClear();
    child.handle("reset2fa", { userId: 1, now: at });
    expect(decipher).not.toHaveBeenCalled();
    expect(sql((db) => db.prepare("SELECT totp_secret FROM twofa").get()!.totp_secret)).toBeNull();
  } finally {
    child.db.close();
  }
});

it.each(["wx", "write", "fsync", "rename", "dir-fsync", "readback"])(
  "maintenance key %s failure is none, no migration/fp and no tmp",
  async (fault) => {
    await open();
    const p = await enroll();
    await stop();
    const over: Partial<typeof fs> = {};
    let fired = false;
    const fail = () => {
      fired = true;
      throw Object.assign(Error("injected"), { code: "EIO" });
    };
    if (fault === "wx")
      over.openSync = ((path, flags, ...rest) =>
        flags === "wx" ? fail() : fs.openSync(path, flags, ...rest)) as typeof fs.openSync;
    if (fault === "write")
      over.writeFileSync = ((path, ...rest) =>
        typeof path === "number" ? fail() : fs.writeFileSync(path, ...rest)) as typeof fs.writeFileSync;
    if (fault === "fsync") over.fsyncSync = () => fail();
    if (fault === "rename") over.renameSync = () => fail();
    if (fault === "dir-fsync") {
      let n = 0;
      over.fsyncSync = (fd) => {
        if (++n === 2) fail();
        fs.fsyncSync(fd);
      };
    }
    if (fault === "readback") over.readFileSync = (() => fail()) as typeof fs.readFileSync;
    const r = maintVm(over);
    expect(fired).toBe(true);
    expect(r.hardening.totpKey).toBe("none");
    expect(r.hardening.totpWarnings).toContain("create-failed");
    expect(row()).toEqual(decode(p.secretB32));
    expect(storedFp()).toBeUndefined();
    if (fs.existsSync(dirname(keyFile)))
      expect(fs.readdirSync(dirname(keyFile)).some((n) => n.endsWith(".tmp"))).toBe(false);
  },
);

it.each(["missing", "31B", "symlink"])("maintenance rows53>0 %s issues no wx/rename/fp write", async (fault) => {
  await encrypted();
  await stop();
  if (fault === "missing") fs.unlinkSync(keyFile);
  if (fault === "31B") fs.writeFileSync(keyFile, Buffer.alloc(31));
  if (fault === "symlink") {
    fs.renameSync(keyFile, `${keyFile}.target`);
    fs.symlinkSync(`${keyFile}.target`, keyFile);
  }
  const oldFp = storedFp(),
    before = row(),
    open = vi.fn(fs.openSync),
    rename = vi.fn(fs.renameSync);
  expect(maintVm({ openSync: open, renameSync: rename }).hardening.totpKey).toBe("missing");
  expect(open.mock.calls.some(([, flags]) => flags === "wx")).toBe(false);
  expect(rename).not.toHaveBeenCalled();
  expect(storedFp()).toBe(oldFp);
  expect(row()).toEqual(before);
});

it.each([1, 2] as const)(
  "store forwards its sole maintenance phase-%i verdict to childEnv (not ambient env)",
  async (phase) => {
    await open();
    await stop();
    const envs: NodeJS.ProcessEnv[] = [];
    const r = await open(phase, at + WRITER_SOAK_MS, {
      dbClient: {
        spawnFn: ((...args: Parameters<typeof spawn>) => {
          envs.push({ ...args[2]?.env });
          return spawn(...args);
        }) as typeof spawn,
      },
    });
    expect(r.hardening.writerActive).toBe(phase === 2);
    expect(store!.hardening!.writerActive).toBe(r.hardening.writerActive);
    expect(envs).toHaveLength(1);
    expect(envs[0]!.PI_WEBHUB_TOTP_KEY).toBe(keyFile);
    expect(envs[0]!.PI_WEBHUB_TOTP_WRITE).toBe(phase === 2 ? "1" : "0");
    await enroll();
    expect(row()).toHaveLength(phase === 2 ? 53 : 20);
  },
);
