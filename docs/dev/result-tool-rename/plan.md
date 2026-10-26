# `get_subagent_result` 改名方案（r2）

> 状态：方案稿 r2（按 gpt-6.1-sol 的 r1 评审修订），**未施工**。拍板后才动 src/tests。
> 坐标：r1 基于 `5f3ed9d2`（v0.9.0）；r2 复核时 `dev` 已到 `a4151048`。工作区里有别的会话未提交的 #62 改动（`src/schedule/**`、`src/tools/schedule-tool.ts`、`src/web-hub/hub/{feishu,schedule}/**`、`docs/dev/scheduled-reports/README.md`，以及新文件 `src/schedule/agent/result-reference.ts`），本稿的引用面已经把它们算进去。
> 范围：只改模型工具 `get_subagent_result` 的名字和措辞，外加改名必需的兼容迁移。参数 schema（`run_id`/`wait`/`wait_ms`）、返回结构、执行语义一律不变。

---

## r2 评审处置表

| #   | 级别    | 评审意见（摘要）                                                                                              | 处置                       | 理由与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | blocker | 漏了 pi 1.3 的历史 active-tool 恢复，resume、`/tree` 和 `/reload` 不能等同处理                                | **采纳**，新增 §3.1、§7.1⑤ | 已核实（`pi-coding-agent/dist/core/agent-session.js`）：<br>① 构造时（resume、fork、`/resume` 切会话都会构造新 `AgentSession`）先 `_buildRuntime({includeAllExtensionTools:true})`，再在 `_usesDefaultTools` 时调 `_restoreToolsFromTranscript`（`:210-215`）。后者把 active 集**覆盖**成 transcript 当前声明的 `toolsAdded` 名单，未注册的名字留在 `_pendingToolNames`（`:1374-1382`）。<br>② `navigateTree` 在发 `session_tree` **之前**无条件 `_restoreToolsFromTranscript()`（`:3374-3378`）。<br>③ `reload()` 用当前 active 集加 `includeAllExtensionTools:true` 重建，新注册的工具会被激活（`:2972-2992`）。<br>pi CHANGELOG 1.3.0 写明 "Resume now restores the session's active tools"，1.0–1.2 没有这个行为。<br>结论：pi 1.3 下 resume、fork 一个旧会话，或 `/tree` 回到改名前的节点时，`get_run_result` 已注册但**不 active**，模型手里没有任何结果工具。`/reload` 不受影响。迁移办法：在**已有**的 post-guard `session_start` 和 `session_tree` 处理器里调用 `ensureResultToolActive`；判定条件是「transcript 声明过旧名、新名已注册但未激活」，满足就**只追加**新名（不删任何工具，也不碰 pending）。实现和测试见 §7.1⑤、§7.3 |
| 2   | blocker | golden 断言先 parse 再 stringify，证明不了逐字节；`diff --stat` 也没有自动断言                                | **采纳**，§6.3 重写        | 改成字节级断言：用 `git show` 取原文件 Buffer，只允许「旧名 → 新名」的子串替换（次数精确断言），xs golden 额外允许在唯一锚点追加一行，结果和新文件 `Buffer.equals`。同时自动断言 `git diff --name-only $BASE -- tests/fixtures` 恰好是 3 个文件，且 fixtures 下没有未跟踪文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | blocker | P1 的残留门禁扫 skills 和 README，可这些文件 P3 才改，P1 的 `npm test` 过不了                                 | **采纳**，§9 和 §7.3 调整  | 门禁分两段引入：P1 只扫 `src/**`（排除 `src/web-hub/ui/**`，P2 管）和 `tests/**`；P3 合入时把扫描范围扩到 `package.json`、`README*.md`、`AGENTS.md`、`docs/guide/**`、`docs/dev/*/README.md`、`skills/**`。每包都能各自变绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | major   | 漏了 README.md/README.en.md、package.json，以及 #62 新增的 scheduled-reports README 和 `SCHEDULE_RESULT_TOOL` | **部分采纳**               | README.md/README.en.md 在 r1 §2.2（`README.md:5,62`、`README.en.md:5,62`）和 r1 P3 文件域里已经有了，这一子项**驳回**。其余**采纳**：全仓重新 rg（含未提交改动）后补上 `package.json:4`（description）、`docs/guide/subagents.md:13,45`、`docs/guide/migration.md`（迁移说明的落点）、`docs/dev/scheduled-reports/README.md:9`（#62 新写）、`src/schedule/agent/result-reference.ts:7`（`SCHEDULE_RESULT_TOOL`），以及 #62 的 `tests/schedule/agent/{note,report-file}.test.ts`。见 §2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | major   | 客户端原样序列化证明不了服务端不会 400；不能写成无条件兼容；要求真机 smoke 记录请求组合并写退路               | **采纳**，§3.2、§7.4       | 结论降级为「客户端无阻断；服务端待真机证据」。smoke 用 traffic 录制（`src/traffic`，临时开启）记下每家的**实际** `tools` 名单和历史调用名，覆盖 Anthropic Messages（`cr-anthropic`/`copilot-anthropic` 中转）、OpenAI Responses（`cr-response`/`copilot-response`）、OpenAI Completions 中转（`cr-kimi`/`cr-glm`）。退路写清楚了，并且**纠正了 r1 的一个隐含错误**：B2 的隐藏别名同样会从请求里剥掉声明，**解决不了**「历史名必须声明」这类 400。可用的退路只有 F1（按需激活的可见旧名桩）和 F2（发请求前把历史调用改名），见 §3.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6   | major   | 现有 schedule/fabric-xs conformance 没跑完整 activate，也没覆盖改名                                           | **采纳**，§7.3             | 核实：`tests/conformance/**` 零处 import `src/index.ts`；那些 golden 是 `tests/integration/**` 里的桩 pi。新增 `tests/conformance/result-tool-rename.test.ts`：用真实 `createAgentSession`/`createAgentSessionRuntime`，`extensionFactories` 里放真实的 toolkit `activate`，覆盖 R1–R8（resume、fork、`/tree` 的迁移，`/reload` 不需要迁移，尊重用户主动停用，旧名 not found 的钩子边界，历史 renderer 接线，pi 恢复行为前提钉）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | minor   | stable 模式不保证发出含新名的完整尾部更新（3 次 / 32 KiB 后只发 pointer，已经 POINTED 就不再发）              | **采纳**，§3.4             | 核实 `src/prompt-sections/stable-section.ts:48-61`：`announced === POINTED` 时直接返回，超过上限时只发 `{kind:"pointer"}`；`update-message.ts:29-34` 的 pointer 文案只说「该段可能已过期」，不含新内容。补了兼容说明：工具列表和新描述里的过渡半句（D6）才是权威来源；smoke 预期按三种状态分别写                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | minor   | 还有按工具名匹配的配置，比如飞书 `waitNotifyTools` 配了旧名会静默失配                                         | **采纳**，§3.6             | 全仓核查以后列出所有按名匹配的点：`waitNotifyTools`（读取时把旧名映射成新名）；agent frontmatter `tools`/`excludeTools`（结果工具从不授予子会话，不需要处理）；pi 自己的 `--tools`/`--exclude-tools`/`defaultTools`（pi 拥有，我们改不了，写进迁移指南）；HUD `toolCounts`（只是展示）；web UI 集合（P2）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | minor   | D5 依据不对：`extend_subagent_timeout` 也能管 `wf_`，`list_subagents` 也列工作流                              | **采纳**，D5 重写          | 核实：`extend-timeout-tool.ts:29-30,158` 支持 workflow 延长，`list-subagents-tool.ts:323` 列出 `wf_`，`abort-tool.ts:14` 能终止 workflow；只有 `steer-tool.ts` 和 `set_model` 只作用于 run。D5 改成「整个 subagent 工具族命名是否统一」，并给出推荐                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 10  | minor   | 「不增加 prompt 成本」和新增的过渡描述自相矛盾；cache 分析漏了 forced-system-prompt 投影                      | **采纳**，§0、§4、§7.5     | 成本改成实数：新文案每请求约 +40 token，其中过渡半句约 10 token。cache 方面核实：主会话 sysprompt hub 只要有段落（agent-types 段在主会话总是存在）就会返回 `{systemPrompt}`（`src/sysprompt/hub.ts:349-372`），pi 因此设置 `forceSystemPrompt`（`extensions/runner.js:1147`）；`_installAgentForcedPromptProjection`（`agent-session.js:1352-1366`）把所有 system 消息折叠成一个头部，头部带当前工具集，所以工具增量**不会**留在尾部。删掉 r1 里「可能保住前缀」的说法，改成「工具集变化后的第一个请求整段 miss 一次」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 0. 结论

