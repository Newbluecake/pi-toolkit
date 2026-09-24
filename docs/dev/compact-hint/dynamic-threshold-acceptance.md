# 动态阈值（compact.dynamicThreshold）· 真机验收手册

> 对应 `dynamic-threshold-plan.md` §12 D4 的 8 条真机验收判据。D1–D3 已上线
> （commits `2cc9107` / `af189dd` / `82b2b40` / `cd0d209`），默认 `compact.dynamicThreshold.mode=on`。
> 本文把每条判据展开成「前提 → 步骤 → 检查命令 → 期望结果」，全部命令可直接复制运行；
> 判据之间无顺序依赖（2/3/4 共用同一次 `switch_context` 的产物）。改动 `src/compact-hint/`
> 相关代码后请把 1–8 全部重跑一遍。

## 0. 先记住这几件事

### 0.1 遥测文件的实际路径

生产路径在 `src/stack.ts` 的 `buildSessionStack` 里组装（搜 `telemetryFilePath`）：

```ts
telemetryFilePath: join(getAgentDir(), "telemetry", "compact-switch.jsonl"),
```

`getAgentDir()` 是 pi（`@earendil-works/pi-coding-agent`）的导出：取 `$PI_CODING_AGENT_DIR`，
未设置时为 `~/.pi/agent`。因此：

| 场景                          | 路径                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| 默认                          | `~/.pi/agent/telemetry/compact-switch.jsonl`                |
| 设置了 `PI_CODING_AGENT_DIR`  | `$PI_CODING_AGENT_DIR/telemetry/compact-switch.jsonl`       |
| 轮转备份（>2 MiB 时自动产生） | 同目录 `compact-switch.jsonl.1`（只保留一代；检查时一并看） |

三个使用事实（实现见 `src/compact-hint/dynamic/telemetry-store.ts`）：

- **文件只在第一次压缩/切换事件后才出现**。动态层每轮 `turn_end` 都在算，但遥测行只在
  `session_compact`（`phase: "switch"`）与观察窗关闭（`phase: "window"`）时落盘；从未压缩过的
  会话没有这个文件是正常的。想快速播种：TUI 里跑一次 `/compact` 即可产生一条
  `trigger: "manual"` 的 switch 行。
- 目录 `0700`、文件 `0600`（首次成功追加后 chmod 一次）；单行 JSONL；超过 2 MiB rename 成 `.1`。
- 合规读法是**逐行 `JSON.parse` 并跳过坏行**（撕裂行契约）；`readTelemetryLines()` 就是该读法的
  实现，本文所有检查脚本也遵守它。

### 0.2 离线预检（不占真机）

`scripts/exp/compact-dynamic-smoke.ts` 是无真机依赖的手工烟测：构造 wire、喂 1M 窗口的 usage
序列、模拟一次交接压缩，然后打印带标记的消息、`statusView()`、遥测行与估计量持久化条目。

```bash
npx tsx scripts/exp/compact-dynamic-smoke.ts
```

期望：输出里能看到 `hint 40% · cost` 一类的英文短标记（方案记法 `[hint …]`；tick 里标记本体无
方括号，中文 note 里才有，见判据 1）、status JSON 的 `"mode": "on"`、一条 `phase: "switch"`
的遥测行（window 行由脚本末尾的 `dispose` 补写，打印时不出现）、以及
`subagent:compact-dynamic` 估计量持久化条目。真机步骤之前先跑一遍，可快速确认接线没断。

### 0.3 回滚（任何一步结果不对时）

```text
/agent settings set compact.dynamicThreshold.mode off
/reload
```

等价的文件改法：`~/.pi/agent/pi-subagent.json` 里 `"compact": { "dynamicThreshold": { "mode": "off" } }`
后 `/reload`。`off` 时不构造 runtime：`/agent status` 无动态节，tick/hint 文案与本功能上线前
**逐字节一致**（由黄金 fixture `tests/fixtures/compact-hint-golden.json` 把关——该 fixture 是
off 行为的合同，**永远不许重新生成**，见判据 6）。遥测文件是纯追加的旁路产物，可直接删除，
删除不影响任何行为。

