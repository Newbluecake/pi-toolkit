/**
 * context-switch · 纯域（无 pi import）：交接内容的校验、渲染与机械附录拼装。
 *
 * 语义：模型调用 `switch_context` 时，把"要带到下一段上下文里的状态"直接写进参数；
 * 这段文本随后经 `session_before_compact` 回传给 pi 作为压缩条目的 summary
 * （见 docs/dev/context-switch/context-switch-plan.md §0/§2），因此它就是压缩后的上下文本身，
 * 不再有第二次 LLM 摘要来补救——校验必须在这里把"敷衍的交接"挡住。
 */

/** 模型撰写的交接内容（工具参数的纯数据投影）。 */
export interface HandoffInput {
  goal: string;
  progress: string;
  next_steps: string;
  decisions?: string;
  key_files?: readonly string[];
  pitfalls?: string;
  open_questions?: string;
}

/** 三个必填字段合计的最小字符数（码点计）。低于此值一律判为敷衍。 */
export const MIN_CORE_HANDOFF_CHARS = 120;
/** 单个 key_files 条目上限（字符）。 */
export const MAX_KEY_FILE_CHARS = 300;
/** key_files 条目数上限。 */
export const MAX_KEY_FILES = 40;
/** 模型撰写部分的总长上限（字符）：超出截断，避免交接文本本身撑爆新上下文。 */
export const MAX_HANDOFF_CHARS = 24_000;

export type HandoffValidation = { ok: true; value: HandoffInput } | { ok: false; reason: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function countChars(value: string): number {
  // 码点计数：中文交接文本按字符算，不因 UTF-16 代理对虚高。
  return [...value].length;
}

function clip(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * 校验模型给出的交接内容。失败时返回可直接回给模型的中文原因（告诉它缺什么、怎么补）。
 */
export function validateHandoff(input: unknown): HandoffValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "参数必须是对象，且至少包含 goal / progress / next_steps 三个字段。" };
  }
  const raw = input as Record<string, unknown>;
  const goal = text(raw.goal);
  const progress = text(raw.progress);
  const nextSteps = text(raw.next_steps);
  const missing: string[] = [];
  if (!goal) missing.push("goal（当前总目标 + 用户原始诉求要点）");
  if (!progress) missing.push("progress（已完成什么、现在停在哪）");
  if (!nextSteps) missing.push("next_steps（下一步有序计划）");
  if (missing.length > 0) {
    return { ok: false, reason: `缺少必填字段：${missing.join("、")}。这些内容丢了就再也找不回来，请补齐后重新调用。` };
  }
  const core = countChars(goal) + countChars(progress) + countChars(nextSteps);
  if (core < MIN_CORE_HANDOFF_CHARS) {
    return {
      ok: false,
      reason:
        `交接内容过于简略（goal + progress + next_steps 合计 ${core} 字，至少 ${MIN_CORE_HANDOFF_CHARS} 字）。` +
        "这段文本会直接取代当前上下文——请写清目标、已完成的事、下一步、关键文件与已定决策。",
    };
  }
  const keyFilesRaw = raw.key_files;
  let keyFiles: string[] | undefined;
  if (keyFilesRaw !== undefined) {
    if (!Array.isArray(keyFilesRaw)) return { ok: false, reason: "key_files 必须是字符串数组。" };
    keyFiles = keyFilesRaw
      .map((entry) => clip(text(entry), MAX_KEY_FILE_CHARS))
      .filter((entry) => entry.length > 0)
      .slice(0, MAX_KEY_FILES);
  }
  const decisions = text(raw.decisions);
  const pitfalls = text(raw.pitfalls);
  const openQuestions = text(raw.open_questions);
  return {
    ok: true,
    value: {
      goal,
      progress,
      next_steps: nextSteps,
      ...(decisions ? { decisions } : {}),
      ...(keyFiles && keyFiles.length > 0 ? { key_files: keyFiles } : {}),
      ...(pitfalls ? { pitfalls } : {}),
      ...(openQuestions ? { open_questions: openQuestions } : {}),
    },
  };
}

/** 机械附录：模型最容易漏、而扩展能确定性提供的事实。 */
export interface HandoffAppendix {
  /** 上一段会话文件路径（可回读原文）。 */
  sessionFile?: string;
  /** 压缩前上下文 token 数。 */
  tokensBefore?: number;
  /** 本段内被改写过的文件。 */
  modifiedFiles?: readonly string[];
  /** 只读过、未改动的文件。 */
  readFiles?: readonly string[];
  /** 未终结的 subagent run（"label(status)" 形式）。 */
  runs?: readonly string[];
  /** 仍在跑的后台 bash job。 */
  bashJobs?: readonly string[];
  /** 未完成的 todo。 */
  todos?: readonly string[];
  /** 是否丢弃了压缩点之前的全部消息（keep_recent=false）。 */
  droppedEverything?: boolean;
}

/** 文件清单上限，避免附录喧宾夺主。 */
export const MAX_APPENDIX_FILES = 25;

function bulletList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const body = shown.map((item) => `  - ${item}`).join("\n");
  return rest > 0 ? `${body}\n  - …另有 ${rest} 项` : body;
}

/** 从 pi 的 `CompactionPreparation.fileOps`（Set 三元组）提取读/改文件清单，宽容任意形状。 */
export function fileListsFromFileOps(fileOps: unknown): { modifiedFiles: string[]; readFiles: string[] } {
  const ops = (fileOps ?? {}) as { read?: unknown; written?: unknown; edited?: unknown };
  const toArray = (value: unknown): string[] =>
    value instanceof Set
      ? [...value].filter((entry): entry is string => typeof entry === "string")
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
  const modified = new Set([...toArray(ops.written), ...toArray(ops.edited)]);
  const read = toArray(ops.read).filter((path) => !modified.has(path));
  return { modifiedFiles: [...modified], readFiles: read };
}

