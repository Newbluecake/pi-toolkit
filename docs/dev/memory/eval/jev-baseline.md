# Jev 评测基线（E0，阶段一）

> 主会话，2026-10-30。脚本 `scripts/dev/jev-eval.mjs`，数据集 `docs/dev/memory/eval/`。调用：OpenCode Zen（`opencode/jev-1.13` 付费档、`opencode/jev-1.13-free` 免费档），经 HTTP 代理（本机直连出口被按地区拦截，返回 451）。
> 阶段一只跑召回与打标：拦截、整理两套评测的出题模板与架构稿 §6.4.3 / §6.3.3 不一致（脚本用两道 bool，架构稿是 choice），等 J2 落地 `questions.ts` 并加一致性测试后再跑（阶段二）。

## 1. 召回（U 层）

数据集：原 40 条（34 正 / 6 负，负例均为明显无关）+ 主会话补充 10 条**难负例**（同领域、字面沾边、但对处理请求无帮助）= 50 条。

### 1.1 措辞 A/B 对比（`jev-1.13`，50 条）

- 措辞 A（架构稿 v2.1 原文）：「Must the assistant know or apply this entry to handle user_message?」；true = must be applied now，false = unrelated or only loosely related。
- 措辞 B（Q36 采纳）：「Would reminding the assistant of this entry right now help it handle user_message correctly or avoid a known mistake?」；false = unrelated, or only shares surface keywords。

| 措辞  | 阈值    | 正确      | 漏召回（/34） | 误召回 | 难负例最高 p |
| ----- | ------- | --------- | ------------- | ------ | ------------ |
| A     | 0.7     | 43/50     | 7             | 0      | 0.11         |
| A     | 0.5     | 46/50     | 4             | 0      | 0.11         |
| B     | 0.7     | 45/50     | 5             | 0      | 0.15         |
| **B** | **0.6** | **46/50** | **4**         | **0**  | 0.15         |

结论（Q36）：措辞改 B、阈值 0.7 → 0.6。

### 1.2 采纳后的正式结果（措辞 B、阈值 0.6）

| 模型          | 正确  | 失败项（p）                            |
| ------------- | ----- | -------------------------------------- |
| jev-1.13      | 46/50 | r05 0.40、r07 0.09、r26 0.48、r37 0.32 |
| jev-1.13-free | 46/50 | r05 0.51、r07 0.09、r26 0.52、r37 0.33 |

两档结果一致（免费档可作默认首位）。残留失败的性质：

- **r37**（「HUD 加个旋转图标」↔「否决 ↻ 图标」）：「之前否决过」类记忆，Jev 联想不到。可考虑在整理或写入回显中提示把否决类决定写成 `rule` 并带场景标签，让 A 层快速通道兜底。
- **r07**（「bash 没有 host view attached」↔ jiti 缓存陈旧）：需两步推理，分类器不擅长。
- **r05、r26**：p 在 0.4–0.52，处于阈值边缘。

### 1.3 观察

- Jev 区分「字面沾边」与「有帮助」能力强：10 条难负例在两种措辞下都 ≤ 0.15。
- 早先手测时沾边条目出现 0.45–0.5，是手写措辞过松（「相关、值得提醒吗」）所致，不代表架构措辞下的分布。
- 单条召回约 $0.000018（632 token 量级）；本阶段全部评测花费 < $0.01。

## 2. 打标（m_type / m_importance）

30 条，判定标准：类型完全一致且重要度误差 ≤ 1。

| 模型          | 通过  | 失败项                                                        |
| ------------- | ----- | ------------------------------------------------------------- |
| jev-1.13      | 22/30 | k13、k14、k15、k16、k27 判为 pitfall；k18、k20、k21 判为 fact |
| jev-1.13-free | 22/30 | 同上                                                          |

失败全部是**类型**分歧（重要度都在容差内）。类型描述将在 J1（`taxonomy.ts` 定稿 `ENTRY_TYPES` 描述）之后用正式模板重跑，若仍偏低再调描述文本；打标不影响召回（召回现场判定）。

