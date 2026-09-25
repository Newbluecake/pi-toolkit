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

**≤3 个子任务时不要用 workflow**——同消息发 3 个 `Agent` 调用更快、更好控，也不必写脚本。

## 禁用与限制

- 禁止承载 `dev-clarify`、方案确认等用户交互闸门；workflow 启动后跑到结束，不能中途等用户。
- 禁止顺序 `await agent()` 冒充并行；并行必须 `parallel()` / `pipeline()`。
- 禁止用 workflow 跳过评审/验收独立性：每个 `agent()` 显式传 `agentType`、`model`、`effort`；
  模型 ID 必须来自速查表。
- 方案强依赖探索结论时先 Explore 后 Plan；只有 Plan 输入自足时才可 Explore + Plan 并行。
- 有文件交叉的 dev 任务必须 `isolation: 'worktree'`；无交叉可省略。
- 批量派 dev 前必须先过[冲突预检](./parallel-safety.md#二冲突预检多写包并行前必做四步)：
  把 `args.tasks` 的文件域分配表跑一遍 `conflict-check.mjs`，交集任务重切或标 `worktree: true`，
  分配表四件事写进每个任务的 prompt。
- `SubagentWorkflow` 一律**后台运行**：调用立即返回 `wf_…` 工作流 ID，终态时推送完成通知；
  通知到达后用 `get_subagent_result(run_id: "wf_…")` 取完整结果，需要中途叫停用 `abort_subagent`。
  不要轮询或 `wait` 干等——主会话在工作流运行期间照常接收用户输入、可以做别的事。

## 模型映射与回退

Explore=`cr-anthropic/claude-sonnet-5`，Plan=`kimi-coding/k3-256k`，
reviewer=`kimi-coding/k3-256k`（与制定模型撞车时改 `cr-anthropic/claude-opus-5`），
dev=`kimi-coding/k3-256k`，verifier=`kimi-coding/k3-256k`（与 dev 撞车时改 sonnet）；
GPT 系（gpt-sol / gpt-terra / gpt-6）只作最后兜底。

`agent()` 返回 `null` 不区分「用户跳过」与「模型失败」；严格按序回退由主会话根据失败通知重派，
workflow 内不做无脑 fallback。

## 最小模板

```js
export const meta = {
  name: "dev-flow-batch",
  description: "Run confirmed dev-flow batch tasks",
  phases: [{ title: "Implement" }, { title: "Verify" }],
};
phase("Implement");
const results = await pipeline(
  args.tasks,
  (t) =>
    agent(t.prompt, {
      label: `dev:${t.id}`,
      phase: "Implement",
      agentType: t.agentType || "general-purpose",
      model: t.devModel || "kimi-coding/k3-256k",
      effort: "medium",
      gate: t.gate,
      ...(t.worktree ? { isolation: "worktree" } : {}),
    }),
  (dev, t) =>
    dev &&
    agent(`验收 ${t.id}：${dev.summary}`, {
      label: `verify:${t.id}`,
      phase: "Verify",
      agentType: "verifier",
      model: t.verifyModel || "kimi-coding/k3-256k",
      effort: "medium",
    }).then((verify) => ({ task: t.id, dev, verify })),
);
return { results: results.filter(Boolean) };
```
