// plan §6.7.1 — rotate-intent 原子写/三态读取/推进/清理（C8）。

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advanceRotateIntentSync,
  cleanupRotateIntentTemps,
  newRotateIntentId,
  readRotateIntentSync,
  removeRotateIntentSync,
  writeRotateIntentSync,
  type RotateIntent,
} from "../../../src/web-hub/protocol/rotate-intent.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rotate-intent-"));
  file = join(dir, "rotate.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function intent(over: Partial<RotateIntent> = {}): RotateIntent {
  return { v: 1, id: newRotateIntentId(), at: Date.now(), by: "agent", pid: process.pid, phase: "intent", ...over };
}

describe("newRotateIntentId", () => {
  it("returns a 32-hex-char id (16 bytes)", () => {
    const id = newRotateIntentId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newRotateIntentId()));
    expect(ids.size).toBe(20);
  });
});

describe("readRotateIntentSync: three-state read", () => {
  it("absent: file does not exist", () => {
    expect(readRotateIntentSync(file)).toEqual({ state: "absent" });
  });

  it("present: valid intent round-trips", () => {
    const i = intent();
    writeRotateIntentSync(file, i);
    expect(readRotateIntentSync(file)).toEqual({ state: "present", intent: i });
  });

  it("unreadable E_NOT_REGULAR: a directory at the path", () => {
    // Reuse `file` as a directory instead of a regular file.
    rmSync(file, { force: true });
    const asDir = join(dir, "as-dir.json");
    mkdirSync(asDir);
    expect(readRotateIntentSync(asDir)).toEqual({ state: "unreadable", code: "E_NOT_REGULAR" });
  });

  it("unreadable E_NOT_REGULAR: a symlink at the path", () => {
    const target = join(dir, "target.json");
    writeFileSync(target, JSON.stringify(intent()));
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(readRotateIntentSync(link)).toEqual({ state: "unreadable", code: "E_NOT_REGULAR" });
  });

  it("unreadable E_PARSE: corrupt JSON content", () => {
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(readRotateIntentSync(file)).toEqual({ state: "unreadable", code: "E_PARSE" });
  });

  it("unreadable E_PARSE: valid JSON but fails schema validation", () => {
    writeFileSync(file, JSON.stringify({ v: 1, id: "not-hex", at: 1, by: "agent", pid: 1, phase: "intent" }), {
      mode: 0o600,
    });
    expect(readRotateIntentSync(file)).toEqual({ state: "unreadable", code: "E_PARSE" });
  });

  it("unreadable with a non-ENOENT fs error code surfaces that code", () => {
    // lstat a path whose parent directory doesn't exist ⇒ ENOENT on the parent, not the file itself,
    // which the implementation still classifies as absent (lstat ENOENT is absent regardless of cause).
    const missingParent = join(dir, "no-such-subdir", "rotate.json");
    expect(readRotateIntentSync(missingParent)).toEqual({ state: "absent" });
  });
});

describe("writeRotateIntentSync: atomic write", () => {
  it("does not leave a .tmp file behind on success", () => {
    writeRotateIntentSync(file, intent());
    const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("overwrite replaces content atomically (readers never see a half-written file)", () => {
    const first = intent({ phase: "intent" });
    writeRotateIntentSync(file, first);
    const second = { ...first, phase: "token-written" as const };
    writeRotateIntentSync(file, second);
    expect(readRotateIntentSync(file)).toEqual({ state: "present", intent: second });
  });

  it("writes with 0600 permissions", () => {
    writeRotateIntentSync(file, intent());
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("cleanupRotateIntentTemps", () => {
  it("removes stale <file>.<pid>.<hex>.tmp leftovers from a crashed writer", () => {
    writeFileSync(`${file}.12345.deadbeef.tmp`, "stale", { mode: 0o600 });
    writeFileSync(`${file}.99999.cafebabe.tmp`, "stale2", { mode: 0o600 });
    cleanupRotateIntentTemps(file);
    const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("does not touch the real intent file or unrelated files", () => {
    writeRotateIntentSync(file, intent());
    writeFileSync(join(dir, "unrelated.json"), "{}");
    writeFileSync(`${file}.1.aaaa.tmp`, "stale", { mode: 0o600 });
    cleanupRotateIntentTemps(file);
    expect(readRotateIntentSync(file).state).toBe("present");
    expect(readFileSync(join(dir, "unrelated.json"), "utf8")).toBe("{}");
  });

  it("is a no-op when the state directory does not exist yet", () => {
    const nowhere = join(dir, "does-not-exist", "rotate.json");
    expect(() => cleanupRotateIntentTemps(nowhere)).not.toThrow();
  });
});

describe("advanceRotateIntentSync", () => {
  it("advances phase intent → token-written and persists it", () => {
    const i = intent({ phase: "intent" });
    writeRotateIntentSync(file, i);
    const advanced = advanceRotateIntentSync(file, i, "token-written");
    expect(advanced.phase).toBe("token-written");
    expect(advanced.id).toBe(i.id);
    expect(readRotateIntentSync(file)).toEqual({ state: "present", intent: advanced });
  });

  it("preserves all other fields (id/at/by/pid) unchanged", () => {
    const i = intent({ phase: "intent", by: "hub" });
    const advanced = advanceRotateIntentSync(file, i, "token-written");
    expect(advanced).toEqual({ ...i, phase: "token-written" });
  });
});

describe("removeRotateIntentSync", () => {
  it("deletes the intent file", () => {
    writeRotateIntentSync(file, intent());
    removeRotateIntentSync(file);
    expect(readRotateIntentSync(file)).toEqual({ state: "absent" });
  });

  it("is idempotent (removing an already-absent file does not throw)", () => {
    expect(() => removeRotateIntentSync(file)).not.toThrow();
    expect(() => removeRotateIntentSync(file)).not.toThrow();
  });
});
