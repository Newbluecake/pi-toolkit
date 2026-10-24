/**
 * init cleanup (user ruling 2026-10-24) against REAL gocryptfs through the real launcher in a pty.
 * Self-gated (realSkipReason); every vault lives in a token-marked mktemp HOME with fake passwords;
 * the cross-suite gocryptfs lock is held per test.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import { type Env, PW, RealHarness, globalMounted, plain, realSkipReason } from "./private-real-harness.js";

const SKIP = realSkipReason();
const WRONG = "WRONG-fake-password";

describe.skipIf(SKIP !== "")("init cleanup — real gocryptfs (fake passwords, mktemp HOME)", () => {
  let release: (() => void) | undefined;
  const T = new RealHarness();
  beforeEach(async () => {
    release = await acquireGocryptfsTestLock(590_000);
  }, 600_000);
  afterEach(() => {
    try {
      T.cleanup();
    } finally {
      release?.();
      release = undefined;
    }
  });
  afterAll(() => T.cleanup());

  const dirOf = (e: Env, n: string) => join(e.h, ".local", "share", "pi-toolkit-secure", n);
  const mntOf = (e: Env, n: string) => join(e.h, "secure", n);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vaults = (e: Env): Record<string, any> =>
    JSON.parse(readFileSync(join(e.h, ".pi", "agent", "pi-subagent.json"), "utf8")).secure?.vaults ?? {};
  const expectNoResidue = (e: Env, n: string) => {
    expect(existsSync(dirOf(e, n))).toBe(false);
    expect(existsSync(mntOf(e, n))).toBe(false);
    expect(vaults(e)[n]).toBeUndefined();
  };

  it("① gocryptfs -init fails (the two new passwords differ) ⇒ removed automatically, no residue", async () => {
    const e = T.setup([], { acme: false, prefix: "ps-ic-" });
    const r = await T.tty(e, "init beta", {}, { passwords: [PW, "OTHER-fake-password"], killAfterMs: 60_000 });
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain("gocryptfs -init 失败");
    expect(r.text).toContain("清理本次创建的内容：");
    expect(r.text).toContain("已撤销登记 secure.vaults.beta");
    expect(r.text).not.toContain("保留未动");
    expectNoResidue(e, "beta");
  }, 120_000);

  it("② first mount 3× wrong ⇒ asked (TTY); y ⇒ everything this run created is gone", async () => {
    const e = T.setup([], { acme: false, prefix: "ps-ic-" });
    const r = await T.tty(
      e,
      "init beta",
      {},
      { passwords: [PW, PW, WRONG, WRONG, WRONG], answers: [[/\[y\/N\]/, "y"]], killAfterMs: 90_000 },
    );
    expect(r.code, r.text).toBe(77);
    expect(r.text).toContain(
      "是否删除刚创建的空保险库 beta？删除后刚才打印的 master key 作废，需要重新 pi-secure init beta。[y/N]",
    );
    expect(r.text).toContain("按要求清理本次创建的内容：");
    expect(r.text).not.toContain("保留未动");
    expectNoResidue(e, "beta");
    expect(globalMounted(mntOf(e, "beta"))).toBe(false);
  }, 150_000);

  it("② N ⇒ the vault is kept (registered); init --fix-settings with the right password completes it", async () => {
    const e = T.setup([], { acme: false, prefix: "ps-ic-" });
    const r = await T.tty(
      e,
      "init beta",
      {},
      { passwords: [PW, PW, WRONG, WRONG, WRONG], answers: [[/\[y\/N\]/, "n"]], killAfterMs: 90_000 },
    );
    expect(r.code, r.text).toBe(77);
    expect(r.text).toContain("已保留保险库 beta");
    expect(r.text).toContain("pi-secure init beta --fix-settings");
    expect(vaults(e).beta).toEqual({ dir: dirOf(e, "beta"), mnt: mntOf(e, "beta") });
    expect(existsSync(join(dirOf(e, "beta"), "cipher", "gocryptfs.conf"))).toBe(true);
    const fx = await T.tty(e, "init beta --fix-settings", {}, { killAfterMs: 90_000 });
    expect(fx.code, fx.text).toBe(0);
    expect(globalMounted(mntOf(e, "beta"))).toBe(true);
    expect(existsSync(join(mntOf(e, "beta"), "work", ".pi", "settings.json"))).toBe(true);
    expect(plain(e, "lock beta").code).toBe(0);
    expect(plain(e, "status beta").text).toContain("layout ok");
  }, 180_000);

  it("--private: 3× wrong in the setup mount ⇒ y removes everything; N keeps it and --fix-settings completes inside the ns", async () => {
    const e = T.setup([], { acme: false, prefix: "ps-ic-" });
    const y = await T.tty(
      e,
      "init pv --private",
      {},
      { passwords: [PW, PW, WRONG, WRONG, WRONG], answers: [[/\[y\/N\]/, "y"]], killAfterMs: 90_000 },
    );
    expect(y.code, y.text).toBe(77);
    expect(y.text).toContain("首次私有挂载失败");
    expect(y.text).toContain("按要求清理本次创建的内容：");
    expect(y.text).not.toContain("保留未动");
    expectNoResidue(e, "pv");
    const n = await T.tty(
      e,
      "init pw --private",
      {},
      { passwords: [PW, PW, WRONG, WRONG, WRONG], answers: [[/\[y\/N\]/, "n"]], killAfterMs: 90_000 },
    );
    expect(n.code, n.text).toBe(77);
    expect(n.text).toContain("已保留保险库 pw（已创建并登记为 --private）");
    expect(vaults(e).pw).toEqual({ dir: dirOf(e, "pw"), mnt: mntOf(e, "pw"), private: true });
    const fx = await T.tty(e, "init pw --fix-settings", {}, { killAfterMs: 90_000 });
    expect(fx.code, fx.text).toBe(0);
    expect(globalMounted(mntOf(e, "pw"))).toBe(false); // setup mode unmounts
    expect(plain(e, "status pw").text).toContain("layout ok");
  }, 300_000);
});
