/**
 * compact-hint dynamic · 切换遥测落盘（dynamic-threshold-plan.md §5.3，R2-7）。
 *
 * 半纯层：只用 `node:fs` / `node:path`（同 src/quota/demotion.ts 的定位）；路径由调用方注入
 * （生产侧是 `join(getAgentDir(), "telemetry", "compact-switch.jsonl")`，D3 wire 组装）。
 *
 * 落盘纪律（§5.3，逐条）：
 * - 目录 `mkdirSync(..., { recursive: true, mode: 0o700 })`；文件首次创建后立刻显式
 *   `chmodSync(path, 0o600)`（appendFileSync 的 mode 只在创建时生效且受 umask 影响），
 *   「本会话已确认过权限」用布尔标志缓存，避免每行一次 chmod/stat syscall。
 * - 单行追加：每条记录只 `appendFileSync(path, line + "\n")` 一次（一次 write）。
 *   **不断言原子性**：`O_APPEND` 对普通文件的小写入实践上 best-effort 不交错，但没有任何
 *   标准保证——高并发/NFS/信号中断下可能出现撕裂行；行长限制（≤3,500B）只是降低概率的
 *   工程手段。因此消费端**必须**逐行 JSON.parse 并跳过坏行（见 readTelemetryLines）。
 * - 超长记录：渲染后 > 3,500B ⇒ 先丢弃 `rProxy.firstUsage`、再丢弃 estimate/price 等可选
 *   诊断字段重渲；仍超长 ⇒ 跳过该条并 warn。
 * - 轮转：写前 `statSync().size > 2 MiB` ⇒ `renameSync(path, path + ".1")`（同目录 rename
 *   原子，自动覆盖旧 `.1`），只保留一代，上界 4 MiB。
 * - 多进程并发：不加锁、不用 lock 文件，接受 §5.3 列明的三类 best-effort 损失
 *   （撕裂行由消费端跳过 / 轮转少保留一代 / append 落到已 rename 走的旧 inode）。
 * - 错误处理：磁盘满（ENOSPC）、目录异常（EACCES/ENOTDIR/EROFS/EISDIR…）一律静默吞掉，
 *   经 safe logger（console.warn + `[pi-subagent]` 前缀）**每会话每 errno 只报一次**；
 *   绝不抛、绝不影响主链路（遥测是 best-effort）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SwitchTelemetryRecord } from "./telemetry.js";

/** 单行字节上限：降低撕裂概率的工程手段，不是正确性论据（R2-7）。 */
export const TELEMETRY_MAX_LINE = 3_500;
/** 写前超过此大小 ⇒ rename 轮转到 `.1`（只保留一代，上界 4 MiB）。 */
export const TELEMETRY_ROTATE_BYTES = 2 * 1024 * 1024;

export interface TelemetryStoreOptions {
  /** 完整文件路径（生产：join(getAgentDir(), "telemetry", "compact-switch.jsonl")）。 */
  readonly filePath: string;
  /** safe logger；缺省 console.warn（`[pi-subagent]` 前缀）。永不因 warn 通道故障抛错。 */
  readonly warn?: ((message: string) => void) | undefined;
}

export interface SwitchTelemetryStore {
  /** 追加一条记录（渲染 + 限长降级 + 轮转检查 + 单次 append）。永不抛。 */
  append(record: SwitchTelemetryRecord): void;
  /** 本会话成功追加的行数（status 的 telemetryCount 端口用）。 */
  count(): number;
}

