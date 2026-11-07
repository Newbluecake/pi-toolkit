/**
 * traffic · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const TRAFFIC_SETTING_SPECS: Record<string, SettingSpec> = {
  // traffic-merge plan §2.2：默认全关 ⇒ 零注册零 IO；全部非 live（/reload 生效）。
  "traffic.enabled": bool(
    "traffic.enabled",
    "Traffic recording (/record on|off|status) of model inputs/outputs to SQLite + web viewer (change: /reload)",
  ),
  "traffic.childSessions": bool(
    "traffic.childSessions",
    "Record subagent (child session) traffic to the database too; false keeps rewrite attribution but skips rows (change: /reload)",
  ),
  "traffic.web.host": choice(
    "traffic.web.host",
    ["127.0.0.1", "0.0.0.0"],
    "Record web viewer bind address; 0.0.0.0 exposes plaintext HTTP to the LAN (change: /reload)",
  ),
  "traffic.web.port": {
    kind: "number",
    path: "traffic.web.port",
    integer: true,
    min: 1024,
    max: 65535,
    description: "Record web viewer first port (auto-increments when busy, up to 20 tries) (change: /reload)",
  },
};
