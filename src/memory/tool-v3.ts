/**
 * `memory` tool v3 — the blocks-layout surface (#36 arch r5 §4.1).
 * `createMemoryToolV3(deps)` builds the ToolDefinition registered when
 * `toolSurfaceFor` says "v3" (layout:blocks + a blocks/absent/auto-migrating
 * directory — src/memory/index.ts). Five commands, whole-block semantics:
 *
 *  - view [path|topic] — budget + topic table (no path), a topic's blocks,
 *    or one block with its full header (rev/CAS metadata included);
 *  - search query — reuses search.ts over active blocks;
 *  - create topic text — parses the first-line `<!-- mem … -->` write syntax
 *    (§4.1.4), allocates the next seq IN the memDir directory lock;
 *  - update path rev text — CAS whole-block replace (inherit + override
 *    metadata merge; nothing a caller omits is ever downgraded);
 *  - delete path [rev] — soft-delete into `blocks/.trash/`.
 *
 * Removed v2 commands never translate implicitly; `normalize-v3.ts` gives
 * them the curated E_UNSUPPORTED_COMMAND message and logs `unsupported:<cmd>`
 * to the diag ring (execute-level only — the host's schema validation
 * rejects unknown `command` values before this point; root 2026-11-06).
 *
 * #26 (no-user-guard-confirm): rewriting/deleting a user rule, an explicit
 * `mem lesson` demotion, or the MODEL demoting global→topic all write
 * through directly — `voided user rule:` echo (anchor = block id), one
 * non-blocking TUI warning, CAS/abort checkpoints, NO confirm. CREATING a
 * user rule is not in the #26 domain (nothing is voided).
 *
 * I1/I4/I5: no timers of its own (the jev write port owns its abort timer);
 * all mutable state lives in this factory's closure; no module state.
 */

import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "../config/settings.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { withMemoryDirLock } from "./lock.js";
import { normalizeV3, type NormalizedV3Call, type RawV3Params, type V3Command } from "./normalize-v3.js";
import { MemoryError, memoryDirFor, toSlug, type MemoryPaths } from "./paths.js";
import { searchMemory } from "./search.js";
import {
  canonicalDir,
  createExclusive,
  ensureMemoryDir,
  ensurePrivateDir,
  readRegular,
  writeTempRegular,
} from "./safe-fs.js";
import { plainMemoryWriteGate } from "./blocks/migrate.js";
import {
  BLOCK_BODY_MAX_BYTES,
  bodyBytes,
  isExpired,
  isResident,
  parseBlockFile,
  type BlockMeta,
  type ParsedBlock,
} from "./blocks/format.js";
import { canonicalTopic, dirFormat, parseBlockName } from "./blocks/naming.js";
import {
  createBlockLocked,
  readCorpus,
  replaceBlockLocked,
  topicSummary,
  trashBlockLocked,
  type BlockCorpus,
} from "./blocks/store.js";
import { INDEX_MAX_BYTES, renderBlocks, residentBlocksOf, residentMeteredBytes } from "./blocks/render.js";
import { injectionSentinel } from "./render.js";
import { parseInlineMeta, stripInlineMeta } from "./jev/entries.js";
import { readIndex } from "./jev/index-store.js";
import { appendDiagLine } from "./jev/diag-log.js";
import {
  formatV3AudienceHint,
  formatV3BudgetLine,
  formatV3CreatedLine,
  formatV3DeletedLine,
  formatV3IgnoredLine,
  formatV3ResidentLine,
  formatV3ResidentOverBudget,
  formatV3StateSnapshotLine,
  formatV3UpdatedLine,
} from "./jev/format.js";
import { looksLikeStateSnapshot, stateSnapshotKinds } from "./govern/snapshot.js";
import type { MemoryWriteGate } from "./contracts.js";
import type { JevIndexV1, JevWritePort } from "./jev/contracts.js";
import { concatGuardSignals, registryOf } from "./tool-v2.js";
import { MEMORY_TOOL_V3_TEXT, MEMORY_TOOL_V3_TEXT_JEV, MemoryToolParamsV3 } from "./tool-surface.js";

export interface MemoryToolV3Deps {
  settings: MemorySettings;
  isChildSession: boolean;
  onAfterWrite: (cwd: string, origin?: string) => void;
  paths?: MemoryPaths;
  /** arch §4.7 — checked inside the lock before every write op (the store's
   *  per-op `checkWrite` re-checks each fs step too). */
  writeGate?: MemoryWriteGate;
  /** `/mem doctor` summary for the view listing footer (best effort). */
  doctorSummary?: (cwd: string) => string;
  /** Jev write port — present ⇒ tagging/scope/relation echoes after a
   *  committed write (arch §4.4). Absent ⇒ none of it, byte-stable (I9). */
  jev?: JevWritePort;
  /** #26 session lifecycle signal — concatenated with the tool signal as the
   *  abort checkpoint for user-rule-touching writes (same rule as v2). */
  sessionSignal?: () => AbortSignal | undefined;
}

type ToolTextResult = {
  content: { type: "text"; text: string }[];
  details: undefined;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
};

/** normalizeV3 notes as a trailing line (v2-era field leftovers). */
function withNotes(t: string, notes: readonly string[]): string {
  return notes.length === 0 ? t : `${t}\nnote: ${notes.join("; ")}`;
}

