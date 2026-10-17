/**
 * `resume` 命名空间的中文副本（web-resume plan v2 §2.6，包 P3）——仅常驻键：头部「恢复」
 * 按钮（D7）与命令面板描述，二者都在弹窗懒加载块首次挂载前渲染。弹窗自身的文案在
 * `i18n/resume-extra.ts`（懒块挂载时注册进 `MESSAGES.*.resume`——首屏 255 KiB 预算没有
 * 余量容纳整份 ~30 键字典，见 logic/resume.ts 头注）。中英键集/占位符由
 * `tests/web-hub/ui/i18n-parity.test.ts`（eager glob 收本文件）与
 * `tests/web-hub/ui/resume-logic.test.ts`（懒半边）钉住。
 */
import type en from "../en/resume.js";

const resume = {
  openTitle: "恢复会话",
  openLabel: "恢复",
  paletteDesc: "恢复会话（在本进程内切换）",
} satisfies Record<keyof typeof en, string>;

export default resume;
