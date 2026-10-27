# 会话别名 真机验收清单（AL6）

> 规格：`alias-plan.md`（r4）。自动化门禁（`tests/integration/fabric-xs-alias*.test.ts`、conformance C-X11）已覆盖协议与行为；本清单只验自动化覆盖不到的真实终端 / 浏览器体验。
> 约定：**A / B / C** 是三个独立的 pi 主会话（三个终端），**cwd 各不相同**（如 `~/ai/前端项目`、`~/ai/后端`、`~/ai/tmp`）。每步「操作 → 预期」，不符即记录并停止。

## 0. 前置（只做一次）

1. `~/.pi/agent/pi-subagent.json` 至少：
   ```json
   {
     "webHub": { "enabled": true },
     "fabric": { "enabled": true, "crossSession": { "enabled": true } }
   }
   ```
   别名默认开启（`fabric.crossSession.alias.enabled` 默认 true，无需配置）。
   **§1–§6 在 `"alias": {"autoFromCwd": false}` 下验证**（自 #72 起 `autoFromCwd` 默认 true，join 时会按目录名自动认领，会干扰 `alias -` 之类的预期；
   在 `fabric.crossSession` 里加上 `"alias": {"autoFromCwd": false}` 并 `/reload`）。§7 再把它改回默认。
2. **三个会话都执行 `/reload`**，然后在其中一个里执行 `/webhub restart`（设置均为非 live；hub 要带上 `crossSession.alias` 键重启）。
3. 三个会话各执行 `/fabric join`；`/fabric status` 应出现 `alias -` 行且不是 `n/a`。若是 `alias n/a (hub-cap off)`：hub 没带 alias 重启成功（或 hub 由 alias.enabled=false 的会话拉起），回到第 2 步。
4. 浏览器 `/webhub open`，侧栏应出现 A–C 三张卡片。

## 1. 设置 / 查看 / 改名 / 清除（TUI）

| #   | 操作                                                                                 | 预期                                                                                                 |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1.1 | A：`/fabric alias 前端`                                                              | 回显「别名已设置：alias @前端 held …」；`/fabric status` 为 `alias @前端 held · lease 7d · cool 10m` |
| 1.2 | A：`/fabric alias`                                                                   | 回显当前状态（held）                                                                                 |
| 1.3 | A：`/fabric alias @后端项目`（改名）                                                 | 成功；旧名 `前端` 进入 10 分钟冷却（只有 A 能收回）                                                  |
| 1.4 | B：`/fabric alias 前端`（冷却中）                                                    | 拒绝：「别名已被占用」；A：`/fabric alias 前端` 可收回                                               |
| 1.5 | A：`/fabric alias --clear`                                                           | 「已清除…10 分钟内只有本会话能收回」；status `alias -`；B 此时仍不能占用 `前端`                      |
| 1.6 | 字符集：A 依次设 `こんにちは`、`한국어`、`ＡＢＣ`（全角）、`abc-1`                   | 均成功（全角折叠为 `abc`）                                                                           |
| 1.7 | 非法：`/fabric alias a_b!`、`_x`、`所有人`、`web 2`（带空格）、17 个汉字、`deadbeef` | 逐条被本地拒绝并给出原因（字符/开头/保留词/参数过多/过长/像 sessionId）；hub 无变化                  |
| 1.8 | 形近：A 持有 `abc0`；B：`/fabric alias abco`                                         | B 被拒：「与已有别名过于相似」（不回显 A 的别名）                                                    |
| 1.9 | Tab 补全：输入 `/fabric alias ` 后按 Tab                                             | 出现 `--clear` 与由 cwd 末段 / 会话名生成的推荐值                                                    |

## 2. 按别名收发（模型）

前置：A 持有 `前端`，A、B、C 都在 `#default`。

