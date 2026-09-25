import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatAvailableModelsForPrompt,
  resolvePromptModels,
  type AvailableModelEntry,
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

function promptModels(
  input: SectionProviderInput,
  stackAvailable: () => readonly AvailableModelEntry[] | undefined,
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
  );
}

export function availableModelsSection(deps: {
  stackAvailable: () => readonly AvailableModelEntry[] | undefined;
}): SectionRegistration {
  return {
    provider: (input) => promptModels(input, deps.stackAvailable),
    title: AVAILABLE_MODELS_TITLE,
  };
}
