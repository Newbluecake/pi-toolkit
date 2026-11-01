# Jev 真机验收报告

- 日期：2026-11-01；HEAD：`64af0452`（dev）
- 环境：`/tmp/jev-acc`（已删除）：`PI_CODING_AGENT_DIR` 指向隔离 agent dir（`auth.json`/`models.json` 符号链接只读 `~/.pi/agent/`），`ARMORY_MEMORY_ROOT` 指向独立 memory 根，cwd 为 scratch git 仓库（无 remote），`scripts/release/release.sh` 为假脚本（`echo start; sleep 600`）；代理 `http://192.168.32.38:7897`；模型 `zai/glm-5.3 --thinking low`；分类器 `opencode/jev-1.13-free`、`opencode/jev-1.13`。
- 花费：主会话约 $0.43（含一次子 agent $0.16，均为壳模型调用，非 Jev）；Jev 自身调用约 20+ 次、累计 **$0.0000–$0.0001**（`/mem jev` 全程显示 `$0.0000 / $0.50`，分类器调用极便宜）。
- 清理：`tmux kill-session` 已执行；`/tmp/jev-acc` 已按确切路径 `rm -rf` 并确认不存在；`~/.pi/agent/memory/` 下确认无 `-tmp-jev-acc*` 残留目录。

## 环境阻塞问题（影响判定范围，务必先读）

真实 `classify()` 调用对两个 `opencode` 分类器**持续**失败，错误形如：
`System One API error (200): {"model":"...","answers":{"probe":{"type":"noul","noul":0.9}},...}`
（HTTP 200，`answers` 字段本身合法——`noul` 是 System One wire 协议对 `bool` 的正确编码，见
`node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js:48-56`）。后期甚至观察到返回
**完全合法的 `choice` 类型答案**（`{"type":"choice","choice":"unrelated","confidence":0.98,...}`）
仍被判为失败。根因在 host 的 `@earendil-works/pi-ai` 包内部（不在 `pi-toolkit/src/memory/jev/**`
范围），超出本次验收可改动范围，**已通过 message_agent 向 root 报告**。连续失败 3 次后两家分类器
进入 `transient` 隔离（60 分钟），状态从 `probing` 固定为 `partial (transient)`，本次会话内**标签
打标从未成功一次**（`tags 0/8 tagged` 全程不变）。

**判定范围影响**：依赖"至少一次成功打标"的项目（#2、#3 的 U 标记、#5 的真实标签 A 快速通道、#10 的
`recovered`、#16 的实际建议）无法在 full 态下验证；不依赖成功 classify 的路径（off/legacy/empty-list/
nogate/gate=hold 的证据兜底/到期/用户令守卫/子会话装配/预算耗尽/451 降级）均可正常验证且结果良好。

## 逐项结果

