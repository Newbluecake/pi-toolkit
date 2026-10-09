/**
 * Best-effort kernel comm naming for the hub's own long-lived processes — the daemon itself
 * (`pi-webhub`, set by `main.ts`), the SQLite auth/session DB child (`pi-webhub-auth`, embedded
 * in `db-child.ts`'s script prelude) and the spawn reaper watchdog (`pi-webhub-reap`, embedded
 * in `spawn/reaper-source.ts`). Without it all three show comm `node` in `/proc/<pid>/stat`,
 * `ps -e` and htop.
 *
 * ONLY the comm is ever set — never `process.title`: on Linux that overwrites
 * `/proc/<pid>/cmdline`, and identity depends on cmdline staying byte-stable. The agent-side
 * hub restart check (`agent/proc-identity.ts`'s `verifyProcIdentity` + `looksLikeHubArgv`)
 * compares `/proc/<pid>/cmdline` against the argv `hub.ts`'s `identityFields` recorded into
 * hub.json at boot, and tests locate the reaper child by its cmdline literal — comm and cmdline
 * are independent kernel fields, so naming comm breaks neither.
 *
 * Names are ≤15 bytes (TASK_COMM_LEN−1; the kernel silently truncates longer writes) and
 * deliberately never `pi` and never `node*` — session-history's occupancy scan
 * (`spawn/history/proc.ts`) classifies `comm === "pi"` as a pi process and `node*` as a
 * candidate needing a cmdline read, so all three names classify as plain "other" there.
 *
 * This module is hub-side only (`hub/` never imports pi). The two inline `node -e` child
 * scripts cannot import it (they are plain CommonJS text run outside jiti), so they embed their
 * own one-line `/proc/self/comm` write with the same best-effort semantics.
 */
import { writeFileSync } from "node:fs";

/** The hub daemon's comm (the child-script names live inside their generated source text). */
export const HUB_COMM = "pi-webhub";

export interface SetProcessCommDeps {
  /** default `process.platform` */
  platform?: NodeJS.Platform;
  /** default writes to `/proc/self/comm`; injectable for tests. */
  write?: (path: string, data: string) => void;
}

/**
 * Set this process's kernel comm to `name`. Linux-only; every failure (non-Linux, missing
 * `/proc`, `EACCES`/`EINVAL`/…) is swallowed — a display nicety must never break hub startup.
 * Synchronous on purpose: called exactly once at process start.
 */
export function setProcessComm(name: string, deps: SetProcessCommDeps = {}): void {
  if (name === "") return;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return;
  const write =
    deps.write ??
    ((path: string, data: string) => {
      writeFileSync(path, data, "utf8");
    });
  try {
    write("/proc/self/comm", name);
  } catch {
    // best-effort: unreadable/absent /proc, rejected name — keep running unnamed
  }
}