| 项           | 推荐                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 方案         | **A′：硬切 + 迁移 + 被动兼容**。只注册新名 `get_run_result`，不注册可调用的旧名。<br>**迁移**（r2 新增，必需）：在已有的 `session_start`/`session_tree` 处理器里调用 `ensureResultToolActive`，处理 pi 1.3 从 transcript 恢复激活集的情况。<br>**被动兼容**：① `RESERVED_TOOL_NAMES` 保留旧名并追加新名；② TUI 用 `registerToolRenderer` 继续渲染历史里的旧名卡片；③ web UI 的按名分支同时认新旧两个名字；④ 飞书 `waitNotifyTools` 读取时把旧名映射成新名；⑤ 新描述带半句 `(Formerly named get_subagent_result.)`（D6） |
| 新名         | **`get_run_result`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| prompt 成本  | 每请求约 +40 token（新描述多说了 `/task`、定时任务和 `r_`/`wf_`；⑤ 约占 10 token）。不做双注册                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 冻结 golden  | **G1：一次性授权、字节级可证明的机械更新**，3 份 A 级 golden（§6）。**需用户裁定**                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 版本         | 算 BREAKING（`refactor(tools)!:` 加 `BREAKING CHANGE:` 脚注），按规则下一版是 v1.0.0（走 master PR）。**需用户裁定**                                                                                                                                                                                                                                                                                                                                                                                                    |
| 历史会话     | 客户端侧无阻断（§3.2）。服务端是否接受「历史调用名不在当前 tools 里」**要等真机 smoke 才能定**；失败时走 F1 或 F2                                                                                                                                                                                                                                                                                                                                                                                                       |
| prompt cache | 本项目主会话处在 forced-prompt 投影下，所以工具集变化后的第一个请求**整段 miss 一次**（每个会话一次）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 拆包         | P1（src + tests + golden + conformance，同一提交，残留门禁只扫 src/tests）→ P2（web UI，可与 P1 并行）→ P3（文档、skills、package.json，并把门禁扩到这些文件）。P1 的前置条件：#62 已提交、工作区干净                                                                                                                                                                                                                                                                                                                   |

### 需用户拍板的决策点

| #   | 决策                                                     | 选项（推荐项在前）                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 兼容策略                                                 | **A′（推荐）** / B2：再加一个隐藏的可调用旧名别名（`prepareLoadout.hiddenDeclarations`）。B2 能让模型照旧名调用也成功、不算 breaking，但**照样需要迁移**（§3.1），也**解决不了**服务端 400（§3.2），多一套机制 / B1 双名可见（拒绝） |
| D2  | 新名                                                     | **`get_run_result`（推荐）** / `check_run` / `get_result` / `run_result`                                                                                                                                                             |
| D3  | A 级冻结 golden 一次性更新授权                           | **G1 字节级机械替换 + 断言脚本（推荐）** / G2 比较时做名称映射（不推荐）/ 不授权（那就只能不改名）                                                                                                                                   |
| D4  | 版本口径                                                 | **标 BREAKING，按规则下一版 v1.0.0，在 dev 上攒着、不为这一项单独发版（推荐）** / 标 BREAKING 但发 0.10.0（无视脚本 WARN，和规则冲突）/ 选 D1=B2，不算 breaking，按 patch 发                                                         |
| D5  | subagent 工具族命名                                      | **只改结果工具，族内其余名字不动（推荐）** / 趁 1.0 一起改成 run 词汇：`abort_run`、`extend_run_timeout`、`list_runs`（这三个都管 `wf_`），`steer_subagent`/`set_model` 只作用于 run 所以保留。理由见 §5.2                           |
| D6  | 描述里加过渡半句 `(Formerly named get_subagent_result.)` | **加，下一个 minor/major 删（推荐）**：约 10 token/请求，是 stable 模式 POINTED 会话里唯一能把旧名映射到新名的模型可见线索 / 不加                                                                                                    |
| D7  | 和 #62 的先后                                            | **#62 先提交，P1 再把 `SCHEDULE_RESULT_TOOL` 并到 `RESULT_TOOL_NAME`（推荐）** / 改名先合，#62 rebase                                                                                                                                |
| D8  | 真机 smoke 若有服务端 400 时的退路                       | **F2：发请求前把历史调用改名（只改投影、不落盘；参数 schema 相同，改名无损）（推荐，前提是 smoke 证明签名和 reasoning 不受影响）** / F1：可见的旧名桩，只在 transcript 含旧名调用的会话里激活 / 回退改名。只有 smoke 失败才需要拍    |

---

## 1. 背景与目标

- 这个工具读三类目标：
  - `Agent`、`/task`、嵌套 Agent 启动的 subagent run（`r_…`）；
  - `SubagentWorkflow` 的后台 workflow（`wf_…`，`src/tools/workflow-target.ts` 的 `resolveToolTarget` 负责分派）；
  - 定时任务的后台 run（`r_…`，#62 之后的 `src/schedule/agent/note.ts` 会输出 `${SCHEDULE_RESULT_TOOL} ${run.runId}`）。

  名字里的 `subagent` 已经不准确。

- 目标：换成能覆盖「任何后台 run」的通用名，模型可理解度不下降，同时守住 I1（零卡死）、I9（off 时逐字节不变）、I10（wire 只增不改）和冻结物规则。
- 约束：
  - 工具名是对外接口（`AGENTS.md` 说本项目是 `@tintinweb/pi-subagents` 的 drop-in 替代）。
  - 3 份 A 级 golden 含这个名字。
  - pi peer 是 `>=1.0.0 <1.4.0`，新用到的 pi API 一律做能力探测。

## 2. 引用面（全仓重扫，含未提交改动）

命令：`rg -n get_subagent_result --glob '!node_modules' --glob '!dist' .`，另加 `rg -n SCHEDULE_RESULT_TOOL`。

### 2.1 有行为意义的引用（必须改）

| 类别                   | 坐标                                                                                                                                                                                                                                                                                                    | 说明                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具注册本体           | `src/tools/result-tool.ts:276` `name`、`:277` `label`、`:279-292` description、`:293-294` promptSnippet、`:305` renderCall 标题、`:62-66` `run_id` 描述、`:155` `extensionOwner`                                                                                                                        | 注册点是 `src/index.ts:981`，post-guard（`:316` 的 HOST_KEY 早退之后），只在主会话注册；子会话从来没有这个工具（`src/service/runtime-adapter.ts` 的 `grantedReserved` 不含它）。`extensionOwner` 只是 `Notifier.ack` 的 `by` 入参（`src/delivery/notifier.ts:280`），不持久化 |
| 保留名                 | `src/runtime/tool-scope.ts:21-62` `RESERVED_TOOL_NAMES[1]`                                                                                                                                                                                                                                              | 被 `fabric-xs-off-golden.json` 的 `reservedToolNames` 冻结                                                                                                                                                                                                                    |
| 模型可见的指引         | `src/tools/agent-tool.ts:264,346-347,359,502`；`src/config/agent-types.ts:225,227,228`                                                                                                                                                                                                                  | `:264`、`:359` 被嵌套 golden 冻结；agent-types 那三行被 `schedule-off-golden` 的 systemPrompt 冻结                                                                                                                                                                            |
| 其他工具的提示文案     | `src/tools/workflow-tool.ts:286,425,527,554,631`、`src/tools/abort-tool.ts:42,113`、`src/tools/extend-timeout-tool.ts:69,93-158`、`src/tools/list-subagents-tool.ts:323`、`src/tools/poll-guard.ts:49`                                                                                                  |                                                                                                                                                                                                                                                                               |
| 通知文本               | `src/delivery/format.ts:78,87`                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                                                                               |
| 命令文案               | `src/commands/task.ts:94,143`                                                                                                                                                                                                                                                                           |                                                                                                                                                                                                                                                                               |
| 定时任务（#62 未提交） | `src/schedule/agent/result-reference.ts:7` `SCHEDULE_RESULT_TOOL = "get_subagent_result"`（注释："Centralized for the forthcoming result-tool rename"）→ 被 `note.ts:21,131`、`report-file.ts:4,61` 引用；测试 `tests/schedule/agent/note.test.ts:72`、`tests/schedule/agent/report-file.test.ts:58-59` | 见 §8                                                                                                                                                                                                                                                                         |
| 按工具名匹配的配置     | `src/feishu-notify/core.ts:20,67`（`waitNotifyTools`）、`src/feishu-notify/index.ts:544-545`                                                                                                                                                                                                            | 见 §3.6                                                                                                                                                                                                                                                                       |
| web UI 按名分支        | `src/web-hub/ui/src/logic/tools.js:53-59` `RUN_REF_TOOLS`、`src/web-hub/ui/src/components/transcript/ToolCard.vue:53` `MD_RESULT_TOOLS`                                                                                                                                                                 | 新旧两个名字都要认（历史 transcript 里还是旧名）                                                                                                                                                                                                                              |