| #   | 场景                     | 结论                         | 一句话证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首次可用 full            | 部分通过                     | 两次真实 classify 均失败，状态停在 `probing`，从未弹出 `jev on` 通知；`/mem` 显示 `jev: probing · 0/7 tagged`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | 存量打标                 | 未能验证（环境限制）         | `tags 0/N tagged` 全程未变化，classify 从未成功过一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | U 召回                   | 未能验证（环境限制）         | 全程未出现 `── mem U: … ──` 标记（召回依赖已打标条目，本环境无一条打上标）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | 写入打标回显             | **通过**（降级路径）         | 新建 `notes.md` 写入经验后回显 `jev: not tagged (partial: transient) — fast path will not see this entry until tagged; inline tags=+… works now`，符合 partial 下的设计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | A 快速通道               | 未能验证（环境限制）         | `gh pr create --help` 未触发任何 `── mem A: … ──`（无已打标条目可推送）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | 门禁拦一次               | 未能验证（环境限制，非 bug） | push 规则 `<!-- mem user -->` 未加 `gate=hold`/`gate`，`guarded` 依赖 Jev 打分（`guard>=0.7`），未打标前恒为 `false`（`src/memory/jev/decide.ts:48-54`），因此 gate 从不拦截——这是设计内行为，不是缺陷，但本环境无法走到"已打标后生效"的那一步                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | release.sh hold          | **通过**（完整闭环）         | 后台跑假 `release.sh`，`git commit` 被 `[memory gate·hold] 本次 bash 调用未执行：Jev 未判定（partial），按证据拦截——规则「core.md #2」...` 拦下；kill 掉后台任务、通知到达后自动重放提交成功（`[dev 1361c4a] t3`）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | release.sh 另一终端      | **通过**（Linux 部分）       | 同 #7 在 Linux 上验证一致拦截；macOS 分支未测（本环境是 Linux，`/mem jev` 显示 `evidence process: bash jobs + /proc (Linux)`，与另一终端场景逻辑相同，未单独起第二终端复测）                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | partial (451/402)        | **通过**                     | 去掉代理后 `/reload`：`Warning: jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（0/7）。/mem jev（451 多为地区拦截，可设 memory.jev.proxy）`；`/mem jev` 显示 `enabled · partial (451) · next probe HH:MM`，stopped/running 两栏齐全                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | 恢复                     | 部分通过                     | 恢复代理后 `/mem jev probe` 正常触发探测（`jev: probe → enabled · probing`），但因环境问题从未等到真正的 `full`/`jev recovered`，无法验证该文案与补打标                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | inactive（无凭证）       | 跳过（需用户）               | 需要一台/一个账户完全没有分类器凭证，本环境有 opencode 凭证，交给用户在合适环境验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12  | off：总开关              | **通过**                     | `enabled=false` + `/reload`：`/mem` 无 jev 行，`/mem jev` 无输出（不报错，静默，等同"无 jev 子命令"）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 13  | off：legacy              | **通过**                     | `layout="legacy"` + `/reload`：启动无任何 jev 相关提醒，`/mem` 无 jev 行，与 #12 一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | secure 域强制关闭        | 跳过（需用户）               | 需要 `pi-secure run <vault>` 交互式建库/解锁，按任务要求留给用户在场验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 15  | 代理键凭证打码           | 部分通过 / **发现**          | `proxy="http://user:pass@…"` 连接成功（代理不校验账密），未触发任何代理错误；代码走查确认：`src/memory/jev/proxy-fetch.ts` 的 `redactProxyUrl()` **全仓没有任何生产调用点**（仅 `tests/memory/jev/proxy-fetch.test.ts` 用到），`client.ts`/`command-port.ts` 所有代理相关错误文案（`proxy error: …`、`CONNECT failed (403)`、`timeout after 20000ms`）均不含原始 URL，`config.proxy` 原始值也从未在任何 `/mem`/`/mem jev`/`/agent settings` 路径回显。结论：不会泄漏凭证（因为压根没有任何路径显示过代理值），但文档/plan 承诺的"代理凭证显示为 `http://***@host:port`"这一具体行为**目前没有代码路径会触发**，`redactProxyUrl` 是测试覆盖但未接线的死代码 |
| 16  | 整理                     | 未能验证（环境限制）         | `intervalDays=0` 后 `/mem review --run` → `jev: review run failed (all-failed: all configured classifiers failed for this call)`；`/mem review --list` → `review: no suggestions`（配对判断需要两次成功 classify，本环境无法达成）                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | 到期                     | **通过**                     | 写 `<!-- mem expires=2026-10-01 -->` 后 `/mem expired` 弹出 `expired · expired — expiring.md: "..."` 带 Delete/Extend/Clear/Skip；选 Extend 后文件注释自动改为 `expires=2026-12-01`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 18  | 用户令守卫               | **通过**                     | agent 尝试用 `memory` 工具改写用户令规则：触及**新插入自身行**的二次编辑先弹 TUI 确认框（`agent 请求修改用户令 … → Yes/No`），选 No 后与直接改写同样落到硬拒绝文案 `用户未确认：用户令条目只有用户能作废。请在回复里向用户提议具体改法`；全程两条用户令规则文件内容未被 agent 改动一个字节                                                                                                                                                                                                                                                                                                                                                                 |
| 19  | 子会话                   | 部分通过                     | 子 agent（`Push-dev-to-origin`）成功装配 Jev（无崩溃），未弹任何 Jev 通知（符合"子会话不弹通知"），push 未被门禁拦——但原因与 #6 相同（push 规则未打标、非 gate=hold 类型），不是子会话特有缺陷；`.jev/` 相关侧车目录全程未生成（本环境因打标从未成功，无法区分"子会话不该写"与"全局都没写出来"）                                                                                                                                                                                                                                                                                                                                                           |
| 20  | web（J9 web 分支）       | 不适用                       | 任务指定本轮未做 web 紧凑分支，跳过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 21  | classifiers 空/全非法    | **通过**                     | ①`classifiers=""` → 与 #12 相同（无 jev 行）；②`classifiers="foo, bar baz"` → 启动提醒逐字匹配 `Warning: memory.jev.classifiers: all entries invalid (foo, bar baz) — jev off`；③恢复默认后重新进入 `probing`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22  | 预算耗尽 partial(budget) | **通过**                     | `maxCalls=1` 后 1 次逻辑调用（两个分类器各计 1 次，共 2）即耗尽；`/mem jev` 显示 `enabled · partial (budget)`，`usage 2 calls`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 23  | nogate 逃生口            | **通过**                     | release.sh 规则加 `nogate` 后 `git commit` 不再被拦（无 hold、无未判定标记）；去掉 `nogate` 恢复 `gate=hold` 后同一操作立即被 `[memory gate·hold]` 重新拦下                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 24  | web 端 `/mem review`     | 跳过（需用户）               | 需要 web-hub 会话，按任务要求留给用户在场验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 不通过/部分通过详情

