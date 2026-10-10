#!/usr/bin/env node
/**
 * consult A/B 分析脚本（docs/dev/consult/ab-instrumentation-plan.md §5 P3）。
 *
 *   node scripts/exp/consult-ab-analyze.mjs [--dir ~/.pi/agent/sessions]
 *       [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--salt <salt>]
 *       [--work-types general,frontend-dev] [--json]
 *
 * 递归读取 *.jsonl 里的 `subagent:run` 条目，按 §5 P3 的规则去重、分角色、
 * 分包、分臂，输出首验通过率（Wilson 95%）、两比例 z 检验、返工轮数、成本、
 * 墙钟、consult 汇总、排除清单、单独的未入组包清单与功效提示。`--json` 输出机器可读的完整分析对象
 * （确定性输出：不含时间戳，可直接做快照）。
 *
 * 时间窗按 diag.createdAt 过滤：--since 含当天 UTC 零点，--until 不含（UTC 零点为上界）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SALT,
  DEFAULT_WORK_TYPES,
  analyzeRuns,
  dedupeRuns,
  parseDayUtc,
  parseSessionText,
  renderReport,
} from "./consult-ab-lib.mjs";

const USAGE = `usage: node scripts/exp/consult-ab-analyze.mjs [options]
  --dir <path>          session root to scan recursively for *.jsonl
                        (default: ~/.pi/agent/sessions)
  --since YYYY-MM-DD    only runs with diag.createdAt >= that UTC midnight
  --until YYYY-MM-DD    only runs with diag.createdAt < that UTC midnight (exclusive)
  --salt <salt>         verify each package's declared arm against the hash
                        (default: no verification; the arm script defaults to ${DEFAULT_SALT})
  --work-types a,b,c    agent types counted as work runs (default: ${DEFAULT_WORK_TYPES.join(",")};
                        "verifier" and "reviewer" are always the verify role and cannot be overridden)
  --json                print the full analysis object as JSON (deterministic)
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
  salt: null,
  workTypes: [...DEFAULT_WORK_TYPES],
  json: false,
};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === "--json") {
    opts.json = true;
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg === "--dir" || arg === "--since" || arg === "--until" || arg === "--salt" || arg === "--work-types") {
    if (next === undefined) fail(`${arg} requires a value`);
    if (arg === "--dir") opts.dir = next;
    else if (arg === "--since") {
      const ms = parseDayUtc(next);
      if (ms === undefined) fail(`--since expects YYYY-MM-DD, got ${JSON.stringify(next)}`);
      opts.since = ms;
    } else if (arg === "--until") {
      const ms = parseDayUtc(next);
      if (ms === undefined) fail(`--until expects YYYY-MM-DD, got ${JSON.stringify(next)}`);
      opts.until = ms;
    } else if (arg === "--salt") opts.salt = next;
    else {
      const types = next
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      if (types.length === 0 || types.some((t) => t === "verifier" || t === "reviewer")) {
        fail(
          `--work-types expects a comma list without the verify types "verifier"/"reviewer", got ${JSON.stringify(next)}`,
        );
      }
      opts.workTypes = types;
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
const analysis = analyzeRuns(chosen, {
  workTypes: opts.workTypes,
  salt: opts.salt,
  since: opts.since,
  until: opts.until,
  scan: { files: files.length, runEntries, malformedEntries },
});

if (opts.json) {
  process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
} else {
  process.stdout.write(`${renderReport(analysis)}\n`);
}
