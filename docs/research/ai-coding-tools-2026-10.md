# AI 编码工具功能调研报告（2026-10）

> 调研日期：2026-10-23。方法：web_search 检索各工具 2026 年最新版本与更新日志，所有来源 URL 均来自真实搜索结果。拿不准的条目标注「未核实」。
> 目的：盘点主流 AI 编码 IDE / CLI 的有趣、差异化功能，对照 pi-toolkit 现有能力分三类，并给出最值得借鉴的 Top 10。

---

## 一、各工具差异化功能盘点

### 1. Claude Code（Anthropic）

Claude Code 在 2026 年已是功能密度最高的终端编码 agent，v2.1.x 系列（10 月已到 2.1.292）。

- **Hooks**：用户可在设置里配置 shell 命令钩子，挂在工具调用/通知等事件上；2026 年新增 `onFailure: "block"`——钩子启动失败/超时/异常退出时阻断动作而不是放行，以及 plugin hooks 的 `serverToolUses`/`agentId`/`ceiling` 字段、`agent.spawn` mod hook 可拒绝 workflow agents。
  来源：https://releases.sh/anthropic/claude-code · https://megachangelog.com/changes/claude-code/claude-code-2-1-290-release-b60b059
- **Subagents + effort 参数**：Agent 工具派发子代理，2.1.292 起 Agent 工具新增 `effort` 参数，可按指定 effort 级别跑子代理；还有 `autoCompactWindow for subagents`、`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`（workflow 子代理独立模型）。
  来源：https://releases.sh/anthropic/claude-code · https://claudekit.io/en/updates/claude-code-2-1-292/
- **Skills（Agent Skills 开放标准）**：技能 = 带 SKILL.md 的能力包；2026 年 9 月起 Team/Enterprise 有组织级管理、合作伙伴技能目录，并作为开放标准（Agent Skills）跨平台复用；企业可开启第三方 skill/plugin 安全扫描。
  来源：https://support.claude.com/en/articles/12138966-release-notes
- **Plugins / Marketplace**：6 月推出插件市场 + Team/Enterprise 管理控制；9 月开放开发者门户提交插件、评审跟踪、用量分析；`claude plugin install --marketplace <source>` 一步加市场并安装。
  来源：https://support.claude.com/en/articles/12138966-release-notes · https://t.co/2urqPZDABy（anthropics/claude-code CHANGELOG）
- **Output Styles**：一套指令设定 Claude 在会话中的角色、语气与回复格式（如把 Claude Code 变成写作/研究助手）。
  来源：https://code.claude.com/docs/en/output-styles
- **/rewind checkpoint（检查点回滚）**：每次 Claude 通过文件编辑工具改动文件前自动存 checkpoint，`/rewind`（别名 `/checkpoint`、`/undo`）可把对话、代码或两者回滚到任一历史点，checkpoint 随会话持久化，关掉终端后 resume 仍能 rewind。
  来源：https://www.chenboyuan.com/claude-code-doc-monitor/2026/03/04/claude-code/interactive-mode.html · https://thepromptshelf.dev/blog/claude-code-checkpointing-rewind-guide-2026/ · https://bacol.todayz.workers.dev/post-https-code.claude.com/docs/en/checkpointing
- **背景任务 + agent view**：`/tasks` 列出/管理后台任务；`claude --resume <id> --bg "<prompt>"` 以 PTY 后台 job 恢复会话；`claude agents --json` 供脚本读取会话状态；agent view 用颜色标出「Needs input」（等待权限/问题/沙箱网络许可）；`/subtask <task>` 派生一个继承完整对话的后台 fork 子代理。
  来源：https://ofs.ccwu.cc/shanraisshan/claude-code-best-practice/blob/main/best-practice/claude-commands.md · https://github.com/thevibeworks/claude-code-docs/blob/main/content/en/docs/claude-code/agent-view.md
- **Statusline**：`/statusline` 自定义状态栏（模型、上下文用量等），社区有 ccstatusline 等可视化编辑器。
  来源：https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty · https://github.com/sirmalloc/ccstatusline
- **Sandbox**：`/sandbox` 切换沙箱模式（OS 级隔离；agent view 提到「sandbox prompt to allow a network host」，即沙箱内网络访问需逐主机批准）。
  来源：https://www.chenboyuan.com/claude-code-doc-monitor/2026/03/04/claude-code/interactive-mode.html · https://github.com/thevibeworks/claude-code-docs/blob/main/content/en/docs/claude-code/agent-view.md
