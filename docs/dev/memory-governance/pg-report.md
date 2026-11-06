# #36 PG · G1 / G2 离线门禁工具交付

## 状态

**NOT-EVALUATED；P5b 仍 BLOCKED。** 本报告是脚本、离线测试和执行方法的阶段交付，不是 G1/G2 达标证明。candidate 阶段没有启动真实模型请求；后续 root 授权的一次 G2 live 已执行但因 harness 错误失败，见下方现场记录。未修改生产源码、真实记忆、设置、标签或 fixtures。

- G1：v3 已冻结，正式可计入 negative 76（AA 40 / UU 20 / UA 16）、positive **10**，另有 20 条 `expected:excluded` 审计行不计 primary。正例不足，脚本在发请求前返回 2；没有花 G1 live 预算。正式门槛不变：困难负例 ≥60（AA ≥30 / UU ≥15 / UA ≥15）、明确正例 ≥20；误自动取代率 ≤1/60，且 AA 为零；正例自动取代召回 ≥50%。未裁定的 moderate 样本不能充作明确正例。
- G2：第三方已条件认可 37 个真实主用户轮、40 个相关性 pair；覆盖 19/34 个 topic 用户令。`g2-turns.jsonl` 已确认的 SHA256：`18ab31816ac7e1e519f299aaf6642a4d6c812c02ca506ba5dabb39b438939a1f`。这仅是标注/来源验收，不是召回结果。
- G2 正式评测必须开启 **U + P2（`predict.model.enabled=true`）**。规则 P/model-off 只能作为额外消融，不能解锁 P5b。
- G1/G2 模型指标、逐样本预测结果、模型缓存尚未生成。数据不足、缓存缺失、请求失败或预算耗尽都不能视为通过。

## 生产构建及不可变评测版本

本包先执行了 `npm run build`。随后在其它并行任务进行后端构建前，已将当时的生产 dist 固定到独立只读目录；正式运行不得使用后来变化的仓库 `dist/`。

| 版本                         | 独立 dist                                     | JS 文件树 SHA256                                                   |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| 新管线 `efa12f26`            | `/tmp/memory36-current-efa12f26-k9A1Uh/dist`  | `fd5cacb1aec001044fd4ca086c1c12d2a52cc77ac2d839a592c553cc822d46c9` |
| 旧 files + 旧选择 `122de638` | `/tmp/memory36-baseline-122de638-a1KeOc/dist` | `dda5ad08e83ab4159258c2f65659d9aac95cd7b4855e73b7f704a725b6ddf630` |

两份 dist 的父目录均有 `memory36-baseline.json`（`commit`、`distHash`）；脚本运行前重新校验 manifest 和文件树。树哈希按相对路径排序，对所有 `.js` 文件的内容 SHA256 清单再次做 SHA256。不会把 pre-P6b 当作旧基线。

基线仅用本地 `git archive 122de638` 只读导出，软链接既有 `node_modules`，在 `/tmp` 内运行既有 TS 编译器；没有安装依赖、checkout/worktree 或 git 写操作。导出源文件及 dist 均已设为只读；依赖链接的目标未改。

复建基线的步骤（仅在已有依赖的机器执行）：

```bash
set -o pipefail
BASE=$(mktemp -d /tmp/memory36-baseline-122de638-XXXXXX)
git archive 122de638 | tar -x -C "$BASE"
ln -s /home/bluecake/ai/pi-toolkit/node_modules "$BASE/node_modules"
(cd "$BASE" && timeout 180 node node_modules/typescript-7/bin/tsc -p tsconfig.build.json) \
  2>&1 | tee /tmp/memory36-baseline-build.log
```

生成 manifest 使用脚本导出的 `treeHash(dist)`，记录 `commit: "122de638"`；新 snapshot 同理记录其真实 commit。不要通过手改 manifest 掩盖版本或文件树不一致。

## 实际管道，而非复制评分规则

### G1

从固定生产 dist 导入 `createJevWritePort`、`EntryIndex`、生产 taxonomy/tagging/redaction 和 `govern/supersede`。在按项目隔离的临时块目录运行生产 `afterWrite`；由生产构造 relation 问句、比较池、权威矩阵、阈值及每写 cap。再调用生产 `supersede`，让 active/rev/CAS/residue/dismissed 等提交条件真正执行；`wouldAuto` 来自其执行结果，不是直接比较模型概率。

`a` 是拟写入的新块，`b` 是旧块；agent 永不取代 user。脚本不复制 `SUPERSEDE_AUTO_P`、`CONFLICT_AUTO_P` 或 `AUTO_PER_WRITE_MAX` 的值。

