import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, basename } from "node:path";

/** 32 random bytes, base64url — shared by `auth.ts` and `admin.ts`'s rotate-intent recovery so
 * both a live `Auth.rotateToken()` and a from-disk startup/scan recovery mint tokens the same way. */
export function generateToken(randomBytesImpl: (n: number) => Buffer = randomBytes): string {
  return randomBytesImpl(32).toString("base64url");
}

/** Replace a token without ever exposing a partially-written file. */
export function replaceTokenAtomic(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    syncDirectory(dirname(file));
    try {
      // rename preserves the temporary mode, but keep this explicit for unusual umasks.
      const st = lstatSync(file);
      if ((st.mode & 0o777) !== 0o600) {
        chmodSync(file, 0o600);
      }
    } catch {
      // The replacement itself is complete; callers will classify a later read failure.
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* absent after rename */
    }
  }
}

export function readTokenFile(file: string): string {
  return readFileSync(file, "utf8").trim();
}

/** Remove stale atomic-write leftovers after a crash. */
export function cleanupTokenTemps(file: string): void {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        try {
          unlinkSync(`${dir}/${name}`);
        } catch {
          /* raced with another cleanup */
        }
      }
    }
  } catch {
    /* state directory may not exist yet */
  }
}

function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems. The rename is
    // still atomic; callers must not turn a successful token replacement into a failure.
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
  }
}