- **Web / 移动端 / 云会话**：浏览器 claude.ai/code、Claude 手机 App 的 Code tab、桌面端都可发起云会话，跑在 Anthropic 托管沙箱里；**Routines**（定时/GitHub 事件/API 触发模板化云 agent）；手机推送通知提醒权限请求等。
  来源：https://code.claude.com/docs/en/claude-code-on-the-web · https://code.claude.com/docs/en/whats-new · https://tessl.io/blog/anthropic-brings-claude-code-to-the-web-and-mobile
- **Agent SDK**：用 Claude Code 同款工具/agent loop/上下文管理构建自家 agent 的 SDK。
  来源：https://www.developersdigest.tech/blog/building-saas-with-ai-agents-2026
- **Claude Duet（研究预览）**：Pro/Max 用户可用的新 App，Claude 作为主动型 agent 工作（proactive agent）。（细节少，未核实其编码场景定位）
  来源：https://support.claude.com/en/articles/12138966-release-notes?facet1=marketing

### 2. xAI Grok Build

- **Grok Build**：xAI（搜索结果里署名 SpaceXAI/SpaceXSI，品牌命名未核实）的终端编码 agent + TUI，Rust 编写（crates 结构），全屏、鼠标可交互、可扩展；2026-07-15 宣布开源；`curl -fsSL https://x.ai/cli/install.sh | bash` 安装，支持 `XAI_API_KEY` 无浏览器认证（CI/CD 友好），`/model grok-4.6` 切模型，最新模型 grok-4.7。亮点是「开源 harness」：agent 如何读/改/搜代码、如何跑命令全部可见可改。
  来源：https://docs.x.ai/build/overview · https://x.ai/news/grok-build-open-source · https://github.com/xai-org/grok-build · https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md

### 3. OpenAI Codex

- **Codex app（macOS → Windows）**：2026-02 推出的桌面「agent 指挥中心」GUI，3 月起支持 Windows。
  来源：https://openai.com/index/introducing-the-codex-app/
- **Codex CLI 改版**：重设计 TUI，新增图片输入、消息排队（agent 干活时可继续发消息）、简化审批模式、待办列表、web search。
  来源：https://x.com/OpenAIDevs/status/1960809814596182163?lang=en
- **云端任务 + IDE 扩展**：IDE 扩展在本地与云端之间无缝移动任务；10 月更新有可搜索设置、即时 steering（实时打断纠正）、可配快捷键。
  来源：https://openai.com/index/introducing-upgrades-to-codex/ · https://releasebot.io/updates/openai/codex
- GPT-5.3-Codex-Spark 研究预览已于 2026-09-14 弃用。
  来源：https://learn.chatgpt.com/docs/changelog

### 4. Cursor

- **Background Agents / Cloud Agents**：后台/云端 agent；2026 年新增「云 agent 的 shell 命令因 OOM 被杀时会告知 agent 内存上限以便降内存重试」、Move to Cloud 修复、后台唤醒的聊天在侧栏上移。Cloud Agents 的工具调用可跑在用户自有硬件上而模型仍在 Cursor 云（BYO 执行环境）。
  来源：https://prod.cursor.com/docs/release-notes · https://ai-tldr.dev/releases/tool/
- **Bugbot**：PR 自动代码评审机器人；2026 年改进：run-once 模式下评审进行中 push 的新提交也会被评审、增量评审保留 BUGBOT.md 规则、本地评审说明跳过了哪些文件、可关闭从已合并 PR 自动学习、Autofix。
  来源：https://prod.cursor.com/docs/release-notes · https://prod.cursor.com/changelog/1-0
- **Memories**：记忆功能，1.x 起持续改进生成质量，并对后台自动生成的记忆引入用户批准以保信任。
  来源：https://prod.cursor.com/changelog/1-2 · https://cursor.com/changelog/page/15
- **Tab（编辑预测）**：不只预测你要输入什么，还预测你要编辑哪里、光标移到哪、需要打开哪个文件；基于近期编辑、周边代码和 linter 错误。
  来源：https://www.rapidevelopers.com/blog/how-does-cursors-ai-powered-autocomplete-feature-work-2026-guide · https://cursor.com/help/ai-features/tab
- **Subagents 级联停止**：停掉一个 subagent 会连它派生的嵌套 subagent（含后台仍在跑的）一起停。
  来源：https://prod.cursor.com/docs/release-notes