- **#1/#2/#3/#5/#10/#16（环境阻塞）**：根因是宿主包 `@earendil-works/pi-ai` 的 System One classify 响应解析问题（见上文"环境阻塞问题"），不在 `pi-toolkit/src/memory/jev/**` 范围内，代码定位：`node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js:112-146`（`classifySystemOne` 的 try/catch）、`dist/utils/error-body.js`（`formatProviderError`/`normalizeProviderError`）。**已用 message_agent 报告给 root**，建议另起环境（不同网络/代理/账户）复测以排除"本代理/本账户异常"的可能性。
- **#6/#19（设计内，非缺陷）**：push 规则缺少 `gate`/`gate=hold` 内联注释时，`guarded` 完全依赖 Jev 已打分的 `guard>=0.7`（`src/memory/jev/decide.ts:48-54`），未打标前恒为 `false`。这是架构既定行为（jev-plan §8 的完整走查顺序假设 #2 的存量打标先成功），本环境因环境阻塞无法达成打标，因此 #6/#19 的"门禁应该拦"这部分无法验证，但**不代表代码有缺陷**。
- **#15（发现，非缺陷但值得追踪）**：`redactProxyUrl()` 有完整单测覆盖，但生产代码路径里从未被调用——当前没有任何用户可见输出会回显 `memory.jev.proxy` 的原始值，所以不存在凭证泄漏，但也意味着文档/`jev-plan.md`/`jev-arch.md` 中"代理凭证总显示为 `http://***@host:port`"这句承诺目前没有对应的可触发场景。建议后续要么找到真正需要回显代理值的路径并接上 `redactProxyUrl`，要么把文档改成"代理原始值从不回显"。

## 需用户现场验收的 3 项

1. **#11 inactive**：需要一台/一个账户完全没有分类器凭证的环境。
2. **#14 secure 域强制关闭**：需要 `pi-secure run <vault>` 交互式建库/解锁密钥。
3. **#24 web 端 `/mem review`**：需要 web-hub 会话与浏览器交互。

## 环境与花费汇总

- Jev 真实调用：约 20+ 次（probe + 若干次 recall/write-tag/review 尝试），**无一次被判定为"成功"**（环境阻塞问题导致）；累计计费 **$0.0000–$0.0001**（`/mem jev` 全程显示 `$0.0000 / $0.50`）。
- 主会话模型调用：约 $0.43（zai/glm-5.3，含一次子 agent $0.16，走的是 cr-anthropic claude-opus-5-5，均与 Jev 无关）。
- 清理：`tmux kill-session` ✅；`rm -rf /tmp/jev-acc`（先 `ls` 确认存在，删除后确认 `ls` 报 No such file）✅；`~/.pi/agent/memory/` 下确认无 `-tmp-jev-acc*` 残留 ✅；未修改 `~/.pi/agent/` 下任何真实文件（仅只读符号链接）；未在 `/home/bluecake/ai/pi-toolkit` 仓库内改动代码，只写了本报告文件。

