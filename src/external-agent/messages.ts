/**
 * 外部 agent 对外文案（external-agent plan §2.11，P1 冻结面）。
 * 全部英文；这是模型/用户可见文案的唯一来源——后续包只 import，不得内联复制。
 */

export const MSG_READONLY_DOMAIN: string =
  'toolDomain:"readonly" runs cannot use droid/* models: external agents run with full permissions in this ' +
  "version, so pi-toolkit cannot guarantee read-only execution. Use a pi model for this run.";

export const MSG_EXPERTS_UNSUPPORTED: string =
  "experts/consult is not supported for droid/* runs (external agents cannot load the consult tool)";

export function msgExpertIsExternal(runId: string): string {
  return `expert ${runId} is a droid external-agent run; consult requires a pi session`;
}

export function msgResumeCrossRuntime(runId: string, from: "droid" | "pi"): string {
  const other = from === "droid" ? "pi" : "droid";
  const origin = from === "droid" ? "a droid external-agent" : "a pi";
  return `cannot resume ${runId}: it was created as ${origin} session, and cross-runtime resume (${other}) is not supported`;
}

export function msgResumeDisabled(runId: string): string {
  return `cannot resume ${runId}: it is a droid external-agent session, but external agents are disabled — enable externalAgents.droid.enabled to resume it`;
}

export function msgResumeCwdGone(cwd: string): string {
  return (
    `cannot resume this droid session: it was created in ${cwd}, which no longer exists (deleted working directory ` +
    "or worktree). droid sessions are bound to their original directory — resuming elsewhere would fork the " +
    "session history. Start a new run instead."
  );
}

export const MSG_RESUME_ISOLATION: string =
  "isolation cannot be combined with resuming a droid run: droid sessions are pinned to their original working directory";

export const MSG_SET_MODEL_TO_EXTERNAL: string = "set_model cannot switch to an external-agent model";

export const MSG_SET_MODEL_ON_EXTERNAL: string = "droid external-agent run; mid-run model switching is not supported";

/** arch §5.1 全文（`expected` = DROID_PROTOCOL_VERSION、`agentVersion` = 目录探测到的 droid 自身版本）。 */
export function msgProtocolDrift(actual: string, expected: string, agentVersion?: string): string {
  const suffix = agentVersion === undefined ? "" : ` (droid ${agentVersion})`;
  return (
    `droid protocol drift: droid speaks factoryProtocolVersion ${actual}, pi-toolkit is pinned to ${expected}${suffix}. ` +
    "Run the droid conformance suite (PI_TOOLKIT_DROID_CONFORMANCE=1 npm run test:conformance) and bump " +
    'DROID_PROTOCOL_VERSION, or set externalAgents.droid.protocolCheck="warn".'
  );
}

/** arch §8.4 鉴权文案（`detail` 已脱敏——调用方负责，本函数不再处理）。 */
export function msgAuthFailure(detail: string): string {
  return (
    `droid authentication/subscription failure (${detail}). This is not a model error — do not retry. ` +
    "Check FACTORY_API_KEY in pi's environment (~/.factory/env.sh is only sourced by new shells; restart pi " +
    "after updating it)."
  );
}

export const MSG_USAGE_EXHAUSTED: string =
  "droid reports model usage exhausted (Factory subscription/credits) — not a model error, do not retry";

/** 非我方发起的 cancel；permissionApprovals > 0 时附批准可能未被理解的提示（§4.3）。 */
export function msgUnexpectedCancel(permissionApprovals: number): string {
  const base = "droid cancelled the turn unexpectedly";
  return permissionApprovals > 0
    ? `${base} (permission approval may not have been understood by this droid version)`
    : base;
}

export function msgPermissionUnacknowledged(waitedMs: number): string {
  return `droid did not acknowledge the permission approval within ${Math.round(waitedMs / 1000)}s (protocol drift?); pi-toolkit stopped the run`;
}

export const MSG_PERMISSION_REPLY_FAILED: string =
  "failed to answer droid's permission request (stdin closed); pi-toolkit stopped the run";

export function msgBinaryNotFound(binary: string): string {
  return (
    `droid binary not found: ${binary} — install Factory droid and make sure it is on PATH, ` +
    "or set externalAgents.droid.binary to the right path"
  );
}

export function msgSchemaNoJson(): string {
  return "droid run did not end with a parseable ```json block (external agents have no StructuredOutput tool)";
}

export function msgProviderNameCollision(provider: string): string {
  return (
    `provider name collision: the pi model registry already has a provider named "${provider}", so the ` +
    `external agent provider cannot be registered as "${provider}" — remove or rename the pi provider, or ` +
    "disable externalAgents.droid"
  );
}

/** §4.8 capabilities 文案：按可缺能力拼「Unavailable here」列表（consult 恒不可用）。 */
export function capabilitiesText(o: { canSpawn: boolean; canMessage: boolean }): string {
  const missing: string[] = ["consulting experts"];
  if (!o.canMessage) missing.push("messaging other agents");
  if (!o.canSpawn) missing.push("spawning pi sub-agents");
  return (
    "You are running as an external agent (Factory droid) on behalf of pi-toolkit, with full permissions in " +
    `your working directory. Unavailable here: ${missing.join(", ")}. Write every finding into your final answer.`
  );
}

/** §5.3 提示词头部文案（`### External agent models (<provider>)` 标题之后的一行说明）。 */
export function externalModelsPromptHeader(provider: string): string {
  return (
    `\`${provider}/<id>\` runs the subagent as a Factory ${provider} CLI process with full permissions, not a pi ` +
    'session: no consult/experts, message_agent, nested Agent, set_model or toolDomain:"readonly"; resuming is ' +
    "pinned to the original working directory; schema answers are parsed from a final ```json block; cost is " +
    "computed from the underlying model's pi price (shown as unpriced when unknown). Any " +
    `${provider} model id is accepted.`
  );
}
