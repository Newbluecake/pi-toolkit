# 源码治理低风险批 · 实施方案（①②③⑥）

> 基线 `dev@b667d880`（2026-10-25）。输入：`docs/dev/source-governance/analysis.md`（#30）。只写方案，不改代码。
> 本批 = 分析 Top10 的 ① AGENTS.md 瘦身拆分、② 零风险去重小包、③ 死代码清理、⑥ 目录归属修正 + pi-free 边界测试；④⑤⑦–⑩ 不在本批。

**修订记录**

- r1（2026-10-25）：初版。
- r2（2026-10-25）：处理评审（gpt-6.1-sol）提出的 9 条意见。#1 不再与 #40 并行，本批整批先合，#40 blockedBy P1，冻结面改为按提交逐个检查（§5、附录 A、§1.7）；#2 redactSecrets 旧位置的两份测试导入并入 P2（§2.1）；#3 `raceDeadline` 保留原实现，Q2 作废（§2.3、§7）；#4 守恒检查改为按块清单完整比对，并给关键全局规则加独立断言（§1.8、§1.11、附录 C）；#5 command-capture 迁出 agent 后仍受 hub 导入守卫约束，并加负向自测（§4.2 B3）；#6 逐个重解析迁移测试的相对导入（§4.1 附表）；#7 M1 处理源码字符串里的旧路径，验收区分接线测试和真实加载门禁（§4.1、§4.4）；#8 死代码证据命令排除两份治理清单（§3.1）；#9 B1 改用 TypeScript AST 扫描并补自测（§4.2 B1）。
- r2.1（2026-10-25，主会话）：复审有条件通过（7/9 闭合），收口剩余两条验收文字：附录 C 新增 A0 文件头块、A1 只覆盖 What this is 前三段（复审 #4）；§4.4 变异验证第 5 项按新旧位置给出不同的 hub registry 相对路径（复审 #5）。

## 0. 需求摘要

1. **①** AGENTS.md（157 KB，每个会话全文注入）拆成「全局不变式 + 冻结物表 + peer bump 检查单 + 目录→README 表」，目标 ≤30 KB；子系统细节**原文搬运**到 `docs/dev/<x>/README.md`，表里写清路径和「何时读」，agent 引导作用不能丢。
2. **②** 只合并逐字节相同或语义相同的副本：`redactSecrets`（2 份）、`isTerminalStatus`（ui 那份）、hub 内的 promise 超时（4 份里收敛 3 份，`raceDeadline` 不动）。错误形状和微任务时序都逐字保留。
3. **③** 只删高置信度的死导出（37 个别名 + 约 26 个零引用函数 + 1 个不可达 stub 文件）；有文档引用或在边界钉死文件里的列为观察。
4. **⑥** 4 组纯移动（cache-keepalive 服务、bash 两个工具、context-switch/compact 三个工具、command-capture），再补一个 pi-free 边界测试，把 hub 白名单里 type-only 的 `config/settings.ts` 收紧成「只许 type 导入」。
5. **硬约束**：行为零变化（不改设置键、wire、tool schema）；冻结面不动（每个治理提交自身的 `git diff <包开工时 HEAD>..<commit> -- tests/fixtures` 为空）；不碰运行时旧名；hub 边界只能收紧；不改 consult 代码（#40 在本批全部合入后才开工）；避开 #43 的文件（`src/secure/bin/convert.mjs`、`tests/secure/convert-*.ts`、`tests/integration/traffic-lifecycle-process.test.ts` 和它新增的子进程测试）。

---

## 1. ① AGENTS.md 瘦身拆分

### 1.1 原则

- **搬运，不改写**：下沉内容逐字从 AGENTS.md 拷到 README（允许的改动只有：去掉列表项的两格续行缩进、加标题和来源头、跑一遍 prettier）。这样信息不会丢，也不会引入新的「规则」。
- **AGENTS.md 只留对所有任务都成立的内容**：What this is（第 1–3 段原文保留）、Commands、全局不变式、冻结物表、peer bump 检查单、目录→README 表、Conventions、pi-extension 易错点、Testing expectations、Releasing（原文保留）。
- **按需读取**：pi 只从 cwd 和父目录加载 `AGENTS.md`（`docs/configuration.md` § Context files），所以子目录 AGENTS.md 不会被自动注入。README 放在 `docs/dev/<x>/README.md`，靠 AGENTS.md 顶部的硬规则 + 表格「必读」列引导 agent 按需 read。
- **切片按标记，不按行号**：#43、#40 都可能在合入前改 AGENTS.md。切片脚本必须用条目起始标记定位（``- `src/<x>/` —``，以及 web-hub 内的 `**<小节名>` 标记），在**合入时的最新 AGENTS.md** 上重跑。下文行号只是 `b667d880` 时的参考值。

### 1.2 新 AGENTS.md 结构与体量预算

| 节                              | 内容                                                                                                                                                                                                                                                                                                                                      | 预算   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 头部硬规则                      | 「改动 `src/<x>/**`（含其测试、设置键、wire 字段）前，先 read 下表『必读』列的 README；README 里是该子系统的不变式、门禁和残留风险。表外的设计细节在 `docs/dev/<feature>/`。」                                                                                                                                                            | 0.4 KB |
| What this is                    | 原第 1、2、3 段（产品定位、零挂起、改名保留旧名）**原文保留**（r2：不压缩，避免守恒例外）；第 4 段「eight merged plugins」整段原文下沉到 plugin-merge README，它包含的 pre/post-guard 事实另由不变式 I3 概括                                                                                                                              | 1.8 KB |
| Commands                        | 原样                                                                                                                                                                                                                                                                                                                                      | 1.1 KB |
| **Global invariants**（I1–I12） | 见 §1.3，每条 1–3 行，全部摘自现有文本                                                                                                                                                                                                                                                                                                    | 5 KB   |
| **Frozen artifacts**            | 见 §1.4 表                                                                                                                                                                                                                                                                                                                                | 2 KB   |
| **pi peer bump checklist**      | 见 §1.5，替代原来散在 8 处的提醒                                                                                                                                                                                                                                                                                                          | 1.5 KB |
| **Repository layout**（表）     | 46 行：`路径 \| 职责（≤1 行）\| 必读 README · 何时读`；见 §1.6。`index.ts`/`index.js`/`skills/`/`src/index.ts`/`src/stack.ts`/`git`/`config`/`child`/`goal`/`reload`/`delivery`/`adapters`/`tools…`/`tests`/`docs/dev`/`scripts/release` 这些短条目原文进表，不下沉；补上从未登记的 `src/date/`、`src/title/`、`src/vendor/`（分析 §5.3） | 9 KB   |
| Conventions                     | TS strict / Prettier / UI 文本语言规则 / Conventional Commits / typebox peer 原文保留；peer 范围那条保留到「reaches `verified`.」为止的原文，后面的 traffic 前提、cmd-history 前提两段原文分别下沉到 traffic README 和 web-hub README，原处补一句「详见 §pi peer bump checklist」                                                         | 2.5 KB |
| pi-extension specifics          | 原样（jiti 源码加载、/reload 同进程重激活与模块级状态禁令、子会话 inert、unref timer）                                                                                                                                                                                                                                                    | 1.3 KB |
| Testing expectations            | 原样                                                                                                                                                                                                                                                                                                                                      | 0.4 KB |
| Releasing                       | **原样**（分支铁律、过渡规则、版本规则、CHANGELOG 生成、流程、flags）                                                                                                                                                                                                                                                                     | 3.6 KB |
| 合计                            |                                                                                                                                                                                                                                                                                                                                           | ≈28 KB |

上限 30 KB；由 §1.8 的测试卡 32 KiB 硬线（留 2 KB 余量，防止下一个功能 PR 一加就红）。

### 1.3 全局不变式清单（I1–I12，全部从现有 AGENTS.md 摘出，不新增规则）

| #   | 不变式                                                                                                                                                                                                                                                                                                                                                            | 来源（现 AGENTS.md）                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| I1  | 零挂起：每个 run 有分层截止（watchdog 子阶段 + 总预算）、升级 reaper、可确认的持久投递；任何截止值都要过 `clampSpanMs`，长延时走 `createSegmentedClock`                                                                                                                                                                                                           | What this is、core 条目                 |
| I2  | `src/index.ts` 只做组装（I7）；`src/stack.ts` 每次 `session_start` 重建会话栈                                                                                                                                                                                                                                                                                     | index/stack 条目                        |
| I3  | HOST_KEY 守卫：`initSecureDomain()` 是 `activate()` 第一条语句；pre-guard（子会话也有）= secure guards、command capture、web_search、date、todo、prompt-section hub、memory、子会话接线（`wireChildSession`/bash child/traffic 录制钩子）；其余（hud、feishu-notify、session-nav、ask_user、title、topic-switch、web-hub、schedule、traffic host 面等）只在主会话 | What this is、secure/traffic/child 条目 |
| I4  | 不留模块级可变状态（`/reload` 同进程重激活，不清模块缓存）；跨激活共享只用 `Symbol.for("pi-subagent:*")` 全局，并写明容量/TTL                                                                                                                                                                                                                                     | pi-extension specifics、core 条目       |
| I5  | 所有 timer `unref()`（ref'd timer 会卡住 `pi -p`）                                                                                                                                                                                                                                                                                                                | pi-extension specifics                  |
| I6  | 子会话保持 inert；子会话扩展只从 settings.json 发现（用 `pi install`，不要 `-e`）                                                                                                                                                                                                                                                                                 | runtime 条目、pi-extension specifics    |
| I7  | 运行时旧名不改：`pi-subagent.json`、`Symbol.for("pi-subagent:*")`、`subagent:*` customType/事件、widget/status key、`[pi-subagent]` 日志前缀                                                                                                                                                                                                                      | What this is                            |
| I8  | pi-free 边界：`src/core`、`src/prompt-sections`、`src/git` 不导入 pi（由 `tests/boundary/pi-free.test.ts` 守，⑥ 新增）；hub/protocol 只导入 `node:*`、typebox 和白名单文件（`tests/web-hub/boundary.test.ts`），**白名单只收紧不放宽**，需要共享时在 `web-hub/protocol/` 放镜像副本                                                                               | core/git/web-hub 条目                   |
| I9  | 设置门控的功能关闭时字节不变，由 §冻结物表中的 golden 证明；非 live 设置要 `/reload`（hub 侧再加 `/webhub restart`）                                                                                                                                                                                                                                              | 各条目反复出现                          |
| I10 | wire/状态槽只做追加：`StatusInfo` 开放槽、可选 frame 字段、cap 门控，不升 PROTO；旧 hub/旧 agent 组合必须字节不变                                                                                                                                                                                                                                                 | web-hub/fabric 条目反复出现             |
| I11 | secure 域：D2/D3/D4 守卫、D8 强制关闭的功能不能被任何设置路径重新打开                                                                                                                                                                                                                                                                                             | secure 条目                             |
| I12 | 工具机制写在 tool/参数描述里，策略写在 `skills/`（skills 是唯一来源，不在 `~/.agents/skills/` 留副本）                                                                                                                                                                                                                                                            | skills 条目                             |

### 1.4 冻结物表（新 AGENTS.md 里的一张表）

| 等级                                       | 文件                                                                                                                                                                                                                                                                                                                                                                         | 规则                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A 永不重生                                 | `tests/fixtures/{fabric-xs-off,fabric-wake-off,fabric-xs-reply-off}-golden.json`、`compact-hint-golden.json`、`schedule-off-golden.json`、`secure-off-golden.json`、`secure-contract-parity.json`、`web-hub-ui/keepalive-legacy-golden.json`、`bash-tools-golden.json`（测试在文件已存在时拒绝 `UPDATE_BASH_GOLDEN`）、`tests/fixtures/legacy-xs-v071/`（prettier 也不许碰） | 改了就说明行为变了；重构必须让它们保持不变                     |
| A′ 只许 USAGE 变化                         | `tests/fixtures/secure-launcher-off-golden.json`                                                                                                                                                                                                                                                                                                                             | 只在 launcher USAGE 文本有意改动时更新                         |
| B 契约 golden（改动 = 有意的对外行为变化） | `available-models-golden.txt`、`feishu-spawn-http-golden.json`、`memory-legacy-golden.json`、`message-agent-wake-schema-golden.json`、`quota-kimi-zai-golden.json`、`tools/agent-nested-surface-golden.json`、`memory/{tiered,doctor}-golden`、`web-hub-ui/quota-legacy-golden.json`、`version/version-anchor-golden.html`、`quota/topbar-no-quota-golden.html`              | 只有在 PR 明确声明对外行为变化时才更新，并在 commit 里写明原因 |
| C 按规则刷新                               | `preview-denylist-corpus.json`（必须同时 bump `PREVIEW_DENYLIST_VERSION` 并跑 `node scripts/dev/preview-denylist-audit.mjs`）；`docs/dev/preview-perf/baseline*.json`（只能由 `npm run probe:preview-perf --write-baseline` 生成）                                                                                                                                           | 按各自规则                                                     |