### 0.4 调试开关

`PI_SUBAGENT_DEBUG_COMPACT_HINT=1` 启动 pi 后，compact-hint 的 tick/hint 发送与 switch hook 的
交接采用路径会打 `[pi-subagent]` 前缀的 `console.warn`，判据 2 排查归因时有用。

## 1. 判据 1：默认 on + 1M 窗口 ⇒ hint 在 38%–45% 触发，tick 尾部带 `hint NN% · cost` 标记

**前提**：settings 未显式改过动态阈值（`~/.pi/agent/pi-subagent.json` 无
`compact.dynamicThreshold` 块，或 `mode` 为 `on`）；模型是 1M 窗口的 Claude（如 Opus）。

**步骤**：

1. `pi` 启动 TUI，`/model` 选 1M 窗口模型。
2. 正常干活让上下文涨过 40%（长对话、读大文件均可）。
3. 观察 `[pi-subagent 上下文通报]` 消息（tick，customType `subagent:usage-tick`）与越线 hint
   消息（customType `subagent:compact-hint`）。
4. 跑 `/agent status` 看动态节。

**期望结果**：

- tick 行末尾出现英文短标记（本体为 `hint 41% · cost`，无方括号；方案 §10.1 的 `[hint …]`
  是标记记法），形如：

  ```text
  [pi-subagent 上下文通报] 上下文已使用约 45%。达到 41% 时会再提醒你考虑 switch_context；现在无需操作。 hint 41% · cost
  ```

- 越线时的 hint 消息附带一行中文说明：`- 本次阈值由价格模型给出 [hint 41% · cost]：继续下去每轮都要为这段长前缀付 cache-read。`
- 动态节第 1 行形如
  `Compact thresholds: hint 41% (dyn·cost) · force 88% · window 1.0M · reserve 16k · range 35%..60%`。
- hint 触发点落在 **38%–45%**（默认参数 + 先验混合下的 C\* ≈ 40%；线上统计量进来后仍在死区内）。
  basis 为 `cost`；若显示 `floor`（35% 地板先兜住）也算通过，但默认参数 + 1M Claude 应命中 `cost`。

## 2. 判据 2：真实 switch_context 后两条同 seq 记录（switch/window），因果字段正确

**前提**：判据 1 的会话继续用；上下文越过 hint 线后让模型执行一次真实的 `switch_context`
（有实质交接文本、被压缩真的消费）。

**步骤**：

1. 完成一次 `switch_context`。
2. 再继续 **至少 6 轮**对话（或等 10 分钟，或直接结束会话）——观察窗在 `turns ≥ 6`、
   `wallMs ≥ 600_000` 或 session 结束（dispose flush）时关闭并落 `phase: "window"` 行。
3. 跑下面的配对检查脚本（按 `sessionId + seq` 配对 switch/window 两行，并核对因果字段）。

```bash
node -e '
const fs = require("node:fs");
const dir = process.env.PI_CODING_AGENT_DIR || (process.env.HOME + "/.pi/agent");
const file = dir + "/telemetry/compact-switch.jsonl";
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const recs = [];
for (const p of [file, file + ".1"]) {
  for (const line of read(p).split("\n")) {
    if (line.length === 0) continue;
    try { recs.push(JSON.parse(line)); } catch { /* 撕裂行契约：跳过 */ }
  }
}
console.log("records:", recs.length, "from", file);
const switches = recs.filter((r) => r.phase === "switch");
let ok = 0;
for (const s of switches) {
  const wins = recs.filter((r) => r.phase === "window" && r.sessionId === s.sessionId && r.seq === s.seq);
  const causal = s.trigger === "switch-tool" && s.adopted === true && s.handoffApplied === true;
  if (causal && wins.length === 1) ok += 1;
  console.log(
    "seq=" + s.seq,
    new Date(s.ts).toISOString(),
    "trigger=" + s.trigger,
    "adopted=" + s.adopted,
    "handoffApplied=" + s.handoffApplied,
    "windowRows=" + wins.length,
    "costUsd=[" + wins.map((w) => (w.rProxy && typeof w.rProxy.costUsd === "number") ? w.rProxy.costUsd : "null").join(", ") + "]",
    causal && wins.length === 1 ? "OK" : "(non-causal or window pending)",
  );
}
console.log("switch rows:", switches.length, "| fully paired causal rows:", ok);
'
```

