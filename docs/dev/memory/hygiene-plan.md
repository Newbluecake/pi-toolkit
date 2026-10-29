# 记忆系统流程改进 · 技术方案（hygiene plan v2）

> 需求摘要：把 `hygiene-flow.md` 里已拍板的五环节（写入/召回/覆盖/失效/整理）落成机制。
> 记忆像 quota 一样主动注入，分四层触发：T1 工具动作、T2a 关键词、T2b 判断器、T3 边界。冷却按「一段上下文」去重，粒度到条目级。
> 触发规则由 agent 写、写完回显；用户令只有用户能作废；临时规则必须带失效条件，到期提示用户、用户确认后才删；预算超 80% 时提示 `/mem tidy`。
> 子 agent 也接收注入（Q9）；用户界面只显示轻量标记（Q8）。功能关闭时逐字节不变（I9）。
> 本文是技术方案，流程与拍板见 `hygiene-flow.md`，能力边界见 `hygiene-explore.md`，评审见 `hygiene-review-r1.md`。状态：v2 = 按评审 r1 修订（处置表在文末 §10），O1–O11 已于 2026-10-29 全部拍板（§8），未动代码。

## 0. 结论速览

| 问题                | 决定（理由见对应章节）                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 条目是什么          | 沿用 `## ` 小节作为「条目」；小节标题下第一行可写一行元数据注释 `<!-- mem … -->`（触发规则、kind、失效条件）。列表行末尾可写同语法的行级注释，但只允许 `kind`/`expires`/`until`（core.md 的 bullet 规则要用）。不新增 frontmatter 键                                            |
| 用户令 vs 经验坑    | `kind=user` / `kind=lesson`。没写时：手写文件（无 `source: agent`）默认 `user`，agent 文件默认 `lesson`（与 Q4「依据 `source: agent`」一致）                                                                                                                                    |
| 注入通道            | 一律走**消息通道**（custom message，进模型上下文），绝不进 system prompt section。T2a/T3 用 `before_agent_start` 返回 `message`；T1、T2b 晚到结果、运行中的 T3 用 `sendMessage(…,{triggerTurn:false})`（流式中会排到本 turn 的工具结果之后，不唤醒新一轮）                      |
| T1 怎么接           | 只挂 `tool_call`：命中 gate 就 `{block:true, reason}` 拦一次；非 gate 则发一条排队的注入消息。**不改写 `tool_result` 的 content**（规避 structuredContent 丢失和内置工具渲染器展开正文的问题），模型看到的位置仍是「紧跟在工具结果后」                                          |
| T2b 成本与时延      | 自建判断调用，**异步、零等待**：`before_agent_start` 只负责发起、不 await。结果晚到就排进本 turn 末尾，空闲时直接追加进上下文。只用便宜模型链（不回退会话模型）。限频：每会话次数上限、每会话美元上限、同会话只保留一个在飞调用、子会话进程级令牌桶。secure 域强制关闭（O11）   |
| 冷却去重            | 每次注入写一条 `appendEntry("subagent:memory-recall")` 记录（不进上下文）。「本段上下文」= 分支上最近一条 `compaction` 之后的部分。每次 `before_agent_start` 从分支反扫重新播种，跨 /reload、resume、/tree 切换都天然正确；switch_context 和压缩都会产生 compaction，即自动重置 |
| Q8 可见             | 模型看注入正文（custom message，内容投影成 user 角色）；用户看轻量标记：TUI 用 `registerMessageRenderer`，折叠时只有一行，展开（ctrl+o）才看到正文；web 在 transcript 加紧凑分支。不用 `setStatus`，省得处理清理时机                                                            |
| Q9 子会话           | 走**子会话自身的 hook**（`before_agent_start` 的 `event.prompt` 就是派单 prompt），不改 `SpawnRequest.prompt`                                                                                                                                                                   |
| append 刷 `updated` | v2 的 `doAppend` **本来就是**锁内读-改-写 + CAS（`tool-v2.ts:605-627` 用的是 `commitReplace`），R4「append 不做读-改-写」只约束 legacy `store.ts`。所以只需在 v2 锁内加一次 `upsertFrontmatterFields`；legacy 面保持不变（它是字节兼容的退路）                                  |
| I9                  | 两个总开关 `memory.hygiene.enabled`、`memory.inject.enabled`，默认开（O4 已拍板）。两者都关时，P0 在改动前录下的 off golden 必须逐字节一致                                                                                                                                      |

## 1. 数据模型

### 1.1 文件层（不变）

- 目录、命名、frontmatter 字段全集（`description`/`read_when`/`topic`/`status`/`updated`/`pin`/`source`）**一个都不加**。`parseMemoryMeta` 本就容忍未知键，但新增键会把「文件级 vs 条目级」搞混，Q4 也需要条目级粒度，所以不用 frontmatter。
- `read_when`/`description` 的用途改成「给人和 T2b 判断器看的说明」，不再承担触发职责（流程要求 `when` 变成系统执行的规则，规则落在条目上）。

### 1.2 条目层：小节元数据行（新增）

条目 = `## ` 小节（`meta.ts:splitSections` 的现有单位，search/edit/tidy 链路都不改切分）。小节标题之后的**第一个非空行**，如果匹配 `^<!--\s*mem\s(.*)-->\s*$`，就是该条目的元数据行：

```md
## 发版规则

<!-- mem kind=user kw=发版|release|打tag tool=bash arg="release.sh|git tag|git push" gate -->

- 默认 patch；feat ≥50 才 minor；发版前确认 CI 绿……
```

语法（一行，≤400B，按空白分词；值可以是不含空白和 `"` 的裸词，也可以是 `"带空格 \" 转义"`）：

| 键        | 值                                  | 作用                                                                                     |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `kind`    | `user` \| `lesson`                  | 用户令 / 经验坑（Q4 权限）                                                               |
| `kw`      | `a\|b\|c` 字面量备选                | T2a：用户消息包含任一词（不区分大小写；纯 ASCII 词要求两侧不是字母数字，中文直接按子串） |
| `tool`    | `bash\|edit\|Agent` 或 `*`          | T1：工具注册名精确匹配                                                                   |
| `arg`     | `"git push\|release.sh"` 字面量备选 | T1：在工具参数的规范串里找子串（不区分大小写）                                           |
| `path`    | `src/web-hub/**\|*.vue` glob 备选   | T1：文件类工具的路径参数（相对仓库根）匹配 glob                                          |
| `gate`    | 无值标记                            | T1 命中时在动作**前**拦一次（Q6）；没有 T1 键时写 gate 无意义，doctor 会报 D18           |
| `expires` | `YYYY-MM-DD`                        | 到这天（含）之后算到期（Q1，④）                                                          |
| `until`   | `"事件描述"`                        | 事件型失效条件，系统无法自动判定，只列为「待确认」                                       |

- **刻意不支持正则**：agent 写的正则跑在每次工具调用的 bash 命令上，有 ReDoS 风险，Node 也没有正则超时。字面量子串加 glob 已覆盖流程里的全部例子（派单、发版、push、删除、改 `src/<x>`）。glob 只支持 `*`、`**`、`?`，编译成锚定的线性正则。
- T1 语义：`tool`、`arg`、`path` 三者中**写了的全部满足**（AND），且至少写一个。只写 `path` 时，默认工具集为 `read|edit|write|grep|find|ls`。
- 参数规范串（`match.ts` 唯一定义）：每个参与匹配的字段拼成一行 `字段名:值`，按固定字段顺序用 `\n` 连接，缺失字段整行省略。`bash`→`command:`；`read/edit/write`→`path:`；`grep/find/ls`→`path:` + `pattern:`；`Agent`→`subagent_type:` + `model:` + `description:` + `prompt:`；其它工具→按键名排序的顶层字段 `key:JSON值`。统一截到前 8KB。带字段名的好处：`arg="model:"` 只在派单**显式传了 model 参数**时命中，而不是 prompt 里碰巧出现 model 这个词（评审 #11）；`arg="git push"` 这类纯值子串照常命中。
- 未知键、坏日期、没有 T1 键却写了 gate、元数据行不在标题下第一行：解析器**不抛错**，产出 `errors`，由 doctor D18 报告。写入时如果是本次写入**新引入**的错误，就拒写（与 `assertNoNewFrontmatterErrors` 同一哲学）。

### 1.3 行级元数据（新增，仅限失效与权限）

core.md 这类文件是 bullet 列表、没有 `## `，「GPT 临时禁用」这类条目就是一行。所以允许在**列表项行尾**写 `<!-- mem kind=user expires=2026-11-30 -->`。只认 `kind`/`expires`/`until` 三个键（行级条目不能触发注入：core 本来就常驻静态块）。行级条目的范围 = 该行 + 其后缩进更深的续行。

### 1.4 条目标识

- `EntryKey` = `<file>#<heading>`（重名标题加 `~2` 后缀）；行级条目为 `<file>:L<n>`，只给失效/权限用，行号随编辑变化，不持久化，**也不用于新旧版本配对**（配对算法见 §3.2）。
- 去重键 = `EntryKey@<sha1(小节正文)前 8 位>`。条目被改过就会重新注入一次（用户改了规则，模型应该再看到一遍）。

### 1.5 兼容旧文件