## 3. 脚本修复记录（主会话）

J0 交付的 `jev-eval.mjs` 在联网模式下有三处问题（验收员只跑了 `--dry-run`，未覆盖）：

1. 代理隧道：`createConnection` 返回 Promise（Node `https` 不支持），且 `agent: false` 使 `createConnection` 被忽略 ⇒ 对代理端口直接做 TLS 握手失败。改为回调形式 + `tls.connect({socket, servername})`，并去掉 `agent: false`。
2. 打标题目 id 双重前缀（`m_m_type`）⇒ 答案全部缺失。
3. 费用恒为 $0：脚本直连 System One，未按目录价计算（未修，以 pi `ModelRuntime` 的 usage 为准）。

> 提示 J2：pi-free 代理 fetch 的实现要避开第 1 条的两个坑。

## 4. 阶段二（J2 合入后，2026-10-31）

评测集按架构语义重建（拦截：每例 = 真实规则 + 调用 + 现场证据 → `unrelated`/`applies`/`violates_now`，38 例；整理：五选一关系，30 对），题目与 `src/memory/jev/questions.ts` 逐字一致（`questions-eval-parity.test.ts` 钉住）。旧评测集（只有命令或合并布尔）的 17/24、15/20 作废。

### 4.1 拦截（38 例，阈值 0.6）

| 模型          | 关系判对 | 最终动作判对 | 漏拦（该拦放行）           | 误拦（不该拦拦了） | hold 降为拦一次      |
| ------------- | -------- | ------------ | -------------------------- | ------------------ | -------------------- |
| jev-1.13      | 31/38    | 34/38        | 0                          | 1（g07 `echo`）    | 2（g14 v=0.55、g23） |
| jev-1.13-free | 29/38    | 31/38        | 1（g02，a+v=0.58，提醒类） | 2（g07、g08）      | 2（同左）            |

- 「最终动作」按 arch §6.4.4 判定表换算：非 hold 规则下 `applies` 与 `violates_now` 都是拦一次，因此 g25/g27/g29 的关系分歧不改变动作。
- 误拦都发生在发版进行中、命令文本里出现 `git commit`/`git tag` 字样的 `echo`/`grep`：模型被证据带偏。代价是拦一次（模型可以说明理由后重试），可接受。
- 把 v 阈值降到 0.5 只能救回 g14，会增加误拦；**门禁阈值维持 0.6**。

### 4.2 整理（30 对）

两模型都是 25/30，错题相同（v01 判 conflict、v08/v09/v19 判 complementary、v10 判 duplicate），属于标注边界模糊。整理只出建议、须用户确认，风险低。

### 4.3 打标（30 条，J1 定稿的类型描述）

两模型 22/30，错题与阶段一相同：5 条「事实」判为「坑」（条目都来自 `pitfalls-*.md`，内容是已知失败与绕法，判断站得住），k26 偏好判为规则，k16 类型对但重要度偏高。类型分歧只在 rule/procedure 与其它类型之间才影响守护，这里不涉及；**不改 `ENTRY_TYPES` 描述**。

### 4.4 一致性测试与 C-J8 实测

- `PI_TOOLKIT_JEV_CONFORMANCE=1 npx vitest run tests/conformance/memory-jev-channels.test.ts`：14 通过、1 跳过（门控项是占位，真实调用由本节手工完成）。
- **C-J8 上下文超限措辞**（两模型一致）：state 约 340KB ⇒ `HTTP 400 {"detail":{"error_type":"max_tokens_exceeded"}}`，即 pi 侧错误文本 `System One API error (400): {"detail":{"error_type":"max_tokens_exceeded"}}`。arch 预设的三个关键词都匹配不上，原先会被归为瞬态（计熔断、不拆批）；已在 `health.ts` 的 `CONTEXT_RE` 加 `max_tokens_exceeded` 并补测试。
- 900 道题（约 167KB，state 很小）照常返回：超限主要由 state 体积触发，问题数量影响小。