/** child-context-switch §2.1: pi 的 `extractFileOpsFromMessage` 不在顶层导出中（只有
 *  `FileOperations` 类型被导出，函数本身没有），子会话 boundary 模式没有 `CompactionPreparation`
 *  可用，只能自己扫 branch。启发式扫描：只识别 assistant 消息中名叫
 *  read/write/edit/multi_edit 的 tool call，从其 `arguments.path`（或 `file_path`/`filePath`）取
 *  路径。未知工具名不记入任何清单（宁可漏，不可造假）。 */
export const CHILD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "multi_edit", "multiedit"]);
export const CHILD_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["read"]);

interface BranchMessageLike {
  type?: unknown;
  message?: { role?: unknown; content?: readonly unknown[] };
}

function toolCallPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const candidate = obj.path ?? obj.file_path ?? obj.filePath;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * 从已持久化的分支条目中扫【fromIndex, toIndex】（闭区间，包含两端）里的 assistant 工具调用，
 * 提取读/改文件清单。与 `fileListsFromFileOps` 同形状返回值，供 `boundary.ts` 拼 appendix 时直接复用。
 */
export function fileListsFromBranch(
  branch: readonly BranchMessageLike[],
  fromIndex: number,
  toIndex: number,
): { modifiedFiles: string[]; readFiles: string[] } {
  const written = new Set<string>();
  const read = new Set<string>();
  const start = Math.max(0, fromIndex);
  const end = Math.min(branch.length - 1, toIndex);
  for (let i = start; i <= end; i++) {
    const entry = branch[i];
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
      const path = toolCallPathArg(call.arguments);
      if (!path) continue;
      const name = call.name.toLowerCase();
      if (CHILD_WRITE_TOOL_NAMES.has(name)) written.add(path);
      else if (CHILD_READ_TOOL_NAMES.has(name)) read.add(path);
    }
  }
  const readOnly = [...read].filter((path) => !written.has(path));
  return { modifiedFiles: [...written], readFiles: readOnly };
}

export function renderAppendix(appendix: HandoffAppendix): string {
  const lines: string[] = [];
  if (appendix.sessionFile) {
    lines.push(`- 上一段会话文件：${appendix.sessionFile}（需要原文细节时直接 read/grep 该 jsonl）`);
  }
  if (appendix.tokensBefore != null && Number.isFinite(appendix.tokensBefore) && appendix.tokensBefore > 0) {
    lines.push(`- 切换前上下文规模：约 ${Math.round(appendix.tokensBefore / 1000)}k tokens`);
  }
  if (appendix.modifiedFiles && appendix.modifiedFiles.length > 0) {
    lines.push(`- 本段改写过的文件：\n${bulletList(appendix.modifiedFiles, MAX_APPENDIX_FILES)}`);
  }
  if (appendix.readFiles && appendix.readFiles.length > 0) {
    lines.push(`- 本段读过（未改）的文件：\n${bulletList(appendix.readFiles, MAX_APPENDIX_FILES)}`);
  }
  if (appendix.runs && appendix.runs.length > 0) {
    lines.push(`- 仍在运行的 subagent：\n${bulletList(appendix.runs, MAX_APPENDIX_FILES)}`);
  }
  if (appendix.bashJobs && appendix.bashJobs.length > 0) {
    lines.push(`- 仍在运行的后台 bash 任务：\n${bulletList(appendix.bashJobs, MAX_APPENDIX_FILES)}`);
  }
  if (appendix.todos && appendix.todos.length > 0) {
    lines.push(`- 未完成的 todo：\n${bulletList(appendix.todos, MAX_APPENDIX_FILES)}`);
  }
  if (lines.length === 0) return "";
  return ["## 机械附录（pi-toolkit 自动补齐，非模型撰写）", ...lines].join("\n");
}

/** 渲染模型撰写的交接正文（不含附录），即 switch_context 的核心产物。 */
export function renderHandoffCore(input: HandoffInput): string {
  const sections: string[] = [
    "# 上下文交接（switch_context）",
    "",
    "以下内容是上一段上下文结束时**你自己写下**的交接状态，它已取代被丢弃的历史消息。" +
      "请把它当作唯一可靠的事实来源继续工作；细节不足时读取下方列出的文件或上一段会话文件，不要凭空假设。",
    "",
    "## 当前目标",
    input.goal,
    "",
    "## 进展",
    input.progress,
    "",
    "## 下一步",
    input.next_steps,
  ];
  if (input.decisions) sections.push("", "## 已定决策与约束", input.decisions);
  if (input.key_files && input.key_files.length > 0) {
    sections.push("", "## 关键文件", input.key_files.map((entry) => `- ${entry}`).join("\n"));
  }
  if (input.pitfalls) sections.push("", "## 已知坑 / 失败过的尝试", input.pitfalls);
  if (input.open_questions) sections.push("", "## 未决问题", input.open_questions);
  return clip(sections.join("\n"), MAX_HANDOFF_CHARS);
}

/** 正文 + 附录，最终写入 pi 压缩条目的 summary。 */
export function composeHandoff(core: string, appendix: HandoffAppendix): string {
  const rendered = renderAppendix(appendix);
  const tail = appendix.droppedEverything
    ? "\n\n> 注意：本次切换丢弃了压缩点之前的**全部**消息，除上文外没有其他上下文。"
    : "";
  return rendered ? `${core}\n\n---\n\n${rendered}${tail}` : `${core}${tail}`;
}
