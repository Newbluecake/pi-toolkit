/**
 * web-hub agent client wiring (plan §包 D — index.ts; arch §3.2).
 *
 * `wireWebHub` runs once per `activate()` (post-guard, gated by
 * `settings.webHub.enabled` in src/index.ts — package I). It registers every
 * handler up front; handlers are synchronous and return on their first line
 * while not attached. print/json modes never attach ⇒ zero sockets, zero
 * spawns, zero git calls.
 *
 * Session lifetime (spike K4, two paths):
 *  1. same module instance (`/new`, `/resume`, `/fork`): `session_shutdown`
 *     detaches (session_detached + 10s grace), the re-run activate finds the
 *     global connection with the same implVersion and reuses the socket; the new
 *     `session_start` attaches and sends a fresh `session` frame;
 *  2. re-evaluated module (`/reload`): new implVersion ⇒ the old instance says
 *     `bye{handover}`, the new one reconnects with the same agentId / new epoch.
 * An activate without a matching session_start takes no connection.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "../../core/types.js";
import { defaultPluginInfoDeps, pluginRoot, readPluginInfo } from "../../hud/plugin-info.js";
import type { HubConfig } from "../hub/ports.js";
import { FORWARDED_EVENTS, type AgentKind, type SessionInfo } from "../protocol/messages.js";
import { resolveHubPaths, type HubPaths } from "../protocol/paths.js";
import { pidAlive } from "../protocol/pid.js";
import {
  acquireConnection,
  currentConnection,
  MODULE_INSTANCE,
  type BindingPort,
  type HubConnection,
} from "./connection.js";
import { createEventTap } from "./event-tap.js";
import { resolveJitiCli, spawnHub, type LauncherPlan } from "./launcher.js";
import { buildBranchReply, buildSnapshotReply } from "./snapshot.js";
import { fleetFingerprint, projectFleet, readStatus } from "./status.js";

export interface WebHubSettings {
  enabled: boolean;
  autoStart: boolean;
  port: number;
  idleExitMinutes: number;
  nodeLoader: string;
} // I 在 settings.ts `import type` 并 re-export（D 不改 settings.ts）

export interface WebHubDeps {
  settings: WebHubSettings;
  fleet: () => readonly RunSnapshot[]; // I: () => holder.current?.query.list() ?? []
  fleetTypeOf?: (runId: string) => string | undefined;
  hubMainPath?: string; // 默认 fileURLToPath(new URL("../hub/main.ts", import.meta.url))
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // ---- test seams (optional; production leaves them unset) ----
  netConnect?: typeof import("node:net").connect;
  spawnImpl?: typeof import("node:child_process").spawn;
  paths?: HubPaths;
  buildInfo?: () => Promise<{ pluginVersion: string; buildId: string }>;
  argv1?: string;
}

export interface WebHubStatusView {
  state: "off" | "connecting" | "live" | "backoff" | "loader" | "proto";
  agentKey?: string;
  hubVersion?: string;
  httpPort?: number;
  lastError?: string;
  attached: boolean;
}

export interface WebHubControl {
  status(): WebHubStatusView;
  /** http://127.0.0.1:<port>/#t=<token>; port from hello_ack (live) or hub.json (pid alive); else a hint. */
  url(): { url: string } | { hint: string };
}

export const WEB_HUB_STATUS_KEY = "pi-subagent:web-hub";
const BUILD_INFO_WAIT_MS = 3_000;

