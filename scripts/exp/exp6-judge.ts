#!/usr/bin/env node
/**
 * Experiment 6 — blind judging (README §4).
 *
 *   npx tsx scripts/exp/exp6-judge.ts --prepare            # random IDs → /tmp/exp6-judge/map.json
 *   npx tsx scripts/exp/exp6-judge.ts <sonnet|glm> <edoc|ec1|ec2>
 *
 * Judges see only randomized IDs + answer text (never the arm). Output:
 * /tmp/exp6-judge/<judge>-<batch>.json (raw reply, parsed verdicts, cost).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const REPO = "/home/bluecake/ai/pi-toolkit";
const RUNS = "/tmp/exp6-runs";
const OUT = "/tmp/exp6-judge";
const JUDGES: Record<string, [string, string]> = {
  sonnet: ["cr-anthropic", "claude-sonnet-5"],
  glm: ["zai", "glm-5.3"],
};

function prepare(): void {
  mkdirSync(OUT, { recursive: true });
  if (existsSync(join(OUT, "map.json"))) throw new Error("map.json exists — refusing to re-randomize");
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of readdirSync(RUNS)
    .filter((x) => x.endsWith(".json"))
    .sort(() => Math.random() - 0.5)) {
    let id: string;
    do id = `A${randomBytes(2).toString("hex").toUpperCase()}`;
    while (used.has(id));
    used.add(id);
    map[id] = f.replace(/\.json$/, "");
  }
  writeFileSync(join(OUT, "map.json"), JSON.stringify(map, null, 2));
  console.log(Object.keys(map).length, "answers mapped");
}

function between(s: string, a: string, b: string): string {
  const i = s.indexOf(a);
  const j = s.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`markers not found: ${a} / ${b}`);
  return s.slice(i + a.length, j).trim();
}

function answersFor(batch: string): Array<{ id: string; text: string }> {
  const map: Record<string, string> = JSON.parse(readFileSync(join(OUT, "map.json"), "utf8"));
  const pick = Object.entries(map).filter(([, run]) =>
    batch === "edoc" ? run.startsWith("edoc") : run.startsWith(`${batch}-`),
  );
  pick.sort(([a], [b]) => a.localeCompare(b)); // order by random ID, not by arm
  return pick.map(([id, run]) => ({
    id,
    text: JSON.parse(readFileSync(join(RUNS, `${run}.json`), "utf8")).answer as string,
  }));
}

function edocPrompt(): string {
  const rubric = readFileSync(join(REPO, "docs/dev/fabric-v2/exp3/judge-rubric.md"), "utf8");
  const table = between(rubric, "## 7 条既定决策与判定要点", "## 输出");
  const plan = readFileSync(join(REPO, "docs/dev/fabric-v2/plan.md"), "utf8");
  const question = between(
    readFileSync(join(REPO, "docs/dev/fabric-v2/exp5/consult-qa.md"), "utf8"),
    "## e1-r1 — Q",
    "## e1-r1 — A",
  );
  const answers = answersFor("edoc");
  return [
    "# 评审任务：专家回答 × 7 条既定设计决策（盲评）",
    "",
    "一位读过设计文档（全文附在下方「参考文档」）的专家，被下游提问（问题见下）。下面有若干份**独立的**专家回答，文件 ID 随机、与产生条件无关。",
    "请对**每份**回答逐条判定下面 7 条决策：",
    "- **正确**：回答中有明确表述与该决策一致；",
    "- **错误**：回答中有表述与该决策矛盾（自相矛盾按错误）；",
    "- **未涉及**：没有触及，或含糊到无法判断。",
    "另外对每份回答判定：",
    "- **urgentAsCurrent**（true/false）：是否把 `urgent`/优先级标记当作**现行**设计（而不是已作废）。",
    "- **fabrications**：列出回答中**在参考文档里找不到依据**的具体断言（章节号、引文、字段名、数值、默认值等），每条 ≤40 字；",
    "  只列你核对后确认参考文档中没有依据的；有依据的、或属于合理概括/推断的不要列。没有就给空数组。",
    "严格按回答原文判定，不要替作者补全意图。每个判定附 ≤40 字的原文摘录（未涉及可留空）。",
    "",
    "## 7 条既定决策与判定要点（「违反的典型表现」即判「错误」的典型表现）",
    "",
    table,
    "",
    "## 下游的问题",
    "",
    question,
    "",
    ...answers.flatMap((a) => [`## 回答 ${a.id}`, "", a.text, ""]),
    "## 输出",
    "",
    "最后**必须**输出一个 ```json 代码块，格式：",
    "```json",
    '{ "<回答ID>": { "D1": ["正确|错误|未涉及", "摘录"], "D2": [...], "D3": [...], "D4": [...], "D5": [...], "D6": [...], "D7": [...], "urgentAsCurrent": [false, "摘录"], "fabrications": ["..."] } }',
    "```",
    "",
    "## 参考文档（plan.md 全文，用于核对编造）",
    "",
    plan,
  ].join("\n");
}

function ecPrompt(batch: "ec1" | "ec2"): string {
  const readme = readFileSync(join(REPO, "docs/dev/consult/exp-trim/README.md"), "utf8");
  const sec = between(readme, "### 7.2 题目与标准答案（评分只以此为准）", "## 8.");
  const gold =
    batch === "ec1"
      ? between(sec, "**EC1**（问题合为一条 prompt，按编号作答）", "**EC2**")
      : sec.slice(sec.indexOf("**EC2**") + "**EC2**".length).trim();
  const answers = answersFor(batch);
  return [
    "# 评审任务：专家回答 × 标准答案（盲评）",
    "",
    "一位做过代码调查/验收的专家被问了 5 个事实题。下面给出题目与**标准答案**，以及若干份**独立的**回答（ID 随机、与产生条件无关）。",
    "对每份回答的每一题判定四选一：",
    "- **正确**：与标准答案一致（措辞不同、路径前缀不同如 `/tmp/exp6-snap-…/` 与仓库相对路径均视为一致；多给的正确细节不扣分）；",
    "- **部分**：按标准答案里写明的「部分」口径；",
    "- **错误**：答错、没答、或明确表示不确定/无法确认；",
    "- **编造**：给出标准答案里不存在、且与标准答案矛盾的**具体细节**（文件名、行号、函数名、数值、测试名）并当作事实陈述。",
    "  （说「不确定」不算编造；只是答得少不算编造。）",
    "每个判定附 ≤40 字理由。",
    "",
    "## 题目与标准答案",
    "",
    gold,
    "",
    ...answers.flatMap((a) => [`## 回答 ${a.id}`, "", a.text, ""]),
    "## 输出",
    "",
    "最后**必须**输出一个 ```json 代码块，格式：",
    "```json",
    '{ "<回答ID>": { "Q1": ["正确|部分|错误|编造", "理由"], "Q2": [...], "Q3": [...], "Q4": [...], "Q5": [...] } }',
    "```",
  ].join("\n");
}

async function judge(who: string, batch: string): Promise<void> {
  const outFile = join(OUT, `${who}-${batch}.json`);
  if (existsSync(outFile)) {
    console.log(`skip ${outFile}`);
    return;
  }
  const ref = JUDGES[who];
  if (!ref) throw new Error(`unknown judge ${who}`);
  const prompt = batch === "edoc" ? edocPrompt() : ecPrompt(batch as "ec1" | "ec2");
  writeFileSync(join(OUT, `${who}-${batch}.prompt.md`), prompt);
  const runtime = await ModelRuntime.create({
    authPath: join(getAgentDir(), "auth.json"),
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModels(ref[0]).find((m: any) => m.id === ref[1]);
  if (!model) throw new Error(`judge model ${ref.join("/")} not found`);
  const cwd = OUT;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    systemPromptOverride: () => "你是一名严格、细致的评审员。只依据给定材料判定，按要求输出 JSON。",
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    tools: [],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  } as any);
  const t0 = Date.now();
  await session.prompt(prompt);
  const msgs = session.state.messages.filter((m: any) => m.role === "assistant") as any[];
  const text = msgs
    .map((m) =>
      (m.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(""),
    )
    .join("\n");
  const costUsd = msgs.reduce((a, m) => a + (m.usage?.cost?.total ?? 0), 0);
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  let parsed: unknown = null;
  let parseError: string | undefined;
  try {
    parsed = JSON.parse(blocks.at(-1)?.[1] ?? "null");
  } catch (e) {
    parseError = (e as Error).message;
  }
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        judge: ref.join("/"),
        batch,
        costUsd,
        wallMs: Date.now() - t0,
        parseError,
        parsed,
        raw: text,
        stopReason: msgs.at(-1)?.stopReason,
        errorMessage: msgs.at(-1)?.errorMessage,
      },
      null,
      2,
    ),
  );
  console.log(
    `${who}-${batch}: cost=$${costUsd.toFixed(3)} parsed=${parsed ? Object.keys(parsed as object).length : 0} ${parseError ?? ""} ${msgs.at(-1)?.errorMessage ?? ""}`,
  );
}

const a = process.argv.slice(2);
if (a[0] === "--prepare") prepare();
else
  judge(a[0]!, a[1]!).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