**期望结果**：

- 至少一行打印 `OK`：`trigger=switch-tool`、`adopted=true`、`handoffApplied=true`、
  `windowRows=1`——即同一次 `switch_context` 恰好产生 `phase: "switch"` 与 `phase: "window"`
  两条**同 `sessionId + seq`** 的记录（seq 来自 `onApplied`，R2-1 的唯一因果信号）。
- `adopted` 读的是 `compactionEntry.fromHook`（交接文本被 pi 采用）；`handoffApplied` 只由
  `onApplied` 开火建立。其他压缩（`/compact`、force、pi 自动）各行应显示
  `trigger=manual/dynamic-force/pi-auto/overflow`，不被误记成 `switch-tool`。
- 若 window 行迟迟不出现：先确认做满了 6 轮/10 分钟/退出会话，再重跑脚本。

## 3. 判据 3：rProxy.costUsd 至少一次非 null；落盘内容递归无路径类字段

**前提**：判据 2 已产生 window 行（`rProxy` 只在 window 行上）。

**步骤**：先跑判据 2 的脚本看 `costUsd=[...]` 是否出现数值；再跑下面的无路径检查
（逐行 `JSON.parse` 后**递归**断言：不存在 `path/file/dir/cwd/hash` 类键名、不存在任何字符串
数组值。**不用 `grep '/'`**——`model.id` 本身合法含 `/`）。

```bash
node -e '
const fs = require("node:fs");
const dir = process.env.PI_CODING_AGENT_DIR || (process.env.HOME + "/.pi/agent");
const file = dir + "/telemetry/compact-switch.jsonl";
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const KEY = /path|file|dir|cwd|hash/i;
const bad = [];
let parsed = 0, skipped = 0;
const walk = (v, p) => {
  if (Array.isArray(v)) {
    if (v.some((x) => typeof x === "string")) bad.push(p + " <- string array value");
    v.forEach((x, i) => walk(x, p + "[" + i + "]"));
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (KEY.test(k)) bad.push(p + "." + k + " <- path-like key");
      walk(val, p + "." + k);
    }
  }
};
for (const p of [file, file + ".1"]) {
  for (const line of read(p).split("\n")) {
    if (line.length === 0) continue;
    let rec = null;
    try { rec = JSON.parse(line); } catch { skipped += 1; }
    if (rec !== null) { parsed += 1; walk(rec, ""); }
  }
}
console.log("parsed:", parsed, "| torn lines skipped:", skipped, "| violations:", bad.length);
for (const b of bad) console.log("  " + b);
process.exitCode = bad.length === 0 ? 0 : 1;
'
```

**期望结果**：

- 判据 2 脚本的 `costUsd=[...]` 里**至少一次非 `null` 的数值**（观察窗内 usage 账本可聚合、
  成本字段齐全时给出；取不到时是 `null` 而绝不是 `0`）。
- 无路径脚本退出码为 0：`violations: 0`，且 `torn lines skipped` 只在多进程并发等极端情况下
  才可能 >0。
- 语义补充：缺失量一律 `null`（T-D2-NULL-NOT-ZERO）；`compactionCostUsd` 单列，绝不混进
  `rProxy.costUsd`（R2-6）。

## 4. 判据 4：文件权限 `-rw-------`（0600）、目录 `drwx------`（0700）

**前提**：遥测文件已存在（至少一次压缩事件，见 §0.1 的 `/compact` 播种法）。

```bash
F="$HOME/.pi/agent/telemetry/compact-switch.jsonl"
[ -n "$PI_CODING_AGENT_DIR" ] && F="$PI_CODING_AGENT_DIR/telemetry/compact-switch.jsonl"
ls -l "$F"
stat -c "%a %n" "$(dirname "$F")" "$F"
```

