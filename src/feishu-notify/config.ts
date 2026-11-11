/** The only notification precedence resolver, shared by sender and coexistence diagnostics.
 * Read-only: never migrate/write configuration and never expose parser errors or file bodies.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettingsNoMigrate } from "../config/settings.js";
import { getSecureDomain } from "../secure/domain.js";
import { parseConfig, type Config } from "./core.js";
import { parseFeishuNotifySettings, parseNotifyFields } from "./settings.js";

export interface NotifyConfigOptions {
  unified?: unknown;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string | undefined;
  legacyPath?: string;
  /** Explicit seam for tests; production always checks the frozen secure verdict as well. */
  secure?: boolean;
}

/** This override selects ONLY the legacy fallback file. Empty string disables that file read.
 * It never replaces pi-toolkit.json, bypasses unified overrides, or suppresses environment fallback.
 * The default legacy location deliberately remains ~/.pi/agent, independent of agentDir.
 */
export function legacyNotifyConfigPath(env: NodeJS.ProcessEnv): string {
  return env.FEISHU_NOTIFY_CONFIG_PATH ?? join(homedir(), ".pi", "agent", "feishu-notify.json");
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function resolveNotifyConfig(options: NotifyConfigOptions = {}): Config & { enabled: boolean } {
  const domain = getSecureDomain();
  if (options.secure === true || (domain !== undefined && domain.kind !== "plain")) return { enabled: false };
  const unified = parseFeishuNotifySettings(
    options.unified === undefined ? readSettingsNoMigrate().feishuNotify : options.unified,
  );
  if (!unified.enabled) return { enabled: false };
  const env = options.env ?? process.env;
  const path = options.legacyPath ?? legacyNotifyConfigPath(env);
  let legacy: Config = {};
  try {
    const text = path === "" ? undefined : (options.readFile ?? readText)(path);
    if (text !== undefined) legacy = parseNotifyFields(JSON.parse(text));
  } catch {
    // JSON.parse may quote credential bytes; neither it nor custom I/O errors are reportable.
  }
  return { ...parseConfig({ ...legacy, ...parseNotifyFields(unified) }, env), enabled: true };
}
