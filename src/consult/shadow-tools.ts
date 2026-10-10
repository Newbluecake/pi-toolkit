import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolDeclaration } from "../core/types.js";

/** The adapter-owned tools whose implementations must never cross into C2. */
export const CONSULT_ADAPTER_TOOL_NAMES = [
  "set_model",
  "message_agent",
  "Agent",
  "consult",
  "StructuredOutput",
] as const;

export type ConsultAdapterToolName = (typeof CONSULT_ADAPTER_TOOL_NAMES)[number];

export function isConsultAdapterToolName(name: string): name is ConsultAdapterToolName {
  return (CONSULT_ADAPTER_TOOL_NAMES as readonly string[]).includes(name);
}

export type ShadowPromptSource = Pick<ToolDefinition, "label" | "promptSnippet" | "promptGuidelines">;

/**
 * Rebuild an adapter-owned declaration without retaining its implementation.
 * The declaration fields are copied from the expert transcript; presentation
 * fields come from the same adapter factory that normally creates the tool.
 */
export function createConsultShadowTool(declaration: ToolDeclaration, source?: ShadowPromptSource): ToolDefinition {
  const name = declaration.name;
  if (typeof name !== "string") throw new Error("consult shadow tool declaration has no name");
  const shadow: ToolDefinition = {
    name,
    label: source?.label ?? name,
    description: declaration.description as string,
    parameters: declaration.parameters as ToolDefinition["parameters"],
    ...(Object.prototype.hasOwnProperty.call(declaration, "constrainedSampling")
      ? {
          constrainedSampling: declaration.constrainedSampling as Exclude<
            ToolDefinition["constrainedSampling"],
            undefined
          >,
        }
      : {}),
    ...(source?.promptSnippet === undefined ? {} : { promptSnippet: source.promptSnippet }),
    ...(source?.promptGuidelines === undefined ? {} : { promptGuidelines: [...source.promptGuidelines] }),
    async execute() {
      return {
        content: [{ type: "text", text: `Tool "${name}" is disabled in this read-only consult.` }],
        details: {},
        isError: true,
      };
    },
  };
  return Object.freeze(shadow);
}

/** Return only adapter-owned declarations, retaining the expert's declaration order. */
export function consultAdapterDeclarations(snapshotTools: readonly ToolDeclaration[]): ToolDeclaration[] {
  return snapshotTools.filter((declaration) => {
    const name = declaration.name;
    return typeof name === "string" && isConsultAdapterToolName(name);
  });
}
