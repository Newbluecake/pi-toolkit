/**
 * Platform-aware schedule test helpers (darwin plan §3 P4-B): the shared seams the existing suites
 * were refactored onto — process identity, liveness probe, external kernel-lock holder, lock
 * acquisition on an fd.
 *
 * Tier rules (darwin plan §5.1(2) 「隐藏 spawn」):
 * - `fixtureSelf()` starts NO child process on any platform: Linux reads the real /proc identity
 *   (identical to the pre-P4-B fixtures), non-Linux returns a STATIC epoch-ms identity. Tier1
 *   suites default to it and stay free of hidden spawns.
 * - `platformIdentity()` / `platformProbe()` on darwin, `spawnLockHolder()`, and `acquireOnFd()`
 *   start real child processes (ps/sysctl, perl flock, flock): callers must be registered in
 *   `TIER1_DECLARED` (kind "proc") or live under `tests/integration/`. Store transactions that
 *   acquire the lock internally (flock/perl per attempt) are the pre-existing hidden-spawn
 *   precedent and do not change tier ownership by themselves.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { createDarwinIdentity } from "../../src/web-hub/protocol/sched-identity.js";
import { defaultLockAcquire, type AcquireResult } from "../../src/schedule/core/lock.js";
import {
  procLivenessProbe,
  readSelfIdentity,
  type IdentityDeps,
  type LivenessProbe,
  type ProcessIdentity,
} from "../../src/schedule/core/recovery.js";

/** The platform's identity seam: darwin ⇒ ps/sysctl, everything else ⇒ the /proc reader. */
export function platformIdentity(): IdentityDeps {
  return process.platform === "darwin" ? createDarwinIdentity() : { readSelf: readSelfIdentity };
}

/** Static epoch-ms `start` (≥ SCHED_EPOCH_MS_FLOOR): the darwin start domain, no child process. */
const FIXTURE_START_MS = 1_769_000_000_000;

/**
 * The fixtures' process identity. Linux: the real /proc identity (the pre-P4-B behavior, errors
 * "needs /proc" when unavailable). Non-Linux: a static epoch-ms identity — deliberately NOT the
 * real ps/sysctl probe, so tier1 suites keep no hidden spawns. Suites that must judge REAL
 * foreign holders (recovery, fault injection children) use `platformIdentity()` instead and are
 * proc-registered.
 */
export function fixtureSelf(): ProcessIdentity {
  if (process.platform === "linux") {
    const s = readSelfIdentity();
    if (s === undefined) throw new Error("needs /proc");
    return s;
  }
  return { pid: process.pid, start: FIXTURE_START_MS, host: hostname(), boot: "sched-fixture-boot" };
}

/** The platform's liveness probe: darwin ⇒ ps/sysctl (epoch-ms domain), else ⇒ /proc ticks. */
export function platformProbe(): LivenessProbe {
  return process.platform === "darwin" ? createDarwinIdentity().probe : procLivenessProbe;
}

/**
 * An external process holding the kernel lock on `lockPath` until killed (or `seconds` pass).
 * Linux: the very same `flock -o -x <path> sleep <s>` command the suites ran before this helper
 * (`-o`: the lock stays with the flock process, so killing it models "the holder died").
 * Darwin: perl `flock(2)` — the holder blocks in LOCK_EX inside its own process and sleeps,
 * so its death releases the lock. `+>>` matches flock(1)'s create-if-missing semantics; every
 * current call site pre-creates the lock file anyway.
 */
export function spawnLockHolder(lockPath: string, seconds = 30): ChildProcess {
  if (process.platform !== "darwin") {
    return spawn("flock", ["-o", "-x", lockPath, "sleep", String(seconds)], { stdio: "ignore" });
  }
  return spawn(
    "/usr/bin/perl",
    [
      "-MFcntl=:flock",
      "-e",
      'open(F, "+>>", $ARGV[0]) or die "open"; $| = 1; flock(F, LOCK_EX) or die "flock"; print "held\\n"; sleep $ARGV[1]',
      lockPath,
      String(seconds),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

/** One platform-default lock attempt on `fd` (linux: flock(1), darwin: perl flock(2)). */
export function acquireOnFd(fd: number): AcquireResult {
  return defaultLockAcquire()(fd);
}
