---
pin: true
source: agent
updated: 2026-09-26T10:29:06.097Z
---

# 跨主题坑与用户偏好（常驻；2026-09-26 治理）

## 用户偏好
- 严格遵循 dev-flow（skills/dev-flow）：L2 方案评审 ∥ 用户确认；开发包 `subagent_type=general`（UI 用 frontend-dev，不是 general-purpose）；每包返回**立即**派 verifier，验收模型 ≠ 开发模型；L0 小修主会话直改后让原 verifier 复验；方案改口径后的开发包挂 `experts: [Plan label]`。
- 验收通过自动 commit（每任务单独 Conventional Commit，只 `git commit <精确路径>`，绝不 `git add -A`）；push/发版需用户确认（用户常自己 push，先 `git fetch` 看 origin）。
- 传输层故障（stream 中断/502/503/upstream/0 轮无进展超时）⇒ 直接 `resume` 换线续跑，不问；429 按路由换线；升 opus/用 fable 先问。
- 模型路由（2026-09-26）：开发 `cr-anthropic/claude-sonnet-5`；评审/验收 `cr-response/gpt-5.6-sol` ⇄ `zhipu-pool/gpt-5.6-sol`（zhipu 线偶发 0 轮卡死）；方案 `cr-anthropic/claude-opus-5-5`；kimi-coding / zai 额度常耗尽。provider 旧名 `cloudrouter-*` 是历史。

## 并发 / subagent
- 本机 `concurrencyLimit=10`（~/.pi/agent/pi-subagent.json）。workflow 本身不占槽，其子任务各占 1 槽；consult slotless。派发前自己数，给即将返回的包留验收槽。
- `/reload` 清空内存态 run 记录 ⇒ reload 前的 run 不能 resume、不能当 consult 专家；pi 崩溃后用 prompt 特征句 `rg -l` 找子会话 jsonl 派新 agent 接手。
- 阶段看门狗（tool/idle/modelTurn）直接杀，宽限/extend 只管总预算；显式 `timeout_s` 是硬上限。派单要求长命令带显式超时。

## git / 并行写
- 删除只用精确路径或严格正则，先列目标。
- 子 agent 会无视「禁 git stash」⇒ 收报告先 `git stash list && git status --short`；>2 写包同树用 `isolation:"worktree"`。isolation 只能从 master HEAD 建；别的分支（如 feat/web-hub-lan）手工 `git worktree add -b <br> /tmp/x <base>` + `ln -s <repo>/node_modules`，让 agent 在该目录自行提交。
- 整理 `pi-agent-<runId>` 自动提交（常带 node_modules 软链）：从最新 master 新建 worktree 分支 → `git cherry-pick --no-commit <commits>` → `git rm --cached node_modules` → 单个提交 → 全量门禁 → `merge --ff-only` → 删分支。**绝不在旧基线分支上 `git reset --soft master`**（会把 master 新提交反向带入索引）。`git merge … | tail` 会吞失败码。
- `.githooks/pre-commit` 会 `prettier --write` 后 `git add` **整个文件** ⇒ 同文件混有别人改动时部分暂存会被带进提交：先手动 prettier，`git commit --no-verify`，提交后在干净 worktree 跑 tsc + vitest 证明该提交可用。
- 同仓库常有另一会话并发提交；开工前 `git log` 查重复。

## 运行时 / 环境
- pi 用 jiti `moduleCache:false` 加载扩展 ⇒ 每个新子会话从磁盘读最新源码，宿主 stack 仍是上次 `/reload` 的代码。合入改宿主↔子会话契约的代码后必须 reload，否则出现版本错位（例：子会话 bash「no host view attached」警告）。HUD 末尾 `toolkit v…@<commit>` 显示宿主加载的提交。
- bash 工具是 zsh：`$VAR` 不分词、无 `declare -A`、`--include=*.ts` 被 glob ⇒ 用 `rg -g` 或写脚本用 bash 跑；`pkill -f` 会杀自身。长命令一律 `timeout`，全量 `timeout 280 npx vitest run`。
- pi 运行时把 `@sinclair/typebox` 别名到 typebox 1.x，devDep 是 0.34 ⇒ 测运行时行为要 `import "typebox"`。
- 调 `buildSessionStack` 的集成测试必须 `sandboxHome()`，否则本机真 key 发真请求。
- 已知高负载 flake（单独重跑能过）：tests/bash/process.test.ts 计时项、tests/web-hub/protocol/pid.test.ts、tests/workflow/worker-integration.test.ts、tests/integration/bash-jobs-wiring.test.ts。测试里别用「N 次 setImmediate」当超时（CI 慢机会挂），用时钟上限。

## 已落地、别再按旧认知处理
- SubagentWorkflow `agent()` opts：未知键直接 reject；`model`/`thinking` 真透传；`experts` 支持；`isolation:"worktree"` 真隔离（回放方案 A：隔离调用及之后不读写 journal）。
- 子会话已有 bash 自动后台 + `bash_job`（bash-timeout-grace P5，`bashJobs.childSessions`）；主会话宽限/延长 P5b 已接通。
- worktree H3 子 agent 自提交丢分支已修（85bed5b）。
- （2026-09-26 补）`list_subagents` 工具已合入（8d4d34a）：reload 后派发前直接调用它查活跃 run / workflow / 空槽，不再手算。另一个高负载 flake：tests/integration/workflow-worktree.test.ts D7/D8（beforeReap 500ms）。
- verifier 是只读类型，常**不执行** prompt 里的 `git worktree add`（直接 `cd /tmp/v-*` 失败、门禁全没跑，只剩读代码结论）⇒ 派验收前主会话自己先建好只读 worktree（`git worktree add --detach /tmp/v-x <commit>` + 软链 node_modules），prompt 里只让它 cd 进去跑，结束后主会话 remove。
- web-hub 前端（2026-09-27 用户决策）：改 Vue SFC + Vite；**构建产物不进 git**，只打进 npm 包与 release zip，本地/开发 checkout 跑 `npm run build:web`，hub 缺产物显示「未构建」提示页，不做运行时下载；风格清新浅色 + 暗色跟随系统、手写 CSS 不引组件库；CSP `script-src 'self'` 不放宽（模板预编译）。
- web-hub 设置（含 webHub.lan）只在扩展 activate（reload）时读取：改完 pi-subagent.json 要先 /reload 再 `/webhub restart`；未 reload 的旧 pi 实例可能抢先拉起不带 LAN 的 hub（hub 配置由拉起它的 pi 经 PI_WEBHUB_CONFIG 传入）。

- **deveye 操作用户真实 tab**：派给子 agent 时只允许 eval/snapshot/screenshot 只读，不允许 click/navigate/type（2026-09-27 调查 agent 看错 uid 误点 web-hub 的 Sign out）；需要交互时由主会话自己做或用 fixture/临时 tab。
