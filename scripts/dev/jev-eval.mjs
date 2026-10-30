#!/usr/bin/env node
/**
 * jev-eval — J0 交付的质量评测脚本（jev-plan §4 J0 第 5 条；arch §10「质量评测」，Tier 3）。
 *
 * 四个数据集（docs/dev/memory/eval/*.json，已人工脱敏）：
 *   recall 40 例（含指代型消息、core 重复注入反例）· gate 38 例（每条真实守护规则 ×
 *   一次待执行工具调用 × 现场证据）· tag 30 例 · review 30 对（六种关系 choice）。
 *
 * gate/review 的期望值与架构稿一致（§6.4.3 / §6.3.3）：gate 期望是分类器给出的关系
 * choice（unrelated / applies / violates_now，评分按 §6.4.4 判定表），review 期望是
 * p<n> 的关系 choice。因此数据集自带规则正文/证据（gate）与 a/b 日期（review），
 * 不再需要合成通用规则，也不再合并 hold / hold-evidence 两档。
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

/** 门禁问题（arch §6.4.3：每个守护条目一个 choice，字面与
 * src/memory/jev/questions.ts 的 buildGateQuestions 逐字一致——parity 测试钉住）。
 * `state` 是评测样例的现场证据（tool / command / programs / running / branch /
 * staged / session），`guardEntries` 是该样例那一条真实守护规则（id = 样例 id）。
 */
export function buildGateQuestions(state, guardEntries) {
  const questions = {};
  for (const e of guardEntries) {
    const anchor = e.heading ? `${e.file} › ${e.heading}` : e.file;
    const authorityLabel = e.authority === "user" ? "user rule" : "assistant lesson";
    questions[e.id] = {
      type: "choice",
      instructions:
        `Project rule (${authorityLabel}) from ${anchor}: 「${e.excerpt}」 ` +
        "How does this rule relate to the pending tool call described in state?",
      criteria: {
        unrelated: "The rule does not cover this tool call",
        applies: "The rule covers this kind of action; the assistant must review the rule before running it",
        violates_now:
          "The rule covers this action AND its condition holds right now according to state, so running it now would break the rule",
      },
    };
  }
  return questions;
}

export function buildGateState(command, toolName = "bash") {
  return { tool: toolName, command, programs: [], running: [], session: "main" };
}

/** 从命令文本推「程序 子命令」形状（arch §6.4.4 的 `shape`，如 `["git commit"]`）：
 * 跳过前导 `VAR=value` / `env` / `sudo` / `timeout <dur>`，取程序 basename，紧邻的
 * 非选项 token 当作子命令。只用于 state 展示，不参与评分。 */
export function commandShape(command) {
  const tokens = String(command).trim().split(/\s+/u).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(t) || t === "env" || t === "sudo" || t === "command") {
      i += 1;
    } else if (t === "timeout") {
      i += 2;
    } else {
      break;
    }
  }
  const program = tokens[i];
  if (program === undefined) return [];
  const name = program.split("/").pop();
  const next = tokens[i + 1];
  const isPlain = next !== undefined && !next.startsWith("-") && !/^["']/u.test(next);
  return isPlain ? [`${name} ${next}`] : [name];
}

/** 打标核心 5 题（arch §6.2.2 m_*，字面与 questions.ts 的 buildTagCoreQuestions
 * 逐字一致——parity 测试钉住）。t_ 与 c 系列问题需要项目 taxonomy/比较候选，评测数据集
 * 没有，所以本评测只跑这 5 题，用 type/importance 两项打分。 */
const ENTRY_TYPE_DESCRIPTIONS = {
  rule: "A rule, requirement or prohibition the assistant must follow.",
  pitfall: "A known pitfall, failure cause or workaround.",
  procedure: "Steps of a workflow to perform.",
  preference: "The user's personal preference or communication style.",
  fact: "Background fact about the project or environment.",
  pointer: "Only points to another document or file.",
};

