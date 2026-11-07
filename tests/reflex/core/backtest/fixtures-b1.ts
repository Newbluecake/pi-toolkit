/**
 * jev-reflex · #25 B1 shared fixtures: builders for REAL-shaped session jsonl lines (shapes
 * verified against `~/.pi/agent/sessions` — see B1-report §1: envelope `id`/`parentId`/
 * ISO `timestamp`, `{type:"message"}` with `message.role`/`content` parts/`stopReason`,
 * `{type:"custom"}` + `customType`/`data`, fork headers whose `parentSession` is the parent's
 * FILE PATH). Read-only import of B0's `tests/reflex/helpers/turn.ts` constructors.
 */
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import {
  buildFamilyIndex,
  createCorpusBuilder,
  type CorpusBuilder,
} from "../../../../src/reflex/core/backtest/corpus.js";
import type { CorpusFilter, SessionHeaderFact, Turn } from "../../../../src/reflex/core/types.js";

/** Base epoch for post-HUD-gate turns (2026-10-29 — safely after HUD_TUI_GATE_SINCE). */
export const TG = 1_790_000_000_000;
let seq = 0;
/** Unique entry id (8 hex) per call — deterministic-looking, no RNG. */
export function eid(prefix = "e"): string {
  seq += 1;
  return `${prefix}${seq.toString(16).padStart(4, "0")}`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface HeaderSpec {
  id: string;
  file?: string;
  at: number;
  cwd?: string;
  parentSession?: string;
}
export function headerLine(h: HeaderSpec): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: h.id,
    timestamp: iso(h.at),
    cwd: h.cwd ?? "/home/unit/proj",
    ...(h.parentSession !== undefined ? { parentSession: h.parentSession } : {}),
  });
}
export function headerFact(h: HeaderSpec): SessionHeaderFact {
  return {
    file: h.file ?? `/sess/${h.at}_${h.id}.jsonl`,
    id: h.id,
    ...(h.parentSession !== undefined ? { parentSession: h.parentSession } : {}),
    timestamp: h.at,
    cwd: h.cwd ?? "/home/unit/proj",
  };
}

export interface UserSpec {
  id: string;
  parentId?: string;
  at: number;
  text: string;
  images?: number;
}
export function userLine(u: UserSpec): string {
  const content =
    u.images === undefined
      ? [{ type: "text", text: u.text }]
      : [
          { type: "text", text: u.text },
          ...Array.from({ length: u.images }, () => ({ type: "image", mimeType: "image/png", data: "x" })),
        ];
  return JSON.stringify({
    type: "message",
    id: u.id,
    ...(u.parentId !== undefined ? { parentId: u.parentId } : {}),
    timestamp: iso(u.at),
    message: { role: "user", content, timestamp: u.at },
  });
}

export interface ToolCallSpec {
  name: string;
  command?: string;
  action?: string;
}
export interface AssistantSpec {
  id: string;
  parentId?: string;
  at: number;
  stopReason?: string;
  toolCalls?: readonly ToolCallSpec[];
}
export function assistantLine(a: AssistantSpec): string {
  const content = [
    ...(a.toolCalls ?? []).map((c) => ({
      type: "toolCall",
      id: `call_${c.name}`,
      name: c.name,
      ...(c.command !== undefined ? { arguments: { command: c.command } } : {}),
      ...(c.action !== undefined ? { arguments: { action: c.action } } : {}),
    })),
  ];
  return JSON.stringify({
    type: "message",
    id: a.id,
    ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
    timestamp: iso(a.at),
    message: {
      role: "assistant",
      content,
      ...(a.stopReason !== undefined ? { stopReason: a.stopReason } : {}),
      timestamp: a.at,
    },
  });
}

export function toolResultLine(o: { id: string; parentId?: string; at: number; toolName?: string }): string {
  return JSON.stringify({
    type: "message",
    id: o.id,
    ...(o.parentId !== undefined ? { parentId: o.parentId } : {}),
    timestamp: iso(o.at),
    message: {
      role: "toolResult",
      toolCallId: `call_${o.toolName ?? "bash"}`,
      toolName: o.toolName ?? "bash",
      content: [{ type: "text", text: "ok" }],
    },
  });
}

export interface CustomSpec {
  id: string;
  parentId?: string;
  at: number;
  customType: string;
  data?: unknown;
}
export function customLine(c: CustomSpec): string {
  return JSON.stringify({
    type: "custom",
    customType: c.customType,
    ...(c.data !== undefined ? { data: c.data } : {}),
    id: c.id,
    ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
    timestamp: iso(c.at),
  });
}

/** A native `pi-hud-llm-time` entry (data shape irrelevant — only the envelope matters). */
export function hudLine(o: { id: string; parentId?: string; at: number }): string {
  return customLine({
    id: o.id,
    ...(o.parentId !== undefined ? { parentId: o.parentId } : {}),
    at: o.at,
    customType: "pi-hud-llm-time",
    data: { v: 1, ms: 12 },
  });
}

/** A persisted `subagent:reflex-record` (shape per `core/shadow-scan.ts` acceptance). */
export function reflexRecordLine(o: {
  id: string;
  parentId?: string;
  at: number;
  requestDigest: string;
  scriptId?: string;
}): string {
  return customLine({
    id: o.id,
    ...(o.parentId !== undefined ? { parentId: o.parentId } : {}),
    at: o.at,
    customType: "subagent:reflex-record",
    data: {
      v: 1,
      kind: "shadow",
      at: o.at,
      scriptId: o.scriptId ?? "jobs.list",
      scriptVer: 1,
      state: "shadow",
      band: "high",
      requestDigest: o.requestDigest,
      chars: 8,
      model: { agree: "no-tool", tools: [] },
    },
  });
}

/** beginFile + line×N + endFile for one file (header pre-parsed into a fact for the index). */
export function feedFile(
  b: CorpusBuilder,
  h: HeaderSpec,
  lines: readonly string[],
): ReturnType<CorpusBuilder["endFile"]> {
  const r = b.beginFile(h.file ?? `/sess/${h.at}_${h.id}.jsonl`, JSON.parse(headerLine(h)));
  if (r !== "ok") return { turns: [], corrections: [] };
  for (const l of lines) b.line(l);
  return b.endFile();
}

export const ALL_CAPS = new Set(["bashJobs", "fleet", "quota", "git", "sessionDir"] as const);

export function builderFor(headers: readonly HeaderSpec[], filter: CorpusFilter = { since: 0 }): CorpusBuilder {
  return createCorpusBuilder(filter, buildFamilyIndex(headers.map(headerFact)));
}

/** All builtin example hits — handy inputs known to be high in the REAL catalog. */
export function builtinHits(): { scriptId: string; text: string }[] {
  return BUILTIN_SCRIPTS.flatMap((s) => s.intent.examples.hit.map((text) => ({ scriptId: s.id, text })));
}

/** Pick the first turn whose text matches (test-side convenience, exact match). */
export function turnOf(turns: readonly Turn[], text: string): Turn {
  const t = turns.find((x) => x.text === text);
  if (t === undefined) throw new Error(`no turn with text ${JSON.stringify(text)}`);
  return t;
}