const STATUS_EVENTS = new Set(["agent_start", "agent_end", "agent_settled", "turn_end", "session_compact"]);
const SESSION_EVENTS = new Set(["model_select", "thinking_level_select", "session_info_changed"]);

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export function wireWebHub(pi: ExtensionAPI, deps: WebHubDeps): WebHubControl {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const settings = deps.settings;
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const paths =
    deps.paths ??
    resolveHubPaths({
      home,
      uid: process.getuid?.() ?? 0,
      xdgRuntimeDir: env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "" ? env.XDG_RUNTIME_DIR : undefined,
    });
  const hubMainPath = deps.hubMainPath ?? fileURLToPath(new URL("../hub/main.ts", import.meta.url));
  const argv1 = deps.argv1 ?? process.argv[1];

  let ctx: ExtensionContext | undefined;
  let conn: HubConnection | undefined;
  let attached = false;
  let generation = 0;
  let sessionReason = "startup";
  let lastLeaf: string | null | undefined;
  let lastFleetFp: string | undefined;
  let tick: NodeJS.Timeout | undefined;
  let statusText: string | undefined;
  let buildInfo: Promise<{ pluginVersion: string; buildId: string }> | undefined;
  let launcher: LauncherPlan | { error: string } | undefined;

  const tap = createEventTap(
    (e, droppable) => {
      const c = conn;
      if (c === undefined) return;
      c.send({ t: "ev", seq: c.nextSeq(), e }, { droppable });
    },
    {
      now,
      setTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return { cancel: () => clearTimeout(t) };
      },
      currentSeq: () => conn?.seq ?? 0,
    },
  );

  const readFleet = (): readonly RunSnapshot[] => {
    try {
      return deps.fleet();
    } catch {
      return [];
    }
  };

  const setStatusLine = (text: string | undefined): void => {
    const c = ctx;
    if (c === undefined || text === statusText) return;
    try {
      if (c.mode !== "tui" || !c.hasUI) return;
      c.ui.setStatus(WEB_HUB_STATUS_KEY, text);
      statusText = text;
    } catch {
      /* stale ctx */
    }
  };

  const publishStatus = (): void => {
    const c = conn;
    const x = ctx;
    if (c === undefined || x === undefined) return;
    const s = readStatus(x, tap, readFleet());
    lastLeaf = s.leafId;
    c.setSlot("status", { t: "status", ...s });
  };

  const publishSession = (override?: Partial<SessionInfo>): void => {
    const c = conn;
    const x = ctx;
    if (c === undefined || x === undefined) return;
    c.setSlot("session", { t: "session", ...sessionInfo(x, sessionReason), ...override });
  };

  const onTick = (): void => {
    const c = conn;
    const x = ctx;
    if (!attached || c === undefined || x === undefined) return;
    try {
      // spike K7④: idle custom_message never reaches extensions — a leaf move is the only signal.
      const leaf = x.sessionManager.getLeafId();
      if (leaf !== lastLeaf) publishStatus();
    } catch {
      /* stale ctx */
    }
    const rows = projectFleet(readFleet(), now(), deps.fleetTypeOf);
    const fp = fleetFingerprint(rows);
    if (fp !== lastFleetFp) {
      lastFleetFp = fp;
      c.setSlot("fleet", { t: "fleet", runs: rows });
    }
  };

  const binding: BindingPort = {
    onSnapshotReq: (rid) => {
      const c = conn;
      const x = ctx;
      if (!attached || c === undefined || x === undefined) return;
      tap.flush(); // pending deltas get their seq BEFORE the snapshot's seq is read
      const snaps = readFleet();
      c.send(
        buildSnapshotReply(rid, {
          seq: c.seq,
          ctx: x,
          tap,
          status: readStatus(x, tap, snaps),
          fleet: projectFleet(snaps, now(), deps.fleetTypeOf),
        }),
      );
    },
    onBranchReq: (rid, maxBytes) => {
      const c = conn;
      const x = ctx;
      if (!attached || c === undefined || x === undefined) return;
      c.send(buildBranchReply(rid, x, maxBytes));
    },
    onStateChange: (v) => {
      if (attached) setStatusLine(statusLineText(v));
    },
  };

  const getBuildInfo = (): Promise<{ pluginVersion: string; buildId: string }> => {
    buildInfo ??= (deps.buildInfo ?? defaultBuildInfo)();
    const fallbackVersion = packageVersionSync();
    return new Promise((resolve) => {
      const fallback = { pluginVersion: fallbackVersion, buildId: `${fallbackVersion}@unknown` };
      const t = setTimeout(() => resolve(fallback), BUILD_INFO_WAIT_MS);
      t.unref();
      buildInfo!.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve(fallback);
        },
      );
    });
  };

  const resolveLauncher = (): LauncherPlan | { error: string } => {
    if (launcher !== undefined) return launcher;
    const r = resolveJitiCli({ argv1, override: settings.nodeLoader });
    launcher = r.ok ? { execPath: process.execPath, jitiCli: r.jitiCli, argv1: argv1 ?? "" } : { error: r.reason };
    return launcher;
  };

  const connectWith = (info: { pluginVersion: string; buildId: string }): void => {
    const x = ctx;
    if (!attached || x === undefined) return;
    const plan = resolveLauncher();
    const config: HubConfig = {
      v: 1,
      home,
      port: settings.port,
      idleExitMinutes: settings.idleExitMinutes,
      pluginVersion: info.pluginVersion,
      buildId: info.buildId,
    };
    if (argv1 !== undefined) config.launcher = [process.execPath, argv1];
    const c = acquireConnection({
      buildId: info.buildId,
      pluginVersion: info.pluginVersion,
      kind: x.mode as AgentKind,
      cwd: safe(() => x.cwd, process.cwd()),
      paths,
      settings,
      launcher: plan,
      now,
      ...(deps.netConnect !== undefined ? { netConnect: deps.netConnect } : {}),
      headless: env.PI_WEBHUB_HEADLESS === "1",
      spawn: () => {
        if (!("error" in plan)) spawnHub(plan, hubMainPath, config, deps.spawnImpl);
      },
    });
    conn = c;
    c.attach(binding, sessionInfo(x, sessionReason));
    publishStatus();
    onTick();
    setStatusLine(statusLineText(c.status()));
  };

  const startTick = (): void => {
    if (tick !== undefined) return;
    tick = setInterval(onTick, 1_000);
    tick.unref();
  };
  const stopTick = (): void => {
    if (tick !== undefined) clearInterval(tick);
    tick = undefined;
  };

  const on = pi.on.bind(pi) as unknown as (event: string, handler: AnyHandler) => void;

  on("session_start", (event, c) => {
    if (c.mode !== "tui" && c.mode !== "rpc") return; // print/json: never attach
    generation += 1;
    const gen = generation;
    ctx = c;
    attached = true;
    sessionReason = reasonOf(event);
    lastLeaf = undefined;
    lastFleetFp = undefined;
    tap.resetForSession(Number.NaN);
    // O(branch entries) cost sum, deferred so session_start returns at once.
    const im = setImmediate(() => {
      if (gen !== generation) return;
      tap.setBaseCost(branchCost(c));
      publishStatus();
    });
    im.unref();
    startTick();
    const existing = currentConnection();
    const suffix = `#${MODULE_INSTANCE}`;
    if (existing !== undefined && existing.implVersion.endsWith(suffix) && existing.status().state !== "off") {
      // path 1: same module instance ⇒ reuse synchronously (acquireConnection matches implVersion).
      connectWith({ pluginVersion: "", buildId: existing.implVersion.slice(0, -suffix.length) });
      return;
    }
    void getBuildInfo().then((info) => {
      if (gen === generation && attached) connectWith(info);
    });
  });

  on("session_shutdown", (event) => {
    if (!attached) return;
    attached = false;
    generation += 1;
    stopTick();
    tap.dispose();
    setStatusLine(undefined);
    const reason = reasonOf(event);
    const detachReason =
      reason === "reload" || reason === "new" || reason === "resume" || reason === "fork" ? reason : "quit";
    conn?.detach(detachReason);
  });

  for (const type of FORWARDED_EVENTS) {
    on(type, (event, c) => {
      if (!attached) return;
      if (c !== undefined) ctx = c;
      tap.handle(event as { type: string } & Record<string, unknown>);
      if (STATUS_EVENTS.has(type)) publishStatus();
      if (SESSION_EVENTS.has(type)) publishSession(sessionOverride(type, event));
    });
  }

  return {
    status: () => conn?.status() ?? { state: "off", attached: false },
    url: () => hubUrl(paths, conn),
  };
}

