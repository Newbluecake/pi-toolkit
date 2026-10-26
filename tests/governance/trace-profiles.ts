/**
 * Settings profiles for the activation-trace golden (docs/dev/source-governance/batch2-plan.md §3.1).
 * Test-only. Each profile is the raw `pi-subagent.json` content written into a throwaway $HOME.
 *
 * `max` turns on every switch that can run offline: fabric + wake + xs (reply / channels / alias),
 * compact (switchTool + keepCompactTool), bashJobs, extend, workflow, load, quota, cacheTtl keepalive,
 * schedule, topicSwitch, askUser, todo (nudge), memory, webSearch, title, hud, sessionNav and
 * `webHub.enabled` with `autoStart:false`. Left out on purpose: feishuNotify / feishuBot / traffic /
 * externalAgents.droid (need credentials, a database or a droid binary; secure-domain D8 forces several of
 * them off anyway). tests/setup/sandbox-home.ts turns any real socket / child-process attempt into a test failure.
 */
import { BASELINE } from "../integration/helpers/schedule-activate.js";

export type ProfileName = "default" | "minimal" | "max" | "child" | "compat-failure";

export const PROFILES: Record<
  ProfileName,
  { settings: unknown; child?: true; omit?: readonly string[]; phase2: boolean }
> = {
  default: { settings: {}, phase2: true },
  minimal: { settings: BASELINE, phase2: true },
  max: {
    settings: {
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
      quota: { enabled: true },
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
  child: { settings: BASELINE, child: true, phase2: false },
  "compat-failure": { settings: BASELINE, omit: ["appendEntry"], phase2: false },
};
