/**
 * #39 P3a hub-slot tests: effective-path precedence (same formula as wireWebHub, via the
 * REAL resolveHubPaths), read-only identity matrix, and the no-read/no-mkdir guarantees.
 */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkHubSlot,
  defaultIo,
  hubMemoryRoot,
  parseHubNamespace,
  resolveHubSlot,
  type HubSlotIo,
} from "../../../src/memory/scopes/hub-slot.js";

const uid = process.getuid?.() ?? 0;
const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-slot-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Counting wrapper over the REAL io (every call really hits the fs). */
const counting = (io: HubSlotIo = defaultIo) => {
  const counts = { inspect: 0, stat: 0, realpath: 0, read: 0 };
  return {
    counts,
    io: {
      inspectDir: (p: string) => {
        counts.inspect++;
        return io.inspectDir(p);
      },
      statFile: (p: string) => {
        counts.stat++;
        return io.statFile(p);
      },
      realpath: (p: string) => {
        counts.realpath++;
        return io.realpath(p);
      },
      readUtf8File: (p: string) => {
        counts.read++;
        return io.readUtf8File(p);
      },
    } satisfies HubSlotIo,
  };
};

describe("resolveHubSlot precedence (mirrors web-hub/agent/index.ts:610-618)", () => {
  it("paths override wins over launchHome/HOME and cwd never participates", () => {
    const base = tmp();
    for (const cwd of [join(base, "a"), join(base, "b"), join(base, "y")]) {
      mkdirSync(cwd, { recursive: true });
      process.chdir(cwd); // same slot regardless of cwd (task: 不把 cwd 拼进 global 槽)
      const slot = resolveHubSlot({
        paths: { stateDir: "/tmp/override/state" },
        launchHome: "/tmp/launch",
        env: { HOME: "/tmp/env" },
        getuid: () => 1234,
      });
      expect(slot).toEqual({ effectiveStateDir: "/tmp/override/state", uid: 1234, source: "web-hub" });
    }
    process.chdir(base);
  });

  it("launchHome beats HOME; empty HOME falls back to homedir(); default-slot otherwise", () => {
    expect(
      resolveHubSlot({ launchHome: "/tmp/launch", env: { HOME: "/tmp/env" }, getuid: () => 7 }).effectiveStateDir,
    ).toBe("/tmp/launch/.pi/agent/web-hub");
    expect(resolveHubSlot({ env: { HOME: "/tmp/env" }, getuid: () => 7 }).effectiveStateDir).toBe(
      "/tmp/env/.pi/agent/web-hub",
    );
    expect(resolveHubSlot({ env: { HOME: "" }, homedir: () => "/tmp/fallback", getuid: () => 7 })).toEqual({
      effectiveStateDir: "/tmp/fallback/.pi/agent/web-hub",
      uid: 7,
      source: "default-slot",
    });
  });

  it("two different stateDir overrides are two different slots; same inputs one slot", () => {
    const a = resolveHubSlot({ paths: { stateDir: "/tmp/one" }, getuid: () => 9 });
    const b = resolveHubSlot({ paths: { stateDir: "/tmp/two" }, getuid: () => 9 });
    expect(hubMemoryRoot(a)).not.toBe(hubMemoryRoot(b));
    expect(hubMemoryRoot(a)).toBe(join("/tmp/one", "hub-memory"));
    expect(resolveHubSlot({ launchHome: "/tmp/h", env: {}, getuid: () => 9 }).effectiveStateDir).toBe(
      resolveHubSlot({ launchHome: "/tmp/h", env: {}, getuid: () => 9 }).effectiveStateDir,
    );
  });
});

