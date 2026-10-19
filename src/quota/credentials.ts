/**
 * Quota credential resolution (docs/dev/quota/quota-plan.md §3.5, decision D1).
 *
 * 降级链：pi 的 `readStoredCredential(id)`（包根公开导出，同步、内部自带
 * try/catch、尊重 PI_* 环境重定向）→ `type !== "api_key"` 或 key 缺失/为空/
 * 不可解析时回退 `process.env[ENV_FALLBACK[id]]` → 仍无 ⇒ `undefined`，
 * 该 provider 本期跳过（首次 miss 打一次 WARN，之后静默——不打 WARN 刷屏）。
 *
 * 配置值模板（pi 允许 auth.json 里的 key 是 `$ENV_VAR` 模板或 shell 命令，
 * 而 `readStoredCredential` **不做解析**）：
 * - 值含 `$` ⇒ 只做单层 `process.env` 查表（`^\$\{?([A-Za-z_]\w*)\}?$`
 *   全量匹配才替换；查不到视为 key 不可用，走 env 回退）。
 * - 值形如命令配置（以 `!` 开头 / 含空白）⇒ 直接放弃（**绝不 `execSync`**——
 *   扩展里执行用户 shell 是安全红线，plan D1）。
 *
 * 本文件是 quota 模块里唯一 import `readStoredCredential` 的文件（pi-facing）。
 *
 * droid CLI 登录态（2026-10-19 用户拍板）：droid 两个池缺 FACTORY_API_KEY 时，
 * 若 `~/.factory` 存在（droid CLI 经 OAuth 自行登录，droid 本身可用）⇒ **不打
 * WARN**，只在状态面披露「余额探测不可用」；`~/.factory` 不存在（droid 未安装）
 * ⇒ 保留 WARN。kimi/zai 的告警路径不受影响。
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDroidQuotaId, type CredentialResolver, type QuotaProviderId } from "./types.js";

export interface CredentialResolverOptions {
  /** 测试注入点：默认 pi 的 readStoredCredential。返回 unknown 便于注入桩。 */
  readonly readCredential?: ((providerId: string) => unknown) | undefined;
  /** 测试注入点：默认 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** 测试注入点：默认不打（生产侧由调用方接 console.warn）。 */
  readonly warn?: ((message: string) => void) | undefined;
  /**
   * 测试注入点：droid CLI 登录态探测（`~/.factory` 存在 ⇒ true）。默认
   * `droidCliLoginPresent`。只对 droid 两个池的告警路径生效；注入桩抛异常 ⇒
   * 保守视为 false（回到 WARN 路径）。
   */
  readonly droidCliLogin?: (() => boolean) | undefined;
}

/**
 * droid CLI 登录态的默认探测：`~/.factory` 存在即视为 droid CLI 已安装/已登录
 *（OAuth 状态写在那里）。与 external-agent 的 `factoryHomeDir()` 同源——
 * `os.homedir()`（POSIX 上每次读 $HOME）；`~/.factory` 是 droid CLI 自己的状态
 * 目录，pi 的 PI_* agent-dir 重定向不适用（droid 子进程也不读它）。单次
 * existsSync 有界、同步；任何异常 ⇒ false（保守：回到 WARN 路径），绝不抛。
 */
export function droidCliLoginPresent(): boolean {
  try {
    return existsSync(join(homedir(), ".factory"));
  } catch {
    return false;
  }
}

/** createCredentialResolver 的附加状态面（droid 池凭据缺失披露用）。 */
export interface DroidCredentialState {
  /**
   * 最近一次 droid 池凭据解析是否落空（auth.json 与 FACTORY_API_KEY 都没有）——
   * 状态面（HUD quota 行 / `/agent status`）据此显示「余额探测不可用」；命中后
   * 归零。kimi/zai 的 miss 不跟踪（它们没有「CLI 自行登录」的语义）。
   */
  readonly droidKeyMissing: () => boolean;
}

/** env 回退变量名（plan §3.5：zai 两站共用 ZAI_API_KEY）。 */
export const ENV_FALLBACK: Readonly<Record<QuotaProviderId, string>> = {
  "zai-coding-cn": "ZAI_API_KEY",
  zai: "ZAI_API_KEY",
  "kimi-coding": "KIMI_CODING_API_KEY",
  // D3 拍板：droid 两池只用 FACTORY_API_KEY（与 droid 子进程继承同一把 key），
  // 不读 ~/.factory/env.sh（那是新 shell 才 source 的）。
  "droid-standard": "FACTORY_API_KEY",
  "droid-core": "FACTORY_API_KEY",
};

