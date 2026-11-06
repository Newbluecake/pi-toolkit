/**
 * Settings profiles for the activation-trace golden (docs/dev/source-governance/batch2-plan.md §3.1).
 * Test-only. Each profile is the raw `pi-subagent.json` content written into a throwaway $HOME.
 *
 * `max` turns on every switch that can run offline: fabric + wake + xs (reply / channels / alias),
 * compact (switchTool + keepCompactTool), bashJobs, extend, workflow, load, quota, cacheTtl keepalive,
 * schedule, topicSwitch, reflex, askUser, todo (nudge), memory, webSearch, title, hud, sessionNav and
 * `webHub.enabled` with `autoStart:false`. Left out on purpose: feishuNotify / feishuBot / traffic /
 * externalAgents.droid (need credentials, a database or a droid binary; secure-domain D8 forces several of
 * them off anyway). tests/setup/sandbox-home.ts turns any real socket / child-process attempt into a test failure.
 */
import { BASELINE } from "../integration/helpers/schedule-activate.js";

export type ProfileName =
  "fast-disabled" | "default" | "minimal" | "max" | "child" | "compat-failure" | "thread-main" | "thread-child";

/**
 * Pinned `quota.providers` for the phase-2 profiles (see the header note). The trace HOME carries no `auth.json`,
 * so every whitelisted static provider without a key emits one `[quota] no usable credential` warning per
 * `session_start`; that count is part of the golden's `ui.notify(warning)` run. Provider defaults therefore must
 * not leak into this contract — a new default-enabled provider (`3fbdb017` added `opencode-go`) would otherwise
 * force a golden refresh for something this test does not own. Provider defaults are pinned by
 * `tests/quota/` + `tests/config/quota-settings.test.ts`; keep this list in sync with the recorded warning count.
 */
const QUOTA_PIN = { providers: "zai-coding-cn,zai,kimi-coding,droid" } as const;

export const PROFILES: Record<
  ProfileName,
  { settings: unknown; child?: true; omit?: readonly string[]; phase2: boolean }
> = {
  default: { settings: { quota: { ...QUOTA_PIN } }, phase2: true },
  // Fast default-enabled is intentional only in the default profile. Historical profiles
  // explicitly disable this new feature to retain their original registration/phase2 bytes.
  "fast-disabled": { settings: { quota: { ...QUOTA_PIN }, fast: { enabled: false } }, phase2: true },
  minimal: { settings: { ...BASELINE, fast: { enabled: false }, quota: { ...QUOTA_PIN } }, phase2: true },
  max: {
    settings: {
      fast: { enabled: false },
      fabric: {
        enabled: true,
        wake: { enabled: true },
        crossSession: {
          enabled: true,
          autoJoin: true,
          reply: { enabled: true },
          channels: { enabled: true },
          alias: { enabled: true },
        },
      },
      compact: { enabled: true, switchTool: true, keepCompactTool: true },
      bashJobs: { enabled: true },
      extend: { enabled: true },
      workflow: { enabled: true },
      load: { enabled: true },
      quota: { enabled: true, ...QUOTA_PIN },
      cacheTtl: { keepalive: true },
      schedule: { enabled: true },
      topicSwitch: { enabled: true },
      askUser: { enabled: true },
      todo: { enabled: true, nudge: { enabled: true } },
      memory: { enabled: true },
      webSearch: { enabled: true },
      title: { enabled: true },
      hud: { enabled: true },
      sessionNav: { enabled: true },
      feishuNotify: { enabled: false },
      webHub: { enabled: true, autoStart: false },
      reflex: { enabled: true },
    },
    phase2: true,
  },
  child: { settings: { ...BASELINE, fast: { enabled: false } }, child: true, phase2: false },
  "compat-failure": { settings: { ...BASELINE, fast: { enabled: false } }, omit: ["appendEntry"], phase2: false },
  // fabric-thread arch §9.3 (P0): the two thread profiles. `thread-main` turns on every switch
  // `max` can run offline PLUS fabric.threads (still inert in P0 — the main-session `thread` tool
  // and the hello cap arrive in P3, so today's trace must be IDENTICAL to `max`'s; when P3 wires
  // the tool the thread-main entry is refreshed once more, with the post-guard order assertion
  // — `thread` right after `message_channel` / the fabric tool group). `thread-child` is the same
  // settings on a child session (child:true keeps the host-claim guard active): child-session
  // activation must gain NO new registration (the child `thread` tool rides customTools
  // injection, never registerTool — §9.2), so its trace must stay identical to `child`'s.
  "thread-main": {
    settings: {
      fast: { enabled: false },
      fabric: {
        enabled: true,
        wake: { enabled: true },
        crossSession: {
          enabled: true,
          autoJoin: true,
          reply: { enabled: true },
          channels: { enabled: true },
          alias: { enabled: true },
        },
        threads: { enabled: true },
      },
      compact: { enabled: true, switchTool: true, keepCompactTool: true },
      bashJobs: { enabled: true },
      extend: { enabled: true },
      workflow: { enabled: true },
      load: { enabled: true },
      quota: { enabled: true, ...QUOTA_PIN },
      cacheTtl: { keepalive: true },
      schedule: { enabled: true },
      topicSwitch: { enabled: true },
      askUser: { enabled: true },
      todo: { enabled: true, nudge: { enabled: true } },
      memory: { enabled: true },
      webSearch: { enabled: true },
      title: { enabled: true },
      hud: { enabled: true },
      sessionNav: { enabled: true },
      feishuNotify: { enabled: false },
      webHub: { enabled: true, autoStart: false },
    },
    phase2: true,
  },
  "thread-child": {
    settings: {
      fast: { enabled: false },
      fabric: {
        enabled: true,
        wake: { enabled: true },
        crossSession: {
          enabled: true,
          autoJoin: true,
          reply: { enabled: true },
          channels: { enabled: true },
          alias: { enabled: true },
        },
        threads: { enabled: true },
      },
      compact: { enabled: true, switchTool: true, keepCompactTool: true },
      bashJobs: { enabled: true },
      extend: { enabled: true },
      workflow: { enabled: true },
      load: { enabled: true },
      quota: { enabled: true, ...QUOTA_PIN },
      cacheTtl: { keepalive: true },
      schedule: { enabled: true },
      topicSwitch: { enabled: true },
      askUser: { enabled: true },
      todo: { enabled: true, nudge: { enabled: true } },
      memory: { enabled: true },
      webSearch: { enabled: true },
      title: { enabled: true },
      hud: { enabled: true },
      sessionNav: { enabled: true },
      feishuNotify: { enabled: false },
      webHub: { enabled: true, autoStart: false },
    },
    child: true,
    phase2: false,
  },
};
