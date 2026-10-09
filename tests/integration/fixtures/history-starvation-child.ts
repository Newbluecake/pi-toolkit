/**
 * web-hub session-history plan §4.8 step 4 — the libuv-starvation child (P-int).
 *
 * Runs as a REAL child process under `UV_THREADPOOL_SIZE=4` (pi's bundled jiti executes this
 * TypeScript directly; the pool size must be fixed before libuv boots, so no in-process test
 * can reproduce it). It builds P-scan's REAL history service whose `fs.open` seam strips
 * `O_NONBLOCK` for exactly one FIFO path: every history open of that file becomes a genuinely
 * BLOCKING threadpool op (a FIFO read-open with no writer never returns). The suite then
 * proves PD4's guarantee — history itself never occupies more than `HISTORY_FS_SLOTS = 2`
 * threadpool threads (its IO gate caps concurrent/zombie ops), so preview-style reads,
 * uploads-style writes and LAN-login `crypto.scrypt` all keep completing.
 *
 * NOTE on the process model (measured on Node 22): a pending blocking threadpool open BLOCKS
 * `process.exit` — this child can never exit on its own once wedged, by design. It therefore
 * never calls exit: the FINAL VERDICT rides stdout as the last JSON line (`"verdict":"pass" |
 * "fail"`), and the parent SIGKILLs after reading it. A non-pass verdict fails the parent.
 *
 * The second half demonstrates §6.5's honest non-guarantee: with preview-style reads ALSO
 * wedged on the same FIFO (2 more stuck threads ⇒ the whole 4-thread pool may be busy),
 * nothing is asserted — the scrypt timing is only recorded.
 */
import { spawnSync } from "node:child_process";
import { scrypt } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open as fspOpen, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryService } from "../../../src/web-hub/hub/spawn/history/service.js";
import { defaultHistoryFs } from "../../../src/web-hub/hub/spawn/history/fs.js";
import { createReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0o4000;
const report: Record<string, unknown> = {};

function emit(verdict: "pass" | "fail", error?: string): void {
  report["verdict"] = verdict;
  if (error !== undefined) report["error"] = error;
  try {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    /* pipe gone — nothing left to do */
  }
}

async function timed(label: string, p: Promise<unknown>, maxMs: number): Promise<"ok" | "error" | "timeout"> {
  const t0 = Date.now();
  const outcome = await Promise.race([
    p.then(
      () => "ok" as const,
      () => "error" as const,
    ),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), maxMs).unref()),
  ]);
  report[label] = { ms: Date.now() - t0, outcome };
  return outcome;
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pwh-starve-"));
  const agentDir = join(home, ".pi", "agent");
  const sessionsDir = join(agentDir, "sessions", "d0");
  mkdirSync(sessionsDir, { recursive: true });
  const workdir = join(home, "work");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    join(sessionsDir, "regular.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "starve0", cwd: workdir, timestamp: "2024-01-01T00:00:00Z" })}\n`,
  );
  const fifoAbs = join(sessionsDir, "blocked.jsonl");
  if (existsSync(fifoAbs)) rmSync(fifoAbs);
  const mk = spawnSync("mkfifo", [fifoAbs]);
  if (mk.status !== 0) {
    emit("fail", `mkfifo failed: ${String(mk.stderr)}`);
    return;
  }

  const real = defaultHistoryFs();
  const service = createHistoryService(
    {
      agentDir,
      forkSrcDir: join(agentDir, "web-hub", "spawn", "fork-src"),
      registry: { list: () => [] },
      managed: () => [],
      deathOf: () => undefined,
      uid: process.getuid?.() ?? 0,
      hubPid: process.pid,
      now: Date.now,
      log: { info(): void {}, warn(): void {}, error(): void {} },
    },
    {
      fs: {
        ...real,
        open: (path: string, flags: number, mode?: number) =>
          real.open(path, path.endsWith("blocked.jsonl") ? flags & ~O_NONBLOCK : flags, mode),
      },
    },
  );

  // ---- phase 1: history wedged alone — everything else MUST keep working ----------------
  // The page() walk itself never opens the FIFO (enumeration filters non-files), so the wedge
  // enters through resolve()'s pin open — exactly the two-slot shape the gate permits.
  const pageMs: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now();
    const res = await service.page({ kind: "all", limit: 10 }, createReqDeadline(Date.now, 1_500));
    const ms = Date.now() - t0;
    pageMs.push(ms);
    if (!res.ok) {
      emit("fail", `page ${i}: cursor-expired (unexpected)`);
      return;
    }
    if (ms > 2_000) {
      emit("fail", `page ${i} exceeded 2s (${ms}ms) — history must degrade, never hang`);
      return;
    }
  }
  const resolveMs: number[] = [];
  let pinned = 0;
  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now();
    const res = await service.resolve(
      { key: "d0/blocked.jsonl", id: "starve0", mode: "resume" },
      workdir,
      createReqDeadline(Date.now, 1_500),
    );
    const ms = Date.now() - t0;
    resolveMs.push(ms);
    if (res.ok) pinned += 1;
    if (ms > 2_000) {
      emit("fail", `resolve ${i} exceeded 2s (${ms}ms)`);
      return;
    }
  }
  report["history"] = { pageMs, resolveMs };
  // the gate's two-slot shape: the first two resolves burn their pin budget on the wedged
  // open; everything after is refused FAST (busy/deadline), and nothing ever pins a FIFO
  const wedged = resolveMs.filter((ms) => ms > 300).length;
  if (pinned !== 0) {
    emit("fail", `resolve pinned a FIFO ${pinned} times`);
    return;
  }
  if (wedged > 2) {
    emit("fail", `${wedged} resolves wedged on the open — more than HISTORY_FS_SLOTS threads held`);
    return;
  }

  // preview-style read, uploads-style write, LAN-login kdf — each completes well under 2s
  if ((await timed("previewRead", readFile(join(sessionsDir, "regular.jsonl"), "utf8"), 2_000)) !== "ok") {
    emit("fail", "preview-style read did not complete <2s — history starved the threadpool beyond its slots");
    return;
  }
  if ((await timed("uploadsWrite", writeFile(join(home, "up.jsonl"), "ok"), 2_000)) !== "ok") {
    emit("fail", "uploads-style write did not complete <2s — history starved the threadpool beyond its slots");
    return;
  }
  if (
    (await timed(
      "scrypt",
      new Promise<void>((resolve, reject) => scrypt("pw", "salt", 16_384, (err) => (err ? reject(err) : resolve()))),
      2_000,
    )) !== "ok"
  ) {
    emit("fail", "crypto.scrypt did not complete <2s — history starved the threadpool beyond its slots");
    return;
  }

  // ---- phase 2 (record-only, §6.5): preview wedged TOO ----------------------------------
  // Two more blocking opens on the same FIFO ⇒ all 4 pool threads may be stuck. PD4 only
  // guarantees history's OWN share, so the scrypt timing below is RECORDED, never asserted.
  void fspOpen(fifoAbs, fsConstants.O_RDONLY).catch(() => undefined);
  void fspOpen(fifoAbs, fsConstants.O_RDONLY).catch(() => undefined);
  await timed(
    "scryptWithPreviewWedged",
    new Promise<void>((resolve) => scrypt("pw", "salt", 16_384, () => resolve())),
    3_000,
  );
  emit("pass");
}

void main().catch((err: unknown) => emit("fail", String(err)));