- 没有元数据行的旧小节：`kind` 走默认，没有 T1/T2a 触发，**仍然参与 T2b 目录**（标题 + 前 100 字）和 T3。所以上线当天就有召回，不必等迁移。
- 渲染：hygiene 开启时，tiered 静态块（core 内联部分）会**剥掉** `<!-- mem … -->` 行和行尾注释，避免占预算。现有 golden 的 fixture 里没有这种注释（`grep -r "<!-- mem" tests/fixtures` 为空），输出逐字节不变。hygiene 关闭时不剥（I9：注释只是普通文本）。legacy layout 永远不剥。
- search：元数据行是正文的一部分，可被搜到（`kw` 命中反而有用），无需改动。
- tidy：tidy 模型可能吞掉元数据行。hygiene 开启时，`tidy/prompt.ts` 加一条「原样保留 `<!-- mem … -->` 行」，`tidy/diff.ts` 的预览对「将删除或改动的 kind=user 条目」加 `⚠ user rule` 标记。**不碰事务层**（流程「不做」项）。

## 2. 主动注入：四层触发

### 2.1 通用部件（`src/memory/hygiene/*` 纯函数 + `src/memory/recall/*` pi 面）

- **EntryIndex**（`hygiene/entry-index.ts`）：扫描记忆目录（复用 `listRegular`/`readRegular`，按 v2 命名），产出 `Entry[]`，字段为 `key/file/heading/kind/meta/text/hash/isStaticCore`。按目录指纹（各文件名+size+mtime）缓存；`onAfterWrite` 时失效。`isStaticCore` = 属于 primary core，且不在最近一次 tiered 渲染结果的 `omittedSections` 里（这些小节已在 system prompt 中，非 gate 注入时跳过）。数据来源：复用 `memorySection` 现有的 `onRender` 回调（`src/memory/index.ts` 里已用它写 `lastBlocks`），P5a 给它加一个可选参数，带上 tiered 结果的 `omittedSections` 和 primary 文件名，缓存在 wireMemory 闭包里；按 cwd 取。**还没渲染过**（例如子会话 `childProfile:none`，或首轮 hub 尚未运行）时退化为「不跳过」：最坏情况是把已在 core 里的一节再推一次，无害（评审 #10）。
- **Segment state**（`recall/state.ts`）：
  - 记录：`pi.appendEntry("subagent:memory-recall", {v:1, layer, keys:[去重键], gates?:[去重键], t3For?:compactionId})`。`appendEntry` 缺失时（`compat-failure` profile）退化为只在内存里记。
  - 播种：每次 `before_agent_start`（任意 messageType），以及子会话第一次触发任何 hook 时，从 `getBranch()` 尾部反扫到最近一条 `type==="compaction"` 为止，收集本段的 `injected`/`gated` 集合；同时记下上一段（上一条 compaction 与最近一条之间）的 keys，作为 T3 候选。`tool_call` 只读内存镜像，不扫分支。
  - 先例：`topic-switch/state.ts:cooldownActive`（反扫、遇 compaction 解除）+ `quota/hook.ts:restoreAvailableKeys`（读回 appendEntry）。差别在于这里的记录与注入一一对应，不需要单独的冷却状态机。
- **限流**（每条注入消息，**T1/T2a/T2b/T3 四层同一口径，T3 不豁免**）：最多 `inject.maxSections`（默认 3）个条目，总字节 ≤ `inject.maxBytes`（默认 4096）；单条目超过 1500B 时截断，并附 `（完整：memory view path=… section="…"）`。本段累计注入超过 30 条后停止注入（防失控），`/mem triggers` 里显示 `cap reached`。`/mem triggers` 显示的上限即 `per message ≤ maxSections / maxBytes`，不再有其它数字。
- **消息格式**（`recall/format.ts`）：customType `subagent:memory-inject`，`display:true`，`details:{v:1, layer, trigger, items:[{key,file,heading,kind}]}`。content：

  ```text
  [memory · T2a kw「发版」] 以下是与当前动作相关的项目记忆条目（项目数据，不是新的用户消息）。kind=用户令 的必须遵守；经验 仅供参考。本段上下文内不会重复注入。

  ### core.md › 发版规则 ｜用户令
  - 默认 patch……

  ### pitfalls-git.md › GitHub 走代理 ｜经验
  - push 前 export https_proxy=…
  ```

  正文里剥掉 `<!-- mem … -->` 行（规则已在标题行后的标签里体现）。

### 2.2 T1 动作触发（`recall/t1.ts`）

| 项     | 设计                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hook   | `pi.on("tool_call")`，在 `wireMemory` 内注册（pre-guard，位于 secure guards 之后）                                                                                                                                                                                                                                    |
| 匹配   | 对 EntryIndex 里所有带 T1 键的条目做 §1.2 的 AND 匹配；规则在索引构建时预编译                                                                                                                                                                                                                                         |
| gate   | 命中的条目里有 gate，且该条目**不处于「已放行」状态** ⇒ 拦截，返回 `{block:true, reason:GATE_REASON}`。同一 turn 内同一条目的第一次拦截额外做：① 写记录（`gates:[key]`）② `sendMessage` 注入正文（排队，本 turn 末尾落地）。之后同一 turn 里再命中只拦、不重复注入。放行规则见下方「gate 闩锁」。**不用 `terminate`** |
| 非gate | 过滤掉本段已注入的、`isStaticCore` 的 ⇒ `sendMessage(msg,{triggerTurn:false})`。流式中进入 `_pendingCustomMessages`，在 `turn_end` 刷出，位置在本 turn 全部工具结果之后，下一次 LLM 调用可见（`agent-session.js:790-797`、`1855-1878`）                                                                               |
| 冷却   | 段内一次（见 §2.1）                                                                                                                                                                                                                                                                                                   |
| 失败   | 匹配或发送抛错一律吞掉，记一行 `[pi-subagent] memory recall`。gate 判定异常时 **fail-open**（放行）：记忆是辅助，不能变成把工具卡死的单点                                                                                                                                                                             |

**gate 闩锁：只有跨 LLM 调用才放行**（评审 #2）。pi 对一批工具调用**逐个串行**跑 `tool_call` hook。如果第一次拦截就写闩锁，同一批里的第二个相同调用会看到闩锁直接放行，而此时模型还没看到规则正文。所以闩锁带上 turn 序号：

- `recall/state.ts` 维护 `turnSeq`：memory 自己的 `turn_end` handler 每次加一（子会话同样有 `turn_end`）。
- 被拦时记 `pendingGate[key] = turnSeq`（内存）。
- 放行条件：`turnSeq > pendingGate[key]`。pi 在 `turn_end` 时**先**派发扩展 handler、**再**刷出 `_pendingCustomMessages`（`agent-session.js:790-797`）。下一次 `tool_call` 只可能发生在下一 turn 的 LLM 调用之后，那时注入消息已经落地、模型已经看过正文。满足条件后转为「已放行」，本段内不再拦。
- 同一批（同一 turn）里的所有相同调用都会被拦，第一个负责注入正文。
- 跨 run 和 /reload：从分支播种出的 `gates` 记录一律视为「已放行」。gate 记录只会在 run 内写入，而 pi 在 run 结束（`finally`）前一定会刷出待发消息，所以记录所在 run 的注入正文必然已经落地。
- run 被中止：同样由 `finally` 刷出，下一次 run 的 `before_agent_start` 重新播种，视为已放行。

gate 拦截文案协议（`format.ts` 常量，中文一句话 + 后续动作，参照 `secure/guards.ts` 的写法）：

```text
[memory gate] 本次 <tool> 调用未执行：它命中了记忆中标为 gate 的规则「core.md › 发版规则」（用户令）。规则正文紧随其后以 [memory] 消息给出。请逐条核对：全部满足就在下一步原样重试（看过正文之后的重试不会再拦；同一批里并发的相同调用也已一并拦下）；有不满足的，调整方案或先问用户。
```

### 2.3 T2a 输入·关键词（`recall/t2.ts`）

- hook：`pi.on("before_agent_start")`（memory 自己的 handler，**只返回 `message`，绝不返回 `systemPrompt`**，注册在 hub 之后）。
- 只在 `event.messageType === "user"` 时运行，`event.prompt` 是用户原文（展开后），所以通知唤醒、`sendMessage` 起的轮次天然排除（Q：T2b「只看用户本人」同样成立）。
- **匹配文本**（评审 #9，部分采纳）：先剥掉 pi 的 skill 展开块（`^<skill name="…" location="…">\n…\n</skill>`，格式见 `agent-session.js:54/1739`，剩下的是用户在 `/skill:x` 后面打的参数），再做 T2a/T2b 匹配。一个 SKILL.md 正文动辄几 KB，几乎必然命中大量 kw，这里不能接受。prompt 模板展开**保留**：模板是用户自己定义的快捷说法，展开后的内容就是用户意图。块格式不符时退化为全文匹配；P0 conformance 钉住这个格式。
- 匹配所有带 `kw` 的条目，过滤本段已注入的和 `isStaticCore` 的，按「命中词数 → 用户令优先 → 文件名」排序，截到 maxSections。返回 `{message}`，位置在用户消息之后，搭本轮请求的便车，不起额外一轮（`agent-session.js:1495-1525`）。

### 2.4 T2b 输入·判断器（`recall/judge.ts`）