export function buildTagCoreQuestions() {
  return {
    m_type: {
      type: "choice",
      instructions: "What kind of project-memory entry is this?",
      criteria: { ...ENTRY_TYPE_DESCRIPTIONS },
    },
    m_importance: {
      type: "score",
      instructions: "How costly is it for the assistant to ignore this entry?",
      criteria: [
        "background",
        "useful",
        "important: ignoring causes rework",
        "critical: ignoring causes an incident or violates an explicit user order",
      ],
    },
    m_guard: {
      type: "bool",
      instructions:
        "Does this entry restrict, or require checks before, a dangerous or irreversible action (push, release, delete, history rewrite, dependency change, credential use, dispatching agents)?",
      criteria: { true: "Yes, it guards such an action", false: "No" },
    },
    m_temporal: {
      type: "choice",
      instructions: "Is this entry permanent or temporary?",
      criteria: {
        permanent: "Holds until someone changes it",
        dated: "Temporary, tied to a date or period",
        event: "Temporary, until some event happens",
      },
    },
    m_userlike: {
      type: "bool",
      instructions:
        "Does this entry read like an order, ruling or preference stated by the user (not a lesson the assistant learned)?",
      criteria: { true: "User order/ruling/preference", false: "Assistant's own lesson or fact" },
    },
  };
}

export function buildTagQuestions(entry) {
  return buildTagCoreQuestions(entry);
}

export function buildTagState(entry) {
  return {
    entry: entry.body,
    file: entry.file ?? "(new)",
    heading: entry.heading ?? "",
    today: new Date().toISOString().slice(0, 10),
  };
}

/** 整理建议问题（arch §6.3.3 p<n>/o<n>，字面与 questions.ts 的
 * buildReviewQuestions 逐字一致——parity 测试钉住）。pair 的 updatedAt 由调用方
 * 给出：jev-review.json 的 a/b 可带 `updated`，缺省按 today 代入。 */
export function buildReviewQuestions(project, today, pairs, staleCands = []) {
  const questions = {};
  for (const p of pairs) {
    questions[p.id] = {
      type: "choice",
      instructions:
        `Entry A (${p.a.file}, updated ${p.a.updatedAt}): 「${p.a.excerpt}」. ` +
        `Entry B (${p.b.file}, updated ${p.b.updatedAt}): 「${p.b.excerpt}」. ` +
        "What is the relation between A and B?",
      criteria: {
        unrelated: "Different topics",
        duplicate: "Same content; one can be removed",
        conflict: "They contradict and neither clearly replaces the other",
        a_supersedes_b: "A is newer/authoritative and makes B obsolete",
        b_supersedes_a: "B is newer/authoritative and makes A obsolete",
        complementary: "Related; both needed",
      },
    };
  }
  for (const o of staleCands) {
    questions[o.id] = {
      type: "bool",
      instructions:
        "Given today's date in state, is this temporary entry likely obsolete now? " +
        `Entry (updated ${o.updatedAt}, temporal: ${o.temporal}): 「${o.excerpt}」`,
      criteria: { true: "Likely obsolete; ask the user to confirm removal", false: "Still likely valid" },
    };
  }
  return questions;
}

export function buildReviewState(project, today) {
  return { project, today };
}

// ───────────────────── 数据集 ─────────────────────

const SETS = ["recall", "gate", "tag", "review"];

/** 门禁关系（arch §6.4.3 的 choice 选项）与整理关系（arch §6.3.3 的 p<n> 选项）。
 * 数据集里写错选项名时在构造阶段就报错，而不是跑完才变成“全错”。 */
const GATE_RELATIONS = ["unrelated", "applies", "violates_now"];
const REVIEW_RELATIONS = ["unrelated", "duplicate", "conflict", "a_supersedes_b", "b_supersedes_a", "complementary"];
/** 门禁阈值（arch §6.4.4 `memory.jev.gate.threshold` 默认值）。 */
const GATE_THRESHOLD = 0.6;

function assertRelation(setName, c) {
  const allowed = setName === "gate" ? GATE_RELATIONS : REVIEW_RELATIONS;
  if (!allowed.includes(c.expected)) {
    throw new Error(`${setName} case ${c.id}: expected must be one of ${allowed.join("|")}, got ${c.expected}`);
  }
}

