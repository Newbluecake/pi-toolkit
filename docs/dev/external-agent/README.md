# droid 外部 agent provider 使用说明

> 开发者要点（进程模型、权限、计费、可用性门禁）见文末「开发者要点（自 AGENTS.md 下沉）」一节。

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

## 可用性（2026-10-20 更新）

`droid` 未登录、凭据失效，或 Factory 付款/订阅、访问权限异常（例如 `No access token`、HTTP 401/402/403）时，端口将整个 droid provider 标记为不可用：

- available-models 提示词不再列出 droid 子块；stable 模式保留冻结的系统提示头，通过既有的尾部更新消息替换模型段（下一次用户轮生效）。
- 新 `Agent`（含嵌套）、workflow `agent()` 和既有 droid run 的 resume 都在准入快速拒绝，不创建 run 或 worktree。未登录/401 提示运行 `droid` 登录或检查凭据后 `/reload`；402 提示检查 Factory 账单与订阅计划；403 提示检查凭据、组织/模型访问权限与订阅计划。
- `/agent status` 显示 `droid: unavailable (<原因>)`；原因只保留固定分类，不带原始凭据。HUD 不变。
- 运行（run）、目录探测（catalog）、额度查询（quota）的失败按来源分别保留；任一来源仍有有效失败就保持不可用，显示最近一次失败的原因。quota 查询成功只清除 quota 失败，不能证明 CLI 的 OAuth 登录有效；成功的 droid turn 清除三类失败。
- catalog 探测成功只清除 catalog 自身的失败，不清除 run 或 quota 失败。探测只做 `initialize_session` + `availableModels`，没有验证首轮模型请求；实测存档 `samples/10-jsonrpc-full-flow.jsonl` 第 3 行已返回 62 个模型，第 9 行首轮却报 HTTP 402；现有离线 fixture 也允许初始化成功后首轮报 `No access token` / HTTP 402。因此目录返回不是有效登录或模型访问的证明。仅 init 成功不算 run 成功，普通额度耗尽（无鉴权错误）也不会使整个 provider 不可用。
- 各来源的鉴权失败仅在当前端口内存中保留，无持久化、无新计时器；各自从最近一次失败起 30 分钟后读时过期，全部清除后允许下一次 spawn 再试，失败会重新拦截。`/reload` 从头重新评估。
- 二进制缺失、provider 名冲突和 strict 协议漂移仍会隐藏 droid 并拒绝准入，不能被鉴权 TTL 或成功信号绕过。关闭 droid 的提示词行为不变。

此规则取代 `quota-plan.md` 2026-10-14 D3 的「401/402/403 只告警不拦 spawn」旧裁定。缺少 `FACTORY_API_KEY` 本身仍不作为不可用证据（CLI 可能已通过 OAuth 登录）；只有实际鉴权失败才触发。若更新的是环境变量中的 key，需从继承新 key 的 shell 重启 pi，单独 `/reload` 不会更新进程环境。

## 计费

子 agent 用量 × 底层模型的 pi 单价折算为美元。匹配规则：规范 provider 优先；Factory 自托管模型（glm/kimi/deepseek/minimax/mistral 等）按同名模型厂商 API 牌价**近似**计（显示 `approx`，**不是** Factory 实际成本——Factory 按 credits 计费）；匹配不到则 `unpriced`，可用 `externalAgents.droid.pricing["<id>"]` 覆盖（`"provider/id"`、`"unpriced"` 或四项 USD/1M 单价）。

已知缺口（v1）：HUD footer 的子 agent 成本、web-hub 卡片/汇总、回报给 pi 的会话总计、workflow 通知按数字合计，未定价部分按 0 计；展示 `unpriced` / `$x+?` 的位置以 `get_run_result` 与 fleet 为准。

## 额度显示与闸门

Factory 额度是 standard / core 两个池，窗口为 month（HUD 紧凑标记 `mo`）。

- `droid/<id>` 派发会查所属池。**core 池模型有回落计费**（2026-10-16 实测确认）：Core 池额度耗尽后自动计入 Standard 池额度继续跑，所以 core 模型只有 Core 与 Standard **两池都触线**才被拒；standard 池模型不能反向使用 Core 池额度，触线即拒。池无法判定时同样是两池都触线才拦。
- Core 池触线而 Standard 有余时，通知与逐池清单写「额度尽，回落 Standard 计费」并照常允许派发 Core 模型（不禁用、不劝改派）；两池都尽才写「已拦，勿派」。
- extra usage（超额付费）默认**拦截**；`quota.droidAllowExtraUsage=true` 才放行，余额会披露。
- 认证类错误（401/402/403）通过统一可用性端口隐藏 droid 模型并拒绝准入，恢复与 TTL 见上节；quota 的 HUD 行为保持不变。
- `quota.providers` 白名单含 `droid` 才查询（默认已含）。web 端需 hub 通告 cap `quota.pools.v1`。

## 探测空会话

目录探测会起一次 RPC `initialize_session`，droid 因此会在 `~/.factory/sessions/<探测目录 slug>/` 落一个空会话文件。频率至多每 `catalogTtlS` 一次，固定目录，属预期现象，可手动清理。

## 已知限制与风险

