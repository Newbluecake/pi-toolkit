# #36 PG · G1 / G2 离线门禁工具交付

## 状态

**NOT-EVALUATED；P5b 仍 BLOCKED。** 本报告是脚本、离线测试和执行方法的阶段交付，不是 G1/G2 达标证明。candidate 阶段没有启动真实模型请求；后续 root 分别授权的两次 G2 live 均未取得可判定的完整结果：首次为 harness 时钟端口错误，第二次在记录 400 次 classifier transport 后以 NOT-EVALUATED 结束，见下方两份独立现场记录。未修改生产源码、真实记忆、设置、标签或 fixtures。

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

## 第二次独立授权 G2 live（修复提交 bfd7ef09，2026-11-06）

### 结论与授权隔离

**G2 NOT-EVALUATED，exit 2；不是召回质量 FAIL，也没有 G2 PASS。整个 PG 仍因 G1 明确正例仅 10/20 而 BLOCKED。** 本授权仅运行 G2 一次，没有第三次自动重试、补联网或预算重置，没有 G1 live。

本次使用 root 已验收并提交的脚本，HEAD `bfd7ef09fd5f7b1426de63cfabcb9b040c082d79`，SHA256：
`118ebfe8dfc54522d4a5e72e64af4eb67a76d6c33d7310cd5bbc6f6f2c4169f5`。
root 已提供该修复的 Sonnet 验收及 33 个 offline + 11 个 tier governance 测试通过证据；本执行阶段没有重跑全量测试、build 或修改脚本。

本次是**新的独立预算授权**：classifier ≤400 且保守预留 ≤$0.50，chat ≤80 且 ≤$0.28，总 900 秒（外层 1000 秒），provider `maxRetries:0`。前次 `g2-live-20261106-71uexlor` 的消费仍为 unknown，未查询 billing、未倒填为零、未读取或复用其模型回答。保守占用按前次授权上限 $0.78 加本次授权上限 $0.78，共 **$1.56 的两次授权总保守上限**；这不表示实际账单已知，也不表示花费了 $1.56。

### 空 cache 与只读 cheap preflight

新私有目录：
`~/.pi/agent/memory-reports/eval36/runs/g2-live-rerun-20261106-drnzDx/`

目录为 0700，冻结数据副本、manifest、日志与审计文件为 0600。仅从 v3 冻结源复制四文件和 `freeze.json`，cache 起始不存在，未手填任何模型回答。四件组 SHA256 与本报告上表一致；current 仍为 **535**，history included **0**，37 个来源主用户轮核对通过，分母 **40 pairs**，本集合仅使用 pi-toolkit 项目的候选目录，不与 claude2api 混池。

预检没有网络、没有合成答案、没有写 modelreplycache。它用两版生产 `buildRecallQuestions` / `splitBatches`，对每轮的全部未裁剪 187 条候选只做输入尺寸计算：旧版 185 批 + 新版 185 批，共 **370 个 U 批**的未裁剪估计；若每批均走两个 classifier 档，可能达到 740 次，尚未计 context-split 重试。实际 static/eligible/P 去重可减少请求，缓存和 failover 仍未知，因此不是最终 transport 数。遵照 root 明确裁定，仍保留 400 次硬 cap，不因估算上界接近而加量。

本次实际使用的三包都解析为仓库本地 **1.4.0**：

- `node_modules/@earendil-works/pi-ai/dist/index.js`
- `node_modules/@earendil-works/pi-coding-agent/dist/index.js`
- `node_modules/@earendil-works/pi-tui/dist/index.js`

不将全局宿主 1.5 混作本次运行版本或兼容性证明。

### 唯一 live 命令与审计

```bash
set -o pipefail
timeout 1000 env PI_TOOLKIT_MEMORY36_GATE_LIVE=1   node scripts/dev/memory36-gate.mjs g2   --data "$HOME/.pi/agent/memory-reports/eval36/runs/g2-live-rerun-20261106-drnzDx"   --dist /tmp/memory36-current-efa12f26-k9A1Uh/dist   --baseline-dist /tmp/memory36-baseline-122de638-a1KeOc/dist   --max-calls 400 --max-classifier-usd 0.5   --max-chat-calls 80 --max-chat-usd 0.28 --timeout-ms 900000   2>&1 | tee "$HOME/.pi/agent/memory-reports/eval36/runs/g2-live-rerun-20261106-drnzDx/aggregate.log"
```

LIVE 环境开关只施于该命令进程。runtime 仍使用只读 credential store、`allowModelNetwork:false`、`refreshOnCreate:false`；模型调用仅沿生产 redaction/DTO 及冻结脚本 transport 路径，生产临时写入仅在 scratch。

- 命令窗口：北京时间 **20:28:38.947–20:31:45.524**，约 **186.58 秒**。
- 耐久审计窗口：**20:28:40.932–20:31:45.443**，约 **184.51 秒**；未达到 900 秒总期限。
- attempt ID：`20261106T122840-273524-b72af285`。
- 耐久审计：`audit/attempt-20261106T122840-273524-b72af285.json`。
- 最终状态 `NOT-EVALUATED`，closed error category **`unclassified`**。不由通用错误串猜测具体 provider 错误或凭证原因。

私有目录还包含 `execution-manifest.json`、`cheap-preflight.json`、`command.txt`、`aggregate.log`、`result-summary.json` 与本次真实 `cache/`。没有 `g2-details.json`；未覆盖旧 run 或旧 attempt。

### 实测聚合计数与预算

| 项目                                       | 本次耐久记录                                                      |
| ------------------------------------------ | ----------------------------------------------------------------- |
| classifier transport calls                 | **400 / 400**，调用硬 cap 已满                                    |
| classifier conservative reserve            | **$0.33600000000000174 / $0.50**                                  |
| classifier cache hits / missing / failures | **0 / 0 / 160**                                                   |
| chat transport calls                       | **31 / 80**                                                       |
| chat conservative reserve                  | **$0.030651600000000005 / $0.28**                                 |
| chat cache hits / missing / failures       | **12 / 0 / 12**                                                   |
| 本次合计 conservative reserve              | **约 $0.3666516**，不是实际账单                                   |
| 本次剩余 classifier call 容量              | **0**；金额尚余约 $0.164 不构成追加调用许可                       |
| 本次剩余 chat 容量                         | 49 次、约 $0.2493484 预留空间；本次已结束，不继续消费             |
| 实际 billed spend                          | **Unknown / N/A**，没有查询 billing 或把预留冒充费用              |
| 本次回答缓存文件                           | 246 个 classifier reply、19 个 chat reply，另有 2 个 catalog 文件 |

