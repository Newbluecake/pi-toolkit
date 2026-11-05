import { isMessageKind, type FabricRecord } from "../core/message.js";
import type { DeliveryEngine } from "../delivery/engine.js";

/**
 * Structural view of the delivery engine: only `transition` is ever needed, so both the full engine (stack build,
 * mailbox pump) and WakeService's narrow `Engine` Pick can call this without a cast.
 */
type TransitionEngine = Pick<DeliveryEngine<FabricRecord, FabricRecord["state"]>, "transition">;

/** #34 (E-entry points): why a record was dropped without a dead letter — its kind is not a current MessageKind. */
export const UNKNOWN_KIND_REASON = "unknown_kind";

/**
 * #34: terminate ONE non-terminal record whose kind is not a current MessageKind (written by an older version).
 * Idempotent, never throws, never retries, never issues a dead letter, never logs the body. Returns true iff
 * this call moved the record to `dropped`.
 *
 * The single shared retire path for every entry point (stack build E3, mailbox pump E5, resume admission E8);
 * the callers guarantee the I1 property by never scheduling a timer for an unknown kind in the first place.
 */
export function retireUnknownKind(
  engine: TransitionEngine,
  record: Pick<FabricRecord, "key" | "kind" | "state">,
): boolean {
  if (isMessageKind(record.kind) || (record.state !== "pending" && record.state !== "claimed")) return false;
  return (
    engine.transition(record.key, ["pending", "claimed"], "dropped", { terminalReason: UNKNOWN_KIND_REASON }) !==
    undefined
  );
}
