/**
 * 双副本检测（traffic-merge plan §2.4 步骤 2/3）：**只告警/辅助，永不构成让位依据**。
 *
 * - settings 扫描：`<agentDir>/settings.json` 与 `<cwd>/.pi/settings.json` 的 packages/extensions
 *   仍列着 `pi-traffic-record` / `@bluecake/pi-traffic-record`，及 `<agentDir>/extensions/traffic-dump.ts`
 *   存在 ⇒ 产出告警文案（外部包可能被过滤/未加载——权威证据只认 `external-active` 符号或 getCommands）。
 * - getCommands 判定：`/record(:\d+)?` 命令的 `sourceInfo.path` 不在 toolkit 包根下 ⇒ 证明有外部
 *   录制器**实际加载**（旧版 v0.2.x 不认协议）⇒ session_start 复核让位（claim.ts 释放）。
 *
 * 纯函数 + 可注入 fs（默认真 fs）；永不抛错（扫描失败 ⇒ 无发现）。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAgentDir } from "../core/agent-dir.js";

export const EXTERNAL_PACKAGE_NAMES = ["pi-traffic-record", "@bluecake/pi-traffic-record"] as const;
export const LEGACY_EXTENSION_FILE = "traffic-dump.ts";

/** `path` 是否在 `root` 目录之下（两侧 resolve；相对 `path` 视为不在任何包根下）。 */
export function isUnder(path: string, root: string): boolean {
  if (!isAbsolute(path)) return false;
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath === resolvedRoot) return true;
  return resolvedPath.startsWith(resolvedRoot + sep);
}

/** toolkit 包根（本模块即 `<pkg>/src/traffic/dup-detect.ts`）。 */
export const TOOLKIT_PACKAGE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface DupDetectFs {
  readFile?(path: string): string;
  exists?(path: string): boolean;
}

export interface DupFinding {
  readonly kind: "package" | "extension-file";
  readonly source: string;
  readonly detail: string;
}

/** 默认 agentDir：复用 pi-free 收敛实现；相对覆盖值回落 `~/.pi/agent`。 */
export function defaultAgentDir(home: string = process.env.HOME ?? ""): string {
  return resolveAgentDir(process.env, home).dir;
}

/**
 * 扫描 settings 与旧扩展文件。返回告警发现（可能为空数组）；任何读/解析失败都按无发现处理。
 * 匹配规则：packages 数组元素（字符串）或 extensions 键/值含外部包名；extensions 兼容
 * pi 的对象形状（`{ "traffic-dump.ts": true }`）与数组形状。
 */
export function scanExternalTrafficReferences(
  opts: { agentDir?: string; cwd?: string; fs?: DupDetectFs } = {},
): DupFinding[] {
  const agentDir = opts.agentDir ?? defaultAgentDir();
  const cwd = opts.cwd ?? process.cwd();
  const readFile = opts.fs?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const exists = opts.fs?.exists ?? ((path: string) => existsSync(path));
  const findings: DupFinding[] = [];

  const candidates: Array<{ source: string; path: string }> = [
    { source: "agent settings", path: join(agentDir, "settings.json") },
    { source: "project settings", path: join(cwd, ".pi", "settings.json") },
  ];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      if (!exists(candidate.path)) continue;
      parsed = JSON.parse(readFile(candidate.path));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const root = parsed as Record<string, unknown>;
    const hitPackage = listMatches(root.packages);
    const hitExtension = mapMatches(root.extensions);
    if (hitPackage || hitExtension) {
      findings.push({
        kind: "package",
        source: candidate.source,
        detail: `${candidate.path} 仍列有外部 pi-traffic-record`,
      });
    }
  }

  const legacy = join(agentDir, "extensions", LEGACY_EXTENSION_FILE);
  try {
    if (exists(legacy)) findings.push({ kind: "extension-file", source: "agent extensions", detail: legacy });
  } catch {
    /* 不存在 ⇒ 无发现 */
  }
  return findings;
}

function listMatches(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => typeof entry === "string" && matchesExternalName(entry));
}

function mapMatches(value: unknown): boolean {
  if (Array.isArray(value)) return listMatches(value);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, val]) => matchesExternalName(key) || (typeof val === "string" && matchesExternalName(val)),
  );
}

function matchesExternalName(text: string): boolean {
  return EXTERNAL_PACKAGE_NAMES.some((name) => text === name || text.includes(`/${name}`) || text.endsWith(name));
}

/** getCommands 的最小面（slash.ts 的 CommandsPort 先例：不依赖完整 ExtensionAPI）。 */
export interface CommandListEntry {
  name: string;
  sourceInfo?: { path?: unknown };
}

export interface ExternalRecorderCommand {
  name: string;
  path: string | null;
}

/**
 * getCommands 判定：存在 `/^record(:\d+)?$/` 且 `sourceInfo.path` 不在 toolkit 包根下的命令 ⇒
 * 外部录制器实际加载。返回首个命中（含其路径，供告警文案）；无命中 ⇒ undefined。
 * 形状异常（无 sourceInfo / path 非字符串）按「不在包根下」处理（fail closed：宁可让位）。
 */
export function findExternalRecorderCommand(
  commands: readonly CommandListEntry[],
  packageRoot: string = TOOLKIT_PACKAGE_ROOT,
): ExternalRecorderCommand | undefined {
  for (const command of commands) {
    if (!/^record(:\d+)?$/.test(command.name)) continue;
    const rawPath = command.sourceInfo?.path;
    const path = typeof rawPath === "string" ? rawPath : null;
    if (path !== null && isUnder(path, packageRoot)) continue;
    return { name: command.name, path };
  }
  return undefined;
}

/** 告警文案（单条，供 notify）。 */
export function formatDupWarning(findings: readonly DupFinding[]): string {
  const lines = findings.map((finding) => `· ${finding.source}: ${finding.detail}`);
  return [
    "检测到外部 pi-traffic-record 残留（toolkit 已内置 traffic.*，请避免双装载）：",
    ...lines,
    "迁移：所有运行中的 pi 执行 /record off → 从 settings.json 删除该 package/extensions 项 → /reload。",
  ].join("\n");
}
