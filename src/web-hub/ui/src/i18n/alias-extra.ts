/**
 * `alias` namespace — the LAZY i18n for the alias section of `ChannelsDialog`
 * (alias-plan r4 §7.1/§7.2, package ALU). Same posture as `channels-extra.ts` /
 * `resume-extra.ts`: not under `en/`/`zh/` (the eager glob would fold it into the
 * first-screen bundle); the lazy dialog chunk calls `registerAliasExtra()` once on mount.
 * Parity: zh `satisfies Record<keyof typeof en, string>` + tests/web-hub/ui/alias-ui.test.ts.
 *
 * Language split (repo rule): compact markers stay English tokens; only the prose
 * hints/confirm copy is translated.
 */
import { MESSAGES } from "./index.js";

const en = {
  dialogTitle: "Channels & alias",
  sectionTitle: "Session alias",
  sectionAria: "Session alias (hub-unique short name)",
  currentAlias: "Current: @{alias}",
  inputLabel: "Set an alias",
  inputPlaceholder: "e.g. web or 前端",
  save: "Save",
  clear: "Clear",
  take: "Try take",
  saveAria: "Save this alias for the session",
  clearAria: "Clear the session's alias",
  takeAria: "Preview taking over this alias from an offline holder",
  suggestionsAria: "Suggested aliases",
  takenTitle: "May already be taken by another session — the hub decides on save",
  doneFallback: "Command finished; the alias chip updates when the session reports its status.",
  hintInvalid: "ASCII letters/digits, “_”, “-”, CJK, kana or Hangul syllables; must contain a letter.",
  hintTooLong: "Too long — up to 16 graphemes and 48 bytes.",
  hintIdLike: "Looks like a session id — pick a word instead.",
  hintReserved: "This name is reserved.",
  takeConfirmTitle: "Take over alias @{alias}?",
  takeExpires: "token expires in {t}",
  takeExpired: "Expired — run the preview again.",
  takeConfirmRun: "Take",
  previewAria: "Take-over preview returned by the hub",
} satisfies Record<string, string>;

const zh: Record<keyof typeof en, string> = {
  dialogTitle: "频道与别名",
  sectionTitle: "会话别名",
  sectionAria: "会话别名（hub 全局唯一的短称呼）",
  currentAlias: "当前：@{alias}",
  inputLabel: "设置别名",
  inputPlaceholder: "如 web 或 前端",
  save: "保存",
  clear: "清除",
  take: "尝试抢占",
  saveAria: "为本会话保存这个别名",
  clearAria: "清除本会话的别名",
  takeAria: "预览从离线持有者手中抢占这个别名",
  suggestionsAria: "推荐别名",
  takenTitle: "可能已被其他会话占用——以保存时 hub 的判定为准",
  doneFallback: "命令已完成；会话上报状态后别名标签会更新。",
  hintInvalid: "可用 ASCII 字母数字、“_”、“-”、汉字、假名或韩文音节；至少含一个字母。",
  hintTooLong: "太长——最多 16 个字形簇且不超过 48 字节。",
  hintIdLike: "看起来像个 session id——请换一个词。",
  hintReserved: "该名称为保留名。",
  takeConfirmTitle: "抢占别名「@{alias}」？",
  takeExpires: "令牌 {t} 后过期",
  takeExpired: "已过期——请重新预览。",
  takeConfirmRun: "确认抢占",
  previewAria: "hub 返回的抢占预览",
};

export const ALIAS_EXTRA: Readonly<Record<"en" | "zh", Readonly<Record<string, string>>>> = { en, zh };

let registered = false;

/** Merge the lazy keys into `MESSAGES.<lang>.alias` (idempotent). */
export function registerAliasExtra(): void {
  if (registered) return;
  registered = true;
  for (const lang of ["en", "zh"] as const) {
    const dict = MESSAGES[lang]["alias"];
    if (dict === undefined) MESSAGES[lang]["alias"] = { ...ALIAS_EXTRA[lang] };
    else for (const [k, v] of Object.entries(ALIAS_EXTRA[lang])) if (!(k in dict)) dict[k] = v;
  }
}
