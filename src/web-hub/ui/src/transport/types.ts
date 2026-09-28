/**
 * Transport abstraction (vue-plan.md v2.1 §3.4, §5.2 — P0 frozen). Both `@logic/token-client.js`
 * (`createClient`, extracted in this same P0 package from the legacy `app.js`) and
 * `@logic/password-client.js` (`createPasswordClient`) are adapted to `satisfies HubTransport` /
 * `satisfies PasswordTransport` by P1's `transport/{token,password}.ts` — never re-implemented
 * here. `tests/web-hub/ui/transport-contract.test.ts` (P1) runs the identical suite against both
 * adapters so the two transports can never silently diverge again (the exact regression class
 * 78dd76b was: password client missing `subscribe`/`page`).
 */

/** SSE frame or local UI/transport event — same shape `@logic/state.js`'s `reduce(state, msg)` consumes. */
export interface Msg {
  readonly event: string;
  readonly data: unknown;
  readonly id?: number;
}

export type ConnState = "connecting" | "open" | "reconnecting" | "auth";

export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

export interface TransportHooks {
  onMessage(msg: Msg): void;
  onConn(state: ConnState): void;
}

/**
 * `HistoryPayload` is intentionally `unknown`-shaped here (not imported from
 * `@protocol/http-contract.js`) — `page()`'s wire payload is exactly `HistoryPayload`, but this
 * module stays free of a hard `@protocol` dependency so it can be typechecked standalone;
 * `Result<import("@protocol/http-contract.js").HistoryPayload>` is what call sites actually use.
 */
export interface CmdRequest {
  agentKey: string;
  id: string;
  op: "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "command";
  text?: string;
  deliver?: "steer" | "followUp";
  runId?: string;
  name?: string;
  args?: string;
  confirm?: true;
  expect?: { sessionId?: string };
  queryOnly?: true;
}
export interface DialogRequest {
  agentKey: string;
  id: string;
  dialogId: string;
  epoch: string;
  action: "answer" | "cancel";
  answers?: readonly { selected: readonly string[]; other: string | null }[];
  queryOnly?: true;
}
export type CmdOutcome =
  | { readonly ok: true; readonly data?: unknown; readonly dup?: boolean }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message?: string;
      readonly retryable: boolean;
      readonly retryAfterS?: number;
      readonly effect?: "none" | "unknown";
    };

export interface HubTransport {
  readonly mode: "token" | "password";
  start(): Promise<void>;
  close(): void;
  subscribe(clientId: string, agentKey: string): Promise<{ ok: boolean; error?: string }>;
  unsubscribe(clientId: string, agentKey: string): Promise<void>;
  page<T = unknown>(agentKey: string, before: string, limit?: number): Promise<Result<T>>;
  command(req: CmdRequest): Promise<CmdOutcome>;
  dialog(req: DialogRequest): Promise<CmdOutcome>;
}

/** `@logic/password-client.js`'s `login()` return shape (JSDoc-documented there; mirrored here). */
export type LoginResult =
  | { readonly ok: true; readonly initialPassword: boolean }
  | { readonly ok: false; readonly kind: "invalid" | "not-allowed" | "network" | "busy-exhausted" }
  | { readonly ok: false; readonly kind: "saturated" | "throttled"; readonly retryAfterS: number }
  | { readonly ok: false; readonly kind: "unknown"; readonly status: number };

export interface PasswordTransport extends HubTransport {
  readonly mode: "password";
  login(username: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;
}
