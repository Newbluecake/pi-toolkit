/**
 * V0 — helper minimal API for convert/export/import (convert-plan §8.1 V0, §1.4/§3.3/§3.4).
 *
 * Covers the port surface V4 (convert.mjs) and V5 (archive.mjs) will be injected with:
 *  - `registerVault(name, entry, {expectAbsent, pending})` — the unified name CLAIM (N2's call
 *    site was migrated 1:1; plain entries stay byte-identical, covered by the older suites)
 *  - `patchVaultEntry` / `removeVaultEntry` — the「仅本 txid」clear (commit point) and rollback,
 *    guarded by the CURRENT entry's pending / relocate.txid inside the settings lock
 *  - typed errors: settings-lock busy ⇒ CliError 73 (§6), config problems ⇒ 78
 *  - `V0_PORTS` (frozen bundle) + `CliError` export
 *
 * The `unlockVault(v, {postMount:false})` half needs a REAL mount: self-gated block at the
 * bottom (real gocryptfs in a private mktemp HOME, fake passfile password — never the user's
 * vaults), serialized against the other real-mount suites via gocryptfs-test-lock.
 *
 * No new commands are wired here (that is V6): __register/__vault-patch/__vault-remove are the
 * INTERNAL flock-child protocol of the functions above.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);

const FAKE_PW = "TESTPASS-fake-not-a-secret";
const which = (b: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const HAVE_FLOCK = process.platform === "linux" && which("flock") !== undefined;

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
function agentHome(): { home: string; file: string } {
  const home = tmp("ps-v0-");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  return { home, file: join(home, ".pi", "agent", "pi-subagent.json") };
}
afterAll(() => {
  for (const d of scratch) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** Hold the settings flock from a detached child; resolves once it prints "held" (lock taken). */
