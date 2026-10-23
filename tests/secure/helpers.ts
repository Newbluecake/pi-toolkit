/** Shared fixtures for the P2 guard tests: a fake vault on disk + a fake mountinfo (no FUSE needed).
 *  New §L.1 layout by default (mount point = <home>/secure/<name>); `legacy: true` builds the
 *  pre-L0 layout (§L.3) for the read-only-compat tests. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSecureDomain, resetSecureDomainForTests, type SecureDomain } from "../../src/secure/domain.js";

export interface FakeVault {
  tmp: string;
  home: string;
  dir: string;
  /** New layout: the mount point `~/secure/<name>`; legacy: `<dir>/mnt`. */
  mnt: string;
  /** Legacy layout only: the old entry symlink `~/secure/<name>` → `<dir>/mnt/work`. */
  link?: string;
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

export function makeFakeVault(
  opts: { name?: string; settings?: unknown; stateIsSentinel?: boolean; legacy?: boolean } = {},
): FakeVault {
  const name = opts.name ?? "acme";
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-secure-p2-")));
  const home = join(tmp, "home");
  const dir = join(tmp, "vaults", name);
  const entryMnt = join(home, "secure", name);
  mkdirSync(join(dir, "cipher"), { recursive: true });
  let mnt: string;
  let link: string | undefined;
  let entry: Record<string, string>;
  if (opts.legacy) {
    // pre-L0 layout: mount point <dir>/mnt + entry symlink ~/secure/<name> → <dir>/mnt/work
    mnt = join(dir, "mnt");
    link = entryMnt;
    entry = { dir, link };
  } else {
    mnt = entryMnt;
    entry = { dir, mnt };
  }
  mkdirSync(join(mnt, "work", "sub"), { recursive: true });
  if (opts.stateIsSentinel) writeFileSync(join(mnt, "state"), "", { mode: 0o400 });
  else mkdirSync(join(mnt, "state", "sessions", "default"), { recursive: true });
  if (link) {
    mkdirSync(join(home, "secure"), { recursive: true });
    symlinkSync(join(mnt, "work"), link);
  }
  const outside = join(tmp, "outside");
  mkdirSync(outside, { recursive: true });
  const settingsPath = join(home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(opts.settings ?? { secure: { vaults: { [name]: entry } } }));
  const base = "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw\n";
  return {
    tmp,
    home,
    dir,
    mnt,
    link,
    work: join(mnt, "work"),
    state: join(mnt, "state"),
    sessions: join(mnt, "state", "sessions", "default"),
    settingsPath,
    mounted: base + mountLine(mnt, "fuse.gocryptfs", join(dir, "cipher")) + "\n",
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
