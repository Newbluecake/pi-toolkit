// §2.2–§2.3 tiered rendering — STUB (todo #22 P0-b's frozen-surface commit;
// real implementation lands in package P1, §14.1). `inject.ts` only reaches
// this module when `memory.layout === "tiered"`, which defaults to
// `"legacy"` in P0 (§9) — so this stub is unreachable under the default
// settings, and its `throw` degrades to `SKIP` via `inject.ts`'s existing
// try/catch (never crashes the session).

import type { TieredRenderInput, TieredRenderResult } from "./contracts.js";

/** Not implemented yet (P1). Pure function — `input.options?.extraTopics`
 *  MUST stay undefined until T4 ships (§13); P1 enforces that, not this stub. */
export function renderTiered(_input: TieredRenderInput): TieredRenderResult {
  throw new Error("renderTiered: not implemented yet (todo #22 P1)");
}

/** §2.3's `minimalFrame` — the L5-vs-normal decision input, shares
 *  `TIERED_TEMPLATES` with `renderTiered` (never a second copy of the format). */
export function minimalFrame(_input: TieredRenderInput): string {
  throw new Error("minimalFrame: not implemented yet (todo #22 P1)");
}
