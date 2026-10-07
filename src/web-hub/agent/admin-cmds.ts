/**
 * `/webhub token rotate` / `/webhub stop` / `/webhub start` agent-side facade (plan §6.7.1/§6.7.2,
 * C8). `createAdminCommands()` is called with **zero** arguments at its one production call
 * site (`agent/index.ts:713`, owned by C1 — "W3 起无人再改，C11/C8 所需接线 C0 已写好"), so every
 * runtime dependency this module needs is reached lazily, at call time, instead of being
 * threaded through a constructor:
 *  - the live hub connection: `connection.ts`'s module-level `currentConnection()` singleton
 *    accessor (never a closure captured at construction time — the connection can be
 *    torn down/recreated across `/reload`, and `currentConnection()` always returns whichever one
 *    is live right now);
 *  - on-disk paths (`stopped`, `rotate.intent`, `token`, `hub.json`): recomputed independently via
 *    `resolveHubPaths()`, the exact same pure function `agent/index.ts` itself calls with the same
 *    inputs (`HOME`/`getuid()`/`XDG_RUNTIME_DIR`) — deterministic, so this always agrees with
 *    whatever `Connection.opts.paths` the live connection was constructed with.
 *
 * Every op writes the stop/rotate marker files directly (protocol-level, pure fs) and/or talks to
 * the hub over the existing `HubConnection.request()` channel — no new I/O primitives.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { HubCtlAckFrame, HubCtlFrame, LanResFrame } from "../protocol/messages.js";
import { resolveHubPaths, webHubSpawnFiles, type HubPaths } from "../protocol/paths.js";
import {
  advanceRotateIntentSync,
  newRotateIntentId,
  removeRotateIntentSync,
  writeRotateIntentSync,
  type RotateIntent,
} from "../protocol/rotate-intent.js";
import { generateToken, replaceTokenAtomic } from "../protocol/token-file.js";
import {
  readStopMarkerSync,
  removeStopMarkerSync,
  writeStopMarkerSync,
  type StopMarkerRead,
} from "../protocol/stop-marker.js";
import { currentConnection } from "./connection.js";
import { ctlLivenessProbe, restartHub, stopHub, type RestartOutcome } from "./restart.js";
import { verifyProcIdentity, readStartTicksNow } from "./proc-identity.js";

export type RotateOutcome =
  | { kind: "rotated"; path: "online"; revoked: { loopback: number; lan: number } }
  | { kind: "unknown" } // ack timed out; the hub may still finish it (recovery scan)
  | { kind: "offline" } // agent completed ①②③ itself, by:"agent"; hub DB untouched
  | { kind: "stale-hub" } // live but no ctl.v2
  | { kind: "error"; message: string };

export type StopOutcome = { kind: "stopped" } | { kind: "marker-write-failed"; message: string } | RestartOutcome; // signalled / manual / failed (never "restarted" — stop never spawns)

export type StartOutcome = { kind: "started" } | { kind: "started-marker-remove-failed"; code: string };

/** §6.7.2: `/webhub open` and `/webhub restart` are explicit intents too — they remove the stop
 * marker (ENOENT counts as success) without spawning (the caller's own flow does that). */
export type ClearStopMarkerOutcome = { kind: "cleared" } | { kind: "clear-failed"; code: string };

export interface AdminCommands {
  stop(): Promise<StopOutcome>;
  start(): Promise<StartOutcome>;
  clearStopMarker(): Promise<ClearStopMarkerOutcome>;
  rotateToken(): Promise<RotateOutcome>;
}

const ROTATE_ACK_TIMEOUT_MS = 3_000;

function currentPaths(): HubPaths & { stoppedFile: string; rotateIntentFile: string } {
  const home = process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir();
  const paths = resolveHubPaths({
    home,
    uid: process.getuid?.() ?? 0,
    xdgRuntimeDir:
      process.env.XDG_RUNTIME_DIR !== undefined && process.env.XDG_RUNTIME_DIR !== ""
        ? process.env.XDG_RUNTIME_DIR
        : undefined,
  });
  // `resolveHubPaths` always sets both (the optional `?` on `HubPaths` exists purely so hand-built
  // test doubles elsewhere don't have to supply them) — the fallback here only guards against a
  // future signature drift, never exercised in production.
  return {
    ...paths,
    stoppedFile: paths.stoppedFile ?? `${paths.stateDir}/stopped`,
    rotateIntentFile: paths.rotateIntentFile ?? `${paths.stateDir}/rotate.intent`,
  };
}

