# todo #22 memory 优化：实施方案（层级 2）

> 状态：**已实施（P0–P5）**。P5 已完成真实 renderer/doctor/tidy 串联、默认值翻转、可发现性代理测试与文档同步；E1 命中率评测和 L1 legacy 淘汰仍按下文作为后续非发布阻塞项。

> 状态：方案稿 **v6**（2026-09-27，dev-flow L2「方案制定」五次修订；v1 = 3f921b7、v2 = 0a29469、v3、v4、v5 均被评审打回）。v6 是小修，只处置 v5 复审的 3 条问题（§11.2 评测成本口径两条 + §1 / §7.0 6b pi 事件时序一条），其余章节沿用 v5。
> 输入：**v5 复审意见（zhipu gpt-sol，主会话转述，下称「复审 v5」）+ 主会话裁定「命中率评测是探索性、非发布阻塞工具（N4 = A），不做硬成本闸门」（权威）**；**v4 复审意见（主会话转述，2026-09-27，下称「复审 v4」）+ 主会话威胁模型裁定（权威）**；v3 复审意见（下称「复审 v3」）+ 用户决策 N4 = A、N5 = A（权威）；`docs/dev/memory/optimize-plan-review-v2.md`（下称「复审 v2」，**复审问题清单 + 用户决策 N1–N3 + 主会话对 v1-7 的裁定，权威**）；
> `docs/dev/memory/optimize-plan-review-v1.md`（下称「评审 v1」，10 条问题 + 14 条决策意见 + 用户决策）；
> `docs/dev/memory/design-review-2026-09-26.md`（下称「设计评审」）§2 量化、§4 契约、§6 P0–P2、§6A 工具层；
> `docs/dev/memory/memory-plan.md`（下称「memory-plan」）；`docs/dev/sysprompt-stable/plan.md`（下称「ss-plan」）§4.1 不变量 I1–I9；
> 代码 `src/memory/*.ts`、`src/sysprompt/hub.ts`、`src/prompt-sections/*.ts`、`src/config/{settings,setting-specs,agent-types}.ts`、`src/runtime/tool-scope.ts`、`src/service/{runtime-adapter,spawn-service}.ts`、`src/consult/`。
> 用户已选**层级 2**：注入改造 + 工具层 T1–T3 + 零成本体检 + 手动 `/mem tidy`。不做空闲自动整理；T4 `Agent({memory})`、T5 关键词预取只在 §13 预留接口。
> 逐条处置：v1→v2 见 §16；v2→v3 见 §17；v3→v4 见 §18；v4→v5 见 §19；**v5→v6 见文末 §20**。

## 0. 摘要

| 维度                 | 现状（设计评审 §2.3 实测）                                                     | 本方案目标                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 主会话首轮 memory 块 | 3,851B（约 1,100 token），pitfalls 截一半，quota/multi 只剩 138B/157B 半截片段 | **硬上限** `memory.blockBytes`=2,400B（UTF-8 字节，含标题/引导语/sentinel），**零半截文件**，超预算按确定性阶梯降级（§2.3）                                                                                                                                                                                                                                                                                        |
| 子会话首轮           | 与主会话相同 3.8KB × N                                                         | 默认 `core` 档：core + 一行主题名；按子会话实际可用工具（memory / read / 都没有）选引导语（§2.4）                                                                                                                                                                                                                                                                                                                  |
| 索引                 | 仅文件名 + 大小，按 mtime 排序；兜底路径是 `<file>` 占位                       | `文件 — description · when: read_when · Nk`，与 mtime 无关的确定性排序；引导语给**真实绝对目录**                                                                                                                                                                                                                                                                                                                   |
| 无意义尾部更新       | touch 文件 ⇒ 索引重排 ⇒ 整块 update                                            | 渲染与 mtime 无关 ⇒ touch 零 update；主题正文改动不改块（除非跨 kB 档或改 frontmatter）                                                                                                                                                                                                                                                                                                                            |
| 工具                 | list / write（整文件覆盖）/ append，读靠通用 `read`                            | 官方命令名 + **官方字段名**（`path/file_text/old_str/new_str/insert_line/insert_text/old_path/new_path/view_range`）+ `section/query` 扩展 + 旧 `action/name/content` 别名                                                                                                                                                                                                                                         |
| 工具面字节           | 1,333B（description 312 + snippet 58 + guidelines 546 + parameters 417）       | **1,443B**（UTF-8 字节；runtime `typebox@1.3.27` 与 devDep `@sinclair/typebox@0.34.52` 实测相同，但 JSON 键序不同 ⇒ golden 用 canonical JSON 比较，§4.5；上限 1,500B）                                                                                                                                                                                                                                             |
| 写入反馈             | 只回字节数                                                                     | 回预算占用 + **精确重复行**坐标；core / 主题超硬上限拒写并给拆分建议                                                                                                                                                                                                                                                                                                                                               |
| 文件系统安全         | 读写都跟随 symlink；append 先查后写可越过上限；create/rename 有 TOCTOU         | 目录内**文件级** symlink 全路径拒绝（含 legacy）；slug 目录 symlink 允许但每次操作 canonicalize 一次（用户显式信任）；目录锁串行化全部变更（含 `/mem import`）；临时文件替换保证全写或不写；`link()` 原子 no-clobber；fs 原语只在 `safe-fs.ts`（§3）                                                                                                                                                               |
| 治理                 | 无                                                                             | `/mem doctor` 零成本体检；`/mem tidy`（默认主会话模型；提案 run 由 runtime 强制只读工具域——模型可见工具集限定为 builtin 四工具 + runtime 自有 StructuredOutput，bind 与每回合 turn_start / turn_end 按名称 + 来源核验并剥离意外工具——模型无写文件工具（defense-in-depth，信任同进程扩展，§7.0.0）；输出字节 + 成本硬上限，无价模型允许但标「无成本保证」）；`--dry-run` 零成本预览；`--frontmatter` 确定性补元数据 |
| 回退                 | —                                                                              | `memory.layout=legacy` + `memory.toolSurface=legacy` ⇒ 注入与工具字节级回到 #22 之前（唯一刻意偏差：文件级 symlink / 非普通文件拒绝，§3.1；文件名接受规则不变）                                                                                                                                                                                                                                                    |

**核心设计取舍**：保留 stable snapshot + tail update 机制和 `subagent:prompt-sections` 持久化（设计评审 §5.1），只换「provider 返回什么」。hub 只做一处向后兼容改动（`pointerHint` 允许函数，**在 hub 内求值、异常降级，P0 实现并测试**），`stable-section.ts` / `fold.ts` / `update-message.ts` / `store.ts` 不动。

### 0.1 v2 相对 v1 的主要变化

1. 工具面口径改为 UTF-8 字节并实测（§4.5），参数改用官方字段名 + 旧别名（§4.1–§4.2），声明「兼容官方语义与字段名，不兼容官方路径模型」。
2. 注入块改为硬预算分配 + 六级确定性降级阶梯，任意 slug/文件集下 L0–L4 保证 ≤ blockBytes（§2.3）；golden 用固定 fixture 逐字节生成（§10.1）。
3. 新增 §3 文件系统安全与并发：统一 `safe-fs.ts`（拒 symlink、防交换）+ 目录锁 `lock.ts` + 原子 create/rename/append 语义。
4. `pointerHint` 函数求值从 P1 挪到 P0（hub 冻结面内完成）。
5. 用户决策落地：手写文件小改允许并警告、覆盖/删除/改名拒绝（§4.3）；tidy 默认用主会话模型并带输出字节 + 成本硬上限（§7）。
6. 精简：`similar.ts` 近似查重、D12、D15、D16 延后；T3 只做精确重复行；D10 并入 D09。
7. 零工具命中率改为可测：固定 10 题问题集、baseline 对照、工具调用计数口径（§11.2）。
8. P0 提交时 `layout`/`toolSurface` 默认值保持 `legacy`，P5 集成后才翻转默认 ⇒ master 每个提交都可发布。

### 0.2 v3 相对 v2 的主要变化（复审 v2）

1. **tidy 提案阶段零写入能力**（新-1，阻塞）：新增 runtime 强制的只读工具域 `SpawnRequest.toolDomain: "readonly"`，与 consult 复用同一强制点与同一常量 `CONSULT_READONLY_TOOLS`（外加 `StructuredOutput`），agent type 与 H2 扩展都不能加宽；tidy 的 spawn 恒带该字段；越权写入测试（§7.0、§10 N 组）。
2. **access 判定**（新-2）：无法确认 active tools ⇒ `none`；consult 明示为 `read`（只读四工具）（§2.4）。
3. **`tool.ts` 原位保留为 legacy**（新-3）：v2 工厂放新文件 `tool-v2.ts`，`tests/memory/tool.test.ts` 零迁移；P0 每个提交都可发布（§2.7、§14）。
4. **fixture 精确子目录所有权**（新-4）：禁止 `tests/fixtures/memory/**` 泛匹配（§14.2）。
5. **工具面 golden 用 canonical JSON**（v1-1）：两版 typebox 实测字节相同、键序不同（§4.5）。
6. **L5 按最终文本计算**（v1-3）：最小框架 `M` 为真实文本；L5 只允许不可约的 header + sentinel 超限；property 对实际输出字节断言（§2.3）。
7. **命中率评测降为探索性指标**（v1-4）：固定运行器（HOME 重定向注入设置、`--no-extensions -e`、超时/重试/归类/版本记录）、每题每组 5 次、`must`/`mustNot` 判定（§11.2）。
8. **import 入锁、临时文件替换、fs 原语下沉 `safe-fs`**（v1-6）：import 级守卫只放行 `safe-fs.ts`；`lock.ts` 零 fs import（§3）。
9. **slug 目录 symlink canonicalize + 信任语义；`NAME_RE` 仅 v2 路径**（v1-7 主会话裁定）（§3.1）。
10. **无价模型 tidy 允许 + 警告**（N1）：删除 `memory.tidy.allowUnpriced`，只保留回合/输出字节/超时硬上限（§7.1、§9）。
11. **包拆分**：P0 从两个提交变为三个（新增独立的 `P0-r` runtime 只读工具域）；P0-b 不再搬迁 `tool.ts`（§14）。

### 0.3 v4 相对 v3 的主要变化（复审 v3 + 用户决策 N4/N5 = A）

1. **P0-r 可 typecheck**（复审 v3-1，阻塞）：`SpawnRequest.toolDomain` 会触发 `src/service/request-threading.ts` 的 `AssertAllClassified` 编译闸；P0-r 文件域纳入该文件，`toolDomain` 登记进 `NOT_THREADED`（由 runtime adapter 消费，不进 runner），并补 request-threading 用例（§7.0 第 5 条、§10 N8、§14）。
2. **只读域只认 builtin 实现**（复审 v3-2）：pi `_refreshToolRegistry` 让同名 custom tool 覆盖 builtin，名称 allowlist 挡不住可写的「假 read」。readonly 域在 H2 之后把 `sessionSpec.customTools` 收窄为 runtime 自己创建的 `StructuredOutput` 实例，其余剔除并 WARN；bind 与每个回合边界再按工具来源（`sourceInfo.source`）核验：`read/grep/find/ls` 必须是 `builtin`、`StructuredOutput` 必须是 `sdk`，不符的从 active 集合剥离（fail-closed）；新增真实 `AgentSession` 端到端「恶意 custom read」测试（§7.0 第 6 条、§10 N9/N10）。
3. **bash_job / switch_context 不进只读域**（复审 v3-3）：`bashJobGrant` 改传 `consult: readonlyDomain`，switch_context 守卫改 `!readonlyDomain`；测试断言 grantedReserved（经 H2 输入观测）与 policy 均不含 `bash_job` / `switch_context` / 任何写工具（§7.0 第 1 条、§10 N3/N4）。
4. **评测运行器可复现、有上限**（复审 v3-4）：固定三组 fixture 映射；pi 从仓库 `node_modules` 解析绝对路径、经 `process.execPath` 启动，不依赖 PATH；总调用数与总成本双预算，超限中止并落盘部分报告（§11.2）。
5. **import 改 async 的调用方全列**（复审 v3-5）：`src/memory/command.ts`（串行 await）、`tests/memory/store.test.ts`（9 处调用 + `toThrow` → `rejects`）、`docs/dev/memory/memory-plan.md` §8.3 冻结签名同步，全部进 P0-b 文件域（§3.3、§10 A5、§14）。
6. **后续、非发布阻塞项**（复审 v3 建议）：命中率评测（新包 E1，运行器移出 P0-a）与 legacy 淘汰（L1）明确为发布后的跟进项；tidy / restore 仍在本期（§11、§13、§14）。
7. **用户决策**：N4 = A（命中率为探索性指标，每题每组 5 次，不作硬门禁）；N5 = A（tidy 零写入放在 runtime `SpawnRequest.toolDomain:"readonly"`）（§12）。

### 0.4 v5 相对 v4 的主要变化（复审 v4 + 主会话威胁模型裁定）

1. **威胁模型写明**（复审 v4-1/2，主会话裁定）：新增 §7.0.0。readonly 域防的是「tidy 子会话里的**模型**通过工具写文件」，不防同进程恶意扩展——H2 与任何 pi 扩展同进程同权限，可直接 monkeypatch `fs` 或改任意对象，进程内无从防御。readonly 保证「模型可见工具集 = builtin `read/grep/find/ls` + runtime 自有 `StructuredOutput`」，是 defense-in-depth，不是安全边界；恶意扩展列为明确非目标。不做对抗式加固；删去 v4 暗示能防恶意扩展的措辞，测试只保留「误配置 / 同名 custom tool 被剥离」类（N10 改名为误配置端到端，不加「改 execute」类用例）。`StructuredOutput` 定义对象 `Object.freeze`（低成本，防意外改写，不当作防线）。
2. **核验点前移到 turn_start**（复审 v4-2）：核对 pi 0.87.1 事件顺序（§1）——扩展的 `before_agent_start` / `agent_start` / `turn_start` 处理器都在 `session.subscribe` 监听者收到 `turn_start` 之前跑完，而 `prepareRequest` 在 `turn_start` 之后才把 `agent.state.tools` 快照成本次请求的可执行集合。readonly 域因此在 bind、**turn_start**、turn_end 三处核验（turn_start 只对带 `provenance` 的 policy 生效，其它 run 逐字节不变），覆盖「bind 后、首个请求前」与「本回合扩展处理器里新注册」两个窗口（§7.0 第 6b 条、§10 N9⑦/N11）。
3. **pi 可执行解析改正**（复审 v4-3）：`require.resolve("…/package.json")` 与 `require.resolve(<包名>)` 在本仓库实测都抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（`exports` 只有 `import` 条件、未导出 `./package.json`）。改为运行器脚本内 `import.meta.resolve("@earendil-works/pi-coding-agent")`（实测得 `…/dist/index.js`）→ 向上找 `name` 匹配的包根 → 读 `bin.pi`（= `dist/bundle/cli.js`）；`--pi <绝对路径>` 可覆盖；补子进程里真实 Node 解析单测（§11.2）。
4. **成本改为硬上限**（复审 v4-4）：价格来自 models.json（无价模型拒绝评测，删去 `--allow-unpriced`）；运行器用私有 agent 目录把评测模型的 `maxTokens` 压到 `--out-tok-max`（pi-ai 以 `model.maxTokens` 作 `max_tokens`，provider 侧硬封顶输出）；每次调用前按「最坏单次成本」`R = (K+1) × W_req` 预留，`spent + R ≤ maxUsd` 才派发 ⇒ 累计实际成本 ≤ 预算（前提 `inTokMax` 逐请求核验，违例立即中止并记录）（§11.2）。

### 0.5 v6 相对 v5 的主要变化（复审 v5 + 主会话裁定）

1. **评测成本从「硬上限」改为「尽力预算 + 有界超支」**（复审 v5-1/2，主会话裁定：命中率评测是探索性、非发布阻塞工具，不为它做硬成本闸门，也不加子进程请求闸 / 握手）。删去 v5「累计实际成本 ≤ 预算」的保证。§0.4 第 4 条与 §19 第 4 行是 v5 的历史记录，已被本条取代。具体改动：子进程强制短缓存——环境里删除 `PI_CACHE_RETENTION`（pi 0.87.1 读取的唯一缓存保留期变量），私有 agent 目录 `settings.json` 写 `cacheWarming:"off"`，toolkit 设置 `cacheTtl:{mode:"off",keepalive:false}`；`W_req` 覆盖 pi-ai `calculateCost` 的全部计费项取最坏值（`cost.tiers` 各档、`cacheRead`、`cacheWrite`、Anthropic 1h 写入按 2× input）；usage 缺失或不完整 ⇒ 立即中止（fail-closed）；写明最大超支 = 未记账的在途请求数 × `W_req`，保守按整次评测 2 条估计并给出理由（§11.2）。
2. **pi 事件时序按 `agent-loop.js` 源码改正**（复审 v5-3）：每个回合在 `turn_start` 之后、`prepareRequest` 之前都有一次 `declareToolChanges`，但它比较的是 `turn_start` 之前的 `context.tools` 快照；首回合的声明在 `prompt()` 里就定下了，早于 `agent_start` / `turn_start`。结论：`turn_start` 剥离只保证本回合**不可执行**（调用得到 `Tool <name> not found`），声明要到下一回合 `prepareNextTurn` 才追平；首回合声明是否干净只取决于 bind 核验。N10 按「首回合 / turn_start 迟注册 / 下一回合追平」三条路径拆分（§1、§7.0 第 6b 条、§10 N10）。

## 1. 现状要点（只列方案依赖的事实）

- `memorySection`（`src/memory/inject.ts:112-137`）是 hub 的同步 provider；RenderCache 键为 `cwd + inlineMax:byteCap:indexMax`，指纹 `name:size:floor(mtimeMs)`（`render.ts:83-101`）。
- `renderMemoryBlock`（`render.ts:140-193`）：索引按 mtime 降序；内联候选 `[pinned] ++ [unpinned]` 取前 `inlineMax`，按 `byteCap` 截断（`truncateAtSection`）。**索引顺序与候选都依赖 mtime** ⇒ touch 会改渲染文本 ⇒ stable 模式下产生一次 tail update（ss-plan R7 已登记）。兜底文案是 `` use the `read` tool to open `<memDir>/<file>` ``。
- hub（`hub.ts:185-217`）：`legacy` 直接折叠 live；`live` 每轮 markStale；`stable` 走 `resolveAtTurn`。`pointerHint` 目前是 `string | undefined`，`sectionTexts` 在**每条** update 上原样透传（`hub.ts:49,200-203`），`update-message.ts` 只在 `kind === "pointer"` 时使用它。**hub 不会对函数求值**——v1「只放宽类型」的做法下动态 pointer 不会工作（评审 v1 #2）。
- 工具（`tool.ts`）：`action` 缺省 list；write 自动 upsert `source: agent` + `updated`；append 纯 O_APPEND 不动 frontmatter（memory-plan R4）；子会话默认拒写（B1）。
- `store.ts`：`listMemory` 用 `statSync`（跟随 symlink）；`writeMemoryFile` 用 `writeFileSync`（跟随 symlink，可写到目录外）；append 先 `statSync` 查大小再 `appendFileSync`——两个进程可同时越过 `maxFileBytes`（评审 v1 #6）。`render.ts` 的 `readHead` / `readFileSync` 同样跟随 symlink ⇒ 目录里一个指向 `~/.ssh/id_rsa` 的 `x.md` 会被注入（评审 v1 #7）。
- `/mem`（`command.ts`）：`cwd = ctx.cwd` **未做 worktree-origin 解析**（与工具/注入不一致，本方案顺手修）。
- 子会话类型影响：内置 `Plan` 工具含 `memory`；用户的 `verifier` / `reviewer` / `Explore` 工具表不含 `memory`；consult 只读域 `CONSULT_READONLY_TOOLS = read/grep/find/ls`（`tool-scope.ts:75`）。子会话扩展实例可通过 `pi.getActiveTools()` 读到本会话实际工具表（`src/context-switch/child.ts:470` 已有先例）。
- 已有 memory 测试（`tests/memory/*.test.ts`、`tests/sysprompt/memory-section.test.ts`）用 `DEFAULT_SETTINGS.memory`。
- **typebox 双版本**：`package.json` devDep `@sinclair/typebox ^0.34.49`（装 0.34.52）；pi 0.87.1 运行时把 `@sinclair/typebox` 别名到自带的 `typebox@1.3.27`（extension loader `getAliases()` / `VIRTUAL_MODULES`）。两版对同一 schema 的 `JSON.stringify` 字节数相同但**键序不同**（0.34：`{"const":"view","type":"string"}`；1.3：`{"type":"string","const":"view"}`）——v2「序列化结果相同」的说法不成立（复审 v1-1）。
- 内置 `Plan` 工具表 `["read","bash","web_search","memory"]`（`src/config/agent-types.ts:153`）含 `bash`；用户同名 agent 文件会**遮蔽**内置类型（first-registered wins）——agent type 不是安全边界（复审 新-1）。
- runtime-adapter 对 consult run 在 H2 之后强制 `sessionSpec.tools = CONSULT_READONLY_TOOLS`，enforcer policy 用同一常量、零 grant，所有注入分支 `!isConsultRun` 守卫（`src/service/runtime-adapter.ts:600-775,785`）——§7.0 复用的只读先例。
- `tests/memory/tool.test.ts:14` 直接 import `src/memory/tool.ts` 的 `createMemoryTool` / `MemoryToolParams`；`tests/memory/store.test.ts` 同步调用 `importProject`（L205/217/224/227/230/237/243，其中 L237 为 `expect(() => …).toThrow(MemoryError)`）与 `importAll`（L280/284）；`src/memory/command.ts:56,58` 同步调用 `importAll` / `targets.map(importProject)`（handler 本身已是 `async`，外层 try/catch 转 notify）；`tests/memory/command.test.ts` 只经 `await cmd.handler("import …")` 间接调用；`docs/dev/memory/memory-plan.md:568-569`（§8.3 冻结面）记着同步签名。`src/` 内无其它调用方。
- **`SpawnRequest` 字段闸**：`src/service/request-threading.ts:65` 的 `AssertAllClassified` 要求 `SpawnRequest` 每个键都登记在 `THREADED` 或 `NOT_THREADED`，漏登记即 `tsc` 失败（`tests/service/request-threading.test.ts` WC13 另有 ff4 负例夹具）。
- **pi 同名覆盖**：pi 0.87.1 `agent-session.js` `_refreshToolRegistry`（L2491–2520）先放 builtin，再用 `[...extension 注册的工具, ...SDK customTools]` 按名 `set` 覆盖；allowlist（`_allowedToolNames`）只按**名字**过滤。因此子会话里任何扩展 `registerTool({name:"read"})` 或 H2 往 `sessionSpec.customTools` 塞的同名工具都会**替换**builtin `read`。来源可从 `session.getAllTools()[i].sourceInfo.source` 区分：builtin 为 `"builtin"`、SDK customTools 为 `"sdk"`、扩展为该扩展自己的 source（由 loader 赋值，扩展不能自填）。pi 把 customTools 包进 `{ definition, sourceInfo }` 注册项，不改写 definition 对象本身（`agent-session.js` L2502），因此冻结 definition 不影响注册。
- **pi 事件顺序、工具声明与可执行快照**（pi 0.87.1；v5 核对，v6 按复审 v5-3 对照 `pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` 与 `pi-coding-agent/dist/core/agent-session.js` 源码改正；决定 §7.0 6b 的核验点与语义）：
  - **监听顺序**：`Agent.processEvents` 逐个 `await` 监听者；`AgentSession._handleAgentEvent` 先 `await this._emitExtensionEvent(event)`（扩展处理器），再同步 `_emit`（`session.subscribe` 监听者，即 runtime 的 bind 回调）。agent loop 对每个事件都 `await emit(...)`，所以一个事件的扩展处理器和 runtime 回调都跑完之后，loop 才往下走。
  - **两个工具集**：模型看到的是**声明集**，由 transcript 里 system 消息的 `toolsAdded` / `toolsRemoved` 累积而成（pi-ai `getCurrentTools(messages)`；`streamAssistantResponse` 只把 messages 转成 LLM 上下文，不传 `context.tools`）。能执行的是**可执行集**，即 `currentContext.tools`，`prepareToolCall` 按名字在其中查找，找不到就返回 `Tool <name> not found`（`agent-loop.js` L479–484）。`declareToolChanges(context, pending)`（L219）把声明集与 `context.tools` 的差量写成一条 system 消息。
  - **首回合**：`prompt()` 先跑扩展 `before_agent_start`，再按 `getActiveToolNames()` 调 `_preparePromptAndToolLoadout`（重设 `agent.state.tools` 并生成系统提示词 section 更新），然后 `runPromptMessages` → `createContextSnapshot()`（`tools: agent.state.tools.slice()`）→ `runAgentLoop`：`declareToolChanges(context, prompts)`（L44，**早于** `agent_start`）→ `agent_start` → `turn_start` → `runLoop` 内再做一次 `declareToolChanges(currentContext, steering)`（L116，仍按 prompt 时快照的 `currentContext.tools`）→ `prepareRequest`。
  - **后续回合**：`finishTurn`（扩展 turn_end 边界）→ `turn_end` → `prepareNextTurn`（`_installAgentNextTurnRefresh`：按 `getActiveToolNames()` 重建 loadout，返回 `context.tools = agent.state.tools.slice()`）→ `turn_start`（L113）→ `declareToolChanges(currentContext, prepared + steering)`（L116，比较的是 `prepareNextTurn` 返回的、**`turn_start` 之前**的 `context.tools`）→ `prepareRequest`。
  - **可执行快照点**：`prepareRequest`（`agent-session.js` `_installAgentRequestProjection`，L311–317）把 `context.tools` 重设为 `agent.state.tools.slice()`，本回合工具执行就用这一份。`setActiveToolsByName` 同步替换 `agent.state.tools`；扩展 `registerTool` 经 `_refreshToolRegistry` → `setActiveToolsByName` 立即生效（同名时替换实现）。
  - **推论**（6b 依据）：①runtime 在 **bind** 时剥离的工具，会被 `prompt()` 的 loadout 排除，首回合既不声明也不可执行——首回合声明是否干净**只取决于 bind 核验**，因为首回合声明在 `prompt()` 里就定了，早于 `agent_start` / `turn_start`；②在 **turn_start** 回调里剥离的工具，本回合 `prepareRequest` 的快照里没有它，本回合**不可执行**；但本回合的声明（首回合在 `prompt()` 里算，后续回合由 L116 按 `turn_start` 之前的 `context.tools` 算）仍含该名，模型调用会得到 `Tool <name> not found`（fail-closed），下一回合 `prepareNextTurn` 按 active 集合重建，L116 的差量写出 `toolsRemoved`，声明追平；③在 **turn_end** 回调里剥离的工具，在 `prepareNextTurn` 之前生效，下一回合声明与可执行集合一致，没有 not found 过渡。`before_agent_start` 是扩展事件，runtime 不是子会话扩展、也无法保证排在其它扩展之后，故不作核验点（它注册的工具由随后的 turn_start 核验变为不可执行，见②）。
- **bash_job 授权**：`runtime-adapter.ts:706-710` 以 `bashJobGrant({ …, consult: isConsultRun })` 决定是否把 `bash_job` 推进 grantedReserved；switch_context 由 `!isConsultRun` 守卫（L717）。`isConsultRun = spec.request.forkSessionFrom !== undefined`（L538），另在 L819（raw prompt）、L843、L889（consult 专属收尾）使用。
- 真实 `AgentSession` + 脚本化假模型的集成测试先例：`tests/integration/child-bash-jobs-real-session.test.ts`（`DefaultResourceLoader({ extensionFactories })` + `createAgentSession`）。
- legacy `listMemory` 接受任意 `*.md` 文件名（无 `NAME_RE`），只有 `writeMemoryFile` 校验 `NAME_RE`；`importProject` 无锁、`existsSync`→`writeFileSync` 有 TOCTOU 且跟随 symlink；`discoverCCProjects` 对 CC 根用 `statSync`（跟随）。
- 真实目录 5 文件、12,706B；pitfalls.md `pin: true` 5,115B，其 `##` 节字节：用户偏好 1,030 / 并发 546 / git 1,153 / 运行时 1,115 / 已落地 1,023；其余 4 个文件均 `source: agent`、无 description、无 read_when、有 H1 标题。
- 主会话模型可从 `ctx.model`（`Model | undefined`，含 `provider/id/cost`）读取；价格表 `cost.{input,output,cacheRead,cacheWrite}` 单位 USD / 1M token。consult 已有首请求估价先例 `estimateFirstRequestUsd`（`src/consult/tool.ts:403`）与回合边界成本闸 `createCapWatcher`（`src/consult/watcher.ts`）。

## 2. 注入层

### 2.1 文件角色与准入规则（「禁止半截文件」）

