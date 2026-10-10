/**
 * consult A/B instrumentation plan (docs/dev/consult/ab-instrumentation-plan.md
 * §4/§5 P1a): the `"verdict/v1"` structured-output schema preset for
 * verifier/reviewer acceptance conclusions, plus host-side rendering of a
 * captured structured result. Defined exactly once here. Pi-free.
 *
 * All strings inside the schema (enum values, `description`) are English
 * only: the schema is injected into the subagent's StructuredOutput tool
 * parameters (model-visible) and is scanned by
 * `tests/tools/model-facing-strings.test.ts`'s `collectDescriptions`. The
 * Chinese cross-reference (pass=通过、conditional_pass=有条件通过、reject=打回)
 * lives in `skills/dev-flow/references/consult-ab.md` (P4), never here.
 */
import { validateAgainstSchema } from "./json-schema.js";
import type { JsonSchema } from "./types.js";

export type SchemaPresetId = "verdict/v1";

export const VERDICT_SCHEMA_V1: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "blockers", "findings", "report"],
  properties: {
    verdict: {
      enum: ["pass", "conditional_pass", "reject"],
      description: "pass = accepted · conditional_pass = accepted with listed follow-ups · reject = sent back",
    },
    blockers: { type: "integer", minimum: 0, description: "Number of findings that block acceptance." },
    findings: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary"],
        properties: {
          severity: { enum: ["blocker", "major", "minor", "nit"] },
          summary: { type: "string", minLength: 1, maxLength: 300 },
          location: { type: "string", maxLength: 200 },
        },
      },
    },
    packageId: { type: "string", maxLength: 64 },
    report: {
      type: "string",
      minLength: 1,
      maxLength: 60000,
      description: "Your full report in your usual output format (matrix, commands, findings).",
    },
  },
};

export const SCHEMA_PRESETS: Readonly<Record<SchemaPresetId, JsonSchema>> = {
  "verdict/v1": VERDICT_SCHEMA_V1,
};

/**
 * Validate the cross-field invariant that JSON Schema cannot express for the
 * verdict/v1 preset. This stays separate from the shape validator so both the
 * injected tool and the host-side re-validation can apply the exact same rule.
 */
export function validateVerdictV1Semantics(value: unknown): { ok: boolean; errors: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: true, errors: [] };
  }
  const payload = value as { blockers?: unknown; findings?: unknown };
  const blockerFindings = Array.isArray(payload.findings)
    ? payload.findings.filter(
        (finding) =>
          finding !== null && typeof finding === "object" && (finding as { severity?: unknown }).severity === "blocker",
      ).length
    : 0;
  if (payload.blockers !== blockerFindings) {
    return {
      ok: false,
      errors: [
        `$.blockers must equal the number of findings with severity "blocker" (got ${String(payload.blockers)}, expected ${blockerFindings}); fix the blockers count`,
      ],
    };
  }
  return { ok: true, errors: [] };
}

/** Resolve a raw (model-supplied) `schema` value to a known preset, when it names one exactly. Anything else (a literal JSON Schema object, an unknown string, non-string) -> `undefined`. */
export function resolveSchemaPreset(raw: unknown): { id: SchemaPresetId; schema: JsonSchema } | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "verdict/v1") return { id: "verdict/v1", schema: VERDICT_SCHEMA_V1 };
  return undefined;
}

interface VerdictV1Shape {
  verdict: "pass" | "conditional_pass" | "reject";
  blockers: number;
  findings?: unknown[];
  report: string;
}

/**
 * Host-side presentation of a run's captured `structuredResult`. For the
 * `"verdict/v1"` preset, when `structured` genuinely validates against
 * `VERDICT_SCHEMA_V1`, renders the report verbatim plus a one-line verdict
 * summary; otherwise (no preset, or a preset whose structured payload fails
 * revalidation — should not normally happen given X10's double validation,
 * but this function must never throw) falls back to `JSON.stringify`.
 * `details.structuredResult` itself is never touched by this function.
 */
export function renderStructuredForHost(structured: unknown, preset: SchemaPresetId | undefined): string {
  if (
    preset === "verdict/v1" &&
    validateAgainstSchema(VERDICT_SCHEMA_V1, structured).ok &&
    validateVerdictV1Semantics(structured).ok
  ) {
    const v = structured as VerdictV1Shape;
    const findingsCount = Array.isArray(v.findings) ? v.findings.length : 0;
    return `${v.report}\n\nverdict: ${v.verdict} · blockers ${v.blockers} · findings ${findingsCount}`;
  }
  return JSON.stringify(structured);
}
