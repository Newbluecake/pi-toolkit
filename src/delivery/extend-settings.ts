/**
 * delivery · timeout-grace/extension settings (#56 batch 2 ⑧): the `extend` block's type, frozen defaults and
 * never-throws parser (timeout-notify arch §7.2). `src/config/settings.ts` imports ONLY this module for the block.
 */

/**
 * timeout-notify：超时宽限 + 延长设置（arch §7.2）。逐字段容错解析见
 * parseExtendSettings。
 */
export interface ExtendSettings {
  /** 总开关。false 时：不注册 extend_subagent_timeout 工具，且 spawn 合并后钳 maxExtensions = 0（D-16）。Default true. */
  enabled: boolean;
  /** 宽限通知投递策略：background = 跳过仍在前台阻塞宿主的 caller-ack run；always = 调试用（D-17）；off = 不发（宽限仍生效）。 */
  notify: "background" | "always" | "off";
}

/** Parse the optional timeout grace/extension settings block（parseCacheTtlSettings 同款容错，never throws）。 */
export function parseExtendSettings(input: unknown): ExtendSettings {
  const defaults = DEFAULT_EXTEND_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    notify:
      value.notify === "background" || value.notify === "always" || value.notify === "off"
        ? value.notify
        : defaults.notify,
  };
}

export const DEFAULT_EXTEND_SETTINGS: ExtendSettings = { enabled: true, notify: "background" };
