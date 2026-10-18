import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FEISHU_CREDENTIALS_FILE,
  computeRequestToken,
  createCredentialStore,
  ensurePrivateDir,
  parseCredentials,
  readPrivateFile,
  realFeishuFs,
  validateCredentialInput,
  writeFileAtomicPrivate,
} from "../../../../src/web-hub/hub/feishu/credentials.js";
import type { CredentialInput, FeishuFs } from "../../../../src/web-hub/hub/feishu/credentials.js";
import { FEISHU_CREDENTIALS_MAX_BYTES } from "../../../../src/web-hub/protocol/feishu.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";

const INPUT: CredentialInput = {
  brand: "feishu",
  appId: "cli_a1b2c3d4e5f6",
  appSecret: "S3cr3tS3cr3tS3cr3tS3cr3tS3cr3t12",
  ownerOpenId: "ou_owner0123456789",
};

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feishu-cred-"));
  dir = join(root, "feishu-bot");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function wrapFs(overrides: Partial<FeishuFs>): FeishuFs {
  return { ...realFeishuFs, ...overrides };
}
const mode = (p: string): number => lstatSync(p).mode & 0o777;
function store(extra: Partial<Parameters<typeof createCredentialStore>[0]> = {}) {
  const clock = createFakeClock(1_760_000_000_000);
  return { clock, s: createCredentialStore({ dir, clock, ...extra }) };
}
function plant(content: string | object, fileMode = 0o600): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, FEISHU_CREDENTIALS_FILE);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), { mode: fileMode });
  chmodSync(p, fileMode);
  return p;
}
const GOOD = {
  v: 1,
  brand: "feishu",
  appId: INPUT.appId,
  appSecret: INPUT.appSecret,
  ownerOpenId: INPUT.ownerOpenId,
  createdAt: "2026-10-18T00:00:00.000Z",
  gen: 5,
  installSecret: "A".repeat(43),
};

