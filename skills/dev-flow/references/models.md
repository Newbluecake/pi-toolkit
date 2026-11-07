# 模型路由细则（models.md）

SKILL.md 的「阶段→模型」表只给首选/回退；本文件是精确 ID、闸门、订阅优先规则与失败处置的完整口径，
以及各条规则背后的日期裁定。

## 模型 ID 速查表

`Agent` 的 `model` 必须用完整 `provider/modelId`；模糊别名会被 `subagent-model-hints` 扩展 block。

| 别名           | 精确 ID（按优先级）                                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sonnet         | `cr-anthropic/claude-sonnet-5-5` → `cr-anthropic/claude-sonnet-5`（2026-10-10 起 5.5 为首选，$3/$15 暂按 5 填；5.5 报错时降回 5 续跑）                                                                                                                                                                |
| kimi-k3        | `kimi-coding/k3-256k` → `kimi-coding/k3` → `cr-kimi/kimi-k3`（有订阅额度时按此顺序，失败按序回退）                                                                                                                                                                                                    |
| glm-5.3        | `zai-coding-cn/glm-5.3` → `zai/glm-5.3`（**订阅线；有余量时在候选阶段升为首选**，见下方订阅优先规则）→ `cr-glm/glm-5.3`（**API 按量计费备线**：两条订阅线报错/429/额度耗尽时换它续跑，不参与订阅优先升首选；走 openai-completions，单价暂按智谱官方 $1.4/$4.4，待核实）                               |
| opus-5.5       | `cr-anthropic/claude-opus-5-5`（**opus 档唯一档**：$4/$20）                                                                                                                                                                                                                                           |
| fable          | `cr-anthropic/claude-fable-5-1` ⚠️ **须 `ask_user` 批准后才可派**（$10/$50）                                                                                                                                                                                                                          |
| gpt-6.1-sol    | `copilot-response/gpt-6.1-sol` → `cr-response/gpt-6.1-sol`（2026-10-19 起 cr-response 恢复可用：copilot 报错/429/额度耗尽先换 cr-response 同模型续跑，两线都不行再按阶段回退链换模型；传输中断时 resume 重试；**禁止用于验收**）；$2/$10，cacheRead $0.1（6.1 起缓存读减半），>272k 输入 2×/输出 1.5× |
| deepseek-flash | `deepseek/deepseek-flash`（验收次选，2026-10-18 起替代 deepseek-v4-pro；与 Claude/GLM/Kimi 系异源；2026-10-27 起也可做代码探索，与 glm-5.3 并列）                                                                                                                                                     |

## 疑难升级阶梯（fable 闸门）

难度升级一律走这条阶梯，**不得跳级**：

```
sonnet → opus-5.5（疑难默认天花板） → [ask_user 批准] → fable
```

- **opus-5.5 是疑难问题的默认最高档**：架构设计、L3 方案制定、疑难 bug 定位、被打回两次的
  方案/开发任务，直接派 opus-5.5，不必请示。
- **fable 是受闸门保护的最后一档**：只有 opus-5.5 已经跑过并明确失败（方案被 reviewer 判
  Blocker、或同一问题连续 2 轮无进展）时才考虑，且**必须先 `ask_user` 拿到用户明确批准**，
  问句里要写清：为什么 opus-5.5 不够、fable 要解决的具体问题、预计成本（$10/$50，约 opus-5.5 的
  2.5 倍）。用户未点头就继续用 opus-5.5 迭代，不得自行升 fable。
- 例外：用户主动点名要用 fable 时视为已批准，无需再问。
- fable 只用于复杂任务（L3），常规任务禁止动用。

## 渠道与独立性规则

- **评审首选 gpt-6.1-sol ⇄ kimi-k3**：两者都与 Claude 系的方案/开发模型天然异源，保证评审独立。gpt-6.1-sol
  实测评审质量好；kimi-k3（`kimi-coding/k3-256k`，订阅）2026-10-26 用户令可做评审，与 gpt-6.1-sol 并列——多个方案
  并行评审时按包分摊，GPT 线 429/503 时直接改派 kimi-k3（kimi 开发/制定的方案不派 kimi 评审）。
  首选 copilot 渠道 `copilot-response/gpt-6.1-sol`，备线 `cr-response/gpt-6.1-sol`（同价，2026-10-19 用户令恢复
  cr-response；cr-response 不接受 reasoning `minimal`/`none`，最低用 `low`）。zhipu-pool 仍不使用；gpt-6-astra /
  gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 虽可调用，但未分配 dev-flow 角色，不进路由表。
- **验收禁用任何 GPT 系**（gpt-6.1-sol 等，任何线路；2026-10-14 用户令），任何情况下都不回退到 GPT 系。
  gpt-6.1-sol 开发的包（开发双首选，2026-09：与 sonnet 并列，多包并行时按包分摊——更便宜、上下文 1.05M），
  验收改派 Claude 系（sonnet）。
