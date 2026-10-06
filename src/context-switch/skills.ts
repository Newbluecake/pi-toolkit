/**
 * context-switch · 「在役 skill」识别（纯域 + 一个真实文件读取的默认实现）。
 *
 * 背景：switch_context 替换历史后，本段上下文里读过的 SKILL.md 正文随之丢失；系统提示里只
 * 永久保留 skill 清单与路径（正文不会回来），新上下文常常忘记重新 read 它们。这里只做
 * **识别**（本段读/改过的 SKILL.md、pi 展开 `/skill:xxx` 生成的消息块、模型自报），渲染成
 * 附录里一行强提示交给 `handoff.ts`——绝不把 SKILL.md 正文搬进交接文本。
 */
import { closeSync, openSync, readSync } from "node:fs";

/** 一条在役 skill 的引用：name 必有，location 缺失时（纯模型自报的名字）附录只显示名字。 */
export interface SkillRef {
  readonly name: string;
  readonly location?: string;
}

/** 附录渲染时的展示上限（超出写"…另 N 个"）。 */
export const MAX_APPENDIX_SKILLS = 8;
/** switch_context `skills` 参数的条目数上限。 */
export const MAX_REPORTED_SKILLS = 8;
/** `skills` 参数单项的字符上限。 */
export const MAX_REPORTED_SKILL_CHARS = 512;
/** 嗅探 SKILL.md frontmatter 时最多读取的字节数（有界，失败静默）。 */
export const MAX_SKILL_SNIFF_BYTES = 8192;

/** 附录里 name 字段的展示上限（超出截断为…）。 */
export const MAX_SKILL_NAME_CHARS = 80;
/** 附录里 location 字段的展示上限（超出截断为…）。 */
export const MAX_SKILL_LOCATION_CHARS = 512;

export type SkillFileReader = (path: string) => string | undefined;

/** 清洗一个待渲染字段：去掉 C0/C1 控制字符（包括 ANSI ESC）、压缩连续空格、截断到上限。
 *  三种来源（文件读取、skill 块头部解析、模型自报）都在归一化处调用它，渲染层（handoff.ts）
 *  拿到的始终是干净文本。 */
function sanitizeSkillField(value: string, maxChars: number): string {
  // 先压缩空白（\s 包含 \t\n\r 等，避免先删字符把两边词连在一起），再删掉剩余的 C0/C1 控制字符
  // （\u0000-\u001F 和 \u007F-\u009F，包括 ESC/\u001B 这类不属于 \s 的控制字）。
  const collapsed = value.replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  const withoutControls = collapsed.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  const chars = [...withoutControls];
  return chars.length <= maxChars ? withoutControls : `${chars.slice(0, maxChars - 1).join("")}…`;
}

/** 对一个 SkillRef 整体应用清洗：name 清洗后为空则丢弃该条（不返回空名字条目）。 */
export function sanitizeSkillRef(ref: SkillRef): SkillRef | undefined {
  const name = sanitizeSkillField(ref.name, MAX_SKILL_NAME_CHARS);
  if (!name) return undefined;
  const location = ref.location !== undefined ? sanitizeSkillField(ref.location, MAX_SKILL_LOCATION_CHARS) : undefined;
  return location ? { name, location } : { name };
}

export function isSkillMdPath(path: string): boolean {
  return typeof path === "string" && (path === "SKILL.md" || path.endsWith("/SKILL.md"));
}

/** 读不到 frontmatter name 时的回退：SKILL.md 的父目录名。 */
function parentDirName(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts[parts.length - 1] === "SKILL.md") parts.pop();
  return parts[parts.length - 1];
}

/** 容忍任意 frontmatter 形状，只取 `name:` 一行；解析失败一律返回 undefined。 */
export function skillNameFromFrontmatter(content: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatter) return undefined;
  const nameLine = /^name:\s*(.+?)\s*$/m.exec(frontmatter[1] ?? "");
  if (!nameLine) return undefined;
  const raw = nameLine[1]?.trim();
  if (!raw) return undefined;
  const unquoted = raw.replace(/^["']|["']$/g, "").trim();
  return unquoted.length > 0 ? unquoted : undefined;
}

/** 真实读取实现：用 openSync/readSync 只读固定大小的头部 buffer（不先读整文件再截断，避免大文件被整文载入
 *  内存），读失败（不存在/权限/IO 错）或文件描述符未打开一律静默返回 undefined，fd 在 finally 里关闭。 */
export function readSkillFileSniffSync(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_SKILL_SNIFF_BYTES);
    const bytesRead = readSync(fd, buffer, 0, MAX_SKILL_SNIFF_BYTES, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort—读失败已经静默降级，关闭失败不应再抛。
      }
    }
  }
}