- 内置浏览器（元素点选进 agent 上下文，防伪造点击）、Goals（目标驱动 loop）。
  来源：https://prod.cursor.com/docs/release-notes

### 5. Windsurf（Cognition / 与 Devin 融合中）

- **Cascade Hooks**：Cascade 事件的钩子（如 `POST_CASCADE_RESPONSE_WITH_TRANSCRIPT`，把完整 transcript 发给外部端点）；团队设置页可见钩子配置。
  来源：https://changelogs.directory/tools/windsurf/releases/windsurf-1.9566.9 · https://changelogs.directory/tools/windsurf/releases/windsurf-1.12.31
- **Git worktrees 支持**：同仓库并行开多个 Cascade 会话互不冲突。
  来源：https://changelogs.directory/tools/windsurf/releases/windsurf-1.13.3
- **Agent Skills**：v1.13.6 起 Cascade 支持 Agent Skills；MCP 系统级 skills。
  来源：https://www.havoptic.com/tools/windsurf · https://changelogs.directory/tools/windsurf?showPrereleases=false
- **Voice**：语音对 Cascade 下指令（Wave 11）。
  来源：https://www.linkedin.com/posts/windsurf_wave-11-is-here-bringing-a-faster-and-more-activity-7351684588919803905-uW_O
- **Adaptive Model Router**：自动按任务路由模型；v2 起深度整合 Devin（Devin Cloud Agent、Agent Command Center、Devin Review）。
  来源：https://changelogs.directory/tools/windsurf?showPrereleases=false · https://releasebot.io/updates/windsurf

### 6. Gemini CLI → Antigravity（Google）

- **重大变化**：2026-06-18 起 Gemini CLI 对个人用户停止服务，由 **Antigravity CLI** 取代；Antigravity 2.0 的核心概念：
  - **Agent Manager**：并行管理多个本地 agent 的指挥中心（go/tmux TUI）；
  - **Scheduled Tasks**：cron 定时触发 agent 调用；
  - **异步工作流**：CLI 在后台编排多个 agent 做大规模重构。
    来源：https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ · https://antigravity.google/blog/introducing-google-antigravity-2/ · https://antigravity.google/product/antigravity-cli/ · https://discuss.ai.google.dev/t/agent-manager-0-40-adds-antigravity-cli-as-a-built-in-agent/187227

### 7. GitHub Copilot

- **Copilot coding agent 2026 更新**：模型选择器、自评审（self-review）、内置安全扫描、自定义 agents、CLI handoff（云端任务交给本地 CLI 继续）。
  来源：https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/
- **Copilot Spaces**：把代码、文档、文件等组织成可复用、可共享的上下文包，喂给 Copilot 获得更精准回答。
  来源：https://github.com/orgs/community/discussions/160840
- Agent harness 治理、agent skills（企业向）。
  来源：https://www.microsoft.com/en-us/copilot/blog/copilot-studio/new-and-improved-github-copilot-harness-agent-skills-and-richer-context/

### 8. Kiro（AWS）

- **Spec 驱动**：prompt → 结构化需求（EARS 记法）→ 设计文档 → 任务清单，spec 是工作单元，任务可勾选跟踪；「validate code correctness to find bugs unit tests miss」（形式化/属性校验方向的宣传，未核实细节）。
  来源：https://kiro.dev/docs/specs/ · https://builder.aws.com/content/3DbBI7LQgNIcs6UUj7IPPvqFHOp/aws-kiro-the-agentic-ide-that-makes-specs-the-unit-of-work · https://kiro.dev/
- **Agent Hooks**：文件保存等事件自动触发 agent 动作（如保存代码自动更新测试）。
  来源：https://www.heyuan110.com/posts/ai/2026-03-10-kiro-review/
- **Steering files**：`.kiro/steering/` 下的 markdown 指导 agent 行为，可对已有项目自动生成 steering 文档。
  来源：https://yehudacohen.substack.com/p/developing-with-kiro-amazons-new
- **Powers**：新特性，让 AI agent 更快更易用的能力包（细节未核实）。
  来源：https://www.reddit.com/r/kiroIDE/comments/1r8mdj9/im_confused_what_kiros_advantage_is/

### 9. Amp（Sourcegraph）

- **Oracle**：用更强（更贵）的模型对代码改动做二次评审的子 agent。
  来源：https://ampcode.com/