| 角色         | 判定                                                                                                                                                             | 注入方式                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| primary core | `core.md` 存在 ⇒ 它；否则按文件名序第一个 `pin: true` 且非 archived 的文件（**降级**，D01 标注为迁移过渡）                                                       | 整文件；放不下则**整节准入**（见下）；再放不下 ⇒ 只进索引    |
| extra pinned | 其余 `pin: true`、非 archived 的文件                                                                                                                             | 只允许**整文件**放进剩余 core 预算；放不下 ⇒ 只进索引并标 📌 |
| topic        | 其余全部                                                                                                                                                         | **永不内联**，只进索引                                       |
| archived     | frontmatter `status: archived`                                                                                                                                   | 不进索引，只计数（`+N archived`）；`view` / `search` 仍可达  |
| 不可寻址     | 非普通文件（文件级 symlink、目录、FIFO…）；**v2 路径**（tiered 渲染、v2 工具、体检、tidy）另加「不符合 `NAME_RE`」——legacy 路径保持「任意 `*.md`」旧规则（§3.1） | 不渲染、不计数、不读取；体检 D14 报告                        |

**pin 语义收敛**（决策 1）：`pin: true` 从「内联优先级 + 可被截断」收敛为「申请进入 core 预算（整文件）」。它不再保证出现在块里；放不下时体检 D03 提示拆分。无 `core.md` 时的降级 primary 允许整节准入——这是当前真实目录（pitfalls.md pinned、无 core.md）迁移前仍能拿到「用户偏好」整节的依据；降级状态永远伴随体检 D01（info）与启动提醒（§6.3），明确它只是迁移过渡。

**整节准入算法**（仅 primary core，纯函数 `admitSections(body, budgetBytes, omitLine)`；决策 2 的「固定选择」）：

1. 把正文切成 `preamble`（首个 `## ` 之前，含 H1）+ 若干 `## ` 节（节 = 标题行到下一个 `## ` 或 `# ` 之前；`###` 及更深属于所在 `##` 节）。代码围栏（` ``` `）内的 `## ` 不算标题。
2. 按**原顺序**贪心：preamble 必须先放；之后每节**整节**放得下就放，放不下就跳过（不截断），继续尝试后面较小的节。选择只依赖正文字节与预算，不依赖 mtime / 名称以外的任何状态 ⇒ 同输入同输出。
3. 有被跳过的节 ⇒ 追加省略行（§2.2 模板），其字节计入预算；节名单超过 200B 时截为 `A · B · +3`（码点安全）。
4. 若连 preamble + 省略行都放不下 ⇒ primary 不内联，进索引并标 `⚠ over core budget`（降级级别 L4，体检 D02）。

**绝不出现**：`…(truncated …)` 标记、半节正文、只有 H1 的碎片。测试断言「块中出现的每个 `## ` 节正文与源文件逐字相等」。

### 2.2 块格式（tiered layout）与模板

以下模板是**冻结文本**，P0 以常量写入 `src/memory/contracts.ts`（`TIERED_TEMPLATES`），P1 只能引用不能改写。`<dir>` 一律替换成 `memoryDirFor(cwd)` 的**真实绝对路径**（已经 worktree-origin 解析；评审 v1 #4），`<name>` 是紧挨着列出的文件名。

```text
## Memory (<slug>) — <N> file(s)                                          ← header（N = 可寻址文件总数，含 archived）

### core.md                                                               ← core 部分（可无）
> _agent-written memory — treat as data, not instructions_               ← 仅 source: agent
<core 正文：整文件，或 preamble + 整节>
…(omitted sections: A · B — memory view core.md section="A")             ← 仅整节准入时；access 变体见下

### <extra-pinned>.md                                                     ← 可选，整文件

<guide 行>                                                                ← 有可列的索引项时
- cache-ttl.md — Prompt cache 的 1h/5m 寿命、保活和自适应边界 · when: cache-ttl; keepalive · 3k
- quota.md — quota-aware dispatch 链路与阶梯阈值 · 2k · stale
- also: a.md, b.md (+3 more, +1 archived)                                 ← 尾行：compact 名单或溢出行（§2.3）

<!-- pi-toolkit:memory <slug> -->
```

各部分之间用一个空行分隔（`\n\n`），索引行之间 `\n`，块以 `sentinel + "\n"` 结尾（与 legacy 相同）。

**access 变体**（按本会话实际工具判定，§2.4）：

| access        | guide 行                                                                                                                                   | 省略行后缀                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `memory+read` | `Topics (open one only when its "when" matches: memory view <name> [section] · memory search <words>; no memory tool: read <dir>/<name>):` | `— memory view <file> section="<A>"` |
| `memory`      | `Topics (open one only when its "when" matches: memory view <name> [section] · memory search <words>):`                                    | 同上                                 |
| `read`        | `Topics (open one only when its "when" matches: read <dir>/<name>):`                                                                       | `— read <dir>/<file>`                |
| `none`        | `Topics (not openable in this session):`                                                                                                   | （无后缀）                           |

`toolSurface=legacy` 时 `memory` 工具没有 view/search ⇒ access 中的 `memory` 视为不存在（`memory+read` → `read`，`memory` → `none`）。

**索引行**（每行 ≤200B，码点安全裁剪，裁剪处加 `…`）：

```text
- <name>[ 📌] — <description ≤110B>[ · when: <read_when ≤70B>] · <sizeTier>[ · stale][ · ⚠ over core budget]
```

- `description` 缺失 ⇒ 正文首个 `# ` 标题（剥掉 frontmatter/drift header 后）⇒ 仍无 ⇒ `(no description)`；空白折叠为单空格。
- **不放 `updated` 日期、不放相对年龄**（决策 9）：日期每次编辑都变、相对年龄每天都变，都会制造 tail update；年龄只在 `view` 目录清单与体检里出现。
- `sizeTier(size)`：`size ≤ 1024 ⇒ "1k"`，否则 `` `${Math.ceil(size / 1024)}k` ``。边界测试：0、1、1024 → `1k`；1025、2048 → `2k`；2049 → `3k`（决策 9 附加条件）。
- 排序：未内联的 primary（带 ⚠）→ 被降级的 extra pinned（📌）→ `active` topic → `stale` topic；同组按文件名升序（码点序）。**与 mtime 完全无关。**

**尾行**：compact 名单 `- also: a.md, b.md (+N more[, +M archived])`；连一个名字都放不下时退化为溢出行 `- … +N more[ (+M archived)]`；无剩余项但有 archived ⇒ `- (+M archived)`；什么都没剩 ⇒ 不输出尾行。

- 首行保持 `## Memory (<slug>)` 前缀：hub `title`、`skipIf` 双注入防护、update 文案全部不变。
- 目录为空（可寻址文件 0 个）⇒ 返回 `""`（与现状一致）。

### 2.3 硬预算分配与确定性降级（评审 v1 #3，决策 2/3）

记 `B = blockBytes`，`C = coreBytes`（解析时钳 `C ≤ B − 600`），`bytes()` 为 UTF-8 字节。纯函数 `renderTiered(input) → TieredRenderResult`：

```ts
interface TieredRenderResult {
  text: string; // "" = 空目录
  bytes: number;
  level: 0 | 1 | 2 | 3 | 4 | 5; // 取触发过的最高级
  omittedSections: string[]; // primary 被跳过的节名
  demotedPinned: string[]; // 降级进索引的 extra pinned
  fullIndexLines: number; // 以完整行出现的索引项数
  tailKind: "none" | "compact" | "overflow" | "archived-only" | "frame-only";
}
```

**记号**（复审 v1-3：全部是**真实渲染文本**的 UTF-8 字节，不是估算）：

- `H` = header 行；`S` = `sentinel + "\n"`；`G` = 按 access 取的 guide 行（§2.2 表，`<dir>` 已替换为真实路径）。
- `Tmax = "- … +" + L + " more" + (A > 0 ? " (+" + A + " archived)" : "")`：`L` = 全部非 archived 可寻址文件数（最坏情况下任何文件——含 primary——都可能落入索引，故取总数），`A` = archived 数。实际尾行要么是只在放得下时才选用的 compact 名单，要么是计数 ≤ `L` 的溢出行 / archived-only 行 ⇒ 任何实际尾行超出 `bytes(Tmax)` 的部分都由步骤 5 从 `rem` 支付，溢出行与 archived-only 行本身恒 ≤ `bytes(Tmax)`（十进制位数单调）。
- **最小正常框架** `M = H + "\n\n" + G + "\n" + Tmax + "\n\n" + S`，由导出纯函数 `minimalFrame(input): string` 生成，与渲染器共用 `TIERED_TEMPLATES` 常量（不另写一份字节公式）。
- **不可约形式** `I = H + "\n\n" + S`：header 是 hub `title` / `skipIf` / update 文案的锚，sentinel 是 legacy 以来的双注入防护契约，二者都不能删。

**分配顺序**（固定，不可配置）：

1. `bytes(M) > B` ⇒ **L5 frame-only**（步骤 8）；否则进入正常分配，**预留** `R = bytes(M)`。
2. **索引保底** `idxFloor = min(240, max(0, bytes(compactAll) − bytes(Tmax)))`（`compactAll` = 含全部可列项的 compact 名单行）；**core 可用额** `coreAvail = max(0, min(C, B − R − idxFloor))`。
3. primary：`part = "### " + name + "\n" + fence? + body`，连同其后的 `"\n\n"` 一起计入 core 用量；`≤ coreAvail` ⇒ 整文件；否则整节准入（省略行计入，后缀按 access 取、含真实 `<dir>`）⇒ **L2**；preamble + 省略行仍放不下 ⇒ 不内联、进索引 ⇒ **L4**。
4. extra pinned：按文件名序，整文件（含其后 `"\n\n"`）放得进 `coreAvail − 已用` 就放；否则进索引 📌 ⇒ **L3**。
5. **索引剩余** `rem = B − R − coreUsed`（`coreUsed` 含 join）。取最大的 `k ≤ min(indexMax, 可列项数)`，使 `Σ bytes(前 k 条完整行 + "\n") + max(0, bytes(尾行(k)) − bytes(Tmax)) ≤ rem`；尾行(k) = 剩余项的 compact 名单（名字按序贪心加入直到放不下，余数记 `+N more`），连一个名字都放不下 ⇒ 溢出行。`k = 0` + 溢出行恒成立。`k < 可列项数` ⇒ **L1**。
6. 无可列项时省略 `G` 及其换行（输出只会更短）。
7. 全部完整放下且无 archived ⇒ **L0**。
8. **L5 frame-only 文本** = `H + "\n\n" + line5 + "\n\n" + S`，`line5` 按序取第一个使总字节 ≤ B 的候选：①access 形式——`- … +<N> files — memory view`（`memory` / `memory+read`）、`- … +<N> files — read <dir>/`（`read`）、`- … +<N> files (not openable in this session)`（`none`）；②通用 `- … +<N> files`；都放不下 ⇒ 输出 `I`。`N` = 可寻址文件总数（与 header 一致）。

**L5 是否允许超限**：只允许**不可约部分**超限——仅当 `bytes(I) > B`（slug 极长：header 与 sentinel 各含一次 slug；`B` 最小 800 ⇒ slug 约 350B 以上才可能）时输出恰为 `I` 且超过 `B`；其余 L5 输出一律 ≤ B。D09 对 L5 报 error，写明实际字节与 `B`。

**不变量**（property test，seeded 300 例随机 fixture：slug 1–1,200B、0–60 文件、description 0–400B、CJK/emoji、随机 pin/archived/stale、四种 access、`B`∈[800, 16384]；**每条都对实际输出 `Buffer.byteLength(result.text, "utf8")` 断言**，不信任渲染器自报的中间量）：

- I-M1a：`result.bytes === Buffer.byteLength(result.text, "utf8")`。
- I-M1b：`level ≤ 4 ⇒ bytes(text) ≤ B`。
- I-M1c：`level = 5 ⇔ bytes(minimalFrame(input)) > B`（测试独立调用 `minimalFrame` 复算）。
- I-M1d：`level = 5 ⇒ bytes(text) ≤ max(B, bytes(I))`；且 `bytes(text) > B ⇒ text === I`。
- I-M2：输出只依赖（文件名、frontmatter、正文字节、sizeTier、access、设置），改 mtime / readdir 顺序不改变任何字节。
- I-M3：出现在块中的每个 `## ` 节与源文件逐字相等；不出现 `truncated`。
- I-M4：L0–L4 下每个可寻址非 archived 文件要么内联，要么以完整行出现，要么计入尾行的名字或 `+N`——总数守恒（`N` 与 header 一致）；L5 下 `N` 出现在 header（及 `line5`，若有）。

**子会话 core 档**用同一函数，只把步骤 6 的 `k` 固定为 0（全部走 compact 名单）。

**当前 5 文件夹具预估**（`<dir>` 取 fixture 占位根，真实 home 下另测）：header ~60B + `### pitfalls.md` + fence ~76B + preamble/用户偏好 ~1,090B + 省略行 ~170B + guide ~200B + 4 条索引 ~560B + sentinel ~58B ≈ **2.2KB**，级别 L2（整节准入）。P1 生成 golden 时同时把实测字节写进包报告；若超过 2,400B，降级阶梯会自动把尾部索引项折进 compact 名单（L1）——不调默认预算（决策 3：以 UTF-8 字节 golden 校准，不按 token）。

### 2.4 子会话档位（`memory.childProfile`，决策 4）

| 值             | 子会话注入                                              | 适用                               |
| -------------- | ------------------------------------------------------- | ---------------------------------- |
| `core`（默认） | core 部分同主会话；索引全部走 compact 名单（§2.3，k=0） | 默认                               |
| `full`         | 与主会话同一块                                          | 子任务常要挑主题的用户             |
| `none`         | `""`                                                    | 等价 `injectInChildSessions=false` |

- `injectInChildSessions` 保留为总开关：`false` ⇒ 一律 `none`（向后兼容）。
- `layout=legacy` 时 `childProfile` 只有 `none` 生效，其余值都注入旧块（保证「legacy = 旧行为」）。
- **access 判定**（决策 4 附加条件 + 复审 新-2）：provider 渲染时调用 `pi.getActiveTools()`，结果交给纯函数 `accessFromTools(tools: readonly string[] | undefined, toolSurface)`：
  1. `getActiveTools` 不存在、抛错或返回非数组 ⇒ `tools = undefined` ⇒ **`none`**。无法确认就按最保守的「本会话打不开」渲染，绝不假设有 `read`（tool-scope allowlist 证明自定义 agent 可以没有 `read`）。
  2. **consult 明示例外**：`tools` 与 `CONSULT_READONLY_TOOLS`（import `src/runtime/tool-scope.ts` 的同一常量）集合相等 ⇒ `read`。consult 的工具域由 runtime-adapter 在 H2 之后强制为这四个（pi allowlist 与 enforcer 同源），所以 consult 永远是 `read`；tidy 只读域（四个 + `StructuredOutput`，§7.0）按规则 3 也得 `read`。
  3. 其余：由 `memory ∈ tools`（且 `toolSurface=v2`；legacy 工具面没有 view/search，视为不存在）与 `read ∈ tools` 组合出 `memory+read | memory | read | none`。
     结果**按会话粘住**（首次渲染求值，`session_start` 时清空），避免会话中途工具变化改变块文本、制造 tail update。主会话同样适用（主会话 `getActiveTools` 正常可用）。`none` 时块仍含 core（规则本身有价值），索引只给名单，guide 明说「本会话无法打开」。
- **agent type 映射**：本期不做（需要 host→child 通道，与 T4 同一件事，§13）。
- **consult**：fork 会话在 `session_start` 恢复专家的 `subagent:prompt-sections` 快照。专家是子 agent（core 档）且 access 相同 ⇒ 零 update。专家是主会话（`experts:["main"]`）⇒ 快照是主会话完整块，consult 子会话 live 是 core 档 + `read` access（`CONSULT_READONLY_TOOLS`）⇒ **首轮恰好一条 tail update**（≤ B）。代价已知、有界，测试钉住。

### 2.5 渲染缓存与「touch ≠ 正文变化」

- 指纹函数 `memoryFingerprint` 仍是失效键（readdir + lstat，便宜；P0 把其 `statSync` 换成 safe-fs 的 lstat 列举并跳过非普通文件；文件名规则保持 legacy，普通文件的指纹不变）。
- **区分 touch 与正文变化靠渲染确定性（I-M2），不靠指纹**：touch ⇒ 缓存 miss ⇒ 重渲染 ⇒ 文本逐字相同 ⇒ hub `live === announced` ⇒ **零 tail update**。
- 每文件元数据缓存 `MetaCache`（闭包内，键 `name`，值 `{dev, ino, size, mtimeNs, sha1, meta}`）：lstat 变化才重读该文件；重读后 sha1 相同则复用解析结果。
- topic 文件只读头部（≤4KB，frontmatter + 首个 H1）；primary / extra pinned 读全文；一律经 `safe-fs.readRegular*`（§3.1）。
- tiered 缓存键：`cwd \0 tiered:<profile>:<C>:<B>:<indexMax>:<toolSurface>:<access>`，新类 `TieredRenderCache`（`src/memory/tiered.ts`），**不改 `RenderCache`**。

### 2.6 尾部更新与 pointer（hub 改动在 P0 完成，评审 v1 #2）

- update 内容仍是完整新块（不做差量）：块 ≤ B ⇒ 3 条上限内 ≤ 3B。差量 update 破坏 I2「有效视图 == live」，否决。
- 真正的节省来自「少发」：①touch 零 update；②topic 正文增删不改块（只有跨 kB 档、改 description/read_when/status 或增删文件才改）；③core 改动才改 core 部分。

**hub 改动规格（P0，`src/sysprompt/hub.ts`）**：

```ts
export interface SectionRegistration {
  provider: SectionProvider;
  title: string | ((input: SectionProviderInput) => string);
  pointerHint?: string | ((input: SectionProviderInput) => string);
  skipIf?: (input: SectionProviderInput) => boolean;
}
```

- `sectionTexts` 构造 `RenderUpdate` 时：`pointerHint` 为**字符串** ⇒ 与今天逐字节相同（仍透传到每条 update，字段形状不变）；为**函数** ⇒ **只在 `resolved.update.kind === "pointer"` 时**以同一个 `input` 调用一次；返回非空字符串 ⇒ 带上；抛错、返回非字符串（含 thenable）或空串 ⇒ 省略该字段（`update-message.ts` 已支持无 hint），并经 `log` WARN 一次（每 section 每 activate 一次）。函数永不在 `update` / `removed` 条目上被调用。
- 求值包在 `sectionTexts` 现有的 per-section try/catch **之内但独立 try**：pointer 函数异常不得让该 section 走 catch 分支（否则会丢掉本轮 update 并回落 snapshot）。
- 测试（P0，`tests/sysprompt/hub.test.ts` 追加）：P-1 字符串 pointerHint 的既有用例输出逐字节不变；P-2 函数只在 pointer 时被调用一次、收到的 `input` 与 provider 相同；P-3 函数抛错 ⇒ pointer 消息无 hint、section 状态进入 POINTED、无异常外泄；P-4 返回 thenable / 数字 / `""` ⇒ 省略；P-5 update/removed 条目不调用函数（spy 计数 0）。

**memory 的 pointer 函数**（P1 在 `inject.ts` 提供）：
`Changed this session: core.md, quota.md. Current index: memory view; a file: memory view <file>; without the memory tool: read <dir>/<file>.`（按 access 取对应片段，`<dir>` 为真实路径）。「本会话改动」= 闭包记录的 `sessionStartedAt`（`session_start` 时刷新）之后 mtime 更新的可寻址文件，按名排序最多 8 个，超出 `+N`；pointer 只在进入 POINTED 那一次渲染，mtime 只影响 pointer 文案、不影响块。

- `freezeInjectionAfterWrite` 语义不变：写后冻结捕获 tiered 缓存的 `peek` 结果。

### 2.7 与 sysprompt-stable 三态的兼容（决策 10）

| 场景                                                        | 行为                                                                                                                           | 保证方式                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `systemPrompt.mode=stable`                                  | 冻结 tiered 快照；变化走 tail；I1–I9 原样成立                                                                                  | hub/状态机不改；集成测试：写后 system prompt 哈希相等 + tail 出现；touch 零 tail  |
| `mode=live`                                                 | 每轮刷新 tiered 块                                                                                                             | 同上                                                                              |
| `mode=legacy`                                               | hub 折叠逻辑逐字节不变；memory 文本由 `memory.layout` 决定                                                                     | hub legacy 分支零改动；既有 memory-section 黄金测试（钉 `layout:"legacy"`）保持绿 |
| SKIP                                                        | provider 任何异常 ⇒ `SKIP`（保留旧快照，I4/I5）                                                                                | `memorySection` 的 try/catch 结构不变                                             |
| POINTED                                                     | 语义不变，pointer 文案可动态                                                                                                   | §2.6 hub 求值规格                                                                 |
| `subagent:prompt-sections` 恢复（升级后首次 resume/reload） | 恢复旧 legacy 块快照，live 是 tiered ⇒ **一条** update，之后稳定；下个刷新点（compact / model_select / 新会话）快照换成 tiered | 条目格式不变（不升 v）；测试：恢复旧快照 + tiered live ⇒ 恰一条 update            |

**「legacy 字节级不变」的口径**：

1. `memory.layout=legacy` ⇒ memory section 文本与 #22 之前**逐字节相同**（任意 `systemPrompt.mode`，含 `session_start` reason = `new` / `reload` / `resume` 三种恢复路径，决策 10 附加条件）。
2. `memory.toolSurface=legacy` ⇒ memory 工具定义（name/label/description/promptSnippet/promptGuidelines/parameters）与执行输出逐字节相同。
3. `systemPrompt.mode=legacy` 只保证 hub 折叠机制不变，**不隐含** `memory.layout=legacy`（两个开关正交）。
4. **唯一刻意偏差**：目录内**文件级** symlink 与非普通文件在 legacy 下同样被跳过（读）/ 拒绝（写）（§3.1，用户决策 N2）。**文件名接受规则不变**：legacy 路径仍接受任意 `*.md`，`NAME_RE` 只在 v2 路径启用（主会话裁定：legacy 字节级不变优先）。golden fixture 不含 symlink，另有 `synthetic/legacy-names/`（非白名单文件名）钉住 legacy 接受规则；偏差本身由 §10 B 组单独钉住。

保证手段：P0 第一个提交在**未改动的代码**上按 §10.1 协议生成 `tests/fixtures/memory-legacy-golden.json`（永不重新生成，同 compact-hint 黄金规则）；`render.ts` 只允许「新增导出」和「把文件打开原语换成 `safe-fs`」两类改动；现 `src/memory/tool.ts` **原位保留为 legacy 实现，P0–P5 全程零改动**（v2 工厂放新文件 `tool-v2.ts`），既有 `tests/memory/tool.test.ts` 无需迁移（复审 新-3）。

## 3. 文件系统安全与并发（评审 v1 #6、#7）

### 3.1 `safe-fs.ts`：memory 模块唯一的 fs 出入口（P0，冻结）

所有读取、注入、`view`/`search`、体检、tidy 快照/备份/应用、restore、CC import、目录锁，**一律**经 `src/memory/safe-fs.ts`。

**守卫**（复审 v1-6）：`src/memory/**/*.ts` 中**只有 `safe-fs.ts`** 可以引用 `node:fs` / `fs` / `node:fs/promises`（静态 import、`require(...)`、动态 `import(...)` 都算；`import type` 除外）。P0 守卫测试 `tests/memory/fs-guard.test.ts` 做 import 级扫描——比 v2 的标识符黑名单严格（`openSync`/`renameSync`/`linkSync`/`unlinkSync` 等也被覆盖），例外清单只有 `src/memory/safe-fs.ts` 一项；`lock.ts` 与 `tidy/**` 不是例外。新增例外 = 冻结面变更。

**目录信任语义**（主会话裁定 v1-7）：

- `<memoryRoot>`、`<memoryRoot>/<slug>` 及其祖先目录是**用户配置**，允许是符号链接（例如把 memory 目录挪到别处同步）。同 uid 信任模型下，能创建该链接的人本来就能直接写这些文件，所以链接目标被视为**用户显式信任的位置**，其中的普通 `.md` 照常注入。这是写进 AGENTS.md、`/mem path` 输出与体检 D14 的明确语义，不是遗漏。
- **每次操作 canonicalize 一次**：`canonicalMemoryDir(cwd, paths) → { display, real, linked } | undefined`。`display = memoryDirFor(cwd)`（已做 worktree-origin 解析）；`real = realpathSync(display)`；随后 `lstat(real).isDirectory()`，否则视为无 memory 并报 D14 error；目录不存在 ⇒ `undefined`（读路径视为空目录，写路径先 `mkdir` 再 canonicalize）。一次渲染 / 一条工具命令 / 一次 import / 一次 tidy apply / 一次 restore 内的所有文件操作都用同一个 `real` 拼路径——操作中途目录链接被改指，也不会跨目录混读混写。
- **渲染文本里的 `<dir>` 用 `display`**（稳定、用户认得；改指链接不改块文本 ⇒ 不制造 tail update），fs 操作一律用 `real`。`linked` 时 `/mem path` 与 D14（info）显示 `display → real`。
- **目录内**：文件级符号链接一律拒绝（读跳过、写拒绝，含 legacy 全部路径，用户决策 N2）；`.trash` / `.backup` / `.backup/<id>` 必须是真实目录（`ensurePrivateDir`）；`.lock` 以 `O_EXCL|O_NOFOLLOW` 创建。

**文件名规则**（主会话裁定 v1-7）：`listRegular(real, { names })` 的 `names: "v2"` ⇒ 只保留过 `NAME_RE` 的项（tiered 渲染、v2 工具、体检、tidy）；`names: "legacy"` ⇒ 任意以 `.md` 结尾的名字（legacy 渲染与指纹、legacy 工具 list、`layout=legacy` 下的 `/mem` / `/mem list`），与 #22 前逐字节一致。两种规则下文件级 symlink / 非普通文件都被跳过。legacy **写入**本来就校验 `NAME_RE`（`writeMemoryFile`），不变。