- **异源**：评审模型 ≠ 方案模型；验收模型 ≠ 开发模型，走回退链时跳过与被评对象同系的模型。开发用了 GLM 的包，
  验收不得再派 GLM（改 kimi-k3 / deepseek-flash / Claude 系）。
- **别因「列表里没有」静默换模型**：系统提示的可用模型列表优先取会话的 scoped models（pi settings 的
  `enabledModels`），没列进去的模型照样已注册、照样能派。按本表精确 ID 直接派，派发被拒才按回退链降级并明说原因
  （2026-10-10 教训：看列表没有就换模型顶替，单日传输失败 4 次）。

## 订阅优先规则

派单前参考系统注入的 [quota] 行：订阅额度窗口内不用就作废，**优先用完订阅**。L1/L2（预警）只是提示，
派单照常；只有 L3（≥90% 或即将耗尽）才跳过该 provider。

- **GLM 订阅优先（2026-10-07 用户拍板）**：zai 订阅有余量时，凡 GLM 在候选内的阶段（代码探索、
  开发实施、任务验收的回退链），GLM 升为该阶段**首选**，排在 sonnet / gpt 系等按量线之前；例外是异源约束（见上）。
  **前端开发不适用**（2026-10-24 用户令）：前端首选 kimi-k3（订阅），GLM 排第二。
- 其余 [quota] 给出的替代只是**候选**（按订阅优先排序）：额度层不知道任务需求，先判断候选是否胜任本阶段，
  胜任就优先用订阅，不胜任就按阶段表另选，不为用额度而硬凑。额度行不存在时按表中默认顺序。
- **kimi**：kimi-coding / zai 订阅常耗尽；额度耗尽或 L3 预警时回退按量线（cr-anthropic 等）默认顺序。
  **验证模型订阅将尽**（如 kimi 7d ≥80%）时，验收优先 deepseek-flash。
- GLM 仍在候选内的阶段可改派 `cr-glm/glm-5.3`（同模型、API 按量计费，按表中常规位次用，不升首选）。

### droid 订阅线（已移除）

2026-10-24 用户令：droid（`droid/<model>`）移出路由表，任何阶段都不派；`externalAgents.droid.enabled` 保持 false。
历史设计见 `docs/dev/external-agent/README.md`。

## 失败处置：传输故障 vs 安全策略拒绝

- **传输层故障**（stream 中断 / 502 / 503 / 0 轮无进展超时 / 模型侧「no model progress」timed_out）：
  直接 `resume` **同一个 run** 换线续跑，不必请示、不重派新 run。429 换线。
- **安全策略拒绝 ≠ 传输错误**（如 Anthropic「triggered restrictions on violative cyber content… Usage Policy」）：
  不自动按回退链重发原 prompt。主会话先判定被拦内容：
  1. **误拦**（任务本身正当，如分析自家代码的签名/鉴权逻辑、协议兼容、错误处理）→ 可改派异厂商模型续跑
     （glm-5.3 / kimi-k3 订阅优先），派单 prompt 写明正当目的与范围；
  2. 被拦部分**本身就是规避第三方风控/安全检测**（克隆客户端 TLS 指纹、伪造遥测/心跳流量、为躲检测做的外观伪装等）
     → 从任务中剔除该部分、向用户说明后再派，**不得换模型重发原任务**。
     两种情况都在汇报里明说被拦及处置。
- 例（2026-10-14）：droid 对齐方案 opus-5.5 被拦，剔除 TLS 指纹/header 外观/心跳三项后改派 kimi-k3。

## 日期裁定索引

| 日期       | 裁定                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| 2026-09    | 开发双首选 sonnet ⇄ gpt-6.1-sol                                          |
| 2026-10-07 | GLM 订阅优先                                                             |
| 2026-10-10 | sonnet-5-5 升首选；教训：不因列表缺失而换模型                            |
| 2026-10-14 | 验收禁 GPT 系；安全拒绝与传输错误分开处理                                |
| 2026-10-15 | gpt-6.1-sol 仅 copilot 渠道；移除 cr-response/zhipu-pool；droid 进路由表 |
| 2026-10-20 | droid 线以 Available models 是否列出为准；不可用（未登录等）整条跳过     |
| 2026-10-16 | L1 加异源 verifier；验证模型订阅将尽优先 deepseek-v4-pro（见 SKILL.md）  |
| 2026-10-18 | 验收次选 deepseek-v4-pro → deepseek-flash（用户要求）                    |
| 2026-10-19 | cr-response 恢复：gpt-6.1-sol 备线 `cr-response/gpt-6.1-sol`             |
| 2026-10-18 | 第 0 步改为主会话 ask_user 轻量澄清；dev-clarify 降为可选（用户要求）    |
| 2026-10-24 | 前端开发 kimi-k3 首选、GLM 次之；droid 移出路由表（用户令）              |
| 2026-10-24 | 方案制定回退链加 kimi-k3（sonnet 之后；用户令）                          |
| 2026-10-27 | 代码探索加 deepseek-flash，与 glm-5.3 并列（用户令）                     |
