# #23 Web 插件更新卡在「等待更新」· 根因定位

> 来源：Explore run r_YRHXQ6VM（glm-5.3，只读，2026-11-05），主会话落盘。用户 2026-11-05 经 ask_user 选定：本次修 A（RC1）+ B（RC2），RC3 另开 #24。
> 委派来源：brain 会话（ref 01a1a966-0b1，reply_to qb10722dea2fb3f9d49）。

## 链路（文件:行）

1. 按钮：「需更新」chip `src/web-hub/ui/src/components/agents/AgentCard.vue:92-95`；详情页提示条 `components/detail/OutdatedReloadBanner.vue:122-128`；汇总「全部重新加载」`composables/useOutdatedReload.ts`（reloadAll）。
2. 状态机 `OrCoordinator`：`src/web-hub/ui/src/logic/outdatedReload.ts`（idle→queued/sending→awaiting/parked→done/failed）。「等待更新」= `awaiting`（90s 上限 `OR_EFFECT_TIMEOUT_MS`）或 `parked`（等子 agent 结束，30min 上限）；文案 `ui/src/i18n/zh/outdated.ts`。
3. transport：`useOutdatedReload.ts:134-150` `control.runCommand(key,"agent","reload",{confirm:true})` → POST `/api/cmd` op=command（`ui/src/types.ts:417`）。
4. hub：`src/web-hub/hub/http-cmd.ts:129`、`:609`（`commands.request(frame)`）。
5. agent：`src/web-hub/agent/commands.ts:1056,1240`；`/agent reload` → `src/reload/command-port.ts`（忙时 arm 后立即返回；闲时 `await ctx.reload()`）；web 直发 `/reload` 走 `agent/builtin-bridge.ts:607-617`（`sendUserMessage("/agent reload")` 后立即返回 ok, completion:"unknown"）。
6. 完成信号：reload → 新 `MODULE_INSTANCE`（`agent/connection.ts:48`）→ handover（`connection.ts:257-273`）→ 新 hello 携新版本（`connection.ts:628`；`agent/index.ts:1527-1545,2569-2574`）→ hub `registry.ts:425-427` **仅当 `prevPhase==="stale" ∨ (epochChanged ∧ caps∋hold.v1)` 才广播 `agent_up`**，否则只发 `gap` → SSE（`hub/http.ts:671-672`）→ UI `mergeCard`（`ui/src/logic/state.js:689-702,1148`）；`gap` 只标 `needsResync`（`state.js:808-810`）。
7. 解除等待：`useOutdatedReload.ts` watch（busy/fleet/`sessionReloadedToHub`）→ `notifyTick` → `isSettled`（`card.pluginVersion == hub.version ∧ !card.outdated`）→ done。**前端唯一解除条件是版本帧，无 ack/离线兜底。**

## 本机证据（`~/.pi/agent/web-hub/hub.log`，2026-11-05）

- 02:48:13Z 4 条 `op:command name:"agent" ok:true ~9ms`（命令送达并被接受）。
- 全日志 0 条 `agent reclaimed epochChanged:true`。
- 4 个目标会话随后 `agent down reason:"quit"`，7–11s 后新 pid、新 agentKey、v0.10.6 顶上。
- 03:05:02 手动 `/reload`：`ok:true 8ms`，同样无 handover 记录。

## 根因

- **RC1 [F]**：UI 把命令 ack 当作 reload 进行中，唯一成功判据是版本帧；deferred reload 的 arm/park/fire 与目标会话下线都没有对应信号。目标在等待期间退出时只能等 90s/30min 超时，卡片不刷新、chip 常亮。
- **RC2 [F]**：即使 reload 成功，epoch 变化只有在 caps 含 `hold.v1`（steerRecall 开）或记录已 stale 时才广播 `agent_up`；否则只发 `gap`，UI 不更新卡片 ⇒ 成功 reload 也会超时。
- **RC3 [I]**：跨版本 reload（0.10.5 进程 → 磁盘 0.10.6）疑似导致目标进程退出 ⇒ 另开 #24。

## 修复方向（用户已选 A+B）

- **A 前端（RC1）**：`OrCoordinator` deps 增 `agentDown(key)`；watch 签名加入 `agent.down` / `card.state==="stale"`；`queued/sending/awaiting/parked` 任一阶段遇到下线 ⇒ 立即 `fail(key,"E_OFFLINE")` 并清计时器；版本帧先到仍优先 done。文件：`ui/src/logic/outdatedReload.ts`、`ui/src/composables/useOutdatedReload.ts`（+ i18n 文案）。
- **B hub（RC2）**：`registry.ts:426` 条件改为 `epochChanged ∧ (hold.v1 ∨ reload.v1)`；新增追加式 agent cap `reload.v1`（`protocol/version.ts`），agent `capsExtra` 带上（`agent/index.ts`）。老 agent 无新 cap ⇒ 仍 gap-only，字节不变（I10）。

## 测试缺口

- `tests/web-hub/ui/outdated-reload.test.ts` 只测纯协调器，没有 handover→agent_up→卡片更新→done 的闭环，也没有「等待期间目标下线」。
- registry 测试把「无 hold.v1 ⇒ gap-only」钉死（Y7.2），但没和 outdated chip 的成功判据关联。
- 最小测试点：A — awaiting/parked 期间 `agentDown` ⇒ `failed E_OFFLINE` 且计时器清空、版本帧先到仍 done；B — epoch 变化 + 新 cap ⇒ 广播 `agent_up`，无新 cap 的老形状保持 gap-only（冻结字节）。
