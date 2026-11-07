# pi 1.4.0 适配报告（#71）

- 基线：`dev` 23bc3278，分支 `chore/pi-1.4`，worktree `/tmp/pi14`。
- 开发依赖：pi-ai / pi-coding-agent / pi-tui（及间接的 pi-agent-core）从 1.3.0 升到 **1.4.0**（2026-10-21 发布）。
- 结论：**支持范围放宽到 `>=1.0.0 <1.5.0`，保留 1.0–1.3 的兼容，没有抬高下限。** 1.4 没有任何我们用到的扩展 API 发生破坏性变化，也没有引入版本分支或双路径 shim。

## 1. pi 1.3.0 → 1.4.0 变更与影响逐条对照

资料来源：`@earendil-works/pi-coding-agent/CHANGELOG.md` 的 1.4.0 一节（pi-ai / pi-tui / pi-agent-core 的 npm 包不带 CHANGELOG，改为对 1.3.0 与 1.4.0 的 `dist/` 逐文件 diff，覆盖全部 `.d.ts` 和相关 `.js`）。

### 1.1 公共类型 / 扩展 API 面

| 变更                                                                                                                                                                                     | 对 pi-toolkit 的影响                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExtensionAPI` / `ExtensionContext` / 事件 / `registerTool` / `ui` 的 `.d.ts` 无变化（`agent-session.d.ts` 只有私有成员差异）                                                            | 无。`npm run typecheck` 零错误（TS7 ×2 + vue-tsc）。                                                                                                                                               |
| `generateSummary()` / `generateSummaryWithUsage()` 的 `reserveTokens` 参数改名 `_reserveTokens` 且类型放宽为 `number \| undefined`，忽略不用；摘要请求不再设 `maxTokens`，用模型输出上限 | 无调用点（`grep generateSummary src` 为空）。`compaction.reserveTokens` 仍然决定「何时开始压缩」，所以 `compact-hint` 的阈值计算（读 `reserveTokens`）不受影响。                                   |
| pi-ai 新增 `ClientIdentity` / `identity`（`Agent`、`AgentLoopConfig`、`Models` 选项）、`PI_AI_VERSION`、`lazyStream(…, observer?)` 的可选第三参                                          | 纯增量，我们没用。                                                                                                                                                                                 |
| pi-ai `./models` 子路径现在被扩展 loader 的别名 / virtual modules 暴露（#11156）                                                                                                         | 纯增量。我们不 import 该子路径。                                                                                                                                                                   |
| `models.json` schema 增加 classifier 的 `compat`（`imageInput`、`sendImageOptInHeader`）、一批 provider 默认模型调整、`compat` 里若干字段                                                | 只影响用户的 `models.json` 与 `available-models` 的内容，不影响我们的代码。`available-models-golden.txt` 等 B 档 golden 未发生变化（全量测试通过，`tests/fixtures/` 对 23bc3278 零 diff，见 §4）。 |
| pi-tui：`Terminal.restoreOnExit?` 与 `TUI` 的 exit-restore handler（#11170）                                                                                                             | 纯增量（可选方法）。我们的 `tui-harness`/HUD/ask_user 组件没有实现 `Terminal`，不受影响。                                                                                                          |
| pi-agent-core：`DEFAULT_AGENT_IDENTITY`、`Agent.identity`                                                                                                                                | 纯增量。                                                                                                                                                                                           |

### 1.2 行为变化（需要逐条判断）

| 变更                                                                                                                                                                                                                                               | 影响与处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#11062/#11075：resume 与 `/tree` 导航时，分支「从未添加也从未移除」的扩展工具现在会被激活**（除非注册时 `defaultActive:false`）。1.3 是用转录里声明的工具集覆盖当前激活集                                                                        | **这是本次唯一导致测试失败的 pi 行为变化**（`result-tool-rename` R1、R5a）。一方面它正好原生修复了我们 `get_subagent_result → get_run_result` 迁移（`src/tools/result-tool-activation.ts`）要绕开的问题：1.4 上新名字原生就是激活的，迁移变成 no-op（`planResultToolActivation` 在新名字已激活时返回 undefined）；迁移代码继续为 1.0–1.3 兜底，**不删**。另一方面带来一个小副作用，见 §6 残留风险 ①。处理方式：R1 改为钉住 1.4 的新事实；R5a 的场景改成「有记录的一轮之后用户停用，再记录一轮，再 resume」，仍然证明迁移不会重新启用用户停用的工具。 |
| 摘要不再有固定输出上限（#9512/#9075）；`/compact <instructions>` 对被拆分的 turn 前缀也生效（#11058）                                                                                                                                              | 对 `context-switch` 的 `session_before_compact` 钩子无接口影响：钩子照常收到 `preparation`，我们不依赖摘要 `maxTokens`。`pi-boundary`、`fabric-xs`（capability 到达 `verified`）都通过。                                                                                                                                                                                                                                                                                                                                                             |
| 提供商归因头改由 pi-ai client identity 提供：`before_provider_headers` 处理器**不再看到** OpenRouter / NVIDIA NIM / OpenCode 的归因头（返回 `null` 仍可删除）；`x-opencode-client`、Cloudflare/GitHub 的 `User-Agent` 变化                         | 我们的 `before_provider_headers` 使用方是 traffic 录制与 cache-ttl keepalive。keepalive 自 pi 1.2 起已不再抓取 headers（走 pi 自己的 provider 管线重放，见 `keepalive-state.ts:161`），不受影响；traffic 录制的是请求/响应，归因头不再出现在其「headers 钩子快照」里属于记录内容变化而非功能变化。`traffic`、`traffic-coexist` conformance 全部通过。                                                                                                                                                                                                |
| 扩展 `select/confirm/input/editor` 对话框与内联 `custom()` 组件改为栈式：并发时后者不再顶掉前者，前者的 promise 不再永远 pending（#11166/#9909）                                                                                                   | 对 `ask_user`、远程作答端口只有正向影响。相关 conformance（`ask-user-wired`、`ask-user-interrupt*`）通过。                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 模型 `compat`/`classifier` 相关、grep 加 `--no-config`、Windows shell 探测、剪贴板、HTML 导出 CJK、Rex 终端、自动重试规则扩充、OpenAI Responses 提示缓存修复、`openai-codex` 模型清单、BOM 配置修复、截断恢复后孤立 toolResult（#11227）等其余条目 | 与我们的代码路径无交集，不需要改动。#11227 的内部实现从 `_lastAssistantToolResults` 改成在 `agent.state.messages` 里找配对结果——我们不碰这些私有成员。                                                                                                                                                                                                                                                                                                                                                                                               |

### 1.3 隐藏的版本闸门（本次最大的坑）

`src/web-hub/protocol/spawn.ts` 的 `SUPPORTED_PI_RANGE.maxExclusive` 是 web-hub 受管 spawn 的硬闸：hub 启动时检查 launcher 指向的 pi 版本，超出范围就 `503 E_LAUNCHER{reason:"launcher",detail:"incompatible"}`，**整个 spawn / resume / fork / restore 功能在 hub 生命周期内 fail-closed**。只改 `package.json` 而不改它，conformance 里 `history-restore`（RH1–RH4）会全灭，真机上则是网页「历史会话」面板不可用。已同步放宽到 `1.5.0`（`tests/web-hub/protocol/spawn.test.ts` 有「与 peer 范围一致」的钉子，所以这一项如果遗漏会被测试抓到）。

## 2. 改动

提交（均在 `chore/pi-1.4`，未 push）：

1. `chore(deps): support pi 1.4`
   - `package.json`：三个 peer `>=1.0.0 <1.5.0`；devDependencies `^1.4.0`；`package-lock.json` 同步（pi-agent-core 等间接依赖随之升到 1.4.0）。
   - `src/web-hub/protocol/spawn.ts`：`SUPPORTED_PI_RANGE.maxExclusive` → `1.5.0`。
   - `src/adapters/pi-compat.ts`：`TESTED_PI_RANGE` → `"1.0.0 - 1.4.0"`，`isWithinTestedRange` 上限 minor 4（1.5+ 才会打「未验证」警告）。
   - 测试：`tests/adapters/pi-compat.test.ts`、`tests/web-hub/hub/spawn/launcher-check.test.ts`、`tests/web-hub/hub/spawn/supervisor.test.ts`、`tests/web-hub/protocol/spawn.test.ts` 的版本样本换到 1.5.0 / 2.0.0 为「范围外」，并把 1.4.x 加入「范围内」正例。
   - `AGENTS.md`：两处 peer 范围字样更新。README / README.en.md 没有写 peer 范围，无需改。
2. `test(conformance): follow pi 1.4 tool restore in the result-tool rename suite` —— 见 §1.2 第一条。
3. `docs(toolchain): pi 1.4 adaptation report` —— 本文件（最后一个提交）。

没有修改 `src/` 里除上面三个常量位置之外的任何代码。

## 3. conformance 结果（`npm run test:conformance`，整个 tests/conformance）

首轮：35 个文件，33 过 / 2 失败；355 过、6 失败、16 跳过。

- 失败 1：`history-restore`（RH1–RH4，4 项）—— 原因是上面 §1.3 的 `SUPPORTED_PI_RANGE` 闸门，**不是 pi 行为变化**。放宽后重跑通过。
- 失败 2：`result-tool-rename` R1、R5a（2 项）—— **pi 行为真的变了**（§1.2 第一条）。已改测试，10/10 通过。

最终代码上的 conformance 逐项（整目录首轮即为最终代码，仅 `result-tool-rename` 与 `history-restore` 在修复后单独复跑通过）：

| suite                                                                                                                                          | 结果                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| pi-boundary（boundary-draft 契约）                                                                                                             | 6/6 通过                                                                      |
| context-switch capability 到 `verified`（`fabric-xs` 里 `expect(h.cap.state).toBe("verified")`）                                               | 通过 —— `src/context-switch/capability.ts` 仍能到达 `verified`                |
| fabric-wake（C-P1–C-P5）、fabric-xs（C-X1–C-X11）                                                                                              | 8/8、20/20                                                                    |
| schedule（C-S1–C-S8）                                                                                                                          | 13/13                                                                         |
| traffic、traffic-coexist                                                                                                                       | 9/9、6/6                                                                      |
| cmd-history、slash-args、rpc-spawn、keepalive-pipeline(+facts)、web-resume、lifecycle-entries、agent-dir（`CONFIG_DIR_NAME === ".pi"` 仍成立） | 全部通过（lifecycle-entries 9/9：pi 1.3 起钉住的扩展模块生命周期在 1.4 未变） |
| secure-gocryptfs（自门控）                                                                                                                     | 6/6 通过（本机有 gocryptfs，真跑）                                            |
| droid-protocol                                                                                                                                 | 17 项中 16 跳过（自门控，无 `FACTORY_API_KEY`），见 §5                        |

## 4. 全量测试、构建与冻结物

- `npm run typecheck`：通过（TS7 `tsc --noEmit` ×2 + `vue-tsc`，零错误）。
- `npm run build`：通过。`npm run format:check`：通过（本报告提交前已 prettier）。
- 全量 `PI_TOOLKIT_TEST_WORKERS=3 npm test`（1555 个文件）：**1550 文件通过 / 5 失败；30115 测试通过、33 失败、56 跳过**。5 个失败文件逐个分类如下，**没有一个与 pi 1.4 有关**：
  - `tests/config/agent-dir-identity.test.ts`（1 项，T-ID1）：这是对 `src/web-hub/hub/hub.ts` 源码文本的 grep 断言（期望 `agentDir: hubAgentDir` 出现 7 次，实际 1 次）。本分支没有改动 `hub.ts`（`git diff 23bc3278 -- src/web-hub/hub/hub.ts` 为空），所以这是 `dev` 23bc3278 上**已存在**的失败，不是本次引入。**未修，范围外**，建议另开任务。
  - `tests/secure/launcher-convert.test.ts`（32 项）：**环境原因**。测试夹具建在仓库内的 `node_modules/.cache/v7/…`，而本 worktree 位于 `/tmp/pi14`，`pi-secure convert` 的路径检查拒绝「位于系统目录之下（/tmp）」，报 65 而非期望的 74，随后一批「launcher stopped at the seam」等待超时。与 pi 版本无关（secure 走 gocryptfs，不走 pi）；在 `/home/bluecake/ai/pi-toolkit` 主工作区正常路径下应当不会出现。**我没有在主工作区验证**（任务禁止触碰主工作区）。建议合并前在主工作区跑一遍 `npx vitest run tests/secure/launcher-convert.test.ts`。
  - `tests/secure/launcher-private-cmd.test.ts`、`launcher-private.test.ts`、`helper-v0-api.test.ts`：全量并发下超时（250 s 级别；同一时段主工作区也在跑另一轮 vitest，机器负载 6+）。**单独重跑全部通过**：`helper-v0-api`+`launcher-private` 52/52，`launcher-private-cmd` 42/42（`PI_TOOLKIT_TEST_WORKERS=1`）。
- 第一轮全量（`timeout 1700`）因我自己设的超时被杀（exit 124，跑到 442 个文件），没有计入结果；上面的数字来自第二轮完整跑完（Duration 2333 s）。
- **冻结物**：`git diff --quiet 23bc3278 -- tests/fixtures/` ⇒ 零差异（A/B 档 golden 与 `governance/activate-trace.json` 均未改动、未刷新）。pi 行为变化没有导致任何 B 档 golden 变化。

## 5. droid conformance

`PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts`：本机有 `droid 0.242.0`，但环境里没有 `FACTORY_API_KEY`，套件按设计自门控，16 项 live 用例全部 skip；唯一的非 live 用例 `skips without PI_TOOLKIT_DROID_CONFORMANCE` 在「设了开关却没 key」的组合下断言 `RUN === false` 而失败——这是该测试自身对该组合的既有写法问题（不设开关时 17 项为 16 skip + 1 过），与 pi 1.4 无关，未改。droid 协议与 pi 版本无耦合，live 验证待有 key 的环境补跑。

## 6. 兼容策略与理由

- **选择：保留 1.0–1.3，peer 放宽到 `>=1.0.0 <1.5.0`，不抬下限。**
- 理由：1.4 对扩展 API 零破坏；唯一的行为变化（工具恢复）对旧版是「保留一段兜底迁移代码」，既不分叉也不增加运行期版本判断（迁移本来就是结构性探测 + fail-safe 的，在 1.4 上自动变成 no-op）。没有出现需要「大量版本分支、双路径 shim」的情形，所以没有触发用户授权的「抬下限」条件。
- 顺带记录：`docs/dev/source-governance/analysis.md` 里挂着的「是否把 peer floor 提到 1.2」仍是悬而未决的独立议题，本次没有动。

## 7. 残留风险

1. **「首轮之前停用工具」在 resume 后会被 pi 1.4 重新激活。** pi 1.4 的 resume 把「分支从未提及」的扩展工具视为新注册工具而激活。若用户在**第一轮 prompt 之前**停用某个我们的工具（例如关掉某个我们注册的工具），转录里既没有 toolsAdded 也没有 toolsRemoved，resume 之后它会回来；已经有过至少一轮记录再停用的则正常。这是 pi 的行为，不是我们的回归，未改动。如果要彻底堵住，需要给相关工具注册 `defaultActive:false` 或在 `session_start` 里自己做二次裁剪，涉及产品取舍，**本次未做**。
2. `ask_user` 在无头模式会 `setActiveTools` 把自己摘掉（`src/ask-user/index.ts disableAskUser`）；resume 后 1.4 会先重新激活再被无头判断摘掉一次，行为等价，不需要处理。
3. 传输/摘要相关：1.4 摘要不再限制输出上限，长推理的摘要可能更贵、更慢；`compact` 的价格感知阈值（`compact-hint/threshold.ts`）只估算触发时机，没有把摘要输出成本算进去，沿用既有口径。
4. 全量测试里的 `gocryptfs` 真实挂载类用例（`tests/secure/*`）在机器忙时会超时，单独跑稳定通过（见 §4）；`launcher-convert` 在 `/tmp` 下无法验证，合并前请在主工作区复验。

## 8. 用户本机升级 pi 后的真机冒烟清单

升级 pi 到 1.4.0 后，在装了本插件（含本分支）的环境里：

1. `pi` 启动无「has not been validated against pi」警告（`TESTED_PI_RANGE` 已含 1.4）。
2. `/reload` 之后，再执行 `/webhub restart`（launcher 检查只在 hub 启动时跑一次）；网页「历史会话」面板不再出现 launcher 失败提示；新建会话、resume、fork 各做一次，并 `/webhub restart` 一次验证 restore。
3. 旧会话 resume（含曾经调用过 `get_subagent_result` 的）：`get_run_result` 在工具列表里且是激活状态。
4. 起一个后台 `Agent`，等完成通知；`get_run_result`、`steer_subagent`、`abort_subagent` 各试一次。
5. 触发一次 `/compact`（以及 `switch_context`，若在用），确认摘要成功、会话继续、`/agent status` 里 compact 阈值行正常。
6. 如开启 cache-ttl keepalive：看一轮 ping 是 `proven-hit`；如开启 traffic：看一条记录正常入库。
7. TUI：同时触发两个对话框（如 `ask_user` 与另一个确认框）确认 1.4 的栈式对话框下互不吞没；`/resume-recent` 正常。
8. 如用 OpenRouter / NVIDIA NIM / OpenCode：确认请求正常（归因头现在由 pi-ai 提供，`before_provider_headers` 不再可见）。