- **Remote Orbs**：工作跑在远程机器上，终端/编辑器只是前端；BYO 推理。
  来源：https://sourcegraph.com/blog/ai-developer-tools · https://aiidelist.com/ide/amp-code
- 无模型选择键（官方代选最优）、200K 上下文、编辑自动应用、CLI + devcontainer + 内置 MCP。
  来源：https://www.reddit.com/r/cursor/comments/1kpin6e/tried_amp_sourcegraphs_new_ai_coding_agent_heres/

### 10. Zed

- **Agent Panel / Agentic Editing**：编辑器内嵌 agent，以编辑器速度编辑文件、导航代码、跑工具；开源、模型/agent 可换（ACP 协议接 Claude Code 等外部 agent）。
  来源：https://zed.dev/ai · https://zed.dev/blog/fastest-ai-code-editor · https://zed.dev/docs/ai/overview
- **Edit prediction**（Zeta）：编辑预测补全。
  来源：https://github.com/zed-industries/zed/discussions/30700
- 官方态度文《On Programming with Agents》：只用 agent 做你自己会做的任务、保持在 loop 里、仔细 review——把「人机协作纪律」当产品哲学写进博客。
  来源：https://zed.dev/blog/on-programming-with-agents

### 11. OpenCode

- 开源、provider 无关（任意模型）、TUI + 桌面 App + IDE 扩展三形态；**事件溯源（event-sourced）会话**；TUI「Mission Control」；自定义 agent 可在 TUI `/agents` 里创建/编辑/删除，带权限、名字、颜色配置；可编程 SDK。
  来源：https://opencode.ai/docs/ · https://sanj.dev/post/opencode-deep-dive-2026/ · https://github.com/anomalyco/opencode/issues/20130

### 12. Aider

- **Watch files 模式**：`aider --watch-files` 监视源码文件，在任意文件里写 `// AI! xxx` 让 aider 执行指令、`// AI? xxx` 提问——「注释即指令」，把指令留在代码上下文里。
  来源：https://github.com/Aider-AI/aider/blob/main/aider/website/HISTORY.md
- `/voice` 语音输入（可编辑转写文本再发送）；`--copy-paste` 模式配合 LLM 网页聊天 UI 使用（复制上下文到剪贴板）。
  来源：https://github.com/Aider-AI/aider/blob/main/aider/website/HISTORY.md
- 每个版本标注「Aider wrote N% of the code in this release」——自我托管程度公开透明。
  来源：https://github.com/Aider-AI/aider/blob/main/aider/website/HISTORY.md

### 13. Warp

- **Warp 2.0 = Agentic Development Environment**：终端 + Code + 多 agent 管理 + 人机协作四合一；可跑内建 Warp Agent，也可接入外部 CLI agent（Claude Code、Codex、Gemini CLI 等）统一管理；企业向的集中配置 agent 访问与权限护栏；workflows/runbooks 团队复用。
  来源：https://www.warp.dev/blog/reimagining-coding-agentic-development-environment · https://www.warp.dev/terminal · https://github.com/warpdotdev/warp · https://blog.sandbase.ai/warp-agentic-terminal-explained-2026/

### 14. Factory Droid

- **多形态同一 agent**：Droid 跑在 CLI、IDE、Web、Slack/Teams、Linear/Jira、Mobile 上；**coordinator agent** 分解工作并派发给专门 droid（code / review / docs / test / knowledge）；headless CI 与浏览器自动化；Droid SDK。
  来源：https://factory.com/ · https://github.com/factory-ai/factory · https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review · https://www.developersdigest.tech/blog/factory-droid-review-setup-2026

---

## 二、对照 pi-toolkit：三分类

### ① pi-toolkit 已有（或基本等价）