/** 单个 SKILL.md 路径 → SkillRef：优先 frontmatter name，读不到就用父目录名；都没有则放弃该项。 */
export function skillRefFromSkillMdPath(path: string, readFile: SkillFileReader): SkillRef | undefined {
  if (!isSkillMdPath(path)) return undefined;
  let name: string | undefined;
  try {
    const content = readFile(path);
    if (content) name = skillNameFromFrontmatter(content);
  } catch {
    name = undefined;
  }
  name = name ?? parentDirName(path);
  return name ? sanitizeSkillRef({ name, location: path }) : undefined;
}

/** 来源①：本段读过或改过、路径以 /SKILL.md 结尾的文件。保持首次出现顺序，按路径去重。 */
export function skillRefsFromTouchedPaths(paths: readonly string[], readFile: SkillFileReader): SkillRef[] {
  const seen = new Set<string>();
  const out: SkillRef[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || seen.has(path) || !isSkillMdPath(path)) continue;
    seen.add(path);
    const ref = skillRefFromSkillMdPath(path, readFile);
    if (ref) out.push(ref);
  }
  return out;
}

/** pi 的 `parseSkillBlock` 锚定头部正则（dist/bundle/chunks/chunk-ZSBPJAJ2.js）：
 *  `^<skill name="([^"]+)" location="([^"]+)">`。我们只解析开头标签取 name/location，
 *  不要求整条消息都匹配（正文、后续用户追问都不关心），也不搬正文。 */
const SKILL_BLOCK_HEADER = /^<skill name="([^"]+)" location="([^"]+)">/;

/** 来源②：pi 展开 `/skill:xxx` 生成的 user 消息块头部。畸形/非该格式的文本一律返回 undefined。 */
export function skillRefFromExpandedBlockText(text: string): SkillRef | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const match = SKILL_BLOCK_HEADER.exec(text);
  if (!match) return undefined;
  const name = match[1];
  const location = match[2];
  if (!name) return undefined;
  return sanitizeSkillRef(location ? { name, location } : { name });
}

/** 从一条消息的 content（string 或 TextContent[] 形状）里拼出纯文本，宽容任意形状。 */
function textOfMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? (block as { text?: unknown }).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return "";
}

/** 最小结构：role/content 俱可选，宽容 AgentMessage 与 branch 条目两种输入形状。 */
export interface UserMessageLike {
  role?: unknown;
  content?: unknown;
}

/** 来源②的入口：从一组消息（pi `AgentMessage[]` 或等价结构）里扫 user 消息的 skill 块头部。 */
export function skillRefsFromUserMessages(messages: readonly UserMessageLike[]): SkillRef[] {
  const out: SkillRef[] = [];
  for (const message of messages ?? []) {
    if (!message || message.role !== "user") continue;
    const ref = skillRefFromExpandedBlockText(textOfMessageContent(message.content));
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * 来源③：switch_context 的 `skills` 参数（模型自报）。有界校验：最多
 * `MAX_REPORTED_SKILLS` 项，每项截断到 `MAX_REPORTED_SKILL_CHARS` 字符。
 * 以 `/SKILL.md` 结尾的项尝试读取 frontmatter 取 name；否则直接当作 skill 名。
 */
export function normalizeReportedSkills(input: unknown, readFile: SkillFileReader): SkillRef[] {
  if (!Array.isArray(input)) return [];
  const out: SkillRef[] = [];
  for (const raw of input.slice(0, MAX_REPORTED_SKILLS)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().slice(0, MAX_REPORTED_SKILL_CHARS);
    if (!trimmed) continue;
    if (isSkillMdPath(trimmed)) {
      const ref = skillRefFromSkillMdPath(trimmed, readFile);
      if (ref) out.push(ref);
    } else {
      const ref = sanitizeSkillRef({ name: trimmed });
      if (ref) out.push(ref);
    }
  }
  return out;
}

/** 合并多来源，按 name 去重（保留首次出现），不设上限——展示上限由渲染层（handoff.ts）处理。 */
export function mergeSkillRefs(...lists: readonly (readonly SkillRef[])[]): SkillRef[] {
  const seen = new Set<string>();
  const out: SkillRef[] = [];
  for (const list of lists) {
    for (const ref of list ?? []) {
      if (!ref || !ref.name || seen.has(ref.name)) continue;
      seen.add(ref.name);
      out.push(ref);
    }
  }
  return out;
}
