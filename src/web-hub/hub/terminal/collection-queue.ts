/** Complete inventory publications share one single-writer fence. Queueing is
 * inside the ORIGINAL exact flight's deadline; cancellation never releases the
 * writer while its underlying publication is still settling. No retries. */
import { TERMINAL_LIMITS as L } from "../../protocol/terminal.js";
import { bounded, TerminalFault } from "./limits.js";

export class TerminalCollectionQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly now: () => number) {}

  async run<T>(publish: () => Promise<T>, deadlineAt: number, signal: AbortSignal): Promise<T> {
    if (this.pending >= L.unresolvedResources) throw new TerminalFault("E_LIMIT");
    if (signal.aborted || this.now() >= deadlineAt) throw new TerminalFault("E_DEADLINE", "unknown");
    this.pending++;
    const work = this.tail
      .then(() => {
        if (signal.aborted || this.now() >= deadlineAt) throw new TerminalFault("E_DEADLINE", "unknown");
        return publish(); // caller rechecks the original exact producer/challenge guard
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return bounded(work, this.now, deadlineAt, signal);
  }
}
