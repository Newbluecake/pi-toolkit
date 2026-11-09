/** Credentials, tool arrays and the two legacy *Ms knobs deliberately remain JSON-only. */
import { bool, type SettingSpec } from "../config/spec-helpers.js";

const inherited = "Unset inherits the legacy file, then built-in default; change: /reload";
export const FEISHU_NOTIFY_SETTING_SPECS: Record<string, SettingSpec> = {
  "feishuNotify.waitNotifyTimeoutSec": {
    kind: "number",
    path: "feishuNotify.waitNotifyTimeoutSec",
    min: 0,
    description: `Wait reminder seconds (default 120); 0 disables. ${inherited}`,
  },
  "feishuNotify.heartbeatIntervalSec": {
    kind: "number",
    path: "feishuNotify.heartbeatIntervalSec",
    min: 0,
    description: `Heartbeat seconds (default 600); 0 disables. ${inherited}`,
  },
  "feishuNotify.idleNotifyTimeoutSec": {
    kind: "number",
    path: "feishuNotify.idleNotifyTimeoutSec",
    min: 0,
    description: `Idle reminder seconds (default 300); 0 disables. ${inherited}`,
  },
  "feishuNotify.subagentSummaryEnabled": bool(
    "feishuNotify.subagentSummaryEnabled",
    `Subagent summary cards (default true). ${inherited}`,
  ),
  "feishuNotify.subagentForegroundSummary": bool(
    "feishuNotify.subagentForegroundSummary",
    `Include foreground subagents (default false). ${inherited}`,
  ),
  "feishuNotify.requireBackgroundIdle": bool(
    "feishuNotify.requireBackgroundIdle",
    `Suppress completion cards while background work is busy (default true). ${inherited}`,
  ),
  "feishuNotify.watchDefault": bool(
    "feishuNotify.watchDefault",
    `Watch new sessions by default (default false). ${inherited}`,
  ),
};