**为什么不主要靠 topic-switch 顺带**：topic-switch 只在「冷缓存 + 估算下一请求 > $0.5 + 空闲 + 有 UI」时才判断（`topic-switch/gate.ts:26-70`），多数消息不触发。它在 post-guard（子会话没有），而且起手就吞掉 input。它的判据 V2 是经过 24 条人工标注评测定下的，往它的输出里加字段会动到它的准确率。所以 T2b 自建调用；「与 topic-switch 共用一次调用」本期不做（O1 已拍板）。

| 项       | 设计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发闸门 | 同步、零 IO、按序检查：① `inject.judge.enabled` 且模型链非空 ② messageType=user ③ **本轮 T2a 没有任何关键词命中**（流程「关键词没命中才兜底」；只要有 kw 命中，哪怕命中的条目都因段内已注入被去重滤掉，本轮也不跑判断器。主会话和子会话首轮同样适用，不设例外）④ 去掉空白后 ≥8 个码点，且不是应答类短句（`继续/好/ok/yes/go/嗯/对/可以/continue/next` 等，可带标点）⑤ 候选目录非空 ⑥ 本会话已调用次数 < `judge.maxCalls`（默认 40），累计花费 < `judge.maxCostUsd`（默认 $0.20）。计数只在内存里，**按 activation 计**，/reload 后清零（评审 #8：接受这个放大窗口；设置键说明和 `/mem triggers` 写明「per activation」）⑦ 子会话：进程级令牌桶有余量（20 次/60s，`Symbol.for("pi-subagent:memory-judge-bucket")`，容量即上限）⑧ **非 secure 域**（O11：`getSecureDomain()?.kind !== "plain"` 时在 wire 阶段就不接判断器，任何设置都打不开，同 I11/D8 语义；`/mem triggers` 显示 `judge: off (secure domain)`） |
| 时序     | `before_agent_start` 只**发起**调用、不 await，零等待。新的用户 prompt 到来就 abort 旧调用（代际计数 + AbortController）。结果回来后若代际仍是当前的 ⇒ `sendMessage(msg,{triggerTurn:false})`：运行中则在当前 turn 末尾落地（有工具调用的任务下一次 LLM 调用就能看到）；已空闲则直接追加进上下文，下次提问时可见                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 模型链   | `memory.inject.judge.models` → `topicSwitch.models` → `title.model`，严格解析 `provider/id`，去重。**不回退会话模型**（会话模型可能是 opus，单次判断就比整个 T2b 预算还贵）。链为空 ⇒ T2b 不跑，`/mem triggers` 显示 `judge: no cheap model`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 调用     | 复用 topic-switch 的端口绑定写法：`streamSimple(model,{systemPrompt,messages},{signal,maxTokens:512,reasoning:"minimal"})`，没有就退到 `complete`。硬超时 `judge.timeoutS`（默认 5s），外层套 `withDeadline(+500ms)`，计时器 `unref`，时长经 `clampSpanMs`（I1/I5）。按链逐个 failover，每档预算 ≥1.5s。**不改 topic-switch 任何文件**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| prompt   | system：「你是项目记忆检索器。给定用户消息与记忆目录，挑出处理这条消息时必须知道的条目（规则、禁令、坑）。宁缺毋滥，最多 3 条，都不相关就返回空数组。只输出 JSON：{"ids":["e3"]}」。user：`MEMORY CATALOG:` 每行 `e<n> \| file › heading \| 用户令/经验 \| 正文前 100 字`（目录在前，便于 provider 前缀缓存），然后 `USER MESSAGE:`（≤2000 码点）。目录 ≤8KB，超出先去掉摘录，再按文件名截断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 解析     | 取第一个平衡的 `{…}`，`ids` 必须是字符串数组；未知 id 丢弃；解析失败按「无命中」处理（fail-open）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 成本估算 | 目录约 1.5–2k token，加消息约 0.5k，输出 <50 token。便宜模型（flash 级）单次约 $0.0003–0.001，每会话上限 40 次 ⇒ 典型 <$0.04，硬上限 $0.20（从返回的 `usage.cost.total` 累计；provider 不报价时按次数上限兜底）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 关键路径 | 不在关键路径上：用户等待时间 +0。代价是「纯问答、没有工具调用」的那一轮，模型本轮看不到 T2b 结果，下一轮才看到。不做同步等待（O2 已拍板）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 2.5 T3 边界触发（`recall/t3.ts`）

- **判定（幂等，跨 /reload）**：当前段（最近一条 compaction 之后）**没有** `t3For===该 compactionId` 的记录，且上一段有注入记录 ⇒ T3 待执行。
- 检查点：`before_agent_start`（任意 messageType；主会话 switch_context 后会自动续跑一轮）和 `turn_end`（子会话 switch_context 走 boundary drafts，会写 compaction 条目，但不发 `session_compact`，只能靠扫分支）。
- 动作：上一段的 keys 按最近优先去重，重新读取当前正文（条目已删就跳过），过滤 `isStaticCore`，取最近的 `maxSections` 条、受 maxBytes 限制（与 §2.1 同一口径；上一段更早的条目若再被需要，会由 T1/T2 正常触发）。在 `before_agent_start` 时作为 `message` 返回；在 `turn_end` 时用 `sendMessage(triggerTurn:false)`。写一条记录 `{layer:"T3", t3For}`。上一段里的 gate 记录**不**带过来（新段内 gate 会重新拦一次，这是有意的：上下文换了，高危动作值得再核对一次）。
- 「会话开始」：resume/fork 时本段记录对应的注入消息都还在上下文里，无需重注。`/new` 的分支是空的，不继承上一个会话（O9 已拍板）。会话开始只做 §3.4 的到期/预算提示（只走 UI，不进模型）。

### 2.6 静态块瘦身：极简目录（流程「分工」一节）

- `TieredRenderOptions` 新增 `indexStyle?: "full" | "compact"`、`stripMemMeta?: boolean`（`src/memory/contracts.ts`）。`compact` 行 = `- name — description(≤60B)[ · stale]`，去掉 `when:` 和体积档。这样 13 个文件基本都能有完整行，`also:` 退化成兜底。排序不变（按文件名，保持确定性和缓存稳定）。
- 只在 `hygiene && inject` 都开时，由 `inject.ts`（section provider）和 `doctor-command.ts`（doctor 的渲染端口）传入；直接调用 `renderTiered` 的 tiered golden 不受影响。
- 上线时 system prompt 会变一次（一次前缀缓存重写），之后保持稳定。

## 3. 写入 / 覆盖 / 失效 / 整理

### 3.1 ① 写入（`tool-v2.ts` + `hygiene/echo.ts`）

- **append 刷新 `updated`**：在 `doAppend` 锁内，非手写文件执行 `upsertFrontmatterFields(final,{source:"agent",updated})`。文件不存在时（append 新建）同样打上 `source: agent`（与 create 一致）。这是**行为变化**，不只是 bugfix：以前 append 新建的文件没有 `source`，事后被当成手写文件，受 doOverwrite/doDelete 的手写保护；改动后它归 agent，agent 可以自由覆写、删除。已列入 §7 风险表，§9.1 也向用户讲明（评审 #7）。只在 hygiene 开启时生效；legacy `store.ts` 的 R4 不动。
- **写后回显**（每个写操作的结果末尾，在预算行之前）：
  - `section: pitfalls-git.md › GitHub 走代理 (L12-30)`：所在小节（①「写完回显所在小节」）。
  - `triggers: kind=lesson · kw=发版|push · tool=bash arg=git push · gate · expires 2026-11-30`：本次触及条目的解析结果（Q7）。新建的小节如果没有元数据行，追加提示 `triggers: none — add <!-- mem kw=… --> under the heading to enable auto-recall`。
  - `similar: core.md › 派单规则 (L8), pitfalls-subagent.md › 模型路由 (L3)`：用新小节标题和关键词在其它文件里跑 `searchMemory`，取前 3 条（支撑①「先检索同主题」和③覆盖检查）。
- **校验**：元数据行解析错误如果是本次新引入的，拒写并给出错误位置。
- **工具面**：新增 `MEMORY_TOOL_V2_TEXT_HYGIENE`（描述末尾加一句语法提示，约 180B：`Entry rules: first line under a ## heading may be <!-- mem kind=user|lesson kw=a|b tool=x arg="…" path=glob gate expires=YYYY-MM-DD until="…" --> (auto-recall + expiry).`）。hygiene 关闭时仍用原常量，字节不变。`memory-tool-surface.json` **新增**一个 key，不改旧 key。
- 策略（先查后写、用户令当场写、经验坑收尾写、写完把 triggers 行转述给用户）写进新 skill `skills/memory-hygiene/SKILL.md`（I12：机制进工具描述，策略进 skill）。

### 3.2 ③ 覆盖与 Q4 权限（`hygiene/guard.ts` + `tool-v2.ts`）