describe("credential commit / load", () => {
  it("writes a 0600 file in a 0700 dir with the §4.4 shape and reloads identically", async () => {
    const { s } = store();
    expect((await s.load()).kind).toBe("absent");
    expect(existsSync(dir)).toBe(false); // load never creates anything
    const r = await s.commit({ ...INPUT, botOpenId: "ou_bot0123456789" });
    expect(r.ok).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(mode(s.path)).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(s.path, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(
      ["appId", "appSecret", "botOpenId", "brand", "createdAt", "gen", "installSecret", "ownerOpenId", "v"].sort(),
    );
    expect(onDisk.v).toBe(1);
    expect(statSync(s.path).size).toBeLessThanOrEqual(FEISHU_CREDENTIALS_MAX_BYTES);
    expect(readdirSync(dir)).toEqual([FEISHU_CREDENTIALS_FILE]); // no tmp left behind
    const again = createCredentialStore({ dir });
    const loaded = await again.load();
    expect(loaded.kind).toBe("loaded");
    expect(again.current()).toEqual(s.current());
    expect(again.tokenCredentials()).toEqual({
      appId: INPUT.appId,
      appSecret: INPUT.appSecret,
      gen: onDisk.gen,
    });
    expect(again.secrets()).toEqual([INPUT.appSecret]);
  });

  it("mints strictly increasing gens (also with an unchanged clock) and a fresh installSecret each commit", async () => {
    const { s } = store();
    const a = await s.commit(INPUT);
    const b = await s.commit(INPUT);
    const c = await s.commit({ ...INPUT, brand: "lark" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("commit failed");
    expect(a.credentials.gen).toBe(1_760_000_000_000);
    expect(b.credentials.gen).toBe(a.credentials.gen + 1);
    expect(c.credentials.gen).toBe(b.credentials.gen + 1);
    expect(new Set([a, b, c].map((x) => x.credentials.installSecret)).size).toBe(3);
    for (const x of [a, b, c]) expect(x.credentials.installSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.credentials.brand).toBe("lark");
    expect(JSON.parse(readFileSync(s.path, "utf8")).brand).toBe("lark");
  });

  it("gen keeps increasing across reset (remove) inside a process", async () => {
    const { s } = store();
    const a = await s.commit(INPUT);
    await s.remove();
    const b = await s.commit(INPUT);
    if (!a.ok || !b.ok) throw new Error("commit failed");
    expect(b.credentials.gen).toBeGreaterThan(a.credentials.gen);
  });

  it("rejects invalid input without touching the disk", async () => {
    const { s } = store();
    for (const bad of [
      { ...INPUT, appId: "app_x" },
      { ...INPUT, appSecret: "" },
      { ...INPUT, appSecret: "has space" },
      { ...INPUT, ownerOpenId: "u_x" },
      { ...INPUT, brand: "other" as never },
      { ...INPUT, botOpenId: "nope" },
    ]) {
      expect(validateCredentialInput(bad)).toBe(false);
      expect(await s.commit(bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(existsSync(dir)).toBe(false);
  });

  it("setBotOpenId only applies to the loaded generation", async () => {
    const { s } = store();
    const r = await s.commit(INPUT);
    if (!r.ok) throw new Error("commit failed");
    expect(await s.setBotOpenId(r.credentials.gen + 1, "ou_bot0123456789")).toBe(false);
    expect(await s.setBotOpenId(r.credentials.gen, "bad")).toBe(false);
    expect(s.current()?.botOpenId).toBeUndefined();
    expect(await s.setBotOpenId(r.credentials.gen, "ou_bot0123456789")).toBe(true);
    expect(s.current()?.botOpenId).toBe("ou_bot0123456789");
    expect(JSON.parse(readFileSync(s.path, "utf8")).botOpenId).toBe("ou_bot0123456789");
    expect(mode(s.path)).toBe(0o600);
  });

  it("current() is a defensive copy", async () => {
    const { s } = store();
    await s.commit(INPUT);
    const c = s.current()!;
    c.appSecret = "tampered";
    expect(s.current()!.appSecret).toBe(INPUT.appSecret);
  });
});

describe("credential load: unsafe ⇒ not loaded, never overwritten", () => {
  const cases: Array<{ name: string; check: string; arrange: () => string }> = [
    {
      name: "world/group-readable file",
      check: "file-mode",
      arrange: () => plant(GOOD, 0o644),
    },
    {
      name: "symlink to a good file",
      check: "file-symlink",
      arrange: () => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const target = join(root, "target.json");
        writeFileSync(target, JSON.stringify(GOOD), { mode: 0o600 });
        const p = join(dir, FEISHU_CREDENTIALS_FILE);
        symlinkSync(target, p);
        return p;
      },
    },
    {
      name: "directory instead of a file",
      check: "file-not-regular",
      arrange: () => {
        mkdirSync(join(dir, FEISHU_CREDENTIALS_FILE), { recursive: true });
        return join(dir, FEISHU_CREDENTIALS_FILE);
      },
    },
    {
      name: "oversize file",
      check: "file-size",
      arrange: () => plant(JSON.stringify({ ...GOOD, pad: "x".repeat(5000) })),
    },
    { name: "invalid JSON", check: "file-json", arrange: () => plant("{not json") },
    { name: "unknown key", check: "file-schema", arrange: () => plant({ ...GOOD, extra: 1 }) },
    { name: "bad appId", check: "file-schema", arrange: () => plant({ ...GOOD, appId: "x" }) },
    {
      name: "missing installSecret",
      check: "file-schema",
      arrange: () => plant({ ...GOOD, installSecret: undefined }),
    },
    { name: "bad gen", check: "file-schema", arrange: () => plant({ ...GOOD, gen: 0 }) },
    { name: "array root", check: "file-schema", arrange: () => plant("[]") },
  ];
  for (const c of cases) {
    it(`${c.name} ⇒ ${c.check}`, async () => {
      const p = c.arrange();
      const before = lstatSync(p, { bigint: true });
      const { s } = store();
      const res = await s.load();
      expect(res).toEqual({ kind: "unsafe", check: c.check });
      expect(s.status()).toBe("unsafe");
      expect(s.current()).toBeUndefined();
      expect(s.tokenCredentials()).toBeUndefined();
      expect(s.secrets()).toEqual([]);
      expect(s.unsafeCheck()).toBe(c.check);
      // never auto-overwritten: commit refused, the path is exactly as it was
      expect(await s.commit(INPUT)).toEqual({ ok: false, reason: "unsafe" });
      const after = lstatSync(p, { bigint: true });
      expect([after.ino, after.mode, after.size]).toEqual([before.ino, before.mode, before.size]);
      expect(existsSync(`${p}.tmp`)).toBe(false);
    });
  }

  it("foreign owner (file) ⇒ file-owner; foreign owner (dir) ⇒ directory-owner", async () => {
    plant(GOOD);
    const realUid = process.getuid!();
    const foreign = wrapFs({ getuid: () => realUid + 1 });
    const a = createCredentialStore({ dir, fs: foreign });
    expect(await a.load()).toEqual({ kind: "unsafe", check: "directory-owner" });
    // directory fine, file owner differs: simulate by lying only for the file stat
    const lie = wrapFs({
      lstat: async (p) => {
        const st = await realFeishuFs.lstat(p);
        if (p.endsWith(FEISHU_CREDENTIALS_FILE)) {
          return {
            isFile: () => st.isFile(),
            isDirectory: () => st.isDirectory(),
            isSymbolicLink: () => st.isSymbolicLink(),
            uid: st.uid + 1,
            mode: st.mode,
            size: st.size,
            dev: st.dev,
            ino: st.ino,
          };
        }
        return st;
      },
    });
    const b = createCredentialStore({ dir, fs: lie });
    expect(await b.load()).toEqual({ kind: "unsafe", check: "file-owner" });
  });

  it("a symlinked directory is unsafe", async () => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, FEISHU_CREDENTIALS_FILE), JSON.stringify(GOOD), { mode: 0o600 });
    symlinkSync(real, dir);
    const { s } = store();
    expect(await s.load()).toEqual({ kind: "unsafe", check: "directory-symlink" });
    expect(await s.commit(INPUT)).toEqual({ ok: false, reason: "unsafe" });
  });

  it("a loose directory owned by us is tightened to 0700 (credentials still load)", async () => {
    plant(GOOD);
    chmodSync(dir, 0o755);
    const { s } = store();
    expect((await s.load()).kind).toBe("loaded");
    expect(mode(dir)).toBe(0o700);
  });

  it("remove() (reset) clears an unsafe symlink WITHOUT touching its target, then setup works again", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(root, "victim.json");
    writeFileSync(target, "precious", { mode: 0o600 });
    symlinkSync(target, join(dir, FEISHU_CREDENTIALS_FILE));
    const { s } = store();
    expect((await s.load()).kind).toBe("unsafe");
    expect(await s.remove()).toEqual({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(s.status()).toBe("absent");
    expect((await s.commit(INPUT)).ok).toBe(true);
    expect(lstatSync(s.path).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("precious");
  });

  it("remove() is idempotent when nothing exists", async () => {
    const { s } = store();
    expect(await s.remove()).toEqual({ ok: true });
    expect(s.status()).toBe("absent");
  });
});

describe("atomic replace", () => {
  it("a failing guard writes nothing (also when it flips between write and rename)", async () => {
    const { s } = store();
    expect(await s.commit(INPUT, { guard: () => false })).toEqual({ ok: false, reason: "guard" });
    expect(existsSync(s.path)).toBe(false);
    let calls = 0;
    expect(await s.commit(INPUT, { guard: () => ++calls < 2 })).toEqual({ ok: false, reason: "guard" });
    expect(calls).toBe(2);
    expect(existsSync(s.path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // tmp removed
    expect(s.status()).not.toBe("loaded");
  });

  it("guard failing on a REPLACE leaves the old credentials on disk and in memory", async () => {
    const { s } = store();
    const old = await s.commit(INPUT);
    if (!old.ok) throw new Error("commit failed");
    let calls = 0;
    const r = await s.commit({ ...INPUT, appId: "cli_other0000000" }, { guard: () => ++calls < 2 });
    expect(r).toEqual({ ok: false, reason: "guard" });
    expect(s.current()).toEqual(old.credentials);
    expect(JSON.parse(readFileSync(s.path, "utf8")).appId).toBe(INPUT.appId);
  });

  for (const stage of ["openWriteExcl", "writeFile", "sync", "rename"] as const) {
    it(`I/O failure at ${stage} ⇒ write-failed, previous credentials intact, no tmp left`, async () => {
      const { s: good } = store();
      const old = await good.commit(INPUT);
      if (!old.ok) throw new Error("commit failed");
      let armed = true;
      const failing = wrapFs({
        openWriteExcl: async (p, m) => {
          if (armed && stage === "openWriteExcl") throw new Error("boom");
          const h = await realFeishuFs.openWriteExcl(p, m);
          return {
            writeFile: async (d) => {
              if (armed && stage === "writeFile") throw new Error("boom");
              return h.writeFile(d);
            },
            sync: async () => {
              if (armed && stage === "sync") throw new Error("boom");
              return h.sync();
            },
            close: () => h.close(),
          };
        },
        rename: async (a, b) => {
          if (armed && stage === "rename") throw new Error("boom");
          return realFeishuFs.rename(a, b);
        },
      });
      const s = createCredentialStore({ dir, fs: failing });
      expect((await s.load()).kind).toBe("loaded");
      const r = await s.commit({ ...INPUT, appId: "cli_other0000000" });
      expect(r).toEqual({ ok: false, reason: "write-failed" });
      expect(s.current()).toEqual(old.credentials);
      expect(JSON.parse(readFileSync(s.path, "utf8")).appId).toBe(INPUT.appId);
      expect(readdirSync(dir)).toEqual([FEISHU_CREDENTIALS_FILE]);
      armed = false;
      expect((await s.commit({ ...INPUT, appId: "cli_other0000000" })).ok).toBe(true);
    });
  }

  it("a stale / symlinked tmp file never redirects the write", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "keep", { mode: 0o600 });
    symlinkSync(victim, join(dir, `${FEISHU_CREDENTIALS_FILE}.tmp`));
    const { s } = store();
    expect((await s.commit(INPUT)).ok).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(readdirSync(dir)).toEqual([FEISHU_CREDENTIALS_FILE]);
    expect(mode(s.path)).toBe(0o600);
  });

  it("commits are serialized (concurrent commits all land in order, last gen wins on disk)", async () => {
    const { s } = store();
    const results = await Promise.all([1, 2, 3, 4].map((n) => s.commit({ ...INPUT, appId: `cli_app${n}` })));
    const gens = results.map((r) => (r.ok ? r.credentials.gen : -1));
    expect(gens).toEqual([...gens].sort((a, b) => a - b));
    expect(JSON.parse(readFileSync(s.path, "utf8")).appId).toBe("cli_app4");
    expect(s.current()?.appId).toBe("cli_app4");
  });
});

describe("private-file primitives", () => {
  it("readPrivateFile: absent / ok / identity", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, "x.bin");
    expect(await readPrivateFile(realFeishuFs, p, 100)).toEqual({ kind: "absent" });
    writeFileSync(p, "hello", { mode: 0o600 });
    const r = await readPrivateFile(realFeishuFs, p, 100);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(Buffer.from(r.bytes).toString()).toBe("hello");
    expect(await readPrivateFile(realFeishuFs, p, 4)).toEqual({ kind: "unsafe", check: "file-size" });
  });

  it("readPrivateFile detects a swap between lstat and open (dev/ino identity)", async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, "x.bin");
    writeFileSync(p, "one", { mode: 0o600 });
    const swapping = wrapFs({
      openRead: async (path) => {
        writeFileSync(`${path}.new`, "two", { mode: 0o600 }); // created while the old inode still exists ⇒ distinct ino
        renameSync(`${path}.new`, path);
        return realFeishuFs.openRead(path);
      },
    });
    expect(await readPrivateFile(swapping, p, 100)).toEqual({ kind: "unsafe", check: "file-identity-changed" });
  });

  it("ensurePrivateDir refuses a file, a symlink, and reports I/O errors", async () => {
    const f = join(root, "afile");
    writeFileSync(f, "x");
    expect(await ensurePrivateDir(realFeishuFs, f)).toEqual({ ok: false, check: "directory-io" });
    const link = join(root, "alink");
    mkdirSync(join(root, "tgt"));
    symlinkSync(join(root, "tgt"), link);
    expect(await ensurePrivateDir(realFeishuFs, link)).toEqual({ ok: false, check: "directory-symlink" });
    expect(await ensurePrivateDir(realFeishuFs, join(root, "fresh", "nested"))).toEqual({ ok: true });
    expect(mode(join(root, "fresh", "nested"))).toBe(0o700);
  });

  it("writeFileAtomicPrivate creates 0600 even under a permissive umask", async () => {
    const old = process.umask(0);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const p = join(dir, "y.json");
      expect(await writeFileAtomicPrivate(realFeishuFs, p, new TextEncoder().encode("{}"))).toBe("written");
      expect(mode(p)).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });
});