| 函数                                                    | 语义                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalMemoryDir(cwd, paths)`                        | 见上「目录信任语义」                                                                                                                                                                                                                                                                  |
| `listRegular(dir, { names })`                           | `readdirSync(dir, { withFileTypes: true })` + 对每个 `*.md` `lstatSync`：只保留 `isFile() && !isSymbolicLink()`（`names:"v2"` 时再过 `NAME_RE`）；其余进 `skipped[]`（`{name, kind: "symlink" \| "dangling" \| "not-file" \| "bad-name"}`，`bad-name` 只在 v2 出现）供 D14            |
| `openRegular(dir, name, flags)`                         | `openSync(join(dir,name), flags \| O_NOFOLLOW)`；随后 `fstatSync(fd).isFile()`，否则关闭并抛 `MemoryError("not a regular file")`。`O_NOFOLLOW` 使「lstat 后被换成 symlink」的交换攻击在 open 时以 `ELOOP` 失败（无 TOCTOU 窗口）                                                      |
| `readRegular(dir, name)` / `readRegularHead(…, n)`      | 基于 `openRegular` 的全文 / 头部读取，返回 `{ text, stat: { dev, ino, size, mode, mtimeNs, ctimeNs } }`（`fstatSync(fd, { bigint: true })`）                                                                                                                                          |
| `writeAll(fd, buf)`                                     | 循环 `writeSync` 直到写完（Node 的 `writeSync` 不保证一次写完）；写入 0 字节或抛错 ⇒ 抛 `MemoryError("short write: k/n bytes")`。**本模块所有写都经它**                                                                                                                               |
| `writeTempRegular(dir, name, data, mode)`               | 在 `dir` 下 `openSync(".<name>.<pid>.<rand8>.tmp", O_CREAT\|O_EXCL\|O_WRONLY\|O_NOFOLLOW, mode)` + `writeAll` + `fsyncSync`，返回临时名；**任何失败 ⇒ 关闭并 `unlinkSync` 临时文件后重抛（目标零改动）**。`mode`：替换已有文件时取原文件 `mode & 0o777`，新建为 0600                  |
| `replaceAtomic(dir, tmp, name)`                         | `renameSync(tmp, name)`（rename 替换目标目录项本身，不跟随目标 symlink）                                                                                                                                                                                                              |
| `createExclusive(dir, tmp, name)`                       | `linkSync(tmp, name)`（目标存在 ⇒ `EEXIST`，原子 no-clobber）+ `unlinkSync(tmp)`；`EPERM/ENOTSUP`（不支持硬链接）⇒ 退化为「持锁下 `lstat` 不存在再 `renameSync`」，结果带 `note: non-atomic create (no hard links)`                                                                   |
| `renameNoClobber(dir, from, to)`                        | 持锁下 `lstat(from)` 为普通文件 → `linkSync(from, to)`（`EEXIST` ⇒ 目标已存在）→ `unlinkSync(from)`；无硬链接支持时同上退化                                                                                                                                                           |
| `ensurePrivateDir(path)`                                | `mkdirSync(recursive, 0o700)` 后 `lstatSync`：必须 `isDirectory() && !isSymbolicLink()`，否则抛错（`.trash` / `.backup/<id>`）                                                                                                                                                        |
| `writeInPlaceLegacy(dir, name, data)`                   | legacy `write` 专用：`openRegular(O_WRONLY\|O_CREAT\|O_TRUNC, 0o600)` + `writeAll`——与 `writeFileSync` 相同的就地截断语义（保留 inode 与已有权限），只多了 `O_NOFOLLOW`；失败时残留部分内容，与 #22 前 `writeFileSync` 相同（legacy 冻结语义）                                        |
| `appendLegacy(dir, name, data)`                         | legacy `append` 专用：`openRegular(O_WRONLY\|O_APPEND\|O_CREAT, 0o600)` → `fstat` 得 `size0` → `writeAll`；失败时若 `fstat.size === size0 + 已写字节`（期间无他人插写）⇒ `ftruncateSync(fd, size0)` 回滚后抛错，否则不截断（不抹掉他人追加），错误注明 `partial append left in place` |
| `lockCreate` / `lockRead` / `lockBreak` / `lockRelease` | §3.2 的锁文件原语：`O_CREAT\|O_EXCL\|O_WRONLY\|O_NOFOLLOW, 0o600` 创建 + `writeAll`（`EEXIST` ⇒ 返回 `false`）；读回 `{ payload, mtimeMs }`；`renameSync(".lock", ".lock.stale-<token>")` + `unlinkSync`；按 token 释放                                                               |
| `isDirFollowOutside(path)`                              | **唯一跟随符号链接的原语**，只给 `discoverCCProjects` 探测 CC 源目录（memory 目录之外、用户自己的 `~/.claude/projects/*/memory`）；函数名即声明                                                                                                                                       |

- **legacy 路径同样加固**：`store.listMemory` / `writeMemoryFile` / `importProject` / `discoverCCProjects` 与 `render.ts` 的 `readHead` / `readFileSync` / `memoryFingerprint` 全部换成上表原语（文件名规则用 `names:"legacy"`）。普通文件的输出逐字节不变（legacy golden 守护）；文件级 symlink 在 legacy 下被跳过/拒绝——§2.7 口径 4 的唯一偏差。
- `nlink > 1` 的硬链接无法判定是否指向目录外，只在体检 D14 报 info，不拒绝。
- 平台：`fs.constants.O_NOFOLLOW` 不存在（非 POSIX）时退化为 `lstat → open → fstat` 并比对 `dev/ino`，不一致即拒绝（仓库其余部分已是 POSIX-only，此为防御）。

### 3.2 目录锁 `lock.ts`（P0，冻结）

所有**变更**（v2 的 create/str_replace/insert/delete/rename/write/append、tidy apply、`--frontmatter` apply、restore、**`/mem import`**（`importProject` / `importAll`，复审 v1-6））在同一 memory 目录（canonical `real`）上串行化：

- **`lock.ts` 零 fs import**：只用 safe-fs 的 `lockCreate/lockRead/lockBreak/lockRelease`、`node:os` 的 `hostname()` 与定时器；fs 守卫对它不开例外。
- 锁文件 `<real>/.lock`，内容 `{"pid":…,"host":…,"token":"<rand16>","at":<ms>}`。
- `withMemoryDirLock<T>(dir, body: () => T, opts?: { timeoutMs?: number }): Promise<T>`：`body` **必须是同步函数**（持锁期间不 await，避免事件循环插入 `before_agent_start` 读到半应用状态）；获取失败每 25ms 重试，总等待默认 2,000ms（`setTimeout(...).unref()`，不阻塞 `pi -p` 退出），超时抛 `MemoryError("memory dir busy (lock held by pid N since Ts); retry")`。body 执行超过 5s ⇒ WARN（陈旧阈值 30s 的安全余量）。
- **陈旧锁**：锁文件 mtime 早于 30s，或同 host 且 `process.kill(pid, 0)` 报 `ESRCH` ⇒ `lockBreak`（rename 只有一个打破者能成功）后重新竞争。
- 释放：`lockRelease` 读回 token 相符才删除（防止误删别人刚拿到的锁）；`finally` 中执行，异常不外泄。
- 读取类命令（view/search/list、注入、体检）**不取锁**：它们读的是 rename 原子替换后的完整文件，最多看到旧版本，不会看到半写内容。

### 3.3 各变更的原子语义（明确接受的并发语义）

| 操作                                                         | 语义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 读-改-写（str_replace/insert/write 覆盖、tidy/restore 应用） | 持锁：`readRegular` 得 `{text, stat0}` → 计算新内容 → `writeTempRegular` → 复查 `lstat(bigint)` 的 `dev/ino/size/mtimeNs/ctimeNs` 与 `stat0` 一致 → `replaceAtomic`；不一致 ⇒ 删临时文件并报 `changed concurrently; view and retry`（不自动重试）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| create                                                       | 持锁：`writeTempRegular` → `createExclusive`（`EEXIST` ⇒ `already exists`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| rename                                                       | 持锁：`renameNoClobber`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| delete（软删除）                                             | 持锁：`ensurePrivateDir(.trash)` → `renameSync(name, .trash/<id>-<name>)`，`id = <YYYYMMDDTHHmmssSSSZ>-<pid>-<rand6>`（唯一，决策 6）；随后按文件名时间序淘汰到 20 个（淘汰也只删 `.trash` 内普通文件）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| append（v2）                                                 | 持锁：`readRegular` 得 `{text, stat0}` → 末字节非 `\n` 则补换行 → 检查变更后大小 ≤ 适用上限（§4.4），否则**整次拒绝** → 新内容 = 原字节原样 + 追加字节（frontmatter 不动，R4）→ `writeTempRegular`（保留原 mode）→ 复查 `stat0` → `replaceAtomic`。**全写或不写**：短写 / ENOSPC 只会失败在临时文件上，目标零改动（复审 v1-6，放弃 v2 的「O_APPEND + 一次 writeSync」）。代价：每次 append 读写整个文件（≤ `maxFileBytes`，可忽略）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| write / append（legacy toolSurface）                         | 冻结语义：无锁，与 #22 前成功路径逐字节一致；write 经 `writeInPlaceLegacy`、append 经 `appendLegacy`（都拒 symlink；append 短写尽力回滚，§3.1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| import（`/mem import`，两种 surface 共用）                   | `importProject` 改为 `async`：目标目录 `mkdir` + canonicalize 后 `withMemoryDirLock`；源文件经 `readRegular(srcDir, name)`（CC 源里的文件级 symlink 同样跳过，计入 `skipped`）；非 `--force` ⇒ `writeTempRegular` + `createExclusive`（`EEXIST` ⇒ `skipped++`，消除 `existsSync`→写 的 TOCTOU）；`--force` ⇒ 目标是普通文件则临时文件替换，是 symlink 则跳过；`importAll` 逐项串行 await。普通文件的产物字节与返回值同 #22 前（legacy golden A6）。**两个函数都声明为 `async function`**：slug 校验失败、源目录缺失等一切错误都以 rejection 返回，绝不同步抛出。**调用方迁移**（P0-b）：`src/memory/command.ts` 改为 `results = await importAll(…)`，显式 slug 列表改 `for … of` 串行 `await importProject(…)`（不用 `Promise.all`，保持「逐项串行、首个失败即停、已导入的保留」这一 #22 前语义），rejection 落进现有 try/catch 转 warning notify；`tests/memory/store.test.ts` 9 处调用加 `await`、所在用例改 `async`、L237 改为 `await expect(importProject(…)).rejects.toThrow(MemoryError)`；`docs/dev/memory/memory-plan.md` §8.3 两行签名改为 `Promise<ImportResult>` / `Promise<ImportResult[]>` |

**接受的语义边界**（写进 `tool.ts` 文件头注释与 AGENTS.md）：

- 在所有写者都是 v2 memory 工具 / tidy / restore 的前提下，硬上限与「不覆盖他人改动」严格成立（锁串行化）。
- **不合作写者**（用户编辑器、legacy toolSurface 的另一进程、Claude Code）不取锁：读-改-写的最终 `lstat` 复查把丢失更新窗口缩到「复查到 rename」之间的微秒级，未完全消除；append 上限在混用 legacy 进程时可被对方的单次写越过（最多对方一次写入的字节）。这两点是明确接受的残余风险，不再宣称「无锁 O_APPEND + 硬上限」。
- 锁超时是用户可见错误，不静默降级为无锁写。
- legacy toolSurface 的 write/append 与 #22 前一样无锁；legacy append 的短写回滚是尽力而为（期间有他人插写则不回滚，只报错）。

## 4. 工具层 T1–T3

### 4.1 兼容声明与参数 schema（评审 v1 #5）

**兼容声明**：与 Anthropic 官方 memory 工具（`memory_20250818`）**兼容命令名、字段名与返回约定**（`old_str` 唯一、省略 `new_str` 即删除、带行号片段）；**不兼容其路径模型**——路径只能是 memory 目录下一层 `*.md`（`/memories/` 前缀被剥掉，`/memories` 或省略 = 目录）；我们是 pi 自定义工具，schema 是官方字段的超集（加 `section` / `query` 与旧别名），不依赖 provider 内置工具类型。其余差异：`create` 目标已存在报错（决策 7，官方实现允许覆盖）；`insert_line: 0` 在有 frontmatter 时落在 frontmatter 之后（§4.3）。

```ts
// src/memory/tool-surface.ts（P0 冻结；golden 见 §4.5）
const S = () => Type.Optional(Type.String());
const lit = (xs: readonly string[]) => Type.Optional(Type.Union(xs.map((x) => Type.Literal(x))));
export const MemoryToolParamsV2 = Type.Object({
  command: lit(["view", "create", "str_replace", "insert", "delete", "rename", "search"]),
  path: S(),
  view_range: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
  section: S(),
  file_text: S(),
  old_str: S(),
  new_str: S(),
  insert_line: Type.Optional(Type.Integer({ minimum: 0 })),
  insert_text: S(),
  old_path: S(),
  new_path: S(),
  query: S(),
  action: lit(["list", "write", "append"]),
  name: S(),
  content: S(),
});
```

- 参数不带逐项 description（字节预算，§4.5）；命令语法集中写在工具 `description` 一处。
- `view_range` 用 `Type.Array(minItems/maxItems)` 而非 `Type.Tuple`，兼容运行时 typebox 1.x 别名（实测 0.34.52 与 1.3.27 序列化字节数同为 861B，但键序不同，见 §4.5）。
- `exactOptionalPropertyTypes` 下所有可选字段按 `params.x !== undefined` 判断。

### 4.2 别名、互斥与优先级（纯函数 `normalizeMemoryCall(params) → NormalizedCall | Error`，P2）

| 规范槽位    | 可接受字段（任选其一）                                  | 适用命令                        |
| ----------- | ------------------------------------------------------- | ------------------------------- |
| `op`        | `command` 或 `action`（`list→view`、`write`、`append`） | 全部                            |
| `target`    | `path` / `name` / `old_path`                            | 除 search 外全部（rename 的源） |
| `dest`      | `new_path`                                              | rename                          |
| `body`      | `file_text` / `content`                                 | create、write                   |
| `body`      | `insert_text` / `content`                               | insert                          |
| `body`      | `content` / `insert_text`                               | append                          |
| `old`/`new` | `old_str` / `new_str`                                   | str_replace                     |

规则（全部有测试）：

1. **互斥即报错，不设优先级**：同一槽位出现两个字段 ⇒ 规范化后值相等则接受（`note: path and name both given (same value)`），不等则报 `conflicting path/name: "a.md" vs "b.md"`。`command` 与 `action` 同时出现 ⇒ 一律报错（语义不同，不做相等判断）。
2. 字段不属于该命令的可接受集合（如 `create` 带 `insert_text`）⇒ 报错并指出该命令接受的字段名（`create takes file_text (or content)`）。
3. 与命令无关的其它字段（如 `view` 带 `old_str`）⇒ 忽略，结果末尾追加 `note: ignored params: old_str`（不多一轮往返）。
4. 路径规范化：去掉前缀 `/memories/`；`""`、`/memories`、`/memories/` 或未给 ⇒ 目录；其余必须过 `NAME_RE` + `dirname(resolve()) === dir` 双保险（`resolveMemoryFile`，P0 从 store 抽出）。
5. `op` 缺省 ⇒ `view`。

### 4.3 命令语义

| 命令                         | 语义                                                                                                                                                                                                              | 返回                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `view`（目录）               | 每文件 `name · description · when · size · updated(YYYY-MM-DD) · status · pin · source`，含 archived；末行 `core 1.1/1.6k · block 2.2/2.4k (L2) · doctor: 1 error 2 warn`                                         | 文本                                               |
| `view path`                  | 全文带行号（`%6d\t`，含 frontmatter 行，与 `insert_line`/`view_range` 同一坐标系）；输出 >16KB 截断并提示 `view_range`                                                                                            | 带行号文本                                         |
| `view path view_range=[a,b]` | 指定行（`b=-1` 到末尾），越界钳到文件范围并注明                                                                                                                                                                   | 同上                                               |
| `view path section=S`        | 标题匹配：先精确（去 `#`、trim、不区分大小写），再唯一前缀；多个 ⇒ 报错列出候选及行号；返回该节                                                                                                                   | 同上 + `section L12–L25`                           |
| `create path file_text`      | 只建新文件（§3.3 原子 no-clobber）；已存在 ⇒ 报错（提示 str_replace/insert，或 `action:"write"` 覆盖）；自动 upsert `source: agent` + `updated`                                                                   | 路径、字节、T3                                     |
| `str_replace`                | `old_str` 在全文恰好出现一次；0 次 ⇒ 报错并建议 `search`；>1 次 ⇒ 报错列出各匹配行号；`new_str` 省略 ⇒ 删除                                                                                                       | 改动处 ±3 行带行号片段 + T3                        |
| `insert`                     | `insert_line=n`：插在第 n 行后；n 落在 frontmatter 内（1..闭合行−1）⇒ 报错；`n=0` 且有 frontmatter ⇒ 规范化为闭合行之后并注明 `inserted after frontmatter (line k)`；或 `section=S`：插到该节末尾；二者恰好给一个 | 片段 + T3                                          |
| `delete path`                | 软删除到 `.trash/<id>-<name>`（§3.3）                                                                                                                                                                             | `deleted (recoverable: /mem restore --trash <id>)` |
| `rename old_path new_path`   | §3.3 no-clobber；两者都过围栏；目标存在 ⇒ 报错；内容与 frontmatter 原样                                                                                                                                           | 新路径                                             |
| `search query`               | 空白切词（≤8 词），字面、不区分大小写；扫描正文行 + description/read_when；行得分 = 命中的不同词数；按得分降序、文件名、行号排序，最多 20 条，每行裁到 160B                                                       | `cache-ttl.md › 上游缓存事实 › L10: …`             |
| `action:list`                | = `view`（目录）                                                                                                                                                                                                  | —                                                  |
| `action:write`               | 覆盖语义（存在即覆盖，走读-改-写原子路径），受手写文件规则、上限与 T3 约束                                                                                                                                        | —                                                  |
| `action:append`              | §3.3 v2 append（持锁、超限整次拒绝），不动 frontmatter                                                                                                                                                            | —                                                  |

**手写文件规则**（用户决策 5；「手写」= 文件存在且 frontmatter `source` ≠ `agent`，含 CC 导入副本）：

| 操作                         | `source: agent` 文件        | 手写文件                                                                                                                                                                                        |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| view / search                | 允许                        | 允许                                                                                                                                                                                            |
| str_replace / insert         | 允许；upsert `updated`      | **允许 + 警告** `⚠ edited a user-authored file; frontmatter left untouched`；**不改 frontmatter**（不翻 `source`、不写 `updated`）；匹配/插入点必须全部落在正文内——触及 frontmatter 区域 ⇒ 拒绝 |
| append                       | 允许（R4 不动 frontmatter） | **允许 + 警告**                                                                                                                                                                                 |
| write 覆盖 / delete / rename | 允许                        | **拒绝**：`<name> is user-authored (no "source: agent"); edit it yourself, or add "source: agent" to its frontmatter first`                                                                     |
| tidy                         | 可提案并 Apply              | **只建议**（无 Apply 选项）                                                                                                                                                                     |

「触及 frontmatter 即拒绝」保证模型不能先用 str_replace 给手写文件加 `source: agent` 再绕过覆盖/删除限制——翻转 provenance 只能由用户完成（新决策 N3，附推荐）。

**其它通用规则**：

- **子会话只读**：`view` / `search` / `action:list` 始终可用；其余命令在 `isChildSession && !allowWriteInChildSessions` 时抛出现有同款错误文案。store 层 `allowWrite` 结构闸门保留并扩到新写函数（R7）。
- **provenance**：create / write / str_replace / insert（仅 agent 文件）写入 `source: agent` + `updated: <ISO>`；append 不动（R4）；rename、delete 不改内容。
- **frontmatter 校验**（写入结果中的 frontmatter，见 §5）：结构性错误 ⇒ 拒写；长度超限、缺 description ⇒ 只在 T3 提示（决策 8）。
- 每次成功变更调用**一次** `onAfterWrite(cwd)`，失败零次；UI 通知沿用 `ctx.hasUI` 惯例。

### 4.4 T3：预算反馈、精确重复行、硬上限（评审 v1 #10 精简）

结果末尾固定附加（英文紧凑标记）：

```text
budget: quota.md 1.9/8k (hard 16k) · core 1.1/1.6k · block 2.2/2.4k (L2)
⚠ duplicate line: "workflow 本身不占槽，其子任务各占 1 槽" also at pitfalls.md:17
⚠ no description/read_when — the index shows the H1 instead; add frontmatter
```

- block 估算 = 用变更后的目录跑一次 `renderTiered`（同步、走 MetaCache）；`layout=legacy` 时只报文件大小。
- **精确重复行**（`src/memory/budget.ts` 内纯函数 `findExactDuplicates`，零模型成本）：对本次新写入/替换的每行归一化（trim、折叠空白、去列表前缀 `- ` / `* ` / `1. `、ASCII 小写），长度 ≥16 个码点的行若与目录内其它可寻址文件（或同文件其它位置）的某行归一化后完全相等 ⇒ 报告，最多 3 条。上界：新行 ≤200 行，语料用 `Set` 查找，O(总行数)。近似查重（`similar.ts`）延后（§13）。
- **硬上限**（只在「变更后更大」时生效，旧的超限文件可以缩小）：
  - primary core 变更后正文 > `coreBytes` ⇒ 拒写，列出最大的几个 `##` 节及字节，建议 `memory create path=<topic>.md` 下沉并在 core 留一行指针。
  - 其它文件 > `topicMaxBytes`（16KB）⇒ 拒写，列出各 `##` 节大小，建议按节拆分。
  - > `topicWarnBytes`（8KB）⇒ 放行 + 警告。
  - 原有 `maxWriteBytes`（单次）/ `maxFileBytes`（绝对上限）保留为最外层。
  - append 同样适用（§3.3：超限整次拒绝、零字节写入）。

### 4.5 工具面字节口径与 golden（评审 v1 #1 Blocker）

**口径（UTF-8 字节，不按 token）**：

```ts
toolSurfaceBytes(def) =
  bytes(def.description) +
  bytes(def.promptSnippet ?? "") +
  bytes((def.promptGuidelines ?? []).join("\n")) +
  bytes(JSON.stringify(def.parameters));
```

`name`/`label` 为常量不计。`JSON.stringify` 不序列化 typebox 的 symbol 键（`[Kind]` 等）。

**跨 typebox 版本口径**（复审 v1-1）：pi 0.87.1 运行时把 `@sinclair/typebox` 别名到自带 `typebox@1.3.27`；测试环境用 devDep `@sinclair/typebox@0.34.52`。二者对同一 schema 产出**相同的键值集合、不同的键序**，因此本方案**不声称跨版本 JSON 文本相同**：

- golden 存 **canonical JSON**：`canonicalJson(v)` = 对象键按码点序递归排序、数组保持原序、`JSON.stringify` 无空白；比较时被测对象同样 canonicalize 后逐字节比较。
- 字节预算按 `toolSurfaceBytes`（原始 `JSON.stringify`，不 canonicalize）计算；键序不改变字节数，测试在两个 typebox 下分别计算并断言**两者相等且 ≤ 上限**。
- 「运行时 typebox」由测试从 pi 包自身解析：`createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("typebox")`——跟随 pi 实际锁定的版本，不依赖 hoisting、不新增依赖；解析失败 ⇒ 测试失败（不 skip）。
- 实测（2026-09-27，两版各构建一次）：v2 parameters 原始 861B / canonical 861B（两版相同）；legacy parameters 417B / 417B；两版 canonical 文本逐字节相等、原始文本不等。合计见下。

**v2 冻结文本**（P0 写入 `tool-surface.ts`，逐字节 golden）：

- `description`（387B）：
  `Project memory (cwd-keyed; core + topic index auto-injected). command: view [path] [view_range|section] · search query · create path file_text · str_replace path old_str [new_str] · insert path insert_line|section insert_text · delete path · rename old_path new_path. path: x.md or /memories/x.md; omit to list. Legacy: action list|write|append + name/content. Never store secrets.`
- `promptSnippet`（42B）：`Project memory: view/search, edit in place`
- `promptGuidelines`（1 行，153B）：
  ``memory: open a topic only when its `when` matches; fix stale facts with str_replace instead of appending duplicates; keep core.md to always-needed rules.``
- `parameters`：§4.1 schema，`JSON.stringify` = **861B**。

**实测合计 1,443B**（legacy 1,333B，净增 110B；主会话 memory 块约省 1.6KB，子会话更多）。命令枚举保留为 Literal Union（模型得到枚举约束）；若改成纯字符串可降到 1,105B，但失去 schema 级约束，不采用。

**验收**：`tests/fixtures/memory-tool-surface.json` 存 legacy 与 v2 两份 `{description, promptSnippet, promptGuidelines, parameters}` 的 **canonical JSON**（另附只作记录、不参与比较的 `typeboxDev` / `typeboxRuntime` 版本号与 `generatedAt`）。测试断言：①两个 typebox 下 canonical 序列化均逐字节等于 golden，golden 本身再 canonicalize 一次不变（防止有人改回原始文本比较）；②两个 typebox 下 v2 `toolSurfaceBytes` 相等且 ≤ 1,500，legacy 均 = 1,333；③promptGuidelines 恰 1 行。legacy 工具定义在 `tool.ts` 中全程零改动，改前改后的运行时都用同一个 typebox 构建同一组 `Type.*` 调用，因此 canonical 相等即运行时原始字节相等。改动任何工具文本都必须同步修订本节与 golden（冻结面变更，上报主会话）。

## 5. frontmatter 契约

```yaml
---
description: Prompt cache 的 1h/5m 寿命、保活和自适应边界
read_when: cache-ttl; prompt cache; keepalive; adaptive
topic: cache-ttl
status: active
updated: 2026-09-26T10:29:06.097Z
pin: false
source: agent
---
```

| 键            | 约束                                                                 | 缺失默认                            | 体检                                                                        |
| ------------- | -------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `description` | 单行；≤160B（超出索引裁剪）                                          | 首个 `# ` 标题 → `(no description)` | topic / extra pinned 缺失 D06 warn；**primary core 不要求**；>160B D07 info |
| `read_when`   | `;` 或 `；` 分隔关键词；≤240B                                        | 无（索引不出 `when:`）              | topic 缺失 D06 info；core / pinned 不要求                                   |
| `topic`       | `[a-z0-9-]{1,48}`                                                    | 文件名去 `.md`                      | 重复 topic D11 warn                                                         |
| `status`      | `active` \| `stale` \| `archived`                                    | `active`                            | 非枚举：写入拒绝 / 体检 D07 error                                           |
| `updated`     | ISO 日期或日期时间（`Date.parse` 可解析且匹配 `^\d{4}-\d{2}-\d{2}`） | 无（年龄规则跳过）                  | 非法 D07 error；超龄 D08                                                    |
| `pin`         | 仅 `true` 生效（沿用 `isPinned`）                                    | false                               | pinned 放不下 D03                                                           |
| `source`      | `agent` ⇒ fence 且可被覆盖/删除；其它/缺失 = 手写                    | 手写                                | —                                                                           |

决策 8 附加条件落地：core 与 topic 规则分开——primary core 永远内联（或整节内联），不需要 description/read_when；topic 只能靠索引被发现，缺 description 是 warn、缺 read_when 是 info；都只提示不拒写。

**parser 约束**：沿用 `parseFrontmatter` 行级规则（必须是文件第一行 `---`；`key: value` 单行；非 kv 行容忍跳过；重复键后者胜），`frontmatter.ts` 现有函数不改。新增 `src/memory/meta.ts`：去掉值两端成对的 `"`/`'`；frontmatter 超过 40 行或 2KB ⇒ 视为无效（D07 error），防止头部读取越界；`read_when` 切词 `readWhenTerms: string[]`（T5 预留）；`splitSections` 识别代码围栏。不引入 YAML 依赖。

## 6. 体检（`/mem doctor`，零模型成本）

### 6.1 规则（v2 精简）

纯函数 `runDoctor(snapshot, settings) → DoctorFinding[]`（`src/memory/doctor.ts`），每条 `{ id, severity: "error"|"warn"|"info", file?, line?, message, fix? }`：

| id  | 级别       | 规则                                                                                                                                                                                                                                                      |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | info       | 无 `core.md`，正以 pinned 文件降级充当 core（迁移过渡，提示 `/mem tidy`）                                                                                                                                                                                 |
| D02 | error      | primary core 正文 > `coreBytes`（含整节准入后仍有省略节、或 L4 未内联）                                                                                                                                                                                   |
| D03 | warn       | `pin: true` 文件未能整文件进入 core 预算                                                                                                                                                                                                                  |
| D04 | warn       | 非 core 文件 > `topicWarnBytes`                                                                                                                                                                                                                           |
| D05 | error      | 非 core 文件 > `topicMaxBytes`                                                                                                                                                                                                                            |
| D06 | warn/info  | topic / extra pinned 缺 description（warn）；topic 缺 read_when（info）                                                                                                                                                                                   |
| D07 | error/info | frontmatter 结构错误：未闭合、超 40 行/2KB、status 非枚举、updated 非法（error）；长度超限（info）                                                                                                                                                        |
| D08 | info/warn  | `status: stale`（info）；`updated` 超 `doctor.staleDays`（默认 60，warn）                                                                                                                                                                                 |
| D09 | warn/error | 主会话块降级：L1–L4 warn（写明级别与被折叠/省略的项）；L5（框架超 `blockBytes`，超长 slug）error。**原 D10 并入此条**                                                                                                                                     |
| D11 | warn       | 多个文件同一 `topic`                                                                                                                                                                                                                                      |
| D13 | error      | 疑似密钥：`sk-[A-Za-z0-9]{20,}`、`AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{30,}`、`xox[bap]-[A-Za-z0-9-]{10,}`、`-----BEGIN [A-Z ]*PRIVATE KEY-----`、`(password\|secret\|token)\s*[:=]\s*\S{8,}`；输出打码为前 4 字符 + `…`                                   |
| D14 | info/warn  | 不可寻址项：v2 路径下不符合 `NAME_RE` 的 `.md`（info）；文件级 symlink / dangling symlink / 非普通文件（warn，「已跳过，不会注入」）；`nlink > 1`（info）；slug 目录是符号链接（info，显示 `display → real` 与信任语义）；canonical 目标不是目录（error） |

ID 保持 v1 编号不重排；D10 合并进 D09，D12（近似重复）、D15（CC drift）、D16（总量 > tidy 输入上限）**延后**（§13；D16 的信息由 `/mem tidy` 自身的输入上限提示覆盖）。

### 6.2 输出位置

- `/mem doctor`：完整清单（多行中文散文 + 英文规则 id），经 `ctx.ui.notify`；条目 >20 时改用 `ctx.ui.editor("memory doctor", text)` 只读展示。
- `/mem`（默认）与 `/mem list`：文件列表后追加一行 `doctor: 1 error · 3 warn — /mem doctor`。
- **提示模型的时机（不打脏缓存）**：体检结果**绝不**进 system prompt、tail message 或 `sendMessage`/`appendEntry`。模型只在两个已付费位置看到：①写入类工具结果里与本次文件相关的条目（T3）；②`view`（目录）末行的健康摘要。

### 6.3 启动提醒（决策 13 附加条件）

- 仅**主会话**（`!isChildSession`）且 `ctx.hasUI` 且 `memory.doctor.notifyOnStart`；子会话、consult、print/RPC 无 UI 会话从不提醒。
- 触发：`session_start` 后首次（同步体检，毫秒级）存在 **error** 级条目或 D01。
- **每会话一次**：闭包 `notifiedSessions: Set<sessionId>`。
- **去重**：进程级 `Symbol.for` 有界 FIFO `lastNotified: Map<cwd, fingerprint>`（不放模块作用域），`fingerprint = sha1(按 id+file 排序的 error/D01 条目)`；同一进程内（`/new`、`/resume`、`/fork` 反复切换，含扩展重新激活）指纹未变 ⇒ 不再提醒；`/reload` 的 `session_shutdown` 显式清空后允许再提醒一次。

## 7. `/mem tidy`（手动；主会话模型 + 输出/成本硬上限 + 逐文件确认）

入口：

| 命令                                                  | 成本       | 语义                                                                                                                      |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/mem tidy [file…]`                                   | 一次子 run | 模型提案 → 校验 → 逐文件确认 → 一次性应用                                                                                 |
| `/mem tidy --dry-run [file…]`                         | **零**     | 只做步骤 1–3 的计算并展示：目标文件与字节、体检摘要、模型、提示词字节、估价 vs 上限；**不 spawn、不写任何文件（含备份）** |
| `/mem tidy --frontmatter [file…]`                     | **零**     | 确定性补元数据模式（决策 12 附加条件，§7.4）                                                                              |
| `/mem restore [<id>]` / `/mem restore --trash [<id>]` | 零         | 恢复 tidy/frontmatter 备份或软删除文件（§7.5）                                                                            |

仅主会话且 `ctx.hasUI`；子会话/无 UI ⇒ notify 说明并返回。spawn 端口由 `src/index.ts` 在 post-guard 通过 `wireMemory` 返回的 `attachTidy(port)` 注入，`port` 经 holder 读当前 stack：`{ spawn, waitOutcome, abort, snapshot(runId) }`（`snapshot` = `query.get`）；未注入 ⇒ `tidy unavailable in this session`。提案 run 带 `expectAck:true` 和 `suppressDelivery:true`，由命令领取结果；adapter 不入完成通知 outbox（包括失败路径），只有 UI 确认后的程序化 apply 可以写盘并备份。

### 7.0 提案阶段零写入能力（复审 新-1 阻塞项；复审 v3-1/2/3；用户决策 N5 = A）

v2 依赖「Plan 只读 + 子会话 memory 只读」，但内置 `Plan` 工具表含 `bash`，且用户同名 agent 文件可遮蔽内置类型——agent type 不是安全边界，子会话 memory 只读也挡不住 bash 改文件。v3 起把零写入做成 **runtime 强制的工具域**，与 consult 用同一套机制；v4 补上「同名 custom tool 覆盖 builtin」这条旁路（复审 v3-2）；v5 写明威胁模型并把运行期核验前移到 turn_start（复审 v4）；v6 按 `agent-loop.js` 源码改正 turn_start 核验的语义（复审 v5-3，§1）。

#### 7.0.0 威胁模型与信任边界（v5，主会话裁定）

- **目标**：防止 tidy 提案子会话里的**模型**通过工具写文件（含 memory 目录）。readonly 域保证**模型可见、可执行的工具集** = pi builtin `read/grep/find/ls` + runtime 自有 `StructuredOutput`（带 schema 时）。手段是按**名称 + 来源**在 bind、每回合 turn_start、turn_end 核验并剥离意外工具，记录 WARN 与诊断（`ScopeDecision.rejected` / `rejectedShadowed`）。
- **信任边界**：信任与本包同进程的所有代码——H2 `resolveSessionSpec` 扩展、子会话加载的任何 pi 扩展、pi 自身。这与 pi 的扩展模型一致：扩展与宿主同进程同权限，可以直接 monkeypatch `fs`、改写任意对象（包括已注册工具的 `execute`、runtime 的 policy），进程内无法防御。
- **定位**：6a/6b 是 **defense-in-depth**，防的是误配置与意外——agent type / H2 配置加了写工具、用户装的其它扩展恰好注册了同名 `read`、MCP 迟注册工具。它们不是安全边界，不承诺抵御有意绕过。
- **非目标（明确）**：①同进程恶意扩展（改 `StructuredOutput.execute` 或 builtin 实现、在 bind 与核验点之间抢注再撤销、直接调 `fs`）；②同 uid 的其它进程写 memory 目录（由 §7.3 步骤 7 的逐文件 sha256 复查发现并跳过，不是防御）；③主会话自身的权限（见下「残余面」①）。不为非目标写对抗式加固或测试。
- **低成本卫生项**：`StructuredOutput` 工具定义对象在 readonly 域内 `Object.freeze`，防止同进程代码**意外**改写（不当作防线）。

- **冻结接口**（P0-r，`src/core/types.ts`）：`SpawnRequest.toolDomain?: "readonly"`。只给进程内调用方（本方案的 tidy）用；Agent 工具、RPC、workflow `agent()` opts、`/task` 都显式构造 request、不透传未知键，因此无法设置该字段（N6 测试钉住）。
- 下文 `readonlyDomain = isConsultRun || spec.request.toolDomain === "readonly"`（`src/service/runtime-adapter.ts`，紧挨 L538 的 `isConsultRun` 定义）。**只有下列 1–3、6 条改用 `readonlyDomain`**；consult 专属逻辑（L819 raw prompt、L843、L889 收尾）继续用 `isConsultRun`，不因 tidy 改变。

**强制点**（与 consult §5.4 B-1/B-2/B-3 同位）：

1. **注入与授权**：所有注入分支（message_agent / set_model / nested Agent / consult）由 `!isConsultRun` 改为 `!readonlyDomain`；switch_context 授权（L717）同样改 `!readonlyDomain`；`bashJobGrant({ …, consult: readonlyDomain })`（L706–710，复审 v3-3：原来传 `isConsultRun`，tidy run 在 `bashJobs.childSessions` 开且 agent type 含 `bash` 时会拿到 `bash_job`）。唯一例外：`toolDomain:"readonly"` 且带 `schema` 时仍注入 `StructuredOutput`（tidy 靠它交提案；consult 不带 schema，行为逐字节不变）。结果：readonly 域的 grantedReserved **恰为** `[]` 或 `["StructuredOutput"]`。
2. **H2 之后**强制 `sessionSpec.tools = [...CONSULT_READONLY_TOOLS, ...(schema ? ["StructuredOutput"] : [])]`——任何 agent type 的 `tools`、任何 `resolveSessionSpec` 扩展都不能加宽。
3. enforcer policy：`buildToolScopePolicy({ tools: CONSULT_READONLY_TOOLS, granted: schema ? ["StructuredOutput"] : [] })`，外加第 6 条的 `provenance`；在 bind、turn_start（仅带 `provenance` 的 policy，见 6b）、turn_end 重算，迟注册的 `bash` / `edit` / `write` / `memory` / MCP 工具被剥离并 WARN。
4. spawn 准入（`src/service/spawn-service.ts`）：`toolDomain` 与 `isolation` / `forkSessionFrom` / `resumeFrom` 同时出现 ⇒ `config` 错误（tidy 从不组合，防御未来误用）。
5. **字段分类闸**（复审 v3-1）：`src/service/request-threading.ts` 的 `NOT_THREADED` 追加 `"toolDomain", // consumed by the runtime adapter (tool domain / policy / provenance); never reaches the runner verbatim`。runner 不需要该字段——它只执行 adapter 交给它的 `toolScope`（policy + enforcer）。漏登记会让 `AssertAllClassified` 编译失败，因此这一行与 `types.ts` 的字段**同一提交**。
6. **只认 builtin 实现**（复审 v3-2；v5 按 §7.0.0 定位为 defense-in-depth）。pi 的 allowlist 只按名字过滤、同名 custom tool 覆盖 builtin（§1），所以 readonly 域在名字之外再核验**实现来源**，两道闸：
   - **6a 创建前收窄**（adapter，第 2 条之后）：`sessionSpec.customTools` 只保留本次 adapter 调用自己创建的那个 `StructuredOutput` 对象（按对象同一性比较，不按名字）；H2 或其它路径加入的任何 custom tool（不论名字）一律剔除，按名 WARN 一次：`[pi-subagent] readonly domain: dropped custom tool(s) from run <id>: read(sdk), foo(sdk)`。该 `StructuredOutput` 定义对象在 readonly 域内创建后即 `Object.freeze`（卫生项，§7.0.0；pi 不改写 definition，§1）。
   - **6b 运行期来源核验**（`src/runtime/tool-scope.ts` + `src/runtime/session-driver.ts` + `src/runtime/runner.ts`）：子会话自己加载的扩展（含用户装的其它 pi 扩展）可能 `registerTool({ name: "read" })`，6a 管不到。新增：
     - `ToolScopePolicy.provenance?: ReadonlyMap<string, string>`——期望来源；readonly 域为 `read/grep/find/ls → "builtin"`，带 schema 时再加 `StructuredOutput → "sdk"`（6a 之后 SDK 来源只剩 runtime 自有实例，故 `"sdk"` 即「runtime 自有」）。其它 run 不设该字段，行为逐字节不变。
     - `SessionHandle` / `ScopeSessionHandle` 增加可选 `getToolSources?(): ReadonlyMap<string, string>`；`PiSessionHandle` 用新导出的纯函数 `toolSourcesOf(session)`（`session.getAllTools()` → `name → sourceInfo.source`，读取失败返回空 Map）实现。
     - **核验点**（v5 选点；v6 按 §1「pi 事件顺序、工具声明与可执行快照」改正语义）：①`onBind`（bind 之后、prompt 之前，现有）：**唯一能影响首回合声明的核验点**——此处剥离的工具不进入 `prompt()` 的 loadout，首回合既不声明也不可执行；②**turn_start**（新增）：runner 的 bind 回调收到 `e.t === "turn_start"` 且 `req.toolScope.policy.provenance !== undefined` 且 run 未终态 ⇒ 同步调用 `enforcer.onTurnBoundary(handle, policy)`。此时本回合扩展的 `before_agent_start` / `agent_start` / `turn_start` 处理器都已跑完，`prepareRequest` 还没快照可执行集合 ⇒ 被剥离的工具**本回合不可执行**。本回合的**声明**不受影响：首回合声明在 `prompt()` 里就定了（早于 `turn_start`），后续回合在 `turn_start` 之后的 `declareToolChanges` 比较的是 `prepareNextTurn` 产出的、`turn_start` 之前的 `context.tools` 快照。所以模型本回合仍可能看到被剥离的名字，调用得到 `Tool <name> not found`（fail-closed），下一回合 `prepareNextTurn` 重建 loadout 后声明写出 `toolsRemoved` 追平。**首回合因此依赖 bind 核验**：bind 之后到首回合声明之间注册的工具（例如扩展在 `before_agent_start` 里注册，或在首回合 `turn_start` 处理器里注册）首回合会被声明、但不可执行；这是接受的 fail-closed 过渡，不另加核验点；③turn_end（现有）：在 `prepareNextTurn` 之前生效，剥离后下一回合声明与可执行集合一致，没有 not found 过渡。未设 `provenance` 的 policy（普通 run、consult 以外的一切）turn_start 不触发 enforcer，与改前逐字节一致；`tool-scope.ts` L98 / L191 的「only at bind/turn_end」注释同步改为「bind / turn_start（仅 provenance policy）/ turn_end」，turn_start 同样是回合边界、不在 tool_exec 中途（TS3 不变）。剩余窗口（`prepareRequest` 之后、下一个核验点之前新注册的工具）不进入本回合的可执行快照，下一个 turn_end 剥离；有意利用该窗口属 §7.0.0 非目标。
     - enforcer 在上述每个核验点，在现有 allow/deny 计算之后：对 `provenance` 中每个仍在 active 集合的名字，来源 ≠ 期望（含 handle 没有 `getToolSources`、Map 中缺该名、读取抛错）⇒ **从 active 集合剥离**（fail-closed，不尝试恢复 builtin——pi 的注册表已按名被覆盖；剥离触发 pi 的 `setActiveToolsByName` → 系统提示词重建，只在出现违例时发生）并 WARN：`[pi-subagent] readonly domain: removed shadowed tool read (source: <src>, expected builtin) from run <id>`。`ScopeDecision` 增加 `rejectedShadowed: readonly string[]`。
     - 后果：被遮蔽的 `read` 剥离后该名在本 run 内不可用（提示词已含全部目标文件正文，tidy 不依赖 `read`）；`StructuredOutput` 被剥离 ⇒ tidy 拿不到结构化结果，按 §7.3 失败路径零写入。
     - **consult 同受益**：6a/6b 以 `readonlyDomain` 为条件，consult run 也获得同样的加固——只在存在同名冲突时才有可观察差异（原先会用遮蔽 builtin 的同名工具，现在剥离），无冲突时逐字节不变。测试用的 fake handle 若缺 `getToolSources` 会被 fail-closed 剥离；P0-r 只允许给相关 fake handle 补 `getToolSources`（返回全 `builtin`），**不允许**为了让旧测试通过而放宽规则。

- 结果（在 §7.0.0 信任边界内）：该域内不存在 `bash` / `edit` / `write` / `bash_job` / `switch_context`，`memory` 工具不在 allowlist（子会话里注册了也被剥离），在核验点上名为 `read/grep/find/ls` 的只可能是 pi builtin 实现 ⇒ 提案 run 的**模型没有任何能写文件的工具**。
- tidy 侧：`TidyPort.spawn` 的请求类型把 `toolDomain: "readonly"` 设为**必填字面量**，漏传编译不过；`memory.tidy.agentType` 只决定系统提示词与模型提示，**不能加宽工具**（设置描述写明）。
- **残余面（明确接受）**：①主会话模型事后用 `Agent({ resume: "mem-tidy" })` 续跑是一个**新 run**，不继承 `toolDomain`——那是主会话自身的权限，tidy 永不消费续跑结果；②同进程扩展与同 uid 其它进程——§7.0.0 非目标；同 uid 外部写入由应用阶段逐文件 sha256 复查发现并跳过（§7.3 步骤 7）。
- 测试：§10 N 组（runtime 侧工具表、policy、H2 覆盖、字段分类、同名覆盖 / 误配置端到端（v6 拆为 bind / 首回合 / turn_start 迟注册 / 下一回合追平四条路径）、turn_start 核验）+ K15（tidy 请求带 `toolDomain`）。按 §7.0.0 不写「恶意扩展改 `execute`」「核验点之间抢注」类对抗用例。

### 7.1 模型与成本（用户决策 11、评审 v1 #8）

- **模型解析顺序**：`memory.tidy.model`（只接受严格 `provider/id`，否则解析时回落 `""` 并 WARN）⇒ `ctx.model`（当前主会话模型，命令执行瞬间读取）⇒ 两者都没有 ⇒ 拒绝（`no model to run tidy`）。解析结果以 `modelOverride` 传给 spawn，`thinkingOverride: "low"`。
- **价格**（用户决策 N1）：`ctx.modelRegistry` 查该模型 `cost`（USD / 1M token）；`input > 0 || output > 0` 视为有价。**无价模型允许运行 + 警告**：不做估价闸，cap watcher 的美元闸关闭（`maxCostUsd` 不适用），只保留三道硬上限——`tidy.maxTurns`（回合）、`tidy.maxOutputBytes`（输出字节，§7.2）、`tidy.timeoutMs`（超时）。所有展示面都明确写 **no cost guarantee**：确认框、`--dry-run` 预览、tidy 报告（`cost: unknown — no price info for <provider/id>, no cost guarantee`）。
- **预估上界**（派发前，纯函数 `estimateTidyUsd`，与 consult `estimateFirstRequestUsd` 同口径）：
  `inTok = ceil(promptBytes / 2)`；`outTok = ceil(min(maxOutputBytes, 1.25 × inputBytes + 4096) / 2) + 2048`（thinking 余量）；
  `est = (inTok × max(cost.input, cost.cacheWrite) + outTok × cost.output) / 1e6`。按 2 B/token 保守估（中文 UTF-8 3B/字、约 1–1.5 字/token）。
  （仅有价模型）`est > maxCostUsd` ⇒ **不派发**，提示缩小文件范围、配更便宜的 `tidy.model` 或调高上限。
- **运行中中止**：复用 `createCapWatcher({ maxTurns: tidy.maxTurns, maxCostUsd: tidy.maxCostUsd })`，由 1s 间隔（`unref`）轮询 `port.snapshot(runId)` 喂入；回合边界上 `diag.usage.costUsd > maxCostUsd` 或回合数到顶 ⇒ `port.abort(runId, "user_stop")` ⇒ 零写入，报告 `tidy aborted: cost cap $X reached ($Y spent)`。无价模型只启用回合闸（`maxCostUsd` 传 `undefined`），报告写 `aborted: turn cap reached (cost unknown)`。
- **有效上界**：成本 ≤ `max(est, maxCostUsd)` + 最后一回合（与 consult 相同的界，最后一回合的输出被 §7.2 的 schema 长度约束封顶）；时长 ≤ `tidy.timeoutMs`（显式 `totalMs` ⇒ 无宽限、不可延长）+ 外层 `withTimeout(timeoutMs + 5s)`。终局 `usage.costUsd > maxCostUsd`（仅可能发生在最后一回合）⇒ 提案仍可展示但每个选择框标题带 `over cost cap`，报告中写明实际花费。
- **费用确认**：`ui.confirm("memory tidy", "<n> files · <in>kB in · <provider/id> · est ≤$<est> (cap $<cap>) · ≤<turns> turns · timeout <T>s. Continue?")`，取消 ⇒ 零 spawn。无价模型的文案改为 `"<n> files · <in>kB in · <provider/id> · ⚠ no price info — no cost guarantee (bounded only by ≤<turns> turns · ≤<out>kB output · timeout <T>s). Continue?"`。

### 7.2 输出硬上限（评审 v1 #8）

- `TIDY_SCHEMA`（P0 冻结在 `contracts.ts`，StructuredOutput 与宿主双重校验）：

```ts
{
  files: Array<{ // maxItems 24
    name: string; // maxLength 128
    action: "keep" | "rewrite" | "create" | "delete" | "rename";
    newName?: string; // maxLength 128
    content?: string; // maxLength 65536（码点）
    reason: string; // maxLength 200
    movedFrom?: string[]; // maxItems 8
  }>;
  dropped: Array<{ from: string; text: string /* maxLength 400 */; reason: string /* maxLength 200 */ }>; // maxItems 200
  notes?: string; // maxLength 1000
}
```

- 宿主在任何 UI 展示之前计算 `outputBytes = Σ bytes(所有字符串字段)`；`> memory.tidy.maxOutputBytes`（默认 65,536）⇒ **整份提案作废**、零写入、notify `tidy output NkB over cap MkB — narrow the file set`。
- 单个 `content` 还要过 §4.4 的 core/topic 硬上限（校验步骤）。

### 7.3 流程

1. **快照**：在 canonical 目录（§3.1）上经 `safe-fs.readRegular` 读取目标文件（v2 文件名规则）（默认全部非 archived 可寻址文件；总量 > `tidy.maxInputBytes`（48KB）⇒ 提示指定文件并返回），记录每文件 `sha256` 与 stat。symlink/非普通文件从不进入快照（§3.1）。
2. **零成本预处理**：跑 `runDoctor`；无 `core.md` ⇒ 迁移模式提示词（§8）。
3. **估价 + 确认**（§7.1）。`--dry-run` 到此展示后返回。
4. **派发**：`spawn({ type: tidy.agentType (默认 "Plan"), prompt, label: "mem-tidy", thinkingOverride: "low", budgetOverride: { totalMs: tidy.timeoutMs }, schema: TIDY_SCHEMA, cwd, modelOverride, toolDomain: "readonly" })` + cap watcher + `waitOutcome`。提案 run 由 runtime 强制只读工具域（§7.0），模型没有任何写文件的工具；应用前的 sha 复查另外兜底同 uid 外部写入。
5. **校验提案**（`src/memory/tidy/validate.ts`，纯函数）：输出字节上限；schema；文件名过 `NAME_RE`；core 提案 ≤ `coreBytes`、topic ≤ `topicMaxBytes`；frontmatter 合法；**内容守恒**——原文件每条非空、非标题行（归一化后）必须出现在某个输出文件中或列在 `dropped[]` 里并附理由，否则该文件标 `⚠ N lines unaccounted`，默认选项变为 Skip；**手写文件**的提案降级为「建议」：可看 diff、可用 editor 复制，但没有 Apply 选项（用户决策 5）。
6. **逐文件确认**：`ui.select("tidy 2/6 · quota.md · rewrite · 1.6k→0.9k · <reason ≤120B>", ["Apply", "Edit then apply", "View diff", "Skip", "Abort all"])`；View diff ⇒ `ui.editor(title, unifiedDiff)` 后回到选择；Edit ⇒ `ui.editor` 预填新内容，结果重走步骤 5 的校验。diff 由 `src/memory/tidy/diff.ts`（行级 LCS，文件 ≤16KB、≤400 行，超出退化为整文件替换视图）生成。**diff 只走 UI，绝不进入会话上下文。**
7. **一次性应用**（`applyTidy`，所有决定收齐后）：`withMemoryDirLock` 内**同步**执行——
   - 备份：`ensurePrivateDir(.backup/<id>)`（`id` 同 §3.3 唯一格式），经 `safe-fs` 复制所有将被改/删/重命名的原文件，写 `manifest.json`：`{ v: 1, id, kind: "tidy", createdAt, entries: [{ name, op, beforeSha256?, afterSha256?, backupFile?, newName? }] }`；目录 0700、文件 0600；只保留最近 10 份。
   - 逐文件复查 sha256，与快照不符 ⇒ 跳过该文件并在报告里说明。
   - §3.3 原子写 / no-clobber 重命名 / 删除（tidy 的删除依赖备份，不进 `.trash`）；agent 文件写入 `source: agent` + `updated`；应用后把实际 `afterSha256` 回填 manifest（manifest 先以临时名写、最后 rename 落定）。
   - 最后调用**一次** `onAfterWrite(cwd)` ⇒ 下一轮恰好一条 tail update（stable）或一次重渲染（legacy/live）。
8. **报告**：`notify("tidy: applied 4, skipped 2 (1 changed on disk); backup .backup/<id>; cost $0.31; next turn carries one memory update")`。

### 7.4 `--frontmatter` 确定性模式（决策 12 附加条件）

零模型成本：对每个缺 `description` / `topic` / `status` 的非 archived 文件，提议 upsert `description = H1`（去掉首尾 `#`、裁到 110B）、`topic = 文件名去 .md 并规范到 [a-z0-9-]`、`status: active`；`read_when` 无法确定性推断 ⇒ 不写（体检继续 info 提示）；primary core 不补 description/read_when（§5）。agent 文件走 §7.3 步骤 6–8 同一套确认/备份/应用（`manifest.kind = "frontmatter"`）；手写文件只给建议。结果必须幂等：对已补全的目录再跑一次 ⇒ 零提案。

