/**
 * #83 offline-only shape diagnostic. No registration, SDK, files, configuration or IO.
 * Input: { observations: [{source, sourceEvidence, api, apiEvidence, strict?, schema}],
 *          compare?: [leftIndex, rightIndex] }.
 * Labels are unverified declarations, including "transport-attested". They never certify provenance.
 * Only JSON data (own data descriptors) is accepted; accessors/functions/cycles fail closed.
 * Limits apply to canonical JSON for the pure API; the CLI also bounds raw stdin bytes.
 * Nodes count values (including containers), root depth is zero. No input is mutated.
 */
export const SCHEDULE_SCHEMA_LIMITS = Object.freeze({
  inputBytes: 256 * 1024,
  nodes: 4096,
  depth: 32,
  outputBytes: 32 * 1024,
});

export const SCHEDULE_SCHEMA_FIELDS = Object.freeze([
  "action",
  "id",
  "name",
  "form",
  "cron",
  "at",
  "every",
  "tz",
  "prompt",
  "feishu",
  "agentType",
  "model",
  "thinking",
  "timeoutS",
  "handoff",
  "isolation",
] as const);
const SOURCES = ["source", "registered", "sdk", "post-bridge", "transport", "reported", "unknown"] as const;
const APIS = [
  "openai-responses",
  "openai-codex-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
  "unknown",
] as const;
const EVIDENCE = ["reported", "selected", "transport-attested", "unknown"] as const;
const TYPES = ["null", "boolean", "object", "array", "number", "integer", "string"] as const;
type JsonType = (typeof TYPES)[number];
type Truth = "yes" | "no" | "unknown";
type Presence = "missing" | "present" | "unknown";
type Strict = "absent" | "true" | "false" | "explicit-null" | "unknown";
type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
export type DiagnosticErrorCode =
  | "E_INPUT_BYTES"
  | "E_NODES"
  | "E_DEPTH"
  | "E_OUTPUT_BYTES"
  | "E_INPUT_DATA"
  | "E_INPUT_SHAPE"
  | "E_JSON"
  | "E_ARGUMENTS"
  | "E_STDIN";
export interface DiagnosticFailure {
  ok: false;
  error: DiagnosticErrorCode;
}
interface FieldShape {
  field: (typeof SCHEDULE_SCHEMA_FIELDS)[number];
  presence: Presence;
  required: Truth;
  type: JsonType[] | "unknown";
  nullability: Truth;
}
export interface ScheduleSchemaShape {
  source: (typeof SOURCES)[number];
  sourceEvidence: (typeof EVIDENCE)[number];
  api: (typeof APIS)[number];
  apiEvidence: (typeof EVIDENCE)[number];
  strict: Strict;
  schemaPresence: "missing" | "explicit-null" | "present";
  fields: FieldShape[];
  unrecognizedProperties: number;
  unrecognizedRequired: number;
  unsupported: number;
  complete: boolean;
}
export type DiagnosticResult =
  | DiagnosticFailure
  | {
      ok: true;
      evidence: "declarations-only";
      scope: "shape-only-not-a-fix";
      observations: ScheduleSchemaShape[];
      comparison?: "different" | "inconclusive" | "equivalent";
    };

class LimitFailure {
  constructor(readonly code: DiagnosticErrorCode) {}
}
export function scheduleDiagnosticFailure(error: DiagnosticErrorCode): DiagnosticFailure {
  // Runtime allowlist too: a cast or untyped caller cannot turn an error into a value echo.
  const allowed: readonly string[] = [
    "E_INPUT_BYTES",
    "E_NODES",
    "E_DEPTH",
    "E_OUTPUT_BYTES",
    "E_INPUT_DATA",
    "E_INPUT_SHAPE",
    "E_JSON",
    "E_ARGUMENTS",
    "E_STDIN",
  ];
  return { ok: false, error: allowed.includes(error) ? error : "E_INPUT_DATA" };
}

function record(v: Data | undefined): v is { [key: string]: Data } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function own(v: Data | undefined, key: string): Data | undefined {
  return record(v) ? (Object.getOwnPropertyDescriptor(v, key)?.value as Data | undefined) : undefined;
}
function has(v: Data | undefined, key: string): boolean {
  return record(v) && Object.getOwnPropertyDescriptor(v, key) !== undefined;
}
function label<const T extends readonly string[]>(value: Data | undefined, allowed: T): T[number] {
  return (typeof value === "string" && allowed.some((x) => x === value) ? value : "unknown") as T[number];
}

