// settings-rename P2 (plan §3.3/§3.4/§3.4.1/§3.8 plugin side; T-PL2/T-PL3/T-PL4, T-MG6 plugin half):
// settingsLocation / defaultSettingsPath / prepareSettingsFile / persistSettingOverride /
// loadSettingsFromFile write-back over every initial file state. Sandbox HOME only; file CONTENTS are
// checked structurally and never printed.
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
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  defaultSettingsPath,
  loadSettingsFromFile,
  persistSettingOverride,
  prepareSettingsFile,
  settingsLocation,
  settingsPathNote,
} from "../../src/config/settings.js";
import { computeSecureDomain } from "../../src/secure/domain.js";
import {
  LEGACY_SETTINGS_FILE_NAME as OLD,
  SETTINGS_FILE_NAME as NEW,
  resolveSettingsFile,
  writeSettingsFileAtomic,
} from "../../src/secure/settings-lock.js";
import { SettingsEditorModel, renderSettingsEditor } from "../../src/ui/settings-editor.js";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(new URL("../../src/secure/bin/helper.mjs", import.meta.url).href);

let sandbox: ReturnType<typeof sandboxHome>;
let home: string;
let agent: string;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sandbox = sandboxHome();
  home = realpathSync(sandbox.home);
  agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
  sandbox.restore();
});

const P = (n: string, dir = agent) => join(dir, n);
const seed = {
  budget: { idleMs: 120_000 },
  secure: { vaults: { acme: { dir: "/d/acme", mnt: "/m/acme" } } },
};
const text = JSON.stringify(seed);
const put = (n: string, t = text, dir = agent) => writeFileSync(P(n, dir), t, { mode: 0o600 });
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const lnks = (dir = agent) => readdirSync(dir).filter((n) => n.endsWith(".lnk"));
const warned = () => warn.mock.calls.map((c) => String(c[0])).join("\n");

describe("settingsLocation / defaultSettingsPath", () => {
  it("S0: no file anywhere ⇒ the NEW name in the default dir; scope default", () => {
    expect(defaultSettingsPath()).toBe(P(NEW));
    expect(settingsLocation()).toMatchObject({ kind: "none", scope: "default" });
    expect(settingsPathNote(settingsLocation())).toBeUndefined();
  });
  it("S1: only the legacy file ⇒ that file (migration is prepareSettingsFile's job, never this getter's)", () => {
    put(OLD);
    expect(defaultSettingsPath()).toBe(P(OLD));
    expect(lstatSync(P(OLD)).isFile()).toBe(true);
    expect(existsSync(P(NEW))).toBe(false);
  });
  it("agentDir scope: the variable's directory wins when it holds a settings file", () => {
    const p = join(home, "elsewhere");
    mkdirSync(p);
    put(NEW, "{}", p);
    put(OLD); // H also has one: ignored
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    expect(defaultSettingsPath()).toBe(P(NEW, p));
    const loc = settingsLocation();
    expect(loc.scope).toBe("agentDir");
    expect(settingsPathNote(loc)).toBe("PI_CODING_AGENT_DIR");
  });
  it("inherited scope: empty agentDir + settings in ~/.pi/agent ⇒ read/write H (拍板④)", () => {
    const p = join(home, "elsewhere");
    mkdirSync(p);
    put(OLD);
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    expect(defaultSettingsPath()).toBe(P(OLD));
    expect(settingsPathNote(settingsLocation())).toBe("inherited from ~/.pi/agent");
  });
  it("agentDir scope with nothing anywhere ⇒ create under the agentDir", () => {
    const p = join(home, "elsewhere");
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    expect(defaultSettingsPath()).toBe(P(NEW, p));
    expect(settingsLocation().scope).toBe("agentDir");
  });
});

