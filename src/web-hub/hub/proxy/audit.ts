/** §7 field-whitelisted audit. Never accept a URL, request, headers, error text, cookie, code or sid. */
import { createHash } from "node:crypto";
import type { AuthIdentity, HubLog } from "../ports.js";
import {
  PROXY_CAP_REASONS,
  PROXY_DENY_LOG_THROTTLE_MS,
  PROXY_DENY_REASONS,
  PROXY_END_LOG_FIELDS,
  PROXY_LOG_EVENTS,
  PROXY_LIMIT_REASONS,
  PROXY_MAX_PROXIES_MAX,
  PROXY_OPEN_LOG_FIELDS,
  PROXY_TARGET_CLASSES,
  PROXY_UNAVAILABLE_EXTRA_REASONS,
  type ProxyCapReason,
  type ProxyDenyReason,
  type ProxyLimitReason,
  type ProxyTargetClass,
  type ProxyUnavailableExtraReason,
} from "../../protocol/proxy.js";
import { canonicalAddr, parseProxyTarget } from "./target.js";

export interface ProxyOpenAudit {
  readonly ok: boolean;
  readonly reason?: ProxyDenyReason | ProxyLimitReason | ProxyUnavailableExtraReason | ProxyCapReason;
  readonly identity: Pick<AuthIdentity, "principal" | "listener">;
  readonly cls?: ProxyTargetClass;
  readonly targetIp?: string;
  readonly targetPort?: number;
  readonly host?: string;
  readonly port?: number;
}
export interface ProxyEndAudit {
  readonly instanceId: string;
  readonly end: "idle" | "hard" | "revoked" | "close";
  readonly reqs: number;
  readonly bytesUp: number;
  readonly bytesDown: number;
  readonly ws: number;
}
export interface ProxyAudit {
  /** instanceId is for throttle only; never emitted verbatim. */
  open(input: ProxyOpenAudit, instanceId?: string): boolean;
  end(input: ProxyEndAudit): void;
  /** Release throttle state on instance shutdown (no timers). */
  forget(instanceId: string): void;
}
function project(fields: readonly string[], record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(fields.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
}
function portOk(n: number | undefined): n is number {
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 65535;
}
function count(n: number): number {
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
/** errCode-only helper for engine catch-alls. Unknown/untrusted exception text is never returned. */
export function proxyErrCode(err: unknown): string {
  if (
    typeof err !== "object" ||
    err === null ||
    !("code" in err) ||
    typeof err.code !== "string" ||
    !/^E[A-Z0-9_]+$/.test(err.code)
  )
    return "E_PROXY_UNAVAILABLE";
  return err.code;
}
export function createProxyAudit(log: Pick<HubLog, "info">, now: () => number): ProxyAudit {
  const deniedAt = new Map<string, number>();
  return {
    open(input, instanceId) {
      if (!input.ok && instanceId !== undefined) {
        const t = now();
        for (const [id, at] of deniedAt) {
          if (t - at >= PROXY_DENY_LOG_THROTTLE_MS) deniedAt.delete(id);
        }
        if (deniedAt.has(instanceId)) return false;
        // Audit must never become a permanent drop gate. If > the live-instance ceiling churn
        // inside one window, log new ids and retire the oldest throttle (not the log event).
        if (deniedAt.size >= PROXY_MAX_PROXIES_MAX) deniedAt.delete(deniedAt.keys().next().value!);
        deniedAt.set(instanceId, t);
      }
      const rec: Record<string, unknown> = { ok: input.ok === true };
      const id = input.identity;
      if (id.listener === "loopback" || id.listener === "lan") rec.listener = id.listener;
      if (
        (id.listener === "lan" && /^u[1-9]\d*$/.test(id.principal)) ||
        (id.listener === "loopback" && /^[A-Za-z0-9_-]{43}$/.test(id.principal))
      )
        rec.principal = id.principal;
      if (
        input.reason !== undefined &&
        (
          [
            ...PROXY_DENY_REASONS,
            ...PROXY_LIMIT_REASONS,
            ...PROXY_UNAVAILABLE_EXTRA_REASONS,
            ...PROXY_CAP_REASONS,
          ] as readonly string[]
        ).includes(input.reason)
      )
        rec.reason = input.reason;
      if (input.cls !== undefined && (PROXY_TARGET_CLASSES as readonly string[]).includes(input.cls))
        rec.cls = input.cls;
      const ip = input.targetIp === undefined ? undefined : canonicalAddr(input.targetIp);
      if (ip !== undefined && portOk(input.targetPort))
        rec.target = `${ip.v === 6 ? `[${ip.key}]` : ip.key}:${input.targetPort}`;
      if (portOk(input.port)) {
        rec.port = input.port;
        if (input.host !== undefined) {
          const parsed = parseProxyTarget(`${input.host}:${input.port}`);
          if (
            parsed.ok &&
            parsed.target.host === input.host &&
            parsed.target.port === input.port &&
            parsed.target.nextPath === "/"
          )
            rec.host = parsed.target.host;
        }
      }
      try {
        log.info(PROXY_LOG_EVENTS[0], project(PROXY_OPEN_LOG_FIELDS, rec));
      } catch {
        /* best effort */
      }
      return true;
    },
    end(input) {
      const rec = {
        instTag: createHash("sha256").update(input.instanceId).digest("base64url"),
        end: (["idle", "hard", "revoked", "close"] as const).includes(input.end) ? input.end : "close",
        reqs: count(input.reqs),
        bytesUp: count(input.bytesUp),
        bytesDown: count(input.bytesDown),
        ws: count(input.ws),
      };
      try {
        log.info(PROXY_LOG_EVENTS[1], project(PROXY_END_LOG_FIELDS, rec));
      } catch {
        /* best effort */
      }
    },
    forget(instanceId) {
      deniedAt.delete(instanceId);
    },
  };
}
