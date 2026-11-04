# R3b 报告 · 跨会话 shadow 汇总 + 晋升判定

日期：2026-11-05 · 分支：dev · 基线：R2b `b669a255`（此前 R0/R2a/R1/R2a′ 均已提交未推送）。
实施范围：plan §4 R3b 步骤 1–3、U5、PD6/PD10/PD12、§5.4、§7。
无 git 写操作；无新依赖；无设置变更；未运行全量 `npm test`（并行包资源约束，留给 root 单份运行）。

## 1. 改动文件（全部新建）

- `/home/bluecake/ai/pi-toolkit/scripts/dev/reflex-shadow.mjs`
- `/home/bluecake/ai/pi-toolkit/src/reflex/core/shadow-scan.ts`
- `/home/bluecake/ai/pi-toolkit/tests/reflex/core/shadow-scan.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/R3b-report.md`

没有改 README（并行 R3a 持有）、其余 `src/reflex/**`、plan X1/X2 或任何 fixture。
`promotion.ts` 的 `accumulate`、`evaluatePromotion`、`countCrossSessionRepeats`、`msPercentiles` 仅调用；`types.ts` 仅 type import。

## 2. 实现与口径

1. `extractReflexRows(line)`：纯函数、无状态、无 pi 值依赖；只认指定的两种 `custom` envelope 与一种 `custom_message` envelope。返回严格的 record/answer/correction 联合，不带正文/entry 元数据。坏 JSON、无关 entry、`v !== 1`、不满足 v1 字段形状的 payload 跳过；额外字段兼容追加。
2. CLI 默认 `--days 14`，支持正数天数、`--cwd <path>`、`--json`。目录根遵循 `$PI_CODING_AGENT_DIR/sessions` 或 `~/.pi/agent/sessions`，cwd 编码镜像 pi 的 `getDefaultSessionDir`（`--<绝对路径分隔符替为减号>--`），不 import pi。目录递归枚举不跟随 symlink；不存在的目录输出空结果，读错误退出 1，不输出部分合格结论。
3. `createReadStream` + `readline` 逐行读取 jsonl，不按文件 mtime 或文件创建日期过滤（旧会话仍可能有新条目）。记录/纠正用 payload `at`，AUTO answer 用 envelope `timestamp`；只保留 `[now-days, now]` 内条目。
4. 每行调用 `accumulate`。同一 `scriptId@scriptVer` 分组；shadow record 与 AUTO answer 都喂 `(sessionFile, at, key, digest)` 给 `countCrossSessionRepeats`，不去重 digest；AUTO repeat 的 reasked 由冻结的 accumulate 计账。correction 独立累计，不依赖下一条候选或正文。
5. 延迟样本来自 shadow `port.ms` 与 AUTO `details.ms`，调用 `msPercentiles` 回填 p50/p95。`okRate`、`divergeRate` 展示依据冻结 stats 的分母；唯一晋升裁判是 `evaluatePromotion`：候选/portRuns/judged 均 ≥50，成功率 ≥99%，分歧 ≤5%，reasked/crossSessionRepeats/corrected=0，unknown 不进判定分母。
6. 跨会话重复缺证据保持未判定；JSON 显示 `crossSessionRepeats:null`（文本 `undetermined`），不静默补 0。发现 v1 AUTO answer 缺/坏 timestamp 时，计 `invalidTimestamps`，全报告重复判定保守置未判定，避免漏掉 repeat 后误晋升。
7. 文本每个脚本一行统计（包括 reasked / crossSessionRepeats / corrected 三列）+ eligible/not eligible + 中文原因；JSON 提供同样统计与 verdict。diverge 样本仅给 `sessionFile + entryId`，不含用户正文、工具参数、答案或 digest 清单，供 §7 人工抽查。
8. 从相对 `dist/reflex/core/{shadow-scan,promotion}.js` import；缺 dist 输出 `缺少 dist：先 npm run build` 并 exit 2。脚本只写 stdout，不联网、不写文件、不读/写设置、不自动晋升；无模块级可变状态、无新增定时器。

## 3. 测试与验收样本

`shadow-scan.test.ts` 共 19 个真实断言测试：

- 三种 entry 精确 payload；坏 JSON/无关 JSON；错误 envelope/customType；所有三种 v≠1；追加字段；损坏 payload 与统计字段拒绝。
- 测试内生成三份会话 JSONL（字符串数组，不写 fixture），通过真实提取与冻结 promotion API 汇总：60 条唯一 digest、无 correction ⇒ eligible，且 cand/portRuns/judged=60、crossSessionRepeats=0、p50=31/p95=58；49 条 ⇒ 明确“候选不足 50”；60 条后仅追加独立 correction ⇒ 不合格。
- 两会话同 digest 相隔 5min ⇒ crossSessionRepeats=1 / 不合格；11min ⇒ 0 / 合格。
- AUTO answer 进入跨会话重复，不增加 shadow candidates；reasked 拒绝晋升；不同 scriptVer 分组。
- 脚本不进 CI（Tier 3）；额外在 `/tmp` 临时会话根手动调用真实 CLI，用 `node:assert/strict` 核验 `--cwd`、环境根、默认 days、60 条 eligible、diverge refs、correction 拒绝、缺 timestamp 未判定、非法 days exit 1、隔离复制脚本缺 dist exit 2。测试准备阶段可写 `/tmp`，脚本本身仍只读。

