/** T51 P0 cross-package internal ports. Types only, no assembly/fallback implementation.
 * Re-exported by ports.ts (the agent-side I8 type-only entry). No auth intent in ledger. */
import type { AuthIdentity } from "./auth-identity.js";
import type { AuthRevokeSelector } from "./auth-revoke.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./ports.js";
import type {
  LedgerV2,
  TerminalScopeV2,
  TerminalTargetLimitsV2,
  TerminalCreateInputV2,
  TerminalMetadataV2,
  TerminalStateV2,
  TerminalHttpRequestsV2,
  TerminalHttpResponseV2,
  TerminalFailureV2,
  TerminalViewFrameV2,
} from "../protocol/terminal-v2.js";

/** Immutable captured context; object identity of linkInstance is significant, never serialized.
 * resolve: exact matching v2 status/current UDS only, <=2s/32 flights; no legacy probing.
 * Recheck current + auth/privacy after RPC, reserve and immediately before backend fork. */
export interface TerminalContextSnapshotV2 {
  readonly scope: Readonly<TerminalScopeV2>;
  readonly cwd: string;
  readonly contextGeneration: number;
  readonly linkInstance: object;
  readonly limits: Readonly<TerminalTargetLimitsV2>;
}
export interface TerminalContextPort {
  resolve(scope: TerminalScopeV2, signal: AbortSignal): Promise<TerminalContextSnapshotV2>;
  current(snapshot: TerminalContextSnapshotV2): boolean;
}

/** P1 owns service/tabs/ring/backend/ledger; P2 implements this view port and its IO.
 * One writer per term, busy never steals. start is called once AFTER headers are committed.
 * detach seals input/resize/ACK and discards pending bytes, never closes the shell.
 * Failure before stream headers is JSON; after headers only error frame or local detach. */
