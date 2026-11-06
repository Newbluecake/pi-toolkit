# pi 1.5.0 适配与最低支持基线（实施记录）

## 当前合同与执行状态（2026-11-07，覆盖下方历史 G0/G1）

**用户已在 ask_user 选择“整个项目最低 1.5”**：三包
`@earendil-works/{pi-ai,pi-coding-agent,pi-tui}` 的 peer 同步为 `>=1.5.0 <1.6.0`，
optional 保留，开发依赖精确 `1.5.0`；**不再支持 1.0–1.4，属于 Breaking Change**。
`SUPPORTED_PI_RANGE={min:"1.5.0",maxExclusive:"1.6.0"}` 与 peer 同源；
`TESTED_PI_RANGE="1.5.0 - 1.5.0"` 只声明实测单点，1.5.1 即使允许安装仍 warning。
版本提示仍不替代结构能力门，不清理旧 shim、不加按版本切功能分支、不改 ABI/schema。
本包不改 Toolkit 版本号/CHANGELOG，不发版、commit、push，不修改主 checkout 的依赖或 global，
不 reload/重启活跃进程；主树依赖此前仍 1.4、global CLI 由用户自行升至 1.5，
**运行中实际 loaded SDK 未知**，不能从 CLI 版本推断。

旧 G0 的“必须保留 >=1.0 floor”、六版重跑和旧 SDK 红阻断支持承诺已被这次用户决定覆盖，
不再重复 6×33 矩阵，也不把旧 1.0/1.1 已知失败冒充修复。Node/CI 策略不顺便调整：
SDK 1.4/1.5 都要求 >=22.19，当前 Node 22.22.1 满足；已有 lock 的
nopt 10.0.1 / abbrev 5.0.0 另有 >=22.22.2 分支 engine 告警，版本未变，非本次新增。

### 已合入与已验证证据（与本轮支持声明分开）

- `4b065925`：四处显式 `tiers | undefined` 的 **type-only** 边界兼容，runtime JS 未变。
- `16289441`：measure managed-effort 的 **结构兼容修复**，stock 1.5 顶层 low 与 1.4 high
  均只在完整合法结构接受；尾部 high/防滥用拒绝仍保留，不是版本分支。
- `/tmp/rh45e-h16x/report.md`：真实 SDK/CLI 1.5，实验仅扩上界（min 仍 1.0），
  RH1–RH4 从 4×503 到 4 pass；独立 RH4 + measure25 + unknownslash7 为 **36 pass**。
  这些旧实验没有验证新 min1.5 边界，本轮另增 launcher 的旧版本拒绝/1.5 patch 接受边界。
- `/tmp/45-current-conformance-handoff.json`：真实 1.5 **private-safe34**，353 pass / 4 skip / 1 todo，
  base `a8fc1dac`；Sonnet 已独立验 safe34。第二次合规复验拥有真实私有依赖目录，
  32,460 regular files 等 hash/不同 inode、共享目录前后无变化。**第一次 symlink 依赖导致
  nested Vitest 写共享 `.vite/vitest/results.json`，不合规，未追认**；只保留其测试结果作为历史，
  不能用它代替第二次隔离证明。skip 为 legacy 三条与未授权 classifier 一条；todo C-R6 引用同组已跑 S5。
- `2f65ea9b` Fast P0：公开 SessionManager 七场景；1.4 复现 ghost 是不安全 characterization，
  1.5 回滚通过。`80af9ca3` 已合 Fast P4a 共享合同。P1/P2 仍各自拥有实现/README，
  本包仅同步 baseline/V4，不抢 Fast 或 Workflow 代码。

### 本轮隔离实现与验证边界

实施 BASE：`80af9ca30ab534db190f8754f577b71c32fc2cd3`；独立 worktree
`/tmp/pi-subagent-worktrees/r_PR3JHW01`，原无 node_modules。安装采用本 worktree 新建真实私有目录，
`env -i` 的 HOME / agentDir / XDG / npm cache / tmp / npm userconfig/globalconfig 全在
`/tmp/b15-PR3J/`；固定官方 npm 包，`--ignore-scripts --save-dev --save-exact --no-audit --no-fund`，
无 npm update/audit fix/legacy-peer-deps，也未复制旧依赖树冒充安装。
新用户授权覆盖旧 registry 策略：**仅必要 1.5 闭包采用 npmjs 官方固定包**，保留原 mixed registry，
相同 version/integrity 的 11 处 incidental resolved URL 改写已恢复。最终用新 lock
`npm ci --ignore-scripts` 重建自有真实目录验证，不开启 postinstall。

本包门禁为精确 version/launcher/peer/docs、Faststorage7、measure25、unknownslash7，
以及 typecheck/build/format；真实命令、退出码、SDK/lock integrity、owned hash 与 patch 统计交付在
`/tmp/pi45-baseline15-handoff.json`，日志 `/tmp/b15-PR3J/`。不另跑 safe34/全 T1/全 Tier2/secure/live。
**集成主会话仍需在主线同步 npm ci 并执行最终全门**；本轮定向绿不代表全量/外部授权门完成。
classifier / droid / secure 挂载 / 付费模型 / 真实 memory 均未授权、未执行。
#36 旧快照的 node_modules 链接仍指主 1.4，root 主依赖切 1.5 前须将原 runtime provenance 标过时并
重冻 current；本包不动 baseline/PG 快照或数据。

本轮自验：七个精确测试文件 **167/167 pass**（含 Faststorage7 / measure25 / unknownslash7），
`npm run typecheck`、`npm run build`、`npm run format:check` 均通过。
格式全树只读检查第一次 120s 超时，增加到 360s 后通过，未全树格式化；
AGENTS 原基线缺 `src/fast/` layout 行导致 K9 初跑失败，已补唯一行并引用基线中已存在的 Fast README。
fixtures 对实施 BASE 零差异；对 origin/dev 既有差异仍非零，不归为本包改动。

Fast V4 新结论：旧 1.4 已退出支持，无需新增旧宿主临时 IO 能力探针或兼容兜底。
1.5 七场景 P0 仅证明 SDK 回滚前提；controller 的最后成功状态、storage-fault、seed 初始化失败
零 prompt 与清理仍需生产集成验证。全部 Responses / native warm follows / 默认 enabled 用户决定不变。

## 历史调研快照（2026-11-06，非当前支持合同）

> 下方原方案/门禁/“未实施”/peer floor/registry 及现场版本均为当时记录，保留用于审计，
> 不再作为当前执行指令；冲突一律以上方 2026-11-07 新用户决定与范围为准。

2026-11-06 · L2 调研 / L3 条件升级 · **方案修订；隔离适配验证已获用户授权，尚未实施、未通过兼容验收，未批准 live 升级**。

## 一页摘要