`cache.failures` 是冻结脚本的请求键失败集合计数，不应当与 transport calls 简单相加来冒充调用总数，也不能用回答文件数反推出所有失败的具体原因。模型回答均由本次 live transport 写入，没有读取或手填旧回复；后续若离线重放这些真实缓存，也只能称为本次缓存 replay，不能称为新的 live 证据。

前次 unknown 按授权上限 $0.78 保守占用，加本次已记录预留约 $0.3666516，得到约 **$1.1466516 的保守占用口径**；两次授权总上限仍为 $1.56。这些金额都不是实际账单。

### 指标与 P2 证据边界

| 项目                                  | 结论                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| 原始标注轮数 / pair 分母              | **37 / 40**，冻结不变                                                             |
| 完整配对结果数量                      | **N/A**；进程异常前未保存完整逐轮结果集，不能证明 ≥30，也不能冒记为 0             |
| old / new hits 与 recall              | **N/A / N/A**；没有完整指标，不报告伪造的 0% 或部分结果冒充正式召回率             |
| `predict.enabled` / `model.enabled`   | 两版均为 true，复用各自生产 wire + renderer + clock                               |
| 全局实际 P2 evidence                  | chat calls **31** + hits **12** = **43 > 0**，确有真实 P2 通路活动                |
| 全局完整性条件                        | missing = 0，但 classifier/chat failures 共 **172**，`p2Evidence.satisfied=false` |
| baseline/current 分别的 P2 calls/hits | **N/A**；冻结脚本没有持久化逐版 telemetry，不能由 aggregate 反推分配              |
| baseline/current 及时 / 迟到          | **N/A**；临时 branch 的 `kind:call` 记录未保存，不现场改脚本加埋点或补造数据      |
| G2 形式 PASS                          | **不满足**：无完整配对指标，且 failures 非零；本次到此结束                        |

本次有真实 P2 调用，但这不等于召回门槛通过。没有完整新旧召回率，因此不能据此裁定「新 <旧」或「新 <60%」，也不生成伪漏项 scope-check 列表。若 root 后续另行取得完整指标并确认红门槛，仍按 plan 派生产 P6b-fix；本包不调 cap、阈值或标签。

### 收尾核验

- 固定 current `efa12f26` / baseline `122de638` 双 dist 树 hash 前后与本报告上表匹配。
- 本次脚本 SHA256 前后仍为 `118ebfe8dfc54522d4a5e72e64af4eb67a76d6c33d7310cd5bbc6f6f2c4169f5`。
- v3 四件组、真实 `auth.json` / `models.json` / `pi-toolkit.json` 内容 hash 前后不变。
- 首次失败目录保留原样，消费 unknown 的事实未被新审计覆盖或倒填。
- 本执行阶段仅更新本报告和自己的私有执行产物；没有修改脚本、测试、src、标签、真实记忆或设置，没有 install/build/git 写操作/Todo/真实 session 消息，也没有全量测试。
- 本阶段自验为报告精确 `prettier --check` 与只读 hash / manifest 复核；模型门禁结果诚实保持 NOT-EVALUATED。

## #36 evaluator 最小闭环修复（2026-11-07，纯离线）

**仍为 NOT-EVALUATED；G1 positive 10 < 20，P5b BLOCKED。没有第三次 live 授权，也未执行真实 PG/cache 重放。** 上方第二次 G2 失败记录为本包开始时已有 dirty 内容，完整保留；其原始计数及失败结论没有重写。以下只描述 evaluator 的修复，不是新质量指标。

### 生命周期与完成性

- G2 old/new 各共享一个各自版本的 **production client 本体**（含 health、lastModel、usage、budgetExhausted），各探测一次；prepareTags 和后续 sample 也使用同一变体 client。G1 在自己的评价 activation 中共享另一 client。`maxCalls/maxCostUsd` 保持原 config，绝不改成 0；真实有限预算耗尽即 NOT-EVALUATED，不为跑满 37 条重置预算。
- 每 sample 仍重建 wire、branch、render cache 和生产 wire 内的 PredictCache/flight；仅共享 client、严格完整 DTO 的 transport cache 和两版各自的生产日账。37 条是独立抽样，不是连续轮；不继承上一 sample 的 P2 pending，不新增生产生命周期。
- 每轮薄 client 代理拦截 `onStatusChange` 并持有退订；finally 调用原 session_shutdown、abortBackground，再清空该轮所有订阅。保留 **drain 在 shutdown 之前**；不是把有效回复收紧成 1 秒窗口，严格 cache replay 的 2 秒延迟仍真实等待。
- 逻辑完成性只拦截 **client.ask 最终 outcome**，逐条记录 evalId/sampleId/turn/variant/duty/callseq/requestedIds/answeredIds/ok/reason/resolved。所有请求题目均通过有效答案校验且 missing 为空才 resolved；handled tier failure 后最终成功可 resolved。失败、partial、budget、pending 均不是 negative 0；后一 sample 同 DTO 成功不会倒填前一个 sample 的失败。
- registry 只记录控制类硬拒绝（预算/abort/审计失败/缓存缺失或损坏）的 sticky 类别，不在 classify 层推断 logical resolved。原 cache missing/failure 统计保留作遥测；不再用累计 raw attempt failure 集合直接否决后来完整的 fallback。
- P2 记录实际 dispatch 与生产 branch 的 `kind:call` 终局。完整的成功，或生产 flight `failed/timeout` 终局后的规则 fallback，均是完整执行；并不要求每次模型成功。已 dispatch 却无终局、aborted/denied、控制类预算或审计拒绝均为 NOT-EVALUATED。生产确定性/短提示 gate 未请求 chat 时记为零 dispatch，不冒充成功调用；正式 G2 仍要求全局 chat calls+hits > 0。两版日账不重置；可观察到已耗尽的日账拒绝也 fail closed。

### 耐久摘要与真实性