export interface TerminalViewV2 {
  readonly viewId: string;
  start(sink: TerminalViewSinkV2): void;
  detach(): void;
}
export interface TerminalViewSinkV2 {
  /** false means local queue rejected; no public SSE/ring/encoder allowed.
   * A true return means accepted, NOT rendered. Only browser ACK advances consumed offset. */
  send(frame: TerminalViewFrameV2): boolean;
  close(): void;
}
export type TerminalOpenViewResultV2 = { ok: true; view: TerminalViewV2 } | TerminalFailureV2;
export interface TerminalViewPortV2 {
  open(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["view"],
    signal: AbortSignal,
  ): Promise<TerminalOpenViewResultV2>;
  /** queryOnly:true only looks up recorded seq results AFTER original auth/scope/view checks.
   * Never expose another/retired view's history; reject stale view as usual. No PTY call,
   * create, writer acquisition or idle renewal. Keep <=64 results + maximum accepted seq;
   * evicted/never accepted/unprovable result => E_INPUT_UNKNOWN effect:unknown, never rewrite. */
  input(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["input"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"input">>;
  resize(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["resize"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"resize">>;
  ack(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["ack"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"ack">>;
}
/** P1 → P2 bridge: exact live term handle, not a second PTY owner. P2 owns single-writer
 * CAS/seq/ACK/queues. P1 owns bounded ring and backend. `invalidated` aborts synchronously
 * on close/scope/privacy/auth loss; retained handles cannot reopen/adopt. */
export interface TerminalRuntimeV2 {
  readonly termId: string;
  readonly invalidated: AbortSignal;
  readonly metadata: Readonly<TerminalMetadataV2>;
  current(): boolean;
  snapshot(): { start: number; end: number; state: TerminalStateV2; exitCode?: number };
  /** Atomic ring suffix capture. start may advance past requested offset: P2 emits gap.
   * end is the captured replay boundary. <=maxBytes, each chunk <=8KiB; no future live bytes. */
  read(
    offset: number,
    maxBytes: number,
  ): { start: number; end: number; chunks: ReadonlyArray<{ offset: number; bytesB64: string }> };
  /** Body-free change notification; unsubscribe is idempotent, no extra public event stream. */
  subscribe(changed: () => void): () => void;
  /** One attempt only; P2 pins seq before await and NEVER retries unknown input.
   * Only nonempty user input renews P1 idle. Responses/resize/ACK never renew idle. */
  write(
    bytesB64: string,
    kind: "user" | "terminal_response",
    signal: AbortSignal,
  ): Promise<{ ok: true } | TerminalFailureV2>;
  resize(cols: number, rows: number, signal: AbortSignal): Promise<{ ok: true } | TerminalFailureV2>;
}
export type TerminalRuntimeResultV2 = { ok: true; runtime: TerminalRuntimeV2 } | TerminalFailureV2;
export interface TerminalServiceV2 {
  runtime(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["view"],
    signal: AbortSignal,
  ): Promise<TerminalRuntimeResultV2>;
  list(auth: AuthIdentity, scope: TerminalScopeV2, signal: AbortSignal): Promise<TerminalHttpResponseV2<"list">>;
  /** Once accepted, cancellation cancels waiting only. Pin requestId until actual settlement.
   * ensure-empty joins/selects exact-scope current tab/pending; never adopts cold unknown. */
  create(
    auth: AuthIdentity,
    scope: TerminalScopeV2,
    input: TerminalCreateInputV2,
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"create">>;
  creation(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["creation"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"creation">>;
  rename(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["rename"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"rename">>;
  /** Query ledger first: cold unknown => E_CLEANUP_UNKNOWN, never not-found/closed.
   * closed requires complete hot physical proof AND exact durable prune. */
  close(
    auth: AuthIdentity,
    input: TerminalHttpRequestsV2["close"],
    signal: AbortSignal,
  ): Promise<TerminalHttpResponseV2<"close">>;
  /** Synchronously seal original scope before asynchronous cleanup. Never adopt a new link. */
  retireScope(scope: TerminalScopeV2): void;
  dispose(): Promise<{ clean: boolean; unresolved: number }>;
}
export interface TerminalRoutesPortV2 {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    identity: AuthIdentity,
    signal: AbortSignal,
  ): Promise<boolean>;
  dispose(): Promise<void>;
}

/** One authoritative allocationsById set, both hot and cold; no disk+hot double counting.
 * `unavailable` does not mean empty. A determined failed write is none; uncertain commit
 * poisons resource admission globally (not auth). Never infer prune from close/exit/PID/TTL. */
export interface TerminalAllocationLedgerPortV2 {
  load(signal: AbortSignal): Promise<{ kind: "loaded"; ledger: LedgerV2 } | { kind: "unavailable" }>;
  commit(
    expectedRevision: number,
    next: LedgerV2,
    signal: AbortSignal,
  ): Promise<
    { kind: "committed"; revision: number } | { kind: "conflict" } | { kind: "unavailable"; effect: "none" | "unknown" }
  >;
}

/** INTERNAL committed auth facts only; never wire/disk/browser input or an auth DB clone. */
export type TerminalAuthFact =
  | { kind: "sid-absent"; sidTag: string }
  | { kind: "user-epoch-advanced"; userId: number; beforeEpoch: number; afterEpoch: number }
  | { kind: "user-absent"; userId: number }
  | { kind: "listeners-invalidated"; loopAuthGen: number; lanComplete: boolean }
  | { kind: "no-change-confirmed" };
export interface TerminalAuthFenceV2 {
  readonly revision: number;
  check(id: AuthIdentity, capturedRevision: number): void;
  /** Synchronous, NO IO/no Promise, MUST NOT throw to auth. Seal matching views/input,
   * abort flights, initiate hot cleanup without waiting. Callback faults poison only terminal.
   * Auth caller also isolates callback errors and ALWAYS runs its own DB/token transaction. */
  invalidate(selector: AuthRevokeSelector): number;
  /** Exact selector+revision only; concurrent revoke invalidates stale settle. Fact missing =>
   * retain deny in this process. No TTL/login proof; restart trusts original auth sources. */
  settle(selector: AuthRevokeSelector, revision: number, fact: TerminalAuthFact): void;
}
