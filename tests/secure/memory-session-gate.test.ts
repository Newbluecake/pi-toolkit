/**
 * #39 P1 secureSessionWriteGate — fake mountinfo + own tmp dirs, NO real mount (A10 tier1).
 * The 17 real-mount suites are unchanged; this file only feeds synthetic mountinfo strings
 * and temp directories to the pure gate.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secureSessionWriteGate } from "../../src/secure/memory-gate.js";
import type { SecureDomain } from "../../src/secure/domain.js";

const GOCRYPTFS_FSTYPE = "fuse.gocryptfs"; // whole-word fstype: the D4 mount marker never matches this spelling

let root = "";
let mnt = "";
let cipher = "";

function mountinfoWith(mountPoint: string, fstype = GOCRYPTFS_FSTYPE, source = cipher): string {
  return `36 35 0:49 / ${mountPoint} rw,relatime shared:1 - ${fstype} ${source} rw,relatime`;
}

const secureDomain = (): SecureDomain =>
  ({
    kind: "secure",
    vault: { root, mntReal: mnt, vault: { name: "t" } },
    vaults: [],
    config: {},
    via: "env",
  }) as unknown as SecureDomain;

beforeEach(() => {
  // realpath mirrors production vaultRoots() (realpathOr): the vault identity is PHYSICAL.
  root = realpathSync(mkdtempSync(join(tmpdir(), "p1-session-gate-")));
  mnt = join(root, "mnt");
  cipher = join(root, "cipher");
  mkdirSync(join(mnt, "state", "sessions", "default"), { recursive: true });
  mkdirSync(join(mnt, "work"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("secureSessionWriteGate", () => {
  it("plain is always ok; locked always refuses", () => {
    const plain = secureSessionWriteGate({ kind: "plain", vaults: [], config: {} } as unknown as SecureDomain);
    expect(plain.check({ sessionFile: "/anywhere/s.json" })).toEqual({ ok: true });
    const locked = secureSessionWriteGate({
      kind: "locked",
      reason: "x",
      vaults: [],
      config: {},
    } as unknown as SecureDomain);
    expect(locked.check({ sessionFile: join(mnt, "state", "s.json") })).toEqual({ ok: false, reason: "locked" });
  });

  it("secure + mounted + session file inside state/ or work/ ⇒ ok", () => {
    const gate = secureSessionWriteGate(secureDomain(), { readMountinfo: () => mountinfoWith(mnt) });
    expect(gate.check({ sessionFile: join(mnt, "state", "sessions", "default", "s.json") })).toEqual({ ok: true });
    expect(gate.check({ sessionFile: join(mnt, "work", "sub", "note.md") })).toEqual({ ok: true });
    expect(gate.check({ sessionDir: join(mnt, "state", "tmp") })).toEqual({ ok: true });
  });

  it("unmounted (mount gone mid-session) ⇒ refused; remount flips it back", () => {
    const sessionFile = join(mnt, "state", "sessions", "s.json");
    let info = mountinfoWith(mnt);
    const gate = secureSessionWriteGate(secureDomain(), { readMountinfo: () => info });
    expect(gate.check({ sessionFile })).toEqual({ ok: true });
    info = ""; // live unmount: every check re-reads mountinfo
    expect(gate.check({ sessionFile })).toEqual({ ok: false, reason: "unmounted" });
    info = mountinfoWith(mnt);
    expect(gate.check({ sessionFile })).toEqual({ ok: true });
  });

  it("a foreign mount (wrong fs type or wrong cipher source) counts as unmounted", () => {
    const sessionFile = join(mnt, "state", "sessions", "s.json");
    const ext4 = secureSessionWriteGate(secureDomain(), {
      readMountinfo: () => mountinfoWith(mnt, "ext4", "/dev/sda1"),
    });
    expect(ext4.check({ sessionFile })).toEqual({ ok: false, reason: "unmounted" });
    const wrongCipher = secureSessionWriteGate(secureDomain(), {
      readMountinfo: () => mountinfoWith(mnt, GOCRYPTFS_FSTYPE, "/elsewhere/cipher"),
    });
    expect(wrongCipher.check({ sessionFile })).toEqual({ ok: false, reason: "unmounted" });
  });

  it("paths outside the write zone refuse: mount root, sentinels, outside the vault", () => {
    const gate = secureSessionWriteGate(secureDomain(), { readMountinfo: () => mountinfoWith(mnt) });
    expect(gate.check({ sessionFile: join(mnt, "s.json") })).toEqual({ ok: false, reason: "path-escaped" });
    expect(gate.check({ sessionDir: mnt })).toEqual({ ok: false, reason: "path-escaped" });
    expect(gate.check({ sessionDir: join(mnt, "state") })).toEqual({ ok: false, reason: "path-escaped" }); // sentinel itself
    expect(gate.check({ sessionFile: join(root, "plain-outside.json") })).toEqual({
      ok: false,
      reason: "path-escaped",
    });
    expect(gate.check({ sessionFile: "/tmp/elsewhere.json" })).toEqual({ ok: false, reason: "path-escaped" });
  });

  it("a symlinked session dir escaping the vault resolves and refuses", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "p1-outside-")));
    try {
      mkdirSync(join(outside, "sessions"), { recursive: true });
      // the gate canonicalizes the session DIRECTORY target: a symlink pointing out resolves out.
      symlinkSync(join(outside, "sessions"), join(mnt, "work", "esc"));
      const gate = secureSessionWriteGate(secureDomain(), { readMountinfo: () => mountinfoWith(mnt) });
      expect(gate.check({ sessionDir: join(mnt, "work", "esc", "default") })).toEqual({
        ok: false,
        reason: "path-escaped",
      });
      expect(gate.check({ sessionFile: join(mnt, "work", "esc", "default", "s.json") })).toEqual({
        ok: false,
        reason: "path-escaped",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("inMemory sessions (no sessionFile/sessionDir) check the mount only", () => {
    const gate = secureSessionWriteGate(secureDomain(), { readMountinfo: () => mountinfoWith(mnt) });
    expect(gate.check({})).toEqual({ ok: true });
    const unmounted = secureSessionWriteGate(secureDomain(), { readMountinfo: () => "" });
    expect(unmounted.check({})).toEqual({ ok: false, reason: "unmounted" });
  });

  it("a target that cannot be resolved fails closed", () => {
    const gate = secureSessionWriteGate(secureDomain(), {
      readMountinfo: () => {
        throw new Error("/proc gone");
      },
    });
    expect(gate.check({ sessionFile: join(mnt, "state", "sessions", "s.json") })).toEqual({
      ok: false,
      reason: "identity-changed",
    });
  });
});