### 2.2 文档、说明、注释

- **用户可见文档（P3）**：
  - `package.json:4`（npm description）；
  - `README.md:5,62`、`README.en.md:5,62`；
  - `AGENTS.md:11,15`；
  - `docs/guide/subagents.md:13,45`；
  - `docs/guide/migration.md`（目前没有旧名，在这里**新增**迁移说明）。
- **子系统 README（P3）**：`docs/dev/{web-hub,subagent-core,fabric-cross-session,external-agent,context-switch}/README.md` 各 1 处，`docs/dev/scheduled-reports/README.md:9`（#62 新写）。
- **skills（P3）**：`skills/dev-flow/SKILL.md:210,231`、`skills/dev-flow/references/subagent-workflow.md:62`。
- **src 注释（P1，机械替换）**：
  - `service/{run-registry,spawn-service}.ts`、`delivery/usage-broadcast.ts`、`workflow/background.ts`、`stack.ts:1089`；
  - `runtime/{runner,session-driver}.ts`、`core/{state-machine,types}.ts`；
  - `tools/{result-text,run-ref,steer-tool,workflow-target}.ts`；
  - `hud/footer.ts`、`commands/status.ts`、`adapters/workflow-notice.ts`、`ui/capped-body.ts`、`archive/control.ts`、`context-switch/child.ts`、`web-hub/agent/status.ts`、`index.ts:956,2056`。
- **不改（历史资产，写进精确允许列表）**：
  - `CHANGELOG.md`（脚本生成，禁止手改）；
  - `docs/dev/**` 里除 README 以外的 plan、report、arch 等（约 45 个文件，包括 #62 的 `docs/dev/scheduled-reports/report-paths-report.md`）；
  - `docs/research/**`；
  - `docs/dev/topic-switch/judge-eval/*.jsonl`（评测语料）；
  - `scripts/exp/exp5-run.sh`（实验 prompt）；
  - `tests/fixtures/preview-perf/stack-3609.ts.txt`（预览性能语料）；
  - 用户记忆里的旧名（历史数据）。
- **已确认不按名字分支**：
  - HUD 成本只读 `toolResult.usage`；
  - `src/web-hub/{hub,protocol}` 零命中，所以没有 wire 变更；
  - `tests/conformance/**` 零命中；
  - `src/traffic` 不按 toolName 分支。
- **既有问题（本次不修，另记 todo）**：冻结的嵌套 Agent 描述让子会话去用 `get_subagent_result`，但子会话里根本没有这个工具。

## 3. 兼容性分析

### 3.1 pi 1.3 的激活集恢复（r2 新增，blocker #1）

| 场景                                                 | pi 行为（`pi-coding-agent/dist/core/agent-session.js`）                                                                                                                                                                                                            | 改名后的结果（不做迁移时）                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 新会话                                               | 构造时 `includeAllExtensionTools:true`，transcript 为空所以不恢复                                                                                                                                                                                                  | 正常                                                                               |
| resume、fork、`/resume` 切会话（都会构造新 session） | `:210-215`：先激活所有扩展工具，再在 `_usesDefaultTools` 时 `_restoreToolsFromTranscript`（`:1374-1382`），把 active 集覆盖成 transcript 当前声明的名单，未注册的名字放进 `_pendingToolNames`。`_usesDefaultTools` 在 `--tools` 不给具体名字时为真（`sdk.js:314`） | **`get_run_result` 已注册但不 active**，旧名永远停在 pending。模型没有结果工具可用 |
| `/tree` 跳到改名前的节点                             | `:3374-3378`：先 `_restoreToolsFromTranscript()`（无条件），再 emit `session_tree`                                                                                                                                                                                 | 同上                                                                               |
| `/reload`                                            | `:2972-2992`：当前 active 集加 `includeAllExtensionTools:true`，新注册工具被激活                                                                                                                                                                                   | 正常                                                                               |
| pi 1.0–1.2                                           | resume 不恢复激活集（CHANGELOG 1.3.0 "Resume now restores the session's active tools"，#10785）                                                                                                                                                                    | 正常（`/tree` 的情况看各版本，迁移逻辑对所有版本都生效）                           |

**迁移设计**：

```ts
// src/tools/result-tool-activation.ts（pi-facing，零模块级状态）
/** 纯函数：transcript 当前声明的工具里有旧名、新名已注册但不 active ⇒ 返回追加后的激活集，否则 undefined。 */
export function planResultToolActivation(input: {
  declared: readonly string[]; // transcript 当前声明的工具名（getCurrentTools 的结果）
  active: readonly string[]; // pi.getActiveTools()
  registered: readonly string[]; // pi.getAllTools().map(t => t.name)
}): string[] | undefined;

/** pi 接线：能力探测不全时返回 noop（桩 pi、旧 pi）。 */
export function createResultToolActivation(pi: ExtensionAPI): (ctx: ExtensionContext) => void;
```

- `declared` 的来源：`ctx.sessionManager.buildSessionProjection().messages` 交给 pi-ai 的 `getCurrentTools`。用 `src/sysprompt/compat.ts` 的 `getTranscriptHelpers` 同样的方式探测，补一个 `getCurrentTools` 探测。
- 需要的能力：`pi.getActiveTools`、`pi.setActiveTools`、`pi.getAllTools`，`ctx.sessionManager.buildSessionProjection`，pi-ai 的 `getCurrentTools`。缺任何一个就不做事。pi 1.0–1.2 本来也不需要迁移。
- 动作：`pi.setActiveTools([...active, RESULT_TOOL_NAME])`。**只追加**：`setActiveToolsByName` 在只加不减时保留 pending（`:1104-1111`），所以不会误伤正在等 MCP 重连的工具。
- 尊重用户的选择：transcript 里没有旧名的会话（比如改名以后用户自己停用了 `get_run_result`）不动。
- **挂载点（I2 只做装配）**：不新注册处理器，在已有的 post-guard 处理器里加一次调用。这样 `schedule-off-golden` 的 `handlerCounts`（`session_start: 8`、`session_tree: 3`）保持不变，golden diff 仍然是纯名字替换：
  - `src/index.ts:1439` 的主 `session_start`，放在函数体最前面，同步执行、try/catch 吞错；
  - `src/index.ts:437` 的 `session_tree`（`restoreArchive`），改成 `(e, ctx) => { restoreArchive(ctx); activateResultTool(ctx); }`。

  pi 是先恢复再 emit，所以这两个钩子一定看到的是恢复后的激活集。

- 子会话不受影响：子会话里没有结果工具，「新名已注册」不成立。
- 备选挂载：单独注册两个处理器。代价是 schedule golden 的 `handlerCounts` 要 +1/+1，断言脚本得放开这两个字节。不推荐。
- 扩展点（不预先实现）：「pi 1.3 resume 时，新版本新增的工具不 active」是个**更一般的潜在问题**，toolkit 以后新增的任何工具都会碰到。`planResultToolActivation` 的签名可以以后泛化成 `renames: Record<legacy, next>`，本次只处理结果工具。

### 3.2 历史里的旧名调用与 provider（major #5）

