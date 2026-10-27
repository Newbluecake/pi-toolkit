/**
 * cache-ttl · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const CACHE_TTL_SETTING_SPECS: Record<string, SettingSpec> = {
  "cacheTtl.mode": choice(
    "cacheTtl.mode",
    ["auto", "on", "off"],
    "Anthropic prompt-cache TTL: auto=follow pi/env, on=force 1h, off=provider default (5m)",
  ),
  "cacheTtl.keepalive": bool("cacheTtl.keepalive", "Master switch for prompt-cache keepalive pings"),
  "cacheTtl.keepaliveIntervalS": seconds("cacheTtl.keepaliveIntervalMs", {
    min: 60,
    max: 240,
    description:
      "Interval between keepalive pings (max 240s: longer intervals can never ping before the 5m TTL safety margin)",
  }),
  "cacheTtl.keepaliveMinPrefixTokens": count(
    "cacheTtl.keepaliveMinPrefixTokens",
    0,
    "Minimum measured prefix tokens required before keepalive engages",
  ),
};