function text(t: string, usage?: ToolTextResult["usage"]): ToolTextResult {
  return usage === undefined
    ? { content: [{ type: "text" as const, text: t }], details: undefined }
    : { content: [{ type: "text" as const, text: t }], details: undefined, usage };
}

function resolveCwd(ctx: ExtensionContext | undefined): string {
  const raw = ctx?.cwd ?? process.cwd();
  return resolveWorktreeOrigin(raw) ?? raw;
}

function localToday(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const READ_ONLY: ReadonlySet<V3Command> = new Set(["view", "search"]);

/** #36 P4 修复轮（§6.1 的 P4 接线）：确定性主会话线索 —— 正文点名主会话
 *  专属机制（显式 audience 未写时）。P6b 的 tag 推导上线后替换/增强此表；
 *  在此之前只有这些高置信词触发，宁缺毋滥。 */
const AUDIENCE_MAIN_HINTS: readonly { readonly re: RegExp; readonly evidence: string }[] = [
  { re: /主会话/, evidence: "主会话" },
  { re: /\bdispatch\b|派单|派发/i, evidence: "dispatch" },
  { re: /\bask_user\b/, evidence: "ask_user" },
  { re: /\bTUI\b/, evidence: "TUI" },
];

function audienceEvidenceOf(body: string): string | undefined {
  for (const hint of AUDIENCE_MAIN_HINTS) {
    if (hint.re.test(body)) return hint.evidence;
  }
  return undefined;
}
const BLOCK_ID_STEM_RE = /^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}$/;

/** #26 abort checkpoint — a write must not touch disk once its commit signal
 *  fired (e.g. while waiting for the lock). */
function assertNotAborted(signal: AbortSignal | undefined, id: string): void {
  if (signal !== undefined && signal.aborted) throw new MemoryError(`${id}: aborted before commit; block unchanged`);
}

/** The write syntax's parsed view (§4.1.4). `errors` are parseInlineMeta's —
 *  they reject the write (same policy as v2's checkInline refusal). */
interface WriteMeta {
  authority?: "user" | "lesson";
  scope?: "global" | "topic";
  audience?: "all" | "main" | "child";
  expires?: string;
  clearExpires?: true;
  until?: string;
  clearUntil?: true;
  tagsAdd?: readonly string[];
  tagsRemove?: readonly string[];
  isPrivate?: boolean;
  title?: string;
  when?: string;
  supersedes?: readonly string[];
  ignored: readonly string[];
  errors: readonly string[];
}

function parseWriteMeta(rawText: string): { meta: WriteMeta; body: string } {
  const firstLine = rawText.split("\n", 1)[0] ?? "";
  const { meta, errors, ignored } = parseInlineMeta(firstLine, { lenientServerOwned: true });
  const body = stripInlineMeta(rawText);
  const out: WriteMeta = {
    ignored,
    errors,
    ...(meta.authority === undefined ? {} : { authority: meta.authority }),
    ...(meta.scope === undefined ? {} : { scope: meta.scope }),
    ...(meta.audience === undefined ? {} : { audience: meta.audience }),
    ...(meta.expires === undefined ? {} : { expires: meta.expires }),
    ...(meta.clearExpires === undefined ? {} : { clearExpires: meta.clearExpires }),
    ...(meta.until === undefined ? {} : { until: meta.until }),
    ...(meta.clearUntil === undefined ? {} : { clearUntil: meta.clearUntil }),
    ...(meta.tagsAdd === undefined ? {} : { tagsAdd: meta.tagsAdd }),
    ...(meta.tagsRemove === undefined ? {} : { tagsRemove: meta.tagsRemove }),
    ...(meta.isPrivate === undefined ? {} : { isPrivate: meta.isPrivate }),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.when === undefined ? {} : { when: meta.when }),
    // P5a 交接（root 2026-11-06）：`supersedes=<id>` 是写入时输入指令，P4 只
    //  解析不执行。P5a 接手执行链：读旧块当前 rev → 锁内七条件复核（含
    //  oldRev CAS、residue 豁免不适用显式指令）→ 单边写 supersededBy →
    //  `superseded:`/`note:` 回显（含新块不继承 global 的提示）→ 恢复入口
    //  /mem restore --block。在此之前该字段随本对象一起丢弃，绝不落盘。
    ...(meta.supersedes === undefined ? {} : { supersedes: meta.supersedes }),
  };
  return { meta: out, body };
}

/** Resolve the accepted §4.1.1 path shapes to a block id stem
 *  (`quota.007` / `quota.007.md` / `/memories/quota.007.md`). */
/** #36 P4 修复轮：checkInline 的冻结签名按 v2 严格校验（服务端键=unknown
 *  key）。v3 的语义是「服务端键一律忽略」——对原始 content 调 checkInline
 *  前，把 parseWriteMeta 报告为 ignored 的键从首行注释里外科式摘除，其余
 *  校验（bad expires、真未知键）原样保留。 */
function stripServerOwnedTokens(rawText: string, ignored: readonly string[]): string {
  if (ignored.length === 0) return rawText;
  let out = rawText;
  for (const key of ignored) {
    out = out.replace(new RegExp(`[ \t]${key}(?:="[^"]*"|=\S+)?`), "");
  }
  return out;
}

