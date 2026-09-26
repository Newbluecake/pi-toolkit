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
| 4–6          | 两者皆可：要挂专家 / worktree 隔离用 `Agent`，同质批量用 workflow（分模型两边都行） |
| **>6**       | **必须 workflow**（全局 `concurrencyLimit` 默认 6，同消息硬派会在全局槽位排队超时） |

workflow 的 `agent()` 超出 `maxParallel`（`min(4, concurrencyLimit − 1)`）时 FIFO 排队（widget 显示 `⧗ N`），
不会失败；派发失败会 reject，fire-and-forget 调用要自己 `.catch()`。

超过 6 个的任务里若有必须挂专家 / 隔离的，把它们拆出来用 `Agent` 派（≤6），其余同质任务进 workflow；
分模型不必拆——`agent()` 可以按调用指定 `model`。

## 禁用与限制

- 禁止承载 `dev-clarify`、方案确认等用户交互闸门；workflow 启动后跑到结束，不能中途等用户。
- 禁止顺序 `await agent()` 冒充并行；并行必须 `parallel()` / `pipeline()`。
- **`agent(prompt, opts)` 严格校验，只认 `label` / `agentType` / `phase` / `fullResult` / `model` / `thinking` /
  `isolation` / `experts` 这八个键**：任何其它键（含拼写变体，如 `effort`/`subagent_type`/`schema`/`resume`/
  `timeout_ms`/`run_in_background`）、未知键值为 `undefined`、`opts` 本身不是普通对象（`false`/`0`/`""`/数组/
  函数/Proxy/类实例）、已知键类型不对，一律 reject（报错列出允许键全集 + 常见误写的替代建议）。`model` 用完整
  `provider/id`（同 `Agent` 的 `model` 参数；裸 id/子串作模糊 hint 解析，未知模型 / hint 解析失败 / 额度闸门拦截
  会直接 reject，错误信息含 `Did you mean` 建议），`thinking` 取 `off|low|medium|high`；
  `isolation: "worktree"`（workflow-worktree plan P2，已上线）**真正生效**：该次 `agent()` 调用在从当前 HEAD
  新建的独立 git worktree 里跑（未提交的主工作区改动对它不可见，隔离的调用之间也互不可见）；跑完把改动提交到
  新分支 `pi-agent-<runId>`（分支名与 workflow 内部的 callId/label 无关，二者的对应关系只在 outcome 文本里给出），
  **调度方自己负责 merge / cherry-pick**——workflow 从不自动合并；提交失败则 worktree 原样保留在磁盘上（outcome
  里给出路径）。`worktree.enabled=false` 时直接 reject（reason `isolation_unavailable`，无退化路径）。**replay-verify
  (P2, todo #13)**：默认 `workflow.isolationReplay="verify"` 时，一次 `committed`(带 sha) 或 `clean` 的隔离调用会
  写进 journal；下次带同一 journal 重跑时，只有它的 `pi-agent-<runId>` 分支在本次启动时刻精确指向记录的 commit
  才会命中回放（删除/rebase/强推/已合并删除都视为 live 重跑）；chain scope 下命中会把它的身份折进链摘要，让
  依赖它的下游也能一起命中（不再像旧版一样无条件染色）；content scope 与 `isolationReplay="off"` 仍保留旧的
  「带隔离的调用以及它之后提交的所有调用都不进 journal 回放」规则：
  `fullResult: true` 时返回对象只在这次调用真的隔离过才会多出 `worktree` 键（`{state, branch?, path?}`），outcome
  文本另有独立的 `worktrees:` 分栏列出每个调用的分支/kept 路径/pending 状态，不会被正文的头尾截断吞掉。
  ⇒ 评审/验收独立性直接在 verify 一级用 `model:` 指定与 dev 不同的模型（见下方模板），或继续写进类型 frontmatter。
- **`agent(prompt, { experts })` 现在可以挂专家**，但规则比顶层 `Agent` 更严：`experts` 只接受**已 completed**
  且有持久化 session 的调用（failed/timed_out/aborted/仍在运行/回放命中的调用都会被拒），可以是 `label`/`run_id`，
  也可以是保留字 `"main"`（指宿主主会话）。解析顺序：`"main"` 优先 → **本 workflow 内自己提交过的同名调用**
  （按声明或去重后的实际 label 匹配；本地有候选就绝不会解析到外面同名的旧 run）→ 交给主会话侧的 consult 解析器
  按 label/run_id 查找。挂了 experts 的那次调用、以及它成功解析之后**这个 run 里提交的所有后续调用**，都不会走
  journal 回放（即使配置了 journal）——重跑一个开了 journal 的脚本时，如果上游专家调用命中了回放，它下游那些
  依赖专家结论的调用会被拒（提示改 `noReplay: true` 整体重跑，或换用外部 run_id）。先 `await` 专家调用、
  确认它已经结束，再把它的 label 传给下一次 `agent({ experts: [...] })`。
- 方案强依赖探索结论时先 Explore 后 Plan；只有 Plan 输入自足时才可 Explore + Plan 并行。
- 有文件交叉的 dev 任务可以进 workflow 了：给冲突的那几个 `agent()` 调用分别挂 `opts.isolation: "worktree"`
  （需要 `worktree.enabled=true`，否则整包直接 reject，无退化路径），各自在独立 worktree 里跑互不干扰；跑完的分支
  由调度方（主会话）自己合并——workflow 不做合并。仍然不挂隔离的调用留在共享工作区，和以前一样必须按冲突预检
  分配文件域。跨调用共享的未跟踪依赖（如 `node_modules`）走 `worktree.linkPaths` 只读共享，不要在隔离调用里跑
  安装/更新类命令（会污染共享目录，这条不受隔离保护）。
- 批量派 dev 前必须先过[冲突预检](./parallel-safety.md#二冲突预检多写包并行前必做四步)：
  把 `args.tasks` 的文件域分配表跑一遍 `conflict-check.mjs`，交集任务重切或移出 workflow 用 `Agent` 隔离派，
  分配表四件事写进每个任务的 prompt。
- `SubagentWorkflow` 一律**后台运行**：调用立即返回 `wf_…` 工作流 ID，终态时推送完成通知；
  通知到达后用 `get_subagent_result(run_id: "wf_…")` 取完整结果，需要中途叫停用 `abort_subagent`。
  不要轮询或 `wait` 干等——主会话在工作流运行期间照常接收用户输入、可以做别的事。

## 模型映射与回退

下表的角色→模型映射**同样适用于 workflow**：`agent()` 的 `opts.model` / `opts.thinking` 与 `Agent` 的同名参数同规则
（完整 `provider/id` 优先；同 prompt 换模型不会命中 journal 旧结果），也可以继续写进 agent 类型 frontmatter 的 `model:`。

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
      agentType: t.agentType || "general",
      model: "zai/glm-5.3", // 按调用指定模型，与 Agent 的 model 参数同规则
    }),
  (dev, t) =>
    dev &&
    agent(`验收 ${t.id}：\n${dev}`, {
      label: `verify:${t.id}`,
      phase: "Verify",
      agentType: "verifier",
      model: "cr-anthropic/claude-sonnet-5", // 与 dev 一级不同模型，才满足验收独立性
      // 验收可以挂上同一 pipeline 里已经 completed 的 dev 调用作为专家（按它声明的 label 匹配到本 workflow
      // 自己那次调用，不会漏解到外面同名的旧 run）——前提是 dev 那次调用必须先 completed（pipeline 本身已保证），
      // 且挂了 experts 之后本次及后续提交不走 journal 回放。
      experts: [`dev:${t.id}`],
    }).then((verify) => ({ task: t.id, dev, verify })),
);
return { results: results.filter(Boolean) };
```
