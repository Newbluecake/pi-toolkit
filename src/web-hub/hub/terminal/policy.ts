/** Boot-only, read-only machine policy. Bootstrap provenance is checked BEFORE any
 * settings body read. O_NOFOLLOW protects only the final component: every parent
 * is independently opened through its held parent's fd and identity checked.
 * Logical budget bounds further work, not an uninterruptible kernel syscall. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readlinkSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentDir } from "../../protocol/agent-dir.js";
import { resolveSettingsLocation } from "../../protocol/settings-location.js";
import { clampSpanMs } from "./limits.js";
import { parseTerminalPolicy } from "../../protocol/terminal-policy.js";
import type { HubConfig, TerminalStartupDiagnostic, TerminalStartupReason } from "../ports.js";

export const TERMINAL_POLICY_MAX_BYTES = 1024 * 1024;
export interface TerminalPolicyFs {
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  fstatSync: (fd: number) => Stats;
  lstatSync: (path: string) => Stats;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  readlinkSync: (path: string) => string;
}
class PolicyError extends Error {
  constructor(readonly reason: TerminalStartupReason) {
    super(reason);
  }
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function normalizeTerminalPolicy(
  input: HubConfig,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fs?: TerminalPolicyFs;
    monotonicNow?: () => number;
    signal?: AbortSignal;
  } = {},
): { config: HubConfig; diagnostic?: TerminalStartupDiagnostic } {
  const { terminal: _legacy, ...config } = input;
  const env = options.env ?? process.env;
  const agent = resolveAgentDir(env, input.home);
  let source: TerminalStartupDiagnostic["source"] = agent.source === "env" ? "agentDir" : "default";
  const unavailable = (reason: TerminalStartupReason) => ({
    config,
    diagnostic: { mode: "per-session" as const, source, state: "unavailable" as const, reason },
  });
  // No read/selection fallback can turn denied/unknown into off or infer plain.
  if (env["PI_WEBHUB_TERMINAL_SOURCE"] !== "plain")
    return unavailable(
      env["PI_WEBHUB_TERMINAL_SOURCE"] === "denied" ? "startup-domain-denied" : "startup-domain-unknown",
    );
  const fs: TerminalPolicyFs = options.fs ?? { openSync, closeSync, fstatSync, lstatSync, readSync, readlinkSync };
  const mono = options.monotonicNow ?? (() => performance.now());
  const deadline = mono() + clampSpanMs(2000);
  const check = () => {
    if (options.signal?.aborted || mono() >= deadline) throw new PolicyError("settings-timeout");
  };
  const op = <T>(fn: () => T): T => {
    check();
    const v = fn();
    check();
    return v;
  };
  const uid = process.getuid?.();
  const safeDir = (s: Stats) =>
    s.isDirectory() &&
    (s.uid === uid || s.uid === 0) &&
    ((s.mode & 0o022) === 0 || (s.uid === 0 && (s.mode & 0o1000) !== 0));
  function read(path: string): unknown {
    const fds: number[] = [];
    // Register immediately, before the post-syscall budget check, for total cleanup.
    const open = (p: string, flags: number) => {
      check();
      const fd = fs.openSync(p, flags);
      fds.push(fd);
      check();
      return fd;
    };
    try {
      const chain: string[] = [];
      for (let p = dirname(path); ; p = dirname(p)) {
        chain.push(p);
        if (dirname(p) === p) break;
      }
      const held: Array<{ path: string; stat: Stats }> = [];
      let parent: number | undefined;
      for (const p of chain.reverse()) {
        const before = op(() => fs.lstatSync(p));
        if (!safeDir(before)) throw new PolicyError("settings-unsafe");
        const fd = open(
          parent === undefined ? p : `/proc/self/fd/${parent}/${basename(p)}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const after = op(() => fs.fstatSync(fd));
        if (!safeDir(after) || !same(before, after)) throw new PolicyError("settings-unsafe");
        held.push({ path: p, stat: after });
        parent = fd;
      }
      const before = op(() => fs.lstatSync(path));
      const safeFile = (s: Stats) => s.isFile() && s.uid === uid && (s.mode & 0o022) === 0;
      if (!safeFile(before)) throw new PolicyError("settings-unsafe");
      if (before.size > TERMINAL_POLICY_MAX_BYTES) throw new PolicyError("settings-oversize");
      const fd = open(
        `/proc/self/fd/${parent}/${basename(path)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const start = op(() => fs.fstatSync(fd));
      if (!safeFile(start) || !same(before, start)) throw new PolicyError("settings-unsafe");
      if (start.size > TERMINAL_POLICY_MAX_BYTES) throw new PolicyError("settings-oversize");
      const verify = () => {
        for (const h of held) {
          const s = op(() => fs.lstatSync(h.path));
          if (!safeDir(s) || !same(h.stat, s)) throw new PolicyError("settings-unsafe");
        }
        const s = op(() => fs.lstatSync(path));
        if (!safeFile(s) || !same(start, s)) throw new PolicyError("settings-unsafe");
      };
      verify(); // parent swap must be caught BEFORE first body byte
      const bytes = Buffer.alloc(TERMINAL_POLICY_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = op(() => fs.readSync(fd, bytes, length, bytes.length - length, length));
        if (n === 0) break;
        length += n;
      }
      if (length > TERMINAL_POLICY_MAX_BYTES) throw new PolicyError("settings-oversize");
      const end = op(() => fs.fstatSync(fd));
      verify();
      if (
        !safeFile(end) ||
        !same(start, end) ||
        start.size !== end.size ||
        start.mtimeMs !== end.mtimeMs ||
        start.ctimeMs !== end.ctimeMs ||
        end.size !== length
      )
        throw new PolicyError("settings-unsafe");
      try {
        return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
      } catch {
        throw new PolicyError("settings-json");
      }
    } finally {
      for (const fd of fds.reverse()) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort; never reuse */
        }
      }
    }
  }
  try {
    const location = resolveSettingsLocation(agent, {
      lstat: (p) => op(() => fs.lstatSync(p)),
      readlink: (p) => op(() => fs.readlinkSync(p)),
    });
    source = location.scope;
    check();
    if (location.kind === "unavailable") return unavailable(location.reason);
    if (location.kind === "none") return { config };
    const settings = read(location.path);
    if (location.kind === "new" && location.legacy === "conflict") {
      const legacy = read(location.legacyPath);
      if (!object(settings) || !object(legacy) || !isDeepStrictEqual(settings["secure"], legacy["secure"]))
        return unavailable("settings-conflict");
    }
    const policy = parseTerminalPolicy(settings);
    check();
    if (policy.state === "off") return { config };
    if (policy.state === "unavailable") return unavailable(policy.reason);
    return {
      config: { ...config, terminal: policy.policy },
      diagnostic: { mode: "per-session", source, state: "ready", effectiveMachineLimits: { ...policy.policy } },
    };
  } catch (error) {
    return unavailable(error instanceof PolicyError ? error.reason : "settings-io");
  }
}
