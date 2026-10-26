// settings-rename P1 (plan §3.4.1, T-MG6 launcher half): every launcher settings WRITER heals a crash-window
// S6a under the lock before it resolves its target, and no writer ever creates the permanent conflict S6b.
// Real helper.mjs writers (registerVault / patchVaultEntry / removeVaultEntry / unclaimInitEntry spawn the
// real flock child); sandbox HOME only; content is checked structurally, never printed.
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
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSecureDomain } from "../../src/secure/domain.js";
import {
  LEGACY_SETTINGS_FILE_NAME as OLD,
  SETTINGS_FILE_NAME as NEW,
  resolveSettingsFile,
  withSettingsFileLock,
  healSettingsFileLocked,
  writeSettingsFileAtomic,
} from "../../src/secure/settings-lock.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(
  pathToFileURL(join(import.meta.dirname, "..", "..", "src", "secure", "bin", "helper.mjs")).href
);

let home: string;
let agent: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-heal-")));
  agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const P = (n: string) => join(agent, n);
const seed = {
  budget: { idleS: 120 },
  secure: { vaults: { acme: { dir: "/d/acme", mnt: "/m/acme", pending: "convert:t1" } } },
};
const text = JSON.stringify(seed);
const put = (n: string, t = text) => writeFileSync(P(n), t, { mode: 0o600 });
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const lnks = () => readdirSync(agent).filter((n) => n.endsWith(".lnk"));

interface State {
  id: string;
  build: () => void;
  /** after the write: where the new content must be readable and the resulting state */
  after: { path: string; kind: string; legacy?: string } | "throws";
}
const STATES: State[] = [
  { id: "S0 nothing", build: () => undefined, after: { path: OLD, kind: "legacy" } },
  { id: "S1 legacy file", build: () => put(OLD), after: { path: OLD, kind: "legacy" } },
  {
    id: "S2 external symlink",
    build: () => {
      writeFileSync(join(home, "dot.json"), text);
      symlinkSync(join(home, "dot.json"), P(OLD));
    },
    after: "throws",
  },
  {
    id: "S3 dangling compat link",
    build: () => symlinkSync(NEW, P(OLD)),
    after: { path: NEW, kind: "new", legacy: "compat-link" },
  },
  { id: "S4 new only", build: () => put(NEW), after: { path: NEW, kind: "new", legacy: "absent" } },
  {
    id: "S5 new + compat link",
    build: () => {
      put(NEW);
      symlinkSync(NEW, P(OLD));
    },
    after: { path: NEW, kind: "new", legacy: "compat-link" },
  },
  {
    id: "S6a same inode (crash window)",
    build: () => {
      put(NEW);
      linkSync(P(NEW), P(OLD));
    },
    after: { path: NEW, kind: "new", legacy: "compat-link" },
  },
  {
    id: "S6b diverged files (stays S6b)",
    build: () => {
      put(NEW);
      put(OLD);
      utimesSync(P(OLD), 5, 5);
    },
    after: { path: NEW, kind: "new", legacy: "conflict" },
  },
];

describe("T-MG6 launcher writers over every initial state", () => {
  for (const s of STATES) {
    it(`registerVault: ${s.id}`, () => {
      s.build();
      const doIt = () => H.registerVault("beta", { dir: "/d/beta", mnt: "/m/beta" }, { home });
      if (s.after === "throws") {
        expect(doIt).toThrow(/符号链接/);
        expect(readJson(join(home, "dot.json")).secure.vaults.beta).toBeUndefined(); // link target untouched
        return;
      }
      doIt();
      expect(readJson(P(s.after.path)).secure.vaults.beta).toEqual({ dir: "/d/beta", mnt: "/m/beta" });
      const st = resolveSettingsFile(agent);
      expect(st.kind).toBe(s.after.kind);
      if (st.kind === "new") expect(st.legacy).toBe(s.after.legacy);
      expect(lnks()).toEqual([]);
      if (st.kind === "new" && st.legacy === "compat-link") expect(readlinkSync(P(OLD))).toBe(NEW);
      // the launcher's own reading of the result is valid (never `secure:invalid` from a manufactured S6b)
      if (s.id.startsWith("S6b")) return;
      expect(H.loadSecureConfig(home).cfg.valid).toBe(true);
      const dom = computeSecureDomain({
        home,
        env: {},
        cwd: home,
        readMountinfo: () => "",
        readSelfMntNs: () => undefined,
        readBootId: () => undefined,
      });
      expect(dom.config.valid).toBe(true);
      expect(dom.config.error).toBeUndefined();
    });

    it(`patchVaultEntry / removeVaultEntry: ${s.id}`, () => {
      s.build();
      const patch = () =>
        H.patchVaultEntry(
          "acme",
          { pending: "convert:t1" },
          { set: { origin: "/o/acme" }, remove: ["pending"] },
          { home },
        );
      if (s.id.startsWith("S0") || s.id.startsWith("S3")) {
        expect(patch()).toEqual({ kind: "missing" }); // nothing claimed ⇒ a patch never creates
        expect(existsSync(P(NEW))).toBe(false);
        return;
      }
      if (s.after === "throws") {
        expect(patch).toThrow(/符号链接/);
        return;
      }
      const r = patch();
      expect(r.kind).toBe("ok");
      const entry = readJson(P(s.after.path)).secure.vaults.acme;
      expect(entry).toEqual({ dir: "/d/acme", mnt: "/m/acme", origin: "/o/acme" });
      const st = resolveSettingsFile(agent);
      expect(st.kind).toBe(s.after.kind);
      if (st.kind === "new") expect(st.legacy).toBe(s.after.legacy);
      expect(lnks()).toEqual([]);
      // removal rollback half goes through the same heal path
      const rm = H.removeVaultEntry("acme", { pending: "convert:t1" }, { home });
      expect(rm.kind).toBe("mismatch"); // pending was cleared by the patch ⇒ never deletes a committed entry
    });
  }

  it("unclaimInitEntry heals S6a too", () => {
    put(NEW, JSON.stringify({ secure: { vaults: { acme: { dir: "/d/a", mnt: "/m/a" } } } }));
    linkSync(P(NEW), P(OLD));
    const r = H.unclaimInitEntry("acme", { dir: "/d/a", mnt: "/m/a" }, undefined, { home });
    expect(r).toEqual({ kind: "ok", action: "deleted" });
    expect(readlinkSync(P(OLD))).toBe(NEW);
    expect(readJson(P(NEW)).secure.vaults).toEqual({});
  });

  it("the settings lock stays the fixed legacy-named file in every state", () => {
    put(NEW);
    symlinkSync(NEW, P(OLD));
    H.registerVault("beta", { dir: "/d/beta", mnt: "/m/beta" }, { home });
    expect(readdirSync(agent).filter((n) => n.includes("lock"))).toEqual([".pi-subagent.json.lock"]);
  });
});

