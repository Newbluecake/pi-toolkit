/**
 * web-hub-spawn plan §SP6 (arch v2 §7.3, invariants L1–L5): the standalone reaper watchdog
 * process's inline script source.
 *
 * `buildReaperSource()` returns plain CommonJS text (the same "inline script" pattern as
 * `db-client.ts:177` / `db-child.ts`'s `buildQueryScript`) which the hub runs as
 * `node --disable-warning=ExperimentalWarning -e "<script>"` with
 * `{detached: true, stdio: ["pipe", "pipe", "ignore"]}`. The script is never touched by
 * jiti/tsc and only ever uses `node:fs`/`node:process` — no disk writes, no hub.log.
 *
 * Protocol (NDJSON, stdin up / stdout down):
 *   hub → reaper: `{op:"track", spawnId, pid, startTicks, bootId, uid}` / `{op:"untrack", pid}`
 *   reaper → hub: `{ok:"ready"}` once at boot (hub gives up after 2s), then diagnostic lines
 *                 only (teardown / signal / skip reports — readable while the hub is alive).
 *
 * Teardown (stdin `end`/`error` ⇒ the hub died or closed normally):
 *   wait `REAPER_GRACE_MS` (5s — gives each pi child its own stdin-EOF orderly exit), then for
 *   every still-tracked pid re-verify identity and `kill(-pid, "SIGTERM")`; after
 *   `REAPER_KILL_AFTER_MS` (3s) re-verify and `kill(-pid, "SIGKILL")` the survivors;
 *   `REAPER_EXIT_AFTER_MS` (1s) later `process.exit(0)`. Total ≤ 5+3+1 = 9s, leaving 3s of
 *   headroom under `ORPHAN_BOUND_MS` (12s, L3). `REAPER_HARD_CAP_MS` (10s) is the backstop:
 *   after stdin EOF the script exits within 10s no matter what.
 *
 * Identity (L5, arch §7.4): the script embeds a byte-for-byte algorithmic copy of
 * `protocol/proc-identity.ts`'s `verifySpawnedIdentity` between the `__VERIFY_BEGIN__` /
 * `__VERIFY_END__` markers — same check order, same fail-closed semantics, same reason
 * strings, plus the group-kill precondition `pgrp === pid` with single-pid fallback on
 * `pgrp-mismatch`. Every signal is preceded by a fresh synchronous re-verification in the
 * same tick. `tests/web-hub/hub/spawn/reaper.test.ts` pins the two implementations against
 * the same `/proc` fixture matrix (via `extractVerifySource` + `new Function`).
 */
import { REAPER_GRACE_MS } from "../../protocol/spawn.js";

/** Teardown phase 2: SIGTERM → wait this long → re-verify → SIGKILL (arch §7.3's "再过 3s"). */
export const REAPER_KILL_AFTER_MS = 3_000;
/** Teardown phase 3: SIGKILL → wait this long → `process.exit(0)` (arch §7.3's "1s 后"). */
export const REAPER_EXIT_AFTER_MS = 1_000;
/** Backstop: the script exits within this budget after stdin EOF, whatever happens. */
export const REAPER_HARD_CAP_MS = 10_000;

export interface ReaperSourceTimings {
  graceMs: number;
  killMs: number;
  exitMs: number;
  hardCapMs: number;
}

export const REAPER_VERIFY_BEGIN = "// __VERIFY_BEGIN__";
export const REAPER_VERIFY_END = "// __VERIFY_END__";

/**
 * The marked verification block of a built script (the embedded `verifyIdentity` and its
 * parsers), for the fixture-parity test that loads it via `new Function`. Throws if the
 * markers are missing — a build regression must fail the test, not silently compare nothing.
 */
export function extractVerifySource(source: string): string {
  const begin = source.indexOf(REAPER_VERIFY_BEGIN);
  const end = source.indexOf(REAPER_VERIFY_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error("reaper source: verify markers missing");
  }
  return source.slice(begin + REAPER_VERIFY_BEGIN.length, end);
}

