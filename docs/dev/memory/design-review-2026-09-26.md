# pi-toolkit 项目 Memory 设计评审（2026-09-26）

## 0. 结论摘要

用户目标是“让 memory 能够以最快的速度加载到上下文，同时节省 token”。当前设计在**缓存稳定性**上合理：`systemPrompt.mode=stable` 将 memory 固定为 system prompt 快照，变化通过尾部 custom message 告知，避免每次写入打断长前缀缓存；但在**信息选择**上不合理：默认 `inlineMax=3`、`byteCap=4000` 以 mtime/pin 选择文件，没有语义描述，也没有“整文件准入”阈值，导致当前真实目录产生两个几乎无用的半截文件片段。

当前真实目录有 5 个文件、12,706B、110 行。默认首轮 Memory 块为 3,851B、47 行，按约 3.5 UTF-8 字节/token 估算约 1,100 token；真正展示的正文只有约 3,186B，约 911 token。`pitfalls.md` 正文被截断（约展示 2,891B/5,047B），`quota.md` 只展示约 138B/1,600B，`multi-agent-experiments.md` 只展示约 157B/2,210B，`live-acceptance-tmux.md` 与 `cache-ttl.md` 完全未读入 system prompt。

建议 todo #22 的目标形态是“**小型常驻核心 + 带描述和 read_when 的索引 + 主题文件按需读取**”，而不是继续扩大当前 recent 内联区。第一阶段先把默认常驻预算降到约 1,600–2,400B（约 460–685 token），并让索引携带足以选择文件的语义；第二阶段再做写入体检与显式自动整理。

## 1. 背景与目标

### 1.1 目标

1. 首次请求尽可能在零次 `read` 工具调用下命中真正高频的项目事实。
2. 常规轮次不因为 memory 写入而重写 system prompt 前缀，保持 prompt-cache 命中。
3. 子 agent 获得必要的项目约束，但 memory token 不随子 agent 数量无界放大。
4. 当信息不在常驻核心时，模型能从索引判断“该读哪个文件、何时读”，避免盲目全文搜索。
5. 为后续 todo #22“memory 自动整理”提供可度量的写入边界、体检规则和整理入口。

### 1.2 约束

- 本评审只读分析，不修改实现。
- 现有文件路径和运行时兼容约定必须保留；不要求立刻迁移现有 memory。
- 不能把所有内容硬塞进 `AGENTS.md`：全局规则、技能策略和项目记忆的生命周期不同。
- “缓存命中”分为两层：本地渲染缓存（避免文件读）和 provider prompt cache（避免前缀重写），不能混为一谈。

## 2. 现状摘要

### 2.1 模块和依赖

```text
src/index.ts（pre-guard 创建 hub）
  └─ src/sysprompt/hub.ts
       ├─ src/memory/index.ts
       │    └─ src/memory/inject.ts::memorySection
       │         └─ src/memory/render.ts
       │              ├─ src/memory/store.ts（readdir/stat/read）
       │              └─ src/memory/frontmatter.ts（pin/source/fm）
       ├─ core-sections（主会话的 agent types/models）
       └─ src/prompt-sections/
            ├─ stable-section.ts（snapshot/announced/stale/POINTED）
            ├─ fold.ts（拼接到 system prompt）
            ├─ update-message.ts（尾部更新 custom message）
            └─ store.ts（subagent:prompt-sections 会话条目）
```

证据：`AGENTS.md:178-217`、`src/memory/index.ts:1-79`、`src/memory/inject.ts:1-137`、`src/sysprompt/hub.ts:77-346`。

`memorySection` 是同步 provider，不拥有自己的 `before_agent_start`；它注册到共享 hub。memory 注册在 pre-guard，因此默认子会话也注册 memory；主会话的 agent types/models 在 HOST_KEY guard 后注册，子会话通常只有 memory section。worktree cwd 通过 `resolveWorktreeOrigin` 回到主仓库 memory 目录。

### 2.2 每轮、每会话的加载机制

**首轮或没有快照的会话：**

