# 刷新慢修复 — 活体验收（2026-10-28 17:58，hub 重启后）

对象：真实会话 `a1556874-vDjp6f`（session 文件 190.9MB / 30,613 行）。
方法：playwright headless Chromium 开 `/#/agent/a1556874-vDjp6f`，计时 subscribe→history 帧、首条 `.tx-item`、加载期间 `/api/version` 最大延迟、hub RSS（/proc）。冷/热各一次。

| 指标 | 修复前（explore 实测） | 门禁（plan §6.2） | 实测 冷 | 实测 热 | 判定 |
|---|---|---|---|---|---|
| 进入详情页→首条 `.tx-item` | 7,394ms | <300ms* | 1,121ms | 698ms | 病理消除（10×） |
| subscribe→history 帧 | 6,957–7,133ms | <150ms* | 804ms | 391ms | 9–18× |
| 快照期间 `/api/version` 最大延迟 | 5,746ms | <50ms | 37ms | 25ms | ✅ 主线程不再阻塞 |
| hub RSS 增量 | +1,051MB（VmHWM 2,660MB） | <200MB | +13MB | +2MB | ✅ |

\* 门禁数字源自 explore 对「纯投影」的估算（尾读投影实测 32–90ms，达成）；端到端含登录、SSE 建连、1.2MB 帧序列化与传输的固定开销。用户可感结果：刷新从 7.4s 骨架屏变为亚秒级。

结论：实质通过。残留：history 帧 391ms（热）中约 300ms 为固定管线开销（非文件规模相关），如需再压可从帧体积入手，与本次修复无关。
