import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSettingsFile as agentFile,
  resolveSettingsLocation as agentLocation,
} from "../../../src/secure/settings-lock.js";
import { resolveAgentDir } from "../../../src/web-hub/protocol/agent-dir.js";
import {
  LEGACY_SETTINGS_FILE_NAME as OLD,
  SETTINGS_FILE_NAME as NEW,
  resolveSettingsFile,
  resolveSettingsLocation,
  type SettingsFsDeps,
} from "../../../src/web-hub/protocol/settings-location.js";

let root: string;
let dir: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-loc-"));
  dir = join(root, "custom");
  home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const file = (d: string, name: string) =>
  writeFileSync(join(d, name), '{"webHub":{"terminal":{"enabled":true}}}', { mode: 0o600 });
const agent = () => ({ dir, home, source: "env" as const });
const errno = (code: string) => Object.assign(new Error("must not expose message/private-path"), { code });

const validRows: Array<[string, (d: string) => void]> = [
  ["S0 absent", () => {}],
  ["S1 legacy regular", (d) => file(d, OLD)],
  ["S4 new regular", (d) => file(d, NEW)],
  [
    "S5 exact relative compat",
    (d) => {
      file(d, NEW);
      symlinkSync(NEW, join(d, OLD));
    },
  ],
  [
    "S5 exact absolute compat",
    (d) => {
      file(d, NEW);
      symlinkSync(join(d, NEW), join(d, OLD));
    },
  ],
  [
    "S6a same inode",
    (d) => {
      file(d, NEW);
      linkSync(join(d, NEW), join(d, OLD));
    },
  ],
  [
    "S6b regular conflict legacy newer",
    (d) => {
      file(d, NEW);
      file(d, OLD);
      utimesSync(join(d, NEW), 1, 1);
      utimesSync(join(d, OLD), 2, 2);
    },
  ],
  [
    "S6b regular conflict new newer",
    (d) => {
      file(d, NEW);
      file(d, OLD);
      utimesSync(join(d, NEW), 2, 2);
      utimesSync(join(d, OLD), 1, 1);
    },
  ],
];
describe("parity ONLY for valid regular-file S0–S7 subsets and declared missing inheritance", () => {
  it.each(validRows)("%s", (_label, build) => {
    build(dir);
    const before = readdirSync(dir);
    expect(resolveSettingsFile(dir)).toEqual(agentFile(dir));
    expect(resolveSettingsLocation(agent())).toEqual(agentLocation(agent()));
    expect(readdirSync(dir)).toEqual(before); // no lock, migration or compat healing
    for (const name of before) {
      if (lstatSync(join(dir, name)).isFile())
        expect(readFileSync(join(dir, name), "utf8")).toContain('"enabled":true');
    }
  });
  it.each(["absent-files", "absent-directory", "absent-parent"])("genuine primary ENOENT may inherit: %s", (kind) => {
    file(home, NEW);
    if (kind !== "absent-files") dir = join(root, kind === "absent-directory" ? "missing" : "missing/child");
    expect(resolveSettingsLocation(agent())).toEqual(agentLocation(agent()));
    expect(resolveSettingsLocation(agent())).toMatchObject({ kind: "new", scope: "inherited", path: join(home, NEW) });
  });
  it("default scope and both missing preserve agent resolver parity", () => {
    const a = resolveAgentDir({}, root);
    expect(resolveSettingsLocation(a)).toEqual(agentLocation(a));
    expect(resolveSettingsLocation(agent())).toEqual(agentLocation(agent()));
  });
  it("present primary never merges HOME terminal limits", () => {
    file(dir, OLD);
    file(home, NEW);
    expect(resolveSettingsLocation(agent())).toMatchObject({ kind: "legacy", scope: "agentDir", path: join(dir, OLD) });
  });
});

