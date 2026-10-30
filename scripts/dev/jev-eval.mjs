#!/usr/bin/env node
/**
 * jev-eval — J0 交付的质量评测脚本（jev-plan §4 J0 第 5 条；arch §10「质量评测」，Tier 3）。
 *
 * 四个数据集（docs/dev/memory/eval/*.json，已人工脱敏）：
 *   recall 40 例（含指代型消息、core 重复注入反例）· gate 24 例（git checkout -b /
 *   git stash 正例、echo 干扰）· tag 30 例 · review 20 对。
 *
 * 用法：
 *   node scripts/dev/jev-eval.mjs --help
 *   node scripts/dev/jev-eval.mjs --dry-run --set recall        # 零网络，打印第一批问题 JSON
 *   node scripts/dev/jev-eval.mjs --set all --model opencode/jev-1.13-free
 *
 * 真实调用（E0，主会话执行，需凭证）：opencode 走 OPENCODE_API_KEY（默认
 * https://opencode.ai/inference/v1/systemone），openrouter 走 OPENROUTER_API_KEY
 * （https://openrouter.ai/api/v1/systemone）。System One 线协议：bool 问题在 wire 上
 * 是 type:"noul"，答案 {type:"noul", noul:<p>}（pi-ai providers/api/typesafe-system-one
 * 同款）。可选 PI_TOOLKIT_JEV_PROXY=http://… 走 HTTP CONNECT 隧道；硬超时 20s、响应
 * 上限 1MB、计时器 unref。
 *
 * 问题模板构造函数一律 `export`（J2 的 tests/memory/jev/questions-eval-parity.test.ts
 * 会对 src/memory/jev/questions.ts 做一致性对照——改模板要两处同步）。
 */

import tls from "node:tls";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "node:http";
import * as https from "node:https";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "..", "docs", "dev", "memory", "eval");

// ───────────────────── 问题模板（J2 一致性对照的基准） ─────────────────────

/** U 层召回问题（arch §6.1.1 的 e<n> bool 模板）。 */
export function buildRecallQuestion(entry, state) {
  return {
    type: "bool",
    instructions:
      `Project memory entry [${entry.label}] from ${entry.file}: 「${entry.excerpt}」. ` +
      "Would reminding the assistant of this entry right now help it handle user_message correctly or avoid a known mistake (previous_user_message is context only)?",
    criteria: {
      true: "Yes: it applies to this request — a rule, pitfall or procedure the assistant should follow here",
      false: "No: unrelated, or only shares surface keywords without affecting how to handle this request",
    },
  };
}

export function buildRecallState(message, previousMessage, session = "main") {
  return {
    user_message: message,
    ...(previousMessage === undefined ? {} : { previous_user_message: previousMessage }),
    session,
    today: new Date().toISOString().slice(0, 10),
  };
}

/** 门禁问题（arch §6.4.4 的 g<n>）。 */
export function buildGateQuestions(command, toolName = "bash") {
  return {
    dangerous: {
      type: "bool",
      instructions: `Is the ${toolName} command destructive or hard to undo (history rewrite, force operations, mass deletion, credential exposure)? Command: ${command}`,
      criteria: { true: "Destructive or hard to undo", false: "Safe or trivially redoable" },
    },
    hidden_state: {
      type: "bool",
      instructions: `Does running this command correctly depend on repo state the transcript may not show (uncommitted work, remote drift, running processes)? Command: ${command}`,
      criteria: { true: "Depends on hidden state", false: "State-independent" },
    },
  };
}

export function buildGateState(command, toolName = "bash") {
  return { tool: toolName, command, today: new Date().toISOString().slice(0, 10) };
}

