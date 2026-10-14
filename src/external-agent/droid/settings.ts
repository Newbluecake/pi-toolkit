/**
 * droid 会话设置（plan §4.4）：init/update 参数构造、thinking→reasoningEffort 映射、
 * 生效值校验（fail closed）。
 *
 * S5 成本陷阱：initialize_session 对无效 modelId **静默**回落默认 gpt-6-sol+high；
 * update_session_settings 则干净拒绝 -32602 "Unknown model"。所以 create/resume 都是
 * init 之后**无条件** update，并以 settings_updated 全量 echo（update 成功响应是 `{}`，
 * S/47 实测）或 init result.settings 作为生效值来源比对 modelId/autonomyLevel。
 */
import {
  DROID_AUTO_REJECT_PERMISSIONS,
  DROID_AUTONOMY_FULL,
  DROID_EFFORT_ORDER,
  DROID_MACHINE_ID,
} from "./protocol.js";

/**
 * initialize_session 参数（plan §6.2 P3 冻结导出）。
 * `autonomyLevel` 覆盖**仅供 conformance**（D7 用 "off" 触发权限请求）；生产路径恒为
 * DROID_AUTONOMY_FULL（"high"）。
 */
export function buildInitParams(o: {
  cwd: string;
  modelId: string;
  reasoningEffort?: string;
  sessionId?: string;
  autonomyLevel?: string;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    machineId: DROID_MACHINE_ID,
    cwd: o.cwd,
    modelId: o.modelId,
    autonomyLevel: o.autonomyLevel ?? DROID_AUTONOMY_FULL,
    autoRejectPermissionRequests: DROID_AUTO_REJECT_PERMISSIONS,
  };
  if (o.reasoningEffort !== undefined) params.reasoningEffort = o.reasoningEffort;
  if (o.sessionId !== undefined) params.sessionId = o.sessionId;
  return params;
}

/** update_session_settings 参数（§4.4 无条件下发；resume 同时解决「持久化设置覆盖 init」坑）。 */
export function buildUpdateSettingsParams(o: { modelId: string; reasoningEffort?: string }): Record<string, unknown> {
  const params: Record<string, unknown> = {
    modelId: o.modelId,
    autonomyLevel: DROID_AUTONOMY_FULL,
    autoRejectPermissionRequests: DROID_AUTO_REJECT_PERMISSIONS,
  };
  if (o.reasoningEffort !== undefined) params.reasoningEffort = o.reasoningEffort;
  return params;
}

/** settings echo 里我们关心的字段（init result.settings / settings_updated.settings 同形）。 */
export interface DroidSettingsEcho {
  modelId?: string;
  autonomyLevel?: string;
  reasoningEffort?: string;
}

/** 从 init result / settings_updated notification / update 响应里抽 settings echo；非对象 ⇒ undefined。 */
export function extractSettingsEcho(source: unknown): DroidSettingsEcho | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const settings = (source as Record<string, unknown>).settings ?? source;
  if (settings === null || typeof settings !== "object") return undefined;
  const s = settings as Record<string, unknown>;
  const out: DroidSettingsEcho = {};
  if (typeof s.modelId === "string") out.modelId = s.modelId;
  if (typeof s.autonomyLevel === "string") out.autonomyLevel = s.autonomyLevel;
  if (typeof s.reasoningEffort === "string") out.reasoningEffort = s.reasoningEffort;
  return out;
}

/** 全量 echo 判定：带 modelId 的 echo 才能用于生效值比对（S/47：update 后先来一条只含变更字段的部分 echo）。 */
export function isFullSettingsEcho(
  echo: DroidSettingsEcho | undefined,
): echo is DroidSettingsEcho & { modelId: string } {
  return echo !== undefined && typeof echo.modelId === "string" && echo.modelId.length > 0;
}

/**
 * 生效值比对（§4.4 step 3，fail closed）：modelId 不符（S5 静默回落）或
 * autonomyLevel !== "high" ⇒ 返回错误描述；通过 ⇒ undefined。
 * echo 缺失/不全 ⇒ 也算不符（无法证明生效值，fail closed）。
 */
export function verifyEffectiveSettings(
  echo: DroidSettingsEcho | undefined,
  expected: { modelId: string },
): string | undefined {
  if (!isFullSettingsEcho(echo)) return "droid did not report a full settings echo (protocol drift?)";
  if (echo.modelId !== expected.modelId)
    return `requested model "${expected.modelId}" but droid applied "${echo.modelId}"`;
  if (echo.autonomyLevel !== DROID_AUTONOMY_FULL)
    return `requested autonomyLevel "${DROID_AUTONOMY_FULL}" but droid applied "${echo.autonomyLevel ?? "<missing>"}"`;
  return undefined;
}

/**
 * thinking → reasoningEffort（arch §8.3）：
 * - level undefined ⇒ defaultEffort（目录已知时）；否则不发（交给 droid 默认）。
 * - "off" ⇒ 依次取 off/none/minimal 中第一个受支持的；都不支持 ⇒ 最低档。
 * - low|medium|high ⇒ 受支持则原样；否则按 DROID_EFFORT_ORDER 取最近受支持档（同距取低）。
 * - efforts 未知（目录未探测到）⇒ level 是合法档位名则原样透传（init/update 会校验），否则 undefined。
 */
export function mapThinkingToEffort(
  level: string | undefined,
  efforts: readonly string[] | undefined,
  defaultEffort: string | undefined,
): string | undefined {
  const known = efforts?.filter((e) => (DROID_EFFORT_ORDER as readonly string[]).includes(e));
  if (level === undefined) return known !== undefined ? defaultEffort : undefined;
  if (known === undefined || known.length === 0)
    return (DROID_EFFORT_ORDER as readonly string[]).includes(level) ? level : undefined;
  const lowest = DROID_EFFORT_ORDER.find((e) => known.includes(e));
  if (level === "off") {
    for (const e of ["off", "none", "minimal"]) if (known.includes(e)) return e;
    return lowest;
  }
  if (known.includes(level)) return level;
  const idx = (DROID_EFFORT_ORDER as readonly string[]).indexOf(level);
  if (idx < 0) return defaultEffort ?? lowest;
  // 最近的受支持档；同距取低。
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of known) {
    const d = Math.abs((DROID_EFFORT_ORDER as readonly string[]).indexOf(e) - idx);
    if (d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best ?? lowest;
}

/** 从目录里取模型的 effort 信息（目录可能不可用 ⇒ undefined）。 */
export function effortInfoOf(
  catalogModels: readonly { id: string; reasoningEfforts: readonly string[]; defaultEffort?: string }[] | undefined,
  modelId: string,
): { efforts: readonly string[] | undefined; defaultEffort: string | undefined } {
  const info = catalogModels?.find((m) => m.id === modelId);
  return { efforts: info?.reasoningEfforts, defaultEffort: info?.defaultEffort };
}
