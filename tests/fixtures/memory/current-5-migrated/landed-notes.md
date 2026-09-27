---
description: 已落地、别再按旧认知处理
topic: landed-notes
status: active
source: agent
---

## 已落地、别再按旧认知处理
- SubagentWorkflow `agent()` opts：未知键直接 reject；`model`/`thinking` 真透传；`experts` 支持；`isolation:"worktree"` 真隔离（回放方案 A：隔离调用及之后不读写 journal）。
- 子会话已有 bash 自动后台 + `bash_job`（bash-timeout-grace P5，`bashJobs.childSessions`）；主会话宽限/延长 P5b 已接通。
- worktree H3 子 agent 自提交丢分支已修（85bed5b）。
- （2026-09-26 补）`list_subagents` 工具已合入（8d4d34a）：reload 后派发前直接调用它查活跃 run / workflow / 空槽，不再手算。另一个高负载 flake：tests/integration/workflow-worktree.test.ts D7/D8（beforeReap 500ms）。
- verifier 是只读类型，常**不执行** prompt 里的 `git worktree add`（直接 `cd /tmp/v-*` 失败、门禁全没跑，只剩读代码结论）⇒ 派验收前主会话自己先建好只读 worktree（`git worktree add --detach /tmp/v-x <commit>` + 软链 node_modules），prompt 里只让它 cd 进去跑，结束后主会话 remove。
- web-hub 前端（2026-09-27 用户决策）：改 Vue SFC + Vite；**构建产物不进 git**，只打进 npm 包与 release zip，本地/开发 checkout 跑 `npm run build:web`，hub 缺产物显示「未构建」提示页，不做运行时下载；风格清新浅色 + 暗色跟随系统、手写 CSS 不引组件库；CSP `script-src 'self'` 不放宽（模板预编译）。
- web-hub 设置（含 webHub.lan）只在扩展 activate（reload）时读取：改完 pi-subagent.json 要先 /reload 再 `/webhub restart`；未 reload 的旧 pi 实例可能抢先拉起不带 LAN 的 hub（hub 配置由拉起它的 pi 经 PI_WEBHUB_CONFIG 传入）。

- **deveye 操作用户真实 tab**：派给子 agent 时只允许 eval/snapshot/screenshot 只读，不允许 click/navigate/type（2026-09-27 调查 agent 看错 uid 误点 web-hub 的 Sign out）；需要交互时由主会话自己做或用 fixture/临时 tab。