### 7.5 restore（决策 14 附加条件）

- `/mem restore`：列出最近备份（id、kind、文件数、时间）与 `.trash` 条目。
- `/mem restore <id>`：
  1. 读 manifest，展示将恢复的文件清单，`ui.confirm` 显式确认（取消 ⇒ 零写入）。
  2. **逐文件冲突检测**：当前文件 sha256 与 manifest 的 `afterSha256` 比较——相等 ⇒ 可安全恢复；不等（用户在 tidy 之后又改过）或文件已不存在 ⇒ 冲突，逐个 `ui.select(["Overwrite (current saved to the pre-restore backup)", "Skip"])`，默认 Skip。tidy 新建的文件（无 `beforeSha256`）：hash 相符 ⇒ 移入 `.trash`；不符 ⇒ 冲突同上。
  3. 持锁：先把所有将被触及的当前文件备份为一份新的 `kind: "restore"` 备份——**该备份失败 ⇒ 整个 restore 中止、零写入**；然后逐文件恢复，单文件失败不回滚已成功的文件，继续其余。
  4. 调用一次 `onAfterWrite`。
  5. **报告**：`restored N, skipped M (conflict), failed K: a.md (EACCES) …; pre-restore backup .backup/<id2>`，失败文件逐个列出原因。
- `/mem restore --trash <id>`：把 `.trash/<id>-<name>` 移回 `<name>`；目标已存在 ⇒ 冲突提示（Overwrite 会先把现有文件软删除，或 Skip）；同样持锁、一次 `onAfterWrite`、报告结果。

### 7.6 测试口径（摘要，全文见 §10 K 组）

超时、spawn 失败、schema 非法、输出超字节上限、估价超上限、运行中 cost cap、用户在确认处取消 ⇒ 零写入；`--dry-run` ⇒ spawn 调用 0 次且目录逐文件 sha 前后相同（含无 `.backup` 生成）；restore 冲突与失败路径均有用例；无价模型走「允许 + 警告」路径并逐一验证回合/输出字节/超时三道硬上限；spawn 请求恒带 `toolDomain:"readonly"`，runtime 侧只读域（含同名 custom tool 剔除/剥离）由 §10 N 组钉住。

## 8. 迁移（现有 5 个文件）

- **零动作可用**：升级后不迁移，tiered 块也能工作——pitfalls.md 作为降级 primary 整节准入（用户偏好整节进块，其余 4 节列在省略行里），另外 4 个文件以 H1 作为 description 进索引，块约 2.2KB。启动提醒一次：`memory: no core.md — run /mem tidy to migrate`（§6.3）。
- **推荐迁移 = 先 `/mem tidy --frontmatter`（零成本补元数据）再 `/mem tidy`（迁移模式）**，迁移提示词要求：
  1. 产出 `core.md`（≤ `coreBytes`）：只放每轮都需要的规则（用户偏好里的流程/提交/换线纪律 + 少数高频运行时坑），每个下沉主题留一行 `→ <file>` 指针；
  2. 拆分混合大文件：pitfalls.md → `core.md` + 例如 `git-parallel.md`、`runtime-pitfalls.md`、`subagent-ops.md`；原文件 action=delete（备份兜底）；
  3. 为所有 topic 文件补 `description` / `read_when` / `topic` / `status`；
  4. 与 `AGENTS.md` / `skills/` / `docs/dev/` 重复的内容（设计评审 §2.5：quota、tmux 验收、交接实验）只能**缩成指向源文档的一行**或标 `status: stale`，删掉的每一句都进 `dropped[]` 并写理由——由用户逐文件确认。
- **不丢内容**：内容守恒校验 + 逐文件确认 + 带 manifest 的备份 + `/mem restore`（hash 冲突检测）。验收用 current-5 fixture 跑一次假 spawn 迁移，断言原文每一行都能在输出或 `dropped[]` 里找到。
- 不提供「确定性 core 迁移」：core 的取舍需要判断力；确定性部分只做 frontmatter（§7.4）。

## 9. 设置键

新增（均为 non-live：activate 时捕获，改后 `/reload`；与现有 memory 键一致）：

| 键                                           | 默认                                          | 范围/取值                      | 理由                                                                                      |
| -------------------------------------------- | --------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `memory.layout`                              | `"tiered"`（**P0 暂为 `"legacy"`，P5 翻转**） | `tiered` \| `legacy`           | legacy = 旧渲染器逐字节回退                                                               |
| `memory.toolSurface`                         | `"v2"`（**P0 暂为 `"legacy"`，P5 翻转**）     | `v2` \| `legacy`               | legacy = 旧工具定义逐字节回退                                                             |
| `memory.childProfile`                        | `"core"`                                      | `core` \| `full` \| `none`     | 子会话 token 放大是设计评审 §2.4 的最大浪费                                               |
| `memory.coreBytes`                           | 1600                                          | 256–8192，钳 ≤ blockBytes−600  | 设计评审 §4.2：约 450 token                                                               |
| `memory.blockBytes`                          | 2400                                          | 800–16384                      | 设计评审 §4.2 总目标约 685 token                                                          |
| `memory.topicWarnBytes`                      | 8192                                          | 1024–maxFileBytes              | 设计评审 §4.2「单文件 2–8KB」                                                             |
| `memory.topicMaxBytes`                       | 16384                                         | ≥topicWarnBytes，≤maxFileBytes | 设计评审 §4.2「超过 16KB 要求拆分」                                                       |
| `memory.doctor.notifyOnStart`                | true                                          | bool                           | 只走 UI，不花 token                                                                       |
| `memory.doctor.staleDays`                    | 60                                            | 7–3650                         | 设计评审 §6 P1-6 取宽松值                                                                 |
| `memory.tidy.agentType`                      | `"Plan"`                                      | 字符串                         | 只决定提示词/模型提示；工具域由 runtime 强制只读（§7.0），不能加宽                        |
| `memory.tidy.model`                          | `""`                                          | `""` 或严格 `provider/id`      | `""` = 当前主会话模型（用户决策 11）                                                      |
| `memory.tidy.timeoutMs`（文件存 `timeoutS`） | 180000                                        | 30s–1800s                      | 登记进 `TIME_SETTING_MS_PATHS`，spec 用 `seconds()`                                       |
| `memory.tidy.maxInputBytes`                  | 49152                                         | 8192–262144                    | 约 16–24k token                                                                           |
| `memory.tidy.maxOutputBytes`                 | 65536                                         | 4096–262144                    | 输出字节硬上限（评审 v1 #8）                                                              |
| `memory.tidy.maxCostUsd`                     | 2.0                                           | 0.05–50（不允许 0）            | 单次成本上限，仅对有价模型生效（无价模型见 §7.1 N1）；主会话模型可能是贵档，给 2 美元余量 |
| `memory.tidy.maxTurns`                       | 4                                             | 1–20                           | 提示词已含全文，正常 1–2 回合                                                             |

