import type { HubAssembly } from "./assembly.js";
import { createScheduleService } from "./schedule/service.js";

export function assembleSchedule(ctx: HubAssembly) {
  const { config, paths, log, now, cleanup } = ctx;
  const registry = ctx.registry!;
  // scheduled-reports plan r3 §7 (H1): the read-only schedule coordinator — constructed ONLY
  // when `config.schedule` exists (key absence IS off: no reader, no `sched.v1`, no frames, no
  // disk). A store root that fails to resolve degrades INSIDE the coordinator (empty
  // projection + WARN, hub keeps running); dispose drains its hub-state flush. The 60s scan
  // loop, observation clock and every timer it owns are unref'd.
  const scheduleHub =
    config.schedule === undefined
      ? undefined
      : createScheduleService({ config: config.schedule, stateDir: paths.stateDir, registry, log, now });
  if (scheduleHub !== undefined) cleanup.push(() => scheduleHub.dispose());

  return scheduleHub;
}