- **客户端侧（已核实，无阻断）**：pi-ai 在重放时把历史 `toolCall` 的名字原样送出，不和当前 tools 比对：
  - Anthropic：`api/anthropic-messages.js:1171-1177`（OAuth 时只做 CC 规范名映射）；
  - OpenAI Responses：`api/openai-responses-shared.js:238-242`；
  - OpenAI Completions：`api/openai-completions.js:600-611`（只在完全没有 tools 时补 `tools: []`）；
  - Google：`api/google-shared.js:232`。

  pi 自己的 transcript 模型就有 `toolsRemoved`（`utils/transcript.js` 的 `getCurrentTools`）。pi 1.0.1 的 `registerToolRenderer` 明说是给 "MCP tools in resumed sessions" 用的。项目先例：v0.9.0 删掉了 `consult` 工具；`tool-scope.ts` 每轮用 `setActiveTools` 剥工具。

- **服务端侧（未证实）**：上面这些只能说明「pi 不拦」，**不能**说明 Anthropic、OpenAI 和中转在「历史调用名不在当前 tools 里」时一定不报 400。结论要以真机 smoke（§7.4）为准。
- **退路（D8，只在 smoke 失败时启用）**：
  - **F2 请求前改名（推荐）**：在已有的 `context` 处理器链上（不新增处理器）把出站 messages 里历史 `toolCall.name === "get_subagent_result"` 改成新名，同时改配对 toolResult 的 `toolName`。只改投影，不落盘。参数 schema 完全相同，所以改名无损。附带好处：历史里不再出现旧名，模型被旧名诱导的来源少一个。风险：Anthropic 带签名的 thinking 和 OpenAI Responses 的加密 reasoning 是否允许同一 assistant 回合里的 tool_use 名被改，要由 smoke 证明；改名会让历史字节变化，触发一次 cache miss，和 §7.5 的那一次合并。
  - **F1 按需可见的旧名桩**：注册一个旧名工具，最小描述 `Renamed to get_run_result.`，空参数，执行只返回错误提示。只在 transcript 含旧名调用的会话里激活（复用 §3.1 的判定），每请求约 +15 token。旧名这时是可调用的（只返回提示）。
  - **不可行的退路**：B2 隐藏别名。`hiddenDeclarations` 由 `_installHiddenDeclarationsProjection`（`agent-session.js:1324-1350`）**从请求里剥掉声明**，所以服务端照样看不到旧名的声明，修不了这类 400。

### 3.3 模型照旧名调用

- **诱导来源**：同一会话里的历史调用、旧通知文本、旧定时任务消息（`display: true` 的 custom 消息，不可改写）、stable 模式下冻结的 system prompt（§3.4）。
- **pi 行为**：`pi-agent-core/dist/agent-loop.js:481-488`。名字不在当前工具集里时，在 `beforeToolCall`（`tool_call` 钩子）**之前**就返回 immediate 错误 `Tool get_subagent_result not found`；`:386-391` 显示 immediate 结果也**不走** `afterToolCall`（`tool_result` 钩子）。所以没法在钩子里重定向（方案 C 不可行）。conformance R6 会把这个边界钉住。
- **后果**：浪费一个工具步骤，模型看到 not found 和当前工具列表后改用新名。D6 的过渡半句让这个映射一步到位。

### 3.4 stable 模式的尾部更新（minor #7）

agent-types 段在 `systemPrompt.mode=stable`（默认）下是冻结快照。按快照状态分三种：

| 会话的快照状态                               | 改名后模型看到什么                                                                                    | smoke 预期                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 还有更新额度（发出次数 < 3 且字节 < 32 KiB） | 一条 `<pi_section_update name="agent-types">` 完整替换块，含新名                                      | 更新块出现，并且含 `get_run_result`      |
| 这次超限                                     | pointer 文案：「该段已变化，完整副本被截留，视为可能过期」（`update-message.ts:29-34`），**不含新名** | 出现 pointer，system prompt 主体仍含旧名 |
| 已经 POINTED                                 | 什么都不发（`stable-section.ts:48`），system prompt 仍含旧名，直到下一个 refresh 点（比如 compact）   | 不出现新的更新消息                       |

后两种情况下，模型能拿到的权威线索只有工具列表（只有新名）和新描述里的过渡半句（D6）。这也是 D6 推荐「加」的主要理由。最坏情况是一次 not found 后自行纠正（§3.3）。

### 3.5 drop-in 替代（`@tintinweb/pi-subagents`）

- 受影响的是用户 agent Markdown、项目 prompt、skills、外部脚本里硬编码的旧名。本机扫描（`~/.pi/agent` 排除 sessions，`~/.agents`，`~/.claude`）没有活配置依赖旧名。
- 本项目早就有意偏离 drop-in：`e3ce20a1 feat(agent)!:`（Agent 改为 background-only）、`7142a380 feat(tools)!:`（`timeout_ms → timeout_s`）。P3 在 README、AGENTS.md、`docs/guide/migration.md` 里补一句「结果工具叫 `get_run_result`（≤v0.9 叫 `get_subagent_result`）」。

### 3.6 按工具名匹配的配置（minor #8）

| 配置 / 匹配点                                                                                                                                      | 所有者  | 旧名的后果                                                                                           | 处理                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 飞书 `waitNotifyTools`（`~/.pi/agent/feishu-notify.json`；`src/feishu-notify/core.ts:67` 解析，`index.ts:545` 用 `includes(event.toolName)` 匹配） | toolkit | 配了旧名就静默失配，阻塞 wait 不再提醒                                                               | **P1 做读取时映射**：`parseConfig` 里旧名换成新名并去重（新增纯函数 `migrateToolNames(names, {[LEGACY]: RESULT})`，放在 `src/core/tool-names.ts`）。加单测。feishuNotify 在 secure 域里强制关闭（D8），映射不影响这一点 |
| agent frontmatter `tools` / `excludeTools`                                                                                                         | toolkit | 结果工具从不授予子会话（`runtime-adapter.ts` 的 `grantedReserved` 不含它），写不写都一样             | 不处理，迁移指南里提一句                                                                                                                                                                                                |
| pi 的 `--tools` / `--exclude-tools` / settings `defaultTools`                                                                                      | pi      | `--tools` 明确列出旧名的话，新名不会被选中（这种情况 `_usesDefaultTools` 为假，§3.1 的迁移也不触发） | 我们改不了 pi 的配置，写进迁移指南。本机 `~/.pi/agent/settings.json` 已确认没有 tools 类键                                                                                                                              |
| HUD `toolCounts`（`src/hud/index.ts:469`）                                                                                                         | toolkit | 旧会话的计数分在两个名字下                                                                           | 只是展示，不处理                                                                                                                                                                                                        |
| web UI `RUN_REF_TOOLS` / `MD_RESULT_TOOLS`                                                                                                         | toolkit | 历史卡片丢 runRef 头和 markdown                                                                      | P2 新旧两个名字都认                                                                                                                                                                                                     |
| traffic 改写规则（用户自写）                                                                                                                       | 用户    | 规则里写死旧名会失配                                                                                 | 迁移指南提醒                                                                                                                                                                                                            |

### 3.7 web hub 新旧混跑

UI 认新旧两个名字后，历史卡片和新卡片都正常。旧 hub（UI bundle 没更新）× 新 agent：新名卡片回落成 `<pre>`，`/webhub restart` 后恢复。没有 wire 变化，I10 不受影响。

## 4. 方案对比（D1）

| 方案                           | 做法                                  | 每请求成本                                      | 需要 §3.1 迁移                                    | 能解决服务端 400       | 结论                                                        |
| ------------------------------ | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| A 纯硬切                       | 只改名                                | 约 +30 token（新描述）                          | 是                                                | 否                     | 不完整                                                      |
| **A′**（推荐）                 | A + §0 列出的迁移和 5 项被动兼容      | 约 +40 token                                    | 是（已含）                                        | 靠 F1/F2 兜底          | **推荐**                                                    |
| B1 双名可见                    | 新旧两个工具都注册                    | 约 +650 token（多一份描述 + schema，约 2.8 KB） | 是                                                | 是                     | 拒绝：长期付费、模型混用、轮询守卫和 usage 去重要跨名字共享 |
| B2 隐藏别名                    | 旧名是别名，`hiddenDeclarations` 隐藏 | 约 +40 token                                    | **是**（resume 时只有别名 active，新名不 active） | **否**（声明也被剥掉） | 备选（只为不升 major）                                      |
| C 钩子重定向                   | `tool_call` 钩子拦截                  | —                                               | —                                                 | —                      | 不可行（§3.3）                                              |
| D 合并成 bash_job 式的管理工具 | 一个工具管 result/abort/extend/list   | —                                               | —                                                 | —                      | 拒绝：过度设计                                              |

