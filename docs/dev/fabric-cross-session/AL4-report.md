# AL4 报告：命令与格式（alias-plan r4 §3.5/§6/§7/§8）

## 命令语法与输出样例（`src/commands/fabric-xs.ts`）

| 命令                                | 行为 / 样例输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/fabric alias`                     | get：`alias @前端 held` / `alias -`（`bridge.get()`，之后非阻塞 `cache.reconcile()`）                                                                                                                                                                                                                                                                                                                                                                                            |
| `/fabric alias <名>`                | 本地 `normalizeAlias`（去 `@`、小写、全角折叠）→ `bridge.set(canonical)`；成功 `别名已设置：alias @web held`；非法在本地拒绝，不发 hub                                                                                                                                                                                                                                                                                                                                           |
| `/fabric alias --clear`             | `bridge.clear()`；`已清除本会话别名（10 分钟内只有本会话能收回）。`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/fabric alias <名> --take`         | `bridge.takePreview` → **TUI（`ctx.mode==="tui"` 且非 web/飞书）**：`ctx.ui.confirm("抢占别名「前端」？","持有会话：~/ai/foo，已离线 3 天 4 小时。抢占后对方回来会失去此别名并收到提示。")`，确认后用 token `bridge.take`；拒绝 ⇒ `已取消抢占。` **web / RPC**：不弹窗、不执行，输出两行，**最后一行**固定为 `确认抢占请执行：/fabric alias 前端 --take=k0123456789abcdef（5 分钟内有效）`（`formatTakeConfirmLine`，与 `XS_ALIAS_TAKE_CONFIRM_RE`/`parseTakeConfirm` 往返已测） |
| `/fabric alias <名> --take=<token>` | token 本地校验 `XS_ALIAS_TAKE_TOKEN_RE` 后 `bridge.take`；任何 hub 结果都不重试                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/fabric status`                    | 新增一行：`alias @前端 held · lease 7d · cool 10m` / `alias - (lost: taken)` / `alias -` / `alias n/a (hub-cap off)` / `alias n/a (alias.enabled=false)`；`deps.alias` 未接线 ⇒ 不出这一行（输出逐字节不变）                                                                                                                                                                                                                                                                     |
| 补全                                | `alias` 子命令；`alias ` → `--clear` + 推荐值（`suggestions()` 经 `normalizeAlias` 过滤，≤8）；`alias <名> --t` → `--take`。纯本地、零 I/O                                                                                                                                                                                                                                                                                                                                       |

hub 错误 → 固定中文文案（`E_XS_ALIAS_{INVALID,TAKEN,TAKE,FULL,BUSY,UNKNOWN,UNAVAILABLE}`；`code` 带 `{detail}` 后缀或 `reason` 均可解析）；`taken/confusable` 不回显任何已有别名；`UNKNOWN` 提示「可能已生效，勿立刻重试」。预览里的 `cwdLabel` 视为不可信：本地再去一次 `\p{C}`（因此不能伪造出第二条确认行）并截 120 字符。

模型可见格式（`format.ts`/`render.ts`）：

- `formatXsMessage`：`[fabric xs from={…} alias="前端" cwd="~/proj" wake=… ]`；`formatXsReply`：`… from={…} alias="前端" request=…`。alias 是独立 JSON 字段（不进 `from` 对象、不经 `fenceMeta` 截断）；仅在有 alias 时说明句追加「；alias 由 hub 核验唯一，name 由对方自报」。`XsMessageFrom.alias?`（空串视同无）。无 alias ⇒ 输出逐字节不变（字面量首行断言 + 与 `alias:""/undefined` 相等）。
- `render.ts`：`buildXsView` 新增 `alias`（`details.from.alias` 优先，否则用**独立正则**解析首行，不依赖 `from` JSON 是否被截断）；`xsHeaderLine` 优先 `@alias`；`HEADER_RE` 容许 alias 字段，cwd 回退解析不受影响。

## 安全防线清单

1. **飞书三层硬拒**：① handler 第一行（`FEISHU_REFUSED_SUBS` 加 `alias`，**含 bare `alias`**），在任何 enabled/membership/hub 请求之前（测试：5 种形态 `calls=[]`、`confirms=[]`）；② prompt 文本拦截正则加 `alias(?:\s|$)`（飞书来源得「飞书入口」专用文案，web 得 command-op 提示）；③ 命令 op 层沿用「hub F6 只转发 prompt/dialog」。
2. **webCommandPolicy.fabric**：`alias` 入 `FABRIC_KNOWN_SUBS`（基线 allow；整名 override 为 confirm/deny 时预览与执行各自走通用确认/拒绝；未知子命令仍 deny）。
3. **web 不弹窗、不自动执行抢占**：确认只来自 `--take=<token>` 的新命令；token 经 `XS_ALIAS_TAKE_TOKEN_RE` 本地校验。
4. agent 无途径：未注册工具，命令不可被模型调用（沿用既有结构）。
5. 本地失败关闭：`alias.enabled=false` / hub 无 cap / bridge 不支持 ⇒ 本地拒绝，不发任何 hub 请求。

## 端口需求（供 ALW）

`createFabricXsCommand` 新增可选 dep `alias?(): FabricXsAliasPort | undefined`：

```ts
interface FabricXsAliasPort {
  localEnabled: boolean; // fabric.crossSession.alias.enabled
  bridge?: XsAliasBridgePort; // AL3 的 op 桥（supported=false ⇒ 本地拒绝）
  cache?: XsAliasCachePort; // AL3 缓存（usable=false ⇒ 视同 hub-cap off；current()/reconcile()）
  leaseDays?: number;
  coolMin?: number; // 仅 status 显示，缺省 7 / 10
  suggestions?(): readonly string[]; // 补全推荐（cwd 末段、会话名前缀…），同步
}
```

- xs 开启时 ALW 应始终传入（含 `localEnabled:false`，这样 status 才显示 `n/a (alias.enabled=false)`）；alias 整体功能关闭且希望 status 逐字节不变时可返回 undefined。
- 收件侧：`receiver.ts` 的 `input.from` 需要带 hub 盖章的 `alias`（`XsMessageFrom.alias`）才能出现在头部——receiver/`stack.ts` 属 AL3/ALW，本包未改；`formatXsMessage/Reply` 已就绪（`from` 对象整体透传即可）。注意仅 `aliasUsable` 收件方写出，否则不要带。
- `FabricXsAliasPort.cache.current()` 的 `lostReason`（见偏离 1）由 AL3 缓存填写。

## 偏离 / 说明

1. `types-alias.ts` 最小追加：`XsAliasCacheEntry.lostReason?: "taken"|"expired"`（为 `alias - (lost: taken)` 显示；缺省按 taken 显示）。
2. `/fabric alias`（含 bare get）也被 prompt 文本拦截与飞书硬拒覆盖，比「仅变更」略严（计划 §8「三层硬拒」）。
3. bridge 的 `set/take` 没有 cwdLabel 参数——hub 侧自取（端口类型沿用 AL0b，未改）。
4. 既有测试同步：`fabric-xs.test.ts` 补全数 10→11（新增 `alias`）。
5. 既有局限（未改）：`from` 名字很长使 `fenceMeta` 截断 JSON 时，`render.ts` `HEADER_RE` 本就匹配不上（kind 退化）；alias 解析与它独立。

## 改动文件

- /home/bluecake/ai/pi-toolkit/src/commands/fabric-xs.ts
- /home/bluecake/ai/pi-toolkit/src/fabric/xs/format.ts
- /home/bluecake/ai/pi-toolkit/src/fabric/xs/render.ts
- /home/bluecake/ai/pi-toolkit/src/fabric/xs/types-alias.ts
- /home/bluecake/ai/pi-toolkit/src/web-hub/agent/command-policy.ts
- /home/bluecake/ai/pi-toolkit/src/web-hub/agent/commands.ts
- /home/bluecake/ai/pi-toolkit/tests/commands/fabric-xs-alias.test.ts（新）
- /home/bluecake/ai/pi-toolkit/tests/fabric/xs-alias-format.test.ts（新）
- /home/bluecake/ai/pi-toolkit/tests/commands/fabric-xs.test.ts、tests/web-hub/agent/{commands-prompt-fabric,command-policy-fabric}.test.ts（扩展）
- /home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/AL4-report.md

## 自验

- `npx vitest run tests/commands tests/fabric tests/web-hub/agent tests/integration/fabric-xs*.test.ts --maxWorkers=3`：151 文件 / 2571 测试，首跑 1 个失败（补全数 10→11，已修复，该文件复跑 37/37 通过）；三份 off golden 与 legacy-xs-v071 相关测试在内全部通过。
- `npm run typecheck`：通过（tsc ×2 + vue-tsc）。
- `npx prettier --check <改动文件>`：All matched files use Prettier code style!
