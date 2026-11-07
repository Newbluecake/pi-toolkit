// settings-rename P1 (plan §3.4, T-MG1…T-MG5): link-publish + compat-symlink migration, its crash
// windows, skips, multi-process races and lock interop with the launcher. Sandboxed tmp dirs only; the
// settings content is never printed — assertions use lstat/readlink/inode checks.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_SETTINGS_FILE_NAME as OLD,
  SETTINGS_FILE_NAME as NEW,
  healSettingsFileLocked,
  migrateLegacySettingsFile,
  resolveSettingsFile,
  settingsLockPath,
  withSettingsFileLock,
} from "../../src/secure/settings-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);
const SECURE_TS = pathToFileURL(join(REPO, "src", "secure", "settings-lock.ts")).href;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-mig-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const P = (n: string) => join(dir, n);
const ino = (n: string) => lstatSync(P(n)).ino;
const lnks = () => readdirSync(dir).filter((n) => n.endsWith(".lnk"));
const body = { budget: { idleS: 120 }, webHub: { enabled: false } };
function seedLegacy(content: unknown = body, mode = 0o600): void {
  writeFileSync(P(OLD), JSON.stringify(content), { mode });
}
function expectS5(origIno: number): void {
  expect(lstatSync(P(NEW)).isFile()).toBe(true);
  expect(lstatSync(P(NEW)).ino).toBe(origIno);
  expect(lstatSync(P(OLD)).isSymbolicLink()).toBe(true);
  expect(readlinkSync(P(OLD))).toBe(NEW);
  expect(readFileSync(P(OLD), "utf8")).toBe(readFileSync(P(NEW), "utf8"));
  expect(lnks()).toEqual([]);
  expect(resolveSettingsFile(dir)).toMatchObject({ kind: "new", legacy: "compat-link" });
}
const eperm = () => Object.assign(new Error("not permitted"), { code: "EPERM" });

describe("T-MG1 migration happy path", () => {
  it("NEW is the original inode (mode kept); LEGACY becomes a relative compat link; second call is a noop", () => {
    seedLegacy(body, 0o640);
    const before = lstatSync(P(OLD));
    const r = migrateLegacySettingsFile(dir);
    expect(r).toEqual({ kind: "migrated", from: P(OLD), to: P(NEW), healed: false });
    expectS5(before.ino);
    expect(lstatSync(P(NEW)).mode & 0o777).toBe(0o640);
    expect(lstatSync(P(NEW)).nlink).toBe(1); // the hard link is gone: the legacy NAME is now a symlink
    expect(migrateLegacySettingsFile(dir)).toEqual({ kind: "noop" });
    expect(migrateLegacySettingsFile(join(dir, "does-not-exist"))).toEqual({ kind: "noop" });
  });

  it("states that must never migrate: S0, S2 (external symlink), S4, S5", () => {
    expect(migrateLegacySettingsFile(dir)).toEqual({ kind: "noop" });
    writeFileSync(P("ext.json"), "{}");
    symlinkSync(P("ext.json"), P(OLD));
    expect(migrateLegacySettingsFile(dir)).toEqual({ kind: "noop" });
    expect(readlinkSync(P(OLD))).toBe(P("ext.json"));
    expect(existsSync(P(NEW))).toBe(false);
  });
});