历史正例按 root 裁定属于**真实文本的假设新增写入关系评测**，不是完整历史时间点重演：上下文只能是该 pair 所属项目的 current corpus 加该历史 b；其它项目及其它历史条目不能入池。历史 b 若与现役 ID 冲突，harness 可用生产 `nextSeq` 分配同 topic 的合法空闲 seq，并将 label ID → eval block ID、来源 hash/时间记在私有明细中。不得改正文、authority、tags、scope、residue 或 private。seq 耗尽必须阻塞。这不能被描述为这些块曾真实并存或实际发生过自动取代；现实同 ID update 不会触发该关系。

### G2

新旧两版分别导入自身的生产 `wireJev`，运行真实 `before_agent_start`，不是只调用排序函数。旧版使用导出的 byte-exact files，新版通过生产 `planMigration` 还原对应 blocks。真实旧/新侧车 tags 沿生产读取及 sanitizer 路径进入；缺少标签只能走生产 `tagOne` 的真实调用或完整缓存，不能补造。

生产 renderer 的 static/resident 信息也送入 wire，避免把已常驻条目误塞入候选池。新管线 topic 用户令入池 cap 直接读取生产 `TOPIC_USER_POOL_CAP`，不复制数值。两版使用同一 settings 派生的 U/P 预算、分类器、原始用户请求和缓存规则；按生产 eligibility、pool、P→U 去重、segment 和 commit 流程实际交付的 U/P items 计数。

每个标注轮是独立激活/空 segment 的重放，不假装恢复该历史会话的全部工具、todo、git、冷却或压缩状态。两版使用独立的生产 P2 日账，评测期间不重置/放大 cap。G2 只用 current 项目 corpus，不把新增历史 G1 条目当作候选。

分母是标注的 **（轮，相关 topic 用户令）pair**；不按「至少命中一条的轮数」计算，不把多余注入记为命中。要求新召回 ≥旧召回且 ≥60%。

## 缓存、超时和隐私

- 没有 `PI_TOOLKIT_MEMORY36_GATE_LIVE=1`：不构造真实模型 runtime/transport；不请求分类、chat、远端 catalog 或认证刷新；只允许完全缓存重放。缺少 catalog、完整 answer、DTO 或 provenance 返回非零及 NOT-EVALUATED。
- 分类缓存键覆盖 namespace、模型语义指纹、完整生产 state/questions；chat 缓存键覆盖模型语义、价目、system、生产 DTO、模型选项。日期如存在于 state/system/DTO 中仍属于键。只有未传给模型文本的测量 timestamp 不进 chat 键。
- 缓存记录实测延迟，重放时保留延迟，不能用 instant response 掩盖 U/P 窗口或旧 P2 的超时；同 DTO 可共享回答，差异 DTO 必须独立真实取得。分类失败/缺题不会变成 false 标签。
- 全链 deadline + abort race；provider 忽略 abort 也不能延长脚本生命周期。请求有逐次 timeout、总调用预算和保守金额预留；达到 cap 则 NOT-EVALUATED，不清日账凑通过。
- 真实调用只用现有 pi `ModelRuntime` 和只读 credential store，不登录、不写凭证、不自动安装或刷新 catalog。所有新增临时文件/缓存/明细只在私有评测目录或 `/tmp`。
- 外发正文通过生产字段级 redaction/截断；private/secret 整条排除。原文件、原始用户轮及来源行号仅留本地 harness；原始记忆整文件、助手消息、推理不外发。凭证及 provider 错误详情不打印。
- 仓库报告只保存聚合统计、命令、版本/hash 和局限；逐样本 verdict/映射/cache key 明细仅写私有目录。SDK 自动重试关闭（`maxRetries:0`），避免单次计数悄悄触发额外请求。

## 数据与执行

原始标注目录：`~/.pi/agent/memory-reports/eval36/`。root 确认 v3 交付结束后，已将 `corpus.json`、`g1-pairs.jsonl`、`g2-turns.jsonl`、`label-report.json` 一起冻结到私有 run 目录 `~/.pi/agent/memory-reports/eval36/runs/pg-candidate-v3/`（四文件及 `freeze.json` 均只读）；脚本必须校验四件组 hash。标注仍在补充时不能做 live。新增标签必须重新记录 label-report hash，不得在观察指标后改标签。

| 冻结文件            | SHA256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `corpus.json`       | `b6ad243148e1aa6c464071cee76873c5e0c18ffa4d1b3e1fcef3644eb03a5f04` |
| `g1-pairs.jsonl`    | `172404b47ddce3911c457bef29db64ca21f8208b7e9d0245fdddf65f8598a1d4` |
| `g2-turns.jsonl`    | `18ab31816ac7e1e519f299aaf6642a4d6c812c02ca506ba5dabb39b438939a1f` |
| `label-report.json` | `f06984a265c7de7227f6a2e608f64e0cc377ea7a0273168f8f885efce5f24ab2` |