---

# 复测（f30b52b5 之后）

- 日期：2026-11-01 10:14–10:35；HEAD：`2d77dae6`（dev，含 `f30b52b5` 修复 proxy-fetch Response、`7584097c` 加 `/mem jev` proxy 行打码）
- 环境：与上一轮完全相同的隔离方式重建（`/tmp/jev-acc`，符号链接只读 `auth.json`/`models.json`，`packages` 绝对路径，假 `release.sh`，scratch 仓库无 remote），已在结尾删除。
- **结论：`f30b52b5` 修复生效**——`classify()` 真实调用不再被误判为错误，status 直接到达 `full`，`7/7`→`6/6`（删掉一条后）全部打标，`/mem jev` 全程 `enabled · full`。

## 逐项结果

| #   | 场景          | 结论                                     | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首次可用 full | **通过**                                 | 启动即弹 `jev on · opencode/jev-1.13-free — 记忆召回、打标、整理、高危拦截已启用；你的消息与记忆摘录会脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭`；`/mem` 显示 `jev: full · opencode/jev-1.13-free · 7/7 tagged · 31 calls $0.000`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | 存量打标      | **通过**                                 | 首次 full 后 7 条全部自动打标（`7/7 tagged`），`.jev/index.json` 存在（0600 权限见下），整理（review）同时跑出 2 条建议                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | U 召回        | **通过**                                 | 发「帮我把 dev 推到 GitHub」后出现 `── mem U: pitfalls-git › #1 (0.86) ──`，随后 ask_user 弹框正确带出"会先设置代理 http://127.0.0.1:7890"的召回内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | A 快速通道    | **通过**                                 | `gh pr create --help` 后出现 `── mem A: pitfalls-git › #1 ──`；`/mem jev` 的 `segment injected 1 (A1)` 印证且不消耗额外 Jev 调用（A 层走已有标签，不现场问 Jev）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | 门禁拦一次    | **通过**                                 | 对话里 agent 尝试启动 `release.sh`，被 `[memory gate] 本次 bash 调用未执行：Jev 判定它属于记忆规则「core.md #2」（用户令，applies 0.90）的管辖范围` 拦下（**真实 Jev 现场判定**，非证据兜底）；agent 读规则后承诺不 commit/tag/切分支，原样重试即放行，`bash scripts/release/release.sh` 成功启动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | 恢复          | 部分通过                                 | 去代理触发真实 `451`（这次是真错误，不是环境 bug），`/mem jev probe` 只刷新"凭证可用性"缓存（代码/测试均确认 `probe()` 设计上不强制重试、不清除 451/transient 的隔离计时器），故单会话内等不到 `recovered`；重启全新 pi 进程（进程级健康表清零）后立即恢复 `full·6/6 tagged`，证明代理恢复后 Jev 能重新工作，只是"恢复"文案需等隔离窗口（451→60min, transient→10min）自然到期或新进程，`/mem jev probe` 本身不是绕过手段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 15  | 代理键        | **通过**                                 | `http://user:pass@…` → `/mem jev` 新增一行 `proxy http://***@192.168.32.38:7897`（凭证正确打码，`7584097c` 生效）；改 `socks5://192.168.32.38:1080` → `proxy socks5://192.168.32.38:1080 — ignored (only http:// proxies are supported)`，且两个分类器此时均走直连（无代理痕迹，一个真 451、一个 2s 超时），与"视为未配置代理"的预期一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 16  | 整理          | **通过**（含一个非 Jev 的既有 bug 发现） | 自动整理跑出 `[supersedes] p=0.92 models.md: "GPT 系模型已解禁" vs "GPT 系模型临时禁用"`（与 jev-arch §16.6 示例逐字对应）与 `[obsolete] p=0.96 expiring.md: …`；`/mem review` 交互选"Delete superseded"后 `models.md` 正确只剩"已解禁"一条。**但**随后 `/mem restore --trash` 报 `trash is empty`，而磁盘上 `.trash/20261101T021815Z-1895859-cn62ih-models.md` 确实存在——走查确认 `src/memory/jev/entry-edit.ts` 的 `trashId()` 与 `src/memory/tool-v2.ts` 的 `trashId()` 都在 `toISOString()` 后用 `.replace(/\.\d+Z$/, "Z")` 砍掉毫秒，产出 6 位时间数字（如 `20261101T021815Z`），但 `src/memory/safe-fs.ts:882` 的 `TRASH_NAME_RE` 与 `src/memory/tidy/manifest.ts:132` 的 `listTrashEntries()` 正则都要求 `\d{8}T\d{9}Z`（9 位，含毫秒），两者天生对不上，`node -e` 验证 `TRASH_NAME_RE.test("20261101T021815Z-1895859-cn62ih-models.md")` 返回 `false`。**这是一个与本次两个修复无关的既有 bug**，影响全部 `/mem restore --trash`（含 jev 整理删除与旧版整条删文件两条路径），不是 Jev 新增代码，但确实卡住 jev-plan #16"可找回"这句验收标准 |
| 19  | 子会话        | **通过**                                 | 三轮验证：①未强调"用户已确认"时子 agent 主动因 core.md 规则放弃 push（软门禁，依赖子会话 recall 的用户令）；②明确声明"用户已确认"后子 agent 放行执行（证明 push 规则本身是软性、靠模型自觉，不是工具层硬拦，这与规则未带 `gate` 注解一致，不是子会话缺陷）；③让子 agent 在 release.sh 运行期间 commit，真实拿到工具层硬拦截：`[memory gate·hold] 本次 bash 调用未执行：规则「core.md #2」（用户令）的条件仍成立（violates_now 0.99；证据：pid … bash scripts/release/release.sh --dry-run）`——bash 调用根本没有执行；子会话全程未弹出任何 Jev 通知；`.jev/index.json` 全程只有一份（主/子共享，无独立子会话侧车）                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 不通过/部分通过详情

