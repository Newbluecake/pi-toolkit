import type { TidyLedgerReservation, TidyLedgerSettlement, TidyLedgerState } from "../contracts.js";

export interface LedgerResult {
  state: TidyLedgerState;
  ok: boolean;
  charged?: number;
  reason?: string;
}
function validAmount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
export function createLedger(capUsd: number): TidyLedgerState {
  return { capUsd: validAmount(capUsd) ? capUsd : 0, spentUsd: 0, reservations: [] };
}
export function reservedUsd(state: TidyLedgerState, exceptRunId?: string): number {
  return state.reservations.reduce((sum, item) => sum + (item.runId === exceptRunId ? 0 : item.amountUsd), 0);
}
/** Reserve before dispatch. A duplicate run id is never allowed to reserve twice. */
export function reserve(state: TidyLedgerState, runId: string, amountUsd: number): LedgerResult {
  if (!runId || !validAmount(amountUsd)) return { state, ok: false, reason: "invalid reservation" };
  if (state.reservations.some((item) => item.runId === runId))
    return { state, ok: false, reason: "run already reserved" };
  if (state.spentUsd + reservedUsd(state) + amountUsd > state.capUsd)
    return { state, ok: false, reason: "cost cap reached" };
  const reservation: TidyLedgerReservation = { runId, amountUsd };
  return { state: { ...state, reservations: [...state.reservations, reservation] }, ok: true };
}

/**
 * Settle a run and release its reservation. Invalid measured costs are charged
 * at least the reservation/estimate, as required by M-T6, then dispatch stops
 * naturally because the ledger has consumed that amount.
 */
export function settle(state: TidyLedgerState, settlement: TidyLedgerSettlement): LedgerResult {
  const reservation = state.reservations.find((item) => item.runId === settlement.runId);
  if (!reservation) return { state, ok: false, reason: "run is not reserved" };
  const estimate = validAmount(settlement.estimatedUsd) ? settlement.estimatedUsd : 0;
  const measured = validAmount(settlement.costUsd);
  const charged = measured ? settlement.costUsd : Math.max(reservation.amountUsd, estimate);
  const reservations = state.reservations.filter((item) => item.runId !== settlement.runId);
  return { state: { ...state, spentUsd: state.spentUsd + charged, reservations }, ok: true, charged };
}

/** Watcher allowance for this run, excluding its own reservation. */
export function watcherCap(state: TidyLedgerState, runId?: string, tidyMaxCostUsd = state.capUsd): number {
  const cap = validAmount(tidyMaxCostUsd) ? tidyMaxCostUsd : 0;
  return Math.max(0, Math.min(cap, state.capUsd - state.spentUsd - reservedUsd(state, runId)));
}
export const settleRun = settle;
