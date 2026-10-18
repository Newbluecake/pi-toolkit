// Scratch pi extension (README screenshot): renders the REAL fleet widget builder with fake run snapshots.
import { buildFleetViewModel } from "../../../../src/ui/fleet-panel.js";
import { buildFleetWidgetLines } from "../../../../src/ui/fleet-widget.js";

const NOW = 1_800_000_000_000;
const diag = (o: any) => ({
  phaseEnteredAt: NOW - 8000,
  pendingTools: 0,
  turns: 3,
  escalation: [],
  orphaned: false,
  generation: 1,
  degraded: [],
  staleInputs: 0,
  unkillable: [],
  lastEventAt: NOW - 1500,
  ...o,
});
const snap = (runId: string, status: string, phase: string, parentRunId: string | undefined, d: any) => ({
  runId,
  generation: 1,
  status,
  phase,
  parentRunId,
  deadlines: { enqueuedAt: NOW - 400000, deadlineAt: NOW + 1_500_000 },
  updatedAt: NOW - 20000,
  diag: diag(d),
});
const tools = (names: string[]) =>
  names.map((name, i) => ({
    name,
    toolCallId: `t${i}`,
    startedAt: NOW - 60000 + i * 4000,
    endedAt: NOW - 58000 + i * 4000,
  }));
const snaps: any[] = [
  snap("r_8Kd2QnVx", "running", "model_turn", undefined, {
    createdAt: NOW - 188000,
    label: "order-tests",
    agentType: "dev",
    model: { provider: "cr-kimi", id: "k3-256k" },
    thinkingLevel: "medium",
    taskPrompt: "Add unit tests for the split order functions",
    phaseEnteredAt: NOW - 21000,
    usage: { input: 91000, output: 5200, cacheRead: 84000, cacheWrite: 0, costUsd: 0.54 },
    toolHistory: tools(["read", "grep", "edit", "bash", "edit", "bash"]),
    thinkingText: "Adding edge cases for priceCart: empty cart, stacked discounts",
  }),
  snap("r_3WmT7pLs", "running", "model_turn", undefined, {
    createdAt: NOW - 96000,
    label: "verify-checkout",
    agentType: "verifier",
    model: { provider: "cr-openai", id: "gpt-5.6-sol" },
    thinkingLevel: "high",
    taskPrompt: "Regression-check the checkout flow",
    phaseEnteredAt: NOW - 14000,
    usage: { input: 52000, output: 3100, cacheRead: 40000, cacheWrite: 0, costUsd: 0.47 },
    toolHistory: tools(["read", "bash"]),
    thinkingText: "Walking the acceptance checklist for the checkout flow…",
  }),
  snap("r_5NcA9yQe", "running", "tool_exec", undefined, {
    createdAt: NOW - 64000,
    label: "docs-sweep",
    agentType: "explorer",
    model: { provider: "cr-kimi", id: "k3-256k" },
    taskPrompt: "Find stale payment docs",
    phaseEnteredAt: NOW - 3000,
    usage: { input: 22000, output: 900, cacheRead: 18000, cacheWrite: 0, costUsd: 0.12 },
    currentTool: { name: "grep", toolCallId: "tg", startedAt: NOW - 3000 },
    toolHistory: tools(["grep", "read", "read"]),
  }),
  snap("r_2ConSuLt", "completed", "settled", "r_8Kd2QnVx", {
    createdAt: NOW - 70000,
    settledAt: NOW - 2500,
    label: "ask-arch",
    agentType: "consult",
    model: { provider: "cr-anthropic", id: "claude-opus-5" },
    usage: { input: 30000, output: 800, cacheRead: 29000, cacheWrite: 0, costUsd: 0.09 },
    consultOf: { askerRunId: "r_8Kd2QnVx" },
    consultCache: {
      v: 1,
      predicted: { state: "warm" },
      first: { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: NOW - 60000 },
    },
    consultThread: { threadId: "c7k9q2mx", seq: 2 },
  }),
];
snaps[3].updatedAt = NOW - 2500;

export default function (pi: any) {
  pi.on("session_start", (_e: any, ctx: any) => {
    const th = ctx.ui.theme;
    for (const ms of [1500, 4000]) setTimeout(() => ctx.ui.setStatus("feishu-notify", undefined), ms).unref?.();
    const color = (tone: string, text: string) =>
      (
        ({
          warn: () => th.fg("warning", text),
          crit: () => th.fg("error", text),
          muted: () => th.fg("muted", text),
          success: () => th.fg("success", text),
          header: () => th.fg("accent", text),
        }) as any
      )[tone]?.() ?? text;
    const vm = buildFleetViewModel(snaps, {
      now: NOW,
      typeOf: (id: string) => snaps.find((s) => s.runId === id)?.diag.agentType,
    });
    const lines = buildFleetWidgetLines(vm, { color: color as any, width: 150, frame: 3, terminalLingerMs: 600_000 });
    if (lines) ctx.ui.setWidget("demo-fleet", lines, { placement: "aboveEditor" });
  });
}