- `<data>/audit/attempt-<id>-turns/` 为新 attempt 独立目录，逐轮 old/new finally 写独占 `wx` 的 0600 摘要（目录 0700）：完成性、closedReason、hits/deliveredIds、逻辑 outcomes、逐轮 usage 差分及累计值、P2 telemetry 和订阅余数。失败样本的 hits/deliveredIds 为 null，已有部分 hashes 仅供诊断。
- attempt 开始写 expected 样本清单，结束写 completion 清单；因准备阶段错误或预算中止而根本没到达的 old/new 样本显式为 missing-sample/NOT-EVALUATED，缺值不补 0。G2 聚合不完整时 old/new hits、recall 为 null；部分结果不能成为正式 PASS。
- 最终 details 同样移到 attempt 独立路径，不覆写旧 run 的固定名文件。原 pre-transport durable audit、16 个封闭错误类别、fatal unhandled latch、segmented clocks、400/$0.50 + 80/$0.28 上限及模型链保持。
- usage 记 `usageEstimated:true` 和 SDK `usage.cost.total` 来源；逐轮使用共享 client 累计值的差分，实际费用仍 unknown，不以 SDK estimate 或 reserve 冒充账单。
- G1 直接 `port.afterWrite` 显式传顶层 `wholeRelation:true`，与 A 的 `a8fc1dac` source 接口对齐。旧 efa12f26 dist 可忽略额外键，但**不能当作验证新 whole criteria 的版本**。当前没有 build/freeze 新 dist；应由 root 在提交 source 后另做 current freeze，baseline 仍为 122de638。

### 离线回归及自验

增加 12 项 fake 回归（33→45 tests）：真实 production client + fakeRegistry 的跨轮 lastModel（清空 health 后仍优先上次成功档）、handled failover、同 DTO 后样本不补前失败、partial 非负例、有限生产预算 sticky 耗尽、订阅归零、真实在飞 background abort 后下轮继续 ask、0600 独占摘要/缺样本、预算硬拒绝不可被 fallback 覆盖、raw failure 仅遥测及 P2 terminal fallback、精确 chat cache 新 sample 复用且保留 2 秒延迟、fresh wire/branch/生产 PredictCache 无 pending carry 及错误 finally 落盘。

为遵守本轮禁止真实 memory/私有标签数据的边界，原 listener 回归中的「读取本机 frozen 私有 corpus 后调用 main」本机分支改为合成 audit/latch 的双 scope 注册/退订断言；没有运行整个真实 PG。原 Clock/flight/preaudit/cap/latch 回归仍执行，已有冻结 dist 的 Clock/flight 本机分支只读生产 JS，不读任何私有标签。

| 命令                                                                                                                                   | 结果                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `timeout 180 env PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/memory/govern/gate-script.test.ts tests/governance/test-tiers.test.ts` | PASS：45 + 11 = 56 tests                     |
| `timeout 300 env PI_TOOLKIT_TEST_WORKERS=2 npm run typecheck`                                                                          | PASS                                         |
| 精确三文件 `timeout 30 npx prettier --check ...`                                                                                       | 交付时以 `/tmp/36-evaluator-format.log` 为准 |

日志 `/tmp/36-evaluator-{tests,typecheck,format}.log`；机器可读交接 `/tmp/36-evaluator-handoff.json`。没有 live/API/model、安装、真实 memory 或旧 run 写入、Todo、git 写操作、全量测试；只改授权三文件。未重生 fixture，未修改生产源码、arch/plan/memory README、settings 或任何 cap。独立 Sonnet 验收及新的 live 授权仍由 root 负责；本包报告后冻结停止。

**交验残留（不可据此宣称完整 P2 闭环）**：production `flight.admit()` 除总调用/金额耗尽外，还会在剩余 USD 不足下一笔 estimate reserve 时静默拒绝，不写 `kind:call`。目前 harness 对 no-dispatch 按正常 rule/prompt gate 记录，尚未有离线证据区分该不足预留分支与普通确定性规则门。这是已向 root 上报的待验缺口，不应由本包通过测试推导 G2 完整性已获证明；独立 verifier 应优先检查该分支。未为消除它修改生产源码或放大任何预算。

## Sonnet r_6QHPBMEJ 窄复验修复：1 blocker + 1 major（2026-11-07）

本节只修该次验收核证的两项，不重新设计 evaluator。上节 45-test 交付及其残留说明为修复前事实保留；第二次 G2 live 失败历史、原预算、质量门及模型链不改。无第三次 live、无真实 memory/标签或私有 corpus 重放。

### Blocker：在公共生产边界先排除静默预算拒绝

- `production(dist)` 额外加载各版本自身公开的 `buildPredictSystemPrompt`、`OUTBOUND_MAX_TOTAL_BYTES`、`estimatePredictUsd`。每轮使用实际 taxonomy 生成 P2 system；链上每个 spec 必须由 `registry.find` 找到模型，且 input/cacheRead/output 价格均有限、非负。缺失模型或无效价目立即 NOT-EVALUATED，不能把 silent unbound 当规则 gate。
- 用 `user = "x".repeat(OUTBOUND_MAX_TOTAL_BYTES)`，对链上全部有效价目调用公共 `estimatePredictUsd(system,user,price)` 后取最大值为 bound。生产估算按 system+user 的 UTF-8 字节数单调计算；ASCII cap 字节覆盖任何生产 serializer 输出的合法 DTO 字节长度，无需复制 uncertain、rules、admit 或 token/输出常量。
- 按与生产 flight 相同的**真实墙钟本地日**读取保留的 variant 日账：要求 calls < 原 cap 且 maxUsd−spent−reserved ≥ bound。不足即受控 `NOT-EVALUATED: chat budget`，逐轮 finally 摘要 complete=false、零 chat transport。不更改 config，不重置账目，不猜测免费价目。
- 该检查是**保守准入上界**，不是 production admit 的精确重放：可能比真实短 DTO 提前阻止临界余额轮，诚实记 NOT-EVALUATED；不是充值、增 cap 或绕过预算。所有模型可绑定且上界通过后，fresh flight 没有旧 in-flight/zombie/breaker/disposed，原 no-dispatch 才可视为合法 rules/prompt gate；后续若产生 denied/aborted 终局仍由原 P2 完成性检查硬阻。
- 此修复关闭上节已上报的「正余额但不足 reserve 无终局」缺口；不把所有 no-dispatch 判无效，也不通过 find 调用次数猜 uncertain。

### Major：测试必须走 main 实际使用的 listener scope

新增脚本导出 `withFatalLatchScope({audit,controller,setExitCode},fn)`，内部创建原 sticky latch、注册原 named listener、`try await fn(latch)`，finally 删除同一 listener。main 的 bounded 主体及原 catch 真实走该 helper；helper 退订后再执行原 controller/summary/scratch cleanup，保留异常审计、exit 2 和 sticky 类别语义。

