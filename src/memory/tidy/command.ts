// §7 `/mem tidy` / `/mem restore` command dispatch — STUB (todo #22 P0-b's
// frozen-surface commit; real implementation lands in package P4, §14.1).
// The gate itself (main session + UI required; no attached spawn port ⇒
// "tidy unavailable in this session") is real, per-plan behavior — it isn't
// deferred to P4, it's part of the assembly skeleton this commit delivers.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TidyPort } from "../contracts.js";
import type { MemoryPaths } from "../paths.js";

export interface TidyCommandDeps {
  paths?: MemoryPaths;
  isChildSession: boolean;
  getTidyPort: () => TidyPort | undefined;
}

/**
 * `/mem tidy [--dry-run|--frontmatter] [file…]` / `/mem restore [--trash] [<id>]`.
 * Real gating (§7's "仅主会话且 ctx.hasUI"; "未注入 ⇒ tidy unavailable in
 * this session"), then throws — P4 fills in the actual proposal/apply flow.
 * The throw flows through `command.ts`'s existing try/catch → warning notify.
 */
export async function handleMemTidyCommand(
  kind: "tidy" | "restore",
  _args: string,
  ctx: ExtensionCommandContext,
  deps: TidyCommandDeps,
): Promise<void> {
  if (deps.isChildSession || !ctx.hasUI) {
    if (ctx.hasUI) ctx.ui.notify(`/mem ${kind} is only available in the main session`, "warning");
    return;
  }
  const port = deps.getTidyPort();
  if (!port) {
    ctx.ui.notify("tidy unavailable in this session", "warning");
    return;
  }
  throw new Error(`/mem ${kind}: not implemented yet (todo #22 P4)`);
}