## 5. 命名

### 5.1 结果工具（D2）

| 候选                    | 评价                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`get_run_result`** ★  | 保留 `get_…_result` 的形状，模型从旧名联想过来成本最低；`run` 和参数 `run_id`、id 前缀 `r_`、项目内部词汇（run registry、`RunOutcome`）一致；把 workflow 定义成一种后台 run 就能覆盖；不和 `bash_job`（job 词汇）冲突；全仓零占用 |
| `check_run`             | 读起来像只看状态，弱化了「收取完整结果」这个主用途                                                                                                                                                                                |
| `get_result`            | 太泛，容易和其他扩展或 MCP 撞名，也容易被拿来读 bash job                                                                                                                                                                          |
| `run_result`            | 纯名词，可能误读成「去运行」                                                                                                                                                                                                      |
| `get_background_result` | 和 bash 的后台 job 混淆；太长                                                                                                                                                                                                     |

### 5.2 工具族（D5）

| 工具                      | 能管 `wf_` 吗                        | 证据                                  |
| ------------------------- | ------------------------------------ | ------------------------------------- |
| `get_subagent_result`     | 能                                   | `result-tool.ts:62-66`                |
| `abort_subagent`          | 能（终止整个 workflow 和它的子 run） | `abort-tool.ts:14`                    |
| `extend_subagent_timeout` | 能（延长 workflow 的期限）           | `extend-timeout-tool.ts:29-30,158`    |
| `list_subagents`          | 列出 workflow                        | `list-subagents-tool.ts:323`          |
| `steer_subagent`          | 只能管 run                           | `steer-tool.ts`（没有 workflow 分支） |
| `set_model`               | 只能管 run                           | —                                     |

**推荐：只改结果工具。** 理由：

1. 结果工具的名字出现在每一条通知、`/task` 回执、定时任务消息、workflow 回执里，模型总是拿着各类 id（`r_` 来自 subagent 和定时任务，`wf_` 来自 workflow）来调它，名字不准确的代价最高。另外三个工具的主要对象仍然是 subagent run，它们的描述已经写明接受 `wf_`。
2. 每多改一个名字，就多一份 §3.1 迁移条目、golden 替换（`schedule-off` 的 systemPrompt 和嵌套 golden 都提到了 `steer_subagent`/`abort_subagent`）、提示文案和用户迁移成本，可理解度的收益却很小。
3. 代价：族内命名不对称（`get_run_result` 和 `abort_subagent` 并存）。如果用户更看重一致性，**唯一合适的时机是同一个 1.0 窗口**，改成 `abort_run`、`extend_run_timeout`、`list_runs`（`steer_subagent`/`set_model` 保留），以免出现第二次 breaking。那样需要另出一份方案，因为文件域和 golden 面会扩大约 3 倍。

### 5.3 新文案草案（英文，模型可见）

需要满足 `tests/tools/model-facing-strings.test.ts`：不出现 `§` 或 `architecture`；`run_id` 描述含 `label`；description 匹配 `/user cannot send new input/`；`wait` 参数描述原样保留（匹配 `/user\s+cannot type a new message/`）。

```ts
name: RESULT_TOOL_NAME, // "get_run_result"
label: "Get Run Result",
description:
  "Check on, or collect the result of, a background run by its id: a subagent run (r_…) started with the " +
  "Agent tool, /task or a scheduled task, or a SubagentWorkflow (wf_…) — progress while it runs, the full " +
  "outcome (for a workflow, plus its children's spend) once it is terminal. (Formerly named get_subagent_result.) " +
  "Every such run pushes a completion notification on terminal state, so the normal flow is: continue other " +
  "work (or end your turn), then call this tool without wait once the notification arrives. Set wait: true " +
  // ↓ 以下和现有描述逐字相同
  "to block until the run finishes (up to wait_ms) — while it blocks, the user cannot send new input, so " +
  "avoid it whenever anything else could proceed (ending your turn counts); it is a fallback for when an " +
  "expected notification never arrived. Terminal results include the run's wall-clock " +
  "duration (text trailer and details.durationMs), so post-completion reads still expose how long it ran. " +
  "Long result text is capped by resultMaxChars with a session-file path for reading the full transcript. " +
  "Reading a result never consumes the run, so checking is safe — but rapid repeated polling of the " +
  "same run returns a warning; await the completion notification instead. " +
  "A wait that times out tells you how to proceed; repeated timeouts on the same run escalate that " +
  "guidance (raise wait_ms, or stop blocking and await the notification).",
promptSnippet:
  "get_run_result(run_id, wait?, wait_ms?) - check a background run's status/result (subagent, scheduled task or workflow)",
// run_id:
"The id of the run to read: a run id (r_…) returned by the Agent tool or named in a /task or scheduled-task " +
"notification; also accepts a unique run_id prefix or the Agent call's label (its description). " +
"A SubagentWorkflow id (wf_…, or a unique prefix / the workflow's script name) reads that background workflow instead."
```

**golden 覆盖到的字符串只替换名字，不改措辞**（嵌套 Agent 两处、agent-types 三行），这样 §6.3 能做字节级证明。

## 6. 冻结 golden（D3，需用户裁定）

### 6.1 三份 golden 各钉了什么

| golden（A 级）                                          | 钉的内容（测试）                                                                                                                                                                      | 旧名的字节出现次数（`grep -o`）                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `tests/fixtures/fabric-xs-off-golden.json`              | xs 关闭时：桩 `activate()` 的有序注册工具名 `mainSessionTools`、`RESERVED_TOOL_NAMES`、`message_agent` schema、hub wiring（`tests/integration/fabric-xs-off-golden.test.ts:171-200`） | 2（`mainSessionTools[9]`、`reservedToolNames[1]`） |
| `tests/fixtures/schedule-off-golden.json`               | schedule 关闭时：`surface.tools`、commands、`handlerCounts`、完整 systemPrompt、statuses、文件、wiring（`tests/integration/schedule-off-golden.test.ts:115-153`）                     | 4（`tools[1]` + systemPrompt 3 处）                |
| `tests/fixtures/tools/agent-nested-surface-golden.json` | 嵌套 Agent 的参数 JSON 和描述逐字节不变（`tests/tools/model-facing-strings.test.ts:296-304`）                                                                                         | 2                                                  |

前两份证明的是「功能 X 关闭时，表面和基线一致」。改名是和 X 无关的**基线迁移**。第三份证明嵌套表面没有意外漂移，改名是有意的表面变更。其余 golden 零命中（`fabric-wake-off`、`fabric-xs-reply-off`、`compact-hint`、`secure-off`、`secure-contract-parity`、`keepalive-legacy`、`bash-tools`、`quota-kimi-zai`、`legacy-xs-v071/`、B/C 级）。新名 `get_run_result` 目前在全仓零出现。

§3.1 的迁移挂在**已有**处理器上，所以 `handlerCounts` 不变。迁移在桩 pi（没有 `getActiveTools` 等方法）上不做事，`registerToolRenderer` 也是探测后才注册，所以 golden 只有名字替换。

### 6.2 可选办法

| 办法                          | 说明                                                                                                         | 风险                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **G1 一次性机械更新**（推荐） | 不跑任何 regen；按 §6.3 的变换产出新文件，再用同一个脚本做字节级断言。先例：#40 Q1（`d32a4a21`）、`86b2e5a4` | 打破「永不重生」字面规则一次，需要明确授权；断言把允许的 diff 精确到子串替换次数和一个锚点追加   |
| G2 比较时做名称映射           | golden 文件不动，测试里先映射再比                                                                            | 「逐字节」退化成「映射后逐字节」，映射表是永久负债，还会抹平新名出现在错误位置这种真漂移。不推荐 |
| G3 / G4                       | 保留旧名注册 / agent-types 文案保留旧名                                                                      | G3 无效（新名也要注册）；G4 教模型调一个不存在的工具。拒绝                                       |