原来测试自己 `process.once/removeListener` 的自证已删除。新测试真实调用 main 使用的 helper，覆盖成功、连续两次、fn 抛错、先 trip 再抛错；断言 listener 数恢复、审计保留、controller abort、exitCode=2 不被清回 0。直接调用 latch hook，不真实 emit 全局 rejection。删除 helper 的 finally 退订会使这些行为断言失败，不依赖源码字符串检查，也不读取私有 frozen corpus。

### 窄修回归与最终自验

新增实际 **production wire + fakeRegistry + 合成 memory 目录** 的回归：正余额 < bound/2 时 chat-budget/零 dispatch/耐久 incomplete；足额确定性规则合法零 dispatch；足额 uncertain 真正 dispatch；链中任一模型 unbound 拒绝；非法价目拒绝；生产 serializer 的 ASCII、多字节/转义 DTO 字节上界及公共 estimate 单调上界。没有用 mock wire 自证此 blocker。

| 命令                                                                                                                                   | 结果                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `timeout 180 env PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/memory/govern/gate-script.test.ts tests/governance/test-tiers.test.ts` | PASS：52 + 11 = 63 tests |
| `timeout 300 env PI_TOOLKIT_TEST_WORKERS=2 npm run typecheck`                                                                          | PASS                     |
| 精确三文件 `timeout 30 npx prettier --check ...`                                                                                       | PASS                     |
| 精确三文件 `timeout 10 git diff --check -- ...`                                                                                        | PASS                     |

最终命令日志仍为 `/tmp/36-evaluator-{tests,typecheck,format,diffcheck}.log`；最终三文件 SHA256 及证据更新至 `/tmp/36-evaluator-handoff.json`。只交 root resume 原 Sonnet 做两项窄复验；G1 仍 **10/20 BLOCKED**，G2 没有新 live/质量结论。冻结后停止，不扩审计范围。

## 2026-11-08 · G1 扩大来源盘点（结论：仍 BLOCKED，口径已定）

root 授权按「每项目独立池、不混比、不补造时间、不凑数」扩大 G1 正例来源。对 `~/.pi/agent/memory/` 下 **23 个项目池**做只读盘点：621 个文件 / 524 份 Markdown / 247 个迁移块正文，逐池完整读 live + `.backup` + `archive`。

**结果：仅 2 条完整取代候选**（`--data` 之外的候选文件 `candidates/g1-expand-20261108.jsonl`，含 full text、entry-sha1、mtime 纳秒原值、projectPool）：

| 池                            | NEW → OLD                                                                                         | 判定                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `-home-bluecake-ai-warren`    | 当前阶段块：M0 未开工/无远端/GitHub 待办 → M0 进行中/两私有仓已建、10 标签、5 里程碑、Issue #1–#8 | 完整覆盖；`createdAt` + mtime 双时间证据 |
| `-home-bluecake-ai-apistrike` | L3 被白名单静默丢弃（无条件接线）→ L3 白名单已回归、`layerEnabled(L3)` 为唯一闸门                 | 完整覆盖；旧块仅此一条独立有效子条款     |

排除理由可核且逐池记录（`candidates/README-20261108.md` + `source-inventory`）：迁移副本与原文相同（不计新增）、部分覆盖、互补非取代、跨项目迁入指针不得混池、时间证据缺失（同文件共用 mtime / 反向 mtime）、agent 索引不得取代 user 详细条目。既有 20 条排除锁定不升格；`.jev/index.json` 的 `dismissed` 全为空。

**因此正例上限为 12/20**：G1 在现有真实数据上不可能达标；这不是标注力度问题，而是「真实记忆里完整取代本就稀少」。root 裁定（2026-11-08）：**接受 G1 长期 BLOCKED**，不再专项追指标，改为随真实取代自然积累后补标；**G2 不受 G1 影响，按已授权单独推进**。门槛、cap、脚本一律不动——不为过门而放宽。

### 现状与前提

- 已并入正式集的只有原 10 条；上述 2 条候选**尚未并入**，也未建新 freeze。
- G2 的 freeze 必须在**记忆元数据修复**之后（否则 legacy 超限字段会让生产读取路径与评测语料不一致）。该修复已于 `2769ad14` 落地：读路径对历史超限字段按 UTF-8 边界在内存降级、源文件字节不变、写入仍严格、迁移 planner 一次性截断并记入报告。
- 与 `pg-candidate-v3` 的关系：该 run 的 `freeze.json` 是历史证据，**不得覆写**；G2 使用独立的新版本目录。

## G2 单次授权资源上限准备（2026-11-08）

用户于 2026-11-08 授权将单次评估 classifier 验证天花板从 400 次 / $0.50 放宽至 **800 次 / $1.50**，原因是历史未裁剪 U 批估算已达 370 批、双档可达 740 次，400 次曾实际耗尽。默认值仍为 400 次 / $0.50：调用方必须显式选择较高授权额度，避免常规运行意外扩大支出。这只是资源上限，**不是评估门槛变更**；正例 ≥20、负例 ≥60、误自动率 ≤1/60、AA=0、召回 ≥50% 均不变，生产日限额亦不变。

历史 370/740 是 efa12f26 的估算，未涵盖 context-split 重试或缺失标签调用，不能宣称是当前版本的完整调用上界；800 高于此历史双档估算，但不足以保证整个 G2 完成。准备包不执行 LIVE，正式运行仍需先核实当前批量和全部调用上界、费用价目、生产限额及冻结脚本的版本来源。

## #36 D4 · G2 正式 LIVE 单档评估（2026-11-09）

### 结论与执行范围

**G2：FAIL，退出码 1。** 本次取得完整 37 个配对轮 / 74 个变体样本，旧版召回 **23/40 = 57.5%**，新版召回 **22/40 = 55%**。新版比旧版低 2.5 个百分点，且低于 G2 的 60% 门槛；不是超时、预算耗尽或缺样本导致的 NOT-EVALUATED。完整性与 P2 形式证据通过不等于质量门通过。**不解锁 PG / P5b；没有补跑。** 本节为本次最新结果，上方 NOT-EVALUATED 均保留为历史执行事实。

