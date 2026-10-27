/**
 * Probe extension for tests/conformance/lifecycle-entries.test.ts (#56 ⑦ step 7-0).
 *
 * It is loaded BY PATH (`additionalExtensionPaths`), not through `extensionFactories`, because only
 * path-loaded extensions go through pi's `extensionCache` — the very thing the probe measures:
 *  - module top level runs once per (re-)import  → `moduleLoads` / `moduleId`
 *  - the default-export factory runs per activation → `activations`
 * Two `session_shutdown` handlers are registered; the first one is async and slow, the second one only
 * logs. If pi did not await handlers sequentially, "shutdown:2" would be logged before "shutdown:1:end".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Probe {
  moduleLoads: number;
  activations: number;
  log: string[];
}

const KEY = Symbol.for("pi-toolkit:test:lifecycle-probe");
const slot = globalThis as unknown as Record<symbol, Probe | undefined>;

function probe(): Probe {
  const p = slot[KEY];
  if (p === undefined) throw new Error("lifecycle probe not initialised by the test");
  return p;
}

const moduleId = ++probe().moduleLoads;

export default function lifecycleProbe(pi: ExtensionAPI): void {
  const p = probe();
  const activation = ++p.activations;
  p.log.push(`activate:${activation}:module${moduleId}`);
  pi.on("session_start", (event) => {
    probe().log.push(`start:${activation}:${event.reason}`);
  });
  pi.on("session_shutdown", async (event) => {
    probe().log.push(`shutdown:${activation}:${event.reason}:1:begin`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref();
    });
    probe().log.push(`shutdown:${activation}:${event.reason}:1:end`);
  });
  pi.on("session_shutdown", (event) => {
    probe().log.push(`shutdown:${activation}:${event.reason}:2`);
  });
}
