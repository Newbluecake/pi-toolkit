# 从独立插件迁移

下列独立插件已逐一融合进本包。迁移 = **卸载旧包 + 升级本包 + `/reload`**：

- `@getpipher/armory-memory` → `pi remove` 即可，memory 数据（`~/.pi/agent/memory/**`）零迁移生效。
- `@bluecake/pi-ask-user` → `pi uninstall`；飞书配置 `~/.pi/agent/feishu-notify.json` 原样保留。
- pi-hud / web-search / pi-claude-todo / session-nav 等散装扩展 → 删除 `~/.pi/agent/extensions/` 下对应的文件或目录。

**残留识别**：pi 对重名命令会加后缀——看到 `/mem:1` `/mem:2`、`/tasklist:1` `/tasklist:2` 而**裸命令消失**，说明旧插件仍在加载；同名工具则是 first-wins 静默遮蔽（看工具 description 是否含新能力即可判断哪一方生效）。

另外：子 agent 会话是按 settings.json 重新发现扩展的，不继承父进程的 `-e <path>`。如果本包只是用 `-e` 加载、没有出现在 settings.json 的 `packages` / `extensions` 里，子会话不会激活它，bash 后台、`switch_context`、memory 注入、cache 保活在子会话里都不会生效。请用 `pi install` 安装。

合并计划存档：[plugin-merge](../dev/plugin-merge/merge-plan.md)。