interface HubJsonSnapshot {
  pid?: number;
  procStartTicks?: number;
  argv?: string[];
}

/** Mirrors `agent/index.ts`'s own local `readHubJsonRecord` (that file is out of this package's
 * exclusive list — C1's, "W3 起无人再改" — so this is a small, deliberate, read-only duplicate). */
function readHubJsonRecord(paths: HubPaths): HubJsonSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(paths.hubJson, "utf8")) as Record<string, unknown>;
    const rec: HubJsonSnapshot = {};
    if (typeof parsed.pid === "number") rec.pid = parsed.pid;
    if (typeof parsed.procStartTicks === "number") rec.procStartTicks = parsed.procStartTicks;
    if (Array.isArray(parsed.argv) && parsed.argv.every((a) => typeof a === "string")) {
      rec.argv = parsed.argv as string[];
    }
    return rec;
  } catch {
    return undefined;
  }
}

function isLiveWithCap(cap: string): boolean {
  const c = currentConnection();
  return c !== undefined && c.status().state === "live" && c.caps.includes(cap);
}

function respawnSoon(): void {
  // §8.2/§6.7.2: `/webhub restart`'s spawn path lives entirely inside `agent/index.ts`'s own
  // closure (`resolveLauncher()`/`buildHubConfig()`/`deps.spawnImpl`, none of which are reachable
  // from this zero-arg-constructed module — that file is C1's, "W3 起无人再改"). There is also no
  // safe public `HubConnection` method to force an immediate reconnect attempt: `close()` tears
  // the link down *permanently* (`this.link = "closed"`, never reconnects again on its own) —
  // calling it here to "nudge" a respawn would be strictly worse than doing nothing. So this is
  // deliberately a no-op: the connection's own backoff loop already retries on a bounded cadence
  // (≤ `TIMING.backoffMaxMs` = 30s) regardless of the marker, and once C10 (W4) wires the stop
  // marker into `connection.ts`'s `maybeSpawn` (per `launcher.ts`'s own doc comment), that same
  // loop's very next attempt will succeed as soon as the marker is gone. Flagged in the delivery
  // report: true "立即 spawn" parity with `/webhub restart` needs either `agent/index.ts` wiring
  // (C1, out of this package's file list) or waiting for that same W4 unfreeze.
}

function restartDeps(): Parameters<typeof restartHub>[0] {
  const paths = currentPaths();
  return {
    isLiveWithCap,
    request: async (frame: HubCtlFrame, cap: string): Promise<HubCtlAckFrame | LanResFrame> => {
      const c = currentConnection();
      if (c === undefined) throw new Error("E_NOT_CONNECTED");
      return c.request(frame, cap);
    },
    readHubRecord: () => {
      const rec = readHubJsonRecord(paths);
      if (rec?.pid === undefined) return undefined;
      const out: { pid: number; procStartTicks?: number; argv?: string[] } = { pid: rec.pid };
      if (rec.procStartTicks !== undefined) out.procStartTicks = rec.procStartTicks;
      if (rec.argv !== undefined) out.argv = rec.argv;
      return out;
    },
    pidAlive: (pid: number) => ctlLivenessProbe(pid),
    verifyIdentity: (expected) => verifyProcIdentity(expected),
    readStartTicksNow: (pid: number) => readStartTicksNow(pid),
    kill: (pid: number, signal: NodeJS.Signals) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone — nothing to signal */
      }
    },
    spawn: respawnSoon,
    now: Date.now,
  };
}

/**
 * web-hub-spawn-restore plan D13/§10.5: `/webhub stop` leaves a one-shot `restore.veto` the next
 * hub boot consumes, so a stop that had to fall back to SIGTERM (a wedged hub that never ran its
 * close handler, records still `live` on disk) is still never followed by a restore. Best-effort:
 * a failure never blocks the stop (returned for the caller/tests, never thrown).
 */
