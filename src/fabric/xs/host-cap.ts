import { readTriggerShape } from "../../adapters/pi-compat.js";

export type XsHostCapabilityState = "unknown" | "observed" | "verified" | "absent";

/** Process-sticky shape evidence (I14). Never runs a probe request, never reads a peer version. */
export class XsHostCapability {
  private value: XsHostCapabilityState = "unknown";
  private warned = false;

  get state(): XsHostCapabilityState {
    return this.value;
  }

  get wakeDowngraded(): "host_unverified" | "host_unsupported" | undefined {
    if (this.value === "unknown") return "host_unverified";
    if (this.value === "absent") return "host_unsupported";
    return undefined;
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
}

const HOST_CAP_KEY = Symbol.for("pi-subagent:xs-host-cap");

export function getXsHostCapability(): XsHostCapability {
  const global = globalThis as Record<symbol, XsHostCapability | undefined>;
  return (global[HOST_CAP_KEY] ??= new XsHostCapability());
}