### 6.3 字节级 golden 断言（P1 报告必须附输出）

`BASE` 是 P1 开工时的 `HEAD`（提交前 `BASE=HEAD`；提交后复验用 `BASE=HEAD~1`）。

```sh
BASE=${BASE:-HEAD} node -e '
const fs=require("node:fs"),assert=require("node:assert"),{execFileSync}=require("node:child_process");
const BASE=process.env.BASE, OLD="get_subagent_result", NEW="get_run_result";
const git=(...a)=>execFileSync("git",a);                         // 返回 Buffer，不经过 JSON
const count=(s,sub)=>s.split(sub).length-1;
function check(path, oldCount, extra){
  const oldBuf=git("show",`${BASE}:${path}`), oldStr=oldBuf.toString("utf8");
  assert.ok(Buffer.from(oldStr,"utf8").equals(oldBuf), path+": utf8 round-trip");   // 解码无损
  assert.equal(count(oldStr,OLD), oldCount, path+": old-name count");
  assert.equal(count(oldStr,NEW), 0, path+": new name pre-existing");
  let exp=oldStr.split(OLD).join(NEW);                              // 唯一允许的替换
  if (extra) exp=extra(exp);
  const neuBuf=fs.readFileSync(path);
  assert.ok(neuBuf.equals(Buffer.from(exp,"utf8")), path+": bytes differ from the allowed transform");
}
// fabric-xs-off：额外只允许在 reservedToolNames 末尾（唯一锚点）追加一行
check("tests/fixtures/fabric-xs-off-golden.json", 2, (s)=>{
  const A=`    "switch_context"\n  ],\n  "messageAgentSchema"`;
  assert.equal(count(s,A),1,"anchor unique");
  return s.replace(A,`    "switch_context",\n    "${NEW}"\n  ],\n  "messageAgentSchema"`);
});
check("tests/fixtures/schedule-off-golden.json", 4);
check("tests/fixtures/tools/agent-nested-surface-golden.json", 2);
// fixtures 下恰好这 3 个文件有变化，并且没有未跟踪文件
const changed=git("diff","--name-only",BASE,"--","tests/fixtures").toString().split("\n").filter(Boolean).sort();
assert.deepStrictEqual(changed,[
  "tests/fixtures/fabric-xs-off-golden.json",
  "tests/fixtures/schedule-off-golden.json",
  "tests/fixtures/tools/agent-nested-surface-golden.json"]);
assert.equal(git("ls-files","--others","--exclude-standard","--","tests/fixtures").toString().trim(),"");
console.log("golden rename diff OK (byte-exact)");'
```

注意：

- 先跑 `npm run format:check`，再跑这个脚本。`fabric-xs-off`/`schedule-off` 不在 `.prettierignore` 里，prettier 如果把追加的数组重排，脚本会失败，那就说明手工产物不合格。
- 三份 golden 的 `note` 字段原样保留。
- commit body 写明：「A 级 golden 一次性机械更新，用户授权于 <日期>；工具改名是基线迁移，不是 off 行为变化」。

## 7. 总体设计（A′）

### 7.1 改动点

1. **名字单一来源**：新建 `src/core/tool-names.ts`，零 import，满足 `src/core` 的 pi-free 边界。`delivery`/`schedule`/`config`/`commands`/`feishu-notify` 都可以从这里取。
   ```ts
   export const RESULT_TOOL_NAME = "get_run_result";
   /** ≤ v0.9.x name. Reserved in child sessions, drawn for history, mapped in name-keyed settings; never registered. */
   export const LEGACY_RESULT_TOOL_NAME = "get_subagent_result";
   /** Rename map applied to name-keyed user settings (order-preserving, de-duplicated). */
   export function migrateToolNames(names: readonly string[]): string[];
   ```
   src 里模型可见的文案一律改成插值引用，golden 覆盖的字符串插值后应当逐字节等于替换后的 golden。web UI 是独立 bundle，用字面量。
2. **`RESERVED_TOOL_NAMES`**：索引 1 的旧名**原地保留**，注释标 LEGACY（同 `consult` 先例）；**末尾**追加 `RESULT_TOOL_NAME`。
3. **result-tool.ts**：按 §5.3 改 name、label、description、snippet、`run_id` 描述、renderCall 标题、`extensionOwner`；schema 结构不变。
4. **TUI 历史渲染**：result-tool.ts 导出纯函数 `legacyResultToolRenderer(tool)`，返回 `(toolName, next) => toolName === LEGACY_RESULT_TOOL_NAME ? { renderCall, renderResult } : next()`。`src/index.ts` 在 `registerTool` 旁边加一行：`if (typeof pi.registerToolRenderer === "function") pi.registerToolRenderer(...)`（pi 1.0.1 起才有）。golden 的桩 pi 没有这个方法，所以不受影响。
5. **激活迁移**（§3.1）：新建 `src/tools/result-tool-activation.ts`，在 `src/index.ts:1439`（主 `session_start`）和 `:437`（`session_tree`）各加一次调用。
6. **飞书 `waitNotifyTools` 映射**（§3.6）：`src/feishu-notify/core.ts:67` 在数组分支上套一层 `migrateToolNames`。
7. **定时任务常量合并**（§8）：删掉 `src/schedule/agent/result-reference.ts` 里的 `SCHEDULE_RESULT_TOOL`，`note.ts`/`report-file.ts` 改成 `import { RESULT_TOOL_NAME }`。
8. **web UI**（P2）：两个集合都加 `"get_run_result"`，旧名那一项加注释「仅用于历史 transcript」。
9. **文案替换**：§2.1 列出的每一处模型可见文案，加 `poll-guard.ts:49` 的默认告警。
10. **不变**：`run_id` 参数名、`ResultToolDetails`、错误文本、usage 去重、poll guard 和 timeout streak、通知管线、wire。

依赖方向：

```
src/core/tool-names.ts（零依赖）
  ▲ tools/*（含 result-tool-activation）  delivery/format  schedule/agent  config/agent-types  commands/task  runtime/tool-scope  feishu-notify/core
  ▲ src/index.ts（只做装配：registerTool、探测后 registerToolRenderer、在已有 session_start/session_tree 里各调一次迁移）
web-hub/ui（独立 bundle，字面量，新旧两个名字）
```

### 7.2 每包门禁

`npm run format:check && npm run typecheck && npm test && npm run build`。另外：

- P1：§6.3 脚本，加 `npm run test:conformance`（含新增的 §7.3 套件；不是 peer bump，droid 和 gocryptfs 套件不需要）。
- P2：`npm run build:web && npm run check:web`。

### 7.3 测试计划

**单测（P1）**：

- `tests/runtime/tool-scope.test.ts`：新旧两个名字都是保留名，子会话里同名的后注册工具会被剥掉。
- `tests/tools/result-tool.test.ts`：`name === RESULT_TOOL_NAME`；`legacyResultToolRenderer` 对旧名返回新工具的 renderer，对其他名字走 `next()`。
- `tests/tools/result-tool-activation.test.ts`：`planResultToolActivation` 的真值表，至少覆盖这几种情况：declared 含旧名且新名不 active → 追加；declared 不含旧名 → 不动；新名已 active → 不动；新名未注册 → 不动；不丢已有 active 项，顺序保持。另测能力探测缺失时不做事、`setActiveTools` 抛错时吞掉并打 `[pi-subagent]` 日志。
- `tests/feishu-notify/*`：`waitNotifyTools: ["get_subagent_result","ask_user"]` 解析成 `["get_run_result","ask_user"]`，旧名和新名同时存在时去重。
- `tests/tools/model-facing-strings.test.ts`：保留现有断言，新增「result 描述含 `wf_` 和 `scheduled task`」。
- 其余 34 个测试文件里的期望字符串：机械替换，或改成引用常量。#62 的 `tests/schedule/agent/{note,report-file}.test.ts` 也在内。

**新 conformance：`tests/conformance/result-tool-rename.test.ts`（P1）**

