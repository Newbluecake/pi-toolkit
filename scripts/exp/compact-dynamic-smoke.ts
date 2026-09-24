import { createCompactHintHook, type CompactHintState, type Stack } from "../../src/stack.js";
import { wireDynamicThreshold } from "../../src/compact-hint/dynamic/wire.js";
import { DEFAULT_DYNAMIC_THRESHOLD_SETTINGS } from "../../src/config/settings.js";
import { readTelemetryLines } from "../../src/compact-hint/dynamic/telemetry-store.js";

const tmp = process.env.TMPDIR ?? "/tmp";
const telemetryPath = `${tmp}/compact-dynamic-smoke-${Date.now()}.jsonl`;
const entries: { type: string; customType: string; data: unknown }[] = [];

const runtime = wireDynamicThreshold({
  ctx: { mode: "interactive" },
  config: { ...DEFAULT_DYNAMIC_THRESHOLD_SETTINGS },
  sessionId: "smoke",
  telemetryFilePath: telemetryPath,
  now: (() => {
    let t = 0;
    return () => (t += 1000);
  })(),
  appendEntry: (type, data) => entries.push({ type, customType: type, data }),
  readBranch: () => entries,
  quota: { enabled: false, isSubscription: () => false, verdictFor: () => undefined },
});

const state: CompactHintState = {
  thresholdPercent: 75,
  forceAtPercent: 88,
  forceScaling: true,
  thresholdTokens: 500, // 500k 绝对线（默认）
  forceAtTokens: 0,
  reserveTokens: 16384,
  lastHintAt: 0,
  hintedAt: undefined,
  tickStepPercent: 10,
  lastTickStep: 0,
  switchTool: false,
  forceDemandTurns: 1,
  demandCount: 0,
  dynamic: runtime,
};
const opus = {
  provider: "anthropic",
  id: "opus-5.5",
  api: "anthropic-messages",
  baseUrl: "https://api.example.com",
  contextWindow: 1_000_000,
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const sent: { customType: string; content: string; details: unknown }[] = [];
const hook = createCompactHintHook(
  { current: { compactHint: state } as Stack },
  { sendMessage: (m) => sent.push(m as never), now: () => 1 },
);
const mkCtx = (percent: number) =>
  ({
    mode: "interactive",
    hasUI: false,
    model: opus,
    getContextUsage: () => ({
      percent,
      contextWindow: 1_000_000,
      tokens: Math.round((percent / 100) * 1_000_000),
    }),
    ui: { notify: () => undefined },
  }) as never;

for (const pct of [30, 36, 38, 40, 41, 42, 45, 50, 60, 74, 76]) hook({}, mkCtx(pct));
console.log(
  JSON.stringify(
    sent.map((m) => ({ t: m.customType, d: m.details, c: m.content.slice(0, 90) })),
    null,
    1,
  ),
);
const view = runtime.statusView();
console.log("status:", JSON.stringify(view, null, 1));
// 遥测：模拟一次 compact
runtime.noteHandoffApplied({ seq: 7, chars: 6000, keepRecent: true, reason: "manual" });
runtime.onSessionCompact(
  { compactionEntry: { fromHook: true, tokensBefore: 500_000, usage: { cost: { total: 0.01 } } }, reason: "manual" },
  { mode: "interactive", model: opus, sessionManager: { getBranch: () => [] } },
);
console.log("telemetry lines:", JSON.stringify(readTelemetryLines(telemetryPath), null, 1).slice(0, 1200));
runtime.dispose({ sessionManager: { getBranch: () => [] } });
console.log("persisted entries:", JSON.stringify(entries, null, 1).slice(0, 600));
console.log("view after dispose:", runtime.statusView());