只读 schema/重建预检：current **535** 块 / **63** 文件；G2 不含历史；两项目均无自定义 taxonomy，生产 preset rev `a13adaf2`（22 tags）匹配；37 个来源均验证为真实主用户行，标签 prompt 与原始文本或其生产脱敏结果一致。pi-toolkit 两版各 187 entries；claude2api 新版 348、旧版 359（whole 合并等差异保留，不强造一对一）。

native corpus adapter 使用 `files[].raw/sha256/mtimeMs`、`entries[].oldEntryHash/newBlockId/source/text/oldTags/newTags`，通过生产迁移 planner 复核 ID、正文、权威、scope，再建临时目录。历史 raw 来源和项目 taxonomy 必须明确可重建；缺失时先协调，不默认编造或替换。

离线完整缓存复跑（首次无缓存应返回 2，而不是 PASS）：

```bash
set -o pipefail
DATA="$HOME/.pi/agent/memory-reports/eval36/runs/pg-candidate-v3"
CURRENT=/tmp/memory36-current-efa12f26-k9A1Uh/dist
BASELINE=/tmp/memory36-baseline-122de638-a1KeOc/dist

timeout 930 env -u PI_TOOLKIT_MEMORY36_GATE_LIVE node scripts/dev/memory36-gate.mjs g1 --data "$DATA" --dist "$CURRENT" \
  2>&1 | tee /tmp/memory36-g1-offline.log

timeout 930 env -u PI_TOOLKIT_MEMORY36_GATE_LIVE node scripts/dev/memory36-gate.mjs g2 --data "$DATA" --dist "$CURRENT" \
  --baseline-dist "$BASELINE" \
  2>&1 | tee /tmp/memory36-g2-offline.log
```

以下是 candidate 阶段的预算约束；后续 root 已单独授权一次 G2 live，执行结果见下方现场记录。任何修复或追加 live 尝试仍须另行授权，不要因为出现数据文件就自动运行。候选调用参数：`--max-calls 400 --max-classifier-usd 0.5 --max-chat-calls 80 --max-chat-usd 0.28 --timeout-ms 900000`。这是硬上限，不是必须花完的目标，也不是无价目可盲发的许可。

只读预检已确认：分类器为 `opencode/jev-1.13-free` / `opencode/jev-1.13`，chat 为 `deepseek/deepseek-flash`，本地 catalog 均存在；opencode/deepseek 的只读 credential metadata 均有 stored `api_key`，未验证远端可用性。付费 classifier 的完整 contextWindow 保守预留为每次 $0.001344（free 为零），$0.5 全局 cap 最多容许 372 次该档请求；无价格/contextWindow 不能派发。37 轮双版最多 74 次单档 P2 请求（实际由生产 uncertain gate 决定；同 DTO 复用），chat 逐次使用生产估算预留；生产每版日账仍为其 settings 值，不重置。

## 自验

| 命令                                                                                                     | 结果                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `timeout 180 npm run build`                                                                              | PASS；生产构建后固定新 snapshot |
| `/tmp` 基线内 `timeout 180 node node_modules/typescript-7/bin/tsc -p tsconfig.build.json`                | PASS                            |
| `timeout 180 npm run typecheck`                                                                          | PASS                            |
| `timeout 120 npx vitest run tests/memory/govern/gate-script.test.ts tests/governance/test-tiers.test.ts` | PASS；17 + 11 tests             |
| 精确三文件 `prettier --check`                                                                            | 最终交付前记录最终结果          |

日志：`/tmp/memory36-{build,baseline-build,snapshot,readonly,typecheck,offline-tests,model-plan,credential-presence}.log`。没有运行全量测试，没有 git 写操作、安装依赖或重生 golden；测试未触发需扩展 `tests/tiers.ts` 的词法登记。

## 局限与未完成门禁

- G1 历史样本仅是文本关系压力测试，存在 harness 身份映射，不等于真实并存执行率；v3 明确正例仅 10，仍低于 20。历史 adapter 另严格检查生产 metadata：11 个 backup 导出的 created/updated 与按 raw 来源重新 plan 的时间不一致，当前该分支 fail closed；不得为此改标签或暗调时间。扩大 G1 数据后需 root 裁定/补齐时间证据并复验，当前 G1 早期样本检查已阻塞，不进入该分支；G2 不读取历史分支。
- G2 只覆盖 19/34 个 topic 用户令；独立审阅已指出弱相关、漏标和以今天规则重放历史请求的局限。不能由该集合宣称所有用户令或真实历史运行均有同样召回率。
- claude2api 被生产元数据校验排除的 11 个文件属于样本代表性风险；本包不修源。
- 原始会话工具/todo/压缩/冷却历史未完整重建，G2 是独立用户轮的生产管道重放。
- P2 金额是生产估算与保守预留，不承诺远端实际收费的绝对上界；无 usage 不按零结算，预算不足如实停止。
- 真正 G1/G2 PASS 仍缺正式 live/完整缓存指标。任何红门槛必须回到单独的 P5a-fix/P6b-fix 生产包处理，本包不调生产阈值、cap 或标签。

