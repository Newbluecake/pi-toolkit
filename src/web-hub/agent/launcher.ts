/**
 * Hub launcher (plan §包 D — launcher.ts).
 *
 * The hub runs as a detached plain-node process executing the package's own TS
 * source through pi's bundled jiti CLI (spike K1/K1-git): from `process.argv[1]`
 * (the pi CLI) we walk up to `@earendil-works/pi-coding-agent/package.json` and
 * resolve `jiti/package.json` from there. `webHub.nodeLoader` overrides the
 * lookup (escape hatch for the bun single-file distribution, where no jiti
 * exists on disk).
 *
 * Nothing here blocks: `spawnHub` is fire-and-forget (detached, stdio ignored,
 * unref'd, async spawn errors swallowed).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { HubConfig } from "../hub/ports.js";
import { TIMING } from "../protocol/messages.js";

export interface LauncherPlan {
  execPath: string;
  jitiCli: string;
  argv1: string;
}

const PI_SCOPE = "@earendil-works";
const PI_PKG = "pi-coding-agent";

/**
 * Resolve pi's bundled `jiti/lib/jiti-cli.mjs`.
 * `override` (settings.webHub.nodeLoader) wins when non-empty.
 */
export function resolveJitiCli(opts: {
  argv1: string | undefined;
  override: string;
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  /** Test seam: module resolution from a package.json path (default: createRequire). */
  resolve?: (fromPackageJson: string, request: string) => string;
}): { ok: true; jitiCli: string } | { ok: false; reason: string } {
  const exists = opts.exists ?? existsSync;
  const realpath = opts.realpath ?? realpathSync;
  const resolve = opts.resolve ?? ((from: string, req: string) => createRequire(from).resolve(req));

  const override = opts.override.trim();
  if (override !== "") {
    return exists(override)
      ? { ok: true, jitiCli: override }
      : { ok: false, reason: `webHub.nodeLoader not found: ${override}` };
  }
  if (opts.argv1 === undefined || opts.argv1 === "") return { ok: false, reason: "process.argv[1] is empty" };

  let real: string;
  try {
    real = realpath(opts.argv1);
  } catch (err) {
    return { ok: false, reason: `realpath(${opts.argv1}) failed: ${errText(err)}` };
  }

  const pkgJson = findPiPackageJson(real, exists);
  if (pkgJson === undefined) return { ok: false, reason: `pi package not found above ${real}` };

  let jitiPkg: string;
  try {
    jitiPkg = resolve(pkgJson, "jiti/package.json");
  } catch (err) {
    return { ok: false, reason: `jiti not resolvable from ${pkgJson}: ${errText(err)}` };
  }
  const cli = join(dirname(jitiPkg), "lib", "jiti-cli.mjs");
  return exists(cli) ? { ok: true, jitiCli: cli } : { ok: false, reason: `jiti-cli missing: ${cli}` };
}

function findPiPackageJson(start: string, exists: (p: string) => boolean): string | undefined {
  let dir = dirname(start);
  for (let i = 0; i < 64; i++) {
    if (basename(dir) === PI_PKG && basename(dirname(dir)) === PI_SCOPE) {
      const own = join(dir, "package.json");
      if (exists(own)) return own;
    }
    const nested = join(dir, "node_modules", PI_SCOPE, PI_PKG, "package.json");
    if (exists(nested)) return nested;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Fire-and-forget hub spawn: `execPath jiti-cli.mjs main.ts`, detached, stdio
 * ignored, config passed through env. Never throws, never awaits.
 */
export function spawnHub(
  plan: LauncherPlan,
  mainTs: string,
  config: HubConfig,
  spawnImpl: typeof import("node:child_process").spawn = nodeSpawn,
): void {
  try {
    const child = spawnImpl(plan.execPath, [plan.jitiCli, mainTs], {
      detached: true,
      stdio: "ignore",
      cwd: config.home,
      env: {
        ...process.env,
        PI_WEBHUB_CONFIG: JSON.stringify(config),
        PI_WEBHUB_LAUNCHER: JSON.stringify([plan.execPath, plan.argv1]),
      },
    });
    // spawn failures (ENOENT, EACCES) surface asynchronously as 'error'; an
    // unhandled 'error' event would crash pi.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* synchronous spawn failure: the reconnect loop just keeps backing off */
  }
}

/**
 * Hub auto-start gate: autoStart on, not a headless child (`PI_WEBHUB_HEADLESS=1`
 * must never resurrect a dead hub, arch §5.3), a resolvable launcher, and at most
 * one spawn per `TIMING.spawnThrottleMs` per pi process.
 */
export function shouldSpawnHub(opts: {
  autoStart: boolean;
  headless: boolean;
  launcherOk: boolean;
  lastSpawnAt: number | undefined;
  now: number;
}): boolean {
  if (!opts.autoStart || opts.headless || !opts.launcherOk) return false;
  return opts.lastSpawnAt === undefined || opts.now - opts.lastSpawnAt >= TIMING.spawnThrottleMs;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
