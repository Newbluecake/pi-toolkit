/**
 * Feishu tenant_access_token cache (bot plan §3, package F2). Pi-free; memory-only (a token is never
 * persisted, logged, or put in a frame).
 *
 * - `POST /open-apis/auth/v3/tenant_access_token/internal` `{app_id, app_secret}` ⇒ top-level
 *   `{code:0, tenant_access_token, expire}` (probe V11: a wrong secret is HTTP 200 + code `10014`).
 * - Cached until `expire − margin` (`FEISHU_HTTP.tokenRefreshMarginS`, 300 s); a response whose lifetime is
 *   not longer than the margin is used for half its lifetime instead (never an immediate refetch loop);
 *   a missing/invalid `expire` ⇒ the token is returned once and NOT cached.
 * - **Single-flight:** concurrent `get()`s share one in-flight refresh.
 * - **Generation:** every credential set carries a `gen` (F4's credentials generation). The cache, the
 *   auth-failure cooldown and the in-flight refresh are all keyed by it — a refresh that completes after the
 *   generation moved on (reset / re-setup / replace) is DISCARDED and its waiters get `auth: "stale"`;
 *   the old token can never be served for the new credentials.
 * - **auth_failed** (`isAuthFailedCode`, V11) is negative-cached for `authFailedCooldownMs` (default 30 s) so
 *   an operation burst cannot hammer the platform with a wrong secret (each attempt can leave a platform
 *   audit entry); a generation change clears it at once. Transient failures are never cached.
 */

import { FEISHU_HTTP, isAllowedApiBase, isAuthFailedCode } from "../../protocol/feishu.js";
import { makeFailure, systemFeishuClock } from "./http.js";
import type { FeishuClock, FeishuFailure, FeishuHttp } from "./http.js";

export interface TokenCredentials {
  appId: string;
  appSecret: string;
  /** Credentials generation (F4); any change invalidates cache, cooldown and in-flight refreshes. */
  gen: number;
}

export interface TenantToken {
  token: string;
  gen: number;
  /** clock ms at which this token stops being served from cache */
  usableUntil: number;
}

export type TokenResult = { ok: true; data: TenantToken } | FeishuFailure;

export interface TokenManagerDeps {
  http: FeishuHttp;
  /** Live credentials, read on every `get()`; `undefined` ⇒ unconfigured/reset. */
  credentials: () => TokenCredentials | undefined;
  clock?: FeishuClock;
  /** default `FEISHU_HTTP.tokenRefreshMarginS * 1000` */
  marginMs?: number;
  /** default 30 000 */
  authFailedCooldownMs?: number;
}

export interface TokenManager {
  /** Resolve a valid token (cached / single-flight refresh). Never throws. */
  get(opts?: { signal?: AbortSignal }): Promise<TokenResult>;
  /**
   * The platform rejected `token` (`99991663/99991664`): drop it — but only if it is still the cached one
   * (a concurrent refresh's newer token is kept). Returns whether anything was dropped.
   */
  invalidate(token: string): boolean;
  /** Current cached token (for redaction sets only — callers must never log it). */
  peek(): string | undefined;
  /** After dispose every `get()` is `unconfigured` and the cache is empty. */
  dispose(): void;
}

