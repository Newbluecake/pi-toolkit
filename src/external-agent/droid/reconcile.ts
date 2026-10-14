/**
 * plan r3（§14）：异常退出时用 droid 自己的会话设置文件对账。
 *
 * droid 进程在一轮未结束时退出（崩溃 / reaper 组杀 / 超时）会丢失该轮的
 * `agent_turn_completed`，账本 L1–L8 漏记。run 终态时若账本存在「已开始未结算」的
 * turn，best-effort 读 `~/.factory/sessions/<cwd slug>/<sessionId>.settings.json` 的
 * 累计 tokenUsage（字段形状与 session_token_usage_changed.tokenUsage 相同，
 * droid-protocol §5 实测），由账本 `observeCumulative` 对最后已知累计逐字段做差补记。
 *
 * 约束（r3 原文）：只读、≤256 KiB、有界（同步读 ≤256KiB 远低于 500ms 上限）、不阻塞
 * 终态投递、绝不重复计费（turn 已结算则不补——调用方用 mapper.turnOpen() 把关；
 * resume 首 turn 无基线时 observeCumulative 只记基线不出增量，天然放弃）、
 * 路径由 sessionId 推出且 O_NOFOLLOW + 普通文件校验；不打印文件内容；一切失败静默放弃。
 */
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExternalTokenCounts } from "../types.js";
import { DROID_SETTINGS_FILE_MAX_BYTES } from "./protocol.js";
import { droidTokenCounts } from "./usage-fields.js";

/**
 * droid 的 cwd slug（实测：`/tmp/droid-spike` ⇒ `-tmp-droid-spike`，即路径分隔符 ⇒ `-`，
 * 其余字符原样——`.config` 等点号保留）。Windows 不在支持面（bash/posix only）。
 */
export function droidCwdSlug(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

export interface DroidNativeSessionPaths {
  dir: string;
  sessionFile: string;
  settingsFile: string;
}

/** 由 (homeDir, cwd, sessionId) 推 droid 原生活动文件坐标（不触盘）。 */
export function droidNativeSessionPaths(o: {
  homeDir: string;
  cwd: string;
  sessionId: string;
}): DroidNativeSessionPaths {
  const dir = join(o.homeDir, ".factory", "sessions", droidCwdSlug(o.cwd));
  return {
    dir,
    sessionFile: join(dir, `${o.sessionId}.jsonl`),
    settingsFile: join(dir, `${o.sessionId}.settings.json`),
  };
}

/** 缺省 home（单独成函数便于测试 stub HOME env；os.homedir() 在 POSIX 上每次读 env）。 */
export function factoryHomeDir(): string {
  return homedir();
}

/**
 * 有界同步读 settings.json 的累计 tokenUsage。
 * 任何一步失败（缺失/目录/符号链接/超限/坏 JSON/缺字段）⇒ undefined，绝不 throw、绝不打印内容。
 */
export function readNativeCumulativeUsage(settingsFile: string): ExternalTokenCounts | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(settingsFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > DROID_SETTINGS_FILE_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(stat.size);
    let off = 0;
    while (off < stat.size) {
      const n = readSync(fd, buf, off, stat.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const parsed: unknown = JSON.parse(buf.subarray(0, off).toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    return droidTokenCounts((parsed as Record<string, unknown>).tokenUsage);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
  }
}