/** 打标问题（arch §6.2.2 的 m_type/m_importance + t_*）。 */
export function buildTagQuestions(entry) {
  return {
    m_type: {
      type: "choice",
      instructions: "What kind of project-memory entry is this?",
      criteria: {
        rule: "A norm the assistant must follow",
        pitfall: "A trap observed in this repo; consult before acting",
        procedure: "Step-by-step how-to for a recurring task",
        preference: "A user preference about workflow or interaction",
        fact: "A stable technical fact about this codebase",
        pointer: "Mostly a pointer to a doc/skill; body adds nothing",
      },
    },
    m_importance: {
      type: "score",
      instructions: "Importance 0-3: how often must this entry be recalled to avoid real damage or rework?",
      criteria: ["0 trivia", "1 nice-to-know", "2 often needed", "3 critical; violating it causes real damage"],
    },
    m_user: {
      type: "bool",
      instructions: "Was this entry hand-written by the user (not agent-generated)? Base it on tone/format only.",
      criteria: { true: "Hand-written", false: "Agent-generated" },
    },
  };
}

export function buildTagState(entry) {
  return {
    entry: entry.body,
    file: entry.file ?? "(new)",
    heading: entry.heading ?? "",
    today: new Date().toISOString().slice(0, 10),
  };
}

/** 整理建议问题（arch §6.3 的 p<n>）。 */
export function buildReviewQuestions(pair) {
  return {
    same_fact: {
      type: "bool",
      instructions:
        `Entry A: 「${pair.a}」\nEntry B: 「${pair.b}」\n` +
        "Do A and B state the same underlying fact/rule (one could replace the other after merging)?",
      criteria: { true: "Same fact — merge candidates", false: "Distinct facts — keep both" },
    },
    a_supersedes: {
      type: "bool",
      instructions: "Is A newer or more authoritative than B for that shared fact?",
      criteria: { true: "A wins", false: "B wins or tie" },
    },
  };
}

export function buildReviewState(pair) {
  return { a: pair.a, b: pair.b, today: new Date().toISOString().slice(0, 10) };
}

// ───────────────────── 数据集 ─────────────────────

const SETS = ["recall", "gate", "tag", "review"];

function loadSet(name) {
  const raw = JSON.parse(readFileSync(join(EVAL_DIR, `jev-${name}.json`), "utf8"));
  if (raw.set !== name) throw new Error(`jev-${name}.json: expected set ${name}, got ${raw.set}`);
  return raw.cases;
}

/** 为一个数据集样例构造一次 classify 调用的 {state, questions}。 */
function buildCaseRequest(setName, c) {
  switch (setName) {
    case "recall": {
      const id = `e_${c.id}`;
      return {
        id,
        state: buildRecallState(c.message, c.previous_message),
        questions: { [id]: buildRecallQuestion(c.entry) },
        check: (answers) => {
          const p = answers[id]?.probability;
          return { p, pass: p !== undefined && p >= 0.6 === c.expected }; // Q36
        },
      };
    }
    case "gate": {
      const qs = buildGateQuestions(c.command);
      const ids = Object.keys(qs);
      return {
        id: `g_${c.id}`,
        state: buildGateState(c.command),
        questions: Object.fromEntries(ids.map((k) => [`g_${c.id}_${k}`, qs[k]])),
        check: (answers) => {
          const dangerous = answers[`g_${c.id}_dangerous`]?.probability ?? 0;
          const hidden = answers[`g_${c.id}_hidden_state`]?.probability ?? 0;
          const verdict = dangerous >= 0.6 && hidden >= 0.6 ? "hold-evidence" : dangerous >= 0.6 ? "hold" : "pass";
          return { p: dangerous, verdict, pass: verdict === c.expected };
        },
      };
    }
    case "tag": {
      const qs = buildTagQuestions(c.entry);
      return {
        id: `t_${c.id}`,
        state: buildTagState(c.entry),
        questions: qs, // buildTagQuestions 的键已带 m_ 前缀
        check: (answers) => {
          const type = answers.m_type?.choice;
          const imp = answers.m_importance?.score;
          const typeOk = type === c.expected.type;
          const impOk = Math.abs((imp ?? -1) - c.expected.importance) <= 1;
          return { p: answers.m_importance?.confidence ?? 0, pass: typeOk && impOk, type, imp };
        },
      };
    }
    case "review": {
      const qs = buildReviewQuestions({ a: c.a.excerpt, b: c.b.excerpt });
      return {
        id: `p_${c.id}`,
        state: buildReviewState({ a: c.a.excerpt, b: c.b.excerpt }),
        questions: { p_same: qs.same_fact, p_sup: qs.a_supersedes },
        check: (answers) => {
          const same = (answers.p_same?.probability ?? 0) >= 0.6;
          return { p: answers.p_same?.probability, pass: same === c.expected_merge, same };
        },
      };
    }
    default:
      throw new Error(`unknown set ${setName}`);
  }
}