## 授权 G2 live 首跑记录（2026-11-06）

### 结论

**G2 NOT-EVALUATED，exit 1；整个 PG 仍因 G1 明确正例 10/20 不足而 BLOCKED。** 没有 G1 live，没有放宽门槛，没有修改脚本、测试、生产代码或标签，没有追加尝试。

root 在独立 Sonnet 安全检查后，仅授权本次 G2 执行。已新建私有目录（0700），只复制冻结四件组与 `freeze.json`（0600），确认 cache 起始为空；首次真实缓存只能由冻结脚本的 transport 生成，未手写任何模型回答。

私有原始结果目录：
`~/.pi/agent/memory-reports/eval36/runs/g2-live-20261106-71uexlor/`

- `execution-manifest.json`：授权范围、起止时间、命令约束、源文件及四件组 hash、本地 SDK 实际解析路径、只读文件前后核验、exit status。
- `command.txt`：实际执行参数。
- `aggregate.log`：本次错误栈；不含用户正文、凭证或 provider 错误响应。
- `result-summary.json`：聚合状态和不可得的计数，缺测值为 `null`，不伪造为零。
- `cache/`：只有两个本地模型 catalog 文件，**模型回答缓存为零**；没有 `g2-details.json`。

执行窗口为北京时间 **18:55:22.729–18:55:25.576**，约 2.85 秒。唯一 live 命令如下，环境开关仅作用于该进程；shell 使用 `pipefail`，通过 `tee` 保存完整聚合日志：

```bash
set -o pipefail
timeout 1000 env PI_TOOLKIT_MEMORY36_GATE_LIVE=1   node scripts/dev/memory36-gate.mjs g2   --data "$HOME/.pi/agent/memory-reports/eval36/runs/g2-live-20261106-71uexlor"   --dist /tmp/memory36-current-efa12f26-k9A1Uh/dist   --baseline-dist /tmp/memory36-baseline-122de638-a1KeOc/dist   --max-calls 400 --max-classifier-usd 0.5   --max-chat-calls 80 --max-chat-usd 0.28 --timeout-ms 900000   2>&1 | tee "$HOME/.pi/agent/memory-reports/eval36/runs/g2-live-20261106-71uexlor/aggregate.log"
```

### 首个故障及证据边界

旧基线的 P2 flight 在 `dist/memory/jev/predict/flight.js:242` 抛出：

```text
TypeError: clock.setTimer is not a function
```

故障属于 **harness 的 Clock 端口不匹配**：冻结脚本 `runTurn` 传入 `{ now, set, clear }`，而两版生产 `Clock` 使用 `setTimer/clearTimer`。生产 `createSegmentedClock` 是把 raw timer 端口转换为该接口的适配器。本次授权禁止改脚本，因此仅记录根因，不修复、不重试；该错误不是召回门槛 FAIL，也不构成 P6b 生产调参证据。

未捕获的异步 rejection 导致进程在聚合计数和逐轮结果落盘前退出。进入 flight 不等于成功完成网络响应；模型请求可能已经开始，**不能由回答缓存为空推断零网络、零调用或零费用**。

| 项目                               | 本次证据                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| 标注轮数 / 相关 pair 分母          | 37 / 40                                                                       |
| 完整完成的新旧配对轮               | 0                                                                             |
| 旧 / 新命中与召回率                | N/A / N/A；未取得完整预测，不能记成 0%                                        |
| baseline P2                        | 配置开启，进入 P2 flight；measured calls/hits、及时/迟到均未落盘              |
| current P2                         | 配置开启，但尚未执行到 current 回放；无实测 P2 证据                           |
| `chat.calls + hits > 0` 正式条件   | 未能提供有效的最终计数证据，因此不满足形式 PASS 条件                          |
| `cache.missing/failures == 0`      | 未最终落盘，不能证明为零                                                      |
| 模型回答缓存                       | 0；另有 2 个 catalog 文件                                                     |
| 实际调用 / 实际费用 / 累计保守预留 | N/A；计数器未落盘，不能虚报为零                                               |
| 剩余可确认预算                     | N/A；本次授权不用于追加尝试，不重置 ledger 或预算                             |
| 授权硬上限                         | classifier ≤400 / $0.50；chat ≤80 / $0.28；总 900 秒；provider `maxRetries:0` |

没有有效召回结果，因此本次没有可据此生成的漏召回 scope-check 清单。若未来修复 harness 后正式评测出现新管线劣于旧版或低于 60%，仍由 root 另派生产修复，不在本包调 cap/阈值。

### 版本与只读边界复核

