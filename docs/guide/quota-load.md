# 额度与负载感知

派单前先看两件事：订阅额度还剩多少、本机现在忙不忙。两者都是"提示 + 快速失败"，数据不可知或陈旧时一律放行，不会因为读不到数据而阻断你。

## 额度感知（quota）

`quota.enabled` 默认 `true`。

**数据来源**（`quota.providers`，默认 `zai-coding-cn,zai,kimi-coding,droid`）：

- GLM（智谱 `zai-coding-cn`、海外 `zai`）与 Kimi（`kimi-coding`）订阅额度，窗口 `5h` / `week`；
- Factory droid 的 Standard / Core 两个额度池（虚拟 provider `droid-standard` / `droid-core`），窗口 `month`（HUD 记作 `mo`）。
- 结果带 TTL 缓存、无周期定时器：`quota.refreshS`=600，L1 或近耗尽时热刷新 `refreshHotS`=120，超过 `staleAfterS`=3600 视为陈旧（陈旧只提示、不拦截）。已过 `resetAt` 的窗口按 0 计（HUD 显示如 `7d 100%·reset`）。

**阶梯预警**（turn_end 注入，`quota.display` 默认 `true`）：

| 级别 | 含义                                                     |
| ---- | -------------------------------------------------------- |
| L1   | `[quota]` tick 行，告知用量                              |
| L2   | 建议按回退链降位                                         |
| L3   | 建议禁用该 provider；`quota.repeatS`（1800）只对 L3 重发 |

阈值按窗口区分（`quota.windows.<5h|week|month>.{l1,l2,l3}Percent`）：`5h` 为 50/75/90，`week` 与 `month` 为 50/95/98。旧的扁平键 `quota.l1Percent` / `l2Percent` / `l3Percent`（50/75/90）仍可用，设置后同时覆盖两个窗口；窗口级键优先于扁平键。

**派发闸门**（`quota.gate` 默认 `true`，`quota.gateLevel` 默认 `3`）：spawn 时目标 provider 已达拦截级别则快速失败，并给出改派建议。降位标记持久化到 `~/.pi/agent/quota-state.json`；上次采纳的读数也存在里面，重启后仍能识别"可疑的突然归零"。HUD 带额度状态行（`quota.hud`）。

**droid 池**：

- 派发 `droid/<id>` 时查所属池。**Core 池有回落**：Core 耗尽后实际计入 Standard 额度继续可用，所以 Core 模型只在两池都到拦截级别时才被拦；此时通知写"额度尽，回落 Standard 计费"。Standard 模型不回落；归属未知的模型要求两池都尽才拦。
- 超额付费（extra usage）默认拦截，`quota.droidAllowExtraUsage=true` 才放行。
- 401/402/403 只告警（HUD `droid auth <code>`），不拦。
- 当 `externalAgents.droid.models` 非空时，提示与改派清单只列名单内模型（见 [Subagent 系统](subagents.md#外部-droid-agent)）。
- 当 pi 订阅用完时，会按池列出可改用的 droid 模型。

Web hub 的额度胶囊、池明细见 [Web Hub](web-hub.md)。

设计：[quota](../dev/quota/quota-plan.md)、[droid 额度](../dev/external-agent/quota-plan.md)、[quota-web](../dev/quota-web/plan.md)。

## 负载感知派单（load）

`load.enabled` 默认 `true`。进程内采样 CPU（含 PSI）、内存、IO 压力和各挂载点磁盘，决定是否暂缓新派发。

- 采样 `load.sampleIntervalS`=5；一个指标需持续 `sustainS`=60 才升级、持续 `recoverS`=30 才恢复，带迟滞。总体级别取各指标最高级，全部未知则为 unknown。
- 默认阈值（`warn` / `crit`）：CPU 忙碌 85% / 95%，PSI 40% / 70%；内存可用 15% / 8%；磁盘空闲 10% / 5%（或绝对值 < 5 GiB）。均可通过 `load.cpu.*` / `load.mem.*` / `load.disk.*` 调整。
- **闸门**（`load.gate` 默认 `true`，`load.gateLevel` 默认 `"crit"`）：顶层与嵌套 `Agent`（含 resume）在闸门期间被拒绝，且拒绝发生在创建任何 run / label / worktree 之前；workflow 的 `agent()` 按 FIFO 等待；consult、`/goal` 验证、tidy、`/task`、@mention、RPC、cron 不受限。
- **提示**（`load.hint.*`，默认开）：turn_end 追加负载提示，`load.hint.repeatS`=600、`minIntervalS`=120。HUD 也带一格（`load.hud`）。
- 看谁在占资源：Web hub 的负载胶囊可打开进程聚合视图（`GET /api/load/top`，`webHub.load` 默认 `true`）。
- 非 print/json 模式、数据未知或陈旧时一律放行。`load.*` 与 `webHub.load` 非 live，需 `/reload`（hub 侧再 `/webhub restart`）。

设计：[sysload plan](../dev/sysload/plan.md)。
