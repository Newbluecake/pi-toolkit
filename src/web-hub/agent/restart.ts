/**
 * `/webhub restart` (plan §8.2; LE). Two paths:
 *  - the hub is live and advertised `ctl.v1`: `hub_ctl{shutdown}` → wait for
 *    `hub_ctl_ack` (≤2s) → wait for the pid to actually exit (≤5s) →
 *    `spawn()` (fire-and-forget, same launcher path as auto-start). This path
 *    **never reads `/proc`** (plan §11 LE row: "ctl 路径不读 /proc").
 *  - anything else (hub offline, no `ctl.v1`, or the ack/exit deadline blew
 *    past — a hung hub): fall back to `hub.json`'s identity fields. Only a
 *    **safety** check (plan §1.1: prevents signalling a PID that got reused
 *    while the hub was hung; same-uid processes are already fully trusted) —
 *    a P1 hub.json (no `procStartTicks`/`argv`) or a non-Linux platform can't
 *    be verified at all, so `process.kill` is never called for them; the
 *    caller is told to confirm and kill manually instead.
 *
 * Every step is injected (`RestartDeps`) so this module has no I/O of its own
 * and every timer it starts (`delay`) is unref'd.
 */
import { randomUUID } from "node:crypto";
import type { HubCtlAckFrame, HubCtlFrame, LanResFrame } from "../protocol/messages.js";
import { pidAlive as pidAliveProbe } from "../protocol/pid.js";
import type { ExpectedIdentity, IdentityVerdict } from "./proc-identity.js";

const ACK_DEADLINE_MS = 2_000;
const EXIT_DEADLINE_MS = 5_000;
const EXIT_POLL_MS = 100;

export interface HubIdentityRecord {
  pid: number;
  procStartTicks?: number;
  argv?: string[];
}

export interface RestartDeps {
  /** Whether the connection is currently live and the hub advertised `cap` in `hello_ack.caps`. */
  isLiveWithCap: (cap: string) => boolean;
  /** `connection.request()`; only ever called after `isLiveWithCap("ctl.v1")` is true. */
  request: (frame: HubCtlFrame, cap: string) => Promise<HubCtlAckFrame | LanResFrame>;
  /** Current `hub.json` record, or `undefined` if it doesn't exist / can't be read. */
  readHubRecord: () => HubIdentityRecord | undefined;
  /**
   * Liveness probe used ONLY by the ctl happy path's post-ack exit wait.
   * Plan §8.2: the ctl path never reads `/proc` — production wires
   * `ctlLivenessProbe` (kill(pid, 0) only), never the zombie-aware
   * `/proc`-reading `pidAlive`.
   */
  pidAlive: (pid: number) => boolean;
  verifyIdentity: (expected: ExpectedIdentity) => Promise<IdentityVerdict>;
  /** Race-window re-check right before signalling (plan §8.2: "发信号前重新读一次 starttime 比对"). */
  readStartTicksNow: (pid: number) => Promise<number | undefined>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Fire-and-forget hub spawn (reuses the same launcher path as auto-start). */
  spawn: () => void;
  now: () => number;
}

export type RestartOutcome =
  | { kind: "restarted" } // ctl.v1 acked, pid exited, respawned
  | { kind: "signalled" } // fallback SIGTERM, identity verified
  | { kind: "manual"; message: string } // can't be verified — caller must act by hand
  | { kind: "failed"; message: string }; // ctl.v1 acked but the pid never exited, and no safe fallback

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

async function raceAck(deps: RestartDeps): Promise<boolean> {
  const frame: HubCtlFrame = { t: "hub_ctl", rid: randomUUID(), op: "shutdown", reason: "restart" };
  const acked = deps
    .request(frame, "ctl.v1")
    .then((res) => res.t === "hub_ctl_ack")
    .catch(() => false);
  const timedOut = delay(ACK_DEADLINE_MS).then(() => false);
  return Promise.race([acked, timedOut]);
}

async function waitExit(deps: RestartDeps, pid: number): Promise<boolean> {
  const deadline = deps.now() + EXIT_DEADLINE_MS;
  while (deps.now() < deadline) {
    if (!deps.pidAlive(pid)) return true;
    await delay(EXIT_POLL_MS);
  }
  return !deps.pidAlive(pid);
}

function oldHubOrNonLinuxMessage(pid: number): string {
  return (
    `hub（pid ${pid}）是旧版本，无法安全确认身份。` +
    `请执行 \`ps -p ${pid} -o args=\`，确认输出以 …/src/web-hub/hub/main.ts ` +
    `结尾后手动 \`kill ${pid}\`（只需要这一次）；也可以等它空闲自动退出。`
  );
}

function identityRejectedMessage(pid: number, reason: string): string {
  return (
    `hub（pid ${pid}）的进程身份校验未通过（${reason}），` +
    `拒绝发送信号。请手动确认进程身份后再执行 \`kill -TERM ${pid}\`。`
  );
}

async function fallback(deps: RestartDeps): Promise<RestartOutcome> {
  const record = deps.readHubRecord();
  if (record === undefined) {
    return {
      kind: "manual",
      message: "找不到 hub.json，无法安全确认进程身份。请手动重启 hub。",
    };
  }
  if (record.procStartTicks === undefined || record.argv === undefined) {
    return { kind: "manual", message: oldHubOrNonLinuxMessage(record.pid) };
  }
  const expected: ExpectedIdentity = { pid: record.pid, procStartTicks: record.procStartTicks, argv: record.argv };
  const verdict = await deps.verifyIdentity(expected);
  if (!verdict.ok) {
    if (verdict.reason === "non-linux") return { kind: "manual", message: oldHubOrNonLinuxMessage(record.pid) };
    return { kind: "manual", message: identityRejectedMessage(record.pid, verdict.reason) };
  }
  // Race window: the PID could have been reused between the check above and now.
  const recheck = await deps.readStartTicksNow(record.pid);
  if (recheck === undefined || recheck !== record.procStartTicks) {
    return { kind: "manual", message: identityRejectedMessage(record.pid, "starttime-mismatch") };
  }
  deps.kill(record.pid, "SIGTERM");
  return { kind: "signalled" };
}

/**
 * `kill(pid, 0)`-only liveness (plan §8.2: the ctl path reads no `/proc`).
 * `/proc` reads stay confined to the no-ack identity fallback.
 */
export function ctlLivenessProbe(pid: number, kill?: (pid: number, signal: 0) => void): boolean {
  return pidAliveProbe(pid, {
    ...(kill ? { kill } : {}),
    readProcStat: () => {
      throw new Error("ctl path reads no /proc");
    },
  });
}

export async function restartHub(deps: RestartDeps): Promise<RestartOutcome> {
  if (deps.isLiveWithCap("ctl.v1")) {
    if (await raceAck(deps)) {
      const record = deps.readHubRecord();
      const pid = record?.pid;
      const exited = pid === undefined ? true : await waitExit(deps, pid);
      if (exited) {
        deps.spawn();
        return { kind: "restarted" };
      }
      return {
        kind: "failed",
        message: "hub 已确认 shutdown 但 5s 内未退出，未自动重启。",
      };
    }
    // no ack within the deadline: the hub may be hung — fall through to the /proc fallback.
  }
  return fallback(deps);
}
