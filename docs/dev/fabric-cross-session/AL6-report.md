# AL6 终局报告（会话别名）

## 改动

| 文件                                                      | 说明                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                                               | `src/fabric/` 段频道/收信箱之后新增「Session aliases」段（设置键与默认值、cap、人才能设置/抢占、hub 单写者表与降级、寻址规则、冻结代价、off byte-identical、gates、残留）；web-hub 段增「Aliases in the web UI」                                       |
| `docs/dev/fabric-cross-session/alias-plan.md`             | §3.6 改为「`crossSession.alias` 键缺失 ⇒ 关闭且 hub 字节不变」并写明 degraded 的 `hub.json.alias`；§11 增 R11/R12/R13                                                                                                                                  |
| `docs/dev/fabric-cross-session/alias-acceptance.md`（新） | 真机清单：设置/改名/清除、非法字符、形近、按别名收发、@ 补全、频道可见性、离线保留、抢占（<10 分钟拒绝、TUI 确认、web 确认框与倒计时）、飞书拒绝、旧 hub、`alias.enabled=false`、混跑、文件损坏降级与 `/webhub status`                                 |
| `src/web-hub/protocol/xs-alias.ts`                        | 增 `XsAliasHubStatus`（`hub.json.alias` 形状，protocol 层，agent 侧可读）                                                                                                                                                                              |
| `src/web-hub/hub/hub-json.ts`                             | `HubRecord.alias?`                                                                                                                                                                                                                                     |
| `src/web-hub/hub/hub.ts`                                  | 在已有 degraded 日志点记录 `{reason,path}`，随首次 `write()` 落入 hub.json（仅 degraded 时写键；ready/关闭 ⇒ 键缺席，字节不变；与 privacy 同模式，无需 patch 方法）                                                                                    |
| `src/web-hub/agent/alias-status.ts`（新）                 | 纯函数渲染 `warning：alias store degraded (<reason>) · <路径>` + 修复提示（控制字符清洗）                                                                                                                                                              |
| `src/web-hub/agent/index.ts`、`src/commands/webhub.ts`    | 读取 hub.json 的 `alias`（结构校验，畸形 ⇒ 缺席）、`WebHubControl.alias?`（可选，旧测试替身不动）、`/webhub status` 输出                                                                                                                               |
| `tests/web-hub/agent/alias-status.test.ts`（新）          | 3 例：缺席无输出、degraded 两行、控制字符不能伪造行                                                                                                                                                                                                    |
| `tests/integration/fabric-xs-alias.test.ts`（新）         | 见下                                                                                                                                                                                                                                                   |
| `tests/integration/helpers/fabric-xs-process.ts`          | 夹具扩展（仅测试）：hub env `XW_HUB_ALIAS_JSON`、`StartHubDeps.now` 注入 + `skew` op、`webCmd` op（web 来源 command + 等 `cmd_late` 取捕获输出）、agent env `XW_ALIAS_JSON`/`XW_WEB_POLICY_JSON`/`XW_RUN_SLASH`；`getCommands` 增 `source:"extension"` |
| `tests/conformance/fabric-xs.test.ts`                     | `host({aliasTools})` 选项 + C-X11                                                                                                                                                                                                                      |

**10 分钟门槛**：hub 时钟经 `startHub(config, frontend, { now })`（`StartHubDeps.now`，既有注入点）在夹具里由 `skew` op 前移，生产代码无后门；agent 不受影响（别名在场/离线时间全由 hub 盖章）。

## C-X11（真实 pi + 本地 Anthropic stub）

`tests/conformance/fabric-xs.test.ts` → `C-X11`：用 alias 版工具实例（`alias:true`，仅描述后缀）+ 真 `XsReceiver`/`RootWakeController`，投递 hub 盖章 `from.alias="前端"` 的静默消息与唤醒消息：

- 所有请求的 `tools`/`system` 字节一致，且 `message_session`/`list_sessions` 描述带别名句；
- `alias` 仅以首行独立字段 ` alias=\"前端\"` 出现，位于 `from=…` 之后，`from=` 内不含别名；含「alias 由 hub 核验唯一，name 由对方自报」说明；
- token、`wakeToken`/`xsWake`、xid、发送方完整 sessionId 不进任何 provider payload。

