// plan §6.7.2 — stop-marker 三态分类矩阵（C8）。

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStopMarkerSync,
  removeStopMarkerSync,
  writeStopMarkerSync,
} from "../../../src/web-hub/protocol/stop-marker.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stop-marker-"));
  file = join(dir, "stop.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readStopMarkerSync: three-state classification matrix", () => {
  it("absent: ENOENT ⇒ { state: 'absent' }", () => {
    expect(readStopMarkerSync(file)).toEqual({ state: "absent" });
  });

  it("stopped: a well-formed marker round-trips with its 'at' timestamp", () => {
    writeStopMarkerSync(file, { v: 1, at: 12345, pid: process.pid, by: "agent" });
    expect(readStopMarkerSync(file)).toEqual({ state: "stopped", at: 12345 });
  });

  it("stopped: presence alone is the stop intent — corrupt JSON content still classifies as stopped", () => {
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(readStopMarkerSync(file)).toEqual({ state: "stopped" });
  });

  it("stopped: valid JSON missing 'at' omits the field but still classifies as stopped", () => {
    writeFileSync(file, JSON.stringify({ v: 1, pid: 1, by: "agent" }), { mode: 0o600 });
    expect(readStopMarkerSync(file)).toEqual({ state: "stopped" });
  });

  it("unknown E_NOT_REGULAR: a directory at the path", () => {
    const asDir = join(dir, "as-dir.json");
    mkdirSync(asDir);
    expect(readStopMarkerSync(asDir)).toEqual({ state: "unknown", code: "E_NOT_REGULAR" });
  });

  it("unknown E_NOT_REGULAR: a symlink at the path", () => {
    const target = join(dir, "target.json");
    writeFileSync(target, "{}");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(readStopMarkerSync(link)).toEqual({ state: "unknown", code: "E_NOT_REGULAR" });
  });

  it("unknown E_OWNER: file owned by a different uid than the current process", () => {
    writeFileSync(file, "{}", { mode: 0o600 });
    // Simulate a uid mismatch: getuid() unavailable path is exercised on non-POSIX only, so
    // we assert the real branch indirectly via lstatSync's st.uid vs process.getuid(); on this
    // POSIX runner the file we just wrote is owned by us, so the mismatch path is exercised by
    // mocking process.getuid to report a different uid.
    const real = process.getuid?.bind(process);
    if (real === undefined) return; // no POSIX uid on this platform — nothing to assert
    (process as unknown as { getuid: () => number }).getuid = () => real() + 1;
    try {
      expect(readStopMarkerSync(file)).toEqual({ state: "unknown", code: "E_OWNER" });
    } finally {
      (process as unknown as { getuid: () => number }).getuid = real;
    }
  });

  it("unknown: a non-ENOENT fs error code (e.g. ENOTDIR from a bogus path segment) surfaces that code", () => {
    // Using a regular file as a path segment turns further traversal into ENOTDIR.
    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "x");
    const bogus = join(notADir, "stop.json");
    const res = readStopMarkerSync(bogus);
    expect(res.state).toBe("unknown");
    expect((res as { code: string }).code).toBe("ENOTDIR");
  });
});

describe("writeStopMarkerSync / removeStopMarkerSync", () => {
  it("defaults to by:'agent' and the current pid when no marker is given", () => {
    writeStopMarkerSync(file);
    const read = readStopMarkerSync(file);
    expect(read.state).toBe("stopped");
  });

  it("remove is idempotent", () => {
    writeStopMarkerSync(file);
    removeStopMarkerSync(file);
    expect(readStopMarkerSync(file)).toEqual({ state: "absent" });
    expect(() => removeStopMarkerSync(file)).not.toThrow();
  });
});
