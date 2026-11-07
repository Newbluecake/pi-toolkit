// 唯一外发 DTO（plan.md v3.2 §6.1）——P 层发给预测模型的全部内容，纯模块、
// pi-free、无模块级可变状态（I4）。
//
// 纪律：
//  · 严格 allowlist——DTO 只从 `PredictInput`+`ruleGuess` 投影白名单字段
//    （todo 的 id、session、carry 等一律丢弃）；`serializePredictOutbound`
//    对任何外来 DTO 再投影一次，未知键/越限值进不来也出不去。
//  · 永不外发：记忆正文、会话 system prompt、助手消息与推理、工具结果、
//    文件路径、命令参数、URL、todo description、子会话内容。request/
//    previous_request 是脱敏+截断后的用户 prompt 本身（模型要读的就是它）；
//    命令只经 shapeOf 变成 `program [subcommand]`，路径只映射为 path_class。
//  · 码点限额由 redactForJev 的 TRUNCATION 表（P1b 已就位的 5 个 predict
//    字段）负责；字节限额在此二次裁剪，全部按 Unicode 码点切，绝不切断
//    多字节字符。序列化总量 ≤6144B，超出按 §6.1 顺序裁剪：
//    previous_request → recent_tools 尾部 → todo 尾部 → request 尾部截断。

import { Buffer } from "node:buffer";
import { redactForJev } from "../redact.js";
import type { PathClass, PredictInput, ToolLite } from "./contracts.js";
import { clampSubagents } from "./signals.js";
import { shapeOf, SUBCOMMAND_ENUMS } from "./shape.js";

// ───────────────────────────── 限额常量（§6.1） ─────────────────────────────

export const OUTBOUND_MAX_TOTAL_BYTES = 6144;
const MAX_REQUEST_BYTES = 3_000;
const MAX_PREV_BYTES = 900;
const MAX_TODO = 8;
const MAX_TODO_SUBJECT_BYTES = 240;
const MAX_TOOLS = 12;
const MAX_JOBS = 5;
const MAX_RULE_GUESS = 6;
const MAX_TAG_DESC_BYTES = 480;

const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const BRANCH_RE = /^[\w./-]{1,40}$/;
const TAG_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
// 与 shape.ts 的 PROGRAM_RE/SCRIPT_RE 同口径（该文件不导出私有正则，此处
// 独立镜像；shapeOf 的输出必过其一）。
const SHAPE_PROGRAM_RE = /^[a-z0-9._-]{1,24}$/;
const SHAPE_SCRIPT_RE = /^[\w.-]{1,40}\.sh$/;

const PATH_CLASSES: ReadonlySet<string> = new Set([
  "src",
  "tests",
  "fixtures",
  "docs",
  "config",
  "credentials",
  "pkg",
  "other",
]);
const TODO_STATUSES: ReadonlySet<string> = new Set(["in_progress", "pending"]);
const JOB_STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed", "other"]);

// ───────────────────────────── DTO 形状（§6.1 逐字） ─────────────────────────────

export interface OutboundTodoItem {
  readonly status: "in_progress" | "pending";
  readonly subject: string;
}

export interface OutboundToolItem {
  readonly tool: string;
  readonly shape?: string;
  readonly path_class?: PathClass;
  readonly error?: true;
  readonly n?: number;
}

export interface OutboundJobItem {
  readonly shape: string;
  readonly status: string;
}

export interface OutboundWorkspace {
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly jobs: readonly OutboundJobItem[];
  readonly subagents: number;
}

export interface OutboundRuleGuess {
  readonly tag: string;
  readonly score: number;
}

export interface PredictOutboundV1 {
  readonly v: 1;
  readonly request: string;
  readonly previous_request?: string;
  readonly todo: readonly OutboundTodoItem[];
  readonly recent_tools: readonly OutboundToolItem[];
  readonly workspace: OutboundWorkspace;
  readonly rule_guess: readonly OutboundRuleGuess[];
}

// ───────────────────────────── 字节级裁剪（不切断 UTF-8） ─────────────────────────────

/** 按码点二分取 UTF-8 ≤maxBytes 的最长前缀——从不在多字节字符中间切断。 */
function clipToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(chars.slice(0, mid).join(""), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, Math.max(0, lo)).join("");
}

// ───────────────────────────── 逐字段净化（build 与外来 DTO 共用） ─────────────────────────────

