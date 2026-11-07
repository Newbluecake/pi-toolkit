import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBashJobManager } from "../../../src/bash/manager.js";
import { createJobStore } from "../../../src/bash/job-store.js";
import { createProcessPort } from "../../../src/bash/process.js";
import { systemClock } from "../../../src/core/clock.js";

/**
 * Issue #73 crash driver (child process of `bash-crash-recovery.test.ts`).
 *
 * Builds a **real** `BashJobManager` — real process port, real store, real
 * directory — starts one job, hands the caller its id and then simply stays
 * alive. The parent deliberately `SIGKILL`s this process: no `dispose()`, no
 * log flush, no exit handler runs. Whatever survives is what the child's own
 * file descriptors keep alive, which is exactly the property under test.
 *
 * Usage: `node --import tsx bash-crash-driver.ts <dir> <command> <handoffFile> <maxLogBytes>`
 */
const [dir, command, handoffFile, maxLogBytesArg] = process.argv.slice(2);
if (dir === undefined || command === undefined || handoffFile === undefined) {
  process.stderr.write("usage: bash-crash-driver.ts <dir> <command> <handoffFile> <maxLogBytes>\n");
  process.exit(2);
}

const store = createJobStore({ dir, retentionMs: 86_400_000, clock: systemClock });
const manager = createBashJobManager({
  store,
  processPort: createProcessPort(),
  clock: systemClock,
  sessionId: "crashing-session",
  maxLogBytes: Number.parseInt(maxLogBytesArg ?? "10485760", 10),
  warn: (message) => process.stderr.write(`[driver] ${message}\n`),
});

const created = await manager.create({ command, cwd: process.cwd() });
// A background job is what the bug is about: only a backgrounded record is
// announced/recovered. `create()` already persisted `running`; stamping the
// marker is the last thing this process does on disk.
await manager.markBackgrounded(created.jobId);

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "job.pid"), `${created.pid}\n`, "utf8");
writeFileSync(
  handoffFile,
  JSON.stringify({
    dir,
    jobId: created.jobId,
    logPath: join(dir, `${created.jobId}.log`),
    exitPath: store.exitPath(created.jobId),
    at: Date.now(),
  }),
  "utf8",
);

// Stay alive until the parent kills us. Anything more (waiting for the job,
// finalizing, disposing) would defeat the test.
setInterval(() => undefined, 1 << 30);
