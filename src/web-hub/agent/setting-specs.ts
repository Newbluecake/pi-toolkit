/**
 * web-hub (`webHub.*`) · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { count, bool, choice, csvString } from "../../config/spec-helpers.js";
import type { SettingSpec } from "../../config/spec-helpers.js";

export const WEBHUB_SETTING_SPECS: Record<string, SettingSpec> = {
  // web-hub (plan 包 I): five keys, all non-live (captured at activate; change → /reload).
  "webHub.enabled": bool(
    "webHub.enabled",
    "web-hub browser UI via a local hub process (default off ⇒ zero wiring/network/disk)",
  ),
  "webHub.autoStart": bool("webHub.autoStart", "web-hub: auto-spawn the hub process when no hub is running"),
  // web-hub-steer-recall plan §4.2 (arch §11 Q1): default on; non-live like the rest of webHub.*.
  "webHub.steerRecall": bool(
    "webHub.steerRecall",
    "web-hub: hold busy web steer/follow-up until pi's next queue drain so they can be recalled (default on)",
  ),
  "webHub.port": {
    kind: "number",
    path: "webHub.port",
    min: 0,
    max: 65_535,
    integer: true,
    description: "web-hub: HTTP port bound to 127.0.0.1 (0 = ephemeral)",
  },
  "webHub.idleExitMinutes": {
    kind: "number",
    path: "webHub.idleExitMinutes",
    min: 1,
    description: "web-hub: hub self-exits after this many minutes with no agents and no browser clients",
  },
  "webHub.nodeLoader": {
    kind: "string",
    path: "webHub.nodeLoader",
    description: "web-hub: explicit jiti-cli path override (escape hatch when pi bundles no jiti)",
  },
  "webHub.control": bool("webHub.control", "web-hub: accept browser control commands"),
  "webHub.remoteAskUser": bool("webHub.remoteAskUser", "web-hub: allow browser ask_user answers"),
  "webHub.webCommands": bool("webHub.webCommands", "web-hub: allow browser slash commands"),
  "webHub.webCommandPolicy": {
    kind: "string",
    path: "webHub.webCommandPolicy",
    description: "web-hub: JSON command policy overrides (allow|confirm|deny)",
  },
  "webHub.uploads": choice(
    "webHub.uploads",
    ["on", "loopback", "off"],
    "web-hub: file upload availability (on = loopback+LAN, loopback = loopback only, off = disabled)",
  ),
  "webHub.preview": choice(
    "webHub.preview",
    ["on", "loopback", "off"],
    "web-hub: in-browser preview of session-cwd files and session-shared uploads (on = loopback+LAN, loopback = loopback only, off = disabled; change: /reload then /webhub restart; use loopback if others use your LAN)",
  ),
  // web-hub-avatar plan v2.1 §2.6: non-live; change requires /reload then /webhub restart.
  "webHub.avatar": bool("webHub.avatar", "web-hub: shared user avatar image (default on; control:false disables it)"),
  // web-hub-privacy plan v2.1「设置」(P1): non-live; change requires /reload then /webhub restart.
  // off ⇒ hub 不挂路由/不发 privacy 帧/不下 privacy.v1 cap/保留已有 privacy.json 标记文件。
  "webHub.privacy": bool(
    "webHub.privacy",
    "web-hub: per-session privacy lock, L2 view-time re-verification (default on; off keeps privacy.json marks untouched)",
  ),
  // web-hub-fleet-drawer plan §4.4 (F2): subagent transcript (fleet drawer) read plane —
  // independent of webHub.control; non-live like the rest of webHub.* (change → /reload).
  "webHub.subagentTranscript": choice(
    "webHub.subagentTranscript",
    ["all", "loopback", "off"],
    "web-hub: subagent transcript in the fleet drawer (all = loopback+LAN, loopback = loopback only, off = disabled)",
  ),
  // web-hub-slash-args plan §5 (P0): non-live; change requires /reload then /webhub restart.
  // r1 #4: the description states the sync-hang residual honestly (default stays "all", §11 D1 拍板).
  "webHub.commandComplete": choice(
    "webHub.commandComplete",
    ["all", "toolkit", "off"],
    "web-hub: / command argument hints + completion in the browser (all = toolkit + third-party commands via the TUI provider, toolkit = toolkit commands only, off = disabled; a third-party completer that hangs synchronously can stall the session — downgrade to toolkit/off if that happens; change: /reload then /webhub restart)",
  ),
  // quota-web plan §2/D8: StatusInfo.quota availability — non-live like the rest of webHub.*
  // (change → /reload).
  "webHub.quota": bool("webHub.quota", "web-hub: subscription-quota pill/card in the top bar (default on)"),
  // web-hub-cmd-history plan §4.9 (A1): command-output history cards in the session transcript.
  // Non-live; change requires /reload. The description states the Q1 verbatim-persistence
  // residual honestly (credentials printed by a command DO land in the session file, §5.3).
  "webHub.cmdHistory": bool(
    "webHub.cmdHistory",
    "web-hub: persist command output as session history cards (default on; output is stored VERBATIM in the session file incl. any tokens it printed — /webhub sensitive subcommands record headers only; change: /reload)",
  ),
  // web-hub archive plan (docs/dev/web-hub/archive-report.md): agent-side auto-archive knob —
  // non-live but does NOT need a hub restart (never read by buildHubConfig; /reload suffices).
  "webHub.archiveAfterMin": {
    kind: "number",
    path: "webHub.archiveAfterMin",
    min: 0,
    description: "web-hub: auto-archive finished agent cards / bash rows in the fleet drawer after N minutes (0 = off)",
  },
  "webHub.archiveKeepRuns": count(
    "webHub.archiveKeepRuns",
    0,
    "web-hub: keep N unarchived finished agent runs; held items count but are never auto-archived (default 6; 0 = time-only; /reload)",
  ),
  "webHub.archiveKeepBash": count(
    "webHub.archiveKeepBash",
    0,
    "web-hub: keep N unarchived finished bash jobs; held items count but are never auto-archived (default 5; 0 = time-only; /reload)",
  ),
  // web-hub LAN (lan-plan.md §9.1, S1-W3 LI): five more keys under webHub.lan.*, all non-live like
  // the rest of webHub.* (captured at activate; change → /reload). extraHosts/trustProxyFrom/
  // externalOrigins are comma-separated on disk and in the editor (`csvString`'s `csv: true`
  // transform) but validated into `string[]` by `parseWebHubLanBlock` at load/reload time — the
  // editor itself does not re-run §2.1/§2.4 classification (that only happens on reload, same as
  // webHub.port's own "must differ from webHub.port" check).
  "webHub.lan.enabled": bool(
    "webHub.lan.enabled",
    "web-hub LAN access: bind 0.0.0.0:<webHub.lan.port> with username/password auth (default off)",
  ),
  "webHub.lan.port": {
    kind: "number",
    path: "webHub.lan.port",
    min: 1,
    max: 65_535,
    integer: true,
    description: "web-hub LAN: HTTP port bound to 0.0.0.0 (must differ from webHub.port)",
  },
  "webHub.lan.allowClients": csvString(
    "webHub.lan.allowClients",
    "web-hub LAN: client IP/CIDR allowlist; empty is unrestricted, all-invalid denies all (/reload then /webhub restart)",
  ),
  "webHub.lan.sessionIdleMinutes": {
    kind: "number",
    path: "webHub.lan.sessionIdleMinutes",
    min: 5,
    max: 10080,
    integer: true,
    description: "web-hub LAN: session idle timeout in minutes (/reload then /webhub restart)",
  },
  "webHub.lan.extraHosts": csvString(
    "webHub.lan.extraHosts",
    "web-hub LAN: extra host names / IPv4 literals to allow-list, comma-separated",
  ),
  "webHub.lan.trustProxyFrom": csvString(
    "webHub.lan.trustProxyFrom",
    "web-hub LAN: trusted reverse-proxy IPv4 literals (only these may set X-Forwarded-*), comma-separated",
  ),
  "webHub.lan.externalOrigins": csvString(
    "webHub.lan.externalOrigins",
    "web-hub LAN: allowed external https origins reachable via a trusted proxy, comma-separated",
  ),
  // web-hub spawn (web-hub-spawn plan §SP2 / arch v2 §6.2; S1 is Linux-only, fail closed): eight
  // keys under webHub.spawn.*. Like the rest of webHub.* they are non-live AND only reach a
  // running hub inside PI_WEBHUB_CONFIG — every description carries the /reload + restart note.
  // Numeric ranges mirror parseWebHubSpawnBlock's clamps (count() has no max ⇒ spread + override,
  // askUser.backgroundInterrupt.maxPerQuestion 同款).
  "webHub.spawn.enabled": bool(
    "webHub.spawn.enabled",
    "web-hub: spawn headless pi sessions in chosen dirs from the browser (default off; change: /reload then /webhub restart)",
  ),
  "webHub.spawn.roots": csvString(
    "webHub.spawn.roots",
    "web-hub spawn: extra allowed parent dirs, absolute or ~-prefixed, comma-separated (empty = known dirs only; change: /reload then /webhub restart)",
  ),
  "webHub.spawn.maxProcesses": {
    ...count(
      "webHub.spawn.maxProcesses",
      1,
      "web-hub spawn: global cap on live spawned sessions, 1-16 (change: /reload then /webhub restart)",
    ),
    max: 16,
  } as SettingSpec,
  "webHub.spawn.maxPerPrincipal": {
    ...count(
      "webHub.spawn.maxPerPrincipal",
      1,
      "web-hub spawn: per-user cap on live spawned sessions, 1-16 (change: /reload then /webhub restart)",
    ),
    max: 16,
  } as SettingSpec,
  "webHub.spawn.ratePerMinute": {
    ...count(
      "webHub.spawn.ratePerMinute",
      1,
      "web-hub spawn: per-user spawn rate cap per minute, 1-30 (change: /reload then /webhub restart)",
    ),
    max: 30,
  } as SettingSpec,
  "webHub.spawn.maxLifetimeMinutes": {
    ...count(
      "webHub.spawn.maxLifetimeMinutes",
      10,
      "web-hub spawn: absolute lifetime of a spawned session in minutes, 10-10080 (change: /reload then /webhub restart)",
    ),
    max: 10_080,
  } as SettingSpec,
  "webHub.spawn.registerTimeoutS": {
    ...count(
      "webHub.spawn.registerTimeoutS",
      10,
      "web-hub spawn: seconds from fork to a live session before the run fails, 10-120 (change: /reload then /webhub restart)",
    ),
    max: 120,
  } as SettingSpec,
  "webHub.spawn.lan": choice(
    "webHub.spawn.lan",
    ["off", "known", "roots"],
    "web-hub spawn: LAN-side reachability - off / known dirs only / roots allowed (change: /reload then /webhub restart)",
  ),
  // web-hub-spawn-restore plan D18/RS2: default on, only meaningful under webHub.spawn.enabled.
  "webHub.spawn.restore": bool(
    "webHub.spawn.restore",
    "web-hub spawn: restore browser-spawned sessions after a hub restart/crash (kill old + re-fork with --session; the in-flight turn is lost; default on; change: /reload then /webhub restart)",
  ),
  // web-hub-session-history plan §3.7 (P-cfg): default on, only meaningful under webHub.spawn.enabled.
  "webHub.spawn.history": bool(
    "webHub.spawn.history",
    "web-hub spawn: browse all past sessions and resume/fork them from the web (default on; change: /reload then /webhub restart)",
  ),
  // 2026-10-13 用户拍板（U1 单用户信任模型既判）: default on (现状：LAN 每次 spawn 都要确认)；
  // false 放弃 LAN 渠道的逐次确认门 —— session-open 的 fork 决策不在豁免范围。
  "webHub.spawn.lanConfirm": bool(
    "webHub.spawn.lanConfirm",
    "web-hub spawn: require a per-spawn confirmation for LAN-originated session starts (default on; off = LAN behaves like loopback's known-dir pass-through; change: /reload then /webhub restart)",
  ),
  // web-hub-proxy plan v2 §5 (X0): at most three leaves, all non-live (captured at activate;
  // change: /reload then /webhub restart). LAN reach follows webHub.lan — no proxy LAN switch;
  // TTLs are fixed constants in protocol/proxy.ts. portRange is validated at load time by
  // parseWebHubProxyBlock (an invalid / overlapping / >256-port range falls back to the default
  // with a warning) — the editor itself only requires a non-empty string, like webHub.nodeLoader.
  "webHub.proxy.enabled": bool(
    "webHub.proxy.enabled",
    "web-hub: browser access to local/LAN HTTP services through per-port proxy listeners (default off ⇒ zero wiring/network/disk; LAN reach follows webHub.lan; change: /reload then /webhub restart)",
  ),
  "webHub.proxy.portRange": {
    kind: "string",
    path: "webHub.proxy.portRange",
    description:
      "web-hub proxy: listener port range <lo>-<hi> (default 7900-7949; at most 256 ports within 1024-65535, must not overlap webHub.port / webHub.lan.port; invalid ⇒ default; change: /reload then /webhub restart)",
  },
  "webHub.proxy.maxProxies": {
    ...count(
      "webHub.proxy.maxProxies",
      1,
      "web-hub proxy: cap on concurrent proxies, 1-16 (default 8; change: /reload then /webhub restart)",
    ),
    max: 16,
  } as SettingSpec,
};

export const FEISHU_BOT_SETTING_SPECS: Record<string, SettingSpec> = {
  // feishu-bot plan v2 §9 (F9, entries suggested by F0): the TUI-editable `feishuBot.*` leaves.
  // All non-live — every description says "change: /reload then /webhub restart".
  // `feishuBot.staleMessageS` keeps its plan name and is deliberately NOT a `time:true` spec —
  // F0 did not register it in TIME_SETTING_MS_PATHS (the live field holds seconds, no ms
  // conversion, the settings file is never rewritten), so stored domain = live domain.
  // `feishuBot.debounceMs` is JSON-ONLY (externalAgents.droid.* pattern): the shared spec-table
  // invariant (tests/ui/settings-editor.test.ts: no exposed key ends in "Ms") means a
  // milliseconds storage key cannot enter the editor without an out-of-domain test change —
  // edit it directly in pi-toolkit.json (legacy name: pi-subagent.json). See docs/dev/feishu-bot/F9-report.md.
  "feishuBot.securityAlerts": bool(
    "feishuBot.securityAlerts",
    "Feishu bot: high-risk LAN security alerts (default on; change: /reload then /webhub restart)",
  ),
  "feishuBot.xsMirror": bool(
    "feishuBot.xsMirror",
    "Feishu bot: mirror cross-session messages that did not wake the session to bound p2p chats (default on; change: /reload then /webhub restart)",
  ),
  "feishuBot.enabled": bool(
    "feishuBot.enabled",
    "Feishu bot: enable the hub-side bot (change: /reload then /webhub restart)",
  ),
  "feishuBot.allowGroups": bool(
    "feishuBot.allowGroups",
    "Feishu bot: answer @-mentions inside group topics (change: /reload then /webhub restart)",
  ),
  "feishuBot.groupRootTopics": bool(
    "feishuBot.groupRootTopics",
    "Feishu bot: bind plain group @-messages by auto-creating a topic (change: /reload then /webhub restart)",
  ),
  "feishuBot.notify": choice(
    "feishuBot.notify",
    ["bound", "off"],
    "Feishu bot: proactive done/failed/waiting notices for bound sessions (change: /reload then /webhub restart)",
  ),
  "feishuBot.spawnScope": choice(
    "feishuBot.spawnScope",
    ["known", "roots"],
    "Feishu bot: directories /new may spawn sessions in (change: /reload then /webhub restart)",
  ),
  "feishuBot.staleMessageS": {
    ...count(
      "feishuBot.staleMessageS",
      30,
      "Feishu bot: messages older than this many seconds are not executed, 30-3600 (change: /reload then /webhub restart)",
    ),
    max: 3_600,
  } as SettingSpec,
  "feishuBot.files.outbound": choice(
    "feishuBot.files.outbound",
    ["auto", "buttons", "off"],
    "Feishu bot: sending reply files - auto images in p2p, gated buttons, or off (change: /reload then /webhub restart)",
  ),
  "feishuBot.files.inbound": bool(
    "feishuBot.files.inbound",
    "Feishu bot: accept image/file attachments from chats (change: /reload then /webhub restart)",
  ),
  "feishuBot.files.maxInboundMiB": {
    ...count(
      "feishuBot.files.maxInboundMiB",
      1,
      "Feishu bot: max inbound file size in MiB, 1-100 (change: /reload then /webhub restart)",
    ),
    max: 100,
  } as SettingSpec,
};