describe("T-MG2 crash windows", () => {
  it("afterLink throws (= killed between c and e) ⇒ S6a; same-inode is NOT a conflict; next call heals", () => {
    seedLegacy();
    const o = ino(OLD);
    const r = migrateLegacySettingsFile(dir, {
      afterLink: () => {
        throw new Error("simulated crash");
      },
    });
    expect(r).toMatchObject({ kind: "skipped", reason: "io" });
    expect(resolveSettingsFile(dir)).toMatchObject({ kind: "new", legacy: "same-inode" });
    expect(ino(NEW)).toBe(o);
    expect(migrateLegacySettingsFile(dir)).toEqual({ kind: "migrated", from: P(OLD), to: P(NEW), healed: true });
    expectS5(o);
  });

  it("a leftover .lnk (killed between e and g) is cleaned and the state still heals", () => {
    seedLegacy();
    const o = ino(OLD);
    linkSync(P(OLD), P(NEW));
    symlinkSync(NEW, P("pi-subagent.json.0123456789abcdef.lnk"));
    symlinkSync(NEW, P("pi-subagent.json.zzzz.lnk")); // not ours (no 16-hex suffix): left alone
    expect(migrateLegacySettingsFile(dir)).toMatchObject({ kind: "migrated", healed: true });
    expect(readdirSync(dir).filter((n) => n.endsWith(".lnk"))).toEqual(["pi-subagent.json.zzzz.lnk"]);
    rmSync(P("pi-subagent.json.zzzz.lnk"));
    expectS5(o);
  });

  it.skipIf(!existsSync(TSX))(
    "real SIGKILL between the hard link and the symlink swap ⇒ S6a ⇒ healed by the next run",
    () => {
      seedLegacy();
      const o = ino(OLD);
      const script = join(dir, "crash.mts");
      writeFileSync(
        script,
        `import { migrateLegacySettingsFile } from ${JSON.stringify(SECURE_TS)};
       migrateLegacySettingsFile(${JSON.stringify(dir)}, { afterLink: () => process.kill(process.pid, "SIGKILL") });`,
      );
      const r = spawnSync(TSX, [script], { stdio: "ignore" });
      expect(r.signal ?? "SIGKILL").toBe("SIGKILL");
      expect(resolveSettingsFile(dir)).toMatchObject({ kind: "new", legacy: "same-inode" });
      expect(migrateLegacySettingsFile(dir)).toMatchObject({ kind: "migrated", healed: true });
      expectS5(o);
    },
    30_000,
  );
});