// ------------------------------------------------------------------ helpers

function reasonOf(event: unknown): string {
  const r = event !== null && typeof event === "object" ? (event as { reason?: unknown }).reason : undefined;
  return typeof r === "string" ? r : "startup";
}

function sessionInfo(ctx: ExtensionContext, reason: string): SessionInfo {
  const sm = ctx.sessionManager;
  const info: SessionInfo = {
    sessionId: safe(() => sm.getSessionId(), ""),
    cwd: safe(() => ctx.cwd, ""),
    reason,
    leafId: safe(() => sm.getLeafId(), null),
    mode: ctx.mode === "rpc" ? "rpc" : "tui",
  };
  const file = safe(() => sm.getSessionFile(), undefined);
  if (file !== undefined) info.sessionFile = file;
  const name = safe(() => sm.getSessionName(), undefined);
  if (name !== undefined) info.name = name;
  const model = safe(() => ctx.model, undefined);
  if (model !== undefined) info.model = { provider: String(model.provider), id: model.id };
  const level = safe(() => ctx.thinkingLevel, undefined);
  if (level !== undefined) info.thinkingLevel = String(level);
  return info;
}

function sessionOverride(type: string, event: unknown): Partial<SessionInfo> {
  const e = (event ?? {}) as Record<string, unknown>;
  if (type === "model_select") {
    const m = e.model as { provider?: unknown; id?: unknown } | undefined;
    if (m !== undefined && typeof m.provider === "string" && typeof m.id === "string") {
      return { model: { provider: m.provider, id: m.id } };
    }
  }
  if (type === "thinking_level_select" && typeof e.level === "string") return { thinkingLevel: e.level };
  if (type === "session_info_changed" && typeof e.name === "string") return { name: e.name };
  return {};
}