- **#10（部分通过，非缺陷）**：`probe()` 按设计（见 `tests/memory/jev/client.test.ts:290` 测试标题 "probe() forces an availability refresh even inside the 10-minute cache window"）只刷新凭证/目录可用性，不重置 per-id 的错误隔离计时器（`UNAVAILABLE_ISOLATION_MS=60min`、`TRANSIENT_ISOLATION_MS=10min`，`src/memory/jev/client.ts:30-32`）。真实网络恢复后，`full` 状态会在隔离窗口到期或下次新进程启动后自然恢复——本次用重启进程的方式间接验证了"代理修好后 Jev 确实能恢复工作"，但没能在同一会话内等到字面意义的 `jev recovered` 通知（需要等 55+ 分钟，超出本次验收时间预算）。
- **#16（整理功能通过，restore --trash 是既有 bug）**：复现步骤——① 任意触发 jev 整理产生一条 `supersedes`/`obsolete` 建议并执行删除（或旧版 `/mem tidy` 整条删文件）；② 立即 `/mem restore --trash`。预期列出可恢复项，实际恒为 `trash is empty`。可疑代码：`src/memory/safe-fs.ts:882`（`TRASH_NAME_RE`，要求 9 位时间戳）、`src/memory/tidy/manifest.ts:131-138`（`listTrashEntries`，同一正则）、`src/memory/jev/entry-edit.ts:54-59` 与 `src/memory/tool-v2.ts:479-485`（两处 `trashId()` 都把毫秒砍掉，只产出 6 位）。三选一修法：要么 `trashId()` 保留毫秒（去掉 `.replace(/\.\d+Z$/, "Z")` 那一步或改成补零到 9 位），要么把 `TRASH_NAME_RE`/`listTrashEntries` 的正则从 `\d{9}Z` 放宽到 `\d{6,9}Z`。影响范围不止 jev，建议作为独立 bug 单独修。

## Jev 调用数与花费

- Jev 分类调用：约 40+ 次（含 1 次首次 full 探测触发的 7 条存量打标批次、召回、A 快速通道查标、gate 判定、review 两两比对），`/mem jev` 显示累计 **$0.0000–$0.0001 / $0.50**（opencode 分类器调用几乎零成本）。
- 主会话模型调用：约 $0.26（zai/glm-5.3），另有 4 次子 agent 调用共约 $0.23–$0.30（cr-anthropic/claude-opus-5-5，用于派单测试，非 Jev）。

