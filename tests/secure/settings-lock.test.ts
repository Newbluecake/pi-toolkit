// data-encryption P1 review #5 / P2: the plugin side of the settings-file lock protocol.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettingsFromFile, persistSettingOverride } from "../../src/config/settings.js";
import { settingsLockPath, withSettingsFileLock } from "../../src/secure/settings-lock.js";

let tmp: string;
let settingsPath: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-lock-")));
  mkdirSync(join(tmp, ".pi", "agent"), { recursive: true });
  settingsPath = join(tmp, ".pi", "agent", "pi-subagent.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Another process's non-blocking attempt on the same lock file: 0 = got it, 1 = held elsewhere. */
function otherProcessTryLock(lockFile: string): number | null {
  return spawnSync("flock", ["-x", "-n", lockFile, "true"], { stdio: "ignore" }).status;
}

describe("withSettingsFileLock", () => {
  it("default lock path is ~/.pi/agent/.pi-subagent.json.lock (same as the launcher)", () => {
    expect(settingsLockPath(settingsPath)).toBe(join(tmp, ".pi", "agent", ".pi-subagent.json.lock"));
  });

  it("flock(2) lives on the open file description: held by the parent after the flock child exited, released on close", () => {
    const lockFile = settingsLockPath(settingsPath);
    const seen: Array<number | null> = [];
    const r = withSettingsFileLock(settingsPath, () => {
      seen.push(otherProcessTryLock(lockFile));
      return 42;
    });
    expect(r).toEqual({ ok: true, value: 42, locked: true });
    expect(seen).toEqual([1]); // the `flock … 3` child had already exited, yet another process could not lock
    expect(otherProcessTryLock(lockFile)).toBe(0); // fd closed ⇒ released
    expect(statSync(lockFile).mode & 0o777).toBe(0o600);
  });

  it("gives up after the wait budget while another process holds the lock (fn never runs)", async () => {
    const lockFile = settingsLockPath(settingsPath);
    writeFileSync(lockFile, "", { mode: 0o600 });
    const holder = spawn("flock", ["-x", lockFile, "sleep", "5"], { stdio: "ignore" });
    try {
      await vi.waitFor(() => expect(otherProcessTryLock(lockFile)).toBe(1));
      const fn = vi.fn(() => 1);
      const t0 = Date.now();
      const r = withSettingsFileLock(settingsPath, fn, { waitS: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("超时");
      expect(fn).not.toHaveBeenCalled();
      expect(Date.now() - t0).toBeLessThan(4_000);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("a symlinked lock file fails closed", () => {
    symlinkSync(join(tmp, "elsewhere"), settingsLockPath(settingsPath));
    const fn = vi.fn();
    const r = withSettingsFileLock(settingsPath, fn);
    expect(r.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("no flock binary ⇒ the documented exception: runs unlocked", () => {
    const r = withSettingsFileLock(settingsPath, () => "x", { flockBin: join(tmp, "no-such-flock") });
    expect(r).toEqual({ ok: true, value: "x", locked: false });
  });

  it("a throwing fn is reported, the lock is still released", () => {
    const r = withSettingsFileLock(settingsPath, () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, error: "boom" });
    expect(otherProcessTryLock(settingsLockPath(settingsPath))).toBe(0);
  });
});

describe("persistSettingOverride under the lock", () => {
  it("refuses to write (and says why) while the lock is held elsewhere", async () => {
    writeFileSync(settingsPath, JSON.stringify({ keep: 1 }));
    const lockFile = settingsLockPath(settingsPath);
    writeFileSync(lockFile, "", { mode: 0o600 });
    const holder = spawn("flock", ["-x", lockFile, "sleep", "15"], { stdio: "ignore" });
    try {
      await vi.waitFor(() => expect(otherProcessTryLock(lockFile)).toBe(1));
      const err = persistSettingOverride("worktree.enabled", true, settingsPath);
      expect(err).toContain("超时");
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ keep: 1 });
    } finally {
      holder.kill("SIGKILL");
    }
  }, 20_000);

  it("writes atomically, keeps a symlinked settings file a symlink, preserves other keys", () => {
    const real = join(tmp, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify({ secure: { vaults: { acme: {} } } }), { mode: 0o640 });
    symlinkSync(real, settingsPath);
    expect(persistSettingOverride("worktree.enabled", true, settingsPath)).toBeUndefined();
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({
      secure: { vaults: { acme: {} } },
      worktree: { enabled: true },
    });
    expect(spawnSync("test", ["-L", settingsPath]).status).toBe(0);
    expect(statSync(real).mode & 0o777).toBe(0o640);
  });

  it("a new settings file is created 0600", () => {
    expect(persistSettingOverride("worktree.enabled", true, settingsPath)).toBeUndefined();
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it("concurrent writers lose no update: plugin persistSettingOverride ∥ launcher registerVault", async () => {
    writeFileSync(settingsPath, "{}\n");
    const helper = join(process.cwd(), "src", "secure", "bin", "helper.mjs");
    const env = { ...process.env, HOME: tmp };
    delete env.PI_SECURE_SETTINGS_FILE;
    const N = 8;
    const children = Array.from(
      { length: N },
      (_, i) =>
        new Promise<number | null>((resolve) => {
          const c = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const h = await import(${JSON.stringify(helper)}); h.registerVault("v${i}", "/vaults/v${i}", "/links/v${i}", ${JSON.stringify(tmp)});`,
            ],
            { env, stdio: ["ignore", "ignore", "pipe"] },
          );
          c.on("exit", (code) => resolve(code));
        }),
    );
    const errors: Array<string | undefined> = [];
    for (let i = 0; i < 20; i++) errors.push(persistSettingOverride(`concurrency.k${i}`, i, settingsPath));
    const codes = await Promise.all(children);
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(errors.every((e) => e === undefined)).toBe(true);
    const final = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      concurrency: Record<string, number>;
      secure: { vaults: Record<string, unknown> };
    };
    expect(Object.keys(final.concurrency).length).toBe(20);
    expect(Object.keys(final.secure.vaults).sort()).toEqual(Array.from({ length: N }, (_, i) => `v${i}`).sort());
  }, 60_000);
});

describe("loadSettingsFromFile migration write-back", () => {
  it("a lock failure only skips the write-back (warn) and still returns the migrated settings", async () => {
    writeFileSync(settingsPath, JSON.stringify({ budget: { idleMs: 120_000 } }));
    const lockFile = settingsLockPath(settingsPath);
    writeFileSync(lockFile, "", { mode: 0o600 });
    const holder = spawn("flock", ["-x", lockFile, "sleep", "20"], { stdio: "ignore" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await vi.waitFor(() => expect(otherProcessTryLock(lockFile)).toBe(1));
      const s = loadSettingsFromFile(settingsPath);
      expect(s.budget.idleMs).toBe(120_000);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ budget: { idleMs: 120_000 } }); // untouched
      expect(warn.mock.calls.some((c) => String(c[0]).includes("retried next time"))).toBe(true);
    } finally {
      warn.mockRestore();
      holder.kill("SIGKILL");
    }
  }, 30_000);

  it("with the lock free the migration is written back", () => {
    writeFileSync(settingsPath, JSON.stringify({ budget: { idleMs: 120_000 } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      loadSettingsFromFile(settingsPath);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ budget: { idleS: 120 } });
    } finally {
      warn.mockRestore();
    }
  });
});
