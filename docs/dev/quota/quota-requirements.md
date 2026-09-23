# Quota-Aware Dispatch — 设计简报（用户已确认）

- 日期：2026-09-23
- 车道：L2
- 来源：主会话与用户的设计讨论（两轮，均已确认）
- 下游：`docs/dev/quota/quota-plan.md`（实施方案）、`docs/dev/quota/integration-map.md`（集成点地图）

## 目标

把「订阅剩余额度」变成 Agent 调度（dev-flow 主会话派单决策）的免费参考值：

1. **零工具调用**：模型不需要花 turn 调工具查额度，额度信息在派单决策时刻已在上下文中。
2. **提前预警**：阶梯式 + 速率预测，在耗尽前就开始把派单导流到回退链后位模型。
3. **兜底**：真正耗尽/429 时 spawn 快速失败并直接给出替代模型，不烧失败 run。

## 已验证的外部契约（2026-09 实测）

### GLM Coding Plan（zai-coding-cn / zai）

- 端点：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（国内）/
  `GET https://api.z.ai/api/monitor/usage/quota/limit`（海外，同 key 同数据）
- 认证：`Authorization` 头放**裸 key**（无 `Bearer ` 前缀）
- 响应形状（实测样例）：

```json
{
  "code": 200,
  "data": {
    "level": "max",
    "limits": [
      {
        "type": "CREDIT_LIMIT",
        "unit": 3,
        "number": 5,
        "usage": 28000,
        "currentValue": 79,
        "remaining": 27920,
        "percentage": 1,
        "nextResetTime": 1790187105217
      },
      {
        "type": "CREDIT_LIMIT",
        "unit": 6,
        "number": 1,
        "usage": 140000,
        "currentValue": 20486,
        "remaining": 119513,
        "percentage": 14,
        "nextResetTime": 1790754528987
      }
    ]
  }
}
```

- `unit: 3` = 5 小时窗口，`unit: 6` = 周窗口；`nextResetTime` 为毫秒时间戳；`percentage` 为已用百分比（取整）。
- 团队版需 `?type=2` + `bigmodel-organization` / `bigmodel-project` 头（**本期不做**，接口留扩展位）。
- key 来源：pi 自己的 auth store（`zai-coding-cn` / `zai` 条目）。优先走 pi 扩展 API 读取，硬编码文件路径为下策——由 Plan 决定具体方式。

### Kimi Code 订阅（kimi-coding，CN 站）

- 端点：`GET https://api.kimi.com/coding/v1/usages`（海外站 `api.kimi.ai` 同路径，**未实测**，首版只挂 CN）
- 认证：`Authorization: Bearer <sk-kimi-... key>`
- ⚠ **必须带浏览器 User-Agent**：裸 curl 默认 UA 会被 Cloudflare 拦（社区实测 403 error 1010）。
- 响应形状（实测样例，已截去 booster_wallet 钱包字段——本期不用）：

```json
{
  "usage": { "limit": "100", "used": "100", "resetTime": "2026-09-28T01:06:33.380237Z" },
  "limits": [
    {
      "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
      "detail": { "limit": "100", "remaining": "100", "resetTime": "2026-09-23T18:06:33.380237Z" }
    }
  ],
  "usages": {
    "limit_5h": { "used_ratio": 0, "reset_time": "2026-09-23T18:06:32Z" },
    "limit_7d": { "used_ratio": 1, "reset_time": "2026-09-28T01:06:32Z" }
  }
}
```

- 解析要点：优先读顶层 `usages.limit_5h` / `usages.limit_7d`（`used_ratio` 0..1 浮点 + ISO 时间戳，最规整）；
  `usage`（周）与 `limits[].detail`（5h，`window.duration:300` 分钟）是字符串数字，做兜底对照。
- **语义陷阱（实测踩到）**：周窗口耗尽（`used_ratio:1`）时 5h 窗口可能仍显示 `remaining:100`——
  provider 级判定必须取**所有窗口的最高严重级**（周 L3 胜出），不能只看 5h。
- 已知上游 bug（MoonshotAI/kimi-code#1569）：某些字段（totalQuota）恒为 99——不要依赖它，只用 ratio。

### Moonshot 开放平台按量余额（moonshot）

- 端点：`GET https://api.moonshot.cn/v1/users/me/balance`，`Authorization: Bearer <key>`
- 响应：`{ "data": { "available_balance": 0, "voucher_balance": 0, "cash_balance": -5.04 } }`（CNY）
- 语义不同：这是**余额**不是窗口额度——映射规则：`available_balance <= 0` → provider 不可用（L3 等价），
  否则只显示不打扰。快照结构里作为独立 kind 处理。

### 通用注意

- 三家端点都是控制台后端接口（非公开 API），响应形状可能变：解析必须宽容，任何异常静默降级。
- key 来源全部是 pi 自己的 auth store（`zai-coding-cn` / `zai` / `kimi-coding` / `moonshot`）。优先走 pi
  扩展 API 读取，硬编码文件路径为下策——由 Plan 决定具体方式。

## 架构（四层）

