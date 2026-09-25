---
name: agent-handoff
description: 多 agent 串行协作时的结构化交接规范——让上游 agent（探索/调研）产出带文件坐标、证据、已排除方案的结构化交接包，下游 agent（设计/开发/评审）按图有选择地核验，而不是重新调研一遍。当调度方要把一个 agent 的结果转给下一个 agent、串行派发「探索→设计→开发」、发现下游 agent 在重复上游的调研、或用户提到交接/handoff/结构化交接/重复调研/上下文转接时使用。
metadata:
  scope: user-level
  evidence: pi-toolkit docs/dev/fabric-v2/baseline-results.md（3 轮对照实验）
---

# 结构化交接（agent-handoff）

## 为什么

对照实验（同一任务、同一模型，唯一变量是交接方式）的结论：

| 交接方式                    | 下游成本        | 游荡文件（上游没碰过的文件）                |
| --------------------------- | --------------- | ------------------------------------------- |
| 只转结论文字                | 基线            | 5–13                                        |
| **结构化交接包 + 核验纪律** | **−34% ~ −53%** | **0–1**                                     |
| 结构化交接包、不给核验纪律  | 最便宜          | 3，但几乎不核验（2 次读文件）⇒ **盲信风险** |

- 省下来的是「找」，不是「读」：下游仍会重读关键文件，但不再四处游荡、grep 摸索。
- **收益来自 `fileIndex`（坐标地图）**，结论叙述本身帮助有限。
- **核验纪律不能省**：只给交接包、不给核验指令时，下游会直接照抄上游结论——最便宜，但会把上游的错误原样传下去。

## 什么时候用

- 串行链路中，下游要在**同一块代码区域**继续工作（探索→设计、设计→实现、实现→评审）。
- 不必用：一步就能完成的小任务；或下游工作区域与上游基本不重叠。

## 第 1 步：派发上游，要求产出交接包

用 `Agent` 的 `schema` 参数强制结构化产出，**同时**让上游把同一份 JSON 写到文件（下游从文件读，调度方不必复述，也保证逐字节一致）。

在上游 prompt 末尾追加：

```text
## 交接包
完成后，先用 bash 把交接包 JSON 写到 /tmp/handoff/<label>.json（mkdir -p），再用 StructuredOutput 提交同一份 JSON。
- fileIndex：你读过的**每一个**相关文件，readFully 如实标注（只看了片段就填 false 并写 lines）；
- evidence：每条关键结论都要有 file + lines 出处；
- ruledOut：你排查过、确认**不是**答案的文件或思路，以及排除理由（这是最容易被遗漏、却最能省下游时间的部分）；
- openQuestions：你没能确认的点，不要把猜测写进 conclusion。
```

`schema`（直接作为对象传入即可）：

```json
{
  "type": "object",
  "required": ["conclusion", "fileIndex", "evidence", "ruledOut", "openQuestions"],
  "properties": {
    "conclusion": { "type": "string", "description": "结论正文，可含分点" },
    "fileIndex": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["path", "role", "readFully"],
        "properties": {
          "path": { "type": "string", "description": "仓库相对路径" },
          "role": {
            "type": "string",
            "description": "这个文件在本问题里的作用、关键符号"
          },
          "readFully": { "type": "boolean" },
          "lines": {
            "type": "string",
            "description": "readFully=false 时读过的行段"
          }
        }
      }
    },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["claim", "file", "lines"],
        "properties": {
          "claim": { "type": "string" },
          "file": { "type": "string" },
          "lines": { "type": "string" }
        }
      }
    },
    "ruledOut": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["target", "why"],
        "properties": {
          "target": {
            "type": "string",
            "description": "被排除的文件/函数/思路"
          },
          "why": { "type": "string" }
        }
      }
    },
    "openQuestions": { "type": "array", "items": { "type": "string" } }
  }
}
```

> 注：pi-toolkit 在 2026-09-24 修复了「模型把 schema 传成 JSON 字符串导致 run 0ms 崩溃」的问题；旧会话需 `/reload` 后生效。
> 若 `schema` 不可用，退化为在 prompt 中要求 ```json 代码块，调用方自行解析校验。

## 第 2 步：派发下游，附带交接包与核验纪律

下游 prompt 中加入（**两段都要，缺一不可**）：

```text
## 前序 agent 的交接
前一个 agent 已经对这条链路做过完整探索，它的结构化交接包在 /tmp/handoff/<label>.json
（字段：conclusion / fileIndex / evidence / ruledOut / openQuestions），请先读它。

