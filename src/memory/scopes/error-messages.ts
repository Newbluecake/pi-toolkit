import type { ScopedMemoryErrorCode } from "./types.js";

/** Exhaustive user-facing guidance; adding a code requires adding its guidance. */
export const SCOPED_ERROR_MESSAGES: Record<ScopedMemoryErrorCode, string> = {
  E_SCOPE_DISABLED: "该记忆作用域不可用，因为当前配置或会话未启用它；请检查设置并在允许的会话中重试。",
  E_CHILD_READONLY: "子会话不能执行此写操作，因为该作用域对它只读；请在主会话中操作。",
  E_CHILD_AUTHORITY: "子会话不能指定 authority，因为其权限由主会话决定；请省略 authority 重试。",
  E_AUTHORITY: "操作未获允许，因为当前身份或权威不符合要求；请检查目标权限，并在需要时由用户在主会话操作。",
  E_HUB_NEEDS_HUMAN_TURN:
    "无法请求批准，因为当前没有有效的真人回合；后台通知会作废真人回合，请在自己的消息里立即重试，并在弹窗中批准。",
  E_HUB_CONFIRM_UNAVAILABLE: "无法请求真人批准，因为当前没有可用的确认界面；请使用终端或网页交互界面重试。",
  E_HUB_DECLINED: "操作未获批准，因为确认被拒绝、取消或超时；如仍需操作，请在新的真人消息中重新发起并确认。",
  E_HUB_DECLINED_TURN: "本回合不能再次请求批准，因为用户已拒绝过；请尊重拒绝，只有用户在新消息中要求时才重新发起。",
  E_HUB_RATE:
    "无法继续请求批准：若本回合批准请求次数已达上限，请等待用户的新消息后再按需重试；若上一个批准请求仍在进行中，请等它结算（批准 / 拒绝 / 超时）后再重试。",
  E_HUB_CAP_STALE: "批准已失效，因为操作或会话状态发生变化；请重新读取目标，并在新的真人回合重新申请批准。",
  E_USER_AUTH_DECLINED: "用户权威操作未获批准，因为用户拒绝了确认；请尊重拒绝，只有用户再次要求时才重新发起。",
  E_REV_REQUIRED: "更新或删除缺少有效版本，因为必须防止覆盖新内容；请先 view 目标并传入返回的实际 rev。",
  E_CONFLICT: "操作发生冲突，因为目标或其版本已变化；请重新 view，核对内容后使用最新 rev 重试。",
  E_FULL: "记忆空间已满或可用编号已耗尽，因此无法新增；请检查容量，删除不再需要的条目，若编号耗尽则使用新会话。",
  E_TOO_LARGE: "内容超过大小限制，因此未能保存；请缩短内容后重试。",
  E_META_INVALID:
    "请求参数无效：hub 写入只使用 user 权威并须经真人批准；create 不传 id 或 rev（空字符串也不合法），hub 的 topic 须为 1–48 位小写字母、数字或连字符。请检查参数并重试，hub 可省略 authority。",
  E_NOT_FOUND: "没有找到目标，因为 id 不存在或目标已被移除；请先 view 或列出条目，再使用实际 id。",
  E_STALE_SESSION: "操作已失效，因为会话或请求状态发生变化；请在当前会话重新读取目标并发起操作。",
  E_PERSIST: "保存失败，因为存储未能完成写入；请先检查实际内容和存储状态，会话记忆需显式重新打开并核验后再写入。",
  E_PERSIST_UNKNOWN:
    "保存结果无法确定，因为写入后未能确认结果；不要盲目重试，请先检查实际内容，会话记忆需显式重新打开并核验。",
  E_BUSY: "暂时无法操作，因为记忆存储正忙或请求过多；请稍后重试。",
  E_NAMESPACE:
    "Hub 记忆暂不可用，因为其存储身份或安全状态无法确认；请检查 Hub 存储状态，不要直接覆盖或导入，确认后再试。",
  E_WRITE_GATE: "记忆操作被阻止，因为当前环境或会话不允许访问；请检查会话和安全状态，在允许的环境中重试。",
  E_FROM_INVALID: "来源引用无效，因为 from 不符合支持的格式；请省略 from 或使用 session:nN、project:<reference> 格式。",
};

export const scopedFailure = (code: ScopedMemoryErrorCode, message = SCOPED_ERROR_MESSAGES[code]) => ({
  ok: false as const,
  code,
  message,
});

/** Enrich only failures, preserving all existing fields and any more specific message. */
export function withScopedMessage<T>(result: T): T {
  if (result && typeof result === "object" && "ok" in result && result.ok === false && "code" in result) {
    const failure = result as T & { code: ScopedMemoryErrorCode; message?: string };
    return { ...failure, message: failure.message ?? SCOPED_ERROR_MESSAGES[failure.code] };
  }
  return result;
}
