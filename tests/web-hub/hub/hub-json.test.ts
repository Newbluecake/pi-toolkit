import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import { createHubJsonWriter, type HubRecord } from "../../../src/web-hub/hub/hub-json.js";
import { memLog } from "./helpers.js";

function tmpFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wh-hubjson-"));
  return { file: join(dir, "hub.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseRecord(over: Partial<HubRecord> = {}): HubRecord {
  return {
    pid: process.pid,
    nonce: "n1",
    version: "1.2.3",
    buildId: "1.2.3@abc",
    proto: PROTO,
    socket: "/tmp/x/hub.sock",
    port: 4242,
    startedAt: 1000,
    ...over,
  };
}

describe("createHubJsonWriter (plan §1.4.2)", () => {
  it("write() creates a 0600 file with the exact record", () => {
    const { file, cleanup } = tmpFile();
    try {
      const w = createHubJsonWriter(file, memLog());
      w.write(baseRecord());
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(baseRecord());
      expect(w.current()).toEqual(baseRecord());
    } finally {
      cleanup();
    }
  });

  it("patchLan() after write() merges lan and re-writes to disk", () => {
    const { file, cleanup } = tmpFile();
    try {
      const w = createHubJsonWriter(file, memLog());
      w.write(baseRecord({ lan: { state: "starting" } }));
      w.patchLan({ state: "on", port: 7879, hosts: ["192.168.1.5"], omitted: [], warnings: [] });
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as HubRecord;
      expect(onDisk.lan).toEqual({ state: "on", port: 7879, hosts: ["192.168.1.5"], omitted: [], warnings: [] });
      expect(onDisk.pid).toBe(process.pid); // other fields untouched
      expect(w.current()?.lan).toEqual(onDisk.lan);
    } finally {
      cleanup();
    }
  });

  it("patchLan() before the first write() only updates memory (no file created)", () => {
    const { file, cleanup } = tmpFile();
    try {
      const w = createHubJsonWriter(file, memLog());
      w.patchLan({ state: "off", reason: "bad-config", detail: "x" });
      expect(existsSync(file)).toBe(false);
      expect(w.current()).toBeUndefined(); // no base record to merge into yet
    } finally {
      cleanup();
    }
  });

  it("multiple patchLan() calls each re-write the merged record", () => {
    const { file, cleanup } = tmpFile();
    try {
      const w = createHubJsonWriter(file, memLog());
      w.write(baseRecord());
      w.patchLan({ state: "starting" });
      w.patchLan({ state: "off", reason: "timeout" });
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as HubRecord;
      expect(onDisk.lan).toEqual({ state: "off", reason: "timeout" });
    } finally {
      cleanup();
    }
  });

  it("write() failures are only logged, never thrown", () => {
    const { file, cleanup } = tmpFile();
    try {
      // Point at a path whose parent doesn't exist ⇒ ENOENT on the tmp-file write.
      const bad = join(file, "nested", "hub.json");
      const log = memLog();
      const w = createHubJsonWriter(bad, log);
      expect(() => w.write(baseRecord())).not.toThrow();
      expect(log.lines.some((l) => l.level === "error" && l.msg.includes("hub.json write failed"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("removeIfOurs() deletes the file only when its pid matches this process", () => {
    const { file, cleanup } = tmpFile();
    try {
      const w = createHubJsonWriter(file, memLog());
      w.write(baseRecord());
      w.removeIfOurs();
      expect(existsSync(file)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("removeIfOurs() leaves a foreign-pid file untouched", () => {
    const { file, cleanup } = tmpFile();
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid + 1 }));
      const w = createHubJsonWriter(file, memLog());
      w.removeIfOurs();
      expect(existsSync(file)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("removeIfOurs() on a missing/corrupt file does not throw", () => {
    const { file, cleanup } = tmpFile();
    try {
      const w = createHubJsonWriter(file, memLog());
      expect(() => w.removeIfOurs()).not.toThrow();
      writeFileSync(file, "not json");
      expect(() => w.removeIfOurs()).not.toThrow();
    } finally {
      cleanup();
    }
  });
});
