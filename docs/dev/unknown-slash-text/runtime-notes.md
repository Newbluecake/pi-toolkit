# #40 runtime notes · 已合并至 Web Hub README

2026-11-06：#41/#42 作者已正式交付并释放 README/唯一 Web build owner；root 授权后，Unknown slash text 正文已合并至 [Web Hub README](../web-hub/README.md)「Slash-arg completion」之后、「Command history」之前，并加入目录项。#41 已有 Activity rail 整节与其他旧内容保持原字节/顺序。本文件只保留交接状态，运行时说明以该 README 为唯一副本，不再是待合并 TODO。

合并内容包括默认 optional `unknown-slash-text.v1`、严格/legacy classifier 边界、权威 UNKNOWN＋effect:none 一次 A→B、已知错误零 fallback、W3 narrow guard、Web commands-off 原路、旧 agent 缺 token 保守拒绝、飞书 enabled-only bot 名单与不同输入来源的 parser/trim 语义。明确 pi 1.4.0 取证范围；#45 的 pi 1.5 独立 clone 适配未集成，不能当作全版本保证。

root 的冻结面裁定现覆盖五个具名比较测试：`fabric-xs-off-golden`、`fabric-xs-reply-off-golden`、`fabric-xs-channel-compat`、`thread-off-golden`、`thread-rebind-off-golden`。历史比较先断言新 token 恰一次，仅 strip 该正交 token；其他 features/XS/thread 字段与帧顺序仍完整比较；默认 on 原始 features 另精确 pin。所有 fixtures 不改，本轮未编辑这些测试。

Sonnet #40 验收（run_id: r_6GC10YKQ）已 conditional 通过，无安全/正确性 blocker；剩余两项 root 待办是本轮 README 合并及最终共同 Web 门禁。此轮仅改三个授权 docs，不维护 Todo、不改源码/测试/规则、不 git 写/安装/全量测试。最终共同 bundle 的门禁与 freeze SHA 记录在 plan 的本轮交接段，交回后不重复构建，以免干扰使用同一 bundle 的 UI verifier。

## 本轮门禁与冻结产物（已完成）

README 合并、三 docs 精确格式/diffcheck 均已完成；唯一一次 build:web/check:web exit 均为 0，日志 `/tmp/40-final-web-gates.log`。freeze SHA（build-info manifest）=`56d47a0555716e07deb0f9190c2d20aaae960c73c97f3a109e4690b7fe22c0c7`；主 bundle `assets/index-CYbcitnd.js` SHA=`428a11dfa66539414fd560b5b86b06410e517b12025ebf74e6f904a00e41480b`。该包明确包含 #40 token/UNKNOWN 与 #41 activity rail/peek/docked 标记；3565 份 src/tests/AGENTS 前后内容 hash 不变，未改构建门禁规则。

产物已冻结，不再反复 build；browser verifier 继续使用同 bundle。详情与精确 README diff 路径见 plan §7。两项 root 待办在作者侧已补齐，待 root resume Sonnet 原验收核闭合后 commit，未擅自宣称最终验收通过。

## Full Tier1 7 fail / 5 files 的测试期望闭合

root 在 #41/#42 提交 efdcb828 后授权补齐五个测试，未重新修改 runtime 或任何 fixture。遗漏第六个比较消费者 reload-result-compat 仅在历史浅拷贝投影剥具名 token；live features 精确 pin、token 恰一次、status 规范 JSON 原字节断言、非 status 原 string/D6 reload-only 与插入帧规则均保留；capture 不得再生成 fixture。raw fixture SHA-256=`65a6dcd638096f553c34da8f94d55486a67a5b78ecf258c767a78680c18b46af`。

Feishu 的原文边界明确为既有 inbound 归一化后的正文：群消息有 @mention 时 `inbound.ts:271-273` 先去 mention 再 trim 首尾。新增真实 decoder 固定字面量断言以及 parser/dispatch 同字面量断言，并以非 slash 普通 control 独立证明相同归一化；不让 expected 单纯来自 decoder 形成同错镜像。内部换行/空格及 /reload 文本保留，DM 原文尾空白继续由单独测试保留。disabled schedule/threads 的普通 prompt 只派发一次，不执行 pi 命令，不新生对应 timer/port/state key/push；known bot 坏参数 help、权限/绑定拒绝及其他契约不变。

本轮本包不跑 full tiers 或 build:web；共享 bundle 后续被其他写入更新的事实见下方并发审计，不再声称仍为上节历史 freeze SHA；日志与最终定向 gate 数量见 plan 的本轮交回记录，交 root resume 原 Sonnet 检查 7 fail 是否闭合后再提交 #40。

测试期望补齐的最终结果：5 files / 79 tests passed（`/tmp/40-tier1-fix-five-final.log`），并完成原29＋新增5文件联合34 files / 927 tests passed（`/tmp/40-tier1-fix-final34.log`）。typecheck、精确7文件格式/diffcheck通过；reload raw fixture hash 保持不变。仍未重跑 fullTier1/构建Web，未改任何 runtime 或 fixtures；等待 root resume Sonnet 核7 fail闭合，不以定向绿冒充全量已绿。

本轮冻结域审计还检测到 4 份**非本包写入**的并发变化：`docs/dev/memory-governance/pg-report.md`、`docs/dev/web-hub/README.md`、`src/web-hub/ui/src/styles/fleet.css`、`tests/web-hub/ui/activity-rail.test.ts`。已向 root 报告归属核验，本包不修改或回滚它们；不能把共享树审计描述为“所有其他文件完全未变”。本包 write 路径仍严格是授权 5 tests＋2 docs。本包未重建 bundle；但终审检测主树产物已由其他写入更新（builtAt=`2026-11-06T11:03:34.881Z`，manifest SHA=`1deddb5848295fbe28861524c6fd227f55fa2f5f6e821c6a33171de71bf79a36`，main=`assets/index-BZb2aB5Y.js`），已另报 root 核归属，不把历史 freeze SHA 宣称为当前共享树状态。
