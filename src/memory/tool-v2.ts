// §4 v2 memory tool factory — STUB (todo #22 P0-b's frozen-surface commit;
// real implementation lands in package P2, §14.1). `index.ts` only selects
// this factory when `memory.toolSurface === "v2"`, which defaults to
// `"legacy"` in P0 (§9) — the existing `tool.ts` (unchanged, §2.7 复审 新-3)
// stays the reachable path until P5 flips the default.

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import type { MemoryPaths } from "./paths.js";

export interface MemoryToolV2Deps {
  settings: MemorySettings;
  isChildSession: boolean;
  onAfterWrite: (cwd: string) => void;
  paths?: MemoryPaths;
}

/** Not implemented yet (P2). Reuses `../../src/memory/tool-surface.ts`'s
 *  frozen `MEMORY_TOOL_V2_TEXT` / `MemoryToolParamsV2` for its definition
 *  once built — this stub's `execute` throws so it fails loudly rather than
 *  silently no-opping if it's ever wired ahead of P2. */
export function createMemoryToolV2(_deps: MemoryToolV2Deps): ToolDefinition {
  return {
    name: "memory",
    label: "Memory",
    description: "memory (v2): not implemented yet (todo #22 P2)",
    parameters: { type: "object", properties: {} } as never,
    async execute(
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx?: ExtensionContext,
    ): Promise<never> {
      throw new Error("memory (v2): not implemented yet (todo #22 P2)");
    },
  } as ToolDefinition;
}
