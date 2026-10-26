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
import type { SchedOffersFrame } from "../../web-hub/protocol/schedule.js";
import { SCHED_CUSTOM_TYPE, SCHED_STATUS_KEY } from "../core/spec.js";
import { createScheduleConfirm, type ScheduleConfirm } from "./confirm.js";
import { createScheduleDigest, type ScheduleDigest } from "./digest.js";
import { systemTimeZone, type OpsPorts } from "./ops.js";
import { createScheduleStatus, type ScheduleStatus } from "./status.js";
import { isEpochDisposed, type ScheduleAgent } from "./wire.js";

export interface ScheduleSurfaceDeps {
  settings: Pick<ScheduleSettings, "defaultTimeoutMs" | "maxTimeoutMs">;
  types: Pick<AgentTypeRegistry, "get" | "list">;
  /** The CURRENT stack's schedule agent (late-bound through the holder). */
  current(): ScheduleAgent | undefined;
  /** I1: the message scheduler's `revokeTask` (late-bound; absent ⇒ ledger-only revocation). */
  revokeQueued?(taskId: string): void;
}

/**
 * What the session coordinator offers the confirm module (#61 C2 adds these members to
 * `ScheduleCoordinator`; read structurally so the C1 surface compiles and degrades to TUI-only —
 * `NULL_SCHEDULE_COORDINATOR` and a pre-C2 coordinator have neither).
 */
interface ConfirmCoordinatorPort {
  offers?(frame: Omit<SchedOffersFrame, "t">): void;
  confirmReady?(): boolean;
}

export interface ScheduleSurface {
  opsPorts(agent: ScheduleAgent, ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">): OpsPorts;
  /** session_start, after `agent.start()` has been kicked off. Resolves when the opening digest ran. */
  start(ctx: ExtensionContext, agent: ScheduleAgent | undefined): Promise<void>;
  shutdown(): void;
  /** The current session's confirm module (#61); undefined for non-interactive / not started. */
  confirm(): ScheduleConfirm | undefined;
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
  let confirm: ScheduleConfirm | undefined;
  let lastTick = -Infinity;
  const TICK_MIN_MS = 5_000;

  const teardown = (): void => {
    status?.dispose();
    digest?.dispose();
    confirm?.dispose();
    status = undefined;
    digest = undefined;
    confirm = undefined;
  };

  pi.on("turn_start", () => {
    status?.refresh();
  });
  // #61: events the confirm presenter needs (forwarded to the CURRENT session's module; registered once per activate).
  pi.on("input", (event) => {
    if ((event as { source?: string }).source !== "extension") confirm?.onInput();
    return { action: "continue" };
  });
  pi.on("before_agent_start", () => {
    confirm?.onBeforeAgentStart();
  });
  pi.on("ui_prompt_start", (event) => {
    confirm?.onUiPrompt(true, { kind: event.kind, ...(event.title !== undefined ? { title: event.title } : {}) });
  });
  pi.on("ui_prompt_end", (event) => {
    const e = event as { kind?: string; title?: string };
    confirm?.onUiPrompt(false, {
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
      ...(e.title !== undefined ? { title: e.title } : {}),
    });
  });
  pi.on("agent_settled", () => {
    confirm?.onAgentSettled();
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
        ...(deps.revokeQueued !== undefined ? { revokeQueued: deps.revokeQueued } : {}),
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
      const coordinator = (): ConfirmCoordinatorPort => agent.coordinator as ConfirmCoordinatorPort;
      const hasUI = (ctx as { hasUI?: boolean }).hasUI === true;
      confirm = createScheduleConfirm({
        agent,
        ...(hasUI
          ? {
              ui: {
                mode: (ctx as { mode?: string }).mode ?? "print",
                hasUI: true,
                select: (title, options) => ctx.ui.select(title, options),
                notify: (text, level) => ctx.ui.notify(text, level),
                isIdle: () => ctx.isIdle(),
              },
            }
          : {}),
        hubConfirmReady: () => coordinator().confirmReady?.() === true,
        publish: (frame) => coordinator().offers?.(frame),
        notice: (text, details) =>
          pi.sendMessage(
            { customType: SCHED_CUSTOM_TYPE, content: text, display: true, details },
            { triggerTurn: false },
          ),
        ...(deps.revokeQueued !== undefined ? { revoke: deps.revokeQueued } : {}),
        clock: systemClock,
      });
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
    confirm: () => confirm,
  };
}