交接纪律：fileIndex 中标 readFully: true 的文件已被完整读过，ruledOut 中的路径/思路已被排查并排除。
除非你有具体理由怀疑，否则不要重读这些文件、不要重走这些死路。
你的方案所依赖的关键结论，请按 evidence 给出的 file + lines 有选择地核验；openQuestions 中的点必须自己确认，不能当作已知。
```

- 第一段（交接纪律）实测会把下游的注意力引向 `fileIndex`，使其**按图核验**；
- 第二段（核验要求）防止盲信。⚠️ 这一句是根据「无纪律 ⇒ 盲信」的发现**补加的**，实验中没有单独测过，属于合理推断而非实测结论。

## 第 3 步：调度方自检

- [ ] 上游交接包的 `fileIndex` 条数是否合理（明显偏少 ⇒ 上游可能没如实登记，让它补）；
- [ ] `ruledOut` 不为空（一次正经的探索几乎总会排除一些东西）；
- [ ] 下游 prompt 两段都在；交接包从文件读，没有由调度方手工改写。

## 可选：让下游能向掌握知识的 agent 请教

实验结论（pi-toolkit `docs/dev/fabric-v2/baseline-results.md` §15–17）：

- **请教形态决定模型会不会问**：要求「结束本轮、等调度方中继」时 0/2 请教；改成**轮内同步**（一次 `Agent` 调用当轮拿到答案）后 **5/5 自发请教**；
- **只在信息读不到时才值得问**：代码里能读到的东西（文件位置、调用链），模型宁愿自己 grep——这是理性的；
  读不到的东西（**拍板过的决策、否决过的方案及理由、用户偏好**），不给获取渠道时下游会被现有代码带偏（质量 2.0/7），能请教时回到 6.5/7，接近直接推送（7.0/7），每次请教约 $0.01；
- **暗示存在但不给渠道最糟**：告诉下游「有决策未展开」却不给请教渠道时，它会去翻会话记录等不该碰的地方。

- **长上下文的真实上游 agent 同样答得准**：专家读完 84KB、正文与修订互相矛盾的方案后被 resume 请教，3/3 按最终修订作答、从未把作废决策当现行，下游评分 7.0/7；单次请教约 $0.1；
- **调用出错是真实风险**：通用 `Agent({resume})` 下，1/4 的下游漏写了 `resume`，结果问了一个一无所知的新 agent，后者跑去别处搜索来编答案。

落地方式：

1. **首选仍是推**：决策类、读不到的知识，能写进交接包就写进去（它最稳，7.0/7）；
2. **补充用拉：consult 工具**（pi-toolkit 内置，`consult.enabled` 默认开）。派发下游时传
   `Agent({ ..., experts: ["<上游 label 或 run_id>"] })`，下游就会多出一个 `consult(expert, question)` 工具，
   轮内同步拿到专家答案。它代替了早先「`can_spawn` + `Agent({resume})`」的活法，并解决了其三个坑：
   - **不会问错人**：白名单在派发时就解析成 run，下游只填专家名 + 问题（旧法 1/4 漏写 `resume` 问到新 agent）；
   - **跨 `/reload` 可用**：专家索引从会话条目重建（旧法 resume 的 run 记录是内存态）；
   - **可并发**：每次请教 fork 一份专家会话，用完即删；专家原会话字节不变。

   约束：专家必须**已结束**；专家在 consult 里**只有只读工具**（read/grep/find/ls），结论先行、≤ 2000 字；
   只有子 agent 能 consult（主会话没有这个工具，只负责在派发时授权 `experts`）；有轮数/成本帽（默认 3 轮、$4，
   首请求预检 $2）。实测（2026-09-25，glm-5.3 专家）：专家凭原上下文 1 轮零工具作答、10s，请教链路合计 < $0.05；
   专家若是 Claude，首轮要把整段专家上下文写进缓存（实测 19k token ≈ sonnet $0.07，长会话按比例涨）。
   下游的 consult 工具描述会**自动列出**每个专家的 label、类型、模型、是否已结束和原始任务摘要（约 160 字），
   prompt 里不必再报专家名字；只需补充摘要看不出的信息，并说明哪类问题该问（拍板过的决策、否决理由、用户偏好）。

3. 如果不提供请教渠道，就**别在 prompt 里暗示存在它拿不到的信息**。

## 反模式

- 只转一段结论文字 ⇒ 下游不知道去哪看，只能重新摸索；
- 只给交接包、不给核验纪律 ⇒ 便宜但盲信；
- 调度方自己重写/摘要交接包再塞进 prompt ⇒ 丢坐标、费调度方上下文，且各下游拿到的版本不一致。
