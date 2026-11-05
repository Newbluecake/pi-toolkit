# #21 包 A · 约定层（xs 委派中途提问）实施报告

基线：dev 分支 `e31968b1`，方案 `docs/dev/xs-ask-redirect/plan.md`（r3）§1 D11、§2「包 A」。

## 改动清单

| 文件                                                    | 改动                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/message-session-tool.ts`                     | `REPLY_DESCRIPTION` 末尾追加 D11 句子（一处字符串拼接，改写末段并补 `+ " " +` 拼接新句）。`LEGACY_DESCRIPTION`、两个 schema 实例（`MessageSessionParamsLegacy` / `MessageSessionParamsReply`）与 `messageSessionParamsFor` 一字未动                                                                                                           |
| `skills/agent-handoff/SKILL.md`                         | 「## 反模式」前新增「## 可选：处理委派任务中途需要澄清时（expectReply 委派）」一节（12 行，≤20 行上限），策略内容：先自查 → 中间问题用新 expectReply(wake:true) 消息反问请求方、绝不用原 replyTo（一次性票据）→ 一次问全附默认 → 不阻塞 ask_user（askRedirect 开启时宿主自动转给请求方、结果照做）→ A 侧用户在场时由 A 用 ask_user 问人后转答 |
| `tests/tools/message-session-reply-description.test.ts` | 新建（T14）：reply-on 含 D11 原句；legacy（及任意 alias/threadRebind/activation 后缀组合）不含、且不含 `ask_user` 字样；各后缀下 D11 句恰出现一次                                                                                                                                                                                             |
| `docs/dev/xs-ask-redirect/A-report.md`                  | 本报告                                                                                                                                                                                                                                                                                                                                        |

工具描述写机制（I12：策略只在 skill，未重复进描述文本）；未触碰 `src/fabric/**`、`src/ask-user/**` 等并行包文件域；未触碰 `tests/fixtures/**`。

## 自验（真实输出）

1. `npx vitest run tests/tools tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-xs-off-golden.test.ts tests/governance`（tee /tmp/pkgA-vitest.log）
   → `Test Files 35 passed (35)` / `Tests 580 passed (580)` / EXIT=0
2. `npx prettier --check src/tools/message-session-tool.ts skills/agent-handoff/SKILL.md tests/tools/message-session-reply-description.test.ts`
   → `All matched files use Prettier code style!` EXIT=0
3. `git diff --quiet HEAD -- tests/fixtures/` → 通过（FIXTURES_CLEAN，A级 golden 未重生）
4. `npx tsc --noEmit -p tsconfig.json 2>&1 | grep message-session` → 空（grep exit 1，本包文件零类型错误）

## 备注

- D11 句子按 plan §1 D11 原文逐字追加（含首部空格分隔）。
- 旧 golden `fabric-xs-reply-off-golden.json` 钉的是 legacy 描述，本包不改它；golden 套件本批运行为绿。
