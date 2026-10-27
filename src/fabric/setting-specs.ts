/**
 * fabric · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const FABRIC_SETTING_SPECS: Record<string, SettingSpec> = {
  "fabric.enabled": bool("fabric.enabled", "Enable inter-agent message fabric"),
  "fabric.minIntervalS": seconds("fabric.minIntervalMs", {
    description: "Minimum interval between messages on one link",
  }),
  "fabric.maxPerRun": count("fabric.maxPerRun", 0, "Progress messages per sender run"),
  "fabric.findingQuota": count("fabric.findingQuota", 0, "Finding messages per sender run"),
  "fabric.directiveQuota": count("fabric.directiveQuota", 0, "Directive messages per sender run"),
  "fabric.deadLetterQuota": count("fabric.deadLetterQuota", 0, "Dead letters per sender run"),
  "fabric.maxChars": count("fabric.maxChars", 0, "Maximum message characters"),
  "fabric.progressTtlS": seconds("fabric.progressTtlMs", { description: "Progress message retention" }),
  "fabric.progressChannel": choice("fabric.progressChannel", ["context", "display"], "Progress channel to root"),
  "fabric.rootMinIntervalS": seconds("fabric.rootMinIntervalMs", {
    description: "Minimum root context interval; 0 = unlimited, backpressure only",
  }),
  "fabric.rootInboxCap": count("fabric.rootInboxCap", 0, "Maximum pending root context messages"),
  // fabric-cross-session plan v3 §4.8 (phase 1, in-tree): only effective while fabric.enabled; read at stack build.
  "fabric.wake.enabled": bool(
    "fabric.wake.enabled",
    "Let message_agent wake or revive finished sub-agents (needs fabric.enabled)",
  ),
  "fabric.wake.maxLevel": count(
    "fabric.wake.maxLevel",
    0,
    "Max causal wake chain depth; deeper wakes degrade to deliver-only",
  ),
  "fabric.wake.perRunQuota": count("fabric.wake.perRunQuota", 0, "Effective wake:true sends per sender run"),
  "fabric.wake.resumeBudgetS": {
    kind: "number",
    path: "fabric.wake.resumeBudgetS",
    min: 60,
    max: 3600,
    integer: true,
    description: "Fixed time budget (seconds) of a revived run",
  },
  "fabric.wake.resumesPerHour": count("fabric.wake.resumesPerHour", 0, "Max revives per hour (all targets)"),
  "fabric.wake.resumesPerTargetPerHour": count(
    "fabric.wake.resumesPerTargetPerHour",
    0,
    "Max revives per hour for one target",
  ),
  "fabric.wake.parkCapPerTarget": count("fabric.wake.parkCapPerTarget", 0, "Max parked messages per finished target"),
};
