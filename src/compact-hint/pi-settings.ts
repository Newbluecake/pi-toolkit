import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PI_DEFAULT_RESERVE_TOKENS } from "./threshold.js";

function validReserve(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function readLayer(path: string, field: "reserveTokens" | "keepRecentTokens"): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[pi-subagent] pi settings ${path} unparseable; ignoring compaction.${field}`);
      return undefined;
    }
    return validReserve(
      (parsed as Record<string, unknown>).compaction &&
        typeof (parsed as Record<string, unknown>).compaction === "object" &&
        !Array.isArray((parsed as Record<string, unknown>).compaction)
        ? ((parsed as Record<string, unknown>).compaction as Record<string, unknown>)[field]
        : undefined,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const suffix = error instanceof SyntaxError ? "unparseable" : "unreadable";
    console.warn(`[pi-subagent] pi settings ${path} ${suffix}; ignoring compaction.${field}`);
    return undefined;
  }
}

function layerValues(cwd: string, field: "reserveTokens" | "keepRecentTokens"): { project?: number; global?: number } {
  let project: number | undefined;
  let global: number | undefined;
  try {
    if (typeof cwd === "string" && cwd.length > 0)
      project = readLayer(join(cwd, CONFIG_DIR_NAME ?? ".pi", "settings.json"), field);
  } catch {
    project = undefined;
  }
  try {
    const agentDir = getAgentDir();
    if (typeof agentDir === "string" && agentDir.length > 0) global = readLayer(join(agentDir, "settings.json"), field);
  } catch {
    global = undefined;
  }
  return {
    ...(project === undefined ? {} : { project }),
    ...(global === undefined ? {} : { global }),
  };
}

/** Read project first, then global; exported for focused tests and diagnostics of the raw file layer. */
export function readPiCompactionReserveTokens(cwd: string): number | undefined {
  const values = layerValues(cwd, "reserveTokens");
  return values.project ?? values.global;
}

/** Resolve the conservative reserve: override, max(file layers, default). */
export function resolveReserveTokens(override: number | undefined, cwd: string): number {
  const explicit = validReserve(override);
  if (explicit !== undefined) return explicit;
  const values = layerValues(cwd, "reserveTokens");
  return Math.max(values.project ?? 0, values.global ?? 0, PI_DEFAULT_RESERVE_TOKENS);
}

/**
 * child-context-switch plan §2.1 ("keepRecentTokens, // pi-settings 读取，缺省
 * DEFAULT_COMPACTION_SETTINGS"): same project→global settings.json layer read as
 * `resolveReserveTokens`, for `compaction.keepRecentTokens` instead. `defaultValue` is the
 * caller's own fallback (pi's own `DEFAULT_COMPACTION_SETTINGS.keepRecentTokens`, read via the
 * namespace import so this pi-settings module stays free of a hard pi import).
 */
export function readPiCompactionKeepRecentTokens(cwd: string): number | undefined {
  const values = layerValues(cwd, "keepRecentTokens");
  return values.project ?? values.global;
}

export function resolveKeepRecentTokens(override: number | undefined, defaultValue: number, cwd: string): number {
  const explicit = validReserve(override);
  if (explicit !== undefined) return explicit;
  const layered = readPiCompactionKeepRecentTokens(cwd);
  return layered ?? validReserve(defaultValue) ?? defaultValue;
}