| #   | 操作                                                                                                 | 预期                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 2.1 | B 对模型说：「你给前端发送一条消息：你好」                                                           | B 的模型调用 `message_session{to:"前端"}`，送达 A；B 的结果文本里**没有**完整 sessionId                 |
| 2.2 | A 的收信头部                                                                                         | 首行形如 `[fabric xs from=… cwd=… ]`；若 B 也有别名，头部含独立字段 ` alias="…"`，且 `from=` 内不含别名 |
| 2.3 | B：`@前端 你好`（TUI 输入）；再输 `@` 触发补全                                                       | 补全里同时显示别名与会话名；`@前端 …` 被路由并送达 A（原文不进模型的本地 prompt）                       |
| 2.4 | B 的 `list_sessions`                                                                                 | A 的行带 `alias="前端"`                                                                                 |
| 2.5 | 频道可见性：A、B `join #team` 后双方 `leave #default`；C 仍在 `#default`；C 对模型说「给前端发消息」 | C 得到 no_target（与「不存在」不可区分），模型应去 `list_sessions` 询问而非猜测；A 不收到任何消息       |
| 2.6 | 把某个会话（C）的**会话名**设成 `前端` 同时 A 持有别名 `前端`，B 发给「前端」                        | 只会到 A（别名优先于名字）                                                                              |

## 3. 离线保留与抢占

| #   | 操作                                                                     | 预期                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | A 持有 `前端`，A 在线；B：`/fabric alias 前端 --take`                    | 拒绝：「持有者仍在线，不能抢占」                                                                                                                                      |
| 3.2 | 关闭 A 的终端（<10 分钟内）；B：`/fabric alias 前端 --take`              | 拒绝：「持有者离线不足 10 分钟，暂不能抢占」                                                                                                                          |
| 3.3 | 保持 A 离线 ≥10 分钟；B（TUI）：`/fabric alias 前端 --take`              | 弹出确认框，标题「抢占别名「前端」？」，正文含持有会话 cwd 与已离线时长；点取消 ⇒「已取消抢占」，hub 无变化                                                           |
| 3.4 | 再次执行并确认                                                           | 「已抢占别名：…」；C 或其他会话按 `前端` 发消息改为到 B                                                                                                               |
| 3.5 | 重新打开 A（`pi --session <原会话文件>` 或 `/resume`）                   | A 收到**一次**提示：「别名「前端」已被其他会话抢占，可以用 /fabric alias 重新设置」；`/fabric status` 为 `alias - (lost: taken)`；再次 `/reload` 不重复提示（同进程） |
| 3.6 | 离线保留：A 持有别名后离线，不到 7 天内他人 `set 前端`                   | 一律「已被占用」（只有 `--take` 路径可抢）                                                                                                                            |
| 3.7 | （可选，改系统时间或在测试 hub 里把 `offlineLeaseH` 调小）离线超过保留期 | 他人 `/fabric alias 前端` 直接成功（过期认领）；原持有者回来得到 `lost: expired` 提示                                                                                 |
| 3.8 | hub 重启（`/webhub restart`）后，离线持有者的 7 天保留期从重启时起算     | 别名仍在（未丢）；预览抢占时的离线时长从 hub 重启后重新计                                                                                                             |

## 4. web 界面

| #    | 操作                                                                                            | 预期                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 4.1  | 打开 A 的详情，标题后                                                                           | 小字 `@前端`，点击打开「频道与别名」弹窗                                                      |
| 4.2  | 卡片 chips 顺序                                                                                 | `kind → 状态类 → xs 徽标 → @别名 → #频道 → 未读角标`；别名超过 8 个字形簇被截断，悬停显示全文 |
| 4.3  | 弹窗别名区：输入 `a_b!`                                                                         | 实时提示不允许的字符；保存按钮不可用                                                          |
| 4.4  | 点推荐 chip（cwd 末段 / 会话名首段 / cwd 中文段）                                               | 填入输入框；别人已占用的 chip 置灰                                                            |
| 4.5  | 保存 / 清除                                                                                     | 回显出现；随后卡片/头部随 status 更新（无乐观更新，可能延迟 ≤1 个 status 周期）               |
| 4.6  | 「尝试抢占」：持有者在线                                                                        | 回显拒绝文案，**不弹**确认框                                                                  |
| 4.7  | 「尝试抢占」：持有者离线 ≥10 分钟                                                               | 弹出确认框，显示预览输出（含 cwd、离线时长）与**倒计时（5 分钟内有效）**；确认后执行成功      |
| 4.8  | 确认框打开后等待超过 5 分钟再确认                                                               | 失败：「状态已变化或确认已失效，请重新预览」；不会抢占                                        |
| 4.9  | `webCommandPolicy`：`{"fabric":"confirm"}`（设置后 `/reload` + `/webhub restart`）重做 4.5、4.7 | 保存/清除/预览/执行**每个命令**先弹通用确认框；抢占流程共两次通用确认（预览一次、执行一次）   |
| 4.10 | `webCommandPolicy:{"fabric":"deny"}`                                                            | 弹窗里别名按钮全部禁用/失败提示，TUI 不受影响                                                 |
| 4.11 | 在 web 对话框直接发文本 `/fabric alias 前端 --take=k0123456789abcdef`                           | 被拦截（prompt 文本不能绕过策略门），不会触发 hub 请求                                        |
| 4.12 | 来信渲染：B→A 且 B 有别名                                                                       | A 的 web 转录里该消息显示 `@别名`（来自首行独立字段），而非自报 name                          |
| 4.13 | `@` 面板                                                                                        | 候选显示 `@别名 · 名`，只列同频道会话；插入的值仍是 `session:<ref>`                           |

