/**
 * Quota HTTP layer (docs/dev/quota/quota-plan.md §3.6): `createFetchJson` is the
 * single network primitive behind every provider adapter.
 *
 * 契约（types.ts `FetchJson`）：**永不抛、永不挂**——失败 / 非 JSON / 非 2xx /
 * 超时 / 中止一律 resolve `undefined`（Minor 7：签名写实为
 * `Promise<unknown>`，undefined 语义靠文档与本实现共同保证）。额度查询是
 * 后台刷新的旁路数据源，不值得重试三连：`QUOTA_MAX_ATTEMPTS = 2`（1 + 1）。
 *
 * 复用 `src/web-search/resilience.ts` 的 `isRetryableError`（401/403 不重试、
 * 429/5xx/网络错重试）、`backoffDelay`、`sleep`（timer 已 unref）、
 * `redactSecrets`。注意 `resilience.withRequestTimeout` 的超时是**硬编码
 * 15s**（REQUEST_TIMEOUT_MS 常量、无参数），而 quota 需要可配置的 10s 默认
 * ——因此本文件实现了带 `timeoutMs` 参数的同款 withTimeout（同样的 unref
 * 纪律 + 中止传播），这是与 plan §3.6「组合 withRequestTimeout」字面签名的
 * 唯一偏差（行为等价、更可测，偏差记录见实施报告）。
 */

import { backoffDelay, isRetryableError, redactSecrets, sleep } from "../web-search/resilience.js";
import type { FetchJson } from "./types.js";

/**
 * Cloudflare 拦裸 curl / node UA（Kimi 实测 403 error 1010，requirements
 * 「已验证的外部契约」）——默认带桌面 Chrome 串。settings `quota.userAgent`
 * 空串 = 用本内置默认（adapters 在 UA 为空时回落到这里）。
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const QUOTA_REQUEST_TIMEOUT_MS = 10_000;
/** 1 次 + 1 次重试；额度查询不值得 3 次（plan §3.6）。 */
export const QUOTA_MAX_ATTEMPTS = 2;

export interface FetchJsonOptions {
  /** 测试注入点；默认调用时解析 globalThis.fetch（便于 vi.stubGlobal）。 */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  /** 参与日志脱敏的裸 key（service 侧传入）；redactSecrets 会逐字替换。 */
  readonly secrets?: readonly string[] | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}

interface AttemptFailure {
  readonly error: unknown;
  readonly status: number | undefined;
  readonly body: string | undefined;
}

type AttemptOutcome =
  { readonly ok: true; readonly value: unknown | undefined } | { readonly ok: false; readonly failure: AttemptFailure };

/**
 * resilience.withRequestTimeout 的参数化版：AbortController + unref'd
 * timeout + 父 signal 传播。额外在超时点用 Promise 兑现**强制**结束——
 * 不依赖底层 fetch 尊重 abort（stub fetch 忽略 signal 也不能把刷新挂死，
 * 这是「永不挂」契约的一部分）。
 */
function withTimeout<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (parentSignal?.aborted) {
      // 已中止的父 signal 不会再触发 abort 事件——必须前置短路，否则请求会照发。
      reject(new Error("quota request aborted"));
      return;
    }
    const controller = new AbortController();
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      settle();
    };
    const onParentAbort = (): void => {
      controller.abort(parentSignal?.reason);
      finish(() => reject(new Error("quota request aborted")));
    };
    const timer = setTimeout(() => {
      controller.abort(new Error("quota request timeout"));
      finish(() => reject(new Error(`quota request timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    timer.unref();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    void action(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** 单次尝试。200 + 非 JSON 是**形状问题**（重试无益）：按成功路径返回 undefined 值。 */
async function runAttempt(
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal | undefined },
  timeoutMs: number,
): Promise<AttemptOutcome> {
  try {
    const response = await withTimeout(init.signal, timeoutMs, (signal) =>
      fetchImpl(url, {
        method: "GET",
        headers: init.headers,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (response.ok) {
      try {
        return { ok: true, value: await response.json() };
      } catch {
        return { ok: true, value: undefined }; // 200 但不是 JSON：静默降级，不重试
      }
    }
    let body: string | undefined;
    try {
      body = await response.text();
    } catch {
      body = undefined;
    }
    const error = new Error(`HTTP ${response.status}${body === undefined ? "" : `: ${body.slice(0, 300)}`}`);
    return { ok: false, failure: { error, status: response.status, body } };
  } catch (error) {
    return { ok: false, failure: { error, status: undefined, body: undefined } };
  }
}

/** 组合超时 + 重试退避 + JSON 守卫 + 密钥脱敏。永不抛。 */
export function createFetchJson(options: FetchJsonOptions = {}): FetchJson {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init)); // 调用时解析全局 fetch，vi.stubGlobal 可拦截
  const timeoutMs = options.timeoutMs ?? QUOTA_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? QUOTA_MAX_ATTEMPTS));
  const secrets = [...(options.secrets ?? [])];
  const safeWarn = (message: string): void => {
    try {
      options.warn?.(message);
    } catch {
      // 日志通道不能破坏「永不抛」契约。
    }
  };
  const describe = (failure: AttemptFailure, attempts: number): string => {
    const raw = failure.error instanceof Error ? failure.error.message : String(failure.error);
    const status = failure.status === undefined ? "" : ` (HTTP ${failure.status})`;
    return redactSecrets(`[quota] fetch failed after ${attempts} attempt(s)${status}: ${raw}`, secrets);
  };
  return async (url, init) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await runAttempt(fetchImpl, url, init, timeoutMs);
      if (outcome.ok) return outcome.value;
      if (
        attempt >= maxAttempts ||
        !isRetryableError(outcome.failure.error, outcome.failure.status, outcome.failure.body)
      ) {
        safeWarn(describe(outcome.failure, attempt));
        return undefined;
      }
      try {
        await sleep(backoffDelay(attempt), init.signal); // 中止时提前放弃
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
}
