import type { CmdFrame, CmdResultFrame } from "../protocol/messages.js";
export interface CommandHandler {
  handle(frame: CmdFrame): void;
  dispose(): void;
}
export interface CommandHandlerDeps {
  send(frame: CmdResultFrame): void;
}
export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  return {
    handle(frame) {
      deps.send({
        t: "cmd_result",
        rid: frame.rid,
        id: frame.id,
        ok: false,
        code: "E_UNSUPPORTED",
        retryable: false,
        effect: "none",
      });
    },
    dispose() {},
  };
}
