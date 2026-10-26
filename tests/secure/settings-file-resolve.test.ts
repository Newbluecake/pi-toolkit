// settings-rename P1 (plan §3.3, T-SF1/T-SF2): the settings file-name resolution table S0–S7 and the
// agentDir location tiers. ONE table drives both implementations — src/secure/settings-lock.ts and the
// launcher mirror in src/secure/bin/helper.mjs — and they must agree row by row.
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
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
import {
  LEGACY_SETTINGS_FILE_NAME,
  SETTINGS_FILE_NAME,
  SETTINGS_LOCK_FILE_NAME,
  resolveSettingsFile,
  resolveSettingsLocation,
  settingsLockPath,
} from "../../src/secure/settings-lock.js";
import type { AgentDirInfo } from "../../src/core/agent-dir.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(
  pathToFileURL(join(import.meta.dirname, "..", "..", "src", "secure", "bin", "helper.mjs")).href
);

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-file-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NEW = SETTINGS_FILE_NAME;
const OLD = LEGACY_SETTINGS_FILE_NAME;

interface Row {
  id: string;
  build: (dir: string, ext: string) => void;
  /** fields of the resolved state (path as a file name inside dir) */
  expect: Record<string, unknown>;
}

const TABLE: Row[] = [
  { id: "S0 nothing", build: () => undefined, expect: { kind: "none", path: NEW, compatLinkDangling: false } },
  {
    id: "S1 legacy regular file",
    build: (d) => writeFileSync(join(d, OLD), "{}"),
    expect: { kind: "legacy", path: OLD, legacyType: "file" },
  },
  {
    id: "S2 legacy is an external symlink",
    build: (d, ext) => {
      writeFileSync(join(ext, "dot.json"), "{}");
      symlinkSync(join(ext, "dot.json"), join(d, OLD));
    },
    expect: { kind: "legacy", path: OLD, legacyType: "symlink" },
  },
  {
    id: "S3 dangling compat link (relative)",
    build: (d) => symlinkSync(NEW, join(d, OLD)),
    expect: { kind: "none", path: NEW, compatLinkDangling: true },
  },
  {
    id: "S3b dangling compat link (absolute target)",
    build: (d) => symlinkSync(join(d, NEW), join(d, OLD)),
    expect: { kind: "none", path: NEW, compatLinkDangling: true },
  },
  {
    id: "S4 new only",
    build: (d) => writeFileSync(join(d, NEW), "{}"),
    expect: { kind: "new", path: NEW, legacy: "absent" },
  },
  {
    id: "S5 new + relative compat link",
    build: (d) => {
      writeFileSync(join(d, NEW), "{}");
      symlinkSync(NEW, join(d, OLD));
    },
    expect: { kind: "new", path: NEW, legacy: "compat-link" },
  },
  {
    id: "S5b new + absolute compat link",
    build: (d) => {
      writeFileSync(join(d, NEW), "{}");
      symlinkSync(join(d, NEW), join(d, OLD));
    },
    expect: { kind: "new", path: NEW, legacy: "compat-link" },
  },
  {
    id: "S5c new + compat link via an intermediate link (realpath equal)",
    build: (d) => {
      writeFileSync(join(d, NEW), "{}");
      symlinkSync(NEW, join(d, "mid.json"));
      symlinkSync("mid.json", join(d, OLD));
    },
    expect: { kind: "new", path: NEW, legacy: "compat-link" },
  },
  {
    id: "S6a same inode (crash window)",
    build: (d) => {
      writeFileSync(join(d, NEW), "{}");
      linkSync(join(d, NEW), join(d, OLD));
    },
    expect: { kind: "new", path: NEW, legacy: "same-inode" },
  },
  {
    id: "S6b two regular files (legacy newer)",
    build: (d) => {
      writeFileSync(join(d, NEW), "{}");
      writeFileSync(join(d, OLD), "{}");
      utimesSync(join(d, NEW), 1000, 1000);
      utimesSync(join(d, OLD), 2000, 2000);
    },
    expect: { kind: "new", path: NEW, legacy: "conflict", legacyNewer: true },
  },
  {
    id: "S6b two regular files (new newer)",
    build: (d) => {
      writeFileSync(join(d, NEW), "{}");
      writeFileSync(join(d, OLD), "{}");
      utimesSync(join(d, NEW), 2000, 2000);
      utimesSync(join(d, OLD), 1000, 1000);
    },
    expect: { kind: "new", path: NEW, legacy: "conflict", legacyNewer: false },
  },
  {
    id: "S6b new + external legacy symlink",
    build: (d, ext) => {
      writeFileSync(join(ext, "dot.json"), "{}");
      writeFileSync(join(d, NEW), "{}");
      symlinkSync(join(ext, "dot.json"), join(d, OLD));
    },
    expect: { kind: "new", path: NEW, legacy: "conflict" },
  },
  {
    id: "S7 new is a directory",
    build: (d) => mkdirSync(join(d, NEW)),
    expect: { kind: "new", path: NEW, legacy: "absent" },
  },
];

function normalise(state: unknown, dir: string): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  for (const k of ["path", "newPath", "legacyPath"])
    if (typeof s[k] === "string") s[k] = (s[k] as string).replace(`${dir}/`, "");
  return s;
}

