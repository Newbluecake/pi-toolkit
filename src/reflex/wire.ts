/**
 * jev-reflex · pi-facing assembly (plan R0 step 8; arch §4.2). R0 SKELETON: guard + the six frozen
 * registrations; every handler is inert (`continue` / no-op). R2b/R3a fill behaviour — they must NOT
 * change the registration list or its order (activate-trace `max` pins it).
 *
 * Invariants kept here: R-I1 (secure/locked ⇒ zero registration), R-I3 (never sendUserMessage / triggerTurn /
 * transform — fallback is always `continue`), R-I5/R-I7 (sync input handler; generation/disposed protocol, PD11),
 * R-I8 (all mutable state in this closure, no `Symbol.for`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReflexCommand } from "./command.js";
import type { ReflexSettings } from "./core/settings.js";
import type { ReflexStatusSnapshot } from "./core/types.js";
import type { ReflexPortDeps } from "./ports/index.js";
import { renderReflexMessage } from "./render-tui.js";

export interface ReflexWireDeps {
  /** Live getter (autoResolve is re-read on every input). */
  settings: () => ReflexSettings;
  secureDomainKind: "plain" | "secure" | "locked";
  ports: ReflexPortDeps;
  fences: {
    /** Late-bound: topic-switch is wired AFTER the R layer. */
    topicSwitchActive: () => boolean;
    goalBusy: () => boolean;
  };
}

export interface ReflexWiring {
  /** Read-only snapshot for the command and tests. */
  snapshot(): ReflexStatusSnapshot;
  /** PD11: late async settles must be dropped when `disposed || gen !== generation`. */
  isStale(gen: number): boolean;
  generation(): number;
}

/** Double lock: `secureDomainKind !== "plain"` ⇒ return undefined, zero registrations. */
export function wireReflex(pi: ExtensionAPI, deps: ReflexWireDeps): ReflexWiring | undefined {
  if (deps.secureDomainKind !== "plain") return undefined;

  // ---- closure state (I4/R-I8) ----
  let disposed = false;
  let generation = 0;
  let inFlight = false;
  let abort = new AbortController();

  const isStale = (gen: number): boolean => disposed || gen !== generation;

  // ① input — plain (non-async) function, fail-open: R0 is always `continue`.
  pi.on("input", () => {
    try {
      return { action: "continue" as const };
    } catch {
      return { action: "continue" as const };
    }
  });

  // ② agent_settled — shadow record settlement lands here (R2b).
  pi.on("agent_settled", () => undefined);

  // ③ session_start — PD11 re-arm: the same closure serves the next session of this activation.
  pi.on("session_start", () => {
    disposed = false;
    abort = new AbortController();
    // R2b: clear pending slot + repeat/correction window memory here.
    inFlight = false;
  });

  // ④ session_shutdown — abort in-flight work, drop pending, bump generation.
  pi.on("session_shutdown", () => {
    try {
      abort.abort();
    } catch {
      /* best-effort */
    }
    // R2b: drop pending slot here.
    disposed = true;
    generation += 1;
  });

  // ⑤ renderer (probe-registered: hosts without the API fall back to pi's default rendering).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer("subagent:reflex", renderReflexMessage);
  }

  // ⑥ command
  pi.registerCommand("reflex", createReflexCommand());

  return {
    snapshot: () => ({
      enabled: deps.settings().enabled,
      generation,
      disposed,
      inFlight,
      scripts: [],
      counters: {},
      unknownAutoResolve: [],
    }),
    isStale,
    generation: () => generation,
  };
}