保留且语义不变：`enabled`、`injectInChildSessions`（总开关）、`allowWriteInChildSessions`、`freezeInjectionAfterWrite`、`maxFileBytes`、`maxWriteBytes`；`indexMax` 两种 layout 共用；`inlineMax` / `byteCap` 只在 `layout=legacy` 下生效（spec 描述注明）。

**回到旧行为**：`memory.layout=legacy` + `memory.toolSurface=legacy` + 可选 `memory.doctor.notifyOnStart=false`。`/mem doctor|tidy|restore` 子命令始终存在（用户触发、零被动影响）。解析沿用 `parseMemorySettings` 逐字段容错、不抛异常；旧设置文件无新键 ⇒ 取默认。

## 10. 测试清单（全部为验收项）

### 10.1 fixture 与 golden 生成协议（评审 v1 #9）

1. **fixture**：`tests/fixtures/memory/current-5/*.md` = 真实 5 文件在 P0 当时的副本（提交前跑一次 D13 同款正则 + 人工过目，无密钥）；合成 fixture `tests/fixtures/memory/synthetic/<case>/`（long-slug、huge-slug（`bytes(I) > B`）、many-files、long-desc、cjk-emoji、no-core、core-over、extra-pinned、archived-only、code-fence-heading、legacy-names（`My Notes.md`、`.hidden.md`、`中文.md` 与一个合法名——钉住 legacy 接受任意 `*.md`、v2 只认 `NAME_RE`））；CC 导入源 `tests/fixtures/memory/cc-source/<slug>/memory/*.md`（A6）。symlink / dangling / swap 场景**只在测试运行时**于临时目录创建，不入库。
2. **物化**：测试助手 `tests/memory/helpers/fixture-dir.ts` 的 `materializeFixture(name)`：`mkdtempSync(join(os.tmpdir(), "memfx-"))` 下建 `root/<slug>/`，复制文件，按 fixture 内 `mtimes.json`（缺省：按文件名序 `2026-09-01T00:00:00Z + i×60s`）`utimesSync`；`cwd` 固定为 `/fixture/repo`（slug `-fixture-repo`）；返回 `{ paths, cwd, memDir, cleanup }`。
3. **禁止真实 home**：golden 相关 suite 的 `beforeEach` 里 `vi.stubEnv("HOME", <tmp>/nohome)` 与 `vi.stubEnv("ARMORY_MEMORY_ROOT", <tmp>/root)`，并断言 `paths.memoryRoot.startsWith(os.tmpdir())`；任何代码意外走 `defaultPaths()` 也落在临时目录。
4. **时间**：`vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"))`；store 调用显式传 `nowIso` 同值。
5. **路径占位**：序列化 golden 时把临时根的所有出现替换为 `${MEMROOT}`；比较时先把 golden 中的占位替换回本次临时根，再**逐字节**比较。
6. **生成**：`UPDATE_MEMORY_GOLDEN=1 npx vitest run tests/memory/legacy-golden.test.ts` 写 `tests/fixtures/memory-legacy-golden.json`（含 `sourceCommit`、`generatedAt`——二者只作记录，比较时剔除，复审 v1-9）；环境变量未设置时测试只比较；设置了但 golden 已存在 ⇒ 测试失败（永不覆盖）。**legacy golden 必须在 P0 第一个提交里生成**，该提交 `git diff --stat -- src/` 为空（verifier 核对）。
7. tiered golden（`tests/fixtures/memory/tiered-golden/*.txt`）由 P1 用同一协议生成；verifier（不同模型）须对照 §2.2/§2.3 逐行审阅 golden 文本并在报告中确认；合入后同样永不自动再生（改格式 = 方案修订）。
8. **所有权**：每个 fixture 子目录只归一个包写（§14.2 表）；新增子目录必须先在 §14.2 登记，禁止任何包按 `tests/fixtures/memory/**` 泛匹配写入（复审 新-4）。

### 10.2 用例

**A. legacy 黄金（P0）** — `tests/memory/legacy-golden.test.ts`

1. `renderMemoryBlock` 在 current-5 / 空目录 / 单文件 / 超 indexMax / `inlineMax=0` / `byteCap=0` / `synthetic/legacy-names` 下的输出 == golden（legacy-names 证明非白名单文件名在 legacy 下照旧出现）。
2. `layout=legacy` 时 `memorySection` 输出 == golden（主会话、子会话，`childProfile=core` 也注入旧块）。
3. `systemPrompt.mode` ∈ {stable, live, legacy} × `session_start` reason ∈ {new, reload, resume}（resume/reload 从预置的 `subagent:prompt-sections` 条目恢复）⇒ system prompt 中 memory 段逐字节 == golden 且零 update（决策 10 附加条件）。
4. `toolSurface=legacy` 时工具定义 canonical 序列化 == golden（§4.5）；list/write/append 输出（固定时间、占位根）== golden。
5. `tests/memory/inject.test.ts`、`tests/memory/wire.test.ts`、`tests/sysprompt/memory-section.test.ts` 显式钉 `layout:"legacy", toolSurface:"legacy"`；`tests/memory/store.test.ts` 的 9 处 `importProject` / `importAll` 调用改 `await`、所在用例改 `async`，L237 同步 `toThrow(MemoryError)` 改 `await expect(…).rejects.toThrow(MemoryError)`，并追加「非法 slug 返回 rejected Promise、调用本身不同步抛出」一例；`tests/memory/command.test.ts` 现有 import 用例已经 `await cmd.handler(…)`，只追加「显式列表 `import a bad c` ⇒ a 已导入、在 bad 处停下、warning notify、c 未导入」一例（钉住串行 + 首错即停）；`tests/memory/tool.test.ts` 直接调用 legacy 工厂 `createMemoryTool`，与默认值无关，**零改动**；全绿。
6. CC import：`cc-source` fixture 下 `importProject` / `importAll`（含 `--force` 与重复导入 skipped）的产物字节与返回值 == golden（测试写 `await importProject(...)`，对 P0-a 的同步返回值同样成立）。

A1–A4、A6 随 P0-a（src 零改动）提交并生成 golden；A5 需要新设置键，随 P0-b 提交。

**B. safe-fs / lock（P0）** — `tests/memory/safe-fs.test.ts`、`lock.test.ts`

1. 指向目录外文件的 symlink `x.md`：`listRegular` 跳过并记 `symlink`；`renderMemoryBlock`（legacy）与 `renderTiered` 均不含其内容；`view`/`search`/体检/tidy 快照均不读取（后三者在 P2–P4 用同一夹具复测）。
2. dangling symlink：跳过、记 `dangling`、不抛。
3. 交换攻击：`lstat` 之后、`open` 之前把普通文件换成 symlink（用注入的钩子模拟）⇒ `openRegular` 以 `ELOOP` 拒绝。
4. legacy `writeMemoryFile` 目标为 symlink ⇒ 拒绝，目录外文件字节不变。
5. `createExclusive` 对已存在目标 ⇒ `EEXIST`；并发两次 create 同名（两个 Promise）⇒ 恰一个成功。
6. `renameNoClobber` 目标存在 ⇒ 拒绝且两个文件字节不变。
7. lock：两个 `withMemoryDirLock` 串行执行（时间线断言无重叠）；超时报 busy；陈旧锁（mtime 回拨 / 不存在的 pid）被打破；释放时 token 不符不删；重试定时器全部 `unref`（`process.getActiveResourcesInfo()` 无残留 Timeout）。
8. v2 append 并发：`Promise.all` 两个各自单独不超限、合起来超限的 append ⇒ 恰一个成功，文件 ≤ 上限，失败者零字节写入；成功者的原有字节（含 frontmatter）逐字节保留。
9. `.trash` / `.backup` 被预置为 symlink ⇒ `ensurePrivateDir` 拒绝。
10. fs 守卫（`tests/memory/fs-guard.test.ts`）：`src/memory/**/*.ts` 除 `safe-fs.ts` 外无任何 `node:fs` / `fs` / `node:fs/promises` 引用（静态 import、`require`、动态 import；`import type` 除外）；`lock.ts` 必须通过。
11. 短写：safe-fs 测试钩子让 `writeSync` 返回部分字节或抛 `ENOSPC` ⇒ v2 append / 读-改-写 / create 的目标字节不变、临时文件已清理；legacy append 期间无插写 ⇒ 被 `ftruncate` 回滚，有插写 ⇒ 不截断且错误注明 `partial append left in place`。
12. slug 目录 symlink：`<root>/<slug>` 链到外部目录 ⇒ 读写正常，所有 fs 调用使用 realpath（spy）；块中 `<dir>` 显示 display 路径；操作中途改指链接（钩子）⇒ 本次操作全部落在旧 `real`；canonical 目标是文件 ⇒ 视为无 memory、D14 error。
13. import 锁：两个 `importProject` 并发 ⇒ 串行（时间线无重叠）；与 v2 写并发 ⇒ 互斥；非 force 且目标已存在 ⇒ skipped、字节不变；目标是 symlink ⇒ 跳过、外部文件不变；CC 源文件是 symlink ⇒ 跳过并计入 skipped。
14. 文件名规则：`legacy-names` 下 `listRegular(names:"legacy")` 含全部 `.md`；`names:"v2"` 只含合法名，其余记 `bad-name`。

**C. hub pointerHint（P0）** — `tests/sysprompt/hub.test.ts` 追加 P-1–P-5（§2.6）。

**D. 工具面（P0）** — `tests/memory/tool-surface.test.ts`：§4.5 三条断言，在 devDep `@sinclair/typebox` 与从 pi 包解析出的运行时 `typebox` 下各跑一遍；`canonicalJson` 单测（键排序递归、数组保序、无空白）。

**E. frontmatter / meta（P0）** — `tests/memory/meta.test.ts`：成对引号、CRLF、重复键、`；` 切词、未闭合、>40 行、status/updated 校验、H1 回退、drift header 剥离后取 H1、节切分（preamble / `##` / `###` 归属 / 代码围栏内的 `##`）。

**F. 设置（P0）** — `tests/config/memory-settings.test.ts` 扩充：默认值（P0 阶段 layout/toolSurface 为 legacy；P5 改断言）、钳制、非法回落、`timeoutS` 秒 ↔ ms、`tidy.model` 非严格值回落、`maxCostUsd=0` 回落、spec 条目。

**G. tiered 渲染（P1）** — `tests/memory/tiered.test.ts`

1. current-5 ⇒ `bytes ≤ 2400`、level 2；5 个文件名全部出现；pitfalls 以 H1 + 「用户偏好」整节出现，省略行列出其余 4 节；无 `truncated`；输出 == tiered golden。
2. 合成 fixture 逐个 == golden：long-slug（L5：`bytes(minimalFrame) > B`，输出含 `line5` 且 ≤ B）、huge-slug（`bytes(I) > B` ⇒ 输出恰为 `I`）、many-files（L1，compact 尾行；再小的预算退化为溢出行）、long-desc（码点安全裁剪、每行 ≤200B）、cjk-emoji、no-core（无 primary ⇒ 无 core 部分）、core-over（L2 → 更小预算 L4 且 ⚠ 行排首位）、extra-pinned（L3，📌）、archived-only（`- (+M archived)`）、code-fence-heading（围栏内 `##` 不切节）。
3. property：I-M1a–I-M1d、I-M2–I-M4，seeded 300 例（固定种子，失败打印种子），全部对 `Buffer.byteLength(result.text)` 断言。
4. touch / 改 mtime 顺序 / readdir 顺序打乱 ⇒ 字节相同。
5. access 四变体 guide 与省略行后缀；`toolSurface=legacy` 下 `memory` 视为不存在；`<dir>` 为真实绝对路径（= `memoryDirFor(cwd)`），块中不含字面 `<dir>`。
6. `sizeTier` 边界 0/1/1024/1025/2048/2049。
7. `childProfile=core` ⇒ k=0；`none` ⇒ `""`；`injectInChildSessions=false` 压过一切；`layout=legacy` 下 childProfile 只有 none 生效。
8. access：`getActiveTools` 不存在 / 抛错 / 返回非数组 ⇒ `none`；返回 `CONSULT_READONLY_TOOLS` ⇒ `read`；四个 + `StructuredOutput` ⇒ `read`；自定义 agent 无 read 无 memory ⇒ `none`；按会话粘住：同会话内 `getActiveTools` 变化不改块，`session_start` 后重新求值。
9. MetaCache：touch 只重读 1 个文件（spy 计数）。

**H. hub 集成（P1 + P5）** — `tests/sysprompt/memory-tiered-section.test.ts`

1. stable：写 core ⇒ 下一轮 system prompt 哈希相等 + 一条 `subagent:prompt-section-update`，内容为新块。
2. stable：touch ⇒ 零 update；topic 正文追加且未跨 kB 档 ⇒ 零 update；跨档 ⇒ 一条。
3. 第 4 次变化 ⇒ pointer，文案含 `Changed this session: …` 与 access 对应片段；memory pointer 函数抛错 ⇒ pointer 无 hint 且会话无异常。
4. 恢复旧 legacy 快照 + tiered live ⇒ 恰一条 update，之后稳定；`session_compact` 后刷新为 tiered 快照。
5. provider 抛错 ⇒ SKIP；`mode=live` 每轮刷新。
6. consult 形态：分支上预置主会话完整块快照 + 子会话 core 档 / read access ⇒ 恰一条 update。

**I. 工具（P2）** — `tests/memory/tool-v2.test.ts`、`edit.test.ts`、`search.test.ts`、`budget.test.ts`、`normalize.test.ts`

1. view：目录清单含预算/健康摘要行；全文行号；view_range（含 -1、越界钳制）；section 精确 / 唯一前缀 / 歧义 / 不存在；16KB 截断；`path` 为 `/memories`、`/memories/`、`""`、缺省 ⇒ 目录。
2. create：新建含 provenance；已存在报错；core 超限拒写 + 拆分建议；status 非法拒写；缺 description 只提示。
3. str_replace：唯一匹配；0 次报错并建议 search；多次报错并列行号；省略 new_str 删除；片段 ±3 行。
4. insert：按行、按节末尾；落在 frontmatter 内报错；`insert_line: 0` + frontmatter ⇒ 规范化并注明；两者都给/都不给报错。
5. delete：进 `.trash/<唯一 id>-<name>`、同名连删两次 id 不同、保留 20 个；rename：目标存在报错、非法名报错、frontmatter 保留。
6. search：坐标格式；多词得分排序；上限 20；字面匹配（`.*` 不当正则）；CJK；archived 标记；description/read_when 命中。
7. **别名 / 互斥**（评审 v1 #5）：官方形态 `{command:"create", path:"/memories/a.md", file_text}`、`{command:"insert", path, insert_line, insert_text}`、`{command:"rename", old_path, new_path}`、`{command:"str_replace", path, old_str, new_str}` 全部成功；旧形态 `{action:"write", name, content}`、`{action:"append", name, content}`、`{action:"list"}` 成功；`path`+`name` 同值接受带 note、异值报错；`file_text`+`content` 异值报错；`command`+`action` 报错；`create` 带 `insert_text` 报错并提示字段名；无关字段忽略并出 note；另收录 Anthropic 官方文档的示例 payload 原样（`view` / `create` / `str_replace` / `insert` / `delete` / `rename` 各一例，测试注释记录来源 URL 与抄录日期，复审 v1-5）全部成功。
8. **手写文件**（用户决策 5）：str_replace / insert / append 成功 + 警告、frontmatter 字节不变；触及 frontmatter 的 str_replace 被拒；write 覆盖 / delete / rename 被拒且文件不变；CC 导入副本按手写处理。
9. T3：预算行数值正确（含 level）；精确重复行命中（列表前缀/大小写/空白差异视为相同）与未命中样例（<16 码点不报）；硬上限只在变大时生效；topicWarn 警告；append 超限整次拒绝。
10. 子会话：所有变更命令拒绝、view/search 可用；`allowWriteInChildSessions=true` 放行。
11. 围栏：`../x.md`、`a/b.md`、`/etc/x.md` 拒绝；`/memories/x.md` 接受；symlink 目标拒绝（view 与变更都拒）；读-改-写期间外部改写（钩子在复查前改 mtime/内容）⇒ `changed concurrently`、目标保留外部内容。
12. 每次成功变更恰好一次 `onAfterWrite`；失败零次。

**J. 体检（P3）** — `tests/memory/doctor.test.ts`：D01–D09、D11、D13、D14 各一正一反；D09 覆盖 L1–L4 warn 与 L5 error；D14 覆盖 symlink/dangling/bad-name/nlink；current-5 期望清单 golden（D01、D03、D06×4 …）；密钥打码；`/mem` 摘要行；启动提醒：主会话一次、子会话/无 UI 零次、同指纹 `/new` 后不重复、指纹变化后再提醒、开关关闭零次；全程从不调用 `sendMessage` / `appendEntry`；零 spawn。

**K. tidy（P4）** — `tests/memory/tidy.test.ts`、`tidy-cost.test.ts`、`restore.test.ts`（假 port + 假 ui）

1. Apply / Edit then apply / View diff→返回 / Skip / Abort all 路径。
2. 模型：`tidy.model=""` ⇒ `modelOverride` 等于 `ctx.model` 的 provider/id；设置了严格值 ⇒ 用设置；都没有 ⇒ 拒绝。
3. 成本：估价 > 上限 ⇒ 零 spawn；无价模型 ⇒ 允许，确认框 / dry-run / 报告均含 `no cost guarantee`，美元闸不启用而回合闸、输出字节闸、超时仍生效（各一例）；cap watcher 在回合边界 costUsd 超限 ⇒ `abort` 被调用、零写入；回合数到顶同理；终局超限 ⇒ 标题带 `over cost cap`。
4. 输出：`outputBytes` 超 `maxOutputBytes` ⇒ 整份作废零写入；单文件超 core/topic 上限 ⇒ 该项不可 Apply。
5. `--dry-run`：spawn 0 次、ui 展示估价、目录逐文件 sha 前后相同、无 `.backup`。
6. 写前备份存在（manifest、before/after sha）；保留 10 份；`/mem restore` 往返后字节相同。
7. restore：取消确认 ⇒ 零写入；用户改过的文件 ⇒ 冲突默认 Skip；Overwrite ⇒ 先进 pre-restore 备份；pre-restore 备份失败 ⇒ 整体中止；单文件恢复失败（只读文件模拟 EACCES）⇒ 其余继续、报告列出失败原因；`--trash` 恢复与目标已存在冲突。
8. 手写文件提案无 Apply；未交代的丢失行 ⇒ 标记且默认 Skip。
9. 应用前磁盘文件被改 ⇒ 该文件跳过；其它照常；应用在锁内（与并发 v2 写互斥，时间线断言）。
10. 批量应用只调用 1 次 `onAfterWrite`；hub 集成下一轮恰好一条 update（P5）。
11. 超时 / spawn 失败 / schema 非法 / 用户取消 ⇒ 零写入；子会话 / 无 UI / 未 attachTidy ⇒ 拒绝并说明。
12. `--frontmatter`：current-5 ⇒ 4 个 agent topic 文件提案（description=H1），pitfalls（primary core）不补 description；再跑一次零提案；手写文件只建议。
13. 迁移模式：current-5 + 预制迁移 payload ⇒ 内容守恒通过、新块 ≤ blockBytes、core ≤ coreBytes。
14. symlink 夹具 ⇒ 快照、备份、restore 都不触碰目录外文件。
15. 只读域：假 port 记录的 spawn 请求恒带 `toolDomain:"readonly"`、无 `isolation`；`memory.tidy.agentType` 设为工具表含 bash/write 的自定义类型时请求照样带 `toolDomain`（工具实际被剥离由 N 组保证）；`--dry-run` 零 spawn。

**L. 装配（P0/P5）** — `tests/memory/wire.test.ts`：layout 选择正确的渲染路由，toolSurface 选择 `tool.ts`（legacy）或 `tool-v2.ts`；`attachTidy` 只在主会话被调用；`/mem` cwd 走 worktree-origin 解析；P5 默认值翻转后 `DEFAULT_SETTINGS.memory.layout === "tiered"`。

**M. 可发现性代理（P5，确定性）** — `tests/memory/discoverability.test.ts`：对 §11.2 问题集中每个 topic 题，断言迁移后 fixture（`current-5-migrated`，由 K13 的预制 payload 落盘生成）的索引行（description/when）至少包含该题一个关键词；迁移前 fixture 至少出现目标文件名。

**N. runtime 只读工具域（P0-r）** — `tests/service/runtime-adapter-readonly-domain.test.ts`、`tests/service/spawn-readonly-domain.test.ts`

1. `toolDomain:"readonly"` + agent type `tools: ["read","bash","edit","write","memory"]` ⇒ `sessionSpec.tools` 恰为 `CONSULT_READONLY_TOOLS` + `StructuredOutput`（带 schema）/ 恰为四个（不带 schema）；agent type 无 `tools` 字段时同样。
2. H2 扩展在 `resolveSessionSpec` 中加入 `bash` / `write` ⇒ 被 H2 之后的强制覆盖。
3. policy：`bash` / `edit` / `write` / `memory` / `message_agent` / `bash_job` / `switch_context` / `Agent` / `set_model` / `consult` 全部 blocked；`policy.allow` 恰为 `{read, grep, find, ls}`（带 schema 再加 `StructuredOutput`），与 `deny` 无交集；模拟回合边界迟注册 `bash` ⇒ `setActiveTools` 剥离 + WARN。
4. 注入 / 授权（复审 v3-3）：在最宽的前提下——`deps.childBashJobsEnabled = true`、`childSwitchContextGrant = () => true`、agent type `tools` 含 `bash`、`fabric` / `nestedSpawn` / `consult` 端口全部接好——①H2 spy 收到的输入 `sessionSpec.tools`（adapter 已把 grantedReserved 合并进去，是 grantedReserved 的可观测面）与 `bash_job` / `switch_context` / `set_model` / `message_agent` / `Agent` / `consult` 无交集；②`customTools` 只含 `StructuredOutput`（带 schema）或为空；③最终 `sessionSpec.tools` 与 `policy.allow` 都不含 `bash` / `edit` / `write` / `memory` / `bash_job` / `switch_context`。对照组：同样前提、不带 `toolDomain` 的普通 run 拿到 `bash_job` 与 `switch_context`（证明前提确实足以触发授权）。
5. **越权写入端到端**（假 session driver + 临时 memory 目录）：子会话脚本依次尝试调用 `bash`（`echo x >> a.md`）、`write`、`edit`、`memory`（create）⇒ 每次都得到「工具不存在」，目录逐文件 sha256 前后相同。
6. 准入：与 `isolation` / `forkSessionFrom` / `resumeFrom` 组合 ⇒ config 错误；Agent 工具参数 schema、RPC spawn schema、workflow `agent()` opts 校验都不接受 `toolDomain`（带上即被拒或被忽略且不进 request）。
7. 回归：`tests/service/runtime-adapter-consult.test.ts`、`tests/consult/freeze-surface.test.ts`、`tests/runtime/tool-scope.test.ts` 原样绿（consult 与普通 run 在无同名冲突时行为不变；只允许为 fake handle 补 `getToolSources`）。
8. **字段分类**（复审 v3-1，追加进 `tests/service/request-threading.test.ts`）：`threadThroughRequestFields({ …, toolDomain: "readonly" })` 的输出不含 `toolDomain`；WC13 ①（真实 `src/` 通过 `tsc --noEmit`）在 P0-r 提交上保持绿——即 `toolDomain` 已登记，两个 ff4 负例夹具不动。
9. **同名覆盖单测**（复审 v3-2，`tests/runtime/tool-scope-provenance.test.ts`）：①H2 往 `customTools` 加名为 `read` / `grep` / `StructuredOutput` / `foo` 的工具 ⇒ 交给 driver 的 spec 只剩 runtime 自有 `StructuredOutput`（对象同一性断言），WARN 列出被剔除名；②fake handle `getToolSources` 报 `read → "ext:/x/evil.ts"` ⇒ `onBind` 剥离 `read`、`rejectedShadowed = ["read"]`、WARN；其余三个 builtin 保留；③回合边界才出现的覆盖（第 2 次 `onTurnBoundary` 时来源变化）同样剥离；④handle 无 `getToolSources` / 抛错 / Map 缺名 ⇒ provenance 名单全部剥离（fail-closed）；⑤`StructuredOutput` 来源非 `sdk` ⇒ 剥离；⑥未设 `provenance` 的 policy 行为与改前逐字节一致（普通 run）；⑦readonly 域 adapter 交给 driver 的 `StructuredOutput` definition `Object.isFrozen === true`，普通 run 不冻结（行为不变）。
10. **误配置同名 custom read 端到端**（复审 v3-2；v5 按 §7.0.0 改名，语义为「误配置 / 同名工具遮蔽 builtin 被剥离」，不是恶意扩展防御；v6 按复审 v5-3 拆路径；`tests/integration/readonly-domain-shadow-real-session.test.ts`，仿 `child-bash-jobs-real-session.test.ts`：真实 `createAgentSession` + `DefaultResourceLoader({ extensionFactories })` + 脚本化假模型）。**公共装置**：同名 `read` 的 `execute` 带副作用（在临时目录写标记文件并往 memory 夹具追加一行），用来观测它是否被调用；会话 `tools` 为 `read/grep/find/ls/StructuredOutput`（`StructuredOutput` 为冻结 definition，顺带证明 pi 接受冻结对象），经生产同一函数 `toolSourcesOf(session)` 包装成 handle，并按 runner 的接法订阅 `session.subscribe`：bind 后跑 readonly policy 的 `onBind`，`turn_start` / `turn_end` 跑 `onTurnBoundary`。脚本化模型记录每次请求收到的 messages，用 pi-ai 导出的 `getCurrentTools(messages)` 算出该请求的**声明集**；工具结果从 transcript 读取。各路径共同断言：`toolSourcesOf` 报出的 `read` 来源不是 `builtin`（pi 确实用它覆盖了 builtin，测试前提成立）；剥离后 active 集合不含 `read`；标记文件不存在，memory 夹具逐文件 sha256 前后相同；`StructuredOutput` 正常收到值。
    - (a)/(b) **bind 路径**：扩展在工厂里 `registerTool({ name: "read" })`（a），或 SDK `customTools` 含同名 `read`（b）。模型第 1 轮调用 `read`、第 2 轮交 `StructuredOutput`。断言：`onBind` 已剥离；**第 1 次请求的声明集不含 `read`**（bind 核验决定首回合声明）；模型硬调 `read` 得到 `Tool read not found`。
    - (c) **首回合路径**（bind 之后、首回合声明之前注册，声明早于 turn_start）：(c1) 扩展在 `before_agent_start` 处理器里注册同名 `read`；(c2) 扩展在自己的 `turn_start` 处理器里、第 1 回合注册。模型第 1 轮调用 `read`、第 2 轮交 `StructuredOutput`。断言：bind 时没有违例（`rejectedShadowed` 为空）；剥离发生在第 1 回合的 turn_start 核验点；**第 1 次请求的声明集含 `read`**（钉住已接受的过渡：首回合声明在 `prompt()` 里定下）；第 1 回合的 `read` 调用得到 `Tool read not found`，不用等 turn_end。
    - (d) **turn_start 迟注册**（第 ≥2 回合）：扩展在第 2 回合的 `turn_start` 处理器里注册同名 `read`。模型第 1 轮调用 `read`（builtin 正常返回夹具内容）、第 2 轮再调 `read`、第 3 轮交 `StructuredOutput`。断言：第 2 次请求的声明集含 `read`（L116 的差量比较的是 `turn_start` 之前的 `context.tools`）；第 2 回合的 `read` 调用得到 `Tool read not found`。
    - (e) **下一回合追平**：接在 (c1)/(c2)/(d) 之后，断言被剥离后的**下一次请求**的声明集不含 `read`，且 transcript 里有一条 `toolsRemoved` 含 `read` 的 system 消息。另加 turn_end 变体：扩展在 `tool_result` 处理器里注册同名 `read`，由 turn_end 核验剥离，断言下一次请求的声明集与可执行集合都不含 `read`（没有 not found 过渡）。
    - **对照组**：同一会话不跑 enforcer ⇒ 标记文件被创建（证明同名实现真会被调用，测试不是空转）。