## 清理确认

- `tmux kill-session -t piacc` ✅
- `ls /tmp/jev-acc` 确认存在 → `rm -rf /tmp/jev-acc` → 再次 `ls /tmp/jev-acc` 返回 `No such file or directory` ✅
- `ls ~/.pi/agent/memory/ | grep -i tmp-jev-acc` 无输出（无残留）✅
- 未修改 `~/.pi/agent/` 下任何真实文件（仅只读符号链接 `auth.json`/`models.json`）；未在 `/home/bluecake/ai/pi-toolkit` 仓库内做任何 git 写操作或运行真实 `scripts/release/release.sh`；仅追加写本报告文件，未 commit。

---

## 复测 #16（9bc556b8 之后）

- 日期：2026-11-01 10:44–10:50；HEAD：`9bc556b8`（`git -C /home/bluecake/ai/pi-toolkit log --oneline -1` 确认），`npm run build` 通过（exit 0）。
- 环境：与前两轮完全相同的隔离方式（`/tmp/jev-acc`，`PI_CODING_AGENT_DIR`/`ARMORY_MEMORY_ROOT` 均在 `/tmp` 下，`auth.json`/`models.json` 只读符号链接到 `~/.pi/agent/`，opencode key 未直接出现在任何输出里——只在子进程环境变量中，命令行/日志全程未打印），代理 `http://192.168.32.38:7897`，`memory.jev.review.intervalDays=0`。启动即 `jev on · opencode/jev-1.13-free`，很快 `7/7 tagged`。全程未对 `/home/bluecake/ai/pi-toolkit` 做任何 git 写操作或改文件，未运行真实仓库的 `release.sh`（scratch 仓库里的假 `release.sh` 这次也未被触发）。

### 步骤与实际输出

**A. jev review 删除 supersedes 条目 → restore --trash**

1. `models.md` 放两条矛盾记录（"GPT 系模型临时禁用" vs "GPT 系模型已解禁"），`/mem review --run` → `jev: review pass complete — 1 suggestion(s) → /mem review`。
2. `/mem review` 交互 → 弹出：
   ```
   review p4 · supersedes
   → Delete superseded — models.md: "- GPT 系模型临时禁用（2026-10-12…"
     Hand to agent — rewrite
     Keep
     Skip
   ```
   选默认项「Delete superseded」后 `models.md` 只剩「已解禁」一条。
3. `/mem restore --trash` → **不再是 "trash is empty"**，列出：
   ```
   20261101T024708189Z-1926281-b39fd9 — models.md
   ```
   （新 ID 形状 `\d{8}T\d{9}Z-<pid>-<6hex>`，9 位毫秒时间戳 + 6 位十六进制，与 `TRASH_NAME_RE`/`listTrashEntries` 的正则完全匹配）。
4. `/mem restore --trash 20261101T024708189Z-1926281-b39fd9` → `restore --trash: restored models.md; pre-restore backup .backup/20261101T024741921Z-1926281-7a938c`；文件内容核对：
   ```
   # 模型可用性记录
   - GPT 系模型临时禁用（2026-10-12 因配额问题）。
   - GPT 系模型已解禁（2026-10-21 确认）。
   ```
   两条都回来了。

**结论：通过**

**B. 旧路径——memory 工具 `delete` 整文件 → restore --trash**

1. 新建 `scratch-note.md`（手写，无 `source: agent`），让模型用 `memory` 工具 `delete` 它。
2. 第一次被拒（用户文件保护，预期行为，非本次验收范围），模型在用户明确下令后补 `source: agent` frontmatter 后重试成功：`deleted scratch-note.md (recoverable: /mem restore --trash 20261101T024835178Z-1926281-c82337)`。
3. `/mem restore --trash` → 列出 `20261101T024835178Z-1926281-c82337 — scratch-note.md`。
4. `/mem restore --trash 20261101T024835178Z-1926281-c82337` → `restore --trash: restored scratch-note.md`；文件内容核对（含模型补的 `source: agent` frontmatter）：
   ```
   ---
   source: agent
   ---
   # 待删文件测试
   - 这个文件用来测试 memory 工具的 delete 路径能否被 /mem restore --trash 找回。
   ```
   原内容完整找回。