- `userEntriesTouched(oldText,newText,fileIsHandWritten)` 是纯函数，返回被**删除或改动**的 `kind=user` 条目（小节级和行级都算；把 `kind=user` 改成别的也算）。纯插入新内容、纯位移都不算。**配对算法：内容 hash 优先，行号只作次序参考**（评审 #4）：
  1. 两版各自切出条目，每条算 `hash = sha1(规范化文本)`。小节级的规范化文本 = 标题 + 元数据行 + 正文；行级 = 该行 + 续行。规范化只做「去行尾空白、统一 `\n`」。
  2. 旧版每个 `kind=user` 条目，在新版**同一文件**里按 hash 找匹配，按多重集合计数（相同文本出现 N 次就要求新版也有 ≥N 次）。行号只在多个同 hash 候选里按原次序依次配对，从不作为配对键。
  3. 找到匹配 ⇒ 未改动（即使行号整体下移）；找不到 ⇒ touched（改动或删除）。
  4. 新版里多出来的条目（新增）一律不算 touched，`kind=user` 的新增只走回显。

  结果：在 core.md 顶部插一行，下面所有行级用户令的行号都变了，但 hash 都还在 ⇒ **不弹确认**；改了用户令里的一个字 ⇒ hash 对不上 ⇒ 弹确认。

- 写操作是 str_replace/insert/write/append/delete 之一、且 touched 非空时，走**两阶段**（因为 `withMemoryDirLock` 的回调是同步的，锁内不能 await）：
  1. 锁外：读文件，算出最终文本，得到 touched 列表，记下 baseline stat；
  2. 主会话且 `ctx.hasUI` ⇒ `ctx.ui.confirm("agent 请求修改用户令", "<条目列表 + 前后摘要>", {timeout: hygiene.confirmTimeoutS})`；
  3. 用户同意 ⇒ 进锁，若 stat 与 baseline 不一致就报「并发修改，请重试」，一致则写入；拒绝或超时 ⇒ 抛 `MemoryError("用户未确认：用户令条目只有用户能作废。请在回复里向用户提议具体改法")`；
  4. 子会话或无 UI ⇒ 直接拒绝，返回同一句话。
- 这就是 Q4「agent 只能提议、用户拍板」的落地：提议以确认框形式当场呈现（O6 已拍板选当场确认）。
- 固有缺口（评审 #13，接受并缓解）：`kind` 是 agent 自己写的标记，agent 可以把一条用户令写成 `kind=lesson`，守卫管不到。缓解：写后回显里 `kind` 打在第一位；`/mem triggers` 把**本会话内 agent 新写或改过的条目**标 `new`，并单列「agent 新写的 lesson」小节，方便用户核对 kind 写得是否诚实。
- rename 不改内容，不触发确认。agent **新建** `kind=user` 条目（记录用户刚下的令）允许，只需回显。
- ③「在回复里点明已作废旧规则 X」：写入结果在确认通过后追加一行 `voided user rule: core.md › X`，skill 要求 agent 原样转述给用户。

### 3.3 ④ 失效（`doctor.ts` + `hygiene/expire.ts` + 新命令）

- 新增 doctor 码（`contracts.ts` 的 `DoctorId` 和 `doctor.ts` 的 `ID_ORDER` 末尾追加；D10/D12/D15/D16 是 optimize-plan 里保留或延后的编号，不复用）：

| ID  | 级别      | 规则                                                                                                                                                                                                                      |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D17 | warn/info | `expires` 已到 ⇒ **warn**（`file:line — "标题或行首" expired 2026-10-21`，fix: `/mem expired`）；带 `until` 事件条件 ⇒ **info**（`conditional on: …`）                                                                    |
| D18 | warn      | 元数据行语法错误（未知键、坏日期、有 gate 没有 T1 键、元数据行位置不对、超过 400B）                                                                                                                                       |
| D19 | warn      | primary core 字节 ≥ `hygiene.budgetWarnPct`%（默认 80）× coreBytes ⇒ 「core.md at 94% of coreBytes — run /mem tidy --dry-run」。**抑止**：同一 primary 已触发 D02 或 D03 时不报（超过 100% 已由它们报告，避免双报、三报） |

- D19 **不再看整块字节**（v1 写了「或整块 ≥ 80% × blockBytes」，评审 #3 后删去）：tiered 渲染器的设计就是把块填满到 blockBytes，渲染后的块几乎总在 80% 以上，这一条会在所有记忆库上常驻误报。⑤ 的「预算」以 core 为准（实测的 94% 就是 core）。
- 抑止后 ⑤ 的提示不能丢：hygiene 开启时，**D02 加上 fix 文本** `run /mem tidy --dry-run to slim it`（D02 现在没有 fix 字段）。所以「超预算」和「接近预算」两种状态都会指向 `/mem tidy`。
- 这三条规则以及 D02 的 fix 文本只在 hygiene 开启时生效（hygiene 关闭时 doctor 输出逐字节不变）。
- **对 current-5 golden 的影响（更正 v1 的错误声明）**：current-5 里 `pitfalls.md` 是 `pin: true` 的 primary core，6036B，远超 coreBytes 1.6kB，D02/D03 已在 golden 里。D19 按上面的抑止规则不报；D17/D18 没有注释，不出现；D09 是 L2，明细只取决于 core 的整节省略，与目录样式无关。但 doctor golden 测试用的是 `DEFAULT_SETTINGS.memory`（hygiene 默认开，O4），D02 那一行会多出 ` (fix: run /mem tidy --dry-run to slim it)` ⇒ **doctor golden 确定要刷新**，原因只有这一处，P4 按 B 级声明刷新。
- **`/mem expired`**（`command.ts` 分派 → `hygiene/expire-command.ts`，仅主会话 + TUI）：逐条列出到期和事件型条目，每条用 `ctx.ui.select` 给出 `删除 / 延期 30 天 / 去掉期限（转长期） / 跳过`。删除和改写在目录锁内用 CAS 完成；删除前把整个文件复制进 `.trash`（复用 `trashId` 方案，可以 `/mem restore --trash` 恢复）。由用户亲自操作，所以手写文件和 `kind=user` 条目都能删（Q1「用户确认后才删」）。agent 没有调用命令的通道，也就无法自行删除。
- **`/mem triggers [file]`**：列出全部条目的规则解析结果、D18 错误、判断器状态（模型链；次数和花费按 activation 计，`/reload` 清零；secure 域显示 `off (secure domain)`）、本段已注入的条目。这是用户审阅 agent 写的触发规则的入口（Q7「用户不同意可以要求修改」）。

### 3.4 会话开始提示与 ⑤ 整理

- 扩展 `doctor-command.ts:createStartupReminder`：relevant 集合从「error + D01」扩成「error + D01 + D17(warn) + D19」（D02 本来就是 error，已在集合里，它的新 fix 文本自然带出 tidy 提示），指纹算法不变（id+file），所以同一状态只提醒一次。文案示例：`/mem doctor: 2 expired entries · core 94% of budget — run /mem expired to review, /mem tidy --dry-run to slim.`
- 仍然只用 `ctx.ui.notify`，限主会话 + hasUI（子会话 `isChildSession` 早返回，I6）。不 sendMessage，不进模型。
- ⑤ `/mem tidy` 本身不改。dry-run 预览对 kind=user 条目加标记，prompt 加保留元数据行的规则（§1.5）。

## 4. 子会话（Q9）与 UI 标记（Q8）

### 4.1 子会话：选 hook 注入，不选派单 prompt 拼接

| 维度         | A. 子会话自身 hook（**选用**）                                                       | B. spawn 时拼进 prompt（fabric inbox 先例）                                |
| ------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 覆盖层       | T1/T2a/T2b/T3 全部，复用同一套代码                                                   | 只有派单那一刻（相当于 T2a），子 agent 自己跑 `git push` 时的 gate 管不到  |
| 对派单的影响 | `SpawnRequest.prompt` 不变，workflow journal/replay 和 resume 不受影响               | prompt 字节变化，影响 journal、`trackInput`、resume 时的 prompt 比对       |
| 准入路径     | 不碰 spawn-service 的「零副作用区」                                                  | 要在准入路径里读盘，违反 spawn 准入纯同步、零 IO 的约定（quota gate 先例） |
| 子会话约束   | 没有 `session_start` ⇒ 在第一个 hook 里懒播种（date 范式）；`mode=print` ⇒ 不涉及 UI | 无                                                                         |
| 外部 droid   | 覆盖不到（droid 不跑本扩展）                                                         | 能覆盖                                                                     |

结论：选 A。droid 外部 run 继续用 `renderExternalMemoryBlock`，本期不加主动注入（O8 已拍板）。

- 条件：`isChildSession && memory.injectInChildSessions && memory.inject.childSessions`，否则子会话不注册 recall hook。
- 子会话第一次 `before_agent_start` 的 `event.prompt` 就是派单 prompt ⇒ T2a 立即注入，T2b 异步（子任务首轮几乎总有工具调用，第二次 LLM 调用就能看到）。这就是 Q9「补上派单 prompt 漏写的禁令」。
- 主会话侧：派单本身是主会话的 `Agent` tool_call ⇒ 主会话的 T1（`tool=Agent` 规则，例如「派单禁 X 模型」，可以标 gate）在派发前拦下或附注，作用于主会话的派单决策。子会话侧只管子任务内容。两侧各管一段，不重复。
- 子会话的 records 写进子会话自己的 session 文件，子 agent 的 switch_context 产生的 compaction 同样触发 T3。

### 4.2 Q8：给模型的 vs 给用户的