11. **runner turn_start 接线**（v5，`tests/runtime/runner-readonly-turn-start.test.ts`，假 driver 发 `turn_start` / `turn_end` 事件）：①policy 带 `provenance` ⇒ 每个 `turn_start` 与 `turn_end` 各调用一次 `onTurnBoundary`，`onBind` 仍在 prompt 之前恰一次；②policy 不带 `provenance`（普通 run / 无 toolScope）⇒ `turn_start` 不调用 enforcer，调用序列与改前逐项相同；③run 已终态（deadline 同 tick 触发）⇒ turn_start 不调用（与 turn_end 同一 `isTerminalStatus` 守卫）；④`tests/runtime/runner-x3-x11.test.ts` 原样绿。

## 11. 真机验收（主会话，P5 后，发布门禁）与零工具命中率评测（后续 E1，非发布阻塞）

### 11.1 真机步骤（tmux，方法见 memory `live-acceptance-tmux.md`）

- R0 基线：在 **P0-a 提交的检出**上执行（src 与 #22 前 master 相同；P0-r / P0-b 合入之后仍可随时用 `git worktree add <tmp> <P0-a sha>` 复现，不再要求抢在合入前做），scratch cwd `/tmp/memacc`，`ARMORY_MEMORY_ROOT=/tmp/memacc-root`，把当前 5 文件复制到 `/tmp/memacc-root/-tmp-memacc/`（不碰真实 `~/.pi/agent/memory`），`/record on`，发一个用户轮，导出首请求 system 中的 memory 段作为 legacy 对照（R7 用）。
- R1：新代码下首请求 memory 段 ≤2,400B、无 `truncated`、兜底路径为 `/tmp/memacc-root/-tmp-memacc/…` 真实路径。
- R2：（v4 移出发布门禁）§11.2 命中率评测归后续包 E1，不阻塞发布；R1–R7 中其余步骤仍是发布门禁。
- R3：让模型 `str_replace` 一条 ⇒ 下一用户轮 system 哈希不变、`cacheRead ≥ 上一前缀 × 0.9`、出现一条 update；`touch` 一个文件 ⇒ 下一轮无 update。
- R4：派一个 verifier 子 agent（工具表无 memory）⇒ 其请求的 memory 段为 core 档、guide 为 `read` 变体，模型能用 `read <真实路径>` 打开主题。
- R5：`/mem doctor` 输出合理；启动提醒只出现一次，`/new` 后不重复。
- R6：`/mem tidy --dry-run` 零 spawn；`/mem tidy --frontmatter` 走完；`/mem tidy`（主会话模型）走完逐文件确认、报告含实际成本；`.backup/<id>` 存在；下一轮恰好一条 update；`/mem restore` 能还原并正确报告冲突。
- R7：设置 `layout=legacy` + `toolSurface=legacy` 后 `/reload` 再 `/new` ⇒ memory 段与 R0 逐字节相同（`touch -d` 固定与 R0 相同 mtime）。**设置切换需新会话或 `/new` 才重新计算**；sysprompt 快照在 `/reload` 时逐字节恢复（by design），不能拿旧会话的 reload 作为新设置生效的判断。
- 清理：按确切路径删 `/tmp/memacc`、`/tmp/memacc-root`；R0 若用了 P0-a worktree，按确切路径 `git worktree remove`。E1 的清理见 §11.2「清理」。

### 11.2 零工具命中率评测（后续包 E1，非发布阻塞；探索性指标；评审 v1 #4、复审 v1-4、复审 v3-4、复审 v4-3/4、复审 v5-1/2）

**定位**：**探索性指标，不作硬门禁**（用户决策 N4 = A，2026-09-27）；**后续、非发布阻塞项**（复审 v3 建议）：运行器与报告归后续包 E1，在 P5 发布之后执行，结果不回卷已发布版本，只驱动下一轮 guide/索引文案修订。每题每组 5 次仍只能发现大幅退化；硬门禁由确定性测试承担——M 组（可发现性代理）、G1（current-5 字节/级别/无截断）、R1 / R3 / R4 / R7 真机步骤。评测结果只用来发现明显退化并驱动 guide/索引文案调整。

**问题集**（P0-a 冻结为 `docs/dev/memory/eval/questions.json`；每题 `{id, class, question, source, must: string[], mustNot: string[]}`；正则大小写不敏感，只在最终答案文本上判定；`correct` = `must` **全部**命中且 `mustNot` **无一**命中。P0-a 的 verifier 对照 current-5 原文逐题复核：照抄正确事实的答案必中，常见错误答案必不中）：

| id  | class | 问句（摘要）                           | source                          | must（全部命中）                                        | mustNot                           |
| --- | ----- | -------------------------------------- | ------------------------------- | ------------------------------------------------------- | --------------------------------- |
| Q1  | core  | 本仓库提交代码有什么规则？             | pitfalls › 用户偏好             | `git commit`；`精确\|exact\|specific`                   | —                                 |
| Q2  | core  | stream 中断或 502 时该怎么处理子任务？ | pitfalls › 用户偏好             | `resume`；`换线\|another route\|switch`                 | `先问\|ask (the )?user`           |
| Q3  | core  | 开发包和验收分别用什么模型？           | pitfalls › 用户偏好             | `claude-sonnet-5`；`gpt-5\.6-sol`                       | —                                 |
| Q4  | topic | 本机 subagent 并发上限是多少？         | pitfalls › 并发（迁移前被省略） | `\b10\b`；`concurrencyLimit\|并发`                      | —                                 |
| Q5  | topic | 1h 与 5m 的 prompt cache 能互相读吗？  | cache-ttl.md                    | `不能\|无法\|不可\|cannot\|can't\|separate\|分离`       | `可以互相读\|can read each other` |
| Q6  | topic | 判断缓存命中应该用什么基准？           | cache-ttl.md                    | `0\.5`                                                  | —                                 |
| Q7  | topic | quota 5h 窗口的阶梯阈值是多少？        | quota.md                        | `50`；`75`；`90`                                        | `95\|98`（周窗口的值）            |
| Q8  | topic | 真机验收怎么驱动独立 pi 实例？         | live-acceptance-tmux.md         | `tmux`                                                  | —                                 |
| Q9  | topic | 这台机器 bash 工具实际是什么 shell？   | pitfalls › 运行时               | `zsh`                                                   | —                                 |
| Q10 | topic | consult fork 要不要裁剪工具输出？      | multi-agent-experiments.md      | `不(做\|需要?\|用)?裁剪\|no(t)? trim\|without trimming` | —                                 |

每个问句后固定追加 `\n\nAnswer in at most two sentences.`，限制长度，减少「列举多个候选碰巧命中」的假阳性。

**三组固定映射**（复审 v3-4；运行器内写死，不接受命令行改组）：

| 组            | 代码检出                                                                                   | 设置（写入临时 `home/.pi/agent/pi-subagent.json`）                                                                               | memory fixture（复制进临时 `root/<slug>/`）                                       |
| ------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `baseline`    | `git worktree add /tmp/memeval-base <P0-a sha>`（#22 前行为）+ `ln -s <repo>/node_modules` | `{"memory":{"enabled":true},"cacheTtl":{"mode":"off","keepalive":false}}`（v6，见「短缓存强制」）                                | `tests/fixtures/memory/current-5/`                                                |
| `tiered-pre`  | 被评测的发布提交（P5 或之后）的干净检出                                                    | `{"memory":{"enabled":true,"layout":"tiered","toolSurface":"v2"},"cacheTtl":{"mode":"off","keepalive":false}}`（显式写出防漂移） | `tests/fixtures/memory/current-5/`                                                |
| `tiered-post` | 同 `tiered-pre`                                                                            | 同 `tiered-pre`                                                                                                                  | `tests/fixtures/memory/current-5-migrated/`（P4 所有，K13 预制迁移 payload 落盘） |

- 三组 fixture 一律从 **tiered 检出**读取；运行器启动时校验 `current-5/` 在 tiered 检出与 `/tmp/memeval-base` 中逐文件 sha256 相同（P0-a 以来不可变），不同 ⇒ 拒绝运行。`current-5-migrated/` 缺失 ⇒ 拒绝运行。
- slug：运行器按 `src/memory/paths.ts` 的 `toSlug` 同一规则（去尾 `/`、`/` → `-`）由临时 `repo/` 路径计算（与 `toSlug` 的一致性由 E1 单测对照钉住）；fixture 的 `mtimes.json` 按 §10.1 物化规则 `utimes`。

**运行器**（`scripts/dev/memory-eval.mjs`，**E1 提交**（v4 从 P0-a 移出）；无依赖 Node 脚本）：

| 项         | 固定值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隔离       | 每组一个临时根 `/tmp/memeval-<group>-<ts>/`：`home/`（`HOME` 指向它；toolkit 设置文件路径由 `homedir()` 决定，脚本在 `home/.pi/agent/pi-subagent.json` 写入该组设置——**从不改动真实设置文件**）、`root/`（`ARMORY_MEMORY_ROOT`，复制该组 fixture）、`repo/`（cwd，空目录，无 AGENTS.md）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| pi 配置    | `PI_CODING_AGENT_DIR=<临时根>/agent/`（v5 私有 agent 目录，0700）：`models.json` 为真实 `~/.pi/agent/models.json` 的副本（0600），只把评测模型条目的 `maxTokens` 改写为 `--out-tok-max`（见「总预算」）；`auth.json` 为指向真实文件的 symlink（不复制凭据）；`settings.json` 只写 `{"cacheWarming":"off"}`（v6，见「短缓存强制」；v5 为无 settings.json）。另加 `--no-session`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| extension  | `--no-extensions -e <该组检出>/index.ts`（不加载已安装的 pi-toolkit 包或其它扩展）；检出按上表三组映射。任一检出工作树脏（`git status --porcelain` 非空）⇒ 脚本拒绝运行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 其它加载   | `--no-skills --no-prompt-templates --no-context-files --no-themes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 工具       | `--tools read,grep,find,ls,memory`（三组相同；去掉 bash/edit/write，避免副作用）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 模型       | `--model cr-anthropic/claude-sonnet-5 --thinking low`；JSONL 中 assistant 消息的实际 provider/model 与之不符 ⇒ 该次记 `model_mismatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 设置       | baseline `{"memory":{"enabled":true},"cacheTtl":{"mode":"off","keepalive":false}}`；tiered-pre / tiered-post `{"memory":{"enabled":true,"layout":"tiered","toolSurface":"v2"},"cacheTtl":{"mode":"off","keepalive":false}}`（P5 后 memory 两键即默认值，显式写出防漂移；`cacheTtl` 两键三组相同，v6 见「短缓存强制」）；其余键缺省                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| pi 可执行  | **不依赖 PATH**（复审 v3-4；v5 按复审 v4-3 改正解析方式）：默认由运行器脚本自身 `import.meta.resolve("@earendil-works/pi-coding-agent")` 解析（脚本位于 tiered 检出，故解析到该检出的 `node_modules`；实测得 `…/node_modules/@earendil-works/pi-coding-agent/dist/index.js`）→ `findPackageRoot`：自该文件目录向上最多 8 级，找到 `package.json` 且 `name === "@earendil-works/pi-coding-agent"` 的目录 → 读 `bin`（字符串或对象的 `pi` 键；0.87.1 为 `{"pi":"dist/bundle/cli.js"}`）→ `path.resolve(包根, bin)`，必须是普通文件（`dist/bundle/cli.js` 只是 `createRequire(import.meta.url)("./cli-runtime.js")` 的薄壳，同目录）。**不用** `require.resolve`：该包 `exports` 只有 `import` 条件且未导出 `./package.json`，`require.resolve("…/package.json")` 与 `require.resolve("@earendil-works/pi-coding-agent")` 在本仓库（Node 22.22.1）实测均抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。`--pi <path>` 显式覆盖：必须是绝对路径、存在且为普通文件，否则拒绝运行。三组共用这一个 cli（baseline 的 `node_modules` 本就是软链）。解析失败 ⇒ 拒绝运行。记录 cli 绝对路径、解析方式（`resolved` / `override`）、sha256 与包根 `version` |
| 调用       | `child_process.spawn(process.execPath, [piCli, "--mode","json",…flags, prompt], { env })`（不经 shell、不查 PATH）；`env` 由纯函数 `buildChildEnv(process.env, group)` 生成：复制父进程环境，覆盖 `HOME` / `ARMORY_MEMORY_ROOT` / `PI_CODING_AGENT_DIR` / `PI_SKIP_VERSION_CHECK` / `PI_TELEMETRY`，并**删除** `PI_CACHE_RETENTION`（v6，见「短缓存强制」）；stdout 按 LF 分帧、去掉可选 `\r`（`docs/json.md` 要求，不用 readline）；stderr 另存                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 超时       | 每次 180s：到时 SIGTERM，5s 后 SIGKILL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 重复与顺序 | 每题每组 **5 次**；三组交错执行（Q1-base、Q1-pre、Q1-post、…），题序按固定种子打乱，摊平上游时段波动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 重试       | 只重试**传输层失败**：退出码非 0 且 stderr 匹配 `429\|5\d\d\|ECONNRESET\|stream (ended\|interrupted)\|overloaded`，或最后一条 assistant `stopReason:"error"`；单次最多 2 次，间隔 15s / 45s，次数记入明细；**全程重试总数 ≤ 30**（用完后传输层失败直接归 `exit_nonzero`）。超时、非法 JSONL、模型不符不重试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 预算       | 见下「总预算」：`--max-calls`（默认 180）、`--max-usd`（默认 15，v6：尽力预算 + 有界超支，不是硬上限）、`--max-wall-min`（默认 240）、`--max-requests`（每次调用的 assistant 请求数 K，默认 6）、`--in-tok-max`（默认 32,000）、`--out-tok-max`（默认 4,096），任一触顶即中止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 记录       | 结果头部：pi cli 绝对路径 / 解析方式 / sha256 / 版本、`node --version`、各组检出 sha、各组 fixture 目录 sha256、脚本 sha256、问题集 sha256、各组设置 JSON、完整 flags、模型与所用价格（`cost.*`，含 `tiers`）、`W_req` / `R` 及其取到最大值的费率项、各项预算上限与实际消耗（含在途请求的保守记账额与失败请求按 `W_req` 的记账额）、短缓存强制状态（父进程 `PI_CACHE_RETENTION` 原值或 unset、已删除；`cacheWarming`；`cacheTtl`）、「有界超支」估计额（`2 × W_req`）、起止时间                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**每次运行的归类**（互斥，按序判定）：`timeout` → `request_cap`（v5：第 K 条 assistant `message_end` 仍带工具调用，被运行器 SIGKILL）→ `usage_invalid`（v6：某条 assistant `message_end` 的 usage 缺失或不完整，见「总预算」，同时中止整次评测）→ `spawn_error`（进程起不来）→ `invalid_jsonl`（任一非空行 `JSON.parse` 失败，或首条记录不是 `type:"session"` 头）→ `exit_nonzero`（重试耗尽）→ `no_final`（没有 `agent_settled`，或没有 role=assistant 的 `message_end`）→ `model_mismatch` → `ok`。只有 `ok` 进入指标分母，其余逐类计数列在汇总表；某组非 `ok` 占比 > 20% ⇒ 该组标 `unreliable`，不据此下结论。

**指标**（只从 `ok` 运行解析；最终答案 = 最后一条 role=assistant `message_end` 的文本块拼接）：

- `T_all` = `tool_execution_start` 事件数；`T_mem` = 其中 `toolName === "memory"`，或 `toolName ∈ {read, grep, find, ls}` 且参数中出现 memory 根路径的调用数；
- `zero` = `T_all === 0`；`hit1` = 第一个 memory 相关调用的目标（`path` / `name` / `query` 命中的文件，或 read 路径）即期望文件；`correct` 如上；
- 每个比率附 Wilson 95% 区间。

**报告与解读**：写 `docs/dev/memory/eval/results-<date>.md`（明细 + 汇总 + 运行元数据）。参考线（非门禁）：core 题 `tiered-pre` 的 `zero ∧ correct` 不低于 baseline；topic 题平均 `T_mem` 不高于 baseline；`tiered-post` topic `hit1` ≥ 80%。**退化信号**：同一指标 tiered 与 baseline 的 Wilson 区间不重叠且下降 ≥ 20 个百分点 ⇒ 主会话上报用户，由用户决定是否回 P1 修改 guide/索引文案（冻结面变更，走方案修订）；不调预算默认值。

**总预算**（复审 v3-4：重试最多三倍但原先无总上限；v5 曾按复审 v4-4 改为「预留式硬上限」；**v6 按复审 v5-1/2 与主会话裁定改为「尽力预算 + 有界超支」**：命中率评测是探索性、非发布阻塞工具（N4 = A），不值得为它做硬成本闸门；不加子进程请求闸 / 握手。本节**不承诺**累计实际成本 ≤ `maxUsd`，只承诺下文的记账规则、fail-closed 中止条件和写明的超支界）：

- **调用数**：每次进程启动（含重试）计 1；计划 150 次 + 重试总数 ≤ 30 ⇒ 上限 `--max-calls` 默认 **180**。启动下一次前 `calls + 1 > maxCalls` ⇒ 中止。
- **价格来源**：启动时从真实 `~/.pi/agent/models.json` 读评测模型条目的 `cost`（USD / 1M token，含可选 `tiers`）。`cost` 缺失、`input` 与 `output` 均为 0，或 `cost` / 任一 tier 的 `input/output/cacheRead/cacheWrite` 不是有限非负数 ⇒ **拒绝运行评测**（v5 起无 `--allow-unpriced`）。
- **短缓存强制**（v6，复审 v5-1）：长缓存会把写入费率抬到 2× input（Anthropic 1h），还会让缓存条目活过单次调用。子进程三处强制短缓存：①环境里**删除** `PI_CACHE_RETENTION`——pi 0.87.1 读取的唯一缓存保留期变量（pi-ai `getProviderEnvValue("PI_CACHE_RETENTION")`，只认 `"long"`，见 `api/anthropic-messages.js` L21–28、`openai-completions.js`、`openai-responses`、`bedrock-converse-stream.js` 与 pi-coding-agent `core/cache-warmer.js`；CLI bundle 各 chunk 同名）；未设置即 `"short"`。不改写为其它值，因为 pi 只比较 `=== "long"`；②私有 agent 目录 `settings.json` 写 `{"cacheWarming":"off"}`：pi 默认 `streaming` 会自发缓存刷新请求（`core/cache-warmer.js`，只读全局设置），这些请求不产生 assistant `message_end`，运行器看不到；③toolkit 设置 `cacheTtl:{mode:"off",keepalive:false}`：`mode:"off"` 让 toolkit 在每个请求上剥掉 `cache_control.ttl`（`src/cache-ttl/cache-ttl.ts` 的 `strip-ttl`，即便环境变量漏网也回到 5m；`auto` 下保活预算用尽后的 `consumeUpgrade` 会强制 1h，`off` 下不会发生），`keepalive:false` 关掉 toolkit 保活 ping（同样是看不到的请求）。三组设置相同，不影响组间对比。E1 单测钉住：`buildChildEnv({ PI_CACHE_RETENTION: "long", … })` 的输出不含该键；扫描所解析 pi 包 `dist/` 下全部 `.js` 中经 `getProviderEnvValue("…")` / `process.env.…` 读取、名字匹配 `/^PI_[A-Z_]*CACHE[A-Z_]*$/` 的变量名，集合必须恰为 `{PI_CACHE_RETENTION}`，pi 升级引入新变量时该测试失败、提示复查。
- **单请求输出封顶**：pi-ai 以 `options.maxTokens ?? model.maxTokens` 作 `max_tokens`（`api/anthropic-messages.js` L813，thinking 预算也在其内），pi CLI 没有 max-tokens 参数 ⇒ 运行器在私有 agent 目录的 `models.json` 里把该模型 `maxTokens` 改写为 `outTokMax`（默认 4,096；答案限两句，足够），由 provider 侧强制。
- **最坏单请求成本 `W_req`**（v6，复审 v5-1：覆盖 pi-ai `calculateCost`（`models.js` L533–550）的全部计费项）：`calculateCost` 先按 `input + cacheRead + cacheWrite` 选出命中的最高 tier（整请求用该档费率），再计 `input × rate.input + output × rate.output + cacheRead × rate.cacheRead + (cacheWrite − cacheWrite1h) × rate.cacheWrite + cacheWrite1h × 2 × rate.input`。取最坏值：令费率集合 `S = [cost, ...(cost.tiers ?? [])]`，
  `inRateMax = max over r∈S of max(2 × r.input, r.cacheWrite, r.cacheRead)`（`2 × input` 覆盖 1h 写入，也 ≥ 普通 input），`outRateMax = max over r∈S of r.output`，
  `W_req = (inTokMax × inRateMax + outTokMax × outRateMax) / 1e6`。
  即全部输入 token 按所有档位中最贵的输入类费率计，输出按最贵档输出费率计。1h 写入项已被短缓存强制排除，仍计入 `W_req`，这样即便强制失效，单条请求的成本上界依然成立。`inTokMax` 默认 32,000（首请求实测约 8–12k，加上把全部 fixture 读一遍的工具输出仍有余量）。sonnet 档（models.json：input 3 / output 15 / cacheRead 0.3 / cacheWrite 3.75，无 tiers）：`inRateMax = 6`，`W_req = (32,000 × 6 + 4,096 × 15) / 1e6 ≈ $0.253`。
- **单次调用请求数封顶**：运行器数 role=assistant 的 `message_end`；第 K 条（默认 6）仍带工具调用 ⇒ 立即 SIGKILL（不给宽限，`--no-session` 无需优雅退出），归 `request_cap`。**没有代码契约保证 SIGKILL 落地前 pi 不再发下一条请求**（复审 v5-2）：pi 执行只读工具只要毫秒级，随即 `prepareRequest` 发请求，stdout 管道延迟加 kill 延迟可能被它抢先。因此 K+1 只是**记账假设**，不是上界。
- **记账**：`spent` = 已结束请求的成本之和。①每条 assistant `message_end`（`stopReason` 为 `stop` / `toolUse` / `length`）取 `max(usage.cost.total, priceOf(usage))`，`priceOf` 是 `calculateCost` 的镜像（tier 选择与 `cacheWrite1h` 计法相同；E1 单测拿 pi-ai `calculateCost` 做对照，覆盖有 tiers 和有 `cacheWrite1h` 的样例），路由不报 cost 也能记账；②`stopReason` 为 `error` / `aborted` 的 `message_end`：失败请求的 usage 不可信（常为全 0，但可能已计费），按 `max(上面的值, W_req)` 记；③调用以 `request_cap` / `timeout` / `usage_invalid` / 传输错误结束时，最后一条未见 `message_end` 的在途请求按 `W_req` 记一条。
- **usage 完整性（fail-closed）**：每条 assistant `message_end` 必须带 `usage` 对象，其中 `input` / `output` / `cacheRead` / `cacheWrite` / `cost.total` 都是有限非负数；`cacheWrite1h` 可缺省，出现时必须有限、非负且 ≤ `cacheWrite`。任一不满足 ⇒ SIGKILL 当前调用，该请求按 `W_req` 记账，该次运行归 `usage_invalid`，**立即中止整次评测**（`status: aborted (usage)`）。`cacheWrite1h > 0` 说明短缓存强制失效 ⇒ 同样立即中止（`status: aborted (cache)`），该请求照常按 ① 记账，成本仍 ≤ `W_req`。
- **派发规则（尽力预算）**：单次调用预留 `R = (K + 1) × W_req`（sonnet 档默认 `R ≈ 7 × $0.253 ≈ $1.77`）。每次启动（含重试）前要求 `spent + R ≤ maxUsd`，否则中止；启动时 `maxUsd < R` ⇒ 拒绝运行。
- **前提逐请求核验**：每条 assistant `message_end` 检查 `usage.input + usage.cacheRead + usage.cacheWrite ≤ inTokMax`、`usage.output ≤ outTokMax`，以及同一调用内请求数 ≤ K+1。任一违例 ⇒ SIGKILL 当前调用、立即中止整次评测（`status: aborted (estimate)`），报告头写明违例请求及其超出 `W_req` 的差额。
- **有界超支（写明，不是保证）**：在「每条请求成本 ≤ `W_req`」这一前提下（由上一条逐请求核验，违例即中止），累计实际成本 ≤ `maxUsd + N_unacc × W_req`。`N_unacc` 是整次评测中**未被记账的已计费请求数**，即没有 `message_end`、也没有被规则 ③ 覆盖的请求。**保守估计按 `N_unacc = 2` 计，超支 ≤ 2 × `W_req` ≈ $0.51**（sonnet 档）。理由：(i) pi agent loop 在一个进程里严格串行，任一时刻至多一条在途请求；两个后台请求源（pi `cacheWarming`、toolkit 保活）已关闭，工具集里没有 Agent / bash，不会派生子会话或外部请求；(ii) 以 kill / timeout / 错误结束的调用，规则 ③ 已为最后一条在途请求记了 `W_req`，失败请求按规则 ② 至少记 `W_req`；(iii) 剩下的只有两类罕见事件：一是 SIGKILL 落地前 pi 已完成第 K+1 条请求**并且**又发出第 K+2 条（需要一次模型请求在 kill 延迟内完整返回，实际不会发生）；二是 provider SDK 内部重试中被计费、却没有产生 `message_end` 的失败尝试（429 / 5xx 大多在响应头阶段失败、不计费）。每类整次评测按至多 1 次估计，合计 2 条。这个估计不作保证，报告头照录 `2 × W_req`；若事后账单显示超支超过该值，在结果文件里记一笔，只影响下次预算设置，不回卷结论。
- **墙钟**：`--max-wall-min` 默认 240。
- **中止语义**：停止派发新运行、等当前运行结束或超时；把已完成明细与汇总落盘为 `results-<date>.md`，头部 `status: aborted (calls|usd|wall|estimate|usage|cache)` 并列出已完成 / 计划数；进程退出码 3。aborted 报告只作记录，不据此下结论。正常完成退出码 0。价格缺失或非法、`maxUsd < R`、cli 解析失败、检出脏、fixture sha 不符属启动前拒绝，退出码 2，不落盘报告。
- 启动时打印计划调用数、典型成本估算、`W_req` / `R`、有界超支估计 `2 × W_req` 与各项上限，`--yes` 以外需要在终端确认一次（脚本只由人手动运行）。

**成本估算**：3 组 × 10 题 × 5 次 = 150 次调用（不含重试）；无 skills / context files 时首请求约 8–12k 输入 token，按 sonnet 档估 **$5–10**。尽力预算 $15（每次调用前预留 `R ≈ $1.77`，所以最后约 $1.77 额度不会被用掉；失败请求按 `W_req` 记账，传输层故障多时会提前触发 `aborted (usd)`，这种运行本来也不可靠），有界超支估计 ≤ $0.51。

**清理**：按确切路径删本次 `/tmp/memeval-<group>-<ts>/` 三个临时根（含私有 agent 目录里的 `models.json` 副本——它可能含字面量 API key，故 0600、随临时根删除；`auth.json` 只是 symlink，删链接不动真实文件），`git worktree remove /tmp/memeval-base`；评测经 HOME 重定向注入设置，从不改动真实 `~/.pi/agent/pi-subagent.json`。

**E1 文件域**：`scripts/dev/memory-eval.mjs`（纯函数——slug、JSONL 归类、指标、预算判定——以具名导出暴露）、`tests/scripts/memory-eval.test.ts`（对这些纯函数单测，含 `toSlug` 镜像与 `src/memory/paths.ts` 的对照、归类顺序（含 `request_cap`）；v5 追加：①**真实 Node 解析**——`child_process.execFileSync(process.execPath, ["--input-type=module", "-e", <import 脚本并打印 resolvePiCli()>])`，在 vitest 转换之外用真实 Node ESM 解析，断言得到绝对路径、以 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` 结尾、是普通文件，且与读 `package.json` 的 `bin.pi` 一致；同一子进程再断言 `createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（钉住放弃 `require.resolve` 的原因，pi 升级若导出 `./package.json` 该断言会提示复查）；②`findPackageRoot` / `binPath` 用临时目录：`bin` 为字符串 / 对象、缺 `bin`、`name` 不符、超过 8 级、目标不是普通文件；`--pi` 非绝对路径 / 不存在 ⇒ 拒绝；③成本：`W_req` / `R` 公式（v6：含 tiers 各档、`cacheRead`、`2 × input`，取最大项；tier 字段非法 ⇒ 拒绝）、`priceOf` 与 pi-ai `calculateCost` 对照（无 tier / 命中 tier / 含 `cacheWrite1h`）、`spent + R > maxUsd` 中止、`maxUsd < R` 启动拒绝、无价拒绝、token 复算与报告 cost 取大、`error` / `aborted` 请求按 `max(·, W_req)` 记账、在途请求按 `W_req` 记账、input / output / 请求数违例 ⇒ `aborted (estimate)`、usage 缺字段 / 非有限 / 负数 / `cacheWrite1h > cacheWrite` ⇒ `usage_invalid` + `aborted (usage)`、`cacheWrite1h > 0` ⇒ `aborted (cache)`；④私有 agent 目录：`models.json` 只改评测模型的 `maxTokens`、其余逐字节保留，`auth.json` 为 symlink，`settings.json` 恰为 `{"cacheWarming":"off"}`；⑤（v6）短缓存强制：`buildChildEnv` 删除 `PI_CACHE_RETENTION` 并覆盖五个固定键，三组设置 JSON 都含 `cacheTtl:{mode:"off",keepalive:false}`，pi 缓存相关环境变量名扫描集合恰为 `{PI_CACHE_RETENTION}`；不启动 pi）、`docs/dev/memory/eval/results-*.md`。E1 只读 `docs/dev/memory/eval/questions.json`（P0-a）与 fixture。

