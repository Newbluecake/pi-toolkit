/** Small bounded JSON-schema subset used by this generated, closed protocol projection.
 * Unsupported keywords/types FAIL CLOSED. Not a general-purpose schema implementation. */
type Schema = { readonly [key: string]: unknown };
const allowed = new Set([
  "anyOf",
  "const",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);
export function terminalSchemaCheck<T>(schema: unknown, value: unknown, depth = 0): value is T {
  if (depth > 16 || !schema || typeof schema !== "object") return false;
  const s = schema as Schema;
  if (Object.keys(s).some((key) => !allowed.has(key))) return false;
  if (Array.isArray(s.anyOf) && Object.keys(s).length !== 1) return false;
  if (Array.isArray(s.anyOf)) return s.anyOf.some((child) => terminalSchemaCheck(child, value, depth + 1));
  if ("const" in s && value !== s.const) return false;
  switch (s.type) {
    case "object": {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        s.additionalProperties !== false ||
        !s.properties ||
        typeof s.properties !== "object"
      )
        return false;
      const object = value as Record<string, unknown>,
        properties = s.properties as Record<string, unknown>;
      if (
        Array.isArray(s.required) &&
        s.required.some((key) => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(object, key))
      )
        return false;
      return Object.entries(object).every(
        ([key, item]) =>
          Object.prototype.hasOwnProperty.call(properties, key) &&
          terminalSchemaCheck(properties[key], item, depth + 1),
      );
    }
    case "array":
      return (
        Array.isArray(value) &&
        (typeof s.minItems !== "number" || value.length >= s.minItems) &&
        (typeof s.maxItems !== "number" || value.length <= s.maxItems) &&
        value.every((item) => terminalSchemaCheck(s.items, item, depth + 1))
      );
    case "string":
      return (
        typeof value === "string" &&
        (typeof s.minLength !== "number" || value.length >= s.minLength) &&
        (typeof s.maxLength !== "number" || value.length <= s.maxLength) &&
        (typeof s.pattern !== "string" || new RegExp(s.pattern).test(value))
      );
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (s.type !== "integer" || Number.isInteger(value)) &&
        (typeof s.minimum !== "number" || value >= s.minimum) &&
        (typeof s.maximum !== "number" || value <= s.maximum)
      );
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}
