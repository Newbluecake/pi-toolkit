/** Fixed source identity checks, not an operator version string/module loader.
 * N profile is embedded by build:maintenance; source-mode CLI cannot publish. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { canonical, digest, json } from "../terminal-v2-maintenance/files.js";
import { OLD_SOURCE_FILES } from "./old-source-profile.js";
declare const __T51_NEW_SOURCE_FILES__: Readonly<Record<string, string>>;
export const compiledNewSourceFiles =
  typeof __T51_NEW_SOURCE_FILES__ === "undefined" ? undefined : __T51_NEW_SOURCE_FILES__;
export interface SourceProfilePin {
  sha256: string;
  verify(): void;
  verifyBytes(): void;
}
export function pinSourceProfile(root: string, kind: "old" | "new"): SourceProfilePin {
  canonical(root);
  const expected = kind === "old" ? OLD_SOURCE_FILES : compiledNewSourceFiles;
  if (!expected) throw new Error("E_RETAINED_COMPILED_PROFILE_REQUIRED");
  const pins: Array<{ path: string; metadata: string; bytesSha256: string }> = [];
  const meta = (s: Stats) => JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
  const capture = (path: string) => {
    const original = lstatSync(path);
    if (
      !original.isFile() ||
      original.uid !== process.getuid?.() ||
      (original.mode & 0o022) !== 0 ||
      original.nlink !== 1 ||
      original.size > 8 * 1024 * 1024
    )
      throw new Error("E_RETAINED_SOURCE_PROFILE_FILE");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (meta(fstatSync(fd)) !== meta(original)) throw new Error("E_RETAINED_SOURCE_PROFILE_CHANGED");
      const bytes = Buffer.alloc(original.size + 1);
      let n = 0;
      while (n < bytes.length) {
        const got = readSync(fd, bytes, n, bytes.length - n, n);
        if (!got) break;
        n += got;
      }
      if (n !== original.size || meta(fstatSync(fd)) !== meta(original) || meta(lstatSync(path)) !== meta(original))
        throw new Error("E_RETAINED_SOURCE_PROFILE_CHANGED");
      return { path, metadata: meta(original), bytesSha256: digest(bytes.subarray(0, n)) };
    } finally {
      closeSync(fd);
    }
  };
  const directories = new Map<string, string>();
  for (const [relative, sha256] of Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("E_RETAINED_SOURCE_PROFILE_PATH");
    const path = join(root, relative),
      parent = dirname(path);
    if (!directories.has(parent)) {
      canonical(parent);
      directories.set(parent, meta(lstatSync(parent)));
    }
    const pin = capture(path);
    if (pin.bytesSha256 !== sha256) throw new Error("E_RETAINED_SOURCE_PROFILE_MISMATCH");
    pins.push(pin);
  }
  const verify = () => {
    canonical(root);
    for (const [path, original] of directories)
      if (meta(lstatSync(path)) !== original) throw new Error("E_RETAINED_SOURCE_PROFILE_CHANGED");
    for (const pin of pins)
      if (meta(lstatSync(pin.path)) !== pin.metadata) throw new Error("E_RETAINED_SOURCE_PROFILE_CHANGED");
  };
  verify();
  return {
    sha256: digest(json(expected)),
    verify,
    verifyBytes() {
      verify();
      for (const pin of pins)
        if (capture(pin.path).bytesSha256 !== pin.bytesSha256) throw new Error("E_RETAINED_SOURCE_PROFILE_CHANGED");
      verify();
    },
  };
}
