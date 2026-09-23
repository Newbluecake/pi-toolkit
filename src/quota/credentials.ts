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
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CredentialResolver, QuotaProviderId } from "./types.js";

export interface CredentialResolverOptions {
  /** 测试注入点：默认 pi 的 readStoredCredential。返回 unknown 便于注入桩。 */
  readonly readCredential?: ((providerId: string) => unknown) | undefined;
  /** 测试注入点：默认 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** 测试注入点：默认不打（生产侧由调用方接 console.warn）。 */
  readonly warn?: ((message: string) => void) | undefined;
}

/** env 回退变量名（plan §3.5：zai 两站共用 ZAI_API_KEY）。 */
export const ENV_FALLBACK: Readonly<Record<QuotaProviderId, string>> = {
  "zai-coding-cn": "ZAI_API_KEY",
  zai: "ZAI_API_KEY",
  "kimi-coding": "KIMI_CODING_API_KEY",
};

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
export function createCredentialResolver(options: CredentialResolverOptions = {}): CredentialResolver {
  const readCredential: (providerId: string) => unknown = options.readCredential ?? readStoredCredential;
  const env: Readonly<Record<string, string | undefined>> = options.env ?? process.env;
  const warned = new Set<string>();
  const warnOnce = (provider: QuotaProviderId): void => {
    if (warned.has(provider)) return;
    warned.add(provider);
    try {
      options.warn?.(
        `[quota] no usable credential for "${provider}" (auth.json or ${ENV_FALLBACK[provider] ?? "?"}) — provider skipped`,
      );
    } catch {
      // 日志通道本身坏了也不能破坏「同步、永不抛」契约。
    }
  };
  return (provider: QuotaProviderId): string | undefined => {
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
    if (fromStore !== undefined) return fromStore;
    const fallbackName = ENV_FALLBACK[provider];
    const fallback = fallbackName === undefined ? undefined : env[fallbackName];
    if (typeof fallback === "string" && fallback !== "") return fallback;
    warnOnce(provider);
    return undefined;
  };
}