## 集成场景（真实 hub 子进程 × 3 个真实 stack，串行启动）

`tests/integration/fabric-xs-alias.test.ts`：

1. **#1** 设置/查看/`@`归一化；`to:"前端"` 送达且结果不含完整 sessionId；来信头部独立 ` alias="后端"`；ref 仍可用；`@前端` 端到端；保留词/`_x`/占用/形近（abc0 vs abco）拒绝，假名与韩文通过。
2. **#2** 不共享频道 ⇒ `no_target`（不回落）；`--clear` ⇒ 冷却内他人被拒、本人可收回。
3. **#3** 抢占全链路：在线拒绝 → 离线 <10 分钟拒绝 → hub 时钟 +11 分钟 → 预览（`parseTakeConfirm` 往返）→ 外来 token 被拒 → 确认执行 → token 一次性 → 发送改投新持有者 → 旧持有者带原会话文件重启，只提示一次（`lost: taken`）。
4. **#4** 文件损坏：重启两次仍 degraded、文件字节不变、无旁生文件；`hub.json.alias{degraded,path}`；`/webhub status` 渲染降级行；agent 无 cap ⇒ `/fabric alias` 本地拒绝、`alias n/a (hub-cap off)`；别名形状的名字（恰为在线会话显示名）发送不到达同名会话；人移走文件 → 重启 → ready 空表、旧别名消失、可新设、hub.json 干净。
5. **#5** web 来源 × `webCommandPolicy.fabric=confirm`：无 confirm ⇒ `E_CONFIRM_REQUIRED`；预览（confirm）的捕获输出末行可被 `parseTakeConfirm` 解析；执行是新 cmdId 且需自己的 confirm；成功后持有别名。
6. **#6** 混跑：`alias.enabled=false` 的旧 agent 行不含 alias、`/fabric alias` 本地拒绝、头部无 ` alias=`，双向 ref 收发正常。

未单独覆盖（已由其他包测试）：fork 不继承别名（AL3/membership 逻辑）、hub 重启后别名保留（AL2 `hub-xs-alias`）、飞书硬拒（AL4）。

## 门禁（均在 /home/bluecake/ai/pi-toolkit，长命令用 setsid+timeout 后台跑日志）

```
$ npm run format:check   → All matched files use Prettier code style!
$ npm run typecheck      → tsc ×2 + vue-tsc 无输出，通过
$ npm run build          → tsc -p tsconfig.build.json 通过
$ npm run build:web      → vite build 通过
$ npm run check:web      → scripts/web-hub/check-ui-dist.ts 通过
$ npm test (最终一次)
 Test Files  1368 passed (1368)
      Tests  25955 passed | 22 skipped (25977)
   Duration  369.71s
$ npm run test:conformance
 Test Files  24 passed (24)
      Tests  261 passed | 17 skipped (278)
   Duration  119.39s
EXIT 0
```

## 修复的回归 / 门禁过程记录

1. 第一次全量：`tests/integration/fabric-xs.test.ts › web /new exec claim …` 失败。原因是本包夹具里让 `sendUserMessage("/cmd")` 真实执行 handler，`/new` 的 trampoline 也被跑了，claim 被释放。修复：该行为改为 opt-in（`XW_RUN_SLASH=1`，仅 #5 的 web 会话使用）。
2. 第二次全量：`tests/integration/web-hub-headless.test.ts › H3 …` 失败一次（`pidAlive(child2)`，L5 断言），单跑该文件 36/36 通过，第三次全量通过，判为全套件负载下的既有 flaky（与别名无关，未改代码）。
3. 未改动三份 off golden 与 `tests/fixtures/legacy-xs-v071/`；未 commit。

## 遗留

- 夹具里 `sendUserMessage` 跑 slash handler 是对 pi 行为的模拟（真实 pi 在 idle 路径同样在调用栈内执行），web 捕获路径的真实 pi 验证仍归真机清单 §4。
- `web-hub-headless` H3 的 flaky 建议另行跟踪。
