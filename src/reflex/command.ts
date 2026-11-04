/**
 * jev-reflex · `/reflex` command (R0 skeleton). R2b implements `status | explain <text> | reset [id]`
 * (arch §4.11); until then it only confirms the layer is armed.
 */
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

export type ReflexCommandDeps = Record<string, never>;

export function createReflexCommand(_deps: ReflexCommandDeps = {}): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "reflex 状态：/reflex 查看只读自省问题的确定性作答层（骨架）。",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        ctx.ui.notify("reflex: enabled (skeleton)", "info");
      } catch {
        /* best-effort: a command handler never throws past here */
      }
    },
  };
}