function holdSettingsLock(home: string): { lockFile: string; release(): void; held: Promise<void> } {
  const lockFile = join(home, ".pi", "agent", ".pi-subagent.json.lock");
  const holder = spawn("flock", [lockFile, "sh", "-c", "echo held; exec sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  let out = "";
  const held = new Promise<void>((resolveHeld) => {
    holder.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      if (out.includes("held")) resolveHeld();
    });
    holder.on("close", () => resolveHeld()); // gone already — the 73 assertions below would fail loudly
  });
  return {
    lockFile,
    held,
    release() {
      try {
        process.kill(-holder.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
    },
  };
}

describe.skipIf(!HAVE_FLOCK)("V0 registerVault — unified name claim", () => {
  it("claim with expectAbsent + pending writes {dir, mnt, pending} and nothing else", () => {
    const { home, file } = agentHome();
    writeFileSync(file, JSON.stringify({ hud: { enabled: true } }));
    H.registerVault("acme", { dir: "/d/acme", mnt: "/m/acme" }, { home, expectAbsent: true, pending: "convert:tx1" });
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.hud).toEqual({ enabled: true });
    expect(j.secure.vaults.acme).toEqual({ dir: "/d/acme", mnt: "/m/acme", pending: "convert:tx1" });
    expect(Object.keys(j.secure.vaults.acme)).toEqual(["dir", "mnt", "pending"]);
  });

  it("private + pending together", () => {
    const { home, file } = agentHome();
    H.registerVault(
      "gamma",
      { dir: "/d/gamma", mnt: "/m/gamma", private: true },
      { home, expectAbsent: true, pending: "import:zz9" },
    );
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.gamma).toEqual({
      dir: "/d/gamma",
      mnt: "/m/gamma",
      private: true,
      pending: "import:zz9",
    });
  });

  it("expectAbsent loses the race ⇒ CliError 78, settings bytes untouched", () => {
    const { home, file } = agentHome();
    H.registerVault("acme", { dir: "/d/acme", mnt: "/m/acme" }, { home, expectAbsent: true, pending: "convert:a" });
    const before = readFileSync(file, "utf8");
    let caught: any;
    try {
      H.registerVault("acme", { dir: "/other", mnt: "/other" }, { home, expectAbsent: true, pending: "convert:b" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(H.CliError);
    expect(caught.code).toBe(H.EXIT.CONFIG); // 78
    expect(String(caught.message)).toMatch(/已在 .* 登记（expectAbsent 认领失败）/);
    expect(readFileSync(file, "utf8")).toBe(before); // no partial write
  });

  it("expectAbsent also refuses a BROKEN existing entry (key presence decides, I-C5)", () => {
    const { home, file } = agentHome();
    writeFileSync(file, JSON.stringify({ secure: { vaults: { acme: "garbage" } } }));
    expect(() =>
      H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home, expectAbsent: true, pending: "convert:a" }),
    ).toThrow(/expectAbsent/);
  });

  it("without expectAbsent the legacy overwrite semantics are unchanged", () => {
    const { home, file } = agentHome();
    writeFileSync(file, JSON.stringify({ secure: { vaults: { acme: { dir: "/old", mnt: "/oldm" } } } }));
    H.registerVault("acme", { dir: "/new", mnt: "/newm" }, { home });
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.acme).toEqual({ dir: "/new", mnt: "/newm" });
  });

  it("validation fails before any lock/IO: bad pending / bad entry / bad name", () => {
    const { home, file } = agentHome();
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home, pending: "no-colon" })).toThrow(/pending/);
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home, pending: "convert:has space" })).toThrow(
      /pending/,
    );
    expect(() => H.registerVault("acme", { dir: "relative", mnt: "/m" }, { home })).toThrow(/dir/);
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/m", origin: "/x" }, { home })).toThrow(/origin/);
    expect(() => H.registerVault("Bad!", { dir: "/d", mnt: "/m" }, { home })).toThrow(/保险库名不合法/);
    expect(existsSync(file)).toBe(false); // nothing was created
  });

  it("settings lock busy ⇒ CliError 73 (typed, §6); released lock works again", async () => {
    const { home } = agentHome();
    const holder = holdSettingsLock(home);
    await holder.held; // the detached child now owns the flock
    try {
      let caught: any;
      try {
        H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home, lockWaitS: 0.3 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(H.CliError);
      expect(caught.code).toBe(H.EXIT.LOCK_BUSY); // 73
      expect(String(caught.message)).toMatch(/设置文件锁 .* 等待超时/);
    } finally {
      holder.release();
    }
    H.registerVault("acme", { dir: "/d", mnt: "/m" }, { home, lockWaitS: 2 });
    expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-subagent.json"), "utf8")).secure.vaults.acme).toEqual(
      { dir: "/d", mnt: "/m" },
    );
  });

  it("__register child protocol: new flags parse; junk and missing values refuse 78", () => {
    const { home, file } = agentHome();
    const env = { ...process.env, HOME: home };
    const ok = spawnSync(
      process.execPath,
      [HELPER, "__register", "acme", "/d", "/m", "--expect-absent", "--pending", "convert:t1"],
      { env, encoding: "utf8" },
    );
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.acme).toEqual({
      dir: "/d",
      mnt: "/m",
      pending: "convert:t1",
    });
    for (const bad of [
      ["--bogus"],
      ["--pending"], // missing value
      ["--expect-absent", "--expect-absent"], // duplicate
      ["--pending", "convert:x", "--pending", "convert:y"], // duplicate
    ]) {
      const r = spawnSync(process.execPath, [HELPER, "__register", "beta", "/d2", "/m2", ...bad], {
        env,
        encoding: "utf8",
      });
      expect(r.status, `flags ${bad.join(" ")}`).toBe(78);
    }
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.beta).toBeUndefined();
  });
});

