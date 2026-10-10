# consult A/B 实验协议（预注册）

> 来源：`docs/dev/consult/eval-2026-10.md` §6.3、`docs/dev/consult/ab-instrumentation-plan.md`。
> 本文件是实验期内 dev-flow「挂专家」矩阵的**覆盖规则**：入组包按这里执行；实验之外照 SKILL.md 原文执行。

## 预注册参数

- **salt**：`consult-ab-v1`
- **起始日期**：2026-10-10（埋点 P1a/P1b/P2/P3 合入当日）；此前的 run 一律不入组。
- **主指标**：首验通过率（`verdict/v1` 的第一个 verdict 为 `pass`），返工轮数（第一个非 `reject` 之前的 `reject` 次数；从未通过记为截尾）。
- **次要指标**：包总成本（含返工、含 consult，扣掉被吸收的 run），墙钟。
- **功效**：首验通过率约 0.3–0.5 时，检测 15 个百分点差异约需**每臂 150 个包**。达不到就不声称有效，分析脚本会打印功效提示。

## 入组

- 范围：场景矩阵里标「可选」的 L2 写包（方案直白、一次通过），外加主会话**事先声明**的一批 L3 写包。
- 入组决定在派发该包第一个 dev **之前**做出，事后不改。
- 打回重派、车道升级、疑难升级等「必须挂」场景本身不入组；只有包在开工时入组，返工才跟着它走。

## 抽签与派发

1. 抽签：`node scripts/exp/consult-ab-arm.mjs <packageId>` ⇒ `experts` 或 `control`。同一个包恒定同一臂，事后可复算。
2. 入组包的**每一次**派发（dev、frontend-dev、verifier、reviewer，含返工 resume 和不走 resume 的重派）都带
   `meta: { lane, packageId, feature, abArm }`。resume 不写 `meta` 时自动继承上一轮的 `dispatchMeta`；显式写则覆盖。
3. verifier 一律传 `schema: "verdict/v1"`，产出结构化结论（report 原文 + verdict + blockers + findings）。
4. `abArm: "experts"` 的 dev/frontend-dev 包必须挂 `experts`（通常是 Plan）；verifier/reviewer 派发带同样的 `abArm`，但协议规定不挂 `experts`，工具层允许这两个角色省略它。`abArm: "control"` 对所有角色都**不得**挂非空 `experts`。工具层会校验一致性，不一致直接报错。

## 两臂规则

- **两臂推送的交接内容保持一致**：方案文件路径、冻结接口、文件域、验证命令一字不差；差别只在是否挂 `experts`。
- **control 臂覆盖「打回重派必须挂」**：control 臂的包被打回时，把打回报告原文推送给重派的 dev，**不挂**上一轮 dev / verifier。
- **两臂的 verifier 都不挂专家**，避免验收端的差异混进结果。
- reviewer 不在实验范围内，照常执行（方案评审推荐挂 Plan）。

## verdict 对照（schema 里只写英文）

| verdict            | 中文       |
| ------------------ | ---------- |
| `pass`             | 通过       |
| `conditional_pass` | 有条件通过 |
| `reject`           | 打回       |

## 分析

```sh
node scripts/exp/consult-ab-analyze.mjs --since 2026-10-10 --salt consult-ab-v1        # 文本报告
node scripts/exp/consult-ab-analyze.mjs --since 2026-10-10 --salt consult-ab-v1 --json # 机读
```

脚本会单独列出未入组包（没有任何 run 声明 `meta.abArm`），它们不计入排除或协议违例；排除清单包含 `mixed-arm`、`hash-mismatch`、`partial-unenrolled`、三类协议违例，警告包含 `absorbed-cap-hit`、
`verdict-missing`。排除率高说明协议执行有漏洞，先修协议再看指标。