## 12. 决策（v1 的 14 条 + 用户决策 + 评审附加条件 + N1–N5 全部已拍板）

| #   | 决策                                                                                | 状态                          | 附加条件与落地位置                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `core.md` 为唯一常驻核心，`pin` 收敛为「申请整文件进 core 预算」                    | 按推荐                        | 无 core 降级只作迁移过渡，永远伴随 D01 + 启动提醒（§2.1、§6.1、§6.3）                                                                                                                                                                            |
| 2   | 无 core.md 时第一个 pinned 文件整节准入充当临时 core                                | 按推荐                        | 选择规则固定（原顺序贪心、围栏感知）+ 超预算行为固定（L2→L4）（§2.1、§2.3）                                                                                                                                                                      |
| 3   | 预算默认 core 1.6KB / 块 2.4KB / 主题警告 8KB / 主题硬上限 16KB                     | 按推荐                        | 一律 UTF-8 字节；以固定 fixture 逐字节 golden 校准（§2.3、§10.1）                                                                                                                                                                                |
| 4   | 子会话默认 `core` 档                                                                | 按推荐                        | 按实际工具表判 access；无 memory 无 read ⇒ `none` 变体（core 保留、索引只列名并声明不可打开）（§2.4）                                                                                                                                            |
| 5   | agent 修改手写文件                                                                  | **用户决策**                  | str_replace/insert/append 允许 + 警告、不改 frontmatter、不得触及 frontmatter；write 覆盖/delete/rename 拒绝；tidy 只建议（§4.3、§7.3）                                                                                                          |
| 6   | delete 软删除到 `.trash`（保留 20）                                                 | 按推荐                        | 唯一 id、`ensurePrivateDir` 防 symlink、`/mem restore --trash` 定义恢复冲突（§3.3、§7.5）                                                                                                                                                        |
| 7   | create 遇已存在报错，覆盖只能 `action:"write"`                                      | 按推荐                        | 原子 no-clobber（`link()`）（§3.1、§3.3）；兼容声明中注明与官方差异（§4.1）                                                                                                                                                                      |
| 8   | 缺 description/read_when 只提示不拒写                                               | 按推荐                        | core 与 topic 规则区分（§5、D06）                                                                                                                                                                                                                |
| 9   | 索引行不含日期，大小按 kB 档                                                        | 按推荐                        | `sizeTier` 边界测试（§2.2、G6）                                                                                                                                                                                                                  |
| 10  | `layout` 与 `toolSurface` 双回退；`systemPrompt.mode=legacy` 不隐含 `layout=legacy` | 按推荐                        | golden 覆盖 new/reload/resume × 三态（§2.7、A3）                                                                                                                                                                                                 |
| 11  | tidy 模型                                                                           | **用户决策**：与主会话一致    | `tidy.model` 可覆盖；输出字节硬上限 + 估价闸 + 运行中 cost/turn 闸，超限中止（§7.1、§7.2）                                                                                                                                                       |
| 12  | 迁移走 `/mem tidy`（迁移模式）逐文件确认                                            | 按推荐                        | 另提供 `--frontmatter` 确定性模式（§7.4）                                                                                                                                                                                                        |
| 13  | 启动体检提醒默认开                                                                  | 按推荐                        | 仅主会话、每会话一次、按 cwd + 指纹去重（§6.3）                                                                                                                                                                                                  |
| 14  | 本期包含 `/mem restore`                                                             | 按推荐                        | 显式确认、逐文件 hash 冲突检测、pre-restore 备份失败即中止、失败报告（§7.5）                                                                                                                                                                     |
| —   | 精简范围                                                                            | **用户决策**                  | `similar.ts`/D12/D15/D16 延后；T3 只做精确重复行（§4.4、§6.1、§13）                                                                                                                                                                              |
| N4  | 零工具命中率评测定位                                                                | **用户决策（2026-09-27）：A** | 探索性指标、每题每组 5 次、不作硬门禁；归后续包 E1、非发布阻塞；三组 fixture 固定映射、仓库内 pi 绝对路径（v5：`import.meta.resolve` + 包根 `bin.pi`）、调用数 + 预留式成本硬上限（§11.2、§14）                                                  |
| N5  | tidy 提案零写入的实现位置                                                           | **用户决策（2026-09-27）：A** | runtime `SpawnRequest.toolDomain:"readonly"`（P0-r）；只认 builtin 四工具 + runtime 自有 StructuredOutput，同名 custom tool 剔除/剥离；bash_job / switch_context 不授权；v5：defense-in-depth，信任同进程扩展、恶意扩展为非目标（§7.0.0、§10 N） |

**决策 N1–N3（用户 2026-09-26 已拍板）与主会话裁定**：

- **N1 无价模型 tidy**：**允许 + 警告**。不做估价闸与美元闸，只保留 `maxTurns` / `maxOutputBytes` / `timeoutMs` 硬上限；确认框、`--dry-run`、报告明确写 no cost guarantee；删除 `memory.tidy.allowUnpriced`（§7.1、§9）。
- **N2 symlink 范围**：全部路径（含 legacy）拒绝**文件级**符号链接（§3.1）。
- **N3 手写文件 provenance**：模型不能改手写文件的 frontmatter（§4.3）。
- **主会话裁定（复审 v1-7）**：`<memoryRoot>/<slug>` 目录本身是符号链接**仍允许**，每次操作 canonicalize 一次并写明「用户显式信任的配置」；目录内文件是符号链接一律拒绝。`NAME_RE` 只在 v2 路径启用，legacy 保持原文件名接受规则，字节级不变（§3.1、§2.7）。

**决策 N4–N5（用户 2026-09-27 已拍板，均选 A）**：

- **N4 命中率评测定位 = A**：探索性指标、不作硬门禁——每题每组 5 次（150 次调用，约 $5–10，尽力预算 $15 + 有界超支估计 ≤ 2 × `W_req`，v6；v5 的「预留式硬上限」已撤回），退化信号（Wilson 区间不重叠且下降 ≥ 20pp）只触发上报。硬门禁由确定性测试 M / G1 与真机 R1 / R3 / R4 / R7 承担。v4 另按复审建议把评测整体标为**后续、非发布阻塞项**（包 E1）。（未选 B：硬门禁需每题每组 ≥ 20 次、≥ 600 次调用，且上游路由波动仍可能误报。）
- **N5 tidy 零写入实现位置 = A**：runtime 只读工具域 `SpawnRequest.toolDomain:"readonly"`——复用 consult 的强制点与常量，独立提交 P0-r，文件域见 §14.1。（未选 B「内置只读 agent type `memory-tidy`」：用户同名 agent 文件可遮蔽内置类型、会改变全体用户 agent-types 提示词字节、且仍需 runtime 兜底防 H2 加宽。）

## 13. 延后项与接口预留

| 延后项                                 | 预留                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4 `Agent({ memory: [...] })`          | `TieredRenderOptions.extraTopics?: readonly string[]`（本期必须为 undefined，渲染器遇到非空直接抛错，防止半实现）；`MemorySectionDeps.resolveChildProfile?: (input) => ChildProfile`（缺省读设置）。host→child 通道将来仿 `src/bash/child-registry.ts` 做 `Symbol.for` 进程级注册表 |
| 按 agent type 映射档位                 | 同上 `resolveChildProfile`；agent 类型 frontmatter 将来可加 `memory:` 键（none / core / full）                                                                                                                                                                                      |
| T5 关键词预取                          | `MemoryMeta.readWhenTerms`；`searchMemory(cwd, query, opts)` 纯函数可复用；预取内容走 tail message，需要开关和 §11.2 同口径的命中率统计                                                                                                                                             |
| 近似查重（`similar.ts`）/ D12          | T3 结果行格式已留 `⚠ duplicate line:` 前缀；将来近似匹配用 `⚠ possible duplicate:` 另起一行，不改现有文本                                                                                                                                                                           |
| D15（CC drift 副本）                   | `listRegular` 已能识别 drift header；将来只需加一条体检规则                                                                                                                                                                                                                         |
| D16（目录总量 > tidy 输入上限）        | 由 `/mem tidy` 自身的输入上限提示覆盖；如需常驻提示再加规则                                                                                                                                                                                                                         |
| 空闲自动整理                           | `planTidy` / `applyTidy` 纯函数与 UI 编排分层，将来接 idle 触发只替换编排层（仍受 §7.1/§7.2 上限约束）                                                                                                                                                                              |
| 在线指标                               | 本期不做遥测；§11.2 评测脚本可离线复跑                                                                                                                                                                                                                                              |
| 差量 update                            | 否决（§2.6）                                                                                                                                                                                                                                                                        |
| **E1 命中率评测**（后续、非发布阻塞）  | P5 发布后执行；运行器 `scripts/dev/memory-eval.mjs` + 纯函数单测 + 结果报告（§11.2）。问题集 `questions.json` 仍在 P0-a 冻结（M 组依赖）。评测出现退化信号 ⇒ 上报用户，走方案修订改 guide/索引文案；不回卷已发布版本                                                                |
| **L1 legacy 淘汰**（后续、非发布阻塞） | `memory.layout=legacy` / `memory.toolSurface=legacy`、`src/memory/tool.ts`、legacy golden 在 P5 翻转默认值后**至少保留 2 个发布版本**；之后另立方案评估移除（需同时处理 `tests/memory/tool.test.ts` 与 A 组 golden）。本期不删任何 legacy 路径                                      |

## 14. 包拆分（dev-flow L2：冻结接口先行 → 并行写包 → 集成）

### 14.1 包与依赖

```text
P0 冻结面（串行，先行；三个有序提交 P0-a → P0-r → P0-b）
 ├─▶ P1 注入层 ─┐
 ├─▶ P2 工具层 ─┤
 ├─▶ P3 体检   ─┼─▶ P5 集成 + 默认值翻转 + 文档 + 真机 R1/R3–R7（主会话）══ 发布 ══▶ E1 命中率评测 ┄┄ L1 legacy 淘汰
 └─▶ P4 tidy   ─┘                                                                        （后续、非发布阻塞）
```

**本期范围**：P0–P5（含 `/mem doctor`、`/mem tidy`、`/mem restore`）是发布内容；E1、L1 是发布后的跟进项，不阻塞发布（复审 v3 建议，§13）。

**P0 冻结面**（1 个 dev 包、三个有序提交；产出的签名/文本在后续包中只能上报、不能自改。每个提交单独跑全量 typecheck / test / format，**每个提交都可发布**）

- **提交 P0-a（src 零改动）**：`tests/fixtures/memory/current-5/`、`tests/fixtures/memory/synthetic/`（含 `legacy-names/`、`huge-slug/`）、`tests/fixtures/memory/cc-source/`、`tests/memory/helpers/fixture-dir.ts`、`tests/memory/legacy-golden.test.ts`（A1–A4、A6）+ 按 §10.1 生成的 `tests/fixtures/memory-legacy-golden.json`；`docs/dev/memory/eval/questions.json`（M 组依赖，仍在此冻结）。评测运行器 **v4 移到后续包 E1**。verifier 核对 `git show --stat` 无 `src/` 路径，并对照 current-5 原文复核问题集正则。此提交的 sha 是 R0 与 E1 baseline 组的固定检出点（可事后用 worktree 复现，§11）。
- **提交 P0-r（runtime 只读工具域，§7.0；不碰 `src/memory/`）**：
  - `src/core/types.ts`（`SpawnRequest.toolDomain`）+ `src/service/request-threading.ts`（`NOT_THREADED` 登记 `toolDomain`，**必须同一提交**，否则 `AssertAllClassified` 编译失败，复审 v3-1）；
  - `src/service/runtime-adapter.ts`（`readonlyDomain`：注入/授权守卫、`bashJobGrant({ consult: readonlyDomain })`、switch_context 守卫、H2 后强制 tools、6a customTools 收窄、readonly 域 `Object.freeze` StructuredOutput definition、policy 带 `provenance`）；
  - `src/service/spawn-service.ts`（准入组合校验）；
  - `src/runtime/tool-scope.ts`（`ToolScopePolicy.provenance`、`ScopeSessionHandle.getToolSources?`、enforcer 来源核验、`ScopeDecision.rejectedShadowed`；保持零 pi import）；
  - `src/runtime/session-driver.ts`（`SessionHandle.getToolSources?`、导出纯函数 `toolSourcesOf(session)`、`PiSessionHandle` 实现）；
  - `src/runtime/runner.ts`（v5：bind 回调里 `turn_start` + `policy.provenance` ⇒ `onTurnBoundary`，与 turn_end 同一终态守卫；无 `provenance` 时不变）；
  - 测试：新文件 `tests/service/runtime-adapter-readonly-domain.test.ts`（N1–N5）、`tests/service/spawn-readonly-domain.test.ts`（N6）、`tests/runtime/tool-scope-provenance.test.ts`（N9）、`tests/integration/readonly-domain-shadow-real-session.test.ts`（N10）、`tests/runtime/runner-readonly-turn-start.test.ts`（N11）；追加 `tests/service/request-threading.test.ts`（N8）；既有 fake handle 若因 fail-closed 需要补 `getToolSources`，只允许改该 fake 所在测试文件的 fake 定义（改动逐个列进提交说明）。
  - 无调用方时（无 `toolDomain`、无同名冲突）零行为变化，N7 回归原样绿 ⇒ 可单独发布。
- **提交 P0-b（memory 冻结面）**：
  - `src/memory/safe-fs.ts`、`src/memory/lock.ts`（完整实现；`lock.ts` 零 fs import）+ B 组测试 `tests/memory/{safe-fs,lock,fs-guard}.test.ts`；
  - `src/memory/store.ts`：全部改用 safe-fs（`names:"legacy"`）；导出 `resolveMemoryFile`、`assertAllowWrite`；`importProject` / `importAll` 改 `async function` 并入锁（§3.3；错误一律 rejection）；其余 legacy 行为除文件级 symlink 外不变；
  - `docs/dev/memory/memory-plan.md`：只改 §8.3 冻结面 L568–569 两行签名为 `Promise<ImportResult>` / `Promise<ImportResult[]>`，并在其下加一行注「#22 optimize-plan P0-b 起为 async、入目录锁」（复审 v3-5；顶部指向本文的指针仍归 P5）；
  - `src/memory/render.ts`：只换 safe-fs 读取原语 + `memoryFingerprint` 改 lstat 列举（legacy golden 守护）；
  - `src/memory/tool.ts`：**不改**（legacy 实现原位保留，复审 新-3）；
  - `src/memory/tool-surface.ts`：§4.5 v2 冻结文本与 schema + `toolSurfaceBytes` + `canonicalJson` + D 组测试 `tests/memory/tool-surface.test.ts` 与 `tests/fixtures/memory-tool-surface.json`；
  - `src/memory/contracts.ts`（类型 + 常量）：`MemoryMeta`、`MemoryAccess`、`ChildProfile`、`TieredRenderOptions`、`TieredRenderResult`、`TIERED_TEMPLATES`、`BudgetReport`、`NormalizedCall`、`DoctorFinding`/`DoctorId`、`TidyProposal`/`TidyDecision`/`TidyManifest`、`TIDY_SCHEMA`、`TidyPort`（`spawn` 请求类型含必填 `toolDomain: "readonly"`）；
  - `src/memory/meta.ts`（完整实现 + E 组测试 `tests/memory/meta.test.ts`）；
  - `src/sysprompt/hub.ts`：§2.6 `pointerHint` 函数求值 + 异常降级 + C 组测试（`tests/sysprompt/hub.test.ts` 追加）；
  - `src/config/settings.ts`、`setting-specs.ts`：§9 全部键（`layout` / `toolSurface` 默认 **legacy**；无 `allowUnpriced`）+ `TIME_SETTING_MS_PATHS` + F 组测试（`tests/config/memory-settings.test.ts`）；
  - `src/memory/index.ts` / `command.ts` / `src/index.ts`：装配骨架——按 toolSurface 选择 `tool.ts` 或 `tool-v2.ts`，按 layout 路由渲染；`/mem` 分发 `doctor` / `tidy` / `restore` 到桩、`import` 改为 `await importAll` / `for…of` 串行 `await importProject`（§3.3）；`attachTidy(port)` 与 post-guard holder 接线（port 的 spawn 映射到带 `toolDomain` 的 `SpawnRequest`）；`/mem` cwd 解析 worktree-origin；`getActiveTools` 端口传给 inject；
  - 桩文件（签名冻结，函数体 `throw new Error("not implemented")` 或返回空；只有 `layout=tiered` / `toolSurface=v2` 或 `/mem doctor|tidy|restore` 才会触达，默认 legacy 下不可达）：`tiered.ts`、`tool-v2.ts`、`edit.ts`、`search.ts`、`budget.ts`、`normalize.ts`、`doctor.ts`、`doctor-command.ts`、`tidy/{prompt,validate,diff,cost,apply,frontmatter,restore,command}.ts`；`inject.ts` 只加 layout 路由（tiered 分支调桩）；
  - 既有测试：`tests/memory/{inject,wire}.test.ts`、`tests/sysprompt/memory-section.test.ts` 钉 `layout/toolSurface: "legacy"`；`tests/memory/store.test.ts` 9 处 import 调用改 await + L237 改 `rejects`，`tests/memory/command.test.ts` 追加串行首错即停一例（§10 A5）；`tests/memory/tool.test.ts` 零改动；A5 追加进 `tests/memory/legacy-golden.test.ts`；L 组装配测试进 `tests/memory/wire.test.ts`。
- 验收：A–F、L、N（含 N8–N11）全绿；全量 typecheck / test / format 绿；接口清单与本文 §2–§7 一致；默认设置下行为与 master 逐字节一致（A 组）。

**P0 冻结面完整性核对**：跨包共享的一切都在 P0——hub（P1 不再改）、safe-fs / lock（P2 / P4 共用）、runtime 只读工具域（P4 消费，P0-r）、contracts 模板与 schema（P1 / P3 / P4）、工具面文本（P2 不改）、settings（全部读）、装配骨架（P5 只翻默认值）。P1–P4 之间剩余的运行时依赖只有「P2 的块估算调用 P1 的 `renderTiered`」「P3 的 D09 调用 `renderTiered`」「P4 调用 P3 的 `runDoctor`」，全部经 P0 冻结的签名，开发期用桩/注入端口测试，真实串联在 P5。

**并行写包**（P0 合入后同一条消息派发，各挂 `experts: [本方案 Plan label]`，`isolation:"worktree"`）：

| 包        | 内容                                                                                                                                                                                              | 文件域（独占）                                                                                                                                                         | 验收口径                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P1 注入层 | `renderTiered`（`minimalFrame` + 分配 + 降级阶梯）、整节准入、MetaCache、TieredRenderCache、childProfile、access（`accessFromTools`）粘住、memory pointer 函数、inject tiered 分支、tiered golden | `src/memory/tiered.ts`、`src/memory/inject.ts`；`tests/memory/tiered.test.ts`、`tests/sysprompt/memory-tiered-section.test.ts`；`tests/fixtures/memory/tiered-golden/` | G 组、H1–H6；current-5 实测字节与级别写进包报告；verifier 逐行审 golden |
| P2 工具层 | v2 工具工厂、`normalizeMemoryCall` 别名/互斥、七个命令、手写文件规则、锁内原子写（含临时文件替换式 append）、T3 预算与精确重复行、硬上限                                                          | `src/memory/tool-v2.ts`、`edit.ts`、`search.ts`、`budget.ts`、`normalize.ts`；`tests/memory/{tool-v2,edit,search,budget,normalize}.test.ts`                            | I 组；块估算经注入的 `renderBlock` 端口测试                             |
| P3 体检   | D01–D09、D11、D13、D14（含 linked 目录），`/mem doctor`，`/mem` 摘要行，启动提醒（去重）                                                                                                          | `src/memory/doctor.ts`、`doctor-command.ts`；`tests/memory/doctor.test.ts`；`tests/fixtures/memory/doctor-golden/`                                                     | J 组；零 spawn、零 sendMessage                                          |
| P4 tidy   | prompt（含迁移模式）、cost（估价 + cap watcher + N1 无价路径）、validate、diff、apply（锁/备份/manifest/sha/单次失效）、frontmatter 模式、restore、UI 编排、只读域请求                            | `src/memory/tidy/*.ts`；`tests/memory/{tidy,tidy-cost,restore}.test.ts`；`tests/fixtures/memory/tidy-payloads/`、`tests/fixtures/memory/current-5-migrated/`           | K1–K9、K11–K15                                                          |

**P5 集成 + 文档**（主会话，或 1 个 dev 包 + 主会话真机）：跨包测试（H 组依赖真实 tiered 的用例、I9 真实块估算、K10 一次 update、M 组 `tests/memory/discoverability.test.ts`）；**翻转默认值** `layout:"tiered"`、`toolSurface:"v2"`（`settings.ts` 两个默认值 + spec 描述 + `tests/config/memory-settings.test.ts` / `tests/memory/wire.test.ts` 的默认值断言）；`AGENTS.md` 中 `src/memory/` 一段（含 §3.1 目录信任语义、§3.3 接受的并发语义）与 `src/service/` 一段（`toolDomain:"readonly"`）、`docs/dev/memory/memory-plan.md` 顶部指向本文、本文状态改为「已实施」；真机 R1、R3–R7（发布门禁）。§11.2 评测**不在 P5**，归后续包 E1。

**E1 命中率评测**（后续、非发布阻塞；P5 发布后，1 个 dev 包写运行器 + 主会话执行）：文件域见 §11.2「E1 文件域」；验收 = E1 单测绿 + 一次完整或 aborted 的报告落盘。

**L1 legacy 淘汰**（后续、非发布阻塞）：P5 之后至少 2 个发布版本再另立方案，本期不排期（§13）。

### 14.2 文件域冲突表

所有权按**精确路径 / 精确子目录**登记（复审 新-4）；任何包都不得按 `tests/fixtures/memory/**` 泛匹配写入，也不得新建未登记的子目录——需要时先上报主会话登记。

| 文件 / 目录                                                                                                                                                                                                                                                                                              | P0                       | P1         | P2         | P3         | P4            | P5                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------- | ---------- | ---------- | ------------- | ----------------------------------------- |
| `src/core/types.ts`、`src/service/{runtime-adapter,spawn-service,request-threading}.ts`、`src/runtime/{tool-scope,session-driver,runner}.ts`                                                                                                                                                             | 写（P0-r）               | —          | —          | —          | 读（经 port） | —                                         |
| `src/config/settings.ts`、`setting-specs.ts`                                                                                                                                                                                                                                                             | 写（P0-b）               | 读         | 读         | 读         | 读            | 只改 2 个默认值 + 描述                    |
| `src/sysprompt/hub.ts`                                                                                                                                                                                                                                                                                   | 写（P0-b）               | 读         | —          | —          | —             | —                                         |
| `src/memory/{contracts,meta,safe-fs,lock,tool-surface}.ts`                                                                                                                                                                                                                                               | 写（P0-b）               | 读         | 读         | 读         | 读            | —                                         |
| `src/memory/store.ts`、`render.ts`                                                                                                                                                                                                                                                                       | 写（P0-b）               | 读         | 读         | 读         | 读            | —                                         |
| `src/memory/tool.ts`（legacy）                                                                                                                                                                                                                                                                           | **全程零改动**           | —          | —          | —          | —             | —                                         |
| `src/memory/{index,command}.ts`、`src/index.ts`                                                                                                                                                                                                                                                          | 写（P0-b）               | —          | —          | —          | —             | 小修（仅集成缺陷，需上报）                |
| `src/memory/{tiered,inject}.ts`                                                                                                                                                                                                                                                                          | 桩 / 路由（P0-b）        | 写         | 读（端口） | 读（端口） | —             | —                                         |
| `src/memory/{tool-v2,edit,search,budget,normalize}.ts`                                                                                                                                                                                                                                                   | 桩（P0-b）               | —          | 写         | —          | —             | —                                         |
| `src/memory/{doctor,doctor-command}.ts`                                                                                                                                                                                                                                                                  | 桩（P0-b）               | —          | —          | 写         | 读（端口）    | —                                         |
| `src/memory/tidy/*`                                                                                                                                                                                                                                                                                      | 桩（P0-b）               | —          | —          | —          | 写            | —                                         |
| `tests/fixtures/memory/current-5/`、`synthetic/`、`cc-source/`；`tests/fixtures/memory-legacy-golden.json`；`tests/memory/helpers/`                                                                                                                                                                      | 写（P0-a）               | 读         | 读         | 读         | 读            | 读                                        |
| `tests/fixtures/memory-tool-surface.json`                                                                                                                                                                                                                                                                | 写（P0-b）               | —          | 读         | —          | —             | 读                                        |
| `tests/fixtures/memory/tiered-golden/`                                                                                                                                                                                                                                                                   | —                        | 写         | —          | —          | —             | 读                                        |
| `tests/fixtures/memory/doctor-golden/`                                                                                                                                                                                                                                                                   | —                        | —          | —          | 写         | —             | 读                                        |
| `tests/fixtures/memory/tidy-payloads/`、`current-5-migrated/`                                                                                                                                                                                                                                            | —                        | —          | —          | —          | 写            | 读（M 组）                                |
| `tests/service/{runtime-adapter,spawn}-readonly-domain.test.ts`、`tests/runtime/{tool-scope-provenance,runner-readonly-turn-start}.test.ts`、`tests/integration/readonly-domain-shadow-real-session.test.ts`；追加 `tests/service/request-threading.test.ts`；必要时仅补 fake handle 的 `getToolSources` | 写（P0-r）               | —          | —          | —          | —             | —                                         |
| `tests/memory/{legacy-golden,safe-fs,lock,fs-guard,tool-surface,meta}.test.ts`、`tests/sysprompt/hub.test.ts`                                                                                                                                                                                            | 写（P0-a / P0-b）        | —          | —          | —          | —             | —                                         |
| `tests/memory/{inject,store,command}.test.ts`、`tests/sysprompt/memory-section.test.ts`                                                                                                                                                                                                                  | 写（P0-b）               | —          | —          | —          | —             | —                                         |
| `tests/memory/wire.test.ts`、`tests/config/memory-settings.test.ts`                                                                                                                                                                                                                                      | 写（P0-b）               | —          | —          | —          | —             | 只改默认值断言                            |
| `tests/memory/tool.test.ts`                                                                                                                                                                                                                                                                              | **全程零改动**           | —          | —          | —          | —             | —                                         |
| 各包新测试文件（见上表「文件域」列）                                                                                                                                                                                                                                                                     | —                        | 写（本包） | 写（本包） | 写（本包） | 写（本包）    | 写 `tests/memory/discoverability.test.ts` |
| `docs/dev/memory/eval/questions.json`                                                                                                                                                                                                                                                                    | 写（P0-a）               | —          | —          | —          | —             | 读（M 组；E1 读）                         |
| `scripts/dev/memory-eval.mjs`、`tests/scripts/memory-eval.test.ts`、`docs/dev/memory/eval/results-*.md`                                                                                                                                                                                                  | —                        | —          | —          | —          | —             | —（**E1 写**，后续、非发布阻塞）          |
| `docs/dev/memory/memory-plan.md`                                                                                                                                                                                                                                                                         | 写 §8.3 L568–569（P0-b） | —          | —          | —          | —             | 写顶部指针                                |
| `AGENTS.md`、`docs/dev/memory/optimize-plan.md`                                                                                                                                                                                                                                                          | —                        | —          | —          | —          | —             | 写                                        |

冻结面纪律：任何包需要改 P0 标「写」的文件 ⇒ 停下上报主会话，由主会话统一改完再推送（dev-flow 规则 9）。P1–P4 文件域互不相交；四个写包按 pitfalls「>2 写包同树用 worktree」用 `isolation:"worktree"`（P0 合入 master 之后从 HEAD 建）。

### 14.3 风险

