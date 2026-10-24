/**
 * Cross-file test serialization for suites that create REAL gocryptfs mounts (N1 review #3).
 *
 * `run --private` refuses while ANY fuse.gocryptfs mount exists globally (it would be copied into
 * the private namespace). Vitest runs test files in parallel workers, so a suite holding global
 * test mounts (launcher-fuse, the N0 golden's real block) would make the private-run suite fail
 * nondeterministically. Every such suite holds this exclusive flock for its whole real block.
 * The lock is a plain file in os.tmpdir() keyed by uid.
 *
 * todo #31 — the lock must die with the test run. The previous holder (a DETACHED
 * `flock … sh -c 'exec sleep <1h>'`) survived an outer `timeout`/SIGKILL as a ppid=1 orphan for an hour.
 *
 * Chosen design: ONE small holder process is the lock's only owner, and it dies with the test run:
 *   - node opens the lock file and hands the fd to the holder as fd 3, then closes its own copy at once
 *     (so the open file description — which carries the flock — belongs to the holder alone);
 *   - the holder is `setpriv --pdeathsig KILL -- sh -c '…'` (when util-linux setpriv exists): the
 *     kernel SIGKILLs it the instant the test process (its parent) dies, for any reason;
 *   - while WAITING (non-blocking `flock -n` every 50 ms) and while HOLDING, it checks every 50 ms
 *     BOTH the test process and the test process's parent (vitest's main process for a forks-pool
 *     worker). Measured on this machine: SIGKILL of vitest's MAIN process
 *     leaves its fork worker running as a ppid=1 orphan (it finishes the current test), so a lock held
 *     on the worker's own fd would stay taken for the rest of that test; with the parent poll it is
 *     released within ~50–100 ms;
 *   - its `sleep` children run with fd 3 closed, so no grandchild can keep the lock;
 *   - not detached: it shares the test process's group, and release() SIGKILLs it.
 * Considered and rejected: flock on an fd held by the test process itself (released instantly on the
 * worker's death, but NOT on the death of vitest's main process — see above).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GOCRYPTFS_TEST_LOCK = join(tmpdir(), `pi-secure-gocryptfs-tests-${process.getuid?.() ?? 0}.lock`);

/**
 * $1 = max polls (wait seconds × 20), $2 = test pid, $3 = its parent. `alive` reads
 * /proc/<pid>/status (no permission needed, unlike `kill -0` on a foreign parent such as pid 1) and
 * treats a zombie as dead. V7 review m1: the WAIT is a 50 ms non-blocking poll that checks both pids
 * on every round, so a waiter whose test process or vitest main dies gives up at once; the only child
 * that ever sees fd 3 is a non-blocking `flock -n 3` that returns within milliseconds (no blocked
 * flock child can outlive the watcher), and every `sleep` runs with fd 3 closed.
 */
const HOLDER_SH = [
  'alive() { while read -r k v _; do [ "$k" = State: ] && { [ "$v" != Z ] && [ "$v" != X ]; return; }; done < "/proc/$1/status"; return 1; }',
  "n=0",
  "while ! flock -n -x 3; do",
  '  alive "$2" 2>/dev/null && alive "$3" 2>/dev/null || exit 2',
  '  n=$((n + 1)); [ "$n" -ge "$1" ] && exit 1',
  "  sleep 0.05 3>&-",
  "done",
  "echo locked",
  'while alive "$2" 2>/dev/null && alive "$3" 2>/dev/null; do sleep 0.05 3>&-; done',
].join("\n");

let setprivOk: boolean | undefined;
function haveSetpriv(): boolean {
  setprivOk ??= spawnSync("setpriv", ["--pdeathsig", "KILL", "--", "true"]).status === 0;
  return setprivOk;
}

/** Resolves with a release function once the exclusive lock is held (rejects after `timeoutMs`). */
export function acquireGocryptfsTestLock(timeoutMs = 240_000, lockFile = GOCRYPTFS_TEST_LOCK): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = openSync(lockFile, "a", 0o600);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const polls = String(Math.max(1, Math.ceil(timeoutMs / 50)));
    const shArgs = ["-c", HOLDER_SH, "sh", polls, String(process.pid), String(process.ppid)];
    const [cmd, args] = haveSetpriv() ? ["setpriv", ["--pdeathsig", "KILL", "--", "sh", ...shArgs]] : ["sh", shArgs];
    let holder: ChildProcess;
    try {
      holder = spawn(cmd as string, args as string[], { stdio: ["ignore", "pipe", "ignore", fd] });
    } finally {
      closeSync(fd); // the holder has its own copy now: it is the description's only owner
    }
    let out = "";
    let settled = false;
    const release = (): void => {
      try {
        holder.kill("SIGKILL");
      } catch {
        /* gone */
      }
    };
    holder.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
      if (!settled && out.includes("locked")) {
        settled = true;
        resolve(release);
      }
    });
    holder.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    holder.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`gocryptfs test lock not acquired (holder exit ${code ?? signal})`));
      }
    });
  });
}
