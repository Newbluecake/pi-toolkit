/**
 * Scheduled tasks — the session-visible surface, assembled (plan r3 §5; A3).
 *
 * One activate-level object that `src/index.ts` (assembly only, invariant I7) wires in; it owns no
 * logic of its own beyond gluing pi events/ctx to the pure A3 modules:
 *  - `opsPorts()` — the ports the `schedule` tool and `/schedule` share (agent-type registry, settings
 *    limits, strict-model check against the live registry, canonical cwd, dispatcher capability);
 *  - per-session `start()` — status-bar controller + the opening digest (after the agent's own
 *    sweep/recovery), torn down on `shutdown()` / the next `start()`;
 *  - `turn_start` / `agent_settled` hooks — cheap re-render + digest verification. (A0's own
 *    `turn_start` hook only pokes the clock; this one is separate and registered once per activate.)
 * No module-level state: everything lives in this closure, rebuilt on every `activate()` (/reload).
 */
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScheduleSettings } from "../../config/settings.js";
import type { AgentTypeRegistry } from "../../config/agent-types.js";
import { systemClock } from "../../core/clock.js";
import { getXsHostCapability } from "../../fabric/xs/host-cap.js";
import { SCHED_STATUS_KEY } from "../core/spec.js";
import { createScheduleDigest, type ScheduleDigest } from "./digest.js";
import { systemTimeZone, type OpsPorts } from "./ops.js";
import { createScheduleStatus, type ScheduleStatus } from "./status.js";
import { isEpochDisposed, type ScheduleAgent } from "./wire.js";

export interface ScheduleSurfaceDeps {
  settings: Pick<ScheduleSettings, "defaultTimeoutMs" | "maxTimeoutMs">;
  types: Pick<AgentTypeRegistry, "get" | "list">;
  /** The CURRENT stack's schedule agent (late-bound through the holder). */
  current(): ScheduleAgent | undefined;
}

export interface ScheduleSurface {
  opsPorts(agent: ScheduleAgent, ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">): OpsPorts;
  /** session_start, after `agent.start()` has been kicked off. Resolves when the opening digest ran. */
  start(ctx: ExtensionContext, agent: ScheduleAgent | undefined): Promise<void>;
  shutdown(): void;
}

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function wireScheduleSurface(pi: ExtensionAPI, deps: ScheduleSurfaceDeps): ScheduleSurface {
  let status: ScheduleStatus | undefined;
  let digest: ScheduleDigest | undefined;
  let lastTick = -Infinity;
  const TICK_MIN_MS = 5_000;

  const teardown = (): void => {
    status?.dispose();
    digest?.dispose();
    status = undefined;
    digest = undefined;
  };

  pi.on("turn_start", () => {
    status?.refresh();
  });
  pi.on("agent_settled", () => {
    status?.refresh();
    const now = systemClock.now();
    if (digest !== undefined && now - lastTick >= TICK_MIN_MS) {
      lastTick = now;
      void digest.tick();
    }
  });

  return {
    opsPorts(agent, ctx) {
      return {
        agent,
        now: () => systemClock.now(),
        limits: {
          defaultTimeoutS: Math.round(deps.settings.defaultTimeoutMs / 1000),
          maxTimeoutS: Math.round(deps.settings.maxTimeoutMs / 1000),
        },
        agentTypes: {
          has: (name) => deps.types.get(name) !== undefined,
          names: () => deps.types.list().map((t) => t.name),
        },
        knownModel: (ref) => {
          try {
            return ctx.modelRegistry.find(ref.provider, ref.id) !== undefined;
          } catch {
            return undefined; // cannot tell ⇒ allowed (the spawn admission re-checks at run time)
          }
        },
        capability: () => getXsHostCapability().state,
        ownerCwd: () => canonicalCwd(ctx.cwd),
        defaultTz: systemTimeZone,
      };
    },
    async start(ctx, agent) {
      teardown();
      if (agent === undefined || agent.mode.kind !== "interactive") return;
      const st = createScheduleStatus({
        agent: deps.current,
        setStatus: (text) => ctx.ui.setStatus(SCHED_STATUS_KEY, text),
        capability: () => getXsHostCapability().state,
        clock: systemClock,
      });
      status = st;
      st.start();
      const dg = createScheduleDigest({
        agent,
        sessionFile: () => {
          try {
            return ctx.sessionManager.getSessionFile();
          } catch {
            return undefined;
          }
        },
        sendMessage: (message, options) => pi.sendMessage(message, options),
        notify: (text) => {
          try {
            ctx.ui.notify(text, "info");
          } catch {
            /* stale ctx */
          }
        },
        isIdle: () => {
          try {
            return ctx.isIdle();
          } catch {
            return false;
          }
        },
        clock: systemClock,
        isEpochDisposed,
      });
      digest = dg;
      // The agent's own start (first sweep + recovery) is kicked off by the caller; wait for it so the
      // digest sees the post-sweep ledger. Never throws.
      await agent.start();
      if (digest !== dg) return; // superseded by a newer session_start / shutdown
      await dg.run();
      st.refresh();
    },
    shutdown: teardown,
  };
}
