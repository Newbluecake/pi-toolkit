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
import { installProcessHandlers, startHub, type StartHubDeps } from "./hub.js";
import { createHttpFrontend } from "./http.js";
import { checkLanPortConflict, parseHubLanConfig } from "./lan-config.js";
import { parseHubSpawnConfig } from "./spawn/config.js";
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

  let hub: Awaited<ReturnType<typeof startHub>>;
  try {
    hub = await startHub(config, createHttpFrontend, startDeps);
  } catch (err) {
    log.error("hub startup failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    log.close();
    process.exit(1);
  }
  if ("exists" in hub) {
    // Singleton race lost: the incumbent hub owns the state dir — exit 0.
    log.info("hub already running, exiting", {});
    log.close();
    process.exit(0);
  }

  installProcessHandlers(hub, log);
  const reason = await hub.closed;
  log.info("hub process exiting", { reason });
  log.close();
  process.exit(0);
}

void main();