用户于 2026-11-09 明确授权本次网络、费用和真实 prompt/记忆的生产脱敏外发：只运行一次、当前真实单档 `opencode/jev-1.13`，chat 默认 `deepseek/deepseek-flash`；classifier 上限 800 / $1.50，chat 既有默认 80 / $0.28。未补第二档、未改代理、未修改配置、门槛、标签或生产代码。SDK `maxRetries:0`，不重置生产账本；脚本自身的逐样本调用与精确 DTO 缓存复用不构成第二次评估。

- 运行版本：HEAD `b3900c249381f9cff97b96c2a51deb6262b4102e`；启动前工作树干净。Node `v22.22.1`，本地 pi 三个 SDK 包 `1.5.0`。
- current：`/home/bluecake/.pi/agent/memory-reports/eval36/runs/pg-freeze-b3900c24/dist`，JS tree hash `68eeaf3671a1a56d598fbc7328f91c779b744f4ddaad7b2d1bff20b97e3fed48`。
- baseline：`/tmp/memory36-baseline-122de638-a1KeOc/dist`，commit `122de638`，JS tree hash `dda5ad08e83ab4159258c2f65659d9aac95cd7b4855e73b7f704a725b6ddf630`，与自身 manifest 一致。**非本轮干净重建**：按用户裁定沿用现有产物；此前使用当前 pi 1.5 依赖复建 baseline 的完整 build 失败，发射 JS 等价不等于完整成功构建。本轮仓库 build 自验不改变此 baseline 来源限制。
- `pg-candidate-v3` 的四件组与原 `freeze.json` 原样复制到新私有目录；源与副本 hash 一致，源 freeze 未覆写。空缓存开始（filesAtStart=0），无合成 catalog/响应、无历史缓存借用。
- 只读前置核验的一个本地断言曾误用 `hasConfiguredAuth`：`refreshOnCreate:false` 下该 availability snapshot 尚为空，不能据此判凭证缺失。核对 SDK 实现及本地 stored `api_key` 元数据后确认两者均存在；未刷新认证、未测试额外网络请求、未运行 gate main。此为本地预检纠正，不是失败 LIVE 后重试。

### 唯一实跑命令、完整输出与时间

私有运行目录（以下简称 `RUN`）：
`/home/bluecake/.pi/agent/memory-reports/eval36/runs/g2-live-single-20261109-dxNlqz`

实际模型命令如下；外层 wrapper 使用独占 `live-started.txt` 防止同授权二次启动，完整副本在 `RUN/command.sh`：

```bash
set -o pipefail
cd /home/bluecake/ai/pi-toolkit
DATA=/home/bluecake/.pi/agent/memory-reports/eval36/runs/g2-live-single-20261109-dxNlqz
timeout --signal=TERM --kill-after=10s 1000s env PI_TOOLKIT_MEMORY36_GATE_LIVE=1 \
  node scripts/dev/memory36-gate.mjs g2 \
  --data "$DATA" \
  --dist /home/bluecake/.pi/agent/memory-reports/eval36/runs/pg-freeze-b3900c24/dist \
  --current-commit b3900c249381f9cff97b96c2a51deb6262b4102e \
  --baseline-dist /tmp/memory36-baseline-122de638-a1KeOc/dist \
  --max-calls 800 --max-classifier-usd 1.50 \
  --max-chat-calls 80 --max-chat-usd 0.28 --timeout-ms 900000 \
  2>&1 | tee "$DATA/aggregate.log"
RC=${PIPESTATUS[0]}
```

- **完整 stdout/stderr**：`RUN/aggregate.log`，未截断；包含原始 JSON report。仓库只写聚合结果，不复制私有 cache keys / 逐样本正文。退出码：`RUN/exit-code.txt` = **1**，由 `PIPESTATUS[0]` 保存，不以 tee 的成功掩盖失败。
- 北京时间：**2026-11-09 00:23:46–00:26:59**；shell 墙钟精确耗时 **193.196975368 秒**。脚本审计窗口 UTC `2026-11-08T16:23:48.624Z`–`16:26:59.300Z`，约 190.676 秒；不是 900 秒超时。
- attempt：`20261108T162348-3236606-86c99b6b`；审计 `RUN/audit/attempt-20261108T162348-3236606-86c99b6b.json`。
- 逐轮摘要及 expected/completion：`RUN/audit/attempt-20261108T162348-3236606-86c99b6b-turns/`；完整 report/runs：`RUN/audit/attempt-20261108T162348-3236606-86c99b6b-g2-details.json`；聚合交付：`RUN/result-summary.json`。
- report 内 `at:2026-11-06T10:16:01.577Z` 是冻结 corpus 的评估时间基座，不是本次实跑日期；真实运行时间以本节和 audit 为准。

### 门槛逐项对照

| 项目                | 不变门槛                                                             | 本次结果                                                       | 判定                      |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------- |
| G2 真实用户轮       | ≥30                                                                  | 37 轮；40 个相关 pair                                          | PASS                      |
| G2 完整新旧配对     | 全部样本完成                                                         | 37/37 配对；74/74 变体 complete；订阅余数均 0；无 hardFailures | PASS                      |
| G2 新召回不退化     | 新 ≥ 旧                                                              | 新 22/40（55%）< 旧 23/40（57.5%）                             | **FAIL**                  |
| G2 新召回绝对门槛   | ≥60%                                                                 | 55%，少于达标所需的 24/40                                      | **FAIL**                  |
| G2 U+P2 证据        | 两版 model.enabled=true；实际 calls+hits>0，逻辑完成且无粘性控制拒绝 | chat 44+18=62；p2Evidence.satisfied=true                       | PASS                      |
| G1 正例支持         | ≥20                                                                  | 冻结正式正例仍 10；本轮不运行 G1                               | NOT-EVALUATED（支持不足） |
| G1 负例支持         | ≥60（AA≥30 / UU≥15 / UA≥15）                                         | 冻结 76（40 / 20 / 16），仅数据支持满足                        | PASS（仅支持数）          |
| G1 误自动取代率     | ≤1/60                                                                | 未执行 G1，无新预测                                            | NOT-EVALUATED             |
| G1 AA 误自动        | =0                                                                   | 未执行 G1                                                      | NOT-EVALUATED             |
| G1 正例自动取代召回 | ≥50%                                                                 | 未执行 G1                                                      | NOT-EVALUATED             |

G1 的 50% 是自动取代召回阈值，不能替代 G2 的 60%；所有门槛均保持原值。G1 另有 2 条未并入候选不计本轮正式支持数。

### 调用与费用（classifier / chat 分开）