describe("T-MG3 skips and conflicts", () => {
  it("no flock binary ⇒ skipped(no-flock) and the settings files are untouched", () => {
    seedLegacy();
    const before = lstatSync(P(OLD));
    const r = migrateLegacySettingsFile(dir, { flockBin: "/nonexistent/flock-bin" });
    expect(r).toMatchObject({ kind: "skipped", reason: "no-flock" });
    expect(existsSync(P(NEW))).toBe(false);
    expect(lnks()).toEqual([]);
    const after = lstatSync(P(OLD));
    expect([after.ino, after.mtimeMs, after.isFile()]).toEqual([before.ino, before.mtimeMs, true]);
  });

  it("lock held by another process ⇒ skipped(lock)", async () => {
    seedLegacy();
    const lockFile = settingsLockPath(P(OLD));
    writeFileSync(lockFile, "", { mode: 0o600 });
    const holder = spawn("flock", ["-x", lockFile, "sleep", "5"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 400));
      const r = migrateLegacySettingsFile(dir, { waitS: 1 });
      expect(r).toMatchObject({ kind: "skipped", reason: "lock" });
      expect(existsSync(P(NEW))).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  }, 20_000);

  it("a not-ours file ⇒ skipped(foreign-owner)", () => {
    seedLegacy();
    const r = migrateLegacySettingsFile(dir, {
      lstat: (p) => {
        const st = lstatSync(p);
        return Object.assign(Object.create(st) as typeof st, { uid: st.uid + 1 });
      },
    });
    expect(r).toMatchObject({ kind: "skipped", reason: "foreign-owner" });
    expect(existsSync(P(NEW))).toBe(false);
  });

  it("an unfinished secure transaction (pending / relocate) ⇒ skipped(secure-txn)", () => {
    for (const key of ["pending", "relocate"]) {
      seedLegacy({ secure: { vaults: { a: { dir: "/d", mnt: "/m", [key]: key === "pending" ? "convert:t1" : {} } } } });
      expect(migrateLegacySettingsFile(dir)).toMatchObject({ kind: "skipped", reason: "secure-txn" });
      expect(existsSync(P(NEW))).toBe(false);
    }
    seedLegacy({ secure: { vaults: { a: { dir: "/d", mnt: "/m" } } } }); // a clean registry migrates
    expect(migrateLegacySettingsFile(dir)).toMatchObject({ kind: "migrated" });
  });

  it("an unparsable file is not blocked by the txn probe (migrates)", () => {
    writeFileSync(P(OLD), "{broken");
    expect(migrateLegacySettingsFile(dir)).toMatchObject({ kind: "migrated" });
  });

  it("hard links unsupported (EPERM) ⇒ silently stays S1", () => {
    seedLegacy();
    const r = migrateLegacySettingsFile(dir, {
      link: () => {
        throw eperm();
      },
    });
    expect(r).toMatchObject({ kind: "skipped", reason: "link-unsupported" });
    expect(resolveSettingsFile(dir)).toMatchObject({ kind: "legacy", legacyType: "file" });
  });

  it("symlinks unsupported (EPERM) ⇒ NEW is removed again, back to S1", () => {
    seedLegacy();
    const o = ino(OLD);
    const r = migrateLegacySettingsFile(dir, {
      symlink: () => {
        throw eperm();
      },
    });
    expect(r).toMatchObject({ kind: "skipped", reason: "symlink-unsupported" });
    expect(existsSync(P(NEW))).toBe(false);
    expect(ino(OLD)).toBe(o);
    expect(lstatSync(P(OLD)).isFile()).toBe(true);
    expect(lnks()).toEqual([]);
  });

  it("LEGACY atomically replaced between the link and the swap ⇒ conflict, .lnk removed, nothing overwritten", () => {
    seedLegacy();
    const r = migrateLegacySettingsFile(dir, {
      afterLink: () => {
        writeFileSync(P("racer.tmp"), JSON.stringify({ other: 1 }));
        renameSync(P("racer.tmp"), P(OLD));
      },
    });
    expect(r).toMatchObject({ kind: "conflict", newPath: P(NEW), legacyPath: P(OLD) });
    expect(lnks()).toEqual([]);
    expect(lstatSync(P(OLD)).isFile()).toBe(true); // the racer's file was NOT replaced by our link
    expect(JSON.parse(readFileSync(P(OLD), "utf8"))).toEqual({ other: 1 });
    expect(resolveSettingsFile(dir)).toMatchObject({ kind: "new", legacy: "conflict" });
  });

  it("NEW created by an unlocked writer right before the link (EEXIST) ⇒ conflict; NEW is never overwritten", () => {
    seedLegacy();
    const r = migrateLegacySettingsFile(dir, {
      link: () => {
        writeFileSync(P(NEW), JSON.stringify({ racer: true }));
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
    });
    expect(r).toMatchObject({ kind: "conflict" });
    expect(JSON.parse(readFileSync(P(NEW), "utf8"))).toEqual({ racer: true });
  });

  it("S6b on entry is reported as a conflict (with the mtime hint) and left alone", () => {
    seedLegacy();
    writeFileSync(P(NEW), "{}");
    const r = migrateLegacySettingsFile(dir);
    expect(r).toMatchObject({ kind: "conflict", newPath: P(NEW), legacyPath: P(OLD) });
    expect(lstatSync(P(OLD)).isFile()).toBe(true);
  });
});

describe("healSettingsFileLocked (§3.4.1)", () => {
  it("S6a ⇒ healed (S5); every other state is a noop; symlink EPERM ⇒ reverted-to-legacy", () => {
    expect(healSettingsFileLocked(dir)).toBe("noop"); // S0
    seedLegacy();
    expect(healSettingsFileLocked(dir)).toBe("noop"); // S1: heal never initiates the migration
    expect(existsSync(P(NEW))).toBe(false);
    const o = ino(OLD);
    linkSync(P(OLD), P(NEW));
    expect(
      healSettingsFileLocked(dir, {
        symlink: () => {
          throw eperm();
        },
      }),
    ).toBe("reverted-to-legacy");
    expect(existsSync(P(NEW))).toBe(false);
    linkSync(P(OLD), P(NEW));
    expect(healSettingsFileLocked(dir)).toBe("healed");
    expectS5(o);
    expect(healSettingsFileLocked(dir)).toBe("noop"); // S5
    rmSync(P(OLD));
    writeFileSync(P(OLD), "{}");
    expect(healSettingsFileLocked(dir)).toBe("noop"); // S6b stays untouched
    expect(lstatSync(P(OLD)).isFile()).toBe(true);
  });
});

function runChild(code: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(TSX, ["--input-type=module", "-e", code], { env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.on("exit", (code) => resolve({ code, out }));
  });
}

describe("T-MG4 multi-process", () => {
  it.skipIf(!existsSync(TSX))(
    "6 concurrent migrators ⇒ exactly one migrates, the rest noop; concurrent readers always see a complete file",
    async () => {
      seedLegacy();
      const o = ino(OLD);
      const expected = readFileSync(P(OLD), "utf8");
      const stop = P("stop-readers");
      const readerCode = `import { readFileSync, existsSync } from "node:fs";
        let bad = 0, n = 0;
        while (!existsSync(${JSON.stringify(stop)})) {
          n++;
          try { if (readFileSync(${JSON.stringify(P(OLD))}, "utf8") !== ${JSON.stringify(expected)}) bad++; } catch { bad++; }
          if (existsSync(${JSON.stringify(P(NEW))})) {
            try { if (readFileSync(${JSON.stringify(P(NEW))}, "utf8") !== ${JSON.stringify(expected)}) bad++; } catch { bad++; }
          }
        }
        console.log(JSON.stringify({ bad, n }));`;
      const readers = Array.from({ length: 4 }, () => runChild(readerCode));
      await new Promise((r) => setTimeout(r, 300));
      const migCode = `import { migrateLegacySettingsFile } from ${JSON.stringify(SECURE_TS)};
        console.log(JSON.stringify(migrateLegacySettingsFile(${JSON.stringify(dir)})));`;
      const migs = await Promise.all(Array.from({ length: 6 }, () => runChild(migCode)));
      writeFileSync(stop, "");
      const reads = await Promise.all(readers);
      const outcomes = migs.map((m) => (JSON.parse(m.out) as { kind: string }).kind);
      expect(outcomes.filter((k) => k === "migrated")).toHaveLength(1);
      expect(outcomes.filter((k) => k === "noop")).toHaveLength(5);
      expectS5(o);
      for (const r of reads) {
        const { bad, n } = JSON.parse(r.out) as { bad: number; n: number };
        expect(bad).toBe(0);
        expect(n).toBeGreaterThan(0);
      }
    },
    90_000,
  );
});

describe("T-MG5 lock interop with the launcher", () => {
  it("fixed lock name; the launcher waits out a held lock, then writes NEW (new inode) and the compat link survives", async () => {
    const home = P("home");
    const agent = join(home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, OLD), JSON.stringify({ keep: 1 }), { mode: 0o600 });
    expect(migrateLegacySettingsFile(agent)).toMatchObject({ kind: "migrated" });
    const lockFile = join(agent, ".pi-subagent.json.lock");
    expect(settingsLockPath(join(agent, NEW))).toBe(lockFile);
    expect(H.settingsLockPath(home)).toBe(lockFile);
    expect(H.settingsFilePath(home)).toBe(join(agent, NEW));
    const holder = spawn("flock", ["-x", lockFile, "sleep", "3"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(() => H.registerVault("acme", { dir: "/d/a", mnt: "/m/a" }, { home, lockWaitS: 1 })).toThrow(/等待超时/);
      const t0 = Date.now();
      H.registerVault("acme", { dir: "/d/a", mnt: "/m/a" }, { home }); // waits for the holder's remaining ~1.5 s
      expect(Date.now() - t0).toBeGreaterThan(500);
    } finally {
      holder.kill("SIGKILL");
    }
    expect(lstatSync(join(agent, NEW)).isFile()).toBe(true);
    expect(readlinkSync(join(agent, OLD))).toBe(NEW);
    const written = JSON.parse(readFileSync(join(agent, OLD), "utf8")) as Record<string, unknown>;
    expect(written.keep).toBe(1);
    expect(Object.keys((written.secure as { vaults: object }).vaults)).toEqual(["acme"]);
  }, 30_000);
});

describe("lock timeout contract is unchanged for ordinary writers", () => {
  it("withSettingsFileLock without requireLock still runs fn when flock is missing (macOS exception)", () => {
    const r = withSettingsFileLock(P(NEW), () => 7, { flockBin: "/nonexistent/flock-bin" });
    expect(r).toEqual({ ok: true, value: 7, locked: false });
    const strict = withSettingsFileLock(P(NEW), () => 7, { flockBin: "/nonexistent/flock-bin", requireLock: true });
    expect(strict).toMatchObject({ ok: false, reason: "no-flock" });
  });
});