> 实施者核对：A/A′/B 的归类以现有 AGENTS.md 和各 golden 测试文件头注释为准；B 档里有文件头写了 "never regenerate" 的就升到 A 档。不要凭印象归类。

### 1.5 peer bump 检查单（新 AGENTS.md 里的一节，替代散落的 8 处）

1. `package.json` 的 pi peer 范围（当前 `>=1.0.0 <1.4.0`）只能有意识地改；同时复查 `src/adapters/pi-compat.ts`。
2. 跑 `npm run test:conformance`（= `vitest run tests/conformance`，整个目录）。该目录包括：context-switch capability、consult-preserve C1–C7（**#40 移除 consult 时删掉这一项**）、fabric-wake C-P1–C-P5、fabric-xs C-X1–C-X11、schedule C-S1–C-S8（C-S6 没有 tsx 会 skip）、traffic + traffic-coexist、cmd-history、slash-args、rpc-spawn、keepalive-pipeline、web-resume、secure-gocryptfs C1–C5（自门控）等。各套件守的前提写在对应 README 里。
3. 升级 pi 或 droid 前额外跑 `PI_TOOLKIT_DROID_CONFORMANCE=1 npx vitest run tests/conformance/droid-protocol.test.ts`；升级 gocryptfs 前跑 `tests/conformance/secure-gocryptfs.test.ts`。
4. 确认冻结物 A 档没有变化：`git diff --quiet origin/dev -- tests/fixtures/`。

### 1.6 目录 → README 映射（下沉清单）

「来源」列是 `b667d880` 时的参考行号；实际以条目起始标记定位。新建 = 该目录还没有 README；追加 = 已有用户向 README，在文末加一节 `## 开发者要点（自 AGENTS.md 下沉）`，并在文件开头加一行指向它。

| AGENTS.md 条目 / 小节                                                                                                                                                                                                                                                            | 来源（参考行）                                                  | 目标 README                                                                                                       | 约体量  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `src/core/`、`src/runtime/`、`src/service/`                                                                                                                                                                                                                                      | 86–139                                                          | `docs/dev/subagent-core/README.md`（新建目录）                                                                    | 5.4 KB  |
| `src/ask-user/`                                                                                                                                                                                                                                                                  | 140                                                             | `docs/dev/ask-user-async/README.md`（新建）                                                                       | 1.0 KB  |
| What this is 第 4 段（合并插件总览，含 traffic 的括号细节和 pre/post-guard 说明）、`src/feishu-notify/`、`src/hud/`、`src/web-search/`                                                                                                                                           | 28–47、141、504–511                                             | `docs/dev/plugin-merge/README.md`（新建）                                                                         | 3.5 KB  |
| `src/bash/`                                                                                                                                                                                                                                                                      | 142–152                                                         | `docs/dev/bash-timeout-grace/README.md`（新建）                                                                   | 1.0 KB  |
| `src/compact-hint/`                                                                                                                                                                                                                                                              | 153–175                                                         | `docs/dev/compact-hint/README.md`（新建）                                                                         | 2.1 KB  |
| `src/context-switch/`（含子会话 switch_context）                                                                                                                                                                                                                                 | 176–195                                                         | `docs/dev/context-switch/README.md`（新建）                                                                       | 1.9 KB  |
| `src/cache-ttl/`                                                                                                                                                                                                                                                                 | 196–268                                                         | `docs/dev/cache-ttl-keepalive/README.md`（新建）                                                                  | 7.7 KB  |
| `src/fabric/`（in-tree、wake phase 1、xs phase 2、reply、channels、aliases）+ web-hub 内「Channels in the web UI」「Aliases in the web UI」两小节                                                                                                                                | 274–460、906–922                                                | `docs/dev/fabric-cross-session/README.md`（新建，顶部 ToC）                                                       | 24.8 KB |
| `src/consult/`                                                                                                                                                                                                                                                                   | 461–503                                                         | `docs/dev/consult/README.md`（新建；首行横幅「本文件由 #40 移除 consult 子系统时整体删除」）                      | 4.5 KB  |
| `src/todo/`                                                                                                                                                                                                                                                                      | 512–520                                                         | `docs/dev/todo-web/README.md`（新建）                                                                             | 0.8 KB  |
| `src/memory/`                                                                                                                                                                                                                                                                    | 521                                                             | `docs/dev/memory/README.md`（新建）                                                                               | 3.1 KB  |
| `src/sysprompt/` + `src/prompt-sections/`                                                                                                                                                                                                                                        | 522–552                                                         | `docs/dev/sysprompt-stable/README.md`（新建）                                                                     | 3.2 KB  |
| `src/session-nav/`                                                                                                                                                                                                                                                               | 553–569                                                         | `docs/dev/web-resume/README.md`（新建）                                                                           | 1.6 KB  |
| web-hub 主体：开头概述 + P2 control + Web resume、UI serving、LAN access、LAN security、四个面板（worktree/bash-jobs/archive/cache keepalive）、Avatar、Privacy、Session switching、`prompt-gate.ts`、Slash-arg、Command history；外加 Conventions 里 cmd-history 的六条 pi 前提 | 570–613、655–694、745–769、888–905、923–930、951–999、1263–1270 | `docs/dev/web-hub/README.md`（新建，顶部 ToC + 指向下面 5 份子 README 的索引）                                    | ≈24 KB  |
| Feishu bot + Cross-session mirror                                                                                                                                                                                                                                                | 614–654                                                         | `docs/dev/feishu-bot/README.md`（**追加**）                                                                       | 6.0 KB  |
| Managed spawn、Created dirs、Restore、Relaunch、Delete session、Session history                                                                                                                                                                                                  | 695–744、931–951（到 `**\`prompt-gate.ts\`**` 之前）            | `docs/dev/web-hub-spawn/README.md`（新建）                                                                        | 9 KB    |
| Content preview（Admission/Upload/Directories）、Preview multi-windows、Chunked、Large-source virtualization、HTML preview                                                                                                                                                       | 770–813                                                         | `docs/dev/web-hub-preview/README.md`（新建）                                                                      | 7 KB    |
| Worktree diff、Worktree graph                                                                                                                                                                                                                                                    | 814–857                                                         | `docs/dev/worktree-diff/README.md`（新建；在 `docs/dev/worktree-graph/` 不另建，只在表里写两个路径都读这一份）    | 6.5 KB  |
| Local-service proxy、In-page link preview                                                                                                                                                                                                                                        | 858–887                                                         | `docs/dev/web-hub-proxy/README.md`（新建）                                                                        | 3 KB    |
| `src/topic-switch/`                                                                                                                                                                                                                                                              | 1000–1030                                                       | `docs/dev/topic-switch/README.md`（新建）                                                                         | 2.9 KB  |
| `src/external-agent/`                                                                                                                                                                                                                                                            | 1034–1056                                                       | `docs/dev/external-agent/README.md`（**追加**）                                                                   | 2.7 KB  |
| `src/quota/`                                                                                                                                                                                                                                                                     | 1057–1075                                                       | `docs/dev/quota/README.md`（新建）                                                                                | 2.3 KB  |
| `src/sysload/`                                                                                                                                                                                                                                                                   | 1076–1091                                                       | `docs/dev/sysload/README.md`（新建）                                                                              | 1.8 KB  |
| `src/secure/`                                                                                                                                                                                                                                                                    | 1092–1093                                                       | `docs/dev/data-encryption/README.md`（新建）                                                                      | 8.3 KB  |
| `src/traffic/` + Conventions 里 traffic 的 conformance 前提（`**Also run \`tests/conformance/traffic.test.ts\``起，到 `**Also run \`tests/conformance/cmd-history.test.ts\`**` 之前）                                                                                            | 1094、1254–1263                                                 | `docs/dev/traffic-merge/README.md`（新建；开头链接 plugin-merge README 的合并总览）                               | 4 KB    |
| `src/schedule/`                                                                                                                                                                                                                                                                  | 1095–1145                                                       | `docs/dev/scheduled-reports/README.md`（新建）                                                                    | 7.2 KB  |
| `src/workflow/`                                                                                                                                                                                                                                                                  | 1156–1220                                                       | `docs/dev/workflow/README.md`（新建目录，链接到 workflow-background/agent-queue/experts/worktree 四个 plan 目录） | 7 KB    |

每块内容在目标 README 里单独占一个章节，章节标题、源标记和例外见附录 C，守恒检查按这份清单逐块比对。README 统一头部：

```markdown
# <子系统> · 开发者要点

> 何时读：改动 `src/<x>/**`、它的测试、`<settings 前缀>.*` 设置键或相关 wire 字段之前。
> 来源：AGENTS.md@<合入时的 base sha> 的 `src/<x>/` 条目，原文搬运，未改写。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：<plan / report / acceptance 链接列表>
```

AGENTS.md 表格「必读」列的写法：`docs/dev/cache-ttl-keepalive/README.md · 动 keepalive/断路器/TTL 前`。web-hub 那一行写：「`docs/dev/web-hub/README.md`（索引）；动 spawn/preview/feishu/worktree diff·graph/proxy 时另读对应子 README」，并且在 `src/web-hub/hub/feishu/`、`hub/spawn/`、`hub/preview/` 等子目录加缩进子行，各自直接指向子 README。

### 1.7 与 #40、#43 的配合（r2：按主会话裁定改写）

- **#40 不并行**：本批整批（P6B→P2→P3→P6M→P1）全部合入后，#40 才以新布局重新核对方案并开工；#40 的所有包 blockedBy 本批 P1 合入，它的文件域届时由作者更新。
- **consult 文档口径**：P1 把 AGENTS.md 的 `src/consult/` 条目**整段**下沉到 `docs/dev/consult/README.md`，首行加横幅「本文件由 #40 移除 consult 子系统时删除」；AGENTS.md 目录表留一行 `src/consult/`，必读列指向该 README，并标「#40 将删除」。#40 的 PS2 相应改为「删除 `docs/dev/consult/README.md` 和目录表里的这一行」。其他条目里顺带提到 consult 的句子（runtime 的 consult fork 豁免、fabric 的 `wakeExclusion: consult fork`、secure 的 `consultSessionDir()`、workflow 的 `experts`、peer bump 检查单里的 consult-preserve）跟着各自条目原样下沉，不删。P1 交付报告附 `rg -n -i consult AGENTS.md docs/dev/*/README.md` 的结果，作为 #40 的删除清单。
- **#43**：当前只改 `src/secure/bin/convert.mjs`、`tests/secure/convert-*.ts`、`tests/integration/traffic-lifecycle-process.test.ts`，以及一个新增的子进程测试（`tests/secure/convert-lease-wait.process.test.ts`）。本批的文件域都不和它们相交（附录 A）。#43 如果在 P1 之前改了 AGENTS.md 的 secure 条目，P1 合入时在最新 AGENTS.md 上重跑切片即可。P1 不碰 `docs/dev/data-encryption/` 下除 README.md 以外的文件。

### 1.8 新增守卫测试 `tests/docs/agents-md.test.ts`（Q6 已决：做）

体量只是上限，主要价值在关键规则的**独立断言**。测试读取新 AGENTS.md，按 `## ` 标题切成节；每条断言都限定在节内，不是全文 grep。

| #   | 断言                                                                                                                                                                                                                                                                                                                                                                                                  | 守的是                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| K0  | 文件字节数 ≤ 32 768                                                                                                                                                                                                                                                                                                                                                                                   | 体量上限                                  |
| K1  | 前 1 500 字节里有「先 read 下表『必读』列的 README」这条硬规则原句                                                                                                                                                                                                                                                                                                                                    | 按需读取入口                              |
| K2  | 「pi peer bump checklist」节含 `npm run test:conformance` 和 `PI_TOOLKIT_DROID_CONFORMANCE=1`；固定清单 `cmd-history, consult-preserve, droid-protocol, fabric-wake, fabric-xs, rpc-spawn, schedule, secure-gocryptfs, slash-args, traffic, traffic-coexist` 中，凡在 `tests/conformance/<name>.test.ts` 实际存在的，其文件名必须出现在本节（#40 删掉 consult-preserve 后该项自动跳过，不需要改测试） | conformance 跑法与清单                    |
| K3  | 同一节含 `src/adapters/pi-compat.ts`，并逐字包含 `package.json` 里三个 `@earendil-works/*` peer 的范围字符串（运行时读 package.json，范围变了测试就逼着文档同步）                                                                                                                                                                                                                                     | peer bump 步骤                            |
| K4  | 「Frozen artifacts」节逐个包含 A/A′ 档路径（`fabric-xs-off-golden.json`、`fabric-wake-off-golden.json`、`fabric-xs-reply-off-golden.json`、`compact-hint-golden.json`、`schedule-off-golden.json`、`secure-off-golden.json`、`secure-contract-parity.json`、`keepalive-legacy-golden.json`、`bash-tools-golden.json`、`legacy-xs-v071/`、`secure-launcher-off-golden.json`），且这些路径在磁盘上存在  | 冻结 golden 表                            |
| K5  | 「Releasing」节逐字包含 5 句锚点（取自现行原文）：`A **patch** release is cut`、`releasing minor/major on \`dev\` is forbidden`、`at least 50 \`feat\` commits`、`**CHANGELOG is generated, never hand-edited**`、`scripts/release/release.sh <version>`                                                                                                                                              | 发版规则                                  |
| K6  | 「pi-extension specifics」节含 `jiti`、`/reload`、`module scope`、`HOST_KEY`、`inert`、`unref()`                                                                                                                                                                                                                                                                                                      | pi-extension 易错点 / child inert / unref |
| K7  | 「What this is」节含原句 `Do NOT "finish the rename" inside`；「Global invariants」节含 I3 的 `HOST_KEY` 与 `initSecureDomain()`、I5 的 `unref()`、I7 的 `pi-subagent.json`、`Symbol.for("pi-subagent:`、`subagent:*`、`[pi-subagent]`                                                                                                                                                                | HOST_KEY / unref / 运行时旧名             |
| K8  | AGENTS.md 里出现的每个 `docs/dev/**/README.md` 路径都存在                                                                                                                                                                                                                                                                                                                                             | 表格链接不悬空                            |
| K9  | `src/` 下每个一级目录都在「Repository layout」节以 `src/<dir>/` 出现                                                                                                                                                                                                                                                                                                                                  | 不再漏登记（分析 §5.3）                   |

