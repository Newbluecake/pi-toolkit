import { readTriggerShape } from "../../adapters/pi-compat.js";

export type XsHostCapabilityState = "unknown" | "observed" | "verified" | "absent";

/** Process-sticky shape evidence (I14). Never runs a probe request, never reads a peer version. */
export class XsHostCapability {
  private value: XsHostCapabilityState = "unknown";
  private warned = false;

  get state(): XsHostCapabilityState {
    return this.value;
  }

  /** wake-unknown-optimistic: only `absent` downgrades a wake (N1 改判 2026-11). `unknown` dispatches optimistically. */
  get wakeDowngraded(): "host_unsupported" | undefined {
    if (this.value === "absent") return "host_unsupported";
    return undefined;
  }

  /** wake-unknown-optimistic: no BAS shape evidence yet ⇒ dispatch is optimistic (first-run verified). */
  get optimistic(): boolean {
    return this.value === "unknown";
  }

  observe(event: unknown): void {
    if (this.value === "absent") return;
    const shape = readTriggerShape(event);
    if (shape === "legacy") this.value = "absent";
    else if (shape === "union" && this.value === "unknown") this.value = "observed";
  }

  /** Only the guard of an authorized controller token calls this. */
  verify(): void {
    if (this.value !== "absent") this.value = "verified";
  }

  /** Missing custom message/details in deferred: take ownership conservatively and disable future wakes. */
  missingCustomShape(warn: (message: string) => void = console.warn): void {
    this.value = "absent";
    if (this.warned) return;
    this.warned = true;
    try {
      warn("[pi-subagent] xs wake: custom trigger details unavailable; future wakes are deliver-only");
    } catch {
      /* diagnostic only */
    }
  }

  /**
   * wake-unknown-optimistic: the host ran the wake trigger's run WITHOUT a before_agent_start
   * (legacy hosts, F1) — the run reached `context` while BAS never saw the token. Unconditionally
   * absent (sticky even from `verified`: the evidence is exact, not presumptive). Shares the one
   * per-process warn with `missingCustomShape`.
   */
  triggerSkipped(warn: (message: string) => void = console.warn): void {
    this.value = "absent";
    if (this.warned) return;
    this.warned = true;
    try {
      warn(
        "[pi-subagent] xs wake: host ran the wake trigger without before_agent_start; future wakes are deliver-only",
      );
    } catch {
      /* diagnostic only */
    }
  }
}

const HOST_CAP_KEY = Symbol.for("pi-subagent:xs-host-cap");

export function getXsHostCapability(): XsHostCapability {
  const global = globalThis as Record<symbol, XsHostCapability | undefined>;
  return (global[HOST_CAP_KEY] ??= new XsHostCapability());
}