- **建议目标：1.5.0 stable**。截至 **2026-11-06 17:28:40 +08:00**，官方 npm 三包 `latest=1.5.0`，GitHub `/releases/latest` 同为 `v1.5.0`，`draft=false / prerelease=false`。agent npm 发布时间为 `2026-11-02T11:05:09.564Z`，Release 发布时间为 `2026-11-02T11:05:31Z`。不是根据记忆或版本号猜测。
- **真实基线：global pi=1.4.0；项目实际 pi-ai / pi-coding-agent / pi-tui 均 1.4.0**。声明 dev 为 `^1.4.0`，peer 为 `>=1.0.0 <1.5.0`，所以 **1.5.0 当前不在支持范围**。`^1.4.0` 又可能在重解锁时拉到 1.5，不能把“没改 package 声明”视为没升级。
- **主要风险是工具参数验证契约，不是 slash 新特性**：宿主从 TypeBox validator 转为 `pi-schema`，改变 coercion / 错误文本；pi-ai root 移除 TypeBox 导出，extension loader 仍提供兼容映射；SDK 与 jiti 路径必须分开验证。未发现本仓源码直接调用已移除的 Refine / BigInt / Undefined / Void / Codec / Format.Set；这只是静态缩小风险，不是兼容证明。
- **#40 不被 1.5 自动实现或取代**：tag 源码仍为 extension command → input → skill/template → run；未知命令继续普通文本，已知 handler 错误仍 handled，TUI 仍提前 trim。Web / 飞书默认启用修复仍归 #40：Web 依靠 optional feature token 可信门，仅权威 `E_UNKNOWN_COMMAND` + `effect:none` 触发一次 A→B；不能混入本适配包。需要在两个宿主版本固定正文、次数、source、错误零 fallback 的行为证据。
- **最小实施预计**：先新增 conformance，再在独立依赖环境核验，必要时只改 compat shim；全部门禁通过后才修改 peer / dev / lock 与支持文档。不批量迁移 TypeBox、不启用新宿主功能、不动 #36P5a/P6b memory 或同树 UI 工作。
- **保护现场**：本阶段只有本文和 `/tmp/pi-version-adaptation-research/` 调研日志；没有 install/update、全局升级、reload、源码/依赖/lock 改动、git 写操作、构建或测试。后续应使用 `/tmp` **独立 clone 内的 worktree + 各自真实 node_modules**，不得链接主树 node_modules。
- **评审与授权状态**：GLM `r_1QK6GGTT` 首轮评审已发生、结论有条件通过；本稿按 root 转交的七项要求修订（未取得评审全文，不新增评审）。用户已通过 ask_user 批准 BASE 固定 `efa12f26` 的 `/tmp` 隔离适配验证，保留旧 peer 策略、新失败先报；root 核对本稿闭合后派实施。本 run 仍只改文档/补证，不安装。未闭合的是目标发布包实测、真实 classifier / droid / secure 门禁与集成/live 切换，不是项目缺少评审或交互能力。

## 1. 范围、级别与冻结现场

需求：同步推进 pi 新版本适配，但先调研与方案；保持正在开发验收的 #36P5a/P6b memory 和同树 UI 不变。此阶段允许写入的仓库路径仅本文；日志与官方材料快照仅在 `/tmp/pi-version-adaptation-research/`。不得 git add/commit/stash/reset/checkout/worktree、npm install/update、升级 global pi、reload，或向共享 node_modules 写入。

按实施风险定 **L2 起步**：多文件 2 + 跨边界 1 + 外部接口契约 1 + 范围策略取舍 1 + 可回滚依赖写路径 1 = 6。若须改变输入链、boundary 提交、tool validation 的安全语义或跨多个源码域补丁，则升级 **L3**：前置架构复审、独立 review 与重新确认；禁止以扩大 peer 范围掩盖接口破坏。本 run 只交付修订文档与证据，不代 root 进入已授权的隔离实施。后续授权仅限 `/tmp` 独立 clone/worktrees、独立真实 node_modules、实验安装/添加测试/必要最小兼容 shim；不动主树安装、global、reload、真实 memory、真实凭证或挂载。

初次记录 HEAD：`c7bf1afe0377bfc52c2f49c33113630dec40ce81`（仅调研现场，不是实施 BASE）。`git status --short` 已有 memory / UI 修改与新增测试、`docs/dev/unknown-slash-text/`、`docs/dev/activity-rail/`；它们属于其他任务。并发工作可能继续变化，不能将最终 status 的一切新增变化归本任务，也不能用全树 reset“恢复现场”。

**已批准 immutable 实验 BASE**：`efa12f261496d0cf2ca1d1f8d320912409ada89c`（只读 `git rev-parse efa12f26` 核实）；不得包含 dirty memory/UI，不从当前 HEAD 或工作树漂移取材。#40 后续落地与并发任务另按精确集成提交复验，不能暗换 BASE。

**frozen 现状并非全绿**：只读执行 `git diff --quiet origin/dev -- tests/fixtures/` 返回 **1**。现有差异包括 `memory-tool-surface.json` 与新增 `memory/{blocks-golden,doctor-golden,migrate-golden}` 文件。不得重生或撤销；实施前由集成方确认所属任务与已接受基线。`protected-baseline.json` 记录调研时 package / lock / compat / fixtures 文件 SHA-256，仅作并发归因辅助，不是上游 golden 的替代品。

## 2. 真实版本与外部证据

