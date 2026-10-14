import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatAvailableModelsForPrompt,
  resolvePromptModels,
  type AvailableModelEntry,
  type ExternalPromptModels,
  type ModelRegistryLike,
  type ScopedModelLike,
} from "../config/available-models.js";
import type { AgentTypeConfig } from "../core/types.js";
import { formatAgentTypesForPrompt } from "../config/agent-types.js";
import type { SectionProviderInput, SectionRegistration } from "./hub.js";

export const AGENT_TYPES_TITLE = "## Available subagent types (pi-subagent)";
export const AVAILABLE_MODELS_TITLE = "## Available models (pi-subagent)";

export function agentTypesSection(deps: { types: { list(): readonly AgentTypeConfig[] } }): SectionRegistration {
  return {
    provider: () => formatAgentTypesForPrompt(deps.types.list()),
    title: AGENT_TYPES_TITLE,
    pointerHint: "The Agent tool rejects an unknown subagent_type with the current list of valid types.",
  };
}

/** external-agent plan §5.3：P5 注入的外部模型端口。缺席/抛错/非数组都降级为
 *  「无 external 子块」——提示词路径绝不因 P5 接线问题而崩。 */
function safeExternalModels(
  externalModels: (() => readonly ExternalPromptModels[] | undefined) | undefined,
): readonly ExternalPromptModels[] | undefined {
  if (typeof externalModels !== "function") return undefined;
  try {
    const value = externalModels();
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function promptModels(
  input: SectionProviderInput,
  stackAvailable: () => readonly AvailableModelEntry[] | undefined,
  externalModels?: () => readonly ExternalPromptModels[] | undefined,
): string {
  // `ctx.scopedModels` is a live ExtensionContext getter (plan.md §4.6:
  // "ctx.scopedModels 抛错视为空") — the try/catch has to sit here, at the
  // property access, not inside resolvePromptModels (by the time a value
  // reaches that pure function, a throw already happened).
  let scoped: readonly ScopedModelLike[] | undefined;
  try {
    scoped = input.ctx.scopedModels as unknown as readonly ScopedModelLike[];
  } catch {
    scoped = undefined;
  }
  return formatAvailableModelsForPrompt(
    resolvePromptModels(scoped, stackAvailable(), input.ctx.modelRegistry as ModelRegistryLike),
    safeExternalModels(externalModels),
  );
}

export function availableModelsSection(deps: {
  stackAvailable: () => readonly AvailableModelEntry[] | undefined;
  /** external-agent plan §5.3（P5 装配）：外部 provider（droid）的展示子块；
   *  缺席（现状，字节不变）或返回 undefined/[] ⇒ 纯 pi 输出。 */
  externalModels?: () => readonly ExternalPromptModels[] | undefined;
}): SectionRegistration {
  return {
    provider: (input) => promptModels(input, deps.stackAvailable, deps.externalModels),
    title: AVAILABLE_MODELS_TITLE,
  };
}