## 4. 自验命令与真实完整输出

所有管道使用 `set -o pipefail`，长命令外加 `timeout`；输出经 tee 保存 `/tmp/r3b-*.log`，没有 head/tail 截断。

### `PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/reflex/core tests/boundary/pi-free.test.ts`（exit 0）

```text
RUN  v2.1.9 /home/bluecake/ai/pi-toolkit

 ✓ tests/reflex/core/promotion.test.ts (25 tests) 13ms
 ✓ tests/reflex/core/gate.test.ts (37 tests) 21ms
 ✓ tests/reflex/core/shadow-scan.test.ts (19 tests) 25ms
 ✓ tests/reflex/core/match.test.ts (11 tests) 13ms
 ✓ tests/reflex/core/state.test.ts (15 tests) 9ms
 ✓ tests/reflex/core/render.test.ts (9 tests) 10ms
 ✓ tests/boundary/pi-free.test.ts (30 tests) 565ms
 ✓ tests/reflex/core/budget.test.ts (12 tests) 10ms
 ✓ tests/reflex/core/catalog.test.ts (13 tests) 15ms
 ✓ tests/reflex/core/agreement.test.ts (11 tests) 9ms
 ✓ tests/reflex/core/schema.test.ts (18 tests) 14ms
 ✓ tests/reflex/core/gate.property.test.ts (2 tests) 58ms
stdout | tests/reflex/core/perf.test.ts > S0+S1 latency (10k random inputs) > p99 per-input evaluateGate+match ≤ 5ms (target 1ms, ×5 CI tolerance)
[reflex perf] n=10000 p50=0.0107ms p99=0.0318ms max=0.8653ms

 ✓ tests/reflex/core/perf.test.ts (1 test) 150ms
 ✓ tests/reflex/core/normalize.test.ts (7 tests) 4ms

 Test Files  14 passed (14)
      Tests  210 passed (210)
   Start at  06:33:18
   Duration  2.74s (transform 318ms, setup 283ms, collect 1.34s, tests 914ms, environment 2ms, prepare 747ms)
```

### `npm run typecheck`

```text
> pi-toolkit@0.10.5 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json

typecheck exit=0
```

### `npm run build`

```text
> pi-toolkit@0.10.5 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle


> pi-toolkit@0.10.5 build:bundle
> node scripts/build-bundle.mjs

build:bundle ok — dist/bundle/index.js sha256=0d72a40e2dbb3683 size=4.68 MB time=182 ms inputs=692
build exit=0
```

### 真实根：`node scripts/dev/reflex-shadow.mjs --days 14`（最终复跑附 strace）

```text
reflex shadow · days=14 files=1363 rows=0 invalidTimestamps=0
sessions: /home/bluecake/.pi/agent/sessions
无 reflex 记录（空结果）；尚无晋升依据。
仅供离线判定，不自动晋升；eligible 仍需人工抽查 diverge，且仅由用户修改 reflex.autoResolve。
text exit=0
```

### 真实根：`node scripts/dev/reflex-shadow.mjs --days 14 --json`（exit 0；最终复跑附 strace）

```text
{
  "sessionRoot": "/home/bluecake/.pi/agent/sessions",
  "scanRoot": "/home/bluecake/.pi/agent/sessions",
  "days": 14,
  "since": 1792622104773,
  "until": 1793831704773,
  "files": 1363,
  "rows": 0,
  "invalidTimestamps": 0,
  "scripts": []
}
```

### Tier 3 额外 CLI 行为断言（exit 0）

```text
CLI fixture: 60 candidates across 3 sessions => eligible; --cwd/default --days/env root/diverge refs verified
reflex shadow · days=14 files=3 rows=60 invalidTimestamps=0
sessions: /tmp/r3b-cli-LTU1X9/sessions/--tmp-reflex-project--
jobs.list@1 cand=60 portRuns=60 ok=60 okRate=100.0% unavailable=0 judged=60 agree=59 noTool=0 diverge=1 unknown=0 divergeRate=1.7% answered=0 fallback=0 repeat=0 reasked=0 crossSessionRepeats=0 corrected=0 p50=31ms p95=58ms · eligible · 达到统计门槛；仍需用户人工抽查后改设置
  diverge: /tmp/r3b-cli-LTU1X9/sessions/--tmp-reflex-project--/0.jsonl entry=r-0
仅供离线判定，不自动晋升；eligible 仍需人工抽查 diverge，且仅由用户修改 reflex.autoResolve。

CLI fixture: +1 independent correction => not eligible, 存在纠正（1）
CLI fixture: AUTO timestamp missing => undetermined (JSON null), never eligible
CLI invalid --days 0 => exit 1
缺少 dist：先 npm run build (exit 2)
All Tier 3 CLI assertions passed; fixtures only under /tmp/r3b-cli-LTU1X9
```