**结论：通过**

### 判定

**#16 完整结论：通过**（整理/supersedes/obsolete 判断此前已验证通过；本轮补全的 `restore --trash` 两条路径——jev review 删除与旧版 `memory delete` 整文件——均可被正确列出并恢复，`9bc556b8` 修复生效，未发现新问题）。

### Jev 调用数与花费

- `/mem jev` 显示本次 activation 累计 **33 calls**，**$0.0000 / $0.50**（opencode 分类器调用近乎零成本）。
- 主会话模型调用（zai/glm-5.3）约 $0.05（`total … Σ$0.050`），与 Jev 本身无关。

### 清理确认

- `tmux kill-session -t piacc` ✅
- `ls /tmp/jev-acc` 确认存在 → `rm -rf /tmp/jev-acc` → 再次 `ls /tmp/jev-acc` 返回 `No such file or directory` ✅
- `ls ~/.pi/agent/memory/ | grep -i tmp-jev-acc` 无输出（无残留）✅
- 未修改 `~/.pi/agent/` 下任何真实文件（仅只读符号链接）；未在 `/home/bluecake/ai/pi-toolkit` 仓库内做任何 git 写操作、未运行真实 `scripts/release/release.sh`；仅追加写本报告文件，未 commit。

---

## #11 inactive（自动测）

- 日期：2026-11-01 12:38–12:42；HEAD：`c5faade9`（`9bc556b8` 之后的一个测试加固提交，与本项无关）。
- **#14（pi-secure 加密会话强制关闭）、#24（web 端 `/mem review`）经用户决定跳过（2026-11-01），由单测与 secure golden 兜底**，本次不测。

### 代码确认（先读，再动手）

- `src/memory/jev/format.ts:274`：`if (status.inactive) return "jev: inactive (no classifier credentials)";` —— `/mem` 一行摘要的确切文案就是这句，验收前已对照代码确认。
- `src/memory/jev/health.ts:217`：`if (next.inactive) return undefined; // §5.3: inactive is never notified` —— inactive 态不触发任何 `ctx.ui.notify`，即不弹任何 jev 通知。
- `src/memory/jev/client.ts:44-71`（`resolveAvailability`）：分类器可用性按精确的 `"<provider>/<id>"` 字符串匹配 `memory.jev.classifiers`（默认仅 `opencode/jev-1.13-free`、`opencode/jev-1.13`），与其它 provider 的凭证完全无关——因此给主对话模型配一个 `zai` 凭证不会让任何分类器"意外可用"，可以安全地只提供 `zai` 来驱动主会话对话。

### 隔离与凭证控制

- 环境根 `/tmp/jev-acc2`（已清理），`PI_CODING_AGENT_DIR`/`ARMORY_MEMORY_ROOT` 均在 `/tmp` 下。
- **未软链 `~/.pi/agent/auth.json`**：改为用 Python 从真实 `auth.json` 里只摘取 `zai` 这一个 key 写入新文件 `/tmp/jev-acc2/agent/auth.json`（0600），全程未在终端打印任何凭证内容，只打印过一次 `auth.json keys (should be only zai): ['zai']` 做结构校验。`models.json` 仍只读符号链接（不含凭证，只是模型目录元数据）。
- 启动 pi 的子进程用 `env -i PATH="$PATH" HOME="$HOME" TERM="$TERM" PI_CODING_AGENT_DIR=... ARMORY_MEMORY_ROOT=... pi --model zai/glm-5.3 --thinking low`，排除了调用者 shell 里的全部环境变量（包括 `FACTORY_API_KEY`、`LINEAR_API_KEY` 等与模型无关的密钥）。本次任务未单独跑 `env | grep -ci key`（因为是用 `env -i` 显式白名单，而非黑名单剔除），但可以确认传入子进程的环境变量集合是 `{PATH, HOME, TERM, PI_CODING_AGENT_DIR, ARMORY_MEMORY_ROOT}` 共 5 个，没有任何 `*_API_KEY`/`*_TOKEN`；唯一的凭证来源是 `auth.json` 文件本身（只含 `zai`），不经环境变量传递。
- `memory.jev` 配置为默认值（`{}`，即分类器列表为默认的两个 `opencode/*` id，但没有 opencode 凭证）。

