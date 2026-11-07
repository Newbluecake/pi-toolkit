#!/usr/bin/env -S npx tsx
/**
 * scripts/release/restart-hub.ts — ask the running web-hub to restart (D of the "version mismatch
 * after every release" fix). Called best-effort by `scripts/release/release.sh` after a release
 * is published; also usable by hand:  npx tsx scripts/release/restart-hub.ts [--wait-ms N]
 *
 * Semantics == `/webhub restart`: it reuses `restartHub` from `src/web-hub/agent/restart.ts`
 * (hub_ctl{shutdown,"restart"} → ack ≤2 s → wait for the pid to exit; if the hub never acks, the
 * same identity-verified SIGTERM fallback, or a manual instruction when identity cannot be proven).
 * The hub answers a restart with a `superseded` frame to every connected agent and, with
 * `webHub.spawn.restore`, tags its managed sessions for restore — exactly as for the TUI command.
 *
 * What it deliberately does NOT do: spawn the replacement hub. A `HubConfig` is built from the
 * user's settings inside a pi agent (`buildHubConfig`); re-deriving it here would fork that logic.
 * Every connected pi session reconnects and respawns the hub on its own (that is also what
 * `/webhub restart` relies on after its own exit wait). Since the hub now reads its version from
 * the package it was loaded from (`hub/self-version.ts`), WHICHEVER session wins that respawn race
 * — even one whose cached build info predates the release — brings up a hub at the on-disk
 * version. After the old hub exits this script polls hub.json and reports whether the new hub's
 * version equals `package.json`; "nobody respawned it yet" is an INFO, not a failure.
 *
 * Skips (exit 0, one INFO line): no hub.json / pid not alive (nothing running), `webHub` never ran,
 * or the stop marker is set (the user ran `/webhub stop` — never resurrect it). Every wait is
 * bounded; every timer unref'd. Exit codes: 0 restarted/skipped, 1 could not restart (caller
 * prints WARN and carries on — a release is never failed by this step).
 *
 * Imports only `node:*` and pi-free protocol/agent-restart modules (no pi, no hub assembly).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

import {
  ctlLivenessProbe,
  restartHub,
  type RestartDeps,
  type RestartOutcome,
} from "../../src/web-hub/agent/restart.js";
import { verifyProcIdentity } from "../../src/web-hub/agent/proc-identity.js";
import {
  decodeHubFrame,
  type HubCtlAckFrame,
  type HubCtlFrame,
  type LanResFrame,
} from "../../src/web-hub/protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import { resolveHubPaths, type HubPaths } from "../../src/web-hub/protocol/paths.js";
import { pidAlive } from "../../src/web-hub/protocol/pid.js";
import { readStartTicksNow } from "../../src/web-hub/protocol/proc-identity.js";
import { readStopMarkerSync } from "../../src/web-hub/protocol/stop-marker.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";

export const HELLO_TIMEOUT_MS = 3_000;
export const DEFAULT_WAIT_NEW_HUB_MS = 20_000;
const NEW_HUB_POLL_MS = 250;

export type RestartHubResult =
  | { kind: "skipped"; reason: "no-hub" | "stopped" | "no-ctl" }
  | { kind: "restarted"; oldPid: number; newHub: NewHubObservation }
  | { kind: "failed"; message: string };

export type NewHubObservation =
  { state: "up"; pid: number; version: string; matchesDisk: boolean | undefined } | { state: "not-yet" };

export interface HubRecordView {
  pid?: number;
  version?: string;
  procStartTicks?: number;
  argv?: string[];
}

export interface RestartHubDeps {
  readonly paths: HubPaths;
  /** `package.json`'s version of THIS checkout — what a correct new hub must report. */
  readonly diskVersion: () => string | undefined;
  readonly readRecord: () => HubRecordView | undefined;
  readonly stopMarkerSet: () => boolean;
  /** Connect + hello; resolves a live control channel, or why there is none. */
  readonly connect: () => Promise<
    | { ok: true; caps: readonly string[]; request: RestartDeps["request"]; close: () => void }
    | { ok: false; reason: "no-socket" | "rejected" | "timeout" }
  >;
  readonly restartDeps: Omit<RestartDeps, "isLiveWithCap" | "request" | "spawn">;
  readonly waitNewHubMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (level: "INFO" | "OK" | "WARN", msg: string) => void;
}

