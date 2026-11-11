/** In-process child completion bridge: one weak-keyed slot per enabled child.
 * Shared across child activations via Symbol, never retains an SDK message or
 * parent tap strongly. Lifecycle boundaries and unsubscribe evict immediately.
 */
import type { MessageSpeedOwner } from "../web-hub/agent/message-speed.js";
import { sanitizeGenerationCore, type GenerationCore } from "../web-hub/protocol/message-generation.js";

interface Completion {
  owner: MessageSpeedOwner;
  currentOwner(): MessageSpeedOwner | undefined;
  core: GenerationCore;
  revoke?: WeakRef<() => void>;
  read: boolean;
}
const KEY = Symbol.for("pi-subagent:child-message-speed-completion");
type BridgeGlobal = typeof globalThis & { [KEY]?: WeakMap<object, Completion> };
function slots(create = false): WeakMap<object, Completion> | undefined {
  const g = globalThis as BridgeGlobal;
  if (create) g[KEY] ??= new WeakMap();
  return g[KEY];
}
function sameOwner(a: MessageSpeedOwner, b: MessageSpeedOwner | undefined): boolean {
  return (
    b !== undefined &&
    a.ownerToken === b.ownerToken &&
    a.activationGeneration === b.activationGeneration &&
    a.sessionGeneration === b.sessionGeneration &&
    a.sessionId === b.sessionId
  );
}
export function createChildMessageSpeedBridge(currentOwner: () => MessageSpeedOwner | undefined): {
  clear(revoke?: boolean): void;
  complete(message: unknown, core: GenerationCore | undefined): void;
} {
  const map = slots(true)!;
  let last: WeakRef<object> | undefined;
  const clear = (revoke = true): void => {
    const message = last?.deref();
    const slot = message === undefined ? undefined : map.get(message);
    if (message !== undefined) map.delete(message);
    last = undefined;
    try {
      if (revoke && slot !== undefined && sameOwner(slot.owner, currentOwner())) slot.revoke?.deref()?.();
    } catch {
      /* revocation is best effort, never affects other frames */
    }
  };
  return {
    clear,
    complete(message, core) {
      clear();
      const owner = currentOwner();
      if (message === null || typeof message !== "object" || core === undefined || owner === undefined) return;
      map.set(message, { owner: { ...owner }, currentOwner, core: { ...core }, read: false });
      last = new WeakRef(message);
    },
  };
}

/** Read once in public observer → EventTap, with no await or parent recomputation.
 * release() invalidates this exact completion on unsubscribe, never a later slot.
 */
export function takeChildMessageSpeed(
  message: unknown,
  revoke: () => void,
): { core: GenerationCore; release(): void } | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const map = slots(); // read never installs anything (including off profiles)
  const slot = map?.get(message);
  if (slot === undefined || slot.read) return undefined;
  const messageRef = new WeakRef(message);
  const slotRef = new WeakRef(slot);
  const release = (): void => {
    const key = messageRef.deref();
    if (key !== undefined && map?.get(key) === slotRef.deref()) map?.delete(key);
  };
  try {
    const core = sameOwner(slot.owner, slot.currentOwner()) ? sanitizeGenerationCore(slot.core) : undefined;
    if (core !== undefined) {
      slot.read = true;
      slot.revoke = new WeakRef(revoke);
      return { core, release };
    }
  } catch {
    /* stale contexts fail closed */
  }
  release();
  return undefined;
}
