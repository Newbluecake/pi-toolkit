# topic-switch judge eval

离线评测 harness，针对 2026-10-16 用户报告的问题：长单仓会话里 v1 判据几乎全
`related`（含「cache ttl ping支持哪些模型」这种 repo+memory 即可回答的新任务），导致
topic-switch 从不建议换会话。目的：对比 `v1`（现行判据）与 `v2`（会话内状态判据，
`src/topic-switch/judge.ts` 的 `buildJudgePrompt(i, "v2")`）在真实历史请求上的准确率。

**线上现状（2026-10-16 起）**：评测后用户拍板，线上默认判据切到 `v2`（`JUDGE_DEFAULT_VARIANT`），
`JUDGE_MAX_TOKENS` 64→512（64 时 glm-5.3-flash 20–33% 调用空回复/截断）。`v1` 保留供对比。
默认输出落在 `docs/dev/topic-switch/judge-eval/`；本轮标注集 `labelled.jsonl`（24 条）。

## 1. extract.mjs — 从 session 文件抽数取候选

```sh
npx tsx scripts/exp/topic-judge-eval/extract.mjs            # 本仓库默认 session 目录，最新 10 个主会话
npx tsx scripts/exp/topic-judge-eval/extract.mjs --limit 8  # 最新 8 个
npx tsx scripts/exp/topic-judge-eval/extract.mjs <文件或目录...> --out <path>
```

对每个**真人输入的**用户请求重建 live judge 当时看到的精确 `JudgeInput`：

- 分支 = 从该消息的 `parentId` 沿树回溯到根（即请求到达那一刻 `getBranch()` 的结果），
  喂给**真实的** `buildBranchView`（直接 import `src/topic-switch/hold.ts`，不是复刻）；
  `sessionName` 取分支里最新 `session_info` 条目（与 `pi.getSessionName()` 同源）。
- 跳过：slash 命令（`/x`）、shell 转义（`!x`）、< 8 码点、`custom_message`/system 注入、
  extension 注入的 `[switch_context]` 交接消息、前面没有 assistant 轮的消息、整个
  `subagent:child` 子代理会话文件（目录模式下先过滤再计 `--limit`，limit 只数主会话）。
- 附加上下文列：`gapMin`（距上一条 assistant 消息的分钟数）、`cold` + `cacheRead`/
  `cacheWrite`（下一轮 assistant 的缓存命中；cold ⇔ `cacheRead ≤ 1024` tokens，全新写入
  如 `{input:4, cacheWrite:75610}` 即 cold；无 usage ⇒ `cold: null`）、`liveOutcome`
  （请求前分支里最近一条 `subagent:topic-switch` outcome 记录，含 outcome/confidence/estUsd）。

输出 `candidates.jsonl`（请求原文保留——这是本机用户自己的数据），每行
`{id, sessionFile, at, gapMin, cold, liveOutcome?, input, label: null, note: ""}`。

## 2. 人工打标（主会话自己做，脚本不代劳）

把 `candidates.jsonl` 复制一份，逐条填 `label`：

- `true` = 答好它**必须**依赖本会话自身状态（judge 应答 related）；
- `false` = repo 文件 + 项目记忆就能答好（judge 应答 unrelated）；
- `note` 随手写理由。`label: null` 的行 run.mjs 会跳过并计数。

## 3. run.mjs — 打标集 × 模型 × 判据版本

```sh
npx tsx scripts/exp/topic-judge-eval/run.mjs <labelled.jsonl> \
  [--models zai-coding-cn/glm-5.3-flash,deepseek/deepseek-flash] \
  [--variants v1,v2] [--concurrency 3] [--timeout-ms 30000] [--max-tokens 512]
```

- 模型注册/鉴权与 live 完全一致：`ModelRuntime.create({authPath/modelsPath:
~/.pi/agent})`（pi 自己的注册表），`complete(model, {systemPrompt, messages},
{maxTokens: JUDGE_MAX_TOKENS, signal})`，回复用真实 `parseJudgeReply` 解析。
- 单次调用失败/超时/解析失败记为 `{error}`，绝不让整轮崩掉（解析失败即线上 `judge-parse`
  的同款行为：`JUDGE_MAX_TOKENS=64` 下截断 JSON 是真实会发生的）。
- 汇总表：每 model × variant 的 accuracy、`false-rel`（该建议换会话却答 related = 漏报）、
  `false-unrel`（不该换却答 unrelated = 误报）；另打逐 case 行，并写
  `results-<date>.json`。

## 为什么用 `npx tsx` 而不是 `node --experimental-strip-types`

两个脚本要 import `src/**/*.ts`，而 src 内部相对导入全部带 `.js` 后缀（ESMLoader
约定），plain node 的 strip-types 不做 `.js → .ts` 路径重写，解析会失败；tsx 能。与
`scripts/exp/exp6-judge.ts`、`consult-fork-probe.ts` 的既有先例一致。

## 冒烟结果（2026-10-16，3 个人工打标 case，真实模型调用）

用户报告的那条（label=false）在 v1 下两模型都答 `related`（conf .85/.95，复现线上误判），
v2 下都答 `unrelated`；两条 label=true 的延续性请求 v1/v2 基本都答对；glm v2 有一次
`parse-error`（截断 JSON，与线上 `judge-parse` 同款）。详见
`docs/dev/topic-switch/judge-eval/results-2026-10-16.json`。

## 2026-10-16 正式评测（24 条，labelled.jsonl，每组合两轮）

| 模型 / 判据           | 准确率 | 漏报 | 误报 | 调用失败 |
| --------------------- | ------ | ---- | ---- | -------- |
| glm-5.3-flash v1 @64  | 71–74% | 5–6  | 0    | 3–5      |
| glm-5.3-flash v1 @512 | 63%    | 9    | 0    | 0        |
| glm-5.3-flash v2 @512 | 79–83% | 4    | 0–1  | 0        |
| deepseek-flash v1 @64 | 67–71% | 7–8  | 0    | 0        |
| deepseek-flash v2 @64 | 75–79% | 5    | 0–1  | 0        |

glm v2 @512 延迟 p50 2.4s / p90 4.4s。注意评测用 30s/次超时，而线上每个模型只有
`min(剩余, max(1500, ceil(judgeTimeoutMs/2)))` = 3s：约 1/3 的 glm 调用会在线上超时回落
deepseek-flash（v2 下 75–79%），所以线上实际准确率介于两行之间。表中数字取自当天终端输出；
`results-*.json` 每次运行覆盖、不入库（.gitignore）。
