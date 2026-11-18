/** P2-only physical resize serialization, shared for the P1 service/runtime lifetime.
 * Not a PTY owner: no bytes/resources/cleanup, no retries, auth or direct IO. start()
 * delegates exactly one resize attempt through the original P1 runtime port. View/factory
 * disposal has NO clear/release capability; only the original Promise settlement releases.
 */
import type { TerminalRuntimeV2 } from "../../terminal-v2-ports.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import { fail, requireLive, TerminalV2Fault } from "./local.js";
export interface TerminalResizeFlightV2 {
  readonly result: ReturnType<TerminalRuntimeV2["resize"]>;
  readonly settled: boolean;
}
export interface TerminalResizeGateV2 {
  busy(runtime: TerminalRuntimeV2): boolean;
  start(runtime: TerminalRuntimeV2, cols: number, rows: number, signal: AbortSignal): TerminalResizeFlightV2;
}
/** P6 creates ONE gate per service lifetime, injecting it into every replacement view
 * factory using that service's handles. Exact object keys, not termId strings. WeakMap
 * does not retain retired runtimes; unresolved physical work still conservatively counts
 * against a hard bounded flight budget until actual settlement, never a cancellation flag.
 */
export function createTerminalResizeGateV2(): TerminalResizeGateV2 {
  const active = new WeakMap<TerminalRuntimeV2, { settled: boolean }>();
  let pending = 0;
  return {
    busy: (runtime) => active.has(runtime),
    start(runtime, cols, rows, signal) {
      requireLive(signal);
      if (runtime.invalidated.aborted || !runtime.current()) throw new TerminalV2Fault(fail("E_SESSION_CHANGED"));
      if (active.has(runtime)) throw new TerminalV2Fault(fail("E_NOT_READY"));
      if (pending >= L.hardTotal) throw new TerminalV2Fault(fail("E_RATE"));
      const entry = { settled: false };
      active.set(runtime, entry);
      pending++;
      const settled = () => {
        entry.settled = true;
        if (active.get(runtime) !== entry) return;
        active.delete(runtime);
        pending--;
      };
      let result: ReturnType<TerminalRuntimeV2["resize"]>;
      try {
        result = runtime.resize(cols, rows, signal);
      } catch (error) {
        settled();
        throw error;
      }
      void result.then(settled, settled);
      return {
        result,
        get settled() {
          return entry.settled;
        },
      };
    },
  };
}