## 5. 只读取证（真实 sessions）

首次扫描（06:31，默认文本与 JSON 两次，1363 文件/0 reflex rows）在两次运行之前 touch `/tmp/r3b-readonly-marker.qDXPpl`，运行后真实输出：

```text
$ find /home/bluecake/.pi/agent/sessions -newer /tmp/r3b-readonly-marker.qDXPpl
```

输出为空。最终代码复跑时，活跃 pi 主会话/本 run 正在并行追加各自 transcript，find 出现活跃 jsonl，不能把该轮的 mtime 变化当成脚本写入或伪称为空。最终真实输出（已通过 message_agent 告知 root）：

```text
sessionRoot=/home/bluecake/.pi/agent/sessions
marker=/tmp/r3b-readonly-marker.JBmqmN
json exit=0

$ find /home/bluecake/.pi/agent/sessions -newer /tmp/r3b-readonly-marker.JBmqmN
/home/bluecake/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/2026-11-04T22-28-23-274Z_01a1a8ad-786a-713c-a5f4-aafdb2227b9e.jsonl
```

因此额外对最终脚本两次真实扫描做进程级 `strace -f -e trace=openat -o /tmp/r3b-openat{,-json}.log` 归因，全文在上述路径；检查所有线程/进程 openat 中 `O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND`，真实断言结果：

```text
/tmp/r3b-openat.log: openat=1499, write-capable opens=0
/tmp/r3b-openat-json.log: openat=1499, write-capable opens=0
Both CLI processes opened files read-only (strace -f evidence).
```

脚本源码只使用 readdir/createReadStream，无文件写 API 或网络 API。首次 find 空 + 最终进程级所有打开均只读，证明 CLI 没有写会话目录；不停止/改动并行 pi 进程以人为制造空 find。

## 6. 冻结面检查

```text
$ git diff --quiet HEAD -- tests/fixtures/ src/reflex/core/promotion.ts src/reflex/core/types.ts
frozen diff exit=0
```

格式门禁（四个交付文件，全文 `/tmp/r3b-format.log`）：

```text
$ npx prettier --check scripts/dev/reflex-shadow.mjs src/reflex/core/shadow-scan.ts tests/reflex/core/shadow-scan.test.ts docs/dev/jev-reflex/R3b-report.md
Checking formatting...
All matched files use Prettier code style!
prettier exit=0
```

## 7. README 待 root 合入的段落原文（plan R3b 步骤 3）

本包不直接编辑 README。建议在现有“晋升流程（plan §7）”步骤 3–4 后添加以下原文（已有步骤仍保留）：

```markdown
### 跨会话离线报告（R3b）

`npm run build && node scripts/dev/reflex-shadow.mjs --days 14`：只读、离线、逐行扫描
`$PI_CODING_AGENT_DIR/sessions`（未设置时 `~/.pi/agent/sessions`）；`--cwd <path>` 仅扫描该工作区会话目录，
`--json` 输出机器可读统计。记录/纠正按 `at`、AUTO answer 按会话 entry 的 `timestamp` 进入时间窗口。
每个 `scriptId@scriptVer` 单独汇总；shadow 候选与 AUTO answer 都参与跨会话重复判定，
纠正从独立 `subagent:reflex-correction` 条目累计，不依赖下一条候选。

报告包含 `reasked / crossSessionRepeats / corrected`、成功率、分歧率、p50/p95 与晋升原因；
缺少重复判定证据显示 `undetermined`（JSON 为 `null`），不能晋升。
`diverge` 样本仅列 session 文件与 entry id，不输出正文；`eligible` 仅表示统计门槛通过，
仍须用户人工抽查，再由用户把脚本 id 加入 `reflex.autoResolve`（live）。脚本不会修改设置或自动晋升。
缺 dist 时提示“先 npm run build”并退出 2；真实目录没有 reflex 条目时输出空结果，不虚构晋升依据。
```

## 8. 遗留与交接

- 本机当前无 reflex 持久条目，尚无真实 shadow 晋升依据；60/49/correction 验收是测试样本，不冒充线上数据。
- README 段落由 root 在 R3a 收口后合入；本包步骤 3 交付为待合入原文。
- 最终 find 的活跃会话写入噪声已用 strace 补证，不是脚本写入。
- 全量 `npm test` 由 root 单份运行；本包所有指定定向门禁已通过。
- 无冻结面修改请求、无其他未决设计问题、无 git add/commit/stash/checkout/reset/restore。