/** Descriptor-only copy: JSON.stringify is used on the private copy, never on caller objects. */
function copyData(input: unknown): Data {
  let nodes = 0;
  let bytes = 0;
  function consume(size: number): void {
    bytes += size;
    if (bytes > SCHEDULE_SCHEMA_LIMITS.inputBytes) throw new LimitFailure("E_INPUT_BYTES");
  }
  const active = new Set<object>();
  function visit(v: unknown, depth: number): Data {
    if (++nodes > SCHEDULE_SCHEMA_LIMITS.nodes) throw new LimitFailure("E_NODES");
    if (depth > SCHEDULE_SCHEMA_LIMITS.depth) throw new LimitFailure("E_DEPTH");
    if (v === null || typeof v === "boolean") {
      consume(v === null || v === true ? 4 : 5);
      return v;
    }
    if (typeof v === "string") {
      if (Buffer.byteLength(v, "utf8") > SCHEDULE_SCHEMA_LIMITS.inputBytes) throw new LimitFailure("E_INPUT_BYTES");
      consume(Buffer.byteLength(JSON.stringify(v), "utf8"));
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      consume(JSON.stringify(v).length);
      return v;
    }
    if (typeof v !== "object" || active.has(v)) throw new LimitFailure("E_INPUT_DATA");
    active.add(v);
    const array = Array.isArray(v);
    consume(2); // Braces/brackets; every byte is counted before building the private copy.
    const out: Data[] | { [key: string]: Data } = array ? [] : (Object.create(null) as { [key: string]: Data });
    const names = Object.getOwnPropertyNames(v);
    if (names.length > SCHEDULE_SCHEMA_LIMITS.nodes + 1) throw new LimitFailure("E_NODES");
    if (Object.getOwnPropertySymbols(v).length) throw new LimitFailure("E_INPUT_DATA");
    let entries = 0;
    for (const key of names) {
      if (array && key === "length") continue;
      const desc = Object.getOwnPropertyDescriptor(v, key);
      if (!desc || !("value" in desc)) throw new LimitFailure("E_INPUT_DATA");
      if (array && key !== String(entries)) throw new LimitFailure("E_INPUT_DATA");
      if (Buffer.byteLength(key, "utf8") > SCHEDULE_SCHEMA_LIMITS.inputBytes) throw new LimitFailure("E_INPUT_BYTES");
      consume((entries ? 1 : 0) + (array ? 0 : Buffer.byteLength(JSON.stringify(key), "utf8") + 1));
      Object.defineProperty(out, key, {
        value: visit(desc.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      entries++;
    }
    if (array && Object.getOwnPropertyDescriptor(v, "length")?.value !== entries)
      throw new LimitFailure("E_INPUT_DATA");
    active.delete(v);
    return out;
  }
  return visit(input, 0);
}

const ANNOTATIONS = ["description", "title", "$comment", "default", "examples", "$schema"];
function extraKeys(v: Data, allowed: readonly string[]): number {
  return record(v) ? Object.keys(v).filter((k) => !allowed.includes(k) && !ANNOTATIONS.includes(k)).length : 0;
}
function simpleTypes(v: Data | undefined): JsonType[] | "unknown" {
  const values = Array.isArray(v) ? v : [v];
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((t) => typeof t !== "string" || !TYPES.some((x) => x === t))
  )
    return "unknown";
  return TYPES.filter((t) => values.includes(t));
}
function fieldSemantics(schema: Data | undefined): {
  type: JsonType[] | "unknown";
  nullability: Truth;
  unsupported: number;
} {
  if (schema === true) return { type: "unknown", nullability: "yes", unsupported: 0 };
  if (!record(schema)) return { type: "unknown", nullability: "unknown", unsupported: 1 };
  const unsupported = extraKeys(schema, ["type", "anyOf"]);
  // Constraints/ref/oneOf/allOf and sibling composition are deliberately not solved.
  if (unsupported || (has(schema, "type") && has(schema, "anyOf")))
    return { type: "unknown", nullability: "unknown", unsupported: Math.max(1, unsupported) };
  if (has(schema, "anyOf")) {
    const branches = own(schema, "anyOf");
    if (!Array.isArray(branches) || !branches.length)
      return { type: "unknown", nullability: "unknown", unsupported: 1 };
    const parts = branches.map(fieldSemantics);
    // Evaluate null as a value, NOT a union of reported branch types. No type union is inferred.
    const nullability = parts.some((p) => p.nullability === "yes")
      ? "yes"
      : parts.every((p) => p.nullability === "no")
        ? "no"
        : "unknown";
    return { type: "unknown", nullability, unsupported: parts.reduce((n, p) => n + p.unsupported, 0) };
  }
  if (!has(schema, "type")) return { type: "unknown", nullability: "yes", unsupported: 0 };
  const type = simpleTypes(own(schema, "type"));
  return {
    type,
    nullability: type === "unknown" ? "unknown" : type.includes("null") ? "yes" : "no",
    unsupported: type === "unknown" ? 1 : 0,
  };
}
function shape(observation: Data): ScheduleSchemaShape {
  if (!record(observation)) throw new LimitFailure("E_INPUT_SHAPE");
  const schema = own(observation, "schema");
  const properties = own(schema, "properties");
  const required = own(schema, "required");
  const rootExtras =
    schema === true
      ? 0
      : record(schema)
        ? extraKeys(schema, ["type", "properties", "required", "additionalProperties"])
        : 1;
  const rootKnown =
    record(schema) &&
    rootExtras === 0 &&
    own(schema, "type") === "object" &&
    (!has(schema, "additionalProperties") || typeof own(schema, "additionalProperties") === "boolean");
  const propsKnown = rootKnown && (!has(schema, "properties") || record(properties));
  const reqKnown =
    rootKnown &&
    (!has(schema, "required") ||
      (Array.isArray(required) &&
        required.every((r) => typeof r === "string") &&
        new Set(required).size === required.length));
  // Unknown observation keys are counted, never named or interpreted. Metadata labels
  // themselves do not establish transport evidence or affect semantic equality.
  let unsupported =
    rootExtras +
    (rootKnown ? 0 : 1) +
    extraKeys(observation, ["source", "sourceEvidence", "api", "apiEvidence", "strict", "schema"]);
  const fields = SCHEDULE_SCHEMA_FIELDS.map((field): FieldShape => {
    const presence = !propsKnown ? "unknown" : has(properties, field) ? "present" : "missing";
    const req: Truth = !reqKnown ? "unknown" : Array.isArray(required) && required.includes(field) ? "yes" : "no";
    const sem =
      presence === "present"
        ? fieldSemantics(own(properties, field))
        : { type: "unknown" as const, nullability: "unknown" as const, unsupported: 0 };
    unsupported += sem.unsupported;
    return { field, presence, required: req, type: sem.type, nullability: sem.nullability };
  });
  const strictValue = own(observation, "strict");
  const strict: Strict = !has(observation, "strict")
    ? "absent"
    : strictValue === null
      ? "explicit-null"
      : strictValue === true
        ? "true"
        : strictValue === false
          ? "false"
          : "unknown";
  const unrecognizedProperties = record(properties)
    ? Object.keys(properties).filter((k) => !SCHEDULE_SCHEMA_FIELDS.some((f) => f === k)).length
    : 0;
  const unrecognizedRequired = Array.isArray(required)
    ? required.filter((k) => !SCHEDULE_SCHEMA_FIELDS.some((f) => f === k)).length
    : 0;
  const complete =
    rootKnown &&
    propsKnown &&
    reqKnown &&
    strict !== "unknown" &&
    !unsupported &&
    !unrecognizedProperties &&
    !unrecognizedRequired &&
    fields.every(
      (f) =>
        (f.presence === "missing" && f.required === "no") ||
        (f.presence === "present" && f.type !== "unknown" && f.nullability !== "unknown"),
    );
  return {
    source: label(own(observation, "source"), SOURCES),
    sourceEvidence: label(own(observation, "sourceEvidence"), EVIDENCE),
    api: label(own(observation, "api"), APIS),
    apiEvidence: label(own(observation, "apiEvidence"), EVIDENCE),
    strict,
    schemaPresence: !has(observation, "schema") ? "missing" : schema === null ? "explicit-null" : "present",
    fields,
    unrecognizedProperties,
    unrecognizedRequired,
    unsupported,
    complete,
  };
}

/** Metadata labels do not participate in shape equality; unknowns can never prove equivalence. */
function compareScheduleSchemaShapes(
  a: ScheduleSchemaShape,
  b: ScheduleSchemaShape,
): "different" | "inconclusive" | "equivalent" {
  if (a.strict !== "unknown" && b.strict !== "unknown" && a.strict !== b.strict) return "different";
  if (a.schemaPresence !== b.schemaPresence) return "different";
  for (let i = 0; i < SCHEDULE_SCHEMA_FIELDS.length; i++) {
    const x = a.fields[i],
      y = b.fields[i];
    if (!x || !y) return "inconclusive";
    if (x.presence !== "unknown" && y.presence !== "unknown" && x.presence !== y.presence) return "different";
    if (x.required !== "unknown" && y.required !== "unknown" && x.required !== y.required) return "different";
    if (x.type !== "unknown" && y.type !== "unknown" && x.type.join(",") !== y.type.join(",")) return "different";
    if (x.nullability !== "unknown" && y.nullability !== "unknown" && x.nullability !== y.nullability)
      return "different";
  }
  return a.complete && b.complete ? "equivalent" : "inconclusive";
}

export function inspectScheduleSchemaShape(input: unknown): DiagnosticResult {
  try {
    const data = copyData(input);
    const observations = own(data, "observations");
    if (!record(data) || !Array.isArray(observations) || !observations.length) throw new LimitFailure("E_INPUT_SHAPE");
    const result: Extract<DiagnosticResult, { ok: true }> = {
      ok: true,
      evidence: "declarations-only",
      scope: "shape-only-not-a-fix",
      observations: observations.map(shape),
    };
    if (has(data, "compare")) {
      const pair = own(data, "compare");
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !pair.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < observations.length)
      )
        throw new LimitFailure("E_INPUT_SHAPE");
      result.comparison = compareScheduleSchemaShapes(
        result.observations[pair[0] as number]!,
        result.observations[pair[1] as number]!,
      );
    }
    // Include the newline emitted by the CLI in the output budget. Never return a partial projection.
    if (Buffer.byteLength(JSON.stringify(result) + "\n", "utf8") > SCHEDULE_SCHEMA_LIMITS.outputBytes)
      throw new LimitFailure("E_OUTPUT_BYTES");
    return result;
  } catch (error) {
    return scheduleDiagnosticFailure(error instanceof LimitFailure ? error.code : "E_INPUT_DATA");
  }
}
