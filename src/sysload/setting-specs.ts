/**
 * sysload · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const LOAD_SETTING_SPECS: Record<string, SettingSpec> = {
  // Load-aware dispatch (docs/dev/sysload/plan.md §6.1): all non-live — captured at activate,
  // change ⇒ /reload (hub-side sampler additionally needs /webhub restart). sustainS/recoverS's
  // true upper bound is 120×sampleIntervalS (dynamic, enforced by parseLoadSettings); the static
  // max below is a generous editor-input ceiling, same soft-bound posture as other *S knobs here.
  "load.enabled": bool("load.enabled", "Load-aware dispatch: monitor CPU/MEM/DISK and gate new spawns when critical"),
  "load.gate": bool("load.gate", "Block/queue new spawns while the overall level is >= load.gateLevel"),
  "load.gateLevel": choice("load.gateLevel", ["crit", "warn"], "Minimum level that blocks a spawn"),
  "load.sampleIntervalS": seconds("load.sampleIntervalMs", {
    min: 2,
    max: 60,
    description: "Sampler tick period",
  }),
  "load.sustainS": seconds("load.sustainMs", {
    max: 7_200,
    hint: "0 = first valid sample upgrades immediately",
    description: "How long an elevated reading must persist before the level escalates",
  }),
  "load.recoverS": seconds("load.recoverMs", {
    max: 7_200,
    description: "How long a recovered reading must persist before the level de-escalates",
  }),
  "load.cpu.warnPercent": count("load.cpu.warnPercent", 0, "CPU busy % (or PSI) warn threshold"),
  "load.cpu.critPercent": count("load.cpu.critPercent", 0, "CPU busy % (or PSI) crit threshold"),
  "load.cpu.psiWarnPercent": count("load.cpu.psiWarnPercent", 0, "CPU PSI (some avg10) % warn threshold"),
  "load.cpu.psiCritPercent": count("load.cpu.psiCritPercent", 0, "CPU PSI (some avg10) % crit threshold"),
  "load.mem.warnAvailPercent": count("load.mem.warnAvailPercent", 0, "MemAvailable % warn threshold"),
  "load.mem.critAvailPercent": count("load.mem.critAvailPercent", 0, "MemAvailable % crit threshold"),
  "load.disk.warnFreePercent": count("load.disk.warnFreePercent", 0, "Disk free % warn threshold"),
  "load.disk.critFreePercent": count("load.disk.critFreePercent", 0, "Disk free % crit threshold"),
  "load.disk.critFreeGiB": count(
    "load.disk.critFreeGiB",
    0,
    "Disk free-bytes crit threshold (GiB); OR'd with critFreePercent",
  ),
  "load.hint.enabled": bool("load.hint.enabled", "Arm the single-slot turn_end recovery hint"),
  "load.hint.display": bool("load.hint.display", "Show the injected load line in the transcript"),
  "load.hint.repeatS": seconds("load.hint.repeatMs", {
    max: 86_400,
    description: "crit re-announce period; warn announces once per escalation",
  }),
  "load.hint.minIntervalS": seconds("load.hint.minIntervalMs", {
    max: 86_400,
    hint: "crit and the recovery hint bypass this floor",
    description: "Global minimum interval between load messages",
  }),
  "load.hud": bool("load.hud", "Show the load line in the status bar"),
};