**期望结果**：`ls -l` 显示 `-rw-------`（属主读写、无组/其他位）；`stat` 输出目录 `700`、
文件 `600`。若存在 `.1` 轮转文件，同样应满足 600（它由 rename 而来，权限继承原文件）。
chmod 时机是「首次成功追加后一次」，因此**空文件不存在时不算失败**，先播种再查。

## 5. 判据 5：分档模型（GPT-5.6 sol，372k 窗口）⇒ 质量线先到 + 跨档前一次性提醒

**前提**：可选到一个 `cost.tiers` 带 `inputTokensAbove: 272000` 的模型（GPT-5.6 sol，
272k 拐点）。**手头没有分档模型时本条转离线**：`npx vitest run tests/compact-hint/dynamic/threshold.test.ts`
（T-D1-TIER-CANDIDATE / T-D1-TIER-BOUNDARY）与 `tests/integration/compact-dynamic-wiring.test.ts`
（T-D3-TIER-EXEMPT）已覆盖同等行为，真机部分在结果表记「无法验证（无分档路由）」。

**步骤**：

1. `/model` 切到 GPT-5.6 sol。
2. `/agent status` 看动态节第 1 行的 basis。
3. 让用量涨进跨档票区间（`usedTokens ∈ [B − TIER_MARGIN, B]`，B=272k）。

**期望结果**：

- **默认参数（`maxQualityPercent=60`）下 basis 是 `quality`，不是 `tier`**：60% 质量上限≈223k，比
  `272k − margin`（≈268k）先到，所以 status 第 1 行显示 `(dyn·quality)`，tick 尾标 `hint 60% · quality`。
  避开高价档由质量上限天然实现（施工偏差 D1-①）。
- 模型没切、用量继续涨进票区 `[B − margin, B]`（≈268k–272k）时，收到**一次**额外的跨档提醒——
  它允许突破 hint 的 10 分钟冷却一次，note 为
  `- 再涨约 Nk token 就会跨进高价档 [tier 272k]，跨档后单价翻倍；在此之前切换最划算。`。每个 B 一张票
  （B 本身仍属低价档，P1-9 边界语义），同一 B 不重发。票据只看用量和 `nextTierTokens`，与 basis 无关。
- 把 `compact.dynamicThreshold.maxQualityPercent` 调到 ≥ 73 后，basis 才会变成 `tier`：status
  `(dyn·tier)`、tick `hint 72% · tier 272k`。
- 例外：该路由若被当作订阅制或价格未知（status 显示 `dyn·quota`，或走质量分支），则
  `nextTierTokens` 为空，不发跨档票——这是设计行为（订阅制没有边际单价），不算失败。
- force 线不受分档影响（D10）：`/agent status` 的 force 值与无分档模型一致。

## 6. 判据 6：mode=off + /reload ⇒ status 无动态节，文案与黄金 fixture 一致

**步骤**：

1. `/agent settings set compact.dynamicThreshold.mode off`，然后 `/reload`。
2. TUI 里 `/agent status`；再正常干活观察 tick/hint 消息。
3. 跑确定性判据（离线黄金回归）：

```bash
npx vitest run tests/integration/compact-dynamic-off-golden.test.ts
```

**期望结果**：

- `/agent status` **不出现** `Compact thresholds:` 开头的动态节（整节不渲染，其余输出不变）。
- tick 行末尾无 `hint …` 标记；hint 消息无中文动态 note——与功能上线前逐字节一致。
- 黄金测试通过：脚本化 usage 序列（跨 hint/force/压缩回落/tick 全网格）下所有 `sendMessage`
  的 content 与 details 和 `tests/fixtures/compact-hint-golden.json` 逐字节相同。
  **该 fixture 是 off 行为的合同，任何情况下不许重新生成**（`scripts/exp/generate-compact-hint-golden.ts`
  是历史录制工具，禁止再对它产出的 fixture 覆盖提交）。
- 验完记得切回：`/agent settings set compact.dynamicThreshold.mode on` + `/reload`。

## 7. 判据 7：print 模式（pi -p）⇒ 零遥测写入、无挂起