1. `memorySection.provider` 解析 cwd：`systemPromptOptions.cwd` → `ctx.cwd` → `process.cwd()`，再解析 worktree origin。
2. 计算 `memoryFingerprint`：对目录 `readdirSync`，对每个 `*.md` 做 `statSync`，按文件名排序，拼接 `name:size:floor(mtimeMs)`。
3. `RenderCache` 命中时只做目录扫描和 stat，不读正文；指纹变化或首次访问才进入 `renderMemoryBlock`。
4. 渲染时先读所有候选文件头最多 512B 判断 `pin: true`，索引按 mtime 降序，内联候选按 `[pinned mtime desc] + [unpinned mtime desc]`。
5. 只剥离首部 frontmatter 和 `pi copy` drift header；`source: agent` 的内联文件增加 fence；块尾增加 `<!-- pi-toolkit:memory <slug> -->`。
6. 内联正文按 UTF-8 字节预算扣除 `### name` 和 fence 的实际字节，超预算在标题/段落/行边界截断并加 `…(truncated — use \`read\` for full file)`。
7. hub 按注册顺序将非空 section 以 `prompt + "\\n\\n" + text` 折叠到 system prompt。memory 位于 agent types/models 之前。

对应实现：`src/memory/render.ts:140-193`、`src/memory/inject.ts:79-136`、`src/prompt-sections/fold.ts:1-6`。

**稳定模式的后续用户轮：**

- provider 每轮仍同步计算 fingerprint；RenderCache 命中时不读正文。
- hub 使用已有 `snapshot`，不会把变化直接折叠进 system prompt。memory 文件变化成为一条 `subagent:prompt-section-update` custom message，位于用户消息之后；更新正文包在 `<pi_section_update>` 中。
- `snapshot/announced/stale/sentCount/sentBytes` 通过 `subagent:prompt-sections` 会话条目持久化；读取走 `getBranch()`，不是 `getEntries()`。
- `session_compact` 或 `model_select` 标记刷新机会；下一个合适的 `before_agent_start` 重新把 live memory 折叠进 system prompt，尾部计数随刷新归零。
- 每个 section 自上次刷新最多 3 条整块更新、累计正文最多 32KB，之后发 pointer；默认 memory `byteCap=4000`，所以 memory 自身最多约 3 × 4KB 的更新正文，另加协议文案。

对应实现：`src/sysprompt/hub.ts:236-277,310-346`、`src/prompt-sections/stable-section.ts:1-72`、`src/prompt-sections/update-message.ts:1-47`、`src/prompt-sections/store.ts:1-127`。不变量和上界见 `docs/dev/sysprompt-stable/plan.md:381-396,900-905`。

**写入后的缓存行为：**

- `freezeInjectionAfterWrite=false`（默认）：写入成功后 `cache.delete(cwd)`，下次 provider 会重新渲染 live block；在 `stable` 模式下，hub 仍保留旧 snapshot，通常只产生尾部更新，不直接改 system prompt 前缀。这个开关删除的是本地 RenderCache，不等于必然打断 provider prompt cache。
- `freezeInjectionAfterWrite=true`：写入后捕获此前 RenderCache 的 block，当前会话 provider 始终返回旧 block；写入内容下个会话才可见，换取更强的字节稳定性。
- `systemPrompt.mode=legacy` 才会把 live 内容直接折叠到 system prompt；memory 改动会造成前缀变化。`live` 模式每轮刷新 section 状态，适合实时性而不适合本目标。

对应实现：`src/memory/index.ts:35-66`、`docs/dev/memory/memory-plan.md:328-342`、`src/sysprompt/hub.ts:176-205`。

### 2.3 当前真实目录的量化结果

采样目录：`/home/bluecake/.pi/agent/memory/-home-bluecake-ai-pi-toolkit/`。统计时使用仓库当前 `dist/memory/render.js` 的真实渲染函数，默认预算 `inlineMax=3`、`byteCap=4000`、`indexMax=15`（默认值见 `src/config/settings.ts:712-724`）。估算 token = UTF-8 字节 / 3.5；这是混合中文、英文、代码标点的保守粗估，不等于具体模型 tokenizer。

| 文件                         |          磁盘字节/行 | frontmatter/pin | 默认处理              |     实际内联正文 | 主要缺口                       |
| ---------------------------- | -------------------: | --------------- | --------------------- | ---------------: | ------------------------------ |
| `pitfalls.md`                |       5,115B / 39 行 | `pin: true`     | 第 1 个候选；多行截断 | 2,891B，约 21 行 | 正文约 2,156B 未展示，约 42.7% |
| `quota.md`                   |       1,658B / 12 行 | 非 pin          | 第 2 个候选；极短截断 |    138B，约 2 行 | 正文约 1,462B 未展示，约 91.4% |
| `multi-agent-experiments.md` |       2,268B / 17 行 | 非 pin          | 第 3 个候选；极短截断 |    157B，约 2 行 | 正文约 2,053B 未展示，约 92.9% |
| `live-acceptance-tmux.md`    |       1,432B / 20 行 | 非 pin          | 只在 index            |               0B | 全文约 409 token 需 read       |
| `cache-ttl.md`               |       2,233B / 22 行 | 非 pin          | 只在 index            |               0B | 全文约 638 token 需 read       |
| **合计**                     | **12,706B / 110 行** | 1 个 pin        | 5 条 index            |    **约 3,186B** | **约 9,520B 正文未直接展示**   |

