import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  availableModelsFromRegistry,
  formatAvailableModelsForPrompt,
  readScopedModels,
  type AvailableModelEntry,
  type ModelRegistryLike,
  type ScopedModelLike,
} from "../config/available-models.js";
import type { AgentTypeConfig } from "../core/types.js";
import { formatAgentTypesForPrompt } from "../config/agent-types.js";
import type { SectionProviderInput, SectionRegistration } from "./hub.js";

export const AGENT_TYPES_TITLE = "## Available subagent types (pi-subagent)";
export const AVAILABLE_MODELS_TITLE = "## Available models (pi-subagent)";

export function agentTypesSection(deps: {
  types: { list(): readonly AgentTypeConfig[] };
  foregroundAutoBackgroundMs: number;
}): SectionRegistration {
  return {
    provider: () =>
      formatAgentTypesForPrompt(deps.types.list(), {
        foregroundAutoBackgroundMs: deps.foregroundAutoBackgroundMs,
      }),
    title: AGENT_TYPES_TITLE,
    pointerHint: "The Agent tool rejects an unknown subagent_type with the current list of valid types.",
  };
}

function promptModels(
  input: SectionProviderInput,
  stackAvailable: () => readonly AvailableModelEntry[] | undefined,
): string {
  let scoped: readonly ScopedModelLike[] | undefined;
  try {
    scoped = input.ctx.scopedModels as unknown as readonly ScopedModelLike[];
  } catch {
    scoped = undefined;
  }
  const scopedEntries = readScopedModels(scoped);
  if (scopedEntries.length > 0) return formatAvailableModelsForPrompt(scopedEntries);
  const stack = stackAvailable();
  return formatAvailableModelsForPrompt(
    stack ?? availableModelsFromRegistry(input.ctx.modelRegistry as ModelRegistryLike),
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