describe("prepareSettingsFile (the main session's one migration point)", () => {
  it("S1 ⇒ S5: NEW is the original inode, LEGACY a compat symlink; second call is a no-op", () => {
    put(OLD);
    const ino = statSync(P(OLD)).ino;
    const r = prepareSettingsFile();
    expect(r.migration.kind).toBe("migrated");
    expect(r.path).toBe(P(NEW));
    expect(r.notices).toEqual([]);
    expect(r.notified).toBe(false);
    expect(statSync(P(NEW)).ino).toBe(ino);
    expect(readlinkSync(P(OLD))).toBe(NEW);
    expect(readJson(P(OLD)).budget.idleMs).toBe(120_000); // old name reads through
    expect(lnks()).toEqual([]);
    expect(warned()).toContain("settings moved");
    warn.mockClear();
    const again = prepareSettingsFile();
    expect(again.migration).toEqual({ kind: "noop" });
    expect(again.path).toBe(P(NEW));
    expect(warned()).toBe("");
  });

  it("S0 / S4 / S5 touch nothing", () => {
    expect(prepareSettingsFile().migration.kind).toBe("noop");
    expect(readdirSync(agent)).toEqual([]);
    put(NEW);
    symlinkSync(NEW, P(OLD));
    const before = [lstatSync(P(NEW)).ino, lstatSync(P(OLD)).ino];
    expect(prepareSettingsFile().migration.kind).toBe("noop");
    expect([lstatSync(P(NEW)).ino, lstatSync(P(OLD)).ino]).toEqual(before);
  });

  it("S2 (external symlink, e.g. a dotfile manager) is not migrated; the link keeps being the file", () => {
    writeFileSync(join(home, "dot.json"), text);
    symlinkSync(join(home, "dot.json"), P(OLD));
    const r = prepareSettingsFile();
    expect(r.migration.kind).toBe("noop");
    expect(r.path).toBe(P(OLD));
    expect(existsSync(P(NEW))).toBe(false);
  });

  it("S6b: reported once in notices (and warned), NEW wins, nothing is touched", () => {
    put(NEW);
    put(OLD);
    utimesSync(P(OLD), 4_000_000_000, 4_000_000_000); // legacy is the newer file
    const r = prepareSettingsFile();
    expect(r.migration.kind).toBe("conflict");
    expect(r.path).toBe(P(NEW));
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain(P(NEW));
    expect(r.notices[0]).toContain("newer");
    expect(warned()).toContain("settings conflict");
    expect(lstatSync(P(OLD)).isFile()).toBe(true);
  });

  it("S6a (crash window) is healed to S5 without a conflict notice", () => {
    put(NEW);
    linkSync(P(NEW), P(OLD));
    const r = prepareSettingsFile();
    expect(r.migration).toMatchObject({ kind: "migrated", healed: true });
    expect(r.notices).toEqual([]);
    expect(readlinkSync(P(OLD))).toBe(NEW);
  });

  it("no flock binary ⇒ no migration, the legacy name keeps being read, nothing is written", () => {
    put(OLD);
    vi.stubEnv("PATH", join(home, "empty-bin"));
    const r = prepareSettingsFile();
    expect(r.migration).toMatchObject({ kind: "skipped", reason: "no-flock" });
    expect(r.path).toBe(P(OLD));
    expect(existsSync(P(NEW))).toBe(false);
    expect(lstatSync(P(OLD)).isFile()).toBe(true);
    expect(warned()).not.toContain("postponed"); // silent: a missing flock is a normal macOS state
  });

  it("a relative PI_CODING_AGENT_DIR is ignored with a notice and the default location stays", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "rel/dir");
    put(OLD);
    const r = prepareSettingsFile();
    expect(r.location.scope).toBe("default");
    expect(r.notices.join("\n")).toContain("relative");
    expect(warned()).toContain("PI_CODING_AGENT_DIR is relative");
    expect(r.path).toBe(P(NEW)); // migrated in the default dir
  });

  it("inherited: migrates ~/.pi/agent's legacy file, leaves the (empty) agentDir untouched", () => {
    const p = join(home, "elsewhere");
    mkdirSync(p);
    put(OLD);
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    const r = prepareSettingsFile();
    expect(r.location.scope).toBe("inherited");
    expect(r.path).toBe(P(NEW));
    expect(readdirSync(p)).toEqual([]);
  });

  it("agentDir: migrates inside the agentDir, lock lives there, home untouched", () => {
    const p = join(home, "elsewhere");
    mkdirSync(p);
    put(OLD, text, p);
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    const r = prepareSettingsFile();
    expect(r.path).toBe(P(NEW, p));
    expect(readlinkSync(P(OLD, p))).toBe(NEW);
    expect(existsSync(P(".pi-subagent.json.lock", p))).toBe(true);
    expect(readdirSync(agent)).toEqual([]);
  });
});

