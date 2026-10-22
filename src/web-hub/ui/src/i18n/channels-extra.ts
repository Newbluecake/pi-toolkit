/**
 * `channels` namespace — the LAZY i18n for `ChannelsDialog` (channel-plan §7, CHU). Same posture as
 * `resume-extra.ts`: not under `en/`/`zh/` (the eager glob would fold it into the first-screen
 * bundle); the lazy dialog chunk calls `registerChannelsExtra()` once on mount. Parity: zh
 * `satisfies Record<keyof typeof en, string>` + `tests/web-hub/ui/channels-dialog.test.ts`.
 */
import { MESSAGES } from "./index.js";

const en = {
  dialogTitle: "Cross-session channels",
  close: "Close",
  listAria: "Channels on this hub",
  members: "{n} session(s)",
  empty: "No channels yet — this session has not joined any.",
  pending: "Applying…",
  sent: "Command sent; the list updates when the session reports its new channels.",
  failed: "Failed: {reason}",
  defaultLeaveNote: "Leaving #default stops this session from reaching sessions on the default channel.",
  newLabel: "Create / join a channel",
  newPlaceholder: "channel-name",
  newAction: "Join",
  fullHint: "Up to {n} channels per session — leave one first.",
  hintInvalid: "Use 1–32 lowercase letters, digits, “_” or “-”, starting with a letter or digit.",
  hintReserved: "This name is reserved.",
  hintJoined: "Already joined.",
  hintFull: "Up to {n} channels per session.",
} satisfies Record<string, string>;

const zh: Record<keyof typeof en, string> = {
  dialogTitle: "跨会话频道",
  close: "关闭",
  listAria: "本 hub 上的频道",
  members: "{n} 个会话",
  empty: "暂无频道——本会话尚未加入任何频道。",
  pending: "处理中…",
  sent: "命令已发送；会话上报新的频道后列表会更新。",
  failed: "失败：{reason}",
  defaultLeaveNote: "离开 #default 后，本会话将不再与默认频道会话互通。",
  newLabel: "新建 / 加入频道",
  newPlaceholder: "频道名",
  newAction: "加入",
  fullHint: "每个会话最多加入 {n} 个频道——请先离开一个。",
  hintInvalid: "1–32 位小写字母、数字、“_”或“-”，以字母或数字开头。",
  hintReserved: "该名称为保留名。",
  hintJoined: "已加入。",
  hintFull: "每个会话最多加入 {n} 个频道。",
};

export const CHANNELS_EXTRA: Readonly<Record<"en" | "zh", Readonly<Record<string, string>>>> = { en, zh };

let registered = false;

/** Merge the lazy keys into `MESSAGES.<lang>.channels` (idempotent). */
export function registerChannelsExtra(): void {
  if (registered) return;
  registered = true;
  for (const lang of ["en", "zh"] as const) {
    const dict = MESSAGES[lang]["channels"];
    if (dict === undefined) MESSAGES[lang]["channels"] = { ...CHANNELS_EXTRA[lang] };
    else for (const [k, v] of Object.entries(CHANNELS_EXTRA[lang])) if (!(k in dict)) dict[k] = v;
  }
}