export interface TelemetryReadResult {
  /** 逐行 JSON.parse 成功的记录（原样 unknown，不做 schema 校验）。 */
  records: unknown[];
  /** 解析失败被跳过的行数（消费端契约：发现并上报撕裂/损坏行）。 */
  skipped: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 超长降级第一档：丢 `rProxy.firstUsage`（「便于日后重算」的可选诊断，§5.3）。 */
function dropStage1(record: SwitchTelemetryRecord): SwitchTelemetryRecord {
  return record.rProxy === undefined ? record : { ...record, rProxy: { ...record.rProxy, firstUsage: null } };
}

/** 超长降级第二档：再丢 estimate/price 的可选诊断数值（核心事实 trigger/seq/rProxy 保留）。 */
function dropStage2(record: SwitchTelemetryRecord): SwitchTelemetryRecord {
  const stage1 = dropStage1(record);
  return {
    ...stage1,
    estimate: {
      g: null,
      sigma: null,
      s0: null,
      cStar: null,
      rUsd: stage1.estimate.rUsd,
      handoffTokens: null,
    },
    price: { cacheRead: null, cacheWrite: null, output: null, tierHit: null, writePricingApproximate: true },
  };
}

export function createTelemetryStore(options: TelemetryStoreOptions): SwitchTelemetryStore {
  let dirEnsured = false;
  let permsConfirmed = false;
  let written = 0;
  const warnedErrnos = new Set<string>();

  const safeWarn = (message: string): void => {
    try {
      (options.warn ?? ((text: string) => console.warn(text)))(message);
    } catch {
      // 日志通道坏了也不能破坏「永不抛」纪律。
    }
  };

  /** 每会话每 errno 只报一次（§5.3 错误处理）。 */
  const warnErrnoOnce = (error: unknown, action: string): void => {
    const code = (error as { code?: unknown } | null)?.code;
    const key = typeof code === "string" && code.length > 0 ? code : "no-errno";
    if (warnedErrnos.has(key)) return;
    warnedErrnos.add(key);
    safeWarn(
      `[pi-subagent] compact-switch telemetry ${action} failed (${key}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };

  const ensureDir = (): void => {
    try {
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
      dirEnsured = true;
    } catch (error) {
      warnErrnoOnce(error, "mkdir");
    }
  };

  /** 首次成功写入后立刻显式 chmod 一次并缓存标志，避免每行 syscall（§5.3 权限纪律）。 */
  const ensurePerms = (): void => {
    if (permsConfirmed) return;
    permsConfirmed = true;
    try {
      fs.chmodSync(options.filePath, 0o600);
    } catch (error) {
      warnErrnoOnce(error, "chmod");
    }
  };

  /** 写前轮转：> 2 MiB ⇒ rename 到 `.1`（同目录原子，自动覆盖旧一代）。 */
  const rotateIfNeeded = (): void => {
    try {
      if (fs.statSync(options.filePath).size > TELEMETRY_ROTATE_BYTES) {
        fs.renameSync(options.filePath, `${options.filePath}.1`);
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENOENT") return; // 首次写入前文件不存在，正常
      warnErrnoOnce(error, "rotate");
    }
  };

  return {
    append(record) {
      let line = JSON.stringify(record);
      if (byteLength(line) > TELEMETRY_MAX_LINE) {
        line = JSON.stringify(dropStage1(record));
        if (byteLength(line) > TELEMETRY_MAX_LINE) {
          line = JSON.stringify(dropStage2(record));
          if (byteLength(line) > TELEMETRY_MAX_LINE) {
            // 仍超长 ⇒ 跳过该条并 warn（每条一报：这是数据丢失事件，应可见）。
            safeWarn(
              `[pi-subagent] compact-switch telemetry skipped overlong record (${byteLength(line)}B > ${TELEMETRY_MAX_LINE})`,
            );
            return;
          }
        }
      }
      if (!dirEnsured) ensureDir();
      rotateIfNeeded();
      try {
        fs.appendFileSync(options.filePath, `${line}\n`);
        written += 1;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "ENOENT") dirEnsured = false; // 目录被并发删除 ⇒ 下次 append 前重试 mkdir
        warnErrnoOnce(error, "append");
        return;
      }
      ensurePerms();
    },
    count() {
      return written;
    },
  };
}

/**
 * 消费端读取契约（§5.3）：逐行 JSON.parse，**跳过解析失败的行并计数**（撕裂行由这里吸收，
 * 绝不抛）。文件不存在/不可读 ⇒ 空结果。不做 schema 校验（拟合脚本自行校验字段）。
 */
export function readTelemetryLines(filePath: string): TelemetryReadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }
  const records: unknown[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}
