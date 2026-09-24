# Consult P0-alpha Probe Results

Date: 2026-09-24
Probe: `scripts/exp/consult-fork-probe.ts`
Pi coding-agent: 0.84.4

## Summary

| Probe                   | 判定     | 关键结果                                                                                                                                         |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| α① fork 链路端到端      | **PASS** | fork 后真实回答复述随机 token；源 sha256 未变；header `parentSession` 正确；systemPrompt 组装成功                                                |
| α② provider 兼容性矩阵  | **PASS** | `cloudrouter-anthropic/claude-opus-5-5` (`anthropic-messages`)：`stopReason=stop`、新增未声明工具调用 0、token 命中；其余 8 个无认证路由 SKIPPED |
| α③ B 首请求成本         | **PASS** | 同一路由约 50k/150k 场景实际 usage cost 分别 `$0.479625` / `$1.230225`；新增不存在工具调用均为 0                                                 |
| α④ fork + open 整链耗时 | **FAIL** | 10,022,299-byte 会话文件为 102.3 ms，超过 100 ms 阈值                                                                                            |

已记录的 provider usage 费用：**$1.816981**（α② `$0.107131`+ α③`$1.709850`）。α① 的早期端到端回答未在当时的脚本输出中保留 usage，因此真实总费用只能确认**不低于 $1.816981**；没有未认证路由的探测请求。

## 载体与自测

- 通过 `npx tsx` 运行，直接 import `src/runtime/session-driver.ts` 的 `toCreateOptions`。
- fork 前预占 `globalThis[Symbol.for("pi-subagent:host")]`；用真实 `SessionManager.forkFrom`，随后 `SessionManager.open`。
- B 工具表固定为 `read`, `grep`, `find`, `ls`。探针输出的注入清单明确复刻：跳过 `message_agent`、`set_model`、嵌套 `Agent`、`StructuredOutput`、`consult`，并绕过类型 prompt 前缀。
- 每轮在会话历史中放入 `CONSULT-PROBE-<rand8>`，同时加入未声明的 `bash`、`write`、`Agent` tool_use/tool_result 历史块。
- 真实请求前执行 `npx tsx scripts/exp/consult-fork-probe.ts --offline`：源 sha256 未变、fork header 的 `parentSession` 正确；10 MB 整链为 108.8 ms，已越过阈值。
- `npx tsx scripts/exp/consult-fork-probe.ts --help` 正常输出用法。

## α① Fork 链路端到端

最终在线运行 token：`CONSULT-PROBE-F46E28FA`

```json
{
  "status": "PASS",
  "sourceSha256Unchanged": true,
  "parentSessionCorrect": true,
  "systemPromptAssembled": true,
  "activeTools": ["read", "grep", "find", "ls"],
  "answerContainsToken": true,
  "answer": "CONSULT-PROBE-F46E28FA"
}
```

源文件和 fork 均创建在运行时临时目录；fork header 的 `parentSession` 与源文件绝对路径相等。系统提示词的 `toCreateOptions` 组装及 `SessionManager.open` 均未报错。源文件 fork 前后 sha256 一致。

## α② Provider 兼容性矩阵

`ModelRuntime` 动态枚举到 9 个 API 候选。当前 pi 默认模型为 `cloudrouter-anthropic/claude-opus-5-5`，即使 registry 的 `hasConfiguredAuth()` 未将 models.json 内联 provider key 标成认证，该默认路由已由 α① 成功使用，因此作为实际可用回退执行一次 B 请求。其余候选没有 pi registry 可用认证，依纪律未硬试。

| API                       | Provider/model                             | 判定        | 原始/机械结果                                                             |
| ------------------------- | ------------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `anthropic-messages`      | `cloudrouter-anthropic/claude-opus-5-5`    | **PASS**    | `stopReason="stop"`; token 命中；新增未声明工具调用 `0`; cost `$0.107131` |
| `bedrock-converse-stream` | `amazon-bedrock/amazon.nova-2-lite-v1:0`   | **SKIPPED** | 无可用认证                                                                |
| `openai-completions`      | `ant-ling/Ling-2.6-1T`                     | **SKIPPED** | 无可用认证                                                                |
| `azure-openai-responses`  | `azure-openai-responses/gpt-4`             | **SKIPPED** | 无可用认证                                                                |
| `openai-responses`        | `cloudflare-ai-gateway/gpt-4.1`            | **SKIPPED** | 无可用认证                                                                |
| `google-generative-ai`    | `google/deep-research-max-preview-04-2026` | **SKIPPED** | 无可用认证                                                                |
| `google-vertex`           | `google-vertex/gemini-2.5-flash`           | **SKIPPED** | 无可用认证                                                                |
| `mistral-conversations`   | `mistral/codestral-latest`                 | **SKIPPED** | 无可用认证                                                                |
| `openai-codex-responses`  | `openai-codex/gpt-5.3-codex-spark`         | **SKIPPED** | 无可用认证                                                                |

计数修正说明：首次原始输出将 fork 历史的 `bash`、`write`、`Agent` 三个 tool_use 也算入本次调用。脚本现已改为只扫描 prompt 后新增消息；原始列表恰好等于这三个预埋历史项，故该真实请求的新增未声明调用数为 `0`。不为这一纯本地归因修正新增付费请求。