## 5. 飞书拒绝

| #   | 操作                                            | 预期                                                   |
| --- | ----------------------------------------------- | ------------------------------------------------------ |
| 5.1 | 飞书机器人对已绑定的会话发 `/fabric alias 前端` | 回复「飞书入口」拒绝文案；hub 日志无别名请求；别名不变 |
| 5.2 | 飞书发 `/fabric alias 前端 --take`              | 同样拒绝，且不产生抢占预览                             |

## 6. 兼容与降级

| #   | 操作                                                                                                               | 预期                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | **旧 hub**：停掉 hub，用上一版本（无 `xs.alias.v1`）手动起 hub；A（alias on）`/reload`                             | `/fabric status`：`alias n/a (hub-cap off)`；`/fabric alias …`：「hub 不支持别名或别名服务降级，需 /webhub restart」；`list_sessions` 行无 alias；模型工具描述**仍是别名版**（冻结策略的已知代价），但按别名寻址退回旧行为（按名字/ref）                                           |
| 6.2 | `alias.enabled=false`（A 设置后 `/reload`）                                                                        | A：`/fabric status` `alias n/a (alias.enabled=false)`；`/fabric alias` 拒绝；`list_sessions` 无 alias；来信头部无 ` alias=`；hub 上原绑定保留（B 看得到 A 仍持有）；A 重新开启后无需重设                                                                                           |
| 6.3 | **混跑**：A（alias on）与 C（alias off 或旧版本）同在 `#default`                                                   | C 行为与升级前逐字节一致；A 给 C 发消息，C 的头部无 ` alias=`；C 无法按别名寻址                                                                                                                                                                                                    |
| 6.4 | **hub 由 alias.enabled=false 的会话拉起**（先关闭所有会话，仅 C 设 off 后启动并 `/webhub start`）                  | 运行期内所有会话都是 `hub-cap off`；由 alias-enabled 的会话执行 `/webhub restart` 后恢复（残留 R11）                                                                                                                                                                               |
| 6.5 | **文件损坏**：停 hub；`echo '{ bad' > <stateDir>/xs-aliases.json`（路径以 `/webhub status` 为准）；`/webhub start` | `/webhub status` 出现 `warning：alias store degraded (…) · <文件路径>` 与修复提示；`/fabric alias` 提示不支持/降级；用别名形状的名字（如 `前端`）发消息得到「别名服务暂不可用，请用 list_sessions 给出的 ref」，**不会**落到同名会话；文件字节保持 `{ bad`，旁边无 `.bak`/临时文件 |
| 6.6 | 连续 `/webhub restart` 两次                                                                                        | 仍然 degraded，文件不变（不自动修复、不回落）                                                                                                                                                                                                                                      |
| 6.7 | 人把文件移走（`mv`）后 `/webhub restart`                                                                           | ready、空表：旧别名全部消失，可重新设置；`/webhub status` 不再有 alias 降级行；（残留 R1：这会让用别名形状名字的请求回落到名字层）                                                                                                                                                 |
| 6.8 | 正常 hub 的 `/webhub status`                                                                                       | **没有**任何 alias 相关行（输出与升级前一致）                                                                                                                                                                                                                                      |
| 6.9 | fork：A fork 出新会话（`/new` 见 7.20）                                                                            | 新会话不继承别名（`/fabric status` 为 `alias -`）；A 仍持有                                                                                                                                                                                                                        |

## 7. 强制抢占与目录名自动别名（#72，需 hub 与 agent 都是 v2）