describe("T-SF1 resolveSettingsFile S0–S7 (TS and launcher mirror, one table)", () => {
  for (const row of TABLE) {
    it(row.id, () => {
      const dir = join(root, "agent");
      const ext = join(root, "ext");
      mkdirSync(dir, { recursive: true });
      mkdirSync(ext, { recursive: true });
      row.build(dir, ext);
      const ts = normalise(resolveSettingsFile(dir), dir);
      const mjs = normalise(H.resolveSettingsFile(dir), dir);
      expect(ts).toMatchObject(row.expect);
      expect(mjs).toEqual(ts);
      expect(ts.newPath).toBe(NEW);
      expect(ts.legacyPath).toBe(OLD);
    });
  }

  it("a missing directory is S0 (ENOENT/ENOTDIR are 'absent', never thrown)", () => {
    expect(resolveSettingsFile(join(root, "nope")).kind).toBe("none");
    writeFileSync(join(root, "afile"), "");
    expect(resolveSettingsFile(join(root, "afile", "sub")).kind).toBe("none");
    expect(H.resolveSettingsFile(join(root, "afile", "sub")).kind).toBe("none");
  });

  it("injected fs seams are used (no real I/O)", () => {
    const seen: string[] = [];
    const st = resolveSettingsFile("/virtual/agent", {
      lstat: (p) => {
        seen.push(p);
        throw Object.assign(new Error("x"), { code: "ENOENT" });
      },
    });
    expect(st.kind).toBe("none");
    expect(seen).toEqual(["/virtual/agent/pi-toolkit.json", "/virtual/agent/pi-subagent.json"]);
  });

  it("the lock name is fixed (I7) whatever the settings file is called", () => {
    for (const n of [NEW, OLD, "whatever.json"])
      expect(settingsLockPath(join(root, n))).toBe(join(root, SETTINGS_LOCK_FILE_NAME));
    expect(SETTINGS_LOCK_FILE_NAME).toBe(".pi-subagent.json.lock");
    expect(H.SETTINGS_LOCK_NAME).toBe(SETTINGS_LOCK_FILE_NAME);
    expect(H.SETTINGS_FILE_NAME).toBe(NEW);
    expect(H.LEGACY_SETTINGS_FILE_NAME).toBe(OLD);
  });
});

describe("T-SF2 resolveSettingsLocation (default / agentDir / inherited)", () => {
  function agentOf(P: string, Hm: string, source: "default" | "env"): AgentDirInfo {
    return { dir: P, home: Hm, source };
  }
  interface LocRow {
    id: string;
    source: "default" | "env";
    p: (d: string) => void;
    h: (d: string) => void;
    scope: string;
    where: "P" | "H";
    kind: string;
  }
  const put = (d: string, n: string) => writeFileSync(join(d, n), "{}");
  const LOC: LocRow[] = [
    {
      id: "default dir, legacy file",
      source: "default",
      p: (d) => put(d, OLD),
      h: (d) => put(d, OLD),
      scope: "default",
      where: "P",
      kind: "legacy",
    },
    {
      id: "default dir, nothing",
      source: "default",
      p: () => undefined,
      h: () => undefined,
      scope: "default",
      where: "P",
      kind: "none",
    },
    {
      id: "env dir has new file",
      source: "env",
      p: (d) => put(d, NEW),
      h: (d) => put(d, OLD),
      scope: "agentDir",
      where: "P",
      kind: "new",
    },
    {
      id: "env dir has only a legacy file",
      source: "env",
      p: (d) => put(d, OLD),
      h: (d) => put(d, NEW),
      scope: "agentDir",
      where: "P",
      kind: "legacy",
    },
    {
      id: "env dir EMPTY, home has legacy ⇒ inherited",
      source: "env",
      p: () => undefined,
      h: (d) => put(d, OLD),
      scope: "inherited",
      where: "H",
      kind: "legacy",
    },
    {
      id: "env dir EMPTY, home has new ⇒ inherited",
      source: "env",
      p: () => undefined,
      h: (d) => put(d, NEW),
      scope: "inherited",
      where: "H",
      kind: "new",
    },
    {
      id: "env dir EMPTY, home EMPTY ⇒ agentDir (create in P)",
      source: "env",
      p: () => undefined,
      h: () => undefined,
      scope: "agentDir",
      where: "P",
      kind: "none",
    },
    {
      id: "env dir has only a dangling compat link ⇒ stays in P",
      source: "env",
      p: (d) => symlinkSync(NEW, join(d, OLD)),
      h: (d) => put(d, OLD),
      scope: "agentDir",
      where: "P",
      kind: "none",
    },
  ];
  for (const row of LOC) {
    it(row.id, () => {
      const P = join(root, "P");
      const Hm = join(root, "H");
      mkdirSync(P, { recursive: true });
      mkdirSync(Hm, { recursive: true });
      row.p(P);
      row.h(Hm);
      const agent = agentOf(row.source === "default" ? Hm : P, Hm, row.source);
      if (row.source === "default") row.p(Hm); // default: P === H
      const loc = resolveSettingsLocation(agent);
      expect(loc.scope).toBe(row.scope);
      expect(loc.kind).toBe(row.kind);
      expect(loc.path.startsWith(`${row.where === "P" && row.source !== "default" ? P : Hm}/`)).toBe(true);
      expect(JSON.parse(JSON.stringify(H.resolveSettingsLocation(agent)))).toEqual(
        JSON.parse(JSON.stringify({ ...loc, agent })),
      );
    });
  }
});
