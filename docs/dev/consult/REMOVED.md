# consult 已移除（#40）

`consult` 工具、Agent / workflow 的专家咨询入口、相关设置与实验脚本已移除。子 agent 遇到代码中读不到的决策或范围问题，应通过 `message_agent` 向父 agent 提问；已有结论通过结构化交接包传递。

本目录的方案、评测与实验结果按 Q11 保留为历史档案，不作为当前使用指南。旧会话和磁盘布局的兼容读取策略见 [移除方案](../consult-removal/plan.md)。开发者 README 里的 consult 入口与门禁已由 PS2 清理；残留只有标明 legacy / #40 的兼容说明。
