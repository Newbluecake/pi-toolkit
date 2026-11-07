/**
 * sysprompt · settings (#56 batch 2 ⑧): the `systemPrompt` block's type, frozen defaults and never-throws parser
 * (design: docs/dev/sysprompt-stable/README.md). `src/config/settings.ts` imports ONLY this module for the block.
 */

/**
 * system prompt 稳定化（docs/dev/sysprompt-stable/plan.md v3.1 §3.2/§3.5）。S1 阶段
 * 只有 `wakeReplay` 一个键（U5）：通知唤醒轮（`triggerTurn: true` 的 sendMessage）
 * 不经过 `before_agent_start`，开头与用户轮不同 ⇒ 整前缀缓存来回失效；开启时把
 * 用户轮捕获的强制文本按 pi 强制投影的形态回放到唤醒请求。`false` = 整层不注册
 * （不是注册后空转），行为与今天逐字节相同。`mode` / `adoptForeignForcedPrompt`
 * 随 M2 加入。逐字段容错解析见 parseSystemPromptSettings（never throws）。
 */
export interface SystemPromptSettings {
  /** Replay the last user run's forced system-prompt bytes onto notification wake runs. Default true. */
  wakeReplay: boolean;
  /** stable freezes sections; live refreshes through the hub; legacy keeps raw live semantics. */
  mode: "stable" | "live" | "legacy";
  /** Permit adopting text appended by a later extension to our forced prompt. */
  adoptForeignForcedPrompt: boolean;
}

/** Parse the optional `systemPrompt` settings block (sysprompt-stable §3.2). Field-by-field fallback to defaults, never throws. */
export function parseSystemPromptSettings(input: unknown): SystemPromptSettings {
  const defaults = DEFAULT_SYSTEM_PROMPT_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const mode = value.mode;
  return {
    wakeReplay: typeof value.wakeReplay === "boolean" ? value.wakeReplay : defaults.wakeReplay,
    mode: mode === "stable" || mode === "live" || mode === "legacy" ? mode : defaults.mode,
    adoptForeignForcedPrompt:
      typeof value.adoptForeignForcedPrompt === "boolean"
        ? value.adoptForeignForcedPrompt
        : defaults.adoptForeignForcedPrompt,
  };
}

export const DEFAULT_SYSTEM_PROMPT_SETTINGS: SystemPromptSettings = {
  wakeReplay: true,
  mode: "stable",
  adoptForeignForcedPrompt: false,
};
