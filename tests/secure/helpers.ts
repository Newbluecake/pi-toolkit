/** Shared fixtures for the P2 guard tests: a fake vault on disk + a fake mountinfo (no FUSE needed). */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSecureDomain, resetSecureDomainForTests, type SecureDomain } from "../../src/secure/domain.js";

export interface FakeVault {
  tmp: string;
  home: string;
  dir: string;
  link: string;
  work: string;
  state: string;
  sessions: string;
  settingsPath: string;
  /** mountinfo text that shows the vault mounted */
  mounted: string;
  /** mountinfo text without the vault */
  unmounted: string;
  outside: string;
  cleanup(): void;
}

export function mountLine(mnt: string, fs: string, src: string): string {
  return `40 25 0:40 / ${mnt.replace(/ /g, "\\040")} rw,nosuid,nodev shared:40 - ${fs} ${src.replace(/ /g, "\\040")} rw`;
}

export function makeFakeVault(opts: { name?: string; settings?: unknown; stateIsSentinel?: boolean } = {}): FakeVault {
  const name = opts.name ?? "acme";
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-secure-p2-")));
  const home = join(tmp, "home");
  const dir = join(tmp, "vaults", name);
  const link = join(home, "secure", name);
  mkdirSync(join(dir, "cipher"), { recursive: true });
  mkdirSync(join(dir, "mnt", "work", "sub"), { recursive: true });
  if (opts.stateIsSentinel) writeFileSync(join(dir, "mnt", "state"), "", { mode: 0o400 });
  else mkdirSync(join(dir, "mnt", "state", "sessions", "default"), { recursive: true });
  mkdirSync(join(home, "secure"), { recursive: true });
  symlinkSync(join(dir, "mnt", "work"), link);
  const outside = join(tmp, "outside");
  mkdirSync(outside, { recursive: true });
  const settingsPath = join(home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(opts.settings ?? { secure: { vaults: { [name]: { dir, link } } } }));
  const base = "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw\n";
  return {
    tmp,
    home,
    dir,
    link,
    work: join(dir, "mnt", "work"),
    state: join(dir, "mnt", "state"),
    sessions: join(dir, "mnt", "state", "sessions", "default"),
    settingsPath,
    mounted: base + mountLine(join(dir, "mnt"), "fuse.gocryptfs", join(dir, "cipher")) + "\n",
    unmounted: base,
    outside,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Freeze a verdict on the process global with an isolated env object (process.env untouched). */
export function freezeDomain(
  v: FakeVault,
  over: { cwd?: string; env?: Record<string, string | undefined>; mountinfo?: string } = {},
): { domain: SecureDomain; env: Record<string, string | undefined> } {
  resetSecureDomainForTests();
  const env = over.env ?? {};
  const domain = initSecureDomain({
    env,
    cwd: over.cwd ?? v.work,
    home: v.home,
    settingsPath: v.settingsPath,
    readMountinfo: () => over.mountinfo ?? v.mounted,
  });
  return { domain, env };
}