- 冻结脚本 SHA256 仍为 `87fa2167d3cc944ced817dba76fffdadd7bd25253930a5e0304e7638663bf7e3`；测试文件 SHA256 仍为 `05566627dcdce4915eb36b29642b5a274069ca11f9bd4c3e6d3b59d9308fe199`。
- current / baseline dist 文件树 hash 与本报告上表完全一致；四件组 hash 前后不变。
- `auth.json`、`models.json`、`pi-toolkit.json` 内容 hash 前后不变；runtime 保持 `refreshOnCreate:false`、`allowModelNetwork:false` 及只读 credential store。
- 本次三包均实际解析到仓库本地 `node_modules/@earendil-works/{pi-ai,pi-coding-agent,pi-tui}/dist/index.js`，各自 package version **1.4.0**。没有把全局宿主 1.5 当成本次被验证的 SDK；本次也不提供宿主 1.5 的兼容性证明。
- 本阶段没有 build、install、全量测试、git 写操作、真实 session 消息或真实记忆写入；仅本报告增加聚合执行记录。报告精确格式检查作为本阶段自验。

## Harness 修复：Clock 契约与错误路径可审计性（2026-11-06 晚，离线包）

本节是 root 确认首跑故障报告后授权的**纯离线修复与测试**交付：无任何 LIVE 调用、无真实模型请求、无源码/设置/标签/fixture 改动、无 git 操作。上方「授权 G2 live 首跑记录」保持原文（其 SHA256 为当时事实，不回改）；私有 run 目录与冻结四件组未触碰。

### 缺陷与注入面审计

- 根因（root 已确认）：冻结脚本 `runTurn` 把 **raw timer 形状 `{now,set,clear}`** 作为 `clock` 传入两版生产 `wireJev`，而两版生产的 `Clock` 契约都是 `now/setTimer/clearTimer`（各 dist 自带 `core/clock.js` 的 `createSegmentedClock` 才是 raw→Clock 的适配器）。baseline `predict/flight.js:242` 首个 `clock.setTimer` 同步抛 `TypeError`，未捕获 rejection 终止进程。这是 **NOT-EVALUATED（harness 错误），不是模型指标 FAIL**。
- 对脚本注入生产入口的 clock/timer 做了完整静态审计：`wireJev` 的 `clock` 是**唯一**要求 Clock 契约的注入点（本次修复）；`createJevClient({now})`、`createJevWritePort({now})` 收的是普通 `() => number` 函数（各自以 `deps.now()` 调用，无 Clock 契约）；`PredictCache` 与 P2 flight 的 clock 都在生产 wire 内部由这些 deps 构建；ledger 仍按 `Symbol.for("pi-subagent:memory-predict-ledger")` 传 `Map` 表，未改。

### 修复内容（仅 `scripts/dev/memory36-gate.mjs`）

- **`productionClockPort(clockModule)`**：`runTurn` 改为注入**各版本自身 dist `core/clock.js` 导出的 `createSegmentedClock`** 在 raw 定时器（unref，I5）上的适配产物——完整同契约转换走生产实现，不是手写 rename。基座用真实墙钟：冻结的 `now` 基座会让 segmented timer 无限重挂而永不触发（变相废掉 P2 期限）；逐轮评测时刻仍由 `deps.now` 固定，二者独立。脚本不再含任何 `clock: {` raw 字面量（源级 pin 测试钉住）。
- **错误路径可审计性**（r2 修订，见下节）：run 数据目录新增私有**逐 attempt 审计文件** `<data>/audit/attempt-<id>.json`（0600 文件 / 0700 目录，路径记入输出 report）：运行一开始即落盘 status/budgets/cache 来源声明；**每次 classifier/chat transport 发起前**同步写入保守 reserve/call 计数（SIGKILL 也留有发起前记录）；成功/FAIL/NOT-EVALUATED/异常/abort 全部在收尾写入 status、finishedAt、budget、cache/chat 摘要与**封闭枚举错误类别**（未知一律 `unclassified`；审计里从不出现 message/stack/name 等自由文本——初版的固定文件名与 regex-scrub 方案经 Sonnet 复验判定不足，同日被取代，见下节）。shell 未捕获 rejection 经 main 内 catch 完成审计后才以 exit 2 退出，不再「只 exit 1 缺成本」。
- **缓存来源声明**：audit 与最终 report 记录 `cacheProvenance`（live/replay 模式、起始 cache 文件数、fresh-empty 声明；不加不必要的加密签名）。
- **正式 G2 P2 证据门禁**：`g2P2Evidence`——`chat.calls + chat.hits > 0` 且 cache `missing/failures == 0` 才可能 PASS；不满足即 NOT-EVALUATED 并把证据写进 report，杜绝 P2 未真正跑过的假 PASS。
- 预算上限不变（classifier ≤400 次/$0.50、chat ≤80 次/$0.28、总 900s、`maxRetries:0`），无重置、无追加 live。**首次旧 run 的缺失计数保持 unknown/null**：不倒填 0、不查真实 auth/billing 端点。