| 口径                         | classifier                                         | chat                                                                              |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| 实际 transport 发起次数      | **370 / 800**（old 185 + new 185）                 | **44 / 80**                                                                       |
| 精确缓存命中                 | 0                                                  | 18（不是额外网络调用）                                                            |
| missing / failure 遥测       | 0 / 0                                              | 0 / 13                                                                            |
| 成功回答缓存                 | 370                                                | 31；另有 13 次失败，无完整 usage                                                  |
| 累计保守预留                 | **$0.497280** / $1.50                              | **$0.0432198** / $0.28                                                            |
| 成功 transport 的 usage 估算 | **$0.126766332**，370 次 SDK usage.cost.total 求和 | **$0.00557742**，31 次唯一成功响应 usage × catalog 价目；不重复计算 18 次缓存命中 |
| 服务商实际账单               | **Unknown**（未查 billing）                        | **Unknown**；13 次失败消费未知，不能记成零                                        |

合计实际 transport **414 次**；累计保守预留约 **$0.5404998**，其中 classifier 未超过 $1.50。预留不是已收费金额；usage 估算也不是服务商账单，不能将 chat 成功部分 $0.00557742 当作全部实际消费。

生产自身限制保持原配置：每个变体 classifier `maxCalls=800 / maxCostUsd=0.5`，P2 每版 `maxCallsPerDay=60 / maxUsdPerDay=0.14`。这与 CLI 的整体 transport 授权上限是不同层次，不互相替代，本次均未因预算中止。

P2 的逐版逻辑结果：old 31 次 dispatch，18 成功/及时、13 `failed`/非及时；new 31 次 dispatch，31 成功/及时。old/new 的生产逻辑账本分别约 $0.015646548 / $0.00557742，含 reserve fallback 或缓存重放，不可相加冒充网络账单。现行已提交 evaluator 将生产 `failed/timeout` 的终态规则 fallback 视为完成；本次 13 个 chat failure 全有终态，无 missing/aborted/denied，故总体是**质量 FAIL**，而非因 raw failure 遥测强行改成 NOT-EVALUATED。未将此差异擅自归因于模型、scope 或某个生产改动。

### 自验、只读边界与残留

| 命令 / 核对                                                                                                                                                        | 结果                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                                                | PASS，exit 0；`RUN/typecheck.log`                                                                                          |
| `npm run build`                                                                                                                                                    | PASS，exit 0；`RUN/build.log`；仅重建仓库忽略的 dist，不替换冻结评估版本                                                   |
| `env -u PI_TOOLKIT_MEMORY36_GATE_LIVE PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1 -- tests/memory/govern/gate-script.test.ts tests/governance/test-tiers.test.ts` | PASS，2 files / 64 tests（53 + 11），exit 0；`RUN/tests.log`；存在旧 snapshot sourcemap 源文件缺失 warning，不影响测试结果 |
| 报告 `prettier --check`、`git diff --check`                                                                                                                        | 最终收尾核验，结果见本次 handoff                                                                                           |
| `node /tmp/mem36-g2-live-summarize.mjs`                                                                                                                            | PASS：74/74 complete、订阅清零、无控制拒绝、费用按唯一 transport cache 求和；前后只读 hash 均一致                          |
| `git diff --quiet HEAD -- src scripts tests/fixtures`                                                                                                              | PASS；生产、dev gate、fixtures/golden 均未改                                                                               |

`pg-candidate-v3/**` 与 `pg-freeze-b3900c24/**` 全部常规文件的前后路径/hash 清单一致，baseline JS tree 不变；`auth.json`、`models.json`、`pi-toolkit.json` 前后 hash 一致。未改真实记忆、未 install、未 commit/push；未运行全量 tier1/tier2/secure。本轮只有本报告追加版本化内容，运行产物留在私有 RUN，交接为 `/tmp/mem36-g2-live-handoff.json`。

残留：G2 两项召回门均失败，后续如要定位或修复应另立任务；本次不补跑、不调 cap/阈值、不改标签。baseline 完整构建来源限界和服务商实际账单未知如上。集合仍仅覆盖 19/34 个 topic 用户令，独立轮重放不恢复完整历史工具/todo/冷却状态，不能外推成全面线上召回率。G1 仍 BLOCKED，PG 不通过。

### G2 可选候选审计（诊断，不改变门禁）

`--candidate-audit on` 在原逐轮审计之外写入同级
`attempt-<id>-turns-candidate-audit/`，按原 identity 独占文件；省略时不创建该目录。
它在现有 `turnClient` 请求／回答和 `onRender` 回调处只保留引用，在轮结束后匹配生产
question 的文件及生产脱敏摘录，输出 labelId、实际 blockId/rev（旧 files 均为 null）、
长度和 SHA-256、临时 alias、布尔概率、实际 U/P 投递层及概率、P2 DTO 字节数和可用的 renderer 预算统计；
不写正文、请求文本或凭证。相同摘录冲突显式标 ambiguous，不能猜选某个块。

限制：当前接口没有暴露实际选择阶段的排除明细、P 候选及 commit 原因，未出现在 U 问句
的块一律记 `unknown`，`residentAtRender` 仅是渲染时观察，不等于后续 ledger 决定。
legacy renderer 没有 blocks 预算统计时记 null；`outboundLimitBytes` 约束的是 P2 DTO，
不是 U 候选池。不要把 unknown 解释成任何给定原因，也不能保证每次漏召回都可归因。
诊断写入失败只输出固定错误，不改变评测结果；分析前需核对 74 个变体文件及 unique 映射。

### P6b U top-k 对照（离线诊断，不是正式 G2）

生产已有 `memory.jev.recall.maxEntries`（默认 3，允许 1–10）；P 层使用独立的
`memory.jev.predict.maxEntries`（默认 2）。`--recall-top-k N` 只覆盖 G2 新版 U 层配置，
旧版和省略参数时沿用原配置，不改变分类问题、阈值或生产默认值；报告追加实验值与新版配置 hash。

