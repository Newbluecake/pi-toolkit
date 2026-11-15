/** Read-only S0–S7 settings selection mirror of secure/settings-lock.ts. No lock, heal,
 * migration, writes or arbitrary symlink following. Valid regular-file states retain parity;
 * unlike the tolerant agent resolver, errors NEVER masquerade as missing/inheritable settings.
 * Selection is NOT a safe body read: the hub reader must still bind/verify an owned regular fd,
 * parent ownership, size, identity and (on conflict) secure-section agreement. */
import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentDirInfo } from "./agent-dir.js";

export const SETTINGS_FILE_NAME = "pi-toolkit.json";
export const LEGACY_SETTINGS_FILE_NAME = "pi-subagent.json";
export type SettingsSelectionReason =
  "settings-io" | "settings-not-directory" | "settings-unsafe-file" | "settings-dangling-compat-link";
export type SettingsFileState = (
  | { kind: "new"; legacy: "absent" | "compat-link" | "same-inode" | "conflict"; legacyNewer?: boolean }
  | { kind: "legacy"; legacyType: "file" }
  | { kind: "none"; compatLinkDangling: false }
  | { kind: "unavailable"; reason: SettingsSelectionReason; code: string }
) & { path: string; newPath: string; legacyPath: string };
export type SettingsLocation = SettingsFileState & {
  scope: "default" | "agentDir" | "inherited";
  agent: AgentDirInfo;
};
export interface SettingsFsDeps {
  lstat?: (path: string) => Stats;
  readlink?: (path: string) => string;
}

/** OS code only, never error.message/path/body. Unknown failures remain errors. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "EIO";
}

export function resolveSettingsFile(dir: string, deps: SettingsFsDeps = {}): SettingsFileState {
  const lstat = deps.lstat ?? lstatSync;
  const readlink = deps.readlink ?? readlinkSync;
  const newPath = join(dir, SETTINGS_FILE_NAME);
  const legacyPath = join(dir, LEGACY_SETTINGS_FILE_NAME);
  const paths = { path: newPath, newPath, legacyPath };
  const unavailable = (reason: SettingsSelectionReason, code: string): SettingsFileState => ({
    ...paths,
    kind: "unavailable",
    reason,
    code,
  });
  const none = (): SettingsFileState => ({ ...paths, kind: "none", compatLinkDangling: false });
  // Walk ancestors first: ENOENT at a leaf cannot hide a file/denied/dangling parent.
  // Parent symlinks are intentionally refused, not followed into another settings scope.
  if (!isAbsolute(dir)) return unavailable("settings-not-directory", "EINVAL");
  const chain: string[] = [];
  for (let p = dir; ; p = dirname(p)) {
    chain.push(p);
    if (dirname(p) === p) break;
  }
  for (const p of chain.reverse()) {
    try {
      if (!lstat(p).isDirectory()) return unavailable("settings-not-directory", "ENOTDIR");
    } catch (error) {
      const code = errorCode(error);
      return code === "ENOENT" ? none() : unavailable("settings-io", code);
    }
  }
  const probe = (path: string): Stats | undefined => {
    try {
      return lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  };
  try {
    const n = probe(newPath);
    const l = probe(legacyPath);
    if (n && !n.isFile()) return unavailable("settings-unsafe-file", n.isSymbolicLink() ? "ELOOP" : "EINVAL");
    let compat = false;
    if (l?.isSymbolicLink()) {
      const target = readlink(legacyPath);
      compat = target === SETTINGS_FILE_NAME || target === newPath;
      if (!compat) return unavailable("settings-unsafe-file", "ELOOP");
      if (!n) return unavailable("settings-dangling-compat-link", "ENOENT");
    } else if (l && !l.isFile()) return unavailable("settings-unsafe-file", "EINVAL");
    if (n) {
      const legacy = !l
        ? "absent"
        : compat
          ? "compat-link"
          : n.dev === l.dev && n.ino === l.ino
            ? "same-inode"
            : "conflict";
      return {
        ...paths,
        kind: "new",
        legacy,
        ...(legacy === "conflict" && l ? { legacyNewer: l.mtimeMs > n.mtimeMs } : {}),
      };
    }
    if (l) return { ...paths, path: legacyPath, kind: "legacy", legacyType: "file" };
    return none();
  } catch (error) {
    return unavailable("settings-io", errorCode(error));
  }
}

/** Only genuine missing primary settings inherit HOME. A bad inherited target is unavailable,
 * including dangling compatibility links; never silently downgrade an attempted restriction. */
export function resolveSettingsLocation(agent: AgentDirInfo, deps: SettingsFsDeps = {}): SettingsLocation {
  const primary = resolveSettingsFile(agent.dir, deps);
  if (agent.source === "default") return { ...primary, scope: "default", agent };
  if (primary.kind !== "none") return { ...primary, scope: "agentDir", agent };
  const home = resolveSettingsFile(agent.home, deps);
  if (home.kind !== "none") return { ...home, scope: "inherited", agent };
  return { ...primary, scope: "agentDir", agent };
}
