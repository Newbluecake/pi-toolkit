/**
 * web-hub-spawn default-model plan §3.1: unit acceptance for `hub/spawn/prefs.ts` — the
 * hub-wide 「新建会话默认模型」 single-value preference file.
 *
 * Two layers, mirroring the store suites' style:
 *   - real-fs tests in a real tmpdir (load discipline: missing/symlink/dir/foreign-uid/oversize/
 *     bad JSON/bad model ⇒ null + file untouched; mode repair; tmp-residue sweep incl. the
 *     non-regular residue that must NOT be unlinked; set() atomicity, 0600, failure isolation);
 *   - injected-fs tests for the failure seams real fs cannot produce on demand (wx collision,
 *     write/rename throw ⇒ memory unchanged, tmp unlinked, code surfaced; mode re-check failing
 *     even after the chmod retry).
 *
 * The createSpawnPrefs/real-fs split also pins the「warn 一次」 behavior indirectly: every
 * load-anomaly case leaves the file exactly as it found it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpawnPrefs, type PrefsFs } from "../../../../src/web-hub/hub/spawn/prefs.js";
import { webHubSpawnFiles } from "../../../../src/web-hub/protocol/paths.js";
import { memLog } from "../helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pwh-prefs-"));
  mkdirSync(join(dir, "state"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const file = (): string => webHubSpawnFiles(join(dir, "state")).prefsJson;
const mk = (): ReturnType<typeof createSpawnPrefs> => createSpawnPrefs({ file: file(), log: memLog() });

function seedRaw(content: string, mode = 0o600): void {
  writeFileSync(file(), content, { mode });
}

describe("load discipline (real fs)", () => {
  it("missing file ⇒ null (fresh state dir — silent, no warn, no file created)", () => {
    const log = memLog();
    const p = createSpawnPrefs({ file: file(), log });
    expect(p.get()).toBe(null);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  it("valid file loads; null defaultModel loads as null", () => {
    seedRaw(JSON.stringify({ v: 1, defaultModel: "anthropic/claude-opus-4-5" }));
    expect(mk().get()).toBe("anthropic/claude-opus-4-5");
    seedRaw(JSON.stringify({ v: 1, defaultModel: null }));
    expect(mk().get()).toBe(null);
  });

  it.each([
    ["symlink", () => symlinkSync("/etc/passwd", file())],
    ["directory", () => mkdirSync(file())],
    ["bad JSON", () => seedRaw("{nope")],
    ["wrong version", () => seedRaw(JSON.stringify({ v: 2, defaultModel: null }))],
    ["invalid model ref", () => seedRaw(JSON.stringify({ v: 1, defaultModel: "no-slash" }))],
    ["non-string defaultModel", () => seedRaw(JSON.stringify({ v: 1, defaultModel: 7 }))],
  ])("%s ⇒ null, file left untouched, warned once", (_name, plant) => {
    plant();
    const log = memLog();
    const p = createSpawnPrefs({ file: file(), log });
    expect(p.get()).toBe(null);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
    // untouched: a symlink still dangles at its target, a dir still exists, content is intact
    expect(() => statSync(file())).not.toThrow();
    if (_name === "wrong version" || _name === "invalid model ref" || _name === "non-string defaultModel") {
      expect(readFileSync(file(), "utf8")).toContain("defaultModel");
    } else if (_name === "bad JSON") {
      expect(readFileSync(file(), "utf8")).toBe("{nope");
    }
  });

  it("foreign uid ⇒ null + untouched (uid seam)", () => {
    seedRaw(JSON.stringify({ v: 1, defaultModel: "p1/m" }));
    const p = createSpawnPrefs({ file: file(), log: memLog(), getuid: () => 12345 });
    expect(p.get()).toBe(null);
  });

  it("oversize (>4 KiB) ⇒ null + untouched", () => {
    seedRaw(JSON.stringify({ v: 1, defaultModel: `x/${"a".repeat(5000)}` }));
    expect(mk().get()).toBe(null);
    expect(statSync(file()).size).toBeGreaterThan(4096);
  });

  it("mode ≠ 0600 ⇒ loads AND gets chmod'd back (best effort)", () => {
    seedRaw(JSON.stringify({ v: 1, defaultModel: "p1/m" }), 0o644);
    const p = mk();
    expect(p.get()).toBe("p1/m");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("tmp residue is swept at load — regular files only", () => {
    const f = file();
    writeFileSync(`${f}.tmp-abc123`, "partial", { mode: 0o600 });
    writeFileSync(`${f}.tmp-def456`, "partial", { mode: 0o600 });
    mkdirSync(`${f}.tmp-dir`);
    const p = mk();
    expect(p.get()).toBe(null);
    expect(statSync(`${f}.tmp-abc123`, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(`${f}.tmp-def456`, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(`${f}.tmp-dir`, { throwIfNoEntry: false })).toBeDefined(); // non-regular: never touched
    rmSync(`${f}.tmp-dir`, { recursive: true });
  });
});

describe("set (real fs)", () => {
  it("full overwrite through tmp+rename, final mode 0600, memory updated only on success", () => {
    const p = mk();
    expect(p.set("p1/m")).toEqual({ ok: true });
    expect(p.get()).toBe("p1/m");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ v: 1, defaultModel: "p1/m" });
    // clear
    expect(p.set(null)).toEqual({ ok: true });
    expect(p.get()).toBe(null);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ v: 1, defaultModel: null });
    // no residue left behind
    expect(statSync(`${file()}.tmp-nope`, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("a second instance (next hub boot) reads what the first wrote", () => {
    const p = mk();
    p.set("openrouter/openai/gpt-4o:extended");
    expect(mk().get()).toBe("openrouter/openai/gpt-4o:extended");
  });
});

describe("set failure seams (injected fs)", () => {
  function plant(over: Partial<PrefsFs>): PrefsFs {
    // a real-file-backed base so untouched ops behave normally
    return over;
  }

  it("wx collision (EEXIST) ⇒ {ok:false}, memory unchanged, no rename, tmp not ours to lose", () => {
    const p = createSpawnPrefs({
      file: file(),
      log: memLog(),
      fs: plant({
        openSync: () => {
          const err = new Error("exists");
          (err as { code?: string }).code = "EEXIST";
          throw err;
        },
      }),
    });
    const r = p.set("p1/m");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EEXIST");
    expect(p.get()).toBe(null);
  });

  it("writeSync throw ⇒ tmp unlinked, memory unchanged, code surfaced", () => {
    const unlinks: string[] = [];
    const p = createSpawnPrefs({
      file: file(),
      log: memLog(),
      fs: plant({
        writeSync: () => {
          throw new Error("nospc");
        },
        unlinkSync: (path) => unlinks.push(path),
      }),
    });
    const r = p.set("p1/m");
    expect(r.ok).toBe(false);
    expect(p.get()).toBe(null);
    expect(unlinks).toHaveLength(1);
    expect(unlinks[0]).toContain(".tmp-");
  });

  it("renameSync throw ⇒ tmp unlinked, memory unchanged", () => {
    const unlinks: string[] = [];
    const p = createSpawnPrefs({
      file: file(),
      log: memLog(),
      fs: plant({
        renameSync: () => {
          const err = new Error("xdev");
          (err as { code?: string }).code = "EXDEV";
          throw err;
        },
        unlinkSync: (path) => unlinks.push(path),
      }),
    });
    expect(p.set("p1/m").ok).toBe(false);
    expect(p.get()).toBe(null);
    expect(unlinks).toHaveLength(1);
  });

  it("post-rename mode re-check failing even after the chmod retry ⇒ failure, memory unchanged", () => {
    // lstat on the RENAMED file always reports 0644-ish: chmod retry "succeeds" but the second
    // lstat still disagrees ⇒ the whole set is refused.
    const p = createSpawnPrefs({
      file: file(),
      log: memLog(),
      fs: plant({
        lstatSync: (path) => {
          if (path === file()) return { isFile: () => true, size: 32, uid: process.getuid?.() ?? 0, mode: 0o644 };
          return { isFile: () => true, size: 0, uid: process.getuid?.() ?? 0, mode: 0o600 };
        },
      }),
    });
    expect(p.set("p1/m").ok).toBe(false);
    expect(p.get()).toBe(null);
  });
});