/** Pure orchestration; all I/O through `deps`, so it is unit-testable without a hub. */
export async function restartRunningHub(deps: RestartHubDeps): Promise<RestartHubResult> {
  const rec = deps.readRecord();
  if (rec?.pid === undefined || !pidAlive(rec.pid)) {
    deps.log("INFO", "no running web-hub (no live hub.json) — nothing to restart");
    return { kind: "skipped", reason: "no-hub" };
  }
  if (deps.stopMarkerSet()) {
    deps.log("INFO", "web-hub was stopped with /webhub stop — leaving it stopped");
    return { kind: "skipped", reason: "stopped" };
  }
  const oldPid = rec.pid;
  const link = await deps.connect();
  let outcome: RestartOutcome;
  if (link.ok) {
    try {
      if (!link.caps.includes("ctl.v1")) {
        deps.log(
          "WARN",
          `hub ${oldPid} has no ctl.v1 (too old to restart over the socket) — restart it by hand: /webhub restart`,
        );
        return { kind: "skipped", reason: "no-ctl" };
      }
      outcome = await restartHub({
        ...deps.restartDeps,
        isLiveWithCap: (cap) => link.caps.includes(cap),
        request: link.request,
        // The replacement is spawned by the reconnecting pi sessions (see header).
        spawn: () => undefined,
      });
    } finally {
      link.close();
    }
  } else {
    // No usable channel (stale socket, hello rejected, hung hub): the same identity-verified
    // fallback `/webhub restart` uses when the ctl path is unavailable.
    outcome = await restartHub({
      ...deps.restartDeps,
      isLiveWithCap: () => false,
      request: async () => {
        throw new Error("E_NOT_CONNECTED");
      },
      spawn: () => undefined,
    });
  }
  switch (outcome.kind) {
    case "restarted":
    case "signalled": {
      if (outcome.kind === "signalled") await waitGone(deps, oldPid);
      deps.log(
        "INFO",
        `hub ${oldPid} ${outcome.kind === "signalled" ? "signalled (SIGTERM)" : "shut down"}; waiting for a session to respawn it`,
      );
      return { kind: "restarted", oldPid, newHub: await observeNewHub(deps, oldPid) };
    }
    case "manual":
    case "failed":
      return { kind: "failed", message: outcome.message };
  }
}

async function waitGone(deps: RestartHubDeps, pid: number): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end && deps.restartDeps.pidAlive(pid)) await deps.sleep(100);
}

async function observeNewHub(deps: RestartHubDeps, oldPid: number): Promise<NewHubObservation> {
  const end = Date.now() + deps.waitNewHubMs;
  for (;;) {
    const rec = deps.readRecord();
    if (rec?.pid !== undefined && rec.pid !== oldPid && pidAlive(rec.pid) && typeof rec.version === "string") {
      const disk = deps.diskVersion();
      return {
        state: "up",
        pid: rec.pid,
        version: rec.version,
        matchesDisk: disk === undefined ? undefined : disk === rec.version,
      };
    }
    if (Date.now() >= end) return { state: "not-yet" };
    await deps.sleep(NEW_HUB_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// real I/O
// ---------------------------------------------------------------------------

function readRecordFrom(file: string): HubRecordView | undefined {
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: HubRecordView = {};
    if (typeof p["pid"] === "number") out.pid = p["pid"];
    if (typeof p["version"] === "string") out.version = p["version"];
    if (typeof p["procStartTicks"] === "number") out.procStartTicks = p["procStartTicks"];
    if (Array.isArray(p["argv"]) && p["argv"].every((a) => typeof a === "string")) out.argv = p["argv"] as string[];
    return out;
  } catch {
    return undefined;
  }
}

/** Minimal agent-protocol client: hello → hello_ack → request/ack. No registry-visible session. */
export function connectControl(paths: HubPaths, timeoutMs = HELLO_TIMEOUT_MS): ReturnType<RestartHubDeps["connect"]> {
  return new Promise((resolve) => {
    const sock = net.connect(paths.socketPath);
    sock.unref();
    let settled = false;
    const waiters = new Map<string, (f: HubCtlAckFrame | LanResFrame) => void>();
    const finish = (v: Awaited<ReturnType<RestartHubDeps["connect"]>>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    timer.unref();
    const decoder = new NdjsonDecoder({
      onFrame: (raw) => {
        const f = decodeHubFrame(raw);
        if (f === undefined) return;
        if (f.t === "hello_ack") {
          finish({
            ok: true,
            caps: f.caps ?? [],
            close: () => sock.destroy(),
            request: (frame: HubCtlFrame) =>
              new Promise<HubCtlAckFrame | LanResFrame>((res, rej) => {
                waiters.set(frame.rid, res);
                sock.once("close", () => rej(new Error("E_CONN_LOST")));
                sock.write(encodeFrame(frame));
              }),
          });
        } else if (f.t === "hello_reject") {
          sock.destroy();
          finish({ ok: false, reason: "rejected" });
        } else if (f.t === "hub_ctl_ack" || f.t === "lan_res") {
          const w = waiters.get(f.rid);
          if (w !== undefined) {
            waiters.delete(f.rid);
            w(f);
          }
        }
      },
      onError: () => {},
    });
    sock.on("data", (c) => decoder.push(c));
    sock.on("error", () => finish({ ok: false, reason: "no-socket" }));
    sock.on("connect", () => {
      sock.write(
        encodeFrame({
          t: "hello",
          proto: { major: PROTO.major, minor: PROTO.minor },
          // 0.0.0 can never be "newer than the hub", so this hello never feeds supersede.observe.
          pluginVersion: "0.0.0",
          buildId: "0.0.0@release-restart",
          agentId: { pid: process.pid, nonce: randomBytes(12).toString("base64url") },
          epoch: randomBytes(6).toString("hex"),
          kind: "rpc",
          launcher: [process.execPath, "restart-hub"],
          cwd: process.cwd(),
          caps: [],
        }),
      );
    });
  });
}

export function realDeps(opts: { home: string; waitNewHubMs: number }): RestartHubDeps {
  const paths = resolveHubPaths({
    home: opts.home,
    uid: process.getuid?.() ?? 0,
    xdgRuntimeDir:
      process.env["XDG_RUNTIME_DIR"] !== undefined && process.env["XDG_RUNTIME_DIR"] !== ""
        ? process.env["XDG_RUNTIME_DIR"]
        : undefined,
  });
  const stopFile = paths.stoppedFile ?? join(paths.stateDir, "stopped");
  return {
    paths,
    diskVersion: () => {
      try {
        const v = (
          JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown }
        ).version;
        return typeof v === "string" ? v : undefined;
      } catch {
        return undefined;
      }
    },
    readRecord: () => readRecordFrom(paths.hubJson),
    stopMarkerSet: () => readStopMarkerSync(stopFile).state !== "absent",
    connect: () => connectControl(paths),
    restartDeps: {
      readHubRecord: () => {
        const r = readRecordFrom(paths.hubJson);
        if (r?.pid === undefined) return undefined;
        const out: { pid: number; procStartTicks?: number; argv?: string[] } = { pid: r.pid };
        if (r.procStartTicks !== undefined) out.procStartTicks = r.procStartTicks;
        if (r.argv !== undefined) out.argv = r.argv;
        return out;
      },
      pidAlive: (pid) => ctlLivenessProbe(pid),
      verifyIdentity: (expected) => verifyProcIdentity(expected),
      readStartTicksNow: (pid) => readStartTicksNow(pid),
      kill: (pid, signal) => {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      },
      now: Date.now,
    },
    waitNewHubMs: opts.waitNewHubMs,
    sleep: (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms);
        t.unref();
      }),
    log: (level, msg) => {
      const tag = level === "WARN" ? "[WARN]" : level === "OK" ? "[OK]" : "[INFO]";
      process.stdout.write(`${tag} hub-restart: ${msg}\n`);
    },
  };
}