describe("parseCredentials / request token", () => {
  it("parseCredentials is strict", () => {
    expect(parseCredentials(GOOD)).toEqual(GOOD);
    expect(parseCredentials({ ...GOOD, botOpenId: "ou_bot" })).toMatchObject({ botOpenId: "ou_bot" });
    for (const bad of [
      null,
      1,
      [],
      { ...GOOD, v: 2 },
      { ...GOOD, brand: "x" },
      { ...GOOD, createdAt: "" },
      { ...GOOD, gen: 1.5 },
    ]) {
      expect(parseCredentials(bad)).toBeUndefined();
    }
  });

  it("computeRequestToken = b64url(HMAC-SHA256(installSecret, cmdId))[0:12] and depends on the secret", () => {
    const secret = "B".repeat(43);
    const cmd = `fs${"a".repeat(30)}`;
    const expected = createHmac("sha256", secret).update(cmd).digest("base64url").slice(0, 12);
    expect(computeRequestToken(secret, cmd)).toBe(expected);
    expect(computeRequestToken(secret, cmd)).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(computeRequestToken("C".repeat(43), cmd)).not.toBe(expected);
    expect(computeRequestToken(secret, `fs${"b".repeat(30)}`)).not.toBe(expected);
  });

  it("an installSecret minted by the store feeds the token (rotation on replace changes tokens)", async () => {
    const { s } = store();
    const a = await s.commit(INPUT);
    const b = await s.commit(INPUT);
    if (!a.ok || !b.ok) throw new Error("commit failed");
    const cmd = `fs${"z".repeat(30)}`;
    expect(computeRequestToken(a.credentials.installSecret, cmd)).not.toBe(
      computeRequestToken(b.credentials.installSecret, cmd),
    );
  });
});