export function writeRestoreVetoSync(stateDir: string): { ok: true } | { ok: false; code: string } {
  const file = webHubSpawnFiles(stateDir).restoreVeto;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ v: 1, at: Date.now(), pid: process.pid })}\n`, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
  }
}

/** D13: an explicit `/webhub restart` overrides an earlier stop's veto (ENOENT counts as success). */
export function clearRestoreVetoSync(stateDir: string): { ok: true } | { ok: false; code: string } {
  try {
    unlinkSync(webHubSpawnFiles(stateDir).restoreVeto);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    return code === "ENOENT" ? { ok: true } : { ok: false, code };
  }
}

/** §6.7.2 "unknown" classification helper — used both for the initial read and (defensively) if
 * the intermediate write/advance throws. */
function stopMarkerReadable(read: StopMarkerRead): boolean {
  return read.state !== "unknown";
}

export function createAdminCommands(): AdminCommands {
  return {
    async stop(): Promise<StopOutcome> {
      const paths = currentPaths();
      // §6.7.2: write the marker FIRST; a write failure must never stop the hub (it would just
      // get pulled straight back up by any other live TUI's auto-start).
      try {
        writeStopMarkerSync(paths.stoppedFile);
      } catch (err) {
        return { kind: "marker-write-failed", message: err instanceof Error ? err.message : String(err) };
      }
      // web-hub-spawn-restore D13: after the stop marker, before stopHub(); failure never blocks.
      writeRestoreVetoSync(paths.stateDir);
      const outcome = await stopHub(restartDeps());
      if (outcome.kind === "restarted") {
        // stopHub() itself never spawns; "restarted" cannot actually happen from it. Defensive
        // narrowing only — treat it identically to a clean stop.
        return { kind: "stopped" };
      }
      if (outcome.kind === "signalled" || outcome.kind === "failed") {
        // Both still mean the hub is gone (or presumed gone / being killed); the marker already
        // prevents any auto-restart either way.
        return outcome.kind === "signalled" ? { kind: "stopped" } : outcome;
      }
      return outcome; // "manual"
    },

    async start(): Promise<StartOutcome> {
      const paths = currentPaths();
      try {
        removeStopMarkerSync(paths.stoppedFile);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
        respawnSoon(); // §6.7.2: "删除失败仍按显式意图 spawn 一次"
        return { kind: "started-marker-remove-failed", code };
      }
      respawnSoon();
      return { kind: "started" };
    },

    async clearStopMarker(): Promise<ClearStopMarkerOutcome> {
      try {
        removeStopMarkerSync(currentPaths().stoppedFile);
        return { kind: "cleared" };
      } catch (err) {
        return { kind: "clear-failed", code: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
      }
    },

    async rotateToken(): Promise<RotateOutcome> {
      const conn = currentConnection();
      const live = conn !== undefined && conn.status().state === "live";
      if (live && conn.caps.includes("ctl.v2")) {
        const frame: HubCtlFrame = {
          t: "hub_ctl",
          rid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          op: "rotate_token",
        };
        try {
          const ack = await Promise.race([
            conn.request(frame, "ctl.v2"),
            new Promise<undefined>((resolve) => {
              const t = setTimeout(() => resolve(undefined), ROTATE_ACK_TIMEOUT_MS);
              t.unref();
            }),
          ]);
          if (ack === undefined) return { kind: "unknown" };
          if (ack.t !== "hub_ctl_ack") return { kind: "error", message: `E_UNEXPECTED_FRAME: ${ack.t}` };
          const revoked = ack.revoked ?? { loopback: 0, lan: 0 };
          return { kind: "rotated", path: "online", revoked };
        } catch (err) {
          return { kind: "error", message: err instanceof Error ? err.message : String(err) };
        }
      }
      if (live) {
        // live but the hub never advertised ctl.v2 (an older P2 hub, pre-C8).
        return { kind: "stale-hub" };
      }
      // §6.7.1 "hub 离线": no live link — do ①②③ ourselves (`by:"agent"`); never ④⑤ (LAN
      // sessions live in the hub's own db, which this process has no business touching directly).
      const paths = currentPaths();
      const intent: RotateIntent = {
        v: 1,
        id: newRotateIntentId(),
        at: Date.now(),
        by: "agent",
        pid: process.pid,
        phase: "intent",
      };
      try {
        writeRotateIntentSync(paths.rotateIntentFile, intent);
        replaceTokenAtomic(paths.tokenFile, generateToken());
        advanceRotateIntentSync(paths.rotateIntentFile, intent, "token-written");
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
      return { kind: "offline" };
    },
  };
}

// Re-exported purely so `commands/webhub.ts`'s tests can construct a `StopMarkerRead` without a
// second import path; not used by this module's own logic beyond the readability check above.
export type { StopMarkerRead };
export { stopMarkerReadable, readStopMarkerSync };
