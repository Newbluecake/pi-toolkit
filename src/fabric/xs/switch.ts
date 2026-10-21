/**
 * fabric phase-2 XS0 (phase2-plan §4.1): the ONE place that decides whether the cross-session
 * surface exists for this process. `xsOn` is a pure function over the four prerequisite
 * switches — frozen once per `activate()` (the value decides tool registration, hello caps and
 * whether the `xs` slot is ever sent); later packages (X2/XW) are the only callers that may
 * evaluate it, always with values read at their own frozen points.
 *
 * Truth table (§4.5): xs send/receive needs ONLY `xsOn` — the RootWakeController additionally
 * needs `fabric.wake.enabled ∧ rootRunMaxS > 0 ∧ host capability observed/verified ∧
 * receive === "wake"`; any miss degrades `wake:true` to deliver-only. Cross-session traffic
 * NEVER falls back to an unsupervised legacy `triggerTurn:true` path (review #8).
 *
 * Pi-free by construction (XS0 source-scan gate: `src/fabric/xs/**` must not import pi).
 */

/** The minimal shape `xsOn` needs from `fabric.*` settings (structural, no settings import). */
export interface XsSwitchFabric {
  enabled: boolean;
  crossSession: { enabled: boolean };
}

/** The minimal shape `xsOn` needs from `webHub.*` settings (structural, no settings import). */
export interface XsSwitchWebHub {
  enabled: boolean;
  /** `webHub.control !== false` — pass the already-negated form here. */
  control: boolean;
}

export interface XsSwitchInputs {
  fabric: XsSwitchFabric;
  webHub: XsSwitchWebHub;
}

/**
 * `xsOn = fabric.enabled ∧ fabric.crossSession.enabled ∧ webHub.enabled ∧ webHub.control`
 * (phase2-plan §4.1). Every input defaults to false-ish only through the caller — this
 * function does no parsing and no fallback; malformed settings are the parsers' problem.
 */
export function xsOn(inputs: XsSwitchInputs): boolean {
  return inputs.fabric.enabled && inputs.fabric.crossSession.enabled && inputs.webHub.enabled && inputs.webHub.control;
}
