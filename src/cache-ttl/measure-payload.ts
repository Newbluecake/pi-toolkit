/** Build-mode validation of FINAL provider params (§3.3), not the pre-conversion context. */
import { OUTPUT_CAP, VALIDATOR_LIMITS } from "./measure-types.js";
import type { MeasureApi, PayloadExpectation, PayloadRejectionCode, PayloadVerdict } from "./measure-types.js";

const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function validateMeasurePayload(
  profile: MeasureApi,
  params: Record<string, unknown>,
  expect: PayloadExpectation,
): PayloadVerdict {
  try {
    const serialized = JSON.stringify(params);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > VALIDATOR_LIMITS.maxSerializedBytes)
      return refuse("too-large");
    if (profile !== expect.api || params.model !== expect.wireModel) return refuse("model-mismatch");
    if (params.stream !== true) return refuse("not-streaming");
    if (hasAny(params, ["tools", "tool_choice", "functions"])) return refuse("tools");
    if (params.n !== undefined && params.n !== 1) return refuse("n");
    switch (profile) {
      case "anthropic-messages":
        return validateAnthropicPayload(params, expect);
      case "openai-responses":
      case "openai-completions": {
        const unsupported = validateOpenAiPayload(profile, params, expect);
        // P2 replaces this explicit unsupported dispatch with the per-profile validators.
        void unsupported;
        return { ok: false, code: "extra-input", detail: "unsupported profile" };
      }
    }
  } catch {
    // Circular/unserialisable/otherwise unfamiliar params cannot authorize a paid request.
    return refuse("too-large");
  }
}

function validateOpenAiPayload(
  profile: "openai-responses" | "openai-completions",
  _params: Record<string, unknown>,
  _expect: PayloadExpectation,
): { kind: "unsupported"; profile: typeof profile } {
  return { kind: "unsupported", profile };
}

function validateAnthropicPayload(p: Record<string, unknown>, expect: PayloadExpectation): PayloadVerdict {
  if (hasAny(p, ["max_output_tokens", "max_completion_tokens"])) return refuse("conflicting-output-caps");
  if (p.max_tokens === undefined) return refuse("no-output-cap");
  if (
    !Number.isInteger(p.max_tokens) ||
    p.max_tokens !== OUTPUT_CAP[expect.api] ||
    expect.outputCap !== OUTPUT_CAP[expect.api]
  )
    return refuse("bad-output-cap");
  if (p.service_tier !== undefined && !["auto", "default", "standard_only"].includes(p.service_tier as string))
    return refuse("billing-tier");
  if (hasAny(p, ["mcp_servers", "container"])) return refuse("server-tools");
  if (hasAny(p, ["instructions", "prompt", "input"])) return refuse("extra-input");
  if (!validThinking(p, expect.managedEffort)) return refuse("thinking");

  const system = textParts(p.system);
  if (!system) return refuse(p.system === undefined ? "missing-synthetic-content" : "extra-input");
  let texts = system;
  if (
    expect.oauth &&
    system.length === 2 &&
    system[0] === OAUTH_IDENTITY &&
    OAUTH_IDENTITY.length <= VALIDATOR_LIMITS.oauthIdentityMaxChars
  )
    texts = system.slice(1);
  if (texts.length !== 1 || texts[0] !== expect.expectedSystem)
    return refuse(system.length === 0 ? "missing-synthetic-content" : "extra-input");
  if (!Array.isArray(p.messages) || p.messages.length === 0) return refuse("missing-synthetic-content");
  const messages = p.messages;
  const user = messages[0];
  if (!isRecord(user) || user.role !== "user" || !onlyKeys(user, ["role", "content"])) return refuse("extra-input");
  const userTexts = textParts(user.content);
  if (!userTexts || userTexts.length !== 1 || userTexts[0] !== expect.expectedUser) return refuse("extra-input");
  // One user message only, plus precisely the builder's empty trailing effort message.
  if (expect.managedEffort) {
    const effort = messages[1];
    if (
      messages.length !== 2 ||
      !isRecord(effort) ||
      effort.role !== "system" ||
      !Array.isArray(effort.content) ||
      effort.content.length !== 0 ||
      !onlyKeys(effort, ["role", "content", "output_config"]) ||
      !validEffort(effort.output_config)
    )
      return refuse("extra-input");
  } else if (messages.length !== 1) return refuse("extra-input");
  const textLength = system.reduce((sum, text) => sum + text.length, 0) + userTexts[0]!.length;
  if (textLength > expect.expectedSystem.length + expect.expectedUser.length + VALIDATOR_LIMITS.extraTextChars)
    return refuse("extra-input");

  // The last USER block, not the managed-effort system message, must have a breakpoint.
  const content = user.content;
  const last = Array.isArray(content) ? content[content.length - 1] : undefined;
  const control = isRecord(last) ? last.cache_control : undefined;
  if (!validCacheControl(control)) return refuse("no-cache-control");
  const long = control.ttl === "1h";
  if (expect.requestedRetention === "long" && !long) return refuse("long-unsupported");
  // Mixed system/user TTLs cannot be represented honestly by one effective tier.
  for (const block of Array.isArray(p.system) ? p.system : []) {
    if (
      isRecord(block) &&
      block.cache_control !== undefined &&
      (!validCacheControl(block.cache_control) || (block.cache_control.ttl === "1h") !== long)
    )
      return refuse("no-cache-control");
  }
  return { ok: true, effectiveTier: long ? "ephemeral-1h" : "ephemeral" };
}

function validThinking(p: Record<string, unknown>, managed: boolean): boolean {
  const thinking = p.thinking;
  if (!managed)
    return (
      !hasAny(p, ["output_config"]) &&
      (thinking === undefined || (isRecord(thinking) && thinking.type === "disabled" && onlyKeys(thinking, ["type"])))
    );
  return (
    isRecord(thinking) &&
    thinking.type === "adaptive" &&
    ["summarized", "omitted"].includes(thinking.display as string) &&
    onlyKeys(thinking, ["type", "display", "block_binding"]) &&
    isRecord(thinking.block_binding) &&
    thinking.block_binding.prefix_mismatch_behavior === "drop_block" &&
    onlyKeys(thinking.block_binding, ["prefix_mismatch_behavior"]) &&
    validEffort(p.output_config)
  );
}
function validEffort(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ["effort"]) &&
    ["low", "medium", "high", "xhigh", "max"].includes(value.effort as string)
  );
}
function validCacheControl(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === "ephemeral" &&
    onlyKeys(value, ["type", "ttl"]) &&
    (value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h")
  );
}
function textParts(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return undefined;
  const texts: string[] = [];
  for (const block of value) {
    if (
      !isRecord(block) ||
      block.type !== "text" ||
      typeof block.text !== "string" ||
      !onlyKeys(block, ["type", "text", "cache_control"])
    )
      return undefined;
    texts.push(block.text);
  }
  return texts;
}
function hasAny(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(value, key));
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function refuse(code: PayloadRejectionCode): PayloadVerdict {
  return { ok: false, code };
}