严格按原缓存时延的重放在 `fa1d8080` 新版第三批返回 all-failed：精确缓存命中且校验通过，
测得延迟 2382.94ms 超过生产单档 2000ms；同类本地缓存测试在关闭审计时仍可复现。
LIVE 中为何能成功不能仅据缓存断言。为探索方向，隔离副本仅把这一条缓存延迟改为 1000ms，
请求哈希和答案均保持原样；其余缓存字节不变。这个时延放宽实验**不能作为正式 G2 门禁结果**。
其 k=3 逐轮 old/new 注入 ID 与上次 LIVE 全部一致；k=3/4/5 在该批数据上新版召回分别为
22/40、23/40、23/40，后两档均找回 `63bb2970` 的唯一旧中新漏对，均未改善共同漏掉的 17 对。
新增未标注条目分别为 0、12、20 对；未标注不代表负例，不能称作已证实误召回。
第 18 轮新版 P2 在 k=3 记录 late、k=4/5 记录 timely，三档注入 ID 相同；因时序差异不能将所有
观测严格解释为只改变 k 的反事实。
详见 `/tmp/mem36-p6b-fix-handoff.json` 和隔离实验目录；不据此声称新阈值达标。

### P6b U threshold 实验参数（仅诊断）

G2 可显式传 `--recall-threshold 0.55`（接受 0.5–0.99），与 `--recall-top-k` 组合；
仅覆盖新版 U 的实验 config，旧版沿用现有设置。不传时保留原配置及生产默认；G2 的
60%／不退化门槛不变。报告中的 `experimentalRecallThreshold` 与
`experimentalNewConfigHash` 标识实验，不改变旧版 config hash 或请求缓存键。

使用上节已说明的单条**时延放宽**缓存副本及原 LIVE 答案进行离线对照；这是探索性重放，
不是完整原始时序或正式 G2。未标注注入不能直接算成误召回，必须结合原始用户请求和记忆
内容人工核对；该数据集没有穷尽的负标签，不能据此算真实 precision。完整表和人工审阅
结论见 `/tmp/mem36-p6b-fix-handoff.json`。

## #36 G2 · 新问句判据 A 全量正式 LIVE（2026-11-09）

### 结论、变量与来源

**正式 G2：PASS，退出码 0。** 37/37 配对轮、74/74 变体样本完整；新版 **26/40 = 65%**，旧版 **22/40 = 55%**。新版 ≥24/40 且不退化，两项质量门均通过。这是原时限下的正式门禁，不是时延放宽诊断；没有重试、补跑或重置预算。**G1 仍 BLOCKED，本次 G2 PASS 不等于 PG / P5b 整体通过。**

- 日期：北京时间 **2026-11-09 10:03:41–10:07:00**，shell 耗时 **199.034813742 秒**。report 的 `at:2026-11-06T10:16:01.577Z` 仍是冻结 corpus 时间基座，不是运行时间。
- 变量：P6b 候选 A 的新问句 true/false 判据，明确纳入有助于正确回答的设计、边界、原理及限制背景；主体问句不变。`questions.ts` 与 `jev-eval.mjs` parity 在 LIVE 前通过。classifier **单档 `opencode/jev-1.13`**，chat **单档 `deepseek/deepseek-flash`**，**k=3、U=0.60** 均不变，无实验覆盖参数。
- current：HEAD **`242e8c01` + 已有未提交问句工作树**，不是干净提交。构建后复制至 `/tmp/mem36-p6b-current-dist-PfRvdQX6/dist`，manifest 明示 `gitDirty:true`；JS tree hash `dc278cb488d049011e07974f11ab276e85630beeea69385f7d5f17dce908a006`，与交接预期一致。本任务没有再改 src / 镜像 / 测试。
- baseline：`/tmp/memory36-baseline-122de638-a1KeOc/dist`，**非本轮干净重建**；manifest commit `122de638`，JS tree hash `dda5ad08e83ab4159258c2f65659d9aac95cd7b4855e73b7f704a725b6ddf630`。沿用产物的构建来源限界保持，不冒称完整重建通过。
- 数据：从上次正式 LIVE 复制五个输入文件，hash 不变；新目录空缓存起步（filesAtStart=0），不复用任何旧响应。新判据影响请求与分批，新版实际每轮 6 批而非原来的 5 批。

### 唯一实跑命令与完整产物

本节 `RUN` 为 `/home/bluecake/.pi/agent/memory-reports/eval36/runs/g2-prompt-a-20261109-rYVK2H`。
实际启动为 `bash "$RUN/command.sh"`，脚本含 HEAD / 输入 hash / dist / baseline / 单档配置校验和独占 `live-started.txt` 防重入。核心命令：

```bash
cd /home/bluecake/ai/pi-toolkit
set -o pipefail
DATA=/home/bluecake/.pi/agent/memory-reports/eval36/runs/g2-prompt-a-20261109-rYVK2H
timeout --signal=TERM --kill-after=10s 1000s env PI_TOOLKIT_MEMORY36_GATE_LIVE=1 \
  node scripts/dev/memory36-gate.mjs g2 --candidate-audit on --data "$DATA" \
  --dist /tmp/mem36-p6b-current-dist-PfRvdQX6/dist \
  --current-commit 242e8c01 \
  --baseline-dist /tmp/memory36-baseline-122de638-a1KeOc/dist \
  --max-calls 800 --max-classifier-usd 1.50 \
  --max-chat-calls 80 --max-chat-usd 0.28 --timeout-ms 900000 \
  2>&1 | tee "$DATA/aggregate.log"
RC=${PIPESTATUS[0]}
```

- **完整 stdout/stderr**：`RUN/aggregate.log`；退出码 `RUN/exit-code.txt` = **0**；精确时间 `RUN/{started-at,finished-at,elapsed-ns}.txt`。完整命令保存在 `RUN/command.sh`，没有以 tee 的状态替代模型进程状态。
- attempt **`20261109T020344-3985277-15193bb8`**；`RUN/audit/attempt-20261109T020344-3985277-15193bb8.json` 保存预算、调用及终态。
- 同前缀的 `-g2-details.json` 保存完整 report/runs；`-turns/` 保存 74 个逐轮变体摘要及 expected/completion；`-turns-candidate-audit/` 保存 74 个候选诊断。
- `RUN/result-summary.json` 为机器可读聚合；`RUN/turn-comparison.json` 保存全部 37 轮新旧两版与上次的命中、增失及未标注投递对比；`RUN/preflight.json` 为只读边界的运行前 hash 证据。

### 指标、完整性与费用

