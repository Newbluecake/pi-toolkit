import type { CmdFrame, DialogsFrame } from "../protocol/messages.js";
export interface DialogBridge {
  frame(): DialogsFrame;
  handle(frame: CmdFrame): void;
  dispose(): void;
}
export function createDialogBridge(): DialogBridge {
  return { frame: () => ({ t: "dialogs", epoch: "", open: [], closed: [] }), handle() {}, dispose() {} };
}