```
auth store ──> [1] 数据层 src/quota/ ──TTL缓存──> [2] 注入层（省 turn）
               适配器: zai ✅ / moonshot(未来)       [3] 调用时闸门（省整次 run）
                                                    [4] HUD（人看）
```

1. **数据层**：适配器接口 `fetchQuota(): Promise<QuotaSnapshot | undefined>`；**本期三个适配器**：zai（GLM 双窗口）、kimi（订阅双窗口 + 周耗尽陷阱）、moonshot（按量余额→不可用判定）；TTL 缓存（默认 ~10min，各自独立）；定时器一律 unref；**静默降级**——任何失败返回 `undefined` 绝不抛（照抄 `src/context-switch/session-facts.ts` 的纪律）。快照需把三家归一化：`{ provider, kind: 'windows'|'balance', windows?: [{scope:'5h'|'week', usedPct, resetAt}], balanceCny? }`。
2. **注入层**：turn_end 钩子 + 阶梯预警（见下）。复用 compact-hint 的消息通道与「数值阶梯」手法。
3. **调用时闸门**：spawn 路径同步检查**缓存快照**（绝不在 spawn 路径发网络请求）；窗口耗尽 → 快速失败给替代模型；`formatModelCandidates` 输出附带额度标记。
4. **HUD**：status key 一行显示（人看；模型不需要）。

## 预警阶梯（核心需求：提前，不是耗尽才提醒）

两维判断，不只看百分比：

```
usedPct    ──> 阶梯网格（默认 50 / 75 / 90%，可配置）
burn rate  ──> 耗尽预测：两次刷新间的用量 delta → ETA(耗尽) vs nextResetTime
```

速率预测是「提前」的关键：百分比 60% 但烧得快、重置还远 → 立即 L2；百分比 90% 但马上重置 → 不慌。

| 级别     | 触发条件               | 行为                                                                                 |
| -------- | ---------------------- | ------------------------------------------------------------------------------------ |
| L0 静默  | < L1 阈值 且预测安全   | 不注入（只进 HUD）                                                                   |
| L1 提示  | ≥50%（默认）           | 低频一行 tick：`[quota] glm-5.3 5h 62%`                                              |
| L2 建议  | ≥75% 或 预测重置前耗尽 | `⚠ glm-5.3 5h 62%，按当前速率 ~01:40 耗尽（重置 02:11）。本轮派单建议先 kimi-k3`     |
| L3 强烈  | ≥90% 或 ETA < 30min    | `⛔ glm-5.3 5h 即将耗尽，本轮禁用，直接 kimi-coding/k3-256k → opus-5` + 候选降位标记 |
| 兜底闸门 | 实际 429 / 100%        | spawn 快速失败给替代模型（理想情况 L2/L3 已使其永不触达）                            |

- **降级标记持久化**：provider 越过 L2 后，之后每轮 `[quota]` 行持续携带「已降位」标记直到窗口重置——不指望模型每轮重新注意。
- **双窗口独立计算**：5h 与周窗口分别跑阶梯，互不干扰；但 **provider 级判定取全部窗口的最高严重级**（Kimi 周耗尽而 5h 空闲的陷阱）。
- L1 tick 需要防噪音（同窗口同级别不重复刷屏，或每 N 轮一次——Plan 决定具体策略）。

## Settings 草案

`quota.enabled`、`quota.providers`（默认 zai + kimi + moonshot 全开）、`quota.refreshMinutes`（默认 10）、
`quota.thresholds { l1: 50, l2: 75, l3: 90 }`（百分比）、`quota.hud`（默认 true）。
字段名与默认值由 Plan 按 setting-specs 现有模式定稿。

## 约束（AGENTS.md 铁律，违反即打回）

- `src/index.ts` assembly-only；新服务的构造/接线进 `src/stack.ts` 的 `buildSessionStack`。
- 严格 TS（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）；ESM 相对导入带 `.js` 后缀。
- 无模块级可变状态（扩展在 /reload 下存活）；定时器一律 `unref()`。
- 子会话惰性（HOST_KEY guard 之后不注册）；注入层只对主会话生效（子会话派单无意义）。
- 工具参数 typebox schema；prettier；1800+ 既有测试保持绿。
- 网络失败的重试/退避参考 `src/web-search/resilience.ts`；**绝不阻塞** turn_end / spawn 主路径（懒触发、缓存先行）。

## 明确不在本期范围

- GLM 团队版 `?type=2` 查询（接口留扩展位）
- Kimi 海外站（`api.kimi.ai`，同路径未实测，首版只挂 CN；留配置位）
- 把额度折算成美元成本（HUD 已有成本线）
- CloudRouter / zhipu-pool 等中转池（无公开额度端点）

## 验收标准

- `npm run typecheck` / `format:check` / `test` / `build` 全绿。
- 阶梯逻辑单元测试：速率预测、降位标记持久化、双窗口独立 + provider 级取最高严重级、moonshot 余额归不可用、静默降级（端点挂了 → 一切照旧）。
- 真实 key 冒烟：GLM + Kimi + moonshot 各拉一次（主会话手动）。
- dev-flow `SKILL.md` 加一句静态规则（主会话改，跨仓库文件）：派单前参考 `[quota]` 行；越过 L2 的 provider 在回退链中降一位。
