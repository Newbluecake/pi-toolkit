import { Type } from "@sinclair/typebox";
import { validateVerdictV1Semantics } from "../core/verdict-schema.js";
import type { SchemaPresetId } from "../core/verdict-schema.js";
import type { JsonSchema, ValidationResult } from "../core/json-schema.js";

/** Host-only submission status; never part of the model-supplied payload schema. */
export interface StructuredOutputSubmissionResult extends ValidationResult {
  code?: "window_closed";
}

/**
 * X10: the tool injected into a subagent session (via SessionSpec.customTools,
 * see service/runtime-adapter.ts) when the caller supplied a `schema`. This
 * is the *first* of the two mandatory validations (architecture §7.2 X10
 * "双重校验"): `onSubmit` runs the same core/json-schema.ts validator the
 * host re-runs independently afterward. A rejected submission never touches
 * the captured value — payload errors can be corrected while the window is
 * open; a closed window instead tells the model to stop submitting.
 */
export function createStructuredOutputTool(deps: {
  schema: JsonSchema;
  schemaPreset?: SchemaPresetId;
  /** Synchronous host gate, before local validation. Does not replace onSubmit's final check. */
  preflight?: () => StructuredOutputSubmissionResult;
  onSubmit: (value: unknown) => StructuredOutputSubmissionResult;
}) {
  // Defensive: every entry point should have normalized already (see
  // core/json-schema.ts#normalizeSchemaInput). Fail here with a readable
  // message rather than letting pi's typebox throw an opaque
  // "Object.defineProperty called on non-object" from Type.Unsafe.
  const schema: unknown = deps.schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(
      `StructuredOutput: schema must be a JSON Schema object, got ${Array.isArray(schema) ? "array" : schema === null ? "null" : typeof schema}`,
    );
  }
  return {
    name: "StructuredOutput",
    label: "Structured Output",
    description:
      "Submit the final structured result for this task. The payload must conform to the JSON Schema the caller " +
      "requested. Call this exactly once, when you have the complete result — if the payload is rejected, fix the " +
      "concrete validation errors and resubmit. If the result window is closed (window_closed), stop submitting; " +
      "changing the payload cannot reopen it. The host independently re-validates the payload " +
      "against the same schema before the run is considered completed; a submission that only looks accepted here " +
      "is not sufficient on its own.",
    promptSnippet: "StructuredOutput(<schema-shaped payload>) - submit the final structured result",
    parameters: Type.Unsafe<unknown>(deps.schema),
    async execute(_toolCallId: string, params: unknown) {
      // This only governs calls that reach execute: SDK schema rejection happens
      // earlier and is deliberately unchanged. No await between gate and validation.
      const preflight = deps.preflight?.();
      const semantic =
        preflight?.ok === false
          ? preflight
          : deps.schemaPreset === "verdict/v1"
            ? validateVerdictV1Semantics(params)
            : { ok: true, errors: [] };
      const result: StructuredOutputSubmissionResult = semantic.ok ? deps.onSubmit(params) : semantic;
      if (!result.ok) {
        const closed = result.code === "window_closed";
        return {
          content: [
            {
              type: "text" as const,
              text: closed
                ? `Structured output rejected (window_closed): ${result.errors.join("; ")}. Stop submitting StructuredOutput for this run; changing the payload cannot reopen the result window.`
                : `Structured output rejected: ${result.errors.join("; ")}. Fix the payload and call StructuredOutput again.`,
            },
          ],
          details: { ok: false, errors: result.errors, ...(closed ? { code: "window_closed" as const } : {}) },
        };
      }
      return {
        content: [{ type: "text" as const, text: "Structured output accepted." }],
        details: { ok: true },
      };
    },
  };
}
