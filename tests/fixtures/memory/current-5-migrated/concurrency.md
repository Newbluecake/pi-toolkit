---
description: 并发 / subagent 坑
topic: concurrency
status: active
source: agent
---

## 并发 / subagent
- 本机 `concurrencyLimit=10`（~/.pi/agent/pi-subagent.json）。workflow 本身不占槽，其子任务各占 1 槽；consult slotless。派发前自己数，给即将返回的包留验收槽。
- `/reload` 清空内存态 run 记录 ⇒ reload 前的 run 不能 resume、不能当 consult 专家；pi 崩溃后用 prompt 特征句 `rg -l` 找子会话 jsonl 派新 agent 接手。
- 阶段看门狗（tool/idle/modelTurn）直接杀，宽限/extend 只管总预算；显式 `timeout_s` 是硬上限。派单要求长命令带显式超时。