实际渲染块的组成：

- 总块：**3,851B / 47 行 / 约 1,100 token**。
- 索引和标题区约 203B；内联区约 3,450B；older pointer 约 140B；sentinel 约 58B。
- index 包含全部 5 个文件，未触发 `indexMax=15` 的条数截断。
- `inlineMax=3` 使剩余 571B 的潜在正文预算没有用来展示第 4 个文件；但第 2、3 个文件已经被截成只有标题和 truncation marker 的片段。
- `byteCap` 约束的是内联文件头、fence 和正文，不是整个 Memory 块；标题、索引、pointer、sentinel 会额外增加总块大小。
- 没有独立的行预算。文件写入上限为单次 65,536B、单文件 262,144B，但这两个上限不等于注入预算。

### 2.4 子会话放大

`memory.injectInChildSessions=true` 默认开启，且 hub 在 pre-guard 注册；因此每个子 agent 的独立 session 首轮都会加载同一 cwd 的 memory block（worktree 子 agent 还会回到主仓库 memory）。默认当前块约 1,100 token，N 个子 agent 首轮至少带来约 `N × 1,100` token 的上下文输入量；10 个子 agent 即约 11,000 token，尚未计 base system prompt 和工具定义。

stable 模式只避免“每个用户轮都重写前缀”，不消除每个子 session 的初始上下文体积；不同 session 的 provider cache 也不能假定共享同一热前缀。将 `injectInChildSessions=false` 可消除这部分放大，但会让子 agent 失去项目记忆；更合适的目标是 child 只注入精简 core，主题文件按需读。

### 2.5 内容审计