> 前置：三个会话 A / B / C **都升级并 `/reload`，再 `/webhub restart`**（hub 要带 `xs.alias.v2`）；`fabric.crossSession.alias.autoFromCwd` 用默认值（true）。
> 设置键是非 live 的：改完要 `/reload`。本节所有「状态」都看 `/fabric status` 的 `alias` 行。cwd 约定：A、B 在**同一个目录** `~/ai/payments`（basename 不能是保留词，
> **不要用 `pi-toolkit`**——命中保留前缀 `pi-` 会被跳过），C 在 `~/ai/other`。

| #    | 操作                                                                                                                            | 预期                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | `/agent settings` 里搜 `autoFromCwd`                                                                                            | 出现 `fabric.crossSession.alias.autoFromCwd`（bool，默认 true；非 live，改完需 `/reload`）                                                                                                                                                      |
| 7.2  | A、B 同时（两个终端几乎同一时刻）`/fabric join`                                                                                 | 恰好一个会话弹出一次「已按目录名自动设置别名 @payments …」；它的 status 为 `alias @payments held (auto) · lease 7d · cool 10m`；另一个为 `alias - · auto skip:taken`，且**没有**通知                                                            |
| 7.3  | 持有者执行 `/fabric alias`（get）；卡片/头部                                                                                    | 显示 `@payments`；web 抢占预览会标注「（自动认领）」                                                                                                                                                                                            |
| 7.4  | 另一个会话（设为 B）`/fabric alias payments`                                                                                    | 「别名已被占用，未设置。」并追加「可用 /fabric alias payments --force 强制抢占（需确认）」（D5）                                                                                                                                                |
| 7.5  | B：`/fabric alias payments --take`（A 在线）                                                                                    | 「持有者仍在线，不能抢占。」同样追加 `--force` 提示                                                                                                                                                                                             |
| 7.6  | B：`/fabric alias payments --force`                                                                                             | 弹确认框 `强制抢占别名「payments」？`，正文含持有会话 cwd、「（自动认领）」、「当前在线」，以及「对方会立即收到…提示；此后发给…的消息将改投本会话（已发出的仍送达对方）」                                                                       |
| 7.7  | 7.6 中选择取消                                                                                                                  | 「已取消抢占。」别名仍在 A；B 在 7.4 已做过人工写操作，status 为 `alias - · auto skip:decided`                                                                                                                                                  |
| 7.8  | 重做 7.6 并确认                                                                                                                 | B：「已抢占别名：alias @payments held」，status 无 `(auto)`；A **不重连、不操作**，几秒内在终端收到「别名「payments」已被其他会话强制抢占（对方已人工确认）…」，一次且仅一次；A 的 status 为 `alias - (lost: taken)`；A 的卡片 `@payments` 消失 |
| 7.9  | web：A 重新持有（A 先 `/fabric alias payments --force` 抢回）后，B 在 web 的「频道与别名」对话框输入 `payments`，点「尝试抢占」 | 回显「持有者仍在线…」，**下方出现红色「强制抢占…」按钮**；点击 → 确认框显示预览（含 cwd、在线、自动认领/否）+ 5 分钟倒计时；确认后成功，A 立刻收到 7.8 的提示                                                                                   |
| 7.10 | 7.9 在 `webCommandPolicy:{"fabric":"confirm"}` 下重做                                                                           | 预览与执行各弹一次通用确认；输出最后一行仍是 `确认抢占请执行：/fabric alias payments --take=<token>（5 分钟内有效）`                                                                                                                            |
| 7.11 | pin：抢占发生的瞬间，某发送方已经把 `payments` 解析成旧持有者、但消息还没发出（时间窗很窄，真机只抽查，难复现就跳过）           | 已解析的消息仍送达被抢前的持有者；之后新发的消息送达新持有者；被抢前的持有者已离线时，该消息返回 NO_TARGET，**绝不**落到新持有者（自动化 ③ 已覆盖）                                                                                             |
| 7.12 | 被抢方 A `/reload`（或重连）                                                                                                    | A 不会重新自动认领 `payments`（30 天墓碑），status `alias - · auto skip:taken`；该名字在 B 手里                                                                                                                                                 |
| 7.13 | B 在 web/TUI 上 `/fabric alias --clear`，A 再 `/reload`                                                                         | 墓碑仍在 ⇒ A 仍不认领（`auto skip:taken`）；等 B 的 10 分钟冷却结束后，同目录的**新会话**（新开一个 pi）join 会自动认领 `payments`                                                                                                              |
| 7.14 | 人工 `--clear` 之后：A 对一个没有别名的会话执行 `/fabric alias --clear`                                                         | 回显含「已关闭本会话的目录名自动别名」；`/reload`、`/webhub restart` 后 status 为 `alias - · auto skip:decided`，永不再自动设置                                                                                                                 |
| 7.15 | 不可通知的持有者：把持有会话的 `fabric.crossSession.enabled` 关掉并 `/reload`（它仍连着 hub），C 对它的别名 `--force`           | 拒绝：「持有会话在线但无法实时通知（版本较旧或未启用跨会话），不能强制抢占；请待其离线 ≥10 分钟后用 --take。」；web 此时**不**出现强制按钮                                                                                                      |
| 7.16 | 旧版 agent 作为在线持有者（用上一版本起一个会话并 `/fabric alias x`），新会话对 `x` `--force`                                   | 同 7.15 的拒绝文案；旧 agent 被杀掉后，新会话**立即**可 `--force`（`--take` 仍提示「不足 10 分钟」）；旧 agent 重启回来得到旧文案（「已被抢占」，无「强制」字样）                                                                               |
| 7.17 | 旧 hub（上一版本）+ 新 agent：`/fabric status`、`/fabric alias x --force`                                                       | status 无 `auto skip:` 后缀、不自动设置；`--force` 本地拒绝「hub 不支持强制抢占，需 /webhub restart」；`set`/`--take`/按别名收发行为与旧版一致                                                                                                  |
| 7.18 | `autoFromCwd=false`（`/reload` 后）新开同目录会话 join                                                                          | 不自动设置；`/fabric status` 的 `alias -` 行没有 `auto skip:` 后缀                                                                                                                                                                              |
| 7.19 | 审计：`<stateDir>` 的 hub 审计日志中 force 执行                                                                                 | 记为 `take`（与普通抢占不可区分，已知残留）；预览记为 `force-preview`；日志里没有别名文本、token、cwd                                                                                                                                           |
| 7.20 | A（持有 `@payments`，自动认领或人工设置均可）执行 `/new`（TUI `/new` 或 `/clear`）                                              | 新会话几秒内 `/fabric status` 为 `alias @payments held …`（人工设置的没有 `(auto)`，自动认领的仍有）；**不弹通知**；`/webhub` 里该卡片 `@payments` 不消失；其它会话 `list_sessions`/解析 `payments` 指向**新**会话 id                           |
| 7.21 | 7.20 之后在 hub 审计/`xs-aliases.json` 里看旧 session id                                                                        | 没有旧 id 的记录、冷却或墓碑；别名记录只有一条，`sessionId` 是新 id（路径见 `/webhub status`）                                                                                                                                                  |
| 7.22 | web 详情头部点「清空」（等价 `/new`）                                                                                           | 同 7.20：别名跟到新会话                                                                                                                                                                                                                         |
| 7.23 | A 先人工 `/fabric alias --clear`（无别名），再 `/new`，再 `/reload`                                                             | 新会话 `alias - · auto skip:decided`：人工「不要别名」的决定随 `/new` 继承，不会按目录名自动设置                                                                                                                                                |
| 7.24 | A 持有 `@payments`，`/fork`（或 web 恢复/`/resume` 另一个会话）                                                                 | fork 出的新会话**不**拿到别名（`alias -`，通常 `auto skip:taken`/`not-joined`）；A 仍持有；没有任何通知                                                                                                                                         |
| 7.25 | A 持有 `@payments`；B 在 A `/new` 之前把它 `--force` 抢走（A 的终端已收到强制抢占提示后再 `/new`）                              | `/new` 后新会话**没有**拿回别名（`alias - …`），B 仍持有；不报错                                                                                                                                                                                |
| 7.26 | `/new` 的同一秒里 `/webhub restart`（hub 重启丢失继承边，R22）                                                                  | 新会话没有交接到别名：旧名留在旧 sid（`xs-aliases.json` 里仍是旧 id），新会话走自动认领（通常因旧 sid 仍持有而 `auto skip:taken`）；之后可用 `--take`/`--force` 取回                                                                            |