describe("persistSettingOverride (omitted path resolves inside the lock)", () => {
  it("S5: writes NEW through the new name, the compat link survives and reads the update", () => {
    put(NEW);
    symlinkSync(NEW, P(OLD));
    expect(persistSettingOverride("budget.idleS", 77)).toBeUndefined();
    expect(readJson(P(NEW)).budget.idleS).toBe(77);
    expect(readlinkSync(P(OLD))).toBe(NEW);
    expect(readJson(P(OLD)).budget.idleS).toBe(77);
  });
  it("inherited scope writes ~/.pi/agent; lock file sits next to it", () => {
    const p = join(home, "elsewhere");
    mkdirSync(p);
    put(NEW);
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    expect(persistSettingOverride("budget.idleS", 5)).toBeUndefined();
    expect(readJson(P(NEW)).budget.idleS).toBe(5);
    expect(readdirSync(p)).toEqual([]);
    expect(existsSync(P(".pi-subagent.json.lock"))).toBe(true);
  });
  it("agentDir scope writes the agentDir; lock file sits there", () => {
    const p = join(home, "elsewhere");
    mkdirSync(p);
    put(NEW, "{}", p);
    vi.stubEnv("PI_CODING_AGENT_DIR", p);
    expect(persistSettingOverride("budget.idleS", 6)).toBeUndefined();
    expect(readJson(P(NEW, p)).budget.idleS).toBe(6);
    expect(existsSync(P(".pi-subagent.json.lock", p))).toBe(true);
    expect(existsSync(P(".pi-subagent.json.lock"))).toBe(false);
  });
  it("S0 creates the NEW name (0600)", () => {
    expect(persistSettingOverride("budget.idleS", 9)).toBeUndefined();
    expect(readJson(P(NEW)).budget.idleS).toBe(9);
    expect(statSync(P(NEW)).mode & 0o777).toBe(0o600);
    expect(existsSync(P(OLD))).toBe(false);
  });
  it("a malformed file is reported, not clobbered", () => {
    put(NEW, "{nope");
    const err = persistSettingOverride("budget.idleS", 1);
    expect(err).toContain(P(NEW));
    expect(readFileSync(P(NEW), "utf8")).toBe("{nope");
  });
});

// ── T-MG6 plugin half ───────────────────────────────────────────────────────────────────────

type Writer = "persist-omitted" | "persist-explicit-new" | "ms-to-s";
interface State {
  id: string;
  build: () => void;
  /** writers for which this state is meaningful */
  writers: Writer[];
  /** where the new content must be readable + resulting file-name state */
  after: { path: string; kind: string; legacy?: string; legacyType?: string };
}
const ALL: Writer[] = ["persist-omitted", "persist-explicit-new", "ms-to-s"];
const STATES: State[] = [
  {
    id: "S0 nothing",
    build: () => undefined,
    writers: ["persist-omitted", "persist-explicit-new"], // nothing to rewrite for the ms→s pass
    after: { path: NEW, kind: "new", legacy: "absent" },
  },
  // For S1/S2 an EXPLICIT NEW path bypasses name resolution on purpose (tests/escape hatch), so only the
  // name-resolving writers apply there.
  {
    id: "S1 legacy file",
    build: () => put(OLD),
    writers: ["persist-omitted", "ms-to-s"],
    after: { path: OLD, kind: "legacy", legacyType: "file" },
  },
  {
    id: "S2 external symlink",
    build: () => {
      writeFileSync(join(home, "dot.json"), text);
      symlinkSync(join(home, "dot.json"), P(OLD));
    },
    writers: ["persist-omitted", "ms-to-s"],
    after: { path: OLD, kind: "legacy", legacyType: "symlink" },
  },
  {
    id: "S3 dangling compat link",
    build: () => symlinkSync(NEW, P(OLD)),
    writers: ["persist-omitted", "persist-explicit-new"],
    after: { path: NEW, kind: "new", legacy: "compat-link" },
  },
  { id: "S4 new only", build: () => put(NEW), writers: ALL, after: { path: NEW, kind: "new", legacy: "absent" } },
  {
    id: "S5 new + compat link",
    build: () => {
      put(NEW);
      symlinkSync(NEW, P(OLD));
    },
    writers: ALL,
    after: { path: NEW, kind: "new", legacy: "compat-link" },
  },
  {
    id: "S6a same inode (crash window)",
    build: () => {
      put(NEW);
      linkSync(P(NEW), P(OLD));
    },
    writers: ALL,
    after: { path: NEW, kind: "new", legacy: "compat-link" },
  },
  {
    id: "S6b diverged files (stays S6b)",
    build: () => {
      put(NEW);
      put(OLD, JSON.stringify({ budget: { idleS: 1 } }));
      utimesSync(P(OLD), 5, 5);
    },
    writers: ALL,
    after: { path: NEW, kind: "new", legacy: "conflict" },
  },
];

