import type { CausalLevel } from "./wake-level.js";

/**
 * fabric-cross-session plan v3 §3.3 L7 (W1): the ONLY place the root's causal level is reset — on PROVEN human input.
 *
 *  - `source` `interactive` / `rpc` (terminal or rpc client) ⇒ human ⇒ reset.
 *  - `source` `extension` ⇒ reset only when the web hub vouches that the text is a prompt it dispatched for a browser
 *    user (`attributeInput(text) === "web_prompt"`, a pure ledger lookup). Everything else an extension injects —
 *    topic-switch re-injection of an already-seen input, `/goal` loop continuations, `/agent reload fire`, another
 *    extension's `sendUserMessage` — never resets. Web hub off ⇒ no port ⇒ extension input never resets.
 *
 * The handler only reads; it never transforms or swallows input (`continue` always), so it may sit anywhere in the
 * `input` chain — it is registered BEFORE the mention / topic-switch handlers because those may answer `handled` and
 * stop the chain, and a human `@label` message or a held prompt is still human input.
 */
export interface WakeInputDeps {
  /** Live read of the current stack's causal level (undefined when wake is off / no stack). Read per event. */
  level: () => CausalLevel | undefined;
  /** Web-hub attribution port; late-bound because the web hub is wired after this hook is registered. */
  attributeInput: () => ((text: string) => "web_prompt" | undefined) | undefined;
}

export interface WakeInputEvent {
  text: string;
  source: "interactive" | "rpc" | "extension";
}

/** Shared with RootWakeController; pure attribution, no level mutation. Attribution failures are not human proof. */
export function classifyHumanInput(
  event: WakeInputEvent,
  attributeInput?: (text: string) => "web_prompt" | undefined,
): boolean {
  if (event.source === "interactive" || event.source === "rpc") return true;
  try {
    return event.source === "extension" && attributeInput?.(event.text) === "web_prompt";
  } catch {
    return false;
  }
}

export function createWakeInputHook(deps: WakeInputDeps): (event: WakeInputEvent) => { action: "continue" } {
  return (event) => {
    try {
      const level = deps.level();
      if (level === undefined) return { action: "continue" };
      // Preserve the old lazy port read: interactive/rpc input never consults web attribution.
      if (classifyHumanInput(event, event.source === "extension" ? deps.attributeInput() : undefined))
        level.resetRoot();
    } catch {
      /* attribution is advisory: a failure here must never disturb input handling */
    }
    return { action: "continue" };
  };
}
