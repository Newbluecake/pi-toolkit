/**
 * hub process entry (plan §包 I): spawned by the agent side as
 * `node <pi's bundled jiti-cli> src/web-hub/hub/main.ts` with the HubConfig
 * JSON in `PI_WEBHUB_CONFIG` (see agent/launcher.ts `spawnHub`). jiti executes
 * this TypeScript file directly; the `.js` import suffixes resolve to the
 * sibling `.ts` sources.
 *
 * Responsibilities (and nothing else):
 *   1. parse `PI_WEBHUB_CONFIG`;
 *   2. `startHub(config, createHttpFrontend)`;
 *   3. `installProcessHandlers(hub, log)` and run until the hub closes
 *      (idle exit / signal), then exit 0.
 * A second hub for the same state dir gets `{ exists: true }` ⇒ exit 0 (the
 * incumbent owns the socket). Any startup failure exits non-zero so the
 * agent-side spawn observer can log it.
 *
 * The log passed to installProcessHandlers is created HERE, not borrowed from
 * the hub: `RunningHub.close()` closes its own log, but the process handlers
 * must still be able to write during/after teardown.
 */
import { resolveHubPaths } from "../protocol/paths.js";
import { normalizeHubPreviewMode } from "../protocol/preview.js";
import { normalizeFeishuBotHubConfig } from "../protocol/feishu.js";
import { HUB_COMM, setProcessComm } from "./comm.js";
import { installProcessHandlers, startHub, type StartHubDeps } from "./hub.js";
import { createHttpFrontend } from "./http.js";
import { checkLanPortConflict, parseHubLanConfig } from "./lan-config.js";
import { parseHubSpawnConfig } from "./spawn/config.js";
import { normalizeHubLoadConfig } from "./load.js";
import { normalizeHubProxyConfig } from "./proxy/config.js";
import { createHubLog } from "./log.js";
import type { HubConfig } from "./ports.js";

export { checkLanPortConflict, parseHubLanConfig } from "./lan-config.js";

function fail(message: string, code: number): never {
  try {
    process.stderr.write(`web-hub main: ${message}\n`);
  } catch {
    /* stderr may be ignored */
  }
  process.exit(code);
}

