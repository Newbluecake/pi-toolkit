import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * reaper-orphans plan §7: fixtures for the "SIGTERM-resistant group member"
 * scenario. `leader.mjs` has NO signal handler (dies on SIGTERM) and forks
 * `worker.mjs` (ignores SIGTERM) into the SAME process group.
 *   leader.mjs <mode> <pidfile>   mode "alive" = linger; "exit" = exit once the worker pid is written.
 */
// The worker writes the pidfile ONLY after its SIGTERM handler is installed (readiness
// signal) and ticks on stdout so an inherited pipe keeps receiving data (holds the drain open).
const WORKER = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => process.stdout.write("tick\\n"), 20);
`;
const LEADER = `import { fork } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [mode, pidfile] = process.argv.slice(2);
const worker = fork(join(dirname(fileURLToPath(import.meta.url)), "worker.mjs"), [pidfile], { stdio: "inherit" });
if (mode === "exit") {
  worker.unref();
  worker.disconnect();
  const t = setInterval(() => { try { readFileSync(pidfile); clearInterval(t); process.exit(0); } catch {} }, 10);
} else setInterval(() => {}, 1 << 30);
`;

export interface OrphanFixture {
  readonly dir: string;
  command(mode: "alive" | "exit"): string;
  workerPid(): number | undefined;
  cleanup(): void;
}

/** Linux: count non-zombie processes whose pgrp === pgid (scans /proc/<pid>/stat). */
export function liveGroupMembers(pgid: number): number {
  let n = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const f = raw
      .slice(raw.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    if (f[0] !== "Z" && Number.parseInt(f[2] ?? "", 10) === pgid) n++;
  }
  return n;
}

export async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

export function createOrphanFixture(): OrphanFixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-orphan-fixture-"));
  writeFileSync(join(dir, "worker.mjs"), WORKER);
  writeFileSync(join(dir, "leader.mjs"), LEADER);
  const pidfile = join(dir, "worker.pid");
  return {
    dir,
    command: (mode) => `node ${join(dir, "leader.mjs")} ${mode} ${pidfile}`,
    workerPid() {
      try {
        const n = Number.parseInt(readFileSync(pidfile, "utf8"), 10);
        return Number.isInteger(n) ? n : undefined;
      } catch {
        return undefined;
      }
    },
    cleanup() {
      const wp = (() => {
        try {
          return Number.parseInt(readFileSync(pidfile, "utf8"), 10);
        } catch {
          return undefined;
        }
      })();
      if (wp !== undefined && Number.isInteger(wp)) {
        try {
          process.kill(wp, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Best-effort SIGKILL of a whole group by recorded pgid (test cleanup only). */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* gone */
  }
}