#40 删掉 `src/consult/` 和它的 README 时，K9 不受影响；如果只删了 README 却留着表行，K8 会报红，这正是想要的。

### 1.9 skills 引导（Q6 已决：做）

`skills/dev-flow/SKILL.md` 的探索阶段加一句：「先 read AGENTS.md 表中目标目录的 README，再派探索」。只改一行，#40 也会改这个文件的 consult 段，冲突很小。

### 1.10 P1 实施步骤

1. 在 `/tmp/agents-split/` 写切片脚本（不入库）：输入是当前的 `AGENTS.md`，按 §1.6 的标记表切出各段，去掉两格续行缩进，按目标文件拼接，加 §1.6 的头部；已有 README 的走追加。
2. 对新增/追加的 README 跑 `npx prettier --write`。
3. 按 §1.2 手写新 AGENTS.md：不变式和冻结表按 §1.3、§1.4，表格行用原条目的第一句压成一行，文字取自原文。
4. 套用 §4.3 的「移动路径替换表」（⑥ 的新路径）到 AGENTS.md 和新 README。历史 plan/report 不改。
5. 新增 `tests/docs/agents-md.test.ts`（K0–K9，§1.8），以及 dev-flow 那一行（Q6 已决）。
6. 按附录 C 的块清单跑守恒检查（§1.11）。

### 1.11 P1 验收判据（r2：逐块完整比对）

- **守恒检查**（脚本放 `/tmp/agents-split/check.mjs`，不入库，verifier 复跑）：
  1. 源文本取 `git show <P1 开工时 HEAD>:AGENTS.md`。按附录 C 的「源标记」在**字符偏移**上切块（标记可以落在行中间，例如 `**Web resume`、`**\`prompt-gate.ts\`**`），每块从自己的标记到清单里下一个标记为止，不按行号。
  2. 机械归一：去掉列表项的 `- ` 前缀和两格续行缩进 → 按 §4.3 路径替换表替换 → 所有空白归一成一个空格。目标文本做同样的空白归一。
  3. 对每一块，定位附录 C 指定的「目标文件 + 目标章节」：章节从该 `##`/`###` 标题开始，到下一个同级或更高级标题为止。断言**整块**归一后的源文本是目标章节归一后文本的**连续子串**。不做句段抽样，不做模糊匹配。
  4. 允许的偏差只有附录 C 「例外」列逐条列出的那些（E1–E6）。prettier 造成的转义差异如果出现，必须逐条写进报告，并补进例外列表，由 verifier 复核；不能整体豁免。
  5. 覆盖性反向检查：源 AGENTS.md 的每个字符（`## ` 标题行除外）都必须恰好落在一个块里。块的区间首尾相接、不重叠、无空隙，规则见附录 C.3，确保没有漏切的段落。
- K0–K9（§1.8）全部通过：`npx vitest run tests/docs/agents-md.test.ts`；`wc -c AGENTS.md` ≤ 30 720。
- `npx prettier --check AGENTS.md "docs/dev/**/README.md"` 通过。
- `git diff --stat` 只出现 `AGENTS.md`、`docs/dev/**/README.md`、`tests/docs/agents-md.test.ts`、`skills/dev-flow/SKILL.md`。
- **盲测**（verifier 做）：派一个只读子 agent，只给它新 AGENTS.md，不给其他文件。10 个问题都要答对并给出路径或原句：
  1. peer bump 前怎么跑 conformance，droid 套件怎么开；
  2. 列出所有 conformance 套件；
  3. 哪些 golden 永不重生，哪个只许 USAGE 变化；
  4. pi peer bump 的完整步骤；
  5. patch 版本在哪个分支发，minor 版本怎么发；
  6. 新加一个 timer 要注意什么，为什么；
  7. 为什么不能留模块级可变状态；
  8. 子会话里哪些功能注册、为什么要 inert；
  9. 设置文件名和 `Symbol.for` 前缀能不能改成 pi-toolkit；
  10. 改 `src/web-hub/hub/feishu/` 前读什么，hub 能不能导入 `src/core/format.ts`。

## 2. ② 零风险去重（包 P2，3 个 commit）

### 2.1 D1 `redactSecrets` 合并到 `src/core/redact.ts`

- 现状：`src/web-search/resilience.ts:92` 和 `src/cache-ttl/ping-client.ts:86` 的函数体逐字节相同。后者的注释写着「为了 pi-free 和避免跨功能导入才复制」。签名分别是 `secrets: string[]` 和 `readonly (string | undefined)[]`。
- 新建 `src/core/redact.ts`，零导入，导出 `redactSecrets(message: string, secrets: readonly (string | undefined)[]): string`，函数体照搬。原函数里的 `if (secret)` 已经能处理 `undefined`；`string[]` 能赋给更宽的参数类型，调用方类型不变。core 的 pi-free 规则（只许 `node:*` 和 core 内部导入）满足。
- 源码调用点：
  - `src/web-search/resilience.ts`：删除本地函数，`errorMessage` 改从 `../core/redact.js` 导入。
  - `src/web-search/providers.ts:10`：把 `redactSecrets` 改成从 `../core/redact.js` 导入，其余三个名字仍从 resilience 导入。
  - `src/quota/http.ts:19`：同上，只有 `redactSecrets` 改到 core；`backoffDelay/isRetryableError/sleep` 仍来自 resilience，不在本批。
  - `src/cache-ttl/ping-client.ts`：删除本地函数，改为导入 core 版本（`:483` 的内部调用不变），同时删掉过时的「Mirrors…」注释。
  - `src/cache-ttl/pipeline-ping.ts:9`：把 `redactSecrets` 从 `./ping-client.js` 的导入列表里拿掉，改为 `import { redactSecrets } from "../core/redact.js"`。
- **测试导入（r2，评审 #2）**：`tests/web-search/resilience.test.ts:2-7` 和 `tests/cache-ttl/keepalive-ping.test.ts:2-6` 的 import 列表都从旧位置导入 `redactSecrets`。把它从这两个列表里拿掉，各自另起一行 `import { redactSecrets } from "../../src/core/redact.js"`。现有的 `describe("redactSecrets")` 断言（resilience `:89-106`、keepalive-ping `:517-520`）一字不改，作为合并后的回归。不再新建 `tests/core/redact.test.ts`，两份原测试已经覆盖了 URL key、Bearer、字面 secret、空串 secret 和 OAuth token。
- `tests/web-hub/agent/redact.test.ts`、`tests/web-hub/hub/feishu/http.test.ts` 测的是另外两份不同实现，不碰。
- **不合并**：`web-hub/hub/feishu/http.ts:187`（hub 侧，规则更强）、`web-hub/agent/redact.ts:77`（单参数，规则不同）。
- 不保留 re-export：两个旧位置不再导出 `redactSecrets`，全仓导入点（上面 5 个源码文件 + 2 个测试）一次改完。改完后 `rg -n "redactSecrets" src tests` 能看到的导入，只剩指向 core 的那些和另外两份独立实现。

### 2.2 D2 `isTerminalStatus` 统一用 `src/core/status.ts`

- `src/ui/fleet-panel.ts:39-43`：删 `const TERMINAL` 和本地 `isTerminalStatus`，改为 `import { isTerminalStatus } from "../core/status.js"`。终态集合一样（completed/failed/timed_out/aborted），行为不变。
- `src/archive/control.ts:31`：改从 `../core/status.js` 导入。
- 不碰 `src/consult/tool.ts:362`（#40）。
- 注意：core 版本是类型守卫（`status is TerminalStatus`），`if (!isTerminalStatus(s)) …` 的分支里类型会被收窄。如果 typecheck 报错（例如 else 分支里再和终态字面量比较），**改调用点的写法，不要改 core**。fleet-panel 不再导出 `isTerminalStatus`（已确认 src/tests/ui 都没有从 fleet-panel 导入它）。

### 2.3 D3 hub 内 promise 超时：只收敛三份，`raceDeadline` 不动（r2，评审 #3）

- 现状有 4 份，错误形状和实现方式各不相同：

