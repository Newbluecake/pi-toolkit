/** Linux identity checks and bounded Node fallback. A timeout is never a reap proof. */
import { readFile, readdir, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { TerminalProcessIdentity, TerminalResourceEntry } from "../../protocol/terminal.js";
import { systemClock, type TimerHandle } from "../../../core/clock.js";
import { clampSpanMs } from "../../../core/deadline.js";
export type ManagedIdentity = TerminalResourceEntry["managed"][number];

export async function readTerminalIdentity(
  pid: number,
  role: ManagedIdentity["role"] = "descendant",
): Promise<ManagedIdentity | undefined> {
  try {
    const [text, bootId, st] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      stat(`/proc/${pid}`),
    ]);
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error("identity");
    return {
      bootId: bootId.trim(),
      pid,
      starttime: fields[19],
      uid: st.uid,
      pgid: Number(fields[2]),
      sid: Number(fields[3]),
      role,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH")
      return undefined;
    throw new Error("terminal identity unavailable");
  }
}
export function sameTerminalProcess(a: TerminalProcessIdentity, b: TerminalProcessIdentity): boolean {
  return a.bootId === b.bootId && a.pid === b.pid && a.starttime === b.starttime && a.uid === b.uid;
}
/** Missing is proven only by ENOENT/ESRCH, not an unreadable /proc or an empty catch. */
export async function terminalIdentitiesGone(identities: readonly ManagedIdentity[]): Promise<boolean> {
  try {
    for (const i of identities) {
      const current = await readTerminalIdentity(i.pid);
      if (current && sameTerminalProcess(i, current)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export async function scanTerminalSession(
  sid: number,
  known: readonly ManagedIdentity[],
): Promise<ManagedIdentity[] | undefined> {
  const begin = performance.now();
  try {
    const pids = (await readdir("/proc")).filter((s) => /^\d+$/.test(s));
    if (pids.length > 8192) return undefined;
    const found = new Map<string, ManagedIdentity>();
    for (const pid of pids) {
      if (performance.now() - begin > 200) return undefined;
      const i = await readTerminalIdentity(Number(pid));
      if (i && (i.sid === sid || known.some((k) => sameTerminalProcess(k, i)))) {
        found.set(`${i.pid}:${i.starttime}`, i);
        if (found.size > 256) return undefined;
      }
    }
    return [...found.values()];
  } catch {
    return undefined;
  }
}

/** Retry ownership stays with the old owner; no TTL deallocation. All timers unref'd. */
export class TerminalReaper {
  private timer: TimerHandle | undefined;
  private rounds = 0;
  private stopped = false;
  constructor(private readonly attempt: () => Promise<boolean>) {}
  start(): void {
    void this.run();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) systemClock.clearTimer(this.timer);
    this.timer = undefined;
  }
  private async run(): Promise<void> {
    if (this.stopped) return;
    this.rounds++;
    let complete = false;
    try {
      complete = await this.attempt();
    } catch {
      /* remains poison */
    }
    if (complete || this.stopped || this.rounds >= 3) return;
    this.timer = systemClock.setTimer(clampSpanMs(20_000)!, () => {
      this.timer = undefined;
      void this.run();
    });
  }
}