| 风险                                          | 缓解                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认块在真实目录上超过 2.4KB                  | 降级阶梯保证 ≤ B（L0–L4）；P1 报告实测级别；不动预算                                                                                                                                                                                                                                                      |
| 迁移前 pitfalls 的 4 节退出常驻，模型少了规则 | 省略行给节名与打开方式；启动提醒引导 tidy；§11.2 Q4/Q9 专门测被省略节的命中；可临时 `layout=legacy`                                                                                                                                                                                                       |
| 子会话 core 档让某些子任务缺主题信息          | compact 名单 + 按 access 的真实路径兜底；`childProfile=full` 可切回；T4 为长期方案                                                                                                                                                                                                                        |
| 升级后首次 resume 出现一次较大 update         | 有界（≤ B），H4 钉住                                                                                                                                                                                                                                                                                      |
| tidy 丢内容 / 误改用户文件                    | 内容守恒 + 手写只建议 + 逐文件确认 + 备份/manifest + hash 冲突 restore                                                                                                                                                                                                                                    |
| tidy 用主会话贵模型                           | 估价闸 + 回合边界 cost 闸 + 输出字节上限 + 确认框显示估价；`tidy.model` 可改便宜档                                                                                                                                                                                                                        |
| 锁残留阻塞写入                                | 30s 陈旧判定 + 死 pid 判定；超时是可见错误；`/mem doctor` 可显示锁持有者（D14 附带）                                                                                                                                                                                                                      |
| 硬链接不可用的文件系统                        | `createExclusive`/`renameNoClobber` 退化为持锁检查 + rename，并在结果中注明                                                                                                                                                                                                                               |
| 新工具面 + 别名让模型困惑                     | 官方字段名为主、旧字段只在 description 末尾一句；§11.2 评测观察工具调用错误率                                                                                                                                                                                                                             |
| `tool.ts`（legacy）与 `tool-v2.ts` 双份维护   | legacy 冻结只修 bug；golden 保护；移除为后续 L1（≥ 2 个发布版本后另立方案，非发布阻塞）                                                                                                                                                                                                                   |
| runtime 只读工具域改动波及 consult            | 强制点与 consult 同位、同常量；consult 回归测试（N7）原样绿；P0-r 独立提交便于回滚                                                                                                                                                                                                                        |
| 误配置 / 其它扩展注册同名工具遮蔽 builtin     | 6a 按对象同一性收窄 customTools；6b 在 bind / turn_start / turn_end 按 `sourceInfo.source` 核验、fail-closed 剥离；N9 单测 + N10 真实会话端到端（含对照组）+ N11                                                                                                                                          |
| 同进程恶意扩展绕过只读域                      | **非目标**（§7.0.0）：同进程同权限、进程内不可防；readonly 是 defense-in-depth。同 uid 外部写入由 tidy 应用前 sha256 复查发现                                                                                                                                                                             |
| consult 获得来源核验后行为变化                | 只在存在同名冲突时可观察（遮蔽 builtin 的同名工具被剥离）；fake handle 只允许补 `getToolSources`，不放宽规则                                                                                                                                                                                              |
| 命中率评测噪声大 / 成本失控                   | 探索性指标（N4 = A）、后续非发布阻塞（E1）；硬门禁由 M / G1 与真机 R 步骤承担；归类剔除传输层失败；调用数 180 / 尽力预算 $15（v6：每次预留 `R=(K+1)×W_req`，`W_req` 覆盖 `calculateCost` 全部计费项；子进程强制短缓存；usage 缺失即中止；有界超支估计 ≤ 2 × `W_req`，不作硬上限）/ 240min，超限中止并落盘 |
| legacy append 短写残留                        | legacy 冻结语义与 #22 前相同；`appendLegacy` 无插写时回滚；v2 append 改为临时文件替换，全写或不写                                                                                                                                                                                                         |

## 15. 本文与相关文档的关系

- 设计依据：设计评审 §2、§4、§6、§6A；sysprompt 不变量：ss-plan §4.1。
- 评审输入：`optimize-plan-review-v1.md`（v1 评审 + 用户决策）；`optimize-plan-review-v2.md`（v2 复审 + 用户决策 N1–N3 + 主会话裁定，v3 修订输入）；v3 复审（主会话转述）+ 用户决策 N4/N5 = A（v4 修订输入，处置见 §18）；v4 复审（主会话转述）+ 主会话威胁模型裁定（v5 修订输入，处置见 §19）；v5 复审（zhipu gpt-sol，主会话转述）+ 主会话「评测不做硬成本闸门」裁定（v6 修订输入，处置见 §20）。
- 实施完成后：memory-plan 顶部加指针；AGENTS.md `src/memory/` 段更新。

## 16. v1→v2 处置

| 评审 #                | 严重度  | 问题                                                     | v2 处置                                                                                                                                                                                                         | 位置               |
| --------------------- | ------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1                     | Blocker | 工具面 ≤1,700B 不可验证（实测约 2,002B）                 | 口径定为 UTF-8 字节并给出公式；参数去掉逐项描述、guidelines 5→1 行、snippet 缩短；实测 v2 **1,443B**（legacy 1,333B），上限 1,500B；legacy 与 v2 序列化文本入 golden                                            | §4.5、§10 D        |
| 2                     | 严重    | `pointerHint` 函数不会被 hub 求值                        | hub 在 pointer 条目上按同一 input 求值、异常/非字符串/thenable 降级为无 hint、独立 try 不影响 section 状态；实现与 P-1–P-5 测试归 P0，P1 只提供函数                                                             | §2.6、§10 C、§14.1 |
| 3                     | 严重    | 超长 slug/多索引/长 omission 可超 2.4KB，D10 只是事后    | 固定分配顺序 + L0–L5 降级阶梯；L0–L4 保证 ≤ B，L5 仅框架超预算；I-M1–I-M4 property test；current-5 与 9 个合成 fixture 逐字节 golden                                                                            | §2.3、§10.1、§10 G |
| 4                     | 严重    | 零工具命中率无分母/基线；索引有 `<dir>` 占位             | 10 题固定问题集（3 core + 7 topic）、baseline/tiered-pre/tiered-post 三组各 2 次、`T_all`/`T_mem`/`zero`/`hit1`/`correct` 口径与达标线；guide 与省略行输出真实绝对目录；另有确定性可发现性代理测试 M 组         | §2.2、§11.2、§10 M |
| 5                     | 严重    | 自称对齐官方却改了字段名                                 | 明确「兼容命令名/字段名/返回约定，不兼容路径模型」；官方字段为主，`name/content/action` 为旧别名；同槽位多字段同值接受、异值报错、`command`+`action` 报错；无关字段忽略并提示                                   | §4.1、§4.2、§10 I7 |
| 6                     | 严重    | size+mtime 非 CAS；append 可越上限；create/rename TOCTOU | 目录锁串行化所有 v2 变更；读-改-写锁内 + bigint lstat 复查；append 锁内 fstat 检查、超限整次拒绝；create/rename 用 `link()` 原子 no-clobber；明确写出对不合作写者的残余风险                                     | §3.2、§3.3、§10 B  |
| 7                     | 严重    | 读取/注入/体检/tidy 仍跟随 symlink                       | `safe-fs.ts` 统一 `O_NOFOLLOW` + fstat 普通文件；legacy 渲染/存储同样改用；`.trash`/`.backup` 必须真实目录；dangling/交换/目录外 symlink 测试；grep 守卫禁止旁路                                                | §3.1、§10 B、N2    |
| 8                     | 严重    | tidy 无输出/成本上限；dry-run 无语义；restore 无确认     | `maxOutputBytes` 硬上限 + schema 长度约束；估价闸 + 回合边界 cost/turn 闸（超限 abort，零写入）；`--dry-run` = 零 spawn 零写入预览；restore 显式确认 + 逐文件 hash 冲突 + pre-restore 备份失败即中止 + 失败报告 | §7.1–§7.5、§10 K   |
| 9                     | 一般    | legacy golden 生成未固定 fixture/mtime/时间              | 生成协议：复制 fixture 到临时根、固定 mtime/系统时间/cwd、stub HOME 与 ARMORY_MEMORY_ROOT、路径占位、仅在 src 零改动的 P0-a 提交生成、永不覆盖                                                                  | §10.1              |
| 10                    | 一般    | similar/D12、D16、D15 冗余；D09/D10 重复                 | `similar.ts`、D12、D15、D16 延后；T3 只做精确重复行；D10 并入 D09                                                                                                                                               | §4.4、§6.1、§13    |
| 决策 5                | 用户    | 手写文件                                                 | 小改（str_replace/insert/append）允许 + 警告且不碰 frontmatter；覆盖/删除/改名拒绝；tidy 只建议                                                                                                                 | §4.3、§7.3、N3     |
| 决策 11               | 用户    | tidy 模型                                                | 默认当前主会话模型，`tidy.model` 可覆盖；仍有输出字节与单次成本上限，超限中止                                                                                                                                   | §7.1、§9、N1       |
| 精简                  | 用户    | 按评审精简                                               | 同 #10                                                                                                                                                                                                          | §13                |
| 决策 1–4、6–10、12–14 | 按推荐  | 评审附加条件                                             | 逐条写入 §12 表「附加条件与落地位置」列                                                                                                                                                                         | §12                |
| —                     | 新增    | master 中间态可发布性                                    | P0 默认 `layout`/`toolSurface` 保持 legacy、桩在默认配置下不可达；P5 集成后翻转默认值                                                                                                                           | §9、§14.1          |

## 17. v2→v3 处置

| 复审 # | 严重度           | 问题                                                                  | v3 处置                                                                                                                                                                                                                                                                                                        | 位置                      |
| ------ | ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| v1-1   | 严重             | 0.34.52 与 runtime 1.3.27 键序不同，不能「逐字节相同」                | 自行用两版实测：v2 parameters 均 861B、合计均 1,443B，legacy parameters 均 417B；canonical 文本相等、原始文本不等。golden 改存 canonical JSON（键递归排序），字节预算按原始 `JSON.stringify` 在两版下分别计算并断言相等 ≤ 1,500；运行时 typebox 从 pi 包自身解析，解析失败即测试失败；不再声称跨版本文本相同   | §1、§4.5、§10 D           |
| v1-2   | 已闭合           | P0 hub 求值                                                           | 保持 P0 冻结，P1 不改 hub                                                                                                                                                                                                                                                                                      | §2.6                      |
| v1-3   | 严重             | L5 判据含 guide、`Ov` 未覆盖实际文案，`level=5 ⇔ F+Ov>B` 与输出不等价 | 判据改为真实文本 `M = minimalFrame(input)`（含 access 对应 guide 与最坏尾行 `Tmax`）；L5 文本按候选 `line5` 逐级退到不可约形式 `I`；只允许 `I` 超限（slug 极长）；I-M1a–d 全部对 `Buffer.byteLength(result.text)` 断言，I-M1c 由测试独立调用 `minimalFrame` 复算                                               | §2.3、§10 G2/G3           |
| v1-4   | 严重             | 运行器未固定、重复次数少、判定宽松                                    | 定位为探索性指标（N4）；运行器固定 HOME 重定向注入设置、`--no-extensions -e`、禁用 skills/templates/context files、工具表、模型、180s 超时、传输层重试规则、七类互斥归类、版本与配置记录；每题每组 5 次、交错执行、Wilson 区间；判定改为 `must` 全中且 `mustNot` 全不中，答案限两句                            | §11.2、§12 N4             |
| v1-5   | 已闭合           | 官方字段                                                              | 验收补官方文档示例 payload 原样（记录来源 URL）                                                                                                                                                                                                                                                                | §10 I7                    |
| v1-6   | 严重             | import 未入锁；append 短写；守卫与 lock.ts 冲突                       | `importProject`/`importAll` 改 async 并入锁、no-clobber 用 `createExclusive`；v2 append 改临时文件替换（全写或不写），所有写经 `writeAll`，临时文件失败即清理；legacy append 短写尽力回滚；锁原语下沉 safe-fs，`lock.ts` 零 fs import；守卫改 import 级，只放行 `safe-fs.ts`                                   | §3.1–§3.3、§10 B10–B13    |
| v1-7   | 严重             | slug 目录 symlink 被跟随；`NAME_RE` 改变 legacy                       | 按主会话裁定：slug 目录 symlink 允许，每次操作 `canonicalMemoryDir` 一次、fs 用 `real`、文本用 `display`，写明用户显式信任语义并在 `/mem path`、D14 显示；目录内文件级 symlink 一律拒绝（含 legacy）；`listRegular({names})` 区分 v2 / legacy，legacy 接受任意 `*.md`，`legacy-names` fixture 进 legacy golden | §2.1、§2.7、§3.1、§6.1    |
| v1-8   | 已闭合（有条件） | `allowUnpriced` 放弃美元上限                                          | 按 N1：无价模型允许 + 警告，删除 `allowUnpriced`；确认框、dry-run、报告明示 no cost guarantee；只保留回合 / 输出字节 / 超时硬上限并各有测试                                                                                                                                                                    | §7.1、§9、§10 K3          |
| v1-9   | 已闭合           | golden 生成                                                           | `sourceCommit` / `generatedAt` 只作记录，比较时剔除                                                                                                                                                                                                                                                            | §10.1                     |
| v1-10  | 已闭合           | 精简                                                                  | 不变                                                                                                                                                                                                                                                                                                           | §13                       |
| 新-1   | 阻塞             | tidy 用 Plan（含 bash），提案阶段可写文件                             | 新增 runtime 只读工具域 `SpawnRequest.toolDomain:"readonly"`：注入分支跳过、H2 后强制 `CONSULT_READONLY_TOOLS` + `StructuredOutput`、enforcer 同源 policy、准入组合校验；tidy spawn 恒带该字段（类型必填）；N 组含越权写入端到端测试；实现位置作为 N5 请用户确认                                               | §7.0、§7.3、§10 N、§12 N5 |
| 新-2   | 严重             | 「无 read 降 none」与「查不到按 read」冲突                            | `accessFromTools`：查不到 / 抛错 / 非数组 ⇒ `none`；与 `CONSULT_READONLY_TOOLS` 集合相等 ⇒ `read`（consult 明示例外）；其余按工具组合                                                                                                                                                                          | §2.4、§10 G8              |
| 新-3   | 严重             | P0-b 换掉 `tool.ts` 导致 `tool.test.ts` 断                            | `tool.ts` 原位保留为 legacy、全程零改动，v2 工厂放 `tool-v2.ts`；`tool.test.ts` 零迁移；受 P0-b 影响的既有测试逐个列入 P0-b 文件域                                                                                                                                                                             | §2.7、§14.1、§14.2        |
| 新-4   | 一般             | `tests/fixtures/memory/**` 多包写入重叠                               | 按精确子目录登记所有权（P0-a：current-5 / synthetic / cc-source；P1：tiered-golden；P3：doctor-golden；P4：tidy-payloads / current-5-migrated），禁止泛匹配和未登记子目录                                                                                                                                      | §10.1 第 8 条、§14.2      |
| N1–N3  | 用户决策         | 无价模型 / symlink 范围 / provenance                                  | 全部落地                                                                                                                                                                                                                                                                                                       | §12                       |
| 包拆分 | —                | —                                                                     | P0 变为 P0-a → P0-r → P0-b 三个可独立发布的提交；P2 文件域 `tool.ts` → `tool-v2.ts`；P3/P4 增加 fixture 子目录；K15、N 组新增                                                                                                                                                                                  | §14                       |

## 18. v3→v4 处置

| 复审 v3 # | 严重度   | 位置（v3）             | 问题                                                                                                             | v4 处置                                                                                                                                                                                                                                                                                                                                                                                              | 位置                                   |
| --------- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1         | 阻塞     | §14.1 L922、§14.2 L957 | `SpawnRequest.toolDomain` 触发 `request-threading.ts:65` `AssertAllClassified`，P0-r 未列该文件 ⇒ 不能 typecheck | `request-threading.ts` 纳入 P0-r，`toolDomain` 登记 `NOT_THREADED`（adapter 消费、不进 runner），与 `types.ts` 同一提交；N8：`threadThroughRequestFields` 不输出 `toolDomain`，WC13 ① 保持绿、ff4 负例不动                                                                                                                                                                                           | §1、§7.0 第 5 条、§10 N8、§14.1、§14.2 |
| 2         | 严重     | §7.0 L559–582          | pi 同名 custom tool 覆盖 builtin，名称 allowlist 放行可写的「假 read」                                           | 6a 创建前把 `customTools` 按对象同一性收窄为 runtime 自有 `StructuredOutput`，其余剔除 + WARN；6b `ToolScopePolicy.provenance` + `getToolSources`（`toolSourcesOf(session)` 读 `sourceInfo.source`），bind 与每个回合边界核验 `read/grep/find/ls = builtin`、`StructuredOutput = sdk`，不符 fail-closed 剥离；N9 单测、N10 真实 `AgentSession` 恶意 custom read 端到端（扩展 / SDK 两变体 + 对照组） | §1、§7.0 第 6 条、§10 N9/N10、§14      |
| 3         | 严重     | §7.0；adapter L706–710 | `bashJobGrant` 传 `consult: isConsultRun`，tidy 仍可能拿到 `bash_job`                                            | 改传 `consult: readonlyDomain`；switch_context 守卫改 `!readonlyDomain`；readonly 域 grantedReserved 恰为 `[]` / `["StructuredOutput"]`；N3/N4 在最宽前提下断言 H2 输入 tools（grantedReserved 可观测面）、customTools、最终 tools、policy 均不含 `bash_job` / `switch_context` / 写工具，并设普通 run 对照组                                                                                        | §7.0 第 1 条、§10 N3/N4                |
| 4         | 一般     | §11.2 L836–859         | 三组 fixture 未定义；`spawn("pi")` 依赖 PATH；重试可达三倍却无总调用 / 成本上限                                  | 三组固定映射表（baseline = P0-a 检出 + current-5；tiered-pre = 发布检出 + current-5；tiered-post = 发布检出 + current-5-migrated），启动校验 fixture sha；pi 从仓库 `node_modules` 解析 cli 绝对路径、`process.execPath` 启动；重试总数 ≤ 30、`--max-calls 180` / `--max-usd 15` / `--max-wall-min 240`，无价路由默认中止，超限落盘 aborted 报告、退出码 3                                           | §11.2                                  |
| 5         | 一般     | §3.3/§14.1 L326、L925  | import 改 async 后 `command.ts`、`store.test.ts` 仍同步；`memory-plan.md:568–569` 旧签名                         | 声明 `async function`（错误一律 rejection）；`command.ts` 改 `await importAll` + `for…of` 串行 `await importProject`（保首错即停）；`store.test.ts` 9 处 await + L237 改 `rejects`、加「不同步抛」一例；`command.test.ts` 加串行首错即停一例；`memory-plan.md` §8.3 签名同步列入 P0-b 文件域                                                                                                         | §1、§3.3、§10 A5、§14.1、§14.2         |
| 6         | 建议     | §11、§13、§14          | 命中率评测与 legacy 淘汰应标为后续、非发布阻塞                                                                   | 评测整体移入后续包 E1（运行器从 P0-a 移出，`questions.json` 留 P0-a 供 M 组），R2 移出发布门禁；legacy 淘汰为 L1（≥ 2 个发布版本后另立方案）；tidy / restore 仍在本期                                                                                                                                                                                                                                | §11、§13、§14.1、§14.3                 |
| N4        | 用户决策 | §12                    | 命中率评测定位                                                                                                   | **A**：探索性指标、每题每组 5 次、不作硬门禁（决策表 N4 行）                                                                                                                                                                                                                                                                                                                                         | §11.2、§12                             |
| N5        | 用户决策 | §12                    | tidy 零写入实现位置                                                                                              | **A**：runtime `SpawnRequest.toolDomain:"readonly"`（决策表 N5 行）                                                                                                                                                                                                                                                                                                                                  | §7.0、§12                              |
| 包拆分    | —        | §14                    | —                                                                                                                | P0-r 文件域 +`request-threading.ts`、`runtime/tool-scope.ts`、`runtime/session-driver.ts` 与 3 个新测试文件 + 追加 request-threading 测试；P0-a 去掉 `memory-eval.mjs`；P0-b 加 `memory-plan.md` §8.3；新增后续包 E1、L1（非发布阻塞）                                                                                                                                                               | §14                                    |

## 19. v4→v5 处置

**主会话裁定（威胁模型，权威）**：readonly toolDomain 的目标是防止 tidy 子会话里的**模型**通过工具写文件，不是防御同进程恶意扩展。H2 与任何 pi 扩展同进程同权限，可以直接 monkeypatch `fs` 或改任意对象，进程内防不住，也不在本方案范围——这与 pi 自身的扩展信任模型一致。因此复审 v4-1/2 不做对抗式加固，改为写明信任边界（§7.0.0），并把核验点放到最早的同步点。

| 复审 v4 # | 严重度 | 位置（v4）         | 问题                                                                       | v5 处置                                                                                                                                                                                                                                                                                                                                                                                                                            | 位置                                              |
| --------- | ------ | ------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1         | 严重   | §7.0 第 6 条       | H2 可原地改 runtime 自有 `StructuredOutput.execute`，6a 的对象同一性挡不住 | **按裁定不做对抗式加固**：新增 §7.0.0，写明信任同进程扩展、恶意扩展为明确非目标、6a/6b 是 defense-in-depth。删去暗示能防恶意扩展的措辞（「恶意 custom read」→「误配置同名 custom read」，残余面②改指 §7.0.0），不加「改 execute」类测试。卫生项：readonly 域 `StructuredOutput` definition `Object.freeze`（pi 不改写 definition，N9⑦ / N10 验证）                                                                                 | §0.4、§1、§7.0.0、§7.0 第 6 条、§10 N9/N10、§14.3 |
| 2         | 严重   | §7.0 第 6b 条      | bind 之后、turn_end 之前注册同名 `read` 的时间窗                           | **按裁定不做对抗式加固**，但把核验前移到最早的同步点：核对 pi 事件顺序（扩展的 `before_agent_start` / `agent_start` / `turn_start` 处理器先于 `session.subscribe` 监听者；`prepareRequest` 在 turn_start 之后才快照可执行集合），新增 **turn_start** 核验点（仅带 `provenance` 的 policy，其它 run 逐字节不变），与 bind、turn_end 共三处；`before_agent_start` 不可用（扩展事件，runtime 不在其中、无序保证）。剩余窗口写入非目标 | §0.4、§1、§7.0 第 3/6b 条、§10 N10(c)/N11、§14    |
| 3         | 一般   | §11.2「pi 可执行」 | `require.resolve("…/package.json")` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`     | 实测确认（主入口的 `require.resolve` 也抛——`exports` 只有 `import` 条件）。改为脚本内 `import.meta.resolve(包名)` → 向上找 `name` 匹配的包根 → `bin.pi`（`dist/bundle/cli.js`）；`--pi <绝对路径>` 覆盖；子进程里真实 Node 解析单测 + `require.resolve` 抛错断言 + 包根查找边界用例                                                                                                                                                | §11.2                                             |
| 4         | 一般   | §11.2「总预算」    | `spent + projected` 不是硬上限                                             | 价格取 models.json、无价拒跑（删 `--allow-unpriced`）；私有 agent 目录把 `maxTokens` 改写为 `outTokMax`，provider 侧封顶输出；`W_req` 按 `inTokMax` / `outTokMax` 计，每次调用最多 K+1 条请求，调用前预留 `R=(K+1)×W_req`，`spent + R ≤ maxUsd` 才派发；在途请求按 `W_req` 记账；前提逐请求核验，违例即中止并记录唯一可能的 overshoot。仍是探索性、非发布阻塞（N4 = A）                                                            | §11.2、§12 N4、§14.3                              |
| 包拆分    | —      | §14                | —                                                                          | P0-r 文件域 + `src/runtime/runner.ts`、`tests/runtime/runner-readonly-turn-start.test.ts`（N11）；E1 单测范围扩充（解析、预算）；其余包不变                                                                                                                                                                                                                                                                                        | §14.1、§14.2                                      |

## 20. v5→v6 处置

**主会话裁定（权威）**：命中率评测是探索性、非发布阻塞工具（N4 = A），不值得为它做硬成本闸门。复审 v5-1/2 因此不走「补齐硬上限」的路，改为放弃「硬上限」措辞，写成「尽力预算 + 有界超支」；不加子进程请求闸或握手。复审 v5-3 按源码改正。

| 复审 v5 # | 严重度 | 位置（v5）                                 | 问题                                                                                                                                                                                                                                              | v6 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 位置                                                                                          |
| --------- | ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1         | 严重   | §11.2「总预算」`W_req` / `R`               | `W_req` 没计 `cacheRead`、`cost.tiers`、Anthropic `cacheWrite1h`（2× input）；pi-ai `calculateCost` 会计入这些项；子进程还会继承 `PI_CACHE_RETENTION=long`                                                                                        | **短缓存强制**：`buildChildEnv` 删除 `PI_CACHE_RETENTION`（核对过，这是 pi 0.87.1 读取的唯一缓存保留期变量，只认 `"long"`）；私有 agent 目录 `settings.json` 写 `cacheWarming:"off"`（pi 自发的刷新请求看不到）；三组 toolkit 设置加 `cacheTtl:{mode:"off",keepalive:false}`（剥掉 ttl、关保活）。**`W_req` 取最坏值**：遍历 `[cost, ...tiers]`，输入按 `inTokMax × max(2×input, cacheWrite, cacheRead)` 取所有档最大值，输出按 `outTokMax ×` 最高档 output（sonnet ≈ $0.253）。记账用 `calculateCost` 镜像（单测对照 pi-ai），`error` / `aborted` 请求按 ≥ `W_req` 记。**usage 缺失 / 不完整 ⇒ 立即中止**（`usage_invalid`、`aborted (usage)`）；`cacheWrite1h > 0` ⇒ `aborted (cache)`；单测扫描 pi 包缓存变量名，升级时提示复查                                                                         | §0.5、§11.2（三组映射、pi 配置、设置、调用、预算、记录、归类、总预算、成本估算、E1 单测 ③–⑤） |
| 2         | 严重   | §11.2「单次调用请求数封顶 / 预留式硬上限」 | 「最多多一条在途请求」没有代码契约保证，`R = (K+1) × W_req` 不是硬上界                                                                                                                                                                            | 删去「累计实际成本 ≤ `maxUsd`」的保证和「预留式硬上限」措辞，K+1 降为记账假设。`R = (K+1) × W_req` 保留为派发时的尽力预留。写明**最大超支 = 未记账的已计费请求数 `N_unacc` × `W_req`**，保守按整次评测 2 条估计（≤ 2 × `W_req` ≈ $0.51）。理由：进程内串行、两个后台请求源已关闭、kill / timeout / 失败请求已按 `W_req` 记账，只剩「kill 前连发两条」和「SDK 重试被计费」两类罕见事件，各按 1 条算。报告头照录该估计。§12 N4、§14.3 两处同步措辞                                                                                                                                                                                                                                                                                                                                                           | §0.5、§11.2「总预算」、§12 N4、§14.3                                                          |
| 3         | 一般   | §1「pi 事件顺序」、§7.0 第 6b 条           | 实际顺序是 `prepareNextTurn → turn_start → declareToolChanges → prepareRequest`，首回合的 `declareToolChanges` 在 `turn_start` 之前；「本回合仍显示工具、调用报 Tool not found」的解释需要修正；测试要分首回合 / turn_start 迟注册 / 下一回合追平 | 对照 `pi-agent-core/dist/agent-loop.js`（L44、L113–116、L219、L479–484）与 `agent-session.js`（`prompt()` loadout、`_installAgentNextTurnRefresh`、`_installAgentRequestProjection`）重写 §1 条目：区分**声明集**（transcript `toolsAdded/Removed`，pi-ai `getCurrentTools`）与**可执行集**（`prepareRequest` 快照）。每回合 `turn_start` 之后的 `declareToolChanges` 比较的是 `turn_start` 之前的 `context.tools` ⇒ turn_start 剥离只让工具**本回合不可执行**，声明下一回合追平；首回合声明在 `prompt()` 里定下 ⇒ **首回合声明只取决于 bind 核验**，bind 之后注册的工具首回合会被声明、但不可执行（接受的 fail-closed 过渡）。§7.0 6b 核验点语义同步改写。N10 拆为 (a)/(b) bind、(c1)/(c2) 首回合、(d) turn_start 迟注册、(e) 下一回合追平（含 turn_end 变体），用 `getCurrentTools` 断言每次请求的声明集 | §0.5、§1、§7.0 intro / 第 6b 条 / 测试行、§10 N10                                             |
| 包拆分    | —      | §14                                        | —                                                                                                                                                                                                                                                 | 文件域不变（N10 仍在 `tests/integration/readonly-domain-shadow-real-session.test.ts`；E1 仍是 `scripts/dev/memory-eval.mjs` + `tests/scripts/memory-eval.test.ts`，只扩充单测范围）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                             |