function sanitizeRequest(prompt: string): string {
  return clipToBytes(redactForJev(prompt, "predictRequest"), MAX_REQUEST_BYTES);
}

function sanitizePrevious(prev: string | undefined): string | undefined {
  if (prev === undefined) return undefined;
  const out = clipToBytes(redactForJev(prev, "predictPrev"), MAX_PREV_BYTES);
  return out === "" ? undefined : out; // 脱敏后为空 ⇒ 无信号，省字节
}

function sanitizeTodoItem(raw: { status: unknown; subject: unknown }): OutboundTodoItem | undefined {
  if (typeof raw.status !== "string" || !TODO_STATUSES.has(raw.status)) return undefined;
  if (typeof raw.subject !== "string") return undefined;
  return {
    status: raw.status as "in_progress" | "pending",
    subject: clipToBytes(redactForJev(raw.subject, "todo"), MAX_TODO_SUBJECT_BYTES),
  };
}

function sanitizeTodoList(items: readonly unknown[]): readonly OutboundTodoItem[] {
  const out: OutboundTodoItem[] = [];
  for (const raw of items) {
    if (out.length >= MAX_TODO) break;
    if (!isPlainishObject(raw)) continue; // null/非对象元素不得抛，跳过
    const sanitized = sanitizeTodoItem(raw as { status: unknown; subject: unknown });
    if (sanitized !== undefined) out.push(sanitized);
  }
  return out;
}

// ───────────────────── 原型键防御（P2 验收小项） ─────────────────────

/** 原型污染向键名：出现在 tool/shape/tag 等字符串槽位时按省略/`other` 降级，
 *  绝不原样外发（Object.hasOwn/Map 之外的字符串槽位同理过滤）。 */
const FORBIDDEN_PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** 元素级防御：null/非对象（含字符串/数字等原始值）不是可净化条目，整体跳过。 */
function isPlainishObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeToolName(tool: string): string {
  if (FORBIDDEN_PROTO_KEYS.has(tool)) return "other";
  return TOOL_RE.test(tool) ? tool : "other";
}

/** recent_tools.shape 防御性校验：只接受 §6.1 shape 表能产生的值（单 token
 *  程序/脚本名，或枚举程序 + 枚举内子命令）。任何带参数/URL/路径的值都被
 *  丢弃（字段整体省略），绝不外发。 */
function sanitizeShape(shape: string | undefined): string | undefined {
  if (typeof shape !== "string") return undefined;
  const tokens = shape.split(" ");
  if (tokens.length === 1) {
    const token = tokens[0]!;
    if (FORBIDDEN_PROTO_KEYS.has(token)) return undefined;
    return token === "other" || SHAPE_PROGRAM_RE.test(token) || SHAPE_SCRIPT_RE.test(token) ? token : undefined;
  }
  if (tokens.length !== 2) return undefined;
  const [program, sub] = tokens as [string, string];
  const enums = SUBCOMMAND_ENUMS[program];
  if (enums === undefined || !SHAPE_PROGRAM_RE.test(program)) return undefined;
  return enums.has(sub) ? shape : undefined;
}

/** 三元组（tool, shape, path_class）合并计数（§6.1）：取最近 ≤12 条，按首现
 *  顺序归并；`n` 为合并条数（=1 时省略），任一条出错 ⇒ `error:true`。 */
