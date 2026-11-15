/** Activation-local lifecycle, owned only by wireWebHub's existing handlers.
 * No pi registrations, global owner, Stack member or off-path IO. */
import { parseTerminalSession, type TerminalSession } from "../../protocol/terminal-session.js";
import type { CmdFrame } from "../../protocol/messages.js";
import type { TerminalNegotiation, TermReq } from "../../protocol/terminal.js";
import { createTerminalOwner, type TerminalOwner, type TerminalOwnerOptions } from "./owner.js";

type OwnerPort = Pick<TerminalOwner, "offer" | "receive" | "linkLost" | "revoke" | "dispose" | "ready">;
export function createTerminalWiring(
  factory: (options: TerminalOwnerOptions) => Promise<OwnerPort> = createTerminalOwner,
) {
  let generation = 0;
  let owner: OwnerPort | undefined;
  let options: TerminalOwnerOptions | undefined;
  let allowed: (() => boolean) | undefined;
  const check = () => {
    try {
      if (allowed?.() === true) return true;
    } catch {
      /* unknown is denied */
    }
    owner?.revoke();
    return false;
  };
  const dispose = () => {
    generation++;
    const old = owner;
    owner = undefined;
    allowed = undefined;
    options = undefined;
    // dispose synchronously seals capabilities BEFORE the caller detaches its connection.
    if (old) void old.dispose().catch(() => {});
  };
  return {
    async start(next: TerminalOwnerOptions): Promise<void> {
      dispose();
      const gen = generation;
      options = next;
      allowed = next.allowed;
      if (!check()) return;
      try {
        const created = await factory(next);
        if (gen !== generation) {
          void created.dispose().catch(() => {});
          return;
        }
        owner = created;
        if (!check()) dispose();
      } catch {
        /* no fallback owner, offer stays unsupported */
      }
    },
    declaration(): TerminalSession | undefined {
      try {
        const o = options;
        if (!o || !check() || owner?.ready() !== true) return undefined;
        const c = o.current();
        if (!c || c.sessionId !== o.sessionId || c.epoch !== o.epoch) return undefined;
        return parseTerminalSession({
          v: 1,
          enabled: true,
          sessionId: o.sessionId,
          epoch: o.epoch,
          limits: { ...o.limits },
        });
      } catch {
        return undefined;
      }
    },
    offer(frame: CmdFrame, request: TerminalNegotiation) {
      return check() ? owner?.offer(frame, request) : undefined;
    },
    receive(frame: TermReq): void {
      if (check()) owner?.receive(frame);
    },
    linkLost(): void {
      owner?.linkLost();
    },
    check,
    dispose,
  };
}