const unsafeRows: Array<[string, (d: string) => void, string]> = [
  [
    "S2 arbitrary legacy symlink",
    (d) => {
      file(root, "external.json");
      symlinkSync(join(root, "external.json"), join(d, OLD));
    },
    "ELOOP",
  ],
  ["S3 dangling relative compat", (d) => symlinkSync(NEW, join(d, OLD)), "ENOENT"],
  ["S3 dangling absolute compat", (d) => symlinkSync(join(d, NEW), join(d, OLD)), "ENOENT"],
  [
    "S5c indirect compat is not exact",
    (d) => {
      file(d, NEW);
      symlinkSync(NEW, join(d, "mid.json"));
      symlinkSync("mid.json", join(d, OLD));
    },
    "ELOOP",
  ],
  [
    "S6b external legacy link",
    (d) => {
      file(d, NEW);
      file(root, "external.json");
      symlinkSync(join(root, "external.json"), join(d, OLD));
    },
    "ELOOP",
  ],
  ["S7 new directory", (d) => mkdirSync(join(d, NEW)), "EINVAL"],
  [
    "new arbitrary symlink",
    (d) => {
      file(root, "external.json");
      symlinkSync(join(root, "external.json"), join(d, NEW));
    },
    "ELOOP",
  ],
  ["new dangling symlink", (d) => symlinkSync("missing", join(d, NEW)), "ELOOP"],
  ["legacy directory", (d) => mkdirSync(join(d, OLD)), "EINVAL"],
];
describe("declared differences: unsafe states are unavailable, NEVER absent/inherited", () => {
  it.each(unsafeRows)("%s", (_label, build, code) => {
    build(dir);
    file(home, NEW);
    expect(resolveSettingsFile(dir)).toMatchObject({ kind: "unavailable", code });
    expect(resolveSettingsFile(dir)).not.toEqual(agentFile(dir));
    expect(resolveSettingsLocation(agent())).toMatchObject({ kind: "unavailable", scope: "agentDir", code });
  });
  it.each(["primary-file", "parent-file", "parent-link", "dangling-parent-link"])("non-directory chain: %s", (kind) => {
    file(home, NEW);
    const base = join(root, "bad");
    if (kind === "primary-file" || kind === "parent-file") file(root, "bad");
    else symlinkSync(kind === "parent-link" ? dir : join(root, "missing"), base);
    dir = kind === "primary-file" ? base : join(base, "child");
    expect(resolveSettingsLocation(agent())).toMatchObject({
      kind: "unavailable",
      scope: "agentDir",
      reason: "settings-not-directory",
      code: "ENOTDIR",
    });
    expect(resolveSettingsLocation(agent())).not.toEqual(agentLocation(agent()));
  });
  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("preserves primary errno %s instead of inheriting", (code) => {
    file(home, NEW);
    const deps: SettingsFsDeps = {
      lstat: (p) => {
        if (p === join(dir, NEW)) throw errno(code);
        return lstatSync(p);
      },
    };
    expect(resolveSettingsLocation(agent(), deps)).toMatchObject({
      kind: "unavailable",
      scope: "agentDir",
      reason: "settings-io",
      code,
    });
  });
  it("directory-level EACCES is not a missing directory (deterministic even as root)", () => {
    file(home, NEW);
    const deps = {
      lstat: (p: string) => {
        if (p === dir) throw errno("EACCES");
        return lstatSync(p);
      },
    };
    expect(resolveSettingsLocation(agent(), deps)).toMatchObject({
      kind: "unavailable",
      scope: "agentDir",
      code: "EACCES",
    });
    expect(agentLocation(agent(), deps)).toMatchObject({ kind: "new", scope: "inherited" });
  });
  it.each(["EACCES", "EIO"])("readlink failure retains %s and cannot count as conflict/absence", (code) => {
    file(dir, NEW);
    symlinkSync(NEW, join(dir, OLD));
    expect(
      resolveSettingsFile(dir, {
        readlink: () => {
          throw errno(code);
        },
      }),
    ).toMatchObject({ kind: "unavailable", reason: "settings-io", code });
    expect(readlinkSync(join(dir, OLD))).toBe(NEW);
  });
  it.each(["file", "parent-file", "EACCES", "dangling-compat", "unsafe-leaf"])(
    "inherited target errors also fail closed: %s",
    (kind) => {
      if (kind === "file") {
        home = join(root, "homefile");
        file(root, "homefile");
      }
      if (kind === "parent-file") {
        file(root, "homefile");
        home = join(root, "homefile/child");
      }
      if (kind === "dangling-compat") symlinkSync(NEW, join(home, OLD));
      if (kind === "unsafe-leaf") mkdirSync(join(home, NEW));
      const deps =
        kind === "EACCES"
          ? {
              lstat: (p: string) => {
                if (p === join(home, NEW)) throw errno("EACCES");
                return lstatSync(p);
              },
            }
          : {};
      const result = resolveSettingsLocation(agent(), deps);
      expect(result).toMatchObject({ kind: "unavailable", scope: "inherited" });
      if (kind === "EACCES") expect(result).toMatchObject({ code: "EACCES" });
    },
  );
  it("unknown thrown values return fixed EIO, not error text/path", () => {
    const result = resolveSettingsFile(dir, {
      lstat: () => {
        throw new Error("private-body");
      },
    });
    expect(result).toMatchObject({ kind: "unavailable", code: "EIO" });
    expect(JSON.stringify(result)).not.toContain("private-body");
  });
});