| 位置                                  | 超时错误                                                         | 非 Error 拒因                 | 本批处理                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub/http.ts:358`（私有）             | `Object.assign(new Error("E_DEADLINE"), { code: "E_DEADLINE" })` | 原样透传                      | 改走 `deadlineRace`                                                                                                                                 |
| `hub/run-routes.ts:106`（私有）       | `new HubError("E_DEADLINE")`                                     | 原样透传                      | 改走 `deadlineRace`                                                                                                                                 |
| `hub/lifecycle.ts:88`（导出）         | ``new Error(`E_DEADLINE: exceeded ${ms}ms`)``                    | 包成 `new Error(String(err))` | 改走 `deadlineRace`                                                                                                                                 |
| `hub/req-deadline.ts:52 raceDeadline` | `new Error("E_DEADLINE")`                                        | 原样透传                      | **不动**。它基于 `Promise.race`，评审实测换成手写 then 后超时拒绝会提前一个微任务（`q1→q2→rejected` 变成 `q1→rejected→q2`），时序可观察，不算零风险 |

- 前三份的写法完全一样：`new Promise` → 先挂 `setTimeout(…).unref?.()` → 再 `p.then(resolve+clear, reject+clear)`。在 `req-deadline.ts` 新增导出原语，结构逐行照搬这个写法：

  ```ts
  export function deadlineRace<T>(
    p: Promise<T>,
    ms: number,
    onTimeout: () => unknown,
    mapReject?: (e: unknown) => unknown,
  ): Promise<T>;
  ```

  `mapReject` 在 reject 回调里同步调用，不额外 `.catch()`，所以不多一跳微任务。

- 改写（函数名、导出和调用点都不变）：
  - `http.ts`：`function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> { return deadlineRace(p, ms, () => Object.assign(new Error("E_DEADLINE"), { code: "E_DEADLINE" })); }`
  - `run-routes.ts`：同形，`() => new HubError("E_DEADLINE")`。
  - `lifecycle.ts`：``deadlineRace(p, ms, () => new Error(`E_DEADLINE: exceeded ${ms}ms`), (err) => (err instanceof Error ? err : new Error(String(err))))``。lifecycle.ts 现在零导入，改完多一条 hub 内部的值导入 `./req-deadline.js`；req-deadline 指向 ports 的只有 `import type`，不形成运行时环。
- 测试：扩展 `tests/web-hub/hub/req-deadline.test.ts`。
  - **时序等价**：先在基线（改动前）上，用三个原实现的同构副本跑出「p 先 resolve / p 先 reject / 超时」三种情况下与 `queueMicrotask(q1/q2)` 交错的事件序列，把序列写进测试；然后断言 `deadlineRace` 的三种情况得到相同序列。
  - **形状**：`onTimeout` 的返回值原样成为拒因；`mapReject` 被调用；先结算时 timer 已清（`vi.useFakeTimers` + `vi.getTimerCount()`）；timer 已 unref。
  - lifecycle 的导出版本单独断言 message 带毫秒数、非 Error 拒因被包装。http 和 run-routes 的包装是私有一行转发，由代码审查确认（diff 只有函数体变成一行 `return deadlineRace(...)`）。
  - `raceDeadline` 现有的两个用例不动。

### 2.4 不做（列为观察）

- `ask-user/interrupt.ts:89` 的 `Clock`：接口是 `schedule/cancel`，和 core 的 `setTimer/clearTimer + TimerHandle` 不同。合并要改 ask-user 的调用点和 `tests/ask-user/bg-harness.ts` 的 `FakeClock`，不算零风险（Q3 已决：不做）。
- `isRecord`（28 份）、`sha256Hex`（≥6 份）、atomic-write、sleep/backoff：不在 Top10 #2 里，留给后续批次。

### 2.5 P2 验收

- `npm run typecheck`
- `npx vitest run tests/core tests/web-search tests/quota tests/cache-ttl tests/ui tests/archive tests/web-hub/hub tests/web-hub/http tests/web-hub/boundary.test.ts`
- `rg -n "redactSecrets" src tests`：除了 `src/web-hub/{agent/redact,hub/feishu/http}.ts` 及其测试，所有导入都指向 `core/redact.js`。
- `git diff <P2 开工时 HEAD>..HEAD -- tests/fixtures` 为空；`src/web-hub/hub/req-deadline.ts` 的 diff 里 `raceDeadline` 函数体没有变化。
- diff 审查：除了被合并的副本，没有删任何导出名；hub 文件只新增 hub 内部的导入（边界测试是绿的）。

---

## 3. ③ 死代码清理（包 P3）

### 3.1 删除前的统一核验方法（每一条都要做，结果贴进报告）

```sh
GOV='--glob !docs/dev/source-governance/analysis.md --glob !docs/dev/source-governance/plan-lowrisk.md'
# ① 代码面：只能命中声明那一行
rg -nw '<name>' --glob '!docs/**' --glob '!node_modules/**' --glob '!dist/**' --glob '!tests/fixtures/**' .
# ② 文档面：排除两份治理清单后必须为空；不为空就进入「历史文档例外」判定
rg -nw '<name>' docs AGENTS.md skills $GOV
```

- 两份治理清单（analysis.md 和本方案）本身会列出所有候选名字，所以两条命令都把它们排除了。`tests/fixtures/**` 里的文本语料（例如 `preview-perf/stack-3609.ts.txt`）是冻结的副本，不算引用，单独排除。
- **历史文档例外**：命令 ② 不为空、但命中的都是「描述当时设计的 plan/report」（目前只有 `readStopMarker` → `docs/dev/web-hub/control-plan.md`）。这种情况仍按高置信度删除，但在报告里单列一节「历史文档例外」，逐条写出名字、命中文件和行号，由 verifier 复核。除此之外，命中任何其他文档的一律降为观察（§3.5）。
- `src/index.ts` 是唯一的包公开面（package.json `exports` 只有 `"."`），下面的条目都不经它导出（已核对）。
- 删掉函数后，同文件里只被它用到的私有 helper 一起删，并在报告里列出来。
- **边界钉死文件的 import 行本批一律不动**：`SYSLOAD_FILE_CLOSURE`、`SCHEDULE_CORE_FILE_CLOSURE`、`GIT_FILE_CLOSURE` 里列出的文件，即使删了导出后某个 import 变成多余，也先留着。
- 已对 `b667d880` 跑过：下面 A、B 两组在代码面（含 `src/web-hub/ui`、scripts、根配置文件）零引用；文档面只有上面那一个历史例外。

### 3.2 A 组：别名残留 37 个（置信度高，全部删除）

都是 `export const X = Y;` 一行，`Y` 本身仍在用：

- `src/core/message.ts:206-207` formatEnvelope、createMessageKey
- `src/delivery/engine.ts:317` createEngine
- `src/extensions/worktree.ts:503` createWorktreeExtensionPoints
- `src/external-agent/droid/usage-fields.ts:29` droidLastCallCounts
- `src/memory/tidy/`：`archive-signals.ts:69` computeArchiveSignals · `batch-plan.ts:188` packBatches · `batch-settings.ts:67` parseTidyBatchSettings（在 SYSLOAD 闭包表里，只删这一行，不碰 import）· `index-edit.ts:140-142` planIndexEdit/applyIndexEdit/applyIndexEdits · `journal.ts:331-333` foldJournal/nextRunState/decideOp · `lease.ts:145-149` createRunLease/readRunLease/refreshRunLease/releaseRunLease/breakRunLease · `manifest.ts:602` parseManifestV2 · `run-ledger.ts:59,61` reserveRun/watcherAllowance · `selection.ts:90` buildSelectionItems · `txn.ts:498-499` executeStep/executeTransaction · `ui/bounded-viewer.ts:71` boundedViewer
- `src/sysload/render.ts:45-47` buildLoadHintText/buildLoadRejectText/buildLoadRecoveryNotice · `tracker.ts:418` createTracker · `wire.ts:121-123` toLoadWire/toLoadGateWire/fingerprintLoad（tracker/wire 在 hub 白名单里，只删导出行）
- `src/web-hub/hub/avatar/fs.ts:223` defaultAvatarFs · `avatar/validate.ts:39-40` validateAvatarPngHub/validateAvatarPngNode
- `src/web-hub/protocol/ui-manifest.ts:155` UNKNOWN_COMMIT

### 3.3 B 组：零引用函数/常量（置信度高，删除）

`cache-ttl/measure-types.ts:729 isMeasureApi` · `extensions/worktree-settings.ts:23 mergeWorktreeSettings` · `external-agent/droid/settings.ts:134 effortInfoOf` · `memory/tidy/journal.ts:297 canTransitionRunState` · `memory/tidy/manifest.ts:80 readBackupFile`、`:85 writeManifest` · `memory/tidy/run-ledger.ts:18 remainingUsd`、`:52 canDispatch`、`:55 releaseReservation` · `runtime/input-budget-registry.ts:82 isValidInputBudget` · `schedule/core/claim.ts:439 claimableNow`（agent 侧，不在 hub 白名单）· `schedule/core/occurrence.ts:249 undecidedCount`（在 SCHEDULE 闭包表里，不碰 import）· `schedule/core/writer.ts:269 runsOfTask` · `sysload/gate.ts:83 loadLevelAtLeast`、`:87 summarizeLoad` · `sysload/render.ts:41 buildLoadNotice` · `todo/ui.ts:222 renderTaskPreview` · `web-hub/hub/avatar/validate.ts:81 isAvatarRejectReason` · `web-hub/hub/spawn/history/index.ts:533 parseCursor` · `web-hub/hub/spawn/history/snapshot.ts:224 verifySnapshotAsync` · `web-hub/protocol/stop-marker.ts:91,100,110` readStopMarker/writeStopMarker/removeStopMarker（async 包装，生产代码只用 `*Sync`；control-plan 里的提及是历史记录，不改）· `web-hub/protocol/rotate-intent.ts:106,112,123` readRotateIntent/writeRotateIntent/removeRotateIntent（同上）。

> `readStopMarker` 在 `docs/dev/web-hub/control-plan.md` 有一处历史提及。例外规则：**只在 plan/report 里被提到、而那份文档描述的是当时的设计**，仍算高置信度，报告里注明即可。其余有文档引用的一律放进观察组。

### 3.4 C 组：不可达文件

| 文件                                    | 处理                                                                                                                                                                                                                                                                                         | 置信度               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `src/web-hub/hub/lan-security-stubs.ts` | 删除。它是 P0 的兼容适配器，B 阶段已经接上真实的 child IPC，生产代码零引用。同时修改 `tests/web-hub/hub/lan-security-surfaces.test.ts`：删掉第 5 行的 import 和第 90–93 行的 stub 断言，保留同一个 `it` 里的 `repairLan2fa` 断言，把用例改名为「B repair is async and honours cancellation」 | 高                   |
| `src/rpc/client.ts`                     | （Q4 已决）`git mv` 到 `tests/rpc/helpers/rpc-client.ts`，并把它的 3 个 import 改成 `../../../src/...`；`tests/rpc/rpc.test.ts:2` 改为导入新位置。`src/rpc/` 保留 server/protocol                                                                                                            | 高（生产路径不可达） |
| `src/workflow/orchestrator.testing.ts`  | **不动**。这是刻意设计的四层「生产不可达」门（`tsconfig.build.json` 排除、`assertNoSmuggledTestHooks`、`tests/workflow/wc14-testhooks-gate.test.ts` 的 grep），分析报告把它归为测试辅助是误判                                                                                                | —                    |

### 3.5 观察组（本批不删，原样记进 P3 报告，留待后续）

- **有文档引用的契约/词表常量**：`schedule/core/spec.ts` 的 SCHED_RECEIPT_TTL_MS、SCHED_UNKNOWN_REASONS、SCHED_DROPPED_REASONS、SCHED_REPORT_SKIPPED_REASONS、SCHED_NOTE_MAX_RESENDS、SCHED_SECTION_NAME · `web-hub/protocol/avatar.ts` 的 AVATAR_BODY_MIN_MS/BODY_CAP_MS/AUTH2_CAP_MS/LOAD_TOTAL_MS · `hub/avatar/routes.ts` 的 AVATAR_STATUS · `hub/spawn/history/budget.ts` 的 HISTORY_INDEX_* · `hub/supersede.ts` 的 SUPERSEDE_DRAIN_MAX_MS · `protocol/feishu.ts` 的 FEISHU_CMD_ID_PREFIX · `protocol/lan-2fa.ts` 的 LAN_LOGIN_PATH。
- **有文档引用的函数**：payloadLineageKey、isMessageKey、backupLiveFile、copyLiveFileToBackup、withinTolerance、onceVerdict、leaseOf、ensureAvatarDir。
- **在边界钉死文件里，删了会改变闭包**：`sysload/io-ledger.ts` 的 createIoLedger、getIoLedgerStats，`sysload/sampler.ts` 的 createDefaultSamplerIo。
- **避让 #43 / #40**：`secure/config.ts` 的 isLegacyVault（secure 契约，parity fixture 相关）、`consult/preserve-identity.ts` 的 snapshotToolDeclarations。
- **只被测试引用的 73 个导出**（包括 `config/{agent-types,available-models}.ts` 的 `append*ToSystemPrompt`，fold.ts 字节一致性测试还在用它们）：不动。

### 3.6 P3 验收

- 报告里每一条都有 §3.1 两条 rg 命令的输出。
- `npm run typecheck`（三段：tsc×2 + vue-tsc）。
- `npx vitest run tests/memory tests/sysload tests/schedule tests/web-hub tests/todo tests/cache-ttl tests/external-agent tests/extensions tests/core tests/delivery tests/runtime tests/rpc`
- `npx vitest run tests/web-hub/boundary.test.ts`（钉死的闭包没变）。
- `git diff --stat` 只有删除，没有任何文件新增导出；`git diff <P3 开工时 HEAD>..HEAD -- tests/fixtures` 为空。
- 报告包含：每条候选两条 rg 命令的输出、「历史文档例外」一节、观察组清单。

---

## 4. ⑥ 目录归属修正 + 边界测试

### 4.1 包 P6M：四组纯移动（一个 writer，**每组一个 commit**，用 `git mv` 保证 rename 检测）

所有移动的共同规则：

- 导出名、函数体、注释一律不动；只改 import/export 的路径。被移文件内部 `../cache-ttl/x.js` 这类路径变成 `./x.js`，其余 `../<dir>/` 路径深度相同、不用改。
- 不留 re-export 垫片（Q5 已决：本批正好在清理别名残留，垫片会制造新的残留）。
- 1:1 的单元测试跟着移；多模块和集成测试原地不动，只改 import 路径（Q5）。
- **迁移测试逐个重解析全部相对导入（r2，评审 #6）**：不批量增删 `../`。对每个移动的测试文件，列出它所有的相对说明符（`from`、`import()`、`new URL()`、`vi.mock()`），按「用旧位置解析出绝对目标，再从新位置重新计算相对路径」逐条改写，结果写进 §4.1 附表并贴进报告。改完后跑一次检查：对每个移动过的测试，用 AST 列出全部相对说明符，逐个确认 `existsSync(resolve(newDir, spec 换成 .ts))`，全部存在才算过。
- **源码字符串里的旧路径（r2，评审 #7）**：tsc 不检查字符串里的路径。每组移动完成后跑 `rg -n '<旧路径（去掉 src/ 前缀也查一遍）>' src tests scripts --glob '!tests/fixtures/**'`，必须 0 命中；注释、文档字符串、子进程源码字符串都在检查范围内。`docs/` 只由 P1 按 §4.3 处理。
- **`tests/fixtures/**` 一律不碰**：例如 `tests/fixtures/preview-perf/stack-3609.ts.txt` 是 stack.ts 的文本语料副本，里面也有 `service/cache-keepalive` 等旧路径，保持原样。

| commit | from → to                                                                                                                                                                                                             | 要改 import 的 src 文件                                                                                                                                                                                                                                                                                                                                                                                                                    | 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | `src/service/cache-keepalive.ts` → `src/cache-ttl/keepalive-service.ts`                                                                                                                                               | `src/cache-ttl/cache-ttl.ts:30`、`src/cache-ttl/child.ts:21`、`src/web-hub/agent/index.ts`、`src/stack.ts`                                                                                                                                                                                                                                                                                                                                 | 只改 import（都已在 `tests/cache-ttl/` 或集成目录）：`tests/cache-ttl/{fake-pipeline.ts,cache-ttl,keepalive-traffic-veto,keepalive-late-usage,keepalive-child,request-capture,keepalive-ping-retry,keepalive-evidence,keepalive-lifecycle,keepalive-pipeline,warmth-port}.test.ts`、`tests/integration/{keepalive-pipeline-service,cache-ttl-removal}.test.ts`、`tests/conformance/keepalive-pipeline.test.ts`；**源码字符串**：`tests/integration/keepalive-pipeline-service.test.ts:491` 子进程脚本里的 `'./src/service/cache-keepalive.ts'` 改为 `'./src/cache-ttl/keepalive-service.ts'`（这段脚本在 `:536` 由 `tsx -e` 执行，tsc 不检查）；注释：`tests/integration/child-keepalive.test.ts:306`、`tests/cache-ttl/keepalive-child.test.ts:3` |
| M2     | `src/tools/bash-tool.ts` → `src/bash/tool.ts`；`src/tools/bash-job-tool.ts` → `src/bash/job-tool.ts`                                                                                                                  | `src/index.ts:99-100`、`src/stack.ts:48`、`src/commands/status.ts:27`、`src/bash/child.ts:28-29`；job-tool 内部：`./bash-tool.js`→`./tool.js`，`../bash/{manager,types,child-registry}.js`→`./…`，`./poll-guard.js`→`../tools/poll-guard.js`（poll-guard 还被 result-tool 用，不动）                                                                                                                                                       | `git mv tests/tools/bash-tool.test.ts tests/bash/tool.test.ts`、`tests/tools/bash-job-tool.test.ts → tests/bash/job-tool.test.ts`、`tests/tools/bash-tools-golden.test.ts → tests/bash/tools-golden.test.ts`（`bash-tools-golden.json` 不动。它的 `FIXTURE_PATH` 按 `process.cwd()` 解析，跟测试文件放在哪无关；`:37` 注释里的 `tests/tools/bash-tools-golden.test.ts` 改成新路径）；只改 import：`tests/tools/model-facing-strings.test.ts`、`tests/integration/bash-auto-background.test.ts`                                                                                                                                                                                                                                                     |
| M3     | `src/tools/switch-context-tool.ts` → `src/context-switch/tool.ts`；`src/tools/compact-tool.ts` → `src/compact-hint/compact-tool.ts`；`src/tools/set-compact-threshold-tool.ts` → `src/compact-hint/threshold-tool.ts` | `src/index.ts:90,91,98`、`src/stack.ts:75`、`src/context-switch/child.ts:34`；tool.ts 内部 `../context-switch/x.js`→`./x.js`；threshold-tool 内部 `../compact-hint/x.js`→`./x.js`，`../stack.js` 不变（同层深度；这条反向类型边归 Top10 #4）                                                                                                                                                                                               | `git mv tests/tools/switch-context-tool.test.ts tests/context-switch/tool.test.ts`、`compact-tool.test.ts → tests/compact-hint/compact-tool.test.ts`、`set-compact-threshold-tool.test.ts → tests/compact-hint/threshold-tool.test.ts`；只改 import：`tests/integration/{context-switch-wiring,compact-hint-wiring}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M4     | `src/web-hub/agent/command-capture.ts` → `src/commands/capture.ts`                                                                                                                                                    | `src/index.ts:135`、`src/commands/{schedule,fabric-xs,webhub}.ts`、`src/memory/tidy/batch-command.ts:51`、`src/ui/settings-editor.ts:2`、`src/todo/index.ts:32`、`src/web-hub/agent/{index,command-usage,twofa-cmd,command-complete,command-record,users-cmd,builtin-bridge}.ts`；capture.ts 内部：`./command-complete.js`/`./command-record.js`（type）→`../web-hub/agent/…`，`../protocol/messages.js`→`../web-hub/protocol/messages.js` | `git mv tests/web-hub/agent/command-capture.test.ts tests/commands/capture.test.ts`（相对导入逐条改写，见附表，**不是**整体去掉一个 `../`）；只改 import：`tests/web-hub/agent/{command-capture-recorder,capture-commands,extension-async-late,builtin-bridge,real-command-matrix}.test.ts`、`tests/commands/{webhub-2fa,webhub-user}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                     |

**§4.1 附表：迁移测试的相对导入逐条改写（`b667d880` 实测）**

| 测试（旧 → 新）                                                                                | 旧说明符                                                                                        | 新说明符                                                        |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tests/web-hub/agent/command-capture.test.ts` → `tests/commands/capture.test.ts`               | `../../../src/web-hub/agent/command-capture.js`（:19）                                          | `../../src/commands/capture.js`                                 |
| 同上                                                                                           | `../../../src/web-hub/agent/index.js`（:20）                                                    | `../../src/web-hub/agent/index.js`                              |
| 同上                                                                                           | `./helpers.js`（:21，`SETTINGS`）                                                               | `../web-hub/agent/helpers.js`                                   |
| `tests/tools/bash-tool.test.ts` → `tests/bash/tool.test.ts`                                    | `../../src/tools/bash-tool.js`（:32）                                                           | `../../src/bash/tool.js`                                        |
| 同上                                                                                           | `../../src/bash/{child-registry,job-store,manager,process,types}.js`、`../../src/core/clock.js` | 不变（同层深度）                                                |
| `tests/tools/bash-job-tool.test.ts` → `tests/bash/job-tool.test.ts`                            | `../../src/tools/bash-job-tool.js`（:12）                                                       | `../../src/bash/job-tool.js`                                    |
| 同上                                                                                           | `../../src/bash/{manager,types,child-registry}.js`                                              | 不变；`resolveRepoPath`（:1013）按 `process.cwd()` 解析，也不变 |
| `tests/tools/bash-tools-golden.test.ts` → `tests/bash/tools-golden.test.ts`                    | `../../src/tools/bash-tool.js`、`../../src/tools/bash-job-tool.js`                              | `../../src/bash/tool.js`、`../../src/bash/job-tool.js`          |
| 同上                                                                                           | `../../src/config/settings.js`                                                                  | 不变                                                            |
| `tests/tools/switch-context-tool.test.ts` → `tests/context-switch/tool.test.ts`                | `../../src/tools/switch-context-tool.js`                                                        | `../../src/context-switch/tool.js`                              |
| 同上                                                                                           | `../../src/context-switch/{capability,store}.js`、`../../src/todo/nudge.js`                     | 不变                                                            |
| `tests/tools/compact-tool.test.ts` → `tests/compact-hint/compact-tool.test.ts`                 | `../../src/tools/compact-tool.js`                                                               | `../../src/compact-hint/compact-tool.js`                        |
| `tests/tools/set-compact-threshold-tool.test.ts` → `tests/compact-hint/threshold-tool.test.ts` | `../../src/tools/set-compact-threshold-tool.js`                                                 | `../../src/compact-hint/threshold-tool.js`                      |
| 同上                                                                                           | `../../src/stack.js`                                                                            | 不变                                                            |

> 被移的**源码**文件，内部导入也逐条重算。例如：`src/bash/job-tool.ts` 的 `./poll-guard.js` 改为 `../tools/poll-guard.js`；`src/commands/capture.ts` 的 `../protocol/messages.js` 改为 `../web-hub/protocol/messages.js`，`./command-complete.js` / `./command-record.js`（type）改为 `../web-hub/agent/…`。

> M4 的边界影响：capture.ts 移出 `src/web-hub/agent/` 后，原来那条「agent 不得导入 hub」的守卫是按文件 glob 扫的，会漏掉它。r2 在 P6B 里修正（§4.2 B3）：守卫的受约束集合继续包含 capture 文件，判断改按解析后的路径。M4 会新增一条 `commands → web-hub/{agent(type),protocol}` 的依赖边，换来 7 个非 web 模块不再依赖 `web-hub/agent`。

**刻意不做**（Q1 已决：不做）：把 `effectiveReceive` / `isValidXsSessionId` 移出 `config/settings.ts`。`settings.ts:1244-1250` 的注释明确说「settings.ts 的值导入闭包被 boundary 测试冻结，所以保留本地字面量」，settings.ts 自己在 `:2229` 也用到它；移走就得改 `SYSLOAD_FILE_CLOSURE` 钉死表。而且 #40 也要改 settings.ts。并入 Top10 #8（settings 子系统化）一起做。

### 4.2 包 P6B：边界测试（与 P6M 并行）

**B1 新建 `tests/boundary/pi-free.test.ts`**

- **用 TypeScript AST 扫描（r2，评审 #9）**：`typescript` 已是 devDependency（`^5.6.0`）。不复制 `tests/web-hub/boundary.test.ts` 的正则 `scanSource`，它有两个已知缺陷：漏掉无插值模板字符串的动态导入（``import(`x`)``），以及把 `import { type X } from` 记成值导入。改用 `ts.createSourceFile(file, text, ScriptTarget.Latest, true, ScriptKind.TS)` 遍历语法树，各类节点的归类如下：

| 节点                                                                                                                           | 归类                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `ImportDeclaration` 无 importClause（`import "x"`）                                                                            | 值                                   |
| `ImportDeclaration`：`importClause.isTypeOnly`，或没有默认名、`namedBindings` 为 `NamedImports` 且每个 element 都 `isTypeOnly` | type                                 |
| 其余 `ImportDeclaration`（含 namespace 导入和混合的 `{ type A, B }`）                                                          | 值                                   |
| 带 moduleSpecifier 的 `ExportDeclaration`：`isTypeOnly`，或 `NamedExports` 的每个 element 都 `isTypeOnly`                      | type；否则为值（含 `export *`）      |
| `ImportEqualsDeclaration` + `ExternalModuleReference`                                                                          | `isTypeOnly` 为 type，否则为值       |
| `CallExpression`：callee 是 `ImportKeyword` 或标识符 `require`，参数是 `StringLiteral` / `NoSubstitutionTemplateLiteral`       | 值                                   |
| 同上，但参数是带插值的模板或其他表达式                                                                                         | **unresolvable**，在任何根下都判失败 |
| `ImportTypeNode`（`import("x").T`、`typeof import("x")`）                                                                      | type                                 |

- B1 自测，用合成源码字符串，每种写法一条：
  - `import "a"` → 值
  - `import type { A } from "a"` → type
  - `import { type A } from "a"` → type
  - `import { type A, B } from "a"` → 值
  - `import * as N from "a"` → 值
  - `export type { A } from "a"` → type
  - `export { type A } from "a"` → type
  - `export * from "a"` → 值
  - ``import(`a`)`` → 值，说明符为 `a`
  - ``import(`${p}`)`` → unresolvable
  - `require("a")` → 值
  - `let t: typeof import("a")` → type
  - 注释或字符串里出现的 `from "a"` → 不计入
- web-hub 那份正则扫描器本批不动，它守的是钉死的闭包表。它把 `import { type X }` 判成值导入只会让检查更严、不会放过违规，这一点记进 §6 R9。
- 规则：

| 根                                                                    | 允许的说明符（**type 导入也算**）                                                                    | 依据                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/core/**/*.ts`                                                    | `node:*`，以及解析后仍在 `src/core/` 内的相对路径                                                    | AGENTS「No pi imports」；当前实测只有 node:* 和 core 内部                                                  |
| `src/prompt-sections/**/*.ts`                                         | 同上，限 `src/prompt-sections/` 内                                                                   | 「pi-free half (no pi imports)」                                                                           |
| `src/git/**/*.ts`                                                     | 同上，限 `src/git/` 内                                                                               | 「pi-free bounded git executor」                                                                           |
| `src/memory/{paths,frontmatter,store,render}.ts` 的**值导入传递闭包** | 闭包里不得出现 `@earendil-works/*`；这 4 个根文件自身连 `import type` 也不许出现 `@earendil-works/*` | 闭包要按值边算：`memory/contracts.ts` 有一条 type-only 导入指向 `service/spawn-service.js`，算类型边会误报 |

- 用 glob 发现文件，不钉文件数（#40 以后会删 `core/consult-*.ts`），只断言每个根至少发现 1 个文件。

**B2 收紧 `tests/web-hub/boundary.test.ts`：type-only 白名单**

- 新增 `HUB_TYPE_ONLY_ALLOWLIST = ["src/config/settings.ts"]`，从 `SYSLOAD_FILE_ALLOWLIST` 里移除 `src/config/settings.ts`。
- `hubImportAllowed(file, spec)` 改为 `hubImportAllowed(file, spec, typeOnly)`，新增一个分支：`inHub && typeOnly && HUB_TYPE_ONLY_ALLOWLIST.includes(resolveImport(file, spec))`。现状只有 `hub/load.ts:10` 的 `import type { LoadSettings }` 依赖这条，测试保持绿；以后谁在 hub 里值导入 settings.ts 就会报红。**这是收紧，不是放宽。**
- `SYSLOAD_FILE_CLOSURE` 里 settings.ts 那行钉死**保持不变**（Q7 已决：保留）。
- 加两个负向自测：合成一个 hub 文件对 `../../config/settings.js` 的引用，`typeOnly:false` 判定拒绝，`typeOnly:true` 判定允许。

**B3 command-capture 继续受「agent 侧不得导入 hub」守卫约束（r2，评审 #5）**

- 现状：`tests/web-hub/boundary.test.ts:251` 只扫 `globSync("src/web-hub/agent/**/*.ts")`，并用 `spec.startsWith("../hub/")` 判断是否导入了 hub。capture 文件移到 `src/commands/` 后不在 glob 里；即使把它加进来，它导入 hub 要写 `../web-hub/hub/…`，前缀判断也认不出来。
- 修改只在 P6B 里做（P6M 不碰 boundary 测试，所以两包能并行）：
  1. 定义 `AGENT_SIDE_EXTRA_CANDIDATES = ["src/web-hub/agent/command-capture.ts", "src/commands/capture.ts"]`，断言**恰好一个存在**（P6M 合入前后都成立）。受约束集合 = agent glob ∪ 存在的那个候选，并断言集合 ⊇ agent glob。这样原来受约束的文件一个不少，capture 文件不管在哪个位置都在集合里。
  2. 抽出纯函数 `agentImportAllowed(file, spec, typeOnly)`，改按**解析后的路径**判断：`resolveImport(file, spec)` 落在 `src/web-hub/hub/` 下就算 hub 导入；只有目标解析为 `src/web-hub/hub/ports.ts` 或 `src/web-hub/hub/ui-root.ts` 且 `typeOnly` 时放行，语义和原来的 `TYPE_ONLY_ALLOWED` 一样。现有 agent 文件没有子目录，导入 hub 的只有 4 处，都是对 `../hub/ports.js`、`../hub/ui-root.js` 的 type 导入（已核对），所以对现有文件结果不变，不会多报。
  3. 负向自测（直接调用 `agentImportAllowed`）：
     - `("src/commands/capture.ts", "../web-hub/hub/registry.js", false)` → 拒绝
     - `("src/commands/capture.ts", "../web-hub/hub/ports.js", true)` → 放行
     - `("src/commands/capture.ts", "../web-hub/hub/ports.js", false)` → 拒绝
     - `("src/web-hub/agent/x.ts", "../hub/registry.js", false)` → 拒绝（旧行为保持）
     - `("src/web-hub/agent/x.ts", "../hub/ui-root.js", true)` → 放行
