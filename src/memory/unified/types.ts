/** v4's pi-free public DTOs and host-owned read/call ports. */
import type { HubItem, SessionItem, ScopedMemoryErrorCode } from "../scopes/types.js";

export type MemoryCommand = "view" | "create" | "update" | "delete" | "search";
export type MemoryScope = "project" | "session" | "hub";
export interface MemoryV4Params {
  command: MemoryCommand;
  scope?: MemoryScope | "all";
  path?: string;
  id?: string;
  text?: string;
  rev?: string;
  query?: string;
  topic?: string;
  from?: string;
  authority?: "agent" | "user";
}
export type NormalizedMemoryCall = MemoryV4Params & { scope: MemoryScope | "all" };
export type ProjectMemoryErrorCode =
  | "E_META_INVALID"
  | "E_NOT_FOUND"
  | "E_REV_REQUIRED"
  | "E_CONFLICT"
  | "E_TOO_LARGE"
  | "E_WRITE_GATE"
  | "E_READONLY"
  | "E_BAD_PATH"
  | "E_BAD_TOPIC"
  | "E_UNMIGRATED"
  | "E_UNSUPPORTED_COMMAND";
export type UnifiedMemoryErrorCode = ScopedMemoryErrorCode | ProjectMemoryErrorCode | "E_INTERNAL";
export interface UnifiedError {
  code: UnifiedMemoryErrorCode;
  message: string;
  originalCode?: string;
  originalMessage?: string;
}
export type ScopeState = "ok" | "empty" | "absent" | "disabled" | "inert" | "poisoned" | "error";
/** Never includes entries, identity, revision or grant metadata. */
export interface ScopeStatus {
  state: ScopeState;
  code?: string;
  message?: string;
  originalCode?: string;
  originalMessage?: string;
}
export type ProjectReadGroup =
  | { kind: "listing"; text: string }
  | { kind: "hits"; hits: { path: string; rev: string; line: number; text: string }[] };
export interface SessionEntry {
  id: string;
  rev: string;
  item: SessionItem;
  inherited?: unknown;
}
export interface HubEntry {
  id: string;
  rev: string;
  item: HubItem;
}
export type SessionReadGroup = { kind: "items"; items: SessionEntry[] } | { kind: "hits"; hits: SessionEntry[] };
export type HubReadGroup = { kind: "items"; items: HubEntry[] } | { kind: "hits"; hits: HubEntry[] };
export type ReadInspection<G> =
  | { status: ScopeStatus & { state: "ok" | "empty" | "absent" }; group: G }
  | { status: ScopeStatus & { state: "disabled" | "inert" | "poisoned" | "error" }; group?: never };
export interface AggregateRead {
  ok: true;
  partial: boolean;
  scopeStatus: Record<MemoryScope, ScopeStatus>;
  groups: { project?: ProjectReadGroup; session?: SessionReadGroup; hub?: HubReadGroup };
}
export interface ScopedV4Port {
  /** Undecorated shared operation path: v4 must not receive alias deprecation metadata. */
  dispatch(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  inspect(scope: "session", call: MemoryV4Params): ReadInspection<SessionReadGroup>;
  inspect(scope: "hub", call: MemoryV4Params): ReadInspection<HubReadGroup>;
}
export interface ProjectV4Port<Context = unknown> {
  run(toolCallId: string, params: MemoryV4Params, signal: AbortSignal | undefined, context: Context): Promise<unknown>;
  inspect(
    call: MemoryV4Params,
    context: Context,
  ): ReadInspection<ProjectReadGroup> | Promise<ReadInspection<ProjectReadGroup>>;
}