/**
 * Build the reaper script. `timings` exists for tests (compressing the 5s/3s/1s escalation to
 * millisecond scale while exercising the exact same code path); production callers pass nothing
 * and get arch §7.3's real timings derived from `REAPER_GRACE_MS`.
 */
export function buildReaperSource(opts: { timings?: Partial<ReaperSourceTimings> } = {}): string {
  const t: ReaperSourceTimings = {
    graceMs: REAPER_GRACE_MS,
    killMs: REAPER_KILL_AFTER_MS,
    exitMs: REAPER_EXIT_AFTER_MS,
    hardCapMs: REAPER_HARD_CAP_MS,
    ...opts.timings,
  };
  return `'use strict';
// web-hub spawn reaper (arch §7.3): independent watchdog, detached from the hub's process group.
// NDJSON protocol — up: {op:"track",spawnId,pid,startTicks,bootId,uid} / {op:"untrack",pid};
// down: {ok:"ready"} at boot, then diagnostics only. Never writes disk.
const fs = require('node:fs');
const GRACE_MS = ${t.graceMs};
const KILL_MS = ${t.killMs};
const EXIT_MS = ${t.exitMs};
const HARD_CAP_MS = ${t.hardCapMs};

const tracked = new Map(); // pid -> {spawnId, pid, startTicks, bootId, uid}
let tearingDown = false;

function report(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\\n'); } catch (err) {}
}

${REAPER_VERIFY_BEGIN}
// Algorithmic copy of protocol/proc-identity.ts's verifySpawnedIdentity (arch §7.4) — same
// check order, same reasons, fail-closed. Sync, with injected deps so tests can feed fixtures.
// expected: {pid, startTicks, bootId, uid}; deps: {readFileSync(path) -> string, platform}.
function parseStartTicks(stat) {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const rest = stat.slice(close + 1).trim().split(/\\s+/);
  const raw = rest[19]; // field 22 overall: state(0) ppid(1) ... starttime(19)
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
function parsePgrp(stat) {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const rest = stat.slice(close + 1).trim().split(/\\s+/);
  const raw = rest[2]; // field 5 overall: state(0) ppid(1) pgrp(2)
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
function parseUidLine(status) {
  const lines = status.split('\\n');
  let line;
  for (const l of lines) { if (l.startsWith('Uid:')) { line = l; break; } }
  if (line === undefined) return undefined;
  const nums = line.slice(4).trim().split(/\\s+/).map(Number);
  const real = nums[0];
  const effective = nums[1];
  if (real === undefined || effective === undefined || !Number.isFinite(real) || !Number.isFinite(effective)) {
    return undefined;
  }
  return { real: real, effective: effective };
}
function verifyIdentity(expected, group, deps) {
  if (deps.platform !== 'linux') return { ok: false, reason: 'non-linux' };
  let bootId;
  try { bootId = deps.readFileSync('/proc/sys/kernel/random/boot_id').trim(); }
  catch (err) { bootId = undefined; }
  if (!bootId || bootId !== expected.bootId) return { ok: false, reason: 'boot-mismatch' };
  let stat;
  let status;
  try {
    stat = deps.readFileSync('/proc/' + expected.pid + '/stat');
    status = deps.readFileSync('/proc/' + expected.pid + '/status');
  } catch (err) {
    return { ok: false, reason: 'no-proc' };
  }
  const starttime = parseStartTicks(stat);
  if (starttime === undefined || starttime !== expected.startTicks) return { ok: false, reason: 'starttime-mismatch' };
  const uid = parseUidLine(status);
  if (uid === undefined || uid.real !== expected.uid || uid.effective !== expected.uid) return { ok: false, reason: 'uid-mismatch' };
  if (group) {
    const pgrp = parsePgrp(stat);
    if (pgrp === undefined || pgrp !== expected.pid) return { ok: false, reason: 'pgrp-mismatch' };
  }
  return { ok: true };
}
${REAPER_VERIFY_END}

const procDeps = {
  readFileSync: function (p) { return fs.readFileSync(p, 'utf8'); },
  platform: process.platform,
};

// L5: identity is re-verified synchronously in the same tick right before every signal.
// Group kill (-pid) only when pgrp === pid; on pgrp-mismatch degrade to the single pid
// (identity itself already held at that point — arch §7.4's "退化为只杀单个 pid").
function signalTracked(signal) {
  for (const rec of Array.from(tracked.values())) {
    const v = verifyIdentity(rec, true, procDeps);
    if (v.ok) {
      try {
        process.kill(-rec.pid, signal);
        report({ ok: 'signal', pid: rec.pid, signal: signal, group: true });
      } catch (err) {
        report({ ok: 'signal-failed', pid: rec.pid, signal: signal, group: true, error: String(err && err.message) });
      }
    } else if (v.reason === 'pgrp-mismatch') {
      try {
        process.kill(rec.pid, signal);
        report({ ok: 'signal', pid: rec.pid, signal: signal, group: false });
      } catch (err2) {
        report({ ok: 'signal-failed', pid: rec.pid, signal: signal, group: false, error: String(err2 && err2.message) });
      }
    } else {
      report({ ok: 'skip', pid: rec.pid, signal: signal, reason: v.reason });
      if (v.reason === 'no-proc') tracked.delete(rec.pid); // already dead; stop re-checking it
    }
  }
}

// stdin EOF/error (hub dead or closed): GRACE → TERM → KILL → exit, hard-capped (arch §7.3).
// The teardown timers are deliberately NOT unref'd: after stdin EOF they are the only thing
// keeping this process alive, and HARD_CAP_MS bounds the whole teardown no matter what.
function teardown() {
  if (tearingDown) return;
  tearingDown = true;
  report({ ok: 'teardown', tracked: tracked.size });
  let exited = false;
  function exitNow() {
    if (exited) return;
    exited = true;
    process.exit(0);
  }
  setTimeout(exitNow, HARD_CAP_MS);
  setTimeout(function () {
    signalTracked('SIGTERM');
    setTimeout(function () {
      signalTracked('SIGKILL');
      setTimeout(exitNow, EXIT_MS);
    }, KILL_MS);
  }, GRACE_MS);
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') { report({ ok: 'bad-frame' }); return; }
  if (frame.op === 'track') {
    const pid = frame.pid;
    const startTicks = frame.startTicks;
    const uid = frame.uid;
    if (
      typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 ||
      typeof startTicks !== 'number' || !Number.isFinite(startTicks) ||
      typeof frame.bootId !== 'string' || frame.bootId.length === 0 ||
      typeof uid !== 'number' || !Number.isInteger(uid)
    ) {
      report({ ok: 'bad-frame' });
      return;
    }
    tracked.set(pid, {
      spawnId: typeof frame.spawnId === 'string' ? frame.spawnId : '',
      pid: pid,
      startTicks: startTicks,
      bootId: frame.bootId,
      uid: uid,
    });
    return;
  }
  if (frame.op === 'untrack') {
    if (typeof frame.pid === 'number') tracked.delete(frame.pid);
    return;
  }
  report({ ok: 'bad-frame' });
}

let buf = '';
process.stdin.on('data', function (chunk) {
  buf += chunk;
  for (;;) {
    const idx = buf.indexOf('\\n');
    if (idx < 0) break;
    let line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.endsWith('\\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    let frame;
    try { frame = JSON.parse(line); } catch (err) { report({ ok: 'bad-frame' }); continue; }
    handleFrame(frame);
  }
});
process.stdin.on('end', teardown);
process.stdin.on('error', teardown);
process.stdout.on('error', function () {});

report({ ok: 'ready' });
`;
}
