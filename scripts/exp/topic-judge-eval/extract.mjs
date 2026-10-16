#!/usr/bin/env -S npx tsx
/**
 * topic-switch judge eval · step 1 — candidate extraction (scripts/exp/topic-judge-eval/).
 *
 * Scans pi session jsonl files (this repo's default session dir, or explicit files/dirs),
 * and for every REAL typed user request rebuilds the exact `JudgeInput` the live judge
 * would have seen at that moment:
 *
 *  - branch-before: walks the parentId chain from the user entry's parent (the leaf at the
 *    moment the request arrived — exactly what `ctx.sessionManager.getBranch()` returned
 *    in `wire.ts runJudge`), then feeds it to the REAL `buildBranchView` imported from
 *    `src/topic-switch/hold.ts` (no replication). sessionName comes from the latest
 *    `session_info` entry in that branch (`pi.getSessionName()` reads the same entries).
 *  - skip rules: slash commands (`/x`), shell escapes (`!x`), < 8 code points,
 *    `custom_message`/system entries (injected), extension-injected user messages
 *    (the `[switch_context]` handoff re-injection), no preceding assistant turn, and whole
 *    files carrying the `subagent:child` marker (they are subagent sessions, not typed).
 *  - context columns: `gapMin` since the previous assistant message, `cold` +
 *    `cacheRead/cacheWrite` of the NEXT assistant turn (cold ⇔ cacheRead ≤ 1024 tokens —
 *    a fresh write like {input:4, cacheWrite:75610} is cold; no usage info ⇒ null), and
 *    the live `subagent:topic-switch` outcome record just before the request, if any.
 *
 * Output: `docs/dev/topic-switch/judge-eval/candidates.jsonl` (one JSON per line:
 * {id, sessionFile, at, gapMin, cold, cacheRead?, cacheWrite?, liveOutcome?, input, label:null,
 * note:""}). Request text is kept intact (the user's own data on this machine); labeling
 * (`label: true|false` = should the judge say related) is done by the main session.
 *
 * Usage (needs tsx — plain `node --experimental-strip-types` cannot rewrite the `.js`
 * import specifiers inside src/, see README):
 *   npx tsx scripts/exp/topic-judge-eval/extract.mjs [files or dirs...] [--limit N] [--out FILE]
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildBranchView } from "../../../src/topic-switch/hold.ts";

const DEFAULT_DIR = join(homedir(), ".pi/agent/sessions/--home-bluecake-ai-pi-toolkit--");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(SCRIPT_DIR, "../../../docs/dev/topic-switch/judge-eval/candidates.jsonl");
const ENTRY_TYPE = "subagent:topic-switch";
const CHILD_MARKER = "subagent:child";
/** cold-cache threshold in tokens: a real warm read is ≥ tens of thousands; ≤1024 is noise. */
const COLD_CACHE_READ_MAX = 1024;

function parseArgs(argv) {
  const paths = [];
  let limit = 10;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") limit = Number.parseInt(argv[++i] ?? "", 10) || limit;
    else if (a === "--out") out = argv[++i] ?? out;
    else paths.push(a);
  }
  return { paths, limit, out };
}

/** pi `message` entries only; `custom_message` (injected) has its own type and is excluded. */
function isUserMessage(entry) {
  return entry?.type === "message" && entry.message?.role === "user";
}
function isAssistantMessage(entry) {
  return entry?.type === "message" && entry.message?.role === "assistant";
}

/** Same join as hold.ts's plainTextOf, plus an image-block count. */
function textAndImages(content) {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let text = "";
  let images = 0;
  for (const block of content) {
    if (block?.type === "text") text += (text ? " " : "") + block.text;
    else if (block?.type === "image") images += 1;
  }
  return { text, images };
}