describe("checkHubSlot (pure read-only)", () => {
  it("missing everything ⇒ absent, and reads NOTHING beyond lstat", () => {
    const base = tmp();
    const slot = { effectiveStateDir: join(base, "web-hub"), uid };
    const wrap = counting();
    expect(checkHubSlot(slot, { io: wrap.io })).toBe("absent");
    expect(wrap.counts).toEqual({ inspect: 1, stat: 0, realpath: 0, read: 0 });
  });

  it("a symlinked stateDir/hub-memory is refused as not-dir (real symlink, no fakes)", () => {
    const base = tmp();
    mkdirSync(join(base, "real-hub"), { recursive: true, mode: 0o700 });
    symlinkSync(join(base, "real-hub"), join(base, "web-hub"));
    expect(checkHubSlot({ effectiveStateDir: join(base, "web-hub"), uid })).toEqual({
      inert: "state-dir-not-dir",
    });
    const state = join(base, "s2");
    mkdirSync(join(state, "actual"), { recursive: true, mode: 0o700 });
    symlinkSync(join(state, "actual"), join(state, "hub-memory"));
    mkdirSync(state, { recursive: true, mode: 0o700 });
    expect(checkHubSlot({ effectiveStateDir: state, uid })).toEqual({ inert: "hub-memory-not-dir" });
  });

  it("empty hub-memory ⇒ absent; half states (namespace XOR blocks) ⇒ inert", () => {
    const base = tmp();
    const state = join(base, "web-hub");
    mkdirSync(join(state, "hub-memory"), { recursive: true, mode: 0o700 });
    const slot = { effectiveStateDir: state, uid };
    expect(checkHubSlot(slot)).toBe("absent");
    mkdirSync(join(state, "hub-memory", "blocks"), { mode: 0o700 });
    expect(checkHubSlot(slot)).toEqual({ inert: "namespace-missing" });
    rmSync(join(state, "hub-memory", "blocks"), { recursive: true });
    writeFileSync(join(state, "hub-memory", "namespace.json"), "{}", { mode: 0o600 });
    expect(checkHubSlot(slot)).toEqual({ inert: "blocks-missing" });
  });

  it("a valid namespace ⇒ ok; identity/host mismatch ⇒ inert (fake identity, real files)", () => {
    const base = tmp();
    const state = join(base, "web-hub");
    const root = join(state, "hub-memory");
    mkdirSync(join(root, "blocks"), { recursive: true, mode: 0o700 });
    const st = defaultIo.inspectDir(state);
    expect(st).not.toBeUndefined();
    expect(st).not.toBe("not-dir");
    const identity = st as { dev: number; ino: number };
    const ns = {
      v: 1,
      uid,
      stateDirReal: defaultIo.realpath(state),
      stateDev: identity.dev,
      stateIno: identity.ino,
      host: "aaaaaaaaaaaaaaaa",
      createdAt: "2026-11-07T09:00:00.000Z",
    };
    writeFileSync(join(root, "namespace.json"), JSON.stringify(ns), { mode: 0o600 });
    expect(checkHubSlot({ effectiveStateDir: state, uid }, { expectedHost: "aaaaaaaaaaaaaaaa" })).toBe("ok");
    expect(checkHubSlot({ effectiveStateDir: state, uid }, { expectedHost: "bbbbbbbbbbbbbbbb" })).toEqual({
      inert: "host-mismatch",
    });
    // A foreign uid is caught by the stateDir OWNERSHIP policy before the namespace compare.
    // Foreign uid via the namespace stamp (directory uid/mode is the documented safe-fs gap).
    const nsForeign = { ...ns, uid: uid + 1 };
    writeFileSync(join(root, "namespace.json"), JSON.stringify(nsForeign), { mode: 0o600 });
    expect(checkHubSlot({ effectiveStateDir: state, uid }, { expectedHost: "aaaaaaaaaaaaaaaa" })).toEqual({
      inert: "namespace-uid",
    });
    writeFileSync(join(root, "namespace.json"), JSON.stringify(ns), { mode: 0o600 });
  });

  it.each([0o755, 0o777])(
    "rejects real broad private-directory mode %o, even with a forged valid namespace",
    (mode) => {
      const state = join(tmp(), "state");
      const root = join(state, "hub-memory");
      mkdirSync(join(root, "blocks"), { recursive: true, mode: 0o700 });
      const st = defaultIo.inspectDir(state);
      if (!st || st === "not-dir") throw new Error("missing real state");
      const ns = {
        v: 1,
        uid,
        stateDirReal: defaultIo.realpath(state),
        stateDev: st.dev,
        stateIno: st.ino,
        host: "aaaaaaaaaaaaaaaa",
        createdAt: "2026-11-07T09:00:00.000Z",
      };
      writeFileSync(join(root, "namespace.json"), JSON.stringify(ns), { mode: 0o600 });
      // stateDir permissions are NOT upgraded or constrained by memory.
      chmodSync(state, mode);
      expect(checkHubSlot({ effectiveStateDir: state, uid })).toBe("ok");
      for (const path of [root, join(root, "blocks")]) {
        chmodSync(path, mode);
        expect(checkHubSlot({ effectiveStateDir: state, uid })).toEqual({
          inert: path === root ? "hub-memory-security" : "blocks-security",
        });
        chmodSync(path, 0o700);
      }
      for (const path of [state, root, join(root, "blocks")]) {
        const io: HubSlotIo = {
          ...defaultIo,
          inspectDir(p) {
            const actual = defaultIo.inspectDir(p);
            return p === path && actual && actual !== "not-dir" ? { ...actual, uid: uid + 1 } : actual;
          },
        };
        expect(checkHubSlot({ effectiveStateDir: state, uid }, { io })).toEqual({
          inert: path === state ? "state-dir-security" : path === root ? "hub-memory-security" : "blocks-security",
        });
      }
      const missingMetadata: HubSlotIo = {
        ...defaultIo,
        inspectDir(p) {
          const actual = defaultIo.inspectDir(p);
          return actual && actual !== "not-dir" ? ({ dev: actual.dev, ino: actual.ino } as typeof actual) : actual;
        },
      };
      expect(checkHubSlot({ effectiveStateDir: state, uid }, { io: missingMetadata })).toEqual({
        inert: "state-dir-security",
      });
      rmSync(join(root, "blocks"), { recursive: true });
      symlinkSync(tmp(), join(root, "blocks"));
      expect(checkHubSlot({ effectiveStateDir: state, uid })).toEqual({ inert: "blocks-not-dir" });
    },
  );

  it("parseHubNamespace rejects corrupt/unknown shapes without throwing", () => {
    expect(parseHubNamespace("not json")).toBeUndefined();
    expect(parseHubNamespace("[]")).toBeUndefined();
    expect(parseHubNamespace(JSON.stringify({ v: 2 }))).toBeUndefined();
    const base = tmp();
    mkdirSync(join(base, "web-hub", "hub-memory", "blocks"), { recursive: true, mode: 0o700 });
    chmodSync(join(base, "web-hub"), 0o700);
    writeFileSync(
      join(base, "web-hub", "hub-memory", "namespace.json"),
      JSON.stringify({
        v: 1,
        uid,
        stateDirReal: "/x",
        stateDev: 1,
        stateIno: 2,
        host: "zz",
        createdAt: "yesterday",
      }),
      { mode: 0o600 },
    );
    expect(checkHubSlot({ effectiveStateDir: join(base, "web-hub"), uid })).toEqual({ inert: "namespace-corrupt" });
  });
});
