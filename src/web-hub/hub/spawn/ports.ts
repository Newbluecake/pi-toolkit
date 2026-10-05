/**
 * web-hub-spawn plan §SP1 (arch v2 §4.1/#3): the spawn subsystem's type-only ports.
 *
 * `hub/spawn/*` implementations (SP7 supervisor, SP8 first-prompt, SP9 routes) depend on THESE
 * `Pick<>` shapes and never on the concrete `Registry`/`CommandRouter` — the assignment
 * `Registry` ⊇ `SpawnRegistryPort` is pinned compile-time by
 * `tests/web-hub/contract/types.test-d.ts` (#3 硬门槛), so a test double only has to satisfy the
 * narrow port. Types only, no runtime code; `http.ts` (SP9) injects `SpawnRouteIo`'s members
 * from its own per-listener helpers (`dispatchCmdOrDialog`'s opts are the precedent).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SpawnsPayload } from "../../protocol/spawn.js";
import type { CommandRouter } from "../ports.js";
import type { Registry } from "../registry.js";
import type { ReqDeadline } from "../req-deadline.js";

/** The registry surface the spawn subsystem reads: views, the bus, publishing, per-agent caps. */
export type SpawnRegistryPort = Pick<Registry, "list" | "get" | "bus" | "publish" | "getCaps">;

/** The command-router surface first-prompt forwarding needs (SP8): just `request()`. */
export type FirstPromptRouterPort = Pick<CommandRouter, "request">;

/** Successful `authorize()`: the authenticated principal the route charges limits/audits to. */
export interface SpawnAuthResult {
  ip: string;
  user?: string;
}

/** `authorize()` already sent its own error response (401/429/503); `code` is mirror-back only. */
export interface SpawnAuthHandled {
  handled: true;
  code: string;
}

/** Structural shape of `http.ts`'s `HttpError` (status-carrying, `API_ERRORS`-coded). */
export interface HttpErrorLike extends Error {
  readonly status: number;
  readonly code: string;
}

/**
 * What `hub/http.ts` injects into every spawn route dispatch, one instance per request per
 * listener (mirrors `dispatchCmdOrDialog`'s opts — same helpers, same semantics):
 * `strictCsrfOk`/`authorize` are the listener's own gates, `readJson`/`sendJson`/`sendError`
 * are the shared body/response helpers, `HttpError` lets routes throw errors the outer handler
 * maps via `statusFor` (SP9). `scheme`/`viaTrustedProxy` feed the LAN scope decision
 * (`lan:"roots"` is capped to `known` on plain-HTTP direct connections, arch §6.4/§8.2).
 */
export interface SpawnRouteIo {
  listener: "loopback" | "lan";
  /** Known before `authorize()` ever runs (LAN: `ctx.clientIp`; loopback: peer IP). */
  ip: string;
  scheme: "http" | "https";
  viaTrustedProxy: boolean;
  strictCsrfOk(): boolean;
  authorize(deadline: ReqDeadline): Promise<SpawnAuthResult | SpawnAuthHandled>;
  readJson(req: IncomingMessage, maxBytes?: number, maxMs?: number): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  sendError(res: ServerResponse, status: number, code: string, message?: string): void;
  HttpError: new (status: number, code: string, message?: string) => HttpErrorLike;
}

/**
 * The frontend surface `createHttpFrontend` optionally carries (SP9 wires
 * `FrontendDeps.spawn`): `handle` dispatches `/api/headless*` for ONE listener; `publicPayload`
 * renders that listener's SSE `spawns` snapshot — LAN policy `off` yields `undefined`, which is
 * the "byte-identical to not-enabled" contract for the LAN face (arch §8.2 matrix).
 */
export interface SpawnFrontendPort {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
    io: SpawnRouteIo,
  ): Promise<void>;
  publicPayload(listener: "loopback" | "lan"): SpawnsPayload | undefined;
}
