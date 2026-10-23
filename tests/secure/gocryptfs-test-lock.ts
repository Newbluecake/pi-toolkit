/**
 * Cross-file test serialization for suites that create REAL gocryptfs mounts (N1 review #3).
 *
 * `run --private` refuses while ANY fuse.gocryptfs mount exists globally (it would be copied into
 * the private namespace). Vitest runs test files in parallel workers, so a suite holding global
 * test mounts (launcher-fuse, the N0 golden's real block) would make the private-run suite fail
 * nondeterministically. Every such suite holds this exclusive flock for its whole real block.
 * The lock is a plain file in os.tmpdir() keyed by uid; a crashed holder releases it (flock).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GOCRYPTFS_TEST_LOCK = join(tmpdir(), `pi-secure-gocryptfs-tests-${process.getuid?.() ?? 0}.lock`);

/** Resolves with a release function once the exclusive lock is held (rejects after `timeoutMs`). */
export function acquireGocryptfsTestLock(timeoutMs = 240_000): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const holder: ChildProcess = spawn(
      "flock",
      [
        "-x",
        "-w",
        String(Math.ceil(timeoutMs / 1000)),
        GOCRYPTFS_TEST_LOCK,
        "sh",
        "-c",
        "echo locked; exec sleep 3600",
      ],
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    let out = "";
    holder.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.includes("locked"))
        resolve(() => {
          try {
            process.kill(-holder.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
        });
    });
    holder.on("close", (code) => {
      if (!out.includes("locked")) reject(new Error(`gocryptfs test lock not acquired (flock exit ${code})`));
    });
  });
}
