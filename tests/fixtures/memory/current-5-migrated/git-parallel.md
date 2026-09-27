---
description: git / 并行写坑
topic: git-parallel
status: active
source: agent
---

## git / 并行写
- 删除只用精确路径或严格正则，先列目标。
- 子 agent 会无视「禁 git stash」⇒ 收报告先 `git stash list && git status --short`；>2 写包同树用 `isolation:"worktree"`。isolation 只能从 master HEAD 建；别的分支（如 feat/web-hub-lan）手工 `git worktree add -b <br> /tmp/x <base>` + `ln -s <repo>/node_modules`，让 agent 在该目录自行提交。
- 整理 `pi-agent-<runId>` 自动提交（常带 node_modules 软链）：从最新 master 新建 worktree 分支 → `git cherry-pick --no-commit <commits>` → `git rm --cached node_modules` → 单个提交 → 全量门禁 → `merge --ff-only` → 删分支。**绝不在旧基线分支上 `git reset --soft master`**（会把 master 新提交反向带入索引）。`git merge … | tail` 会吞失败码。
- `.githooks/pre-commit` 会 `prettier --write` 后 `git add` **整个文件** ⇒ 同文件混有别人改动时部分暂存会被带进提交：先手动 prettier，`git commit --no-verify`，提交后在干净 worktree 跑 tsc + vitest 证明该提交可用。
- 同仓库常有另一会话并发提交；开工前 `git log` 查重复。
