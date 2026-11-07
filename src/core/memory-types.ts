/**
 * #39 seed DTO single source. Pure DATA ONLY: no imports, host ports, capabilities or pi.
 * The runtime/service core must never depend on memory/ (including erased type imports).
 * Memory scopes type-import/re-export these DTOs instead of maintaining a duplicate shape.
 */
export type MemoryAuthority = "agent" | "user";
export type MemoryApprovalChannel = "tui" | "web";
export type SessionMemoryId = string;
export type MemorySessionId = string;
/** Real SDK message/custom/compact/fork samples satisfy [A-Za-z0-9_-]{1,64}; NOT a path. */
export type MemoryLeafId = string;
export type MemoryTimestamp = string;

export type SessionMemoryGrant =
  | { readonly via: "command" }
  | { readonly via: "dialog"; readonly turn: string; readonly cap: string; readonly channel?: MemoryApprovalChannel };
export interface SessionItem {
  readonly id: SessionMemoryId;
  readonly text: string;
  readonly authority: MemoryAuthority;
  readonly grant?: SessionMemoryGrant;
  readonly created: MemoryTimestamp;
  readonly updated: MemoryTimestamp;
  readonly from?: string;
  readonly originSid?: MemorySessionId;
}
/** Deep-copy then freeze ALL nested records/arrays, never retain the caller's mutable references. */
export interface SessionMemorySeedV1 {
  readonly v: 1;
  readonly fromSid: MemorySessionId;
  readonly fromLeaf?: MemoryLeafId;
  readonly frozenAt: MemoryTimestamp;
  readonly items: readonly SessionItem[];
  readonly nextN: number;
}
/** Explicit empty prevents dequeue-time re-reading. No FastSeed/fast.enabled dependency. */
export type MemorySeedCapture =
  | { readonly v: 1; readonly state: "empty" }
  | { readonly v: 1; readonly state: "captured"; readonly seed: SessionMemorySeedV1 };
