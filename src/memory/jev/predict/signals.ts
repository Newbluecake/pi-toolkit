// 信号整形（plan.md v3.2 §2.1 / §11.1 signals.ts）：端口原料 → `PredictInput`，
// 含全部数量/长度上限与 `pathClass`。pi-free；无模块级可变状态（I4）。
//
// `/skill:` 展开块剥离复用与 jev/wire.ts 相同的正则（该文件非 pi-free，
// predict/* 不能 import 它，I8），在此独立复制一份，保持字节一致。

import type { PathClass, PredictInput, ToolLite } from "./contracts.js";

const SKILL_BLOCK_RE = /<skill name="[^"]*" location="[^"]*">[\s\S]*?<\/skill>\n*/g;

const MAX_PROMPT_CODEPOINTS = 4000;
const MAX_PREVIOUS_PROMPT_CODEPOINTS = 1000;
const MAX_TODO_SUBJECT_CODEPOINTS = 200;
const MAX_TODO = 12;
const MAX_RECENT_TOOLS = 20;
const MAX_BASH_JOBS = 10;
const MAX_BASH_COMMAND_CODEPOINTS = 500;

/** 去掉 `/skill:` 展开块（与 jev `stripSkillBlocks` 字节一致）。 */
export function stripSkillBlocks(text: string): string {
  return text.replace(SKILL_BLOCK_RE, "");
}

/** 按码点（Unicode 代码点，非 UTF-16 code unit）截断，不切断代理对。 */
export function truncateCodepoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** 夹到 [0, 99] 的整数（§2.1 activeSubagents）。 */
export function clampSubagents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(99, Math.trunc(n)));
}

// ───────────────────────────── pathClass（§2.1 ToolLite.pathClass） ─────────────────────────────

const FIXTURES_RE = /(^|\/)(tests?\/)?__?fixtures?__?(\/|$)|\/fixtures\//i;
const TESTS_RE = /(^|\/)tests?(\/|$)|\.(test|spec)\.[a-z]+$/i;
const DOCS_RE = /(^|\/)docs(\/|$)|\.md$/i;
const CREDENTIALS_RE = /(^|\/)\.env(\.|$)|auth\.json$|\.pem$|id_rsa|(^|\/)secrets?(\/|$)|credentials/i;
const CONFIG_RE = /(^|\/)(settings|\.pi-subagent|pi-toolkit)\.json$|(^|\/)config(\/|$)|\.config\.[a-z]+$/i;
const PKG_RE = /(^|\/)package(-lock)?\.json$|(^|\/)(pnpm|yarn|package)-lock\.\w+$|(^|\/)tsconfig.*\.json$/i;
const SRC_RE = /(^|\/)src(\/|$)/i;

/** 路径 → `PathClass`（signals.ts 独有的本地分类，供 R11/R21/outbound §6.1 用）。
 *  顺序敏感：fixtures 优先于 tests（`tests/fixtures/x` 必须判为 fixtures）。 */
export function classifyPathClass(path: string): PathClass {
  if (FIXTURES_RE.test(path)) return "fixtures";
  if (CREDENTIALS_RE.test(path)) return "credentials";
  if (PKG_RE.test(path)) return "pkg";
  if (CONFIG_RE.test(path)) return "config";
  if (TESTS_RE.test(path)) return "tests";
  if (DOCS_RE.test(path)) return "docs";
  if (SRC_RE.test(path)) return "src";
  return "other";
}

// ───────────────────────────── 原料裁剪（§2.1 上限） ─────────────────────────────

export interface RawTodo {
  readonly id: number;
  readonly subject: string;
  readonly status: "pending" | "in_progress" | "completed" | string;
}

/** ≤12，in_progress 优先（保序：先全部 in_progress 再 pending，各自保持原序），
 *  completed 等其他状态被丢弃；subject 截到 200 码点。 */
export function capTodo(todo: readonly RawTodo[]): readonly PredictInput["todo"][number][] {
  const inProgress = todo.filter((t) => t.status === "in_progress");
  const pending = todo.filter((t) => t.status === "pending");
  return [...inProgress, ...pending].slice(0, MAX_TODO).map((t) => ({
    id: t.id,
    subject: truncateCodepoints(t.subject, MAX_TODO_SUBJECT_CODEPOINTS),
    status: t.status as "pending" | "in_progress",
  }));
}

/** 上一 run 的工具调用，≤20（保留最近的 20 条，保序）。 */
export function capRecentTools(tools: readonly ToolLite[]): readonly ToolLite[] {
  return tools.length <= MAX_RECENT_TOOLS ? tools : tools.slice(tools.length - MAX_RECENT_TOOLS);
}

export interface RawBashJob {
  readonly status: "running" | "done" | "failed" | "other" | string;
  readonly command: string;
}

/** ≤10，command 截到 500 码点；未知 status 归一化为 "other"。 */
export function capBashJobs(jobs: readonly RawBashJob[]): readonly PredictInput["bashJobs"][number][] {
  return jobs.slice(0, MAX_BASH_JOBS).map((j) => ({
    status: j.status === "running" || j.status === "done" || j.status === "failed" ? j.status : "other",
    command: truncateCodepoints(j.command, MAX_BASH_COMMAND_CODEPOINTS),
  }));
}

// ───────────────────────────── 组装（§2.1 PredictInput） ─────────────────────────────

export interface BuildPredictInputRaw {
  readonly prompt: string;
  readonly previousPrompt?: string;
  readonly todo: readonly RawTodo[];
  readonly recentTools: readonly ToolLite[];
  readonly git?: { branch?: string; dirty?: boolean };
  readonly bashJobs: readonly RawBashJob[];
  readonly activeSubagents: number;
  readonly session: "main" | "child";
  readonly carry?: PredictInput["carry"];
}

/** 原料 → `PredictInput`：剥 skill 块、逐字段截断/限额/夹值（§2.1）。 */
export function buildPredictInput(raw: BuildPredictInputRaw): PredictInput {
  const prompt = truncateCodepoints(stripSkillBlocks(raw.prompt), MAX_PROMPT_CODEPOINTS);
  const previousPrompt =
    raw.previousPrompt === undefined
      ? undefined
      : truncateCodepoints(stripSkillBlocks(raw.previousPrompt), MAX_PREVIOUS_PROMPT_CODEPOINTS);
  return {
    prompt,
    ...(previousPrompt === undefined ? {} : { previousPrompt }),
    todo: capTodo(raw.todo),
    recentTools: capRecentTools(raw.recentTools),
    ...(raw.git === undefined ? {} : { git: raw.git }),
    bashJobs: capBashJobs(raw.bashJobs),
    activeSubagents: clampSubagents(raw.activeSubagents),
    session: raw.session,
    ...(raw.carry === undefined ? {} : { carry: raw.carry }),
  };
}
