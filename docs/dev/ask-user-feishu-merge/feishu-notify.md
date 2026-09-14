# Feishu 通知（合并版）

本包通过 `feishu-notify.ts` 注册 Feishu 通知扩展。配置文件仍为
`~/.pi/agent/feishu-notify.json`，也可使用 `FEISHU_WEBHOOK_URL` 和
`FEISHU_WEBHOOK_SECRET`。

## 触发方式

- 在任务输入中加入 `@notify` 或 `#notify`，只关注本次任务。
- `/watch` 切换会话级关注。在配置文件中设置 `"watchDefault": true`
  可让每个新会话默认进入关注状态（进入会话后仍可用 `/watch` 临时关闭）。
- 使用 `/feishu-test` 验证 webhook。

通知均为被动触发，不再提供 AI 主动调用的 `feishu_notify` 工具。

## 后台门控

主扩展通过 `Symbol.for("pi-subagent:background-status")` 发布当前 session 的
后台 subagent 和后台 bash 数量。默认情况下，结果卡、subagent 汇总卡和空闲提醒
只有在两项均为零时才发送。**主会话停下时若后台仍在忙，说明任务尚未结束，
完成类通知直接抑制，不暂存、不补发**：结果卡就这样丢弃；subagent 汇总卡保留
记录，等后台空闲后的下一个自然触发点（settle / 投递 / agent_start 补偿）再组卡；
空闲提醒本身只在真·空闲时才 arm，后台忙时不会启动。

心跳卡、等待输入卡以及 `/feishu-test`、`/watch` 等显式触发不受
后台门控影响。`bashJobs.autoBackgroundS` 为零时，后台 bash 计数为 `null`，该条件
按恒真处理。provider 缺失时受门控通知 fail-closed，并写入
`~/.pi/agent/feishu-notify.log`；豁免通知仍可发送。

可选配置：

```json
{
  "watchDefault": false,
  "requireBackgroundIdle": true
}
```

`requireBackgroundIdle: false` 表示不要求后台空闲，完成类通知在主会话停下时
立即发送（即使仍有 subagent/后台 bash 在跑）。

## 从独立包迁移

1. `pi uninstall @bluecake/pi-ask-user`，或从 pi packages 配置移除旧包。
2. 安装/升级 `pi-subagent`，启用其三个 `pi.extensions` 入口。
3. 原 `feishu-notify.json` 无需迁移；按需增加上面的门控设置。
4. 看到旧包冲突 warning 时，先移除旧包再执行 `/reload`。

独立 `pi-ask-user` 与合并版同时安装属于不支持的配置，因为同名工具、命令和事件
处理器可能重复注册并造成重复卡片。
