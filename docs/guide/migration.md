# 从独立插件迁移

下列独立插件已逐一融合进本包。迁移 = **卸载旧包 + 升级本包 + `/reload`**：

- `@getpipher/armory-memory` → `pi remove` 即可，memory 数据（`~/.pi/agent/memory/**`）零迁移生效。
- `@bluecake/pi-ask-user` → `pi uninstall`；飞书配置 `~/.pi/agent/feishu-notify.json` 原样保留。
- pi-hud / web-search / pi-claude-todo / session-nav 等散装扩展 → 删除 `~/.pi/agent/extensions/` 下对应的文件或目录。

**残留识别**：pi 对重名命令会加后缀——看到 `/mem:1` `/mem:2`、`/tasklist:1` `/tasklist:2` 而**裸命令消失**，说明旧插件仍在加载；同名工具则是 first-wins 静默遮蔽（看工具 description 是否含新能力即可判断哪一方生效）。

另外：子 agent 会话是按 settings.json 重新发现扩展的，不继承父进程的 `-e <path>`。如果本包只是用 `-e` 加载、没有出现在 settings.json 的 `packages` / `extensions` 里，子会话不会激活它，bash 后台、`switch_context`、memory 注入、cache 保活在子会话里都不会生效。请用 `pi install` 安装。

合并计划存档：[plugin-merge](../dev/plugin-merge/merge-plan.md)。

## 结果工具改名：`get_subagent_result` → `get_run_result`

读取后台 run（`r_…`，含定时任务）和后台 workflow（`wf_…`）结果的模型工具改名为 **`get_run_result`**。参数（`run_id` / `wait` / `wait_ms`）、返回结构和行为不变；只注册新名，旧名不再可调用（模型照旧名调用会得到 pi 的 `Tool get_subagent_result not found`，下一步改用新名即可；工具描述里带有过渡说明 `(Formerly named get_subagent_result.)`，下个 minor/major 删除）。其余 subagent 工具名（`Agent`、`steer_subagent`、`abort_subagent`、`extend_subagent_timeout`、`list_subagents`）不变。

**自动兼容（无需操作）**

- 旧会话 resume、fork、`/resume` 切换、`/tree` 回到旧节点时：pi ≥ 1.3 会按 transcript 恢复启用的工具集，本包检测到 transcript 里用过旧名，会自动把 `get_run_result` 追加进启用集（只追加，不移除任何工具）。**例外**：进程带 `--tools` / `-t` / `--exclude-tools` / `--no-tools` / `--no-builtin-tools` 等工具选择参数时不自动启用，视为用户的显式选择；用户在旧会话里主动停用过它也不会被重新打开。`/reload` 本身不受影响。
- TUI 与 web hub 的历史卡片：旧名的历史调用照常渲染（TUI 标题为 `Get Run Result`；web UI 的 markdown 渲染与 run 引用头新旧两名都认。旧 hub 的 UI 包需要 `/webhub restart` 才认新名，否则新名卡片退化为纯文本）。
- 飞书 `~/.pi/agent/feishu-notify.json` 的 `waitNotifyTools` 里写了旧名：读取时自动映射成新名并去重。

**需要手动修改的地方**

- pi 的 `--tools` / `--exclude-tools` 命令行参数与 settings 的 `defaultTools`：写死了旧名的要改成 `get_run_result`（否则新名不会被选中）。
- 用户自建的 traffic 改写规则里按旧名匹配的条件。
- 自己的 agent Markdown、项目 prompt、skills、外部脚本里硬编码的旧名（子会话本来就没有这个工具，agent frontmatter 的 `tools` / `excludeTools` 写不写都一样）。

**升级后的代价**：工具集变化后每个存活会话预计有一次 prompt cache miss（整段重新计费一次，是否恰好一次取决于会话与 system prompt 投影状态）；建议在空闲时 `/reload`。

**真机验证（2026-10-26）**：拿一个含旧名历史调用的真实会话，在 Anthropic messages、OpenAI responses、kimi coding、deepseek 四条线路上 resume 并续写，请求均被接受（无 400）；kimi/deepseek 的模型实际调用的是新名。部分模型口头上会照抄历史里的旧名，但真正调用时选的是当前工具列表中的新名。详见 [smoke-report](../dev/result-tool-rename/smoke-report.md)。