async function main(): Promise<void> {
  // Kernel comm only (see hub/comm.ts): cmdline — which hub.json's identity argv and the
  // agent-side restart check depend on — is deliberately left untouched.
  setProcessComm(HUB_COMM);
  const raw = process.env.PI_WEBHUB_CONFIG;
  if (raw === undefined || raw.trim() === "") fail("PI_WEBHUB_CONFIG is not set", 2);
  let config: HubConfig;
  try {
    config = JSON.parse(raw) as HubConfig;
  } catch (err) {
    fail(`PI_WEBHUB_CONFIG is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  if (config.v !== 1 || typeof config.home !== "string" || config.home === "") {
    fail("PI_WEBHUB_CONFIG is not a v1 HubConfig", 2);
  }
  // `process.umask(0o077)` returns the previous mask. web-hub-spawn §SP2: keep it and hand it to
  // the hub via StartHubDeps.childUmask so the spawn supervisor (SP7/SP10) restores the user's own
  // umask around each fork — children must not inherit the hub's private 0o077.
  const inheritedUmask = process.umask(0o077); // before any file-system operation (§1.3.1)

  const startDeps: StartHubDeps = {};
  if (config.lan !== undefined) {
    const parsed = parseHubLanConfig(config.lan);
    if (!parsed.ok) {
      const { lan: _drop, ...rest } = config;
      config = rest;
      startDeps.lanConfigError = { detail: parsed.detail };
    } else {
      const conflict = checkLanPortConflict(parsed.lan, config.port);
      if (!conflict.ok) {
        const { lan: _drop, ...rest } = config;
        config = rest;
        startDeps.lanConfigError = { detail: conflict.detail };
      } else {
        config = { ...config, lan: parsed.lan };
      }
    }
  }

  // web-hub-spawn §SP2: strict re-validation of config.spawn — any invalid field drops the whole
  // key (feature off, everything else keeps running). No hub log exists yet (createHubLog comes
  // below), so the warn goes to stderr, the same channel fail() uses.
  if (config.spawn !== undefined) {
    const parsedSpawn = parseHubSpawnConfig(config.spawn);
    if (!parsedSpawn.ok) {
      const { spawn: _drop, ...rest } = config;
      config = rest;
      try {
        process.stderr.write(`web-hub main: dropping config.spawn: ${parsedSpawn.detail}\n`);
      } catch {
        /* stderr may be ignored */
      }
    } else {
      config = { ...config, spawn: parsedSpawn.spawn };
    }
  }

  // web-hub-preview plan v3 §4.1 (PV1): same fail-soft re-validation of config.preview — the
  // wire carries "on"/"loopback" only ("off" is the key's absence, and the agent side never
  // writes it), so anything else drops the whole key: preview stays off, the hub keeps running.
  if (config.preview !== undefined) {
    const rawPreview = config.preview;
    const preview = normalizeHubPreviewMode(rawPreview);
    if (preview === undefined) {
      const { preview: _drop, ...rest } = config;
      config = rest;
      try {
        process.stderr.write(`web-hub main: dropping config.preview: ${JSON.stringify(rawPreview)}\n`);
      } catch {
        /* stderr may be ignored */
      }
    } else {
      config = { ...config, preview };
    }
  }

  // Slash-args: unknown/off values omit the gate, never advertise an unusable cap.
  if (config.cmdArgs !== undefined && config.cmdArgs !== "all" && config.cmdArgs !== "toolkit") {
    const { cmdArgs: _drop, ...rest } = config;
    config = rest;
  }
  // web-hub-avatar plan v2.1 §2.6: feature-off is represented by an absent
  // key. Fail soft on hand-edited/old launcher config, preserving startup.
  if (config.avatar !== undefined && config.avatar !== true) {
    const { avatar: _drop, ...rest } = config;
    config = rest;
  }

  // web-hub-privacy plan v2.1 (P1): same fail-soft discipline as `avatar` — the literal key
  // `true` is the only legal value; anything else (hand-edited/old launcher config) drops the
  // key, leaving the feature off but the hub running.
  if (config.privacy !== undefined && config.privacy !== true) {
    const { privacy: _drop, ...rest } = config;
    config = rest;
  }

  // sysload P3: config.load is a startup snapshot.  Reject the complete key on
  // malformed values rather than partially clamping it; this keeps the hub's
  // cap, sampler, SSE and REST surfaces as one feature gate.
  if (config.load !== undefined) {
    const rawLoad = config.load;
    const load = normalizeHubLoadConfig(rawLoad);
    if (load === undefined) {
      const { load: _drop, ...rest } = config;
      config = rest;
      try {
        process.stderr.write(`web-hub main: dropping config.load: ${JSON.stringify(rawLoad)}\n`);
      } catch {
        /* stderr may be ignored */
      }
    } else {
      config = { ...config, load };
    }
  }
  // web-hub-proxy plan v2 §5 (X1c): config.proxy is one feature gate — a malformed value, or a
  // range overlapping the hub/LAN port (second line of the port-collision veto), drops the
  // WHOLE key: no service, routes, caps, /api cross-site gate or disk; the hub keeps running.
  if (config.proxy !== undefined) {
    const rawProxy = config.proxy;
    const normalized = normalizeHubProxyConfig(rawProxy, {
      hubPort: config.port,
      ...(config.lan === undefined ? {} : { lanPort: config.lan.port }),
    });
    if (!normalized.ok) {
      const { proxy: _drop, ...rest } = config;
      config = rest;
      try {
        process.stderr.write(`web-hub main: dropping config.proxy: ${normalized.detail}\n`);
      } catch {
        /* stderr may be ignored */
      }
    } else {
      config = { ...config, proxy: normalized.proxy };
    }
  }
  if (config.feishuBot !== undefined) {
    const feishuBot = normalizeFeishuBotHubConfig(config.feishuBot);
    if (feishuBot === undefined) {
      const { feishuBot: _drop, ...rest } = config;
      config = rest;
      try {
        process.stderr.write("web-hub main: dropping malformed config.feishuBot\n");
      } catch {
        /* ignored */
      }
    } else config = { ...config, feishuBot };
  }
  startDeps.childUmask = inheritedUmask;

  const paths = resolveHubPaths({
    home: config.home,
    uid: process.getuid?.() ?? 0,
    xdgRuntimeDir:
      process.env.XDG_RUNTIME_DIR !== undefined && process.env.XDG_RUNTIME_DIR !== ""
        ? process.env.XDG_RUNTIME_DIR
        : undefined,
  });
  const log = createHubLog(paths.logFile);
  log.info("hub process starting", { port: config.port, idleExitMinutes: config.idleExitMinutes });

  // Every exit from main() is an explicit process.exit(). A close() (startup-time supersede, or a
  // later fence/idle/admin/self-restart close) shuts the listening sockets first and then awaits
  // bounded teardown steps whose deadline timers are unref'd; with no ref'd handle left Node would
  // exit naturally with status 0 mid-teardown — dropping owner release, hub.json removal and the
  // final `hub closed` log. This ref'd keepalive lives for the whole entry process and is only
  // ended by the explicit exits below (the close() deadline itself bounds how long it can hold).
  const keepAlive = setInterval(() => {}, 1_000);
  let hub: Awaited<ReturnType<typeof startHub>>;
  try {
    hub = await startHub(config, createHttpFrontend, startDeps);
  } catch (err) {
    clearInterval(keepAlive);
    log.error("hub startup failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    log.close();
    process.exit(1);
  }
  if ("exists" in hub && hub.exists === false) {
    log.info("hub closed during startup, exiting", { reason: hub.reason });
    clearInterval(keepAlive);
    log.close();
    process.exit(0);
  }
  if ("exists" in hub) {
    // Singleton race lost: the incumbent hub owns the state dir — exit 0.
    log.info("hub already running, exiting", {});
    clearInterval(keepAlive);
    log.close();
    process.exit(0);
  }

  installProcessHandlers(hub, log);
  const reason = await hub.closed;
  log.info("hub process exiting", { reason });
  clearInterval(keepAlive);
  log.close();
  process.exit(0);
}

void main();