| 项目                           | 本次结果                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| 完整配对 / 相关 pair 分母      | 37/37；40（冻结不变）                                                       |
| 新版绝对门槛                   | 26/40 ≥24/40：**PASS**                                                      |
| 新版不退化                     | 26/40 ≥22/40：**PASS**，+10 个百分点                                        |
| 完整逻辑结果                   | 74/74 complete；全部 recall outcome resolved；订阅余数 0；hardFailures 为空 |
| classifier transport           | **407 / 800**，旧 185 + 新 222；cache hits / missing / failures 均 0        |
| chat transport / cache         | **44 / 80** 次真实调用 + 18 次缓存命中；missing 0；29 次成功、15 次失败     |
| P2 形式证据                    | calls+hits=62；`p2Evidence.satisfied=true`                                  |
| classifier 成功 usage 估算     | **$0.140714868**（旧 $0.061888764，新 $0.078826104）                        |
| chat 成功 transport usage 估算 | **$0.005239704**，只算 29 个唯一成功响应                                    |
| 已知成功 usage 合计            | **$0.145954572**；不是全额账单，失败 chat 消费未知                          |
| 累计保守预留                   | classifier **$0.547008 / $1.50**；chat **$0.0432753 / $0.28**               |
| 服务商实际账单                 | **Unknown**；未查询 billing，不把预留或 usage estimate 当账单               |

此前约 $0.063 的估算仅覆盖一版旧分批，未含旧版空缓存对照及新判据增批；本次正式调用数/费用以上表为准。生产自身预算未重置、未改变。

**15 次 chat failure 不等于评估不完整**：旧版 31 次 P2 dispatch，18 成功 / 13 `failed`；新版 31 次，29 成功 / 2 `failed`，timely 26 / 非及时 5。全部都有生产终局，无 pending / aborted / denied / sticky 控制拒绝；既有 evaluator 将生产 failed/timeout 后的规则 fallback 视为完整执行。本次没有评估总超时或缺样本，不把运行失败伪装成质量结果，也没有为本次调整此完成性规则。两版逻辑账本包含缓存/预留 fallback，不能再加进 transport 费用。

### 与上次正式 LIVE 逐轮对比

对照目录：`g2-live-single-20261109-dxNlqz`（上次新版 22/40、旧版 23/40），**不是**时延放宽的离线诊断目录。
下表只列命中已标注 relevant pair 改变的轮；新增/丢失均相对于上次同一变体。

| 轮次 | turn id    | 变体 | 新召回的对                      | 新丢失的对                      |
| ---- | ---------- | ---- | ------------------------------- | ------------------------------- |
| 6    | `b9f77b18` | 新版 | —                               | `pit/fabric-xs-activation.002`  |
| 7    | `5d8fa4cd` | 新版 | `pit/fabric-xs-activation.001`  | —                               |
| 10   | `da35ee49` | 新版 | `pit/fabric-xs-activation.002`  | —                               |
| 11   | `521483b5` | 新版 | `pit/jev-reflex.001`            | —                               |
| 20   | `63bb2970` | 新版 | `pit/schedule-auto-approve.003` | —                               |
| 23   | `180ec94f` | 旧版 | —                               | `pit/schedule-auto-approve.002` |
| 36   | `5f60305e` | 新版 | `pit/memory-predict.006`        | —                               |

新版 **新增 5 对、丢失 1 对，净增 4 对（22→26）**；其余 31 轮新版相关 pair 命中不变。旧版 **新增 0 对、丢失 1 对（23→22）**；其余 36 轮不变。完整投递 ID 变化（含未标注项）见 `turn-comparison.json`。

### 自验、边界与残留

- LIVE 前：`env -u PI_TOOLKIT_MEMORY36_GATE_LIVE PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1 -- tests/memory/jev/questions-eval-parity.test.ts tests/memory/jev/questions.test.ts tests/memory/govern/gate-script.test.ts tests/memory/govern/candidate-audit.test.ts`：**PASS，实际 3 files / 89 tests**，其中 parity 4 tests。最后一个过滤路径无对应测试文件，不声称执行过独立 candidate-audit suite；候选审计相关回归在 gate-script suite 内。旧临时快照的 sourcemap 源缺失 warning 不影响结果。日志 `RUN/tests.log`。
- `npm run typecheck`、`npm run build`：均 **PASS / exit 0**，日志 `RUN/{typecheck,build}.log`；build 仅重建仓库忽略的 dist，然后复制 current 隔离快照，不替换冻结件。
- `node /tmp/mem36-g2-prompt-a-summarize.mjs`：只读核验、计数与逐轮指标重新计算均 **PASS**，日志 `RUN/summary-check.log`；没有调用 gate main 或模型。
- 运行前后 `pg-candidate-v3/**`、`pg-freeze-b3900c24/**`、上次 LIVE 全部常规文件路径/hash 一致；baseline/current 快照、输入、已有 dirty 源码/测试/README、真实 auth/models/settings hash 不变。没有 install、commit/push、源代码修改、门槛或标签修改、冻结件重生。
- `git diff --quiet HEAD -- tests/fixtures/` 通过。相对 `origin/dev` 的 fixture 检查在运行前已非零：仅已有 `tests/fixtures/scoped-memory-tool-surface.json` 分支差异；前后清单相同，本次未修改它，不将该基线差异谎报为全仓 frozen gate 通过。
- 报告格式与 `git diff --check` 收尾结果见本次 handoff；没有运行全量 tier1/tier2/secure。本任务仅追加本报告；既有四个 dirty 文件保留原样。

**证据限界**：这是单次正式门禁通过，不是统计显著性或线上全面改善证明；空缓存 LIVE 的旧版自身也波动，P2 时序与新问句分批同时变化，不能把逐轮全部差异归因为判据文本。新版未标注投递 pair 从 **48→64**（旧版 47→48）；未标注不等于负例，尚未人工穷尽判定，不能由召回通过推导 precision 或噪声无回归。隔离轮不恢复完整历史；候选审计记录 ID/概率/哈希而非完整原始 prompt DTO。baseline 非本轮干净重建、失败调用费用未知等来源限制继续保留。G1 仍 BLOCKED，不自动解锁 PG/P5b，不补跑。

交接：`/tmp/mem36-g2-prompt-a-handoff.json`。

## 2026-11-09 · F1 默认布局翻转

依据 G2 正式 PASS（新版 26/40、旧版 22/40，门槛 24/40），默认 `memory.layout` 翻转为 `blocks`，`memory.migrate.auto` 默认仍为 true。G1 长期 **BLOCKED**，用户已显式接受该残留，不代表 G1 通过；自动取代误判率无 G1 数据背书，保持既有阈值和单批上限并在翻转后抽样复核。
