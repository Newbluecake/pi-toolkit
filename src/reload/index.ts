/**
 * Deferred /reload — pi-facing assembly (all mutable state in this closure;
 * /reload re-imports the module, so nothing module-level may be mutable).
 *
 * Wiring:
 * - session_start (TUI only, settings.reload.defer): wrap the current editor
 *   so an exact `/reload` submission becomes `/agent reload`.
 * - subagent:completed / subagent:failed on the pi.events bus: recount active
 *   runs and let the controller fire once the fleet is empty. The bus
 *   survives /reload, so both subscriptions are collected and dropped on
 *   session_shutdown (same pattern as src/hud/).
 * - fire: `pi.sendUserMessage("/agent reload fire", { deliverAs: "followUp",
 *   expandPromptTemplates: true })` — command dispatch in pi's prompt() is
 *   gated behind `expandPromptTemplates`, which sendUserMessage defaults to
 *   FALSE (agent-session.js), so without the flag the injected text bypasses
 *   `_tryExecuteExtensionCommand` and lands in the LLM context as a plain
 *   user message (observed live: the fire message reached the model, reload
 *   never ran). With the flag, dispatch executes the command immediately —
 *   even mid-stream — which also beats any follow-up spawn the model might
 *   issue once it receives the settling run's result. The fire command
 *   re-checks busyness itself, so a stale fire just re-arms.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import { DeferredReloadController } from "./defer.js";
import { createReloadEditorFactory } from "./editor.js";

export interface DeferredReloadDeps {
  settings: AgentSettings;
  /** Fresh count of non-terminal subagent runs, read at event time. */
  activeRunCount: () => number;
}

/**
 * Wire the deferred-reload feature; returns the controller so the `/agent`
 * command layer can arm/disarm/inspect it. Call AFTER wireSessionNav so this
 * session_start handler runs after session-nav's and wraps its editor.
 */
export function wireDeferredReload(pi: ExtensionAPI, deps: DeferredReloadDeps): DeferredReloadController {
  const controller = new DeferredReloadController({
    fire: () => {
      // expandPromptTemplates: true is load-bearing — see the module header.
      pi.sendUserMessage("/agent reload fire", { deliverAs: "followUp", expandPromptTemplates: true });
    },
  });

  const onSettle = () => {
    controller.handleRunSettled(deps.activeRunCount());
  };
  const busUnsubscribers: Array<() => void> = [
    pi.events.on("subagent:completed", onSettle),
    pi.events.on("subagent:failed", onSettle),
  ];

  pi.on("session_start", (_event, ctx) => {
    // TUI-only: child/rpc sessions never replace the editor component, and
    // print mode has no editor at all. The setting gates the interception
    // only — `/agent reload` stays usable regardless.
    if (ctx.mode !== "tui") return;
    if (!deps.settings.reload.defer) return;
    ctx.ui.setEditorComponent(createReloadEditorFactory(ctx.ui.getEditorComponent()));
  });

  pi.on("session_shutdown", () => {
    while (busUnsubscribers.length > 0) busUnsubscribers.pop()?.();
  });

  return controller;
}
