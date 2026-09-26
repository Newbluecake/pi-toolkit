/**
 * workflow-worktree plan D13 (v2.1 condition 2): the current session's
 * durable landing spot for a worktree disposition report that arrives AFTER
 * its owning SpawnService/Runner pair has been disposed (a stack rebuild —
 * new/resume/fork/`/reload` — or session_shutdown). Without this, H3
 * (beforeReap) continuing to run in the background would patch the OLD
 * stack's store and, via `wrapWithRunLog`, `pi.appendEntry("subagent:run",
 * …)` into whatever session file that old stack's store closed over — which,
 * after a stack rebuild, is a stale reference that can resurrect an old run
 * into the WRONG session's read-back.
 *
 * pi-free by design (same `Symbol.for` exemption class as
 * `core/worktree-origin.ts` and the HOST_KEY guard): the actual
 * `pi.appendEntry` call lives in stack.ts's registration, not here. Every
 * write is entirely best-effort — a missing sink just warns, never throws.
 */

export interface LateWorktreeDisposition {
  runId: string;
  state: "committed" | "kept" | "clean";
  branch?: string;
  path?: string;
  at: number;
}

const SINK_KEY = Symbol.for("pi-subagent:worktree-disposition-sink");

interface SinkHolder {
  token: object;
  write: (entry: LateWorktreeDisposition) => void;
}

function holder(): SinkHolder | undefined {
  return (globalThis as Record<symbol, unknown>)[SINK_KEY] as SinkHolder | undefined;
}

/**
 * Register the current session's sink. `token` is an opaque identity object
 * (e.g. the stack instance) — only the same token can later release it,
 * matching the HOST_KEY release-by-identity pattern so a stale/late release
 * from a previous stack can never evict a newer one.
 */
export function registerDispositionSink(token: object, write: (entry: LateWorktreeDisposition) => void): void {
  (globalThis as Record<symbol, unknown>)[SINK_KEY] = { token, write };
}

/** Idempotent, identity-checked release — a no-op if `token` no longer owns the current sink. */
export function releaseDispositionSink(token: object): void {
  const current = holder();
  if (current && current.token === token) delete (globalThis as Record<symbol, unknown>)[SINK_KEY];
}

/**
 * Route a late worktree disposition to whichever session currently owns the
 * sink. Absent sink (no session registered, or between shutdown and the next
 * stack's registration) ⇒ WARN only, never throws — this call site (Runner's
 * post-dispose beforeReap write-back) must stay best-effort no matter what.
 */
export function writeLateWorktreeDisposition(entry: LateWorktreeDisposition): void {
  const current = holder();
  if (!current) {
    console.warn(
      `[pi-subagent] late worktree disposition for run ${entry.runId} (${entry.state}) dropped: no session is registered to receive it`,
    );
    return;
  }
  try {
    current.write(entry);
  } catch (err) {
    console.warn(
      `[pi-subagent] late worktree disposition write failed for run ${entry.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
