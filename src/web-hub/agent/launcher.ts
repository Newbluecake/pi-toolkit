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
import { hubSafeEnv } from "../../secure/env.js";
import { getSecureDomain, hubSpawnBlockedReason } from "../../secure/domain.js";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { findPiPackageJson } from "../../core/host-modules.js";
import type { HubConfig } from "../hub/ports.js";
import { TIMING } from "../protocol/messages.js";
import { readStopMarkerSync, type StopMarkerRead } from "../protocol/stop-marker.js";

export interface LauncherPlan {
  execPath: string;
  jitiCli: string;
  argv1: string;
  /** Closed, host-owned bootstrap map; never inherited from the consumer environment. */
  hostAliases: HostTypeBoxAliases;
}

export type HostTypeBoxAliases = Readonly<
  Record<
    | "@sinclair/typebox"
    | "@sinclair/typebox/value"
    | "@sinclair/typebox/compile"
    | "typebox"
    | "typebox/value"
    | "typebox/compile",
    string
  >
>;

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

/**
 * Build the complete production plan. The override selects only the loader, never the
 * module owner: even with an override, TypeBox must resolve from the real parent pi.
 * Same resolution requests as pi 1.5's extension loader; no consumer/cwd fallback.
 */
export function resolveLauncherPlan(
  opts: Parameters<typeof resolveJitiCli>[0] & { execPath?: string },
): { ok: true; plan: LauncherPlan } | { ok: false; reason: string } {
  const realpath = opts.realpath ?? realpathSync;
  const exists = opts.exists ?? existsSync;
  const resolve = opts.resolve ?? ((from: string, req: string) => createRequire(from).resolve(req));
  if (!opts.argv1) return { ok: false, reason: "process.argv[1] is empty" };
  try {
    const real = realpath(opts.argv1);
    const piPackageJson = findPiPackageJson(real, exists);
    if (piPackageJson === undefined) return { ok: false, reason: `pi package not found above ${real}` };
    const loader = resolveJitiCli(opts);
    if (!loader.ok) return loader;
    const targets = ["typebox", "typebox/value", "typebox/compile"].map((request) => {
      const target = resolve(piPackageJson, request);
      if (!isAbsolute(target) || !statSync(target).isFile()) {
        throw new Error(`${request} target is not an absolute file: ${target}`);
      }
      return realpath(target);
    });
    const [root, value, compile] = targets as [string, string, string];
    return {
      ok: true,
      plan: {
        execPath: opts.execPath ?? process.execPath,
        argv1: opts.argv1,
        jitiCli: loader.jitiCli,
        hostAliases: {
          "@sinclair/typebox": root,
          typebox: root,
          "@sinclair/typebox/value": value,
          "typebox/value": value,
          "@sinclair/typebox/compile": compile,
          "typebox/compile": compile,
        },
      },
    };
  } catch (err) {
    return { ok: false, reason: `hub host TypeBox resolution failed: ${errText(err)}` };
  }
}

/** private-plan §4.1-5 / security review N3 #1: `spawnHub`'s refusal verdict — the ONE place a
 *  hub spawn can be blocked because the caller's process lives in (or cannot be proven NOT to
 *  live in) a private mount ns. `unknown` blocks exactly like `in-ns` (fail-safe). */
export type SpawnHubResult = { blocked: false } | { blocked: true; reason: "private-ns" | "private-ns-unknown" };

/**
 * The default gate: a FRESH three-state judgment (`judgePrivateNsGate` — never the frozen
 * domain verdict, so a miss cannot survive until process exit). Re-judged on every call; the
 * cost is one fd-bound record read per registered vault (+2 /proc reads only when a record
 * exists), and ZERO fs access for an unconfigured process.
 */
export function hubSpawnBlockedInPrivateNs(): "private-ns" | "private-ns-unknown" | undefined {
  return hubSpawnBlockedReason();
}