/**
 * warnOnce 的键（quota-plan r2 §3）：droid 两个虚拟 id 共享一把 key ⇒ 合并成一个键
 * `"droid"`，文案里的 provider 名也写 `droid`；kimi/zai 的键和文案都不变。
 */
export function warnKey(provider: QuotaProviderId): string {
  return isDroidQuotaId(provider) ? "droid" : provider;
}

/** `$VAR` / `${VAR}` 模板——必须全量匹配（部分内插如 `sk-$x` 不算模板，视为坏值）。 */
const ENV_TEMPLATE = /^\$\{?([A-Za-z_]\w*)\}?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minor 5（评审）语义收窄，写明：**只查 `process.env`（或注入的 env 表）**，
 * 不处理 pi `ApiKeyCredential.env` 的 per-provider 环境变量映射；也不处理
 * `$$` / `$!` 之类的转义写法。命令型配置（`!` 前缀 / 含空白）直接放弃，
 * 永不执行。
 */
function resolveConfigValue(key: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (key.startsWith("!") || /\s/.test(key)) return undefined; // 命令型 → 放弃（绝不 exec）
  if (!key.includes("$")) return key;
  const match = ENV_TEMPLATE.exec(key);
  if (!match) return undefined;
  const value = env[match[1] ?? ""];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 首次 miss 打一次 WARN，之后静默（D1：不打 WARN 刷屏）。 */
export function createCredentialResolver(
  options: CredentialResolverOptions = {},
): CredentialResolver & DroidCredentialState {
  const readCredential: (providerId: string) => unknown = options.readCredential ?? readStoredCredential;
  const env: Readonly<Record<string, string | undefined>> = options.env ?? process.env;
  const cliLogin: () => boolean = options.droidCliLogin ?? droidCliLoginPresent;
  const warned = new Set<string>();
  let droidMissing = false;
  const cliLoggedIn = (): boolean => {
    try {
      return cliLogin() === true;
    } catch {
      return false; // 注入桩异常 ⇒ 保守走 WARN 路径（与「永不抛」契约一致）。
    }
  };
  const warnOnce = (provider: QuotaProviderId): void => {
    const key = warnKey(provider);
    if (warned.has(key)) return;
    warned.add(key);
    try {
      options.warn?.(
        `[quota] no usable credential for "${key}" (auth.json or ${ENV_FALLBACK[provider] ?? "?"}) — provider skipped`,
      );
    } catch {
      // 日志通道本身坏了也不能破坏「同步、永不抛」契约。
    }
  };
  const resolve = (provider: QuotaProviderId): string | undefined => {
    let fromStore: string | undefined;
    try {
      const credential = readCredential(provider);
      if (isRecord(credential) && credential.type === "api_key") {
        const key = credential.key;
        if (typeof key === "string" && key.trim() !== "") {
          fromStore = resolveConfigValue(key, env);
        }
      }
    } catch {
      // readStoredCredential 自身永不抛（plan §0），但注入桩可能抛——吞掉走回退链。
    }
    const found = fromStore ?? envFallback(provider, env);
    if (found !== undefined) {
      if (isDroidQuotaId(provider)) droidMissing = false;
      return found;
    }
    if (isDroidQuotaId(provider)) {
      droidMissing = true;
      // 2026-10-19 用户拍板：droid CLI 已登录（~/.factory 存在，OAuth 下 droid 本身
      // 可用）时缺 FACTORY_API_KEY 不打 WARN——余额探测不可用由状态面披露（HUD quota
      // 行 / `/agent status` 的「余额探测不可用」指示）；~/.factory 不存在（droid
      // 未安装）⇒ 保留 WARN。
      if (!cliLoggedIn()) warnOnce(provider);
      return undefined;
    }
    warnOnce(provider);
    return undefined;
  };
  resolve.droidKeyMissing = (): boolean => droidMissing;
  return resolve;
}

/** env 回退取值（ENV_FALLBACK 查表 + 非空校验）；无回退名/空值 ⇒ undefined。 */
function envFallback(provider: QuotaProviderId, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const fallbackName = ENV_FALLBACK[provider];
  const fallback = fallbackName === undefined ? undefined : env[fallbackName];
  return typeof fallback === "string" && fallback !== "" ? fallback : undefined;
}