- 环境：真实 `createAgentSession`/`createAgentSessionRuntime`；`extensionFactories` 里放**真实的 toolkit `activate`**（`tests/integration/explicit-timeout-e2e.test.ts` 已经证明能在测试进程里加载 `src/index.ts`）。HOME 和 agentDir 都指向临时目录。web-hub、schedule、xs 保持默认关闭。模型用 `agent-session-harness.ts` 的 fakeModelRuntime，它记录每次请求的 `context.messages`；对这些 messages 跑 `getCurrentTools` 得到请求里实际声明的工具。
- 种子会话：先用一个只注册 `get_subagent_result`（加 bash）的桩扩展跑一轮：脚本化模型调用一次旧名，然后结束。这样 transcript 里会声明旧名，也有旧名的 toolCall 和 toolResult。

| 编号 | 场景                                                                                         | 断言                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | 前提钉：不加载 toolkit，只用另一个注册了 `get_run_result` 的桩去 resume 种子会话             | `getActiveToolNames()` **不含** `get_run_result`。钉住 pi 1.3 的恢复行为；pi 一旦改了，这条会提醒我们重新评估                                                                               |
| R2   | 用真实 toolkit resume 种子会话                                                               | `session_start` 之后 active 含 `get_run_result`；第一次请求声明了 `get_run_result`、没声明旧名；历史 toolCall 仍是旧名；请求成功（fake）                                                    |
| R3   | fork 种子会话里的旧条目                                                                      | 同 R2                                                                                                                                                                                       |
| R4   | 在 R2 会话里发一轮（新名进入 transcript），再 `navigateTree` 回种子节点                      | `session_tree` 之后 active 含 `get_run_result`                                                                                                                                              |
| R5   | 新会话里用 `setActiveTools` 停用 `get_run_result` 并发一轮（transcript 不含旧名），再 resume | **保持停用**（尊重用户选择）                                                                                                                                                                |
| R6   | `/reload`（`session.reload()`）                                                              | active 含 `get_run_result`（pi 自己的行为），迁移不做事                                                                                                                                     |
| R7   | 脚本化模型调用 `get_subagent_result`，同时挂一个探针扩展记录 `tool_call`/`tool_result`       | toolResult 是 `isError` 且文本为 `Tool get_subagent_result not found`；探针的 `tool_call` 和 `tool_result` **都没被调用**（钉住钩子边界：pi 一旦开始对未知工具触发钩子，方案 C 就变得可行） |
| R8   | `session.extensionRunner.resolveToolRenderers("get_subagent_result", () => undefined)`       | 返回对象含 `renderCall`/`renderResult`；对 `"get_run_result"` 返回注册的 renderer；对无关名字走 base                                                                                        |

**残留门禁（分两段）**：新增 `tests/docs/result-tool-rename.test.ts`。

- P1 版：只扫 `src/**`（排除 `src/web-hub/ui/**`）和 `tests/**`。允许列表：`src/core/tool-names.ts`、`src/runtime/tool-scope.ts` 的保留项、`result-tool.ts` 的过渡半句、本门禁测试自己、迁移和兼容相关测试、3 份 golden 以外的 fixtures 语料（`preview-perf/stack-3609.ts.txt`）。
- P2 合入后：从排除项里去掉 `src/web-hub/ui/**`，允许列表加上 UI 的两个集合。
- P3 版：扫描范围扩到 `package.json`、`README*.md`、`AGENTS.md`、`docs/guide/**`、`docs/dev/*/README.md`、`skills/**`。允许列表加 README、AGENTS、`migration.md` 里的迁移说明。

### 7.4 真机 smoke（P1 合入后、发版前；tmux 流程按 live-acceptance-tmux 记忆）

准备：

- 临时开启 traffic 录制（`traffic.enabled`，default off，secure 域外可用），结束后关掉。
- 拿一个改名前产生的、含 `get_subagent_result` 调用的真实会话（复制一份，不动原件）。

| 步骤 | 内容                                                                                                                                                                                                    | 记录与通过标准                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | 依次用 `cr-anthropic`（或 `copilot-anthropic`，Anthropic Messages 中转）、`cr-response` 或 `copilot-response`（OpenAI Responses 中转）、`cr-kimi` 或 `cr-glm`（OpenAI Completions 中转）resume 并发一轮 | 从 traffic 记录里摘出：请求 `tools[].name` 名单（含 `get_run_result`、不含旧名）、历史里的 `tool_use`/`function_call` 名（含旧名）、HTTP 状态。三家都要 2xx。只要有一家 400，就按 D8 选 F2 或 F1，修完重跑 S1 |
| S2   | 同一会话执行 `/tree` 回到旧节点再发一轮                                                                                                                                                                 | 请求的 tools 里有 `get_run_result`                                                                                                                                                                            |
| S3   | stable 模式下检查 agent-types 段                                                                                                                                                                        | 按 §3.4 的三态之一出现。三态都算通过，但要记录是哪一种                                                                                                                                                        |
| S4   | 诱导模型调用旧名                                                                                                                                                                                        | 拿到 not found，下一步改用 `get_run_result`                                                                                                                                                                   |
| S5   | TUI 历史卡片                                                                                                                                                                                            | 旧名卡片按 `Get Run Result:` 标题渲染（pi ≥1.0.1）                                                                                                                                                            |
| S6   | web hub 历史卡片（P2 合入、`/webhub restart` 之后）                                                                                                                                                     | 新旧两个名字都有 markdown 渲染和 runRef 头                                                                                                                                                                    |
| S7   | 如果启用了 F2                                                                                                                                                                                           | Anthropic 带 thinking 的会话、OpenAI Responses 带 reasoning 的会话在历史改名后都能正常续写（没有签名或 reasoning 错误）                                                                                       |

### 7.5 prompt cache

- 本项目主会话里，sysprompt hub 只要折叠出段落（主会话总有 agent-types 段）就会返回 `{systemPrompt}`（`src/sysprompt/hub.ts:349-372`），pi 因此设置 `forceSystemPrompt`（`extensions/runner.js:1147`）。`_installAgentForcedPromptProjection`（`agent-session.js:1352-1366`）把所有 system 消息折叠成一个头部，头部带当前 `toolsAdded`，所以工具集的任何变化都会改写请求最前面那段。
- 结论：每个存活会话在**工具集变化后的第一个请求**（`/reload` 之后，或者 resume、`/tree` 迁移之后）整段 cache miss 一次，之后照常命中。没有「增量保前缀」这条路。
- 新会话、子会话没有额外成本。只有嵌套 Agent 描述变了，只影响新 spawn 的子会话。
- 如果启用 F2，历史字节也会变，但和上面那次 miss 发生在同一个请求里。
- 发版说明里写上这一点，建议空闲时 `/reload`。

## 8. 和 #62 的耦合（D7）

- #62（未提交）已经把定时任务里的结果工具名收拢成 `src/schedule/agent/result-reference.ts:7` 的 `SCHEDULE_RESULT_TOOL`，引用方是 `note.ts:131`（`` `${SCHEDULE_RESULT_TOOL} ${run.runId}` ``，没有 runId 时回落到报告的绝对路径）和 `report-file.ts:61`（截断后缀）；`docs/dev/scheduled-reports/README.md:9` 同步写了旧名。
- 推荐 #62 先提交。P1 再删掉 `SCHEDULE_RESULT_TOOL`，改成 `import { RESULT_TOOL_NAME } from "../../core/tool-names.js"`，同步 `tests/schedule/agent/{note,report-file}.test.ts`。README 那一处归 P3。
- **P1 的前置条件**：`git status --short` 为空（#62 已提交），避免两个包同时改 `src/schedule/agent/**`。
- 这些文本只在 schedule 开启时产生，不在 `schedule-off-golden` 里。已经写进会话历史的定时任务消息不可改写，归入 §3.3 的诱导来源（如果启用 F2，它只改 toolCall，不改这些 custom 消息）。

## 9. 拆包