C1：未触发。B 形态通过机械三条件，故不需要历史引用名桩。

## α③ B 首请求成本

路由：`cloudrouter-anthropic/claude-opus-5-5` (`anthropic-messages`)；工具表仍为 B 的四件只读表。

| 场景             | 最终 usage totalTokens | usage.cost total | 新增不存在工具调用 | 判定     |
| ---------------- | ---------------------: | ---------------: | -----------------: | -------- |
| 中等，目标约 50k |                 95,763 |      `$0.479625` |                  0 | **PASS** |
| 长，目标约 150k  |                245,793 |      `$1.230225` |                  0 | **PASS** |

原始 usage 分项：

```json
{
  "50k": { "output": 0.00108, "cacheWrite": 0.478545, "total": 0.479625 },
  "150k": { "output": 0.00168, "cacheWrite": 1.228545, "total": 1.230225 }
}
```

按方案当前预检定义，长场景的实测首请求成本低于 `$2` 的 `maxFirstRequestUsd` 初始值；本次数据不足以按 P90 重定默认值，只能确认 `$2/$4` 在该路由的两个测点未被击穿。

## α④ Fork + open 整链耗时

设置：生成真实 jsonl 会话，实际大小 10,022,299 bytes；计时从 `SessionManager.forkFrom` 开始，到 fork 文件 `SessionManager.open` 完成，覆盖 SDK 源读取、fork 写入、fork 实例构造重读和 open 重读。

```json
{
  "sourceBytes": 10022299,
  "elapsedMs": 102.31293600000026,
  "thresholdMs": 100,
  "status": "FAIL"
}
```

离线重复为 108.8166 ms；此前同载体观测 104.5 ms、110.1 ms、121.2 ms、132.7 ms。最低测量仍超过阈值。按方案 §11-2，应将手写流式 fork（最多从三读降为两读）的可行性列为后续实现项；本探针不修改 `src/` 或 `tests/`。

## Verification

- `npx tsx scripts/exp/consult-fork-probe.ts --help`: PASS
- `npx tsx scripts/exp/consult-fork-probe.ts --offline`: PASS for α① structural assertions; α④ correctly reports threshold exceedance
- `npx prettier --check scripts/exp/consult-fork-probe.ts docs/dev/consult/p0-alpha-results.md`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm test`: PASS, 217 files / 3332 tests
- `npm run format:check`: FAIL only on pre-existing unformatted files: `docs/dev/consult/review-2.md`, `docs/dev/consult/review-3.md`, `docs/dev/sysprompt-stable/review-1.md`, `docs/dev/sysprompt-stable/review-2.md`. The two files delivered here pass targeted Prettier validation.

## 补充复跑（2026-09-24，主会话执行）：α② 路由矩阵补全

首跑报「8 条路由无认证」是**探针路由选择的缺陷**，已修复（见下），真实矩阵结果：

| api                | provider/model                        | 判定     | 备注                                                                                                                   |
| ------------------ | ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| anthropic-messages | cloudrouter-anthropic/claude-opus-5-5 | **PASS** | 首跑已测                                                                                                               |
| openai-responses   | cloudrouter-response/gpt-6-astra      | **PASS** | 补测                                                                                                                   |
| openai-completions | droid-completion/glm-5.2              | **PASS** | 补测                                                                                                                   |
| openai-completions | zai/glm-4.7                           | **PASS** | 补测；真实派单主力                                                                                                     |
| openai-completions | copilot-completion/kimi-k3            | FAIL     | **非 B 形态问题**：对照实验（无工具最小请求）该 provider 也返回空文本/错误，属 provider 自身不稳；B 形态判定不采信此条 |
| anthropic-messages | kimi-coding                           | 未测     | 7d 额度耗尽（quota L3 拦截）；额度恢复后可补测                                                                         |
| anthropic-messages | moonshot                              | 未测     | 当前无 agent 类型引用；首次用于专家派单前补测                                                                          |

**结论：α② PASS**（三大 api 族在可用 provider 上全部通过 B 形态三条件：stopReason=stop、未声明工具零调用、预埋 token 复述命中）。

### 探针修复（scripts/exp/consult-fork-probe.ts）

1. `hasConfiguredAuth` 不可靠（对实测可用的 cloudrouter-anthropic/zai 一律 false，只认部分凭证来源）——改为「models.json 内联 apiKey ∪ auth.json 顶层键 ∪ hasConfiguredAuth」三源并集。
2. `routes()` 曾遍历全部内置 provider（ant-ling、cloudflare-ai-gateway 等无凭证项）且按 api 先到先得——改为只遍历可用 provider。
3. 新增 `--provider P`（限定矩阵 provider）与 `--no-cost`（跳过 α③，避免重复计费）。
4. `--provider` 过滤必须在按 api 去重**之前**生效（否则 droid 会被同 api 的 copilot 去重掉）。

### α④ 复测

三次复测 102.3 / 108.8 / 124.9 / 160.1ms——波动大但持续超 100ms 阈值。按方案 §11-2 的既定决策：**包 B 的 fork-store 采用手写流式 fork**（省掉实例构造那一遍读，3→2 遍，~40 行）；若实施后仍超阈，记录为已知限制（请教是低频前台操作）。不额外升级方案。