- 用例标题改为「agent-side files (agent/** + command capture) never import hub/** (ports/ui-root type-only excepted)」。
- P6M 合入后，旧候选路径不再存在，只是不命中，测试不用再改。是否删掉这个旧候选、进一步收紧，留给后续批次。

### 4.3 移动路径替换表（P1 用来改 AGENTS.md 和新 README）

| 旧路径                                    | 新路径                               |
| ----------------------------------------- | ------------------------------------ |
| `src/service/cache-keepalive.ts`          | `src/cache-ttl/keepalive-service.ts` |
| `src/tools/bash-tool.ts`                  | `src/bash/tool.ts`                   |
| `src/tools/bash-job-tool.ts`              | `src/bash/job-tool.ts`               |
| `src/tools/switch-context-tool.ts`        | `src/context-switch/tool.ts`         |
| `src/tools/compact-tool.ts`               | `src/compact-hint/compact-tool.ts`   |
| `src/tools/set-compact-threshold-tool.ts` | `src/compact-hint/threshold-tool.ts` |
| `src/web-hub/agent/command-capture.ts`    | `src/commands/capture.ts`            |
| `src/rpc/client.ts`（Q4）                 | `tests/rpc/helpers/rpc-client.ts`    |

### 4.4 P6 验收（r2：接线测试与真实加载门禁分开）

通用要求：

- `npm run typecheck && npm run build`（tsconfig.build 也要能编译）。
- `git diff -M90% --stat <P6M 开工时 HEAD>..HEAD`：每个被移文件都显示为 rename（R≥90%）。`git diff -M <base>..HEAD -- <新路径>`：改动只落在 `import` / `export … from` 行、必要的注释路径，以及 §4.1 明列的源码字符串上。
- §4.1 的两项检查都要过：迁移测试的相对导入全部 existsSync；旧路径 rg 0 命中。
- `git diff <P6M 开工时 HEAD>..HEAD -- tests/fixtures` 为空。

两类测试分开跑、分开报告，**两类都必须通过**：

- **(a) 真实 `activate()` 接线测试**：在进程内用 fake pi 调 `activate()` / `buildSessionStack()`，走 vitest 的 ESM 解析。能发现静态导入链断裂和注册顺序问题；发现不了 jiti / pi 资源加载器的问题，也发现不了源码字符串里的路径。
  - M1：`npx vitest run tests/cache-ttl tests/integration/cache-ttl-removal.test.ts tests/integration/child-keepalive.test.ts`
  - M2：`npx vitest run tests/bash tests/tools/model-facing-strings.test.ts tests/integration/bash-auto-background.test.ts tests/integration/bash-jobs-wiring.test.ts tests/commands/status.test.ts`
  - M3：`npx vitest run tests/context-switch tests/compact-hint tests/integration/context-switch-wiring.test.ts tests/integration/compact-hint-wiring.test.ts`
  - M4：`npx vitest run tests/commands tests/web-hub/agent tests/todo tests/memory tests/ui tests/integration/web-hub-cmd-history.test.ts`
- **(b) jiti / pi 资源加载器的真实加载门禁**：由真实 pi 进程或 pi 的 `DefaultResourceLoader` 加载，路径一错就在加载时失败。
  - 每组都跑：`npx vitest run tests/conformance/rpc-spawn.test.ts tests/conformance/rpc-bash-jobs.test.ts tests/conformance/slash-args.test.ts tests/conformance/history-restore.test.ts`。这四个通过 `settings.json` 的 `packages: [REPO_ROOT]` 让真实 pi 用 jiti 加载整个包，任何被移文件的相对导入写错都会在这里暴露。
  - M1 加跑：`npx vitest run tests/conformance/keepalive-pipeline.test.ts`（真实 `DefaultResourceLoader` + pi 管线），以及 `tests/integration/keepalive-pipeline-service.test.ts`（`:536` 用 `tsx -e` 起子进程执行 `:491` 的源码字符串，只有它能证明那处字符串替换是对的）。
  - M2 无需另加：`tests/conformance/rpc-bash-jobs.test.ts` 已覆盖 bash 工具在真实 rpc 会话里的注册。
  - 有门控的套件在本机被 skip 时，报告里必须写明原因，并由主会话收口时在能跑的环境补跑；skip 不算通过。
- P6B：`npx vitest run tests/boundary tests/web-hub/boundary.test.ts` 通过。**变异验证**（verifier 做，做完还原）：
  1. 往 `src/core/format.ts` 加 `import type {} from "@earendil-works/pi-coding-agent"` → B1 报红；
  2. 往 `src/core/format.ts` 加 ``await import(`node:fs`)`` → 不报红；改成 ``import(`${x}`)`` → 报红；
  3. 把 `hub/load.ts:10` 的 `import type` 改成值导入 → B2 报红；
  4. 往 `src/git/diff.ts` 加 `import "../core/clock.js"` → B1 报红；
  5. 在 capture 文件当前位置加对 hub registry 的值导入 → B3 报红：旧位置 `src/web-hub/agent/command-capture.ts` 用 `"../hub/registry.js"`，迁移后 `src/commands/capture.ts` 用 `"../web-hub/hub/registry.js"`（评审 r2 复审 #5）。

## 5. 拆包、并行与合入顺序

| 包  | 内容                        | 车道 | 依赖                                                 | 文件域（详见附录 A）                                                                                                                                                                                |
| --- | --------------------------- | ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6B | ⑥ 边界测试 B1/B2/B3         | L1   | 无                                                   | `tests/boundary/**`、`tests/web-hub/boundary.test.ts`                                                                                                                                               |
| P2  | ② D1/D2/D3（3 个 commit）   | L1   | 无                                                   | core/redact、web-search/{resilience,providers}、quota/http、cache-ttl/{ping-client,pipeline-ping}、ui/fleet-panel、archive/control、hub/{req-deadline,http,run-routes,lifecycle}，以及 3 个测试文件 |
| P3  | ③ A/B/C 组                  | L1   | 无                                                   | 约 37 个 src 文件（只删不加）、lan-security-stubs、rpc/client                                                                                                                                       |
| P6M | ⑥ 移动 M1–M4（4 个 commit） | L2   | 无（与 P6B 文件域不相交；B3 在新旧两种布局下都成立） | 见 §4.1（含 `src/index.ts`、`src/stack.ts` 的 import 行）                                                                                                                                           |
| P1  | ① 文档                      | L2   | 合入时依赖 P6M（路径替换表）和 P3（rpc/client 去向） | `AGENTS.md`、`docs/dev/**/README.md`、`tests/docs/**`、`skills/dev-flow/SKILL.md`                                                                                                                   |

- **外部依赖（r2，主会话裁定）**：
  - **#40**：全部包 blockedBy 本批 P1 合入，不与本批并行。本批全部合入后，#40 以新布局重新核对方案，文件域由其作者更新。所以附录 A 不再列 #40 的伪包。
  - **#43**：当前只改 `src/secure/bin/convert.mjs`、`tests/secure/convert-*.ts`、`tests/integration/traffic-lifecycle-process.test.ts`，以及一个新增子进程测试（`tests/secure/convert-lease-wait.process.test.ts`）。本批全部避开，附录 A 用 `ext:#43` 伪包证明不相交。
- **第一波并行**：P6B、P2、P3、P6M 四个写包同时开，各用独立 worktree。附录 A 预检确认已存在文件零交集，几处相邻的文件分属不同包：
  - `src/cache-ttl/`：P2 改 `ping-client.ts`，P6M 改 `cache-ttl.ts`、`child.ts`
  - `src/ui/`：P2 改 `fleet-panel.ts`，P6M 改 `settings-editor.ts`
  - `src/todo/`：P3 改 `ui.ts`，P6M 改 `index.ts`
  - `tests/cache-ttl/`：P2 改 `keepalive-ping.test.ts`，P6M 改其余 keepalive 测试
  - `tests/web-hub/boundary.test.ts`：只有 P6B 改
- **P1 可以同时开写**（切片脚本、README 骨架、AGENTS.md 草稿），但最后合入：rebase 到最新 dev，在最新的 AGENTS.md 上重跑切片，再套 §4.3 替换表。
- **合入顺序**：P6B → P2 → P3 → P6M → P1。
- 每个包返回后立即派 verifier（验收模型 ≠ 开发模型，按 dev-flow）。验收通过后，由主会话按精确路径 commit；push 需用户确认。
- **冻结面检查（r2，主会话裁定）**：逐个提交检查。每个治理提交都要满足 `git diff <base>..<commit> -- tests/fixtures` 为空，`<base>` 取该包开工时的 HEAD。不做跨 #40 的集成检查。
- **主会话收口**（本批全部合入后、#40 开工前）：
  - `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web`
  - `npm run test:conformance`
  - `git diff <本批第一个包开工时 HEAD>..HEAD -- src | rg '^[-+].*(Symbol\.for\("pi-subagent|"subagent:)'`：每条删除行都要在新增行里找到同文（只允许整行搬移）

## 6. 风险与回滚

| #   | 风险                                                                    | 缓解                                                                                                                                                                                                | 回滚                                                                             |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| R1  | AGENTS.md 下沉后 agent 不读 README，漏掉子系统不变式                    | 顶部硬规则 + 表格「必读·何时读」列 + 不变式和冻结物留在 AGENTS.md + K1–K9 关键规则断言 + 盲测 10 问 + dev-flow 一行（Q6）                                                                           | `git revert` P1 commit，即恢复原 AGENTS.md（README 是新增文件，revert 时一起删） |
| R2  | 切片丢段或错位                                                          | 按字符偏移的标记切块，逐块完整比对，再做覆盖性反向检查（§1.11、附录 C）；K1–K9 关键规则断言；盲测 10 问                                                                                             | 同上                                                                             |
| R3  | 和 #40、#43 冲突                                                        | #40 blockedBy P1，不并行（主会话裁定）；#43 文件域不相交（附录 A）；P1 合入时在最新 AGENTS.md 上重跑切片                                                                                            | 逐包 revert                                                                      |
| R4  | `isTerminalStatus` 变成类型守卫后引发类型收窄报错                       | typecheck 能发现；只改调用点写法                                                                                                                                                                    | revert D2 commit                                                                 |
| R5  | hub 超时的错误形状被无意改变（下游按 `code`/message 匹配）              | 每个包装各自传入原来的错误工厂，测试断言形状；`raceDeadline` 不动                                                                                                                                   | revert D3 commit                                                                 |
| R6  | 移动后 jiti 运行时路径写错（tsc 一般能发现，字符串里的路径发现不了）    | typecheck + build + (a) 接线测试 + (b) 真实加载门禁（§4.4）；没有 `vi.mock`/`await import` 指向这些路径（已用 grep 确认）；唯一的源码字符串（keepalive-pipeline-service:491）明列替换并跑子进程用例 | 每组一个 commit，可单独 revert                                                   |
| R7  | 删了外部消费者在用的导出                                                | 包公开面只有 `src/index.ts`（exports 只有 `"."`），本批不改它的导出；有文档引用的都进了观察组                                                                                                       | revert P3                                                                        |
| R8  | prettier 重排下沉的 markdown                                            | 下沉后跑 `prettier --write`，守恒检查做空白归一                                                                                                                                                     | —                                                                                |
| R9  | 边界钉死表被顺手改动；web-hub 正则扫描器把 `import { type X }` 当值导入 | P3 不碰钉死文件的 import 行；B2 只新增 type-only 分支，钉死表不动（Q7）。正则扫描器的这个误判只会让检查更严，不会放过违规；B1 用 AST，不继承这个误判                                                | revert P6B                                                                       |
| R10 | 迁移测试的相对导入写错，或源码字符串里残留旧路径（tsc 查不出来）        | 逐条重解析 + existsSync 检查（§4.1 附表）；旧路径 rg 必须 0 命中；跑真实加载门禁（§4.4 (b)）                                                                                                        | revert 对应的 M 提交                                                             |
| R11 | capture 文件移出 agent 目录后，hub 导入守卫覆盖不到它                   | B3：受约束集合固定包含 capture 文件，判断改按解析路径，并有负向自测                                                                                                                                 | revert P6B / M4                                                                  |
| R12 | hub 超时换实现后微任务时序变了                                          | `raceDeadline` 不动；另外三份和原实现同构，并加时序等价测试（§2.3）                                                                                                                                 | revert D3                                                                        |

---

## 7. 拍板结果（r2：全部已定，无待拍板项）

| #   | 问题                                         | 结论                                                                                             |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Q1  | xs 领域函数移出 `config/settings.ts`         | 本批不做，并入 Top10 #8（用户按推荐）                                                            |
| Q2  | `raceDeadline` 改走 `deadlineRace`           | **评审后改为不改动**。评审实测超时拒绝会提前一个微任务；本批只收敛另外三份（§2.3），不再需要拍板 |
| Q3  | ask-user 的 `Clock` 并入 core                | 不做（用户按推荐）                                                                               |
| Q4  | `src/rpc/client.ts` 去向                     | 移到 `tests/rpc/helpers/rpc-client.ts`（用户按推荐）                                             |
| Q5  | 兼容垫片与测试文件                           | 不留 re-export 垫片；1:1 单元测试跟着移，集成测试原地只改 import（用户按推荐）                   |
| Q6  | AGENTS.md 守卫测试与 dev-flow 加一行         | 都做（用户按推荐）；测试内容按评审 #4 扩充为 K0–K9（§1.8）                                       |
| Q7  | `SYSLOAD_FILE_CLOSURE` 里 settings.ts 那一行 | 保留（用户按推荐）                                                                               |
| Q8  | ① 与 #40 的先后                              | ① 先合（用户拍板）；主会话进一步裁定本批整批先合，#40 blockedBy P1                               |

## 附录 A：冲突预检 spec（`node skills/dev-flow/scripts/conflict-check.mjs /tmp/sg-lowrisk-spec.json`）

> 脚本在仓库里的路径是 `skills/dev-flow/scripts/conflict-check.mjs`（`~/.agents/skills/dev-flow/scripts/` 不存在）。
>
> - **外部依赖**：#40 的全部包 blockedBy 本批 P1 合入，不并行，因此这里不列 #40 的伪包。`ext:#43` 只列 #43 当前的文件域，用来证明不相交。
> - **新增文件**：#43 新增的子进程测试 `tests/secure/convert-lease-wait.process.test.ts` 也被 `tests/secure/convert-*.ts` 覆盖；本批没有任何包碰 `tests/secure/**`。
> - **预检结果**：r2 的 spec 在 `b667d880` 上实测 exit 0。

```json
[
  {
    "id": "P1:docs",
    "globs": ["AGENTS.md", "docs/dev/*/README.md", "tests/docs/**", "skills/dev-flow/SKILL.md"]
  },
  {
    "id": "P2:dedup",
    "globs": [
      "src/core/redact.ts",
      "src/web-search/resilience.ts",
      "src/web-search/providers.ts",
      "src/quota/http.ts",
      "src/cache-ttl/ping-client.ts",
      "src/cache-ttl/pipeline-ping.ts",
      "src/ui/fleet-panel.ts",
      "src/archive/control.ts",
      "src/web-hub/hub/req-deadline.ts",
      "src/web-hub/hub/http.ts",
      "src/web-hub/hub/run-routes.ts",
      "src/web-hub/hub/lifecycle.ts",
      "tests/web-search/resilience.test.ts",
      "tests/cache-ttl/keepalive-ping.test.ts",
      "tests/web-hub/hub/req-deadline.test.ts"
    ]
  },
  {
    "id": "P3:dead",
    "globs": [
      "src/core/message.ts",
      "src/delivery/engine.ts",
      "src/extensions/worktree.ts",
      "src/extensions/worktree-settings.ts",
      "src/external-agent/droid/usage-fields.ts",
      "src/external-agent/droid/settings.ts",
      "src/memory/tidy/archive-signals.ts",
      "src/memory/tidy/batch-plan.ts",
      "src/memory/tidy/batch-settings.ts",
      "src/memory/tidy/index-edit.ts",
      "src/memory/tidy/journal.ts",
      "src/memory/tidy/lease.ts",
      "src/memory/tidy/manifest.ts",
      "src/memory/tidy/run-ledger.ts",
      "src/memory/tidy/selection.ts",
      "src/memory/tidy/txn.ts",
      "src/memory/tidy/ui/bounded-viewer.ts",
      "src/sysload/render.ts",
      "src/sysload/tracker.ts",
      "src/sysload/wire.ts",
      "src/sysload/gate.ts",
      "src/cache-ttl/measure-types.ts",
      "src/runtime/input-budget-registry.ts",
      "src/schedule/core/claim.ts",
      "src/schedule/core/occurrence.ts",
      "src/schedule/core/writer.ts",
      "src/todo/ui.ts",
      "src/web-hub/hub/avatar/fs.ts",
      "src/web-hub/hub/avatar/validate.ts",
      "src/web-hub/hub/spawn/history/index.ts",
      "src/web-hub/hub/spawn/history/snapshot.ts",
      "src/web-hub/hub/lan-security-stubs.ts",
      "src/web-hub/protocol/ui-manifest.ts",
      "src/web-hub/protocol/stop-marker.ts",
      "src/web-hub/protocol/rotate-intent.ts",
      "src/rpc/client.ts",
      "tests/rpc/**",
      "tests/web-hub/hub/lan-security-surfaces.test.ts"
    ]
  },
  {
    "id": "P6B:boundary",
    "globs": ["tests/boundary/**", "tests/web-hub/boundary.test.ts"]
  },
  {
    "id": "P6M:moves",
    "globs": [
      "src/service/cache-keepalive.ts",
      "src/cache-ttl/keepalive-service.ts",
      "src/cache-ttl/cache-ttl.ts",
      "src/cache-ttl/child.ts",
      "src/web-hub/agent/index.ts",
      "src/stack.ts",
      "src/index.ts",
      "src/tools/bash-tool.ts",
      "src/tools/bash-job-tool.ts",
      "src/bash/tool.ts",
      "src/bash/job-tool.ts",
      "src/bash/child.ts",
      "src/commands/status.ts",
      "src/tools/switch-context-tool.ts",
      "src/tools/compact-tool.ts",
      "src/tools/set-compact-threshold-tool.ts",
      "src/context-switch/tool.ts",
      "src/context-switch/child.ts",
      "src/compact-hint/compact-tool.ts",
      "src/compact-hint/threshold-tool.ts",
      "src/web-hub/agent/command-capture.ts",
      "src/commands/capture.ts",
      "src/commands/schedule.ts",
      "src/commands/fabric-xs.ts",
      "src/commands/webhub.ts",
      "src/memory/tidy/batch-command.ts",
      "src/ui/settings-editor.ts",
      "src/todo/index.ts",
      "src/web-hub/agent/command-usage.ts",
      "src/web-hub/agent/twofa-cmd.ts",
      "src/web-hub/agent/command-complete.ts",
      "src/web-hub/agent/command-record.ts",
      "src/web-hub/agent/users-cmd.ts",
      "src/web-hub/agent/builtin-bridge.ts",
      "tests/cache-ttl/fake-pipeline.ts",
      "tests/cache-ttl/cache-ttl.test.ts",
      "tests/cache-ttl/keepalive-traffic-veto.test.ts",
      "tests/cache-ttl/keepalive-late-usage.test.ts",
      "tests/cache-ttl/keepalive-child.test.ts",
      "tests/cache-ttl/keepalive-ping-retry.test.ts",
      "tests/cache-ttl/keepalive-evidence.test.ts",
      "tests/cache-ttl/keepalive-lifecycle.test.ts",
      "tests/cache-ttl/keepalive-pipeline.test.ts",
      "tests/cache-ttl/request-capture.test.ts",
      "tests/cache-ttl/warmth-port.test.ts",
      "tests/integration/keepalive-pipeline-service.test.ts",
      "tests/integration/cache-ttl-removal.test.ts",
      "tests/integration/child-keepalive.test.ts",
      "tests/conformance/keepalive-pipeline.test.ts",
      "tests/tools/bash-tool.test.ts",
      "tests/tools/bash-job-tool.test.ts",
      "tests/tools/bash-tools-golden.test.ts",
      "tests/bash/tool.test.ts",
      "tests/bash/job-tool.test.ts",
      "tests/bash/tools-golden.test.ts",
      "tests/tools/model-facing-strings.test.ts",
      "tests/integration/bash-auto-background.test.ts",
      "tests/tools/switch-context-tool.test.ts",
      "tests/tools/compact-tool.test.ts",
      "tests/tools/set-compact-threshold-tool.test.ts",
      "tests/context-switch/tool.test.ts",
      "tests/compact-hint/compact-tool.test.ts",
      "tests/compact-hint/threshold-tool.test.ts",
      "tests/integration/context-switch-wiring.test.ts",
      "tests/integration/compact-hint-wiring.test.ts",
      "tests/web-hub/agent/command-capture.test.ts",
      "tests/commands/capture.test.ts",
      "tests/web-hub/agent/command-capture-recorder.test.ts",
      "tests/web-hub/agent/capture-commands.test.ts",
      "tests/web-hub/agent/extension-async-late.test.ts",
      "tests/web-hub/agent/builtin-bridge.test.ts",
      "tests/web-hub/agent/real-command-matrix.test.ts",
      "tests/commands/webhub-2fa.test.ts",
      "tests/commands/webhub-user.test.ts"
    ]
  },
  {
    "id": "ext:#43",
    "globs": [
      "src/secure/bin/convert.mjs",
      "tests/secure/convert-*.ts",
      "tests/integration/traffic-lifecycle-process.test.ts"
    ]
  }
]
```

> - P1 的 `docs/dev/*/README.md` 会匹配到已有的 `external-agent/README.md`、`feishu-bot/README.md`（追加内容），这两份没有其他包碰。
> - r2 把 P6M 原来的 `tests/cache-ttl/keepalive-*.test.ts` 通配改成逐个列出。通配会和 P2 的 `keepalive-ping.test.ts` 撞车，而列出的文件就是 `rg -l 'service/cache-keepalive' tests --glob '!tests/fixtures/**'` 的结果。
> - 每个包开工前在最新 dev 上重跑一次预检，退出码必须为 0。

## 附录 B：交付物清单

- P1：新 `AGENTS.md`；新建 README 25 份（含 `docs/dev/subagent-core/`、`docs/dev/workflow/` 两个新目录）+ 追加 2 份；`tests/docs/agents-md.test.ts`（K0–K9）；按附录 C 逐块比对的守恒检查输出（含例外清单）；盲测 10 问的问答记录；consult 搬迁清单。
- P2：新文件 `src/core/redact.ts`，以及 11 个源码文件和 3 个测试文件的改动（`tests/web-search/resilience.test.ts`、`tests/cache-ttl/keepalive-ping.test.ts`、`tests/web-hub/hub/req-deadline.test.ts`）。
- P3：删除清单（每条附 §3.1 两条 rg 命令的输出）+「历史文档例外」一节 + 观察组清单。
- P6B：`tests/boundary/pi-free.test.ts`（AST 扫描器 + 自测），`tests/web-hub/boundary.test.ts` 的改动（B2 + B3），以及 5 项变异验证的记录。
- P6M：4 个 commit，每个附 `git diff -M --stat`、迁移测试相对导入的 existsSync 结果、旧路径 rg 结果，以及 (a)(b) 两类测试的结果。

## 附录 C：AGENTS.md 切块清单（守恒检查的唯一依据）

**块的划分**：每块从自己的「源标记」开始，到清单里下一个源标记为止，按**字符偏移**切，标记可以落在行中间。源文本是 P1 开工时 HEAD 的 AGENTS.md。条目标记都是行首形式 ``- `<路径>` —``，表里简写成路径；web-hub、fabric 内部的小节标记是原文里的加粗起始片段，已在 `b667d880` 上逐个确认全文只出现 1 次。「目标章节」是目标文件里为该块新建的标题，守恒检查按它定位。

**归一规则**（源和目标都做）：去掉列表项的 `- ` 前缀和两格续行缩进 → 只对源文本套 §4.3 路径替换表 → 所有空白归一成一个空格。归一后，源块必须是目标章节的**连续子串**。

### C.1 留在 AGENTS.md 的块

| 块  | 源标记                                                                                                                                                                                                                                                                                                                                                                                 | 目标（AGENTS.md 内）                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A0  | 文件头：`# AGENTS.md` 标题行与其后 `Guidance for AI coding agents…` 段（到 `## What this is` 之前）                                                                                                                                                                                                                                                                                    | 新文件头（`## What this is` 之前），独立比较并纳入覆盖性检查（评审 r2 复审 #4）                                 |
| A1  | `## What this is` 节前三段（节标题之后到第 3 段结束：`Do NOT "finish the rename" inside \`src/\`.`）                                                                                                                                                                                                                                                                                   | `## What this is`                                                                                               |
| A2  | `## Commands` 整节                                                                                                                                                                                                                                                                                                                                                                     | `## Commands`                                                                                                   |
| A3  | `` `index.ts` ``、`` `index.js` ``、`` `skills/` ``、`` `src/index.ts` ``、`` `src/stack.ts` ``、`` `src/child/` ``、`` `src/git/` ``、`` `src/config/` ``、`` `src/reload/` ``、`` `src/goal/` ``、`` `src/delivery/` ``、`` `src/adapters/` ``、`` `src/tools/`, `src/commands/`… ``、`` `tests/` ``、`` `docs/dev/` ``、`` `scripts/release/package.sh` `` 共 16 个短条目，各自一块 | `## Repository layout` 表格中对应行的「职责」格，原文换行并为空格；`docs/dev/` 那格在原文后追加一句 README 说明 |
| A4  | `## Conventions` 开头到 `reaches \`verified\`.`（peer 范围那条的前半）                                                                                                                                                                                                                                                                                                                 | `## Conventions`                                                                                                |
| A5  | `## pi-extension specifics` 整节                                                                                                                                                                                                                                                                                                                                                       | `## pi-extension specifics`                                                                                     |
| A6  | `## Testing expectations` 整节                                                                                                                                                                                                                                                                                                                                                         | `## Testing expectations`                                                                                       |
| A7  | `## Releasing` 整节                                                                                                                                                                                                                                                                                                                                                                    | `## Releasing`                                                                                                  |

### C.2 下沉块

| 块  | 源标记                                                                                                                           | 目标文件                                    | 目标章节                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| D01 | `What this is` 第 4 段开头 `It also absorbs eight formerly-standalone plugins` 到 `## Commands` 之前                             | `docs/dev/plugin-merge/README.md`           | `## 合并插件总览（原 What this is 第 4 段）`      |
| D02 | `` `src/core/` ``                                                                                                                | `docs/dev/subagent-core/README.md`          | `## src/core/`                                    |
| D03 | `` `src/runtime/` ``                                                                                                             | 同上                                        | `## src/runtime/`                                 |
| D04 | `` `src/service/` ``                                                                                                             | 同上                                        | `## src/service/`                                 |
| D05 | `` `src/ask-user/` ``                                                                                                            | `docs/dev/ask-user-async/README.md`         | `## src/ask-user/`                                |
| D06 | `` `src/feishu-notify/` ``                                                                                                       | `docs/dev/plugin-merge/README.md`           | `## src/feishu-notify/`                           |
| D07 | `` `src/bash/` ``                                                                                                                | `docs/dev/bash-timeout-grace/README.md`     | `## src/bash/`                                    |
| D08 | `` `src/compact-hint/` ``                                                                                                        | `docs/dev/compact-hint/README.md`           | `## src/compact-hint/`                            |
| D09 | `` `src/context-switch/` ``                                                                                                      | `docs/dev/context-switch/README.md`         | `## src/context-switch/`                          |
| D10 | `` `src/cache-ttl/` ``                                                                                                           | `docs/dev/cache-ttl-keepalive/README.md`    | `## src/cache-ttl/`                               |
| D11 | `` `src/fabric/` ``（到 `**Wake phase 1` 之前）                                                                                  | `docs/dev/fabric-cross-session/README.md`   | `## In-tree fabric`                               |
| D12 | `**Wake phase 1`                                                                                                                 | 同上                                        | `## Wake phase 1`                                 |
| D13 | `**Cross-session phase 2**`                                                                                                      | 同上                                        | `## Cross-session phase 2`                        |
| D14 | `**Request-reply`                                                                                                                | 同上                                        | `## Request-reply`                                |
| D15 | `**Channels + broadcast`                                                                                                         | 同上                                        | `## Channels + broadcast + unread inbox`          |
| D16 | `**Session aliases`                                                                                                              | 同上                                        | `## Session aliases`                              |
| D17 | `` `src/consult/` ``                                                                                                             | `docs/dev/consult/README.md`                | `## src/consult/`（文件首行是「#40 将删除」横幅） |
| D18 | `` `src/hud/` ``                                                                                                                 | `docs/dev/plugin-merge/README.md`           | `## src/hud/`                                     |
| D19 | `` `src/web-search/` ``                                                                                                          | 同上                                        | `## src/web-search/`                              |
| D20 | `` `src/todo/` ``                                                                                                                | `docs/dev/todo-web/README.md`               | `## src/todo/`                                    |
| D21 | `` `src/memory/` ``                                                                                                              | `docs/dev/memory/README.md`                 | `## src/memory/`                                  |
| D22 | `` `src/sysprompt/` + `src/prompt-sections/` ``                                                                                  | `docs/dev/sysprompt-stable/README.md`       | `## src/sysprompt/ + src/prompt-sections/`        |
| D23 | `` `src/session-nav/` ``                                                                                                         | `docs/dev/web-resume/README.md`             | `## src/session-nav/`                             |
| D24 | `` `src/web-hub/` ``（到 `**Web resume` 之前）                                                                                   | `docs/dev/web-hub/README.md`                | `## 概述与 P2 control-plane`                      |
| D25 | `**Web resume`                                                                                                                   | 同上                                        | `## Web resume (resume.v1)`                       |
| D26 | `**Feishu bot (`                                                                                                                 | `docs/dev/feishu-bot/README.md`（追加）     | `## 开发者要点：Feishu bot`                       |
| D27 | `**Cross-session mirror (`                                                                                                       | 同上                                        | `## 开发者要点：Cross-session mirror`             |
| D28 | `**UI serving`（含其中的 LAN access 段）                                                                                         | `docs/dev/web-hub/README.md`                | `## UI serving 与 LAN access`                     |
| D29 | `**LAN security (`                                                                                                               | 同上                                        | `## LAN security`                                 |
| D30 | `**Managed spawn (`                                                                                                              | `docs/dev/web-hub-spawn/README.md`          | `## Managed spawn`                                |
| D31 | `**Created dirs (`                                                                                                               | 同上                                        | `## Created dirs`                                 |
| D32 | `**Restore across hub restarts`                                                                                                  | 同上                                        | `## Restore across hub restarts`                  |
| D33 | `**Relaunch an offline`                                                                                                          | 同上                                        | `## Relaunch`                                     |
| D34 | `**Delete session (`                                                                                                             | 同上                                        | `## Delete session`                               |
| D35 | `**Worktree panel (`                                                                                                             | `docs/dev/web-hub/README.md`                | `## Worktree panel`                               |
| D36 | `**Bash-jobs panel (`                                                                                                            | 同上                                        | `## Bash-jobs panel`                              |
| D37 | `**Fleet drawer archive (`                                                                                                       | 同上                                        | `## Fleet drawer archive`                         |
| D38 | `**Cache keepalive panel (`                                                                                                      | 同上                                        | `## Cache keepalive panel`                        |
| D39 | `**Content preview (`（含 Admission / Upload attachments / Directories）                                                         | `docs/dev/web-hub-preview/README.md`        | `## Content preview`                              |
| D40 | `**Preview multi-windows**`                                                                                                      | 同上                                        | `## Preview multi-windows`                        |
| D41 | `**Chunked text preview**`                                                                                                       | 同上                                        | `## Chunked text preview`                         |
| D42 | `**Large-source virtualization**`                                                                                                | 同上                                        | `## Large-source virtualization`                  |
| D43 | `**HTML preview (rendered)**`                                                                                                    | 同上                                        | `## HTML preview`                                 |
| D44 | `**Worktree diff (`                                                                                                              | `docs/dev/worktree-diff/README.md`          | `## Worktree diff`                                |
| D45 | `**Worktree graph**`（含 R11-style upgrade gate）                                                                                | 同上                                        | `## Worktree graph`                               |
| D46 | `**Local-service proxy (`                                                                                                        | `docs/dev/web-hub-proxy/README.md`          | `## Local-service proxy`                          |
| D47 | `**In-page link preview (`                                                                                                       | 同上                                        | `## In-page link preview`                         |
| D48 | `**Avatar (`                                                                                                                     | `docs/dev/web-hub/README.md`                | `## Avatar`                                       |
| D49 | `**Privacy lock (`                                                                                                               | 同上                                        | `## Privacy lock`                                 |
| D50 | `**Channels in the web UI (`                                                                                                     | `docs/dev/fabric-cross-session/README.md`   | `## Web UI：Channels`                             |
| D51 | `**Aliases in the web UI (`                                                                                                      | 同上                                        | `## Web UI：Aliases`                              |
| D52 | `**Session switching (`                                                                                                          | `docs/dev/web-hub/README.md`                | `## Session switching`                            |
| D53 | `**Session history (`（到 ``**`prompt-gate.ts`**`` 之前）                                                                        | `docs/dev/web-hub-spawn/README.md`          | `## Session history`                              |
| D54 | ``**`prompt-gate.ts`**``                                                                                                         | `docs/dev/web-hub/README.md`                | `## prompt-gate.ts`                               |
| D55 | `- **Slash-arg completion**`                                                                                                     | 同上                                        | `## Slash-arg completion`                         |
| D56 | `- **Command history**`                                                                                                          | 同上                                        | `## Command history`                              |
| D57 | `` `src/topic-switch/` ``                                                                                                        | `docs/dev/topic-switch/README.md`           | `## src/topic-switch/`                            |
| D58 | `` `src/external-agent/` ``                                                                                                      | `docs/dev/external-agent/README.md`（追加） | `## 开发者要点（自 AGENTS.md 下沉）`              |
| D59 | `` `src/quota/` ``                                                                                                               | `docs/dev/quota/README.md`                  | `## src/quota/`                                   |
| D60 | `` `src/sysload/` ``                                                                                                             | `docs/dev/sysload/README.md`                | `## src/sysload/`                                 |
| D61 | `` `src/secure/` ``                                                                                                              | `docs/dev/data-encryption/README.md`        | `## src/secure/`                                  |
| D62 | `` `src/traffic/` ``                                                                                                             | `docs/dev/traffic-merge/README.md`          | `## src/traffic/`                                 |
| D63 | `` `src/schedule/` ``                                                                                                            | `docs/dev/scheduled-reports/README.md`      | `## src/schedule/`                                |
| D64 | `` `src/workflow/` ``                                                                                                            | `docs/dev/workflow/README.md`               | `## src/workflow/`                                |
| D65 | Conventions 中 `**Also run \`tests/conformance/traffic.test.ts\``到`**Also run \`tests/conformance/cmd-history.test.ts\`**` 之前 | `docs/dev/traffic-merge/README.md`          | `## Peer-bump conformance premises (traffic)`     |
| D66 | Conventions 中 `**Also run \`tests/conformance/cmd-history.test.ts\`**`到`## pi-extension specifics` 之前                        | `docs/dev/web-hub/README.md`                | `## Peer-bump conformance premises (cmd-history)` |

> 实施者在**合入时的 AGENTS.md** 上，先验证清单里每个源标记恰好出现 1 次；如果有新增的条目或小节（例如 #43 加了一段），在本表追加一行再切，不能让新内容落进相邻块里。

### C.3 例外（只有这些允许不逐字一致）

| #   | 例外                                                                                                               | 校验方式                                     |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| E1  | §4.3 路径替换：只替换源文本里出现的旧路径，属于机械归一，不算内容改动                                              | 报告列出每块里替换的次数                     |
| E2  | prettier 在新上下文里改了转义或强调符号（例如 `*` 和 `_` 互换）                                                    | 逐处列出「源片段 → 目标片段」，verifier 复核 |
| E3  | A3 `docs/dev/` 格在原文**之后**追加的一句 README 说明                                                              | 原文本身仍要完整命中                         |
| E4  | A4 之后补的一句「详见 §pi peer bump checklist」                                                                    | 同上                                         |
| E5  | 新写的内容：不变式 I1–I12、冻结物表、peer bump 检查单、表格的「职责」摘要（下沉块那些行）和「必读」列、README 头部 | 不参与守恒比对，由 K1–K9 和盲测覆盖          |

**覆盖性反向检查**：A1–A7 与 D01–D66 的源区间按偏移排序后必须首尾相接，恰好覆盖从文件开头到 `## pi-extension specifics` 之前的全部文本，加上 A5–A7 三节，不留空隙也不重叠。唯一不进任何块的是各 `## ` 标题行本身（目标里会重建）。

## 用户拍板（2026-10-25）

- Q8：① 先合，#40 以新布局为准（consult 段下沉到 `docs/dev/consult/README.md`，带「#40 将删除」横幅）。
- Q1–Q7：全部按推荐。
