/**
 * topic-switch · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, csvString } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const TOPIC_SWITCH_SETTING_SPECS: Record<string, SettingSpec> = {
  // topic-switch (docs/dev/topic-switch/plan.md §P3b.1): nine settable keys; `debugAssumedTtlS`
  // is a JSON-only live-acceptance seam and deliberately NOT listed here. `topicSwitch.model` is
  // csv-style: stored/displayed as a comma-joined string, live `topicSwitch.models: string[]`.
  "topicSwitch.enabled": bool(
    "topicSwitch.enabled",
    "Offer to switch to a clean new session for a new, unrelated, expensive request (default on)",
  ),
  "topicSwitch.costThresholdUsd": {
    kind: "number",
    path: "topicSwitch.costThresholdUsd",
    min: 0.01,
    max: 100,
    description: "Only offer a switch when the next request's estimated cost exceeds this (USD)",
  },
  "topicSwitch.model": csvString(
    "topicSwitch.models",
    "Comma-separated provider/id chain for the relevance judge, tried in order with failover " +
      '(or "" to fall back to title.model then the session model). Sends the new request and a short excerpt ' +
      "of the recent conversation to these models.",
  ),
  "topicSwitch.judgeTimeoutS": seconds("topicSwitch.judgeTimeoutMs", {
    min: 1,
    max: 30,
    description: "Hard timeout for the relevance judge call; timeout/error always fail open (stay)",
  }),
  "topicSwitch.minConfidence": {
    kind: "number",
    path: "topicSwitch.minConfidence",
    min: 0,
    max: 1,
    description: "Minimum judge confidence to treat a request as unrelated",
  },
  "topicSwitch.confirmTimeoutS": seconds("topicSwitch.confirmTimeoutMs", {
    min: 5,
    max: 300,
    description: "Confirmation dialog timeout; timing out counts as staying (and starts the cooldown)",
  }),
  "topicSwitch.minChars": {
    ...count("topicSwitch.minChars", 0, "Code-point length below which a message is treated as too short to judge"),
    max: 200,
  } as SettingSpec,
  "topicSwitch.regrowTokens": count(
    "topicSwitch.regrowTokens",
    0,
    "Context growth (tokens) needed to lift a per-session cooldown after declining a switch; 0 = only a compaction lifts it",
  ),
  "topicSwitch.expirySlackS": seconds("topicSwitch.expirySlackMs", {
    max: 600,
    description: "Extra slack beyond the assumed cache TTL before a prefix is proven cold",
  }),
};
