/**
 * `dialog` i18n namespace, Chinese (control-plan.md v2.1 §5, §7.6 — C5).
 */
import en from "../en/dialog.js";

type Messages<T> = { [K in keyof T]: string };

const dialog = {
  formAria: "Agent 提问",
  alsoInTerminal: "也可以在终端作答——先答者生效。",
  questionTab: "问题 {n}",
  questionTabAria: "问题 {n}：{header}",
  other: "其它",
  otherAria: "其它——输入你自己的回答",
  otherPlaceholder: "输入你自己的回答…",
  submit: "提交",
  submitAria: "提交答案",
  cancel: "取消",
  cancelConfirm: "确认取消",
  cancelAria: "取消此对话框",
  cancelArmed: "已待确认——再次点击确认取消，Esc 返回",
  suspended: "hub 升级中——请在终端作答；hub 恢复后若仍未作答，此表单会自动恢复。",
  epochChanged: "此表单是在终端重载前打开的——请检查后重新作答。",
  closedTui: "已在终端作答",
  closedWeb: "已在另一个浏览器作答",
  closedHere: "已作答",
  closedAbort: "Agent 已中止",
  closedBackground: "后台任务完成，问题已暂挂，模型会重新提问",
  closedSession: "会话已结束",
  closedError: "对话框因错误关闭",
  cancelledTui: "已在终端取消",
  cancelledWeb: "已在另一个浏览器取消",
  cancelledHere: "已取消",
  closedGeneric: "对话框已关闭",
  // multi-question tabs: an answered tab's ✓ mark is decorative; screen readers get this suffix
  answeredMark: "已回答",
} satisfies Messages<typeof en>;

export default dialog;