| 调研到的功能                                                   | pi-toolkit 对应                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code 背景任务 / `claude agents` / agent view            | `Agent` 工具 background-only + fleet widget（agent tree）+ `get_subagent_result`/`steer_subagent`/`abort_subagent` |
| Subagents / 子代理模型与 effort 配置                           | Agent tool 的 `model`/`thinking`、agent type frontmatter；workflow `agent()` 的 per-call model/thinking override   |
| 多 agent 编排 / coordinator（Factory、Warp、Antigravity）      | `SubagentWorkflow` 编排引擎 + journal/replay                                                                       |
| Skills / Agent Skills                                          | `skills/`（dev-flow、agent-handoff），pi 原生 `pi.skills`                                                          |
| 定时触发 agent（Antigravity Scheduled Tasks、Claude Routines） | `src/schedule/` cron 调度器                                                                                        |
| Kiro spec 驱动                                                 | dev-spec-dev skill（SDD 两阶段流程）                                                                               |
| Steering files / Memories                                      | `src/memory/` cwd-keyed 项目记忆 + tiered 注入 + AGENTS.md                                                         |
| Web UI / Codex app / Cursor cloud 会话管理                     | `src/web-hub/`（浏览器 UI + managed spawn + resume + 预览面板群）                                                  |
| 移动端权限审批推送（Claude Code mobile push）                  | feishu-notify + feishuBot（ask_user 卡片双通道作答）                                                               |
| Codex steering（运行中纠正）                                   | `steer_subagent` + 主会话 input                                                                                    |
| Codex 消息排队                                                 | fabric mailbox / `message_agent` park + successor coalescing                                                       |
| Windsurf worktrees 并行会话                                    | workflow `isolation:"worktree"` + Agent 工具 worktree 隔离（H2/H3）                                                |
| Amp Oracle（强模型复核）                                       | `consult` 专家咨询（含 `"main"` 保留专家）                                                                         |
| Amp handoff / agent 间交接                                     | agent-handoff skill + consult + fabric `message_agent`                                                             |
| Copilot coding agent 云端跑任务                                | web-hub managed spawn（`pi --mode rpc` 子进程）+ restore/relaunch                                                  |
| OpenCode 自定义 agent（权限/颜色）                             | `src/config/` agent-type registry（frontmatter 定义工具域/can_message）                                            |
| Statusline                                                     | `src/hud/` 完整 footer（git/token/成本/速度）                                                                      |
| Cursor 内置浏览器元素检查                                      | deveye skill（浏览器调试）——非 pi-toolkit 本体但生态已有                                                           |
| Cursor subagent 级联停止                                       | reaper + run tree 管理（孤儿回收）                                                                                 |
| Zed「review 纪律」哲学                                         | dev-flow 的 verifier 闸门（验收模型 ≠ 开发模型）                                                                   |

### ② pi-toolkit 没有、值得借鉴