**步骤**：

```bash
F="$HOME/.pi/agent/telemetry/compact-switch.jsonl"
[ -n "$PI_CODING_AGENT_DIR" ] && F="$PI_CODING_AGENT_DIR/telemetry/compact-switch.jsonl"
BEFORE=$( [ -f "$F" ] && wc -l < "$F" || echo 0 )
timeout 180 pi -p "Use the Agent tool to dispatch one general subagent that replies with the single word pong, then reply done."
AFTER=$( [ -f "$F" ] && wc -l < "$F" || echo 0 )
echo "telemetry lines: before=$BEFORE after=$AFTER"
```

**期望结果**：

- `pi -p` 在 timeout 内**自行退出**（exit 0，无挂起——动态层零 timer，print/json 构造期即返回
  惰性 runtime）。
- `before == after`：print 主会话与其子会话都不写遥测（`isLazyMode`：`mode === "print" || mode === "json"`；
  子会话另有 HOST_KEY 守卫兜底）。

## 8. 判据 8：订阅制 provider 额度 >75% ⇒ `dyn·quota` 且 hint 线被前压

**前提**：`quota.enabled=true`、当前 provider 命中 `quota.subscriptionProviders`、quota verdict
非 `stale`、未过期窗口的最高 `usedPct > 75`。**没有真实订阅环境时本条转离线**：
`npx vitest run tests/compact-hint/dynamic/threshold.test.ts`（T-D1-SUBSCRIPTION）与
`tests/integration/compact-dynamic-wiring.test.ts` 已覆盖前压曲线；真机部分记
「无法验证（无订阅环境）」。

**步骤**：

1. 在上述前提下正常开一轮会话（额度数据由 quota 子系统拉取，`/agent status` 的 quota 节可见
   用量）。
2. `/agent status` 看动态节；观察 hint 触发点。
3. 让会话发生一次压缩后，用判据 2 的脚本看 `lines.basis`。

**期望结果**：

- status 第 1 行显示 `(dyn·quota)`；hint 线低于质量上限（60%）——被前压曲线
  （75%→95% 线性压向地板）拉早，`usedPct ≥ 95` 时压到地板 35%。
- 遥测 switch/window 行的 `lines.basis === "quota"`；`lines.hintPercent` 随 `usedPct` 上升而下降。
- verdict `stale` / 无未过期窗口 / quota 关闭 ⇒ 不前压（basis 回 `quality-cap` 或正常 cost 路径），
  这是设计行为。

## 9. 结果记录表

| #   | 判据                                    | 结果（pass/fail/无法验证） | 备注 |
| --- | --------------------------------------- | -------------------------- | ---- |
| 1   | 1M 默认 on，hint 38–45%，`· cost` 标记  |                            |      |
| 2   | switch/window 同 seq 配对 + 因果字段    |                            |      |
| 3   | rProxy.costUsd 非 null + 递归无路径     |                            |      |
| 4   | 0600/0700 权限                          |                            |      |
| 5   | 分档模型：`dyn·quality` + 跨档票提醒    |                            |      |
| 6   | off 逐字节回归（status + 黄金 fixture） |                            |      |
| 7   | `pi -p` 零遥测、无挂起                  |                            |      |
| 8   | 订阅 `dyn·quota` 前压                   |                            |      |

## 10. 常见非故障形态（排障）

- `dyn off (price-unknown → static line)`：当前路由的 `cost.cacheRead` 不是有限正数（部分
  免费/代理路由），默认 `unknownPriceMode=static` 下动态层退回静态线——设计行为。
- `dyn off (usage-unknown)`：`ContextUsage.tokens` 为 null（会话极早期），几轮后自然恢复。
- 遥测文件不存在：还没有任何压缩事件；`/compact` 一次即可播种（记为 `trigger: "manual"`）。
- window 行不出现：观察窗未到期（6 轮/10 分钟）；退出会话（dispose）会按实际值补写。
- 撕裂行（`JSON.parse` 失败被跳过）：多进程并发追加的已知 best-effort 损失（方案 §5.3），
  丢的是一条遥测而不是主链路数据。
