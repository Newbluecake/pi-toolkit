# web-hub `/` 命令参数补全 — 真机验收清单（P4）

> 对应方案：`docs/dev/web-hub-slash-args/plan.md`（§6 UI 行为、§11 拍板 D1/D2、r1 评审处置）。
> 前置：`webHub.enabled`、`webHub.commandComplete` 保持默认 `all`（改动需 `/reload` + `/webhub restart`，
> 非 live）；浏览器 UI 已构建（`npm run build:web`）且 `/webhub open` 打开。
> 每条都是可判定（能/不能、出现/不出现），桌面（≥768px Chrome）与手机（`pointer:coarse`，
> 可用 DevTools 模拟）各过一遍。执行人勾选并记录偏差。

## 0. 环境确认

- [ ] `/webhub status` 出现一行 `cmd-args: all · hub-cap on`（英文紧凑 token；cap off 时为
      `cmd-args: all · hub-cap off (old hub, or /webhub restart pending)`，n/a = 未连接 hub）。
- [ ] 浏览器打开会话详情，Composer 可用。

## 1. 静态 usage 提示（零请求）

- [ ] 输入 `/agent `（注意末尾空格）：名字面板隐藏，参数面板头部显示 `/agent` + usage 行
      （来自 toolkit 手写表；不再显示名字候选列表）。
- [ ] 输入 `/model `：头部 usage 显示 `<provider/model>`（pi builtin 表），无动态候选标记。
- [ ] 退格删掉空格回到 `/agent`：名字面板行为与旧版一致（参数面板消失）。

## 2. 动态补全 — S-own（toolkit 命令，桌面）

- [ ] `/agent st` → 候选含 `status`；继续输入使前缀无匹配 → 「无可用补全」弱提示 + 头部 usage 仍在。
- [ ] `/webhub ` → 候选**只有** `status`（`passwd`/`2fa`/`user`/`open` 等 deny 子命令永不出现）。
- [ ] `/cache-ttl keepalive ` → 出现下一级候选（如 `on`/`off`/`reset`），多层链路可用。
- [ ] 候选行出现 confirm 徽标（如 `/mem tidy` 类 confirm 项）与命令面板同款样式。

## 3. 键盘与选择（D2 拍板，桌面）

- [ ] `/agent ` 后按 `↑`/`↓`/`Shift+Tab`：高亮循环移动，焦点仍在输入框。
- [ ] **↑↓ 移动过后按 Enter**：应用高亮候选（文本变为 `/agent <value>`），Enter 被消费、不发送。
- [ ] **未用 ↑↓ 直接按 Enter**：不应用任何候选，Enter 仍是「执行当前命令」（与名字面板旧行为一致）。
- [ ] 高亮未导航时按任意非导航字符键（如字母）：`argNavigated` 复位，随后的 Enter 不应用候选（r1 #5）。
- [ ] `Tab`：应用当前高亮项；面板可见但无候选时 Tab 也不逃焦（被消费）。
- [ ] `Esc`：关闭参数面板；紧接着输入任意字符后面板按规则重开（latch 复位）。

## 4. 第三方命令（S-tui，主会话须为 TUI 模式）

- [ ] 装 `/record`（或任意带 `getArgumentCompletions` 的第三方命令）后 `/record ` 出现其参数候选。
- [ ] 无补全函数的第三方命令（如自定义 hello 命令）：只有 usage/description 头部，无候选、无报错。
- [ ] RPC 托管会话（spawn 面板新开的 agent）上同一第三方命令：无动态候选（降级为静态提示，D3 接受）。

## 5. 输入法（IME，桌面 + 手机）

- [ ] 中文输入法组字期间（拼音未上屏）输入 `/agent ` 后继续组字：面板不闪跳、不发请求；
      `compositionend` 上屏后补一次查询。
- [ ] 组字期间按 Enter（确认候选词）：不被参数面板消费，不应用补全项。

## 6. 手机（pointer:coarse）

- [ ] `/agent ` 面板出现在键盘上方（与名字面板同位置，max-height 受限可滚动）。
- [ ] 点按候选行 = 应用（textarea 不失焦）；应用后下一级候选立即出现。
- [ ] Enter 为换行（不应用候选）；无 Tab 键也可完整走通「输入 → 点选 → 再输入」。

## 7. 模式与旧 hub 兼容

- [ ] `webHub.commandComplete: "toolkit"`（改设置 → `/reload` → `/webhub restart`）：
      `/agent ` 仍补全（S-own）；第三方命令不再有动态候选；`/webhub status` 显示 `cmd-args: toolkit`。
- [ ] `webHub.commandComplete: "off"`（同样非 live）：`/agent ` 无参数面板（含静态 usage 都不出现），
      名字面板行为与功能引入前完全一致；`/webhub status` 显示 `cmd-args: off`。
- [ ] 回到 `all` 后重启 hub：功能恢复。
- [ ] 旧 hub（版本低于 cmd.args.v1）+ 新 agent：`/agent ` 不出现任何参数提示（`args` 从 commands 帧
      剥离），名字面板正常；`/webhub status` 显示 `hub-cap off`；`POST /api/command/complete` 404。

## 8. 稳定性抽查

- [ ] 快速连打 `/agent ` + 退格 + 再输入若干轮：无重复请求风暴（防抖 150ms）、无过期响应闪烁（seq 丢弃）。
- [ ] 断网/agent 掉线时输入 `/agent `：静默降级为头部 usage，无报错弹窗。
- [ ] hub 日志（`<stateDir>/web-hub.log`）抽查 `command-complete` 审计行：只有
      `listener/name/plen/hits/ms/code/source`，**无 prefix 与候选文本**；浏览器中途关闭的请求记 `code:"aborted"`。

## 9. 记录

- 执行日期 / pi-toolkit 版本 / 浏览器与机型：
- 偏差与备注：
