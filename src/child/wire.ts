/**
 * Child-session assembly (child-context-switch plan.md §2, package P3).
 *
 * Single pre-guard entry point called from `src/index.ts` when `isChildSession` — mirrors
 * `src/bash/child.ts`'s own convention (registered once per `activate()`, everything lazy,
 * no dependency on `session_start` — plan §0 fact 3 / §2 device diagram). Composes the two
 * child-session features and wires the one cross-cutting signal between them: a committed
 * boundary-draft switch rewrites the child session's context exactly like a compaction does,
 * so the keepalive service must invalidate on it too (plan §2.4).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import { wireFastChild, type FastWireOptions } from "../fast/wire.js";
import { wireChildContextSwitch } from "../context-switch/child.js";
import { wireChildKeepalive } from "../cache-ttl/child.js";
import { wireChildMessageSpeed, type ChildMessageSpeedOptions } from "./message-speed.js";
import { getInputBudgetRegistry, inputTokensForBytes } from "../runtime/input-budget-registry.js";

export function wireChildSession(
  pi: ExtensionAPI,
  settings: AgentSettings,
  fastOptions?: FastWireOptions,
  messageSpeedOptions?: ChildMessageSpeedOptions,
): void {
  wireChildMessageSpeed(pi, settings, messageSpeedOptions);
  const keepalive = wireChildKeepalive(pi, settings);
  // Fast must precede even synchronous budget-registry replay (and traffic outside this factory).
  wireFastChild(pi, settings.fast.enabled, fastOptions);
  const registry = getInputBudgetRegistry();
  // Registration is deferred until the first budgeted run in this process.
  // At most one provider handler is installed for this child pi session; an
  // unregistered session remains a no-op because the handler resolves the
  // current session's entry at request time.
  let installed = false;
  let unsubscribeBudget: (() => void) | undefined;
  const install = () => {
    if (installed) return;
    installed = true;
    pi.on("before_provider_request", (event, ctx) => {
      const registration = registry.get(ctx.sessionManager.getSessionId());
      if (!registration) return;
      let payloadBytes: number;
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(event.payload) ?? "null", "utf8");
      } catch {
        // An unserializable provider payload cannot be measured safely: fail closed.
        payloadBytes = Number.MAX_SAFE_INTEGER;
      }
      registration.onMeasure(payloadBytes);
      if (inputTokensForBytes(payloadBytes) > registration.maxInputTokens) {
        // pi deliberately swallows handler errors. Abort synchronously instead;
        // the provider receives the already-aborted signal and does not send.
        registration.abort(
          `input-budget: measured ${inputTokensForBytes(payloadBytes)} tokens > ${registration.maxInputTokens}`,
        );
      }
    });
    // One-shot: the handler resolves the session's registration at request time,
    // so no later registry event concerns this session. Unsubscribe immediately;
    // during `subscribe`'s replay of already-registered sessions the unsubscribe
    // binding is not assigned yet, hence the post-subscribe guard below.
    unsubscribeBudget?.();
  };
  unsubscribeBudget = registry.subscribe(install);
  if (installed) unsubscribeBudget();
  pi.on("session_shutdown", () => {
    // Strong reference from this child session to `install`: the registry holds
    // listeners only weakly (finished child sessions must not be pinned — they are
    // disposed via `AgentSession.dispose()`, which never emits `session_shutdown`),
    // so this handler, which lives inside the session's own object graph, is what
    // keeps the measurer closure alive for exactly as long as the session lives.
    void install;
    unsubscribeBudget?.();
  });
  wireChildContextSwitch(pi, settings, {
    onSwitchCommitted: () => keepalive?.noteContextSwitch(),
  });
}
