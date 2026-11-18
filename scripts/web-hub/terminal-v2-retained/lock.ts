/** Kernel-held flock shared by maintenance and the fixed launcher. Persistent lock
 * file has no stale-PID reclaim. CLI death closes stdin -> helper normally exits ->
 * kernel releases lock; an independent CLI can then reacquire. No daemon/signals. */
import { constants, closeSync, fstatSync, lstatSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { HeldDirectory } from "../terminal-v2-maintenance/files.js";
const HELPER = `
const deadline = Number(process.argv[1]);
if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now()+31000) process.exit(64);
const timer=setTimeout(()=>process.exit(75), Math.max(1,deadline-Date.now())); timer.unref();
process.stdin.on('end',()=>{clearTimeout(timer);process.exit(0)});
process.stdin.on('error',()=>process.exit(75));process.stdin.resume();
process.stdout.write('retained-lock-ready\\n');
`;
export interface RetainedLock {
  guard(): void;
  release(): Promise<void>;
}
export async function acquireRetainedLock(directory: HeldDirectory, deadline: number): Promise<RetainedLock> {
  directory.check();
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 30000)
    throw new Error("E_RETAINED_LOCK_DEADLINE");
  const executable = lstatSync("/usr/bin/flock");
  if (
    !executable.isFile() ||
    executable.uid !== 0 ||
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0
  )
    throw new Error("E_RETAINED_FLOCK_UNTRUSTED");
  if (directory.absent("maintenance.lock")) {
    directory.create("maintenance.lock", Buffer.from("pi-subagent:terminal-retained-lock:1\n"));
    directory.sync();
  }
  const pin = directory.read("maintenance.lock", 1024);
  if (pin.bytes.toString() !== "pi-subagent:terminal-retained-lock:1\n") throw new Error("E_RETAINED_LOCK_SHAPE");
  const fd = openSync(
    directory.at("maintenance.lock"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const identity = fstatSync(fd);
  if (identity.dev !== pin.fingerprint.dev || identity.ino !== pin.fingerprint.ino) {
    closeSync(fd);
    throw new Error("E_RETAINED_LOCK_CHANGED");
  }
  const child = spawn(
    "/usr/bin/flock",
    ["--no-fork", "--exclusive", "--nonblock", "/proc/self/fd/4", process.execPath, "-e", HELPER, String(deadline)],
    {
      stdio: ["pipe", "pipe", "pipe", "ignore", fd],
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  closeSync(fd);
  const stdin = child.stdin!,
    stdout = child.stdout!,
    stderr = child.stderr!;
  let ended = false,
    released = false;
  stdin.on("error", () => {
    ended = true;
  });
  stderr.resume();
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      ended = true;
      resolve();
    });
    child.once("error", () => {
      ended = true;
      resolve();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("E_RETAINED_LOCK_DEADLINE")),
        Math.min(2000, Math.max(1, deadline - Date.now())),
      );
      timer.unref();
      let reply = "";
      const close = () => {
        clearTimeout(timer);
        reject(new Error("E_RETAINED_LOCK_BUSY"));
      };
      child.once("close", close);
      child.once("error", close);
      stdout.on("data", (b: Buffer) => {
        reply += b.toString();
        if (reply === "retained-lock-ready\n") {
          clearTimeout(timer);
          child.removeListener("close", close);
          child.removeListener("error", close);
          resolve();
        } else if (reply.length >= 128) {
          clearTimeout(timer);
          reject(new Error("E_RETAINED_LOCK_PROTOCOL"));
        }
      });
    });
    const guard = () => {
      if (released || ended || child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
        throw new Error("E_RETAINED_LOCK_LOST");
      directory.verify(pin);
    };
    guard();
    return {
      guard,
      async release() {
        if (released) return;
        released = true;
        stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("E_RETAINED_LOCK_RELEASE_UNKNOWN")), 2000);
              timer.unref();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
  } catch (e) {
    stdin.end();
    void closed;
    throw e;
  }
}
