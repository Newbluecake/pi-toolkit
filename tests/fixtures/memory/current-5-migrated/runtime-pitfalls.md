---
description: 运行时 / 环境坑
topic: runtime-pitfalls
status: active
source: agent
---

## 运行时 / 环境
- pi 用 jiti `moduleCache:false` 加载扩展 ⇒ 每个新子会话从磁盘读最新源码，宿主 stack 仍是上次 `/reload` 的代码。合入改宿主↔子会话契约的代码后必须 reload，否则出现版本错位（例：子会话 bash「no host view attached」警告）。HUD 末尾 `toolkit v…@<commit>` 显示宿主加载的提交。
- bash 工具是 zsh：`$VAR` 不分词、无 `declare -A`、`--include=*.ts` 被 glob ⇒ 用 `rg -g` 或写脚本用 bash 跑；`pkill -f` 会杀自身。长命令一律 `timeout`，全量 `timeout 280 npx vitest run`。
- pi 运行时把 `@sinclair/typebox` 别名到 typebox 1.x，devDep 是 0.34 ⇒ 测运行时行为要 `import "typebox"`。
- 调 `buildSessionStack` 的集成测试必须 `sandboxHome()`，否则本机真 key 发真请求。
- 已知高负载 flake（单独重跑能过）：tests/bash/process.test.ts 计时项、tests/web-hub/protocol/pid.test.ts、tests/workflow/worker-integration.test.ts、tests/integration/bash-jobs-wiring.test.ts。测试里别用「N 次 setImmediate」当超时（CI 慢机会挂），用时钟上限。