function resolveBlockId(target: string): string {
  let s = target;
  if (s.startsWith("/memories/")) s = s.slice("/memories/".length);
  else if (s.startsWith("memories/")) s = s.slice("memories/".length);
  if (s.endsWith(".md")) s = s.slice(0, -3);
  if (s.includes("/") || !BLOCK_ID_STEM_RE.test(s)) {
    throw new MemoryError(
      `E_BAD_PATH: ${JSON.stringify(target)} is not a block id — use <topic>.<seq> (e.g. quota.007), quota.007.md or /memories/quota.007.md`,
    );
  }
  return s;
}

/** view's topic form: a bare topic name (optionally `.md`). */
function resolveTopicName(target: string): string | undefined {
  let s = target;
  if (s.startsWith("/memories/")) s = s.slice("/memories/".length);
  if (s.endsWith(".md")) s = s.slice(0, -3);
  return canonicalTopic(s);
}

function readBlock(realDir: string, id: string): ParsedBlock {
  const name = `${id}.md`;
  const { text: raw } = readRegular(realDir, name);
  const parsed = parseBlockFile(name, raw);
  if ("stray" in parsed) throw new MemoryError(`E_BAD_PATH: ${name} is not a well-formed block`);
  return parsed;
}

function readBlockIfExists(realDir: string, id: string): ParsedBlock | undefined {
  try {
    return readBlock(realDir, id);
  } catch (err) {
    if (err instanceof MemoryError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The create-time BlockMeta (§4.1.4 — only EXPLICIT keys are set; nothing
 *  is ever auto-promoted: no scope ⇒ topic default, no authority ⇒ agent). */
function metaForCreate(w: WriteMeta): Omit<BlockMeta, "created" | "updated" | "version" | "status" | "kind"> {
  const authority: "user" | "agent" = w.authority === "user" ? "user" : "agent";
  const tags =
    w.tagsAdd === undefined && w.tagsRemove === undefined
      ? undefined
      : { add: [...(w.tagsAdd ?? [])], remove: [...(w.tagsRemove ?? [])] };
  return {
    authority,
    ...(authority === "user" && w.scope !== undefined ? { scope: w.scope } : {}),
    ...(w.audience === undefined ? {} : { audience: w.audience }),
    ...(w.expires === undefined ? {} : { expires: w.expires }),
    ...(w.until === undefined ? {} : { until: w.until }),
    ...(tags === undefined ? {} : { tags }),
    ...(w.isPrivate === true ? { private: true as const } : {}),
    ...(w.title === undefined ? {} : { title: w.title }),
    ...(w.when === undefined ? {} : { when: w.when }),
  };
}

/** The update merge = inherit + override (§4.1.4): an omitted key inherits
 *  the old value — a whole-block rewrite that drops the comment must not
 *  silently demote authority or scope. `expires=none`/`until=none` clear.
 *  `scope=` on an (explicitly demoted) agent block is dropped (server rule:
 *  scope is user-only). */
function mergeMeta(current: BlockMeta, w: WriteMeta): BlockMeta {
  const authority: "user" | "agent" =
    w.authority === undefined ? current.authority : w.authority === "user" ? "user" : "agent";
  const add = new Set([...(current.tags?.add ?? []), ...(w.tagsAdd ?? [])]);
  const remove = new Set([...(current.tags?.remove ?? []), ...(w.tagsRemove ?? [])]);
  for (const r of remove) add.delete(r);
  const next: BlockMeta = {
    ...current,
    authority,
    ...(w.isPrivate === true || current.private === true ? { private: true as const } : {}),
  };
  delete next.private;
  if (w.isPrivate === true || current.private === true) next.private = true;
  const title = w.title ?? current.title;
  delete next.title;
  if (title !== undefined) next.title = title;
  const when = w.when ?? current.when;
  delete next.when;
  if (when !== undefined) next.when = when;
  if (authority === "user") {
    const scope = w.scope ?? (current.authority === "user" ? current.scope : undefined);
    delete next.scope;
    if (scope !== undefined) next.scope = scope;
  } else {
    delete next.scope;
  }
  const audience = w.audience ?? current.audience;
  delete next.audience;
  if (audience !== undefined) next.audience = audience;
  delete next.expires;
  const expires = w.clearExpires === true ? undefined : (w.expires ?? current.expires);
  if (expires !== undefined) next.expires = expires;
  delete next.until;
  const until = w.clearUntil === true ? undefined : (w.until ?? current.until);
  if (until !== undefined) next.until = until;
  delete next.tags;
  if (add.size > 0 || remove.size > 0) next.tags = { add: [...add], remove: [...remove] };
  return next;
}

/** #26 判定域 (arch §4.1.4): user-block rewrite/delete, explicit `mem
 *  lesson` demotion, model-driven global→topic. */
function userRuleChange(
  current: ParsedBlock,
  nextMeta: BlockMeta | undefined,
): { voided: string; notifyKind: "edit" | "delete" | "demote-scope" } | undefined {
  const wasUser = current.meta.authority === "user";
  if (!wasUser) return undefined;
  if (nextMeta === undefined) return { voided: `voided user rule: ${current.id}`, notifyKind: "delete" };
  if (nextMeta.authority !== "user") {
    return { voided: `voided user rule: ${current.id} (demoted to agent)`, notifyKind: "edit" };
  }
  if (current.meta.scope === "global" && nextMeta.scope !== "global") {
    return { voided: `voided user rule: ${current.id} (global → topic)`, notifyKind: "demote-scope" };
  }
  return { voided: `voided user rule: ${current.id}`, notifyKind: "edit" };
}

/** #26: the one-line TUI warning after a committed user-rule change (main
 *  session + UI only; every mode still sees the `voided user rule:` echo). */
function notifyUserRuleChange(
  ctx: ExtensionContext | undefined,
  isChildSession: boolean,
  id: string,
  change: { notifyKind: "edit" | "delete" | "demote-scope" } | undefined,
): void {
  if (change === undefined) return;
  if (isChildSession || ctx?.hasUI !== true) return;
  const ui = ctx?.ui as { notify?: unknown } | undefined;
  if (typeof ui?.notify !== "function") return;
  const message =
    change.notifyKind === "delete"
      ? `agent 删除了用户令 ${id}（块已移入 .trash，可用 /mem restore --trash 找回）`
      : change.notifyKind === "demote-scope"
        ? `agent 把用户令 ${id} 从 global 降为 topic（已直接写入，未经确认）`
        : `agent 改动了用户令 ${id}（已直接写入，未经确认）`;
  try {
    (ui.notify as (message: string, level?: "info" | "warning" | "error") => void)(message, "warning");
  } catch {
    // never fail a committed write on a notify error
  }
}

// ───────────────────── view rendering (§4.1.2) ─────────────────────

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}k`;
}

/** Bytes of the rendered index part (guide → just before the sentinel) —
 *  measured from the SAME renderer the prompt uses, so the budget line and
 *  the injected block cannot drift apart. */
function indexBytesUsed(
  corpus: BlockCorpus,
  slug: string,
  settings: MemorySettings,
  today: string,
  isChild: boolean,
): number {
  const result = renderBlocks(corpus, { slug, isChild, residentBytes: settings.residentBytes, today });
  const sentinel = injectionSentinel(slug);
  // The index part is located by its guide line's stable prefix (render.ts
  // keeps INDEX_GUIDE module-local; the `Topics (` prefix is its frozen
  // first word — arch §3.3.3's render contract).
  const from = result.text.search(/^Topics \(/m);
  if (from < 0) return 0;
  const to = result.text.lastIndexOf(sentinel);
  const part = to > from ? result.text.slice(from, to) : result.text.slice(from);
  return Buffer.byteLength(part.replace(/\s+$/, ""), "utf8");
}

function residentBudget(
  corpus: BlockCorpus,
  settings: MemorySettings,
  today: string,
): { used: number; max: number; over: boolean } {
  const resident = residentBlocksOf(corpus.blocks, { isChild: false, today });
  const used = residentMeteredBytes(resident, today);
  return { used, max: settings.residentBytes, over: used > settings.residentBytes };
}

function blockHeader(b: ParsedBlock, today: string, full: boolean): string {
  const parts = [`#### ${b.id} · rev ${b.rev} · ${b.meta.authority}`];
  if (b.meta.authority === "user" && b.meta.scope === "global") parts.push(" · global");
  if (b.meta.audience !== undefined && b.meta.audience !== "all") parts.push(` · audience ${b.meta.audience}`);
  if (b.meta.expires !== undefined) parts.push(` · expires ${b.meta.expires}`);
  if (isExpired(b.meta, today)) parts.push(" · expired");
  if (b.meta.until !== undefined) parts.push(` · until ${JSON.stringify(b.meta.until)}`);
  if (full) {
    parts.push(` · created ${b.meta.created.slice(0, 10)}`);
    parts.push(` · updated ${b.meta.updated.slice(0, 10)}`);
    if (b.meta.supersededBy !== undefined) parts.push(` · superseded by ${b.meta.supersededBy}`);
    if (b.meta.private === true) parts.push(" · private");
  }
  return parts.join("");
}

function renderTopicView(corpus: BlockCorpus, jevIndex: JevIndexV1 | undefined, topic: string, today: string): string {
  const all = corpus.blocks.filter((b) => b.topic === topic);
  if (all.length === 0) {
    throw new MemoryError(`E_NOT_FOUND: no blocks under topic ${JSON.stringify(topic)} — view (no path) lists topics`);
  }
  const active = all.filter((b) => b.meta.status === "active");
  const superseded = all.filter((b) => b.meta.status === "superseded");
  const lines: string[] = [];
  const summary = topicSummary(corpus, jevIndex, topic);
  lines.push(`topic ${topic}${summary === "" ? "" : ` — ${summary}`}`);
  const sections = new Map<string, ParsedBlock[]>();
  for (const b of active) {
    const key = b.meta.section ?? "";
    const list = sections.get(key) ?? [];
    list.push(b);
    sections.set(key, list);
  }
  for (const [section, blocks] of sections) {
    if (section !== "") lines.push(`## ${section}`);
    for (const b of blocks) lines.push(blockHeader(b, today, false), b.body);
  }
  for (const b of superseded) lines.push(`#### ${b.id} · superseded by ${b.meta.supersededBy ?? "?"} (not injected)`);
  const archived = corpus.archivedByTopic.get(topic) ?? 0;
  if (archived > 0) lines.push(`archived: ${archived}`);
  return lines.join("\n");
}

interface TopicStat {
  active: number;
  decisions: number;
  global: number;
  expired: number;
  superseded: number;
}

function renderListing(cwd: string, corpus: BlockCorpus, deps: MemoryToolV3Deps, today: string): string {
  const jevIndex = (() => {
    try {
      return readIndex(memoryDirFor(cwd, deps.paths)).index;
    } catch {
      return undefined;
    }
  })();
  const active = corpus.blocks.filter((b) => b.meta.status === "active");
  const topics = new Map<string, TopicStat>();
  for (const b of corpus.blocks) {
    const stat: TopicStat = topics.get(b.topic) ?? { active: 0, decisions: 0, global: 0, expired: 0, superseded: 0 };
    if (b.meta.status === "active") stat.active += 1;
    if (b.meta.status === "active" && b.meta.authority === "user" && (b.meta.scope ?? "topic") === "topic")
      stat.decisions += 1;
    if (isResident(b.meta)) stat.global += 1;
    if (isExpired(b.meta, today)) stat.expired += 1;
    if (b.meta.status === "superseded") stat.superseded += 1;
    topics.set(b.topic, stat);
  }
  const budget = residentBudget(corpus, deps.settings, today);
  const indexUsed = indexBytesUsed(corpus, toSlug(cwd), deps.settings, today, deps.isChildSession);
  const global = [...topics.values()].reduce((s, t) => s + t.global, 0);
  const lines: string[] = [
    `topics: ${topics.size} · blocks: ${active.length} · global: ${global}`,
    `resident ${kb(budget.used)}/${kb(budget.max)} · index ${kb(indexUsed)}/${kb(INDEX_MAX_BYTES)}`,
  ];
  const ordered = [...topics.entries()].sort(
    (a, b) => b[1].active - a[1].active || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  for (const [topic, stat] of ordered) {
    const summary = topicSummary(corpus, jevIndex, topic);
    let line = `- ${topic}${summary === "" ? "" : ` — ${summary}`}`;
    line += ` · ${stat.active} blocks`;
    if (stat.decisions > 0) line += ` · ${stat.decisions} decisions`;
    if (stat.global > 0) line += ` · ${stat.global} global`;
    if (stat.expired > 0) line += ` · ${stat.expired} expired`;
    if (stat.superseded > 0) line += ` · ${stat.superseded} superseded`;
    const archived = corpus.archivedByTopic.get(topic) ?? 0;
    if (archived > 0) line += ` · ${archived} archived`;
    lines.push(line);
  }
  if (deps.doctorSummary !== undefined) {
    try {
      lines.push(deps.doctorSummary(cwd));
    } catch {
      // best effort footer only
    }
  }
  return lines.join("\n");
}

// ───────────────────── write echo composition (§4.1.5) ─────────────────────

interface WriteFinish {
  head: string;
  corpus: BlockCorpus;
  authority: "user" | "agent";
  hasExpiry: boolean;
  ignoredLine: string;
  voidedLine: string | undefined;
  /** #36 P4 修复轮（§4.1.5 行表）：写的是 global 块 ⇒ resident: 行（不限超
   *  预算）；超预算时由 over-budget 变体覆盖。 */
  isGlobalWrite: boolean;
  /** normalizeV3 notes（v2 残留字段提示）——回显在 head 之后。 */
  notes: readonly string[];
  /** §6.1 audience 建议的确定性证据（无显式 audience 且正文点名主会话类
   *  信号时）；P6b 的 tag 推导上线后可替换该启发式。 */
  audienceEvidence: string | undefined;
}

/** Compose the §4.1.5 echo: head → budget → jev block (section/jev/scope/
 *  relation suggestions) → state snapshot → resident-over → ignored →
 *  voided. The jev block is absent without a port (I9). */
async function finishWrite(
  cwd: string,
  deps: MemoryToolV3Deps,
  ctx: ExtensionContext | undefined,
  signal: AbortSignal | undefined,
  out: WriteFinish,
  block: { id: string; rev: string; authority: "user" | "agent"; scopeExplicit: boolean },
  beforeRaw: string | undefined,
  afterRaw: string,
): Promise<ToolTextResult> {
  const today = localToday();
  const parts: string[] = [out.head];
  if (out.notes.length > 0) parts.push(`note: ${out.notes.join("; ")}`);
  const budget = residentBudget(out.corpus, deps.settings, today);
  const indexUsed = indexBytesUsed(out.corpus, toSlug(cwd), deps.settings, today, deps.isChildSession);
  parts.push(formatV3BudgetLine(budget.used, budget.max, indexUsed, INDEX_MAX_BYTES));
  let usage: ToolTextResult["usage"];
  if (deps.jev !== undefined) {
    try {
      const result = await deps.jev.afterWrite({
        cwd,
        file: `${block.id}.md`,
        before: beforeRaw,
        after: afterRaw,
        ...(signal === undefined ? {} : { signal }),
        registry: registryOf(ctx),
        block,
        // arch §4.4: askScope = user ∧ no explicit scope ∧ jev wired (the
        // port's off/partial early-returns suppress g1 naturally).
        ...(block.authority === "user" && !block.scopeExplicit ? { askScope: true } : {}),
      });
      if (result.echo.length > 0) parts.push(result.echo.join("\n"));
      if (result.usage !== undefined && result.usage.calls > 0) {
        usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.usage.costUsd },
        };
      }
    } catch {
      // afterWrite never rejects (frozen contract) — belt and braces
    }
  }
  // §5.3 state-snapshot advice: agent blocks only (never user rules), with
  // or without jev — the detector is deterministic and the write already
  // succeeded (advice, never a block).
  const parsed = parseBlockFile(`${block.id}.md`, afterRaw);
  if (out.authority === "agent" && !out.hasExpiry && !("stray" in parsed) && looksLikeStateSnapshot(parsed.body)) {
    parts.push(formatV3StateSnapshotLine(stateSnapshotKinds(parsed.body)));
  }
  if (out.audienceEvidence !== undefined) parts.push(formatV3AudienceHint(out.audienceEvidence));
  if (budget.over) parts.push(formatV3ResidentOverBudget(budget.used, budget.max));
  else if (out.isGlobalWrite) parts.push(formatV3ResidentLine(budget.used, budget.max));
  if (out.ignoredLine !== "") parts.push(out.ignoredLine);
  if (out.voidedLine !== undefined) parts.push(out.voidedLine);
  return text(parts.join("\n"), usage);
}

// ───────────────────── factory ─────────────────────

export function createMemoryToolV3(deps: MemoryToolV3Deps): ToolDefinition {
  const { settings } = deps;
  const gate = deps.writeGate ?? plainMemoryWriteGate;

  function assertWritable(command: V3Command): void {
    if (deps.isChildSession && !settings.allowWriteInChildSessions && !READ_ONLY.has(command)) {
      throw new MemoryError(
        "E_READONLY: child sessions are read-only for memory by default; enable memory.allowWriteInChildSessions to allow writes",
      );
    }
  }

  return {
    name: "memory",
    label: "Memory",
    description: deps.jev === undefined ? MEMORY_TOOL_V3_TEXT.description : MEMORY_TOOL_V3_TEXT_JEV.description,
    promptSnippet: MEMORY_TOOL_V3_TEXT.promptSnippet,
    promptGuidelines: [...MEMORY_TOOL_V3_TEXT.promptGuidelines],
    parameters: MemoryToolParamsV3,
    async execute(_toolCallId, rawParams: RawV3Params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
      const cwd = resolveCwd(ctx);
      const guardSignal = concatGuardSignals(signal, deps.sessionSignal?.());
      let normalized: NormalizedV3Call;
      try {
        normalized = normalizeV3(rawParams);
      } catch (err) {
        if (err instanceof MemoryError && err.message.startsWith("E_UNSUPPORTED_COMMAND")) {
          // §4.1.3: every execute-level unsupported-command rejection leaves
          // a diag line (observable old habits). Fail-soft by contract.
          const m = /"([^"]+)"/.exec(err.message)?.[1] ?? "unknown";
          try {
            const display = memoryDirFor(cwd, deps.paths);
            appendDiagLine(
              canonicalDir(display)?.real ?? display,
              Date.now(),
              `unsupported:${m.replace(/^action:/, "")}`,
            );
          } catch {
            /* diagnostics are fail-soft */
          }
        }
        throw err;
      }
      const command = normalized.command;
      assertWritable(command);
      const display = memoryDirFor(cwd, deps.paths);
      const real = canonicalDir(display)?.real;
      const realDir = join(real ?? display, "blocks");
      const today = localToday();
      const now = new Date();
      const format = dirFormat(display);

      // ── search ──
      if (command === "search") {
        if (normalized.query === undefined) throw new Error("search requires query");
        if (format !== "blocks") return text(`no matches for ${JSON.stringify(normalized.query)}`);
        const corpus = readCorpus(realDir);
        const files = corpus.blocks
          .filter((b) => b.meta.status === "active" && b.meta.private !== true)
          .map((b) => ({ name: `${b.id}.md`, body: b.body }));
        const hits = searchMemory(files, normalized.query);
        if (hits.length === 0) return text(`no matches for ${JSON.stringify(normalized.query)}`);
        const revs = new Map<string, string>(corpus.blocks.map((b) => [`${b.id}.md`, b.rev] as const));
        return text(
          withNotes(
            hits
              .map((h) => `${h.file.replace(/\.md$/, "")} · rev ${revs.get(h.file) ?? "?"} › L${h.line}: ${h.text}`)
              .join("\n"),
            normalized.notes,
          ),
        );
      }

      const gateErr = (why: string): MemoryError => new MemoryError(`E_WRITE_GATE: memory write refused (${why})`);
      const requireGate = (): void => {
        const verdict = gate.check(display);
        if (!verdict.ok) throw gateErr(verdict.reason);
      };

      // ── view ──
      if (command === "view") {
        if (format !== "blocks") {
          return text(
            `No block memory for ${cwd} yet${format === "files" ? " — run /mem migrate to convert the legacy files" : ""}.`,
          );
        }
        const corpus = readCorpus(realDir);
        if (normalized.path === undefined)
          return text(withNotes(renderListing(cwd, corpus, deps, today), normalized.notes));
        // A block-id-shaped path (topic.seq) addresses a block; anything
        // else is tried as a topic name.
        if (BLOCK_ID_STEM_RE.test(normalized.path.replace(/\.md$/, "").replace(/^\/?(memories\/)?/, ""))) {
          const id = resolveBlockId(normalized.path);
          const b = readBlockIfExists(realDir, id);
          if (b === undefined) {
            throw new MemoryError(`E_NOT_FOUND: block ${id} does not exist — view (no path) lists topics`);
          }
          return text(withNotes(`${blockHeader(b, today, true)}\n${b.body}`, normalized.notes));
        }
        const topic = resolveTopicName(normalized.path);
        if (topic === undefined) {
          throw new MemoryError(
            `E_BAD_PATH: ${JSON.stringify(normalized.path)} is neither a block id nor a topic name`,
          );
        }
        const jevIndex = (() => {
          try {
            return readIndex(real ?? display).index;
          } catch {
            return undefined;
          }
        })();
        return text(withNotes(renderTopicView(corpus, jevIndex, topic, today), normalized.notes));
      }

      // ── write commands: layout pre-checks ──
      if (command === "update" || command === "delete") {
        if (format === "files") {
          throw new MemoryError("E_UNMIGRATED: the memory directory still uses legacy files — run /mem migrate first");
        }
        if (format === "held") {
          throw new MemoryError("E_UNMIGRATED: a migration hold is present — finish or roll back with /mem migrate");
        }
      }
      if (command === "create" && format === "files") {
        throw new MemoryError("E_UNMIGRATED: the memory directory still uses legacy files — run /mem migrate first");
      }
      if (command === "create" && format === "held") {
        throw new MemoryError("E_UNMIGRATED: a migration hold is present — finish or roll back with /mem migrate");
      }

      // ── create ──
      if (command === "create") {
        if (normalized.topic === undefined || normalized.text === undefined) {
          throw new Error("create requires topic and text");
        }
        const topic = canonicalTopic(normalized.topic);
        if (topic === undefined || topic !== normalized.topic) {
          throw new MemoryError(
            `E_BAD_TOPIC: topic must match [a-z0-9-]{1,48} (canonical form ${JSON.stringify(topic ?? "")})`,
          );
        }
        const { meta, body } = parseWriteMeta(normalized.text);
        if (meta.errors.length > 0) {
          throw new MemoryError(`refused: the inline comment has errors — ${meta.errors.join("; ")}`);
        }
        const bytes = bodyBytes(body);
        if (bytes > BLOCK_BODY_MAX_BYTES) {
          throw new MemoryError(
            `E_TOO_LARGE: block body is ${bytes}B > 1024B — split it into several blocks (one fact each)`,
          );
        }
        assertNotAborted(guardSignal, `create ${topic}`);
        const inlineErr = deps.jev?.checkInline(
          `${topic}.md`,
          undefined,
          stripServerOwnedTokens(normalized.text, meta.ignored),
        );
        if (inlineErr !== undefined) throw new MemoryError(inlineErr);
        const metaObj = metaForCreate(meta);
        // absent ⇒ first write creates blocks/ — the §4.7 explicit-path
        // protocol: bootstrap (verifies unlocked/mount/write-zone/ancestor
        // identity WITHOUT requiring a prior capture) → ensureMemoryDir →
        // capture the new dir; the in-lock store ops then run normal per-op
        // gate checks. Gates without bootstrap keep the check() semantics.
        if (format === "absent") {
          const verdict = gate.bootstrap !== undefined ? gate.bootstrap(display) : gate.check(display);
          if (!verdict.ok) {
            throw new MemoryError(`E_WRITE_GATE: memory write refused (${verdict.reason})`);
          }
          ensureMemoryDir(display);
          gate.capture(display);
        }
        const created = await withMemoryDirLock(real ?? display, () => {
          const nowFormat = dirFormat(display);
          if (nowFormat === "absent") {
            // §3.4: source:"fresh" marker, atomic, in-lock
            ensurePrivateDir(realDir);
            const marker = JSON.stringify({ v: 1, source: "fresh", migratedAt: now.toISOString() });
            const tmp = writeTempRegular(realDir, ".layout.json", Buffer.from(marker, "utf8"), 0o600);
            createExclusive(realDir, tmp, ".layout.json");
          } else if (nowFormat !== "blocks") {
            throw new MemoryError("E_UNMIGRATED: directory is not in block layout");
          }
          requireGate();
          assertNotAborted(guardSignal, `create ${topic}`);
          return createBlockLocked(realDir, topic, metaObj, body, now, { gate });
        });
        deps.onAfterWrite(cwd);
        const corpus = readCorpus(realDir);
        return finishWrite(
          cwd,
          deps,
          ctx,
          signal,
          {
            head: formatV3CreatedLine(created.id, topic, created.rev, bytes, BLOCK_BODY_MAX_BYTES),
            corpus,
            authority: created.meta.authority,
            hasExpiry: created.meta.expires !== undefined || created.meta.until !== undefined,
            ignoredLine: formatV3IgnoredLine(meta.ignored),
            // creating a user rule is NOT a #26 change — nothing was voided
            voidedLine: undefined,
            isGlobalWrite: isResident(created.meta),
            notes: normalized.notes,
            audienceEvidence: meta.audience === undefined ? audienceEvidenceOf(body) : undefined,
          },
          {
            id: created.id,
            rev: created.rev,
            authority: created.meta.authority,
            scopeExplicit: meta.scope !== undefined,
          },
          undefined,
          created.raw,
        );
      }

      // ── update ──
      if (command === "update") {
        if (normalized.text === undefined) throw new Error("update requires text");
        if (normalized.path === undefined) throw new Error("update requires path");
        const id = resolveBlockId(normalized.path);
        const current = readBlockIfExists(realDir, id);
        if (current === undefined) {
          throw new MemoryError(`E_NOT_FOUND: block ${id} does not exist — view (no path) lists topics`);
        }
        if (normalized.rev === undefined || normalized.rev === "") {
          throw new MemoryError(
            `E_REV_REQUIRED: update requires rev — current rev ${current.rev} (view ${id} for the latest)`,
          );
        }
        const { meta, body } = parseWriteMeta(normalized.text);
        if (meta.errors.length > 0) {
          throw new MemoryError(`refused: the inline comment has errors — ${meta.errors.join("; ")}`);
        }
        const bytes = bodyBytes(body);
        if (bytes > BLOCK_BODY_MAX_BYTES) {
          throw new MemoryError(
            `E_TOO_LARGE: block body is ${bytes}B > 1024B — split it into several blocks (one fact each)`,
          );
        }
        if (current.rev !== normalized.rev) {
          throw new MemoryError(
            `E_CONFLICT: current rev ${current.rev}\n${current.body}\nmerge and retry update with the current rev`,
          );
        }
        const nextMeta = mergeMeta(current.meta, meta);
        const change = userRuleChange(current, nextMeta);
        if (change !== undefined) assertNotAborted(guardSignal, id);
        const inlineErr = deps.jev?.checkInline(
          `${id}.md`,
          current.raw,
          stripServerOwnedTokens(normalized.text, meta.ignored),
        );
        if (inlineErr !== undefined) throw new MemoryError(inlineErr);
        const updated = await withMemoryDirLock(real ?? display, () => {
          if (dirFormat(display) !== "blocks") throw new MemoryError("E_UNMIGRATED: directory is not in block layout");
          requireGate();
          assertNotAborted(guardSignal, id);
          try {
            return replaceBlockLocked(realDir, id, normalized.rev!, { meta: nextMeta, body }, now, { gate });
          } catch (err) {
            if (err instanceof MemoryError && err.message.startsWith("E_CONFLICT")) {
              throw new MemoryError(`${err.message}\nmerge and retry update with the current rev`);
            }
            throw err;
          }
        });
        deps.onAfterWrite(cwd);
        notifyUserRuleChange(ctx, deps.isChildSession, id, change);
        const corpus = readCorpus(realDir);
        return finishWrite(
          cwd,
          deps,
          ctx,
          signal,
          {
            head: formatV3UpdatedLine(id, updated.rev, current.rev, bytes, BLOCK_BODY_MAX_BYTES),
            corpus,
            authority: updated.meta.authority,
            hasExpiry: updated.meta.expires !== undefined || updated.meta.until !== undefined,
            ignoredLine: formatV3IgnoredLine(meta.ignored),
            voidedLine: change?.voided,
            isGlobalWrite: isResident(updated.meta),
            notes: normalized.notes,
            audienceEvidence: meta.audience === undefined ? audienceEvidenceOf(body) : undefined,
          },
          { id, rev: updated.rev, authority: updated.meta.authority, scopeExplicit: meta.scope !== undefined },
          current.raw,
          updated.raw,
        );
      }

      // ── delete ──
      if (normalized.path === undefined) throw new Error("delete requires path");
      const id = resolveBlockId(normalized.path);
      const current = readBlockIfExists(realDir, id);
      if (current === undefined) {
        throw new MemoryError(`E_NOT_FOUND: block ${id} does not exist — view (no path) lists topics`);
      }
      const change = userRuleChange(current, undefined);
      if (change !== undefined) assertNotAborted(guardSignal, id);
      const trash = await withMemoryDirLock(real ?? display, () => {
        if (dirFormat(display) !== "blocks") throw new MemoryError("E_UNMIGRATED: directory is not in block layout");
        requireGate();
        assertNotAborted(guardSignal, id);
        try {
          return trashBlockLocked(realDir, `${id}.md`, normalized.rev === "" ? undefined : normalized.rev, { gate });
        } catch (err) {
          if (err instanceof MemoryError && err.message.startsWith("E_CONFLICT")) {
            throw new MemoryError(`${err.message}\nview ${id} and retry delete with the current rev`);
          }
          throw err;
        }
      });
      deps.onAfterWrite(cwd);
      notifyUserRuleChange(ctx, deps.isChildSession, id, change);
      const trashId = trash.trashName.replace(/-[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}\.md$/, "");
      const lines = [formatV3DeletedLine(id, trashId)];
      // §4.1.2 delete row: blocks this one superseded stay superseded.
      const supersededByThis = readCorpus(realDir).blocks.filter((b) => b.meta.supersededBy === id);
      if (supersededByThis.length > 0) {
        lines.push(
          `note: ${supersededByThis.length} block(s) superseded by ${id} stay superseded: ${supersededByThis
            .map((b) => b.id)
            .join(", ")}`,
        );
      }
      if (change !== undefined) lines.push(change.voided);
      return text(lines.join("\n"));
    },
  } as ToolDefinition;
}
