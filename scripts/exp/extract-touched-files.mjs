#!/usr/bin/env node
/**
 * baseline-experiment 取数工具（docs/dev/fabric-v2/baseline-experiment.md 的 M1/M4）。
 *
 * 从一个 pi session JSONL 里提取「这个 agent 实际碰过哪些仓库文件」。
 *
 * 为什么不用 diag.toolHistory[].argsPreview：它截断到 80 字符、是容量 30 的 ring，
 * 会系统性低估。会话文件是完整的。
 *
 * 为什么必须解析 bash 命令：探索型 agent 的绝大多数文件接触发生在
 * `bash grep/sed/rg/cat` 里，只取 args.path 会漏掉大半。
 *
 * usage:
 *   node scripts/exp/extract-touched-files.mjs <session.jsonl> [--json] [--root <repoRoot>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const asJson = argv.includes("--json");
const rootIdx = argv.indexOf("--root");
const root = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();

if (!file) {
  console.error("usage: extract-touched-files.mjs <session.jsonl> [--json] [--root <repoRoot>]");
  process.exit(2);
}

/** 仓库内的相对路径形态；末段必须带扩展名，避免把目录当文件。 */
const PATH_RE =
  /(?:^|[\s'"`(=:,])((?:src|tests|docs|scripts|examples)\/[A-Za-z0-9_@.\-/]*[A-Za-z0-9_-]\.[A-Za-z0-9]+)/g;
const ROOT_FILES = new Set([
  "AGENTS.md",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "index.ts",
  "index.js",
  "vitest.config.ts",
]);

const norm = (p) => {
  let s = p.trim().replace(/^\.\//, "");
  if (s.startsWith(root)) s = s.slice(root.length).replace(/^\//, "");
  // glob/通配保留原样（它们代表"扫了一批"，不是精确文件）
  return s;
};

const harvest = (text, sink) => {
  if (typeof text !== "string" || !text) return;
  // 关键：子 agent 常用**绝对路径**（/abs/repo/src/x.ts）。先把仓库根前缀剥掉再匹配，
  // 否则 `src` 前面是 `/`（不在边界字符类里）会导致整段静默漏匹配——这个 bug 不报错、
  // 只是返回 0，足以让整个实验的结论作废。
  const t = root ? text.split(root.replace(/\/$/, "") + "/").join("") : text;
  for (const m of t.matchAll(PATH_RE)) sink.add(norm(m[1]));
  for (const rf of ROOT_FILES) {
    const re = new RegExp(`(?:^|[\\s'"\`(=:,/])${rf.replace(/\./g, "\\.")}(?![A-Za-z0-9])`);
    if (re.test(t) && !t.includes(`/${rf}`)) sink.add(rf);
  }
};

const files = new Set();
const byTool = new Map();
let toolCalls = 0;

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
  for (const part of entry.message.content ?? []) {
    if (part?.type !== "toolCall") continue;
    toolCalls++;
    const name = part.name ?? "?";
    byTool.set(name, (byTool.get(name) ?? 0) + 1);
    const args = part.args ?? part.arguments ?? {};
    const before = files.size;
    // ① 显式路径参数
    for (const key of ["path", "file_path", "filePath"]) harvest(args[key], files);
    // ② bash 命令 / 搜索模式里内嵌的路径
    // 注意：故意**不**采集 `prompt`——派子 agent 的 prompt 里出现路径不等于本会话访问过它，
    // 实测会把 prompt 模板里的占位符（如 src/xxx.ts）计进摸索痕迹，污染 M1b。
    for (const key of ["command", "pattern", "query"]) harvest(args[key], files);
    void before;
  }
}

const all = [...files].filter(Boolean).sort();
// M1b：不存在的路径 = 「猜文件在哪」的摸索痕迹，是交接包缺文件索引的直接代理指标。
const missing = all.filter((p) => !p.includes("*") && !existsSync(join(root, p)));
const hit = all.filter((p) => !missing.includes(p));
if (asJson) {
  console.log(
    JSON.stringify(
      { file, toolCalls, byTool: Object.fromEntries(byTool), files: hit, gropedMissing: missing },
      null,
      2,
    ),
  );
} else {
  console.log(`session: ${file}`);
  console.log(`toolCalls: ${toolCalls}  (${[...byTool].map(([k, v]) => `${k}\u00d7${v}`).join(" ")})`);
  console.log(`touched files: ${hit.length}   groped-missing (M1b): ${missing.length}`);
  for (const f of hit) console.log("  " + f);
  if (missing.length) {
    console.log("-- 猜错的路径（摸索痕迹）--");
    for (const f of missing) console.log("  ? " + f);
  }
}