### 新增离线回归（`tests/memory/govern/gate-script.test.ts`，17→26 个测试）

- **生产模块经源码注入**（`src/core/clock`、`src/memory/jev/predict/{flight,ledger}`），CI 不依赖预先 dist；本机存在 `dist/core/clock.js` 与两份冻结 dist（`/tmp/memory36-current-efa12f26-k9A1Uh`、`/tmp/memory36-baseline-122de638-a1KeOc`，两份 `core/clock.js` 逐字节一致）时逐一做 Clock 契约检查（setTimer 真实触发、clearTimer 取消、幂等）。
- **真正经过生产 P2 start/flight 路径**：用 harness 实际注入的 `productionClockPort` 产物（经生产 `createSegmentedClock`）驱动生产 `createPredictFlight` 状态机，fake transport 受显式测试 seam 控制（deferred/挂起/延迟回复），计时器经 fake-timer 真实推进：
  - ok 路径：attempt+outer 两个 timer 实际挂起、成功后清掉；replayed latency（延迟回复）真实消耗进 attempt 计时（ms ≥ 延迟）；**setTimer/clearTimer 实际被调用**有计数断言；ledger 按 usage 结算。
  - 外层期限路径：不响应 abort 的挂起 transport 在 `requestBudgetMs+OUTER_GRACE_MS` 后由**生产 segmented clock** 真实触发外层期限 → timeout 结算、zombie=1、账本按预留入账；迟到完成只清 zombie。
  - shutdown 路径：abort 在飞请求、清计时器、预留 release 不计费。
  - **缺陷 pin**：旧的 raw `{now,set,clear}` 形状在同一生产调用点被拒（`setTimer is not a function`）——该缺陷类别由运行生产状态机的回归钉住，不再只靠纯 mock 单例漏错。
- **audit/p2Evidence 单测**：0600 权限、running→finish 状态机、transport 发起前计数落盘、凭证形字符串 scrub、`g2P2Evidence` 真值表。

### 本阶段自验