/** Single pass over the active branch: sum assistant `usage.cost.total` (no serialization, no abandoned branches). */
function branchCost(ctx: ExtensionContext): number {
  let total = 0;
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as unknown as {
        type?: unknown;
        message?: { role?: unknown; usage?: { cost?: { total?: unknown } } };
      };
      if (e.type !== "message" || e.message?.role !== "assistant") continue;
      const t = e.message.usage?.cost?.total;
      if (typeof t === "number" && Number.isFinite(t)) total += t;
    }
  } catch {
    /* stale ctx: keep what we have */
  }
  return total;
}

export function statusLineText(v: WebHubStatusView): string | undefined {
  switch (v.state) {
    case "live":
      return "web ●";
    case "connecting":
      return "web ○";
    case "loader":
      return "web ✗loader";
    case "proto":
      return "web ✗proto";
    case "backoff":
      return "web ✗";
    case "off":
      return undefined;
  }
}

function hubUrl(paths: HubPaths, conn: HubConnection | undefined): { url: string } | { hint: string } {
  const view = conn?.status();
  const port = (view?.state === "live" ? view.httpPort : undefined) ?? hubJsonPort(paths.hubJson);
  if (port === undefined) {
    return { hint: `hub 未运行：state=${view?.state ?? "off"}，见 ${paths.logFile}` };
  }
  const base = `http://127.0.0.1:${port}/`;
  let token = "";
  try {
    token = readFileSync(paths.tokenFile, "utf8").trim();
  } catch {
    /* missing */
  }
  if (token === "") {
    const partial: { url: string; hint: string } = { url: base, hint: `token 文件缺失：${paths.tokenFile}` };
    return partial;
  }
  return { url: `${base}#t=${encodeURIComponent(token)}` };
}

function hubJsonPort(file: string): number | undefined {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const pid = j.pid;
    if (typeof pid !== "number" || !pidAlive(pid)) return undefined;
    const http = j.http as { port?: unknown } | undefined;
    const port = j.port ?? j.httpPort ?? http?.port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function packageVersionSync(): string {
  try {
    const root = pluginRoot();
    if (root === undefined) return "0.0.0";
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function defaultBuildInfo(): Promise<{ pluginVersion: string; buildId: string }> {
  const d = defaultPluginInfoDeps();
  const info = d === undefined ? {} : await readPluginInfo(d);
  const version = info.version ?? packageVersionSync();
  return { pluginVersion: version, buildId: `${version}@${info.commit ?? "nogit"}${info.dirty === true ? "*" : ""}` };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