### 实测输出

启动日志（无 jev 相关通知，只有预期的 quota 凭证缺失警告，与 jev 无关）：

```
Warning: [quota] no usable credential for "zai-coding-cn" (auth.json or ZAI_API_KEY) — provider skipped
Warning: [quota] no usable credential for "kimi-coding" (auth.json or KIMI_CODING_API_KEY) — provider skipped
```

`/mem`：

```
   core.md (110B)
 doctor: 0 findings — /mem doctor
 jev: inactive (no classifier credentials)
```

—— 与 `format.ts:274` 的文案逐字一致。

`/mem jev`：

```
 jev      enabled · partial (no-auth)
 models   1 opencode/jev-1.13-free
          2 opencode/jev-1.13
 stopped  recall U · error recall E · write tagging · review run · gate judgment
 running  action fast path A · re-inject after compaction B · gate evidence tier · review list
 tags     0/1 tagged · 1 pending (edited since last tagging) · taxonomy a13adaf2
 evidence process: bash jobs + /proc (Linux)
 usage    0 calls · $0.0000 / $0.50 · per activation (/reload resets)
 segment  injected 0 · gates 0 (hold 0) · cap 0/30 · verdict cache 0
 review   0 open → /mem review
```

—— 内部状态是 `partial (no-auth)`（`inactive=true` 由 wire.ts 的 `refreshInactive` 单独叠加到 `/mem` 一行摘要上），两个分类器都因缺少 opencode 凭证标记为 `no-auth`。

发一条真实对话消息（"你好，简单说一句你看到了项目记忆里的哪条规则"）验证"记忆行为与升级前一致"：

```
── date 2026-11-01 Sun 12:40 (Asia/Shanghai) · session start ──
你好！项目记忆里有一条核心规则：push 到远程前必须先问用户确认，不能自己执行 git push。
```

—— `core.md` 常驻块照常注入（与 Jev 无关，升级前后行为一致），全程**没有**出现任何 `── mem U: … ──` 标记（U 层召回已停用，符合 inactive 下 "stopped recall U" 的预期），也没有任何 jev 弹窗/通知。

消息发送前后 `/mem jev` 的 `usage` 均为 **0 calls**，确认全程**零次** Jev 分类调用。

文件系统检查（消息发送后）：

```
/tmp/jev-acc2/memory
/tmp/jev-acc2/memory/-tmp-jev-acc2-proj
/tmp/jev-acc2/memory/-tmp-jev-acc2-proj/core.md
```

—— **没有产生 `.jev/` 目录**（无索引、无任何调用记录），与预期"inactive 不留 Jev 侧车"一致。

### 判定

**#11 通过**：

- `/mem` 显示 `jev: inactive (no classifier credentials)`，与代码 (`format.ts:274`) 逐字匹配；
- 全程未弹任何 jev 通知（`health.ts:217` 的 "inactive is never notified" 得到验证）；
- 记忆注入（core.md 常驻块）行为与升级前一致，U 层召回正确停用且未留下任何标记；
- `.jev/` 目录全程未创建，`/mem jev` 的 `usage` 全程 0 calls，确认零 Jev 调用。

### 花费

- Jev 调用数：**0**，花费 **$0.0000**（设计上 inactive 完全不触发任何分类器调用）。
- 主会话模型调用（zai/glm-5.3，仅用于验证记忆注入行为，与 Jev 无关）：约 $0.035（一次对话）。

### 清理确认

- `tmux kill-session -t piacc2` ✅
- `ls /tmp/jev-acc2` 确认存在 → `rm -rf /tmp/jev-acc2` → 再次 `ls /tmp/jev-acc2` 返回 `No such file or directory` ✅
- `ls ~/.pi/agent/memory/ | grep -i tmp-jev-acc2` 无输出（无残留）✅
- 未修改 `~/.pi/agent/` 下任何真实文件（只读取 `auth.json` 中的 `zai` 字段摘取到临时文件，未写回、未打印凭证内容；`models.json` 仍只读符号链接）；未在 `/home/bluecake/ai/pi-toolkit` 仓库内做任何 git 写操作、未运行 `release.sh`；仅追加写本报告文件，未 commit。
