#!/usr/bin/env node
/**
 * consult 缓存埋点分析脚本（docs/dev/consult/expert-keepalive-plan.md §4.4，包 F）。
 *
 *   node scripts/exp/consult-cache-analyze.mjs [--dir ~/.pi/agent/sessions]
 *       [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--retro] [--json]
 *
 * 递归读取 *.jsonl 里的 `subagent:run` 条目，按 §4.4 输出 consult 缓存埋点分析：
 *  - probe（默认）：消费 `diag.consults.cacheProbes[]`（§4.1），输出结局分布、
 *    hitRatio 分布、逐请求 cacheRead/cacheWrite、间隔分桶、成本 cold/warm、被拦调用、
 *    与 §11 的保活 go/no-go 四项指标。
 *  - retro（--retro）：历史数据（今天没有 cacheProbes）——从 `subagent:run` 重算
 *    「专家结算 → 消费者派发」的间隔分桶，输出可得到的结局分布与成本。对缺失数据健壮，
 *    只写 stdout，绝不写磁盘。
 *
 * 时间窗按 run 的 diag.createdAt 过滤：--since 含当天 UTC 零点，--until 不含。
 * `--json` 输出机器可读的完整分析对象（确定性：不含时间戳，可做快照）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeConsultCache, dedupeRuns, parseDayUtc, parseSessionText, renderReport } from "./consult-cache-lib.mjs";

const USAGE = `usage: node scripts/exp/consult-cache-analyze.mjs [options]
  --dir <path>      session root to scan recursively for *.jsonl
                    (default: ~/.pi/agent/sessions)
  --since YYYY-MM-DD  only runs with diag.createdAt >= that UTC midnight
  --until YYYY-MM-DD  only runs with diag.createdAt < that UTC midnight (exclusive)
  --retro           retro mode: reconstruct expert-settle -> consumer-dispatch gaps
                    from historical subagent:run (no cacheProbes available today)
  --follow-gaps     compute per-thread follow-up gaps (consecutive consult gap vs
                    cache outcome, from consult-run diag.consultCache/consultThread)
  --json            print the full analysis object as JSON (deterministic)
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.stderr.write(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = {
  dir: join(homedir(), ".pi", "agent", "sessions"),
  since: null,
  until: null,
  retro: false,
  followGaps: false,
  json: false,
};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === "--retro") {
    opts.retro = true;
  } else if (arg === "--follow-gaps") {
    opts.followGaps = true;
  } else if (arg === "--json") {
    opts.json = true;
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg === "--dir" || arg === "--since" || arg === "--until") {
    if (next === undefined) fail(`${arg} requires a value`);
    if (arg === "--dir") opts.dir = next;
    else if (arg === "--since") {
      const ms = parseDayUtc(next);
      if (ms === undefined) fail(`--since expects YYYY-MM-DD, got ${JSON.stringify(next)}`);
      opts.since = ms;
    } else {
      const ms = parseDayUtc(next);
      if (ms === undefined) fail(`--until expects YYYY-MM-DD, got ${JSON.stringify(next)}`);
      opts.until = ms;
    }
    i++;
  } else {
    fail(`unknown argument ${arg}`);
  }
}

if (opts.since !== null && opts.until !== null && opts.since >= opts.until) {
  fail(`--since must be before --until`);
}
if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
  fail(`--dir ${opts.dir} is not a directory`);
}

// 递归收集 *.jsonl，路径字典序 = 去重平局裁决的扫描顺序
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // 竞态：扫描期间被删
    }
    if (st.isDirectory()) walk(path);
    else if (st.isFile() && name.endsWith(".jsonl")) files.push(path);
  }
}
walk(opts.dir);
files.sort();

const parsedFiles = [];
let runEntries = 0;
let malformedEntries = 0;
for (const path of files) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`warn: skipping unreadable file ${path}: ${err.message}`);
    continue;
  }
  const { snapshots, malformed } = parseSessionText(text);
  runEntries += snapshots.length;
  malformedEntries += malformed;
  parsedFiles.push({ path, snapshots });
}

const chosen = dedupeRuns(parsedFiles);
const analysis = analyzeConsultCache(chosen, {
  retro: opts.retro,
  since: opts.since,
  until: opts.until,
  followGaps: opts.followGaps,
  scan: { files: files.length, runEntries, malformedEntries },
});

if (opts.json) {
  process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
} else {
  process.stdout.write(`${renderReport(analysis)}\n`);
}