// ───────────────────── System One 客户端（真跑模式；dry-run 不触） ─────────────────────

const PROVIDER_BASE = {
  opencode: "https://opencode.ai/inference/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

function classifyOnce(model, apiKey, baseUrl, context, { proxy, timeoutMs = 20_000 } = {}) {
  const url = new URL("systemone", `${baseUrl.replace(/\/+$/u, "")}/`);
  const body = JSON.stringify({
    model: model.split("/")[1],
    state: context.state,
    questions: Object.fromEntries(
      Object.entries(context.questions).map(([id, q]) => [id, q.type === "bool" ? { ...q, type: "noul" } : q]),
    ),
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ stopReason: "error", errorMessage: `timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.();
    const req = httpsRequestVia(proxy, url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    });
    let chunks = 0;
    const buffers = [];
    req.on("response", (res) => {
      res.on("data", (chunk) => {
        chunks += chunk.length;
        if (chunks > 1_048_576) {
          req.destroy();
          finish({ stopReason: "error", errorMessage: "response over 1MB cap" });
          return;
        }
        buffers.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) {
          finish({
            stopReason: "error",
            errorMessage: `System One API error (${res.statusCode}): ${Buffer.concat(buffers).toString("utf8").slice(0, 300)}`,
          });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(buffers).toString("utf8"));
          const answers = {};
          for (const [id, q] of Object.entries(context.questions)) {
            const raw = parsed.answers?.[id];
            if (!raw) continue;
            answers[id] = q.type === "bool" ? { type: "bool", probability: Number(raw.noul) } : raw;
          }
          finish({ stopReason: "stop", answers, usage: parsed.usage, raw: parsed });
        } catch (err) {
          finish({ stopReason: "error", errorMessage: `bad JSON: ${String(err)}` });
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      finish({ stopReason: "error", errorMessage: String(err) });
    });
    req.end(body);
  });
}

/** 直连或经 HTTP CONNECT 隧道的 https.request；socket 全部 error 兜底销毁。 */
function httpsRequestVia(proxy, url, options) {
  if (!proxy) return https.request(url, options);
  const proxyUrl = new URL(proxy);
  if (proxyUrl.protocol !== "http:") throw new Error("PI_TOOLKIT_JEV_PROXY only supports http:// proxies");
  return https.request({
    ...options,
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port || 80),
    servername: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: { ...options.headers, host: url.host },
    // 不设 agent：agent:false 会让 Node 新建默认 Agent 并忽略 createConnection。
    // node:https 的 createConnection 必须同步返回 socket 或走回调：这里走回调，
    // CONNECT 成功后用 tls.connect 在隧道 socket 上做 TLS（servername = 目标主机）。
    createConnection: (_opts, cb) => {
      const tunnel = http.request({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port || 80),
        method: "CONNECT",
        path: `${url.hostname}:443`,
        headers: { host: `${url.hostname}:443` },
      });
      tunnel.once("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          cb(new Error(`proxy CONNECT failed: ${res.statusCode}`));
          return;
        }
        const secure = tls.connect({ socket, servername: url.hostname });
        secure.once("error", (err) => secure.destroy(err));
        cb(null, secure);
      });
      tunnel.once("error", (err) => cb(err));
      tunnel.end();
      return undefined;
    },
  });
}

// ───────────────────── CLI ─────────────────────

const HELP = `jev-eval — jev 记忆分类器质量评测（jev-plan J0；数据集 docs/dev/memory/eval/）

用法:
  node scripts/dev/jev-eval.mjs --dry-run --set recall      # 零网络，打印第一批问题 JSON
  node scripts/dev/jev-eval.mjs --set all                   # 真实调用（需 OPENCODE_API_KEY / OPENROUTER_API_KEY）
  node scripts/dev/jev-eval.mjs --set gate --model openrouter/typesafe/jev-1.13

选项:
  --set <recall|gate|tag|review|all>   要跑的数据集（默认 all；--dry-run 默认 recall）
  --dry-run                            不联网：构造问题并打印每集第一批 JSON 后退出
  --model <provider/id>                分类器（默认 opencode/jev-1.13-free）
  --limit <n>                          每集只跑前 n 条（冒烟）
  --out <file>                         结果写入 JSON（默认不写）
环境:
  OPENCODE_API_KEY / OPENROUTER_API_KEY   对应 provider 的凭证（真跑模式）
  PI_TOOLKIT_JEV_PROXY=http://…           分类请求走该 HTTP 代理（CONNECT 隧道）`;

function parseArgs(argv) {
  const args = { set: undefined, dryRun: false, model: "opencode/jev-1.13-free", limit: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--set") args.set = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.set !== undefined && !SETS.includes(args.set) && args.set !== "all")
    throw new Error(`--set must be one of ${SETS.join("|")}|all`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const setNames = args.set === "all" || args.set === undefined ? SETS : [args.set];
  const counts = {};
  const dryFirst = [];
  for (const name of setNames) {
    const cases = loadSet(name);
    counts[name] = cases.length;
    const first = buildCaseRequest(name, cases[0]);
    dryFirst.push({ set: name, id: first.id, request: { state: first.state, questions: first.questions } });
  }
  console.log(
    `jev-eval · sets: ${setNames.map((s) => `${s}(${counts[s]})`).join(" · ")}${args.dryRun ? " · dry-run" : ""}`,
  );
  if (args.dryRun) {
    for (const item of dryFirst) {
      console.log(`\n── ${item.set} · first batch (${item.id}) ──`);
      console.log(JSON.stringify(item.request, null, 2));
    }
    console.log("\n(dry-run: no network. Real runs need credentials; E0 fills docs/dev/memory/eval/jev-baseline.md)");
    return;
  }
  const provider = args.model.split("/")[0];
  const apiKey =
    provider === "opencode"
      ? process.env.OPENCODE_API_KEY
      : provider === "openrouter"
        ? process.env.OPENROUTER_API_KEY
        : undefined;
  const baseUrl = PROVIDER_BASE[provider];
  if (!apiKey || !baseUrl) {
    throw new Error(
      `no credentials/baseUrl for provider "${provider}" — set OPENCODE_API_KEY or OPENROUTER_API_KEY (or use --dry-run)`,
    );
  }
  const proxy = process.env.PI_TOOLKIT_JEV_PROXY || undefined;
  const results = {};
  for (const name of setNames) {
    const cases = loadSet(name);
    const slice = args.limit === undefined ? cases : cases.slice(0, args.limit);
    let pass = 0;
    let errors = 0;
    let cost = 0;
    const misses = [];
    for (const c of slice) {
      const req = buildCaseRequest(name, c);
      const out = await classifyOnce(
        args.model,
        apiKey,
        baseUrl,
        { state: req.state, questions: req.questions },
        { proxy },
      );
      if (out.stopReason !== "stop") {
        errors += 1;
        misses.push(`${req.id}: ERROR ${out.errorMessage ?? "?"}`);
        continue;
      }
      if (out.usage?.cost?.total) cost += out.usage.cost.total;
      const verdict = req.check(out.answers);
      if (verdict.pass) pass += 1;
      else misses.push(`${req.id}: ${JSON.stringify(verdict)}`);
    }
    results[name] = { total: slice.length, pass, errors, costUsd: Number(cost.toFixed(6)), misses };
    console.log(
      `${name}: ${pass}/${slice.length} pass · ${errors} errors · $${cost.toFixed(4)}${misses.length ? `\n  misses:\n    ${misses.slice(0, 20).join("\n    ")}` : ""}`,
    );
  }
  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      args.out,
      JSON.stringify({ model: args.model, date: new Date().toISOString(), results }, null, 2) + "\n",
    );
    console.log(`results written: ${args.out}`);
  }
}

main().catch((err) => {
  console.error(`jev-eval: ${String(err)}`);
  process.exitCode = 1;
});