| 对象 | 通道                                                                                                                                                                                                   | 内容                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 模型 | custom message `subagent:memory-inject`（投影为 user 角色进上下文），gate 时另有 tool error 的 reason                                                                                                  | 条目正文 + 来源 + kind                                               |
| 用户 | 同一条消息的**渲染器**：TUI `registerMessageRenderer`，折叠为一行 dim 标记，例如 `── mem T2a: pitfalls-git › GitHub 走代理, core › 发版规则 ──`（标记 token 用英文，标题是数据原样显示），展开才有正文 | 只有标记；gate 时还有工具错误框里的一句 reason（协议文本，不含正文） |
| web  | `src/web-hub/ui/src/components/transcript/entries.ts` 增加 `subagent:memory-inject` 紧凑分支（同 date 的 `:146-151`/`:184-189`），点击展开                                                             | 同上                                                                 |

- 子会话没有 UI；标记会出现在子会话 transcript 里（web 的 run 详情、`/agent` 查看时可见）。
- 不用 `setStatus("mem")`：它是常驻状态位，要额外处理 turn_start/settled/shutdown 清理，而且看不到历史；渲染器标记跟着 transcript 走，天然只在发生时出现。web 侧也不加 `StatusInfo` 槽（I10 不动 wire）。

## 5. 设置键与 I9

### 5.1 新键（全部非 live，改后 `/reload`；登记到 `src/memory/setting-specs.ts`，解析在 `parseMemorySettings` 里逐字段容错）

| 键                               | 类型/范围           | 默认   | 说明                                                                                                                         |
| -------------------------------- | ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `memory.hygiene.enabled`         | bool                | `true` | 数据模型总开关：元数据解析和剥离、写后回显、Q4 守卫、append 刷时间戳、D17–D19、启动提示扩展、`/mem expired`、`/mem triggers` |
| `memory.hygiene.budgetWarnPct`   | 50–100              | `80`   | D19 阈值                                                                                                                     |
| `memory.hygiene.confirmTimeoutS` | seconds 10–600      | `60`   | 用户令修改确认框超时（超时视为拒绝）                                                                                         |
| `memory.inject.enabled`          | bool                | `true` | 主动注入总开关（T1/T2a/T3、渲染器、极简目录）；实际生效值 = hygiene && inject                                                |
| `memory.inject.childSessions`    | bool                | `true` | Q9                                                                                                                           |
| `memory.inject.maxSections`      | 1–10                | `3`    | 每条注入消息的条目上限                                                                                                       |
| `memory.inject.maxBytes`         | 512–16384           | `4096` | 每条注入消息的字节上限                                                                                                       |
| `memory.inject.judge.enabled`    | bool                | `true` | T2b；secure 域强制关（O11），此键打不开                                                                                      |
| `memory.inject.judge.models`     | string（逗号/数组） | `""`   | 空 ⇒ `topicSwitch.models` → `title.model`                                                                                    |
| `memory.inject.judge.timeoutS`   | seconds 1–15        | `5`    | 单次 T2b 总预算                                                                                                              |
| `memory.inject.judge.maxCalls`   | 0–500               | `40`   | 每会话调用次数上限（per activation：内存计数，`/reload` 清零）                                                               |
| `memory.inject.judge.maxCostUsd` | 0.01–5              | `0.2`  | 每会话累计花费上限（per activation，同上）                                                                                   |

- `judge.models` 的回退值由 `src/index.ts` 从已加载的 `topicSwitch.models`/`title.model` 算好，作为参数传给 `wireMemory`（只是装配，I2 允许）。
- `tests/config/__corpus__/setting-specs-pin.json` 与 `tests/config/memory-settings.test.ts` 同步更新。

### 5.2 I9 证明

- **两者都关** ⇒ `wireMemory` 不注册任何 recall hook 和渲染器；工具描述用原常量；doAppend、doctor、启动提示、tiered 渲染选项、tidy prompt 全部走原路径。
- **P0（改代码之前）** 在当前 dev 上生成 `tests/fixtures/memory/hygiene-off-golden.json`，内容包括：
  1. 真实 `wireMemory`（默认设置）的注册序列（on/registerTool/registerCommand/registerMessageRenderer）；
  2. 一段固定脚本下 v2 工具的输出文本，以及 create/str_replace/insert/append/write/delete 之后的文件字节（时间戳用假时钟固定）；
  3. 对 current-5 及一个含 core 的合成 fixture 的 tiered 渲染、doctor 报告、启动提示文本；
  4. tidy prompt 的文本。

  之后的测试以 `{hygiene:{enabled:false}, inject:{enabled:false}}` 重放，必须逐字节相等。生成器遇到已存在的文件就拒绝重生（同 `bash-tools-golden` 规则），视为 A 级。

- **只关 inject**：只证明 recall hook 和渲染器零注册、tiered 选项不传（单测）。

### 5.3 冻结面刷新清单

