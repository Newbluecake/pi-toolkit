import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  readlinkSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  renameSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import {
  normalizeTerminalPolicy,
  TERMINAL_POLICY_MAX_BYTES,
  type TerminalPolicyFs,
} from "../../../../src/web-hub/hub/terminal/policy.js";
import { config, tmpDirs } from "../helpers.js";
const tmp = tmpDirs();
afterEach(() => tmp.cleanup());
const limits = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const realFs: TerminalPolicyFs = { openSync, closeSync, fstatSync, lstatSync, readSync, readlinkSync };
function fixture() {
  const home = tmp.make("wh-policy-");
  const dir = join(home, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pi-toolkit.json");
  const env: Record<string, string | undefined> = { PI_WEBHUB_TERMINAL_SOURCE: "plain" };
  return {
    home,
    dir,
    file,
    env,
    run: (fs?: TerminalPolicyFs) => normalizeTerminalPolicy(config({ home }), { env, ...(fs ? { fs } : {}) }),
  };
}
describe("boot machine policy, not legacy launch configuration", () => {
  it("real off: absent/explicit off policy strips nothing from an already-off config, no diagnostic", () => {
    const f = fixture();
    const original = config({ home: f.home });
    expect(normalizeTerminalPolicy(original, { env: f.env })).toEqual({ config: original });
    writeFileSync(f.file, JSON.stringify({ webHub: { terminal: { enabled: false, maxTotal: "invalid-unused" } } }));
    expect(f.run()).toEqual({ config: original });
    expect(original).not.toHaveProperty("terminal");
  });
  it("legacy terminal conflicts with machine off: old launch key never enables or mutates input", () => {
    const f = fixture();
    const input = config({ home: f.home, terminal: limits });
    const result = normalizeTerminalPolicy(input, { env: f.env });
    expect(result.config).not.toHaveProperty("terminal");
    expect(result).not.toHaveProperty("diagnostic");
    expect(input.terminal).toEqual(limits);
  });
  it.each(["denied", undefined, "secure", "locked", "", "PLAIN"])(
    "source %s: unavailable, ZERO metadata/body I/O",
    (source) => {
      const f = fixture();
      writeFileSync(f.file, JSON.stringify({ webHub: { terminal: { enabled: true } } }));
      f.env.PI_WEBHUB_TERMINAL_SOURCE = source;
      const fs = Object.fromEntries(
        Object.keys(realFs).map((k) => [
          k,
          vi.fn(() => {
            throw new Error("must not read");
          }),
        ]),
      ) as unknown as TerminalPolicyFs;
      const result = f.run(fs);
      expect(result.config).not.toHaveProperty("terminal");
      expect(result.diagnostic).toMatchObject({
        mode: "per-session",
        state: "unavailable",
        reason: source === "denied" ? "startup-domain-denied" : "startup-domain-unknown",
      });
      for (const fn of Object.values(fs)) expect(fn).not.toHaveBeenCalled();
    },
  );
  it("plain independent of launch key: reads strict machine limits; no arbitrary settings forwarded", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      JSON.stringify({
        secret: "not-forwarded",
        webHub: { terminal: { enabled: true, maxTotal: 3, inputIdleS: 300 } },
      }),
    );
    expect(f.run()).toEqual({
      config: config({ home: f.home, terminal: { ...limits, maxTotal: 3, inputIdleMs: 300000 } }),
      diagnostic: {
        mode: "per-session",
        state: "ready",
        source: "default",
        effectiveMachineLimits: { ...limits, maxTotal: 3, inputIdleMs: 300000 },
      },
    });
  });
  it("PI_CODING_AGENT_DIR override and genuine absent inheritance select the correct scope", () => {
    const f = fixture();
    const custom = join(f.home, "custom");
    mkdirSync(custom);
    f.env.PI_CODING_AGENT_DIR = custom;
    writeFileSync(f.file, JSON.stringify({ webHub: { terminal: { enabled: true, maxTotal: 4 } } }));
    expect(f.run().diagnostic).toMatchObject({
      source: "inherited",
      state: "ready",
      effectiveMachineLimits: { maxTotal: 4 },
    });
    writeFileSync(
      join(custom, "pi-toolkit.json"),
      JSON.stringify({ webHub: { terminal: { enabled: true, maxTotal: 1 } } }),
    );
    expect(f.run().diagnostic).toMatchObject({
      source: "agentDir",
      state: "ready",
      effectiveMachineLimits: { maxTotal: 1 },
    });
  });
  it.each(["bad-json", "unsafe-mode", "symlink", "oversize", "invalid-limits", "dangling-compat"])(
    "%s is unavailable, never off/legacy fallback",
    (kind) => {
      const f = fixture();
      if (kind === "dangling-compat") symlinkSync("pi-toolkit.json", join(f.dir, "pi-subagent.json"));
      else if (kind === "symlink") symlinkSync(join(f.home, "missing"), f.file);
      else {
        writeFileSync(
          f.file,
          kind === "bad-json"
            ? "{"
            : kind === "oversize"
              ? " ".repeat(TERMINAL_POLICY_MAX_BYTES + 1)
              : JSON.stringify({
                  webHub: { terminal: { enabled: true, ...(kind === "invalid-limits" ? { maxTotal: 0 } : {}) } },
                }),
        );
        if (kind === "unsafe-mode") chmodSync(f.file, 0o666);
      }
      const r = f.run();
      expect(r.config).not.toHaveProperty("terminal");
      expect(r.diagnostic?.state).toBe("unavailable");
      expect(JSON.stringify(r.diagnostic)).not.toContain(f.home);
    },
  );
  it("unsafe/denied primary NEVER inherits a healthy HOME", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ webHub: { terminal: { enabled: true } } }));
    f.env.PI_CODING_AGENT_DIR = join(f.home, "unsafe");
    writeFileSync(f.env.PI_CODING_AGENT_DIR, "file-not-directory");
    expect(f.run().diagnostic).toMatchObject({
      source: "agentDir",
      state: "unavailable",
      reason: "settings-not-directory",
    });
    const denied: TerminalPolicyFs = {
      ...realFs,
      lstatSync(p) {
        if (p === f.dir) throw Object.assign(new Error("SECRET"), { code: "EACCES" });
        return lstatSync(p);
      },
    };
    delete f.env.PI_CODING_AGENT_DIR;
    expect(f.run(denied).diagnostic).toMatchObject({ state: "unavailable", reason: "settings-io" });
  });
  it("S6b checks both secure sections but does not merge legacy terminal limits", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      JSON.stringify({ secure: { enabled: false }, webHub: { terminal: { enabled: true, maxTotal: 2 } } }),
    );
    const legacy = join(f.dir, "pi-subagent.json");
    writeFileSync(
      legacy,
      JSON.stringify({ secure: { enabled: true }, webHub: { terminal: { enabled: true, maxTotal: 32 } } }),
    );
    expect(f.run().diagnostic).toMatchObject({ reason: "settings-conflict" });
    writeFileSync(
      legacy,
      JSON.stringify({ secure: { enabled: false }, webHub: { terminal: { enabled: true, maxTotal: 32 } } }),
    );
    expect(f.run().config.terminal?.maxTotal).toBe(2);
  });
  it("all parent fds use NOFOLLOW; a swapped parent is rejected before any body read and ALL fds close", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ webHub: { terminal: { enabled: true } } }));
    const opened = new Set<number>();
    const read = vi.fn(readSync);
    let swapped = false;
    const fs: TerminalPolicyFs = {
      ...realFs,
      readSync: read,
      openSync: ((p: string, flags: number) => {
        expect(flags & constants.O_NOFOLLOW).not.toBe(0);
        const fd = openSync(p, flags);
        opened.add(fd);
        if (p.endsWith("/pi-toolkit.json") && !swapped) {
          swapped = true;
          renameSync(f.dir, `${f.dir}-old`);
          symlinkSync(`${f.dir}-old`, f.dir);
        }
        return fd;
      }) as typeof openSync,
      closeSync(fd) {
        opened.delete(fd);
        closeSync(fd);
      },
    };
    expect(f.run(fs).diagnostic).toMatchObject({ state: "unavailable", reason: "settings-unsafe" });
    expect(read).not.toHaveBeenCalled();
    expect(opened.size).toBe(0);
  });
  it("fd mutation and logical budget exhaustion cannot publish enabled", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ webHub: { terminal: { enabled: true } } }));
    let tick = 0;
    expect(
      normalizeTerminalPolicy(config({ home: f.home }), { env: f.env, monotonicNow: () => (tick += 1000) }).diagnostic,
    ).toMatchObject({ state: "unavailable", reason: "settings-timeout" });
    const fs: TerminalPolicyFs = {
      ...realFs,
      readSync(fd, b, off, len, pos) {
        const n = readSync(fd, b, off, len, pos);
        if (n) chmodSync(f.file, 0o666);
        return n;
      },
    };
    expect(f.run(fs).diagnostic).toMatchObject({ state: "unavailable", reason: "settings-unsafe" });
  });
});