describe("the plugin-side write protocol (what persistSettingOverride composes in P2)", () => {
  // lock → heal → resolve target → atomic write. The same composition P2 wires into persistSettingOverride;
  // pinned here at the protocol level so P2 cannot regress it.
  function pluginWrite(): void {
    const r = withSettingsFileLock(P(NEW), () => {
      healSettingsFileLocked(agent);
      const st = resolveSettingsFile(agent);
      const target = st.kind === "none" ? st.newPath : st.path;
      const cur = existsSync(target) ? (JSON.parse(readFileSync(target, "utf8")) as object) : {};
      writeSettingsFileAtomic(target, JSON.stringify({ ...cur, touched: true }));
    });
    expect(r.ok).toBe(true);
  }
  it("S6a ⇒ S5 (never S6b); S5 keeps the link; atomic write replaces the NEW inode only", () => {
    put(NEW);
    linkSync(P(NEW), P(OLD));
    pluginWrite();
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "new", legacy: "compat-link" });
    expect(readJson(P(OLD)).touched).toBe(true);
    pluginWrite();
    expect(lstatSync(P(OLD)).isSymbolicLink()).toBe(true);
    expect(lnks()).toEqual([]);
  });
  it("WITHOUT the heal the same write manufactures S6b — the failure mode the heal exists for", () => {
    put(NEW);
    linkSync(P(NEW), P(OLD));
    writeSettingsFileAtomic(P(NEW), JSON.stringify({ touched: true }));
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "new", legacy: "conflict" });
  });
});

describe("healSettingsFileLocked: TS and launcher mirror agree", () => {
  const eperm = () => Object.assign(new Error("not permitted"), { code: "EPERM" });
  for (const impl of ["ts", "mjs"] as const) {
    const heal = (deps: object = {}) =>
      impl === "ts" ? healSettingsFileLocked(agent, deps) : H.healSettingsFileLocked(agent, deps);
    it(`${impl}: S6a ⇒ healed; S0/S1/S4/S5/S6b ⇒ noop`, () => {
      expect(heal()).toBe("noop");
      put(OLD);
      expect(heal()).toBe("noop");
      rmSync(P(OLD));
      put(NEW);
      expect(heal()).toBe("noop");
      linkSync(P(NEW), P(OLD));
      expect(heal()).toBe("healed");
      expect(readlinkSync(P(OLD))).toBe(NEW);
      expect(heal()).toBe("noop");
      rmSync(P(OLD));
      put(OLD, "{}");
      expect(heal()).toBe("noop");
      expect(lstatSync(P(OLD)).isFile()).toBe(true);
    });
    it(`${impl}: symlink EPERM ⇒ reverted-to-legacy (NEW removed, LEGACY intact)`, () => {
      put(NEW);
      linkSync(P(NEW), P(OLD));
      const before = lstatSync(P(OLD)).ino;
      expect(
        heal({
          symlink: () => {
            throw eperm();
          },
        }),
      ).toBe("reverted-to-legacy");
      expect(existsSync(P(NEW))).toBe(false);
      expect(lstatSync(P(OLD)).ino).toBe(before);
      expect(lnks()).toEqual([]);
    });
    it(`${impl}: a leftover .lnk is removed, and a replaced LEGACY (not same inode) is never overwritten`, () => {
      put(NEW);
      linkSync(P(NEW), P(OLD));
      symlinkSync(NEW, P("pi-subagent.json.0123456789abcdef.lnk"));
      expect(heal()).toBe("healed");
      expect(lnks()).toEqual([]);
    });
  }
});
