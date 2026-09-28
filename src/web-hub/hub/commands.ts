/**
 * hub command router (plan §6.1/§12.1 C0 — fast-path stub; §12.3 "接管": C3 replaces this whole
 * file's `createCommandRouter()` body with the real §6.3 gated implementation, but the exported
 * `CommandRouter` shape stays the one frozen in `./ports.ts` — `FrontendDeps.commands?` and this
 * module must never drift into two competing interfaces).
 *
 * C0 zero-visible-change contract: `request()` always answers `E_UNSUPPORTED` without ever
 * touching `registry`/`log`/audit/caps — no new capability is ever broadcast, no frame is ever
 * actually dispatched to an agent.
 */
import type { CommandRouter } from "./ports.js";

export type { CommandRouter } from "./ports.js";

export function createCommandRouter(): CommandRouter {
  return {
    request: async (frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_UNSUPPORTED",
      retryable: false,
      effect: "none",
    }),
    drain: async () => ({ inflight: 0, timedOut: false }),
    inflight: () => 0,
  };
}
