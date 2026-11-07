/** Activation-local public loader-bus contract. No pi imports, globals or timers. */
import type { EffectiveHubSlot } from "./types.js";

export const MEMORY_BIND_EVENT = "subagent:memory-bind";
export interface MemoryChildOwner {
  readonly runId: string;
  readonly incarnation: object;
}
/** The actual SDK object, not a wrapper. Production store uses this exact identity. */
export interface MemoryChildManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch(): readonly unknown[];
  appendCustomEntry?(customType: string, data: unknown): unknown;
}
export interface MemoryBindReply {
  readonly v: 1;
  readonly wired: true;
  readonly dispose: () => void;
}
export interface MemoryBindRequest {
  readonly v: 1;
  readonly owner: MemoryChildOwner;
  readonly manager: MemoryChildManager;
  readonly reason: "created" | "resume";
  readonly frozenParentHubSlot?: EffectiveHubSlot;
  /** Synchronous reply only; late replies dispose their own binding. */
  readonly reply: (response: MemoryBindReply) => void;
}
export interface MemoryChildBindingPort {
  readonly frozenParentHubSlot?: EffectiveHubSlot;
  /** Internal test gate only. Production absence remains diagnostic-only (#27). */
  readonly strict?: boolean;
}
export interface MemoryChildBus {
  on(event: string, handler: (value: unknown) => void): () => void;
}

/** One activation accepts one exact driver incarnation/manager; no lazy resume inference. */
export function receiveMemoryChildBinding(
  bus: MemoryChildBus,
  bind: (request: MemoryBindRequest) => () => void,
): () => void {
  let current: { request: MemoryBindRequest; response: MemoryBindReply } | undefined;
  let disposed = false;
  const off = bus.on(MEMORY_BIND_EVENT, (value) => {
    const request = value as MemoryBindRequest | undefined;
    if (disposed || !request || request.v !== 1 || typeof request.reply !== "function") return;
    if (request.reason !== "created" && request.reason !== "resume") return;
    if (!request.owner || !request.owner.incarnation || !request.manager) return;
    if (current) {
      if (
        current.request.owner.incarnation === request.owner.incarnation &&
        current.request.owner.runId === request.owner.runId &&
        current.request.manager === request.manager
      )
        request.reply(current.response);
      return;
    }
    const release = bind(request);
    let live = true;
    const response: MemoryBindReply = {
      v: 1,
      wired: true,
      dispose() {
        if (!live) return;
        live = false;
        disposed = true;
        off();
        release();
      },
    };
    current = { request, response };
    request.reply(response);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    off();
    current?.response.dispose();
  };
}