describe.skipIf(!HAVE_FLOCK)("V0 patchVaultEntry — the「仅本 txid」commit point", () => {
  function claimed(withPending = "convert:tx1") {
    const { home, file } = agentHome();
    H.registerVault("acme", { dir: "/d/acme", mnt: "/m/acme" }, { home, expectAbsent: true, pending: withPending });
    return { home, file };
  }

  it("convert §1.4 step 14: clear pending + set origin/backup atomically, entry order preserved", () => {
    const { home, file } = claimed();
    const r = H.patchVaultEntry(
      "acme",
      { pending: "convert:tx1" },
      { remove: ["pending"], set: { origin: "/home/me/acme", backup: "/home/me/acme.pi-secure-backup-1" } },
      { home },
    );
    expect(r.kind).toBe("ok");
    expect(r.entry).toEqual({
      dir: "/d/acme",
      mnt: "/m/acme",
      origin: "/home/me/acme",
      backup: "/home/me/acme.pi-secure-backup-1",
    });
    expect(Object.keys(r.entry)).toEqual(["dir", "mnt", "origin", "backup"]);
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.acme).toEqual(r.entry);
  });

  it("import §3.3 step 7: clear pending + set relocate", () => {
    const { home, file } = claimed("import:tx2");
    const rel = { from: "/old/work", to: "/new/work", txid: "tx2", phase: "pending" };
    const r = H.patchVaultEntry(
      "acme",
      { pending: "import:tx2" },
      { remove: ["pending"], set: { relocate: rel } },
      {
        home,
      },
    );
    expect(r.kind).toBe("ok");
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.acme).toEqual({
      dir: "/d/acme",
      mnt: "/m/acme",
      relocate: rel,
    });
  });

  it("relocation done (§3.4 step 5): clear relocate guarded by ITS txid", () => {
    const { home, file } = claimed("import:tx2");
    H.patchVaultEntry(
      "acme",
      { pending: "import:tx2" },
      { remove: ["pending"], set: { relocate: { from: "/a", to: "/b", txid: "tx2", phase: "sessions" } } },
      { home },
    );
    const r = H.patchVaultEntry("acme", { relocateTxid: "tx2" }, { remove: ["relocate"] }, { home });
    expect(r.kind).toBe("ok");
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.acme).toEqual({ dir: "/d/acme", mnt: "/m/acme" });
  });

  it("WRONG txid ⇒ mismatch, settings bytes untouched (someone else owns the entry)", () => {
    const { home, file } = claimed("convert:winner");
    const before = readFileSync(file, "utf8");
    const r = H.patchVaultEntry(
      "acme",
      { pending: "convert:loser" },
      { remove: ["pending"], set: { origin: "/x" } },
      { home },
    );
    expect(r.kind).toBe("mismatch");
    expect(String(r.reason)).toContain("convert:winner");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("a committed entry (pending already cleared) no longer matches", () => {
    const { home } = claimed();
    H.patchVaultEntry("acme", { pending: "convert:tx1" }, { remove: ["pending"] }, { home });
    const r = H.patchVaultEntry("acme", { pending: "convert:tx1" }, { remove: ["pending"] }, { home });
    expect(r.kind).toBe("mismatch");
  });

  it("both guard conditions must hold when both are given", () => {
    const { home } = claimed("import:tx2");
    H.patchVaultEntry(
      "acme",
      { pending: "import:tx2" },
      { set: { relocate: { from: "/a", to: "/b", txid: "tx9", phase: "p" } } },
      { home },
    );
    const bad = H.patchVaultEntry(
      "acme",
      { pending: "import:tx2", relocateTxid: "tx2" }, // relocate is tx9, not tx2
      { remove: ["relocate"] },
      { home },
    );
    expect(bad.kind).toBe("mismatch");
    const good = H.patchVaultEntry(
      "acme",
      { pending: "import:tx2", relocateTxid: "tx9" },
      { remove: ["relocate", "pending"] },
      { home },
    );
    expect(good.kind).toBe("ok");
  });

  it('missing entry / missing settings file ⇒ {kind:"missing"}, nothing created', () => {
    const { home, file } = agentHome();
    writeFileSync(file, JSON.stringify({ secure: { vaults: {} } }));
    expect(H.patchVaultEntry("acme", { pending: "convert:t" }, { remove: ["pending"] }, { home }).kind).toBe("missing");
    const empty = tmp("ps-v0-");
    expect(H.patchVaultEntry("acme", { pending: "convert:t" }, { remove: ["pending"] }, { home: empty }).kind).toBe(
      "missing",
    );
    expect(existsSync(join(empty, ".pi", "agent", "pi-subagent.json"))).toBe(false);
  });

  it("patch surface is allowlisted and shape-checked (programming errors throw, never write)", () => {
    const { home, file } = claimed();
    const before = readFileSync(file, "utf8");
    const badPatches = [
      { set: { dir: "/other" } }, // no dir/mnt/private through the txn surface
      { set: { mnt: "/other" } },
      { set: { private: true } },
      { remove: ["dir"] },
      { remove: ["nope"] },
      { set: { pending: "convert:x" }, remove: ["pending"] }, // set+remove same key
      { set: { origin: "relative" } }, // not absolute
      { set: { pending: "bad pending" } },
      { set: { relocate: { from: "/a", to: "/b", txid: "t", phase: "P" } } }, // phase charset
      { set: { relocate: { from: "/a", to: "/b", txid: "t" } } }, // missing phase
      { set: { relocate: { from: "/a", to: "/b", txid: "t", phase: "p", extra: 1 } } }, // unknown key
      { bogus: true }, // unknown patch key
    ];
    for (const p of badPatches)
      expect(() => H.patchVaultEntry("acme", { pending: "convert:tx1" }, p, { home })).toThrow();
    expect(() => H.patchVaultEntry("acme", {}, { remove: ["pending"] }, { home })).toThrow(/至少要有一个条件/); // no unconditional patch
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("an unparsable settings file is refused (shared refusal path)", () => {
    const { home, file } = agentHome();
    writeFileSync(file, "{bad");
    let caught: any;
    try {
      H.patchVaultEntry("acme", { pending: "convert:t" }, { remove: ["pending"] }, { home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(H.CliError);
    expect(caught.code).toBe(H.EXIT.CONFIG);
    expect(String(caught.message)).toMatch(/拒绝改写/);
  });

  it("settings lock busy ⇒ CliError 73", async () => {
    const { home } = claimed();
    const holder = holdSettingsLock(home);
    await holder.held;
    try {
      let caught: any;
      try {
        H.patchVaultEntry("acme", { pending: "convert:tx1" }, { remove: ["pending"] }, { home, lockWaitS: 0.3 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(H.CliError);
      expect(caught.code).toBe(H.EXIT.LOCK_BUSY);
    } finally {
      holder.release();
    }
  });

  it("unrelated vaults and top-level keys survive the patch", () => {
    const { home, file } = claimed();
    writeFileSync(
      file,
      JSON.stringify({
        keep: 1,
        secure: {
          enabled: true,
          vaults: {
            other: { dir: "/o", mnt: "/om" },
            acme: { dir: "/d/acme", mnt: "/m/acme", pending: "convert:tx1" },
          },
        },
      }),
    );
    const r = H.patchVaultEntry("acme", { pending: "convert:tx1" }, { remove: ["pending"] }, { home });
    expect(r.kind).toBe("ok");
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.keep).toBe(1);
    expect(j.secure.enabled).toBe(true);
    expect(j.secure.vaults.other).toEqual({ dir: "/o", mnt: "/om" });
    expect(j.secure.vaults.acme).toEqual({ dir: "/d/acme", mnt: "/m/acme" });
  });

  it("__vault-patch child: result JSON on stdout; bad argv/JSON ⇒ 78", () => {
    const { home, file } = claimed();
    const env = { ...process.env, HOME: home };
    const ok = spawnSync(
      process.execPath,
      [
        HELPER,
        "__vault-patch",
        "acme",
        JSON.stringify({ pending: "convert:tx1" }),
        JSON.stringify({ remove: ["pending"] }),
      ],
      { env, encoding: "utf8" },
    );
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ kind: "ok", entry: { dir: "/d/acme", mnt: "/m/acme" } });
    for (const argv of [
      [HELPER, "__vault-patch", "acme", "{bad json", "{}"],
      [HELPER, "__vault-patch", "acme", "{}"], // wrong arity
    ]) {
      const r = spawnSync(process.execPath, argv, { env, encoding: "utf8" });
      expect(r.status, argv.join(" ")).toBe(78);
    }
  });
});

describe.skipIf(!HAVE_FLOCK)("V0 removeVaultEntry — rollback removes only this txid's entry", () => {
  function claimed(withPending = "convert:tx1") {
    const { home, file } = agentHome();
    H.registerVault("acme", { dir: "/d/acme", mnt: "/m/acme" }, { home, expectAbsent: true, pending: withPending });
    H.registerVault("other", { dir: "/d/other", mnt: "/m/other" }, { home });
    return { home, file };
  }

  it("removes the entry when pending matches; other entries survive", () => {
    const { home, file } = claimed();
    const r = H.removeVaultEntry("acme", { pending: "convert:tx1" }, { home });
    expect(r.kind).toBe("ok");
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults).toEqual({
      other: { dir: "/d/other", mnt: "/m/other" },
    });
  });

  it("wrong txid / committed entry ⇒ mismatch, nothing deleted (I-C8)", () => {
    const { home, file } = claimed("convert:mine");
    const before = readFileSync(file, "utf8");
    expect(H.removeVaultEntry("acme", { pending: "convert:theirs" }, { home }).kind).toBe("mismatch");
    expect(readFileSync(file, "utf8")).toBe(before);
    // committed (pending cleared) ⇒ never deletable through this API
    H.patchVaultEntry("acme", { pending: "convert:mine" }, { remove: ["pending"] }, { home });
    const afterCommit = readFileSync(file, "utf8");
    expect(H.removeVaultEntry("acme", { pending: "convert:mine" }, { home }).kind).toBe("mismatch");
    expect(readFileSync(file, "utf8")).toBe(afterCommit);
  });

  it('missing entry / missing settings ⇒ {kind:"missing"}; a non-object entry ⇒ mismatch (fail closed)', () => {
    const { home, file } = agentHome();
    writeFileSync(file, JSON.stringify({ secure: { vaults: {} } }));
    expect(H.removeVaultEntry("acme", { pending: "convert:t" }, { home }).kind).toBe("missing");
    writeFileSync(file, JSON.stringify({ secure: { vaults: { acme: "garbage" } } }));
    expect(H.removeVaultEntry("acme", { pending: "convert:t" }, { home }).kind).toBe("mismatch");
    expect(JSON.parse(readFileSync(file, "utf8")).secure.vaults.acme).toBe("garbage"); // untouched
  });

  it("guard.pending is mandatory (no unconditional removal) and validated", () => {
    const { home } = claimed();
    expect(() => H.removeVaultEntry("acme", {}, { home })).toThrow(/guard\.pending/);
    expect(() => H.removeVaultEntry("acme", { relocateTxid: "tx" }, { home })).toThrow(/guard\.pending/);
    expect(() => H.removeVaultEntry("acme", { pending: "nope" }, { home })).toThrow(/guard\.pending/);
  });

  it("settings lock busy ⇒ CliError 73", async () => {
    const { home } = claimed();
    const holder = holdSettingsLock(home);
    await holder.held;
    try {
      expect(() => H.removeVaultEntry("acme", { pending: "convert:tx1" }, { home, lockWaitS: 0.3 })).toThrowError(
        expect.objectContaining({ code: H.EXIT.LOCK_BUSY }) as never,
      );
    } finally {
      holder.release();
    }
  });
});

describe("V0 surface — CliError + V0_PORTS", () => {
  it("CliError is exported and carries the §6 exit code", () => {
    const e = new H.CliError(76, "busy");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(76);
    expect(String(e)).toContain("busy");
  });

  it("V0_PORTS is a frozen bundle of exactly the six port functions", () => {
    expect(Object.isFrozen(H.V0_PORTS)).toBe(true);
    expect(Object.keys(H.V0_PORTS)).toEqual([
      "unlockVault",
      "registerVault",
      "patchVaultEntry",
      "removeVaultEntry",
      "finalizeBounded",
      "scanCwdOccupants",
      "preflight",
    ]);
    for (const k of Object.keys(H.V0_PORTS)) expect(typeof H.V0_PORTS[k]).toBe("function");
    expect(H.V0_PORTS.unlockVault).toBe(H.unlockVault);
    expect(H.V0_PORTS.registerVault).toBe(H.registerVault);
    expect(H.V0_PORTS.patchVaultEntry).toBe(H.patchVaultEntry);
    expect(H.V0_PORTS.removeVaultEntry).toBe(H.removeVaultEntry);
    expect(H.V0_PORTS.finalizeBounded).toBe(H.finalizeBounded);
    expect(H.V0_PORTS.scanCwdOccupants).toBe(H.scanCwdOccupants);
    expect(H.V0_PORTS.preflight).toBe(H.preflight);
  });

  it("PENDING_RE accepts the plan's marker forms and rejects junk", () => {
    expect(H.PENDING_RE.test("convert:0123abcd-XYZ")).toBe(true);
    expect(H.PENDING_RE.test("import:deadbeef")).toBe(true);
    for (const bad of ["", "convert", "convert:", "CONVERT:x", "convert:x y", "a".repeat(40) + ":" + "x".repeat(60)])
      expect(H.PENDING_RE.test(bad)).toBe(false);
  });
});

// ───────────────────── unlockVault(v, {postMount:false}) — REAL gocryptfs ─────────────────────

const HAVE_FUSE =
  process.platform === "linux" &&
  ["gocryptfs", "fusermount3", "flock", "script"].every((b) => which(b) !== undefined) &&
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0;

describe.skipIf(!HAVE_FUSE)("V0 unlockVault({postMount:false}) against real gocryptfs", () => {
  // Real global mounts: serialize against the other real-mount suites (gocryptfs-test-lock).
  let releaseGocryptfsLock: (() => void) | undefined;
  beforeAll(async () => {
    releaseGocryptfsLock = await acquireGocryptfsTestLock();
  }, 250_000);
  afterAll(() => releaseGocryptfsLock?.());

  /** Build a registered, initialized, UNMOUNTED vault test-side (fake passfile only). */
  function buildVault(name: string): { root: string; home: string; dir: string; mnt: string; env: NodeJS.ProcessEnv } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-v0f-")));
    chmodSync(root, 0o700);
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    const dir = join(home, ".local", "share", "pi-toolkit-secure", name);
    const mnt = join(home, "secure", name);
    const v = H.deriveVault(name, dir, mnt);
    H.createLayout(v, { home });
    const passfile = join(root, "pf");
    writeFileSync(passfile, `${FAKE_PW}\n`, { mode: 0o600 });
    const r = spawnSync("gocryptfs", ["-init", "-passfile", passfile, "--", v.cipher], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    H.registerVault(name, { dir, mnt }, { home, expectAbsent: true, pending: "convert:v0test" });
    scratch.push(root);
    return { root, home, dir, mnt, env: { ...process.env, HOME: home } };
  }

  /** Run a driver script under a pty, typing passwords at each gocryptfs prompt. */
  function runPtyDriver(scriptPath: string, answers: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000) {
    return new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn("script", ["-qefc", `${process.execPath} ${scriptPath}`, "/dev/null"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let text = "";
      let typed = 0;
      const onData = (b: Buffer) => {
        text += b.toString("utf8");
        if (/Password: *$/.test(text.trimEnd() + " ") && typed < answers.length) {
          child.stdin.write(`${answers[typed++]}\r`);
          // only one answer per prompt: drop the matched prompt so the next needs fresh input
          text = text.replace(/Password: *$/, "");
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        resolve({ code, text: text.replace(/\r/g, "") });
      });
    });
  }

  const mountedAt = (mnt: string) =>
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((l) => l.split(" ")[4] === mnt && l.includes(" - fuse.gocryptfs "));

  it("mounts RAW: no work/state dirs, no .pi/settings.json; then finalizeBounded unmounts", async () => {
    const { root, home, mnt, env } = buildVault("rawmount");
    const driver = join(root, "driver.mjs");
    writeFileSync(
      driver,
      `import { existsSync, readdirSync } from "node:fs";
const H = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
const { vault } = H.resolveVault("rawmount", { home: ${JSON.stringify(home)} });
const r = await H.unlockVault(vault, { postMount: false });
console.log("UNLOCK " + JSON.stringify({ how: r.how, realMnt: r.realMnt }));
console.log("RAW " + JSON.stringify({ entries: readdirSync(${JSON.stringify(mnt)}), work: existsSync(${JSON.stringify(join(mnt, "work"))}), pi: existsSync(${JSON.stringify(join(mnt, ".pi"))}) }));
const f = await H.finalizeBounded(vault);
console.log("FINALIZE " + f.code);
`,
    );
    const r = await runPtyDriver(driver, [FAKE_PW], env);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('"how":"mounted-now"');
    // the vault dir has no symlinks in its chain here, so realMnt === lexical mnt
    expect(r.text).toContain(`"realMnt":${JSON.stringify(mnt)}`);
    expect(r.text).toContain(`"entries":[]`);
    expect(r.text).toContain(`"work":false`);
    expect(r.text).toContain(`"pi":false`);
    expect(r.text).toContain("FINALIZE 0");
    expect(mountedAt(mnt)).toBe(false);
    // unmounted again ⇒ the two sentinels are visible once more
    expect(readdirSync(mnt).sort()).toEqual(["state", "work"]);
  });

  it("default (postMount:true) still builds work/state + sessionDir — regression for the option shadowing the function", async () => {
    const { root, home, mnt, env } = buildVault("withpost");
    const driver = join(root, "driver2.mjs");
    writeFileSync(
      driver,
      `import { existsSync, readdirSync } from "node:fs";
const H = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
const { vault } = H.resolveVault("withpost", { home: ${JSON.stringify(home)} });
const r = await H.unlockVault(vault); // no options: postMount runs (a boolean option once shadowed the same-named function)
console.log("UNLOCK " + r.how);
console.log("POST " + JSON.stringify({ work: existsSync(${JSON.stringify(join(mnt, "work"))}), state: existsSync(${JSON.stringify(join(mnt, "state"))}), settings: existsSync(${JSON.stringify(join(mnt, "work", ".pi", "settings.json"))}) }));
const f = await H.finalizeBounded(vault);
console.log("FINALIZE " + f.code);
`,
    );
    const r = await runPtyDriver(driver, [FAKE_PW], env);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("UNLOCK mounted-now");
    expect(r.text).toContain('"work":true');
    expect(r.text).toContain('"state":true');
    expect(r.text).toContain('"settings":true');
    expect(r.text).toContain("FINALIZE 0");
    expect(mountedAt(mnt)).toBe(false);
  });

  it("failure path stays typed: 3 wrong passwords ⇒ CliError 77, nothing mounted, sentinels intact", async () => {
    const { root, home, mnt, env } = buildVault("wrongpw");
    const driver = join(root, "driver.mjs");
    writeFileSync(
      driver,
      `const H = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
const { vault } = H.resolveVault("wrongpw", { home: ${JSON.stringify(home)} });
try {
  await H.unlockVault(vault, { postMount: false });
  console.log("NO-THROW");
} catch (e) {
  console.log("THREW " + e.code + " " + (e instanceof H.CliError));
}
`,
    );
    const r = await runPtyDriver(driver, [FAKE_PW + "-wrong", FAKE_PW + "-wrong", FAKE_PW + "-wrong"], env);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain(`THREW ${H.EXIT.BAD_PASSWORD} true`); // 77, typed
    expect(mountedAt(mnt)).toBe(false);
    expect(readdirSync(mnt).sort()).toEqual(["state", "work"]);
  });
});