| 命令                                                                 | 结果                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout 300 npx vitest run tests/memory/govern/gate-script.test.ts` | PASS；26 tests                                                                                                                                      |
| `timeout 200 npx vitest run tests/governance/test-tiers.test.ts`     | PASS；11 tests                                                                                                                                      |
| `timeout 500 npm run typecheck`                                      | PASS                                                                                                                                                |
| `npx prettier --check`（脚本/测试/本报告）                           | PASS                                                                                                                                                |
| 离线 smoke：temp 副本 `g1`（无 LIVE）                                | exit 2，BLOCKED 输出与首跑前逐字节一致（10/20 正例不足，未发请求，无写入）                                                                          |
| 离线 smoke：temp 副本 `g2`（无 LIVE）                                | exit 2；`audit-state.json`（0600）记录 replay 模式、fresh-empty 声明、sanitized 错误类别 `NOT-EVALUATED: chat catalog absent`——错误路径审计真实落盘 |

未跑 build / build:web / 全量 tiers（#48/#40 并行包所有权）；测试未新增 tier2 词法特征（child_process/socket/长 sleep/mount），governance 门禁 11 项通过。

### 待复验

- **LIVE G2 重跑必须 root 新授权**，本包不自动执行。修复后首跑预期：两版生产 flight 正常进入（setTimer/clearTimer 工作），`audit-state.json` 全程留痕，`g2-details.json` 产出真实 P2 证据。
- 本包交付后文件 SHA256：脚本 `31d9b3c12d89a0b0542f5ed4df63f9a602020f74222807ddd45a64b9d2a63461`、测试 `4372a1de8fd636aedec24180eebb20e556a7e8ec2cd1820a744a1aefdef53ba1`（上方首跑记录的 `87fa…`/`0556…` 属于当时冻结版本，为历史事实）。两份冻结 dist 与四件组 hash 不变，重跑前仍须校验。
- G1 仍 BLOCKED（明确正例 10/20）；任何指标/阈值/cap 未因修 harness 而调整。

## Harness 修复第二轮：Sonnet 复验 2 major + 1 minor（2026-11-06 晚，离线）

独立 Sonnet 复验（run `r_AHFJCYTE`）确认 Clock 修复对真实两版 flight 有效、26 离线测试 + 11 tier governance + typecheck + format 全过，但判定两项 major 缺陷与一项同块 minor，本轮全部修复。仍为纯离线交付：无 LIVE 调用，无 labels/旧 run/预算上限改动，只动脚本/测试/本报告三文件；主树上 #45 的未提交 type patch 未触碰。

### Major 1：固定名 `audit-state.json` 可被后续同目录 run 覆盖（已修）

复验场景：live attempt 留下 running/calls=7 的审计后被同目录离线重跑抹成 0，丢失 live 失败发起证据。修复：

- 审计改为**每 attempt 唯一文件** `<data>/audit/attempt-<id>.json`（id = 紧凑时间戳-pid-随机 4 字节；0700 目录 / 0600 文件；attempt id 与相对路径记入输出 report 的 `audit` 字段）。创建用 `wx`：即使 id 碰撞也 fail closed，绝不覆写既有文件；同 attempt 内更新用 tmp+rename 原子替换，崩溃时残留的旧完整记录 + 惰性 `.tmp`。
- 同目录 replay/retry 各得独立文件，旧 live 证据字节不变（已用真实双跑 smoke 验证：第二次 g2 后首文件 SHA256 不变）。
- 内存提交仅在写盘成功后进行：写失败不会让内存态膨胀值经后续 finalize 溢出到磁盘。不做任何旧 run 迁移/清理，旧 run 未知计数保持原样。

### Major 2：`sanitizeErrorCategory` regex+截断不充分（已修）

复验构造的 auth 解析 Error（含 `key:…` 与 401 provider body）原样穿透，初版「绝不含 key/error body」声明不实。修复：

- 删除自由文本拼装，改为**封闭枚举类别** `AUDIT_ERROR_CATEGORIES`（unclassified / unhandled-rejection / clock-port / dataset / dist-provenance / invalid-input / cache-missing / cache-corrupt / classifier-unavailable / classifier-budget / classifier-failed / chat-catalog / chat-budget / chat-failed / deadline-abort / audit-write）。已知受控失败由本文件自身的 `NOT-EVALUATED:` 前缀错误码与 Clock TypeError 签名映射为常量；其余（任意 Error.name/message/code/stack、provider body、回显密文）一律固定 `unclassified`。`finish()` 拒绝枚举外的类别值——自由文本从写入路径上被阻断，而非被清洗。CLI 聚合错误行本就是固定文案。
- 上节旧声明已同步纠正（标注 r2 修订）。

### Minor 3：前置审计写失败时 chat calls 已 + 但 failures 未 +（已修）

- chat 与 classifier transport 均改为：保守 reserve 先加且不退；**attempted-call 计数仅在审计写盘成功后推进**；写失败立即抛受控 `NOT-EVALUATED: pre-transport audit write failed`（类别 `audit-write`）并 `failures++`，transport 绝不发起。`createReplyCache` 的 catch 现在原样保留受控 `NOT-EVALUATED:` 错误（类别不丢），仅抑制原始 provider 错误。计数语义区分「预留」与「实际发起」，未离网请求不再抬高 `g2P2Evidence`。

### #4（采纳）：冻结 dist flight 校验纳入本机分支 + unhandledRejection

- 新增测试：本机存在两份冻结 dist 时，直接动态导入**各自的** `flight.js/ledger.js/core/clock.js`，用 harness `productionClockPort` 端口驱动真实生产 flight dispatch（CI 无 dist 时跳过，源码版恒跑）。
- `main()` 内注册一次性 `unhandledRejection` 处理：仅记 `unhandled-rejection` 封闭类别 + 尽力 `audit.finish` + `process.exitCode=2`；无模块级可变状态、无定时器，不会悬挂 `pi -p`。

### 本轮新增/改写回归（26→30 个测试）

- 逐 attempt 隔离：sentinel live attempt（running/calls=7）在第二次同目录 attempt 后字节不变；自动 id 唯一、碰撞 id fail closed；SIGKILL 窗口（无 finish）reserve 可读；0600/0700 权限。
- 封闭类别对抗：合成 key JSON、Authorization header、URL query 密文、provider 回显私文、换行、未知 Error.name/code/stack 的 hostile Error——类别为常量 `unclassified`，样本文字在审计 JSON 中零出现；已知受控失败映射稳定可区分；非枚举类别被 `finish` 拒绝。未读取任何真实密钥。
- fail-closed：chat/classifier 前置审计写失败 ⇒ mock runtime 的 `streamSimple`/`classify` 零调用、`calls=0`、`failures=1`、reserve 保守保留、`g2P2Evidence` 拒绝；审计写入先于请求的调用顺序断言。
- 冻结 dist flight dispatch（本机分支，上文）。

### 本轮自验

| 命令                                                                 | 结果                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `timeout 300 npx vitest run tests/memory/govern/gate-script.test.ts` | PASS；30 tests                                                                                                            |
| `timeout 200 npx vitest run tests/governance/test-tiers.test.ts`     | PASS；11 tests                                                                                                            |
| `timeout 500 npm run typecheck`                                      | PASS                                                                                                                      |
| `npx prettier --check`（三文件）                                     | PASS                                                                                                                      |
| 离线 smoke（temp 副本）：`g1` / `g2` ×2                              | exit 2 / exit 2 / exit 2；第二次 g2 后首 attempt 审计文件 SHA256 不变；`audit/` 内两独立 attempt 文件，均 0600、目录 0700 |

### 待复验（不变）

- LIVE G2 重跑仍须 root 新授权，不自动执行；G1 仍 BLOCKED（10/20）；预算上限与指标未动。
- 本轮交付后文件 SHA256：脚本 `441926c0e7b7820f09b470240c3306111d872b27836d40f2605cdcd6672ca76f`、测试 `0798cb000474b2b104754bb55536285d6975c802c535d9364fa6d566845d4830`（前一轮的 `31d9b3c1…`/`4372a1de…` 随本轮修复作废）。

## 窄修：fatal-rejection 粘性闩（root 亲读确认，2026-11-06 晚，离线）

Sonnet 复验（`r_0H65DQDF`）已 PASS 前两轮 2 major + minor 修复；root 亲读 script 后确认最后唯一残留缺口：unhandledRejection handler 此前只设 `process.exitCode=2` + 审计 NOT-EVALUATED，main 仍可正常走完并返回 PASS、success 路径 `audit.finish` 会覆盖记录、CLI `.then(code)` 把 exitCode 改回 0——违反「错误不假 PASS」。本轮只修这个窄缺口，不引新 scope：仍只动脚本/测试/本报告三文件，无 LIVE、无 labels/旧 run/预算/src 改动；per-attempt 审计、封闭枚举与其余已过逻辑逐行为保持不变。

### 修复（`scripts/dev/memory36-gate.mjs`）

- 新增 `createFatalRejectionLatch({audit, abort, setExitCode})`：**main 激活局部粘性闩**（无模块级状态）。`onFatalRejection` 具名回调一次性触发：abort 当前 controller 停止后续派发（不动已持久 reserve）、`audit.finish(NOT-EVALUATED, errorCategory:"unhandled-rejection")`、exitCode=2；不用 `process.exit` 硬杀、不加新 ref 定时器。
- 粘性语义贯穿 main 全部结束路径：metrics 汇总后 `metrics.status = latch.forcedStatus(...)` 强制 NOT-EVALUATED（report/details 同步继承）；success 路径 `audit.finish` 不带 errorCategory，闩写入的封闭类别按 finish 展开语义**保留不被覆盖**；返回码经 `latch.forcedExit(...)` 强制 2，CLI `.then(code)` 映射拿到的是 2，无法再改回 0；catch 路径只在**未触发**闩时提供 `classifyErrorCategory`，触发后不替换类别。
- `process.once("unhandledRejection", latch.onFatalRejection)` 具名注册，main 的 `finally` 在所有结束路径 `removeListener`——连续 main 调用不残留 handler。

### 定向离线回归（30→33 个测试，新增 3）

- **粘性反例**：spy `process.once` 捕获具名回调后**直接调用**（不真正 emit 全局 unhandledRejection，避免误触 Vitest 自身 handler）——原本会 PASS 的 gate 步骤（`forcedStatus("PASS")`、正常 `audit.finish`、CLI exit 映射）后必须 NOT-EVALUATED + 返回 2 + 审计类别仍为 `unhandled-rejection`，abort 副作用恰好一次。
- **异常路径类别保持**：触发后按 main catch 形状 finish（不带替换类别）→ 类别保持；未触发时闩为恒等映射。
- **真实 main 调用**（本机有冻结四件组与 dist 时执行，CI 自动跳过）：两次连续 g2 异常路径调用，`unhandledRejection` listener 数恢复原值、无残留，且 `audit/` 下留有两个独立 attempt 文件（per-attempt 保留不受影响）。

### 自验

| 命令                                                                 | 结果                                 |
| -------------------------------------------------------------------- | ------------------------------------ |
| `timeout 300 npx vitest run tests/memory/govern/gate-script.test.ts` | PASS；33 tests（含真实 main 双调用） |
| `timeout 200 npx vitest run tests/governance/test-tiers.test.ts`     | PASS；11 tests                       |
| `npx prettier --check`（脚本/测试）                                  | PASS                                 |

未跑全量 typecheck 大循环（本轮无 TS 面变化；`.mjs` 不在 tsc 范围、测试文件不在 typecheck tsconfig，既有 41 项门禁无涉）。

### 待复验（不变）

- LIVE G2 仍须 root 新授权；G1 仍 BLOCKED（10/20）；预算/labels/旧 run 未动。
- 本轮文件 SHA256：脚本 `118ebfe8dfc54522d4a5e72e64af4eb67a76d6c33d7310cd5bbc6f6f2c4169f5`、测试 `1c8052c0ca94ad87192338a2f82102bfe2d80d79e2edf2c141009c687de797a3`（上一轮 `441926c0…`/`0798cb00…` 作废）。