| 文件                         | 分类判断                                                                                    | 依据与处理建议                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pitfalls.md`                | **特定任务才需要**；约一半是流程/模型路由偏好，另一半是运行时排障。不是每轮都需要全文 pin。 | `/reload`、模块状态、子会话等与 `AGENTS.md:328-332`、`AGENTS.md:188-217` 有重复；开发流程应以 `skills/dev-flow/` 为源。拆为小型“当前项目硬约束” core + `workflow.md`/`runtime-pitfalls.md`。 |
| `cache-ttl.md`               | **特定任务才需要**；并含已完成结论和未查明待办。                                            | 主题和事实已在 `AGENTS.md:120-146`、`docs/dev/cache-ttl-adaptive/plan.md` 及 verification 文档中重复。保留实验数据的简短索引，正文下沉到 cache-ttl 主题文件。                                |
| `live-acceptance-tmux.md`    | **特定任务才需要**，只在真机验收/traffic.db/tmux 调试时有用。                               | 与 `docs/dev/sysprompt-stable/acceptance.md:4-5,25-28,69-108`、`docs/dev/sysprompt-stable/plan.md:1017-1037` 的验收方法重复；不应常驻。                                                      |
| `multi-agent-experiments.md` | **特定任务才需要**，主要是交接和 consult 的实验结论。                                       | 与 `skills/agent-handoff/SKILL.md:13-23,131-158`、`docs/dev/fabric-v2/baseline-results.md:71-72,160-162,454-477` 重复；只保留一条“使用 fileIndex/核验纪律”的索引。                           |
| `quota.md`                   | **特定任务才需要**；不是普通 coding 轮的项目事实。                                          | 几乎逐条对应 `AGENTS.md:230-236` 和 `docs/dev/quota/`；应从常驻 memory 下沉或删除重复副本。                                                                                                  |

“每轮都需要全文”的文件当前是 **0/5**。按职责判断，**12,706B 全部可以移出默认全文内联**；保守估计可直接删除或合并重复内容约 **35%–50%（4.4–6.4KB）**，其余不是应删，而是应下沉到主题文件。这个比例是人工内容分类估算，不是字节级相似度算法结果。

## 3. 总体设计评估与可选方案

### 3.1 当前方案的优点

1. **system prompt 稳定化方向正确。** `stable` snapshot + tail update 保留长前缀缓存，解决了“写入后整段 system prompt 改变”的主要成本问题。
2. **渲染成本有本地缓存。** 指纹只需 readdir/stat；缓存 miss 才读正文，纯模块边界清楚。
3. **有基本安全和可追溯能力。** frontmatter pin/source、agent fence、子会话默认禁写、目录和字节上限都已落地。
4. **错误降级明确。** provider 失败返回 `SKIP`，不会因为 memory 读失败破坏 session；空目录不烧 system prompt token。
5. **子会话和 worktree 语义一致。** memory section 预注册，worktree origin 统一到主仓库目录。

### 3.2 当前方案的主要缺点

1. **选择依据是 mtime/pin，不是任务相关性。** 最近写入的验收或排障记录会挤掉更通用的事实；`pin` 还会把一个大文件长期放在第一候选。
2. **默认截断发生在注入时，而不是内容生产时。** 当前 `pitfalls.md` 同时付出了文件索引、fence、正文前半段的 token，却仍拿不到完整规则；后续模型很可能 read 全文，形成“首轮半截 + 工具再读”的重复成本。
3. **`inlineMax=3` 产生低价值碎片。** 当前 `quota.md`/`multi-agent-experiments.md` 只留下约 138B/157B，不能支持可靠决策，却消耗上下文空间。
4. **索引不可检索语义。** 只有文件名和大小。模型看到 `cache-ttl.md` 不知道什么时候值得读，也不知道它是否已过时。
5. **尾部 update 是完整块复制。** 变化频繁时最多 3 次 × 32KB/section；虽然有界，但对 memory 来说仍会重复发送索引和已知内容。pointer 只说使用 `memory list`，没有直接给出候选文件及 read_when。
6. **mtime 变化被视为内容变化。** 只 touch 文件也会改变 fingerprint，稳定模式会生成 update；计划文档已承认该行为（`docs/dev/sysprompt-stable/plan.md:1073`），但对“最快加载”并不理想。

### 3.3 方案对比

| 方案                                           | 零工具调用命中率                           | 每轮 token                                        | prompt-cache                          | 结论                                   |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| 当前 index + pinned/recent 截断                | 中低：有索引但无语义；大文件常命中半截     | 默认约 1,100 token/每个 session；稳定后仍占上下文 | stable 模式好；写入走 tail，legacy 差 | 保留稳定化机制，替换选择算法           |
| **硬预算精简 core + 描述索引**                 | 高：高频事实直接命中；主题事实可按描述定位 | 建议 460–685 token 常驻                           | 最好；core 变更低频，尾部少           | 推荐目标形态                           |
| 写入时强制预算，注入时不截断                   | 中高：内容完整但不一定相关                 | 上限可控，避免半截；仍可能把多个主题全注入        | 稳定，但写入失败/整理成本上升         | 必须做，不能单独解决相关性             |
| 主题细文件 + frontmatter description/read_when | 中高：索引能指导精确 read                  | 常驻只付索引；按需付单文件                        | 好；单文件变动只触发一次 tail         | 推荐作为 core 之后的第二层             |
| 按 agent 类型/子会话裁剪                       | 主会话高，子会话取决于类型                 | 可把 N 个 child 从 1,100 降至 300–500 token       | 各 session 前缀更小、命中更便宜       | 推荐 child 默认 core-only，可配置 full |
| 稳定内容放 AGENTS.md/skills                    | 高，但把内容直接放在全局 system prompt     | memory token 归零，AGENTS/skill token 增加        | 文件变化会影响全局前缀；范围过宽      | 只迁移真正全局、稳定、每轮必需的规则   |

### 3.4 推荐组合

采用“**A 小核心 + B 语义索引 + C 主题按需读 + D 子会话裁剪**”：

```text
system prompt
  └─ pi_project_memory（稳定 snapshot）
       ├─ core.md：约 1,200–1,600B，全文常驻
       └─ Index：约 600–1,000B，文件名 + description + topics + read_when + updated

memory directory
  ├─ core.md
  ├─ cache-ttl.md
  ├─ quota.md
  ├─ agent-handoff.md
  └─ acceptance-tmux.md

工具调用
  └─ 模型按 index 的 read_when 精确 read 一个主题文件