/**
 * Fire-and-forget hub spawn: `execPath jiti-cli.mjs main.ts`, detached, stdio
 * ignored, config passed through env. Never throws, never awaits.
 *
 * private-plan §4.1-1: the ONE hard gate covering every caller (auto-start, respawn, restart,
 * start) — inside a private mount ns (or when that cannot be ruled out) the spawn is refused
 * outright (a hub trapped in the ns would hold the plaintext view). Callers may pass their own
 * `privateNsBlocked` seam; the default re-judges fresh, so it can never disagree with the
 * session's own judgment.
 */
export function spawnHub(
  plan: LauncherPlan,
  mainTs: string,
  config: HubConfig,
  spawnImpl: typeof import("node:child_process").spawn = nodeSpawn,
  privateNsBlocked: () => "private-ns" | "private-ns-unknown" | undefined = hubSpawnBlockedInPrivateNs,
): SpawnHubResult {
  const reason = privateNsBlocked();
  if (reason !== undefined) return { blocked: true, reason };
  // Required at the runtime boundary too: malformed internal/fake plans must never
  // silently launch an unaliased jiti. Keep this outside the spawn-error swallow.
  const aliases: unknown = plan.hostAliases;
  if (typeof aliases !== "object" || aliases === null || Object.keys(aliases).length !== 6) {
    throw new Error("Invalid hub host TypeBox alias map");
  }
  for (const request of ["typebox", "typebox/value", "typebox/compile"] as const) {
    const target = Reflect.get(aliases, request);
    if (typeof target !== "string" || !isAbsolute(target) || Reflect.get(aliases, `@sinclair/${request}`) !== target) {
      throw new Error(`Invalid hub host TypeBox alias map: ${request}`);
    }
  }
  try {
    // Never trust an inherited marker (hubSafeEnv may return process.env itself).
    // This bootstrap veto uses the frozen domain, NOT the session runtime guard.
    const env = { ...hubSafeEnv(process.env) };
    delete env.PI_WEBHUB_TERMINAL_SOURCE;
    try {
      const kind = getSecureDomain()?.kind;
      if (kind === "plain") env.PI_WEBHUB_TERMINAL_SOURCE = "plain";
      else if (kind === "secure" || kind === "locked") env.PI_WEBHUB_TERMINAL_SOURCE = "denied";
    } catch {
      /* uninitialized/unknown provenance stays absent, never inferred plain */
    }
    const child = spawnImpl(plan.execPath, [plan.jitiCli, mainTs], {
      detached: true,
      stdio: "ignore",
      cwd: config.home,
      env: {
        // data-encryption §2.7: the hub only ever sees the pre-secure env (identity when no PI_SECURE_* key).
        ...env,
        // jiti resolves tsconfig paths BEFORE aliases. Replace (do not merge) user input.
        JITI_ALIAS: JSON.stringify(plan.hostAliases),
        JITI_TSCONFIG_PATHS: "false",
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
  return { blocked: false };
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
  /**
   * Stop marker gate (plan §6.7.2): `absent` is the only state that ever allows a spawn
   * (fail-closed on `unknown`). Read fresh on every admission — never cached — either via the
   * pre-classified `stop` (tests / a caller that already read it this tick) or by reading
   * `stoppedFile` synchronously right here (production). Both omitted ⇒ legacy/test default of
   * `absent` (byte-identical pre-v2.1 behavior for every existing caller).
   *
   * NOTE (plan §12.3/§12.5): the only production call site is `connection.ts`'s `maybeSpawn`,
   * which is a frozen face not owned by this package (C8) — wiring `stoppedFile` through that
   * call is C10's job at W4 (`launcher.ts C8 → C10`, `connection.ts` 冻结面 → C10). This function
   * is delivered and unit-tested standalone; end-to-end auto-spawn gating lands with C10.
   */
  stop?: "absent" | "stopped" | "unknown";
  stoppedFile?: string;
  readStop?: (file: string) => StopMarkerRead;
}): boolean {
  if (!opts.autoStart || opts.headless || !opts.launcherOk) return false;
  const stop =
    opts.stop ??
    (opts.stoppedFile === undefined ? "absent" : (opts.readStop ?? readStopMarkerSync)(opts.stoppedFile).state);
  if (stop !== "absent") return false;
  return opts.lastSpawnAt === undefined || opts.now - opts.lastSpawnAt >= TIMING.spawnThrottleMs;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
