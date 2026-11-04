/**
 * jev-reflex · builtin script catalog (plan R1 step 5; arch §4.5). Four readonly MVP scripts;
 * every script's `examples` are the unit-test corpus (hit ⇒ high for THAT script, miss never
 * high anywhere) — the arch §4.5 table sentences are all present verbatim.
 *
 * Strong sources are whole-sentence templates over the NORMALIZED text and are implicitly
 * anchored (`^…$`, match.ts); weak/exclude are substring anchors. No `/g`, no nested
 * quantifiers — `validateCatalog` at module load refuses anything else (R-I12).
 */

import type { RScriptV1 } from "./types.js";
import { validateCatalog } from "./schema.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_SCRIPTS: readonly RScriptV1[] = deepFreeze([
  {
    schema: "rscript/1",
    id: "jobs.list",
    version: 1,
    origin: "builtin",
    risk: "readonly",
    intent: {
      strong: [
        "后台还有几个 ?job",
        "后台(还有|有)多少 ?job",
        "(现在)?后台(还)?有几个任务(在跑)?",
        "有后台任务在跑(吗)?",
        "后台任务状态(如何|怎么样)?",
        "bash jobs?",
      ],
      weak: ["job", "后台任务"],
      exclude: ["停", "杀", "kill", "放后台", "日志", "log", "新开", "新起", "再开"],
      examples: {
        hit: ["后台还有几个 job", "有后台任务在跑吗", "bash jobs", "后台任务状态", "现在后台有几个任务在跑"],
        miss: [
          "把后台 job 都停了",
          "那个 job 完成了吗",
          "跑一下测试放后台",
          "后台 job 的日志给我看下",
          "新开一个后台任务",
        ],
      },
    },
    port: { id: "jobs.list" },
    requires: ["bashJobs"],
    render: { title: "bash jobs", emptyText: "当前没有后台任务", maxLines: 16 },
    agreement: { tools: ["bash_job:list", "bash_job:status"], bashShapes: [] },
  },
  {
    schema: "rscript/1",
    id: "fleet.status",
    version: 1,
    origin: "builtin",
    risk: "readonly",
    intent: {
      strong: [
        "有几个 ?subagent ?(正)?在跑",
        "subagent ?都?在跑(吗)?",
        "子 ?agent ?(的)?状态(如何)?",
        "(现在|目前)?有哪些 ?agent ?(正)?在?跑",
        "(现在)?有几个 ?agent ?在?跑(吗)?",
        "fleet (状态|status)",
      ],
      weak: ["subagent", "agent", "子代理"],
      exclude: ["派", "停", "创建", "新开", "新建", "报告", "结果", "日志"],
      examples: {
        hit: [
          "有几个 subagent 在跑",
          "子 agent 状态",
          "现在有哪些 agent 在跑",
          "subagent 都在跑吗",
          "现在有几个 agent 在跑",
        ],
        miss: [
          "派个 agent 去查",
          "停掉所有 agent",
          "agent 跑完了吗他说了啥",
          "新开一个 agent",
          "帮我看看 agent 的报告",
        ],
      },
    },
    port: { id: "fleet.status" },
    requires: ["fleet"],
    render: { title: "fleet", emptyText: "当前没有在跑的 subagent", maxLines: 12 },
    agreement: { tools: ["get_run_result", "list_subagents"], bashShapes: [] },
  },
  {
    schema: "rscript/1",
    id: "quota.summary",
    version: 1,
    origin: "builtin",
    risk: "readonly",
    intent: {
      strong: [
        "额度(还)?剩多少",
        "还剩多少额度",
        "额度(已经)?用了多少(了)?",
        "quota ?还有多少",
        "quota (剩余|余量|还剩多少)",
        "\\d+h ?额度(用了|还?剩)多少",
        "\\d+小时 ?额度(用了|还?剩)多少",
      ],
      weak: ["额度", "quota"],
      // 费用 ≠ 额度（arch §4.5）：花钱/换模型/重置时间都不是额度读数。
      exclude: ["换", "不够", "重置", "花"],
      examples: {
        hit: ["额度还剩多少", "quota 还有多少", "5h 额度用了多少", "还剩多少额度", "额度用了多少了"],
        miss: ["额度不够了换个模型", "这周花了多少钱", "额度什么时候重置", "换个便宜点的模型跑", "这个月花了多少钱"],
      },
    },
    port: { id: "quota.summary" },
    requires: ["quota"],
    render: { title: "quota", emptyText: "没有可信的额度快照", maxLines: 8 },
    // 模型没有额度工具：shadow 比对按 no-tool 统计（arch §4.5 表）。
    agreement: { tools: [], bashShapes: [] },
  },
  {
    schema: "rscript/1",
    id: "git.status",
    version: 1,
    origin: "builtin",
    risk: "readonly",
    intent: {
      strong: [
        "工作区干净(吗)?",
        "git status",
        "(有没有|没有|有)?未提交的改动(吗)?",
        "(当前|现在)?分支是什么",
        "(当前|现在)?在哪个分支",
        "(当前|现在)?是哪个分支",
      ],
      weak: ["干净", "未提交", "分支", "git status", "工作区"],
      exclude: ["回滚", "回退", "git log", "git diff", "提交一下", "提交吧", "提交了"],
      examples: {
        hit: ["工作区干净吗", "git status", "有未提交的改动吗", "当前分支是什么", "有没有未提交的改动"],
        miss: ["把改动提交了", "回滚工作区", "这些改动对吗", "git log 看一下", "帮我提交一下"],
      },
    },
    port: { id: "git.status" },
    requires: ["git"],
    render: { title: "git", emptyText: "工作区干净，无未提交改动", maxLines: 16 },
    agreement: { tools: [], bashShapes: ["git status", "git diff"] },
  },
] as RScriptV1[]);

// R-I12 / catalog self-check: refuse to load anything schema-invalid, duplicate, extracted,
// over-budget, or carrying a regex shape we forbade. Deterministic one-shot call — no state.
validateCatalog(BUILTIN_SCRIPTS);
