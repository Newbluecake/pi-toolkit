# AF6 终局交付报告（#72 alias-force-default r2）

基线：`feat/alias-72` @ 495e331d（AF0–AF4、AFU、AFW 与第一波跟进修复）。本包只做集成测试、README、真机验收步骤；`src/` 与 `tests/fixtures/` 零改动。

## 改动

| 文件                                                | 内容                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/fabric-xs-alias-v2.test.ts`      | 新增，6 个用例，真实 hub 子进程 × 3 个真实 stack，hub 时钟经 `StartHubDeps.now`（fixture 的 `skew` op）                                                                                   |
| `tests/integration/helpers/fabric-xs-process.ts`    | 测试夹具新增 4 个开关（见下），默认行为字节不变；不在 `tests/fixtures/` 下                                                                                                                |
| `docs/dev/fabric-cross-session/README.md`           | 「Session aliases」补 #72 增量（`--force`、三态在场、`xs_alias_evt`、自动认领、decided 标记、I5′/I7/I8/I9/I10、r4 §5.2 修订、混跑、门禁、残留）；「Web UI：Aliases」补强制按钮与 cwd chip |
| `docs/dev/fabric-cross-session/alias-acceptance.md` | §0 注明 §1–§6 在 `autoFromCwd:false` 下验证；新增 §7（19 步）                                                                                                                             |
| `docs/dev/fabric-cross-session/AF6-report.md`       | 本报告                                                                                                                                                                                    |

README 里「Aliases deliberately do NOT transfer on `/new`」那句原样保留（AF7 再改）。

### 夹具开关（`helpers/fabric-xs-process.ts`，均为测试专用）

- `XW_CWD`：peer 的工作目录（自动认领取它的 basename；默认 `process.cwd()`，旧用例不变）。
- `XW_TUI_CONFIRM=1`：peer 以 `mode:"tui"` 运行，`ctx.ui.confirm` 被记录到 `inspect().confirms`，由 `confirmAnswer` op 决定回答（默认 yes）；顺带补了 `getEditorComponent/setEditorComponent` 桩（TUI 才会走的 session_start 钩子）。
- `XW_STRIP_V2=1`（agent）/ `XW_HUB_STRIP_V2=1`（hub）：在 `net.Socket.prototype.write` 上改写自己发出的 `hello` / `hello_ack`，去掉 `xs.alias.v2`。对端在线路上看到的就是旧 agent / 旧 hub，v2 的各道门（`aliasV2Capable`、hub caps）正是按这个判定的；两个进程本身仍跑当前代码。

## 覆盖的场景（对应 §9 集成 ①–⑧）

| 用例                 | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①②④⑦（一个长场景）   | 3 个同 cwd 会话并发 join ⇒ 恰好 1 个 `held (auto)`（hub 表里 `origin:"auto"`、恰好 1 条自动设置通知），另 2 个 `auto skip:taken` 且无通知；人工 `set` 撞名 ⇒「已占用」+ `--force` 提示（D5）；`--take` 对在线持有者 ⇒ 拒绝 + `--force` 提示；TUI `--force` 确认框文案（`强制抢占别名「payments」？`、「（自动认领）」「当前在线」）；抢占成功后表里 `origin` 被删、墓碑 `forced:true`；被抢方**不重连**（hub 收到的该 agent session 帧数不变）就收到一次「强制抢占（对方已人工确认）」，status 变 `alias - (lost: taken)`；被抢方 `/reload` 后即使名字空闲也不再自动认领（墓碑）；无墓碑的另一个会话 `/reload` 能认领（对照）；hub 时钟 +31 天后墓碑过期，被抢方恢复自动认领资格 |
| ③ pin 屏障           | B 已 resolve「前端」→ A，C `--force` 夺走，B 的 send 仍送达 A（C 没收到）；第二轮 B resolve → C，A 抢回，C 被杀 ⇒ B 的 send 返回 `no_target`/`effect:none`，A 没收到，hub 上总共只有第一轮 1 次 deliver                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ⑤ web force          | `webCommandPolicy.fabric=confirm`：无确认 ⇒ `E_CONFIRM_REQUIRED`；确认后的预览输出含确认框文案且 `parseTakeConfirm` 可解析；预览不改表；执行也需要自己的策略确认；成功后持有者收到强制抢占通知                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ⑧a 不可通知 + 混跑   | **旧 agent 在线**（`XW_STRIP_V2`）持有 ⇒ force 拒绝（`无法实时通知…--take`、不弹确认框）、take 拒绝（在线）；它被杀后**立刻** force 成功、take 仍「不足 10 分钟」；它带原 session 文件回来 ⇒ 只收到旧文案（lost 一次，不含「强制抢占」），status `alias - (lost: taken)`。**linked 持有者**（xs 关闭 + `/reload`，仍连着 hub）⇒ force 拒绝，hub +11 分钟后仍拒绝，`--take` 却成功（take 只看 xs 在线）                                                                                                                                                                                                                                                                           |
| ⑥ decided 跨 reload  | 自动认领后 `--clear`（回显「已关闭本会话的目录名自动别名」，会话文件里有 `subagent:xs-alias-decided`）→ hub 重启 → hub 时钟 +11 分钟（冷却已过，名字空闲）→ `/reload` ⇒ `alias - · auto skip:decided`；同目录新会话随后认领成功（证明名字确实空闲，差别只在 decided）                                                                                                                                                                                                                                                                                                                                                                                                            |
| ⑧b 旧 hub × 新 agent | hub 去掉 `xs.alias.v2`（`XW_HUB_STRIP_V2`）：两个同 cwd 会话 join 后不自动认领、status 无 `auto skip:` 后缀；人工 `set` 正常；撞名提示与 `--take` 拒绝都**不含** `--force`；`--force` 本地拒绝「hub 不支持强制抢占」且零确认框；按别名收发照常送达（hub 上 deliver 数 = 1，不丢帧）                                                                                                                                                                                                                                                                                                                                                                                              |

### 哪些场景降到了单测层

- 无场景因为开销降到单测。plan §9 的集成 ⑨（`/new` / fork 交接）属 AF7，本包不含。
- 两处不是**字节级**真旧版本，而是线路级模拟：旧 agent / 旧 hub 用 `XW_STRIP_V2` / `XW_HUB_STRIP_V2` 改写握手 caps（仓库里没有旧版二进制可跑）。这足以验证 v2 的所有门（hub 对 `aliasV2Capable` 的判定、agent 对 hub caps 的判定、不发 `intent`、回包不含新键）；而「旧 hub 读带 `origin`/`forced` 键的文件不 degraded」「旧 schema 整帧丢弃新字段」在 AF0/AF1 的单测里钉住，未在此重复。
- TUI 确认走 `XW_TUI_CONFIRM` 的 `ui.confirm` 桩（场景 ①②、③、⑧a、⑧b），web/RPC 文本确认走 `webCmd`（⑤）；真终端体验在 `alias-acceptance.md` §7。
- `E_XS_ALIAS_TAKE{stale}` 的各细分（presence/rev 变化、并发两次、mode 互不相通、wedged 后晚到的推送）仍只在 hub 单测层（AF1/AF2），集成层不重复。

## 变异验证

注释掉 `router.ts` 中 `registry.send(... xs_alias_evt ...)`：用例 ①②④ 在「被抢方实时收到提示」处超时失败（已还原，`git status` 干净）。线路级旧 agent 判定同理：不去掉 `xs.alias.v2` 时 ⑧a 里「force 拒绝」会变成成功抢占。

## 自验

均在 `/tmp/alias-afw`，未执行 install。

| 命令                                                                                 | 结果                                         |
| ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `npm run typecheck`                                                                  | 通过                                         |
| `npx vitest run tests/integration/fabric-xs-alias-v2.test.ts --maxWorkers=1` ×3 连跑 | 3/3 各 6 例全绿（约 64 s/遍），无偶发失败    |
| `npx vitest run tests/integration --maxWorkers=3`                                    | 133 文件 / 997 通过 / 6 skip（既有）         |
| `npm run test:conformance`                                                           | 35 文件 / 361 通过 / 16 skip（自门控）       |
| `npm run format:check`                                                               | 通过                                         |
| `git diff --quiet 9ce5abc7 -- tests/fixtures/`                                       | 干净（三份 off golden、activate-trace 未动） |

## 给 AF7 的备注

- `intent:"handoff"` 仍回 `E_XS_BAD_FRAME`；README 与 §7 已写明「`/new` 不交接」，AF7 落地后改 README「Session aliases」里那句、alias-acceptance 6.9，并补集成 ⑨。
- 夹具的 `replace` op 已能模拟 `/new` / fork / resume（`reason`），`XW_CWD` 对新 session 同样生效。