1. **文件级 checkpoint + /rewind（Claude Code）**：每次 write/edit 前自动快照，可按对话点回滚「代码、对话或两者」。价值：无人值守长任务的最大安全网，比 git 更细（无需 commit）、比会话树更直接。落地思路：pi 已有会话树/分支概念，pi-toolkit 可加 `src/checkpoint/`——在 `tool_call`（write/edit）前把工作区受影响文件快照进 `<sessionDir>/checkpoints/<id>/`（hardlink 池省空间），`/rewind` 列出检查点（对齐消息序号）并恢复文件 + fork 会话到该点。工作量 **M**。
2. **OS 级命令沙箱 + 网络白名单（Claude Code `/sandbox`）**：bash 命令在 bubblewrap/seatbelt 里跑，网络访问逐主机批准。价值：配合 pi-toolkit 的后台无人值守（cron、/goal loop、workflow）把「敢放手」推到新高度；现有 secure vault 管的是数据加密，不管执行隔离，两者互补。落地：bash 工具外层包 `bwrap`（Linux），设置项 `sandbox.enabled` + 允许主机列表，被拒时走 ask_user/web 批准。工作量 **M**（Linux-only 先行）。
3. **用户自定义 hooks 系统（Claude Code hooks / Windsurf Cascade Hooks / Kiro Agent Hooks）**：设置文件里配 shell 命令挂在工具事件上（PreToolUse/PostToolUse/Notification…），支持 `onFailure:"block"`。价值：pi-toolkit 内部大量用 pi 事件钩子，但用户没有无需写 TS 扩展的自定义入口；hooks 是个人自动化与企业合规（审计日志、强制 lint）的最低成本接口。落地：`hooks.json` 配置 → 在 `tool_call`/`session` 事件上 spawn 命令（带 JSON stdin），同步阻塞类钩子加 deadline。工作量 **S-M**。
4. **Bugbot 式自动 PR 评审 + 规则文件 + Autofix（Cursor）**：push 后自动评审 PR，`BUGBOT.md` 沉淀团队规则，可从已合并 PR 学习，增量评审，Autofix 一键修。价值：pi-toolkit 已有 review-* skills 和 fix-pr-comments skill，缺的是「无人值守自动跑 + 规则文件持续学习」这一层；与 cron + web-hub spawn 组合正好。落地：`/review-bot watch <repo>` → cron 轮询 `gh pr list` → worktree 隔离派发 review agent（读 `REVIEW.md` 规则）→ `gh pr comment`。工作量 **M**。
5. **Copilot Spaces 式命名上下文包**：把代码/文档/网页整理成命名、可复用、可共享的上下文包。价值：pi-toolkit 的 memory 是单项目持久记忆，Spaces 是「按需 attach 的主题上下文」；对应到 pi 就是可命名、可在会话/子代理派发时引用的 context bundle。落地：`memory` 旁加 `bundle` 概念（一组文件/文本的清单），Agent 派发时 `context:["bundle:api-design"]` 注入提示词；web-hub 上可视化编辑。工作量 **M**。
6. **Aider watch-files（注释即指令）**：`// AI! 把这个函数改成…` 写在代码里自动触发 agent。价值：零切换成本的「就地派单」，与 pi-toolkit 后台派发天然契合（触发后自动 spawn 后台 run，结果以 Feishu/web 通知回来）。落地：一个 fs watcher（bash 后台 job 或 pi 服务）扫描 diff 里的触发注释 → 构造 prompt spawn Agent。工作量 **S**。
7. **远程执行环境（Amp Orbs / Cursor BYO 硬件 / Copilot coding agent 云沙箱）**：agent 跑在远程机器/容器里，本地只是控制面。价值：pi-toolkit 的 web-hub managed spawn 已是本机版；远程化后可让重负载任务不占本机、并在沙箱里跑不可信代码。落地：spawn 层加 SSH/容器 target（bunker 沙盒平台可作为后端之一）。工作量 **L**。
8. **插件市场 + 安全扫描（Claude Code plugins/marketplace）**：目录、评审、用量分析、恶意内容扫描。价值：pi 已有 `pi install git:`，缺目录与信任层；对 pi-toolkit 而言更现实的是先做「本地已装扩展清单 + 版本/权限审计」而非真市场。工作量 **L**（市场）/ **S**（本地审计 `/agent extensions`）。
9. **agent 写记忆的人工批准流（Cursor Memories approvals）**：后台自动生成的记忆需用户批准才生效。价值：pi-toolkit 的 agent 写 memory 已带 `source: agent` 溯源，再加「pending 批准」状态可防止 agent 自我强化错误认知。落地：memory 写入增加 `status: pending`，`/mem approve` 确认，HUD 提示待批数。工作量 **S**。
10. **从现有代码库自动生成 steering/memory 初稿（Kiro steering 生成）**：分析仓库自动生成指导文档。价值：降低新仓库上手成本，与 `/mem init`（目前只生成骨架）互补。落地：派发一个只读探索 run → 产出 core.md/topics 初稿 → 走第 9 条的批准流。工作量 **S**。
11. **Output styles（Claude Code）**：一键切换 agent 角色/语气/输出格式。价值：对「用 pi 做非编码工作」（写作、调研）有轻量价值。落地：system prompt 预设包 + `/style` 命令切换（prompt-sections 机制已现成）。工作量 **S**。

### ③ 有趣但不适合 pi-toolkit

- **Tab 补全 / 编辑预测（Cursor Tab、Zed Zeta）**：pi 是终端 agent 不是编辑器，无补全载体；属于编辑器内核功能。
- **Voice 语音输入（Windsurf/Aider）**：终端 SSH/服务器场景价值低，引入音频依赖与隐私面，ROI 差。
- **企业组织级 skills/插件管理控制台（Claude Team/Enterprise、Copilot 治理）**：pi-toolkit 是个人/小团队工具，管理控制台超出定位。
- **Claude Duet 主动型 agent**：理念与 pi-toolkit 现有「topic-switch 建议新会话、闸门由人确认」的人机分工哲学相反，且产品形态模糊。
- **Cursor 内置浏览器**：编辑器集成组件；pi-toolkit 场景已由 deveye skill 覆盖。
- **Grok Build 开源 Rust TUI 本身**：pi 已是 TUI，无需再造；其「开源 harness」思路 pi 已满足（pi/pi-toolkit 均开源）。
- **Warp 四合一 IDE 化**：pi 走扩展化终端路线，不做 IDE。

---

## 三、最值得做的 Top 10（排序）

