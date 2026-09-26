/**
 * Child-session assembly (child-context-switch plan.md §2, package P3).
 *
 * Single pre-guard entry point called from `src/index.ts` when `isChildSession` — mirrors
 * `src/bash/child.ts`'s own convention (registered once per `activate()`, everything lazy,
 * no dependency on `session_start` — plan §0 fact 3 / §2 device diagram). Composes the two
 * child-session features and wires the one cross-cutting signal between them: a committed
 * boundary-draft switch rewrites the child session's context exactly like a compaction does,
 * so the keepalive service must invalidate on it too (plan §2.4).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import { wireChildContextSwitch } from "../context-switch/child.js";
import { wireChildKeepalive } from "../cache-ttl/child.js";

export function wireChildSession(pi: ExtensionAPI, settings: AgentSettings): void {
  const keepalive = wireChildKeepalive(pi, settings);
  wireChildContextSwitch(pi, settings, {
    onSwitchCommitted: () => keepalive?.noteContextSwitch(),
  });
}