/** jev-gate.json 样例 → arch §6.4.3 的 state：命令形状（programs）+ 现场证据
 * （running / branch / staged；staged 仅在有值时带上，同 arch §6.4.2）。 */
function buildGateCaseState(c) {
  const evidence = c.evidence ?? {};
  const staged = evidence.staged ?? [];
  return {
    ...buildGateState(c.command, c.tool ?? "bash"),
    programs: commandShape(c.command),
    running: evidence.running ?? [],
    ...(evidence.branch === undefined ? {} : { branch: evidence.branch }),
    ...(staged.length === 0 ? {} : { staged }),
  };
}

function loadSet(name) {
  const raw = JSON.parse(readFileSync(join(EVAL_DIR, `jev-${name}.json`), "utf8"));
  if (raw.set !== name) throw new Error(`jev-${name}.json: expected set ${name}, got ${raw.set}`);
  return raw.cases;
}

/** 为一个数据集样例构造一次 classify 调用的 {state, questions, check}。
 * 导出供本地自检（`--dry-run` 与离线验评分规则）；不是出题模板，不受 parity 测试约束。 */
export function buildCaseRequest(setName, c) {
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
      assertRelation("gate", c);
      const id = c.id;
      const guardEntries = [
        {
          id,
          file: c.rule.file,
          heading: c.rule.heading,
          authority: c.rule.authority,
          excerpt: c.rule.excerpt,
        },
      ];
      const state = buildGateCaseState(c);
      return {
        id,
        state,
        questions: buildGateQuestions(state, guardEntries),
        // 评分只看关系（arch §6.4.4）：a=P(applies)、v=P(violates_now)，阈值 0.6。
        // 期望 unrelated ⇒ a+v<0.6；applies ⇒ a+v≥0.6 且 v<0.6；violates_now ⇒ v≥0.6。
        check: (answers) => {
          const a = answers[id]?.probabilities?.applies ?? 0;
          const v = answers[id]?.probabilities?.violates_now ?? 0;
          const pass =
            c.expected === "unrelated"
              ? a + v < GATE_THRESHOLD
              : c.expected === "applies"
                ? a + v >= GATE_THRESHOLD && v < GATE_THRESHOLD
                : v >= GATE_THRESHOLD;
          return { a, v, choice: answers[id]?.choice, pass };
        },
      };
    }
    case "tag": {
      const qs = buildTagQuestions(c.entry);
      return {
        id: `t_${c.id}`,
        state: buildTagState(c.entry),
        questions: qs,
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
      assertRelation("review", c);
      const id = `p_${c.id}`;
      const today = new Date().toISOString().slice(0, 10);
      const pair = {
        id,
        a: { file: c.a.file, updatedAt: c.a.updated ?? today, excerpt: c.a.excerpt },
        b: { file: c.b.file, updatedAt: c.b.updated ?? today, excerpt: c.b.excerpt },
      };
      return {
        id,
        state: buildReviewState("pi-toolkit", today),
        questions: buildReviewQuestions("pi-toolkit", today, [pair]),
        // 直接比对关系 choice（arch §6.3.3 的六个选项）。
        check: (answers) => {
          const choice = answers[id]?.choice;
          return { p: answers[id]?.probabilities?.[choice] ?? 0, choice, pass: choice === c.expected };
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
    // 全量构造：dry-run 也把每个样例跑一遍构造/校验路径（选项名、必填字段、state 组装）。
    const requests = cases.map((c) => buildCaseRequest(name, c));
    dryFirst.push({
      set: name,
      id: requests[0].id,
      count: requests.length,
      request: { state: requests[0].state, questions: requests[0].questions },
    });
  }
  console.log(
    `jev-eval · sets: ${setNames.map((s) => `${s}(${counts[s]})`).join(" · ")}${args.dryRun ? " · dry-run" : ""}`,
  );
  if (args.dryRun) {
    for (const item of dryFirst) {
      console.log(`\n── ${item.set} · first batch (${item.id}) · ${item.count} cases ──`);
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

// Only run as a CLI entry point — importing this module for the parity test
// (tests/memory/jev/questions-eval-parity.test.ts) must not trigger a run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`jev-eval: ${String(err)}`);
    process.exitCode = 1;
  });
}