function sanitizeToolList(tools: readonly unknown[]): readonly OutboundToolItem[] {
  const recent = tools.slice(Math.max(0, tools.length - MAX_TOOLS));
  const merged: OutboundToolItem[] = [];
  const index = new Map<string, number>();
  for (const raw of recent) {
    if (!isPlainishObject(raw)) continue; // null/非对象元素不得抛，跳过
    const t = raw as { tool?: unknown; shape?: unknown; pathClass?: unknown; isError?: unknown };
    const tool = sanitizeToolName(typeof t.tool === "string" ? t.tool : "");
    const shape = sanitizeShape(typeof t.shape === "string" ? t.shape : undefined);
    const pathClass =
      typeof t.pathClass === "string" && PATH_CLASSES.has(t.pathClass) ? (t.pathClass as PathClass) : undefined;
    const key = `${tool}\u0000${shape ?? ""}\u0000${pathClass ?? ""}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, merged.length);
      merged.push({
        tool,
        ...(shape === undefined ? {} : { shape }),
        ...(pathClass === undefined ? {} : { path_class: pathClass }),
        ...(t.isError === true ? { error: true as const } : {}),
      });
      continue;
    }
    const prev = merged[at]!;
    const count = (prev.n ?? 1) + 1;
    merged[at] = {
      ...prev,
      ...(t.isError === true ? { error: true as const } : {}),
      n: count,
    };
  }
  return merged;
}

function sanitizeBranch(branch: string | undefined): string | undefined {
  if (typeof branch !== "string" || branch === "") return undefined;
  const redacted = redactForJev(branch, "branch");
  return BRANCH_RE.test(redacted) ? redacted : "other";
}

function sanitizeJobStatus(status: unknown): string {
  return typeof status === "string" && JOB_STATUSES.has(status) ? status : "other";
}

/** workspace.jobs：≤5 项 `{shape, status}`——shape 由 shapeOf 从命令本地
 *  归纳（参数/URL/路径永不出命令），status 归一到四值。 */
function sanitizeJobsFromCommands(jobs: readonly unknown[]): readonly OutboundJobItem[] {
  return jobs
    .filter(isPlainishObject)
    .slice(0, MAX_JOBS)
    .map((j) => ({
      shape: shapeOf(typeof j.command === "string" ? j.command : ""),
      status: sanitizeJobStatus(j.status),
    }));
}

function sanitizeJobsFromItems(jobs: readonly unknown[]): readonly OutboundJobItem[] {
  return jobs
    .filter(isPlainishObject)
    .slice(0, MAX_JOBS)
    .map((j) => ({
      shape:
        sanitizeShape(typeof j.shape === "string" && !FORBIDDEN_PROTO_KEYS.has(j.shape) ? j.shape : undefined) ??
        "other",
      status: sanitizeJobStatus(j.status),
    }));
}

function sanitizeRuleGuess(guesses: readonly unknown[]): readonly OutboundRuleGuess[] {
  const out: OutboundRuleGuess[] = [];
  for (const raw of guesses) {
    if (out.length >= MAX_RULE_GUESS) break;
    if (!isPlainishObject(raw)) continue; // null/非对象元素不得抛，跳过
    const g = raw as { tag?: unknown; score?: unknown };
    if (typeof g.tag !== "string" || FORBIDDEN_PROTO_KEYS.has(g.tag) || !TAG_ID_RE.test(g.tag)) continue;
    const score = typeof g.score === "number" && Number.isFinite(g.score) ? g.score : 0;
    out.push({ tag: g.tag, score: Math.round(Math.min(1, Math.max(0, score)) * 10) / 10 });
  }
  return out;
}

/** 用户 tag 描述（进 system prompt，§6.1 其他字段）：redact(tagDesc)（≤160
 *  码点）→ 去换行 → ≤480B。预置描述不经此函数（原样使用）。 */
export function sanitizeTagDesc(desc: string): string {
  return clipToBytes(redactForJev(desc, "tagDesc").replace(/\r?\n/g, " "), MAX_TAG_DESC_BYTES);
}

// ───────────────────────────── 组装与序列化 ─────────────────────────────

interface OutboundParts {
  readonly request: string;
  readonly previousRequest?: string;
  readonly todo: readonly OutboundTodoItem[];
  readonly tools: readonly OutboundToolItem[];
  readonly workspace: OutboundWorkspace;
  readonly ruleGuess: readonly OutboundRuleGuess[];
}

/** 固定键序组装（§6.1 字段顺序）——序列化的确定性由此保证（cache 的
 *  turnKey 直接哈希序列化字节）。 */
function assemble(parts: OutboundParts): PredictOutboundV1 {
  return {
    v: 1,
    request: parts.request,
    ...(parts.previousRequest === undefined ? {} : { previous_request: parts.previousRequest }),
    todo: parts.todo,
    recent_tools: parts.tools,
    workspace: parts.workspace,
    rule_guess: parts.ruleGuess,
  };
}

// ───────────────────────────── 总量裁剪（§6.1 顺序） ─────────────────────────────

function withoutPreviousRequest(dto: PredictOutboundV1): PredictOutboundV1 {
  return {
    v: dto.v,
    request: dto.request,
    todo: dto.todo,
    recent_tools: dto.recent_tools,
    workspace: dto.workspace,
    rule_guess: dto.rule_guess,
  };
}

/** 序列化 ≤maxBytes（默认 6144B）。裁剪顺序：previous_request → recent_tools
 *  尾部 → todo 尾部 → request 尾部截断（按码点切，不切断 UTF-8）。其余字段
 *  数量/尺寸有硬上限，永远不会轮到它们。纯函数，返回新对象。 */
export function fitOutboundBudget(
  dto: PredictOutboundV1,
  maxBytes: number = OUTBOUND_MAX_TOTAL_BYTES,
): PredictOutboundV1 {
  let cur = dto;
  while (Buffer.byteLength(JSON.stringify(cur), "utf8") > maxBytes) {
    if (cur.previous_request !== undefined) {
      cur = withoutPreviousRequest(cur);
      continue;
    }
    if (cur.recent_tools.length > 0) {
      cur = { ...cur, recent_tools: cur.recent_tools.slice(0, -1) };
      continue;
    }
    if (cur.todo.length > 0) {
      cur = { ...cur, todo: cur.todo.slice(0, -1) };
      continue;
    }
    const over = Buffer.byteLength(JSON.stringify(cur), "utf8") - maxBytes;
    const requestBytes = Buffer.byteLength(cur.request, "utf8");
    if (requestBytes === 0) break; // 已无可裁内容（理论到不了：其余字段有硬上限）
    const clipped = clipToBytes(cur.request, Math.max(0, requestBytes - over));
    if (clipped === cur.request) break; // 无进展保护
    cur = { ...cur, request: clipped };
  }
  return cur;
}

// ───────────────────────────── 对外入口 ─────────────────────────────

export interface PredictOutboundExtras {
  /** 最终修饰后的规则结果（tally 输出；score 已含 §4.2 修饰）。 */
  readonly ruleGuess: readonly { readonly tag: string; readonly score: number }[];
}

/** `PredictInput` + 规则结果 → 严格 allowlist 的 PredictOutboundV1（§6.1）。
 *  输入里的 id/session/carry 等非白名单字段（以及运行时多塞的任何属性）在
 *  投影中丢弃。 */
export function buildPredictOutbound(input: PredictInput, extras: PredictOutboundExtras): PredictOutboundV1 {
  const branch = sanitizeBranch(input.git?.branch);
  const previousRequest = sanitizePrevious(input.previousPrompt);
  const parts: OutboundParts = {
    request: sanitizeRequest(input.prompt),
    ...(previousRequest === undefined ? {} : { previousRequest }),
    todo: sanitizeTodoList(input.todo),
    tools: sanitizeToolList(input.recentTools),
    workspace: {
      ...(branch === undefined ? {} : { branch }),
      ...(typeof input.git?.dirty === "boolean" ? { dirty: input.git.dirty } : {}),
      jobs: sanitizeJobsFromCommands(input.bashJobs),
      subagents: clampSubagents(input.activeSubagents),
    },
    ruleGuess: sanitizeRuleGuess(extras.ruleGuess),
  };
  return fitOutboundBudget(assemble(parts));
}

/** 外来 DTO → 规范 DTO 的确定性再投影（逐字段重新过净化与限额），随后按
 *  6144B 预算裁剪、JSON.stringify。同一 DTO round-trip 后字节不变（cache
 *  turnKey 依赖此性质）。 */
export function serializePredictOutbound(dto: PredictOutboundV1): string {
  const branch = sanitizeBranch(typeof dto.workspace?.branch === "string" ? dto.workspace.branch : undefined);
  const previousRequest = sanitizePrevious(typeof dto.previous_request === "string" ? dto.previous_request : undefined);
  const projected = assemble({
    request: sanitizeRequest(typeof dto.request === "string" ? dto.request : ""),
    ...(previousRequest === undefined ? {} : { previousRequest }),
    todo: sanitizeTodoList(Array.isArray(dto.todo) ? dto.todo : []),
    tools: sanitizeToolList(Array.isArray(dto.recent_tools) ? dto.recent_tools : []),
    workspace: {
      ...(branch === undefined ? {} : { branch }),
      ...(typeof dto.workspace?.dirty === "boolean" ? { dirty: dto.workspace.dirty } : {}),
      jobs: sanitizeJobsFromItems(Array.isArray(dto.workspace?.jobs) ? dto.workspace.jobs : []),
      subagents: clampSubagents(typeof dto.workspace?.subagents === "number" ? dto.workspace.subagents : 0),
    },
    ruleGuess: sanitizeRuleGuess(Array.isArray(dto.rule_guess) ? dto.rule_guess : []),
  });
  return JSON.stringify(fitOutboundBudget(projected));
}
