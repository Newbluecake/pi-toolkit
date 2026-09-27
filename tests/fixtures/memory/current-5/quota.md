---
source: agent
updated: 2026-09-25T13:33:48.000Z
---

# quota-aware dispatch（src/quota/，设计 docs/dev/quota/，plan §13 为验收后修订）

- 链路：订阅额度拉取 → turn_end 阶梯预警注入（L1/L2/L3）→ spawn 准入快速失败 → HUD 独立状态行（status key `quota`，组装在 `renderExtensionStatusLines`，测试 tests/hud/footer.test.ts）。
- 用户决策（别推翻）：零定时器（turn_end 懒刷新，空闲时 HUD 行冻结）；注入走 `sendMessage triggerTurn:false`，**禁 systemPrompt**（打脏缓存前缀）；stale 快照零注入且闸门放行；**充值余额检测已移除**（moonshot 适配器删除，别加回）；恢复倒计时用文字 token `resets 2d11h`（否决 ↻ 图标），取用完窗口 resetAt 最大值，任一未知不显示。
- zai-coding-cn 与 zai 同 key 时展示层去重（dedupeVerdicts），gate 仍按 provider id 独立。
- 端点契约（非公开 API，2026-09 实测）：GLM `GET open.bigmodel.cn/api/monitor/usage/quota/limit` 裸 key 无 Bearer，`data.limits` 只有 unit:3（5h）/unit:6（week）；Kimi `GET api.kimi.com/coding/v1/usages` Bearer + 浏览器 UA（Cloudflare 拦裸 UA），只读 `usages.limit_5h/limit_7d`（totalQuota 恒 99 是上游 bug；`booster_wallet` 是余额不是窗口）。**两家都没有月度窗口**，别加 month scope。
- 阶梯阈值按窗口（#7，已落地）：5h 50/75/90、week/7d 50/95/98（`ladder.ts` DEFAULT_THRESHOLDS_BY_WINDOW）；`quota.windows.{5h,week}.*` 覆盖单窗口，旧扁平 `quota.l1Percent…` 仍同时覆盖两窗口；HUD >95% 显示 resets，L3 多 provider 合并播报。