function write(w: Writer): string | undefined {
  if (w === "persist-omitted") return persistSettingOverride("budget.touchedS", 42);
  if (w === "persist-explicit-new") return persistSettingOverride("budget.touchedS", 42, P(NEW));
  loadSettingsFromFile(defaultSettingsPath());
  return undefined;
}

function expectWritten(w: Writer, path: string): void {
  const j = readJson(path);
  if (w === "ms-to-s") {
    expect(j.budget.idleS).toBe(120); // legacy *Ms key rewritten to seconds
    expect(j.budget.idleMs).toBeUndefined();
  } else {
    expect(j.budget.touchedS).toBe(42);
  }
}

describe("T-MG6 plugin writers over every initial state (never manufacture S6b)", () => {
  for (const s of STATES) {
    for (const w of s.writers) {
      it(`${w}: ${s.id}`, () => {
        s.build();
        expect(write(w)).toBeUndefined();
        const st = resolveSettingsFile(agent);
        expect(st.kind).toBe(s.after.kind);
        if (st.kind === "new") expect(st.legacy).toBe(s.after.legacy);
        if (st.kind === "legacy") expect(st.legacyType).toBe(s.after.legacyType);
        expect(lnks()).toEqual([]);
        // the content is readable at the resolved location (for S2 through the external link)
        const loc = settingsLocation();
        expect(loc.path).toBe(P(s.after.path));
        expectWritten(w, loc.path);
        if (s.id.startsWith("S2")) {
          expect(lstatSync(P(OLD)).isSymbolicLink()).toBe(true); // ms→s / persist keep the dotfile link
          expectWritten(w, join(home, "dot.json"));
        }
        if (st.kind === "new" && st.legacy === "compat-link") {
          expect(readlinkSync(P(OLD))).toBe(NEW);
          if (!s.id.startsWith("S3")) expectWritten(w, P(OLD));
        }
        if (s.id.startsWith("S6b")) {
          // a new-version writer neither repairs nor deepens the conflict: LEGACY is untouched
          expect(readJson(P(OLD))).toEqual({ budget: { idleS: 1 } });
          return;
        }
        // (4) a write touching a file that carries secure.vaults never yields `secure:invalid`, from either reader
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
    }
  }

  it("S6a ⇒ S5 even when the writer is an ms→s write-back and the heal comes first (no 'changed while migrating')", () => {
    put(NEW);
    linkSync(P(NEW), P(OLD));
    loadSettingsFromFile(P(NEW));
    expect(warned()).not.toContain("failed to write");
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "new", legacy: "compat-link" });
  });
});

describe("T-PL4 downgrade simulation: an old-version writer goes through the compat link", () => {
  it("writeSettingsFileAtomic(LEGACY) updates NEW and keeps the link; plain writeFileSync(LEGACY) follows it", () => {
    put(NEW);
    symlinkSync(NEW, P(OLD));
    writeSettingsFileAtomic(P(OLD), JSON.stringify({ via: "atomic" }));
    expect(readJson(P(NEW)).via).toBe("atomic");
    expect(lstatSync(P(OLD)).isSymbolicLink()).toBe(true);
    writeFileSync(P(OLD), JSON.stringify({ via: "plain" }));
    expect(readJson(P(NEW)).via).toBe("plain");
    expect(lstatSync(P(OLD)).isSymbolicLink()).toBe(true);
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "new", legacy: "compat-link" });
  });
});

describe("editor title names a non-default settings source", () => {
  const title = (pathNote: string | undefined): string => {
    const model = new SettingsEditorModel({
      current: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      persist: () => undefined,
      path: "/x/pi-toolkit.json",
      pathNote,
    });
    return renderSettingsEditor(model.snapshot(), { width: 140 }).find((l) => l.includes("Extension settings"))!;
  };
  it("default scope: title is unchanged (no suffix)", () => {
    expect(title(undefined)).toContain("Extension settings — /x/pi-toolkit.json");
    expect(title(undefined)).not.toContain("(");
  });
  it("inherited / agentDir scopes append the note", () => {
    expect(title(settingsPathNote({ ...settingsLocation(), scope: "inherited" }))).toContain(
      "/x/pi-toolkit.json (inherited from ~/.pi/agent)",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "elsewhere"));
    expect(title(settingsPathNote(settingsLocation()))).toContain("/x/pi-toolkit.json (PI_CODING_AGENT_DIR)");
  });
});