| 包     | 文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 依赖                       | 提交与门禁                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | 新建 `src/core/tool-names.ts`、`src/tools/result-tool-activation.ts`；修改 `src/tools/{result-tool,agent-tool,workflow-tool,abort-tool,extend-timeout-tool,list-subagents-tool,poll-guard}.ts`、`src/runtime/tool-scope.ts`、`src/config/agent-types.ts`、`src/delivery/format.ts`、`src/commands/task.ts`、`src/schedule/agent/{note,report-file,result-reference}.ts`、`src/feishu-notify/core.ts`、`src/index.ts`（只加装配：renderer 探测注册，在已有的 `session_start`/`session_tree` 里各调一次迁移）、§2.2 列出的 src 注释；`tests/**`（不含 `tests/web-hub/ui/**`），含新 conformance、单测、P1 版残留门禁；3 份 golden | D1–D3 拍板；#62 已提交     | 同一个提交：`refactor(tools)!: rename get_subagent_result to get_run_result`，带 `BREAKING CHANGE:` 脚注。门禁：§7.2 + §6.3 + `test:conformance`                                                                  |
| **P2** | `src/web-hub/ui/src/logic/tools.js`、`src/web-hub/ui/src/components/transcript/ToolCard.vue`、`tests/web-hub/ui/tool-card.test.ts`（新旧两个名字各跑一遍 markdown 和 runRef 用例）                                                                                                                                                                                                                                                                                                                                                                                                                                              | 无（纯增量，可与 P1 并行） | `feat(web-hub,ui): render get_run_result cards like the legacy result tool`；`build:web` + `check:web`                                                                                                            |
| **P3** | `package.json:4`、`README.md`、`README.en.md`、`AGENTS.md`、`docs/guide/{subagents,migration}.md`、`docs/dev/{web-hub,subagent-core,fabric-cross-session,external-agent,context-switch,scheduled-reports}/README.md`、`skills/dev-flow/SKILL.md`、`skills/dev-flow/references/subagent-workflow.md`；把残留门禁扩到这些文件（P3 版）                                                                                                                                                                                                                                                                                            | P1 已合入                  | `docs: rename get_subagent_result to get_run_result in guides and skills`。`migration.md` 写：新名、旧会话兼容（自动激活）、not found 的含义、`--tools`/`defaultTools`/traffic 规则需要手动改、飞书配置会自动映射 |

每包返回后派 verifier（验收模型和开发模型不同）。P1 的 verifier 报告必须附：§6.3 输出、conformance R1–R8 结果、`git status --short` 干净证明。真机 smoke §7.4 在 P1、P2 合入后、发版前做。

## 10. 发版（D4）

- 工具名是对外接口，D1=A′ 时旧名不可调用，所以是 BREAKING。先例：`7142a380 feat(tools)!:`（参数改名）。
- 规则（`scripts/release/release.sh:219-242`）：遇到 BREAKING 建议 major，也就是 v1.0.0，要先 PR dev→master，再在 master 上打版，发完 `git switch dev && git merge --ff-only master`。
- 推荐：P1 照实标 `!`，在 dev 上攒着，和 1.0 一起发（同时把 D5 定下来）。只有选 D1=B2，才能合规地按 patch 发；代价见 §4，而且 B2 照样需要 §3.1 的迁移。
- CHANGELOG 由脚本生成，进「⚠️ Breaking Changes」节。commit body 写：新名；旧会话 resume、`/tree` 时自动激活新名；旧名调用会得到 not found；TUI 和 web 的历史卡片照常显示；飞书 `waitNotifyTools` 自动映射；`--tools` 要手动改；升级后每个会话有一次 cache miss。

## 11. 风险清单

| 风险                                                         | 等级 | 缓解                                                  |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------- |
| pi 1.3 resume、fork、`/tree` 后没有结果工具                  | 高   | §3.1 迁移 + conformance R2–R5，R1 钉住 pi 的前提      |
| 服务端拒收历史里未声明的工具名                               | 中   | §7.4 S1 三类 API 真机记录；F2 或 F1 退路（D8）        |
| 模型照旧名调用                                               | 低   | not found 自纠正（R7 钉边界）；D6 过渡半句            |
| stable 模式 POINTED 会话的 prompt 一直是旧名                 | 低   | 工具列表和 D6 为权威；compact 后 refresh              |
| golden 更新夹带漂移                                          | 低   | §6.3 字节级断言 + 文件集合断言                        |
| 漏改模型可见文案                                             | 中   | 常量化 + 三段式残留门禁                               |
| 用户按名配置失配                                             | 低   | 飞书自动映射；`--tools` 和 traffic 规则写进迁移指南   |
| F2 改历史和签名、加密 reasoning 冲突                         | 中   | 只有 S1 失败才启用；S7 专项验证                       |
| 和 #62 冲突                                                  | 低   | 前置条件：#62 已提交；`SCHEDULE_RESULT_TOOL` 并入常量 |
| 以后又想统一工具族，导致第二次 breaking                      | 中   | D5 在 1.0 之前定下来                                  |
| 新版本新增的工具在 pi 1.3 resume 时都不 active（一般化问题） | 中   | 本次只修结果工具；另记 todo 评估把激活迁移泛化        |

## r3 主会话裁定（第二轮评审后，2026-10-26）

两轮评审后按 dev-flow 由主会话裁定，以下条款**覆盖**正文中与之冲突的内容，实施以本节为准。

- **R2-B1 迁移不得重新打开用户停用的工具（采纳，改不变式）**：pi 1.3 `_restoreToolsFromTranscript` 的恢复集 = transcript 声明集 + `--tools` 的 `+/-` 修饰（`agent-session.js:1374-1381`）。迁移只在同时满足以下条件时追加新名：① 当前 transcript 的工具声明含旧名；② 新名已注册、`_isAllowedTool` 允许且当前不 active；③ **本进程没有任何 `--tools` / 工具修饰类参数**（扩展侧拿不到 modifiers 时一律不迁移，fail-safe）。能可靠读到 modifiers 时，可以把 ③ 放宽为「modifiers 未显式排除新名」。R5 必须覆盖 `--tools -get_run_result`（不得激活）与「无修饰」（应激活）两格。
- **R2-B2 golden 期望构造（采纳）**：字节断言脚本按**出现位置**替换：fabric-xs-off golden 的 `reservedToolNames` 保留旧名原位不动，只在列表末尾追加新名；其余出现位置按精确次数替换。脚本先对期望自检，确认保留名列表恰含旧名 1 次、新名 1 次，再与新文件逐字节比较。
- **R2-M1 残留门禁（采纳，简化）**：取消分阶段扩扫，旧名残留门禁只在**最后一个包**引入，届时一次扫全仓：src/tests/skills/README*/docs/guide/docs/dev/*/README.md/package.json。允许列表写死：保留名列表、历史兼容渲染、迁移代码、golden、`(Formerly named …)` 过渡句、旧设计档案。前面各包不加门禁，各自 npm test 自然独立变绿。
- **R2-M2/M3/M4 F1/F2 退路（采纳，移出本次范围）**：本次实施**不包含** F1/F2 的实现。真机 smoke（S1–S4）若出现服务端因历史旧名调用返回 400，立即停工，另出 F2 方案再评审（具体钩子、返回值接线、handlerCounts 授权、traffic 记录边界都在那份方案里定）。正文 F1/F2 降级为「备选思路」，S1/S4 的验收判据维持「记录实际请求组合 + 判定是否 400」，不预设修复后重跑。
- **R2-m1 cache 表述（采纳）**：改为「工具集变化后预计整段 miss，是否恰好一次取决于会话与 forced projection 状态」，不作确定性保证。
- 评审第一轮驳回的 #4 子项维持驳回（README.md / README.en.md 已在 §2.2 与 P3 文件域中）。

## 用户拍板（2026-10-26）

- D1 方案：A′（只注册新名 + r3 迁移规则 + 被动兼容）。
- D2 新名：`get_run_result`。
- D3：一次性授权更新 3 份 A 级 golden（fabric-xs-off、schedule-off、tools/agent-nested-surface），范围按 r3 R2-B2，由字节级脚本证明。
- D4：改名提交标 BREAKING（`!:`），先在 dev 上攒着，择机一起发 v1.0.0；改名合入前可以先发 v0.9.x patch。
- D5：只改结果工具，其余 subagent 工具名不动。
- D6：加过渡半句 `(Formerly named get_subagent_result.)`，按推荐处理。
- D7：#62 已先提交（8505261d），常量 `SCHEDULE_RESULT_TOOL` 并入统一名字常量。
- D8：按 r3 移出本次范围（smoke 出现 400 时停工另立方案）。