| 文件                                                                                        | 级别 | 预期                                                                                                                                                                    | 处置                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/governance/activate-trace.json`                                             | B    | **变**：default/max/child profile 下 memory 段新增 `on(before_agent_start)`、`on(tool_call)`、`on(turn_end)`、renderer 注册                                             | `PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`，commit 写明「memory recall hooks」                |
| `tests/fixtures/memory-tool-surface.json`                                                   | 契约 | **新增** hygiene 变体 key，旧 key 不变                                                                                                                                  | 同包更新 `tool-surface.test.ts` 字节预算                                                                       |
| `tests/fixtures/memory/doctor-golden/current-5.json`                                        | B    | **确定变**：hygiene 默认开 ⇒ D02 行追加 `(fix: run /mem tidy --dry-run to slim it)`（§3.3）。D19 因 D02/D03 抑止不出现；D17/D18 无注释不出现；D09 为 L2，与目录样式无关 | P4 按 B 级声明刷新，commit 写明「D02 fix 指向 /mem tidy（hygiene ⑤）」；diff 若出现 D02 fix 以外的变化即为 bug |
| `tests/fixtures/memory/tiered-golden/*`                                                     | B    | 不变（直接调用，不传新选项）                                                                                                                                            | 新增 `g3_compact_*`、`g3_strip_*` 为新文件                                                                     |
| `tests/fixtures/memory-legacy-golden.json`                                                  | B    | 不变（legacy layout/tool，a3 只用 hub + memorySection，不走 wireMemory）                                                                                                | 每包回归                                                                                                       |
| `schedule-off-golden.json`、`fabric-*-off-golden.json`、`secure-off-golden.json` 等 A 级    | A    | 不变：schedule-off 用 BASELINE（`memory.enabled:false`）；fabric-xs-off 只钉工具表（不新增工具）；secure-off 只比较各场景之间的 trace                                   | 每包跑 `git diff --quiet origin/dev -- tests/fixtures/`，只允许上面声明过的文件变化                            |
| `tests/fixtures/tools/agent-nested-surface-golden.json`（A）、`bash-tools-golden.json`（A） | A    | 不变（不改工具定义）                                                                                                                                                    | —                                                                                                              |
| `tests/config/__corpus__/setting-specs-pin.json`                                            | pin  | 变：追加 12 键                                                                                                                                                          | P2                                                                                                             |
| 新增 `tests/fixtures/memory/hygiene-off-golden.json`                                        | A′   | 新建于 P0                                                                                                                                                               | 之后永不重生                                                                                                   |

## 6. 拆包

依赖图：`P0 → P1 → {P2∥} → {P3, P4, P5a, P5b, P6, P7} → P8`。P1 和 P2 可以并行；P3/P4/P5a/P5b/P6/P7 在 P1+P2 合入后可以并行（文件域互不重叠，冲突点见各包说明）。

| 包  | 范围（文件域）                                                                                                                                                                                                                                                                                                                                                                       | 依赖                                          | 验收标准                                                                                                                                                                                                                                                                                                                                                                 | 测试清单                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | 只加测试：`tests/memory/hygiene/off-golden.test.ts` + 生成 `hygiene-off-golden.json`（**在未改动的 dev 上**）；`tests/conformance/memory-recall-channels.test.ts`（钉住 pi 前提）                                                                                                                                                                                                    | —                                             | golden 在 base 上生成且自测通过；conformance 证明：① `tool_call` 里 `sendMessage(triggerTurn:false)` 在 turn_end 落到工具结果之后、下一次 LLM 调用可见，不起额外一轮 ② `before_agent_start` 的 message 位于用户消息之后 ③ block 后模型收到 isError 结果，且 `tool_result` 不触发 ④ 子会话 switch 提交 compaction 条目                                                    | 两个新文件；`npx vitest run tests/conformance tests/memory`                                                                                                                        |
| P1  | 纯域：`src/memory/hygiene/{contracts,entry-meta,entry-index,match,glob,strip}.ts`；`src/memory/contracts.ts` 加 `TieredRenderOptions.indexStyle/stripMemMeta`、`DoctorId` 加 D17–D19（只加类型）                                                                                                                                                                                     | P0                                            | 解析器永不抛错；语法表全覆盖；glob 线性；匹配规范串唯一定义；无 pi import                                                                                                                                                                                                                                                                                                | `tests/memory/hygiene/{entry-meta,entry-index,match,glob,strip}.test.ts` + 种子属性测试（任意输入不抛错、剥离后再解析无元数据、key 稳定）                                          |
| P2  | `src/memory/settings.ts`、`setting-specs.ts`、pin corpus、`tests/config/memory-settings.test.ts`                                                                                                                                                                                                                                                                                     | P0                                            | 12 键容错解析与默认值；`/agent settings` 列表顺序 pin 更新                                                                                                                                                                                                                                                                                                               | config 测试全绿                                                                                                                                                                    |
| P3  | 写入侧：`src/memory/tool-v2.ts`、`tool-surface.ts`、`hygiene/{guard,echo}.ts`、`memory-tool-surface.json`（新增 key）、`skills/memory-hygiene/SKILL.md`                                                                                                                                                                                                                              | P1,P2                                         | append 刷新 `updated`（hygiene 开）；回显三行；新引入的元数据错误拒写；用户令两阶段确认：同意/拒绝/超时/子会话/无 UI/并发冲突六条路径；配对算法：**在条目上方插行不触发确认**、改一个字触发、删掉重复的相同行之一触发（多重集合）；append 新建文件带 `source: agent`；hygiene 关时输出与 P0 golden 相等                                                                  | `tests/memory/hygiene/{guard,echo}.test.ts`、`tests/memory/tool-v2-hygiene.test.ts`、`tool-surface.test.ts` 预算                                                                   |
| P4  | 失效与整理：`doctor.ts`（D17–D19）、`doctor-command.ts`（启动提示 + 渲染端口传 compact 选项）、`command.ts`（分派）、`hygiene/{expire,expire-command,triggers-command}.ts`、`tidy/{prompt,diff}.ts`（仅 hygiene 开时的增量）                                                                                                                                                         | P1,P2                                         | D17–D19 规则与 ID 顺序；**D19 在 D02/D03 已触发时抑止**；D02 fix 文本（仅 hygiene 开）；启动提示指纹去重；`/mem expired` 四个选项 + `.trash` 恢复；`/mem triggers` 输出（per activation 口径、`new` 标记、secure 判断器状态）；doctor golden 刷新且 diff 只含 D02 fix 一处                                                                                               | `tests/memory/doctor.test.ts` 增补、`tests/memory/hygiene/{expire,expire-command,triggers}.test.ts`、`tests/memory/tidy*.test.ts` 回归                                             |
| P5a | 注入运行时（不含判断器）：`src/memory/recall/{wire,state,t1,t2,t3,format,renderer}.ts`、`src/memory/index.ts`（调用 `wireRecall`，预留 `judge?: RecallJudge` 端口）、`src/index.ts`（传 judge 回退模型）、`src/memory/inject.ts`（传 tiered 选项）                                                                                                                                   | P1,P2                                         | §2.1–2.3、2.5 全部行为；段内去重跨 /reload、resume、/tree；compaction 后重置并触发 T3；gate 闩锁跨 LLM 调用才放行（**同一批两个相同调用都被拦、只注入一次正文**；下一 turn 的重试放行；/reload 后播种为已放行）且异常时 fail-open；T3 受 maxSections 约束；`isStaticCore` 未渲染时退化为不跳过；T2a 剥 skill 块；子会话懒播种；off 时零注册；`activate-trace` 按声明刷新 | `tests/memory/recall/{state,t1,t2,t3,format,wire}.test.ts`、`tests/integration/memory-recall.test.ts`（fakePi 跑完整 session：注入→reload→compaction→T3）、`tests/governance` 刷新 |
| P5b | 判断器：`src/memory/recall/judge.ts` + 把端口接进 `recall/wire.ts`（P5a 合入后的最后一步，单处改动）。**开工前先读 `docs/dev/data-encryption/README.md`**，在包报告里写结论：新增的外发路径是「记忆目录 + 用户消息 → 便宜模型 provider」，secure 域强制关（O11）的落点和测试；P8 把 T2b 补进该 README 的 D8 强制关闭清单                                                             | P1,P2（实现）；P5a（接线）                    | 闸门 8 条逐条；异步不阻塞（fake clock 断言 `before_agent_start` 同步返回）；新 prompt 会 abort 旧调用；超时、failover、解析失败都 fail-open；次数和花费上限；令牌桶；不回退会话模型；secure 域下零接线且设置打不开                                                                                                                                                       | `tests/memory/recall/judge.test.ts`（fake port + fake clock）、判断器闸门表驱动测试（含「kw 命中但已去重仍不跑」）、`tests/memory/recall/judge-secure.test.ts`                     |
| P6  | 静态块：`src/memory/tiered.ts`（compact 目录行、剥离元数据）                                                                                                                                                                                                                                                                                                                         | P1                                            | 不传新选项时所有现有 tiered golden 逐字节不变；compact 与剥离的新 golden；I-M 属性测试在 compact 下仍成立                                                                                                                                                                                                                                                                | `tests/memory/tiered.test.ts` 增补、新 `tiered-golden/g3_*`                                                                                                                        |
| P7  | web UI：`src/web-hub/ui/src/components/transcript/entries.ts` 紧凑分支 + `src/web-hub/ui/src/logic/memMarker.ts`                                                                                                                                                                                                                                                                     | P1（details 形状冻结在 hygiene/contracts.ts） | 老 hub 加新 agent 显示为通用 custom 条目（不报错）；`npm run build:web && npm run check:web` 通过                                                                                                                                                                                                                                                                        | `tests/web-hub-ui/*` 对应单测                                                                                                                                                      |
| P8  | 文档与收尾：`docs/dev/memory/README.md`（hygiene/recall 不变式、新 hook 说明「memory 仅返回 message」）、`docs/guide/memory.md`、`docs/dev/data-encryption/README.md`（D8 清单补 T2b）、`skills/dev-flow/SKILL.md`（流程节点兜底一句）、全量回归。注明 **Q10（core 指针型条目清理）是上线后的手动流程**：主动注入观察有效后，由 agent 列出可删条目、用户逐条确认，不在本方案代码范围 | 全部                                          | `npm run format:check && npm run typecheck && npm test && npm run build`；`git diff origin/dev -- tests/fixtures/` 只出现 §5.3 声明过的文件                                                                                                                                                                                                                              | 全量                                                                                                                                                                               |

冲突点：`doctor-command.ts` 只归 P4（P6 只提供选项实现）；`src/memory/index.ts` 和 `src/index.ts` 只归 P5a；`contracts.ts` 只归 P1。P3 与 P4 都会读 `hygiene/entry-meta.ts`，但不改它。

每包按 dev-flow：返回后立即派验收（验收模型 ≠ 开发模型），通过后按精确路径 commit。

## 7. 风险与回滚

| 风险                                                                                        | 等级 | 缓解                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **注入噪音**：kw 太宽、T2b 乱选，污染上下文、抬高 token 成本                                | 高   | 段内去重、每条 ≤3 条目/4KB、段累计 30 条熔断；T2b 提示「宁缺毋滥」；`/mem triggers` 让用户看到每条规则；三期就是调优（Q3）                                      |
| pi 的排队语义变化（`_pendingCustomMessages` 刷出时机）                                      | 中   | P0 的 conformance 测试钉住；纳入 peer bump 时跑的 `tests/conformance`                                                                                           |
| gate 误拦，挡住正常操作                                                                     | 中   | 看过正文后的下一步原样重试即放行，本段不再拦；判定异常时 fail-open                                                                                              |
| 用户令确认框打断 agent（离开时卡到超时）                                                    | 中   | 默认 60s 超时视为拒绝，agent 收到明确文案；子会话、无 UI 直接拒绝，不挂起                                                                                       |
| T2b 费用失控                                                                                | 低   | 不回退会话模型；次数和美元双上限；令牌桶；可单独关 `judge.enabled`                                                                                              |
| tidy 模型吞掉元数据行或用户令                                                               | 中   | prompt 规则 + 预览标记；dry-run 由用户确认（不动事务层）                                                                                                        |
| 手写文件的正文编辑被确认框拦住（行为变化）                                                  | 低   | 只拦改动或删除已有条目；纯插入不拦；可关 hygiene                                                                                                                |
| secure 域：判断器把记忆目录发给便宜模型的 provider                                          | 低   | **已拍板 O11：secure 域强制关 T2b**（wire 阶段不接线，任何设置都打不开）；P5b 开工前读 data-encryption README 并写结论                                          |
| append 新建文件改为 `source: agent`（行为变化）：这类文件不再受手写保护，agent 可覆写、删除 | 低   | 只影响 agent 自己用 append 新建的文件，与 create 行为一致；删除走 `.trash` 可恢复；§9.1 向用户说明「agent 新建的文件归 agent」；想锁定就删掉 `source: agent` 行 |
| gate 同批绕过（v1 缺陷）                                                                    | —    | 已修：闩锁跨 LLM 调用才放行（§2.2），P5a 有同批用例                                                                                                             |

**回滚**：`memory.inject.enabled=false`（或 `memory.hygiene.enabled=false`）后 `/reload`，由 P0 golden 保证逐字节回到旧行为。代码层面每包独立 commit，可以按包 revert。数据层面元数据行就是 markdown 注释，功能关闭后作为普通文本保留，不需要迁移回滚。

## 8. 拍板记录（2026-10-29 已全部拍板）

| #   | 问题                                                   | 结论（已拍板）                                                                                                      |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| O1  | T2b 是否与 topic-switch 共用一次调用                   | **(a) 本期独立调用**。topic-switch 多数消息不触发、子会话没有、改它的判据会动到它评测过的准确率；以后可再做顺带     |
| O2  | T2b 是否允许有界同步等待                               | **(a) 纯异步、零等待**。纯问答那一轮看不到结果，下一轮才在上下文里                                                  |
| O3  | 判断器模型链是否回退会话模型                           | **(a) 不回退**。没有便宜模型就不跑 T2b                                                                              |
| O4  | 默认开关                                               | **(a) hygiene + inject 默认开**。回滚只需一个开关                                                                   |
| O5  | 手写文件（无 `source: agent`）的条目是否默认视为用户令 | **(a) 是**                                                                                                          |
| O6  | agent 修改用户令时的交互                               | **(a) 当场 `ctx.ui.confirm`**，用户同意即生效；拒绝、超时、子会话、无 UI 一律拒绝                                   |
| O7  | 事件型失效条件（`until`）是否进会话开始提示            | **(a) 不进**。只在 `/mem doctor`、`/mem expired` 里列为待确认                                                       |
| O8  | 外部 droid run 是否做主动注入                          | **(a) 本期不做**                                                                                                    |
| O9  | `/new` 新会话是否继承上一会话的注入条目                | **(a) 不继承**                                                                                                      |
| O10 | core.md 现有 bullet 规则的 kind 标注迁移               | **(a) 上线后由 agent 列出疑似用户令的行，用户逐条确认后加 `kind=user`**。这是上线后的操作流程，代码只提供语法与守卫 |
| O11 | secure 域是否强制关 T2b（评审 #6 新增）                | **强制关**。wire 阶段不接判断器，任何设置路径都打不开（同 I11/D8）；P5b 开工前读 data-encryption README 并写结论    |

Q10（core 指针型条目清理）与 O10 是两件事：Q10 是主动注入上线并观察有效后，由 agent 列出可删的指针型条目、用户逐条确认删除，属于**上线后的手动流程，不在本方案代码范围**（评审 #14）。

## 9. 给用户的技术讲解

> 这一节写给没读过代码的人：记忆怎么存、怎么改、怎么被系统主动送到模型眼前。以下按 2026-10-29 的拍板结果（§8 O1–O11）叙述：默认开启、手写文件算你的、改用户令当场弹框、判断器只用便宜模型并且在加密（secure）环境下关闭。

### 9.1 记忆是怎么管理的

**存在哪、长什么样**。每个项目有一个记忆目录 `~/.pi/agent/memory/<项目路径转写>/`，里面是若干 `.md` 文件。`core.md` 是每轮都会放进 system prompt 的核心规则，其余是专题文件（如 `pitfalls-git.md`）。每个文件开头有一小段 frontmatter，与以前相同：

```md
---
description: Git / GitHub 相关坑
read_when: push; 发版; 代理
source: agent # 有这行 = 归 agent；没有 = 归你（手写）
updated: 2026-10-29T11:00:00Z # 最后修改时间，doctor 据此判断陈旧
---
```

**新增的是「条目」这一层**。文件里每个 `## 小标题` 是一条记忆。小标题下第一行可以写一行注释，告诉系统这条记忆**什么时候该送到模型面前**、**是谁的规则**、**什么时候过期**：

```md
## GitHub 走代理

<!-- mem kind=lesson kw=push|发版 tool=bash arg="git push|gh release" -->

- push 前先 export https_proxy=…
```

| 字段                       | 含义                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `kind=user`                | 用户令：你下的命令、拍板、否决。只有你能作废                        |
| `kind=lesson`              | 经验坑：agent 踩过的坑，agent 可以自己改                            |
| `kw=发版\|push`            | 你的消息里出现这些词，就推送这条                                    |
| `tool=bash arg="git push"` | agent 要执行包含 `git push` 的 bash 命令时推送                      |
| `path=src/web-hub/**`      | agent 读或改这些文件时推送                                          |
| `gate`                     | 高危：不是事后提醒，而是在动作**执行前**拦一次，让 agent 先对照规则 |
| `expires=2026-11-30`       | 临时规则，到这天后系统提醒你确认删除                                |
| `until="pi 升到 1.5"`      | 按事件失效的临时规则（系统无法判断事件，只列出来请你确认）          |

core.md 里一行一条的规则，也可以在行尾写 `<!-- mem kind=user expires=… -->`，用来标权限和期限。这些注释在 markdown 预览里看不见，放进 system prompt 时也会被剥掉，不占预算。

**怎么写入**。agent 写记忆前先搜同主题条目，有就原地改，没有才新增。你下的令当场写；踩到的坑在任务收尾时写。写完后工具会返回三行，agent 必须转述给你：

```text
section: pitfalls-git.md › GitHub 走代理 (L12-18)
triggers: kind=lesson · kw=push|发版 · tool=bash arg=git push|gh release
similar: core.md › 发版规则 (L9)
```

觉得触发规则不对，直接让 agent 改。想看全部规则，跑 `/mem triggers`，本会话里 agent 新写或改过的条目会标 `new`，方便你核对它把哪些当成了你的令、哪些当成了经验。

**文件归谁**。agent 新建的文件（不管用 create 还是 append 新建）都会带上 `source: agent`，归 agent：里面的经验条目 agent 可以自己改，甚至删掉整个文件（删除会进 `.trash`，可恢复）。你手写的文件（没有 `source: agent` 这行）归你，里面的条目默认都算你的令。想把某个 agent 文件收归自己，删掉 `source: agent` 那一行即可。

**怎么修改、覆盖**。新令和旧令冲突时，agent 必须找到旧条并处置，不能只追加。如果旧条是**用户令**，agent 动它时系统会弹确认框：「agent 请求修改用户令：core.md › 派单规则，改前 / 改后……」。你点同意才写入，拒绝或 60 秒不理都视为拒绝。子 agent 不能改用户令。改完后 agent 会告诉你「已作废旧规则 X」。经验坑 agent 可以自己改。

**怎么失效、清理**。

- 带 `expires` 的条目到期后，下次开会话时会弹一行提示：`/mem doctor: 2 expired entries — run /mem expired to review`。
- 跑 `/mem expired` 会逐条问你：删除 / 延期 30 天 / 去掉期限 / 跳过。删除前会备份整个文件，可以 `/mem restore --trash` 恢复。**系统和 agent 都不会自动删除。**
- core.md 用到预算 80% 以上时同样会提示，建议你跑 `/mem tidy --dry-run` 先看整理方案。
- `/mem doctor` 能看到全部到期条目、语法错误（D17/D18/D19）。

**权限一览**：

| 操作                            | 你                   | 主会话 agent                     | 子 agent       |
| ------------------------------- | -------------------- | -------------------------------- | -------------- |
| 新增条目（含记录你的新令）      | ✅                   | ✅（回显给你）                   | ❌（默认只读） |
| 覆写或删除 agent 新建的整个文件 | ✅                   | ✅（文件里有用户令时仍需你确认） | ❌             |
| 修改或删除经验坑                | ✅                   | ✅                               | ❌             |
| 修改或删除用户令                | ✅                   | 需你在确认框同意                 | ❌             |
| 删除到期条目                    | ✅（`/mem expired`） | ❌（只能提醒你）                 | ❌             |

### 9.2 记忆是怎么被主动送到模型面前的

以前只有 core.md 每轮都在，专题文件要靠模型「自己想起来去读」，实测派单十几次一次都没读。现在系统在四类事件上主动推送：

| 层         | 挂在哪个事件                                       | 看什么                                                | 注入落在哪                                                  |
| ---------- | -------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| T1 动作    | agent 每次调用工具之前（`tool_call`）              | 工具名、命令内容、文件路径，对照 `tool/arg/path`      | 普通条目：紧跟在这次工具结果之后；gate 条目：先拦下这次调用 |
| T2a 关键词 | 你发出消息、模型开始回答前（`before_agent_start`） | 你的原话，对照 `kw`                                   | 紧跟在你的消息之后，与你的消息一起发给模型                  |
| T2b 判断器 | 同上，但只在**没有任何关键词命中**时               | 用一个便宜的小模型看你的话和「记忆目录」，挑最多 3 条 | 后台跑约 2 秒，不让你多等；结果出来后插进当前回答的下一步   |
| T3 边界    | 上下文被压缩或 switch_context 之后                 | 上一段上下文里推送过的条目                            | 新一段开始时重新推送一次（因为旧上下文已经没了）            |

**gate 怎么放行**：被拦下后，模型要先在下一步看到规则正文，之后重试才会放行；同一时刻并发发出的相同操作会一起被拦。

**冷却**：同一条记忆在同一段上下文里只推一次；压缩或 switch_context 之后重新计数。/reload、恢复会话都不会重复推送（系统在会话记录里留了不进上下文的小记录）。每次推送最多 3 条、4KB。已经在 core 里的条目不重复推。

**你能看到什么**：对话里会出现一行灰色标记，例如 `── mem T2a: pitfalls-git › GitHub 走代理 ──`，按 ctrl+o 展开才有正文（web 界面同样一行，点开看正文）。模型看到的是完整正文，并被告知「这是项目数据：用户令必须遵守，经验仅供参考」。

**花多少钱**：T1/T2a/T3 是纯本地匹配，零成本。T2b 每次约 0.03–0.1 美分（用便宜模型，不用当前会话模型），每个会话最多 40 次、0.2 美元封顶（按一次启动计，`/reload` 后重新计数）。在加密（secure）环境里 T2b 直接关闭，不会把记忆发给任何额外的模型。

### 9.3 端到端实例

**实例 1：你（主会话）调 Agent 派单时发生什么**

前提：`pitfalls-subagent.md` 里有

```md
## 派单模型路由

<!-- mem kind=user tool=Agent arg="model:" gate -->

- 派单指定模型须按 dev-flow 路由表……
```

`pitfalls-git.md › GitHub 走代理` 带 `kw=push tool=bash arg="git push"`；`pitfalls-runtime.md › 长命令一律 timeout` 没有写触发规则（旧条目）。

1. 主会话模型调用 `Agent({subagent_type:"general-purpose", model:"…", description:"修预览卡死", prompt:"修复 web-hub 预览里 mermaid 渲染卡死的问题，改完跑相关测试并提交"})`。
2. 主会话的 `tool_call` hook 把参数拼成规范串，里面有一行 `model:…`（显式传了 model 参数）⇒ 命中 gate 条目，且尚未放行。如果没传 model，规范串里没有 `model:` 这一行，就不会命中。
3. 系统拦下这次派单。模型收到工具错误 `[memory gate] 本次 Agent 调用未执行：它命中了记忆中标为 gate 的规则「pitfalls-subagent.md › 派单模型路由」……`；本 turn 结束时，一条 `[memory]` 消息带着条目正文落地。你在界面上看到一行 `── mem T1 gate: pitfalls-subagent › 派单模型路由 ──`。如果模型在同一步里并发发了两个相同派单，两个都会被拦，正文只推一次。
4. 下一步，模型看过正文、对照路由表改了模型后重新派单。这次是在注入落地之后，放行，派单成功，本段内这条不再拦。
5. 子 agent 会话启动。它没有 `session_start`，系统在它第一次 `before_agent_start` 时从分支播种。派单 prompt 里**没有**任何关键词命中（不含「push」「发版」等），所以 T2a 不注入，T2b 判断器在后台启动（子 agent 开始干活，不等它）。
6. 约 2 秒后判断器从记忆目录里挑出 `pitfalls-runtime.md › 长命令一律 timeout`（这条没写触发规则，但它的标题和摘录在目录里）。结果排在子 agent 第一轮工具调用的结果之后，第二次 LLM 调用就能看到。这就是 Q9「补上派单 prompt 漏写的禁令」，也说明旧条目不写规则也能被召回。
   - 对照：如果派单 prompt 写的是「……改完 git push」，「push」命中 T2a，`GitHub 走代理` 立即贴在任务后面，**本轮就不跑判断器**（关键词命中则不兜底）。
7. 子 agent 之后执行 `git push` 时，子会话的 `tool_call` hook 命中 `GitHub 走代理` 的 T1 规则。如果本段还没推过，就排在这次工具结果之后推送；推过了就不重复。如果某条命中的是 gate，同样先拦一次（子会话有自己独立的「段」）。
8. 你的派单 prompt 原文没有被改动。子 agent 的注入记录在它自己的会话里，web 的 run 详情能看到标记。

**实例 2：你说「发版」时发生什么**

前提：`core.md` 里有 `## 发版规则` 小节（`kind=user kw=发版 tool=bash arg="release.sh|git tag" gate`），`pitfalls-git.md › GitHub 走代理`（`kw=发版|push`）。

1. 你输入「发版」。在模型开始回答前，`before_agent_start` 拿到你的原话。
2. T2a：「发版」命中两条。`core.md › 发版规则` 已经在 system prompt 里，跳过；`GitHub 走代理` 不在，于是作为一条 `[memory · T2a kw「发版」]` 消息贴在你的消息后面，一起发给模型。界面多一行 `── mem T2a: pitfalls-git › GitHub 走代理 ──`。
3. 因为 T2a 已有命中，T2b 不跑，零成本。
4. 模型按流程准备发版，调用 `bash("scripts/release/release.sh 0.9.3")`。
5. T1：`tool=bash` 加 `arg` 包含 `release.sh` ⇒ 命中 `core.md › 发版规则` 的 gate。虽然它在 core 里，gate 仍然会拦，并把正文再推一次，让模型在动作前对照。模型看到「发版前须确认 GitHub CI 绿」，先跑 `gh run list` 确认，或者问你。
6. 确认后模型在下一步原样重试 `release.sh`。这时注入正文已经落地，放行。
7. 如果中途做了 switch_context，新一段开始时 T3 会把「GitHub 走代理」重新推一次；gate 在新段里若再遇到 `release.sh` 也会再拦一次。

**实例 3：你下了一条临时令**

1. 你说「11 月底前派单都不要用 X 模型」。
2. agent 先搜「派单 模型」，找到 `core.md` 里一条旧用户令「派单可用 X」（这一行已按 O10 迁移标了 `kind=user`），与新令冲突。
3. agent 用 str_replace 把旧行改成新令，行尾写 `<!-- mem kind=user expires=2026-11-30 -->`。因为改动的是用户令，系统弹确认框，你点同意。
4. 工具返回 `voided user rule: core.md:L7` 和 `triggers: kind=user · expires 2026-11-30`。agent 在回复里告诉你：「已作废旧规则『派单可用 X』；新规则 11-30 到期」。
5. 12 月 1 日开会话时，你看到 `/mem doctor: 1 expired entry — run /mem expired to review`。跑 `/mem expired`，选「删除」，这条规则被移除（有备份）。

## 10. 评审 r1 处置表

| #   | 严重度 | 处置     | 落点或理由                                                                                                                                                                                                                                           |
| --- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 严重   | 采纳     | §2.4 闸门③定为「本轮有任何 kw 命中（含被去重滤掉的）就不跑判断器，主会话和子会话首轮都不设例外」；§9.3 实例 1 改为派单 prompt 无 kw 命中时展示 T2b，并加一条「含 push 则 T2a 命中、不跑 T2b」的对照；§9.2 表同步                                     |
| 2   | 严重   | 采纳     | §2.2 新增「gate 闩锁」：记录被拦时的 `turnSeq`，`turnSeq` 前进（注入已在 turn_end 刷出）后才放行；同批相同调用全拦、只注入一次正文；播种出的记录视为已放行。P5a 测试清单加同批用例；gate 文案与 §9 同步                                              |
| 3   | 严重   | 采纳     | §3.3 D19 只看 core，并在 D02/D03 已触发时抑止，删去「整块 ≥80%」（渲染器本就填满块，会常驻误报）；⑤ 的 tidy 提示改由 D02 fix 承载；§5.3 改为「doctor golden 确定刷新」，原因是 D02 行多出 fix 文本，且仅此一处                                       |
| 4   | 一般   | 采纳     | §3.2 规格化配对算法：内容 hash 优先，多重集合计数，行号只作同 hash 候选的次序参考；§1.4 注明行级 key 不用于配对；P3 验收加「条目上方插行不触发确认」等三例                                                                                           |
| 5   | 一般   | 采纳     | T3 不豁免，与 T1/T2 同受 `maxSections`/`maxBytes` 约束（§2.1、§2.5），`/mem triggers` 只显示这一口径                                                                                                                                                 |
| 6   | 一般   | 采纳     | §8 补 O11（已拍板：secure 域强制关 T2b）；§2.4 闸门⑧、§5.1 设置说明、§7 风险表同步；P5b 开工前读 `docs/dev/data-encryption/README.md` 并写结论，P8 把 T2b 补进 D8 清单                                                                               |
| 7   | 一般   | 采纳     | §3.1 写明这是行为变化；§7 风险表新增一行（低）；§9.1 新增「文件归谁」一段，权限表加一行                                                                                                                                                              |
| 8   | 建议   | 采纳     | 次数和花费上限按 activation 计、/reload 清零，接受这个窗口；写进 §2.4 闸门⑥、§5.1 设置说明、`/mem triggers` 和 §9.2                                                                                                                                  |
| 9   | 建议   | 部分采纳 | 剥掉 pi 的 `<skill …>…</skill>` 展开块后再匹配（SKILL.md 正文必然大面积误命中）；prompt 模板展开保留，因为模板是用户自己定义的快捷说法，展开内容即意图。不改用 `input` 原文：要多注册一个 hook，而且与 topic-switch 吞掉再重投的时序难以对齐（§2.3） |
| 10  | 建议   | 采纳     | §2.1：复用 `memorySection` 的 `onRender` 回调（P5a 加可选参数带 `omittedSections`），未渲染过时退化为「不跳过」                                                                                                                                      |
| 11  | 建议   | 采纳     | §1.2 规范串改为带字段名的 `key:value` 行；实例 1 规则改为 `arg="model:"`，并说明不传 model 时不命中                                                                                                                                                  |
| 12  | 建议   | 采纳     | 拍板已完成：§8 改为拍板记录；§9 开头注明按拍板结果叙述，正文不再出现「推荐」假设                                                                                                                                                                     |
| 13  | 建议   | 采纳     | §3.2 记为固有缺口；`/mem triggers` 对本会话 agent 新写或改过的条目标 `new`，并单列「agent 新写的 lesson」；§9.1 告诉用户如何核对                                                                                                                     |
| 14  | 建议   | 采纳     | §8 表后与 P8 均注明：Q10 是上线后的手动流程，不在本方案代码范围；并与 O10（kind 标注迁移）区分开                                                                                                                                                     |