- ~~resume 后模型不记得前情~~ **已修复（#31）**：根因是 `droid.initialize_session(sessionId)` 只续会话文件、不恢复 LLM 历史；resume 现改走 `droid.load_session`，真正恢复上下文。副作用（fail closed）：droid 原生会话文件（`~/.factory/sessions/…`）被清理/换机器时 resume 直接报 `config`（`Session not found -32004`），不再静默失忆续跑。详见 `resume-memory.md`。
- resume 钉 transcript 头行记录的原 cwd；该目录（如已清理的 worktree）不存在则报 `config` 错误，不回落；外部 resume 不能与 isolation 同用。
- **R10 残余风险**：droid 以完整权限（autonomy high，权限请求自动批准）运行，并读取用户全局 skills / AGENTS.md / MCP 配置，子 agent 可调用你配置的 MCP 工具。建议在 droid 侧为 exec 场景收紧 MCP；破坏性任务用 worktree 隔离。
- 只读工具域（tidy）拒绝走 droid。
- D10 实测 turn 进行中关闭 stdin 不会让 droid 退出——已由 `sh` owner-watchdog 哨兵兜底，pi 被强杀后孤儿会被清理。
- 并发受 `concurrencyLimit` 与 sysload 闸门约束（droid 二进制约 290MB/进程）。

## conformance（真机协议一致性）

升级 pi 或 droid 之前手动跑（需真实 droid 与凭据，默认跳过）：

```sh
PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts
```

## 故障排查

| 现象                    | 处理                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| 401 / `No access token` | 检查 `FACTORY_API_KEY` 或运行 `droid` 重新登录后 `/reload`；环境 key 更新需重启 pi             |
| HTTP 402                | 检查 Factory 账单、订阅计划与所属组织，修复后 `/reload`                                        |
| HTTP 403                | 检查凭据、组织/模型访问权限及订阅计划，修复后 `/reload`                                        |
| `droid` 二进制找不到    | 确认 PATH，或设 `externalAgents.droid.binary` 为绝对路径；改后 `/reload`                       |
| 协议漂移（strict 拒绝） | 多为 droid 升级所致；跑 conformance 确认；临时可设 `protocolCheck: "warn"`；并按上文禁用自更新 |
| 额度被拒                | `/agent` 看池与 `mo`；必要时 `quota.droidAllowExtraUsage`                                      |
| 未知模型                | 看返回的候选；目录可能过期，等待重探或缩短 `catalogTtlS`                                       |

## 开发者要点（自 AGENTS.md 下沉）

`src/external-agent/` — external agent provider framework, currently one adapter: the virtual provider `droid/<model>`
(Factory's `droid` CLI; design `docs/dev/external-agent/{plan,arch}.md`, user guide `docs/dev/external-agent/README.md`).
Settings-gated: `externalAgents.droid.enabled` defaults false ⇒ no port/router/probe/disk write and a byte-identical
stack/prompt (the always-on checks use only structural evidence: `diag.external`, the `<agentDir>/external-agent/` path).
Ports are assembled in `src/stack.ts`; `RoutingSessionDriver` sends `droid/*` models to the droid adapter and everything
else to the pi driver. Process model: `droid exec --input-format stream-jsonrpc` child (`process.ts`/`jsonrpc.ts`),
wrapped by an `sh` owner-watchdog because D10 measured that closing stdin mid-turn does NOT make droid exit (idle EOF
does); `DROID_EXITS_ON_STDIN_EOF=false`, auto-update disabled via child env (strong guarantee is the user's
`~/.factory/update-policy.json`). Permissions: `autonomyLevel:"high"` with `autoRejectPermissionRequests:false` and a
synchronous `proceed_once` auto-approve (R10: droid also reads the user's global skills/AGENTS.md/MCP). `toolDomain:"readonly"`
is refused for droid (tidy can never use it — droid cannot be sandboxed read-only). Resume pins the
transcript's header-line cwd (missing ⇒ `config` error, never a fallback; external resume + isolation rejected).
Billing: droid usage × the underlying model's pi price (`pricing.ts`; family/consensus matches are `approx`; no match ⇒
`unpriced` "all"/"partial", never inferred from costUsd≈0). The model catalog is probed lazily (an empty session is
written under `~/.factory/sessions/<probe-cwd slug>/`). Quota: droid's two Factory pools gate spawn (see `src/quota/`).
Provider availability (2026-10-20): port-local auth evidence from runs/probes or quota HTTP 401/402/403 hides droid
from the available-models section (stable hub tail update) and fast-rejects new/nested/workflow spawns AND resumes;
`/agent status` exposes the most recent active reason. Failures are source-scoped (run/catalog/quota), each with
a 30min read-time TTL: quota success clears quota only; catalog success clears catalog only (metadata init can
succeed without usable login/model access); a successful droid turn clears all three. Any active failure blocks.
`/reload` re-evaluates, no persistence/timers. Missing binary/collision/strict drift remain blocked.
Protocol drift is guarded by a strict/warn check plus `tests/conformance/droid-protocol.test.ts` (real droid, opt-in
`PI_TOOLKIT_DROID_CONFORMANCE=1`; run it manually before any pi/droid upgrade).