按「对 pi-toolkit 核心叙事（零悬挂后台 agent + 多面控制 + 成本/缓存治理）的增益 × 落地成本」排序：

1. **文件级 checkpoint + /rewind（M）**——无人值守时代的第一安全网；与 pi 会话树正交互补，用户痛点最高频。
2. **bash 命令沙箱 + 网络白名单（M）**——让 cron/workflow//goal 的放手运行有执行级护栏；与 secure vault 互补成「数据 + 执行」双层安全故事。
3. **用户 hooks 系统（S-M）**——最低成本的自动化/合规扩展点；Claude Code、Windsurf、Kiro 三家都押注，说明是行业共识。
4. **PR review bot + REVIEW.md 规则 + 学习（M）**——把现有 review skills 串成无人值守闭环，cron + worktree + spawn 全是现成积木。
5. **命名上下文包（Spaces 式）（M）**——补齐 memory（持久、被动注入）与单次 prompt（一次性）之间的空档；对 Agent 派发质量提升直接。
6. **agent 写记忆的人工批准流（S）**——便宜且直接保护记忆质量，防 agent 错误自我强化。
7. **watch-files 注释即指令（S）**——小而美的差异化交互，「在代码里留言给 agent」很契合后台派发叙事。
8. **从代码库自动生成 steering/memory 初稿（S）**——降低新仓库接入成本，与 #6 批准流联动即成完整 onboarding。
9. **插件/扩展本地审计清单（S，市场 L 先不做）**——`/agent extensions` 列已装扩展、来源、版本、文件完整性；先做信任可见性，市场以后再说。
10. **远程执行环境（L）**——战略方向（云端/容器跑重任务），但工程量大、依赖外部平台，排在最后作为 2027 路线候选。

候选落选说明：Output styles（S）有趣但与 pi-toolkit 编码主线关联弱；完整插件市场（L）属生态工程，宜等 pi 官方方向明确。

---

## 附：主要来源索引

- Claude Code 官方发布说明：https://support.claude.com/en/articles/12138966-release-notes · https://releases.sh/anthropic/claude-code · CHANGELOG https://t.co/2urqPZDABy
- Claude Code 文档镜像（checkpointing/agent-view/output-styles/web）：https://bacol.todayz.workers.dev/post-https-code.claude.com/docs/en/checkpointing · https://github.com/thevibeworks/claude-code-docs/blob/main/content/en/docs/claude-code/agent-view.md · https://code.claude.com/docs/en/output-styles · https://code.claude.com/docs/en/claude-code-on-the-web · https://code.claude.com/docs/en/whats-new
- Grok Build：https://docs.x.ai/build/overview · https://x.ai/news/grok-build-open-source · https://github.com/xai-org/grok-build
- Codex：https://openai.com/index/introducing-the-codex-app/ · https://openai.com/index/introducing-upgrades-to-codex/ · https://releasebot.io/updates/openai/codex · https://learn.chatgpt.com/docs/changelog
- Cursor：https://prod.cursor.com/docs/release-notes · https://prod.cursor.com/changelog/1-0 · https://prod.cursor.com/changelog/1-2 · https://cursor.com/help/ai-features/tab
- Windsurf：https://changelogs.directory/tools/windsurf?showPrereleases=false · https://releasebot.io/updates/windsurf
- Antigravity/Gemini CLI：https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ · https://antigravity.google/blog/introducing-google-antigravity-2/ · https://github.com/google-gemini/gemini-cli
- Copilot：https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/ · https://github.com/orgs/community/discussions/160840
- Kiro：https://kiro.dev/docs/specs/ · https://builder.aws.com/content/3DbBI7LQgNIcs6UUj7IPPvqFHOp/aws-kiro-the-agentic-ide-that-makes-specs-the-unit-of-work
- Amp：https://ampcode.com/ · https://sourcegraph.com/blog/ai-developer-tools
- Zed：https://zed.dev/ai · https://zed.dev/docs/ai/overview · https://zed.dev/blog/on-programming-with-agents
- OpenCode：https://opencode.ai/docs/ · https://sanj.dev/post/opencode-deep-dive-2026/
- Aider：https://github.com/Aider-AI/aider/blob/main/aider/website/HISTORY.md
- Warp：https://www.warp.dev/blog/reimagining-coding-agentic-development-environment · https://github.com/warpdotdev/warp
- Factory：https://factory.com/ · https://github.com/factory-ai/factory