| 项                  | 已核实事实                                                                                 | 证据                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局 CLI            | `pi --version` 为 `1.4.0`                                                                  | `command -v pi` → `/home/bluecake/.nvm/versions/node/v22.22.1/bin/pi`；realpath → 同 prefix 的 `lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`                                                              |
| 本地开发依赖        | 三包 package.json `version=1.4.0`；lock 也锁 1.4.0                                         | `node_modules/@earendil-works/{pi-ai,pi-coding-agent,pi-tui}/package.json`，根 package / lock                                                                                                                                     |
| peer / tested       | 三包 `>=1.0.0 <1.5.0`；`TESTED_PI_RANGE="1.0.0 - 1.4.0"`                                   | `package.json`；`src/adapters/pi-compat.ts`；`tests/adapters/pi-compat.test.ts` 明确将 1.5 列为 warning                                                                                                                           |
| 运行环境            | Node `v22.22.1`，npm `10.9.4`                                                              | 只读版本命令                                                                                                                                                                                                                      |
| 官方 npm 最新       | 三包 `latest=1.5.0`；仅另有 `legacy-node20=0.74.2` tag；查询的 time keys 无预发布版本      | 显式 `npm --registry=https://registry.npmjs.org --cache /tmp/pi-version-adaptation-research/npm-cache view … dist-tags time --json`                                                                                               |
| 官方 stable Release | `v1.5.0`，非 draft、非 prerelease                                                          | [Release](https://github.com/earendil-works/pi/releases/tag/v1.5.0)、[latest API](https://api.github.com/repos/earendil-works/pi/releases/latest)、[tag API](https://api.github.com/repos/earendil-works/pi/releases/tags/v1.5.0) |
| 发布依赖链          | agent 1.5.0 精确依赖 ai / tui / agent-core / codemode / mcp 1.5.0；ai 依赖 pi-schema 1.5.0 | 官方 npm 版本 metadata；日志 `official-*-1.5.0.json`                                                                                                                                                                              |
| engine              | 三包 **1.4.0 与 1.5.0 均**要求 Node `>=22.19.0`                                            | 官方两版本 metadata（`official-*-1.{4,5}.0.json`）；本机满足。这是既有下限，不是 1.5 新增风险；仓库 Node/CI 口径实验见下文，不全面抬 Node                                                                                         |

官方 registry URLs：

- <https://registry.npmjs.org/@earendil-works%2fpi-coding-agent>
- <https://registry.npmjs.org/@earendil-works%2fpi-ai>
- <https://registry.npmjs.org/@earendil-works%2fpi-tui>

先前默认 registry 查询仅作交叉证据；**最新判定以显式 npmjs.org 查询 + 官方 Release 为准**，不依赖 lock 中 npmmirror URL。后续执行前再次核验标签与 integrity；若出现新 stable，应增补差分方案，不静默改变本方案目标。Release API 的 `immutable=false`，故保留材料内容 hash，不能只依赖可移动的 tag。

### 官方阅读与证据范围

已完整阅读本机全局安装包 `README.md`、`docs/extensions.md`、`docs/sdk.md`，以及本任务选取的引用文档 `docs/{slash-commands,prompt-templates,skills,session-format,compaction,rpc-commands,models}.md`。README / SDK / models 与取回的 v1.5.0 对应文件字节一致；extensions 不同，已另完整读 v1.5.0 的 **3347 行**版本，不能将旧简版当作完整新版 API 参考。

Changelog 已补齐完整阅读：本机 agent **6365 行**（包括历史归档），官方 v1.5.0 的 ai **2443 行**、agent-core **798 行**、tui **1326 行**。官方 agent 的 1.5.0 段已完整读；其从 `## [1.4.0]` 起的全部历史尾段经逐字节比较与已完整读的本机 agent 相同，因此官方 agent 全文也已覆盖。分析重点仍为 1.4.0 → 1.5.0；两个 release 段的完整摘录保存在 `/tmp/pi-version-adaptation-research/*-related-release-notes.md`。历史内容用于识别原有契约，未把历史 breaking changes 错算为本次新变化。

官方固定版本入口（以下路径均基于 `v1.5.0`，不以 main 的漂移内容证明目标版本）：

- [agent CHANGELOG](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md)
- [ai CHANGELOG / JSON Schema 迁移示例](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md)
- [agent-core CHANGELOG / AgentTool 泛型](https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/CHANGELOG.md)
- [tui CHANGELOG](https://github.com/earendil-works/pi/blob/v1.5.0/packages/tui/CHANGELOG.md)
- [extensions / tool parameter schemas](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md#tool-parameter-schemas-and-typebox)
- [SDK](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md)、[models / classifier](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/models.md#use-classifier-models)、[slash commands](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/slash-commands.md)
- [AgentSession](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/agent-session.ts)、[extension loader](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/extensions/loader.ts)、[types](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/extensions/types.ts)、[runner](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/extensions/runner.ts)
- [interactive input](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/modes/interactive/interactive-mode.ts)、[ModelRuntime](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/model-runtime.ts)

GitHub raw curl 一次未成功，后改用官方 contents API。先前超时的两项现已补齐并完整阅读；新增选读的官方 v1.5 `docs/{rpc,rpc-commands,rpc-extension-ui}.md` 也已完整阅读。每份内容均从 contents API `?ref=v1.5.0` base64 解码，验证字节数及 `SHA1("blob " + size + NUL + bytes) == API sha`，独立记录 SHA-256：

| v1.5 官方路径（`packages/coding-agent/` 下） | bytes | Git blob SHA-1                             | SHA-256                                                            |
| -------------------------------------------- | ----- | ------------------------------------------ | ------------------------------------------------------------------ |
| `src/modes/rpc/rpc-mode.ts`                  | 24168 | `1c0995d36ec752155f1d13b019728f9343bb263c` | `d534e0fa1484844a097963d5f4fb4df9397c5a1b5e29e42aed7575ab6f67989b` |
| `src/core/tools/index.ts`                    | 6784  | `5e8fd5b36912371c1e54878356bf40356d619aeb` | `3c66ea1e03530fb85436ee639f35add8bf72718ac6e76b738a1f41be58a2b472` |
| `docs/rpc.md`                                | 8897  | `a39cc8da25c17e8d41af35bd32ac0bef5604b1b4` | `37a03d180115460a0a275022f4aeabef1e5345458df6a9b6e8a6de18474de720` |

快照在 `/tmp/pi-version-adaptation-research/packages__coding-agent__{src__modes__rpc__rpc-mode.ts,src__core__tools__index.ts,docs__rpc.md,docs__rpc-commands.md,docs__rpc-extension-ui.md}`，各相邻 `.evidence.json` 保存精确 API URL/ref、blob sha、size、SHA-256。G1 开始前必须验证这些材料仍完整、相关所选文档已读；取不到/核验失败即 **BLOCKED**，不得先实施再补证。官方 tag 源码证据不等同 npm 发布包运行验证。

新增阅读结论：RPC `prompt` 显式传 `source:"rpc"`，preflight 后才发 acceptance response；`handled` 不承诺 agent_settled，不能把 response 当模型结束。`get_commands` 收录 invocationName/template/skill 而不含 TUI-only builtin；JSONL 使用 LF/CRLF，不能按 Unicode 分隔符拆帧。工具 index 分开导出 ToolDefinition 与 AgentTool 工厂，coding 与 readonly 集合各自固定；P0 需验证 SDK/jiti 两条路径和集合不扩权，不能据静态导出就宣称类型/执行兼容。RPC UI 的 custom/no-op 限制属宿主接口，不是本方案作者沙盒限制。

已完整读的相关项目 README：`subagent-core`、`context-switch`、`cache-ttl-keepalive`、`sysprompt-stable`、`memory`、`jev-reflex`、`topic-switch`、`web-hub`、`plugin-merge`、`ask-user-async`、`data-encryption`；另完整读 #40 `docs/dev/unknown-slash-text/plan.md`。未遍历无关子系统；未来改动其他域先补对应必读 README。

## 3. 变化风险与本仓兼容落点

| 风险                                     | 官方变化 / 证据                                                                                                                                                                             | 本仓定位与验收要求                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **高：校验与 coercion**                  | pi-schema `compile(...,{coerce:true}).parse()`；required string 的 null、integer 的小数字符串、单值 array、optional null、未解析 ref、错误文本与旧版不同                                    | `src/tools/structured-output-tool.ts:39` 的 `Type.Unsafe` 接受外部 schema；`src/core/json-schema.ts` 的 host 独立再验证仍须保持。必须捕获 execute 实收 DTO / 非法输入零副作用，不能仅测 schema 构造或加载。不得为通过测试放宽 host validator                                                                                                     |
| **高：SDK / loader 类型分界**            | pi-ai published root 不再导出 TypeBox；loader 将 root 映射到 extension view，并保留 `@sinclair/typebox` → `typebox` aliases；AgentTool 的 JSON Schema 参数泛型与常见 TypeBox kinds 推断变化 | 本仓多数工具直接 import `@sinclair/typebox`，common Union / Object / Record 使用较多，扫描未发现直接使用被移除的非 JSON kinds。当前 1.4 agent 本就依赖 `typebox 1.3.27`，**不是本次首次换 TypeBox**。要分别测 plain Node SDK、jiti 文件扩展、主/子会话；Value.Check/Errors 的本地协议校验不等于宿主工具校验                                      |
| **中高：canonical context / compaction** | SDK summary 不再把 stored OAuth 当 explicit apiKey；失败 session append 不再留下仅内存条目；tree summary 排除已 context_edit 内容与失败 assistant                                           | `src/context-switch/{hook,child,capability}.ts`、`src/runtime/session-driver.ts`、`src/adapters/pi-compat.ts`。固定 boundary L0-L3、retain-none、sourceEntry、继续一次、abort 不续跑、写盘失败后的 getBranch/projection/resume 一致性；不删除 runtime 自证                                                                                       |
| **中高：工具顺序 / prompt**              | 相同 active tool 集合重排不再导致 system delta；保留存量顺序、新工具追加；system prompt 收紧                                                                                                | `src/runtime/tool-scope.ts`、`src/sysprompt/{hub,compat,wake-replay}.ts`、`src/cache-ttl/pipeline-ping.ts`。证明授权工具集合不扩大、readonly provenance 不失效、重复重排无多余 delta；新宿主 prompt 变化不得冒充本扩展 off 行为变化而重生 golden                                                                                                 |
| **中：classifier / memory**              | classifier 文档仍 `getAvailableOfType/getModelOfType/classify`；ModelRuntime:816–832 catch→ClassifierResult；OpenCode System One endpoint / catalog / 成本变化                              | `src/memory/jev/{client,contracts,wire}.ts`；client:316 调 `classify(model,{state,questions},{signal,fetch})`，读取 stopReason/answers/usage.cost.total。文档/源码结构未显示必须修改客户端，但不可宣称已运行兼容。C-J7/8/15 真调用验证 auth、proxy fetch、超时/abort、错误分类和价格；C-J16 合并返回通道也必须覆盖。P5a/P6b 未提交内容不进入本包 |
| **中：输入与命令**                       | 新文档强化 command→input→expand 约定；新 key handling / autocomplete PageUp/PageDown 与 Shift+Enter 修复                                                                                    | `src/commands/capture.ts`、`src/web-hub/agent/{slash,builtin-bridge,commands,command-policy}.ts`、`src/reflex/wire.ts`、`src/topic-switch/{wire,filters}.ts`；见下一节。第三方 command 和 TUI-only builtin 不是同一注册表                                                                                                                        |
| **中：usage / stream**                   | `cost.totalFromProvider`、responseModel；partial tool args 改增量解析，raw parser 状态不再留 content block；OpenRouter total 改用实账                                                       | `src/runtime/session-driver.ts` 的事件映射/usage、traffic/keepalive/HUD 投影需回归。新增字段可忽略但不得丢 total；不要用 absent 的 partialJson 等内部字段当 API；quota 与 retry/1308 路径必须保持有界                                                                                                                                            |
| **中：安装 / trust**                     | `-e npm:` 非精确 ref 在启动/reload 可能联网更新；配置包失败改 warning + skip；saved distrust 优先                                                                                           | SDK resource discovery 与 child activation signal 必须验证，包跳过不可被“CLI 活着”掩盖。沙箱只配本地精确路径，不使用 floating `-e`，不读取真实用户包列表，不刷新共享安装                                                                                                                                                                         |
| **低 / 非目标**                          | changelog 提示、selfUpdateCommand、Terra、blocked UI、keyHint 注入                                                                                                                          | 不启用、不新增设置、不改模型默认值或工具 exposure；TUI/ask_user 仅回归。适配不等于顺带采用新功能                                                                                                                                                                                                                                                 |

`pi-compat.ts` 当前 `eventsPresent` 是保守假设；required capability 全部存在只能说明结构通过。I14 约定：版本仅用于 warning，功能必须 structural probe；不能加 `version>=1.5` 的业务分支。只有门禁通过后才能上调 TESTED 声明。

## 4. #40 未知 slash 的影响判断

### 目标版本有直接证据的前提

- 官方 `agent-session.ts:2113–2227`：`expandPromptTemplates` 默认为 true；先调用 `_tryExecuteExtensionCommand`；未知返回 false；之后 input，再 skill/template。命令名只按首个 ASCII 空格拆分，已知 handler throw 后 emitError 并返回 true。
- `agent-session.ts:2448–2475`：`sendUserMessage` 的 `expandPromptTemplates` 默认 false。Web 普通 prompt 使用 false，仍应仅过 input、不得意外执行 slash。
- `extensions/runner.ts:1525–1575`：await input handler，handled 立即短路；transform 将正文/图片传给后续 handler；来源与 streamingBehavior 独立传递。
- `interactive-mode.ts:3261–3448`：提交开头仍 `text=text.trim()`；builtin 分流先于 session.prompt；compacting 时未知消息排队、已知 extension command 可立即执行。严格首尾空白保真仍不能由后置 input hook 补救。
- v1.5 `getCommands` 文档仍排除 TUI-only builtin；重名 extension 使用 invocation suffix。`slash-commands.md` 比本机版本多列 `/mcp`，但 MCP builtin extension 原本就存在，**不能据文档新增一行断言 runtime 新增命令**，须按实际加载资源核验。

### 与 #40 已定裁定同步（#40 正收口，本包不重复评审或实现）

按 #40 当前方案与 root 已定裁定：**默认启用**，不新增关闭设置；沿用 optional `StatusInfo.features` 中精确 token `unknown-slash-text.v1`，不新增 hub/hello cap、字段或 PROTO。只有 control∧webCommands、ctx 有效且本 activation 严格三态分类/bridge/W3 路径已装配才 advertise。Web commands 开启时，名单缺席只是 unresolved，不能作为未知或授权；agent 完整可信分类为 unknown，A 收到终态 **`E_UNKNOWN_COMMAND` 且 `effect:none`** 后才允许一次普通文本 B（缓存原文，`expandPromptTemplates:false`，B 与 A 不同 cmdId）。发送 A/衔接 B 都复核当前 token、identity/session/epoch；token 缺失或消失保守维持旧命令语义/取消衔接。webCommands=false 仍原直接 prompt，不走 A→B/W3。

注册表 unavailable（缺 port、异常、非数组/畸形）返回 `E_UNSUPPORTED` + `effect:none`，绝不伪报 unknown。重复响应不再生 B；A 不明只 query A，B 不明只 query B；刷新丢失关联不自动恢复 fallback。已知坏参数/deny/confirm/handler error/timeout/网络错/effect:unknown 一律不转文本。非法 wire 名不能用正则或 `E_BAD_REQUEST` 当未知，依 #40 W3 严格分类；飞书 bot 已组装时走自身命令名单之外文本逻辑，不借 Web token，也不触发 W3。TUI 接受宿主 trim。这些是 #40 的既定默认行为与可信门，不是 1.5 自动提供的新能力。`safeGetCommands()` 当前把异常变 []，不能在新功能中用 [] 证明未知；名单 400 截断与前端 stale 清单同理。`command-policy.ts` 的 builtin 集合与已加载 extension/template/skill registry 应分别取证，不把未加载 `/mcp` 或一个 builtin 名硬变成可执行授权。

在独立 1.4 / 1.5 环境给 #40 共用 harness 加以下断言：unknown `/foo`、`/foo2`、`/foo\tx`、`/foo\nx`、单 `/`、路径、多行/Unicode、known extension throw、known builtin 坏参数、skill/template 命中/未知、streaming steer/followUp、compaction、suffix collision；断言 user 正文、handler/provider 次数、input source、error 可见与零 fallback。TUI 从真实 InteractiveMode 主循环进入，RPC 从真实子进程进入，不能只直接调用 AgentSession.prompt 代替所有入口。

保持 secure → wake/xs/mention → notify → reflex → topic-switch 的现有拦截顺序及 prefix veto；未知普通文本也允许被安全/input handler 合法 handled，不承诺必定到模型。升级测试不擅自实现飞书 / Web 新路由。#40 当前正由 root 收口；本包只同步既定事实，不重新打开已定产品取舍。

## 5. 最小精确文件域与 peer 策略（隔离实验已授权；正式集成另闸门）

### P0：测试证据包（先行）

可新增：

- `tests/conformance/pi-1.5-validation.test.ts`：真实 AgentSession 工具执行 DTO、coercion、validation failures、普通工具与 StructuredOutput 的 host 二次校验；fake provider 明确捕获执行次数/输入，不调用真实 memory 写路径。
- `tests/conformance/pi-1.5-sdk.test.ts`：SDK / jiti 两入口、child discovery、工具顺序不扩权、boundary / append-failure / projection 可观察行为。
- `tests/conformance/unknown-slash-text.test.ts`：与 #40 所有者协调唯一归属；若已由 #40 添加，则复用不重复写。只钉宿主旧有语义，不实现功能。
- 必要时只在 `tests/tiers.ts` 登记实际新增归属。复用 `tests/conformance/{agent-session-harness,tui-harness}.ts`；不全树重构 harness。

### P1：声明与兼容包（P0 和矩阵证据后）

预计必改 `package.json`、`package-lock.json`、`src/adapters/pi-compat.ts`、`tests/adapters/pi-compat.test.ts`、`AGENTS.md` 中 peer / checklist 当前值、`tests/docs/agents-md.test.ts` 文档契约、本方案。AGENTS checklist 与其 K2/K3 对照断言须同步为 C-J1–C-J16（及实际 C-X 全集），扩充具体 case/range 的真断言，不能只改注释；这些仅列为后续精确文件域，本轮不编辑或运行。新实现细节写相关 subsystem README，不回灌 AGENTS。

- **推荐正式 peer：三包同步 `>=1.0.0 <1.6.0`**，保留 optional peer；只在旧范围回归矩阵 + 1.5 gates 通过后采用。不直接 `^1` / `<2` 预授权未知 minor。
- 独立实验先把三项 dev 精确设 `1.5.0`；正式也建议精确 pin，lock 固化 transitive / integrity，未来更新显式提案。避免 `^1.4.0` 静默跨 minor。保持 host-provided TypeBox peer 与无 runtime dependencies 现状。
- TESTED range 仅在证据通过后精确扩至 `1.0.0 - 1.5.0`；peer `<1.6.0` 是支持策略，允许未来 1.5 patch 安装，不等于这些 patch 已实测。**1.5.1 仍应 warning**（同 1.6/2.0），warning 不阻止安装/不作功能 gate；后续每个 1.5.x patch 先跑本方案差分/conformance/旧矩阵再扩 tested 上界。能力缺失仍拒绝。
- 旧版本矩阵若失败，不偷抬 peer floor、不声明宽区间。重新确认“补 shim 保持旧版本”还是“缩窄/不连续 peer”；未获决定不发包。

**只有实测失败才打开的条件源码域**：`src/runtime/session-driver.ts`、`src/tools/structured-output-tool.ts`、`src/sysprompt/compat.ts`，各配同名 tests。boundary 问题须先复审才准改 `src/context-switch/{hook,child,capability}.ts`。memory client 问题先交 #36 所有者与用户，不在同树覆盖 `src/memory/**`。任何新增 production 路径须列精确文件重新授权，不给 `src/**` 空白授权。

不预计修改 `src/index.ts` 注册顺序、web wire / UI、settings、模型默认目录、secure、quota、bash、fabric、schedule；其门禁失败若确为新宿主兼容问题，应单列失败证据再扩域，不“顺手修”。不批量替换 `@sinclair/typebox` 为 `typebox` / pi-schema，不重生任何 A golden。

## 6. 独立环境方案（用户已授权后续派实施；本 run 均未执行）

**首选：独立 clone 内建立 worktrees**，而非在主仓 `.git/worktrees` 注册，既隔离依赖也避免实施实验写主仓 git 元数据。git clone 从已确认的集成提交取基线，不会包含主树未提交 memory/UI；需测集成 WIP 时，应等其所有者交付提交，不自动 rsync 正在变化的树。

```sh
# root 闭合修订后派实施；本 run 不执行。
BASE=efa12f261496d0cf2ca1d1f8d320912409ada89c
ROOT=$(mktemp -d /tmp/pi-adapt-XXXXXX)
timeout 120s git clone --no-local --no-hardlinks /home/bluecake/ai/pi-toolkit "$ROOT/repo"
timeout 30s git -C "$ROOT/repo" worktree add --detach "$ROOT/pi14" "$BASE"
timeout 30s git -C "$ROOT/repo" worktree add --detach "$ROOT/pi15" "$BASE"
```

每个 worktree 单独创建真实 node_modules、npm cache、HOME、agentDir、TMPDIR、XDG state/cache 与 session 测试目录；**禁止**软链、bind mount、hardlink/reflink 可写共享 node_modules，不继承全局 pi 设置/包目录。安装前检查 `realpath`、`stat`，确认无路径指回主树。

- 1.4 基线：仅在副本 `npm ci --ignore-scripts`，保存 npm ls / lock / versions；已锁 resolved 镜像地址不等于 npmjs source，记录实际来源，不能用 `--registry` 声称所有 lock URL 自动改写。
- 1.5 副本：保留旧 peer 支持策略，仅在副本为目标实验临时调整三项 dev / 必要安装 peer 声明后，定向 `npm install --ignore-scripts --save-dev --save-exact @earendil-works/pi-ai@1.5.0 @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-tui@1.5.0 --registry=https://registry.npmjs.org`，设置各自 npm cache；检查 lock diff 仅必要闭包，无全量 npm update / audit fix / legacy-peer-deps 掩盖冲突。
- 实验 `node_modules/.bin/pi --version` 与 `node` 读取三包实际 version，`npm ls` 核查 agent-core / pi-schema 及重复宿主副本；采集 dist.integrity，禁止拿 PATH 的 global pi 冒充 target。不升级共享 Node/npm。
- 用副本 `node_modules/.bin/{tsx,vitest,pi}`，不要裸 npx 自动下载。对需要 real RPC/TUI 的 harness 确认 child PATH 同样指向该副本。独立 HOME 的 settings 仅登记本地副本的 extension，保留子会话按 settings 发现路径，不以父会话 `-e` 冒充子会话继承。
- 安装过程默认 `--ignore-scripts`；确有原生依赖需要脚本，先列明包/脚本与必要性再确认，禁止在主树补装。启动前关闭自动 fetch、真实 Feishu/schedule/traffic/网络副作用；fake provider 离线 conformance 与真实凭证门禁分开。
- 更老 peer 端点在其他独立副本单独安装/锁定，不能反复覆盖 pi14 / pi15 的 node_modules 造成并行混版。矩阵至少 1.0.0 下界、各 minor 的代表 stable（查询 registry 后定精确版本）、1.4.0、1.5.0；真实行为与对应 typecheck 分开记录。

本次已批准使用独立 clone/worktrees，不另选普通拷贝方案；不复制主树 node_modules / dist / `.pi` / 用户数据，本 run 不执行。

### Registry 与 lock 交付标准

实验允许“原 lock 镜像 URL + 目标包 npmjs URL”的混源，但逐项记录 resolved/integrity/实际来源；`--registry` 不会重写既有 resolved，实验 lock 不能原样冒充正式交付。正式按 root 确认的实际混源/最小 diff 策略：以既有主要 registry **`https://registry.npmmirror.com`** 定向生成必要 pi 闭包，官方 npmjs 只核验版本与 integrity；不得无理由把全 lock 转为 npmjs。当前实际 lock 有 420 个 mirror 与 11 个 npmjs resolved、无仓库 `.npmrc`，不能谎称基线已全单源；原有例外保留并列来源/归因，不借本任务顺带清洗。验收以 BASE→正式 lock 的精确 diff 为准：非必要闭包的 version/resolved/integrity 不变；新增/更新闭包采用既定 registry 并与官方 integrity 对照。root 已确认：必要依赖若仅官方存在，记录具体包/版本、官方 resolved、原因与 integrity 为明确例外；integrity 不一致则先报 root，不擅自切全局 registry、重解锁全树或放宽 peer。评审第 6 项属审计建议、非 blocker，最小 diff 优先；最终报告不得宣称全 lock 单源。

### Node/CI 既有风险的隔离实验

三包 1.4.0 已有 `>=22.19.0`，故不能把本次定性为新增 Node 下限。当前 CI 主 job 用浮动 `22`，web-min-node 用精确 `22.12.0`；22.5 是 traffic floor smoke 的既有范围，不是现有 CI 安装 job。后续在隔离环境记录 Node 实际 patch、npm 版本、engine-strict 设置，对 **1.4/1.5** 同条件测 Node 22（实际解析 patch）、22.12.0、22.5.0 的安装退出码/EBADENGINE 告警或失败（默认与 strict 模式分列）；安装成功不等于低于包 engine 受支持。若需新增 CI job 或改仓库 engines，列证据另申请 `.github/workflows/ci.yml`/package 文档扩域，不从本计划推导全面抬高 Node，亦不覆盖 traffic 原下限。

## 7. 实施验收与完整门禁

所有下列命令均为**未来门禁，不是本阶段通过记录**。每条设置有限外层 timeout；timeout 本身是失败，不能当 pass。使用 `set -o pipefail` 保存退出码 / stdout / stderr；全量只限并发一次，不与 #36/UI 当前测试争抢机器。

### 7.1 AGENTS peer bump checklist 全覆盖

1. 有意识同步三项 peer，复核 `src/adapters/pi-compat.ts`，完成 P0 新测试与旧版本矩阵。
2. `npm run test:conformance` 跑 **整个 tests/conformance**，不能只跑此表或声称 self-gated skip 就算验证完成。必须覆盖：
   - `pi-boundary.test.ts` / child context-switch 能力。
   - `fabric-wake.test.ts` C-P1–C-P5；`fabric-xs.test.ts` **C-X1–C-X16 全集（含 C-X12b / C-X14b）**；legacy / human grant 等现有文件不排除。
   - `schedule.test.ts` C-S1–C-S8（C-S6 无 tsx 会 skip，必须确保副本有 tsx 后重跑）。
   - `traffic.test.ts`、`traffic-coexist.test.ts`。
   - `cmd-history.test.ts`、`slash-args.test.ts`、`rpc-spawn.test.ts`。
   - `keepalive-pipeline.test.ts`、`web-resume.test.ts`。
   - `secure-gocryptfs.test.ts` C1–C5（self-gating，真实环境另约）。
   - `agent-dir.test.ts`：`CONFIG_DIR_NAME === ".pi"` 与真实 env 名称 / 路径行为。
   - `reflex.test.ts` C-R1–C-R8，C-R6 引用 `topic-switch-hop.test.ts` S5，不能把 todo 引用当独立已测行为。
   - `memory-jev-channels.test.ts` **C-J1–C-J16**（含 P/U 合并返回通道），与后续 AGENTS checklist / tests/docs 契约同步，不得遗漏。C-J7 真调用、C-J8、C-J15 真可用性需 `PI_TOOLKIT_JEV_CONFORMANCE=1` + 真 classifier credential/proxy；类型级与目录级不替代网络实证。
3. 升 pi 前还必须显式 `PI_TOOLKIT_DROID_CONFORMANCE=1 … vitest run tests/conformance/droid-protocol.test.ts`；需 droid / FACTORY_API_KEY。虽然不升级 droid 也必须执行，缺条件记 **BLOCKED**，不以未启用 droid 或默认 skip 绕过。若另升级 gocryptfs，再单独重跑 secure-gocryptfs；本方案不升级它。
4. 全部 A frozen 不变；B/C 只按 AGENTS 指定规则，不能为兼容绿灯刷 golden。

当前整个 conformance 还包括（基于调研时文件表，执行时重新枚举）：`ask-user-interrupt-keys`、`ask-user-interrupt`、`ask-user-wired`、`fabric-human-grant-context`、`fabric-xs-legacy`、`history-restore`、`input-budget`、`keepalive-pipeline-facts`、`lifecycle-entries`、`measure-build`、`measure-openai-build`、`model-switch`、`result-tool-rename`、`rpc-bash-jobs`、`secure-convert`、`secure-convert-xc2`、`secure-convert-xc89`、`secure-private-ns`、`steer-hold`、`steer-hold-driver`、`todo-archive`、`topic-switch-hop`、`wake-run-sysprompt`。这些是 `.test.ts` 文件简称，不是建议排除 helpers 或只匹配这些名字。

### 7.2 工程与真实行为门禁

| 层          | 必须执行 / 断言                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向        | P0 validation/SDK/#40；`tests/adapters/pi-compat.test.ts`；StructuredOutput 真拒绝/接受与 host 二次验证；SDK create/resume/abort/dispose；boundary 提交与 keepalive/traffic 共存；stack teardown matrix                          |
| 类型        | `npm run typecheck`（TS7 两配置 + Vue）；1.5 与保留的旧 peer 环境分别验证，不用 any cast 掩盖 API 破坏                                                                                                                           |
| 构建        | `npm run build`；pi 加载 TS index 的 smoke 与 Node dist 入口分开测，build 绿不代表 jiti 绿                                                                                                                                       |
| UI          | `npm run build:web && npm run check:web`；不修改同树 UI，核验锁变动对打包/CSP/size/provenance/licences 无破坏；浏览器 TUI/RPC dialogs、key hints、PageUp/Down 等定向 smoke；mermaid Tier3 需涉及相关运行面时按独立浏览器环境执行 |
| 日常 / 集成 | `PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier1`；`PI_TOOLKIT_TEST_WORKERS=2 npm run test:tier2`（包含 secure）。Tier1 硬门；Tier2 CI 红先 rerun，再本地同文件取证，不能悄悄 skip                                                  |
| 全量        | 集成交付 / push 前按 AGENTS 跑 `npm test`，避免与上述全量重复并发；发布还需 release.sh 全门禁且另获用户确认，本方案不发版                                                                                                        |
| Secure      | 独占干净 mount table / 非 symlink TMPDIR，`PI_TOOLKIT_TEST_WORKERS=1 npm run test:secure`，及真实 secure conformance。不能卸载他人/当前活跃 vault 以“修环境”；协调用户维护窗口。preflight 红是环境阻塞，不是 flake               |
| 真人 / 网络 | 明确获准的 credential gate：Jev C-J7/8/15、droid；最小额度/脱敏日志。无凭证不谎报 pass，无用户正文外发，无真实 memory 写入                                                                                                       |
| 格式        | `npm run format:check`；实施中 formatter 仅精确改动路径，绝不 `format --write .` 扫到无关树                                                                                                                                      |

行为测试必须用 fake provider/controlled transport 捕获实际消息、事件、工具 args、执行与持久化次数；对 failure / timeout / abort 有明确负断言。不得恒真 stub、不得“不抛异常即通过”。真实外部 API 门禁另列成本与凭证授权。

### 7.3 Frozen 比对与版本矩阵口径

- 实施前后均运行 `git diff --quiet origin/dev -- tests/fixtures/`，记录非零原因；当前非零属于既有差异，不能宣称已为零。
- 额外以**批准的集成 BASE**前后比较 fixtures 全体与 A 清单 SHA-256；现有 memory B/新增 fixture 交由其任务所有者核验。适配包自身 fixture diff 应为零，禁止 UPDATE / CAPTURE 环境变量“修通过”。
- 旧 hub × 新 agent、新 hub ×旧 agent / UI 兼容与 off 路径按既有 golden 逐字节核验；不 bump PROTO、不改 runtime old names。
- 宿主自身 system prompt、validation error 文案、catalog 变化应在**新独立 fixture 或精确语义断言**体现，不能覆盖冻结扩展 golden；若 A 本身冲突，停止并审查范围。
- 验收报告每环境写清 local CLI / SDK / child 实际版本、Node、lock hash、执行/skip/block 数、命令 exit；“1.5 类型通过 + 1.4 实际运行”不能算单个完整环境通过。

## 8. 真实升级、用户确认点与回滚（未执行）

**G0 方案与实验授权：已发生、限定隔离范围。** GLM `r_1QK6GGTT` 首轮有条件通过，本稿对应七项处置见 §9。用户已通过 ask_user 批准目标 1.5.0 的隔离验证，BASE 固定 `efa12f261496d0cf2ca1d1f8d320912409ada89c`；`/tmp` 独立 clone/worktrees + 独立真实 node_modules，可实验安装依赖/添加测试/必要最小兼容 shim，保留旧 peer 策略、新失败先报。不动主树安装/global/reload/真实 memory/真实凭证/挂载。root 核对修订闭合后派实施；这不授权本 run 安装，也不是集成/live 批准。

**G1 已授权隔离实施的执行顺序（不得简化成只测 1.4）**：

1. G1 前先闭合 §2 官方缺证据/完整阅读门；G0 BASE 必须为 immutable 完整 hash，禁止 dirty UI/memory。对相同 BASE 的 `{1.0,1.1,1.2,1.3,1.4}` 每个 minor 选精确版本（至少各 x.0，下界 1.0.0；另有代表 patch 须记理由和完整版本），先跑保留支持范围的类型/行为门禁并记录**既有 pass/fail**，不加 production 补丁。
2. 相同 BASE 换 1.5.0，跑同一命令与 P0 新行为断言，保存 red/无失败结果及日志。新测试应在对照两侧同样运行，production 内容仍为 BASE；不得预先套 shim 再伪造 red。
3. 只对已实证的适配失败加必要最小补丁；1.5.0 同命令重跑 green，逐失败关联补丁。若原本全绿，记录无需 shim，不为流程制造假 red。
4. 将**同一个补丁集**应用各独立版本环境，形成 `BASE × {1.0,1.1,1.2,1.3,1.4,1.5}` 对 `PATCHED × 同全集` 的 typecheck/行为双矩阵，附 test id、版本/lock hash、exit、pass/fail/skip/block、原始日志路径。对比新增/消失失败，不用汇总一个绿灯遮蔽单元格。

既有 known-fail 仅可按相同 BASE/宿主/环境/测试签名及证据归因；它仍是支持承诺缺口，不能从矩阵删除、改 skip、用“既有”免验或扩大 peer 掩盖。保留旧 peer 策略；任何新失败先报 root，未获裁定不抬 floor/不缩窄范围/不发包。范围扩大停止并升 L3。#36/UI 完成交付后另选精确集成提交完整复验，不把其 dirty 状态混入已批准 BASE 或捆绑发布。

**G2 集成授权**：异源验收（与实施模型不同）核对精确 diff / 日志 / frozen / skipped 外部项。所有必须门禁闭合后，由集成主会话仅挑本包精确文件；是否提交/推送按届时用户授权，不从本阶段推导。AGENTS / peer / compat tested 文案与证据一起更新。

**G3 宿主切换授权（独立于改 peer）**：先保护真实 sessions / settings / auth / 安装 manifest 的可回退备份（敏感备份不落仓库、不进入调研日志）；记录旧 pi 1.4.0 安装来源、prefix、可执行路径与依赖 lock/integrity。等待主会话/subagents/bash/workflows 全部空闲，用户确认维护窗口；不能为验收主动 reload 正在运行的会话。

推荐先在**独立安装 prefix**安装精确 `@earendil-works/pi-coding-agent@1.5.0`，用绝对路径 + 独立 agentDir / session 副本 canary；确认身份与版本、工具表、主/子会话发现、一个受控 prompt、命令/上下文切换、恢复、Web/RPC。通过后用户再确认 PATH / 原有安装方式切换。不要直接 `pi update`（可能带 extensions/models 更新），不要一次升级全局 pi + 插件 + 全部包。

若最终选择原 npm global prefix 切换，获准并停止相关进程后才运行精确版本全局安装；若是 pi.dev managed install，应遵循对应 manifest/lock 方式而不是 npm 混装。`/reload` 只重载扩展，不会把正在运行进程的宿主从 1.4 变 1.5，真实切换必须退出并重启；hub 是否需重启另按实际宿主/插件变化确认，不自动影响所有共享会话。

**回滚**：实验失败只停实验子进程、保留脱敏日志，主树与 global 仍 1.4；精确清理自己创建的 `/tmp/pi-adapt-*`，不广泛删除 /tmp 或 npm cache。正式失败停止新进程，恢复旧 PATH/prefix 或按原安装方式重装精确 1.4.0，回退适配独立提交与配套 package+lock，重新启动；不全树 reset，不覆盖 #36/UI。新版本可能已经写 session / settings / changelog-seen 状态，先在副本验证 1.4 读取；无法证明时用升级前备份/新会话，不让旧宿主继续改唯一新格式文件。回滚完成核对 CLI / local SDK / child / lock hash，跑 1.4 最小 smoke，真实全量门禁另排。

## 9. 本阶段自验与遗留

已执行的核验：版本命令、官方 npm view、GitHub Release/contents 只读查询、源码/文档定位、根 package/lock 读取、git status/diff/rev-parse 只读操作、保护文件 hash。本文另做单文件 Prettier check 与内容/路径检查，结果见交付摘要。

**未运行** typecheck/build/UI bundle/tiers/conformance/secure；这是无实施阶段的权限边界，不是这些门禁已通过。官方源文件取回到 /tmp 只是调研材料，不是依赖安装。未写共享 node_modules，未升级全局 pi，未 reload，未提交 git。

### 首轮评审七项处置（按 root 转交，不声称取得全文）

| 项                   | 本稿处置                                                                                                     | 后续门禁 / 状态                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1 · severe 基线/矩阵 | G0 完整 immutable BASE 固定；G1 改为旧五 minor BASE pass/fail → BASE 1.5 red → 最小补丁 green → 同补丁全矩阵 | known-fail 逐项归因，不豁免支持承诺；新失败先报，尚未运行 |
| 2 · 官方缺证据       | rpc-mode/tools-index contents 字节/blob SHA/SHA-256 核实并完整阅读；补读目标 RPC 三篇文档                    | G1 前材料校验失败即 BLOCKED；不替代发布包实测             |
| 3 · engines          | 核实 1.4 已要求 >=22.19；列 Node 22/22.12/22.5 双版本安装告警/失败实验                                       | CI/engines 扩域另批，不武断全面抬 Node                    |
| 4 · fabric           | 按实际 C-X1–C-X16（含 12b/14b）全覆盖                                                                        | 完整 conformance，不排除新增项                            |
| 5 · memory/docs      | C-J1–C-J16；后续 AGENTS 与 tests/docs/agents-md.test.ts 精确对照域                                           | 本轮不改这些文件；真 classifier 仍未授权                  |
| 6 · lock             | 实验混源可追踪；正式沿既定 registry 的必要闭包最小 diff，旧混源例外不顺带清洗                                | 核对官方 integrity；不无理由重写全 lock                   |
| 7 · future patch     | peer <1.6 允许 1.5 patch；tested 上界精确 1.5.0                                                              | 1.5.1 warning 是预期；后续 patch 必须先门禁再扩 tested    |

另按 root 提醒同步 §4 #40 当前默认启用/权威 unknown effect:none 一次 A→B/optional feature token 可信门，移除旧 cap/default-off 叙述；仅事实同步，不新增评审。

### 局部类型集成状态（2026-11-06，主树已落地）

隔离验证提交 `a0bcc7471abc935b6eaeeef485fd734c696ab2cb`（报告 `/tmp/pi-adapt-lPbUM0/adaptation-report.md`，patch `/tmp/pi-adapt-lPbUM0/adaptation.patch`）中 Sonnet `r_X2K1DR1C` 验证过的 type-only 子集（4 个 src 文件、每处仅给 `tiers` 字段加显式 `| undefined`：`src/cache-ttl/keepalive-service.ts`、`src/cache-ttl/keepalive-state.ts`、`src/memory/tidy/cost.ts`、`src/core/types.ts`）已按授权精确集成进主树，逐文件 blob SHA 与隔离提交完全一致；主树 typecheck、既有 pricing/keepalive/tidy/pi-free 门禁在本地 pi 1.4 依赖下通过。这是**局部类型边界兼容**（pi 1.5 的价目 DTO 可显式携带 `tiers: undefined`），不代表 peer / TESTED_PI_RANGE / dev 依赖已抬升——三包 peer 仍 `>=1.0.0 <1.5.0`，tested 仍 `1.0.0 - 1.4.0`，runtime JS 未变。隔离包里的 3 个 P0 新增测试（`tests/conformance/pi-1.5-validation.test.ts`、`tests/conformance/pi-1.5-sdk.test.ts`、`tests/conformance/pi15host-case.test.ts`）**未集成**：它们在本地 1.4 上有已知的上游 append-ghost 红，待正式 1.5 支持/characterization 策略单独处理，保留在隔离证据包。剩余门禁见 §7–§8（整包兼容仍 BLOCKED）。

遗留：隔离实施及目标 1.5 发布包已做定向实测（六版真安装矩阵、20 条 P0、253 断言两版验证，见 `/tmp/pi-adapt-lPbUM0/`）与上述 4 处 type-only 集成；完整 39 conformance / tiers / UI / 真实 classifier / droid / secure 与旧支持范围失败归因未全闭合，不宣称支持范围扩展通过。真实凭证与 secure 维护窗口仍未授权。用户已自行把 global pi 升到 1.5，本地依赖仍 1.4，我们未做任何 global 安装/回退；运行中旧进程加载的模块版本未知。真实 classifier/droid 需另行凭证/网络额度授权，secure 需独占机器与挂载窗口；CI 扩域、正式集成、live 安装/切换/reload 仍未授权。**隔离授权已获准不等于兼容通过，更不等于可以现在升级真实宿主。**
