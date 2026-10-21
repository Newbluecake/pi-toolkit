/**
 * `/mem init` — create a `core.md` skeleton for a project whose memory has
 * no primary core (doctor D01's "no primary at all" warn, the state that
 * triggers the `startupReminderText` "no core.md" notice).
 *
 * Write path reuses the SAME primitives the v2 memory tool's `create` op
 * uses (`tool-v2.ts`'s `doCreate`): `ensureMemoryDir` + `canonicalDir`
 * (same slug-dir canonicalization/permissions), `withMemoryDirLock` for
 * lock-serialized mutation, and `writeTempRegular` + `createExclusive` for
 * the atomic no-clobber create. Reads never take the lock (lock.ts).
 *
 * Provenance decision: the skeleton carries NO `source:` field. Agent tool
 * writes stamp `source: agent`; everything else is user-authored
 * (`frontmatterSource(content) !== "agent"` in `tool-v2.ts`'s
 * `isHandWritten`). `/mem init` is an explicit USER command, so the file is
 * user-authored: the memory tool can still edit its body (with the usual
 * "user-authored" warning) but cannot overwrite/delete it wholesale or
 * touch its frontmatter — the skeleton the user filled in is protected.
 *
 * Refusal wording deliberately mirrors D01's own fix text (doctor.ts), so
 * the command and the doctor always point at the same remedy.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { DEFAULT_SETTINGS, type MemorySettings } from "../config/settings.js";
import type { MemoryMeta } from "./contracts.js";
import { withMemoryDirLock } from "./lock.js";
import { parseMemoryMeta } from "./meta.js";
import { memoryDirFor, MemoryError, type MemoryPaths } from "./paths.js";
import {
  canonicalDir,
  createExclusive,
  ensureMemoryDir,
  listRegular,
  readRegular,
  statRegularIfExists,
  writeTempRegular,
} from "./safe-fs.js";

const CORE_NAME = "core.md";

export type MemInitOutcome =
  | { kind: "created"; path: string; topicFiles: number }
  | { kind: "exists"; path: string }
  | { kind: "archived"; path: string }
  | { kind: "pinStandin"; name: string };

export interface MemInitDeps {
  paths?: MemoryPaths;
  isChildSession: boolean;
  /** Defaults to `DEFAULT_SETTINGS.memory` (same convention as tidy). */
  settings?: MemorySettings;
  /** Post-write injection-block invalidation (wireMemory's onAfterWrite). */
  onAfterWrite?: (cwd: string) => void;
  /** Doctor summary trailer appended to the success notice. */
  doctorSummary?: (cwd: string) => string;
  now?: () => Date;
}

/** Small skeleton — frontmatter mirrors what a healthy primary core carries
 *  (pin + description + topic + status + updated all keep D01/D06/D07/D08
 *  silent); the body stays well under the default 1600B core budget so the
 *  freshly created file itself triggers no doctor finding. `updated` is
 *  stamped by the caller (test-injectable clock). */
export function coreSkeleton(nowIso: string): string {
  return `---
pin: true
description: 每轮必需的项目规则与用户偏好
topic: core
status: active
updated: ${nowIso}
---

# 核心规则（每轮）

<!-- 只放每轮都必须遵守的规则；话题细节放单独文件，并在此留 \`→ 文件名\` 指针 -->
<!-- 例：- 提交前先跑测试；不要手改生成目录（如 dist/） -->

- （在此写下第一条每轮必需的规则）
`;
}

/** Pure-ish core of `/mem init` (single lock round; the body is synchronous
 *  as `withMemoryDirLock` requires). Exported for tests; the command handler
 *  below owns all user-facing text. */
export async function runMemInit(cwd: string, deps: MemInitDeps): Promise<MemInitOutcome> {
  const display = memoryDirFor(cwd, deps.paths);
  ensureMemoryDir(display);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
  const real = canon.real;
  const path = `${display}/${CORE_NAME}`;
  return withMemoryDirLock(real, () => {
    const existing = statRegularIfExists(real, CORE_NAME);
    if (existing) {
      const { text } = readRegular(real, CORE_NAME);
      const { meta } = parseMemoryMeta(text, "core");
      if (meta.status === "archived") return { kind: "archived", path };
      return { kind: "exists", path };
    }
    const metas: { name: string; meta: MemoryMeta | undefined }[] = listRegular(real, { names: "v2" }).files.map(
      (f) => {
        try {
          return {
            name: f.name,
            meta: parseMemoryMeta(readRegular(real, f.name).text, f.name.replace(/\.md$/, "")).meta,
          };
        } catch {
          return { name: f.name, meta: undefined }; // raced delete — skip, never fatal
        }
      },
    );
    const standin = metas
      .filter((f) => f.meta?.pin === true && f.meta.status !== "archived")
      .map((f) => f.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
    if (standin !== undefined) return { kind: "pinStandin", name: standin };
    const topicFiles = metas.filter((f) => f.meta !== undefined && !f.meta.pin && f.meta.status !== "archived").length;
    const nowIso = (deps.now?.() ?? new Date()).toISOString();
    const tmp = writeTempRegular(real, CORE_NAME, Buffer.from(coreSkeleton(nowIso), "utf8"), 0o600);
    createExclusive(real, tmp, CORE_NAME);
    return { kind: "created", path, topicFiles };
  });
}

export async function handleMemInitCommand(ctx: ExtensionCommandContext, deps: MemInitDeps): Promise<void> {
  const settings = deps.settings ?? DEFAULT_SETTINGS.memory;
  // Child sessions are read-only for memory by default — same rule the
  // memory TOOL's write gate (`assertWritable` in tool-v2.ts) uses, since
  // init performs exactly that class of write. (tidy/restore refuse child
  // sessions outright because they also need the main session's spawn port;
  // import predates the gate and is an unaddressed inconsistency.)
  if (deps.isChildSession && !settings.allowWriteInChildSessions) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "child sessions are read-only for memory by default; enable memory.allowWriteInChildSessions to allow writes",
        "warning",
      );
    }
    return;
  }
  const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
  const outcome = await runMemInit(cwd, deps);
  if (!ctx.hasUI) return;
  switch (outcome.kind) {
    case "exists":
      ctx.ui.notify(`core.md 已存在，无需初始化。\n${outcome.path}`, "info");
      return;
    case "archived":
      // D01's archived fix: "Set core.md back to status: active, or …"
      ctx.ui.notify(
        `未创建：core.md 已存在但处于归档状态（status: archived）——把它改回 status: active 即可（详见 /mem doctor）。`,
        "warning",
      );
      return;
    case "pinStandin":
      // D01's degraded-primary fix: "Rename it to core.md, or run /mem tidy to migrate."
      ctx.ui.notify(
        `未创建：「${outcome.name}」（pin: true）正在充当主核——把它改名为 core.md，或运行 /mem tidy 迁移。`,
        "warning",
      );
      return;
    case "created": {
      deps.onAfterWrite?.(cwd);
      const lines = [
        `已创建 core.md 骨架：${outcome.path}`,
        "编辑它，把每轮必须遵守的规则填进去；话题细节另建文件并在此留指针。",
      ];
      if (outcome.topicFiles > 0) {
        lines.push(
          `已有 ${outcome.topicFiles} 个话题文件：可把其中每轮都要遵守的规则移进 core.md（也可以让 agent 代为整理）`,
        );
      }
      if (deps.doctorSummary) lines.push(deps.doctorSummary(cwd));
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }
  }
}
