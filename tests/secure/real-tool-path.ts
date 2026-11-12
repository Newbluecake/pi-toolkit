/** Test-only gocryptfs binding. Metadata only: never executes a tool or imports product code. */
import { constants, accessSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type RealGocryptfsBinding = Readonly<{ selectedPath: string; realPath: string }>;
export type RealGocryptfsResolution =
  Readonly<{ binding: RealGocryptfsBinding; reason?: never }> | Readonly<{ binding?: never; reason: string }>;

/** No cwd-relative/empty PATH entries; an invalid first candidate is not a fallback request. */
export function resolveRealGocryptfs(parentPath: string): RealGocryptfsResolution {
  const dirs = [...new Set(parentPath.split(delimiter).filter(Boolean))];
  if (dirs.some((dir) => !isAbsolute(dir))) return Object.freeze({ reason: "gocryptfs: relative PATH entry" });
  for (const dir of dirs) {
    const selectedPath = join(dir, "gocryptfs");
    try {
      lstatSync(selectedPath); // distinguish an absent candidate from a dangling symlink
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return Object.freeze({ reason: `gocryptfs: ${selectedPath}: ${(error as Error).message}` });
    }
    try {
      const binding = Object.freeze({ selectedPath, realPath: realpathSync(selectedPath) });
      requireRealGocryptfs(binding);
      return Object.freeze({ binding });
    } catch (error) {
      return Object.freeze({ reason: `gocryptfs: ${selectedPath}: ${(error as Error).message}` });
    }
  }
  return Object.freeze({ reason: "missing gocryptfs" });
}

// Vitest isolates module instances per test file. Capability and fixtures consume THIS snapshot;
// no globalThis/env cache, and no rediscovery when a capable fixture later fails.
export const DEFAULT_REAL_GOCRYPTFS = resolveRealGocryptfs(process.env.PATH ?? "");

/** Revalidate an explicit binding, never fall back to PATH (including after snapshot deletion). */
export function requireRealGocryptfs(
  binding: RealGocryptfsBinding | undefined = DEFAULT_REAL_GOCRYPTFS.binding,
): RealGocryptfsBinding {
  if (!binding) throw new Error(DEFAULT_REAL_GOCRYPTFS.reason ?? "missing gocryptfs binding");
  const { selectedPath, realPath } = binding;
  if (!isAbsolute(selectedPath) || !isAbsolute(realPath)) throw new Error("gocryptfs binding must be absolute");
  try {
    if (realpathSync(selectedPath) !== realPath || realpathSync(realPath) !== realPath)
      throw new Error("binding target changed");
    const st = statSync(realPath);
    if (!st.isFile() || !(st.mode & 0o111)) throw new Error("not an executable regular file");
    accessSync(realPath, constants.X_OK);
  } catch (error) {
    throw new Error(`gocryptfs binding ${selectedPath}: ${(error as Error).message}`);
  }
  return binding;
}

/** A fresh single-name bridge, ONLY under an owned physical 0700 scratch root. Never repairs it. */
export function createRealToolBridge(ownedScratch: string, binding: RealGocryptfsBinding): string {
  requireRealGocryptfs(binding);
  const st = lstatSync(ownedScratch);
  if (
    !isAbsolute(ownedScratch) ||
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o700 ||
    realpathSync(ownedScratch) !== ownedScratch
  )
    throw new Error(`gocryptfs bridge requires owned physical 0700 scratch: ${ownedScratch}`);
  const bin = join(ownedScratch, "real-tools");
  mkdirSync(bin, { mode: 0o700 }); // EEXIST (even empty/symlink) is an error, not ours to clean
  symlinkSync(binding.realPath, join(bin, "gocryptfs"));
  requireRealGocryptfs(binding);
  if (realpathSync(join(bin, "gocryptfs")) !== binding.realPath)
    throw new Error(`gocryptfs bridge target mismatch: ${bin}`);
  return bin;
}

/** Fixed tail only; do not call from spawn/tty/plain or after a caller's explicit PATH override. */
export function composeRealPath(
  fakeBin: string,
  nodeOnlyBin: string | undefined,
  realToolsBin: string,
  binding: RealGocryptfsBinding,
  systemTail = "/usr/bin:/bin",
): string {
  requireRealGocryptfs(binding);
  if (realToolsBin === fakeBin || realToolsBin === nodeOnlyBin)
    throw new Error("gocryptfs bridge must be separate from fake/node bins");
  const bridge = lstatSync(realToolsBin);
  if (
    !bridge.isDirectory() ||
    bridge.isSymbolicLink() ||
    bridge.uid !== process.getuid?.() ||
    (bridge.mode & 0o777) !== 0o700 ||
    readdirSync(realToolsBin).join(",") !== "gocryptfs" ||
    !lstatSync(join(realToolsBin, "gocryptfs")).isSymbolicLink() ||
    realpathSync(join(realToolsBin, "gocryptfs")) !== binding.realPath
  )
    throw new Error(`gocryptfs bridge whitelist/target mismatch: ${realToolsBin}`);
  const path = [fakeBin, ...(nodeOnlyBin ? [nodeOnlyBin] : []), realToolsBin, systemTail]
    .filter(Boolean)
    .join(delimiter);
  const resolved = resolveRealGocryptfs(path);
  if (resolved.binding?.realPath !== binding.realPath)
    throw new Error(`controlled PATH gocryptfs mismatch: ${resolved.reason ?? resolved.binding?.realPath}`);
  // A real pi in a parent/nvm/system directory must never win over this fixture's fake pi.
  const pi = join(fakeBin, "pi");
  if (!statSync(pi).isFile()) throw new Error(`missing fake pi: ${pi}`);
  accessSync(pi, constants.X_OK);
  return path;
}
