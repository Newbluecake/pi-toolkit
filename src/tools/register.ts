import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { systemClock } from "../core/clock.js";
import type { PiCapabilities } from "../adapters/pi-compat.js";
import type { AgentSettings } from "../config/settings.js";
import {
  forwardQuery,
  forwardResolveRun,
  forwardSpawn,
  forwardWorkflowQuery,
  forwardNotifier,
  requireStack,
  type StackHolder,
} from "../holder.js";
import { createAgentTool } from "./agent-tool.js";
import { createResultTool, legacyResultToolRenderer } from "./result-tool.js";
import { createListSubagentsTool } from "./list-subagents-tool.js";
import { createSteerTool } from "./steer-tool.js";
import { createSetModelTool } from "./set-model-tool.js";
import { createAbortTool } from "./abort-tool.js";
import { createExtendTimeoutTool } from "./extend-timeout-tool.js";

export interface SubagentToolsDeps {
  holder: StackHolder;
  /** Passed by reference: budget etc. are mutated in place by `/agent settings`, never copy. */
  settings: AgentSettings;
  /** Only `canSetModel` is read. */
  caps: Pick<PiCapabilities, "canSetModel">;
  isReloadPending: () => boolean;
}

/**
 * The seven core subagent tools (+ the legacy get_run_result renderer), moved verbatim out of `activate()`
 * (#56 batch 2 step 5-2). Registration order is a contract: Agent → get_run_result → legacy renderer →
 * list_subagents → steer_subagent → set_model → abort_subagent → (extend.enabled) extend_subagent_timeout.
 */
export function registerSubagentTools(pi: ExtensionAPI, deps: SubagentToolsDeps): void {
  const { holder, settings, caps, isReloadPending } = deps;
  // Markdown body rendering for the Agent / get_run_result cards.
  // getMarkdownTheme() reads pi's global theme, which throws before the
  // interactive theme subsystem is initialized (headless/print mode, tests)
  // — the tools fall back to their legacy plain-text cards in that case.
  const resolveMarkdownTheme = () => {
    try {
      return getMarkdownTheme();
    } catch {
      return undefined;
    }
  };
  pi.registerTool(
    createAgentTool({
      // Top-level Agent always runs in the background (docs/dev/agent-background-only):
      // only spawn() is reached; the outcome arrives through the notification outbox.
      spawn: forwardSpawn(holder),
      isReloadPending,
      markdownTheme: resolveMarkdownTheme,
      // L1 (agent-tool pool-full plan §2): read fresh on every call so a
      // live `/agent settings` edit (or /reload) takes effect immediately,
      // same convention as worktreeAvailable above.
      queueWhenFull: () => settings.agent.queueWhenFull,
      loadGate: () => holder.current?.load?.port().verdict().gating === true,
    }),
  );
  const resultTool = createResultTool({
    query: forwardQuery(holder),
    resolveRun: forwardResolveRun(holder),
    notifier: forwardNotifier(holder),
    resultMaxChars: () => settings.resultMaxChars,
    markdownTheme: resolveMarkdownTheme,
    workflows: forwardWorkflowQuery(holder),
    wake: { inboxCount: (runId) => holder.current?.wake?.inboxCount(runId) ?? 0 },
  });
  pi.registerTool(resultTool);
  // Resumed transcripts still carry calls under the pre-rename name: draw them with the same cards
  // (pi ≥ 1.0.1; absent on older pi / stub hosts, where history simply falls back to the generic card).
  if (typeof pi.registerToolRenderer === "function") pi.registerToolRenderer(legacyResultToolRenderer(resultTool));
  pi.registerTool(
    createListSubagentsTool({
      query: forwardQuery(holder),
      spawn: { slots: () => requireStack(holder).spawn.slots() },
      workflow: { activity: { list: () => requireStack(holder).workflow.activity.list() } },
      now: () => systemClock.now(),
    }),
  );
  // steer reply (steer-tool reply param): same fabric signal as the @mention
  // wiring below (`holder.current?.fabric != null`) — read live at call time
  // so a /reload or settings change takes effect without re-registration.
  pi.registerTool(
    createSteerTool({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      fabricEnabled: () => holder.current?.fabric != null,
    }),
  );
  // set_model host form (plan §4.11): self-switch goes through the ExtensionAPI
  // (only available when the pi build exposes it — otherwise `host` stays
  // absent and self-switching degrades to a clear error while switching a
  // running subagent keeps working). All stack reads go through the holder at
  // call time so the tool survives session_start rebuilds.
  pi.registerTool(
    createSetModelTool({
      ...(caps.canSetModel
        ? {
            host: {
              setModel: (model) => pi.setModel(model as never),
              getThinkingLevel: () => pi.getThinkingLevel(),
              setThinkingLevel: (level) => pi.setThinkingLevel(level as never),
              findModel: (p, id) => holder.current?.models.find(p, id),
            },
          }
        : {}),
      runs: { setModel: (runId, model, opts) => requireStack(holder).query.setModel(runId, model, opts) },
      resolveHint: (hint) => holder.current?.models.resolveHint(hint),
      available: () => holder.current?.models.available() ?? [],
      // external-agent plan §5.4/§5.5（P5）：仅 externalAgents.droid.enabled 时注入（settings
      // 在 activate() 快照；enabled ⇒ 每个 session stack 都带端口）。谓词经 holder 晚绑定，
      // /reload 后新栈缺席即自动失效；缺席 ⇒ droid/x 走原未知模型路径（字节一致，评审 #7）。
      ...(settings.externalAgents.droid.enabled
        ? { externalOwns: (p: string) => holder.current?.external?.owns(p) === true }
        : {}),
      resolveRun: forwardResolveRun(holder),
      labelOf: (runId) => holder.current?.query.get(runId)?.diag.label,
    }),
  );
  pi.registerTool(
    createAbortTool({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      workflows: forwardWorkflowQuery(holder),
    }),
  );
  // timeout-notify：extend.enabled=false 时工具不注册（spawn 侧同步钳 maxExtensions=0，D-16）。
  if (settings.extend.enabled) {
    pi.registerTool(
      createExtendTimeoutTool({
        query: forwardQuery(holder),
        resolveRun: forwardResolveRun(holder),
        workflows: forwardWorkflowQuery(holder),
        now: () => systemClock.now(),
      }),
    );
  }
}
