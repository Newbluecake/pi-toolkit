# Feishu 通知（合并版）

本包从唯一扩展入口注册飞书 webhook 通知。推荐把配置放入
`<agentDir>/pi-toolkit.json` 的顶层 `feishuNotify`（默认 agentDir 为 `~/.pi/agent`，
跟随 `PI_CODING_AGENT_DIR` 及统一设置的继承规则）。这不是 Web Hub 的 `feishuBot`。
旧 `~/.pi/agent/feishu-notify.json` **仍兼容，不自动复制、迁移或删除**。

## 配置与优先级（#70）

每个字段独立选择：**统一 `feishuNotify` 有效字段 → 旧独立文件有效字段 → 环境变量 → 内置默认**。
环境回退只有 `webhookUrl` 对应 `FEISHU_WEBHOOK_URL`、`secret` 对应
`FEISHU_WEBHOOK_SECRET`；其余字段没有环境变量。
`enabled` 是统一设置专属总开关，默认 `true`，旧文件的 `enabled` 不参与解析。
`enabled:false`、secure 或 locked 域强制关闭时，不读取旧文件，也不靠环境变量重新开启。

- 省略、`undefined`（程序调用）、`null`、错误类型或非有限数值表示本层缺省，继续向下回退。
  整段为 `null` / 数组 / 非对象同样视作缺省；关闭请用 `{ "enabled": false }`，不是整个段写 `false`。
- 布尔只接受真正的 `true` / `false`；**显式 `false` 不回退**。
- 数值只接受有限 number；**`0` 和负数保留**，按下表关闭对应机制；手写 JSON 兼容小数。
  普通设置编辑器只接受非负秒数，旧毫秒字段不会被自动转换或改写。
- 字符串（含空串）保留。`webhookUrl:""` 明确停止发送（不回退旧文件/环境）；
  `secret:""` 明确关闭签名，不阻止 webhook 本身继承。
- `waitNotifyTools` 必须是全为字符串的 JSON 数组（会复制并映射旧工具名）；
  `[]` 明确不提醒任何工具；错误数组整字段回退，不把非法元素当工具名。
- 缺失、不可读、坏 JSON 或非对象旧文件静默视作缺省；坏统一文件按统一 loader 的规则回落默认设置，
  再按旧文件/环境回退。解析错误不打印文件内容或异常原文。

`FEISHU_NOTIFY_CONFIG_PATH` **只覆盖旧独立文件的回退路径**，不会选择统一设置文件、
不会提升旧文件优先级，也不会禁用环境回退。未设时用固定的
`~/.pi/agent/feishu-notify.json`（不跟随 agentDir）；非空路径原样使用（相对路径相对进程 cwd，
不展开 `~`）；空串表示不读旧文件。统一设置文件仍由 agentDir 与既有新/旧设置文件名规则选择。

完整字段（下表是最终默认，不是自动写入统一设置的覆盖值）：

| `feishuNotify` 字段         | 默认           | 含义                                            |
| --------------------------- | -------------- | ----------------------------------------------- |
| `enabled`                   | `true`         | 统一设置专属总开关；secure/locked 始终关闭      |
| `webhookUrl`                | 未设置         | 机器人 webhook URL，JSON-only；也可从环境回退   |
| `secret`                    | 未设置         | webhook 签名密钥，JSON-only；也可从环境回退     |
| `waitNotifyTimeoutSec`      | `120`          | 交互工具等待提醒秒数；≤0 关闭                   |
| `waitNotifyTools`           | `["ask_user"]` | 等待提醒工具列表，JSON-only；旧工具名读取时映射 |
| `heartbeatIntervalSec`      | `600`          | 长任务心跳间隔秒数；≤0 关闭                     |
| `idleNotifyTimeoutSec`      | `300`          | settle 后无新输入的空闲提醒秒数；≤0 关闭        |
| `subagentSummaryEnabled`    | `true`         | 是否发送 subagent 汇总卡                        |
| `subagentFlushDebounceMs`   | `1500`         | 汇总去抖毫秒；≤0 立即 flush；JSON-only          |
| `subagentDeliveryGraceMs`   | `6000`         | 等待投递通道的宽限毫秒；≤0 不等；JSON-only      |
| `subagentForegroundSummary` | `false`        | 兼容字段：将历史纯前台 run 纳入汇总             |
| `requireBackgroundIdle`     | `true`         | 完成类通知要求后台空闲                          |
| `watchDefault`              | `false`        | 新会话默认关注（`/watch` 可临时切换）           |

安全配置示例（不含凭据，URL/签名可保留环境变量或已有旧文件回退）：

```json
{
  "feishuNotify": {
    "enabled": true,
    "watchDefault": false,
    "requireBackgroundIdle": true,
    "heartbeatIntervalSec": 0
  }
}
```

改动后 `/reload`；发送端也会在 `session_start` 与 `/feishu-test` 重新读取配置，但不要依赖它
代替 reload（尤其是总开关）。这组通知设置不需要 `/webhub restart`。
普通 `/agent settings` / `list` / 补全只展示总开关、三个 `*Sec` 数字与四个布尔字段。
新增字段未设时显示 `(unset)`，表示继承，而不是强行覆盖旧文件的默认值；重置会移除统一覆盖并恢复回退。
凭据与数组/毫秒项只允许手工编辑 JSON；`secret` / `webhookUrl` 不进入普通明文设置行和 `set` 命令。

**凭据保护**：包含 URL 或签名密钥的统一/独立 JSON 都是本地明文，建议文件权限 `0600`，
不要提交、贴日志或发给模型；也可继续使用环境变量。
加载/持久化的 JSON 语法错误不回显原文；发送失败只返回 HTTP 状态或固定网络错误，
不记录远端响应正文、fetch 异常、URL 或签名内容。Web Hub 共存诊断只接收两个布尔值
`configured` / `watchDefault`，不带凭据。旧文件与备份不会自动删除，仍须用户自行保护。

## 触发方式

- 在任务输入中加入 `@notify` 或 `#notify`，只关注本次任务。
- `/watch` 切换会话级关注。在 `feishuNotify` 中设置 `"watchDefault": true`
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
  "feishuNotify": {
    "watchDefault": false,
    "requireBackgroundIdle": true
  }
}
```

`requireBackgroundIdle: false` 表示不要求后台空闲，完成类通知在主会话停下时
立即发送（即使仍有 subagent/后台 bash 在跑）。

## 从独立包迁移

1. `pi uninstall @bluecake/pi-ask-user`，或从 pi packages 配置移除旧包。
2. 安装/升级 `pi-toolkit`（单一扩展入口）。
3. 原 `feishu-notify.json` 无需迁移；可手工把字段放进统一 `feishuNotify` 段。两者并存时按逐字段优先级解析；本包不会改动或删除旧文件。
4. 看到旧包冲突 warning 时，先移除旧包再执行 `/reload`。

独立 `pi-ask-user` 与合并版同时安装属于不支持的配置，因为同名工具、命令和事件
处理器可能重复注册并造成重复卡片。