function ts(entry) {
  const t = entry?.timestamp ?? entry?.message?.timestamp;
  const ms = t === undefined ? NaN : Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseFile(file) {
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
}

function extractFile(file) {
  const entries = parseFile(file);
  if (entries.some((e) => e?.type === "custom" && e.customType === CHILD_MARKER)) {
    process.stderr.write(`skip (subagent child session): ${basename(file)}\n`);
    return [];
  }
  const byId = new Map(entries.filter((e) => typeof e?.id === "string").map((e) => [e.id, e]));
  const candidates = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isUserMessage(entry)) continue;
    const { text: rawText, images } = textAndImages(entry.message.content);
    const text = rawText.trim();
    if (text.startsWith("/") || text.startsWith("!")) continue; // slash command / shell escape
    if (text.startsWith("[switch_context]")) continue; // extension-injected handoff, not typed
    if ([...text].length < 8) continue; // very short / pure tool-result echoes

    // Branch exactly as getBranch() saw it at this moment: root → … → parent(leaf).
    const branch = [];
    for (let cur = byId.get(entry.parentId ?? ""); cur; cur = byId.get(cur.parentId ?? "")) branch.push(cur);
    branch.reverse();

    const view = buildBranchView(branch);
    if (!view.hasAssistant) continue; // "a user message preceded by an assistant turn"

    // gapMin since the previous assistant message (any stopReason — timestamps are what matter)
    let prevAssistantAt;
    for (let j = branch.length - 1; j >= 0; j -= 1) {
      if (isAssistantMessage(branch[j])) {
        prevAssistantAt = ts(branch[j]);
        break;
      }
    }
    const atMs = ts(entry);
    const gapMin =
      atMs !== undefined && prevAssistantAt !== undefined
        ? Math.round(((atMs - prevAssistantAt) / 60_000) * 10) / 10
        : null;

    // latest session_info name in the branch (pi.getSessionName() reads the same entries)
    let sessionName;
    for (const e of branch)
      if (e?.type === "session_info" && typeof e.name === "string" && e.name !== "") sessionName = e.name;

    // live topic-switch outcome record just before this request (state.ts reads via getBranch)
    let liveOutcome;
    for (const e of branch) {
      if (e?.type === "custom" && e.customType === ENTRY_TYPE && e.data?.kind === "outcome") {
        const d = e.data;
        liveOutcome = {
          outcome: d.outcome,
          ...(typeof d.confidence === "number" ? { confidence: d.confidence } : {}),
          ...(typeof d.estUsd === "number" ? { estUsd: d.estUsd } : {}),
        };
      }
    }

    // next assistant turn's cache numbers (after this request, file order)
    let cacheRead = null;
    let cacheWrite = null;
    for (let j = i + 1; j < entries.length; j += 1) {
      const e = entries[j];
      if (!isAssistantMessage(e)) continue;
      const usage = e.message.usage;
      if (!usage) continue;
      cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : null;
      cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : null;
      break;
    }
    const cold = cacheRead === null ? null : cacheRead <= COLD_CACHE_READ_MAX;

    const input = {
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(view.lastCompactionSummary !== undefined ? { compactionSummary: view.lastCompactionSummary } : {}),
      recentUserMessages: view.recentUserTexts,
      ...(view.lastAssistantText !== undefined ? { lastAssistantExcerpt: view.lastAssistantText } : {}),
      request: text,
      imageCount: images,
    };
    candidates.push({
      id: `${basename(file)}:${entry.id ?? i}`,
      sessionFile: resolve(file),
      at: entry.timestamp ?? null,
      gapMin,
      cold,
      ...(cacheRead !== null || cacheWrite !== null ? { cacheRead, cacheWrite } : {}),
      ...(liveOutcome !== undefined ? { liveOutcome } : {}),
      input,
      label: null,
      note: "",
    });
  }
  return candidates;
}

function listFiles(path, limit) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(path, f))
    .filter((f) => !looksLikeChildSession(f)) // child sessions are not typed sessions — the limit counts real ones
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}

/** Cheap head-sniff: the `subagent:child` marker is written at child-session start (near the head). */
function looksLikeChildSession(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(`"customType":"${CHILD_MARKER}"`);
  } catch {
    return false;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
  }
}

const { paths, limit, out } = parseArgs(process.argv.slice(2));
const inputs = paths.length > 0 ? paths : [DEFAULT_DIR];
const files = inputs.flatMap((p) => listFiles(p, limit));
process.stderr.write(`scanning ${files.length} file(s)\n`);
const all = [];
for (const f of files) all.push(...extractFile(f));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, all.map((c) => JSON.stringify(c)).join("\n") + (all.length > 0 ? "\n" : ""));
const withOutcome = all.filter((c) => c.liveOutcome !== undefined).length;
const coldCount = all.filter((c) => c.cold === true).length;
console.log(
  `candidates: ${all.length} (from ${files.length} files; liveOutcome on ${withOutcome}, cold=true on ${coldCount})`,
);
console.log(`wrote ${out}`);
