# SubagentWorkflow 使用规范（可选批量执行器）

`SubagentWorkflow` 是**阶段内批量执行器**，不替代主会话调度。只在子任务已拆清、需求已澄清、
方案已确认时使用；否则仍用 `Agent` 单派或同消息并行派发。

## 何时用（能明显省轮次才用）

| 场景              | 说明                                                          |
| ----------------- | ------------------------------------------------------------- |
| 代码探索 fan-out  | 目标模糊时按模块/路由/关键词并行多个 Explore，汇总后喂给 Plan |
| 开发 + 验收流水线 | 方案确认后 `pipeline(tasks, devStage, verifyStage)` 批量跑    |
| 多模块验收        | 按模块并行 verifier，schema 输出验收矩阵后由主会话汇总        |
| 复杂评审 panel    | 方案产出后并行多个 reviewer lens；标准任务不必                |

**按并行规模选**：

| 同一轮并行数 | 用什么                                                                              |
| ------------ | ----------------------------------------------------------------------------------- |
| ≤3           | 同消息多个 `Agent`（更快、更好控，不必写脚本）                                      |
| 4–6          | 两者皆可：需要分模型 / 挂专家 / worktree 隔离用 `Agent`，同质批量用 workflow        |
| **>6**       | **必须 workflow**（全局 `concurrencyLimit` 默认 6，同消息硬派会在全局槽位排队超时） |

workflow 的 `agent()` 超出 `maxParallel`（`min(4, concurrencyLimit − 1)`）时 FIFO 排队（widget 显示 `⧗ N`），
不会失败；派发失败会 reject，fire-and-forget 调用要自己 `.catch()`。

超过 6 个的任务里若有必须分模型 / 挂专家 / 隔离的，把它们拆出来用 `Agent` 派（≤6），其余同质任务进 workflow。

## 禁用与限制

- 禁止承载 `dev-clarify`、方案确认等用户交互闸门；workflow 启动后跑到结束，不能中途等用户。
- 禁止顺序 `await agent()` 冒充并行；并行必须 `parallel()` / `pipeline()`。
- **`agent(prompt, opts)` 只认 `label` / `agentType` / `phase` / `fullResult`**：`model`、`effort`/thinking 传了也被忽略，
  `isolation: "worktree"` 只写进 journal、**不真正隔离**。子 run 的模型 = agent 类型 frontmatter 的 `model:`，没有则走 pi 默认模型。
  ⇒ 评审/验收独立性靠「类型 frontmatter 的模型与 dev 类型不同」保证；做不到就别把评审/验收放进 workflow。
- 方案强依赖探索结论时先 Explore 后 Plan；只有 Plan 输入自足时才可 Explore + Plan 并行。
- 有文件交叉的 dev 任务**不能进 workflow**（隔离不生效）：重切文件域，或改用 `Agent({ isolation: "worktree" })`。
- 批量派 dev 前必须先过[冲突预检](./parallel-safety.md#二冲突预检多写包并行前必做四步)：
  把 `args.tasks` 的文件域分配表跑一遍 `conflict-check.mjs`，交集任务重切或移出 workflow 用 `Agent` 隔离派，
  分配表四件事写进每个任务的 prompt。
- `SubagentWorkflow` 派发**不支持 `experts`**（workflow 子 run 拿不到 consult 工具）：按 SKILL.md「挂专家」矩阵
  必须挂专家的包（L3 写包、打回重派、换模型接手）不进 workflow，改用 `Agent` 同消息并行派。
- `SubagentWorkflow` 一律**后台运行**：调用立即返回 `wf_…` 工作流 ID，终态时推送完成通知；
  通知到达后用 `get_subagent_result(run_id: "wf_…")` 取完整结果，需要中途叫停用 `abort_subagent`。
  不要轮询或 `wait` 干等——主会话在工作流运行期间照常接收用户输入、可以做别的事。

## 模型映射与回退

下表是**用 `Agent` 派发时**的角色→模型映射。workflow 内指定不了模型，只有把模型写进对应 agent 类型的
frontmatter（`model:`）才会生效——当前 `~/.pi/agent/agents/*.md` 都没写 `model:`，workflow 子 run 一律走 pi 默认模型。

Explore=`zai-coding-cn/glm-5.3`（→ `zai/glm-5.3` → sonnet），Plan=`kimi-coding/k3-256k`，
reviewer=`cr-anthropic/claude-opus-5-5`（方案用 opus 档时改 `kimi-coding/k3-256k`），
dev=`kimi-coding/k3-256k`，verifier=`zai-coding-cn/glm-5.3`（dev 用 glm 时改 `cr-anthropic/claude-sonnet-5`）；
GPT 系（gpt-sol / gpt-terra / gpt-6）只作最后兜底。以 SKILL.md「各阶段模型分工」表为准。

`agent()` 返回 `null` 不区分「用户跳过」与「模型失败」；严格按序回退由主会话根据失败通知重派，
workflow 内不做无脑 fallback。

**超时**：默认预算的 workflow 到点先进宽限并通知主会话（头部 `⏳grace 58s`），可用
`extend_subagent_timeout(run_id: "wf_…")` 延长；显式 `timeout_s` 是硬顶。

## 最小模板

`pipeline(items, ...stages)` 的每个 stage 签名是 **`(prev, item, index)`**——第一级的 `prev` 是 `undefined`，
任务要从第二个参数取。

```js
export const meta = {
  name: "dev-flow-batch",
  description: "Run confirmed dev-flow batch tasks",
  phases: [{ title: "Implement" }, { title: "Verify" }],
};
phase("Implement");
const results = await pipeline(
  args.tasks,
  (_prev, t) =>
    agent(t.prompt, {
      label: `dev:${t.id}`,
      phase: "Implement",
      agentType: t.agentType || "general", // 模型由该类型 frontmatter 决定
    }),
  (dev, t) =>
    dev &&
    agent(`验收 ${t.id}：\n${dev}`, {
      label: `verify:${t.id}`,
      phase: "Verify",
      agentType: "verifier", // 与 dev 类型的 frontmatter 模型不同，才满足验收独立性
    }).then((verify) => ({ task: t.id, dev, verify })),
);
return { results: results.filter(Boolean) };
```