/** Maps a result to the process exit code and the user-facing summary lines. */
export function reportResult(r: RestartHubResult, log: RestartHubDeps["log"]): number {
  switch (r.kind) {
    case "skipped":
      return 0;
    case "failed":
      log("WARN", `could not restart the hub: ${r.message}`);
      return 1;
    case "restarted":
      if (r.newHub.state === "not-yet") {
        log(
          "INFO",
          "no pi session respawned the hub yet — it will start (at the on-disk version) with the next pi session",
        );
      } else if (r.newHub.matchesDisk === false) {
        log(
          "WARN",
          `new hub (pid ${r.newHub.pid}) reports v${r.newHub.version}, which differs from this checkout — check hub.log`,
        );
      } else {
        log(
          "OK",
          `hub restarted: new pid ${r.newHub.pid}, v${r.newHub.version}${r.newHub.matchesDisk === true ? " (matches package.json)" : ""}`,
        );
      }
      return 0;
  }
}

export function parseWaitMs(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const i = argv.indexOf("--wait-ms");
  const raw = i >= 0 ? argv[i + 1] : env["PI_TOOLKIT_HUB_RESTART_WAIT_MS"];
  if (raw === undefined || !/^[0-9]{1,6}$/.test(raw)) return DEFAULT_WAIT_NEW_HUB_MS;
  return Math.min(120_000, Number(raw));
}

async function main(): Promise<void> {
  const env = process.env;
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  const deps = realDeps({ home, waitNewHubMs: parseWaitMs(process.argv.slice(2), env) });
  let code = 1;
  // Every socket/timer below is unref'd (I5), so on its own Node would exit silently mid-await.
  // This ONE ref'd timer is both the keepalive and the hard overall deadline of the whole run
  // (hello ≤3 s + ack ≤2 s + exit ≤5 s + fallback + new-hub wait ≤120 s); process.exit ends it.
  const watchdog = setTimeout(() => {
    deps.log("WARN", "timed out — gave up waiting for the hub");
    process.exit(1);
  }, deps.waitNewHubMs + 60_000);
  try {
    code = reportResult(await restartRunningHub(deps), deps.log);
  } catch (err) {
    deps.log("WARN", `unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(code);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
