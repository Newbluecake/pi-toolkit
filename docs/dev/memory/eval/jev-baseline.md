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

## 4. 待办（阶段二，J2 合入后）

- 拦截（24 条）、整理（20 对）按 `questions.ts` 的正式模板重跑；确认门禁阈值 0.6。
- 打标按 J1 定稿的类型描述重跑。
- `PI_TOOLKIT_JEV_CONFORMANCE=1` 跑 C-J7 真实调用、C-J8、C-J15。