```

默认不再按 mtime 把多个主题文件塞进 inline 区；`pin` 只用于 core 或明确批准的第二个小文件。若要保留 recent，可只在“文件小于 1KB 且 index 描述明确”时整文件准入。

## 4. 接口与数据契约建议

本节是给 todo #22 后续设计/开发使用的契约，不是本次实现改动。

### 4.1 Memory 文件 frontmatter

现有行级 parser 不支持 YAML 数组，因此第一版保持简单 key/value：

```yaml
---
topic: cache-ttl
description: Prompt cache 的 1h/5m 寿命、保活和自适应边界
read_when: cache-ttl; prompt cache; keepalive; adaptive
status: active
updated: 2026-09-26
pin: false
source: agent
---
```

约束：`description` ≤160 UTF-8 字节；`read_when` 为分号分隔关键词 ≤240B；`status` 取 `active|stale|archived`；`updated` 只接受 ISO 日期。渲染器只把 description/read_when/status 摘要放入 index，不把 frontmatter 原文放进正文。

### 4.2 常驻预算

建议默认值：

- `coreBytes`: 1,600B（硬上限；约 450 token）。
- `indexBytes`: 1,000B（约 285 token），最多 20 项。
- Memory section 总目标：2,400B 以内（约 685 token，包含标题、指针、sentinel 的正常开销）。
- 常驻全文文件数：1；最多允许一个额外小文件，且该文件正文 ≤800B。
- 主题文件：建议单文件 2–8KB；超过 8KB 警告，超过 16KB 要求拆分或归档；不在注入时静默截断成半截。

这不是要求每个模型固定使用 685 token，而是可观测的上限；混排 tokenizer 需在真机 traffic.db 中再校准。

### 4.3 写入契约

- `core.md` 的 write/append 必须在落盘前按 coreBytes 校验，超限拒写并提示拆分。
- 主题文件建议 `maxFileBytes=8KB`，append 达到 6KB 时产生体检告警；不建议继续提高全局 `maxFileBytes` 来容纳长日志。
- 新 write 必须有 `description` 和 `read_when`；append 不改变 frontmatter，但体检时要求补齐。
- 写入不在请求路径自动调用 LLM 总结：自动摘要会增加延迟、成本和失败面。先做确定性的拒写/告警/候选报告，再由显式 `/mem organize` 或 todo #22 的后台整理流程处理。
- 保留 `source: agent` fence 和子会话默认只读；自动整理产生的文件应标记 provenance，并避免把“整理指令”当项目事实注入。
- 不再把 mtime 作为内容相关性的唯一信号；fingerprint 至少加入 size/content hash 或 frontmatter `updated`，并区分“只 touch”与“正文变化”。

### 4.4 更新消息契约

- stable snapshot、tail update、pointer、`subagent:prompt-sections` 持久化机制继续复用，不另造 memory 专属缓存协议。
- memory update 优先发送“文件变更摘要 + 目标文件名 + read_when”，只有小型 core 变化才发送完整 core。
- pointer 应至少包含受影响文件名和 `memory` 工具的精确 action；当前仅有 `Use the memory tool (action: 'list')`，对降低额外 read 往返不够。
- 子会话使用相同 section 接口，但 provider 根据 agent type 返回 core-only 或空；不要复制一套 child 专用注入实现。

## 5. 关键决策与取舍

### 5.1 为什么保留 stable snapshot + tail

这是当前最合理的部分。memory 写入是低频但经常发生在长任务中；让写入直接改变 system prompt 会让从变更位置开始的 provider cache 前缀失效。stable 模式将变化放在可见的尾部消息，保持开头字节稳定；`docs/dev/sysprompt-stable/plan.md:1027-1037` 也明确以此验证 cacheRead 和 wake replay。

不选“每轮都实时注入”的理由是它牺牲 prompt-cache；不选“写入后强制下轮刷新”的理由是一次低价值 memory 更新可能付出整段前缀重写。`freezeInjectionAfterWrite` 可作为极端成本控制开关，但不应成为自动整理的默认机制，因为它延迟了模型刚写内容的可见性。

### 5.2 为什么不用继续提高 byteCap

提高到 8KB/16KB 会让当前五个文件更完整，却把“所有主题都常驻”的错误选择固化，且子 agent 成本线性增加。当前总目录 12.7KB 已证明内容量不是唯一问题：真正缺的是优先级、语义和过时治理。先压缩/拆分/描述，再考虑预算。

### 5.3 为什么不把全部内容迁入 AGENTS.md 或 skills

`AGENTS.md` 适合每次都必须遵守的仓库级规则；skills 适合任务策略和操作流程。cache-ttl、quota、tmux 验收、consult 实验是主题知识，迁入全局会扩大所有任务的固定前缀，并且改变这些文档会影响全局缓存。建议只把确认稳定的跨任务约束迁移到现有源文档，memory 只保留项目事实和决策摘要。

### 5.4 为什么 index 必须有 description/read_when

当前索引只告诉模型“有一个叫 `cache-ttl.md` 的文件”，不能回答“现在是否相关”。没有语义时，模型要么盲目 read，要么搜索整个仓库；这与已有交接实验“省的是找，不是读”的结论相反。`skills/agent-handoff/SKILL.md:13-23` 已证明坐标和核验纪律比长结论更有价值，memory index 应采用同一原则。

## 6. todo #22 实施要点（按收益/成本排序）

### P0：先调整加载机制，收益最高

1. **改为 core-only 常驻。** `render.ts`/`inject.ts` 保留 stable hub 和 RenderCache，但默认只内联 `core.md`；主题文件只生成 index 摘要。目标总块 ≤2.4KB。
2. **补语义索引。** 扩展 frontmatter 和 index 行为 `file — description [topics] [read_when] [updated]`；保持行级 parser，避免引入 YAML 依赖。
3. **禁止低价值半截文件。** 在 inline 候选准入时采用整文件或最小有效比例（例如至少 50% 正文或至少 300B）；否则只进 index。当前 quota/multi 的 138B/157B 片段应成为回归测试。
4. **child 默认 core-only。** 保留 `injectInChildSessions` 总开关，再增加明确的 child profile（`none|core|full`）或按 agent type 映射；不要让 N 个 child 自动复制完整 memory。

### P1：写入约束和体检

5. **写入时强制分层预算。** core 1.6KB、主题 8KB、append 软阈值 6KB；超限拒写并给出拆分建议，旧文件通过体检逐步修复。
6. **新增只读体检输出。** 检查：core 超预算、主题超 8/16KB、缺 description/read_when、`status: stale`、超过 30/60 天未更新、index 总预算、重复 topic、疑似 secret、只 touch 导致的虚假变化。
7. **改 pointer 信息。** 超过 update 上限时，消息直接列出变更文件和 `read_when`，减少“先 list 再猜再 read”的往返。

### P2：自动整理和度量

8. **自动整理做成显式/后台流程，不放在注入热路径。** 先生成合并、去重、归档候选和 diff，用户确认后写回；默认不让 LLM 静默覆盖用户记忆。
9. **建立指标。** 记录每 session 的 memory bytes/tokens、child profile、update 次数、pointer 次数、`read` 命中率、首轮零工具命中率、cacheRead/cacheWrite；按主会话与子会话分开看。
10. **回归验收。** 用当前五文件作为 fixture：默认块 ≤2.4KB；普通 coding 任务不自动 read 主题；cache-ttl 任务通过 index 一次命中目标文件；写入后 system prompt hash 稳定、tail message 出现；compaction 后新 snapshot 正确替换旧内容。

## 7. 实施风险与验证边界

- “3.5B/token”只适合容量规划；最终 token 应使用实际运行模型的 tokenizer 或 traffic.db usage 校准。
- stable hub 的刷新点、wake replay、子会话 pre-guard 顺序属于共享基础设施；修改 memory provider 时必须保留 `SKIP`、`POINTED`、`getBranch()` 和 `session_compact` 语义。
- 将默认 child 注入从 full 改为 core 是行为变化，需要按 agent type 验收，尤其是 Plan/验证类 agent 是否仍能访问索引和 memory 工具。
- 不能把“文件已被 pin”当作“内容应永远完整注入”；pin 应只表达优先级，仍受 core/主题分层和预算约束。
- 现有 `docs/dev/memory/memory-plan.md:245` 已注明旧版 handler 描述被 M3 registration 取代；后续方案和测试必须以 `memorySection` + hub 为准，不应恢复独立 memory hook。

## 8. 证据清单

- 实现：`src/memory/paths.ts`、`frontmatter.ts`、`store.ts`、`render.ts`、`inject.ts`、`index.ts`、`src/sysprompt/hub.ts`、`src/prompt-sections/{stable-section,fold,update-message,store}.ts`。
- 设置：`src/config/settings.ts:64-82,561-725,1249-1275`；`src/config/setting-specs.ts:290-316`。
- 设计：`docs/dev/memory/memory-plan.md:186-236,245-260,328-342`；`docs/dev/sysprompt-stable/plan.md:381-396,625-650,900-905,1017-1037`。
- 项目约定：`AGENTS.md:178-217,230-236,297-300,323-332`。
- 真实数据：`/home/bluecake/.pi/agent/memory/-home-bluecake-ai-pi-toolkit/*.md`，本评审统计日期为 2026-09-26。
