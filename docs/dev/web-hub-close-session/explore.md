# web 关闭托管会话——现状探索（2026-10-06，Explore k3 r_T1QCYMD4，主会话落盘）

## 结论

「关闭 hub 托管（managed spawn）会话」已全链路存在：

- API：`POST /api/headless/:id/stop`，body 可选 `{force:true}`，幂等（`src/web-hub/hub/spawn/routes.ts:638-704` `handleStop` → `supervisor.stop`，`supervisor.ts:1518-1529`）。
- 停止梯（`supervisor.ts:773-799`）：stdin EOF（5s）→ SIGTERM(-pgid)（3s）→ SIGKILL(-pgid)（5s）→ 守卫置 `exit.unconfirmed`；每次发信号前同步身份复验。`force` 跳过 stdin 宽限。
- UI：详情页头 `DetailHeader.vue:76-124,165-181`「停止会话」两步确认（4s 解除），`useSpawn.stop(spawnId)` 不带 force；仅 `managedFor(spawns, agentKey)` 命中（state ∈ live/stopping 且有 agentKey，`logic/spawn.js:179-198`）时渲染。卡片 `web` 徽章区分托管会话（`AgentCard.vue`）。
- pi RPC 协议无 exit/shutdown 命令；stdin EOF 即优雅退出（rpc-mode.js:638），SIGTERM 跳过 stdout flush。
- 权限：严格 CSRF（JSON + `X-PWH: 1` + Origin），stop 无 owner 检查（arch §6.0 #8 有意裁定），限流 10/2s；`spawn.lan=off` 时 LAN 面整体 404。
- 关闭后：记录 `exited{endReason:user}` 保留（≤20 条终态），agent 卡片保留标 stopped；会话 jsonl 保留，TUI 可 resume，web 无 resume 路径。

## 缺口

1. UI 无 force 入口；2. 列表页（AgentCard）无关闭入口，只能进详情页；3. 无 web 侧 resume；
2. 终态记录/已停卡片无法手动清除；5. cmd 面无 close op（不需要，stop API 已覆盖）。

## 测试坐标

`tests/integration/web-hub-headless.test.ts`（closure 用例 stop→exited{user}，:554-669）、
`tests/web-hub/hub/spawn/supervisor.test.ts`、`tests/web-hub/ui/detail-header.test.ts`、`tests/web-hub/ui/logic-spawn.test.ts`。
设计：`docs/dev/web-hub-spawn/{arch,plan,acceptance}.md`。