const MAX_TOKEN_LEN = 4_096;
const MAX_EXPIRE_S = 7_200;

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const clock = deps.clock ?? systemFeishuClock;
  const marginMs = deps.marginMs ?? FEISHU_HTTP.tokenRefreshMarginS * 1_000;
  const cooldownMs = deps.authFailedCooldownMs ?? 30_000;

  let cached: TenantToken | undefined;
  let failedAuth: { gen: number; failure: FeishuFailure; until: number } | undefined;
  let inflight: { gen: number; promise: Promise<TokenResult> } | undefined;
  let disposed = false;

  const authFailure = (auth: NonNullable<FeishuFailure["auth"]>, from?: FeishuFailure): FeishuFailure => {
    const failure = makeFailure("auth", from !== undefined ? from.reason : `token-${auth}`, {
      auth,
      ...(from?.status !== undefined ? { status: from.status } : {}),
      ...(from?.code !== undefined ? { code: from.code } : {}),
      ...(from?.msg !== undefined ? { msg: from.msg } : {}),
      ...(from?.scopes !== undefined ? { scopes: from.scopes } : {}),
    });
    // The token stage never reached a send: the effect of the CALLER's request is none, whatever the cause
    // (a transient transport error during refresh included — the caller's own request was not sent).
    failure.effect = "none";
    failure.retryable = auth === "transient" || auth === "stale";
    return failure;
  };

  const currentGen = (): number | undefined => {
    if (disposed) return undefined;
    try {
      return deps.credentials()?.gen;
    } catch {
      return undefined;
    }
  };

  async function refresh(creds: TokenCredentials): Promise<TokenResult> {
    const gen = creds.gen;
    const r = await deps.http.json({
      op: "token",
      method: "POST",
      path: FEISHU_HTTP.tokenPath,
      json: { app_id: creds.appId, app_secret: creds.appSecret },
      secrets: [creds.appSecret],
    });
    // generation moved on while we were waiting: discard whatever came back
    if (currentGen() !== gen) return authFailure("stale");

    if (!r.ok) {
      if (r.kind === "destination" || r.kind === "bad-request") return authFailure("refused", r);
      if (r.kind === "api" && r.code !== undefined && isAuthFailedCode(r.code)) {
        const failure = authFailure("auth_failed", r);
        failedAuth = { gen, failure, until: clock.now() + cooldownMs };
        return failure;
      }
      return authFailure("transient", r);
    }

    const token = r.data.body["tenant_access_token"];
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN || /\s/.test(token)) {
      return authFailure("transient", makeFailure("protocol", "protocol:invalid-token-response"));
    }
    const expireRaw = r.data.body["expire"];
    const expireS =
      typeof expireRaw === "number" && Number.isFinite(expireRaw) ? Math.min(MAX_EXPIRE_S, Math.max(0, expireRaw)) : 0;
    const lifetimeMs = expireS * 1_000;
    const validMs = lifetimeMs > marginMs ? lifetimeMs - marginMs : Math.floor(lifetimeMs / 2);
    const entry: TenantToken = { token, gen, usableUntil: clock.now() + validMs };
    // a zero-lifetime token is served to this caller but never cached
    if (validMs > 0) cached = entry;
    failedAuth = undefined;
    return { ok: true, data: entry };
  }

  function raceAbort(promise: Promise<TokenResult>, signal: AbortSignal | undefined): Promise<TokenResult> {
    if (signal === undefined) return promise;
    if (signal.aborted) return Promise.resolve(authFailure("aborted"));
    return new Promise<TokenResult>((resolve) => {
      const onAbort = (): void => resolve(authFailure("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(authFailure("transient"));
        },
      );
    });
  }

  return {
    get(opts) {
      if (disposed) return Promise.resolve(authFailure("unconfigured"));
      let creds: TokenCredentials | undefined;
      try {
        creds = deps.credentials();
      } catch {
        creds = undefined;
      }
      if (creds === undefined || creds.appId.length === 0 || creds.appSecret.length === 0) {
        cached = undefined;
        failedAuth = undefined;
        return Promise.resolve(authFailure("unconfigured"));
      }
      const gen = creds.gen;
      if (cached !== undefined && cached.gen !== gen) cached = undefined;
      if (failedAuth !== undefined && failedAuth.gen !== gen) failedAuth = undefined;

      if (cached !== undefined && clock.now() < cached.usableUntil) {
        const hit: TokenResult = { ok: true, data: cached };
        return Promise.resolve(hit);
      }
      cached = undefined;
      if (failedAuth !== undefined && clock.now() < failedAuth.until) {
        return Promise.resolve(failedAuth.failure);
      }
      if (opts?.signal?.aborted) return Promise.resolve(authFailure("aborted"));
      if (inflight !== undefined && inflight.gen === gen) return raceAbort(inflight.promise, opts?.signal);

      const startedFor = creds;
      const promise: Promise<TokenResult> = (async (): Promise<TokenResult> => {
        if (!isAllowedApiBase(deps.http.apiBase)) {
          return authFailure("refused", makeFailure("destination", "destination:base"));
        }
        return refresh(startedFor);
      })().finally(() => {
        if (inflight?.promise === promise) inflight = undefined;
      });
      inflight = { gen, promise };
      return raceAbort(promise, opts?.signal);
    },

    invalidate(token) {
      if (cached !== undefined && cached.token === token) {
        cached = undefined;
        return true;
      }
      return false;
    },

    peek: () => (disposed ? undefined : cached?.token),

    dispose() {
      disposed = true;
      cached = undefined;
      failedAuth = undefined;
      inflight = undefined;
    },
  };
}
