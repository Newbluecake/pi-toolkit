/** Activation-local lifecycle, owned only by wireWebHub's existing handlers.
 * No pi registrations, global owner, Stack member or off-path IO. */
import { TerminalLocalError } from "../../protocol/terminal-local.js";
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
  let retryableInitial = false;
  let attemptedLink: string | undefined;
  let inFlight: object | undefined;
  const check = () => {
    try {
      if (allowed?.() === true) return true;
    } catch {
      /* unknown is denied */
    }
    owner?.revoke();
    dispose(); // withdrawal seals even an owner-less/in-flight initialization
    return false;
  };
  const dispose = () => {
    generation++;
    const old = owner;
    owner = undefined;
    allowed = undefined;
    options = undefined;
    retryableInitial = false;
    attemptedLink = undefined;
    inFlight = undefined;
    // dispose synchronously seals capabilities BEFORE the caller detaches its connection.
    if (old) void old.dispose().catch(() => {});
  };
  const initialize = async (next: TerminalOwnerOptions, gen: number, link?: string): Promise<boolean> => {
    const flight = {};
    inFlight = flight;
    try {
      const created = await factory(next);
      let current: ReturnType<TerminalOwnerOptions["current"]>;
      try {
        current = link === undefined ? undefined : next.current();
      } catch {
        void created.dispose().catch(() => {});
        return false;
      }
      if (
        gen !== generation ||
        (link !== undefined &&
          (current?.localConnectionInstance !== link ||
            current.sessionId !== next.sessionId ||
            current.epoch !== next.epoch))
      ) {
        void created.dispose().catch(() => {});
        return false;
      }
      owner = created;
      if (!check()) return false;
      retryableInitial = false;
      return true;
    } catch (error) {
      if (gen === generation && link === undefined)
        retryableInitial = error instanceof TerminalLocalError && error.reason === "stale-authority-prev-boot";
      // Retry failures never expand the initial eligibility (not even unresolved-local-state).
      return false;
    } finally {
      if (inFlight === flight) inFlight = undefined;
    }
  };
  return {
    async start(next: TerminalOwnerOptions): Promise<void> {
      dispose();
      const gen = generation;
      options = next;
      allowed = next.allowed;
      if (!check()) return;
      await initialize(next, gen);
    },
    /** One guarded compensation per genuinely new live link. No timer/status-tick
     * retry, no replacement of an existing/revoked owner, no automatic shell open. */
    async retryLocalAfterHubLink(link: string | undefined): Promise<boolean> {
      if (!link || owner || inFlight || !retryableInitial || attemptedLink === link) return false;
      const next = options,
        gen = generation;
      if (!next || !check()) return false;
      const current = next.current();
      if (
        !current ||
        current.localConnectionInstance !== link ||
        current.sessionId !== next.sessionId ||
        current.epoch !== next.epoch
      )
        return false;
      attemptedLink = link;
      return initialize(next, gen, link);
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
