# droid 外部 agent provider 使用说明

pi-toolkit 可以把 [Factory droid](https://factory.ai) 当作虚拟 provider `droid/<model>`，像普通模型一样通过 `Agent({ model: "droid/<id>" })` 派发子 agent。
默认关闭；关闭时 pi-toolkit 的行为与提示词字节不变。设计见 `plan.md` / `arch.md`，额度见 `quota-plan.md`。

## 启用步骤

1. 安装 droid CLI，确认 `droid --version` 可用。
2. 登录或设置 `FACTORY_API_KEY`（环境变量，pi 进程要能继承到）。
3. 在 `~/.pi/agent/pi-subagent.json` 加入：

   ```json
   {
     "externalAgents": {
       "droid": { "enabled": true, "binary": "droid", "advertiseMax": 12 }
     }
   }
   ```

   其余键：`protocolCheck`（`strict` 默认 / `warn`）、`models`（提示词展示的模型 id，`[]` = 自动；**非空时同时是新 spawn 的白名单**——名单外的 `droid/<id>` 会在准入被拒并列出允许的 id，resume 不受限）、`injectMemory`、`pricing`、`catalogTtlS`、`requestTimeoutS`、`initTimeoutS`、`killGraceS`。启用/二进制/协议检查为非 live，需 `/reload`。

4. **强烈建议**关闭 droid 自更新（自更新会导致协议漂移）：

   ```sh
   echo '{"disableAutoUpdate":true}' > ~/.factory/update-policy.json
   ```

   pi-toolkit 对子进程也注入了禁用更新的环境变量，但那只是尽力而为；这个文件才是强保证。

## 模型选择

模型目录来自 droid 自身（`availableModels`），缓存在 `<agentDir>/cache/external-agent/`，超过 `catalogTtlS`（默认 24h）或 droid 二进制变化后台重探。提示词最多展示 `advertiseMax` 个（0..50，默认 12）；用 `models` 固定展示列表。传入未知模型 id 会被拒绝并给出候选，不会静默改成默认模型。非空 `models` 同时是白名单：quota 推荐/逐池清单只列名单内模型（名单外目录模型不再出现，「等 N 个」只计名单内）；新 spawn 名单外 id 会在准入被拒（目录不可用也照样执行），resume 继承的模型不受限；名单内但目录查不到的 id 若 `quota.droidPools` 能改判其池则仍可进推荐，否则跳过。

## 计费

子 agent 用量 × 底层模型的 pi 单价折算为美元。匹配规则：规范 provider 优先；Factory 自托管模型（glm/kimi/deepseek/minimax/mistral 等）按同名模型厂商 API 牌价**近似**计（显示 `approx`，**不是** Factory 实际成本——Factory 按 credits 计费）；匹配不到则 `unpriced`，可用 `externalAgents.droid.pricing["<id>"]` 覆盖（`"provider/id"`、`"unpriced"` 或四项 USD/1M 单价）。

已知缺口（v1）：HUD footer 的子 agent 成本、web-hub 卡片/汇总、回报给 pi 的会话总计、workflow 通知按数字合计，未定价部分按 0 计；展示 `unpriced` / `$x+?` 的位置以 `get_subagent_result` 与 fleet 为准。

## 额度显示与闸门

Factory 额度是 standard / core 两个池，窗口为 month（HUD 紧凑标记 `mo`）。

- `droid/<id>` 派发会查所属池：触线则拒绝；池无法判定时两池都触线才拦。
- extra usage（超额付费）默认**拦截**；`quota.droidAllowExtraUsage=true` 才放行，余额会披露。
- 认证类错误（401/402/403）**只告警不拦截**，HUD 显示 `droid auth <code>`。
- `quota.providers` 白名单含 `droid` 才查询（默认已含）。web 端需 hub 通告 cap `quota.pools.v1`。

## 探测空会话

目录探测会起一次 RPC `initialize_session`，droid 因此会在 `~/.factory/sessions/<探测目录 slug>/` 落一个空会话文件。频率至多每 `catalogTtlS` 一次，固定目录，属预期现象，可手动清理。

## 已知限制与风险

- ~~resume 后模型不记得前情~~ **已修复（#31）**：根因是 `droid.initialize_session(sessionId)` 只续会话文件、不恢复 LLM 历史；resume 现改走 `droid.load_session`，真正恢复上下文。副作用（fail closed）：droid 原生会话文件（`~/.factory/sessions/…`）被清理/换机器时 resume 直接报 `config`（`Session not found -32004`），不再静默失忆续跑。详见 `resume-memory.md`。
- resume 钉 transcript 头行记录的原 cwd；该目录（如已清理的 worktree）不存在则报 `config` 错误，不回落；外部 resume 不能与 isolation 同用。
- **R10 残余风险**：droid 以完整权限（autonomy high，权限请求自动批准）运行，并读取用户全局 skills / AGENTS.md / MCP 配置，子 agent 可调用你配置的 MCP 工具。建议在 droid 侧为 exec 场景收紧 MCP；破坏性任务用 worktree 隔离。
- 只读工具域（consult 专家、tidy）拒绝走 droid。
- D10 实测 turn 进行中关闭 stdin 不会让 droid 退出——已由 `sh` owner-watchdog 哨兵兜底，pi 被强杀后孤儿会被清理。
- 并发受 `concurrencyLimit` 与 sysload 闸门约束（droid 二进制约 290MB/进程）。

## conformance（真机协议一致性）

升级 pi 或 droid 之前手动跑（需真实 droid 与凭据，默认跳过）：

```sh
PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts
```

## 故障排查

| 现象                            | 处理                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| 402 / 401 / `droid auth <code>` | 检查 `FACTORY_API_KEY` 或重新登录；仅告警，不拦派发；402 多为额度/账单问题                     |
| `droid` 二进制找不到            | 确认 PATH，或设 `externalAgents.droid.binary` 为绝对路径；改后 `/reload`                       |
| 协议漂移（strict 拒绝）         | 多为 droid 升级所致；跑 conformance 确认；临时可设 `protocolCheck: "warn"`；并按上文禁用自更新 |
| 额度被拒                        | `/agent` 看池与 `mo`；必要时 `quota.droidAllowExtraUsage`                                      |
| 未知模型                        | 看返回的候选；目录可能过期，等待重探或缩短 `catalogTtlS`                                       |
